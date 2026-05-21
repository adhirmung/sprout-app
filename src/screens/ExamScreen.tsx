import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { analyzeAndGenerateExam, generateExamVariant, markExamSubmission } from '../lib/examClaude';
import type { ExamQuestion, ExamResults, GeneratedExam } from '../lib/examClaude';
import {
  dbDeleteExamSet,
  dbLoadAttempts,
  dbLoadAttemptSummaries,
  dbLoadExamSets,
  dbSaveAttempt,
  dbSaveExamSet,
} from '../lib/examDb';
import type { AttemptSummary, StoredAttempt, StoredExamSet } from '../lib/examDb';

// ── Math symbol groups ─────────────────────────────────────────

const SYMBOL_GROUPS: { label: string; items: { display: string; insert: string }[] }[] = [
  {
    label: 'Basic',
    items: [
      { display: '×',   insert: '×'   },
      { display: '÷',   insert: '÷'   },
      { display: '±',   insert: '±'   },
      { display: '≠',   insert: '≠'   },
      { display: '≈',   insert: '≈'   },
      { display: '≤',   insert: '≤'   },
      { display: '≥',   insert: '≥'   },
      { display: '√',   insert: '√'   },
      { display: '∞',   insert: '∞'   },
      { display: '∴',   insert: '∴'   },
    ],
  },
  {
    label: 'Powers',
    items: [
      { display: 'x²',  insert: '²'   },
      { display: 'x³',  insert: '³'   },
      { display: 'xⁿ',  insert: '^n'  },
      { display: 'x⁻¹', insert: '⁻¹'  },
      { display: '∛',   insert: '∛'   },
      { display: '½',   insert: '½'   },
      { display: '¼',   insert: '¼'   },
      { display: '¾',   insert: '¾'   },
    ],
  },
  {
    label: 'Trig',
    items: [
      { display: 'sin',    insert: 'sin '    },
      { display: 'cos',    insert: 'cos '    },
      { display: 'tan',    insert: 'tan '    },
      { display: 'sin⁻¹',  insert: 'sin⁻¹ '  },
      { display: 'cos⁻¹',  insert: 'cos⁻¹ '  },
      { display: 'tan⁻¹',  insert: 'tan⁻¹ '  },
      { display: 'θ',      insert: 'θ'       },
      { display: 'π',      insert: 'π'       },
    ],
  },
  {
    label: 'Calculus',
    items: [
      { display: "f'(x)", insert: "f'(x)" },
      { display: 'd/dx',  insert: 'd/dx '  },
      { display: '∫',     insert: '∫'      },
      { display: '∑',     insert: '∑'      },
      { display: 'lim',   insert: 'lim '   },
      { display: 'Δ',     insert: 'Δ'      },
      { display: '→',     insert: '→'      },
      { display: '∂',     insert: '∂'      },
    ],
  },
  {
    label: 'Greek',
    items: [
      { display: 'α', insert: 'α' },
      { display: 'β', insert: 'β' },
      { display: 'γ', insert: 'γ' },
      { display: 'δ', insert: 'δ' },
      { display: 'λ', insert: 'λ' },
      { display: 'μ', insert: 'μ' },
      { display: 'σ', insert: 'σ' },
      { display: 'φ', insert: 'φ' },
      { display: 'ω', insert: 'ω' },
      { display: 'Ω', insert: 'Ω' },
    ],
  },
  {
    label: 'Sets',
    items: [
      { display: '∈', insert: '∈' },
      { display: '∉', insert: '∉' },
      { display: '∪', insert: '∪' },
      { display: '∩', insert: '∩' },
      { display: '⊂', insert: '⊂' },
      { display: '∅', insert: '∅' },
      { display: '∀', insert: '∀' },
      { display: '∃', insert: '∃' },
    ],
  },
];

// ── Types ──────────────────────────────────────────────────────

type ExamPhase = 'upload' | 'generating' | 'preview' | 'taking' | 'marking' | 'results';

interface UploadedPaper {
  file:   File;
  base64: string;
  name:   string;
  sizeMB: number;
}

// Sidebar category
type SetCategory = 'untaken' | 'incomplete' | 'complete';

function categorizeSet(
  setId:     string,
  summaries: Record<string, AttemptSummary>,
): SetCategory {
  const s = summaries[setId];
  if (!s || s.count === 0)                            return 'untaken';
  if (s.bestPct === null || s.bestPct < 50)           return 'incomplete';
  return 'complete';
}

// ── Math keyboard ──────────────────────────────────────────────

