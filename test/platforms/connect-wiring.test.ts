import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { SIGNATURE_LINE } from '../../src/plan/pipeline.js';
import { connectWiring, createPlatforms } from '../../src/platforms/registry.js';
import { BEARER, connectNow, harness, type Harness } from '../connect/helpers.js';
import { msk } from '../publish/helpers.js';
import { seedVariantPlan, variantKey } from '../publish/variant-helpers.js';
import { blocks } from '../support/blocks.js';
import { FakeThreads } from '../support/fake-threads.js';
import { FakeLinkedIn } from './linkedin/fake-linkedin.js';

// WP-PLAT-02 item 1 (resubmission 2): the adapters read their tokens from the account-connect
// package's encrypted store (`connectWiring`, as `src/index.ts` wires it), and the LinkedIn app
// id and secret reach the adapter. The connect flow runs against the connect package's own fake
// OAuth servers; the posts go to the adapters' own fake platform servers, which accept exactly
// one token.

const DAY = 86_400_000;
const BODY = 'Тишина третий день. Кто нарушит её первым?';
const made: Harness[] = [];
const fakes: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop();
  for (const h of made.splice(0).reverse()) await h.close();
});

/** The platforms of the service over the harness's store and connect service. */
const platformsOf = (h: Harness, env: Record<string, string>) =>
  createPlatforms({
    config: loadConfig(env),
    store: h.store,
    blocks,
    ...connectWiring(h.connect, h.config),
    now: () => msk('09:07:41'),
    sleep: async () => undefined,
  });

describe('refresh, restart, the refreshed token is used (item 11b)', () => {
  it('Threads: the weekly refresh replaces the token, and after a restart the post uses the new one', async () => {
    const h = await harness();
    made.push(h);
    const { token: first } = await connectNow(h, 'threads');
    expect(h.connect.tokenStore('threads').get()).toBe(first);

    // A week later the connect package refreshes the token (the adapter's own refresh call).
    h.advance(7 * DAY);
    await h.connect.tick();
    const refreshed = h.threads.token;
    expect(refreshed).not.toBe(first);
    expect(h.threads.sent('refresh')).toHaveLength(1);

    // Restart: a new process over the same database file.
    const h2 = await h.reopen();
    made.push(h2);
    expect(h2.connect.tokenStore('threads').get()).toBe(refreshed);

    // The Threads platform accepts the refreshed token only.
    const threads = await new FakeThreads(refreshed).start();
    fakes.push(threads);
    seedVariantPlan(
      h2.store,
      [{ id: 's1', at: '09:00' }],
      [{ slot: 's1', platform: 'threads', at: '09:07:41', text: BODY }],
    );
    const p = platformsOf(h2, { DRY_RUN_THREADS: 'false', THREADS_API_BASE_URL: threads.baseUrl });
    const loop = p.list.find((r) => r.platform === 'threads')!.loop!;
    expect((await loop.runOnce()).result).toBe('sent');
    expect(threads.posts.map((x) => x.text)).toEqual([`${BODY}\n\n${SIGNATURE_LINE}`]);
    expect(threads.requests.length).toBeGreaterThan(0);
    expect(threads.requests.every((r) => r.tokenOk)).toBe(true);
    expect(h2.store.publications.get(variantKey('s1', 'threads'))!.status).toBe('sent');

    // /ready: present, healthy, with the expiry the store holds.
    await p.probe();
    const expiresAt = h2.connect.tokenStore('threads').expiresAt();
    expect(p.status().threads).toMatchObject({
      ok: true,
      adapter: 'present',
      tokenExpiresAt: expiresAt,
    });
    // Neither token was written anywhere in clear.
    const dump = JSON.stringify([
      h2.store.publications.listForPlan('2026-10-11'),
      h2.store.alerts.list(),
      p.status(),
    ]);
    for (const t of [first, refreshed]) {
      expect(dump).not.toContain(t);
      expect(h2.dbBytes()).not.toContain(t);
    }
  });

  it('a token that is no longer the stored one is not used: the old one is refused by the platform', async () => {
    const h = await harness();
    made.push(h);
    const { token: first } = await connectNow(h, 'threads');
    h.advance(7 * DAY);
    await h.connect.tick();
    // The platform would accept only the first token: the service sends the refreshed one.
    const threads = await new FakeThreads(first).start();
    fakes.push(threads);
    seedVariantPlan(
      h.store,
      [{ id: 's1', at: '09:00' }],
      [{ slot: 's1', platform: 'threads', at: '09:07:41', text: BODY }],
    );
    const p = platformsOf(h, { DRY_RUN_THREADS: 'false', THREADS_API_BASE_URL: threads.baseUrl });
    expect((await p.list[0]!.loop!.runOnce()).result).not.toBe('sent');
    expect(threads.posts).toEqual([]);
    expect(threads.requests.some((r) => r.tokenOk)).toBe(false);
  });
});

