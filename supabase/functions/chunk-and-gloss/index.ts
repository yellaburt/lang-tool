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

const PROMPT_VERSION = 'v3';
const MODEL = 'claude-haiku-4-5';

const SYSTEM_PROMPT = `You prepare a reading lesson for an intermediate Spanish learner. The user pastes a passage that may be in Spanish OR in English. Your job: produce Spanish chunks (5-15 words each) with an English gloss for each chunk.

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
  let body: { text?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length === 0) {
    return jsonResponse({ error: 'No text provided' }, 400);
  }

  // Call Anthropic.
  const client = new Anthropic({ apiKey: anthropicKey });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: text }],
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'split_and_gloss' },
    });

    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use' || toolUse.name !== 'split_and_gloss') {
      return jsonResponse({ error: 'Model did not call the expected tool' }, 502);
    }

    const input = toolUse.input as unknown;
    if (
      typeof input !== 'object' ||
      input === null ||
      !('chunks' in input) ||
      !Array.isArray((input as { chunks: unknown }).chunks)
    ) {
      return jsonResponse({ error: 'Tool response shape was invalid' }, 502);
    }
    const raw = (input as { chunks: unknown[] }).chunks;

    const chunks: Array<{ tlText: string; englishGloss: string; sentenceIndex: number }> = [];
    for (const c of raw) {
      if (
        typeof c === 'object' &&
        c !== null &&
        typeof (c as Record<string, unknown>).tlText === 'string' &&
        typeof (c as Record<string, unknown>).englishGloss === 'string' &&
        typeof (c as Record<string, unknown>).sentenceIndex === 'number'
      ) {
        const v = c as { tlText: string; englishGloss: string; sentenceIndex: number };
        chunks.push({
          tlText: v.tlText,
          englishGloss: v.englishGloss,
          sentenceIndex: Math.trunc(v.sentenceIndex),
        });
      }
    }
    if (chunks.length === 0) {
      return jsonResponse({ error: 'No valid chunks returned' }, 502);
    }

    return jsonResponse({ chunks, promptVersion: PROMPT_VERSION, model: MODEL });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return jsonResponse({ error: `Anthropic call failed: ${message}` }, 502);
  }
});
