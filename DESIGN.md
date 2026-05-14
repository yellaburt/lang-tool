# lang-tool — Design Document (built state)

Snapshot of what the program actually does and how it does it, as of May 2026.
Companion to the original aspirational design doc; this one documents the part
that's actually working.

---

## 1. What it does (user-facing summary)

A personal Spanish reading-and-listening tool. You paste a passage (in
Spanish or English), and the tool:

- splits it into bite-sized chunks at natural clause boundaries
- speaks each chunk aloud (Spanish), shows the chunk on screen
- reveals an English gloss aligned to that chunk
- optionally speaks the English aloud
- optionally re-reads the Spanish in a contrasting voice for ear training
- moves to the next chunk on a configurable timer, or under user control

Passages are saved between sessions. Resume where you left off. Six color
themes, four emphasis styles, and per-pace controls let the experience tune
to your preferences. All speech is local (Web Speech API). Translation and
chunking are done by Claude (Anthropic API) and cached per-passage.

### Who it's for

Right now, just Pete. Architecturally ready for Adryane and Ben as additional
users, but the SRS / Anki / italki-bridge features outlined in the original
doc are not yet built.

---

## 2. Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`) |
| UI framework | React 19 (functional components, hooks, no class components) |
| Build / dev | Vite 8 + `@vitejs/plugin-react` |
| Testing | Vitest 4 (47 tests passing) |
| LLM | Anthropic SDK (`@anthropic-ai/sdk`), Haiku model with prompt caching |
| Speech | Web Speech API (`speechSynthesis`, browser-native) |
| Persistence | `localStorage`, schema-versioned blob |
| Module count | 7 source files + 2 test files + entry/config |

No bundler complexity, no backend, no database. Single-user, single-machine,
runs entirely in the browser against locally stored state plus the Anthropic
API.

---

## 3. File structure

```
src/
  types.ts         (132 lines)  Domain types — Passage, Chunk, Settings, etc.
  core.ts          (397 lines)  Pure logic — chunking, SRS, grading, reducers
  core.test.ts     (471 lines)  40 tests covering core
  llm.ts           (228 lines)  Anthropic API client + per-passage cache
  storage.ts       (117 lines)  Schema-versioned localStorage persistence
  storage.test.ts  (132 lines)  7 tests covering save/load round-trip
  app.tsx          (~470 lines) State machine — AppState, reducer, App component
  views.tsx        (~970 lines) View components + TTS shell-layer helpers
  main.tsx         (13 lines)   React entry point
  app.css          (~370 lines) Theme variables + UI styles
  vite-env.d.ts                 Vite env type declarations
```

