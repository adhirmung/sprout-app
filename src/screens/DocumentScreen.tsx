import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { SproutMark } from '../components/Brand';
import { Chip } from '../components/Chip';
import { ProgressBar } from '../components/ProgressBar';
import {
  buildChatSystemPrompt,
  evaluateWrittenAnswer,
  generateBoosterCards,
  generateContentAudit,
  generateContentMap,
  generateFeed,
  generatePracticeQuiz,
  generateReading,
  generateVisualComponents,
  hasApiKey,
  saveApiKey,
  streamCardChat,
} from '../lib/claude';
import type { ChatMessage, ContentAudit, ContentMap, DocumentReading, FeedCard, FeedAudit, PracticeQuestion, PracticeQuiz, VisualComponent, VisualSet, WrittenEvaluation } from '../lib/claude';
import { dbLoadContent, dbLoadGeneratedCards, dbSaveContent, dbSaveGeneratedCards, fetchPdfBase64FromStorage } from '../lib/supabase';
import { Store, celebrate } from '../lib/store';
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
  const [phase,           setPhase]           = useState<'idle' | 'mapping' | 'map' | 'read-loading' | 'read' | 'loading' | 'running' | 'done' | 'practice' | 'visuals'>('idle');
  const [visualSet,       setVisualSet]       = useState<VisualSet | null>(null);
  const [contentMap,      setContentMap]      = useState<ContentMap | null>(null);
  const [documentReading, setDocumentReading] = useState<DocumentReading | null>(null);
  const [contentAudit,    setContentAudit]    = useState<ContentAudit | null>(null);
  const [auditLoading,    setAuditLoading]    = useState(false);
  const [gapLoading,      setGapLoading]      = useState(false);
  const [gapCardsAdded,   setGapCardsAdded]   = useState(0);
  const [cards,      setCards]      = useState<FeedCard[]>([]);
  const [audit,     setAudit]     = useState<FeedAudit | null>(null);
  const [idx,       setIdx]       = useState(0);
  const [score,       setScore]       = useState(0);
  const [streak,      setStreak]      = useState(0);
  const [quizCorrect, setQuizCorrect] = useState(0);
  const [quizTotal,   setQuizTotal]   = useState(0);
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

  // Preload cached content map and reading on mount (localStorage first, then Supabase)
  useEffect(() => {
    const cachedMap = Store.get<ContentMap | null>(`map:${sourceKey}`, null);
    if (cachedMap?.synthesis && Array.isArray(cachedMap.topics)) {
      setContentMap(cachedMap);
    } else if (userId) {
      dbLoadContent<ContentMap>(userId, sourceKey, 'map')
        .then(data => { if (data?.synthesis && Array.isArray(data.topics)) { Store.set(`map:${sourceKey}`, data); setContentMap(data); } })
        .catch(() => {});
    }

    const cachedReading = Store.get<DocumentReading | null>(`reading:${sourceKey}`, null);
    if (cachedReading?.topics?.length && cachedReading.topics[0]?.subtopics?.length) {
      setDocumentReading(cachedReading);
    } else if (userId) {
      dbLoadContent<DocumentReading>(userId, sourceKey, 'reading')
        .then(data => { if (data?.topics?.length && data.topics[0]?.subtopics?.length) { Store.set(`reading:${sourceKey}`, data); setDocumentReading(data); } })
        .catch(() => {});
    }

    const cachedAudit = Store.get<ContentAudit | null>(`audit:${sourceKey}`, null);
    if (cachedAudit && typeof cachedAudit.coverageScore === 'number') {
      setContentAudit(cachedAudit);
    } else if (userId) {
      dbLoadContent<ContentAudit>(userId, sourceKey, 'audit')
        .then(data => { if (data && typeof data.coverageScore === 'number') { Store.set(`audit:${sourceKey}`, data); setContentAudit(data); } })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, sourceKey]);

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

  // Auto-dismiss the gap-cards toast after 5 s
  useEffect(() => {
    if (gapCardsAdded <= 0) return;
    const t = setTimeout(() => setGapCardsAdded(0), 5000);
    return () => clearTimeout(t);
  }, [gapCardsAdded]);

  const generate = async (force = false, mode: 'activities' | 'flashcards' | 'quiz' = 'activities') => {
    setPhase('loading');
    setError('');
    setFromCache(false);

    // ── Activities → rich HTML5 visual components ──────────────
    if (mode === 'activities') {
      try {
        const cacheKey = `visuals:${sourceKey}`;
        if (!force) {
          // Check localStorage first (fast), then Supabase (authenticated users)
          const cached = Store.get<VisualSet | null>(cacheKey, null);
          if (cached && Array.isArray(cached.components) && cached.components.length > 0) {
            setVisualSet(cached); setFromCache(true); setPhase('visuals'); return;
          }
          if (userId) {
            const dbCached = await dbLoadContent<VisualSet>(userId, sourceKey, 'visuals').catch(() => null);
            if (dbCached && Array.isArray(dbCached.components) && dbCached.components.length > 0) {
              Store.set(cacheKey, dbCached);
              setVisualSet(dbCached); setFromCache(true); setPhase('visuals'); return;
            }
          }
        }
        let resolvedPdf = pdfBase64;
        if (!resolvedPdf && storagePath) resolvedPdf = await fetchPdfBase64FromStorage(storagePath).catch(() => null);
        if (fileType === 'PDF' && !resolvedPdf) throw new Error('Could not load PDF binary. Try re-uploading the file.');
        const vs = await generateVisualComponents(topic, content, resolvedPdf);
        Store.set(cacheKey, vs);
        if (userId) dbSaveContent(userId, sourceKey, 'visuals', vs).catch(console.error);
        setVisualSet(vs); setPhase('visuals');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Generation failed. Please retry.');
        setPhase('idle');
      }
      return;
    }

    // ── Flashcards / Quiz → existing card feed ─────────────────
    const modeKey = `${sourceKey}:feed:${mode}`;
    setScore(0); setStreak(0); setQuizCorrect(0); setQuizTotal(0);
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
      // Pass 2: background audit → auto-append gap cards
      void runTwoPassBoost(resolvedPdf, modeKey, result.cards);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed. Please retry.');
      setPhase('idle');
    }
  };

  const startLearning = async () => {
    const mapKey = `map:${sourceKey}`;
    // Serve from localStorage cache if available
    const cached = Store.get<ContentMap | null>(mapKey, null);
    if (cached?.synthesis && Array.isArray(cached.topics)) {
      setContentMap(cached);
      setPhase('map');
      return;
    }
    // Serve from Supabase cache for authenticated users
    if (userId) {
      const dbCached = await dbLoadContent<ContentMap>(userId, sourceKey, 'map').catch(() => null);
      if (dbCached?.synthesis && Array.isArray(dbCached.topics)) {
        Store.set(mapKey, dbCached);
        setContentMap(dbCached);
        setPhase('map');
        return;
      }
    }
    setPhase('mapping');
    setError('');
    try {
      let resolvedPdf = pdfBase64;
      if (!resolvedPdf && storagePath) {
        resolvedPdf = await fetchPdfBase64FromStorage(storagePath).catch(() => null);
      }
      if (fileType === 'PDF' && !resolvedPdf) {
        throw new Error('Could not load PDF binary. Try re-uploading the file.');
      }
      const map = await generateContentMap(topic, content, resolvedPdf);
      Store.set(mapKey, map);
      if (userId) dbSaveContent(userId, sourceKey, 'map', map).catch(console.error);
      setContentMap(map);
      setPhase('map');

      // Run audit in background — doesn't block the user
      void runAudit(map, resolvedPdf);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate topic map. Please retry.');
      setPhase('idle');
    }
  };

  const runAudit = async (map: ContentMap, resolvedPdf: string | null) => {
    const auditKey = `audit:${sourceKey}`;
    const cached = Store.get<ContentAudit | null>(auditKey, null);
    if (cached && typeof cached.coverageScore === 'number') { setContentAudit(cached); return; }
    setAuditLoading(true);
    try {
      // Use text content for the audit — no need to re-send the PDF binary
      // (the map comparison only needs extractable text, not images).
      // Only fall back to PDF if there is no extracted text at all.
      const auditPdf = content ? null : resolvedPdf;
      const audit = await generateContentAudit(topic, content, auditPdf, map);
      Store.set(auditKey, audit);
      if (userId) dbSaveContent(userId, sourceKey, 'audit', audit).catch(console.error);
      setContentAudit(audit);
    } catch { /* non-fatal — audit is enhancement only */ }
    finally { setAuditLoading(false); }
  };

  /**
   * Two-pass boost: runs silently after fresh card generation.
   * 1. Ensures a content map exists (generates one if needed).
   * 2. Runs a coverage audit against that map (with full caching).
   * 3. Generates one targeted flashcard per missed concept and appends
   *    them to the live card feed — the learner sees them seamlessly after
   *    the first-pass cards.
   */
  const runTwoPassBoost = async (
    resolvedPdf: string | null,
    modeKey: string,
    firstPassCards: FeedCard[],
  ) => {
    // ── Step 1: get or generate map (needed for audit) ────────
    let map: ContentMap | null = Store.get<ContentMap | null>(`map:${sourceKey}`, null);
    if (!map?.synthesis && userId) {
      map = await dbLoadContent<ContentMap>(userId, sourceKey, 'map').catch(() => null);
    }
    if (!map?.synthesis) {
      try {
        map = await generateContentMap(topic, content, content ? null : resolvedPdf);
        Store.set(`map:${sourceKey}`, map);
        setContentMap(map);
        if (userId) dbSaveContent(userId, sourceKey, 'map', map).catch(console.error);
      } catch { return; /* can't audit without a map */ }
    }

    // ── Step 2: get or run coverage audit ────────────────────
    let audit: ContentAudit | null = Store.get<ContentAudit | null>(`audit:${sourceKey}`, null);
    if (!audit && userId) {
      audit = await dbLoadContent<ContentAudit>(userId, sourceKey, 'audit').catch(() => null);
    }
    if (!audit) {
      try {
        setAuditLoading(true);
        audit = await generateContentAudit(topic, content, content ? null : resolvedPdf, map);
        Store.set(`audit:${sourceKey}`, audit);
        setContentAudit(audit);
        if (userId) dbSaveContent(userId, sourceKey, 'audit', audit).catch(console.error);
      } catch { return; }
      finally { setAuditLoading(false); }
    } else {
      // Populate the map-view audit panel if not already set
      setContentAudit(audit);
    }

    if (!audit || audit.missedConcepts.length === 0) return;

    // ── Step 3: generate gap cards and append to feed ─────────
    try {
      const gapCards = await generateBoosterCards(topic, audit.missedConcepts, content);
      if (gapCards.length === 0) return;

      setCards(prev => [...prev, ...gapCards]);
      setGapCardsAdded(gapCards.length);

      // Persist combined set so the next load already has gap cards baked in
      const combined = [...firstPassCards, ...gapCards];
      if (userId) {
        dbSaveGeneratedCards(userId, modeKey, topic, { cards: combined, audit: null }, contentLen).catch(console.error);
      } else {
        Store.set(`feed:${modeKey}`, { cards: combined, audit: null });
      }
    } catch { /* non-fatal — gap cards are an enhancement */ }
  };

  /** Generate one targeted flashcard per missed concept and launch the card feed */
  const generateGaps = async (missedConcepts: string[]) => {
    if (missedConcepts.length === 0 || gapLoading) return;
    setGapLoading(true);
    try {
      const gapCards = await generateBoosterCards(topic, missedConcepts, content);
      if (gapCards.length === 0) return;
      // Launch straight into the card feed with only the gap cards
      setCards(gapCards);
      setAudit(null);
      setIdx(0);
      setScore(0);
      setStreak(0);
      setQuizCorrect(0);
      setQuizTotal(0);
      setStartTime(Date.now());
      setPhase('running');
    } catch (e) {
      console.error('Gap generation failed:', e);
    } finally {
      setGapLoading(false);
    }
  };

  const startReading = async (map: ContentMap) => {
    // Only use cache if it has the new subtopic format (not old paragraphs format)
    const cached = Store.get<DocumentReading | null>(`reading:${sourceKey}`, null);
    if (cached?.topics?.length && cached.topics[0]?.subtopics?.length) {
      setDocumentReading(cached);
      setPhase('read');
      return;
    }
    // Check Supabase cache for authenticated users
    if (userId) {
      const dbCached = await dbLoadContent<DocumentReading>(userId, sourceKey, 'reading').catch(() => null);
      if (dbCached?.topics?.length && dbCached.topics[0]?.subtopics?.length) {
        Store.set(`reading:${sourceKey}`, dbCached);
        setDocumentReading(dbCached);
        setPhase('read');
        return;
      }
    }
    setPhase('read-loading');
    setError('');
    try {
      let resolvedPdf = pdfBase64;
      if (!resolvedPdf && storagePath) resolvedPdf = await fetchPdfBase64FromStorage(storagePath).catch(() => null);
      if (fileType === 'PDF' && !resolvedPdf) throw new Error('Could not load PDF binary. Try re-uploading the file.');
      const wmScore = profile?.workingMemory.score ?? 60;
      const sentenceTarget = wmScore < 40 ? 2 : wmScore < 55 ? 3 : wmScore < 72 ? 4 : 5;
      const reading = await generateReading(topic, content, resolvedPdf, map, sentenceTarget);
      Store.set(`reading:${sourceKey}`, reading);
      if (userId) dbSaveContent(userId, sourceKey, 'reading', reading).catch(console.error);
      setDocumentReading(reading);
      setPhase('read');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate reading material. Please retry.');
      setPhase('map');
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

  if (phase === 'map' && contentMap) return (
    <MapView
      contentMap={contentMap}
      topic={topic}
      hasCache={!!Store.get<ContentMap | null>(`map:${sourceKey}`, null)}
      hasReading={!!documentReading}
      profile={profile}
      contentAudit={contentAudit}
      auditLoading={auditLoading}
      gapLoading={gapLoading}
      onGenerateGaps={generateGaps}
      onBack={() => setPhase('idle')}
      onRead={() => startReading(contentMap)}
      onPractice={() => setPhase('practice')}
      onRegenerate={async () => {
        Store.del(`map:${sourceKey}`);
        Store.del(`audit:${sourceKey}`);
        setContentMap(null);
        setContentAudit(null);
        setPhase('mapping');
        setError('');
        try {
          let resolvedPdf = pdfBase64;
          if (!resolvedPdf && storagePath) resolvedPdf = await fetchPdfBase64FromStorage(storagePath).catch(() => null);
          const map = await generateContentMap(topic, content, resolvedPdf);
          Store.set(`map:${sourceKey}`, map);
          if (userId) dbSaveContent(userId, sourceKey, 'map', map).catch(console.error);
          setContentMap(map);
          setPhase('map');
          void runAudit(map, resolvedPdf);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Failed to generate topic map.');
          setPhase('idle');
        }
      }}
    />
  );

  if (phase === 'practice' && documentReading) return (
    <PracticeView
      documentReading={documentReading}
      topic={topic}
      profile={profile}
      onBack={() => setPhase('read')}
    />
  );

  if (phase === 'visuals' && visualSet) return (
    <VisualsView
      visualSet={visualSet}
      topic={topic}
      hasCache={!!Store.get<VisualSet | null>(`visuals:${sourceKey}`, null)}
      onBack={() => setPhase('idle')}
      onRegenerate={() => { Store.del(`visuals:${sourceKey}`); setVisualSet(null); void generate(true, 'activities'); }}
    />
  );

  if (phase === 'read' && documentReading && contentMap) return (
    <ReadView
      documentReading={documentReading}
      topic={topic}
      hasCache={!!Store.get<DocumentReading | null>(`reading:${sourceKey}`, null)}
      profile={profile}
      onBack={() => setPhase('map')}
      onPractice={() => setPhase('practice')}
      onRegenerate={async () => {
        Store.del(`reading:${sourceKey}`);
        setDocumentReading(null);
        await startReading(contentMap);
      }}
    />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--bg)', overflow: 'hidden' }}>
      {phase !== 'idle' && (
        <FeedHeader
          topic={topic} breadcrumb={breadcrumb}
          score={score} streak={streak}
          onBack={
            (phase === 'loading' || phase === 'mapping') ? () => { setPhase('idle'); setError(''); } :
            phase === 'read-loading' ? () => { setPhase('map'); setError(''); } :
            onBack
          }
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
            hasMap={!!contentMap}
            error={error} retryRef={retryRef} profile={profile}
            onBack={onBack}
            onGenerate={(mode) => generate(false, mode)}
            onRegenerate={() => generate(true, 'activities')}
            onStartLearning={startLearning}
          />
        )}
        {(phase === 'loading' || phase === 'mapping' || phase === 'read-loading') && <FeedLoading topic={topic} />}
        {phase === 'running' && cards.length > 0 && cards[idx] && (
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <CardView
              key={idx} card={cards[idx]} idx={idx} total={cards.length}
              topic={topic} content={content} profile={profile}
              onCorrect={() => { addScore(20, true);  setQuizCorrect(c => c + 1); setQuizTotal(t => t + 1); }}
              onWrong={()  => { addScore(0,  false); setQuizTotal(t => t + 1); }}
              onRated={diff => addScore({ easy: 15, medium: 10, hard: 5 }[diff], true)}
              onPrev={prev} onNext={next}
            />
          </div>
        )}
        {phase === 'done' && (
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <CompletionView
              cards={cards} score={score} audit={audit}
              quizCorrect={quizCorrect} quizTotal={quizTotal}
              elapsed={startTime ? Date.now() - startTime : 0}
              onBack={onBack}
              onRestart={() => { setIdx(0); setScore(0); setStreak(0); setQuizCorrect(0); setQuizTotal(0); setStartTime(Date.now()); setPhase('running'); }}
            />
          </div>
        )}
      </div>

      {/* Gap-cards toast — appears when pass 2 appends bonus cards */}
      {gapCardsAdded > 0 && (
        <div style={{
          position: 'fixed', bottom: 90, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--ink)', color: 'white', borderRadius: 14,
          padding: '10px 18px', fontSize: 13, fontWeight: 700,
          display: 'flex', alignItems: 'center', gap: 10,
          boxShadow: '0 6px 28px rgba(0,0,0,0.28)', zIndex: 200, whiteSpace: 'nowrap',
          animation: 'slideUp 0.35s ease',
        }}>
          <span>📚</span>
          <span>+{gapCardsAdded} gap card{gapCardsAdded !== 1 ? 's' : ''} added for missed concepts</span>
          <button
            onClick={() => setGapCardsAdded(0)}
            aria-label="Dismiss"
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.55)', cursor: 'pointer', padding: 0, fontSize: 20, lineHeight: 1, marginLeft: 4 }}
          >×</button>
        </div>
      )}

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

