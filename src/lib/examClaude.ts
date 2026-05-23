import Anthropic from '@anthropic-ai/sdk';
import { getApiKey } from './gemini';
import { dbLogUsage } from './supabase';

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

function createClient(): Anthropic {
  const apiKey = getApiKey();
  const USE_PROXY = import.meta.env.VITE_USE_PROXY === 'true';
  if (apiKey) return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  if (USE_PROXY) return new Anthropic({
    apiKey:  'via-proxy',
    baseURL: `${window.location.origin}/api`,
    dangerouslyAllowBrowser: true,
  });
  throw new Error('NO_API_KEY');
}

// ── Streaming helper ────────────────────────────────────────────

async function streamToText(
  client:  Anthropic,
  params:  Parameters<typeof client.messages.create>[0],
  fnName:  string,
  userId:  string | null = null,
): Promise<string> {
  let text         = '';
  let inputTokens  = 0;
  let outputTokens = 0;

  const stream = await client.messages.create({ ...params, stream: true });
  for await (const event of stream) {
    if (event.type === 'message_start')                                               inputTokens  = event.message.usage.input_tokens;
    else if (event.type === 'message_delta' && event.usage)                           outputTokens = event.usage.output_tokens;
    else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') text       += event.delta.text;
  }

  void dbLogUsage(userId, fnName, params.model as string, inputTokens, outputTokens);
  return text;
}

function extractJson(raw: string): string {
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in AI response.');
  return raw.slice(start, end + 1);
}

// ── Exam generation ─────────────────────────────────────────────

/**
 * Analyses 2+ past exam papers (base64 PDFs) and generates a new
 * practice exam that mirrors their style, topics, and difficulty.
 */
export async function analyzeAndGenerateExam(
  pdfBase64Array: string[],
  onProgress?: (msg: string) => void,
  userId?: string | null,
): Promise<GeneratedExam> {
  onProgress?.('Analysing your past exam papers…');

  const client = createClient();

  type MsgContent = Parameters<typeof client.messages.create>[0]['messages'][0]['content'];

  const pdfBlocks = pdfBase64Array.map((b64, i) => ({
    type:   'document' as const,
    source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: b64 },
    title:  `Past Exam Paper ${i + 1}`,
  }));

  const prompt = `You are an expert NSC (South African National Senior Certificate) / CAPS curriculum exam paper designer.

I am providing ${pdfBase64Array.length} past exam papers. Analyse them carefully, then generate a completely NEW practice exam that:
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
      "modelAnswer": "Step 1: ...\nStep 2: ...\nAnswer: 42 units",
      "markingGuidance": "2 marks method, 2 marks substitution, 1 mark calculation, 1 mark units."
    }
  ]
}

Question type rules:
- "mcq": Multiple choice. ALWAYS include exactly 4 options (A, B, C, D). modelAnswer is the letter only, e.g. "C".
- "short": Short paragraph answer (2–6 marks). modelAnswer lists key marking points.
- "calculation": Numerical/mathematical/scientific calculation (3–10 marks). modelAnswer is full worked solution.
- "essay": Extended writing (8–20 marks). modelAnswer is a paragraph plan or rubric.

IMPORTANT: The sum of all question marks must equal totalMarks.`;

  onProgress?.('Generating your personalised practice exam…');

  const raw = await streamToText(client, {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 12000,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages: [{
      role:    'user',
      content: [
        ...(pdfBlocks as unknown as NonNullable<MsgContent>[]),
        { type: 'text' as const, text: prompt },
      ] as MsgContent,
    }],
  }, 'analyzeAndGenerateExam', userId ?? null);

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

  // Ensure every question has required fields
  exam.questions = exam.questions.map((q, i) => ({
    id:     q.id    ?? `q${i + 1}`,
    number: q.number ?? String(i + 1),
    type:   (['mcq', 'short', 'calculation', 'essay'].includes(q.type) ? q.type : 'short') as ExamQuestion['type'],
    topic:  q.topic ?? 'General',
    marks:  typeof q.marks === 'number' ? q.marks : 2,
    stem:   q.stem  ?? '',
    context: q.context,
    options: q.options,
    modelAnswer:    q.modelAnswer    ?? '',
    markingGuidance: q.markingGuidance,
  }));

  return exam;
}

