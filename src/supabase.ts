import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ChunkAndGloss } from './prompt';
import {
  Chunk,
  ChunkId,
  ChunkingMode,
  GrammarExplanation,
  LearnerState,
  Passage,
  PassageId,
  Settings,
  WordDefinition,
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

// Username → synthetic email map. Supabase's password auth requires an
// email-shaped identifier; we use `.local` addresses that are never actually
// emailed. Signups are disabled in the Supabase dashboard, so the only
// accounts that can sign in are the ones provisioned out-of-band.
//
// To add a new user: create them in Supabase dashboard (Authentication →
// Users → Add user → email + password, auto-confirm), then add an entry here
// and redeploy.
const USERNAME_TO_EMAIL: Readonly<Record<string, string>> = {
  ARD: 'ard@lang-tool.local',
  DPD: 'dpd@lang-tool.local',
};

export async function signInWithPassword(
  username: string,
  password: string,
): Promise<void> {
  const email = USERNAME_TO_EMAIL[username.trim().toUpperCase()];
  if (!email) {
    throw new Error('Unknown user, try again');
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Supabase returns "Invalid login credentials" for both wrong password
    // and unknown user; surface it verbatim.
    throw new Error(error.message);
  }
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
  folder?: string | null;
  subfolder?: string | null;
  chunking_mode?: string | null;
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
    chunkingMode: row.chunking_mode === 'lyrics' ? 'lyrics' : 'prose',
    folder: row.folder ?? null,
    subfolder: row.subfolder ?? null,
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

function passageRow(passage: Passage, ownerId: string) {
  return {
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
    chunking_mode: passage.chunkingMode,
    folder: passage.folder,
    subfolder: passage.subfolder,
  };
}

export async function insertPassage(passage: Passage, ownerId: string): Promise<void> {
  const { error } = await supabase.from('passages').insert(passageRow(passage, ownerId));
  if (error) throw new Error(`insertPassage: ${error.message}`);
}

// Multi-row insert for adding a book's chapters at once — one round-trip
// instead of N. No-op on an empty array.
export async function insertPassages(
  passages: ReadonlyArray<Passage>,
  ownerId: string,
): Promise<void> {
  if (passages.length === 0) return;
  const { error } = await supabase
    .from('passages')
    .insert(passages.map((p) => passageRow(p, ownerId)));
  if (error) throw new Error(`insertPassages: ${error.message}`);
}

// Folder/subfolder mutator — kept separate from updatePassageContent so a
// move-passage dispatch doesn't accidentally re-write the chunks blob, and
// vice versa. Title moves through updatePassageContent (alongside the
// content that triggers its writes).
export async function updatePassageMetadata(passage: Passage): Promise<void> {
  const { error } = await supabase
    .from('passages')
    .update({
      folder: passage.folder,
      subfolder: passage.subfolder,
    })
    .eq('id', passage.id);
  if (error) throw new Error(`updatePassageMetadata: ${error.message}`);
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

// Upgrade a stored settings blob to the current shape. Settings live as a
// single JSONB blob (no per-setting columns), so schema evolution happens here
// in the app layer, not in SQL migrations. Currently: map the legacy
// `listeningMode` boolean onto `readingMode`. The cleaned shape persists on the
// next settings write, at which point the stale `listeningMode`,
// `autoAdvanceDelaySec`, and `defaultReadingMode` keys drop out of the blob.
function normalizeSettings(raw: unknown): Partial<Settings> {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = { ...(raw as Record<string, unknown>) };
  if (r['readingMode'] === undefined) {
    r['readingMode'] = r['listeningMode'] === true ? 'listening' : 'scaffolded';
  }
  // 'reading' mode's read-aloud-on-advance toggle: absent in older blobs → on.
  if (r['readAloudOnAdvance'] === undefined) {
    r['readAloudOnAdvance'] = true;
  }
  delete r['listeningMode'];
  delete r['autoAdvanceDelaySec'];
  // `readingMode` is now sticky (persisted + synced), so the old per-user
  // sign-in default is gone. Drop the stale key; it falls out on the next write.
  delete r['defaultReadingMode'];
  return r as Partial<Settings>;
}

export async function fetchSettings(): Promise<Settings> {
  const { data, error } = await supabase
    .from('user_settings')
    .select('settings')
    .maybeSingle();
  if (error) throw new Error(`fetchSettings: ${error.message}`);
  if (!data) return defaultSettings();
  return { ...defaultSettings(), ...normalizeSettings(data.settings) };
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

// Map raw Supabase / Anthropic error strings to short, user-readable text.
// The raw messages ("Edge Function returned a non-2xx status code") are
// useless to a reader; this surface is what shows up in the error banner.
function humanizeChunkAndGlossError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/at capacity|overloaded/i.test(msg)) {
    // The server already crafted a user-ready message; pass through.
    return msg;
  }
  if (/401|unauthor/i.test(msg)) {
    return 'Your sign-in expired. Please sign out and back in.';
  }
  if (/429|rate.?limit/i.test(msg)) {
    return 'Translation service is rate-limited. Wait a minute and try again.';
  }
  if (/network|fetch|failed to fetch|abort/i.test(msg)) {
    return "Couldn't reach the translation service. Check your connection.";
  }
  if (/non-2xx|edge function|earlydrop|timeout|503|502|504/i.test(msg)) {
    return 'Translation service had a hiccup. Please try again.';
  }
  return 'Translation service had a problem. Please try again.';
}

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /401|unauthor/i.test(msg);
}

// Marker thrown by callChunkAndGloss to signal that the retry loop should
// stop — used when the failure won't be resolved by retrying (e.g. Anthropic
// is overloaded, so the same call will fail the same way).
class NonRetryableError extends Error {}

// Marker for "the translation service refused this specific content."
// Caller (batch fetcher) treats this as skip-and-continue, not as a
// passage-level error. Inherits from NonRetryableError so the inner retry
// loop in callChunkAndGloss also stops.
export class ContentRefusedError extends NonRetryableError {}

export async function callChunkAndGloss(
  text: string,
  options: { chunkingMode?: ChunkingMode } = {},
): Promise<ReadonlyArray<ChunkAndGloss>> {
  // Retry transient failures (EarlyDrop, network blips, 5xx) silently. Most
  // of the failures we see are these — auto-retry usually wins before the
  // user notices anything. Auth errors aren't retried since they won't
  // resolve themselves.
  const maxAttempts = 3;
  let lastErr: unknown = null;
  const chunkingMode: ChunkingMode = options.chunkingMode ?? 'prose';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      // Exponential backoff: ~1s, ~2s between attempts (≤3s total wait).
      const waitMs = 1000 * Math.pow(2, attempt - 2);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    try {
      const { data, error } = await supabase.functions.invoke('chunk-and-gloss', {
        body: { text, chunkingMode },
      });
      if (error) {
        lastErr = error;
        if (isAuthError(error)) break;
        continue;
      }
      const payload = data as {
        chunks?: ReadonlyArray<ChunkAndGloss>;
        error?: string;
        errorKind?: string;
      };
      if (payload.error) {
        // App-level error from the function. Three known errorKinds:
        //   overloaded — Anthropic at capacity; same call will fail.
        //   unavailable — service tried + health check failed; same.
        //   refused — content was specifically refused; caller will skip
        //     this batch and continue with the next.
        if (payload.errorKind === 'refused') {
          throw new ContentRefusedError(payload.error);
        }
        if (
          payload.errorKind === 'overloaded' ||
          payload.errorKind === 'unavailable'
        ) {
          throw new NonRetryableError(payload.error);
        }
        throw new Error(payload.error);
      }
      if (!payload.chunks || payload.chunks.length === 0) {
        // Empty response — treat as transient and retry.
        lastErr = new Error('No content returned');
        continue;
      }
      return payload.chunks;
    } catch (e) {
      lastErr = e;
      if (e instanceof NonRetryableError) break;
      if (isAuthError(e)) break;
      // Other errors flow through — retry once more in case the body parse
      // itself was a flake.
    }
  }
  // Log the technical detail for debugging, then surface the friendly one.
  console.error('chunk-and-gloss failed after retries:', lastErr);
  // A refused batch must keep its ContentRefusedError type so the batch
  // fetcher inserts a […] placeholder and continues to the next batch,
  // rather than failing the whole passage. Re-wrapping it in a plain Error
  // (as the catch-all below does) erases the type and turns a skippable
  // refusal into a dead-end "Try again" loop on the same content.
  if (lastErr instanceof ContentRefusedError) throw lastErr;
  // Other non-retryable failures (overloaded / unavailable) already carry a
  // server-crafted, user-ready message — surface it verbatim instead of
  // flattening it to the generic catch-all.
  if (lastErr instanceof NonRetryableError) throw new Error(lastErr.message);
  throw new Error(humanizeChunkAndGlossError(lastErr));
}

