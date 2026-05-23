import Anthropic from '@anthropic-ai/sdk';
import type { LearnerProfile } from './types';
import { dbLogUsage } from './supabase';

// ── Current user (set once on auth, used for usage logging) ──────
let _currentUserId: string | null = null;
export function setCurrentUserId(id: string | null): void { _currentUserId = id; }

// ── API key helpers ───────────────────────────────────────────

const USE_PROXY = import.meta.env.VITE_USE_PROXY === 'true';

export function getApiKey(): string {
  return (import.meta.env.VITE_ANTHROPIC_API_KEY as string) || localStorage.getItem('sprout:apiKey') || '';
}

export function hasApiKey(): boolean { return !!(getApiKey()) || USE_PROXY; }

export function saveApiKey(key: string) { localStorage.setItem('sprout:apiKey', key); }

function getClient(): Anthropic {
  const apiKey = getApiKey();
  if (apiKey) return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  if (USE_PROXY) return new Anthropic({
    apiKey:             'via-proxy',
    baseURL:            `${window.location.origin}/api`,
    dangerouslyAllowBrowser: true,
  });
  throw new Error('NO_API_KEY');
}

// ── Chat helpers ─────────────────────────────────────────────

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export function buildChatSystemPrompt(
  topic: string,
  sourceContent: string | null,
  cardDescription: string,
  profile: LearnerProfile | null,
): string {
  const wm  = profile?.workingMemory?.score    ?? 60;
  const ps  = profile?.processingSpeed?.score  ?? 60;
  const fi  = profile?.fluidIntelligence?.score ?? 60;

  const grade   = wm < 40 && ps < 40 ? '6–7' : wm > 70 && ps > 70 ? '10–12' : '8–9';
  const tone    = fi < 50
    ? 'Prefer concrete examples and everyday analogies. Avoid abstract language.'
    : 'Abstract explanations and comparisons are welcome.';
  const brevity = wm < 50
    ? 'Keep each reply to 2–3 short sentences (≤15 words each).'
    : 'Up to 5 sentences when detail is genuinely needed.';

  return `You are a patient, expert tutor in the Sprout learning app helping a student understand their study material.

TOPIC: "${topic}"
${sourceContent ? `\nSOURCE MATERIAL:\n"""\n${sourceContent.slice(0, 20000)}\n"""` : ''}
CURRENT CARD THE STUDENT IS VIEWING:
${cardDescription}

LEARNER PROFILE:
- Target reading level: Grade ${grade} (Flesch-Kincaid)
- ${tone}
- ${brevity}

RULES:
- Answer only what was asked — never over-explain unprompted.
- If the student asks for a quiz answer, give a guiding hint first, not the direct answer.
- Ground responses in the source material when available; never invent facts.
- Be warm and encouraging. If they seem confused, offer a different angle or a real-world analogy.
- Never use bullet-point lists longer than 3 items in a single reply.`;
}

export async function streamCardChat(
  history: ChatMessage[],
  systemPrompt: string,
  onChunk: (text: string) => void,
): Promise<void> {
  const client = getClient();
  const stream = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system:     systemPrompt,
    messages:   history,
    stream:     true,
  });
  let inputTokens  = 0;
  let outputTokens = 0;
  for await (const event of stream) {
    if (event.type === 'message_start') {
      inputTokens = event.message.usage.input_tokens;
    } else if (event.type === 'message_delta' && event.usage) {
      outputTokens = event.usage.output_tokens;
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      onChunk(event.delta.text);
    }
  }
  void dbLogUsage(_currentUserId, 'streamCardChat', 'claude-haiku-4-5-20251001', inputTokens, outputTokens);
}

// ── Content map ───────────────────────────────────────────────

export interface SubTopic {
  id:      string;
  title:   string;
  summary: string;
}

export interface Topic {
  id:        string;
  title:     string;
  summary:   string;
  subtopics: SubTopic[];
}

export interface ContentMap {
  synthesis: string;
  topics:    Topic[];
}

// ── Document reading ──────────────────────────────────────────

export interface TopicKeyTerm {
  term:       string;
  definition: string;
}

export interface SubtopicQuiz {
  question:    string;
  options:     string[];   // exactly 3 options
  answer:      number;     // 0-based index of correct option
  explanation: string;     // 1-2 sentences shown after answering
}

export interface TopicReading {
  topicId:      string;
  title:        string;
  subtopics:    { title: string; content: string; quiz: SubtopicQuiz }[];
  keyTerms:     TopicKeyTerm[];
  whyItMatters: string;
}

export interface DocumentReading {
  topics: TopicReading[];
}

// ── Feed generator ────────────────────────────────────────────

export interface FeedAudit {
  coverageScore: number;   // 0–100: % of major topics from source represented in cards
  accuracyScore: number;   // 0–100: how well cards reflect the source without adding outside knowledge
  depthScore:    number;   // 0–100: whether cards span the full document vs clustering at the start
  overallScore:  number;   // average of the three
  missedTopics:  string[]; // up to 3 important topics from source not covered by any card
}

export interface FeedResult {
  cards: FeedCard[];
  audit: FeedAudit | null;
}

export type FeedCard =
  | { type: 'summary';        title: string; points: string[] }
  | { type: 'flashcard';      question: string; answer: string }
  | { type: 'concept';        title: string; explanation: string; example: string; analogy: string; keyTerms: { term: string; definition: string }[] }
  | { type: 'worked_example'; title: string; problem: string; steps: { label: string; content: string }[]; insight: string }
  | { type: 'fill_blank';     sentence: string; blanks: string[]; hint: string }
  | { type: 'diagram';        title: string; center: string; nodes: { label: string; emoji: string }[] }
  | { type: 'animation';      title: string; steps: { icon: string; title: string; description: string }[] }
  | { type: 'quiz';           question: string; options: string[]; correctIndex: number; explanation: string };

// ── Streaming text helper ─────────────────────────────────────
// Accumulates a full streamed response so JSON-generating functions
// don't sit idle waiting for a complete message (avoids proxy timeouts).
// Also captures input/output token counts from the stream events and
// logs them to api_usage (fire-and-forget) for cost tracking.
async function streamToText(
  client:  ReturnType<typeof getClient>,
  params:  Parameters<typeof client.messages.create>[0],
  fnName:  string,
): Promise<string> {
  let text         = '';
  let inputTokens  = 0;
  let outputTokens = 0;

  const stream = await client.messages.create({ ...params, stream: true });
  for await (const event of stream) {
    if (event.type === 'message_start') {
      inputTokens = event.message.usage.input_tokens;
    } else if (event.type === 'message_delta' && event.usage) {
      outputTokens = event.usage.output_tokens;
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text;
    }
  }

  void dbLogUsage(_currentUserId, fnName, params.model as string, inputTokens, outputTokens);
  return text;
}

