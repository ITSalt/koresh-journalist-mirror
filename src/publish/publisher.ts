import { localClock } from '../lib/clock.js';
import { publicationKey, textHash } from '../lib/idempotency.js';
import type { PlanSlot } from '../plan/schema.js';
import {
  AlreadyExists,
  SlotNotClaimable,
  type Plan,
  type Publication,
  type Slot,
  type Store,
} from '../store/index.js';
import type { BotApi, RetryOptions } from '../telegram/bot-api.js';
import { RefusedPost } from './compose.js';
import { itemHash, itemMethod, sendItem, slotItems, type SlotItem } from './items.js';
import type { Blocks, DecideInput } from './types.js';

// The Telegram publisher (WP-SVC-11). One loop; each iteration handles at most one slot of
// today's plan (Moscow day):
//   reconcile  intents older than 2 min (a crash between intent and result) become `unknown`
//   resume     a slot whose parts so far are all sent continues with its next part
//   decide     the scheduler (WP-SVC-05) picks one slot; returned skips are stored as `skipped`
//   publish    per part: plan approved and slot planned? -> beginIntent(key) -> send -> result
//              The intent is written only while the slot row still holds the json the parts were
//              composed from (checked inside the insert, WP-SVC-22): a slot replaced by
//              PUT /v1/plans/:date/slots/:slotId after it was read is not sent with the old text;
//              the iteration stops and the next one reads the new text.
//              A slot with an image (WP-SVC-24) has a photo as its part 0, sent by the very same
//              steps; the image is named inside the slot json, so that one check covers image and
//              text together and a restart sends only the parts that have no row yet.
// Results: sent (message id), dry (DRY_RUN, nothing sent), failed (4xx or known not sent),
// unknown (the request left, no answer: never resent automatically, an alert instead).
// A slot with any publication row is never offered to the scheduler again; an `unknown` or
// `failed` row blocks only its own slot.

export const INTENT_STALE_MS = 2 * 60_000;
export const POLL_INTERVAL_MS = 60_000;
/** Pause between parts of one slot: ~1 msg/s per chat. */
export const PART_GAP_MS = 1100;
export const DEFAULT_RULES = { graceMin: 90, minGapMin: 20 } as const;

export interface PublisherLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface PublisherOptions {
  store: Store;
  blocks: Blocks;
  /** Required unless `dryRun`. */
  api?: BotApi;
  /** `TELEGRAM_CHANNEL`: `@name` or a numeric chat id. */
  channel: string;
  dryRun: boolean;
  /** `TG_TRAILER` (D-16): appended after the signature at publish time. */
  trailer?: string;
  /** TZ_PLAN: the day whose plan is published. */
  tz: string;
  /** Replaces secret values in text before it is stored or logged (L-3). */
  scrub?: (s: string) => string;
  rules?: { graceMin?: number; minGapMin?: number };
  retry?: RetryOptions;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: PublisherLogger;
  intervalMs?: number;
  partGapMs?: number;
}

export interface Iteration {
  date: string;
  /** Slot handled in this iteration, with its result. */
  slot?: string;
  result?: 'sent' | 'dry' | 'failed' | 'unknown' | 'refused' | 'stopped' | 'skipped';
  skipped: string[];
  /** When the loop should run again (ISO); undefined: on the poll interval. */
  wakeAt?: string;
  /** True when the loop should run again right away (after a publish). */
  again?: boolean;
}

