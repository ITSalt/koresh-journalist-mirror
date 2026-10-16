import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { finalizePlan, type PlanBase } from '../../src/plan/pipeline.js';
import {
  configureVariantGaps,
  DEFAULT_VARIANT_MIN_GAP_MIN,
  variantGapIssues,
  variantMinGapMin,
} from '../../src/plan/variants.js';
import { buildServer } from '../../src/server.js';
import { openStore } from '../../src/store/index.js';
import { DATE, validPlan } from './fixtures.js';
import {
  LINKEDIN_EN,
  LINKEDIN_RU,
  THREADS_RU,
  v1Input,
  v2Input,
  variant,
} from './variant-fixtures.js';

// WP-PLAT-02, resubmission 1, item 5 (director's decision of 13.10): two variants of the same
// platform on one day closer than that platform's minimum gap are refused at intake with the code
// `variant_gap`, like `round_time`, instead of the second one waiting silently at publish time.

const base: PlanBase = { version: 1, date: DATE, sourceWindow: validPlan().sourceWindow };
const finalize = (input: ReturnType<typeof v2Input>) =>
  finalizePlan(input, base, { variants: true });
const at = (hms: string) => `${DATE}T${hms}+03:00`;
const gaps = (variants: unknown, onSecond?: unknown) =>
  (finalize(v2Input(variants, onSecond)).errors ?? [])
    .filter((e) => e.code === 'variant_gap')
    .map((e) => e.path);

afterEach(() => configureVariantGaps({ threads: 20, linkedin: 20 }));

