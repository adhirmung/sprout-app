/**
 * ActivityMemoryMatch — flip-card pairs game.
 * Terms and definitions are shuffled into a single grid.
 * Tap two matching cards to pair them; all pairs → complete.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryMatchActivity } from '../lib/gemini';

interface Card {
  id:     number;
  pairId: number;
  text:   string;
  kind:   'term' | 'def';
}

interface Props {
  activity:   MemoryMatchActivity;
  onComplete: (score: number, total: number) => void;
}

export function ActivityMemoryMatch({ activity, onComplete }: Props) {
  const cards = useMemo<Card[]>(() => {
    const raw: Card[] = activity.pairs.flatMap((p, i) => [
      { id: i * 2,     pairId: i, text: p.term,       kind: 'term' as const },
      { id: i * 2 + 1, pairId: i, text: p.definition, kind: 'def'  as const },
    ]);
    // Fisher-Yates shuffle
    for (let i = raw.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [raw[i], raw[j]] = [raw[j], raw[i]];
    }
    return raw;
  }, [activity]);

  const [revealed,  setRevealed]  = useState<Set<number>>(new Set());
  const [matched,   setMatched]   = useState<Set<number>>(new Set());
  const [selected,  setSelected]  = useState<number | null>(null);
  const [shake,     setShake]     = useState<Set<number>>(new Set());
  const [moves,     setMoves]     = useState(0);
  const [done,      setDone]      = useState(false);
  const lockRef = useRef(false);

  const total = activity.pairs.length;

  const flip = (id: number) => {
    if (lockRef.current)      return;
    if (matched.has(id))      return;
    if (revealed.has(id))     return;
    if (selected === id)      return;

    setRevealed(prev => new Set([...prev, id]));

    if (selected === null) {
      setSelected(id);
      return;
    }

    // Second card flipped
    lockRef.current = true;
    setMoves(m => m + 1);
    const firstCard  = cards.find(c => c.id === selected)!;
    const secondCard = cards.find(c => c.id === id)!;

    if (firstCard.pairId === secondCard.pairId) {
      // ✅ Match
      const newMatched = new Set([...matched, selected, id]);
      setMatched(newMatched);
      setSelected(null);
      lockRef.current = false;
      if (newMatched.size === cards.length) {
        setTimeout(() => setDone(true), 400);
      }
    } else {
      // ❌ No match — shake then flip back
      setShake(new Set([selected, id]));
      setTimeout(() => {
        setRevealed(prev => {
          const n = new Set(prev);
          n.delete(selected);
          n.delete(id);
          return n;
        });
        setShake(new Set());
        setSelected(null);
        lockRef.current = false;
      }, 900);
    }
  };

  useEffect(() => {
    if (done) onComplete(total, total);
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps

  const matchedPairs = matched.size / 2;

  if (done) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32, textAlign: 'center' }}>
      <div style={{ fontSize: 52 }}>🎉</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)' }}>All matched!</div>
      <div style={{ fontSize: 15, color: 'var(--ink-2)' }}>{total} pairs · {moves} moves</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Progress */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink-2)' }}>
          {matchedPairs} / {total} matched
        </span>
        <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>{moves} moves</span>
      </div>

      {/* Progress bar */}
      <div style={{ height: 5, background: 'var(--line)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${(matchedPairs / total) * 100}%`, background: 'var(--brand)', borderRadius: 99, transition: 'width 0.3s' }} />
      </div>

      {/* Card grid — 4 cols, constrained by parent 600px wrapper */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {cards.map(card => {
          const isRevealed = revealed.has(card.id);
          const isMatched  = matched.has(card.id);
          const isShaking  = shake.has(card.id);
          const isSelected = selected === card.id;

          const bg = isMatched
            ? '#DCFCE7'
            : isRevealed
              ? (isShaking ? '#FEE2E2' : '#EEF6FF')
              : 'var(--bg-tint)';
          const border = isMatched
            ? '2px solid #16A34A'
            : isSelected
              ? '2px solid var(--brand)'
              : isShaking
                ? '2px solid #EF4444'
                : '2px solid var(--line)';

          return (
            <button
              key={card.id}
              onClick={() => flip(card.id)}
              style={{
                aspectRatio: '3 / 4',
              minHeight: 72,
              maxHeight: 120,
                borderRadius: 10,
                border,
                background: bg,
                cursor: isMatched ? 'default' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 6,
                transition: 'all 0.2s',
                animation: isShaking ? 'shake 0.4s' : undefined,
                overflow: 'hidden',
              }}>
              {isRevealed || isMatched ? (
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: isMatched ? '#16A34A' : 'var(--ink)',
                  textAlign: 'center',
                  lineHeight: 1.35,
                  wordBreak: 'break-word',
                }}>
                  {card.text}
                </span>
              ) : (
                <span style={{ fontSize: 18, opacity: 0.3 }}>?</span>
              )}
            </button>
          );
        })}
      </div>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20%       { transform: translateX(-4px); }
          40%       { transform: translateX(4px); }
          60%       { transform: translateX(-4px); }
          80%       { transform: translateX(4px); }
        }
      `}</style>
    </div>
  );
}
