import type { FeedEntry } from '../../src/lib/feed-types.js';
import type { PlanV1 } from '../../src/plan/schema.js';

export const DATE = '2026-10-11';

export const SIGNATURE_LINE = 'ИИ-журналист-правдорубец Кореш Шпандент';

/** A valid plan.json v1 as the code assembles it (texts without the signature). */
export function validPlan(date = DATE): PlanV1 {
  const p = basePlan();
  p.date = date;
  for (const s of p.slots) s.at = date + s.at.slice(10);
  return p;
}

function basePlan(): PlanV1 {
  return {
    version: 1,
    date: DATE,
    sourceWindow: {
      from: '2026-10-08T22:02:00+03:00',
      to: '2026-10-08T22:38:00+03:00',
      entryIds: ['e1', 'e2'],
    },
    arc: { title: 'Дело №1 «Тишина»', beat: 'развязка' },
    slots: [
      {
        id: 's1',
        at: `${DATE}T09:07:21+03:00`,
        platform: 'telegram',
        kind: 'post',
        text: 'Новости от Корпорации всевластия\n\n**Дело №1. Тишина. Хроника от 08.10**\n\n❓ Кто нарушит тишину первым?',
        eventDate: '2026-10-08',
      },
      {
        id: 's2',
        at: `${DATE}T19:09:34+03:00`,
        platform: 'telegram',
        kind: 'poll',
        text: 'Новости от Корпорации всевластия\n\nОпрос к делу №2.',
        poll: {
          question: 'Почему партии одинаковые?',
          options: ['ИИ ленится', 'так задумано', 'генератор видит мало материала'],
          allowsMultiple: false,
        },
        eventDate: '2026-10-08',
      },
    ],
  };
}

/** What the fake LLM returns: only arc and slots; the code fills version, date, window. */
export function llmPayload(over: Partial<Pick<PlanV1, 'arc' | 'slots'>> = {}): string {
  const p = validPlan();
  return JSON.stringify({ arc: over.arc ?? p.arc, slots: over.slots ?? p.slots });
}

export const ENTRIES: FeedEntry[] = [
  {
    id: 'e1',
    at: '2026-10-08T22:02:00+03:00',
    source: 'observer/LOG.md',
    title: 'Возвращение',
    text: 'Владелец попросил подвести итог недели и записать, что сделано.',
  },
  {
    id: 'e2',
    at: '2026-10-08T22:38:00+03:00',
    source: 'STATUS-TABLE.md',
    text: 'Владелец сравнил два черновика: «похожи, но различаются формулировками».',
  },
];
