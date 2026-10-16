import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createScheduler,
  FALLBACK_HOLD_MS,
  localClock,
  nextDay,
  runFallback,
  type EveningOptions,
  type WindowEntriesPort,
} from '../../src/jobs/evening.js';
import { createOpenRouterClient } from '../../src/llm/openrouter.js';
import type { BuildPlanDeps } from '../../src/plan/build.js';
import { SIGNATURE_LINE } from '../../src/plan/pipeline.js';
import { PlanV1Schema } from '../../src/plan/schema.js';
import { openStore, type Store } from '../../src/store/index.js';
import { FakeOpenRouter } from '../llm/fake-openrouter.js';
import { DATE, ENTRIES, llmPayload } from '../plan/fixtures.js';

const KEY = 'fake-openrouter-key-for-tests';
/** `HH:MM` MSK on the evening before DATE (2026-10-10), as an instant. */
const msk = (hhmm: string, day = '2026-10-10') => new Date(`${day}T${hhmm}:00+03:00`);

let fake: FakeOpenRouter;
let dir: string;
const stores: Store[] = [];
beforeEach(async () => {
  fake = await new FakeOpenRouter().start();
  dir = mkdtempSync(join(tmpdir(), 'jrn-jobs-'));
});
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

const fileStore = () => {
  const s = openStore(join(dir, 'journalist.db'));
  stores.push(s);
  return s;
};

const planDeps = (store: Store, over: Partial<BuildPlanDeps> = {}): BuildPlanDeps => ({
  store,
  llm: createOpenRouterClient({ apiKey: KEY, model: 'vendor/writer', baseUrl: fake.baseUrl }),
  capUsd: 1,
  estimateUsd: 0.1,
  prompts: { styleBible: 'BIBLE', criteria: 'CRITERIA', rules: 'RULES' },
  ...over,
});

const testPort: WindowEntriesPort = async () => ({ available: true, entries: ENTRIES });

function scheduler(store: Store, at: () => Date, over: Partial<EveningOptions> = {}) {
  return createScheduler({ store, tz: 'Europe/Moscow', plan: planDeps(store), now: at, ...over });
}

/** A plan for DATE written at `at` (default 20:00 MSK the evening before, inside the deadline). */
const draft = (
  store: Store,
  status: 'draft' | 'approved' | 'rejected' | 'failed' = 'draft',
  at = msk('20:00'),
) => store.plans.upsert({ date: DATE, status, json: '{}', md: `# ${status}` }, at);

const kinds = (store: Store) => store.alerts.list().map((a) => a.kind);

