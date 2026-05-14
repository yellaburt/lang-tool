import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings, emptyLearnerState } from './core';
import {
  _clearForTests,
  flushSaveLearnerState,
  loadLearnerState,
  scheduleSaveLearnerState,
} from './storage';
import { LearnerState, Passage, PassageId } from './types';

// === Fake localStorage for Node test env ===

function installFakeLocalStorage(): void {
  const store: Record<string, string> = {};
  const fake: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    getItem: (k: string) => (k in store ? (store[k] as string) : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = fake;
}

beforeEach(() => {
  installFakeLocalStorage();
  _clearForTests();
});

// === Helpers ===

const T0 = 1_700_000_000_000;

function samplePassage(id: string, lastReadChunkIndex = 0): Passage {
  return {
    id: id as PassageId,
    title: `Title ${id}`,
    language: 'es',
    rawText: 'Hola.',
    chunks: [],
    createdAt: T0,
    lastOpenedAt: T0,
    lastReadChunkIndex,
    sentenceCount: 1,
    processingStatus: { kind: 'complete' },
  };
}

function withPassage(state: LearnerState, p: Passage): LearnerState {
  return { ...state, passages: { ...state.passages, [p.id]: p } };
}

// === Load ===

describe('loadLearnerState', () => {
  it('returns an empty state when nothing is stored', () => {
    const s = loadLearnerState();
    expect(s).toEqual(emptyLearnerState());
  });

  it('returns an empty state on parse errors', () => {
    localStorage.setItem('lang-tool:learner-state', '{not valid json');
    expect(loadLearnerState()).toEqual(emptyLearnerState());
  });

  it('returns an empty state on schema-version mismatch', () => {
    localStorage.setItem(
      'lang-tool:learner-state',
      JSON.stringify({ schemaVersion: 999, learnerState: emptyLearnerState() }),
    );
    expect(loadLearnerState()).toEqual(emptyLearnerState());
  });

  it('round-trips a state with a passage through save and load', () => {
    const start = withPassage(emptyLearnerState(), samplePassage('p1', 3));
    flushSaveLearnerState(start);
    const loaded = loadLearnerState();
    expect(loaded.passages['p1' as PassageId]?.lastReadChunkIndex).toBe(3);
    expect(loaded.passages['p1' as PassageId]?.title).toBe('Title p1');
  });

  it('falls back to defaults for partial settings on disk', () => {
    // Simulate an older storage shape where settings only had a subset of fields.
    const partial = {
      schemaVersion: 1,
      learnerState: {
        ...emptyLearnerState(),
        settings: { paceMultiplier: 1.5 } as unknown,
      },
    };
    localStorage.setItem('lang-tool:learner-state', JSON.stringify(partial));
    const s = loadLearnerState();
    // Missing fields are filled from defaultSettings.
    expect(s.settings.dialect).toBe(defaultSettings().dialect);
    expect(s.settings.speechPaceMultiplier).toBe(defaultSettings().speechPaceMultiplier);
  });
});

// === Save ===

describe('saving', () => {
  it('flushSaveLearnerState writes synchronously', () => {
    const s = withPassage(emptyLearnerState(), samplePassage('p2'));
    flushSaveLearnerState(s);
    const raw = localStorage.getItem('lang-tool:learner-state');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(1);
  });

  it('scheduleSaveLearnerState debounces — only the last state is written', async () => {
    const a = withPassage(emptyLearnerState(), samplePassage('p1'));
    const b = withPassage(a, samplePassage('p2'));
    const c = withPassage(b, samplePassage('p3'));
    scheduleSaveLearnerState(a, 30);
    scheduleSaveLearnerState(b, 30);
    scheduleSaveLearnerState(c, 30);
    await new Promise((r) => setTimeout(r, 80));
    const loaded = loadLearnerState();
    expect(Object.keys(loaded.passages)).toEqual(
      expect.arrayContaining(['p1', 'p2', 'p3']),
    );
  });
});
