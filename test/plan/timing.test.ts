import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenRouterClient } from '../../src/llm/openrouter.js';
import { buildPlan, type BuildPlanDeps } from '../../src/plan/build.js';
import { finalizePlan, type PlanBase } from '../../src/plan/pipeline.js';
import { renderPlanMd } from '../../src/plan/render.js';
import {
  isRoundAt,
  previousDay,
  timingWarnings,
  yesterdayTimes,
  type PlanWarning,
} from '../../src/plan/timing.js';
import { openStore, type Store } from '../../src/store/index.js';
import { FakeOpenRouter } from '../llm/fake-openrouter.js';
import { DATE, ENTRIES, llmPayload, validPlan } from './fixtures.js';

// WP-SVC-25: round times are refused at the intake (the pipeline POST and the fallback share),
// a slot at a minute of yesterday's plan gets a warning.

const at = (hhmm: string) => `${DATE}T${hhmm}+03:00`;

describe('isRoundAt', () => {
  it.each(['19:00:00', '19:00', '09:15:00', '12:30', '18:45:00', '00:00', '23:45:00'])(
    '%s is round',
    (t) => expect(isRoundAt(at(t))).toBe(true),
  );
  it.each(['19:00:07', '19:07', '12:03:00', '19:09:53', '18:45:01', '09:16:00', '12:30:59'])(
    '%s is not round',
    (t) => expect(isRoundAt(at(t))).toBe(false),
  );
});

describe('previousDay, timingWarnings', () => {
  it('previousDay crosses month and year', () => {
    expect(previousDay('2026-10-11')).toBe('2026-10-10');
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
    expect(previousDay('2027-01-01')).toBe('2026-12-31');
  });

  it('warns on the same HH:MM whatever the seconds, with path and slot id', () => {
    const w = timingWarnings(
      [
        { id: 's1', at: at('09:07:21') },
        { id: 's2', at: at('19:09:41') },
      ],
      new Set(['19:09']),
    );
    expect(w).toEqual<PlanWarning[]>([
      {
        path: 'slots.1.at',
        slotId: 's2',
        code: 'same_time_as_yesterday',
        message: expect.stringContaining('19:09') as string,
      },
    ]);
    expect(timingWarnings([{ id: 's1', at: at('09:07:21') }], new Set())).toEqual([]);
  });
});

const base = (): PlanBase => {
  const { version, date, sourceWindow } = validPlan();
  return { version, date, sourceWindow };
};
const withTimes = (...times: string[]) => {
  const p = validPlan();
  const slots = times.map((t, i) => ({ ...p.slots[0]!, id: `s${i + 1}`, at: at(t) }));
  return { arc: p.arc, slots };
};
const codes = (f: ReturnType<typeof finalizePlan>) =>
  (f.errors ?? []).map((e) => `${e.path}|${e.slotId}|${e.code}`);

describe('finalizePlan: round_time', () => {
  it.each(['19:00:00', '19:00', '09:15:00', '12:30', '18:45:00'])('%s: round_time', (t) => {
    const f = finalizePlan(withTimes(t), base());
    expect(codes(f)).toEqual(['slots.0.at|s1|round_time']);
    expect(f.errors![0]!.message).toContain('round time');
  });

  it.each(['19:00:07', '19:07', '12:03:00', '19:09:53'])('%s passes', (t) => {
    const f = finalizePlan(withTimes(t), base());
    expect(f.errors).toBeUndefined();
    expect(f.plan!.slots[0]!.at).toBe(at(t));
  });

  it('a poll slot is checked too, and every round slot is reported at once', () => {
    const p = validPlan();
    const slots = [
      { ...p.slots[0]!, at: at('09:00:00') },
      { ...p.slots[1]!, at: at('19:07:34') },
      { ...p.slots[0]!, id: 's3', at: at('21:30') },
    ];
    expect(codes(finalizePlan({ arc: p.arc, slots }, base()))).toEqual([
      'slots.0.at|s1|round_time',
      'slots.2.at|s3|round_time',
    ]);
    const poll = [{ ...p.slots[1]!, at: at('19:00:00') }];
    expect(codes(finalizePlan({ arc: p.arc, slots: poll }, base()))).toEqual([
      'slots.0.at|s2|round_time',
    ]);
  });

  it('seconds alone make a quarter fine, minutes alone make a non-quarter fine', () => {
    expect(finalizePlan(withTimes('19:00:01'), base()).errors).toBeUndefined();
    expect(finalizePlan(withTimes('19:01:00'), base()).errors).toBeUndefined();
  });
});

