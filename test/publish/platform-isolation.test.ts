import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  createPublisher,
  decideInput,
  DEFAULT_RULES,
  INTENT_STALE_MS,
} from '../../src/publish/publisher.js';
import { buildServer } from '../../src/server.js';
import {
  AlreadyExists,
  openStore,
  VariantNotClaimable,
  type Store,
} from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';
import { CHANNEL, DATE, msk, TOKEN } from './helpers.js';
import { seedVariantPlan, variantKey, variantPublication, variantRow } from './variant-helpers.js';

// WP-PLAT-02 scope item 9: the nine places where the Telegram code of main would read the rows
// or the data of a variant (WP-PLAT-01 pre-review). In every test a variant row (and, where it
// matters, its publication row, which carries the slot's own id) exists for the same date and
// slot, and Telegram behaves as if it were not there. Items 7a and 7b of the package are the
// first and the seventh place.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };

let fake: FakeBotApi;
let store: Store;
let t: Date;
beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
  store = openStore(':memory:');
  t = msk('08:00');
});
afterEach(async () => {
  store.close();
  await fake.stop();
});

const telegram = () =>
  createPublisher({
    store,
    blocks,
    api: createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 1000 }),
    channel: CHANNEL,
    dryRun: false,
    tz: 'Europe/Moscow',
    now: () => t,
    sleep: async () => undefined,
  });
const server = () =>
  buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: API_TOKEN, TELEGRAM_BOT_TOKEN: TOKEN }),
    store,
    logLevel: 'silent',
    now: () => t,
    preflight: { blocks, channel: CHANNEL },
  });
const slotStatus = (id: string) =>
  store.slots.listForPlan(DATE).find((s) => s.slotId === id)!.status;
const telegramRows = () =>
  store.publications.listForPlan(DATE).filter((p) => p.platform === 'telegram');
const alerts = (kind: string) => store.alerts.list().filter((a) => a.kind === kind);

/** One slot at 12:05 with a Threads and a LinkedIn variant of its own. */
const DAY = [{ id: 's1', at: '12:05', text: 'Полдень. Кто на месте?' }];
const VARIANTS = [
  { slot: 's1', platform: 'threads', at: '12:00' },
  { slot: 's1', platform: 'linkedin', at: '12:00:30' },
] as const;

describe('1. decideInput reads Telegram rows only (publisher.ts decideInput, item 7a)', () => {
  it('a variant sent at 12:00 does not delay the Telegram slot due at 12:05', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    variantPublication(store, 's1', 'threads', 'sent', msk('12:00'));
    variantPublication(store, 's1', 'linkedin', 'sent', msk('12:00:30'));

    t = msk('12:04:59');
    const early = await telegram().runOnce();
    expect(early.result).toBeUndefined();
    // Telegram wakes for its own slot, not for the end of another platform's min gap.
    expect(early.wakeAt).toBe(msk('12:05').toISOString());

    t = msk('12:05');
    const it = await telegram().runOnce();
    expect(it).toMatchObject({ slot: 's1', result: 'sent' });
    expect(fake.channel).toHaveLength(1);
    expect(telegramRows().map((p) => [p.key, p.status])).toEqual([
      [`telegram:${DATE}:s1:0`, 'sent'],
    ]);
  });

  it('a row of another platform with the slot id does not mark the Telegram slot done', () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    for (const status of ['intent', 'unknown', 'failed'] as const) {
      store.db.prepare('DELETE FROM publications').run();
      variantPublication(store, 's1', 'threads', status, msk('12:00'));
      const input = decideInput({
        date: DATE,
        plan: store.plans.get(DATE)!,
        slots: store.slots.listForPlan(DATE),
        pubs: store.publications.listForPlan(DATE),
        now: msk('12:05'),
        rules: DEFAULT_RULES,
      });
      expect(input.done, status).toEqual([]);
      expect(input.lastPublishedAt, status).toBeUndefined();
      expect(blocks.decide(input).publish, status).toBe('s1');
    }
  });

  it("Telegram's own min gap still counts its own rows", async () => {
    seedVariantPlan(
      store,
      [
        { id: 's1', at: '12:00' },
        { id: 's2', at: '12:05' },
      ],
      [{ slot: 's2', platform: 'threads', at: '12:01' }],
    );
    t = msk('12:00');
    expect((await telegram().runOnce()).result).toBe('sent');
    variantPublication(store, 's2', 'threads', 'sent', msk('12:01'));
    t = msk('12:05');
    const it = await telegram().runOnce();
    expect(it.result).toBeUndefined();
    expect(it.wakeAt).toBe(msk('12:20').toISOString());
  });
});

