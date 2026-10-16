import { beforeEveningOf, localClock, nextDay, POST_DEADLINE, toMinutes } from '../lib/clock.js';
import type { FeedEntry } from '../lib/feed-types.js';
import { buildPlan, type BuildPlanDeps } from '../plan/build.js';
import { LOCKED } from '../plan/intake.js';
import { saveDraft } from '../plan/pipeline.js';
import type { Store } from '../store/index.js';

// The evening plan step (D-10, D-14), all times in TZ_PLAN (Moscow), all for tomorrow's plan:
//   20:30 fallback  no draft/approved/rejected plan -> buildPlan via OpenRouter (under the cap);
//                   only until 21:00: later it is marked skipped, so a late fallback draft is never
//                   approved unseen in the same tick (review M-2)
//   21:00 no_plan   no plan, or a failed one -> alert `no_plan` (no posts that day)
//   22:00           deadline of the director's POST (P-7)
//   23:00 approve   a draft stored before 22:00 becomes approved; rejected stays rejected
// At startup: today's plan still `draft` (23:00 was missed) -> alert `approve_missed`.
// One in-process scheduler wakes every minute. A `job_runs` row per (job, date) is claimed before
// a job runs, so a job never runs twice for a date (restarts, two processes on one DB file), and
// a restart later the same evening still runs what is due. After midnight "tomorrow" moves on,
// so a missed evening is not caught up the next day.

export { localClock, nextDay } from '../lib/clock.js';

export type JobName = 'fallback' | 'no_plan' | 'approve' | 'approve_missed';

/** In run order; `at`/`until` are local wall-clock times in TZ_PLAN. */
export const JOBS: readonly { name: JobName; at: string; until?: string }[] = [
  { name: 'fallback', at: '20:30', until: '21:00' },
  { name: 'no_plan', at: '21:00' },
  { name: 'approve', at: '23:00' },
];

export const TICK_MS = 60_000;
/**
 * How long a claimed, unfinished fallback (another process mid-call) holds back the later jobs.
 * Two OpenRouter attempts of at most 120 s each fit in it.
 */
export const FALLBACK_HOLD_MS = 5 * 60_000;

export type WindowEntries =
  { available: true; entries: FeedEntry[] } | { available: false; reason: string };

/**
 * Entries for the fallback plan of `date`, already windowed and redacted. WP-SVC-17 plugs the
 * board's `selectWindow` + `redact` in here.
 */
export type WindowEntriesPort = (date: string, now: Date) => Promise<WindowEntries>;

/** Default port until WP-SVC-17: unavailable, so the fallback fails closed without an LLM call. */
export const unavailableWindow: WindowEntriesPort = async () => ({
  available: false,
  reason: 'the feed window port is not plugged in (WP-SVC-17)',
});

export interface Logger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface EveningOptions {
  store: Store;
  /** TZ_PLAN, an IANA zone. */
  tz: string;
  plan: BuildPlanDeps;
  windowEntries?: WindowEntriesPort;
  now?: () => Date;
  log?: Logger;
  intervalMs?: number;
}

/** 20:30: the OpenRouter fallback, only when the director has not delivered a plan. */
export async function runFallback(
  o: Pick<EveningOptions, 'store' | 'plan' | 'windowEntries'>,
  date: string,
  now: Date,
): Promise<string> {
  const { store } = o;
  const existing = store.plans.get(date);
  if (existing && (existing.status === 'draft' || LOCKED.has(existing.status))) {
    return `skipped: plan is ${existing.status}`;
  }
  const win = await (o.windowEntries ?? unavailableWindow)(date, now);
  if (!win.available) {
    store.alerts.add(
      {
        kind: 'fallback_unavailable',
        message: `no fallback plan for ${date}: ${win.reason}; the director must POST /v1/plans/${date}`,
      },
      now,
    );
    return 'unavailable';
  }
  const r = await buildPlan({ date, entries: win.entries, now }, o.plan);
  if (r.status !== 'draft' || !r.plan || !r.md) {
    store.alerts.add(
      { kind: 'fallback_failed', message: `fallback plan for ${date} failed: ${r.reason}` },
      now,
    );
    return `failed: ${r.reason}`;
  }
  const { plan, md } = r;
  // The director may have posted while the LLM was working: never overwrite that.
  return store.db
    .transaction(() => {
      const cur = store.plans.get(date);
      if (cur && cur.status !== 'failed') return `discarded: plan became ${cur.status}`;
      saveDraft(store, { plan, md }, null, now);
      return 'draft';
    })
    .immediate();
}

