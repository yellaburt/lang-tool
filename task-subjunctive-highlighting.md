# Task: Subjunctive highlighting (input enhancement)

**Status:** In progress. Steps 1–3 (types, prompt/schema, span→offset resolution)
are committed; step 4 (render) is committed too — annotated word tokens now carry
`mood-trigger` / `mood-verb` classes and a `--mood-hue`, but **`app.css` has no
rules for them yet, so nothing is visible until step 5**. Steps 5–6 (styles,
toggle) are scoped in detail below. Plan reconciled against the actual codebase
2026-08-15 — see "Scoping corrections" for where the original spec's assumptions
didn't match the code.

**Goal:** Visually mark subjunctive verb forms and their mood triggers in passage text, so the reader notices subjunctive morphology that "good-enough" comprehension otherwise skips over. This is textual input enhancement targeted at a form (regular-stem subjunctive, where mood is marked by a single theme-vowel swap) that skilled readers demonstrably fail to notice.

## Background / rationale

Pete comprehends passages fine but does not register subjunctive forms — especially regular stems (*hable*, *coma*), where the marker is one vowel and the form pattern-matches as an ordinary verb of the opposite conjugation class. The fix is a pre-attentive visual cue, paired with the existing grammar-note feature for on-demand explanation. Design intent: the highlight does the *noticing*; the grammar note does the *understanding*.

## Scoping corrections (spec vs. actual code)

The original spec was written against an earlier mental model. Three corrections
that materially shrink the work:

1. **There is no shared, content-keyed chunk cache.** The spec said to store
   `mood_annotations` "alongside the existing gloss cache (content-keyed, shared
   across users)." That cache does not exist for chunks — glosses are part of each
   `Chunk`, and chunks are persisted as a **JSONB blob on the `passages` row**
   (`supabase.ts` `passageRow`; confirmed by the lyrics migration comment:
   "stored inside each chunk's JSONB record"). Annotations ride along as a new
   optional field on `Chunk`, exactly like `precededByBlankLine` did for lyrics.
   → The spec's "Cache invalidation" section is moot and has been removed.