describe('2. resumable matches rows by slot id and platform (publisher.ts resumable)', () => {
  it('a sent variant of a not yet due slot does not start the Telegram slot early', async () => {
    seedVariantPlan(store, DAY, [{ slot: 's1', platform: 'threads', at: '11:30' }]);
    variantPublication(store, 's1', 'threads', 'sent', msk('11:30'));
    t = msk('11:31');
    const it = await telegram().runOnce();
    expect(it.result).toBeUndefined();
    expect(it.wakeAt).toBe(msk('12:05').toISOString());
    expect(fake.requests).toHaveLength(0);
    expect(slotStatus('s1')).toBe('planned');
    expect(alerts('partial_post')).toHaveLength(0);
  });

  it('a sent variant of a slot past its grace does not become a partial post', async () => {
    seedVariantPlan(store, DAY, [{ slot: 's1', platform: 'threads', at: '12:00' }]);
    variantPublication(store, 's1', 'threads', 'sent', msk('12:00'));
    t = msk('14:00'); // 115 minutes late: the slot is skipped as stale, not as a partial post
    const it = await telegram().runOnce();
    expect(it.skipped).toEqual(['s1']);
    expect(alerts('partial_post')).toHaveLength(0);
    expect(alerts('slot_skipped')).toHaveLength(1);
  });
});

describe('3. each loop reconciles its own stale intents (publisher.ts reconcile, store)', () => {
  it("the Telegram loop leaves another platform's stale intent alone", async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    variantPublication(store, 's1', 'threads', 'intent', msk('11:00'));
    store.publications.beginIntent(
      {
        key: `telegram:${DATE}:s0:0`,
        platform: 'telegram',
        planDate: DATE,
        slotId: 's0',
        textSha256: 'a'.repeat(64),
      },
      msk('11:00'),
    );
    t = msk('11:30');
    const p = telegram();
    expect(p.reconcile()).toEqual([`telegram:${DATE}:s0:0`]);
    expect(store.publications.get(variantKey('s1', 'threads'))!.status).toBe('intent');
    expect(alerts('publish_unknown').map((a) => a.message)).toEqual([
      `telegram:${DATE}:s0:0: an intent was left without a result (restart); it may be posted. Not resent: check the channel`,
    ]);
    await p.runOnce();
    expect(store.publications.get(variantKey('s1', 'threads'))!.status).toBe('intent');
    expect(alerts('publish_unknown')).toHaveLength(1);
  });

  it('listStaleIntents and markStaleIntentsUnknown take a platform', () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    variantPublication(store, 's1', 'threads', 'intent', msk('11:00'));
    variantPublication(store, 's1', 'linkedin', 'intent', msk('11:00'));
    const at = msk('11:30');
    const keys = (platform?: string) =>
      store.publications.listStaleIntents(INTENT_STALE_MS, at, platform).map((p) => p.key);
    expect(keys('telegram')).toEqual([]);
    expect(keys('threads')).toEqual([variantKey('s1', 'threads')]);
    expect(keys()).toEqual([variantKey('s1', 'linkedin'), variantKey('s1', 'threads')]);
    expect(store.publications.markStaleIntentsUnknown(INTENT_STALE_MS, at, 'threads')).toBe(1);
    expect(store.publications.get(variantKey('s1', 'threads'))!.status).toBe('unknown');
    expect(store.publications.get(variantKey('s1', 'linkedin'))!.status).toBe('intent');
  });
});

