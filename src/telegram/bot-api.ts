// Minimal Telegram Bot API client: `POST <base>/bot<token>/<method>` with a JSON body
// (multipart/form-data when a param is a Blob, i.e. a file upload: see `sendPhoto`).
// Every failure is classified by whether the request can have reached Telegram:
//   not_sent      the connection was never established: safe to retry
//   rate_limited  429: not posted; retry after `retry_after`
//   server        5xx: not posted; retry with backoff
//   client        other 4xx: not posted; never retried
//   unknown       the request left and no answer came (reset, timeout, unreadable body):
//                 it may be posted, so it is never retried automatically
// Descriptions never contain the URL (which holds the token).

import { randomBytes } from 'node:crypto';

export const DEFAULT_TIMEOUT_MS = 30_000;

export type CallResult<T> =
  | { ok: true; result: T }
  | { ok: false; kind: 'rate_limited'; status: 429; retryAfterS: number; description: string }
  | { ok: false; kind: 'server' | 'client'; status: number; description: string }
  | { ok: false; kind: 'not_sent' | 'unknown'; description: string };

/** The answer of a file download: the body is a stream the caller reads (or cancels). */
export type DownloadResult =
  | { ok: true; contentLength?: number; body: ReadableStream<Uint8Array> }
  | { ok: false; kind: 'not_sent' | 'unknown' | 'client' | 'server'; status?: number };

export interface BotApi {
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<CallResult<T>>;
  /**
   * GET `<base>/file/bot<token>/<file_path>` for a `file_path` that getFile returned. The URL
   * holds the token: it is never returned or put into a result.
   */
  download?(filePath: string): Promise<DownloadResult>;
}

export interface BotApiOptions {
  token: string;
  /** Default `https://api.telegram.org`. */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Error codes of the connect phase: the request body was never sent. */
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
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

/** A quoted header parameter of a multipart part (WHATWG form-data encoding). */
const quoted = (s: string) => s.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

const CRLF = Buffer.from('\r\n');

/**
 * Multipart body for a call with a file: a Blob is a file part, an object is JSON, the rest text.
 * Written by hand, not with `FormData`: that one turns every line break of a text field into
 * CRLF, and a caption must go out byte for byte as it was rendered, measured and hashed
 * (WP-SVC-24).
 */
async function toMultipart(
  params: Record<string, unknown>,
): Promise<{ body: Uint8Array<ArrayBuffer>; contentType: string }> {
  const parts: { head: string; data: Buffer }[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = `Content-Disposition: form-data; name="${quoted(key)}"`;
    if (value instanceof Blob) {
      const filename =
        key === 'photo' ? `image.${value.type === 'image/png' ? 'png' : 'jpg'}` : key;
      parts.push({
        head: `${name}; filename="${quoted(filename)}"\r\nContent-Type: ${value.type || 'application/octet-stream'}`,
        data: Buffer.from(await value.arrayBuffer()),
      });
    } else {
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      parts.push({ head: name, data: Buffer.from(text, 'utf8') });
    }
  }
  // The boundary must not occur in any part.
  let boundary = '';
  while (!boundary || parts.some((p) => p.data.includes(boundary))) {
    boundary = `----journalist${randomBytes(16).toString('hex')}`;
  }
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${p.head}\r\n\r\n`, 'utf8'), p.data, CRLF);
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    body: new Uint8Array(Buffer.concat(chunks)),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export function createBotApi(o: BotApiOptions): BotApi {
  const base = (o.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async download(filePath) {
      const path = filePath.split('/').map(encodeURIComponent).join('/');
      let res: Response;
      try {
        res = await doFetch(`${base}/file/bot${o.token}/${path}`, {
          method: 'GET',
          // A redirect would carry the token to another address.
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const code = errorCode(err);
        return { ok: false, kind: code && CONNECT_CODES.has(code) ? 'not_sent' : 'unknown' };
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, kind: res.status >= 500 ? 'server' : 'client', status: res.status };
      }
      const length = Number(res.headers.get('content-length'));
      return {
        ok: true,
        body: res.body,
        ...(Number.isSafeInteger(length) && length >= 0 ? { contentLength: length } : {}),
      };
    },

    async call<T>(method: string, params: Record<string, unknown>): Promise<CallResult<T>> {
      let res: Response;
      // Built before anything is sent: a file upload is multipart, everything else JSON.
      const upload = Object.values(params).some((v) => v instanceof Blob);
      const payload = upload
        ? await toMultipart(params)
        : { body: JSON.stringify(params), contentType: 'application/json' };
      try {
        res = await doFetch(`${base}/bot${o.token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': payload.contentType },
          body: payload.body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const code = errorCode(err);
        const name = (err as { name?: string } | null)?.name ?? 'Error';
        const description = `${method}: ${name}${code ? ` ${code}` : ''}`;
        if (code && CONNECT_CODES.has(code)) return { ok: false, kind: 'not_sent', description };
        return { ok: false, kind: 'unknown', description };
      }
      let body: {
        ok?: boolean;
        result?: T;
        description?: string;
        parameters?: { retry_after?: number };
      };
      try {
        body = (await res.json()) as typeof body;
      } catch (err) {
        if (res.status >= 500) {
          return {
            ok: false,
            kind: 'server',
            status: res.status,
            description: `${method}: HTTP ${res.status}`,
          };
        }
        if (res.status >= 400 && res.status !== 429) {
          return {
            ok: false,
            kind: 'client',
            status: res.status,
            description: `${method}: HTTP ${res.status}`,
          };
        }
        const name = (err as { name?: string } | null)?.name ?? 'Error';
        return {
          ok: false,
          kind: 'unknown',
          description: `${method}: unreadable answer (${name})`,
        };
      }
      if (res.ok && body.ok === true) return { ok: true, result: body.result as T };
      const description = String(body.description ?? `HTTP ${res.status}`).slice(0, 500);
      if (res.status === 429) {
        const ra = Number(body.parameters?.retry_after);
        return {
          ok: false,
          kind: 'rate_limited',
          status: 429,
          retryAfterS: Number.isFinite(ra) && ra >= 0 ? ra : 1,
          description,
        };
      }
      if (res.status >= 500) return { ok: false, kind: 'server', status: res.status, description };
      if (res.status >= 400) return { ok: false, kind: 'client', status: res.status, description };
      // 2xx with ok:false: Telegram refused it.
      return { ok: false, kind: 'client', status: res.status, description };
    },
  };
}

