import { useEffect, useMemo, useState } from 'react';
import { dbLoadAllAttempts, dbLoadExamSets } from '../lib/examDb';
import type { StoredAttempt, StoredExamSet } from '../lib/examDb';

// ── Types ──────────────────────────────────────────────────────

interface TopicStat {
  topic:         string;
  awarded:       number;
  total:         number;
  pct:           number;
  questionCount: number;
}

interface TypeStat {
  type:    string;
  awarded: number;
  total:   number;
  pct:     number;
}

interface SetStat {
  set:         StoredExamSet;
  attempts:    StoredAttempt[];
  scores:      number[];
  bestPct:     number | null;
  avgPct:      number | null;
  improvement: number | null;
  totalSecs:   number;
}

// ── Helpers ────────────────────────────────────────────────────

function fmtTime(s: number): string {
  if (s < 60)   return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0)    return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function typeLabel(t: string): string {
  switch (t) {
    case 'mcq':         return 'Multiple Choice';
    case 'short':       return 'Short Answer';
    case 'calculation': return 'Calculation';
    case 'essay':       return 'Essay';
    default:            return t;
  }
}

function typeEmoji(t: string): string {
  switch (t) {
    case 'mcq':         return '🔘';
    case 'short':       return '✏️';
    case 'calculation': return '🔢';
    case 'essay':       return '📝';
    default:            return '❓';
  }
}

function gradeCol(pct: number): string {
  if (pct >= 70) return '#059669';
  if (pct >= 40) return '#b45309';
  return '#dc2626';
}

function gradeDot(pct: number): string {
  if (pct >= 70) return '#22c55e';
  if (pct >= 40) return '#f59e0b';
  return '#ef4444';
}

function gradeBg(pct: number): string {
  if (pct >= 70) return '#ECFDF5';
  if (pct >= 40) return '#FFFBEB';
  return '#FEF2F2';
}

function gradeLabel(pct: number): string {
  if (pct >= 70) return 'Strong';
  if (pct >= 40) return 'Building';
  return 'Needs Work';
}

// ── Sparkline ──────────────────────────────────────────────────

