import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CALLBACK_QUERY_KEYS,
  DEFAULT_PUBLIC_DIR,
  failText,
  parseCallbackQuery,
  PUBLIC_RATE_MAX,
  PUBLIC_RATE_WINDOW_MS,
  publicPaths,
  safeLogUrl,
} from '../../src/connect/public.js';
import { parsePublicBase } from '../../src/connect/service.js';
import { buildPublicServer } from '../../src/server.js';
import { BEARER, harness, PREFIX, VIA_PROXY, type Harness } from './helpers.js';

// The public surface (WP-PLAT-06 acceptance 2, WP-PLAT-07 acceptance 1): exactly two static
// pages and two callback paths, on a listener of their own (`h.pub`). Everything else is a 404
// there, with or without forwarding headers and with a valid bearer; the main listener (`h.app`)
// does not have the four paths at all, and answers nothing to a proxied request.

const made: Harness[] = [];
async function setup(o: Parameters<typeof harness>[0] = {}) {
  const h = await harness(o);
  made.push(h);
  return h;
}
afterEach(async () => {
  for (const h of made.splice(0).reverse()) await h.close();
});

const proxied = { ...VIA_PROXY, ...BEARER };
/** As Caddy forwards it with a bearer; with a bearer only; with nothing at all. */
const HEADER_SETS: Record<string, string>[] = [proxied, VIA_PROXY, BEARER, {}];
const FOUR = publicPaths(PREFIX);

/** Paths of the main listener and near misses of the public ones. */
const OTHER_PATHS = [
  '/v1/connect',
  '/v1/plans/2026-10-16',
  '/v1/alerts',
  '/v1/connect/threads/start',
  '/health',
  '/ready',
  '/',
  '/privacy',
  '/oauth/threads/callback',
  `${PREFIX}/v1/connect`,
  `${PREFIX}/v1/plans/2026-10-16`,
  `${PREFIX}/health`,
  `${PREFIX}/ready`,
  `${PREFIX}/`,
  PREFIX,
  `${PREFIX}/privacy/`,
  `${PREFIX}/privacy.html`,
  `${PREFIX}/PRIVACY`,
  '/KORESH/privacy',
  `${PREFIX}/%70rivacy`,
  `${PREFIX}//privacy`,
  `${PREFIX}/oauth/threads`,
  `${PREFIX}/oauth/threads/callback/`,
  `${PREFIX}/oauth/facebook/callback`,
  `${PREFIX}/oauth/thr%65ads/callback`,
];
/** Paths that try to leave the prefix; a test client may resolve them before sending. */
const ESCAPES = [
  `${PREFIX}/oauth/threads/callback/../../../v1/connect`,
  `${PREFIX}/../v1/connect`,
  `${PREFIX}/%2e%2e/v1/connect`,
  `${PREFIX}/%2E%2E/health`,
  `${PREFIX}/..%2fv1/connect`,
  `${PREFIX}/privacy/..%2f..%2fhealth`,
];
/**
 * A spelling that a resolving client turns into a real public path. Sent only on a raw socket:
 * Caddy forwards such a request as it came, and the listener must not serve it.
 */
const RAW_ONLY = [`${PREFIX}/x/../privacy`, `${PREFIX}/./privacy`, `${PREFIX}/privacy;x=1`];

const rawGet = (port: number, path: string, headers: Record<string, string>, method = 'GET') =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    // node:http sends `path` as it is: no dot segment is resolved, nothing is decoded.
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
const listen = async (app: FastifyInstance) => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as AddressInfo).port;
};

