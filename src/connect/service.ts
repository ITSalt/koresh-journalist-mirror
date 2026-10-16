// Account connect (WP-PLAT-06, decision D-5): the owner opens one link, the platform sends him
// back to our callback, the service exchanges the code on the server and keeps the token
// encrypted. No token passes through a chat, GitHub or the director's session.
//
// This file is the whole logic; HTTP lives in ./public.ts (the public callback and the two
// static pages) and ../api/connect.ts (the director's routes behind the bearer).
//
// Rules that hold everywhere here:
//   - a token, a code, a state, an app secret or the store key is never put into a return value
//     meant for a response, an alert, a log line or an error message;
//   - a state is stored hashed, is valid 30 minutes and is used up by its first presentation;
//   - a wrong or missing setting switches the connect off with a named reason. It never throws
//     at start: the publishing service must not stop because of a connect setting.

import type { Config } from '../config.js';
import { expiryReminder, type ExpiryReminder } from '../platforms/linkedin/expiry.js';
import { createThreadsAdapter } from '../platforms/threads/adapter.js';
import { createMemoryStepStore } from '../platforms/threads/step-store.js';
import type { TokenStore } from '../platforms/threads/token-store.js';
import { CONNECT_PLATFORMS, type ConnectPlatform } from '../store/connect.js';
import type { Store } from '../store/index.js';
import {
  decryptToken,
  encryptToken,
  hashState,
  isStateShaped,
  newState,
  parseTokenStoreKey,
} from './crypto.js';
import {
  cut,
  exchangeLinkedInCode,
  exchangeThreadsCode,
  linkedinAuthorizeUrl,
  threadsAuthorizeUrl,
  type ExchangeResult,
} from './oauth.js';

export { CONNECT_PLATFORMS, type ConnectPlatform } from '../store/connect.js';

export const STATE_TTL_MS = 30 * 60_000;
/** The Threads token is refreshed once it has gone this long without a refresh. */
export const THREADS_REFRESH_EVERY_MS = 7 * 86_400_000;
/** After a failed refresh the next attempt waits this long (one alert a day, not one an hour). */
export const THREADS_REFRESH_RETRY_MS = 86_400_000;
const MAX_CODE_LENGTH = 1500;

export function isConnectPlatform(v: string): v is ConnectPlatform {
  return (CONNECT_PLATFORMS as readonly string[]).includes(v);
}

/** The reason code shown on the fixed error page («Не получилось: <код>»). */
export type ConnectFailure =
  | 'not_configured'
  | 'link_unknown'
  | 'link_expired'
  | 'link_used'
  | 'link_wrong_platform'
  | 'denied'
  | 'no_code'
  | 'exchange_failed'
  | 'platform_unreachable'
  | 'account_unreadable'
  | 'wrong_account'
  | 'store_failed';

export type CallbackResult = { ok: true } | { ok: false; reason: ConnectFailure };

export interface PublicBase {
  /** `https://host/prefix`, no trailing slash. */
  base: string;
  /** The path part, e.g. `/koresh`: the only prefix the public routes live under. */
  prefix: string;
}

/**
 * PUBLIC_BASE must be `https://<host>/<prefix>`: https, no credentials, no query, no fragment,
 * and a non-empty path of plain segments (the public routes get a prefix of their own, apart
 * from the director's routes: not `/v1`, `/health` or `/ready`). `undefined` for anything else.
 */
export function parsePublicBase(raw: string | undefined): PublicBase | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    return undefined;
  }
  const prefix = url.pathname.replace(/\/+$/, '');
  if (!/^(\/[A-Za-z0-9_-]+)+$/.test(prefix)) return undefined;
  // Never the place of the service's own routes.
  if (/^\/(v1|health|ready)(\/|$)/.test(prefix)) return undefined;
  return { base: `${url.origin}${prefix}`, prefix };
}

export interface PlatformOverview {
  connected: boolean;
  /** False while a setting this platform needs is absent or wrong (`missing` names them). */
  configured: boolean;
  missing?: string[];
  account?: { id: string; name: string };
  tokenExpiresAt?: string;
  connectedAt?: string;
  lastRefreshAt?: string;
  lastError?: string;
  /** LinkedIn only: how close the 60-day end is (the owner repeats the consent before it). */
  reminder?: ExpiryReminder;
}

