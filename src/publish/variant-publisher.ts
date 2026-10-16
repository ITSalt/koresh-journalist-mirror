import { localClock } from '../lib/clock.js';
import { textHash } from '../lib/idempotency.js';
import type { Variant, VariantPlatform } from '../plan/schema.js';
import { variantId, variantPublicationKey } from '../plan/variants.js';
import { composeVariantText, frameCarriesLink, type FrameOptions } from '../platforms/frame.js';
import type { Outcome, PlatformAdapter, PublishInput } from '../platforms/types.js';
import {
  AlreadyExists,
  VariantNotClaimable,
  type Plan,
  type Publication,
  type SlotVariant,
  type Store,
} from '../store/index.js';
import {
  DEFAULT_RULES,
  INTENT_STALE_MS,
  POLL_INTERVAL_MS,
  type PublisherLogger,
} from './publisher.js';
import type { Blocks, DecideInput } from './types.js';

// The publish loop of one platform outside Telegram (WP-PLAT-02): Threads or LinkedIn. One loop
// per platform, each over the variants of that platform in today's plan (`slot_variants`); the
// Telegram publisher (`publisher.ts`) is not touched by it and does not wait for it. Each
// iteration handles at most one item:
//   reconcile  this platform's intents older than 2 min (a crash between intent and result)
//              become `unknown`, with an alert that names the platform (`publish_unknown` for a
//              post, `comment_unknown` for a first comment)
//   complete   a variant whose post is `sent` and whose comment has any final state, `unknown`
//              included, is `done`
//   comment    a variant whose post is `sent` and whose first comment is due: the comment is its
//              own item with its own key (`part` 1)
//   decide     the same scheduler as Telegram, over this platform's variants and rows only
//              (grace and min gap of the platform); returned skips are stored as `skipped`
//   publish    frame composed -> claim -> `adapter.validate` -> `adapter.publish` -> result
// The claim is the status re-read before every send: ONE statement writes the intent row only
// while the plan is approved and the variant row is planned and still holds the json that was
// read (`beginVariantIntent`; for the comment `beginCommentIntent`: the post row is `sent`). A
// reject of the day, in either branch of the route, therefore wins over a send that has not
// claimed yet.
// Results: sent (platform id and url), dry (DRY_RUN_<PLATFORM>: no adapter method is called),
// failed (the platform refused, or nothing was accepted: the variant is lost for the day),
// unknown (the request may have left: an alert, the variant is blocked). Nothing is ever resent
// automatically: a variant with any publication row is never offered to the scheduler again.

export interface FirstComment {
  /** True when a comment with the link follows a post that is sent now (link mode, probe). */
  due(): boolean;
  /**
   * Called once with the outcome of a comment. Returns what the director is told, or `null`;
   * `undefined` leaves the loop's own alert (a failed or unknown comment) in place.
   */
  settled?(outcome: Outcome<{ id: string }>): { kind: string; text: string } | null | undefined;
}

export interface VariantPublisherOptions {
  store: Store;
  blocks: Pick<Blocks, 'decide'>;
  platform: VariantPlatform;
  /** Required unless `dryRun`. In a dry run no method of it is called. */
  adapter?: PlatformAdapter;
  /** `DRY_RUN_<PLATFORM>`: `dry` rows, nothing is sent. */
  dryRun: boolean;
  /** TZ_PLAN: the day whose plan is published. */
  tz: string;
  frame?: FrameOptions;
  /** The owner's original post: `PublishInput.link`, and the text of the first comment. */
  link?: string;
  firstComment?: FirstComment;
  rules?: { graceMin?: number; minGapMin?: number };
  /** Replaces secret values in text before it is stored or logged. */
  scrub?: (s: string) => string;
  now?: () => Date;
  log?: PublisherLogger;
  intervalMs?: number;
}

