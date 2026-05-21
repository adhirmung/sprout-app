import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import {
  analyzeAndGenerateExam,
  markExamSubmission,
} from '../lib/examClaude';
import type { ExamQuestion, ExamResults, GeneratedExam } from '../lib/examClaude';

// ── Types ──────────────────────────────────────────────────────

type ExamPhase = 'upload' | 'generating' | 'preview' | 'taking' | 'marking' | 'results';

interface UploadedPaper {
  file:   File;
  base64: string;
  name:   string;
  sizeMB: number;
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
  const [phase,       setPhase]       = useState<ExamPhase>('upload');
  const [papers,      setPapers]      = useState<UploadedPaper[]>([]);
  const [dragging,    setDragging]    = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [exam,        setExam]        = useState<GeneratedExam | null>(null);
  const [answers,     setAnswers]     = useState<Record<string, string>>({});
  const [results,     setResults]     = useState<ExamResults | null>(null);
  const [error,       setError]       = useState<string | null>(null);
  const [timeLeft,    setTimeLeft]    = useState(0);
  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Keep a stable ref to the submit callback so the timer closure stays fresh
  const submitRef = useRef<() => Promise<void>>(async () => {});

  // ── File handling ──────────────────────────────────────────

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
    setPapers(prev => [...prev, ...loaded].slice(0, 5)); // cap at 5
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFiles(Array.from(e.dataTransfer.files));
  }, [handleFiles]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(Array.from(e.target.files));
    e.target.value = ''; // allow re-upload of same file
  }, [handleFiles]);

  // ── Generate exam ──────────────────────────────────────────

  const handleGenerate = async () => {
    if (papers.length < 2) return;
    setPhase('generating');
    setError(null);
    try {
      const generated = await analyzeAndGenerateExam(
        papers.map(p => p.base64),
        setProgressMsg,
        userId,
      );
      setExam(generated);
      setAnswers({});
      setPhase('preview');
    } catch (err) {
      setError((err as Error).message || 'Failed to generate exam. Please try again.');
      setPhase('upload');
    }
  };

  // ── Exam session ────────────────────────────────────────────

  const handleStartExam = () => {
    if (!exam) return;
    setTimeLeft(exam.durationMinutes * 60);
    setPhase('taking');
  };

  const handleSubmitExam = useCallback(async () => {
    if (!exam) return;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setPhase('marking');
    setProgressMsg('Marking your answers…');
    try {
      const examResults = await markExamSubmission(exam, answers, setProgressMsg, userId);
      setResults(examResults);
      setPhase('results');
    } catch (err) {
      setError((err as Error).message || 'Marking failed. Please try again.');
      setPhase('taking');
    }
  }, [exam, answers, userId]);

  // Keep the submit ref updated
  useEffect(() => { submitRef.current = handleSubmitExam; }, [handleSubmitExam]);

  // Countdown timer
  useEffect(() => {
    if (phase !== 'taking') return;
    timerRef.current = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) {
          clearInterval(timerRef.current!);
          void submitRef.current();
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [phase]);

  // ── Reset / retry ──────────────────────────────────────────

  const handleReset = () => {
    setPapers([]); setExam(null); setAnswers({});
    setResults(null); setError(null); setPhase('upload');
  };

  const handleRetry = () => {
    setAnswers({}); setResults(null); setPhase('preview');
  };

  // ── Loading overlay ────────────────────────────────────────

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

  // ── Results ────────────────────────────────────────────────

  if (phase === 'results' && results && exam) {
    return <ResultsView exam={exam} results={results} onReset={handleReset} onRetry={handleRetry} onBack={onBack} />;
  }

  // ── Taking exam ────────────────────────────────────────────

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

  // ── Preview ────────────────────────────────────────────────

  if (phase === 'preview' && exam) {
    return <PreviewView exam={exam} onStart={handleStartExam} onBack={() => setPhase('upload')} />;
  }

  // ── Upload (default) ────────────────────────────────────────

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <ScreenHeader title="Exam Module" onBack={onBack} />

      <div style={{ flex: 1, overflowY: 'auto', padding: '28px 20px' }}>
        <div style={{ maxWidth: 680, margin: '0 auto' }}>

          {/* Intro */}
          <div style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)', margin: '0 0 8px' }}>
              Practice Exam Generator
            </h2>
            <p style={{ fontSize: 14, color: 'var(--ink-3)', margin: 0, lineHeight: 1.6 }}>
              Upload 2 or more past NSC exam papers and the AI will analyse them, then
              generate a new practice exam that matches their style, topics, and difficulty.
            </p>
          </div>

          {/* Drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border:     `2.5px dashed ${dragging ? 'var(--brand)' : 'var(--line)'}`,
              borderRadius: 18,
              padding:    '44px 24px',
              textAlign:  'center',
              cursor:     'pointer',
              background: dragging ? 'var(--brand-tint)' : 'var(--card)',
              transition: 'border-color 0.18s, background 0.18s',
              marginBottom: 18,
            }}
          >
            <div style={{ marginBottom: 12, color: dragging ? 'var(--brand)' : 'var(--ink-3)', display: 'flex', justifyContent: 'center' }}>
              <Icon name="upload" size={36} stroke="currentColor" />
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>
              Drop PDF files here or click to browse
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>
              Upload 2–5 past exam papers (PDF only)
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileInput}
            />
          </div>

          {/* Uploaded files */}
          {papers.length > 0 && (
            <div style={{ marginBottom: 20 }}>
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
                        {p.sizeMB.toFixed(1)} MB &bull; PDF
                      </div>
                    </div>
                    <button
                      onClick={() => setPapers(prev => prev.filter((_, j) => j !== i))}
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

          {/* Requirement hint */}
          {papers.length < 2 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 16px', background: '#FFFBEB',
              border: '1.5px solid #FDE68A', borderRadius: 12, marginBottom: 18,
            }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
              <span style={{ fontSize: 13, color: '#92400E' }}>
                {papers.length === 0
                  ? 'Upload at least 2 past exam papers to get started.'
                  : 'Upload 1 more paper to enable exam generation.'}
              </span>
            </div>
          )}

          {papers.length >= 2 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 16px', background: '#ECFDF5',
              border: '1.5px solid #A7F3D0', borderRadius: 12, marginBottom: 18,
            }}>
              <Icon name="check" size={18} stroke="#059669" />
              <span style={{ fontSize: 13, color: '#065F46', fontWeight: 600 }}>
                {papers.length} papers ready. AI will analyse all of them to generate your exam.
              </span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '12px 16px', background: '#FEF2F2',
              border: '1.5px solid #FECACA', borderRadius: 12, marginBottom: 18,
            }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>❌</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#991B1B', marginBottom: 2 }}>Error</div>
                <div style={{ fontSize: 13, color: '#991B1B' }}>{error}</div>
              </div>
            </div>
          )}

          {/* Generate button */}
          <button
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={papers.length < 2}
            style={{ width: '100%', fontSize: 15, padding: '14px 24px', borderRadius: 14 }}
          >
            <Icon name="sparkle" size={18} stroke="currentColor" style={{ display: 'inline', marginRight: 8 }} />
            Generate Practice Exam
          </button>
        </div>
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
          animation: `exam-dot ${1.2}s ease-in-out ${i * 0.22}s infinite`,
        }} />
      ))}
      <style>{`@keyframes exam-dot{0%,80%,100%{transform:scale(0);opacity:.4}40%{transform:scale(1);opacity:1}}`}</style>
    </div>
  );
}