function sourceBlock(contentText: string | null, hasPdf: boolean): string {
  return hasPdf
    ? 'The full document (text + images) is attached above.'
    : contentText
      ? `SOURCE CONTENT — use ONLY facts from this text:\n"""\n${contentText.slice(0, 40_000)}\n"""`
      : '(No source — use accurate general knowledge for this topic.)';
}

function buildActivitiesPrompt(topic: string, contentText: string | null, hasPdf: boolean): string {
  return `You are an expert educational content designer. Generate a rich, sequenced learning feed for: "${topic}"
${sourceBlock(contentText, hasPdf)}

Generate as many cards as needed to achieve full coverage of the source — minimum 12, maximum 20.
Scale the count to the content: a dense 30-page document warrants 18-20 cards; a short 5-page document 12-14.

Required card sequence (repeat types as needed to cover all major topics):
- Start with: summary, concept, concept
- Then alternate freely between: flashcard, concept, worked_example, animation, fill_blank, quiz
- End with at least 2 quiz cards
- Every major topic, named concept, process, and key figure in the source must appear in at least one card

BEFORE generating any card: mentally divide the document into three equal thirds (beginning, middle, end).
Allocate cards proportionally — approximately one third of all cards must draw from each third of the document.
Do not move on from a third until you have extracted its key topics.

Rules:
- Cover the FULL breadth of the source — spread cards across ALL sections, not just the opening
- All facts from source content only; never invent
- fill_blank: number of _____ must exactly equal blanks array length
- worked_example steps: each step builds logically on the previous
- quiz correctIndex is 0-based; distractors must be plausible
- No two cards may cover the same concept

Return ONLY valid JSON — no markdown fences:
{
  "cards": [
    { "type": "summary", "title": "Key concepts — ...", "points": ["...", "...", "...", "...", "..."] },
    {
      "type": "concept",
      "title": "...",
      "explanation": "2-3 clear sentences explaining the core concept with precise vocabulary",
      "example": "A concrete real-world example that makes it tangible",
      "analogy": "A memorable analogy or metaphor that aids understanding",
      "keyTerms": [
        { "term": "...", "definition": "concise 1-sentence definition" },
        { "term": "...", "definition": "..." },
        { "term": "...", "definition": "..." }
      ]
    },
    {
      "type": "concept",
      "title": "...",
      "explanation": "2-3 clear sentences on a DIFFERENT concept from the source",
      "example": "A concrete real-world example",
      "analogy": "A memorable analogy or metaphor",
      "keyTerms": [
        { "term": "...", "definition": "..." },
        { "term": "...", "definition": "..." },
        { "term": "...", "definition": "..." }
      ]
    },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    {
      "type": "worked_example",
      "title": "...",
      "problem": "The scenario, question, or problem to work through",
      "steps": [
        { "label": "Step 1: Identify", "content": "What to do and why — be specific" },
        { "label": "Step 2: Apply", "content": "..." },
        { "label": "Step 3: Conclude", "content": "..." }
      ],
      "insight": "The key takeaway — what this example teaches"
    },
    {
      "type": "animation",
      "title": "How it works",
      "steps": [
        { "icon": "🌱", "title": "Stage name", "description": "What happens at this stage and why it matters" }
      ]
    },
    {
      "type": "fill_blank",
      "sentence": "The _____ converts _____ into energy through _____.",
      "blanks": ["exact answer 1", "exact answer 2", "exact answer 3"],
      "hint": "Think about the main mechanism described in the source"
    },
    {
      "type": "fill_blank",
      "sentence": "Another sentence from a later section with _____ and _____.",
      "blanks": ["exact answer 1", "exact answer 2"],
      "hint": "Hint referencing a different part of the source"
    },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 0, "explanation": "..." },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 1, "explanation": "..." }
  ],
  "audit": {
    "coverageScore": <0–100, % of major topics from the source represented across all cards>,
    "accuracyScore": <0–100, how accurately cards reflect the source — deduct for content not grounded in the source>,
    "depthScore": <0–100, whether cards span the full document or cluster around the opening pages>,
    "overallScore": <integer average of the three scores>,
    "missedTopics": [<up to 3 important topics from the source not covered by any card>]
  }
}`;
}

function buildFlashcardsOnlyPrompt(topic: string, contentText: string | null, hasPdf: boolean): string {
  return `You are an expert educator. Generate as many flashcards as needed to achieve full coverage of the source — minimum 20, maximum 40.
Scale the count to the content: a dense 30-page document warrants 35-40 cards; a short 5-page document 20-25.
Topic: "${topic}"
${sourceBlock(contentText, hasPdf)}

BEFORE generating any card: mentally divide the document into three equal thirds (beginning, middle, end).
Allocate cards proportionally — approximately one third of all cards must draw from each third of the document.
Do not move on from a third until you have extracted its key topics.

Rules:
- Every major section, named concept, process, key figure, and fact in the source must appear in at least one card
- Vary question types: definitions, mechanisms, comparisons, cause-effect, applications
- Answers: 1-3 precise sentences; include exact terminology from the source
- Each card must cover a DISTINCT concept — no repetition

Return ONLY valid JSON — no markdown fences:
{
  "cards": [
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." },
    { "type": "flashcard", "question": "...", "answer": "..." }
  ],
  "audit": {
    "coverageScore": <0–100>,
    "accuracyScore": <0–100>,
    "depthScore": <0–100>,
    "overallScore": <integer average>,
    "missedTopics": [<up to 3 important topics not covered>]
  }
}`;
}