describe('variant_gap at intake', () => {
  it('LinkedIn RU and EN 10 minutes apart: refused, naming both variants and the gap', () => {
    const f = finalize(
      v2Input([
        variant(LINKEDIN_RU, { at: at('10:12:09') }),
        variant(LINKEDIN_EN, { at: at('10:22:09') }),
      ]),
    );
    expect(f.plan).toBeUndefined();
    expect(f.errors).toEqual([
      {
        path: 'slots.0.variants.1.at',
        slotId: 's1',
        code: 'variant_gap',
        message:
          'linkedin variants s1/ru at 10:12:09 and s1/en at 10:22:09 are 10 min 0 s apart; the minimum gap on linkedin is 20 min, so the second one would wait instead of going out at its time. Put them at least 20 min apart',
      },
    ]);
  });

  it('exactly the gap apart is accepted; one second less is refused', () => {
    expect(
      gaps([
        variant(LINKEDIN_RU, { at: at('10:12:09') }),
        variant(LINKEDIN_EN, { at: at('10:32:09') }),
      ]),
    ).toEqual([]);
    const f = finalize(
      v2Input([
        variant(LINKEDIN_RU, { at: at('10:12:09') }),
        variant(LINKEDIN_EN, { at: at('10:32:08') }),
      ]),
    );
    expect(f.errors!.map((e) => [e.path, e.code])).toEqual([
      ['slots.0.variants.1.at', 'variant_gap'],
    ]);
    expect(f.errors![0]!.message).toContain('19 min 59 s apart');
  });

  it('the issue is on the later variant, whatever the order in the body; seconds are optional', () => {
    const f = finalize(
      v2Input([
        variant(LINKEDIN_EN, { at: at('10:41') }),
        variant(LINKEDIN_RU, { at: at('10:27:30') }),
      ]),
    );
    expect(f.errors!.map((e) => e.path)).toEqual(['slots.0.variants.0.at']);
    expect(f.errors![0]!.message).toContain(
      'linkedin variants s1/ru at 10:27:30 and s1/en at 10:41 are 13 min 30 s apart',
    );
  });

  it('variants of different platforms may stand as close as they like', () => {
    expect(
      gaps([
        variant(THREADS_RU, { at: at('10:12:09') }),
        variant(LINKEDIN_RU, { at: at('10:12:10') }),
        variant(LINKEDIN_EN, { at: at('10:41') }),
      ]),
    ).toEqual([]);
  });

  it('the rule holds across slots of the day and reports every pair of neighbours', () => {
    const input = v2Input([
      variant(THREADS_RU, { at: at('09:07:41') }),
      variant(THREADS_RU, { lang: 'en', at: at('09:20:41') }),
    ]);
    // A third post slot with a Threads variant close to the second one.
    input.slots.push({
      ...input.slots[0]!,
      id: 's3',
      at: at('12:07:21'),
      variants: [variant(THREADS_RU, { at: at('09:31:41') })],
    });
    input.slots.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const f = finalize(input);
    const found = f.errors!.filter((e) => e.code === 'variant_gap');
    expect(found.map((e) => [e.slotId, e.path.split('.').slice(2).join('.')])).toEqual([
      ['s1', 'variants.1.at'],
      ['s3', 'variants.0.at'],
    ]);
    expect(found[1]!.message).toContain('threads variants s1/en at 09:20:41 and s3/ru at 09:31:41');
  });

  it('each platform reads its own gap; 0 switches the rule off for that platform', () => {
    expect(variantMinGapMin('threads')).toBe(DEFAULT_VARIANT_MIN_GAP_MIN);
    const pair = [
      variant(LINKEDIN_RU, { at: at('10:12:09') }),
      variant(LINKEDIN_EN, { at: at('10:22:09') }),
      variant(THREADS_RU, { at: at('11:02:09') }),
      variant(THREADS_RU, { lang: 'en', at: at('11:12:09') }),
    ];
    expect(gaps(pair)).toEqual(['slots.0.variants.1.at', 'slots.0.variants.3.at']);
    configureVariantGaps({ linkedin: 10 });
    expect(gaps(pair)).toEqual(['slots.0.variants.3.at']);
    configureVariantGaps({ threads: 0, linkedin: 30 });
    expect(gaps(pair)).toEqual(['slots.0.variants.1.at']);
    // A value that is not a number of minutes changes nothing.
    configureVariantGaps({ linkedin: Number.NaN, threads: -1 });
    expect([variantMinGapMin('linkedin'), variantMinGapMin('threads')]).toEqual([30, 0]);
  });

  it('is listed with the other faults of the plan, all at once', () => {
    const f = finalize(
      v2Input([
        variant(LINKEDIN_RU, { at: at('10:15:00'), text: 'Без вопроса.' }),
        variant(LINKEDIN_EN, { at: at('10:22:09') }),
      ]),
    );
    expect(f.errors!.map((e) => `${e.path}:${e.code}`)).toEqual([
      'slots.0.variants.0.at:round_time',
      'slots.0.variants.0.text:no_question',
      'slots.0.variants.1.at:variant_gap',
    ]);
  });

  it('a variant refused by its own rule is left to that rule', () => {
    // A duplicate, a variant on the poll slot, a malformed and a foreign-day `at`.
    const f = finalize(
      v2Input(
        [
          variant(LINKEDIN_RU, { at: at('10:12:09') }),
          variant(LINKEDIN_RU, { at: at('10:12:09') }),
          variant(LINKEDIN_EN, { at: 'soon' }),
        ],
        [variant(LINKEDIN_EN, { at: at('10:13:09') })],
      ),
    );
    expect(f.errors!.map((e) => e.code)).not.toContain('variant_gap');
    expect(variantGapIssues('nope')).toEqual([]);
    expect(variantGapIssues([null, { variants: 'x' }, { variants: [null, { at: 5 }] }])).toEqual(
      [],
    );
  });

  it('a plan without variants and the fallback path are not touched by the rule', () => {
    expect(finalize(v1Input()).errors).toBeUndefined();
    // The fallback (no `variants` option) drops variants before any rule sees them.
    const close = v2Input([
      variant(LINKEDIN_RU, { at: at('10:12:09') }),
      variant(LINKEDIN_EN, { at: at('10:22:09') }),
    ]);
    expect(finalizePlan(close, base).errors).toBeUndefined();
  });

  it('POST /v1/plans/:date answers 422 variant_gap and stores nothing', async () => {
    const store = openStore(':memory:');
    try {
      const token = 'fake-api-token-for-tests-0123456789';
      const app = buildServer({
        config: loadConfig({ JOURNALIST_API_TOKEN: token }),
        store,
        logLevel: 'silent',
        now: () => new Date('2026-10-10T17:00:00+03:00'),
      });
      const post = (variants: unknown) =>
        app.inject({
          method: 'POST',
          url: `/v1/plans/${DATE}`,
          headers: { authorization: `Bearer ${token}` },
          payload: v2Input(variants),
        });
      const res = await post([
        variant(LINKEDIN_RU, { at: at('10:12:09') }),
        variant(LINKEDIN_EN, { at: at('10:22:09') }),
      ]);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().errors).toMatchObject([
        { path: 'slots.0.variants.1.at', slotId: 's1', code: 'variant_gap' },
      ]);
      expect(store.plans.get(DATE)).toBeUndefined();
      // Twenty minutes apart, the same plan is stored.
      const ok = await post([
        variant(LINKEDIN_RU, { at: at('10:12:09') }),
        variant(LINKEDIN_EN, { at: at('10:32:09') }),
      ]);
      expect(ok.statusCode, ok.body).toBe(201);
      expect(store.slotVariants.listForPlan(DATE).map((v) => v.lang)).toEqual(['ru', 'en']);
    } finally {
      store.close();
    }
  });
});