describe('the public listener', () => {
  it('serves the two pages and the two callbacks, with or without the proxy headers', async () => {
    const h = await setup();
    for (const headers of [VIA_PROXY, {}]) {
      for (const path of ['/privacy', '/data-deletion']) {
        const res = await h.pub.inject({ method: 'GET', url: `${PREFIX}${path}`, headers });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.headers['www-authenticate']).toBeUndefined();
        expect(res.body).toBe(
          readFileSync(join(DEFAULT_PUBLIC_DIR, `${path.slice(1)}.html`), 'utf8'),
        );
      }
      for (const platform of ['threads', 'linkedin']) {
        const res = await h.pub.inject({
          method: 'GET',
          url: `${PREFIX}/oauth/${platform}/callback`,
          headers,
        });
        // The route exists (a fixed page of its own, not the 404).
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain(failText('link_unknown'));
      }
    }
  });

  it('has the four routes registered and no other: no director route, no health, no ready', async () => {
    const h = await setup();
    await h.pub.ready();
    await h.app.ready();
    expect(FOUR).toEqual([
      '/koresh/privacy',
      '/koresh/data-deletion',
      '/koresh/oauth/threads/callback',
      '/koresh/oauth/linkedin/callback',
    ]);
    // `hasRoute` asks for a route as it was registered (the two callbacks are one pattern).
    for (const url of [
      `${PREFIX}/privacy`,
      `${PREFIX}/data-deletion`,
      `${PREFIX}/oauth/:platform/callback`,
    ]) {
      expect(h.pub.hasRoute({ method: 'GET', url }), url).toBe(true);
      expect(h.app.hasRoute({ method: 'GET', url }), url).toBe(false);
    }
    for (const [method, url] of [
      ['GET', '/health'],
      ['GET', '/ready'],
      ['GET', '/v1/connect'],
      ['POST', '/v1/connect/:platform/start'],
      ['DELETE', '/v1/connect/:platform'],
      ['GET', '/v1/plans/:date'],
      ['POST', '/v1/plans/:date'],
      ['POST', '/v1/feed'],
      ['GET', '/v1/alerts'],
      ['POST', '/v1/owner/drafts'],
      ['GET', '/v1/inbox'],
      ['POST', '/v1/images'],
      ['POST', '/v1/test-publish'],
    ] as const) {
      // Each of them is a route of the main listener, and of the main listener only.
      expect(h.app.hasRoute({ method, url }), `${method} ${url} on main`).toBe(true);
      expect(h.pub.hasRoute({ method, url }), `${method} ${url} on public`).toBe(false);
    }
    // Everything the public instance has, by its own listing: the four paths and nothing else.
    const listing = h.pub.printRoutes({ commonPrefix: false });
    expect(listing).not.toMatch(/v1|health|ready/);
    const lines = listing.split('\n').filter((l) => l.trim() !== '');
    expect(lines.filter((l) => /\((GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)/.test(l))).toHaveLength(
      3,
    );
  });

  it.each([...OTHER_PATHS, ...ESCAPES])(
    '%s is the fixed 404: any method, with or without forwarding headers, valid bearer or not',
    async (path) => {
      const h = await setup();
      for (const method of ['GET', 'POST', 'DELETE', 'HEAD'] as const) {
        for (const headers of HEADER_SETS) {
          const res = await h.pub.inject({ method, url: path, headers });
          expect(res.statusCode, method).toBe(404);
          expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
          if (method !== 'HEAD') expect(res.body).toContain(failText('not_found'));
          expect(res.headers['www-authenticate']).toBeUndefined();
        }
      }
      expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get()).toEqual({ n: 0 });
      expect(h.store.alerts.list()).toEqual([]);
    },
  );

  it('on a real socket: raw, unresolved paths, every header set, nothing but the four', async () => {
    const h = await setup();
    const port = await listen(h.pub);
    for (const path of [...OTHER_PATHS, ...ESCAPES, ...RAW_ONLY]) {
      for (const headers of HEADER_SETS) {
        for (const method of ['GET', 'POST', 'DELETE']) {
          const res = await rawGet(port, path, headers, method);
          const where = `${method} ${path} ${JSON.stringify(Object.keys(headers))}`;
          expect(res.status, where).toBe(404);
          expect(res.body, where).toContain(failText('not_found'));
          expect(res.body, where).not.toMatch(/"connected"|"status"|"alerts"|"version"/);
        }
      }
    }
    for (const path of FOUR) {
      const res = await rawGet(port, path, {});
      expect([200, 400], path).toContain(res.status);
    }
    expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get()).toEqual({ n: 0 });
  });

  it('a start, a disconnect or a read of the director API sent to the public port does nothing', async () => {
    const h = await setup();
    const { state } = await h.start('threads');
    expect((await h.callback('threads', { code: h.threads.issueCode(), state })).statusCode).toBe(
      200,
    );
    for (const [method, url] of [
      ['DELETE', '/v1/connect/threads'],
      ['POST', '/v1/connect/threads/start'],
      ['GET', '/v1/connect'],
      ['POST', `/v1/plans/2026-10-16/reject`],
    ] as const) {
      for (const headers of HEADER_SETS) {
        expect((await h.pub.inject({ method, url, headers })).statusCode).toBe(404);
      }
    }
    expect(h.store.connect.tokens.get('threads')).toBeDefined();
    expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get()).toEqual({ n: 1 });
  });
});

