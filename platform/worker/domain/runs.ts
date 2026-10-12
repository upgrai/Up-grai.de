import { CHANNELS, type Channel } from '../../shared/policy';
import type { Actor, Env } from '../env';
import { HttpError, id, nowIso } from '../util';
import { approvalHash } from './approvals';
import { audit } from './audit';
import { getContact } from './contacts';

export type AgentId = 'research' | 'qualify' | 'sales' | 'followup' | 'phone';
export type StepId = 'research' | 'qualify' | 'policy' | 'draft' | 'approval' | 'send' | 'followup';
export type EventStatus = 'started' | 'done' | 'blocked' | 'failed' | 'waiting';
export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export const STEP_AGENT: Record<StepId, AgentId> = {
  research: 'research',
  qualify: 'qualify',
  policy: 'sales',
  draft: 'sales',
  approval: 'sales',
  send: 'sales',
  followup: 'followup',
};

export async function recordEvent(
  env: Env,
  workspaceId: string,
  runId: string,
  step: StepId,
  status: EventStatus,
  message = '',
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO workflow_events (workspace_id, run_id, step, agent, status, message) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind(workspaceId, runId, step, STEP_AGENT[step], status, message),
    env.DB.prepare('UPDATE workflow_runs SET current_step = ?1, updated_at = ?2 WHERE id = ?3').bind(step, nowIso(), runId),
  ]);
}

export async function setRunStatus(env: Env, runId: string, status: RunStatus, patch: { context?: unknown; costCents?: number } = {}) {
  await env.DB.prepare(
    `UPDATE workflow_runs SET status = ?1, updated_at = ?2,
       context = coalesce(?3, context), cost_cents = cost_cents + ?4 WHERE id = ?5`,
  )
    .bind(status, nowIso(), patch.context === undefined ? null : JSON.stringify(patch.context), patch.costCents ?? 0, runId)
    .run();
}

const ACTIVE = `('queued','running')`;

export async function startPipeline(
  env: Env,
  actor: Actor,
  workspaceId: string,
  contactId: string,
  channel: Channel,
): Promise<{ runId: string }> {
  if (!CHANNELS.includes(channel)) throw new HttpError(400, 'Unbekannter Kanal');
  const contact = await getContact(env, workspaceId, contactId);
  if (contact.status === 'paused') throw new HttpError(409, 'Kontakt ist pausiert (Widerspruch oder manuelle Pause)');

  const ws = await env.DB.prepare('SELECT max_parallel_runs FROM workspaces WHERE id = ?1').bind(workspaceId).first<{ max_parallel_runs: number }>();
  const active = await env.DB.prepare(`SELECT count(*) AS n FROM workflow_runs WHERE workspace_id = ?1 AND status IN ${ACTIVE}`)
    .bind(workspaceId)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= (ws?.max_parallel_runs ?? 2)) {
    throw new HttpError(429, `Höchstens ${ws?.max_parallel_runs ?? 2} parallele Agentenläufe – bitte warten, bis ein Lauf fertig ist.`);
  }
  const open = await env.DB.prepare(
    `SELECT id FROM workflow_runs WHERE contact_id = ?1 AND status IN ('queued','running','waiting_approval')`,
  )
    .bind(contactId)
    .first<{ id: string }>();
  if (open) throw new HttpError(409, 'Für diesen Kontakt läuft bereits ein Agentenlauf');

  const runId = id('run');
  await env.DB.prepare(
    `INSERT INTO workflow_runs (id, workspace_id, contact_id, channel, status, started_by) VALUES (?1, ?2, ?3, ?4, 'queued', ?5)`,
  )
    .bind(runId, workspaceId, contactId, channel, actor.email)
    .run();
  await env.LEAD_PIPELINE.create({ id: runId, params: { runId, workspaceId, contactId, channel } });
  await audit(env, actor, workspaceId, 'run.started', runId, { contactId, channel });
  return { runId };
}