describe('4. the stale skip of the Telegram loop touches slots only (publisher.ts skip)', () => {
  it('a slot and its variant both past grace: the slot is skipped, the variant row is not', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    t = msk('14:00');
    const it = await telegram().runOnce();
    expect(it.skipped).toEqual(['s1']);
    expect(slotStatus('s1')).toBe('skipped');
    expect(variantRow(store, 's1', 'threads').status).toBe('planned');
    expect(variantRow(store, 's1', 'linkedin').status).toBe('planned');
    expect(store.publications.listForPlan(DATE)).toEqual([]);
  });
});

describe('5. the preview decides for Telegram from Telegram rows (preflight.ts previewDay)', () => {
  it('a variant sent a minute earlier: the preview still publishes the slot', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    variantPublication(store, 's1', 'threads', 'sent', msk('12:04'));
    const res = await server().inject({
      method: 'GET',
      url: `/v1/plans/${DATE}/preview?now=${encodeURIComponent(msk('12:05').toISOString())}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toEqual({ publish: 's1', skip: [] });
    expect(res.json().slot.id).toBe('s1');
  });
});

describe('6. the slot PUT guard reads Telegram rows only (replace.ts listForSlot)', () => {
  const put = () =>
    server().inject({
      method: 'PUT',
      url: `/v1/plans/${DATE}/slots/s1`,
      headers: auth,
      payload: { text: 'Правка владельца. Кто согласен?', reason: 'owner edit' },
    });

  it('a sent variant of the slot does not block the replacement of the Telegram text', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const sent = variantPublication(store, 's1', 'threads', 'sent', msk('07:59'));
    const variantsBefore = JSON.stringify(store.slotVariants.listForPlan(DATE));
    const res = await put();
    expect(res.statusCode, res.body).toBe(200);
    expect(store.slots.listForPlan(DATE)[0]!.json).toContain('Правка владельца');
    // ... and the replacement leaves the variant and its publication row as they were.
    expect(JSON.stringify(store.slotVariants.listForPlan(DATE))).toBe(variantsBefore);
    expect(store.publications.get(sent.key)).toEqual(sent);
  });

  it('a Telegram row of the slot still blocks it', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    store.publications.beginIntent({
      key: `telegram:${DATE}:s1:0`,
      platform: 'telegram',
      planDate: DATE,
      slotId: 's1',
      textSha256: 'a'.repeat(64),
    });
    const res = await put();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'slot_started', publications: 1 });
  });
});

describe('7. a reject stops every platform (director.ts reject, item 7b)', () => {
  const reject = () =>
    server().inject({
      method: 'POST',
      url: `/v1/plans/${DATE}/reject`,
      headers: auth,
      payload: { reason: 'off topic' },
    });
  const TWO = [
    { id: 's1', at: '09:00' },
    { id: 's2', at: '19:00' },
  ];
  const TWO_VARIANTS = [
    { slot: 's1', platform: 'threads', at: '09:05' },
    { slot: 's2', platform: 'threads', at: '19:05' },
    { slot: 's2', platform: 'linkedin', at: '19:10' },
    { slot: 's2', platform: 'linkedin', lang: 'en', at: '19:30' },
  ] as const;
  const variantStatuses = () =>
    store.slotVariants
      .listForPlan(DATE)
      .map((v) => `${v.slotId}/${v.platform}/${v.lang}:${v.status}`);

  it('nothing started: 200, the planned variants are skipped with the slots', async () => {
    seedVariantPlan(store, TWO, [...TWO_VARIANTS]);
    const res = await reject();
    expect(res.statusCode).toBe(200);
    expect(res.json().skipped).toEqual(['s1', 's2']);
    expect(res.json().skippedVariants).toHaveLength(4);
    expect(variantStatuses()).toEqual([
      's1/threads/ru:skipped',
      's2/threads/ru:skipped',
      's2/linkedin/ru:skipped',
      's2/linkedin/en:skipped',
    ]);
    expect(store.plans.get(DATE)!.status).toBe('rejected');
  });

  it('after the Telegram slot s1 is sent: 409, and the planned variants are skipped too', async () => {
    seedVariantPlan(store, TWO, [...TWO_VARIANTS]);
    t = msk('09:00');
    expect((await telegram().runOnce()).result).toBe('sent');
    const res = await reject();
    expect(res.statusCode).toBe(409);
    expect(res.json().skipped).toEqual(['s2']);
    expect(res.json()).toMatchObject({
      error: 'already started on telegram: a post is out or may be out there',
      startedOn: ['telegram'],
    });
    expect(variantStatuses().every((s) => s.endsWith(':skipped'))).toBe(true);
    // The plan stays approved in this branch, so the claim is refused by the variant status.
    expect(store.plans.get(DATE)!.status).toBe('approved');
    const v = variantRow(store, 's2', 'threads');
    expect(() =>
      store.publications.beginVariantIntent({
        key: variantKey('s2', 'threads'),
        platform: 'threads',
        planDate: DATE,
        slotId: 's2',
        lang: 'ru',
        textSha256: 'f'.repeat(64),
        expectVariantJson: v.json,
      }),
    ).toThrow(VariantNotClaimable);
  });

  it('a variant that is out counts as started: 409 although no Telegram row exists', async () => {
    for (const status of ['sent', 'intent', 'unknown'] as const) {
      store.close();
      store = openStore(':memory:');
      seedVariantPlan(store, TWO, [...TWO_VARIANTS]);
      variantPublication(store, 's1', 'threads', status, msk('09:05'));
      const res = await reject();
      expect(res.statusCode, status).toBe(409);
      // The answer names the platform of what is out: no Telegram slot was sent here.
      expect(res.json(), status).toMatchObject({
        error: 'already started on threads: a post is out or may be out there',
        startedOn: ['threads'],
      });
      expect(JSON.stringify(res.json())).not.toContain('first slot');
      expect(store.slots.listForPlan(DATE).map((s) => s.status)).toEqual(['skipped', 'skipped']);
      // Whatever is still planned is skipped, the variant with the unresolved row included.
      expect(variantStatuses(), status).toEqual([
        `s1/threads/ru:${status === 'sent' ? 'done' : 'skipped'}`,
        's2/threads/ru:skipped',
        's2/linkedin/ru:skipped',
        's2/linkedin/en:skipped',
      ]);
    }
  });

  it('several platforms out: all are named, Telegram first', async () => {
    seedVariantPlan(store, TWO, [...TWO_VARIANTS]);
    variantPublication(store, 's2', 'linkedin', 'unknown', msk('08:59'));
    variantPublication(store, 's1', 'threads', 'sent', msk('09:00'));
    t = msk('09:00');
    expect((await telegram().runOnce()).result).toBe('sent');
    const res = await reject();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'already started on telegram, threads, linkedin: a post is out or may be out there',
      startedOn: ['telegram', 'threads', 'linkedin'],
    });
  });

  it('a day without variants answers exactly as before (no skippedVariants key)', async () => {
    seedVariantPlan(store, TWO, []);
    const res = await reject();
    expect(res.json()).toEqual({ date: DATE, status: 'rejected', skipped: ['s1', 's2'] });
  });
});

describe('8. the read routes show platform and variant status (director.ts GET routes)', () => {
  it('GET /v1/publications returns the platform of each row as a field', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    variantPublication(store, 's1', 'threads', 'sent', msk('12:00'));
    t = msk('12:05');
    await telegram().runOnce();
    const res = await server().inject({
      method: 'GET',
      url: `/v1/publications?date=${DATE}`,
      headers: auth,
    });
    const rows = res.json().publications as { key: string; platform: string; slotId: string }[];
    expect(rows.map((r) => [r.key, r.platform, r.slotId])).toEqual([
      [`telegram:${DATE}:s1:0`, 'telegram', 's1'],
      [`threads:${DATE}:s1-ru:0`, 'threads', 's1'],
    ]);
  });

  it('GET /v1/plans/:date shows the status of each variant; a v1 plan has no such key', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    variantPublication(store, 's1', 'threads', 'sent', msk('12:00'));
    const get = () => server().inject({ method: 'GET', url: `/v1/plans/${DATE}`, headers: auth });
    expect((await get()).json().variants).toEqual([
      {
        slotId: 's1',
        platform: 'threads',
        lang: 'ru',
        at: `${DATE}T12:00:00+03:00`,
        status: 'done',
      },
      {
        slotId: 's1',
        platform: 'linkedin',
        lang: 'ru',
        at: `${DATE}T12:00:30+03:00`,
        status: 'planned',
      },
    ]);
    store.close();
    store = openStore(':memory:');
    seedVariantPlan(store, DAY, []);
    expect(Object.keys((await get()).json()).sort()).toEqual([
      'createdAt',
      'date',
      'plan',
      'slots',
      'status',
    ]);
  });
});

describe('9. the variant claim is its own statement (store beginVariantIntent)', () => {
  const claim = (over: Record<string, unknown> = {}) => {
    const v = variantRow(store, 's1', 'threads');
    return store.publications.beginVariantIntent({
      key: variantKey('s1', 'threads'),
      platform: 'threads',
      planDate: DATE,
      slotId: 's1',
      lang: 'ru',
      textSha256: 'f'.repeat(64),
      expectVariantJson: v.json,
      ...over,
    });
  };

  it('claims once while the plan is approved and the variant is planned and unchanged', () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    expect(claim()).toMatchObject({
      key: `threads:${DATE}:s1-ru:0`,
      platform: 'threads',
      slotId: 's1',
      part: 0,
      status: 'intent',
    });
    expect(() => claim()).toThrow(AlreadyExists);
  });

  it.each(['draft', 'rejected', 'failed'] as const)('refuses a %s plan', (status) => {
    seedVariantPlan(store, DAY, [...VARIANTS], { status });
    expect(() => claim()).toThrow(VariantNotClaimable);
    expect(store.publications.listForPlan(DATE)).toEqual([]);
  });

  it('refuses a variant that is not planned, a changed json and an unknown variant', () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    expect(() => claim({ expectVariantJson: '{"other":true}' })).toThrow(VariantNotClaimable);
    expect(() => claim({ lang: 'en' })).toThrow(VariantNotClaimable);
    expect(() => claim({ slotId: 's9' })).toThrow(VariantNotClaimable);
    store.slotVariants.setStatus(DATE, 's1', 'threads', 'ru', 'skipped');
    expect(() => claim()).toThrow(VariantNotClaimable);
    store.slotVariants.setStatus(DATE, 's1', 'threads', 'ru', 'done');
    expect(() => claim()).toThrow(VariantNotClaimable);
    expect(store.publications.listForPlan(DATE)).toEqual([]);
  });

  it('does not look at the slot row, and the slot claim does not look at the variant', () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const slot = store.slots.listForPlan(DATE)[0]!;
    // The Telegram slot is done (or skipped): its variants are still their own.
    store.slots.setStatus(DATE, 's1', 'done');
    expect(claim().status).toBe('intent');
    // The variant is skipped: the Telegram slot is still claimed by its own statement.
    store.slots.setStatus(DATE, 's1', 'planned');
    store.slotVariants.setStatus(DATE, 's1', 'linkedin', 'ru', 'skipped');
    expect(
      store.publications.beginIntent({
        key: `telegram:${DATE}:s1:0`,
        platform: 'telegram',
        planDate: DATE,
        slotId: 's1',
        textSha256: 'a'.repeat(64),
        expectSlotJson: slot.json,
      }).status,
    ).toBe('intent');
  });
});
