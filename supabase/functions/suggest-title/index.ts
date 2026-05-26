// Edge Function: suggest-title
//
// Generates a short, library-card-style title for a passage. Called once
// per passage at save time (or on demand via a "suggest title" button). The
// title is just a suggestion — the user can override it.
//
// Uses Haiku 4.5. Cheap (~1500 input tokens, ~30 output tokens; well under
// $0.001 per call). Failures are non-fatal — caller falls back to a
// first-sentence-derived title.

import Anthropic from 'npm:@anthropic-ai/sdk@0.95.2';
import { createClient } from 'npm:@supabase/supabase-js@2';

const MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = `You generate a short, descriptive title for a reading
passage. The user is browsing a personal library of articles, stories, and
essays — the title should help them recognize a passage at a glance.

Rules:
- 2–7 words. Strictly shorter is better.
- English, regardless of the passage's language.
- Title case ("The Things They Carried"), not all-caps.
- For a recognizable existing work (a poem, a published article, a Vonnegut
  story, a Wikipedia entry), use the actual title — possibly with a short
  identifier ("Mother Night, Introduction").
- For unknown / personal content, give a 2–5 word description of the topic
  or hook.
- No quotation marks. No trailing punctuation. No emojis.
- Don't include the source ("Article about…", "Story:") unless that's how
  the work is known.

Call suggest_title with your output. No other text.`;

const TOOL = {
  name: 'suggest_title',
  description: 'Provide a short title for a reading passage.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: {
        type: 'string',
        description: '2-7 word English title, no quotes or trailing punctuation.',
      },
    },
    required: ['title'],
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

  let body: { text?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length === 0) return jsonResponse({ error: 'No text provided' }, 400);

  // Truncate very long inputs — for title generation, the first ~2000 chars
  // is plenty of signal. Avoids burning input tokens on a 50-page article.
  const excerpt = text.length > 2000 ? text.slice(0, 2000) + '\n[…]' : text;

  const client = new Anthropic({ apiKey: anthropicKey });
  try {
    const response = await withTimeout(
      client.messages.create({
        model: MODEL,
        max_tokens: 256,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: excerpt }],
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'suggest_title' },
      }),
      TIMEOUT_MS,
    );
    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use' || toolUse.name !== 'suggest_title') {
      return jsonResponse({ error: 'Model did not call the expected tool' }, 502);
    }
    const input = toolUse.input as { title?: unknown };
    if (typeof input.title !== 'string' || input.title.trim().length === 0) {
      return jsonResponse({ error: 'No title in tool response' }, 502);
    }
    // Defensive: trim, strip wrapping quotes, cap length.
    let title = input.title.trim();
    title = title.replace(/^["'“‘]|["'”’]$/g, '').trim();
    if (title.length > 80) title = title.slice(0, 80).trim();
    return jsonResponse({ title });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`suggest-title call failed: ${msg}`);
    return jsonResponse({ error: 'Title suggestion failed.' }, 502);
  }
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`suggest-title timed out after ${ms}ms`)), ms),
    ),
  ]);
}