// ── Visual learning components view ──────────────────────────

const VISUAL_TYPE_META: Record<VisualComponent['type'], { label: string; color: string; bg: string; emoji: string }> = {
  diagram:     { label: 'Diagram',     color: '#3B82F6', bg: '#EFF6FF', emoji: '🔬' },
  chart:       { label: 'Chart',       color: '#10B981', bg: '#ECFDF5', emoji: '📊' },
  timeline:    { label: 'Timeline',    color: '#F59E0B', bg: '#FFFBEB', emoji: '📅' },
  process:     { label: 'Process',     color: '#8B5CF6', bg: '#F5F3FF', emoji: '⚙️' },
  interactive: { label: 'Interactive', color: '#EF4444', bg: '#FEF2F2', emoji: '✦' },
};

function VisualsView({
  visualSet, topic, hasCache, onBack, onRegenerate,
}: {
  visualSet:    VisualSet;
  topic:        string;
  hasCache:     boolean;
  onBack:       () => void;
  onRegenerate: () => void;
}) {
  const isMobile = useIsMobile();
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  const handleRegenerate = () => {
    setRegenerating(true);
    onRegenerate();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--bg)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', background: 'var(--card)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--ink-3)', lineHeight: 1, padding: 4 }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)' }}>Visual Learning</div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{topic}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>{visualSet.components.length} visuals</span>
          {hasCache && (
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 10, background: 'var(--brand)', border: 'none', color: 'white', fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: regenerating ? 0.6 : 1 }}>
              🔄 {regenerating ? 'Generating…' : 'Regenerate'}
            </button>
          )}
        </div>
      </div>

      {/* Scrollable grid */}
      <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '16px 12px 32px' : '24px 28px 40px' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)',
          gap: isMobile ? 16 : 22,
          maxWidth: 1100,
          margin: '0 auto',
        }}>
          {visualSet.components.map((c, i) => {
            const meta = VISUAL_TYPE_META[c.type] ?? VISUAL_TYPE_META.diagram;
            const isExpanded = expandedIdx === i;
            const isLast = i === visualSet.components.length - 1;
            const isSolo = !isMobile && isLast && visualSet.components.length % 2 === 1;

            return (
              <div key={i} style={{
                borderRadius: 18,
                border: `1.5px solid ${meta.color}33`,
                background: 'var(--card)',
                overflow: 'hidden',
                boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
                gridColumn: isSolo ? '1 / -1' : undefined,
                maxWidth: isSolo ? 640 : undefined,
                justifySelf: isSolo ? 'center' : undefined,
                width: isSolo ? '100%' : undefined,
              }}>
                {/* Card header */}
                <div style={{ padding: '14px 18px', background: meta.bg, borderBottom: `1px solid ${meta.color}22` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                    <span style={{ fontSize: 13 }}>{meta.emoji}</span>
                    <span style={{ padding: '3px 9px', borderRadius: 999, background: meta.color, color: 'white', fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      {meta.label}
                    </span>
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)', lineHeight: 1.3, marginBottom: 4 }}>{c.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>{c.concept}</div>
                </div>

                {/* iframe */}
                <div style={{ position: 'relative', background: '#fff' }}>
                  <iframe
                    srcDoc={c.html}
                    sandbox="allow-scripts"
                    style={{
                      width: '100%',
                      height: isExpanded ? 560 : isMobile ? 260 : 360,
                      border: 'none',
                      display: 'block',
                      transition: 'height 0.35s ease',
                    }}
                    title={c.title}
                  />
                  {/* Expand toggle */}
                  <button
                    onClick={() => setExpandedIdx(isExpanded ? null : i)}
                    style={{
                      position: 'absolute', bottom: 10, right: 10,
                      padding: '4px 10px', borderRadius: 8,
                      background: 'rgba(0,0,0,0.55)', color: 'white',
                      fontSize: 11, fontWeight: 700, border: 'none',
                      cursor: 'pointer', backdropFilter: 'blur(4px)',
                    }}>
                    {isExpanded ? '↑ Collapse' : '⤢ Expand'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Idle view (two-column) ────────────────────────────────────

function DocIdleView({
  source, topic, breadcrumb, isLargeDoc, fromCache, audit, hasMap, error, retryRef, profile,
  onBack, onGenerate, onRegenerate, onStartLearning,
}: {
  source: FeedSource | null; topic: string; breadcrumb: string;
  isLargeDoc: boolean; fromCache: boolean; audit: FeedAudit | null; hasMap: boolean; error: string;
  retryRef: React.RefObject<HTMLButtonElement | null>; profile: LearnerProfile | null;
  onBack: () => void; onGenerate: (mode: 'activities' | 'flashcards' | 'quiz') => void; onRegenerate: () => void; onStartLearning: () => void;
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
    { id: 'flashcards', emoji: '🃏', bg: '#EEF6FF', title: 'Flashcards', desc: 'AI-generated flip cards to test your memory' },
    { id: 'activities', emoji: '🎮', bg: '#EDFAF3', title: 'Activities',  desc: 'Interactive learning components', recommended: true },
    { id: 'podcast',    emoji: '🎙️', bg: '#F5F0FF', title: 'Podcast',     desc: 'AI-generated audio lesson', soon: true },
  ];

  const handleMode = (id: string, soon?: boolean) => {
    if (soon) return;
    const mode: 'activities' | 'flashcards' | 'quiz' =
      id === 'flashcards' ? 'flashcards' : 'activities';
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
      <p style={{ color: 'var(--ink-2)', fontSize: 14, marginBottom: 20, lineHeight: 1.6 }}>
        Choose how you want to study this content.
      </p>

      {/* Start Learning — primary meta-learning entry point */}
      <button
        onClick={onStartLearning}
        style={{
          padding: '18px 20px', borderRadius: 18, marginBottom: 28,
          background: 'linear-gradient(135deg, var(--brand-tint) 0%, rgba(47,158,94,0.12) 100%)',
          border: '2px solid var(--brand)', display: 'flex', alignItems: 'center', gap: 14,
          textAlign: 'left', cursor: 'pointer', width: '100%',
          boxShadow: '0 2px 12px rgba(47,158,94,0.15)',
        }}
      >
        <div style={{ width: 50, height: 50, borderRadius: 14, background: 'var(--brand)', display: 'grid', placeItems: 'center', fontSize: 24, flexShrink: 0 }}>
          🗺️
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <span style={{ fontWeight: 800, fontSize: 15, color: 'var(--brand-2)' }}>Start Learning</span>
            {hasMap && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--brand)', background: 'var(--brand-soft)', padding: '2px 7px', borderRadius: 6 }}>READY</span>}
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 }}>
            Explore the topic map, read summaries, then dive into practice.
          </div>
        </div>
        <Icon name="chevron-right" size={18} stroke="var(--brand)" />
      </button>

      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--ink-4)', textTransform: 'uppercase', marginBottom: 12 }}>
        Or jump straight to practice
      </div>

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

// ── Map view helpers ──────────────────────────────────────────

const TOPIC_COLORS = ['#2F9E5E', '#3B82F6', '#8B5CF6', '#F59E0B', '#EF4444', '#06B6D4', '#EC4899', '#10B981'];

function getCognitiveTip(profile: LearnerProfile | null): string | null {
  if (!profile) return null;
  const wm = profile.workingMemory.score;
  const ps = profile.processingSpeed.score;
  const sa = profile.sustainedAttention.score;
  const fi = profile.fluidIntelligence.score;
  if (wm < 45) return 'Study in 10-minute bursts, then take a 3-minute break before continuing.';
  if (sa < 45) return 'Set a 15-minute focus timer — your attention is sharpest in short sprints.';
  if (ps < 45) return 'Read each subtopic twice — your brain processes deeply when given time.';
  if (fi > 70) return 'Link new topics to things you already know — your pattern recognition is strong.';
  if (wm > 70) return 'You can handle 25–30 minute sessions — your working memory handles complex material well.';
  return 'Study all topics before jumping to practice — build the full picture first.';
}

function getReadingWpm(profile: LearnerProfile | null): number {
  if (!profile) return 220;
  const ps = profile.processingSpeed.score;
  if (ps < 35) return 150;
  if (ps < 55) return 190;
  if (ps < 70) return 220;
  return 265;
}

function getBreakIntervalMinutes(profile: LearnerProfile | null): number {
  if (!profile) return 15;
  const sa = profile.sustainedAttention.score;
  if (sa < 35) return 8;
  if (sa < 55) return 12;
  if (sa < 70) return 18;
  return 25;
}

// ── Map view ──────────────────────────────────────────────────

function MapView({ contentMap, topic, hasCache, hasReading, profile, contentAudit, auditLoading, gapLoading, onGenerateGaps, onBack, onRead, onPractice, onRegenerate }: {
  contentMap:      ContentMap;
  topic:           string;
  hasCache:        boolean;
  hasReading:      boolean;
  profile:         LearnerProfile | null;
  contentAudit:    ContentAudit | null;
  auditLoading:    boolean;
  gapLoading:      boolean;
  onGenerateGaps:  (missed: string[]) => void;
  onBack:          () => void;
  onRead:          () => void;
  onPractice:      (mode: 'activities' | 'flashcards' | 'quiz') => void;
  onRegenerate:    () => void;
}) {
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set());
  const [auditOpen,    setAuditOpen]    = useState(true);
  const isMobile = useIsMobile();

  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const mapPct = Math.min(45, 30 + Math.max(0, contentMap.topics.length - 4) * 2);
  const cognitiveTip = getCognitiveTip(profile);

  const StepDot = ({ n, active }: { n: number; active: boolean }) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        background: active ? 'var(--brand)' : 'var(--bg-tint)',
        border: `2px solid ${active ? 'var(--brand)' : 'var(--line)'}`,
        display: 'grid', placeItems: 'center',
        fontSize: 13, fontWeight: 800,
        color: active ? 'white' : 'var(--ink-4)',
        transition: 'all 0.2s',
      }}>{n}</div>
      <div style={{ fontSize: 10, fontWeight: 700, color: active ? 'var(--brand)' : 'var(--ink-4)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {n === 1 ? 'Map' : n === 2 ? 'Read' : 'Practice'}
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--bg)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '0 16px', height: 58, flexShrink: 0, background: 'var(--card)', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-ghost" onClick={onBack} style={{ padding: 8, borderRadius: '50%', minWidth: 44, minHeight: 44 }} aria-label="Back">
          <Icon name="arrow-left" size={20} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="label-eyebrow" style={{ marginBottom: 1 }}>Learning Guide</div>
          <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{topic}</div>
        </div>
        {hasCache && (
          <button className="btn btn-ghost" onClick={onRegenerate} style={{ fontSize: 12, padding: '6px 10px', color: 'var(--ink-3)', gap: 5 }}>
            <Icon name="refresh" size={13} stroke="var(--ink-3)" /> Refresh
          </button>
        )}
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '20px 16px' : '24px 24px' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>

          {/* Step progress */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, marginBottom: 24 }}>
            <StepDot n={1} active={true} />
            <div style={{ width: isMobile ? 40 : 64, height: 2, background: 'var(--line)', margin: '0 4px', marginBottom: 20 }} />
            <StepDot n={2} active={false} />
            <div style={{ width: isMobile ? 40 : 64, height: 2, background: 'var(--line)', margin: '0 4px', marginBottom: 20 }} />
            <StepDot n={3} active={false} />
          </div>

          {/* Step 1 label */}
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderRadius: 999, background: 'var(--brand)', color: 'white' }}>
              <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Step 1 · Topic Map</span>
            </div>
            <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--ink-3)' }}>Study this first before moving to practice</p>
          </div>

          {/* Understanding meter */}
          <div style={{ padding: '14px 18px', borderRadius: 14, background: 'var(--card)', border: '1px solid var(--line)', marginBottom: 16, boxShadow: '0 1px 6px rgba(0,0,0,0.04)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 600 }}>After understanding this map</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--brand)', fontFamily: 'var(--font-mono)' }}>{mapPct}%</div>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: 'var(--bg-tint)', overflow: 'hidden', marginBottom: 6 }}>
              <div style={{ width: `${mapPct}%`, height: '100%', borderRadius: 999, background: 'linear-gradient(90deg, var(--brand) 0%, #7ed5a0 100%)' }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>content understanding · complete all 3 steps for 90%+</div>
          </div>

          {/* Cognitive tip */}
          {cognitiveTip && (
            <div style={{ padding: '12px 16px', borderRadius: 12, background: '#FFFBEB', border: '1px solid rgba(244,183,64,0.4)', marginBottom: 20, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>🧠</span>
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#92400E', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>Your cognitive profile suggests</div>
                <div style={{ fontSize: 13, color: '#78350F', lineHeight: 1.6 }}>{cognitiveTip}</div>
              </div>
            </div>
          )}

          {/* Big Picture synthesis */}
          <div style={{ padding: '18px 20px', borderRadius: 16, background: 'var(--brand-tint)', border: '1px solid var(--brand-soft)', marginBottom: 20 }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', color: 'var(--brand)', textTransform: 'uppercase', marginBottom: 8 }}>
              Big Picture
            </div>
            <p style={{ margin: 0, fontSize: 16, lineHeight: 1.85, color: 'var(--ink-2)' }}>
              {contentMap.synthesis}
            </p>
          </div>

          {/* Mind-map style topic tree */}
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', color: 'var(--ink-3)', textTransform: 'uppercase', marginBottom: 12 }}>
            Topics · {contentMap.topics.length}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: (auditLoading || contentAudit) ? 16 : 20 }}>
            {contentMap.topics.map((t, i) => {
              const color = TOPIC_COLORS[i % TOPIC_COLORS.length];
              const isOpen = expanded.has(t.id);
              return (
                <div key={t.id} style={{
                  borderRadius: 14,
                  border: `1.5px solid ${isOpen ? color + '44' : 'var(--line)'}`,
                  background: 'var(--card)',
                  overflow: 'hidden',
                  borderLeft: `4px solid ${color}`,
                  transition: 'border-color 0.2s, box-shadow 0.2s',
                  boxShadow: isOpen ? `0 2px 12px ${color}18` : 'none',
                }}>
                  <button
                    onClick={() => toggle(t.id)}
                    style={{ width: '100%', padding: '14px 16px', display: 'flex', alignItems: 'flex-start', gap: 12, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                  >
                    {/* Numbered circle in topic color */}
                    <div style={{
                      width: 26, height: 26, borderRadius: '50%',
                      background: isOpen ? color : color + '18',
                      border: `1.5px solid ${color}`,
                      display: 'grid', placeItems: 'center',
                      flexShrink: 0, fontSize: 11, fontWeight: 800,
                      color: isOpen ? 'white' : color,
                      fontFamily: 'var(--font-mono)',
                      transition: 'all 0.2s',
                    }}>
                      {i + 1}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)', marginBottom: isOpen ? 0 : 4 }}>{t.title}</div>
                      {!isOpen && <div style={{ fontSize: 14, color: 'var(--ink-3)', lineHeight: 1.6 }}>{t.summary}</div>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      {!isOpen && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: color, background: color + '18', padding: '2px 7px', borderRadius: 6 }}>
                          {t.subtopics.length} subtopics
                        </span>
                      )}
                      <div style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>
                        <Icon name="chevron-right" size={16} stroke={isOpen ? color : 'var(--ink-4)'} />
                      </div>
                    </div>
                  </button>

                  {isOpen && (
                    <div style={{ borderTop: `1px solid ${color}22`, paddingBottom: 10 }}>
                      {/* Topic summary */}
                      <div style={{ padding: '10px 16px 12px 54px', fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.75, fontStyle: 'italic' }}>
                        {t.summary}
                      </div>
                      {/* Subtopics with colored connector line */}
                      <div style={{ position: 'relative', paddingLeft: 54 }}>
                        {/* Vertical connector line */}
                        <div style={{ position: 'absolute', left: 28, top: 0, bottom: 12, width: 2, background: `linear-gradient(to bottom, ${color}55, ${color}11)`, borderRadius: 2 }} />
                        {t.subtopics.map((sub) => (
                          <div key={sub.id} style={{ display: 'flex', gap: 12, padding: '8px 16px 8px 0', position: 'relative' }}>
                            {/* Horizontal connector */}
                            <div style={{ position: 'absolute', left: -26, top: 17, width: 18, height: 2, background: color + '55' }} />
                            {/* Dot */}
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, marginTop: 5, border: `2px solid white`, boxShadow: `0 0 0 1.5px ${color}` }} />
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)', marginBottom: 3 }}>{sub.title}</div>
                              <div style={{ fontSize: 14, color: 'var(--ink-3)', lineHeight: 1.7 }}>{sub.summary}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── Coverage Audit panel ── */}
          {(auditLoading || contentAudit) && (() => {
            const score  = contentAudit?.coverageScore ?? 0;
            const missed = contentAudit?.missedConcepts ?? [];
            const tips   = contentAudit?.suggestions ?? [];
            const scoreColor = score >= 85 ? '#16A34A' : score >= 65 ? '#D97706' : '#DC2626';
            const scoreBg    = score >= 85 ? '#F0FDF4' : score >= 65 ? '#FFFBEB' : '#FEF2F2';
            const scoreBorder= score >= 85 ? '#86EFAC' : score >= 65 ? '#FDE68A' : '#FECACA';

            return (
              <div style={{ borderRadius: 16, border: `1.5px solid ${scoreBorder}`, background: scoreBg, overflow: 'hidden', marginBottom: 20 }}>
                {/* Audit header */}
                <button
                  onClick={() => setAuditOpen(o => !o)}
                  style={{ width: '100%', padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                >
                  <span style={{ fontSize: 16, flexShrink: 0 }}>🔍</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: scoreColor, marginBottom: 2 }}>
                      Coverage Audit
                    </div>
                    <div style={{ fontSize: 13, color: scoreColor, fontWeight: 600 }}>
                      {auditLoading && !contentAudit
                        ? 'Analysing document coverage…'
                        : missed.length === 0
                          ? 'Excellent — no significant gaps found'
                          : `${missed.length} item${missed.length !== 1 ? 's' : ''} not covered by this map`}
                    </div>
                  </div>
                  {contentAudit && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 22, fontWeight: 800, color: scoreColor, fontFamily: 'var(--font-mono)', lineHeight: 1 }}>{score}%</div>
                        <div style={{ fontSize: 10, color: scoreColor, fontWeight: 600, opacity: 0.7 }}>covered</div>
                      </div>
                      <div style={{ transform: auditOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>
                        <Icon name="chevron-right" size={16} stroke={scoreColor} />
                      </div>
                    </div>
                  )}
                  {auditLoading && !contentAudit && (
                    <div style={{ width: 20, height: 20, border: `2px solid ${scoreColor}44`, borderTop: `2px solid ${scoreColor}`, borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                  )}
                </button>

                {/* Expanded body */}
                {auditOpen && contentAudit && missed.length > 0 && (
                  <div style={{ borderTop: `1px solid ${scoreBorder}`, padding: '14px 18px' }}>
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: scoreColor, marginBottom: 10 }}>
                      Missed from document
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: tips.length ? 14 : 0 }}>
                      {missed.map((item, i) => (
                        <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                          <div style={{ width: 20, height: 20, borderRadius: '50%', background: scoreColor + '18', border: `1.5px solid ${scoreColor}44`, display: 'grid', placeItems: 'center', flexShrink: 0, fontSize: 10, fontWeight: 800, color: scoreColor, fontFamily: 'var(--font-mono)' }}>
                            {i + 1}
                          </div>
                          <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6, paddingTop: 1 }}>{item}</div>
                        </div>
                      ))}
                    </div>

                    {/* Study gaps button */}
                    <button
                      onClick={() => onGenerateGaps(missed)}
                      disabled={gapLoading}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        marginTop: 14, padding: '10px 16px', borderRadius: 12,
                        background: scoreColor, color: 'white', border: 'none',
                        fontSize: 13, fontWeight: 700, cursor: gapLoading ? 'not-allowed' : 'pointer',
                        opacity: gapLoading ? 0.7 : 1, width: '100%', justifyContent: 'center',
                      }}
                    >
                      {gapLoading ? (
                        <>
                          <div style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.4)', borderTop: '2px solid white', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                          Generating gap cards…
                        </>
                      ) : (
                        <>📚 Study {missed.length} missed item{missed.length !== 1 ? 's' : ''} →</>
                      )}
                    </button>

                    {tips.length > 0 && (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: scoreColor, marginBottom: 8, marginTop: 16 }}>
                          Suggestions
                        </div>
                        {tips.map((tip, i) => (
                          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
                            <span style={{ color: scoreColor, fontSize: 13, flexShrink: 0 }}>→</span>
                            <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>{tip}</div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}

                {auditOpen && contentAudit && missed.length === 0 && (
                  <div style={{ borderTop: `1px solid ${scoreBorder}`, padding: '12px 18px', fontSize: 13, color: scoreColor, lineHeight: 1.6 }}>
                    {tips.length > 0 ? tips[0] : 'The generated map covers all major concepts in this document.'}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Step nav bar */}
      <div style={{ flexShrink: 0, padding: '10px 24px 14px', borderTop: '1px solid var(--line)', background: 'var(--card)', display: 'flex', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', maxWidth: 320, width: '100%' }}>
          {/* Step 1 — Map (active) */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '0 4px' }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--brand)', border: '3px solid var(--brand)', display: 'grid', placeItems: 'center', fontSize: 13, color: 'white', fontWeight: 800, boxShadow: '0 0 0 4px rgba(47,158,94,0.15)' }}>1</div>
            <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--brand)', letterSpacing: '0.02em' }}>Map</span>
          </div>

          {/* Line 1→2 */}
          <div style={{ flex: 1, height: 2.5, background: hasReading ? 'var(--brand)' : 'var(--line)', borderRadius: 2, marginBottom: 18, transition: 'background 0.5s' }} />

          {/* Step 2 — Read (clickable) */}
          <button onClick={onRead} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: hasReading ? 'var(--brand)' : 'var(--bg-tint)', border: `2.5px solid ${hasReading ? 'var(--brand)' : 'var(--line)'}`, display: 'grid', placeItems: 'center', fontSize: 13, color: hasReading ? 'white' : 'var(--ink-4)', fontWeight: 800, transition: 'all 0.4s', boxShadow: hasReading ? '0 2px 8px rgba(47,158,94,0.3)' : 'none' }}>
              {hasReading ? '✓' : '2'}
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, color: hasReading ? 'var(--brand)' : 'var(--ink-3)', letterSpacing: '0.02em', transition: 'color 0.4s' }}>Read</span>
          </button>

          {/* Line 2→3 */}
          <div style={{ flex: 1, height: 2.5, background: 'var(--line)', borderRadius: 2, marginBottom: 18 }} />

          {/* Step 3 — Practice (clickable) */}
          <button onClick={() => onPractice('activities')} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--bg-tint)', border: '2.5px solid var(--line)', display: 'grid', placeItems: 'center', fontSize: 13, color: 'var(--ink-4)', fontWeight: 800 }}>3</div>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', letterSpacing: '0.02em' }}>Practice</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Practice quiz helpers ─────────────────────────────────────

