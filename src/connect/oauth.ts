// The OAuth side of the account connect (WP-PLAT-06): the authorize links and the exchange of a
// code for the token the adapters use. Every platform fact is one constant or one function here.
//
//   [read]     official pages read on 13.10.2026:
//              Threads  developers.facebook.com/documentation/threads/get-started/
//                       get-access-tokens-and-permissions and .../long-lived-tokens
//              LinkedIn learn.microsoft.com/en-us/linkedin/shared/authentication/
//                       authorization-code-flow and .../consumer/integrations/self-serve/
//                       sign-in-with-linkedin-v2
//   [assumed]  not settled by those pages; to be confirmed by the owner's first sitting
//
// What already exists in the adapters is used from there, not rewritten: the Threads profile
// read (`me`) and the LinkedIn `userinfo`. The refresh of the Threads token is the adapter's
// `refreshToken` (see ./service.ts). The adapters have no code exchange, so it lives here.
//
// A code is single use, so no call that carries one is ever sent twice. Nothing here logs. A
// failure is a fixed reason code plus a detail built only from the HTTP status and the short
// machine codes of the platform's error body, never from its free text (which can echo the
// code), and the request's own secrets are cut out of the detail before it leaves.

import { createLinkedInClient } from '../platforms/linkedin/client.js';
import { createThreadsClient } from '../platforms/threads/client.js';
import { GRANT_TYPE_EXCHANGE } from '../platforms/threads/platform-facts.js';

/** [read] Threads: comma-separated. No reply permission until replies are built (D-6). */
export const THREADS_SCOPES = ['threads_basic', 'threads_content_publish'] as const;
/** [read] LinkedIn: always the same set; another set invalidates the earlier tokens. */
export const LINKEDIN_SCOPES = ['openid', 'profile', 'w_member_social'] as const;

/** [read] The authorization window of Threads, as the page prints it today. */
export const DEFAULT_THREADS_AUTHORIZE_URL = 'https://threads.com/oauth/authorize';
/** [read] Code for a short-lived token: a POST on the API host. */
export const THREADS_CODE_PATH = '/oauth/access_token';
/** [read] Short-lived for long-lived token: `GET /access_token`. */
export const THREADS_LONG_LIVED_PATH = '/access_token';
/** [read] */
export const LINKEDIN_AUTHORIZE_PATH = '/oauth/v2/authorization';
/** [read] */
export const LINKEDIN_TOKEN_PATH = '/oauth/v2/accessToken';

export const DEFAULT_EXCHANGE_TIMEOUT_MS = 10_000;

export type ExchangeFailureCode =
  /** The platform answered the code or token exchange with an error. */
  | 'exchange_failed'
  /** No usable answer came (timeout, reset, unreadable body). */
  | 'platform_unreachable'
  /** The token was issued but the account behind it could not be read. */
  | 'account_unreadable';

export type ExchangeResult =
  | { ok: true; token: string; expiresAt: string; account: { id: string; name: string } }
  | { ok: false; code: ExchangeFailureCode; detail: string };

export interface ExchangeDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface ThreadsApp {
  appId: string;
  appSecret: string;
  /** Like `https://graph.threads.net`. */
  apiBaseUrl: string;
  authorizeUrl: string;
}

export interface LinkedInApp {
  clientId: string;
  clientSecret: string;
  /** Like `https://www.linkedin.com`. */
  oauthBaseUrl: string;
  /** Like `https://api.linkedin.com`. */
  apiBaseUrl: string;
}

const trimBase = (url: string) => url.replace(/\/+$/, '');

/** [read] `client_id`, `redirect_uri`, `scope`, `response_type=code`, `state`. */
export function threadsAuthorizeUrl(app: ThreadsApp, redirectUri: string, state: string): string {
  const url = new URL(app.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: redirectUri,
    scope: THREADS_SCOPES.join(','),
    response_type: 'code',
    state,
  }).toString();
  return url.href;
}

/** [read] `response_type=code`, `client_id`, `redirect_uri`, `state`, `scope` (space-delimited,
 *  URL-encoded as `%20` like the documented sample). */