function buildQuizOnlyPrompt(topic: string, contentText: string | null, hasPdf: boolean): string {
  return `You are an expert educator. Generate as many quiz questions as needed to achieve full coverage of the source — minimum 12, maximum 16.
Scale the count to the content: a dense document warrants 14-16 questions; a short one 12.
Topic: "${topic}"
${sourceBlock(contentText, hasPdf)}

BEFORE generating any question: mentally divide the document into three equal thirds (beginning, middle, end).
Allocate questions proportionally — approximately one third of all questions must draw from each third of the document.
Do not move on from a third until you have extracted its key testable concepts.

Rules:
- Every major section and key concept in the source must be tested by at least one question
- Each question has exactly 4 options
- correctIndex is 0-based (0 = first option is correct)
- Distractors must be plausible — not obviously wrong
- Explanation addresses the most tempting wrong answer (2-3 sentences)
- Mix recall, application, and analysis questions
- Each question must cover a DISTINCT concept — no repetition

Return ONLY valid JSON — no markdown fences:
{
  "cards": [
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 0, "explanation": "..." },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 1, "explanation": "..." },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 2, "explanation": "..." },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 0, "explanation": "..." },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 3, "explanation": "..." },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 1, "explanation": "..." },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 2, "explanation": "..." },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 0, "explanation": "..." },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 3, "explanation": "..." },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 1, "explanation": "..." },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 2, "explanation": "..." },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 3, "explanation": "..." }
  ],
  "audit": {
    "coverageScore": <0–100>,
    "accuracyScore": <0–100>,
    "depthScore": <0–100>,
    "overallScore": <integer average>,
    "missedTopics": [<up to 3 important topics not covered>]
  }
}`;
}

function repairJson(s: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped  = false;
  for (const ch of s) {
    if (escaped)                       { escaped = false; continue; }
    if (ch === '\\' && inString)       { escaped = true;  continue; }
    if (ch === '"')                    { inString = !inString; continue; }
    if (inString)                      { continue; }
    if (ch === '{')                    { stack.push('}'); }
    else if (ch === '[')               { stack.push(']'); }
    else if (ch === '}' || ch === ']') { stack.pop(); }
  }
  return s.replace(/,\s*$/, '') + stack.reverse().join('');
}

export async function generateFeed(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
  mode:        'activities' | 'flashcards' | 'quiz' = 'activities',
): Promise<FeedResult> {
  const client = getClient();

  const promptFn  = mode === 'flashcards' ? buildFlashcardsOnlyPrompt
    : mode === 'quiz' ? buildQuizOnlyPrompt
    : buildActivitiesPrompt;

  const maxTokens = mode === 'flashcards' ? 16000 : mode === 'quiz' ? 8000 : 12000;

  type MsgContent = Parameters<typeof client.messages.create>[0]['messages'][0]['content'];
  const userContent: MsgContent = pdfBase64
    ? ([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: promptFn(topic, contentText, true) },
      ] as MsgContent)
    : promptFn(topic, contentText, false);

  const raw = await streamToText(client, {
    model:    'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    system:   'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages: [{ role: 'user', content: userContent }],
  }, 'generateFeed');

  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Failed to generate content. Please retry.');

  let parsed: { cards: FeedCard[]; audit?: FeedAudit };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    parsed = JSON.parse(repairJson(raw.slice(start)));
  }

  if (!Array.isArray(parsed.cards) || parsed.cards.length === 0) {
    throw new Error('Invalid response. Please retry.');
  }

  return { cards: parsed.cards, audit: parsed.audit ?? null };
}

// ── Post-booster re-audit ─────────────────────────────────────
// Re-scores the final deck (main + booster) using a compact card manifest.
// Text-only, no PDF re-send — costs ~$0.003 per run.

export async function reauditCards(
  topic:       string,
  cards:       FeedCard[],
  contentText: string | null,
): Promise<FeedAudit | null> {
  if (cards.length === 0) return null;
  const client = getClient();

  const manifest = cards.map((c, i) => {
    switch (c.type) {
      case 'summary':        return `${i + 1}. Summary: "${c.title}" (${c.points.length} points)`;
      case 'flashcard':      return `${i + 1}. Flashcard: "${c.question}"`;
      case 'concept':        return `${i + 1}. Concept: "${c.title}" — terms: ${c.keyTerms.map(k => k.term).join(', ')}`;
      case 'worked_example': return `${i + 1}. Worked Example: "${c.title}"`;
      case 'animation':      return `${i + 1}. Animation: "${c.title}" (${c.steps.length} steps)`;
      case 'fill_blank':     return `${i + 1}. Fill-blank: "${c.sentence}"`;
      case 'quiz':           return `${i + 1}. Quiz: "${c.question}"`;
      case 'diagram':        return `${i + 1}. Diagram: "${c.title}"`;
      default:               return `${i + 1}. Card: ${(c as { type: string }).type}`;
    }
  }).join('\n');

  const sourceCtx = contentText
    ? `SOURCE CONTENT:\n"""\n${contentText.slice(0, 20_000)}\n"""`
    : '(No source text — assess based on topic and card topics.)';

  const prompt = `You are a content quality auditor. Score this ${cards.length}-card learning deck for "${topic}".

${sourceCtx}

CARD DECK:
${manifest}

Score 0-100 on each dimension:
- coverageScore: % of major topics, named concepts, key figures, and facts from the source represented across all cards
- accuracyScore: how well cards reflect the source without invented facts
- depthScore: whether cards spread evenly across the full document (beginning, middle, end) or cluster at the front
- overallScore: integer average of the three
- missedTopics: up to 3 important source topics not covered by any card (empty array if none)

Return ONLY valid JSON:
{ "coverageScore": <0-100>, "accuracyScore": <0-100>, "depthScore": <0-100>, "overallScore": <integer>, "missedTopics": [] }`;

  const raw = await streamToText(client, {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: prompt }],
  }, 'reauditCards');

  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) return null;

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (typeof parsed.coverageScore !== 'number') return null;
    return parsed as FeedAudit;
  } catch { return null; }
}

// ── Booster pass ──────────────────────────────────────────────
// Generates one targeted flashcard per missed topic — text-only, no PDF re-send.

export async function generateBoosterCards(
  topic:       string,
  missedTopics: string[],
  contentText: string | null,
): Promise<FeedCard[]> {
  if (missedTopics.length === 0) return [];
  const client = getClient();

  const topicList = missedTopics.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const sourceCtx = contentText
    ? `SOURCE CONTENT:\n"""\n${contentText.slice(0, 20_000)}\n"""`
    : '(Use accurate general knowledge for this topic.)';

  const prompt = `You are an expert educator. Generate exactly ${missedTopics.length} flashcard(s) for the topic "${topic}".
${sourceCtx}

Each flashcard must directly address exactly one of these missed topics — in order:
${topicList}

Rules:
- One flashcard per missed topic — no more, no less
- Answers: 1-3 precise sentences with exact facts, names, dates, or measurements
- Ground answers in the source content where possible; otherwise use accurate general knowledge

Return ONLY valid JSON — no markdown fences:
{ "cards": [{ "type": "flashcard", "question": "...", "answer": "..." }] }`;

  const raw = await streamToText(client, {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: prompt }],
  }, 'generateBoosterCards');

  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) return [];

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed.cards) ? parsed.cards as FeedCard[] : [];
  } catch {
    try {
      const parsed = JSON.parse(repairJson(raw.slice(start)));
      return Array.isArray(parsed.cards) ? parsed.cards as FeedCard[] : [];
    } catch { return []; }
  }
}

