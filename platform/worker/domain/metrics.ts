import type { Env } from '../env';

/** Kennzahlen ausschließlich aus erfassten Daten. "Gewonnen" erzeugt keinen Zahlungseingang. */
export async function workspaceMetrics(env: Env, workspaceId: string) {
  const monthStart = new Date();
  monthStart.setDate(1);
  const monthIso = monthStart.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const [payments, pipeline, tasks, approvals, replies, runs, spend, contacts] = await env.DB.batch([
    env.DB.prepare('SELECT coalesce(sum(amount_cents),0) AS v, count(*) AS n FROM payments WHERE workspace_id = ?1 AND received_on >= ?2').bind(workspaceId, monthIso),
    env.DB.prepare(
      `SELECT coalesce(sum(one_time_cents),0) AS one_time, coalesce(sum(recurring_cents_month),0) AS recurring,
              coalesce(sum(CASE WHEN is_estimate = 1 THEN 1 ELSE 0 END),0) AS estimates, count(*) AS n
         FROM opportunities WHERE workspace_id = ?1 AND stage IN ('qualified','meeting','proposal')`,
    ).bind(workspaceId),
    env.DB.prepare(`SELECT count(*) AS n FROM tasks WHERE workspace_id = ?1 AND done_at IS NULL AND due_at <= ?2`).bind(workspaceId, new Date(Date.now() + 86_400_000).toISOString()),
    env.DB.prepare(`SELECT count(*) AS n FROM approvals WHERE workspace_id = ?1 AND status = 'pending'`).bind(workspaceId),
    env.DB.prepare(`SELECT count(*) AS n FROM activities WHERE workspace_id = ?1 AND direction = 'inbound' AND occurred_at >= ?2`).bind(workspaceId, new Date(Date.now() - 7 * 86_400_000).toISOString()),
    env.DB.prepare(`SELECT status, count(*) AS n FROM workflow_runs WHERE workspace_id = ?1 GROUP BY status`).bind(workspaceId),
    env.DB.prepare('SELECT coalesce(spent_cents,0) AS v FROM ai_spend WHERE workspace_id = ?1 AND day = ?2').bind(workspaceId, today),
    env.DB.prepare('SELECT count(*) AS n, coalesce(sum(is_demo),0) AS demo FROM contacts WHERE workspace_id = ?1').bind(workspaceId),
  ]);

  const one = <T>(r: D1Result) => (r.results?.[0] ?? {}) as T;
  const runCounts = Object.fromEntries((runs.results as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  return {
    paymentsMonthCents: one<{ v: number }>(payments).v ?? 0,
    paymentsMonthCount: one<{ n: number }>(payments).n ?? 0,
    pipelineOneTimeCents: one<{ one_time: number }>(pipeline).one_time ?? 0,
    pipelineRecurringCents: one<{ recurring: number }>(pipeline).recurring ?? 0,
    pipelineEstimates: one<{ estimates: number }>(pipeline).estimates ?? 0,
    pipelineCount: one<{ n: number }>(pipeline).n ?? 0,
    tasksDue: one<{ n: number }>(tasks).n ?? 0,
    approvalsPending: one<{ n: number }>(approvals).n ?? 0,
    repliesWeek: one<{ n: number }>(replies).n ?? 0,
    runs: runCounts as Record<string, number>,
    aiSpendTodayCents: one<{ v: number }>(spend).v ?? 0,
    contacts: one<{ n: number }>(contacts).n ?? 0,
    demoContacts: one<{ demo: number }>(contacts).demo ?? 0,
  };
}
