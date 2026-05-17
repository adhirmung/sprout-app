import Anthropic from '@anthropic-ai/sdk';
import type { LearnerProfile } from './types';

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
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      onChunk(event.delta.text);
    }
  }
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

export interface TopicReading {
  topicId:       string;
  title:         string;
  paragraphs:    string[];
  keyTerms:      TopicKeyTerm[];
  whyItMatters:  string;
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

  const msg = await client.messages.create({
    model:    'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    system:   'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages: [{ role: 'user', content: userContent }],
  });

  const raw   = msg.content.find(b => b.type === 'text')?.text ?? '';
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

  const msg = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw   = msg.content.find(b => b.type === 'text')?.text ?? '';
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

  const msg = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw   = msg.content.find(b => b.type === 'text')?.text ?? '';
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
): Promise<ContentMap> {
  const client = getClient();
  const hasPdf = !!pdfBase64;

  const prompt = `You are an expert educational content analyst. Analyze this document and extract a structured learning map.

Topic: "${topic}"
${sourceBlock(contentText, hasPdf)}

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

  const msg = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: userContent }],
  });

  const raw   = msg.content.find(b => b.type === 'text')?.text ?? '';
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
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
  contentMap:  ContentMap,
): Promise<DocumentReading> {
  const client = getClient();
  const hasPdf = !!pdfBase64;

  const mapOutline = contentMap.topics.map(t =>
    `- id: "${t.id}" | "${t.title}": ${t.subtopics.map(s => s.title).join(', ')}`
  ).join('\n');

  const prompt = `You are an expert educational content writer. Write a detailed study guide for each topic listed below.

Topic: "${topic}"
${sourceBlock(contentText, hasPdf)}

TOPICS TO COVER (use these exact topicId values):
${mapOutline}

For EACH topic write:
1. paragraphs: 2–3 paragraphs (4–6 sentences each). Each paragraph covers a distinct subtopic or aspect. Use specific facts, figures, and named concepts from the source. Grade 9–10 reading level — clear and precise.
2. keyTerms: 3–5 important terms from this topic with concise, accurate definitions (1–2 sentences each).
3. whyItMatters: one sentence explaining why this topic is significant in the broader context.

Rules:
- Ground everything in the source — no invented facts
- Key terms must appear naturally in the paragraphs
- Cover every subtopic listed for each topic across the paragraphs

Return ONLY valid JSON — no markdown fences:
{
  "topics": [
    {
      "topicId": "t1",
      "title": "...",
      "paragraphs": ["paragraph 1...", "paragraph 2...", "paragraph 3..."],
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

  const msg = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: userContent }],
  });

  const raw   = msg.content.find(b => b.type === 'text')?.text ?? '';
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