function noPlan(store: Store, date: string, now: Date): string {
  const p = store.plans.get(date);
  if (p && p.status !== 'failed') return `ok: plan is ${p.status}`;
  store.alerts.add(
    {
      kind: 'no_plan',
      message: `no plan for ${date}${p ? ' (the plan failed)' : ''}: nothing is published that day`,
    },
    now,
  );
  return p ? 'alert: failed' : 'alert: absent';
}

function approve(store: Store, date: string, tz: string, now: Date): string {
  const p = store.plans.get(date);
  if (!p) return 'no plan';
  if (p.status !== 'draft') return `kept: ${p.status}`;
  if (!beforeEveningOf(new Date(p.updatedAt), date, POST_DEADLINE, tz)) {
    store.alerts.add(
      {
        kind: 'draft_too_late',
        message: `the draft for ${date} was stored after ${POST_DEADLINE}; not approved, nothing is published`,
      },
      now,
    );
    return `kept: draft stored after ${POST_DEADLINE}`;
  }
  store.plans.setStatus(date, 'approved');
  return 'approved';
}

/** Claims (job, date) and runs a synchronous job in the same IMMEDIATE transaction. */
function runOnce(store: Store, job: JobName, date: string, now: Date, fn: () => string) {
  return store.db
    .transaction((): string | undefined => {
      if (!store.jobRuns.claim(job, date, now)) return undefined;
      const result = fn();
      store.jobRuns.finish(job, date, result);
      return result;
    })
    .immediate();
}

export interface Scheduler {
  /** Runs every job that is due and not yet run for tomorrow; returns `job: result` lines. */
  tick(): Promise<string[]>;
  /** Startup check: today's plan still `draft` -> one `approve_missed` alert per date. */
  checkMissedApproval(): string | undefined;
  start(): void;
  stop(): Promise<void>;
}

export function createScheduler(o: EveningOptions): Scheduler {
  const now = o.now ?? (() => new Date());
  const { store, tz, log } = o;
  localClock(new Date(), tz); // an invalid TZ_PLAN fails here, at startup
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<string[]> | undefined;

  async function due(): Promise<string[]> {
    const at = now();
    const local = localClock(at, tz);
    const date = nextDay(local.date);
    const done: string[] = [];
    for (const job of JOBS) {
      if (local.minutes < toMinutes(job.at)) continue;
      let result: string | undefined;
      try {
        if (job.until && local.minutes >= toMinutes(job.until)) {
          // Past its window (e.g. a restart after 21:00): marked skipped, never run late.
          result = runOnce(store, job.name, date, at, () => `skipped: after ${job.until}`);
          if (result === undefined) continue;
        } else if (job.name === 'fallback') {
          if (!store.jobRuns.claim('fallback', date, at)) continue;
          // Claimed before the call: a crash mid-call never leads to a second LLM call.
          result = await runFallback(o, date, at);
          store.jobRuns.finish('fallback', date, result);
        } else {
          const fb = store.jobRuns.get('fallback', date);
          if (fb && fb.result === null && at.getTime() - Date.parse(fb.at) < FALLBACK_HOLD_MS) {
            break; // a fallback call is in flight elsewhere: decide after it, on a later tick
          }
          const fn =
            job.name === 'no_plan'
              ? () => noPlan(store, date, at)
              : () => approve(store, date, tz, at);
          result = runOnce(store, job.name, date, at, fn);
          if (result === undefined) continue;
        }
      } catch (err) {
        result = `error: ${(err as Error).message}`;
        store.jobRuns.finish(job.name, date, result);
        store.alerts.add({ kind: 'job_error', message: `${job.name} ${date}: ${result}` }, at);
        log?.error({ err, job: job.name, date }, 'evening job failed');
      }
      log?.info({ job: job.name, date, result }, 'evening job ran');
      done.push(`${job.name}: ${result}`);
    }
    return done;
  }

  const scheduler: Scheduler = {
    checkMissedApproval() {
      const at = now();
      const today = localClock(at, tz).date;
      if (store.plans.get(today)?.status !== 'draft') return undefined;
      return runOnce(store, 'approve_missed', today, at, () => {
        store.alerts.add(
          {
            kind: 'approve_missed',
            message: `the plan for ${today} is still a draft: the 23:00 approval did not run; nothing is published today`,
          },
          at,
        );
        return 'alert';
      });
    },
    async tick() {
      if (running) return [];
      running = due();
      try {
        return await running;
      } finally {
        running = undefined;
      }
    },
    start() {
      if (timer) return;
      // A failing tick (e.g. the database went away) is logged; it never kills the process.
      const run = () => {
        scheduler.tick().catch((err: unknown) => log?.error({ err }, 'scheduler tick failed'));
      };
      try {
        scheduler.checkMissedApproval();
      } catch (err) {
        log?.error({ err }, 'missed-approval check failed');
      }
      run();
      timer = setInterval(run, o.intervalMs ?? TICK_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
  };
  return scheduler;
}
