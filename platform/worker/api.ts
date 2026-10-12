import { Hono, type Context } from 'hono';
import { CONNECTORS, MCP_SCOPES } from '../shared/catalog';
import { CHANNELS, CONSENT_BASES, PARTY_TYPES, type Channel } from '../shared/policy';
import { authenticateUser, ensureUser, requireMember } from './auth';
import { createConnection, deleteConnection, listConnections, resolveConnection, testConnection, type ConnectionRow } from './connectors';
import { audit } from './domain/audit';
import {
  applyLead, channelDecisions, commitImport, contactConsents, getContact, listContacts, matchLead,
  normalizeLead, parseImportPayload, previewImport, suppressContact, type LeadInput,
} from './domain/contacts';
import { workspaceMetrics } from './domain/metrics';
import { agentStatus, decideApproval, eventsSince, getRun, listApprovals, listRuns, startPipeline } from './domain/runs';
import { completeTask, createTask, listToday, type TaskKind } from './domain/tasks';
import type { Actor, Env } from './env';
import { HttpError, id, nowIso, sha256Hex } from './util';

type Vars = { actor: Actor; ws: string; role: 'owner' | 'member' };
type C = Context<{ Bindings: Env; Variables: Vars }>;

export const api = new Hono<{ Bindings: Env; Variables: Vars }>().basePath('/api');

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: 'Interner Fehler' }, 500);
});

async function body<T = Record<string, unknown>>(c: C): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, 'JSON erwartet');
  }
}

// ---------- Eingehende Webhooks (ohne Benutzer-Anmeldung, mit Verbindungs-Token) ----------

api.post('/hooks/:connectionId', async (c) => {
  const row = await c.env.DB.prepare(`SELECT * FROM connections WHERE id = ?1 AND provider = 'webhook_in'`)
    .bind(c.req.param('connectionId'))
    .first<ConnectionRow>();
  const presented = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!row || !presented) throw new HttpError(401, 'Unbekannter Webhook');
  const conn = await resolveConnection(c.env, row);
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(conn.secrets.token ?? '')]);
  if (a !== b) throw new HttpError(401, 'Unbekannter Webhook');

  const payload = await body<{ format?: string; leads?: LeadInput[]; lead?: LeadInput }>(c);
  const leads = payload.lead ? [payload.lead] : parseImportPayload(payload);
  const actor: Actor = { email: `webhook:${row.id}`, via: 'webhook' };
  const result = await commitImport(c.env, actor, row.workspace_id, leads, conn.config.audienceId || undefined);
  return c.json(result);
});

// ---------- Anmeldung, CSRF-Schutz ----------

api.use('*', async (c, next) => {
  const email = await authenticateUser(c.req.raw, c.env);
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) throw new HttpError(403, 'Fremder Ursprung');
    if (c.req.method !== 'DELETE' && !c.req.header('content-type')?.includes('application/json')) {
      throw new HttpError(415, 'JSON erwartet');
    }
  }
  await ensureUser(c.env, email);
  c.set('actor', { email, via: 'ui' });
  await next();
});

api.use('/workspaces/:ws/*', async (c, next) => {
  const ws = c.req.param('ws')!;
  c.set('role', await requireMember(c.env, ws, c.get('actor').email));
  c.set('ws', ws);
  await next();
});

const requireOwner = (c: C) => {
  if (c.get('role') !== 'owner') throw new HttpError(403, 'Nur Inhaber dürfen das ändern');
};

// ---------- Benutzer & Arbeitsbereiche ----------

api.get('/me', async (c) => {
  const email = c.get('actor').email;
  const { results } = await c.env.DB.prepare(
    `SELECT w.id, w.slug, w.name, w.description, w.accent, m.role FROM workspaces w
       JOIN memberships m ON m.workspace_id = w.id WHERE m.user_email = ?1 ORDER BY w.created_at`,
  )
    .bind(email)
    .all();
  return c.json({ email, workspaces: results, environment: c.env.ENVIRONMENT });
});

const ACCENTS = ['cyan', 'amber', 'violet', 'emerald', 'rose'];

