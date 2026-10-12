import { evaluateAllChannels, type Channel, type ChannelDecision, type ConsentFact, type PartyType, PARTY_TYPES } from '../../shared/policy';
import type { Actor, Env } from '../env';
import { HttpError, id, normalizeEmail, normalizePhone, nowIso, parseJson, sha256Hex } from '../util';
import { audit } from './audit';

export interface ContactRow {
  id: string;
  workspace_id: string;
  audience_id: string | null;
  display_name: string;
  organization: string | null;
  party_type: PartyType;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  language: string;
  source_url: string | null;
  verified_at: string | null;
  research: string;
  score: number | null;
  score_reason: string | null;
  status: string;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export async function getContact(env: Env, workspaceId: string, contactId: string): Promise<ContactRow> {
  const row = await env.DB.prepare('SELECT * FROM contacts WHERE id = ?1 AND workspace_id = ?2')
    .bind(contactId, workspaceId)
    .first<ContactRow>();
  if (!row) throw new HttpError(404, 'Kontakt nicht gefunden');
  return row;
}

export interface ContactFilter {
  q?: string;
  audienceId?: string;
  status?: string;
  limit?: number;
}

export async function listContacts(env: Env, workspaceId: string, f: ContactFilter = {}): Promise<ContactRow[]> {
  const where = ['workspace_id = ?1'];
  const binds: unknown[] = [workspaceId];
  if (f.q) {
    binds.push(`%${f.q.toLowerCase()}%`);
    const p = `?${binds.length}`;
    where.push(`(lower(display_name) LIKE ${p} OR lower(coalesce(organization,'')) LIKE ${p} OR lower(coalesce(city,'')) LIKE ${p} OR lower(coalesce(email,'')) LIKE ${p})`);
  }
  if (f.audienceId) {
    binds.push(f.audienceId);
    where.push(`audience_id = ?${binds.length}`);
  }
  if (f.status) {
    binds.push(f.status);
    where.push(`status = ?${binds.length}`);
  }
  binds.push(Math.min(Math.max(f.limit ?? 200, 1), 500));
  const { results } = await env.DB.prepare(
    `SELECT * FROM contacts WHERE ${where.join(' AND ')} ORDER BY coalesce(score,-1) DESC, updated_at DESC LIMIT ?${binds.length}`,
  )
    .bind(...binds)
    .all<ContactRow>();
  return results;
}

// ---------- Sperrliste ----------

async function suppressionHash(kind: 'email' | 'phone', value: string): Promise<string> {
  return sha256Hex(`${kind}:${value}`);
}

export async function isSuppressed(env: Env, email: string | null, phone: string | null): Promise<boolean> {
  const hashes: string[] = [];
  if (email) hashes.push(await suppressionHash('email', email));
  if (phone) hashes.push(await suppressionHash('phone', phone));
  if (!hashes.length) return false;
  const row = await env.DB.prepare(
    `SELECT 1 AS hit FROM suppressions WHERE value_hash IN (${hashes.map((_, i) => `?${i + 1}`).join(',')}) LIMIT 1`,
  )
    .bind(...hashes)
    .first();
  return !!row;
}

/** Widerspruch: plattformweit sperren, laufende Agentenläufe des Kontakts stoppen. */
export async function suppressContact(env: Env, actor: Actor, workspaceId: string, contactId: string, reason: string) {
  const c = await getContact(env, workspaceId, contactId);
  const stmts: D1PreparedStatement[] = [];
  for (const [kind, value] of [['email', c.email], ['phone', c.phone]] as const) {
    if (!value) continue;
    stmts.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO suppressions (id, kind, value_hash, reason, source_workspace_id, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      ).bind(id('sup'), kind, await suppressionHash(kind, value), reason, workspaceId, actor.email),
    );
  }
  stmts.push(env.DB.prepare(`UPDATE contacts SET status = 'paused', updated_at = ?1 WHERE id = ?2`).bind(nowIso(), contactId));
  stmts.push(
    env.DB.prepare(
      `UPDATE approvals SET status = 'invalidated' WHERE contact_id = ?1 AND status = 'pending'`,
    ).bind(contactId),
  );
  await env.DB.batch(stmts);
  await audit(env, actor, workspaceId, 'contact.suppressed', contactId, { reason });
}

// ---------- Kontaktberechtigung ----------

