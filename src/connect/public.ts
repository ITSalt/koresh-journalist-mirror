// The public surface of the service (WP-PLAT-06, WP-PLAT-07): the ONLY routes a request from
// outside may reach. Exactly four, under the path prefix of PUBLIC_BASE, without a bearer:
//
//   GET <prefix>/privacy                      static page from public/privacy.html
//   GET <prefix>/data-deletion                static page from public/data-deletion.html
//   GET <prefix>/oauth/threads/callback       the platform sends the owner back here
//   GET <prefix>/oauth/linkedin/callback
//
// They live on a listener of their own (PUBLIC_PORT; `buildPublicServer` in ../server.ts), which
// has nothing else: the director API, /health and /ready are not on that port at all, so a proxy
// in front of it cannot reach them whatever it forwards and whatever headers it sends or strips.
// `registerPublicSurface` is written for that dedicated instance: its guard is the instance's
// first hook and covers every request to the port. A path that is not, character for character,
// one of the four gets the fixed 404, with or without a bearer or a forwarding header.
// Rules of the surface: GET only (HEAD for the two pages); no body; the URL at most 2 KB; on the
// callbacks only the query keys the platforms document; 20 requests a minute per client address;
// fixed HTML answers in Russian that never hold anything taken from the request; no cookie, no
// script.
//
// `rejectForwarded` is the second lock, on the main listener: a request that came through a
// reverse proxy (it carries a forwarding header, which Caddy always sets) is answered 404 there
// on every path, valid bearer or not. The director talks to 127.0.0.1 directly, so a proxy that
// is pointed at the wrong port still exposes nothing of the director API.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  isConnectPlatform,
  type CallbackResult,
  type ConnectFailure,
  type ConnectService,
} from './service.js';

/** `public/` at the repository root; works from both `src/connect` and `dist/connect`. */
export const DEFAULT_PUBLIC_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'public',
);

export const PUBLIC_URL_LIMIT = 2048;
export const PUBLIC_RATE_MAX = 20;
export const PUBLIC_RATE_WINDOW_MS = 60_000;
/**
 * Query keys a callback may carry: `code` and `state`, and on a refusal `error`,
 * `error_description` (both platforms) and `error_reason` (Threads sends it when the owner
 * presses Cancel). Any other key is refused with 400. `error_description` and `error_reason` are
 * accepted and never read.
 */
export const CALLBACK_QUERY_KEYS: readonly string[] = [
  'code',
  'state',
  'error',
  'error_reason',
  'error_description',
];
/** The static pages ignore the query entirely (links to them arrive with tracking keys). */
const PAGES = { '/privacy': 'privacy.html', '/data-deletion': 'data-deletion.html' } as const;

export const DONE_TEXT = 'Готово. Можно закрыть страницу.';
export const failText = (reason: string) => `Не получилось: ${reason}. Напишите директору.`;

/** Reasons this file adds to the service's own (`ConnectFailure`). All are fixed words. */
export type PageReason =
  | ConnectFailure
  | 'not_found'
  | 'bad_request'
  | 'method_not_allowed'
  | 'url_too_long'
  | 'too_many_requests'
  | 'page_unavailable';

const STATUS: Record<PageReason, number> = {
  not_found: 404,
  bad_request: 400,
  method_not_allowed: 405,
  url_too_long: 414,
  too_many_requests: 429,
  page_unavailable: 503,
  not_configured: 503,
  link_unknown: 400,
  link_expired: 400,
  link_used: 400,
  link_wrong_platform: 400,
  denied: 400,
  no_code: 400,
  exchange_failed: 502,
  platform_unreachable: 502,
  account_unreadable: 502,
  wrong_account: 403,
  store_failed: 500,
};

function html(text: string): string {
  return (
    '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="robots" content="noindex">\n<title>Koresh Desk</title>\n</head>\n' +
    `<body>\n<p>${text}</p>\n</body>\n</html>\n`
  );
}

const HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // The callback address holds the code and the state: it must not travel on as a referrer.
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-origin',
};

