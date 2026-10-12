import { motion } from 'motion/react';
import { KanbanSquare, Plus, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, ws } from '../api';
import { eur, STAGE_LABEL } from '../format';
import { Link } from '../router';
import { useApp } from '../state';
import { Badge, Button, Card, Empty, Field, Input, Modal, Select, Skeleton, useAction } from '../ui';

interface Opp {
  id: string;
  title: string;
  stage: string;
  contact_id: string;
  contact_name: string;
  contact_org: string | null;
  one_time_cents: number;
  recurring_cents_month: number;
  is_estimate: number;
}

const STAGES = ['new', 'qualified', 'meeting', 'proposal', 'won', 'lost'];

const euroToCents = (v: string) => Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100) || 0;

export default function Pipeline() {
  const app = useApp();
  const [opps, setOpps] = useState<Opp[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<Opp | null>(null);
  const { run } = useAction();

  const load = useCallback(async () => {
    const d = await api<{ opportunities: Opp[] }>(ws(app.workspaceId, '/opportunities'));
    setOpps(d.opportunities);
  }, [app.workspaceId]);

  useEffect(() => {
    load().catch(() => setOpps([]));
  }, [load]);

  const move = (o: Opp, stage: string) =>
    run('move', async () => {
      setOpps((prev) => prev?.map((x) => (x.id === o.id ? { ...x, stage } : x)) ?? null);
      await api(ws(app.workspaceId, `/opportunities/${o.id}`), { method: 'PATCH', body: { stage } });
      app.refresh();
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Pipeline</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Einmalpreise, laufende Gebühren und Schätzungen bleiben getrennt. „Gewonnen“ ist kein Zahlungseingang – Zahlungen erfasst du mit Datum und Beleg.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> Verkaufschance
        </Button>
      </div>

      {!opps ? (
        <Skeleton className="h-72" />
      ) : opps.length === 0 ? (
        <Card>
          <Empty icon={<KanbanSquare size={20} />} title="Noch keine Verkaufschancen" text="Lege eine Verkaufschance zu einem Kontakt an." action={<Button onClick={() => setCreating(true)}>Anlegen</Button>} />
        </Card>
      ) : (
        <div className="scrollbar-thin -mx-4 overflow-x-auto px-4 pb-2">
          <div className="grid min-w-[1100px] grid-cols-6 gap-3">
            {STAGES.map((s) => {
              const col = opps.filter((o) => o.stage === s);
              const oneTime = col.reduce((a, o) => a + o.one_time_cents, 0);
              const monthly = col.reduce((a, o) => a + o.recurring_cents_month, 0);
              return (
                <div key={s} className="glass rounded-2xl p-3">
                  <div className="mb-3 px-1">
                    <p className="flex items-center justify-between text-sm font-semibold">
                      {STAGE_LABEL[s]} <span className="text-xs font-normal text-muted">{col.length}</span>
                    </p>
                    <p className="text-xs text-muted">
                      {eur(oneTime)}
                      {monthly > 0 && ` + ${eur(monthly)}/Mon.`}
                    </p>
                  </div>
                  <div className="space-y-2">
                    {col.map((o) => (
                      <motion.div layout key={o.id} className="rounded-xl border border-line bg-black/25 p-3">
                        <Link to={`/kontakte/${o.contact_id}`} className="block truncate text-sm font-medium hover:text-accent">
                          {o.contact_org ?? o.contact_name}
                        </Link>
                        <p className="truncate text-xs text-muted">{o.title}</p>
                        <p className="mt-2 text-sm tabular-nums">
                          {eur(o.one_time_cents)}
                          {o.recurring_cents_month > 0 && <span className="text-muted"> + {eur(o.recurring_cents_month)}/Mon.</span>}
                        </p>
                        {o.is_estimate ? <Badge tone="warn" className="mt-1">Schätzung</Badge> : null}
                        <div className="mt-2 flex gap-1">
                          <Select value={o.stage} onChange={(e) => move(o, e.target.value)} className="!h-8 text-xs">
                            {STAGES.map((x) => (
                              <option key={x} value={x}>
                                {STAGE_LABEL[x]}
                              </option>
                            ))}
                          </Select>
                          {o.stage === 'won' && (
                            <Button size="sm" variant="ghost" aria-label="Zahlung erfassen" onClick={() => setPaying(o)}>
                              <Wallet size={14} />
                            </Button>
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <NewOppModal open={creating} onClose={() => setCreating(false)} onDone={load} />
      <PaymentModal opp={paying} onClose={() => setPaying(null)} />
    </div>
  );
}

function NewOppModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const app = useApp();
  const { busy, run } = useAction();
  const [contacts, setContacts] = useState<{ id: string; display_name: string; organization: string | null }[]>([]);
  const [f, setF] = useState({ contact_id: '', title: '', one_time: '', monthly: '', estimate: true });

  useEffect(() => {
    if (!open) return;
    api<{ contacts: { id: string; display_name: string; organization: string | null }[] }>(ws(app.workspaceId, '/contacts')).then((d) => setContacts(d.contacts));
  }, [open, app.workspaceId]);

  return (
    <Modal open={open} onClose={onClose} title="Verkaufschance anlegen">
      <div className="space-y-3">
        <Field label="Kontakt">
          <Select value={f.contact_id} onChange={(e) => setF({ ...f, contact_id: e.target.value })}>
            <option value="">Bitte wählen</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.organization ?? c.display_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Titel">
          <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Website-Relaunch" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Einmalig (€)">
            <Input inputMode="decimal" value={f.one_time} onChange={(e) => setF({ ...f, one_time: e.target.value })} />
          </Field>
          <Field label="Monatlich (€)">
            <Input inputMode="decimal" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.checked })} /> Betrag ist eine Schätzung
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            disabled={!f.contact_id}
            loading={busy === 'create'}
            onClick={() =>
              run('create', async () => {
                await api(ws(app.workspaceId, '/opportunities'), {
                  body: {
                    contact_id: f.contact_id,
                    offer_id: app.offerId || undefined,
                    title: f.title,
                    one_time_cents: euroToCents(f.one_time),
                    recurring_cents_month: euroToCents(f.monthly),
                    is_estimate: f.estimate,
                  },
                });
                onDone();
                app.refresh();
                onClose();
                setF({ contact_id: '', title: '', one_time: '', monthly: '', estimate: true });
              })
            }
          >
            Anlegen
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PaymentModal({ opp, onClose }: { opp: Opp | null; onClose: () => void }) {
  const app = useApp();
  const { busy, run } = useAction();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [ref, setRef] = useState('');
  return (
    <Modal open={!!opp} onClose={onClose} title="Zahlungseingang erfassen">
      <div className="space-y-3">
        <p className="text-sm text-muted">{opp?.contact_org ?? opp?.contact_name} · {opp?.title}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Betrag (€)">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Eingang am">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Belegreferenz" hint="z. B. Rechnungsnummer oder Kontoauszug">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            disabled={!euroToCents(amount) || !ref.trim()}
            loading={busy === 'pay'}
            onClick={() =>
              run(
                'pay',
                async () => {
                  await api(ws(app.workspaceId, '/payments'), { body: { opportunity_id: opp!.id, amount_cents: euroToCents(amount), received_on: date, reference: ref } });
                  app.refresh();
                  setAmount('');
                  setRef('');
                  onClose();
                },
                'Zahlung erfasst',
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
