/**
 * ActivitySortClassify — tap an item to select it, tap a bucket to assign it.
 * When all items are assigned, "Check" reveals score.
 */
import { useMemo, useState } from 'react';
import type { SortClassifyActivity } from '../lib/gemini';

interface Props {
  activity:   SortClassifyActivity;
  onComplete: (score: number, total: number) => void;
}

const BUCKET_COLORS = ['#6366F1', '#0EA5E9', '#16A34A', '#F59E0B'];
const BUCKET_TINTS  = ['#EEF2FF', '#E0F2FE', '#DCFCE7', '#FEF9C3'];

export function ActivitySortClassify({ activity, onComplete }: Props) {
  const { categories, items } = activity;

  // Shuffle items once on mount
  const shuffled = useMemo(() => {
    const arr = items.map((item, i) => ({ ...item, idx: i }));
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }, [items]);

  // assignments: item.idx → category name (or null = unassigned)
  const [assignments, setAssignments] = useState<Record<number, string>>({});
  const [selectedIdx,  setSelectedIdx]  = useState<number | null>(null);
  const [checked,      setChecked]      = useState(false);
  const [score,        setScore]        = useState(0);
  const [done,         setDone]         = useState(false);

  const unassigned = shuffled.filter(item => assignments[item.idx] === undefined);
  const allAssigned = unassigned.length === 0;

  const selectItem = (idx: number) => {
    if (checked) return;
    setSelectedIdx(prev => prev === idx ? null : idx);
  };

  const assignToBucket = (cat: string) => {
    if (checked || selectedIdx === null) return;
    setAssignments(prev => ({ ...prev, [selectedIdx]: cat }));
    setSelectedIdx(null);
  };

  const checkAnswers = () => {
    let correct = 0;
    shuffled.forEach(item => {
      if (assignments[item.idx] === item.category) correct++;
    });
    setScore(correct);
    setChecked(true);
  };

  const handleDone = () => {
    setDone(true);
    onComplete(score, shuffled.length);
  };

  if (done) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32, textAlign: 'center' }}>
      <div style={{ fontSize: 52 }}>{score === shuffled.length ? '🎯' : score >= shuffled.length * 0.7 ? '👍' : '💪'}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)' }}>{score} / {shuffled.length} correct</div>
      <div style={{ fontSize: 14, color: 'var(--ink-3)' }}>
        {score === shuffled.length ? 'Perfect sort!' : score >= shuffled.length * 0.7 ? 'Great work!' : 'Keep practising!'}
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Unassigned items pool */}
      {!checked && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-3)', marginBottom: 8 }}>
            Tap an item, then tap a bucket ↓
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, minHeight: 44 }}>
            {unassigned.map(item => (
              <button
                key={item.idx}
                onClick={() => selectItem(item.idx)}
                style={{
                  padding: '7px 13px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                  background: selectedIdx === item.idx ? 'var(--brand)' : 'var(--bg-tint)',
                  color:      selectedIdx === item.idx ? 'white'       : 'var(--ink)',
                  border: `1.5px solid ${selectedIdx === item.idx ? 'var(--brand)' : 'var(--line)'}`,
                  cursor: 'pointer', transition: 'all 0.15s',
                }}>
                {item.label}
              </button>
            ))}
            {unassigned.length === 0 && (
              <span style={{ fontSize: 13, color: 'var(--ink-4)', fontStyle: 'italic' }}>All items placed!</span>
            )}
          </div>
        </div>
      )}

      {/* Buckets */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {categories.map((cat, ci) => {
          const color = BUCKET_COLORS[ci % BUCKET_COLORS.length];
          const tint  = BUCKET_TINTS[ci % BUCKET_TINTS.length];
          const inBucket = shuffled.filter(item => assignments[item.idx] === cat);

          return (
            <button
              key={cat}
              onClick={() => assignToBucket(cat)}
              disabled={checked}
              style={{
                width: '100%', textAlign: 'left',
                borderRadius: 14, border: `2px solid ${selectedIdx !== null && !checked ? color : 'var(--line)'}`,
                background: tint, padding: '12px 14px', cursor: checked ? 'default' : 'pointer',
                transition: 'all 0.15s',
                transform: selectedIdx !== null && !checked ? 'scale(1.01)' : 'scale(1)',
              }}>
              <div style={{ fontSize: 12, fontWeight: 800, color, marginBottom: inBucket.length > 0 ? 8 : 0, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {cat}
              </div>
              {inBucket.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {inBucket.map(item => {
                    const isCorrect = item.category === cat;
                    return (
                      <span
                        key={item.idx}
                        onClick={e => { if (!checked) { e.stopPropagation(); setAssignments(prev => { const n = {...prev}; delete n[item.idx]; return n; }); }}}
                        style={{
                          padding: '5px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                          background: checked ? (isCorrect ? '#DCFCE7' : '#FEE2E2') : 'white',
                          color:      checked ? (isCorrect ? '#16A34A' : '#DC2626') : 'var(--ink)',
                          border:     checked ? `1.5px solid ${isCorrect ? '#16A34A' : '#EF4444'}` : '1.5px solid var(--line)',
                          cursor:     checked ? 'default' : 'pointer',
                        }}>
                        {item.label}
                        {checked && !isCorrect && (
                          <span style={{ fontSize: 10, opacity: 0.75, marginLeft: 4 }}>→ {item.category}</span>
                        )}
                      </span>
                    );
                  })}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Action button */}
      {!checked ? (
        allAssigned && (
          <button
            onClick={checkAnswers}
            style={{ padding: '13px 24px', borderRadius: 12, background: 'var(--brand)', color: 'white', border: 'none', fontSize: 15, fontWeight: 800, cursor: 'pointer' }}>
            Check Answers
          </button>
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ textAlign: 'center', padding: '14px', borderRadius: 12, background: score === shuffled.length ? '#DCFCE7' : '#FEF9C3', border: `1px solid ${score === shuffled.length ? '#16A34A' : '#D97706'}` }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: score === shuffled.length ? '#16A34A' : '#92400E' }}>
              {score} / {shuffled.length} correct
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
