import type { Actor, Env } from '../env';
import { HttpError, id, nowIso } from '../util';
import { audit } from './audit';

export type TaskKind = 'callback' | 'followup' | 'reply' | 'call' | 'letter' | 'review' | 'other';

export interface NewTask {
  contactId?: string | null;
  runId?: string | null;
  kind: TaskKind;
  title: string;
  reason?: string;
  dueAt: string;
}

export async function createTask(env: Env, actor: Actor, workspaceId: string, t: NewTask): Promise<string> {
  if (!t.title?.trim()) throw new HttpError(400, 'Titel fehlt');
  if (Number.isNaN(Date.parse(t.dueAt))) throw new HttpError(400, 'Fälligkeit ungültig');
  if (t.contactId) {
    const ok = await env.DB.prepare('SELECT 1 FROM contacts WHERE id = ?1 AND workspace_id = ?2').bind(t.contactId, workspaceId).first();
    if (!ok) throw new HttpError(404, 'Kontakt nicht gefunden');
  }
  const taskId = id('tsk');
  await env.DB.prepare(
    'INSERT INTO tasks (id, workspace_id, contact_id, run_id, kind, title, reason, due_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
  )
    .bind(taskId, workspaceId, t.contactId ?? null, t.runId ?? null, t.kind, t.title.trim(), t.reason ?? '', new Date(t.dueAt).toISOString(), actor.email)
    .run();
  await audit(env, actor, workspaceId, 'task.created', taskId, { kind: t.kind });
  return taskId;
}

export async function completeTask(env: Env, actor: Actor, workspaceId: string, taskId: string) {
  const r = await env.DB.prepare('UPDATE tasks SET done_at = ?1 WHERE id = ?2 AND workspace_id = ?3 AND done_at IS NULL')
    .bind(nowIso(), taskId, workspaceId)
    .run();
  if (!r.meta.changes) throw new HttpError(404, 'Aufgabe nicht gefunden oder bereits erledigt');
  await audit(env, actor, workspaceId, 'task.done', taskId);
}

/** Priorität für "Heute": Rückrufe und Antworten vor Freigaben vor Nachfassen vor Erstkontakten. */
const KIND_RANK: Record<TaskKind, number> = { callback: 0, reply: 1, review: 2, followup: 3, call: 4, letter: 5, other: 6 };

export async function listToday(env: Env, workspaceId: string) {
  const until = new Date();
  until.setHours(23, 59, 59, 999);
  const { results } = await env.DB.prepare(
    `SELECT t.*, c.display_name AS contact_name, c.organization AS contact_org
       FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE t.workspace_id = ?1 AND t.done_at IS NULL AND t.due_at <= ?2
      ORDER BY t.due_at ASC LIMIT 200`,
  )
    .bind(workspaceId, until.toISOString())
    .all<Record<string, unknown> & { kind: TaskKind; due_at: string }>();
  const now = Date.now();
  return results
    .map((t) => ({ ...t, overdue: Date.parse(t.due_at) < now - 3600_000 }))
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.due_at.localeCompare(b.due_at));
}
