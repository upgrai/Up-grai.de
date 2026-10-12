import { ExternalTokenError, OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { MCP_SCOPES } from '../shared/catalog';
import { api } from './api';
import { recordEvent, setRunStatus, type StepId } from './domain/runs';
import type { Env } from './env';
import { handleMcp, type McpProps } from './mcp/server';
import { handleAuthorize } from './oauth';
import { sha256Hex } from './util';

export { LeadPipeline } from './workflows/lead-pipeline';

const SCOPES = Object.keys(MCP_SCOPES);

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: McpProps }) {
    const props = ctx.props;
    if (!props?.email) return new Response('Unauthorized', { status: 401 });
    return handleMcp(request, env, props);
  },
};

const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === '/authorize') return handleAuthorize(request, env);
    if (url.pathname.startsWith('/api/')) return api.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};

// Die Ressourcen-URL hängt von der Domain ab; daher einmal pro PUBLIC_URL erzeugt.
const providers = new Map<string, OAuthProvider<Env>>();

function provider(env: Env): OAuthProvider<Env> {
  const base = env.PUBLIC_URL.replace(/\/$/, '');
  let p = providers.get(base);
  if (p) return p;
  const resource = `${base}/mcp`;
  p = new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: mcpHandler as never,
    defaultHandler: defaultHandler as never,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/register',
    scopesSupported: [...SCOPES, 'offline_access'],
    requiredScopes: ['sales:read'],
    resourceMetadata: { resource, authorization_servers: [base] },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    // Persönliche Zugangsschlüssel (upg_…) für Automationen ohne OAuth, z. B. n8n oder Skripte
    resolveExternalToken: async ({ token, env: e }) => {
      if (!token.startsWith('upg_')) return null;
      const row = await (e as Env).DB.prepare('SELECT id, user_email, scopes FROM api_tokens WHERE token_hash = ?1 AND revoked_at IS NULL')
        .bind(await sha256Hex(token))
        .first<{ id: string; user_email: string; scopes: string }>();
      if (!row) return null;
      const scopes = row.scopes.split(' ').filter((s) => SCOPES.includes(s));
      if (!scopes.length) throw new ExternalTokenError('insufficient_scope', { description: 'Schlüssel ohne Berechtigung', statusCode: 403, requiredScopes: ['sales:read'] });
      await (e as Env).DB.prepare(`UPDATE api_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`).bind(row.id).run();
      const props: McpProps = { email: row.user_email, scopes, client: `token:${row.id}` };
      return { props, audience: resource };
    },
  });
  providers.set(base, p);
  return p;
}

/** Aufräumen: Läufe, deren Workflow-Instanz abgebrochen ist, sichtbar als Fehler markieren. */
async function reconcileRuns(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, workspace_id, current_step FROM workflow_runs WHERE status IN ('queued','running') AND updated_at < ?1 LIMIT 50`,
  )
    .bind(new Date(Date.now() - 30 * 60_000).toISOString())
    .all<{ id: string; workspace_id: string; current_step: StepId | null }>();
  for (const r of results) {
    try {
      const status = await (await env.LEAD_PIPELINE.get(r.id)).status();
      if (status.status === 'errored' || status.status === 'terminated') {
        await recordEvent(env, r.workspace_id, r.id, r.current_step ?? 'research', 'failed', `Workflow ${status.status}: ${status.error?.message ?? ''}`.trim());
        await setRunStatus(env, r.id, 'failed');
      }
    } catch (err) {
      console.error('reconcile failed', r.id, err);
    }
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return provider(env).fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(reconcileRuns(env));
  },
} satisfies ExportedHandler<Env>;
