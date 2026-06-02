import { describe, expect, it } from 'vitest';
import {
  addPassage,
  addVocabItem,
  applyReviewEvent,
  chunkPassage,
  compareChapters,
  defaultSettings,
  dueVocabItemIds,
  emptyLearnerState,
  findNextChapter,
  gradeQuestion,
  initialSrsState,
  isBookLikeFolder,
  IdGen,
  makeClozeQuestion,
  nextSrsState,
  parseChapterNumber,
  passagePercentRead,
  recordChunkExposure,
  recordExposure,
  shouldInterleaveQuestion,
  splitLyricsIntoLines,
} from './core';
import {
  Chunk,
  ChunkId,
  Passage,
  PassageId,
  Question,
  ReviewEvent,
  ReviewEventId,
  VocabItem,
  VocabItemId,
} from './types';

// --- Helpers ---

function makeIdGen(): IdGen {
  let n = 0;
  return {
    newPassageId: () => `p${++n}` as PassageId,
    newChunkId: () => `c${++n}` as ChunkId,
    newVocabItemId: () => `v${++n}` as VocabItemId,
    newReviewEventId: () => `r${++n}` as ReviewEventId,
  };
}

const T0 = 1_700_000_000_000; // arbitrary epoch ms
const DAY = 24 * 60 * 60 * 1000;

// --- Chunking ---

describe('chunkPassage', () => {
  const ids = makeIdGen();
  const pid = 'p1' as PassageId;

  it('splits Spanish on terminal punctuation', () => {
    const chunks = chunkPassage(pid, 'Hola. Me llamo Pete. Tengo gatos.', ids);
    expect(chunks.map((c) => c.tlText)).toEqual([
      'Hola.',
      'Me llamo Pete.',
      'Tengo gatos.',
    ]);
  });

  it('keeps ¿ and ¡ attached to the next chunk', () => {
    const chunks = chunkPassage(pid, '¿Cómo estás? ¡Bien, gracias!', ids);
    expect(chunks.map((c) => c.tlText)).toEqual(['¿Cómo estás?', '¡Bien, gracias!']);
  });

  it('handles ellipsis as terminal', () => {
    const chunks = chunkPassage(pid, 'Pues… no sé. Tal vez.', ids);
    expect(chunks.map((c) => c.tlText)).toEqual(['Pues…', 'no sé.', 'Tal vez.']);
  });

  it('captures trailing text without final punctuation', () => {
    const chunks = chunkPassage(pid, 'Una oración. Sin punto final', ids);
    expect(chunks.map((c) => c.tlText)).toEqual(['Una oración.', 'Sin punto final']);
  });

  it('returns empty array for empty input', () => {
    expect(chunkPassage(pid, '', ids)).toEqual([]);
    expect(chunkPassage(pid, '   \n  ', ids)).toEqual([]);
  });

  it('assigns sequential indices and passage id', () => {
    const chunks = chunkPassage(pid, 'Uno. Dos. Tres.', ids);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(chunks.every((c) => c.passageId === pid)).toBe(true);
  });

  it('leaves englishGloss and audioRef null', () => {
    const chunks = chunkPassage(pid, 'Uno.', ids);
    expect(chunks[0]!.englishGloss).toBeNull();
    expect(chunks[0]!.audioRef).toBeNull();
  });
});

