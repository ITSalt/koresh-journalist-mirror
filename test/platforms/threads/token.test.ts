import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createThreadsClient } from '../../../src/platforms/threads/client.js';
import {
  createMemoryTokenStore,
  type TokenStore,
} from '../../../src/platforms/threads/token-store.js';
import { FakeThreads } from '../../support/fake-threads.js';
import { input, NOW, rig, TOKEN } from './helpers.js';

const DAY_MS = 24 * 3600 * 1000;
const NEW_TOKEN = 'THMARKER0refreshed0token0for0tests0yyyyyyyyyyyy';
const at = (ms: number) => new Date(NOW.getTime() + ms);

let fake: FakeThreads;
beforeEach(async () => {
  fake = await new FakeThreads(TOKEN).start();
  fake.now = () => NOW;
  fake.tokenIssuedAt = at(-11 * DAY_MS);
  fake.tokenExpiresAt = at(49 * DAY_MS);
  fake.nextTokens.push(NEW_TOKEN);
});
afterEach(async () => {
  await fake.stop();
});

describe('token store', () => {
  it('the in-memory store keeps the token and expiry it is given', () => {
    const store = createMemoryTokenStore('a');
    store.set('b', '2026-12-11T12:00:00.000Z');
    expect(store.get()).toBe('b');
    expect(store.expiresAt?.()).toBe('2026-12-11T12:00:00.000Z');
  });
});

describe('refreshToken', () => {
  it('happy path: asks for a refreshed token, stores it with its expiry, uses it from then on', async () => {
    const { adapter, tokens } = rig(fake);
    const r = await adapter.refreshToken();

    const expiresAt = at(60 * DAY_MS).toISOString();
    expect(r).toEqual({ ok: true, result: { expiresAt } });
    expect(fake.sent('refresh')).toHaveLength(1);
    expect(fake.sent('refresh')[0]).toMatchObject({
      method: 'GET',
      path: '/refresh_access_token',
      params: { grant_type: 'th_refresh_token' },
      tokenOk: true,
    });
    expect(tokens.get()).toBe(NEW_TOKEN);
    expect(tokens.expiresAt?.()).toBe(expiresAt);

    // The fake now accepts the new token only: the next publish must carry it.
    expect((await adapter.publish(input())).ok).toBe(true);
    expect(fake.requests.at(-1)!.tokenOk).toBe(true);
    expect((await adapter.health()).tokenExpiresAt).toBe(expiresAt);
  });

  it('the result holds the expiry, never the token', async () => {
    const { adapter } = rig(fake);
    const text = JSON.stringify(await adapter.refreshToken());
    expect(text).not.toContain(NEW_TOKEN);
    expect(text).not.toContain(TOKEN);
  });

  it('the client function returns the new token and its expiry', async () => {
    const client = createThreadsClient({
      token: () => TOKEN,
      baseUrl: fake.baseUrl,
      now: () => NOW,
    });
    expect(await client.refreshAccessToken()).toEqual({
      ok: true,
      result: { token: NEW_TOKEN, expiresAt: at(60 * DAY_MS).toISOString() },
    });
  });

  it('a token younger than 24 h is refused by the platform: `refused`, not retried, store unchanged', async () => {
    fake.tokenIssuedAt = at(-2 * 3600 * 1000);
    const { adapter, tokens, waits } = rig(fake);
    const r = await adapter.refreshToken();
    expect(r).toEqual({
      ok: false,
      outcome: 'refused',
      description: 'refresh_access_token: The access token is too young to be refreshed. (code 10)',
    });
    expect(fake.sent('refresh')).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(tokens.get()).toBe(TOKEN);
    expect(tokens.expiresAt?.()).toBeUndefined();
  });

  it('a token known to be younger than 24 h is refused without a call', async () => {
    // Issued 2 h ago, so it expires in 60 days minus 2 h.
    const expiresAt = at(60 * DAY_MS - 2 * 3600 * 1000).toISOString();
    const { adapter, tokens } = rig(fake, { tokens: createMemoryTokenStore(TOKEN, expiresAt) });
    const r = await adapter.refreshToken();
    expect(r).toEqual({
      ok: false,
      outcome: 'refused',
      description: `token_too_young: the token is younger than 24 h, it can be refreshed from ${at(22 * 3600 * 1000).toISOString()}`,
      retryAfterS: 22 * 3600,
    });
    expect(fake.requests).toHaveLength(0);
    expect(tokens.get()).toBe(TOKEN);
  });

  it('exactly 24 h old is old enough: the call is made', async () => {
    fake.tokenIssuedAt = at(-DAY_MS);
    const expiresAt = at(59 * DAY_MS).toISOString();
    const { adapter } = rig(fake, { tokens: createMemoryTokenStore(TOKEN, expiresAt) });
    expect((await adapter.refreshToken()).ok).toBe(true);
    expect(fake.sent('refresh')).toHaveLength(1);
  });

  it('a token known to be expired is refused without a call', async () => {
    const expiresAt = at(-1000).toISOString();
    const { adapter } = rig(fake, { tokens: createMemoryTokenStore(TOKEN, expiresAt) });
    const r = await adapter.refreshToken();
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(r.ok ? '' : r.description).toMatch(/^token_expired: /);
    expect(fake.requests).toHaveLength(0);
  });

  it('a token the platform reports as expired is `refused` with token_invalid', async () => {
    fake.tokenExpiresAt = at(-1000);
    const { adapter, tokens } = rig(fake);
    const r = await adapter.refreshToken();
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(r.ok ? '' : r.description).toMatch(/^token_invalid: refresh_access_token: .*code 190/);
    expect(tokens.get()).toBe(TOKEN);
  });

  it('a 5xx is retried', async () => {
    fake.queue('refresh', { status: 502 });
    const { adapter, tokens, waits } = rig(fake);
    expect((await adapter.refreshToken()).ok).toBe(true);
    expect(waits).toEqual([1000]);
    expect(tokens.get()).toBe(NEW_TOKEN);
  });

  it('a lost answer is `unknown` and not resent; the old token stays in the store', async () => {
    fake.queue('refresh', { drop: true, applied: false });
    const { adapter, tokens } = rig(fake);
    expect(await adapter.refreshToken()).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('refresh')).toHaveLength(1);
    expect(tokens.get()).toBe(TOKEN);
  });

  it('an answer without a token or an expiry is `unknown`; nothing is stored', async () => {
    fake.queue('refresh', { raw: '{"token_type":"bearer"}', applied: false });
    const { adapter, tokens } = rig(fake);
    expect(await adapter.refreshToken()).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(tokens.get()).toBe(TOKEN);
  });

  it('a store that cannot keep the new token: `failed`, and the new token is not in the description', async () => {
    const store: TokenStore = {
      get: () => TOKEN,
      set(token) {
        throw new Error(`cannot write ${token}`);
      },
    };
    const { adapter } = rig(fake, { tokens: store });
    const r = await adapter.refreshToken();
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(r.ok ? '' : r.description).toMatch(/^token_store_error: /);
    expect(JSON.stringify(r)).not.toContain(NEW_TOKEN);
  });
});
