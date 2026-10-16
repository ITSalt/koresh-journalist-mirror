// Threads API client: container, publish, post URL, profile, quota, token refresh.
// Same rules as the Telegram client (src/telegram/bot-api.ts), restated here because this
// directory imports nothing from the rest of the service. Every failure is classified by whether
// the request can have reached Threads:
//   not_sent       the connection was never established (refused, DNS, connect timeout): safe
//                  to retry. EHOSTUNREACH and ENETUNREACH are NOT in this class: on a reused
//                  socket they can follow a request that was written and carried out
//   rate_limited   429: retry after `Retry-After` when given, else with backoff
//   server         5xx: retried for calls with no public effect; for the PUBLISH call it means
//                  "received, result not known", so it is `unknown` and never retried
//   client         other 4xx: the platform said no; never retried
//   token_invalid  error code 190 or HTTP 401: never retried; the description starts with
//                  `token_invalid`
//   unknown        the request left and no usable answer came (reset, timeout, unreadable 2xx)
//
// The PUBLISH call has its own, stricter rules (decisions D-3 and D-4), see `publishContainer`:
// an error answer is a certain "no" only when it answers the FIRST request for that container
// and is not transient. Any error answer to a later request for the same container is `unknown`,
// because an earlier request may have been carried out whatever its answer said.
//
// Descriptions never hold the URL (the token travels in it) and are scrubbed of the token, which
// the platform echoes in some of its error texts. Nothing here logs.

import {
  API_VERSION,
  authorize,
  CONTAINER_PUBLISHES_ONCE,
  CREATION_ID_PARAM,
  DEFAULT_BASE_URL,
  DEFAULT_USER_ID,
  GRANT_TYPE_REFRESH,
  isTokenError,
  isTransientError,
  ME_FIELDS,
  MEDIA_TYPE_TEXT,
  parseError,
  parseId,
  parseMe,
  parsePermalink,
  parseQuota,
  parseRefresh,
  PERMALINK_FIELDS,
  QUOTA_FIELDS,
  type Quota,
  REFRESH_PATH,
  retryAfterSeconds,
} from './platform-facts.js';
import { scrub } from './scrub.js';
import type { Outcome } from '../types.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
/** Prefix of every description that means "the token is not accepted". */
export const TOKEN_INVALID = 'token_invalid';

export type CallResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; kind: 'rate_limited'; status: number; retryAfterS?: number; description: string }
  | { ok: false; kind: 'server'; status: number; description: string }
  | {
      ok: false;
      kind: 'client' | 'token_invalid';
      status: number;
      /** The platform marks the refusal as temporary: it says nothing certain about the request. */
      transient: boolean;
      description: string;
    }
  | { ok: false; kind: 'not_sent' | 'unknown'; description: string };

/**
 * Outcome of the publish call. `notPublished` is set only when it is certain that nothing became
 * public: the first request for the container was refused with a lasting 4xx, or no request ever
 * left. Only then may the item start over with a fresh container.
 */
export type PublishCallOutcome = Outcome<{ id: string }> & { notPublished?: true };

export interface RetryOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Total attempts (default 5). */
  maxAttempts?: number;
  /** Total time spent waiting between attempts (default 90 s). */
  maxWaitMs?: number;
  /** First backoff, doubled each time (default 1 s). */
  baseDelayMs?: number;
}

export interface ThreadsClientOptions {
  /** Read for every request, so a refreshed token is used from the next call on. */
  token: () => string;
  /** Default `https://graph.threads.net` (tests point it at the local fake). */
  baseUrl?: string;
  /** Default `me`. */
  userId?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
  retry?: RetryOptions;
  /** Send the publish request once more after a first 429. Off by default: see
   *  CONTAINER_PUBLISHES_ONCE in platform-facts.ts before switching it on. */
  resendPublishAfter429?: boolean;
}