describe('chunkPassage sub-sentence splitting', () => {
  const ids = makeIdGen();
  const pid = 'p1' as PassageId;

  it('leaves short sentences alone', () => {
    const chunks = chunkPassage(pid, 'Tengo gatos.', ids);
    expect(chunks.map((c) => c.tlText)).toEqual(['Tengo gatos.']);
  });

  it('splits a long sentence at a comma + coordinator', () => {
    const text =
      'El presidente llegó a la capital esta mañana, y los manifestantes lo recibieron con pancartas.';
    const chunks = chunkPassage(pid, text, ids);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((c) => c.tlText.startsWith('y '))).toBe(true);
  });

  it('splits at a subordinator like "porque"', () => {
    const text =
      'La economía sigue creciendo lentamente porque el banco central mantiene las tasas estables.';
    const chunks = chunkPassage(pid, text, ids);
    expect(chunks.length).toBe(2);
    expect(chunks[1]!.tlText.startsWith('porque')).toBe(true);
  });

  it('splits a long sentence and keeps each chunk under the word limit', () => {
    const text =
      'El nuevo proyecto de ley aumenta el salario mínimo en todo el país, pero los empresarios temen que esto reduzca la contratación de personal joven.';
    const chunks = chunkPassage(pid, text, ids);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    chunks.forEach((c) => {
      const words = c.tlText.split(/\s+/).filter((w) => w).length;
      expect(words).toBeLessThanOrEqual(15);
    });
  });

  it('recurses when both halves still exceed the limit', () => {
    const text =
      'El presidente llegó a la capital esta mañana, y los manifestantes lo recibieron con pancartas, pero la policía mantuvo el orden con calma.';
    const chunks = chunkPassage(pid, text, ids);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses to split below minWordsPerSubChunk on either side', () => {
    // Borderline case: short tail after comma would be a tiny chunk; leave whole.
    const text = 'Voy a la tienda muy rápido, ahora mismo.';
    const chunks = chunkPassage(pid, text, ids, { maxWords: 6, minWordsPerSubChunk: 4 });
    expect(chunks.map((c) => c.tlText)).toEqual(['Voy a la tienda muy rápido, ahora mismo.']);
  });

  it('respects custom maxWords', () => {
    const text = 'El gato come pescado, y el perro come carne.';
    const long = chunkPassage(pid, text, ids, { maxWords: 100, minWordsPerSubChunk: 2 });
    expect(long.length).toBe(1);
    const split = chunkPassage(pid, text, ids, { maxWords: 5, minWordsPerSubChunk: 2 });
    expect(split.length).toBeGreaterThan(1);
  });

  it('assigns sentenceIndex sequentially per source sentence', () => {
    const text = 'Hola. Tengo hambre. Vamos a comer.';
    const chunks = chunkPassage(pid, text, ids);
    expect(chunks.map((c) => c.sentenceIndex)).toEqual([0, 1, 2]);
  });

  it('gives all sub-chunks of one sentence the same sentenceIndex', () => {
    const text =
      'El presidente llegó a la capital esta mañana, y los manifestantes lo recibieron con pancartas. Empezó una nueva semana.';
    const chunks = chunkPassage(pid, text, ids);
    const sentence0 = chunks.filter((c) => c.sentenceIndex === 0);
    const sentence1 = chunks.filter((c) => c.sentenceIndex === 1);
    expect(sentence0.length).toBeGreaterThanOrEqual(2);
    expect(sentence1.length).toBe(1);
    expect(sentence1[0]!.tlText).toBe('Empezó una nueva semana.');
  });
});

// --- Lyrics splitting ---

describe('splitLyricsIntoLines', () => {
  it('emits one line per non-empty source line', () => {
    const out = splitLyricsIntoLines('Line one\nLine two\nLine three');
    expect(out.map((l) => l.text)).toEqual(['Line one', 'Line two', 'Line three']);
    expect(out.every((l) => !l.precededByBlankLine)).toBe(true);
  });

  it('flags lines after a blank line', () => {
    const out = splitLyricsIntoLines('A\nB\n\nC\nD');
    expect(out.map((l) => l.text)).toEqual(['A', 'B', 'C', 'D']);
    expect(out.map((l) => l.precededByBlankLine)).toEqual([false, false, true, false]);
  });

  it('treats multiple consecutive blank lines like one', () => {
    const out = splitLyricsIntoLines('A\n\n\n\nB');
    expect(out.map((l) => l.precededByBlankLine)).toEqual([false, true]);
  });

  it('flags the first line when the source begins with blank lines', () => {
    const out = splitLyricsIntoLines('\n\nA\nB');
    expect(out.map((l) => l.text)).toEqual(['A', 'B']);
    expect(out.map((l) => l.precededByBlankLine)).toEqual([true, false]);
  });

  it('trims whitespace per line and skips whitespace-only lines', () => {
    const out = splitLyricsIntoLines('  A  \n   \n B ');
    expect(out.map((l) => l.text)).toEqual(['A', 'B']);
    expect(out.map((l) => l.precededByBlankLine)).toEqual([false, true]);
  });

  it('handles CRLF line endings', () => {
    const out = splitLyricsIntoLines('A\r\n\r\nB');
    expect(out.map((l) => l.text)).toEqual(['A', 'B']);
    expect(out.map((l) => l.precededByBlankLine)).toEqual([false, true]);
  });

  it('returns empty array for empty / whitespace-only input', () => {
    expect(splitLyricsIntoLines('')).toEqual([]);
    expect(splitLyricsIntoLines('   \n  \n')).toEqual([]);
  });
});

