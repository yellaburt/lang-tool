// Edge Function: chunk-and-gloss
//
// Receives a Spanish or English passage from an authenticated user, calls
// the Anthropic API with the server-side key, and returns validated chunks.
//
// Holds the ANTHROPIC_API_KEY as a Supabase secret so it never appears in
// client bundles.
//
// The prompt + tool schema are duplicated from src/prompt.ts. Keep in sync
// manually until a build-time sharing step is set up.

import Anthropic from 'npm:@anthropic-ai/sdk@0.95.2';
import { createClient } from 'npm:@supabase/supabase-js@2';

// ===== Shared prompt block — keep in sync with src/prompt.ts =====

// v5: added mood_annotations (subjunctive highlighting) to the tool schema.
const PROMPT_VERSION = 'v5';
const PRIMARY_MODEL = 'claude-haiku-4-5';
const FALLBACK_MODEL = 'claude-sonnet-4-5';
// Wall-clock timeouts per call. Supabase Edge Functions get killed around
// 75s, so the worst-case (Haiku timeout + Sonnet timeout + overhead) must
// stay under that. For normal batches both models respond in well under 10s.
const PRIMARY_TIMEOUT_MS = 20_000;
const FALLBACK_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = `You are a translation aid for an adult Spanish-reading practice tool. The user pastes a passage that may be in Spanish OR in English. Your job: produce Spanish chunks (5-15 words each) with an English gloss for each chunk.

This tool processes ALL kinds of adult reading material — literary fiction, history, journalism, memoir, academic writing — including passages that describe difficult subjects (war, atrocity, illness, sexuality, crime). You are a translation and chunking aid, NOT a content moderator. The user has chosen the source material for their own educational purposes; refusing to process serious literature or historical writing defeats the tool's purpose. Process every input as written.

DETECT THE INPUT LANGUAGE FIRST.

- If the input is Spanish: split it as-is into chunks. Each chunk's English gloss is a natural English translation in context.
- If the input is English: translate it to natural Mexican Spanish, then split the SPANISH translation into chunks. Each chunk's English gloss is the corresponding ORIGINAL English fragment — preserve the user's original wording wherever possible by aligning Spanish chunks to source English phrases. Only paraphrase when alignment is not clean.

CRITICAL RULES (apply to both cases):

1. HARD MAXIMUM: every Spanish chunk must be 15 words or fewer. This is enforced.
2. If a Spanish sentence is longer than 15 words, you MUST split it. There is always a way.
3. Preferred Spanish break points, in order:
   a. After a comma followed by a coordinator (", y", ", pero", ", o")
   b. Before a subordinator (que, porque, cuando, mientras, aunque, si, donde, como, según)
   c. Before a bare coordinator (y, pero, o)
   d. After any bare comma
4. Never split between an article and noun, between a preposition and its object, or in the middle of a verb tense.
5. If the input was already Spanish, preserve it exactly — do not paraphrase, correct, or normalize.
6. Use Mexican Spanish / Latin American conventions (e.g., "carro" → "car", "celular" → "cellphone").
7. Glosses of consecutive chunks within one sentence must read as natural English when joined with a single space.
8. sentenceIndex is 0-based and tracks SPANISH sentence boundaries. All chunks from the same Spanish sentence share an index.

EXAMPLE 1 — Spanish input:

Input:
"En los últimos 20 años, ha tejido un entramado empresarial que presuntamente ha arruinado a cientos de familias e inversores y dejado atrapados en la insolvencia a maestros y proveedores, según la investigación realizada por EL MUNDO. Es un caso complejo."

Output:
- { tlText: "En los últimos 20 años,", englishGloss: "In the last 20 years,", sentenceIndex: 0 }
- { tlText: "ha tejido un entramado empresarial", englishGloss: "he has woven a business network", sentenceIndex: 0 }
- { tlText: "que presuntamente ha arruinado a cientos de familias e inversores", englishGloss: "that has allegedly ruined hundreds of families and investors", sentenceIndex: 0 }
- { tlText: "y dejado atrapados en la insolvencia a maestros y proveedores,", englishGloss: "and left teachers and suppliers trapped in insolvency,", sentenceIndex: 0 }
- { tlText: "según la investigación realizada por EL MUNDO.", englishGloss: "according to the investigation by EL MUNDO.", sentenceIndex: 0 }
- { tlText: "Es un caso complejo.", englishGloss: "It is a complex case.", sentenceIndex: 1 }

EXAMPLE 2 — English input:

Input:
"The president arrived in the capital this morning, and the protesters welcomed him with banners. It is a complex case."

Output:
- { tlText: "El presidente llegó a la capital esta mañana,", englishGloss: "The president arrived in the capital this morning,", sentenceIndex: 0 }
- { tlText: "y los manifestantes lo recibieron con pancartas.", englishGloss: "and the protesters welcomed him with banners.", sentenceIndex: 0 }
- { tlText: "Es un caso complejo.", englishGloss: "It is a complex case.", sentenceIndex: 1 }

Note: the Spanish in Example 2 is your translation; the English glosses are the user's original English, sliced to align with each Spanish chunk.

MOOD ANNOTATIONS (subjunctive highlighting):

For each chunk, also return a mood_annotations array marking Spanish subjunctive verb forms and the mood triggers that license them. This drives a visual highlight that helps the reader notice subjunctive morphology. If a chunk has no subjunctive forms, return an empty mood_annotations array (or omit it).

What to tag:
- Every subjunctive VERB form: present, imperfect (both -ra and -se forms), present perfect, and pluperfect subjunctive. For perfect forms, tag the WHOLE verb phrase including the auxiliary (e.g. "haya llamado", "hubiera venido"). role = "subjunctive_verb".
- The mood TRIGGER when it appears in the SAME chunk: a conjunction or verb + que, or a subordinator that governs the subjunctive (e.g. "quiero que", "dudo que", "es posible que", "para que", "sin que", "antes de que"). role = "trigger".

Pairing (pair_id):
- A trigger and the verb(s) it licenses share the same integer pair_id. Number pair_ids starting at 1 within each chunk.
- A single trigger may license multiple verbs — they all share its pair_id.
- A verb with NO trigger in the same chunk (imperatives, independent uses, or a trigger that fell in a previous chunk) still gets its own unique pair_id, with no trigger sharing it.

Special cases:
- Negative imperatives ("no me digas") and independent subjunctive uses ("que te vaya bien", "¡viva!"): tag the verb, no trigger.
- Two-mood triggers (aunque, cuando, quizás, mientras, relative clauses with indefinite antecedents): tag the pair ONLY when the verb is actually subjunctive. When the verb is indicative, tag NOTHING.
- Do NOT tag indicative verbs, even right after a que or a two-mood trigger.
- When you are uncertain whether a form is subjunctive in this context (homographs, ambiguous forms after quoted speech), OMIT it. A missed highlight is fine; a wrong one teaches wrong grammar.

Each annotation's "span" MUST be copied verbatim from this chunk's tlText, exactly as it appears (same accents, capitalization, and spacing), so it can be located in the text.

MOOD EXAMPLE — for the chunk tlText "No creo que llames antes de que él llegue":
- { span: "No creo que", role: "trigger", pair_id: 1 }
- { span: "llames", role: "subjunctive_verb", pair_id: 1 }
- { span: "antes de que", role: "trigger", pair_id: 2 }
- { span: "llegue", role: "subjunctive_verb", pair_id: 2 }

Call split_and_gloss with your output. Do not include any text outside the tool call.`;