function Sparkline({ scores }: { scores: number[] }) {
  if (scores.length < 2) return <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>1 attempt</span>;
  const W = 100; const H = 30; const pad = 4;
  const pts = scores.map((s, i) => {
    const x = pad + (i / (scores.length - 1)) * (W - pad * 2);
    const y = pad + (1 - Math.min(s, 100) / 100) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const improving = scores[scores.length - 1] >= scores[0];
  const c         = improving ? '#22c55e' : '#ef4444';
  const [lx, ly]  = pts[pts.length - 1].split(',');
  return (
    <svg width={W} height={H} style={{ display: 'block', flexShrink: 0 }}>
      <polyline points={pts.join(' ')} fill="none" stroke={c} strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={Number(lx)} cy={Number(ly)} r={3} fill={c} />
    </svg>
  );
}

// ── Section wrapper ─────────────────────────────────────────────

function Section({ title, subtitle, children }: {
  title:    string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ padding: 20, marginBottom: 16 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--ink)' }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>{subtitle}</div>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Stat card ──────────────────────────────────────────────────

function StatCard({ icon, label, value, sub }: {
  icon:  string;
  label: string;
  value: string;
  sub?:  string;
}) {
  return (
    <div style={{
      padding: '16px 18px', borderRadius: 14,
      background: 'var(--card)', border: '1.5px solid var(--line)',
    }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--ink-4)', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--ink)', lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ── Main screen ────────────────────────────────────────────────

interface ProgressScreenProps {
  userId?: string;
}

export function ProgressScreen({ userId }: ProgressScreenProps) {
  const [examSets, setExamSets] = useState<StoredExamSet[]>([]);
  const [attempts, setAttempts] = useState<StoredAttempt[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [subject,  setSubject]  = useState('All');

  useEffect(() => {
    if (!userId) { setLoading(false); return; }
    Promise.all([
      dbLoadExamSets(userId),
      dbLoadAllAttempts(userId),
    ]).then(([sets, all]) => {
      setExamSets(sets);
      setAttempts(all);
      setLoading(false);
    });
  }, [userId]);

  // ── Filter ────────────────────────────────────────────────────

  const subjects = useMemo(() => {
    const s = new Set(examSets.map(e => e.subject).filter(Boolean));
    return ['All', ...Array.from(s).sort()];
  }, [examSets]);

  const filteredSets = useMemo(
    () => subject === 'All' ? examSets : examSets.filter(s => s.subject === subject),
    [examSets, subject],
  );

  const filteredSetIds = useMemo(() => new Set(filteredSets.map(s => s.id)), [filteredSets]);

  const filteredAttempts = useMemo(
    () => attempts.filter(a => filteredSetIds.has(a.examSetId)),
    [attempts, filteredSetIds],
  );

  // ── Snapshot stats ────────────────────────────────────────────

  const totalSecs = filteredAttempts.reduce((s, a) => s + (a.durationSeconds ?? 0), 0);

  const totalQsAnswered = filteredAttempts.reduce((s, a) => {
    if (!a.results) return s;
    return s + a.results.results.filter(
      r => r.studentAnswer && r.studentAnswer !== '(no answer provided)'
    ).length;
  }, 0);

  const scored    = filteredAttempts.filter(a => a.scorePct !== null).map(a => a.scorePct!);
  const avgScore  = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null;
  const bestScore = scored.length ? Math.max(...scored) : null;

  // ── Question → topic / type lookup maps ──────────────────────

  const qTopicMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const set of filteredSets)
      for (const q of set.examData.questions)
        m.set(q.id, q.topic);
    return m;
  }, [filteredSets]);

  const qTypeMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const set of filteredSets)
      for (const q of set.examData.questions)
        m.set(q.id, q.type);
    return m;
  }, [filteredSets]);

  // ── Topic mastery (aggregated across all attempts) ─────────────

  const topicStats: TopicStat[] = useMemo(() => {
    const m = new Map<string, { awarded: number; total: number; n: number }>();
    for (const a of filteredAttempts) {
      if (!a.results) continue;
      for (const r of a.results.results) {
        const topic = qTopicMap.get(r.questionId) ?? 'General';
        const cur   = m.get(topic) ?? { awarded: 0, total: 0, n: 0 };
        m.set(topic, { awarded: cur.awarded + r.awarded, total: cur.total + r.total, n: cur.n + 1 });
      }
    }
    return Array.from(m.entries())
      .map(([topic, { awarded, total, n }]) => ({
        topic, awarded, total, questionCount: n,
        pct: total > 0 ? (awarded / total) * 100 : 0,
      }))
      .sort((a, b) => a.pct - b.pct);
  }, [filteredAttempts, qTopicMap]);

  // ── Question type breakdown ───────────────────────────────────

  const typeStats: TypeStat[] = useMemo(() => {
    const m = new Map<string, { awarded: number; total: number }>();
    for (const a of filteredAttempts) {
      if (!a.results) continue;
      for (const r of a.results.results) {
        const type = qTypeMap.get(r.questionId) ?? 'other';
        const cur  = m.get(type) ?? { awarded: 0, total: 0 };
        m.set(type, { awarded: cur.awarded + r.awarded, total: cur.total + r.total });
      }
    }
    const ORDER = ['mcq', 'short', 'calculation', 'essay'];
    return Array.from(m.entries())
      .map(([type, { awarded, total }]) => ({
        type, awarded, total,
        pct: total > 0 ? (awarded / total) * 100 : 0,
      }))
      .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  }, [filteredAttempts, qTypeMap]);

  // ── Per exam set performance ──────────────────────────────────

  const setStats: SetStat[] = useMemo(() => {
    return filteredSets
      .map(set => {
        const sa = filteredAttempts
          .filter(a => a.examSetId === set.id)
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        const scores     = sa.map(a => a.scorePct ?? 0);
        const best       = scores.length ? Math.max(...scores) : null;
        const avg        = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        const impr       = scores.length >= 2 ? scores[scores.length - 1] - scores[0] : null;
        const totalSecs  = sa.reduce((s, a) => s + (a.durationSeconds ?? 0), 0);
        return { set, attempts: sa, scores, bestPct: best, avgPct: avg, improvement: impr, totalSecs };
      })
      .filter(s => s.attempts.length > 0)         // hide untouched exam sets
      .sort((a, b) => {                            // most recently attempted first
        const la = a.attempts[a.attempts.length - 1]?.createdAt ?? '';
        const lb = b.attempts[b.attempts.length - 1]?.createdAt ?? '';
        return lb.localeCompare(la);
      });
  }, [filteredSets, filteredAttempts]);

  // ── Render ────────────────────────────────────────────────────

  if (!userId) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 40, textAlign: 'center' }}>
        <span style={{ fontSize: 52 }}>🔒</span>
        <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)' }}>Sign in to view your progress</div>
        <div style={{ fontSize: 14, color: 'var(--ink-3)', maxWidth: 340, lineHeight: 1.65 }}>
          Your exam history, topic mastery, and learning trends are saved when you have an account.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 14, color: 'var(--ink-3)' }}>Loading your progress…</div>
      </div>
    );
  }

  const hasAttempts = filteredAttempts.length > 0;
  const weakTopics  = topicStats.filter(t => t.pct < 40);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Header ── */}
      <div style={{ padding: '20px 24px 0', flexShrink: 0, borderBottom: '1px solid var(--line)', paddingBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <span style={{ fontSize: 22 }}>📊</span>
          <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--ink)' }}>Progress Dashboard</div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: subjects.length > 1 ? 14 : 0 }}>
          Your practice exam history, topic mastery and learning trends
        </div>

        {/* Subject filter tabs */}
        {subjects.length > 1 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {subjects.map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setSubject(s)}
                style={{
                  padding: '5px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', border: 'none',
                  background: subject === s ? 'var(--brand)'    : 'var(--bg)',
                  color:      subject === s ? '#fff'            : 'var(--ink-3)',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Scrollable body ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 40px' }}>

        {/* ── Snapshot stats ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
          <StatCard icon="⏱️" label="Study Time"   value={fmtTime(totalSecs)}                        sub={`${filteredAttempts.length} sessions`} />
          <StatCard icon="📝" label="Exams Taken"  value={String(filteredAttempts.length)}           sub={`${filteredSets.filter(s => filteredAttempts.some(a => a.examSetId === s.id)).length} exam sets`} />
          <StatCard icon="❓" label="Qs Answered"  value={String(totalQsAnswered)}                   sub="across all attempts" />
          <StatCard icon="📈" label="Avg Score"    value={avgScore !== null ? `${avgScore.toFixed(0)}%` : '—'} sub={bestScore !== null ? `Best: ${bestScore.toFixed(0)}%` : undefined} />
        </div>

        {/* ── No data empty state ── */}
        {!hasAttempts && (
          <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--ink-3)' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>
              No exam attempts yet
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.65, maxWidth: 360, margin: '0 auto' }}>
              Complete a practice exam to start seeing your topic mastery,
              question type breakdown, and progress trends here.
            </div>
          </div>
        )}

        {hasAttempts && (
          <>
            {/* ── Focus areas callout (if any topics < 40%) ── */}
            {weakTopics.length > 0 && (
              <div style={{
                display: 'flex', gap: 12, padding: '14px 18px', marginBottom: 16,
                background: '#FEF2F2', border: '1.5px solid #FECACA', borderRadius: 14,
              }}>
                <span style={{ fontSize: 20, flexShrink: 0 }}>📌</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: '#991B1B', marginBottom: 4 }}>
                    Concentrate on these topics
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                    {weakTopics.map(t => (
                      <span key={t.topic} style={{
                        fontSize: 12, color: '#B91C1C', fontWeight: 600,
                        background: '#FEE2E2', padding: '2px 9px', borderRadius: 20,
                      }}>
                        {t.topic} · {t.pct.toFixed(0)}%
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── Topic Mastery ── */}
            {topicStats.length > 0 && (
              <Section
                title="Topic Mastery"
                subtitle={`${topicStats.length} topics · aggregated across all attempts · weakest first`}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {topicStats.map(({ topic, awarded, total, pct, questionCount }) => (
                    <div key={topic}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                        {/* Status dot */}
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: gradeDot(pct), flexShrink: 0 }} />

                        {/* Topic name */}
                        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {topic}
                        </span>

                        {/* Marks + question count */}
                        <span style={{ fontSize: 11, color: 'var(--ink-4)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                          {awarded}/{total} · {questionCount}q
                        </span>

                        {/* Percentage */}
                        <span style={{ fontSize: 12, fontWeight: 800, color: gradeCol(pct), minWidth: 36, textAlign: 'right', flexShrink: 0 }}>
                          {pct.toFixed(0)}%
                        </span>

                        {/* Status pill */}
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 9px', borderRadius: 20,
                          background: gradeBg(pct), color: gradeCol(pct), flexShrink: 0, whiteSpace: 'nowrap',
                        }}>
                          {gradeLabel(pct)}
                        </span>
                      </div>

                      {/* Bar */}
                      <div style={{ height: 5, background: 'var(--line)', borderRadius: 999, overflow: 'hidden', marginLeft: 16 }}>
                        <div style={{
                          height: '100%', borderRadius: 999, background: gradeDot(pct),
                          width: `${Math.min(pct, 100)}%`, transition: 'width 0.6s ease',
                        }} />
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* ── Question Type Breakdown ── */}
            {typeStats.length > 0 && (
              <Section
                title="Question Type Breakdown"
                subtitle="How you perform across different question formats"
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {typeStats.map(({ type, awarded, total, pct }) => (
                    <div key={type}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                        <span style={{ fontSize: 16, flexShrink: 0 }}>{typeEmoji(type)}</span>
                        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                          {typeLabel(type)}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--ink-4)', flexShrink: 0 }}>
                          {awarded}/{total} marks
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 800, color: gradeCol(pct), minWidth: 38, textAlign: 'right', flexShrink: 0 }}>
                          {pct.toFixed(0)}%
                        </span>
                      </div>
                      <div style={{ height: 7, background: 'var(--line)', borderRadius: 999, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', borderRadius: 999, background: gradeDot(pct),
                          width: `${Math.min(pct, 100)}%`, transition: 'width 0.6s ease',
                        }} />
                      </div>
                    </div>
                  ))}
                </div>

                {/* Type insight */}
                {typeStats.length >= 2 && (() => {
                  const sorted  = [...typeStats].sort((a, b) => a.pct - b.pct);
                  const weakest = sorted[0];
                  const best    = sorted[sorted.length - 1];
                  if (weakest.type === best.type) return null;
                  return (
                    <div style={{ marginTop: 14, padding: '10px 14px', background: 'var(--bg)', borderRadius: 10, fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.6 }}>
                      💡 You score best on <strong style={{ color: 'var(--ink)' }}>{typeLabel(best.type)}</strong> ({best.pct.toFixed(0)}%) and need the most work on <strong style={{ color: 'var(--ink)' }}>{typeLabel(weakest.type)}</strong> ({weakest.pct.toFixed(0)}%).
                    </div>
                  );
                })()}
              </Section>
            )}

            {/* ── Exam Set Performance ── */}
            {setStats.length > 0 && (
              <Section
                title="Exam Performance"
                subtitle="Score trend per exam set — retake to see your improvement"
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {setStats.map(({ set, attempts: sa, scores, bestPct, avgPct, improvement, totalSecs: secs }) => {
                    const trend      = improvement;
                    const trendCol   = trend === null ? 'var(--ink-4)' : trend > 0 ? '#059669' : trend < 0 ? '#dc2626' : 'var(--ink-3)';
                    const trendLabel = trend === null ? '' : trend > 0 ? `↑ +${trend.toFixed(0)}%` : trend < 0 ? `↓ ${trend.toFixed(0)}%` : '→ Stable';

                    return (
                      <div key={set.id} style={{
                        padding: '16px 18px', borderRadius: 14,
                        background: 'var(--bg)', border: '1.5px solid var(--line)',
                      }}>
                        {/* Title row */}
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {set.subject || set.title}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>
                              {set.grade} · {sa.length} attempt{sa.length !== 1 ? 's' : ''} · {fmtTime(secs)} total
                            </div>
                          </div>
                          <Sparkline scores={scores} />
                        </div>

                        {/* Score pills row */}
                        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: scores.length > 1 ? 10 : 0 }}>
                          {bestPct !== null && (
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--ink-4)' }}>Best</div>
                              <div style={{ fontSize: 14, fontWeight: 800, color: gradeCol(bestPct) }}>{bestPct.toFixed(0)}%</div>
                            </div>
                          )}
                          {avgPct !== null && (
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--ink-4)' }}>Avg</div>
                              <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--ink-2)' }}>{avgPct.toFixed(0)}%</div>
                            </div>
                          )}
                          {trend !== null && (
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--ink-4)' }}>Progress</div>
                              <div style={{ fontSize: 14, fontWeight: 800, color: trendCol }}>{trendLabel}</div>
                            </div>
                          )}
                        </div>

                        {/* Score timeline — each attempt as a chip */}
                        {scores.length > 0 && (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            {sa.map((attempt, i) => {
                              const s   = attempt.scorePct ?? 0;
                              const isLast = i === sa.length - 1;
                              return (
                                <span key={attempt.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                  {i > 0 && <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>→</span>}
                                  <span
                                    title={fmtDate(attempt.createdAt)}
                                    style={{
                                      fontSize: 11, fontWeight: 700,
                                      padding: '3px 9px', borderRadius: 20,
                                      color:      gradeCol(s),
                                      background: gradeBg(s),
                                      border:     isLast ? `1.5px solid ${gradeDot(s)}` : 'none',
                                    }}
                                  >
                                    {s.toFixed(0)}%
                                  </span>
                                </span>
                              );
                            })}
                            {sa.length === 1 && (
                              <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>
                                Retake to track progress
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Section>
            )}

            {/* ── All exam sets with no attempts (untouched) ── */}
            {(() => {
              const untouched = filteredSets.filter(s =>
                !filteredAttempts.some(a => a.examSetId === s.id)
              );
              if (untouched.length === 0) return null;
              return (
                <Section title="Not Yet Attempted" subtitle="Exam sets you haven't taken yet">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {untouched.map(set => (
                      <div key={set.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '10px 14px', borderRadius: 10,
                        background: 'var(--bg)', border: '1.5px solid var(--line)',
                      }}>
                        <span style={{ fontSize: 18 }}>📋</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {set.subject || set.title}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>{set.grade} · {set.totalMarks} marks</div>
                        </div>
                        <span style={{ fontSize: 11, color: 'var(--ink-4)', padding: '3px 9px', background: 'var(--card)', borderRadius: 20, border: '1px solid var(--line)', whiteSpace: 'nowrap' }}>
                          Not started
                        </span>
                      </div>
                    ))}
                  </div>
                </Section>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}
