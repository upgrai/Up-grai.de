import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

const RouterCtx = createContext<{ path: string; navigate: (to: string) => void }>({ path: '/', navigate: () => {} });

export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState(null, '', to);
    setPath(to);
    window.scrollTo({ top: 0 });
  }, []);
  return <RouterCtx.Provider value={{ path, navigate }}>{children}</RouterCtx.Provider>;
}

export const useRouter = () => useContext(RouterCtx);

/** Sehr kleiner Pfadabgleich: "/kontakte/:id" */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function Link({ to, className, children, onClick }: { to: string; className?: string; children: ReactNode; onClick?: () => void }) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onClick?.();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
