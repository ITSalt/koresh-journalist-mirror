import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PHOTO_MAX_BYTES } from '../../src/api/director.js';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { createInboxPoller } from '../../src/telegram/inbox.js';
import { TOKEN as BOT_TOKEN } from '../publish/helpers.js';
import { FakeBotApi } from '../support/fake-bot-api.js';

// POST /v1/owner/drafts/photo: one PNG or JPEG with a caption to the owner's private chat only.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const PROD = '@Channel1';
const OWNER = 555000111;
const MARKER = 'IMG-MARKER-7c1f9a52-do-not-log';

let fake: FakeBotApi;
let store: Store;
let logs: string[];
beforeEach(async () => {
  fake = await new FakeBotApi(BOT_TOKEN).start();
  fake.chats = {
    [PROD]: { id: -1001, type: 'channel' },
    [String(OWNER)]: { id: OWNER, type: 'private' },
  };
  store = openStore(':memory:');
  logs = [];
});
afterEach(async () => {
  store.close();
  await fake.stop();
});

const botApi = () => createBotApi({ token: BOT_TOKEN, baseUrl: fake.baseUrl, timeoutMs: 2000 });

function app(o: { owner?: number | null; withApi?: boolean; dryRun?: boolean } = {}) {
  const chatId = o.owner === null ? undefined : (o.owner ?? OWNER);
  return buildServer({
    config: loadConfig({
      JOURNALIST_API_TOKEN: API_TOKEN,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      ...(o.dryRun ? { DRY_RUN: 'true' } : {}),
    }),
    store,
    logLevel: 'info',
    logStream: { write: (l) => void logs.push(l) },
    owner: {
      chatId,
      channel: PROD,
      api: o.withApi === false ? undefined : botApi(),
      sleep: async () => undefined,
      scrub: (s) => s.split(BOT_TOKEN).join('[REDACTED]'),
    },
  });
}
type App = ReturnType<typeof app>;

/** A buffer starting with the real magic bytes, with the marker inside, padded to `size`. */
function image(kind: 'png' | 'jpeg', size = 200): Buffer {
  const head =
    kind === 'png'
      ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const b = Buffer.alloc(size, 0x41);
  head.copy(b, 0);
  Buffer.from(MARKER).copy(b, head.length + 3);
  return b;
}
const MIME = { png: 'image/png', jpeg: 'image/jpeg' } as const;
const b64 = (b: Buffer) => b.toString('base64');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const post = (a: App, payload: unknown, headers: Record<string, string> = auth) =>
  a.inject({ method: 'POST', url: '/v1/owner/drafts/photo', headers, payload: payload as object });

const valid = (kind: 'png' | 'jpeg' = 'png', extra: Record<string, unknown> = {}) => ({
  imageBase64: b64(image(kind)),
  mime: MIME[kind],
  ...extra,
});

