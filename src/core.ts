import {
  ChapterSplit,
  Chunk,
  ChunkId,
  LearnerState,
  Passage,
  PassageId,
  Question,
  ReviewEvent,
  ReviewEventId,
  ReviewOutcome,
  Settings,
  SrsState,
  VocabItem,
  VocabItemId,
} from './types';

// === Exhaustiveness ===

export function assertNever(x: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(x)}`);
}

// === ID generation ===
// Core is pure; the shell decides the source (uuid, nanoid, counter).

export interface IdGen {
  readonly newPassageId: () => PassageId;
  readonly newChunkId: () => ChunkId;
  readonly newVocabItemId: () => VocabItemId;
  readonly newReviewEventId: () => ReviewEventId;
}

// === Defaults ===

const SM2_DEFAULT_EASE = 2.5;
const SM2_MIN_EASE = 1.3;
const DAY_MS = 24 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

export function defaultSettings(): Settings {
  return {
    dialect: 'es-MX',
    questionFrequency: 4,
    revealMode: 'cumulative',
    ttsVoice: null,
    englishTtsVoice: null,
    ttsEnabled: true,
    speechPaceMultiplier: 1.0,
    readPaceMultiplier: 1.0,
    englishTtsEnabled: false,
    englishSpeechPaceMultiplier: 1.0,
    reReadEnabled: false,
    reReadVoice: null,
    reReadPaceMultiplier: 1.1,
    reReadAlternates: false,
    reReadShortChunks: false,
    readingMode: 'scaffolded',
    defaultReadingMode: 'scaffolded',
    theme: 'white',
    emphasisStyle: 'color',
  };
}

export function emptyLearnerState(): LearnerState {
  return {
    passages: {},
    vocabItems: {},
    srs: {},
    reviews: [],
    sessions: [],
    settings: defaultSettings(),
  };
}

export function initialSrsState(vocabItemId: VocabItemId): SrsState {
  return {
    vocabItemId,
    lastReviewedAt: null,
    nextDueAt: 0,
    intervalDays: 0,
    ease: SM2_DEFAULT_EASE,
    exposureChunks: [],
    lapseCount: 0,
  };
}

// === Chunking ===
// Spanish v1: split on sentence-ending punctuation, then recursively split
// long sentences at the best available clause boundary (comma + coordinator,
// subordinator, bare comma). Heuristic; refine with real news samples.

export interface ChunkingOptions {
  readonly maxWords: number;
  readonly minWordsPerSubChunk: number;
}

const DEFAULT_CHUNKING: ChunkingOptions = {
  maxWords: 12,
  minWordsPerSubChunk: 4,
};

export function chunkPassage(
  passageId: PassageId,
  rawText: string,
  ids: Pick<IdGen, 'newChunkId'>,
  options: Partial<ChunkingOptions> = {},
): ReadonlyArray<Chunk> {
  const opts: ChunkingOptions = { ...DEFAULT_CHUNKING, ...options };
  const sentences = splitOnTerminalPunctuation(rawText);
  const out: Chunk[] = [];
  let chunkIndex = 0;
  sentences.forEach((sentence, sentenceIndex) => {
    for (const tlText of subdivide(sentence, opts)) {
      out.push({
        id: ids.newChunkId(),
        passageId,
        index: chunkIndex++,
        sentenceIndex,
        tlText,
        englishGloss: null,
        audioRef: null,
      });
    }
  });
  return out;
}

// Local sentence splitter — no LLM, just terminal-punctuation heuristic. Used
// by the shell to pre-split a passage before incremental batch processing.
export function splitSentences(rawText: string): ReadonlyArray<string> {
  return splitOnTerminalPunctuation(rawText);
}

export interface LyricsLine {
  readonly text: string;
  // True if there was at least one blank (whitespace-only) line immediately
  // before this one in the source. The first non-empty line is also flagged
  // true if the source begins with blank lines, so a song that opens with
  // whitespace still renders as starting a stanza. Each line is 1:1 with a
  // batch — no merging across lines.
  readonly precededByBlankLine: boolean;
}

// Lyrics splitter — for song-lyric passages where line breaks are
// load-bearing. Splits on \n (CRLF tolerant). Empty / whitespace-only lines
// are not emitted as their own chunks; instead they flag the next non-empty
// line as a stanza opener via precededByBlankLine.
export function splitLyricsIntoLines(rawText: string): ReadonlyArray<LyricsLine> {
  const out: LyricsLine[] = [];
  let pendingBlank = false;
  for (const raw of rawText.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      pendingBlank = true;
      continue;
    }
    out.push({ text: trimmed, precededByBlankLine: pendingBlank });
    pendingBlank = false;
  }
  return out;
}

// === Book ingestion: chapter splitting ===

function bookWordCount(s: string): number {
  const t = s.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

// A run of roman-numeral letters. Case-insensitive at the call site. Doesn't
// validate that the numeral is well-formed (e.g. "iiii") — books aren't strict.
const ROMAN = '[ivxlcdm]+';

// Headers are tiered by confidence. STRONG patterns are unmistakable chapter
// markers that almost never occur by accident in prose, so 2 of them is enough
// to trust a book split (e.g. Mother Night uses "17: August Krapptauer Goes to
// Valhalla …" — number, colon, title). WEAK patterns (a bare number or roman
// numeral alone on a line) are easy to hit by accident, so they need ≥3 and are
// only used when no strong headers are present.
const STRONG_HEADER_PATTERNS: ReadonlyArray<RegExp> = [
  // "Chapter 12", "Chapter IV: The Return", "Capítulo 3 — El final"
  new RegExp(`^(chapter|cap[íi]tulo)\\s+(\\d+|${ROMAN})\\b`, 'i'),
  // Spelled-out chapter numbers: "Chapter One", "Capítulo Dos", …
  new RegExp(
    '^(chapter|cap[íi]tulo)\\s+' +
      '(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|' +
      'thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|' +
      'uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\\b',
    'i',
  ),
  // "17: August …" / "1. The Beginning" — number, separator, then a title.
  // Requires whitespace after the separator, so "2.1 lbs" / "3:45" don't match.
  /^\d+\s*[.:]\s+\S/,
];

const WEAK_HEADER_PATTERNS: ReadonlyArray<RegExp> = [
  /^\d+$/, // bare arabic number on its own line
  new RegExp(`^${ROMAN}$`, 'i'), // bare roman numeral on its own line
];

function headerKind(line: string): 'strong' | 'weak' | null {
  const t = line.trim();
  if (t.length === 0) return null;
  if (STRONG_HEADER_PATTERNS.some((re) => re.test(t))) return 'strong';
  if (WEAK_HEADER_PATTERNS.some((re) => re.test(t))) return 'weak';
  return null;
}

// Title for the pre-first-header section, from its first non-empty line.
function leadingSectionTitle(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const t = firstLine.slice(0, 50).trim();
  return t.length > 0 ? t : 'Introduction';
}

// Length-based fallback when a book has no detectable chapter headers: pack
// sentences into ~targetWords sections, breaking only on sentence boundaries.
function splitByLength(text: string, targetWords: number): ChapterSplit[] {
  const sentences = splitSentences(text);
  const sections: ChapterSplit[] = [];
  let buf: string[] = [];
  let words = 0;
  const flush = () => {
    const content = buf.join(' ').trim();
    if (content.length > 0) {
      sections.push({ title: `Part ${sections.length + 1}`, content });
    }
    buf = [];
    words = 0;
  };
  for (const s of sentences) {
    buf.push(s);
    words += bookWordCount(s);
    if (words >= targetWords) flush();
  }
  flush();
  if (sections.length === 0) {
    const t = text.trim();
    return t.length > 0 ? [{ title: 'Part 1', content: t }] : [];
  }
  return sections;
}

// Split a pasted book into chapter sections. Tries header heuristics first
// (strong headers trusted at ≥2, weak at ≥3 — see headerKind); otherwise falls
// back to length-based sectioning. The header line is used as the chapter title
// and stripped from the content, so a chapter never opens with "Chapter 1" as
// readable text.
export function splitBookIntoChapters(
  text: string,
  opts: { targetWordsPerSection?: number } = {},
): ChapterSplit[] {
  const targetWords = opts.targetWordsPerSection ?? 2000;
  const lines = text.split(/\r?\n/);

  // Prefer strong headers (trusted at ≥2); fall back to weak headers (≥3);
  // otherwise split by length. Strong and weak are never mixed — a book uses
  // one style, and mixing would let a stray bare number break a real chapter.
  const strongIdx: number[] = [];
  const weakIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const kind = headerKind(lines[i]!);
    if (kind === 'strong') strongIdx.push(i);
    else if (kind === 'weak') weakIdx.push(i);
  }
  const headerIdx =
    strongIdx.length >= 2 ? strongIdx : weakIdx.length >= 3 ? weakIdx : null;

  if (headerIdx === null) {
    return splitByLength(text, targetWords);
  }

  const sections: ChapterSplit[] = [];

  // Text before the first header: keep as a leading section only if it's
  // substantial (else it's a title page / front matter and gets dropped).
  const preText = lines.slice(0, headerIdx[0]).join('\n').trim();
  if (bookWordCount(preText) >= 30) {
    sections.push({ title: leadingSectionTitle(preText), content: preText });
  }

  for (let h = 0; h < headerIdx.length; h++) {
    const start = headerIdx[h]!;
    const end = h + 1 < headerIdx.length ? headerIdx[h + 1]! : lines.length;
    const title = lines[start]!.trim();
    const content = lines
      .slice(start + 1, end)
      .join('\n')
      .trim();
    // Drop empty chapters (back-to-back headers, e.g. a table of contents).
    if (content.length > 0) sections.push({ title, content });
  }

  // If every header turned out empty (pathological), fall back to length.
  return sections.length > 0 ? sections : splitByLength(text, targetWords);
}

// === Book folders: detection, chapter ordering, read progress ===

function romanToInt(s: string): number {
  const map: Record<string, number> = {
    i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000,
  };
  const r = s.toLowerCase();
  let total = 0;
  for (let i = 0; i < r.length; i++) {
    const cur = map[r[i]!] ?? 0;
    const next = map[r[i + 1]!] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

// Parse a chapter number from a passage/chapter title, for ordering chapters
// in a book folder and for next-chapter navigation. Recognizes exactly the
// header shapes splitBookIntoChapters produces — "Chapter 12" / "Capítulo IV"
// (arabic or roman), "Part 3", "1. Title", "1: Title", a standalone arabic
// number, or a standalone roman numeral. Returns null when the title carries
// no recognizable number (e.g. a derived leading-section / intro title).
export function parseChapterNumber(title: string): number | null {
  const t = title.trim();
  const chapter = t.match(
    new RegExp(`^(?:chapter|cap[íi]tulo|part)\\s+(\\d+|${ROMAN})\\b`, 'i'),
  );
  if (chapter) {
    const tok = chapter[1]!;
    return /^\d+$/.test(tok) ? parseInt(tok, 10) : romanToInt(tok);
  }
  const numbered = t.match(/^(\d+)[.:]\s/);
  if (numbered) return parseInt(numbered[1]!, 10);
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (new RegExp(`^${ROMAN}$`, 'i').test(t)) return romanToInt(t);
  return null;
}

// Order two chapters of a book for display / navigation. Numbered chapters
// sort by their parsed number; an unnumbered leading section (intro) sorts
// before the numbered ones; createdAt breaks any remaining tie. This does NOT
// rely on createdAt for primary ordering — a batch-inserted book stamps every
// chapter with the same millisecond, so the title number is the real key.
export function compareChapters(a: Passage, b: Passage): number {
  const na = parseChapterNumber(a.title);
  const nb = parseChapterNumber(b.title);
  if (na !== null && nb !== null) return na - nb || a.createdAt - b.createdAt;
  if (na !== null) return 1; // a is numbered, b is an intro → b first
  if (nb !== null) return -1; // a is an intro, b is numbered → a first
  return a.createdAt - b.createdAt;
}

// True when a folder reads like a book: enough sequentially-numbered chapters
// that the flat folder listing would be a wall of rows. Keyed on titles that
// parseChapterNumber recognizes (the same shapes the book splitter emits), so
// detection stays consistent with ingestion. The ≥70% threshold tolerates a
// leading intro section or the odd hand-added passage; the ≥5 floor keeps a
// couple of "Article 1 / Article 2"-style rows from collapsing into a card.
export function isBookLikeFolder(passages: ReadonlyArray<Passage>): boolean {
  if (passages.length < 5) return false;
  const numbered = passages.filter(
    (p) => parseChapterNumber(p.title) !== null,
  ).length;
  return numbered / passages.length >= 0.7;
}

// Read progress (0–100) for a passage, in SENTENCES so the denominator is the
// whole document rather than just the chunks translated so far. A complete,
// fully-read passage reads 100 even though lastReadChunkIndex runs one past the
// final chunk. Mirrors the number shown on the library row.
export function passagePercentRead(passage: Passage): number {
  const total = passage.sentenceCount;
  if (total <= 0) return 0;
  const finished =
    passage.processingStatus.kind === 'complete' &&
    passage.lastReadChunkIndex >= passage.chunks.length;
  if (finished) return 100;
  let sentencesRead = 0;
  if (passage.chunks.length > 0) {
    const idx = Math.min(passage.lastReadChunkIndex, passage.chunks.length - 1);
    const cur = passage.chunks[idx];
    sentencesRead = cur ? cur.sentenceIndex : 0;
  }
  return Math.round((sentencesRead / total) * 100);
}

// The chapter that follows `currentPassageId` within its book folder, or null
// if it's the last (or not in a folder). Siblings are the same folder +
// subfolder, ordered by compareChapters (parsed chapter number, createdAt as
// the tiebreaker). Callers gate this on isBookLikeFolder so a generic folder
// of numbered articles never offers a surprise "next chapter".
export function findNextChapter(
  passages: ReadonlyArray<Passage>,
  currentPassageId: PassageId,
): Passage | null {
  const current = passages.find((p) => p.id === currentPassageId);
  if (!current || current.folder === null) return null;
  const siblings = passages
    .filter(
      (p) => p.folder === current.folder && p.subfolder === current.subfolder,
    )
    .sort(compareChapters);
  const idx = siblings.findIndex((p) => p.id === currentPassageId);
  if (idx < 0 || idx + 1 >= siblings.length) return null;
  return siblings[idx + 1]!;
}

// What a "Resume reading" button should open, for a given set of passages (the
// whole library for the top-level button, or one folder's passages for a folder
// button). `advancedToNext` is true when the most-recently-read passage was
// already finished, so we're pointing at the following item instead.
export interface ResumeTarget {
  readonly passage: Passage;
  readonly advancedToNext: boolean;
}

// True once the reader has actually started a passage (made progress, or opened
// it — a brand-new passage stamps lastOpenedAt === createdAt, and the
// passages_with_state view coalesces a missing reading_state row back to that
// same created_at, so "opened" reads identically on every device).
function hasBeenStarted(p: Passage): boolean {
  return p.lastReadChunkIndex > 0 || p.lastOpenedAt > p.createdAt;
}

// A passage is finished when it's fully processed and the reader has advanced
// past its last chunk (lastReadChunkIndex runs one past the final chunk at the
// end). Mirrors the "100%" condition in passagePercentRead.
function isPassageFinished(p: Passage): boolean {
  return (
    p.processingStatus.kind === 'complete' &&
    p.lastReadChunkIndex >= p.chunks.length
  );
}

// Decide where "Resume reading" should drop the reader, mirroring how a reader
// thinks about "where I left off":
//   - Among passages they've actually started, take the most recently opened —
//     that's the thing they were last reading.
//   - If they hadn't finished it, resume there. (open-passage restores the saved
//     chunk position, so this lands exactly where they stopped.)
//   - If they HAD finished it, point at the next item in the same folder, opened
//     at its own saved position — the beginning, for an untouched next chapter.
//   - If the finished passage has no next item (the last chapter, or a
//     standalone top-level passage with no sequence), return null so the button
//     disappears.
// Every input comes from synced reading_state, so this resolves identically on
// whatever device the reader picks up next.
export function computeResumeTarget(
  passages: ReadonlyArray<Passage>,
): ResumeTarget | null {
  const started = passages.filter(hasBeenStarted);
  if (started.length === 0) return null;
  const current = started.reduce((latest, p) =>
    p.lastOpenedAt > latest.lastOpenedAt ? p : latest,
  );
  if (!isPassageFinished(current)) {
    return { passage: current, advancedToNext: false };
  }
  const next = findNextChapter(passages, current.id);
  return next ? { passage: next, advancedToNext: true } : null;
}

// Count "significant new words" in a Spanish chunk relative to its English
// gloss. Used to decide whether re-read should fire on short chunks. Rules:
//   - Letter-word that ALSO appears in the English gloss (case-insensitive):
//     not new (e.g. "Howard", "Jones", "no", "hotel"). Doesn't count.
//   - Letter-word that doesn't appear: counts as 1.
//   - Numeric run: each digit counts (since digits are read one-by-one in
//     speech — "ciento veintitres" is roughly 3 spoken units for "123").
//   - Pure punctuation tokens don't count.
//
// Example: "No dijo Howard Jones" against "No said Howard Jones"
//   No → in English → skip
//   dijo → not in English → 1
//   Howard → in English → skip
//   Jones → in English → skip
//   Total: 1
export function countSignificantWords(
  spanishText: string,
  englishGloss: string | null,
): number {
  const englishWords = new Set<string>();
  if (englishGloss) {
    const matches = englishGloss.match(/[\p{L}]+/gu);
    if (matches) {
      for (const w of matches) englishWords.add(w.toLowerCase());
    }
  }
  let count = 0;
  // Match either a run of digits OR a run of Unicode letters.
  const tokens = spanishText.match(/\d+|[\p{L}]+/gu) ?? [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      count += token.length;
    } else if (!englishWords.has(token.toLowerCase())) {
      count += 1;
    }
  }
  return count;
}

// Tokens that look like sentence ends but aren't. Lowercased, no trailing dot.
// English titles, Spanish titles, common Latin abbrev., and a few measurement
// abbreviations Pete's reading material has hit.
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  // English titles
  'mr', 'mrs', 'ms', 'dr', 'st', 'sr', 'jr', 'prof', 'rev', 'hon', 'capt',
  'sgt', 'lt', 'col', 'gen', 'rep', 'sen', 'gov', 'pres',
  // Spanish titles
  'sra', 'srta', 'sres', 'dra', 'don', 'dn', 'fr', 'sto', 'sta',
  // Latin / common abbreviations
  'etc', 'eg', 'ie', 'cf', 'vs', 'no', 'nos', 'vol', 'pp', 'ch', 'p',
  'al', // "et al."
  // Measurement / unit-ish
  'oz', 'lb', 'lbs', 'kg', 'mg', 'ml', 'cm', 'mm', 'km', 'ft', 'in',
]);

function splitOnTerminalPunctuation(text: string): ReadonlyArray<string> {
  const result: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    current += c;
    if (c !== '.' && c !== '!' && c !== '?' && c !== '…') continue;

    if (c === '.' && !shouldSplitAtPeriod(current, text, i)) {
      continue;
    }

    const trimmed = current.trim();
    if (trimmed.length > 0) result.push(trimmed);
    current = '';
  }
  const tail = current.trim();
  if (tail.length > 0) result.push(tail);
  return result;
}

// Heuristic: a period ends a sentence unless one of these holds:
//   - The token immediately before the period is a known abbreviation
//   - The token is a single letter (e.g. "U.S.", "D.A.")
//   - The token is a bare number (e.g. "2.1 pounds")
//   - The next non-whitespace character is lowercase (clear continuation)
function shouldSplitAtPeriod(
  current: string,
  full: string,
  periodIndex: number,
): boolean {
  // Find the token immediately preceding the period.
  const beforeDot = current.slice(0, current.length - 1);
  const tokenMatch = beforeDot.match(/(\S+)$/);
  if (tokenMatch) {
    const tokenRaw = tokenMatch[1] ?? '';
    const token = tokenRaw.toLowerCase();
    if (ABBREVIATIONS.has(token)) return false;
    // Single letter abbreviations like the "U" / "S" / "A" inside "U.S.A."
    if (/^[A-Za-zÁÉÍÓÚÑáéíóúñ]$/.test(tokenRaw)) return false;
    // Numeric decimals: "2.1 pounds" — the token before the dot is "2".
    if (/^\d+$/.test(tokenRaw)) return false;
  }
  // Look at the next non-whitespace character.
  let j = periodIndex + 1;
  while (j < full.length && /\s/.test(full[j] ?? '')) j++;
  if (j < full.length) {
    const next = full[j] ?? '';
    // Continues mid-sentence (lowercase letter — clearly not a new sentence).
    if (/[a-zñáéíóú]/.test(next)) return false;
  }
  return true;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

interface SplitCandidate {
  readonly position: number;
  readonly score: number;
}

// Higher score = better split point. Each pattern returns the character
// position to split at (left chunk is text.slice(0, position)).
function findSplitCandidates(text: string): ReadonlyArray<SplitCandidate> {
  const out: SplitCandidate[] = [];

  // Comma followed by a coordinator. Split right after the comma; new chunk
  // begins with "y" / "pero" / etc. Score 10.
  for (const m of text.matchAll(/,\s+(?=(?:y|pero|o|ni|sino|mas)\s)/gi)) {
    if (m.index !== undefined) out.push({ position: m.index + 1, score: 10 });
  }
  // Subordinator preceded by whitespace. Split right before the subordinator.
  // Score 8.
  for (const m of text.matchAll(/\s(?=(?:que|porque|cuando|mientras|aunque|si|donde|como|pues)\s)/gi)) {
    if (m.index !== undefined) out.push({ position: m.index + 1, score: 8 });
  }
  // Bare comma. Score 6.
  for (const m of text.matchAll(/,\s+/g)) {
    if (m.index !== undefined) out.push({ position: m.index + 1, score: 6 });
  }

  return out;
}

function subdivide(text: string, opts: ChunkingOptions): ReadonlyArray<string> {
  const words = countWords(text);
  if (words <= opts.maxWords) return [text];

  const candidates = findSplitCandidates(text);
  // Keep only candidates that produce both sides >= minWordsPerSubChunk.
  // Prefer the highest-scoring; tie-break by closeness to the midpoint.
  const midpoint = text.length / 2;
  const scored = candidates
    .map((c) => {
      const left = text.slice(0, c.position).trim();
      const right = text.slice(c.position).trim();
      const lw = countWords(left);
      const rw = countWords(right);
      if (lw < opts.minWordsPerSubChunk || rw < opts.minWordsPerSubChunk) return null;
      const balancePenalty = Math.abs(c.position - midpoint) / text.length;
      return { ...c, left, right, adjusted: c.score - balancePenalty };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  if (scored.length === 0) return [text];

  scored.sort((a, b) => b.adjusted - a.adjusted);
  const best = scored[0]!;
  return [...subdivide(best.left, opts), ...subdivide(best.right, opts)];
}

// === SRS update ===
// SM-2-ish three-state. 'got' grows interval, 'tip-of-tongue' rests it briefly
// with a small ease penalty, 'failed' resets to short interval with larger penalty.

export function nextSrsState(
  prev: SrsState,
  outcome: ReviewOutcome,
  reviewedAt: number,
): SrsState {
  switch (outcome) {
    case 'got': {
      const isFirst = prev.intervalDays === 0;
      const nextInterval = isFirst ? 1 : Math.round(prev.intervalDays * prev.ease);
      return {
        ...prev,
        lastReviewedAt: reviewedAt,
        nextDueAt: reviewedAt + nextInterval * DAY_MS,
        intervalDays: nextInterval,
      };
    }
    case 'tip-of-tongue': {
      const nextInterval = Math.max(1, Math.round(prev.intervalDays * 0.5));
      return {
        ...prev,
        lastReviewedAt: reviewedAt,
        nextDueAt: reviewedAt + nextInterval * DAY_MS,
        intervalDays: nextInterval,
        ease: Math.max(SM2_MIN_EASE, prev.ease - 0.15),
      };
    }
    case 'failed': {
      return {
        ...prev,
        lastReviewedAt: reviewedAt,
        nextDueAt: reviewedAt + TEN_MINUTES_MS,
        intervalDays: 0,
        ease: Math.max(SM2_MIN_EASE, prev.ease - 0.3),
        lapseCount: prev.lapseCount + 1,
      };
    }
    default:
      return assertNever(outcome);
  }
}

// === Exposure tracking ===
// "Word knowledge as gradient" (§8): set of distinct chunks the item has been seen in.

export function recordExposure(prev: SrsState, chunkId: ChunkId): SrsState {
  if (prev.exposureChunks.includes(chunkId)) return prev;
  return { ...prev, exposureChunks: [...prev.exposureChunks, chunkId] };
}

// === Due selection ===

export function dueVocabItemIds(
  state: LearnerState,
  now: number,
): ReadonlyArray<VocabItemId> {
  return Object.values(state.srs)
    .filter((s) => s.nextDueAt <= now)
    .sort((a, b) => a.nextDueAt - b.nextDueAt)
    .map((s) => s.vocabItemId);
}

// === Question grading ===
// MCQ and cloze graded locally; translation grading is deferred to the shell
// (LLM-as-judge) because it requires non-pure I/O.

export type GradeRequest =
  | { readonly kind: 'mcq-meaning'; readonly selectedIndex: number }
  | { readonly kind: 'cloze'; readonly answer: string }
  | { readonly kind: 'translate-tl-to-en'; readonly answer: string }
  | { readonly kind: 'translate-en-to-tl'; readonly answer: string };

export type GradeResult =
  | { readonly kind: 'auto'; readonly outcome: ReviewOutcome }
  | {
      readonly kind: 'needs-judgment';
      readonly prompt: string;
      readonly reference: string;
      readonly userAnswer: string;
    };

export function gradeQuestion(question: Question, response: GradeRequest): GradeResult {
  switch (question.kind) {
    case 'mcq-meaning': {
      if (response.kind !== 'mcq-meaning') throw mismatchedKinds(question.kind, response.kind);
      return {
        kind: 'auto',
        outcome: response.selectedIndex === question.correctIndex ? 'got' : 'failed',
      };
    }
    case 'cloze': {
      if (response.kind !== 'cloze') throw mismatchedKinds(question.kind, response.kind);
      const got = normalizeForCompare(response.answer) === normalizeForCompare(question.answer);
      return { kind: 'auto', outcome: got ? 'got' : 'failed' };
    }
    case 'translate-tl-to-en': {
      if (response.kind !== 'translate-tl-to-en') throw mismatchedKinds(question.kind, response.kind);
      return {
        kind: 'needs-judgment',
        prompt: question.prompt,
        reference: question.reference,
        userAnswer: response.answer,
      };
    }
    case 'translate-en-to-tl': {
      if (response.kind !== 'translate-en-to-tl') throw mismatchedKinds(question.kind, response.kind);
      return {
        kind: 'needs-judgment',
        prompt: question.prompt,
        reference: question.reference,
        userAnswer: response.answer,
      };
    }
    default:
      return assertNever(question);
  }
}

function mismatchedKinds(qKind: string, rKind: string): Error {
  return new Error(`Mismatched question/response kinds: ${qKind} vs ${rKind}`);
}

function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .replace(/\s+/g, ' ');
}

// === Cloze generation ===
// Pure: blank out the target surface form. Distractor options (if any) come
// from the shell, since they may need an LLM.

export function makeClozeQuestion(
  chunk: Chunk,
  targetVocab: VocabItemId,
  targetWord: string,
  options: ReadonlyArray<string> | null = null,
): Question | null {
  const re = new RegExp(`\\b${escapeRegex(targetWord)}\\b`, 'i');
  if (!re.test(chunk.tlText)) return null;
  return {
    kind: 'cloze',
    target: targetVocab,
    sentence: chunk.tlText.replace(re, '___'),
    answer: targetWord,
    options,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// === State reducers ===
// Each takes prev state, returns next state. The shell threads them.

export function addPassage(state: LearnerState, passage: Passage): LearnerState {
  return { ...state, passages: { ...state.passages, [passage.id]: passage } };
}

export function addVocabItem(state: LearnerState, item: VocabItem): LearnerState {
  return {
    ...state,
    vocabItems: { ...state.vocabItems, [item.id]: item },
    srs: { ...state.srs, [item.id]: initialSrsState(item.id) },
  };
}

export function recordChunkExposure(
  state: LearnerState,
  vocabItemId: VocabItemId,
  chunkId: ChunkId,
): LearnerState {
  const prev = state.srs[vocabItemId];
  if (!prev) return state;
  return { ...state, srs: { ...state.srs, [vocabItemId]: recordExposure(prev, chunkId) } };
}

export function applyReviewEvent(state: LearnerState, event: ReviewEvent): LearnerState {
  const prevSrs = state.srs[event.vocabItemId];
  if (!prevSrs) return state;
  return {
    ...state,
    srs: { ...state.srs, [event.vocabItemId]: nextSrsState(prevSrs, event.outcome, event.reviewedAt) },
    reviews: [...state.reviews, event],
  };
}

// === Session flow ===
// Core decides *when* to interleave a question. *Which* question is built in
// the shell because mcq distractors and translation references need the LLM.

export function shouldInterleaveQuestion(
  chunksRevealedSinceLastQuestion: number,
  settings: Settings,
): boolean {
  return chunksRevealedSinceLastQuestion >= settings.questionFrequency;
}
