// Edge Function: explain-grammar
//
// Returns a grammar explanation for a single Spanish chunk — the kind of
// "why is this sentence shaped this way" commentary the word-lookup can't
// give. Cached in public.grammar_explanations so re-taps are instant.
// Every tap (cache hit or miss) writes a row to
// public.grammar_explanation_events for the calling user.
//
// Mirrors define-word in structure. No Sonnet fallback — single-sentence
// grammar commentary is well within Haiku's range.

import Anthropic from 'npm:@anthropic-ai/sdk@0.95.2';
import { createClient } from 'npm:@supabase/supabase-js@2';

const MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = `You are a Spanish grammar coach for an intermediate adult learner.
The learner is reading a Spanish chunk and tapped a "grammar" button to ask
why the sentence is shaped the way it is. You receive the Spanish chunk and
its English gloss. Explain the grammatical features that matter — not the
ones that don't.

DO flag, when present:
- Subjunctive moods (present, imperfect/past, especially -ara/-iera, -ase/-iese)
- Conditional and counterfactual si-clause structure
- Irregular preterites (fui, hice, tuve, etc.) when they're doing real work
- Reflexive, reciprocal, impersonal, or passive "se" constructions
- Clitic pronoun placement (lo, la, le, se) and clitic climbing
- Subject-verb-object inversions used for emphasis
- Idiomatic constructions whose meaning isn't compositional
- False friends or register-marked vocabulary (formal, vulgar, regional)
- Notable verb periphrases (ir a + inf, acabar de + inf, llevar + gerund, etc.)
- Mood shifts triggered by specific conjunctions (para que, aunque, etc.)

DO NOT flag:
- Regular present-tense conjugations
- Common cognates
- Plain "to be" with ser/estar unless the choice is actually instructive here
- Anything that an intermediate learner would already know cold

If the sentence is grammatically routine and has nothing worth noting for an
intermediate learner, call the tool with isUnremarkable: true, an empty
summary, and an empty notes array. Better to say nothing than to pad.

The summary should be one or two sentences orienting the learner: "This is a
counterfactual si-clause" or "Note the impersonal 'se'." The notes array
gives 0-4 specific topics with brief explanations. Be concise — the learner
sees the sentence; don't restate it.

Call explain_grammar with your output; do not write text outside the tool call.`;

const TOOL = {
  name: 'explain_grammar',
  description: 'Grammar explanation for a Spanish chunk for an intermediate learner.',
  input_schema: {
    type: 'object' as const,
    properties: {
      isUnremarkable: {
        type: 'boolean',
        description:
          'True if the sentence has no grammatical features worth flagging for an intermediate learner. When true, summary and notes should be empty.',
      },
      summary: {
        type: 'string',
        description:
          '1-2 sentences orienting the learner to what is notable. Empty string when isUnremarkable.',
      },
      notes: {
        type: 'array',
        description:
          '0-4 specific grammar points. Empty array when isUnremarkable.',
        items: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description:
                'Short label, e.g. "Past subjunctive (-ara/-iera)", "Impersonal se", "Si clause counterfactual".',
            },
            explanation: {
              type: 'string',
              description:
                'One or two sentences explaining this point in context.',
            },
          },
          required: ['topic', 'explanation'],
        },
      },
    },
    required: ['isUnremarkable', 'summary', 'notes'],
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

  const { data: userData, error: authError } = await supabase.auth.getUser();
  if (authError || !userData.user) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let body: {
    spanishText?: unknown;
    englishGloss?: unknown;
    language?: unknown;
    passageId?: unknown;
    chunkId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const spanishText =
    typeof body.spanishText === 'string' ? body.spanishText.trim() : '';
  const englishGloss =
    typeof body.englishGloss === 'string' ? body.englishGloss.trim() : '';
  const language = typeof body.language === 'string' ? body.language : 'es';
  const passageId =
    typeof body.passageId === 'string' && body.passageId.length > 0
      ? body.passageId
      : null;
  const chunkId =
    typeof body.chunkId === 'string' && body.chunkId.length > 0
      ? body.chunkId
      : null;
  if (spanishText.length === 0) {
    return jsonResponse({ error: 'No spanishText provided' }, 400);
  }

  function recordEvent(payload: unknown): void {
    void supabase
      .from('grammar_explanation_events')
      .insert({
        user_id: userData.user!.id,
        spanish_text: spanishText,
        english_gloss: englishGloss,
        passage_id: passageId,
        chunk_id: chunkId,
        language,
        payload,
      })
      .then(({ error }) => {
        if (error) {
          console.warn('grammar event insert failed:', error.message);
        }
      });
  }

  // 1. Check cache.
  const { data: cached } = await supabase
    .from('grammar_explanations')
    .select('payload')
    .eq('spanish_text', spanishText)
    .eq('english_gloss', englishGloss)
    .eq('language', language)
    .maybeSingle();
  if (cached?.payload) {
    recordEvent(cached.payload);
    return jsonResponse({ explanation: cached.payload, cached: true });
  }

  // 2. Cache miss — call Anthropic.
  const client = new Anthropic({ apiKey: anthropicKey });
  let explanation: Record<string, unknown>;
  try {
    const userMessage = `Spanish chunk: "${spanishText}"\n\nEnglish gloss: "${englishGloss}"`;
    const response = await withTimeout(
      client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: userMessage }],
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'explain_grammar' },
      }),
      TIMEOUT_MS,
    );
    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use' || toolUse.name !== 'explain_grammar') {
      console.error('explain-grammar: model did not call tool');
      return jsonResponse(
        { error: 'Grammar service had a problem. Please try again.' },
        502,
      );
    }
    explanation = toolUse.input as Record<string, unknown>;
    if (typeof explanation.isUnremarkable !== 'boolean') {
      return jsonResponse(
        { error: 'Grammar service returned malformed output.' },
        502,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`explain-grammar call failed: ${msg}`);
    if (/529|overloaded/i.test(msg)) {
      return jsonResponse({
        error: 'Grammar service is at capacity. Please wait a moment and try again.',
        errorKind: 'overloaded',
      });
    }
    return jsonResponse(
      { error: 'Grammar service had a problem. Please try again.' },
      502,
    );
  }

  // 3. Save to cache + record per-user event.
  void supabase
    .from('grammar_explanations')
    .insert({
      spanish_text: spanishText,
      english_gloss: englishGloss,
      language,
      payload: explanation,
    })
    .then(({ error }) => {
      if (error && !/duplicate|conflict|23505/i.test(error.message)) {
        console.warn('explain-grammar cache insert failed:', error.message);
      }
    });
  recordEvent(explanation);

  return jsonResponse({ explanation, cached: false });
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`explain-grammar timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}
