// Kanalregeln für die Erstansprache in Deutschland (Grundlage: § 7 UWG).
// Das Regelwerk ist bewusst streng und vor dem Livegang juristisch zu prüfen.
//
// - E-Mail, SMS, WhatsApp: vorherige ausdrückliche Einwilligung – auch bei Geschäftskunden.
//   Ausnahme E-Mail: Bestandskunde nach § 7 Abs. 3 UWG (ähnliche Leistung, Hinweis auf Widerspruch).
//   Eine selbst gestellte Anfrage des Kontakts erlaubt die Antwort auf diesem Kanal.
// - Telefon: Verbraucher nur mit ausdrücklicher Einwilligung;
//   Geschäftskontakte bei dokumentierter mutmaßlicher Einwilligung.
// - Brief: zulässig, solange kein Widerspruch vorliegt.
// - Sperrliste (Widerspruch) blockiert jeden Kanal, plattformweit.

export const CHANNELS = ['phone', 'email', 'whatsapp', 'sms', 'letter'] as const;
export type Channel = (typeof CHANNELS)[number];

export const PARTY_TYPES = ['business', 'consumer', 'unknown'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export const CONSENT_BASES = ['express_consent', 'inbound_request', 'existing_customer', 'presumed_b2b'] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export interface ConsentFact {
  channel: Channel;
  basis: ConsentBasis;
  revokedAt?: string | null;
}

export interface ChannelCheckInput {
  channel: Channel;
  partyType: PartyType;
  consents: ConsentFact[];
  suppressed: boolean;
  hasRecipient: boolean;
  /** Letzte eingehende WhatsApp-Nachricht (ISO), für das 24-Stunden-Fenster */
  lastInboundWhatsappAt?: string | null;
  now?: Date;
}

export interface ChannelDecision {
  allowed: boolean;
  basis?: ConsentBasis | 'no_objection';
  reason: string;
  /** WhatsApp außerhalb des 24-Stunden-Fensters: nur genehmigte Vorlage */
  requiresTemplate?: boolean;
}

export const CHANNEL_LABEL: Record<Channel, string> = {
  phone: 'Telefon',
  email: 'E-Mail',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  letter: 'Brief',
};

export const BASIS_LABEL: Record<ConsentBasis, string> = {
  express_consent: 'Ausdrückliche Einwilligung',
  inbound_request: 'Eigene Anfrage des Kontakts',
  existing_customer: 'Bestandskunde (§ 7 Abs. 3 UWG)',
  presumed_b2b: 'Mutmaßliche Einwilligung (Geschäftskontakt)',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function activeBases(consents: ConsentFact[], channel: Channel): Set<ConsentBasis> {
  return new Set(consents.filter((c) => c.channel === channel && !c.revokedAt).map((c) => c.basis));
}

export function evaluateChannel(input: ChannelCheckInput): ChannelDecision {
  const { channel, partyType, suppressed, hasRecipient } = input;

  if (suppressed) {
    return { allowed: false, reason: 'Widerspruch auf der Sperrliste – keine Kontaktaufnahme.' };
  }
  if (!hasRecipient) {
    return { allowed: false, reason: `Für ${CHANNEL_LABEL[channel]} ist keine Empfängerangabe hinterlegt.` };
  }

  const bases = activeBases(input.consents, channel);

  switch (channel) {
    case 'letter':
      return { allowed: true, basis: 'no_objection', reason: 'Briefwerbung ist ohne Widerspruch zulässig.' };

    case 'phone': {
      if (bases.has('express_consent')) return { allowed: true, basis: 'express_consent', reason: BASIS_LABEL.express_consent };
      if (bases.has('inbound_request')) return { allowed: true, basis: 'inbound_request', reason: 'Rückruf auf eigene Anfrage.' };
      if (partyType === 'consumer') {
        return { allowed: false, reason: 'Verbraucher: Anruf nur mit ausdrücklicher Einwilligung.' };
      }
      if (partyType === 'unknown') {
        return { allowed: false, reason: 'Unklar, ob Geschäftskontakt oder Verbraucher – bitte zuerst einordnen.' };
      }
      if (bases.has('presumed_b2b')) {
        return { allowed: true, basis: 'presumed_b2b', reason: 'Geschäftskontakt mit dokumentierter mutmaßlicher Einwilligung.' };
      }
      return {
        allowed: false,
        reason: 'Geschäftskontakt: mutmaßliche Einwilligung (konkreter Bedarfsbezug) zuerst dokumentieren.',
      };
    }

    case 'email':
    case 'sms':
    case 'whatsapp': {
      let basis: ConsentBasis | undefined;
      if (bases.has('express_consent')) basis = 'express_consent';
      else if (bases.has('inbound_request')) basis = 'inbound_request';
      else if (channel === 'email' && bases.has('existing_customer')) basis = 'existing_customer';

      if (!basis) {
        return {
          allowed: false,
          reason: `${CHANNEL_LABEL[channel]}-Werbung braucht eine vorherige ausdrückliche Einwilligung – auch bei Firmen.`,
        };
      }
      if (channel === 'whatsapp') {
        const now = input.now ?? new Date();
        const last = input.lastInboundWhatsappAt ? Date.parse(input.lastInboundWhatsappAt) : NaN;
        const inWindow = Number.isFinite(last) && now.getTime() - last < DAY_MS;
        if (!inWindow) {
          return { allowed: true, basis, reason: BASIS_LABEL[basis], requiresTemplate: true };
        }
      }
      return { allowed: true, basis, reason: BASIS_LABEL[basis] };
    }
  }
}

/** Liefert die Entscheidung für alle Kanäle, z. B. für die Kontaktansicht. */
export function evaluateAllChannels(
  base: Omit<ChannelCheckInput, 'channel' | 'hasRecipient'>,
  recipients: Partial<Record<Channel, boolean>>,
): Record<Channel, ChannelDecision> {
  const out = {} as Record<Channel, ChannelDecision>;
  for (const channel of CHANNELS) {
    out[channel] = evaluateChannel({ ...base, channel, hasRecipient: recipients[channel] ?? false });
  }
  return out;
}
