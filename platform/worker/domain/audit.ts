import type { Actor, Env } from '../env';

export async function audit(
  env: Env,
  actor: Actor,
  workspaceId: string | null,
  action: string,
  target?: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_log (workspace_id, actor, via, action, target, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  )
    .bind(workspaceId, actor.email, actor.via, action, target ?? null, JSON.stringify(detail))
    .run();
}
