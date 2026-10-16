import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeThreads } from '../../support/fake-threads.js';
import { input, KEY, rig, TOKEN } from './helpers.js';

// Decisions D-3 and D-4: what an answer to the publish call proves. A 4xx is a certain "no" only
// when it answers the FIRST request for that container and is not transient. Any error answer to
// a later request for the same container is `unknown`: an earlier request may have been carried
// out whatever its own answer said. Only a certain "no" lets the item start over with a fresh
// container; everything else leaves the record at the publish step for good.
//
// By default the publish request is never sent a second time after an answer: a first 429 ends
// the call (`failed`, the record stays). The single resend after a first 429 exists behind
// `resendPublishAfter429: true` and is tested with that option set; it is switched on only after
// live calls have shown that the platform refuses to publish a container twice.

let fake: FakeThreads;
beforeEach(async () => {
  fake = await new FakeThreads(TOKEN).start();
});
afterEach(async () => {
  await fake.stop();
});

const isPublish = (url: unknown) => new URL(String(url)).pathname.endsWith('/threads_publish');
const transportError = (code: string) =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(`connect ${code}`), { code }),
  });

/** The first `n` publish requests never leave: the connection fails with `code`. */
const neverSent =
  (code: string, n: number): typeof fetch =>
  async (url, init) => {
    if (isPublish(url) && n-- > 0) throw transportError(code);
    return fetch(url, init);
  };

/** The first publish request is carried out by the platform, then the socket fails with `code`. */
const lateFailure = (code: string): typeof fetch => {
  let first = true;
  return async (url, init) => {
    if (isPublish(url) && first) {
      first = false;
      await fetch(url, init);
      throw transportError(code);
    }
    return fetch(url, init);
  };
};

/** After the first call: the same key again, as a guarded retry by the caller would do. */
async function retrySendsNothing(adapter: ReturnType<typeof rig>['adapter']) {
  const before = fake.requests.length;
  const again = await adapter.publish(input());
  expect(again).toMatchObject({ ok: false, outcome: 'unknown' });
  expect(again.ok ? '' : again.description).toMatch(/^publish_already_started: /);
  expect(fake.requests).toHaveLength(before);
}

describe('the double post found in review: one key must end with one post', () => {
  it('by default: the platform publishes and answers 429; nothing is sent again, one post', async () => {
    fake.queue('publish', { status: 429, retryAfter: 1, applied: true });
    const { adapter, steps, waits } = rig(fake);
    const r = await adapter.publish(input());

    expect(r).toEqual({
      ok: false,
      outcome: 'failed',
      description:
        'threads_publish: fake error 429 (code 4) (a 429 on the publish call is not sent again; ' +
        'the publish step stays recorded, this key is not sent again)',
      retryAfterS: 1,
    });
    expect(waits).toEqual([]);
    expect(fake.sent('publish')).toHaveLength(1);
    expect(steps.get(KEY)?.step).toBe('publish');

    await retrySendsNothing(adapter);
    await retrySendsNothing(adapter);
    expect(fake.sent('publish')).toHaveLength(1);
    expect(fake.containers.size).toBe(1);
    expect(fake.posts).toHaveLength(1);
  });

  it('with the resend on: the platform publishes, answers 429, then refuses the resend as already published', async () => {
    // Request 1: carried out, answered 429. Request 2: the same container, 400. The third
    // request, a fresh container published under the same key, is the one that must never leave.
    fake.queue('publish', { status: 429, retryAfter: 1, applied: true });
    const { adapter, steps, waits } = rig(fake, { resendPublishAfter429: true });
    const r = await adapter.publish(input());

    expect(fake.posts).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(r.ok ? '' : r.description).toBe(
      'threads_publish: The media has already been published. (code 100) ' +
        '(answer to request 2 for the same container: an earlier one may have been carried out)',
    );
    expect(waits).toEqual([1000]);
    expect(fake.sent('publish')).toHaveLength(2);
    expect(steps.get(KEY)?.step).toBe('publish');

    await retrySendsNothing(adapter);
    await retrySendsNothing(adapter);
    expect(fake.sent('publish')).toHaveLength(2);
    expect(fake.containers.size).toBe(1);
    expect(fake.posts).toHaveLength(1);
  });

  it.each(['EHOSTUNREACH', 'ENETUNREACH'])(
    'the platform publishes and the socket then fails with %s: `unknown` after one request',
    async (code) => {
      const { adapter, steps, waits } = rig(fake, { fetch: lateFailure(code) });
      const r = await adapter.publish(input());

      expect(r).toEqual({
        ok: false,
        outcome: 'unknown',
        description: `threads_publish: TypeError ${code}`,
      });
      expect(fake.sent('publish')).toHaveLength(1);
      expect(waits).toEqual([]);
      expect(steps.get(KEY)?.step).toBe('publish');

      await retrySendsNothing(adapter);
      expect(fake.containers.size).toBe(1);
      expect(fake.posts).toHaveLength(1);
    },
  );
});

