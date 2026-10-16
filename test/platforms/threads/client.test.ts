import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createThreadsClient,
  type ThreadsClientOptions,
} from '../../../src/platforms/threads/client.js';
import { FakeThreads } from '../../support/fake-threads.js';
import { TOKEN } from './helpers.js';

let fake: FakeThreads;
let waits: number[];
beforeEach(async () => {
  fake = await new FakeThreads(TOKEN).start();
  waits = [];
});
afterEach(async () => {
  await fake.stop();
});

const client = (over: Partial<ThreadsClientOptions> = {}) =>
  createThreadsClient({
    token: () => TOKEN,
    timeoutMs: 2000,
    ...over,
    baseUrl: over.baseUrl ?? fake.baseUrl,
    retry: {
      sleep: async (ms) => {
        waits.push(ms);
      },
      ...over.retry,
    },
  });

describe('reads', () => {
  it('me returns the profile id and name', async () => {
    expect(await client().me()).toEqual({
      ok: true,
      result: { id: fake.userId, username: 'fake_profile' },
    });
  });

  it('publishingLimit returns usage, total and the window', async () => {
    fake.quotaUsage = 4;
    expect(await client().publishingLimit()).toEqual({
      ok: true,
      result: { usage: 4, total: 250, durationS: 86400 },
    });
  });

  it('permalink returns the public URL of a published post', async () => {
    const c = client();
    const container = await c.createContainer('Привет');
    const post = await c.publishContainer(container.ok ? container.result.id : '');
    const id = post.ok ? post.result.id : '';
    expect(await c.permalink(id)).toEqual({ ok: true, result: { url: fake.posts[0]!.permalink } });
    expect(fake.sent('permalink')[0]).toMatchObject({
      path: `/v1.0/${id}`,
      params: { fields: 'id,permalink' },
    });
  });

  it('a read has no effect, so a lost answer is simply asked again', async () => {
    fake.queue('me', { drop: true }, { hang: true });
    const r = await client({ timeoutMs: 200 }).me();
    expect(r.ok).toBe(true);
    expect(fake.sent('me')).toHaveLength(3);
  });

  it('a quota answer with no usable numbers is not a quota', async () => {
    fake.queue(
      'quota',
      { raw: '{"data":[{"quota_usage":1,"config":{"quota_total":0}}]}' },
      { raw: '{"data":[{"quota_usage":"1","config":{"quota_total":250}}]}' },
    );
    const c = client({ retry: { maxAttempts: 1 } });
    expect(await c.publishingLimit()).toMatchObject({ ok: false, outcome: 'failed' });
    expect(await c.publishingLimit()).toMatchObject({ ok: false, outcome: 'failed' });
  });
});

describe('container', () => {
  it('a refused connection is retried with backoff and ends as `failed`: nothing was sent', async () => {
    const base = fake.baseUrl;
    await fake.stop();
    const r = await client({ baseUrl: base, retry: { maxAttempts: 3 } }).createContainer('x');
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(r.ok ? '' : r.description).toMatch(/^threads: .*ECONNREFUSED.*gave up after 3 attempts/);
    expect(waits).toEqual([1000, 2000]);
    fake = await new FakeThreads(TOKEN).start(); // for afterEach
  });

  it('by default gives up after 5 attempts', async () => {
    fake.queue('container', ...Array.from({ length: 5 }, () => ({ status: 500 })));
    const r = await client().createContainer('x');
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(fake.sent('container')).toHaveLength(5);
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });

  it('stops when the next wait would exceed the wait budget', async () => {
    fake.queue('container', { status: 500 }, { status: 500 }, { status: 500 });
    const r = await client({ retry: { maxWaitMs: 2500 } }).createContainer('x');
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(r.ok ? '' : r.description).toContain('retry wait 2000 ms exceeds the budget');
    expect(waits).toEqual([1000]);
  });

  it('a timeout is retried: the container is invisible, so it is never `unknown`', async () => {
    fake.queue('container', { hang: true }, { hang: true });
    const r = await client({ timeoutMs: 150, retry: { maxAttempts: 2 } }).createContainer('x');
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(fake.sent('container')).toHaveLength(2);
    expect(fake.posts).toHaveLength(0);
  });
});

