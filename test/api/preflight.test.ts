import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';
import { DATE, longText, msk, seedPlan, TOKEN as BOT_TOKEN } from '../publish/helpers.js';

// Scope item 15: GET /v1/plans/:date/preview and POST /v1/test-publish.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const PROD = '@Channel1';
const OWNER_CHAT = '123456789'; // a private chat with the bot (D-25)

let fake: FakeBotApi;
let store: Store;
beforeEach(async () => {
  fake = await new FakeBotApi(BOT_TOKEN).start();
  fake.chats = {
    [PROD]: { id: -1001, type: 'channel' },
    '-1001': { id: -1001, type: 'channel' },
    [OWNER_CHAT]: { id: 123456789, type: 'private' },
  };
  store = openStore(':memory:');
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
        ? createBotApi({ token: BOT_TOKEN, baseUrl: fake.baseUrl, timeoutMs: 1000 })
        : undefined,
      sleep: async () => undefined,
    },
  });
}

const snapshot = () => ({
  pubs: store.publications.listForPlan(DATE),
  slots: store.slots.listForPlan(DATE),
  plan: store.plans.get(DATE),
});

describe('GET /v1/plans/:date/preview', () => {
  it('approved plan at 09:00:30: publish s1 with its rendered parts; sends and writes nothing', async () => {
    seedPlan(store, [
      { id: 's1', at: '09:00', text: `**Дело №1.**\n\n${longText()}` },
      { id: 's2', at: '19:00' },
    ]);
    const before = snapshot();
    const res = await app().inject({
      method: 'GET',
      url: `/v1/plans/${DATE}/preview?now=${encodeURIComponent('2026-10-11T09:00:30+03:00')}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.planStatus).toBe('approved');
    expect(body.decision).toEqual({ publish: 's1', skip: [] });
    expect(body.slot.id).toBe('s1');
    expect(body.slot.parts.length).toBeGreaterThan(1);
    for (const p of body.slot.parts) {
      expect(p.kind).toBe('text');
      expect(p.length).toBeLessThanOrEqual(4096);
      expect(p.problems).toEqual([]);
    }
    expect(body.slot.parts[0].text.startsWith(blocks.md.bold('Дело №1.'))).toBe(true);
    expect(fake.requests).toHaveLength(0);
    expect(snapshot()).toEqual(before);
    expect(store.alerts.list()).toEqual([]);
  });

  it('a draft plan: nothing would be published', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00' }], { status: 'draft' });
    const res = await app().inject({
      method: 'GET',
      url: `/v1/plans/${DATE}/preview?now=${encodeURIComponent(msk('09:00:30').toISOString())}`,
      headers: auth,
    });
    expect(res.json()).toMatchObject({ planStatus: 'draft', decision: { skip: [] } });
    expect(res.json().decision.publish).toBeUndefined();
    expect(res.json().slot).toBeUndefined();
  });

  it('a poll slot previews the sendPoll part; a scheduler error is reported', async () => {
    seedPlan(store, [
      {
        id: 'q1',
        at: '09:00',
        kind: 'poll',
        text: 'Опрос.',
        poll: { question: 'Да?', options: ['да', 'нет'], allowsMultiple: false },
      },
    ]);
    const res = await app().inject({
      method: 'GET',
      url: `/v1/plans/${DATE}/preview?now=${encodeURIComponent('2026-10-11T09:00:30+03:00')}`,
      headers: auth,
    });
    expect(res.json().slot.parts.map((p: { kind: string }) => p.kind)).toEqual(['text', 'poll']);
    store.slots.replaceForPlan(DATE, [
      { slotId: 'x', at: `${DATE}T09:00:00`, kind: 'post', json: '{}' },
    ]);
    const bad = await app().inject({
      method: 'GET',
      url: `/v1/plans/${DATE}/preview`,
      headers: auth,
    });
    expect(bad.json().schedulerError.code).toBe('BAD_TIME');
  });

  it('takes the publication log into account (min gap after a sent slot)', async () => {
    seedPlan(store, [
      { id: 's1', at: '09:00' },
      { id: 's2', at: '09:10' },
    ]);
    const key = `telegram:${DATE}:s1:0`;
    store.publications.beginIntent(
      { key, platform: 'telegram', planDate: DATE, slotId: 's1', part: 0, textSha256: 'x' },
      msk('09:00:05'),
    );
    store.publications.markSent(key, '7', msk('09:00:05'));
    const res = await app().inject({
      method: 'GET',
      url: `/v1/plans/${DATE}/preview?now=${encodeURIComponent('2026-10-11T09:10:30+03:00')}`,
      headers: auth,
    });
    expect(res.json().decision).toEqual({ skip: [], wakeAt: msk('09:20:05').toISOString() });
  });

  it('needs the bearer token and a valid now', async () => {
    expect(
      (await app().inject({ method: 'GET', url: `/v1/plans/${DATE}/preview` })).statusCode,
    ).toBe(401);
    const res = await app().inject({
      method: 'GET',
      url: `/v1/plans/${DATE}/preview?now=2026-10-11T09:00:30`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/test-publish', () => {
  const post = (a: ReturnType<typeof app>, body: object = { date: DATE, slotId: 's1' }) =>
    a.inject({ method: 'POST', url: '/v1/test-publish', headers: auth, payload: body });

  it('sends to TEST_CHANNEL (a private chat), not the channel; leaves publications and slots unchanged', async () => {
    seedPlan(
      store,
      [
        { id: 's1', at: '09:00', text: 'Тест. Ну?' },
        {
          id: 'q1',
          at: '19:00',
          kind: 'poll',
          text: 'Опрос.',
          poll: { question: 'Да?', options: ['да', 'нет'], allowsMultiple: false },
        },
      ],
      { status: 'draft' },
    );
    const before = snapshot();
    const a = app(OWNER_CHAT);
    const r1 = await post(a);
    expect(r1.statusCode).toBe(200);
    const r2 = await post(a, { date: DATE, slotId: 'q1' });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().messageIds).toHaveLength(2);
    expect(fake.channel.map((m) => [m.method, m.chat_id])).toEqual([
      ['sendMessage', OWNER_CHAT],
      ['sendMessage', OWNER_CHAT],
      ['sendPoll', OWNER_CHAT],
    ]);
    expect(fake.channel[0]!.text).toContain('Тест\\. Ну?');
    expect(fake.channel[2]!.poll).toMatchObject({ is_anonymous: true, type: 'regular' });
    expect(snapshot()).toEqual(before);
    expect(store.alerts.list().map((x) => x.kind)).toEqual(['test_publish', 'test_publish']);
  });

  it('refuses with 409 when TEST_CHANNEL is unset or equals TELEGRAM_CHANNEL (string or chat id)', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00' }]);
    expect((await post(app(undefined))).statusCode).toBe(409);
    const byName = await post(app('@channel1'));
    expect(byName.statusCode).toBe(409);
    expect(fake.sent('getChat')).toHaveLength(0); // refused on the name, before any getChat
    const byId = await post(app('-1001'));
    expect(byId.statusCode).toBe(409);
    expect(byId.json().error).toBe('TEST_CHANNEL is the production channel');
    fake.chats['@unknown'] = null;
    expect((await post(app('@unknown'))).statusCode).toBe(409);
    expect((await post(app(OWNER_CHAT, false))).statusCode).toBe(409);
    expect(fake.sent('sendMessage')).toHaveLength(0);
    expect(store.publications.listForPlan(DATE)).toEqual([]);
  });

  it('404 for an unknown slot, 422 for a post that cannot be composed', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: 'Без подписи?' }], { raw: true });
    expect((await post(app(OWNER_CHAT), { date: DATE, slotId: 'nope' })).statusCode).toBe(404);
    const r = await post(app(OWNER_CHAT));
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/^unsigned/);
    expect(fake.sent('sendMessage')).toHaveLength(0);
  });
});
