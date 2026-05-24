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

export type ProcessingStatus =
  | { readonly kind: 'in-progress'; readonly processedSentenceCount: number }
  | { readonly kind: 'complete' }
  | { readonly kind: 'error'; readonly message: string };

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
  readonly sentenceCount: number;
  readonly processingStatus: ProcessingStatus;
}

export interface Chunk {
  readonly id: ChunkId;
  readonly passageId: PassageId;
  readonly index: number;
  readonly sentenceIndex: number;
  readonly tlText: string;
  readonly englishGloss: string | null;
  readonly audioRef: string | null;
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
