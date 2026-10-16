import { afterEach, describe, expect, it } from 'vitest';
import { THREADS_REFRESH_EVERY_MS, THREADS_REFRESH_RETRY_MS } from '../../src/connect/service.js';
import { BEARER, connectNow, harness, type Harness } from './helpers.js';

// WP-PLAT-06 acceptance 5 (Threads refresh) and scope 3 (LinkedIn expiry reminder states).
// The refresh call itself is the adapter's `refreshToken`; here: when it runs, and that the
// stored token changes only when it succeeded (decision D-3: a failed refresh keeps the old one).

const DAY = 86_400_000;
const made: Harness[] = [];
async function setup(o: Parameters<typeof harness>[0] = {}) {
  const h = await harness(o);
  made.push(h);
  return h;
}
afterEach(async () => {
  for (const h of made.splice(0).reverse()) await h.close();
});

const stored = (h: Harness) => h.connect.tokenStore('threads').get();
const overview = async (h: Harness) =>
  (await h.app.inject({ method: 'GET', url: '/v1/connect', headers: BEARER })).json();
const kinds = (h: Harness) => h.store.alerts.list().map((a) => a.kind);

describe('Threads token refresh', () => {
  it('is weekly: not before 7 days, then once, then not again for 7 days', async () => {
    const h = await setup();
    const { token } = await connectNow(h, 'threads');
    for (const ms of [0, 3_600_000, DAY, 5 * DAY - 3_600_000, DAY - 1]) {
      h.advance(ms);
      await h.connect.tick();
    }
    // 7 days minus one millisecond after the connect: nothing was asked.
    expect(h.threads.sent('refresh')).toHaveLength(0);
    expect(stored(h)).toBe(token);

    h.advance(1);
    await h.connect.tick();
    expect(h.threads.sent('refresh')).toHaveLength(1);
    const fresh = h.threads.token;
    expect(fresh).not.toBe(token);
    expect(stored(h)).toBe(fresh);
    const o = (await overview(h)).threads;
    expect(o.lastRefreshAt).toBe(h.now().toISOString());
    expect(o.tokenExpiresAt).toBe(new Date(h.now().getTime() + 60 * DAY).toISOString());
    expect(o.lastError).toBeUndefined();
    // Neither token is in the file in clear, and the old one is gone.
    expect(h.dbBytes()).not.toContain(token);
    expect(h.dbBytes()).not.toContain(fresh);

    for (let i = 0; i < 6; i++) {
      h.advance(DAY);
      await h.connect.tick();
    }
    expect(h.threads.sent('refresh')).toHaveLength(1);
    h.advance(DAY);
    await h.connect.tick();
    expect(h.threads.sent('refresh')).toHaveLength(2);
    expect(kinds(h)).toEqual(['platform_connected']);
  });

  it('a token younger than 24 h is not refreshed (the adapter refuses without a call)', async () => {
    const h = await setup();
    const { token } = await connectNow(h, 'threads');
    // The row says "never refreshed for 8 days", but the token itself was issued an hour ago.
    h.store.db
      .prepare(
        "UPDATE platform_tokens SET connected_at = ?, expires_at = ? WHERE platform = 'threads'",
      )
      .run(
        new Date(h.now().getTime() - 8 * DAY).toISOString(),
        new Date(h.now().getTime() + 60 * DAY - 3_600_000).toISOString(),
      );
    await h.connect.tick();
    expect(h.threads.sent('refresh')).toHaveLength(0);
    expect(stored(h)).toBe(token);
    expect((await overview(h)).threads.lastError).toContain('token_too_young');
  });

  it.each([
    ['a 400 from the platform', { status: 400, body: { error: { message: 'no', code: 10 } } }],
    ['a 500', { status: 500 }],
    ['no answer', { hang: true }],
    ['a dropped connection', { drop: true }],
    ['an answer without a token', { status: 200, body: { token_type: 'bearer' } }],
  ] as const)(
    '%s: the old token stays, an alert is written, the next try is a day later',
    async (_n, reply) => {
      const h = await setup();
      const { token } = await connectNow(h, 'threads');
      const before = h.store.connect.tokens.get('threads');
      h.advance(THREADS_REFRESH_EVERY_MS);
      // The adapter retries a 5xx on this call (it publishes nothing): fail every attempt.
      h.threads.queue('refresh', reply, reply, reply, reply, reply, reply);
      await h.connect.tick();
      expect(h.threads.sent('refresh').length).toBeGreaterThan(0);
      expect(stored(h)).toBe(token);
      expect(h.store.connect.tokens.get('threads')).toEqual(before);
      expect(kinds(h)).toEqual(['platform_connected', 'platform_refresh_failed']);
      const alert = h.store.alerts.list()[1]!.message;
      expect(alert).toContain('threads token refresh failed, the stored token stays');
      expect(alert).not.toContain(token);
      const o = (await overview(h)).threads;
      expect(o.connected).toBe(true);
      expect(o.lastError).toContain('refresh_failed');
      expect(o.lastRefreshAt).toBeUndefined();

      // Hourly ticks do not hammer the platform or the alerts.
      const calls = h.threads.sent('refresh').length;
      h.advance(THREADS_REFRESH_RETRY_MS - 1);
      await h.connect.tick();
      expect(h.threads.sent('refresh')).toHaveLength(calls);
      expect(kinds(h)).toHaveLength(2);
    },
  );

  it('a failed refresh is tried again the next day and then succeeds', async () => {
    const h = await setup();
    const { token } = await connectNow(h, 'threads');
    h.advance(THREADS_REFRESH_EVERY_MS);
    h.threads.queue('refresh', { status: 400, body: { error: { message: 'no', code: 10 } } });
    await h.connect.tick();
    expect(stored(h)).toBe(token);
    h.advance(THREADS_REFRESH_RETRY_MS);
    await h.connect.tick();
    expect(stored(h)).toBe(h.threads.token);
    expect(stored(h)).not.toBe(token);
    expect((await overview(h)).threads.lastError).toBeUndefined();
  });

  it('a restart keeps the refreshed token', async () => {
    const h = await setup();
    const { token } = await connectNow(h, 'threads');
    h.advance(THREADS_REFRESH_EVERY_MS);
    await h.connect.tick();
    const fresh = h.threads.token;
    expect(fresh).not.toBe(token);

    const again = await h.reopen();
    made.push(again);
    expect(stored(again)).toBe(fresh);
    const o = (await overview(again)).threads;
    expect(o).toMatchObject({ connected: true, account: { name: 'fake_profile' } });
    expect(o.lastRefreshAt).toBe(h.now().toISOString());
    // And it is not refreshed again just because the process is new.
    await again.connect.tick();
    expect(again.threads.sent('refresh')).toHaveLength(1);
  });

  it('nothing is asked while Threads is not connected, and LinkedIn is never refreshed', async () => {
    const h = await setup();
    await connectNow(h, 'linkedin');
    h.advance(30 * DAY);
    await h.connect.tick();
    expect(h.threads.requests).toHaveLength(0);
    expect(h.linkedin.ops()).toEqual(['token', 'userinfo']);
  });

  it('overlapping ticks make one refresh call', async () => {
    const h = await setup();
    await connectNow(h, 'threads');
    h.advance(THREADS_REFRESH_EVERY_MS);
    await Promise.all([h.connect.tick(), h.connect.tick(), h.connect.tick()]);
    expect(h.threads.sent('refresh')).toHaveLength(1);
  });
});

