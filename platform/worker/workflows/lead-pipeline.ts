import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { CHANNEL_LABEL, evaluateChannel, type Channel } from '../../shared/policy';
import { agentConnection, loadKnowledge, qualifyAgent, researchAgent, salesAgent, type ResearchResult } from '../agents';
import { findConnection } from '../connectors';
import { dispatch } from '../connectors/send';
import { approvalHash } from '../domain/approvals';
import { contactConsents, getContact, isSuppressed, lastInboundWhatsapp, recipientFor } from '../domain/contacts';
import { recordEvent, setRunStatus, type StepId } from '../domain/runs';
import { createTask } from '../domain/tasks';
import type { Actor, Env } from '../env';
import { id, nowIso } from '../util';

export interface LeadPipelineParams {
  runId: string;
  workspaceId: string;
  contactId: string;
  channel: Channel;
}

const WORKFLOW_ACTOR: Actor = { email: 'agent@upgrai', via: 'workflow' };

const CHANNEL_PROVIDERS: Record<Channel, string[]> = {
  email: ['resend'],
  sms: ['twilio'],
  whatsapp: ['twilio'],
  phone: [],
  letter: [],
};

class Blocked extends Error {}

/**
 * Feste Reihenfolge, nicht vom Modell gesteuert:
 * Recherche → Qualifizierung → Kanalprüfung → Entwurf → Freigabe (Mensch) → Kontakt → Wiedervorlage.
 * Jeder Schritt ist einzeln wiederholbar; der Versand ist über den Ausgang (eine Zeile pro Freigabe) gegen Doppelausführung geschützt.
 */
