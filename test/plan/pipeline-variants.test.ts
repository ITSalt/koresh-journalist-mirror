import { describe, expect, it } from 'vitest';
import { PublicationKeyError } from '../../src/lib/idempotency.js';
import { threadsLength } from '../../src/lib/threads-length.js';
import {
  finalizePlan,
  SIGNATURE_LINE,
  telegramSlot,
  type PlanBase,
  type PlanIssue,
} from '../../src/plan/pipeline.js';
import { PlanV2Schema, type PlanV2 } from '../../src/plan/schema.js';
import {
  LINKEDIN_FRAME_RESERVE,
  LINKEDIN_TEXT_LIMIT,
  THREADS_FRAME_RESERVE,
  VARIANT_LIMITS,
  variantId,
  variantLength,
  variantPublicationKey,
} from '../../src/plan/variants.js';
import { DATE, validPlan } from './fixtures.js';
import {
  LINKEDIN_EN,
  LINKEDIN_RU,
  signed,
  THREADS_RU,
  v1Input,
  v2Input,
  variant,
  VARIANTS,
} from './variant-fixtures.js';

// WP-PLAT-01 scope 2, 3 and 7: the rules of every variant in the shared pipeline.

const base: PlanBase = { version: 1, date: DATE, sourceWindow: validPlan().sourceWindow };
const finalize = (input: { arc: unknown; slots: unknown }, variants = true) =>
  finalizePlan(input, base, variants ? { variants: true } : {});
const brief = (errors: PlanIssue[] | undefined) => (errors ?? []).map((e) => `${e.path}:${e.code}`);

/** What the code adds to a Threads body: a blank line and the signature line. */
const SIGNATURE_UNITS = threadsLength(`\n\n${SIGNATURE_LINE}`);
/** A body of exactly `units` Threads units that ends with a question. */
const body = (units: number, tail = '?') => 'я'.repeat(units - threadsLength(tail)) + tail;

describe('finalizePlan with variants (the plan POST)', () => {
  it('returns plan.json v2: every variant signed like a Telegram text, nothing else added', () => {
    const f = finalize(v2Input());
    expect(f.errors).toBeUndefined();
    const plan = f.plan as PlanV2;
    expect(plan.version).toBe(2);
    expect(PlanV2Schema.parse(plan)).toEqual(plan);
    expect(plan.slots[0]!.variants).toEqual(VARIANTS.map((v) => ({ ...v, text: signed(v.text) })));
    expect(plan.slots[1]).not.toHaveProperty('variants');
    // Scope 3: no profile frame in the stored text (the header and the disclaimer are composed
    // at publish time).
    for (const v of plan.slots[0]!.variants!) {
      expect(v.text.split(SIGNATURE_LINE)).toHaveLength(2);
      expect(v.text).not.toContain('Новости от Корпорации всевластия');
      expect(v.text).not.toContain('исследовательского проекта');
    }
  });

  it('the Telegram part of a v2 plan equals the same plan without variants', () => {
    const v2 = finalize(v2Input()).plan!;
    const v1 = finalize(v1Input()).plan!;
    expect(v1.version).toBe(1);
    expect(v2.slots.map(telegramSlot)).toEqual(v1.slots);
    expect(JSON.stringify(v2.slots.map(telegramSlot))).toBe(JSON.stringify(v1.slots));
    expect({ ...v2, version: 1, slots: v1.slots }).toEqual(v1);
  });

  it.each([[undefined], [null], [[]]])('variants = %j means none: the plan is v1', (none) => {
    const input = v1Input();
    input.slots[0]!.variants = none;
    input.slots[1]!.variants = none;
    const f = finalize(input);
    expect(f.errors).toBeUndefined();
    expect(f.plan!.version).toBe(1);
    expect(JSON.stringify(f.plan)).toBe(JSON.stringify(finalize(v1Input()).plan));
    expect(f.md).toBe(finalize(v1Input()).md);
  });

  it('a signature the author wrote is not doubled', () => {
    const own = variant(THREADS_RU, { text: `${THREADS_RU.text}\n\n— ${SIGNATURE_LINE}` });
    const plan = finalize(v2Input([own])).plan as PlanV2;
    expect(plan.slots[0]!.variants![0]!.text).toBe(signed(THREADS_RU.text));
  });

  it('telegramSlot returns a v1 slot as it is and never changes its argument', () => {
    const plan = finalize(v2Input()).plan as PlanV2;
    const before = JSON.stringify(plan);
    expect(telegramSlot(plan.slots[1]!)).toBe(plan.slots[1]);
    expect(telegramSlot(plan.slots[0]!)).not.toHaveProperty('variants');
    expect(JSON.stringify(plan)).toBe(before);
  });
});

