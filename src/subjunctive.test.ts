import { describe, expect, it } from 'vitest';
import {
  analyzeToken,
  applyLexicon,
  isHomograph,
  matchSubjunctive,
  scanLexiconFacts,
  subjunctiveForms,
  unambiguousAnalysis,
  type CandidateAnnotation,
} from '../supabase/functions/_shared/subjunctive';

function forms(lemma: string, tense: string): string[] {
  return subjunctiveForms(lemma)
    .filter((f) => f.tense === tense)
    .map((f) => f.form);
}

// Build a candidate annotation from a span, the way resolveMoodAnnotations would.
function ann(
  text: string,
  span: string,
  role: CandidateAnnotation['role'],
  pairId: number,
  lemma?: string,
): CandidateAnnotation {
  const start = text.indexOf(span);
  if (start < 0) throw new Error(`span not in text: ${span}`);
  return { start, end: start + span.length, role, pairId, ...(lemma ? { lemma } : {}) };
}

describe('subjunctive generation', () => {
  it('regular -ar / -er / -ir present', () => {
    expect(forms('hablar', 'present')).toEqual(['hable', 'hables', 'hable', 'hablemos', 'habléis', 'hablen']);
    expect(forms('comer', 'present')).toEqual(['coma', 'comas', 'coma', 'comamos', 'comáis', 'coman']);
    expect(forms('vivir', 'present')).toEqual(['viva', 'vivas', 'viva', 'vivamos', 'viváis', 'vivan']);
  });

  it('imperfect in -ra and -se, with the stressed 1pl', () => {
    expect(forms('hablar', 'imperfect-ra')).toContain('habláramos');
    expect(forms('aullar', 'imperfect-ra')).toContain('aullaran');
    expect(forms('ser', 'imperfect-se')).toContain('fuésemos');
    expect(forms('vivir', 'imperfect-ra')).toContain('viviéramos');
    expect(forms('abrir', 'imperfect-ra')).toContain('abriera');
  });

  it('spelling changes', () => {
    expect(forms('buscar', 'present')[0]).toBe('busque');
    expect(forms('llegar', 'present')[0]).toBe('llegue');
    expect(forms('empezar', 'present')[0]).toBe('empiece');
    expect(forms('conocer', 'present')[0]).toBe('conozca');
    expect(forms('vencer', 'present')[0]).toBe('venza');
    expect(forms('coger', 'present')[0]).toBe('coja');
    expect(forms('seguir', 'present')[0]).toBe('siga');
    expect(forms('construir', 'present')[0]).toBe('construya');
    expect(forms('averiguar', 'present')[0]).toBe('averigüe');
  });

  it('stem changes, including the -ir nosotros change', () => {
    expect(forms('pensar', 'present')).toEqual(['piense', 'pienses', 'piense', 'pensemos', 'penséis', 'piensen']);
    expect(forms('dormir', 'present')).toContain('durmamos');
    expect(forms('sentir', 'present')).toContain('sintamos');
    expect(forms('pedir', 'present')[3]).toBe('pidamos');
    expect(forms('jugar', 'present')[0]).toBe('juegue');
    expect(forms('dormir', 'imperfect-ra')[0]).toBe('durmiera');
    expect(forms('enviar', 'present')[0]).toBe('envíe');
    expect(forms('aullar', 'present')[0]).toBe('aúlle');
  });

  it('irregulars and their compounds', () => {
    expect(forms('tener', 'present')[0]).toBe('tenga');
    expect(forms('tener', 'imperfect-ra')[0]).toBe('tuviera');
    expect(forms('mantener', 'imperfect-ra')[0]).toBe('mantuviera');
    expect(forms('decir', 'imperfect-ra')[3]).toBe('dijéramos');
    expect(forms('conducir', 'imperfect-ra')[0]).toBe('condujera');
    expect(forms('ir', 'present')[0]).toBe('vaya');
    expect(forms('dar', 'present')[0]).toBe('dé');
    expect(forms('leer', 'imperfect-ra')[0]).toBe('leyera');
    // mover is not a compound of ver.
    expect(forms('mover', 'present')[0]).toBe('mueva');
  });
});

describe('matchSubjunctive (the veto check)', () => {
  it('accepts real subjunctive forms of the named lemma', () => {
    expect(matchSubjunctive('hablen', 'hablar')?.tense).toBe('present');
    expect(matchSubjunctive('coman', 'comer')?.persons).toEqual(['3pl']);
    expect(matchSubjunctive('hable', 'hablar')?.persons).toEqual(['1sg', '3sg']);
    expect(matchSubjunctive('estuviera', 'estar')?.tense).toBe('imperfect-ra');
    expect(matchSubjunctive('fuésemos', 'ir')?.tense).toBe('imperfect-se');
    expect(matchSubjunctive('No me digas', 'decir')?.tense).toBe('present');
    expect(matchSubjunctive('descanse', 'descansar')).not.toBeNull();
  });

  it('accepts compound tenses with either lemma', () => {
    expect(matchSubjunctive('haya escrito', 'escribir')?.tense).toBe('perfect');
    expect(matchSubjunctive('hubiera sabido', 'saber')?.tense).toBe('pluperfect-ra');
    expect(matchSubjunctive('hubiese llegado', 'haber')?.tense).toBe('pluperfect-se');
    expect(matchSubjunctive('haya escrito', 'leer')).toBeNull();
  });

  it('rejects the observed false tags', () => {
    expect(matchSubjunctive('se recuperó', 'recuperar')).toBeNull();
    expect(matchSubjunctive('recuperó', 'recuperarse')).toBeNull();
    expect(matchSubjunctive('portas', 'portar')).toBeNull();
    expect(matchSubjunctive('aullarán', 'aullar')).toBeNull();
    expect(matchSubjunctive('llegaba', 'llegar')).toBeNull();
    expect(matchSubjunctive('estaban', 'estar')).toBeNull();
  });

  it('does not falsely veto unknown stem-changing verbs', () => {
    // "desplegar" isn't in the known list; its class is unknown, so every
    // class is tried.
    expect(matchSubjunctive('despliegue', 'desplegar')).not.toBeNull();
  });
});