export interface ThreadsClient {
  /** Step 1. No public effect, so every failure is `failed` or `refused`, never `unknown`. */
  createContainer(text: string): Promise<Outcome<{ id: string }>>;
  /** Step 2, the public one: `unknown` whenever a request may have been carried out. */
  publishContainer(containerId: string): Promise<PublishCallOutcome>;
  permalink(postId: string, retry?: RetryOptions): Promise<Outcome<{ url: string }>>;
  me(retry?: RetryOptions): Promise<Outcome<{ id: string; username?: string }>>;
  publishingLimit(retry?: RetryOptions): Promise<Outcome<Quota>>;
  /** Asks for a refreshed token. The caller stores it; the token is in no description. */
  refreshAccessToken(): Promise<Outcome<{ token: string; expiresAt: string }>>;
}

/**
 * Error codes that can only come from the connect phase: the request was never sent. Nothing
 * else belongs here. EHOSTUNREACH and ENETUNREACH can also arrive late, on a socket that already
 * carried the request, so they are `unknown` like every other transport error (D-4).
 */
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function errorCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What a call with no public effect may do again on its own (the publish call has its own loop). */
interface Policy {
  /** Resend after a lost answer: only for calls that change nothing. */
  retryUnknown: boolean;
}
const REPEATABLE: Policy = { retryUnknown: true };
const REFRESH: Policy = { retryUnknown: false };

