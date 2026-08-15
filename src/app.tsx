import type { ReactElement } from 'react';
import { useEffect, useReducer, useRef, useState } from 'react';
import {
  addPassage,
  assertNever,
  emptyLearnerState,
  IdGen,
  splitLyricsIntoLines,
  splitSentences,
} from './core';
import { splitAndGloss } from './llm';
import { loadLearnerState } from './storage';
import {
  AuthSession,
  ContentRefusedError,
  deletePassage as supabaseDeletePassage,
  callDefineWord,
  callExplainGrammar,
  callSuggestTitle,
  fetchLearnerState,
  fetchPassages,
  getCurrentSession,
  insertPassages,
  signInWithPassword,
  subscribeAuth,
  updatePassageContent,
  updatePassageMetadata,
  upsertReadingState,
  upsertSettings,
} from './supabase';
import {
  Chunk,
  ChunkId,
  ChunkingMode,
  EmphasisStyle,
  GrammarExplanation,
  LearnerState,
  MoodAnnotation,
  Passage,
  PassageId,
  ProcessingStatus,
  ReadingMode,
  ReviewEventId,
  Settings,
  ThemeName,
  VocabItemId,
  WordDefinition,
} from './types';
import {
  LibraryView,
  LoadingView,
  LoginView,
  PasteView,
  ProcessingView,
  ReadingView,
  SettingsModal,
} from './views';

// === Shell-layer ID generation ===

const ids: IdGen = {
  newPassageId: () => crypto.randomUUID() as PassageId,
  newChunkId: () => crypto.randomUUID() as ChunkId,
  newVocabItemId: () => crypto.randomUUID() as VocabItemId,
  newReviewEventId: () => crypto.randomUUID() as ReviewEventId,
};

// === App state ===

export type View = 'library' | 'paste' | 'processing' | 'reading';

export interface UiState {
  readonly view: View;
  readonly draftText: string;
  readonly currentPassageId: PassageId | null;
  // Listening mode adds an initial "hidden Spanish audio" phase before the
  // normal Spanish phase. This flag tracks whether that hidden phase is done.
  // In non-listening mode it stays implicitly satisfied (the speech effect
  // only consults it when listeningMode is on).
  readonly listeningHiddenSpanishDone: boolean;
  readonly spanishTtsDone: boolean;
  readonly englishTtsDone: boolean;
  readonly reReadDone: boolean;
  // Light AND reading mode. englishRevealed: the reader tapped "Show English"
  // for the current chunk (English is gated behind a deliberate action in both
  // modes). Resets on every chunk change. Neither mode auto-advances — the
  // reader always taps Continue / Show English to move on.
  readonly englishRevealed: boolean;
  // 'reading' mode only. The per-chunk state machine has two states: READING
  // (silent, text visible — readingSpeaking false) and SPEAKING (the chunk's
  // Spanish audio plays once after Continue, then advances — readingSpeaking
  // true). Only entered when readAloudOnAdvance is on. Resets on every chunk
  // change, so each chunk opens fresh in READING.
  readonly readingSpeaking: boolean;
  readonly isPaused: boolean;
  readonly processingError: string | null;
  readonly settingsOpen: boolean;
  // The passage currently being fetched in the background (one in flight at a
  // time). Lets the batch-fetch effect avoid kicking off concurrent fetches.
  readonly activeBatchFetch: PassageId | null;
  // Active word lookup, if any. Tapping a word sets this; dismissing clears
  // it. We pause audio and surface a definition panel below the chunk the
  // word came from.
  readonly wordLookup: WordLookupUiState | null;
  // Active grammar-panel lookup, if any. Mutually exclusive with wordLookup:
  // opening one closes the other so the user never juggles two bottom sheets
  // on mobile.
  readonly grammarPanel: GrammarPanelUiState | null;
}

export type WordLookupUiState =
  | { readonly kind: 'loading'; readonly word: string; readonly chunkId: ChunkId }
  | {
      readonly kind: 'ready';
      readonly word: string;
      readonly chunkId: ChunkId;
      readonly definition: WordDefinition;
    }
  | {
      readonly kind: 'error';
      readonly word: string;
      readonly chunkId: ChunkId;
      readonly message: string;
    };

export type GrammarPanelUiState =
  | { readonly kind: 'loading'; readonly chunkId: ChunkId }
  | {
      readonly kind: 'ready';
      readonly chunkId: ChunkId;
      readonly explanation: GrammarExplanation;
    }
  | {
      readonly kind: 'error';
      readonly chunkId: ChunkId;
      readonly message: string;
    };

export interface AppState {
  readonly learner: LearnerState;
  readonly ui: UiState;
}