// ── Content map generator ─────────────────────────────────────

export async function generateContentMap(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
  gapFill?:    string[],      // pass-2: concepts that must be explicitly included
): Promise<ContentMap> {
  const client = getClient();
  const hasPdf = !!pdfBase64;

  const gapBlock = gapFill?.length
    ? `\n\nCRITICAL GAP-FILL REQUIREMENT:\nA coverage audit identified the following concepts as MISSING from an earlier version of this map.\nYou MUST explicitly include ALL of these in appropriate topics and subtopics — do not skip any:\n${gapFill.map((g, i) => `${i + 1}. ${g}`).join('\n')}\nIf a concept doesn't fit existing topics, add a new subtopic or topic to accommodate it.`
    : '';

  const prompt = `You are an expert educational content analyst. Analyze this document and extract a structured learning map.

Topic: "${topic}"
${sourceBlock(contentText, hasPdf)}${gapBlock}

Extract a hierarchical topic map. Cover the FULL document proportionally — topics from the beginning, middle, and end.
Generate 4–8 major topics, each with 2–5 subtopics.

Return ONLY valid JSON — no markdown fences:
{
  "synthesis": "3–4 sentences: the document's main theme, key arguments, overall structure, and why it matters to a student",
  "topics": [
    {
      "id": "t1",
      "title": "Major Topic Name",
      "summary": "1–2 sentences describing what this topic covers and its significance",
      "subtopics": [
        { "id": "t1s1", "title": "Subtopic Name", "summary": "1–2 sentences on this specific subtopic" },
        { "id": "t1s2", "title": "Subtopic Name", "summary": "1–2 sentences on this specific subtopic" }
      ]
    }
  ]
}`;

  type MsgContent = Parameters<typeof client.messages.create>[0]['messages'][0]['content'];
  const userContent: MsgContent = pdfBase64
    ? ([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt },
      ] as MsgContent)
    : prompt;

  const raw = await streamToText(client, {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: userContent }],
  }, 'generateContentMap');

  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Failed to generate topic map. Please retry.');

  let parsed: ContentMap;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    parsed = JSON.parse(repairJson(raw.slice(start)));
  }

  if (!parsed.synthesis || !Array.isArray(parsed.topics) || parsed.topics.length === 0) {
    throw new Error('Invalid topic map response. Please retry.');
  }

  return parsed;
}

// ── Document reading generator ────────────────────────────────

export async function generateReading(
  topic:          string,
  contentText:    string | null,
  _pdfBase64:     string | null,  // kept for API compatibility; not re-sent per-topic to avoid 7× data transfer
  contentMap:     ContentMap,
  sentenceTarget: number = 3,
  gapFill?:       string[],   // pass-2: concepts that must appear in the written content
): Promise<DocumentReading> {
  const client = getClient();

  const MAX_TOPICS = 7;
  const cappedTopics = contentMap.topics.slice(0, MAX_TOPICS);

  const sentenceInstruction = sentenceTarget <= 2
    ? '2 concise sentences — one main idea, one supporting detail'
    : sentenceTarget <= 3
      ? '3 sentences — clear and focused, one key fact per sentence'
      : '4 sentences — include elaboration and one concrete example';

  const gapBlock = gapFill?.length
    ? `\n\nCRITICAL GAP-FILL: The following concepts must be explicitly woven in where relevant:\n${gapFill.map((g, i) => `${i + 1}. ${g}`).join('\n')}`
    : '';

  // Generate each topic in its own focused API call, all in parallel.
  // A single call for 7 topics × 5 subtopics exceeds the model's ~8k output
  // token limit and gets truncated — per-topic calls (max ~2500 tokens each)
  // are reliable regardless of document size.
  const topicResults = await Promise.all(
    cappedTopics.map(async (t): Promise<TopicReading | null> => {
      // Build per-topic source context.
      // For text docs: include raw text (first 6k chars) + this topic's content-map summaries.
      // For PDF-only docs: rely on the content-map summaries extracted during map generation.
      const topicContext =
        `Topic overview: ${t.title} — ${t.summary}\n` +
        t.subtopics.map(s => `• ${s.title}: ${s.summary}`).join('\n');

      const sourceCtx = contentText
        ? `SOURCE CONTENT (use facts from this):\n"""\n${contentText.slice(0, 6_000)}\n"""\n\nTOPIC CONTEXT FROM CONTENT MAP:\n${topicContext}`
        : `TOPIC CONTEXT (extracted from the source document):\n${topicContext}`;

      const subtopicList = t.subtopics.map(s => `• "${s.title}"`).join('\n');

      const prompt = `You are an expert educational content writer. Write study material for a single topic.

Overall subject: "${topic}"
${sourceCtx}${gapBlock}

TOPIC (topicId: "${t.id}"): "${t.title}"
SUBTOPICS TO COVER:
${subtopicList}

For EACH subtopic above write:
1. "content": EXACTLY ${sentenceInstruction}. Grade 9–10 reading level. Use specific facts, figures, and named concepts.
2. "quiz": one short comprehension question — 3 plausible options (exactly one correct), 0-based answer index, 1-sentence explanation.

Also write:
- "keyTerms": 3–5 key terms from this topic with 1–2 sentence definitions each.
- "whyItMatters": one sentence on this topic's significance.

Rules: ground all facts in the source; subtopic titles must match exactly; quiz distractors must be plausible.

Return ONLY valid JSON — no markdown:
{
  "topicId": "${t.id}",
  "title": "${t.title}",
  "subtopics": [
    {
      "title": "Subtopic name (must match outline)",
      "content": "...",
      "quiz": { "question": "...", "options": ["Option A", "Option B", "Option C"], "answer": 0, "explanation": "..." }
    }
  ],
  "keyTerms": [{ "term": "...", "definition": "..." }],
  "whyItMatters": "..."
}`;

      try {
        const raw = await streamToText(client, {
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 2500,  // per-topic; 5 subtopics × 4 sentences + quiz + terms ≈ 1700 tokens
          system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
          messages:   [{ role: 'user', content: prompt }],
        }, 'generateReading');

        const start = raw.indexOf('{');
        const end   = raw.lastIndexOf('}');
        if (start === -1 || end === -1) {
          console.error(`[generateReading] topic "${t.title}" — no JSON in response`);
          return null;
        }

        let parsed: TopicReading;
        try {
          parsed = JSON.parse(raw.slice(start, end + 1));
        } catch {
          try {
            parsed = JSON.parse(repairJson(raw.slice(start)));
          } catch {
            console.error(`[generateReading] topic "${t.title}" — JSON parse failed. Tail:`, raw.slice(-200));
            return null;
          }
        }

        if (!Array.isArray(parsed.subtopics) || parsed.subtopics.length === 0) {
          console.error(`[generateReading] topic "${t.title}" — no subtopics in response`);
          return null;
        }

        return { ...parsed, topicId: t.id, title: t.title };
      } catch (e) {
        console.error(`[generateReading] topic "${t.title}" error:`, e);
        return null;
      }
    })
  );

  const topics = topicResults.filter((t): t is TopicReading => t !== null && Array.isArray(t.subtopics) && t.subtopics.length > 0);
  if (topics.length === 0) throw new Error('Failed to generate reading material. Please retry.');
  return { topics };
}

