import { AnimatePresence, motion } from 'motion/react';
import { Check, Inbox, Pencil, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CHANNEL_LABEL, type Channel } from '../../shared/policy';
import { api, ws } from '../api';
import { relTime } from '../format';
import { Link } from '../router';
import { useApp } from '../state';
import { Badge, Button, Card, Empty, Field, Input, Skeleton, Textarea, useAction } from '../ui';

interface Approval {
  id: string;
  contact_id: string;
  contact_name: string;
  contact_org: string | null;
  channel: Channel;
  recipient: string;
  subject: string;
  body: string;
  created_by: string;
  created_at: string;
}

export default function Approvals() {
  const app = useApp();
  const [items, setItems] = useState<Approval[] | null>(null);

  const load = useCallback(async () => {
    const d = await api<{ approvals: Approval[] }>(ws(app.workspaceId, '/approvals'));
    setItems(d.approvals);
  }, [app.workspaceId]);

  useEffect(() => {
    load().catch(() => setItems([]));
  }, [load, app.pulse]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold">Freigaben</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Deine Freigabe gilt für genau diese Aktion: Firma, Empfänger, Kanal und Text. Jede Änderung erzeugt eine neue Freigabe; Agenten können sich nie selbst freigeben.
        </p>
      </div>
      {!items ? (
        <Skeleton className="h-64" />
      ) : items.length === 0 ? (
        <Card>
          <Empty icon={<Inbox size={20} />} title="Keine offenen Freigaben" text="Wenn ein Agent einen Entwurf fertig hat, erscheint er hier." />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <AnimatePresence>
            {items.map((a) => (
              <ApprovalCard key={a.id} a={a} onDone={() => setItems((p) => p?.filter((x) => x.id !== a.id) ?? null)} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ a, onDone }: { a: Approval; onDone: () => void }) {
  const app = useApp();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(a.subject);
  const [body, setBody] = useState(a.body);
  const changed = subject !== a.subject || body !== a.body;

  const decide = (decision: 'approve' | 'reject') =>
    run(
      decision,
      async () => {
        await api(ws(app.workspaceId, `/approvals/${a.id}`), { body: { decision, ...(changed ? { subject, body } : {}) } });
        onDone();
        app.refresh();
      },
      decision === 'approve' ? 'Freigegeben – der Agent führt jetzt aus' : 'Abgelehnt',
    );

  return (
    <motion.div layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}>
      <Card className="flex h-full flex-col p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warn">Freigabe nötig</Badge>
          <Badge tone="accent">{CHANNEL_LABEL[a.channel]}</Badge>
          <span className="ml-auto text-xs text-muted">{relTime(a.created_at)}</span>
        </div>
        <Link to={`/kontakte/${a.contact_id}`} className="mt-3 font-display text-lg font-semibold hover:text-accent">
          {a.contact_org ?? a.contact_name}
        </Link>
        <p className="text-xs text-muted">
          an {a.recipient} · Entwurf: {a.created_by}
        </p>
        {editing ? (
          <div className="mt-4 space-y-3">
            <Field label="Betreff">
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            <Field label="Text">
              <Textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
            </Field>
          </div>
        ) : (
          <div className="mt-4 flex-1 rounded-xl border border-line bg-black/25 p-4">
            {subject && <p className="mb-2 text-sm font-semibold">{subject}</p>}
            <p className="whitespace-pre-line text-sm leading-relaxed text-fg/90">{body}</p>
          </div>
        )}
        {changed && <p className="mt-2 text-xs text-warn">Geändert – beim Freigeben entsteht eine neue Freigabe mit neuem Prüfwert.</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" loading={busy === 'approve'} onClick={() => decide('approve')}>
            <Check size={16} /> Freigeben
          </Button>
          <Button variant="ghost" onClick={() => setEditing((e) => !e)}>
            <Pencil size={15} /> {editing ? 'Vorschau' : 'Bearbeiten'}
          </Button>
          <Button variant="danger" className="ml-auto" loading={busy === 'reject'} onClick={() => decide('reject')}>
            <X size={15} /> Ablehnen
          </Button>
        </div>
      </Card>
    </motion.div>
  );
}
