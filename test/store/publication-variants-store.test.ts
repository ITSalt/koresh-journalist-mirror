import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPublisher } from '../../src/publish/publisher.js';
import { DEFAULT_MIGRATIONS_DIR } from '../../src/store/migrate.js';
import {
  AlreadyExists,
  openStore,
  VariantNotClaimable,
  type Store,
} from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { CHANNEL, DATE, msk, seedPlan, TOKEN } from '../publish/helpers.js';
import {
  seedVariantPlan,
  variantKey,
  variantPublication,
  variantRow,
} from '../publish/variant-helpers.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';

// WP-PLAT-02: what the store gained for the publications of variants: migration 008 (`url` and
// `step` on a publication row), the write of a posted variant, the step record, the claim of a
// first comment, and variants listed by instant.

const DAY = [{ id: 's1', at: '09:00', text: 'Утро. Кто первый?' }];
const VARIANTS = [
  { slot: 's1', platform: 'threads', at: '09:07:41' },
  { slot: 's1', platform: 'linkedin', at: '09:10' },
] as const;

describe('migration 008 on a database of schema 007', () => {
  let dir: string;
  let fake: FakeBotApi;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jrn-m007-'));
    fake = await new FakeBotApi(TOKEN).start();
  });
  afterEach(async () => {
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies alone, keeps every old row as it reads, and the old plan publishes as before', async () => {
    const old = join(dir, 'migrations-007');
    mkdirSync(old);
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
      if (f < '008') cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
    }
    expect(readdirSync(old)).toHaveLength(7);
    const db = join(dir, 'journalist.db');

    const before = openStore(db, { migrationsDir: old });
    expect(before.migrationsApplied).toHaveLength(7);
    expect(() => before.db.prepare('SELECT url, step FROM publications').all()).toThrow(
      /no such column/,
    );
    seedPlan(before, [
      { id: 's1', at: '09:00', text: 'Утро. Кто первый?' },
      { id: 's2', at: '19:00', text: 'Вечер. Кто последний?' },
    ]);
    const key = `telegram:${DATE}:s1:0`;
    before.publications.beginIntent(
      { key, platform: 'telegram', planDate: DATE, slotId: 's1', textSha256: 'x' },
      msk('09:00:01'),
    );
    before.publications.markSent(key, '41', msk('09:00:02'));
    before.slots.setStatus(DATE, 's1', 'done');
    const dump = (s: Store) => ({
      plan: s.plans.get(DATE),
      slots: s.slots.listForPlan(DATE),
      pubs: s.publications.listForPlan(DATE),
    });
    const was = dump(before);
    before.close();

    const after = openStore(db);
    try {
      expect(after.migrationsApplied).toEqual([
        '008_publication_url_step.sql',
        '009_owner_inbox_files.sql',
      ]);
      // A Telegram row reads with exactly the keys it had: no `url`, no `step`.
      expect(dump(after)).toEqual(was);
      expect(Object.keys(after.publications.get(key)!)).toEqual(Object.keys(was.pubs[0]!));
      expect(after.db.prepare('SELECT url, step FROM publications').all()).toEqual([
        { url: null, step: null },
      ]);

      const publisher = createPublisher({
        store: after,
        blocks,
        api: createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 5000 }),
        channel: CHANNEL,
        dryRun: false,
        tz: 'Europe/Moscow',
        now: () => msk('19:00:30'),
        sleep: async () => undefined,
      });
      expect(await publisher.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
      expect(after.publications.listForPlan(DATE).map((p) => Object.keys(p).length)).toEqual([
        Object.keys(was.pubs[0]!).length,
        Object.keys(was.pubs[0]!).length,
      ]);
    } finally {
      after.close();
    }
    const third = openStore(db);
    expect(third.migrationsApplied).toEqual([]);
    third.close();
  });
});

