/**
 * StudyScreen — learning dashboard.
 *
 * Panels (all backed by real localStorage data):
 *   1. Quick stats bar — streak, time today, topics mastered, weak topic count
 *   2. Needs Review — docs that have weak spots (< 60% practice score)
 *   3. Document Progress — every doc in the library with a progress bar
 */
import { useMemo } from 'react';
import { Icon } from '../components/Icon';
import { Store, StudyTracker } from '../lib/store';
import type { FeedSource, LibraryFile, LibraryTree } from '../lib/types';

// ── Data helpers ──────────────────────────────────────────────

type SubStatus = 'unread' | 'read' | 'learnt';

interface FlatDoc {
  path:      string[];
  name:      string;
  item:      LibraryFile;
  sourceKey: string;
}

function collectAllFiles(tree: LibraryTree, path: string[] = []): FlatDoc[] {
  const out: FlatDoc[] = [];
  for (const name in tree) {
    const it = tree[name];
    if (it.type === 'file') {
      const p = [...path, name];
      out.push({ path: p, name, item: it, sourceKey: p.join('/') });
    } else if (it.type === 'folder') {
      out.push(...collectAllFiles(it.children, [...path, name]));
    }
  }
  return out.sort((a, b) => (b.item.created || 0) - (a.item.created || 0));
}

function getDocProgress(sourceKey: string): { done: number; total: number; hasContent: boolean } {
  const progress   = Store.get<Record<string, SubStatus> | null>(`progress:${sourceKey}`, null);
  const hasContent = !!(
    Store.get(`map:${sourceKey}`,    null) ||
    Store.get(`course:${sourceKey}`, null)
  );
  if (!progress) return { done: 0, total: 0, hasContent };
  const vals = Object.values(progress);
  return { done: vals.filter(v => v !== 'unread').length, total: vals.length, hasContent };
}

interface WeakDoc {
  sourceKey:  string;
  docName:    string;
  path:       string[];
  item:       LibraryFile;
  weakCount:  number;  // topics < 60%
  avgScore:   number;  // average of weak scores
  lowestScore: number;
}

function scanAllWeakDocs(docs: FlatDoc[]): WeakDoc[] {
  const results: WeakDoc[] = [];
  for (const doc of docs) {
    const raw = Store.get<Record<string, number> | null>(`weakspots:${doc.sourceKey}`, null);
    if (!raw) continue;
    const all   = Object.values(raw);
    const weak  = all.filter(pct => pct < 60);
    if (weak.length === 0) continue;
    results.push({
      sourceKey:   doc.sourceKey,
      docName:     doc.name,
      path:        doc.path,
      item:        doc.item,
      weakCount:   weak.length,
      avgScore:    Math.round(weak.reduce((s, v) => s + v, 0) / weak.length),
      lowestScore: Math.min(...weak),
    });
  }
  return results.sort((a, b) => a.lowestScore - b.lowestScore);
}

function countMasteredTopics(docs: FlatDoc[]): number {
  let total = 0;
  for (const doc of docs) {
    const progress = Store.get<Record<string, SubStatus> | null>(`progress:${doc.sourceKey}`, null);
    if (!progress) continue;
    total += Object.values(progress).filter(v => v === 'learnt').length;
  }
  return total;
}

// ── Palette ───────────────────────────────────────────────────

const DOC_COLORS = [
  '#2F9E5E', '#4FB7F5', '#8C5BD9', '#F4B740',
  '#FF7A5C', '#16A34A', '#0EA5E9', '#D946EF',
];

// ── Main component ────────────────────────────────────────────

interface StudyScreenProps {
  library:    LibraryTree;
  onOpenFile: (src: FeedSource) => void;
}

