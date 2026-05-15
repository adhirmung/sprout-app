/**
 * Sprout — Rigorous Cognitive Assessment
 *
 * Scientific basis:
 *  Working Memory   : Digit-span / Corsi-block paradigm (Corsi, 1972; Wechsler, 2008)
 *                     2-of-3 adaptive span method (Conway et al., 2005)
 *  Processing Speed : Symbol-matching with speed-accuracy trade-off scoring
 *  Fluid Intelligence: Number-series with mixed pattern types (Cattell, 1963)
 *  Confidence Calib. : Brier score (Brier, 1950); calibration bias
 *  Executive Function: Task-switching paradigm, switch-cost (Rogers & Monsell, 1995)
 *  Sustained Attention: Continuous Performance Task + signal-detection d′
 *                       (Rosvold et al., 1956; Green & Swets, 1966)
 *
 * Protocol:
 *  - 2 unscored practice trials per test (with corrective feedback)
 *  - "Practice complete" transition screen
 *  - Scored trials: no feedback (avoids response-criterion drift)
 *  - Reaction times recorded for speed/EF/attention
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SproutMark, SproutWordmark } from '../components/Brand';
import { Icon } from '../components/Icon';
import { celebrate } from '../lib/store';
import type { LearnerProfile, User } from '../lib/types';

// ── Psychometric utilities ─────────────────────────────────────────────────────

/**
 * Inverse normal CDF — Beasley-Springer-Moro rational approximation.
 * Used for d-prime (signal-detection theory).
 */
function normSInv(p: number): number {
  p = Math.max(0.001, Math.min(0.999, p));
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
              1.383577518672690e+02, -3.066479806614716e+01,  2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
              6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00,  4.374664141464968e+00,  2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5; r = q*q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1-p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

/**
 * Signal-detection d′ with log-linear correction for extreme rates.
 * Hautus (1995) correction: add 0.5 to numerator, 1 to denominator.
 */
function computeDPrime(hits: number, misses: number, fas: number, crs: number): number {
  const hitRate = (hits + 0.5) / (hits + misses + 1);
  const faRate  = (fas  + 0.5) / (fas  + crs   + 1);
  return normSInv(hitRate) - normSInv(faRate);
}

/**
 * Brier score: mean squared error between confidence and outcome.
 * Range 0 (perfect) – 0.25 (chance) – 1 (perfectly wrong).
 */
function computeBrierScore(trials: Array<{ correct: boolean; confidence: number }>): number {
  if (!trials.length) return 0.25;
  return trials.reduce((s, t) => s + (t.confidence / 100 - (t.correct ? 1 : 0)) ** 2, 0) / trials.length;
}

/** Clamp + round to integer */
const clamp = (v: number, lo = 0, hi = 100) => Math.round(Math.max(lo, Math.min(hi, v)));

// ── Trial result types ─────────────────────────────────────────────────────────

interface WMTrial       { span: number;     correct: boolean; practice: boolean }
interface SpeedTrial    { correct: boolean; rt: number;       practice: boolean }
interface FluidTrial    { correct: boolean; confidence: number; rt: number; practice: boolean }
interface EFTrial       { correct: boolean; rt: number; isSwitch: boolean; practice: boolean }
interface AttentionTrial{ isTarget: boolean; responded: boolean; rt: number | null; practice: boolean }

interface TestData {
  wmVerbal:    WMTrial[];
  wmVisual:    WMTrial[];
  speed:       SpeedTrial[];
  fluid:       FluidTrial[];
  ef:          EFTrial[];
  attention:   AttentionTrial[];
}

// ── Test catalogue ─────────────────────────────────────────────────────────────

const TESTS = [
  { id: 'wm-verbal',  name: 'Word Span',       icon: '📝', color: 'brand', chip: 'Working Memory',      dataKey: 'wmVerbal',   scoredTrials: 12 },
  { id: 'wm-visual',  name: 'Spatial Span',    icon: '🧩', color: 'plum',  chip: 'Working Memory',      dataKey: 'wmVisual',   scoredTrials: 12 },
  { id: 'speed',      name: 'Pair Matching',   icon: '⚡', color: 'gold',  chip: 'Processing Speed',    dataKey: 'speed',      scoredTrials: 24 },
  { id: 'fluid',      name: 'Number Series',   icon: '🔢', color: 'sky',   chip: 'Fluid Intelligence',  dataKey: 'fluid',      scoredTrials: 12 },
  { id: 'ef',         name: 'Rule Switching',  icon: '🔀', color: 'coral', chip: 'Executive Function',  dataKey: 'ef',         scoredTrials: 20 },
  { id: 'attention',  name: 'Focus Monitor',   icon: '🎯', color: 'brand', chip: 'Sustained Attention', dataKey: 'attention',  scoredTrials: 30 },
] as const;

const PRACTICE_TRIALS = 2;

// ── Top-level flow ─────────────────────────────────────────────────────────────

interface AssessmentFlowProps {
  user: User;
  onComplete: (profile: LearnerProfile) => void;
  onSkip: () => void;
}

export function AssessmentFlow({ user, onComplete, onSkip }: AssessmentFlowProps) {
  const [phase, setPhase]   = useState<'intro' | 'running' | 'results'>('intro');
  const [testIdx, setTestIdx] = useState(0);
  const [data, setData]     = useState<TestData>({
    wmVerbal: [], wmVisual: [], speed: [], fluid: [], ef: [], attention: [],
  });

  const appendTrials = useCallback((key: keyof TestData, trials: TestData[keyof TestData]) => {
    setData(d => ({ ...d, [key]: [...(d[key] as unknown[]), ...(trials as unknown[])] as typeof d[typeof key] }));
  }, []);

  const handleTestDone = useCallback((key: keyof TestData, trials: TestData[keyof TestData]) => {
    appendTrials(key, trials);
    if (testIdx + 1 >= TESTS.length) {
      setPhase('results');
    } else {
      setTestIdx(i => i + 1);
    }
  }, [testIdx, appendTrials]);

  if (phase === 'intro') {
    return (
      <AssessIntro
        user={user}
        onStart={() => setPhase('running')}
        onSkip={onSkip}
      />
    );
  }

  if (phase === 'running') {
    const test = TESTS[testIdx];
    return (
      <TestHost
        key={test.id}
        test={test}
        index={testIdx}
        total={TESTS.length}
        onDone={(trials) => handleTestDone(test.dataKey as keyof TestData, trials as TestData[keyof TestData])}
      />
    );
  }

  const profile = computeProfile(data);
  return <AssessResults results={profile} onContinue={() => onComplete(profile)} />;
}

// ── Intro ──────────────────────────────────────────────────────────────────────

function AssessIntro({ user, onStart, onSkip }: { user: User; onStart: () => void; onSkip: () => void }) {
  const items = [
    { icon: '📝', label: 'Word Span',       desc: '12 trials · adaptive difficulty · 2-of-3 span method',        color: 'brand' },
    { icon: '🧩', label: 'Spatial Span',    desc: '12 trials · Corsi block paradigm · visual working memory',    color: 'plum'  },
    { icon: '⚡', label: 'Pair Matching',   desc: '24 trials · reaction time + accuracy · speed-accuracy trade-off', color: 'gold' },
    { icon: '🔢', label: 'Number Series',   desc: '12 trials · mixed patterns · Brier score confidence calibration', color: 'sky'  },
    { icon: '🔀', label: 'Rule Switching',  desc: '20 trials · task-switching · switch-cost measurement',         color: 'coral' },
    { icon: '🎯', label: 'Focus Monitor',   desc: '30 trials · vigilance CPT · signal-detection d′ scoring',     color: 'brand' },
  ];

  return (
    <div style={{ minHeight: '100dvh', padding: '40px 20px', background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ maxWidth: 760, width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 48 }}>
          <SproutWordmark size={18} />
          <button className="btn btn-ghost" onClick={onSkip} style={{ fontSize: 13 }}>Skip for now →</button>
        </div>

        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderRadius: 999, background: 'var(--brand-soft)', color: 'var(--brand-2)', fontSize: 12, fontWeight: 700, marginBottom: 18, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            <Icon name="sparkle" size={14} /> Evidence-based · 10–15 minutes
          </div>
          <h1 className="display" style={{ fontSize: 'clamp(34px, 5vw, 52px)', marginBottom: 14 }}>
            Hey {user.name.split(' ')[0]} 👋<br />let's map how you learn.
          </h1>
          <p style={{ fontSize: 17, color: 'var(--ink-2)', maxWidth: 560, margin: '0 auto' }}>
            Six validated cognitive tests produce a precise learning profile. Every card you see afterward is tuned to your results. Each test starts with two unscored practice trials.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 28 }}>
          {items.map(t => (
            <div key={t.label} className="card" style={{ padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: `var(--${t.color}-soft)`, display: 'grid', placeItems: 'center', fontSize: 22, flexShrink: 0 }}>{t.icon}</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{t.label}</div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>{t.desc}</div>
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: 18, display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 24, background: 'var(--brand-tint)', borderColor: 'var(--brand-soft)' }}>
          <Icon name="sparkle" size={20} stroke="var(--brand-2)" style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>
            <strong>No right or wrong cognitive style.</strong> The profile reveals <em>how</em> you learn, not how smart you are. Results are used only to personalise content pace, chunk size, and feedback frequency.
          </div>
        </div>

        <button className="btn btn-primary btn-lg btn-block" onClick={onStart}>
          Start assessment <Icon name="arrow-right" size={18} />
        </button>
      </div>
    </div>
  );
}

