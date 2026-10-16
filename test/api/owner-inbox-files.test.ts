import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { INBOX_FILE_MAX_BYTES, sniffImage } from '../../src/api/owner-inbox.js';
import { buildPublicServer, buildServer } from '../../src/server.js';
import { createConnectService } from '../../src/connect/service.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { createInboxPoller } from '../../src/telegram/inbox.js';
import { TOKEN as BOT_TOKEN } from '../publish/helpers.js';
import { FakeBotApi } from '../support/fake-bot-api.js';

// GET /v1/owner/inbox and GET /v1/owner/inbox/<id>/files/<idx>: the owner's pictures, listed
// without Telegram file ids and fetched through getFile and the file download of a fake Bot
// API. Main listener only, behind the bearer; nothing on the public listener.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const OWNER = 555000111;
const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(300_000, 7)]);
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  Buffer.alloc(5000, 1),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'),
  Buffer.alloc(800, 2),
]);

let fake: FakeBotApi;
let store: Store;
let lines: string[];
beforeEach(async () => {
  fake = await new FakeBotApi(BOT_TOKEN).start();
  store = openStore(':memory:');
  lines = [];
});
afterEach(async () => {
  store.close();
  await fake.stop();
});

const botApi = () => createBotApi({ token: BOT_TOKEN, baseUrl: fake.baseUrl, timeoutMs: 2000 });
const config = (env: Record<string, string> = {}) =>
  loadConfig({ JOURNALIST_API_TOKEN: API_TOKEN, TELEGRAM_BOT_TOKEN: BOT_TOKEN, ...env });
function app(o: { withApi?: boolean; maxBytes?: number } = {}) {
  return buildServer({
    config: config(),
    store,
    logStream: { write: (l: string) => void lines.push(l) },
    logLevel: 'info',
    owner: {
      chatId: OWNER,
      channel: '@Channel1',
      ...(o.withApi === false ? {} : { api: botApi() }),
      ...(o.maxBytes !== undefined ? { fileMaxBytes: o.maxBytes } : {}),
    },
  });
}

const msg = (update_id: number, message: Record<string, unknown>) => ({
  update_id,
  message: {
    message_id: update_id + 1000,
    date: 1_790_000_000,
    chat: { id: OWNER, type: 'private' },
    from: { id: OWNER },
    ...message,
  },
});
async function seed() {
  fake.files['FID-photo-x'] = { path: 'photos/file_7.jpg', bytes: JPEG };
  fake.files['FID-doc'] = { path: 'documents/file_8.png', bytes: PNG };
  fake.files['FID-webp'] = { path: 'documents/file_9.webp', bytes: WEBP };
  fake.pushUpdate(
    msg(1, {
      media_group_id: 'G1',
      caption: 'generated',
      photo: [
        { file_id: 'FID-photo-s', file_unique_id: 'U-s', width: 90, height: 90 },
        { file_id: 'FID-photo-x', file_unique_id: 'U-x', width: 1280, height: 1280 },
      ],
    }),
  );
  fake.pushUpdate(
    msg(2, {
      media_group_id: 'G1',
      document: { file_id: 'FID-doc', file_unique_id: 'U-doc', mime_type: 'image/png' },
    }),
  );
  fake.pushUpdate(msg(3, { text: 'the pair above: left generated, right real' }));
  fake.pushUpdate(
    msg(4, { document: { file_id: 'FID-webp', file_unique_id: 'U-w', mime_type: 'image/webp' } }),
  );
  await createInboxPoller({
    api: botApi(),
    store,
    ownerChatId: OWNER,
    log: { info() {}, warn() {}, error() {} },
    sleep: async () => undefined,
  }).pollOnce();
  return store.inbox.listAfter(0).map((r) => r.id);
}