export function createThreadsClient(o: ThreadsClientOptions): ThreadsClient {
  // Throws here, at start, on a base URL that is not one (never later, in the middle of a call).
  const base = new URL(o.baseUrl ?? DEFAULT_BASE_URL).href.replace(/\/+$/, '');
  const user = encodeURIComponent(o.userId ?? DEFAULT_USER_ID);
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = o.now ?? (() => new Date());
  const v = `/${API_VERSION}`;

  async function call(
    op: string,
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string>,
  ): Promise<CallResult> {
    let token = '';
    try {
      token = o.token();
    } catch {
      // handled below as a missing token
    }
    if (typeof token !== 'string' || token === '') {
      return {
        ok: false,
        kind: 'token_invalid',
        status: 0,
        transient: false,
        description: `${TOKEN_INVALID}: ${op}: no token in the store`,
      };
    }
    const clean = (text: string) => scrub(text, [token]).slice(0, 300);
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers = new Headers();
    authorize(url, headers, token);
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers,
        // A redirect would carry the token to another address.
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const code = errorCode(err);
      const name = (err as { name?: unknown } | null)?.name;
      const description = clean(
        `${op}: ${typeof name === 'string' ? name : 'Error'}${code ? ` ${code}` : ''}`,
      );
      if (code && CONNECT_CODES.has(code)) return { ok: false, kind: 'not_sent', description };
      return { ok: false, kind: 'unknown', description };
    }
    const status = res.status;
    let body: unknown;
    let readable = true;
    try {
      body = await res.json();
    } catch {
      readable = false;
    }
    if (res.ok) {
      if (readable && typeof body === 'object' && body !== null && !Array.isArray(body)) {
        if (!('error' in body)) return { ok: true, body: body as Record<string, unknown> };
      }
      return {
        ok: false,
        kind: 'unknown',
        description: `${op}: unreadable answer (HTTP ${status})`,
      };
    }
    const error = readable ? parseError(body) : undefined;
    const said = error?.message ?? `HTTP ${status}`;
    const codes = error?.code !== undefined ? ` (code ${error.code}` : '';
    const sub = codes && error?.subcode !== undefined ? `, subcode ${error.subcode}` : '';
    const description = clean(`${op}: ${said}${codes}${sub}${codes ? ')' : ''}`);
    if (status === 429) {
      const retryAfterS = retryAfterSeconds(res.headers);
      return {
        ok: false,
        kind: 'rate_limited',
        status,
        description,
        ...(retryAfterS !== undefined ? { retryAfterS } : {}),
      };
    }
    if (status >= 500) return { ok: false, kind: 'server', status, description };
    const transient = isTransientError(status, error);
    if (isTokenError(status, error)) {
      return {
        ok: false,
        kind: 'token_invalid',
        status,
        transient,
        description: `${TOKEN_INVALID}: ${description}`,
      };
    }
    if (status >= 400) return { ok: false, kind: 'client', status, transient, description };
    // 1xx and 3xx never reach here with `redirect: 'error'`; if one does, nothing is known.
    return { ok: false, kind: 'unknown', description };
  }

  /** One logical call: repeats what the policy allows, within the attempt and wait bounds. */
  async function run<T>(
    op: string,
    policy: Policy,
    retry: RetryOptions | undefined,
    request: () => Promise<CallResult>,
    parse: (body: Record<string, unknown>) => T | undefined,
  ): Promise<Outcome<T>> {
    const r = { ...o.retry, ...retry };
    const sleep = r.sleep ?? realSleep;
    const maxAttempts = r.maxAttempts ?? 5;
    const maxWaitMs = r.maxWaitMs ?? 90_000;
    let delay = r.baseDelayMs ?? 1000;
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      let res = await request();
      if (res.ok) {
        const result = parse(res.body);
        if (result !== undefined) return { ok: true, result };
        res = {
          ok: false,
          kind: 'unknown',
          description: `${op}: answer without the expected fields`,
        };
      }
      const { description } = res;
      if (res.kind === 'client' || res.kind === 'token_invalid') {
        return { ok: false, outcome: 'refused', description };
      }
      if (res.kind === 'unknown' && !policy.retryUnknown) {
        return { ok: false, outcome: 'unknown', description };
      }
      const retryAfterS = res.kind === 'rate_limited' ? res.retryAfterS : undefined;
      const fail = (text: string): Outcome<T> => ({
        ok: false,
        outcome: 'failed',
        description: text,
        ...(retryAfterS !== undefined ? { retryAfterS } : {}),
      });
      if (attempt >= maxAttempts) return fail(`${description} (gave up after ${attempt} attempts)`);
      let wait: number;
      if (retryAfterS !== undefined) wait = retryAfterS * 1000;
      else {
        wait = delay;
        delay *= 2;
      }
      if (waited + wait > maxWaitMs) {
        return fail(`${description} (retry wait ${wait} ms exceeds the budget)`);
      }
      waited += wait;
      await sleep(wait);
    }
  }

  /**
   * The one call that makes something public (D-3, D-4). Requests for the same container are
   * counted: only what answers the FIRST one can be a certain "no".
   *   2xx with a post id                  ok
   *   lost answer, any other transport error, unreadable 2xx, 5xx
   *                                       `unknown`, never sent again
   *   first request, lasting 4xx          `refused`, certain (`notPublished`)
   *   first request, transient 4xx (Graph code 1 or 2, `is_transient`, HTTP 408, 409)
   *                                       `unknown`
   *   first request, 429                  `failed`, but not certain: the record stays. Only
   *                                       with `resendPublishAfter429` on (off by default, see
   *                                       CONTAINER_PUBLISHES_ONCE) is it sent once more after
   *                                       the wait, if the wait fits the budget
   *   never sent (connect phase)          sent again; all attempts never sent: `failed`, certain
   *   later request, ANY error answer     `unknown`: an earlier request may have been carried
   *                                       out (a 429 or a refused connection proves nothing
   *                                       about what the platform did with it)
   */
  async function publish(containerId: string): Promise<PublishCallOutcome> {
    const op = 'threads_publish';
    const r = o.retry ?? {};
    const sleep = r.sleep ?? realSleep;
    const maxAttempts = r.maxAttempts ?? 5;
    const maxWaitMs = r.maxWaitMs ?? 90_000;
    let delay = r.baseDelayMs ?? 1000;
    let waited = 0;
    /** True while no request can have reached the platform. */
    let neverSent = true;
    const resendAfter429 = o.resendPublishAfter429 ?? CONTAINER_PUBLISHES_ONCE;
    const STAYS = 'the publish step stays recorded, this key is not sent again';
    for (let attempt = 1; ; attempt++) {
      const res = await call(op, 'POST', `${v}/${user}/threads_publish`, {
        [CREATION_ID_PARAM]: containerId,
      });
      if (res.ok) {
        const id = parseId(res.body);
        if (id !== undefined) return { ok: true, result: { id } };
        return {
          ok: false,
          outcome: 'unknown',
          description: `${op}: answer without the expected fields`,
        };
      }
      const { description } = res;
      if (res.kind === 'unknown') return { ok: false, outcome: 'unknown', description };
      if (res.kind === 'server') {
        return {
          ok: false,
          outcome: 'unknown',
          description: `${description} (HTTP ${res.status} after the request was received)`,
        };
      }
      if (res.kind !== 'not_sent' && attempt > 1) {
        return {
          ok: false,
          outcome: 'unknown',
          description: `${description} (answer to request ${attempt} for the same container: an earlier one may have been carried out)`,
        };
      }
      if (res.kind === 'client' || res.kind === 'token_invalid') {
        if (res.transient) {
          return {
            ok: false,
            outcome: 'unknown',
            description: `${description} (a temporary refusal says nothing certain)`,
          };
        }
        return { ok: false, outcome: 'refused', description, notPublished: true };
      }
      if (res.kind === 'rate_limited') neverSent = false;
      const stop = res.kind === 'rate_limited' && !resendAfter429;
      const retryAfterS = res.kind === 'rate_limited' ? res.retryAfterS : undefined;
      const fail = (why: string): PublishCallOutcome => ({
        ok: false,
        outcome: 'failed',
        description: neverSent ? `${description} (${why})` : `${description} (${why}; ${STAYS})`,
        ...(retryAfterS !== undefined ? { retryAfterS } : {}),
        ...(neverSent ? { notPublished: true as const } : {}),
      });
      if (stop) return fail('a 429 on the publish call is not sent again');
      if (attempt >= maxAttempts) return fail(`gave up after ${attempt} attempts`);
      let wait: number;
      if (retryAfterS !== undefined) wait = retryAfterS * 1000;
      else {
        wait = delay;
        delay *= 2;
      }
      if (waited + wait > maxWaitMs) return fail(`retry wait ${wait} ms exceeds the budget`);
      waited += wait;
      await sleep(wait);
    }
  }

  return {
    createContainer(text) {
      return run(
        'threads',
        REPEATABLE,
        undefined,
        () =>
          call('threads', 'POST', `${v}/${user}/threads`, { media_type: MEDIA_TYPE_TEXT, text }),
        (b) => {
          const id = parseId(b);
          return id === undefined ? undefined : { id };
        },
      );
    },

    async publishContainer(containerId) {
      if (typeof containerId !== 'string' || containerId === '') {
        return {
          ok: false,
          outcome: 'refused',
          description: 'threads_publish: no container id, nothing was sent',
          notPublished: true,
        };
      }
      return publish(containerId);
    },

    permalink(postId, retry) {
      return run(
        'permalink',
        REPEATABLE,
        retry,
        () =>
          call('permalink', 'GET', `${v}/${encodeURIComponent(postId)}`, {
            fields: PERMALINK_FIELDS,
          }),
        (b) => {
          const url = parsePermalink(b);
          return url === undefined ? undefined : { url };
        },
      );
    },

    me(retry) {
      return run(
        'me',
        REPEATABLE,
        retry,
        () => call('me', 'GET', `${v}/${user}`, { fields: ME_FIELDS }),
        parseMe,
      );
    },

    publishingLimit(retry) {
      return run(
        'threads_publishing_limit',
        REPEATABLE,
        retry,
        () =>
          call('threads_publishing_limit', 'GET', `${v}/${user}/threads_publishing_limit`, {
            fields: QUOTA_FIELDS,
          }),
        parseQuota,
      );
    },

    refreshAccessToken() {
      return run(
        'refresh_access_token',
        REFRESH,
        undefined,
        () => call('refresh_access_token', 'GET', REFRESH_PATH, { grant_type: GRANT_TYPE_REFRESH }),
        (b) => {
          const fresh = parseRefresh(b);
          if (fresh === undefined) return undefined;
          return {
            token: fresh.token,
            expiresAt: new Date(now().getTime() + fresh.expiresInS * 1000).toISOString(),
          };
        },
      );
    },
  };
}
