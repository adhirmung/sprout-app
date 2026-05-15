import Anthropic from '@anthropic-ai/sdk';
import type { LearnerProfile } from './types';

// ── Public types ──────────────────────────────────────────────

export interface GeneratedCards {
  topic: string;
  summary: { title: string; points: string[] };
  flashcards: Array<{ question: string; answer: string }>;
  animation: {
    title: string;
    steps: Array<{ icon: string; title: string; description: string }>;
  };
  quiz: Array<{
    question:    string;
    options:     string[];
    correctIndex: number;
    explanation: string;
  }>;
  interactives: Array<{
    type:  string;
    title: string;
    html:  string;
  }>;
}

// ── API key helpers ───────────────────────────────────────────

// VITE_USE_PROXY=true → route all Anthropic calls through /.netlify/functions/claude
// Set this in Netlify env; keep ANTHROPIC_API_KEY (no VITE_ prefix) as the server secret.
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

// ── Prompt builder ────────────────────────────────────────────

function buildPrompt(topic: string, content: string | null, profile: LearnerProfile | null): string {
  const wm  = profile?.workingMemory?.score        ?? 60;
  const ps  = profile?.processingSpeed?.score      ?? 60;
  const fi  = profile?.fluidIntelligence?.score    ?? 60;
  const ef  = profile?.executiveFunction?.score    ?? 60;
  const att = profile?.sustainedAttention?.score   ?? 60;
  const bias = profile?.confidence?.calibrationBias ?? 0;

  // ── Derived pedagogy targets ──────────────────────────────
  const gradeLevel =
    wm < 40 && ps < 40 ? '6–7' :
    wm > 70 && ps > 70 ? '10–12' : '8–9';

  const wordLimit = wm < 50 ? 18 : wm < 70 ? 25 : 35;

  const bloomsTarget =
    fi < 40
      ? 'Remember / Understand — definitions, facts, basic recall. Question stems: "What is…", "Define…", "List…", "Name…"'
      : fi < 70
      ? 'Understand / Apply — explain mechanisms, give examples, use concepts. Question stems: "Explain why…", "How does…", "Give an example of…"'
      : 'Analyse / Evaluate — compare, infer, judge, predict. Question stems: "Why does…", "What would happen if…", "Compare…", "Which factor most…"';

  const chunkRule =
    wm < 50
      ? 'ONE idea per bullet/step — never combine two concepts in one point.'
      : wm < 70
      ? 'At most TWO related ideas per bullet/step.'
      : 'Up to THREE connected ideas per bullet/step.';

  const sentenceRule =
    att < 50
      ? 'Max 15 words per sentence. Vivid, punchy language. No nested clauses.'
      : 'Normal sentence length (≤25 words). Vary structure to maintain engagement.';

  const confidenceRule =
    Math.abs(bias) < 0.05
      ? 'Standard quiz difficulty — balanced distractors.'
      : bias > 0
      ? 'Learner is OVERCONFIDENT: make distractors subtly plausible; target knowledge gaps; avoid easy giveaways.'
      : 'Learner is UNDERCONFIDENT: make the correct answer clearly best; use an encouraging, supportive explanation tone.';

  const efRule =
    ef > 70
      ? 'Include at least one compare-and-contrast or if-then reasoning element somewhere in the cards.'
      : '';

  // ── Card counts ───────────────────────────────────────────
  // Scale up when real source content is provided — more material = more cards
  const hasContent     = !!content;
  const summaryCount   = hasContent ? (wm  > 70 ? 8 : 6) : (wm  > 70 ? 5 : 3);
  const flashcardCount = hasContent ? (att > 70 ? 8 : 6) : (att > 70 ? 4 : 2);
  const stepCount      = hasContent ? (att > 70 ? 6 : 4) : (att > 70 ? 5 : 3);
  const quizCount      = hasContent ? (fi  > 60 ? 5 : 3) : (fi  > 60 ? 2 : 1);

  const contentBlock = content
    ? `\n\nSOURCE CONTENT — derive ALL facts, examples, and terminology exclusively from this text. Do NOT add general knowledge not present here:\n"""\n${content.slice(0, 40000)}\n"""\n\nCOVERAGE REQUIREMENT: Your cards must span the FULL breadth of the source — cover every major section, concept, and specific detail present. Do not cluster around the opening paragraphs.\n\nSPECIFIC DETAIL RULES — if the source contains any of the following, you MUST include them:\n• Mnemonics and memory tips (e.g. "A for Artery, Away from the heart") — put these in flashcards and summary\n• Procedural/step-by-step sequences (e.g. blood flow order, centrifuge separation steps) — use the animation card to tell this story in sequence\n• Lab or measurement activities (e.g. pulse formula, centrifuge density order) — include in flashcards\n• Named diseases or disorders — cover cause, mechanism, and effect\n• Answer keys or model answers — use their exact wording as flashcard answers`
    : '\n\n(No source text — generate accurate general knowledge for this topic.)';

  return `You are an expert adaptive learning card generator for Sprout, a science-backed study app. Your output is calibrated precisely to the learner's cognitive profile.

TOPIC: "${topic}"${contentBlock}

━━━ LEARNER COGNITIVE PROFILE ━━━
Working memory        ${wm}/100   ${wm < 50 ? '(limited — small chunks essential)' : wm > 70 ? '(strong — can handle more at once)' : '(average)'}
Processing speed      ${ps}/100   ${ps < 50 ? '(slower — simplify syntax)' : ps > 70 ? '(fast — complexity is fine)' : '(average)'}
Fluid reasoning       ${fi}/100   ${fi < 50 ? '(concrete thinker — use examples, not abstraction)' : fi > 70 ? '(abstract thinker — inference and analysis welcome)' : '(average)'}
Executive function    ${ef}/100   ${ef < 50 ? '(lower — avoid multi-step switching in one question)' : ef > 70 ? '(high — challenge with complexity)' : '(average)'}
Sustained attention   ${att}/100  ${att < 50 ? '(low — short, punchy content)' : att > 70 ? '(high — richer explanations welcome)' : '(average)'}

━━━ MANDATORY ADAPTATION RULES ━━━
1. READING LEVEL   → Grade ${gradeLevel} (Flesch-Kincaid). Max ${wordLimit} words per bullet or step.
2. COGNITIVE LEVEL → ${bloomsTarget}
3. CHUNK SIZE      → ${chunkRule}
4. SENTENCES       → ${sentenceRule}
5. QUIZ CALIBRATION→ ${confidenceRule}${efRule ? `\n6. REASONING       → ${efRule}` : ''}

━━━ STATIC CARD SPECIFICATIONS ━━━
• summary:   ${summaryCount} bullet points. Each ≤${wordLimit} words. Hook the student — open with the most surprising or important idea.
• flashcards:${flashcardCount} pairs. Questions target the Bloom's level above. Answers ≤2 sentences.
• animation: ${stepCount} steps. Tell a STORY — foundational → mechanistic → real-world consequence. Each step should feel like the next scene in a narrative.
• quiz:      ${quizCount} question(s). Four options (A–D). correctIndex is 0-based. Explanation addresses the most tempting wrong answer.

━━━ TEACHING PHILOSOPHY — READ THIS FIRST ━━━
The interactive components below ARE the lesson. They must TEACH, not just test.
Think like an educational designer building an immersive experience, not a test author.

TEACHING STYLE adapted to this learner:
${wm < 50   ? '• Low working memory → Use narrative and story to carry context. One idea per screen. Use characters or journeys so the student does not have to hold the structure in their head.' : ''}
${fi < 50   ? '• Concrete thinker → Anchor every concept in a vivid real-world analogy or scenario embedded visually in the component.' : ''}
${fi >= 70  ? '• Abstract thinker → Include cause-and-effect exploration, what-if scenarios, and system-level thinking.' : ''}
${att < 50  ? '• Low attention → Short punchy animated segments (≤10 seconds each). Gamify. Add rewards, progress bars, satisfying click feedback.' : ''}
${att >= 70 ? '• High attention → Rich layered content. Progressive disclosure with depth. Complex visuals with detail to explore.' : ''}
${ef >= 70  ? '• High executive function → Include guided discovery and hypothesis-testing. Let the student manipulate variables and see outcomes.' : ''}

━━━ INTERACTIVE COMPONENTS — 4 REQUIRED ━━━
Generate exactly 4 interactive components. Follow this mandatory split:

  TEACHING TYPES (choose at least 2 — these explain and show):
    comic | choose_adventure | infographic | simulation | concept_map |
    mindmap | timeline | data_visualization | labeling_diagram | 3d_viewer |
    step_animation | graph_plotter

  PRACTICE TYPES (choose at most 2 — these consolidate learning):
    fill_in_blank | matching_game | drag_drop | word_search | crossword |
    sequence_order | math_problems | code_challenge | comparison_table

For each component write a COMPLETE self-contained HTML document.

━━━ HTML QUALITY STANDARDS — NON-NEGOTIABLE ━━━
1. MOTION IS MANDATORY — every teaching component must animate. Use:
   • CSS @keyframes for entrances, pulses, flows, reveals
   • CSS transitions on all interactive state changes
   • requestAnimationFrame / Canvas for simulations and data viz
   • SVG animations (SMIL or CSS) for diagrams and mindmaps
2. VISUAL POLISH — not plain HTML. Use:
   • Gradients, shadows, rounded corners, glassmorphism where appropriate
   • Emoji and icons as visual anchors
   • Color-coded sections matching the palette below
   • Smooth hover/active states on every clickable element
3. TEACHING COMPONENTS must include a clear narrative arc:
   • comic → panels with speech bubbles, characters, sequenced reveal
   • choose_adventure → branching story with consequences that teach concepts
   • infographic → animated sections that appear sequentially as the student scrolls or clicks
   • simulation → manipulable controls (sliders, toggles) with live visual feedback
   • concept_map / mindmap → nodes that expand on click with animated connections
   • timeline → horizontal or vertical scroll with animated entry per event
   • labeling_diagram → SVG/Canvas diagram with clickable hotspots revealing explanations
4. Zero external dependencies — no CDN, no fetch(), no import. All JS/CSS inline.
5. Fits inside 480 px height. overflow:auto on inner containers, never on body/html.
6. Colour palette (hard-code hex values — no CSS variables):
   bg #FAF7F2 | card #FFFFFF | green #2F9E5E | green-dark #248B4F | green-light #DCEFE2
   ink #1F2937 | ink-mid #4A5563 | ink-muted #8A93A0 | border #ECE7DD
   coral #FF7A5C | gold #F4B740 | sky #4FB7F5 | plum #8C5BD9
7. Font: font-family: -apple-system, "Segoe UI", system-ui, sans-serif
8. All content from SOURCE CONTENT only — no invented facts.
9. Reading level: Grade ${gradeLevel}.
10. JSON safety: the "html" value must be a single valid JSON string.
    Escape every " inside HTML as \\" and every \\ as \\\\.
    No raw newlines — use \\n if needed.

━━━ OUTPUT FORMAT ━━━
Return ONLY valid JSON — no markdown fences, no prose before or after. Schema:

{
  "topic": "3–5 word label",
  "summary": {
    "title": "Key concepts — <topic>",
    "points": ["...", ...]
  },
  "flashcards": [
    { "question": "...", "answer": "..." }
  ],
  "animation": {
    "title": "How it works, step by step",
    "steps": [{ "icon": "one emoji", "title": "3–6 words", "description": "..." }]
  },
  "quiz": [
    {
      "question":    "...",
      "options":     ["A ...", "B ...", "C ...", "D ..."],
      "correctIndex": 0,
      "explanation": "..."
    }
  ],
  "interactives": [
    { "type": "comic",          "title": "A day in the life of a red blood cell",    "html": "<!DOCTYPE html>..." },
    { "type": "choose_adventure","title": "Journey through the circulatory system",   "html": "<!DOCTYPE html>..." },
    { "type": "labeling_diagram","title": "Label the heart chambers",                "html": "<!DOCTYPE html>..." },
    { "type": "drag_drop",      "title": "Sort blood components by function",        "html": "<!DOCTYPE html>..." }
  ]
}`;
}