describe('publications of variants', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
    seedVariantPlan(store, DAY, [...VARIANTS]);
  });
  afterEach(() => store.close());

  it('markPosted writes the id and the url in one step, only from an intent', () => {
    const key = variantKey('s1', 'threads');
    variantPublication(store, 's1', 'threads', 'intent', msk('09:07:41'));
    const at = msk('09:07:43');
    expect(
      store.publications.markPosted(key, { id: '179', url: 'https://t.example/p' }, at),
    ).toMatchObject({
      status: 'sent',
      messageId: '179',
      url: 'https://t.example/p',
      sentAt: at.toISOString(),
    });
    expect(() => store.publications.markPosted(key, { id: '180' })).toThrow(
      /is sent, expected intent/,
    );
    expect(() => store.publications.markPosted('nope', { id: '1' })).toThrow(/not found/);
    // A post without a public address has no `url` key.
    variantPublication(store, 's1', 'linkedin', 'intent', msk('09:10'));
    const li = store.publications.markPosted(variantKey('s1', 'linkedin'), { id: 'urn:x' });
    expect('url' in li).toBe(false);
  });

  it('setStep records on an intent row only and shows up as `step`', () => {
    const key = variantKey('s1', 'threads');
    expect(() => store.publications.setStep(key, '{"step":"container"}')).toThrow(/not an intent/);
    const row = variantPublication(store, 's1', 'threads', 'intent', msk('09:07:41'));
    expect('step' in row).toBe(false);
    store.publications.setStep(key, '{"step":"publish"}');
    expect(store.publications.get(key)!.step).toBe('{"step":"publish"}');
    store.publications.markFailed(key, 'x');
    expect(() => store.publications.setStep(key, '{"step":"container"}')).toThrow(/not an intent/);
    expect(store.publications.get(key)!.step).toBe('{"step":"publish"}');
  });

  describe('beginCommentIntent', () => {
    const post = variantKey('s1', 'linkedin');
    const comment = variantKey('s1', 'linkedin', 'ru', 1);
    const claim = (over: Record<string, unknown> = {}) =>
      store.publications.beginCommentIntent({
        key: comment,
        platform: 'linkedin',
        planDate: DATE,
        slotId: 's1',
        lang: 'ru',
        part: 1,
        textSha256: 'c'.repeat(64),
        postKey: post,
        ...over,
      });
    /** The post is sent and the variant waits for its comment (still `planned`). */
    const sentPost = () => {
      variantPublication(store, 's1', 'linkedin', 'intent', msk('09:10'));
      store.publications.markPosted(post, { id: 'urn:li:share:1' }, msk('09:10:01'));
    };

    it('claims once while the post is sent, the plan approved and the variant planned', () => {
      sentPost();
      expect(claim()).toMatchObject({ key: comment, part: 1, status: 'intent', slotId: 's1' });
      expect(() => claim()).toThrow(AlreadyExists);
    });

    it.each(['intent', 'unknown', 'failed', 'dry'] as const)(
      'refuses while the post row is %s',
      (status) => {
        variantPublication(store, 's1', 'linkedin', status, msk('09:10'));
        if (status === 'dry') store.slotVariants.setStatus(DATE, 's1', 'linkedin', 'ru', 'planned');
        expect(() => claim()).toThrow(VariantNotClaimable);
      },
    );

    it('refuses without a post row, for another variant, after a reject and when the day stopped', () => {
      expect(() => claim()).toThrow(VariantNotClaimable);
      sentPost();
      expect(() => claim({ lang: 'en' })).toThrow(VariantNotClaimable);
      expect(() => claim({ platform: 'threads' })).toThrow(VariantNotClaimable);
      expect(() => claim({ postKey: variantKey('s1', 'threads') })).toThrow(VariantNotClaimable);
      store.slotVariants.setStatus(DATE, 's1', 'linkedin', 'ru', 'skipped');
      expect(() => claim()).toThrow(VariantNotClaimable);
      store.slotVariants.setStatus(DATE, 's1', 'linkedin', 'ru', 'planned');
      store.plans.setStatus(DATE, 'rejected');
      expect(() => claim()).toThrow(VariantNotClaimable);
      expect(store.publications.get(comment)).toBeUndefined();
    });
  });
});

describe('slotVariants.listForPlan orders by instant (item 10)', () => {
  it('`09:05+03:00` comes before `09:05:30+03:00` and after `09:04:59+03:00`', () => {
    const store = openStore(':memory:');
    try {
      seedVariantPlan(
        store,
        [
          { id: 'a', at: '09:00' },
          { id: 'b', at: '09:01' },
        ],
        [],
      );
      const row = (slotId: string, platform: 'threads' | 'linkedin', at: string) => ({
        slotId,
        platform,
        lang: 'ru' as const,
        at,
        json: JSON.stringify({ platform, lang: 'ru', at, text: 'x' }),
      });
      store.slotVariants.replaceForPlan(DATE, [
        // As text, "09:05+03:00" sorts after "09:05:30+03:00" (':' is greater than '+').
        row('a', 'threads', `${DATE}T09:05:30+03:00`),
        row('b', 'threads', `${DATE}T09:05+03:00`),
        row('a', 'linkedin', `${DATE}T09:04:59+03:00`),
        row('b', 'linkedin', `${DATE}T09:05:00+03:00`),
      ]);
      expect(store.slotVariants.listForPlan(DATE).map((v) => `${v.slotId}/${v.platform}`)).toEqual([
        'a/linkedin',
        // The same instant written two ways: slot, then platform.
        'b/linkedin',
        'b/threads',
        'a/threads',
      ]);
      expect(variantRow(store, 'b', 'threads').at).toBe(`${DATE}T09:05+03:00`);
    } finally {
      store.close();
    }
  });
});
