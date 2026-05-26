import { GoogleGenAI } from '@google/genai';
import { dbLogUsage } from './supabase';

// ── Model ──────────────────────────────────────────────────────
// Use Flash for exam tasks — stays well within Netlify's 26s timeout.
const EXAM_MODEL = 'gemini-2.5-flash';

// ── Types ──────────────────────────────────────────────────────

export interface ExamQuestion {
  id: string;
  number: string;
  type: 'mcq' | 'short' | 'calculation' | 'essay';
  topic: string;
  marks: number;
  stem: string;
  context?: string;
  /** MCQ only — exactly 4 items like ["A. Option one", "B. Option two", …] */
  options?: string[];
  modelAnswer: string;
  markingGuidance?: string;
}

export interface GeneratedExam {
  title: string;
  subject: string;
  grade: string;
  totalMarks: number;
  durationMinutes: number;
  instructions: string[];
  questions: ExamQuestion[];
}

export interface QuestionResult {
  questionId: string;
  studentAnswer: string;
  awarded: number;
  total: number;
  percentage: number;
  feedback: string;
  modelAnswer: string;
}

export interface ExamResults {
  totalAwarded: number;
  totalMarks: number;
  percentage: number;
  letterGrade: string;
  results: QuestionResult[];
  overallFeedback: string;
}

// ── Client ─────────────────────────────────────────────────────

function getClient(): GoogleGenAI {
  const USE_PROXY = import.meta.env.VITE_USE_PROXY === 'true';
  if (USE_PROXY) {
    return new GoogleGenAI({
      apiKey:      'via-proxy',
      httpOptions: { baseUrl: `${window.location.origin}/api/gemini` },
    });
  }
  const apiKey =
    (import.meta.env.VITE_GEMINI_API_KEY as string) ||
    localStorage.getItem('sprout:geminiKey') ||
    '';
  if (!apiKey) throw new Error('NO_API_KEY');
  return new GoogleGenAI({ apiKey });
}

// ── Core helpers ─────────────────────────────────────────────────

type Part = { text: string } | { inlineData: { data: string; mimeType: string } };

/**
 * Non-streaming generate — kept for short calls (marking, variants).
 * Do NOT use for large PDF analysis: the proxy blocks waiting for the full
 * Gemini response and Netlify's 26 s edge-function wall-clock kills it.
 */
async function generateText(
  parts:          Part[],
  systemPrompt:   string,
  maxTokens:      number,
  fnName:         string,
  userId:         string | null = null,
): Promise<string> {
  const client = getClient();

  const response = await client.models.generateContent({
    model:    EXAM_MODEL,
    contents: [{ role: 'user', parts }],
    config:   {
      systemInstruction: systemPrompt,
      maxOutputTokens:   maxTokens,
      temperature:       0.1,
      thinkingConfig:    { thinkingBudget: 0 },
    },
  });

  const text = response.text ?? '';

  const usage = response.usageMetadata;
  void dbLogUsage(
    userId, fnName, EXAM_MODEL,
    usage?.promptTokenCount     ?? 0,
    usage?.candidatesTokenCount ?? 0,
  );

  return text;
}

/**
 * Streaming generate — accumulates all SSE chunks and returns the full text.
 * Use for large PDF analysis: the proxy's fetch() resolves on the first chunk
 * (SSE response headers arrive immediately), so Netlify's 26 s timeout is never
 * triggered regardless of how long Gemini takes to finish the full response.
 */
async function generateTextStreaming(
  parts:          Part[],
  systemPrompt:   string,
  maxTokens:      number,
  fnName:         string,
  userId:         string | null = null,
  onChunk?:       (text: string) => void,
): Promise<string> {
  const client = getClient();

  const stream = await client.models.generateContentStream({
    model:    EXAM_MODEL,
    contents: [{ role: 'user', parts }],
    config:   {
      systemInstruction: systemPrompt,
      maxOutputTokens:   maxTokens,
      temperature:       0.1,
      thinkingConfig:    { thinkingBudget: 0 },
    },
  });

  let accumulated = '';
  let inputTokens  = 0;
  let outputTokens = 0;

  for await (const chunk of stream) {
    const t = chunk.text ?? '';
    if (t) {
      accumulated += t;
      onChunk?.(accumulated);
    }
    if (chunk.usageMetadata) {
      inputTokens  = chunk.usageMetadata.promptTokenCount     ?? inputTokens;
      outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
    }
  }

  void dbLogUsage(userId, fnName, EXAM_MODEL, inputTokens, outputTokens);

  return accumulated;
}

