import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  endsWithQuestion,
  finalizePlan,
  finalizeSlot,
  SIGNATURE_LINE,
  signText,
  sourceWindowOf,
  TEXT_MAX_RAW,
  type PlanBase,
} from '../../src/plan/pipeline.js';
import { PlanV1Schema } from '../../src/plan/schema.js';
import { DATE, validPlan } from './fixtures.js';

const SIG = 'ИИ-журналист-правдорубец Кореш Шпандент';
const base = (): PlanBase => {
  const { version, date, sourceWindow } = validPlan();
  return { version, date, sourceWindow };
};

describe('signText', () => {
  it('appends the signature line once', () => {
    expect(signText('Текст?')).toBe(`Текст?\n\n${SIGNATURE_LINE}`);
  });

  it('D-26: the signature has no dash and a model-written dashed one is replaced', () => {
    expect(SIGNATURE_LINE).toBe(SIG);
    expect(SIGNATURE_LINE).not.toMatch(/[\u2013\u2014]/);
    const out = signText(`Текст?\n\n— ${SIG}`);
    expect(out).toBe(`Текст?\n\n${SIG}`);
    expect(out.split(SIG)).toHaveLength(2);
  });

  it('D-26: the signature constant is only Cyrillic letters, hyphens and spaces', () => {
    expect(SIGNATURE_LINE).toMatch(/^[\u0410-\u044F\u0401\u0451\- ]+$/);
    expect(SIGNATURE_LINE).not.toMatch(/[A-Za-z]/);
    expect(SIGNATURE_LINE).toBe('ИИ-журналист-правдорубец Кореш Шпандент');
  });

  it('L-2: strips a decorated signature line before appending (no doubling)', () => {
    const t = `Опрос к делу №2.\n\n**— ${SIG}** 🤖\n_${SIG}_`;
    const out = signText(t);
    expect(out.split(SIG)).toHaveLength(2);
    expect(out).toBe(`Опрос к делу №2.\n\n${SIGNATURE_LINE}`);
  });

  it('L-2: strips a signature line that is not the last line', () => {
    const out = signText(`Начало\n— ${SIG}\n❓ Кто первым?`);
    expect(out).toBe(`Начало\n❓ Кто первым?\n\n${SIGNATURE_LINE}`);
  });
});

describe('endsWithQuestion (L-4)', () => {
  it.each([
    ['❓ Кто первым?'],
    ['❓ Кто первым?»'],
    ['«Кто первым?»)'],
    ['Что дальше?'],
    ['❓ «Почему партии одинаковые?»'],
    [`❓ Кто первым?\n\n${SIG}`],
    [`❓ Кто первым?\n\n— ${SIG}`],
    [`❓ Кто первым?\n\n**${SIG}** 🤖`],
  ])('accepts %j', (t) => {
    expect(endsWithQuestion(t)).toBe(true);
  });

  it.each([
    // review M-1 probe strings
    ['Почему? Потому что ответ: деньги. Конец истории.'],
    ['Зачем? Затем. Итог: ответ - никто не знает…'],
    ['https://x.ru/p?a=1'],
    ['см. https://x.ru/p?'],
    // near misses of the style-bible form
    // D-26: the answer-deadline tail is gone
    ['Кто первым? Ответ — 12.10 в 09:00.'],
    ['Кто первым? Ответ - 12.10'],
    ['Кто первым? (Ответ — 11.10 в 09:00)'],
    ['Читайте https://x.ru/p?'],
    ['Подробности: https://example.org/page?a=1'],
    ['Ссылка https://example.org/?a=1 Ответ — 12.10'],
    ['Кто первым? Неизвестно.'],
    ['Вопрос? Нет, утверждение.'],
    ['Кто первым?\nВопросов нет.'],
    [''],
    [`${SIG}`],
    [`— ${SIG}`],
  ])('refuses %j', (t) => {
    expect(endsWithQuestion(t)).toBe(false);
  });
});

