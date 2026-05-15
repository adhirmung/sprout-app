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

// ── Feed generator ────────────────────────────────────────────

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

Generate exactly 9 cards in this order — all types required:
1. summary  — 5 key points spanning the full material
2. concept  — deep explanation with example, analogy, and 3-5 key terms
3. flashcard — Q&A testing recall
4. flashcard — Q&A on a different concept
5. worked_example — step-by-step walk through a problem or process (3-5 steps)
6. animation — 4-5 narrative steps showing how the process works
7. fill_blank — one sentence with 2-3 blanks (use _____ for each blank)
8. quiz — 4-option multiple choice
9. quiz — 4-option multiple choice on a different concept

Rules:
- Cover the FULL breadth of the source — not just the opening section
- All facts from source content only; never invent
- fill_blank: number of _____ must exactly equal blanks array length
- worked_example steps: each step builds logically on the previous
- quiz correctIndex is 0-based; distractors must be plausible

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
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 0, "explanation": "..." },
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 1, "explanation": "..." }
  ]
}`;
}

function buildFlashcardsOnlyPrompt(topic: string, contentText: string | null, hasPdf: boolean): string {
  return `You are an expert educator. Generate 15 comprehensive flashcards for: "${topic}"
${sourceBlock(contentText, hasPdf)}

Rules:
- Span the FULL breadth of the material — cover all major sections, concepts, and facts
- Vary question types: definitions, mechanisms, comparisons, cause-effect, applications
- Answers: 1-3 precise sentences; include exact terminology from the source
- Do NOT cluster around only the opening section
- Include: key terms, processes, formulas, examples, named concepts, procedures

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
    { "type": "flashcard", "question": "...", "answer": "..." }
  ]
}`;
}

function buildQuizOnlyPrompt(topic: string, contentText: string | null, hasPdf: boolean): string {
  return `You are an expert educator. Generate 8 comprehensive multiple-choice quiz questions for: "${topic}"
${sourceBlock(contentText, hasPdf)}

Rules:
- Span the FULL breadth of the material
- Each question has exactly 4 options
- correctIndex is 0-based (0 = first option is correct)
- Distractors must be plausible — not obviously wrong
- Explanation addresses the most tempting wrong answer (2-3 sentences)
- Mix recall, application, and analysis questions

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
    { "type": "quiz", "question": "...", "options": ["A ...", "B ...", "C ...", "D ..."], "correctIndex": 0, "explanation": "..." }
  ]
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
): Promise<FeedCard[]> {
  const client = getClient();

  const promptFn  = mode === 'flashcards' ? buildFlashcardsOnlyPrompt
    : mode === 'quiz' ? buildQuizOnlyPrompt
    : buildActivitiesPrompt;

  const maxTokens = mode === 'flashcards' ? 5000 : mode === 'quiz' ? 4000 : 7000;

  type MsgContent = Parameters<typeof client.messages.create>[0]['messages'][0]['content'];
  const userContent: MsgContent = pdfBase64
    ? ([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: promptFn(topic, contentText, true) },
      ] as MsgContent)
    : promptFn(topic, contentText, false);

  const model = 'claude-haiku-4-5-20251001';

  const msg = await client.messages.create({
    model, max_tokens: maxTokens,
    system:   'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages: [{ role: 'user', content: userContent }],
  });

  const raw   = msg.content.find(b => b.type === 'text')?.text ?? '';
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Failed to generate content. Please retry.');

  let parsed: { cards: FeedCard[] };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    parsed = JSON.parse(repairJson(raw.slice(start)));
  }

  if (!Array.isArray(parsed.cards) || parsed.cards.length === 0) {
    throw new Error('Invalid response. Please retry.');
  }
  return parsed.cards;
}
