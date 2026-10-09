// Tests for the September 2026 updates (task-lang-tool-updates-2026-09.md):
// untranslated-chunk handling, pronoun context, the speech window, the
// trigger tense note, and the reading-mode audio switch.
import { describe, expect, it } from 'vitest';
import { detectSourceLanguage } from '../supabase/functions/_shared/language';
import {
  hasReadableText,
  jumpLanding,
  lookupSpeechEnabled,
  upcomingItems,
  panelRestartIndex,
  passageUnits,
  scrubPreview,
  precedingContext,
  replaceChunk,
  shiftedPieces,
  speechWindow,
  tenseNote,
  upgradeLegacyPlaceholders,
} from './core';
import { buildUserMessage, resolveMoodAnnotations } from './prompt';
import { Chunk, ChunkId, MoodAnnotation, Passage, PassageId } from './types';

const pid = 'p1' as PassageId;

function chunk(i: number, sentenceIndex: number, tlText: string, extra: Partial<Chunk> = {}): Chunk {
  return {
    id: `c${i}` as ChunkId,
    passageId: pid,
    index: i,
    sentenceIndex,
    tlText,
    englishGloss: tlText === '[…]' ? '[Skipped — translation service declined this section]' : 'gloss',
    audioRef: null,
    ...extra,
  };
}

function passage(rawText: string, chunks: Chunk[], extra: Partial<Passage> = {}): Passage {
  return {
    id: pid,
    title: 't',
    language: 'es',
    rawText,
    chunks,
    createdAt: 0,
    lastOpenedAt: 0,
    lastReadChunkIndex: 0,
    sentenceCount: 4,
    processingStatus: { kind: 'complete' },
    chunkingMode: 'prose',
    folder: null,
    subfolder: null,
    ...extra,
  };
}

// Annotation over the first occurrence of `span` in `text`.
function ann(text: string, span: string, role: MoodAnnotation['role'], pairId: number, extra: Partial<MoodAnnotation> = {}): MoodAnnotation {
  const start = text.indexOf(span);
  return { start, end: start + span.length, role, pairId, ...extra };
}

describe('detectSourceLanguage', () => {
  it('tells Spanish from English', () => {
    expect(detectSourceLanguage('El perro corre por la calle y ladra.')).toBe('es');
    expect(detectSourceLanguage('The dog ran down the street and he barked.')).toBe('en');
    expect(detectSourceLanguage('¿Qué pasó?')).toBe('es');
  });
});

describe('upgradeLegacyPlaceholders', () => {
  const raw = 'Uno es aquí. Dos es allá. The man was killed in the war. Cuatro es fin.';

  it('recovers the source text of an old […] chunk and marks it unavailable', () => {
    const p = passage(raw, [
      chunk(0, 0, 'Uno es aquí.'),
      chunk(1, 1, '[…]'),
      chunk(2, 3, 'Cuatro es fin.'),
    ]);
    const up = upgradeLegacyPlaceholders(p);
    expect(up.chunks[1]!.tlText).toBe('Dos es allá. The man was killed in the war.');
    expect(up.chunks[1]!.englishGloss).toBeNull();
    expect(up.chunks[1]!.unavailable).toBeDefined();
  });

  it('classifies an English-only source as a missing translation', () => {
    const p = passage(raw, [chunk(0, 2, '[…]'), chunk(1, 3, 'Cuatro es fin.')]);
    expect(upgradeLegacyPlaceholders(p).chunks[0]).toMatchObject({
      tlText: 'The man was killed in the war.',
      unavailable: 'translation',
    });
  });

  it('leaves passages without placeholders untouched (same object)', () => {
    const p = passage(raw, [chunk(0, 0, 'Uno es aquí.')]);
    expect(upgradeLegacyPlaceholders(p)).toBe(p);
  });
});