// --- SRS ---

describe('nextSrsState', () => {
  const vid = 'v1' as VocabItemId;
  const fresh = initialSrsState(vid);

  it("'got' on a new item schedules 1 day out", () => {
    const next = nextSrsState(fresh, 'got', T0);
    expect(next.intervalDays).toBe(1);
    expect(next.nextDueAt).toBe(T0 + 1 * DAY);
    expect(next.ease).toBe(2.5);
    expect(next.lastReviewedAt).toBe(T0);
  });

  it("'got' on a 1-day interval grows by ease", () => {
    const one = { ...fresh, intervalDays: 1, ease: 2.5 };
    const next = nextSrsState(one, 'got', T0);
    expect(next.intervalDays).toBe(3); // round(1 * 2.5)
    expect(next.nextDueAt).toBe(T0 + 3 * DAY);
  });

  it("'tip-of-tongue' halves interval and nudges ease down", () => {
    const prev = { ...fresh, intervalDays: 10, ease: 2.5 };
    const next = nextSrsState(prev, 'tip-of-tongue', T0);
    expect(next.intervalDays).toBe(5);
    expect(next.ease).toBeCloseTo(2.35, 5);
  });

  it("'tip-of-tongue' floors interval at 1 day", () => {
    const next = nextSrsState(fresh, 'tip-of-tongue', T0);
    expect(next.intervalDays).toBe(1);
  });

  it("'failed' resets to 10 minutes, drops ease, increments lapses", () => {
    const prev = { ...fresh, intervalDays: 30, ease: 2.5, lapseCount: 2 };
    const next = nextSrsState(prev, 'failed', T0);
    expect(next.intervalDays).toBe(0);
    expect(next.nextDueAt).toBe(T0 + 10 * 60 * 1000);
    expect(next.ease).toBeCloseTo(2.2, 5);
    expect(next.lapseCount).toBe(3);
  });

  it('respects ease floor of 1.3', () => {
    const brittle = { ...fresh, ease: 1.4 };
    const next = nextSrsState(brittle, 'failed', T0);
    expect(next.ease).toBe(1.3);
  });
});

// --- Exposure ---

describe('recordExposure', () => {
  const vid = 'v1' as VocabItemId;
  const fresh = initialSrsState(vid);

  it('adds a chunk id the first time', () => {
    const next = recordExposure(fresh, 'c1' as ChunkId);
    expect(next.exposureChunks).toEqual(['c1']);
  });

  it('is idempotent on the same chunk', () => {
    const once = recordExposure(fresh, 'c1' as ChunkId);
    const twice = recordExposure(once, 'c1' as ChunkId);
    expect(twice).toBe(once); // same reference: no allocation
  });

  it('accumulates distinct chunks', () => {
    const a = recordExposure(fresh, 'c1' as ChunkId);
    const b = recordExposure(a, 'c2' as ChunkId);
    expect(b.exposureChunks).toEqual(['c1', 'c2']);
  });
});

// --- Grading ---

describe('gradeQuestion', () => {
  const vid = 'v1' as VocabItemId;

  it('grades mcq-meaning by index match', () => {
    const q: Question = {
      kind: 'mcq-meaning',
      target: vid,
      prompt: 'tomar',
      options: ['to take', 'to drink', 'to walk'],
      correctIndex: 1,
    };
    expect(gradeQuestion(q, { kind: 'mcq-meaning', selectedIndex: 1 })).toEqual({
      kind: 'auto',
      outcome: 'got',
    });
    expect(gradeQuestion(q, { kind: 'mcq-meaning', selectedIndex: 0 })).toEqual({
      kind: 'auto',
      outcome: 'failed',
    });
  });

  it('grades cloze with normalization (diacritics, case, punctuation)', () => {
    const q: Question = {
      kind: 'cloze',
      target: vid,
      sentence: 'Me llamo ___.',
      answer: 'Pedro',
      options: null,
    };
    expect(gradeQuestion(q, { kind: 'cloze', answer: 'pedro' })).toEqual({
      kind: 'auto',
      outcome: 'got',
    });
    expect(gradeQuestion(q, { kind: 'cloze', answer: 'Pédro!' })).toEqual({
      kind: 'auto',
      outcome: 'got',
    });
    expect(gradeQuestion(q, { kind: 'cloze', answer: 'Pablo' })).toEqual({
      kind: 'auto',
      outcome: 'failed',
    });
  });

  it('defers translation grading to the shell', () => {
    const q: Question = {
      kind: 'translate-tl-to-en',
      target: vid,
      prompt: 'Tengo hambre.',
      reference: "I'm hungry.",
    };
    const r = gradeQuestion(q, { kind: 'translate-tl-to-en', answer: 'I have hunger' });
    expect(r.kind).toBe('needs-judgment');
    if (r.kind === 'needs-judgment') {
      expect(r.userAnswer).toBe('I have hunger');
      expect(r.reference).toBe("I'm hungry.");
    }
  });

  it('throws on mismatched question/response kinds', () => {
    const q: Question = {
      kind: 'mcq-meaning',
      target: vid,
      prompt: 'x',
      options: ['a'],
      correctIndex: 0,
    };
    expect(() => gradeQuestion(q, { kind: 'cloze', answer: 'a' })).toThrow();
  });
});

