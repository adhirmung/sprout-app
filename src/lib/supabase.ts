import { createClient } from '@supabase/supabase-js';
import type { LearnerProfile, LibraryTree } from './types';
import type { ChatMessage, FeedResult } from './claude';

const SUPABASE_URL  = 'https://nocguvewcpbdasoinztk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vY2d1dmV3Y3BiZGFzb2luenRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1MzY4OTAsImV4cCI6MjA5NDExMjg5MH0.rDRX1WGTaNjlDwoWJCcJwbKP35WUsIyRuqXpCHBV4yg';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── Profile ───────────────────────────────────────────────────

export async function dbLoadProfile(userId: string) {
  const { data } = await supabase
    .from('profiles')
    .select('display_name, cognitive_profile, api_key')
    .eq('user_id', userId)
    .single();
  return {
    displayName:      (data?.display_name      as string)              ?? '',
    cognitiveProfile: (data?.cognitive_profile as LearnerProfile|null) ?? null,
    apiKey:           (data?.api_key           as string)              ?? '',
  };
}

export async function dbSaveProfile(
  userId: string,
  patch: { displayName?: string; cognitiveProfile?: LearnerProfile; apiKey?: string },
) {
  const row: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };
  if (patch.displayName      !== undefined) row.display_name      = patch.displayName;
  if (patch.cognitiveProfile !== undefined) row.cognitive_profile = patch.cognitiveProfile;
  if (patch.apiKey           !== undefined) row.api_key           = patch.apiKey;
  await supabase.from('profiles').upsert(row);
}

// ── Generated cards cache ─────────────────────────────────────

export async function dbLoadGeneratedCards(
  userId: string,
  fileKey: string,
): Promise<{ result: FeedResult; contentLen: number } | null> {
  const { data } = await supabase
    .from('generated_cards')
    .select('cards_json, content_len')
    .eq('user_id', userId)
    .eq('file_key', fileKey)
    .single();
  if (!data) return null;
  // Handle both old format (plain array) and new format ({ cards, audit })
  const raw = data.cards_json as FeedResult | unknown[];
  const result: FeedResult = Array.isArray(raw)
    ? { cards: raw as FeedResult['cards'], audit: null }
    : raw as FeedResult;
  return { result, contentLen: data.content_len as number };
}

export async function dbSaveGeneratedCards(
  userId: string,
  fileKey: string,
  topic: string,
  result: FeedResult,
  contentLen: number,
): Promise<void> {
  const { error } = await supabase.from('generated_cards').upsert({
    user_id:      userId,
    file_key:     fileKey,
    topic,
    cards_json:   result,
    content_len:  contentLen,
    generated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,file_key' });
  if (error) throw error;
}

export async function dbDeleteGeneratedCards(userId: string, fileKey: string): Promise<void> {
  await Promise.all([
    supabase.from('generated_cards').delete().eq('user_id', userId).eq('file_key', fileKey),
    supabase.from('chat_history').delete().eq('user_id', userId).eq('file_key', fileKey),
  ]);
}

// ── Chat history ──────────────────────────────────────────────

export async function dbLoadChatHistory(
  userId: string,
  fileKey: string,
  cardIndex: number,
): Promise<ChatMessage[]> {
  const { data } = await supabase
    .from('chat_history')
    .select('messages')
    .eq('user_id', userId)
    .eq('file_key', fileKey)
    .eq('card_index', cardIndex)
    .single();
  return (data?.messages as ChatMessage[]) ?? [];
}

export async function dbSaveChatHistory(
  userId: string,
  fileKey: string,
  cardIndex: number,
  messages: ChatMessage[],
): Promise<void> {
  await supabase.from('chat_history').upsert({
    user_id:    userId,
    file_key:   fileKey,
    card_index: cardIndex,
    messages,
    updated_at: new Date().toISOString(),
  });
}

// ── PDF Storage ───────────────────────────────────────────────

export async function uploadPdfToStorage(
  userId: string,
  title: string,
  base64: string,
): Promise<string | null> {
  try {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const blob  = new Blob([bytes], { type: 'application/pdf' });
    const safe  = title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
    const path  = `${userId}/${Date.now()}_${safe}.pdf`;
    const { data, error } = await supabase.storage.from('pdfs').upload(path, blob, { upsert: true });
    if (error || !data) return null;
    return data.path;
  } catch {
    return null;
  }
}

export async function fetchPdfBase64FromStorage(storagePath: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage.from('pdfs').download(storagePath);
    if (error || !data) return null;
    return new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
      reader.readAsDataURL(data);
    });
  } catch {
    return null;
  }
}

// ── Generic content cache (map / reading / visuals) ───────────

/**
 * Load a cached content blob (map, reading, or visuals) for a given file.
 * Returns null when no entry exists.
 */
export async function dbLoadContent<T>(
  userId: string,
  fileKey: string,
  contentType: 'map' | 'reading' | 'visuals' | 'audit',
): Promise<T | null> {
  const { data } = await supabase
    .from('generated_content')
    .select('data_json')
    .eq('user_id', userId)
    .eq('file_key', fileKey)
    .eq('content_type', contentType)
    .single();
  return data ? (data.data_json as T) : null;
}

/**
 * Persist a content blob (map, reading, or visuals) for a given file.
 * Upserts so re-generation overwrites the old cache.
 */
export async function dbSaveContent<T>(
  userId: string,
  fileKey: string,
  contentType: 'map' | 'reading' | 'visuals' | 'audit',
  data: T,
): Promise<void> {
  const { error } = await supabase.from('generated_content').upsert(
    {
      user_id:      userId,
      file_key:     fileKey,
      content_type: contentType,
      data_json:    data,
      generated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,file_key,content_type' },
  );
  if (error) throw error;
}

// ── Library ───────────────────────────────────────────────────

export async function dbLoadLibrary(userId: string): Promise<LibraryTree> {
  const { data } = await supabase
    .from('library')
    .select('tree')
    .eq('user_id', userId)
    .single();
  return (data?.tree as LibraryTree) ?? {};
}

export async function dbSaveLibrary(userId: string, tree: LibraryTree): Promise<void> {
  await supabase.from('library').upsert({
    user_id:    userId,
    tree,
    updated_at: new Date().toISOString(),
  });
}
