import { describe, expect, it } from 'vitest';
import { finalizePlan, type PlanBase } from '../../src/plan/pipeline.js';
import { renderPlanMd } from '../../src/plan/render.js';
import type { PlanV2 } from '../../src/plan/schema.js';
import { DATE, validPlan } from './fixtures.js';
import { LINKEDIN_RU, THREADS_RU, v1Input, v2Input, variant } from './variant-fixtures.js';

// WP-PLAT-01 scope 5: plan.md shows every variant under its slot.

const base: PlanBase = { version: 1, date: DATE, sourceWindow: validPlan().sourceWindow };
const v2 = (variants?: unknown) =>
  finalizePlan(v2Input(variants), base, { variants: true }).plan as PlanV2;

describe('renderPlanMd with variants', () => {
  it('renders one block per variant: platform, language, time, length used / limit, text', () => {
    const md = renderPlanMd(v2());
    expect(md).toMatchSnapshot();
    expect(md).toBe(renderPlanMd(v2()));
  });

  it('adds the blocks after the Telegram part of the slot and changes nothing else', () => {
    const plain = renderPlanMd(finalizePlan(v1Input(), base).plan!);
    const md = renderPlanMd(v2());
    const [head, s1, s2] = md.split('\n\n---\n\n');
    const [plainHead, plainS1, plainS2] = plain.split('\n\n---\n\n');
    expect(head).toBe(plainHead);
    expect(s2).toBe(plainS2);
    expect(s1!.startsWith(`${plainS1}\n\n### Threads · RU · `)).toBe(true);
  });

  it('keeps the order of the plan and shows the time as written', () => {
    const md = renderPlanMd(
      v2([
        variant(LINKEDIN_RU, { at: `${DATE}T23:59:59+03:00` }),
        variant(THREADS_RU, { at: `${DATE}T00:01+03:00` }),
      ]),
    );
    expect(md.split('\n').filter((l) => l.startsWith('### '))).toEqual([
      expect.stringMatching(/^### LinkedIn · RU · 23:59:59 МСК · длина \d+\/2700$/),
      expect.stringMatching(/^### Threads · RU · 00:01 МСК · длина \d+\/500$/),
    ]);
  });
});