describe('finalizePlan without the variants option (the fallback, scope 7)', () => {
  it('drops variants, valid or not, and returns plan.json v1', () => {
    const v1 = finalizePlan(v1Input(), base);
    for (const variants of [VARIANTS, [{ platform: 'x', text: 'тире — тут' }], 'junk']) {
      const f = finalizePlan(v2Input(variants, variants), base);
      expect(f.errors).toBeUndefined();
      expect(JSON.stringify(f.plan)).toBe(JSON.stringify(v1.plan));
      expect(f.md).toBe(v1.md);
    }
  });
});

describe('the rules of a variant, every fault at once', () => {
  it('lints a variant as a Telegram text (D-26), naming slots.N.variants.M', () => {
    const f = finalize(
      v2Input([
        variant(THREADS_RU, { text: 'Важно отметить: тишина — это «знак».\n- пункт\nКто за?' }),
        LINKEDIN_RU,
        variant(LINKEDIN_EN, { text: 'A short dash – here. Who noticed?' }),
      ]),
    );
    expect(brief(f.errors)).toEqual([
      'slots.0.variants.0.text:em_dash',
      'slots.0.variants.0.text:guillemets',
      'slots.0.variants.0.text:list_line',
      'slots.0.variants.0.text:stop_phrase',
      'slots.0.variants.2.text:en_dash',
    ]);
    expect(f.errors![0]).toEqual({
      path: 'slots.0.variants.0.text',
      slotId: 's1',
      code: 'em_dash',
      message: expect.stringContaining('em dash (U+2014) is not allowed'),
      excerpt: expect.stringContaining('тишина — это'),
    });
    expect(f.plan).toBeUndefined();
  });

  it('the lint leaves the signature line out, as for a Telegram text', () => {
    const own = variant(THREADS_RU, { text: `Кто здесь?\n— ${SIGNATURE_LINE}` });
    expect(finalize(v2Input([own])).errors).toBeUndefined();
  });

  it('a variant must end with a plain question', () => {
    const f = finalize(
      v2Input([
        variant(THREADS_RU, { text: 'Тишина. Вопросов нет.' }),
        variant(LINKEDIN_RU, {
          text: 'Вопрос был? Был.\n\nА теперь ссылка https://example.org/?a=1',
        }),
        LINKEDIN_EN,
      ]),
    );
    expect(brief(f.errors)).toEqual([
      'slots.0.variants.0.text:no_question',
      'slots.0.variants.1.text:no_question',
    ]);
    expect(f.errors![0]!.message).toMatch(/must end with a plain question/);
  });

  it('Threads: 500 units by rule R1 including the signature line fit, 501 do not', () => {
    const fits = variant(THREADS_RU, { text: body(500 - SIGNATURE_UNITS) });
    const plan = finalize(v2Input([fits])).plan as PlanV2;
    expect(threadsLength(plan.slots[0]!.variants![0]!.text)).toBe(500);

    const over = variant(THREADS_RU, { text: body(501 - SIGNATURE_UNITS) });
    const f = finalize(v2Input([over]));
    expect(f.errors).toEqual([
      {
        path: 'slots.0.variants.0.text',
        slotId: 's1',
        code: 'too_long',
        message: expect.stringMatching(
          /^501 units as Threads counts .* max 500 on threads; shorten it$/,
        ),
      },
    ]);
  });

  it('Threads: an emoji takes its UTF-8 bytes, so a text of fewer chars can be too long', () => {
    // 👍 is 2 UTF-16 units and 1 code point, and 4 units by rule R1.
    const fits = variant(THREADS_RU, { text: body(500 - SIGNATURE_UNITS, '👍?') });
    expect(finalize(v2Input([fits])).errors).toBeUndefined();

    const over = variant(THREADS_RU, { text: body(501 - SIGNATURE_UNITS, '👍?') });
    expect(signed(over.text).length).toBeLessThan(500);
    expect([...signed(over.text)].length).toBeLessThan(500);
    const f = finalize(v2Input([over]));
    expect(brief(f.errors)).toEqual(['slots.0.variants.0.text:too_long']);
    expect(f.errors![0]!.message).toContain('501 units');
  });

  it('LinkedIn: LINKEDIN_TEXT_LIMIT chars including the frame, whose room is reserved', () => {
    const max = LINKEDIN_TEXT_LIMIT - LINKEDIN_FRAME_RESERVE;
    const room = max - `\n\n${SIGNATURE_LINE}`.length;
    const fits = variant(LINKEDIN_RU, { text: 'я'.repeat(room - 1) + '?' });
    const plan = finalize(v2Input([fits])).plan as PlanV2;
    expect(plan.slots[0]!.variants![0]!.text).toHaveLength(max);

    const over = variant(LINKEDIN_RU, { text: 'я'.repeat(room) + '?' });
    const f = finalize(v2Input([over]));
    expect(f.errors).toEqual([
      {
        path: 'slots.0.variants.0.text',
        slotId: 's1',
        code: 'too_long',
        message: `${max + 1} chars as LinkedIn counts (a reserved character such as ( ) # _ * takes two) after the signature, max ${max} on linkedin (${LINKEDIN_TEXT_LIMIT} minus ${LINKEDIN_FRAME_RESERVE} kept for the frame); shorten it`,
      },
    ]);
    // The same text is far too long for Threads and fine for the Telegram slot itself.
    expect(brief(finalize(v2Input([variant(over, { platform: 'threads' })])).errors)).toEqual([
      'slots.0.variants.0.text:too_long',
    ]);
  });

  it('acceptance 2: an em dash, 501 Threads units, a duplicate, a poll slot, another day: one list', () => {
    const f = finalize(
      v2Input(
        [
          variant(THREADS_RU, { text: 'Тишина — это знак. Кто согласен?' }),
          variant(THREADS_RU, { text: body(501 - SIGNATURE_UNITS, '👍?') }),
          variant(LINKEDIN_RU, { at: '2026-10-12T10:12:09+03:00' }),
          { ...LINKEDIN_EN, image: { sha256: 'a'.repeat(64), credit: 'x' } },
        ],
        [THREADS_RU],
      ),
    );
    expect(f.plan).toBeUndefined();
    expect(f.errors!.map((e) => [e.path, e.code, e.slotId])).toEqual([
      ['slots.0.variants.3', 'unrecognized_keys', 's1'],
      ['slots.0.variants.1', 'duplicate_variant', 's1'],
      ['slots.0.variants.2.at', 'wrong_date', 's1'],
      ['slots.1.variants', 'variants_not_allowed', 's2'],
      ['slots.0.variants.0.text', 'em_dash', 's1'],
      ['slots.0.variants.1.text', 'too_long', 's1'],
    ]);
  });

  it('faults of the Telegram text and of the variants of one slot are listed together', () => {
    const input = v2Input([variant(THREADS_RU, { text: 'Без вопроса.' })]);
    (input.slots[0] as Record<string, unknown>).text = 'Тоже без вопроса.';
    expect(brief(finalize(input).errors)).toEqual([
      'slots.0.text:no_question',
      'slots.0.variants.0.text:no_question',
    ]);
  });

  it.each([
    ['not a list', 'junk', ['slots.0.variants:invalid_type']],
    ['an object', { platform: 'threads' }, ['slots.0.variants:invalid_type']],
    [
      'a list of non-objects',
      [7, null],
      ['slots.0.variants.0:invalid_type', 'slots.0.variants.1:invalid_type'],
    ],
    [
      'an unknown platform and language',
      [variant(THREADS_RU, { platform: 'facebook', lang: 'de', text: 'я'.repeat(6000) + '?' })],
      ['slots.0.variants.0.platform:invalid_value', 'slots.0.variants.0.lang:invalid_value'],
    ],
    [
      'no text, a bad time',
      [{ platform: 'threads', lang: 'ru', at: '09:07' }],
      ['slots.0.variants.0.at:invalid_format', 'slots.0.variants.0.text:invalid_type'],
    ],
    ['a blank text', [variant(THREADS_RU, { text: ' \n ' })], ['slots.0.variants.0.text:custom']],
  ])('malformed variants (%s) are schema errors, never a crash', (_name, variants, expected) => {
    expect(brief(finalize(v2Input(variants)).errors)).toEqual(expected);
  });

  // WP-PLAT-01 scope 2 / WP-SVC-25: `round_time` applies to a variant's `at` as to a slot's.
  it.each(['10:00:00', '10:15', '10:15:00', '21:45:00'])(
    'a variant at a round time (%s) is refused with round_time',
    (hhmm) => {
      const f = finalize(v2Input([variant(THREADS_RU, { at: `${DATE}T${hhmm}+03:00` })]));
      expect(brief(f.errors)).toEqual(['slots.0.variants.0.at:round_time']);
    },
  );

  it.each(['10:00:07', '10:07', '10:16:00'])('a variant at %s passes', (hhmm) => {
    const f = finalize(v2Input([variant(THREADS_RU, { at: `${DATE}T${hhmm}+03:00` })]));
    expect(f.errors).toBeUndefined();
  });
});

