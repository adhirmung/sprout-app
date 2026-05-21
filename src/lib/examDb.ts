import { supabase } from './supabase';
import type { GeneratedExam, ExamResults } from './examClaude';

// ── Types ──────────────────────────────────────────────────────

export interface StoredExamSet {
  id:              string;
  userId:          string;
  title:           string;
  subject:         string;
  grade:           string;
  paperNames:      string[];
  examData:        GeneratedExam;
  totalMarks:      number;
  durationMinutes: number;
  createdAt:       string;
}

export interface StoredAttempt {
  id:              string;
  examSetId:       string;
  userId:          string;
  answers:         Record<string, string>;
  results:         ExamResults | null;
  scorePct:        number | null;
  letterGrade:     string | null;
  durationSeconds: number | null;
  createdAt:       string;
}

// ── Exam sets ─────────────────────────────────────────────────

export async function dbLoadExamSets(userId: string): Promise<StoredExamSet[]> {
  const { data } = await supabase
    .from('exam_sets')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (!data) return [];
  return data.map(row => ({
    id:              row.id              as string,
    userId:          row.user_id         as string,
    title:           row.title           as string,
    subject:         row.subject         as string,
    grade:           row.grade           as string,
    paperNames:      row.paper_names     as string[],
    examData:        row.exam_data       as GeneratedExam,
    totalMarks:      row.total_marks     as number,
    durationMinutes: row.duration_minutes as number,
    createdAt:       row.created_at      as string,
  }));
}

export async function dbSaveExamSet(
  userId: string,
  set: {
    title:           string;
    subject:         string;
    grade:           string;
    paperNames:      string[];
    examData:        GeneratedExam;
    totalMarks:      number;
    durationMinutes: number;
  },
): Promise<StoredExamSet | null> {
  const { data, error } = await supabase
    .from('exam_sets')
    .insert({
      user_id:          userId,
      title:            set.title,
      subject:          set.subject,
      grade:            set.grade,
      paper_names:      set.paperNames,
      exam_data:        set.examData,
      total_marks:      set.totalMarks,
      duration_minutes: set.durationMinutes,
    })
    .select()
    .single();
  if (error || !data) return null;
  return {
    id:              data.id              as string,
    userId:          data.user_id         as string,
    title:           data.title           as string,
    subject:         data.subject         as string,
    grade:           data.grade           as string,
    paperNames:      data.paper_names     as string[],
    examData:        data.exam_data       as GeneratedExam,
    totalMarks:      data.total_marks     as number,
    durationMinutes: data.duration_minutes as number,
    createdAt:       data.created_at      as string,
  };
}

export async function dbDeleteExamSet(id: string): Promise<void> {
  await supabase.from('exam_sets').delete().eq('id', id);
}

// ── Attempts ──────────────────────────────────────────────────

export async function dbLoadAttempts(examSetId: string): Promise<StoredAttempt[]> {
  const { data } = await supabase
    .from('exam_attempts')
    .select('*')
    .eq('exam_set_id', examSetId)
    .order('created_at', { ascending: false });
  if (!data) return [];
  return data.map(row => ({
    id:              row.id               as string,
    examSetId:       row.exam_set_id      as string,
    userId:          row.user_id          as string,
    answers:         row.answers          as Record<string, string>,
    results:         row.results          as ExamResults | null,
    scorePct:        row.score_pct        as number | null,
    letterGrade:     row.letter_grade     as string | null,
    durationSeconds: row.duration_seconds as number | null,
    createdAt:       row.created_at       as string,
  }));
}

export async function dbSaveAttempt(
  examSetId:       string,
  userId:          string,
  answers:         Record<string, string>,
  results:         ExamResults,
  durationSeconds: number,
): Promise<StoredAttempt | null> {
  const { data, error } = await supabase
    .from('exam_attempts')
    .insert({
      exam_set_id:      examSetId,
      user_id:          userId,
      answers,
      results,
      score_pct:        results.percentage,
      letter_grade:     results.letterGrade,
      duration_seconds: durationSeconds,
    })
    .select()
    .single();
  if (error || !data) return null;
  return {
    id:              data.id               as string,
    examSetId:       data.exam_set_id      as string,
    userId:          data.user_id          as string,
    answers:         data.answers          as Record<string, string>,
    results:         data.results          as ExamResults,
    scorePct:        data.score_pct        as number,
    letterGrade:     data.letter_grade     as string,
    durationSeconds: data.duration_seconds as number,
    createdAt:       data.created_at       as string,
  };
}