Plus `index.html`, `vite.config.ts`, `tsconfig.json`, `package.json`, and
`.env.local` (containing the user's Anthropic API key, gitignored).

---

## 4. Architectural principles

These constraints were specified by Ben and informed every design choice:

- **Functional core, imperative shell.** `core.ts` is pure — no I/O, no
  React, no global state. `app.tsx`/`views.tsx` carry the imperative parts
  (effects, dispatch, DOM, audio).
- **Strong typing.** `strict` mode, plus `noUncheckedIndexedAccess` (so
  `arr[i]` returns `T | undefined`) and `exactOptionalPropertyTypes`.
- **Immutability.** Every interface field is `readonly`; every array is
  `ReadonlyArray<T>`; every record is `Readonly<Record<K, V>>`. State updates
  produce new state via reducers.
- **Discriminated unions** for variants (View, AppAction, ProcessingStatus,
  VocabItem.kind, Question.kind, ReviewOutcome). Switch statements with
  `assertNever` for compile-time exhaustiveness checking.
- **Branded ID types.** `PassageId`, `ChunkId`, `VocabItemId`, etc. are
  `string & { __brand: 'PassageId' }`. Zero runtime cost; catches a class of
  bugs at compile time.
- **Few modules.** Three files (types/core/views/app) cover the bulk of the
  app, with `storage.ts` and `llm.ts` extracted because they're cohesive
  side-effect concerns. No premature splitting.

---

## 5. Data model

### Top-level: `LearnerState`

The persisted source of truth.

```typescript
interface LearnerState {
  readonly passages: Readonly<Record<PassageId, Passage>>;
  readonly vocabItems: Readonly<Record<VocabItemId, VocabItem>>;
  readonly srs: Readonly<Record<VocabItemId, SrsState>>;
  readonly reviews: ReadonlyArray<ReviewEvent>;
  readonly sessions: ReadonlyArray<Session>;
  readonly settings: Settings;
}
```

`vocabItems`, `srs`, `reviews`, `sessions` are present in the schema but not
populated by current code — they're reserved for the SRS work in the original
doc.

### `Passage`

```typescript
interface Passage {
  readonly id: PassageId;
  readonly title: string;
  readonly language: LanguageCode;     // currently always 'es'
  readonly rawText: string;            // original pasted text
  readonly chunks: ReadonlyArray<Chunk>;
  readonly createdAt: number;
  readonly lastOpenedAt: number;       // for library sort order
  readonly lastReadChunkIndex: number; // resume point — single source of truth
  readonly processingStatus: ProcessingStatus;
}
```

`lastReadChunkIndex` lives on the passage (not on transient UI state), so the
reading position persists across sessions automatically.

### `Chunk`

```typescript
interface Chunk {
  readonly id: ChunkId;
  readonly passageId: PassageId;
  readonly index: number;          // absolute position in passage
  readonly sentenceIndex: number;  // sub-chunks of one sentence share this
  readonly tlText: string;         // Spanish
  readonly englishGloss: string | null;
  readonly audioRef: string | null;  // reserved for cached TTS audio
}
```

`sentenceIndex` is what powers the "sub-chunks of one sentence display as one
growing sentence" UI behavior — and the per-sentence voice alternation
feature.

### `ProcessingStatus` (discriminated union)

```typescript
type ProcessingStatus =
  | { readonly kind: 'in-progress'; readonly processedChunkCount: number }
  | { readonly kind: 'complete' }
  | { readonly kind: 'error'; readonly message: string };
```

Always `'complete'` in current code (whole-passage processing). The
`'in-progress'` variant is reserved for the incremental-processing work
(Session B from the build plan).

### `Settings`

User preferences. All persisted via the storage layer.

```typescript
interface Settings {
  readonly dialect: 'es-MX' | 'es-ES' | 'es-neutral';
  readonly questionFrequency: number;       // reserved for question interleaving
  readonly revealMode: RevealMode;          // reserved
  readonly ttsVoice: string | null;         // primary Spanish voice name
  readonly englishTtsVoice: string | null;
  readonly ttsEnabled: boolean;
  readonly speechPaceMultiplier: number;
  readonly readPaceMultiplier: number;
  readonly englishTtsEnabled: boolean;
  readonly englishSpeechPaceMultiplier: number;
  readonly reReadEnabled: boolean;
  readonly reReadVoice: string | null;
  readonly reReadPaceMultiplier: number;
  readonly reReadAlternates: boolean;
  readonly theme: ThemeName;
  readonly emphasisStyle: EmphasisStyle;
}
```

---

## 6. UI state — `UiState` and `AppState`

`AppState = { learner: LearnerState; ui: UiState }`. The learner part
persists; the UI part is per-session.

```typescript
interface UiState {
  readonly view: 'library' | 'paste' | 'processing' | 'reading';
  readonly draftText: string;
  readonly currentPassageId: PassageId | null;
  readonly spanishTtsDone: boolean;
  readonly englishTtsDone: boolean;
  readonly reReadDone: boolean;
  readonly isPaused: boolean;
  readonly processingError: string | null;
  readonly settingsOpen: boolean;
}
```

Notice what's *not* here: `currentChunkIndex`. That lives on the open passage
(`passage.lastReadChunkIndex`) so it persists.

---

## 7. Action set — `AppAction`

All state mutations go through one reducer with an exhaustive switch over a
discriminated union. Current actions:

**Navigation**
- `set-draft` — typing in the paste box
- `request-process` — starts the LLM pipeline
- `passage-ready` — LLM returned chunks, transition to reading
- `processing-failed` — LLM call errored
- `cancel-processing` — bail out of processing
- `open-passage` — click a passage in the library
- `delete-passage` — remove from library (with browser confirm)
- `go-to-library` — back to library
- `reset-to-paste` — clear draft and go to paste view
- `toggle-settings` — open/close settings modal

**Playback**
- `spanish-tts-finished`, `english-tts-finished`, `re-read-tts-finished` —
  dispatched by speech `onend` handlers
- `advance`, `go-back`, `jump-to-start`, `replay-current` — chunk navigation
- `toggle-pause` — first press freezes the auto-flow at the current chunk;
  second press advances to the next chunk and resumes auto-flow

**Settings**
- `set-speech-pace`, `set-read-pace`, `set-english-speech-pace`,
  `set-re-read-pace` — pace sliders
- `toggle-english-tts`, `toggle-re-read`, `toggle-re-read-alternates`
- `set-tts-voice`, `set-english-tts-voice`, `set-re-read-voice`
- `set-theme`, `set-emphasis-style`

Every chunk-transition action resets the three speech-done flags
(`spanishTtsDone`, `englishTtsDone`, `reReadDone`) so the next chunk's speech
plays fresh.

---

## 8. The reading view's playback state machine

This is the most subtle part of the program. Per chunk, three sequential
speech phases are coordinated by three separate `useEffect` blocks, each
guarded by the previous phase's done-flag:

```
                  ┌── Spanish TTS ──┐
                  │                  │
[chunk current] ──┤  (always plays)  ├──→ spanishTtsDone = true
                  └──────────────────┘
                            │
                            ↓
                  ┌── English TTS ───┐
                  │  (if enabled)    │
                  │  primary→en→pri  │
                  │   crossfade      ├──→ englishTtsDone = true (or skipped)
                  └──────────────────┘
                            │
                            ↓
                  ┌── Re-read TTS ───┐
                  │  (if enabled)    │
                  │  back to Spanish ├──→ reReadDone = true (or skipped)
                  │     voice        │
                  └──────────────────┘
                            │
                            ↓
                  ┌── Hold + fade ───┐
                  │  Holds for       │
                  │  reading-pace ×  │
                  │  word-count.     │
                  │  Fades emphasis  │
                  │  over last       │
                  │  1/3 (max 500ms) │
                  │  before advance. │
                  └──────────────────┘
                            │
                            ↓
                       dispatch advance
                            │
                            ↓
                   [chunk = N+1, all flags reset]
```

### Visual emphasis follows the audio

The active row's emphasized cell (color/bold/both per Emphasis setting) flips
between Spanish and English to match what's playing:

- Spanish TTS playing → Spanish cell highlighted (`tl-active`)
- English TTS playing → English cell highlighted (`en-active`)
- Re-read playing → back to Spanish cell (`tl-active`)
- After all speech done → stays on Spanish cell if re-read enabled, so the
  next chunk's Spanish cell continues the column (eye moves straight down);
  otherwise stays on English

200ms crossfade between cells; up to 500ms fade-out before chunk advance.

### Speech cancellation

`speakChunk` is the shell-layer wrapper around `speechSynthesis.speak()`. Each
call captures two closure-local flags:

- `cancelled` — flipped to `true` by the returned cleanup function (called
  when React tears down the effect)
- `ended` — flipped to `true` synchronously inside the utterance's
  `onend`/`onerror` handler

The cleanup checks `ended` before calling `speechSynthesis.cancel()` — only
cancels speech that's still in flight. This avoids a Chrome quirk where
calling `cancel()` on an idle synth leaves it in a state where subsequent
`speak()` calls silently fail.

The `cancelled` flag prevents the `onerror` event (fired by Chrome on
cancellation) from being treated as a natural completion and dispatching a
stale `tts-finished` action.

### Pause semantics

- **Press space** during any speech phase → `isPaused = true` → all three
  speech effects re-run with `if (isPaused) return;` → cleanup cancels the
  in-flight utterance → speech stops immediately
- **Press space again** → reducer advances to the next chunk and clears
  `isPaused` in one batched state update → effects re-run with the next
  chunk's reset flags → next chunk's speech starts fresh
- **Opening settings** is treated the same as pausing (settings-modal mount
  cancels speech; closing it restarts the current chunk's audio)

### Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Pause (first press) → advance (second press) |
| → | Skip to next chunk immediately |
| ← | Back to previous chunk |
| Home | Jump to start of passage |
| R | Replay current chunk |

---

## 9. The processing pipeline (incremental / lazy)

A passage is processed **batch by batch**, not all at once. Each batch is a
small group of sentences (currently 4) sent to Claude. The first batch fetches
upfront so reading can start quickly; subsequent batches stream in while the
user reads.

```
User pastes text
       │
       ↓
[paste view]  ───[click Start]───→  buildEmptyPassage(rawText)
                                            │
                                            ↓
                                splitSentences (local regex; instant)
                                            │
                                    Passage created with:
                                      - rawText
                                      - chunks: []
                                      - sentenceCount: N
                                      - processingStatus: in-progress(0)
                                            │
                                            ↓
                                dispatch start-passage
                                            │
                                            ↓
                                [processing view]
                                            │
                                            ↓
                                Batch-fetch effect fires
                                            │
                                            ↓
                            splitAndGloss(batchText) ─── llm.ts
                                            │       (sentences 0..3 of N)
                                            │
                                            ├── localStorage cache hit?  → use cached chunks
                                            ├── No API key?              → regex-stub fallback
                                            └── Otherwise → Anthropic API call (Haiku, tool-use)
                                                            │
                                                            ↓
                                dispatch append-chunks (with chunks + sentence count)
                                            │
                                            ↓
                                Reducer: append chunks; status → in-progress(K) or complete;
                                         if first batch landed, view → reading
                                            │
                                            ↓
                                    [reading view]
                                            │
                                            │ (user reads through chunks)
                                            │
                                            ↓
                                When user is within PREFETCH_LEAD_CHUNKS (=3)
                                of the end of processed chunks, AND there's
                                more to process, AND no fetch in flight…
                                            │
                                            ↓
                                Batch-fetch effect fires again
                                  → splitAndGloss(next batchText)
                                  → dispatch append-chunks
                                  → ...repeats until status === complete
```

### Why incremental

- **Long articles work.** The original single-shot model hit the 4096-token
  output limit on long articles (~1800+ words) and failed catastrophically.
  Each batch's output is small and well under any limit.
- **Fast start.** First batch (4 sentences) takes ~1-3 seconds. User starts
  reading immediately while subsequent batches stream in.
- **Cost-aware quitting.** If the user bails after reading 5 chunks of a
  long article, they paid for the batches that produced those 5 chunks —
  not the whole article.
- **Cross-session resume.** Partial passages persist via the storage layer.
  Open a half-processed passage from the library; the batch-fetch effect
  picks up where it left off automatically.

### One in-flight fetch at a time

`UiState.activeBatchFetch: PassageId | null` ensures only one batch fetch
runs at any moment. The batch-fetch effect checks this and bails if a fetch
is in progress; it re-runs when the fetch completes (because completion
clears `activeBatchFetch`).

This deliberately doesn't try to parallelize. Spurious cancellation is a
bigger risk than throughput at this scale.

### Sentence-index offset across batches

The LLM is given each batch as a standalone passage, so it returns
`sentenceIndex` values starting at 0 within that batch. The batch-fetch
effect adds a `sentenceOffset` (= already-processed sentence count) before
appending, so the global sentence indexing remains consistent across batches.

### Language handling (unchanged from earlier)

The LLM prompt detects input language. If input is Spanish, chunks contain
the source Spanish as `tlText`. If input is English, the LLM translates to
Mexican Spanish for `tlText` and uses **the original English** (aligned to
each Spanish chunk) for `englishGloss`.

### Caching (unchanged)

- **Prompt caching** at the Anthropic API. The system prompt is marked
  `cache_control: { type: 'ephemeral' }`, so re-requests within ~5 minutes
  pay only the cache-hit rate (~10% of input cost).
- **Result caching** in localStorage. Key is `SHA-256(batchText + model +
  promptVersion)`. Re-pasting the exact same passage hits the cache for
  every batch — zero new API cost.

### Language handling

The LLM prompt detects input language. If input is Spanish, chunks contain
the source Spanish as `tlText`. If input is English, the LLM translates to
Mexican Spanish for `tlText` and uses **the original English** (aligned to
each Spanish chunk) for `englishGloss` — preserving the user's source wording
rather than back-translating.

### Caching

Two levels of caching are active:

- **Prompt caching** at the Anthropic API. The system prompt is marked
  `cache_control: { type: 'ephemeral' }`, so re-requests within ~5 minutes
  pay only the cache-hit rate (~10% of input cost).
- **Result caching** in localStorage. Key is `SHA-256(passage + model +
  promptVersion)`. Re-pasting the exact same passage = zero API cost. Changes
  to the prompt bump `PROMPT_VERSION` (currently `v3`), invalidating old
  cache entries.

The LLM prompt currently includes a one-shot example for each direction
(Spanish input and English input) plus a hard constraint that no chunk
exceed 15 words.

---

## 10. Storage layer

`storage.ts` reads/writes a single localStorage key — `lang-tool:learner-state` — 
containing a schema-versioned blob:

```typescript
interface StorageBlob {
  readonly schemaVersion: 1;
  readonly learnerState: LearnerState;
}
```

### Load (`loadLearnerState`)

- Returns `emptyLearnerState()` on missing key, parse error, or unknown
  schema version
- Normalizes loaded `LearnerState` — fills in missing fields from
  `defaultSettings()` so older shapes still load
- Never throws

### Save (`scheduleSaveLearnerState`)

- Debounced (1 second). Multiple rapid state changes (e.g., advancing
  through chunks) collapse to a single write.
- Stale-time tradeoff: at most 1 second of state changes can be lost on
  abrupt close. Acceptable for our use case.
- Quota and `localStorage`-disabled errors swallowed; the in-memory state
  remains correct.

### Save trigger

A single `useEffect` in the App component:

```typescript
useEffect(() => {
  scheduleSaveLearnerState(state.learner);
}, [state.learner]);
```

Triggers on every `state.learner` change. UI state (`view`, `draftText`,
`isPaused`, etc.) is intentionally not persisted — it's transient.

### Schema migrations

`schemaVersion` is on the wire. To change the shape:

1. Bump the constant `CURRENT_SCHEMA` in `storage.ts`
2. Add a migration step in `loadLearnerState` that handles the older version
3. (Or: leave version 1, ensure field additions are backward-compatible by
   filling defaults — this is what `normalizeLearnerState` already does for
   missing fields)

---

## 11. Theming

Six themes (White, Cream, Sepia, Light Gray, Dark, High Contrast) defined as
CSS-variable overrides on `[data-theme="..."]` selectors. Variables include
`--bg`, `--text-primary`, `--text-secondary`, `--highlight-bg`,
`--surface-border`, `--button-bg`, etc. All theme-aware UI references these
variables, never hex literals.

The active theme is applied by a `useEffect` in App that sets
`document.documentElement.dataset.theme = settings.theme`. Same pattern for
`data-emphasis` (color / bold / both / none).

Adding a new theme: one `[data-theme='new-theme'] { ... }` block in
`app.css` plus an option in `THEME_OPTIONS`. No per-component changes needed.

---

## 12. Pedagogical features

What the current build supports from the original doc's intent:

| Feature | Status |
|---|---|
| Chunked TL → English reveal | ✅ Built |
| Cumulative reveal (sentence-grouped) | ✅ Built |
| TTS Spanish (any installed voice) | ✅ Built |
| TTS English (optional) | ✅ Built |
| Spanish re-read with separate voice | ✅ Built |
| Voice alternation (per sentence) | ✅ Built |
| Pace controls (independent for speech/reading/English/re-read) | ✅ Built |
| Theme + emphasis style (orthogonal) | ✅ Built |
| Passage library with progress + delete | ✅ Built |
| Resume from last-read chunk | ✅ Built |
| Per-passage translation cache | ✅ Built |
| Paste English → get Spanish lesson | ✅ Built |
| Mexican Spanish bias in glosses | ✅ Built (via prompt) |
| Comprehensible input (TL first, then EN) | ✅ Built |
| Affective filter management (no streaks, etc.) | ✅ Built |
| SRS / spaced repetition | ❌ Schema present, no UI |
| Questions / cued recall / cloze | ❌ Types present, no UI |
| Speaking practice / ASR | ❌ Not started |
| Scenarios | ❌ Not started |
| AI conversation mode | ❌ Not started |
| italki warmup / capture | ❌ Not started |
| Anki integration (Ben mode) | ❌ Not started |
| Japanese / furigana | ❌ Not started |
| Three-stage reveal | ❌ Not started |
| Incremental passage processing | ✅ Built (sentence-batched, prefetched) |
| Phone deployment | ❌ Not started |
| Audio-only walking mode | ❌ Not started |

---

## 13. What's deferred and why

Each of the unbuilt items has a known cost-benefit profile:

- ~~**Incremental processing**~~ — Built. Sentence-batched (4 sentences
  per batch), one fetch in flight at a time, prefetches as the user nears
  the end of processed content. Long articles work; quitting mid-passage
  saves API cost on unprocessed batches.
- **Phone deployment** — the dev-mode `vite --host` would give Wi-Fi access
  in ~15 minutes; full Phase-3 deployment (backend proxy + production host +
  PWA) is 8-15h. Gated on need: useful when Adryane or Ben actually want to
  use the tool.
- **SRS + questions** — the most complex unbuilt feature. The original doc's
  vocabulary tracking and question generation requires a meaningful pipeline
  on top of the current reading-only flow. Multiple sessions of work.
- **italki bridge / scenarios** — depend on having SRS infrastructure first.
- **Anki / Japanese / furigana** — Ben-mode. Independent product. Could be
  done after Pete's Spanish mode is mature.

---

## 14. Test coverage

47 unit tests, all on pure functions:

- **`core.test.ts`** (40 tests)
  - Chunking: sentence splitting, sub-sentence splitting at clause
    boundaries, edge cases (¿/¡, ellipsis, trailing text, custom limits),
    sentence-index assignment
  - SRS scheduling math (got / tip-of-tongue / failed with ease floor and
    interval reset)
  - Exposure tracking
  - Due-item selection
  - Question grading (MCQ exact-match, cloze with normalization, translation
    defer-to-judgment)
  - Cloze generation
  - State reducers (addVocabItem, addPassage, applyReviewEvent,
    recordChunkExposure)
- **`storage.test.ts`** (7 tests)
  - Load returns empty on missing / corrupt / wrong-schema-version data
  - Round-trip save/load preserves passage data
  - Partial settings on disk get default-filled
  - Save synchronous (`flushSaveLearnerState`)
  - Save debounce collapses rapid changes

No tests on React effects or rendering. Effects are thin wrappers over the
tested pure code; coverage is in the pure layer.

---

## 15. Known issues and rough edges

- **First TTS call may require a user gesture.** Some browsers don't allow
  speech until the user has interacted; clicking "Start reading" satisfies
  this. If silence on the very first chunk, hit pause then resume.
- **Firefox has spotty Web Speech support.** Chrome and Edge work well.
- **Mobile is untested.** Layout has a 640px breakpoint that stacks the
  Spanish/English columns vertically; whether the rest of the UX feels right
  on phone is unknown.
- **Re-read pace currently shares the speech-pace slider's range** (0.5×–
  2.0×). Could be narrowed pedagogically (0.7×–1.0× for "natural-paced
  reinforcement") if the wider range proves unhelpful.
- **Long sentences with no internal punctuation** can sometimes produce
  chunks larger than the 15-word target. The prompt enforces a hard maximum,
  but in pathological cases (Spanish with no commas, conjunctions, or
  subordinators), the LLM may break the constraint to avoid splitting a
  preposition from its object.

---

## 16. Operations

### Run locally

```
cd C:\Users\DonAd\lang-tool
npm install     # only first time
npm run dev     # starts Vite on http://localhost:5173
```

### Other scripts

```
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # production build to dist/
npm run preview    # serve the production build locally
```

### API key

`.env.local` at project root:

```
VITE_ANTHROPIC_API_KEY=sk-ant-api03-...
```

The variable name must start with `VITE_` for Vite to expose it to client
code. The key ends up in the bundled JavaScript — fine for `localhost` use,
not safe for any deployment. Real deployment (Adryane / Ben access) will
need a backend proxy.

### Cost monitoring

Anthropic console at console.anthropic.com → Usage tab. With Haiku and
prompt-cached system prompts, a typical news paragraph costs around
$0.005–0.02 per first read; re-reads are free (localStorage cache). Set a
monthly spend cap in console settings as a safety net.

---

## 17. Glossary

| Term | Meaning in this project |
|---|---|
| TL | Target language. Spanish in this build. |
| Chunk | A 5–15-word unit of TL text, the atomic unit of comprehension and playback. |
| Sentence | A source-language sentence; may contain multiple sub-chunks. |
| Gloss | The English meaning shown beside the Spanish chunk. |
| Re-read | An optional second Spanish reading of the same chunk, possibly in a different voice. |
| Emphasis | Visual marking of the currently-active chunk (color background, bold, both, or none). |
| Theme | The color palette of the whole UI. |
| Passage | The pasted text plus all its derived chunks and reading state. |
| Library | The persisted list of all passages the user has processed. |
| Active side | Which cell (Spanish or English) gets emphasis in the current moment, following the audio. |

---

*Last revised: at the point Pete asked "can you create a design document
that explains what the program currently does and how it does it."*