describe('GET /v1/owner/inbox', () => {
  it('lists the rows after `since` with kind, album, text and files, never a file id', async () => {
    const [a, b, c, d] = await seed();
    const res = await app().inject({
      method: 'GET',
      url: '/v1/owner/inbox?since=0',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages).toEqual([
      {
        id: a,
        at: '2026-09-21T14:13:20.000Z',
        kind: 'photo',
        mediaGroupId: 'G1',
        text: 'generated',
        replyToMessageId: null,
        draftId: null,
        files: [{ idx: 0, mime: null, width: 1280, height: 1280 }],
      },
      {
        id: b,
        at: '2026-09-21T14:13:20.000Z',
        kind: 'document',
        mediaGroupId: 'G1',
        text: '',
        replyToMessageId: null,
        draftId: null,
        files: [{ idx: 0, mime: 'image/png', width: null, height: null }],
      },
      {
        id: c,
        at: '2026-09-21T14:13:20.000Z',
        kind: 'text',
        mediaGroupId: null,
        text: 'the pair above: left generated, right real',
        replyToMessageId: null,
        draftId: null,
        files: [],
      },
      {
        id: d,
        at: '2026-09-21T14:13:20.000Z',
        kind: 'document',
        mediaGroupId: null,
        text: '',
        replyToMessageId: null,
        draftId: null,
        files: [{ idx: 0, mime: 'image/webp', width: null, height: null }],
      },
    ]);
    expect(body.next).toBe(d);
    expect(res.body).not.toMatch(/FID-|U-x|U-doc|file_id|fileId/);
    const later = await app().inject({
      method: 'GET',
      url: `/v1/owner/inbox?since=${b}&limit=1`,
      headers: auth,
    });
    expect(later.json().messages.map((m: { id: number }) => m.id)).toEqual([c]);
    expect(later.json().next).toBe(c);
  });

  it('refuses a bad since or limit, and needs the bearer', async () => {
    for (const q of ['since=-1', 'since=x', 'since=', 'limit=0', 'limit=501']) {
      const res = await app().inject({ method: 'GET', url: `/v1/owner/inbox?${q}`, headers: auth });
      expect(res.statusCode, q).toBe(400);
    }
    expect((await app().inject({ method: 'GET', url: '/v1/owner/inbox' })).statusCode).toBe(401);
    expect(
      (await app().inject({ method: 'GET', url: '/v1/owner/inbox/1/files/0' })).statusCode,
    ).toBe(401);
  });

  it('the old GET /v1/inbox answers exactly as before', async () => {
    await seed();
    const res = await app().inject({ method: 'GET', url: '/v1/inbox', headers: auth });
    expect(Object.keys(res.json().messages[0]).sort()).toEqual([
      'at',
      'draftId',
      'draftLabel',
      'draftRef',
      'id',
      'kind',
      'replyToMessageId',
      'text',
    ]);
  });
});

describe('GET /v1/owner/inbox/<id>/files/<idx>', () => {
  it('streams the photo from Telegram with the type read from its bytes; logs status and size only', async () => {
    const [a] = await seed();
    const res = await app().inject({
      method: 'GET',
      url: `/v1/owner/inbox/${a}/files/0`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-length']).toBe(String(JPEG.length));
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload.equals(JPEG)).toBe(true);
    // getFile with the stored id, then the download of the path it gave.
    expect(fake.sent('getFile').map((r) => r.body)).toEqual([{ file_id: 'FID-photo-x' }]);
    expect(fake.downloads).toEqual(['photos/file_7.jpg']);
    const log = lines.join('');
    const line = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'owner inbox file');
    expect(line).toMatchObject({ status: 200, size: JPEG.length });
    expect(Object.keys(line).sort()).toEqual([
      'hostname',
      'level',
      'msg',
      'pid',
      'reqId',
      'size',
      'status',
      'time',
    ]);
    expect(log).not.toMatch(/FID-|file_7|photos\/|U-x/);
    expect(log).not.toContain(BOT_TOKEN);
  });

  it.each([
    [1, 'image/png', () => PNG],
    [3, 'image/webp', () => WEBP],
  ])('row %#: an image document streams as %s', async (n, type, bytes) => {
    const ids = await seed();
    const id = n === 1 ? ids[1] : ids[3];
    const res = await app().inject({
      method: 'GET',
      url: `/v1/owner/inbox/${id}/files/0`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(type);
    expect(res.rawPayload.equals(bytes())).toBe(true);
  });

  it('nothing is stored on the server: the bytes are in no table', async () => {
    const [a] = await seed();
    await app().inject({ method: 'GET', url: `/v1/owner/inbox/${a}/files/0`, headers: auth });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM images').get()).toEqual({ n: 0 });
    const cols = store.db.prepare("SELECT name FROM pragma_table_info('owner_inbox_files')").all();
    expect(cols.map((c) => (c as { name: string }).name)).toEqual([
      'inbox_id',
      'idx',
      'file_id',
      'file_unique_id',
      'mime',
      'width',
      'height',
    ]);
  });

  it('a file over the cap that getFile announces: 413, and no download at all', async () => {
    const [a] = await seed();
    fake.files['FID-photo-x']!.size = INBOX_FILE_MAX_BYTES + 1;
    const res = await app().inject({
      method: 'GET',
      url: `/v1/owner/inbox/${a}/files/0`,
      headers: auth,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'file over 20 MB' });
    expect(fake.downloads).toEqual([]);
    expect(INBOX_FILE_MAX_BYTES).toBe(20 * 1024 * 1024);
  });

  it('a download longer than the cap by its content-length: 413 before any byte is sent', async () => {
    const [a] = await seed();
    fake.files['FID-photo-x']!.size = null;
    const res = await app({ maxBytes: 1000 }).inject({
      method: 'GET',
      url: `/v1/owner/inbox/${a}/files/0`,
      headers: auth,
    });
    expect(res.statusCode).toBe(413);
    expect(fake.downloads).toEqual(['photos/file_7.jpg']);
  });

  it('a download that turns out longer than the cap without saying so is cut off', async () => {
    const [a] = await seed();
    fake.files['FID-photo-x']!.size = null;
    fake.files['FID-photo-x']!.chunked = true;
    const res = await app({ maxBytes: 100_000 })
      .inject({ method: 'GET', url: `/v1/owner/inbox/${a}/files/0`, headers: auth })
      .catch((err: unknown) => err);
    // Either the response is cut short or the request fails: never the whole file.
    if (res instanceof Error) expect(res).toBeInstanceOf(Error);
    else expect((res as { rawPayload: Buffer }).rawPayload.length).toBeLessThan(JPEG.length);
    const line = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'owner inbox file');
    expect(line).toMatchObject({ status: 413 });
  });

  it('bytes that are not an image: 415, nothing sent on', async () => {
    const [a] = await seed();
    fake.files['FID-photo-x']!.bytes = Buffer.from('<html>not a picture</html>');
    const res = await app().inject({
      method: 'GET',
      url: `/v1/owner/inbox/${a}/files/0`,
      headers: auth,
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'not an image' });
  });

  it('a stored non-image mime is refused without asking Telegram', async () => {
    const [a] = await seed();
    store.db
      .prepare("UPDATE owner_inbox_files SET mime = 'application/pdf' WHERE inbox_id = ?")
      .run(a);
    const res = await app().inject({
      method: 'GET',
      url: `/v1/owner/inbox/${a}/files/0`,
      headers: auth,
    });
    expect(res.statusCode).toBe(415);
    expect(fake.sent('getFile')).toEqual([]);
  });

  it('an unknown message or index is 404, a bad one 400, and without the bot token 409', async () => {
    const [a, , c] = await seed();
    for (const url of [
      `/v1/owner/inbox/${a}/files/1`,
      `/v1/owner/inbox/${c}/files/0`,
      '/v1/owner/inbox/999/files/0',
    ]) {
      expect((await app().inject({ method: 'GET', url, headers: auth })).statusCode, url).toBe(404);
    }
    for (const url of ['/v1/owner/inbox/x/files/0', '/v1/owner/inbox/1/files/-1']) {
      expect((await app().inject({ method: 'GET', url, headers: auth })).statusCode, url).toBe(400);
    }
    const none = await app({ withApi: false }).inject({
      method: 'GET',
      url: `/v1/owner/inbox/${a}/files/0`,
      headers: auth,
    });
    expect(none.statusCode).toBe(409);
    expect(fake.sent('getFile')).toEqual([]);
  });

  it("a getFile refusal is 502 without Telegram's text", async () => {
    const [a] = await seed();
    fake.replies.getFile = [{ status: 400, description: 'Bad Request: wrong file_id FID-photo-x' }];
    const res = await app().inject({
      method: 'GET',
      url: `/v1/owner/inbox/${a}/files/0`,
      headers: auth,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'getFile failed: client 400' });
    expect(fake.downloads).toEqual([]);
    expect(lines.join('')).not.toContain('FID-photo-x');
  });

  it('a download the file server answers 404 is 502', async () => {
    const [a] = await seed();
    fake.files['FID-photo-x']!.gone = true;
    const res = await app().inject({
      method: 'GET',
      url: `/v1/owner/inbox/${a}/files/0`,
      headers: auth,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'download failed: client 404' });
    expect(fake.downloads).toEqual(['photos/file_7.jpg']);
    const line = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'owner inbox file');
    expect(line).toMatchObject({ status: 502 });
    expect(line).not.toHaveProperty('size');
  });
});

describe('the public listener', () => {
  it('has no inbox route: 404, with or without the bearer', async () => {
    const [a] = await seed();
    const cfg = config({
      PUBLIC_BASE: 'https://public.example.org/koresh',
      TOKEN_STORE_KEY: Buffer.alloc(32, 1).toString('base64'),
    });
    const pub = buildPublicServer({
      config: cfg,
      connect: createConnectService({ config: cfg, store }),
      logLevel: 'silent',
    })!;
    for (const url of ['/v1/owner/inbox', `/v1/owner/inbox/${a}/files/0`, '/v1/inbox']) {
      for (const headers of [auth, {}, { ...auth, 'x-forwarded-for': '203.0.113.5' }]) {
        const res = await pub.inject({ method: 'GET', url, headers });
        expect(res.statusCode, url).toBe(404);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      }
    }
    expect(fake.sent('getFile')).toEqual([]);
    await pub.close();
  });
});

describe('sniffImage', () => {
  it('knows JPEG, PNG and WebP by their first bytes, nothing else', () => {
    expect(sniffImage(JPEG.subarray(0, 12))).toBe('image/jpeg');
    expect(sniffImage(PNG.subarray(0, 12))).toBe('image/png');
    expect(sniffImage(WEBP.subarray(0, 12))).toBe('image/webp');
    for (const b of [
      Buffer.from('GIF89a......'),
      Buffer.from('%PDF-1.7....'),
      Buffer.from('RIFF....WAVE'),
      Buffer.from('ff', 'hex'),
      Buffer.alloc(0),
    ]) {
      expect(sniffImage(b)).toBeUndefined();
    }
  });
});
