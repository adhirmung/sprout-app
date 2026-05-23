import type { ProcessData } from '../lib/gemini';

const COLORS = ['#aa3bff', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export function VisualProcess({ data }: { data: ProcessData }) {
  return (
    <div style={{
      display:       'flex',
      flexDirection: 'column',
      alignItems:    'center',
      padding:       '16px',
      height:        '100%',
      boxSizing:     'border-box',
      overflowY:     'auto',
      gap:           0,
    }}>
      {data.steps.map((step, i) => {
        const color = COLORS[i % COLORS.length];
        return (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: 540 }}>
            {/* Step card */}
            <div
              style={{
                display:      'flex',
                gap:          14,
                alignItems:   'flex-start',
                background:   'var(--bg)',
                border:       '1.5px solid var(--border)',
                borderRadius: 12,
                padding:      '14px 16px',
                width:        '100%',
                boxSizing:    'border-box',
                boxShadow:    '0 1px 4px rgba(0,0,0,0.05)',
                animation:    'ps-pop 0.35s ease both',
                animationDelay: `${i * 0.08}s`,
              }}
            >
              {/* Step number circle */}
              <div style={{
                width:          36,
                height:         36,
                borderRadius:   '50%',
                background:     color,
                color:          '#fff',
                display:        'flex',
                alignItems:     'center',
                justifyContent: 'center',
                fontSize:       15,
                fontWeight:     800,
                flexShrink:     0,
              }}>
                {i + 1}
              </div>

              {/* Text */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-h)', marginBottom: 4, lineHeight: 1.3 }}>
                  {step.title}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>
                  {step.description}
                </div>
              </div>
            </div>

            {/* Connector arrow */}
            {i < data.steps.length - 1 && (
              <div style={{ fontSize: 18, color: 'var(--border)', padding: '4px 0', lineHeight: 1 }}>↓</div>
            )}
          </div>
        );
      })}

      <style>{`
        @keyframes ps-pop {
          from { opacity: 0; transform: scale(0.95) translateY(6px); }
          to   { opacity: 1; transform: scale(1)    translateY(0);   }
        }
      `}</style>
    </div>
  );
}
