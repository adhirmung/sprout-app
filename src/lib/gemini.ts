import { FunctionCallingConfigMode, GoogleGenAI, Type } from '@google/genai';
import type { LearnerProfile } from './types';
import { dbLogUsage } from './supabase';

// ── Model config ──────────────────────────────────────────────
// Both use Flash to stay within Netlify Edge Function's 26s timeout.
// gemini-2.5-pro has mandatory thinking (can take 60s+) → times out.
// gemini-2.5-flash with thinkingBudget:0 responds in ~5s.
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

function textPart(text: string): Part {
  return { text };
}

// ── Core generation helper ────────────────────────────────────
// Non-streaming for all JSON tasks (streaming only needed for chat).
// Logs token usage fire-and-forget.

async function generateText(
  model:             string,
  systemInstruction: string,
  parts:             Part[],
  maxOutputTokens:   number,
  fnName:            string,
): Promise<string> {
  const client = getClient();

  const response = await client.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config:   {
      systemInstruction,
      maxOutputTokens,
      temperature: 0.1,
      // Disable thinking tokens — keeps responses under Netlify's 26s edge-function limit.
      // 2.5-pro has mandatory thinking (60s+); 2.5-flash has optional thinking.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const text = response.text ?? '';

  const usage = response.usageMetadata;
  void dbLogUsage(
    _currentUserId, fnName, model,
    usage?.promptTokenCount     ?? 0,
    usage?.candidatesTokenCount ?? 0,
  );

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
function sourceBlock(contentText: string | null, hasPdf: boolean): string {
  return hasPdf
    ? 'The full document (text + images) is attached above.'
    : contentText
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
// Streams the full document content (text + tables + image descriptions)
// via Gemini multimodal. Returns rich markdown. Because we stream, the
// Netlify 26s edge-function timeout never fires — chunks arrive continuously.

export async function extractPdfContent(
  pdfBase64: string,
  onChunk?:  (accumulated: string, newChunk: string) => void,
): Promise<string> {
  const client = getClient();

  const prompt = `Extract the COMPLETE text content of this document. Include every heading, subheading, body paragraph, table cell, caption, label, and footnote.
- Format tables as Markdown tables (| col | col | format)
- For charts, diagrams, or images: write a brief description in [square brackets] explaining what is shown
- Use # for main headings, ## for subheadings, ### for smaller headings
- Reproduce ALL text verbatim — do not skip, summarise, or paraphrase any section
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
  topicId:      string;
  title:        string;
  subtopics:    { title: string; content: string; quiz: SubtopicQuiz }[];
  keyTerms:     TopicKeyTerm[];
  whyItMatters: string;
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
  | { type: 'flashcard';      question: string; answer: string }
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

export interface ContentAudit {
  coverageScore:  number;
  missedConcepts: string[];
  suggestions:    string[];
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

function buildFlashcardsOnlyPrompt(topic: string, contentText: string | null, hasPdf: boolean): string {
  return `You are an expert educator. Generate 20 flashcards covering "${topic}" comprehensively.
${sourceBlock(contentText, hasPdf)}

Rules:
- Cover every major concept, person, date, and process in the source
- Questions should be specific and unambiguous
- Answers: 1–3 precise sentences with exact facts

Return ONLY valid JSON — no markdown:
{ "cards": [{ "type": "flashcard", "question": "...", "answer": "..." }], "audit": null }`;
}

function buildQuizOnlyPrompt(topic: string, contentText: string | null, hasPdf: boolean): string {
  return `You are an expert educator. Generate 15 multiple-choice quiz questions about "${topic}".
${sourceBlock(contentText, hasPdf)}

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
): Promise<FeedResult> {
  const promptFn  = mode === 'flashcards' ? buildFlashcardsOnlyPrompt
    : mode === 'quiz' ? buildQuizOnlyPrompt
    : buildActivitiesPrompt;

  const maxTokens = mode === 'flashcards' ? 16000 : mode === 'quiz' ? 8000 : 16000;

  const parts: Part[] = pdfBase64
    ? [pdfPart(pdfBase64), textPart(promptFn(topic, contentText, true))]
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
  // Build a compact listing of every heading + snippet for the model
  const listing = sections.map(s => {
    const indent = s.level === 1 ? '' : '  ';
    const bullet = s.level === 1 ? '●' : '○';
    const hint   = s.snippet ? ` — ${s.snippet.slice(0, 120)}` : '';
    return `${indent}${bullet} ${s.title}${hint}`;
  }).join('\n');

  const prompt = `Document: "${topic}"

These are the EXACT section headings from the document (● = main section, ○ = sub-section):
${listing}

Your task:
1. Write a 2-sentence synthesis describing the overall document.
2. Write ONE short sentence summarising each section listed above.

Rules:
- Do NOT add, remove, rename, or reorder any section.
- Every key in "summaries" must match the section title exactly as shown above.
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
): Promise<ContentMap> {
  const hasPdf = !!pdfBase64;

  const gapBlock = gapFill?.length
    ? `\n\nAlso include these missing concepts:\n${gapFill.map((g, i) => `${i + 1}. ${g}`).join('\n')}`
    : '';

  const mapSource = hasPdf
    ? 'The full document (text + images) is attached above.'
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

// ── Heading-list extractor ────────────────────────────────────
// When markdown parsing yields too few headings (e.g. the PDF used
// coloured banners instead of text headings), we ask the model one
// focused question: "List every section heading in order."
// The output is tiny (just titles) so it's fast and never truncates.

async function extractSectionHeadings(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
): Promise<ParsedSection[]> {
  const hasPdf = !!pdfBase64;

  const source = hasPdf
    ? 'The PDF document is attached.'
    : contentText
      ? `Document text:\n"""\n${contentText.slice(0, 80_000)}\n"""`
      : '(No content provided.)';

  const prompt = `Document: "${topic}"
${source}

List EVERY named section heading and sub-section heading from this document, in the exact order they appear.

Rules:
- Include ALL sections — do not skip, merge, group, or rename any heading.
- Use level 1 for main section titles, level 2 for sub-sections under them.
- Copy the title text exactly as it appears in the document.
- If the document has 25 named sections, your list must have 25 entries.

Return ONLY valid JSON — no markdown fences, no explanation:
{
  "headings": [
    { "level": 1, "title": "Exact Main Section Title" },
    { "level": 2, "title": "Exact Sub-section Title" }
  ]
}`;

  const parts: Part[] = pdfBase64
    ? [pdfPart(pdfBase64), textPart(prompt)]
    : [textPart(prompt)];

  console.log(`[extractSectionHeadings] mode=${hasPdf ? 'PDF' : 'text'} pdfLen=${pdfBase64?.length ?? 0}`);

  const raw = await generateText(
    SMART_MODEL,
    'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    parts,
    4000,
    'extractSectionHeadings',
  );

  console.log(`[extractSectionHeadings] raw response (first 400 chars):`, raw.slice(0, 400));

  const parsed = parseJson<{ headings: { level: number; title: string }[] }>(raw);
  const result = (parsed.headings ?? []).map(h => ({
    level: Math.min(Math.max(h.level ?? 1, 1), 3) as 1 | 2 | 3,
    title: String(h.title ?? '').trim(),
    snippet: '',
  })).filter(h => h.title.length > 0);

  console.log(`[extractSectionHeadings] found ${result.length} headings`);
  return result;
}

// ── generateContentMap (public entry point) ───────────────────
// Three-path strategy:
//  1. Parse markdown headings from extracted text (instant, no API call).
//  2. Ask the model for headings only (small, fast, reliable) — used when
//     the PDF has non-standard heading formatting (coloured banners etc.).
//  3. Full model-driven map — last resort for unstructured docs (essays, articles).

export async function generateContentMap(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
  gapFill?:    string[],
): Promise<ContentMap> {

  // ── Path 1: markdown heading parse (no API call) ──────────────
  // Only reliable when there is NO PDF — otherwise the PDF's non-standard
  // headings (coloured banners etc.) won't appear in the extracted text
  // and Path 1 returns only the few sections that happen to look like
  // markdown headings, missing most of the document.
  if (!pdfBase64) {
    const sections = contentText ? parseSectionsFromMarkdown(contentText) : [];
    console.log(`[generateContentMap] Path 1 (no PDF): found ${sections.length} markdown headings`);
    if (sections.length > 0) {
      const h1Count   = sections.filter(s => s.level === 1).length;
      const normalised = h1Count === 0
        ? sections.map(s => ({ ...s, level: 1 as const }))
        : sections;
      return generateMapFromHeadings(topic, normalised);
    }
  } else {
    console.log(`[generateContentMap] PDF present (len=${pdfBase64.length}), skipping Path 1 → going to Path 2`);
  }

  // ── Path 2: focused heading extraction via model (one API call) ─
  // Always used when a PDF is present — the model reads the raw PDF and
  // lists every heading verbatim, regardless of visual formatting style.
  const headings = await extractSectionHeadings(topic, contentText, pdfBase64);
  if (headings.length > 0) {
    const h1Count   = headings.filter(h => h.level === 1).length;
    const normalised = h1Count === 0
      ? headings.map(h => ({ ...h, level: 1 as const }))
      : headings;
    return generateMapFromHeadings(topic, normalised);
  }

  // ── Path 3: full model-driven map — last resort ───────────────
  // For truly unstructured content (essays, articles) with no discernible
  // heading structure at all.
  return generateMapFromModel(topic, contentText, pdfBase64, gapFill);
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

// ── Content audit ─────────────────────────────────────────────

export async function generateContentAudit(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
  contentMap:  ContentMap,
): Promise<ContentAudit> {
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

Be very specific. If nothing is missed, return an empty array.

Give a coverageScore 0–100: what percentage of the document's important, testable content is represented in the map.
Give 1–3 concrete suggestions for what the map should add or emphasise.

Return ONLY valid JSON — no markdown:
{
  "coverageScore": <0–100>,
  "missedConcepts": ["Specific missed item with brief context"],
  "suggestions":    ["Actionable suggestion"]
}`;

  const parts: Part[] = pdfBase64
    ? [pdfPart(pdfBase64), textPart(prompt)]
    : [textPart(prompt)];

  const raw = await generateText(
    SMART_MODEL,
    'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    parts,
    2000,
    'generateContentAudit',
  );

  const parsed = parseJson<ContentAudit>(raw);
  if (typeof parsed.coverageScore !== 'number' || !Array.isArray(parsed.missedConcepts)) {
    throw new Error('Invalid audit response.');
  }
  return parsed;
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

// ── Streaming course material (new architecture) ──────────────
// Generates notes one topic at a time using extractedText (no PDF binary).
// Each call is text-only + small output ≈ 3–5 s — well within the 26s limit.
// Topics stream in progressively; the UI can switch to 'course' after topic 1.

export async function streamCourseMaterial(
  topic:           string,
  extractedText:   string,
  contentMap:      ContentMap,
  onTopicComplete: (tr: TopicReading) => void,
  onProgress?:     (msg: string) => void,
): Promise<DocumentReading> {
  const allTopics:  TopicReading[] = [];
  const totalTopics = contentMap.topics.length;
  // Send up to 150 K chars of extracted text per call (covers most documents)
  const TEXT_LIMIT  = 150_000;
  const textSlice   = extractedText.slice(0, TEXT_LIMIT);

  for (let i = 0; i < totalTopics; i++) {
    const t = contentMap.topics[i];
    onProgress?.(`Generating notes — ${i + 1} of ${totalTopics}: ${t.title}…`);

    const topicOutline = `Topic (topicId: "${t.id}", title: "${t.title}"):
Overview: ${t.summary}
Subtopics:
${t.subtopics.map(s => `  • "${s.title}": ${s.summary}`).join('\n')}`;

    const prompt = `You are an expert educational content organiser. EXTRACT content from the original document — do NOT rewrite or paraphrase.

SUBJECT: "${topic}"
SOURCE CONTENT (verbatim from the uploaded document):
"""
${textSlice}
"""

TOPIC OUTLINE:
${topicOutline}

INSTRUCTIONS:
For each subtopic "content": find and copy 3–6 CONSECUTIVE sentences VERBATIM from the SOURCE CONTENT above that directly explain this subtopic. Use the EXACT words — do NOT paraphrase or reword.

Produce for this topic:
1. "content": VERBATIM sentences from the document for each subtopic.
2. "quiz": one comprehension question — exactly 3 plausible options, 0-based answer index, 1-sentence explanation.

Also:
- "keyTerms": 3–5 key terms with clear, document-grounded definitions.
- "whyItMatters": one sentence on why this topic matters to a student.

Rules: subtopic titles must match the outline EXACTLY; content must come from the document.

Return ONLY valid JSON — no markdown fences:
{
  "topicId": "${t.id}",
  "title": "${t.title}",
  "subtopics": [
    {
      "title": "Subtopic name (must match outline exactly)",
      "content": "...",
      "quiz": { "question": "...", "options": ["A", "B", "C"], "answer": 0, "explanation": "..." }
    }
  ],
  "keyTerms": [{ "term": "...", "definition": "..." }],
  "whyItMatters": "..."
}`;

    try {
      const client = getClient();
      const stream = await client.models.generateContentStream({
        model:    SMART_MODEL,
        contents: [{ role: 'user', parts: [textPart(prompt)] }],
        config:   {
          systemInstruction: 'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
          maxOutputTokens:   2000,
          temperature:       0.1,
          thinkingConfig:    { thinkingBudget: 0 },
        },
      });

      let raw          = '';
      let inputTokens  = 0;
      let outputTokens = 0;

      for await (const chunk of stream) {
        const chunkText = chunk.text ?? '';
        if (chunkText) raw += chunkText;
        if (chunk.usageMetadata) {
          inputTokens  = chunk.usageMetadata.promptTokenCount     ?? inputTokens;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
        }
      }

      void dbLogUsage(_currentUserId, 'streamCourseMaterial', SMART_MODEL, inputTokens, outputTokens);

      const parsed = parseJson<TopicReading>(raw);
      if (!Array.isArray(parsed.subtopics) || parsed.subtopics.length === 0) {
        console.error(`[streamCourseMaterial] topic "${t.title}" — no subtopics`);
        continue;
      }

      const tr: TopicReading = { ...parsed, topicId: t.id, title: t.title };
      allTopics.push(tr);
      onTopicComplete(tr);
    } catch (e) {
      console.error(`[streamCourseMaterial] topic "${t.title}" error:`, e);
      // continue — partial results are better than nothing
    }
  }

  if (allTopics.length === 0) throw new Error('Failed to generate course material. Please retry.');
  return { topics: allTopics };
}

// ── Paragraph quiz ────────────────────────────────────────────

export async function generateParagraphQuiz(
  subtopicTitle:   string,
  subtopicContent: string,
  topicTitle:      string,
): Promise<ParagraphQuiz> {
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

  const parsed = parseJson<ParagraphQuiz>(raw);
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error('Invalid quiz response. Please retry.');
  }
  return parsed;
}

// ── Document Diagnostic ───────────────────────────────────────
// Two-part quality test:
//   1. Did the AI read the full document? (page/section inventory)
//   2. Are those sections faithfully represented in the notes?

export interface DocumentDiagnostic {
  /** Estimated number of pages the AI processed (0 = could not determine) */
  pagesEstimated: number;
  /** Every major section / chapter the AI identified in the document */
  sectionsFound: string[];
  /** 0–100: how completely the *notes* cover the full document */
  notesCoverageScore: number;
  /** Specific topics / concepts present in the doc but absent from the notes */
  missingFromNotes: string[];
  /** One-sentence verdict on read completeness */
  readVerdict: string;
  /** One-sentence verdict on notes quality */
  notesVerdict: string;
}

export async function generateDocumentDiagnostic(
  topic:          string,
  contentText:    string | null,
  pdfBase64:      string | null,
  courseMaterial: DocumentReading,
): Promise<DocumentDiagnostic> {
  // Flatten notes into readable text so Gemini can compare
  const notesSummary = courseMaterial.topics.map(t =>
    `## ${t.title}\n` +
    t.subtopics.map(s => `- ${s.title}: ${s.content.slice(0, 300)}`).join('\n')
  ).join('\n\n');

  const prompt = `You are a document quality auditor. Perform a two-part diagnostic:

TOPIC: "${topic}"
${sourceBlock(contentText, !!pdfBase64)}

--- GENERATED NOTES (what the AI produced) ---
${notesSummary.slice(0, 6000)}
--- END NOTES ---

PART 1 — DID THE AI READ THE FULL DOCUMENT?
• Estimate the total number of pages in the original document.
• List EVERY major section, chapter, or topic heading you can identify in the document.
• Did the content appear to cut off, or was the full document accessible?

PART 2 — HOW COMPLETELY ARE THE NOTES?
• What percentage (0–100) of the document's important, testable content appears in the notes?
• List any specific topics, sections, facts, formulas, or named concepts that are in the document but ABSENT from the notes.

Return ONLY valid JSON — no markdown:
{
  "pagesEstimated": <integer, 0 if unknown>,
  "sectionsFound": ["Section name — brief description of content", "..."],
  "notesCoverageScore": <0-100>,
  "missingFromNotes": ["Specific missing topic or concept", "..."],
  "readVerdict": "One sentence: did the AI read the full document?",
  "notesVerdict": "One sentence: how complete are the notes?"
}`;

  const parts: Part[] = pdfBase64
    ? [pdfPart(pdfBase64), textPart(prompt)]
    : [textPart(prompt)];

  const raw = await generateText(
    SMART_MODEL,
    'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    parts,
    3000,
    'generateDocumentDiagnostic',
  );

  const parsed = parseJson<DocumentDiagnostic>(raw);
  if (typeof parsed.notesCoverageScore !== 'number' || !Array.isArray(parsed.sectionsFound)) {
    throw new Error('Invalid diagnostic response.');
  }
  return parsed;
}
