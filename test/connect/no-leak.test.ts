import { afterEach, describe, expect, it } from 'vitest';
import { THREADS_REFRESH_EVERY_MS } from '../../src/connect/service.js';
import {
  API_TOKEN,
  BEARER,
  connectNow,
  harness,
  PREFIX,
  STORE_KEY,
  VIA_PROXY,
  type Harness,
} from './helpers.js';

// WP-PLAT-06 acceptance 3: no token, code, state, app secret or TOKEN_STORE_KEY in any response,
// log line, alert or error. One long scenario walks every path of the connect (successes,
// refusals, platform errors that echo the request, a failed refresh) and then every byte the
// service produced is searched for every secret that existed. The test fails if one is found.
//
// The single exception is by contract: the answer of POST /v1/connect/<platform>/start holds the
// state, because the state is part of the link the director sends to the owner. That answer is
// checked for everything else.

const made: Harness[] = [];
afterEach(async () => {
  for (const h of made.splice(0).reverse()) await h.close();
});

describe('nothing secret leaves the service', () => {
  it('not in a response, a log line, an alert, a status or an error', async () => {
    const h = await harness();
    made.push(h);
    /** Everything the service said to anyone. */
    const said: string[] = [];
    /** The answers of `start`: they may hold their own state, nothing else. */
    const startAnswers: string[] = [];
    const states: string[] = [];
    const codes: string[] = [];
    const record = (r: { body: string; headers: Record<string, unknown> }) =>
      void said.push(r.body, JSON.stringify(r.headers));

    const start = async (platform: 'threads' | 'linkedin') => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/connect/${platform}/start`,
        headers: BEARER,
      });
      startAnswers.push(res.body);
      const state = new URL(res.json().url).searchParams.get('state')!;
      states.push(state);
      return state;
    };
    const code = (platform: 'threads' | 'linkedin') => {
      const c = h[platform].issueCode();
      codes.push(c);
      return c;
    };
    const cb = async (platform: 'threads' | 'linkedin', query: Record<string, string>) => {
      const res = await h.callback(platform, query);
      record(res);
      return res;
    };

    for (const platform of ['threads', 'linkedin'] as const) {
      const first = platform === 'threads' ? 'code' : 'token';
      // The platform refuses and its error body repeats the code and the app secret.
      h[platform].queue(first, { echo: 400 });
      expect(
        (await cb(platform, { code: code(platform), state: await start(platform) })).statusCode,
      ).toBe(502);
      // A 5xx whose body repeats them too.
      h[platform].queue(first, { echo: 500 });
      await cb(platform, { code: code(platform), state: await start(platform) });
      // A timeout.
      h[platform].queue(first, { hang: true });
      await cb(platform, { code: code(platform), state: await start(platform) });
      // The account read fails after a token was issued, with an echoing body.
      h[platform].queue(platform === 'threads' ? 'me' : 'userinfo', { echo: 400 });
      await cb(platform, { code: code(platform), state: await start(platform) });
      // The owner cancels; the platform's own text comes along.
      const cancelled = await start(platform);
      await cb(platform, {
        error: 'access_denied',
        error_description: cancelled,
        state: cancelled,
      });
      // A used state, an unknown state, a state at the wrong callback, extra keys.
      const used = states[0]!;
      await cb(platform, { code: code(platform), state: used });
      await cb(platform, {
        code: code(platform),
        state: Buffer.alloc(32, 3).toString('base64url'),
      });
      await cb(platform === 'threads' ? 'linkedin' : 'threads', {
        code: code(platform),
        state: await start(platform),
      });
      await cb(platform, { code: code(platform), state: await start(platform), scope: 'x' });
      // And a success.
      expect(
        (await cb(platform, { code: code(platform), state: await start(platform) })).statusCode,
      ).toBe(200);
    }
    const tokens = [h.threads.token, h.linkedin.token];
    expect(tokens.every((t) => t.length > 10)).toBe(true);

    // A Threads refresh that the platform answers with an echoing error, then one that works.
    h.advance(THREADS_REFRESH_EVERY_MS + 1000);
    h.threads.queue('refresh', { echo: 400 });
    await h.connect.tick(h.app.log);
    h.advance(2 * 86_400_000);
    await h.connect.tick(h.app.log);
    tokens.push(h.threads.token);
    expect(h.threads.token).toMatch(/^FAKE-THREADS-REFRESHED-TOKEN-/);

    // A wrong account on a second service over the same database.
    const strict = await harness({
      env: { THREADS_EXPECTED_USERNAME: 'somebody_else' },
      from: { dbFile: h.dbFile, threads: h.threads, linkedin: h.linkedin, at: h.now() },
    });
    made.push(strict);
    const strictStart = await strict.app.inject({
      method: 'POST',
      url: '/v1/connect/threads/start',
      headers: BEARER,
    });
    startAnswers.push(strictStart.body);
    const strictState = new URL(strictStart.json().url).searchParams.get('state')!;
    states.push(strictState);
    const strictCode = strict.threads.issueCode();
    codes.push(strictCode);
    const refused = await strict.callback('threads', { code: strictCode, state: strictState });
    expect(refused.statusCode).toBe(403);
    record(refused);
    tokens.push(strict.threads.token);

    // What the director can read, and a proxied request that is turned away.
    for (const app of [h.app, strict.app]) {
      for (const url of ['/v1/connect', '/v1/alerts', '/ready', '/health']) {
        record(await app.inject({ method: 'GET', url, headers: BEARER }));
      }
      record(
        await app.inject({
          method: 'GET',
          url: `/v1/connect?code=${codes[0]}&state=${states[0]}`,
          headers: { ...BEARER, ...VIA_PROXY },
        }),
      );
      record(
        await app.inject({
          method: 'GET',
          url: `${PREFIX}/privacy?code=${codes[1]}&state=${states[1]}`,
          headers: VIA_PROXY,
        }),
      );
      record(await app.inject({ method: 'DELETE', url: '/v1/connect/linkedin', headers: BEARER }));
    }
    // The same odd requests on the public listeners, with and without the proxy's headers.
    for (const pub of [h.pub, strict.pub]) {
      for (const headers of [VIA_PROXY, BEARER]) {
        for (const url of [
          `/v1/connect?code=${codes[0]}&state=${states[0]}`,
          `/nothing?state=${states[2]}&code=${codes[2]}`,
          `${PREFIX}/privacy?code=${codes[1]}&state=${states[1]}`,
          `${PREFIX}/oauth/threads/callback/x?code=${codes[3]}&state=${states[3]}`,
        ]) {
          record(await pub.inject({ method: 'GET', url, headers }));
        }
        record(
          await pub.inject({
            method: 'HEAD',
            url: `${PREFIX}/oauth/threads/callback?code=${codes[4]}&state=${states[4]}`,
            headers,
          }),
        );
      }
    }
    said.push(h.logs(), strict.logs());
    said.push(JSON.stringify(h.store.alerts.list(1000)));
    said.push(JSON.stringify(h.store.db.prepare('SELECT * FROM bot_state').all()));

    const all = said.join('\n');
    // The scenario really produced output of every kind.
    expect(h.store.alerts.list(1000).length).toBeGreaterThan(12);
    expect(all).toContain('platform connect failed');
    expect(all).toContain('token refresh failed');
    expect(all).toContain('platform_connected');
    expect(all).toContain('/oauth/threads/callback?[REDACTED]');

    const secrets: [string, string][] = [
      ...states.map((s, i): [string, string] => [`state ${i}`, s]),
      ...codes.map((c, i): [string, string] => [`code ${i}`, c]),
      ...tokens.map((t, i): [string, string] => [`token ${i}`, t]),
      ['threads app secret', h.threads.appSecret],
      ['linkedin client secret', h.linkedin.clientSecret],
      ['token store key', STORE_KEY],
      ['api token', API_TOKEN],
      // Families: any token, code or id token the fakes ever issue.
      ['a short-lived threads token', 'FAKE-THREADS-SHORT-TOKEN'],
      ['a long-lived threads token', 'FAKE-THREADS-LONG-TOKEN'],
      ['a refreshed threads token', 'FAKE-THREADS-REFRESHED-TOKEN'],
      ['a linkedin token', 'FAKE-LINKEDIN-ACCESS-TOKEN'],
      ['a linkedin id token', 'FAKE-LINKEDIN-ID-TOKEN'],
      ['a threads code', 'FAKE-THREADS-CODE'],
      ['a linkedin code', 'FAKE-LINKEDIN-CODE'],
    ];
    expect(states.length).toBeGreaterThan(12);
    expect(codes.length).toBeGreaterThan(16);
    for (const [name, value] of secrets) {
      expect(value.length).toBeGreaterThan(8);
      for (const form of new Set([value, encodeURIComponent(value)])) {
        expect(all.includes(form), `${name} found in the service's output`).toBe(false);
      }
    }

    // The `start` answers: their own state by contract, and no other secret.
    const starts = startAnswers.join('\n');
    for (const [name, value] of secrets.filter(([n]) => !n.startsWith('state '))) {
      expect(starts.includes(value), `${name} found in a start answer`).toBe(false);
    }
    // The database file: tokens only encrypted, states only hashed, no code at all.
    const bytes = h.dbBytes();
    for (const [name, value] of secrets.filter(([n]) => n !== 'api token')) {
      expect(bytes.includes(value), `${name} found in the database file`).toBe(false);
    }
  });

  it('the logged request line of a callback has no query', async () => {
    const h = await harness();
    made.push(h);
    const { state, code } = await connectNow(h, 'threads');
    const lines = h
      .logs()
      .split('\n')
      .filter((l) => l.includes('/oauth/threads/callback'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(JSON.parse(l).req.url).toBe(`${PREFIX}/oauth/threads/callback?[REDACTED]`);
    }
    expect(h.logs()).not.toContain(state);
    expect(h.logs()).not.toContain(code);
  });

  it('the app secrets and the store key are scrubbed from any log line by value', async () => {
    const h = await harness();
    made.push(h);
    h.app.log.info(
      {
        note: `secret ${h.threads.appSecret} key ${STORE_KEY}`,
        TOKEN_STORE_KEY: STORE_KEY,
        nested: { LINKEDIN_CLIENT_SECRET: h.linkedin.clientSecret },
      },
      `x ${h.linkedin.clientSecret} ${encodeURIComponent(STORE_KEY)}`,
    );
    const out = h.logs();
    expect(out).toContain('[REDACTED]');
    for (const s of [h.threads.appSecret, h.linkedin.clientSecret, STORE_KEY]) {
      expect(out).not.toContain(s);
      expect(out).not.toContain(encodeURIComponent(s));
    }
  });
});