export function linkedinAuthorizeUrl(app: LinkedInApp, redirectUri: string, state: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: redirectUri,
    state,
    scope: LINKEDIN_SCOPES.join(' '),
  })
    .toString()
    .replace(/\+/g, '%20');
  return `${trimBase(app.oauthBaseUrl)}${LINKEDIN_AUTHORIZE_PATH}?${query}`;
}

type Answer = { kind: 'http'; status: number; body: unknown } | { kind: 'no_answer'; name: string };

async function request(
  url: string,
  init: { method: 'GET' | 'POST'; form?: Record<string, string> },
  deps: ExchangeDeps,
): Promise<Answer> {
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: init.method,
      ...(init.form
        ? {
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(init.form).toString(),
          }
        : {}),
      // A redirect would carry the code or the secret to another address.
      redirect: 'error',
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    return { kind: 'no_answer', name: typeof name === 'string' ? name : 'Error' };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(await res.text());
  } catch {
    // Not JSON, or cut off: the status still decides.
  }
  return { kind: 'http', status: res.status, body };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A short machine code of an error body (`OAuthException`, `invalid_request`, `190`), or ''. */
function machineCode(v: unknown): string {
  const text = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
  return typeof text === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(text) ? text : '';
}

/**
 * `HTTP <status>` plus the machine codes of the error body. The free text of the body
 * (`error_message`, `error_description`, `message`) is deliberately left out: platforms echo the
 * code and tokens there.
 */
function httpDetail(status: number, body: unknown): string {
  const parts: string[] = [`HTTP ${status}`];
  if (isRecord(body)) {
    const nested = isRecord(body.error) ? body.error : undefined;
    for (const v of [
      body.error_type,
      body.code,
      nested ? nested.type : body.error,
      nested?.code,
      nested?.error_subcode,
    ]) {
      const code = machineCode(v);
      if (code !== '') parts.push(code);
    }
  }
  return parts.join(' ');
}

/** Cuts every given secret (as it is and percent-encoded) out of a text. */
export function cut(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    for (const form of new Set([s, encodeURIComponent(s)]))
      out = out.split(form).join('[redacted]');
  }
  return out.slice(0, 300);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const positive = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

/**
 * Threads: code -> short-lived token (1 hour) -> long-lived token (60 days) -> the profile behind
 * it, all inside the one callback, so the short-lived token never rests anywhere.
 *   [read]    POST <api>/oauth/access_token with client_id, client_secret, code,
 *             grant_type=authorization_code, redirect_uri -> { access_token, user_id }
 *   [assumed] the POST is accepted as a URL-encoded form (the documented sample is `curl -F`)
 *   [read]    GET <api>/access_token?grant_type=th_exchange_token&client_secret=&access_token=
 *             -> { access_token, token_type, expires_in }
 */