/** Weitere Anbieter/Unternehmen können einen eigenen Arbeitsbereich anlegen. */
api.post('/workspaces', async (c) => {
  const b = await body<{ name?: string; description?: string; accent?: string }>(c);
  const name = b.name?.trim();
  if (!name || name.length > 80) throw new HttpError(400, 'Name fehlt oder ist zu lang');
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ws';
  const exists = await c.env.DB.prepare('SELECT 1 FROM workspaces WHERE slug = ?1').bind(slug).first();
  const wsId = id('ws');
  const actor = c.get('actor');
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO workspaces (id, slug, name, description, accent) VALUES (?1, ?2, ?3, ?4, ?5)').bind(
      wsId, exists ? `${slug}-${wsId.slice(-4)}` : slug, name, b.description?.trim() ?? '', ACCENTS.includes(b.accent ?? '') ? b.accent : 'violet',
    ),
    c.env.DB.prepare(`INSERT INTO memberships (workspace_id, user_email, role) VALUES (?1, ?2, 'owner')`).bind(wsId, actor.email),
  ]);
  await audit(c.env, actor, wsId, 'workspace.created', wsId);
  return c.json({ id: wsId }, 201);
});

api.get('/workspaces/:ws/overview', async (c) => {
  const ws = c.get('ws');
  const [w, offers, audiences] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM workspaces WHERE id = ?1').bind(ws),
    c.env.DB.prepare('SELECT * FROM offers WHERE workspace_id = ?1 ORDER BY is_active DESC, name').bind(ws),
    c.env.DB.prepare('SELECT * FROM audiences WHERE workspace_id = ?1 ORDER BY name').bind(ws),
  ]);
  const [metrics, agents, ai] = await Promise.all([
    workspaceMetrics(c.env, ws),
    agentStatus(c.env, ws),
    c.env.DB.prepare(`SELECT id, provider, label FROM connections WHERE workspace_id = ?1 AND status = 'connected' AND provider IN ('gemini','openai','anthropic') ORDER BY created_at`).bind(ws).all(),
  ]);
  const workspace = w.results[0] as Record<string, unknown>;
  const engines = ai.results as { id: string; provider: string; label: string }[];
  const engine = engines.find((e) => e.id === workspace.ai_provider) ?? engines[0] ?? null;
  return c.json({ workspace, role: c.get('role'), offers: offers.results, audiences: audiences.results, metrics, agents, engine });
});

api.patch('/workspaces/:ws/settings', async (c) => {
  requireOwner(c);
  const b = await body<{ daily_ai_budget_cents?: number; max_parallel_runs?: number; ai_provider?: string | null }>(c);
  const ws = c.get('ws');
  if (b.ai_provider) {
    const ok = await c.env.DB.prepare(`SELECT 1 FROM connections WHERE id = ?1 AND workspace_id = ?2 AND provider IN ('gemini','openai','anthropic')`).bind(b.ai_provider, ws).first();
    if (!ok) throw new HttpError(400, 'Unbekannte KI-Verbindung');
  }
  const budget = b.daily_ai_budget_cents === undefined ? null : Math.max(0, Math.min(100_000, Math.round(b.daily_ai_budget_cents)));
  const parallel = b.max_parallel_runs === undefined ? null : Math.max(1, Math.min(10, Math.round(b.max_parallel_runs)));
  await c.env.DB.prepare(
    `UPDATE workspaces SET daily_ai_budget_cents = coalesce(?1, daily_ai_budget_cents), max_parallel_runs = coalesce(?2, max_parallel_runs),
       ai_provider = CASE WHEN ?3 = 1 THEN ?4 ELSE ai_provider END WHERE id = ?5`,
  )
    .bind(budget, parallel, b.ai_provider !== undefined ? 1 : 0, b.ai_provider ?? null, ws)
    .run();
  await audit(c.env, c.get('actor'), ws, 'workspace.settings', ws, b);
  return c.json({ ok: true });
});

api.get('/workspaces/:ws/members', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT user_email, role, created_at FROM memberships WHERE workspace_id = ?1 ORDER BY created_at').bind(c.get('ws')).all();
  return c.json({ members: results });
});

api.post('/workspaces/:ws/members', async (c) => {
  requireOwner(c);
  const b = await body<{ email?: string; role?: string }>(c);
  const email = b.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'E-Mail ungültig');
  const role = b.role === 'owner' ? 'owner' : 'member';
  await c.env.DB.prepare('INSERT INTO memberships (workspace_id, user_email, role) VALUES (?1, ?2, ?3) ON CONFLICT(workspace_id, user_email) DO UPDATE SET role = excluded.role')
    .bind(c.get('ws'), email, role)
    .run();
  await audit(c.env, c.get('actor'), c.get('ws'), 'member.added', email, { role });
  return c.json({ ok: true }, 201);
});