// ── Chat helpers ─────────────────────────────────────────────

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

/** Builds the system prompt for the per-card tutor chat. */
export function buildChatSystemPrompt(
  topic: string,
  sourceContent: string | null,
  cardDescription: string,
  profile: LearnerProfile | null,
): string {
  const wm  = profile?.workingMemory?.score    ?? 60;
  const ps  = profile?.processingSpeed?.score  ?? 60;
  const fi  = profile?.fluidIntelligence?.score ?? 60;

  const grade     = wm < 40 && ps < 40 ? '6–7' : wm > 70 && ps > 70 ? '10–12' : '8–9';
  const tone      = fi < 50
    ? 'Prefer concrete examples and everyday analogies. Avoid abstract language.'
    : 'Abstract explanations and comparisons are welcome.';
  const brevity   = wm < 50
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

/** Streams a tutor chat response chunk by chunk, calling onChunk for each text delta. */
export async function streamCardChat(
  history: ChatMessage[],
  systemPrompt: string,
  onChunk: (text: string) => void,
): Promise<void> {
  const client = getClient();

  const stream = await client.messages.create({
    model:      'claude-sonnet-4-6',
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

// ── Interactives-only generator ───────────────────────────────

export interface Interactive {
  type:      string;
  title:     string;
  objective: string;
  html:      string;
}

export interface GeneratedInteractives {
  topic:        string;
  interactives: Interactive[];
}

// Internal — produced by Sonnet, consumed by Haiku
interface ComponentBrief {
  type:      string;
  title:     string;
  objective: string;
  content:   string; // everything Haiku needs to know about the subject matter
}

// ── Phase 1: Sonnet plans what to build ──────────────────────

function buildPlanningPrompt(topic: string, hasNativePdf: boolean, contentText: string | null): string {
  const sourceNote = hasNativePdf
    ? 'The full document (text and images) is attached above.'
    : contentText
      ? `SOURCE TEXT:\n"""\n${contentText.slice(0, 40_000)}\n"""`
      : '(No source provided — use accurate general knowledge for this topic.)';

  return `You are an expert educational designer. Analyse the provided content and plan 5 interactive learning components that together form a complete lesson.

TOPIC: "${topic}"
${sourceNote}

Design the components in this arc:
1. HOOK     — the most surprising or counterintuitive idea; grabs attention immediately
2. EXPLAIN  — animated visual explanation of the core concept
3. EXPLORE  — student manipulates something and sees real-time consequences
4. PRACTICE — active recall; student produces answers from the source material
5. CHALLENGE — hardest synthesis problem; use exact exercises and answers from the source

Choose the component type that best serves each arc position. Use domain knowledge:
• Mathematics  → graph_plotter, simulation, concept_classifier, math_problems, matching_game
• Biology      → labeling_diagram, simulation, timeline, choose_adventure, matching_game
• Chemistry    → simulation, step_animation, labeling_diagram, comparison_table
• Physics      → simulation, graph_plotter, step_animation, math_problems
• History      → timeline, choose_adventure, data_visualization, infographic, comparison_table
• Language     → fill_in_blank, matching_game, choose_adventure, infographic

Rules:
• At least 3 teaching types (graph_plotter, simulation, infographic, labeling_diagram, timeline, step_animation, choose_adventure, concept_classifier, data_visualization)
• At most 2 practice types (matching_game, fill_in_blank, drag_drop, math_problems, comparison_table, sequence_order)
• The "content" field must be fully self-contained — include every fact, formula, worked example, and answer the HTML developer will need. Be specific and thorough.
• Base everything only on the provided source. Do not invent facts.

Return only valid JSON:
{
  "topic": "3–5 word label",
  "interactives": [
    {
      "type": "graph_plotter",
      "title": "Watch 1/x approach zero",
      "objective": "After this, the student can explain why lim(x→∞) 1/x = 0 using the graph.",
      "content": "The function f(x) = 1/x. As x increases without bound, f(x) approaches 0. Examples: f(10)=0.1, f(100)=0.01, f(1000)=0.001. The limit is 0. Show the curve approaching but never touching the x-axis (the asymptote)."
    }
  ]
}`;
}

// Close any JSON structure that was truncated at the token limit
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

  // Strip any trailing comma before we close (e.g., last item was cut mid-array)
  let repaired = s.replace(/,\s*$/, '');
  return repaired + stack.reverse().join('');
}

async function planInteractives(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
): Promise<ComponentBrief[]> {
  const client = getClient();

  type UserContent = Array<{ type: 'text'; text: string } | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }>;
  const userContent: UserContent = [];

  if (pdfBase64) {
    userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } });
  }
  userContent.push({ type: 'text', text: buildPlanningPrompt(topic, !!pdfBase64, contentText) });

  const msg = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 8000,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: userContent as Parameters<typeof client.messages.create>[0]['messages'][0]['content'] }],
  });

  const raw   = msg.content.find(b => b.type === 'text')?.text ?? '';

  // Extract the JSON object, stripping any markdown code fences Sonnet may add
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1) throw new Error('Planning phase failed — no JSON found. Please retry.');

  // Slice from first { to last } (discards trailing ``` fences)
  let jsonStr = end > start ? raw.slice(start, end + 1) : raw.slice(start);

  // If the response was cut off (no closing brace, or token limit hit), repair
  if (msg.stop_reason === 'max_tokens' || end <= start) {
    jsonStr = repairJson(jsonStr);
  }

  let plan: { topic?: string; interactives: ComponentBrief[] };
  try {
    plan = JSON.parse(jsonStr);
  } catch {
    // Last resort: try repairing regardless of stop_reason
    try {
      plan = JSON.parse(repairJson(jsonStr));
    } catch (e2) {
      throw new Error(`Planning phase returned invalid JSON. Please retry. (${e2 instanceof Error ? e2.message : e2})`);
    }
  }

  if (!Array.isArray(plan.interactives) || plan.interactives.length === 0) {
    throw new Error('Planning phase returned no components. Please retry.');
  }

  return plan.interactives;
}