// Prepended to SYSTEM_PROMPT when the caller flags this batch as song lyrics.
// Keeps the model from second-guessing poetic word order or non-literal
// imagery the way it would on a news article.
const LYRICS_ADDENDUM = `This text is song lyrics. Expect non-standard grammar, poetic word order for rhyme or meter, dropped subjects, and metaphorical or figurative language. Gloss the meaning, not the surface words, where they diverge. Don't flag poetic devices as errors. Word lookups should account for non-literal senses where context suggests them.

LYRICS CHUNKING OVERRIDE — this takes priority over the chunk-size and splitting rules below. The input is exactly ONE line of a song and is the atomic unit. Return EXACTLY ONE chunk: tlText is the whole Spanish line, englishGloss is the whole line's English meaning, and sentenceIndex is 0. Do NOT split the line into multiple chunks even if it exceeds 15 words. The 15-word maximum and every splitting rule below DO NOT APPLY to lyrics.

`;

const TOOL = {
  name: 'split_and_gloss',
  description: 'Break Spanish text into comprehensible-sized chunks with English glosses.',
  input_schema: {
    type: 'object' as const,
    properties: {
      chunks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tlText: { type: 'string' },
            englishGloss: { type: 'string' },
            sentenceIndex: { type: 'integer' },
            mood_annotations: {
              type: 'array',
              description:
                'Subjunctive verbs and their mood triggers in this chunk. Empty when the chunk has none.',
              items: {
                type: 'object',
                properties: {
                  span: { type: 'string' },
                  role: { type: 'string', enum: ['trigger', 'subjunctive_verb'] },
                  pair_id: { type: 'integer' },
                },
                required: ['span', 'role', 'pair_id'],
              },
            },
          },
          required: ['tlText', 'englishGloss', 'sentenceIndex'],
        },
      },
    },
    required: ['chunks'],
  },
};

