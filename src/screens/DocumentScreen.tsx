import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { SproutMark } from '../components/Brand';
import { Chip } from '../components/Chip';
import { ProgressBar } from '../components/ProgressBar';
import {
  buildChatSystemPrompt,
  generateFeed,
  hasApiKey,
  saveApiKey,
  streamCardChat,
} from '../lib/claude';
import type { ChatMessage, FeedCard, FeedAudit } from '../lib/claude';
import { dbLoadGeneratedCards, dbSaveGeneratedCards, fetchPdfBase64FromStorage } from '../lib/supabase';
import { Store } from '../lib/store';
import type { FeedSource, LearnerProfile } from '../lib/types';

// ── Helpers ───────────────────────────────────────────────────

const LARGE_DOC_CHARS = 120_000;

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const fn = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return mobile;
}

// ── DocumentScreen ────────────────────────────────────────────

interface DocumentScreenProps {
  source:  FeedSource | null;
  profile: LearnerProfile | null;
  onBack:  () => void;
  userId?: string;
}

export function DocumentScreen({ source, profile, onBack, userId }: DocumentScreenProps) {
  const [phase,     setPhase]     = useState<'idle' | 'loading' | 'running' | 'done'>('idle');
  const [cards,     setCards]     = useState<FeedCard[]>([]);
  const [audit,     setAudit]     = useState<FeedAudit | null>(null);
  const [idx,       setIdx]       = useState(0);
  const [score,     setScore]     = useState(0);
  const [streak,    setStreak]    = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [error,     setError]     = useState('');
  const [fromCache, setFromCache] = useState(false);
  const [needsKey,  setNeedsKey]  = useState(!hasApiKey());
  const [showTutor, setShowTutor] = useState(false);
  const retryRef = useRef<HTMLButtonElement>(null);

  const topic       = source?.path?.[source.path.length - 1] ?? 'Document';
  const content     = source?.item?.content     ?? null;
  const pdfBase64   = source?.item?.pdfBase64   ?? null;
  const storagePath = source?.item?.storagePath ?? null;
  const fileType    = (source?.item?.fileType   ?? '').toUpperCase();
  const sourceKey   = source?.path?.join('/')   ?? 'general';
  const breadcrumb  = source?.path ? source.path.slice(0, -1).join(' › ') : '';
  const isLargeDoc  = (content?.length ?? 0) > LARGE_DOC_CHARS;
  const contentLen  = content?.length ?? 0;

  useEffect(() => { if (error) retryRef.current?.focus(); }, [error]);

  // Preload cached audit on mount so the quality badge shows while idle
  useEffect(() => {
    if (userId) {
      dbLoadGeneratedCards(userId, `${sourceKey}:feed:activities`)
        .then(cached => { if (cached?.result.audit) setAudit(cached.result.audit); })
        .catch(() => {});
    } else {
      const cached = Store.get<{ cards: FeedCard[]; audit: FeedAudit | null } | null>(`feed:${sourceKey}:feed:activities`, null);
      if (cached?.audit) setAudit(cached.audit);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, sourceKey]);

  const generate = async (force = false, mode: 'activities' | 'flashcards' | 'quiz' = 'activities') => {
    const modeKey = `${sourceKey}:feed:${mode}`;
    setPhase('loading');
    setError('');
    setFromCache(false);
    setScore(0);
    setStreak(0);
    try {
      if (!force) {
        if (userId) {
          const cached = await dbLoadGeneratedCards(userId, modeKey).catch(() => null);
          if (cached && cached.result.cards.length > 0) {
            setCards(cached.result.cards);
            setAudit(cached.result.audit);
            setIdx(0); setFromCache(true);
            setStartTime(Date.now()); setPhase('running'); return;
          }
        } else {
          const cached = Store.get<{ cards: FeedCard[]; audit: FeedAudit | null } | null>(`feed:${modeKey}`, null);
          if (cached && Array.isArray(cached.cards) && cached.cards.length > 0) {
            setCards(cached.cards);
            setAudit(cached.audit ?? null);
            setIdx(0); setFromCache(true);
            setStartTime(Date.now()); setPhase('running'); return;
          }
        }
      }

      // Resolve PDF binary: prefer in-memory, fall back to Supabase Storage
      let resolvedPdf = pdfBase64;
      if (!resolvedPdf && storagePath) {
        resolvedPdf = await fetchPdfBase64FromStorage(storagePath).catch(() => null);
      }

      // PDFs must always use the native binary path — no degraded text fallback
      if (fileType === 'PDF' && !resolvedPdf) {
        throw new Error('Could not load PDF binary. Try re-uploading the file.');
      }

      const result = await generateFeed(topic, content, resolvedPdf, mode);

      const finalResult = { cards: result.cards, audit: result.audit };
      if (userId) {
        dbSaveGeneratedCards(userId, modeKey, topic, finalResult, contentLen).catch(console.error);
      } else {
        Store.set(`feed:${modeKey}`, finalResult);
      }
      setCards(result.cards); setAudit(result.audit); setIdx(0); setStartTime(Date.now()); setPhase('running');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed. Please retry.');
      setPhase('idle');
    }
  };

  const next = () => { if (idx + 1 >= cards.length) { setPhase('done'); } else { setIdx(i => i + 1); } };
  const prev = () => { if (idx > 0) setIdx(i => i - 1); };

  const addScore = (pts: number, keepStreak: boolean) => {
    setScore(s => s + pts);
    setStreak(s => keepStreak ? s + 1 : 0);
  };

  if (needsKey) return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--bg)' }}>
      <FeedHeader topic={topic} breadcrumb={breadcrumb} score={0} streak={0} onBack={onBack} />
      <ApiKeyGate onSave={() => setNeedsKey(false)} />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--bg)', overflow: 'hidden' }}>
      {phase !== 'idle' && (
        <FeedHeader
          topic={topic} breadcrumb={breadcrumb}
          score={score} streak={streak}
          onBack={phase === 'loading' ? () => { setPhase('idle'); setError(''); } : onBack}
        />
      )}

      {phase === 'running' && (
        <div style={{ padding: '10px 24px', borderBottom: '1px solid var(--line)', background: 'var(--card-soft)', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-2)', fontWeight: 600, marginBottom: 6 }}>
            <span>Card {idx + 1} of {cards.length}</span>
            <span>{Math.round(((idx + 1) / cards.length) * 100)}%</span>
          </div>
          <ProgressBar value={idx + 1} max={cards.length} gradient label={`Card ${idx + 1} of ${cards.length}`} />
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: (phase === 'running' || phase === 'done') ? 24 : 0 }}>
        {phase === 'idle' && (
          <DocIdleView
            source={source} topic={topic} breadcrumb={breadcrumb}
            isLargeDoc={isLargeDoc} fromCache={fromCache} audit={audit}
            error={error} retryRef={retryRef} profile={profile}
            onBack={onBack}
            onGenerate={(mode) => generate(false, mode)}
            onRegenerate={() => generate(true, 'activities')}
            onOpenTutor={() => setShowTutor(true)}
          />
        )}
        {phase === 'loading' && <FeedLoading topic={topic} />}
        {phase === 'running' && cards.length > 0 && cards[idx] && (
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <CardView
              key={idx} card={cards[idx]} idx={idx} total={cards.length}
              topic={topic} content={content} profile={profile}
              onCorrect={() => addScore(20, true)}
              onWrong={() => addScore(0, false)}
              onRated={diff => addScore({ easy: 15, medium: 10, hard: 5 }[diff], true)}
              onPrev={prev} onNext={next}
            />
          </div>
        )}
        {phase === 'done' && (
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <CompletionView
              cards={cards} score={score} audit={audit}
              elapsed={startTime ? Date.now() - startTime : 0}
              onBack={onBack}
              onRestart={() => { setIdx(0); setScore(0); setStreak(0); setStartTime(Date.now()); setPhase('running'); }}
            />
          </div>
        )}
      </div>

      {/* Tutor FAB */}
      {(phase === 'running' || phase === 'done') && (
        <button
          onClick={() => setShowTutor(true)}
          style={{
            position: 'fixed', bottom: 24, right: 24,
            width: 52, height: 52, borderRadius: '50%',
            background: 'var(--brand)', color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 20px rgba(47,158,94,0.45)',
            border: 'none', cursor: 'pointer',
            zIndex: 'var(--z-dropdown)' as unknown as number,
          }}
          aria-label="Ask tutor"
        >
          <Icon name="sparkle" size={22} stroke="white" />
        </button>
      )}

      {showTutor && (
        <TutorOverlay
          topic={topic} content={content} cards={cards} profile={profile}
          currentCard={phase === 'idle' ? undefined : cards[idx]}
          onClose={() => setShowTutor(false)}
        />
      )}
    </div>
  );
}

