import { afterEach, describe, expect, it } from 'vitest';
import { BEARER, connectNow, harness, STORE_KEY, type Harness } from './helpers.js';

// WP-PLAT-07, review item L1: a stored token that cannot be decrypted (TOKEN_STORE_KEY changed
// or lost, the row damaged) means nothing can be published on that platform. One alert
// `platform_token_unreadable` when a platform enters that state: per state change, not per tick.

const DAY = 86_400_000;
const OTHER_KEY = Buffer.alloc(32, 0x21).toString('base64');
const made: Harness[] = [];
async function setup(o: Parameters<typeof harness>[0] = {}) {
  const h = await harness(o);
  made.push(h);
  return h;
}
afterEach(async () => {
  for (const h of made.splice(0).reverse()) await h.close();
});

/** A second service over the same database, as after a redeploy with other settings. */
const restart = (h: Harness, env: Record<string, string> = {}) =>
  setup({
    env,
    from: { dbFile: h.dbFile, threads: h.threads, linkedin: h.linkedin, at: h.now() },
  });
const unreadable = (h: Harness) =>
  h.store.alerts.list(1000).filter((a) => a.kind === 'platform_token_unreadable');
const ticks = async (h: Harness, n: number) => {
  for (let i = 0; i < n; i++) await h.connect.tick();
};

describe('a stored token that cannot be read', () => {
  it('one alert per platform when the key was changed, none on the ticks that follow', async () => {
    const h = await setup();
    const threads = await connectNow(h, 'threads');
    const linkedin = await connectNow(h, 'linkedin');
    await ticks(h, 3);
    expect(unreadable(h)).toEqual([]);

    const rekeyed = await restart(h, { TOKEN_STORE_KEY: OTHER_KEY });
    await rekeyed.connect.tick(rekeyed.app.log);
    const expiry = (p: 'threads' | 'linkedin') => h.store.connect.tokens.get(p)!.expiresAt;
    expect(unreadable(rekeyed).map((a) => a.message)).toEqual([
      `threads token cannot be read with the current TOKEN_STORE_KEY (account fake_profile, id ${h.threads.userId}; it expires ${expiry('threads')}): nothing can be published there until the key is restored or the owner connects again (POST /v1/connect/threads/start)`,
      `linkedin token cannot be read with the current TOKEN_STORE_KEY (account John Doe, id 782bbtaQ; it expires ${expiry('linkedin')}): nothing can be published there until the key is restored or the owner connects again (POST /v1/connect/linkedin/start)`,
    ]);
    // Per state change, not per tick: an hour later, a day later, still two.
    await ticks(rekeyed, 5);
    rekeyed.advance(DAY);
    await ticks(rekeyed, 5);
    expect(unreadable(rekeyed)).toHaveLength(2);

    // No secret in the alert, the log or the status.
    const said =
      JSON.stringify(rekeyed.store.alerts.list(1000)) +
      rekeyed.logs() +
      (await rekeyed.app.inject({ method: 'GET', url: '/v1/connect', headers: BEARER })).body;
    for (const secret of [threads.token, linkedin.token, OTHER_KEY, STORE_KEY]) {
      expect(said).not.toContain(secret);
    }
    expect(rekeyed.logs()).toContain('stored token cannot be read');
  });

  it('an unreadable Threads token is not sent to the platform for a refresh, and that makes no daily alert', async () => {
    const h = await setup();
    await connectNow(h, 'threads');
    const rekeyed = await restart(h, { TOKEN_STORE_KEY: OTHER_KEY });
    for (let day = 0; day < 10; day++) {
      rekeyed.advance(DAY);
      await rekeyed.connect.tick();
    }
    expect(rekeyed.threads.sent('refresh')).toHaveLength(0);
    expect(rekeyed.store.alerts.list(1000).map((a) => a.kind)).toEqual([
      'platform_connected',
      'platform_token_unreadable',
    ]);
  });

  it('alerts again when it breaks a second time, after the key was restored in between', async () => {
    const h = await setup();
    await connectNow(h, 'threads');
    const broken = await restart(h, { TOKEN_STORE_KEY: OTHER_KEY });
    await ticks(broken, 2);
    expect(unreadable(broken)).toHaveLength(1);

    // The right key is back: the token reads again, nothing is said, the note is cleared.
    const restored = await restart(broken);
    await ticks(restored, 2);
    expect(unreadable(restored)).toHaveLength(1);
    expect(restored.connect.tokenStore('threads').get()).toMatch(/^FAKE-THREADS-LONG-TOKEN-/);

    const brokenAgain = await restart(restored, { TOKEN_STORE_KEY: OTHER_KEY });
    await ticks(brokenAgain, 2);
    expect(unreadable(brokenAgain)).toHaveLength(2);
  });

  it('a missing TOKEN_STORE_KEY counts as unreadable', async () => {
    const h = await setup();
    await connectNow(h, 'linkedin');
    const keyless = await restart(h, { TOKEN_STORE_KEY: '' });
    await ticks(keyless, 2);
    expect(unreadable(keyless)).toHaveLength(1);
    expect(unreadable(keyless)[0]!.message).toMatch(/^linkedin token cannot be read/);
  });

  it('a damaged row counts as unreadable', async () => {
    const h = await setup();
    await connectNow(h, 'threads');
    h.store.db
      .prepare(
        "UPDATE platform_tokens SET token_enc = 'v1.AAAA.BBBB.CCCC' WHERE platform = 'threads'",
      )
      .run();
    await ticks(h, 2);
    expect(unreadable(h)).toHaveLength(1);
  });

  it('connecting again under the new key ends the state; a later break alerts again', async () => {
    const h = await setup();
    await connectNow(h, 'threads');
    const rekeyed = await restart(h, { TOKEN_STORE_KEY: OTHER_KEY });
    await rekeyed.connect.tick();
    expect(unreadable(rekeyed)).toHaveLength(1);
    expect((await connectNow(rekeyed, 'threads')).res.statusCode).toBe(200);
    await ticks(rekeyed, 2);
    expect(unreadable(rekeyed)).toHaveLength(1);
    // The first key comes back: now the token stored under the second one cannot be read.
    const back = await restart(rekeyed);
    await ticks(back, 2);
    expect(unreadable(back)).toHaveLength(2);
  });

  it('a disconnect ends the state too, and a platform without a token never alerts', async () => {
    const h = await setup();
    await ticks(h, 2);
    expect(h.store.alerts.list()).toEqual([]);
    await connectNow(h, 'threads');
    const rekeyed = await restart(h, { TOKEN_STORE_KEY: OTHER_KEY });
    await rekeyed.connect.tick();
    rekeyed.connect.disconnect('threads');
    await ticks(rekeyed, 2);
    expect(unreadable(rekeyed)).toHaveLength(1);
    expect(
      rekeyed.store.db
        .prepare("SELECT value FROM bot_state WHERE key = 'connect.threads.token_unreadable'")
        .get(),
    ).toEqual({ value: '' });
  });
});