describe('reverse lookup and homographs', () => {
  it('finds known forms without a lemma', () => {
    expect(unambiguousAnalysis('aullaran')?.tense).toBe('imperfect-ra');
    expect(unambiguousAnalysis('hablen')?.lemma).toBe('hablar');
    expect(unambiguousAnalysis('fueran')?.lemma).toBe('ser / ir');
  });

  it('refuses homographs', () => {
    for (const w of ['coma', 'vaya', 'cante', 'entre', 'tarde', 'tienda', 'una']) {
      expect(isHomograph(w)).toBe(true);
      expect(unambiguousAnalysis(w)).toBeNull();
    }
  });

  it('detects cross-verb collisions automatically', () => {
    // sentir subjunctive vs sentar indicative; creer subjunctive vs crear indicative.
    expect(analyzeToken('sienta').length).toBeGreaterThan(0);
    expect(isHomograph('sienta')).toBe(true);
    expect(isHomograph('crea')).toBe(true);
  });

  it('never treats future indicative as subjunctive', () => {
    expect(unambiguousAnalysis('aullarán')).toBeNull();
  });
});

describe('scanLexiconFacts', () => {
  it('reports aullaran as imperfect subjunctive, not future', () => {
    const facts = scanLexiconFacts('Temían que los perros aullaran toda la noche.');
    expect(facts.map((f) => f.token)).toEqual(['aullaran']);
    expect(facts[0]!.match.tense).toBe('imperfect-ra');
  });

  it('ignores indicative text and homographs', () => {
    expect(scanLexiconFacts('Cuando llegaba la comida, los seres humanos estaban callados.')).toEqual([]);
    expect(scanLexiconFacts('Me gustaba su cante por las mañanas.')).toEqual([]);
  });
});

describe('applyLexicon', () => {
  it('drops everything on cuando + indicative (item 1 negative case)', () => {
    const t = 'Cuando llegaba la comida, los seres humanos estaban callados y confiados y hermosos.';
    const { annotations } = applyLexicon(t, [
      ann(t, 'Cuando', 'trigger', 1),
      ann(t, 'llegaba', 'subjunctive_verb', 1, 'llegar'),
    ]);
    expect(annotations).toEqual([]);
  });

  it('vetoes confident false tags and logs them', () => {
    const t = 'cuando se recuperó del golpe';
    const { annotations, disagreements } = applyLexicon(t, [
      ann(t, 'cuando', 'trigger', 1),
      ann(t, 'se recuperó', 'subjunctive_verb', 1, 'recuperar'),
    ]);
    expect(annotations).toEqual([]);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0]!.lemma).toBe('recuperar');
  });

  it('keeps a valid pair and attaches lemma + tense', () => {
    const t = 'Mi madre quería que la abriera delante de ella';
    const { annotations } = applyLexicon(t, [
      ann(t, 'quería que', 'trigger', 1),
      ann(t, 'abriera', 'subjunctive_verb', 1, 'abrir'),
    ]);
    expect(annotations.map((a) => a.role)).toEqual(['trigger', 'subjunctive_verb']);
    expect(annotations[1]!.tense).toBe('imperfect-ra');
  });

  it('drops a trigger whose verb is gone or only possible (item 1 guard)', () => {
    const t = 'Me gustaba su cante por las mañanas';
    const { annotations } = applyLexicon(t, [
      ann(t, 'Me gustaba', 'trigger', 1),
      ann(t, 'cante', 'possible_subjunctive', 1, 'cantar'),
    ]);
    expect(annotations.map((a) => a.role)).toEqual(['possible_subjunctive']);
  });

  it('promotes an uncertain tag on an unambiguous form', () => {
    const t = 'ojalá hablen pronto';
    const { annotations } = applyLexicon(t, [ann(t, 'hablen', 'possible_subjunctive', 1, 'hablar')]);
    expect(annotations[0]!.role).toBe('subjunctive_verb');
  });

  it('tags an unambiguous form the model missed, and logs it', () => {
    const t = 'temían que los perros aullaran';
    const { annotations, disagreements } = applyLexicon(t, []);
    expect(annotations).toHaveLength(1);
    expect(t.slice(annotations[0]!.start, annotations[0]!.end)).toBe('aullaran');
    expect(disagreements[0]!.modelAnswer).toBe('not tagged as subjunctive');
  });
});