// ── Header ────────────────────────────────────────────────────

function FeedHeader({ topic, breadcrumb, score, streak, onBack }: {
  topic: string; breadcrumb: string; score: number; streak: number; onBack: () => void;
}) {
  const isMobile = useIsMobile();
  return (
    <div style={{
      padding: '0 16px', height: 58, flexShrink: 0,
      background: 'var(--card)', borderBottom: '1px solid var(--line)',
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <button className="btn btn-ghost" onClick={onBack} style={{ padding: 8, borderRadius: '50%', minWidth: 44, minHeight: 44 }} aria-label="Go back">
        <Icon name="arrow-left" size={20} />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        {breadcrumb && !isMobile && (
          <div className="label-eyebrow" style={{ marginBottom: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {breadcrumb}
          </div>
        )}
        <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{topic}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <StatPill icon="trophy" color="gold"  value={score}  label={isMobile ? '' : 'pts'} />
        <StatPill icon="flame"  color="coral" value={streak} label={isMobile ? '' : 'streak'} />
      </div>
    </div>
  );
}

function StatPill({ icon, color, value, label }: { icon: string; color: string; value: number; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 999, background: `var(--${color}-soft)` }}>
      <Icon name={icon} size={14} stroke={`var(--${color})`} />
      <span style={{ fontWeight: 700, fontSize: 13, color: `var(--${color})`, fontFamily: 'var(--font-mono)' }}>{value}</span>
      {label && <span style={{ fontSize: 11, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>{label}</span>}
    </div>
  );
}

// ── Idle view (two-column) ────────────────────────────────────

function DocIdleView({
  source, topic, breadcrumb, isLargeDoc, fromCache, audit, error, retryRef, profile,
  onBack, onGenerate, onRegenerate, onOpenTutor,
}: {
  source: FeedSource | null; topic: string; breadcrumb: string;
  isLargeDoc: boolean; fromCache: boolean; audit: FeedAudit | null; error: string;
  retryRef: React.RefObject<HTMLButtonElement | null>; profile: LearnerProfile | null;
  onBack: () => void; onGenerate: (mode: 'activities' | 'flashcards' | 'quiz') => void; onRegenerate: () => void; onOpenTutor: () => void;
}) {
  const isMobile = useIsMobile();
  const [hoveredMode, setHoveredMode] = useState<string | null>(null);

  // Fetch PDF from Supabase Storage when the in-memory base64 is gone (e.g. after navigation)
  const [storagePdf, setStoragePdf] = useState<string | null>(null);
  useEffect(() => {
    const b64  = source?.item?.pdfBase64;
    const path = source?.item?.storagePath;
    if (b64 || !path) { setStoragePdf(null); return; }
    let cancelled = false;
    fetchPdfBase64FromStorage(path)
      .then(r => { if (!cancelled && r) setStoragePdf(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [source?.item?.pdfBase64, source?.item?.storagePath]);

  // Build a blob URL from whichever base64 source is available
  const pdfBlobUrl = useMemo(() => {
    const b64 = source?.item?.pdfBase64 ?? storagePdf;
    if (!b64) return null;
    try {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const blob  = new Blob([bytes], { type: 'application/pdf' });
      return URL.createObjectURL(blob);
    } catch { return null; }
  }, [source?.item?.pdfBase64, storagePdf]);

  useEffect(() => () => { if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl); }, [pdfBlobUrl]);

  const titleClean  = topic.replace(/\.[^.]+$/, '');
  const titleWords  = titleClean.split(/\s+/);
  const titleMain   = titleWords.length > 1 ? titleWords.slice(0, -1).join(' ') : '';
  const titleAccent = titleWords[titleWords.length - 1];

  const fileType    = (source?.item?.fileType ?? 'FILE').toUpperCase();
  const folderLabel = breadcrumb || 'Library';

  const wordCount = source?.item?.content ? source.item.content.split(/\s+/).length : 0;

  // Page estimate: file size for PDFs (~100 KB/page), word count for text files
  const estPages = source?.item?.size && fileType === 'PDF'
    ? Math.max(1, Math.round(source.item.size * 1_048_576 / 102_400))
    : wordCount > 0 ? Math.max(1, Math.ceil(wordCount / 300)) : null;

  // PDFs have no extracted text under Option C — always use the generic description
  const rawContent = fileType === 'PDF' ? '' : (source?.item?.content ?? '');
  const sampleWords = rawContent.trim().split(/\s+/).slice(0, 60);
  const avgWordLen  = sampleWords.length > 5
    ? sampleWords.reduce((s, w) => s + w.length, 0) / sampleWords.length : 0;
  const shortDesc = rawContent && avgWordLen >= 4.0
    ? rawContent.replace(/\s+/g, ' ').trim().slice(0, 200) + '…'
    : 'A personalised learning feed of summaries, flashcards, worked examples, and quizzes — generated from your document.';

  const COVER_BG: Record<string, string> = {
    PDF:  'linear-gradient(135deg, #FFB5A7 0%, #E8756A 100%)',
    DOCX: 'linear-gradient(135deg, #93C5FD 0%, #3B82F6 100%)',
    DOC:  'linear-gradient(135deg, #93C5FD 0%, #3B82F6 100%)',
    MP3:  'linear-gradient(135deg, #C4B5FD 0%, #8B5CF6 100%)',
    M4A:  'linear-gradient(135deg, #C4B5FD 0%, #8B5CF6 100%)',
    TXT:  'linear-gradient(135deg, #BBF7D0 0%, #16A34A 100%)',
  };
  const coverGrad = COVER_BG[fileType] ?? 'linear-gradient(135deg, #86EFAC 0%, #16A34A 100%)';
  const coverIcon = fileType === 'PDF' ? '📄'
    : (fileType === 'MP3' || fileType === 'M4A') ? '🎵'
    : (fileType === 'DOCX' || fileType === 'DOC') ? '📝'
    : '📚';

  const MODES = [
    { id: 'tutor',      emoji: '🎓', bg: '#FFF8EC', title: 'Tutor me',   desc: 'Chat with an AI tutor about this content' },
    { id: 'flashcards', emoji: '🃏', bg: '#EEF6FF', title: 'Flashcards', desc: 'AI-generated flip cards to test your memory' },
    { id: 'activities', emoji: '🎮', bg: '#EDFAF3', title: 'Activities',  desc: 'Interactive learning components', recommended: true },
    { id: 'quiz',       emoji: '🧠', bg: '#FFF7ED', title: 'Quiz me',     desc: 'Multiple-choice questions from the content' },
    { id: 'podcast',    emoji: '🎙️', bg: '#F5F0FF', title: 'Podcast',     desc: 'AI-generated audio lesson', soon: true },
  ];

  const handleMode = (id: string, soon?: boolean) => {
    if (soon) return;
    if (id === 'tutor') { onOpenTutor(); return; }
    const mode: 'activities' | 'flashcards' | 'quiz' =
      id === 'flashcards' ? 'flashcards' : id === 'quiz' ? 'quiz' : 'activities';
    onGenerate(mode);
  };

  const leftPanel = (
    <div style={{ padding: isMobile ? '24px 20px' : '40px 48px', display: 'flex', flexDirection: 'column', borderRight: isMobile ? 'none' : '1px solid var(--line)' }}>
      <button onClick={onBack} className="btn btn-ghost"
        style={{ alignSelf: 'flex-start', gap: 8, marginBottom: 28, padding: '6px 0', color: 'var(--ink-2)', fontSize: 14, fontWeight: 600 }}>
        <Icon name="arrow-left" size={16} /> Back to library
      </button>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 22 }}>
        <span style={{ padding: '5px 12px', borderRadius: 999, background: 'var(--bg-tint)', border: '1px solid var(--line)', fontSize: 12, color: 'var(--ink-2)', fontWeight: 600 }}>
          📚 {folderLabel}
        </span>
        <Chip color="brand">{fileType}</Chip>
        <Chip color="gold">~12 min</Chip>
      </div>

      <h1 className="display" style={{ fontSize: isMobile ? 40 : 56, lineHeight: 1.05, letterSpacing: '-0.025em', marginBottom: 18 }}>
        {titleMain && <span style={{ color: 'var(--ink)' }}>{titleMain} </span>}
        <span style={{ color: 'var(--brand)' }}>{titleAccent}</span>
      </h1>

      <p style={{ color: 'var(--ink-2)', lineHeight: 1.7, fontSize: 15, marginBottom: 28 }}>{shortDesc}</p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 36 }}>
        {estPages && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', border: '1px solid var(--line)', borderRadius: 12, fontSize: 13, fontWeight: 600, color: 'var(--ink-2)' }}>
            <Icon name="file" size={15} stroke="var(--ink-3)" /> {estPages} pages
          </div>
        )}
        {fileType === 'PDF' && estPages && estPages > 32 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', border: '1px dashed var(--coral-soft)', borderRadius: 12, fontSize: 12, color: 'var(--coral)' }}>
            ⚠ Large PDF — first 32 pages only
          </div>
        )}
        {fileType !== 'PDF' && isLargeDoc && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', border: '1px dashed var(--line-2)', borderRadius: 12, fontSize: 12, color: 'var(--ink-3)' }}>
            📄 Large doc — key highlights only
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: 12, fontSize: 13, fontWeight: 600, color: 'var(--brand-2)', background: 'var(--brand-tint)', border: '1px solid var(--brand-soft)' }}>
          ✨ Ready to learn
        </div>
      </div>

      {audit && <QualityBadge audit={audit} />}

      {pdfBlobUrl ? (
        <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid var(--line)', minHeight: 380, flex: 1 }}>
          <iframe
            src={pdfBlobUrl}
            title="PDF preview"
            style={{ width: '100%', height: '100%', minHeight: 380, border: 'none', display: 'block' }}
          />
        </div>
      ) : (
        <div style={{ borderRadius: 20, overflow: 'hidden', background: coverGrad, padding: '40px 28px', textAlign: 'center' }}>
          <div style={{ fontSize: 52, marginBottom: 14, filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.18))' }}>{coverIcon}</div>
          <div style={{ fontWeight: 800, fontSize: 20, color: 'white', textShadow: '0 1px 6px rgba(0,0,0,0.28)', marginBottom: 6 }}>{titleClean}</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.78)', fontWeight: 500 }}>From {folderLabel}</div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 20, fontSize: 13, color: 'var(--error)', background: 'var(--error-soft)', border: '1px solid var(--error-line)', padding: '10px 14px', borderRadius: 10 }}>
          ⚠ {error} — select Activities to retry
        </div>
      )}
    </div>
  );

  const rightPanel = (
    <div style={{ padding: isMobile ? '8px 20px 32px' : '40px 48px', display: 'flex', flexDirection: 'column' }}>
      <h2 className="display" style={{ fontSize: 32, marginBottom: 8 }}>Learn this</h2>
      <p style={{ color: 'var(--ink-2)', fontSize: 14, marginBottom: 28, lineHeight: 1.6 }}>
        Choose how you want to study this content.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {MODES.map(m => (
          <button
            key={m.id}
            ref={'recommended' in m && m.recommended && error ? retryRef : undefined}
            onClick={() => handleMode(m.id, 'soon' in m ? m.soon : false)}
            disabled={'soon' in m && m.soon}
            onMouseEnter={() => { if (!('soon' in m && m.soon)) setHoveredMode(m.id); }}
            onMouseLeave={() => setHoveredMode(null)}
            style={{
              position: 'relative',
              padding: '18px 20px', borderRadius: 18,
              display: 'flex', alignItems: 'center', gap: 16,
              border: 'recommended' in m && m.recommended ? '2px solid var(--brand)' : '1.5px solid var(--line)',
              background: 'var(--card)',
              textAlign: 'left',
              cursor: 'soon' in m && m.soon ? 'default' : 'pointer',
              opacity: 'soon' in m && m.soon ? 0.55 : 1,
              transition: 'box-shadow 0.15s, transform 0.12s',
              boxShadow: hoveredMode === m.id ? '0 4px 20px rgba(0,0,0,0.08)' : 'none',
              transform: hoveredMode === m.id ? 'translateY(-1px)' : 'none',
              outline: 'none',
            }}>
            {'recommended' in m && m.recommended && (
              <div style={{ position: 'absolute', top: -11, left: 18, background: 'var(--brand)', color: 'white', fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', padding: '2px 10px', borderRadius: 6 }}>
                RECOMMENDED
              </div>
            )}
            <div style={{ width: 50, height: 50, borderRadius: 14, background: m.bg, display: 'grid', placeItems: 'center', fontSize: 24, flexShrink: 0 }}>
              {m.emoji}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)', marginBottom: 2 }}>{m.title}</div>
              <div style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5 }}>{m.desc}</div>
            </div>
            {'soon' in m && m.soon
              ? <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-4)', background: 'var(--bg-tint)', padding: '3px 8px', borderRadius: 6, border: '1px solid var(--line)', flexShrink: 0 }}>SOON</span>
              : <Icon name="chevron-right" size={18} stroke="var(--ink-4)" />
            }
          </button>
        ))}
      </div>

      {profile && (
        <div style={{ marginTop: 20, padding: 16, borderRadius: 16, background: 'var(--brand-tint)', border: '1px solid var(--brand-soft)', display: 'flex', gap: 10 }}>
          <span style={{ fontSize: 18 }}>✨</span>
          <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
            Based on your cognitive profile, Sprout suggests{' '}
            <span style={{ fontWeight: 700, color: 'var(--brand-2)' }}>Activities</span>
            {' '}— it matches how you learn best.
          </div>
        </div>
      )}

      {fromCache && (
        <button className="btn btn-ghost btn-block" onClick={onRegenerate} style={{ marginTop: 14, fontSize: 13 }}>
          ↺ Regenerate fresh content
        </button>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <div style={{ overflowY: 'auto' }}>
        {leftPanel}
        {rightPanel}
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'grid', gridTemplateColumns: '55% 45%' }}>
      <div style={{ overflowY: 'auto' }}>{leftPanel}</div>
      <div style={{ overflowY: 'auto' }}>{rightPanel}</div>
    </div>
  );
}

