import { describe, expect, it } from 'vitest';
import { signText } from '../../src/plan/pipeline.js';
import {
  formatIssues,
  PlanSchema,
  PlanV1Schema,
  PlanV2Schema,
  SlotSchema,
  VariantSchema,
  type PlanV2,
} from '../../src/plan/schema.js';
import { DATE, validPlan } from './fixtures.js';
import { LINKEDIN_EN, LINKEDIN_RU, THREADS_RU, variant, VARIANTS } from './variant-fixtures.js';

// plan.json v2 (WP-PLAT-01 scope 1): v1 plus optional `variants` on a slot.

/** A stored v2 document: the fixture plan, signed, with `variants` on s1. */
function v2Doc(variants: unknown = VARIANTS): PlanV2 {
  const p = validPlan();
  const slots = p.slots.map((s) => ({ ...s, text: signText(s.text) }));
  return {
    ...p,
    version: 2,
    slots: [{ ...slots[0]!, variants: variants as PlanV2['slots'][number]['variants'] }, slots[1]!],
  };
}
const issues = (doc: unknown) => {
  const r = PlanV2Schema.safeParse(doc);
  return r.success ? [] : formatIssues(r.error);
};

describe('VariantSchema', () => {
  it('accepts threads and linkedin, ru and en, with and without seconds', () => {
    for (const v of VARIANTS) expect(VariantSchema.parse(v)).toEqual(v);
    expect(VariantSchema.safeParse(variant(THREADS_RU, { lang: 'en' })).success).toBe(true);
  });

  it.each([
    ['platform', 'telegram'],
    ['platform', 'facebook'],
    ['lang', 'de'],
    ['lang', 'RU'],
    ['at', `${DATE}T09:07:41Z`],
    ['at', `${DATE}T09:07:41+02:00`],
    ['at', `${DATE} 09:07`],
    ['text', '   '],
    ['text', 7],
  ])('refuses %s = %j', (key, value) => {
    const r = VariantSchema.safeParse(variant(THREADS_RU, { [key]: value }));
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toEqual([key]);
  });

  it('is strict: an image, a first comment or any other key is refused', () => {
    for (const key of ['image', 'firstComment', 'kind', 'id']) {
      const r = VariantSchema.safeParse(variant(THREADS_RU, { [key]: 'x' }));
      expect(r.success, key).toBe(false);
      expect(r.error!.issues[0]!.code).toBe('unrecognized_keys');
    }
  });

  it.each(['platform', 'lang', 'at', 'text'])('requires %s', (key) => {
    const v: Record<string, unknown> = { ...THREADS_RU };
    delete v[key];
    expect(VariantSchema.safeParse(v).success).toBe(false);
  });
});

describe('PlanV2Schema', () => {
  it('accepts a plan with a Threads RU variant and a LinkedIn RU + EN pair', () => {
    const doc = v2Doc();
    expect(PlanV2Schema.parse(doc)).toEqual(doc);
  });

  it('keeps the keys of a slot in order, variants last', () => {
    const out = PlanV2Schema.parse(v2Doc());
    expect(Object.keys(out.slots[0]!)).toEqual([
      'id',
      'at',
      'platform',
      'kind',
      'text',
      'eventDate',
      'variants',
    ]);
    expect(out.slots[1]).not.toHaveProperty('variants');
  });

  it('a plan without any variants is a valid v2 plan', () => {
    const doc = { ...validPlan(), version: 2 };
    expect(PlanV2Schema.safeParse(doc).success).toBe(true);
  });

  it('refuses an empty variants list in a stored plan (no variants = no key)', () => {
    expect(issues(v2Doc([]))).toEqual([expect.stringMatching(/^slots\.0\.variants: /)]);
  });

  it('refuses two variants of one platform and language in a slot', () => {
    const second = variant(THREADS_RU, { at: `${DATE}T11:03:17+03:00` });
    expect(issues(v2Doc([THREADS_RU, LINKEDIN_RU, second]))).toEqual([
      'slots.0.variants.2: a slot has at most one variant per platform and language ("threads/ru" repeats)',
    ]);
    // The same platform in two languages and the same language on two platforms are fine.
    expect(issues(v2Doc([LINKEDIN_RU, LINKEDIN_EN, THREADS_RU]))).toEqual([]);
  });

  it('refuses a variant whose time is on another day', () => {
    const late = variant(THREADS_RU, { at: '2026-10-12T00:03:11+03:00' });
    expect(issues(v2Doc([late]))).toEqual([
      `slots.0.variants.0.at: at must be on the plan date ${DATE}`,
    ]);
    const edge = variant(THREADS_RU, { at: `${DATE}T23:59:59+03:00` });
    expect(issues(v2Doc([edge]))).toEqual([]);
  });

  it('refuses variants on a poll slot', () => {
    const doc = v2Doc();
    (doc.slots[1] as Record<string, unknown>).variants = [THREADS_RU];
    expect(issues(doc)).toEqual(['slots.1.variants: a poll slot cannot have variants']);
  });

  it('reports the faults of slots and of variants together, each with its own code', () => {
    const doc = v2Doc([
      THREADS_RU,
      variant(THREADS_RU, { at: '2026-10-12T09:07:41+03:00' }),
      { ...LINKEDIN_RU, image: {} },
    ]) as unknown as { slots: Record<string, unknown>[] };
    doc.slots[1]!.id = 's1';
    doc.slots[1]!.variants = [LINKEDIN_EN];
    const r = PlanV2Schema.safeParse(doc);
    expect(r.success).toBe(false);
    expect(
      r.error!.issues.map((i) => [
        i.path.join('.'),
        i.code === 'custom' ? ((i.params?.code as string | undefined) ?? i.code) : i.code,
      ]),
    ).toEqual([
      ['slots.0.variants.2', 'unrecognized_keys'],
      ['slots.1.id', 'custom'],
      ['slots.0.variants.1.at', 'wrong_date'],
      ['slots.0.variants.1', 'duplicate_variant'],
      ['slots.1.variants', 'variants_not_allowed'],
    ]);
  });

  it('does not throw on a broken document', () => {
    for (const doc of [null, 7, {}, { slots: 'x' }, { slots: [null, { variants: [null, 3] }] }]) {
      expect(PlanV2Schema.safeParse(doc).success).toBe(false);
    }
  });
});

describe('plan versions side by side', () => {
  it('PlanSchema reads a stored plan of either version', () => {
    const v1 = validPlan();
    expect(PlanSchema.parse(v1)).toEqual(v1);
    const v2 = v2Doc();
    expect(PlanSchema.parse(v2)).toEqual(v2);
    expect(PlanSchema.safeParse({ ...v1, version: 3 }).success).toBe(false);
  });

  it('PlanSchema applies the rules of the version it reads', () => {
    const doc = v2Doc([THREADS_RU, THREADS_RU]);
    expect(PlanSchema.safeParse(doc).success).toBe(false);
  });

  it('a v1 reader refuses a v2 plan instead of losing its variants silently', () => {
    expect(PlanV1Schema.safeParse(v2Doc()).success).toBe(false);
  });

  it('the Telegram slot schema knows no variants: the key is dropped like any unknown key', () => {
    const slot = { ...validPlan().slots[0]!, variants: VARIANTS };
    expect(SlotSchema.parse(slot)).toEqual(validPlan().slots[0]);
  });
});