interface UserAnswer {
  questionId: string;
  score:      number;
  maxScore:   number;
  userValue:  string | number | null;
  feedback?:  string;
}

interface PracticeReport {
  totalScore:      number;
  maxScore:        number;
  percentage:      number;
  topicBreakdown:  { topicId: string; topicTitle: string; score: number; maxScore: number; percentage: number }[];
  suggestions:     string[];
  overallFeedback: string;
  band:            'excellent' | 'good' | 'fair' | 'needs-work';
}

function buildPracticeReport(quiz: PracticeQuiz, answers: UserAnswer[]): PracticeReport {
  const total    = answers.reduce((s, a) => s + a.score, 0);
  const maxScore = quiz.questions.reduce((s, q) => s + (q.type === 'written' ? 2 : 1), 0);
  const pct      = maxScore === 0 ? 0 : Math.round((total / maxScore) * 100);

  const topicMap = new Map<string, { title: string; score: number; max: number }>();
  quiz.questions.forEach((q, i) => {
    const a = answers[i];
    if (!a) return;
    if (!topicMap.has(q.topicId)) topicMap.set(q.topicId, { title: q.topicTitle, score: 0, max: 0 });
    const t = topicMap.get(q.topicId)!;
    t.score += a.score;
    t.max   += q.type === 'written' ? 2 : 1;
  });

  const topicBreakdown = [...topicMap.entries()].map(([topicId, t]) => ({
    topicId, topicTitle: t.title, score: t.score, maxScore: t.max,
    percentage: t.max === 0 ? 0 : Math.round((t.score / t.max) * 100),
  })).sort((a, b) => a.percentage - b.percentage);

  const weakTopics = topicBreakdown.filter(t => t.percentage < 60);
  const suggestions: string[] = weakTopics.length === 0
    ? ['Excellent across the board! Try a new quiz to keep the knowledge fresh.']
    : weakTopics.map(t => `Revisit "${t.topicTitle}" — you scored ${t.percentage}% on those questions.`);
  if (pct < 50) suggestions.push('Go back to the reading and focus on the red topics above, then retry.');

  const band: PracticeReport['band'] = pct >= 85 ? 'excellent' : pct >= 70 ? 'good' : pct >= 50 ? 'fair' : 'needs-work';
  const overallFeedback = (
    band === 'excellent'  ? '🎉 Outstanding! You have a strong command of this material.' :
    band === 'good'       ? '👏 Well done! A few gaps to close — you\'re nearly there.' :
    band === 'fair'       ? '💪 Solid effort. Focus on the weaker topics and try again.' :
                            '📚 Keep at it — revisit the reading and tackle those red topics.'
  );
  return { totalScore: total, maxScore, percentage: pct, topicBreakdown, suggestions, overallFeedback, band };
}

