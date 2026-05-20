/**
 * VisualBiology — p5.js biology simulations.
 * Each sketch is a factory (w, h) → (p: p5) => void so the canvas
 * is always sized to the actual container, not p5's 100×100 default.
 */
import { useEffect, useRef } from 'react';
import p5 from 'p5';
import type { SimulationPayload } from '../lib/claude';

interface Props { payload: SimulationPayload }

// ── Sketch factories (close over w, h) ───────────────────────────────────────

function makeCirculatorySketch(W: number, H: number) {
  return (p: p5) => {
    type Cell = { t: number; speed: number; oxy: boolean };
    const cells: Cell[] = [];
    const N = 22;
    const cx = W / 2, cy = H / 2;

    p.setup = () => {
      p.createCanvas(W, H);
      p.frameRate(60);
      p.textAlign(p.CENTER, p.CENTER);
      for (let i = 0; i < N; i++)
        cells.push({ t: (i / N) * p.TWO_PI * 2, speed: p.random(0.012, 0.018), oxy: i < N / 2 });
    };

    function cellPos(t: number, loop: 'left' | 'right'): [number, number] {
      const rx = W * 0.28, ry = H * 0.22;
      const ox = loop === 'left' ? -rx * 0.55 : rx * 0.55;
      return [cx + ox + Math.cos(t) * rx * 0.55, cy + Math.sin(t) * ry];
    }

    p.draw = () => {
      p.background(248, 248, 252);
      const rx = W * 0.28, ry = H * 0.22;

      // Vessels
      p.noFill(); p.strokeWeight(18); p.stroke(220, 40, 60, 60);
      p.ellipse(cx - rx * 0.55, cy, rx * 1.1, ry * 2);
      p.stroke(120, 80, 180, 50); p.strokeWeight(20);
      p.ellipse(cx + rx * 0.55, cy, rx * 1.1, ry * 2);

      // Heart
      const hs = Math.max(28, W * 0.065);
      p.noStroke(); p.fill(220, 40, 60);
      p.ellipse(cx - hs * 0.45, cy - hs * 0.15, hs * 0.9, hs * 0.9);
      p.ellipse(cx + hs * 0.45, cy - hs * 0.15, hs * 0.9, hs * 0.9);
      p.triangle(cx - hs * 0.88, cy + hs * 0.05, cx + hs * 0.88, cy + hs * 0.05, cx, cy + hs * 0.9);

      // Blood cells
      cells.forEach((c, i) => {
        c.t += c.speed;
        const loop: 'left' | 'right' = i < N / 2 ? 'left' : 'right';
        const [x, y] = cellPos(c.t, loop);
        const col = c.oxy ? p.color(230, 50, 60) : p.color(110, 40, 80);
        p.fill(col); p.noStroke(); p.ellipse(x, y, 14, 10);
        p.fill(p.red(col) * 0.82, p.green(col) * 0.82, p.blue(col) * 0.82, 180);
        p.ellipse(x, y, 6, 4);
      });

      // Labels
      p.fill(80); p.noStroke(); p.textSize(Math.max(10, W * 0.026));
      p.text('Oxygenated', cx - rx * 0.55, cy + ry + 18);
      p.text('Deoxygenated', cx + rx * 0.55, cy + ry + 18);
      p.fill(255); p.textSize(Math.max(9, W * 0.024));
      p.text('♥', cx, cy - 2);
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function makeMitosisSketch(W: number, H: number) {
  return (p: p5) => {
    const STAGES = ['Interphase', 'Prophase', 'Metaphase', 'Anaphase', 'Telophase', 'Cytokinesis'];
    const DESC = [
      'DNA replicates; cell prepares to divide',
      'Chromatin condenses into chromosomes',
      'Chromosomes align at the cell equator',
      'Sister chromatids are pulled to opposite poles',
      'Two nuclear envelopes re-form',
      'Cytoplasm divides → 2 daughter cells',
    ];
    let stage = 0, timer = 0;
    const DURATION = 150;
    const cx = W / 2, cy = H / 2 - 20;
    const r = Math.min(W, H) * 0.22;

    p.setup = () => { p.createCanvas(W, H); p.noStroke(); p.textAlign(p.CENTER, p.CENTER); };

    p.draw = () => {
      p.background(248, 248, 252);
      if (++timer > DURATION) { timer = 0; stage = (stage + 1) % STAGES.length; }
      const prog = timer / DURATION;

      if (stage === 0) {
        p.fill(200, 230, 200, 180); p.ellipse(cx, cy, r * 2, r * 2);
        p.fill(120, 180, 255, 200); p.ellipse(cx, cy, r * 0.9, r * 0.9);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * p.TWO_PI;
          p.fill(60, 80, 200, 160);
          p.ellipse(cx + Math.cos(a) * r * 0.25, cy + Math.sin(a) * r * 0.25, 8, 5);
        }
      } else if (stage === 1) {
        p.fill(200, 230, 200, 180); p.ellipse(cx, cy, r * 2, r * 2);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * p.TWO_PI + prog;
          p.fill(60, 80, 200);
          p.push(); p.translate(cx + Math.cos(a) * r * 0.3, cy + Math.sin(a) * r * 0.3);
          p.rotate(a); p.rect(-5, -12, 10, 24, 5); p.pop();
        }
      } else if (stage === 2) {
        p.fill(200, 230, 200, 180); p.ellipse(cx, cy, r * 2, r * 2);
        p.stroke(180, 220, 255, 120); p.strokeWeight(1.5);
        for (let i = 0; i < 4; i++) {
          const yy = cy + (i - 1.5) * r * 0.35;
          p.line(cx - r * 0.9, cy - r * 0.7, cx, yy);
          p.line(cx + r * 0.9, cy - r * 0.7, cx, yy);
        }
        p.noStroke();
        for (let i = 0; i < 4; i++) {
          p.fill(60, 80, 200);
          p.rect(cx - 14, cy + (i - 1.5) * r * 0.35 - 12, 28, 24, 5);
        }
      } else if (stage === 3) {
        const sep = prog * r * 0.7;
        p.fill(200, 230, 200, 180); p.ellipse(cx, cy, r * 2, r * 2);
        for (let i = 0; i < 4; i++) {
          const yy = cy + (i - 1.5) * r * 0.28;
          p.fill(60, 80, 200);
          p.rect(cx - 14 - sep, yy - 10, 22, 20, 4);
          p.rect(cx - 8 + sep, yy - 10, 22, 20, 4);
        }
      } else if (stage === 4) {
        p.fill(200, 230, 200, 180); p.ellipse(cx, cy, r * 2, r * 2);
        p.fill(120, 180, 255, 200);
        p.ellipse(cx - r * 0.45, cy, r * 0.82, r * 0.82);
        p.ellipse(cx + r * 0.45, cy, r * 0.82, r * 0.82);
      } else {
        const sep = 0.28 + prog * 0.38;
        const scale = 1 - prog * 0.18;
        p.fill(200, 230, 200, 180);
        p.ellipse(cx - r * sep, cy, r * 2 * scale, r * 2 * scale);
        p.ellipse(cx + r * sep, cy, r * 2 * scale, r * 2 * scale);
        p.fill(120, 180, 255, 160);
        p.ellipse(cx - r * sep, cy, r * 0.8 * scale, r * 0.8 * scale);
        p.ellipse(cx + r * sep, cy, r * 0.8 * scale, r * 0.8 * scale);
      }

      // Stage dots
      const dotY = H - 32;
      const sp = Math.min(46, (W - 40) / STAGES.length);
      const sx = cx - ((STAGES.length - 1) / 2) * sp;
      STAGES.forEach((_, i) => {
        p.fill(i === stage ? '#aa3bff' : '#E5E7EB'); p.noStroke();
        p.ellipse(sx + i * sp, dotY, i === stage ? 12 : 7, i === stage ? 12 : 7);
      });

      // Labels
      p.fill(40); p.noStroke();
      p.textSize(Math.max(13, W * 0.033)); p.textStyle(p.BOLD);
      p.text(STAGES[stage], cx, H - 62);
      p.textStyle(p.NORMAL);
      p.textSize(Math.max(10, W * 0.024)); p.fill(110);
      p.text(DESC[stage], cx, H - 46);
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function makeNeuralSketch(W: number, H: number) {
  return (p: p5) => {
    const N = 5;
    let pulseT = 0, fireIdx = -1, fireAge = 0;
    const REST = 130;

    p.setup = () => { p.createCanvas(W, H); p.textAlign(p.CENTER, p.CENTER); };

    const nx = (i: number) => W * (0.12 + i * (0.76 / (N - 1)));
    const ny = H / 2;

    p.draw = () => {
      p.background(248, 248, 252);
      if (++pulseT > REST) { pulseT = 0; fireIdx = 0; fireAge = 0; }
      if (fireIdx >= 0) { if (++fireAge > 18) { fireIdx++; fireAge = 0; } }
      if (fireIdx >= N) fireIdx = -1;

      // Axon lines
      for (let i = 0; i < N - 1; i++) {
        const active = i === fireIdx - 1 && fireAge < 18;
        p.strokeWeight(3);
        p.stroke(active ? p.color(170, 59, 255) : p.color(180, 200, 220));
        p.line(nx(i), ny, nx(i + 1), ny);
        if (!active) {
          p.noStroke(); p.fill(240, 200, 120, 180);
          p.rect((nx(i) + nx(i + 1)) / 2 - 16, ny - 7, 32, 14, 4);
        }
      }

      // Dendrites
      p.stroke(150, 180, 200); p.strokeWeight(2);
      p.line(nx(0), ny, nx(0) - 28, ny - 30);
      p.line(nx(0), ny, nx(0) - 28, ny + 30);
      p.line(nx(0), ny, nx(0) - 38, ny);

      // Pulse
      if (fireIdx >= 0) {
        const from = nx(Math.max(0, fireIdx - 1));
        const to   = fireIdx < N ? nx(fireIdx) : nx(N - 1) + 60;
        const px   = p.lerp(from, to, Math.min(1, fireAge / 18));
        const glow = Math.sin((fireAge / 18) * Math.PI);
        p.noStroke(); p.fill(170, 59, 255, 200 * glow);
        p.ellipse(px, ny, 22 + glow * 8, 22 + glow * 8);
        p.fill(255, 255, 200, 220 * glow); p.ellipse(px, ny, 10, 10);
      }

      // Neuron bodies
      for (let i = 0; i < N; i++) {
        const x = nx(i);
        const isActive = i === fireIdx && fireAge < 18;
        const fired    = (fireIdx === -1 && pulseT < 30) || (fireIdx > i);
        p.strokeWeight(2.5);
        p.stroke(isActive ? '#aa3bff' : '#94A3B8');
        p.fill(isActive ? p.color(240, 220, 255) : fired ? p.color(220, 245, 220) : p.color(240, 248, 255));
        p.ellipse(x, ny, 36, 36);
        if (i < N - 1) {
          p.noStroke(); p.fill(isActive ? '#aa3bff' : '#94A3B8');
          p.triangle(x + 14, ny - 5, x + 14, ny + 5, x + 22, ny);
        }
      }

      // Labels
      p.noStroke(); p.fill(80); p.textSize(Math.max(10, W * 0.025));
      p.text('Dendrites', nx(0) - 36, ny - 44);
      p.text('Axon terminal', nx(N - 1) + 16, ny - 26);
      p.fill(150); p.textSize(Math.max(9, W * 0.022));
      p.text('← action potential propagation →', W / 2, ny + 44);
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function makeEcosystemSketch(W: number, H: number) {
  return (p: p5) => {
    type Agent = { x: number; y: number; vx: number; vy: number };
    const PREY_N = 28, PRED_N = 5;
    const prey: Agent[] = [], pred: Agent[] = [];

    const mkAgent = () => ({
      x: p.random(W), y: p.random(H - 40),
      vx: p.random(-1.5, 1.5), vy: p.random(-1.5, 1.5),
    });

    p.setup = () => {
      p.createCanvas(W, H);
      p.textAlign(p.LEFT, p.CENTER);
      for (let i = 0; i < PREY_N; i++) prey.push(mkAgent());
      for (let i = 0; i < PRED_N;  i++) pred.push(mkAgent());
    };

    const wrap = (a: Agent) => {
      a.x = (a.x + W) % W;
      a.y = ((a.y + H - 40) % (H - 40));
    };

    const move = (a: Agent, spd: number) => {
      a.x += a.vx * spd; a.y += a.vy * spd;
      a.vx += p.random(-0.12, 0.12); a.vy += p.random(-0.12, 0.12);
      const s = Math.hypot(a.vx, a.vy);
      if (s > 2) { a.vx = a.vx / s * 2; a.vy = a.vy / s * 2; }
      wrap(a);
    };

    p.draw = () => {
      p.background(245, 250, 245);

      pred.forEach(pr => {
        let nearD = Infinity, nx = 0, ny = 0;
        prey.forEach(py => {
          const d = Math.hypot(pr.x - py.x, pr.y - py.y);
          if (d < nearD) { nearD = d; nx = py.x; ny = py.y; }
        });
        pr.vx += (nx - pr.x) * 0.001; pr.vy += (ny - pr.y) * 0.001;
        move(pr, 1.4);
      });

      prey.forEach(py => {
        pred.forEach(pr => {
          const d = Math.hypot(py.x - pr.x, py.y - pr.y);
          if (d < 90) { py.vx -= (pr.x - py.x) * 0.006; py.vy -= (pr.y - py.y) * 0.006; }
        });
        move(py, 1);
      });

      p.noStroke(); p.fill(50, 180, 90);
      prey.forEach(py => p.ellipse(py.x, py.y, 10, 10));

      p.fill(220, 50, 60);
      pred.forEach(pr => {
        p.push(); p.translate(pr.x, pr.y); p.rotate(Math.atan2(pr.vy, pr.vx));
        p.triangle(-10, -6, -10, 6, 10, 0); p.pop();
      });

      // HUD bar
      p.fill(240, 248, 240); p.rect(0, H - 36, W, 36);
      p.fill(50, 180, 90); p.ellipse(28, H - 18, 10, 10);
      p.fill(60); p.textSize(12); p.text(`Prey: ${prey.length}`, 38, H - 18);
      p.fill(220, 50, 60); p.ellipse(130, H - 18, 10, 10);
      p.text(`Predators: ${pred.length}`, 140, H - 18);
      p.fill(150); p.textAlign(p.RIGHT, p.CENTER);
      p.text('Lotka-Volterra predator-prey model', W - 10, H - 18);
    };
  };
}

// ── Simulation metadata ───────────────────────────────────────────────────────

type SimType = 'circulatory' | 'mitosis' | 'neural' | 'ecosystem';

const SKETCH_FACTORIES: Record<SimType, (w: number, h: number) => (p: p5) => void> = {
  circulatory: makeCirculatorySketch,
  mitosis:     makeMitosisSketch,
  neural:      makeNeuralSketch,
  ecosystem:   makeEcosystemSketch,
};

const LABELS: Record<SimType, { emoji: string; name: string }> = {
  circulatory: { emoji: '❤️',  name: 'Circulatory System' },
  mitosis:     { emoji: '🔬', name: 'Cell Division (Mitosis)' },
  neural:      { emoji: '⚡',  name: 'Neural Signal Propagation' },
  ecosystem:   { emoji: '🌿', name: 'Ecosystem Dynamics' },
};

// ── Component ─────────────────────────────────────────────────────────────────

export function VisualBiology({ payload }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef  = useRef<p5 | null>(null);

  const simType = (payload.simulationVariables?.simulationType as SimType | undefined) ?? 'circulatory';
  const label   = LABELS[simType] ?? LABELS.circulatory;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Tear down any previous p5 instance
    instanceRef.current?.remove();
    instanceRef.current = null;
    el.innerHTML = '';

    let mounted = false;

    const mount = (w: number, h: number) => {
      if (mounted || w < 10 || h < 10) return;
      mounted = true;
      el.innerHTML = '';
      const factory = SKETCH_FACTORIES[simType] ?? makeCirculatorySketch;
      instanceRef.current = new p5(factory(w, h), el);
    };

    // ResizeObserver fires with accurate contentRect once layout is stable
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        mount(e.contentRect.width, e.contentRect.height);
      }
    });
    ro.observe(el);

    // Also try immediately (element may already have dimensions after first paint)
    mount(el.offsetWidth, el.offsetHeight);

    return () => {
      ro.disconnect();
      instanceRef.current?.remove();
      instanceRef.current = null;
    };
  }, [simType]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '12px 20px 10px', borderBottom: '1px solid var(--line)',
        background: 'var(--bg)', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 18 }}>{label.emoji}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{label.name}</span>
        <span style={{
          marginLeft: 'auto', fontSize: 11, color: '#059669',
          background: '#ECFDF5', padding: '2px 8px', borderRadius: 20, fontWeight: 600,
        }}>
          Live simulation
        </span>
      </div>

      {/* p5 canvas container — flex:1 fills remaining height */}
      <div ref={containerRef} style={{ flex: 1, overflow: 'hidden', position: 'relative' }} />
    </div>
  );
}