// ── Visual learning components ────────────────────────────────

export interface ChartData {
  chartType: 'bar' | 'line' | 'pie';
  xLabel?:   string;
  yLabel?:   string;
  items:     { name: string; value: number }[];
}

export interface DiagramData {
  nodes: { id: string; label: string; subtitle?: string; nodeType?: 'start' | 'process' | 'decision' | 'end' }[];
  edges: { from: string; to: string; label?: string }[];
}

export interface TimelineData {
  events: { date: string; title: string; description: string }[];
}

export interface ProcessData {
  steps: { title: string; description: string }[];
}

// ── Dynamic simulation payload (client-side render via KaTeX / function-plot / p5) ──
export interface SimulationPayload {
  domain:             'math' | 'graphing' | 'biology';
  title:              string;
  concept:            string;
  // math domain → KaTeX renders these
  latexFormulas?:     string[];
  // graphing domain → function-plot renders this
  graphingEquation?:  string;
  // biology domain → p5 simulation switcher
  simulationVariables?: {
    simulationType?: 'circulatory' | 'mitosis' | 'neural' | 'ecosystem';
    [key: string]: unknown;
  };
}

export interface VisualComponent {
  title:   string;
  type:    'diagram' | 'chart' | 'timeline' | 'process' | 'interactive' | 'simulation' | 'dynamic';
  concept: string;
  // Structured data — rendered by React components (new approach)
  chartData?:        ChartData;
  diagramData?:      DiagramData;
  timelineData?:     TimelineData;
  processData?:      ProcessData;
  simulationPayload?: SimulationPayload;
  // Raw HTML — simulation + legacy cached visuals
  html?: string;
}

export interface VisualSet {
  components: VisualComponent[];
}



