import { emptyLearnerState, defaultSettings } from './core';
import { LearnerState } from './types';

const STORAGE_KEY = 'lang-tool:learner-state';
const CURRENT_SCHEMA = 1;

interface StorageBlob {
  readonly schemaVersion: number;
  readonly learnerState: LearnerState;
}

// Load persisted state, or fall back to a fresh empty state.
// Robust to: missing key, parse errors, schema-version mismatch,
// missing inner fields. Never throws.
export function loadLearnerState(): LearnerState {
  const fresh = emptyLearnerState();
  if (typeof localStorage === 'undefined') return fresh;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fresh;
    const parsed = JSON.parse(raw) as unknown;
    if (!isStorageBlob(parsed)) return fresh;
    if (parsed.schemaVersion !== CURRENT_SCHEMA) return fresh;
    // Fill in any missing top-level fields so older shapes still load.
    return normalizeLearnerState(parsed.learnerState);
  } catch {
    return fresh;
  }
}

// Schedule a debounced save. Repeated calls within `delayMs` collapse into a
// single write of the latest state. Errors (e.g. quota) are swallowed.
let saveTimer: number | null = null;

export function scheduleSaveLearnerState(state: LearnerState, delayMs: number = 1000): void {
  if (typeof localStorage === 'undefined') return;
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow(state);
  }, delayMs) as unknown as number;
}

// Flush any pending save synchronously. Useful before unload or in tests.
export function flushSaveLearnerState(state: LearnerState): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveNow(state);
}

function saveNow(state: LearnerState): void {
  try {
    const blob: StorageBlob = { schemaVersion: CURRENT_SCHEMA, learnerState: state };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
  } catch {
    // Quota exceeded, disabled, etc. Non-fatal; the in-memory state remains.
  }
}

function isStorageBlob(x: unknown): x is StorageBlob {
  return (
    typeof x === 'object' &&
    x !== null &&
    'schemaVersion' in x &&
    'learnerState' in x &&
    typeof (x as { schemaVersion: unknown }).schemaVersion === 'number' &&
    typeof (x as { learnerState: unknown }).learnerState === 'object'
  );
}

// Coerce a loaded LearnerState to a complete one. Any missing or wrong-typed
// top-level field falls back to the empty/default value. We trust the schema
// version to mean "shape matches"; this is a defensive belt regardless.
function normalizeLearnerState(s: unknown): LearnerState {
  const fresh = emptyLearnerState();
  if (typeof s !== 'object' || s === null) return fresh;
  const src = s as Record<string, unknown>;
  const passages = src['passages'];
  const vocabItems = src['vocabItems'];
  const srs = src['srs'];
  const reviews = src['reviews'];
  const sessions = src['sessions'];
  const settings = src['settings'];
  return {
    passages: isRecord(passages) ? (passages as LearnerState['passages']) : fresh.passages,
    vocabItems: isRecord(vocabItems)
      ? (vocabItems as LearnerState['vocabItems'])
      : fresh.vocabItems,
    srs: isRecord(srs) ? (srs as LearnerState['srs']) : fresh.srs,
    reviews: Array.isArray(reviews) ? (reviews as LearnerState['reviews']) : fresh.reviews,
    sessions: Array.isArray(sessions) ? (sessions as LearnerState['sessions']) : fresh.sessions,
    settings: isRecord(settings)
      ? { ...defaultSettings(), ...(settings as Partial<LearnerState['settings']>) }
      : fresh.settings,
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// === Test-only helpers ===
// Exposed so storage.test.ts can clear state between cases without touching
// localStorage directly. Not exported to production callers via index.
export function _clearForTests(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}