describe('finalizePlan: same_time_as_yesterday', () => {
  it('returns the warning, does not block, and shows it at the top of plan.md', () => {
    const f = finalizePlan(withTimes('19:09:41'), base(), { yesterday: new Set(['19:09']) });
    expect(f.errors).toBeUndefined();
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings![0]).toMatchObject({
      path: 'slots.0.at',
      slotId: 's1',
      code: 'same_time_as_yesterday',
    });
    const md = f.md!;
    expect(md.indexOf('Предупреждения')).toBeGreaterThan(0);
    expect(md.indexOf('Предупреждения')).toBeLessThan(md.indexOf('## 19:09 МСК'));
    expect(md).toContain('слот s1, 19:09 МСК: то же время, что во вчерашнем плане');
  });

  it('without a match the plan.md is the one renderPlanMd gives and warnings are empty', () => {
    const f = finalizePlan(withTimes('19:08:41'), base(), { yesterday: new Set(['19:09']) });
    expect(f.warnings).toEqual([]);
    expect(f.md).toBe(renderPlanMd(f.plan!));
    expect(f.md).not.toContain('Предупреждения');
  });
});

describe('yesterdayTimes', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  const seedDay = (
    date: string,
    status: 'draft' | 'approved' | 'rejected' | 'failed',
    t: string,
  ) => {
    store.plans.upsert({ date, status: 'draft', json: '{}', md: '' });
    store.slots.replaceForPlan(date, [
      { slotId: 's1', at: `${date}T${t}+03:00`, kind: 'post', json: '{}' },
    ]);
    if (status !== 'draft') store.plans.setStatus(date, status);
  };

  it.each(['draft', 'approved', 'rejected'] as const)('counts a %s plan', (status) => {
    seedDay('2026-10-10', status, '19:09:12');
    expect([...yesterdayTimes(store, DATE)]).toEqual(['19:09']);
  });

  it('ignores a failed plan, other days and a missing plan', () => {
    seedDay('2026-10-10', 'failed', '19:09:12');
    seedDay('2026-10-09', 'approved', '08:05:00');
    expect(yesterdayTimes(store, DATE).size).toBe(0);
    expect(yesterdayTimes(store, '2026-12-01').size).toBe(0);
  });
});

describe('the fallback (buildPlan) shares the intake rules', () => {
  const now = new Date('2026-10-10T16:00:00Z');
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
  const deps = (): BuildPlanDeps => ({
    store,
    llm: createOpenRouterClient({ apiKey: KEY, model: 'vendor/writer', baseUrl: fake.baseUrl }),
    capUsd: 1,
    estimateUsd: 0.1,
    prompts: { styleBible: 'BIBLE', criteria: 'CRITERIA', rules: 'RULES' },
  });
  const run = () => buildPlan({ date: DATE, entries: ENTRIES, now }, deps());

  it('a round time comes back as round_time in the repair message, then the fix is accepted', async () => {
    const p = validPlan();
    fake.replies.push({
      content: llmPayload({ slots: p.slots.map((s) => ({ ...s, at: at('19:00:00') })) }),
    });
    fake.replies.push({ content: llmPayload() });
    const r = await run();
    expect(r.status).toBe('draft');
    expect(fake.requests).toHaveLength(2);
    const second = JSON.stringify(fake.requests[1]);
    expect(second).toContain('round');
    expect(second).toContain('slots.0.at');
  });

  it('two round answers in a row fail the run', async () => {
    const round = llmPayload({
      slots: validPlan().slots.map((s) => ({ ...s, at: at('09:30:00') })),
    });
    fake.replies.push({ content: round }, { content: round });
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('slots.0.at');
  });

  it("puts yesterday's minutes into the warnings block of plan.md", async () => {
    store.plans.upsert({ date: '2026-10-10', status: 'approved', json: '{}', md: '' });
    store.slots.replaceForPlan('2026-10-10', [
      { slotId: 's1', at: '2026-10-10T09:07:50+03:00', kind: 'post', json: '{}' },
    ]);
    fake.replies.push({ content: llmPayload() });
    const r = await run();
    expect(r.status).toBe('draft');
    expect(r.md).toContain('Предупреждения');
    expect(r.md).toContain('слот s1, 09:07 МСК');
  });
});
