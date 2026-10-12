// MCP-Server (Streamable HTTP, zustandslos, JSON-Antworten).
// Ein Endpunkt für ChatGPT (Apps/Connectors), Claude, Cursor, n8n und andere MCP-Clients.
// Bewusst nicht über MCP möglich: Freigaben erteilen, Kontaktberechtigungen erfassen, Versand auslösen.

import { CHANNELS, type Channel } from '../../shared/policy';
import { memberWorkspaceIds } from '../auth';
import { audit } from '../domain/audit';
import { applyLead, channelDecisions, commitImport, getContact, listContacts, matchLead, normalizeLead, previewImport, type LeadInput } from '../domain/contacts';
import { workspaceMetrics } from '../domain/metrics';
import { getRun, listRuns, startPipeline } from '../domain/runs';
import { createTask, listToday, type TaskKind } from '../domain/tasks';
import type { Actor, Env } from '../env';
import { HttpError, id } from '../util';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

export interface McpProps {
  email: string;
  scopes: string[];
  client?: string;
}

type Json = Record<string, unknown>;

interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: 'sales:read' | 'sales:write';
  inputSchema: Json;
  handler: (env: Env, actor: Actor, args: Json) => Promise<unknown>;
}

const workspaceProp = {
  workspace: { type: 'string', description: 'Arbeitsbereich: ID oder Kurzname, z. B. "upgrai" oder "hermann-living"' },
};

async function resolveWorkspace(env: Env, actor: Actor, ref: unknown): Promise<string> {
  if (typeof ref !== 'string' || !ref) throw new HttpError(400, 'workspace fehlt');
  const row = await env.DB.prepare(
    `SELECT w.id FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
      WHERE (w.id = ?1 OR w.slug = ?1) AND m.user_email = ?2`,
  )
    .bind(ref, actor.email)
    .first<{ id: string }>();
  if (!row) throw new HttpError(404, `Arbeitsbereich "${ref}" nicht gefunden`);
  return row.id;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

const leadSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    organization: { type: 'string' },
    party_type: { type: 'string', enum: ['business', 'consumer', 'unknown'], description: 'Geschäftskontakt oder Verbraucher – bestimmt die zulässigen Kanäle' },
    email: { type: 'string' },
    phone: { type: 'string' },
    website: { type: 'string' },
    address: { type: 'string' },
    city: { type: 'string' },
    country: { type: 'string', description: 'ISO-Ländercode, z. B. DE' },
    language: { type: 'string' },
    source_url: { type: 'string', description: 'Quelle der Angaben (Pflicht für belastbare Recherche)' },
    verified_at: { type: 'string', description: 'Prüfzeitpunkt (ISO 8601)' },
    audience_id: { type: 'string' },
    attributes: { type: 'object', description: 'Weitere Recherchemerkmale', additionalProperties: true },
    rating: { type: 'object', properties: { value: { type: 'number' }, scale: { type: 'number' }, count: { type: 'number' } }, required: ['value', 'scale', 'count'] },
  },
};