// ===== CORS =====

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

// ===== Handler =====

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // Auth: forward the user's JWT to Supabase Auth to verify identity.
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

  const { data: userData, error: authError } = await supabase.auth.getUser();
  if (authError || !userData.user) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // Parse request body.
  let body: { text?: unknown; chunkingMode?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length === 0) {
    return jsonResponse({ error: 'No text provided' }, 400);
  }
  const chunkingMode: 'prose' | 'lyrics' =
    body.chunkingMode === 'lyrics' ? 'lyrics' : 'prose';

  // Call Anthropic with a Haiku→Sonnet fallback.
  const client = new Anthropic({ apiKey: anthropicKey });

  try {
    let result: { chunks: ValidatedChunk[]; model: string };
    try {
      // Primary: Haiku — fast and cheap, handles ~95%+ of batches.
      result = await callModel(client, text, PRIMARY_MODEL, PRIMARY_TIMEOUT_MS, chunkingMode);
    } catch (primaryErr) {
      const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      // If Anthropic itself is overloaded (HTTP 529), Sonnet hits the same
      // backend and won't save us — short-circuit so the user sees a
      // specific "service overloaded" message in a few seconds instead of
      // waiting another 30s for Sonnet to also fail.
      if (isOverloadError(primaryErr)) {
        console.warn(`Anthropic overloaded on Haiku; skipping Sonnet fallback`);
        // Return 200 with a structured error so supabase-js exposes the
        // body to the client (non-2xx hides it). The client treats
        // payload.error as a non-retryable failure with this exact phrasing.
        return jsonResponse({
          error: 'Anthropic is at capacity right now. Please wait a few minutes and try again.',
          errorKind: 'overloaded',
        });
      }
      console.warn(`Haiku failed (${primaryMsg}); falling back to Sonnet`);
      result = await callModel(client, text, FALLBACK_MODEL, FALLBACK_TIMEOUT_MS, chunkingMode);
    }
    return jsonResponse({
      chunks: result.chunks,
      promptVersion: PROMPT_VERSION,
      model: result.model,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    // Log so we can see in Supabase logs which error escaped (Sonnet
    // timeout, refusal, malformed output, etc.) — previously only the
    // Haiku-failed warning showed up.
    console.error(`chunk-and-gloss outer failure: ${message}`);
    if (isOverloadError(e)) {
      return jsonResponse({
        error: 'Anthropic is at capacity right now. Please wait a few minutes and try again.',
        errorKind: 'overloaded',
      });
    }
    // Both Haiku AND Sonnet failed on this content. To distinguish
    // "Anthropic is down" from "Anthropic is refusing this specific
    // content" we run a tiny health check on a known-benign sentence.
    // If that works, we know the service is up — the content was refused.
    // If it fails, the service is genuinely unavailable.
    try {
      const healthy = await isServiceHealthy(client);
      if (healthy) {
        console.warn('chunk-and-gloss: content refused (health check passed)');
        return jsonResponse({
          error:
            'The translation service declined to process this batch (content policy). The batch will be skipped.',
          errorKind: 'refused',
        });
      }
    } catch (healthErr) {
      console.warn(
        `health check itself threw: ${healthErr instanceof Error ? healthErr.message : healthErr}`,
      );
    }
    return jsonResponse({
      error:
        'Translation service is unavailable right now. Please try again later.',
      errorKind: 'unavailable',
    });
  }
});

// ===== Anthropic call w/ timeout + structured parsing =====

type MoodRole = 'trigger' | 'subjunctive_verb';

interface MoodAnnotation {
  start: number;
  end: number;
  role: MoodRole;
  pairId: number;
}

interface ValidatedChunk {
  tlText: string;
  englishGloss: string;
  sentenceIndex: number;
  moodAnnotations?: MoodAnnotation[];
}