export interface ConnectLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export type ConnectConfig = Pick<
  Config,
  | 'PUBLIC_BASE'
  | 'TOKEN_STORE_KEY'
  | 'THREADS_APP_ID'
  | 'THREADS_APP_SECRET'
  | 'THREADS_EXPECTED_USERNAME'
  | 'THREADS_AUTHORIZE_URL'
  | 'THREADS_API_BASE_URL'
  | 'LINKEDIN_CLIENT_ID'
  | 'LINKEDIN_CLIENT_SECRET'
  | 'LINKEDIN_EXPECTED_SUB'
  | 'LINKEDIN_OAUTH_BASE_URL'
  | 'LINKEDIN_API_BASE_URL'
>;

export interface ConnectServiceOptions {
  config: ConnectConfig;
  store: Pick<Store, 'connect' | 'alerts' | 'botState'>;
  now?: () => Date;
  /** Tests point the platform base URLs at local fakes; `fetch` and `sleep` are for them too. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface ConnectService {
  /** The public address, when PUBLIC_BASE is a usable one. */
  publicBase(): PublicBase | undefined;
  /** `<PUBLIC_BASE>/oauth/<platform>/callback`: what the owner registers in the app. */
  redirectUri(platform: ConnectPlatform): string | undefined;
  /** The authorize link with a fresh one-time state; `missing` names what is not set. */
  start(
    platform: ConnectPlatform,
  ): { ok: true; url: string; expiresAt: string } | { ok: false; missing: string[] };
  /** The platform sent the owner back. Only the reason code leaves; see the rules above. */
  callback(
    platform: ConnectPlatform,
    query: { code?: string; state?: string; error?: string },
    log?: ConnectLog,
  ): Promise<CallbackResult>;
  /** Deletes the token and the account record at once. False when nothing was stored. */
  disconnect(platform: ConnectPlatform): { disconnected: boolean };
  overview(): Record<ConnectPlatform, PlatformOverview>;
  /** The adapters' token seam (`get`, `set`, `expiresAt`) over the encrypted row. */
  tokenStore(platform: ConnectPlatform): TokenStore & { expiresAt(): string | undefined };
  /**
   * Periodic work: weekly Threads refresh, LinkedIn expiry reminders, an alert when a stored
   * token stops being readable, old states removed.
   */
  tick(log?: ConnectLog): Promise<void>;
}

const errorName = (err: unknown): string => {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : 'Error';
};