export interface VariantIteration {
  platform: VariantPlatform;
  date: string;
  /** The variant handled in this iteration (`<slot>-<lang>`), with its result. */
  variant?: string;
  /** `post` or `comment`. */
  item?: 'post' | 'comment';
  result?: 'sent' | 'dry' | 'failed' | 'unknown' | 'refused' | 'stopped' | 'skipped';
  skipped: string[];
  wakeAt?: string;
  again?: boolean;
}

export interface VariantPublisher {
  platform: VariantPlatform;
  /** This platform's stale intents -> unknown, one alert each; returns their keys. */
  reconcile(): string[];
  runOnce(): Promise<VariantIteration>;
  start(): void;
  stop(): Promise<void>;
}

/** Publication statuses that count as "a post went (or may have gone) out" for the min gap. */
const OUT_STATUSES = new Set(['sent', 'dry', 'unknown', 'intent']);
const POST = 0;
const COMMENT = 1;

const errorName = (err: unknown) => (err as { name?: string } | null)?.name ?? 'Error';

/** The variants of one platform among the rows of a day. */
export const variantsOf = (variants: SlotVariant[], platform: VariantPlatform) =>
  variants.filter((v) => v.platform === platform);

export const variantKeyOf = (v: SlotVariant, part: number) =>
  variantPublicationKey({
    platform: v.platform,
    planDate: v.planDate,
    slotId: v.slotId,
    lang: v.lang,
    part,
  });

/**
 * The scheduler input of one platform for a stored day (shared by the loop and the preview):
 * the ids are `<slot>-<lang>`; `done` = variants that are not `planned` or have a post row;
 * `lastPublishedAt` = the latest row of THIS platform that is (or may be) out. Rows of Telegram
 * and of the other platform are not read: each platform's min gap counts only its own rows.
 */
export function variantDecideInput(x: {
  date: string;
  plan: Plan;
  platform: VariantPlatform;
  /** Variants of the platform. */
  variants: SlotVariant[];
  pubs: Publication[];
  now: Date;
  rules: { graceMin: number; minGapMin: number };
}): DecideInput {
  const pubs = x.pubs.filter((p) => p.platform === x.platform);
  const keys = new Set(pubs.map((p) => p.key));
  const done = x.variants.filter((v) => v.status !== 'planned' || keys.has(variantKeyOf(v, POST)));
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
    slots: x.variants.map((v) => ({ id: variantId(v.slotId, v.lang), at: v.at })),
    done: done.map((v) => variantId(v.slotId, v.lang)),
    ...(Number.isFinite(last) ? { lastPublishedAt: new Date(last).toISOString() } : {}),
    now: x.now.toISOString(),
    rules: x.rules,
  };
}

/** What a variant sends: the stored text inside its frame, and the link where there is one. */
export function variantInput(
  v: SlotVariant,
  o: { frame?: FrameOptions; link?: string },
): PublishInput {
  const variant = JSON.parse(v.json) as Variant;
  if (typeof variant.text !== 'string' || variant.text.trim() === '') {
    throw new Error('the variant has no text');
  }
  const link = o.link?.trim();
  const frame: FrameOptions = { ...o.frame, ...(link ? { link } : {}) };
  // A disclaimer that carries the link already: the adapter must not add it once more.
  const inText = frameCarriesLink(v.platform, v.lang, frame);
  return {
    key: variantKeyOf(v, POST),
    text: composeVariantText(v.platform, v.lang, variant.text, frame),
    lang: v.lang,
    ...(link && !inText ? { link } : {}),
  };
}