// ---------- Angebote & Zielgruppen (Agentenwissen) ----------

api.post('/workspaces/:ws/offers', async (c) => {
  requireOwner(c);
  const b = await body<Record<string, string>>(c);
  if (!b.name?.trim()) throw new HttpError(400, 'Name fehlt');
  const offerId = id('off');
  await c.env.DB.prepare('INSERT INTO offers (id, workspace_id, name, description, services, pricing, limits, goal) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(offerId, c.get('ws'), b.name.trim(), b.description ?? '', b.services ?? '', b.pricing ?? '', b.limits ?? '', b.goal ?? '')
    .run();
  await audit(c.env, c.get('actor'), c.get('ws'), 'offer.created', offerId);
  return c.json({ id: offerId }, 201);
});

api.patch('/workspaces/:ws/offers/:id', async (c) => {
  requireOwner(c);
  const b = await body<Record<string, string | number>>(c);
  const fields = ['name', 'description', 'services', 'pricing', 'limits', 'goal', 'is_active'] as const;
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const f of fields) {
    if (b[f] === undefined) continue;
    binds.push(f === 'is_active' ? (b[f] ? 1 : 0) : String(b[f]));
    sets.push(`${f} = ?${binds.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'Keine Änderungen');
  binds.push(nowIso(), c.req.param('id'), c.get('ws'));
  const r = await c.env.DB.prepare(`UPDATE offers SET ${sets.join(', ')}, updated_at = ?${binds.length - 2} WHERE id = ?${binds.length - 1} AND workspace_id = ?${binds.length}`)
    .bind(...binds)
    .run();
  if (!r.meta.changes) throw new HttpError(404, 'Angebot nicht gefunden');
  await audit(c.env, c.get('actor'), c.get('ws'), 'offer.updated', c.req.param('id'), { fields: Object.keys(b) });
  return c.json({ ok: true });
});

api.post('/workspaces/:ws/audiences', async (c) => {
  requireOwner(c);
  const b = await body<{ offer_id?: string; name?: string; description?: string; criteria?: string[]; default_party_type?: string }>(c);
  if (!b.name?.trim() || !b.offer_id) throw new HttpError(400, 'Name und Angebot nötig');
  const offer = await c.env.DB.prepare('SELECT 1 FROM offers WHERE id = ?1 AND workspace_id = ?2').bind(b.offer_id, c.get('ws')).first();
  if (!offer) throw new HttpError(404, 'Angebot nicht gefunden');
  const audId = id('aud');
  const pt = (PARTY_TYPES as readonly string[]).includes(b.default_party_type ?? '') ? b.default_party_type : 'unknown';
  await c.env.DB.prepare('INSERT INTO audiences (id, workspace_id, offer_id, name, description, criteria, default_party_type) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(audId, c.get('ws'), b.offer_id, b.name.trim(), b.description ?? '', JSON.stringify((b.criteria ?? []).map(String).slice(0, 20)), pt)
    .run();
  await audit(c.env, c.get('actor'), c.get('ws'), 'audience.created', audId);
  return c.json({ id: audId }, 201);
});

// ---------- Kontakte ----------

api.get('/workspaces/:ws/contacts', async (c) => {
  const contacts = await listContacts(c.env, c.get('ws'), {
    q: c.req.query('q') || undefined,
    status: c.req.query('status') || undefined,
    audienceId: c.req.query('audience') || undefined,
  });
  return c.json({ contacts });
});

api.post('/workspaces/:ws/contacts', async (c) => {
  const { lead, error } = normalizeLead(await body<LeadInput>(c));
  if (!lead) throw new HttpError(400, error ?? 'Ungültig');
  const m = await matchLead(c.env, c.get('ws'), lead);
  if (m.kind === 'conflict') return c.json({ conflict: true, reason: m.reason, contactId: m.contactId }, 409);
  return c.json(await applyLead(c.env, c.get('actor'), c.get('ws'), lead, m), 201);
});

api.get('/workspaces/:ws/contacts/:id', async (c) => {
  const ws = c.get('ws');
  const contact = await getContact(c.env, ws, c.req.param('id'));
  const [channels, consents, rest] = await Promise.all([
    channelDecisions(c.env, contact),
    contactConsents(c.env, contact.id),
    c.env.DB.batch([
      c.env.DB.prepare('SELECT * FROM activities WHERE contact_id = ?1 ORDER BY occurred_at DESC LIMIT 50').bind(contact.id),
      c.env.DB.prepare('SELECT * FROM tasks WHERE contact_id = ?1 AND done_at IS NULL ORDER BY due_at').bind(contact.id),
      c.env.DB.prepare('SELECT * FROM opportunities WHERE contact_id = ?1 ORDER BY updated_at DESC').bind(contact.id),
      c.env.DB.prepare(`SELECT * FROM approvals WHERE contact_id = ?1 ORDER BY created_at DESC LIMIT 10`).bind(contact.id),
      c.env.DB.prepare(`SELECT id, status, channel, current_step, created_at FROM workflow_runs WHERE contact_id = ?1 ORDER BY created_at DESC LIMIT 10`).bind(contact.id),
    ]),
  ]);
  const [activities, tasks, opportunities, approvals, runs] = rest.map((r) => r.results);
  return c.json({ contact, channels, consents, activities, tasks, opportunities, approvals, runs });
});

api.patch('/workspaces/:ws/contacts/:id', async (c) => {
  const b = await body<{ party_type?: string; audience_id?: string | null; status?: string; address?: string }>(c);
  const ws = c.get('ws');
  const contact = await getContact(c.env, ws, c.req.param('id'));
  if (b.party_type && !(PARTY_TYPES as readonly string[]).includes(b.party_type)) throw new HttpError(400, 'Ungültiger Typ');
  if (b.audience_id) {
    const ok = await c.env.DB.prepare('SELECT 1 FROM audiences WHERE id = ?1 AND workspace_id = ?2').bind(b.audience_id, ws).first();
    if (!ok) throw new HttpError(400, 'Zielgruppe gehört nicht zu diesem Arbeitsbereich');
  }
  const statuses = ['new', 'researching', 'qualified', 'contacted', 'customer', 'lost', 'paused'];
  if (b.status && !statuses.includes(b.status)) throw new HttpError(400, 'Ungültiger Status');
  await c.env.DB.prepare(
    `UPDATE contacts SET party_type = coalesce(?1, party_type), audience_id = CASE WHEN ?2 = 1 THEN ?3 ELSE audience_id END,
       status = coalesce(?4, status), address = coalesce(?5, address), updated_at = ?6 WHERE id = ?7`,
  )
    .bind(b.party_type ?? null, b.audience_id !== undefined ? 1 : 0, b.audience_id ?? null, b.status ?? null, b.address ?? null, nowIso(), contact.id)
    .run();
  await audit(c.env, c.get('actor'), ws, 'contact.patched', contact.id, b);
  return c.json({ ok: true });
});

/** Kontaktberechtigung erfassen – nur Menschen in der Oberfläche, immer mit Beleg. */
api.post('/workspaces/:ws/contacts/:id/consents', async (c) => {
  const b = await body<{ channel?: string; basis?: string; evidence?: string; granted_at?: string }>(c);
  const ws = c.get('ws');
  const contact = await getContact(c.env, ws, c.req.param('id'));
  if (!(CHANNELS as readonly string[]).includes(b.channel ?? '')) throw new HttpError(400, 'Kanal ungültig');
  if (!(CONSENT_BASES as readonly string[]).includes(b.basis ?? '')) throw new HttpError(400, 'Grundlage ungültig');
  if (!b.evidence?.trim() || b.evidence.trim().length < 10) throw new HttpError(400, 'Beleg fehlt (wann, wie, durch wen – mindestens ein Satz)');
  if (b.basis === 'presumed_b2b' && contact.party_type !== 'business') throw new HttpError(400, 'Mutmaßliche Einwilligung nur bei Geschäftskontakten');
  if (b.basis === 'presumed_b2b' && b.channel !== 'phone') throw new HttpError(400, 'Mutmaßliche Einwilligung gilt nur für Telefon');
  const consentId = id('cns');
  await c.env.DB.prepare('INSERT INTO consents (id, workspace_id, contact_id, channel, basis, evidence, granted_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(consentId, ws, contact.id, b.channel, b.basis, b.evidence.trim(), b.granted_at || nowIso(), c.get('actor').email)
    .run();
  await audit(c.env, c.get('actor'), ws, 'consent.added', consentId, { channel: b.channel, basis: b.basis });
  return c.json({ id: consentId }, 201);
});

api.post('/workspaces/:ws/consents/:id/revoke', async (c) => {
  const r = await c.env.DB.prepare('UPDATE consents SET revoked_at = ?1 WHERE id = ?2 AND workspace_id = ?3 AND revoked_at IS NULL')
    .bind(nowIso(), c.req.param('id'), c.get('ws'))
    .run();
  if (!r.meta.changes) throw new HttpError(404, 'Berechtigung nicht gefunden');
  await audit(c.env, c.get('actor'), c.get('ws'), 'consent.revoked', c.req.param('id'));
  return c.json({ ok: true });
});

api.post('/workspaces/:ws/contacts/:id/suppress', async (c) => {
  const b = await body<{ reason?: string }>(c);
  await suppressContact(c.env, c.get('actor'), c.get('ws'), c.req.param('id'), b.reason?.trim() || 'Widerspruch');
  return c.json({ ok: true });
});

api.post('/workspaces/:ws/contacts/:id/notes', async (c) => {
  const b = await body<{ text?: string; kind?: string; direction?: string }>(c);
  const contact = await getContact(c.env, c.get('ws'), c.req.param('id'));
  const text = b.text?.trim();
  if (!text) throw new HttpError(400, 'Text fehlt');
  const kinds = ['call', 'email', 'whatsapp', 'sms', 'letter', 'note'];
  const kind = kinds.includes(b.kind ?? '') ? b.kind : 'note';
  const direction = ['inbound', 'outbound', 'internal'].includes(b.direction ?? '') ? b.direction : 'internal';
  const actId = id('act');
  const stmts = [
    c.env.DB.prepare('INSERT INTO activities (id, workspace_id, contact_id, kind, direction, summary, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(actId, c.get('ws'), contact.id, kind, direction, text.slice(0, 4000), c.get('actor').email),
  ];
  // Eine Antwort des Kontakts stoppt ausstehendes Nachfassen
  if (direction === 'inbound') {
    stmts.push(c.env.DB.prepare(`UPDATE tasks SET done_at = ?1 WHERE contact_id = ?2 AND kind = 'followup' AND done_at IS NULL`).bind(nowIso(), contact.id));
  }
  await c.env.DB.batch(stmts);
  return c.json({ id: actId }, 201);
});

api.post('/workspaces/:ws/contacts/:id/runs', async (c) => {
  const b = await body<{ channel?: string }>(c);
  return c.json(await startPipeline(c.env, c.get('actor'), c.get('ws'), c.req.param('id'), (b.channel ?? 'email') as Channel), 201);
});

// ---------- Import ----------

api.post('/workspaces/:ws/imports/preview', async (c) => {
  const leads = parseImportPayload(await body(c));
  return c.json(await previewImport(c.env, c.get('ws'), leads));
});

api.post('/workspaces/:ws/imports/commit', async (c) => {
  const b = await body<{ format?: string; leads?: LeadInput[]; csv?: string; audience_id?: string }>(c);
  return c.json(await commitImport(c.env, c.get('actor'), c.get('ws'), parseImportPayload(b), b.audience_id));
});

// ---------- Heute, Aufgaben ----------

api.get('/workspaces/:ws/today', async (c) => c.json({ tasks: await listToday(c.env, c.get('ws')) }));

api.post('/workspaces/:ws/tasks', async (c) => {
  const b = await body<{ contact_id?: string; kind?: TaskKind; title?: string; reason?: string; due_at?: string }>(c);
  const taskId = await createTask(c.env, c.get('actor'), c.get('ws'), {
    contactId: b.contact_id ?? null,
    kind: b.kind ?? 'other',
    title: b.title ?? '',
    reason: b.reason,
    dueAt: b.due_at ?? nowIso(),
  });
  return c.json({ id: taskId }, 201);
});

api.post('/workspaces/:ws/tasks/:id/done', async (c) => {
  await completeTask(c.env, c.get('actor'), c.get('ws'), c.req.param('id'));
  return c.json({ ok: true });
});

// ---------- Agentenläufe, Ereignisse, Freigaben ----------

api.get('/workspaces/:ws/runs', async (c) => c.json({ runs: await listRuns(c.env, c.get('ws')) }));
api.get('/workspaces/:ws/runs/:id', async (c) => c.json(await getRun(c.env, c.get('ws'), c.req.param('id'))));

api.get('/workspaces/:ws/events', async (c) => {
  const since = Number(c.req.query('since') ?? 0) || 0;
  const [events, agents] = await Promise.all([eventsSince(c.env, c.get('ws'), since), agentStatus(c.env, c.get('ws'))]);
  return c.json({ events, agents });
});

api.get('/workspaces/:ws/approvals', async (c) => c.json({ approvals: await listApprovals(c.env, c.get('ws'), c.req.query('status') ?? 'pending') }));

api.post('/workspaces/:ws/approvals/:id', async (c) => {
  const b = await body<{ decision?: string; subject?: string; body?: string }>(c);
  if (b.decision !== 'approve' && b.decision !== 'reject') throw new HttpError(400, 'decision: approve | reject');
  return c.json(await decideApproval(c.env, c.get('actor'), c.get('ws'), c.req.param('id'), b.decision, { subject: b.subject, body: b.body }));
});

// ---------- Angebote (Verkaufschancen) & Zahlungen ----------

const STAGES = ['new', 'qualified', 'meeting', 'proposal', 'won', 'lost'];

api.get('/workspaces/:ws/opportunities', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT o.*, c.display_name AS contact_name, c.organization AS contact_org FROM opportunities o JOIN contacts c ON c.id = o.contact_id
      WHERE o.workspace_id = ?1 ORDER BY o.updated_at DESC LIMIT 300`,
  )
    .bind(c.get('ws'))
    .all();
  return c.json({ opportunities: results });
});

api.post('/workspaces/:ws/opportunities', async (c) => {
  const b = await body<{ contact_id?: string; offer_id?: string; title?: string; one_time_cents?: number; recurring_cents_month?: number; is_estimate?: boolean }>(c);
  const ws = c.get('ws');
  await getContact(c.env, ws, b.contact_id ?? '');
  if (b.offer_id && !(await c.env.DB.prepare('SELECT 1 FROM offers WHERE id = ?1 AND workspace_id = ?2').bind(b.offer_id, ws).first())) {
    throw new HttpError(400, 'Angebot gehört nicht zu diesem Arbeitsbereich');
  }
  const oppId = id('opp');
  await c.env.DB.prepare(
    'INSERT INTO opportunities (id, workspace_id, contact_id, offer_id, title, one_time_cents, recurring_cents_month, is_estimate) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
  )
    .bind(oppId, ws, b.contact_id, b.offer_id ?? null, b.title?.trim() || 'Verkaufschance', Math.max(0, Math.round(b.one_time_cents ?? 0)), Math.max(0, Math.round(b.recurring_cents_month ?? 0)), b.is_estimate === false ? 0 : 1)
    .run();
  await audit(c.env, c.get('actor'), ws, 'opportunity.created', oppId);
  return c.json({ id: oppId }, 201);
});

api.patch('/workspaces/:ws/opportunities/:id', async (c) => {
  const b = await body<{ stage?: string; one_time_cents?: number; recurring_cents_month?: number; is_estimate?: boolean }>(c);
  if (b.stage && !STAGES.includes(b.stage)) throw new HttpError(400, 'Stufe ungültig');
  const r = await c.env.DB.prepare(
    `UPDATE opportunities SET stage = coalesce(?1, stage), one_time_cents = coalesce(?2, one_time_cents),
       recurring_cents_month = coalesce(?3, recurring_cents_month), is_estimate = coalesce(?4, is_estimate), updated_at = ?5
     WHERE id = ?6 AND workspace_id = ?7`,
  )
    .bind(b.stage ?? null, b.one_time_cents ?? null, b.recurring_cents_month ?? null, b.is_estimate === undefined ? null : b.is_estimate ? 1 : 0, nowIso(), c.req.param('id'), c.get('ws'))
    .run();
  if (!r.meta.changes) throw new HttpError(404, 'Verkaufschance nicht gefunden');
  await audit(c.env, c.get('actor'), c.get('ws'), 'opportunity.updated', c.req.param('id'), b);
  return c.json({ ok: true });
});

api.post('/workspaces/:ws/payments', async (c) => {
  const b = await body<{ opportunity_id?: string; amount_cents?: number; received_on?: string; reference?: string }>(c);
  if (!b.amount_cents || b.amount_cents <= 0) throw new HttpError(400, 'Betrag fehlt');
  if (!b.received_on || Number.isNaN(Date.parse(b.received_on))) throw new HttpError(400, 'Eingangsdatum fehlt');
  if (!b.reference?.trim()) throw new HttpError(400, 'Belegreferenz fehlt');
  const payId = id('pay');
  await c.env.DB.prepare('INSERT INTO payments (id, workspace_id, opportunity_id, amount_cents, received_on, reference, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(payId, c.get('ws'), b.opportunity_id ?? null, Math.round(b.amount_cents), b.received_on.slice(0, 10), b.reference.trim(), c.get('actor').email)
    .run();
  await audit(c.env, c.get('actor'), c.get('ws'), 'payment.recorded', payId);
  return c.json({ id: payId }, 201);
});

// ---------- Verbindungen ----------

api.get('/catalog', (c) =>
  c.json({ connectors: CONNECTORS, mcp: { url: `${c.env.PUBLIC_URL.replace(/\/$/, '')}/mcp`, scopes: MCP_SCOPES } }),
);

api.get('/workspaces/:ws/connections', async (c) => c.json({ connections: await listConnections(c.env, c.get('ws')) }));

api.post('/workspaces/:ws/connections', async (c) => {
  requireOwner(c);
  const b = await body<{ provider?: string; label?: string; values?: Record<string, string> }>(c);
  const created = await createConnection(c.env, c.get('actor'), c.get('ws'), b.provider ?? '', b.values ?? {}, b.label);
  const test = await testConnection(c.env, c.get('actor'), c.get('ws'), created.id);
  return c.json({ ...created, ...test, webhookUrl: b.provider === 'webhook_in' ? `${c.env.PUBLIC_URL.replace(/\/$/, '')}/api/hooks/${created.id}` : undefined }, 201);
});

api.post('/workspaces/:ws/connections/:id/test', async (c) => c.json(await testConnection(c.env, c.get('actor'), c.get('ws'), c.req.param('id'))));

api.delete('/workspaces/:ws/connections/:id', async (c) => {
  requireOwner(c);
  await deleteConnection(c.env, c.get('actor'), c.get('ws'), c.req.param('id'));
  return c.json({ ok: true });
});

// ---------- Persönliche MCP-Zugangsschlüssel (für n8n, Make, Skripte) ----------

api.get('/tokens', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, prefix, scopes, last_used_at, created_at FROM api_tokens WHERE user_email = ?1 AND revoked_at IS NULL ORDER BY created_at DESC')
    .bind(c.get('actor').email)
    .all();
  return c.json({ tokens: results });
});

api.post('/tokens', async (c) => {
  const b = await body<{ name?: string; scopes?: string[] }>(c);
  const scopes = (b.scopes ?? ['sales:read']).filter((s) => s in MCP_SCOPES);
  if (!scopes.length) throw new HttpError(400, 'Mindestens eine Berechtigung');
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = `upg_${Array.from(raw, (x) => x.toString(16).padStart(2, '0')).join('')}`;
  const tokId = id('tok');
  await c.env.DB.prepare('INSERT INTO api_tokens (id, user_email, name, token_hash, prefix, scopes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(tokId, c.get('actor').email, b.name?.trim() || 'Zugangsschlüssel', await sha256Hex(token), token.slice(0, 10), scopes.join(' '))
    .run();
  await audit(c.env, c.get('actor'), null, 'token.created', tokId, { scopes });
  return c.json({ id: tokId, token }, 201);
});

api.delete('/tokens/:id', async (c) => {
  const r = await c.env.DB.prepare('UPDATE api_tokens SET revoked_at = ?1 WHERE id = ?2 AND user_email = ?3 AND revoked_at IS NULL')
    .bind(nowIso(), c.req.param('id'), c.get('actor').email)
    .run();
  if (!r.meta.changes) throw new HttpError(404, 'Schlüssel nicht gefunden');
  await audit(c.env, c.get('actor'), null, 'token.revoked', c.req.param('id'));
  return c.json({ ok: true });
});

api.get('/workspaces/:ws/audit', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM audit_log WHERE workspace_id = ?1 ORDER BY id DESC LIMIT 100').bind(c.get('ws')).all();
  return c.json({ entries: results });
});
