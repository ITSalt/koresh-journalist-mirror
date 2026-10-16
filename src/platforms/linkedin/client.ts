// Minimal LinkedIn client for a member's self-serve token: userinfo, create post, create
// comment, introspect token. It follows the rules of the Telegram client (src/telegram/bot-api.ts)
// without importing it. Every failure is classified by whether the request can have reached
// LinkedIn:
//   not sent (refused connection, DNS failure, connect timeout) and 429: nothing was created;
//       retried with a bound, and when the bound is reached the outcome is `failed`
//   4xx: LinkedIn said no: `refused`, never retried
//   the request left and no clear answer came: `unknown`. For a call that creates a post or a
//       comment this covers a reset, a timeout, a 2xx without an id, a redirect and every 5xx
//       (decision D-3: a 5xx can follow an accepted create). It may be public, so the call stops
//       at once and is never resent. A missed post is cheaper than a doubled one.
//   The two read calls (userinfo, introspect) create nothing, so for them a lost answer or a 5xx
//   is retried like a 429 and ends as `failed`.
// A description starts with a stable code (`token_invalid: ...`, see `LinkedInErrorCode`) and
// never holds the token or the client secret: they are cut out of every text before it leaves.

import type { Outcome } from '../types.js';
import {
  INTROSPECT_PATH,
  POSTS_PATH,
  USERINFO_PATH,
  commentBody,
  commentIdFromResponse,
  commentPath,
  createdNothing,
  errorSummary,
  introspectForm,
  isDuplicateError,
  isVersionError,
  parseIntrospection,
  postBody,
  postIdFromResponse,
  restHeaders,
  retryAfterSeconds,
  type Introspection,
} from './facts.js';
import { DEFAULT_LINKEDIN_VERSION } from './config.js';

export const DEFAULT_TIMEOUT_MS = 30_000;

/** The first word of every failure description. */
export type LinkedInErrorCode =
  | 'token_invalid' // 401: the token is wrong, expired or revoked
  | 'comment_forbidden' // 403 on a comment: this token may not comment
  | 'forbidden' // 403 elsewhere
  | 'version_sunset' // the Linkedin-Version is no longer served (or missing): bump LINKEDIN_VERSION
  | 'duplicate' // 422: LinkedIn already has this content
  | 'rejected' // any other 4xx
  | 'rate_limited' // 429
  | 'server_error' // 5xx
  | 'not_sent' // the connection was never established
  | 'no_answer' // the request left, no answer came
  | 'unreadable_answer' // a 2xx that does not hold what it must
  | 'invalid_input' // refused locally, nothing was sent
  | 'not_configured'; // a needed setting is absent, nothing was sent

/** The code a description starts with (`undefined` for a success). */
export function errorCodeOf(o: Outcome<unknown>): LinkedInErrorCode | undefined {
  if (o.ok) return undefined;
  return /^([a-z_]+):/.exec(o.description)?.[1] as LinkedInErrorCode | undefined;
}

export interface RetryOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Total attempts (default 4). */
  maxAttempts?: number;
  /** Total time spent waiting between attempts (default 90 s). */
  maxWaitMs?: number;
  /** First backoff, doubled each time (default 1 s). */
  baseDelayMs?: number;
}

export interface LinkedInClientOptions {
  token: string;
  /** App credentials, needed only by `introspect`. */
  clientId?: string;
  clientSecret?: string;
  /** `Linkedin-Version`, YYYYMM (default `DEFAULT_LINKEDIN_VERSION`). */
  version?: string;
  /** Default `https://api.linkedin.com`. */
  apiBaseUrl?: string;
  /** Default `https://www.linkedin.com` (introspection lives there). */
  oauthBaseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  retry?: RetryOptions;
}

export interface LinkedInClient {
  /**
   * The member id (`sub`) of the token's owner, and the full `name` when the answer carries one
   * (the connect shows it to the director). Read only: safe to repeat.
   */
  userinfo(): Promise<Outcome<{ sub: string; name?: string }>>;
  /** One public post with this commentary (already escaped). Exactly one or none. */
  createPost(authorUrn: string, commentary: string): Promise<Outcome<{ id: string }>>;
  /** One comment by `actorUrn` under `postUrn`. */
  createComment(postUrn: string, actorUrn: string, text: string): Promise<Outcome<{ id: string }>>;
  /** Whether the token is active and when it ends. Read only: safe to repeat. */
  introspect(): Promise<Outcome<Introspection>>;
}

/**
 * Error codes that can only come before a connection exists (refused, DNS, connect timeout):
 * the request body was never sent. EHOSTUNREACH and ENETUNREACH are left out on purpose: on a
 * reused keep-alive socket they can come after the body was written, so they count as "no
 * answer" (unknown for a create).
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

/** Cuts every secret (as it is and percent-encoded) and any bearer value out of a text. */
export function scrub(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    for (const form of new Set([s, encodeURIComponent(s)]))
      out = out.split(form).join('[redacted]');
  }
  return out.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]').slice(0, 300);
}

