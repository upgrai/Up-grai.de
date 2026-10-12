import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './env';
import { HttpError } from './util';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Ermittelt den angemeldeten Benutzer.
 * Produktion: Cloudflare Access schützt die Oberfläche; wir prüfen das signierte JWT selbst.
 * Lokal: DEV_USER_EMAIL, aber nur wenn ENVIRONMENT=development und Access nicht konfiguriert ist.
 */
export async function authenticateUser(request: Request, env: Env): Promise<string> {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();

  if (team && aud) {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) throw new HttpError(401, 'Nicht angemeldet (Cloudflare Access)');
    let jwks = jwksCache.get(team);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
      jwksCache.set(team, jwks);
    }
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: `https://${team}`, audience: aud });
      const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
      if (!email) throw new Error('missing email');
      return email;
    } catch {
      throw new HttpError(401, 'Ungültige Anmeldung');
    }
  }

  if (env.ENVIRONMENT === 'development' && env.DEV_USER_EMAIL) {
    return env.DEV_USER_EMAIL.toLowerCase();
  }
  // Fail closed: ohne Access-Konfiguration kein Zugang außerhalb der Entwicklung
  throw new HttpError(401, 'Anmeldung nicht konfiguriert');
}

/** Legt den Benutzer an und macht OWNER_EMAILS zu Inhabern der vorkonfigurierten Arbeitsbereiche. */
export async function ensureUser(env: Env, email: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (email, last_seen_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  )
    .bind(email)
    .run();

  const owners = (env.OWNER_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (owners.includes(email)) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO memberships (workspace_id, user_email, role)
       SELECT id, ?1, 'owner' FROM workspaces WHERE id IN ('ws_upgrai','ws_hermann')`,
    )
      .bind(email)
      .run();
  }
}

export async function requireMember(
  env: Env,
  workspaceId: string,
  email: string,
): Promise<'owner' | 'member'> {
  const row = await env.DB.prepare('SELECT role FROM memberships WHERE workspace_id = ?1 AND user_email = ?2')
    .bind(workspaceId, email)
    .first<{ role: 'owner' | 'member' }>();
  // 404 statt 403: verrät nicht, ob ein fremder Arbeitsbereich existiert
  if (!row) throw new HttpError(404, 'Arbeitsbereich nicht gefunden');
  return row.role;
}

export async function memberWorkspaceIds(env: Env, email: string): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT workspace_id FROM memberships WHERE user_email = ?1')
    .bind(email)
    .all<{ workspace_id: string }>();
  return results.map((r) => r.workspace_id);
}
