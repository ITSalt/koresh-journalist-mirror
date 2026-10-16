import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { SIGNATURE_LINE } from '../../src/plan/pipeline.js';
import { FRAME_TEXTS } from '../../src/platforms/frame.js';
import {
  createPlatforms,
  LINKEDIN_PROBE_SETTLED,
  linkedinFirstComment,
  reportIgnoredPlatformSettings,
  rowStepStore,
  type PlatformsOptions,
} from '../../src/platforms/registry.js';
import { createMemoryTokenStore } from '../../src/platforms/threads/index.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { DATE, msk } from '../publish/helpers.js';
import { seedVariantPlan, variantKey, variantRow } from '../publish/variant-helpers.js';
import { blocks } from '../support/blocks.js';
import { fakeAdapter, unknown } from '../support/fake-adapter.js';
import { FakeThreads } from '../support/fake-threads.js';
import { FakeLinkedIn } from './linkedin/fake-linkedin.js';

// WP-PLAT-02 scope items 1, 5, 8 and 11: the registry of platforms built from the config. The
// loops are driven with scripted fake adapters; the merged Threads and LinkedIn adapters appear
// only in the wiring tests at the end, against their own fake servers.

/** Made-up markers, not real tokens: the tests assert they never show up in what is stored. */
const TH_TOKEN = 'THMARKER0fake0token0for0tests0only0xxxxxxxxxxxx';
const LI_TOKEN = 'LIMARKER0fake0token0for0tests0only0xxxxxxxxxxxx';
const BODY = 'Тишина третий день. Кто нарушит её первым?';
const signed = (text: string) => `${text}\n\n${SIGNATURE_LINE}`;

let store: Store;
let t: Date;
beforeEach(() => {
  store = openStore(':memory:');
  t = msk('08:00');
});
afterEach(() => {
  store.close();
});

const DAY = [{ id: 's1', at: '09:00', text: 'Утро. Кто первый?' }];
const VARIANTS = [
  { slot: 's1', platform: 'threads', at: '09:07:41', text: BODY },
  { slot: 's1', platform: 'linkedin', at: '09:07:41', text: BODY },
  { slot: 's1', platform: 'linkedin', lang: 'en', at: '09:40', text: 'Silence. Who breaks it?' },
] as const;

const platforms = (env: Record<string, string> = {}, over: Partial<PlatformsOptions> = {}) =>
  createPlatforms({
    config: loadConfig(env),
    store,
    blocks,
    now: () => t,
    sleep: async () => undefined,
    ...over,
  });
const rows = () => store.publications.listForPlan(DATE);
const alerts = (kind?: string) => store.alerts.list().filter((a) => !kind || a.kind === kind);
const loopOf = (p: ReturnType<typeof platforms>, platform: 'threads' | 'linkedin') =>
  p.list.find((r) => r.platform === platform)!.loop!;

