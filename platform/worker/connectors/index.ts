import { CONNECTOR_BY_ID } from '../../shared/catalog';
import { decryptJson, encryptJson } from '../crypto';
import { audit } from '../domain/audit';
import type { Actor, Env } from '../env';
import { HttpError, id, nowIso, parseJson } from '../util';

export interface ConnectionRow {
  id: string;
  workspace_id: string;
  provider: string;
  label: string;
  config: string;
  secret_ciphertext: string | null;
  status: 'unchecked' | 'connected' | 'error';
  last_error: string | null;
  last_checked_at: string | null;
  created_at: string;
}

export interface ResolvedConnection {
  id: string;
  provider: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
}

/** Öffentliche Sicht: niemals Geheimnisse zurückgeben. */
export function publicConnection(row: ConnectionRow) {
  const { secret_ciphertext, config, ...rest } = row;
  return { ...rest, config: parseJson<Record<string, string>>(config, {}), hasSecret: !!secret_ciphertext };
}

export async function listConnections(env: Env, workspaceId: string) {
  const { results } = await env.DB.prepare('SELECT * FROM connections WHERE workspace_id = ?1 ORDER BY created_at')
    .bind(workspaceId)
    .all<ConnectionRow>();
  return results.map(publicConnection);
}

export async function createConnection(
  env: Env,
  actor: Actor,
  workspaceId: string,
  provider: string,
  values: Record<string, string>,
  label?: string,
) {
  const def = CONNECTOR_BY_ID[provider];
  if (!def || def.planned) throw new HttpError(400, 'Dieser Anbieter ist nicht verfügbar');
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const f of def.fields) {
    const v = values[f.key]?.trim();
    if (!v) {
      if (f.required) throw new HttpError(400, `${f.label} fehlt`);
      continue;
    }
    (f.secret ? secrets : config)[f.key] = v;
  }
  if (provider === 'webhook_in') {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    secrets.token = `whk_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  const connId = id('cxn');
  const ciphertext = Object.keys(secrets).length ? await encryptJson(env.ENCRYPTION_KEY, secrets) : null;
  await env.DB.prepare(
    'INSERT INTO connections (id, workspace_id, provider, label, config, secret_ciphertext, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  )
    .bind(connId, workspaceId, provider, label?.trim() || def.name, JSON.stringify(config), ciphertext, actor.email)
    .run();
  await audit(env, actor, workspaceId, 'connection.created', connId, { provider });
  // Webhook-Token wird genau einmal im Klartext angezeigt
  return { id: connId, oneTimeSecret: provider === 'webhook_in' ? secrets.token : undefined };
}

export async function deleteConnection(env: Env, actor: Actor, workspaceId: string, connectionId: string) {
  const r = await env.DB.prepare('DELETE FROM connections WHERE id = ?1 AND workspace_id = ?2').bind(connectionId, workspaceId).run();
  if (!r.meta.changes) throw new HttpError(404, 'Verbindung nicht gefunden');
  await env.DB.prepare('UPDATE workspaces SET ai_provider = NULL WHERE id = ?1 AND ai_provider = ?2').bind(workspaceId, connectionId).run();
  await audit(env, actor, workspaceId, 'connection.deleted', connectionId);
}

export async function resolveConnection(env: Env, row: ConnectionRow): Promise<ResolvedConnection> {
  return {
    id: row.id,
    provider: row.provider,
    config: parseJson(row.config, {}),
    secrets: row.secret_ciphertext ? await decryptJson(env.ENCRYPTION_KEY, row.secret_ciphertext) : {},
  };
}

/** Erste geprüfte Verbindung eines Anbieters (bzw. mit Fähigkeit) im Arbeitsbereich. */
export async function findConnection(env: Env, workspaceId: string, providers: string[]): Promise<ResolvedConnection | null> {
  if (!providers.length) return null;
  const row = await env.DB.prepare(
    `SELECT * FROM connections WHERE workspace_id = ?1 AND status = 'connected'
       AND provider IN (${providers.map((_, i) => `?${i + 2}`).join(',')}) ORDER BY created_at LIMIT 1`,
  )
    .bind(workspaceId, ...providers)
    .first<ConnectionRow>();
  return row ? resolveConnection(env, row) : null;
}

async function expectOk(res: Response, what: string) {
  if (res.ok) return;
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 200);
  } catch {
    /* ignore */
  }
  throw new Error(`${what}: HTTP ${res.status} ${detail}`);
}

/** Verbindungstest gegen den Anbieter. Ergebnis wird gespeichert. */
export async function testConnection(env: Env, actor: Actor, workspaceId: string, connectionId: string) {
  const row = await env.DB.prepare('SELECT * FROM connections WHERE id = ?1 AND workspace_id = ?2').bind(connectionId, workspaceId).first<ConnectionRow>();
  if (!row) throw new HttpError(404, 'Verbindung nicht gefunden');
  const c = await resolveConnection(env, row);
  let error: string | null = null;
  try {
    switch (c.provider) {
      case 'gemini':
        await expectOk(
          await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.config.model)}`, {
            headers: { 'x-goog-api-key': c.secrets.apiKey },
          }),
          'Gemini',
        );
        break;
      case 'openai':
        await expectOk(
          await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(c.config.model)}`, {
            headers: { authorization: `Bearer ${c.secrets.apiKey}` },
          }),
          'OpenAI',
        );
        break;
      case 'anthropic':
        await expectOk(
          await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(c.config.model)}`, {
            headers: { 'x-api-key': c.secrets.apiKey, 'anthropic-version': '2023-06-01' },
          }),
          'Anthropic',
        );
        break;
      case 'twilio':
        await expectOk(
          await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.config.accountSid)}.json`, {
            headers: { authorization: `Basic ${btoa(`${c.config.accountSid}:${c.secrets.authToken}`)}` },
          }),
          'Twilio',
        );
        break;
      case 'resend':
        await expectOk(await fetch('https://api.resend.com/domains', { headers: { authorization: `Bearer ${c.secrets.apiKey}` } }), 'Resend');
        break;
      case 'webhook_in':
        break;
      default:
        throw new Error('Kein Test für diesen Anbieter');
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const status = error ? 'error' : 'connected';
  await env.DB.prepare('UPDATE connections SET status = ?1, last_error = ?2, last_checked_at = ?3 WHERE id = ?4')
    .bind(status, error, nowIso(), connectionId)
    .run();
  await audit(env, actor, workspaceId, 'connection.tested', connectionId, { status });
  return { status, error };
}
