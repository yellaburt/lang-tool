// Shared between the client and the Supabase Edge Function so the prompt,
// tool schema, ChunkAndGloss type, and response validation stay in lockstep.
// Only pure data + pure functions here — no SDK imports, no env access.

// Bump this whenever the prompt or tool schema changes so cached results are
// invalidated client-side. The cache key is SHA-256(passage|model|version).
// v5: added mood_annotations (subjunctive highlighting) to the tool schema.
export const PROMPT_VERSION = 'v5';

// Default model used by both client cache key and edge function.
export const MODEL = 'claude-haiku-4-5';

// Resolved subjunctive-highlighting annotation, offsets into tlText. Mirrors
// MoodAnnotation in types.ts — kept in sync manually (this file is self-
// contained so it can be duplicated into the Deno edge function).
export type MoodRole = 'trigger' | 'subjunctive_verb';

export interface MoodAnnotation {
  readonly start: number;
  readonly end: number;
  readonly role: MoodRole;
  readonly pairId: number;
}

export interface ChunkAndGloss {
  readonly tlText: string;
  readonly englishGloss: string;
  readonly sentenceIndex: number;
  // Resolved server-side from the model's raw span output. Absent when the
  // chunk has no subjunctive forms.
  readonly moodAnnotations?: ReadonlyArray<MoodAnnotation>;
}

export const SYSTEM_PROMPT = `You are a translation aid for an adult Spanish-reading practice tool. The user pastes a passage that may be in Spanish OR in English. Your job: produce Spanish chunks (5-15 words each) with an English gloss for each chunk.

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

// Anthropic tool-use schema. The shape is duplicated from
// Anthropic.Tool['input_schema'] because we want this file SDK-free.
export const TOOL_NAME = 'split_and_gloss';

export const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    chunks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tlText: {
            type: 'string',
            description: 'The Spanish chunk, exactly as it appears in the source passage.',
          },
          englishGloss: {
            type: 'string',
            description: 'Natural English meaning of this chunk in context.',
          },
          sentenceIndex: {
            type: 'integer',
            description:
              '0-based index of the source sentence. All sub-chunks of one source sentence share an index.',
          },
          mood_annotations: {
            type: 'array',
            description:
              'Subjunctive verbs and their mood triggers in this chunk. Empty when the chunk has none.',
            items: {
              type: 'object',
              properties: {
                span: {
                  type: 'string',
                  description:
                    'Exact substring of this chunk\'s tlText for the trigger or verb, copied verbatim.',
                },
                role: {
                  type: 'string',
                  enum: ['trigger', 'subjunctive_verb'],
                  description: 'Whether this span is a mood trigger or the subjunctive verb it licenses.',
                },
                pair_id: {
                  type: 'integer',
                  description:
                    'Links a trigger to the verb(s) it licenses (shared id). A verb with no trigger gets its own id.',
                },
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
};

export const TOOL_DESCRIPTION =
  'Break Spanish text into comprehensible-sized chunks with English glosses.';

// Resolve the model's raw span-based mood_annotations into offset-based
// MoodAnnotations against a chunk's tlText. Each span must appear verbatim in
// tlText; annotations whose span can't be located (or that are malformed) are
// dropped — false negatives are cheap, false positives teach wrong grammar.
// Repeated spans resolve to their first occurrence (adequate for ≤15-word
// chunks). Returns undefined when nothing resolves, so the field is omitted.
export function resolveMoodAnnotations(
  tlText: string,
  raw: unknown,
): ReadonlyArray<MoodAnnotation> | undefined {
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

// Validate a raw tool-use response into a known shape. Either the client or
// the edge function can call this. Throws on invalid input.
export function validateChunksFromToolUse(input: unknown): ReadonlyArray<ChunkAndGloss> {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('chunks' in input) ||
    !Array.isArray((input as { chunks: unknown }).chunks)
  ) {
    throw new Error('Tool response was not in the expected shape.');
  }
  const raw = (input as { chunks: ReadonlyArray<unknown> }).chunks;
  const validated: ChunkAndGloss[] = [];
  for (const c of raw) {
    if (
      typeof c === 'object' &&
      c !== null &&
      typeof (c as { tlText?: unknown }).tlText === 'string' &&
      typeof (c as { englishGloss?: unknown }).englishGloss === 'string' &&
      typeof (c as { sentenceIndex?: unknown }).sentenceIndex === 'number'
    ) {
      const v = c as { tlText: string; englishGloss: string; sentenceIndex: number };
      const moodAnnotations = resolveMoodAnnotations(
        v.tlText,
        (c as { mood_annotations?: unknown }).mood_annotations,
      );
      validated.push({
        tlText: v.tlText,
        englishGloss: v.englishGloss,
        sentenceIndex: Math.trunc(v.sentenceIndex),
        ...(moodAnnotations ? { moodAnnotations } : {}),
      });
    }
  }
  if (validated.length === 0) {
    throw new Error('No valid chunks in tool response.');
  }
  return validated;
}
