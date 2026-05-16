import type { ReactElement } from 'react';
import { useEffect, useReducer, useRef, useState } from 'react';
import { addPassage, assertNever, emptyLearnerState, IdGen, splitSentences } from './core';
import { splitAndGloss } from './llm';
import { loadLearnerState } from './storage';
import {
  AuthSession,
  deletePassage as supabaseDeletePassage,
  fetchLearnerState,
  getCurrentSession,
  insertPassage,
  signInWithPassword,
  subscribeAuth,
  updatePassageContent,
  upsertReadingState,
  upsertSettings,
} from './supabase';
import {
  Chunk,
  ChunkId,
  EmphasisStyle,
  LearnerState,
  Passage,
  PassageId,
  ProcessingStatus,
  ReviewEventId,
  Settings,
  ThemeName,
  VocabItemId,
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
  readonly spanishTtsDone: boolean;
  readonly englishTtsDone: boolean;
  readonly reReadDone: boolean;
  readonly isPaused: boolean;
  readonly processingError: string | null;
  readonly settingsOpen: boolean;
  // The passage currently being fetched in the background (one in flight at a
  // time). Lets the batch-fetch effect avoid kicking off concurrent fetches.
  readonly activeBatchFetch: PassageId | null;
}

export interface AppState {
  readonly learner: LearnerState;
  readonly ui: UiState;
}

export type AppAction =
  | { readonly kind: 'library-loaded'; readonly learner: LearnerState }
  | { readonly kind: 'set-draft'; readonly text: string }
  | { readonly kind: 'start-passage'; readonly passage: Passage }
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
  | { readonly kind: 'cancel-processing' }
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
  | { readonly kind: 'open-passage'; readonly passageId: PassageId; readonly now: number }
  | { readonly kind: 'delete-passage'; readonly passageId: PassageId }
  | { readonly kind: 'go-to-library' }
  | { readonly kind: 'set-theme'; readonly theme: ThemeName }
  | { readonly kind: 'set-emphasis-style'; readonly style: EmphasisStyle }
  | { readonly kind: 'set-tts-voice'; readonly voiceName: string | null }
  | { readonly kind: 'set-english-tts-voice'; readonly voiceName: string | null }
  | { readonly kind: 'toggle-settings' }
  | { readonly kind: 'reset-to-paste' };

// Build an empty UiState; the learner state is supplied by the caller so the
// same shape works whether we're starting fresh or hydrating from storage.
function freshUiState(view: View): UiState {
  return {
    view,
    draftText: '',
    currentPassageId: null,
    spanishTtsDone: false,
    englishTtsDone: false,
    reReadDone: false,
    isPaused: false,
    processingError: null,
    settingsOpen: false,
    activeBatchFetch: null,
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

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.kind) {
    case 'library-loaded': {
      const hasPassages = Object.keys(action.learner.passages).length > 0;
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
          spanishTtsDone: false,
          englishTtsDone: false,
          reReadDone: false,
          isPaused: false,
          processingError: null,
        },
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

    case 'cancel-processing':
      return {
        ...state,
        ui: { ...state.ui, view: 'paste' },
      };

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

    case 'advance': {
      const passageId = state.ui.currentPassageId;
      if (passageId === null) return state;
      const passage = state.learner.passages[passageId];
      if (!passage) return state;
      const next = setCurrentChunkIndex(state, passage.lastReadChunkIndex + 1);
      return {
        ...next,
        ui: {
          ...next.ui,
          spanishTtsDone: false,
          englishTtsDone: false,
          reReadDone: false,
        },
      };
    }

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
          spanishTtsDone: false,
          englishTtsDone: false,
          reReadDone: false,
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
          spanishTtsDone: false,
          englishTtsDone: false,
          reReadDone: false,
          isPaused: false,
        },
      };
    }

    case 'replay-current':
      return {
        ...state,
        ui: {
          ...state.ui,
          spanishTtsDone: false,
          englishTtsDone: false,
          reReadDone: false,
        },
      };

    case 'toggle-pause': {
      // Pause semantics: first press = stop auto-advance, stay on this chunk.
      // Second press = advance to next chunk and resume auto-flow.
      if (!state.ui.isPaused) {
        return { ...state, ui: { ...state.ui, isPaused: true } };
      }
      const passageId = state.ui.currentPassageId;
      if (passageId === null) {
        return { ...state, ui: { ...state.ui, isPaused: false } };
      }
      const passage = state.learner.passages[passageId];
      if (!passage) return { ...state, ui: { ...state.ui, isPaused: false } };
      const next = setCurrentChunkIndex(state, passage.lastReadChunkIndex + 1);
      return {
        ...next,
        ui: {
          ...next.ui,
          spanishTtsDone: false,
          englishTtsDone: false,
          reReadDone: false,
          isPaused: false,
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
          spanishTtsDone: false,
          englishTtsDone: false,
          reReadDone: false,
          isPaused: false,
          processingError: null,
        },
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
              spanishTtsDone: false,
              englishTtsDone: false,
              reReadDone: false,
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
          spanishTtsDone: false,
          englishTtsDone: false,
          reReadDone: false,
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
          spanishTtsDone: false,
          englishTtsDone: false,
          reReadDone: false,
          isPaused: false,
          processingError: null,
        },
      };

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
//   Smaller = faster first-batch latency, more total round-trips.
//   Larger = slower first-batch, more efficient overall.
//   4 is a reasonable starting point (~1 paragraph per batch).
//
// PREFETCH_LEAD_CHUNKS: when the user is within this many chunks of the end
//   of currently-processed content, kick off the next batch in the background.
const SENTENCES_PER_BATCH = 4;
const PREFETCH_LEAD_CHUNKS = 3;