describe('adapters from the config', () => {
  it('without a token store both adapters are absent, dry and never required', async () => {
    const p = platforms();
    expect(p.list.map((r) => [r.platform, r.dryRun, r.adapter, Boolean(r.loop)])).toEqual([
      ['threads', true, undefined, true],
      ['linkedin', true, undefined, true],
    ]);
    await p.probe();
    expect(p.status()).toEqual({
      threads: {
        ok: false,
        required: false,
        dryRun: true,
        adapter: 'absent',
        detail: 'adapter absent: no token store for the account (not connected)',
      },
      linkedin: {
        ok: false,
        required: false,
        dryRun: true,
        adapter: 'absent',
        detail: 'adapter absent: no token store for the account (not connected)',
      },
    });
    expect(alerts()).toEqual([]);
  });

  it('/ready says so and stays ready: a platform is never required', async () => {
    const p = platforms();
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: 'fake-telegram-token' });
    const app = buildServer({
      config,
      store,
      logLevel: 'silent',
      platformStatus: () => p.status(),
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.components.threads).toMatchObject({
      ok: false,
      required: false,
      adapter: 'absent',
    });
    expect(body.components.linkedin).toMatchObject({
      ok: false,
      required: false,
      adapter: 'absent',
    });
    // Even a registry that claimed otherwise cannot make a platform required.
    const lying = buildServer({
      config,
      store,
      logLevel: 'silent',
      platformStatus: () => ({
        threads: { ...p.status().threads, required: true as unknown as false },
      }),
    });
    expect((await lying.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    // Without the registry /ready has exactly the components it had before this package.
    const plain = buildServer({ config, store, logLevel: 'silent' });
    const before = (await plain.inject({ method: 'GET', url: '/ready' })).json();
    expect(Object.keys(before.components)).toEqual(['db', 'telegram', 'inbox', 'llm', 'connect']);
  });

  it('a dry day without any adapter records dry rows', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const p = platforms();
    t = msk('09:07:41');
    for (const r of p.list) await r.loop!.runOnce();
    expect(rows().map((r) => [r.platform, r.status])).toEqual([
      ['linkedin', 'dry'],
      ['threads', 'dry'],
    ]);
  });

  it('live without a connected account: no loop, one alert, /ready names the reason', () => {
    const p = platforms({ DRY_RUN_THREADS: 'false' });
    const threads = p.list[0]!;
    expect(threads.loop).toBeUndefined();
    expect(p.list[1]!.loop).toBeDefined();
    expect(alerts().map((a) => [a.kind, a.message])).toEqual([
      [
        'platform_disabled',
        'threads: DRY_RUN_THREADS=false without a connected account: the publisher does not run; nothing is published there',
      ],
    ]);
  });
});

describe('the platform_config alert is written once per changed value (r1 item 7)', () => {
  /** One boot of the service with this environment. */
  const boot = (env: Record<string, string>) =>
    reportIgnoredPlatformSettings(store, loadConfig(env), t);
  const told = () => alerts('platform_config').map((a) => a.message);

  it('not on every boot: the same wrong values are told once', () => {
    const env = { DRY_RUN_THREADS: 'flase', LINKEDIN_LINK_MODE: 'coment' };
    expect(boot(env)).toBe(true);
    expect(boot(env)).toBe(false);
    expect(boot({ ...env, PORT: '9000' })).toBe(false);
    expect(told()).toEqual([
      'invalid values ignored, the defaults are used: DRY_RUN_THREADS, LINKEDIN_LINK_MODE',
    ]);
  });

  it('a changed value, one more key or one key less is told again', () => {
    expect(boot({ DRY_RUN_THREADS: 'flase' })).toBe(true);
    expect(boot({ DRY_RUN_THREADS: 'fasle' })).toBe(true);
    expect(boot({ DRY_RUN_THREADS: 'fasle', LINKEDIN_VERSION: '2027-01' })).toBe(true);
    expect(boot({ LINKEDIN_VERSION: '2027-01' })).toBe(true);
    expect(boot({ LINKEDIN_VERSION: '2027-01' })).toBe(false);
    expect(told()).toEqual([
      'invalid values ignored, the defaults are used: DRY_RUN_THREADS',
      'invalid values ignored, the defaults are used: DRY_RUN_THREADS',
      'invalid values ignored, the defaults are used: DRY_RUN_THREADS, LINKEDIN_VERSION',
      'invalid values ignored, the defaults are used: LINKEDIN_VERSION',
    ]);
  });

  it('valid settings write nothing; a mistake that was fixed and is made again is told again', () => {
    expect(boot({})).toBe(false);
    expect(boot({ DRY_RUN_THREADS: 'false' })).toBe(false);
    expect(told()).toEqual([]);
    expect(boot({ DRY_RUN_THREADS: 'flase' })).toBe(true);
    expect(boot({ DRY_RUN_THREADS: 'false' })).toBe(false);
    expect(boot({ DRY_RUN_THREADS: 'flase' })).toBe(true);
    expect(told()).toHaveLength(2);
    // Only the fingerprint is kept, never a value.
    expect(JSON.stringify(store.db.prepare('SELECT * FROM bot_state').all())).not.toContain(
      'flase',
    );
  });
});