export type AppAction =
  | { readonly kind: 'library-loaded'; readonly learner: LearnerState }
  | { readonly kind: 'set-draft'; readonly text: string }
  | { readonly kind: 'start-passage'; readonly passage: Passage }
  | { readonly kind: 'save-passage'; readonly passage: Passage }
  // Book ingestion: add many chapter passages (all in one folder) at once and
  // return to the library. Chapters process lazily when first opened.
  | { readonly kind: 'add-book'; readonly passages: ReadonlyArray<Passage> }
  | {
      readonly kind: 'refresh-passages';
      readonly passages: Readonly<Record<PassageId, Passage>>;
    }
  | {
      readonly kind: 'append-chunks';
      readonly passageId: PassageId;
      readonly chunks: ReadonlyArray<Chunk>;
      readonly processedSentenceCount: number;
    }
  | { readonly kind: 'start-batch-fetch'; readonly passageId: PassageId }
  | {
      readonly kind: 'mark-passage-error';
      readonly passageId: PassageId;
      readonly message: string;
    }
  | {
      readonly kind: 'skip-batch';
      readonly passageId: PassageId;
      readonly placeholderChunk: Chunk;
      readonly processedSentenceCount: number;
    }
  | { readonly kind: 'retry-passage-processing'; readonly passageId: PassageId }
  | { readonly kind: 'cancel-processing' }
  | { readonly kind: 'listening-hidden-spanish-finished'; readonly chunkId: ChunkId }
  | { readonly kind: 'spanish-tts-finished'; readonly chunkId: ChunkId }
  | { readonly kind: 'english-tts-finished'; readonly chunkId: ChunkId }
  | { readonly kind: 're-read-tts-finished'; readonly chunkId: ChunkId }
  | { readonly kind: 'advance' }
  | { readonly kind: 'go-back' }
  | { readonly kind: 'jump-to-start' }
  | { readonly kind: 'replay-current' }
  | { readonly kind: 'toggle-pause' }
  | { readonly kind: 'set-speech-pace'; readonly multiplier: number }
  | { readonly kind: 'set-read-pace'; readonly multiplier: number }
  | { readonly kind: 'toggle-english-tts' }
  | { readonly kind: 'set-english-speech-pace'; readonly multiplier: number }
  | { readonly kind: 'toggle-re-read' }
  | { readonly kind: 'set-re-read-voice'; readonly voiceName: string | null }
  | { readonly kind: 'set-re-read-pace'; readonly multiplier: number }
  | { readonly kind: 'toggle-re-read-alternates' }
  | { readonly kind: 'toggle-re-read-short-chunks' }
  | { readonly kind: 'set-reading-mode'; readonly mode: ReadingMode }
  | { readonly kind: 'toggle-read-aloud-on-advance' }
  // Light mode: reveal the English gloss for the current chunk. English is gated
  // behind this deliberate action; advancing still requires a Continue tap.
  | { readonly kind: 'reveal-english' }
  // Reading mode: toggle the English gloss for the current chunk on/off. Unlike
  // light mode's one-way reveal, the reader can hide it again.
  | { readonly kind: 'toggle-reading-english' }
  // Reading mode: the reader tapped Continue. From READING it either enters
  // SPEAKING (readAloudOnAdvance on) or advances immediately; during SPEAKING it
  // skips the rest of the audio and advances now.
  | { readonly kind: 'reading-continue' }
  | { readonly kind: 'open-passage'; readonly passageId: PassageId; readonly now: number }
  | { readonly kind: 'delete-passage'; readonly passageId: PassageId }
  | { readonly kind: 'rename-passage'; readonly passageId: PassageId; readonly title: string }
  | {
      readonly kind: 'move-passage';
      readonly passageId: PassageId;
      readonly folder: string | null;
      readonly subfolder: string | null;
    }
  | {
      // Rename a folder OR sub-folder. For 'folder' scope, every passage
      // whose folder===oldName is updated. For 'subfolder' scope, every
      // passage with folder===parentFolder AND subfolder===oldName is
      // updated. If newName matches an existing folder/subfolder, the
      // entries merge naturally — no error.
      readonly kind: 'rename-folder';
      readonly scope: 'folder' | 'subfolder';
      readonly oldName: string;
      readonly newName: string;
      readonly parentFolder?: string;
    }
  | {
      // "Remove" a folder = move all its passages out (folder→top-level,
      // subfolder→parent's root). The folders themselves are implicit so
      // there's nothing else to remove. No passage is deleted.
      readonly kind: 'delete-folder';
      readonly scope: 'folder' | 'subfolder';
      readonly name: string;
      readonly parentFolder?: string;
    }
  | {
      // Destructive: delete a folder AND every passage inside it. For 'folder'
      // scope this includes passages in its sub-folders (they still carry
      // folder===name). Permanent — there's no undo and Supabase free tier has
      // no point-in-time recovery, so callers must confirm first.
      readonly kind: 'delete-folder-contents';
      readonly scope: 'folder' | 'subfolder';
      readonly name: string;
      readonly parentFolder?: string;
    }
  | { readonly kind: 'go-to-library' }
  | { readonly kind: 'set-theme'; readonly theme: ThemeName }
  | { readonly kind: 'set-emphasis-style'; readonly style: EmphasisStyle }
  | { readonly kind: 'set-tts-voice'; readonly voiceName: string | null }
  | { readonly kind: 'set-english-tts-voice'; readonly voiceName: string | null }
  | { readonly kind: 'toggle-settings' }
  | { readonly kind: 'reset-to-paste' }
  | { readonly kind: 'lookup-word'; readonly word: string; readonly chunkId: ChunkId }
  | {
      readonly kind: 'lookup-word-result';
      readonly word: string;
      readonly chunkId: ChunkId;
      readonly definition: WordDefinition;
    }
  | {
      readonly kind: 'lookup-word-error';
      readonly word: string;
      readonly chunkId: ChunkId;
      readonly message: string;
    }
  | { readonly kind: 'dismiss-lookup' }
  | { readonly kind: 'request-grammar'; readonly chunkId: ChunkId }
  | {
      readonly kind: 'grammar-result';
      readonly chunkId: ChunkId;
      readonly explanation: GrammarExplanation;
    }
  | {
      readonly kind: 'grammar-error';
      readonly chunkId: ChunkId;
      readonly message: string;
    }
  | { readonly kind: 'dismiss-grammar' };

// The per-chunk speech/interaction flags, reset every time the current chunk
// changes (advance, go-back, jump, replay, open-passage, …). Kept in one place
// so the set can't drift across the ~10 reset sites.
function freshPhaseFlags() {
  return {
    listeningHiddenSpanishDone: false,
    spanishTtsDone: false,
    englishTtsDone: false,
    reReadDone: false,
    englishRevealed: false,
    readingSpeaking: false,
  } as const;
}

// Build an empty UiState; the learner state is supplied by the caller so the
// same shape works whether we're starting fresh or hydrating from storage.
function freshUiState(view: View): UiState {
  return {
    view,
    draftText: '',
    currentPassageId: null,
    ...freshPhaseFlags(),
    isPaused: false,
    processingError: null,
    settingsOpen: false,
    activeBatchFetch: null,
    wordLookup: null,
    grammarPanel: null,
  };
}

// Lazy init for useReducer: start with an empty learner state and the library
// view. The library is hydrated from Supabase by an effect on App mount once
// the user is authenticated.
function emptyInitialState(): AppState {
  return {
    learner: emptyLearnerState(),
    ui: freshUiState('library'),
  };
}

function updateSettings(learner: LearnerState, patch: Partial<Settings>): LearnerState {
  return { ...learner, settings: { ...learner.settings, ...patch } };
}

// Update the open passage's lastReadChunkIndex. No-op if no passage open.
function setCurrentChunkIndex(state: AppState, newIndex: number): AppState {
  const passageId = state.ui.currentPassageId;
  if (passageId === null) return state;
  const passage = state.learner.passages[passageId];
  if (!passage) return state;
  const clamped = Math.max(0, newIndex);
  return {
    ...state,
    learner: {
      ...state.learner,
      passages: {
        ...state.learner.passages,
        [passageId]: { ...passage, lastReadChunkIndex: clamped },
      },
    },
  };
}