/** A fixed page with the security headers: the answer to everything that is refused. */
export function sendFixed(reply: FastifyReply, reason: PageReason) {
  return reply
    .headers(HEADERS)
    .code(STATUS[reason])
    .type('text/html; charset=utf-8')
    .send(html(failText(reason)));
}

const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'via',
  'x-real-ip',
];

const pathOf = (req: FastifyRequest): string => {
  const url = req.raw.url ?? '/';
  const i = url.indexOf('?');
  return i < 0 ? url : url.slice(0, i);
};

/** The four public paths, spelled exactly as they are served. */
export function publicPaths(prefix: string): string[] {
  return [
    ...Object.keys(PAGES).map((p) => `${prefix}${p}`),
    `${prefix}/oauth/threads/callback`,
    `${prefix}/oauth/linkedin/callback`,
  ];
}

/**
 * First hook of the MAIN listener: a request that came through a proxy gets the fixed 404 there,
 * on every path and before any routing. Nothing public is served by the main listener (the four
 * public paths are on the public one), so nothing proxied has any business on it. See the head
 * of this file.
 */
export function rejectForwarded() {
  return async function forwardedGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined)) return;
    return sendFixed(reply, 'not_found');
  };
}

/**
 * The address the limit counts by: the last entry of `X-Forwarded-For` (the one the nearest
 * proxy wrote: what a client sends in that header itself sits before it), else the socket's.
 */
export function clientAddress(req: FastifyRequest): string {
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[header.length - 1] : header;
  const last = raw?.split(',').pop()?.trim();
  if (last && last.length <= 64) return last;
  return req.raw.socket.remoteAddress ?? 'unknown';
}

export interface RateOptions {
  max?: number;
  windowMs?: number;
  now?: () => number;
}

/** Fixed window per address; returns the seconds to wait when the address is over the limit. */
export function createRateLimit(o: RateOptions = {}) {
  const max = o.max ?? PUBLIC_RATE_MAX;
  const windowMs = o.windowMs ?? PUBLIC_RATE_WINDOW_MS;
  const now = o.now ?? Date.now;
  const MAX_ADDRESSES = 5000;
  const seen = new Map<string, { start: number; count: number }>();
  return function over(address: string): number | undefined {
    const at = now();
    if (seen.size >= MAX_ADDRESSES) {
      for (const [k, v] of seen) if (at - v.start >= windowMs) seen.delete(k);
    }
    // Still full of live windows: the newcomers share one bucket instead of growing the map.
    const key = seen.has(address) || seen.size < MAX_ADDRESSES ? address : '*';
    let w = seen.get(key);
    if (!w || at - w.start >= windowMs) {
      w = { start: at, count: 0 };
      seen.set(key, w);
    }
    w.count += 1;
    if (w.count <= max) return undefined;
    return Math.max(1, Math.ceil((w.start + windowMs - at) / 1000));
  };
}

/** The callback's query: only the allowed keys, each at most once. `undefined` otherwise. */
export function parseCallbackQuery(rawUrl: string): Record<string, string> | undefined {
  const i = rawUrl.indexOf('?');
  const out: Record<string, string> = {};
  if (i < 0) return out;
  for (const [k, v] of new URLSearchParams(rawUrl.slice(i + 1))) {
    if (!CALLBACK_QUERY_KEYS.includes(k) || k in out) return undefined;
    out[k] = v;
  }
  return out;
}

export interface PublicSurfaceOptions {
  connect: ConnectService;
  /** The path prefix of PUBLIC_BASE, e.g. `/koresh`. */
  prefix: string;
  publicDir?: string;
  rate?: RateOptions;
}

/**
 * Makes `app` the public listener: the guard, the four routes and the fixed 404. For a dedicated
 * instance only (`buildPublicServer`): the guard is added at the root and answers every request
 * that reaches the instance, so on an instance with other routes it would refuse them all.
 */