describe('the main listener', () => {
  it('does not have the four public paths: 404, direct or proxied, and a callback there does nothing', async () => {
    const h = await setup();
    await h.app.ready();
    const { state } = await h.start('threads');
    const code = h.threads.issueCode();
    for (const path of FOUR) {
      expect(h.app.hasRoute({ method: 'GET', url: path }), path).toBe(false);
      for (const headers of HEADER_SETS) {
        const res = await h.app.inject({
          method: 'GET',
          url: `${path}?code=${code}&state=${state}`,
          headers,
        });
        expect(res.statusCode, path).toBe(404);
        expect(res.body).not.toContain('Koresh Desk: ');
        expect(res.body).not.toContain('Готово');
      }
    }
    expect(h.app.hasRoute({ method: 'GET', url: `${PREFIX}/oauth/:platform/callback` })).toBe(
      false,
    );
    // Nothing was exchanged and the state is still good on the public listener.
    expect(h.threads.requests).toHaveLength(0);
    expect((await h.callback('threads', { code, state })).statusCode).toBe(200);
  });

  it('on a real socket the four public paths are 404 too', async () => {
    const h = await setup();
    const port = await listen(h.app);
    for (const path of FOUR) {
      for (const headers of HEADER_SETS) {
        expect((await rawGet(port, path, headers)).status, path).toBe(404);
      }
    }
    // And it still serves the director directly.
    const direct = await rawGet(port, '/v1/connect', BEARER);
    expect(direct.status).toBe(200);
    expect(direct.body).toContain('"connected"');
  });

  it('answers nothing to a proxied request (the second lock): 404 on every path, bearer or not', async () => {
    const h = await setup();
    for (const [method, url] of [
      ['GET', '/v1/connect'],
      ['POST', '/v1/connect/threads/start'],
      ['DELETE', '/v1/connect/threads'],
      ['GET', '/v1/plans/2026-10-16'],
      ['GET', '/v1/alerts'],
      ['GET', '/health'],
      ['GET', '/ready'],
      ['GET', '/'],
      ...FOUR.map((p) => ['GET', p] as const),
    ] as const) {
      for (const headers of [
        proxied,
        { ...BEARER, 'x-forwarded-host': 'public.example.org' },
        { ...BEARER, 'x-forwarded-proto': 'https' },
        { ...BEARER, forwarded: 'for=203.0.113.9' },
        { ...BEARER, via: '1.1 Caddy' },
        { ...BEARER, 'x-real-ip': '203.0.113.9' },
      ]) {
        const res = await h.app.inject({ method, url, headers });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.body).toContain(failText('not_found'));
        expect(res.body).not.toContain('"connected"');
      }
    }
    // Nothing happened behind the 404: no state was made, nothing was deleted.
    expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get()).toEqual({ n: 0 });
    // The director, on 127.0.0.1 without a proxy, is served as before.
    const direct = await h.app.inject({ method: 'GET', url: '/v1/connect', headers: BEARER });
    expect(direct.statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
  });

  it('a proxied DELETE changes nothing', async () => {
    const h = await setup();
    const { state } = await h.start('threads');
    expect((await h.callback('threads', { code: h.threads.issueCode(), state })).statusCode).toBe(
      200,
    );
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/v1/connect/threads',
      headers: proxied,
    });
    expect(res.statusCode).toBe(404);
    expect(h.store.connect.tokens.get('threads')).toBeDefined();
  });
});