// ── Quality badge ─────────────────────────────────────────────

function QualityBadge({ audit }: { audit: FeedAudit }) {
  const scoreColor = (s: number) =>
    s >= 75 ? 'var(--brand)' : s >= 50 ? 'var(--gold)' : 'var(--coral)';
  const scoreBg = (s: number) =>
    s >= 75 ? 'var(--brand-tint)' : s >= 50 ? '#FFFBEB' : 'var(--coral-soft)';

  const pills = [
    { label: 'Coverage', value: audit.coverageScore },
    { label: 'Accuracy', value: audit.accuracyScore },
    { label: 'Depth',    value: audit.depthScore    },
  ];

  return (
    <div style={{ marginBottom: 24, padding: '14px 16px', borderRadius: 14, background: 'var(--bg-tint)', border: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.07em', color: 'var(--ink-3)', textTransform: 'uppercase' }}>
          Content Quality
        </div>
        <div style={{ fontSize: 13, fontWeight: 800, color: scoreColor(audit.overallScore), fontFamily: 'var(--font-mono)' }}>
          {audit.overallScore}/100
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {pills.map(p => (
          <div key={p.label} style={{ padding: '8px 10px', borderRadius: 10, background: scoreBg(p.value), textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: scoreColor(p.value), fontFamily: 'var(--font-mono)', lineHeight: 1 }}>
              {p.value}
            </div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ink-3)', marginTop: 3, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {p.label}
            </div>
          </div>
        ))}
      </div>
      {audit.missedTopics && audit.missedTopics.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.5 }}>
          Not covered: {audit.missedTopics.join(' · ')}
        </div>
      )}
    </div>
  );
}