describe('an error answer to a second or later publish request is never a clean refusal', () => {
  it('with the resend on: 429, then a 4xx: `unknown`, the record stays at the publish step', async () => {
    fake.queue(
      'publish',
      { status: 429, retryAfter: 1 },
      { status: 400, error: { message: 'Not allowed', code: 10 } },
    );
    const { adapter, steps } = rig(fake, { resendPublishAfter429: true });
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('publish')).toHaveLength(2);
    expect(steps.get(KEY)?.step).toBe('publish');
    await retrySendsNothing(adapter);
    expect(fake.containers.size).toBe(1);
  });

  it('a refused connection, then a 4xx: `unknown`, the record stays', async () => {
    fake.queue('publish', { status: 400, error: { message: 'Not allowed', code: 10 } });
    const { adapter, steps } = rig(fake, { fetch: neverSent('ECONNREFUSED', 1) });
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('publish')).toHaveLength(1);
    expect(steps.get(KEY)?.step).toBe('publish');
    await retrySendsNothing(adapter);
  });

  it('with the resend on: 429, then a token error: `unknown`, not a refusal', async () => {
    fake.queue(
      'publish',
      { status: 429, retryAfter: 1 },
      { status: 400, error: { message: 'Invalid token', code: 190 } },
    );
    const { adapter, steps } = rig(fake, { resendPublishAfter429: true });
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(steps.get(KEY)?.step).toBe('publish');
  });

  it('with the resend on: a second 429 is not waited for: `unknown` after two requests', async () => {
    fake.queue('publish', { status: 429, retryAfter: 1 }, { status: 429, retryAfter: 1 });
    const { adapter, steps, waits } = rig(fake, { resendPublishAfter429: true });
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('publish')).toHaveLength(2);
    expect(waits).toEqual([1000]);
    expect(steps.get(KEY)?.step).toBe('publish');
  });

  it('with the resend on: 429, then the resend succeeds: one post', async () => {
    fake.queue('publish', { status: 429, retryAfter: 1 });
    const { adapter, waits } = rig(fake, { resendPublishAfter429: true });
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(waits).toEqual([1000]);
    expect(fake.sent('publish')).toHaveLength(2);
    expect(fake.posts).toHaveLength(1);
  });

  it('by default the same 429 is the end: one request, no post, no wait', async () => {
    fake.queue('publish', { status: 429, retryAfter: 1 });
    const { adapter, waits } = rig(fake);
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'failed' });
    expect(waits).toEqual([]);
    expect(fake.sent('publish')).toHaveLength(1);
    expect(fake.posts).toHaveLength(0);
  });
});