function MathKeyboard({ onInsert, onClose }: {
  onInsert: (sym: string) => void;
  onClose:  () => void;
}) {
  const [activeGroup, setActiveGroup] = useState(0);

  return (
    <div style={{
      border: '1.5px solid var(--line)', borderRadius: 14,
      background: 'var(--card)', padding: '12px 14px', marginBottom: 10,
      boxShadow: '0 4px 24px rgba(0,0,0,0.10)',
      animation: 'math-kb-in 0.15s ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {SYMBOL_GROUPS.map((g, i) => (
          <button
            key={g.label}
            onClick={() => setActiveGroup(i)}
            style={{
              padding: '3px 10px', borderRadius: 7,
              fontSize: 11, fontWeight: 700, cursor: 'pointer',
              border: 'none',
              background: activeGroup === i ? 'var(--brand)'  : 'var(--bg)',
              color:      activeGroup === i ? '#fff'          : 'var(--ink-3)',
              transition: 'background 0.12s, color 0.12s',
            }}
          >
            {g.label}
          </button>
        ))}
        <button
          onClick={onClose}
          aria-label="Close math keyboard"
          style={{
            marginLeft: 'auto', padding: '3px 8px', borderRadius: 7,
            border: '1px solid var(--line)', background: 'transparent',
            color: 'var(--ink-4)', cursor: 'pointer', fontSize: 13, lineHeight: '1',
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {SYMBOL_GROUPS[activeGroup].items.map(sym => (
          <button
            key={sym.insert}
            onClick={() => onInsert(sym.insert)}
            title={`Insert ${sym.insert}`}
            style={{
              minWidth: 44, height: 38, padding: '0 8px',
              borderRadius: 8, border: '1.5px solid var(--line)',
              background: 'var(--bg)', cursor: 'pointer',
              fontSize: 15, fontWeight: 600, color: 'var(--ink)',
              fontFamily: '"STIX Two Math", "Cambria Math", math, serif',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'border-color 0.12s, background 0.12s',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.borderColor = 'var(--brand)';
              (e.currentTarget as HTMLElement).style.background  = 'var(--brand-tint)';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.borderColor = 'var(--line)';
              (e.currentTarget as HTMLElement).style.background  = 'var(--bg)';
            }}
          >
            {sym.display}
          </button>
        ))}
      </div>

      <style>{`
        @keyframes math-kb-in {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function gradeColor(grade: string): string {
  switch (grade) {
    case 'A': return '#059669';
    case 'B': return '#16a34a';
    case 'C': return '#ca8a04';
    case 'D': return '#ea580c';
    default:  return '#dc2626';
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case 'mcq':         return 'MCQ';
    case 'short':       return 'Short Answer';
    case 'calculation': return 'Calculation';
    case 'essay':       return 'Essay';
    default:            return type;
  }
}

function typeChip(type: string): { bg: string; fg: string } {
  switch (type) {
    case 'mcq':         return { bg: '#EFF6FF', fg: '#1D4ED8' };
    case 'short':       return { bg: '#F0FDF4', fg: '#15803D' };
    case 'calculation': return { bg: '#FDF4FF', fg: '#7E22CE' };
    case 'essay':       return { bg: '#FFF7ED', fg: '#C2410C' };
    default:            return { bg: 'var(--brand-tint)', fg: 'var(--brand-2)' };
  }
}

// ── Main screen ────────────────────────────────────────────────

interface ExamScreenProps {
  userId?: string;
  onBack:  () => void;
}

export function ExamScreen({ userId, onBack }: ExamScreenProps) {
  // ── DB state ─────────────────────────────────────────────────
  const [examSets,         setExamSets]         = useState<StoredExamSet[]>([]);
  const [attemptSummaries, setAttemptSummaries] = useState<Record<string, AttemptSummary>>({});
  const [selectedSetId,    setSelectedSetId]    = useState<string | null>(null);
  const [attempts,         setAttempts]         = useState<StoredAttempt[]>([]);
  const [loadingSets,      setLoadingSets]      = useState(false);

  // ── Session state ─────────────────────────────────────────────
  const [phase,            setPhase]            = useState<ExamPhase>('upload');
  const [papers,           setPapers]           = useState<UploadedPaper[]>([]);
  const [dragging,         setDragging]         = useState(false);
  const [progressMsg,      setProgressMsg]      = useState('');
  const [exam,             setExam]             = useState<GeneratedExam | null>(null);
  const [answers,          setAnswers]          = useState<Record<string, string>>({});
  const [results,          setResults]          = useState<ExamResults | null>(null);
  const [error,            setError]            = useState<string | null>(null);
  const [timeLeft,         setTimeLeft]         = useState(0);
  const [startTime,        setStartTime]        = useState(0);
  const [savingError,      setSavingError]      = useState<string | null>(null);
  // flag: open file-picker as soon as UploadPanel mounts
  const [openPickerOnce,   setOpenPickerOnce]   = useState(false);

  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submitRef   = useRef<() => Promise<void>>(async () => {});

  // ── Load exam sets + summaries on mount ───────────────────────
  useEffect(() => {
    if (!userId) return;
    setLoadingSets(true);
    Promise.all([
      dbLoadExamSets(userId),
      dbLoadAttemptSummaries(userId),
    ]).then(([sets, summaries]) => {
      setExamSets(sets);
      setAttemptSummaries(summaries);
      setLoadingSets(false);
    });
  }, [userId]);

  // ── Open file picker after UploadPanel mounts ─────────────────
  useEffect(() => {
    if (!openPickerOnce || phase !== 'upload') return;
    fileInputRef.current?.click();
    setOpenPickerOnce(false);
  }, [openPickerOnce, phase]);

  // ── Load attempts when selection changes ─────────────────────
  useEffect(() => {
    if (!selectedSetId) { setAttempts([]); return; }
    dbLoadAttempts(selectedSetId).then(setAttempts);
  }, [selectedSetId]);

  // ── Sidebar actions ───────────────────────────────────────────

  const handleSelectSet = (set: StoredExamSet) => {
    setSelectedSetId(set.id);
    setExam(set.examData);
    setAnswers({});
    setResults(null);
    setError(null);
    setSavingError(null);
    setPhase('preview');
  };

  /**
   * "New Exam" — resets everything to the upload screen AND immediately
   * opens the file-picker once UploadPanel has mounted.
   */
  const handleNewExam = () => {
    setSelectedSetId(null);
    setExam(null);
    setPapers([]);
    setAnswers({});
    setResults(null);
    setError(null);
    setSavingError(null);
    setPhase('upload');
    setOpenPickerOnce(true); // triggers effect after render
  };

  const handleDeleteSet = async (id: string) => {
    if (!window.confirm('Delete this exam set and all its history?')) return;
    await dbDeleteExamSet(id);
    setExamSets(prev => prev.filter(s => s.id !== id));
    setAttemptSummaries(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (selectedSetId === id) {
      setSelectedSetId(null);
      setExam(null);
      setAttempts([]);
      setPhase('upload');
    }
  };

  // ── File handling ─────────────────────────────────────────────

  const handleFiles = useCallback(async (files: File[]) => {
    const pdfs = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (!pdfs.length) return;
    const loaded: UploadedPaper[] = await Promise.all(
      pdfs.map(async file => ({
        file,
        base64: await readFileAsBase64(file),
        name:   file.name.replace(/\.pdf$/i, ''),
        sizeMB: file.size / (1024 * 1024),
      }))
    );
    setPapers(prev => [...prev, ...loaded].slice(0, 5));
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFiles(Array.from(e.dataTransfer.files));
  }, [handleFiles]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(Array.from(e.target.files));
    e.target.value = '';
  }, [handleFiles]);

  // ── Generate exam ─────────────────────────────────────────────

  const handleGenerate = async () => {
    if (papers.length < 2) return;
    setPhase('generating');
    setError(null);
    setSavingError(null);
    try {
      const generated = await analyzeAndGenerateExam(
        papers.map(p => p.base64),
        setProgressMsg,
        userId,
      );
      setExam(generated);
      setAnswers({});

      if (userId) {
        const saved = await dbSaveExamSet(userId, {
          title:           generated.title,
          subject:         generated.subject,
          grade:           generated.grade,
          paperNames:      papers.map(p => p.name),
          examData:        generated,
          totalMarks:      generated.totalMarks,
          durationMinutes: generated.durationMinutes,
        });
        if (saved) {
          setExamSets(prev => [saved, ...prev]);
          setAttemptSummaries(prev => ({ ...prev, [saved.id]: { count: 0, bestPct: null } }));
          setSelectedSetId(saved.id);
          setAttempts([]);
        } else {
          setSavingError('Exam generated but could not be saved to your history.');
        }
      }

      setPhase('preview');
    } catch (err) {
      setError((err as Error).message || 'Failed to generate exam. Please try again.');
      setPhase('upload');
    }
  };

  // ── Start / retake ────────────────────────────────────────────

  const handleStartExam = useCallback(() => {
    if (!exam) return;
    setAnswers({});
    setResults(null);
    setTimeLeft(exam.durationMinutes * 60);
    setStartTime(Date.now());
    setPhase('taking');
  }, [exam]);

  // ── Generate variant from existing exam ──────────────────────

  const handleGenerateVariant = useCallback(async () => {
    if (!exam) return;

    // Collect all previously generated exams for this set so Claude avoids
    // repeating question stems the student has already seen.
    const siblingExams = examSets
      .filter(s => s.id !== selectedSetId &&
                   s.subject === exam.subject &&
                   s.grade   === exam.grade)
      .map(s => s.examData);

    setPhase('generating');
    setProgressMsg('Preparing a fresh variant…');
    setError(null);
    setSavingError(null);

    try {
      const variant = await generateExamVariant(
        exam,
        siblingExams,
        setProgressMsg,
        userId,
      );

      setExam(variant);
      setAnswers({});

      if (userId) {
        // Reuse the same paper names so the sidebar still shows the source
        const sourcePaperNames = examSets.find(s => s.id === selectedSetId)?.paperNames ?? [];
        const saved = await dbSaveExamSet(userId, {
          title:           variant.title,
          subject:         variant.subject,
          grade:           variant.grade,
          paperNames:      sourcePaperNames,
          examData:        variant,
          totalMarks:      variant.totalMarks,
          durationMinutes: variant.durationMinutes,
        });
        if (saved) {
          setExamSets(prev => [saved, ...prev]);
          setAttemptSummaries(prev => ({ ...prev, [saved.id]: { count: 0, bestPct: null } }));
          setSelectedSetId(saved.id);
          setAttempts([]);
        } else {
          setSavingError('Variant generated but could not be saved to your history.');
        }
      }

      setPhase('preview');
    } catch (err) {
      setError((err as Error).message || 'Failed to generate variant. Please retry.');
      setPhase('preview');
    }
  }, [exam, examSets, selectedSetId, userId]);

  // ── Submit exam ───────────────────────────────────────────────

  const handleSubmitExam = useCallback(async () => {
    if (!exam) return;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    setPhase('marking');
    setProgressMsg('Marking your answers…');
    try {
      const examResults = await markExamSubmission(exam, answers, setProgressMsg, userId);
      setResults(examResults);

      if (userId && selectedSetId) {
        const saved = await dbSaveAttempt(selectedSetId, userId, answers, examResults, elapsed);
        if (saved) {
          setAttempts(prev => [saved, ...prev]);
          // keep sidebar summaries fresh
          setAttemptSummaries(prev => {
            const existing = prev[selectedSetId] ?? { count: 0, bestPct: null };
            const newBest  = examResults.percentage > (existing.bestPct ?? -1)
              ? examResults.percentage
              : existing.bestPct;
            return { ...prev, [selectedSetId]: { count: existing.count + 1, bestPct: newBest } };
          });
        }
      }

      setPhase('results');
    } catch (err) {
      setError((err as Error).message || 'Marking failed. Please try again.');
      setPhase('taking');
    }
  }, [exam, answers, userId, selectedSetId, startTime]);

  useEffect(() => { submitRef.current = handleSubmitExam; }, [handleSubmitExam]);

  // ── Countdown timer ───────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'taking') return;
    timerRef.current = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) { clearInterval(timerRef.current!); void submitRef.current(); return 0; }
        return t - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [phase]);

  // ── Full-screen phases (no sidebar) ──────────────────────────

  if (phase === 'taking' && exam) {
    return (
      <TakingView
        exam={exam}
        answers={answers}
        timeLeft={timeLeft}
        onAnswer={(id, val) => setAnswers(prev => ({ ...prev, [id]: val }))}
        onSubmit={handleSubmitExam}
      />
    );
  }

  if (phase === 'generating' || phase === 'marking') {
    return (
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
        <ScreenHeader title="Exam Module" onBack={onBack} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: 32 }}>
          <span style={{ fontSize: 52 }}>{phase === 'generating' ? '📝' : '✍️'}</span>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--ink)', textAlign: 'center' }}>
            {phase === 'generating' ? 'Creating your practice exam…' : 'Marking your submission…'}
          </div>
          <div style={{ fontSize: 14, color: 'var(--ink-3)', textAlign: 'center', maxWidth: 320 }}>{progressMsg}</div>
          <LoadingDots />
        </div>
      </div>
    );
  }

  // ── Sidebar + right panel layout ──────────────────────────────

  // Categorise exam sets for three-section sidebar
  const untaken    = examSets.filter(s => categorizeSet(s.id, attemptSummaries) === 'untaken');
  const incomplete = examSets.filter(s => categorizeSet(s.id, attemptSummaries) === 'incomplete');
  const complete   = examSets.filter(s => categorizeSet(s.id, attemptSummaries) === 'complete');

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <ScreenHeader title="Exam Module" onBack={onBack} />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── Left sidebar ── */}
        <aside style={{
          width: 240, flexShrink: 0,
          display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--line)',
          background: 'var(--card)',
          overflow: 'hidden',
        }}>
          {/* New exam button — opens file picker directly */}
          <div style={{ padding: '12px 10px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleNewExam}
              style={{
                width: '100%', fontSize: 13, padding: '9px 14px', borderRadius: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >
              <span style={{ fontSize: 16, lineHeight: 1, fontWeight: 700 }}>+</span>
              New Exam
            </button>
          </div>

          {/* Saved exams list — three sections */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px 16px' }}>

            {/* Guest */}
            {!userId && (
              <div style={{ padding: '24px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 28, marginBottom: 10 }}>🔒</div>
                <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.7 }}>
                  Sign in to save your exam history and track progress over time.
                </div>
              </div>
            )}

            {/* Loading */}
            {userId && loadingSets && (
              <div style={{ padding: '20px 10px', textAlign: 'center', color: 'var(--ink-4)', fontSize: 13 }}>
                Loading…
              </div>
            )}

            {/* Truly empty */}
            {userId && !loadingSets && examSets.length === 0 && (
              <div style={{ padding: '24px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 28, marginBottom: 10 }}>📋</div>
                <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.7 }}>
                  No saved exams yet.<br />Click <strong>New Exam</strong> to get started.
                </div>
              </div>
            )}

            {/* ── Untaken ── */}
            {untaken.length > 0 && (
              <>
                <SectionLabel label="Untaken" dot="#94a3b8" count={untaken.length} />
                {untaken.map(set => (
                  <ExamSetCard
                    key={set.id}
                    set={set}
                    isSelected={set.id === selectedSetId}
                    summary={attemptSummaries[set.id]}
                    onSelect={() => handleSelectSet(set)}
                    onDelete={() => void handleDeleteSet(set.id)}
                  />
                ))}
              </>
            )}

            {/* ── Incomplete ── */}
            {incomplete.length > 0 && (
              <>
                <SectionLabel label="Incomplete" dot="#f97316" count={incomplete.length} />
                {incomplete.map(set => (
                  <ExamSetCard
                    key={set.id}
                    set={set}
                    isSelected={set.id === selectedSetId}
                    summary={attemptSummaries[set.id]}
                    onSelect={() => handleSelectSet(set)}
                    onDelete={() => void handleDeleteSet(set.id)}
                  />
                ))}
              </>
            )}

            {/* ── Complete ── */}
            {complete.length > 0 && (
              <>
                <SectionLabel label="Complete" dot="#22c55e" count={complete.length} />
                {complete.map(set => (
                  <ExamSetCard
                    key={set.id}
                    set={set}
                    isSelected={set.id === selectedSetId}
                    summary={attemptSummaries[set.id]}
                    onSelect={() => handleSelectSet(set)}
                    onDelete={() => void handleDeleteSet(set.id)}
                  />
                ))}
              </>
            )}
          </div>
        </aside>

        {/* ── Right panel ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {phase === 'upload' && (
            <UploadPanel
              papers={papers}
              dragging={dragging}
              error={error}
              savingError={savingError}
              guestMode={!userId}
              fileInputRef={fileInputRef}
              onDragOver={() => setDragging(true)}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onFileInput={handleFileInput}
              onRemovePaper={i => setPapers(prev => prev.filter((_, j) => j !== i))}
              onGenerate={handleGenerate}
            />
          )}

          {phase === 'preview' && exam && (
            <PreviewPanel
              exam={exam}
              attempts={attempts}
              savingError={savingError}
              onStart={handleStartExam}
              onGenerateVariant={handleGenerateVariant}
            />
          )}

          {phase === 'results' && results && exam && (
            <ResultsPanel
              exam={exam}
              results={results}
              onRetake={handleStartExam}
              onViewHistory={() => setPhase('preview')}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Section label ──────────────────────────────────────────────

function SectionLabel({ label, dot, count }: { label: string; dot: string; count: number }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '10px 10px 3px',
    }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
      <span style={{
        fontSize: 10, fontWeight: 800, textTransform: 'uppercase',
        letterSpacing: '0.09em', color: 'var(--ink-4)', flex: 1,
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 10, color: 'var(--ink-4)',
        background: 'var(--bg)', borderRadius: 8, padding: '1px 6px',
      }}>
        {count}
      </span>
    </div>
  );
}

// ── Exam set card (sidebar item) ───────────────────────────────

function ExamSetCard({ set, isSelected, summary, onSelect, onDelete }: {
  set:        StoredExamSet;
  isSelected: boolean;
  summary:    AttemptSummary | undefined;
  onSelect:   () => void;
  onDelete:   () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const hasAttempts = summary && summary.count > 0;
  const passed      = hasAttempts && summary.bestPct !== null && summary.bestPct >= 50;

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '9px 10px',
        borderRadius: 10, marginBottom: 2, cursor: 'pointer',
        background: isSelected ? 'var(--brand-tint)' : hovered ? 'var(--bg)' : 'transparent',
        border: `1.5px solid ${isSelected ? 'var(--brand)' : 'transparent'}`,
        transition: 'all 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12, fontWeight: 700,
            color: isSelected ? 'var(--brand-2)' : 'var(--ink)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {set.subject || set.title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>
            {set.grade} · {set.paperNames.length} paper{set.paperNames.length !== 1 ? 's' : ''}
          </div>

          {hasAttempts && summary.bestPct !== null && (
            <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: passed ? '#059669' : '#ea580c' }}>
                {summary.bestPct.toFixed(0)}% best
              </span>
              <span style={{ fontSize: 10, color: 'var(--ink-4)' }}>
                · {summary.count} attempt{summary.count !== 1 ? 's' : ''}
              </span>
            </div>
          )}
        </div>

        {(isSelected || hovered) && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onDelete(); }}
            aria-label="Delete exam set"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '2px 4px', borderRadius: 5, flexShrink: 0,
              color: 'var(--ink-4)', display: 'flex', alignItems: 'center',
            }}
          >
            <Icon name="close" size={13} stroke="currentColor" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Upload panel (homepage) ────────────────────────────────────

function UploadPanel({ papers, dragging, error, savingError, guestMode, fileInputRef, onDragOver, onDragLeave, onDrop, onFileInput, onRemovePaper, onGenerate }: {
  papers:        UploadedPaper[];
  dragging:      boolean;
  error:         string | null;
  savingError:   string | null;
  guestMode:     boolean;
  fileInputRef:  React.RefObject<HTMLInputElement | null>;
  onDragOver:    () => void;
  onDragLeave:   () => void;
  onDrop:        (e: React.DragEvent) => void;
  onFileInput:   (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemovePaper: (i: number) => void;
  onGenerate:    () => void;
}) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>

        {/* ── Hero CTA ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 18,
          padding: '20px 24px', marginBottom: 24,
          background: 'var(--brand-tint)',
          border: '1.5px solid var(--brand)',
          borderRadius: 18,
        }}>
          <span style={{ fontSize: 44, flexShrink: 0 }}>📝</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--ink)', marginBottom: 5 }}>
              Generate a New Examination
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.55 }}>
              Upload 2–5 past NSC papers and AI will analyse them, then create a
              timed practice exam that mirrors their style and difficulty.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => fileInputRef.current?.click()}
            style={{ fontSize: 13, padding: '10px 18px', borderRadius: 10, flexShrink: 0 }}
          >
            Upload Papers
          </button>
        </div>

        {/* Guest notice */}
        {guestMode && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 16px', background: '#EFF6FF',
            border: '1.5px solid #BFDBFE', borderRadius: 12, marginBottom: 20,
          }}>
            <span style={{ fontSize: 18, flexShrink: 0 }}>ℹ️</span>
            <span style={{ fontSize: 13, color: '#1E40AF' }}>
              Sign in to save your exam history and track your progress over time.
            </span>
          </div>
        )}

        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); onDragOver(); }}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2.5px dashed ${dragging ? 'var(--brand)' : 'var(--line)'}`,
            borderRadius: 18, padding: '36px 24px',
            textAlign: 'center', cursor: 'pointer',
            background: dragging ? 'var(--brand-tint)' : 'var(--card)',
            transition: 'border-color 0.18s, background 0.18s',
            marginBottom: 18,
          }}
        >
          <div style={{ marginBottom: 10, color: dragging ? 'var(--brand)' : 'var(--ink-3)', display: 'flex', justifyContent: 'center' }}>
            <Icon name="upload" size={32} stroke="currentColor" />
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', marginBottom: 5 }}>
            Drop PDF files here or click to browse
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>Upload 2–5 past exam papers (PDF only)</div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            style={{ display: 'none' }}
            onChange={onFileInput}
          />
        </div>

        {/* Uploaded papers */}
        {papers.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--ink-4)', marginBottom: 10 }}>
              Uploaded Papers ({papers.length}/5)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {papers.map((p, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 16px',
                  background: 'var(--card)', border: '1.5px solid var(--line)', borderRadius: 12,
                }}>
                  <span style={{ fontSize: 22, flexShrink: 0 }}>📋</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>
                      {p.sizeMB.toFixed(1)} MB · PDF
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemovePaper(i)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 8, borderRadius: 8, color: 'var(--ink-3)', display: 'flex', alignItems: 'center' }}
                    aria-label="Remove"
                  >
                    <Icon name="close" size={16} stroke="currentColor" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Status banners */}
        {papers.length < 2 && papers.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 16px', background: '#FFFBEB',
            border: '1.5px solid #FDE68A', borderRadius: 12, marginBottom: 16,
          }}>
            <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
            <span style={{ fontSize: 13, color: '#92400E' }}>
              Upload 1 more paper to enable exam generation.
            </span>
          </div>
        )}

        {papers.length >= 2 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 16px', background: '#ECFDF5',
            border: '1.5px solid #A7F3D0', borderRadius: 12, marginBottom: 16,
          }}>
            <Icon name="check" size={18} stroke="#059669" />
            <span style={{ fontSize: 13, color: '#065F46', fontWeight: 600 }}>
              {papers.length} papers ready. AI will analyse all of them.
            </span>
          </div>
        )}

        {error && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '12px 16px', background: '#FEF2F2',
            border: '1.5px solid #FECACA', borderRadius: 12, marginBottom: 16,
          }}>
            <span style={{ fontSize: 18, flexShrink: 0 }}>❌</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#991B1B', marginBottom: 2 }}>Error</div>
              <div style={{ fontSize: 13, color: '#991B1B' }}>{error}</div>
            </div>
          </div>
        )}

        {savingError && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 16px', background: '#FFFBEB',
            border: '1.5px solid #FDE68A', borderRadius: 12, marginBottom: 16,
          }}>
            <span style={{ fontSize: 16 }}>⚠️</span>
            <span style={{ fontSize: 13, color: '#92400E' }}>{savingError}</span>
          </div>
        )}

        {/* Generate button */}
        {papers.length >= 2 && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onGenerate}
            style={{
              width: '100%', fontSize: 15, padding: '14px 24px', borderRadius: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            <Icon name="sparkle" size={18} stroke="currentColor" />
            Generate Examination
          </button>
        )}
      </div>
    </div>
  );
}