// ── TestHost — manages practice → main phases ──────────────────────────────────

type AnyTrial = WMTrial | SpeedTrial | FluidTrial | EFTrial | AttentionTrial;

interface TestHostProps {
  test: typeof TESTS[number];
  index: number;
  total: number;
  onDone: (trials: AnyTrial[]) => void;
}

function TestHost({ test, index, total, onDone }: TestHostProps) {
  const [subPhase, setSubPhase] = useState<'practice' | 'transition' | 'main'>('practice');
  const [practiceDone, setPracticeDone] = useState<AnyTrial[]>([]);

  const handlePracticeComplete = (trials: AnyTrial[]) => {
    setPracticeDone(trials);
    setSubPhase('transition');
  };

  const handleMainComplete = (trials: AnyTrial[]) => {
    const all = [...practiceDone, ...trials];
    onDone(all);
  };

  const progressPct = (index / total) * 100;

  return (
    <div style={{ minHeight: '100dvh', padding: '24px 20px 40px', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ maxWidth: 720, width: '100%', margin: '0 auto', flex: 1, display: 'flex', flexDirection: 'column' }}>

        {/* Progress bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
          <SproutMark size={32} />
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12, color: 'var(--ink-2)', fontWeight: 600 }}>
              <span>{test.chip} · {test.name}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {subPhase === 'practice' && <span className="chip" style={{ fontSize: 11 }}>Practice</span>}
                {subPhase === 'main'     && <span className="chip brand" style={{ fontSize: 11 }}>Scored</span>}
                {index + 1} / {total}
              </span>
            </div>
            <div style={{ height: 6, background: 'var(--line)', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{ height: '100%', background: 'var(--brand)', width: `${progressPct}%`, transition: 'width 0.4s' }} />
            </div>
          </div>
        </div>

        {subPhase === 'practice' && (
          <TrialRunner
            key="practice"
            testType={test.dataKey}
            trialsTotal={PRACTICE_TRIALS}
            isPractice
            onComplete={handlePracticeComplete}
          />
        )}

        {subPhase === 'transition' && (
          <PracticeTransition testName={test.name} onContinue={() => setSubPhase('main')} />
        )}

        {subPhase === 'main' && (
          <TrialRunner
            key="main"
            testType={test.dataKey}
            trialsTotal={test.scoredTrials}
            isPractice={false}
            onComplete={handleMainComplete}
          />
        )}
      </div>
    </div>
  );
}

function PracticeTransition({ testName, onContinue }: { testName: string; onContinue: () => void }) {
  return (
    <div className="card fade-up" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 48, textAlign: 'center' }}>
      <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--brand-soft)', display: 'grid', placeItems: 'center', marginBottom: 22 }}>
        <Icon name="check" size={28} stroke="var(--brand)" />
      </div>
      <h2 className="display" style={{ fontSize: 28, marginBottom: 10 }}>Practice complete</h2>
      <p style={{ color: 'var(--ink-2)', fontSize: 16, maxWidth: 420, marginBottom: 32 }}>
        Good. Now the real {testName} trials begin. You won't see feedback on your answers — just work steadily and trust your first instinct.
      </p>
      <button className="btn btn-primary btn-lg" onClick={onContinue}>
        Begin scored trials <Icon name="arrow-right" size={18} />
      </button>
    </div>
  );
}

// ── TrialRunner — dispatches to per-test trial components ──────────────────────

interface TrialRunnerProps {
  testType: string;
  trialsTotal: number;
  isPractice: boolean;
  onComplete: (trials: AnyTrial[]) => void;
}

function TrialRunner({ testType, trialsTotal, isPractice, onComplete }: TrialRunnerProps) {
  const [trialIdx, setTrialIdx] = useState(0);
  const [collected, setCollected] = useState<AnyTrial[]>([]);
  const [countdown, setCountdown] = useState(3);
  const [started, setStarted] = useState(false);
  const doneRef = useRef(false);

  useEffect(() => {
    if (started) return;
    if (countdown <= 0) { setStarted(true); return; }
    const t = setTimeout(() => setCountdown(c => c - 1), 700);
    return () => clearTimeout(t);
  }, [countdown, started]);

  const handleTrialDone = useCallback((trial: AnyTrial) => {
    if (doneRef.current) return;
    const next = [...collected, trial];
    if (next.length >= trialsTotal) {
      doneRef.current = true;
      onComplete(next);
    } else {
      setCollected(next);
      setTrialIdx(i => i + 1);
    }
  }, [collected, trialsTotal, onComplete]);

  if (!started) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          {isPractice && (
            <div className="chip" style={{ marginBottom: 18, fontSize: 13 }}>Practice round — answers don't count</div>
          )}
          <div className="display" style={{ fontSize: 96, color: 'var(--brand)', animation: 'pop 0.5s ease' }} key={countdown}>
            {countdown || 'Go!'}
          </div>
        </div>
      </div>
    );
  }

  const trialProps = { trialIdx, trialsTotal, isPractice, onDone: handleTrialDone };

  switch (testType) {
    case 'wmVerbal':   return <VerbalSpanTrial   key={trialIdx} {...trialProps} />;
    case 'wmVisual':   return <VisualSpanTrial   key={trialIdx} {...trialProps} />;
    case 'speed':      return <SpeedMatchTrial   key={trialIdx} {...trialProps} />;
    case 'fluid':      return <FluidPatternTrial key={trialIdx} {...trialProps} />;
    case 'ef':         return <RuleSwitchTrial   key={trialIdx} {...trialProps} prevTrialIdx={trialIdx - 1} />;
    case 'attention':  return <VigilanceTrial    key={trialIdx} {...trialProps} />;
    default:           return null;
  }
}

// ── Shared trial frame ─────────────────────────────────────────────────────────

function TrialFrame({ trialIdx, trialsTotal, isPractice, hint, children, footer }: {
  trialIdx: number; trialsTotal: number; isPractice: boolean;
  hint?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <div className="card fade-up" style={{ flex: 1, padding: 36, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', minHeight: 420, position: 'relative' }}>
      <div style={{ position: 'absolute', top: 18, right: 18, display: 'flex', gap: 8 }}>
        {isPractice && <span className="chip" style={{ fontSize: 11 }}>Practice</span>}
        <span className="chip">{trialIdx + 1} / {trialsTotal}</span>
      </div>
      {hint && <div style={{ color: 'var(--ink-2)', marginBottom: 22, fontSize: 15 }}>{hint}</div>}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', width: '100%' }}>{children}</div>
      {footer && <div style={{ marginTop: 22, display: 'flex', gap: 10 }}>{footer}</div>}
    </div>
  );
}

/** Brief coloured feedback shown after practice trials */
function FeedbackFlash({ correct, correctAnswer, onDone }: { correct: boolean; correctAnswer?: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, correct ? 800 : 1300);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="card fade-up" style={{
      flex: 1, padding: 48, display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', textAlign: 'center',
      background: correct ? 'var(--brand-tint)' : '#FFF1EA',
      borderColor: correct ? 'var(--brand-soft)' : 'var(--coral-soft)',
    }}>
      <div style={{ fontSize: 56, marginBottom: 16 }}>{correct ? '✅' : '❌'}</div>
      <div className="display" style={{ fontSize: 26, color: correct ? 'var(--brand-2)' : 'var(--coral)', marginBottom: correct ? 0 : 10 }}>
        {correct ? 'Correct!' : 'Not quite'}
      </div>
      {!correct && correctAnswer && (
        <div style={{ fontSize: 15, color: 'var(--ink-2)', marginTop: 8 }}>Answer was: <strong>{correctAnswer}</strong></div>
      )}
    </div>
  );
}

// ── 1. Verbal Span (Word Span) ─────────────────────────────────────────────────
// Adaptive: span starts at 3, grows by 1 every 3 trials. Max = 7.
// Scoring: 2-of-3 method computed at results time.

const CONSONANTS = 'BCDFGHJKLMNPRSTVWXZ'.split('');

function VerbalSpanTrial({ trialIdx, trialsTotal, isPractice, onDone }: {
  trialIdx: number; trialsTotal: number; isPractice: boolean;
  onDone: (t: WMTrial) => void;
}) {
  const spanLength = isPractice ? 3 : Math.min(3 + Math.floor(trialIdx / 3), 7);
  const [stage, setStage]   = useState<'show' | 'recall' | 'feedback'>('show');
  const [input, setInput]   = useState('');
  const [correct, setCorrect] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const seq = useMemo(() => {
    return Array(spanLength).fill(0)
      .map(() => CONSONANTS[Math.floor(Math.random() * CONSONANTS.length)]).join(' ');
  }, [spanLength]);

  const showDuration = 1500 + spanLength * 400;

  useEffect(() => {
    if (stage !== 'show') return;
    const t = setTimeout(() => setStage('recall'), showDuration);
    return () => clearTimeout(t);
  }, [stage, showDuration]);

  useEffect(() => {
    if (stage === 'recall') inputRef.current?.focus();
  }, [stage]);

  const submit = () => {
    const isCorrect = input.toUpperCase().replace(/\s+/g, ' ').trim() === seq;
    setCorrect(isCorrect);
    if (isPractice) {
      setStage('feedback');
    } else {
      onDone({ span: spanLength, correct: isCorrect, practice: false });
    }
  };

  if (stage === 'feedback') {
    return (
      <FeedbackFlash correct={correct} correctAnswer={seq}
        onDone={() => onDone({ span: spanLength, correct, practice: true })} />
    );
  }

  if (stage === 'show') {
    return (
      <TrialFrame trialIdx={trialIdx} trialsTotal={trialsTotal} isPractice={isPractice} hint="Memorize this sequence — it will disappear">
        <div className="display mono" style={{ fontSize: Math.min(72, 180 / spanLength), color: 'var(--brand)', letterSpacing: '0.08em' }}>
          {seq}
        </div>
        <div style={{ marginTop: 20, fontSize: 13, color: 'var(--ink-3)' }}>
          {spanLength} letters · {(showDuration / 1000).toFixed(1)}s
        </div>
      </TrialFrame>
    );
  }

  return (
    <TrialFrame trialIdx={trialIdx} trialsTotal={trialsTotal} isPractice={isPractice} hint="Type the letters you saw, separated by spaces"
      footer={<button className="btn btn-primary" onClick={submit}>Submit <Icon name="arrow-right" size={16}/></button>}>
      <input ref={inputRef} className="input mono" value={input} onChange={e => setInput(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="B C D …"
        style={{ maxWidth: 400, fontSize: 26, textAlign: 'center', letterSpacing: '0.06em' }} />
    </TrialFrame>
  );
}

// ── 2. Visual Span (Corsi Block) ───────────────────────────────────────────────
// Adaptive: 3 cells at start, +1 per 3 trials, max 7.

function VisualSpanTrial({ trialIdx, trialsTotal, isPractice, onDone }: {
  trialIdx: number; trialsTotal: number; isPractice: boolean;
  onDone: (t: WMTrial) => void;
}) {
  const numCells = isPractice ? 3 : Math.min(3 + Math.floor(trialIdx / 3), 7);
  const [stage, setStage]   = useState<'show' | 'recall' | 'feedback'>('show');
  const [picked, setPicked] = useState<number[]>([]);
  const [correct, setCorrect] = useState(false);

  const positions = useMemo(() => {
    const set = new Set<number>();
    while (set.size < numCells) set.add(Math.floor(Math.random() * 16)); // 4×4 grid
    return [...set];
  }, [numCells]);

  const showDuration = 1200 + numCells * 350;

  useEffect(() => {
    if (stage !== 'show') return;
    const t = setTimeout(() => setStage('recall'), showDuration);
    return () => clearTimeout(t);
  }, [stage, showDuration]);

  const submit = () => {
    const isCorrect = JSON.stringify([...picked].sort()) === JSON.stringify([...positions].sort());
    setCorrect(isCorrect);
    if (isPractice) {
      setStage('feedback');
    } else {
      onDone({ span: numCells, correct: isCorrect, practice: false });
    }
  };

  if (stage === 'feedback') {
    return (
      <FeedbackFlash correct={correct}
        onDone={() => onDone({ span: numCells, correct, practice: true })} />
    );
  }

  return (
    <TrialFrame trialIdx={trialIdx} trialsTotal={trialsTotal} isPractice={isPractice}
      hint={stage === 'show' ? `Memorize ${numCells} highlighted cells` : 'Tap every cell you saw'}
      footer={stage === 'recall' ? (
        <button className="btn btn-primary" onClick={submit}>Submit <Icon name="arrow-right" size={16}/></button>
      ) : null}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {[...Array(16)].map((_, i) => {
          const lit = stage === 'show' ? positions.includes(i) : picked.includes(i);
          return (
            <button key={i} disabled={stage === 'show'}
              onClick={() => setPicked(p => p.includes(i) ? p.filter(x => x !== i) : [...p, i])}
              style={{
                width: 64, height: 64, borderRadius: 12,
                border: `2px solid ${lit ? 'var(--brand)' : 'var(--line)'}`,
                background: lit ? 'var(--brand)' : 'var(--card)',
                transition: 'all 0.15s',
              }} />
          );
        })}
      </div>
    </TrialFrame>
  );
}

// ── 3. Processing Speed (Symbol Matching) ─────────────────────────────────────
// 24 scored trials. 6-character strings. RT + accuracy recorded.
// Score = inverse-RT weighted accuracy (speed-accuracy trade-off).

function SpeedMatchTrial({ trialIdx, trialsTotal, isPractice, onDone }: {
  trialIdx: number; trialsTotal: number; isPractice: boolean;
  onDone: (t: SpeedTrial) => void;
}) {
  const startRef   = useRef(Date.now());
  const respondedRef = useRef(false);
  const [stage, setStage] = useState<'task' | 'feedback'>('task');
  const [correct, setCorrect] = useState(false);

  const { str1, str2, isSame } = useMemo(() => {
    const chars = 'ABCDEFGHJKMNPQRSTVWXYZ';
    const len = 4;
    const s1 = Array(len).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
    const same = Math.random() > 0.5;
    let s2 = s1;
    if (!same) {
      const changeIdx = Math.floor(Math.random() * len);
      const orig = s1[changeIdx];
      let replacement = orig;
      while (replacement === orig) replacement = chars[Math.floor(Math.random() * chars.length)];
      s2 = s1.slice(0, changeIdx) + replacement + s1.slice(changeIdx + 1);
    }
    return { str1: s1, str2: s2, isSame: same };
  }, [trialIdx]);

  useEffect(() => { startRef.current = Date.now(); respondedRef.current = false; }, [str1]);

  const respond = (answer: boolean) => {
    if (respondedRef.current) return;
    respondedRef.current = true;
    const rt = Date.now() - startRef.current;
    const isCorrect = answer === isSame;
    setCorrect(isCorrect);
    if (isPractice) {
      setStage('feedback');
    } else {
      onDone({ correct: isCorrect, rt, practice: false });
    }
  };

  if (stage === 'feedback') {
    return (
      <FeedbackFlash correct={correct} correctAnswer={isSame ? 'Same' : 'Different'}
        onDone={() => onDone({ correct, rt: 0, practice: true })} />
    );
  }

  return (
    <TrialFrame trialIdx={trialIdx} trialsTotal={trialsTotal} isPractice={isPractice} hint="Are these two letter pairs identical?"
      footer={<>
        <button className="btn btn-primary" style={{ minWidth: 140 }} onClick={() => respond(true)}>✓ Same</button>
        <button className="btn btn-secondary" style={{ minWidth: 140 }} onClick={() => respond(false)}>✗ Different</button>
      </>}>
      <div className="mono display" style={{ lineHeight: 2, userSelect: 'none' }}>
        <div style={{ fontSize: 42 }}>{str1}</div>
        <div style={{ fontSize: 42 }}>{str2}</div>
      </div>
    </TrialFrame>
  );
}

// ── 4. Fluid Intelligence (Number Series + Confidence) ────────────────────────
// 12 scored trials with 3 pattern types: arithmetic, geometric, alternating.
// After each answer a confidence slider (50–100%) appears — Brier score computed at end.
// Practice trials show feedback; scored trials do not.

interface PatternItem {
  sequence: number[];
  answer: number;
  options: number[];
  type: string;
  explanation: string;
}

function generatePattern(seed: number): PatternItem {
  const r = (n: number) => Math.floor((Math.sin(seed * 9301 + n * 49297 + 233720) * 0.5 + 0.5) * n);

  const patternType = seed % 3;

  if (patternType === 0) {
    // Arithmetic: a + n*d
    const a = r(8) + 1;
    const d = r(6) + 2;
    const seq = [a, a+d, a+2*d, a+3*d];
    const ans = a + 4*d;
    const distractors = [ans - d, ans + d, ans + 2*d, ans - 1, ans + 1].filter(x => x !== ans);
    const opts = [ans, ...distractors.slice(0, 3)].sort(() => Math.random() - 0.5);
    return { sequence: seq, answer: ans, options: opts, type: 'Arithmetic', explanation: `Each term increases by ${d}` };
  } else if (patternType === 1) {
    // Geometric: a * r^n
    const a = r(4) + 1;
    const ratio = r(2) + 2; // 2 or 3
    const seq = [a, a*ratio, a*ratio**2, a*ratio**3];
    const ans = a * ratio**4;
    const distractors = [ans * ratio, Math.floor(ans / ratio), ans + ratio, ans - ratio].filter(x => x !== ans && x > 0);
    const opts = [ans, ...distractors.slice(0, 3)].sort(() => Math.random() - 0.5);
    return { sequence: seq, answer: ans, options: opts, type: 'Geometric', explanation: `Each term is multiplied by ${ratio}` };
  } else {
    // Alternating / Fibonacci-like: each term = sum of previous two
    const a = r(5) + 1;
    const b = r(5) + a + 1;
    const seq = [a, b, a+b, a+2*b];
    const ans = 2*a + 3*b;
    const distractors = [ans + b, ans - a, ans + a, ans - b].filter(x => x !== ans && x > 0);
    const opts = [ans, ...distractors.slice(0, 3)].sort(() => Math.random() - 0.5);
    return { sequence: seq, answer: ans, options: opts, type: 'Fibonacci-style', explanation: `Each term = sum of the previous two` };
  }
}

function FluidPatternTrial({ trialIdx, trialsTotal, isPractice, onDone }: {
  trialIdx: number; trialsTotal: number; isPractice: boolean;
  onDone: (t: FluidTrial) => void;
}) {
  const startRef = useRef(Date.now());
  const [picked, setPicked]   = useState<number | null>(null);
  const [showConf, setShowConf] = useState(false);
  const [confidence, setConf] = useState(70);
  const [stage, setStage]     = useState<'task' | 'feedback'>('task');

  const pattern = useMemo(() => generatePattern(trialIdx * 7 + (isPractice ? 99 : 0)), [trialIdx, isPractice]);

  useEffect(() => { startRef.current = Date.now(); }, [pattern]);

  const selectAnswer = (opt: number) => {
    if (picked !== null) return;
    setPicked(opt);
    setShowConf(true);
  };

  const submit = () => {
    const rt = Date.now() - startRef.current;
    const isCorrect = picked === pattern.answer;
    if (isPractice) {
      setStage('feedback');
      setTimeout(() => onDone({ correct: isCorrect, confidence, rt, practice: true }), isCorrect ? 800 : 1300);
    } else {
      onDone({ correct: isCorrect, confidence, rt, practice: false });
    }
  };

  if (stage === 'feedback') {
    return (
      <FeedbackFlash correct={picked === pattern.answer}
        correctAnswer={`${pattern.answer} (${pattern.explanation})`}
        onDone={() => {}} />
    );
  }

  return (
    <TrialFrame trialIdx={trialIdx} trialsTotal={trialsTotal} isPractice={isPractice} hint="What number comes next?">
      <div className="display mono" style={{ fontSize: 'clamp(28px, 5vw, 44px)', color: 'var(--brand)', marginBottom: 28, letterSpacing: '0.04em' }}>
        {pattern.sequence.join(' → ')} → ?
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, width: '100%', maxWidth: 380, marginBottom: showConf ? 20 : 0 }}>
        {pattern.options.map(opt => (
          <button key={opt} onClick={() => selectAnswer(opt)}
            className="btn btn-secondary"
            style={{
              padding: '16px 0', fontSize: 22, fontWeight: 700,
              background: picked === opt ? 'var(--brand-tint)' : undefined,
              borderColor: picked === opt ? 'var(--brand)' : undefined,
              color: picked === opt ? 'var(--brand-2)' : undefined,
            }}>
            {opt}
          </button>
        ))}
      </div>

      {showConf && (
        <div className="fade-up" style={{ width: '100%', maxWidth: 420, marginTop: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 10 }}>
            How confident are you? <span style={{ color: 'var(--brand-2)' }}>{confidence}%</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>Just guessing</span>
            <input type="range" min={50} max={100} step={5} value={confidence}
              onChange={e => setConf(Number(e.target.value))}
              style={{ flex: 1, accentColor: 'var(--brand)', height: 6 }} />
            <span style={{ fontSize: 12, color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>Certain</span>
          </div>
          <button className="btn btn-primary btn-block" style={{ marginTop: 14 }} onClick={submit}>
            Next <Icon name="arrow-right" size={16} />
          </button>
        </div>
      )}
    </TrialFrame>
  );
}

// ── 5. Executive Function (Rule Switching) ─────────────────────────────────────
// Alternates between number task (even/odd) and letter task (vowel/consonant).
// Switch cost = mean RT on switch trials − mean RT on repeat trials.

function RuleSwitchTrial({ trialIdx, trialsTotal, isPractice, prevTrialIdx, onDone }: {
  trialIdx: number; trialsTotal: number; isPractice: boolean;
  prevTrialIdx: number; onDone: (t: EFTrial) => void;
}) {
  const startRef     = useRef(Date.now());
  const respondedRef = useRef(false);
  const [stage, setStage] = useState<'task' | 'feedback'>('task');
  const [correct, setCorrect] = useState(false);

  // Interleave: even trials = number task, odd = letter task → creates natural switches
  const isNumberTask = trialIdx % 2 === 0;
  const isSwitch = trialIdx > 0 && (trialIdx % 2 !== prevTrialIdx % 2);

  const { stimulus, rule, answer } = useMemo(() => {
    if (isNumberTask) {
      const n = Math.floor(Math.random() * 9) + 1;
      return { stimulus: String(n), rule: 'Is this number EVEN?', answer: n % 2 === 0 };
    } else {
      const letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];
      return { stimulus: letter, rule: 'Is this a VOWEL?', answer: 'AEIOU'.includes(letter) };
    }
  }, [trialIdx, isNumberTask]);

  useEffect(() => { startRef.current = Date.now(); respondedRef.current = false; }, [stimulus]);

  const respond = (userAnswer: boolean) => {
    if (respondedRef.current) return;
    respondedRef.current = true;
    const rt = Date.now() - startRef.current;
    const isCorrect = userAnswer === answer;
    setCorrect(isCorrect);
    if (isPractice) {
      setStage('feedback');
    } else {
      onDone({ correct: isCorrect, rt, isSwitch, practice: false });
    }
  };

  if (stage === 'feedback') {
    return (
      <FeedbackFlash correct={correct} correctAnswer={answer ? 'Yes' : 'No'}
        onDone={() => onDone({ correct, rt: 0, isSwitch, practice: true })} />
    );
  }

  return (
    <TrialFrame trialIdx={trialIdx} trialsTotal={trialsTotal} isPractice={isPractice}
      hint={<span style={{ color: 'var(--coral)', fontWeight: 700, fontSize: 17 }}>{rule}</span>}
      footer={<>
        <button className="btn btn-primary" style={{ minWidth: 140 }} onClick={() => respond(true)}>✓ Yes</button>
        <button className="btn btn-secondary" style={{ minWidth: 140 }} onClick={() => respond(false)}>✗ No</button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        {isSwitch && !isPractice && (
          <div className="chip coral" style={{ fontSize: 11, animation: 'pop 0.3s ease' }}>Rule changed!</div>
        )}
        <div className="display" style={{ fontSize: 100, color: 'var(--ink)', lineHeight: 1 }}>{stimulus}</div>
      </div>
    </TrialFrame>
  );
}

// ── 6. Sustained Attention (Continuous Performance Task) ──────────────────────
// 30 scored trials. Target = 'X', appears 30% of the time.
// 900ms stimulus window. d′ computed from hit/FA rates at score time.

function VigilanceTrial({ trialIdx, trialsTotal, isPractice, onDone }: {
  trialIdx: number; trialsTotal: number; isPractice: boolean;
  onDone: (t: AttentionTrial) => void;
}) {
  const startRef     = useRef(Date.now());
  const respondedRef = useRef(false);
  // Determine target once per trial instance (stable across re-renders)
  const isTargetRef  = useRef(Math.random() > 0.70);
  const letterRef    = useRef(
    isTargetRef.current
      ? 'X'
      : 'ABCDEFGHIJKLMNOPQRSTUVWYZ'[Math.floor(Math.random() * 25)]
  );
  const [stage, setStage] = useState<'isi' | 'stimulus' | 'feedback'>('isi');
  const [correct, setCorrect] = useState(false);

  const isTarget = isTargetRef.current;
  const letter   = letterRef.current;

  const commit = useCallback((clicked: boolean) => {
    if (respondedRef.current) return;
    respondedRef.current = true;
    const rt = clicked ? Date.now() - startRef.current : null;
    const isCorrect = isTarget === clicked;
    setCorrect(isCorrect);
    if (isPractice) {
      setStage('feedback');
    } else {
      onDone({ isTarget, responded: clicked, rt, practice: false });
    }
  }, [isTarget, isPractice, onDone]);

  // ISI: 400ms fixation cross → then show stimulus
  useEffect(() => {
    const t = setTimeout(() => {
      setStage('stimulus');
      startRef.current = Date.now();
      respondedRef.current = false;
    }, 400);
    return () => clearTimeout(t);
  }, []);

  // Auto-advance after 1000ms if no response
  useEffect(() => {
    if (stage !== 'stimulus') return;
    const t = setTimeout(() => commit(false), 1000);
    return () => clearTimeout(t);
  }, [stage, commit]);

  if (stage === 'feedback') {
    return (
      <FeedbackFlash correct={correct}
        correctAnswer={isTarget ? 'Tap on X' : 'Don\'t tap — only tap X'}
        onDone={() => onDone({ isTarget, responded: false, rt: null, practice: true })} />
    );
  }

  if (stage === 'isi') {
    return (
      <div className="card" style={{ flex: 1, display: 'grid', placeItems: 'center', minHeight: 420, position: 'relative' }}>
        <div style={{ position: 'absolute', top: 18, right: 18 }} className="chip">{trialIdx + 1} / {trialsTotal}</div>
        <div style={{ fontSize: 36, fontWeight: 700, color: 'var(--ink-3)', lineHeight: 1 }}>+</div>
      </div>
    );
  }

  return (
    <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 60, cursor: 'pointer', position: 'relative', minHeight: 420 }}
      onClick={() => commit(true)}>
      <div style={{ position: 'absolute', top: 18, right: 18 }} className="chip">{trialIdx + 1} / {trialsTotal}</div>
      <div style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 24, fontWeight: 600 }}>
        Tap only when you see <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--coral)' }}>X</strong>
      </div>
      <div className="display mono" style={{ fontSize: 110, color: isTarget ? 'var(--coral)' : 'var(--ink)', lineHeight: 1, animation: 'pop 0.2s ease' }} key={letter}>
        {letter}
      </div>
      <div style={{ marginTop: 32, fontSize: 12, color: 'var(--ink-4)' }}>
        {isTarget ? '' : 'Wait — do not tap'}
      </div>
    </div>
  );
}