// ── Preview view ───────────────────────────────────────────────

function PreviewView({ exam, onStart, onBack }: { exam: GeneratedExam; onStart: () => void; onBack: () => void }) {
  const counts = {
    mcq:         exam.questions.filter(q => q.type === 'mcq').length,
    short:       exam.questions.filter(q => q.type === 'short').length,
    calculation: exam.questions.filter(q => q.type === 'calculation').length,
    essay:       exam.questions.filter(q => q.type === 'essay').length,
  };

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <ScreenHeader title={exam.title} subtitle={`${exam.subject} • ${exam.grade}`} onBack={onBack} />

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 20px' }}>
        <div style={{ maxWidth: 680, margin: '0 auto' }}>

          {/* Meta card */}
          <div className="card" style={{ padding: 24, marginBottom: 18 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)', marginBottom: 18 }}>
              {exam.title}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
              {[
                { label: 'Subject',       value: exam.subject,              icon: '📚' },
                { label: 'Grade',         value: exam.grade,                icon: '🎓' },
                { label: 'Total Marks',   value: String(exam.totalMarks),   icon: '📊' },
                { label: 'Duration',      value: `${exam.durationMinutes} min`, icon: '⏱️' },
                { label: 'Questions',     value: String(exam.questions.length), icon: '❓' },
              ].map(({ label, value, icon }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--bg)', borderRadius: 10 }}>
                  <span style={{ fontSize: 18 }}>{icon}</span>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--ink-4)' }}>{label}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{value}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Type badges */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(Object.entries(counts) as [string, number][]).filter(([, n]) => n > 0).map(([t, n]) => (
                <span key={t} style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: typeChip(t).bg, color: typeChip(t).fg }}>
                  {n} × {typeLabel(t)}
                </span>
              ))}
            </div>
          </div>

          {/* Instructions */}
          <div className="card" style={{ padding: 20, marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)', marginBottom: 12 }}>📋 Instructions</div>
            <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 7 }}>
              {exam.instructions.map((ins, i) => (
                <li key={i} style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>{ins}</li>
              ))}
            </ol>
          </div>

          {/* Question list */}
          <div className="card" style={{ padding: 20, marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)', marginBottom: 12 }}>
              ❓ Questions ({exam.questions.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {exam.questions.map((q, i) => {
                const chip = typeChip(q.type);
                return (
                  <div key={q.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '9px 0',
                    borderBottom: i < exam.questions.length - 1 ? '1px solid var(--line)' : 'none',
                  }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-4)', width: 28, flexShrink: 0 }}>Q{q.number}</span>
                    <span style={{ flex: 1, fontSize: 13, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {q.topic}
                    </span>
                    <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: chip.bg, color: chip.fg, flexShrink: 0 }}>
                      {typeLabel(q.type)}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-3)', flexShrink: 0, minWidth: 40, textAlign: 'right' }}>
                      {q.marks} mk
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <button
            className="btn btn-primary"
            onClick={onStart}
            style={{ width: '100%', fontSize: 15, padding: '14px 24px', borderRadius: 14 }}
          >
            <Icon name="play" size={18} stroke="currentColor" style={{ display: 'inline', marginRight: 8 }} />
            Start Exam — {exam.durationMinutes} min
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
  const urgent   = timeLeft < 600 && timeLeft > 0; // < 10 minutes

  const confirmSubmit = () => {
    const unanswered = exam.questions.length - answered;
    if (unanswered > 0 && !window.confirm(`You have ${unanswered} unanswered question${unanswered !== 1 ? 's' : ''}. Submit anyway?`)) return;
    onSubmit();
  };

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* Sticky exam header */}
      <div style={{
        padding: '12px 16px', background: 'var(--card)', borderBottom: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{exam.subject}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{answered}/{exam.questions.length} answered</div>
        </div>

        {/* Timer */}
        <div style={{
          padding: '7px 14px', borderRadius: 20,
          background: urgent ? '#FEF2F2' : 'var(--brand-tint)',
          color:      urgent ? '#DC2626' : 'var(--brand-2)',
          fontWeight: 800, fontSize: 15, fontFamily: 'monospace',
          border: `1.5px solid ${urgent ? '#FECACA' : 'transparent'}`,
          animation: urgent ? 'timer-urgent 1s ease infinite' : 'none',
          display: 'flex', alignItems: 'center', gap: 6,
          flexShrink: 0,
        }}>
          <Icon name="clock" size={14} stroke="currentColor" />
          {formatTime(timeLeft)}
        </div>

        <button
          className="btn btn-primary"
          onClick={confirmSubmit}
          style={{ fontSize: 13, padding: '8px 16px', flexShrink: 0 }}
        >
          Submit
        </button>
      </div>

      {/* Progress bar */}
      <div style={{ height: 3, background: 'var(--line)', flexShrink: 0 }}>
        <div style={{
          height: '100%', background: 'var(--brand)',
          width: `${(answered / exam.questions.length) * 100}%`,
          transition: 'width 0.3s',
        }} />
      </div>

      {/* Scrollable questions */}
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
            className="btn btn-primary"
            onClick={confirmSubmit}
            style={{ width: '100%', fontSize: 15, padding: '14px 24px', borderRadius: 14, marginTop: 8 }}
          >
            Submit All Answers
          </button>
        </div>
      </div>

      <style>{`
        @keyframes timer-urgent { 0%, 100% { opacity:1; } 50% { opacity:0.55; } }
      `}</style>
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
  const chip = typeChip(question.type);
  const hasAnswer = answer.trim().length > 0;

  return (
    <div className="card" style={{
      padding: 20, marginBottom: 16,
      borderLeft: `4px solid ${hasAnswer ? 'var(--brand)' : 'var(--line)'}`,
      transition: 'border-color 0.2s',
    }}>
      {/* Question header */}
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

          {/* Stimulus / context */}
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

      {/* MCQ */}
      {question.type === 'mcq' && question.options && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {question.options.map((opt, j) => {
            const letter   = opt.trim()[0] ?? String.fromCharCode(65 + j);
            const selected = answer === letter;
            const display  = opt.slice(2).trim(); // strip "A. "
            return (
              <button
                key={j}
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
        <textarea
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
      )}
    </div>
  );
}

// ── Results view ───────────────────────────────────────────────

function ResultsView({ exam, results, onReset, onRetry, onBack }: {
  exam:    GeneratedExam;
  results: ExamResults;
  onReset: () => void;
  onRetry: () => void;
  onBack:  () => void;
}) {
  const [showAnswers, setShowAnswers] = useState(false);
  const color = gradeColor(results.letterGrade);

  const pctNum = typeof results.percentage === 'number'
    ? results.percentage
    : (results.totalAwarded / results.totalMarks) * 100;

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <ScreenHeader title="Results" subtitle={`${exam.subject} • ${exam.grade}`} onBack={onBack} />

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 16px' }}>
        <div style={{ maxWidth: 680, margin: '0 auto' }}>

          {/* Score card */}
          <div className="card" style={{ padding: 28, textAlign: 'center', marginBottom: 18 }}>
            {/* Percentage */}
            <div style={{ fontSize: 68, fontWeight: 900, color, lineHeight: 1, marginBottom: 6 }}>
              {pctNum.toFixed(0)}%
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color, marginBottom: 4 }}>
              Grade {results.letterGrade}
            </div>
            <div style={{ fontSize: 14, color: 'var(--ink-3)', marginBottom: 20 }}>
              {results.totalAwarded} / {results.totalMarks} marks
            </div>

            {/* Bar */}
            <div style={{ height: 10, background: 'var(--line)', borderRadius: 999, overflow: 'hidden', marginBottom: 20 }}>
              <div style={{ height: '100%', borderRadius: 999, background: color, width: `${Math.min(pctNum, 100)}%` }} />
            </div>

            {/* Overall feedback */}
            <div style={{
              fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.7,
              textAlign: 'left', background: 'var(--bg)',
              padding: '14px 16px', borderRadius: 12,
            }}>
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
                onClick={() => setShowAnswers(s => !s)}
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: '6px 12px' }}
              >
                {showAnswers ? 'Hide answers' : 'Show model answers'}
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {results.results.map(res => {
                const q    = exam.questions.find(x => x.id === res.questionId);
                const pct  = res.total > 0 ? (res.awarded / res.total) * 100 : 0;
                const rc   = pct >= 100 ? '#059669' : pct >= 50 ? '#ca8a04' : '#dc2626';
                const rbg  = pct >= 100 ? '#ECFDF5' : pct >= 50 ? '#FFFBEB' : '#FEF2F2';

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
                      <div style={{
                        padding: '4px 10px', borderRadius: 20,
                        background: rbg, color: rc,
                        fontSize: 12, fontWeight: 800, flexShrink: 0,
                      }}>
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
            <button className="btn btn-secondary" onClick={onRetry} style={{ flex: 1, padding: '12px 20px', borderRadius: 12 }}>
              <Icon name="rotate" size={16} stroke="currentColor" style={{ display: 'inline', marginRight: 8 }} />
              Try Again
            </button>
            <button className="btn btn-primary" onClick={onReset} style={{ flex: 1, padding: '12px 20px', borderRadius: 12 }}>
              <Icon name="upload" size={16} stroke="currentColor" style={{ display: 'inline', marginRight: 8 }} />
              New Papers
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