// ── Feed loading ──────────────────────────────────────────────

function FeedLoading({ topic }: { topic: string }) {
  const STEPS = ['Reading your content…', 'Matching to your learning profile…', 'Crafting your feed…'];
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStep(s => Math.min(s + 1, STEPS.length - 1)), 3500);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 24 }}>
      <div style={{ textAlign: 'center', maxWidth: 360 }}>
        <div style={{ position: 'relative', width: 96, height: 96, margin: '0 auto 24px' }}>
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '4px solid var(--brand-soft)', borderTopColor: 'var(--brand)', animation: 'spin 1s linear infinite' }} />
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <SproutMark size={52} />
          </div>
        </div>
        <h2 className="display" style={{ fontSize: 22, marginBottom: 6 }}>Generating your feed</h2>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 24 }}>{topic} · Usually 10–20 s</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'left' }}>
          {STEPS.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14, color: i <= step ? 'var(--ink)' : 'var(--ink-4)', transition: 'color 0.4s' }}>
              <div style={{
                width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                display: 'grid', placeItems: 'center', transition: 'background 0.4s',
                background: i < step ? 'var(--brand)' : i === step ? 'var(--brand-tint)' : 'var(--line)',
                border: i === step ? '2px solid var(--brand)' : 'none',
              }}>
                {i < step && <Icon name="check" size={12} stroke="white" />}
              </div>
              <span style={{ fontWeight: i <= step ? 600 : 400 }}>{s}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Card shell ────────────────────────────────────────────────

const CARD_META: Record<string, { chip: string; color: string; icon: string }> = {
  summary:        { chip: 'Summary',        color: 'brand', icon: '📝' },
  flashcard:      { chip: 'Flashcard',      color: 'sky',   icon: '🃏' },
  concept:        { chip: 'Concept',        color: 'plum',  icon: '💡' },
  worked_example: { chip: 'Worked Example', color: 'gold',  icon: '🔍' },
  fill_blank:     { chip: 'Fill the Blank', color: 'coral', icon: '✏️' },
  diagram:        { chip: 'Diagram',        color: 'plum',  icon: '🎨' },
  animation:      { chip: 'Animation',      color: 'gold',  icon: '🎬' },
  quiz:           { chip: 'Quiz',           color: 'coral', icon: '✅' },
};

function CardView({ card, idx, total, topic, content, profile, onCorrect, onWrong, onRated, onPrev, onNext }: {
  card: FeedCard; idx: number; total: number;
  topic: string; content: string | null; profile: LearnerProfile | null;
  onCorrect: () => void; onWrong: () => void;
  onRated: (d: 'easy' | 'medium' | 'hard') => void;
  onPrev: () => void; onNext: () => void;
}) {
  const meta = CARD_META[card.type] ?? { chip: card.type, color: 'brand', icon: '📚' };

  return (
    <div className="card fade-up" style={{ padding: 28, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <Chip color={meta.color as import('../components/Chip').ChipColor}>
          {meta.icon} {meta.chip}
        </Chip>
        <span style={{ fontSize: 12, color: 'var(--ink-3)', fontWeight: 600 }}>{idx + 1} / {total}</span>
      </div>

      {card.type === 'summary'        && <SummaryCard       card={card} />}
      {card.type === 'flashcard'      && <FlashCard          card={card} onRated={onRated} />}
      {card.type === 'concept'        && <ConceptCard        card={card} />}
      {card.type === 'worked_example' && <WorkedExampleCard  card={card} />}
      {card.type === 'fill_blank'     && <FillBlankCard      card={card} onRated={onRated} />}
      {card.type === 'diagram'        && <DiagramCard        card={card} />}
      {card.type === 'animation'      && <AnimationCard      card={card} />}
      {card.type === 'quiz'           && <QuizCard           card={card} onCorrect={onCorrect} onWrong={onWrong} />}

      <div style={{ display: 'flex', gap: 10, marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--line)' }}>
        <button className="btn btn-secondary" onClick={onPrev} disabled={idx === 0}>
          <Icon name="arrow-left" size={16} /> Prev
        </button>
        <button className="btn btn-primary" onClick={onNext} style={{ flex: 1 }}>
          {idx + 1 === total ? 'Finish' : 'Next'} <Icon name="arrow-right" size={16} />
        </button>
      </div>

      <InlineChat key={idx} card={card} topic={topic} content={content} profile={profile} />
    </div>
  );
}

// ── Inline card chat ──────────────────────────────────────────

function InlineChat({ card, topic, content, profile }: {
  card: FeedCard; topic: string; content: string | null; profile: LearnerProfile | null;
}) {
  const [open,      setOpen]      = useState(false);
  const [messages,  setMessages]  = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, open]);

  const cardDesc = topicLabel(card);
  const sys      = buildChatSystemPrompt(topic, content, cardDesc, profile);

  const handleSend = async (text: string) => {
    const userMsg: ChatMessage = { role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setStreaming(true);
    let out = '';
    try {
      await streamCardChat(history, sys, chunk => {
        out += chunk;
        setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: 'assistant', content: out }; return u; });
      });
    } catch {
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 13, fontWeight: 600, color: 'var(--ink-3)',
          padding: '4px 0', width: '100%',
        }}
      >
        <Icon name="sparkle" size={14} stroke="var(--brand)" />
        <span style={{ color: 'var(--brand)' }}>Ask about this card</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} stroke="var(--ink-4)" />
      </button>

      {open && (
        <div className="fade-up" style={{ marginTop: 10 }}>
          <div style={{
            maxHeight: 260, overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8,
            marginBottom: 10, padding: '4px 0',
          }}>
            {messages.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--ink-4)', textAlign: 'center', padding: '12px 0' }}>
                Ask anything about this card
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '86%',
                padding: '8px 12px',
                borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '4px 14px 14px 14px',
                background: m.role === 'user' ? 'var(--brand)' : 'var(--bg-tint)',
                border: m.role === 'assistant' ? '1px solid var(--line)' : 'none',
                color: m.role === 'user' ? 'white' : 'var(--ink)',
                fontSize: 13, lineHeight: 1.6,
              }}>
                {m.content || (streaming && i === messages.length - 1 ? <TypingDots /> : null)}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <ChatInput onSend={handleSend} disabled={streaming} placeholder="Ask about this card…" />
        </div>
      )}
    </div>
  );
}

