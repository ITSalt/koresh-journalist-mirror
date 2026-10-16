// Threads adapter behind the platform adapter contract (./types.ts): validate, publish, health,
// plus the token refresh the service runs on its own schedule. No `comment`: by decision D-1
// there is no first comment on Threads.
//
// One publish item, two recorded steps (./step-store.ts):
//   1. container: created, then recorded. Invisible, so any failure here is `failed` or
//      `refused` and the whole item can be started over.
//   2. publish: recorded FIRST, then the request leaves. If the process dies or the answer is
//      lost anywhere after the record, the next `publish` for the same key sends nothing and
//      answers `unknown`: one public post or none, never two.
// A restart that finds only step 1 creates a fresh container; the old one is never published.
// The record goes back to step 1 (so the caller may try the item again, with a fresh container,
// if its own rules allow) only when it is certain that nothing became public: the FIRST publish
// request for the container was refused with a lasting 4xx, or no request ever left. Everything
// else leaves the record at step 2, including a `failed` after a 429: decisions D-3 and D-4, a
// missed post is cheaper than a doubled one on the owner's own profile.
//
// The adapter holds no state and does not log. Descriptions start with a code where the caller
// may want to branch: `invalid_input`, `quota_exhausted`, `token_invalid`, `token_expired`,
// `token_too_young`, `publish_already_started`, `publish_in_progress`, `step_store_error`,
// `token_store_error`.

import { createThreadsClient, type RetryOptions, type ThreadsClientOptions } from './client.js';
import { DEFAULT_PUBLISH_DELAY_MS, REFRESH_MIN_AGE_S, TOKEN_LIFETIME_S } from './platform-facts.js';
import { scrub } from './scrub.js';
import type { PublishStepStore } from './step-store.js';
import type { TokenStore } from './token-store.js';
import type { Outcome, PlatformAdapter, PublishInput } from '../types.js';
import { validate } from './validate.js';

export interface ThreadsAdapterOptions {
  tokens: TokenStore;
  /** The caller's record of the two publish steps; see ./step-store.ts. */
  steps: PublishStepStore;
  baseUrl?: string;
  userId?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  retry?: Omit<RetryOptions, 'sleep'>;
  /** Wait between the container and the publish call (default 0: see platform-facts.ts). */
  publishDelayMs?: number;
  /** Send the publish request once more after a first 429. Off by default: see
   *  CONTAINER_PUBLISHES_ONCE in platform-facts.ts before switching it on. */
  resendPublishAfter429?: boolean;
}

export interface ThreadsAdapter extends PlatformAdapter {
  platform: 'threads';
  /**
   * Refreshes the long-lived token and stores it. Refused without a call when the stored expiry
   * shows the token is younger than 24 h or already expired. The token is not in the result.
   */
  refreshToken(): Promise<Outcome<{ expiresAt: string }>>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Health and the quota read before a publish must be quick: one attempt. */
const ONCE: RetryOptions = { maxAttempts: 1 };
/** The post is public already; its URL is worth a few tries, not a long wait. */
const URL_READ: RetryOptions = { maxAttempts: 3, maxWaitMs: 5000 };

export function createThreadsAdapter(o: ThreadsAdapterOptions): ThreadsAdapter {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? realSleep;
  const publishDelayMs = o.publishDelayMs ?? DEFAULT_PUBLISH_DELAY_MS;
  const clientOptions: ThreadsClientOptions = {
    token: () => o.tokens.get(),
    now,
    retry: { ...o.retry, sleep },
    ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
    ...(o.userId !== undefined ? { userId: o.userId } : {}),
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.fetch !== undefined ? { fetch: o.fetch } : {}),
    ...(o.resendPublishAfter429 !== undefined
      ? { resendPublishAfter429: o.resendPublishAfter429 }
      : {}),
  };
  const client = createThreadsClient(clientOptions);

