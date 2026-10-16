import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryStepStore,
  type PublishStep,
  type PublishStepStore,
} from '../../../src/platforms/threads/step-store.js';
import { FakeThreads } from '../../support/fake-threads.js';
import { input, KEY, NOW, rig, TOKEN, writes } from './helpers.js';

let fake: FakeThreads;
beforeEach(async () => {
  fake = await new FakeThreads(TOKEN).start();
});
afterEach(async () => {
  await fake.stop();
});

const THUMB = String.fromCodePoint(0x1f44d);

describe('publish: the happy path', () => {
  it('creates a container, then publishes it: two write calls in order, one public post', async () => {
    const { adapter, steps } = rig(fake);
    const r = await adapter.publish(input());

    expect(fake.ops()).toEqual(['quota', 'container', 'publish', 'permalink']);
    expect(writes(fake)).toEqual(['container', 'publish']);
    const [containerId] = [...fake.containers.keys()];
    expect(fake.sent('container')[0]).toMatchObject({
      method: 'POST',
      path: '/v1.0/me/threads',
      params: { media_type: 'TEXT', text: input().text },
      tokenOk: true,
      tokenIn: 'query',
    });
    expect(fake.sent('publish')[0]).toMatchObject({
      method: 'POST',
      path: '/v1.0/me/threads_publish',
      params: { creation_id: containerId },
      tokenOk: true,
    });
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]).toMatchObject({ containerId, text: input().text });
    expect(r).toEqual({
      ok: true,
      result: { id: fake.posts[0]!.id, url: fake.posts[0]!.permalink },
    });
    expect(steps.get(KEY)).toEqual({ step: 'publish', containerId, at: NOW.toISOString() });
  });

  it('sends the text as it is and nothing else: `link` does not travel', async () => {
    const { adapter } = rig(fake);
    const text = `Утро.\nКто первый? ${THUMB}`;
    await adapter.publish(input({ text, link: 'https://t.me/Channel1/57' }));
    expect(fake.sent('container')[0]!.params).toEqual({ media_type: 'TEXT', text });
    expect(fake.posts[0]!.text).toBe(text);
  });

  it('a configured user id replaces `me` in the paths', async () => {
    const { adapter } = rig(fake, { userId: fake.userId });
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(fake.sent('container')[0]!.path).toBe(`/v1.0/${fake.userId}/threads`);
    expect(fake.sent('publish')[0]!.path).toBe(`/v1.0/${fake.userId}/threads_publish`);
  });

  it('waits between the two calls when a publish delay is configured', async () => {
    const { adapter, waits } = rig(fake, { publishDelayMs: 30_000 });
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(waits).toEqual([30_000]);
  });

  it('the post is public even when its URL cannot be read: ok without `url`', async () => {
    fake.queue('permalink', { status: 500 }, { status: 500 }, { status: 500 });
    const { adapter } = rig(fake);
    const r = await adapter.publish(input());
    expect(r).toEqual({ ok: true, result: { id: fake.posts[0]!.id } });
    expect(fake.sent('permalink')).toHaveLength(3);
    expect(fake.sent('publish')).toHaveLength(1);
  });

  it('a refused URL read does not turn a published post into a failure', async () => {
    fake.queue('permalink', { status: 400, error: { message: 'no', code: 190 } });
    const { adapter } = rig(fake);
    expect(await adapter.publish(input())).toEqual({ ok: true, result: { id: fake.posts[0]!.id } });
  });
});