/**
 * Comprehensive validator that drops questions with incomplete or unanswerable stems.
 *
 * Categories of failure (apply across ALL subjects):
 *
 * 1. Structural incompleteness — stem ends with a colon, ellipsis, or
 *    dangling sub-question prefix (the model copied a header without the body).
 *
 * 2. Unresolved external references — stem mentions a figure, table, diagram,
 *    graph, source, extract, or passage that is NOT provided in `context`.
 *    A student cannot answer "Refer to Figure 3" if Figure 3 is absent.
 *
 * 3. Vocabulary tasks without target words — "Find antonyms for:" / "Give
 *    synonyms for:" without listing the actual words.
 *
 * 4. Sub-question header only — the model numbered a heading as if it were
 *    a question (e.g. "1.1", "a)") with no actual question body.
 *
 * 5. Trivially short — fewer than 10 characters; cannot be a real question.
 */
function sanitizeQuestions(questions: ExamQuestion[]): ExamQuestion[] {
  // Patterns that signal an unresolved external reference
  const EXTERNAL_REF = /\b(figure\s*\d|table\s*\d|diagram\s*\d|graph\s*\d|source\s*[a-z\d]|the extract|the passage|the text|the article|the poem|the story|refer to|as shown|see above|see below|in the (?:diagram|figure|table|graph|image) (?:above|below|provided))\b/i;

  // Patterns that signal a vocabulary task whose word list is missing
  const VOCAB_NO_WORDS = /\b(antonym|synonym|homophone|homonym|idiom|figure of speech|part of speech|word class|language feature)s?\s+for\s*:?\s*$/i;

  // Patterns that look like a section/sub-question header rather than a question
  const HEADER_ONLY = /^(section|part|question|q)\s*[a-z\d]+\s*[:\-–—]?\s*$/i;
  const SUB_Q_ONLY  = /^\d+\.\d+\s*$/;             // e.g. "1.1" alone

  const reasons: string[] = [];

  const kept = questions.filter(q => {
    const stem = (q.stem ?? '').trim();
    const hasContext = !!q.context?.trim();

    // 5. Too short
    if (stem.length < 10) {
      reasons.push(`Q${q.number}: too short ("${stem}")`);
      return false;
    }

    // 1a. Ends with bare colon → structurally incomplete header
    if (stem.endsWith(':')) {
      reasons.push(`Q${q.number}: stem ends with ":" — header without body ("${stem.slice(0, 60)}")`);
      return false;
    }

    // 1b. Ends with ellipsis → truncated
    if (stem.endsWith('…') || stem.endsWith('...')) {
      reasons.push(`Q${q.number}: stem ends with ellipsis — truncated`);
      return false;
    }

    // 3. Vocabulary task without target words
    if (VOCAB_NO_WORDS.test(stem)) {
      reasons.push(`Q${q.number}: vocabulary task with no target words ("${stem.slice(0, 60)}")`);
      return false;
    }

    // 4. Section header or bare sub-question number
    if (HEADER_ONLY.test(stem) || SUB_Q_ONLY.test(stem)) {
      reasons.push(`Q${q.number}: looks like a section header, not a question ("${stem}")`);
      return false;
    }

    // 2. Unresolved external reference (only a problem when context is absent)
    if (!hasContext && EXTERNAL_REF.test(stem)) {
      reasons.push(`Q${q.number}: references external content with no context field ("${stem.slice(0, 80)}")`);
      return false;
    }

    return true;
  });

  if (reasons.length > 0) {
    console.warn(
      `[examClaude] sanitizeQuestions: dropped ${reasons.length} incomplete question(s):\n` +
      reasons.map(r => `  • ${r}`).join('\n'),
    );
  }

  return kept;
}

