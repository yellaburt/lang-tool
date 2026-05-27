# Spanish reading app — light mode + book ingestion build plan

## Goal

Add a third reading mode ("light") for chunks where the current scaffolding has
become excessive, plus book-as-collection ingestion that auto-splits a pasted
book into chapter-passages in a folder. Polish mobile UX before handing the app
to a second user (ARD).

The two existing reading modes are preserved as-is:

- **Default (scaffolded):** Spanish audio → Spanish text → English → optional re-read.
- **Listening (over-your-head):** hidden Spanish audio → Spanish text+audio → English → optional re-read.

The new third mode is:

- **Light:** Spanish audio plays once with the text visible, then pause. The
  user taps **Continue**, taps **Show English**, or taps any Spanish word for a
  lookup. Auto-advance fires after a configurable delay if no interaction
  happens. No automatic re-read.

The full architecture and design history is documented in `CLAUDE.md` at the
repo root. Read it first if you're a fresh Claude Code session.

---

## Recommended Claude Code model setup

**Default: Claude Sonnet 4.6** (`claude-sonnet-4-6`). Right balance of capability
and iteration speed for the multi-file feature work in this plan. Per
Anthropic's recent guidance, Sonnet is the recommended starting point for
coding workflows and is the daily-driver default in Claude Code.

**Drop to Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) for the most
mechanical tasks: Task 1's CSS work, Task 4's simple settings field addition,
small UI tweaks. Haiku iterates fast and is plenty capable for well-scoped
single-file work.

**Reach for Claude Opus 4.7** (`claude-opus-4-7`) only when:
- Sonnet gets stuck on the speech-effects refactor in Task 3.
- You want a second opinion on a design decision before committing to it.
- You hit a real debugging puzzle that needs deeper reasoning.

The "over-design is better than under-design" instinct is right for
architecture but inverted for model choice on execution. Opus iteration is slow
enough to actively hurt vibe-coding feedback loops on tasks this well-scoped.
Use `/model` in Claude Code to switch per session.

---

## Build order

