/**
 * ActivityMemoryMatch — connect terms to definitions.
 * Terms column on the left, shuffled definitions on the right.
 * Tap a term to select it, then tap the matching definition.
 * Matched pairs lock green; wrong pairs shake red then reset.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryMatchActivity } from '../lib/gemini';

interface Props {
  activity:   MemoryMatchActivity;
  onComplete: (score: number, total: number) => void;
}

export function ActivityMemoryMatch({ activity, onComplete }: Props) {
  const total = activity.pairs.length;

  // Shuffled definition indices (index into activity.pairs)
  const defOrder = useMemo(() => {
    const arr = activity.pairs.map((_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }, [activity]);

  const [selectedTerm, setSelectedTerm] = useState<number | null>(null); // pair index
  const [matched,      setMatched]      = useState<Set<number>>(new Set()); // pair indices
  const [wrong,        setWrong]        = useState<{ term: number; def: number } | null>(null);
  const [moves,        setMoves]        = useState(0);
  const [done,         setDone]         = useState(false);
  const lockRef = useRef(false);

  const tapTerm = (pairIdx: number) => {
    if (lockRef.current || matched.has(pairIdx)) return;
    setSelectedTerm(prev => prev === pairIdx ? null : pairIdx);
    setWrong(null);
  };

  const tapDef = (pairIdx: number) => {
    if (lockRef.current || matched.has(pairIdx)) return;
    if (selectedTerm === null) return; // must pick a term first

    setMoves(m => m + 1);

    if (selectedTerm === pairIdx) {
      // ✅ Correct
      const newMatched = new Set([...matched, pairIdx]);
      setMatched(newMatched);
      setSelectedTerm(null);
      if (newMatched.size === total) setTimeout(() => setDone(true), 400);
    } else {
      // ❌ Wrong
      lockRef.current = true;
      setWrong({ term: selectedTerm, def: pairIdx });
      setTimeout(() => {
        setWrong(null);
        setSelectedTerm(null);
        lockRef.current = false;
      }, 800);
    }
  };

  useEffect(() => {
    if (done) onComplete(total, total);
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps

  const matchedCount = matched.size;

  if (done) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32, textAlign: 'center' }}>
      <div style={{ fontSize: 52 }}>🎉</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)' }}>All matched!</div>
      <div style={{ fontSize: 15, color: 'var(--ink-2)' }}>{total} pairs · {moves} moves</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Instructions + progress */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>
          {selectedTerm === null ? 'Tap a term on the left to select it' : 'Now tap the matching definition →'}
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-3)' }}>{matchedCount}/{total}</span>
      </div>

      {/* Progress bar */}
      <div style={{ height: 4, background: 'var(--line)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${(matchedCount / total) * 100}%`, background: 'var(--brand)', borderRadius: 99, transition: 'width 0.3s' }} />
      </div>

      {/* Two-column grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>

        {/* Terms column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-4)', textAlign: 'center', marginBottom: 2 }}>
            Terms
          </div>
          {activity.pairs.map((pair, i) => {
            const isMatched  = matched.has(i);
            const isSelected = selectedTerm === i;
            const isWrongTerm = wrong?.term === i;
            return (
              <button
                key={i}
                onClick={() => tapTerm(i)}
                disabled={isMatched}
                style={{
                  padding: '10px 10px',
                  borderRadius: 10,
                  border: `2px solid ${isMatched ? '#16A34A' : isSelected ? 'var(--brand)' : isWrongTerm ? '#EF4444' : 'var(--line)'}`,
                  background: isMatched ? '#DCFCE7' : isSelected ? 'var(--brand-tint)' : isWrongTerm ? '#FEE2E2' : 'var(--card)',
                  cursor: isMatched ? 'default' : 'pointer',
                  fontSize: 12, fontWeight: 700,
                  color: isMatched ? '#16A34A' : isSelected ? 'var(--brand)' : 'var(--ink)',
                  textAlign: 'left', lineHeight: 1.4,
                  transition: 'all 0.15s',
                  animation: isWrongTerm ? 'shake 0.4s' : undefined,
                  minHeight: 52,
                  display: 'flex', alignItems: 'center',
                }}>
                {isMatched && <span style={{ marginRight: 5, fontSize: 13 }}>✓</span>}
                {pair.term}
              </button>
            );
          })}
        </div>

        {/* Definitions column (shuffled) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-4)', textAlign: 'center', marginBottom: 2 }}>
            Definitions
          </div>
          {defOrder.map((pairIdx) => {
            const isMatched  = matched.has(pairIdx);
            const isWrongDef = wrong?.def === pairIdx;
            const isActive   = selectedTerm !== null && !isMatched;
            return (
              <button
                key={pairIdx}
                onClick={() => tapDef(pairIdx)}
                disabled={isMatched || selectedTerm === null}
                style={{
                  padding: '10px 10px',
                  borderRadius: 10,
                  border: `2px solid ${isMatched ? '#16A34A' : isWrongDef ? '#EF4444' : isActive ? 'var(--line-2)' : 'var(--line)'}`,
                  background: isMatched ? '#DCFCE7' : isWrongDef ? '#FEE2E2' : isActive ? 'var(--card)' : 'var(--bg-tint)',
                  cursor: isMatched || selectedTerm === null ? 'default' : 'pointer',
                  fontSize: 11, fontWeight: 500,
                  color: isMatched ? '#16A34A' : 'var(--ink-2)',
                  textAlign: 'left', lineHeight: 1.45,
                  transition: 'all 0.15s',
                  animation: isWrongDef ? 'shake 0.4s' : undefined,
                  minHeight: 52,
                  display: 'flex', alignItems: 'center',
                  opacity: !isMatched && selectedTerm === null ? 0.55 : 1,
                }}>
                {isMatched && <span style={{ marginRight: 5, fontSize: 13, flexShrink: 0 }}>✓</span>}
                {activity.pairs[pairIdx].definition}
              </button>
            );
          })}
        </div>
      </div>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25%       { transform: translateX(-5px); }
          75%       { transform: translateX(5px); }
        }
      `}</style>
    </div>
  );
}
