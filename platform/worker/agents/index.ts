import { CHANNEL_LABEL, type Channel } from '../../shared/policy';
import { findConnection, resolveConnection, type ConnectionRow, type ResolvedConnection } from '../connectors';
import type { ContactRow } from '../domain/contacts';
import type { Env } from '../env';
import { parseJson, sha256Hex } from '../util';
import { estimateCents, generate, parseModelJson } from './llm';
import qualifyRole from './roles/qualify.md';
import researchRole from './roles/research.md';
import salesRole from './roles/sales.md';

export interface Knowledge {
  workspace: { id: string; name: string; description: string | null };
  offer: { name: string; description: string; services: string; pricing: string; limits: string; goal: string } | null;
  audience: { name: string; description: string; criteria: string[] } | null;
  version: string;
}

/** Lädt nur das für diesen Kontakt relevante Wissen; die Version wird im Lauf gespeichert. */
export async function loadKnowledge(env: Env, contact: ContactRow): Promise<Knowledge> {
  const ws = await env.DB.prepare('SELECT id, name, description FROM workspaces WHERE id = ?1').bind(contact.workspace_id).first<Knowledge['workspace']>();
  if (!ws) throw new Error('Arbeitsbereich fehlt');
  const aud = contact.audience_id
    ? await env.DB.prepare('SELECT name, description, criteria, offer_id, updated_at FROM audiences WHERE id = ?1').bind(contact.audience_id).first<{ name: string; description: string; criteria: string; offer_id: string; updated_at: string }>()
    : null;
  const offer = aud
    ? await env.DB.prepare('SELECT name, description, services, pricing, limits, goal, updated_at FROM offers WHERE id = ?1').bind(aud.offer_id).first<Knowledge['offer'] & { updated_at: string }>()
    : null;
  const version = (await sha256Hex(JSON.stringify([offer?.updated_at, aud?.updated_at, researchRole, qualifyRole, salesRole]))).slice(0, 12);
  return {
    workspace: ws,
    offer: offer ? { name: offer.name, description: offer.description, services: offer.services, pricing: offer.pricing, limits: offer.limits, goal: offer.goal } : null,
    audience: aud ? { name: aud.name, description: aud.description, criteria: parseJson<string[]>(aud.criteria, []) } : null,
    version,
  };
}

/** KI-Verbindung des Arbeitsbereichs; null = Demo-Modus (regelbasiert, ohne KI). */
export async function agentConnection(env: Env, workspaceId: string): Promise<ResolvedConnection | null> {
  const ws = await env.DB.prepare('SELECT ai_provider FROM workspaces WHERE id = ?1').bind(workspaceId).first<{ ai_provider: string | null }>();
  if (ws?.ai_provider) {
    const row = await env.DB.prepare(`SELECT * FROM connections WHERE id = ?1 AND workspace_id = ?2 AND status = 'connected'`)
      .bind(ws.ai_provider, workspaceId)
      .first<ConnectionRow>();
    if (row) return resolveConnection(env, row);
  }
  return findConnection(env, workspaceId, ['gemini', 'openai', 'anthropic']);
}

function contactBrief(c: ContactRow) {
  return {
    name: c.display_name,
    organization: c.organization,
    type: c.party_type,
    city: c.city,
    country: c.country,
    language: c.language,
    website: c.website,
    source_url: c.source_url,
    verified_at: c.verified_at,
    research: parseJson<Record<string, unknown>>(c.research, {}),
  };
}

export interface AgentOutput<T> {
  data: T;
  costCents: number;
  engine: string;
}

async function run<T>(conn: ResolvedConnection | null, role: string, payload: unknown, demo: () => T): Promise<AgentOutput<T>> {
  if (!conn) return { data: demo(), costCents: 0, engine: 'demo' };
  const result = await generate(conn, {
    system: `${role}\n\nAntworte ausschließlich mit gültigem JSON im beschriebenen Format.`,
    prompt: JSON.stringify(payload, null, 2),
  });
  return { data: parseModelJson<T>(result.text), costCents: estimateCents(result), engine: `${result.provider}:${result.model}` };
}

export interface ResearchResult {
  summary: string;
  facts: { fact: string; source: string }[];
  open_questions: string[];
}