// === Edge Function: suggest-title ===

// Returns a short library-card-style title for the passage. Used at save
// time (background) and by an explicit "Suggest title" button. Failure is
// non-fatal — caller falls back to a first-line-derived title.
export async function callSuggestTitle(text: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('suggest-title', {
    body: { text },
  });
  if (error) {
    console.warn('suggest-title transport error:', error);
    throw new Error('Title suggestion failed.');
  }
  const payload = data as { title?: string; error?: string };
  if (payload.error) throw new Error(payload.error);
  if (!payload.title || payload.title.length === 0) {
    throw new Error('Empty title.');
  }
  return payload.title;
}

// === Edge Function: define-word ===

export async function callDefineWord(
  word: string,
  chunkText: string,
  options: {
    language?: string;
    passageId?: PassageId;
    chunkId?: ChunkId;
  } = {},
): Promise<WordDefinition> {
  const { data, error } = await supabase.functions.invoke('define-word', {
    body: {
      word,
      chunkText,
      language: options.language ?? 'es',
      passageId: options.passageId,
      chunkId: options.chunkId,
    },
  });
  if (error) {
    console.error('define-word transport error:', error);
    throw new Error(humanizeChunkAndGlossError(error));
  }
  const payload = data as {
    definition?: WordDefinition;
    error?: string;
    errorKind?: string;
  };
  if (payload.error) {
    // 'overloaded' is informational only here — we don't retry word lookups,
    // the user will tap again if they care. Just surface the message.
    throw new Error(payload.error);
  }
  if (!payload.definition) {
    throw new Error('No definition returned.');
  }
  return payload.definition;
}

// === Edge Function: explain-grammar ===

export async function callExplainGrammar(
  spanishText: string,
  englishGloss: string,
  options: {
    language?: string;
    passageId?: PassageId;
    chunkId?: ChunkId;
  } = {},
): Promise<GrammarExplanation> {
  const { data, error } = await supabase.functions.invoke('explain-grammar', {
    body: {
      spanishText,
      englishGloss,
      language: options.language ?? 'es',
      passageId: options.passageId,
      chunkId: options.chunkId,
    },
  });
  if (error) {
    console.error('explain-grammar transport error:', error);
    throw new Error(humanizeChunkAndGlossError(error));
  }
  const payload = data as {
    explanation?: GrammarExplanation;
    error?: string;
    errorKind?: string;
  };
  if (payload.error) {
    throw new Error(payload.error);
  }
  if (!payload.explanation) {
    throw new Error('No grammar explanation returned.');
  }
  return payload.explanation;
}