describe('upcomingItems + jumpLanding', () => {
  const raw = 'Uno es aquí. Dos es allá y más. Tres. . . Cuatro es fin. Cinco.';
  // Sentences: 0 Uno, 1 Dos, 2 Tres, 3 ".", 4 ".", 5 Cuatro, 6 Cinco
  const cs = [
    chunk(0, 0, 'Uno es aquí.'),
    chunk(1, 1, 'Dos es allá'),
    chunk(2, 1, 'y más.'),
    chunk(3, 2, 'Tres.'),
  ];
  const p = passage(raw, cs, {
    sentenceCount: 7,
    processingStatus: { kind: 'in-progress', processedSentenceCount: 5 },
  });

  it('lists the rest of the current sentence, later chunks, then untranslated sentences', () => {
    const items = upcomingItems(p, 1);
    expect(items.map((i) => i.text)).toEqual(['y más.', 'Tres.', 'Cuatro es fin.', 'Cinco.']);
    expect(items.map((i) => i.target)).toEqual([
      { kind: 'chunk', index: 2 },
      { kind: 'chunk', index: 3 },
      { kind: 'sentence', sentenceIndex: 5 },
      { kind: 'sentence', sentenceIndex: 6 },
    ]);
  });

  it('lists nothing past the end of a finished passage', () => {
    expect(upcomingItems({ ...p, processingStatus: { kind: 'complete' } }, 3)).toEqual([]);
  });

  it('waits until the target is translated, then lands on its first chunk', () => {
    expect(jumpLanding(p, 5)).toBeNull();
    const more = {
      ...p,
      chunks: [...cs, chunk(4, 5, 'Cuatro es fin.')],
      processingStatus: { kind: 'in-progress' as const, processedSentenceCount: 7 },
    };
    expect(jumpLanding(more, 5)).toBe(4);
    // A skipped punctuation-only target lands on the next real chunk.
    expect(jumpLanding(more, 3)).toBe(4);
  });
});

describe('scrubber position', () => {
  const raw = 'Uno es aquí. Dos es allá y más. Tres. . . Cuatro es fin. Cinco.';
  const cs = [
    chunk(0, 0, 'Uno es aquí.'),
    chunk(1, 1, 'Dos es allá'),
    chunk(2, 1, 'y más.'),
    chunk(3, 2, 'Tres.'),
  ];
  const p = passage(raw, cs, {
    sentenceCount: 7,
    processingStatus: { kind: 'in-progress', processedSentenceCount: 5 },
  });

  it('counts every source unit, punctuation-only ones included', () => {
    expect(passageUnits(p)).toHaveLength(7);
  });

  it('previews a unit by its opening words', () => {
    expect(scrubPreview('Dos es allá y más.')).toBe('Dos es allá y más.');
    expect(scrubPreview('a b c d e f g h i j', 3)).toBe('a b c…');
    expect(scrubPreview('   ')).toBe('');
  });
});

describe('panelRestartIndex', () => {
  // Sentence 1 spans chunks 1–2; the reader is on chunk 3 (sentence 2).
  const cs = [
    chunk(0, 0, 'Uno es aquí.'),
    chunk(1, 1, 'Dos es allá'),
    chunk(2, 1, 'y más.'),
    chunk(3, 2, 'Tres.'),
  ];
  const p = passage('x', cs);

  it('restarts at the first chunk of the tapped sentence', () => {
    expect(panelRestartIndex(p, 3, cs[2]!.id)).toBe(1);
    expect(panelRestartIndex(p, 3, cs[1]!.id)).toBe(1);
    expect(panelRestartIndex(p, 3, cs[0]!.id)).toBe(0);
  });

  it('goes to the sentence start even from a later chunk of the current sentence', () => {
    expect(panelRestartIndex(p, 2, cs[1]!.id)).toBe(1);
  });

  it('leaves the usual behaviour alone for the current chunk or no panel', () => {
    expect(panelRestartIndex(p, 3, cs[3]!.id)).toBeNull();
    expect(panelRestartIndex(p, 3, null)).toBeNull();
    expect(panelRestartIndex(p, 3, 'nope' as ChunkId)).toBeNull();
  });
});

describe('hasReadableText', () => {
  it('treats punctuation-only batches as empty', () => {
    // Morel Part 4, sentences 153–154: a spaced-out ellipsis split into two
    // one-character "sentences", which stalled the passage.
    expect(hasReadableText('. .')).toBe(false);
    expect(hasReadableText('* * * —')).toBe(false);
    expect(hasReadableText('Hasta creo haberlos visto.')).toBe(true);
    expect(hasReadableText('1939.')).toBe(true);
  });
});