export type SendResult<T> =
  | { ok: true; result: T; attempts: number }
  | {
      ok: false;
      /** `failed`: known not posted; `unknown`: may be posted, never resend automatically. */
      outcome: 'failed' | 'unknown';
      status?: number;
      description: string;
      attempts: number;
    };

export interface RetryOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Total attempts (default 5). */
  maxAttempts?: number;
  /** Total time spent waiting between attempts (default 90 s, below the 2 min intent age). */
  maxWaitMs?: number;
  /** First backoff for 5xx and refused connections, doubled each time (default 1 s). */
  baseDelayMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One logical send: retries 429 (after `retry_after`), 5xx and refused connections, all of which
 * mean the message was not posted; stops at the first `client` or `unknown` outcome.
 */
export async function sendWithRetry<T = unknown>(
  api: BotApi,
  method: string,
  params: Record<string, unknown>,
  o: RetryOptions = {},
): Promise<SendResult<T>> {
  const sleep = o.sleep ?? realSleep;
  const maxAttempts = o.maxAttempts ?? 5;
  const maxWaitMs = o.maxWaitMs ?? 90_000;
  let delay = o.baseDelayMs ?? 1000;
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    const r = await api.call<T>(method, params);
    if (r.ok) return { ok: true, result: r.result, attempts: attempt };
    if (r.kind === 'unknown') {
      return { ok: false, outcome: 'unknown', description: r.description, attempts: attempt };
    }
    const status = 'status' in r ? r.status : undefined;
    const fail = (description: string) =>
      ({
        ok: false,
        outcome: 'failed',
        description,
        attempts: attempt,
        ...(status ? { status } : {}),
      }) as const;
    if (r.kind === 'client') return fail(r.description);
    if (attempt >= maxAttempts) return fail(`${r.description} (gave up after ${attempt} attempts)`);
    let wait: number;
    if (r.kind === 'rate_limited') wait = r.retryAfterS * 1000;
    else {
      wait = delay;
      delay *= 2;
    }
    if (waited + wait > maxWaitMs) {
      return fail(`${r.description} (retry wait ${wait} ms exceeds the budget)`);
    }
    waited += wait;
    await sleep(wait);
  }
}

/** Mime types `sendPhoto` is used with by the owner-photo route. */
export type PhotoMime = 'image/png' | 'image/jpeg';

/**
 * Sends one picture as multipart/form-data. The caption is plain text and no parse_mode is set,
 * unless the caller passes `parseMode` (the channel publisher does, for a caption it rendered to
 * MarkdownV2 itself; the owner-photo route never does).
 * Retries like any other send (429, 5xx and refused connections only; an unknown outcome is never
 * resent). The bytes are only in the request body: nothing here logs or keeps them.
 */
export function sendPhoto<T = { message_id: number }>(
  api: BotApi,
  chatId: number | string,
  bytes: Uint8Array,
  mime: PhotoMime,
  caption?: string,
  o: RetryOptions = {},
  parseMode?: 'MarkdownV2',
): Promise<SendResult<T>> {
  return sendWithRetry<T>(
    api,
    'sendPhoto',
    {
      chat_id: chatId,
      photo: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }),
      ...(caption ? { caption } : {}),
      ...(caption && parseMode ? { parse_mode: parseMode } : {}),
    },
    o,
  );
}
