import { describe, expect, it } from 'vitest';
import { evaluateChannel, type ChannelCheckInput } from '../shared/policy';

const base: ChannelCheckInput = { channel: 'email', partyType: 'business', consents: [], suppressed: false, hasRecipient: true };

describe('Kanalregeln (§ 7 UWG)', () => {
  it('sperrt Kalt-E-Mail auch an Firmen', () => {
    expect(evaluateChannel(base).allowed).toBe(false);
  });

  it('erlaubt E-Mail mit ausdrücklicher Einwilligung', () => {
    const d = evaluateChannel({ ...base, consents: [{ channel: 'email', basis: 'express_consent' }] });
    expect(d).toMatchObject({ allowed: true, basis: 'express_consent' });
  });

  it('ignoriert widerrufene Einwilligungen', () => {
    const d = evaluateChannel({ ...base, consents: [{ channel: 'email', basis: 'express_consent', revokedAt: '2026-01-01' }] });
    expect(d.allowed).toBe(false);
  });

  it('Bestandskunden-Ausnahme gilt nur für E-Mail', () => {
    const consents = [{ channel: 'sms' as const, basis: 'existing_customer' as const }, { channel: 'email' as const, basis: 'existing_customer' as const }];
    expect(evaluateChannel({ ...base, consents }).allowed).toBe(true);
    expect(evaluateChannel({ ...base, channel: 'sms', consents }).allowed).toBe(false);
  });

  it('Telefon: Verbraucher nur mit ausdrücklicher Einwilligung', () => {
    expect(evaluateChannel({ ...base, channel: 'phone', partyType: 'consumer' }).allowed).toBe(false);
    expect(evaluateChannel({ ...base, channel: 'phone', partyType: 'consumer', consents: [{ channel: 'phone', basis: 'presumed_b2b' }] }).allowed).toBe(false);
    expect(evaluateChannel({ ...base, channel: 'phone', partyType: 'consumer', consents: [{ channel: 'phone', basis: 'express_consent' }] }).allowed).toBe(true);
  });

  it('Telefon: Geschäftskontakt braucht dokumentierte mutmaßliche Einwilligung', () => {
    expect(evaluateChannel({ ...base, channel: 'phone' }).allowed).toBe(false);
    expect(evaluateChannel({ ...base, channel: 'phone', consents: [{ channel: 'phone', basis: 'presumed_b2b' }] }).allowed).toBe(true);
  });

  it('Telefon: unklare Einordnung sperrt', () => {
    const d = evaluateChannel({ ...base, channel: 'phone', partyType: 'unknown', consents: [{ channel: 'phone', basis: 'presumed_b2b' }] });
    expect(d.allowed).toBe(false);
  });

  it('Brief ist ohne Widerspruch zulässig, mit Widerspruch nicht', () => {
    expect(evaluateChannel({ ...base, channel: 'letter', partyType: 'consumer' }).allowed).toBe(true);
    expect(evaluateChannel({ ...base, channel: 'letter', suppressed: true }).allowed).toBe(false);
  });

  it('Sperrliste schlägt jede Einwilligung', () => {
    const d = evaluateChannel({ ...base, suppressed: true, consents: [{ channel: 'email', basis: 'express_consent' }] });
    expect(d.allowed).toBe(false);
  });

  it('ohne Empfängerangabe kein Kontakt', () => {
    expect(evaluateChannel({ ...base, channel: 'letter', hasRecipient: false }).allowed).toBe(false);
  });

  it('WhatsApp außerhalb von 24 Stunden braucht eine Vorlage', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    const consents = [{ channel: 'whatsapp' as const, basis: 'express_consent' as const }];
    const inWindow = evaluateChannel({ ...base, channel: 'whatsapp', consents, lastInboundWhatsappAt: '2026-10-12T08:00:00Z', now });
    const outside = evaluateChannel({ ...base, channel: 'whatsapp', consents, lastInboundWhatsappAt: '2026-10-10T08:00:00Z', now });
    expect(inWindow.requiresTemplate).toBeFalsy();
    expect(outside).toMatchObject({ allowed: true, requiresTemplate: true });
  });
});
