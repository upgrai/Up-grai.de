import { describe, expect, it } from 'vitest';
import { approvalHash } from '../worker/domain/approvals';
import { normalizeLead, parseCsv } from '../worker/domain/contacts';
import { normalizePhone } from '../worker/util';

describe('Telefonnummern', () => {
  it('normalisiert deutsche und internationale Formate nach E.164', () => {
    expect(normalizePhone('040 / 123 456-7')).toBe('+49401234567');
    expect(normalizePhone('0049 40 1234567')).toBe('+49401234567');
    expect(normalizePhone('+48 600 700 800')).toBe('+48600700800');
    expect(normalizePhone('whatsapp:+49 170 1234567')).toBe('+491701234567');
    expect(normalizePhone('abc')).toBeNull();
  });
});

describe('Lead-Normalisierung (lead-research/1.0)', () => {
  it('braucht Name oder Organisation', () => {
    expect(normalizeLead({}).error).toBeTruthy();
    expect(normalizeLead({ organization: 'Café Nord' }).lead?.display_name).toBe('Café Nord');
  });

  it('lehnt ungültige E-Mail ab, statt sie zu verwerfen', () => {
    expect(normalizeLead({ name: 'A', email: 'kein-mail' }).error).toMatch(/E-Mail/);
  });

  it('Bewertung behält Skala und Anzahl, Verfügbarkeit braucht Zeitraum', () => {
    const ok = normalizeLead({ name: 'A', rating: { value: 4.6, scale: 5, count: 132 } });
    expect(ok.lead?.research.rating).toEqual({ value: 4.6, scale: 5, count: 132 });
    expect(normalizeLead({ name: 'A', rating: { value: 4.6 } as never }).error).toBeTruthy();
    expect(normalizeLead({ name: 'A', availability: { from: '2026-11-01', to: '' } }).error).toBeTruthy();
  });

  it('unbekannter Kontakttyp bleibt unbekannt', () => {
    expect(normalizeLead({ name: 'A', party_type: 'firma?' }).lead?.party_type).toBe('unknown');
  });
});

describe('CSV-Import', () => {
  it('liest Semikolon-CSV mit Anführungszeichen, Bewertung und Zusatzmerkmalen', () => {
    const csv = 'name;city;phone;rating_value;rating_scale;rating_count;Online-Reservierung\n"Trattoria ""Da Rosa""";Hamburg;040 1234567;4,5;5;87;nein\n';
    const [lead] = parseCsv(csv);
    expect(lead.name).toBe('Trattoria "Da Rosa"');
    expect(lead.rating).toEqual({ value: 4.5, scale: 5, count: 87 });
    expect(lead.attributes).toEqual({ 'online-reservierung': 'nein' });
  });

  it('liest Komma-CSV mit Zeilenumbruch im Feld', () => {
    const rows = parseCsv('name,address\r\n"Haus A","Weg 1\nHinterhaus"\r\nHaus B,Weg 2');
    expect(rows).toHaveLength(2);
    expect(rows[0].address).toBe('Weg 1\nHinterhaus');
  });
});

describe('Freigabe-Hash', () => {
  const content = { workspaceId: 'ws_a', contactId: 'c1', channel: 'email', recipient: 'a@b.de', subject: 'Hallo', body: 'Text' };
  it('ändert sich bei jeder inhaltlichen Änderung', async () => {
    const h = await approvalHash(content);
    expect(await approvalHash({ ...content })).toBe(h);
    expect(await approvalHash({ ...content, body: 'Text!' })).not.toBe(h);
    expect(await approvalHash({ ...content, recipient: 'x@b.de' })).not.toBe(h);
    expect(await approvalHash({ ...content, workspaceId: 'ws_b' })).not.toBe(h);
  });
});
