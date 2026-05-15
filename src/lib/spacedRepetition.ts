/**
 * SM-2 spaced repetition engine.
 * Each flashcard the learner rates gets added to a persistent review queue.
 * On next session open, due cards are prepended to the deck.
 */

const STORE_KEY = 'sprout:reviews';
const DAY_MS    = 86_400_000;

export interface ReviewItem {
  id:           string;
  sourceKey:    string;   // source path joined — used to scope reviews per material
  question:     string;
  answer:       string;
  interval:     number;   // days until next review
  ease:         number;   // multiplier 1.3–3.0, starts at 2.5
  nextReview:   number;   // epoch ms
  lastReviewed: number;   // epoch ms
}

type Queue = Record<string, ReviewItem>;

function load(): Queue {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
  catch { return {}; }
}

function save(q: Queue) {
  localStorage.setItem(STORE_KEY, JSON.stringify(q));
}

function makeId(sourceKey: string, question: string): string {
  // Stable, human-readable-ish key
  const raw = sourceKey + '::' + question;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (Math.imul(31, hash) + raw.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

// ── Public API ────────────────────────────────────────────────

/** All cards due for review from this source, sorted by most-overdue first. */
export function getDueItems(sourceKey: string): ReviewItem[] {
  const now = Date.now();
  return Object.values(load())
    .filter(r => r.sourceKey === sourceKey && r.nextReview <= now)
    .sort((a, b) => a.nextReview - b.nextReview);
}

/** Total due across ALL sources — used for global badges. */
export function getTotalDue(): number {
  const now = Date.now();
  return Object.values(load()).filter(r => r.nextReview <= now).length;
}

/** Add a newly-rated flashcard to the queue. Safe to call multiple times (idempotent on id). */
export function addToQueue(
  sourceKey: string,
  question: string,
  answer: string,
  firstRating: 'hard' | 'medium' | 'easy'
) {
  const q  = load();
  const id = makeId(sourceKey, question);
  if (q[id]) { recordReview(id, firstRating); return; } // already tracked — just update

  const intervals = { hard: 1, medium: 3, easy: 7 };
  q[id] = {
    id, sourceKey, question, answer,
    interval:     intervals[firstRating],
    ease:         2.5,
    nextReview:   Date.now() + intervals[firstRating] * DAY_MS,
    lastReviewed: Date.now(),
  };
  save(q);
}

/** Update an existing review item after the learner rates it again. */
export function recordReview(id: string, rating: 'hard' | 'medium' | 'easy') {
  const q    = load();
  const item = q[id];
  if (!item) return;

  let { interval, ease } = item;

  if (rating === 'hard') {
    interval = 1;
    ease     = Math.max(1.3, ease - 0.2);
  } else if (rating === 'medium') {
    interval = Math.max(2, Math.round(interval * ease));
    // ease unchanged
  } else {
    interval = Math.max(4, Math.round(interval * ease * 1.3));
    ease     = Math.min(3.0, ease + 0.15);
  }

  q[id] = { ...item, interval, ease, nextReview: Date.now() + interval * DAY_MS, lastReviewed: Date.now() };
  save(q);
}

/** How many days until the next review for a source (0 = due now). */
export function daysUntilNextReview(sourceKey: string): number | null {
  const items = Object.values(load()).filter(r => r.sourceKey === sourceKey);
  if (!items.length) return null;
  const next = Math.min(...items.map(r => r.nextReview));
  return Math.max(0, Math.ceil((next - Date.now()) / DAY_MS));
}
