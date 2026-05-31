import { FunctionCallingConfigMode, GoogleGenAI, Type } from '@google/genai';
import type { LearnerProfile } from './types';
import { dbLogUsage } from './supabase';

// ── Model config ──────────────────────────────────────────────
// Netlify Edge Functions have a hard 26s wall-clock timeout.
// All generation calls use streaming (generateContentStream) so the
// edge function resolves as soon as Gemini sends the first SSE chunk.
// thinkingBudget:0 disables thinking on gemini-2.5-flash, keeping
// first-token latency to ~2-5s — safely within the 26s limit.
const SMART_MODEL = 'gemini-2.5-flash';
const FAST_MODEL  = 'gemini-2.5-flash';

// ── Current user (set once on auth, used for usage logging) ───
let _currentUserId: string | null = null;
export function setCurrentUserId(id: string | null): void { _currentUserId = id; }

// ── API key helpers ───────────────────────────────────────────

const USE_PROXY = import.meta.env.VITE_USE_PROXY === 'true';

export function getApiKey(): string {
  return (import.meta.env.VITE_GEMINI_API_KEY as string) || localStorage.getItem('sprout:geminiKey') || '';
}
export function hasApiKey(): boolean { return !!getApiKey() || USE_PROXY; }
export function saveApiKey(key: string) { localStorage.setItem('sprout:geminiKey', key); }

function getClient(): GoogleGenAI {
  if (USE_PROXY) {
    // Key lives server-side in Netlify env — never in the browser bundle
    return new GoogleGenAI({
      apiKey:      'via-proxy',
      httpOptions: { baseUrl: `${window.location.origin}/api/gemini` },
    });
  }
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');
  return new GoogleGenAI({ apiKey });
}

// ── Part helpers ──────────────────────────────────────────────

type Part = { text: string } | { inlineData: { data: string; mimeType: string } };

function pdfPart(base64: string): Part {
  return { inlineData: { data: base64, mimeType: 'application/pdf' } };
}

function imagePart(base64: string, mimeType = 'image/jpeg'): Part {
  return { inlineData: { data: base64, mimeType } };
}

function textPart(text: string): Part {
  return { text };
}

// ── Core generation helper ────────────────────────────────────
// Non-streaming for all JSON tasks (streaming only needed for chat).
// Logs token usage fire-and-forget.