export async function listRuns(env: Env, workspaceId: string, limit = 30) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.contact_id, r.channel, r.status, r.current_step, r.cost_cents, r.started_by, r.created_at, r.updated_at,
            c.display_name AS contact_name, c.organization AS contact_org
       FROM workflow_runs r LEFT JOIN contacts c ON c.id = r.contact_id
      WHERE r.workspace_id = ?1 ORDER BY r.updated_at DESC LIMIT ?2`,
  )
    .bind(workspaceId, limit)
    .all();
  return results;
}

export async function getRun(env: Env, workspaceId: string, runId: string) {
  const run = await env.DB.prepare('SELECT * FROM workflow_runs WHERE id = ?1 AND workspace_id = ?2').bind(runId, workspaceId).first();
  if (!run) throw new HttpError(404, 'Lauf nicht gefunden');
  const { results: events } = await env.DB.prepare('SELECT * FROM workflow_events WHERE run_id = ?1 ORDER BY id').bind(runId).all();
  return { run, events };
}

export async function eventsSince(env: Env, workspaceId: string, sinceId: number) {
  const { results } = await env.DB.prepare(
    `SELECT e.*, c.display_name AS contact_name FROM workflow_events e
       LEFT JOIN workflow_runs r ON r.id = e.run_id LEFT JOIN contacts c ON c.id = r.contact_id
      WHERE e.workspace_id = ?1 AND e.id > ?2 ORDER BY e.id DESC LIMIT 60`,
  )
    .bind(workspaceId, sinceId)
    .all();
  return results.reverse();
}

/** Status der Agenten für die Dashboard-Dots. */
export async function agentStatus(env: Env, workspaceId: string) {
  const { results } = await env.DB.prepare(
    `SELECT r.status, r.current_step FROM workflow_runs r
      WHERE r.workspace_id = ?1 AND r.status IN ('queued','running','waiting_approval','blocked','failed')
        AND r.updated_at >= ?2`,
  )
    .bind(workspaceId, new Date(Date.now() - 7 * 86_400_000).toISOString())
    .all<{ status: RunStatus; current_step: StepId | null }>();

  type Dot = 'ready' | 'running' | 'approval' | 'paused' | 'error';
  const dots: Record<'research' | 'sales' | 'followup', Dot> = { research: 'ready', sales: 'ready', followup: 'ready' };
  const rank: Record<Dot, number> = { ready: 0, paused: 1, running: 2, approval: 3, error: 4 };
  const bump = (k: keyof typeof dots, d: Dot) => {
    if (rank[d] > rank[dots[k]]) dots[k] = d;
  };
  for (const r of results) {
    const agent = r.current_step ? STEP_AGENT[r.current_step] : 'research';
    const key: keyof typeof dots = agent === 'research' || agent === 'qualify' ? 'research' : agent === 'followup' ? 'followup' : 'sales';
    if (r.status === 'failed') bump(key, 'error');
    else if (r.status === 'waiting_approval') bump(key, 'approval');
    else if (r.status === 'blocked') bump(key, 'paused');
    else bump(key, 'running');
  }
  return dots;
}

// ---------- Freigaben ----------

export async function listApprovals(env: Env, workspaceId: string, status = 'pending') {
  const { results } = await env.DB.prepare(
    `SELECT a.*, c.display_name AS contact_name, c.organization AS contact_org
       FROM approvals a JOIN contacts c ON c.id = a.contact_id
      WHERE a.workspace_id = ?1 AND a.status = ?2 ORDER BY a.created_at DESC LIMIT 100`,
  )
    .bind(workspaceId, status)
    .all();
  return results;
}

/**
 * Freigabe durch einen Menschen in der Oberfläche. KI-Assistenten (MCP) und Agenten dürfen nicht freigeben.
 * Optional geänderter Text: dann wird die alte Freigabe ungültig und eine neue mit neuem Hash erzeugt und sofort entschieden.
 */
export async function decideApproval(
  env: Env,
  actor: Actor,
  workspaceId: string,
  approvalId: string,
  decision: 'approve' | 'reject',
  edited?: { subject?: string; body?: string },
) {
  if (actor.via !== 'ui') throw new HttpError(403, 'Freigaben sind nur in der Oberfläche durch einen Menschen möglich');
  const a = await env.DB.prepare(`SELECT * FROM approvals WHERE id = ?1 AND workspace_id = ?2`)
    .bind(approvalId, workspaceId)
    .first<{ id: string; run_id: string | null; status: string; contact_id: string; channel: string; recipient: string; subject: string; body: string }>();
  if (!a) throw new HttpError(404, 'Freigabe nicht gefunden');
  if (a.status !== 'pending') throw new HttpError(409, 'Freigabe ist nicht mehr offen');

  let finalId = a.id;
  if (decision === 'approve' && edited && (edited.body !== undefined || edited.subject !== undefined)) {
    const subject = edited.subject ?? a.subject;
    const body = edited.body ?? a.body;
    if (subject !== a.subject || body !== a.body) {
      finalId = id('apr');
      const hash = await approvalHash({ workspaceId, contactId: a.contact_id, channel: a.channel, recipient: a.recipient, subject, body });
      await env.DB.batch([
        env.DB.prepare(`UPDATE approvals SET status = 'invalidated', decided_by = ?1, decided_at = ?2 WHERE id = ?3`).bind(actor.email, nowIso(), a.id),
        env.DB.prepare(
          `INSERT INTO approvals (id, workspace_id, run_id, contact_id, channel, recipient, subject, body, content_hash, status, created_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10)`,
        ).bind(finalId, workspaceId, a.run_id, a.contact_id, a.channel, a.recipient, subject, body, hash, actor.email),
      ]);
    }
  }

  const status = decision === 'approve' ? 'approved' : 'rejected';
  const r = await env.DB.prepare(`UPDATE approvals SET status = ?1, decided_by = ?2, decided_at = ?3 WHERE id = ?4 AND status = 'pending'`)
    .bind(status, actor.email, nowIso(), finalId)
    .run();
  if (!r.meta.changes) throw new HttpError(409, 'Freigabe wurde parallel entschieden');
  await audit(env, actor, workspaceId, `approval.${status}`, finalId);

  if (a.run_id) {
    try {
      const instance = await env.LEAD_PIPELINE.get(a.run_id);
      await instance.sendEvent({ type: 'approval-decision', payload: { approvalId: finalId, decision } });
    } catch (err) {
      console.error('approval event delivery failed', a.run_id, err);
    }
  }
  return { approvalId: finalId, status };
}
