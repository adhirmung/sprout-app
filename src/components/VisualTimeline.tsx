import type { TimelineData } from '../lib/gemini';

const COLORS = ['#aa3bff', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export function VisualTimeline({ data }: { data: TimelineData }) {
  return (
    <div style={{
      padding: '16px 20px',
      overflowY: 'auto',
      height: '100%',
      boxSizing: 'border-box',
    }}>
      <div style={{ position: 'relative', maxWidth: 580, margin: '0 auto' }}>

        {/* Centre line */}
        <div style={{
          position: 'absolute',
          left: '50%',
          top: 8,
          bottom: 8,
          width: 2,
          background: 'var(--border)',
          transform: 'translateX(-50%)',
        }} />

        {data.events.map((ev, i) => {
          const isLeft = i % 2 === 0;
          const color  = COLORS[i % COLORS.length];
          return (
            <div
              key={i}
              style={{
                display:      'flex',
                justifyContent: isLeft ? 'flex-end' : 'flex-start',
                paddingRight: isLeft ? 'calc(50% + 18px)' : 0,
                paddingLeft:  isLeft ? 0 : 'calc(50% + 18px)',
                marginBottom: 20,
                position:     'relative',
                animation:    `tl-fade 0.4s ease both`,
                animationDelay: `${i * 0.08}s`,
              }}
            >
              {/* Dot */}
              <div style={{
                position:    'absolute',
                left:        '50%',
                top:         14,
                width:       13,
                height:      13,
                borderRadius: '50%',
                background:  color,
                border:      '3px solid var(--bg)',
                transform:   'translateX(-50%)',
                zIndex:      1,
              }} />

              {/* Card */}
              <div style={{
                background:   'var(--bg)',
                border:       '1.5px solid var(--border)',
                borderRadius: 10,
                padding:      '10px 13px',
                maxWidth:     220,
                boxShadow:    '0 1px 4px rgba(0,0,0,0.06)',
              }}>
                <div style={{
                  fontSize: 10, fontWeight: 800, color,
                  textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 3,
                }}>
                  {ev.year}
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-h)', marginBottom: 3, lineHeight: 1.3 }}>
                  {ev.title}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.45 }}>
                  {ev.description}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <style>{`
        @keyframes tl-fade {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0);   }
        }
      `}</style>
    </div>
  );
}