export async function exchangeThreadsCode(
  app: ThreadsApp,
  redirectUri: string,
  code: string,
  deps: ExchangeDeps = {},
): Promise<ExchangeResult> {
  const now = deps.now ?? (() => new Date());
  const base = trimBase(app.apiBaseUrl);
  const secrets: (string | undefined)[] = [code, app.appSecret];
  const fail = (failure: ExchangeFailureCode, detail: string): ExchangeResult => ({
    ok: false,
    code: failure,
    detail: cut(detail, secrets),
  });

  const first = await request(
    `${base}${THREADS_CODE_PATH}`,
    {
      method: 'POST',
      form: {
        client_id: app.appId,
        client_secret: app.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      },
    },
    deps,
  );
  if (first.kind === 'no_answer') return fail('platform_unreachable', `code: ${first.name}`);
  const short = isRecord(first.body) ? str(first.body.access_token) : undefined;
  secrets.push(short);
  if (first.status < 200 || first.status >= 300) {
    return fail('exchange_failed', `code: ${httpDetail(first.status, first.body)}`);
  }
  if (short === undefined) return fail('platform_unreachable', 'code: answer without a token');

  const longUrl = new URL(`${base}${THREADS_LONG_LIVED_PATH}`);
  longUrl.search = new URLSearchParams({
    grant_type: GRANT_TYPE_EXCHANGE,
    client_secret: app.appSecret,
    access_token: short,
  }).toString();
  const second = await request(longUrl.href, { method: 'GET' }, deps);
  if (second.kind === 'no_answer')
    return fail('platform_unreachable', `long-lived: ${second.name}`);
  const long = isRecord(second.body) ? str(second.body.access_token) : undefined;
  secrets.push(long);
  if (second.status < 200 || second.status >= 300) {
    return fail('exchange_failed', `long-lived: ${httpDetail(second.status, second.body)}`);
  }
  const expiresInS = isRecord(second.body) ? positive(second.body.expires_in) : undefined;
  if (long === undefined || expiresInS === undefined) {
    return fail('platform_unreachable', 'long-lived: answer without a token or its lifetime');
  }
  const expiresAt = new Date(now().getTime() + expiresInS * 1000).toISOString();

  // The adapter's own profile read, with the new token.
  const me = await createThreadsClient({
    token: () => long,
    baseUrl: base,
    timeoutMs: deps.timeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS,
    retry: { maxAttempts: 2, baseDelayMs: 500, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  }).me();
  if (!me.ok) return fail('account_unreadable', `me: ${me.description}`);
  return {
    ok: true,
    token: long,
    expiresAt,
    account: { id: me.result.id, name: me.result.username ?? me.result.id },
  };
}

/**
 * LinkedIn: code -> the 60-day member token -> the member behind it.
 *   [read] POST <oauth>/oauth/v2/accessToken, URL-encoded form with grant_type=authorization_code,
 *          code, client_id, client_secret, redirect_uri -> { access_token, expires_in, scope }
 *   [read] GET <api>/v2/userinfo -> { sub, name, ... } (the adapter's own call)
 */
export async function exchangeLinkedInCode(
  app: LinkedInApp,
  redirectUri: string,
  code: string,
  deps: ExchangeDeps = {},
): Promise<ExchangeResult> {
  const now = deps.now ?? (() => new Date());
  const secrets: (string | undefined)[] = [code, app.clientSecret];
  const fail = (failure: ExchangeFailureCode, detail: string): ExchangeResult => ({
    ok: false,
    code: failure,
    detail: cut(detail, secrets),
  });

  const answer = await request(
    `${trimBase(app.oauthBaseUrl)}${LINKEDIN_TOKEN_PATH}`,
    {
      method: 'POST',
      form: {
        grant_type: 'authorization_code',
        code,
        client_id: app.clientId,
        client_secret: app.clientSecret,
        redirect_uri: redirectUri,
      },
    },
    deps,
  );
  if (answer.kind === 'no_answer') return fail('platform_unreachable', `token: ${answer.name}`);
  const token = isRecord(answer.body) ? str(answer.body.access_token) : undefined;
  secrets.push(token);
  if (isRecord(answer.body))
    secrets.push(str(answer.body.id_token), str(answer.body.refresh_token));
  if (answer.status < 200 || answer.status >= 300) {
    return fail('exchange_failed', `token: ${httpDetail(answer.status, answer.body)}`);
  }
  const expiresInS = isRecord(answer.body) ? positive(answer.body.expires_in) : undefined;
  if (token === undefined || expiresInS === undefined) {
    return fail('platform_unreachable', 'token: answer without a token or its lifetime');
  }
  const expiresAt = new Date(now().getTime() + expiresInS * 1000).toISOString();

  const who = await createLinkedInClient({
    token,
    apiBaseUrl: app.apiBaseUrl,
    oauthBaseUrl: app.oauthBaseUrl,
    timeoutMs: deps.timeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS,
    retry: { maxAttempts: 2, baseDelayMs: 500, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  }).userinfo();
  if (!who.ok) return fail('account_unreadable', `userinfo: ${who.description}`);
  return {
    ok: true,
    token,
    expiresAt,
    account: { id: who.result.sub, name: who.result.name ?? who.result.sub },
  };
}