// ── Phase 2: Haiku generates HTML for each component ─────────

function buildComponentPrompt(brief: ComponentBrief): string {
  return `Build a self-contained, visually stunning HTML5 interactive learning component.

Type: ${brief.type}
Title: ${brief.title}
Objective: ${brief.objective}

Content to teach:
${brief.content}

Technical requirements (non-negotiable):
• One complete HTML file — no external dependencies, no CDN links, no fetch()
• <html> and <body>: margin:0; padding:0; — do NOT set overflow:hidden or a fixed height on body/html; let content define its own natural height
• On load AND whenever content changes size, report height: window.parent.postMessage({type:'sprout:resize',height:document.body.scrollHeight},'*')
• Inner scrollable panels are fine with overflow:auto, but never clip the overall page content
• Colour palette (hard-code hex values): bg #FAF7F2, card #FFFFFF, green #2F9E5E, coral #FF7A5C, gold #F4B740, sky #4FB7F5, plum #8C5BD9, ink #1F2937, ink-mid #4A5563, border #ECE7DD
• Font: -apple-system, "Segoe UI", system-ui, sans-serif
• Use Unicode for maths: ² ³ → ∞ π ≤ ≥ ≠ ≈ (never write x2, ex, ->, inf)

Make it as beautiful, animated, and interactive as possible. Use Canvas, SVG, CSS animations, requestAnimationFrame — whatever best serves the learning.

Return ONLY the complete HTML document starting with <!DOCTYPE html>. Nothing else.`;
}