// --- Cloze generation ---

describe('makeClozeQuestion', () => {
  const vid = 'v1' as VocabItemId;
  const cid = 'c1' as ChunkId;
  const chunk: Chunk = {
    id: cid,
    passageId: 'p1' as PassageId,
    index: 0,
    sentenceIndex: 0,
    tlText: 'Yo tomo café por la mañana.',
    englishGloss: null,
    audioRef: null,
  };

  it('blanks the target word in the sentence', () => {
    const q = makeClozeQuestion(chunk, vid, 'tomo');
    expect(q).not.toBeNull();
    expect(q!.kind).toBe('cloze');
    if (q && q.kind === 'cloze') {
      expect(q.sentence).toBe('Yo ___ café por la mañana.');
      expect(q.answer).toBe('tomo');
    }
  });

  it('returns null if the target is not in the chunk', () => {
    expect(makeClozeQuestion(chunk, vid, 'bebo')).toBeNull();
  });

  it('is case-insensitive when matching but preserves the target as the answer', () => {
    const q = makeClozeQuestion(chunk, vid, 'TOMO');
    expect(q).not.toBeNull();
    if (q && q.kind === 'cloze') expect(q.answer).toBe('TOMO');
  });

  it('respects word boundaries (no partial-word match)', () => {
    expect(makeClozeQuestion(chunk, vid, 'tom')).toBeNull();
  });
});

// --- Reducers ---

describe('state reducers', () => {
  it('addVocabItem inserts vocab and fresh SRS state', () => {
    const item: VocabItem = {
      kind: 'word',
      id: 'v1' as VocabItemId,
      lemma: 'tomar',
      language: 'es',
      addedAt: T0,
    };
    const next = addVocabItem(emptyLearnerState(), item);
    expect(next.vocabItems['v1' as VocabItemId]).toEqual(item);
    expect(next.srs['v1' as VocabItemId]?.intervalDays).toBe(0);
    expect(next.srs['v1' as VocabItemId]?.ease).toBe(2.5);
  });

  it('addPassage inserts the passage by id', () => {
    const passage: Passage = {
      id: 'p1' as PassageId,
      title: 'Test',
      language: 'es',
      rawText: 'Hola.',
      chunks: [],
      createdAt: T0,
      lastOpenedAt: T0,
      lastReadChunkIndex: 0,
      sentenceCount: 1,
      processingStatus: { kind: 'complete' },
      chunkingMode: 'prose',
      folder: null,
      subfolder: null,
    };
    const next = addPassage(emptyLearnerState(), passage);
    expect(next.passages['p1' as PassageId]).toEqual(passage);
  });

  it('applyReviewEvent updates SRS and appends review', () => {
    const item: VocabItem = {
      kind: 'word',
      id: 'v1' as VocabItemId,
      lemma: 'tomar',
      language: 'es',
      addedAt: T0,
    };
    const start = addVocabItem(emptyLearnerState(), item);
    const event: ReviewEvent = {
      id: 'r1' as ReviewEventId,
      vocabItemId: 'v1' as VocabItemId,
      questionKind: 'mcq-meaning',
      outcome: 'got',
      responseTimeMs: 1200,
      reviewedAt: T0,
    };
    const next = applyReviewEvent(start, event);
    expect(next.srs['v1' as VocabItemId]?.intervalDays).toBe(1);
    expect(next.reviews).toHaveLength(1);
    expect(next.reviews[0]).toEqual(event);
  });

  it('applyReviewEvent on unknown vocab is a no-op', () => {
    const start = emptyLearnerState();
    const event: ReviewEvent = {
      id: 'r1' as ReviewEventId,
      vocabItemId: 'v-missing' as VocabItemId,
      questionKind: 'mcq-meaning',
      outcome: 'got',
      responseTimeMs: 1000,
      reviewedAt: T0,
    };
    expect(applyReviewEvent(start, event)).toBe(start);
  });

  it('recordChunkExposure updates the SRS exposureChunks for the item', () => {
    const item: VocabItem = {
      kind: 'word',
      id: 'v1' as VocabItemId,
      lemma: 'tomar',
      language: 'es',
      addedAt: T0,
    };
    const start = addVocabItem(emptyLearnerState(), item);
    const next = recordChunkExposure(start, 'v1' as VocabItemId, 'c1' as ChunkId);
    expect(next.srs['v1' as VocabItemId]?.exposureChunks).toEqual(['c1']);
  });
});

