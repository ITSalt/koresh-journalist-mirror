import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createOpenRouterClient } from '../../src/llm/openrouter.js';
import {
  buildPlan,
  planDepsFromConfig,
  SIGNATURE_LINE,
  TEXT_MAX_RAW,
  type BuildPlanDeps,
} from '../../src/plan/build.js';
import { loadPromptTexts } from '../../src/plan/prompt.js';
import { PlanV1Schema } from '../../src/plan/schema.js';
import { openStore, type Store } from '../../src/store/index.js';
import { FakeOpenRouter } from '../llm/fake-openrouter.js';
import { DATE, ENTRIES, llmPayload, validPlan } from './fixtures.js';

const now = new Date('2026-10-10T16:00:00Z'); // 19:00 MSK on the 10th, plan for the 11th
const SPEND_DAY = '2026-10-10';
const KEY = 'fake-openrouter-key-for-tests';

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

const deps = (over: Partial<BuildPlanDeps> = {}): BuildPlanDeps => ({
  store,
  llm: createOpenRouterClient({ apiKey: KEY, model: 'vendor/writer', baseUrl: fake.baseUrl }),
  capUsd: 1,
  estimateUsd: 0.1,
  prompts: { styleBible: 'BIBLE', criteria: 'CRITERIA', rules: 'RULES' },
  ...over,
});
const run = (d = deps()) => buildPlan({ date: DATE, entries: ENTRIES, now }, d);

