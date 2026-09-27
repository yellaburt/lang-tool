# Task: lang-tool updates (September 2026)

**Status:** All ten items implemented (2026-09-27), typechecked, and unit-tested.
Not yet deployed or verified in the live app. See "Implementation notes" at the
bottom for where the build differs from this spec.

This doc collects ten pending changes. Items 1 through 5 amend `docs/task-subjunctive-highlighting.md` (the original subjunctive spec). Where this doc and the codebase's existing conventions differ on names or structure, follow the codebase. Where this doc and the older spec conflict, this doc wins.

**Suggested order:** 4 (lexicon) first, then 1, 2, 3, 5, then 6, 8, 7, 9, 10.

**Migration numbering:** check existing migration prefixes before creating a new one. A duplicate prefix (two `20260527` migrations) previously caused silent persistence failures.

---

## Part A. Subjunctive highlighting fixes

### Dependency: deterministic subjunctive-form lexicon

Items 3, 4 and 5 depend on a deterministic lexicon: generated subjunctive conjugation tables per lemma (present, imperfect *-ra* and *-se*, perfect, pluperfect), with tense, person and number for each form. If this does not exist yet, build it first.

### 1. Renderer guard against false triggers

- In the mood-annotation renderer, drop any `trigger` annotation that has no `subjunctive_verb` with the same `pair_id` in the same chunk.
- Keep the guard strict to the same chunk. Do not widen it to adjacent chunks.
- Tighten the annotation prompt: "Two-mood triggers (cuando, aunque, mientras, quizás, hasta que, si, etc.) followed by an indicative verb get no tags at all. Before tagging any trigger, first identify the verb it governs and confirm that verb is subjunctive."
- Negative test case: *Cuando llegaba la comida, los seres humanos estaban callados y confiados y hermosos.* Nothing in this sentence should be tagged.

### 2. Uncertainty policy

- Uncertain triggers: omit.
- Uncertain verbs: tag, using the `possible_subjunctive` role (item 3).

### 3. New role: `possible_subjunctive`

- Add a third annotation role, `possible_subjunctive`, rendered in the muted (trigger) style.
- A deterministic lexicon post-pass emits it for tokens that match a subjunctive form but also have a non-verb homograph (*coma*, *vaya*, *cante*, etc.) and that the model did not confidently tag.
- Confident model tags and unambiguous lexicon matches remain `subjunctive_verb`.

### 4. Unconditional lexicon veto

- Check every `subjunctive_verb` tag against the lexicon table for that lemma. If the token is not a subjunctive form of that lemma, drop the tag.
- Apply this to every tag, not only uncertain ones. The observed errors came through as confident tags.
- Observed cases this must catch: *se recuperó* tagged near *cuando*; *portas* tagged near *si*. In both, a nearby trigger word led the model to tag the next verb regardless of its form.

### 5. Lexicon as ground truth for glosses

- For any token the lexicon covers, the lexicon is authoritative for mood and tense. Pass its answer into gloss generation as a given fact, not a suggestion. The gloss prompt does not re-derive it.
- Tokens outside lexicon coverage: the gloss generates independently, as now.
- If the model's independent reading still disagrees with the lexicon for a covered token, write the disagreement to a review log (lemma, token, lexicon answer, model answer, chunk id). Do not silently resolve it either way. Recurring disagreement on one lemma means the lexicon entry should be audited.
- Observed case: *aullaran* (imperfect subjunctive) was highlighted correctly but glossed as *aullarán* (future indicative).

---

## Part B. Pipeline robustness

### 6. Refusal and failure handling

Detect failure by schema validation: any response that does not parse into the expected structure is a failure, including refusal prose, preambles and truncation.

**Current behavior to remove:** a refused translation currently displays as `[...]`. Remove that placeholder everywhere. In both cases below, the reader sees the original text followed by a plain `[not translated]` label, never an omission.

**Prevent refusals first (both pipelines).** Refusals cluster on violent, sexual or cruel passages, which are often important to the story.
- In the system prompt for both the gloss and translation calls, state that the task is a faithful translation of a published literary work for a reader studying it, and that violence, sexuality and cruelty must be rendered accurately.
- Also instruct: never soften, summarize, sanitize or omit anything. A silently softened translation is worse than a visible failure, because the reader cannot detect it.

**(a) Gloss pipeline, Spanish source.**
- On failure, retry once on Sonnet with the same framing.
- If it still fails, persist the chunk with `gloss_status: 'unavailable'`.
- Render the Spanish normally. Word-tap stays active. No mood annotations for that chunk.
- In place of the English gloss, show the label `[not translated]`.
- Add a per-chunk manual "retry translation" action.

**(b) Translation pipeline, English source.** A failure here is a hole in the book, so retry.
- Retry on Sonnet. Then retry once with shifted chunk boundaries (merge with a neighbor or split differently). Then stop. No loops.
- If still failing, persist `translation_status: 'unavailable'` with the English source text.
- Render such chunks inline as the English source followed by `[not translated]`, with word-tap, TTS and mood annotations disabled.
- Add a per-chunk manual "retry translation" action.
- If translation runs at ingestion, list untranslated chunks in the post-ingestion report.

### 8. Pronoun context for glosses

- Problem: Spanish drops subject pronouns, and chunk-by-chunk glossing loses track of who the subject is, so English pronouns sometimes get the wrong gender (observed in *La invención de Morel*).
- Fix: include the one or two preceding chunks of Spanish in each gloss call, clearly marked as context only, not to be translated.
- Preceding text only. Never include text that comes later in the book.

---