const count = (t: string) =>
  (store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

describe('POST /v1/owner/drafts/photo: sending', () => {
  it.each(['png', 'jpeg'] as const)(
    'a valid %s goes to OWNER_CHAT_ID as multipart with the caption and no parse_mode',
    async (kind) => {
      const img = image(kind, 300);
      const caption = 'Иллюстрация 2b: «вариант» <b>не жирный</b> *и не курсив*';
      const res = await post(app(), {
        imageBase64: b64(img),
        mime: MIME[kind],
        caption,
        label: 'illustration',
        ref: '2b',
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.messageIds).toHaveLength(1);
      const reqs = fake.sent('sendPhoto');
      expect(reqs).toHaveLength(1);
      const r = reqs[0]!;
      expect(r.tokenOk).toBe(true);
      expect(r.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(r.body.chat_id).toBe(String(OWNER));
      expect(r.body.caption).toBe(caption);
      expect(r.body).not.toHaveProperty('parse_mode');
      expect(Object.keys(r.body).sort()).toEqual(['caption', 'chat_id']);
      expect(r.files.photo).toMatchObject({ type: MIME[kind], size: img.length, sha256: sha(img) });
      expect(fake.channel).toHaveLength(1);
      expect(fake.channel[0]).toMatchObject({
        method: 'sendPhoto',
        message_id: body.messageIds[0],
      });
    },
  );

  it('without a caption none is sent', async () => {
    const res = await post(app(), valid('png'));
    expect(res.statusCode).toBe(201);
    expect(fake.sent('sendPhoto')[0]!.body).not.toHaveProperty('caption');
    const r = await post(app(), valid('png', { caption: '' }));
    expect(r.statusCode).toBe(201);
    expect(fake.sent('sendPhoto')[1]!.body).not.toHaveProperty('caption');
  });

  it('stores one draft row and one part row with the message id; no image bytes', async () => {
    const img = image('png', 400);
    const res = await post(app(), {
      imageBase64: b64(img),
      mime: 'image/png',
      caption: 'подпись',
      label: 'L',
      ref: '2026-10-12/i1',
    });
    const { draftId, messageIds } = res.json();
    const d = store.ownerDrafts.get(draftId)!;
    expect(d).toMatchObject({ status: 'sent', label: 'L', ref: '2026-10-12/i1' });
    expect(d.text).toBe(`[photo image/png 400 B sha256:${sha(img)}]\nподпись`);
    expect(store.ownerDrafts.messageIds(draftId)).toEqual(messageIds);
    expect(store.ownerDrafts.byMessageId(messageIds[0])?.id).toBe(draftId);
    expect(count('owner_drafts')).toBe(1);
    expect(count('owner_draft_parts')).toBe(1);
    expect(count('publications')).toBe(0);
  });

  it('the draft text has no caption line when there is no caption', async () => {
    const img = image('jpeg');
    const { draftId } = (await post(app(), valid('jpeg'))).json();
    expect(store.ownerDrafts.get(draftId)!.text).toBe(
      `[photo image/jpeg ${img.length} B sha256:${sha(img)}]`,
    );
  });

  it('accepts a caption of exactly 1024 chars and an image of exactly 5 MB', async () => {
    const big = image('jpeg', PHOTO_MAX_BYTES);
    const res = await post(app(), {
      imageBase64: b64(big),
      mime: 'image/jpeg',
      caption: 'c'.repeat(1024),
    });
    expect(res.statusCode).toBe(201);
    expect(fake.sent('sendPhoto')[0]!.files.photo!.size).toBe(PHOTO_MAX_BYTES);
  });

  it('works whatever DRY_RUN is and writes no publication row', async () => {
    expect((await post(app({ dryRun: true }), valid())).statusCode).toBe(201);
    expect(count('publications')).toBe(0);
  });

  it('never sends to the channel: only getChat looks at it, the picture goes to the owner', async () => {
    await post(app(), valid());
    expect(fake.channel.every((m) => m.chat_id === String(OWNER))).toBe(true);
    const sends = fake.requests.filter((r) => r.method !== 'getChat');
    expect(sends.map((r) => r.method)).toEqual(['sendPhoto']);
  });

  it('a reply of the owner to the picture maps to the draft in GET /v1/inbox', async () => {
    const a = app();
    const { draftId, messageIds } = (
      await post(a, valid('png', { caption: 'q', label: 'L', ref: 'R' }))
    ).json();
    fake.pushUpdate({
      update_id: 1,
      message: {
        message_id: 5000,
        date: 1_790_000_000,
        chat: { id: OWNER, type: 'private' },
        from: { id: OWNER },
        text: 'годится',
        reply_to_message: { message_id: messageIds[0] },
      },
    });
    const quiet = () => undefined;
    await createInboxPoller({
      api: botApi(),
      store,
      ownerChatId: OWNER,
      log: { info: quiet, warn: quiet, error: quiet },
    }).pollOnce();
    const res = await a.inject({ method: 'GET', url: '/v1/inbox', headers: auth });
    expect(res.json().messages[0]).toMatchObject({
      text: 'годится',
      draftId,
      draftRef: 'R',
      draftLabel: 'L',
      replyToMessageId: messageIds[0],
    });
  });
});

describe('POST /v1/owner/drafts/photo: refusals send nothing', () => {
  const noSend = () => {
    expect(fake.sent('sendPhoto')).toHaveLength(0);
    expect(fake.channel).toHaveLength(0);
    expect(count('owner_drafts')).toBe(0);
  };

  it('401 without the bearer token', async () => {
    const res = await post(app(), valid(), {});
    expect(res.statusCode).toBe(401);
    expect(fake.requests).toHaveLength(0);
    noSend();
  });

  it('409 without OWNER_CHAT_ID, and without a bot token', async () => {
    expect((await post(app({ owner: null }), valid())).statusCode).toBe(409);
    expect((await post(app({ withApi: false }), valid())).statusCode).toBe(409);
    expect(fake.requests).toHaveLength(0);
    noSend();
  });

  it('409 when the owner chat resolves to the channel, is not private, or is unknown', async () => {
    fake.chats[String(OWNER)] = { id: -1001, type: 'channel' };
    expect((await post(app(), valid())).statusCode).toBe(409);
    fake.chats[String(OWNER)] = { id: -1001, type: 'private' };
    expect((await post(app(), valid())).statusCode).toBe(409);
    fake.chats[String(OWNER)] = { id: OWNER, type: 'group' };
    expect((await post(app(), valid())).statusCode).toBe(409);
    fake.chats[String(OWNER)] = { id: OWNER, type: 'supergroup' };
    expect((await post(app(), valid())).statusCode).toBe(409);
    fake.chats[String(OWNER)] = null;
    expect((await post(app(), valid())).statusCode).toBe(409);
    noSend();
  });

  it('409 when TELEGRAM_CHANNEL resolves to the very same chat as OWNER_CHAT_ID', async () => {
    fake.chats[PROD] = { id: OWNER, type: 'private' };
    expect((await post(app(), valid())).statusCode).toBe(409);
    noSend();
  });

  it('409 when the channel itself cannot be resolved', async () => {
    fake.chats[PROD] = null;
    expect((await post(app(), valid())).statusCode).toBe(409);
    noSend();
  });

  it.each([
    ['chatId', { chatId: -1001 }],
    ['chat_id', { chat_id: PROD }],
    ['chat', { chat: PROD }],
    ['parse_mode', { parse_mode: 'MarkdownV2' }],
    ['any unknown key', { foo: 1 }],
  ])('422 on a body with %s, nothing sent', async (_n, extra) => {
    const res = await post(app(), valid('png', extra));
    expect(res.statusCode).toBe(422);
    expect(fake.requests).toHaveLength(0);
    noSend();
  });

  it.each([
    ['image/gif', 'gif'],
    ['application/pdf', 'pdf'],
    ['image/webp', 'webp'],
    ['IMAGE/PNG', 'upper case'],
    ['', 'empty'],
  ])('422 on mime %s (%s)', async (mime) => {
    const res = await post(app(), { imageBase64: b64(image('png')), mime });
    expect(res.statusCode).toBe(422);
    expect(fake.requests).toHaveLength(0);
    noSend();
  });

  it('422 when the bytes are not the declared type', async () => {
    const a = app();
    const send = async (img: Buffer, mime: string) =>
      (await post(a, { imageBase64: b64(img), mime })).statusCode;
    expect(await send(image('png'), 'image/jpeg')).toBe(422);
    expect(await send(image('jpeg'), 'image/png')).toBe(422);
    const gif = Buffer.from('GIF89a' + 'x'.repeat(50));
    expect(await send(gif, 'image/png')).toBe(422);
    expect(await send(gif, 'image/jpeg')).toBe(422);
    // a PNG head cut short, and an almost-JPEG head
    expect(await send(image('png').subarray(0, 7), 'image/png')).toBe(422);
    expect(await send(Buffer.from([0xff, 0xd8, 0xfe, 0x00, 0x00]), 'image/jpeg')).toBe(422);
    expect(fake.requests).toHaveLength(0);
    noSend();
  });

  it.each([
    ['not base64 at all', '!!!not base64!!!'],
    ['wrong length', b64(image('png')).slice(0, -1)],
    ['whitespace inside', b64(image('png')).replace(/^(.{8})/, '$1\n')],
    ['url-safe alphabet', b64(image('png')).slice(0, -4) + '-_-_'],
    ['padding in the middle', 'iVBORw0K=GgoAAAA='],
    ['empty', ''],
  ])('422 on invalid base64: %s', async (_n, imageBase64) => {
    const res = await post(app(), { imageBase64, mime: 'image/png' });
    expect(res.statusCode).toBe(422);
    expect(fake.requests).toHaveLength(0);
    noSend();
  });

  it('413 when the decoded image is over 5 MB (1 byte over), nothing sent', async () => {
    const res = await post(app(), {
      imageBase64: b64(image('png', PHOTO_MAX_BYTES + 1)),
      mime: 'image/png',
    });
    expect(res.statusCode).toBe(413);
    expect(fake.requests).toHaveLength(0);
    noSend();
  });

  it('413 when the JSON body is over the 8 MB limit of the route', async () => {
    const res = await post(app(), {
      imageBase64: 'A'.repeat(9 * 1024 * 1024),
      mime: 'image/png',
    });
    expect(res.statusCode).toBe(413);
    expect(fake.requests).toHaveLength(0);
    noSend();
  });

  it('422 on a caption over 1024 chars, label or ref too long, or a wrong type', async () => {
    const a = app();
    for (const extra of [
      { caption: 'c'.repeat(1025) },
      { label: 'l'.repeat(65) },
      { ref: 'r'.repeat(201) },
      { caption: 5 },
    ]) {
      expect((await post(a, valid('png', extra))).statusCode).toBe(422);
    }
    expect((await post(a, { mime: 'image/png' })).statusCode).toBe(422);
    expect((await post(a, { imageBase64: b64(image('png')) })).statusCode).toBe(422);
    expect(fake.requests).toHaveLength(0);
    noSend();
  });
});

describe('POST /v1/owner/drafts/photo: failures', () => {
  it('502 when the send fails: draft failed, no part, token scrubbed', async () => {
    fake.queue('sendPhoto', { status: 400, description: `bad ${BOT_TOKEN}` });
    const res = await post(app(), valid());
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body).toMatchObject({ status: 'failed', messageIds: [] });
    expect(JSON.stringify(body)).not.toContain(BOT_TOKEN);
    const d = store.ownerDrafts.get(body.draftId)!;
    expect(d.status).toBe('failed');
    expect(d.error).not.toContain(BOT_TOKEN);
    expect(store.ownerDrafts.messageIds(d.id)).toEqual([]);
  });

  it('retries a 5xx and then succeeds with the message id', async () => {
    fake.queue('sendPhoto', { status: 502 });
    const res = await post(app(), valid());
    expect(res.statusCode).toBe(201);
    expect(fake.sent('sendPhoto')).toHaveLength(2);
    expect(fake.channel).toHaveLength(1);
  });

  it('never resends when the outcome is unknown (the reply was lost)', async () => {
    fake.queue('sendPhoto', { drop: true });
    const res = await post(app(), valid());
    expect(res.statusCode).toBe(502);
    expect(fake.sent('sendPhoto')).toHaveLength(1);
    expect(store.ownerDrafts.get(res.json().draftId)!.status).toBe('failed');
  });
});

describe('POST /v1/owner/drafts/photo: the image is never kept or logged', () => {
  const dumpDb = () => {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    return tables
      .map((t) => JSON.stringify(store.db.prepare(`SELECT * FROM "${t.name}"`).all()))
      .join('\n');
  };
  const needles = (img: Buffer) => [
    MARKER,
    b64(img),
    b64(img).slice(0, 48),
    // the marker as base64 at each of the three alignments
    ...[0, 1, 2].map((k) =>
      Buffer.concat([Buffer.alloc(k), Buffer.from(MARKER)])
        .toString('base64')
        .slice(4, 24),
    ),
  ];

  it('neither the log stream nor any table holds the bytes, the base64 or the marker', async () => {
    const img = image('png', 3000);
    const a = app();
    const ok = await post(a, { imageBase64: b64(img), mime: 'image/png', caption: 'c' });
    expect(ok.statusCode).toBe(201);
    // refused requests must not echo it either
    const refusals = [
      await post(a, { imageBase64: b64(img), mime: 'image/jpeg' }),
      await post(a, { imageBase64: b64(img), mime: 'image/png', chatId: 1 }),
      await post(a, { imageBase64: b64(img), mime: 'image/gif' }),
      await post(a, { imageBase64: b64(img) + '!!!!', mime: 'image/png' }),
      await post(a, { imageBase64: b64(img), mime: 'image/png', caption: 'c'.repeat(2000) }),
    ];
    fake.chats[String(OWNER)] = { id: OWNER, type: 'group' };
    refusals.push(await post(a, { imageBase64: b64(img), mime: 'image/png' }));
    fake.chats[String(OWNER)] = { id: OWNER, type: 'private' };
    fake.queue('sendPhoto', { status: 400 });
    refusals.push(await post(a, { imageBase64: b64(img), mime: 'image/png' }));
    const out = logs.join('') + dumpDb() + [ok, ...refusals].map((r) => r.body).join('\n');
    for (const n of needles(img)) expect(out, n.slice(0, 16)).not.toContain(n);
    // what is logged: type, size and hash
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.msg === 'owner photo sent');
    expect(line).toMatchObject({ mime: 'image/png', size: 3000, sha256: sha(img) });
  });
});