describe('per-platform facts (src/plan/variants.ts)', () => {
  it('variantLength: what the stored text uses and what it may use', () => {
    expect(variantLength('threads', 'ok 👍')).toEqual({ used: 7, max: 500 });
    expect(variantLength('linkedin', 'ok 👍')).toEqual({ used: 5, max: 2700 });
    expect(LINKEDIN_TEXT_LIMIT).toBe(3000);
    expect(THREADS_FRAME_RESERVE).toBe(0);
    expect(VARIANT_LIMITS.threads.limit).toBe(500);
    expect(VARIANT_LIMITS.linkedin.limit - VARIANT_LIMITS.linkedin.frameReserve).toBe(2700);
  });

  it('publication keys are <platform>:<date>:<slot>-<lang>:<part>', () => {
    const k = { planDate: DATE, slotId: 's1', part: 0 } as const;
    expect(variantPublicationKey({ ...k, platform: 'threads', lang: 'ru' })).toBe(
      `threads:${DATE}:s1-ru:0`,
    );
    expect(variantPublicationKey({ ...k, platform: 'linkedin', lang: 'en', part: 1 })).toBe(
      `linkedin:${DATE}:s1-en:1`,
    );
    expect(variantId('s2-poll', 'en')).toBe('s2-poll-en');
  });

  it('no two variants of a day share a key, and none shares one with a Telegram slot', () => {
    const keys = new Set<string>();
    const slots = ['s1', 's1-ru', 's1-en', 's1-ru-en', 'ru', 'en'];
    for (const slotId of slots) {
      keys.add(`telegram:${DATE}:${slotId}:0`);
      for (const platform of ['threads', 'linkedin'] as const) {
        for (const lang of ['ru', 'en'] as const) {
          keys.add(variantPublicationKey({ platform, planDate: DATE, slotId, lang, part: 0 }));
        }
      }
    }
    expect(keys.size).toBe(slots.length * 5);
  });

  it('refuses what a publication key refuses', () => {
    const bad = { platform: 'threads', lang: 'ru', planDate: 'tomorrow', slotId: 's1', part: 0 };
    expect(() => variantPublicationKey(bad as never)).toThrow(PublicationKeyError);
  });
});