describe('publish call', () => {
  it('without a container id nothing is sent', async () => {
    const r = await client().publishContainer('');
    expect(r).toEqual({
      ok: false,
      outcome: 'refused',
      description: 'threads_publish: no container id, nothing was sent',
      notPublished: true,
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('a container the platform does not know is `refused`', async () => {
    const r = await client().publishContainer('17909999');
    expect(r).toEqual({
      ok: false,
      outcome: 'refused',
      description:
        'threads_publish: The requested resource does not exist (code 24, subcode 4279009)',
      notPublished: true,
    });
    expect(fake.posts).toHaveLength(0);
  });

  it('a 2xx that carries an error object is `unknown`, not a success and not a retry', async () => {
    fake.queue('publish', {
      raw: '{"id":"18000001","error":{"message":"odd","code":1}}',
      applied: false,
    });
    const c = client();
    const container = await c.createContainer('x');
    const r = await c.publishContainer(container.ok ? container.result.id : '');
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('publish')).toHaveLength(1);
  });

  it('by default a first 429 ends the call: `failed` after one request, not marked certain', async () => {
    fake.queue('publish', { status: 429, retryAfter: 1 });
    const c = client();
    const container = await c.createContainer('x');
    const r = await c.publishContainer(container.ok ? container.result.id : '');
    expect(r).toMatchObject({ ok: false, outcome: 'failed', retryAfterS: 1 });
    expect(r).not.toHaveProperty('notPublished');
    expect(fake.sent('publish')).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('with the resend on, a second 429 is not waited for: an error answer to a later request is `unknown`', async () => {
    fake.queue('publish', { status: 429, retryAfter: 1 }, { status: 429, retryAfter: 2 });
    const c = client({ resendPublishAfter429: true });
    const container = await c.createContainer('x');
    const r = await c.publishContainer(container.ok ? container.result.id : '');
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(r).not.toHaveProperty('notPublished');
    expect(fake.sent('publish')).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  it('a success carries no `notPublished` mark', async () => {
    const c = client();
    const container = await c.createContainer('x');
    const r = await c.publishContainer(container.ok ? container.result.id : '');
    expect(r).toEqual({ ok: true, result: { id: fake.posts[0]!.id } });
  });
});

describe('construction', () => {
  it('a base URL that is not a URL fails at start, not in the middle of a call', () => {
    expect(() => createThreadsClient({ token: () => TOKEN, baseUrl: 'not a url' })).toThrow();
  });

  it('a trailing slash in the base URL is harmless', async () => {
    expect((await client({ baseUrl: `${fake.baseUrl}/` }).me()).ok).toBe(true);
    expect(fake.sent('me')[0]!.path).toBe('/v1.0/me');
  });
});

describe('transport errors that can arrive late', () => {
  const late =
    (code: string): typeof fetch =>
    async (url, init) => {
      await fetch(url, init); // the request is carried out, then the socket fails
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error(`connect ${code}`), { code }),
      });
    };

  it.each(['EHOSTUNREACH', 'ENETUNREACH'])(
    '%s on a read or a container is asked again like any lost answer',
    async (code) => {
      let n = 0;
      const once: typeof fetch = (url, init) =>
        n++ === 0 ? late(code)(url, init) : fetch(url, init);
      expect((await client({ fetch: once }).me()).ok).toBe(true);
      expect(fake.sent('me')).toHaveLength(2);
    },
  );

  it.each(['EHOSTUNREACH', 'ENETUNREACH'])(
    '%s on the token refresh is `unknown` and not resent',
    async (code) => {
      fake.tokenIssuedAt = new Date('2026-09-01T00:00:00.000Z');
      const r = await client({ fetch: late(code) }).refreshAccessToken();
      expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
      expect(fake.sent('refresh')).toHaveLength(1);
    },
  );
});

describe('descriptions', () => {
  it('a long platform message is cut to 300 characters', async () => {
    fake.queue('container', { status: 400, error: { message: 'm'.repeat(1000), code: 100 } });
    const r = await client().createContainer('x');
    expect(r.ok ? 0 : r.description.length).toBe(300);
  });

  it('a network error is described by its name and code, never by its message', async () => {
    const failing: typeof fetch = async () => {
      throw Object.assign(new TypeError('fetch failed: some detail of the request'), {
        cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      });
    };
    expect(await client({ fetch: failing }).publishContainer('17900001')).toEqual({
      ok: false,
      outcome: 'unknown',
      description: 'threads_publish: TypeError ECONNRESET',
    });
  });

  it('an error without a body is described by its status', async () => {
    fake.queue('container', { raw: 'Bad Gateway', rawStatus: 502, applied: false });
    const r = await client({ retry: { maxAttempts: 1 } }).createContainer('x');
    expect(r).toEqual({
      ok: false,
      outcome: 'failed',
      description: 'threads: HTTP 502 (gave up after 1 attempts)',
    });
  });
});
