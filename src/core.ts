import { detectSourceLanguage } from '../supabase/functions/_shared/language';
import { isKnownLemma } from '../supabase/functions/_shared/subjunctive';
import {
  ChapterSplit,
  Chunk,
  ChunkId,
  LearnerState,
  MoodAnnotation,
  Passage,
  PassageId,
  Question,
  ReviewEvent,
  ReviewEventId,
  ReviewOutcome,
  Settings,
  SrsState,
  SubjTense,
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
    readAloudOnAdvance: true,
    theme: 'white',
    emphasisStyle: 'color',
    highlightSubjunctive: true,
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

// === Reading modes ===

// Does the reader's setup include audio? Decides whether a word tap also
// speaks the word (item 9). Every mode plays audio except 'reading', which
// has audio only when "Play Spanish audio when advancing" is on — and when it
// is, word taps speak too.
export function lookupSpeechEnabled(
  settings: Pick<Settings, 'readingMode' | 'readAloudOnAdvance'>,
): boolean {
  switch (settings.readingMode) {
    case 'scaffolded':
    case 'listening':
    case 'light':
    case 'reveal':
      return true;
    case 'reading':
      return settings.readAloudOnAdvance;
    default:
      return assertNever(settings.readingMode);
  }
}

// === Translation failures (task item 6) ===

// v5 and earlier inserted this placeholder chunk when a batch was refused,
// throwing the source text away. The placeholder is gone everywhere now.
const LEGACY_PLACEHOLDER_TEXT = '[…]';
// A refused v5 batch was always one batch: at most this many source units.
const LEGACY_BATCH_SIZE = 2;

function isLegacyPlaceholder(c: Chunk): boolean {
  return c.tlText === LEGACY_PLACEHOLDER_TEXT && c.unavailable === undefined;
}

// Recover the source text behind legacy '[…]' placeholder chunks from the
// passage's rawText (the placeholder carries its batch's first sentenceIndex;
// the next chunk's sentenceIndex bounds it) and turn each into a proper
// unavailable chunk, so old passages show "[not translated]" and can be
// retried like new ones. Applied on load; persists on the passage's next write.
export function upgradeLegacyPlaceholders(passage: Passage): Passage {
  if (!passage.chunks.some(isLegacyPlaceholder)) return passage;
  const units = passageUnits(passage);
  const chunks = passage.chunks.map((c, i) => {
    if (!isLegacyPlaceholder(c)) return c;
    const next = passage.chunks[i + 1];
    const end =
      passage.chunkingMode === 'lyrics'
        ? c.sentenceIndex + 1
        : Math.min(next ? next.sentenceIndex : Infinity, c.sentenceIndex + LEGACY_BATCH_SIZE);
    const source = units.slice(c.sentenceIndex, Math.max(end, c.sentenceIndex + 1)).join(' ');
    return unavailableChunk(c, source);
  });
  return { ...passage, chunks };
}

// Turn a chunk skeleton into an unavailable chunk carrying `source`. Which kind
// depends on the source language: a Spanish source keeps its Spanish (only the
// gloss is missing); an English source has no Spanish at all.
export function unavailableChunk(
  base: Omit<Chunk, 'tlText' | 'englishGloss' | 'unavailable' | 'moodAnnotations'>,
  source: string,
): Chunk {
  const { id, passageId, index, sentenceIndex, audioRef, precededByBlankLine } = base;
  return {
    id,
    passageId,
    index,
    sentenceIndex,
    audioRef,
    ...(precededByBlankLine ? { precededByBlankLine } : {}),
    tlText: source,
    englishGloss: null,
    unavailable: detectSourceLanguage(source) === 'en' ? 'translation' : 'gloss',
  };
}

// Does the text contain anything to read — a letter or digit? Punctuation-only
// fragments (". .", "—", "* * *") are skipped as batches and dropped as chunks.
export function hasReadableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

// One piece of a batch re-cut with shifted boundaries. `sentenceOffset` is the
// piece's first sentence relative to the batch's first sentence.
export interface ShiftedPiece {
  readonly text: string;
  readonly sentenceOffset: number;
}

// Clause punctuation a single long sentence can be cut at.
const CLAUSE_BREAK = /[,;:—–]\s+/g;

// Re-cut a failed batch for the one shifted-boundary retry an English source
// gets: a multi-sentence batch is split into single sentences; a single
// sentence is cut in two at the clause break nearest its middle. Returns null
// when there's no different way to cut it (a single sentence with no clause
// punctuation) — the caller then gives up rather than resending the same text.
export function shiftedPieces(sentences: ReadonlyArray<string>): ReadonlyArray<ShiftedPiece> | null {
  if (sentences.length > 1) {
    return sentences.map((text, i) => ({ text, sentenceOffset: i }));
  }
  const s = sentences[0];
  if (s === undefined) return null;
  const mid = s.length / 2;
  let best: number | null = null;
  for (const m of s.matchAll(CLAUSE_BREAK)) {
    const cut = m.index + m[0].length;
    if (cut >= s.length) continue;
    if (best === null || Math.abs(cut - mid) < Math.abs(best - mid)) best = cut;
  }
  if (best === null) return null;
  return [
    { text: s.slice(0, best).trim(), sentenceOffset: 0 },
    { text: s.slice(best).trim(), sentenceOffset: 0 },
  ];
}

// Replace one chunk (a retried unavailable chunk) with its freshly processed
// replacement(s), re-indexing everything after it. The reader's position stays
// on the same text: if it was past the replaced chunk it shifts by the growth.
export function replaceChunk(
  passage: Passage,
  chunkId: ChunkId,
  replacements: ReadonlyArray<Chunk>,
): Passage {
  const at = passage.chunks.findIndex((c) => c.id === chunkId);
  if (at < 0 || replacements.length === 0) return passage;
  const chunks = [
    ...passage.chunks.slice(0, at),
    ...replacements,
    ...passage.chunks.slice(at + 1),
  ].map((c, index) => (c.index === index ? c : { ...c, index }));
  const lastReadChunkIndex =
    passage.lastReadChunkIndex > at
      ? passage.lastReadChunkIndex + replacements.length - 1
      : passage.lastReadChunkIndex;
  return { ...passage, chunks, lastReadChunkIndex };
}

// One block of not-yet-reached text in the scrollable reading view: either
// already-translated chunks (jump straight there) or a source sentence that
// hasn't been translated yet (translate up to it, then jump).
export interface UpcomingItem {
  readonly key: string;
  readonly text: string;
  readonly target:
    | { readonly kind: 'chunk'; readonly index: number }
    | { readonly kind: 'sentence'; readonly sentenceIndex: number };
}

// The passage's source units, indexed by the `sentenceIndex` chunks carry:
// sentences for prose, lines for lyrics. Includes punctuation-only units (they
// hold their index even though they never become chunks).
export function passageUnits(passage: Passage): ReadonlyArray<string> {
  return passage.chunkingMode === 'lyrics'
    ? splitLyricsIntoLines(passage.rawText).map((l) => l.text)
    : splitSentences(passage.rawText);
}

// The opening words of a unit, for the scrubber's drag tooltip.
export function scrubPreview(text: string, maxWords = 8): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ') + '…';
}