async function generateComponent(
  client: Anthropic,
  brief:  ComponentBrief,
): Promise<string> {
  const stream = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    system:     'You are a creative web developer building educational interactive components. Return ONLY a complete valid HTML document starting with <!DOCTYPE html>. No explanations, no markdown fences.',
    messages:   [{ role: 'user', content: buildComponentPrompt(brief) }],
    stream:     true,
  });

  let html = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      html += event.delta.text;
    }
  }

  // Strip any preamble Haiku may add before <!DOCTYPE html>
  const match = html.match(/<!DOCTYPE\s+html[\s\S]*/i);
  return match ? match[0].trim() : html.trim();
}

// ── Orchestrator ──────────────────────────────────────────────

export async function generateInteractives(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
  onProgress?: (update: 'planning' | number) => void,
): Promise<GeneratedInteractives> {
  // Phase 1 — Sonnet reads the content and plans 5 component briefs
  onProgress?.('planning');
  const briefs = await planInteractives(topic, contentText, pdfBase64);

  // Phase 2 — Haiku generates all 5 HTML components in parallel
  onProgress?.(0);
  const client = getClient();
  let completed = 0;

  const htmlResults = await Promise.all(
    briefs.map(async brief => {
      const html = await generateComponent(client, brief);
      onProgress?.(++completed);
      return html;
    }),
  );

  return {
    topic: topic,
    interactives: briefs.map((brief, i) => ({
      type:      brief.type,
      title:     brief.title,
      objective: brief.objective,
      html:      htmlResults[i],
    })),
  };
}