/** Keyword-based fallback when the Claude API call for tool_use fails. */
function buildFallbackPayload(topic: string): SimulationPayload {
  const t = topic.toLowerCase();

  // ── Biology ──────────────────────────────────────────────────────────────
  if (/\b(blood|heart|circulat|cardio|vascu|artery|vein|plasma|pulmonary)\b/.test(t))
    return { domain: 'biology', title: 'Circulatory System', concept: 'Animated blood flow through the heart and vessels.', simulationVariables: { simulationType: 'circulatory' } };
  if (/\b(cell|divis|mitosis|meiosis|chromosome|nucleus|dna|rna|genetic|genome|replicat)\b/.test(t))
    return { domain: 'biology', title: 'Cell Division', concept: 'Animated mitosis stages from interphase to cytokinesis.', simulationVariables: { simulationType: 'mitosis' } };
  if (/\b(neuron|nerve|synapse|action.?potential|brain|neural|dendrite|axon|cortex|reflex)\b/.test(t))
    return { domain: 'biology', title: 'Neural Signal', concept: 'Action potential propagating across a neuron chain.', simulationVariables: { simulationType: 'neural' } };
  if (/\b(ecosystem|predator|prey|population|ecology|species|food.web|evolution|natural.select|biome)\b/.test(t))
    return { domain: 'biology', title: 'Ecosystem Dynamics', concept: 'Live predator-prey particle simulation.', simulationVariables: { simulationType: 'ecosystem' } };

  // ── Graphing ──────────────────────────────────────────────────────────────
  if (/\b(trigonometr|sine|cosine|tangent|wave|oscillat|periodic)\b/.test(t))
    return { domain: 'graphing', title: 'Trigonometric Wave', concept: 'Graph of a sine wave.', graphingEquation: 'sin(x)' };
  if (/\b(quadratic|parabola|polynomial)\b/.test(t))
    return { domain: 'graphing', title: 'Quadratic Function', concept: 'Graph of a quadratic equation.', graphingEquation: 'x^2' };
  if (/\b(exponential|logarithm|log|growth|decay)\b/.test(t))
    return { domain: 'graphing', title: 'Exponential Function', concept: 'Graph of exponential growth.', graphingEquation: 'exp(x)' };

  // ── Math (LaTeX) ──────────────────────────────────────────────────────────
  if (/\b(limit|limits|continuity|lim|approaches|epsilon|delta)\b/.test(t))
    return { domain: 'math', title: 'Limits & Continuity', concept: 'Core limit definitions and rules.', latexFormulas: ['\\lim_{x \\to c} f(x) = L', '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1', '\\lim_{x \\to \\infty} \\left(1 + \\frac{1}{x}\\right)^x = e', '\\lim_{x \\to 0} \\frac{e^x - 1}{x} = 1'] };
  if (/\b(derivative|differenti|rate.of.change|gradient|tangent.line|chain.rule|product.rule)\b/.test(t))
    return { domain: 'math', title: 'Differentiation Rules', concept: 'Core derivative formulas.', latexFormulas: ['\\frac{d}{dx}[x^n] = nx^{n-1}', '\\frac{d}{dx}[\\sin x] = \\cos x', '\\frac{d}{dx}[e^x] = e^x', '\\frac{d}{dx}[\\ln x] = \\frac{1}{x}'] };
  if (/\b(integral|integrat|antiderivative|area.under|riemann)\b/.test(t))
    return { domain: 'math', title: 'Integration Rules', concept: 'Core integral formulas.', latexFormulas: ['\\int x^n\\,dx = \\frac{x^{n+1}}{n+1} + C', '\\int \\sin x\\,dx = -\\cos x + C', '\\int e^x\\,dx = e^x + C', '\\int_a^b f(x)\\,dx = F(b) - F(a)'] };
  if (/\b(calculus)\b/.test(t))
    return { domain: 'math', title: 'Calculus Essentials', concept: 'Key derivative and integral formulas.', latexFormulas: ['\\frac{d}{dx}[x^n] = nx^{n-1}', '\\int x^n\\,dx = \\frac{x^{n+1}}{n+1} + C', '\\lim_{h \\to 0}\\frac{f(x+h)-f(x)}{h}'] };
  if (/\b(algebra|equation|linear|simultaneous|matrix|vector|complex.number)\b/.test(t))
    return { domain: 'math', title: 'Algebra Equations', concept: 'Key algebraic formulas.', latexFormulas: ['ax^2 + bx + c = 0', 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', '(a+b)^2 = a^2 + 2ab + b^2'] };
  if (/\b(statistic|probability|normal.distribution|mean|variance|standard.deviation)\b/.test(t))
    return { domain: 'math', title: 'Statistics Formulas', concept: 'Core statistical measures.', latexFormulas: ['\\mu = \\frac{1}{n}\\sum_{i=1}^n x_i', '\\sigma^2 = \\frac{1}{n}\\sum(x_i - \\mu)^2', 'P(A \\cup B) = P(A) + P(B) - P(A \\cap B)'] };
  if (/\b(physics|force|energy|momentum|velocity|acceleration|newton|motion|kinematic)\b/.test(t))
    return { domain: 'math', title: 'Physics Equations', concept: 'Key equations of motion and energy.', latexFormulas: ['F = ma', 'v = u + at', 'E_k = \\frac{1}{2}mv^2', 's = ut + \\frac{1}{2}at^2'] };
  if (/\b(chemistry|reaction|equilibrium|thermodynam|enthalpy|entropy|gibbs)\b/.test(t))
    return { domain: 'math', title: 'Chemistry Equations', concept: 'Core thermodynamic and equilibrium expressions.', latexFormulas: ['\\Delta G = \\Delta H - T\\Delta S', 'K_{eq} = \\frac{[\\text{products}]}{[\\text{reactants}]}', 'PV = nRT'] };

  // ── Default: graphing (y=x² is universally relatable) ────────────────────
  return { domain: 'graphing', title: `${topic} — Function Graph`, concept: `Interactive graph for ${topic}.`, graphingEquation: 'x^2' };
}

/**
 * Generates a dynamic visual using Claude tool_use for schema-constrained JSON output.
 * Claude picks one of three renderers based on topic:
 *   math     → KaTeX formula display
 *   graphing → function-plot equation graph
 *   biology  → p5.js preset simulation (circulatory / mitosis / neural / ecosystem)
 *
 * Falls back to a topic-keyword-inferred visual if the API call fails,
 * so the Dynamic tab always appears.
 */
async function generateDynamicVisual(
  topic:       string,
  contentText: string | null,
): Promise<VisualComponent> {
  const makeComponent = (payload: SimulationPayload): VisualComponent => ({
    type:              'dynamic',
    title:             payload.title,
    concept:           payload.concept,
    simulationPayload: payload,
  });

  try {
    const client = getClient();

    const sourceCtx = contentText
      ? `SOURCE MATERIAL:\n"""\n${contentText.slice(0, 8000)}\n"""`
      : '(No source — use accurate general knowledge for this topic.)';

    const prompt = `You are an expert educational content designer.
Choose the best interactive visual for a student studying: "${topic}"

${sourceCtx}

DOMAIN RULES — read carefully:

Use "biology" when the topic is about living organisms, body systems, anatomy, physiology, ecology, cells, or neuroscience.
Examples → Circulatory System = biology/circulatory, Mitosis = biology/mitosis, Nervous System = biology/neural, Food Webs = biology/ecosystem.

Use "math" when the topic is about mathematical formulas, equations, proofs, or named rules.
Examples → Limits = math (show lim formulas), Derivatives = math, Newton's Laws = math, Chemical Equations = math.

Use "graphing" when the topic is a mathematical function best understood by seeing its curve.
Examples → Quadratic Functions = graphing (x^2), Sine Wave = graphing (sin(x)), Exponential Growth = graphing (exp(x)).

IMPORTANT: "Circulatory System" → domain MUST be "biology", simulationType "circulatory".
IMPORTANT: "Limits" or "Continuity" → domain MUST be "math", provide limit formula strings.

Call render_simulation now.`;

    const response = await client.messages.create({
      model:      'claude-3-5-sonnet-20241022',
      max_tokens: 600,
      tools: [{
        name:        'render_simulation',
        description: 'Render an interactive educational visual for a student',
        input_schema: {
          type: 'object' as const,
          properties: {
            domain:           { type: 'string', enum: ['math', 'graphing', 'biology'] },
            title:            { type: 'string', description: 'Short descriptive title (≤8 words)' },
            concept:          { type: 'string', description: 'One sentence explaining what this visual shows' },
            latexFormulas:    { type: 'array', items: { type: 'string' }, description: 'LaTeX formula strings for math domain' },
            graphingEquation: { type: 'string', description: 'math.js equation for graphing domain, e.g. "sin(x)"' },
            simulationVariables: {
              type: 'object',
              description: 'Parameters for biology domain',
              properties: {
                simulationType: { type: 'string', enum: ['circulatory', 'mitosis', 'neural', 'ecosystem'] },
              },
            },
          },
          required: ['domain', 'title', 'concept'],
        },
      }],
      tool_choice: { type: 'tool', name: 'render_simulation' },
      messages:    [{ role: 'user', content: prompt }],
    });

    void dbLogUsage(
      _currentUserId,
      'generateDynamicVisual',
      'claude-3-5-sonnet-20241022',
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    const toolBlock = response.content.find(b => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      console.warn('[generateDynamicVisual] no tool_use block — using fallback');
      return makeComponent(buildFallbackPayload(topic));
    }

    const payload = toolBlock.input as SimulationPayload;
    if (!payload?.domain || !payload?.title) {
      console.warn('[generateDynamicVisual] invalid payload — using fallback', payload);
      return makeComponent(buildFallbackPayload(topic));
    }

    console.info('[generateDynamicVisual] ✓ domain:', payload.domain, '| simType:', payload.simulationVariables?.simulationType);
    return makeComponent(payload);

  } catch (err) {
    console.warn('[generateDynamicVisual] API error — using fallback:', err);
    return makeComponent(buildFallbackPayload(topic));
  }
}

/**
 * Generates visual learning components.
 * Currently: Dynamic visual only (Claude tool_use → KaTeX / function-plot / p5).
 * Static visuals (diagram, chart, timeline, process, simulation) are disabled
 * while the Dynamic engine is being tested.
 */
export async function generateVisualComponents(
  topic:       string,
  contentText: string | null,
  _pdfBase64:  string | null,
): Promise<VisualSet> {
  const dynamicVisual = await generateDynamicVisual(topic, contentText);
  return { components: [dynamicVisual] };
}

// ── Content audit ─────────────────────────────────────────────

export interface ContentAudit {
  coverageScore:  number;   // 0–100
  missedConcepts: string[]; // specific named items, dates, facts not in the map
  suggestions:    string[]; // 1–3 actionable tips
}

/**
 * Audits a generated content map against the original document.
 * Returns a coverage score and an exhaustive list of specific missed concepts.
 */
export async function generateContentAudit(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
  contentMap:  ContentMap,
): Promise<ContentAudit> {
  const client = getClient();
  const hasPdf = !!pdfBase64;

  const mapSummary = contentMap.topics.map(t =>
    `• ${t.title}\n${t.subtopics.map(s => `  – ${s.title}: ${s.summary}`).join('\n')}`
  ).join('\n');

  const prompt = `You are a curriculum quality auditor. Compare the original document to the generated topic map and identify exactly what was missed.

Topic: "${topic}"
${sourceBlock(contentText, hasPdf)}

GENERATED TOPIC MAP:
Synthesis: ${contentMap.synthesis}

Topics covered:
${mapSummary}

Task: List EVERY important concept, named entity, specific date, named person/mission/device, specific statistic, key process, or testable fact from the original document that is NOT represented in the topic map above.

Be very specific — not "more detail on rovers" but "Lunokhod 2 (1970) — Russia's first remote-controlled robotic rover on the Moon".
Include important supporting facts even if the parent topic is present (e.g. if "Blood Vessels" is in the map but the valve mechanism is missing, list it).
If nothing is missed, return an empty array.

Give a coverageScore 0–100: what percentage of the document's important, testable content is represented in the map.
Give 1–3 concrete suggestions for what the map should add or emphasise.

Return ONLY valid JSON — no markdown:
{
  "coverageScore": <0–100>,
  "missedConcepts": [
    "Specific missed item with brief context",
    "..."
  ],
  "suggestions": [
    "Actionable suggestion",
    "..."
  ]
}`;

  type MsgContent = Parameters<typeof client.messages.create>[0]['messages'][0]['content'];
  const userContent: MsgContent = pdfBase64
    ? ([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt },
      ] as MsgContent)
    : prompt;

  const raw = await streamToText(client, {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: userContent }],
  }, 'generateContentAudit');

  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Failed to generate audit.');

  let parsed: ContentAudit;
  try   { parsed = JSON.parse(raw.slice(start, end + 1)); }
  catch { parsed = JSON.parse(repairJson(raw.slice(start))); }

  if (typeof parsed.coverageScore !== 'number' || !Array.isArray(parsed.missedConcepts)) {
    throw new Error('Invalid audit response.');
  }
  return parsed;
}

