import {
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
    reReadPaceMultiplier: 1.0,
    reReadAlternates: false,
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

function splitOnTerminalPunctuation(text: string): ReadonlyArray<string> {
  const result: string[] = [];
  let current = '';
  for (const c of text) {
    current += c;
    if (c === '.' || c === '!' || c === '?' || c === '…') {
      const trimmed = current.trim();
      if (trimmed.length > 0) result.push(trimmed);
      current = '';
    }
  }
  const tail = current.trim();
  if (tail.length > 0) result.push(tail);
  return result;
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
