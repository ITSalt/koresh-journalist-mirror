import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { createInboxPoller } from '../../src/telegram/inbox.js';
import { TOKEN as BOT_TOKEN } from '../publish/helpers.js';
import { FakeBotApi } from '../support/fake-bot-api.js';

// POST /v1/owner/drafts, GET /v1/inbox and the /ready inbox component.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const PROD = '@Channel1';
const OWNER = 555000111;

let fake: FakeBotApi;
let store: Store;
let gaps: number[];
beforeEach(async () => {
  fake = await new FakeBotApi(BOT_TOKEN).start();
  fake.chats = {
    [PROD]: { id: -1001, type: 'channel' },
    [String(OWNER)]: { id: OWNER, type: 'private' },
  };
  store = openStore(':memory:');
  gaps = [];
});
afterEach(async () => {
  store.close();
  await fake.stop();
});

const botApi = () => createBotApi({ token: BOT_TOKEN, baseUrl: fake.baseUrl, timeoutMs: 1000 });

function app(o: { owner?: number | null; withApi?: boolean } = {}) {
  const chatId = o.owner === null ? undefined : (o.owner ?? OWNER);
  return buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: API_TOKEN, TELEGRAM_BOT_TOKEN: BOT_TOKEN }),
    store,
    logLevel: 'silent',
    owner: {
      chatId,
      channel: PROD,
      api: o.withApi === false ? undefined : botApi(),
      sleep: async (ms) => void gaps.push(ms),
      scrub: (s) => s.split(BOT_TOKEN).join('[REDACTED]'),
    },
  });
}
type App = ReturnType<typeof app>;

const post = (a: App, payload: unknown, headers: Record<string, string> = auth) =>
  a.inject({ method: 'POST', url: '/v1/owner/drafts', headers, payload: payload as object });

const words = (n: number) =>
  'слово '
    .repeat(Math.ceil(n / 6))
    .slice(0, n)
    .trim();

