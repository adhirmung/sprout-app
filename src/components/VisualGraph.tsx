import { useLayoutEffect, useRef, useState } from 'react';
import functionPlot from 'function-plot';

interface Props {
  equation: string;
  title?:   string;
}

export function VisualGraph({ equation, title }: Props) {
  const wrapRef  = useRef<HTMLDivElement>(null);
  const plotRef  = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);

  // We need the wrapper's actual pixel size before rendering the plot
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const plot = plotRef.current;
    if (!wrap || !plot) return;

    setErr(null);

    const render = () => {
      const w = wrap.offsetWidth  || 400;
      const h = wrap.offsetHeight || 300;
      // Clear old SVG so re-render is clean
      plot.innerHTML = '';
      try {
        functionPlot({
          target: plot,
          width:  w,
          height: h,
          grid:   true,
          data: [{
            fn:    equation,
            color: '#aa3bff',
          }],
          xAxis: { label: 'x' },
          yAxis: { label: 'y' },
          annotations: [],
        });
      } catch (e) {
        setErr(`Could not plot "${equation}": ${(e as Error).message}`);
      }
    };

    render();

    // Re-render on container resize
    const ro = new ResizeObserver(render);
    ro.observe(wrap);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equation]);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding:      '12px 20px 10px',
        borderBottom: '1px solid var(--line)',
        background:   'var(--bg)',
        flexShrink:   0,
        display:      'flex',
        alignItems:   'center',
        gap:          8,
      }}>
        <span style={{ fontSize: 18 }}>📈</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
          {title ?? 'Function Graph'}
        </span>
        <code style={{
          marginLeft:   'auto',
          fontSize:     12,
          color:        '#aa3bff',
          background:   '#F3E8FF',
          padding:      '2px 10px',
          borderRadius: 20,
          fontWeight:   700,
        }}>
          y = {equation}
        </code>
      </div>

      {/* Plot area */}
      <div ref={wrapRef} style={{ flex: 1, position: 'relative', background: 'var(--bg)' }}>
        {err ? (
          <div style={{
            position:    'absolute', inset: 0,
            display:     'flex', flexDirection: 'column',
            alignItems:  'center', justifyContent: 'center',
            gap:         12, padding: 24,
          }}>
            <span style={{ fontSize: 32 }}>⚠️</span>
            <p style={{ fontSize: 13, color: 'var(--ink-3)', textAlign: 'center', maxWidth: 300 }}>{err}</p>
          </div>
        ) : (
          <div
            ref={plotRef}
            style={{ width: '100%', height: '100%' }}
          />
        )}
      </div>

      <style>{`
        /* function-plot SVG responsive fix */
        .function-plot svg { display: block; }
      `}</style>
    </div>
  );
}
