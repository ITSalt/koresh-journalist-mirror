import { describe, expect, it } from 'vitest';
import { PlanV1Schema, type PlanV1 } from '../../src/plan/schema.js';
import { DATE, validPlan } from './fixtures.js';

const parse = (p: unknown) => PlanV1Schema.safeParse(p);
const messages = (p: unknown) => {
  const r = parse(p);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};
const withSlots = (f: (s: PlanV1['slots']) => void): PlanV1 => {
  const p = validPlan();
  f(p.slots);
  return p;
};

describe('plan.json v1 schema', () => {
  it('accepts a valid plan and a plan with zero slots', () => {
    expect(parse(validPlan()).success).toBe(true);
    expect(parse({ ...validPlan(), slots: [] }).success).toBe(true);
  });

  it('requires version 1 and a calendar date', () => {
    expect(parse({ ...validPlan(), version: 2 }).success).toBe(false);
    expect(parse({ ...validPlan(), date: '2026-13-01' }).success).toBe(false);
  });

  it('accepts an at with or without seconds on the plan date at +03:00', () => {
    const p = withSlots((s) => (s[0]!.at = `${DATE}T09:00+03:00`));
    expect(parse(p).success).toBe(true);
  });

  it.each([
    ['UTC offset', `${DATE}T06:00:00Z`],
    ['another offset', `${DATE}T09:00:00+02:00`],
    ['another day', '2026-10-12T09:00:00+03:00'],
    ['bad hour', `${DATE}T24:00:00+03:00`],
    ['no time', DATE],
  ])('refuses an at with %s', (_name, at) => {
    const p = withSlots((s) => (s[0]!.at = at));
    expect(messages(p).some((m) => m.startsWith('slots.0.at'))).toBe(true);
  });

  it('refuses slots out of order and allows equal times', () => {
    const swapped = withSlots((s) => s.reverse());
    expect(messages(swapped).join()).toMatch(/sorted by at/);
    const equal = withSlots((s) => (s[1]!.at = s[0]!.at));
    expect(parse(equal).success).toBe(true);
  });

  it('refuses duplicate slot ids and ids with a colon or whitespace', () => {
    expect(messages(withSlots((s) => (s[1]!.id = 's1'))).join()).toMatch(/unique/);
    expect(parse(withSlots((s) => (s[0]!.id = 'a:b'))).success).toBe(false);
    expect(parse(withSlots((s) => (s[0]!.id = ' s1'))).success).toBe(false);
    expect(parse(withSlots((s) => (s[0]!.id = ''))).success).toBe(false);
  });

  it('only allows the telegram platform', () => {
    const p = withSlots((s) => ((s[0] as { platform: string }).platform = 'threads'));
    expect(parse(p).success).toBe(false);
  });

  it('requires a poll on a poll slot', () => {
    const p = withSlots((s) => delete s[1]!.poll);
    expect(messages(p).join()).toMatch(/slots\.1\.poll: .*poll slot requires/);
  });

  it('checks poll limits: 2..10 options of at most 100 chars, question at most 300', () => {
    const poll = (f: (o: NonNullable<PlanV1['slots'][number]['poll']>) => void) =>
      withSlots((s) => f(s[1]!.poll!));
    expect(parse(poll((o) => (o.options = ['one']))).success).toBe(false);
    expect(
      parse(poll((o) => (o.options = Array.from({ length: 11 }, (_, i) => `o${i}`)))).success,
    ).toBe(false);
    expect(
      parse(poll((o) => (o.options = Array.from({ length: 10 }, (_, i) => `o${i}`)))).success,
    ).toBe(true);
    expect(parse(poll((o) => (o.options = ['x'.repeat(101), 'b']))).success).toBe(false);
    expect(parse(poll((o) => (o.options = ['x'.repeat(100), 'b']))).success).toBe(true);
    expect(parse(poll((o) => (o.options = ['', 'b']))).success).toBe(false);
    expect(parse(poll((o) => (o.question = 'q'.repeat(301)))).success).toBe(false);
    expect(parse(poll((o) => (o.question = 'q'.repeat(300)))).success).toBe(true);
  });

  it('requires a non-empty text and a calendar eventDate', () => {
    expect(parse(withSlots((s) => (s[0]!.text = '  '))).success).toBe(false);
    expect(parse(withSlots((s) => (s[0]!.eventDate = '08.10'))).success).toBe(false);
  });

  it('requires sourceWindow with from, to and entryIds', () => {
    expect(parse({ ...validPlan(), sourceWindow: { from: 'x', to: 'y' } }).success).toBe(false);
  });

  it('reports cross-slot faults together with field faults, and survives non-objects', () => {
    const p = validPlan() as unknown as { arc: unknown; slots: { at: string; poll?: unknown }[] };
    p.arc = {};
    p.slots[0]!.at = '2026-10-12T09:00:00+03:00';
    delete p.slots[1]!.poll;
    const r = PlanV1Schema.safeParse(p);
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['arc.title', 'slots.1.poll', 'slots.0.at']));
    for (const v of [undefined, null, 5, 'x', [], { slots: 'x' }, { slots: [null, 1] }]) {
      expect(() => PlanV1Schema.safeParse(v)).not.toThrow();
    }
  });
});
