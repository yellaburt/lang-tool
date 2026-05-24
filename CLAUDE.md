# lang-tool — context for future Claude sessions

This file exists so any fresh Claude Code session on any machine can be
useful within ~2 minutes. **Read this first** when you start work on this
project. The deeper design document is `DESIGN.md` (older, may be stale on
recent details).

## Who and what

A personal Spanish-reading practice tool built by Pete for daily use by:

- **Pete** (intermediate Spanish, prepping for a trip to Spain — `DPD` account)
- **Adryane** (Pete's wife, Spanish learner, prefers literary content — `ARD` account)
- **Ben** (Pete's son, Stanford CS PhD in programming languages; Japanese
  learner; source of "interface module + switch statements over OOP"
  engineering principles that shape this codebase)

It complements italki sessions and Genki textbook study. It is **not**
trying to be Duolingo or a SaaS — three users total, ever.

The reading loop: paste a Spanish or English passage → Claude (Haiku, with
Sonnet fallback) chunks it into 5–15-word phrases with English glosses →
the app reads each Spanish chunk aloud, then reveals the English, then
optionally re-reads in Spanish with a contrasting voice, then advances.

## Stack

- **TypeScript 5.6** strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- **React 19** with `useReducer` as the state machine
- **Vite 8** build, **Vitest 4** tests
- **Web Speech API** for TTS (no ElevenLabs — uses the device's installed
  voices via `speechSynthesis`)
- **Supabase** for Postgres + auth + Edge Functions (Deno runtime)
- **Anthropic SDK** in the Edge Function only — client never sees the key
- **Cloudflare Workers** (static-assets mode) for hosting, auto-deployed
  from GitHub `main` branch

## Layout

```
src/
  app.tsx           ~900 lines: state machine (reducer), top-level App
                    component, all useEffects (auth, batch-fetch, sync to
                    Supabase, theme application, library auto-refresh).
  views.tsx         ~1500 lines: every React view component lives here
                    (LoginView, LibraryView, PasteView, ProcessingView,
                    ReadingView, SettingsModal, ErrorView). Also TTS
                    helpers (speakChunk + SpeechController) at the bottom.
  core.ts           Pure functions: chunkPassage, splitSentences, SRS,
                    addPassage, defaultSettings. No React, no I/O.
  types.ts          Domain types. Branded ID types (PassageId, ChunkId,
                    etc.) prevent mixing different IDs.
  prompt.ts         Shared SYSTEM_PROMPT, tool schema, ChunkAndGloss type,
                    validator. Duplicated in supabase/functions/.../index.ts
                    — keep in sync manually.
  supabase.ts       All Supabase calls: auth, CRUD, callChunkAndGloss
                    (with retry + humanized errors).
  llm.ts            Thin wrapper around supabase.callChunkAndGloss.
                    Retained for legacy hasApiKey() check.
  storage.ts        localStorage utilities — legacy, mostly inert post-Supabase.
  app.css           All styles. CSS variables for theme tokens.

supabase/
  functions/chunk-and-gloss/index.ts
                    The Edge Function. Validates user JWT, calls Anthropic
                    with the server-side key, returns chunks. Has the
                    Haiku→Sonnet fallback logic.
  migrations/       SQL schema for passages, reading_state, user_settings.

.github/workflows/
  deploy-supabase.yml  Auto-deploys the Edge Function when supabase/functions/
                       changes on main. Cloudflare auto-deploy is separately
                       wired via Cloudflare's GitHub integration.
```

## Key design decisions and the rationale

These come up repeatedly. Don't relitigate without reading the rationale.

### Functional core / imperative shell
`core.ts` is pure. All I/O (Supabase, Web Speech, localStorage) is in
`app.tsx` (effects) and `supabase.ts` (network). React reducer is also
pure. This keeps the logic testable and the side-effecting code small.

### Discriminated unions + assertNever
Every action and state-shape variant uses a `kind` field. Switch
statements end with `default: return assertNever(action)` so the
compiler flags missing cases. **Don't replace this with class hierarchies
or visitor patterns** — Ben specifically prefers switches and we lean
into them.

### Branded ID types
`type PassageId = string & { readonly __brand: 'PassageId' }`. The
compiler prevents using a ChunkId where a PassageId is expected. ID
constructors live in `core.ts` (`IdGen` interface) so the shell can
inject `crypto.randomUUID()` without polluting the core.

### Hardcoded Supabase URL + publishable key
In `src/supabase.ts`. **Not a mistake.** Cloudflare Workers (static-assets
mode) doesn't accept env vars, and the publishable key is RLS-constrained
so it's safe to ship publicly. The real secret (ANTHROPIC_API_KEY) lives
only in Supabase Edge Function secrets.

### Password auth (not magic links)
Magic link / OTP flow was unreliable (Supabase free-tier email rate
limits, magic links opening the wrong browser). Switched to username +
password with two pre-seeded accounts. Usernames map to synthetic
`@lang-tool.local` emails (never actually emailed). Public signups
disabled in Supabase dashboard. To add a new user: create them in
Supabase dashboard → add an entry to `USERNAME_TO_EMAIL` in
`src/supabase.ts` → push.

### Incremental batch processing (lazy LLM)
Long passages aren't sent to Anthropic all at once. The shell splits the
passage into sentences locally (`splitSentences` in `core.ts`), then the
batch-fetch effect in `app.tsx` sends 2 sentences at a time to the Edge
Function. Why 2: Claude alignment errors scale with batch complexity;
smaller batches reduce the rate of misaligned Spanish-to-English
chunks. The user starts reading once the first batch lands; subsequent
batches arrive in the background as they approach the end.

### Haiku primary, Sonnet fallback
`chunk-and-gloss/index.ts` tries Claude Haiku 4.5 first (~$0.30/month
at Pete's volume). On failure — timeout, refusal (no tool_use returned),
empty chunks, or malformed output — it retries the same batch on Claude
Sonnet 4.5. Sonnet handles literary/historical content (Holocaust
memoir, war reporting, etc.) more reliably than Haiku. Expected fallback
rate: <5% of batches. **Exception**: on HTTP 529 "overloaded" from
Anthropic, we skip the Sonnet fallback because Sonnet hits the same
overloaded backend.

### Pause = restart-current-chunk on resume (not synth.resume)
Web Speech API's `speechSynthesis.resume()` silently fails after the
synth has been paused for more than a few seconds, especially in Chrome.
Reliable approach: on resume, cancel the parked utterance and re-speak
the current chunk from the beginning. The cost is re-hearing a few
seconds of audio the user already heard; the benefit is "Resume" always
works. Implemented in all three speech-phase effects in `ReadingView`.

### Auto-deploy from GitHub
Cloudflare watches the repo (Workers & Pages → lang-tool → Settings →
Build connected to `yellaburt/lang-tool`). GitHub Actions watches it
too (`deploy-supabase.yml` runs on push when `supabase/functions/`
changes). **Never run `npx wrangler deploy` or `npx supabase functions
deploy` manually anymore** — that bypasses the audit trail. Always
commit + push.

## Deployment workflow

1. Make changes locally.
2. `git push` (or use Claude Code's git tools — same thing).
3. Cloudflare auto-deploys static site within ~1-2 min.
4. GitHub Actions auto-deploys Edge Function if `supabase/functions/`
   changed.
5. Pete hard-refreshes / pulls-down to load the new version.

## Testing on phones

Both Pete and Adryane read on phones in addition to desktop. Always
think about touch interactions:
- Bottom-of-screen overlays steal real estate (URL bar overlap)
- Web Speech behavior varies by browser/OS — Android Chrome is the
  primary mobile target
- `@media (hover: none) and (pointer: coarse)` is the touch detection
  used throughout the CSS

## Costs

Pete is on Anthropic's Build tier with $5 promo credit. Burn rate:
~$0.30/month at current usage on Haiku-only. Sonnet fallback could push
to ~$1-2/month worst case. Not money to worry about.

Supabase is on free tier (500MB Postgres, 2M Edge Function invocations,
1GB egress). Cloudflare free tier handles the static site.

## Open / known issues

- Edge Function `src/prompt.ts` and `supabase/functions/chunk-and-gloss/index.ts`
  duplicate the SYSTEM_PROMPT, tool schema, and validator. Manual sync
  required. Someday: build-time injection. Not worth doing while it's
  just two files.
- Web Speech is finicky cross-platform. Voices load asynchronously
  (5s grace period in `useAvailableVoices`). Pause/resume hacks above.
- No real undo. If you delete a passage, it's gone.

## Things Pete cares about

- **Quality of explanation**: he's technical (was a programmer, now
  uses tools daily) and wants real tradeoffs surfaced, not breezy
  confidence.
- **Honest cost/effort estimates** in hours-of-his-own-vibe-coding,
  with ranges and tail (e.g., "2-4 hours, possibly 6 if X").
- **Trip to Spain** is the immediate goal — practical Spanish fluency,
  not academic completeness.
- **Adryane's anxiety about formal grammar** — features that emphasize
  comprehension over production are good. Don't surface grammar
  jargon unless asked.
- **Spain trip readiness** is more important than Mexican Spanish even
  though Mexican Spanish is the default dialect (because Adryane's
  learning materials use it).