describe('DRY_RUN_THREADS and DRY_RUN_LINKEDIN (scope item 5)', () => {
  it('default: both dry, zero adapter calls, even with DRY_RUN=false for Telegram', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const threads = fakeAdapter('threads');
    const linkedin = fakeAdapter('linkedin', { comment: true });
    const p = platforms({ DRY_RUN: 'false' }, { adapters: { threads, linkedin } });
    expect(p.list.map((r) => r.dryRun)).toEqual([true, true]);
    for (const at of ['09:07:41', '09:07:42', '09:40', '09:41']) {
      t = msk(at);
      for (const r of p.list) await r.loop!.runOnce();
    }
    expect([...threads.calls, ...linkedin.calls]).toEqual([]);
    expect(rows().map((r) => r.status)).toEqual(['dry', 'dry', 'dry']);
  });

  it('each flag switches only its own platform', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const threads = fakeAdapter('threads');
    const linkedin = fakeAdapter('linkedin', { comment: true });
    const p = platforms({ DRY_RUN_LINKEDIN: 'false' }, { adapters: { threads, linkedin } });
    expect(p.list.map((r) => [r.platform, r.dryRun])).toEqual([
      ['threads', true],
      ['linkedin', false],
    ]);
    t = msk('09:07:41');
    await loopOf(p, 'threads').runOnce();
    await loopOf(p, 'linkedin').runOnce();
    expect(threads.calls).toEqual([]);
    expect(linkedin.calls).toEqual(['validate', 'publish']);
    expect(rows().map((r) => [r.platform, r.status])).toEqual([
      ['linkedin', 'sent'],
      ['threads', 'dry'],
    ]);

    const q = platforms({ DRY_RUN_THREADS: 'false' }, { adapters: { threads, linkedin } });
    expect(q.list.map((r) => r.dryRun)).toEqual([false, true]);
  });

  it('rules, the link and the Threads disclaimer come from the config', async () => {
    const p = platforms({
      THREADS_GRACE_MIN: '30',
      THREADS_MIN_GAP_MIN: '5',
      LINKEDIN_MIN_GAP_MIN: '0',
      THREADS_DISCLAIMER: 'true',
      LINKEDIN_LINK_URL: 'https://t.me/Channel1/99',
    });
    expect(p.list.map((r) => [r.rules, r.link, r.frame])).toEqual([
      [{ graceMin: 30, minGapMin: 5 }, undefined, { threadsDisclaimer: true }],
      [{ graceMin: 90, minGapMin: 0 }, 'https://t.me/Channel1/99', { linkInline: true }],
    ]);
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const threads = fakeAdapter('threads');
    const live = platforms(
      { DRY_RUN_THREADS: 'false', THREADS_DISCLAIMER: 'true' },
      { adapters: { threads } },
    );
    t = msk('09:07:41');
    await loopOf(live, 'threads').runOnce();
    expect(threads.posts[0]!.text).toBe(`${signed(BODY)}\n\n${FRAME_TEXTS.ru.disclaimer.comment}`);
    // LinkedIn's frame follows its link mode.
    expect(platforms({ LINKEDIN_LINK_MODE: 'comment' }).list[1]!.frame).toEqual({
      linkInline: false,
    });
    expect(threads.posts[0]!.link).toBeUndefined();
  });
});

describe('Telegram is wrapped: started first, never held back', () => {
  it('start and stop go through the registry; a platform loop that throws stops only itself', async () => {
    const order: string[] = [];
    const telegram = {
      start: () => void order.push('telegram start'),
      stop: async () => void order.push('telegram stop'),
    };
    const p = platforms({}, { telegram });
    p.list[0]!.loop!.start = () => {
      order.push('threads start');
      throw new Error('boom');
    };
    const linkedinStart = p.list[1]!.loop!.start.bind(p.list[1]!.loop);
    p.list[1]!.loop!.start = () => {
      order.push('linkedin start');
      linkedinStart();
    };
    p.start();
    await p.stop();
    expect(order).toEqual(['telegram start', 'threads start', 'linkedin start', 'telegram stop']);
    expect(alerts('platform_disabled').map((a) => a.message)).toEqual([
      'threads: the publish loop did not start',
    ]);
  });

  it('a token store whose every read throws: the adapter is present and the start is not disturbed', () => {
    const p = platforms(
      { THREADS_API_BASE_URL: 'http://127.0.0.1:1' },
      {
        tokens: {
          // A store whose every read throws.
          threads: {
            get() {
              throw new Error('store is down');
            },
            set() {
              throw new Error('store is down');
            },
          },
        },
        telegram: { start: () => undefined, stop: async () => undefined },
      },
    );
    // Built lazily over the store: present, and "not connected" when asked.
    expect(p.list[0]!.adapter).toBeDefined();
    expect(() => p.start()).not.toThrow();
    return p.stop();
  });
});

