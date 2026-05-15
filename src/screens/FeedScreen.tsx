import { useEffect, useMemo, useRef, useState } from 'react';
import { SproutMark } from '../components/Brand';
import { Icon } from '../components/Icon';
import { celebrate } from '../lib/store';
import { buildChatSystemPrompt, generateInteractives, hasApiKey, saveApiKey, streamCardChat } from '../lib/claude';
import type { ChatMessage, GeneratedInteractives } from '../lib/claude';
import { dbDeleteGeneratedCards, dbLoadChatHistory, dbLoadGeneratedCards, dbSaveChatHistory, dbSaveGeneratedCards } from '../lib/supabase';
import type { FeedSource, LearnerProfile } from '../lib/types';

// ── Types ─────────────────────────────────────────────────────
interface SummaryCard     { type: 'summary';     title: string; points: string[] }
interface FlashcardCard   { type: 'flashcard';   question: string; answer: string; reviewId?: string }
interface AnimationCard   { type: 'animation';   title: string; steps: Array<{ icon: string; title: string; description: string }> }
interface QuizCard        { type: 'quiz';        question: string; options: string[]; correctAnswer: number; explanation: string }
interface InteractiveCard { type: 'interactive'; interactiveType: string; title: string; objective?: string; html: string }
type Card = SummaryCard | FlashcardCard | AnimationCard | QuizCard | InteractiveCard;

// ── Adapt Claude JSON → Card[] ────────────────────────────────
function adaptCards(gen: GeneratedInteractives): Card[] {
  return gen.interactives.map(i => ({
    type:            'interactive' as const,
    interactiveType: i.type,
    title:           i.title,
    objective:       i.objective,
    html:            i.html,
  }));
}

// Interactives are kept in generation order (hook → explain → explore → practice → challenge).
function orderCards(cards: Card[]): Card[] { return cards; }