describe('a transient refusal of the first publish request proves nothing', () => {
  it.each([
    ['Graph code 1', { status: 400, error: { message: 'An unknown error occurred', code: 1 } }],
    ['Graph code 2', { status: 400, error: { message: 'Service unavailable', code: 2 } }],
    [
      'is_transient',
      { status: 400, error: { message: 'Try again', code: 10, is_transient: true } },
    ],
    ['HTTP 408', { status: 408, error: { message: 'Request timeout', code: 10 } }],
    ['HTTP 409', { status: 409, error: { message: 'Conflict', code: 10 } }],
  ])('%s: `unknown`, one request, the record stays', async (_name, reply) => {
    fake.queue('publish', reply);
    const { adapter, steps, waits } = rig(fake);
    const r = await adapter.publish(input());
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(r.ok ? '' : r.description).toContain('a temporary refusal says nothing certain');
    expect(fake.sent('publish')).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(steps.get(KEY)?.step).toBe('publish');
    await retrySendsNothing(adapter);
    expect(fake.containers.size).toBe(1);
  });

  it('the same answers carried out by the platform end with one post', async () => {
    fake.queue('publish', {
      status: 400,
      error: { message: 'An unknown error occurred', code: 1 },
      applied: true,
    });
    const { adapter } = rig(fake);
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'unknown' });
    await retrySendsNothing(adapter);
    expect(fake.posts).toHaveLength(1);
  });
});

describe('when the item may start over with a fresh container', () => {
  it('a lasting 4xx on the first request: `refused`, back to step 1, the retry makes one post', async () => {
    fake.queue('publish', { status: 400, error: { message: 'Not allowed', code: 10 } });
    const { adapter, steps } = rig(fake);
    const r = await adapter.publish(input());
    expect(r).toEqual({
      ok: false,
      outcome: 'refused',
      description: 'threads_publish: Not allowed (code 10)',
    });
    expect(steps.get(KEY)?.step).toBe('container');
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(fake.posts).toHaveLength(1);
  });

  it('a token error on the first request: `refused`, back to step 1', async () => {
    fake.queue('publish', { status: 400, error: { message: 'Invalid token', code: 190 } });
    const { adapter, steps } = rig(fake);
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'refused' });
    expect(steps.get(KEY)?.step).toBe('container');
  });

  it('no request ever left (refused connection every time): `failed`, back to step 1', async () => {
    const { adapter, steps, waits } = rig(fake, {
      fetch: neverSent('ECONNREFUSED', 3),
      retry: { maxAttempts: 3 },
    });
    const r = await adapter.publish(input());
    expect(r).toEqual({
      ok: false,
      outcome: 'failed',
      description: 'threads_publish: TypeError ECONNREFUSED (gave up after 3 attempts)',
    });
    expect(waits).toEqual([1000, 2000]);
    expect(fake.sent('publish')).toHaveLength(0);
    expect(steps.get(KEY)?.step).toBe('container');

    expect((await adapter.publish(input())).ok).toBe(true);
    expect(fake.posts).toHaveLength(1);
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])(
    '%s is a connect-phase failure too: sent again, one post',
    async (code) => {
      const { adapter, waits } = rig(fake, { fetch: neverSent(code, 1) });
      expect((await adapter.publish(input())).ok).toBe(true);
      expect(waits).toEqual([1000]);
      expect(fake.posts).toHaveLength(1);
    },
  );

  it.each(['EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])(
    '%s is not: `unknown` after one attempt, even if the request did not arrive',
    async (code) => {
      const { adapter, steps, waits } = rig(fake, { fetch: neverSent(code, 1) });
      expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'unknown' });
      expect(waits).toEqual([]);
      expect(fake.sent('publish')).toHaveLength(0);
      expect(steps.get(KEY)?.step).toBe('publish');
    },
  );
});