/**
 * Build an empty Passage skeleton from raw text. Used by PasteView's onStart
 * to dispatch a `start-passage` action. The passage starts with no chunks;
 * the batch-fetch effect will populate them lazily, batch by batch.
 *
 * Returns null if the input is empty or has no extractable sentences.
 */
export function buildEmptyPassage(rawText: string): Passage | null {
  const text = rawText.trim();
  if (text.length === 0) return null;
  const sentences = splitSentences(text);
  if (sentences.length === 0) return null;
  const now = Date.now();
  return {
    id: ids.newPassageId(),
    title: deriveTitle(text),
    language: 'es',
    rawText: text,
    chunks: [],
    createdAt: now,
    lastOpenedAt: now,
    lastReadChunkIndex: 0,
    sentenceCount: sentences.length,
    processingStatus: { kind: 'in-progress', processedSentenceCount: 0 },
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

    for (const id of Object.keys(curr.passages) as PassageId[]) {
      const before = prev.passages[id];
      const after = curr.passages[id];
      if (!after) continue;
      if (!before) {
        void insertPassage(after, session.userId).catch((e) =>
          console.error('Passage insert failed', e),
        );
        void upsertReadingState(
          session.userId,
          after.id,
          after.lastReadChunkIndex,
          after.lastOpenedAt,
        ).catch((e) => console.error('Reading state save failed', e));
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
    for (const id of Object.keys(prev.passages) as PassageId[]) {
      if (!(id in curr.passages)) {
        void supabaseDeletePassage(id).catch((e) =>
          console.error('Passage delete failed', e),
        );
      }
    }

    prevLearnerRef.current = curr;
  }, [state.learner, libraryStatus, session]);

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

    // Compute the next batch from the local sentence split.
    const sentences = splitSentences(passage.rawText);
    const batchSentences = sentences.slice(processed, processed + SENTENCES_PER_BATCH);
    if (batchSentences.length === 0) return;
    const batchText = batchSentences.join(' ');
    const newProcessedCount = processed + batchSentences.length;
    // Sub-chunks inside this batch will get sentenceIndex 0..N-1 from the
    // LLM. Shift them up by the count of sentences already processed so the
    // global sentence indexing remains correct across batches.
    const sentenceOffset = processed;
    const startIndex = passage.chunks.length;

    dispatch({ kind: 'start-batch-fetch', passageId });

    void (async () => {
      try {
        const chunkData = await splitAndGloss(batchText);
        if (chunkData.length === 0) {
          dispatch({
            kind: 'mark-passage-error',
            passageId,
            message: 'No chunks were produced for this batch.',
          });
          return;
        }
        const newChunks: Chunk[] = chunkData.map((cg, i) => ({
          id: ids.newChunkId(),
          passageId,
          index: startIndex + i,
          sentenceIndex: sentenceOffset + cg.sentenceIndex,
          tlText: cg.tlText,
          englishGloss: cg.englishGloss,
          audioRef: null,
        }));
        dispatch({
          kind: 'append-chunks',
          passageId,
          chunks: newChunks,
          processedSentenceCount: newProcessedCount,
        });
      } catch (e) {
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