Each task is intended as one Claude Code session (an evening's work). The
ordering is deliberate but tasks 5-7 are independent of tasks 1-4 and can
interleave.

1. Mobile word-tap fixes
2. Grammar note feature (on-demand per-chunk grammar explanation)
3. Light reading mode (mode logic + UI + auto-advance timer)
4. Per-user default reading mode (settings + migration)
5. Book ingestion (paste view + heuristic chapter splitter)
6. Folder-as-book rendering (compact display when a folder looks like a book)
7. Next-chapter navigation (continue button at end of chapter)

---

## Task 1: Mobile word-tap fixes

**Goal:** Reduce mis-taps when looking up words on phone, and stop the lookup
panel from pushing the chunk off-screen on small viewports.

**Files:**
- `src/app.css` — line-height for Spanish text, lookup panel positioning
- `src/views.tsx` — `WordLookupPanel`

**Changes:**

1. Increase line-height of Spanish chunk text to ~1.7 (from whatever the
   current value is — grep for the chunk-text class in `app.css`). The English
   line can stay tighter (~1.4) to fit more on screen.

2. Refactor `WordLookupPanel` to render as a pinned bottom sheet on viewports
   below ~640px wide. Desktop keeps the current inline-below-chunk behavior.

   Mobile approach:
   - `position: fixed; left: 0; right: 0; bottom: 0`
   - `padding-bottom: env(safe-area-inset-bottom)` for iOS notch
   - Slide-up animation on mount, slide-down on dismiss
   - Thin handle/grab bar at the top for visual affordance
   - `max-height: 50vh` with internal scroll
   - When the panel is open on mobile, add `padding-bottom: <panelHeight>` to
     the chunk container so the active chunk stays in viewport above it
   - Tapping outside the panel (on the chunk area or a backdrop) dismisses it

3. The × dismiss button needs at least a 44×44px tap target. Use `padding`,
   not just a larger `font-size`.

**Acceptance:**
- On phone (Chrome Android), tapping a Spanish word mid-chunk shows the panel
  without scrolling the chunk off-screen.
- Tapping adjacent words on the same line lands on the correct word reliably
  during a casual reading session.
- Desktop behavior is unchanged.

**Gotchas:**
- Pure CSS + JSX work. Don't touch the `wordLookup` state machine in `app.tsx`.
- The existing `scrollIntoView` call that fires when the panel mounts (grep
  for it in `app.tsx` and `views.tsx`) should be conditioned to desktop only.

---

## Task 2: Grammar note feature

**Goal:** Add an on-demand grammar explanation panel per chunk. The user taps
a **Grammar** button on any chunk; an Edge Function asks Haiku to explain
notable grammatical features (verb forms, mood, clause structure, idiomatic
constructions) for an intermediate Spanish learner. Cache server-side keyed on
the chunk text so re-taps are instant and free. Log per-user requests for
future analysis.

This addresses a gap the existing tooling misses: the word lookup tells you
what *fuera* means and that it's past subjunctive, but it doesn't tell you why
the sentence is using past subjunctive, what the construction is doing
semantically, or that the English gloss is smoothing over a counterfactual
nuance. The grammar feature catches that class of comprehension gap — where
the meaning lands but the form's contribution to meaning doesn't.

**Files:**
- `supabase/functions/explain-grammar/index.ts` — new Edge Function
- `supabase/migrations/<timestamp>_grammar_explanations.sql` — new cache table + per-user history table
- `src/types.ts` — `GrammarExplanation` type, optional state field on chunk
- `src/supabase.ts` — `callExplainGrammar` wrapper
- `src/app.tsx` — reducer actions, fetch effect (modeled on word lookup)
- `src/views.tsx` — `GrammarPanel` component, Grammar button on each chunk
- `src/app.css` — panel + button styles

**Changes:**

1. **Edge Function `explain-grammar`:** Model closely on `define-word`.
   - Input: `{ spanishText, englishGloss, userId, chunkId }`
   - Check `grammar_explanations` cache table keyed on
     `(spanish_text, english_gloss, language)`. On hit, return cached payload.
   - On miss, call Haiku 4.5 with tool-use. Tool schema:
     ```ts
     {
       isUnremarkable: boolean,    // true if the sentence has no
                                   // grammatical features worth flagging
       summary: string,            // 1-2 sentences for an intermediate
                                   // learner. Empty string if isUnremarkable.
       notes: [{ topic: string, explanation: string }]
                                   // 0-4 specific points. Common topics:
                                   // "Past subjunctive (-ara/-iera)",
                                   // "Reflexive se", "Preterite vs imperfect",
                                   // "Si clause structure", etc.
     }
     ```
   - System prompt: instruct Haiku to focus on features that an intermediate
     Spanish learner reading Vonnegut-level prose would benefit from. Skip
     basic features (regular present tense, common cognates). Flag the
     interesting stuff: subjunctive moods, irregular preterites, *se*
     passives/impersonals, clitic pronoun placement, idiomatic
     constructions, false friends, register-marked vocabulary.
     If the sentence is grammatically routine, set `isUnremarkable: true`
     and return empty summary/notes.
   - Cache the result.
   - Insert a row into `grammar_explanation_events` (per-user history,
     same pattern as `word_lookup_events`).
   - Return the explanation to the client.
   - Same Haiku timeout + diagnostic + error handling pattern as
     `define-word`. No Sonnet fallback needed (this is a single-sentence
     task, well within Haiku's range).

2. **Migration:** Two tables.
   - `grammar_explanations` (cache): `id`, `spanish_text`, `english_gloss`,
     `language`, `payload jsonb`, `created_at`. Unique index on the
     (spanish_text, english_gloss, language) triple.
   - `grammar_explanation_events` (per-user history): `id`, `user_id`,
     `chunk_id` (nullable; chunks can be deleted but events stay), `payload jsonb`, `created_at`.
     RLS: users can only read their own rows.

3. **Reducer actions:**
   - `RequestGrammar { chunkId }` — sets `grammarPanel` state to
     `{ kind: 'loading', chunkId }`. Pauses audio.
   - `ReceiveGrammar { explanation }` — transitions to `{ kind: 'ready', ... }`.
   - `DismissGrammar` — clears the panel. Does not auto-resume audio.

4. **Fetch effect:** Mirrors the word-lookup fetch effect. Watches for
   `grammarPanel.kind === 'loading'`, calls `callExplainGrammar` with the
   chunk text + English gloss, dispatches `ReceiveGrammar` with the result.

5. **UI:**
   - A small **Gr** or **¶** icon button at the end of each rendered chunk,
     near the word-lookup affordance. Visible in all three reading modes.
   - On tap, pause audio (existing pause action), then show the panel below
     the chunk. Same positioning rules as the word lookup panel — pinned
     bottom sheet on mobile, inline-below on desktop.
   - Panel content: `summary` rendered as prose, `notes` rendered as a
     list of (bold topic) + explanation pairs. If `isUnremarkable === true`,
     show "Nothing notable in this sentence" as a one-line message.
   - × dismiss button. Tapping ▶ Resume dismisses AND continues reading
     (same as word lookup).

**Acceptance:**
- Tap Grammar on a chunk containing *fuera* in a counterfactual *si* clause →
  panel explains past subjunctive + si-clause counterfactual.
- Tap Grammar on a chunk that's just "Mary fue al mercado" → panel says
  nothing notable.
- Re-tap on the same chunk → instant (cache hit).
- `grammar_explanation_events` shows your taps in the database after a few
  reading sessions.

**Gotchas:**
- The cache key includes English gloss, not just Spanish, because the same
  Spanish sentence with different glosses might warrant slightly different
  explanations. Cache hit rate will be near-perfect within a single passage
  but cross-passage hits will be rare. That's fine — Haiku is cheap.
- The Grammar button is small but distinct from the word-tap area. On
  mobile, give it a clearly separated tap zone (margin or a different
  visual treatment) so users don't accidentally hit it while tapping words.
- The prompt should explicitly say "skip basic features" — without that
  instruction, Haiku tends to over-explain easy sentences with comments
  about "this is a regular -ar verb in the present tense" which is noise.
- Estimate: 4-6 hours. Mostly mirrors `define-word`, so the unknowns are in
  the prompt tuning (1-2 iterations to get the right level of detail) and
  the panel styling.

---

## Task 3: Light reading mode

**Goal:** Add the third reading mode with button-gated English reveal and an
auto-advance timer.

**Files:**
- `src/types.ts` — extend mode type
- `src/core.ts` — default settings update
- `src/app.tsx` — reducer actions, speech effects
- `src/views.tsx` — `ReadingView` UI, `SettingsModal` mode picker
- `src/app.css` — button styles, progress bar
- `supabase/migrations/<timestamp>_reading_mode.sql` — add new settings columns

**Changes:**

1. **Type:** Replace the existing implicit listening-mode toggle with:
   ```ts
   type ReadingMode = 'scaffolded' | 'listening' | 'light';
   ```
   In `UserSettings`, add `readingMode: ReadingMode` and
   `autoAdvanceDelaySec: number` (allowed: 3 | 5 | 8 | 12 | 0 where 0 means
   never; default 5).

2. **Migration:** Add `reading_mode TEXT NOT NULL DEFAULT 'scaffolded'` and
   `auto_advance_delay_sec INTEGER NOT NULL DEFAULT 5` to `user_settings`.
   Backfill: if a previous `listening_mode` boolean column existed, migrate
   `true → 'listening'`, `false → 'scaffolded'`, then drop the old column in a
   follow-up migration once both users have logged in fresh.

3. **Reducer actions:** Add (or rename, depending on what exists):
   - `RevealEnglish` — sets a per-chunk flag in state showing English text
     plus, if English-aloud is enabled, plays English audio.
   - `Continue` — advances to the next chunk; also cancels any auto-advance
     timer.
   - `CancelAutoAdvance` — fires when a word lookup begins or the user pauses.

4. **Speech effects in light mode:** Rewrite the chunk flow so that when
   `readingMode === 'light'`:
   - Spanish audio plays once with text visible. No automatic transition to
     English.
   - When Spanish audio completes, the auto-advance timer starts.
   - Tapping a word → cancels the timer, opens lookup. Closing lookup does NOT
     auto-resume the timer; the user must tap Continue or Show English.
   - Tapping Show English → reveals English text (existing display logic,
     newly gated on user action) and optionally plays English audio. When
     English audio completes (or immediately if English-aloud is off), the
     timer restarts.
   - Tapping Continue → advance.
   - No re-read phase.

5. **UI in `ReadingView`:**
   - Two-button bar below the active chunk in light mode, after Spanish audio
     finishes. Buttons: **Show English** (left), **Continue** (right). At
     least 48dp tall.
   - Position: `position: sticky; bottom: 80px` on mobile (clear of Chrome
     chrome), `position: static` on desktop.
   - A thin progress bar across the bottom of the chunk that visually counts
     down the auto-advance timer (width animates from 100% → 0%). Tapping
     anywhere on the chunk cancels it.
   - Keyboard: Space = Continue, E = Show English. The existing
     Space-as-pause should be preserved while audio is actively playing;
     Space-as-continue only fires in the "awaiting input" state.

6. **Settings modal:** Replace the listening-mode checkbox with a mode picker
   (radio buttons or a segmented control):
   - Scaffolded (default)
   - Listening (audio-first)
   - Light (minimal scaffolding)

   Plus an auto-advance-delay select (3s / 5s / 8s / 12s / Never), visible
   only when mode is Light.

**Acceptance:**
- Toggling between the three modes mid-passage works without crashes.
- In light mode, finishing a chunk's Spanish audio brings up the two-button
  bar with a visible countdown.
- Auto-advance fires after the configured delay if no interaction.
- Tapping a word cancels the timer cleanly.
- Tapping Show English reveals the English (and plays English audio if
  English-aloud is on), then restarts the timer.
- Keyboard shortcuts work on desktop.

**Gotchas:**
- The speech effects are interconnected via "done" flags. Don't try to share
  one effect tree across all three modes; branch early on `readingMode` and
  keep separate effect trees per mode. Cleaner to reason about, easier to
  debug.
- The auto-advance timer should use a `useRef` for the timeout ID and clear
  it on unmount and on any user action.
- Decide explicitly what happens when the user toggles modes mid-chunk: the
  simplest answer is to restart the current chunk under the new mode.

---

## Task 4: Per-user default reading mode

**Goal:** DPD and ARD have different default modes on sign-in (DPD: light,
ARD: scaffolded). Both can still toggle per session.

**Files:**
- `src/types.ts`
- `src/supabase.ts` — settings load/save
- `src/app.tsx` — apply default on login
- `src/views.tsx` — settings modal
- `supabase/migrations/<timestamp>_default_reading_mode.sql`

**Changes:**

1. **Migration:** Add `default_reading_mode TEXT NOT NULL DEFAULT 'scaffolded'`
   to `user_settings`.

2. On login, after `user_settings` loads, seed the in-memory `readingMode`
   from `defaultReadingMode`. Per-session changes stay in memory; the default
   only applies on a fresh login.

3. **Settings modal:** Add a "Default on sign-in" picker that's visually
   distinct from the current-session mode picker. Same three options.

**Acceptance:**
- ARD signs in → defaults to scaffolded.
- DPD signs in (after setting the default) → defaults to light.
- Changing the session mode does NOT change the default; changing the default
  does NOT change the current session.

---

## Task 5: Book ingestion

**Goal:** Pasting a long text (Mother Night, a Vonnegut anthology, a
Project Gutenberg classic) and choosing **Add as book** creates a folder
named after the book, splits it into chapter passages, and starts background
processing.

**Files:**
- `src/core.ts` — chapter-splitting function
- `src/types.ts` — `ChapterSplit` type
- `src/views.tsx` — `PasteView` with new option
- `src/app.tsx` — reducer action to ingest a book

**Changes:**

1. **Splitter in core.ts:**
   ```ts
   type ChapterSplit = { title: string; content: string };
   function splitBookIntoChapters(
     text: string,
     opts?: { targetWordsPerSection?: number }
   ): ChapterSplit[]
   ```
   Strategy:
   - Try chapter-header heuristics. Patterns matched on their own line
     (case-insensitive, optional surrounding whitespace):
     - `Chapter <number-or-roman>[: title]?`
     - `Capítulo <number-or-roman>[: title]?`
     - Standalone roman numeral on a line (catches Vonnegut-style headers)
     - `<arabic-number>\. <title>` at start of line, when followed by
       non-trivial content
   - If 3 or more chapter headers are found, split there. Use the matched
     header line as the chapter title.
   - If fewer than 3 are found, fall back to length-based splitting at
     sentence boundaries (use existing `splitSentences`) into sections of
     ~2000 words each. Title sections "Part 1", "Part 2", ...

2. **PasteView:**
   - When pasted text exceeds ~5000 words, show a third button alongside
     Save and Start reading: **Add as book**.
   - Tapping it: run `splitBookIntoChapters`, show a confirmation modal:
     "Detected N chapters. Save as a book?" with an editable book-title
     field defaulted to a guess (first non-empty line, truncated to 50 chars).

3. **Reducer action `AddBook`:**
   - Creates a folder with the book title.
   - For each `ChapterSplit`, creates a passage with:
     - `folder = bookTitle`
     - `title = chapter.title`
     - `sourceText = chapter.content`
     - `chunks = []`
     - `processingStatus.kind = 'in-progress'`
   - Batch-insert all passages into Supabase if possible.

4. **Navigation:** After AddBook, return to the library and scroll to the
   new book's folder. Don't auto-open any chapter.

**Acceptance:**
- Paste Mother Night → **Add as book** appears → confirm → folder with the
  full chapter list appears → processing kicks off → first chapters become
  readable within ~1 minute.
- Paste a random news article (too short) → no **Add as book** button.
- Paste a long essay without chapter markers → **Add as book** → splits into
  "Part 1", "Part 2", ... by length.

**Gotchas:**
- Spawning 40 simultaneous background batch-fetches will hammer the
  chunk-and-gloss Edge Function and may hit Anthropic rate limits. The
  batch-fetch effect should serialize or cap concurrency to 2-3 passages at
  a time. Check `app.tsx`'s batch-fetch effect; if it doesn't already do
  this, add a `processingPassageId` lock.
- Title auto-suggest already fires on every untitled passage. With 40 new
  passages, that's 40 parallel `suggest-title` calls. Add a small jitter
  (random delay 0-2s) to spread them out, or rate-limit client-side. (Note:
  if chapters already have titles from the splitter, suggest-title should
  skip them entirely.)
- Test against at least two books: Mother Night (Arabic chapter numbers)
  and one with Roman numerals or word-based chapter headers, before calling
  this done.

---

## Task 6: Folder-as-book rendering

**Goal:** When a folder contains many sequentially-numbered passages, render
it compactly so the library doesn't become a 40-row wall.

**Files:**
- `src/core.ts` — `isBookLikeFolder` predicate
- `src/views.tsx` — `FolderGroup`
- `src/app.css` — compact row styles

**Changes:**

1. **Predicate in core.ts:**
   ```ts
   function isBookLikeFolder(passages: Passage[]): boolean
   ```
   Returns true if:
   - `passages.length >= 5`, AND
   - At least 70% of titles match `/^(chapter|capítulo|part)\s+\d+/i` or
     `/^\d+[.:]\s/`.

   This avoids false positives on a "News" folder where everyone happens to
   be titled "Article 1", "Article 2", etc.

2. **FolderGroup branch:**
   - If `isBookLikeFolder` is false, render the existing way.
   - If true, render a single book card on the library root showing:
     - Book title (folder name)
     - Aggregate progress: "Chapter X of N, M% complete" where X is the
       last opened chapter, M is averaged from
       `lastReadChunkIndex / chunks.length` per chapter
   - Tapping the card drills into a chapter list view: one compact row per
     chapter showing title, % read, last-opened date, and the open action.
   - No per-row rename / move / delete in compact view; tap a small "..."
     kebab to reach the existing action menu.

3. **CSS:** Compact rows ~40-48px tall (vs the current ~80px), smaller text,
   no large action buttons. Still tappable on mobile.

**Acceptance:**
- Mother Night folder shows as a single book card on the library root.
- Tapping it shows the chapter list.
- Generic folders (a few random articles) still render the old way.

**Gotchas:**
- Pure render change; no data model change. Be careful not to break the
  existing folder rename / remove flows — they should still work, just be
  reached via the kebab in the chapter list view.

---

## Task 7: Next-chapter navigation

**Goal:** When you finish reading a passage in a book-like folder, show a
"Continue to next chapter →" button.

**Files:**
- `src/views.tsx` — end-of-passage UI in `ReadingView`
- `src/core.ts` — helper to find the next passage in a book

**Changes:**

1. **Helper in core.ts:**
   ```ts
   function findNextChapter(
     passages: Passage[],
     currentPassageId: PassageId
   ): Passage | null
   ```
   Filter to passages in the same folder, sort by detected chapter number
   (parse the title; reuse Task 5's regex), fall back to creation order,
   return the one immediately after current. Null if current is last.

2. **ReadingView:** When `lastReadChunkIndex` reaches `chunks.length - 1`
   AND the folder is book-like, render a "Continue to next chapter:
   <title> →" button below the final chunk. Tap → loads the next chapter
   into reading view from chunk 0.

3. Keep the existing back-to-library button next to the continue button.

**Acceptance:**
- Finish chapter 1 of Mother Night → "Continue to Chapter 2 →" appears.
- Tap it → reading view loads chapter 2 from chunk 0.
- Finish the last chapter → no continue button; back-to-library only.

**Gotchas:**
- Chapter-number parsing needs to handle Arabic, Roman, and "Part N" formats.
  Reuse the regex from Task 5.
- Only show this for book-like folders. Auto-advancing from "Article 1" to
  "Article 2" in a generic folder would be surprising.

---

## What's deliberately out of scope

Resist scope creep. These are real ideas, just not for this plan:

- **Adaptive per-chunk scaffolding** based on new-word density. Ship the
  three-mode toggle first; gather usage data before automating per-chunk
  mode selection.
- **Lookup history review screen / SRS.** Worth doing, but after Adryane has
  used the app for a few weeks so you have real data.
- **EPUB / PDF book input.** Plain-text paste covers Mother Night and most
  Project Gutenberg classics. EPUB parsing is its own can of worms.
- **Lemma-based personal vocab tracking.** Exact-string lookup history is
  enough until proven otherwise.
- **Speech production / shadowing.** Separate project; italki is the right
  tool for production practice.
- **Multi-select / drag-drop for moving passages.** Real UX gap (noted in
  `CLAUDE.md`) but unrelated to this plan.
- **Refused-batch retry button.** Worthwhile but orthogonal.
- **System-prompt-duplication cleanup.** Engineering debt; fix when there's
  time.

---

## After this ships

Once the six tasks land and you've used the app for a week or two:

- Watch which mode you each settle into.
- Check whether the auto-advance default (5s) feels right or needs tuning.
- See whether ARD uses book ingestion or stays on shorter articles.
- Decide whether adaptive per-chunk scaffolding is worth building or whether
  the three-mode toggle is sufficient.
- Open the lookup-history review screen as the next major feature if you and
  ARD start asking for it.