const Q_TYPE_META = {
  mcq:     { label: 'Multiple Choice', color: '#3B82F6', bg: '#EFF6FF' },
  fill:    { label: 'Fill in Blank',   color: '#F59E0B', bg: '#FFFBEB' },
  written: { label: 'Written Answer',  color: '#8B5CF6', bg: '#F5F3FF' },
} as const;

const BAND_COLOR = {
  excellent:    '#10B981',
  good:         '#3B82F6',
  fair:         '#F59E0B',
  'needs-work': '#EF4444',
} as const;

function PracticeView({
  documentReading, topic, profile: _profile, onBack,
}: {
  documentReading: DocumentReading;
  topic:           string;
  profile:         LearnerProfile | null;
  onBack:          () => void;
}) {
  const isMobile = useIsMobile();
  type Phase = 'generating' | 'quiz' | 'done';
  const [practicePhase, setPracticePhase] = useState<Phase>('generating');
  const [quiz,          setQuiz]          = useState<PracticeQuiz | null>(null);
  const [genError,      setGenError]      = useState('');
  const [currentQ,      setCurrentQ]      = useState(0);
  const [answers,       setAnswers]       = useState<UserAnswer[]>([]);

  // Per-question interaction state
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [textInput,      setTextInput]      = useState('');
  const [submitted,      setSubmitted]      = useState(false);
  const [evaluating,     setEvaluating]     = useState(false);
  const [qFeedback,      setQFeedback]      = useState<{ score: number; feedback: string } | null>(null);

  const resetQ = () => {
    setSelectedOption(null);
    setTextInput('');
    setSubmitted(false);
    setEvaluating(false);
    setQFeedback(null);
  };

  const runGenerate = async () => {
    setPracticePhase('generating');
    setGenError('');
    setCurrentQ(0);
    setAnswers([]);
    resetQ();
    try {
      const q = await generatePracticeQuiz(documentReading, topic);
      setQuiz(q);
      setPracticePhase('quiz');
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Failed to generate quiz.');
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void runGenerate(); }, []);

  const currentQuestion: PracticeQuestion | null = quiz?.questions[currentQ] ?? null;

  const handleSubmit = async () => {
    if (!currentQuestion || submitted || evaluating) return;

    if (currentQuestion.type === 'mcq') {
      if (selectedOption === null) return;
      const correct = selectedOption === currentQuestion.answer ? 1 : 0;
      setSubmitted(true);
      setAnswers(prev => [...prev, { questionId: currentQuestion.id, score: correct, maxScore: 1, userValue: selectedOption }]);
      setQFeedback({
        score: correct,
        feedback: correct
          ? `✓ Correct! ${currentQuestion.explanation}`
          : `✗ The answer is option ${String.fromCharCode(65 + (currentQuestion.answer ?? 0))}. ${currentQuestion.explanation}`,
      });

    } else if (currentQuestion.type === 'fill') {
      if (!textInput.trim()) return;
      const userNorm    = textInput.trim().toLowerCase();
      const correctNorm = (currentQuestion.blank ?? '').toLowerCase();
      const correct     = userNorm === correctNorm ? 1 : 0;
      setSubmitted(true);
      setAnswers(prev => [...prev, { questionId: currentQuestion.id, score: correct, maxScore: 1, userValue: textInput }]);
      setQFeedback({
        score: correct,
        feedback: correct
          ? `✓ Correct! "${currentQuestion.blank}" — ${currentQuestion.explanation}`
          : `✗ The answer was "${currentQuestion.blank}". ${currentQuestion.explanation}`,
      });

    } else if (currentQuestion.type === 'written') {
      if (!textInput.trim()) return;
      setEvaluating(true);
      let evalResult: WrittenEvaluation;
      try {
        evalResult = await evaluateWrittenAnswer(
          currentQuestion.question,
          currentQuestion.sampleAnswer ?? '',
          textInput,
          topic,
        );
      } catch {
        evalResult = { score: 1, feedback: 'Partial credit — could not fully evaluate.' };
      }
      setSubmitted(true);
      setEvaluating(false);
      setAnswers(prev => [...prev, {
        questionId: currentQuestion.id,
        score:      evalResult.score,
        maxScore:   2,
        userValue:  textInput,
        feedback:   evalResult.feedback,
      }]);
      setQFeedback({ score: evalResult.score, feedback: evalResult.feedback });
    }
  };

  const handleNext = () => {
    if (!quiz) return;
    if (currentQ + 1 >= quiz.questions.length) {
      setPracticePhase('done');
    } else {
      setCurrentQ(q => q + 1);
      resetQ();
    }
  };

  const report = quiz && answers.length > 0 && practicePhase === 'done'
    ? buildPracticeReport(quiz, answers)
    : null;

  // ── Generating / error ──────────────────────────────────────
  if (practicePhase === 'generating') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--bg)', alignItems: 'center', justifyContent: 'center', gap: 20, padding: 32 }}>
        {genError ? (
          <>
            <div style={{ fontSize: 32 }}>⚠️</div>
            <div style={{ fontSize: 15, color: 'var(--ink-2)', textAlign: 'center', maxWidth: 360 }}>{genError}</div>
            <button onClick={() => void runGenerate()} className="btn btn-primary">Try again</button>
            <button onClick={onBack} style={{ fontSize: 13, color: 'var(--ink-3)', background: 'none', border: 'none', cursor: 'pointer' }}>← Back to reading</button>
          </>
        ) : (
          <>
            <div style={{ width: 48, height: 48, borderRadius: '50%', border: '4px solid var(--brand)', borderTopColor: 'transparent', animation: 'spin 0.9s linear infinite' }} />
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>Generating your quiz…</div>
            <div style={{ fontSize: 13, color: 'var(--ink-3)', textAlign: 'center' }}>Crafting questions across all topics</div>
          </>
        )}
      </div>
    );
  }

  // ── Done / report ───────────────────────────────────────────
  if (practicePhase === 'done' && report) {
    const bandColor = BAND_COLOR[report.band];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--bg)', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', background: 'var(--card)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--ink-3)', lineHeight: 1, padding: 4 }}>←</button>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)' }}>Practice Results</div>
            <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{topic}</div>
          </div>
          <button onClick={() => void runGenerate()}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 10, background: 'var(--brand)', border: 'none', color: 'white', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            🔄 New Quiz
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '20px 16px 32px' : '28px 28px 40px' }}>
          <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>

            {/* Score circle + overall feedback */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '28px 20px', borderRadius: 20, background: 'var(--card)', border: `2px solid ${bandColor}33`, boxShadow: '0 4px 20px rgba(0,0,0,0.06)' }}>
              <div style={{ width: 100, height: 100, borderRadius: '50%', border: `6px solid ${bandColor}`, display: 'grid', placeItems: 'center', boxShadow: `0 0 0 6px ${bandColor}22` }}>
                <span style={{ fontSize: 28, fontWeight: 900, color: bandColor, fontFamily: 'var(--font-mono)' }}>{report.percentage}%</span>
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', textAlign: 'center' }}>{report.overallFeedback}</div>
              <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>{report.totalScore} / {report.maxScore} points</div>
            </div>

            {/* Topic breakdown */}
            <div style={{ borderRadius: 16, background: 'var(--card)', border: '1px solid var(--line)', overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', background: 'var(--bg-tint)' }}>
                <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-2)' }}>Topic Breakdown</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {report.topicBreakdown.map((t, i) => {
                  const tColor = t.percentage >= 80 ? '#10B981' : t.percentage >= 60 ? '#F59E0B' : '#EF4444';
                  return (
                    <div key={t.topicId} style={{ padding: '12px 18px', borderBottom: i < report.topicBreakdown.length - 1 ? '1px solid var(--line)' : 'none' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', flex: 1, marginRight: 12 }}>{t.topicTitle}</div>
                        <div style={{ fontSize: 12, fontWeight: 800, color: tColor, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{t.percentage}%</div>
                      </div>
                      <div style={{ height: 6, borderRadius: 999, background: 'var(--bg-tint)', overflow: 'hidden' }}>
                        <div style={{ width: `${t.percentage}%`, height: '100%', background: tColor, borderRadius: 999, transition: 'width 0.8s ease' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Suggestions */}
            <div style={{ borderRadius: 16, background: 'var(--card)', border: '1px solid var(--line)', overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', background: 'var(--bg-tint)' }}>
                <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-2)' }}>📋 What to focus on</div>
              </div>
              <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {report.suggestions.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>{report.band === 'excellent' ? '✨' : '→'}</span>
                    <span style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>{s}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={onBack}
                style={{ flex: 1, padding: '12px 0', borderRadius: 12, border: '1.5px solid var(--line)', background: 'var(--card)', color: 'var(--ink-2)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                ← Back to Reading
              </button>
              <button onClick={() => void runGenerate()}
                style={{ flex: 1, padding: '12px 0', borderRadius: 12, border: 'none', background: 'var(--brand)', color: 'white', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                🔄 New Quiz
              </button>
            </div>

          </div>
        </div>
      </div>
    );
  }

  // ── Quiz question ───────────────────────────────────────────
  if (!currentQuestion || !quiz) return null;
  const meta     = Q_TYPE_META[currentQuestion.type];
  const progress = ((currentQ + 1) / quiz.questions.length) * 100;
  const canSubmit = currentQuestion.type === 'mcq'
    ? selectedOption !== null
    : textInput.trim().length >= 2;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--bg)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--line)', background: 'var(--card)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--ink-3)', lineHeight: 1, padding: 4 }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)' }}>Practice Quiz</div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{topic}</div>
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>{currentQ + 1} / {quiz.questions.length}</div>
      </div>

      {/* Progress bar */}
      <div style={{ height: 4, background: 'var(--bg-tint)', flexShrink: 0 }}>
        <div style={{ height: '100%', width: `${progress}%`, background: 'var(--brand)', borderRadius: '0 2px 2px 0', transition: 'width 0.4s ease' }} />
      </div>

      {/* Scrollable question area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '16px 14px 24px' : '24px 28px 32px' }}>
        <div style={{ maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Type + topic badges */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ padding: '4px 10px', borderRadius: 999, background: meta.bg, color: meta.color, fontSize: 11, fontWeight: 800, border: `1px solid ${meta.color}33` }}>
              {meta.label}
            </span>
            <span style={{ padding: '4px 10px', borderRadius: 999, background: 'var(--bg-tint)', color: 'var(--ink-3)', fontSize: 11, fontWeight: 700, border: '1px solid var(--line)' }}>
              {currentQuestion.topicTitle}
            </span>
          </div>

          {/* Question card */}
          <div style={{ borderRadius: 18, border: `2px solid ${meta.color}33`, background: 'var(--card)', overflow: 'hidden', boxShadow: '0 4px 20px rgba(0,0,0,0.06)' }}>

            {/* Question text */}
            <div style={{ padding: isMobile ? '18px 18px 14px' : '22px 24px 16px', borderBottom: `1px solid ${meta.color}22` }}>
              <p style={{ margin: 0, fontSize: isMobile ? 15 : 17, fontWeight: 700, color: 'var(--ink)', lineHeight: 1.5 }}>
                {currentQuestion.type === 'fill'
                  ? currentQuestion.question.split('___').map((part, pi, arr) => (
                      <span key={pi}>
                        {part}
                        {pi < arr.length - 1 && (
                          <span style={{ display: 'inline-block', minWidth: 80, borderBottom: `2px solid ${meta.color}`, margin: '0 4px', fontStyle: 'italic', color: meta.color, fontSize: '0.85em' }}>
                            {submitted ? currentQuestion.blank : '        '}
                          </span>
                        )}
                      </span>
                    ))
                  : currentQuestion.question}
              </p>
            </div>

            {/* Answer area */}
            <div style={{ padding: isMobile ? '14px 18px' : '18px 24px' }}>
              {/* MCQ options */}
              {currentQuestion.type === 'mcq' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {(currentQuestion.options ?? []).map((opt, oi) => {
                    const isSelected = selectedOption === oi;
                    const isCorrect  = submitted && oi === currentQuestion.answer;
                    const isWrong    = submitted && isSelected && oi !== currentQuestion.answer;
                    const bgColor    = isCorrect ? '#D1FAE5' : isWrong ? '#FEE2E2' : isSelected ? meta.color + '15' : 'var(--bg-tint)';
                    const borderColor = isCorrect ? '#10B981' : isWrong ? '#EF4444' : isSelected ? meta.color : 'var(--line)';
                    const textColor  = isCorrect ? '#065F46' : isWrong ? '#991B1B' : isSelected ? meta.color : 'var(--ink-2)';
                    return (
                      <button
                        key={oi}
                        onClick={() => !submitted && setSelectedOption(oi)}
                        disabled={submitted}
                        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderRadius: 12, border: `1.5px solid ${borderColor}`, background: bgColor, cursor: submitted ? 'default' : 'pointer', textAlign: 'left', transition: 'all 0.15s', width: '100%' }}>
                        <span style={{ width: 24, height: 24, borderRadius: '50%', border: `2px solid ${borderColor}`, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, color: textColor, flexShrink: 0, background: isCorrect ? '#10B981' : isWrong ? '#EF4444' : isSelected ? meta.color : 'transparent' }}>
                          <span style={{ color: isCorrect || isWrong || isSelected ? 'white' : textColor }}>{String.fromCharCode(65 + oi)}</span>
                        </span>
                        <span style={{ fontSize: 14, color: textColor, fontWeight: isSelected || isCorrect ? 600 : 400, lineHeight: 1.4 }}>{opt}</span>
                        {isCorrect && <span style={{ marginLeft: 'auto', fontSize: 16 }}>✓</span>}
                        {isWrong  && <span style={{ marginLeft: 'auto', fontSize: 16 }}>✗</span>}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Fill in blank input */}
              {currentQuestion.type === 'fill' && !submitted && (
                <input
                  type="text"
                  value={textInput}
                  onChange={e => setTextInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !submitted && void handleSubmit()}
                  placeholder="Type the missing term…"
                  autoFocus
                  style={{ width: '100%', padding: '11px 14px', borderRadius: 10, border: `1.5px solid ${meta.color}66`, background: 'var(--bg-tint)', fontSize: 15, color: 'var(--ink)', outline: 'none', boxSizing: 'border-box' }}
                />
              )}

              {/* Written textarea */}
              {currentQuestion.type === 'written' && !submitted && (
                <textarea
                  value={textInput}
                  onChange={e => setTextInput(e.target.value)}
                  placeholder="Write your answer here… (2–4 sentences)"
                  rows={5}
                  autoFocus
                  style={{ width: '100%', padding: '11px 14px', borderRadius: 10, border: `1.5px solid ${meta.color}66`, background: 'var(--bg-tint)', fontSize: 14, color: 'var(--ink)', outline: 'none', resize: 'vertical', lineHeight: 1.6, boxSizing: 'border-box', fontFamily: 'inherit' }}
                />
              )}

              {/* Feedback panel (after submit) */}
              {submitted && qFeedback && (
                <div style={{ marginTop: currentQuestion.type === 'mcq' ? 12 : 0, padding: '12px 16px', borderRadius: 12, background: qFeedback.score > 0 ? '#D1FAE522' : '#FEE2E222', border: `1.5px solid ${qFeedback.score > 0 ? '#10B981' : '#EF4444'}44` }}>
                  {currentQuestion.type === 'written' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: qFeedback.score === 2 ? '#065F46' : qFeedback.score === 1 ? '#92400E' : '#991B1B' }}>
                        {qFeedback.score === 2 ? '⭐ Full marks' : qFeedback.score === 1 ? '½ Partial credit' : '✗ Needs work'}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--ink-4)', marginLeft: 'auto' }}>{qFeedback.score} / 2</span>
                    </div>
                  )}
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>{qFeedback.feedback}</p>
                </div>
              )}

              {/* Evaluating state for written */}
              {evaluating && (
                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--ink-3)', fontSize: 13 }}>
                  <div style={{ width: 16, height: 16, borderRadius: '50%', border: '2.5px solid var(--brand)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                  Claude is reading your answer…
                </div>
              )}
            </div>
          </div>

          {/* Submit / Next button */}
          {!submitted ? (
            <button
              onClick={() => void handleSubmit()}
              disabled={!canSubmit || evaluating}
              style={{ padding: '13px 0', borderRadius: 12, border: 'none', background: canSubmit ? meta.color : 'var(--bg-tint)', color: canSubmit ? 'white' : 'var(--ink-4)', fontSize: 14, fontWeight: 700, cursor: canSubmit ? 'pointer' : 'default', transition: 'all 0.2s', width: '100%' }}>
              {evaluating ? 'Evaluating…' : currentQuestion.type === 'written' ? 'Submit answer' : 'Check answer'}
            </button>
          ) : (
            <button
              onClick={handleNext}
              style={{ padding: '13px 0', borderRadius: 12, border: 'none', background: 'var(--brand)', color: 'white', fontSize: 14, fontWeight: 700, cursor: 'pointer', width: '100%', transition: 'all 0.2s' }}>
              {currentQ + 1 >= quiz.questions.length ? 'See results →' : 'Next question →'}
            </button>
          )}

        </div>
      </div>
    </div>
  );
}

// ── Focus view helpers ────────────────────────────────────────

function FocusTerms({ terms, color }: { terms: { term: string; definition: string }[]; color: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderRadius: 12, border: `1px solid ${color}33`, overflow: 'hidden' }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: '100%', padding: '9px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: color + '0d', border: 'none', cursor: 'pointer' }}>
        <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color }}>📖 Key Terms</span>
        <span style={{ fontSize: 13, color, display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>›</span>
      </button>
      {open && terms.map((kt, ki) => (
        <div key={kt.term} style={{ padding: '9px 14px', borderTop: `1px solid ${color}22`, background: ki % 2 === 0 ? 'transparent' : color + '04' }}>
          <span style={{ fontWeight: 700, fontSize: 13, color }}>{kt.term}</span>
          <span style={{ fontSize: 13, color: 'var(--ink-3)', marginLeft: 6 }}>— {kt.definition}</span>
        </div>
      ))}
    </div>
  );
}

function FocusChatInput({ color, streaming, onSend }: { color: string; streaming: boolean; onSend: (text: string) => void }) {
  const [val, setVal] = useState('');
  const submit = () => { const t = val.trim(); if (!t || streaming) return; setVal(''); onSend(t); };
  return (
    <div style={{ display: 'flex', gap: 8, padding: '8px 14px', borderTop: `1px solid ${color}22` }}>
      <input
        value={val} onChange={e => setVal(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && !e.shiftKey && submit()}
        placeholder="Ask a question…"
        style={{ flex: 1, padding: '7px 12px', borderRadius: 10, border: '1.5px solid var(--line)', background: 'var(--bg)', fontSize: 13, color: 'var(--ink)', outline: 'none' }}
      />
      <button onClick={submit} disabled={streaming || !val.trim()}
        style={{ padding: '7px 14px', borderRadius: 10, background: val.trim() && !streaming ? color : 'var(--bg-tint)', color: val.trim() && !streaming ? 'white' : 'var(--ink-4)', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, transition: 'all 0.2s' }}>
        {streaming ? '…' : '↑'}
      </button>
    </div>
  );
}

// ── Read view ─────────────────────────────────────────────────

function ReadView({ documentReading, topic, hasCache, profile, onBack, onPractice, onRegenerate }: {
  documentReading: DocumentReading;
  topic: string;
  hasCache: boolean;
  profile: LearnerProfile | null;
  onBack: () => void;
  onPractice: (mode: 'activities' | 'flashcards' | 'quiz') => void;
  onRegenerate: () => void;
}) {
  type SubStatus = 'unread' | 'read' | 'learnt';

  const [expandedSubs,      setExpandedSubs]      = useState<Set<string>>(new Set([`${documentReading.topics[0]?.topicId}-0`]));
  const [subStatuses,       setSubStatuses]       = useState<Record<string, SubStatus>>({});
  const [reachedMilestones, setReachedMilestones] = useState<Set<number>>(new Set());
  const [elapsedSec,        setElapsedSec]        = useState(0);
  const [breakDismissed,    setBreakDismissed]    = useState(false);
  type ActiveQuiz = { key: string; quiz: import('../lib/claude').SubtopicQuiz; color: string; selected: number | null; revealed: boolean } | null;
  const [activeQuiz,  setActiveQuiz]  = useState<ActiveQuiz>(null);
  const [viewMode,    setViewMode]    = useState<'list' | 'cards'>('list');
  const [cardIdx,     setCardIdx]     = useState(0);

  const isMobile    = useIsMobile();
  const [showSidebar, setShowSidebar] = useState(() => window.innerWidth >= 820);
  const scrollRef   = useRef<HTMLDivElement>(null);
  const startRef    = useRef(Date.now());

  useEffect(() => {
    const fn = () => setShowSidebar(window.innerWidth >= 820);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);

  const wpm          = getReadingWpm(profile);
  const breakMinutes = getBreakIntervalMinutes(profile);
  const cognitiveTip = getCognitiveTip(profile);

  // Total words for reading time estimate
  const totalWords = documentReading.topics.reduce((sum, t) =>
    sum + (t.subtopics ?? []).reduce((s, sub) => s + sub.content.split(/\s+/).length, 0), 0);
  const totalReadMinutes = Math.max(1, Math.ceil(totalWords / wpm));

  // Progress driven by user-marked subtopics
  const allSubKeys  = documentReading.topics.flatMap(t =>
    (t.subtopics ?? []).map((_, si) => `${t.topicId}-${si}`));
  const totalSubs   = allSubKeys.length;
  const doneCount   = allSubKeys.filter(k => subStatuses[k] && subStatuses[k] !== 'unread').length;
  const progressPct = totalSubs === 0 ? 0 : Math.round((doneCount / totalSubs) * 100);

  // Flattened subtopics for card view
  const allCards = documentReading.topics.flatMap((t, ti) =>
    (t.subtopics ?? []).map((sub, si) => ({
      sub, key: `${t.topicId}-${si}`, topic: t,
      color: TOPIC_COLORS[ti % TOPIC_COLORS.length], si,
    }))
  );
  const safeCardIdx = Math.min(cardIdx, Math.max(0, allCards.length - 1));

  // Celebrate milestone nodes as they're reached
  useEffect(() => {
    [25, 50, 75, 100].forEach(m => {
      if (progressPct >= m && !reachedMilestones.has(m)) {
        setReachedMilestones(prev => new Set([...prev, m]));
        celebrate();
      }
    });
  }, [progressPct]); // eslint-disable-line react-hooks/exhaustive-deps

  // Elapsed time ticker (every 30 s)
  useEffect(() => {
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - startRef.current) / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  const elapsedMinutes = Math.floor(elapsedSec / 60);
  const showBreak      = elapsedMinutes >= breakMinutes && !breakDismissed;

  const markStatus = (key: string, status: SubStatus) =>
    setSubStatuses(prev => ({ ...prev, [key]: prev[key] === status ? 'unread' : status }));

  const answerQuiz = (selected: number) => {
    if (!activeQuiz) return;
    const correct = activeQuiz.quiz.answer;
    setActiveQuiz(prev => prev ? { ...prev, selected, revealed: true } : null);
    if (selected === correct) {
      setSubStatuses(prev => ({ ...prev, [activeQuiz.key]: 'learnt' }));
      celebrate();
      setTimeout(() => setActiveQuiz(null), 1800);
    }
  };

  const scrollTo = (topicId: string) =>
    document.getElementById(`rt-${topicId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const toggleSub = (key: string) => setExpandedSubs(prev => {
    const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n;
  });

  // ── Sidebar (desktop) ────────────────────────────────────────
  const sidebar = (
    <div style={{
      width: 220, flexShrink: 0,
      display: 'flex', flexDirection: 'column', gap: 0,
      borderLeft: '2px solid var(--line)', background: 'var(--card)',
      overflowY: 'auto', padding: '20px 14px',
      height: '100%',
    }}>
      {/* Total reading time */}
      <div style={{ marginBottom: 20, padding: '12px 14px', borderRadius: 12, background: 'var(--bg-tint)', border: '1px solid var(--line)' }}>
        <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-2)', marginBottom: 5 }}>Total Reading Time</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--brand)', fontFamily: 'var(--font-mono)', lineHeight: 1 }}>~{totalReadMinutes} min</div>
        {cognitiveTip && <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 6, lineHeight: 1.4, fontStyle: 'italic' }}>{cognitiveTip}</div>}
      </div>

      {/* Milestone spine */}
      {(() => {
        const MILESTONES = [
          { pct: 25,  emoji: '⚡', msg: 'Great start — keep it up!' },
          { pct: 50,  emoji: '🔥', msg: "Halfway! You're on fire!" },
          { pct: 75,  emoji: '🏁', msg: 'Final stretch — almost there!' },
          { pct: 100, emoji: '🎉', msg: 'Complete! You nailed it!' },
        ];
        return (
          <div style={{ position: 'relative', marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-2)', marginBottom: 12 }}>Your Progress</div>
            {/* Spine line */}
            <div style={{ position: 'absolute', left: 9, top: 36, bottom: 0, width: 2, background: 'var(--line)', borderRadius: 2 }} />
            {/* Filled spine overlay */}
            <div style={{
              position: 'absolute', left: 9, top: 36, width: 2, borderRadius: 2,
              background: 'linear-gradient(180deg, var(--brand), #7ed5a0)',
              height: `${Math.min(progressPct, 99)}%`,
              transition: 'height 0.6s ease',
            }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {MILESTONES.map((m) => {
                const reached = progressPct >= m.pct;
                return (
                  <div key={m.pct} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingBottom: 28 }}>
                    {/* Node */}
                    <div style={{
                      width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                      background: reached ? 'var(--brand)' : 'var(--card)',
                      border: `2.5px solid ${reached ? 'var(--brand)' : 'var(--line)'}`,
                      display: 'grid', placeItems: 'center',
                      fontSize: 9, color: 'white', fontWeight: 800,
                      boxShadow: reached ? '0 0 0 3px var(--brand-tint)' : 'none',
                      transition: 'all 0.4s ease',
                      zIndex: 1, position: 'relative',
                    }}>
                      {reached && '✓'}
                    </div>
                    {/* Label */}
                    <div style={{ paddingTop: 1 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: reached ? 'var(--brand)' : 'var(--ink-4)', marginBottom: 2 }}>{m.pct}%</div>
                      <div style={{ fontSize: 12, color: reached ? 'var(--ink-2)' : 'var(--ink-4)', lineHeight: 1.4 }}>
                        {reached ? `${m.emoji} ${m.msg}` : m.msg}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Break reminder */}
      {showBreak ? (
        <div style={{ padding: '10px 12px', borderRadius: 10, background: '#FFFBEB', border: '1px solid rgba(244,183,64,0.5)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
            <span style={{ fontSize: 14 }}>⏸</span>
            <button onClick={() => setBreakDismissed(true)} style={{ fontSize: 10, color: 'var(--ink-4)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>
          </div>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#92400E', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>Take a break</div>
          <div style={{ fontSize: 12, color: '#78350F', lineHeight: 1.5 }}>You've been reading {elapsedMinutes} min. A short break boosts retention.</div>
        </div>
      ) : (
        <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg-tint)', border: '1px solid var(--line)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>⏱ Next break</div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)' }}>After {breakMinutes} min of reading</div>
        </div>
      )}
    </div>
  );

  // ── Sub-action bar shared by both views ──────────────────────
  const subActionBar = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
      {/* View toggle */}
      <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 10, background: 'var(--bg-tint)', border: '1px solid var(--line)' }}>
        {(['list', 'cards'] as const).map(m => (
          <button key={m} onClick={() => setViewMode(m)} style={{
            padding: '5px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: 'none',
            background: viewMode === m ? 'var(--card)' : 'transparent',
            color: viewMode === m ? 'var(--ink)' : 'var(--ink-4)',
            boxShadow: viewMode === m ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
            transition: 'all 0.18s',
          }}>
            {m === 'list' ? '≡ List' : '▣ Focus'}
          </button>
        ))}
      </div>

      {/* Break reminder chip (mobile + desktop when no sidebar) */}
      {showBreak && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: 20, background: '#FFFBEB', border: '1px solid rgba(244,183,64,0.5)' }}>
          <span style={{ fontSize: 13 }}>⏸</span>
          <span style={{ fontSize: 11, color: '#78350F', fontWeight: 600 }}>Take a break</span>
          <button onClick={() => setBreakDismissed(true)} style={{ fontSize: 11, color: '#78350F', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>
        </div>
      )}
    </div>
  );

  // ── Focus card chat state ─────────────────────────────────────
  const [focusChatOpen,     setFocusChatOpen]     = useState(false);
  const [focusChatMessages, setFocusChatMessages] = useState<ChatMessage[]>([]);
  const [focusChatStreaming, setFocusChatStreaming] = useState(false);
  const focusChatBottomRef = useRef<HTMLDivElement>(null);

  // Reset chat when card changes
  useEffect(() => {
    setFocusChatOpen(false);
    setFocusChatMessages([]);
  }, [safeCardIdx]);

  useEffect(() => {
    if (focusChatOpen) focusChatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [focusChatMessages, focusChatOpen]);

  const handleFocusChat = async (text: string) => {
    if (!allCards[safeCardIdx]) return;
    const { sub, topic: ct } = allCards[safeCardIdx];
    const cardDesc = `Subtopic: "${sub.title}"\nContent: ${sub.content}`;
    const sys = buildChatSystemPrompt(topic, null, cardDesc, profile);
    const userMsg: ChatMessage = { role: 'user', content: text };
    const history = [...focusChatMessages, userMsg];
    setFocusChatMessages([...history, { role: 'assistant', content: '' }]);
    setFocusChatStreaming(true);
    let out = '';
    try {
      await streamCardChat(history, sys, chunk => {
        out += chunk;
        setFocusChatMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: 'assistant', content: out }; return u; });
      });
    } catch { setFocusChatMessages(prev => prev.slice(0, -1)); }
    finally { setFocusChatStreaming(false); void ct; }
  };

  // ── Card view (one subtopic at a time) ────────────────────────
  const cardView = (() => {
    if (allCards.length === 0) return null;
    const { sub, key, color, si, topic: ct } = allCards[safeCardIdx];
    const isRead   = subStatuses[key] === 'read' || subStatuses[key] === 'learnt';
    const isLearnt = subStatuses[key] === 'learnt';
    const termsPerSub = Math.ceil(ct.keyTerms.length / Math.max(1, (ct.subtopics ?? []).length));
    const subTerms = ct.keyTerms.slice(si * termsPerSub, (si + 1) * termsPerSub);

    return (
      /* Outer: scrollable column, card + chat flow naturally below each other */
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <div style={{ maxWidth: 580, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 20 }}>

          {/* Progress strip */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-3)' }}>{safeCardIdx + 1} / {allCards.length}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>{progressPct}% complete</span>
            </div>
            <div style={{ height: 5, borderRadius: 999, background: 'var(--bg-tint)', overflow: 'hidden' }}>
              <div style={{ width: `${((safeCardIdx + 1) / allCards.length) * 100}%`, height: '100%', background: `linear-gradient(90deg, ${color}, ${color}88)`, borderRadius: 999, transition: 'width 0.4s ease' }} />
            </div>
          </div>

          {/* Card — natural height, no internal scroll */}
          <div style={{ borderRadius: isMobile ? 16 : 20, border: `2px solid ${color}44`, background: 'var(--card)', overflow: 'hidden', boxShadow: '0 4px 24px rgba(0,0,0,0.07)' }}>

            {/* Card header */}
            <div style={{ padding: isMobile ? '14px 16px 10px' : '16px 22px 12px', borderBottom: `1px solid ${color}22` }}>
              <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.09em', color, marginBottom: 4 }}>{ct.title}</div>
              <h2 style={{ fontSize: isMobile ? 17 : 20, fontWeight: 800, color: 'var(--ink)', lineHeight: 1.3, margin: 0 }}>{sub.title}</h2>
            </div>

            {/* Card body — flows freely, no scroll trap */}
            <div style={{ padding: isMobile ? '14px 16px' : '16px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ margin: 0, fontSize: isMobile ? 14 : 15, lineHeight: 1.8, color: 'var(--ink-2)' }}>{sub.content}</p>
              {subTerms.length > 0 && <FocusTerms terms={subTerms} color={color} />}
            </div>

            {/* Card footer */}
            <div style={{ borderTop: `1px solid ${color}22` }}>
              {/* Ask about this card — prominent toggle */}
              <div style={{ padding: '10px 16px', borderBottom: `1px solid ${color}11` }}>
                <button
                  onClick={() => setFocusChatOpen(o => !o)}
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: 10, cursor: 'pointer',
                    background: focusChatOpen ? color : color + '12',
                    border: `1.5px solid ${color}55`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                    fontSize: 13, fontWeight: 700,
                    color: focusChatOpen ? 'white' : color,
                    transition: 'all 0.2s',
                  }}
                >
                  <span style={{ fontSize: 15 }}>✨</span>
                  {focusChatOpen ? 'Close chat' : 'Ask about this card'}
                </button>
              </div>

              {/* Status buttons */}
              <div style={{ padding: '10px 16px', display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button onClick={() => setSubStatuses(prev => ({ ...prev, [key]: prev[key] === 'read' ? 'unread' : 'read' }))}
                  style={{ padding: '8px 18px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1.5px solid ${isRead ? color : 'var(--line)'}`, background: isRead && !isLearnt ? color : isRead ? color + '15' : 'var(--bg-tint)', color: isRead && !isLearnt ? 'white' : isRead ? color : 'var(--ink-3)', transition: 'all 0.2s', whiteSpace: 'nowrap' }}>
                  ✓ Read
                </button>
                {sub.quiz && (
                  <button onClick={() => setActiveQuiz({ key, quiz: sub.quiz!, color, selected: null, revealed: false })}
                    style={{ padding: '8px 18px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1.5px solid ${color}66`, background: color + '0f', color, transition: 'all 0.2s', whiteSpace: 'nowrap' }}>
                    🧪 Test Me
                  </button>
                )}
                <button onClick={() => setSubStatuses(prev => ({ ...prev, [key]: prev[key] === 'learnt' ? 'unread' : 'learnt' }))}
                  style={{ padding: '8px 18px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1.5px solid ${isLearnt ? '#8C5BD9' : 'var(--line)'}`, background: isLearnt ? '#8C5BD9' : 'var(--bg-tint)', color: isLearnt ? 'white' : 'var(--ink-3)', transition: 'all 0.2s', whiteSpace: 'nowrap' }}>
                  🧠 Learnt
                </button>
              </div>
            </div>
          </div>

          {/* Chat panel — sits BELOW the card, not trapped inside */}
          {focusChatOpen && (
            <div style={{ borderRadius: 16, border: `1.5px solid ${color}44`, background: 'var(--card)', overflow: 'hidden', boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
              {/* Chat header */}
              <div style={{ padding: '11px 16px', background: color + '0d', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${color}22` }}>
                <span style={{ fontSize: 15 }}>✨</span>
                <span style={{ fontSize: 13, fontWeight: 800, color }}>Ask about this card</span>
              </div>
              {/* Messages */}
              <div style={{ maxHeight: 260, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 9 }}>
                {focusChatMessages.length === 0 && (
                  <div style={{ fontSize: 13, color: 'var(--ink-4)', textAlign: 'center', padding: '18px 0' }}>Ask anything about this subtopic</div>
                )}
                {focusChatMessages.map((m, mi) => (
                  <div key={mi} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    <div style={{ maxWidth: '85%', padding: '8px 13px', borderRadius: m.role === 'user' ? '14px 14px 3px 14px' : '14px 14px 14px 3px', background: m.role === 'user' ? color : 'var(--bg-tint)', color: m.role === 'user' ? 'white' : 'var(--ink-2)', fontSize: 13, lineHeight: 1.55 }}>
                      {m.content || <span style={{ opacity: 0.5 }}>…</span>}
                    </div>
                  </div>
                ))}
                <div ref={focusChatBottomRef} />
              </div>
              <FocusChatInput color={color} streaming={focusChatStreaming} onSend={handleFocusChat} />
            </div>
          )}

          {/* Prev / Next */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <button onClick={() => setCardIdx(i => Math.max(0, i - 1))} disabled={safeCardIdx === 0}
              style={{ padding: '8px 20px', borderRadius: 12, fontSize: 13, fontWeight: 700, cursor: safeCardIdx === 0 ? 'default' : 'pointer', border: '1.5px solid var(--line)', background: 'var(--card)', color: 'var(--ink-2)', opacity: safeCardIdx === 0 ? 0.35 : 1, transition: 'opacity 0.2s' }}>
              ← Prev
            </button>
            <div style={{ flex: 1, display: 'flex', gap: 5, overflow: 'hidden', justifyContent: 'center' }}>
              {allCards.map((c, di) => (
                <div key={di} onClick={() => setCardIdx(di)} style={{ width: di === safeCardIdx ? 20 : 7, height: 7, borderRadius: 4, flexShrink: 0, cursor: 'pointer', transition: 'all 0.25s', background: subStatuses[c.key] && subStatuses[c.key] !== 'unread' ? c.color : di === safeCardIdx ? 'var(--brand)' : 'var(--line)' }} />
              ))}
            </div>
            <button onClick={() => setCardIdx(i => Math.min(allCards.length - 1, i + 1))} disabled={safeCardIdx === allCards.length - 1}
              style={{ padding: '8px 20px', borderRadius: 12, fontSize: 13, fontWeight: 700, cursor: safeCardIdx === allCards.length - 1 ? 'default' : 'pointer', border: '1.5px solid var(--line)', background: 'var(--card)', color: 'var(--ink-2)', opacity: safeCardIdx === allCards.length - 1 ? 0.35 : 1, transition: 'opacity 0.2s' }}>
              Next →
            </button>
          </div>

        </div>
      </div>
    );
  })();

  // ── Main content ─────────────────────────────────────────────
  const mainContent = (
    <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: isMobile ? '20px 16px 32px' : '24px 28px 40px' }}>

        {subActionBar}

        {viewMode === 'cards' ? cardView : (<>

        {/* Topic pills nav */}
        <div style={{ display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 4, marginBottom: 24, scrollbarWidth: 'none' }}>
          {documentReading.topics.map((t, i) => {
            const color   = TOPIC_COLORS[i % TOPIC_COLORS.length];
            const topicSubKeys = (t.subtopics ?? []).map((_, si) => `${t.topicId}-${si}`);
            const topicDone  = topicSubKeys.filter(k => subStatuses[k] && subStatuses[k] !== 'unread').length;
            const topicTotal = topicSubKeys.length;
            const topicComplete = topicTotal > 0 && topicDone === topicTotal;
            return (
              <button key={t.topicId} onClick={() => scrollTo(t.topicId)} style={{
                whiteSpace: 'nowrap', padding: '5px 11px', borderRadius: 999,
                background: topicComplete ? color : 'var(--bg-tint)',
                color: topicComplete ? 'white' : 'var(--ink-3)',
                border: `1.5px solid ${topicComplete ? color : topicDone > 0 ? color + '55' : 'var(--line)'}`,
                cursor: 'pointer', fontSize: 12, fontWeight: 700, transition: 'all 0.2s',
              }}>
                {topicComplete ? '✓ ' : topicDone > 0 ? `${topicDone}/${topicTotal} ` : ''}{i + 1} · {t.title.split(' ').slice(0, 3).join(' ')}
              </button>
            );
          })}
        </div>

        {/* Topic sections */}
        {documentReading.topics.map((t, i) => {
          const color = TOPIC_COLORS[i % TOPIC_COLORS.length];
          const subs  = t.subtopics ?? [];
          return (
            <div key={t.topicId} id={`rt-${t.topicId}`} style={{ marginBottom: 44, scrollMarginTop: 12 }}>
              {/* Topic heading */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: color, display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 800, color: 'white', flexShrink: 0 }}>{i + 1}</div>
                <div style={{ flex: 1, height: 2, background: `linear-gradient(90deg, ${color}99, transparent)`, borderRadius: 2 }} />
              </div>
              <h2 style={{ fontSize: 19, fontWeight: 800, color, marginBottom: 14, lineHeight: 1.3 }}>{t.title}</h2>

              {/* Subtopic accordions with read/learnt ticks + key terms inside */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {subs.map((sub, si) => {
                  const key    = `${t.topicId}-${si}`;
                  const isOpen = expandedSubs.has(key);
                  const status = subStatuses[key] ?? 'unread';
                  const isRead   = status === 'read' || status === 'learnt';
                  const isLearnt = status === 'learnt';
                  // Distribute key terms across subtopics
                  const termsPerSub = Math.ceil(t.keyTerms.length / subs.length);
                  const subTerms = t.keyTerms.slice(si * termsPerSub, (si + 1) * termsPerSub);
                  return (
                    <div key={key} style={{ borderRadius: 14, border: `1.5px solid ${isRead ? color + '66' : isOpen ? color + '44' : 'var(--line)'}`, overflow: 'hidden', transition: 'border-color 0.25s', background: isRead ? color + '06' : 'var(--card)' }}>
                      {/* Accordion header */}
                      <button
                        onClick={() => toggleSub(key)}
                        style={{ width: '100%', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                      >
                        <div style={{ width: 22, height: 22, borderRadius: 7, background: isRead ? color : isOpen ? color : color + '20', border: `1.5px solid ${color}`, display: 'grid', placeItems: 'center', flexShrink: 0, fontSize: 10, fontWeight: 800, color: isRead || isOpen ? 'white' : color, transition: 'all 0.2s' }}>
                          {isLearnt ? '🧠' : isRead ? '✓' : si + 1}
                        </div>
                        <span style={{ flex: 1, fontWeight: 700, fontSize: 14, color: isRead ? color : 'var(--ink)' }}>{sub.title}</span>
                        {/* Status dot when collapsed */}
                        {!isOpen && isRead && (
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: isLearnt ? '#8C5BD9' : color, flexShrink: 0 }} />
                        )}
                        <div style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }}>
                          <Icon name="chevron-right" size={15} stroke={isOpen ? color : 'var(--ink-4)'} />
                        </div>
                      </button>

                      {/* Expanded content */}
                      {isOpen && (
                        <div style={{ borderTop: `1px solid ${color}22` }}>
                          {/* Reading content */}
                          <div style={{ padding: '12px 16px 12px 46px' }}>
                            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.85, color: 'var(--ink-2)' }}>{sub.content}</p>
                          </div>

                          {/* Key terms for this subtopic */}
                          {subTerms.length > 0 && (
                            <div style={{ margin: '0 16px 12px 46px', borderRadius: 10, border: `1px solid ${color}33`, overflow: 'hidden' }}>
                              <div style={{ padding: '7px 12px', background: color + '0d', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color }}>
                                📖 Key Terms
                              </div>
                              {subTerms.map((kt, ki) => (
                                <div key={kt.term} style={{ padding: '9px 12px', borderTop: `1px solid ${color}22`, background: ki % 2 === 0 ? 'transparent' : color + '04' }}>
                                  <span style={{ fontWeight: 700, fontSize: 13, color }}>{kt.term}</span>
                                  <span style={{ fontSize: 13, color: 'var(--ink-3)', marginLeft: 6 }}>— {kt.definition}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Read / Test Me / Learnt buttons */}
                          <div style={{ padding: '10px 14px', borderTop: `1px solid ${color}11`, display: 'flex', gap: 7, alignItems: 'center' }}>
                            <button
                              onClick={() => markStatus(key, 'read')}
                              style={{
                                flex: 1, padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                                cursor: 'pointer', border: `1.5px solid ${isRead ? color : 'var(--line)'}`,
                                background: isRead && !isLearnt ? color : isRead ? color + '15' : 'var(--bg-tint)',
                                color: isRead && !isLearnt ? 'white' : isRead ? color : 'var(--ink-3)',
                                transition: 'all 0.2s',
                              }}
                            >
                              ✓ Read
                            </button>
                            {sub.quiz && (
                              <button
                                onClick={() => setActiveQuiz({ key, quiz: sub.quiz!, color, selected: null, revealed: false })}
                                style={{
                                  flex: 1, padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                                  cursor: 'pointer', border: `1.5px solid ${color}66`,
                                  background: 'transparent', color,
                                  transition: 'all 0.2s',
                                }}
                              >
                                🧪 Test Me
                              </button>
                            )}
                            <button
                              onClick={() => markStatus(key, 'learnt')}
                              style={{
                                flex: 1, padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                                cursor: 'pointer', border: `1.5px solid ${isLearnt ? '#8C5BD9' : 'var(--line)'}`,
                                background: isLearnt ? '#8C5BD9' : 'var(--bg-tint)',
                                color: isLearnt ? 'white' : 'var(--ink-3)',
                                transition: 'all 0.2s',
                              }}
                            >
                              🧠 Learnt
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Why it matters */}
              <div style={{ padding: '12px 14px', borderRadius: 12, background: color + '0d', border: `1px solid ${color}33`, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 15, flexShrink: 0 }}>💡</span>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color, marginBottom: 4 }}>Why it matters</div>
                  <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.7 }}>{t.whyItMatters}</div>
                </div>
              </div>
            </div>
          );
        })}
        </>)}
      </div>
    </div>
  );

  // ── Quiz modal ───────────────────────────────────────────────
  const quizModal = activeQuiz && (() => {
    const { quiz, color, selected, revealed } = activeQuiz;
    const isCorrect = revealed && selected === quiz.answer;
    return (
      <div
        onClick={(e) => { if (e.target === e.currentTarget) setActiveQuiz(null); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 2000,
          background: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '24px 16px',
        }}
      >
        <div style={{
          width: '100%', maxWidth: 460,
          background: 'var(--card)',
          borderRadius: 20,
          boxShadow: '0 24px 64px rgba(0,0,0,0.3)',
          overflow: 'hidden',
        }}>
          {/* Modal header */}
          <div style={{ padding: '16px 20px 14px', borderBottom: `2px solid ${color}33`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>🧪</span>
              <span style={{ fontSize: 14, fontWeight: 800, color }}>Quick Test</span>
            </div>
            <button
              onClick={() => setActiveQuiz(null)}
              style={{ width: 28, height: 28, borderRadius: '50%', border: '1px solid var(--line)', background: 'var(--bg-tint)', cursor: 'pointer', fontSize: 14, color: 'var(--ink-3)', display: 'grid', placeItems: 'center' }}
            >✕</button>
          </div>

          {/* Question + options */}
          <div style={{ padding: '18px 20px 14px' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)', lineHeight: 1.5, marginBottom: 16 }}>
              {quiz.question}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {quiz.options.map((opt, oi) => {
                const isSelected = oi === selected;
                const isAnswer   = oi === quiz.answer;
                let bg = 'var(--bg-tint)', border = 'var(--line)', textColor = 'var(--ink-2)', prefix = String.fromCharCode(65 + oi);
                if (revealed) {
                  if (isAnswer)                    { bg = 'rgba(47,158,94,0.12)'; border = 'var(--brand)'; textColor = 'var(--brand)'; prefix = '✓'; }
                  else if (isSelected && !isAnswer) { bg = 'rgba(255,122,92,0.1)';  border = '#FF7A5C';     textColor = '#FF7A5C';      prefix = '✗'; }
                }
                return (
                  <button
                    key={oi}
                    disabled={revealed}
                    onClick={() => answerQuiz(oi)}
                    style={{
                      padding: '11px 14px', borderRadius: 12,
                      border: `1.5px solid ${border}`,
                      background: bg, color: textColor,
                      fontSize: 13, fontWeight: revealed && isAnswer ? 700 : 500,
                      textAlign: 'left', cursor: revealed ? 'default' : 'pointer',
                      display: 'flex', alignItems: 'center', gap: 10, transition: 'all 0.2s',
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 12, width: 16, flexShrink: 0 }}>{prefix}</span>
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Result footer */}
          {revealed && (
            <div style={{
              padding: '14px 20px 18px',
              borderTop: `1px solid ${isCorrect ? 'rgba(47,158,94,0.2)' : 'rgba(255,122,92,0.2)'}`,
              background: isCorrect ? 'rgba(47,158,94,0.05)' : 'rgba(255,122,92,0.05)',
            }}>
              {isCorrect ? (
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--brand)' }}>
                  🎉 Correct! Marked as Learnt — closing…
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 13, color: '#CC3B1A', fontWeight: 600, lineHeight: 1.55, marginBottom: 12 }}>
                    {quiz.explanation}
                  </div>
                  <button
                    onClick={() => setActiveQuiz(prev => prev ? { ...prev, selected: null, revealed: false } : null)}
                    style={{ padding: '8px 18px', borderRadius: 10, fontSize: 13, fontWeight: 700, background: color, color: 'white', border: 'none', cursor: 'pointer' }}
                  >
                    Try again →
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--bg)', overflow: 'hidden' }}>
      {quizModal}
      {/* Header */}
      <div style={{ padding: '0 16px', height: 58, flexShrink: 0, background: 'var(--card)', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-ghost" onClick={onBack} style={{ padding: 8, borderRadius: '50%', minWidth: 44, minHeight: 44 }} aria-label="Back to map">
          <Icon name="arrow-left" size={20} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="label-eyebrow" style={{ marginBottom: 1 }}>Step 2 · Read</div>
          <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{topic}</div>
        </div>
        {hasCache && (
          <button className="btn btn-ghost" onClick={onRegenerate} style={{ fontSize: 12, padding: '6px 10px', color: 'var(--ink-3)', gap: 5 }}>
            <Icon name="refresh" size={13} stroke="var(--ink-3)" /> Refresh
          </button>
        )}
      </div>

      {/* Body — always row layout; sidebar visible in both List and Focus modes */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden', minHeight: 0 }}>
        {viewMode === 'cards' ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, padding: isMobile ? '14px 14px 10px' : '20px 28px 14px' }}>
            {subActionBar}
            {cardView}
          </div>
        ) : mainContent}
        {showSidebar && sidebar}
      </div>

      {/* Step nav bar */}
      <div style={{ flexShrink: 0, padding: '10px 24px 14px', borderTop: '1px solid var(--line)', background: 'var(--card)', display: 'flex', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', maxWidth: 320, width: '100%' }}>
          {/* Step 1 — Map (done, clickable) */}
          <button onClick={onBack} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--brand)', display: 'grid', placeItems: 'center', fontSize: 14, color: 'white', fontWeight: 800, boxShadow: '0 2px 8px rgba(47,158,94,0.3)' }}>✓</div>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand)', letterSpacing: '0.02em' }}>Map</span>
          </button>

          {/* Line 1→2 */}
          <div style={{ flex: 1, height: 2.5, background: 'var(--brand)', borderRadius: 2, marginBottom: 18 }} />

          {/* Step 2 — Read (active, not clickable) */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '0 4px' }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--brand)', border: '3px solid var(--brand)', display: 'grid', placeItems: 'center', fontSize: 13, color: 'white', fontWeight: 800, boxShadow: '0 0 0 4px rgba(47,158,94,0.15)' }}>2</div>
            <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--brand)', letterSpacing: '0.02em' }}>Read</span>
          </div>

          {/* Line 2→3 (fills green when 100% done) */}
          <div style={{ flex: 1, height: 2.5, background: progressPct >= 100 ? 'var(--brand)' : 'var(--line)', borderRadius: 2, marginBottom: 18, transition: 'background 0.5s' }} />

          {/* Step 3 — Practice (upcoming, clickable) */}
          <button onClick={() => onPractice('activities')} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: progressPct >= 100 ? 'var(--brand)' : 'var(--bg-tint)', border: `2.5px solid ${progressPct >= 100 ? 'var(--brand)' : 'var(--line)'}`, display: 'grid', placeItems: 'center', fontSize: 13, color: progressPct >= 100 ? 'white' : 'var(--ink-4)', fontWeight: 800, transition: 'all 0.4s', boxShadow: progressPct >= 100 ? '0 2px 8px rgba(47,158,94,0.3)' : 'none' }}>3</div>
            <span style={{ fontSize: 11, fontWeight: 700, color: progressPct >= 100 ? 'var(--brand)' : 'var(--ink-3)', letterSpacing: '0.02em', transition: 'color 0.4s' }}>Practice</span>
          </button>
        </div>
      </div>
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

function CompletionView({ cards, score, audit, quizCorrect, quizTotal, elapsed, onBack, onRestart }: {
  cards: FeedCard[]; score: number; audit: FeedAudit | null;
  quizCorrect: number; quizTotal: number; elapsed: number;
  onBack: () => void; onRestart: () => void;
}) {
  const mins    = Math.floor(elapsed / 60000);
  const secs    = Math.floor((elapsed % 60000) / 1000);
  const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;
  const quizPct = quizTotal > 0 ? Math.round((quizCorrect / quizTotal) * 100) : null;

  return (
    <div className="card fade-up" style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 64, marginBottom: 14, animation: 'pop 0.6s ease' }}>🌱</div>
      <h2 className="display" style={{ fontSize: 32, marginBottom: 8 }}>Great work!</h2>
      <p style={{ color: 'var(--ink-2)', marginBottom: 28, fontSize: 15 }}>Your sprout grew a little taller today.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: quizPct !== null ? 16 : 28 }}>
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
      {quizPct !== null && (
        <div style={{ marginBottom: 16, padding: '14px 20px', borderRadius: 14, background: quizPct >= 80 ? 'var(--brand-tint)' : quizPct >= 60 ? '#FFFBEB' : 'var(--coral-soft)', border: `1px solid ${quizPct >= 80 ? 'var(--brand-soft)' : quizPct >= 60 ? 'rgba(244,183,64,0.35)' : 'var(--coral-soft)'}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-3)', marginBottom: 2 }}>Quiz score</div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>{quizCorrect} correct out of {quizTotal}</div>
          </div>
          <div style={{ fontSize: 32, fontWeight: 800, fontFamily: 'var(--font-mono)', color: quizPct >= 80 ? 'var(--brand)' : quizPct >= 60 ? 'var(--gold)' : 'var(--coral)' }}>
            {quizPct}%
          </div>
        </div>
      )}
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