  /** Texts built here from the caller's stores never carry the token either. */
  const clean = (text: string): string => {
    let token = '';
    try {
      token = o.tokens.get();
    } catch {
      // nothing to scrub
    }
    return scrub(text, [token]);
  };
  const errorName = (err: unknown): string => {
    const name = (err as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? name : 'Error';
  };

  // Keys whose publish is running in this process right now. Not state that outlives a call: it
  // only keeps a second, overlapping call for the same key from walking the two steps in step
  // with the first one (the step records are read once, at the start).
  const running = new Set<string>();

  async function publish(input: PublishInput): Promise<Outcome<{ id: string; url?: string }>> {
    const issues = validate(input);
    if (issues.length > 0) {
      return {
        ok: false,
        outcome: 'refused',
        description: `invalid_input: ${issues.map((i) => `${i.code} (${i.message})`).join('; ')}`,
      };
    }
    if (running.has(input.key)) {
      return {
        ok: false,
        outcome: 'unknown',
        description:
          'publish_in_progress: another publish for this key is running; this call sent nothing',
      };
    }
    running.add(input.key);
    try {
      return await publishOnce(input);
    } finally {
      running.delete(input.key);
    }
  }

  async function publishOnce(input: PublishInput): Promise<Outcome<{ id: string; url?: string }>> {
    let prior;
    try {
      prior = o.steps.get(input.key);
    } catch (err) {
      return {
        ok: false,
        outcome: 'failed',
        description: clean(`step_store_error: read failed (${errorName(err)}), nothing was sent`),
      };
    }
    if (prior !== undefined && prior.step !== 'container') {
      // Anything but a clean step 1 means a publish request may be out: never send again.
      return {
        ok: false,
        outcome: 'unknown',
        description: clean(
          `publish_already_started: a publish request for this key was started at ${prior.at} ` +
            `(container ${prior.containerId}); it is never sent again`,
        ),
      };
    }

    // The platform enforces the quota itself; reading it first turns a certain refusal into a
    // clear one before anything is created. Only a quota that was read and is used up stops the
    // post: an unreadable or refused quota read does not (the container call speaks for itself).
    const quota = await client.publishingLimit(ONCE);
    if (quota.ok && quota.result.usage >= quota.result.total) {
      return {
        ok: false,
        outcome: 'failed',
        description: `quota_exhausted: ${quota.result.usage} of ${quota.result.total} posts used, nothing was sent`,
      };
    }

    const container = await client.createContainer(input.text);
    if (!container.ok) return container;
    const containerId = container.result.id;
    const record = (step: 'container' | 'publish'): string | undefined => {
      try {
        o.steps.set(input.key, { step, containerId, at: now().toISOString() });
        return undefined;
      } catch (err) {
        return clean(`step_store_error: step ${step} was not recorded (${errorName(err)})`);
      }
    };
    const notRecorded = record('container');
    if (notRecorded !== undefined) {
      return { ok: false, outcome: 'failed', description: `${notRecorded}, nothing was published` };
    }
    if (publishDelayMs > 0) await sleep(publishDelayMs);

    const publishNotRecorded = record('publish');
    if (publishNotRecorded !== undefined) {
      return {
        ok: false,
        outcome: 'failed',
        description: `${publishNotRecorded}, the publish request was not sent`,
      };
    }
    const published = await client.publishContainer(containerId);
    if (!published.ok) {
      // Back to step 1 only when the client is certain that nothing became public. If this
      // record fails, step 2 stays and the item answers `unknown` from now on: the safe side.
      const { notPublished, ...outcome } = published;
      if (notPublished === true) record('container');
      return outcome;
    }

    const id = published.result.id;
    // The post is public from here on: nothing below may turn this into a failure.
    const link = await client.permalink(id, URL_READ);
    return { ok: true, result: { id, ...(link.ok ? { url: link.result.url } : {}) } };
  }

  /** Expiry of the stored token, when the store knows it and it is a date. */
  const knownExpiry = (): string | undefined => {
    try {
      const at = o.tokens.expiresAt?.();
      return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : undefined;
    } catch {
      return undefined;
    }
  };

  async function health(): Promise<{ ok: boolean; detail: string; tokenExpiresAt?: string }> {
    const [me, quota] = await Promise.all([client.me(ONCE), client.publishingLimit(ONCE)]);
    const expiresAt = knownExpiry();
    const expired = expiresAt !== undefined && Date.parse(expiresAt) <= now().getTime();
    const exhausted = quota.ok && quota.result.usage >= quota.result.total;
    const parts = [
      me.ok
        ? `profile ok${me.result.username ? ` (@${me.result.username})` : ''}`
        : `profile: ${me.description}`,
      quota.ok
        ? `quota ${quota.result.usage}/${quota.result.total}${exhausted ? ' exhausted' : ''}`
        : `quota: ${quota.description}`,
      expiresAt === undefined
        ? 'token expiry unknown until the first refresh'
        : `token ${expired ? 'expired' : 'expires'} ${expiresAt}`,
    ];
    return {
      ok: me.ok && quota.ok && !exhausted && !expired,
      detail: clean(parts.join('; ')),
      ...(expiresAt !== undefined ? { tokenExpiresAt: expiresAt } : {}),
    };
  }

  async function refreshToken(): Promise<Outcome<{ expiresAt: string }>> {
    const known = knownExpiry();
    if (known !== undefined) {
      const expiresMs = Date.parse(known);
      const nowMs = now().getTime();
      if (expiresMs <= nowMs) {
        return {
          ok: false,
          outcome: 'refused',
          description: `token_expired: the token expired ${known}; an expired token cannot be refreshed, a new one is needed`,
        };
      }
      // The store keeps the expiry only; a token lives 60 days, so its age follows from it.
      const refreshableMs = expiresMs - TOKEN_LIFETIME_S * 1000 + REFRESH_MIN_AGE_S * 1000;
      if (nowMs < refreshableMs) {
        return {
          ok: false,
          outcome: 'refused',
          description: `token_too_young: the token is younger than 24 h, it can be refreshed from ${new Date(refreshableMs).toISOString()}`,
          retryAfterS: Math.ceil((refreshableMs - nowMs) / 1000),
        };
      }
    }
    const fresh = await client.refreshAccessToken();
    if (!fresh.ok) return fresh;
    try {
      o.tokens.set(fresh.result.token, fresh.result.expiresAt);
    } catch (err) {
      return {
        ok: false,
        outcome: 'failed',
        description: scrub(
          `token_store_error: the refreshed token was not stored (${errorName(err)}); the old one stays in use`,
          [fresh.result.token],
        ),
      };
    }
    return { ok: true, result: { expiresAt: fresh.result.expiresAt } };
  }

  return { platform: 'threads', validate, publish, health, refreshToken };
}