describe('publish: validation comes first', () => {
  it('a text over the limit is refused with no request at all', async () => {
    const { adapter } = rig(fake);
    const r = await adapter.publish(input({ text: 'x'.repeat(501) }));
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(r.ok ? '' : r.description).toMatch(/^invalid_input: too_long /);
    expect(fake.requests).toHaveLength(0);
  });

  it('the limit is R1: 498 characters that count 501 are refused, though the platform fake would take them', async () => {
    const { adapter } = rig(fake);
    const r = await adapter.publish(input({ text: 'x'.repeat(497) + THUMB }));
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(fake.requests).toHaveLength(0);
    expect(fake.posts).toHaveLength(0);
  });

  it('an empty text and more than 5 links are refused with no request', async () => {
    const { adapter } = rig(fake);
    const links = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`).join(' ');
    expect(await adapter.publish(input({ text: ' ' }))).toMatchObject({ outcome: 'refused' });
    expect(await adapter.publish(input({ text: links }))).toMatchObject({ outcome: 'refused' });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('publish: step 1, the container (invisible, safe to repeat)', () => {
  it('a 5xx is retried with backoff, then the post is published once', async () => {
    fake.queue('container', { status: 500 }, { status: 503 });
    const { adapter, waits } = rig(fake);
    const r = await adapter.publish(input());
    expect(r.ok).toBe(true);
    expect(waits).toEqual([1000, 2000]);
    expect(fake.sent('container')).toHaveLength(3);
    expect(fake.sent('publish')).toHaveLength(1);
    expect(fake.posts).toHaveLength(1);
  });

  it('a 429 waits for Retry-After', async () => {
    fake.queue('container', { status: 429, retryAfter: 7 });
    const { adapter, waits } = rig(fake);
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(waits).toEqual([7000]);
  });

  it('a 429 without Retry-After backs off like a 5xx', async () => {
    fake.queue('container', { status: 429 }, { status: 429 });
    const { adapter, waits } = rig(fake);
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(waits).toEqual([1000, 2000]);
  });

  it('a lost answer is retried: the first container stays unpublished, one post', async () => {
    fake.queue('container', { drop: true });
    const { adapter } = rig(fake);
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(fake.containers.size).toBe(2);
    expect([...fake.containers.values()].map((c) => c.published)).toEqual([false, true]);
    expect(fake.posts).toHaveLength(1);
  });

  it('retries exhausted: `failed`, no publish call, nothing recorded, so the item can start over', async () => {
    fake.queue('container', { status: 500 }, { status: 500 }, { status: 500 });
    const { adapter, steps } = rig(fake, { retry: { maxAttempts: 3 } });
    const r = await adapter.publish(input());
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(r.ok ? '' : r.description).toContain('gave up after 3 attempts');
    expect(fake.sent('publish')).toHaveLength(0);
    expect(steps.get(KEY)).toBeUndefined();

    const again = await adapter.publish(input());
    expect(again.ok).toBe(true);
    expect(fake.posts).toHaveLength(1);
  });

  it('a 429 whose Retry-After exceeds the wait budget is `failed` with retryAfterS', async () => {
    fake.queue('container', { status: 429, retryAfter: 600 });
    const { adapter, waits } = rig(fake);
    expect(await adapter.publish(input())).toMatchObject({
      ok: false,
      outcome: 'failed',
      retryAfterS: 600,
    });
    expect(waits).toEqual([]);
    expect(fake.sent('publish')).toHaveLength(0);
  });

  it('a 4xx is `refused` and never retried', async () => {
    fake.queue('container', { status: 400, error: { message: 'Param text is bad', code: 100 } });
    const { adapter, waits } = rig(fake);
    expect(await adapter.publish(input())).toEqual({
      ok: false,
      outcome: 'refused',
      description: 'threads: Param text is bad (code 100)',
    });
    expect(waits).toEqual([]);
    expect(fake.sent('container')).toHaveLength(1);
    expect(fake.sent('publish')).toHaveLength(0);
  });

  it('an answer without a container id never leads to a publish call', async () => {
    fake.queue('container', { raw: '{}', applied: false }, { raw: '{"id":""}', applied: false });
    const { adapter } = rig(fake, { retry: { maxAttempts: 2 } });
    const r = await adapter.publish(input());
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(fake.sent('publish')).toHaveLength(0);
    expect(fake.posts).toHaveLength(0);
  });
});

describe('publish: step 2, the public call', () => {
  it('a timeout after the request left is `unknown`; there is no second publish call', async () => {
    fake.queue('publish', { hang: true });
    const { adapter, waits } = rig(fake, { timeoutMs: 200 });
    const r = await adapter.publish(input());
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('publish')).toHaveLength(1);
    expect(waits).toEqual([]);
    // The fake did publish it: this is why the call must never be sent again.
    expect(fake.posts).toHaveLength(1);
  });

  it('a closed socket after the request left is `unknown`, no retry', async () => {
    fake.queue('publish', { drop: true });
    const { adapter } = rig(fake);
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('publish')).toHaveLength(1);
    expect(fake.posts).toHaveLength(1);
  });

  it('a 5xx after the request was accepted is `unknown`, not retried', async () => {
    fake.queue('publish', { status: 500 });
    const { adapter, waits } = rig(fake);
    const r = await adapter.publish(input());
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(r.ok ? '' : r.description).toContain('HTTP 500 after the request was received');
    expect(fake.sent('publish')).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('an unreadable 2xx is `unknown` (the post is public), no retry', async () => {
    fake.queue('publish', { raw: '<html>ok</html>' });
    const { adapter } = rig(fake);
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('publish')).toHaveLength(1);
    expect(fake.posts).toHaveLength(1);
  });

  it('a 2xx without a post id is `unknown`', async () => {
    fake.queue('publish', { raw: '{"success":true}' });
    const { adapter } = rig(fake);
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('publish')).toHaveLength(1);
  });

  it('after an `unknown` the same key is never sent again: no request of any kind', async () => {
    fake.queue('publish', { hang: true });
    const { adapter, steps } = rig(fake, { timeoutMs: 200 });
    await adapter.publish(input());
    const before = fake.requests.length;

    const again = await adapter.publish(input());
    expect(again).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(again.ok ? '' : again.description).toMatch(/^publish_already_started: /);
    expect(fake.requests).toHaveLength(before);
    expect(fake.posts).toHaveLength(1);
    expect(steps.get(KEY)?.step).toBe('publish');
  });

  it('after a success the same key is not published a second time either', async () => {
    const { adapter } = rig(fake);
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.posts).toHaveLength(1);
    expect(fake.sent('container')).toHaveLength(1);
  });

  it('a 429 is not sent again by default: `failed` after one request', async () => {
    fake.queue('publish', { status: 429, retryAfter: 2 });
    const { adapter, waits } = rig(fake);
    expect(await adapter.publish(input())).toMatchObject({
      ok: false,
      outcome: 'failed',
      retryAfterS: 2,
    });
    expect(waits).toEqual([]);
    expect(fake.sent('publish')).toHaveLength(1);
    expect(fake.posts).toHaveLength(0);
  });

  it('with resendPublishAfter429 on, a first 429 is sent once more after Retry-After, one post', async () => {
    fake.queue('publish', { status: 429, retryAfter: 2 });
    const { adapter, waits } = rig(fake, { resendPublishAfter429: true });
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(waits).toEqual([2000]);
    expect(fake.sent('publish')).toHaveLength(2);
    expect(fake.posts).toHaveLength(1);
  });

  it('a refused connection means "never sent": it is retried, one post', async () => {
    let refuse = 1;
    const refusing: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname.endsWith('/threads_publish') && refuse-- > 0) {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        });
      }
      return fetch(url, init);
    };
    const { adapter, waits } = rig(fake, { fetch: refusing });
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(waits).toEqual([1000]);
    expect(fake.posts).toHaveLength(1);
  });

  it('a 4xx is `refused`: not retried, and the item goes back to step 1', async () => {
    fake.queue('publish', { status: 400, error: { message: 'Not allowed', code: 10 } });
    const { adapter, steps } = rig(fake);
    expect(await adapter.publish(input())).toEqual({
      ok: false,
      outcome: 'refused',
      description: 'threads_publish: Not allowed (code 10)',
    });
    expect(fake.sent('publish')).toHaveLength(1);
    expect(fake.posts).toHaveLength(0);
    expect(steps.get(KEY)?.step).toBe('container');

    // The caller may try again: a fresh container, exactly one post.
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(fake.containers.size).toBe(2);
    expect(fake.posts).toHaveLength(1);
  });

  it('a redirect is not followed (the token would travel with it): `unknown`', async () => {
    fake.queue('publish', {
      raw: '',
      rawStatus: 302,
      headers: { location: `${fake.baseUrl}/v1.0/me` },
      applied: false,
    });
    const { adapter } = rig(fake);
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('me')).toHaveLength(0);
  });
});

describe('publish: the two recorded steps', () => {
  /** A store that sees every record and can fail at a chosen step. */
  function recorder(failAt?: PublishStep['step']) {
    const inner = createMemoryStepStore();
    const log: string[] = [];
    const store: PublishStepStore = {
      get: (key) => inner.get(key),
      set(key, step) {
        log.push(`${step.step}@${fake.ops().filter((o) => o === 'publish').length}`);
        if (step.step === failAt) throw new Error('disk full');
        inner.set(key, step);
      },
    };
    return { store, log, inner };
  }

  it('records the container after it exists and the publish step BEFORE the request leaves', async () => {
    const { store, log } = recorder();
    let stepWhenPublishArrived: string | undefined;
    fake.onRequest = (r) => {
      if (r.op === 'publish') stepWhenPublishArrived = store.get(KEY)?.step;
    };
    const { adapter } = rig(fake, { steps: store });
    expect((await adapter.publish(input())).ok).toBe(true);
    // `publish@0`: recorded while the fake had seen no publish request yet.
    expect(log).toEqual(['container@0', 'publish@0']);
    expect(stepWhenPublishArrived).toBe('publish');
  });

  it('if the publish step cannot be recorded, the publish request is not sent', async () => {
    const { store } = recorder('publish');
    const { adapter } = rig(fake, { steps: store });
    const r = await adapter.publish(input());
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(r.ok ? '' : r.description).toMatch(/^step_store_error: step publish was not recorded/);
    expect(fake.sent('publish')).toHaveLength(0);
    expect(fake.posts).toHaveLength(0);
  });

  it('if the container step cannot be recorded, nothing is published', async () => {
    const { store } = recorder('container');
    const { adapter } = rig(fake, { steps: store });
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'failed' });
    expect(fake.sent('publish')).toHaveLength(0);
  });

  it('if the steps cannot be read, nothing is sent at all', async () => {
    const store: PublishStepStore = {
      get() {
        throw new Error('db is locked');
      },
      set() {},
    };
    const { adapter } = rig(fake, { steps: store });
    const r = await adapter.publish(input());
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(r.ok ? '' : r.description).toMatch(/^step_store_error: read failed/);
    expect(fake.requests).toHaveLength(0);
  });

  it('a restart between the two steps: a fresh container, the old one is never published, one post', async () => {
    // First process: the container exists and is recorded, then the process is gone before the
    // publish step (modelled by a store that fails exactly there).
    const first = recorder('publish');
    await rig(fake, { steps: first.store }).adapter.publish(input());
    const old = first.inner.get(KEY)!;
    expect(old.step).toBe('container');
    expect(fake.posts).toHaveLength(0);

    // Second process: a new adapter over the same records.
    const { adapter } = rig(fake, { steps: first.inner });
    const r = await adapter.publish(input());
    expect(r.ok).toBe(true);
    expect(fake.containers.size).toBe(2);
    expect(fake.containers.get(old.containerId)!.published).toBe(false);
    expect(fake.sent('publish')).toHaveLength(1);
    expect(fake.sent('publish')[0]!.params.creation_id).not.toBe(old.containerId);
    expect(fake.posts).toHaveLength(1);
  });

  it('a restart after the publish step was recorded: nothing is sent, `unknown`', async () => {
    const steps = createMemoryStepStore();
    steps.set(KEY, { step: 'publish', containerId: '17900001', at: '2026-10-12T11:59:00.000Z' });
    const { adapter } = rig(fake, { steps });
    const r = await adapter.publish(input());
    expect(r).toEqual({
      ok: false,
      outcome: 'unknown',
      description:
        'publish_already_started: a publish request for this key was started at ' +
        '2026-10-12T11:59:00.000Z (container 17900001); it is never sent again',
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('a record it does not understand is treated as a started publish: nothing is sent', async () => {
    const steps = createMemoryStepStore();
    steps.set(KEY, { step: 'sent', containerId: 'x', at: 'y' } as unknown as PublishStep);
    const { adapter } = rig(fake, { steps });
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.requests).toHaveLength(0);
  });

  it('two overlapping calls for one key: one post, the second call sends nothing', async () => {
    const { adapter } = rig(fake);
    const [a, b] = await Promise.all([adapter.publish(input()), adapter.publish(input())]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({
      ok: false,
      outcome: 'unknown',
      description:
        'publish_in_progress: another publish for this key is running; this call sent nothing',
    });
    expect(fake.containers.size).toBe(1);
    expect(fake.posts).toHaveLength(1);
  });

  it('a failed call frees its key: the next call for it runs', async () => {
    fake.queue('container', { status: 400 });
    const { adapter } = rig(fake);
    expect(await adapter.publish(input())).toMatchObject({ ok: false, outcome: 'refused' });
    expect((await adapter.publish(input())).ok).toBe(true);
  });

  it('other keys are not affected by one key that is blocked', async () => {
    fake.queue('publish', { hang: true });
    const { adapter } = rig(fake, { timeoutMs: 200 });
    await adapter.publish(input());
    const other = await adapter.publish(input({ key: 'threads:2026-10-20:s2:0', text: 'Второй.' }));
    expect(other.ok).toBe(true);
    expect(fake.posts.map((p) => p.text)).toEqual([input().text, 'Второй.']);
  });
});

describe('publish: token errors', () => {
  it('error 190 on the container is `refused` with a token_invalid detail, not retried', async () => {
    fake.queue('container', {
      status: 400,
      error: {
        message: 'Error validating access token: Session has expired',
        code: 190,
        error_subcode: 463,
      },
    });
    const { adapter, waits } = rig(fake);
    expect(await adapter.publish(input())).toEqual({
      ok: false,
      outcome: 'refused',
      description:
        'token_invalid: threads: Error validating access token: Session has expired (code 190, subcode 463)',
    });
    expect(waits).toEqual([]);
    expect(fake.sent('container')).toHaveLength(1);
    expect(fake.sent('publish')).toHaveLength(0);
  });

  it('error 190 on the publish call is `refused` with a token_invalid detail', async () => {
    fake.queue('publish', { status: 400, error: { message: 'Invalid token', code: 190 } });
    const { adapter } = rig(fake);
    const r = await adapter.publish(input());
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(r.ok ? '' : r.description).toMatch(/^token_invalid: threads_publish: /);
    expect(fake.posts).toHaveLength(0);
  });

  it('a token the platform does not accept: one refused container call, no publish call', async () => {
    fake.token = 'another-token-the-adapter-does-not-have';
    const { adapter, waits } = rig(fake);
    const r = await adapter.publish(input());
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(r.ok ? '' : r.description).toMatch(/^token_invalid: threads: /);
    expect(writes(fake)).toEqual(['container']);
    expect(waits).toEqual([]);
  });

  it('an HTTP 401 without an error body is a token error too', async () => {
    fake.queue('container', { raw: 'Unauthorized', rawStatus: 401, applied: false });
    const { adapter } = rig(fake);
    const r = await adapter.publish(input());
    expect(r).toEqual({
      ok: false,
      outcome: 'refused',
      description: 'token_invalid: threads: HTTP 401',
    });
  });

  it('an empty token store sends nothing', async () => {
    const { adapter } = rig(fake, {
      tokens: { get: () => '', set() {} },
    });
    const r = await adapter.publish(input());
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(r.ok ? '' : r.description).toMatch(/^token_invalid: .*no token in the store/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('publish: quota', () => {
  it('an exhausted quota stops the item before anything is created', async () => {
    fake.quotaUsage = 250;
    const { adapter } = rig(fake);
    expect(await adapter.publish(input())).toEqual({
      ok: false,
      outcome: 'failed',
      description: 'quota_exhausted: 250 of 250 posts used, nothing was sent',
    });
    expect(fake.ops()).toEqual(['quota']);
    expect(fake.containers.size).toBe(0);
  });

  it('one post below the limit still goes out', async () => {
    fake.quotaUsage = 249;
    const { adapter } = rig(fake);
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(fake.posts).toHaveLength(1);
  });

  it('an unreadable quota does not stop the post (the platform enforces the limit itself)', async () => {
    fake.queue('quota', { status: 500 });
    const { adapter, waits } = rig(fake);
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(fake.sent('quota')).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('a refused quota read does not stop the post either', async () => {
    fake.queue('quota', { status: 400, error: { message: 'Unsupported get request', code: 100 } });
    const { adapter } = rig(fake);
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(fake.posts).toHaveLength(1);
  });

  it('a quota answer in an unexpected shape does not stop the post', async () => {
    fake.queue('quota', { raw: '{"data":[]}' });
    const { adapter } = rig(fake);
    expect((await adapter.publish(input())).ok).toBe(true);
  });
});
