/**
 * ActivitySequence — reorder shuffled steps into the correct sequence.
 * ↑ / ↓ buttons move items up or down in the list.
 * "Check Order" reveals which are in the right position.
 */
import { useMemo, useState } from 'react';
import type { SequenceActivity } from '../lib/gemini';

interface Props {
  activity:   SequenceActivity;
  onComplete: (score: number, total: number) => void;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  // Re-shuffle if accidentally already sorted
  const original = arr.map((_, i) => i);
  const isSorted = a.every((v, i) => v === original[i]);
  return isSorted ? shuffle(arr) : a;
}

export function ActivitySequence({ activity, onComplete }: Props) {
  const { steps } = activity;

  // Each element = original index into `steps`
  const initial = useMemo(() => shuffle(steps.map((_, i) => i)), [steps]);
  const [order,   setOrder]   = useState<number[]>(initial);
  const [checked, setChecked] = useState(false);
  const [done,    setDone]    = useState(false);

  const moveUp   = (i: number) => { if (i === 0 || checked) return; const a = [...order]; [a[i-1], a[i]] = [a[i], a[i-1]]; setOrder(a); };
  const moveDown = (i: number) => { if (i === order.length - 1 || checked) return; const a = [...order]; [a[i], a[i+1]] = [a[i+1], a[i]]; setOrder(a); };

  const correctCount = order.filter((orig, pos) => orig === pos).length;

  const handleCheck = () => setChecked(true);
  const handleDone  = () => { setDone(true); onComplete(correctCount, steps.length); };

  if (done) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32, textAlign: 'center' }}>
      <div style={{ fontSize: 52 }}>{correctCount === steps.length ? '🏆' : correctCount >= steps.length * 0.7 ? '👍' : '💪'}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)' }}>{correctCount} / {steps.length} in order</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      <div style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5 }}>
        Use ↑ ↓ to put the steps in the correct order.
      </div>

      {/* Step list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {order.map((origIdx, pos) => {
          const isCorrect = checked && origIdx === pos;
          const isWrong   = checked && origIdx !== pos;

          return (
            <div
              key={origIdx}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '11px 13px', borderRadius: 12,
                background: isCorrect ? '#DCFCE7' : isWrong ? '#FEE2E2' : 'var(--card)',
                border: `1.5px solid ${isCorrect ? '#16A34A' : isWrong ? '#EF4444' : 'var(--line)'}`,
                transition: 'all 0.2s',
              }}>

              {/* Step number */}
              <div style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                background: isCorrect ? '#16A34A' : isWrong ? '#EF4444' : 'var(--bg-tint)',
                color: (isCorrect || isWrong) ? 'white' : 'var(--ink-3)',
                display: 'grid', placeItems: 'center',
                fontSize: 12, fontWeight: 800,
              }}>
                {pos + 1}
              </div>

              {/* Step text */}
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--ink)', lineHeight: 1.4 }}>
                {steps[origIdx]}
              </span>

              {/* Correct position hint */}
              {isWrong && (
                <span style={{ fontSize: 10, color: '#EF4444', fontWeight: 700, flexShrink: 0 }}>
                  → #{origIdx + 1}
                </span>
              )}

              {/* Up / Down arrows */}
              {!checked && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
                  <button
                    onClick={() => moveUp(pos)}
                    disabled={pos === 0}
                    style={{ background: 'none', border: 'none', cursor: pos === 0 ? 'default' : 'pointer', opacity: pos === 0 ? 0.25 : 0.7, fontSize: 13, lineHeight: 1, padding: '2px 4px' }}>
                    ↑
                  </button>
                  <button
                    onClick={() => moveDown(pos)}
                    disabled={pos === order.length - 1}
                    style={{ background: 'none', border: 'none', cursor: pos === order.length - 1 ? 'default' : 'pointer', opacity: pos === order.length - 1 ? 0.25 : 0.7, fontSize: 13, lineHeight: 1, padding: '2px 4px' }}>
                    ↓
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Action */}
      {!checked ? (
        <button
          onClick={handleCheck}
          style={{ padding: '13px 24px', borderRadius: 12, background: 'var(--brand)', color: 'white', border: 'none', fontSize: 15, fontWeight: 800, cursor: 'pointer', marginTop: 4 }}>
          Check Order
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ textAlign: 'center', padding: '14px', borderRadius: 12, background: correctCount === steps.length ? '#DCFCE7' : '#FEF9C3' }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: correctCount === steps.length ? '#16A34A' : '#92400E' }}>
              {correctCount === steps.length ? '🎯 Perfect order!' : `${correctCount} / ${steps.length} correct positions`}
            </div>
          </div>
          <button
            onClick={handleDone}
            style={{ padding: '13px 24px', borderRadius: 12, background: 'var(--brand)', color: 'white', border: 'none', fontSize: 15, fontWeight: 800, cursor: 'pointer' }}>
            Continue →
          </button>
        </div>
      )}
    </div>
  );
}