// --- Due selection ---

describe('dueVocabItemIds', () => {
  it('returns items whose nextDueAt is at or before now, sorted by due time', () => {
    let s = emptyLearnerState();
    const v1: VocabItem = { kind: 'word', id: 'v1' as VocabItemId, lemma: 'a', language: 'es', addedAt: T0 };
    const v2: VocabItem = { kind: 'word', id: 'v2' as VocabItemId, lemma: 'b', language: 'es', addedAt: T0 };
    const v3: VocabItem = { kind: 'word', id: 'v3' as VocabItemId, lemma: 'c', language: 'es', addedAt: T0 };
    s = addVocabItem(s, v1);
    s = addVocabItem(s, v2);
    s = addVocabItem(s, v3);
    // Manually rewrite due times to test ordering.
    s = {
      ...s,
      srs: {
        ['v1' as VocabItemId]: { ...s.srs['v1' as VocabItemId]!, nextDueAt: T0 - 1000 },
        ['v2' as VocabItemId]: { ...s.srs['v2' as VocabItemId]!, nextDueAt: T0 + 1000 },
        ['v3' as VocabItemId]: { ...s.srs['v3' as VocabItemId]!, nextDueAt: T0 - 5000 },
      },
    };
    expect(dueVocabItemIds(s, T0)).toEqual(['v3', 'v1']);
  });
});

// --- Session flow ---

describe('shouldInterleaveQuestion', () => {
  it('fires when the threshold is hit', () => {
    const s = defaultSettings();
    expect(shouldInterleaveQuestion(s.questionFrequency - 1, s)).toBe(false);
    expect(shouldInterleaveQuestion(s.questionFrequency, s)).toBe(true);
    expect(shouldInterleaveQuestion(s.questionFrequency + 1, s)).toBe(true);
  });
});

// --- Book folders (Task 7) ---

function makeChapter(
  id: string,
  title: string,
  opts: Partial<Passage> = {},
): Passage {
  return {
    id: id as PassageId,
    title,
    language: 'es',
    rawText: 'x',
    chunks: [],
    createdAt: T0,
    lastOpenedAt: T0,
    lastReadChunkIndex: 0,
    sentenceCount: 1,
    processingStatus: { kind: 'complete' },
    chunkingMode: 'prose',
    folder: 'Book',
    subfolder: null,
    ...opts,
  };
}

describe('parseChapterNumber', () => {
  it('parses the header shapes the splitter emits', () => {
    expect(parseChapterNumber('Chapter 12')).toBe(12);
    expect(parseChapterNumber('Chapter IV: The Return')).toBe(4);
    expect(parseChapterNumber('Capítulo 3 — El final')).toBe(3);
    expect(parseChapterNumber('Part 7')).toBe(7);
    expect(parseChapterNumber('1. The Beginning')).toBe(1);
    expect(parseChapterNumber('2: Otra cosa')).toBe(2);
    expect(parseChapterNumber('5')).toBe(5);
    expect(parseChapterNumber('xiv')).toBe(14);
  });
  it('returns null for titles with no recognizable number', () => {
    expect(parseChapterNumber('Introduction')).toBeNull();
    expect(parseChapterNumber('A Quiet Morning')).toBeNull();
    expect(parseChapterNumber('Article')).toBeNull();
  });
});

