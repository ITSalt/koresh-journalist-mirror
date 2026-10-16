import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLinkedInClient,
  errorCodeOf,
  scrub,
  type LinkedInClientOptions,
} from '../../../src/platforms/linkedin/client.js';
import { FakeLinkedIn } from './fake-linkedin.js';

// Made-up values: they only have to be recognisable if they ever show up where they must not.
const TOKEN = 'fake-linkedin-member-token-MARKER-TOKEN-for-tests-only';
const CLIENT_ID = 'fake-client-id-77abc';
const CLIENT_SECRET = 'fake-client-secret-MARKER-SECRET+/=for tests';

let fake: FakeLinkedIn;
const waits: number[] = [];
const sleep = async (ms: number) => {
  waits.push(ms);
};

beforeEach(async () => {
  waits.length = 0;
  fake = await new FakeLinkedIn({
    token: TOKEN,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  }).start();
});
afterEach(async () => {
  await fake.stop();
});

const client = (over: Partial<LinkedInClientOptions> = {}) =>
  createLinkedInClient({
    token: TOKEN,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    apiBaseUrl: fake.baseUrl,
    oauthBaseUrl: fake.baseUrl,
    timeoutMs: 2000,
    retry: { sleep },
    ...over,
  });

const author = () => fake.personUrn;