describe('health for /ready', () => {
  it('shows the last health check; tells once when a platform stops being fine', async () => {
    const threads = fakeAdapter('threads');
    const linkedin = fakeAdapter('linkedin');
    linkedin.healthState = {
      ok: true,
      detail: 'token active until 2026-12-11T09:00:00.000Z, reminder: none',
      tokenExpiresAt: '2026-12-11T09:00:00.000Z',
    };
    const p = platforms({}, { adapters: { threads, linkedin } });
    expect(p.status().threads).toMatchObject({
      ok: false,
      adapter: 'present',
      detail: 'health not checked yet',
    });
    await p.probe();
    expect(p.status()).toMatchObject({
      threads: { ok: true, adapter: 'present', detail: 'fake ok', required: false, dryRun: true },
      linkedin: { ok: true, tokenExpiresAt: '2026-12-11T09:00:00.000Z' },
    });
    expect(alerts()).toEqual([]);

    threads.healthState = { ok: false, detail: 'token_invalid: me: code 190' };
    await p.probe();
    await p.probe();
    expect(p.status().threads).toMatchObject({ ok: false, detail: 'token_invalid: me: code 190' });
    expect(alerts().map((a) => [a.kind, a.message])).toEqual([
      ['platform_unhealthy', 'threads: token_invalid: me: code 190'],
    ]);
  });

  it('a health call that throws is a not-ok status, never an exception', async () => {
    const threads = fakeAdapter('threads');
    threads.health = async () => {
      throw new TypeError('fetch failed');
    };
    const p = platforms({}, { adapters: { threads } });
    await expect(p.probe()).resolves.toBeUndefined();
    expect(p.status().threads).toMatchObject({
      ok: false,
      detail: 'health check failed (TypeError)',
    });
  });

  it('account tokens are scrubbed from everything the loops store', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const threads = fakeAdapter('threads');
    threads.publishQueue.push(unknown(`publish: Malformed access token ${TH_TOKEN}`));
    threads.healthState = { ok: false, detail: `bad token ${TH_TOKEN}` };
    const p = platforms(
      { DRY_RUN_THREADS: 'false' },
      { adapters: { threads }, tokens: { threads: createMemoryTokenStore(TH_TOKEN) } },
    );
    t = msk('09:07:41');
    await loopOf(p, 'threads').runOnce();
    await p.probe();
    const dump = JSON.stringify([rows(), alerts(), p.status()]);
    expect(dump).toContain('Malformed access token [REDACTED]');
    expect(dump).not.toContain(TH_TOKEN);
  });
});