// Where Continue / Resume picks up after a word lookup or grammar panel: if the
// panel is on a chunk other than the one being read, the first chunk of that
// chunk's sentence — tapping a word in an earlier sentence is how the reader
// says "from here" (the scrubber for rough positioning, a tap for fine). Null
// when the panel is on the current chunk or nothing is open: carry on as usual
// (resume the chunk, or advance in the manual modes).
export function panelRestartIndex(
  passage: Passage,
  currentChunkIndex: number,
  panelChunkId: ChunkId | null,
): number | null {
  if (panelChunkId === null) return null;
  const tapped = passage.chunks.find((c) => c.id === panelChunkId);
  if (!tapped || tapped.index === currentChunkIndex) return null;
  const first = passage.chunks.find((c) => c.sentenceIndex === tapped.sentenceIndex);
  return first ? first.index : null;
}

// Everything after the reader's current chunk, one item per sentence: first
// the processed chunks (grouped by sentence, so the rest of the current
// sentence comes first), then the raw source sentences/lines that haven't
// been processed yet. Punctuation-only sentences are left out — they're never
// processed into chunks (see hasReadableText).
export function upcomingItems(passage: Passage, currentChunkIndex: number): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  let group: Chunk[] = [];
  const flush = () => {
    const first = group[0];
    if (first) {
      items.push({
        key: `c${first.id}`,
        text: group.map((c) => c.tlText).join(' '),
        target: { kind: 'chunk', index: first.index },
      });
    }
    group = [];
  };
  for (const c of passage.chunks.slice(currentChunkIndex + 1)) {
    if (group[0] && group[0].sentenceIndex !== c.sentenceIndex) flush();
    group.push(c);
  }
  flush();

  const status = passage.processingStatus;
  if (status.kind === 'complete') return items;
  // Where processing stopped. An errored passage resumes after its last chunk
  // (same rule as retry-passage-processing).
  const processed =
    status.kind === 'in-progress'
      ? status.processedSentenceCount
      : passage.chunks.reduce((m, c) => Math.max(m, c.sentenceIndex + 1), 0);
  const units = passageUnits(passage);
  units.forEach((text, sentenceIndex) => {
    if (sentenceIndex < processed || !hasReadableText(text)) return;
    items.push({ key: `s${sentenceIndex}`, text, target: { kind: 'sentence', sentenceIndex } });
  });
  return items;
}

