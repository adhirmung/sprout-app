import { useEffect, useMemo, useState } from 'react';
import { dbLoadAllAttempts, dbLoadExamSets } from '../lib/examDb';
import type { StoredAttempt, StoredExamSet } from '../lib/examDb';

// ── Helpers ────────────────────────────────────────────────────

function fmtTime(s: number): string {
  if (s < 60)  return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0)   return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function masteryColor(pct: number) {
  if (pct >= 70) return { bar: '#22c55e', text: '#059669', bg: '#ECFDF5', label: 'Strong' };
  if (pct >= 40) return { bar: '#f59e0b', text: '#b45309', bg: '#FFFBEB', label: 'Building' };
  return           { bar: '#ef4444', text: '#dc2626', bg: '#FEF2F2', label: 'Needs Work' };
}

// ── Main screen ────────────────────────────────────────────────

interface ProgressScreenProps {
  userId?: string;
}

export function ProgressScreen({ userId }: ProgressScreenProps) {
  const [examSets,  setExamSets]  = useState<StoredExamSet[]>([]);
  const [attempts,  setAttempts]  = useState<StoredAttempt[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [subject,   setSubject]   = useState('');
  const [topic,     setTopic]     = useState('');

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

  // ── Dropdown options ──────────────────────────────────────────

  const subjects = useMemo(() => {
    return [...new Set(examSets.map(s => s.subject).filter(Boolean))].sort();
  }, [examSets]);

  const topics = useMemo(() => {
    if (!subject) return [];
    const sets = examSets.filter(s => s.subject === subject);
    const all  = sets.flatMap(s => s.examData.questions.map(q => q.topic));
    return [...new Set(all)].sort();
  }, [examSets, subject]);

  // Reset topic when subject changes
  useEffect(() => { setTopic(''); }, [subject]);

  // ── Data for selected subject + topic ─────────────────────────

  // All exam sets for selected subject
  const subjectSets = useMemo(
    () => examSets.filter(s => s.subject === subject),
    [examSets, subject],
  );
  const subjectSetIds = useMemo(() => new Set(subjectSets.map(s => s.id)), [subjectSets]);

  // All attempts for selected subject
  const subjectAttempts = useMemo(
    () => attempts.filter(a => subjectSetIds.has(a.examSetId)),
    [attempts, subjectSetIds],
  );

  // question id → topic, question id → question count per attempt
  const qTopicMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const set of subjectSets)
      for (const q of set.examData.questions)
        m.set(q.id, q.topic);
    return m;
  }, [subjectSets]);

  // question id → question stem (for focus areas)
  const qStemMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const set of subjectSets)
      for (const q of set.examData.questions)
        m.set(q.id, q.stem);
    return m;
  }, [subjectSets]);

  // question count per exam set (for pro-rating time)
  const setQCountMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const set of subjectSets)
      m.set(set.id, set.examData.questions.length);
    return m;
  }, [subjectSets]);

  // topic question count per exam set (for pro-rating time to topic)
  const setTopicQCountMap = useMemo(() => {
    const m = new Map<string, number>();
    if (!topic) return m;
    for (const set of subjectSets) {
      const count = set.examData.questions.filter(q => q.topic === topic).length;
      m.set(set.id, count);
    }
    return m;
  }, [subjectSets, topic]);

  // ── Stats computed for the selected scope ─────────────────────

  interface AttemptStat {
    id:          string;
    date:        string;
    awarded:     number;
    total:       number;
    pct:         number;
    timeSeconds: number;          // pro-rated to topic
    feedback:    string[];        // per-question feedback for wrong answers
    weakStem:    string[];        // stems of low-scoring questions
  }

  const { timeInvested, mastery, attemptStats, focusAreas } = useMemo(() => {
    if (!subject) return { timeInvested: 0, mastery: null, attemptStats: [], focusAreas: [] };

    let totalAwarded = 0;
    let totalMarks   = 0;
    let totalSecs    = 0;
    const stats: AttemptStat[] = [];

    // Accumulate feedback across all attempts to surface weak spots
    const feedbackMap = new Map<string, { awarded: number; total: number; feedback: string[]; stem: string }>();

    for (const attempt of subjectAttempts) {
      if (!attempt.results) continue;

      const totalQInSet   = setQCountMap.get(attempt.examSetId) ?? 1;
      const topicQInSet   = topic ? (setTopicQCountMap.get(attempt.examSetId) ?? 0) : totalQInSet;
      const ratio         = totalQInSet > 0 ? topicQInSet / totalQInSet : 1;
      const proRatedSecs  = Math.round((attempt.durationSeconds ?? 0) * ratio);

      let attAwarded = 0;
      let attTotal   = 0;
      const attFeedback: string[] = [];
      const attWeak: string[]     = [];

      for (const res of attempt.results.results) {
        const qTopic = qTopicMap.get(res.questionId);
        if (topic && qTopic !== topic) continue;
        if (!topic && !qTopic) continue; // subject mode: include all

        attAwarded += res.awarded;
        attTotal   += res.total;

        // Track per-question performance for focus areas
        const key  = res.questionId;
        const cur  = feedbackMap.get(key) ?? { awarded: 0, total: 0, feedback: [], stem: qStemMap.get(key) ?? '' };
        feedbackMap.set(key, {
          awarded:  cur.awarded + res.awarded,
          total:    cur.total   + res.total,
          feedback: [...cur.feedback, res.feedback].filter(Boolean),
          stem:     cur.stem || qStemMap.get(key) || '',
        });

        // Collect feedback for low-scoring answers in this attempt
        const pct = res.total > 0 ? res.awarded / res.total : 1;
        if (pct < 0.5 && res.feedback) {
          attFeedback.push(res.feedback);
          const stem = qStemMap.get(res.questionId);
          if (stem) attWeak.push(stem.slice(0, 80) + (stem.length > 80 ? '…' : ''));
        }
      }

      if (attTotal === 0) continue;

      totalAwarded += attAwarded;
      totalMarks   += attTotal;
      totalSecs    += proRatedSecs;

      stats.push({
        id:          attempt.id,
        date:        attempt.createdAt,
        awarded:     attAwarded,
        total:       attTotal,
        pct:         Math.round((attAwarded / attTotal) * 100),
        timeSeconds: proRatedSecs,
        feedback:    attFeedback,
        weakStem:    attWeak,
      });
    }

    // Focus areas: questions where cumulative score < 50%
    const focus = Array.from(feedbackMap.entries())
      .map(([, v]) => ({ ...v, pct: v.total > 0 ? (v.awarded / v.total) * 100 : 0 }))
      .filter(v => v.pct < 50 && v.total > 0)
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 6);

    return {
      timeInvested: totalSecs,
      mastery:      totalMarks > 0 ? Math.round((totalAwarded / totalMarks) * 100) : null,
      attemptStats: stats.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
      focusAreas:   focus,
    };
  }, [subjectAttempts, subject, topic, qTopicMap, qStemMap, setQCountMap, setTopicQCountMap]);

  const hasSelection = Boolean(subject);
  const hasData      = attemptStats.length > 0;
  const mc           = mastery !== null ? masteryColor(mastery) : null;

  // ── Guard states ──────────────────────────────────────────────

  if (!userId) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 40, textAlign: 'center' }}>
        <span style={{ fontSize: 52 }}>🔒</span>
        <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--ink)' }}>Sign in to track your progress</div>
        <div style={{ fontSize: 13, color: 'var(--ink-3)', maxWidth: 320, lineHeight: 1.65 }}>
          Your study time, topic mastery, and practice test results are saved when you have an account.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 14, color: 'var(--ink-3)' }}>Loading…</div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Header ── */}
      <div style={{
        padding: '20px 24px 16px',
        borderBottom: '1px solid var(--line)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 22 }}>📊</span>
          <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--ink)' }}>Dashboard</div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>
          Track your study progress by subject and topic
        </div>
      </div>

      {/* ── Scrollable body ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>

        {/* ── Selector card ── */}
        <div className="card" style={{ padding: '20px 22px', marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--ink-4)', marginBottom: 14 }}>
            Select subject &amp; topic
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {/* Subject dropdown */}
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--ink-4)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                Subject
              </label>
              <select
                value={subject}
                onChange={e => setSubject(e.target.value)}
                style={{
                  width: '100%', padding: '9px 12px', borderRadius: 10,
                  border: '1.5px solid var(--line)', background: 'var(--bg)',
                  color: subject ? 'var(--ink)' : 'var(--ink-4)',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  outline: 'none', appearance: 'none',
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2.5'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 10px center',
                  paddingRight: 32,
                }}
              >
                <option value="">— Select subject —</option>
                {subjects.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            {/* Topic dropdown */}
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--ink-4)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                Topic <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span>
              </label>
              <select
                value={topic}
                onChange={e => setTopic(e.target.value)}
                disabled={!subject || topics.length === 0}
                style={{
                  width: '100%', padding: '9px 12px', borderRadius: 10,
                  border: '1.5px solid var(--line)', background: 'var(--bg)',
                  color: topic ? 'var(--ink)' : 'var(--ink-4)',
                  fontSize: 13, fontWeight: 600, cursor: subject ? 'pointer' : 'not-allowed',
                  opacity: subject ? 1 : 0.5,
                  outline: 'none', appearance: 'none',
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2.5'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 10px center',
                  paddingRight: 32,
                }}
              >
                <option value="">— All topics —</option>
                {topics.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* ── No subject selected ── */}
        {!hasSelection && (
          <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--ink-4)' }}>
            <div style={{ fontSize: 40, marginBottom: 14 }}>🎯</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink-3)', marginBottom: 8 }}>
              Select a subject to view your progress
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.65, maxWidth: 340, margin: '0 auto' }}>
              Choose a subject from the dropdown above. Optionally narrow it down to a specific topic.
            </div>
            {subjects.length === 0 && (
              <div style={{ marginTop: 20, fontSize: 12, color: 'var(--ink-4)', padding: '12px 16px', background: 'var(--card)', borderRadius: 10, display: 'inline-block' }}>
                No subjects found — complete a practice test first to populate this dashboard.
              </div>
            )}
          </div>
        )}

        {/* ── Selected but no data ── */}
        {hasSelection && !hasData && (
          <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--ink-4)' }}>
            <div style={{ fontSize: 40, marginBottom: 14 }}>📋</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink-3)', marginBottom: 8 }}>
              No practice test results yet
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.65, maxWidth: 340, margin: '0 auto' }}>
              Complete a practice test for <strong style={{ color: 'var(--ink)' }}>{subject}</strong>
              {topic ? ` covering ${topic}` : ''} to start tracking your progress here.
            </div>
          </div>
        )}

        {/* ── Results ── */}
        {hasSelection && hasData && mc && (
          <>
            {/* ── 1. Stats row ── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
              {[
                {
                  icon: '⏱️',
                  label: 'Time Studied',
                  value: fmtTime(timeInvested),
                  sub: `across ${attemptStats.length} attempt${attemptStats.length !== 1 ? 's' : ''}`,
                },
                {
                  icon: '📝',
                  label: 'Tests Taken',
                  value: String(attemptStats.length),
                  sub: topic ? `on ${topic}` : subject,
                },
                {
                  icon: '🎯',
                  label: 'Best Score',
                  value: `${Math.max(...attemptStats.map(a => a.pct))}%`,
                  sub: 'on this ' + (topic ? 'topic' : 'subject'),
                },
                {
                  icon: '📈',
                  label: 'Latest Score',
                  value: `${attemptStats[attemptStats.length - 1].pct}%`,
                  sub: fmtDate(attemptStats[attemptStats.length - 1].date),
                },
              ].map(({ icon, label, value, sub }) => (
                <div key={label} style={{
                  padding: '14px 16px', borderRadius: 14,
                  background: 'var(--card)', border: '1.5px solid var(--line)',
                }}>
                  <div style={{ fontSize: 22, marginBottom: 6 }}>{icon}</div>
                  <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--ink-4)', marginBottom: 3 }}>
                    {label}
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--ink)', lineHeight: 1.1 }}>{value}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 3 }}>{sub}</div>
                </div>
              ))}
            </div>

            {/* ── 2. Mastery progress bar ── */}
            <div className="card" style={{ padding: '20px 22px', marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)', marginBottom: 2 }}>
                    Mastery Progress — {topic || subject}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>
                    Based on cumulative practice test performance
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 16 }}>
                  <div style={{ fontSize: 28, fontWeight: 900, color: mc.text, lineHeight: 1 }}>
                    {mastery}%
                  </div>
                  <div style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 20,
                    background: mc.bg, color: mc.text, marginTop: 4, display: 'inline-block',
                  }}>
                    {mc.label}
                  </div>
                </div>
              </div>

              {/* Bar */}
              <div style={{ position: 'relative', height: 14, background: 'var(--line)', borderRadius: 999, overflow: 'hidden', marginBottom: 10 }}>
                <div style={{
                  height: '100%', borderRadius: 999,
                  background: `linear-gradient(90deg, ${mc.bar}99, ${mc.bar})`,
                  width: `${Math.min(mastery!, 100)}%`,
                  transition: 'width 0.8s ease',
                }} />
              </div>

              {/* Milestones */}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ink-4)', fontWeight: 600, paddingTop: 2 }}>
                <span>0%</span>
                <span style={{ color: mastery! >= 40 ? '#b45309' : 'var(--ink-4)' }}>40% Building</span>
                <span style={{ color: mastery! >= 70 ? '#059669' : 'var(--ink-4)' }}>70% Strong</span>
                <span>100%</span>
              </div>
            </div>

            {/* ── 3. Practice test results for this topic ── */}
            <div className="card" style={{ padding: '20px 22px', marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)', marginBottom: 16 }}>
                Practice Test Results — {topic || subject}
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['Attempt', 'Date', 'Score on Topic', 'Marks', 'Time', 'Result'].map(h => (
                        <th key={h} style={{
                          fontSize: 10, fontWeight: 800, textTransform: 'uppercase',
                          letterSpacing: '0.08em', color: 'var(--ink-4)',
                          padding: '6px 10px', textAlign: 'left',
                          borderBottom: '1.5px solid var(--line)',
                          whiteSpace: 'nowrap',
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {attemptStats.map((a, i) => {
                      const isBest = a.pct === Math.max(...attemptStats.map(x => x.pct));
                      const col    = masteryColor(a.pct);
                      const prev   = attemptStats[i - 1];
                      const delta  = prev ? a.pct - prev.pct : null;
                      return (
                        <tr key={a.id} style={{
                          background: isBest ? 'var(--brand-tint)' : 'transparent',
                          borderBottom: i < attemptStats.length - 1 ? '1px solid var(--line)' : 'none',
                        }}>
                          <td style={{ padding: '11px 10px', fontSize: 12, fontWeight: 700, color: 'var(--ink-4)' }}>
                            #{i + 1}{isBest ? ' ⭐' : ''}
                          </td>
                          <td style={{ padding: '11px 10px', fontSize: 12, color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>
                            {fmtDate(a.date)}
                          </td>
                          <td style={{ padding: '11px 10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 60, height: 5, background: 'var(--line)', borderRadius: 999, overflow: 'hidden', flexShrink: 0 }}>
                                <div style={{ height: '100%', width: `${a.pct}%`, background: col.bar, borderRadius: 999 }} />
                              </div>
                              <span style={{ fontSize: 13, fontWeight: 800, color: col.text }}>{a.pct}%</span>
                            </div>
                          </td>
                          <td style={{ padding: '11px 10px', fontSize: 12, color: 'var(--ink-3)' }}>
                            {a.awarded}/{a.total}
                          </td>
                          <td style={{ padding: '11px 10px', fontSize: 12, color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>
                            {fmtTime(a.timeSeconds)}
                          </td>
                          <td style={{ padding: '11px 10px' }}>
                            <span style={{
                              fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                              background: col.bg, color: col.text, whiteSpace: 'nowrap',
                            }}>
                              {col.label}
                              {delta !== null && (
                                <span style={{ marginLeft: 4, opacity: 0.75 }}>
                                  {delta > 0 ? `↑${delta}%` : delta < 0 ? `↓${Math.abs(delta)}%` : '→'}
                                </span>
                              )}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── 4. Focus areas ── */}
            {focusAreas.length > 0 ? (
              <div className="card" style={{ padding: '20px 22px', marginBottom: 20 }}>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)', marginBottom: 2 }}>
                    What to Focus On
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>
                    Aspects where you scored below 50% across all attempts — concentrate here next
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {focusAreas.map((area, i) => {
                    const col = masteryColor(area.pct);
                    return (
                      <div key={i} style={{
                        padding: '14px 16px', borderRadius: 12,
                        background: 'var(--bg)', border: `1.5px solid ${col.bar}44`,
                        borderLeft: `4px solid ${col.bar}`,
                      }}>
                        {/* Question stem */}
                        {area.stem && (
                          <div style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 600, marginBottom: 8, lineHeight: 1.5 }}>
                            {area.stem.slice(0, 120)}{area.stem.length > 120 ? '…' : ''}
                          </div>
                        )}

                        {/* Score bar */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: area.feedback.length ? 10 : 0 }}>
                          <div style={{ flex: 1, height: 5, background: 'var(--line)', borderRadius: 999, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${area.pct}%`, background: col.bar, borderRadius: 999 }} />
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 800, color: col.text, flexShrink: 0 }}>
                            {area.pct.toFixed(0)}% ({area.awarded}/{area.total} marks)
                          </span>
                        </div>

                        {/* Latest AI feedback */}
                        {area.feedback.length > 0 && (
                          <div style={{
                            fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.6,
                            padding: '8px 12px', background: 'var(--card)', borderRadius: 8,
                          }}>
                            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--ink-4)', display: 'block', marginBottom: 3 }}>
                              AI Feedback
                            </span>
                            {area.feedback[area.feedback.length - 1]}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              /* All good */
              <div style={{
                padding: '16px 20px', borderRadius: 14, marginBottom: 20,
                background: '#ECFDF5', border: '1.5px solid #A7F3D0',
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <span style={{ fontSize: 22, flexShrink: 0 }}>✅</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#065F46', marginBottom: 2 }}>
                    No weak areas identified
                  </div>
                  <div style={{ fontSize: 12, color: '#047857', lineHeight: 1.5 }}>
                    You're scoring above 50% on every question type for {topic || subject}. Keep it up — aim for 70%+ for Strong mastery.
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