// Resolve the model's raw span-based mood_annotations into offset-based
// MoodAnnotations against a chunk's tlText. Mirrors resolveMoodAnnotations in
// src/prompt.ts — keep in sync. Each span must appear verbatim in tlText;
// malformed or unlocatable annotations are dropped (false negatives are cheap,
// false positives teach wrong grammar). Repeated spans resolve to their first
// occurrence. Returns undefined when nothing resolves, so the field is omitted.
function resolveMoodAnnotations(tlText: string, raw: unknown): MoodAnnotation[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const resolved: MoodAnnotation[] = [];
  for (const a of raw) {
    if (typeof a !== 'object' || a === null) continue;
    const span = (a as { span?: unknown }).span;
    const role = (a as { role?: unknown }).role;
    const pairId = (a as { pair_id?: unknown }).pair_id;
    if (typeof span !== 'string' || span.length === 0) continue;
    if (role !== 'trigger' && role !== 'subjunctive_verb') continue;
    if (typeof pairId !== 'number' || !Number.isFinite(pairId)) continue;
    const start = tlText.indexOf(span);
    if (start < 0) continue;
    resolved.push({ start, end: start + span.length, role, pairId: Math.trunc(pairId) });
  }
  return resolved.length > 0 ? resolved : undefined;
}

async function callModel(
  client: Anthropic,
  text: string,
  model: string,
  timeoutMs: number,
  chunkingMode: 'prose' | 'lyrics' = 'prose',
): Promise<{ chunks: ValidatedChunk[]; model: string }> {
  // For lyrics, the addendum precedes the cached SYSTEM_PROMPT block. The
  // shared prefix still benefits from Anthropic's ephemeral cache; the
  // addendum is small enough that re-sending it per request is fine.
  const systemBlocks =
    chunkingMode === 'lyrics'
      ? [
          { type: 'text' as const, text: LYRICS_ADDENDUM },
          { type: 'text' as const, text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' as const } },
        ]
      : [
          { type: 'text' as const, text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' as const } },
        ];
  const response = await withTimeout(
    client.messages.create({
      model,
      max_tokens: 8192,
      system: systemBlocks,
      messages: [{ role: 'user', content: text }],
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'split_and_gloss' },
    }),
    timeoutMs,
    model,
  );

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use' || toolUse.name !== 'split_and_gloss') {
    // Most likely a refusal: model returned text content instead of calling
    // the tool. Throw so the caller falls back to a more capable model.
    throw new Error(`${model} did not call the expected tool`);
  }

  const input = toolUse.input as unknown;
  if (
    typeof input !== 'object' ||
    input === null ||
    !('chunks' in input) ||
    !Array.isArray((input as { chunks: unknown }).chunks)
  ) {
    throw new Error(`${model} returned malformed tool input`);
  }
  const raw = (input as { chunks: unknown[] }).chunks;

  const chunks: ValidatedChunk[] = [];
  for (const c of raw) {
    if (
      typeof c === 'object' &&
      c !== null &&
      typeof (c as Record<string, unknown>).tlText === 'string' &&
      typeof (c as Record<string, unknown>).englishGloss === 'string' &&
      typeof (c as Record<string, unknown>).sentenceIndex === 'number'
    ) {
      const v = c as ValidatedChunk;
      const moodAnnotations = resolveMoodAnnotations(
        v.tlText,
        (c as { mood_annotations?: unknown }).mood_annotations,
      );
      chunks.push({
        tlText: v.tlText,
        englishGloss: v.englishGloss,
        sentenceIndex: Math.trunc(v.sentenceIndex),
        ...(moodAnnotations ? { moodAnnotations } : {}),
      });
    }
  }
  if (chunks.length === 0) {
    throw new Error(`${model} returned no valid chunks`);
  }
  return { chunks, model };
}

// Promise.race-based timeout. The underlying HTTP request may keep running
// after the timeout fires — that's fine; we just stop waiting for it.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// Detect Anthropic's HTTP 529 overloaded_error. The SDK throws an error
// whose .message contains the status code and body. We don't depend on
// SDK-specific shapes since the JSON body is always included in .message.
function isOverloadError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b529\b|overloaded_error|"Overloaded"/i.test(msg);
}

// Probe whether Anthropic + our function are healthy by chunking a tiny,
// uncontroversial sentence. Used as a tiebreaker when the real call has
// failed: if THIS works, the service is fine and the original failure was
// content refusal. If THIS also fails, the service is genuinely down.
//
// Short timeout (8s) since we expect this to either succeed quickly or
// confirm an outage. We don't want to add 30s of latency on the failure
// path.
const HEALTH_CHECK_SENTENCE = 'Hola, ¿cómo estás hoy?';
const HEALTH_CHECK_TIMEOUT_MS = 8_000;

async function isServiceHealthy(client: Anthropic): Promise<boolean> {
  try {
    const result = await callModel(
      client,
      HEALTH_CHECK_SENTENCE,
      PRIMARY_MODEL,
      HEALTH_CHECK_TIMEOUT_MS,
    );
    return result.chunks.length > 0;
  } catch {
    return false;
  }
}
