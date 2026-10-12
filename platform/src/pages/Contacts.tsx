import { motion } from 'motion/react';
import { Ban, CheckCircle2, ExternalLink, FileUp, Globe, MapPin, Play, Plus, Search, ShieldOff, Upload, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { BASIS_LABEL, CHANNEL_LABEL, CHANNELS, CONSENT_BASES, type Channel, type ChannelDecision } from '../../shared/policy';
import { api, ApiError, ws } from '../api';
import { dateTime, eur, PARTY_LABEL, relTime, STAGE_LABEL, STATUS_LABEL, TASK_KIND_LABEL } from '../format';
import { match, useRouter } from '../router';
import { useApp } from '../state';
import { Badge, Button, Card, cx, Drawer, Empty, Field, Input, Modal, SectionTitle, Select, Skeleton, Textarea, useAction } from '../ui';
import { StartRunModal } from './Workflows';

interface Contact {
  id: string;
  display_name: string;
  organization: string | null;
  party_type: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  language: string;
  source_url: string | null;
  verified_at: string | null;
  research: string;
  score: number | null;
  score_reason: string | null;
  status: string;
  audience_id: string | null;
  is_demo: number;
  updated_at: string;
}

function ScoreBar({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs text-muted">nicht bewertet</span>;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
        <motion.div initial={{ width: 0 }} animate={{ width: `${score}%` }} className="h-full rounded-full bg-accent-grad" />
      </div>
      <span className="text-xs tabular-nums text-muted">{score}</span>
    </div>
  );
}

export default function Contacts() {
  const app = useApp();
  const { path, navigate } = useRouter();
  const openId = match('/kontakte/:id', path)?.id;
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (app.audienceId) params.set('audience', app.audienceId);
    const d = await api<{ contacts: Contact[] }>(ws(app.workspaceId, `/contacts?${params}`));
    setContacts(d.contacts);
  }, [app.workspaceId, app.audienceId, q, status]);

  useEffect(() => {
    const t = setTimeout(() => load().catch(() => setContacts([])), 180);
    return () => clearTimeout(t);
  }, [load, app.pulse]);

  const audienceName = (id: string | null) => app.overview?.audiences.find((a) => a.id === id)?.name;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Kontakte</h1>
          <p className="mt-1 text-sm text-muted">
            {app.audienceId ? `Zielgruppe: ${audienceName(app.audienceId)}` : 'Alle Zielgruppen'} · sortiert nach Passung
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> Kontakt
          </Button>
          <Button variant="primary" onClick={() => setImporting(true)}>
            <Upload size={16} /> Importieren
          </Button>
        </div>
      </div>

      <Card className="p-3 sm:p-4">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input className="pl-9" placeholder="Suchen nach Name, Firma, Stadt, E-Mail…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-48">
            <option value="">Alle Status</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>

        {!contacts ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : contacts.length === 0 ? (
          <Empty icon={<Users size={20} />} title="Keine Kontakte" text="Importiere Recherche-Ergebnisse (CSV oder lead-research/1.0) oder lege einen Kontakt an." action={<Button onClick={() => setImporting(true)}>Importieren</Button>} />
        ) : (
          <ul className="divide-y divide-line">
            {contacts.map((c, i) => (
              <motion.li key={c.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.015, 0.3) }}>
                <button onClick={() => navigate(`/kontakte/${c.id}`)} className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition hover:bg-white/[0.03]">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.04] font-display text-sm font-semibold text-accent">
                    {(c.organization ?? c.display_name).slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-sm font-medium">
                      {c.organization ?? c.display_name}
                      {c.is_demo ? <Badge tone="warn">Demo</Badge> : null}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {[c.organization ? c.display_name : null, c.city, audienceName(c.audience_id)].filter(Boolean).join(' · ') || '–'}
                    </p>
                  </div>
                  <div className="hidden sm:block">
                    <ScoreBar score={c.score} />
                  </div>
                  <Badge className="hidden md:inline-flex">{PARTY_LABEL[c.party_type]}</Badge>
                  <Badge tone={c.status === 'paused' ? 'bad' : c.status === 'customer' ? 'ok' : c.status === 'qualified' ? 'accent' : 'neutral'}>{STATUS_LABEL[c.status]}</Badge>
                </button>
              </motion.li>
            ))}
          </ul>
        )}
      </Card>

      <ContactDrawer id={openId} onClose={() => navigate('/kontakte')} onChanged={load} />
      <ImportModal open={importing} onClose={() => setImporting(false)} onDone={load} />
      <NewContactModal open={creating} onClose={() => setCreating(false)} onDone={(id) => { load(); navigate(`/kontakte/${id}`); }} />
    </div>
  );
}