describe('createPost', () => {
  it('sends one POST /rest/posts with the exact headers and body and returns the URN', async () => {
    const r = await client().createPost(author(), 'Привет \\(мир\\)');
    expect(r).toEqual({ ok: true, result: { id: fake.feed[0]!.urn } });
    expect(fake.feed[0]!.urn).toMatch(/^urn:li:share:\d+$/);
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/rest/posts');
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['linkedin-version']).toBe('202609');
    expect(req.headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.body).toEqual({
      author: 'urn:li:person:782bbtaQ',
      commentary: 'Привет \\(мир\\)',
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });

  it('takes the version from the settings', async () => {
    fake.activeVersions.add('202701');
    expect((await client({ version: '202701' }).createPost(author(), 'a')).ok).toBe(true);
    expect(fake.requests[0]!.headers['linkedin-version']).toBe('202701');
  });

  it('a sunset version is refused as version_sunset and not retried', async () => {
    fake.activeVersions = new Set(['202701']);
    const r = await client().createPost(author(), 'a');
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(errorCodeOf(r)).toBe('version_sunset');
    expect(!r.ok && r.description).toContain('NONEXISTENT_VERSION');
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.feed).toHaveLength(0);
  });

  it('401 is refused as token_invalid and not retried', async () => {
    const r = await client({ token: 'another-fake-token' }).createPost(author(), 'a');
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(errorCodeOf(r)).toBe('token_invalid');
    expect(fake.sent('posts')).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('an expired token is token_invalid too', async () => {
    fake.tokenStatus = 'expired';
    expect(errorCodeOf(await client().createPost(author(), 'a'))).toBe('token_invalid');
  });

  it('403 is refused as forbidden; any other 4xx as rejected; none is retried', async () => {
    const r403 = await client().createPost('urn:li:person:someoneElse', 'a');
    expect(r403).toMatchObject({ ok: false, outcome: 'refused' });
    expect(errorCodeOf(r403)).toBe('forbidden');
    fake.queue('posts', {
      status: 400,
      body: { status: 400, code: 'MISSING_FIELD', message: 'x' },
    });
    const r400 = await client().createPost(author(), 'a');
    expect(r400).toMatchObject({ ok: false, outcome: 'refused' });
    expect(errorCodeOf(r400)).toBe('rejected');
    expect(!r400.ok && r400.description).toContain('HTTP 400 MISSING_FIELD');
    expect(fake.sent('posts')).toHaveLength(2);
    expect(fake.feed).toHaveLength(0);
    expect(waits).toEqual([]);
  });

  it('a timeout after the request left is unknown and the post is never sent again', async () => {
    fake.queue('posts', { hang: true });
    const r = await client({ timeoutMs: 150 }).createPost(author(), 'a');
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(errorCodeOf(r)).toBe('no_answer');
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.feed).toHaveLength(1); // it is public although we never heard back
    expect(waits).toEqual([]);
  });

  it('a timeout is unknown also when LinkedIn did not create the post', async () => {
    fake.queue('posts', { hang: true, accepted: false });
    const r = await client({ timeoutMs: 150 }).createPost(author(), 'a');
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('posts')).toHaveLength(1);
  });

  it('a socket closed after the request is unknown and never sent again', async () => {
    fake.queue('posts', { drop: true });
    const r = await client().createPost(author(), 'a');
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.feed).toHaveLength(1);
  });

  it('a 201 without the id header is unknown (unreadable answer) and never sent again', async () => {
    fake.queue('posts', { noId: true });
    const r = await client().createPost(author(), 'a');
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(errorCodeOf(r)).toBe('unreadable_answer');
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.feed).toHaveLength(1);
  });

  it('a redirect is not followed: unknown, one request, the token goes nowhere else', async () => {
    fake.queue('posts', { status: 307, headers: { location: `${fake.baseUrl}/v2/userinfo` } });
    const r = await client().createPost(author(), 'a');
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.requests).toHaveLength(1);
  });

  it('a 5xx on a create is unknown at once: no retry, no wait (D-3)', async () => {
    for (const status of [500, 502, 503, 504]) {
      fake.queue('posts', { status, raw: '<html>gateway</html>' });
      const r = await client().createPost(author(), `text ${status}`);
      expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
      expect(errorCodeOf(r)).toBe('server_error');
      expect(!r.ok && r.description).toContain(`HTTP ${status}`);
    }
    expect(fake.sent('posts')).toHaveLength(4); // one request per call
    expect(waits).toEqual([]);
    expect(fake.feed).toHaveLength(0);
  });

  it('a 5xx that follows an accepted create is unknown and the post is not sent again', async () => {
    fake.queue('posts', { status: 502, accepted: true });
    const r = await client().createPost(author(), 'posted behind a 502');
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.feed).toHaveLength(1); // public once, never twice
    expect(waits).toEqual([]);
  });

  it('gives up as failed after the attempts are used on 429', async () => {
    fake.queue('posts', { status: 429 }, { status: 429 }, { status: 429 }, { status: 429 });
    const r = await client().createPost(author(), 'a');
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(errorCodeOf(r)).toBe('rate_limited');
    expect(!r.ok && r.description).toContain('gave up after 4 attempts');
    expect(fake.sent('posts')).toHaveLength(4);
    expect(fake.feed).toHaveLength(0);
  });

  it('a 201 whose body is cut off still gives the id from x-restli-id', async () => {
    fake.queue('posts', { cutBody: true });
    const r = await client().createPost(author(), 'a');
    expect(r).toEqual({ ok: true, result: { id: fake.feed[0]!.urn } });
    expect(fake.sent('posts')).toHaveLength(1);
  });

  it('a 201 with a cut body and no id header is unknown and never sent again', async () => {
    fake.queue('posts', { cutBody: true, withoutId: true });
    const r = await client().createPost(author(), 'a');
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(errorCodeOf(r)).toBe('unreadable_answer');
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.feed).toHaveLength(1);
  });

  /** A fetch that fails the way undici does: a TypeError whose cause carries the code. */
  const failingFetch = (code: string) => {
    let calls = 0;
    const f = (async () => {
      calls++;
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('socket'), { code }),
      });
    }) as unknown as typeof fetch;
    return { f, calls: () => calls };
  };

  it.each(['EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])(
    '%s on a create is unknown: it can come after the body was written; one attempt',
    async (code) => {
      const { f, calls } = failingFetch(code);
      const r = await client({ fetch: f }).createPost(author(), 'a');
      expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
      expect(errorCodeOf(r)).toBe('no_answer');
      expect(!r.ok && r.description).toContain(code);
      expect(calls()).toBe(1);
      expect(waits).toEqual([]);
      const c = failingFetch(code);
      const rc = await client({ fetch: c.f }).createComment('urn:li:share:1', author(), 'x');
      expect(rc).toMatchObject({ ok: false, outcome: 'unknown' });
      expect(c.calls()).toBe(1);
    },
  );

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])(
    '%s on a create is not sent: retried within the bound, then failed',
    async (code) => {
      const { f, calls } = failingFetch(code);
      const r = await client({ fetch: f }).createPost(author(), 'a');
      expect(r).toMatchObject({ ok: false, outcome: 'failed' });
      expect(errorCodeOf(r)).toBe('not_sent');
      expect(calls()).toBe(4);
      expect(waits).toEqual([1000, 2000, 4000]);
    },
  );

  it('waits Retry-After on 429 and then posts', async () => {
    fake.queue('posts', { status: 429, headers: { 'retry-after': '7' } });
    const r = await client().createPost(author(), 'a');
    expect(r.ok).toBe(true);
    expect(waits).toEqual([7000]);
    expect(fake.feed).toHaveLength(1);
  });

  it('backs off on a 429 without Retry-After', async () => {
    fake.queue('posts', { status: 429 }, { status: 429 });
    expect((await client().createPost(author(), 'a')).ok).toBe(true);
    expect(waits).toEqual([1000, 2000]);
  });

  it('gives up as failed with retryAfterS when Retry-After exceeds the wait budget', async () => {
    fake.queue('posts', { status: 429, headers: { 'retry-after': '3600' } });
    const r = await client({ retry: { sleep, maxWaitMs: 60_000 } }).createPost(author(), 'a');
    expect(r).toMatchObject({ ok: false, outcome: 'failed', retryAfterS: 3600 });
    expect(errorCodeOf(r)).toBe('rate_limited');
    expect(waits).toEqual([]);
    expect(fake.sent('posts')).toHaveLength(1);
  });

  it('a refused connection is retried and ends as failed: nothing was sent', async () => {
    const port = Number(new URL(fake.baseUrl).port);
    await fake.stop();
    const r = await createLinkedInClient({
      token: TOKEN,
      apiBaseUrl: `http://127.0.0.1:${port}`,
      retry: { sleep, maxAttempts: 3 },
    }).createPost('urn:li:person:x', 'a');
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(errorCodeOf(r)).toBe('not_sent');
    expect(waits).toEqual([1000, 2000]);
    fake = await new FakeLinkedIn({
      token: TOKEN,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    }).start(); // for afterEach
  });

  it('a duplicate on the first attempt is a plain refusal', async () => {
    await client().createPost(author(), 'same text');
    const r = await client().createPost(author(), 'same text');
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(errorCodeOf(r)).toBe('duplicate');
    expect(fake.feed).toHaveLength(1);
  });

  it('a duplicate reported on a retry is unknown, not a clean refusal', async () => {
    // Not expected from LinkedIn: a 429 for a create that was accepted after all.
    fake.queue('posts', { status: 429, accepted: true });
    const r = await client().createPost(author(), 'posted behind a 429');
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(errorCodeOf(r)).toBe('duplicate');
    expect(fake.sent('posts')).toHaveLength(2);
    expect(fake.feed).toHaveLength(1);
  });
});