// ── Card → text description for the chat system prompt ───────
function describeCard(card: Card): string {
  switch (card.type) {
    case 'summary':
      return `Summary card — "${card.title}"\nPoints:\n${card.points.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
    case 'flashcard':
      return `Flashcard\nQ: "${card.question}"\nA: "${card.answer}"`;
    case 'animation':
      return `Step-by-step walkthrough — "${card.title}"\n${card.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.description}`).join('\n')}`;
    case 'quiz':
      return `Quiz question: "${card.question}"\nOptions: ${card.options.join(' | ')}\n(If asked for the answer, give a guiding hint only — do not reveal it directly.)`;
    case 'interactive':
      return `Interactive activity — "${card.title}" (type: ${card.interactiveType})${card.objective ? `\nLearning objective: ${card.objective}` : ''}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────
const interactiveLabel = (t: string) => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// ── FeedScreen ────────────────────────────────────────────────
interface FeedScreenProps {
  source:   FeedSource | null;
  profile:  LearnerProfile | null;
  onBack:   () => void;
  userId?:  string;
}

export function FeedScreen({ source, profile, onBack, userId }: FeedScreenProps) {
  const [phase, setPhase]       = useState<'key' | 'loading' | 'running' | 'error' | 'done'>(() => hasApiKey() ? 'loading' : 'key');
  const [cards, setCards]       = useState<Card[]>([]);
  const [error, setError]       = useState('');
  const [idx, setIdx]           = useState(0);
  const [score, setScore]         = useState(0);
  const [streak, setStreak]       = useState(0);
  const [fromCache, setFromCache] = useState(false);
  const [genProgress, setGenProgress] = useState<'planning' | number>(0);
  const [start]                 = useState(Date.now());
  const loadedFor               = useRef<FeedSource | null | undefined>(undefined);

  const sourceKey = source?.path?.join('/') ?? 'general';

  const load = (force = false) => {
    if (!hasApiKey()) { setPhase('key'); return; }
    setPhase('loading');
    setError('');
    setFromCache(false);
    setGenProgress(0);
    loadedFor.current = source;

    const topic      = source?.path?.[source.path.length - 1] ?? 'General study';
    const content    = source?.item?.content ?? null;
    const pdfBase64  = source?.item?.pdfBase64 ?? null;
    const contentLen = content?.length ?? (pdfBase64 ? -1 : 0);

    const doAdapt = (gen: GeneratedInteractives) => {
      setCards(orderCards(adaptCards(gen)));
      setIdx(0);
      setPhase('running');
    };

    const fetchFromClaude = () =>
      generateInteractives(topic, content, pdfBase64, setGenProgress).then(gen => {
        if (userId) dbSaveGeneratedCards(userId, sourceKey, topic, gen as never, contentLen).catch(() => {});
        doAdapt(gen);
      });

    const p = userId && !force
      ? dbLoadGeneratedCards(userId, sourceKey).then(cached => {
          if (cached && cached.contentLen === contentLen) {
            // Accept only the new interactives format; regenerate if old format is cached
            const data = cached.cards as unknown as GeneratedInteractives;
            if (Array.isArray(data?.interactives)) {
              setFromCache(true);
              doAdapt(data);
            } else {
              return fetchFromClaude();
            }
          } else {
            return fetchFromClaude();
          }
        })
      : fetchFromClaude();

    p.catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg === 'NO_API_KEY' ? 'API key missing.' : msg);
      setPhase('error');
    });
  };

  const handleRegenerate = () => {
    if (userId) dbDeleteGeneratedCards(userId, sourceKey).catch(() => {});
    load(true);
  };

  useEffect(() => {
    if (loadedFor.current === source) return;
    if (!hasApiKey()) { setPhase('key'); return; }
    load();
  }, [source]);

  const next = () => { if (idx + 1 >= cards.length) setPhase('done'); else { setIdx(i => i + 1); window.scrollTo(0, 0); } };
  const prev = () => { if (idx > 0) { setIdx(i => i - 1); window.scrollTo(0, 0); } };

  if (phase === 'key')     return <ApiKeySetup onBack={onBack} onSave={load} />;
  if (phase === 'loading') return <FeedLoading progress={genProgress} />;
  if (phase === 'error')   return <FeedError message={error} onRetry={load} onBack={onBack} />;

  const sourceLabel = source?.path ? source.path.join(' · ') : 'Study material';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      {/* Header */}
      <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', background: 'var(--card)', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button className="btn btn-ghost" onClick={onBack} style={{ padding: 8, borderRadius: '50%' }}>
          <Icon name="arrow-left" size={20} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="label-eyebrow" style={{ marginBottom: 2 }}>Learning feed</div>
          <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sourceLabel}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {fromCache && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, background: 'var(--brand-tint)', fontSize: 12, fontWeight: 600, color: 'var(--brand-2)' }}>
              <Icon name="bolt" size={12} stroke="var(--brand-2)" /> Saved
              <button onClick={handleRegenerate} style={{ marginLeft: 2, fontSize: 11, color: 'var(--ink-3)', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                · Regenerate
              </button>
            </div>
          )}
          <StatBadge icon="trophy" color="gold"  value={score}  label="pts" />
          <StatBadge icon="flame"  color="coral" value={streak} label="streak" />
        </div>
      </div>

      {/* Progress */}
      {phase === 'running' && (
        <div style={{ padding: '10px 24px', borderBottom: '1px solid var(--line)', background: 'var(--card-soft)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-2)', fontWeight: 600, marginBottom: 6 }}>
            <span>Card {idx + 1} of {cards.length}</span>
            <span>{Math.round(((idx + 1) / cards.length) * 100)}%</span>
          </div>
          <div style={{ height: 5, background: 'var(--line)', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ height: '100%', background: 'linear-gradient(90deg, var(--brand), var(--sky))', width: `${((idx + 1) / cards.length) * 100}%`, transition: 'width 0.4s' }} />
          </div>
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          {phase === 'running' && cards[idx] && (
            <CardView
              key={idx} card={cards[idx]} idx={idx} total={cards.length}
              chatContext={{ topic: source?.path?.[source.path.length - 1] ?? 'Study', sourceContent: source?.item?.content ?? null, profile }}
              userId={userId} fileKey={sourceKey}
              onPrev={prev} onNext={next}
            />
          )}
          {phase === 'done' && (
            <CompletionView
              cards={cards} score={score} elapsed={Date.now() - start}
              onBack={onBack}
              onRestart={() => { setIdx(0); setPhase('running'); setScore(0); setStreak(0); }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── API key setup ─────────────────────────────────────────────
function ApiKeySetup({ onBack, onSave }: { onBack: () => void; onSave: () => void }) {
  const [key, setKey] = useState('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', background: 'var(--card)', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button className="btn btn-ghost" onClick={onBack} style={{ padding: 8, borderRadius: '50%' }}>
          <Icon name="arrow-left" size={20} />
        </button>
        <div className="label-eyebrow">Connect Claude</div>
      </div>
      <div style={{ display: 'grid', placeItems: 'center', flex: 1, padding: 24 }}>
        <div style={{ maxWidth: 420, width: '100%', textAlign: 'center' }}>
          <div style={{ fontSize: 56, marginBottom: 18 }}>🔑</div>
          <h2 className="display" style={{ fontSize: 28, marginBottom: 10 }}>Connect Claude API</h2>
          <p style={{ color: 'var(--ink-2)', marginBottom: 28, fontSize: 15, lineHeight: 1.65 }}>
            Sprout uses Claude to generate personalised study cards from your content.
            Add your Anthropic API key to get started — stored locally on your device only.
          </p>
          <input className="input" value={key} onChange={e => setKey(e.target.value)}
            placeholder="sk-ant-api03-…"
            style={{ marginBottom: 14, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: '0.02em' }} />
          <button className="btn btn-primary btn-block" disabled={!key.startsWith('sk-')}
            onClick={() => { saveApiKey(key.trim()); onSave(); }}>
            Save and generate cards
          </button>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 16, lineHeight: 1.6 }}>
            Get a key at <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>console.anthropic.com</span>.
            Your key is never sent anywhere except directly to Anthropic's API.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Error state ───────────────────────────────────────────────
function FeedError({ message, onRetry, onBack }: { message: string; onRetry: () => void; onBack: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', background: 'var(--card)', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button className="btn btn-ghost" onClick={onBack} style={{ padding: 8, borderRadius: '50%' }}>
          <Icon name="arrow-left" size={20} />
        </button>
        <div className="label-eyebrow">Generation failed</div>
      </div>
      <div style={{ display: 'grid', placeItems: 'center', flex: 1, padding: 24 }}>
        <div style={{ maxWidth: 400, textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h2 className="display" style={{ fontSize: 24, marginBottom: 10 }}>Something went wrong</h2>
          <p style={{ color: 'var(--ink-2)', marginBottom: 8, fontSize: 14, lineHeight: 1.6 }}>Claude couldn't generate your cards.</p>
          <p style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--ink-3)', background: 'var(--bg-tint)', padding: '10px 14px', borderRadius: 10, marginBottom: 24 }}>
            {message}
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button className="btn btn-secondary" onClick={onBack}>Go back</button>
            <button className="btn btn-primary"   onClick={onRetry}><Icon name="rotate" size={16} /> Retry</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Loading ───────────────────────────────────────────────────
const ARC_LABELS = ['Hook', 'Explain', 'Explore', 'Practice', 'Challenge'];

function FeedLoading({ progress }: { progress: 'planning' | number }) {
  const [preflight, setPreflight] = useState(0);

  const isPlanning    = progress === 'planning';
  const isGenerating  = typeof progress === 'number' && progress >= 0 && (isPlanning === false);
  const completedCount = typeof progress === 'number' ? progress : 0;

  // Cycle through preflight steps until Sonnet takes over
  useEffect(() => {
    if (isPlanning || isGenerating) return;
    const i = setInterval(() => setPreflight(s => Math.min(s + 1, 1)), 2200);
    return () => clearInterval(i);
  }, [isPlanning, isGenerating]);

  const preflightSteps = ['Checking saved components…', 'Starting…'];


  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', background: 'var(--bg)', padding: 24 }}>
      <div style={{ textAlign: 'center', maxWidth: 380 }}>

        {/* Spinner */}
        <div style={{ position: 'relative', width: 80, height: 80, margin: '0 auto 24px' }}>
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '4px solid var(--brand-soft)', borderTopColor: 'var(--brand)', animation: 'spin 1s linear infinite' }} />
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}><SproutMark size={40} /></div>
        </div>

        <h2 className="display" style={{ fontSize: 22, marginBottom: 20 }}>
          {isPlanning ? 'Sonnet is planning your lesson…' : isGenerating ? 'Haiku is building components…' : 'Preparing…'}
        </h2>

        {/* Preflight — before Sonnet kicks off */}
        {!isPlanning && !isGenerating && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 4 }}>
            {preflightSteps.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, color: i <= preflight ? 'var(--ink)' : 'var(--ink-3)', transition: 'color 0.4s', fontSize: 14 }}>
                <div style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0, transition: 'background 0.4s', display: 'grid', placeItems: 'center',
                  background: i < preflight ? 'var(--brand)' : i === preflight ? 'var(--brand-tint)' : 'var(--line)' }}>
                  {i < preflight ? <Icon name="check" size={11} stroke="white" /> : i === preflight ? <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--brand)' }} /> : null}
                </div>
                {s}
              </div>
            ))}
          </div>
        )}

        {/* Sonnet planning phase */}
        {isPlanning && (
          <div style={{ padding: '14px 18px', borderRadius: 12, background: '#FFFFFF', border: '1px solid #ECE7DD', fontSize: 14, color: '#4A5563', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#4FB7F5', animation: 'pulse 1s ease-in-out infinite', flexShrink: 0 }} />
            Sonnet is reading your content and designing the learning arc…
          </div>
        )}

        {/* Haiku component-by-component progress */}
        {isGenerating && (
          <div style={{ textAlign: 'left' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, color: 'var(--ink-3)', marginBottom: 8 }}>
              <span>Components</span>
              <span>{completedCount} / {ARC_LABELS.length}</span>
            </div>
            <div style={{ height: 6, background: 'var(--line)', borderRadius: 999, overflow: 'hidden', marginBottom: 16 }}>
              <div style={{ height: '100%', background: 'linear-gradient(90deg, var(--brand), var(--sky))', width: `${(completedCount / ARC_LABELS.length) * 100}%`, transition: 'width 0.5s ease' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ARC_LABELS.map((label, i) => {
                const done = i < completedCount;
                const active = i === completedCount;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14,
                    color: done ? 'var(--ink)' : active ? 'var(--brand-2)' : 'var(--ink-3)',
                    transition: 'color 0.3s' }}>
                    <div style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', transition: 'background 0.3s',
                      background: done ? 'var(--brand)' : active ? 'var(--brand-tint)' : 'var(--line)',
                      border: active ? '2px solid var(--brand)' : 'none' }}>
                      {done
                        ? <Icon name="check" size={12} stroke="white" />
                        : active ? <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--brand)', animation: 'pulse 1s ease-in-out infinite' }} /> : null}
                    </div>
                    <span style={{ fontWeight: done || active ? 600 : 400 }}>{label}</span>
                    {active && <span style={{ fontSize: 11, color: 'var(--ink-3)', marginLeft: 'auto' }}>writing…</span>}
                    {done && <span style={{ fontSize: 11, color: 'var(--brand)', marginLeft: 'auto' }}>done</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── StatBadge ─────────────────────────────────────────────────
function StatBadge({ icon, color, value, label }: { icon: string; color: string; value: number; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999, background: `var(--${color}-soft)` }}>
      <Icon name={icon} size={14} stroke={`var(--${color})`} />
      <span className="mono" style={{ fontWeight: 700, fontSize: 13, color: `var(--${color})` }}>{value}</span>
      <span style={{ fontSize: 11, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>{label}</span>
    </div>
  );
}

// ── CardView ──────────────────────────────────────────────────
interface ChatContext { topic: string; sourceContent: string | null; profile: LearnerProfile | null }

interface CardViewProps {
  card: Card; idx: number; total: number;
  chatContext: ChatContext;
  userId?: string; fileKey: string;
  onPrev: () => void; onNext: () => void;
}

function CardView({ card, idx, total, chatContext, userId, fileKey, onPrev, onNext }: CardViewProps) {

  const [chatOpen, setChatOpen]   = useState(false);
  const [messages, setMessages]   = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [chatError, setChatError] = useState('');

  // Load persisted chat history on mount (keyed by card index)
  useEffect(() => {
    if (!userId) return;
    dbLoadChatHistory(userId, fileKey, idx)
      .then(msgs => { if (msgs.length) { setMessages(msgs); setChatOpen(true); } })
      .catch(() => {});
  }, [userId, fileKey, idx]);

  const handleSend = async (text: string) => {
    const userMsg: ChatMessage = { role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setStreaming(true);
    setChatError('');

    const systemPrompt = buildChatSystemPrompt(
      chatContext.topic,
      chatContext.sourceContent,
      describeCard(card),
      chatContext.profile,
    );

    let finalContent = '';
    try {
      await streamCardChat(history, systemPrompt, (chunk) => {
        finalContent += chunk;
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: finalContent };
          return updated;
        });
      });
      const saved: ChatMessage[] = [...history, { role: 'assistant', content: finalContent }];
      if (userId) dbSaveChatHistory(userId, fileKey, idx, saved).catch(() => {});
    } catch (e) {
      setChatError(e instanceof Error ? e.message : 'Something went wrong.');
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="card fade-up" style={{ padding: 32, marginBottom: 16, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <span className="chip plum">
          🎮 {card.type === 'interactive' ? interactiveLabel((card as InteractiveCard).interactiveType) : card.type}
        </span>
        <span style={{ fontSize: 12, color: 'var(--ink-3)', fontWeight: 600 }}>{idx + 1} / {total}</span>
      </div>

      {card.type === 'interactive' && <InteractiveCardView card={card} />}

      {/* Ask Claude toggle */}
      <button
        onClick={() => setChatOpen(o => !o)}
        style={{
          width: '100%', marginTop: 20, padding: '10px 16px', borderRadius: 12,
          background: chatOpen ? 'var(--brand-tint)' : 'var(--bg-tint)',
          border: `1px solid ${chatOpen ? 'var(--brand)' : 'var(--line)'}`,
          color: chatOpen ? 'var(--brand-2)' : 'var(--ink-2)',
          fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 8, transition: 'all 0.15s', cursor: 'pointer',
        }}
      >
        💬 {chatOpen ? 'Close chat' : 'Ask Claude about this card'}
      </button>

      {/* Chat panel */}
      {chatOpen && (
        <ChatPanel
          messages={messages}
          streaming={streaming}
          error={chatError}
          onSend={handleSend}
        />
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 20, paddingTop: 20, borderTop: '1px solid var(--line)' }}>
        <button className="btn btn-secondary" onClick={onPrev} disabled={idx === 0}><Icon name="arrow-left" size={16} /> Previous</button>
        <button className="btn btn-primary" onClick={onNext} style={{ flex: 1 }}>{idx + 1 === total ? 'Finish' : 'Next'} <Icon name="arrow-right" size={16} /></button>
      </div>
    </div>
  );
}

// ── Interactive card (sandboxed iframe) ───────────────────────
function InteractiveCardView({ card }: { card: InteractiveCard }) {
  const [height, setHeight] = useState(240);

  const handleMessage = (e: MessageEvent) => {
    if (e.data?.type === 'sprout:resize' && typeof e.data.height === 'number') {
      setHeight(Math.max(e.data.height, 240));
    }
  };

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Inject a resize shim so the iframe always reports its true scroll height,
  // even when the component forgets to call postMessage itself.
  const srcDoc = useMemo(() => {
    const shim = `<script>(function(){` +
      `function r(){` +
        `var h=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,240);` +
        `window.parent.postMessage({type:'sprout:resize',height:h},'*');` +
      `}` +
      `window.addEventListener('load',function(){r();setTimeout(r,300);setTimeout(r,800);});` +
      `if(document.readyState!=='loading'){setTimeout(r,50);}` +
      `if(typeof ResizeObserver!=='undefined'){` +
        `new ResizeObserver(function(){setTimeout(r,50);}).observe(document.documentElement);` +
      `}` +
    `})();<\/script>`;
    return card.html.includes('</body>')
      ? card.html.replace('</body>', shim + '</body>')
      : card.html + shim;
  }, [card.html]);

  return (
    <>
      <h2 className="display" style={{ fontSize: 22, marginBottom: 6 }}>{card.title}</h2>
      {card.objective && (
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 14, lineHeight: 1.5 }}>
          🎯 {card.objective}
        </p>
      )}
      <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid var(--line)', background: '#FAF7F2' }}>
        <iframe
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          style={{ width: '100%', height, border: 'none', display: 'block', transition: 'height 0.25s ease' }}
          title={card.title}
        />
      </div>
    </>
  );
}

// ── Chat panel ────────────────────────────────────────────────
function ChatPanel({ messages, streaming, error, onSend }: {
  messages: ChatMessage[];
  streaming: boolean;
  error: string;
  onSend: (text: string) => void;
}) {
  const [input, setInput]   = useState('');
  const bottomRef           = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = () => {
    if (!input.trim() || streaming) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
        Chat with Claude
      </div>

      {/* Message history */}
      {messages.length > 0 && (
        <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12, paddingRight: 4 }}>
          {messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              padding: '10px 14px',
              borderRadius: m.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
              background: m.role === 'user' ? 'var(--brand)' : 'var(--bg-tint)',
              border: m.role === 'assistant' ? '1px solid var(--line)' : 'none',
              color: m.role === 'user' ? 'white' : 'var(--ink)',
              fontSize: 14, lineHeight: 1.6,
            }}>
              {m.content
                ? m.content
                : (streaming && i === messages.length - 1)
                  ? <TypingDots />
                  : null}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: 'var(--coral)', marginBottom: 10, padding: '8px 12px', background: '#FFE4DA', borderRadius: 8 }}>
          {error}
        </div>
      )}

      {/* Input row */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Ask anything about this card…"
          disabled={streaming}
          style={{ flex: 1, fontSize: 14 }}
        />
        <button
          className="btn btn-primary"
          onClick={send}
          disabled={!input.trim() || streaming}
          style={{ padding: '0 16px', flexShrink: 0 }}
        >
          <Icon name="arrow-right" size={16} />
        </button>
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', height: 20 }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: 6, height: 6, borderRadius: '50%',
          background: 'var(--ink-3)',
          display: 'inline-block',
          animation: `dot-pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
        }} />
      ))}
    </span>
  );
}