## Part C. Reading and listening features

### 7. Tense note on trigger tap

- Tapping a trigger shows a short note explaining the tense relationship between trigger and subjunctive:
  - Present-frame trigger: present subjunctive (*quiero que vengas*).
  - Past-frame trigger (preterite, imperfect, pluperfect, conditional): imperfect subjunctive (*quería que vinieras*, *me gustaría que vinieras*).
- Example note text: "*quería* is past, so the subjunctive shifts to *vinieras*."
- No new visual marker on the page. Every trigger keeps its current style.
- Use the grammar-note infrastructure if it exists. If not, a minimal popover is fine.

### 9. Speak the tapped word

- When the user is in a mode with audio enabled (match the codebase's existing notion of an audio/listening mode), tapping a word plays it aloud when the definition appears.
- Play a three-word window: the word before, the tapped word, the word after, as they appear in the text (the conjugated surface form, not the infinitive).
- Do not cross punctuation or sentence boundaries. If the tapped word is first or last in its sentence or passage, drop the missing side.
- The written definition still shows the lemma/infinitive.
- **Audio source, in order of preference:**
  1. If the passage audio has ElevenLabs word or character timestamps, replay that stretch of the existing passage audio. No new TTS call.
  2. Otherwise, synthesize the window with the same voice as the passage and cache it (keyed by window text and voice).
- If passage audio is playing, pause it, play the window, then resume.

### 10. New mode: read, listen, reveal

A new reading mode. Integrate it with the existing mode switcher and per-user default mode setting.

1. Show the Spanish chunk.
2. User presses Continue. The Spanish text is hidden and the chunk audio plays.
   - A replay button is available while the text is hidden.
3. When the audio ends, the Spanish reappears.
   - The English translation stays hidden behind a tap. Do not show it automatically.
4. Continue advances to the next chunk.

Before building, confirm that the existing light reading mode does not already do this. (Light reading mode hides the English, not the Spanish.)

---

## Testing notes

- Seed passages for Part A: regular *-ar* and *-er/-ir* present subjunctive; imperfect in *-ra* and *-se*; perfect subjunctive; negative imperative; independent *que* clause; *cuando* + indicative (the sentence in item 1); *cuando* + subjunctive; homographs *coma*, *vaya*; *aullaran* vs. *aullarán*.
- Old cached chunks without annotations or lexicon data render without errors.
- Word-tap still works on highlighted words on mobile.
- Item 9: tap first word, last word, and a word next to a comma; confirm the window stops at punctuation.
- Item 10: replay works while hidden; English never appears without a tap.

## Out of scope (possible later)

- Flag for tense mismatch (past trigger followed by present subjunctive).
- Cross-chunk trigger/verb pairing.
- Bracketing English pronouns that the Spanish left unstated ("[he] arrived").
- Reversed listening order (listen first, then read) as a harder variant of item 10.

---

## Implementation notes (spec vs. codebase)

Per the spec's own rule, where the spec and the codebase differed, the build
follows the codebase:

- **One pipeline, not two.** Glossing (Spanish source) and translation (English
  source) are the same `chunk-and-gloss` call; the model detects the language.
  6(a)/6(b) are told apart client-side by a local language guess
  (`_shared/language.ts`). The shifted-boundary retry lives on the client,
  because only the client knows the neighbouring sentences.
- **Status fields:** one optional `Chunk.unavailable: 'gloss' | 'translation'`
  (a discriminated field, per codebase style) instead of separate
  `gloss_status` / `translation_status`. Chunks are JSONB, so no migration.
- **No ingestion report exists** (chapters process lazily when opened), so the
  6(b) "list untranslated chunks in the post-ingestion report" item doesn't
  apply. Untranslated chunks are visible inline with a retry button.
- **Item 9, no ElevenLabs.** Audio is Web Speech (local, free), so there are no
  timestamps to replay from and nothing to cache. The window is synthesized in
  the passage's Spanish voice. The existing lookup behaviour is kept: the tap
  pauses passage audio, and it stays paused until Resume. It does not
  auto-resume after the window plays, because the definition panel is still
  open.
- **Item 9 boundaries:** the window stays inside the tapped chunk. At a chunk
  edge that isn't a sentence edge, the missing side is dropped.
- **Item 3 "did not confidently tag"** is read as "the model tagged it as
  uncertain". The post-pass never adds `possible_subjunctive` to an untagged
  token. Doing so would tint every *entre*, *una* and *tarde*. It does tag
  *unambiguous* known forms the model missed, as `subjunctive_verb`, and logs
  them.
- **Item 5 review log:** `mood_review_log` (new migration
  `20260927_mood_review_log.sql`, prefix checked). The "model answer" for a
  gloss disagreement is what the model's tagging implies (tagged / not
  tagged); the English gloss isn't parsed for tense. Vetoes are logged too, so
  a bad lexicon entry shows up as recurring rows.
- **Item 7:** the frame is read from the paired verb's lexicon tense. The note
  names the trigger's verb when it has one ("*quería* is past…") and says "the
  main verb" for bare conjunctions (*para que*). Only v6+ chunks have tenses.
- **Item 10 is new behaviour.** Light hides the English, never the Spanish.
  The existing Reading mode (with read-aloud-on-advance) plays audio with the
  text visible, then auto-advances. Neither matches, so the new mode is
  `'reveal'` ("Read, listen, reveal").
- **Also added (spirit of 6):** strict validation now fails a response on any
  malformed chunk (v5 silently skipped them), on truncation, on an empty gloss,
  and when a Spanish input comes back missing >15% of its letters.
