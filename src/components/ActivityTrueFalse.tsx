/**
 * ActivityTrueFalse — rapid-fire true/false speed round.
 * One statement at a time; tap TRUE or FALSE to answer.
 * Result + explanation shown briefly before auto-advancing.
 */
import { useEffect, useState } from 'react';
import type { TrueFalseActivity } from '../lib/gemini';

interface Props {
  activity:   TrueFalseActivity;
  onComplete: (score: number, total: number) => void;
}

export function ActivityTrueFalse({ activity, onComplete }: Props) {
  const { statements } = activity;

  const [idx,      setIdx]      = useState(0);
  const [answered, setAnswered] = useState<Record<number, boolean>>({});
  const [showing,  setShowing]  = useState(false); // showing result before advance
  const [done,     setDone]     = useState(false);

  const current  = statements[idx];
  const total    = statements.length;
  const score    = Object.entries(answered).filter(([i, ans]) => ans === statements[Number(i)].answer).length;

  const answer = (guess: boolean) => {
    if (showing || answered[idx] !== undefined) return;
    setAnswered(prev => ({ ...prev, [idx]: guess }));
    setShowing(true);
  };

  // Auto-advance after showing result
  useEffect(() => {
    if (!showing) return;
    const t = setTimeout(() => {
      setShowing(false);
      if (idx + 1 >= total) {
        setDone(true);
        onComplete(score + (answered[idx] === statements[idx].answer ? 1 : 0), total);
      } else {
        setIdx(i => i + 1);
      }
    }, 1800);
    return () => clearTimeout(t);
  }, [showing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (done) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32, textAlign: 'center' }}>
      <div style={{ fontSize: 52 }}>{score >= total * 0.8 ? '⚡' : score >= total * 0.6 ? '👍' : '💪'}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)' }}>{score} / {total} correct</div>
      <div style={{ fontSize: 14, color: 'var(--ink-3)' }}>
        {score === total ? 'Flawless!' : score >= total * 0.8 ? 'Sharp recall!' : score >= total * 0.6 ? 'Good effort!' : 'Review and retry!'}
      </div>
    </div>
  );

  const userAnswer    = answered[idx];
  const hasAnswered   = userAnswer !== undefined;
  const isCorrect     = hasAnswered && userAnswer === current.answer;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Progress */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, height: 5, background: 'var(--line)', borderRadius: 99, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(idx / total) * 100}%`, background: 'var(--brand)', borderRadius: 99, transition: 'width 0.3s' }} />
        </div>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-3)', flexShrink: 0 }}>{idx + 1} / {total}</span>
      </div>

      {/* Statement card */}
      <div style={{
        minHeight: 120, borderRadius: 16, padding: '22px 20px',
        background: hasAnswered
          ? (isCorrect ? '#DCFCE7' : '#FEE2E2')
          : 'var(--card)',
        border: `2px solid ${hasAnswered ? (isCorrect ? '#16A34A' : '#EF4444') : 'var(--line)'}`,
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10,
        transition: 'all 0.2s',
      }}>
        <p style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--ink)', lineHeight: 1.5, textAlign: 'center' }}>
          {current.text}
        </p>
        {hasAnswered && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: isCorrect ? '#16A34A' : '#DC2626', textAlign: 'center' }}>
              {isCorrect ? '✓ Correct' : `✗ ${current.answer ? 'This is TRUE' : 'This is FALSE'}`}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', textAlign: 'center', lineHeight: 1.5 }}>
              {current.explanation}
            </div>
          </div>
        )}
      </div>

      {/* Answer buttons */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <button
          onClick={() => answer(true)}
          disabled={hasAnswered}
          style={{
            padding: '16px', borderRadius: 14, border: 'none',
            background: hasAnswered && !isCorrect && !current.answer ? '#FEE2E2'
              : hasAnswered && current.answer ? '#DCFCE7'
              : '#DCFCE7',
            color: '#16A34A', fontSize: 18, fontWeight: 800,
            cursor: hasAnswered ? 'default' : 'pointer',
            opacity: hasAnswered ? 0.7 : 1,
            transition: 'all 0.15s',
          }}>
          ✓ TRUE
        </button>
        <button
          onClick={() => answer(false)}
          disabled={hasAnswered}
          style={{
            padding: '16px', borderRadius: 14, border: 'none',
            background: '#FEE2E2',
            color: '#DC2626', fontSize: 18, fontWeight: 800,
            cursor: hasAnswered ? 'default' : 'pointer',
            opacity: hasAnswered ? 0.7 : 1,
            transition: 'all 0.15s',
          }}>
          ✗ FALSE
        </button>
      </div>

      {/* Running score */}
      <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--ink-4)', fontWeight: 600 }}>
        Score: {score} correct so far
      </div>
    </div>
  );
}