// Uses streaming internally so chunks keep the Netlify edge-function
// connection alive — preventing the 26s timeout on slow responses.
// All callers continue to receive the full accumulated text string.
async function generateText(
  model:             string,
  systemInstruction: string,
  parts:             Part[],
  maxOutputTokens:   number,
  fnName:            string,
): Promise<string> {
  const client = getClient();

  const stream = await client.models.generateContentStream({
    model,
    contents: [{ role: 'user', parts }],
    config:   {
      systemInstruction,
      maxOutputTokens,
      temperature:    0.1,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  let text      = '';
  let inTokens  = 0;
  let outTokens = 0;

  for await (const chunk of stream) {
    if (chunk.text) text += chunk.text;
    if (chunk.usageMetadata) {
      inTokens  = chunk.usageMetadata.promptTokenCount     ?? inTokens;
      outTokens = chunk.usageMetadata.candidatesTokenCount ?? outTokens;
    }
  }

  void dbLogUsage(_currentUserId, fnName, model, inTokens, outTokens);
  return text;
}

// ── JSON repair helper ────────────────────────────────────────
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

function extractJson(raw: string): string {
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found in response');
  return raw.slice(start, end + 1);
}

function parseJson<T>(raw: string): T {
  const slice = extractJson(raw);
  try   { return JSON.parse(slice) as T; }
  catch { return JSON.parse(repairJson(slice)) as T; }
}

// ── Source block helper ───────────────────────────────────────
function sourceBlock(
  contentText: string | null,
  hasPdf:      boolean,
  hasImages?:  boolean,
  pages?:      string,
): string {
  if (hasImages) return 'The images attached above are the primary source material. Analyse them carefully.';
  if (hasPdf) {
    const pageNote = pages ? ` Focus ONLY on pages ${pages} of the document.` : '';
    return `The full document (text + images) is attached above.${pageNote}`;
  }
  return contentText
    ? `SOURCE CONTENT — use ONLY facts from this text:\n"""\n${contentText.slice(0, 40_000)}\n"""`
    : '(No source — use accurate general knowledge for this topic.)';
}

// ── Chat helpers ─────────────────────────────────────────────

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export function buildChatSystemPrompt(
  topic:         string,
  sourceContent: string | null,
  cardDescription: string,
  profile:       LearnerProfile | null,
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
  history:      ChatMessage[],
  systemPrompt: string,
  onChunk:      (text: string) => void,
): Promise<void> {
  const client = getClient();

  // Convert history to Gemini format (assistant → model)
  const contents = history.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const stream = await client.models.generateContentStream({
    model:    FAST_MODEL,
    contents,
    config:   { systemInstruction: systemPrompt, maxOutputTokens: 512, temperature: 0.7 },
  });

  let inputTokens  = 0;
  let outputTokens = 0;

  for await (const chunk of stream) {
    const t = chunk.text ?? '';
    if (t) onChunk(t);
    if (chunk.usageMetadata) {
      inputTokens  = chunk.usageMetadata.promptTokenCount     ?? inputTokens;
      outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
    }
  }

  void dbLogUsage(_currentUserId, 'streamCardChat', FAST_MODEL, inputTokens, outputTokens);
}

// ── PDF extractor ─────────────────────────────────────────────
// Streams the full text extraction from a PDF.
// Returns the extracted text string directly.

export async function extractPdfContent(
  pdfBase64: string,
  onChunk?:  (accumulated: string, newChunk: string) => void,
): Promise<string> {
  const client = getClient();

  const prompt = `Extract the COMPLETE text content of this document. Include every heading, subheading, body paragraph, and table.
- Use # for main headings, ## for subheadings, ### for smaller headings
- Reproduce ALL body text verbatim — do not skip, summarise, or paraphrase any written content
- DATA TABLES: recreate as Markdown tables (| col | col |\n|---|---|\n| val | val |)
- DIAGRAMS & ILLUSTRATIONS: skip entirely — do NOT describe, caption, or transcribe decorative images, clipart, or anatomy diagrams
- DIAGRAM LABELS: if a diagram has labelled parts (e.g. arrows pointing to parts of an organ), extract ONLY the text labels as a simple bullet list — do not describe the diagram itself
- Do NOT add commentary, notes, or your own interpretation`;

  const stream = await client.models.generateContentStream({
    model:    SMART_MODEL,
    contents: [{ role: 'user', parts: [pdfPart(pdfBase64), textPart(prompt)] }],
    config:   {
      systemInstruction: 'You are a precise document transcription assistant. Reproduce every word of the document faithfully.',
      maxOutputTokens:   32000,
      temperature:       0.0,
      thinkingConfig:    { thinkingBudget: 0 },
    },
  });

  let accumulated  = '';
  let inputTokens  = 0;
  let outputTokens = 0;

  for await (const chunk of stream) {
    const t = chunk.text ?? '';
    if (t) {
      accumulated += t;
      onChunk?.(accumulated, t);
    }
    if (chunk.usageMetadata) {
      inputTokens  = chunk.usageMetadata.promptTokenCount     ?? inputTokens;
      outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
    }
  }

  void dbLogUsage(_currentUserId, 'extractPdfContent', SMART_MODEL, inputTokens, outputTokens);
  return accumulated;
}

// ── Types ─────────────────────────────────────────────────────

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

export interface TopicKeyTerm {
  term:       string;
  definition: string;
}

export interface SubtopicQuiz {
  question:    string;
  options:     string[];
  answer:      number;
  explanation: string;
}

export interface TopicReading {
  topicId:       string;
  title:         string;
  subtopics:     { title: string; content?: string; bullets?: string[]; quiz?: SubtopicQuiz }[];
  keyTerms:      TopicKeyTerm[];
  whyItMatters?: string;
}

export interface DocumentReading {
  topics: TopicReading[];
}

export interface FeedAudit {
  coverageScore: number;
  accuracyScore: number;
  depthScore:    number;
  overallScore:  number;
  missedTopics:  string[];
}

export interface FeedResult {
  cards: FeedCard[];
  audit: FeedAudit | null;
}

export type FeedCard =
  | { type: 'summary';        title: string; points: string[] }
  | { type: 'flashcard';      question: string; answer: string; topic?: string }
  | { type: 'concept';        title: string; explanation: string; example: string; analogy: string; keyTerms: { term: string; definition: string }[] }
  | { type: 'worked_example'; title: string; problem: string; steps: { label: string; content: string }[]; insight: string }
  | { type: 'fill_blank';     sentence: string; blanks: string[]; hint: string }
  | { type: 'diagram';        title: string; center: string; nodes: { label: string; emoji: string }[] }
  | { type: 'animation';      title: string; steps: { icon: string; title: string; description: string }[] }
  | { type: 'quiz';           question: string; options: string[]; correctIndex: number; explanation: string };

export interface ChartData {
  chartType: 'bar' | 'line' | 'pie';
  xLabel?:   string;
  yLabel?:   string;
  items:     { name: string; value: number }[];
}

export interface DiagramData {
  nodes: { id: string; label: string; subtitle?: string; nodeType?: string }[];
  edges: { from: string; to: string }[];
}

export interface TimelineData {
  events: { year: string; title: string; description: string }[];
}

export interface ProcessData {
  steps: { icon: string; title: string; description: string }[];
}

export interface SimulationPayload {
  domain:              'math' | 'graphing' | 'biology';
  title:               string;
  concept:             string;
  latexFormulas?:      string[];
  graphingEquation?:   string;
  simulationVariables?: { simulationType: 'circulatory' | 'mitosis' | 'neural' | 'ecosystem' };
}

export interface VisualComponent {
  type:               'diagram' | 'chart' | 'timeline' | 'process' | 'interactive' | 'simulation' | 'dynamic';
  title:              string;
  concept:            string;
  chartData?:         ChartData;
  diagramData?:       DiagramData;
  timelineData?:      TimelineData;
  processData?:       ProcessData;
  simulationPayload?: SimulationPayload;
  html?:              string;
}

export interface VisualSet {
  components: VisualComponent[];
}


export interface PracticeQuestion {
  id:            string;
  type:          'mcq' | 'fill' | 'written';
  topicId:       string;
  topicTitle:    string;
  question:      string;
  options?:      string[];
  answer?:       number;
  blank?:        string;
  sampleAnswer?: string;
  explanation:   string;
}

export interface PracticeQuiz {
  questions: PracticeQuestion[];
}

export interface WrittenEvaluation {
  score:    0 | 1 | 2;
  feedback: string;
}

export interface ParagraphQuestion {
  question:    string;
  options:     string[];
  answer:      number;
  explanation: string;
}

export interface ParagraphQuiz {
  questions: ParagraphQuestion[];
}

// ── Feed prompts ──────────────────────────────────────────────

function buildActivitiesPrompt(topic: string, contentText: string | null, hasPdf: boolean, hasImages = false): string {
  return `You are an expert educational content designer. Generate a rich, sequenced learning feed for: "${topic}"
${sourceBlock(contentText, hasPdf, hasImages)}

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
- quiz: correctIndex is 0-based; options must have exactly 3 items
- concept: keyTerms must have 2-4 items; analogy must be a fresh real-world comparison
- animation: steps must have exactly 4 items, each with icon (single emoji), title, description

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "cards": [
    { "type": "summary",        "title": "...", "points": ["...", "...", "..."] },
    { "type": "flashcard",      "question": "...", "answer": "..." },
    { "type": "concept",        "title": "...", "explanation": "...", "example": "...", "analogy": "...", "keyTerms": [{ "term": "...", "definition": "..." }] },
    { "type": "worked_example", "title": "...", "problem": "...", "steps": [{ "label": "Step 1", "content": "..." }], "insight": "..." },
    { "type": "fill_blank",     "sentence": "The ___ is responsible for ___.", "blanks": ["term1", "term2"], "hint": "..." },
    { "type": "animation",      "title": "...", "steps": [{ "icon": "🔬", "title": "...", "description": "..." }] },
    { "type": "quiz",           "question": "...", "options": ["A", "B", "C"], "correctIndex": 0, "explanation": "..." }
  ],
  "audit": {
    "coverageScore": <0-100>,
    "accuracyScore":  <0-100>,
    "depthScore":     <0-100>,
    "overallScore":   <0-100>,
    "missedTopics":   []
  }
}`;
}

function buildFlashcardsOnlyPrompt(topic: string, contentText: string | null, hasPdf: boolean, count = 20, hasImages = false, pages?: string): string {
  return `You are an expert educator. Generate exactly ${count} flashcards covering "${topic}" comprehensively.
${sourceBlock(contentText, hasPdf, hasImages, pages)}

Rules:
- Cover every major concept, person, date, and process in the source
- Questions should be specific and unambiguous
- Answers: 1–3 precise sentences with exact facts
- For each card, set "topic" to the chapter or section it belongs to (short label, e.g. "Cell Division" or "World War II Causes")

Return ONLY valid JSON — no markdown:
{ "cards": [{ "type": "flashcard", "question": "...", "answer": "...", "topic": "..." }], "audit": null }`;
}

function buildQuizOnlyPrompt(topic: string, contentText: string | null, hasPdf: boolean, hasImages = false, pages?: string): string {
  return `You are an expert educator. Generate 15 multiple-choice quiz questions about "${topic}".
${sourceBlock(contentText, hasPdf, hasImages, pages)}

Rules:
- Spread questions evenly across all major topics
- 3 options each, exactly one correct (0-based correctIndex)
- Distractors must be plausible, not obviously wrong

Return ONLY valid JSON — no markdown:
{ "cards": [{ "type": "quiz", "question": "...", "options": ["A","B","C"], "correctIndex": 0, "explanation": "..." }], "audit": null }`;
}

// ── Feed generator ────────────────────────────────────────────

export async function generateFeed(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
  mode:        'activities' | 'flashcards' | 'quiz' = 'activities',
  images?:     string[],
  pages?:      string,
): Promise<FeedResult> {
  const hasImages = (images?.length ?? 0) > 0;

  // Scale flashcard count by document length so larger docs get fuller coverage
  const flashcardCount = (() => {
    if (mode !== 'flashcards') return 20;
    const len = contentText?.length ?? 0;
    if (len >= 25_000) return 40;
    if (len >= 8_000)  return 30;
    if (len > 0)       return 20;
    if (hasImages)     return images!.length >= 5 ? 30 : 20;
    return pdfBase64 ? 30 : 20;
  })();

  const promptFn = mode === 'flashcards'
    ? (t: string, c: string | null, pdf: boolean) =>
        buildFlashcardsOnlyPrompt(t, c, pdf, flashcardCount, hasImages, pages)
    : mode === 'quiz'
    ? (t: string, c: string | null, pdf: boolean) =>
        buildQuizOnlyPrompt(t, c, pdf, hasImages, pages)
    : (t: string, c: string | null, pdf: boolean) =>
        buildActivitiesPrompt(t, c, pdf, hasImages);

  const maxTokens = mode === 'flashcards' ? 16000 : mode === 'quiz' ? 8000 : 16000;

  const parts: Part[] = pdfBase64
    ? [pdfPart(pdfBase64), textPart(promptFn(topic, contentText, true))]
    : hasImages
    ? [...images!.map(b64 => imagePart(b64)), textPart(promptFn(topic, null, true))]
    : [textPart(promptFn(topic, contentText, false))];

  const raw = await generateText(
    FAST_MODEL,
    'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    parts,
    maxTokens,
    'generateFeed',
  );

  const parsed = parseJson<{ cards: FeedCard[]; audit?: FeedAudit }>(raw);
  if (!Array.isArray(parsed.cards) || parsed.cards.length === 0) {
    throw new Error('Invalid response. Please retry.');
  }
  return { cards: parsed.cards, audit: parsed.audit ?? null };
}

// ── Post-booster re-audit ─────────────────────────────────────

export async function reauditCards(
  topic:       string,
  cards:       FeedCard[],
  contentText: string | null,
): Promise<FeedAudit | null> {
  if (cards.length === 0) return null;

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

  try {
    const raw = await generateText(FAST_MODEL, 'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.', [textPart(prompt)], 300, 'reauditCards');
    const parsed = parseJson<FeedAudit>(raw);
    return typeof parsed.coverageScore === 'number' ? parsed : null;
  } catch { return null; }
}

// ── Booster pass ──────────────────────────────────────────────

export async function generateBoosterCards(
  topic:        string,
  missedTopics: string[],
  contentText:  string | null,
): Promise<FeedCard[]> {
  if (missedTopics.length === 0) return [];

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

Return ONLY valid JSON — no markdown fences:
{ "cards": [{ "type": "flashcard", "question": "...", "answer": "..." }] }`;

  try {
    const raw = await generateText(FAST_MODEL, 'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.', [textPart(prompt)], 1500, 'generateBoosterCards');
    const parsed = parseJson<{ cards: FeedCard[] }>(raw);
    return Array.isArray(parsed.cards) ? parsed.cards : [];
  } catch { return []; }
}

// ── Content map generator ─────────────────────────────────────

// ── Heading parser ────────────────────────────────────────────
// Walks the markdown produced by extractPdfContent and extracts every
// heading (# / ## / ###) together with a short snippet of the body text
// that follows it.  This gives us the authentic document structure so
// generateContentMap never has to "invent" topics.

interface ParsedSection {
  level:   1 | 2 | 3;
  title:   string;
  snippet: string; // first ~200 chars of body text under this heading
}

function parseSectionsFromMarkdown(text: string): ParsedSection[] {
  const lines   = text.split('\n');
  const sections: ParsedSection[] = [];
  let level     = 0 as 0 | 1 | 2 | 3;
  let title     = '';
  let body: string[] = [];

  const flush = () => {
    if (level > 0 && title) {
      const snippet = body
        .filter(l => l.trim() && !l.startsWith('#'))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
      sections.push({ level: level as 1 | 2 | 3, title, snippet });
    }
    body = [];
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+)$/);
    if (m) {
      flush();
      level = Math.min(m[1].length, 3) as 1 | 2 | 3;
      title = m[2].trim();
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

// ── Heading-based map builder ─────────────────────────────────
// The model's only job here is writing 1-sentence summaries.
// Topic structure is determined by the document's own headings.

async function generateMapFromHeadings(
  topic:    string,
  sections: ParsedSection[],
): Promise<ContentMap> {
  // Build a compact listing for the summaries call — deduplicate repeated
  // sub-section titles (e.g. "Translation" × 20) so the model isn't swamped
  // with identical lines.  The full sections array still drives content-map
  // assembly below.
  const seenInListing = new Set<string>();
  const listing = sections.map(s => {
    const indent = s.level === 1 ? '' : '  ';
    const bullet = s.level === 1 ? '●' : '○';
    const hint   = s.snippet ? ` — ${s.snippet.slice(0, 120)}` : '';
    const line   = `${indent}${bullet} ${s.title}${hint}`;
    // For recurring sub-section titles, show only the first occurrence in the
    // listing; repeated occurrences add a count hint instead.
    const key = `${s.level}:${s.title}`;
    if (seenInListing.has(key)) return null; // will be filtered out
    seenInListing.add(key);
    return line;
  }).filter(Boolean).join('\n');

  const prompt = `Document: "${topic}"

These are the EXACT section headings from the document (● = main section, ○ = sub-section).
Note: recurring sub-section titles (e.g. "Translation", "Purport") appear under EACH main section even though listed once here.
${listing}

Your task:
1. Write a 2-sentence synthesis describing the overall document.
2. Write ONE short sentence summarising each UNIQUE heading shown above.

Rules:
- Every key in "summaries" must match a heading title above exactly.
- Keep every summary to 1 sentence (max 20 words).

Return ONLY valid JSON — no markdown fences:
{
  "synthesis": "Two sentences about the document.",
  "summaries": {
    "Exact Section Title": "One-sentence summary.",
    "Another Section Title": "One-sentence summary."
  }
}`;

  const raw = await generateText(
    SMART_MODEL,
    'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    [textPart(prompt)],
    16000,
    'generateContentMap',
  );

  const parsed = parseJson<{ synthesis: string; summaries: Record<string, string> }>(raw);
  const summaries = parsed.summaries ?? {};

  // Assemble ContentMap from the parsed headings
  const topics: Topic[] = [];
  let topicIdx = 0;

  for (const section of sections) {
    const summary = summaries[section.title] ?? `Covers ${section.title}.`;

    if (section.level === 1) {
      topicIdx++;
      topics.push({ id: `t${topicIdx}`, title: section.title, summary, subtopics: [] });
    } else {
      // level 2 or 3 — attach to the last topic, or promote to topic if none yet
      if (topics.length === 0) {
        topicIdx++;
        topics.push({ id: `t${topicIdx}`, title: section.title, summary, subtopics: [] });
      } else {
        const parent = topics[topics.length - 1];
        parent.subtopics.push({
          id:      `${parent.id}s${parent.subtopics.length + 1}`,
          title:   section.title,
          summary,
        });
      }
    }
  }

  return { synthesis: parsed.synthesis ?? '', topics };
}

// ── Model-driven map builder (fallback) ───────────────────────
// Used for essays / articles / any doc that lacks markdown headings.

async function generateMapFromModel(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
  gapFill?:    string[],
  images?:     string[],
): Promise<ContentMap> {
  const hasPdf    = !!pdfBase64;
  const hasImages = (images?.length ?? 0) > 0;

  const gapBlock = gapFill?.length
    ? `\n\nAlso include these missing concepts:\n${gapFill.map((g, i) => `${i + 1}. ${g}`).join('\n')}`
    : '';

  const mapSource = hasPdf
    ? 'The full document (text + images) is attached above.'
    : hasImages
    ? 'The images attached above contain the source material. Analyse all of them.'
    : contentText
      ? `SOURCE CONTENT:\n"""\n${contentText.slice(0, 120_000)}\n"""`
      : '(No source content provided.)';

  const prompt = `Analyse this document and create a structured learning map.

Topic: "${topic}"
${mapSource}${gapBlock}

Identify every distinct section or theme. Cover beginning, middle, and end.
Each topic: 2–3 subtopics. Summaries: 1 sentence each.

Return ONLY valid JSON — no markdown fences:
{
  "synthesis": "Two sentences about this document.",
  "topics": [
    {
      "id": "t1",
      "title": "Topic Name",
      "summary": "One sentence.",
      "subtopics": [
        { "id": "t1s1", "title": "Subtopic", "summary": "One sentence." }
      ]
    }
  ]
}`;

  const parts: Part[] = pdfBase64
    ? [pdfPart(pdfBase64), textPart(prompt)]
    : hasImages
    ? [...images!.map(b64 => imagePart(b64)), textPart(prompt)]
    : [textPart(prompt)];

  const raw = await generateText(
    SMART_MODEL,
    'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    parts,
    12000,
    'generateContentMap',
  );

  const parsed = parseJson<ContentMap>(raw);
  if (!parsed.synthesis || !Array.isArray(parsed.topics) || parsed.topics.length === 0) {
    throw new Error('Invalid topic map response. Please retry.');
  }
  return parsed;
}

// ── Two-pass streaming TOC scanner ───────────────────────────
//
// Pass 1 (global, non-streaming, ~5–10s):
//   Model reads the whole PDF and returns the major themes, which named
//   items belong to each theme, and worksheet/activity headings to exclude.
//   This gives Pass 2 the global context it needs to correctly group items.
//
// Pass 2 (streaming, anchored, ~10–15s):
//   Model scans sequentially, but now knows the theme hierarchy.
//   MERCURY → SUBTOPIC of INNER PLANETS (not a new TOPIC).
//   RECORD YOUR FINDINGS → excluded (worksheet, not content).
//   Output: one labelled line per structural element, streamed live.
//
// Both passes are separate API calls, each well within Netlify's 26s limit.

// ── Types ──────────────────────────────────────────────────────

interface TOCEntry {
  type:    'synthesis' | 'topic' | 'subtopic';
  title:   string;
  summary: string;
}

interface TOCTheme {
  title:   string;
  members: string[]; // named items that belong to this theme as subtopics
}

interface TOCThemeMap {
  subject: string;
  themes:  TOCTheme[];
  exclude: string[]; // worksheet/activity headings to suppress
}

// ── TOC line parser ────────────────────────────────────────────

function parseTOCLines(raw: string): TOCEntry[] {
  const entries: TOCEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    let prefix: TOCEntry['type'] | null = null;
    let rest = '';

    if (trimmed.startsWith('SYNTHESIS:')) { prefix = 'synthesis'; rest = trimmed.slice('SYNTHESIS:'.length).trim(); }
    else if (trimmed.startsWith('TOPIC:'))    { prefix = 'topic';     rest = trimmed.slice('TOPIC:'.length).trim(); }
    else if (trimmed.startsWith('SUBTOPIC:')) { prefix = 'subtopic';  rest = trimmed.slice('SUBTOPIC:'.length).trim(); }

    if (!prefix || !rest) continue;

    const pipe    = rest.indexOf(' | ');
    const title   = pipe >= 0 ? rest.slice(0, pipe).trim() : rest.trim();
    const summary = pipe >= 0 ? rest.slice(pipe + 3).trim() : '';
    if (title) entries.push({ type: prefix, title, summary });
  }
  return entries;
}

// ── ContentMap assembler ───────────────────────────────────────

function assembleTOC(entries: TOCEntry[]): ContentMap {
  let synthesis = '';
  const topics: Topic[] = [];
  let topicIdx = 0;
  const seen   = new Set<string>(); // deduplicate repeated topic headings

  for (const entry of entries) {
    if (entry.type === 'synthesis') {
      synthesis = entry.title + (entry.summary ? ' ' + entry.summary : '');
      continue;
    }

    if (entry.type === 'topic') {
      const key = entry.title.toLowerCase().trim();
      if (seen.has(key)) continue; // duplicate heading — skip
      seen.add(key);

      // Elaborating-subtitle guard:
      // If this topic title starts with the full preceding topic title
      // word-for-word AND has 6+ words, it's a descriptive sub-label
      // (e.g. "PREPOSITIONS USUALLY REFER TO PLACE...") — demote to subtopic.
      if (topics.length > 0) {
        const prev      = topics[topics.length - 1];
        const prevLow   = prev.title.toLowerCase();
        const curLow    = entry.title.toLowerCase();
        const wordCount = entry.title.trim().split(/\s+/).length;
        if (wordCount >= 6 && curLow.startsWith(prevLow + ' ')) {
          prev.subtopics.push({
            id:      `t${topicIdx}s${prev.subtopics.length + 1}`,
            title:   entry.title,
            summary: entry.summary || `Covers ${entry.title}.`,
          });
          continue;
        }
      }

      topicIdx++;
      topics.push({
        id:        `t${topicIdx}`,
        title:     entry.title,
        summary:   entry.summary || `Covers ${entry.title}.`,
        subtopics: [],
      });
    } else if (entry.type === 'subtopic' && topics.length > 0) {
      const parent = topics[topics.length - 1];
      parent.subtopics.push({
        id:      `t${topicIdx}s${parent.subtopics.length + 1}`,
        title:   entry.title,
        summary: entry.summary || `Covers ${entry.title}.`,
      });
    }
  }

  return { synthesis, topics };
}

// ── Pass 1 — Global theme extractor ───────────────────────────
// Non-streaming, fast (~5–10s). Reads the whole PDF and returns the
// logical theme hierarchy so Pass 2 can make correct local decisions.

async function extractTOCThemes(
  topic:     string,
  pdfBase64: string,
): Promise<TOCThemeMap> {
  const client = getClient();

  const prompt = `Read this document ("${topic}") carefully and identify its logical content structure.

Return a JSON object with:
1. "subject"  — the subject/title of this document (e.g. "Earth and Beyond", "English Grammar Handbook")
2. "themes"   — the major content themes/chapters in reading order (5–15 items).
                 For each theme list any named items that belong to it as sub-sections ("members").
                 Examples of members: planet names under "Inner Planets", pronoun types under "Pronouns",
                 punctuation marks under "Punctuation", figures of speech under "Figures of Speech".
                 For grammar comparison sections (e.g. "Degrees of Comparison"), list the degree forms
                 as members: ["Positive Degree", "Comparative Degree", "Superlative Degree"].
                 Leave "members" as [] only if the theme genuinely has no named sub-sections.
3. "exclude"  — headings that are worksheet activities or instructions, NOT content
                 (e.g. "Record Your Findings", "Discuss the Image Below", "Revision", "Activity", "Extension").

Return ONLY valid JSON — no markdown:
{
  "subject": "Document subject",
  "themes": [
    { "title": "Theme Title", "members": ["Named sub-item 1", "Named sub-item 2"] },
    { "title": "Theme with no sub-items", "members": [] }
  ],
  "exclude": ["Worksheet heading 1", "Activity heading 2"]
}`;

  // Stream instead of blocking generateContent — the proxy's fetch() resolves
  // on the first SSE chunk so Netlify's 26 s edge-function limit is never hit,
  // even for large PDFs that take Gemini 30–40 s to process.
  const stream = await client.models.generateContentStream({
    model:    SMART_MODEL,
    contents: [{ role: 'user', parts: [pdfPart(pdfBase64), textPart(prompt)] }],
    config:   {
      systemInstruction: 'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
      maxOutputTokens:   4000,
      temperature:       0.0,
      thinkingConfig:    { thinkingBudget: 0 },
    },
  });

  let raw      = '';
  let inTokens = 0;
  let outTokens = 0;
  for await (const chunk of stream) {
    if (chunk.text) raw += chunk.text;
    if (chunk.usageMetadata) {
      inTokens  = chunk.usageMetadata.promptTokenCount     ?? inTokens;
      outTokens = chunk.usageMetadata.candidatesTokenCount ?? outTokens;
    }
  }
  void dbLogUsage(_currentUserId, 'extractTOCThemes', SMART_MODEL, inTokens, outTokens);

  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    // Fallback — return a minimal theme map so Pass 2 still runs
    return { subject: topic, themes: [], exclude: [] };
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as TOCThemeMap;
    return {
      subject: parsed.subject ?? topic,
      themes:  Array.isArray(parsed.themes)  ? parsed.themes  : [],
      exclude: Array.isArray(parsed.exclude) ? parsed.exclude : [],
    };
  } catch {
    return { subject: topic, themes: [], exclude: [] };
  }
}

// ── Pass 2 — Anchored streaming scan ──────────────────────────
// Streams the PDF with the theme hierarchy from Pass 1 as context.
// The model now knows which items are subtopics of which theme,
// and which headings are worksheet activities to skip.

async function buildStreamingTOC(
  topic:     string,
  pdfBase64: string,
  themeMap?: TOCThemeMap,
): Promise<ContentMap | null> {
  const client = getClient();

  // Build theme block for the prompt
  const subject = themeMap?.subject ?? topic;
  const themes  = themeMap?.themes  ?? [];
  const exclude = themeMap?.exclude ?? [];

  const themeBlock = themes.length
    ? `The document has these major themes (in order):\n` +
      themes.map((t, i) => {
        const members = t.members?.length
          ? `  members → ${t.members.join(', ')}`
          : '  (no named sub-items — emit TOPIC only)';
        return `  ${i + 1}. ${t.title}\n${members}`;
      }).join('\n')
    : '';

  const excludeBlock = exclude.length
    ? `\nWorksheet/activity sections — emit NOTHING for these:\n` +
      exclude.map(e => `  ✗ ${e}`).join('\n')
    : '';

  const anchoredRules = themes.length ? `
Classification rules (anchored to the theme list above):
- TOPIC  → emit when you first encounter each major theme. Use the exact theme title.
- SUBTOPIC → emit for every named member listed under the current theme.
  Example: theme "Inner Planets" lists Mercury, Venus, Earth, Mars as members →
    when you see the Mercury heading emit:  SUBTOPIC: Mercury | …
    when you see Venus emit:               SUBTOPIC: Venus | …   (etc.)
- Worksheet/activity headings in the exclude list → emit NOTHING
- Body text, bullet points, tables, examples → emit NOTHING
- Same heading appearing more than once → emit only the first occurrence
- Once inside a SUBTOPIC, all nested content is silence` : `
Classification rules:
- TOPIC = a standalone major chapter or section
- SUBTOPIC = the FIRST level of named sub-sections within the current topic
  (lettered: A. B. C., numbered: 1. 2. 3., named categories, grammar table column headers)
- Body text, rules, examples, nested items → emit NOTHING
- Same heading appearing more than once → emit only the first occurrence
- Once inside a SUBTOPIC, all nested content is silence`;

  const prompt = `Scan the document "${subject}" from start to finish and build a Table of Contents.

${themeBlock}${excludeBlock}

For each piece of text, emit exactly one line — or emit nothing:
  SYNTHESIS: [two sentences about the whole document]   ← once only, at the very start
  TOPIC: [exact title] | [one sentence summary]
  SUBTOPIC: [exact title] | [one sentence summary]
${anchoredRules}

Output one line per item, no blank lines, no other text. Begin scanning now:`;

  let accumulated  = '';
  let inputTokens  = 0;
  let outputTokens = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      accumulated  = '';
      inputTokens  = 0;
      outputTokens = 0;
      const stream = await client.models.generateContentStream({
        model:    SMART_MODEL,
        contents: [{ role: 'user', parts: [pdfPart(pdfBase64), textPart(prompt)] }],
        config:   {
          systemInstruction: 'Output ONLY SYNTHESIS:, TOPIC:, and SUBTOPIC: lines. No other text.',
          maxOutputTokens:   8000,
          temperature:       0.0,
          thinkingConfig:    { thinkingBudget: 0 },
        },
      });
      for await (const chunk of stream) {
        accumulated += chunk.text ?? '';
        if (chunk.usageMetadata) {
          inputTokens  = chunk.usageMetadata.promptTokenCount     ?? inputTokens;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
        }
      }
      break;
    } catch (err) {
      const msg         = String(err);
      const isRetryable = msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('timed out');
      if (!isRetryable || attempt === 3) throw err;
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }

  void dbLogUsage(_currentUserId, 'buildStreamingTOC', SMART_MODEL, inputTokens, outputTokens);

  const entries    = parseTOCLines(accumulated);
  const topicCount = entries.filter(e => e.type === 'topic').length;
  if (topicCount === 0) return null;

  return assembleTOC(entries);
}

// ── Heading-level normaliser ──────────────────────────────────
// Universal fix for documents with repeated section patterns.
//
// Problem: when a document has many identically-structured blocks
// (e.g. 20 scripture verses each with "Translation" + "Purport"),
// the heading extractor sometimes returns those recurring sub-titles
// at level 1 instead of level 2, producing a flat 60-topic list
// instead of 20 topics each with 2 subtopics.
//
// Heuristic: any heading title that appears at level 1 two or more
// times throughout the document is almost certainly a recurring
// sub-section (not a unique standalone chapter).  Reclassify it
// to level 2 so it nests correctly under its preceding unique topic.

function normaliseHeadingLevels(sections: ParsedSection[]): ParsedSection[] {
  // Count level-1 occurrences per title
  const freq = new Map<string, number>();
  for (const s of sections) {
    if (s.level === 1) freq.set(s.title, (freq.get(s.title) ?? 0) + 1);
  }
  // Titles appearing 2+ times at level 1 are recurring sub-sections
  const repeated = new Set(
    [...freq.entries()].filter(([, n]) => n >= 2).map(([t]) => t),
  );
  if (repeated.size === 0) return sections; // nothing to fix
  return sections.map(s =>
    s.level === 1 && repeated.has(s.title) ? { ...s, level: 2 as const } : s,
  );
}

// ── Text-only heading extractor (no PDF) ─────────────────────────
// Used when there is no PDF — extracts section structure from extracted
// text via a single JSON call. No streaming needed (no binary upload).

async function extractSectionHeadings(
  topic:       string,
  contentText: string,
): Promise<ParsedSection[]> {
  const prompt = `Document: "${topic}"

Document text:
"""
${contentText.slice(0, 80_000)}
"""

List EVERY named section heading and sub-section heading from this document, in the exact order they appear.

Rules:
- Include ALL sections — do not skip, merge, group, or rename any heading.
- Level 1 = a UNIQUE main section that identifies a distinct chapter or topic
  (appears only once, e.g. "Chapter 3", "TEXT 7", "The Solar System").
- Level 2 = a sub-section that appears WITHIN a main section.
  CRITICAL: if the same heading title (e.g. "Translation", "Purport",
  "Examples", "Summary", "Introduction") appears repeatedly under different
  main sections, it MUST be level 2 — never level 1.
- Copy the title text exactly as it appears in the document.

Return ONLY valid JSON — no markdown fences, no explanation:
{
  "headings": [
    { "level": 1, "title": "Exact Main Section Title" },
    { "level": 2, "title": "Exact Sub-section Title" }
  ]
}`;

  const raw = await generateText(
    SMART_MODEL,
    'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    [textPart(prompt)],
    4000,
    'extractSectionHeadings',
  );

  const parsed = parseJson<{ headings: { level: number; title: string }[] }>(raw);
  return (parsed.headings ?? []).map(h => ({
    level:   Math.min(Math.max(h.level ?? 1, 1), 3) as 1 | 2 | 3,
    title:   String(h.title ?? '').trim(),
    snippet: '',
  })).filter(h => h.title.length > 0);
}

// ── generateContentMap (public entry point) ───────────────────
// Three-path strategy:
//  1. Parse markdown headings from extracted text (instant, no API call).
//  2. PDF → single streaming JSON call: model outputs full ContentMap
//     using content understanding, not visual formatting heuristics.
//  3. Full model-driven map — last resort for unstructured docs with no PDF.

export async function generateContentMap(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
  gapFill?:    string[],
  images?:     string[],
): Promise<ContentMap> {
  const hasImages = (images?.length ?? 0) > 0;

  // ── Path 1: markdown heading parse (no API call) ──────────────
  // Only used when there is NO PDF and NO images — PDFs/images with visual
  // headings won't produce useful markdown from text extraction.
  if (!pdfBase64 && !hasImages) {
    const sections = contentText ? parseSectionsFromMarkdown(contentText) : [];
    if (sections.length > 0) {
      const h1Count    = sections.filter(s => s.level === 1).length;
      const levelled   = h1Count === 0
        ? sections.map(s => ({ ...s, level: 1 as const }))
        : sections;
      return generateMapFromHeadings(topic, normaliseHeadingLevels(levelled));
    }
  }

  // ── Path 2: two-pass streaming TOC scanner (PDF only) ────────
  if (pdfBase64) {
    const themeMap = await extractTOCThemes(topic, pdfBase64);
    const map      = await buildStreamingTOC(topic, pdfBase64, themeMap);
    if (map) return map;
  }

  // ── Path 2b: text-only heading extraction ─────────────────────
  if (!hasImages && contentText) {
    const headings = await extractSectionHeadings(topic, contentText);
    if (headings.length > 0) {
      const h1Count  = headings.filter(h => h.level === 1).length;
      const levelled = h1Count === 0
        ? headings.map(h => ({ ...h, level: 1 as const }))
        : headings;
      return generateMapFromHeadings(topic, normaliseHeadingLevels(levelled));
    }
  }

  // ── Path 3: model-driven map (images go directly here) ───────
  return generateMapFromModel(topic, contentText, pdfBase64, gapFill, images);
}

// ── Topic Bullets ─────────────────────────────────────────────
// Single-call replacement for the old multi-call streamCourseMaterial.
// Generates 2-3 bullet points per subtopic for ALL topics in one request.
// Cost: ~$0.004/session vs ~$0.03 for old approach.

export interface TopicBullets {
  topicId:   string;
  title:     string;
  subtopics: { title: string; bullets: string[] }[];
  keyTerms:  TopicKeyTerm[];
}

export async function generateTopicBullets(
  extractedText: string,
  contentMap:    ContentMap,
): Promise<TopicBullets[]> {
  const TEXT_LIMIT  = 120_000;
  const textSlice   = extractedText.slice(0, TEXT_LIMIT);

  const topicListing = contentMap.topics.map(t =>
    `Topic (id: "${t.id}"): "${t.title}"\n` +
    (t.subtopics.length > 0
      ? t.subtopics.map(s => `  - "${s.title}"`).join('\n')
      : '  (no subtopics — treat the topic itself as the single section)')
  ).join('\n\n');

  const prompt = `You are an expert educator creating concise study notes.

DOCUMENT TEXT:
${textSlice}

TOPIC STRUCTURE:
${topicListing}

TASK:
For EVERY topic and subtopic listed above, generate study bullets based solely on the document text.

Rules:
- 2–3 bullet points per subtopic. Each bullet is 1 clear, factual sentence.
- For topics with no subtopics, generate 2–3 bullets for the topic itself.
- keyTerms: 3–6 important terms per topic with a short definition (≤ 15 words).
- Use ONLY information present in the document text — do not invent or generalise.
- Preserve the exact topicId values from the structure above.

Return ONLY valid JSON — no markdown, no extra text:
{
  "topics": [
    {
      "topicId": "<exact id from structure>",
      "title": "<topic title>",
      "subtopics": [
        { "title": "<subtopic title>", "bullets": ["bullet 1", "bullet 2", "bullet 3"] }
      ],
      "keyTerms": [
        { "term": "Term", "definition": "Short definition" }
      ]
    }
  ]
}`;

  const raw = await generateText(
    SMART_MODEL,
    'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    [textPart(prompt)],
    8000,
    'generateTopicBullets',
  );

  const parsed = parseJson<{ topics: TopicBullets[] }>(raw);
  return Array.isArray(parsed.topics) ? parsed.topics : [];
}

// ── AI Summary (replaces old Read view) ───────────────────────
//
// Generates a creative, freely-structured summary of the document.
// If course material (notes) already exists it's used as the primary
// source — much richer than the raw text. Falls back to extracted text
// + content map when notes haven't been generated yet.
// Uses streaming so the summary appears word-by-word in the UI.

export async function generateAISummary(
  topic:          string,
  courseMaterial: DocumentReading | null,
  contentMap:     ContentMap | null,
  contentText:    string | null,
  onChunk:        (accumulated: string) => void,
): Promise<string> {
  // Build source block — prefer full notes, fall back to extracted text
  let sourceBlock: string;
  if (courseMaterial && courseMaterial.topics.length > 0) {
    sourceBlock = courseMaterial.topics.map(t =>
      `## ${t.title}${t.whyItMatters ? `\n_${t.whyItMatters}_` : ''}\n` +
      t.subtopics.map(s => `### ${s.title}\n${s.content ?? ''}`).join('\n\n')
    ).join('\n\n---\n\n');
  } else if (contentMap && contentText) {
    // No notes yet — use map structure + raw text slice
    const mapOutline = contentMap.topics.map(t =>
      `• ${t.title}: ${t.summary}\n${t.subtopics.map(s => `  – ${s.title}: ${s.summary}`).join('\n')}`
    ).join('\n');
    sourceBlock = `CONTENT OUTLINE:\n${mapOutline}\n\nSOURCE TEXT (first extract):\n${contentText.slice(0, 20_000)}`;
  } else if (contentText) {
    sourceBlock = contentText.slice(0, 25_000);
  } else {
    sourceBlock = contentMap
      ? contentMap.topics.map(t => `• ${t.title}: ${t.summary}`).join('\n')
      : '(No source available)';
  }

  const prompt = `You are a brilliant, creative educator. You've just studied comprehensive material on "${topic}" and your job is to write a summary that a student would actually WANT to read — not a rewrite, a re-imagining.

SOURCE MATERIAL:
${sourceBlock}

YOUR TASK:
Transform this content into something memorable, engaging, and genuinely fun. You have COMPLETE creative freedom on structure and format. Mix and match ideas like:
- A punchy TLDR that captures the whole subject in 2–3 sentences
- Unexpected analogies ("The nucleus is like the CEO of a company — it doesn't do the work, it just controls everything")
- "Did you know?" or "Here's the wild part…" callouts for fascinating facts
- Connecting ideas across topics in surprising ways
- A "Common Mistakes" or "Don't confuse these" section if relevant
- Write some sections like you're explaining to a friend over coffee
- Use emojis to give sections personality
- A "Golden Rules" or "Never Forget These" section at the end — the 5 things that will always come up

RULES:
- Cover ALL major concepts — don't skip any topic
- Use markdown: ## for sections, **bold** for key terms, *italic* for emphasis, > for callouts, - for bullets
- Make it feel alive — this is a highlight reel, not a textbook
- High school level but NOT dumbed down
- 600–1000 words`;

  const client = getClient();
  const stream = await client.models.generateContentStream({
    model:    SMART_MODEL,
    contents: [{ role: 'user', parts: [textPart(prompt)] }],
    config:   {
      systemInstruction: 'You are a creative, engaging educational writer. Use markdown freely. Make it fun.',
      maxOutputTokens:   4000,
      temperature:       0.8,
      thinkingConfig:    { thinkingBudget: 0 },
    },
  });

  let full     = '';
  let inTok    = 0;
  let outTok   = 0;
  for await (const chunk of stream) {
    const t = chunk.text ?? '';
    if (t) { full += t; onChunk(full); }
    if (chunk.usageMetadata) {
      inTok  = chunk.usageMetadata.promptTokenCount     ?? inTok;
      outTok = chunk.usageMetadata.candidatesTokenCount ?? outTok;
    }
  }
  void dbLogUsage(_currentUserId, 'generateAISummary', SMART_MODEL, inTok, outTok);
  return full;
}

// ── Document reading generator ────────────────────────────────

export async function generateReading(
  topic:          string,
  contentText:    string | null,
  _pdfBase64:     string | null,
  contentMap:     ContentMap,
  sentenceTarget: number = 3,
  gapFill?:       string[],
): Promise<DocumentReading> {
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

  const topicResults = await Promise.all(
    cappedTopics.map(async (t): Promise<TopicReading | null> => {
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
        const raw = await generateText(
          SMART_MODEL,
          'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
          [textPart(prompt)],
          4000,
          'generateReading',
        );

        const parsed = parseJson<TopicReading>(raw);
        if (!Array.isArray(parsed.subtopics) || parsed.subtopics.length === 0) {
          console.error(`[generateReading] topic "${t.title}" — no subtopics`);
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

function buildFallbackPayload(topic: string): SimulationPayload {
  const t = topic.toLowerCase();
  if (/\b(blood|heart|circulat|cardio|vascu|artery|vein|plasma|pulmonary)\b/.test(t))
    return { domain: 'biology', title: 'Circulatory System', concept: 'Animated blood flow through the heart and vessels.', simulationVariables: { simulationType: 'circulatory' } };
  if (/\b(cell|divis|mitosis|meiosis|chromosome|nucleus|dna|rna|genetic|genome|replicat)\b/.test(t))
    return { domain: 'biology', title: 'Cell Division', concept: 'Animated mitosis stages from interphase to cytokinesis.', simulationVariables: { simulationType: 'mitosis' } };
  if (/\b(neuron|nerve|synapse|action.?potential|brain|neural|dendrite|axon|cortex|reflex)\b/.test(t))
    return { domain: 'biology', title: 'Neural Signal', concept: 'Action potential propagating across a neuron chain.', simulationVariables: { simulationType: 'neural' } };
  if (/\b(ecosystem|predator|prey|population|ecology|species|food.web|evolution|natural.select|biome)\b/.test(t))
    return { domain: 'biology', title: 'Ecosystem Dynamics', concept: 'Live predator-prey particle simulation.', simulationVariables: { simulationType: 'ecosystem' } };
  if (/\b(trigonometr|sine|cosine|tangent|wave|oscillat|periodic)\b/.test(t))
    return { domain: 'graphing', title: 'Trigonometric Wave', concept: 'Graph of a sine wave.', graphingEquation: 'sin(x)' };
  if (/\b(quadratic|parabola|polynomial)\b/.test(t))
    return { domain: 'graphing', title: 'Quadratic Function', concept: 'Graph of a quadratic equation.', graphingEquation: 'x^2' };
  if (/\b(exponential|logarithm|log|growth|decay)\b/.test(t))
    return { domain: 'graphing', title: 'Exponential Function', concept: 'Graph of exponential growth.', graphingEquation: 'exp(x)' };
  if (/\b(limit|limits|continuity|lim|approaches|epsilon|delta)\b/.test(t))
    return { domain: 'math', title: 'Limits & Continuity', concept: 'Core limit definitions and rules.', latexFormulas: ['\\lim_{x \\to c} f(x) = L', '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1', '\\lim_{x \\to \\infty} \\left(1 + \\frac{1}{x}\\right)^x = e'] };
  if (/\b(derivative|differenti|rate.of.change|gradient|tangent.line|chain.rule|product.rule)\b/.test(t))
    return { domain: 'math', title: 'Differentiation Rules', concept: 'Core derivative formulas.', latexFormulas: ['\\frac{d}{dx}[x^n] = nx^{n-1}', '\\frac{d}{dx}[\\sin x] = \\cos x', '\\frac{d}{dx}[e^x] = e^x'] };
  if (/\b(integral|integrat|antiderivative|area.under|riemann)\b/.test(t))
    return { domain: 'math', title: 'Integration Rules', concept: 'Core integral formulas.', latexFormulas: ['\\int x^n\\,dx = \\frac{x^{n+1}}{n+1} + C', '\\int \\sin x\\,dx = -\\cos x + C', '\\int e^x\\,dx = e^x + C'] };
  if (/\b(algebra|equation|linear|simultaneous|matrix|vector)\b/.test(t))
    return { domain: 'math', title: 'Algebra Equations', concept: 'Key algebraic formulas.', latexFormulas: ['ax^2 + bx + c = 0', 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', '(a+b)^2 = a^2 + 2ab + b^2'] };
  if (/\b(statistic|probability|mean|variance|standard.deviation)\b/.test(t))
    return { domain: 'math', title: 'Statistics Formulas', concept: 'Core statistical measures.', latexFormulas: ['\\mu = \\frac{1}{n}\\sum_{i=1}^n x_i', '\\sigma^2 = \\frac{1}{n}\\sum(x_i - \\mu)^2', 'P(A \\cup B) = P(A) + P(B) - P(A \\cap B)'] };
  if (/\b(physics|force|energy|momentum|velocity|acceleration|newton|motion|kinematic)\b/.test(t))
    return { domain: 'math', title: 'Physics Equations', concept: 'Key equations of motion and energy.', latexFormulas: ['F = ma', 'v = u + at', 'E_k = \\frac{1}{2}mv^2', 's = ut + \\frac{1}{2}at^2'] };
  if (/\b(chemistry|reaction|equilibrium|thermodynam|enthalpy|entropy|gibbs)\b/.test(t))
    return { domain: 'math', title: 'Chemistry Equations', concept: 'Core thermodynamic and equilibrium expressions.', latexFormulas: ['\\Delta G = \\Delta H - T\\Delta S', 'K_{eq} = \\frac{[\\text{products}]}{[\\text{reactants}]}', 'PV = nRT'] };
  return { domain: 'graphing', title: `${topic} — Function Graph`, concept: `Interactive graph for ${topic}.`, graphingEquation: 'x^2' };
}

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

DOMAIN RULES:
- Use "biology" for living organisms, body systems, anatomy, physiology, ecology, cells, or neuroscience.
- Use "math" for mathematical formulas, equations, proofs, or named rules.
- Use "graphing" for mathematical functions best understood by seeing their curve.

Call render_simulation now.`;

    const response = await client.models.generateContent({
      model:    FAST_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config:   {
        tools: [{
          functionDeclarations: [{
            name:        'render_simulation',
            description: 'Render an interactive educational visual for a student',
            parameters:  {
              type: Type.OBJECT,
              properties: {
                domain:           { type: Type.STRING, enum: ['math', 'graphing', 'biology'] },
                title:            { type: Type.STRING, description: 'Short descriptive title (≤8 words)' },
                concept:          { type: Type.STRING, description: 'One sentence explaining what this visual shows' },
                latexFormulas:    { type: Type.ARRAY,  items: { type: Type.STRING }, description: 'LaTeX formula strings for math domain' },
                graphingEquation: { type: Type.STRING, description: 'math.js equation for graphing domain, e.g. "sin(x)"' },
                simulationVariables: {
                  type: Type.OBJECT,
                  properties: { simulationType: { type: Type.STRING, enum: ['circulatory', 'mitosis', 'neural', 'ecosystem'] } },
                },
              },
              required: ['domain', 'title', 'concept'],
            },
          }],
        }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
      },
    });

    void dbLogUsage(
      _currentUserId, 'generateDynamicVisual', FAST_MODEL,
      response.usageMetadata?.promptTokenCount     ?? 0,
      response.usageMetadata?.candidatesTokenCount ?? 0,
    );

    const call = response.functionCalls?.[0];
    if (!call?.args) {
      console.warn('[generateDynamicVisual] no function call — using fallback');
      return makeComponent(buildFallbackPayload(topic));
    }

    const payload = call.args as unknown as SimulationPayload;
    if (!payload?.domain || !payload?.title) return makeComponent(buildFallbackPayload(topic));

    return makeComponent(payload);
  } catch (err) {
    console.warn('[generateDynamicVisual] error — using fallback:', err);
    return makeComponent(buildFallbackPayload(topic));
  }
}

export async function generateVisualComponents(
  topic:       string,
  contentText: string | null,
  _pdfBase64:  string | null,
): Promise<VisualSet> {
  const dynamicVisual = await generateDynamicVisual(topic, contentText);
  return { components: [dynamicVisual] };
}

// ── Practice quiz ─────────────────────────────────────────────

export async function generatePracticeQuiz(
  documentReading: DocumentReading,
  topic:           string,
): Promise<PracticeQuiz> {
  const topicCount   = documentReading.topics.length;
  const mcqCount     = Math.max(topicCount + 2, 6);
  const fillCount    = Math.max(topicCount, 4);
  const writtenCount = Math.max(Math.ceil(topicCount * 0.75), 3);

  const contentSummary = documentReading.topics.map(t =>
    `TOPIC "${t.title}" (topicId: "${t.topicId}"):\n` +
    t.subtopics.map(s => `  - ${s.title}: ${s.content ?? ''}`).join('\n') +
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
    { "id": "q1", "type": "mcq",     "topicId": "t1", "topicTitle": "...", "question": "...", "options": ["A","B","C"], "answer": 0, "explanation": "..." },
    { "id": "q2", "type": "fill",    "topicId": "t1", "topicTitle": "...", "question": "The ___ converts light into energy.", "blank": "chloroplast", "explanation": "..." },
    { "id": "q3", "type": "written", "topicId": "t2", "topicTitle": "...", "question": "Explain why...", "sampleAnswer": "A complete answer would mention...", "explanation": "Key points: ..." }
  ]
}`;

  const raw = await generateText(
    SMART_MODEL,
    'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    [textPart(prompt)],
    8000,
    'generatePracticeQuiz',
  );

  const parsed = parseJson<PracticeQuiz>(raw);
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
  try {
    const raw = await generateText(
      FAST_MODEL,
      'You are a precise JSON generator. Output only valid JSON.',
      [textPart(`Grade this student answer on "${topic}".

QUESTION: ${question}
SAMPLE ANSWER: ${sampleAnswer}
STUDENT ANSWER: ${userAnswer}

Score: 2 = comprehensive & correct, 1 = partially correct, 0 = incorrect or missing key ideas.
Return ONLY: { "score": 0, "feedback": "Warm 1-2 sentence feedback." }`)],
      200,
      'evaluateWrittenAnswer',
    );
    return parseJson<WrittenEvaluation>(raw);
  } catch {
    return { score: 1, feedback: 'Partial credit — keep going!' };
  }
}

// ── Course Material generator ─────────────────────────────────
// Notes = verbatim content from the original document, reorganised by topic.
// Students use Notes to study the actual source material (not an AI summary).
// Map + Read provide the AI-interpreted versions.
//
// BATCHING STRATEGY (beats Netlify's 26s edge-function timeout):
//   • Topics are split into sequential batches of BATCH_SIZE (3).
//   • Each batch: PDF sent once + ~3 topics of output ≈ 2 100 tokens → ~10s.
//   • Total for 7 topics: 3 sequential calls × ~10s = ~30s user wait.
//   • Sending all 7 topics in one call (7 × 700 = 4 900 tokens + PDF overhead)
//     still risks hitting 26s; parallel calls multiply the risk × 7.

export async function generateCourseMaterial(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
  contentMap:  ContentMap,
  onProgress?: (msg: string) => void,
): Promise<DocumentReading> {
  const BATCH_SIZE = 3;   // topics per edge-function call — safe at ~10s each
  const MAX_TOPICS = 7;
  const cappedTopics = contentMap.topics.slice(0, MAX_TOPICS);

  const hasPdf  = !!pdfBase64;
  const hasText = !!contentText;
  const fullText = contentText?.slice(0, 60_000) ?? '';

  // Split into sequential batches
  const batches: typeof cappedTopics[] = [];
  for (let i = 0; i < cappedTopics.length; i += BATCH_SIZE) {
    batches.push(cappedTopics.slice(i, i + BATCH_SIZE));
  }

  const allTopics: TopicReading[] = [];

  for (let b = 0; b < batches.length; b++) {
    const batch    = batches[b];
    const startNum = b * BATCH_SIZE + 1;
    const endNum   = Math.min(startNum + batch.length - 1, cappedTopics.length);
    onProgress?.(`Extracting notes — topics ${startNum}–${endNum} of ${cappedTopics.length}…`);

    // Outline for this batch only
    const topicsOutline = batch.map((t, i) =>
      `Topic ${i + 1} (topicId: "${t.id}", title: "${t.title}"):
Overview: ${t.summary}
Subtopics:
${t.subtopics.map(s => `  • "${s.title}": ${s.summary}`).join('\n')}`
    ).join('\n\n');

    // Verbatim instruction differs by source type
    const contentInstruction = hasText
      ? `For each subtopic "content": find and copy 3–6 CONSECUTIVE sentences VERBATIM from the SOURCE CONTENT above that directly explain this subtopic. Copy the EXACT words as they appear — do NOT paraphrase, reword, or summarise.`
      : hasPdf
        ? `For each subtopic "content": find and copy 3–6 CONSECUTIVE sentences VERBATIM from the PDF document above that directly explain this subtopic. Copy the EXACT words as they appear — do NOT paraphrase, reword, or summarise.`
        : `For each subtopic "content": write 4–6 clear, specific, factually accurate sentences based on the topic context.`;

    const sourceSection = hasText
      ? `SOURCE CONTENT (verbatim from the uploaded document):\n"""\n${fullText}\n"""\n\n`
      : '';

    const prompt = `You are an expert educational content organiser. Your job is to EXTRACT and REORGANISE content from the original document — not rewrite it.

SUBJECT: "${topic}"
${sourceSection}TOPIC OUTLINE (${batch.length} topics in this batch):
${topicsOutline}

INSTRUCTIONS:
${contentInstruction}

For EVERY topic in the outline, and EVERY subtopic within it, produce:
1. "content": ${hasText || hasPdf ? 'VERBATIM sentences from the document (see instruction above).' : '4–6 educational sentences grounded in the topic context.'}
2. "quiz": one comprehension question — exactly 3 plausible options, 0-based answer index, 1-sentence explanation.

Also for each topic:
- "keyTerms": 3–5 key terms with clear, document-grounded definitions.
- "whyItMatters": one sentence on why this topic matters to a student.

Rules:
- Process ALL ${batch.length} topics in this batch — do not skip any.
- Subtopic titles must match the outline EXACTLY.
- Content must come from the document, not be invented.
- Quiz distractors must be plausible, not obviously wrong.

Return ONLY valid JSON — no markdown fences:
{
  "topics": [
    {
      "topicId": "t1",
      "title": "Topic Title",
      "subtopics": [
        {
          "title": "Subtopic name (must match outline exactly)",
          "content": "...",
          "quiz": { "question": "...", "options": ["A", "B", "C"], "answer": 0, "explanation": "..." }
        }
      ],
      "keyTerms": [{ "term": "...", "definition": "..." }],
      "whyItMatters": "..."
    }
  ]
}`;

    // For PDFs: send the binary once per batch (small output keeps each call <26s).
    // For text docs: embed the full text in the prompt — no binary needed.
    const parts: Part[] = hasPdf
      ? [pdfPart(pdfBase64!), textPart(prompt)]
      : [textPart(prompt)];

    const raw = await generateText(
      SMART_MODEL,
      'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
      parts,
      4000,  // 3 topics × ~700 tokens = ~2 100 + overhead ≈ 10s — well under 26s
      'generateCourseMaterial',
    );

    const parsed = parseJson<{ topics: TopicReading[] }>(raw);
    if (!Array.isArray(parsed.topics) || parsed.topics.length === 0) {
      throw new Error(`Failed to generate notes for topics ${startNum}–${endNum}. Please retry.`);
    }

    // Enforce topicId / title from the content map so IDs never drift
    const batchTopics = parsed.topics
      .map((tr, i) => {
        const source = batch[i];
        if (!source) return null;
        if (!Array.isArray(tr.subtopics) || tr.subtopics.length === 0) return null;
        return { ...tr, topicId: source.id, title: source.title } as TopicReading;
      })
      .filter((t): t is TopicReading => t !== null);

    allTopics.push(...batchTopics);
  }

  if (allTopics.length === 0) throw new Error('Failed to generate course material. Please retry.');
  return { topics: allTopics };
}


// ── Paragraph quiz ────────────────────────────────────────────

export async function generateParagraphQuiz(
  extractedText:  string,
  subTopicTitle:  string,
  topicTitle:     string,
): Promise<ParagraphQuestion[]> {
  const prompt = `You are an expert educator. Generate exactly 5 multiple-choice questions to test understanding of the following subtopic.

Generate questions specifically about '${subTopicTitle}' (part of topic '${topicTitle}') based on the source document.

SOURCE DOCUMENT (excerpt):
${extractedText.slice(0, 6000)}

Rules:
- Each question must be directly answerable from the source document above.
- Provide exactly 4 answer options per question (A, B, C, D).
- Exactly one option is correct; the other 3 are plausible distractors.
- Vary difficulty: 2 recall questions, 2 comprehension questions, 1 application/inference question.
- Explanation is 1 sentence shown after the student answers.
- answer is the 0-based index of the correct option.

Return ONLY valid JSON — no markdown:
{
  "questions": [
    { "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "answer": 0, "explanation": "..." }
  ]
}`;

  const raw = await generateText(
    FAST_MODEL,
    'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    [textPart(prompt)],
    2000,
    'generateParagraphQuiz',
  );

  const parsed = parseJson<{ questions: ParagraphQuestion[] }>(raw);
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error('Invalid quiz response. Please retry.');
  }
  return parsed.questions;
}

// ── Per-topic conceptual explanation (Understand mode) ────────
// Streams a 150-220 word plain-language explanation of a single topic.
// Not a summary — a genuine "knowledgeable friend" explanation with an
// analogy and a key insight blockquote at the end.

export async function streamTopicUnderstanding(
  courseTopic:    string,
  topicTitle:     string,
  topicSummary:   string,
  subtopics:      { title: string }[],
  allTopicTitles: string[],
  onChunk:        (text: string) => void,
): Promise<void> {
  const client = getClient();

  const pos      = allTopicTitles.indexOf(topicTitle);
  const prevTopic = pos > 0                         ? allTopicTitles[pos - 1] : null;
  const nextTopic = pos < allTopicTitles.length - 1 ? allTopicTitles[pos + 1] : null;

  const systemInstruction = `\
You are a warm, knowledgeable teacher explaining ideas to a curious student.
Your job is NOT to summarise the notes — it is to explain what this topic REALLY means,
why it matters, and how it connects to the bigger picture.
Write in flowing, conversational prose. Use one relatable analogy to make the idea concrete.
Target 150–220 words of main body text.
End with a single key insight on its own line as a Markdown blockquote (> Your insight here).
Do NOT use headings, bullet points, or numbered lists. Plain prose + one blockquote only.`;

  const subtopicList = subtopics.map(s => `• ${s.title}`).join('\n');

  const prompt = [
    `Course: "${courseTopic}"`,
    `Topic: "${topicTitle}"`,
    topicSummary ? `Overview: ${topicSummary}` : '',
    subtopicList  ? `Subtopics covered:\n${subtopicList}` : '',
    prevTopic     ? `This topic follows: "${prevTopic}"` : '',
    nextTopic     ? `This topic leads into: "${nextTopic}"` : '',
    '',
    'Write a conceptual explanation for a student who wants to truly understand this, not just memorise it.',
  ].filter(Boolean).join('\n');

  const stream = await client.models.generateContentStream({
    model:    FAST_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config:   {
      systemInstruction,
      maxOutputTokens: 500,
      temperature:     0.7,
      thinkingConfig:  { thinkingBudget: 0 },
    },
  });

  let inputTokens  = 0;
  let outputTokens = 0;

  for await (const chunk of stream) {
    const t = chunk.text ?? '';
    if (t) onChunk(t);
    if (chunk.usageMetadata) {
      inputTokens  = chunk.usageMetadata.promptTokenCount     ?? inputTokens;
      outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
    }
  }

  void dbLogUsage(_currentUserId, 'streamTopicUnderstanding', FAST_MODEL, inputTokens, outputTokens);
}

// ── Study brief (personalised plan shown on the Map screen) ───

export type StudyBrief = {
  approach:        string;    // 2-3 sentence strategy for this material
  anchorConcepts:  string[];  // 3-5 must-know concepts before anything else
  studyOrder:      string;    // narrative on recommended reading order
  hardSpots:       string[];  // 2-4 predicted difficult areas
  sessionPlan:     string;    // how to break this into sessions with timing
  profileInsights: string[];  // 2-3 tips derived from cognitive profile
};

function _briefScoreLabel(score: number): string {
  if (score >= 75) return 'high';
  if (score >= 45) return 'moderate';
  return 'low';
}

export async function generateStudyBrief(
  contentMap:  ContentMap,
  topic:       string,
  profile:     LearnerProfile | null,
): Promise<StudyBrief> {
  const topicList = contentMap.topics
    .map((t, i) =>
      `${i + 1}. ${t.title}\n   Subtopics: ${t.subtopics.map(s => s.title).join(', ')}`,
    )
    .join('\n');

  const profileBlock = profile
    ? [
        `Working memory: ${_briefScoreLabel(profile.workingMemory.score)}`,
        `Processing speed: ${_briefScoreLabel(profile.processingSpeed.score)}`,
        `Fluid intelligence (abstract reasoning): ${_briefScoreLabel(profile.fluidIntelligence.score)}`,
        `Executive function (task switching): ${_briefScoreLabel(profile.executiveFunction.score)}`,
        `Sustained attention: ${_briefScoreLabel(profile.sustainedAttention.score)}`,
        profile.confidence.calibrationBias !== undefined
          ? `Confidence calibration: ${
              profile.confidence.calibrationBias >  0.1 ? 'overconfident — needs extra verification steps' :
              profile.confidence.calibrationBias < -0.1 ? 'underconfident — needs reassurance and confidence building' :
              'well calibrated'
            }`
          : '',
      ].filter(Boolean).join('\n')
    : 'No cognitive profile available — provide generic, broadly applicable advice.';

  const systemInstruction = `\
You are an expert learning strategist with deep knowledge of subject-specific study methods.

Step 1 — Identify the subject type from the content (e.g. biology, chemistry, physics, mathematics,
history, geography, law, philosophy, religious studies / scripture, language learning, literature,
economics, psychology, computer science, medicine, etc.).

Step 2 — Apply the best-practice study approach for THAT subject type. Examples:
- Biology / Science: understand mechanisms and cause-effect chains; link structure to function; use active recall on processes
- Scripture / Religious studies: read slowly; trace the argument and its spiritual significance; understand Sanskrit/original terms before translation
- Mathematics: work through examples; understand proofs before memorising; build incrementally
- History: construct a chronological narrative first; link events by causation; anchor around key figures
- Law: learn doctrine then apply to facts; case-based reasoning; statutory interpretation
- Language learning: spaced repetition; phonetic awareness; contextual usage before grammar rules
- Philosophy: trace each argument step by step; identify premises and conclusions; apply to modern scenarios
- Literature: understand context before close reading; track themes and motifs; author's intent vs. reader response
- Economics / Psychology: understand models first; real-world application; statistical thinking

Step 3 — Personalise to the learner's cognitive profile.

Be specific — reference actual topic names from the map. Keep every field brief, direct, actionable.
Return ONLY valid JSON — no markdown fences, no extra text.`;

  const prompt = `\
Topic: "${topic}"
Overview: ${contentMap.synthesis}

Topics in this material:
${topicList}

Learner cognitive profile:
${profileBlock}

Return a JSON object with EXACTLY these keys:
{
  "approach":        "2-3 sentences — name the subject type, then give the subject-appropriate strategy for THIS specific material",
  "anchorConcepts":  ["concept 1", "concept 2", "concept 3"],
  "studyOrder":      "1-2 sentences on recommended reading order and why, informed by the subject type",
  "hardSpots":       ["difficult area 1 — why it is hard for this subject type", "difficult area 2", "difficult area 3"],
  "sessionPlan":     "1-2 sentences on how to split this into sessions with rough timing, suited to this subject",
  "profileInsights": ["tip 1 referencing their actual profile scores AND the subject", "tip 2", "tip 3"]
}

anchorConcepts: 3-5 ideas the student must grasp before the rest makes sense (specific to this material).
hardSpots: 2-4 specific topics/concepts predicted to challenge THIS student given the subject type and their profile.
profileInsights: MUST reference the learner's actual cognitive scores AND explain what they mean for studying THIS subject.`;

  // Use streaming internally to avoid Netlify's 26s edge-function timeout.
  // Same pattern as generateDocumentDiagnostic — accumulate chunks, parse at end.
  const client = getClient();
  const stream = await client.models.generateContentStream({
    model:    FAST_MODEL,
    contents: [{ role: 'user', parts: [textPart(prompt)] }],
    config:   {
      systemInstruction,
      maxOutputTokens: 900,
      temperature:     0.3,
      thinkingConfig:  { thinkingBudget: 0 },
    },
  });

  let raw        = '';
  let inTokens   = 0;
  let outTokens  = 0;
  for await (const chunk of stream) {
    if (chunk.text) raw += chunk.text;
    if (chunk.usageMetadata) {
      inTokens  = chunk.usageMetadata.promptTokenCount     ?? inTokens;
      outTokens = chunk.usageMetadata.candidatesTokenCount ?? outTokens;
    }
  }
  void dbLogUsage(_currentUserId, 'generateStudyBrief', FAST_MODEL, inTokens, outTokens);

  const parsed = parseJson<StudyBrief>(raw);
  if (!parsed.approach || !Array.isArray(parsed.anchorConcepts)) {
    throw new Error('Invalid study brief response.');
  }
  return parsed;
}
