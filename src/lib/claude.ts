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
  pdfBase64:      string | null,
  contentMap:     ContentMap,
  sentenceTarget: number = 3,
  gapFill?:       string[],   // pass-2: concepts that must appear in the written content
): Promise<DocumentReading> {
  const client = getClient();
  const hasPdf = !!pdfBase64;

  const mapOutline = contentMap.topics.map(t =>
    `- topicId: "${t.id}" | "${t.title}"\n${t.subtopics.map(s => `    • "${s.title}"`).join('\n')}`
  ).join('\n');

  const sentenceInstruction = sentenceTarget <= 2
    ? '2 concise sentences — one main idea, one supporting detail'
    : sentenceTarget <= 3
      ? '3 sentences — clear and focused, one key fact per sentence'
      : sentenceTarget <= 4
        ? '4 sentences — include elaboration and a concrete example'
        : '4–5 sentences — include nuance, examples, and connections to other topics';

  const gapBlock = gapFill?.length
    ? `\n\nCRITICAL GAP-FILL REQUIREMENT:\nThe following concepts were identified as MISSING from an earlier draft. You MUST weave ALL of them explicitly into the appropriate subtopic content below:\n${gapFill.map((g, i) => `${i + 1}. ${g}`).join('\n')}`
    : '';

  const prompt = `You are an expert educational content writer. Write a structured study guide for each topic and subtopic listed below.

Topic: "${topic}"
${sourceBlock(contentText, hasPdf)}${gapBlock}

TOPICS AND SUBTOPICS TO COVER (use these exact topicId values):
${mapOutline}

For EACH topic write:
1. subtopics: for each subtopic listed above, write EXACTLY ${sentenceInstruction}. Use specific facts, figures, and named concepts from the source. Grade 9–10 reading level. Also generate one short quiz question testing the key idea of that subtopic — 3 answer options, exactly one correct, plus a 1-sentence explanation of the correct answer.
2. keyTerms: 3–5 important terms from this topic with concise, accurate definitions (1–2 sentences each).
3. whyItMatters: one sentence explaining why this topic matters in the broader context.

Rules:
- Ground everything in the source — no invented facts
- Key terms must appear naturally in the subtopic content
- The subtopic titles in your output must match the titles listed above exactly
- Quiz distractors must be plausible — not obviously wrong
- Quiz correctIndex is 0-based

Return ONLY valid JSON — no markdown fences:
{
  "topics": [
    {
      "topicId": "t1",
      "title": "...",
      "subtopics": [
        {
          "title": "Subtopic name from outline",
          "content": "...",
          "quiz": {
            "question": "...",
            "options": ["Option A", "Option B", "Option C"],
            "answer": 0,
            "explanation": "One sentence explaining why the correct answer is right."
          }
        }
      ],
      "keyTerms": [
        { "term": "...", "definition": "..." },
        { "term": "...", "definition": "..." },
        { "term": "...", "definition": "..." }
      ],
      "whyItMatters": "..."
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
    max_tokens: 8000,   // ~40s at Haiku streaming speed — safe within Netlify's 50s limit
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: userContent }],
  }, 'generateReading');

  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Failed to generate reading material. Please retry.');

  let parsed: DocumentReading;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    parsed = JSON.parse(repairJson(raw.slice(start)));
  }

  if (!Array.isArray(parsed.topics) || parsed.topics.length === 0) {
    throw new Error('Invalid reading response. Please retry.');
  }

  return parsed;
}

// ── Visual learning components ────────────────────────────────

export interface VisualComponent {
  title:   string;
  type:    'diagram' | 'chart' | 'timeline' | 'process' | 'interactive' | 'simulation';
  concept: string;
  html:    string;
}

export interface VisualSet {
  components: VisualComponent[];
}

// Shared responsive CSS requirement injected into every generated document
const RESPONSIVE_REQUIREMENTS = `- Complete standalone document (<!DOCTYPE html> to </html>)
- ZERO external resources — no CDN, no external fonts, no image URLs
- Only: inline SVG, Canvas API, CSS animations, vanilla JS
- CRITICAL: html and body must have { margin:0; padding:0; width:100%; height:100%; overflow:hidden }
- Use percentage widths/heights, vw/vh units — NEVER fixed pixel viewport dimensions
- White or #FAFAF9 background, dark readable labels (#1a1a1a or similar)
- All text, labels, and elements must stay within the visible area at any iframe size`;

// Type-specific generation instructions
const VISUAL_TYPE_GUIDE: Record<VisualComponent['type'], string> = {
  diagram:     'SVG anatomical or structural diagram with labeled parts, arrows, and callouts. Use percentage-based SVG viewBox so it scales to any container.',
  chart:       'SVG bar chart, pie chart, or line graph using real data/values from the source. Axes, labels, and bars must be proportional — no fixed pixel sizes.',
  timeline:    'Horizontal or vertical timeline of key stages, events, or phases. Each event is a node with a label. Must scroll or fit within 100% width.',
  process:     'Animated step-by-step flow showing how a key process works (CSS keyframe animation). Steps appear sequentially. Use flexbox/grid — no absolute px offsets.',
  interactive: 'Hoverable or clickable SVG that reveals additional detail on interaction. Tooltips or highlight states on click/hover.',
  simulation:  'Interactive simulation where the user manipulates parameters via sliders or buttons to observe real-time changes. Use requestAnimationFrame for smooth animation. Include: (1) a Canvas or SVG drawing area that fills most of the viewport, (2) at least one labelled slider or button control, (3) accurate mathematical or physical model from the source material, (4) a Reset button. Labels must include units.',
};

/**
 * Generates one visual component in its own API call.
 * Regular visuals: Haiku, max_tokens 2000 (~5–15s).
 * Simulations: Sonnet, max_tokens 5000 (~15–35s) — more complex JS required.
 * All types use responsive CSS so the iframe never clips or overlaps content.
 */
async function generateOneVisual(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
  visualType:  VisualComponent['type'],
): Promise<VisualComponent | null> {
  const client      = getClient();
  const hasPdf      = !!pdfBase64;
  const isSimulation = visualType === 'simulation';
  const model       = isSimulation ? 'claude-sonnet-4-5-20251001' : 'claude-haiku-4-5-20251001';
  const maxTokens   = isSimulation ? 5000 : 2000;

  const prompt = isSimulation
    ? `You are an expert educational simulation developer. Create ONE interactive simulation that accurately models a key concept from the source material.

Topic: "${topic}"
${sourceBlock(contentText, hasPdf)}

Visual type: "simulation"
Instruction: ${VISUAL_TYPE_GUIDE.simulation}

Requirements:
${RESPONSIVE_REQUIREMENTS}
- requestAnimationFrame animation loop for smooth real-time updates
- Interactive controls (sliders/buttons) positioned at the bottom or side — never overlapping the simulation area
- Accurate formulas and constants — ground numbers in the source material
- Clear axis labels, units, and a legend if applicable
- A visible Reset button that restores initial state

Return ONLY valid JSON. Escape double-quotes inside HTML as \\\":
{
  "title": "Short descriptive title",
  "type": "simulation",
  "concept": "One sentence: what concept this simulation demonstrates interactively",
  "html": "<!DOCTYPE html>..."
}`
    : `You are an expert educational multimedia designer. Create ONE self-contained HTML5 visual learning component.

Topic: "${topic}"
${sourceBlock(contentText, hasPdf)}

Visual type: "${visualType}"
Instruction: ${VISUAL_TYPE_GUIDE[visualType]}

Requirements:
${RESPONSIVE_REQUIREMENTS}
- Smooth CSS animations where they add clarity
- Concise and efficient — avoid redundant markup

Return ONLY valid JSON. Escape double-quotes inside HTML as \\\":
{
  "title": "Short descriptive title",
  "type": "${visualType}",
  "concept": "One sentence: what concept this visual teaches",
  "html": "<!DOCTYPE html>..."
}`;

  type MsgContent = Parameters<typeof client.messages.create>[0]['messages'][0]['content'];
  const userContent: MsgContent = pdfBase64
    ? ([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt },
      ] as MsgContent)
    : prompt;

  try {
    const raw = await streamToText(client, {
      model,
      max_tokens: maxTokens,
      system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
      messages:   [{ role: 'user', content: userContent }],
    }, 'generateVisualComponents');

    const start = raw.indexOf('{');
    const end   = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return null;

    let parsed: VisualComponent;
    try   { parsed = JSON.parse(raw.slice(start, end + 1)) as VisualComponent; }
    catch { parsed = JSON.parse(repairJson(raw.slice(start))) as VisualComponent; }

    return parsed?.html && parsed?.title ? parsed : null;
  } catch {
    return null; // individual failures are non-fatal — other components still show
  }
}

/**
 * Generates 4 visual learning components in parallel.
 * Each component is its own bounded API call (~5–15s each) so no single
 * request can hit Netlify's 50-second edge-function wall-clock limit.
 * Total wall time: ~10–20s regardless of document size.
 */
export async function generateVisualComponents(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
): Promise<VisualSet> {
  // Text path: 4 standard visuals (Haiku) + 1 simulation (Sonnet), all parallel.
  // PDF-only path: limit to 2 standard + 1 simulation to avoid large concurrent uploads.
  const types: VisualComponent['type'][] = contentText
    ? ['diagram', 'chart', 'timeline', 'process', 'simulation']
    : ['diagram', 'chart', 'simulation'];

  const results = await Promise.allSettled(
    types.map(type => generateOneVisual(topic, contentText, pdfBase64, type)),
  );

  const components = results
    .filter((r): r is PromiseFulfilledResult<VisualComponent> =>
      r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

  if (components.length === 0) {
    throw new Error('Failed to generate visual components. Please retry.');
  }

  return { components };
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
