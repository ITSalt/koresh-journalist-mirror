// Every fact about the Threads API that this adapter relies on, in one file. Nobody has a tester
// account yet, so nothing here has met the live API.
//
//   [read]     taken from the platform's documentation on 12.10.2026
//              (features/journalist/next/platforms-plan.md in the orchestrator workspace)
//   [assumed]  not in what was read, or read without the exact spelling: one constant or one
//              function each, so the first real call can correct it in one place
//
// The fake server in test/support/fake-threads.ts answers the way this file expects.

/** [read] */
export const DEFAULT_BASE_URL = 'https://graph.threads.net';
/** [read] */
export const API_VERSION = 'v1.0';
/** [read] Container of a text post. */
export const MEDIA_TYPE_TEXT = 'TEXT';
/** [read] Long-lived token lifetime; a refreshed token lives as long again. */
export const TOKEN_LIFETIME_S = 60 * 24 * 3600;
/** [read] A token can be refreshed when it is at least this old (and not expired). */
export const REFRESH_MIN_AGE_S = 24 * 3600;
/** [read] At most this many links in one post. */
export const MAX_LINKS = 5;

/** [assumed] Name of the publish call's parameter that holds the container id. */
export const CREATION_ID_PARAM = 'creation_id';
/** [assumed] `grant_type` of the refresh call. */
export const GRANT_TYPE_REFRESH = 'th_refresh_token';
/** [assumed] `grant_type` of the short-to-long exchange call. No code here calls it: the exchange
 *  is outside this package; the value is kept so that both spellings sit in one place. */
export const GRANT_TYPE_EXCHANGE = 'th_exchange_token';
/** [assumed] Path of the refresh call: on the host root, without the version prefix. */
export const REFRESH_PATH = '/refresh_access_token';
/** [assumed] `me` is accepted wherever the documentation writes `{user-id}`. */
export const DEFAULT_USER_ID = 'me';
/** [assumed] A text container can be published at once (the documented wait is about media). */
export const DEFAULT_PUBLISH_DELAY_MS = 0;
/**
 * [assumed, NOT confirmed] A container can be published once: a publish request for a container
 * that is already public is refused. Nothing read so far says so (the fake's refusal text is
 * invented), so this is false and the publish request is never sent a second time: a first 429
 * ends the call as `failed` after one request and the record stays at the publish step. The cost
 * is known: a 429 on the publish call loses that post. Set it to true (or pass
 * `resendPublishAfter429: true`) only after live calls have shown a second publish of the same
 * container being refused; then a first 429 is followed by one resend after the wait.
 */
export const CONTAINER_PUBLISHES_ONCE = false;
/** [assumed] Fields of the profile read used by `health`. */
export const ME_FIELDS = 'id,username';
/** [assumed] Fields of the quota read. */
export const QUOTA_FIELDS = 'quota_usage,config';
/** [assumed] Fields of the read that returns the public URL of a published post. */
export const PERMALINK_FIELDS = 'id,permalink';

/**
 * [assumed] How the token travels: the `access_token` query parameter, as in the documented
 * examples. The alternative, if the live API prefers it, is an `Authorization: Bearer` header.
 */
export function authorize(url: URL, headers: Headers, token: string): void {
  void headers;
  url.searchParams.set('access_token', token);
}

export interface ApiError {
  message?: string;
  type?: string;
  code?: number;
  subcode?: number;
  /** `is_transient` of the error body. */
  transient?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const id = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== ''
    ? v
    : typeof v === 'number' && Number.isFinite(v)
      ? String(v)
      : undefined;

/** [assumed] Error body in the Graph API shape:
 *  `{ error: { message, type, code, error_subcode, is_transient } }`. */
export function parseError(body: unknown): ApiError | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const e = body.error;
  return {
    ...(typeof e.message === 'string' ? { message: e.message } : {}),
    ...(typeof e.type === 'string' ? { type: e.type } : {}),
    ...(num(e.code) !== undefined ? { code: num(e.code) } : {}),
    ...(num(e.error_subcode) !== undefined ? { subcode: num(e.error_subcode) } : {}),
    ...(e.is_transient === true ? { transient: true } : {}),
  };
}

/** [assumed] A token error is error code 190 (any subcode) or HTTP 401. */
export function isTokenError(status: number, error: ApiError | undefined): boolean {
  return error?.code === 190 || status === 401;
}

/**
 * [assumed] A refusal the platform itself calls temporary: Graph error code 1 (unknown error) or
 * 2 (service temporarily unavailable), `is_transient: true`, or HTTP 408 / 409. Such an answer
 * to the publish call says nothing certain about what happened to the request.
 */
export function isTransientError(status: number, error: ApiError | undefined): boolean {
  if (status === 408 || status === 409) return true;
  return error?.transient === true || error?.code === 1 || error?.code === 2;
}

/** [assumed] A rate limit is HTTP 429; the wait, when given, is the `Retry-After` header in seconds. */
export function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null || raw.trim() === '') return undefined;
  const s = Number(raw);
  return Number.isFinite(s) && s >= 0 ? s : undefined;
}

/** [assumed] Container and publish calls both answer `{ "id": "<id>" }`. */
export function parseId(body: Record<string, unknown>): string | undefined {
  return id(body.id);
}

/** [assumed] The profile read answers `{ id, username }`. */
export function parseMe(
  body: Record<string, unknown>,
): { id: string; username?: string } | undefined {
  const userId = id(body.id);
  if (userId === undefined) return undefined;
  return { id: userId, ...(typeof body.username === 'string' ? { username: body.username } : {}) };
}

/** [assumed] The post read answers `{ id, permalink }`. */
export function parsePermalink(body: Record<string, unknown>): string | undefined {
  return typeof body.permalink === 'string' && /^https:\/\//.test(body.permalink)
    ? body.permalink
    : undefined;
}

export interface Quota {
  usage: number;
  total: number;
  durationS?: number;
}

/** [assumed] `{ data: [{ quota_usage, config: { quota_total, quota_duration } }] }`. */
export function parseQuota(body: Record<string, unknown>): Quota | undefined {
  const row = Array.isArray(body.data) ? (body.data as unknown[])[0] : undefined;
  if (!isRecord(row) || !isRecord(row.config)) return undefined;
  const usage = num(row.quota_usage);
  const total = num(row.config.quota_total);
  if (usage === undefined || total === undefined || total <= 0) return undefined;
  const durationS = num(row.config.quota_duration);
  return { usage, total, ...(durationS !== undefined ? { durationS } : {}) };
}

/** [assumed] The refresh call answers `{ access_token, token_type, expires_in }` (seconds). */
export function parseRefresh(
  body: Record<string, unknown>,
): { token: string; expiresInS: number } | undefined {
  const expiresInS = num(body.expires_in);
  if (typeof body.access_token !== 'string' || body.access_token === '') return undefined;
  if (expiresInS === undefined || expiresInS <= 0) return undefined;
  return { token: body.access_token, expiresInS };
}

/**
 * [assumed] What the platform counts as a link: anything that starts with a scheme or `www.`, and
 * a bare host name (`t.me/Channel1/57`, `example.com`). Every occurrence counts (the platform may
 * count unique links only), and `Node.js` counts too: this errs towards refusing a text the
 * platform would take, never towards accepting one it would refuse.
 */
export function countLinks(text: string): number {
  const link =
    /(?:https?:\/\/|www\.)[^\s]+|(?<![\w@.])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?(?![\w@])/giu;
  return [...text.matchAll(link)].length;
}