export class LeadPipeline extends WorkflowEntrypoint<Env, LeadPipelineParams> {
  async run(event: WorkflowEvent<LeadPipelineParams>, step: WorkflowStep) {
    const { runId, workspaceId, contactId, channel } = event.payload;
    const env = this.env;
    let current: StepId = 'research';

    const phase = async <T>(name: StepId, label: string, fn: () => Promise<{ value: T; message: string; costCents?: number }>) => {
      current = name;
      // Blockaden (Budget, fehlende Berechtigung) werden nicht wiederholt, sondern als Ergebnis zurückgegeben
      const res = await step.do(name, { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
        await recordEvent(env, workspaceId, runId, name, 'started', label);
        try {
          const out = await fn();
          await recordEvent(env, workspaceId, runId, name, 'done', out.message);
          if (out.costCents) await addSpend(env, workspaceId, runId, out.costCents);
          return { ok: true as const, value: JSON.stringify(out.value ?? null) };
        } catch (err) {
          if (err instanceof Blocked) return { ok: false as const, blocked: err.message };
          throw err;
        }
      });
      if (!res.ok) throw new Blocked(res.blocked);
      return JSON.parse(res.value) as T;
    };

    try {
      await step.do('start', async () => {
        await setRunStatus(env, runId, 'running');
      });

      // 1. Recherche
      const research = await phase<{ result: ResearchResult; version: string }>('research', 'Recherche-Agent sammelt belegte Angaben', async () => {
        await assertBudget(env, workspaceId);
        const contact = await getContact(env, workspaceId, contactId);
        const k = await loadKnowledge(env, contact);
        const out = await researchAgent(await agentConnection(env, workspaceId), k, contact);
        await env.DB.prepare('UPDATE workflow_runs SET knowledge_version = ?1 WHERE id = ?2').bind(k.version, runId).run();
        await env.DB.prepare(`INSERT INTO activities (id, workspace_id, contact_id, kind, direction, summary, created_by) VALUES (?1, ?2, ?3, 'research', 'internal', ?4, ?5)`)
          .bind(id('act'), workspaceId, contactId, out.data.summary, `agent:${out.engine}`)
          .run();
        return { value: { result: out.data, version: k.version }, message: out.data.summary, costCents: out.costCents };
      });

      // 2. Qualifizierung
      await phase('qualify', 'Qualifizierungs-Agent bewertet die Passung', async () => {
        await assertBudget(env, workspaceId);
        const contact = await getContact(env, workspaceId, contactId);
        const k = await loadKnowledge(env, contact);
        const out = await qualifyAgent(await agentConnection(env, workspaceId), k, contact, research.result);
        const score = Math.max(0, Math.min(100, Math.round(Number(out.data.score) || 0)));
        await env.DB.prepare(`UPDATE contacts SET score = ?1, score_reason = ?2, status = CASE WHEN status = 'new' THEN 'qualified' ELSE status END, updated_at = ?3 WHERE id = ?4`)
          .bind(score, out.data.reason, nowIso(), contactId)
          .run();
        return { value: score, message: `Passung ${score}/100 – ${out.data.reason}`, costCents: out.costCents };
      });

      // 3. Kanalprüfung (Kontaktberechtigung)
      const policy = await phase<{ allowed: boolean; reason: string; recipient: string | null; requiresTemplate: boolean }>(
        'policy',
        `Prüfe Kontaktberechtigung für ${CHANNEL_LABEL[channel]}`,
        async () => {
          const d = await checkChannel(env, workspaceId, contactId, channel);
          return { value: d, message: d.allowed ? `Erlaubt: ${d.reason}` : `Gesperrt: ${d.reason}` };
        },
      );
      if (!policy.allowed || !policy.recipient) throw new Blocked(policy.reason);
      if (policy.requiresTemplate) {
        throw new Blocked('WhatsApp außerhalb des 24-Stunden-Fensters: nur mit genehmigter Vorlage (noch nicht hinterlegt).');
      }

      // 4. Entwurf → Freigabe anlegen
      const approvalId = await phase<string>('draft', 'Vertriebs-Agent entwirft die Ansprache', async () => {
        await assertBudget(env, workspaceId);
        const contact = await getContact(env, workspaceId, contactId);
        const k = await loadKnowledge(env, contact);
        const sender = await senderName(env, workspaceId);
        const out = await salesAgent(await agentConnection(env, workspaceId), k, contact, research.result, channel, sender);
        const subject = String(out.data.subject ?? '').slice(0, 300);
        const body = String(out.data.body ?? '').slice(0, 8000);
        if (!body.trim()) throw new Error('Leerer Entwurf');
        const aid = id('apr');
        const hash = await approvalHash({ workspaceId, contactId, channel, recipient: policy.recipient!, subject, body });
        await env.DB.prepare(
          `INSERT INTO approvals (id, workspace_id, run_id, contact_id, channel, recipient, subject, body, content_hash, created_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
          .bind(aid, workspaceId, runId, contactId, channel, policy.recipient, subject, body, hash, `agent:${out.engine}`)
          .run();
        return { value: aid, message: `Entwurf bereit (${out.engine === 'demo' ? 'Demo-Modus' : out.engine})`, costCents: out.costCents };
      });

      // 5. Auf deine Freigabe warten
      current = 'approval';
      await step.do('await-approval', async () => {
        await recordEvent(env, workspaceId, runId, 'approval', 'waiting', 'Wartet auf deine Freigabe');
        await setRunStatus(env, runId, 'waiting_approval');
      });
      let decision: { approvalId: string; decision: 'approve' | 'reject' };
      try {
        const ev = await step.waitForEvent<{ approvalId: string; decision: 'approve' | 'reject' }>('approval', {
          type: 'approval-decision',
          timeout: '14 days',
        });
        decision = ev.payload;
      } catch {
        await step.do('approval-timeout', async () => {
          await env.DB.prepare(`UPDATE approvals SET status = 'invalidated' WHERE run_id = ?1 AND status = 'pending'`).bind(runId).run();
          await recordEvent(env, workspaceId, runId, 'approval', 'blocked', 'Keine Freigabe innerhalb von 14 Tagen – Lauf beendet');
          await setRunStatus(env, runId, 'cancelled');
        });
        return;
      }
      if (decision.decision !== 'approve') {
        await step.do('rejected', async () => {
          await recordEvent(env, workspaceId, runId, 'approval', 'done', 'Entwurf abgelehnt – kein Kontakt');
          await setRunStatus(env, runId, 'completed');
        });
        return;
      }
      await step.do('approved', async () => {
        await recordEvent(env, workspaceId, runId, 'approval', 'done', 'Freigegeben');
        await setRunStatus(env, runId, 'running');
      });

      // 6. Kontakt: Hash und Berechtigung erneut prüfen, dann genau einmal ausführen
      current = 'send';
      const sent = await step.do('send', { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' } }, async () => {
        await recordEvent(env, workspaceId, runId, 'send', 'started', `${CHANNEL_LABEL[channel]}: Ausführung`);
        return executeApproved(env, workspaceId, runId, decision.approvalId ?? approvalId, channel);
      });
      if (sent.status === 'blocked') throw new Blocked(sent.message);
      await step.do('send-recorded', async () => {
        await recordEvent(env, workspaceId, runId, 'send', 'done', sent.message);
      });

      // 7. Wiedervorlage
      await phase('followup', 'Nachfass-Agent plant die Wiedervorlage', async () => {
        const due = addBusinessDays(3);
        await createTask(env, WORKFLOW_ACTOR, workspaceId, {
          contactId,
          runId,
          kind: 'followup',
          title: `Nachfassen: ${CHANNEL_LABEL[channel]}`,
          reason: 'Keine Antwort nach Erstkontakt (3 Werktage)',
          dueAt: due,
        });
        return { value: due, message: `Wiedervorlage am ${new Date(due).toLocaleDateString('de-DE')}` };
      });

      await step.do('finish', async () => {
        await setRunStatus(env, runId, 'completed');
      });
    } catch (err) {
      const blocked = err instanceof Blocked;
      const message = err instanceof Error ? err.message : String(err);
      await step.do('fail', async () => {
        await recordEvent(env, workspaceId, runId, current, blocked ? 'blocked' : 'failed', message);
        await setRunStatus(env, runId, blocked ? 'blocked' : 'failed');
        if (blocked) {
          await createTask(env, WORKFLOW_ACTOR, workspaceId, {
            contactId,
            runId,
            kind: 'review',
            title: 'Agentenlauf blockiert – bitte prüfen',
            reason: message,
            dueAt: nowIso(),
          });
        }
      });
    }
  }
}

function addBusinessDays(n: number, from = new Date()): string {
  const d = new Date(from);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  d.setUTCHours(8, 0, 0, 0);
  return d.toISOString();
}

async function senderName(env: Env, workspaceId: string): Promise<string> {
  const ws = await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?1').bind(workspaceId).first<{ name: string }>();
  return `Ihr Team von ${ws?.name ?? 'uns'}`;
}

async function checkChannel(env: Env, workspaceId: string, contactId: string, channel: Channel) {
  const c = await getContact(env, workspaceId, contactId);
  const recipient = recipientFor(c, channel);
  const d = evaluateChannel({
    channel,
    partyType: c.party_type,
    consents: await contactConsents(env, contactId),
    suppressed: await isSuppressed(env, c.email, c.phone),
    hasRecipient: !!recipient,
    lastInboundWhatsappAt: await lastInboundWhatsapp(env, contactId),
  });
  return { allowed: d.allowed, reason: d.reason, recipient, requiresTemplate: !!d.requiresTemplate };
}

async function assertBudget(env: Env, workspaceId: string) {
  const ws = await env.DB.prepare('SELECT daily_ai_budget_cents FROM workspaces WHERE id = ?1').bind(workspaceId).first<{ daily_ai_budget_cents: number }>();
  const spent = await env.DB.prepare('SELECT spent_cents FROM ai_spend WHERE workspace_id = ?1 AND day = ?2')
    .bind(workspaceId, new Date().toISOString().slice(0, 10))
    .first<{ spent_cents: number }>();
  const reserve = 3; // Reservierung pro Agentenschritt in Cent
  if ((spent?.spent_cents ?? 0) + reserve > (ws?.daily_ai_budget_cents ?? 500)) {
    throw new Blocked('KI-Tagesbudget erreicht – morgen geht es weiter oder Budget in den Einstellungen erhöhen.');
  }
}

async function addSpend(env: Env, workspaceId: string, runId: string, cents: number) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ai_spend (workspace_id, day, spent_cents) VALUES (?1, ?2, ?3)
       ON CONFLICT(workspace_id, day) DO UPDATE SET spent_cents = spent_cents + excluded.spent_cents`,
    ).bind(workspaceId, new Date().toISOString().slice(0, 10), cents),
    env.DB.prepare('UPDATE workflow_runs SET cost_cents = cost_cents + ?1 WHERE id = ?2').bind(cents, runId),
  ]);
}

/**
 * Führt eine Freigabe genau einmal aus.
 * - Hash wird neu berechnet: geänderter Inhalt = keine Ausführung.
 * - Kontaktberechtigung und Sperrliste werden erneut geprüft.
 * - Ausgangszeile mit UNIQUE(approval_id): ein zweiter Versuch findet den vorhandenen Eintrag und sendet nicht erneut.
 */
export async function executeApproved(env: Env, workspaceId: string, runId: string, approvalId: string, channel: Channel) {
  const a = await env.DB.prepare(`SELECT * FROM approvals WHERE id = ?1 AND workspace_id = ?2`)
    .bind(approvalId, workspaceId)
    .first<{ id: string; status: string; contact_id: string; channel: string; recipient: string; subject: string; body: string; content_hash: string }>();
  if (!a || a.status !== 'approved') return { status: 'blocked' as const, message: 'Keine gültige Freigabe' };
  const hash = await approvalHash({ workspaceId, contactId: a.contact_id, channel: a.channel, recipient: a.recipient, subject: a.subject, body: a.body });
  if (hash !== a.content_hash || a.channel !== channel) return { status: 'blocked' as const, message: 'Inhalt nach Freigabe verändert – Freigabe ungültig' };

  const check = await checkChannel(env, workspaceId, a.contact_id, channel);
  if (!check.allowed || check.recipient !== a.recipient) {
    return { status: 'blocked' as const, message: `Bei Ausführung gesperrt: ${check.reason}` };
  }

  const existing = await env.DB.prepare('SELECT id, status, provider_ref FROM outbox WHERE approval_id = ?1').bind(a.id).first<{ id: string; status: string; provider_ref: string | null }>();
  if (existing && ['sent', 'manual'].includes(existing.status)) {
    return { status: existing.status as 'sent' | 'manual', message: 'Bereits ausgeführt (keine Doppelaktion)' };
  }
  if (existing && existing.status === 'sending') {
    // Ein früherer Versuch brach während des Versands ab: nicht blind wiederholen, Mensch prüft
    return { status: 'blocked' as const, message: 'Versandstatus unklar – bitte im Anbieter-Protokoll prüfen' };
  }
  const outboxId = existing?.id ?? id('out');
  if (!existing) {
    await env.DB.prepare(`INSERT INTO outbox (id, workspace_id, approval_id, channel, recipient, status) VALUES (?1, ?2, ?3, ?4, ?5, 'queued')`)
      .bind(outboxId, workspaceId, a.id, channel, a.recipient)
      .run();
  }
  await env.DB.prepare(`UPDATE outbox SET status = 'sending', attempts = attempts + 1, updated_at = ?1 WHERE id = ?2`).bind(nowIso(), outboxId).run();

  try {
    const conn = await findConnection(env, workspaceId, CHANNEL_PROVIDERS[channel]);
    const res = await dispatch(channel, conn, { recipient: a.recipient, subject: a.subject, body: a.body, idempotencyKey: a.id });
    const stmts = [
      env.DB.prepare(`UPDATE outbox SET status = ?1, provider_ref = ?2, error = NULL, updated_at = ?3 WHERE id = ?4`).bind(res.status, res.providerRef ?? null, nowIso(), outboxId),
      env.DB.prepare(`UPDATE contacts SET status = CASE WHEN status IN ('new','qualified','researching') THEN 'contacted' ELSE status END, updated_at = ?1 WHERE id = ?2`).bind(nowIso(), a.contact_id),
    ];
    if (res.status === 'sent') {
      stmts.push(
        env.DB.prepare(`INSERT INTO activities (id, workspace_id, contact_id, kind, direction, summary, created_by) VALUES (?1, ?2, ?3, ?4, 'outbound', ?5, 'agent:sales')`)
          .bind(id('act'), workspaceId, a.contact_id, channel, a.subject || a.body.slice(0, 120)),
      );
    }
    await env.DB.batch(stmts);
    if (res.status === 'manual') {
      await createTask(env, WORKFLOW_ACTOR, workspaceId, {
        contactId: a.contact_id,
        runId,
        kind: channel === 'phone' ? 'call' : 'letter',
        title: channel === 'phone' ? 'Freigegebenen Anruf führen' : 'Freigegebenen Brief versenden',
        reason: a.subject,
        dueAt: nowIso(),
      });
    }
    return { status: res.status, message: res.status === 'sent' ? `Gesendet (${res.providerRef ?? 'ok'})` : res.note ?? 'Aufgabe angelegt' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Anbieter hat abgelehnt oder ist nicht erreichbar: Retry erlaubt (Resend dedupliziert zusätzlich über den Idempotency-Key)
    await env.DB.prepare(`UPDATE outbox SET status = 'failed', error = ?1, updated_at = ?2 WHERE id = ?3`).bind(message, nowIso(), outboxId).run();
    if (message.startsWith('Keine geprüfte Verbindung')) return { status: 'blocked' as const, message: `${message} – unter „Verbindungen“ einrichten` };
    throw err;
  }
}
