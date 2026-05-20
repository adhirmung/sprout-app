import { useEffect, useRef } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

interface Props {
  formulas: string[];
  title?:   string;
}

export function VisualMath({ formulas, title }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '';

    if (!formulas.length) {
      el.innerHTML = '<p style="color:#6B7280;text-align:center;padding:32px;font-size:14px">No formulas available.</p>';
      return;
    }

    formulas.forEach((raw, i) => {
      const card = document.createElement('div');
      card.style.cssText = [
        'background:var(--card,#fff)',
        'border:1.5px solid var(--line,#e5e7eb)',
        'border-radius:14px',
        'padding:20px 24px',
        'margin-bottom:14px',
        'box-shadow:0 2px 8px rgba(0,0,0,0.05)',
        'overflow-x:auto',
        'color:#111827',           // explicit dark colour — never invisible
        `animation:mth-pop 0.3s ease both`,
        `animation-delay:${i * 70}ms`,
      ].join(';');

      try {
        katex.render(raw, card, {
          displayMode:  true,
          throwOnError: false,
          output:       'html',
          trust:        false,
          strict:       'warn',
        });
      } catch {
        const pre = document.createElement('pre');
        pre.style.cssText = 'font-family:monospace;font-size:14px;color:#374151;white-space:pre-wrap;margin:0';
        pre.textContent = raw;
        card.appendChild(pre);
      }

      el.appendChild(card);
    });
  }, [formulas]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '12px 20px 10px', borderBottom: '1px solid var(--line)',
        background: 'var(--bg)', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 18 }}>∑</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
          {title ?? 'Key Equations'}
        </span>
        <span style={{
          marginLeft: 'auto', fontSize: 11, color: '#7C3AED',
          background: '#F3E8FF', padding: '2px 8px', borderRadius: 20, fontWeight: 600,
        }}>
          {formulas.length} {formulas.length === 1 ? 'formula' : 'formulas'}
        </span>
      </div>

      {/* Formula cards */}
      <div
        ref={ref}
        style={{
          flex: 1, overflowY: 'auto',
          padding: '16px 20px',
          background: 'var(--bg)',
        }}
      />

      <style>{`
        @keyframes mth-pop {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .katex-display { text-align: center !important; margin: 0 !important; }
        .katex { color: #111827 !important; }
      `}</style>
    </div>
  );
}
