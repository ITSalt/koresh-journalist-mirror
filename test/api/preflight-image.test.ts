import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { SlotImage } from '../../src/plan/schema.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';
import { seedImage } from '../support/images.js';
import { DATE, longText, msk, seedPlan, TOKEN as BOT_TOKEN } from '../publish/helpers.js';

// WP-SVC-24 scope 6, acceptance 8: the preview shows the photo item of a slot with an image, and
// test-publish sends the same items (the photo included) to TEST_CHANNEL only.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const PROD = '@Channel1';
const OWNER_CHAT = '123456789';
const CREDIT_ESCAPED = 'Иллюстрация: zenith\\-claude';

let fake: FakeBotApi;
let store: Store;
let img: ReturnType<typeof seedImage>;
let image: SlotImage;
beforeEach(async () => {
  fake = await new FakeBotApi(BOT_TOKEN).start();
  fake.chats = {
    [PROD]: { id: -1001, type: 'channel' },
    '-1001': { id: -1001, type: 'channel' },
    [OWNER_CHAT]: { id: 123456789, type: 'private' },
  };
  store = openStore(':memory:');
  img = seedImage(store, 1280, 720);
  image = {
    sha256: img.sha256,
    mime: 'image/png',
    width: 1280,
    height: 720,
    credit: 'zenith-claude',
  };
});
afterEach(async () => {
  store.close();
  await fake.stop();
});

function app(testChannel?: string, withApi = true) {
  return buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: API_TOKEN, TELEGRAM_BOT_TOKEN: BOT_TOKEN }),
    store,
    logLevel: 'silent',
    preflight: {
      blocks,
      channel: PROD,
      testChannel,
      api: withApi
        ? createBotApi({ token: BOT_TOKEN, baseUrl: fake.baseUrl, timeoutMs: 5000 })
        : undefined,
      sleep: async () => undefined,
    },
  });
}
type App = ReturnType<typeof app>;

const snapshot = () =>
  JSON.stringify({
    pubs: store.publications.listForPlan(DATE),
    slots: store.slots.listForPlan(DATE),
    plan: store.plans.get(DATE),
  });
const preview = (a: App, at = '09:00:30') =>
  a.inject({
    method: 'GET',
    url: `/v1/plans/${DATE}/preview?now=${encodeURIComponent(msk(at).toISOString())}`,
    headers: auth,
  });
const test = (a: App, slotId = 's1') =>
  a.inject({
    method: 'POST',
    url: '/v1/test-publish',
    headers: auth,
    payload: { date: DATE, slotId },
  });

describe('GET /v1/plans/:date/preview for a slot with an image', () => {
  it('a short post: the image and ONE part, the photo with its caption and length', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: 'Утро. Кто первый?', image }]);
    const before = snapshot();
    const res = await preview(app());
    expect(res.statusCode).toBe(200);
    const caption = `Утро\\. Кто первый?\n\nИИ\\-журналист\\-правдорубец Кореш Шпандент\n\n${CREDIT_ESCAPED}`;
    expect(res.json().slot).toEqual({
      id: 's1',
      at: `${DATE}T09:00:00+03:00`,
      kind: 'post',
      image,
      parts: [
        { index: 0, kind: 'photo', text: caption, length: caption.length, problems: [], image },
      ],
    });
    expect(res.json().refused).toBeUndefined();
    // Reads only: nothing sent, nothing written, the bytes are not in the answer.
    expect(fake.requests).toHaveLength(0);
    expect(snapshot()).toBe(before);
    expect(store.alerts.list()).toEqual([]);
    expect(res.body.length).toBeLessThan(2000);
  });

  it('a long post: the photo with the credit first, then the text parts in order', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: longText(), image }]);
    const parts = (await preview(app())).json().slot.parts as {
      index: number;
      kind: string;
      text: string;
      length: number;
      image?: unknown;
    }[];
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.map((p) => p.index)).toEqual(parts.map((_, i) => i));
    expect(parts.map((p) => p.kind)).toEqual(['photo', ...parts.slice(1).map(() => 'text')]);
    expect(parts[0]).toEqual({
      index: 0,
      kind: 'photo',
      text: CREDIT_ESCAPED,
      length: CREDIT_ESCAPED.length,
      problems: [],
      image,
    });
    expect(parts.slice(1).every((p) => p.image === undefined && p.length <= 4096)).toBe(true);
    expect(parts[parts.length - 1]!.text).toContain('Кореш Шпандент');
  });

  it('an image that is not in the store: `refused`, as the publisher would refuse it', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: 'Утро. Кто первый?', image }]);
    store.db.exec('DELETE FROM images');
    const body = (await preview(app())).json();
    expect(body.refused).toMatchObject({ code: 'image_missing' });
    expect(body.slot).toMatchObject({ id: 's1', image, parts: [] });
  });
});