// ── Summary card ──────────────────────────────────────────────

function SummaryCard({ card }: { card: Extract<FeedCard, { type: 'summary' }> }) {
  return (
    <>
      <h2 className="display" style={{ fontSize: 26, marginBottom: 18, lineHeight: 1.2 }}>{card.title}</h2>
      <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {card.points.map((p, i) => (
          <li key={i} style={{ display: 'flex', gap: 14, padding: '14px 16px', background: 'var(--bg-tint)', borderRadius: 14, borderLeft: '3px solid var(--brand)' }}>
            <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--brand)', color: 'white', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{i + 1}</div>
            <div style={{ flex: 1, lineHeight: 1.6, fontSize: 14, color: 'var(--ink)' }}>{p}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

// ── Flashcard ─────────────────────────────────────────────────

function FlashCard({ card, onRated }: {
  card: Extract<FeedCard, { type: 'flashcard' }>;
  onRated: (d: 'easy' | 'medium' | 'hard') => void;
}) {
  const [flipped, setFlipped] = useState(false);
  const [rated,   setRated]   = useState(false);

  return (
    <>
      <button
        onClick={() => setFlipped(f => !f)}
        aria-label={flipped ? `Answer: ${card.answer}. Press to show question.` : `Question: ${card.question}. Press to reveal answer.`}
        aria-pressed={flipped}
        style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, perspective: 1200, marginBottom: 16, borderRadius: 18 }}
      >
        <div style={{ position: 'relative', minHeight: 200, transition: 'transform 0.55s', transformStyle: 'preserve-3d', transform: flipped ? 'rotateY(180deg)' : 'none' }}>
          <FlashFace>
            <div className="display" style={{ fontSize: 22, lineHeight: 1.35, color: 'var(--ink)' }}>{card.question}</div>
            <div style={{ marginTop: 14, fontSize: 12, color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="rotate" size={13} /> Tap to reveal answer
            </div>
          </FlashFace>
          <FlashFace back>
            <div style={{ fontSize: 17, lineHeight: 1.65, color: 'var(--ink)' }}>{card.answer}</div>
          </FlashFace>
        </div>
      </button>

      {flipped && !rated && (
        <div className="fade-up" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          {([
            { d: 'hard',   c: 'coral', emoji: '😰', label: 'Hard',   pts: 5 },
            { d: 'medium', c: 'gold',  emoji: '🤔', label: 'Medium', pts: 10 },
            { d: 'easy',   c: 'brand', emoji: '😊', label: 'Easy',   pts: 15 },
          ] as const).map(o => (
            <button key={o.d} className="btn btn-secondary"
              style={{ padding: '14px 0', flexDirection: 'column', gap: 4, borderColor: `var(--${o.c}-soft)` }}
              onClick={() => { setRated(true); onRated(o.d); }}>
              <span style={{ fontSize: 22 }}>{o.emoji}</span>
              <span style={{ fontWeight: 700, color: `var(--${o.c})`, fontSize: 12 }}>{o.label}</span>
              <span style={{ fontSize: 10, color: 'var(--ink-4)' }}>+{o.pts} pts</span>
            </button>
          ))}
        </div>
      )}
      {flipped && rated && (
        <div className="fade-up" style={{ textAlign: 'center', fontSize: 13, color: 'var(--ink-3)', padding: 8 }}>
          ✓ Rated — tap Next to continue
        </div>
      )}
    </>
  );
}

function FlashFace({ back, children }: { back?: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      position: back ? 'absolute' : 'relative', inset: 0,
      backfaceVisibility: 'hidden', transform: back ? 'rotateY(180deg)' : 'none',
      background: back ? 'var(--brand-tint)' : 'var(--card-soft)',
      border: '1px solid var(--line)', borderRadius: 18,
      padding: 32, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', textAlign: 'center',
      minHeight: 200, boxSizing: 'border-box',
    }}>{children}</div>
  );
}

// ── Concept card ─────────────────────────────────────────────

function ConceptCard({ card }: { card: Extract<FeedCard, { type: 'concept' }> }) {
  return (
    <>
      <h2 className="display" style={{ fontSize: 24, marginBottom: 16, lineHeight: 1.25 }}>{card.title}</h2>

      <p style={{ fontSize: 15, lineHeight: 1.8, color: 'var(--ink)', marginBottom: 20 }}>{card.explanation}</p>

      <div style={{ background: 'var(--brand-tint)', border: '1px solid var(--brand-soft)', borderRadius: 14, padding: '14px 18px', marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', color: 'var(--brand-2)', marginBottom: 6, textTransform: 'uppercase' }}>💡 Example</div>
        <p style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--ink)', margin: 0 }}>{card.example}</p>
      </div>

      <div style={{ background: '#FFFBEB', border: '1px solid rgba(244,183,64,0.35)', borderRadius: 14, padding: '14px 18px', marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', color: 'var(--gold)', marginBottom: 6, textTransform: 'uppercase' }}>🧩 Analogy</div>
        <p style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--ink)', margin: 0 }}>{card.analogy}</p>
      </div>

      {card.keyTerms && card.keyTerms.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', color: 'var(--ink-3)', marginBottom: 10, textTransform: 'uppercase' }}>Key Terms</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {card.keyTerms.map((kt, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 14px', background: 'var(--bg-tint)', borderRadius: 10, border: '1px solid var(--line)' }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--brand)', flexShrink: 0, minWidth: 110 }}>{kt.term}</span>
                <span style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>{kt.definition}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ── Worked example card ───────────────────────────────────────

function WorkedExampleCard({ card }: { card: Extract<FeedCard, { type: 'worked_example' }> }) {
  return (
    <>
      <h2 className="display" style={{ fontSize: 22, marginBottom: 16 }}>{card.title}</h2>

      <div style={{ background: 'var(--card-soft)', border: '1px solid var(--line)', borderRadius: 14, padding: '14px 18px', marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', color: 'var(--ink-3)', marginBottom: 8, textTransform: 'uppercase' }}>Problem</div>
        <p style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--ink)', margin: 0, fontWeight: 500 }}>{card.problem}</p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
        {card.steps.map((step, i) => (
          <div key={i} style={{ display: 'flex', gap: 14, padding: '12px 16px', background: 'var(--bg-tint)', borderRadius: 12, border: '1px solid var(--line)' }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--brand)', color: 'white', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 13, flexShrink: 0 }}>{i + 1}</div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-3)', marginBottom: 3 }}>{step.label}</div>
              <div style={{ fontSize: 14, color: 'var(--ink)', lineHeight: 1.65 }}>{step.content}</div>
            </div>
          </div>
        ))}
      </div>

      {card.insight && (
        <div style={{ background: 'var(--brand)', borderRadius: 14, padding: '14px 18px' }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.65)', marginBottom: 6, textTransform: 'uppercase' }}>💡 Key Insight</div>
          <p style={{ fontSize: 14, lineHeight: 1.65, color: 'white', margin: 0, fontWeight: 500 }}>{card.insight}</p>
        </div>
      )}
    </>
  );
}

// ── Fill-in-the-blank card ────────────────────────────────────

function FillBlankCard({ card, onRated }: {
  card: Extract<FeedCard, { type: 'fill_blank' }>;
  onRated: (d: 'easy' | 'medium' | 'hard') => void;
}) {
  const [inputs,    setInputs]    = useState<string[]>(card.blanks.map(() => ''));
  const [submitted, setSubmitted] = useState(false);
  const [showHint,  setShowHint]  = useState(false);
  const [scored,    setScored]    = useState(false);

  const parts   = card.sentence.split('_____');
  const results = inputs.map((inp, i) => inp.trim().toLowerCase() === card.blanks[i]?.toLowerCase());
  const allCorrect = results.every(Boolean);

  const submit = () => {
    if (inputs.some(v => !v.trim())) return;
    setSubmitted(true);
    if (!scored) { setScored(true); onRated(allCorrect ? 'easy' : 'hard'); }
  };

  return (
    <>
      <h2 className="display" style={{ fontSize: 22, marginBottom: 6 }}>Fill in the blanks</h2>
      <p style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 22 }}>Complete the sentence with the correct words.</p>

      <div style={{ fontSize: 16, lineHeight: 2.8, marginBottom: 20, background: 'var(--bg-tint)', borderRadius: 14, padding: '20px 22px', border: '1px solid var(--line)' }}>
        {parts.map((part, i) => (
          <span key={i}>
            {part}
            {i < card.blanks.length && (
              <input
                value={inputs[i]}
                onChange={e => { const n = [...inputs]; n[i] = e.target.value; setInputs(n); }}
                onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                disabled={submitted}
                placeholder="  ?  "
                aria-label={`Blank ${i + 1}`}
                style={{
                  display: 'inline-block',
                  width: Math.max(80, (card.blanks[i]?.length ?? 6) * 11 + 24),
                  margin: '0 4px',
                  padding: '3px 10px',
                  borderRadius: 8,
                  border: submitted
                    ? `2px solid ${results[i] ? 'var(--brand)' : 'var(--coral)'}`
                    : '2px solid var(--brand)',
                  background: submitted
                    ? results[i] ? 'var(--brand-tint)' : 'var(--coral-soft)'
                    : 'white',
                  fontSize: 15,
                  fontWeight: 700,
                  color: submitted ? (results[i] ? 'var(--brand-2)' : 'var(--coral)') : 'var(--ink)',
                  textAlign: 'center',
                  outline: 'none',
                  verticalAlign: 'middle',
                }}
              />
            )}
          </span>
        ))}
      </div>

      {!submitted && (
        <div style={{ marginBottom: 16 }}>
          <button className="btn btn-ghost" onClick={() => setShowHint(h => !h)} style={{ fontSize: 13, padding: '6px 12px' }}>
            {showHint ? 'Hide hint' : '💡 Show hint'}
          </button>
          {showHint && (
            <div className="fade-up" style={{ marginTop: 8, fontSize: 13, color: 'var(--ink-2)', background: '#FFFBEB', padding: '10px 14px', borderRadius: 10, border: '1px solid rgba(244,183,64,0.35)' }}>
              {card.hint}
            </div>
          )}
        </div>
      )}

      {!submitted ? (
        <button className="btn btn-primary btn-block" onClick={submit} disabled={inputs.some(v => !v.trim())} style={{ fontSize: 14 }}>
          Check answers
        </button>
      ) : (
        <div aria-live="polite" className="fade-up" style={{ padding: 16, borderRadius: 14, background: allCorrect ? 'var(--brand-tint)' : 'var(--coral-soft)', borderLeft: `4px solid ${allCorrect ? 'var(--brand)' : 'var(--coral)'}` }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: allCorrect ? 'var(--brand-2)' : 'var(--coral)' }}>
            {allCorrect ? '✅ Perfect!' : '❌ Not quite'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
            Correct answers: <strong>{card.blanks.join(', ')}</strong>
          </div>
        </div>
      )}
    </>
  );
}

// ── Diagram card ──────────────────────────────────────────────

function DiagramCard({ card }: { card: Extract<FeedCard, { type: 'diagram' }> }) {
  const nodes = card.nodes.slice(0, 7);
  const n = nodes.length;
  const cx = 300, cy = 185, R = 128, nodeR = 38;

  return (
    <>
      <h2 className="display" style={{ fontSize: 22, marginBottom: 16 }}>{card.title}</h2>
      <div style={{ background: 'var(--bg-tint)', borderRadius: 18, padding: 12, border: '1px solid var(--line)', overflowX: 'auto' }}>
        <svg viewBox="0 0 600 370" style={{ width: '100%', minWidth: 280, height: 'auto' }} aria-hidden="true">
          {nodes.map((_, i) => {
            const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
            return <line key={i} x1={cx} y1={cy} x2={cx + R * Math.cos(angle)} y2={cy + R * Math.sin(angle)} stroke="var(--line-2)" strokeWidth="1.5" />;
          })}
          <ellipse cx={cx} cy={cy} rx={76} ry={38} fill="var(--brand-soft)" stroke="var(--brand)" strokeWidth="2" />
          <text x={cx} y={cy + 5} textAnchor="middle" fontWeight="800" fontSize="13" fill="var(--brand-2)">
            {card.center.length > 16 ? card.center.slice(0, 16) + '…' : card.center}
          </text>
          {nodes.map((node, i) => {
            const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
            const nx = cx + R * Math.cos(angle);
            const ny = cy + R * Math.sin(angle);
            return (
              <g key={i}>
                <circle cx={nx} cy={ny} r={nodeR} fill="var(--card)" stroke="var(--line-2)" strokeWidth="1.5" />
                <text x={nx} y={ny - 4} textAnchor="middle" fontSize="18">{node.emoji}</text>
                <text x={nx} y={ny + 15} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--ink)">
                  {node.label.length > 10 ? node.label.slice(0, 10) + '…' : node.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </>
  );
}

// ── Animation card ────────────────────────────────────────────

function AnimationCard({ card }: { card: Extract<FeedCard, { type: 'animation' }> }) {
  const [step,    setStep]    = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing || step >= card.steps.length - 1) return;
    const t = setTimeout(() => setStep(s => s + 1), 2400);
    return () => clearTimeout(t);
  }, [step, playing, card.steps.length]);

  const s = card.steps[step];

  return (
    <>
      <h2 className="display" style={{ fontSize: 22, marginBottom: 16 }}>{card.title}</h2>
      <div style={{ background: 'var(--bg-tint)', borderRadius: 18, padding: 24, border: '1px solid var(--line)', minHeight: 180, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 18, animation: 'fadeUp 0.35s ease' }}>
          <div style={{ width: 64, height: 64, borderRadius: 18, background: 'var(--brand)', display: 'grid', placeItems: 'center', fontSize: 30, flexShrink: 0 }}>
            {s.icon}
          </div>
          <div>
            <div className="label-eyebrow" style={{ marginBottom: 6 }}>Step {step + 1} / {card.steps.length}</div>
            <h3 className="display" style={{ fontSize: 18, marginBottom: 6 }}>{s.title}</h3>
            <p style={{ color: 'var(--ink-2)', fontSize: 14, lineHeight: 1.6, margin: 0 }}>{s.description}</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 20, justifyContent: 'center' }}>
          {card.steps.map((_, i) => (
            <button key={i} onClick={() => setStep(i)} aria-label={`Step ${i + 1}`}
              style={{ width: i === step ? 28 : 10, height: 10, borderRadius: 999, background: i === step ? 'var(--brand)' : 'var(--line-2)', transition: 'all 0.2s', border: 'none', cursor: 'pointer', padding: 0 }} />
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
        <button className="btn btn-secondary" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0} style={{ padding: '8px 14px' }}>
          <Icon name="chevron-left" size={16} />
        </button>
        <button className="btn btn-secondary" onClick={() => setPlaying(p => !p)} style={{ padding: '8px 16px' }}>
          <Icon name={playing ? 'pause' : 'play'} size={16} /> {playing ? 'Pause' : 'Play'}
        </button>
        <button className="btn btn-secondary" onClick={() => setStep(Math.min(card.steps.length - 1, step + 1))} disabled={step === card.steps.length - 1} style={{ padding: '8px 14px' }}>
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
    </>
  );
}

// ── Quiz card ─────────────────────────────────────────────────

function QuizCard({ card, onCorrect, onWrong }: {
  card: Extract<FeedCard, { type: 'quiz' }>;
  onCorrect: () => void; onWrong: () => void;
}) {
  const [pick,      setPick]      = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const isCorrect = pick === card.correctIndex;

  const submit = () => {
    if (pick === null) return;
    setSubmitted(true);
    pick === card.correctIndex ? onCorrect() : onWrong();
  };

  return (
    <>
      <h2 className="display" style={{ fontSize: 22, marginBottom: 20, lineHeight: 1.3 }}>{card.question}</h2>
      <div role="radiogroup" aria-label="Answer options" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {card.options.map((opt, i) => {
          let state: 'idle' | 'selected' | 'correct' | 'wrong' = 'idle';
          if (submitted) {
            if (i === card.correctIndex) state = 'correct';
            else if (i === pick) state = 'wrong';
          } else if (pick === i) state = 'selected';

          const colors = {
            idle:     { bg: 'var(--card-soft)', bd: 'var(--line)',  fg: 'var(--ink)'     },
            selected: { bg: 'var(--brand-tint)', bd: 'var(--brand)', fg: 'var(--brand-2)' },
            correct:  { bg: 'var(--brand-soft)', bd: 'var(--brand)', fg: 'var(--brand-2)' },
            wrong:    { bg: 'var(--coral-soft)', bd: 'var(--coral)', fg: 'var(--coral)'   },
          }[state];

          return (
            <button key={i} role="radio" aria-checked={pick === i}
              disabled={submitted} onClick={() => setPick(i)}
              style={{
                padding: '14px 16px', borderRadius: 14,
                background: colors.bg, border: `2px solid ${colors.bd}`, color: colors.fg,
                display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left',
                fontSize: 14, fontWeight: 600, transition: 'all 0.18s',
                cursor: submitted ? 'default' : 'pointer',
              }}>
              <div style={{
                width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                background: state === 'idle' ? 'var(--card)' : colors.bd,
                color: state === 'idle' ? 'var(--ink-2)' : 'white',
                display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 13,
                border: `1px solid ${colors.bd}`,
              }}>
                {state === 'correct' ? <Icon name="check" size={14} stroke="white" />
                : state === 'wrong'  ? <Icon name="close" size={14} stroke="white" />
                : String.fromCharCode(65 + i)}
              </div>
              <span style={{ flex: 1 }}>{opt}</span>
            </button>
          );
        })}
      </div>

      {!submitted ? (
        <button className="btn btn-primary btn-block" disabled={pick === null} onClick={submit} style={{ fontSize: 14 }}>
          Submit answer
        </button>
      ) : (
        <div aria-live="polite" className="fade-up" style={{
          padding: 16, borderRadius: 14,
          background: isCorrect ? 'var(--brand-tint)' : 'var(--coral-soft)',
          borderLeft: `4px solid ${isCorrect ? 'var(--brand)' : 'var(--coral)'}`,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: isCorrect ? 'var(--brand-2)' : 'var(--coral)' }}>
            {isCorrect ? '✅ Correct!' : '❌ Not quite'}
          </div>
          <div style={{ color: 'var(--ink-2)', lineHeight: 1.6, fontSize: 14 }}>{card.explanation}</div>
        </div>
      )}
    </>
  );
}

// ── Completion view ───────────────────────────────────────────

function CompletionView({ cards, score, audit, elapsed, onBack, onRestart }: {
  cards: FeedCard[]; score: number; audit: FeedAudit | null; elapsed: number;
  onBack: () => void; onRestart: () => void;
}) {
  const mins    = Math.floor(elapsed / 60000);
  const secs    = Math.floor((elapsed % 60000) / 1000);
  const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;

  return (
    <div className="card fade-up" style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 64, marginBottom: 14, animation: 'pop 0.6s ease' }}>🌱</div>
      <h2 className="display" style={{ fontSize: 32, marginBottom: 8 }}>Great work!</h2>
      <p style={{ color: 'var(--ink-2)', marginBottom: 28, fontSize: 15 }}>Your sprout grew a little taller today.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 28 }}>
        {([
          { v: cards.length, l: 'Cards',  c: 'brand' },
          { v: score,        l: 'Points', c: 'gold'  },
          { v: timeStr,      l: 'Time',   c: 'sky'   },
        ] as const).map((s, i) => (
          <div key={i} style={{ padding: 18, borderRadius: 16, background: `var(--${s.c}-soft)` }}>
            <div className="display" style={{ fontSize: 28, color: `var(--${s.c})`, marginBottom: 4 }}>{s.v}</div>
            <div className="label-eyebrow">{s.l}</div>
          </div>
        ))}
      </div>
      {audit && (
        <div style={{ marginBottom: 28, textAlign: 'left' }}>
          <QualityBadge audit={audit} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <button className="btn btn-secondary" onClick={onRestart}>
          <Icon name="rotate" size={16} /> Review again
        </button>
        <button className="btn btn-primary" onClick={onBack}>
          Done <Icon name="arrow-right" size={16} />
        </button>
      </div>
    </div>
  );
}

// ── API key gate ──────────────────────────────────────────────

function ApiKeyGate({ onSave }: { onSave: () => void }) {
  const [key, setKey] = useState('');
  return (
    <div style={{ display: 'grid', placeItems: 'center', flex: 1, padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 40, textAlign: 'center' }}>🔑</div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Connect Claude API</div>
          <div style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6 }}>
            Sprout uses Claude to power AI features. Add your Anthropic API key to get started.
          </div>
        </div>
        <input className="input" value={key} onChange={e => setKey(e.target.value)}
          placeholder="sk-ant-api03-…"
          style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 12 }}
          aria-label="Anthropic API key" />
        <button className="btn btn-primary btn-block" disabled={!key.startsWith('sk-')}
          onClick={() => { saveApiKey(key.trim()); onSave(); }}>
          Save key
        </button>
        <p style={{ fontSize: 11, color: 'var(--ink-3)', textAlign: 'center', lineHeight: 1.6, margin: 0 }}>
          Get a key at <span style={{ fontFamily: 'var(--font-mono)' }}>console.anthropic.com</span>. Stored locally only.
        </p>
      </div>
    </div>
  );
}