describe('shiftedPieces', () => {
  it('splits a multi-sentence batch into single sentences', () => {
    expect(shiftedPieces(['One.', 'Two.'])).toEqual([
      { text: 'One.', sentenceOffset: 0 },
      { text: 'Two.', sentenceOffset: 1 },
    ]);
  });

  it('cuts a single sentence at the clause break nearest its middle', () => {
    const pieces = shiftedPieces(['He came in, sat down by the fire, and then he wept for hours.']);
    expect(pieces).toHaveLength(2);
    expect(pieces!.map((p) => p.text).join(' ')).toBe(
      'He came in, sat down by the fire, and then he wept for hours.',
    );
  });

  it('gives up when there is no other way to cut', () => {
    expect(shiftedPieces(['He wept.'])).toBeNull();
  });
});

describe('replaceChunk', () => {
  it('replaces one chunk with several, re-indexing and keeping the reader on the same text', () => {
    const p = passage('x', [chunk(0, 0, 'a'), chunk(1, 1, 'b'), chunk(2, 2, 'c')], {
      lastReadChunkIndex: 2,
    });
    const out = replaceChunk(p, 'c1' as ChunkId, [chunk(9, 1, 'b1'), chunk(10, 1, 'b2')]);
    expect(out.chunks.map((c) => c.tlText)).toEqual(['a', 'b1', 'b2', 'c']);
    expect(out.chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(out.lastReadChunkIndex).toBe(3);
  });
});

describe('precedingContext', () => {
  // The real La invención de Morel failure: "Pasó, de ida y de vuelta" came out
  // as "He passed". The two chunks before it carry no gender at all; the clue
  // (adormecida) and the settled subject ("She …") are further back.
  const morel = [
    chunk(0, 43, 'un pañuelo, casi violeta, en la cabeza.', { englishGloss: 'a scarf, almost violet, on her head.' }),
    chunk(1, 44, 'Estuvo un rato mirando el mar,', { englishGloss: 'She stood for a while looking at the sea,' }),
    chunk(2, 44, 'como adormecida;', { englishGloss: 'as if drowsy;' }),
    chunk(3, 44, 'después se levantó y fue a buscar el libro.', { englishGloss: 'then she got up and went to look for the book.' }),
    chunk(4, 45, 'Se movió con esa libertad que tenemos', { englishGloss: 'She moved with that freedom that we have' }),
    chunk(5, 45, 'cuando estamos solos.', { englishGloss: 'when we are alone.' }),
    chunk(6, 46, 'Pasó, de ida y de vuelta,', { englishGloss: 'He passed' }),
  ];

  it('reaches back far enough to include the gender marker and the settled subject', () => {
    const ctx = precedingContext(morel, 6);
    expect(ctx).toHaveLength(6);
    expect(ctx.join('\n')).toContain('como adormecida; = as if drowsy;');
    expect(ctx.join('\n')).toContain('She moved');
  });

  it('never includes the chunk itself or anything later', () => {
    expect(precedingContext(morel, 6).join('\n')).not.toContain('Pasó');
    expect(precedingContext(morel, 0)).toEqual([]);
  });

  it('skips untranslated English-source chunks', () => {
    const cs = [
      chunk(0, 0, 'uno'),
      chunk(1, 1, 'English source', { unavailable: 'translation', englishGloss: null }),
      chunk(2, 2, 'dos'),
    ];
    expect(precedingContext(cs, 3)).toEqual(['uno = gloss', 'dos = gloss']);
  });
});

describe('speechWindow', () => {
  const t = 'Llegó tarde, pero nadie dijo nada.';
  const at = (w: string) => [t.indexOf(w), t.indexOf(w) + w.length] as const;

  it('speaks the word with its neighbours', () => {
    expect(speechWindow(t, ...at('nadie'))).toBe('pero nadie dijo');
  });
  it('drops the missing side at the start and end', () => {
    expect(speechWindow(t, ...at('Llegó'))).toBe('Llegó tarde');
    expect(speechWindow(t, ...at('nada'))).toBe('dijo nada');
  });
  it('stops at punctuation', () => {
    expect(speechWindow(t, ...at('tarde'))).toBe('Llegó tarde');
    expect(speechWindow(t, ...at('pero'))).toBe('pero nadie');
  });
});

describe('tenseNote', () => {
  it('explains a past frame', () => {
    const t = 'Mi madre quería que la abriera';
    const moods = [
      ann(t, 'quería que', 'trigger', 1),
      ann(t, 'abriera', 'subjunctive_verb', 1, { tense: 'imperfect-ra' }),
    ];
    expect(tenseNote(t, moods, t.indexOf('quería'), t.indexOf('quería') + 6)).toBe(
      '"quería" is past, so the subjunctive shifts to "abriera".',
    );
  });

  it('explains a present frame, and a conjunction-only trigger', () => {
    const t = 'quiero que vengas para que comas';
    const moods = [
      ann(t, 'quiero que', 'trigger', 1),
      ann(t, 'vengas', 'subjunctive_verb', 1, { tense: 'present' }),
      ann(t, 'para que', 'trigger', 2),
      ann(t, 'comas', 'subjunctive_verb', 2, { tense: 'present' }),
    ];
    expect(tenseNote(t, moods, 0, 5)).toContain('"quiero" is present');
    expect(tenseNote(t, moods, t.indexOf('para'), t.indexOf('para') + 4)).toContain(
      'The main verb is present',
    );
  });

  it('treats the conditional as a past frame', () => {
    const t = 'me gustaría que vinieras';
    const moods = [
      ann(t, 'me gustaría que', 'trigger', 1),
      ann(t, 'vinieras', 'subjunctive_verb', 1, { tense: 'imperfect-ra' }),
    ];
    expect(tenseNote(t, moods, 3, 11)).toContain('"gustaría" is conditional');
  });

  it('does not mistake -ería imperfects for conditionals', () => {
    const t = 'prefería que vinieras';
    const moods = [
      ann(t, 'prefería que', 'trigger', 1),
      ann(t, 'vinieras', 'subjunctive_verb', 1, { tense: 'imperfect-ra' }),
    ];
    expect(tenseNote(t, moods, 0, 8)).toBe('"prefería" is past, so the subjunctive shifts to "vinieras".');
  });

  it('is null off-trigger or without a lexicon tense (pre-v6 chunks)', () => {
    const t = 'quiero que vengas';
    const moods = [ann(t, 'quiero que', 'trigger', 1), ann(t, 'vengas', 'subjunctive_verb', 1)];
    expect(tenseNote(t, moods, 0, 6)).toBeNull();
    expect(tenseNote(t, undefined, 0, 6)).toBeNull();
  });
});

describe('lookupSpeechEnabled', () => {
  it('speaks in audio modes, and in Reading mode only with read-aloud on', () => {
    expect(lookupSpeechEnabled({ readingMode: 'reading', readAloudOnAdvance: true })).toBe(true);
    expect(lookupSpeechEnabled({ readingMode: 'reading', readAloudOnAdvance: false })).toBe(false);
    expect(lookupSpeechEnabled({ readingMode: 'reveal', readAloudOnAdvance: false })).toBe(true);
    expect(lookupSpeechEnabled({ readingMode: 'light', readAloudOnAdvance: false })).toBe(true);
  });
});

describe('prompt v6', () => {
  it('resolves possible_subjunctive and carries the lemma on verbs only', () => {
    const t = 'que se coma';
    const out = resolveMoodAnnotations(t, [
      { span: 'coma', role: 'possible_subjunctive', pair_id: 1, lemma: 'comer' },
      { span: 'que', role: 'trigger', pair_id: 2, lemma: 'nope' },
    ]);
    expect(out).toEqual([
      { start: 7, end: 11, role: 'possible_subjunctive', pairId: 1, lemma: 'comer' },
      { start: 0, end: 3, role: 'trigger', pairId: 2 },
    ]);
  });

  it('sends bare text when there is no context or facts', () => {
    expect(buildUserMessage('Hola.', [], '')).toBe('Hola.');
  });

  it('labels context and facts, with the text to process last', () => {
    const msg = buildUserMessage('Llegó.', ['Ella salió.'], '- "x": y');
    expect(msg.indexOf('PRECEDING CONTEXT')).toBeLessThan(msg.indexOf('LEXICON FACTS'));
    expect(msg.indexOf('LEXICON FACTS')).toBeLessThan(msg.indexOf('TEXT TO PROCESS'));
    expect(msg.endsWith('Llegó.\n>>>')).toBe(true);
  });
});
