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
import {
  applyLexicon,
  formatLexiconFacts,
  scanLexiconFacts,
  type CandidateAnnotation,
  type CheckedAnnotation,
  type LexiconDisagreement,
} from '../_shared/subjunctive.ts';
import { detectSourceLanguage } from '../_shared/language.ts';

// ===== Shared prompt block — keep in sync with src/prompt.ts =====

// v5: added mood_annotations (subjunctive highlighting) to the tool schema.
// v6: faithful-translation framing; possible_subjunctive role + lemma on verb
//     annotations (lexicon veto); tightened two-mood triggers; preceding-context
//     and lexicon-facts blocks in the user message.
// v7: preceding context is the last 6 chunks as Spanish = English gloss pairs
//     (2 Spanish-only chunks missed gender established a few chunks back).
const PROMPT_VERSION = 'v7';
const PRIMARY_MODEL = 'claude-haiku-4-5';
const FALLBACK_MODEL = 'claude-sonnet-4-5';
// Wall-clock timeouts per call. Supabase Edge Functions get killed around
// 75s, so the worst-case (Haiku timeout + Sonnet timeout + overhead) must
// stay under that. For normal batches both models respond in well under 10s.
const PRIMARY_TIMEOUT_MS = 20_000;
const FALLBACK_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = `You are a translation aid for an adult Spanish-reading practice tool. The user pastes a passage that may be in Spanish OR in English. Your job: produce Spanish chunks (5-15 words each) with an English gloss for each chunk.

The task is a faithful translation of published literary and journalistic work — novels, stories, history, memoir, news — for an adult reader who is studying it in the original. These works often depict violence, sexuality, cruelty, war, crime and illness, and those passages are frequently central to the story. Render them accurately, with the same force and explicitness as the source. You are a translation and chunking aid, NOT a content moderator; the reader chose the text.

NEVER soften, summarize, sanitize, euphemize or omit anything. Every sentence of the input must appear in your output, translated in full. A silently softened or shortened translation is worse than no translation, because the reader cannot tell that anything is missing.

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

INPUT FORMAT:

The user message is either the plain text to process, or it contains up to three labelled blocks:
- PRECEDING CONTEXT: the chunks that come just before this text in the same work, one per line, each as "Spanish = English gloss the reader was shown". They were already processed. Do NOT chunk, gloss or return them. Use them to work out who dropped subjects and pronouns refer to, so the English gloss gets the right he/she/they/it. Spanish omits subject pronouns, and a verb like "pasó" or "se movió" says nothing about gender — so read the earlier Spanish for gender markers (adormecida, cansado, ella) and the earlier English glosses for the subject already established ("She moved…"). Keep that same subject unless the Spanish clearly introduces a different one. Never default to "he".
- LEXICON FACTS: verb forms in the text that a deterministic conjugation table has identified. These are authoritative GIVEN FACTS about mood and tense, not suggestions. Gloss each one accordingly (e.g. an imperfect subjunctive "aullaran" is "would howl / howled", never the future "will howl") and do not re-derive it.
- TEXT TO PROCESS: the text you must chunk and gloss. Everything in your output comes from this block only.

MOOD ANNOTATIONS (subjunctive highlighting):

For each chunk, also return a mood_annotations array marking Spanish subjunctive verb forms and the mood triggers that license them. This drives a visual highlight that helps the reader notice subjunctive morphology. If a chunk has no subjunctive forms, return an empty mood_annotations array (or omit it).

What to tag:
- Every subjunctive VERB form: present, imperfect (both -ra and -se forms), present perfect, and pluperfect subjunctive. For perfect forms, tag the WHOLE verb phrase including the auxiliary (e.g. "haya llamado", "hubiera venido"). role = "subjunctive_verb". Give its infinitive in "lemma" (e.g. "llamar" for "haya llamado", "ir" for "vaya").
- The mood TRIGGER when it appears in the SAME chunk: a conjunction or verb + que, or a subordinator that governs the subjunctive (e.g. "quiero que", "dudo que", "es posible que", "para que", "sin que", "antes de que"). role = "trigger".

Before tagging ANY trigger, first identify the verb it governs and confirm that verb is subjunctive. No subjunctive verb, no trigger.

Pairing (pair_id):
- A trigger and the verb(s) it licenses share the same integer pair_id. Number pair_ids starting at 1 within each chunk.
- A single trigger may license multiple verbs — they all share its pair_id.
- A verb with NO trigger in the same chunk (imperatives, independent uses, or a trigger that fell in a previous chunk) still gets its own unique pair_id, with no trigger sharing it.

Special cases:
- Negative imperatives ("no me digas") and independent subjunctive uses ("que te vaya bien", "¡viva!"): tag the verb, no trigger.
- Two-mood triggers (cuando, aunque, mientras, quizás, hasta que, si, después de que, relative clauses with indefinite antecedents, etc.) followed by an INDICATIVE verb get no tags at all — neither the trigger nor the verb. Example: "Cuando llegaba la comida, los seres humanos estaban callados" has NO subjunctive: llegaba and estaban are indicative. Tag nothing in it.
- Do NOT tag indicative verbs, even right after a que or a two-mood trigger. A nearby trigger word does not make the next verb subjunctive: check the verb's own ending ("se recuperó", "portas", "aullarán" are indicative).

Uncertainty:
- Uncertain whether a TRIGGER applies: omit it.
- Uncertain whether a VERB form is subjunctive in this context (e.g. homographs like "coma", "vaya", "cante", which can also be nouns or interjections): tag it with role = "possible_subjunctive" (with lemma and pair_id) instead of "subjunctive_verb". Never pair a trigger with a possible_subjunctive verb.

Each annotation's "span" MUST be copied verbatim from this chunk's tlText, exactly as it appears (same accents, capitalization, and spacing), so it can be located in the text.

MOOD EXAMPLE — for the chunk tlText "No creo que llames antes de que él llegue":
- { span: "No creo que", role: "trigger", pair_id: 1 }
- { span: "llames", role: "subjunctive_verb", pair_id: 1, lemma: "llamar" }
- { span: "antes de que", role: "trigger", pair_id: 2 }
- { span: "llegue", role: "subjunctive_verb", pair_id: 2, lemma: "llegar" }

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
                  role: {
                    type: 'string',
                    enum: ['trigger', 'subjunctive_verb', 'possible_subjunctive'],
                  },
                  pair_id: { type: 'integer' },
                  lemma: { type: 'string' },
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
  let body: { text?: unknown; chunkingMode?: unknown; context?: unknown };
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
  // Up to six preceding chunks as "Spanish = English gloss" lines, for pronoun
  // resolution only (item 8). The client only ever sends text that comes
  // BEFORE this batch.
  const context = Array.isArray(body.context)
    ? body.context
        .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        .slice(-MAX_CONTEXT_CHUNKS)
        .map((c) => c.trim().slice(0, MAX_CONTEXT_CHARS))
    : [];
  // Lexicon facts (item 5): verb forms the conjugation tables are sure about,
  // handed to the model as givens. Empty for English input — there's no
  // Spanish to scan until the model has translated it.
  const lexiconFacts = formatLexiconFacts(scanLexiconFacts(text));
  const request: ModelRequest = { text, chunkingMode, context, lexiconFacts };

  // Call Anthropic with a Haiku→Sonnet fallback.
  const client = new Anthropic({ apiKey: anthropicKey });

  try {
    let result: { chunks: ValidatedChunk[]; model: string };
    try {
      // Primary: Haiku — fast and cheap, handles ~95%+ of batches.
      result = await callModel(client, request, PRIMARY_MODEL, PRIMARY_TIMEOUT_MS);
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
      // Same framing, same request — Sonnet refuses less and follows the
      // schema more reliably. This is the one retry the server does; shifted
      // chunk boundaries for English sources are the client's job, since only
      // it knows the neighbouring sentences.
      console.warn(`Haiku failed (${primaryMsg}); falling back to Sonnet`);
      result = await callModel(client, request, FALLBACK_MODEL, FALLBACK_TIMEOUT_MS);
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
        // "refused" covers any content-specific failure: refusal prose, a
        // preamble instead of the tool call, truncation, or output that fails
        // schema validation. The client keeps the source text and marks the
        // chunk [not translated]; it never drops it.
        return jsonResponse({
          error: 'The translation service could not translate this section.',
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

// Item 8: how much preceding text rides along for pronoun resolution.
const MAX_CONTEXT_CHUNKS = 6;
const MAX_CONTEXT_CHARS = 400;

// Spanish input must come back essentially verbatim (rule 5), so if the chunks
// carry noticeably fewer letters than the input, something was dropped —
// sanitised or skipped. Treated as a failure, like a refusal: a visible
// "[not translated]" beats a silent hole. Lenient, because the model may
// legitimately drop a stray symbol or normalise whitespace.
const MIN_SPANISH_COVERAGE = 0.85;

interface ModelRequest {
  readonly text: string;
  readonly chunkingMode: 'prose' | 'lyrics';
  readonly context: ReadonlyArray<string>;
  readonly lexiconFacts: string;
}

interface ValidatedChunk {
  tlText: string;
  englishGloss: string;
  sentenceIndex: number;
  moodAnnotations?: CheckedAnnotation[];
  lexiconDisagreements?: LexiconDisagreement[];
}

// Resolve the model's raw span-based mood_annotations into offset-based
// annotations against a chunk's tlText. Mirrors resolveMoodAnnotations in
// src/prompt.ts — keep in sync. Each span must appear verbatim in tlText;
// malformed or unlocatable annotations are dropped (false negatives are cheap,
// false positives teach wrong grammar). Repeated spans resolve to their first
// occurrence. The lexicon post-pass (applyLexicon) runs on the result.
function resolveMoodAnnotations(tlText: string, raw: unknown): CandidateAnnotation[] {
  if (!Array.isArray(raw)) return [];
  const resolved: CandidateAnnotation[] = [];
  for (const a of raw) {
    if (typeof a !== 'object' || a === null) continue;
    const span = (a as { span?: unknown }).span;
    const role = (a as { role?: unknown }).role;
    const pairId = (a as { pair_id?: unknown }).pair_id;
    const lemma = (a as { lemma?: unknown }).lemma;
    if (typeof span !== 'string' || span.length === 0) continue;
    if (role !== 'trigger' && role !== 'subjunctive_verb' && role !== 'possible_subjunctive') {
      continue;
    }
    if (typeof pairId !== 'number' || !Number.isFinite(pairId)) continue;
    const start = tlText.indexOf(span);
    if (start < 0) continue;
    resolved.push({
      start,
      end: start + span.length,
      role,
      pairId: Math.trunc(pairId),
      ...(role !== 'trigger' && typeof lemma === 'string' && lemma.length > 0 ? { lemma } : {}),
    });
  }
  return resolved;
}

// Mirrors buildUserMessage in src/prompt.ts — keep in sync.
function buildUserMessage(
  text: string,
  context: ReadonlyArray<string>,
  lexiconFacts: string,
): string {
  if (context.length === 0 && lexiconFacts.length === 0) return text;
  const parts: string[] = [];
  if (context.length > 0) {
    parts.push(`PRECEDING CONTEXT (do not translate or return):\n<<<\n${context.join('\n')}\n>>>`);
  }
  if (lexiconFacts.length > 0) {
    parts.push(`LEXICON FACTS (authoritative):\n${lexiconFacts}`);
  }
  parts.push(`TEXT TO PROCESS:\n<<<\n${text}\n>>>`);
  return parts.join('\n\n');
}

function letterCount(s: string): number {
  return (s.match(/\p{L}/gu) ?? []).length;
}

// Failure is detected by schema validation, not by sniffing for refusal
// wording: anything that doesn't parse into the expected structure throws —
// refusal prose, a preamble instead of the tool call, truncation, a malformed
// chunk, or a Spanish input that came back with text missing.
async function callModel(
  client: Anthropic,
  request: ModelRequest,
  model: string,
  timeoutMs: number,
): Promise<{ chunks: ValidatedChunk[]; model: string }> {
  // For lyrics, the addendum precedes the cached SYSTEM_PROMPT block. The
  // shared prefix still benefits from Anthropic's ephemeral cache; the
  // addendum is small enough that re-sending it per request is fine.
  const systemBlocks =
    request.chunkingMode === 'lyrics'
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
      messages: [
        {
          role: 'user',
          content: buildUserMessage(request.text, request.context, request.lexiconFacts),
        },
      ],
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'split_and_gloss' },
    }),
    timeoutMs,
    model,
  );

  if (response.stop_reason === 'max_tokens') {
    // Truncated mid-tool-call: whatever parsed is a prefix of the answer.
    throw new Error(`${model} output was truncated`);
  }

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
      typeof c !== 'object' ||
      c === null ||
      typeof (c as Record<string, unknown>).tlText !== 'string' ||
      typeof (c as Record<string, unknown>).englishGloss !== 'string' ||
      typeof (c as Record<string, unknown>).sentenceIndex !== 'number'
    ) {
      // One bad chunk fails the whole response. Skipping it (as v5 did) would
      // silently drop part of the passage.
      throw new Error(`${model} returned a malformed chunk`);
    }
    const v = c as { tlText: string; englishGloss: string; sentenceIndex: number };
    if (v.englishGloss.trim().length === 0 && /\p{L}/u.test(v.tlText)) {
      throw new Error(`${model} returned an empty gloss`);
    }
    const { annotations, disagreements } = applyLexicon(
      v.tlText,
      resolveMoodAnnotations(v.tlText, (c as { mood_annotations?: unknown }).mood_annotations),
    );
    if (disagreements.length > 0) {
      console.warn(`lexicon disagreement: ${JSON.stringify(disagreements)}`);
    }
    chunks.push({
      tlText: v.tlText,
      englishGloss: v.englishGloss,
      sentenceIndex: Math.trunc(v.sentenceIndex),
      ...(annotations.length > 0 ? { moodAnnotations: annotations } : {}),
      ...(disagreements.length > 0 ? { lexiconDisagreements: disagreements } : {}),
    });
  }
  if (chunks.length === 0) {
    throw new Error(`${model} returned no valid chunks`);
  }
  if (detectSourceLanguage(request.text) === 'es') {
    const out = letterCount(chunks.map((ch) => ch.tlText).join(' '));
    if (out < letterCount(request.text) * MIN_SPANISH_COVERAGE) {
      throw new Error(`${model} dropped part of the Spanish input`);
    }
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
      { text: HEALTH_CHECK_SENTENCE, chunkingMode: 'prose', context: [], lexiconFacts: '' },
      PRIMARY_MODEL,
      HEALTH_CHECK_TIMEOUT_MS,
    );
    return result.chunks.length > 0;
  } catch {
    return false;
  }
}