// ── Flashcard generator ───────────────────────────────────────

export interface Flashcard {
  question: string;
  answer:   string;
}

export async function generateFlashcards(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
): Promise<Flashcard[]> {
  const client = getClient();

  const sourceNote = pdfBase64
    ? 'The full document is attached above.'
    : contentText
      ? `SOURCE TEXT:\n"""\n${contentText.slice(0, 40_000)}\n"""`
      : '(No source — use accurate general knowledge for this topic.)';

  const prompt = `Generate 12 high-quality flashcards for: "${topic}".

${sourceNote}

Rules:
- Cover the full breadth of the material, not just the opening sections
- Questions test understanding, not just surface recall
- Answers are concise: 1–3 sentences max
- Include key definitions, formulas, procedures, and worked examples

Return ONLY valid JSON — no markdown fences:
{"flashcards": [{"question": "...", "answer": "..."}, ...]}`;

  type MsgContent = Parameters<typeof client.messages.create>[0]['messages'][0]['content'];

  const model = pdfBase64 ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
  const content: MsgContent = pdfBase64
    ? ([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt },
      ] as MsgContent)
    : prompt;

  const msg = await client.messages.create({
    model, max_tokens: 4000,
    system:   'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages: [{ role: 'user', content }],
  });

  const raw   = msg.content.find(b => b.type === 'text')?.text ?? '';
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Failed to generate flashcards. Please retry.');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed.flashcards)) throw new Error('Invalid flashcard response. Please retry.');
  return parsed.flashcards as Flashcard[];
}

