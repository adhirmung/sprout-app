import { createContext, useCallback, useContext, useState } from 'react';
import { Icon } from './Icon';

type ToastKind = 'info' | 'success' | 'error';
type ToastFn = (msg: string, kind?: ToastKind) => void;

const ToastCtx = createContext<ToastFn>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

interface ToastItem {
  id: string;
  msg: string;
  kind: ToastKind;
}

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback<ToastFn>((msg, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setItems(s => [...s, { id, msg, kind }]);
    setTimeout(() => setItems(s => s.filter(t => t.id !== id)), 3200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'fixed', bottom: 24, left: 0, right: 0,
          display: 'grid', placeItems: 'center', zIndex: 'var(--z-toast)' as unknown as number, pointerEvents: 'none',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map(t => (
            <div key={t.id} className="card fade-up" style={{
              padding: '12px 18px', borderRadius: 999,
              background: t.kind === 'error' ? 'var(--error-soft)' : t.kind === 'success' ? 'var(--brand-soft)' : 'var(--card)',
              borderColor: t.kind === 'error' ? 'var(--error-line)' : t.kind === 'success' ? 'var(--success-line)' : 'var(--line)',
              fontWeight: 600, fontSize: 14, pointerEvents: 'auto',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icon name={t.kind === 'error' ? 'close' : t.kind === 'success' ? 'check' : 'sparkle'} size={16} />
              {t.msg}
            </div>
          ))}
        </div>
      </div>
    </ToastCtx.Provider>
  );
}