describe('compareChapters', () => {
  it('orders by chapter number with intros first', () => {
    const chapters = [
      makeChapter('c', 'Chapter 10'),
      makeChapter('a', 'Chapter 2'),
      makeChapter('intro', 'Prologue'),
      makeChapter('b', 'Chapter 1'),
    ];
    const sorted = [...chapters].sort(compareChapters).map((p) => p.title);
    expect(sorted).toEqual([
      'Prologue',
      'Chapter 1',
      'Chapter 2',
      'Chapter 10',
    ]);
  });
});

describe('isBookLikeFolder', () => {
  it('is true for ≥5 mostly-numbered chapters', () => {
    const book = [
      makeChapter('i', 'Introduction'), // unnumbered, tolerated
      makeChapter('1', 'Chapter 1'),
      makeChapter('2', 'Chapter 2'),
      makeChapter('3', 'Chapter 3'),
      makeChapter('4', 'Chapter 4'),
    ];
    expect(isBookLikeFolder(book)).toBe(true);
  });
  it('detects a book of bare-number chapters (Mother Night style)', () => {
    const book = ['1', '2', '3', '4', '5', '6'].map((t) => makeChapter(t, t));
    expect(isBookLikeFolder(book)).toBe(true);
  });
  it('is false for too few passages', () => {
    const few = ['Chapter 1', 'Chapter 2'].map((t) => makeChapter(t, t));
    expect(isBookLikeFolder(few)).toBe(false);
  });
  it('is false for a folder of descriptively-titled articles', () => {
    const articles = [
      'Spain raises rates',
      'A new museum opens',
      'Local team wins',
      'Weather turns cold',
      'Election results in',
    ].map((t, i) => makeChapter(`a${i}`, t));
    expect(isBookLikeFolder(articles)).toBe(false);
  });
});

describe('findNextChapter', () => {
  const book = [
    makeChapter('c1', 'Chapter 1'),
    makeChapter('c2', 'Chapter 2'),
    makeChapter('c10', 'Chapter 10'),
  ];
  it('returns the next chapter by chapter number, not array order', () => {
    // c10 is listed before c2 here; sorting must still give 1 → 2 → 10.
    const shuffled = [book[0]!, book[2]!, book[1]!];
    expect(findNextChapter(shuffled, 'c1' as PassageId)?.title).toBe(
      'Chapter 2',
    );
    expect(findNextChapter(shuffled, 'c2' as PassageId)?.title).toBe(
      'Chapter 10',
    );
  });
  it('returns null on the last chapter', () => {
    expect(findNextChapter(book, 'c10' as PassageId)).toBeNull();
  });
  it('stays within the same folder', () => {
    const mixed = [
      makeChapter('a1', 'Chapter 1', { folder: 'Book A' }),
      makeChapter('a2', 'Chapter 2', { folder: 'Book A' }),
      makeChapter('b1', 'Chapter 1', { folder: 'Book B' }),
    ];
    expect(findNextChapter(mixed, 'a1' as PassageId)?.id).toBe('a2');
    // a2 is last in Book A even though Book B has more chapters.
    expect(findNextChapter(mixed, 'a2' as PassageId)).toBeNull();
  });
  it('returns null for a top-level (folderless) passage', () => {
    const loose = [makeChapter('x', 'Chapter 1', { folder: null })];
    expect(findNextChapter(loose, 'x' as PassageId)).toBeNull();
  });
});

describe('passagePercentRead', () => {
  it('is 100 for a complete, fully-read passage', () => {
    const p = makeChapter('p', 'Chapter 1', {
      sentenceCount: 4,
      chunks: [{ sentenceIndex: 0 } as Chunk, { sentenceIndex: 2 } as Chunk],
      lastReadChunkIndex: 2, // one past the last chunk
      processingStatus: { kind: 'complete' },
    });
    expect(passagePercentRead(p)).toBe(100);
  });
  it('reflects partial progress by sentence position', () => {
    const p = makeChapter('p', 'Chapter 1', {
      sentenceCount: 10,
      chunks: [{ sentenceIndex: 0 } as Chunk, { sentenceIndex: 5 } as Chunk],
      lastReadChunkIndex: 1,
      processingStatus: { kind: 'in-progress', processedSentenceCount: 6 },
    });
    expect(passagePercentRead(p)).toBe(50);
  });
  it('is 0 before any chunks land', () => {
    const p = makeChapter('p', 'Chapter 1', {
      sentenceCount: 8,
      chunks: [],
      processingStatus: { kind: 'in-progress', processedSentenceCount: 0 },
    });
    expect(passagePercentRead(p)).toBe(0);
  });
});
