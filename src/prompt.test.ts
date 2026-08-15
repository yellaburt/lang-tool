import { describe, expect, it } from 'vitest';
import { resolveMoodAnnotations } from './prompt';

describe('resolveMoodAnnotations', () => {
  const tl = 'No creo que llames antes de que él llegue';

  it('resolves spans to char offsets that slice back to the span', () => {
    const raw = [
      { span: 'No creo que', role: 'trigger', pair_id: 1 },
      { span: 'llames', role: 'subjunctive_verb', pair_id: 1 },
      { span: 'antes de que', role: 'trigger', pair_id: 2 },
      { span: 'llegue', role: 'subjunctive_verb', pair_id: 2 },
    ];
    const out = resolveMoodAnnotations(tl, raw);
    expect(out).toBeDefined();
    expect(out!).toHaveLength(4);
    for (const a of out!) {
      expect(tl.slice(a.start, a.end)).toBe(
        raw.find((r) => r.role === a.role && r.pair_id === a.pairId)!.span,
      );
    }
    expect(out!.map((a) => a.pairId)).toEqual([1, 1, 2, 2]);
  });

  it('drops annotations whose span is not found verbatim in tlText', () => {
    const out = resolveMoodAnnotations(tl, [
      { span: 'llames', role: 'subjunctive_verb', pair_id: 1 },
      { span: 'hablara', role: 'subjunctive_verb', pair_id: 2 }, // not present
    ]);
    expect(out).toHaveLength(1);
    expect(tl.slice(out![0]!.start, out![0]!.end)).toBe('llames');
  });

  it('drops malformed annotations (bad role, non-string span, non-numeric pair_id)', () => {
    const out = resolveMoodAnnotations(tl, [
      { span: 'llames', role: 'indicative', pair_id: 1 },
      { span: 42, role: 'trigger', pair_id: 1 },
      { span: 'llames', role: 'subjunctive_verb', pair_id: 'x' },
    ]);
    expect(out).toBeUndefined();
  });

  it('returns undefined for empty, missing, or non-array input', () => {
    expect(resolveMoodAnnotations(tl, [])).toBeUndefined();
    expect(resolveMoodAnnotations(tl, undefined)).toBeUndefined();
    expect(resolveMoodAnnotations(tl, 'nope')).toBeUndefined();
  });

  it('resolves a repeated span to its first occurrence', () => {
    const out = resolveMoodAnnotations('que venga, que se vaya', [
      { span: 'que', role: 'trigger', pair_id: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out![0]!.start).toBe(0);
    expect(out![0]!.end).toBe(3);
  });
});
