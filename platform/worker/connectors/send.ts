import type { Channel } from '../../shared/policy';
import type { ResolvedConnection } from './index';

export interface SendResult {
  status: 'sent' | 'manual';
  providerRef?: string;
  note?: string;
}

/**
 * Führt eine freigegebene Kontaktaktion aus.
 * Telefon und Brief erzeugen eine Aufgabe für dich (Erstkontakte führst du selbst).
 * E-Mail/SMS/WhatsApp gehen über die verbundene Plattform; Idempotency-Key verhindert Doppelversand.
 */
export async function dispatch(
  channel: Channel,
  conn: ResolvedConnection | null,
  msg: { recipient: string; subject: string; body: string; idempotencyKey: string },
): Promise<SendResult> {
  if (channel === 'phone' || channel === 'letter') {
    return { status: 'manual', note: channel === 'phone' ? 'Anruf als Aufgabe angelegt' : 'Brief als Aufgabe angelegt' };
  }
  if (!conn) throw new Error(`Keine geprüfte Verbindung für ${channel}`);

  if (channel === 'email') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${conn.secrets.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': msg.idempotencyKey,
      },
      body: JSON.stringify({ from: conn.config.from, to: [msg.recipient], subject: msg.subject, text: msg.body }),
    });
    if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { id?: string };
    return { status: 'sent', providerRef: data.id };
  }

  // Twilio (SMS / WhatsApp) hat keinen Idempotency-Key: Schutz vor Doppelversand über den Ausgangsstatus.
  // WhatsApp außerhalb des 24h-Fensters braucht eine Vorlage – das prüft der Workflow vorher.
  const from = channel === 'whatsapp' ? conn.config.whatsappFrom : conn.config.smsFrom;
  if (!from) throw new Error(`Twilio-Absender für ${channel} fehlt`);
  const body = new URLSearchParams({ To: msg.recipient, From: from, Body: msg.body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(conn.config.accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${conn.config.accountSid}:${conn.secrets.authToken}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`Twilio HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { sid?: string };
  return { status: 'sent', providerRef: data.sid };
}