export function registerPublicSurface(app: FastifyInstance, o: PublicSurfaceOptions): void {
  const dir = o.publicDir ?? DEFAULT_PUBLIC_DIR;
  const over = createRateLimit(o.rate);
  const exact = new Set(publicPaths(o.prefix));
  const pages = new Map<string, string>();
  for (const [route, file] of Object.entries(PAGES)) {
    try {
      pages.set(route, readFileSync(join(dir, file), 'utf8'));
    } catch (err) {
      app.log.error({ err, file }, 'public page not readable');
    }
  }
  const refuse = sendFixed;

  // onRequest: decided before any body is read and before any route is looked at.
  app.addHook('onRequest', async (req, reply) => {
    const wait = over(clientAddress(req));
    if (wait !== undefined) {
      reply.header('retry-after', String(wait));
      return refuse(reply, 'too_many_requests');
    }
    // The raw path, before any decoding: only the four spellings exist on this listener.
    if (!exact.has(pathOf(req))) return refuse(reply, 'not_found');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      reply.header('allow', 'GET');
      return refuse(reply, 'method_not_allowed');
    }
    if ((req.raw.url ?? '').length > PUBLIC_URL_LIMIT) return refuse(reply, 'url_too_long');
    const length = req.headers['content-length'];
    if (
      (length !== undefined && length !== '0') ||
      req.headers['transfer-encoding'] !== undefined
    ) {
      return refuse(reply, 'bad_request');
    }
    reply.headers(HEADERS);
  });

  // Reached by a HEAD on a callback (no such route: a link preview must not use a state up).
  app.setNotFoundHandler((_req, reply) => refuse(reply, 'not_found'));
  // Whatever goes wrong here, the answer is a fixed page: never an error's own message.
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ error: err instanceof Error ? err.name : 'Error' }, 'public route failed');
    return refuse(reply, 'bad_request');
  });

  for (const route of Object.keys(PAGES)) {
    app.get(`${o.prefix}${route}`, async (_req, reply) => {
      const page = pages.get(route);
      if (page === undefined) return refuse(reply, 'page_unavailable');
      // A policy page may be cached and indexed; the callbacks never are.
      return reply
        .header('cache-control', 'public, max-age=300')
        .type('text/html; charset=utf-8')
        .send(page);
    });
  }

  app.get<{ Params: { platform: string } }>(
    `${o.prefix}/oauth/:platform/callback`,
    { exposeHeadRoute: false },
    async (req, reply) => {
      const { platform } = req.params;
      if (!isConnectPlatform(platform)) return refuse(reply, 'not_found');
      const query = parseCallbackQuery(req.raw.url ?? '');
      if (query === undefined) return refuse(reply, 'bad_request');
      let result: CallbackResult;
      try {
        result = await o.connect.callback(
          platform,
          {
            ...(query.code !== undefined ? { code: query.code } : {}),
            ...(query.state !== undefined ? { state: query.state } : {}),
            ...(query.error !== undefined ? { error: query.error } : {}),
          },
          req.log,
        );
      } catch (err) {
        // Only the error's class: a message could hold what the platform echoed.
        const name = (err as { name?: unknown } | null)?.name;
        req.log.error(
          { platform, error: typeof name === 'string' ? name : 'Error' },
          'connect callback failed',
        );
        return refuse(reply, 'store_failed');
      }
      if (!result.ok) return refuse(reply, result.reason);
      return reply.type('text/html; charset=utf-8').send(html(DONE_TEXT));
    },
  );
}

/**
 * The URL as it may appear in a log line. A callback address holds the code and the state, so
 * the query of everything under an `/oauth/` path is dropped whole (whatever its keys are
 * spelled like), and on any other path the values of `code` and `state` are cut out.
 */
export function safeLogUrl(url: string): string {
  const i = url.indexOf('?');
  if (i < 0) return url;
  const path = url.slice(0, i);
  if (/\/oauth\//i.test(path)) return `${path}?[REDACTED]`;
  return path + url.slice(i).replace(/([?&](?:code|state)=)[^&]*/gi, '$1[REDACTED]');
}