/** Close any unclosed brackets left by a truncated streaming response. */
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
  // Strip markdown code fences the model occasionally emits despite instructions
  const stripped = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '');
  const start = stripped.indexOf('{');
  const end   = stripped.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in AI response.');
  return stripped.slice(start, end + 1);
}

function parseExamJson(raw: string): GeneratedExam {
  const slice = extractJson(raw);
  try   { return JSON.parse(slice) as GeneratedExam; }
  catch { return JSON.parse(repairJson(slice)) as GeneratedExam; }
}

// ── Exam generation ─────────────────────────────────────────────

/**
 * Analyses 1+ past exam papers (base64 PDFs and/or Word documents) and
 * generates a new practice exam that mirrors their style, topics, and difficulty.
 */
export async function analyzeAndGenerateExam(
  pdfBase64Array: string[],
  onProgress?: (msg: string) => void,
  userId?: string | null,
  textDocs: { name: string; content: string }[] = [],
): Promise<GeneratedExam> {
  onProgress?.('Analysing your past exam papers…');

  const pdfParts: Part[] = pdfBase64Array.map(b64 => ({
    inlineData: { data: b64, mimeType: 'application/pdf' },
  }));

  // Embed Word/text documents as labelled text blocks
  const textParts: Part[] = textDocs.map(doc => ({
    text: `\n\n--- BEGIN EXAM PAPER: ${doc.name} ---\n${doc.content}\n--- END EXAM PAPER: ${doc.name} ---\n`,
  }));

  const totalPapers = pdfBase64Array.length + textDocs.length;

  const prompt = `I am providing ${totalPapers} past exam paper${totalPapers !== 1 ? 's' : ''}${textDocs.length > 0 ? ` (${pdfBase64Array.length > 0 ? `${pdfBase64Array.length} PDF${pdfBase64Array.length !== 1 ? 's' : ''} and ` : ''}${textDocs.length} Word document${textDocs.length !== 1 ? 's' : ''})` : ''}. Analyse them carefully, then generate a completely NEW practice exam that:
- Matches the exact style, structure, and format of these papers
- Tests the same curriculum topics at the same difficulty and cognitive level
- Has proportionally similar mark allocation, question types, and difficulty spread
- Uses NSC/CAPS marking conventions (e.g. accept alternatives where appropriate)
- Has realistic NSC-style question stems, scenarios, and stimulus material

Detect the subject and grade from the papers. Generate 15–25 questions spread across question types found in the originals.

Return ONLY valid JSON — no markdown fences, no explanation:
{
  "title": "Practice Examination Paper",
  "subject": "detected subject name",
  "grade": "Grade 12",
  "totalMarks": 150,
  "durationMinutes": 180,
  "instructions": [
    "Read all questions carefully before answering.",
    "Answer ALL questions.",
    "Number your answers correctly according to the numbering system used in the question paper.",
    "Write neatly and legibly."
  ],
  "questions": [
    {
      "id": "q1",
      "number": "1",
      "type": "mcq",
      "topic": "Topic name",
      "marks": 2,
      "stem": "The full question text here?",
      "context": "Optional stimulus material, table, or background info. Omit if not needed.",
      "options": ["A. Option one", "B. Option two", "C. Option three", "D. Option four"],
      "modelAnswer": "B",
      "markingGuidance": "Award 2 marks for B. No partial marks."
    },
    {
      "id": "q2",
      "number": "2",
      "type": "short",
      "topic": "Topic name",
      "marks": 4,
      "stem": "Explain how X affects Y. (4)",
      "modelAnswer": "Full model answer with key points listed.",
      "markingGuidance": "1 mark per valid point, max 4. Accept any reasonable alternative."
    },
    {
      "id": "q3",
      "number": "3",
      "type": "calculation",
      "topic": "Topic name",
      "marks": 6,
      "stem": "Calculate the value of Z given that… Show all working.",
      "modelAnswer": "Step 1: ...\\nStep 2: ...\\nAnswer: 42 units",
      "markingGuidance": "2 marks method, 2 marks substitution, 1 mark calculation, 1 mark units."
    }
  ]
}

Question type rules:
- "mcq": Multiple choice. ALWAYS include exactly 4 options (A, B, C, D). modelAnswer is the letter only, e.g. "C".
- "short": Short paragraph answer (2–6 marks). modelAnswer lists key marking points.
- "calculation": Numerical/mathematical/scientific calculation (3–10 marks). modelAnswer is full worked solution.
- "essay": Extended writing (8–20 marks). modelAnswer is a paragraph plan or rubric.

SELF-CONTAINMENT RULES — apply to every question in every subject:
A student must be able to read a question and answer it with ONLY the information in "stem" and "context". They cannot see the original exam paper.

FORBIDDEN in "stem" (will be automatically dropped):
✗ Stems that end with ":" — always incomplete (a header, not a question)
✗ Stems that end with "..." — truncated
✗ Any reference to "Figure N", "Table N", "Diagram N", "Graph N", "Source A/B/C", "the extract", "the passage", "the poem", "the text", "the article", "refer to...", "as shown", "see above/below" — UNLESS that content is fully reproduced in the "context" field
✗ Vocabulary tasks without target words: NEVER write "Find antonyms for:" — write "Find words from the extract that are antonyms for: dark, noisy, warm (3)"
✗ Sub-question header lines without a question body (e.g. "1.1" alone, or "Section B:")

REQUIRED for each question type:
✓ Comprehension/language: put the passage/poem/extract in "context"; ask a specific question in "stem"
✓ Data/graph questions: reproduce the table, data set, or describe the graph fully in "context"
✓ Vocabulary (antonyms, synonyms, homophones, word class, idioms): list every target word inside "stem"
✓ Calculation: include ALL given values, units, and formulae needed in "stem" or "context"
✓ Diagram-based (Biology, Geography, Physics): describe or reproduce the diagram in "context"
✓ Multi-part source questions (History, English): put each source in "context"; write a separate complete question per source

IMPORTANT: The sum of all question marks must equal totalMarks.`;

  onProgress?.('Generating your personalised practice exam…');

  // Use streaming so the proxy's fetch() resolves on the first SSE chunk —
  // avoids Netlify's 26 s edge-function timeout on large multi-PDF requests.
  const raw = await generateTextStreaming(
    [...pdfParts, ...textParts, { text: prompt }],
    'You are an expert NSC (South African National Senior Certificate) / CAPS curriculum exam paper designer. Output only valid JSON — no markdown, no extra text.',
    16000,
    'analyzeAndGenerateExam',
    userId ?? null,
  );

  onProgress?.('Finalising exam…');

  let exam: GeneratedExam;
  try {
    exam = parseExamJson(raw);
  } catch {
    console.error('[analyzeAndGenerateExam] raw response (first 500 chars):', raw.slice(0, 500));
    throw new Error('Failed to parse exam from AI response. Please retry.');
  }

  if (!Array.isArray(exam.questions) || exam.questions.length === 0) {
    throw new Error('Failed to generate exam questions. Please retry.');
  }

  exam.questions = sanitizeQuestions(
    exam.questions.map((q, i) => ({
      id:              q.id     ?? `q${i + 1}`,
      number:          q.number ?? String(i + 1),
      type:            (['mcq', 'short', 'calculation', 'essay'].includes(q.type) ? q.type : 'short') as ExamQuestion['type'],
      topic:           q.topic  ?? 'General',
      marks:           typeof q.marks === 'number' ? q.marks : 2,
      stem:            q.stem   ?? '',
      context:         q.context,
      options:         q.options,
      modelAnswer:     q.modelAnswer    ?? '',
      markingGuidance: q.markingGuidance,
    })),
  );

  if (exam.questions.length === 0) {
    throw new Error('All generated questions were incomplete. Please retry.');
  }

  return exam;
}