export const TOOLS: ToolDef[] = [
  {
    name: 'list_workspaces',
    title: 'Arbeitsbereiche',
    description: 'Listet die Unternehmen (Arbeitsbereiche) mit Angeboten und Zielgruppen, auf die du Zugriff hast.',
    scope: 'sales:read',
    inputSchema: { type: 'object', properties: {} },
    handler: async (env, actor) => {
      const ids = await memberWorkspaceIds(env, actor.email);
      if (!ids.length) return { workspaces: [] };
      const ph = ids.map((_, i) => `?${i + 1}`).join(',');
      const [ws, offers, auds] = await env.DB.batch([
        env.DB.prepare(`SELECT id, slug, name, description FROM workspaces WHERE id IN (${ph})`).bind(...ids),
        env.DB.prepare(`SELECT id, workspace_id, name, description, is_active FROM offers WHERE workspace_id IN (${ph})`).bind(...ids),
        env.DB.prepare(`SELECT id, workspace_id, offer_id, name, description FROM audiences WHERE workspace_id IN (${ph})`).bind(...ids),
      ]);
      return {
        workspaces: (ws.results as Json[]).map((w) => ({
          ...w,
          offers: (offers.results as Json[]).filter((o) => o.workspace_id === w.id).map((o) => ({
            ...o,
            audiences: (auds.results as Json[]).filter((a) => a.offer_id === o.id),
          })),
        })),
      };
    },
  },
  {
    name: 'search_contacts',
    title: 'Kontakte suchen',
    description: 'Sucht Kontakte nach Name, Organisation, Stadt oder E-Mail. Sortiert nach Passung.',
    scope: 'sales:read',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceProp,
        query: { type: 'string' },
        status: { type: 'string', enum: ['new', 'researching', 'qualified', 'contacted', 'customer', 'lost', 'paused'] },
        audience_id: { type: 'string' },
        limit: { type: 'number', default: 25 },
      },
      required: ['workspace'],
    },
    handler: async (env, actor, a) => {
      const ws = await resolveWorkspace(env, actor, a.workspace);
      const rows = await listContacts(env, ws, { q: str(a.query), status: str(a.status), audienceId: str(a.audience_id), limit: Number(a.limit) || 25 });
      return {
        contacts: rows.map((c) => ({
          id: c.id, name: c.display_name, organization: c.organization, type: c.party_type, city: c.city,
          status: c.status, score: c.score, email: c.email, phone: c.phone, demo: !!c.is_demo,
        })),
      };
    },
  },
  {
    name: 'get_contact',
    title: 'Kontakt öffnen',
    description: 'Alle Angaben zu einem Kontakt: Recherche, zulässige Kanäle (mit Begründung), Verlauf, offene Aufgaben.',
    scope: 'sales:read',
    inputSchema: { type: 'object', properties: { ...workspaceProp, contact_id: { type: 'string' } }, required: ['workspace', 'contact_id'] },
    handler: async (env, actor, a) => {
      const ws = await resolveWorkspace(env, actor, a.workspace);
      const c = await getContact(env, ws, String(a.contact_id));
      const [channels, acts, tasks] = await Promise.all([
        channelDecisions(env, c),
        env.DB.prepare('SELECT kind, direction, summary, occurred_at FROM activities WHERE contact_id = ?1 ORDER BY occurred_at DESC LIMIT 20').bind(c.id).all(),
        env.DB.prepare('SELECT id, kind, title, due_at FROM tasks WHERE contact_id = ?1 AND done_at IS NULL ORDER BY due_at').bind(c.id).all(),
      ]);
      return { contact: { ...c, research: JSON.parse(c.research) }, channels, activities: acts.results, open_tasks: tasks.results };
    },
  },
  {
    name: 'today',
    title: 'Heute',
    description: 'Arbeitsliste für heute: Rückrufe, Antworten, Freigaben, fällige Wiedervorlagen – in dieser Reihenfolge.',
    scope: 'sales:read',
    inputSchema: { type: 'object', properties: workspaceProp, required: ['workspace'] },
    handler: async (env, actor, a) => ({ tasks: await listToday(env, await resolveWorkspace(env, actor, a.workspace)) }),
  },
  {
    name: 'metrics',
    title: 'Kennzahlen',
    description: 'Kennzahlen aus erfassten Daten: Zahlungseingänge (Monat), offene Angebotswerte, Aufgaben, Freigaben, Antworten, KI-Kosten.',
    scope: 'sales:read',
    inputSchema: { type: 'object', properties: workspaceProp, required: ['workspace'] },
    handler: async (env, actor, a) => workspaceMetrics(env, await resolveWorkspace(env, actor, a.workspace)),
  },
  {
    name: 'list_agent_runs',
    title: 'Agentenläufe',
    description: 'Letzte Agentenläufe mit Status; mit run_id die einzelnen Schritte eines Laufs.',
    scope: 'sales:read',
    inputSchema: { type: 'object', properties: { ...workspaceProp, run_id: { type: 'string' } }, required: ['workspace'] },
    handler: async (env, actor, a) => {
      const ws = await resolveWorkspace(env, actor, a.workspace);
      return a.run_id ? getRun(env, ws, String(a.run_id)) : { runs: await listRuns(env, ws) };
    },
  },
  {
    name: 'upsert_lead',
    title: 'Lead anlegen oder ergänzen',
    description:
      'Legt einen Kontakt an oder ergänzt einen vorhandenen (Treffer über E-Mail/Telefon). Bestehende Angaben werden nicht überschrieben. ' +
      'Widersprüchliche Treffer werden nicht übernommen, sondern gemeldet. Gib immer source_url an, wenn die Angaben aus einer Recherche stammen.',
    scope: 'sales:write',
    inputSchema: { type: 'object', properties: { ...workspaceProp, lead: leadSchema }, required: ['workspace', 'lead'] },
    handler: async (env, actor, a) => {
      const ws = await resolveWorkspace(env, actor, a.workspace);
      const { lead, error } = normalizeLead((a.lead ?? {}) as LeadInput);
      if (!lead) throw new HttpError(400, error ?? 'Ungültiger Lead');
      const m = await matchLead(env, ws, lead);
      if (m.kind === 'conflict') return { result: 'conflict', reason: m.reason, contact_id: m.contactId, hint: 'Bitte in der Oberfläche prüfen.' };
      const r = await applyLead(env, actor, ws, lead, m);
      return { result: r.action, contact_id: r.id };
    },
  },
  {
    name: 'import_leads',
    title: 'Leads importieren',
    description:
      'Importiert mehrere Leads im Format lead-research/1.0. Mit commit=false nur Vorschau (neu/ergänzen/Konflikt/ungültig), mit commit=true übernehmen. ' +
      'Konflikte werden nie automatisch übernommen.',
    scope: 'sales:write',
    inputSchema: {
      type: 'object',
      properties: { ...workspaceProp, leads: { type: 'array', items: leadSchema, maxItems: 1000 }, audience_id: { type: 'string' }, commit: { type: 'boolean', default: false } },
      required: ['workspace', 'leads'],
    },
    handler: async (env, actor, a) => {
      const ws = await resolveWorkspace(env, actor, a.workspace);
      const leads = (Array.isArray(a.leads) ? a.leads : []) as LeadInput[];
      if (leads.length > 1000) throw new HttpError(400, 'Maximal 1000 Leads');
      return a.commit ? commitImport(env, actor, ws, leads, str(a.audience_id)) : previewImport(env, ws, leads);
    },
  },
  {
    name: 'add_note',
    title: 'Notiz hinzufügen',
    description: 'Hängt eine Notiz an den Verlauf eines Kontakts (z. B. Gesprächsnotiz).',
    scope: 'sales:write',
    inputSchema: { type: 'object', properties: { ...workspaceProp, contact_id: { type: 'string' }, text: { type: 'string', maxLength: 4000 } }, required: ['workspace', 'contact_id', 'text'] },
    handler: async (env, actor, a) => {
      const ws = await resolveWorkspace(env, actor, a.workspace);
      const c = await getContact(env, ws, String(a.contact_id));
      const text = String(a.text ?? '').trim().slice(0, 4000);
      if (!text) throw new HttpError(400, 'Text fehlt');
      const actId = id('act');
      await env.DB.prepare(`INSERT INTO activities (id, workspace_id, contact_id, kind, direction, summary, created_by) VALUES (?1, ?2, ?3, 'note', 'internal', ?4, ?5)`)
        .bind(actId, ws, c.id, text, `${actor.email} via MCP`)
        .run();
      await audit(env, actor, ws, 'note.added', c.id);
      return { id: actId };
    },
  },
  {
    name: 'create_task',
    title: 'Aufgabe anlegen',
    description: 'Legt eine Aufgabe oder Wiedervorlage an (z. B. Rückruf). Erscheint in der Heute-Liste.',
    scope: 'sales:write',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceProp,
        contact_id: { type: 'string' },
        kind: { type: 'string', enum: ['callback', 'followup', 'reply', 'call', 'letter', 'review', 'other'] },
        title: { type: 'string' },
        reason: { type: 'string' },
        due_at: { type: 'string', description: 'Fälligkeit (ISO 8601)' },
      },
      required: ['workspace', 'kind', 'title', 'due_at'],
    },
    handler: async (env, actor, a) => {
      const ws = await resolveWorkspace(env, actor, a.workspace);
      const taskId = await createTask(env, actor, ws, {
        contactId: str(a.contact_id) ?? null,
        kind: (str(a.kind) ?? 'other') as TaskKind,
        title: String(a.title ?? ''),
        reason: str(a.reason),
        dueAt: String(a.due_at ?? ''),
      });
      return { id: taskId };
    },
  },
  {
    name: 'start_agent_run',
    title: 'Agentenlauf starten',
    description:
      'Startet Recherche → Qualifizierung → Kanalprüfung → Entwurf für einen Kontakt. Der Lauf endet mit einem Entwurf, ' +
      'den ein Mensch in der Plattform freigeben muss. Über MCP wird nichts versendet.',
    scope: 'sales:write',
    inputSchema: {
      type: 'object',
      properties: { ...workspaceProp, contact_id: { type: 'string' }, channel: { type: 'string', enum: [...CHANNELS] } },
      required: ['workspace', 'contact_id', 'channel'],
    },
    handler: async (env, actor, a) => {
      const ws = await resolveWorkspace(env, actor, a.workspace);
      return startPipeline(env, actor, ws, String(a.contact_id), String(a.channel) as Channel);
    },
  },
];

