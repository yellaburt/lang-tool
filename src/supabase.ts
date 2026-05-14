import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ChunkAndGloss } from './prompt';
import {
  Chunk,
  ChunkId,
  LearnerState,
  Passage,
  PassageId,
  Settings,
} from './types';
import { defaultSettings, emptyLearnerState } from './core';

// === Client ===
//
// Supabase URL and the publishable (anon) key are hardcoded. Both are
// designed to be public:
//   - URL is the project's public endpoint.
//   - publishable key is constrained by RLS policies; it gives no privilege
//     beyond what each user is explicitly allowed.
// The TRUE secret (service-role key + ANTHROPIC_API_KEY) lives only in
// Supabase Edge Function secrets, never in client code.
//
// Hardcoding avoids fighting Cloudflare's env-var UI for static-only Workers
// and means new contributors don't need a local .env.local to run the app.

const SUPABASE_URL = 'https://vbqnmwsmgdbwewzsfxud.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable__4QHolk1se7EUcgIMjOvHw_y7u1HjlX';

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// === Auth ===

export interface AuthSession {
  readonly userId: string;
  readonly email: string;
}

export async function getCurrentSession(): Promise<AuthSession | null> {
  const { data } = await supabase.auth.getSession();
  const s = data.session;
  if (!s || !s.user || !s.user.email) return null;
  return { userId: s.user.id, email: s.user.email };
}

export async function signInWithEmail(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // Redirect back to the current origin after clicking the magic link.
      emailRedirectTo: window.location.origin,
    },
  });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

// Subscribe to auth state changes. Returns an unsubscribe function.
export function subscribeAuth(
  cb: (session: AuthSession | null) => void,
): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, s) => {
    if (!s || !s.user || !s.user.email) {
      cb(null);
    } else {
      cb({ userId: s.user.id, email: s.user.email });
    }
  });
  return () => data.subscription.unsubscribe();
}

// === Library ===
// Translation between our domain types and the Postgres column shapes.

interface PassageRow {
  id: string;
  owner_id: string;
  visibility: string;
  title: string;
  language: string;
  raw_text: string;
  chunks: ReadonlyArray<Chunk>;
  processing_status: Passage['processingStatus'];
  sentence_count: number;
  created_at: string;
  last_read_chunk_index?: number;
  last_opened_at?: string;
}

function passageFromRow(row: PassageRow): Passage {
  return {
    id: row.id as PassageId,
    title: row.title,
    language: row.language as Passage['language'],
    rawText: row.raw_text,
    chunks: row.chunks,
    createdAt: new Date(row.created_at).getTime(),
    lastOpenedAt: row.last_opened_at
      ? new Date(row.last_opened_at).getTime()
      : new Date(row.created_at).getTime(),
    lastReadChunkIndex: row.last_read_chunk_index ?? 0,
    sentenceCount: row.sentence_count,
    processingStatus: row.processing_status,
  };
}

// Fetch all passages visible to the current user (own + public), with their
// reading-state joined in via the `passages_with_state` view.
export async function fetchPassages(): Promise<
  Readonly<Record<PassageId, Passage>>
> {
  const { data, error } = await supabase
    .from('passages_with_state')
    .select('*');
  if (error) throw new Error(`fetchPassages: ${error.message}`);
  const result: Record<PassageId, Passage> = {};
  for (const row of (data ?? []) as PassageRow[]) {
    const p = passageFromRow(row);
    result[p.id] = p;
  }
  return result;
}

export async function insertPassage(passage: Passage, ownerId: string): Promise<void> {
  const { error } = await supabase.from('passages').insert({
    id: passage.id,
    owner_id: ownerId,
    visibility: 'private',
    title: passage.title,
    language: passage.language,
    raw_text: passage.rawText,
    chunks: passage.chunks,
    processing_status: passage.processingStatus,
    sentence_count: passage.sentenceCount,
    created_at: new Date(passage.createdAt).toISOString(),
  });
  if (error) throw new Error(`insertPassage: ${error.message}`);
}

export async function updatePassageContent(passage: Passage): Promise<void> {
  // RLS will reject if the caller isn't the owner.
  const { error } = await supabase
    .from('passages')
    .update({
      chunks: passage.chunks,
      processing_status: passage.processingStatus,
      sentence_count: passage.sentenceCount,
      title: passage.title,
    })
    .eq('id', passage.id);
  if (error) throw new Error(`updatePassageContent: ${error.message}`);
}

export async function deletePassage(passageId: PassageId): Promise<void> {
  const { error } = await supabase.from('passages').delete().eq('id', passageId);
  if (error) throw new Error(`deletePassage: ${error.message}`);
}

export async function upsertReadingState(
  userId: string,
  passageId: PassageId,
  lastReadChunkIndex: number,
  lastOpenedAt: number,
): Promise<void> {
  const { error } = await supabase.from('reading_state').upsert(
    {
      user_id: userId,
      passage_id: passageId,
      last_read_chunk_index: lastReadChunkIndex,
      last_opened_at: new Date(lastOpenedAt).toISOString(),
    },
    { onConflict: 'user_id,passage_id' },
  );
  if (error) throw new Error(`upsertReadingState: ${error.message}`);
}

// === Settings ===

export async function fetchSettings(): Promise<Settings> {
  const { data, error } = await supabase
    .from('user_settings')
    .select('settings')
    .maybeSingle();
  if (error) throw new Error(`fetchSettings: ${error.message}`);
  if (!data) return defaultSettings();
  return { ...defaultSettings(), ...(data.settings as Partial<Settings>) };
}

export async function upsertSettings(userId: string, settings: Settings): Promise<void> {
  const { error } = await supabase.from('user_settings').upsert(
    {
      user_id: userId,
      settings,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(`upsertSettings: ${error.message}`);
}

// === LearnerState bundle ===

export async function fetchLearnerState(): Promise<LearnerState> {
  const fresh = emptyLearnerState();
  const [passages, settings] = await Promise.all([
    fetchPassages(),
    fetchSettings(),
  ]);
  return { ...fresh, passages, settings };
}

// === Edge Function: chunk-and-gloss ===

export async function callChunkAndGloss(text: string): Promise<ReadonlyArray<ChunkAndGloss>> {
  const { data, error } = await supabase.functions.invoke('chunk-and-gloss', {
    body: { text },
  });
  if (error) throw new Error(`chunk-and-gloss: ${error.message}`);
  const payload = data as { chunks?: ReadonlyArray<ChunkAndGloss>; error?: string };
  if (payload.error) throw new Error(payload.error);
  if (!payload.chunks || payload.chunks.length === 0) {
    throw new Error('chunk-and-gloss returned no chunks');
  }
  return payload.chunks;
}