describe('without a usable PUBLIC_BASE', () => {
  it.each([[''], ['http://x.example/koresh'], ['https://x.example'], ['https://x.example/v1']])(
    'PUBLIC_BASE=%j: there is no public listener, and the main one works as before',
    async (value) => {
      const h = await setup({ env: { PUBLIC_BASE: value } });
      expect(h.publicApp).toBeUndefined();
      expect(
        buildPublicServer({ config: h.config, connect: h.connect, logLevel: 'silent' }),
      ).toBeUndefined();
      for (const url of [...FOUR, '/privacy']) {
        expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(404);
      }
      expect((await h.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await h.app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
      const start = await h.app.inject({
        method: 'POST',
        url: '/v1/connect/threads/start',
        headers: BEARER,
      });
      expect(start.statusCode).toBe(409);
    },
  );
});

describe('what the public listener refuses', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)('%s', async (method) => {
    const h = await setup();
    const { state } = await h.start('threads');
    for (const url of [
      `${PREFIX}/privacy`,
      `${PREFIX}/oauth/threads/callback?code=${h.threads.issueCode()}&state=${state}`,
    ]) {
      const res = await h.pub.inject({ method, url, headers: VIA_PROXY });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('GET');
      expect(res.body).toContain(failText('method_not_allowed'));
    }
    expect(h.threads.requests).toHaveLength(0);
    // The state was not touched by the refused requests.
    const ok = await h.callback('threads', { code: h.threads.issueCode(), state });
    expect(ok.statusCode).toBe(200);
  });

  it('HEAD on a callback (a link preview) does not use the state up', async () => {
    const h = await setup();
    const { state } = await h.start('threads');
    const code = h.threads.issueCode();
    const head = await h.pub.inject({
      method: 'HEAD',
      url: `${PREFIX}/oauth/threads/callback?code=${code}&state=${state}`,
      headers: VIA_PROXY,
    });
    expect(head.statusCode).toBe(404);
    expect(h.threads.requests).toHaveLength(0);
    expect((await h.callback('threads', { code, state })).statusCode).toBe(200);
    // The pages answer a HEAD.
    const page = await h.pub.inject({ method: 'HEAD', url: `${PREFIX}/privacy` });
    expect(page.statusCode).toBe(200);
  });

  it('a body', async () => {
    const h = await setup();
    const { state } = await h.start('threads');
    const url = `${PREFIX}/oauth/threads/callback?code=${h.threads.issueCode()}&state=${state}`;
    for (const extra of [
      {
        payload: 'x=1',
        headers: { ...VIA_PROXY, 'content-type': 'application/x-www-form-urlencoded' },
      },
      { payload: { code: 'x' }, headers: VIA_PROXY },
      { headers: { ...VIA_PROXY, 'transfer-encoding': 'chunked' } },
    ]) {
      const res = await h.pub.inject({ method: 'GET', url, ...extra });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(failText('bad_request'));
    }
    expect(h.threads.requests).toHaveLength(0);
  });

  it('extra query keys on a callback (scope, redirect_uri, anything)', async () => {
    const h = await setup();
    const { state } = await h.start('threads');
    const code = h.threads.issueCode();
    const extras: Record<string, string>[] = [
      { scope: 'threads_manage_replies' },
      { redirect_uri: 'https://evil.example/' },
      { access_token: 'x' },
      { x: '' },
    ];
    for (const extra of extras) {
      const res = await h.callback('threads', { code, state, ...extra });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(failText('bad_request'));
    }
    // A key given twice is refused too.
    const twice = await h.pub.inject({
      method: 'GET',
      url: `${PREFIX}/oauth/threads/callback?code=${code}&state=${state}&state=${state}`,
      headers: VIA_PROXY,
    });
    expect(twice.statusCode).toBe(400);
    expect(h.threads.requests).toHaveLength(0);
    // None of the refused requests used the state up.
    expect((await h.callback('threads', { code, state })).statusCode).toBe(200);
    expect(CALLBACK_QUERY_KEYS).toEqual([
      'code',
      'state',
      'error',
      'error_reason',
      'error_description',
    ]);
    expect(parseCallbackQuery('/x?code=a&state=b')).toEqual({ code: 'a', state: 'b' });
    expect(parseCallbackQuery('/x?c%6Fde=a&sc%6Fpe=b')).toBeUndefined();
  });

  it('a URL over 2 KB', async () => {
    const h = await setup();
    const { state } = await h.start('threads');
    const res = await h.callback('threads', { code: 'c'.repeat(2100), state });
    expect(res.statusCode).toBe(414);
    expect(res.body).toContain(failText('url_too_long'));
    const page = await h.pub.inject({
      method: 'GET',
      url: `${PREFIX}/privacy?${'a'.repeat(2100)}`,
      headers: VIA_PROXY,
    });
    expect(page.statusCode).toBe(414);
    expect(h.threads.requests).toHaveLength(0);
    // 2048 characters is still served.
    const base = `${PREFIX}/privacy?`;
    const fits = await h.pub.inject({
      method: 'GET',
      url: base + 'a'.repeat(2048 - base.length),
      headers: VIA_PROXY,
    });
    expect(fits.statusCode).toBe(200);
  });

  it('more than 20 requests a minute from one address, per address, whatever the path', async () => {
    let at = 1_000_000;
    const h = await setup({ rate: { now: () => at } });
    expect(PUBLIC_RATE_MAX).toBe(20);
    expect(PUBLIC_RATE_WINDOW_MS).toBe(60_000);
    const get = (ip: string, url = `${PREFIX}/privacy`) =>
      h.pub.inject({ method: 'GET', url, headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 10; i++) expect((await get('198.51.100.7')).statusCode).toBe(200);
    // Requests for paths that do not exist count as well: the limit is the listener's.
    for (let i = 0; i < 10; i++) {
      expect((await get('198.51.100.7', '/v1/connect')).statusCode).toBe(404);
    }
    const limited = await get('198.51.100.7');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.body).toContain(failText('too_many_requests'));
    expect((await get('198.51.100.7', `${PREFIX}/oauth/threads/callback`)).statusCode).toBe(429);
    expect((await get('198.51.100.7', '/nothing')).statusCode).toBe(429);
    // Another address is not affected; a client cannot pick its address by sending the header
    // itself, because the proxy appends the real one after it.
    expect((await get('198.51.100.8')).statusCode).toBe(200);
    expect((await get('10.0.0.1, 198.51.100.7')).statusCode).toBe(429);
    at += 60_000;
    expect((await get('198.51.100.7')).statusCode).toBe(200);
  });

  it('without a forwarding header the limit counts by the socket address', async () => {
    const h = await setup({ rate: { max: 3 } });
    const port = await listen(h.pub);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await rawGet(port, `${PREFIX}/privacy`, {})).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  it('a limited callback does not use the state up and calls nobody', async () => {
    const h = await setup({ rate: { max: 1 } });
    const { state } = await h.start('threads');
    await h.pub.inject({ method: 'GET', url: `${PREFIX}/privacy`, headers: VIA_PROXY });
    const res = await h.callback('threads', { code: h.threads.issueCode(), state });
    expect(res.statusCode).toBe(429);
    expect(h.threads.requests).toHaveLength(0);
    expect(
      h.store.db.prepare('SELECT COUNT(*) AS n FROM oauth_states WHERE used_at IS NULL').get(),
    ).toEqual({ n: 1 });
  });
});

describe('every public answer', () => {
  it('carries the security headers and never a cookie', async () => {
    const h = await setup();
    const { state } = await h.start('threads');
    const answers = [
      await h.pub.inject({ method: 'GET', url: `${PREFIX}/privacy`, headers: VIA_PROXY }),
      await h.pub.inject({ method: 'GET', url: `${PREFIX}/nothing`, headers: VIA_PROXY }),
      await h.pub.inject({ method: 'POST', url: `${PREFIX}/privacy`, headers: VIA_PROXY }),
      await h.pub.inject({
        method: 'GET',
        url: `${PREFIX}/oauth/threads/callback?code=${h.threads.issueCode()}&state=${state}`,
        headers: { ...VIA_PROXY, cookie: 'sid=1' },
      }),
      await h.pub.inject({
        method: 'GET',
        url: `${PREFIX}/oauth/linkedin/callback`,
        headers: VIA_PROXY,
      }),
      await h.pub.inject({ method: 'GET', url: '/v1/connect', headers: BEARER }),
      await h.pub.inject({ method: 'GET', url: `${PREFIX}/%zz`, headers: {} }),
    ];
    expect(answers.map((a) => a.statusCode)).toEqual([200, 404, 405, 200, 400, 404, 400]);
    for (const a of answers) {
      expect(a.headers['set-cookie']).toBeUndefined();
      expect(a.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(a.headers['content-security-policy']).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      expect(a.headers['x-content-type-options']).toBe('nosniff');
      expect(a.headers['x-frame-options']).toBe('DENY');
      expect(a.headers['referrer-policy']).toBe('no-referrer');
      expect(a.body).not.toMatch(/<script|<form|<img|<link|<iframe|https?:\/\//i);
    }
    // The callbacks and the refusals are never cached.
    for (const a of answers.slice(1)) expect(a.headers['cache-control']).toBe('no-store');
  });

  it('is fixed text: nothing of the request comes back', async () => {
    const h = await setup();
    const marker = 'ECHO-MARKER-7391';
    const res = [
      await h.callback('threads', { code: marker, state: marker }),
      await h.callback('threads', {
        error: marker,
        error_description: `<b>${marker}</b>`,
        state: marker,
      }),
      await h.pub.inject({ method: 'GET', url: `${PREFIX}/${marker}`, headers: VIA_PROXY }),
      await h.pub.inject({
        method: 'GET',
        url: `${PREFIX}/privacy?${marker}=1`,
        headers: VIA_PROXY,
      }),
      await h.pub.inject({
        method: 'GET',
        url: `${PREFIX}/oauth/${marker}/callback`,
        headers: VIA_PROXY,
      }),
      await h.pub.inject({ method: 'GET', url: `/${marker}?x=${marker}`, headers: {} }),
    ];
    for (const r of res) {
      expect(r.body).not.toContain(marker);
      expect(JSON.stringify(r.headers)).not.toContain(marker);
    }
  });
});

describe('a path the router cannot read', () => {
  it('gets a fixed answer on both listeners: the path and the query are not repeated', async () => {
    const h = await setup();
    const marker = 'UNREADABLE-MARKER-5512';
    for (const app of [h.app, h.pub]) {
      for (const url of [
        `${PREFIX}/%zz${marker}?code=${marker}&state=${marker}`,
        `${PREFIX}/oauth/${marker}${'x'.repeat(200)}/callback?code=${marker}&state=${marker}`,
        `/v1/%zz${marker}?code=${marker}`,
      ]) {
        for (const headers of [VIA_PROXY, BEARER]) {
          const res = await app.inject({ method: 'GET', url, headers });
          expect([400, 404]).toContain(res.statusCode);
          expect(res.body).not.toContain(marker);
          expect(res.body).not.toContain('"connected"');
        }
      }
    }
    expect(h.logs()).not.toContain(`code=${marker}`);
    expect(h.logs()).not.toContain(`state=${marker}`);
  });
});

describe('a 404 with a code and a state in its query (review item L2)', () => {
  it('leaves no query value in the log, on the main listener and on the public one', async () => {
    const h = await setup();
    const code = 'L2-CODE-MARKER-40417';
    const state = 'L2-STATE-MARKER-40418';
    const urls = [
      `/nothing?code=${code}&state=${state}`,
      `/v1/nothing?state=${state}&code=${code}`,
      `/oauth/threads/callback?code=${code}&state=${state}`,
      `${PREFIX}/oauth/threads/callback/?code=${code}&state=${state}`,
      `${PREFIX}/privacy/x?code=${code}&state=${state}`,
      // On the main listener the public paths themselves are a 404.
      `${PREFIX}/oauth/threads/callback?code=${code}&state=${state}`,
      `${PREFIX}/privacy?code=${code}&state=${state}`,
    ];
    let notFound = 0;
    for (const [name, app] of [
      ['main', h.app],
      ['public', h.pub],
    ] as const) {
      for (const url of urls) {
        // Without a forwarding header: on the main listener this is the root 404 handler.
        const res = await app.inject({ method: 'GET', url, headers: BEARER });
        if (res.statusCode === 404) notFound += 1;
        else expect(name, url).toBe('public');
        expect(res.body).not.toContain(code);
        expect(res.body).not.toContain(state);
      }
    }
    // Every URL was a 404 on the main listener, and all but the two real routes on the public.
    expect(notFound).toBe(urls.length * 2 - 2);
    // The public listener's own 404 handler: a HEAD on a callback (there is no such route).
    const head = await h.pub.inject({
      method: 'HEAD',
      url: `${PREFIX}/oauth/linkedin/callback?code=${code}&state=${state}`,
    });
    expect(head.statusCode).toBe(404);
    const log = h.logs();
    // Both listeners did log these requests.
    expect(log.split('\n').filter((l) => l.includes('"/nothing?')).length).toBe(2);
    expect(log).toContain('/nothing?code=[REDACTED]&state=[REDACTED]');
    expect(log).toContain('"listener":"public"');
    expect(log).not.toContain(code);
    expect(log).not.toContain(state);
  });
});

describe('what the public listener logs (the policy: no data of other people)', () => {
  const IP = '198.51.100.73';
  const AGENT = 'Mozilla/5.0 (X11; Linux x86_64) VisitorAgent-Marker-5821';
  const visitor = { 'x-forwarded-for': IP, 'user-agent': AGENT, 'accept-language': 'ru-RU' };
  const reqOf = (l: Record<string, unknown>) => l.req as { method: string; url: string };
  const publicLines = (h: Harness) =>
    h
      .logs()
      .split('\n')
      .filter((l) => l.includes('"listener":"public"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it('one line per request with method, path and status; no address, no agent, no header', async () => {
    const h = await setup();
    const { state } = await h.start('threads');
    const code = h.threads.issueCode();
    const requests: [string, string, number][] = [
      ['GET', `${PREFIX}/privacy`, 200],
      ['GET', `${PREFIX}/data-deletion`, 200],
      ['GET', `${PREFIX}/oauth/threads/callback?code=${code}&state=${state}`, 200],
      ['GET', `${PREFIX}/oauth/linkedin/callback?error=access_denied`, 400],
      ['POST', `${PREFIX}/privacy`, 405],
      ['GET', '/v1/connect', 404],
    ];
    for (const [method, url, status] of requests) {
      const res = await h.pub.inject({ method: method as 'GET', url, headers: visitor });
      expect(res.statusCode, url).toBe(status);
    }
    // Every line of the public listener is checked, whatever wrote it.
    const log = h.logs();
    expect(log).not.toContain(IP);
    expect(log).not.toContain('VisitorAgent-Marker-5821');
    expect(log).not.toContain('ru-RU');
    const lines = publicLines(h);
    const requestLines = lines.filter((l) => l.msg === 'public request');
    expect(requestLines.map((l) => [reqOf(l).method, reqOf(l).url, l.status])).toEqual([
      ['GET', `${PREFIX}/privacy`, 200],
      ['GET', `${PREFIX}/data-deletion`, 200],
      ['GET', `${PREFIX}/oauth/threads/callback?[REDACTED]`, 200],
      ['GET', `${PREFIX}/oauth/linkedin/callback?[REDACTED]`, 400],
      ['POST', `${PREFIX}/privacy`, 405],
      ['GET', '/v1/connect', 404],
    ]);
    for (const l of lines) {
      // Nothing about the client in any line of this listener, whatever wrote it.
      for (const key of ['res', 'headers', 'remoteAddress', 'remotePort', 'ip', 'host']) {
        expect(l, JSON.stringify(l)).not.toHaveProperty(key);
      }
      if ('req' in l) expect(Object.keys(reqOf(l)).sort()).toEqual(['method', 'url']);
      expect(JSON.stringify(l)).not.toMatch(/user-agent|x-forwarded|127\.0\.0\.1/i);
    }
    for (const l of requestLines) {
      expect(Object.keys(l).sort()).toEqual([
        'hostname',
        'level',
        'listener',
        'msg',
        'pid',
        'req',
        'reqId',
        'status',
        'time',
      ]);
    }
    // The code and the state never appear either.
    expect(log).not.toContain(code);
    expect(log).not.toContain(state);
  });

  it('a refused request (rate limit, unreadable URL) leaves no visitor data either', async () => {
    const h = await setup({ rate: { max: 1 } });
    await h.pub.inject({ method: 'GET', url: `${PREFIX}/privacy`, headers: visitor });
    const limited = await h.pub.inject({
      method: 'GET',
      url: `${PREFIX}/privacy`,
      headers: visitor,
    });
    expect(limited.statusCode).toBe(429);
    const bad = await h.pub.inject({ method: 'GET', url: `${PREFIX}/%zz`, headers: visitor });
    expect(bad.statusCode).toBe(400);
    expect(h.logs()).not.toContain(IP);
    expect(h.logs()).not.toContain('VisitorAgent-Marker-5821');
    const statuses = publicLines(h)
      .filter((l) => l.msg === 'public request')
      .map((l) => l.status);
    expect(statuses.slice(0, 2)).toEqual([200, 429]);
  });

  it('on a real socket the address of the connection is not logged either', async () => {
    const h = await setup();
    await h.pub.listen({ port: 0, host: '127.0.0.1' });
    const { port } = h.pub.server.address() as AddressInfo;
    for (const path of FOUR) {
      const res = await rawGet(port, path, { 'x-forwarded-for': IP, 'user-agent': AGENT });
      expect([200, 400]).toContain(res.status);
    }
    const lines = publicLines(h).filter((l) => l.msg === 'public request');
    expect(lines.map((l) => reqOf(l).url)).toEqual(FOUR);
    for (const l of lines) expect(JSON.stringify(l)).not.toMatch(/127\.0\.0\.1|198\.51|Marker/);
  });

  it('the main listener logs as before (headers and address, for the director)', async () => {
    const h = await setup();
    await h.app.inject({ method: 'GET', url: '/health', headers: { 'user-agent': AGENT } });
    const main = h
      .logs()
      .split('\n')
      .filter((l) => l.includes('"url":"/health"'));
    expect(main.length).toBeGreaterThan(0);
    expect(main[0]).toContain('VisitorAgent-Marker-5821');
    expect(main[0]).toContain('"remoteAddress"');
  });
});

describe('the two policy pages', () => {
  it.each(['privacy.html', 'data-deletion.html'])(
    '%s has no script, no form and no external resource',
    (file) => {
      const page = readFileSync(join(DEFAULT_PUBLIC_DIR, file), 'utf8');
      expect(page).toMatch(/^<!doctype html>/i);
      expect(page).toMatch(/<meta charset="utf-8"/i);
      // No script in any form.
      expect(page).not.toMatch(/<script|javascript:|\son[a-z]+\s*=/i);
      // Nothing that sends data anywhere.
      expect(page).not.toMatch(/<form|<input|<button|<textarea|<select/i);
      // Nothing loaded from anywhere: no tag with a source, no stylesheet import, no frame.
      expect(page).not.toMatch(
        /<img|<link|<iframe|<frame|<object|<embed|<video|<audio|<source|<svg|<base|<meta[^>]+http-equiv/i,
      );
      expect(page).not.toMatch(/\ssrc\s*=|\ssrcset\s*=|url\s*\(|@import/i);
      // A link may only be a mail or an https address the reader clicks; nothing is fetched.
      for (const m of page.matchAll(/\shref\s*=\s*["']?([^"'\s>]+)/gi)) {
        expect(m[1]).toMatch(/^(mailto:|https:\/\/)/);
      }
    },
  );

  it('a missing page file is a fixed 503, not a crash', async () => {
    const h = await setup();
    const pub = buildPublicServer({
      config: h.config,
      connect: h.connect,
      logLevel: 'silent',
      publicDir: join(DEFAULT_PUBLIC_DIR, 'nowhere'),
    })!;
    const res = await pub.inject({ method: 'GET', url: `${PREFIX}/privacy`, headers: VIA_PROXY });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain(failText('page_unavailable'));
    await pub.close();
  });
});

describe('PUBLIC_BASE', () => {
  it('is https with a path prefix, nothing else', () => {
    expect(parsePublicBase('https://public.example.org/koresh')).toEqual({
      base: 'https://public.example.org/koresh',
      prefix: '/koresh',
    });
    expect(parsePublicBase('https://public.example.org/koresh/')?.prefix).toBe('/koresh');
    expect(parsePublicBase('https://a.example/x/y-z_1')?.prefix).toBe('/x/y-z_1');
    for (const bad of [
      undefined,
      '',
      'http://a.example/koresh',
      'https://a.example',
      'https://a.example/',
      'https://user:pw@a.example/koresh',
      'https://a.example/koresh?x=1',
      'https://a.example/koresh#x',
      'https://a.example/ko%20resh',
      'https://a.example/v1',
      'https://a.example/v1/public',
      'https://a.example/health',
      'https://a.example/ready/',
      'https://a.example/ko resh',
      'koresh',
    ]) {
      expect(parsePublicBase(bad), String(bad)).toBeUndefined();
    }
  });
});

describe('safeLogUrl', () => {
  it('drops the whole query of a callback and the code and state anywhere else', () => {
    expect(safeLogUrl('/koresh/oauth/threads/callback?code=AAA&state=BBB')).toBe(
      '/koresh/oauth/threads/callback?[REDACTED]',
    );
    expect(safeLogUrl('/koresh/oauth/x/callback?c%6Fde=AAA')).toBe(
      '/koresh/oauth/x/callback?[REDACTED]',
    );
    expect(safeLogUrl('/koresh/privacy?code=AAA&x=1&state=BBB')).toBe(
      '/koresh/privacy?code=[REDACTED]&x=1&state=[REDACTED]',
    );
    expect(safeLogUrl('/v1/publications?date=2026-10-16')).toBe('/v1/publications?date=2026-10-16');
    expect(safeLogUrl('/health')).toBe('/health');
  });
});