describe('POST /v1/test-publish for a slot with an image', () => {
  it('sends the photo and the text parts to TEST_CHANNEL only; no publication row', async () => {
    seedPlan(
      store,
      [
        { id: 's1', at: '09:00', text: 'Утро. Кто первый?', image },
        { id: 's2', at: '19:00', text: longText(), image },
      ],
      { status: 'draft' },
    );
    const before = snapshot();
    const a = app(OWNER_CHAT);
    const one = await test(a);
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json()).toMatchObject({ chat: OWNER_CHAT, messageIds: [100] });
    const two = await test(a, 's2');
    expect(two.statusCode, two.body).toBe(200);

    const sends = fake.requests.filter((r) => r.method !== 'getChat');
    expect(sends.map((r) => r.method).slice(0, 3)).toEqual([
      'sendPhoto',
      'sendPhoto',
      'sendMessage',
    ]);
    // Every message went to the owner's chat; the production channel got nothing.
    expect(new Set(sends.map((r) => r.body.chat_id))).toEqual(new Set([OWNER_CHAT]));
    expect(new Set(fake.channel.map((m) => m.chat_id))).toEqual(new Set([OWNER_CHAT]));
    expect(fake.channel.filter((m) => m.method === 'sendPhoto')).toEqual([
      expect.objectContaining({
        photoSha256: img.sha256,
        parse_mode: 'MarkdownV2',
        caption: expect.stringContaining('Утро\\. Кто первый?'),
      }),
      expect.objectContaining({ photoSha256: img.sha256, caption: CREDIT_ESCAPED }),
    ]);
    expect(two.json().messageIds).toHaveLength(sends.length - 1);

    expect(snapshot()).toBe(before);
    expect(store.publications.listForPlan(DATE)).toEqual([]);
    expect(store.alerts.list().map((x) => x.kind)).toEqual(['test_publish', 'test_publish']);
  });

  it('sends exactly the items the preview shows', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: longText(), image }]);
    const a = app(OWNER_CHAT);
    const parts = (await preview(a)).json().slot.parts as { kind: string; text: string }[];
    expect((await test(a)).statusCode).toBe(200);
    expect(fake.channel.map((m) => [m.method, m.caption ?? m.text])).toEqual(
      parts.map((p) => [p.kind === 'photo' ? 'sendPhoto' : 'sendMessage', p.text]),
    );
  });

  describe('the four refusals of WP-SVC-11 hold for a photo: 409 and nothing is sent', () => {
    beforeEach(() => {
      seedPlan(store, [{ id: 's1', at: '09:00', text: 'Утро. Кто первый?', image }]);
    });
    afterEach(() => {
      expect(fake.sent('sendPhoto')).toHaveLength(0);
      expect(fake.sent('sendMessage')).toHaveLength(0);
      expect(fake.channel).toEqual([]);
      expect(store.publications.listForPlan(DATE)).toEqual([]);
    });

    it('TEST_CHANNEL is not set', async () => {
      const res = await test(app(undefined));
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('TEST_CHANNEL is not set');
      expect((await test(app('   '))).statusCode).toBe(409);
    });

    it('no Bot API client', async () => {
      const res = await test(app(OWNER_CHAT, false));
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('TELEGRAM_BOT_TOKEN is not set');
    });

    it('TEST_CHANNEL is the production channel by name (any case), before any getChat', async () => {
      for (const name of [PROD, '@channel1', ' @CHANNEL1 ']) {
        const res = await test(app(name));
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe('TEST_CHANNEL is the production channel');
      }
      expect(fake.requests).toHaveLength(0);
    });

    it('TEST_CHANNEL resolves to the id of the production channel, or cannot be resolved', async () => {
      const byId = await test(app('-1001'));
      expect(byId.statusCode).toBe(409);
      expect(byId.json().error).toBe('TEST_CHANNEL is the production channel');
      fake.chats['@alias_of_prod'] = { id: -1001, type: 'channel' };
      expect((await test(app('@alias_of_prod'))).statusCode).toBe(409);
      fake.chats['@unknown'] = null;
      const unknown = await test(app('@unknown'));
      expect(unknown.statusCode).toBe(409);
      expect(unknown.json().error).toContain('getChat failed');
      fake.chats[PROD] = null;
      expect((await test(app(OWNER_CHAT))).statusCode).toBe(409);
    });
  });

  it('422 and nothing sent when the image is not in the store; 502 when the photo fails', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: longText(), image }]);
    const a = app(OWNER_CHAT);
    fake.queue('sendPhoto', { status: 400, description: 'Bad Request: wrong file' });
    const failed = await test(a);
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ messageIds: [] });
    expect(failed.json().error).toMatch(/^sendPhoto: failed/);
    // The text parts did not go out after the failed photo.
    expect(fake.sent('sendMessage')).toHaveLength(0);

    store.db.exec('DELETE FROM images');
    const res = await test(a);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/^image_missing/);
    expect(fake.channel).toEqual([]);
  });
});