// ── Quiz generator ────────────────────────────────────────────

export interface QuizQuestion {
  question:     string;
  options:      string[];
  correctIndex: number;
  explanation:  string;
}

export async function generateQuiz(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
): Promise<QuizQuestion[]> {
  const client = getClient();

  const sourceNote = pdfBase64
    ? 'The full document is attached above.'
    : contentText
      ? `SOURCE TEXT:\n"""\n${contentText.slice(0, 40_000)}\n"""`
      : '(No source — use accurate general knowledge for this topic.)';

  const prompt = `Generate 8 multiple-choice quiz questions for: "${topic}".

${sourceNote}

Rules:
- Span the full breadth of the material
- Each question has exactly 4 options
- correctIndex is 0-based (0 = first option)
- Distractors must be plausible — not obviously wrong
- Explanation addresses the most tempting wrong answer (2–3 sentences)

Return ONLY valid JSON — no markdown fences:
{"questions": [{"question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0, "explanation": "..."}, ...]}`;

  type MsgContent = Parameters<typeof client.messages.create>[0]['messages'][0]['content'];

  const model = pdfBase64 ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
  const content: MsgContent = pdfBase64
    ? ([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt },
      ] as MsgContent)
    : prompt;

  const msg = await client.messages.create({
    model, max_tokens: 4000,
    system:   'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages: [{ role: 'user', content }],
  });

  const raw   = msg.content.find(b => b.type === 'text')?.text ?? '';
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Failed to generate quiz. Please retry.');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed.questions)) throw new Error('Invalid quiz response. Please retry.');
  return parsed.questions as QuizQuestion[];
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

export async function generateFeed(
  topic:       string,
  contentText: string | null,
  pdfBase64:   string | null,
  mode:        'activities' | 'flashcards' | 'quiz' = 'activities',
): Promise<FeedCard[]> {
  const client = getClient();

  const promptFn = mode === 'flashcards' ? buildFlashcardsOnlyPrompt
    : mode === 'quiz'       ? buildQuizOnlyPrompt
    : buildActivitiesPrompt;

  const maxTokens = mode === 'flashcards' ? 5000 : mode === 'quiz' ? 4000 : 7000;

  type MsgContent = Parameters<typeof client.messages.create>[0]['messages'][0]['content'];
  const userContent: MsgContent = pdfBase64
    ? ([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: promptFn(topic, contentText, true) },
      ] as MsgContent)
    : promptFn(topic, contentText, false);

  const model = pdfBase64 ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';

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

// ── Main generator ────────────────────────────────────────────

export async function generateFeedCards(
  topic:   string,
  content: string | null,
  profile: LearnerProfile | null
): Promise<GeneratedCards> {
  const client = getClient();

  const msg = await client.messages.create({
    model:      'claude-opus-4-7',
    max_tokens: 16000,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text. When writing HTML inside JSON string values, escape all double-quotes as \\" and all backslashes as \\\\, and represent newlines as \\n so the result is a valid single-line JSON string.',
    messages:   [{ role: 'user', content: buildPrompt(topic, content, profile) }],
  });

  const raw   = msg.content.find(b => b.type === 'text')?.text ?? '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude returned an unexpected response. Please retry.');
  return JSON.parse(match[0]) as GeneratedCards;
}