export async function contactConsents(env: Env, contactId: string): Promise<(ConsentFact & { id: string; evidence: string; granted_at: string })[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, channel, basis, evidence, granted_at, revoked_at AS revokedAt FROM consents WHERE contact_id = ?1 ORDER BY granted_at DESC',
  )
    .bind(contactId)
    .all<ConsentFact & { id: string; evidence: string; granted_at: string }>();
  return results;
}

export async function lastInboundWhatsapp(env: Env, contactId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT max(occurred_at) AS t FROM activities WHERE contact_id = ?1 AND kind = 'whatsapp' AND direction = 'inbound'`,
  )
    .bind(contactId)
    .first<{ t: string | null }>();
  return row?.t ?? null;
}

export function recipientFor(c: Pick<ContactRow, 'email' | 'phone' | 'address' | 'display_name' | 'organization' | 'city'>, channel: Channel): string | null {
  switch (channel) {
    case 'email':
      return c.email;
    case 'phone':
    case 'sms':
      return c.phone;
    case 'whatsapp':
      return c.phone ? `whatsapp:${c.phone}` : null;
    case 'letter':
      return c.address ? [c.organization ?? c.display_name, c.address, c.city].filter(Boolean).join(', ') : null;
  }
}

export async function channelDecisions(env: Env, c: ContactRow): Promise<Record<Channel, ChannelDecision>> {
  const [consents, suppressed, lastWa] = await Promise.all([
    contactConsents(env, c.id),
    isSuppressed(env, c.email, c.phone),
    lastInboundWhatsapp(env, c.id),
  ]);
  return evaluateAllChannels(
    { partyType: c.party_type, consents, suppressed, lastInboundWhatsappAt: lastWa },
    {
      email: !!recipientFor(c, 'email'),
      phone: !!recipientFor(c, 'phone'),
      sms: !!recipientFor(c, 'sms'),
      whatsapp: !!recipientFor(c, 'whatsapp'),
      letter: !!recipientFor(c, 'letter'),
    },
  );
}

// ---------- Anlegen / Ergänzen ----------

export interface LeadInput {
  name?: string;
  organization?: string;
  party_type?: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  city?: string;
  country?: string;
  language?: string;
  source_url?: string;
  verified_at?: string;
  audience_id?: string;
  attributes?: Record<string, unknown>;
  rating?: { value: number; scale: number; count: number };
  availability?: { from: string; to: string; note?: string };
}

export interface NormalizedLead {
  display_name: string;
  organization: string | null;
  party_type: PartyType;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  language: string;
  source_url: string | null;
  verified_at: string | null;
  audience_id: string | null;
  research: Record<string, unknown>;
}

const clean = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

export function normalizeLead(input: LeadInput): { lead?: NormalizedLead; error?: string } {
  const organization = clean(input.organization);
  const display_name = clean(input.name) ?? organization;
  if (!display_name) return { error: 'Name oder Organisation fehlt' };

  const rawEmail = clean(input.email);
  const email = normalizeEmail(rawEmail);
  if (rawEmail && !email) return { error: `Ungültige E-Mail: ${rawEmail}` };

  const rawPhone = clean(input.phone);
  const phone = normalizePhone(rawPhone);
  if (rawPhone && !phone) return { error: `Telefonnummer nicht normalisierbar: ${rawPhone}` };

  const pt = clean(input.party_type)?.toLowerCase();
  const party_type: PartyType = (PARTY_TYPES as readonly string[]).includes(pt ?? '') ? (pt as PartyType) : 'unknown';

  const research: Record<string, unknown> = { ...(input.attributes ?? {}) };
  if (input.rating) {
    const { value, scale, count } = input.rating;
    if (!(Number.isFinite(value) && Number.isFinite(scale) && Number.isFinite(count))) {
      return { error: 'Bewertung braucht Wert, Skala und Anzahl' };
    }
    research.rating = { value, scale, count };
  }
  if (input.availability) {
    if (!input.availability.from || !input.availability.to) return { error: 'Verfügbarkeit braucht einen Zeitraum (von/bis)' };
    research.availability = input.availability;
  }

  return {
    lead: {
      display_name,
      organization,
      party_type,
      email,
      phone,
      website: clean(input.website),
      address: clean(input.address),
      city: clean(input.city),
      country: clean(input.country)?.toUpperCase() ?? null,
      language: clean(input.language)?.toLowerCase() ?? 'de',
      source_url: clean(input.source_url),
      verified_at: clean(input.verified_at),
      audience_id: clean(input.audience_id),
      research,
    },
  };
}

export type MatchKind = 'new' | 'update' | 'conflict';

export interface MatchResult {
  kind: MatchKind;
  contactId?: string;
  reason: string;
}

/** Sichere Treffer ergänzen, widersprüchliche Treffer gehen in die Prüfung. */
export async function matchLead(env: Env, workspaceId: string, lead: NormalizedLead): Promise<MatchResult> {
  const byEmail = lead.email
    ? await env.DB.prepare('SELECT id, phone FROM contacts WHERE workspace_id = ?1 AND email = ?2').bind(workspaceId, lead.email).first<{ id: string; phone: string | null }>()
    : null;
  const byPhone = lead.phone
    ? await env.DB.prepare('SELECT id, email FROM contacts WHERE workspace_id = ?1 AND phone = ?2').bind(workspaceId, lead.phone).first<{ id: string; email: string | null }>()
    : null;

  if (byEmail && byPhone && byEmail.id !== byPhone.id) {
    return { kind: 'conflict', reason: 'E-Mail und Telefon gehören zu unterschiedlichen Kontakten' };
  }
  if (byEmail) {
    if (lead.phone && byEmail.phone && byEmail.phone !== lead.phone) {
      return { kind: 'conflict', contactId: byEmail.id, reason: 'Gleiche E-Mail, abweichende Telefonnummer' };
    }
    return { kind: 'update', contactId: byEmail.id, reason: 'Treffer über E-Mail' };
  }
  if (byPhone) {
    if (lead.email && byPhone.email && byPhone.email !== lead.email) {
      return { kind: 'conflict', contactId: byPhone.id, reason: 'Gleiche Telefonnummer, abweichende E-Mail' };
    }
    return { kind: 'update', contactId: byPhone.id, reason: 'Treffer über Telefon' };
  }
  if (lead.organization && lead.city) {
    const byOrg = await env.DB.prepare(
      'SELECT id FROM contacts WHERE workspace_id = ?1 AND lower(organization) = lower(?2) AND lower(city) = lower(?3)',
    )
      .bind(workspaceId, lead.organization, lead.city)
      .first<{ id: string }>();
    if (byOrg) return { kind: 'conflict', contactId: byOrg.id, reason: 'Gleiche Organisation und Stadt ohne eindeutige Kennung' };
  }
  return { kind: 'new', reason: 'Neuer Kontakt' };
}

async function assertAudience(env: Env, workspaceId: string, audienceId: string | null) {
  if (!audienceId) return;
  const ok = await env.DB.prepare('SELECT 1 FROM audiences WHERE id = ?1 AND workspace_id = ?2').bind(audienceId, workspaceId).first();
  if (!ok) throw new HttpError(400, 'Zielgruppe gehört nicht zu diesem Arbeitsbereich');
}

export async function applyLead(
  env: Env,
  actor: Actor,
  workspaceId: string,
  lead: NormalizedLead,
  match: MatchResult,
): Promise<{ id: string; action: 'created' | 'updated' }> {
  await assertAudience(env, workspaceId, lead.audience_id);
  const now = nowIso();
  if (match.kind === 'update' && match.contactId) {
    const existing = await getContact(env, workspaceId, match.contactId);
    // Ergänzen statt überschreiben: Recherchemerkmale werden zusammengeführt, leere Felder aufgefüllt
    const research = { ...parseJson<Record<string, unknown>>(existing.research, {}), ...lead.research };
    await env.DB.prepare(
      `UPDATE contacts SET
        organization = coalesce(organization, ?3), email = coalesce(email, ?4), phone = coalesce(phone, ?5),
        website = coalesce(website, ?6), address = coalesce(address, ?7), city = coalesce(city, ?8), country = coalesce(country, ?9),
        source_url = coalesce(?10, source_url), verified_at = coalesce(?11, verified_at),
        party_type = CASE WHEN party_type = 'unknown' THEN ?12 ELSE party_type END,
        audience_id = coalesce(audience_id, ?13), research = ?14, updated_at = ?15
       WHERE id = ?1 AND workspace_id = ?2`,
    )
      .bind(
        existing.id, workspaceId, lead.organization, lead.email, lead.phone, lead.website, lead.address, lead.city,
        lead.country, lead.source_url, lead.verified_at, lead.party_type, lead.audience_id, JSON.stringify(research), now,
      )
      .run();
    await audit(env, actor, workspaceId, 'contact.updated', existing.id, { source: lead.source_url });
    return { id: existing.id, action: 'updated' };
  }

  const contactId = id('con');
  let partyType = lead.party_type;
  if (partyType === 'unknown' && lead.audience_id) {
    const aud = await env.DB.prepare('SELECT default_party_type FROM audiences WHERE id = ?1').bind(lead.audience_id).first<{ default_party_type: PartyType }>();
    partyType = aud?.default_party_type ?? 'unknown';
  }
  await env.DB.prepare(
    `INSERT INTO contacts (id, workspace_id, audience_id, display_name, organization, party_type, email, phone, website, address, city, country, language, source_url, verified_at, research, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)`,
  )
    .bind(
      contactId, workspaceId, lead.audience_id, lead.display_name, lead.organization, partyType, lead.email, lead.phone,
      lead.website, lead.address, lead.city, lead.country, lead.language, lead.source_url, lead.verified_at,
      JSON.stringify(lead.research), now,
    )
    .run();
  await audit(env, actor, workspaceId, 'contact.created', contactId, { source: lead.source_url });
  return { id: contactId, action: 'created' };
}

// ---------- Import: lead-research/1.0 (JSON) und CSV ----------

export interface ImportPreviewRow {
  index: number;
  name: string;
  kind: MatchKind | 'invalid';
  reason: string;
  contactId?: string;
}

export function parseImportPayload(body: { format?: string; leads?: LeadInput[]; csv?: string }): LeadInput[] {
  if (body.csv) return parseCsv(body.csv);
  if (body.format && body.format !== 'lead-research/1.0') throw new HttpError(400, `Unbekanntes Format: ${body.format}`);
  if (!Array.isArray(body.leads)) throw new HttpError(400, 'leads fehlt');
  if (body.leads.length > 1000) throw new HttpError(400, 'Maximal 1000 Leads pro Import');
  return body.leads;
}

export async function previewImport(env: Env, workspaceId: string, leads: LeadInput[]) {
  const rows: ImportPreviewRow[] = [];
  for (const [index, input] of leads.entries()) {
    const { lead, error } = normalizeLead(input);
    if (!lead) {
      rows.push({ index, name: String(input.name ?? input.organization ?? '–'), kind: 'invalid', reason: error ?? 'Ungültig' });
      continue;
    }
    const m = await matchLead(env, workspaceId, lead);
    rows.push({ index, name: lead.display_name, kind: m.kind, reason: m.reason, contactId: m.contactId });
  }
  const count = (k: ImportPreviewRow['kind']) => rows.filter((r) => r.kind === k).length;
  return { rows, summary: { new: count('new'), update: count('update'), conflict: count('conflict'), invalid: count('invalid') } };
}

export async function commitImport(env: Env, actor: Actor, workspaceId: string, leads: LeadInput[], audienceId?: string) {
  let created = 0;
  let updated = 0;
  const skipped: ImportPreviewRow[] = [];
  for (const [index, input] of leads.entries()) {
    const { lead, error } = normalizeLead({ ...input, audience_id: input.audience_id ?? audienceId });
    if (!lead) {
      skipped.push({ index, name: String(input.name ?? '–'), kind: 'invalid', reason: error ?? 'Ungültig' });
      continue;
    }
    const m = await matchLead(env, workspaceId, lead);
    if (m.kind === 'conflict') {
      skipped.push({ index, name: lead.display_name, kind: 'conflict', reason: m.reason, contactId: m.contactId });
      continue;
    }
    const r = await applyLead(env, actor, workspaceId, lead, m);
    if (r.action === 'created') created++;
    else updated++;
  }
  await audit(env, actor, workspaceId, 'import.committed', null, { created, updated, skipped: skipped.length });
  return { created, updated, skipped };
}

/** Minimaler CSV-Parser (RFC 4180: Anführungszeichen, Kommas/Semikolons, Zeilenumbrüche in Feldern). */
export function parseCsv(text: string): LeadInput[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row);

  const [header, ...data] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  const known = new Set(['name', 'organization', 'party_type', 'email', 'phone', 'website', 'address', 'city', 'country', 'language', 'source_url', 'verified_at', 'audience_id']);
  return data.map((cols) => {
    const lead: Record<string, unknown> = {};
    const attributes: Record<string, string> = {};
    keys.forEach((k, i) => {
      const v = cols[i]?.trim();
      if (!v) return;
      if (known.has(k)) lead[k] = v;
      else if (k === 'rating_value' || k === 'rating_scale' || k === 'rating_count') {
        const r = (lead.rating as Record<string, number>) ?? {};
        r[k.slice(7)] = Number(v.replace(',', '.'));
        lead.rating = r;
      } else attributes[k] = v;
    });
    if (Object.keys(attributes).length) lead.attributes = attributes;
    return lead as LeadInput;
  });
}