// Where a pending "start here" on sentence `sentenceIndex` lands: the first
// chunk at or after that sentence, once processing has covered it. Null while
// it's still being translated. A target that was skipped (punctuation only)
// lands on the next chunk; on a finished passage with nothing after it, the
// last chunk.
export function jumpLanding(passage: Passage, sentenceIndex: number): number | null {
  const covered =
    passage.processingStatus.kind === 'complete' ||
    (passage.processingStatus.kind === 'in-progress' &&
      passage.processingStatus.processedSentenceCount > sentenceIndex);
  if (!covered) return null;
  const at = passage.chunks.findIndex((c) => c.sentenceIndex >= sentenceIndex);
  if (at >= 0) return at;
  // Covered, but only skipped punctuation so far: keep waiting unless done.
  if (passage.processingStatus.kind === 'complete') return Math.max(0, passage.chunks.length - 1);
  return null;
}

// How many preceding chunks ride along with a gloss call. The spec said one or
// two, but in practice that's too few: in La invención de Morel, "Pasó, de ida
// y de vuelta" came right after "Se movió con esa libertad…" / "cuando estamos
// solos." — no gender marker in either — and was glossed "He passed". The
// feminine clue (adormecida) was four chunks back.
const CONTEXT_CHUNKS = 6;

// The chunks before `beforeIndex`, each as its Spanish plus the English gloss
// already shown to the reader, sent with a gloss call so the model can tell who
// a dropped subject refers to (item 8). The glosses matter as much as the
// Spanish: they carry the subject already settled ("She moved…"), which the
// Spanish ("Se movió…") often doesn't. Preceding text only — never anything
// later in the book. Untranslated English-source chunks are skipped.
export function precedingContext(
  chunks: ReadonlyArray<Chunk>,
  beforeIndex: number,
): ReadonlyArray<string> {
  return chunks
    .slice(0, Math.max(0, beforeIndex))
    .filter((c) => c.unavailable !== 'translation')
    .slice(-CONTEXT_CHUNKS)
    .map((c) => (c.englishGloss ? `${c.tlText} = ${c.englishGloss}` : c.tlText));
}

// === Word tap (items 7 and 9) ===

const WORD_RE = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+/g;

