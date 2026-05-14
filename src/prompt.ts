// Shared between the client and the Supabase Edge Function so the prompt,
// tool schema, ChunkAndGloss type, and response validation stay in lockstep.
// Only pure data + pure functions here — no SDK imports, no env access.

// Bump this whenever the prompt or tool schema changes so cached results are
// invalidated client-side. The cache key is SHA-256(passage|model|version).
export const PROMPT_VERSION = 'v3';

// Default model used by both client cache key and edge function.
export const MODEL = 'claude-haiku-4-5';

export interface ChunkAndGloss {
  readonly tlText: string;
  readonly englishGloss: string;
  readonly sentenceIndex: number;
}

export const SYSTEM_PROMPT = `You prepare a reading lesson for an intermediate Spanish learner. The user pastes a passage that may be in Spanish OR in English. Your job: produce Spanish chunks (5-15 words each) with an English gloss for each chunk.

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
        },
        required: ['tlText', 'englishGloss', 'sentenceIndex'],
      },
    },
  },
  required: ['chunks'],
};

export const TOOL_DESCRIPTION =
  'Break Spanish text into comprehensible-sized chunks with English glosses.';

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
      validated.push({
        tlText: v.tlText,
        englishGloss: v.englishGloss,
        sentenceIndex: Math.trunc(v.sentenceIndex),
      });
    }
  }
  if (validated.length === 0) {
    throw new Error('No valid chunks in tool response.');
  }
  return validated;
}