describe('the first comment on LinkedIn with the core rows (scope item 8, D-2)', () => {
  const ok = { ok: true, result: { id: 'c1' } } as const;
  const forbidden = {
    ok: false,
    outcome: 'refused',
    description: 'comment_forbidden: HTTP 403',
  } as const;

  it('inline: the probe comment is due once; an accepted comment settles it with an alert', () => {
    const c = linkedinFirstComment(store, 'inline');
    expect(c.due()).toBe(true);
    expect(c.settled!(ok)).toMatchObject({ kind: 'linkedin_comment_works' });
    expect(store.botState.get(LINKEDIN_PROBE_SETTLED)).toBe('1');
    expect(c.due()).toBe(false);
    // The flag is stored: a new process does not probe again.
    expect(linkedinFirstComment(store, 'inline').due()).toBe(false);
  });

  it('inline: a 403 settles it too; anything else leaves the probe open', () => {
    const c = linkedinFirstComment(store, 'inline');
    expect(c.settled!(unknown('no_answer: create comment'))).toMatchObject({
      kind: 'linkedin_comment_unknown',
    });
    expect(c.due()).toBe(true);
    expect(c.settled!(forbidden)).toMatchObject({ kind: 'linkedin_comment_forbidden' });
    expect(c.due()).toBe(false);
  });

  it('comment mode: a comment follows every post; success tells nothing', () => {
    store.botState.set(LINKEDIN_PROBE_SETTLED, '1');
    const c = linkedinFirstComment(store, 'comment');
    expect(c.due()).toBe(true);
    expect(c.settled!(ok)).toBeNull();
    expect(c.due()).toBe(true);
  });

  it('through the loop: post, one probe comment, alert; the next post gets no comment', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const linkedin = fakeAdapter('linkedin', { comment: true });
    const p = platforms({ DRY_RUN_LINKEDIN: 'false' }, { adapters: { linkedin } });
    const loop = loopOf(p, 'linkedin');
    for (const at of ['09:07:41', '09:07:42', '09:07:43', '09:40', '09:40:01', '09:40:02']) {
      t = msk(at);
      await loop.runOnce();
    }
    expect(linkedin.calls).toEqual(['validate', 'publish', 'comment', 'validate', 'publish']);
    expect(linkedin.comments).toEqual([
      {
        postId: 'linkedin-post-1',
        text: 'https://t.me/Channel1/57',
        key: variantKey('s1', 'linkedin', 'ru', 1),
      },
    ]);
    // Inline mode: the disclaimer carries the link, so the adapter is not given it again.
    expect(linkedin.posts.map((x) => x.link)).toEqual([undefined, undefined]);
    expect(linkedin.posts.map((x) => x.text.endsWith('https://t.me/Channel1/57'))).toEqual([
      true,
      true,
    ]);
    expect(alerts().map((a) => a.kind)).toEqual(['linkedin_comment_works']);
    expect(rows().map((r) => [r.key.slice(-7), r.status])).toEqual([
      ['s1-en:0', 'sent'],
      ['s1-ru:0', 'sent'],
      ['s1-ru:1', 'sent'],
    ]);
    expect(variantRow(store, 's1', 'linkedin', 'en').status).toBe('done');
  });
});

describe('the step record of a Threads publish lives on the publication row (item 11a)', () => {
  it('get and set go to the intent row; a row that is not an intent cannot be written', () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const steps = rowStepStore(store);
    const key = variantKey('s1', 'threads');
    expect(steps.get(key)).toBeUndefined();
    expect(() => steps.set(key, { step: 'container', containerId: 'c1', at: 'x' })).toThrow(
      /not an intent/,
    );
    store.publications.beginVariantIntent({
      key,
      platform: 'threads',
      planDate: DATE,
      slotId: 's1',
      lang: 'ru',
      textSha256: 'f'.repeat(64),
      expectVariantJson: variantRow(store, 's1', 'threads').json,
    });
    const step = { step: 'publish', containerId: 'c1', at: '2026-10-11T06:07:41.000Z' } as const;
    steps.set(key, step);
    expect(steps.get(key)).toEqual(step);
    expect(store.publications.get(key)!.step).toBe(JSON.stringify(step));
    store.publications.markUnknown(key, 'x');
    expect(steps.get(key)).toEqual(step); // the record outlives the result
    expect(() => steps.set(key, { ...step, step: 'container' })).toThrow(/not an intent/);
  });
});

