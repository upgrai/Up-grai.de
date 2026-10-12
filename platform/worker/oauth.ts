// Zustimmungsseite für KI-Assistenten (ChatGPT, Claude, …), die sich per OAuth 2.1 mit der Plattform verbinden.
import { AuthorizationError, CimdFetchError, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { MCP_SCOPES } from '../shared/catalog';
import { authenticateUser, ensureUser } from './auth';
import { audit } from './domain/audit';
import type { Env } from './env';
import type { McpProps } from './mcp/server';
import { HttpError } from './util';

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:dark;--bg:#05070d;--card:rgba(17,22,36,.82);--line:rgba(148,163,184,.18);--text:#e6ebf5;--muted:#93a0b8;--accent:#5eead4;--warn:#fbbf24}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:radial-gradient(1200px 600px at 20% -10%,rgba(94,234,212,.16),transparent),radial-gradient(900px 500px at 110% 110%,rgba(139,92,246,.18),transparent),var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
.card{width:100%;max-width:460px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px;backdrop-filter:blur(18px);box-shadow:0 30px 80px rgba(0,0,0,.45)}
h1{font-size:20px;margin:0 0 6px}p{margin:8px 0;color:var(--muted)}strong{color:var(--text)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px;font-weight:600;letter-spacing:.02em}
.dot{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 18px var(--accent)}
label{display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid var(--line);border-radius:12px;margin:8px 0;cursor:pointer}
label span small{display:block;color:var(--muted)}input{margin-top:4px;accent-color:#5eead4}
.warn{border:1px solid rgba(251,191,36,.4);background:rgba(251,191,36,.08);color:var(--warn);padding:10px 12px;border-radius:12px}
.row{display:flex;gap:10px;margin-top:18px}button{flex:1;padding:12px;border-radius:12px;border:1px solid var(--line);font:inherit;font-weight:600;cursor:pointer;background:transparent;color:var(--text)}
button.primary{background:linear-gradient(135deg,#5eead4,#8b5cf6);color:#05070d;border:0}
.note{font-size:13px}
</style></head><body><main class="card"><div class="brand"><span class="dot"></span>UPGRAI Sales</div>${inner}</main></body></html>`;
}

function consentPage(d: ConsentDescription, handle: string, email: string): string {
  const origin = d.clientDomain
    ? `Veröffentlicht von <strong>${esc(d.clientDomain)}</strong>.`
    : 'Diese Anwendung hat sich selbst registriert; ihr Name ist nicht geprüft.';
  const requested = d.scope.length ? d.scope : Object.keys(MCP_SCOPES);
  const scopes = requested
    .filter((s) => s in MCP_SCOPES)
    .map(
      (s) =>
        `<label><input type="checkbox" name="scope" value="${esc(s)}" ${s === 'sales:read' ? 'checked' : ''}><span><strong>${esc(s)}</strong><small>${esc(
          MCP_SCOPES[s as keyof typeof MCP_SCOPES],
        )}</small></span></label>`,
    )
    .join('');
  return page(
    `${d.clientName} verbinden`,
    `<h1>${esc(d.clientName)} mit deinem Vertriebsarbeitsplatz verbinden?</h1>
<p>${origin} Der Zugang wird an <strong>${esc(d.redirectHost)}</strong> gesendet.</p>
${d.redirectIsLoopback ? '<p class="warn">Der Zugang geht an eine Anwendung auf diesem Computer. Fahre nur fort, wenn du die Anmeldung gerade selbst dort gestartet hast.</p>' : ''}
<p>Angemeldet als <strong>${esc(email)}</strong>. Der Assistent sieht nur Arbeitsbereiche, in denen du Mitglied bist.</p>
<form method="post">
<input type="hidden" name="handle" value="${esc(handle)}">
${scopes}
<p class="note">Freigaben, Kontaktberechtigungen und Versand bleiben immer bei dir in der Plattform.</p>
<div class="row"><button name="decision" value="deny">Ablehnen</button><button class="primary" name="decision" value="approve">Erlauben</button></div>
</form>`,
  );
}

function errorPage(message: string, status = 400) {
  return new Response(page('Verbindung nicht möglich', `<h1>Verbindung nicht möglich</h1><p>${esc(message)}</p>`), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' },
  });
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  let email: string;
  try {
    email = await authenticateUser(request, env);
  } catch (err) {
    return errorPage(err instanceof HttpError ? err.message : 'Nicht angemeldet', 401);
  }
  await ensureUser(env, email);

  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set('content-type', 'text/html; charset=utf-8');
      return new Response(consentPage(details, consent.handle, email), { headers: consent.headers });
    }
    if (request.method === 'POST') {
      const form = await request.formData();
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const scope = form.getAll('scope').map(String).filter((s) => s in MCP_SCOPES);
      if (!scope.includes('sales:read')) scope.unshift('sales:read');
      const approved = await oauth.approveConsent(request, handle, { scope });
      const props: McpProps = { email, scopes: approved.request.scope, client: approved.request.clientId };
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: email,
        metadata: { label: approved.request.clientId },
        scope: approved.request.scope,
        props,
      });
      await audit(env, { email, via: 'ui' }, null, 'assistant.connected', approved.request.clientId, { scope: approved.request.scope });
      approved.headers.set('location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response('Method Not Allowed', { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return errorPage(error.description ?? 'Ungültige Anfrage');
    if (error instanceof CimdFetchError) return errorPage('Diese Anwendung konnte nicht überprüft werden.');
    throw error;
  }
}