describe('finalizePlan', () => {
  it('validates, signs every text and renders md', () => {
    const p = validPlan();
    const f = finalizePlan({ arc: p.arc, slots: p.slots }, base());
    expect(f.errors).toBeUndefined();
    expect(PlanV1Schema.safeParse(f.plan).success).toBe(true);
    for (const s of f.plan!.slots) expect(s.text.endsWith(`\n\n${SIGNATURE_LINE}`)).toBe(true);
    expect(f.md).toContain(`План Кореша на 11.10.2026`);
    expect(f.md!.split(SIGNATURE_LINE)).toHaveLength(3);
  });

  it('lists schema, question and length errors at once, naming the slots', () => {
    const p = validPlan();
    const slots: unknown[] = structuredClone(p.slots);
    (slots[0] as { text: string }).text = 'Без вопроса.';
    delete (slots[1] as { poll?: unknown }).poll;
    slots.push({ ...p.slots[0], id: 's3', at: `${DATE}T21:00:00+03:00`, text: 'а'.repeat(4000) });
    const f = finalizePlan({ arc: { title: '' }, slots }, base());
    expect(f.plan).toBeUndefined();
    const byCode = f.errors!.map((e) => [e.path, e.slotId, e.code]);
    expect(byCode).toEqual(
      expect.arrayContaining([
        ['arc.title', undefined, 'too_small'],
        ['arc.beat', undefined, 'invalid_type'],
        ['slots.1.poll', 's2', 'custom'],
        ['slots.0.text', 's1', 'no_question'],
        ['slots.2.text', 's3', 'no_question'],
        ['slots.2.text', 's3', 'too_long'],
      ]),
    );
    expect(f.errors!.every((e) => e.message.length > 0)).toBe(true);
  });

  it('D-26: three different violations come back in one 422 with path, slotId and excerpt', () => {
    const p = validPlan();
    p.slots[0]!.text = 'Тишина — это страшно.\n- пункт\nВажно отметить: «так».\n\nКто первым?';
    const f = finalizePlan({ arc: p.arc, slots: p.slots }, base());
    expect(f.plan).toBeUndefined();
    const codes = f.errors!.map((e) => e.code);
    expect(codes).toEqual(
      expect.arrayContaining(['em_dash', 'list_line', 'stop_phrase', 'guillemets']),
    );
    for (const e of f.errors!) {
      expect(e).toMatchObject({ path: 'slots.0.text', slotId: 's1' });
      expect(e.excerpt).toBeTruthy();
    }
  });

  it('D-26: the old "Ответ — ДД.ММ" tail now fails with em_dash', () => {
    const p = validPlan();
    p.slots[0]!.text = 'Кто первым? Ответ — 12.10 в 09:00.';
    const f = finalizePlan({ arc: p.arc, slots: p.slots }, base());
    expect(f.errors!.map((e) => e.code)).toEqual(
      expect.arrayContaining(['em_dash', 'no_question']),
    );
  });

  it('D-26: a model-written dashed signature line is neither linted nor kept', () => {
    const p = validPlan();
    p.slots[0]!.text = `Что дальше?\n\n— ${SIG}`;
    const f = finalizePlan({ arc: p.arc, slots: p.slots }, base());
    expect(f.errors).toBeUndefined();
    expect(f.plan!.slots[0]!.text).toBe(`Что дальше?\n\n${SIG}`);
  });

  it('D-26: the poll question and options are linted too, with their paths', () => {
    const p = validPlan();
    p.slots[1]!.poll!.question = 'Почему — так?';
    p.slots[1]!.poll!.options = ['ИИ ленится', '- так задумано', '«да»'];
    const f = finalizePlan({ arc: p.arc, slots: p.slots }, base());
    expect(f.errors!.map((e) => [e.path, e.slotId, e.code])).toEqual(
      expect.arrayContaining([
        ['slots.1.poll.question', 's2', 'em_dash'],
        ['slots.1.poll.options.1', 's2', 'list_line'],
        ['slots.1.poll.options.2', 's2', 'guillemets'],
      ]),
    );
  });

  it(`holds the ${TEXT_MAX_RAW} limit after signing`, () => {
    const p = validPlan();
    const tail = '\n\n❓ Вопрос?';
    const room = TEXT_MAX_RAW - `\n\n${SIGNATURE_LINE}`.length - tail.length;
    p.slots[0]!.text = 'а'.repeat(room) + tail;
    const ok = finalizePlan({ arc: p.arc, slots: p.slots }, base());
    expect(ok.plan!.slots[0]!.text).toHaveLength(TEXT_MAX_RAW);
    p.slots[0]!.text = 'а'.repeat(room + 1) + tail;
    const bad = finalizePlan({ arc: p.arc, slots: p.slots }, base());
    expect(bad.errors).toEqual([
      expect.objectContaining({ path: 'slots.0.text', slotId: 's1', code: 'too_long' }),
    ]);
  });

  it('reports a body that is not an object of slots', () => {
    const f = finalizePlan({ arc: undefined, slots: 'nope' }, base());
    expect(f.errors!.map((e) => e.path)).toEqual(expect.arrayContaining(['arc', 'slots']));
  });
});