describe('wiring of the merged adapters (their own fake servers)', () => {
  let fakeThreads: FakeThreads;
  let fakeLinkedIn: FakeLinkedIn;
  beforeEach(async () => {
    fakeThreads = await new FakeThreads(TH_TOKEN).start();
    fakeLinkedIn = await new FakeLinkedIn({
      token: LI_TOKEN,
      clientId: 'client-id',
      clientSecret: 'client-secret-marker',
    }).start();
  });
  afterEach(async () => {
    await fakeThreads.stop();
    await fakeLinkedIn.stop();
  });

  it('Threads: the loop publishes through the adapter; id, url and the step are on the row', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const tokens = createMemoryTokenStore(TH_TOKEN);
    const p = platforms(
      { DRY_RUN_THREADS: 'false', THREADS_API_BASE_URL: fakeThreads.baseUrl },
      { tokens: { threads: tokens } },
    );
    t = msk('09:07:41');
    expect((await loopOf(p, 'threads').runOnce()).result).toBe('sent');
    expect(fakeThreads.posts.map((x) => x.text)).toEqual([signed(BODY)]);
    const row = store.publications.get(variantKey('s1', 'threads'))!;
    expect(row).toMatchObject({
      status: 'sent',
      messageId: fakeThreads.posts[0]!.id,
      url: fakeThreads.posts[0]!.permalink,
    });
    expect(JSON.parse(row.step!)).toMatchObject({
      step: 'publish',
      containerId: fakeThreads.posts[0]!.containerId,
    });
    // The token is read from the store for every call: a replaced token is used at once.
    fakeThreads.token = `${TH_TOKEN}-next`;
    await p.probe();
    expect(p.status().threads.ok).toBe(false);
    tokens.set(`${TH_TOKEN}-next`, '2026-12-30T00:00:00.000Z');
    await p.probe();
    expect(p.status().threads).toMatchObject({
      ok: true,
      tokenExpiresAt: '2026-12-30T00:00:00.000Z',
    });
    expect(JSON.stringify([rows(), alerts(), p.status()])).not.toContain(TH_TOKEN);
  });

  it('Threads: no token in the store is one clear refusal and no request', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const p = platforms(
      { DRY_RUN_THREADS: 'false', THREADS_API_BASE_URL: fakeThreads.baseUrl },
      { tokens: { threads: createMemoryTokenStore('') } },
    );
    t = msk('09:07:41');
    expect((await loopOf(p, 'threads').runOnce()).result).toBe('failed');
    expect(fakeThreads.requests).toEqual([]);
    expect(store.publications.get(variantKey('s1', 'threads'))).toMatchObject({
      status: 'failed',
      error: 'not_connected: no account token is stored; nothing was sent',
    });
    await p.probe();
    expect(p.status().threads).toMatchObject({
      ok: false,
      adapter: 'present',
      detail: 'not connected: no token is stored',
    });
  });

  it('LinkedIn inline: the frame, the link as the last line, hashtags escaped, one probe comment', async () => {
    seedVariantPlan(store, DAY, [
      {
        slot: 's1',
        platform: 'linkedin',
        at: '09:07:41',
        text: 'Дело №1 (тишина) #офис. Кто первый?',
      },
    ]);
    const env = {
      DRY_RUN_LINKEDIN: 'false',
      LINKEDIN_API_BASE_URL: fakeLinkedIn.baseUrl,
      LINKEDIN_OAUTH_BASE_URL: fakeLinkedIn.baseUrl,
    };
    const p = platforms(env, {
      tokens: { linkedin: createMemoryTokenStore(LI_TOKEN) },
      linkedinApp: { clientId: 'client-id', clientSecret: 'client-secret-marker' },
    });
    const loop = loopOf(p, 'linkedin');
    t = msk('09:07:41');
    expect(await loop.runOnce()).toMatchObject({ item: 'post', result: 'sent' });
    expect(await loop.runOnce()).toMatchObject({ item: 'comment', result: 'sent' });
    await loop.runOnce();

    const f = FRAME_TEXTS.ru;
    expect(fakeLinkedIn.feed).toHaveLength(1);
    const post = fakeLinkedIn.feed[0]!;
    expect(post.text).toBe(
      `${f.header}\n\n${signed('Дело №1 (тишина) #офис. Кто первый?')}\n\n${f.disclaimer.inline.replace('{link}', 'https://t.me/Channel1/57')}`,
    );
    // D-3: every '#' stays escaped, so LinkedIn shows plain text, not a hashtag.
    expect(post.unescapedReserved).toEqual([]);
    expect(post.commentary).toContain('\\#офис');
    expect(post.commentary).toContain('\\(тишина\\)');
    expect(fakeLinkedIn.comments.map((c) => [c.postUrn, c.text])).toEqual([
      [post.urn, 'https://t.me/Channel1/57'],
    ]);
    expect(store.publications.get(variantKey('s1', 'linkedin'))).toMatchObject({
      status: 'sent',
      messageId: post.urn,
      url: `https://www.linkedin.com/feed/update/${post.urn}/`,
    });
    expect(alerts().map((a) => a.kind)).toEqual(['linkedin_comment_works']);
    await p.probe();
    expect(p.status().linkedin).toMatchObject({ ok: true, adapter: 'present' });
    expect(p.status().linkedin.tokenExpiresAt).toBeDefined();
    const dump = JSON.stringify([rows(), alerts(), p.status()]);
    expect(dump).not.toContain(LI_TOKEN);
    expect(dump).not.toContain('client-secret-marker');
  });

  it('LinkedIn: a 403 on the probe keeps the post, says so once, and is not tried again', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    fakeLinkedIn.commentsAllowed = false;
    const p = platforms(
      {
        DRY_RUN_LINKEDIN: 'false',
        LINKEDIN_API_BASE_URL: fakeLinkedIn.baseUrl,
        LINKEDIN_OAUTH_BASE_URL: fakeLinkedIn.baseUrl,
      },
      { tokens: { linkedin: createMemoryTokenStore(LI_TOKEN) } },
    );
    const loop = loopOf(p, 'linkedin');
    for (const at of ['09:07:41', '09:07:42', '09:07:43', '09:40', '09:40:01']) {
      t = msk(at);
      await loop.runOnce();
    }
    expect(fakeLinkedIn.feed).toHaveLength(2);
    expect(fakeLinkedIn.comments).toEqual([]);
    expect(fakeLinkedIn.sent('comments')).toHaveLength(1);
    expect(alerts().map((a) => a.kind)).toEqual(['linkedin_comment_forbidden']);
    expect(rows().map((r) => [r.key.slice(-7), r.status])).toEqual([
      ['s1-en:0', 'sent'],
      ['s1-ru:0', 'sent'],
      ['s1-ru:1', 'failed'],
    ]);
  });

  it('LinkedIn comment mode: the post has no link, the first comment carries it', async () => {
    seedVariantPlan(store, DAY, [{ slot: 's1', platform: 'linkedin', at: '09:07:41', text: BODY }]);
    const p = platforms(
      {
        DRY_RUN_LINKEDIN: 'false',
        LINKEDIN_LINK_MODE: 'comment',
        LINKEDIN_API_BASE_URL: fakeLinkedIn.baseUrl,
        LINKEDIN_OAUTH_BASE_URL: fakeLinkedIn.baseUrl,
      },
      { tokens: { linkedin: createMemoryTokenStore(LI_TOKEN) } },
    );
    const loop = loopOf(p, 'linkedin');
    t = msk('09:07:41');
    await loop.runOnce();
    await loop.runOnce();
    expect(fakeLinkedIn.feed[0]!.text).not.toContain('t.me');
    expect(fakeLinkedIn.comments.map((c) => c.text)).toEqual(['https://t.me/Channel1/57']);
    expect(alerts()).toEqual([]);
  });

  it('LinkedIn: a token replaced in the store is used without a restart; none is "not connected"', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const tokens = createMemoryTokenStore('');
    const p = platforms(
      {
        DRY_RUN_LINKEDIN: 'false',
        LINKEDIN_MIN_GAP_MIN: '0',
        LINKEDIN_API_BASE_URL: fakeLinkedIn.baseUrl,
        LINKEDIN_OAUTH_BASE_URL: fakeLinkedIn.baseUrl,
      },
      { tokens: { linkedin: tokens } },
    );
    const loop = loopOf(p, 'linkedin');
    t = msk('09:07:41');
    expect((await loop.runOnce()).result).toBe('failed');
    expect(fakeLinkedIn.requests).toEqual([]);
    tokens.set(LI_TOKEN, '2026-12-11T09:00:00.000Z');
    t = msk('09:40');
    expect(await loop.runOnce()).toMatchObject({ variant: 's1-en', result: 'sent' });
    expect(fakeLinkedIn.feed).toHaveLength(1);
  });
});
