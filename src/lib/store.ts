export const Store = {
  get<T>(key: string, def: T): T {
    try {
      const v = localStorage.getItem('sprout:' + key);
      return v == null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(key: string, val: unknown) {
    try { localStorage.setItem('sprout:' + key, JSON.stringify(val)); } catch {}
  },
  del(key: string) {
    try { localStorage.removeItem('sprout:' + key); } catch {}
  },
};

// ── Study tracker ─────────────────────────────────────────────

export interface StudyStats {
  streak:       number;   // consecutive days with any study activity
  lastDate:     string;   // YYYY-MM-DD of most recent activity
  todayMinutes: number;   // minutes studied today
  todayDate:    string;   // YYYY-MM-DD for todayMinutes (reset when date changes)
  totalMinutes: number;   // all-time total
  activeDays:   string[]; // up to 56 recent YYYY-MM-DD strings (for future heatmap)
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export const StudyTracker = {
  get(): StudyStats {
    return Store.get<StudyStats>('study:stats', {
      streak: 0, lastDate: '', todayMinutes: 0, todayDate: '', totalMinutes: 0, activeDays: [],
    });
  },

  /** Call when leaving a study session. minutes < 1 are ignored. */
  log(minutes: number): void {
    if (minutes < 1) return;
    const today     = todayStr();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const s         = StudyTracker.get();
    const newStreak = s.lastDate === today
      ? s.streak
      : s.lastDate === yesterday
        ? s.streak + 1
        : 1;
    Store.set('study:stats', {
      streak:       newStreak,
      lastDate:     today,
      todayMinutes: s.todayDate === today ? s.todayMinutes + minutes : minutes,
      todayDate:    today,
      totalMinutes: s.totalMinutes + minutes,
      activeDays:   [...new Set([...(s.activeDays ?? []).slice(-55), today])],
    } satisfies StudyStats);
  },
};

export function celebrate() {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5000;';
  const colors = ['#2F9E5E', '#FF7A5C', '#F4B740', '#4FB7F5', '#8C5BD9'];
  for (let i = 0; i < 24; i++) {
    const dot = document.createElement('div');
    const c = colors[i % colors.length];
    dot.style.cssText = `position:absolute;top:50%;left:50%;width:10px;height:10px;border-radius:2px;background:${c};transform:translate(-50%,-50%);`;
    const angle = (i / 24) * Math.PI * 2;
    const dist = 180 + Math.random() * 120;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist;
    dot.animate(
      [
        { transform: 'translate(-50%,-50%) scale(1)', opacity: '1' },
        { transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(0)`, opacity: '0' },
      ],
      { duration: 900 + Math.random() * 400, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'forwards' }
    );
    el.appendChild(dot);
  }
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}