export function createVariantPublisher(o: VariantPublisherOptions): VariantPublisher {
  const { store, blocks, tz, platform } = o;
  const now = o.now ?? (() => new Date());
  const scrub = (s: string) => (o.scrub ? o.scrub(s) : s).slice(0, 1000);
  const rules = { ...DEFAULT_RULES, ...o.rules };
  const log = o.log;
  const link = o.link?.trim() || undefined;
  if (!o.dryRun && !o.adapter) {
    throw new Error(`the ${platform} publisher needs an adapter unless DRY_RUN_${platform}`);
  }
  localClock(new Date(), tz); // an invalid zone fails at construction

  const schedulerAlerts = new Set<string>();
  const alert = (kind: string, message: string) => {
    store.alerts.add({ kind, message: scrub(message) }, now());
  };
  const setStatus = (v: SlotVariant, status: 'done' | 'skipped') =>
    store.slotVariants.setStatus(v.planDate, v.slotId, platform, v.lang, status);
  /** `done` unless the day was stopped meanwhile (a reject marked the variant `skipped`). */
  const finish = (v: SlotVariant) => {
    const row = variantsOf(store.slotVariants.listForPlan(v.planDate), platform).find(
      (x) => x.slotId === v.slotId && x.lang === v.lang,
    );
    if (row?.status === 'planned') setStatus(v, 'done');
  };

  function reconcile(): string[] {
    const at = now();
    const keys: string[] = [];
    for (const p of store.publications.listStaleIntents(INTENT_STALE_MS, at, platform)) {
      try {
        store.publications.markUnknown(p.key, 'intent left unresolved (restart); not resent');
      } catch {
        continue; // resolved meanwhile
      }
      keys.push(p.key);
      if (p.part === COMMENT) {
        // The comment is its own item: its alert says what may be out, and the post is not it.
        alert(
          'comment_unknown',
          `${p.key}: an intent was left without a result (restart); the first comment may be posted on ${platform}. Not resent: check the post on the ${platform} profile`,
        );
      } else {
        alert(
          'publish_unknown',
          `${p.key}: an intent was left without a result (restart); it may be posted on ${platform}. Not resent: check the ${platform} profile`,
        );
      }
      log?.error({ key: p.key, platform }, 'stale publication intent marked unknown');
    }
    return keys;
  }

  /**
   * A variant is complete once its post is `sent` and its comment has any final state (sent,
   * failed, or unknown after a crash while the comment was in flight): it becomes `done`.
   * Returns the variants as they stand after that.
   */
  function completeCommented(variants: SlotVariant[], pubs: Publication[]): SlotVariant[] {
    const byKey = new Map(pubs.map((p) => [p.key, p]));
    return variants.map((v) => {
      if (v.status !== 'planned') return v;
      const comment = byKey.get(variantKeyOf(v, COMMENT));
      if (byKey.get(variantKeyOf(v, POST))?.status !== 'sent') return v;
      if (!comment || comment.status === 'intent') return v;
      setStatus(v, 'done');
      return { ...v, status: 'done' as const };
    });
  }

  type Result = NonNullable<VariantIteration['result']>;

  async function publishVariant(v: SlotVariant): Promise<Result> {
    const key = variantKeyOf(v, POST);
    if (store.publications.get(key)) return 'stopped'; // any row blocks this variant only
    const claim = (textSha256: string): Result | undefined => {
      try {
        store.publications.beginVariantIntent(
          {
            key,
            platform,
            planDate: v.planDate,
            slotId: v.slotId,
            lang: v.lang,
            part: POST,
            textSha256,
            expectVariantJson: v.json,
          },
          now(),
        );
        return undefined;
      } catch (err) {
        if (err instanceof AlreadyExists) return 'stopped'; // another process took it
        if (err instanceof VariantNotClaimable) {
          // Rejected, skipped or changed between the read and the intent: nothing leaves.
          log?.info({ key, platform }, 'variant is no longer publishable: not sent');
          return 'stopped';
        }
        throw err;
      }
    };
    /** Recorded as a failed post without any request, so the variant is blocked and visible. */
    const refuse = (message: string): Result => {
      store.publications.markFailed(key, scrub(`refused: ${message}`));
      setStatus(v, 'skipped');
      alert('publish_refused', `${key}: ${message}; nothing was sent on ${platform}`);
      log?.error({ key, platform }, 'variant refused');
      return 'refused';
    };

    let input: PublishInput;
    try {
      input = variantInput(v, { frame: o.frame, link });
    } catch (err) {
      const stopped = claim(textHash(v.json));
      return stopped ?? refuse(`compose error: ${errorName(err)}: ${(err as Error)?.message}`);
    }

    const stopped = claim(textHash(input.text));
    if (stopped) return stopped;
    if (o.dryRun) {
      store.publications.markDry(key, now());
      setStatus(v, 'done');
      log?.info(
        { key, platform, chars: input.text.length },
        `DRY_RUN_${platform.toUpperCase()}: publication recorded, nothing sent`,
      );
      return 'dry';
    }
    const adapter = o.adapter!;

    let issues: { code: string; message: string }[];
    try {
      issues = adapter.validate(input);
    } catch (err) {
      issues = [{ code: 'validate_error', message: errorName(err) }];
    }
    if (issues.length > 0) {
      return refuse(issues.map((i) => `${i.code} (${i.message})`).join('; '));
    }

    let r: Outcome<{ id: string; url?: string }>;
    try {
      r = await adapter.publish(input);
    } catch (err) {
      // The adapter gave no answer at all: the request may have left.
      r = { ok: false, outcome: 'unknown', description: `no_answer: publish: ${errorName(err)}` };
    }
    if (r.ok) {
      store.publications.markPosted(key, r.result, now());
      // A variant with a first comment to come stays `planned` until the comment has its result.
      const commentDue = Boolean(adapter.comment && link && o.firstComment?.due());
      if (!commentDue) setStatus(v, 'done');
      log?.info({ key, platform, id: r.result.id, url: r.result.url }, 'published');
      return 'sent';
    }
    const description = scrub(r.description);
    if (r.outcome === 'unknown') {
      store.publications.markUnknown(key, description);
      alert(
        'publish_unknown',
        `${key}: ${description}; it may be posted on ${platform}. Not resent: check the ${platform} profile`,
      );
      log?.error({ key, platform, error: description }, 'publication outcome unknown');
      return 'unknown';
    }
    store.publications.markFailed(key, description);
    setStatus(v, 'skipped');
    const wait =
      r.retryAfterS !== undefined ? ` (the platform asked to wait ${r.retryAfterS} s)` : '';
    alert(
      'publish_failed',
      `${key}: ${r.outcome}: ${description}${wait}; nothing was sent on ${platform}. Not resent: this variant is lost for the day`,
    );
    log?.error({ key, platform, error: description }, 'publication failed');
    return 'failed';
  }

  /** A planned variant whose post is `sent` and that has no comment row yet. */
  function pendingComment(
    variants: SlotVariant[],
    pubs: Publication[],
  ): { variant: SlotVariant; post: Publication } | undefined {
    const byKey = new Map(pubs.map((p) => [p.key, p]));
    for (const v of variants) {
      if (v.status !== 'planned') continue;
      const post = byKey.get(variantKeyOf(v, POST));
      if (post?.status === 'sent' && !byKey.has(variantKeyOf(v, COMMENT))) {
        return { variant: v, post };
      }
    }
    return undefined;
  }

  async function publishComment(v: SlotVariant, post: Publication, at: Date): Promise<Result> {
    const adapter = o.adapter;
    if (o.dryRun || !adapter?.comment || !link || !post.messageId || !o.firstComment?.due()) {
      // No comment is due (any more): the variant is complete with its post.
      finish(v);
      return 'stopped';
    }
    const key = variantKeyOf(v, COMMENT);
    try {
      store.publications.beginCommentIntent(
        {
          key,
          platform,
          planDate: v.planDate,
          slotId: v.slotId,
          lang: v.lang,
          part: COMMENT,
          textSha256: textHash(link),
          postKey: post.key,
        },
        now(),
      );
    } catch (err) {
      if (err instanceof AlreadyExists || err instanceof VariantNotClaimable) {
        log?.info({ key, platform }, 'comment is no longer publishable: not sent');
        return 'stopped';
      }
      throw err;
    }
    if (at.getTime() - Date.parse(v.at) > rules.graceMin * 60_000) {
      store.publications.markFailed(key, 'not sent: the post is past its grace window');
      finish(v);
      alert(
        'comment_skipped',
        `${key}: the first comment under ${post.key} was not sent in time and is not sent now; the post itself is out`,
      );
      return 'skipped';
    }

    let r: Outcome<{ id: string }>;
    try {
      r = await adapter.comment(post.messageId, link, key);
    } catch (err) {
      r = { ok: false, outcome: 'unknown', description: `no_answer: comment: ${errorName(err)}` };
    }
    // The comment row only: whatever happened here, the post row stays as it is.
    if (r.ok) store.publications.markSent(key, r.result.id, now());
    else if (r.outcome === 'unknown') store.publications.markUnknown(key, scrub(r.description));
    else store.publications.markFailed(key, scrub(r.description));
    finish(v);

    const told = o.firstComment?.settled?.(r);
    if (told !== undefined) {
      if (told) alert(told.kind, `${key}: ${told.text}`);
    } else if (!r.ok) {
      const description = scrub(r.description);
      alert(
        r.outcome === 'unknown' ? 'comment_unknown' : 'comment_failed',
        r.outcome === 'unknown'
          ? `${key}: ${description}; the first comment may be posted on ${platform}. Not resent; the post ${post.key} is out`
          : `${key}: ${r.outcome}: ${description}; the first comment was not posted on ${platform}. Not resent; the post ${post.key} is out`,
      );
    }
    if (r.ok) log?.info({ key, platform, id: r.result.id }, 'first comment published');
    else log?.error({ key, platform, error: scrub(r.description) }, 'first comment not published');
    return r.ok ? 'sent' : r.outcome === 'unknown' ? 'unknown' : 'failed';
  }

  async function runOnce(): Promise<VariantIteration> {
    reconcile();
    const at = now();
    const date = localClock(at, tz).date;
    const none: VariantIteration = { platform, date, skipped: [] };
    const plan = store.plans.get(date);
    if (!plan) return none;
    const planned = variantsOf(store.slotVariants.listForPlan(date), platform);
    if (planned.length === 0) return none;
    const pubs = store.publications.listForPlan(date);
    const variants = completeCommented(planned, pubs);
    const idOf = (v: SlotVariant) => variantId(v.slotId, v.lang);

    if (plan.status === 'approved') {
      const c = pendingComment(variants, pubs);
      if (c) {
        const result = await publishComment(c.variant, c.post, at);
        return { ...none, variant: idOf(c.variant), item: 'comment', result, again: true };
      }
    }

    let d;
    try {
      d = blocks.decide(
        variantDecideInput({ date, plan, platform, variants, pubs, now: at, rules }),
      );
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string };
      const code = e.name === 'SchedulerError' ? (e.code ?? 'SchedulerError') : 'error';
      if (!schedulerAlerts.has(`${date}:${code}`)) {
        schedulerAlerts.add(`${date}:${code}`);
        alert(
          'scheduler_error',
          `plan ${date}: the scheduler refused the ${platform} variants (${code}: ${e.message ?? ''}); nothing is published on ${platform} that day`,
        );
      }
      log?.error({ date, platform, code }, 'scheduler refused the variants');
      return none;
    }

    const byId = new Map(variants.map((v) => [idOf(v), v]));
    for (const id of d.skip) {
      const v = byId.get(id);
      if (!v) continue;
      setStatus(v, 'skipped');
      alert(
        'variant_skipped',
        `variant ${date}/${id} on ${platform} is past its grace window and was skipped`,
      );
      log?.info({ date, platform, variant: id }, 'stale variant skipped');
    }
    const rest = { ...none, skipped: d.skip };
    if (!d.publish) return { ...rest, ...(d.wakeAt ? { wakeAt: d.wakeAt } : {}) };
    const v = byId.get(d.publish);
    if (!v) return rest;
    const result = await publishVariant(v);
    return { ...rest, variant: d.publish, item: 'post', result, again: true };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = true;
  const interval = o.intervalMs ?? POLL_INTERVAL_MS;

  function schedule(it?: VariantIteration) {
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
        log?.error({ err, platform }, 'variant publisher iteration failed');
        schedule();
      })
      .finally(() => {
        running = undefined;
      });
  }

  return {
    platform,
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