// ── Tutor overlay (chat panel) ────────────────────────────────

function topicLabel(c: FeedCard): string {
  switch (c.type) {
    case 'summary':        return c.title;
    case 'flashcard':      return c.question;
    case 'concept':        return c.title;
    case 'worked_example': return c.title;
    case 'animation':      return c.title;
    case 'fill_blank':     return c.sentence;
    case 'quiz':           return c.question;
    case 'diagram':        return c.title;
    default:               return (c as { type: string }).type;
  }
}

function TutorOverlay({ topic, content, cards, profile, currentCard, onClose }: {
  topic: string; content: string | null; cards: FeedCard[]; profile: LearnerProfile | null;
  currentCard: FeedCard | undefined; onClose: () => void;
}) {
  const [messages,         setMessages]         = useState<ChatMessage[]>([]);
  const [streaming,        setStreaming]         = useState(false);
  const [error,            setError]             = useState('');
  const [showTopicPicker,  setShowTopicPicker]   = useState(false);
  const [pendingTopic,     setPendingTopic]      = useState('');
  const bottomRef  = useRef<HTMLDivElement>(null);
  const isMobile   = useIsMobile();

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const cardDesc = !currentCard ? `Study session on ${topic}`
    : currentCard.type === 'quiz'      ? `Quiz question: "${currentCard.question}"`
    : currentCard.type === 'flashcard' ? `Flashcard Q: "${currentCard.question}"`
    : `${currentCard.type} card about ${topic}`;

  const handleSend = async (text: string) => {
    setShowTopicPicker(false);
    setPendingTopic('');
    const userMsg: ChatMessage = { role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setStreaming(true); setError('');
    const sys = buildChatSystemPrompt(topic, content, cardDesc, profile);
    let out = '';
    try {
      await streamCardChat(history, sys, chunk => {
        out += chunk;
        setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: 'assistant', content: out }; return u; });
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setStreaming(false);
    }
  };

  const pickTopic = (label: string) => {
    setPendingTopic(label);
    setShowTopicPicker(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-modal)' as unknown as number, display: 'flex' }}>
      {/* Backdrop */}
      <div onClick={onClose} style={{ flex: 1, background: 'rgba(15,23,42,0.32)', backdropFilter: 'blur(2px)' }} />

      {/* Panel */}
      <div style={{
        width: isMobile ? '100vw' : 'min(680px, 55vw)',
        height: '100dvh', display: 'flex', flexDirection: 'column',
        background: 'var(--card)',
        boxShadow: '-12px 0 48px rgba(15,23,42,0.14)',
        animation: 'slideInRight 0.22s ease',
      }}>

        {/* Header */}
        <div style={{ padding: '0 16px', height: 56, flexShrink: 0, borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--brand)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <Icon name="sparkle" size={15} stroke="white" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Tutor</div>
            <div style={{ fontSize: 11, color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{topic}</div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 8, borderRadius: '50%', minWidth: 40, minHeight: 40 }} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 8px', display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--bg)' }}>
          {messages.length === 0 && (
            <div style={{ margin: 'auto', textAlign: 'center', padding: '0 24px' }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>🎓</div>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Ask your tutor</div>
              <div style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6 }}>
                Ask anything, or tap <strong>+</strong> to pick a card topic.
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              {m.role === 'assistant' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <div style={{ width: 20, height: 20, borderRadius: 6, background: 'var(--brand)', display: 'grid', placeItems: 'center' }}>
                    <Icon name="sparkle" size={11} stroke="white" />
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-3)' }}>Tutor</span>
                </div>
              )}
              <div style={{
                maxWidth: '82%', padding: '10px 14px',
                borderRadius: m.role === 'user' ? '18px 18px 4px 18px' : '4px 18px 18px 18px',
                background: m.role === 'user' ? 'var(--brand)' : 'var(--card)',
                border: m.role === 'assistant' ? '1px solid var(--line)' : 'none',
                color: m.role === 'user' ? 'white' : 'var(--ink)',
                fontSize: 13, lineHeight: 1.65,
                boxShadow: m.role === 'assistant' ? '0 1px 4px rgba(0,0,0,0.05)' : 'none',
              }}>
                {m.content || (streaming && i === messages.length - 1 ? <TypingDots /> : null)}
              </div>
            </div>
          ))}
          {error && <div style={{ fontSize: 12, color: 'var(--error)', padding: '8px 12px', background: 'var(--error-soft)', borderRadius: 8 }}>{error}</div>}
          <div ref={bottomRef} />
        </div>

        {/* Input row with + topic picker */}
        <div style={{ padding: '10px 16px 16px', borderTop: '1px solid var(--line)', background: 'var(--card)', flexShrink: 0, position: 'relative' }}>

          {/* Topic picker popover */}
          {showTopicPicker && cards.length > 0 && (
            <div className="fade-up" style={{
              position: 'absolute', bottom: '100%', left: 16, right: 16, marginBottom: 8,
              background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14,
              boxShadow: '0 8px 32px rgba(15,23,42,0.12)',
              maxHeight: 280, overflowY: 'auto',
              zIndex: 10,
            }}>
              <div style={{ padding: '10px 14px 6px', fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', color: 'var(--ink-4)', textTransform: 'uppercase' }}>
                Pick a topic
              </div>
              {cards.map((c, i) => {
                const meta  = CARD_META[c.type] ?? { icon: '📚' };
                const label = topicLabel(c);
                return (
                  <button key={i} onClick={() => pickTopic(label)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%',
                      padding: '8px 14px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-tint)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                  >
                    <span style={{ fontSize: 13, flexShrink: 0, paddingTop: 1 }}>{meta.icon}</span>
                    <span style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500, lineHeight: 1.45 }}>
                      {label.length > 70 ? label.slice(0, 70) + '…' : label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            {/* + button */}
            {cards.length > 0 && (
              <button
                onClick={() => setShowTopicPicker(p => !p)}
                title="Pick a topic"
                style={{
                  width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                  border: '1.5px solid var(--line)',
                  background: showTopicPicker ? 'var(--brand-tint)' : 'var(--card)',
                  color: showTopicPicker ? 'var(--brand)' : 'var(--ink-3)',
                  display: 'grid', placeItems: 'center',
                  cursor: 'pointer', fontSize: 20, fontWeight: 300, lineHeight: 1,
                  transition: 'background 0.12s, color 0.12s',
                }}>
                +
              </button>
            )}
            <div style={{ flex: 1 }}>
              <ChatInput
                onSend={handleSend}
                disabled={streaming}
                placeholder="Ask anything…"
                prefill={pendingTopic}
                onPrefillConsumed={() => setPendingTopic('')}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Shared primitives ─────────────────────────────────────────

function ChatInput({ onSend, disabled, placeholder, prefill, onPrefillConsumed }: {
  onSend: (t: string) => void; disabled: boolean; placeholder: string;
  prefill?: string; onPrefillConsumed?: () => void;
}) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prefill) {
      setInput(prefill);
      inputRef.current?.focus();
      onPrefillConsumed?.();
    }
  }, [prefill]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = () => { if (!input.trim() || disabled) return; onSend(input.trim()); setInput(''); };
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input ref={inputRef} className="input" value={input} onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        placeholder={placeholder} disabled={disabled} style={{ flex: 1, fontSize: 13 }} />
      <button className="btn btn-primary" onClick={send} disabled={!input.trim() || disabled}
        style={{ padding: '0 14px', minWidth: 44, minHeight: 44 }} aria-label="Send message">
        <Icon name="arrow-right" size={16} />
      </button>
    </div>
  );
}

function TypingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', height: 20 }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ink-3)', animation: 'dot-pulse 1.4s ease infinite', animationDelay: `${i * 0.2}s` }} />
      ))}
    </span>
  );
}
