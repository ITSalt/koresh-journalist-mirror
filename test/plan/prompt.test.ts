import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPrompt,
  FEEDBACK_DAYS,
  lastOpenQuestion,
  loadPromptContext,
  loadPromptTexts,
  type PromptInput,
} from '../../src/plan/prompt.js';
import { openStore, type Feedback, type Store } from '../../src/store/index.js';
import { DATE, ENTRIES, validPlan } from './fixtures.js';

const TEXTS = {
  styleBible: 'БИБЛИЯ СТИЛЯ (тест)',
  criteria: 'КРИТЕРИИ (тест)',
  rules: 'ПРАВИЛА (тест)',
};
const FEEDBACK: Feedback[] = [
  {
    id: 1,
    planDate: '2026-10-05',
    slotId: 's1',
    verdict: 'dislike',
    note: 'Слишком длинно; шутка про Мальдивы — уже было',
    at: '2026-10-05T20:00:00.000Z',
  },
  {
    id: 2,
    planDate: '2026-10-06',
    slotId: null,
    verdict: 'like',
    note: null,
    at: '2026-10-06T20:00:00.000Z',
  },
];

const input = (over: Partial<PromptInput> = {}): PromptInput => ({
  date: DATE,
  entries: ENTRIES,
  ...TEXTS,
  feedback: FEEDBACK,
  previousPlans: [validPlan('2026-10-10')],
  ...over,
});

const open: Store[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

describe('buildPrompt', () => {
  it('builds a system and a user message (snapshot)', () => {
    const m = buildPrompt(input());
    expect(m.map((x) => x.role)).toEqual(['system', 'user']);
    expect(m).toMatchSnapshot();
  });

  it('puts the style bible and the rules in the system message', () => {
    const [sys] = buildPrompt(input());
    expect(sys!.content).toContain(TEXTS.styleBible);
    expect(sys!.content).toContain(TEXTS.rules);
    expect(sys!.content).toContain(TEXTS.criteria);
    expect(sys!.content).toContain('"slots"');
  });

  it('includes every entry with id, at, source, title and text', () => {
    const user = buildPrompt(input())[1]!.content;
    for (const e of ENTRIES) {
      expect(user).toContain(e.id);
      expect(user).toContain(e.at);
      expect(user).toContain(e.source);
      expect(user).toContain(e.text);
    }
    expect(user).toContain('Возвращение');
  });

  it('includes a feedback note verbatim', () => {
    const user = buildPrompt(input())[1]!.content;
    expect(user).toContain('Слишком длинно; шутка про Мальдивы — уже было');
    expect(user).toContain('не понравилось');
  });

  it('includes previous slots and the last open question', () => {
    const user = buildPrompt(input())[1]!.content;
    expect(user).toContain('2026-10-10');
    expect(user).toContain('Дело №1. Тишина. Хроника от 08.10');
    expect(user).toContain('Почему партии одинаковые?');
  });

  it('is pure: same input, same output', () => {
    expect(buildPrompt(input())).toEqual(buildPrompt(input()));
  });

  it('says when there is no feedback and no previous plan', () => {
    const user = buildPrompt(input({ feedback: [], previousPlans: [] }))[1]!.content;
    expect(user).toContain('Отзывов нет.');
    expect(user).toContain('Предыдущих планов нет.');
  });
});

describe('lastOpenQuestion', () => {
  it('takes the poll question when the newest plan ends with a poll', () => {
    expect(lastOpenQuestion([validPlan()])).toBe('Почему партии одинаковые?');
  });

  it('takes the last question line of the last post, without the signature', () => {
    const p = validPlan();
    p.slots = [
      {
        ...p.slots[0]!,
        text: 'Текст.\n\n❓ Кто первым?\n\n— ИИ-журналист-правдорубец Кореш Шпандент',
      },
    ];
    expect(lastOpenQuestion([p])).toBe('❓ Кто первым?');
  });

  it('is undefined without plans or slots', () => {
    expect(lastOpenQuestion([])).toBeUndefined();
    expect(lastOpenQuestion([{ ...validPlan(), slots: [] }])).toBeUndefined();
  });
});

describe('loadPromptContext', () => {
  const now = new Date('2026-10-10T16:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  it(`takes feedback of the last ${FEEDBACK_DAYS} days only`, () => {
    const s = openStore(':memory:');
    open.push(s);
    s.feedback.add(
      { planDate: '2026-09-30', verdict: 'like', note: 'note from 10 days ago' },
      daysAgo(10),
    );
    s.feedback.add(
      { planDate: '2026-09-20', verdict: 'dislike', note: 'note from 20 days ago' },
      daysAgo(20),
    );
    const ctx = loadPromptContext(s, DATE, now);
    expect(ctx.feedback.map((f) => f.note)).toEqual(['note from 10 days ago']);
  });

  it('takes up to 3 previous valid plans, newest first, skipping unparsable ones', () => {
    const s = openStore(':memory:');
    open.push(s);
    for (const d of ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-10']) {
      s.plans.upsert({
        date: d,
        status: 'approved',
        json: JSON.stringify(validPlan(d)),
        md: '',
      });
    }
    s.plans.upsert({ date: '2026-10-09', status: 'approved', json: '{"broken":', md: '' });
    s.plans.upsert({ date: DATE, status: 'draft', json: JSON.stringify(validPlan()), md: '' });
    const ctx = loadPromptContext(s, DATE, now);
    expect(ctx.previousPlans.map((p) => p.date)).toEqual(['2026-10-10', '2026-10-08']);
  });
});

describe('prompt texts', () => {
  it('loads the committed style bible and rules', () => {
    const t = loadPromptTexts();
    expect(t.styleBible).toBe(readFileSync('prompts/style-bible.md', 'utf8'));
    expect(t.styleBible).toContain('Кореш Шпандент — библия стиля');
    expect(t.rules).toContain('заканчивается живым вопросом');
    expect(t.rules).not.toMatch(/срок(ом)? ответа/);
    expect(t.criteria).toBe(readFileSync('prompts/channel1-criteria.md', 'utf8'));
  });
});