describe('clock helpers', () => {
  it('reads the local date and minutes in the zone', () => {
    expect(localClock(new Date('2026-10-10T17:30:00Z'), 'Europe/Moscow')).toEqual({
      date: '2026-10-10',
      minutes: 20 * 60 + 30,
    });
    expect(localClock(new Date('2026-10-10T21:10:00Z'), 'Europe/Moscow')).toEqual({
      date: '2026-10-11',
      minutes: 10,
    });
    expect(nextDay('2026-10-31')).toBe('2026-11-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
  });

  it('refuses an invalid zone at creation', () => {
    const s = openStore(':memory:');
    stores.push(s);
    expect(() => scheduler(s, () => msk('20:00'), { tz: 'Mars/Olympus' })).toThrow();
  });
});

describe('20:30 fallback', () => {
  it('does nothing before 20:30', async () => {
    const s = fileStore();
    fake.failOnRequest = true;
    expect(await scheduler(s, () => msk('20:29'), { windowEntries: testPort }).tick()).toEqual([]);
    expect(fake.requests).toHaveLength(0);
    expect(s.jobRuns.get('fallback', DATE)).toBeUndefined();
  });

  it.each(['draft', 'approved', 'rejected'] as const)(
    'with a %s plan for tomorrow the fake OpenRouter gets zero requests',
    async (status) => {
      const s = fileStore();
      draft(s, status);
      fake.failOnRequest = true;
      const out = await scheduler(s, () => msk('20:30'), { windowEntries: testPort }).tick();
      expect(out).toEqual([`fallback: skipped: plan is ${status}`]);
      expect(fake.requests).toHaveLength(0);
      expect(s.plans.get(DATE)?.status).toBe(status);
    },
  );

  it('with no plan and a plugged port: one request and a signed draft is stored', async () => {
    const s = fileStore();
    fake.replies.push({ content: llmPayload(), cost: 0.03 });
    const out = await scheduler(s, () => msk('20:31'), { windowEntries: testPort }).tick();
    expect(out).toEqual(['fallback: draft']);
    expect(fake.requests).toHaveLength(1);
    const p = s.plans.get(DATE)!;
    expect(p.status).toBe('draft');
    expect(p.inputSha256).toBeNull();
    const plan = PlanV1Schema.parse(JSON.parse(p.json));
    expect(plan.sourceWindow.entryIds).toEqual(['e1', 'e2']);
    for (const sl of plan.slots) expect(sl.text.endsWith(SIGNATURE_LINE)).toBe(true);
    expect(s.slots.listForPlan(DATE).map((x) => x.slotId)).toEqual(['s1', 's2']);
    expect(p.md).toContain('План Кореша на 11.10.2026');
  });

  it('with a failed plan it runs and replaces it', async () => {
    const s = fileStore();
    draft(s, 'failed');
    fake.replies.push({ content: llmPayload() });
    await scheduler(s, () => msk('20:31'), { windowEntries: testPort }).tick();
    expect(fake.requests).toHaveLength(1);
    expect(s.plans.get(DATE)?.status).toBe('draft');
  });

  it('with the default port: no request, a fallback_unavailable alert, no plan', async () => {
    const s = fileStore();
    fake.failOnRequest = true;
    const out = await scheduler(s, () => msk('20:30')).tick();
    expect(out).toEqual(['fallback: unavailable']);
    expect(fake.requests).toHaveLength(0);
    expect(kinds(s)).toEqual(['fallback_unavailable']);
    expect(s.plans.get(DATE)).toBeUndefined();
  });

  it('an LLM failure (no cap set) alerts and stores nothing', async () => {
    const s = fileStore();
    fake.failOnRequest = true;
    const sch = scheduler(s, () => msk('20:30'), {
      windowEntries: testPort,
      plan: planDeps(s, { capUsd: undefined }),
    });
    expect(await sch.tick()).toEqual(['fallback: failed: cap']);
    expect(fake.requests).toHaveLength(0);
    expect(kinds(s)).toEqual(['llm_cap', 'fallback_failed']);
    expect(s.plans.get(DATE)).toBeUndefined();
  });

  it('never overwrites a plan the director posted while the LLM was working', async () => {
    const s = fileStore();
    const racing: WindowEntriesPort = async () => {
      s.plans.upsert({ date: DATE, status: 'draft', json: '{}', md: 'director' });
      return { available: true, entries: ENTRIES };
    };
    fake.replies.push({ content: llmPayload() });
    const r = await runFallback(
      { store: s, plan: planDeps(s), windowEntries: racing },
      DATE,
      msk('20:30'),
    );
    expect(r).toBe('discarded: plan became draft');
    expect(s.plans.get(DATE)?.md).toBe('director');
  });
});

describe('21:00 no_plan and 23:00 approve', () => {
  it('21:00 with no plan writes a no_plan alert; with a failed plan too', async () => {
    const a = openStore(':memory:');
    stores.push(a);
    expect(await scheduler(a, () => msk('21:00')).tick()).toEqual([
      'fallback: skipped: after 21:00',
      'no_plan: alert: absent',
    ]);
    expect(kinds(a)).toEqual(['no_plan']);

    const b = openStore(':memory:');
    stores.push(b);
    draft(b, 'failed');
    expect(await scheduler(b, () => msk('21:05')).tick()).toEqual([
      'fallback: skipped: after 21:00',
      'no_plan: alert: failed',
    ]);
    expect(kinds(b)).toEqual(['no_plan']);
  });

  it('21:00 with a draft: no alert', async () => {
    const s = fileStore();
    draft(s);
    await scheduler(s, () => msk('21:00')).tick();
    expect(kinds(s)).toEqual([]);
  });

  it('23:00 approves a draft; a rejected plan stays rejected', async () => {
    const s = fileStore();
    draft(s);
    const out = await scheduler(s, () => msk('23:00')).tick();
    expect(out).toContain('approve: approved');
    expect(s.plans.get(DATE)?.status).toBe('approved');

    const r = openStore(':memory:');
    stores.push(r);
    draft(r, 'rejected');
    expect(await scheduler(r, () => msk('23:00')).tick()).toContain('approve: kept: rejected');
    expect(r.plans.get(DATE)?.status).toBe('rejected');
  });

  it('P-7: 23:00 approves a draft stored at 21:59, not one stored at 22:00 (alert)', async () => {
    const ok = fileStore();
    draft(ok, 'draft', msk('21:59'));
    expect(await scheduler(ok, () => msk('23:00')).tick()).toContain('approve: approved');

    const late = openStore(':memory:');
    stores.push(late);
    draft(late, 'draft', msk('22:00'));
    expect(await scheduler(late, () => msk('23:00')).tick()).toContain(
      'approve: kept: draft stored after 22:00',
    );
    expect(late.plans.get(DATE)?.status).toBe('draft');
    expect(kinds(late)).toEqual(['draft_too_late']);
  });

  it('22:59 does not approve yet', async () => {
    const s = fileStore();
    draft(s);
    await scheduler(s, () => msk('22:59')).tick();
    expect(s.plans.get(DATE)?.status).toBe('draft');
  });
});

describe('once per (job, date) across restarts and processes', () => {
  it('two instances on one DB file: one fallback call at 20:45, one approval at 23:05', async () => {
    const a = fileStore();
    const b = fileStore();
    fake.replies.push({ content: llmPayload() });
    fake.replies.push({ content: llmPayload() }); // would be used by a second, wrong call
    const run = (at: () => Date) =>
      Promise.all([
        scheduler(a, at, { windowEntries: testPort }).tick(),
        scheduler(b, at, { windowEntries: testPort }).tick(),
      ]).then(([x, y]) => [...x, ...y].sort());
    expect(await run(() => msk('20:45'))).toEqual(['fallback: draft']);
    expect(fake.requests).toHaveLength(1);
    expect(await run(() => msk('23:05'))).toEqual([
      'approve: approved',
      'no_plan: ok: plan is draft',
    ]);
    expect(a.plans.get(DATE)?.status).toBe('approved');
    expect(kinds(a)).toEqual([]);

    // Restart: a third instance on the same file runs nothing again.
    a.close();
    const c = fileStore();
    expect(await scheduler(c, () => msk('23:30'), { windowEntries: testPort }).tick()).toEqual([]);
    expect(await scheduler(b, () => msk('23:59'), { windowEntries: testPort }).tick()).toEqual([]);
    expect(fake.requests).toHaveLength(1);
  });

  it('review L-1: plan absent, two instances and a restart at 21:00 -> exactly one no_plan', async () => {
    const a = fileStore();
    const b = fileStore();
    const at = () => msk('21:00');
    await Promise.all([scheduler(a, at).tick(), scheduler(b, at).tick()]);
    a.close();
    const c = fileStore();
    await scheduler(c, () => msk('21:01')).tick();
    expect(kinds(c)).toEqual(['no_plan']);
    expect(c.jobRuns.get('no_plan', DATE)?.result).toBe('alert: absent');
  });

  it('review M-2: down 20:00-23:05, the restart makes no fallback draft and approves nothing', async () => {
    const s = fileStore();
    fake.failOnRequest = true;
    expect(await scheduler(s, () => msk('23:05'), { windowEntries: testPort }).tick()).toEqual([
      'fallback: skipped: after 21:00',
      'no_plan: alert: absent',
      'approve: no plan',
    ]);
    expect(fake.requests).toHaveLength(0);
    expect(s.plans.get(DATE)).toBeUndefined();
    expect(kinds(s)).toEqual(['no_plan']);
  });

  it('a restart after 23:00 still approves the pending draft for tomorrow', async () => {
    const first = fileStore();
    draft(first);
    // The process ran until 22:00 and was down at 23:00.
    expect(await scheduler(first, () => msk('22:00')).tick()).toEqual([
      'fallback: skipped: after 21:00',
      'no_plan: ok: plan is draft',
    ]);
    first.close();
    const second = fileStore();
    expect(await scheduler(second, () => msk('23:40')).tick()).toEqual(['approve: approved']);
    expect(second.plans.get(DATE)?.status).toBe('approved');
  });

  it('catch-up is for the same evening only: after midnight the missed draft is not approved', async () => {
    const s = fileStore();
    draft(s);
    const out = await scheduler(s, () => msk('00:10', '2026-10-11')).tick();
    expect(out).toEqual([]);
    expect(s.plans.get(DATE)?.status).toBe('draft');
  });

  it('later jobs wait while another process holds an unfinished fallback', async () => {
    const s = fileStore();
    s.jobRuns.claim('fallback', DATE, msk('20:58')); // claimed elsewhere, still running
    expect(await scheduler(s, () => msk('21:01')).tick()).toEqual([]);
    expect(kinds(s)).toEqual([]);
    const later = new Date(msk('20:58').getTime() + FALLBACK_HOLD_MS);
    expect(await scheduler(s, () => later).tick()).toEqual(['no_plan: alert: absent']);
  });

  it('start() ticks at once and stop() waits for it', async () => {
    const s = fileStore();
    draft(s);
    const sch = scheduler(s, () => msk('23:00'), { intervalMs: 10_000 });
    sch.start();
    await sch.stop();
    expect(s.plans.get(DATE)?.status).toBe('approved');
  });
});

describe('review I-1: missed approval at startup', () => {
  const morning = () => msk('00:10', DATE);

  it("today's plan still a draft after midnight -> one approve_missed alert", async () => {
    const a = fileStore();
    draft(a);
    const sch = scheduler(a, morning);
    sch.start(); // the startup check runs before the first tick
    await sch.stop();
    expect(kinds(a)).toEqual(['approve_missed']);
    expect(a.alerts.list()[0]!.message).toContain(DATE);
    // A restart (or a second instance) does not repeat it.
    const b = fileStore();
    expect(scheduler(b, morning).checkMissedApproval()).toBeUndefined();
    expect(kinds(b)).toEqual(['approve_missed']);
    expect(a.plans.get(DATE)?.status).toBe('draft');
  });

  it.each(['approved', 'rejected', 'failed'] as const)('no alert for a %s plan', (status) => {
    const s = fileStore();
    draft(s, status);
    expect(scheduler(s, morning).checkMissedApproval()).toBeUndefined();
    expect(kinds(s)).toEqual([]);
  });

  it('no alert without a plan for today', () => {
    const s = fileStore();
    expect(scheduler(s, morning).checkMissedApproval()).toBeUndefined();
    expect(kinds(s)).toEqual([]);
  });
});