// ── Variant generation ──────────────────────────────────────────

/**
 * Generates a brand-new practice exam covering the same curriculum topics
 * as `sourceExam` but with completely different question stems, numbers,
 * scenarios, and stimulus material.
 */
export async function generateExamVariant(
  sourceExam:    GeneratedExam,
  previousExams: GeneratedExam[] = [],
  onProgress?:   (msg: string) => void,
  userId?:       string | null,
): Promise<GeneratedExam> {
  onProgress?.('Generating a new exam variant…');

  const topicRows = sourceExam.questions
    .map(q => `  Q${q.number} [${q.type}, ${q.marks}m, ${q.topic}]: ${q.stem.slice(0, 90)}`)
    .join('\n');

  const seenBlock = previousExams.length
    ? `\nPREVIOUS VARIANT QUESTIONS (do NOT reuse these stems or scenarios):\n` +
      previousExams.flatMap(e => e.questions).map(q =>
        `  [${q.type}] ${q.stem.slice(0, 80)}`
      ).join('\n')
    : '';

  const variantNum = previousExams.length + 2;

  const prompt = `I need Variant ${variantNum} of a ${sourceExam.subject} (${sourceExam.grade}) practice exam.

SOURCE EXAM STRUCTURE (replicate topics & mark distribution — NOT the questions):
${topicRows}
${seenBlock}

Generate a COMPLETELY NEW practice exam that:
- Covers the EXACT same syllabus topics as the source exam above
- Keeps the same total marks (${sourceExam.totalMarks}) and duration (${sourceExam.durationMinutes} min)
- Uses DIFFERENT question stems, numbers, real-world contexts, and stimulus material
- Still follows NSC/CAPS style and marking conventions
- Has the same spread of question types (MCQ, short, calculation, essay) as the source

Return ONLY valid JSON — no markdown fences, no explanation:
{
  "title": "Practice Examination — Variant ${variantNum}",
  "subject": "${sourceExam.subject}",
  "grade": "${sourceExam.grade}",
  "totalMarks": ${sourceExam.totalMarks},
  "durationMinutes": ${sourceExam.durationMinutes},
  "instructions": ${JSON.stringify(sourceExam.instructions)},
  "questions": [
    {
      "id": "q1", "number": "1", "type": "mcq", "topic": "...",
      "marks": 2, "stem": "...", "options": ["A. …","B. …","C. …","D. …"],
      "modelAnswer": "B", "markingGuidance": "..."
    }
  ]
}

SELF-CONTAINMENT RULE: Every question must be answerable using only "stem" + "context" — the student cannot see the original paper. Never end a stem with ":". Never reference figures, tables, diagrams, passages, or sources unless reproduced in "context". Vocabulary tasks (antonyms, synonyms, etc.) must list ALL target words in the stem.

IMPORTANT: Sum of all question marks must equal ${sourceExam.totalMarks}.`;

  onProgress?.('Building variant questions…');

  const raw = await generateText(
    [{ text: prompt }],
    'You are an expert NSC (South African National Senior Certificate) / CAPS curriculum exam paper designer. Output only valid JSON — no markdown, no extra text.',
    12000,
    'generateExamVariant',
    userId ?? null,
  );

  onProgress?.('Finalising variant…');

  let exam: GeneratedExam;
  try {
    exam = JSON.parse(extractJson(raw)) as GeneratedExam;
  } catch {
    throw new Error('Failed to parse exam variant from AI response. Please retry.');
  }

  if (!Array.isArray(exam.questions) || exam.questions.length === 0) {
    throw new Error('Failed to generate variant questions. Please retry.');
  }

  exam.questions = sanitizeQuestions(
    exam.questions.map((q, i) => ({
      id:              q.id     ?? `q${i + 1}`,
      number:          q.number ?? String(i + 1),
      type:            (['mcq', 'short', 'calculation', 'essay'].includes(q.type) ? q.type : 'short') as ExamQuestion['type'],
      topic:           q.topic  ?? 'General',
      marks:           typeof q.marks === 'number' ? q.marks : 2,
      stem:            q.stem   ?? '',
      context:         q.context,
      options:         q.options,
      modelAnswer:     q.modelAnswer    ?? '',
      markingGuidance: q.markingGuidance,
    })),
  );

  if (exam.questions.length === 0) {
    throw new Error('All generated questions were incomplete. Please retry.');
  }

  return exam;
}