// ── Completion ────────────────────────────────────────────────
function CompletionView({ cards, score, elapsed, onBack, onRestart }: {
  cards: Card[]; score: number; elapsed: number;
  onBack: () => void; onRestart: () => void;
}) {
  useEffect(() => { celebrate(); }, []);
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  return (
    <div className="card fade-up" style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 64, marginBottom: 14, animation: 'pop 0.6s ease' }}>🌱</div>
      <h2 className="display" style={{ fontSize: 36, marginBottom: 8 }}>Great work!</h2>
      <p style={{ color: 'var(--ink-2)', marginBottom: 24, fontSize: 16 }}>Your sprout grew a little taller today.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
        {[
          { v: cards.length,                                          l: 'Activities', c: 'brand' },
          { v: score,                                                 l: 'Points',     c: 'gold' },
          { v: `${mins}:${String(secs).padStart(2, '0')}`,           l: 'Time',       c: 'sky' },
        ].map((s, i) => (
          <div key={i} style={{ padding: 18, borderRadius: 16, background: `var(--${s.c}-soft)` }}>
            <div className="display" style={{ fontSize: 32, color: `var(--${s.c})` }}>{s.v}</div>
            <div className="label-eyebrow">{s.l}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <button className="btn btn-secondary" onClick={onRestart}><Icon name="rotate" size={16} /> Replay</button>
        <button className="btn btn-primary"   onClick={onBack}>Back to home <Icon name="arrow-right" size={16} /></button>
      </div>
    </div>
  );
}
