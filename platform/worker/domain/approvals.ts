import { sha256Hex } from '../util';

export interface ApprovalContent {
  workspaceId: string;
  contactId: string;
  channel: string;
  recipient: string;
  subject: string;
  body: string;
}

/** Freigabe-Hash: jede Änderung an Firma, Kontakt, Kanal, Empfänger, Betreff oder Text macht die Freigabe ungültig. */
export function approvalHash(c: ApprovalContent): Promise<string> {
  const canonical = JSON.stringify([c.workspaceId, c.contactId, c.channel, c.recipient, c.subject, c.body]);
  return sha256Hex(canonical);
}