// ── Marking ─────────────────────────────────────────────────────

/**
 * Sends the completed exam + student answers to Gemini for marking.
 * Returns per-question scores, feedback, and an overall grade.
 */
export async function markExamSubmission(
  exam:    GeneratedExam,
  answers: Record<string, string>,
  onProgress?: (msg: string) => void,
  userId?: string | null,
): Promise<ExamResults> {
  onProgress?.('Marking your answers…');

  const answerData = exam.questions.map(q => ({
    id:              q.id,
    number:          q.number,
    type:            q.type,
    marks:           q.marks,
    question:        q.stem,
    modelAnswer:     q.modelAnswer,
    markingGuidance: q.markingGuidance ?? '',
    studentAnswer:   answers[q.id] ?? '(no answer provided)',
  }));

  const prompt = `Mark these student answers strictly and fairly according to NSC marking guidelines.

EXAM: ${exam.subject} — ${exam.grade}
TOTAL MARKS AVAILABLE: ${exam.totalMarks}

QUESTIONS AND STUDENT ANSWERS:
${JSON.stringify(answerData, null, 2)}

Marking rules:
- MCQ: Full marks if the student's letter matches the model answer exactly (case-insensitive). 0 if wrong or blank.
- Short answer: Award 1 mark per valid point, up to the maximum. Accept reasonable alternatives.
- Calculation: Award marks for correct method (even with arithmetic error), correct substitution, correct answer, correct units.
- Essay: Use a holistic rubric — content accuracy, structure, depth, and relevance.
- Be honest — do not inflate marks. Students need accurate feedback to improve.

Letter grade thresholds: A: 80–100%, B: 70–79%, C: 60–69%, D: 50–59%, E: 40–49%, F: 30–39%, G: 0–29%

Return ONLY valid JSON — no markdown:
{
  "totalAwarded": 95,
  "totalMarks": ${exam.totalMarks},
  "percentage": 63.3,
  "letterGrade": "C",
  "results": [
    {
      "questionId": "q1",
      "studentAnswer": "...",
      "awarded": 2,
      "total": 2,
      "percentage": 100,
      "feedback": "Correct! / specific constructive 1-2 sentence feedback",
      "modelAnswer": "the correct answer / full worked solution"
    }
  ],
  "overallFeedback": "2-3 sentences: overall performance assessment, strongest area identified, and 1 concrete improvement suggestion"
}`;

  onProgress?.('Calculating your results…');

  const raw = await generateText(
    [{ text: prompt }],
    'You are an expert NSC marker. Output only valid JSON — no markdown, no extra text.',
    8000,
    'markExamSubmission',
    userId ?? null,
  );

  let results: ExamResults;
  try {
    results = JSON.parse(extractJson(raw)) as ExamResults;
  } catch {
    throw new Error('Failed to parse marking results. Please retry.');
  }

  if (!Array.isArray(results.results)) {
    throw new Error('Invalid marking response. Please retry.');
  }

  results.totalAwarded = Math.min(results.totalAwarded ?? 0, exam.totalMarks);
  results.percentage   = results.percentage ?? Math.round((results.totalAwarded / exam.totalMarks) * 1000) / 10;
  results.letterGrade  = results.letterGrade ?? gradeFromPct(results.percentage);

  return results;
}