describe('LinkedIn through the connect store and the app credentials', () => {
  it('health introspects with the app id and secret; a post goes out with the stored token', async () => {
    const h = await harness();
    made.push(h);
    const { token } = await connectNow(h, 'linkedin');
    const linkedin = await new FakeLinkedIn({
      token,
      clientId: h.config.LINKEDIN_CLIENT_ID!,
      clientSecret: h.config.LINKEDIN_CLIENT_SECRET!,
    }).start();
    fakes.push(linkedin);
    seedVariantPlan(
      h.store,
      [{ id: 's1', at: '09:00' }],
      [{ slot: 's1', platform: 'linkedin', at: '09:07:41', text: BODY }],
    );
    const env = {
      DRY_RUN_LINKEDIN: 'false',
      LINKEDIN_LINK_MODE: 'comment',
      LINKEDIN_API_BASE_URL: linkedin.baseUrl,
      LINKEDIN_OAUTH_BASE_URL: linkedin.baseUrl,
    };
    const p = platformsOf(h, env);
    await p.probe();
    // Introspection answers only to the right client id and secret.
    expect(p.status().linkedin).toMatchObject({ ok: true, adapter: 'present' });
    expect(linkedin.sent('introspect')).toHaveLength(1);
    const loop = p.list.find((r) => r.platform === 'linkedin')!.loop!;
    expect((await loop.runOnce()).result).toBe('sent');
    expect(linkedin.feed).toHaveLength(1);

    // Without the app credentials the same check cannot pass.
    const withoutApp = createPlatforms({
      config: loadConfig(env),
      store: h.store,
      blocks,
      tokens: connectWiring(h.connect, h.config).tokens,
    });
    await withoutApp.probe();
    expect(withoutApp.status().linkedin.ok).toBe(false);
  });

  it('a disconnected account: the adapter answers "not connected" and calls nothing', async () => {
    const h = await harness();
    made.push(h);
    await connectNow(h, 'linkedin');
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/v1/connect/linkedin',
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    const linkedin = await new FakeLinkedIn({
      token: 'unused',
      clientId: h.config.LINKEDIN_CLIENT_ID!,
      clientSecret: h.config.LINKEDIN_CLIENT_SECRET!,
    }).start();
    fakes.push(linkedin);
    seedVariantPlan(
      h.store,
      [{ id: 's1', at: '09:00' }],
      [{ slot: 's1', platform: 'linkedin', at: '09:07:41', text: BODY }],
    );
    const p = platformsOf(h, {
      DRY_RUN_LINKEDIN: 'false',
      LINKEDIN_API_BASE_URL: linkedin.baseUrl,
      LINKEDIN_OAUTH_BASE_URL: linkedin.baseUrl,
    });
    expect((await p.list[1]!.loop!.runOnce()).result).toBe('failed');
    expect(h.store.publications.get(variantKey('s1', 'linkedin'))!.error).toBe(
      'not_connected: no account token is stored; nothing was sent',
    );
    await p.probe();
    expect(p.status().linkedin).toMatchObject({
      ok: false,
      adapter: 'present',
      detail: 'not connected: no token is stored',
    });
    expect(linkedin.requests).toEqual([]);
  });
});