describe('createComment', () => {
  const post = async () => {
    const r = await client().createPost(author(), 'post');
    if (!r.ok) throw new Error('setup');
    return r.result.id;
  };

  it('posts to the percent-encoded socialActions path and returns the comment URN', async () => {
    const urn = await post();
    const text = 'Ссылка (оригинал): https://t.me/Channel1/57';
    const r = await client().createComment(urn, author(), text);
    const made = fake.comments[0]!;
    expect(r).toEqual({ ok: true, result: { id: made.commentUrn } });
    expect(made.commentUrn).toMatch(/^urn:li:comment:\(urn:li:activity:\d+,\d+\)$/);
    const req = fake.sent('comments')[0]!;
    expect(req.path).toBe(`/rest/socialActions/${urn.replaceAll(':', '%3A')}/comments`);
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['linkedin-version']).toBe('202609');
    expect(req.headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(req.headers['content-type']).toBe('application/json');
    // The comment text is plain text: it is not escaped as little text.
    expect(req.body).toEqual({ actor: author(), object: urn, message: { text } });
  });

  it('falls back to the numeric id of the header when the body cannot be read', async () => {
    const urn = await post();
    fake.queue('comments', {
      status: 201,
      raw: 'not json',
      headers: { 'x-restli-id': '6643206422739898368' },
    });
    expect(await client().createComment(urn, author(), 'x')).toEqual({
      ok: true,
      result: { id: '6643206422739898368' },
    });
  });

  it('403 is refused as comment_forbidden: one call, no retry, never unknown', async () => {
    const urn = await post();
    fake.commentsAllowed = false;
    const r = await client().createComment(urn, author(), 'x');
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(errorCodeOf(r)).toBe('comment_forbidden');
    expect(fake.sent('comments')).toHaveLength(1);
    expect(fake.comments).toHaveLength(0);
    expect(waits).toEqual([]);
  });

  it('a 5xx on a comment is unknown at once: no retry (D-3)', async () => {
    const urn = await post();
    fake.queue('comments', { status: 500 }, { status: 503, accepted: true });
    for (const made of [0, 1]) {
      const r = await client().createComment(urn, author(), `x ${made}`);
      expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
      expect(errorCodeOf(r)).toBe('server_error');
    }
    expect(fake.sent('comments')).toHaveLength(2); // one request per call
    expect(fake.comments).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('a 201 whose body is cut off still gives the comment id from x-restli-id', async () => {
    const urn = await post();
    fake.queue('comments', { cutBody: true });
    const r = await client().createComment(urn, author(), 'x');
    expect(r).toEqual({ ok: true, result: { id: fake.comments[0]!.id } });
    expect(fake.comments[0]!.id).toMatch(/^[0-9]+$/);
    expect(fake.sent('comments')).toHaveLength(1);
  });

  it('a timeout is unknown and the comment is never sent again', async () => {
    const urn = await post();
    fake.queue('comments', { hang: true });
    const r = await client({ timeoutMs: 150 }).createComment(urn, author(), 'x');
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('comments')).toHaveLength(1);
  });

  it('401 on a comment is token_invalid; a sunset version is version_sunset', async () => {
    const urn = await post();
    const r = await client({ token: 'another-fake-token' }).createComment(urn, author(), 'x');
    expect(errorCodeOf(r)).toBe('token_invalid');
    fake.activeVersions = new Set(['202701']);
    expect(errorCodeOf(await client().createComment(urn, author(), 'x'))).toBe('version_sunset');
  });

  it('the short-term comment throttle (429) is retried with a bound', async () => {
    const urn = await post();
    fake.queue('comments', {
      status: 429,
      body: { status: 429, message: 'Comment create throttled' },
    });
    expect((await client().createComment(urn, author(), 'x')).ok).toBe(true);
    expect(fake.comments).toHaveLength(1);
    expect(waits).toEqual([1000]);
  });
});

describe('userinfo', () => {
  it('returns the member id with only the bearer header', async () => {
    expect(await client().userinfo()).toEqual({
      ok: true,
      result: { sub: '782bbtaQ', name: 'John Doe' },
    });
    const req = fake.sent('userinfo')[0]!;
    expect(req.method).toBe('GET');
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('401 is token_invalid', async () => {
    const r = await client({ token: 'another-fake-token' }).userinfo();
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(errorCodeOf(r)).toBe('token_invalid');
  });

  it('a read creates nothing, so a 5xx or an unreachable host is retried', async () => {
    fake.queue('userinfo', { status: 500 }, { status: 503 });
    expect(await client().userinfo()).toMatchObject({ ok: true, result: { sub: '782bbtaQ' } });
    expect(waits).toEqual([1000, 2000]);
    let calls = 0;
    const unreachable = (async () => {
      calls++;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } });
    }) as unknown as typeof fetch;
    const r = await client({ fetch: unreachable, retry: { sleep, maxAttempts: 3 } }).userinfo();
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(calls).toBe(3);
  });

  it('a read that got no answer is retried and ends as failed, not unknown', async () => {
    fake.queue('userinfo', { drop: true }, { status: 200, raw: '{}' });
    const r = await client({ retry: { sleep, maxAttempts: 2 } }).userinfo();
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(fake.sent('userinfo')).toHaveLength(2);
  });
});