export function createConnectService(o: ConnectServiceOptions): ConnectService {
  const { config, store } = o;
  const now = o.now ?? (() => new Date());
  const base = parsePublicBase(config.PUBLIC_BASE);
  const key = parseTokenStoreKey(config.TOKEN_STORE_KEY);
  const deps = {
    now,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
  };

  const app = {
    threads: { id: config.THREADS_APP_ID, secret: config.THREADS_APP_SECRET },
    linkedin: { id: config.LINKEDIN_CLIENT_ID, secret: config.LINKEDIN_CLIENT_SECRET },
  };
  const NAMES = {
    threads: { id: 'THREADS_APP_ID', secret: 'THREADS_APP_SECRET' },
    linkedin: { id: 'LINKEDIN_CLIENT_ID', secret: 'LINKEDIN_CLIENT_SECRET' },
  } as const;

  /** Env names only, never values. */
  function missing(platform: ConnectPlatform): string[] {
    const out: string[] = [];
    if (!config.PUBLIC_BASE) out.push('PUBLIC_BASE is not set');
    else if (!base) out.push('PUBLIC_BASE must be an https address with a path prefix');
    if (!config.TOKEN_STORE_KEY) out.push('TOKEN_STORE_KEY is not set');
    else if (!key) out.push('TOKEN_STORE_KEY must be base64 of 32 bytes');
    if (!app[platform].id) out.push(`${NAMES[platform].id} is not set`);
    if (!app[platform].secret) out.push(`${NAMES[platform].secret} is not set`);
    return out;
  }

  const redirectUri = (platform: ConnectPlatform) =>
    base ? `${base.base}/oauth/${platform}/callback` : undefined;

  // Small per-platform notes kept in the existing key/value table.
  const errorKey = (p: ConnectPlatform) => `connect.${p}.last_error`;
  const setLastError = (p: ConnectPlatform, text: string) =>
    store.botState.set(errorKey(p), text === '' ? '' : `${now().toISOString()} ${text}`);
  const lastError = (p: ConnectPlatform) => store.botState.get(errorKey(p)) || undefined;
  const REMINDER_KEY = 'connect.linkedin.reminder';
  const unreadableKey = (p: ConnectPlatform) => `connect.${p}.token_unreadable`;
  const REFRESH_ATTEMPT_KEY = 'connect.threads.refresh_attempt_at';

  function readToken(platform: ConnectPlatform): string | undefined {
    if (!key) return undefined;
    const row = store.connect.tokens.get(platform);
    return row ? decryptToken(key, platform, row.tokenEnc) : undefined;
  }

  function tokenStore(platform: ConnectPlatform) {
    return {
      /** '' when nothing is stored or it cannot be read: the adapters answer `token_invalid`. */
      get: () => readToken(platform) ?? '',
      set(token: string, expiresAt: string) {
        if (!key) throw new Error('TOKEN_STORE_KEY is not usable');
        if (typeof token !== 'string' || token === '') throw new Error('empty token');
        const stored = store.connect.tokens.replaceToken(
          platform,
          encryptToken(key, platform, token),
          expiresAt,
          now(),
        );
        // Not connected (disconnected meanwhile): a refresh never brings a token back.
        if (!stored) throw new Error(`${platform} is not connected`);
      },
      expiresAt: () => store.connect.tokens.get(platform)?.expiresAt,
    };
  }

  function exchange(platform: ConnectPlatform, code: string): Promise<ExchangeResult> {
    const redirect = redirectUri(platform) as string;
    if (platform === 'threads') {
      return exchangeThreadsCode(
        {
          appId: app.threads.id as string,
          appSecret: app.threads.secret as string,
          apiBaseUrl: config.THREADS_API_BASE_URL,
          authorizeUrl: config.THREADS_AUTHORIZE_URL,
        },
        redirect,
        code,
        deps,
      );
    }
    return exchangeLinkedInCode(
      {
        clientId: app.linkedin.id as string,
        clientSecret: app.linkedin.secret as string,
        oauthBaseUrl: config.LINKEDIN_OAUTH_BASE_URL,
        apiBaseUrl: config.LINKEDIN_API_BASE_URL,
      },
      redirect,
      code,
      deps,
    );
  }

  /** The configured expected account, and whether this one is it. */
  function expected(
    platform: ConnectPlatform,
    account: { id: string; name: string },
  ): { set: boolean; matches: boolean } {
    if (platform === 'threads') {
      const want = config.THREADS_EXPECTED_USERNAME?.trim().replace(/^@/, '').toLowerCase();
      if (!want) return { set: false, matches: true };
      return { set: true, matches: account.name.toLowerCase() === want };
    }
    const want = config.LINKEDIN_EXPECTED_SUB?.trim();
    if (!want) return { set: false, matches: true };
    return { set: true, matches: account.id === want };
  }

  /** Records a failed connect for the director: last error, alert, log line. No secrets. */
  function failed(
    platform: ConnectPlatform,
    reason: ConnectFailure,
    detail: string,
    secrets: readonly (string | undefined)[],
    log: ConnectLog | undefined,
  ): CallbackResult {
    const text = cut(`${reason}${detail ? `: ${detail}` : ''}`, [
      ...secrets,
      app[platform].secret,
      config.TOKEN_STORE_KEY,
    ]);
    setLastError(platform, text);
    store.alerts.add(
      { kind: 'platform_connect_failed', message: `${platform} connect failed: ${text}` },
      now(),
    );
    log?.warn({ platform, reason: text }, 'platform connect failed');
    return { ok: false, reason };
  }

  async function callback(
    platform: ConnectPlatform,
    query: { code?: string; state?: string; error?: string },
    log?: ConnectLog,
  ): Promise<CallbackResult> {
    // Nothing below this line runs for a request that does not carry a state we issued: no
    // platform call, no write, no alert. The public cannot make the service do anything.
    if (missing(platform).length > 0) return { ok: false, reason: 'not_configured' };
    const { state, code } = query;
    if (typeof state !== 'string' || !isStateShaped(state)) {
      return { ok: false, reason: 'link_unknown' };
    }
    const use = store.connect.states.consume(hashState(state), platform, now());
    if (use !== 'ok') return { ok: false, reason: `link_${use}` };

    // From here on the state is used up: whatever happens, the owner needs a new link.
    const secrets = [state, code];
    if (query.error !== undefined) {
      const said = /^[A-Za-z0-9_.-]{1,60}$/.test(query.error) ? query.error : 'error';
      return failed(
        platform,
        'denied',
        `the platform sent ${said} instead of a code`,
        secrets,
        log,
      );
    }
    if (typeof code !== 'string' || code === '' || code.length > MAX_CODE_LENGTH) {
      return failed(platform, 'no_code', 'the redirect carried no usable code', secrets, log);
    }

    let result: ExchangeResult;
    try {
      result = await exchange(platform, code);
    } catch (err) {
      return failed(platform, 'platform_unreachable', errorName(err), secrets, log);
    }
    if (!result.ok) return failed(platform, result.code, result.detail, secrets, log);
    secrets.push(result.token);

    const { account } = result;
    const who = `${platform === 'threads' ? '@' : ''}${account.name} (id ${account.id})`;
    if (!expected(platform, account).matches) {
      return failed(
        platform,
        'wrong_account',
        `${who} is not the expected account, nothing was stored`,
        secrets,
        log,
      );
    }

    try {
      store.connect.tokens.put(
        {
          platform,
          tokenEnc: encryptToken(key as Buffer, platform, result.token),
          expiresAt: result.expiresAt,
          accountId: account.id,
          accountName: account.name,
        },
        now(),
      );
    } catch (err) {
      return failed(platform, 'store_failed', errorName(err), secrets, log);
    }
    setLastError(platform, '');
    store.botState.set(unreadableKey(platform), '');
    if (platform === 'linkedin') store.botState.set(REMINDER_KEY, 'none');
    if (platform === 'threads') store.botState.set(REFRESH_ATTEMPT_KEY, '');
    const confirm = expected(platform, account).set
      ? ''
      : ' (no expected account is set: confirm it is the right one)';
    store.alerts.add(
      {
        kind: 'platform_connected',
        message: cut(
          `${platform} connected: ${who}, token expires ${result.expiresAt}${confirm}`,
          secrets,
        ),
      },
      now(),
    );
    log?.info(
      { platform, account: account.name, expiresAt: result.expiresAt },
      'platform connected',
    );
    return { ok: true };
  }

  function overviewOf(platform: ConnectPlatform): PlatformOverview {
    const gaps = missing(platform);
    const row = store.connect.tokens.get(platform);
    const out: PlatformOverview = {
      connected: false,
      configured: gaps.length === 0,
      ...(gaps.length > 0 ? { missing: gaps } : {}),
    };
    let error = lastError(platform);
    if (row) {
      const readable = key !== undefined && decryptToken(key, platform, row.tokenEnc) !== undefined;
      out.connected = readable;
      if (!readable) {
        error =
          'token_unreadable: the stored token cannot be read with the current TOKEN_STORE_KEY; connect again';
      }
      out.account = { id: row.accountId, name: row.accountName };
      out.tokenExpiresAt = row.expiresAt;
      out.connectedAt = row.connectedAt;
      if (row.lastRefreshAt) out.lastRefreshAt = row.lastRefreshAt;
      if (platform === 'linkedin') out.reminder = expiryReminder(now(), row.expiresAt);
    }
    if (error) out.lastError = error;
    return out;
  }

  /**
   * A stored token that cannot be decrypted (the key was changed or lost, the row is damaged)
   * means nothing can be published there, and nothing else would say so. One alert when a
   * platform enters that state, none while it lasts; the note is cleared when the token reads
   * again, on a new connect and on a disconnect, so a later break alerts again.
   */
  function watchUnreadable(log?: ConnectLog): void {
    for (const platform of CONNECT_PLATFORMS) {
      const row = store.connect.tokens.get(platform);
      const unreadable = row !== undefined && readToken(platform) === undefined;
      const noted = store.botState.get(unreadableKey(platform)) === '1';
      if (unreadable === noted) continue;
      store.botState.set(unreadableKey(platform), unreadable ? '1' : '');
      if (!unreadable || !row) continue;
      store.alerts.add(
        {
          kind: 'platform_token_unreadable',
          message:
            `${platform} token cannot be read with the current TOKEN_STORE_KEY ` +
            `(account ${row.accountName}, id ${row.accountId}; it expires ${row.expiresAt}): ` +
            'nothing can be published there until the key is restored or the owner connects ' +
            `again (POST /v1/connect/${platform}/start)`,
        },
        now(),
      );
      log?.warn({ platform }, 'stored token cannot be read');
    }
  }

  let refreshing = false;

  /** D-3 for the refresh: the stored token is replaced only by a refresh that succeeded. */
  async function refreshThreads(log?: ConnectLog): Promise<void> {
    const row = store.connect.tokens.get('threads');
    if (!row || refreshing) return;
    // A token that cannot be read cannot be refreshed: `watchUnreadable` has said so once.
    if (readToken('threads') === undefined) return;
    const at = now().getTime();
    const since = Date.parse(row.lastRefreshAt ?? row.connectedAt);
    if (Number.isFinite(since) && at - since < THREADS_REFRESH_EVERY_MS) return;
    const lastAttempt = Date.parse(store.botState.get(REFRESH_ATTEMPT_KEY) || '');
    if (Number.isFinite(lastAttempt) && at - lastAttempt < THREADS_REFRESH_RETRY_MS) return;
    refreshing = true;
    try {
      store.botState.set(REFRESH_ATTEMPT_KEY, now().toISOString());
      const old = readToken('threads');
      // The adapter's own refresh: it refuses a token younger than 24 h or already expired,
      // and it stores the new token (through the seam above) only when the call succeeded.
      const adapter = createThreadsAdapter({
        tokens: tokenStore('threads'),
        steps: createMemoryStepStore(),
        baseUrl: config.THREADS_API_BASE_URL,
        now,
        ...(o.fetch ? { fetch: o.fetch } : {}),
        ...(o.sleep ? { sleep: o.sleep } : {}),
        ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      });
      const r = await adapter.refreshToken();
      if (r.ok) {
        setLastError('threads', '');
        store.botState.set(REFRESH_ATTEMPT_KEY, '');
        log?.info({ platform: 'threads', expiresAt: r.result.expiresAt }, 'token refreshed');
        return;
      }
      const text = cut(`refresh_failed: ${r.description}`, [
        old,
        readToken('threads'),
        config.TOKEN_STORE_KEY,
      ]);
      setLastError('threads', text);
      store.alerts.add(
        {
          kind: 'platform_refresh_failed',
          message: `threads token refresh failed, the stored token stays (expires ${row.expiresAt}): ${text}`,
        },
        now(),
      );
      log?.warn({ platform: 'threads', reason: text }, 'token refresh failed');
    } finally {
      refreshing = false;
    }
  }

  /** One alert per reminder state (7 days, 1 day, expired): the core sends the owner a link. */
  function linkedinReminder(): void {
    const row = store.connect.tokens.get('linkedin');
    const state: ExpiryReminder = row ? expiryReminder(now(), row.expiresAt) : 'none';
    if ((store.botState.get(REMINDER_KEY) || 'none') === state) return;
    store.botState.set(REMINDER_KEY, state);
    if (!row || state === 'none') return;
    store.alerts.add(
      {
        kind: 'platform_token_expiring',
        message:
          `linkedin token ${state === 'expired' ? 'expired' : 'expires'} ${row.expiresAt} (${state}): ` +
          'send the owner a fresh link from POST /v1/connect/linkedin/start',
      },
      now(),
    );
  }

  return {
    publicBase: () => base,
    redirectUri,
    tokenStore,
    callback,

    start(platform) {
      const gaps = missing(platform);
      if (gaps.length > 0 || !base) return { ok: false, missing: gaps };
      const state = newState();
      const expiresAt = new Date(now().getTime() + STATE_TTL_MS);
      store.connect.states.add(hashState(state), platform, expiresAt, now());
      const redirect = redirectUri(platform) as string;
      // The scopes are constants of ./oauth.ts: nothing of the request reaches this link.
      const url =
        platform === 'threads'
          ? threadsAuthorizeUrl(
              {
                appId: app.threads.id as string,
                appSecret: '',
                apiBaseUrl: config.THREADS_API_BASE_URL,
                authorizeUrl: config.THREADS_AUTHORIZE_URL,
              },
              redirect,
              state,
            )
          : linkedinAuthorizeUrl(
              {
                clientId: app.linkedin.id as string,
                clientSecret: '',
                oauthBaseUrl: config.LINKEDIN_OAUTH_BASE_URL,
                apiBaseUrl: config.LINKEDIN_API_BASE_URL,
              },
              redirect,
              state,
            );
      return { ok: true, url, expiresAt: expiresAt.toISOString() };
    },

    disconnect(platform) {
      const row = store.connect.tokens.get(platform);
      const disconnected = store.connect.tokens.delete(platform);
      // Links handed out before the disconnect must not connect the account again.
      store.connect.states.revoke(platform);
      setLastError(platform, '');
      store.botState.set(unreadableKey(platform), '');
      if (platform === 'linkedin') store.botState.set(REMINDER_KEY, 'none');
      if (platform === 'threads') store.botState.set(REFRESH_ATTEMPT_KEY, '');
      if (disconnected) {
        const who = row ? `${row.accountName} (id ${row.accountId})` : 'unknown account';
        store.alerts.add(
          {
            kind: 'platform_disconnected',
            message: `${platform} disconnected: the stored token and the account record of ${who} were deleted`,
          },
          now(),
        );
      }
      return { disconnected };
    },

    overview: () => ({ threads: overviewOf('threads'), linkedin: overviewOf('linkedin') }),

    async tick(log) {
      store.connect.states.prune(new Date(now().getTime() - 86_400_000));
      watchUnreadable(log);
      linkedinReminder();
      await refreshThreads(log);
    },
  };
}