// Move to the next chunk, resetting the per-chunk phase flags and clearing any
// pause. Shared by the 'advance' action and reading mode's Continue (both the
// immediate-advance and the skip-the-audio paths land here).
function advanceToNextChunk(state: AppState): AppState {
  const passageId = state.ui.currentPassageId;
  if (passageId === null) return state;
  const passage = state.learner.passages[passageId];
  if (!passage) return state;
  const next = setCurrentChunkIndex(state, passage.lastReadChunkIndex + 1);
  return {
    ...next,
    ui: {
      ...next.ui,
      ...freshPhaseFlags(),
      // Navigating to a new chunk resumes playback (matching jump-to-start).
      // In light mode this is what lets Continue clear a pause left behind by
      // a dismissed word lookup, so the next chunk's Spanish actually plays.
      isPaused: false,
      // Advancing dismisses any open lookup/grammar panel — it belongs to the
      // chunk we're leaving, so it'd be stale on the next one. This is also what
      // lets reading mode's in-panel Continue close the panel as it advances.
      wordLookup: null,
      grammarPanel: null,
    },
  };
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.kind) {
    case 'library-loaded': {
      const hasPassages = Object.keys(action.learner.passages).length > 0;
      // readingMode is sticky: the last mode the user picked is persisted in the
      // settings blob and synced across devices, so we use it as-loaded — sign-in
      // no longer reseeds it. (Falls back to defaultSettings()'s 'scaffolded' for
      // accounts that never picked one.)
      return {
        learner: action.learner,
        ui: {
          ...state.ui,
          view: hasPassages ? 'library' : 'paste',
        },
      };
    }

    case 'set-draft':
      // Typing clears any prior processing error.
      return {
        ...state,
        ui: { ...state.ui, draftText: action.text, processingError: null },
      };

    case 'start-passage': {
      // Caller (PasteView) built the empty passage (with chunks=[],
      // sentenceCount, status=in-progress). We add it to the library and go
      // straight to the processing view; the batch-fetch effect handles
      // the first batch.
      return {
        learner: addPassage(state.learner, action.passage),
        ui: {
          ...state.ui,
          view: 'processing',
          currentPassageId: action.passage.id,
          ...freshPhaseFlags(),
          isPaused: false,
          processingError: null,
        },
      };
    }

    case 'save-passage': {
      // Add the passage to the library and return to the library view. The
      // batch-fetch effect will process chunks in the background while the
      // user is in the library, because currentPassageId is set. When the
      // first batch lands, the view doesn't transition (see append-chunks).
      return {
        learner: addPassage(state.learner, action.passage),
        ui: {
          ...state.ui,
          view: 'library',
          currentPassageId: action.passage.id,
          draftText: '',
          ...freshPhaseFlags(),
          isPaused: false,
          processingError: null,
        },
      };
    }

    case 'add-book': {
      // Add all chapter passages and return to the library. currentPassageId is
      // cleared to null so NOTHING processes in the background — chapters are
      // processed lazily, only when the user opens one (see the batch-fetch
      // effect, which only ever processes the open passage).
      let learner = state.learner;
      for (const p of action.passages) {
        learner = addPassage(learner, p);
      }
      return {
        learner,
        ui: {
          ...state.ui,
          view: 'library',
          currentPassageId: null,
          draftText: '',
          ...freshPhaseFlags(),
          isPaused: false,
          processingError: null,
        },
      };
    }

    case 'refresh-passages': {
      // Replace the passage map with what Supabase reports, but never
      // clobber locally-newer state: if our client has MORE chunks than the
      // server's view (because we're mid-batch-processing and haven't
      // pushed yet), keep the client version. Client-only passages (not in
      // server response) are preserved too.
      const merged: Record<PassageId, Passage> = {};
      for (const [pid, sp] of Object.entries(action.passages)) {
        const id = pid as PassageId;
        const cp = state.learner.passages[id];
        merged[id] = cp && cp.chunks.length > sp.chunks.length ? cp : sp;
      }
      for (const [pid, cp] of Object.entries(state.learner.passages)) {
        const id = pid as PassageId;
        if (!(id in merged)) merged[id] = cp;
      }
      return {
        ...state,
        learner: { ...state.learner, passages: merged },
      };
    }

    case 'start-batch-fetch':
      return {
        ...state,
        ui: { ...state.ui, activeBatchFetch: action.passageId },
      };

    case 'append-chunks': {
      const existing = state.learner.passages[action.passageId];
      if (!existing) {
        // Passage was deleted while a fetch was in flight. Drop the result.
        return { ...state, ui: { ...state.ui, activeBatchFetch: null } };
      }
      const newChunks = [...existing.chunks, ...action.chunks];
      const isComplete = action.processedSentenceCount >= existing.sentenceCount;
      const newStatus: ProcessingStatus = isComplete
        ? { kind: 'complete' }
        : {
            kind: 'in-progress',
            processedSentenceCount: action.processedSentenceCount,
          };
      const updatedPassage: Passage = {
        ...existing,
        chunks: newChunks,
        processingStatus: newStatus,
      };
      // First batch landed for the passage we're currently waiting on:
      // transition processing → reading.
      const shouldTransition =
        state.ui.view === 'processing' &&
        state.ui.currentPassageId === action.passageId &&
        newChunks.length > 0;
      return {
        learner: {
          ...state.learner,
          passages: {
            ...state.learner.passages,
            [action.passageId]: updatedPassage,
          },
        },
        ui: {
          ...state.ui,
          view: shouldTransition ? 'reading' : state.ui.view,
          activeBatchFetch: null,
        },
      };
    }

    case 'mark-passage-error': {
      const existing = state.learner.passages[action.passageId];
      const learner = existing
        ? {
            ...state.learner,
            passages: {
              ...state.learner.passages,
              [action.passageId]: {
                ...existing,
                processingStatus: { kind: 'error', message: action.message } as ProcessingStatus,
              },
            },
          }
        : state.learner;
      // If the error happened during the FIRST batch (no chunks yet), kick
      // the user back to the paste view with the error message. Otherwise
      // (mid-passage error during background fetch) stay where we are and
      // surface the error inline on the reading view.
      const isFirstBatchError =
        existing !== undefined && existing.chunks.length === 0;
      return {
        learner,
        ui: {
          ...state.ui,
          view: isFirstBatchError ? 'paste' : state.ui.view,
          processingError: isFirstBatchError ? action.message : state.ui.processingError,
          activeBatchFetch: null,
        },
      };
    }

    case 'skip-batch': {
      // The translation service refused this batch. Insert a single
      // placeholder chunk so the reader sees something was skipped, advance
      // processedSentenceCount past the refused sentences, and keep the
      // passage status as in-progress so the next batch is still tried.
      const existing = state.learner.passages[action.passageId];
      if (!existing) {
        return { ...state, ui: { ...state.ui, activeBatchFetch: null } };
      }
      const newChunks = [...existing.chunks, action.placeholderChunk];
      const isComplete = action.processedSentenceCount >= existing.sentenceCount;
      const newStatus: ProcessingStatus = isComplete
        ? { kind: 'complete' }
        : {
            kind: 'in-progress',
            processedSentenceCount: action.processedSentenceCount,
          };
      const shouldTransition =
        state.ui.view === 'processing' &&
        state.ui.currentPassageId === action.passageId &&
        newChunks.length > 0;
      return {
        learner: {
          ...state.learner,
          passages: {
            ...state.learner.passages,
            [action.passageId]: {
              ...existing,
              chunks: newChunks,
              processingStatus: newStatus,
            },
          },
        },
        ui: {
          ...state.ui,
          view: shouldTransition ? 'reading' : state.ui.view,
          activeBatchFetch: null,
        },
      };
    }

    case 'retry-passage-processing': {
      // Reset an errored passage back to in-progress so the batch-fetch
      // effect picks it up again. The resume point is computed from how
      // many sentences are represented in existing chunks — we don't store
      // the count in the error state itself.
      const existing = state.learner.passages[action.passageId];
      if (!existing) return state;
      let processedSentenceCount = 0;
      if (existing.chunks.length > 0) {
        const maxIdx = existing.chunks.reduce(
          (m, c) => (c.sentenceIndex > m ? c.sentenceIndex : m),
          -1,
        );
        processedSentenceCount = Math.min(maxIdx + 1, existing.sentenceCount);
      }
      const newStatus: ProcessingStatus =
        processedSentenceCount >= existing.sentenceCount
          ? { kind: 'complete' }
          : { kind: 'in-progress', processedSentenceCount };
      return {
        learner: {
          ...state.learner,
          passages: {
            ...state.learner.passages,
            [action.passageId]: { ...existing, processingStatus: newStatus },
          },
        },
        ui: { ...state.ui, processingError: null },
      };
    }

    case 'cancel-processing':
      return {
        ...state,
        ui: { ...state.ui, view: 'paste' },
      };

    case 'listening-hidden-spanish-finished': {
      const passageId = state.ui.currentPassageId;
      if (passageId === null) return state;
      const passage = state.learner.passages[passageId];
      const chunk = passage?.chunks[passage.lastReadChunkIndex];
      if (!chunk || chunk.id !== action.chunkId) return state;
      return { ...state, ui: { ...state.ui, listeningHiddenSpanishDone: true } };
    }

    case 'spanish-tts-finished': {
      const passageId = state.ui.currentPassageId;
      if (passageId === null) return state;
      const passage = state.learner.passages[passageId];
      const chunk = passage?.chunks[passage.lastReadChunkIndex];
      if (!chunk || chunk.id !== action.chunkId) return state;
      return { ...state, ui: { ...state.ui, spanishTtsDone: true } };
    }

    case 'english-tts-finished': {
      const passageId = state.ui.currentPassageId;
      if (passageId === null) return state;
      const passage = state.learner.passages[passageId];
      const chunk = passage?.chunks[passage.lastReadChunkIndex];
      if (!chunk || chunk.id !== action.chunkId) return state;
      return { ...state, ui: { ...state.ui, englishTtsDone: true } };
    }

    case 're-read-tts-finished': {
      const passageId = state.ui.currentPassageId;
      if (passageId === null) return state;
      const passage = state.learner.passages[passageId];
      const chunk = passage?.chunks[passage.lastReadChunkIndex];
      if (!chunk || chunk.id !== action.chunkId) return state;
      return { ...state, ui: { ...state.ui, reReadDone: true } };
    }

    case 'advance':
      return advanceToNextChunk(state);

    case 'go-back': {
      const passageId = state.ui.currentPassageId;
      if (passageId === null) return state;
      const passage = state.learner.passages[passageId];
      if (!passage || passage.lastReadChunkIndex <= 0) return state;
      const next = setCurrentChunkIndex(state, passage.lastReadChunkIndex - 1);
      return {
        ...next,
        ui: {
          ...next.ui,
          ...freshPhaseFlags(),
          isPaused: false,
        },
      };
    }

    case 'jump-to-start': {
      const passageId = state.ui.currentPassageId;
      if (passageId === null) return state;
      const passage = state.learner.passages[passageId];
      if (!passage || passage.lastReadChunkIndex === 0) return state;
      const next = setCurrentChunkIndex(state, 0);
      return {
        ...next,
        ui: {
          ...next.ui,
          ...freshPhaseFlags(),
          isPaused: false,
        },
      };
    }

    case 'replay-current':
      return {
        ...state,
        ui: {
          ...state.ui,
          ...freshPhaseFlags(),
        },
      };

    case 'toggle-pause': {
      // Pause semantics: pause/resume the in-flight TTS in place. The speech
      // effects (in ReadingView) call synth.pause()/synth.resume() based on
      // isPaused, so toggling this flag freezes / continues the same
      // utterance mid-word. To advance, use the ▶ button or → arrow.
      //
      // Resuming (was paused → now playing) also dismisses any open word
      // lookup panel — Pete's "get out of my way and read" expectation.
      const willBePaused = !state.ui.isPaused;
      return {
        ...state,
        ui: {
          ...state.ui,
          isPaused: willBePaused,
          wordLookup: willBePaused ? state.ui.wordLookup : null,
          grammarPanel: willBePaused ? state.ui.grammarPanel : null,
        },
      };
    }

    case 'set-speech-pace':
      return {
        ...state,
        learner: updateSettings(state.learner, { speechPaceMultiplier: action.multiplier }),
      };

    case 'set-read-pace':
      return {
        ...state,
        learner: updateSettings(state.learner, { readPaceMultiplier: action.multiplier }),
      };

    case 'toggle-english-tts':
      return {
        ...state,
        learner: updateSettings(state.learner, {
          englishTtsEnabled: !state.learner.settings.englishTtsEnabled,
        }),
      };

    case 'set-english-speech-pace':
      return {
        ...state,
        learner: updateSettings(state.learner, {
          englishSpeechPaceMultiplier: action.multiplier,
        }),
      };

    case 'toggle-re-read':
      return {
        ...state,
        learner: updateSettings(state.learner, {
          reReadEnabled: !state.learner.settings.reReadEnabled,
        }),
      };

    case 'set-re-read-voice':
      return {
        ...state,
        learner: updateSettings(state.learner, { reReadVoice: action.voiceName }),
      };

    case 'set-re-read-pace':
      return {
        ...state,
        learner: updateSettings(state.learner, { reReadPaceMultiplier: action.multiplier }),
      };

    case 'toggle-re-read-short-chunks':
      return {
        ...state,
        learner: updateSettings(state.learner, {
          reReadShortChunks: !state.learner.settings.reReadShortChunks,
        }),
      };

    case 'set-reading-mode':
      // Sticky: persisted in the settings blob and synced across devices, and no
      // longer reseeded on sign-in (see 'library-loaded').
      return {
        ...state,
        learner: updateSettings(state.learner, { readingMode: action.mode }),
      };

    case 'toggle-read-aloud-on-advance':
      return {
        ...state,
        learner: updateSettings(state.learner, {
          readAloudOnAdvance: !state.learner.settings.readAloudOnAdvance,
        }),
      };

    case 'toggle-reading-english':
      // Reading mode: flip the gloss on/off. Clear isPaused so a pause left by a
      // dismissed word lookup doesn't linger (reading mode has no audio to gate,
      // but isPaused also blocks the SPEAKING/advance path, so keep it clean).
      return {
        ...state,
        ui: {
          ...state.ui,
          englishRevealed: !state.ui.englishRevealed,
          isPaused: false,
        },
      };

    case 'reading-continue': {
      // During SPEAKING, Continue skips the rest of the audio and advances now.
      if (state.ui.readingSpeaking) return advanceToNextChunk(state);
      // From READING: hide the English immediately, then branch on the setting.
      if (state.learner.settings.readAloudOnAdvance) {
        // Enter SPEAKING: text stays visible, English hidden, Spanish audio
        // plays once (the speech effect fires on readingSpeaking) then advances.
        // Clear isPaused so a dismissed-lookup pause can't block the audio, and
        // close any open lookup/grammar panel (Continue tapped from inside it).
        return {
          ...state,
          ui: {
            ...state.ui,
            englishRevealed: false,
            readingSpeaking: true,
            isPaused: false,
            wordLookup: null,
            grammarPanel: null,
          },
        };
      }
      // readAloudOnAdvance off: advance immediately (freshPhaseFlags hides the
      // English on the next chunk).
      return advanceToNextChunk(state);
    }

    case 'reveal-english':
      // Light mode: the reader asked to see the English. Clear isPaused so any
      // English audio actually plays — a prior word lookup may have left the
      // chunk paused. The chunk still won't advance until a Continue tap.
      return {
        ...state,
        ui: {
          ...state.ui,
          englishRevealed: true,
          isPaused: false,
        },
      };

    case 'toggle-re-read-alternates':
      return {
        ...state,
        learner: updateSettings(state.learner, {
          reReadAlternates: !state.learner.settings.reReadAlternates,
        }),
      };

    case 'open-passage': {
      const passage = state.learner.passages[action.passageId];
      if (!passage) return state;
      // Stamp lastOpenedAt so the library can sort by recency.
      const updated: Passage = { ...passage, lastOpenedAt: action.now };
      return {
        learner: {
          ...state.learner,
          passages: { ...state.learner.passages, [action.passageId]: updated },
        },
        ui: {
          ...state.ui,
          view: 'reading',
          currentPassageId: action.passageId,
          ...freshPhaseFlags(),
          isPaused: false,
          processingError: null,
        },
      };
    }

    case 'rename-passage': {
      const existing = state.learner.passages[action.passageId];
      if (!existing) return state;
      const cleanTitle = action.title.trim();
      if (cleanTitle.length === 0) return state;
      return {
        ...state,
        learner: {
          ...state.learner,
          passages: {
            ...state.learner.passages,
            [action.passageId]: { ...existing, title: cleanTitle },
          },
        },
      };
    }

    case 'move-passage': {
      const existing = state.learner.passages[action.passageId];
      if (!existing) return state;
      // Normalize: a subfolder requires a folder. If folder is null, force
      // subfolder null too (matches the DB CHECK constraint).
      const cleanFolder = action.folder?.trim() || null;
      const cleanSub = cleanFolder === null ? null : action.subfolder?.trim() || null;
      return {
        ...state,
        learner: {
          ...state.learner,
          passages: {
            ...state.learner.passages,
            [action.passageId]: {
              ...existing,
              folder: cleanFolder,
              subfolder: cleanSub,
            },
          },
        },
      };
    }

    case 'rename-folder': {
      const newName = action.newName.trim();
      if (newName.length === 0 || newName === action.oldName) return state;
      const updated: Record<PassageId, Passage> = {};
      for (const [id, p] of Object.entries(state.learner.passages)) {
        const pid = id as PassageId;
        if (action.scope === 'folder' && p.folder === action.oldName) {
          updated[pid] = { ...p, folder: newName };
        } else if (
          action.scope === 'subfolder' &&
          p.folder === action.parentFolder &&
          p.subfolder === action.oldName
        ) {
          updated[pid] = { ...p, subfolder: newName };
        } else {
          updated[pid] = p;
        }
      }
      return {
        ...state,
        learner: { ...state.learner, passages: updated },
      };
    }

    case 'delete-folder': {
      const updated: Record<PassageId, Passage> = {};
      for (const [id, p] of Object.entries(state.learner.passages)) {
        const pid = id as PassageId;
        if (action.scope === 'folder' && p.folder === action.name) {
          // Move out of folder entirely: top-level (both nulled).
          updated[pid] = { ...p, folder: null, subfolder: null };
        } else if (
          action.scope === 'subfolder' &&
          p.folder === action.parentFolder &&
          p.subfolder === action.name
        ) {
          // Move up one level: stay in parent folder, clear subfolder.
          updated[pid] = { ...p, subfolder: null };
        } else {
          updated[pid] = p;
        }
      }
      return {
        ...state,
        learner: { ...state.learner, passages: updated },
      };
    }

    case 'delete-folder-contents': {
      // Drop every passage in the folder (or sub-folder). The persistence
      // effect notices the removed ids and issues the Supabase deletes, same
      // path as delete-passage.
      const kept: Record<PassageId, Passage> = {};
      let deletedCurrent = false;
      for (const [id, p] of Object.entries(state.learner.passages)) {
        const pid = id as PassageId;
        const matches =
          action.scope === 'folder'
            ? p.folder === action.name
            : p.folder === action.parentFolder && p.subfolder === action.name;
        if (matches) {
          if (state.ui.currentPassageId === pid) deletedCurrent = true;
          continue;
        }
        kept[pid] = p;
      }
      return {
        learner: { ...state.learner, passages: kept },
        ui: deletedCurrent
          ? {
              ...state.ui,
              currentPassageId: null,
              ...freshPhaseFlags(),
              isPaused: false,
            }
          : state.ui,
      };
    }

    case 'delete-passage': {
      const passages = { ...state.learner.passages };
      delete passages[action.passageId];
      // If we were reading the deleted passage, also drop the reference.
      const isCurrent = state.ui.currentPassageId === action.passageId;
      return {
        learner: { ...state.learner, passages },
        ui: isCurrent
          ? {
              ...state.ui,
              currentPassageId: null,
              ...freshPhaseFlags(),
              isPaused: false,
            }
          : state.ui,
      };
    }

    case 'go-to-library':
      return {
        ...state,
        ui: {
          ...state.ui,
          view: 'library',
          currentPassageId: null,
          ...freshPhaseFlags(),
          isPaused: false,
        },
      };

    case 'set-theme':
      return {
        ...state,
        learner: updateSettings(state.learner, { theme: action.theme }),
      };

    case 'set-emphasis-style':
      return {
        ...state,
        learner: updateSettings(state.learner, { emphasisStyle: action.style }),
      };

    case 'set-tts-voice':
      return {
        ...state,
        learner: updateSettings(state.learner, { ttsVoice: action.voiceName }),
      };

    case 'set-english-tts-voice':
      return {
        ...state,
        learner: updateSettings(state.learner, { englishTtsVoice: action.voiceName }),
      };

    case 'toggle-settings':
      return {
        ...state,
        ui: { ...state.ui, settingsOpen: !state.ui.settingsOpen },
      };

    case 'reset-to-paste':
      return {
        ...state,
        ui: {
          ...state.ui,
          view: 'paste',
          draftText: '',
          currentPassageId: null,
          ...freshPhaseFlags(),
          isPaused: false,
          processingError: null,
        },
      };

    case 'lookup-word': {
      // Pause audio immediately and mark the lookup as in flight. The
      // effect (see ReadingView) calls callDefineWord and dispatches the
      // result. If the user clicks another word while one is loading, the
      // newer lookup replaces the older — the older one's result is
      // discarded by the result reducer's identity check.
      // Mutual exclusion: any open grammar panel goes away.
      return {
        ...state,
        ui: {
          ...state.ui,
          isPaused: true,
          wordLookup: { kind: 'loading', word: action.word, chunkId: action.chunkId },
          grammarPanel: null,
        },
      };
    }

    case 'lookup-word-result': {
      const lu = state.ui.wordLookup;
      if (
        !lu ||
        lu.kind !== 'loading' ||
        lu.word !== action.word ||
        lu.chunkId !== action.chunkId
      ) {
        return state; // Stale result for a lookup we already replaced/dismissed.
      }
      return {
        ...state,
        ui: {
          ...state.ui,
          wordLookup: {
            kind: 'ready',
            word: action.word,
            chunkId: action.chunkId,
            definition: action.definition,
          },
        },
      };
    }

    case 'lookup-word-error': {
      const lu = state.ui.wordLookup;
      if (
        !lu ||
        lu.kind !== 'loading' ||
        lu.word !== action.word ||
        lu.chunkId !== action.chunkId
      ) {
        return state;
      }
      return {
        ...state,
        ui: {
          ...state.ui,
          wordLookup: {
            kind: 'error',
            word: action.word,
            chunkId: action.chunkId,
            message: action.message,
          },
        },
      };
    }

    case 'dismiss-lookup':
      // Note: we don't auto-resume. Pete chose "stay paused" — user hits
      // Resume manually to continue reading.
      return { ...state, ui: { ...state.ui, wordLookup: null } };

    case 'request-grammar': {
      // Same shape as 'lookup-word': pause audio, mark in flight, clear the
      // other panel so only one bottom sheet is ever open.
      return {
        ...state,
        ui: {
          ...state.ui,
          isPaused: true,
          grammarPanel: { kind: 'loading', chunkId: action.chunkId },
          wordLookup: null,
        },
      };
    }

    case 'grammar-result': {
      const gp = state.ui.grammarPanel;
      if (!gp || gp.kind !== 'loading' || gp.chunkId !== action.chunkId) {
        return state; // Stale result.
      }
      return {
        ...state,
        ui: {
          ...state.ui,
          grammarPanel: {
            kind: 'ready',
            chunkId: action.chunkId,
            explanation: action.explanation,
          },
        },
      };
    }

    case 'grammar-error': {
      const gp = state.ui.grammarPanel;
      if (!gp || gp.kind !== 'loading' || gp.chunkId !== action.chunkId) {
        return state;
      }
      return {
        ...state,
        ui: {
          ...state.ui,
          grammarPanel: {
            kind: 'error',
            chunkId: action.chunkId,
            message: action.message,
          },
        },
      };
    }

    case 'dismiss-grammar':
      return { ...state, ui: { ...state.ui, grammarPanel: null } };

    default:
      return assertNever(action);
  }
}