describe('introspect', () => {
  it('posts the form to the OAuth host and reads the state and the expiry', async () => {
    const r = await client().introspect();
    expect(r).toEqual({
      ok: true,
      result: { active: true, status: 'active', expiresAt: new Date('2026-12-11T09:00:00.000Z') },
    });
    const req = fake.sent('introspect')[0]!;
    expect(req.path).toBe('/oauth/v2/introspectToken');
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(req.headers.authorization).toBeUndefined();
    expect(req.body).toEqual({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, token: TOKEN });
  });

  it('reports an expired and a revoked token as not active', async () => {
    fake.tokenStatus = 'expired';
    expect(await client().introspect()).toMatchObject({
      ok: true,
      result: { active: false, status: 'expired' },
    });
    fake.tokenStatus = 'revoked';
    expect(await client().introspect()).toMatchObject({
      ok: true,
      result: { active: false, status: 'revoked' },
    });
  });

  it('a wrong client secret is a refusal about the app, not token_invalid', async () => {
    const r = await client({ clientSecret: 'wrong-fake-secret' }).introspect();
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(errorCodeOf(r)).toBe('rejected');
  });

  it('without the app credentials nothing is sent', async () => {
    const r = await createLinkedInClient({ token: TOKEN, oauthBaseUrl: fake.baseUrl }).introspect();
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(errorCodeOf(r)).toBe('not_configured');
    expect(fake.requests).toHaveLength(0);
  });

  it('an answer without `active` is failed after the retries', async () => {
    fake.queue('introspect', { status: 200, raw: '{}' }, { status: 200, raw: 'oops' });
    const r = await client({ retry: { sleep, maxAttempts: 2 } }).introspect();
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(errorCodeOf(r)).toBe('unreadable_answer');
  });
});