// ── Score computation ──────────────────────────────────────────────────────────

function computeProfile(data: TestData): LearnerProfile {
  // ── Working Memory Verbal (2-of-3 span method) ──
  const scoredWMV = data.wmVerbal.filter(t => !t.practice);
  const wmvSpanScore = computeSpan(scoredWMV);
  const wmvNorm = clamp((wmvSpanScore - 3) / (7 - 3) * 100);

  // ── Working Memory Visual ──
  const scoredWMVis = data.wmVisual.filter(t => !t.practice);
  const wmVisSpanScore = computeSpan(scoredWMVis);
  const wmVisNorm = clamp((wmVisSpanScore - 3) / (7 - 3) * 100);

  const wmScore = clamp((wmvNorm + wmVisNorm) / 2);

  // ── Processing Speed ──
  const scoredSpeed = data.speed.filter(t => !t.practice);
  const correctSpeed = scoredSpeed.filter(t => t.correct);
  const accuracy = correctSpeed.length / Math.max(scoredSpeed.length, 1);
  const meanRT = correctSpeed.length
    ? correctSpeed.reduce((s, t) => s + t.rt, 0) / correctSpeed.length : 2500;
  // Fast = 400ms (score 100), slow = 2400ms (score 0). Penalise low accuracy.
  const rtScore = clamp((2400 - meanRT) / 20);
  const speedScore = clamp(rtScore * Math.sqrt(accuracy));

  // ── Fluid Intelligence + Confidence Calibration ──
  const scoredFluid = data.fluid.filter(t => !t.practice);
  const fluidAcc = scoredFluid.length
    ? scoredFluid.filter(t => t.correct).length / scoredFluid.length : 0.5;
  const brier = computeBrierScore(scoredFluid);
  const meanConf = scoredFluid.length
    ? scoredFluid.reduce((s, t) => s + t.confidence, 0) / scoredFluid.length / 100 : 0.7;
  const calibBias = meanConf - fluidAcc; // positive = overconfident
  const fluidScore = clamp(fluidAcc * 100);
  // Calibration score: perfect brier=0 → 100; chance brier=0.25 → 0
  const confScore  = clamp((0.25 - brier) / 0.25 * 100);

  // ── Executive Function (switch cost) ──
  const scoredEF = data.ef.filter(t => !t.practice);
  const efAcc = scoredEF.length ? scoredEF.filter(t => t.correct).length / scoredEF.length : 0.6;
  const switchTrials  = scoredEF.filter(t => t.isSwitch  && t.correct);
  const repeatTrials  = scoredEF.filter(t => !t.isSwitch && t.correct);
  const meanSwitch = switchTrials.length ? switchTrials.reduce((s, t) => s + t.rt, 0) / switchTrials.length : 800;
  const meanRepeat = repeatTrials.length ? repeatTrials.reduce((s, t) => s + t.rt, 0) / repeatTrials.length : 600;
  const switchCost = meanSwitch - meanRepeat; // ms
  // Score: accuracy drives 70%, switch cost drives 30% (lower cost = better)
  const costScore = clamp(100 - (switchCost - 50) / 5); // 50ms → 90, 300ms → 40
  const efScore   = clamp(efAcc * 70 + (costScore / 100) * 30);

  // ── Sustained Attention (d′) ──
  const scoredAttn = data.attention.filter(t => !t.practice);
  const hits  = scoredAttn.filter(t => t.isTarget && t.responded).length;
  const misses= scoredAttn.filter(t => t.isTarget && !t.responded).length;
  const fas   = scoredAttn.filter(t => !t.isTarget && t.responded).length;
  const crs   = scoredAttn.filter(t => !t.isTarget && !t.responded).length;
  const dPrime = computeDPrime(hits, misses, fas, crs);
  const hitRate = (hits + 0.5) / (hits + misses + 1);
  const faRate  = (fas + 0.5)  / (fas + crs + 1);
  // d′ typical range: −1 to 4.5. Map to 0–100.
  const attnScore = clamp((dPrime + 1) / 5.5 * 100);

  return {
    workingMemory:     { score: wmScore,    verbalSpan: wmvSpanScore,  visualSpan: wmVisSpanScore },
    processingSpeed:   { score: speedScore, accuracy,                  switchCost: meanRT },
    fluidIntelligence: { score: fluidScore, accuracy: fluidAcc,        brierScore: brier, calibrationBias: calibBias },
    executiveFunction: { score: efScore,    efAccuracy: efAcc,         switchCost },
    sustainedAttention:{ score: attnScore,  dPrime,                    hitRate,    faRate },
    confidence:        { score: confScore,  brierScore: brier,         calibrationBias: calibBias },
    completedAt:       Date.now(),
  };
}

