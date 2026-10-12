import { motion } from 'motion/react';
import { Building2, ChevronRight, Cpu, Inbox, KanbanSquare, LayoutDashboard, Plug, Settings, Target, Users, Workflow } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useRouter } from '../router';
import { useApp } from '../state';
import { cx, StatusDot } from '../ui';

const NAV = [
  { to: '/', label: 'Heute', icon: LayoutDashboard },
  { to: '/workflows', label: 'Workflows', icon: Workflow },
  { to: '/kontakte', label: 'Kontakte', icon: Users },
  { to: '/freigaben', label: 'Freigaben', icon: Inbox, badge: 'approvals' as const },
  { to: '/pipeline', label: 'Pipeline', icon: KanbanSquare },
  { to: '/verbindungen', label: 'Verbindungen', icon: Plug },
  { to: '/einstellungen', label: 'Einstellungen', icon: Settings },
];

const MOBILE_NAV = ['/', '/workflows', '/kontakte', '/freigaben', '/verbindungen'];

function isActive(path: string, to: string) {
  return to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`);
}

function ChipSelect({ icon, value, onChange, options, label }: { icon: ReactNode; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label: string }) {
  return (
    <label className="group relative flex min-w-0 items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-2.5 py-1.5 transition hover:border-white/25 hover:bg-white/[0.06]">
      <span className="text-accent">{icon}</span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</span>
        <span className="truncate text-[13px] font-medium text-fg">{options.find((o) => o.value === value)?.label ?? '–'}</span>
      </span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ContextBar() {
  const app = useApp();
  const ov = app.overview;
  const offers = ov?.offers ?? [];
  const audiences = (ov?.audiences ?? []).filter((a) => a.offer_id === app.offerId);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ChipSelect icon={<Building2 size={15} />} label="Unternehmen" value={app.workspaceId} onChange={app.setWorkspaceId} options={app.workspaces.map((w) => ({ value: w.id, label: w.name }))} />
      <ChevronRight size={14} className="hidden text-muted sm:block" />
      <ChipSelect
        icon={<KanbanSquare size={15} />}
        label="Angebot"
        value={app.offerId}
        onChange={app.setOfferId}
        options={offers.map((o) => ({ value: o.id, label: o.is_active ? o.name : `${o.name} (inaktiv)` }))}
      />
      <ChevronRight size={14} className="hidden text-muted sm:block" />
      <ChipSelect
        icon={<Target size={15} />}
        label="Zielgruppe"
        value={app.audienceId}
        onChange={app.setAudienceId}
        options={[{ value: '', label: 'Alle Zielgruppen' }, ...audiences.map((a) => ({ value: a.id, label: a.name }))]}
      />
    </div>
  );
}

function EngineBadge() {
  const { overview } = useApp();
  const engine = overview?.engine;
  return (
    <Link
      to="/verbindungen"
      className={cx(
        'hidden items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-medium transition md:flex',
        engine ? 'border-ok/30 bg-ok/10 text-ok' : 'border-warn/30 bg-warn/10 text-warn',
      )}
    >
      <Cpu size={14} />
      {engine ? engine.label : 'Demo-Modus · keine KI verbunden'}
    </Link>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { path } = useRouter();
  const app = useApp();
  const approvals = app.overview?.metrics.approvalsPending ?? 0;
  const running = Object.values(app.agents).some((d) => d === 'running');

  return (
    <div className="relative z-10 min-h-dvh lg:pl-[232px]">
      {/* Seitenleiste */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r border-line bg-ink/40 px-3 py-5 backdrop-blur-xl lg:flex">
        <Link to="/" className="mb-8 flex items-center gap-2.5 px-2">
          <span className="relative grid h-9 w-9 place-items-center rounded-xl bg-accent-grad shadow-[0_0_30px_-6px_var(--accent)]">
            <span className="h-3 w-3 rounded-full bg-ink" />
          </span>
          <span className="font-display text-[17px] font-semibold tracking-tight">
            UPGRAI <span className="text-muted">Sales</span>
          </span>
        </Link>
        <nav className="flex flex-col gap-1">
          {NAV.map((n) => {
            const active = isActive(path, n.to);
            return (
              <Link
                key={n.to}
                to={n.to}
                className={cx(
                  'relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                  active ? 'text-fg' : 'text-muted hover:bg-white/[0.04] hover:text-fg',
                )}
              >
                {active && (
                  <motion.span layoutId="nav-active" className="absolute inset-0 rounded-xl border border-line bg-white/[0.07]" transition={{ type: 'spring', damping: 30, stiffness: 400 }} />
                )}
                <n.icon size={18} className={cx('relative', active && 'text-accent')} />
                <span className="relative">{n.label}</span>
                {n.badge === 'approvals' && approvals > 0 && (
                  <span className="relative ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-warn px-1.5 text-[11px] font-bold text-ink">{approvals}</span>
                )}
                {n.to === '/workflows' && running && <span className="relative ml-auto"><StatusDot state="running" size={7} /></span>}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto rounded-2xl border border-line bg-white/[0.03] p-3">
          <p className="text-[11px] uppercase tracking-wider text-muted">Angemeldet</p>
          <p className="mt-0.5 truncate text-sm">{app.email}</p>
          {app.environment === 'development' && <p className="mt-2 text-[11px] text-warn">Lokale Entwicklung</p>}
        </div>
      </aside>

      {/* Kopfzeile */}
      <header className="sticky top-0 z-20 border-b border-line bg-ink/55 backdrop-blur-xl">
        <div className="flex items-center gap-3 px-4 py-2.5 sm:px-6">
          <Link to="/" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-grad lg:hidden">
            <span className="h-2.5 w-2.5 rounded-full bg-ink" />
          </Link>
          <div className="min-w-0 flex-1 overflow-x-auto scrollbar-thin">
            <ContextBar />
          </div>
          <EngineBadge />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 pb-28 pt-6 sm:px-6 lg:pb-12">{children}</main>

      {/* Mobile Navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-ink/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
        <div className="grid grid-cols-5">
          {NAV.filter((n) => MOBILE_NAV.includes(n.to)).map((n) => {
            const active = isActive(path, n.to);
            return (
              <Link key={n.to} to={n.to} className={cx('relative flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium', active ? 'text-accent' : 'text-muted')}>
                <n.icon size={20} />
                {n.label}
                {n.badge === 'approvals' && approvals > 0 && (
                  <span className="absolute right-[22%] top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-warn px-1 text-[9px] font-bold text-ink">{approvals}</span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