// ── Screen header ──────────────────────────────────────────────

function ScreenHeader({ title, subtitle, onBack }: { title: string; subtitle?: string; onBack?: () => void }) {
  return (
    <div style={{
      padding: '12px 16px', background: 'var(--card)', borderBottom: '1px solid var(--line)',
      display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
    }}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 8, borderRadius: 8, color: 'var(--ink-2)', display: 'flex', alignItems: 'center' }}
          aria-label="Back"
        >
          <Icon name="chevron-left" size={20} stroke="currentColor" />
        </button>
      )}
      <span style={{ fontSize: 20 }}>🎓</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 1 }}>{subtitle}</div>}
      </div>
    </div>
  );
}

// ── Loading dots ───────────────────────────────────────────────

function LoadingDots() {
  return (
    <div style={{ display: 'flex', gap: 7 }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          width: 9, height: 9, borderRadius: '50%', background: 'var(--brand)',
          animation: `exam-dot 1.2s ease-in-out ${i * 0.22}s infinite`,
        }} />
      ))}
      <style>{`@keyframes exam-dot{0%,80%,100%{transform:scale(0);opacity:.4}40%{transform:scale(1);opacity:1}}`}</style>
    </div>
  );
}

// ── Preview panel (with attempt history) ───────────────────────

function PreviewPanel({ exam, attempts, savingError, onStart, onGenerateVariant }: {
  exam:                GeneratedExam;
  attempts:            StoredAttempt[];
  savingError:         string | null;
  onStart:             () => void;
  onGenerateVariant:   () => void;
}) {
  const [showQuestions, setShowQuestions] = useState(false);
  const hasAttempts = attempts.length > 0;
  const bestPct     = hasAttempts
    ? Math.max(...attempts.map(a => a.scorePct ?? 0))
    : null;

  const counts = {
    mcq:         exam.questions.filter(q => q.type === 'mcq').length,
    short:       exam.questions.filter(q => q.type === 'short').length,
    calculation: exam.questions.filter(q => q.type === 'calculation').length,
    essay:       exam.questions.filter(q => q.type === 'essay').length,
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px' }}>
      <div style={{ maxWidth: 700, margin: '0 auto' }}>

        {savingError && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px', background: '#FFFBEB',
            border: '1.5px solid #FDE68A', borderRadius: 10, marginBottom: 16,
          }}>
            <span style={{ fontSize: 15 }}>⚠️</span>
            <span style={{ fontSize: 13, color: '#92400E' }}>{savingError}</span>
          </div>
        )}

        {/* Exam meta card */}
        <div className="card" style={{ padding: 24, marginBottom: 18 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)', marginBottom: 16 }}>
            {exam.title}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10, marginBottom: 16 }}>
            {[
              { label: 'Subject',   value: exam.subject,                  icon: '📚' },
              { label: 'Grade',     value: exam.grade,                    icon: '🎓' },
              { label: 'Marks',     value: String(exam.totalMarks),       icon: '📊' },
              { label: 'Duration',  value: `${exam.durationMinutes} min`, icon: '⏱️' },
              { label: 'Questions', value: String(exam.questions.length), icon: '❓' },
            ].map(({ label, value, icon }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg)', borderRadius: 10 }}>
                <span style={{ fontSize: 18 }}>{icon}</span>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-4)' }}>{label}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{value}</div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(Object.entries(counts) as [string, number][]).filter(([, n]) => n > 0).map(([t, n]) => (
              <span key={t} style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: typeChip(t).bg, color: typeChip(t).fg }}>
                {n} × {typeLabel(t)}
              </span>
            ))}
          </div>
        </div>

        {/* Instructions */}
        <div className="card" style={{ padding: 18, marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)', marginBottom: 10 }}>📋 Instructions</div>
          <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {exam.instructions.map((ins, i) => (
              <li key={i} style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.65 }}>{ins}</li>
            ))}
          </ol>
        </div>

        {/* Questions (collapsible) */}
        <div className="card" style={{ padding: 18, marginBottom: 18 }}>
          <button
            type="button"
            onClick={() => setShowQuestions(s => !s)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)' }}>
              ❓ Questions ({exam.questions.length})
            </span>
            <span style={{
              fontSize: 12, color: 'var(--ink-4)',
              transform: showQuestions ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.18s', display: 'inline-block',
            }}>▼</span>
          </button>

          {showQuestions && (
            <div style={{ marginTop: 12 }}>
              {exam.questions.map((q, i) => {
                const chip = typeChip(q.type);
                return (
                  <div key={q.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
                    borderBottom: i < exam.questions.length - 1 ? '1px solid var(--line)' : 'none',
                  }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-4)', width: 26, flexShrink: 0 }}>Q{q.number}</span>
                    <span style={{ flex: 1, fontSize: 13, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.topic}</span>
                    <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: chip.bg, color: chip.fg, flexShrink: 0 }}>{typeLabel(q.type)}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-3)', flexShrink: 0, minWidth: 38, textAlign: 'right' }}>{q.marks} mk</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Attempt history */}
        {hasAttempts && (
          <div className="card" style={{ padding: 20, marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)', marginBottom: 14 }}>
              📈 Attempt History
            </div>

            {bestPct !== null && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 16px', background: 'var(--brand-tint)',
                borderRadius: 10, marginBottom: 16,
              }}>
                <span style={{ fontSize: 22 }}>🏆</span>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand-2)' }}>Personal Best</div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--brand-2)', lineHeight: 1.2 }}>
                    {bestPct.toFixed(1)}%
                  </div>
                </div>
                <div style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--brand-2)', fontWeight: 600 }}>
                  {attempts.length} attempt{attempts.length !== 1 ? 's' : ''}
                </div>
              </div>
            )}

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['#', 'Date', 'Score', 'Grade', 'Duration'].map(h => (
                      <th key={h} style={{
                        fontSize: 10, fontWeight: 800, textTransform: 'uppercase',
                        letterSpacing: '0.08em', color: 'var(--ink-4)',
                        padding: '6px 8px', textAlign: 'left',
                        borderBottom: '1.5px solid var(--line)',
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((a, i) => {
                    const isBest = (a.scorePct ?? -1) === bestPct;
                    const pct    = a.scorePct ?? 0;
                    const gc     = gradeColor(a.letterGrade ?? 'G');
                    return (
                      <tr key={a.id} style={{
                        background: isBest ? 'var(--brand-tint)' : 'transparent',
                        borderBottom: i < attempts.length - 1 ? '1px solid var(--line)' : 'none',
                      }}>
                        <td style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-4)', padding: '10px 8px' }}>
                          {attempts.length - i}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--ink-2)', padding: '10px 8px', whiteSpace: 'nowrap' }}>
                          {formatDate(a.createdAt)}
                        </td>
                        <td style={{ fontSize: 13, fontWeight: 700, color: gc, padding: '10px 8px' }}>
                          {pct.toFixed(1)}%
                          {isBest && <span style={{ fontSize: 11, marginLeft: 5 }}>⭐</span>}
                        </td>
                        <td style={{ padding: '10px 8px' }}>
                          <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 9px', borderRadius: 20, background: `${gc}22`, color: gc }}>
                            {a.letterGrade ?? '—'}
                          </span>
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--ink-3)', padding: '10px 8px', whiteSpace: 'nowrap' }}>
                          {formatDuration(a.durationSeconds)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 12 }}>
          {/* Generate variant — always available */}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onGenerateVariant}
            style={{
              flex: 1, fontSize: 14, padding: '13px 16px', borderRadius: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            }}
          >
            <Icon name="sparkle" size={16} stroke="currentColor" />
            New Variant
          </button>

          {/* Start / Retake */}
          <button
            type="button"
            className="btn btn-primary"
            onClick={onStart}
            style={{
              flex: 2, fontSize: 15, padding: '13px 20px', borderRadius: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            <Icon name="play" size={18} stroke="currentColor" />
            {hasAttempts ? 'Retake Exam' : `Start Exam — ${exam.durationMinutes} min`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Taking view ────────────────────────────────────────────────

function TakingView({ exam, answers, timeLeft, onAnswer, onSubmit }: {
  exam:     GeneratedExam;
  answers:  Record<string, string>;
  timeLeft: number;
  onAnswer: (id: string, val: string) => void;
  onSubmit: () => void;
}) {
  const answered = exam.questions.filter(q => answers[q.id] && answers[q.id].trim()).length;
  const urgent   = timeLeft < 600 && timeLeft > 0;

  const confirmSubmit = () => {
    const unanswered = exam.questions.length - answered;
    if (unanswered > 0 && !window.confirm(`You have ${unanswered} unanswered question${unanswered !== 1 ? 's' : ''}. Submit anyway?`)) return;
    onSubmit();
  };

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{
        padding: '12px 16px', background: 'var(--card)', borderBottom: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {exam.subject}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{answered}/{exam.questions.length} answered</div>
        </div>

        <div style={{
          padding: '7px 14px', borderRadius: 20,
          background: urgent ? '#FEF2F2' : 'var(--brand-tint)',
          color:      urgent ? '#DC2626' : 'var(--brand-2)',
          fontWeight: 800, fontSize: 15, fontFamily: 'monospace',
          border: `1.5px solid ${urgent ? '#FECACA' : 'transparent'}`,
          animation: urgent ? 'timer-urgent 1s ease infinite' : 'none',
          display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
        }}>
          <Icon name="clock" size={14} stroke="currentColor" />
          {formatTime(timeLeft)}
        </div>

        <button
          type="button"
          className="btn btn-primary"
          onClick={confirmSubmit}
          style={{ fontSize: 13, padding: '8px 16px', flexShrink: 0 }}
        >
          Submit
        </button>
      </div>

      <div style={{ height: 3, background: 'var(--line)', flexShrink: 0 }}>
        <div style={{
          height: '100%', background: 'var(--brand)',
          width: `${(answered / exam.questions.length) * 100}%`,
          transition: 'width 0.3s',
        }} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          {exam.questions.map((q, i) => (
            <QuestionCard
              key={q.id}
              question={q}
              index={i}
              answer={answers[q.id] ?? ''}
              onAnswer={val => onAnswer(q.id, val)}
            />
          ))}

          <button
            type="button"
            className="btn btn-primary"
            onClick={confirmSubmit}
            style={{ width: '100%', fontSize: 15, padding: '14px 24px', borderRadius: 14, marginTop: 8 }}
          >
            Submit All Answers
          </button>
        </div>
      </div>

      <style>{`@keyframes timer-urgent { 0%, 100% { opacity:1; } 50% { opacity:0.55; } }`}</style>
    </div>
  );
}

// ── Question card ──────────────────────────────────────────────

function QuestionCard({ question, index, answer, onAnswer }: {
  question: ExamQuestion;
  index:    number;
  answer:   string;
  onAnswer: (val: string) => void;
}) {
  const chip        = typeChip(question.type);
  const hasAnswer   = answer.trim().length > 0;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showMath, setShowMath] = useState(false);

  const insertSymbol = useCallback((sym: string) => {
    const ta = textareaRef.current;
    if (!ta) { onAnswer(answer + sym); return; }
    const start  = ta.selectionStart ?? answer.length;
    const end    = ta.selectionEnd   ?? answer.length;
    const newVal = answer.slice(0, start) + sym + answer.slice(end);
    onAnswer(newVal);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + sym.length, start + sym.length);
    });
  }, [answer, onAnswer]);

  return (
    <div className="card" style={{
      padding: 20, marginBottom: 16,
      borderLeft: `4px solid ${hasAnswer ? 'var(--brand)' : 'var(--line)'}`,
      transition: 'border-color 0.2s',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 10, flexShrink: 0,
          background: hasAnswer ? 'var(--brand)' : 'var(--line)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 800, fontSize: 13,
          color: hasAnswer ? '#fff' : 'var(--ink-3)',
          transition: 'background 0.2s, color 0.2s',
        }}>
          {hasAnswer ? <Icon name="check" size={16} stroke="currentColor" /> : index + 1}
        </div>

        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 20, background: chip.bg, color: chip.fg }}>
              {typeLabel(question.type)}
            </span>
            <span style={{ fontSize: 11, color: 'var(--ink-4)', fontWeight: 600 }}>
              {question.marks} {question.marks === 1 ? 'mark' : 'marks'}
            </span>
            <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>&bull; {question.topic}</span>
          </div>

          {question.context && (
            <div style={{
              fontSize: 13, color: 'var(--ink-2)', background: 'var(--bg)',
              padding: '10px 14px', borderRadius: 10, marginBottom: 10,
              borderLeft: '3px solid var(--brand)', lineHeight: 1.6,
            }}>
              {question.context}
            </div>
          )}

          <div style={{ fontSize: 14, color: 'var(--ink)', fontWeight: 500, lineHeight: 1.65 }}>
            {question.stem}
          </div>
        </div>
      </div>

      {/* MCQ options */}
      {question.type === 'mcq' && question.options && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {question.options.map((opt, j) => {
            const letter   = opt.trim()[0] ?? String.fromCharCode(65 + j);
            const selected = answer === letter;
            const display  = opt.slice(2).trim();
            return (
              <button
                key={j}
                type="button"
                onClick={() => onAnswer(selected ? '' : letter)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '11px 15px', borderRadius: 12, textAlign: 'left',
                  border: `1.5px solid ${selected ? 'var(--brand)' : 'var(--line)'}`,
                  background: selected ? 'var(--brand-tint)' : 'var(--bg)',
                  cursor: 'pointer', transition: 'all 0.15s',
                }}
              >
                <div style={{
                  width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                  background: selected ? 'var(--brand)' : 'var(--card)',
                  border: `1.5px solid ${selected ? 'var(--brand)' : 'var(--line)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 800,
                  color: selected ? '#fff' : 'var(--ink-3)',
                  transition: 'background 0.15s, color 0.15s',
                }}>
                  {letter}
                </div>
                <span style={{ fontSize: 13, color: selected ? 'var(--brand-2)' : 'var(--ink)', fontWeight: selected ? 600 : 400, lineHeight: 1.5 }}>
                  {display}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Written / calculation / essay */}
      {question.type !== 'mcq' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
            <button
              type="button"
              onClick={() => setShowMath(m => !m)}
              title="Insert mathematical notation"
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', borderRadius: 8,
                border: `1.5px solid ${showMath ? 'var(--brand)' : 'var(--line)'}`,
                background: showMath ? 'var(--brand-tint)' : 'var(--bg)',
                color: showMath ? 'var(--brand-2)' : 'var(--ink-3)',
                cursor: 'pointer', fontSize: 12, fontWeight: 700,
                transition: 'all 0.15s',
              }}
            >
              <span style={{ fontSize: 15, lineHeight: 1 }}>∑</span>
              Math symbols
            </button>
          </div>

          {showMath && (
            <MathKeyboard
              onInsert={insertSymbol}
              onClose={() => setShowMath(false)}
            />
          )}

          <textarea
            ref={textareaRef}
            value={answer}
            onChange={e => onAnswer(e.target.value)}
            placeholder={
              question.type === 'calculation' ? 'Show all working here…' :
              question.type === 'essay'       ? 'Write your essay here. Plan before you write.' :
                                                'Write your answer here…'
            }
            rows={question.type === 'essay' ? 9 : question.type === 'calculation' ? 6 : 4}
            style={{
              width: '100%', borderRadius: 12, padding: '12px 16px',
              border: '1.5px solid var(--line)', background: 'var(--bg)',
              color: 'var(--ink)', fontSize: 14, fontFamily: 'inherit',
              lineHeight: 1.6, resize: 'vertical', outline: 'none',
              boxSizing: 'border-box',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'var(--brand)'; }}
            onBlur={e => { e.currentTarget.style.borderColor = 'var(--line)'; }}
          />
        </div>
      )}
    </div>
  );
}

// ── Results panel ──────────────────────────────────────────────

function ResultsPanel({ exam, results, onRetake, onViewHistory }: {
  exam:          GeneratedExam;
  results:       ExamResults;
  onRetake:      () => void;
  onViewHistory: () => void;
}) {
  const [showAnswers, setShowAnswers] = useState(false);
  const color  = gradeColor(results.letterGrade);
  const pctNum = typeof results.percentage === 'number'
    ? results.percentage
    : (results.totalAwarded / results.totalMarks) * 100;

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '24px 20px' }}>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>

        {/* Score card */}
        <div className="card" style={{ padding: 28, textAlign: 'center', marginBottom: 18 }}>
          <div style={{ fontSize: 68, fontWeight: 900, color, lineHeight: 1, marginBottom: 6 }}>
            {pctNum.toFixed(0)}%
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, color, marginBottom: 4 }}>
            Grade {results.letterGrade}
          </div>
          <div style={{ fontSize: 14, color: 'var(--ink-3)', marginBottom: 20 }}>
            {results.totalAwarded} / {results.totalMarks} marks
          </div>

          <div style={{ height: 10, background: 'var(--line)', borderRadius: 999, overflow: 'hidden', marginBottom: 20 }}>
            <div style={{ height: '100%', borderRadius: 999, background: color, width: `${Math.min(pctNum, 100)}%` }} />
          </div>

          <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.7, textAlign: 'left', background: 'var(--bg)', padding: '14px 16px', borderRadius: 12 }}>
            {results.overallFeedback}
          </div>
        </div>

        {/* Per-question breakdown */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--ink-4)' }}>
              Question Breakdown
            </div>
            <button
              type="button"
              onClick={() => setShowAnswers(s => !s)}
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: '6px 12px' }}
            >
              {showAnswers ? 'Hide answers' : 'Show model answers'}
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {results.results.map(res => {
              const q   = exam.questions.find(x => x.id === res.questionId);
              const pct = res.total > 0 ? (res.awarded / res.total) * 100 : 0;
              const rc  = pct >= 100 ? '#059669' : pct >= 50 ? '#ca8a04' : '#dc2626';
              const rbg = pct >= 100 ? '#ECFDF5' : pct >= 50 ? '#FFFBEB' : '#FEF2F2';

              return (
                <div key={res.questionId} className="card" style={{ padding: 16, borderLeft: `4px solid ${rc}` }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
                        Q{q?.number ?? '?'}: {q?.topic ?? 'Question'}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 3, lineHeight: 1.5 }}>
                        {res.feedback}
                      </div>
                    </div>
                    <div style={{ padding: '4px 10px', borderRadius: 20, background: rbg, color: rc, fontSize: 12, fontWeight: 800, flexShrink: 0 }}>
                      {res.awarded}/{res.total}
                    </div>
                  </div>

                  {showAnswers && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                      <div style={{ padding: '10px 14px', background: 'var(--bg)', borderRadius: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 4 }}>Your Answer</div>
                        <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                          {res.studentAnswer || '(No answer provided)'}
                        </div>
                      </div>
                      <div style={{ padding: '10px 14px', background: '#ECFDF5', borderRadius: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', color: '#065F46', marginBottom: 4 }}>Model Answer</div>
                        <div style={{ fontSize: 13, color: '#065F46', lineHeight: 1.5 }}>
                          {res.modelAnswer}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 12 }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onViewHistory}
            style={{ flex: 1, padding: '12px 20px', borderRadius: 12 }}
          >
            <Icon name="rotate" size={16} stroke="currentColor" style={{ display: 'inline', marginRight: 8 }} />
            View History
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onRetake}
            style={{ flex: 1, padding: '12px 20px', borderRadius: 12 }}
          >
            <Icon name="play" size={16} stroke="currentColor" style={{ display: 'inline', marginRight: 8 }} />
            Retake Exam
          </button>
        </div>
      </div>
    </div>
  );
}
