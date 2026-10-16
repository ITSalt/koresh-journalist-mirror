import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR } from '../../src/store/migrate.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { createInboxPoller, inboxFilesOf } from '../../src/telegram/inbox.js';
import { TOKEN } from '../publish/helpers.js';
import { FakeBotApi } from '../support/fake-bot-api.js';

// The owner's pictures in the inbox: a photo (its largest size) or an image document is kept as
// a Telegram file reference next to its row; an album shares media_group_id. Nothing of a
// stranger is kept, and no file id, caption or text reaches a log line.

const OWNER = 555000111;
const STRANGER = 777000222;

let fake: FakeBotApi;
let dir: string;
let store: Store;
let logs: string[];
const log = {
  info: (o: object, m?: string) => logs.push(JSON.stringify([o, m])),
  warn: (o: object, m?: string) => logs.push(JSON.stringify([o, m])),
  error: (o: object, m?: string) => logs.push(JSON.stringify([o, m])),
};
const poll = () =>
  createInboxPoller({
    api: createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 2000 }),
    store,
    ownerChatId: OWNER,
    log,
    sleep: async () => undefined,
  }).pollOnce();

const update = (
  update_id: number,
  message: Record<string, unknown>,
  chat: Record<string, unknown> = { id: OWNER, type: 'private' },
  from: Record<string, unknown> = { id: OWNER },
) => ({
  update_id,
  message: { message_id: update_id + 1000, date: 1_790_000_000, chat, from, ...message },
});
/** Telegram's photo sizes, smallest first. */
const photo = (tag: string) => [
  {
    file_id: `FID-${tag}-s`,
    file_unique_id: `UID-${tag}-s`,
    width: 90,
    height: 60,
    file_size: 1200,
  },
  {
    file_id: `FID-${tag}-m`,
    file_unique_id: `UID-${tag}-m`,
    width: 320,
    height: 213,
    file_size: 15000,
  },
  {
    file_id: `FID-${tag}-x`,
    file_unique_id: `UID-${tag}-x`,
    width: 1280,
    height: 853,
    file_size: 160000,
  },
];
const rows = () => store.inbox.listAfter(0);
const fileRows = () =>
  store.db.prepare('SELECT * FROM owner_inbox_files ORDER BY inbox_id, idx').all();

beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
  dir = mkdtempSync(join(tmpdir(), 'journalist-inbox-files-'));
  store = openStore(join(dir, 'state.db'));
  logs = [];
});
afterEach(async () => {
  try {
    store.close();
  } catch {
    // closed by the test
  }
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('owner pictures in the inbox', () => {
  it('a photo with a caption: kind photo, the caption as text, the largest size kept', async () => {
    fake.pushUpdate(update(1, { photo: photo('a'), caption: 'generated, the left one' }));
    await poll();
    const [row] = rows();
    expect(row).toMatchObject({
      kind: 'photo',
      text: 'generated, the left one',
      mediaGroupId: null,
    });
    expect(store.inbox.fileMeta([row!.id]).get(row!.id)).toEqual([
      { idx: 0, mime: null, width: 1280, height: 853 },
    ]);
    expect(store.inbox.file(row!.id, 0)).toMatchObject({
      fileId: 'FID-a-x',
      fileUniqueId: 'UID-a-x',
    });
    expect(fileRows()).toHaveLength(1);
  });

  it('the largest size is chosen by pixels, whatever the order', () => {
    const sizes = [...photo('b')].reverse();
    expect(inboxFilesOf({ photo: sizes })?.files[0]?.fileId).toBe('FID-b-x');
    // Same pixels: the larger file wins.
    expect(
      inboxFilesOf({
        photo: [
          { file_id: 'p1', file_unique_id: 'u1', width: 10, height: 10, file_size: 5 },
          { file_id: 'p2', file_unique_id: 'u2', width: 10, height: 10, file_size: 9 },
        ],
      })?.files[0]?.fileId,
    ).toBe('p2');
    // Sizes without ids are not a photo.
    expect(inboxFilesOf({ photo: [{}] })).toBeUndefined();
  });

  it('an image document: kind document, its mime, no pixel size', async () => {
    fake.pushUpdate(
      update(2, {
        document: {
          file_id: 'FID-doc',
          file_unique_id: 'UID-doc',
          file_name: 'real-product.png',
          mime_type: 'image/png',
          file_size: 2_000_000,
          thumbnail: { file_id: 'FID-thumb', file_unique_id: 'UID-thumb', width: 320, height: 320 },
        },
        caption: 'real',
      }),
    );
    await poll();
    const [row] = rows();
    expect(row).toMatchObject({ kind: 'document', text: 'real' });
    expect(store.inbox.fileMeta([row!.id]).get(row!.id)).toEqual([
      { idx: 0, mime: 'image/png', width: null, height: null },
    ]);
    expect(store.inbox.file(row!.id, 0)?.fileId).toBe('FID-doc');
  });

  it.each(['image/jpeg', 'image/webp', 'IMAGE/JPEG'])('a %s document is kept', async (mime) => {
    fake.pushUpdate(
      update(3, { document: { file_id: 'F', file_unique_id: 'U', mime_type: mime } }),
    );
    await poll();
    expect(rows()[0]!.kind).toBe('document');
    expect(fileRows()).toHaveLength(1);
  });

  it('an album of two: two rows with the same media_group_id, each with its file', async () => {
    fake.pushUpdate(update(10, { media_group_id: '13579', photo: photo('g1'), caption: 'pair 1' }));
    fake.pushUpdate(
      update(11, {
        media_group_id: '13579',
        document: { file_id: 'FID-g2', file_unique_id: 'UID-g2', mime_type: 'image/jpeg' },
      }),
    );
    fake.pushUpdate(update(12, { media_group_id: '24680', photo: photo('h1') }));
    await poll();
    const all = rows();
    expect(all.map((r) => [r.kind, r.mediaGroupId, r.text])).toEqual([
      ['photo', '13579', 'pair 1'],
      ['document', '13579', ''],
      ['photo', '24680', ''],
    ]);
    const meta = store.inbox.fileMeta(all.map((r) => r.id));
    expect(all.map((r) => meta.get(r.id)?.length)).toEqual([1, 1, 1]);
    expect(store.inbox.file(all[1]!.id, 0)?.fileId).toBe('FID-g2');
  });

  it('a photo from a stranger, or in a group, is dropped: no row, no file', async () => {
    fake.pushUpdate(
      update(
        20,
        { photo: photo('s'), caption: 'hi' },
        { id: STRANGER, type: 'private' },
        { id: STRANGER },
      ),
    );
    fake.pushUpdate(update(21, { photo: photo('g') }, { id: -100500, type: 'group' }));
    await poll();
    expect(rows()).toEqual([]);
    expect(fileRows()).toEqual([]);
    expect(logs.join('\n')).toContain('"dropped":2');
  });

  it('a document that is not an image is kind other, with no file', async () => {
    fake.pushUpdate(
      update(30, {
        document: { file_id: 'FID-pdf', file_unique_id: 'UID-pdf', mime_type: 'application/pdf' },
        caption: 'the brief',
      }),
    );
    fake.pushUpdate(update(31, { document: { file_id: 'FID-x', file_unique_id: 'UID-x' } }));
    fake.pushUpdate(update(32, { sticker: { file_id: 'FID-st', file_unique_id: 'UID-st' } }));
    await poll();
    expect(rows().map((r) => [r.kind, r.text])).toEqual([
      ['other', 'the brief'],
      ['other', ''],
      ['other', ''],
    ]);
    expect(fileRows()).toEqual([]);
  });

  it('a text message stays kind text and has no file', async () => {
    fake.pushUpdate(update(40, { text: 'plain' }));
    await poll();
    expect(rows().map((r) => [r.kind, r.text, r.mediaGroupId])).toEqual([['text', 'plain', null]]);
    expect(fileRows()).toEqual([]);
  });

  it('a repeated update stores neither the row nor its file twice', async () => {
    fake.pushUpdate(update(50, { photo: photo('r') }));
    await poll();
    store.botState.set('tg_updates_offset', '0');
    fake.pushUpdate(update(50, { photo: photo('r') }));
    await poll();
    expect(rows()).toHaveLength(1);
    expect(fileRows()).toHaveLength(1);
  });

  it('no file id, caption or text in any log line', async () => {
    fake.pushUpdate(update(60, { photo: photo('secret'), caption: 'CAPTION-MARKER-1' }));
    fake.pushUpdate(
      update(61, {
        document: {
          file_id: 'FID-DOC-MARKER',
          file_unique_id: 'UID-DOC-MARKER',
          mime_type: 'image/png',
        },
        caption: 'CAPTION-MARKER-2',
      }),
    );
    await poll();
    const all = logs.join('\n');
    expect(all).not.toMatch(/FID-|UID-|CAPTION-MARKER/);
    expect(all).toContain('"stored":2');
  });
});

describe('migration 009 on a database at schema 008', () => {
  it('keeps every inbox row and id, and takes the new kinds', () => {
    const old = join(dir, 'migrations-008');
    mkdirSync(old);
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
      if (f < '009') cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
    }
    const db = join(dir, 'old.db');
    const before = openStore(db, { migrationsDir: old });
    // Rows as the code before this migration wrote them (without media_group_id).
    const insert = before.db.prepare(
      'INSERT INTO owner_inbox (update_id, message_id, at, text, kind) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run(1, 101, '2026-10-14T10:00:00.000Z', 't1', 'text');
    insert.run(2, 102, '2026-10-14T10:01:00.000Z', 't2', 'other');
    insert.run(4, 104, '2026-10-14T10:02:00.000Z', 't4', 'text');
    // The newest row is gone: its id (3) must never be given again.
    before.db.prepare('DELETE FROM owner_inbox WHERE update_id = 4').run();
    expect(() =>
      before.db
        .prepare(
          "INSERT INTO owner_inbox (update_id, message_id, at, text, kind) VALUES (9, 9, 'x', '', 'photo')",
        )
        .run(),
    ).toThrow(/CHECK/);
    const was = before.db.prepare('SELECT * FROM owner_inbox ORDER BY id').all() as {
      id: number;
    }[];
    expect(was.map((r) => r.id)).toEqual([1, 2]);
    before.close();

    const after = openStore(db);
    try {
      expect(after.migrationsApplied).toEqual(['009_owner_inbox_files.sql']);
      expect(after.db.prepare('SELECT * FROM owner_inbox ORDER BY id').all()).toEqual(
        was.map((r) => ({ ...r, media_group_id: null })),
      );
      expect(
        after.inbox.add({
          updateId: 3,
          messageId: 103,
          at: 'y',
          text: '',
          kind: 'photo',
          mediaGroupId: 'g',
          files: [{ idx: 0, fileId: 'f', fileUniqueId: 'u', mime: null, width: 1, height: 1 }],
        }),
      ).toBe(true);
      const ids = after.inbox.listAfter(0).map((r) => r.id);
      // AUTOINCREMENT goes on after the highest id ever given (3), not after the highest kept.
      expect(ids).toEqual([1, 2, 4]);
      expect(() =>
        after.db
          .prepare(
            "INSERT INTO owner_inbox (update_id, message_id, at, text, kind) VALUES (8, 8, 'x', '', 'video')",
          )
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      after.close();
    }
  });
});