describe('POST /v1/owner/drafts', () => {
  it('401 without the bearer token, nothing sent', async () => {
    const res = await post(app(), { text: 'hi' }, {});
    expect(res.statusCode).toBe(401);
    expect(fake.requests).toHaveLength(0);
  });

  it('409 without OWNER_CHAT_ID, nothing sent or stored', async () => {
    const res = await post(app({ owner: null }), { text: 'hi' });
    expect(res.statusCode).toBe(409);
    expect(fake.requests).toHaveLength(0);
    expect(store.ownerDrafts.get(1)).toBeUndefined();
  });

  it('409 without a bot token', async () => {
    const res = await post(app({ withApi: false }), { text: 'hi' });
    expect(res.statusCode).toBe(409);
  });

  it.each([
    ['empty text', { text: '' }],
    ['no text', {}],
    ['too long', { text: 'x'.repeat(20001) }],
    ['label too long', { text: 'x', label: 'l'.repeat(65) }],
    ['ref too long', { text: 'x', ref: 'r'.repeat(201) }],
  ])('400 on %s', async (_n, payload) => {
    const res = await post(app(), payload);
    expect(res.statusCode).toBe(400);
    expect(fake.sent('sendMessage')).toHaveLength(0);
  });

  it('sends plain text with the header, no parse_mode, previews off; 201 with ids', async () => {
    const res = await post(app(), { text: 'Черновик', label: 'plan', ref: '2026-10-12/s1' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.messageIds).toHaveLength(1);
    const req = fake.sent('sendMessage')[0]!.body;
    expect(req.text).toBe('[plan] 2026-10-12/s1\n\nЧерновик');
    expect(req.chat_id).toBe(OWNER);
    expect(req).not.toHaveProperty('parse_mode');
    expect(req.link_preview_options).toEqual({ is_disabled: true });
    expect(store.ownerDrafts.get(body.draftId)).toMatchObject({
      status: 'sent',
      ref: '2026-10-12/s1',
    });
    expect(store.ownerDrafts.byMessageId(body.messageIds[0])?.id).toBe(body.draftId);
  });

  it('a 9000-char text goes out as 3 parts of <= 4096, in order, all stored, with gaps', async () => {
    const text = words(9000);
    const res = await post(app(), { text, label: 'L', ref: 'R' });
    expect(res.statusCode).toBe(201);
    const { draftId, messageIds } = res.json();
    expect(messageIds).toHaveLength(3);
    const sent = fake.sent('sendMessage').map((r) => r.body.text as string);
    expect(sent).toHaveLength(3);
    for (const t of sent) expect(t.length).toBeLessThanOrEqual(4096);
    expect(sent[0]!.startsWith('[L] R\n\n')).toBe(true);
    expect(sent[1]!.startsWith('[')).toBe(false);
    expect(gaps).toEqual([1100, 1100]);
    expect(store.ownerDrafts.messageIds(draftId)).toEqual(messageIds);
    for (const id of messageIds) expect(store.ownerDrafts.byMessageId(id)?.id).toBe(draftId);
    const joined = sent.map((t, i) => (i === 0 ? t.replace('[L] R\n\n', '') : t)).join(' ');
    expect(joined.replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  it('never sends to the channel: every message goes to the owner chat; no publication rows', async () => {
    await post(app(), { text: words(9000) });
    expect(fake.channel.length).toBeGreaterThan(0);
    for (const m of fake.channel) expect(m.chat_id).toBe(OWNER);
    expect(fake.sent('sendMessage').every((r) => r.body.chat_id === OWNER)).toBe(true);
    expect(fake.sent('sendPoll')).toHaveLength(0);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM publications').get()).toEqual({ n: 0 });
  });

  it('refuses when the owner chat resolves to the channel, is not private, or is unknown', async () => {
    fake.chats[String(OWNER)] = { id: -1001, type: 'channel' };
    expect((await post(app(), { text: 'x' })).statusCode).toBe(409);
    fake.chats[String(OWNER)] = { id: OWNER, type: 'group' };
    expect((await post(app(), { text: 'x' })).statusCode).toBe(409);
    fake.chats[String(OWNER)] = null;
    expect((await post(app(), { text: 'x' })).statusCode).toBe(409);
    expect(fake.sent('sendMessage')).toHaveLength(0);
  });

  it('works whatever DRY_RUN is (the route does not read it)', async () => {
    const a = buildServer({
      config: loadConfig({ JOURNALIST_API_TOKEN: API_TOKEN, DRY_RUN: 'true' }),
      store,
      logLevel: 'silent',
      owner: { chatId: OWNER, channel: PROD, api: botApi() },
    });
    expect((await post(a, { text: 'x' })).statusCode).toBe(201);
  });

  it('502 on a mid-way failure: parts sent so far, status partial, token scrubbed', async () => {
    fake.queue('sendMessage', { accept: true }, { status: 400, description: `bad ${BOT_TOKEN}` });
    const res = await post(app(), { text: words(9000) });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.status).toBe('partial');
    expect(body.messageIds).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(BOT_TOKEN);
    const d = store.ownerDrafts.get(body.draftId)!;
    expect(d.status).toBe('partial');
    expect(d.error).not.toContain(BOT_TOKEN);
    expect(store.ownerDrafts.messageIds(d.id)).toEqual(body.messageIds);
  });

  it('502 with status failed when nothing was sent', async () => {
    fake.queue('sendMessage', { status: 400 });
    const res = await post(app(), { text: 'x' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ status: 'failed', messageIds: [] });
  });
});

describe('GET /v1/inbox', () => {
  const get = (a: App, q = '', headers: Record<string, string> = auth) =>
    a.inject({ method: 'GET', url: `/v1/inbox${q}`, headers });
  const seed = (n: number) => {
    for (let i = 1; i <= n; i++) {
      store.inbox.add({
        updateId: i,
        messageId: i,
        at: '2026-10-11T10:00:00.000Z',
        text: `m${i}`,
        kind: 'text',
      });
    }
  };
  const texts = (r: { messages: { text: string }[] }) => r.messages.map((x) => x.text);

  it('401 without the bearer token', async () => {
    expect((await get(app(), '', {})).statusCode).toBe(401);
  });

  it('pages oldest first with after/limit, and next', async () => {
    seed(5);
    const a = app();
    const p1 = (await get(a, '?limit=2')).json();
    expect(texts(p1)).toEqual(['m1', 'm2']);
    expect(p1.next).toBe(2);
    const p2 = (await get(a, `?after=${p1.next}&limit=10`)).json();
    expect(texts(p2)).toEqual(['m3', 'm4', 'm5']);
    expect((await get(a, '?after=5')).json()).toEqual({ messages: [], next: 5 });
  });

  it('returns the documented fields, with the draft ref and label', async () => {
    const d = store.ownerDrafts.add({ label: 'L', ref: 'R', text: 't', status: 'sent' });
    store.ownerDrafts.addPart(d.id, 0, 77);
    store.inbox.add({
      updateId: 1,
      messageId: 9,
      at: 'x',
      text: 'ok',
      replyToMessageId: 77,
      draftId: d.id,
      kind: 'text',
    });
    const m = (await get(app())).json().messages[0];
    expect(m).toEqual({
      id: 1,
      at: 'x',
      text: 'ok',
      kind: 'text',
      replyToMessageId: 77,
      draftId: d.id,
      draftRef: 'R',
      draftLabel: 'L',
    });
  });

  it('caps at 500 and rejects an invalid after/limit with 400', async () => {
    seed(600);
    const a = app();
    expect((await get(a, '?limit=500')).json().messages).toHaveLength(500);
    expect((await get(a, '?limit=501')).statusCode).toBe(400);
    expect((await get(a, '?limit=0')).statusCode).toBe(400);
    for (const bad of ['abc', '-1', '1.5', '']) {
      expect((await get(a, `?after=${bad}`)).statusCode, bad).toBe(400);
    }
  });

  it('end to end: a draft, the owner reply read by the poller, the inbox shows the draft', async () => {
    const a = app();
    const { draftId, messageIds } = (await post(a, { text: 'q', label: 'L', ref: 'R' })).json();
    fake.pushUpdate({
      update_id: 1,
      message: {
        message_id: 5000,
        date: 1_790_000_000,
        chat: { id: OWNER, type: 'private' },
        from: { id: OWNER },
        text: 'approved',
        reply_to_message: { message_id: messageIds[0] },
      },
    });
    const quiet = () => undefined;
    const poller = createInboxPoller({
      api: createBotApi({ token: BOT_TOKEN, baseUrl: fake.baseUrl, timeoutMs: 2000 }),
      store,
      ownerChatId: OWNER,
      log: { info: quiet, warn: quiet, error: quiet },
    });
    await poller.pollOnce();
    const m = (await get(a)).json().messages[0];
    expect(m).toMatchObject({
      text: 'approved',
      draftId,
      draftRef: 'R',
      replyToMessageId: messageIds[0],
    });
  });
});

describe('/ready inbox', () => {
  const ready = (inboxStatus?: () => { enabled: true; lastPollAt?: string; lastError?: string }) =>
    buildServer({
      config: loadConfig({ JOURNALIST_API_TOKEN: API_TOKEN, TELEGRAM_BOT_TOKEN: BOT_TOKEN }),
      store,
      logLevel: 'silent',
      inboxStatus,
    }).inject({ method: 'GET', url: '/ready' });

  it('shows the inbox as disabled and stays ready', async () => {
    const res = await ready();
    expect(res.statusCode).toBe(200);
    expect(res.json().components.inbox).toMatchObject({
      enabled: false,
      required: false,
      ok: true,
    });
  });

  it('reports enabled with the poll state, even with a last error', async () => {
    const res = await ready(() => ({ enabled: true, lastPollAt: 'T', lastError: 'client 409' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().components.inbox).toMatchObject({
      enabled: true,
      lastError: 'client 409',
      required: false,
    });
  });
});