describe('LinkedIn expiry reminder', () => {
  it('7 days, 1 day, expired: one alert per state, and the state is in GET /v1/connect', async () => {
    const h = await setup();
    await connectNow(h, 'linkedin');
    const expiresAt = (await overview(h)).linkedin.tokenExpiresAt as string;
    const state = async () => (await overview(h)).linkedin.reminder;
    const tickTwice = async () => {
      await h.connect.tick();
      await h.connect.tick();
    };
    await tickTwice();
    expect(await state()).toBe('none');
    expect(kinds(h)).toEqual(['platform_connected']);

    h.advance(53 * DAY - 1000);
    await tickTwice();
    expect(await state()).toBe('none');
    expect(kinds(h)).toHaveLength(1);

    h.advance(1000);
    await tickTwice();
    expect(await state()).toBe('in_7_days');
    expect(kinds(h)).toEqual(['platform_connected', 'platform_token_expiring']);
    expect(h.store.alerts.list()[1]!.message).toBe(
      `linkedin token expires ${expiresAt} (in_7_days): send the owner a fresh link from POST /v1/connect/linkedin/start`,
    );

    h.advance(6 * DAY);
    await tickTwice();
    expect(await state()).toBe('in_1_day');
    expect(kinds(h)).toHaveLength(3);

    h.advance(DAY);
    await tickTwice();
    expect(await state()).toBe('expired');
    expect(kinds(h)).toHaveLength(4);
    expect(h.store.alerts.list()[3]!.message).toContain(`linkedin token expired ${expiresAt}`);

    // The owner opens the fresh link: the reminder starts over.
    await connectNow(h, 'linkedin');
    await tickTwice();
    expect(await state()).toBe('none');
    expect(kinds(h)).toEqual([
      'platform_connected',
      'platform_token_expiring',
      'platform_token_expiring',
      'platform_token_expiring',
      'platform_connected',
    ]);
    // The link for the owner still comes from the same route, with the same three scopes.
    const { url } = await h.start('linkedin');
    expect(new URL(url).searchParams.get('scope')).toBe('openid profile w_member_social');
  });

  it('tick removes states that ended more than a day ago, and only those', async () => {
    const h = await setup();
    await h.start('threads');
    h.advance(DAY);
    await h.start('linkedin');
    h.advance(31 * 60_000);
    await h.connect.tick();
    expect(h.store.db.prepare('SELECT platform FROM oauth_states').all()).toEqual([
      { platform: 'linkedin' },
    ]);
  });
});
