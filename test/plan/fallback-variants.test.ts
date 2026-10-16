import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFallback } from '../../src/jobs/evening.js';
import { createOpenRouterClient } from '../../src/llm/openrouter.js';
import { buildPlan, type BuildPlanDeps } from '../../src/plan/build.js';
import { finalizePlan, saveDraft } from '../../src/plan/pipeline.js';
import { buildPrompt, lastOpenQuestion, loadPromptContext } from '../../src/plan/prompt.js';
import { openStore, type Store } from '../../src/store/index.js';
import { FakeOpenRouter } from '../llm/fake-openrouter.js';
import { DATE, ENTRIES, validPlan } from './fixtures.js';
import { v1Input, v2Input, VARIANTS } from './variant-fixtures.js';

// WP-PLAT-01 scope 7: the fallback (OpenRouter) writes no variants; a stored v2 plan is still
// the "plan of the day before" of its prompt, Telegram texts only.

const EVENING = new Date('2026-10-10T17:30:00Z'); // 20:30 MSK on the 10th

let fake: FakeOpenRouter;
let store: Store;
beforeEach(async () => {
  fake = await new FakeOpenRouter().start();
  store = openStore(':memory:');
});
afterEach(async () => {
  store.close();
  await fake.stop();
});

const deps = (): BuildPlanDeps => ({
  store,
  llm: createOpenRouterClient({
    apiKey: 'fake-openrouter-key-for-tests',
    model: 'vendor/writer',
    baseUrl: fake.baseUrl,
  }),
  capUsd: 1,
  estimateUsd: 0.1,
  prompts: { styleBible: 'BIBLE', criteria: 'CRITERIA', rules: 'RULES' },
});

describe('the fallback and variants', () => {
  it('variants in the LLM answer are dropped: the plan is plan.json v1', async () => {
    fake.replies.push({ content: JSON.stringify(v2Input()), cost: 0.02 });
    const r = await buildPlan({ date: DATE, entries: ENTRIES, now: EVENING }, deps());
    expect(r.status).toBe('draft');
    expect(r.plan!.version).toBe(1);
    const plain = finalizePlan(v1Input(), {
      version: 1,
      date: DATE,
      sourceWindow: validPlan().sourceWindow,
    });
    expect(JSON.stringify(r.plan)).toBe(JSON.stringify(plain.plan));
    expect(r.md).toBe(plain.md);
    expect(r.md).not.toContain('### ');
  });

  it('even broken variants do not fail the fallback plan', async () => {
    const answer = v2Input([{ platform: 'threads', text: 'тире — тут' }], VARIANTS);
    fake.replies.push({ content: JSON.stringify(answer), cost: 0.02 });
    const r = await buildPlan({ date: DATE, entries: ENTRIES, now: EVENING }, deps());
    expect(r.status).toBe('draft');
    expect(fake.requests).toHaveLength(1);
  });

  it('the stored fallback draft has no variant rows', async () => {
    fake.replies.push({ content: JSON.stringify(v2Input()), cost: 0.02 });
    const result = await runFallback(
      { store, plan: deps(), windowEntries: async () => ({ available: true, entries: ENTRIES }) },
      DATE,
      EVENING,
    );
    expect(result).toBe('draft');
    expect(JSON.parse(store.plans.get(DATE)!.json).version).toBe(1);
    expect(store.plans.get(DATE)!.json).not.toContain('variants');
    expect(store.slots.listForPlan(DATE)).toHaveLength(2);
    expect(store.slotVariants.listForPlan(DATE)).toEqual([]);
  });

  it('its prompt does not ask for variants', async () => {
    fake.replies.push({ content: JSON.stringify(v1Input()), cost: 0.02 });
    await buildPlan({ date: DATE, entries: ENTRIES, now: EVENING }, deps());
    const prompt = fake.requests[0]!.body.messages.map((m) => m.content).join('\n');
    expect(prompt).not.toMatch(/variants|threads|linkedin/i);
  });
});

describe('a stored v2 plan in the prompt context', () => {
  const before = '2026-10-10';
  const base = { version: 1 as const, date: before, sourceWindow: validPlan().sourceWindow };
  const onDay = (input: ReturnType<typeof v1Input>) => {
    const text = JSON.stringify(input).replaceAll(DATE, before);
    return JSON.parse(text) as ReturnType<typeof v1Input>;
  };

  it('counts as the plan of the day before, exactly as the same plan without variants', () => {
    const v2 = finalizePlan(onDay(v2Input()), base, { variants: true });
    expect(v2.plan!.version).toBe(2);
    saveDraft(store, { plan: v2.plan!, md: v2.md! });
    const ctx = loadPromptContext(store, DATE, EVENING);
    expect(ctx.previousPlans).toHaveLength(1);
    expect(ctx.previousPlans[0]).toEqual(v2.plan);
    expect(lastOpenQuestion(ctx.previousPlans)).toBe('Почему партии одинаковые?');
    const withV2 = buildPrompt({ date: DATE, entries: ENTRIES, ...deps().prompts, ...ctx });

    // The same day stored as a v1 plan gives the same prompt, byte for byte.
    const other = openStore(':memory:');
    try {
      const v1 = finalizePlan(onDay(v1Input()), base);
      saveDraft(other, { plan: v1.plan!, md: v1.md! });
      const plain = buildPrompt({
        date: DATE,
        entries: ENTRIES,
        ...deps().prompts,
        ...loadPromptContext(other, DATE, EVENING),
      });
      expect(withV2).toEqual(plain);
    } finally {
      other.close();
    }
    const text = withV2.map((m) => m.content).join('\n');
    expect(text).toContain('Кто нарушит тишину первым?');
    // The closing question of each variant is its own: none of them reaches the prompt.
    for (const v of VARIANTS) expect(text).not.toContain(v.text.split('\n').pop());
  });
});