describe('a `failed` publish that is not certain keeps the record at the publish step', () => {
  it('with the resend on: a first 429 whose Retry-After does not fit the budget: `failed`, the key is not sent again', async () => {
    fake.queue('publish', { status: 429, retryAfter: 600 });
    const { adapter, steps, waits } = rig(fake, { resendPublishAfter429: true });
    const r = await adapter.publish(input());
    expect(r).toEqual({
      ok: false,
      outcome: 'failed',
      description:
        'threads_publish: fake error 429 (code 4) (retry wait 600000 ms exceeds the budget; ' +
        'the publish step stays recorded, this key is not sent again)',
      retryAfterS: 600,
    });
    expect(waits).toEqual([]);
    expect(steps.get(KEY)?.step).toBe('publish');
    await retrySendsNothing(adapter);
  });

  it('with the resend on: that 429 carried out by the platform: still one post', async () => {
    fake.queue('publish', { status: 429, retryAfter: 600, applied: true });
    const { adapter } = rig(fake, { resendPublishAfter429: true });
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'failed' });
    await retrySendsNothing(adapter);
    expect(fake.containers.size).toBe(1);
    expect(fake.posts).toHaveLength(1);
  });

  it('with the resend on: 429, then refused connections until the attempts run out: `failed`, the record stays', async () => {
    fake.queue('publish', { status: 429, retryAfter: 1 });
    let seen = 0;
    const afterFirst: typeof fetch = async (url, init) => {
      if (isPublish(url) && seen++ > 0) throw transportError('ECONNREFUSED');
      return fetch(url, init);
    };
    const { adapter, steps, waits } = rig(fake, {
      fetch: afterFirst,
      retry: { maxAttempts: 3 },
      resendPublishAfter429: true,
    });
    const r = await adapter.publish(input());
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(r.ok ? '' : r.description).toContain('gave up after 3 attempts');
    expect(r.ok ? '' : r.description).toContain('the publish step stays recorded');
    expect(waits).toEqual([1000, 1000]);
    expect(fake.sent('publish')).toHaveLength(1);
    expect(steps.get(KEY)?.step).toBe('publish');
  });

  it('with the resend explicitly off: the same as the default', async () => {
    fake.queue('publish', { status: 429, retryAfter: 1, applied: true });
    const { adapter, steps, waits } = rig(fake, { resendPublishAfter429: false });
    const r = await adapter.publish(input());
    expect(r).toEqual({
      ok: false,
      outcome: 'failed',
      description:
        'threads_publish: fake error 429 (code 4) (a 429 on the publish call is not sent again; ' +
        'the publish step stays recorded, this key is not sent again)',
      retryAfterS: 1,
    });
    expect(waits).toEqual([]);
    expect(fake.sent('publish')).toHaveLength(1);
    expect(steps.get(KEY)?.step).toBe('publish');
    await retrySendsNothing(adapter);
    expect(fake.posts).toHaveLength(1);
  });

  it('by default a refused connection is still sent again (it never left)', async () => {
    const { adapter } = rig(fake, { fetch: neverSent('ECONNREFUSED', 1) });
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(fake.posts).toHaveLength(1);
  });

  it('the outcome handed to the caller has the contract shape only', async () => {
    fake.queue('publish', { status: 400, error: { message: 'Not allowed', code: 10 } });
    const { adapter } = rig(fake);
    expect(Object.keys(await adapter.publish(input())).sort()).toEqual([
      'description',
      'ok',
      'outcome',
    ]);
  });
});

describe('the container step is not affected: it is invisible and may always be repeated', () => {
  it.each(['EHOSTUNREACH', 'ENETUNREACH'])('%s on the container call is retried', async (code) => {
    let first = true;
    const once: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname.endsWith('/threads') && first) {
        first = false;
        throw transportError(code);
      }
      return fetch(url, init);
    };
    const { adapter } = rig(fake, { fetch: once });
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(fake.posts).toHaveLength(1);
  });

  it('a transient 4xx on the container call is a plain refusal (nothing is public)', async () => {
    fake.queue('container', { status: 400, error: { message: 'Try again', code: 2 } });
    const { adapter } = rig(fake);
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'refused' });
    expect(fake.sent('publish')).toHaveLength(0);
  });
});