/** One HTTP exchange, before any meaning is given to it. */
type Exchange =
  | { kind: 'http'; status: number; headers: Headers; body: unknown }
  | { kind: 'not_sent'; detail: string }
  | { kind: 'no_answer'; detail: string };

/** One attempt of one logical call. */
type Attempt<T> =
  | { ok: true; result: T }
  | { ok: false; kind: 'refused'; description: string }
  | { ok: false; kind: 'unknown'; description: string }
  | { ok: false; kind: 'retryable'; description: string; retryAfterS?: number };

interface Call<T> {
  /** Short name for descriptions, e.g. `create post`. */
  label: string;
  url: string;
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string };
  /** True for reads: an unanswered request created nothing, so it is retried like a 5xx. */
  readOnly: boolean;
  /** The code of a 403 on this call. */
  forbidden: LinkedInErrorCode;
  /** The code of a 401 on this call. */
  unauthorized: LinkedInErrorCode;
  /** Reads the result out of a 2xx; `undefined` when the answer does not hold it. */
  parse(headers: Headers, body: unknown): T | undefined;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createLinkedInClient(o: LinkedInClientOptions): LinkedInClient {
  const api = (o.apiBaseUrl ?? 'https://api.linkedin.com').replace(/\/+$/, '');
  const oauth = (o.oauthBaseUrl ?? 'https://www.linkedin.com').replace(/\/+$/, '');
  const version = o.version ?? DEFAULT_LINKEDIN_VERSION;
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secrets = [o.token, o.clientSecret];
  const clean = (text: string) => scrub(text, secrets);

  async function exchange(c: Call<unknown>): Promise<Exchange> {
    let res: Response;
    try {
      res = await doFetch(c.url, {
        ...c.init,
        // A redirect is never followed: the bearer token goes to the configured host only.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const code = errorCode(err);
      const name = (err as { name?: string } | null)?.name ?? 'Error';
      const detail = `${name}${code ? ` ${code}` : ''}`;
      return { kind: code && CONNECT_CODES.has(code) ? 'not_sent' : 'no_answer', detail };
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      // The status and the headers are known, the body was cut off: they still decide. A 201
      // carries the id of what was created in `x-restli-id`, so it is not lost with the body.
      return { kind: 'http', status: res.status, headers: res.headers, body: null };
    }
    let body: unknown = null;
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON (an HTML error page of a gateway): the status still decides.
      }
    }
    return { kind: 'http', status: res.status, headers: res.headers, body };
  }

  async function attempt<T>(c: Call<T>): Promise<Attempt<T>> {
    const x = await exchange(c);
    if (x.kind === 'not_sent') {
      return {
        ok: false,
        kind: 'retryable',
        description: clean(`not_sent: ${c.label}: ${x.detail}`),
      };
    }
    if (x.kind === 'no_answer') {
      return {
        ok: false,
        kind: c.readOnly ? 'retryable' : 'unknown',
        description: clean(`no_answer: ${c.label}: ${x.detail}`),
      };
    }
    const { status } = x;
    const said = errorSummary(x.body);
    const describe = (code: LinkedInErrorCode) =>
      clean(`${code}: ${c.label}: HTTP ${status}${said ? ` ${said}` : ''}`);
    if (status >= 200 && status < 300) {
      // The headers are read first; `body` is null when it was cut off or is not JSON.
      const result = c.parse(x.headers, x.body);
      if (result !== undefined) return { ok: true, result };
      // LinkedIn accepted the request but the answer does not say what was created.
      return {
        ok: false,
        kind: c.readOnly ? 'retryable' : 'unknown',
        description: describe('unreadable_answer'),
      };
    }
    if (createdNothing(status)) {
      const retryAfterS = retryAfterSeconds(x.headers);
      return {
        ok: false,
        kind: 'retryable',
        description: describe('rate_limited'),
        ...(retryAfterS !== undefined ? { retryAfterS } : {}),
      };
    }
    if (status >= 500) {
      // D-3: a 5xx can follow an accepted create, so the post or comment may be public.
      return {
        ok: false,
        kind: c.readOnly ? 'retryable' : 'unknown',
        description: describe('server_error'),
      };
    }
    if (status >= 400) {
      let code: LinkedInErrorCode = 'rejected';
      if (isVersionError(status, x.body)) code = 'version_sunset';
      else if (status === 401) code = c.unauthorized;
      else if (status === 403) code = c.forbidden;
      else if (isDuplicateError(status, x.body)) code = 'duplicate';
      return { ok: false, kind: 'refused', description: describe(code) };
    }
    // 1xx or 3xx: not an answer LinkedIn documents for these calls.
    return {
      ok: false,
      kind: c.readOnly ? 'retryable' : 'unknown',
      description: describe('unreadable_answer'),
    };
  }

  /**
   * One logical call: retries only what is known not to have been accepted (429, a connection
   * that was never made; for the two read calls also a 5xx or a lost answer); stops at the first
   * refusal and at the first unknown outcome.
   */
  async function run<T>(c: Call<T>): Promise<Outcome<T>> {
    const sleep = o.retry?.sleep ?? realSleep;
    const maxAttempts = o.retry?.maxAttempts ?? 4;
    const maxWaitMs = o.retry?.maxWaitMs ?? 90_000;
    let delay = o.retry?.baseDelayMs ?? 1000;
    let waited = 0;
    for (let n = 1; ; n++) {
      let a: Attempt<T>;
      try {
        a = await attempt(c);
      } catch (err) {
        // Nothing above is meant to throw; if it does, the request may have left.
        const name = (err as { name?: string } | null)?.name ?? 'Error';
        a = { ok: false, kind: 'unknown', description: clean(`no_answer: ${c.label}: ${name}`) };
      }
      if (a.ok) return a;
      if (a.kind === 'unknown')
        return { ok: false, outcome: 'unknown', description: a.description };
      if (a.kind === 'refused') {
        // A duplicate reported on a retry would mean an earlier attempt of this same call was
        // accepted after all (a retry only follows a 429 or a connection that was never made,
        // so this is not expected): the post may be public, so it is not a clean "no".
        if (n > 1 && !c.readOnly && a.description.startsWith('duplicate:')) {
          return {
            ok: false,
            outcome: 'unknown',
            description: clean(
              `${a.description} (after a retry: an earlier attempt may be public)`,
            ),
          };
        }
        return { ok: false, outcome: 'refused', description: a.description };
      }
      const { description, retryAfterS } = a;
      const failed = (why: string): Outcome<T> => ({
        ok: false,
        outcome: 'failed',
        description: clean(`${description} (${why})`),
        ...(retryAfterS !== undefined ? { retryAfterS } : {}),
      });
      if (n >= maxAttempts) return failed(`gave up after ${n} attempts`);
      let wait: number;
      if (retryAfterS !== undefined) wait = retryAfterS * 1000;
      else {
        wait = delay;
        delay *= 2;
      }
      if (waited + wait > maxWaitMs) return failed(`retry wait ${wait} ms exceeds the budget`);
      waited += wait;
      await sleep(wait);
    }
  }

  const rest = () => restHeaders(o.token, version);

  return {
    userinfo() {
      return run({
        label: 'userinfo',
        url: `${api}${USERINFO_PATH}`,
        init: { method: 'GET', headers: { authorization: `Bearer ${o.token}` } },
        readOnly: true,
        forbidden: 'forbidden',
        unauthorized: 'token_invalid',
        parse(_h, body) {
          const b = body as { sub?: unknown; name?: unknown } | null;
          const sub = b?.sub;
          if (typeof sub !== 'string' || sub === '') return undefined;
          const name = typeof b?.name === 'string' ? b.name.trim() : '';
          return name !== '' ? { sub, name } : { sub };
        },
      });
    },

    createPost(authorUrn, commentary) {
      return run({
        label: 'create post',
        url: `${api}${POSTS_PATH}`,
        init: {
          method: 'POST',
          headers: rest(),
          body: JSON.stringify(postBody(authorUrn, commentary)),
        },
        readOnly: false,
        forbidden: 'forbidden',
        unauthorized: 'token_invalid',
        parse(headers) {
          const id = postIdFromResponse(headers);
          return id ? { id } : undefined;
        },
      });
    },

    createComment(postUrn, actorUrn, text) {
      return run({
        label: 'create comment',
        url: `${api}${commentPath(postUrn)}`,
        init: {
          method: 'POST',
          headers: rest(),
          body: JSON.stringify(commentBody(actorUrn, postUrn, text)),
        },
        readOnly: false,
        forbidden: 'comment_forbidden',
        unauthorized: 'token_invalid',
        parse(headers, body) {
          const id = commentIdFromResponse(headers, body);
          return id ? { id } : undefined;
        },
      });
    },

    async introspect() {
      if (!o.clientId || !o.clientSecret) {
        return {
          ok: false,
          outcome: 'refused',
          description:
            'not_configured: introspect: LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET are needed',
        };
      }
      return run({
        label: 'introspect',
        url: `${oauth}${INTROSPECT_PATH}`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: introspectForm(o.clientId, o.clientSecret, o.token),
        },
        readOnly: true,
        forbidden: 'forbidden',
        // Here a 401 is about the app's secret, not about the member token.
        unauthorized: 'rejected',
        parse: (_h, body) => parseIntrospection(body),
      });
    },
  };
}