export interface Publisher {
  /** Stale intents -> unknown, one alert each; returns their keys. */
  reconcile(): string[];
  runOnce(): Promise<Iteration>;
  start(): void;
  stop(): Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DONE_STATUSES = new Set(['sent', 'dry']);
/** Publication statuses that count as "a post went (or may have gone) out" for the min gap. */
const OUT_STATUSES = new Set(['sent', 'dry', 'unknown', 'intent']);

/** Escaped length of what an item sends as text (a poll has none): for the DRY_RUN log line. */
const chars = (item: SlotItem) =>
  item.kind === 'text'
    ? item.part.escaped.length
    : item.kind === 'photo'
      ? item.caption.escaped.length
      : undefined;

/** The platform of this loop: the only publication rows it reads, claims and reconciles. */
export const TELEGRAM = 'telegram';

/**
 * The scheduler input for a stored day (shared by the loop and the preview route): `done` = slots
 * that are not `planned` or have any Telegram publication row; `lastPublishedAt` = the latest
 * Telegram row that is (or may be) out. Rows of other platforms (the variants of a slot carry the
 * slot's id, WP-PLAT-02) are not Telegram's: they neither mark a slot done nor move the min gap.
 */
export function decideInput(x: {
  date: string;
  plan: Plan;
  slots: Slot[];
  pubs: Publication[];
  now: Date;
  rules: { graceMin: number; minGapMin: number };
}): DecideInput {
  const pubs = x.pubs.filter((p) => p.platform === TELEGRAM);
  const withRows = new Set(pubs.map((p) => p.slotId));
  const done = x.slots.filter((s) => s.status !== 'planned' || withRows.has(s.slotId));
  const last = pubs
    .filter((p) => OUT_STATUSES.has(p.status))
    .map((p) => Date.parse(p.sentAt ?? p.createdAt))
    .filter(Number.isFinite)
    .reduce((a, b) => Math.max(a, b), -Infinity);
  return {
    day: {
      date: x.date,
      approved: x.plan.status === 'approved',
      rejected: x.plan.status === 'rejected',
    },
    slots: x.slots.map((s) => ({ id: s.slotId, at: s.at })),
    done: done.map((s) => s.slotId),
    ...(Number.isFinite(last) ? { lastPublishedAt: new Date(last).toISOString() } : {}),
    now: x.now.toISOString(),
    rules: x.rules,
  };
}

export function createPublisher(o: PublisherOptions): Publisher {
  const { store, blocks, tz } = o;
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? realSleep;
  const scrub = (s: string) => (o.scrub ? o.scrub(s) : s).slice(0, 1000);
  const rules = { ...DEFAULT_RULES, ...o.rules };
  const log = o.log;
  if (!o.dryRun && !o.api) throw new Error('the publisher needs a Bot API client unless DRY_RUN');
  localClock(new Date(), tz); // an invalid zone fails at construction

  const schedulerAlerts = new Set<string>();
  const alert = (kind: string, message: string) => {
    store.alerts.add({ kind, message: scrub(message) }, now());
  };

  function reconcile(): string[] {
    const at = now();
    const keys: string[] = [];
    // Only Telegram's own intents: another platform's loop may still wait for its answer.
    for (const p of store.publications.listStaleIntents(INTENT_STALE_MS, at, TELEGRAM)) {
      try {
        store.publications.markUnknown(p.key, 'intent left unresolved (restart); not resent');
      } catch {
        continue; // resolved meanwhile
      }
      keys.push(p.key);
      alert(
        'publish_unknown',
        `${p.key}: an intent was left without a result (restart); it may be posted. Not resent: check the channel`,
      );
      log?.error({ key: p.key }, 'stale publication intent marked unknown');
    }
    return keys;
  }

  const planStatusOk = (date: string, slotId: string) =>
    store.plans.get(date)?.status === 'approved' &&
    store.slots.listForPlan(date).find((s) => s.slotId === slotId)?.status === 'planned';

  async function publishSlot(date: string, slot: Slot): Promise<NonNullable<Iteration['result']>> {
    const key = (part: number) =>
      publicationKey({ platform: 'telegram', planDate: date, slotId: slot.slotId, part });
    let s: PlanSlot;
    let list: SlotItem[];
    try {
      s = JSON.parse(slot.json) as PlanSlot;
      // Throws RefusedPost: a text that cannot be composed, or an image that is not stored.
      list = slotItems(store, s, { trailer: o.trailer, blocks });
    } catch (caught) {
      // Scope item 13: any compose error (e.g. a RangeError from chunkText) refuses the slot once
      // with an alert; re-throwing would retry it every minute without one.
      const err =
        caught instanceof RefusedPost
          ? caught
          : new RefusedPost(
              'compose_error',
              `compose error: ${(caught as Error)?.name ?? 'Error'}: ${(caught as Error)?.message ?? String(caught)}`,
            );
      // Recorded as a failed part 0 without any request, so the slot is blocked and visible.
      if (!store.publications.get(key(0))) {
        try {
          store.publications.beginIntent(
            {
              key: key(0),
              platform: 'telegram',
              planDate: date,
              slotId: slot.slotId,
              part: 0,
              textSha256: textHash(slot.json),
              expectSlotJson: slot.json,
            },
            now(),
          );
        } catch (e) {
          // The text was replaced (or the day stopped) since it was read: this refusal is about
          // a text that is no longer the slot's. The next iteration reads the slot again.
          if (e instanceof SlotNotClaimable || e instanceof AlreadyExists) {
            log?.info({ key: key(0) }, 'slot changed since it was read: not refused, not sent');
            return 'stopped';
          }
          throw e;
        }
        store.publications.markFailed(key(0), scrub(`refused: ${err.message}`));
      }
      store.slots.setStatus(date, slot.slotId, 'skipped');
      alert('publish_refused', `${key(0)}: ${err.message}; nothing was sent`);
      log?.error({ key: key(0), code: err.code }, 'post refused');
      return 'refused';
    }

    let sentAny = false;
    for (const [i, item] of list.entries()) {
      const k = key(i);
      const existing = store.publications.get(k);
      if (existing) {
        if (DONE_STATUSES.has(existing.status)) {
          sentAny = true;
          continue;
        }
        return 'stopped'; // intent/unknown/failed: blocks this slot only
      }
      // I-2: the plan may have been rejected (or the slot skipped) since the last part.
      if (!planStatusOk(date, slot.slotId)) {
        log?.info({ key: k }, 'plan no longer approved or slot not planned: not sent');
        return 'stopped';
      }
      if (i > 0 && !o.dryRun) await sleep(o.partGapMs ?? PART_GAP_MS);
      const method = itemMethod(item);
      const hash = itemHash(item, s);
      try {
        store.publications.beginIntent(
          {
            key: k,
            platform: 'telegram',
            planDate: date,
            slotId: slot.slotId,
            part: i,
            textSha256: hash,
            expectSlotJson: slot.json,
          },
          now(),
        );
      } catch (err) {
        if (err instanceof AlreadyExists) return 'stopped'; // another process took it
        if (err instanceof SlotNotClaimable) {
          // Replaced, skipped or rejected between the read and the intent: nothing leaves.
          log?.info(
            { key: k },
            'slot changed since it was read or is no longer publishable: not sent',
          );
          return 'stopped';
        }
        throw err;
      }
      if (o.dryRun) {
        store.publications.markDry(k, now());
        log?.info(
          { key: k, method, chars: chars(item) },
          'DRY_RUN: publication recorded, nothing sent',
        );
        sentAny = true;
        continue;
      }
      const r = await sendItem(o.api!, o.channel, item, s, { sleep, ...o.retry });
      if (r.ok) {
        store.publications.markSent(k, String(r.result.message_id), now());
        log?.info({ key: k, method, messageId: r.result.message_id }, 'published');
        sentAny = true;
        continue;
      }
      const description = scrub(r.description);
      if (r.outcome === 'unknown') {
        store.publications.markUnknown(k, description);
        alert(
          'publish_unknown',
          `${k}: ${description}; it may be posted. Not resent: check the channel`,
        );
        log?.error({ key: k, error: description }, 'publication outcome unknown');
        return 'unknown';
      }
      store.publications.markFailed(k, description);
      if (!sentAny) store.slots.setStatus(date, slot.slotId, 'skipped');
      alert(
        'publish_failed',
        `${k}: ${description}${sentAny ? ' (earlier parts are out)' : '; nothing was sent'}`,
      );
      log?.error({ key: k, error: description }, 'publication failed');
      return 'failed';
    }
    store.slots.setStatus(date, slot.slotId, 'done');
    return o.dryRun ? 'dry' : 'sent';
  }

  /** A planned slot whose rows so far are all sent/dry: an interrupted multi-part post. */
  function resumable(slots: Slot[], pubs: Publication[]): Slot | undefined {
    return slots.find((s) => {
      if (s.status !== 'planned') return false;
      const rows = pubs.filter((p) => p.slotId === s.slotId && p.platform === TELEGRAM);
      return rows.length > 0 && rows.every((p) => DONE_STATUSES.has(p.status));
    });
  }

  async function runOnce(): Promise<Iteration> {
    reconcile();
    const at = now();
    const date = localClock(at, tz).date;
    const plan = store.plans.get(date);
    if (!plan) return { date, skipped: [] };
    const slots = store.slots.listForPlan(date);
    const pubs = store.publications.listForPlan(date);

    if (plan.status === 'approved') {
      const r = resumable(slots, pubs);
      if (r) {
        const lateMs = at.getTime() - Date.parse(r.at);
        if (lateMs > rules.graceMin * 60_000) {
          store.slots.setStatus(date, r.slotId, 'skipped');
          alert(
            'partial_post',
            `slot ${date}/${r.slotId}: only some parts are out and the slot is past its grace window; the rest is not sent`,
          );
          return { date, slot: r.slotId, result: 'skipped', skipped: [r.slotId], again: true };
        }
        const result = await publishSlot(date, r);
        return { date, slot: r.slotId, result, skipped: [], again: true };
      }
    }

    let d;
    try {
      d = blocks.decide(decideInput({ date, plan, slots, pubs, now: at, rules }));
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string };
      const code = e.name === 'SchedulerError' ? (e.code ?? 'SchedulerError') : 'error';
      // One alert per (date, code) per process: the loop polls every minute and publishes nothing.
      if (!schedulerAlerts.has(`${date}:${code}`)) {
        schedulerAlerts.add(`${date}:${code}`);
        alert(
          'scheduler_error',
          `plan ${date}: the scheduler refused the slots (${code}: ${e.message ?? ''}); nothing is published that day`,
        );
      }
      log?.error({ date, code }, 'scheduler refused the plan');
      return { date, skipped: [] };
    }

    for (const id of d.skip) {
      store.slots.setStatus(date, id, 'skipped');
      alert('slot_skipped', `slot ${date}/${id} is past its grace window and was skipped`);
      log?.info({ date, slot: id }, 'stale slot skipped');
    }
    if (!d.publish) return { date, skipped: d.skip, ...(d.wakeAt ? { wakeAt: d.wakeAt } : {}) };
    const slot = slots.find((s) => s.slotId === d.publish);
    if (!slot) return { date, skipped: d.skip };
    const result = await publishSlot(date, slot);
    return { date, slot: slot.slotId, result, skipped: d.skip, again: true };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = true;
  const interval = o.intervalMs ?? POLL_INTERVAL_MS;

  function schedule(it?: Iteration) {
    if (stopped) return;
    let delay = interval;
    if (it?.again) delay = 0;
    else if (it?.wakeAt) {
      delay = Math.min(interval, Math.max(0, Date.parse(it.wakeAt) - now().getTime()));
    }
    timer = setTimeout(tick, delay);
    timer.unref();
  }

  function tick() {
    timer = undefined;
    running = runOnce()
      .then((it) => schedule(it))
      .catch((err: unknown) => {
        log?.error({ err }, 'publisher iteration failed');
        schedule();
      })
      .finally(() => {
        running = undefined;
      });
  }

  return {
    reconcile,
    runOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
}
