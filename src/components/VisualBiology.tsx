/**
 * VisualBiology — p5.js biology simulations.
 * Four preset sketches, selected via simulationType:
 *   circulatory  – blood cells flowing through a heart circuit
 *   mitosis      – cell dividing through the stages of mitosis
 *   neural       – action potential propagating across a neuron chain
 *   ecosystem    – predator / prey particle ecosystem
 */
import { useEffect, useRef } from 'react';
import p5 from 'p5';
import type { SimulationPayload } from '../lib/claude';

interface Props {
  payload: SimulationPayload;
}

// ── sketch factories ──────────────────────────────────────────────────────────

function circulatorySketch(p: p5) {
  let cx: number, cy: number;
  type Cell = { t: number; speed: number; oxy: boolean };
  const cells: Cell[] = [];
  const N = 22;

  p.setup = () => {
    p.createCanvas(p.width, p.height);
    cx = p.width / 2; cy = p.height / 2;
    for (let i = 0; i < N; i++) {
      cells.push({ t: (i / N) * p.TWO_PI * 2, speed: p.random(0.012, 0.018), oxy: i < N / 2 });
    }
    p.textAlign(p.CENTER, p.CENTER);
  };

  // Two elliptical loops sharing the heart centre
  function cellPos(t: number, loop: 'left' | 'right'): [number, number] {
    const rx = p.width * 0.28, ry = p.height * 0.22;
    const ox = loop === 'left' ? -rx * 0.55 : rx * 0.55;
    return [cx + ox + Math.cos(t) * rx * 0.55, cy + Math.sin(t) * ry];
  }

  p.draw = () => {
    p.background(248, 248, 252);

    // ── vessels ──
    p.noFill(); p.strokeWeight(18); p.stroke(220, 40, 60, 60);
    const rx = p.width * 0.28, ry = p.height * 0.22;
    p.ellipse(cx - rx * 0.55, cy, rx * 1.1, ry * 2);  // left loop
    p.ellipse(cx + rx * 0.55, cy, rx * 1.1, ry * 2);  // right loop

    p.strokeWeight(20); p.stroke(120, 80, 180, 50);
    p.ellipse(cx - rx * 0.55, cy, rx * 1.1, ry * 2);

    // ── heart ──
    p.noStroke(); p.fill(220, 40, 60);
    const hs = Math.max(28, p.width * 0.06);
    p.ellipse(cx - hs * 0.45, cy - hs * 0.15, hs * 0.9, hs * 0.9);
    p.ellipse(cx + hs * 0.45, cy - hs * 0.15, hs * 0.9, hs * 0.9);
    p.triangle(cx - hs * 0.88, cy + hs * 0.05, cx + hs * 0.88, cy + hs * 0.05, cx, cy + hs * 0.9);

    // ── blood cells ──
    cells.forEach((c, i) => {
      c.t += c.speed;
      const loop: 'left' | 'right' = i < N / 2 ? 'left' : 'right';
      const [x, y] = cellPos(c.t, loop);
      const r = c.oxy ? p.color(230, 50, 60) : p.color(120, 40, 80);
      p.fill(r); p.noStroke();
      p.ellipse(x, y, 14, 10);
      // biconcave indent
      p.fill(p.red(r) * 0.85, p.green(r) * 0.85, p.blue(r) * 0.85, 180);
      p.ellipse(x, y, 6, 4);
    });

    // ── labels ──
    p.fill(80); p.noStroke(); p.textSize(Math.max(10, p.width * 0.025));
    p.text('Oxygenated', cx - rx * 0.55, cy + ry + 18);
    p.text('Deoxygenated', cx + rx * 0.55, cy + ry + 18);
    p.fill(255); p.textSize(Math.max(9, p.width * 0.022));
    p.text('♥', cx, cy);
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function mitosisSketch(p: p5) {
  const STAGES = ['Interphase', 'Prophase', 'Metaphase', 'Anaphase', 'Telophase', 'Cytokinesis'];
  const DESC = [
    'DNA replicates; cell prepares',
    'Chromatin condenses into chromosomes',
    'Chromosomes align at cell equator',
    'Sister chromatids pulled apart',
    'Nuclear envelopes re-form',
    'Cytoplasm divides → 2 daughter cells',
  ];
  let stage = 0;
  let timer = 0;
  const DURATION = 140;

  p.setup = () => {
    p.createCanvas(p.width, p.height);
    p.textAlign(p.CENTER, p.CENTER);
    p.noStroke();
  };

  p.draw = () => {
    p.background(248, 248, 252);
    timer++;
    if (timer > DURATION) { timer = 0; stage = (stage + 1) % STAGES.length; }
    const prog = timer / DURATION;
    const cx = p.width / 2, cy = p.height / 2 - 10;
    const r  = Math.min(p.width, p.height) * 0.22;

    // Stage-specific rendering
    if (stage === 0) {
      // Interphase — intact cell, nucleus visible
      p.fill(200, 230, 200, 180); p.ellipse(cx, cy, r * 2, r * 2);
      p.fill(120, 180, 255, 200); p.ellipse(cx, cy, r * 0.9, r * 0.9);
      // DNA strands
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * p.TWO_PI;
        p.fill(60, 80, 200, 160);
        p.ellipse(cx + Math.cos(a) * r * 0.25, cy + Math.sin(a) * r * 0.25, 8, 5);
      }
    } else if (stage === 1) {
      // Prophase — condensing chromosomes
      p.fill(200, 230, 200, 180); p.ellipse(cx, cy, r * 2, r * 2);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * p.TWO_PI + prog;
        p.fill(60, 80, 200);
        p.push(); p.translate(cx + Math.cos(a) * r * 0.3, cy + Math.sin(a) * r * 0.3);
        p.rotate(a); p.rect(-5, -12, 10, 24, 5); p.pop();
      }
    } else if (stage === 2) {
      // Metaphase — aligned at equator
      p.fill(200, 230, 200, 180); p.ellipse(cx, cy, r * 2, r * 2);
      // spindle fibres
      p.stroke(180, 220, 255, 120); p.strokeWeight(1.5);
      for (let i = 0; i < 4; i++) {
        const yy = cy + (i - 1.5) * r * 0.35;
        p.line(cx - r * 0.9, cy - r * 0.7, cx, yy);
        p.line(cx + r * 0.9, cy - r * 0.7, cx, yy);
      }
      p.noStroke();
      for (let i = 0; i < 4; i++) {
        const yy = cy + (i - 1.5) * r * 0.35;
        p.fill(60, 80, 200);
        p.rect(cx - 14, yy - 12, 28, 24, 5);
      }
    } else if (stage === 3) {
      // Anaphase — pulling apart
      const sep = prog * r * 0.7;
      p.fill(200, 230, 200, 180); p.ellipse(cx, cy, r * 2, r * 2);
      for (let i = 0; i < 4; i++) {
        const yy = cy + (i - 1.5) * r * 0.28;
        p.fill(60, 80, 200);
        p.rect(cx - 14 - sep, yy - 10, 22, 20, 4);
        p.rect(cx - 8 + sep, yy - 10, 22, 20, 4);
      }
    } else if (stage === 4) {
      // Telophase — two nuclei forming
      p.fill(200, 230, 200, 180); p.ellipse(cx, cy, r * 2, r * 2);
      p.fill(120, 180, 255, 200);
      p.ellipse(cx - r * 0.45, cy, r * 0.8, r * 0.8);
      p.ellipse(cx + r * 0.45, cy, r * 0.8, r * 0.8);
    } else {
      // Cytokinesis — two daughter cells
      const sep = 0.3 + prog * 0.35;
      p.fill(200, 230, 200, 180);
      p.ellipse(cx - r * sep, cy, r * 2 * (1 - prog * 0.2), r * 2 * (1 - prog * 0.2));
      p.ellipse(cx + r * sep, cy, r * 2 * (1 - prog * 0.2), r * 2 * (1 - prog * 0.2));
      p.fill(120, 180, 255, 160);
      p.ellipse(cx - r * sep, cy, r * 0.8, r * 0.8);
      p.ellipse(cx + r * sep, cy, r * 0.8, r * 0.8);
    }

    // Stage indicator dots
    const dotY = p.height - 28;
    const spacing = Math.min(48, (p.width - 40) / STAGES.length);
    const startX  = cx - ((STAGES.length - 1) / 2) * spacing;
    STAGES.forEach((_, i) => {
      p.fill(i === stage ? '#aa3bff' : '#E5E7EB'); p.noStroke();
      p.ellipse(startX + i * spacing, dotY, i === stage ? 12 : 8, i === stage ? 12 : 8);
    });

    // Stage name + description
    p.fill(40); p.noStroke();
    p.textSize(Math.max(13, p.width * 0.032)); p.textStyle(p.BOLD);
    p.text(STAGES[stage], cx, p.height - 58);
    p.textStyle(p.NORMAL);
    p.textSize(Math.max(10, p.width * 0.024)); p.fill(100);
    p.text(DESC[stage], cx, p.height - 40);
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function neuralSketch(p: p5) {
  const N = 5;
  let pulseT   = 0;
  let fireIdx  = -1;
  let fireAge  = 0;
  const REST = 120;

  p.setup = () => {
    p.createCanvas(p.width, p.height);
    p.textAlign(p.CENTER, p.CENTER);
  };

  function neuronX(i: number) { return p.width * (0.12 + i * (0.76 / (N - 1))); }
  const neuronY = () => p.height / 2;

  p.draw = () => {
    p.background(248, 248, 252);

    pulseT++;
    if (pulseT > REST) { pulseT = 0; fireIdx = 0; fireAge = 0; }
    if (fireIdx >= 0) {
      fireAge++;
      if (fireAge > 18) { fireIdx++; fireAge = 0; }
      if (fireIdx >= N) fireIdx = -1;
    }

    const ny = neuronY();

    // ── axon lines ──
    for (let i = 0; i < N - 1; i++) {
      const x1 = neuronX(i), x2 = neuronX(i + 1);
      p.strokeWeight(3);
      const active = i === fireIdx - 1 && fireAge < 18;
      p.stroke(active ? p.color(170, 59, 255) : p.color(180, 200, 220));
      p.line(x1, ny, x2, ny);

      // Myelin sheaths
      if (!active) {
        p.noStroke(); p.fill(240, 200, 120, 180);
        const mid = (x1 + x2) / 2;
        p.rect(mid - 16, ny - 7, 32, 14, 4);
      }
    }

    // ── dendrites (branching lines from first neuron) ──
    p.stroke(150, 180, 200); p.strokeWeight(2);
    const dx = neuronX(0);
    p.line(dx, ny, dx - 28, ny - 30);
    p.line(dx, ny, dx - 28, ny + 30);
    p.line(dx, ny, dx - 36, ny);

    // ── signal pulse ──
    if (fireIdx >= 0) {
      const fx = neuronX(Math.max(0, fireIdx - 1));
      const tx = fireIdx < N ? neuronX(fireIdx) : neuronX(N - 1) + 60;
      const px = p.lerp(fx, tx, Math.min(1, fireAge / 18));
      const glow = Math.sin((fireAge / 18) * Math.PI);
      p.noStroke(); p.fill(170, 59, 255, 200 * glow);
      p.ellipse(px, ny, 22 + glow * 8, 22 + glow * 8);
      p.fill(255, 255, 200, 220 * glow);
      p.ellipse(px, ny, 10, 10);
    }

    // ── neurons (soma) ──
    for (let i = 0; i < N; i++) {
      const x = neuronX(i);
      const isActive = i === fireIdx && fireAge < 18;
      const wasFired  = fireIdx > i + 1;

      p.strokeWeight(2.5);
      p.stroke(isActive ? '#aa3bff' : '#94A3B8');
      p.fill(isActive ? p.color(240, 220, 255) : wasFired ? p.color(220, 240, 220) : p.color(240, 248, 255));
      p.ellipse(x, ny, 36, 36);

      // axon hillock triangle
      p.noStroke(); p.fill(isActive ? '#aa3bff' : '#94A3B8');
      if (i < N - 1) {
        p.triangle(x + 14, ny - 5, x + 14, ny + 5, x + 22, ny);
      }
    }

    // ── labels ──
    p.noStroke(); p.fill(80); p.textSize(Math.max(10, p.width * 0.024));
    p.text('Dendrites', neuronX(0) - 34, ny - 40);
    p.text('Axon terminals', neuronX(N - 1) + 14, ny - 24);
    p.textSize(Math.max(9, p.width * 0.02)); p.fill(140);
    p.text('Action potential', p.width / 2, ny + 40);
    p.text('propagation →', p.width / 2, ny + 56);
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function ecosystemSketch(p: p5) {
  const PREY_N = 30, PRED_N = 6;
  type Agent = { x: number; y: number; vx: number; vy: number };
  const prey: Agent[] = [], pred: Agent[] = [];
  let gen = 0;

  function mkAgent(w: number, h: number): Agent {
    return { x: p.random(w), y: p.random(h), vx: p.random(-1.5, 1.5), vy: p.random(-1.5, 1.5) };
  }

  p.setup = () => {
    p.createCanvas(p.width, p.height);
    for (let i = 0; i < PREY_N; i++) prey.push(mkAgent(p.width, p.height));
    for (let i = 0; i < PRED_N;  i++) pred.push(mkAgent(p.width, p.height));
    p.textAlign(p.CENTER, p.CENTER);
  };

  function move(a: Agent, speed: number) {
    a.x = (a.x + a.vx * speed + p.width)  % p.width;
    a.y = (a.y + a.vy * speed + p.height) % p.height;
    // Random walk
    a.vx += p.random(-0.15, 0.15); a.vy += p.random(-0.15, 0.15);
    const spd = Math.hypot(a.vx, a.vy);
    if (spd > 2) { a.vx /= spd / 2; a.vy /= spd / 2; }
  }

  p.draw = () => {
    p.background(245, 250, 245);
    gen++;

    // Predators chase nearest prey
    pred.forEach(pr => {
      let nearest: Agent | null = null, nearD = Infinity;
      prey.forEach(py => {
        const d = Math.hypot(pr.x - py.x, pr.y - py.y);
        if (d < nearD) { nearD = d; nearest = py; }
      });
      if (nearest) {
        const nx = (nearest as Agent);
        pr.vx += (nx.x - pr.x) * 0.001;
        pr.vy += (nx.y - pr.y) * 0.001;
      }
      move(pr, 1.4);
    });

    // Prey flee nearest predator
    prey.forEach(py => {
      pred.forEach(pr => {
        const d = Math.hypot(py.x - pr.x, py.y - pr.y);
        if (d < 80) {
          py.vx -= (pr.x - py.x) * 0.006;
          py.vy -= (pr.y - py.y) * 0.006;
        }
      });
      move(py, 1);
    });

    // ── draw prey ──
    p.noStroke(); p.fill(50, 180, 90);
    prey.forEach(py => p.ellipse(py.x, py.y, 10, 10));

    // ── draw predators ──
    p.fill(220, 50, 60);
    pred.forEach(pr => {
      p.push();
      p.translate(pr.x, pr.y);
      p.rotate(Math.atan2(pr.vy, pr.vx));
      p.triangle(-10, -6, -10, 6, 10, 0);
      p.pop();
    });

    // ── HUD ──
    const hudY = p.height - 22;
    p.fill(50, 180, 90); p.ellipse(40, hudY, 10, 10);
    p.fill(60); p.textSize(12); p.textAlign(p.LEFT, p.CENTER);
    p.text(`Prey: ${prey.length}`, 50, hudY);

    p.fill(220, 50, 60); p.ellipse(130, hudY, 10, 10);
    p.text(`Predators: ${pred.length}`, 140, hudY);

    p.fill(140); p.textAlign(p.CENTER, p.CENTER); p.textSize(10);
    p.text('Predator-prey ecosystem (Lotka-Volterra)', p.width / 2, 16);
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const SKETCH_MAP = {
  circulatory: circulatorySketch,
  mitosis:     mitosisSketch,
  neural:      neuralSketch,
  ecosystem:   ecosystemSketch,
} as const;

type SimType = keyof typeof SKETCH_MAP;
const LABELS: Record<SimType, { emoji: string; name: string }> = {
  circulatory: { emoji: '❤️',  name: 'Circulatory System' },
  mitosis:     { emoji: '🔬', name: 'Cell Division (Mitosis)' },
  neural:      { emoji: '⚡',  name: 'Neuron Signal' },
  ecosystem:   { emoji: '🌿', name: 'Ecosystem Dynamics' },
};

// ─────────────────────────────────────────────────────────────────────────────

export function VisualBiology({ payload }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef  = useRef<p5 | null>(null);

  const simType: SimType =
    (payload.simulationVariables?.simulationType as SimType | undefined) ?? 'circulatory';
  const sketchFn = SKETCH_MAP[simType] ?? circulatorySketch;
  const label    = LABELS[simType] ?? LABELS.circulatory;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Destroy any previous instance
    instanceRef.current?.remove();

    // Give the element its measured size so p5 can read it in setup
    const w = el.offsetWidth  || 400;
    const h = el.offsetHeight || 300;

    const sketch = (p: p5) => {
      // Pre-seed width/height so setup can read them
      (p as unknown as { width: number; height: number }).width  = w;
      (p as unknown as { width: number; height: number }).height = h;

      const origSetup = sketchFn.toString().includes('p.setup') ? sketchFn : null;
      void origSetup;
      sketchFn(p);

      // Override setup to fix canvas size to container
      const userSetup = p.setup;
      p.setup = () => {
        p.createCanvas(w, h);
        if (userSetup) userSetup.call(p);
      };
    };

    instanceRef.current = new p5(sketch, el);
    return () => { instanceRef.current?.remove(); instanceRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simType]);

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
        <span style={{ fontSize: 18 }}>{label.emoji}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{label.name}</span>
        <span style={{
          marginLeft:   'auto',
          fontSize:     11,
          color:        '#059669',
          background:   '#ECFDF5',
          padding:      '2px 8px',
          borderRadius: 20,
          fontWeight:   600,
        }}>
          Live simulation
        </span>
      </div>

      {/* p5 canvas container */}
      <div
        ref={containerRef}
        style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
      />
    </div>
  );
}