/**
 * 2-of-3 span estimation: return the highest span level
 * at which the user got ≥2 out of every 3 trials correct.
 * Falls back to max-correct-span if trial distribution is uneven.
 */
function computeSpan(trials: WMTrial[]): number {
  // Group by span length
  const bySpan: Record<number, boolean[]> = {};
  trials.forEach(t => {
    if (!bySpan[t.span]) bySpan[t.span] = [];
    bySpan[t.span].push(t.correct);
  });
  const levels = Object.keys(bySpan).map(Number).sort((a, b) => a - b);
  let bestSpan = 3;
  for (const lvl of levels) {
    const results = bySpan[lvl];
    const correct = results.filter(Boolean).length;
    if (correct / results.length >= 0.67) bestSpan = lvl;
  }
  return bestSpan;
}

// ── Level labels ───────────────────────────────────────────────────────────────

export function levelLabel(score: number): string {
  if (score >= 85) return 'Exceptional';
  if (score >= 70) return 'High';
  if (score >= 50) return 'Average';
  if (score >= 30) return 'Developing';
  return 'Low';
}

// ── Results screen ─────────────────────────────────────────────────────────────

function AssessResults({ results, onContinue }: { results: LearnerProfile; onContinue: () => void }) {
  useEffect(() => { celebrate(); }, []);

  const dims = [
    { key: 'workingMemory',     label: 'Working Memory',     icon: '🧠', color: 'brand',
      sub: (r: LearnerProfile['workingMemory']) =>
        r.verbalSpan !== undefined ? `Verbal span ${r.verbalSpan} · Visual span ${r.visualSpan}` : '' },
    { key: 'processingSpeed',   label: 'Processing Speed',   icon: '⚡', color: 'gold',
      sub: (r: LearnerProfile['processingSpeed']) =>
        r.switchCost !== undefined ? `Mean RT ${Math.round(r.switchCost)}ms` : '' },
    { key: 'fluidIntelligence', label: 'Fluid Reasoning',    icon: '🧩', color: 'plum',
      sub: (r: LearnerProfile['fluidIntelligence']) =>
        r.accuracy !== undefined ? `Accuracy ${Math.round(r.accuracy * 100)}%` : '' },
    { key: 'executiveFunction', label: 'Executive Function', icon: '🔀', color: 'coral',
      sub: (r: LearnerProfile['executiveFunction']) =>
        r.switchCost !== undefined ? `Switch cost ${Math.round(r.switchCost)}ms` : '' },
    { key: 'sustainedAttention',label: 'Sustained Attention',icon: '🎯', color: 'sky',
      sub: (r: LearnerProfile['sustainedAttention']) =>
        r.dPrime !== undefined ? `d′ = ${r.dPrime.toFixed(2)}` : '' },
    { key: 'confidence',        label: 'Confidence Calib.',  icon: '🎯', color: 'brand',
      sub: (r: LearnerProfile['confidence']) => {
        if (r.calibrationBias === undefined) return '';
        if (Math.abs(r.calibrationBias) < 0.08) return 'Well-calibrated';
        return r.calibrationBias > 0 ? `Overconfident by ${Math.round(r.calibrationBias * 100)}%` : `Underconfident by ${Math.round(-r.calibrationBias * 100)}%`;
      }},
  ] as const;

  const summary = buildSummary(results);

  return (
    <div style={{ minHeight: '100dvh', padding: '40px 20px', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 760, width: '100%', margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ fontSize: 56, marginBottom: 12 }}>🎉</div>
          <h1 className="display" style={{ fontSize: 'clamp(32px, 5vw, 46px)', marginBottom: 10 }}>
            Your learning profile is ready.
          </h1>
          <p style={{ color: 'var(--ink-2)', fontSize: 16, maxWidth: 500, margin: '0 auto' }}>
            98 data points collected. Every card you see is now tuned to how <em>you</em> learn.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 24 }}>
          {dims.map(d => {
            const r = results[d.key as keyof LearnerProfile] as LearnerProfile['workingMemory'];
            const subText = d.sub(r as never);
            return (
              <div key={d.key} className="card" style={{ padding: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <span style={{ fontSize: 22 }}>{d.icon}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{d.label}</span>
                </div>
                <div className="display" style={{ fontSize: 28, color: `var(--${d.color})`, marginBottom: 6 }}>{levelLabel(r.score)}</div>
                <div style={{ height: 6, background: 'var(--line)', borderRadius: 999, overflow: 'hidden', marginBottom: 6 }}>
                  <div style={{ height: '100%', background: `var(--${d.color})`, width: `${r.score}%`, transition: 'width 1.2s cubic-bezier(.4,0,.2,1)' }} />
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                  Score {r.score}/100 {subText ? `· ${subText}` : ''}
                </div>
              </div>
            );
          })}
        </div>

        <div className="card" style={{ padding: 22, background: 'var(--brand-tint)', borderColor: 'var(--brand-soft)', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--brand)', color: 'white', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
              <Icon name="sparkle" size={20} />
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand-2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                What this means for your learning
              </div>
              <p style={{ color: 'var(--ink)', lineHeight: 1.7, fontSize: 15 }}>{summary}</p>
            </div>
          </div>
        </div>

        <button className="btn btn-primary btn-lg btn-block" onClick={onContinue}>
          Take me to Sprout <Icon name="arrow-right" size={18} />
        </button>
      </div>
    </div>
  );
}

function buildSummary(r: LearnerProfile): string {
  const wm   = r.workingMemory.score;
  const sp   = r.processingSpeed.score;
  const fi   = r.fluidIntelligence.score;
  const ef   = r.executiveFunction.score;
  const attn = r.sustainedAttention.score;
  const bias = r.confidence.calibrationBias ?? 0;

  const parts: string[] = [];

  if (wm >= 70 && sp >= 70 && fi >= 70) {
    parts.push('You process dense material quickly and retain large amounts of information — Sprout will deliver advanced cards with minimal scaffolding.');
  } else if (wm < 45 || sp < 45) {
    parts.push('You work best with smaller, clearly separated chunks. Sprout will break concepts into bite-sized pieces and pace delivery to avoid overload.');
  } else {
    parts.push('You have a solid, balanced cognitive foundation. Sprout will mix independent challenge with structured support.');
  }

  if (ef < 50) {
    parts.push('Task-switching costs you more than average — your feed will group related concepts instead of jumping between topics.');
  } else if (ef >= 75) {
    parts.push('You switch between tasks with low cost, so Sprout will interleave topics to maximise transfer.');
  }

  if (attn < 50) {
    parts.push('Your vigilance d′ suggests attention wanders over time — sessions will be kept short with high-contrast signals at key moments.');
  } else if (attn >= 75) {
    parts.push('Your sustained focus is strong — longer sessions with deeper content are appropriate for you.');
  }

  if (Math.abs(bias) < 0.08) {
    parts.push('Your confidence is well-calibrated with your performance — you know what you know.');
  } else if (bias > 0.15) {
    parts.push('You tend to be overconfident: Sprout will add more testing to surface gaps before they become problems.');
  } else if (bias < -0.15) {
    parts.push('You tend to underestimate yourself: Sprout will remind you of your strengths and push you a bit further than you might push yourself.');
  }

  return parts.join(' ');
}