// ── Variant generation ──────────────────────────────────────────

/**
 * Generates a brand-new practice exam covering the same curriculum topics
 * as `sourceExam` but with completely different question stems, numbers,
 * scenarios, and stimulus material.
 *
 * Optionally pass `previousExams` (earlier variants) so Claude can avoid
 * repeating questions the student has already seen.
 */
export async function generateExamVariant(
  sourceExam:    GeneratedExam,
  previousExams: GeneratedExam[] = [],
  onProgress?:   (msg: string) => void,
  userId?:       string | null,
): Promise<GeneratedExam> {
  onProgress?.('Generating a new exam variant…');

  const client = createClient();

  // Summarise the source exam's topics so Claude knows what curriculum to cover
  const topicRows = sourceExam.questions
    .map(q => `  Q${q.number} [${q.type}, ${q.marks}m, ${q.topic}]: ${q.stem.slice(0, 90)}`)
    .join('\n');

  // Build an "already used" block from all previous variants
  const seenBlock = previousExams.length
    ? `\nPREVIOUS VARIANT QUESTIONS (do NOT reuse these stems or scenarios):\n` +
      previousExams.flatMap(e => e.questions).map(q =>
        `  [${q.type}] ${q.stem.slice(0, 80)}`
      ).join('\n')
    : '';

  const variantNum = previousExams.length + 2; // source = 1, this = 2, 3, …

  const prompt = `You are an expert NSC (South African National Senior Certificate) / CAPS curriculum exam paper designer.

I need Variant ${variantNum} of a ${sourceExam.subject} (${sourceExam.grade}) practice exam.

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

IMPORTANT: Sum of all question marks must equal ${sourceExam.totalMarks}.`;

  onProgress?.('Building variant questions…');

  const raw = await streamToText(client, {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 12000,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: prompt }],
  }, 'generateExamVariant', userId ?? null);

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

  exam.questions = exam.questions.map((q, i) => ({
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
  }));

  return exam;
}

// ── Marking ─────────────────────────────────────────────────────

/**
 * Sends the completed exam + student answers to Claude for marking.
 * Returns per-question scores, feedback, and an overall grade.
 */
export async function markExamSubmission(
  exam:    GeneratedExam,
  answers: Record<string, string>,
  onProgress?: (msg: string) => void,
  userId?: string | null,
): Promise<ExamResults> {
  onProgress?.('Marking your answers…');

  const client = createClient();

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

  const prompt = `You are an expert NSC marker. Mark these student answers strictly and fairly according to NSC marking guidelines.

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
      "feedback": "Correct! Great work. / specific constructive 1-2 sentence feedback",
      "modelAnswer": "the correct answer / full worked solution"
    }
  ],
  "overallFeedback": "2-3 sentences: overall performance assessment, strongest area identified, and 1 concrete improvement suggestion"
}`;

  onProgress?.('Calculating your results…');

  const raw = await streamToText(client, {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    system:     'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
    messages:   [{ role: 'user', content: prompt }],
  }, 'markExamSubmission', userId ?? null);

  let results: ExamResults;
  try {
    results = JSON.parse(extractJson(raw)) as ExamResults;
  } catch {
    throw new Error('Failed to parse marking results. Please retry.');
  }

  if (!Array.isArray(results.results)) {
    throw new Error('Invalid marking response. Please retry.');
  }

  // Clamp values and fill gaps
  results.totalAwarded = Math.min(results.totalAwarded ?? 0, exam.totalMarks);
  results.percentage   = results.percentage ?? Math.round((results.totalAwarded / exam.totalMarks) * 1000) / 10;
  results.letterGrade  = results.letterGrade ?? gradeFromPct(results.percentage);

  return results;
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