describe('a failure detail', () => {
  it("is the HTTP status and the platform's machine codes, never its free text", async () => {
    const h = await harness();
    made.push(h);
    for (const [platform, op] of [
      ['threads', 'code'],
      ['threads', 'long'],
      ['linkedin', 'token'],
    ] as const) {
      const { state } = await h.start(platform);
      // The error body repeats the whole request in every text field.
      h[platform].queue(op, { echo: 400 });
      await h.callback(platform, { code: h[platform].issueCode(), state });
    }
    const messages = h.store.alerts.list().map((a) => a.message);
    expect(messages).toEqual([
      'threads connect failed: exchange_failed: code: HTTP 400 OAuthException 400 OAuthException 100',
      'threads connect failed: exchange_failed: long-lived: HTTP 400 OAuthException 400 OAuthException 100',
      'linkedin connect failed: exchange_failed: token: HTTP 400 OAuthException 400 invalid_request',
    ]);
    expect(h.logs()).not.toContain('Bad request');
  });

  it('has the secrets of its own request cut out, whatever text it is built from', async () => {
    const { cut } = await import('../../src/connect/oauth.js');
    const code = 'FAKE-CODE a/b+c=';
    expect(cut(`x ${code} y ${encodeURIComponent(code)} z`, [code, undefined, ''])).toBe(
      'x [redacted] y [redacted] z',
    );
    expect(cut('a'.repeat(1000), [])).toHaveLength(300);
  });
});