describe('buildPlan with a fake OpenRouter', () => {
  it('builds a valid draft plan, md and records the cost from usage.cost', async () => {
    fake.replies.push({ content: llmPayload(), cost: 0.0512 });
    const r = await run();
    expect(r.status).toBe('draft');
    expect(r.reason).toBeUndefined();
    expect(PlanV1Schema.safeParse(r.plan).success).toBe(true);
    expect(r.plan!.date).toBe(DATE);
    expect(r.plan!.sourceWindow).toEqual({
      from: ENTRIES[0]!.at,
      to: ENTRIES[1]!.at,
      entryIds: ['e1', 'e2'],
    });
    expect(r.md).toContain('План Кореша на 11.10.2026');
    expect(r.costUsd).toBeCloseTo(0.0512);
    expect(store.spend.forDay(SPEND_DAY)).toBeCloseTo(0.0512);
    expect(fake.requests).toHaveLength(1);
    expect(store.plans.get(DATE)).toBeUndefined(); // storing is WP-SVC-10's
  });

  it('appends the signature line to every post text (D-9)', async () => {
    fake.replies.push({ content: llmPayload() });
    const r = await run();
    expect(r.plan!.slots.length).toBe(2);
    for (const [i, s] of r.plan!.slots.entries()) {
      expect(s.text.endsWith(`\n\n${SIGNATURE_LINE}`)).toBe(true);
      expect(s.text.startsWith(validPlan().slots[i]!.text)).toBe(true);
    }
    expect(r.md!.split(SIGNATURE_LINE)).toHaveLength(3);
  });

  it('does not double the signature when the model already wrote it', async () => {
    const p = validPlan();
    p.slots[0]!.text += '\n\nИИ-журналист-правдорубец Кореш Шпандент';
    fake.replies.push({ content: llmPayload({ slots: p.slots }) });
    const r = await run();
    expect(r.plan!.slots[0]!.text.split('Кореш Шпандент')).toHaveLength(2);
  });

  it('L-2: a decorated signature in a poll text is replaced, not doubled', async () => {
    const p = validPlan();
    p.slots[1]!.text += '\n\n**ИИ-журналист-правдорубец Кореш Шпандент** 🤖';
    fake.replies.push({ content: llmPayload({ slots: p.slots }) });
    const r = await run();
    expect(r.status).toBe('draft');
    expect(r.plan!.slots[1]!.text.split('Кореш Шпандент')).toHaveLength(2);
    expect(r.plan!.slots[1]!.text.endsWith(`\n\n${SIGNATURE_LINE}`)).toBe(true);
  });

  it('L-4: a URL with "?" on the last line is not a question', async () => {
    const p = validPlan();
    p.slots[0]!.text = 'Текст.\n\nПодробности: https://example.org/page?a=1';
    fake.replies.push({ content: llmPayload({ slots: p.slots }) });
    fake.replies.push({ content: llmPayload({ slots: p.slots }) });
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/slots\.0\.text: a post must end with a plain question/);
  });

  it('repairs invalid JSON once, sending the parse error back', async () => {
    fake.replies.push({ content: '{"arc": {"title": "x"', cost: 0.02 });
    fake.replies.push({ content: '```json\n' + llmPayload() + '\n```', cost: 0.03 });
    const r = await run();
    expect(r.status).toBe('draft');
    expect(fake.requests).toHaveLength(2);
    const second = fake.requests[1]!.body.messages;
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(second[2]!.content).toBe('{"arc": {"title": "x"');
    expect(second[3]!.content).toMatch(/JSON/);
    expect(r.costUsd).toBeCloseTo(0.05);
    expect(store.spend.forDay(SPEND_DAY)).toBeCloseTo(0.05);
  });

  it('repairs a schema error, listing the validation errors', async () => {
    const p = validPlan();
    delete p.slots[1]!.poll;
    fake.replies.push({ content: llmPayload({ slots: p.slots }) });
    fake.replies.push({ content: llmPayload() });
    const r = await run();
    expect(r.status).toBe('draft');
    expect(fake.requests[1]!.body.messages[3]!.content).toContain('slots.1.poll');
  });

  it('fails after the second invalid answer', async () => {
    fake.replies.push({ content: 'not json', cost: 0.01 });
    fake.replies.push({ content: '{"slots": "nope"}', cost: 0.01 });
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/^invalid: /);
    expect(r.plan).toBeUndefined();
    expect(fake.requests).toHaveLength(2);
    expect(r.costUsd).toBeCloseTo(0.02);
  });

  it('over the cap: fails with reason cap, makes no request, writes an alert', async () => {
    fake.failOnRequest = true;
    store.spend.add(0.95, now);
    const r = await run();
    expect(r).toEqual({ status: 'failed', reason: 'cap', costUsd: 0 });
    expect(fake.requests).toHaveLength(0);
    expect(store.alerts.list().map((a) => a.kind)).toEqual(['llm_cap']);
    expect(store.spend.forDay(SPEND_DAY)).toBeCloseTo(0.95);
  });

  it('hits the cap on the repair call: no second request', async () => {
    store.spend.add(0.8, now);
    fake.replies.push({ content: 'not json', cost: 0.15 });
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('cap');
    expect(fake.requests).toHaveLength(1);
    expect(r.costUsd).toBeCloseTo(0.15);
  });

  it('refuses a post without a question at the end, then accepts the repaired one', async () => {
    const p = validPlan();
    p.slots[0]!.text = 'Новости от Корпорации всевластия\n\nВопросов нет.';
    fake.replies.push({ content: llmPayload({ slots: p.slots }) });
    fake.replies.push({ content: llmPayload() });
    const r = await run();
    expect(r.status).toBe('draft');
    expect(fake.requests[1]!.body.messages[3]!.content).toMatch(/slots\.0\.text: .*question/);
  });

  it('accepts a question line followed by the answer deadline', async () => {
    const p = validPlan();
    p.slots[0]!.text = 'Текст.\n\n❓ Кто первым?';
    fake.replies.push({ content: llmPayload({ slots: p.slots }) });
    expect((await run()).status).toBe('draft');
  });

  it('does not require a question on a poll slot', async () => {
    const p = validPlan();
    p.slots[1]!.text = 'Голосуйте ниже.';
    fake.replies.push({ content: llmPayload({ slots: p.slots }) });
    expect((await run()).status).toBe('draft');
  });

  it(`refuses a text over ${TEXT_MAX_RAW} chars after signing`, async () => {
    const p = validPlan();
    const tail = '\n\n❓ Вопрос?';
    const room = TEXT_MAX_RAW - `\n\n${SIGNATURE_LINE}`.length - tail.length;
    p.slots[0]!.text = 'а'.repeat(room) + tail; // exactly at the limit once signed
    fake.replies.push({ content: llmPayload({ slots: p.slots }) });
    const ok = await run();
    expect(ok.status).toBe('draft');
    expect(ok.plan!.slots[0]!.text.length).toBe(TEXT_MAX_RAW);

    p.slots[0]!.text = 'а'.repeat(room + 1) + tail;
    fake.replies.push({ content: llmPayload({ slots: p.slots }) });
    fake.replies.push({ content: llmPayload({ slots: p.slots }) });
    const bad = await run();
    expect(bad.status).toBe('failed');
    expect(bad.reason).toMatch(/3501 chars/);
  });

  it('empty entries: a draft with zero slots and a reason, no LLM call', async () => {
    fake.failOnRequest = true;
    const r = await buildPlan({ date: DATE, entries: [], now }, deps());
    expect(r.status).toBe('draft');
    expect(r.plan!.slots).toEqual([]);
    expect(PlanV1Schema.safeParse(r.plan).success).toBe(true);
    expect(r.reason).toMatch(/no entries/);
    expect(r.md).toContain('Публикаций нет.');
    expect(r.costUsd).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  it('never sends a private entry to the LLM', async () => {
    fake.replies.push({ content: llmPayload() });
    const secret = {
      id: 'p1',
      at: ENTRIES[0]!.at,
      source: 'dm',
      text: 'PRIVATE-MARKER',
      private: true,
    };
    await buildPlan({ date: DATE, entries: [...ENTRIES, secret], now }, deps());
    expect(JSON.stringify(fake.requests[0]!.body)).not.toContain('PRIVATE-MARKER');
  });

  it('fails on an LLM error with the estimate kept as cost', async () => {
    fake.replies.push({ status: 502, body: { error: { message: 'bad gateway' } } });
    const r = await run();
    expect(r).toMatchObject({ status: 'failed', costUsd: 0.1 });
    expect(r.reason).toMatch(/^llm: .*502/);
  });

  it('fails without an LLM client (no key or model), making no request', async () => {
    const r = await run(deps({ llm: undefined }));
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/OPENROUTER_API_KEY/);
    expect(fake.requests).toHaveLength(0);
  });

  it('puts feedback of 10 days ago into the prompt and not that of 20 days ago', async () => {
    const day = 86_400_000;
    store.feedback.add(
      { planDate: '2026-09-30', verdict: 'dislike', note: 'NOTE-10-DAYS: меньше канцелярита' },
      new Date(now.getTime() - 10 * day),
    );
    store.feedback.add(
      { planDate: '2026-09-20', verdict: 'like', note: 'NOTE-20-DAYS' },
      new Date(now.getTime() - 20 * day),
    );
    fake.replies.push({ content: llmPayload() });
    await run();
    const prompt = fake.requests[0]!.body.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('NOTE-10-DAYS: меньше канцелярита');
    expect(prompt).not.toContain('NOTE-20-DAYS');
  });
});

describe('planDepsFromConfig', () => {
  it('wires config: model, cap, estimate, committed prompts', () => {
    const d = planDepsFromConfig(
      loadConfig({
        OPENROUTER_API_KEY: KEY,
        OPENROUTER_MODEL: 'vendor/writer',
        LLM_DAILY_CAP_USD: '1',
        LLM_ESTIMATE_USD: '0.2',
      }),
      store,
    );
    expect(d.llm?.model).toBe('vendor/writer');
    expect(d.capUsd).toBe(1);
    expect(d.estimateUsd).toBe(0.2);
    expect(d.prompts).toEqual(loadPromptTexts());
  });

  it('leaves llm undefined without a key or a model, and lets a model override', () => {
    expect(planDepsFromConfig(loadConfig({ OPENROUTER_MODEL: 'm' }), store).llm).toBeUndefined();
    expect(planDepsFromConfig(loadConfig({ OPENROUTER_API_KEY: KEY }), store).llm).toBeUndefined();
    const d = planDepsFromConfig(loadConfig({ OPENROUTER_API_KEY: KEY }), store, { model: 'x/y' });
    expect(d.llm?.model).toBe('x/y');
  });
});
