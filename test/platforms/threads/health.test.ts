import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryTokenStore } from '../../../src/platforms/threads/token-store.js';
import { FakeThreads } from '../../support/fake-threads.js';
import { NOW, rig, TOKEN } from './helpers.js';

let fake: FakeThreads;
beforeEach(async () => {
  fake = await new FakeThreads(TOKEN).start();
  fake.quotaUsage = 3;
});
afterEach(async () => {
  await fake.stop();
});

const EXPIRES = '2026-12-11T12:00:00.000Z';
const withExpiry = (expiresAt = EXPIRES) => ({ tokens: createMemoryTokenStore(TOKEN, expiresAt) });

describe('health', () => {
  it('reads the profile and the quota and reports the token expiry', async () => {
    const { adapter } = rig(fake, withExpiry());
    expect(await adapter.health()).toEqual({
      ok: true,
      detail: `profile ok (@fake_profile); quota 3/250; token expires ${EXPIRES}`,
      tokenExpiresAt: EXPIRES,
    });
    expect(fake.ops().sort()).toEqual(['me', 'quota']);
    expect(fake.sent('me')[0]).toMatchObject({
      path: '/v1.0/me',
      params: { fields: 'id,username' },
    });
    expect(fake.sent('quota')[0]).toMatchObject({
      path: '/v1.0/me/threads_publishing_limit',
      params: { fields: 'quota_usage,config' },
    });
  });

  it('an env token has no known expiry until the first refresh', async () => {
    const { adapter } = rig(fake);
    expect(await adapter.health()).toEqual({
      ok: true,
      detail:
        'profile ok (@fake_profile); quota 3/250; token expiry unknown until the first refresh',
    });
  });

  it('an exhausted quota is not healthy', async () => {
    fake.quotaUsage = 250;
    const { adapter } = rig(fake, withExpiry());
    const h = await adapter.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('quota 250/250 exhausted');
  });

  it('an expired token is not healthy', async () => {
    const expired = new Date(NOW.getTime() - 1000).toISOString();
    const { adapter } = rig(fake, withExpiry(expired));
    const h = await adapter.health();
    expect(h).toMatchObject({ ok: false, tokenExpiresAt: expired });
    expect(h.detail).toContain(`token expired ${expired}`);
  });

  it('a token the platform refuses is not healthy and says token_invalid', async () => {
    fake.token = 'another-token-the-adapter-does-not-have';
    const { adapter } = rig(fake, withExpiry());
    const h = await adapter.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('profile: token_invalid: me: ');
    expect(h.detail).toContain('quota: token_invalid: threads_publishing_limit: ');
  });

  it('a failing profile read is not healthy, even with the quota and the token in order', async () => {
    fake.queue('me', { status: 500 });
    const { adapter } = rig(fake, withExpiry());
    const h = await adapter.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toBe(
      `profile: me: fake error 500 (code 1) (gave up after 1 attempts); quota 3/250; token expires ${EXPIRES}`,
    );
  });

  it('an unreadable quota is not healthy; the profile part still shows', async () => {
    fake.queue('quota', { status: 500 });
    const { adapter } = rig(fake, withExpiry());
    const h = await adapter.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('profile ok (@fake_profile); quota: threads_publishing_limit: ');
  });

  it('a store whose expiry cannot be read or is not a date: reported as unknown, no throw', async () => {
    const broken = {
      get: () => TOKEN,
      set() {},
      expiresAt(): string {
        throw new Error('db is locked');
      },
    };
    expect((await rig(fake, { tokens: broken }).adapter.health()).detail).toContain(
      'token expiry unknown',
    );
    const odd = createMemoryTokenStore(TOKEN, 'soon');
    const h = await rig(fake, { tokens: odd }).adapter.health();
    expect(h.detail).toContain('token expiry unknown');
    expect(h.tokenExpiresAt).toBeUndefined();
  });

  it('is quick: one attempt per read, no waiting', async () => {
    fake.queue('me', { status: 500 });
    fake.queue('quota', { status: 429, retryAfter: 30 });
    const { adapter, waits } = rig(fake);
    expect((await adapter.health()).ok).toBe(false);
    expect(fake.requests).toHaveLength(2);
    expect(waits).toEqual([]);
  });

  it('never throws and never publishes: an unreachable platform is a `false`', async () => {
    const base = fake.baseUrl;
    await fake.stop();
    const { adapter } = rig(fake, { baseUrl: base });
    const h = await adapter.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/^profile: me: /);
    fake = await new FakeThreads(TOKEN).start(); // for afterEach
  });
});