export function StudyScreen({ library, onOpenFile }: StudyScreenProps) {
  const stats = useMemo(() => StudyTracker.get(), []);

  const allDocs = useMemo(() => collectAllFiles(library), [library]);

  const weakDocs  = useMemo(() => scanAllWeakDocs(allDocs), [allDocs]);
  const mastered  = useMemo(() => countMasteredTopics(allDocs), [allDocs]);

  const todayLabel = stats.todayDate === new Date().toISOString().slice(0, 10) && stats.todayMinutes > 0
    ? stats.todayMinutes < 60
      ? `${stats.todayMinutes}m`
      : `${Math.floor(stats.todayMinutes / 60)}h ${stats.todayMinutes % 60}m`
    : '—';

  const startedDocs = allDocs.filter(d => getDocProgress(d.sourceKey).hasContent);

  const isEmpty = allDocs.length === 0;

  return (
    <div style={{ overflow: 'auto', height: '100%', padding: '32px clamp(20px, 4vw, 48px)' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>

        {/* ── Page header ── */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 'clamp(24px, 3vw, 32px)', fontWeight: 900, color: 'var(--ink)', marginBottom: 4 }}>
            📊 Study Hub
          </h1>
          <p style={{ fontSize: 14, color: 'var(--ink-3)' }}>Your learning overview — real data, not placeholders.</p>
        </div>

        {/* ── Quick stats ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 32 }}>
          <StatCard icon="flame"   color="coral"  label="Day streak"       value={stats.streak > 0 ? `${stats.streak}` : '—'} unit={stats.streak > 0 ? 'days' : ''} />
          <StatCard icon="clock"   color="sky"    label="Studied today"    value={todayLabel}                                   unit="" />
          <StatCard icon="sparkle" color="brand"  label="Topics mastered"  value={mastered > 0 ? `${mastered}` : '—'}           unit={mastered > 0 ? 'topics' : ''} />
          <StatCard icon="alert"   color="coral"  label="Needs review"     value={weakDocs.reduce((s, d) => s + d.weakCount, 0) || '—'} unit={weakDocs.length > 0 ? 'topics' : ''} />
        </div>

        {/* ── Needs Review section ── */}
        {weakDocs.length > 0 && (
          <Section title="🎯 Needs Review" subtitle="Topics you scored below 60% in practice">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
              {weakDocs.map((d, i) => (
                <WeakDocCard
                  key={d.sourceKey}
                  doc={d}
                  color={DOC_COLORS[i % DOC_COLORS.length]}
                  onOpen={() => onOpenFile({ path: d.path, item: d.item })}
                />
              ))}
            </div>
          </Section>
        )}

        {/* ── Document Progress section ── */}
        {isEmpty ? (
          <EmptyState onOpenLibrary={() => {}} />
        ) : (
          <Section
            title="📚 Document Progress"
            subtitle={`${startedDocs.length} of ${allDocs.length} documents started`}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
              {allDocs.map((doc, i) => {
                const prog  = getDocProgress(doc.sourceKey);
                const color = DOC_COLORS[i % DOC_COLORS.length];
                return (
                  <DocProgressCard
                    key={doc.sourceKey}
                    doc={doc}
                    progress={prog}
                    color={color}
                    onOpen={() => onOpenFile({ path: doc.path, item: doc.item })}
                  />
                );
              })}
            </div>
          </Section>
        )}

        <div style={{ height: 32 }} />
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────

function StatCard({
  icon, color, label, value, unit,
}: {
  icon: string; color: string; label: string; value: string | number; unit: string;
}) {
  return (
    <div className="card" style={{ padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{
        width: 40, height: 40, borderRadius: 12, flexShrink: 0,
        background: `var(--${color}-soft)`, color: `var(--${color})`,
        display: 'grid', placeItems: 'center',
      }}>
        <Icon name={icon} size={18} stroke="currentColor" />
      </div>
      <div>
        <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--ink)', lineHeight: 1.1, fontFamily: 'var(--font-mono)' }}>{value}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-3)', fontWeight: 600, marginTop: 2 }}>{unit ? `${unit} · ` : ''}{label}</div>
      </div>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)', marginBottom: 2 }}>{title}</h2>
        {subtitle && <p style={{ fontSize: 12, color: 'var(--ink-3)' }}>{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function WeakDocCard({
  doc, color, onOpen,
}: {
  doc: WeakDoc; color: string; onOpen: () => void;
}) {
  const avgBar = Math.round(doc.avgScore);
  const barColor = doc.avgScore < 40 ? '#EF4444' : '#F59E0B';
  return (
    <div className="card" style={{
      padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14,
      borderLeft: `3px solid ${barColor}`,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: color + '22', display: 'grid', placeItems: 'center', fontSize: 18, flexShrink: 0 }}>
          📄
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--ink-4)', fontWeight: 600, marginBottom: 2 }}>
            {doc.path.slice(0, -1).join(' › ') || 'Library'}
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {doc.docName}
          </div>
        </div>
      </div>

      {/* Weak score summary */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--ink-3)', fontWeight: 600 }}>
            {doc.weakCount} topic{doc.weakCount > 1 ? 's' : ''} need review
          </span>
          <span style={{ fontSize: 12, fontWeight: 800, color: barColor, fontFamily: 'var(--font-mono)' }}>
            avg {avgBar}%
          </span>
        </div>
        <div style={{ height: 6, borderRadius: 999, background: 'var(--bg-tint)', overflow: 'hidden' }}>
          <div style={{ width: `${avgBar}%`, height: '100%', background: barColor, borderRadius: 999, transition: 'width 0.6s' }} />
        </div>
      </div>

      {/* CTA */}
      <button
        onClick={onOpen}
        style={{
          padding: '9px 14px', borderRadius: 10, border: 'none',
          background: barColor, color: 'white',
          fontSize: 12, fontWeight: 700, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          transition: 'opacity 0.15s',
        }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = '0.85'}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = '1'}
      >
        🎯 Study Now <Icon name="arrow-right" size={13} stroke="white" />
      </button>
    </div>
  );
}

function DocProgressCard({
  doc, progress, color, onOpen,
}: {
  doc: FlatDoc;
  progress: { done: number; total: number; hasContent: boolean };
  color: string;
  onOpen: () => void;
}) {
  const pct       = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const isStarted = progress.hasContent || progress.done > 0;
  const isDone    = progress.total > 0 && progress.done === progress.total;

  const statusLabel = isDone
    ? '✓ Complete'
    : progress.total > 0
      ? `${progress.done} / ${progress.total} topics read`
      : isStarted
        ? 'Map generated'
        : 'Not started';

  return (
    <button
      className="card"
      onClick={onOpen}
      style={{
        padding: '18px 20px', textAlign: 'left', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 14,
        transition: 'transform 0.15s, box-shadow 0.18s',
        borderTop: `3px solid ${isStarted ? color : 'var(--line)'}`,
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)';
        (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-2)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.transform = 'translateY(0)';
        (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-1)';
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0,
          background: isStarted ? color + '22' : 'var(--bg-tint)',
          color: isStarted ? color : 'var(--ink-4)',
          display: 'grid', placeItems: 'center',
        }}>
          <Icon name="file" size={17} stroke="currentColor" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--ink-4)', fontWeight: 600, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {doc.path.slice(0, -1).join(' › ') || 'Library'}
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {doc.name}
          </div>
        </div>
        {isDone && <span style={{ fontSize: 13, flexShrink: 0 }}>✅</span>}
      </div>

      {/* Progress */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--ink-3)', fontWeight: 600 }}>{statusLabel}</span>
          {progress.total > 0 && (
            <span style={{ fontSize: 11, fontWeight: 800, color: isDone ? '#10B981' : isStarted ? color : 'var(--ink-4)', fontFamily: 'var(--font-mono)' }}>
              {pct}%
            </span>
          )}
        </div>
        <div style={{ height: 5, borderRadius: 999, background: 'var(--bg-tint)', overflow: 'hidden' }}>
          <div style={{
            width: `${pct}%`, height: '100%', borderRadius: 999,
            background: isDone ? '#10B981' : color,
            transition: 'width 0.6s ease',
          }} />
        </div>
      </div>

      {/* CTA label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 700, color: isStarted ? color : 'var(--ink-3)', marginTop: -4 }}>
        {isDone ? 'Review again' : isStarted ? 'Continue' : 'Open'} <Icon name="arrow-right" size={13} stroke="currentColor" />
      </div>
    </button>
  );
}

function EmptyState({ onOpenLibrary }: { onOpenLibrary: () => void }) {
  return (
    <div className="card" style={{ padding: '48px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center' }}>
      <div style={{ fontSize: 48 }}>📚</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)' }}>Nothing to track yet</div>
      <div style={{ fontSize: 14, color: 'var(--ink-3)', maxWidth: 320 }}>
        Upload your first document to the library and Sprout will start tracking your progress here.
      </div>
      <button className="btn btn-primary" onClick={onOpenLibrary}>
        <Icon name="folder" size={16} /> Open Library
      </button>
    </div>
  );
}