describe('sourceWindowOf and canonicalJson', () => {
  it('window spans the earliest and latest entry', () => {
    const now = new Date('2026-10-10T17:00:00Z');
    expect(sourceWindowOf([], now)).toEqual({
      from: now.toISOString(),
      to: now.toISOString(),
      entryIds: [],
    });
    expect(
      sourceWindowOf(
        [
          { id: 'b', at: '2026-10-08T22:00:00+03:00' },
          { id: 'a', at: '2026-10-08T10:00:00+03:00' },
        ],
        now,
      ),
    ).toEqual({
      from: '2026-10-08T10:00:00+03:00',
      to: '2026-10-08T22:00:00+03:00',
      entryIds: ['b', 'a'],
    });
  });

  it('canonical JSON ignores key order', () => {
    expect(canonicalJson({ b: [1, { y: 1, x: 2 }], a: 'z' })).toBe(
      canonicalJson({ a: 'z', b: [1, { x: 2, y: 1 }] }),
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});

describe('finalizeSlot (WP-SVC-22): one slot through the rules of finalizePlan', () => {
  const slot = (over: Record<string, unknown> = {}) => ({ ...validPlan().slots[0]!, ...over });

  it('returns the signed slot, equal to what finalizePlan makes of the same slot', () => {
    const p = validPlan();
    const whole = finalizePlan({ arc: p.arc, slots: p.slots }, base());
    for (const [i, s] of p.slots.entries()) {
      const one = finalizeSlot({ ...s }, s.id);
      expect(one.errors).toBeUndefined();
      expect(JSON.stringify(one.slot)).toBe(JSON.stringify(whole.plan!.slots[i]));
    }
  });

  it('reports the same codes as finalizePlan, with paths relative to the slot', () => {
    const cases: Record<string, unknown>[] = [
      { text: 'Ответ — 12.10. Кто первый?' },
      { text: 'Просто утверждение.' },
      { text: `${'а'.repeat(TEXT_MAX_RAW)} Кто?` },
      { text: '  ' },
      { text: 42 },
      { kind: 'poll', text: 'Опрос.' },
      { kind: 'poll', text: 'Опрос.', poll: { question: '«Кто»?', options: ['a'] } },
    ];
    for (const over of cases) {
      const s = slot(over);
      const whole = finalizePlan({ arc: validPlan().arc, slots: [s] }, base()).errors ?? [];
      const one = finalizeSlot(s, 's1').errors ?? [];
      expect(one.length, JSON.stringify(over)).toBeGreaterThan(0);
      expect(one.map((e) => ({ ...e, path: `slots.0.${e.path}` }))).toEqual(whole);
      expect(one.every((e) => e.slotId === 's1')).toBe(true);
    }
  });
});