// ── Practice quiz ─────────────────────────────────────────────

export interface PracticeQuestion {
  id:           string;
  type:         'mcq' | 'fill' | 'written';
  topicId:      string;
  topicTitle:   string;
  question:     string;
  options?:     string[];    // MCQ only — exactly 3
  answer?:      number;      // MCQ only — 0-based index
  blank?:       string;      // fill only — the correct term
  sampleAnswer?: string;     // written only — for grading
  explanation:  string;
}

export interface PracticeQuiz {
  questions: PracticeQuestion[];
}

export interface WrittenEvaluation {
  score:    0 | 1 | 2;
  feedback: string;
}

export async function generatePracticeQuiz(
  documentReading: DocumentReading,
  topic: string,
): Promise<PracticeQuiz> {
  const client = getClient();

  const topicCount   = documentReading.topics.length;
  const mcqCount     = Math.max(topicCount + 2, 6);
  const fillCount    = Math.max(topicCount, 4);
  const writtenCount = Math.max(Math.ceil(topicCount * 0.75), 3);

  const contentSummary = documentReading.topics.map(t =>
    `TOPIC "${t.title}" (topicId: "${t.topicId}"):\n` +
    t.subtopics.map(s => `  - ${s.title}: ${s.content}`).join('\n') +
    `\n  Key terms: ${t.keyTerms.map(k => k.term).join(', ')}`
  ).join('\n\n');

  const prompt = `Create a comprehensive practice quiz on: "${topic}".

STUDY CONTENT:
${contentSummary}

Generate ${mcqCount + fillCount + writtenCount} questions total:
- ${mcqCount} multiple-choice (type "mcq"): 3 options, one correct (0-based answer index), plausible distractors
- ${fillCount} fill-in-the-blank (type "fill"): sentence with ___ where a key term belongs, "blank" field = the correct term
- ${writtenCount} written explanation (type "written"): requires a short paragraph, "sampleAnswer" field for grading

Rules:
- Spread proportionally across ALL topics — every topicId must appear at least once.
- Explanations are 1-2 sentences shown after answering.
- Written questions test deeper understanding, not just recall.

Return ONLY valid JSON — no markdown:
{
  "questions": [
    { "id": "q1", "type": "mcq", "topicId": "t1", "topicTitle": "...", "question": "...", "options": ["A","B","C"], "answer": 0, "explanation": "..." },
    { "id": "q2", "type": "fill", "topicId": "t1", "topicTitle": "...", "question": "The ___ converts light into energy.", "blank": "chloroplast", "explanation": "..." },
    { "id": "q3", "type": "written", "topicId": "t2", "topicTitle": "...", "question": "Explain why...", "sampleAnswer": "A complete answer would mention...", "explanation": "Key points: ..." }
  ]
}`;

  const raw = await streamToText(client, {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: prompt }],
  }, 'generatePracticeQuiz');

  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Failed to generate quiz. Please retry.');

  let parsed: PracticeQuiz;
  try   { parsed = JSON.parse(raw.slice(start, end + 1)); }
  catch { parsed = JSON.parse(repairJson(raw.slice(start))); }

  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error('Invalid quiz response. Please retry.');
  }
  return parsed;
}

export async function evaluateWrittenAnswer(
  question:     string,
  sampleAnswer: string,
  userAnswer:   string,
  topic:        string,
): Promise<WrittenEvaluation> {
  const client = getClient();
  const raw = await streamToText(client, {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system:     'You are a precise JSON generator. Output only valid JSON.',
    messages: [{
      role: 'user',
      content: `Grade this student answer on "${topic}".

QUESTION: ${question}
SAMPLE ANSWER: ${sampleAnswer}
STUDENT ANSWER: ${userAnswer}

Score: 2 = comprehensive & correct, 1 = partially correct, 0 = incorrect or missing key ideas.
Return ONLY: { "score": 0, "feedback": "Warm 1-2 sentence feedback." }`,
    }],
  }, 'evaluateWrittenAnswer');
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) return { score: 1, feedback: 'Partial credit — keep going!' };
  try   { return JSON.parse(raw.slice(start, end + 1)) as WrittenEvaluation; }
  catch { return { score: 1, feedback: 'Partial credit — keep going!' }; }
}