// ---------- Kontaktansicht ----------

interface ContactDetail {
  contact: Contact;
  channels: Record<Channel, ChannelDecision>;
  consents: { id: string; channel: Channel; basis: keyof typeof BASIS_LABEL; evidence: string; granted_at: string; revokedAt: string | null }[];
  activities: { id: string; kind: string; direction: string; summary: string; occurred_at: string; created_by: string }[];
  tasks: { id: string; kind: string; title: string; due_at: string; reason: string }[];
  opportunities: { id: string; title: string; stage: string; one_time_cents: number; recurring_cents_month: number; is_estimate: number }[];
  runs: { id: string; status: string; channel: string; current_step: string; created_at: string }[];
}

function ContactDrawer({ id, onClose, onChanged }: { id?: string; onClose: () => void; onChanged: () => void }) {
  const app = useApp();
  const [d, setD] = useState<ContactDetail | null>(null);
  const [startRun, setStartRun] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [note, setNote] = useState('');
  const [noteKind, setNoteKind] = useState('note:internal');
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setD(await api<ContactDetail>(ws(app.workspaceId, `/contacts/${id}`)));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) onClose();
    }
  }, [id, app.workspaceId, onClose]);

  useEffect(() => {
    setD(null);
    load();
  }, [load]);
  useEffect(() => {
    if (id && app.pulse) load();
  }, [app.pulse]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (body: Record<string, unknown>) =>
    run('patch', async () => {
      await api(ws(app.workspaceId, `/contacts/${id}`), { method: 'PATCH', body });
      await load();
      onChanged();
    });

  const c = d?.contact;
  const research = c ? (JSON.parse(c.research || '{}') as Record<string, unknown>) : {};

  return (
    <Drawer open={!!id} onClose={onClose} title="Kontakt">
      {!d || !c ? (
        <div className="space-y-3 p-6">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <div className="space-y-6 p-6">
          <div>
            <div className="flex flex-wrap items-center gap-2 pr-8">
              <Badge>{PARTY_LABEL[c.party_type]}</Badge>
              <Badge tone={c.status === 'paused' ? 'bad' : 'accent'}>{STATUS_LABEL[c.status]}</Badge>
              {c.is_demo ? <Badge tone="warn">Demo – nicht kontaktieren</Badge> : null}
            </div>
            <h2 className="mt-3 font-display text-2xl font-semibold">{c.organization ?? c.display_name}</h2>
            {c.organization && <p className="text-sm text-muted">{c.display_name}</p>}
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              {c.city && (
                <span className="flex items-center gap-1">
                  <MapPin size={14} /> {[c.address, c.city, c.country].filter(Boolean).join(', ')}
                </span>
              )}
              {c.website && (
                <a href={c.website.startsWith('http') ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-accent hover:underline">
                  <Globe size={14} /> Website
                </a>
              )}
              {c.source_url && (
                <a href={c.source_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-fg">
                  <ExternalLink size={14} /> Quelle {c.verified_at && `(geprüft ${dateTime(c.verified_at)})`}
                </a>
              )}
            </div>
            {c.score !== null && (
              <div className="mt-4 rounded-xl border border-line bg-white/[0.03] p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wider text-muted">Passung</span>
                  <ScoreBar score={c.score} />
                </div>
                <p className="mt-1 text-sm">{c.score_reason}</p>
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" disabled={c.status === 'paused'} onClick={() => setStartRun(true)}>
                <Play size={14} /> Agentenlauf
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={c.status === 'paused'}
                loading={busy === 'suppress'}
                onClick={() => {
                  const reason = window.prompt('Widerspruch erfassen – Grund (wird plattformweit gesperrt):', 'Widerspruch per Telefon');
                  if (!reason) return;
                  run('suppress', async () => {
                    await api(ws(app.workspaceId, `/contacts/${c.id}/suppress`), { body: { reason } });
                    await load();
                    onChanged();
                  }, 'Kontakt gesperrt und pausiert');
                }}
              >
                <ShieldOff size={14} /> Widerspruch
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Einordnung">
              <Select value={c.party_type} onChange={(e) => patch({ party_type: e.target.value })}>
                {Object.entries(PARTY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Zielgruppe">
              <Select value={c.audience_id ?? ''} onChange={(e) => patch({ audience_id: e.target.value || null })}>
                <option value="">–</option>
                {app.overview?.audiences.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <section>
            <SectionTitle title="Kanäle" subtitle="Berechtigung je Kanal, mit Grund" action={<Button size="sm" onClick={() => setConsentOpen(true)}><Plus size={14} /> Berechtigung</Button>} />
            <div className="grid gap-2 sm:grid-cols-2">
              {CHANNELS.map((ch) => {
                const dec = d.channels[ch];
                return (
                  <div key={ch} className={cx('rounded-xl border p-3', dec.allowed ? 'border-ok/25 bg-ok/[0.05]' : 'border-line bg-white/[0.02]')}>
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {dec.allowed ? <CheckCircle2 size={15} className="text-ok" /> : <Ban size={15} className="text-muted" />}
                      {CHANNEL_LABEL[ch]}
                    </p>
                    <p className="mt-1 text-xs text-muted">{dec.reason}</p>
                  </div>
                );
              })}
            </div>
            {d.consents.length > 0 && (
              <ul className="mt-3 space-y-2">
                {d.consents.map((cn) => (
                  <li key={cn.id} className={cx('rounded-xl border border-line p-3 text-sm', cn.revokedAt && 'opacity-50')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {CHANNEL_LABEL[cn.channel]} · {BASIS_LABEL[cn.basis]}
                      </span>
                      {cn.revokedAt ? (
                        <Badge tone="bad">widerrufen</Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            run('revoke', async () => {
                              await api(ws(app.workspaceId, `/consents/${cn.id}/revoke`), { body: {} });
                              await load();
                            })
                          }
                        >
                          Widerrufen
                        </Button>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {cn.evidence} · {dateTime(cn.granted_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionTitle title="Kontaktdaten & Recherche" />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted">E-Mail</dt>
              <dd className="truncate">{c.email ?? '–'}</dd>
              <dt className="text-muted">Telefon</dt>
              <dd>{c.phone ?? '–'}</dd>
              <dt className="text-muted">Sprache</dt>
              <dd>{c.language}</dd>
              {Object.entries(research).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="break-words">{typeof v === 'object' ? formatResearch(k, v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          </section>

          {(d.tasks.length > 0 || d.opportunities.length > 0) && (
            <section className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-xs uppercase tracking-wider text-muted">Offene Aufgaben</p>
                {d.tasks.map((t) => (
                  <p key={t.id} className="text-sm">
                    <Badge>{TASK_KIND_LABEL[t.kind]}</Badge> {t.title} <span className="text-xs text-muted">{relTime(t.due_at)}</span>
                  </p>
                ))}
                {d.tasks.length === 0 && <p className="text-sm text-muted">–</p>}
              </div>
              <div>
                <p className="mb-2 text-xs uppercase tracking-wider text-muted">Verkaufschancen</p>
                {d.opportunities.map((o) => (
                  <p key={o.id} className="text-sm">
                    <Badge tone="accent">{STAGE_LABEL[o.stage]}</Badge> {o.title} · {eur(o.one_time_cents)}
                    {o.recurring_cents_month > 0 && ` + ${eur(o.recurring_cents_month)}/Monat`}
                  </p>
                ))}
                {d.opportunities.length === 0 && <p className="text-sm text-muted">–</p>}
              </div>
            </section>
          )}

          <section>
            <SectionTitle title="Verlauf" />
            <div className="mb-4 space-y-2">
              <Textarea rows={2} placeholder="Gesprächsnotiz, Antwort des Kontakts …" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="flex gap-2">
                <Select value={noteKind} onChange={(e) => setNoteKind(e.target.value)} className="flex-1">
                  <option value="note:internal">Notiz</option>
                  <option value="call:outbound">Anruf geführt</option>
                  <option value="call:inbound">Anruf erhalten</option>
                  <option value="email:inbound">Antwort per E-Mail (stoppt Nachfassen)</option>
                  <option value="whatsapp:inbound">Antwort per WhatsApp (stoppt Nachfassen)</option>
                </Select>
                <Button
                  disabled={!note.trim()}
                  loading={busy === 'note'}
                  onClick={() =>
                    run('note', async () => {
                      const [kind, direction] = noteKind.split(':');
                      await api(ws(app.workspaceId, `/contacts/${c.id}/notes`), { body: { text: note, kind, direction } });
                      setNote('');
                      await load();
                    })
                  }
                >
                  Speichern
                </Button>
              </div>
            </div>
            <ol className="relative space-y-3 border-l border-line pl-4">
              {d.activities.map((a) => (
                <li key={a.id} className="relative">
                  <span className={cx('absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full', a.direction === 'inbound' ? 'bg-ok' : a.direction === 'outbound' ? 'bg-[var(--accent)]' : 'bg-white/30')} />
                  <p className="whitespace-pre-line text-sm">{a.summary}</p>
                  <p className="text-[11px] text-muted">
                    {a.kind} · {a.direction} · {a.created_by} · {dateTime(a.occurred_at)}
                  </p>
                </li>
              ))}
              {d.activities.length === 0 && <p className="text-sm text-muted">Noch kein Verlauf.</p>}
            </ol>
          </section>

          <StartRunModal open={startRun} onClose={() => setStartRun(false)} contactId={c.id} onStarted={load} />
          <ConsentModal open={consentOpen} onClose={() => setConsentOpen(false)} contactId={c.id} partyType={c.party_type} onDone={load} />
        </div>
      )}
    </Drawer>
  );
}

function formatResearch(key: string, v: unknown): string {
  const o = v as Record<string, unknown>;
  if (key === 'rating' && o && 'value' in o) return `${o.value} von ${o.scale} (${o.count} Bewertungen)`;
  if (key === 'availability' && o && 'from' in o) return `${o.from} bis ${o.to}${o.note ? ` – ${o.note}` : ''}`;
  return JSON.stringify(v);
}

function ConsentModal({ open, onClose, contactId, partyType, onDone }: { open: boolean; onClose: () => void; contactId: string; partyType: string; onDone: () => void }) {
  const app = useApp();
  const { busy, run } = useAction();
  const [channel, setChannel] = useState<Channel>('phone');
  const [basis, setBasis] = useState<string>(partyType === 'business' ? 'presumed_b2b' : 'express_consent');
  const [evidence, setEvidence] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  return (
    <Modal open={open} onClose={onClose} title="Kontaktberechtigung erfassen">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Nur mit Beleg: wann, wie und durch wen. KI-Assistenten und Agenten können keine Berechtigungen anlegen.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kanal">
            <Select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Datum">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Grundlage">
          <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
            {CONSENT_BASES.map((b) => (
              <option key={b} value={b} disabled={b === 'presumed_b2b' && (partyType !== 'business' || channel !== 'phone')}>
                {BASIS_LABEL[b]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Beleg" hint={basis === 'presumed_b2b' ? 'Konkreter Bedarfsbezug, z. B. „Website seit 2019 nicht erreichbar, Betrieb wirbt aktiv um Gäste“.' : 'z. B. „Einwilligung per Kontaktformular am 12.10., Double-Opt-in bestätigt“.'}>
          <Textarea rows={3} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            disabled={evidence.trim().length < 10}
            loading={busy === 'consent'}
            onClick={() =>
              run(
                'consent',
                async () => {
                  await api(ws(app.workspaceId, `/contacts/${contactId}/consents`), { body: { channel, basis, evidence, granted_at: new Date(date).toISOString() } });
                  setEvidence('');
                  onDone();
                  onClose();
                },
                'Berechtigung gespeichert',
              )
            }
          >
            Speichern
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- Neuer Kontakt ----------

function NewContactModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const app = useApp();
  const { busy, run } = useAction();
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Modal open={open} onClose={onClose} title="Kontakt anlegen">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input value={f.name ?? ''} onChange={set('name')} />
        </Field>
        <Field label="Organisation">
          <Input value={f.organization ?? ''} onChange={set('organization')} />
        </Field>
        <Field label="E-Mail">
          <Input type="email" value={f.email ?? ''} onChange={set('email')} />
        </Field>
        <Field label="Telefon">
          <Input value={f.phone ?? ''} onChange={set('phone')} />
        </Field>
        <Field label="Stadt">
          <Input value={f.city ?? ''} onChange={set('city')} />
        </Field>
        <Field label="Einordnung">
          <Select value={f.party_type ?? 'unknown'} onChange={set('party_type')}>
            {Object.entries(PARTY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Quelle (URL)">
          <Input value={f.source_url ?? ''} onChange={set('source_url')} />
        </Field>
        <Field label="Zielgruppe">
          <Select value={f.audience_id ?? app.audienceId} onChange={set('audience_id')}>
            <option value="">–</option>
            {app.overview?.audiences.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Abbrechen
        </Button>
        <Button
          variant="primary"
          loading={busy === 'create'}
          onClick={() =>
            run('create', async () => {
              const body = { ...f, audience_id: f.audience_id ?? (app.audienceId || undefined) };
              const r = await api<{ id: string }>(ws(app.workspaceId, '/contacts'), { body });
              setF({});
              onClose();
              onDone(r.id);
            })
          }
        >
          Anlegen
        </Button>
      </div>
    </Modal>
  );
}

// ---------- Import ----------

interface Preview {
  rows: { index: number; name: string; kind: string; reason: string }[];
  summary: { new: number; update: number; conflict: number; invalid: number };
}

const SAMPLE_CSV = `name;organization;party_type;phone;email;city;source_url;verified_at;rating_value;rating_scale;rating_count;website_status
Maria Beispiel;Trattoria Beispiel;business;040 1234567;;Hamburg;https://maps.example/trattoria;2026-10-12;4,5;5;87;veraltet`;

function ImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const app = useApp();
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const [audience, setAudience] = useState(app.audienceId);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    if (open) {
      setAudience(app.audienceId);
      setPreview(null);
    }
  }, [open, app.audienceId]);

  const payload = () => {
    const t = text.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? { format: 'lead-research/1.0', leads: parsed } : parsed;
    }
    return { csv: t };
  };

  return (
    <Modal open={open} onClose={onClose} title="Recherche importieren" wide>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          CSV (Komma oder Semikolon) oder JSON im Format <code className="text-accent">lead-research/1.0</code>. Sichere Treffer ergänzen vorhandene Kontakte, widersprüchliche Treffer werden nicht übernommen.
        </p>
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm hover:bg-white/5">
            <FileUp size={15} /> Datei wählen
            <input
              type="file"
              accept=".csv,.json,text/csv,application/json"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setText(await file.text());
                setPreview(null);
              }}
            />
          </label>
          <Button size="sm" variant="ghost" onClick={() => { setText(SAMPLE_CSV); setPreview(null); }}>
            Beispiel einfügen
          </Button>
        </div>
        <Textarea rows={7} className="font-mono text-xs" placeholder="CSV oder JSON hier einfügen …" value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} />
        <Field label="Zielgruppe für neue Kontakte">
          <Select value={audience} onChange={(e) => setAudience(e.target.value)}>
            <option value="">–</option>
            {app.overview?.audiences.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>

        {preview && (
          <div className="rounded-2xl border border-line bg-white/[0.02] p-4">
            <div className="mb-3 flex flex-wrap gap-2">
              <Badge tone="ok">{preview.summary.new} neu</Badge>
              <Badge tone="accent">{preview.summary.update} ergänzen</Badge>
              <Badge tone="warn">{preview.summary.conflict} Konflikte</Badge>
              <Badge tone="bad">{preview.summary.invalid} ungültig</Badge>
            </div>
            <ul className="max-h-48 space-y-1 overflow-y-auto text-sm scrollbar-thin">
              {preview.rows.map((r) => (
                <li key={r.index} className="flex justify-between gap-3">
                  <span className="truncate">{r.name}</span>
                  <span className={cx('shrink-0 text-xs', r.kind === 'invalid' || r.kind === 'conflict' ? 'text-warn' : 'text-muted')}>{r.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button
            disabled={!text.trim()}
            loading={busy === 'preview'}
            onClick={() =>
              run('preview', async () => {
                setPreview(await api<Preview>(ws(app.workspaceId, '/imports/preview'), { body: payload() }));
              })
            }
          >
            Vorschau
          </Button>
          <Button
            variant="primary"
            disabled={!preview || preview.summary.new + preview.summary.update === 0}
            loading={busy === 'commit'}
            onClick={() =>
              run('commit', async () => {
                const r = await api<{ created: number; updated: number; skipped: unknown[] }>(ws(app.workspaceId, '/imports/commit'), {
                  body: { ...payload(), audience_id: audience || undefined },
                });
                onDone();
                onClose();
                setText('');
                return r;
              }, 'Import übernommen')
            }
          >
            Übernehmen
          </Button>
        </div>
      </div>
    </Modal>
  );
}
