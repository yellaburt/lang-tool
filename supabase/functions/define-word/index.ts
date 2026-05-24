// Edge Function: define-word
//
// Returns a contextual definition for a single word inside a Spanish chunk.
// Caches results in public.word_lookups so repeat taps (by anyone) are
// instant and free. Cache key is (word, chunk_text, language).
//
// Why include the chunk in the cache key: "banco" means bank in one context
// and bench in another. The verb tense of "tengo" doesn't change, but the
// idiom-membership of "dar la vuelta" depends on what's around it.

import Anthropic from 'npm:@anthropic-ai/sdk@0.95.2';
import { createClient } from 'npm:@supabase/supabase-js@2';

const MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = `You are a Spanish dictionary for an intermediate adult learner.
The learner is reading a Spanish chunk and tapped on a specific word. Provide a
short, useful, contextual entry. Do not lecture. Do not pad. The learner sees
the chunk; you don't need to explain the surrounding text.

Always include the word's English meaning IN THIS CONTEXT (not a generic list of
meanings — pick the sense that fits here).

If the word is a verb form: include its infinitive, the infinitive's English
meaning, tense (e.g. "preterite", "imperfect", "present subjunctive"), mood
(indicative / subjunctive / imperative / conditional), and person+number
(e.g. "3rd person singular").

If the word is part of an idiom or fixed expression spanning multiple words in
this chunk: include the full expression (in Spanish) and what it means as a
whole. Only include this field when there's a real idiom — don't invent one
just because the word could be part of one in some other context.

Use natural English. Be brief. Call define_word with your output; do not write
text outside the tool call.`;

const TOOL = {
  name: 'define_word',
  description: 'Contextual Spanish word definition for a language learner.',
  input_schema: {
    type: 'object' as const,
    properties: {
      meaning: {
        type: 'string',
        description: "The word's English meaning in this specific context. One sentence.",
      },
      verb: {
        type: 'object',
        description: 'Present only if the word is a conjugated verb form.',
        properties: {
          infinitive: { type: 'string', description: 'Spanish infinitive.' },
          infinitiveEnglish: {
            type: 'string',
            description: 'English meaning of the infinitive (e.g. "to have").',
          },
          tense: {
            type: 'string',
            description: 'e.g. "present", "preterite", "imperfect", "present subjunctive".',
          },
          mood: {
            type: 'string',
            description: '"indicative", "subjunctive", "imperative", or "conditional".',
          },
          person: {
            type: 'string',
            description: 'e.g. "1st person singular", "3rd person plural".',
          },
        },
        required: ['infinitive', 'infinitiveEnglish', 'tense', 'mood', 'person'],
      },
      idiom: {
        type: 'object',
        description: 'Present ONLY if the word is part of an idiom or fixed expression visible in this chunk.',
        properties: {
          expression: { type: 'string', description: 'The full Spanish expression.' },
          meaning: { type: 'string', description: 'What the whole expression means in English.' },
        },
        required: ['expression', 'meaning'],
      },
      notes: {
        type: 'string',
        description: 'Optional one-line note (false-friend warning, register, regionalism). Omit if nothing useful to add.',
      },
    },
    required: ['meaning'],
  },
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!supabaseUrl || !supabaseAnonKey || !anthropicKey) {
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  // Auth: just confirm the caller is signed in. We use the same client for
  // cache reads/writes so RLS sees them as that user.
  const { data: userData, error: authError } = await supabase.auth.getUser();
  if (authError || !userData.user) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let body: { word?: unknown; chunkText?: unknown; language?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const word = typeof body.word === 'string' ? body.word.trim() : '';
  const chunkText = typeof body.chunkText === 'string' ? body.chunkText.trim() : '';
  const language = typeof body.language === 'string' ? body.language : 'es';
  if (word.length === 0) return jsonResponse({ error: 'No word provided' }, 400);
  if (chunkText.length === 0) return jsonResponse({ error: 'No chunkText provided' }, 400);

  // 1. Check cache.
  const { data: cached } = await supabase
    .from('word_lookups')
    .select('definition')
    .eq('word', word)
    .eq('chunk_text', chunkText)
    .eq('language', language)
    .maybeSingle();
  if (cached?.definition) {
    return jsonResponse({ definition: cached.definition, cached: true });
  }

  // 2. Cache miss — call Anthropic.
  const client = new Anthropic({ apiKey: anthropicKey });
  let definition: Record<string, unknown>;
  try {
    const userMessage = `Chunk: "${chunkText}"\n\nWord clicked: "${word}"`;
    const response = await withTimeout(
      client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: userMessage }],
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'define_word' },
      }),
      TIMEOUT_MS,
    );
    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use' || toolUse.name !== 'define_word') {
      console.error('define-word: model did not call tool');
      return jsonResponse({ error: 'Definition service had a problem. Please try again.' }, 502);
    }
    definition = toolUse.input as Record<string, unknown>;
    if (typeof definition.meaning !== 'string' || definition.meaning.length === 0) {
      return jsonResponse({ error: 'Definition service returned no meaning.' }, 502);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`define-word call failed: ${msg}`);
    if (/529|overloaded/i.test(msg)) {
      return jsonResponse(
        {
          error: 'Definition service is at capacity. Please wait a moment and try again.',
          errorKind: 'overloaded',
        },
      );
    }
    return jsonResponse({ error: 'Definition service had a problem. Please try again.' }, 502);
  }

  // 3. Save to cache (fire-and-forget; don't block the response).
  void supabase
    .from('word_lookups')
    .insert({ word, chunk_text: chunkText, language, definition })
    .then(({ error }) => {
      if (error && !/duplicate|conflict|23505/i.test(error.message)) {
        console.warn('define-word cache insert failed:', error.message);
      }
    });

  return jsonResponse({ definition, cached: false });
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`define-word timed out after ${ms}ms`)), ms),
    ),
  ]);
}