function deriveTitle(text: string): string {
  const firstLine = text.split('\n')[0] ?? text;
  return firstLine.slice(0, 60).trim() || 'Untitled passage';
}

// === Batching constants ===
//
// SENTENCES_PER_BATCH: how many source sentences to send per LLM round-trip.
//   Smaller = faster first-batch latency, more total round-trips, AND
//   better LLM alignment (it has less to track per call). Dropped from 4
//   to 2 after observing the LLM occasionally smush two sentences' English
//   glosses into one chunk on complex multi-clause batches.
//
// PREFETCH_LEAD_CHUNKS: when the user is within this many chunks of the end
//   of currently-processed content, kick off the next batch in the background.
const SENTENCES_PER_BATCH = 2;
const PREFETCH_LEAD_CHUNKS = 3;

/**
 * Build an empty Passage skeleton from raw text. Used by PasteView's onStart
 * to dispatch a `start-passage` action. The passage starts with no chunks;
 * the batch-fetch effect will populate them lazily, batch by batch.
 *
 * Returns null if the input is empty or has no extractable sentences.
 */
export function buildEmptyPassage(
  rawText: string,
  options: { chunkingMode?: ChunkingMode; folder?: string; title?: string } = {},
): Passage | null {
  // Prose passages are trimmed; lyrics passages preserve internal blank lines
  // (the stanza-break signal) but still strip leading/trailing whitespace.
  const chunkingMode: ChunkingMode = options.chunkingMode ?? 'prose';
  const text =
    chunkingMode === 'lyrics' ? rawText.replace(/^\s+|\s+$/g, '') : rawText.trim();
  if (text.length === 0) return null;
  const sentenceCount =
    chunkingMode === 'lyrics'
      ? splitLyricsIntoLines(text).length
      : splitSentences(text).length;
  if (sentenceCount === 0) return null;
  const now = Date.now();
  return {
    id: ids.newPassageId(),
    // Book chapters pass an explicit title (the detected header / "Part N");
    // everything else derives a title from the first line.
    title: options.title ?? deriveTitle(text),
    language: 'es',
    rawText: text,
    chunks: [],
    createdAt: now,
    lastOpenedAt: now,
    lastReadChunkIndex: 0,
    sentenceCount,
    processingStatus: { kind: 'in-progress', processedSentenceCount: 0 },
    chunkingMode,
    folder: options.folder ?? null,
    subfolder: null,
  };
}