export function researchAgent(conn: ResolvedConnection | null, k: Knowledge, c: ContactRow) {
  return run<ResearchResult>(conn, researchRole, { workspace: k.workspace.name, audience: k.audience, contact: contactBrief(c) }, () => {
    const facts: ResearchResult['facts'] = [];
    const add = (fact: string | null | undefined, source: string) => fact && facts.push({ fact, source });
    add(c.organization && `Organisation: ${c.organization}`, 'organization');
    add(c.city && `Standort: ${c.city}`, 'city');
    add(c.website && `Website: ${c.website}`, 'website');
    for (const [key, value] of Object.entries(parseJson<Record<string, unknown>>(c.research, {}))) {
      add(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`, c.source_url ?? `research.${key}`);
    }
    const open = (k.audience?.criteria ?? []).filter((crit) => !facts.some((f) => f.fact.toLowerCase().includes(crit.toLowerCase().split(' ')[0])));
    return {
      summary: `${c.display_name}${c.city ? ` (${c.city})` : ''}: ${facts.length} belegte Angaben, ${open.length} offene Fragen. [Demo-Modus – keine KI verbunden]`,
      facts,
      open_questions: open,
    };
  });
}

export interface QualifyResult {
  score: number;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  unknown: string[];
}

export function qualifyAgent(conn: ResolvedConnection | null, k: Knowledge, c: ContactRow, research: ResearchResult) {
  return run<QualifyResult>(conn, qualifyRole, { offer: k.offer, audience: k.audience, contact: contactBrief(c), research }, () => {
    const total = Math.max(k.audience?.criteria.length ?? 0, 1);
    const known = total - research.open_questions.length;
    const score = Math.round(40 + (known / total) * 40 + (c.website ? 0 : 10));
    return {
      score: Math.min(score, 90),
      confidence: known / total > 0.6 ? 'medium' : 'low',
      reason: `${known} von ${total} Qualifizierungsmerkmalen belegt${c.website ? '' : '; keine Website gefunden'}. [Demo-Modus]`,
      unknown: research.open_questions,
    };
  });
}

export interface DraftResult {
  subject: string;
  body: string;
}

export function salesAgent(
  conn: ResolvedConnection | null,
  k: Knowledge,
  c: ContactRow,
  research: ResearchResult,
  channel: Channel,
  sender: string,
) {
  return run<DraftResult>(
    conn,
    salesRole,
    { channel: CHANNEL_LABEL[channel], sender, workspace: k.workspace, offer: k.offer, audience: k.audience, contact: contactBrief(c), research },
    () => {
      const greeting = c.party_type === 'business' && c.organization ? `Guten Tag,` : `Guten Tag ${c.display_name},`;
      const offer = k.offer?.name ?? k.workspace.name;
      const hook = research.facts.find((f) => f.source !== 'organization')?.fact;
      if (channel === 'phone') {
        return {
          subject: `Gesprächsleitfaden: ${c.organization ?? c.display_name}`,
          body: [
            `Einstieg: ${sender} von ${k.workspace.name}. Ich rufe an wegen ${offer.toLowerCase()}.`,
            hook ? `Bezug: ${hook}` : 'Bezug: noch keine belegte Angabe – offen fragen.',
            'Frage 1: Wie kommen heute die meisten Anfragen zu Ihnen?',
            'Frage 2: Was müsste sich ändern, damit es sich für Sie lohnt?',
            'Nächster Schritt: 20-Minuten-Termin für ein Beratungsgespräch vorschlagen.',
            '[Demo-Modus – Entwurf ohne KI]',
          ].join('\n'),
        };
      }
      return {
        subject: `${offer} für ${c.organization ?? c.display_name}`,
        body: [
          greeting,
          '',
          `mein Name ist ${sender} von ${k.workspace.name}. ${k.offer?.description ?? ''}`.trim(),
          hook ? `Mir ist aufgefallen: ${hook}.` : '',
          `Hätten Sie Interesse an einem kurzen Gespräch dazu?`,
          '',
          'Viele Grüße',
          sender,
          '',
          channel === 'letter' ? '' : 'Sie möchten keine weiteren Nachrichten? Eine kurze Antwort genügt.',
          '[Demo-Modus – Entwurf ohne KI]',
        ]
          .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
          .join('\n'),
      };
    },
  );
}