// ── Exam from notes ──────────────────────────────────────────────

/**
 * Generates a practice exam from the document's content map topic titles.
 * Using topic titles (not the raw PDF) avoids API timeouts on large documents
 * while still guaranteeing full coverage — every section is listed explicitly
 * and the model must produce at least one question per section.
 */
export async function generateExamFromNotes(
  topicTitles: string[],
  topic:       string,
  onProgress?: (msg: string) => void,
  userId?:     string | null,
): Promise<GeneratedExam> {
  onProgress?.('Building exam from your document sections…');

  const sectionList = topicTitles.map((t, i) => `${i + 1}. ${t}`).join('\n');

  const prompt = `You are creating a practice exam for the subject: "${topic}".

The document contains these sections (in order):
${sectionList}

Your task:
- Generate 15–25 questions that are spread proportionally across these sections
- Produce AT LEAST one question for every section listed above
- Use a mix of types: mcq (multiple choice), short (2–6 marks), essay (8–15 marks)
- The "topic" field in each question must exactly match one of the section names above
- Questions must test understanding, not just recall
- MCQ must have exactly 4 options (A, B, C, D)
- Total marks must add up to exactly 100

Return ONLY valid JSON — no markdown fences:
{
  "title": "Practice Exam: ${topic}",
  "subject": "${topic}",
  "grade": "General",
  "totalMarks": 100,
  "durationMinutes": 60,
  "instructions": [
    "Answer ALL questions.",
    "Read each question carefully before answering.",
    "Write neatly and legibly."
  ],
  "questions": [
    {
      "id": "q1",
      "number": "1",
      "type": "mcq",
      "topic": "Exact section name from the list above",
      "marks": 2,
      "stem": "Question text?",
      "options": ["A. Option one", "B. Option two", "C. Option three", "D. Option four"],
      "modelAnswer": "B",
      "markingGuidance": "Award 2 marks for B."
    },
    {
      "id": "q2",
      "number": "2",
      "type": "short",
      "topic": "Exact section name",
      "marks": 4,
      "stem": "Explain...",
      "modelAnswer": "Key points the student should cover.",
      "markingGuidance": "1 mark per valid point, max 4."
    },
    {
      "id": "q3",
      "number": "3",
      "type": "essay",
      "topic": "Exact section name",
      "marks": 10,
      "stem": "Discuss...",
      "modelAnswer": "A well-structured answer would include...",
      "markingGuidance": "Content 6 marks, structure 2 marks, language 2 marks."
    }
  ]
}`;

  onProgress?.('Generating exam…');

  const raw = await generateText(
    [{ text: prompt }],
    'You are an expert exam paper designer. Output only valid JSON — no markdown, no extra text.',
    12000,
    'generateExamFromNotes',
    userId ?? null,
  );

  onProgress?.('Finalising exam…');

  let exam: GeneratedExam;
  try {
    exam = JSON.parse(extractJson(raw)) as GeneratedExam;
  } catch {
    throw new Error('Failed to parse exam from AI response. Please retry.');
  }

  if (!Array.isArray(exam.questions) || exam.questions.length === 0) {
    throw new Error('Failed to generate exam questions. Please retry.');
  }

  exam.questions = sanitizeQuestions(
    exam.questions.map((q, i) => ({
      id:              q.id     ?? `q${i + 1}`,
      number:          q.number ?? String(i + 1),
      type:            (['mcq', 'short', 'calculation', 'essay'].includes(q.type) ? q.type : 'short') as ExamQuestion['type'],
      topic:           q.topic  ?? 'General',
      marks:           typeof q.marks === 'number' ? q.marks : 2,
      stem:            q.stem   ?? '',
      context:         q.context,
      options:         q.options,
      modelAnswer:     q.modelAnswer    ?? '',
      markingGuidance: q.markingGuidance,
    })),
  );

  if (exam.questions.length === 0) {
    throw new Error('All generated questions were incomplete. Please retry.');
  }

  return exam;
}

function gradeFromPct(pct: number): string {
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B';
  if (pct >= 60) return 'C';
  if (pct >= 50) return 'D';
  if (pct >= 40) return 'E';
  if (pct >= 30) return 'F';
  return 'G';
}