// === App component ===

type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';
type LibraryStatus = 'idle' | 'migrating' | 'loading' | 'ready' | 'error';

export function App() {
  const [state, dispatch] = useReducer(reducer, undefined, emptyInitialState);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading');
  const [libraryStatus, setLibraryStatus] = useState<LibraryStatus>('idle');
  const [libraryError, setLibraryError] = useState<string | null>(null);

  // Bootstrap auth state on mount + subscribe to changes (sign-in / sign-out
  // from another tab, magic-link redirect, etc.).
  useEffect(() => {
    let mounted = true;
    void getCurrentSession().then((s) => {
      if (!mounted) return;
      setSession(s);
      setAuthStatus(s ? 'authenticated' : 'unauthenticated');
    });
    const unsubscribe = subscribeAuth((s) => {
      setSession(s);
      setAuthStatus(s ? 'authenticated' : 'unauthenticated');
      // On sign-out, drop in-memory state so a fresh sign-in starts clean.
      if (!s) {
        dispatch({ kind: 'library-loaded', learner: emptyLearnerState() });
        setLibraryStatus('idle');
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // Once authenticated, load the library from Supabase. Runs once per (re)
  // authentication. We use a ref to guard against StrictMode double-mount and
  // deliberately exclude `libraryStatus` from the deps — otherwise the call
  // to setLibraryStatus('loading') inside this effect would re-trigger it
  // and the in-flight fetch would get cancelled before it finishes.
  const loadStartedRef = useRef(false);
  useEffect(() => {
    if (authStatus !== 'authenticated' || session === null) {
      loadStartedRef.current = false; // reset on sign-out
      return;
    }
    if (loadStartedRef.current) return;
    loadStartedRef.current = true;

    void (async () => {
      try {
        localStorage.removeItem('lang-tool:learner-state');
        setLibraryStatus('loading');
        const learner = await fetchLearnerState();
        dispatch({ kind: 'library-loaded', learner });
        setLibraryStatus('ready');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[lib] library load failed', err);
        setLibraryError(msg);
        setLibraryStatus('error');
      }
    })();
  }, [authStatus, session]);

  // Persist state.learner changes back to Supabase, diffing against the
  // previous snapshot so we only write what actually changed. The first
  // observation after a library-loaded action is the load result itself —
  // don't write it back.
  const prevLearnerRef = useRef<LearnerState | null>(null);
  useEffect(() => {
    if (libraryStatus !== 'ready' || session === null) return;
    const prev = prevLearnerRef.current;
    const curr = state.learner;
    if (prev === null) {
      prevLearnerRef.current = curr;
      return;
    }

    if (prev.settings !== curr.settings) {
      void upsertSettings(session.userId, curr.settings).catch((e) =>
        console.error('Settings save failed', e),
      );
    }

    // New passages are batched into a single insert — adding a book creates
    // dozens at once, and one multi-row insert beats N parallel POSTs. We don't
    // write a reading_state row for new passages: the passages_with_state view
    // coalesces a missing row to (0, created_at), and the first actual read
    // creates it via the lastReadChunkIndex branch below.
    const newPassages: Passage[] = [];
    for (const id of Object.keys(curr.passages) as PassageId[]) {
      const before = prev.passages[id];
      const after = curr.passages[id];
      if (!after) continue;
      if (!before) {
        newPassages.push(after);
        continue;
      }
      if (before === after) continue;
      if (
        before.chunks !== after.chunks ||
        before.processingStatus !== after.processingStatus ||
        before.title !== after.title ||
        before.sentenceCount !== after.sentenceCount
      ) {
        void updatePassageContent(after).catch((e) =>
          console.error('Passage update failed', e),
        );
      }
      if (
        before.folder !== after.folder ||
        before.subfolder !== after.subfolder
      ) {
        void updatePassageMetadata(after).catch((e) =>
          console.error('Passage folder update failed', e),
        );
      }
      if (
        before.lastReadChunkIndex !== after.lastReadChunkIndex ||
        before.lastOpenedAt !== after.lastOpenedAt
      ) {
        void upsertReadingState(
          session.userId,
          after.id,
          after.lastReadChunkIndex,
          after.lastOpenedAt,
        ).catch((e) => console.error('Reading state save failed', e));
      }
    }
    if (newPassages.length > 0) {
      void insertPassages(newPassages, session.userId).catch((e) =>
        console.error('Passage insert failed', e),
      );
    }
    for (const id of Object.keys(prev.passages) as PassageId[]) {
      if (!(id in curr.passages)) {
        void supabaseDeletePassage(id).catch((e) =>
          console.error('Passage delete failed', e),
        );
      }
    }

    prevLearnerRef.current = curr;
  }, [state.learner, libraryStatus, session]);

  // Suggest a Claude-generated title for any passage whose title is still
  // the deterministic first-line derivation. Each passage is attempted at
  // most once per app session (tracked in a ref). User-renamed passages
  // and passages that already have a non-default title are skipped.
  const titleAttemptedRef = useRef<Set<PassageId>>(new Set());
  useEffect(() => {
    if (libraryStatus !== 'ready' || session === null) return;
    for (const passage of Object.values(state.learner.passages)) {
      if (titleAttemptedRef.current.has(passage.id)) continue;
      titleAttemptedRef.current.add(passage.id);
      // Skip if the user already named it (heuristic: title differs from
      // the deterministic first-line derivation).
      if (passage.title !== deriveTitle(passage.rawText)) continue;
      void callSuggestTitle(passage.rawText)
        .then((suggested) => {
          if (suggested && suggested !== passage.title) {
            dispatch({
              kind: 'rename-passage',
              passageId: passage.id,
              title: suggested,
            });
          }
        })
        .catch((e) => {
          console.warn('Title suggestion failed:', e);
        });
    }
  }, [state.learner.passages, libraryStatus, session]);

  // Library auto-refresh: every time the user navigates to the library view,
  // re-fetch passages from Supabase so additions made on another device show
  // up without a manual reload. The merge in the `refresh-passages` reducer
  // never clobbers locally-newer state.
  const currentView = state.ui.view;
  useEffect(() => {
    if (currentView !== 'library') return;
    if (libraryStatus !== 'ready') return;
    let cancelled = false;
    (async () => {
      try {
        const passages = await fetchPassages();
        if (cancelled) return;
        dispatch({ kind: 'refresh-passages', passages });
      } catch (e) {
        // Silent: keep showing stale data rather than blocking the UI.
        console.warn('Library refresh failed', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentView, libraryStatus]);

  // Word-lookup effect: when a tap registers (wordLookup goes from null to
  // {kind:'loading'}), call the define-word Edge Function and dispatch the
  // result. The reducer ignores results that don't match the current
  // in-flight lookup, so racing taps are safe.
  const wordLookup = state.ui.wordLookup;
  const passages = state.learner.passages;
  useEffect(() => {
    if (!wordLookup || wordLookup.kind !== 'loading') return;
    let cancelled = false;
    void (async () => {
      // Find the chunk text + passageId for the chunkId. Search across all
      // loaded passages — usually the chunk is in the current passage but
      // the cross-passage search is cheap and avoids coupling to UI state.
      let chunkText: string | null = null;
      let passageIdForChunk: PassageId | null = null;
      for (const passage of Object.values(passages)) {
        const c = passage.chunks.find((ch) => ch.id === wordLookup.chunkId);
        if (c) {
          chunkText = c.tlText;
          passageIdForChunk = passage.id;
          break;
        }
      }
      if (chunkText === null) {
        if (!cancelled) {
          dispatch({
            kind: 'lookup-word-error',
            word: wordLookup.word,
            chunkId: wordLookup.chunkId,
            message: "Couldn't find that chunk.",
          });
        }
        return;
      }
      try {
        const definition = await callDefineWord(wordLookup.word, chunkText, {
          ...(passageIdForChunk !== null ? { passageId: passageIdForChunk } : {}),
          chunkId: wordLookup.chunkId,
        });
        if (cancelled) return;
        dispatch({
          kind: 'lookup-word-result',
          word: wordLookup.word,
          chunkId: wordLookup.chunkId,
          definition,
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        dispatch({
          kind: 'lookup-word-error',
          word: wordLookup.word,
          chunkId: wordLookup.chunkId,
          message: msg,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wordLookup, passages]);

  // Grammar-panel effect: when grammarPanel goes to {kind:'loading'}, look up
  // the chunk's Spanish + English text and call explain-grammar. Mirrors the
  // word-lookup effect above — same identity-check pattern guards against
  // stale results when the user rapidly opens grammar on different chunks.
  const grammarPanel = state.ui.grammarPanel;
  useEffect(() => {
    if (!grammarPanel || grammarPanel.kind !== 'loading') return;
    let cancelled = false;
    void (async () => {
      let spanishText: string | null = null;
      let englishGloss = '';
      let passageIdForChunk: PassageId | null = null;
      for (const passage of Object.values(passages)) {
        const c = passage.chunks.find((ch) => ch.id === grammarPanel.chunkId);
        if (c) {
          spanishText = c.tlText;
          englishGloss = c.englishGloss ?? '';
          passageIdForChunk = passage.id;
          break;
        }
      }
      if (spanishText === null) {
        if (!cancelled) {
          dispatch({
            kind: 'grammar-error',
            chunkId: grammarPanel.chunkId,
            message: "Couldn't find that chunk.",
          });
        }
        return;
      }
      try {
        const explanation = await callExplainGrammar(spanishText, englishGloss, {
          ...(passageIdForChunk !== null ? { passageId: passageIdForChunk } : {}),
          chunkId: grammarPanel.chunkId,
        });
        if (cancelled) return;
        dispatch({
          kind: 'grammar-result',
          chunkId: grammarPanel.chunkId,
          explanation,
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        dispatch({
          kind: 'grammar-error',
          chunkId: grammarPanel.chunkId,
          message: msg,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [grammarPanel, passages]);

  // Apply theme + emphasis-style as data attributes on the root element.
  // CSS variables and emphasis rules key off these.
  const theme = state.learner.settings.theme;
  const emphasisStyle = state.learner.settings.emphasisStyle;
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.setAttribute('data-emphasis', emphasisStyle);
  }, [emphasisStyle]);

  // Batch-fetch effect: drives lazy, incremental processing of a passage's
  // sentences. Fires whenever any of its inputs change. The guards inside
  // decide whether a fetch is actually needed; if not, the effect is a no-op.
  //
  // Triggers:
  //   - Just-created passage in processing view (no chunks yet) → fetch first batch.
  //   - Reading view, user nearing end of processed chunks → fetch next batch.
  //
  // Only one fetch is in flight at a time globally (via activeBatchFetch in UI
  // state). The completion handler dispatches `append-chunks` which clears
  // activeBatchFetch and lets the effect re-run for the next batch.
  useEffect(() => {
    const passageId = state.ui.currentPassageId;
    if (passageId === null) return;
    if (state.ui.activeBatchFetch !== null) return; // someone else is fetching
    const passage = state.learner.passages[passageId];
    if (!passage) return;
    if (passage.processingStatus.kind !== 'in-progress') return; // complete or error

    const processed = passage.processingStatus.processedSentenceCount;
    if (processed >= passage.sentenceCount) return; // shouldn't happen, defensive

    // Should we fetch right now? Yes if (a) we have no chunks yet (first
    // batch) or (b) the user is close enough to the end of processed chunks
    // to need more.
    const chunksRemaining =
      passage.chunks.length - passage.lastReadChunkIndex - 1;
    const needsFetch =
      passage.chunks.length === 0 || chunksRemaining <= PREFETCH_LEAD_CHUNKS;
    if (!needsFetch) return;

    // Compute the next batch from the local source split. Lyrics mode batches
    // one line at a time (so chunkingMode 'lyrics' overrides SENTENCES_PER_BATCH
    // to 1) and carries the stanza-break flag forward onto the first emitted
    // chunk; prose mode batches SENTENCES_PER_BATCH source sentences as one
    // joined string.
    const isLyrics = passage.chunkingMode === 'lyrics';
    let batchText: string;
    let batchUnitCount: number;
    let precededByBlankLine = false;
    if (isLyrics) {
      const lines = splitLyricsIntoLines(passage.rawText);
      const line = lines[processed];
      if (!line) return;
      batchText = line.text;
      batchUnitCount = 1;
      precededByBlankLine = line.precededByBlankLine;
    } else {
      const sentences = splitSentences(passage.rawText);
      const batchSentences = sentences.slice(processed, processed + SENTENCES_PER_BATCH);
      if (batchSentences.length === 0) return;
      batchText = batchSentences.join(' ');
      batchUnitCount = batchSentences.length;
    }
    const newProcessedCount = processed + batchUnitCount;
    // Sub-chunks inside this batch will get sentenceIndex 0..N-1 from the
    // LLM. Shift them up by the count of sentences already processed so the
    // global sentence indexing remains correct across batches.
    const sentenceOffset = processed;
    const startIndex = passage.chunks.length;

    dispatch({ kind: 'start-batch-fetch', passageId });

    void (async () => {
      try {
        const chunkDataRaw = await splitAndGloss(batchText, {
          chunkingMode: passage.chunkingMode,
        });
        // Filter out chunks whose Spanish text contains no letters or digits
        // (just punctuation like "." or "—"). Claude occasionally emits these
        // as standalone chunks; they have no audio or learning value and
        // render as empty rows.
        const chunkData = chunkDataRaw.filter((cg) =>
          /[\p{L}\p{N}]/u.test(cg.tlText),
        );
        if (chunkData.length === 0) {
          dispatch({
            kind: 'mark-passage-error',
            passageId,
            message: 'No chunks were produced for this batch.',
          });
          return;
        }
        // Lyrics: a source line is the atomic unit. Collapse the model's
        // response for this one line into exactly ONE chunk — the whole
        // Spanish line beside the whole line's English meaning. Alignment then
        // can't drift across sub-chunks no matter how the model split its
        // answer (the edge function is also told to return a single chunk, so
        // this is usually a 1-element join). sentenceIndex is the line's
        // global index, so each line renders as its own row with its own
        // stanza-break flag. Prose keeps per-sentence sub-chunking, shifting
        // the model's 0..N-1 sentenceIndex up by the count already processed.
        let newChunks: Chunk[];
        if (isLyrics) {
          // The line's sub-chunks are joined with a single space into one
          // chunk, so each sub-chunk's mood-annotation offsets shift by the
          // running length (tlText + 1 for the join space). In the usual case
          // the model returns a single sub-chunk and the shift is a no-op.
          const lyricMoods: MoodAnnotation[] = [];
          let moodOffset = 0;
          for (const cg of chunkData) {
            if (cg.moodAnnotations) {
              for (const a of cg.moodAnnotations) {
                lyricMoods.push({ ...a, start: a.start + moodOffset, end: a.end + moodOffset });
              }
            }
            moodOffset += cg.tlText.length + 1;
          }
          newChunks = [
            {
              id: ids.newChunkId(),
              passageId,
              index: startIndex,
              sentenceIndex: processed,
              tlText: chunkData.map((cg) => cg.tlText).join(' '),
              englishGloss: chunkData.map((cg) => cg.englishGloss).join(' '),
              audioRef: null,
              ...(precededByBlankLine ? { precededByBlankLine: true } : {}),
              ...(lyricMoods.length > 0 ? { moodAnnotations: lyricMoods } : {}),
            },
          ];
        } else {
          newChunks = chunkData.map((cg, i) => ({
            id: ids.newChunkId(),
            passageId,
            index: startIndex + i,
            sentenceIndex: sentenceOffset + cg.sentenceIndex,
            tlText: cg.tlText,
            englishGloss: cg.englishGloss,
            audioRef: null,
            ...(cg.moodAnnotations ? { moodAnnotations: cg.moodAnnotations } : {}),
          }));
        }
        dispatch({
          kind: 'append-chunks',
          passageId,
          chunks: newChunks,
          processedSentenceCount: newProcessedCount,
        });
      } catch (e) {
        if (e instanceof ContentRefusedError) {
          // The translation service refused this batch (likely on content
          // grounds). Insert a placeholder chunk so the reader sees the
          // skip, advance past the refused sentences, and let the next
          // batch try its luck — refusal is per-batch, not per-passage.
          const placeholderChunk: Chunk = {
            id: ids.newChunkId(),
            passageId,
            index: startIndex,
            sentenceIndex: sentenceOffset,
            tlText: '[…]',
            englishGloss: '[Skipped — translation service declined this section]',
            audioRef: null,
            ...(precededByBlankLine ? { precededByBlankLine: true } : {}),
          };
          dispatch({
            kind: 'skip-batch',
            passageId,
            placeholderChunk,
            processedSentenceCount: newProcessedCount,
          });
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        dispatch({ kind: 'mark-passage-error', passageId, message: msg });
      }
    })();
  }, [
    state.ui.currentPassageId,
    state.ui.activeBatchFetch,
    state.learner.passages,
    dispatch,
  ]);

  // Bootstrap gates: render different views during auth + library load.
  if (authStatus === 'loading') {
    return <LoadingView message="Checking your sign-in…" />;
  }
  if (authStatus === 'unauthenticated') {
    return (
      <LoginView
        onSignIn={async (username, password) => {
          await signInWithPassword(username, password);
        }}
      />
    );
  }
  if (libraryStatus === 'migrating') {
    return <LoadingView message="Uploading your existing library…" />;
  }
  if (libraryStatus === 'loading' || libraryStatus === 'idle') {
    return <LoadingView message="Loading your library…" />;
  }
  if (libraryStatus === 'error') {
    return (
      <LoadingView
        message={`Couldn't load library: ${libraryError ?? 'unknown error'}`}
      />
    );
  }

  let viewElement: ReactElement;
  switch (state.ui.view) {
    case 'library':
      viewElement = <LibraryView state={state} dispatch={dispatch} />;
      break;
    case 'paste':
      viewElement = <PasteView state={state} dispatch={dispatch} />;
      break;
    case 'processing':
      viewElement = <ProcessingView state={state} dispatch={dispatch} />;
      break;
    case 'reading':
      viewElement = <ReadingView state={state} dispatch={dispatch} />;
      break;
    default:
      return assertNever(state.ui.view);
  }

  return (
    <>
      {viewElement}
      {state.ui.settingsOpen && <SettingsModal state={state} dispatch={dispatch} />}
    </>
  );
}