describe('secrets never leave the client in a description or a log', () => {
  const markers = [TOKEN, CLIENT_SECRET, encodeURIComponent(CLIENT_SECRET), 'MARKER'];
  const leaks = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return markers.filter((m) => text.includes(m));
  };

  it('scrub cuts secrets as they are, percent-encoded, and any bearer value', () => {
    const dirty = `a ${TOKEN} b ${encodeURIComponent(CLIENT_SECRET)} c ${CLIENT_SECRET} Bearer zzz.other`;
    const cleaned = scrub(dirty, [TOKEN, CLIENT_SECRET, undefined]);
    expect(leaks(cleaned)).toEqual([]);
    expect(cleaned).not.toContain('zzz.other');
    expect(cleaned).toContain('[redacted]');
    expect(scrub('x'.repeat(1000), [])).toHaveLength(300);
  });

  it('whatever LinkedIn or the network answers', async () => {
    const out: unknown[] = [];
    const logged: unknown[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      }),
    );
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    try {
      // LinkedIn echoes everything it was sent.
      const echo = {
        status: 400,
        code: `X ${TOKEN}`,
        message: `Authorization: Bearer ${TOKEN}; client_secret=${encodeURIComponent(CLIENT_SECRET)}; ${CLIENT_SECRET}`,
      };
      // Per call, in order: a refusal; a throttle to the end (failed); a 5xx; a lost answer.
      for (const route of ['posts', 'comments'] as const) {
        fake.queue(route, { status: 400, body: echo });
        fake.queue(route, { status: 429, body: echo }, { status: 429, body: echo });
        fake.queue(route, { status: 429, body: echo }, { status: 429, body: echo });
        fake.queue(route, { status: 500, body: echo }); // unknown at once
        fake.queue(route, { drop: true }); // unknown
      }
      // The reads: a refusal; four retried answers (failed); four more (failed); a refusal.
      for (const route of ['userinfo', 'introspect'] as const) {
        fake.queue(route, { status: 400, body: echo });
        fake.queue(route, { status: 500, body: echo }, { status: 500, body: echo });
        fake.queue(route, { status: 429, body: echo }, { status: 500, body: echo });
        fake.queue(route, { drop: true }, { status: 200, body: echo });
        fake.queue(route, { status: 500, body: echo }, { status: 500, body: echo });
        fake.queue(route, { status: 401, body: echo });
      }
      const c = client({ retry: { sleep, maxAttempts: 4 } });
      for (let i = 0; i < 4; i++) {
        out.push(await c.createPost(author(), `text ${i}`));
        out.push(await c.createComment('urn:li:share:1', author(), 'x'));
        out.push(await c.userinfo());
        out.push(await c.introspect());
      }
      // Every queued answer was used, and each call ended the way the comment above says.
      for (const route of ['posts', 'comments', 'userinfo', 'introspect'] as const) {
        expect(fake.replies[route]).toEqual([]);
      }
      const read = ['refused', 'failed', 'failed', 'refused'];
      expect(out.map((o) => (o as { outcome: string }).outcome)).toEqual(
        ['refused', 'failed', 'unknown', 'unknown'].flatMap((write, i) => [
          write,
          write,
          read[i],
          read[i],
        ]),
      );
      // A timeout and a transport error whose message holds the URL and the secrets.
      fake.queue('posts', { hang: true });
      out.push(await client({ timeoutMs: 150 }).createPost(author(), 'hang'));
      const throwing = (async () => {
        throw Object.assign(new Error(`connect failed for Bearer ${TOKEN} ${CLIENT_SECRET}`), {
          cause: new Error(TOKEN),
        });
      }) as unknown as typeof fetch;
      const t = client({ fetch: throwing });
      out.push(await t.createPost(author(), 'a'), await t.introspect(), await t.userinfo());
      // A refused connection.
      const dead = client({ apiBaseUrl: 'http://127.0.0.1:1', oauthBaseUrl: 'http://127.0.0.1:1' });
      out.push(await dead.createPost(author(), 'a'), await dead.introspect());

      expect(out).toHaveLength(16 + 1 + 3 + 2);
      expect(out.every((o) => (o as { ok: boolean }).ok === false)).toBe(true);
      for (const o of out) expect(leaks(o)).toEqual([]);
      expect(leaks(logged)).toEqual([]);
      for (const spy of [stdout, stderr]) {
        for (const call of spy.mock.calls) expect(leaks(String(call[0]))).toEqual([]);
      }
    } finally {
      for (const s of [...spies, stdout, stderr]) s.mockRestore();
    }
  });
});