// ── Course Material generator ─────────────────────────────────
// Extracts verbatim passages from the source document, organised into
// the same topic/subtopic structure as DocumentReading. The content
// field for each subtopic contains exact sentences from the source —
// no paraphrasing or AI rewriting.

export async function generateCourseMaterial(
  topic:       string,
  contentText: string | null,
  _pdfBase64:  string | null,
  contentMap:  ContentMap,
): Promise<DocumentReading> {
  const client = getClient();
  const MAX_TOPICS = 7;
  const cappedTopics = contentMap.topics.slice(0, MAX_TOPICS);

  // Build a rich source from the content map summaries as fallback
  const mapSource = contentMap.topics.map(t =>
    `${t.title}: ${t.summary}\n` +
    t.subtopics.map(s => `  - ${s.title}: ${s.summary}`).join('\n'),
  ).join('\n\n');

  // Prefer actual document text; fall back to structured map summaries
  const sourceText = contentText ? contentText.slice(0, 8_000) : mapSource;
  const isVerbatim = !!contentText;

  const topicResults = await Promise.all(
    cappedTopics.map(async (t): Promise<TopicReading | null> => {
      const topicContext =
        `Topic overview: ${t.title} — ${t.summary}\n` +
        t.subtopics.map(s => `• ${s.title}: ${s.summary}`).join('\n');

      const subtopicList = t.subtopics.map(s => `• "${s.title}"`).join('\n');

      const contentInstruction = isVerbatim
        ? `"content": Copy 3–5 CONSECUTIVE sentences VERBATIM from the SOURCE CONTENT above that directly explain this subtopic. Use the EXACT words as written — do NOT paraphrase or alter any wording.`
        : `"content": Write 3–5 clear, educational sentences explaining this subtopic based on the source material. Be factual and direct.`;

      const prompt = `You are an expert educational content organiser. Create structured course notes.

Overall subject: "${topic}"
SOURCE CONTENT:
"""
${sourceText}
"""

TOPIC CONTEXT (from content analysis):
${topicContext}

TOPIC (topicId: "${t.id}"): "${t.title}"
SUBTOPICS TO COVER:
${subtopicList}

For EACH subtopic above:
1. ${contentInstruction}
2. "quiz": one comprehension question — 3 plausible options, 0-based answer index, 1-sentence explanation.

Also:
- "keyTerms": 3–5 key terms with definitions.
- "whyItMatters": one sentence explaining this topic's significance.

Rules: subtopic titles must match the outline exactly; quiz distractors must be plausible.

Return ONLY valid JSON — no markdown:
{
  "topicId": "${t.id}",
  "title": "${t.title}",
  "subtopics": [
    { "title": "Subtopic name (must match outline)", "content": "...", "quiz": { "question": "...", "options": ["A", "B", "C"], "answer": 0, "explanation": "..." } }
  ],
  "keyTerms": [{ "term": "...", "definition": "..." }],
  "whyItMatters": "..."
}`;

      try {
        const raw = await streamToText(client, {
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 3000,  // verbatim passages can be longer than AI-written text
          system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
          messages:   [{ role: 'user', content: prompt }],
        }, 'generateCourseMaterial');

        const start = raw.indexOf('{');
        const end   = raw.lastIndexOf('}');
        if (start === -1 || end === -1) {
          console.error(`[generateCourseMaterial] topic "${t.title}" — no JSON`);
          return null;
        }

        let parsed: TopicReading;
        try {
          parsed = JSON.parse(raw.slice(start, end + 1));
        } catch {
          try {
            parsed = JSON.parse(repairJson(raw.slice(start)));
          } catch {
            console.error(`[generateCourseMaterial] topic "${t.title}" — parse failed`);
            return null;
          }
        }

        if (!Array.isArray(parsed.subtopics) || parsed.subtopics.length === 0) return null;
        return { ...parsed, topicId: t.id, title: t.title };
      } catch (e) {
        console.error(`[generateCourseMaterial] topic "${t.title}" error:`, e);
        return null;
      }
    })
  );

  const topics = topicResults.filter((t): t is TopicReading => t !== null && Array.isArray(t.subtopics) && t.subtopics.length > 0);
  if (topics.length === 0) throw new Error('Failed to generate course material. Please retry.');
  return { topics };
}

// ── Paragraph quiz (4–5 Qs per subtopic for Read → Test Me) ──

export interface ParagraphQuestion {
  question:    string;
  options:     string[];  // exactly 4 options
  answer:      number;    // 0-based index of correct option
  explanation: string;
}

export interface ParagraphQuiz {
  questions: ParagraphQuestion[];  // 4–5 questions
}

export async function generateParagraphQuiz(
  subtopicTitle:   string,
  subtopicContent: string,
  topicTitle:      string,
): Promise<ParagraphQuiz> {
  const client = getClient();

  const prompt = `You are an expert educator. Generate exactly 5 multiple-choice questions to test understanding of the following study paragraph.

TOPIC: ${topicTitle}
SUBTOPIC: ${subtopicTitle}

PARAGRAPH CONTENT:
${subtopicContent}

Rules:
- Each question must be directly answerable from the paragraph content above.
- Provide exactly 4 answer options per question (A, B, C, D).
- Exactly one option is correct; the other 3 are plausible distractors.
- Vary difficulty: 2 recall questions, 2 comprehension questions, 1 application/inference question.
- Explanation is 1 sentence shown after the student answers.
- answer is the 0-based index of the correct option.

Return ONLY valid JSON — no markdown:
{
  "questions": [
    { "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "answer": 0, "explanation": "..." },
    { "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "answer": 2, "explanation": "..." },
    { "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "answer": 1, "explanation": "..." },
    { "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "answer": 3, "explanation": "..." },
    { "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "answer": 0, "explanation": "..." }
  ]
}`;

  const raw = await streamToText(client, {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: prompt }],
  }, 'generateParagraphQuiz');

  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Failed to generate questions. Please retry.');

  let parsed: ParagraphQuiz;
  try   { parsed = JSON.parse(raw.slice(start, end + 1)); }
  catch { parsed = JSON.parse(repairJson(raw.slice(start))); }

  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error('Invalid quiz response. Please retry.');
  }
  return parsed;
}