2. **No SQL migration is needed — for anything.** Both storage sites are
   schema-free: chunks are JSONB (new field is free), and settings are a single
   versioned JSONB blob (`user_settings.settings`), so `highlight_subjunctive` is
   just a field in `defaultSettings()` that merges over old blobs on load
   (`fetchSettings`, `supabase.ts`). → The spec's "add a settings migration + watch
   the duplicate `20260527` prefix" warning does not apply here; we add zero
   migrations. (That collision was real — `20260527_grammar_explanations` — but it
   can't bite a change that adds no migrations.)

3. **The grammar-note feature already exists.** The spec treated it as
   "existing/planned." It is shipped: the `¶` button (`views.tsx`), `GrammarPanel`,
   the `explain-grammar` Edge Function, and the `grammar_explanations` cache. So the
   "highlight noticing / grammar note understanding" pairing is already wired;
   highlighting only needs to compose with the existing `ClickableSpanish` + `¶`
   render.

Minor: the reading modes are `scaffolded | listening | light | reading` — there is
no `lyrics` *reading* mode (lyrics is a `chunkingMode`). Highlighting applies across
all four reading modes **and** both chunking modes.

## Design decisions (already made — do not relitigate)

1. **Color, not italics.** Italics carry existing meaning in literary prose.
2. **Cause-and-effect pairing, same hue family, different weight:**
   - Mood **trigger** (e.g., *quiero que*, *dudo que*, *para que*, *antes de que*): muted shade (e.g., soft amber / low-saturation).
   - **Subjunctive verb**: saturated version of the same hue.
   - The shared hue family visually reconnects trigger and verb even when separated by intervening clauses. No arrows, brackets, or other diagram furniture. With multiple pairs in one chunk, cycle a small hue set by `pair_id`.
3. **Per-user toggle**, stored in the settings JSONB blob (same mechanism as
   `readingMode` / `readAloudOnAdvance` — NOT a SQL column). Default: **ON**
   (decided 2026-08-15). The off state is also a self-test ("can I spot them unaided?").
4. Highlighting applies in all reading modes and both chunking modes, wherever Spanish text is displayed.

## Architecture decision: annotations fold into `chunk-and-gloss`

Produce annotations inside the existing `chunk-and-gloss` call, **not** a separate
on-demand function.

Why: highlighting is **passive and always-on** — every chunk needs annotations the
moment it renders. A dedicated per-chunk function (like `explain-grammar`) is the
wrong shape: it would fire a call for *every* chunk on first view, ~doubling
processing calls and adding latency before highlights appear. Folding into
`chunk-and-gloss` means annotations arrive **with the chunk, at zero extra calls and
near-zero extra latency** (a few more output tokens on a call already happening).
Cost stays ~$0.30/mo.

Tradeoff accepted: annotation logic now lives in the hot chunking path. Mitigate by
keeping it strictly additive — the model still returns the same chunks;
`mood_annotations` is an optional extra array — and bump `PROMPT_VERSION` to `v5`.

## Data model

Add an optional field to `Chunk` (in `types.ts`), mirroring `precededByBlankLine`'s
optional/backward-compat pattern. Suggested shape:

```json
"moodAnnotations": [
  { "start": 0,  "end": 10, "role": "trigger",          "pairId": 1 },
  { "start": 34, "end": 40, "role": "subjunctive_verb", "pairId": 1 }
]
```

- `role`: `"trigger"` | `"subjunctive_verb"`.
- `pairId`: links a trigger to its licensed verb(s). A single trigger may license multiple verbs (shared `pairId`); a verb may appear with **no** pair (see edge cases).
- `start`/`end` are **character offsets into the chunk's `tlText`**, resolved
  server-side (see Anchoring). Character offsets — not token indices — because the
  renderer re-tokenizes `tlText` and can intersect ranges cleanly.

Old passages simply lack the field and render unhighlighted (graceful degradation,
same as `precededByBlankLine`). No reprocessing.

## Anchoring (the real engineering risk)

LLMs are unreliable at emitting exact character offsets, so:

- The model returns per annotation: `span` (exact substring), `role`, `pairId`.
- **Resolve `span` → `[start,end)` deterministically in the Edge Function** by
  locating it in `tlText`. If it is not found as a clean substring, **drop the
  annotation** (honors "false negatives are cheap, false positives teach wrong
  grammar"). Store the resolved range on the chunk so the renderer never re-searches.
- Chunks are ≤15 words, so first-occurrence matching is adequate for v1; ambiguous
  repeated words just get dropped.

## Pipeline changes

Extend the chunk-and-gloss prompt + tool schema. **The prompt and schema are
duplicated in `src/prompt.ts` and `supabase/functions/chunk-and-gloss/index.ts` —
edit both and keep them in sync.** Instructions to the model:

- Tag **all** subjunctive verb forms: present, imperfect (both *-ra* and *-se*), present perfect, pluperfect subjunctive. Include the auxiliary in perfect forms (*haya llamado* → tag the whole verb phrase).
- Tag the trigger phrase when present in the same chunk (conjunction/verb + *que*, e.g. *quiero que*, *es posible que*, *para que*, *sin que*, *antes de que*).
- Negative imperatives (*no me digas*) and independent subjunctive uses (*que te vaya bien*, *¡viva!*): tag the verb, no trigger.
- **Do not** tag indicative verbs even after two-mood triggers.

Extend `TOOL_INPUT_SCHEMA` with an optional `mood_annotations` array per chunk, and
extend `validateChunksFromToolUse` (and the edge function's inline validator) to
resolve/validate the spans. Bump `PROMPT_VERSION` → `v5` in both copies.

## Edge cases (handle deliberately)

1. **Two-mood triggers** (*aunque*, *cuando*, *quizás*, *mientras*, relative clauses with indefinite antecedents): highlight the pair only when the verb is **subjunctive**; highlight nothing when **indicative**. The contrast surfacing over time is itself the lesson; the grammar-note feature explains it on tap. This is the highest-risk spot for a cheap model over-tagging — budget prompt-iteration time here and lean on omit-when-uncertain.
2. **Verb without visible trigger** (imperatives, independent uses, trigger in a previous sentence/chunk): highlight the verb solo. Renderer must not assume every `subjunctive_verb` has a partner.
3. **Trigger and verb split across chunks:** tag each side in its own chunk; don't attempt cross-chunk pairing in v1.
4. **Ambiguous forms** (*hable* 1st vs 3rd person is fine; homographs with nouns/other tenses, forms after quoted speech): when uncertain whether a form is subjunctive in context, omit the tag. False negatives are cheap; false positives teach wrong grammar.

## Rendering

- Extend `tokenizeSpanish` (`views.tsx`) to carry each token's char offset; have
  `ClickableSpanish` add a `mood-trigger` / `mood-verb` (hue-by-`pairId`)
  **className** to word-tokens whose range intersects an annotation.
- className-only (no extra wrapping element) so the tap `<button>`s and their
  geometry are untouched — this is what satisfies "must not break tap-region
  geometry from Task 1."
- Colors as CSS variables so they're themeable; pick values that survive all six
  themes (light + dark). A subtle tint, not a highlighter stripe.
- No new interaction in v1: highlights are passive. Grammar-note `¶` tap (already
  shipped) is the explanation path.

## Settings

- Add `highlight_subjunctive: true` to `defaultSettings()` (`core.ts`). It merges
  over older stored blobs automatically via `fetchSettings`; `normalizeSettings`
  needs no change (absent key falls back to the default). **No SQL migration.**
- Add the toggle to the Appearance section of the settings accordion (`views.tsx`).
- Gate the render: apply annotation classes only when the setting is on.

## Implementation steps

| # | Area | Files | Effort | Status |
|---|------|-------|--------|--------|
| 1 | Types: `MoodAnnotation` + optional `moodAnnotations?` on `Chunk` | `types.ts` | 15 min | ✅ done |
| 2 | Prompt + tool schema (both copies), bump `PROMPT_VERSION`→`v5` | `prompt.ts`, `chunk-and-gloss/index.ts` | 1.5–2.5 hr | ✅ done |
| 3 | Resolve `span`→char range + validate/drop; carry through to `Chunk` (both prose + lyrics paths) | `prompt.ts`, `chunk-and-gloss/index.ts`, `app.tsx`, `prompt.test.ts` | 1–1.5 hr | ✅ done |
| 4 | Render: thread offsets through tokenizer, apply hue classes | `views.tsx` (`tokenizeSpanish`, `ClickableSpanish`) | 1.5–2.5 hr | ✅ done |
| 5 | Styles: trigger/verb tints keyed on `--mood-hue`, per theme | `app.css` | 1.5–3 hr | ✅ done, verified in all 6 themes |
| 6 | Setting (`highlightSubjunctive`, default ON) + toggle + CSS gate | `types.ts`, `core.ts`, `app.tsx`, `views.tsx` | 1–1.5 hr | ✅ done |
| 7 | Manual verification (seed passages, mobile tap, toggle, themes) | seed/manual | 1–1.5 hr | ⬜ next |

**Original total: ~8–12 hours, tail to ~15.** Steps 1–3 landed near estimate.
**Remaining (4–7): ~5–8 hours, tail ~9** — the only soft spot is cross-theme CSS
tuning (step 5); everything else is mechanical and follows existing precedent.

## Steps 4–6 detail (scoped against code 2026-08-15)

### Key decision: gate via a root data-attribute + CSS, not prop-threading

The codebase already applies `emphasisStyle`/`theme` by setting `data-emphasis` /
`data-theme` on `<html>` (`app.tsx` ~1592), with CSS keying off
`[data-emphasis='…']`. Mirror that instead of passing a boolean down the render
tree:

- **Always render** the mood classes on annotated word tokens (data is already on
  `chunk.moodAnnotations` after step 3).
- Add a root `data-highlight-subjunctive="on|off"` attribute via one `useEffect`.
- CSS shows the tint only under `[data-highlight-subjunctive='on']`.

So the toggle is **pure CSS** — no boolean threaded through `SentenceItem` →
`ClickableSpanish`.

Two conventions:
- **`highlightSubjunctive` (camelCase)**, not the earlier `highlight_subjunctive` —
  the `Settings` interface is camelCase throughout.
- **Tint via `background` / `box-shadow` keyed on an inline `--mood-hue` var**, not
  text color. The active chunk already changes *text color* via `data-emphasis`; a
  background tint composes cleanly instead of fighting it, and matches the spec's
  "a tint, not a highlighter stripe." Hue cycles a small fixed palette (4 hues) by
  `pairId`; verb more saturated than trigger. `background`/`box-shadow` only (no
  padding/border) so tap-target geometry doesn't reflow.

### Step 4 — render (`views.tsx`)

- **4a** `tokenizeSpanish`: extend each returned token with `start`/`end` char
  offsets (running position) so word tokens can be intersected with annotations.
- **4b** `ClickableSpanish`: add `moodAnnotations?` prop; for each **word** token,
  find an annotation whose range intersects
  (`tok.start < ann.end && ann.start < tok.end`) and attach `mood-trigger` /
  `mood-verb` class + inline `--mood-hue` (from `pairId % 4`). Pass
  `moodAnnotations={c.moodAnnotations}` at both call sites (past sentence ~2804,
  current sentence ~2865). Import `MoodAnnotation`. First intersecting annotation
  wins if two overlap (rare).

**Step 4 as built:** `tokenizeSpanish` now returns `{text, isWord, start, end}`
(offsets from `RegExpExecArray.index`). `ClickableSpanish` takes an optional
`moodAnnotations` prop — typed `| undefined` explicitly, since
`exactOptionalPropertyTypes` is on and the call sites pass `c.moodAnnotations`
straight through. Hue comes from `MOOD_HUES = [38, 190, 280, 340]` indexed by
`pairId`; `--mood-hue` is set inline as a **bare hue angle** (e.g. `38`), so
step 5's CSS reads it as `hsl(var(--mood-hue) …)`.

### Step 5 — styles (`app.css`)

- `.mood-trigger` / `.mood-verb` background tints derived from `--mood-hue`, gated
  by `[data-highlight-subjunctive='on']`; verb more saturated than trigger.
- Alpha-based tints so one rule set adapts across all 6 themes; then a per-theme
  eyeball pass for legibility (light + dark).
- Verify composition with: `.word-clickable` hover/active, the active-chunk emphasis
  rules (~1249), and `.sentences.lookup-open` dimming (~1554).

**Step 5 as built — two of this section's assumptions were wrong:**

1. **"The active chunk changes *text color* via `data-emphasis`, so a background
   tint composes cleanly."** It does not. `[data-emphasis='color'|'both']` paints
   the whole `.pair-tl` cell with `--highlight-bg` — a yellow band (`#fff59d`
   white, `#ffff00` high-contrast). An alpha tint over yellow loses most of its
   contrast. Mitigated by lifting both alphas and darkening `--mood-light` while
   that band is up — **and by dropping amber from the palette entirely.** At hue
   38 the trigger was invisible on the band and the verb was a faint olive
   smudge, while teal on the same band read cleanly. `MOOD_HUES` is now
   `[190, 280, 340, 150]` (teal, violet, rose, green): no hue near yellow. The
   spec's "e.g. soft amber" was illustrative, and it is the one color this
   feature cannot use.
2. **`.word-clickable`'s hover/active use the `background` SHORTHAND**, which
   resets `background-image`. So the tint is painted as a `background-image`
   (`linear-gradient(var(--mood-tint), var(--mood-tint))`) and the gated rules
   outrank the hover rules — tint survives the tap, hover color shows through
   underneath. Do not "simplify" this to `background-color`; that trades away
   tap feedback on highlighted words.

**Gate is on the NEGATIVE** — `html:not([data-highlight-subjunctive='off'])` —
not `='on'` as this section originally said. Default is ON, and gating this way
means highlights don't flash off on first paint before the settings blob loads,
and step 5 is verifiable before step 6 exists. Step 6 only has to write the
attribute.

**Preview harness:** `mood-preview.html` at the repo root (untracked). Run
`npm run dev` and open `http://localhost:5173/mood-preview.html` — it links the
live `src/app.css`, so edit and refresh with no build step. Renders the real
DOM (`.pair-row.current.tl-active .pair-tl` etc., real `.word-clickable`
buttons) across all four hues, both roles, the emphasis band, past-sentence
dimming and the spec's edge cases, with theme / emphasis / on-off switchers
(keys 1–6 and 0). It duplicates `MOOD_HUES` and the `(pairId - 1) % 4` formula
from `views.tsx` — **change both together or the page lies.** This is what
caught the amber problem; use it for step 7 rather than hunting for a passage
containing the right forms.

Tuning knobs are four inherited vars (`--mood-sat`, `--mood-light`,
`--mood-alpha-trigger`, `--mood-alpha-verb`) with per-theme overrides for
cream/sepia (warm grounds swallow amber), dark (mid tints read as mud), and
high-contrast (soft wash defeats the theme; gets a solid underline on the verb).
Past sentences dim via `color` only, so the tint composes there without help.

### Step 6 — setting + toggle + gate

- **6a** `types.ts` `Settings`: add `readonly highlightSubjunctive: boolean`.
  `core.ts` `defaultSettings()`: `highlightSubjunctive: true`. No `normalizeSettings`
  change (defaults merge on load). No SQL migration (JSONB blob).
- **6b** `app.tsx`: add `set-highlight-subjunctive` action to the `AppAction` union
  (~248) + reducer case (~1041) mirroring `set-emphasis-style` (persists + syncs via
  the existing settings sync); add the `data-highlight-subjunctive` root-attribute
  effect (~1596).
- **6c** `views.tsx` `ThemePickers` (~75): add an Appearance-section checkbox
  dispatching the new action.

**Step 6 as built:** the action is **`toggle-highlight-subjunctive`** (no
payload), not the `set-highlight-subjunctive` this section proposed — every
other boolean setting in the reducer is a payload-free `toggle-*`
(`toggle-english-tts`, `toggle-re-read`, `toggle-read-aloud-on-advance`);
`set-emphasis-style` takes a payload only because emphasis is an enum. The
toggle is a `.toggle-row` checkbox at the end of `ThemePickers`, matching the
other settings toggles rather than sitting alongside the two `<select>`s.

`normalizeSettings` confirmed to need no change: `fetchSettings` returns
`{ ...defaultSettings(), ...normalizeSettings(raw) }`, so a blob without the
key inherits the `true` default. No migration, as predicted.

Verified in the harness: flipping the gate removes every tint with no layout
shift and no effect on the emphasis band.

## Testing notes

- Seed test passages containing: regular -ar and -er/-ir present subjunctive; imperfect subjunctive in both *-ra* and *-se* forms; a perfect subjunctive; a negative imperative; an independent *que* clause; *cuando* + indicative vs. *cuando* + subjunctive; a trigger separated from its verb by an intervening clause.
- Verify word-tap still works on highlighted words on mobile.
- Verify toggle off removes all highlighting without reprocessing.
- Verify old cached chunks (no annotations) render without errors.

## Risks

- **Prompt reliability on two-mood triggers** (*cuando*/*aunque* + indicative vs. subjunctive) — where a cheap model over-tags. Concentrated prompt-iteration cost.
- **Span resolution ambiguity** on repeated words — accepted as dropped annotations in v1.
- **Prompt duplication drift** — touches both `prompt.ts` and the edge-function copy again (the recurring debt CLAUDE.md flags). Optional: add the build-time injection step first if tired of it; not required.

## Out of scope for v1

- Cross-chunk trigger/verb pairing.
- Backfilling annotations onto pre-existing passages (no per-passage reprocess path exists today; would be a small follow-up action that re-runs stored `tlText` through annotation).
- Highlighting other moods/forms (conditional, future subjunctive, etc.).
- Any spaced-repetition or tracking of which highlighted forms were tapped (possible later: feed into the implicit-signals model).
