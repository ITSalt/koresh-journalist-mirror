import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPublisher } from '../../src/publish/publisher.js';
import { DEFAULT_MIGRATIONS_DIR } from '../../src/store/migrate.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { CHANNEL, DATE, msk, seedPlan, TOKEN } from '../publish/helpers.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';
import { png, sha256 } from '../support/images.js';

describe('store.images (migration 005)', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  it('stores an image under the sha256 of its bytes; meta has no bytes, get has them', () => {
    const bytes = png(640, 480);
    const at = new Date('2026-10-12T10:00:00Z');
    const r = store.images.add({ mime: 'image/png', bytes, width: 640, height: 480 }, at);
    const meta = {
      sha256: sha256(bytes),
      mime: 'image/png',
      size: bytes.length,
      width: 640,
      height: 480,
      createdAt: at.toISOString(),
    };
    expect(r).toEqual({ image: meta, created: true });
    expect(store.images.meta(meta.sha256)).toEqual(meta);
    const full = store.images.get(meta.sha256)!;
    expect(full.bytes.equals(bytes)).toBe(true);
    expect({ ...full, bytes: undefined }).toEqual({ ...meta, bytes: undefined });
  });

  it('the same bytes again change nothing: one row, the first facts stay', () => {
    const bytes = png(640, 480);
    const first = new Date('2026-10-12T10:00:00Z');
    store.images.add({ mime: 'image/png', bytes, width: 640, height: 480 }, first);
    const again = store.images.add(
      { mime: 'image/jpeg', bytes, width: 1, height: 2 },
      new Date('2026-10-13T10:00:00Z'),
    );
    expect(again.created).toBe(false);
    expect(again.image).toMatchObject({
      mime: 'image/png',
      width: 640,
      height: 480,
      createdAt: first.toISOString(),
    });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM images').get()).toEqual({ n: 1 });
  });

  it('an unknown sha256 is undefined; another format than PNG or JPEG is refused', () => {
    expect(store.images.meta('0'.repeat(64))).toBeUndefined();
    expect(store.images.get('0'.repeat(64))).toBeUndefined();
    expect(() =>
      store.images.add({
        mime: 'image/gif' as 'image/png',
        bytes: Buffer.from('GIF89a'),
        width: 1,
        height: 1,
      }),
    ).toThrow(/CHECK/);
  });
});

// Acceptance 10: migration 005 on a database that is at schema 004 and holds an approved plan,
// as the live one does at the deploy. It is additive: the old rows are untouched and the old
// slots still publish.
describe('migration 005 on a database at schema 004', () => {
  let dir: string;
  let fake: FakeBotApi;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jrn-mig5-'));
    fake = await new FakeBotApi(TOKEN).start();
  });
  afterEach(async () => {
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies alone, keeps every old row, and the old slots publish as before', async () => {
    const old = join(dir, 'migrations-004');
    mkdirSync(old);
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
      if (f < '005') cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
    }
    expect(readdirSync(old)).toHaveLength(4);
    const db = join(dir, 'journalist.db');

    const before = openStore(db, { migrationsDir: old });
    expect(before.migrationsApplied).toHaveLength(4);
    expect(() => before.db.prepare('SELECT 1 FROM images').get()).toThrow(/no such table/);
    seedPlan(before, [
      { id: 's1', at: '09:00', text: 'Утро. Кто первый?' },
      { id: 's2', at: '19:00', text: 'Вечер. Кто последний?' },
    ]);
    // s1 went out before the deploy.
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
      // 006 (WP-PLAT-01), 007 (WP-PLAT-06) and 008 (WP-PLAT-02) are later migrations that the
      // same boot applies after 005.
      expect(after.migrationsApplied).toEqual([
        '005_images.sql',
        '006_slot_variants.sql',
        '007_connect.sql',
        '008_publication_url_step.sql',
        '009_owner_inbox_files.sql',
      ]);
      expect(dump(after)).toEqual(was);
      expect(after.db.prepare('SELECT COUNT(*) AS n FROM images').get()).toEqual({ n: 0 });

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
      expect(fake.requests.map((r) => r.method)).toEqual(['sendMessage']);
      expect(fake.channel[0]!.text).toContain('Вечер\\. Кто последний?');
      expect(after.publications.listForPlan(DATE).map((p) => [p.slotId, p.status])).toEqual([
        ['s1', 'sent'],
        ['s2', 'sent'],
      ]);
    } finally {
      after.close();
    }

    // A second boot applies nothing.
    const third = openStore(db);
    expect(third.migrationsApplied).toEqual([]);
    third.close();
  });
});
