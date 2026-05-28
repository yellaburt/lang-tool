export type PassageId = string & { readonly __brand: 'PassageId' };
export type ChunkId = string & { readonly __brand: 'ChunkId' };
export type VocabItemId = string & { readonly __brand: 'VocabItemId' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type ReviewEventId = string & { readonly __brand: 'ReviewEventId' };

export type LanguageCode = 'es' | 'en';

// Contextual word definition returned by the define-word Edge Function.
// `meaning` is always present; `verb` and `idiom` only when applicable.
export interface WordDefinition {
  readonly meaning: string;
  readonly verb?: VerbInfo;
  readonly idiom?: IdiomInfo;
  readonly notes?: string;
}

export interface VerbInfo {
  readonly infinitive: string;
  readonly infinitiveEnglish: string;
  readonly tense: string;
  readonly mood: string;
  readonly person: string;
}

export interface IdiomInfo {
  readonly expression: string;
  readonly meaning: string;
}

// Grammar explanation returned by the explain-grammar Edge Function for a
// whole Spanish chunk. When isUnremarkable is true, summary is empty and
// notes is empty — the chunk has nothing grammatically interesting for an
// intermediate learner.
export interface GrammarExplanation {
  readonly isUnremarkable: boolean;
  readonly summary: string;
  readonly notes: ReadonlyArray<GrammarNote>;
}

export interface GrammarNote {
  readonly topic: string;
  readonly explanation: string;
}

export type ProcessingStatus =
  | { readonly kind: 'in-progress'; readonly processedSentenceCount: number }
  | { readonly kind: 'complete' }
  | { readonly kind: 'error'; readonly message: string };

// 'prose' (default): split on sentence-ending punctuation, batch ~2 sentences
// per LLM call. 'lyrics': split on newlines, one line per LLM call, blank
// lines mark stanza breaks. Set once at creation; not user-editable after.
export type ChunkingMode = 'prose' | 'lyrics';

export interface Passage {
  readonly id: PassageId;
  readonly title: string;
  readonly language: LanguageCode;
  readonly rawText: string;
  readonly chunks: ReadonlyArray<Chunk>;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
  readonly lastReadChunkIndex: number;
  // Total source sentences (locally split, no LLM). chunks.length grows as
  // batches are processed; processingStatus tracks how many sentences are done.
  // For lyrics mode, "sentence" means "non-empty line".
  readonly sentenceCount: number;
  readonly processingStatus: ProcessingStatus;
  readonly chunkingMode: ChunkingMode;
  // Optional two-level library organization. null = top-level (no folder).
  // subfolder may only be set when folder is also set.
  readonly folder: string | null;
  readonly subfolder: string | null;
}

export interface Chunk {
  readonly id: ChunkId;
  readonly passageId: PassageId;
  readonly index: number;
  readonly sentenceIndex: number;
  readonly tlText: string;
  readonly englishGloss: string | null;
  readonly audioRef: string | null;
  // Lyrics mode only. Set on the first sub-chunk of any line that follows a
  // blank line (and on the first chunk of the passage if the source begins
  // with blank lines). Rendering uses this to draw a stanza break above.
  // Omitted in prose mode for backward compatibility.
  readonly precededByBlankLine?: boolean;
}

export type VocabItem =
  | {
      readonly kind: 'word';
      readonly id: VocabItemId;
      readonly lemma: string;
      readonly language: LanguageCode;
      readonly addedAt: number;
    }
  | {
      readonly kind: 'chunk';
      readonly id: VocabItemId;
      readonly chunkId: ChunkId;
      readonly addedAt: number;
    };

export interface SrsState {
  readonly vocabItemId: VocabItemId;
  readonly lastReviewedAt: number | null;
  readonly nextDueAt: number;
  readonly intervalDays: number;
  readonly ease: number;
  readonly exposureChunks: ReadonlyArray<ChunkId>;
  readonly lapseCount: number;
}

export type ReviewOutcome = 'got' | 'tip-of-tongue' | 'failed';

export interface ReviewEvent {
  readonly id: ReviewEventId;
  readonly vocabItemId: VocabItemId;
  readonly questionKind: Question['kind'];
  readonly outcome: ReviewOutcome;
  readonly responseTimeMs: number;
  readonly reviewedAt: number;
}

export type Question =
  | {
      readonly kind: 'mcq-meaning';
      readonly target: VocabItemId;
      readonly prompt: string;
      readonly options: ReadonlyArray<string>;
      readonly correctIndex: number;
    }
  | {
      readonly kind: 'cloze';
      readonly target: VocabItemId;
      readonly sentence: string;
      readonly answer: string;
      readonly options: ReadonlyArray<string> | null;
    }
  | {
      readonly kind: 'translate-tl-to-en';
      readonly target: VocabItemId;
      readonly prompt: string;
      readonly reference: string;
    }
  | {
      readonly kind: 'translate-en-to-tl';
      readonly target: VocabItemId;
      readonly prompt: string;
      readonly reference: string;
    };

export type RevealMode = 'cumulative' | 'parallel' | 'replacement';

export type SessionMode = 'intensive' | 'extensive' | 'audio-only' | 'drill-only';

export interface Session {
  readonly id: SessionId;
  readonly mode: SessionMode;
  readonly passageId: PassageId | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly reviewEventIds: ReadonlyArray<ReviewEventId>;
}

export type ThemeName =
  | 'white'
  | 'cream'
  | 'sepia'
  | 'light-gray'
  | 'dark'
  | 'high-contrast';

export type EmphasisStyle = 'color' | 'bold' | 'both' | 'none';

export interface Settings {
  readonly dialect: 'es-MX' | 'es-ES' | 'es-neutral';
  readonly questionFrequency: number;
  readonly revealMode: RevealMode;
  readonly ttsVoice: string | null;
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
  // When false (default), re-read skips chunks with ≤3 significant new words
  // (English-identical words and proper names don't count; each digit of a
  // numeric run counts as a separate word). Set true to always re-read.
  readonly reReadShortChunks: boolean;
  // Listening practice mode: each chunk runs in 3 phases —
  //   1. Spanish audio plays with all text hidden (pure listening test)
  //   2. Spanish text appears + Spanish audio plays again
  //   3. English text appears + English audio plays (if english TTS on)
  // Existing re-read still works on top of this if enabled, adding a 4th
  // phase.
  readonly listeningMode: boolean;
  readonly theme: ThemeName;
  readonly emphasisStyle: EmphasisStyle;
}

export interface LearnerState {
  readonly passages: Readonly<Record<PassageId, Passage>>;
  readonly vocabItems: Readonly<Record<VocabItemId, VocabItem>>;
  readonly srs: Readonly<Record<VocabItemId, SrsState>>;
  readonly reviews: ReadonlyArray<ReviewEvent>;
  readonly sessions: ReadonlyArray<Session>;
  readonly settings: Settings;
}