// The text to speak when a word at [start, end) is tapped: the word before, the
// word, and the word after, exactly as written (conjugated surface forms). A
// neighbour is only included when nothing but whitespace separates it from the
// tapped word, so the window never crosses punctuation or a sentence boundary.
// Stays within the chunk — at a chunk edge the missing side is simply dropped.
export function speechWindow(text: string, start: number, end: number): string {
  const words = [...text.matchAll(WORD_RE)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
  const k = words.findIndex((w) => w.start < end && start < w.end);
  const tapped = words[k];
  if (!tapped) return text.slice(start, end);
  const joins = (a: { end: number }, b: { start: number }) =>
    /^\s+$/.test(text.slice(a.end, b.start));
  const prev = words[k - 1];
  const next = words[k + 1];
  const from = prev && joins(prev, tapped) ? prev.start : tapped.start;
  const to = next && joins(tapped, next) ? next.end : tapped.end;
  return text.slice(from, to);
}

// Words inside a trigger phrase that aren't its frame verb: conjunctions,
// negation, pronouns, articles. What's left ("quería", "es", "creo") is the
// verb whose tense sets the frame.
const TRIGGER_FUNCTION_WORDS = new Set([
  'que', 'para', 'antes', 'de', 'sin', 'a', 'menos', 'con', 'tal', 'hasta', 'cuando',
  'aunque', 'en', 'caso', 'ojalá', 'quizás', 'quizá', 'vez', 'mientras', 'después',
  'fin', 'siempre', 'modo', 'manera', 'como', 'donde', 'no', 'lo', 'la', 'le', 'les',
  'me', 'te', 'se', 'nos', 'os', 'el', 'un', 'una', 'y', 'o', 'ni', 'si', 'porque',
  'así', 'luego', 'apenas',
]);

// Irregular conditional stems (tendría, haría, …) — not infinitive + ía.
const IRREGULAR_CONDITIONAL_STEMS = new Set([
  'tendr', 'podr', 'har', 'dir', 'sabr', 'querr', 'pondr', 'saldr', 'vendr', 'habr',
  'cabr', 'valdr',
]);

// A conditional is the whole infinitive + ía (gustaría, comería). Ending in
// -ría isn't enough: quería and prefería are imperfects of querer/preferir.
// -aría is always conditional (the -ar imperfect is -aba); -ería / -iría only
// when what's left is a known infinitive.
function isConditional(word: string): boolean {
  const m = word.toLowerCase().match(/^(.+)ía(s|mos|is|n)?$/);
  const stem = m?.[1];
  if (!stem) return false;
  if (IRREGULAR_CONDITIONAL_STEMS.has(stem) || stem.endsWith('ar')) return true;
  return isKnownLemma(stem);
}

function isPastSubjunctive(tense: SubjTense): boolean {
  return tense !== 'present' && tense !== 'perfect';
}

// Item 7: the note shown when the reader taps a trigger. Explains the
// tense relationship with the subjunctive it licenses: a present frame takes
// the present subjunctive (quiero que vengas), a past frame — preterite,
// imperfect, pluperfect or conditional — takes the imperfect (quería que
// vinieras). The frame is read off the paired verb's lexicon tense, which
// always agrees with the trigger in a well-formed sentence. Null when the tap
// isn't on a trigger, or the pair has no lexicon tense (pre-v6 chunks).
export function tenseNote(
  text: string,
  annotations: ReadonlyArray<MoodAnnotation> | undefined,
  start: number,
  end: number,
): string | null {
  if (!annotations) return null;
  const trigger = annotations.find((a) => a.role === 'trigger' && start < a.end && a.start < end);
  if (!trigger) return null;
  const verb = annotations.find(
    (a) => a.role === 'subjunctive_verb' && a.pairId === trigger.pairId && a.tense !== undefined,
  );
  if (!verb?.tense) return null;
  const triggerText = text.slice(trigger.start, trigger.end);
  const verbText = text.slice(verb.start, verb.end);
  const past = isPastSubjunctive(verb.tense);
  const words = triggerText.match(WORD_RE) ?? [];
  if (words[0]?.toLowerCase() === 'si') {
    return past
      ? `After "si", the past subjunctive "${verbText}" marks something hypothetical — it isn't (or wasn't) actually so.`
      : null;
  }
  const frameVerb = words.find((w) => !TRIGGER_FUNCTION_WORDS.has(w.toLowerCase()));
  if (frameVerb) {
    if (!past) return `"${frameVerb}" is present, so the subjunctive stays present: "${verbText}".`;
    const conditional = isConditional(frameVerb);
    return conditional
      ? `"${frameVerb}" is conditional, which counts as past, so the subjunctive shifts to "${verbText}".`
      : `"${frameVerb}" is past, so the subjunctive shifts to "${verbText}".`;
  }
  return past
    ? `The main verb is past, so after "${triggerText}" the subjunctive shifts to "${verbText}".`
    : `The main verb is present, so after "${triggerText}" the subjunctive is present: "${verbText}".`;
}