const INSTRUCTIONS = [
  'UPGRAI Sales: gemeinsamer Vertriebsarbeitsplatz für mehrere Unternehmen (z. B. UPGRAI und Hermann Living).',
  'Rufe zuerst list_workspaces auf und arbeite immer im passenden Arbeitsbereich; vermische keine Daten zwischen Unternehmen.',
  'Erfinde keine Kontaktdaten. Gib bei Recherche immer source_url und verified_at an. Unbekanntes bleibt leer.',
  'Kontaktberechtigungen, Freigaben und Versand sind Menschen in der Plattform vorbehalten.',
].join(' ');

function rpcResult(rpcId: unknown, result: unknown) {
  return { jsonrpc: '2.0', id: rpcId, result };
}
function rpcError(rpcId: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: rpcId ?? null, error: { code, message } };
}

export async function handleMcp(request: Request, env: Env, props: McpProps): Promise<Response> {
  if (request.method === 'GET') {
    // Kein serverseitiger Ereignisstrom: zustandsloser Server
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  }
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Json };
  try {
    msg = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }
  if (Array.isArray(msg)) return Response.json(rpcError(null, -32600, 'Batching wird nicht unterstützt'), { status: 400 });
  if (msg.id === undefined || msg.id === null) {
    // Benachrichtigung (z. B. notifications/initialized)
    return new Response(null, { status: 202 });
  }

  const actor: Actor = { email: props.email, via: 'mcp', scopes: props.scopes };
  const reply = (body: unknown) => Response.json(body, { headers: { 'cache-control': 'no-store' } });

  switch (msg.method) {
    case 'initialize': {
      const requested = String(msg.params?.protocolVersion ?? '');
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      return reply(
        rpcResult(msg.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'upgrai-sales', title: 'UPGRAI Sales', version: '0.1.0' },
          instructions: INSTRUCTIONS,
        }),
      );
    }
    case 'ping':
      return reply(rpcResult(msg.id, {}));
    case 'tools/list':
      return reply(
        rpcResult(msg.id, {
          tools: TOOLS.filter((t) => props.scopes.includes(t.scope)).map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { title: t.title, readOnlyHint: t.scope === 'sales:read', destructiveHint: false, idempotentHint: t.scope === 'sales:read', openWorldHint: false },
          })),
        }),
      );
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return reply(rpcError(msg.id, -32602, `Unbekanntes Werkzeug: ${name}`));
      if (!props.scopes.includes(tool.scope)) {
        return reply(rpcResult(msg.id, { isError: true, content: [{ type: 'text', text: `Fehlende Berechtigung: ${tool.scope}` }] }));
      }
      try {
        const data = await tool.handler(env, actor, (msg.params?.arguments ?? {}) as Json);
        const structured = (data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data }) as Json;
        return reply(rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured }));
      } catch (err) {
        const text = err instanceof HttpError ? err.message : 'Interner Fehler';
        if (!(err instanceof HttpError)) console.error('mcp tool error', name, err);
        return reply(rpcResult(msg.id, { isError: true, content: [{ type: 'text', text }] }));
      }
    }
    default:
      return reply(rpcError(msg.id, -32601, `Methode nicht unterstützt: ${msg.method}`));
  }
}
