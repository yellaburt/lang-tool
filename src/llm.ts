// Thin wrapper around the Supabase Edge Function. The Anthropic API key
// lives server-side in Supabase secrets, so clients never see it.
// All cache and retry logic is on the server (or absent for Phase A).

import { ChunkAndGloss } from './prompt';
import { callChunkAndGloss } from './supabase';

export type { ChunkAndGloss } from './prompt';

export async function splitAndGloss(
  passage: string,
): Promise<ReadonlyArray<ChunkAndGloss>> {
  const cleaned = passage.trim();
  if (cleaned.length === 0) return [];
  return callChunkAndGloss(cleaned);
}

// Retained for backward compatibility with views that gate UI on whether the
// API path is configured. With the Edge Function in place and the Supabase
// credentials hardcoded, this is always true at runtime.
export function hasApiKey(): boolean {
  return true;
}
