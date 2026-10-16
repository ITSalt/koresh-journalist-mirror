import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendOwnerNotice } from '../../src/api/owner-notice.js';
import { loadConfig } from '../../src/config.js';
import {
  createExpiryReminder,
  LINKEDIN_REMINDER_STATE,
  type ExpiryReminderOptions,
  type SendResult,
} from '../../src/platforms/expiry-reminder.js';
import { createPlatforms } from '../../src/platforms/registry.js';
import { createMemoryTokenStore } from '../../src/platforms/threads/index.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { TOKEN as BOT_TOKEN } from '../publish/helpers.js';
import { blocks } from '../support/blocks.js';
import { fakeAdapter } from '../support/fake-adapter.js';
import { FakeBotApi } from '../support/fake-bot-api.js';

// WP-PLAT-02, resubmission 1, item 2: the core tells the owner in his private chat that the
// LinkedIn token is about to end, 7 days and 1 day before (and when it has ended), with a fresh
// connect link. The link provider, the expiry and the chat are ports: scripted here, no platform
// and no account-connect code.

const DAY = 86_400_000;
const EXPIRES = '2026-12-11T09:00:00.000Z';
const LINK = 'https://www.linkedin.com/oauth/v2/authorization?state=one-time';
const before = (ms: number) => new Date(Date.parse(EXPIRES) - ms);

let store: Store;
let t: Date;
let sent: string[];
let links: number;
let reply: SendResult;
beforeEach(() => {
  store = openStore(':memory:');
  t = before(30 * DAY);
  sent = [];
  links = 0;
  reply = { ok: true };
});
afterEach(() => store.close());

const job = (over: Partial<ExpiryReminderOptions> = {}) =>
  createExpiryReminder({
    store,
    expiresAt: () => EXPIRES,
    connectLink: () => {
      links += 1;
      return { url: `${LINK}-${links}` };
    },
    send: async (text) => {
      if (reply.ok) sent.push(text);
      return reply;
    },
    now: () => t,
    ...over,
  });
const alerts = () => store.alerts.list().map((a) => [a.kind, a.message]);

describe('one message per state', () => {
  it('none (more than 7 days left): nothing is sent and no link is made', async () => {
    t = before(8 * DAY);
    expect(await job().tick()).toEqual({ state: 'none', action: 'nothing' });
    t = before(7 * DAY + 1);
    expect(await job().tick()).toEqual({ state: 'none', action: 'nothing' });
    expect(sent).toEqual([]);
    expect(links).toBe(0);
    expect(alerts()).toEqual([]);
  });

  it('in_7_days: one message with the date, "7 дней" and a fresh connect link', async () => {
    t = before(7 * DAY);
    expect(await job().tick()).toEqual({ state: 'in_7_days', action: 'sent', withLink: true });
    expect(sent).toEqual([
      `Токен LinkedIn действует до 11.12.2026 12:00 по Москве: осталось не больше 7 дней. Чтобы продлить доступ, откройте ссылку и нажмите "Разрешить": ${LINK}-1\nСсылка одноразовая и действует недолго. Если она уже не открывается, напишите директору, он пришлёт новую.`,
    ]);
  });

  it('in_1_day: one message that says a day is left, with its own fresh link', async () => {
    t = before(DAY);
    expect(await job().tick()).toEqual({ state: 'in_1_day', action: 'sent', withLink: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('осталось не больше суток');
    expect(sent[0]).toContain(`${LINK}-1`);
  });

  it('expired: one message that says posting has stopped, with a link', async () => {
    t = before(-1);
    expect(await job().tick()).toEqual({ state: 'expired', action: 'sent', withLink: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Токен LinkedIn закончился: посты в LinkedIn остановлены');
    expect(sent[0]).toContain(`${LINK}-1`);
  });

  it('no message ever names a token generator, a secret or GitHub, or has a long dash', async () => {
    for (const ms of [7 * DAY, DAY, -1]) {
      t = before(ms);
      await job().tick();
    }
    expect(sent).toHaveLength(3);
    for (const text of sent) {
      expect(text).not.toMatch(/generator|генератор|LINKEDIN_TOKEN|GitHub|секрет|[‒-―]/i);
    }
  });
});

describe('once per state, across checks and restarts', () => {
  it('the hourly check and a restart do not repeat a reminder', async () => {
    t = before(7 * DAY);
    const j = job();
    await j.tick();
    for (let h = 1; h <= 5; h++) {
      t = new Date(before(7 * DAY).getTime() + h * 3_600_000);
      expect(await j.tick()).toEqual({ state: 'in_7_days', action: 'already_sent' });
      // A new process on the same database.
      expect(await job().tick()).toEqual({ state: 'in_7_days', action: 'already_sent' });
    }
    expect(sent).toHaveLength(1);
    expect(links).toBe(1); // no link is made for a reminder that is not sent
  });

  it('7 days, then 1 day, then expired: three messages, each with a new link', async () => {
    const j = job();
    for (const ms of [8 * DAY, 7 * DAY, 3 * DAY, DAY, 3_600_000, -1, -5 * DAY]) {
      t = before(ms);
      await j.tick();
    }
    expect(sent.map((s) => s.slice(0, 40))).toEqual([
      'Токен LinkedIn действует до 11.12.2026 1',
      'Токен LinkedIn действует до 11.12.2026 1',
      'Токен LinkedIn закончился: посты в Linke',
    ]);
    expect(sent.map((s) => /state=one-time-(\d)/.exec(s)![1])).toEqual(['1', '2', '3']);
  });

  it('a renewed token resets it: the next approach of an end is told from the start', async () => {
    let expires = EXPIRES;
    const j = job({ expiresAt: () => expires });
    t = before(DAY);
    await j.tick();
    // The owner connected again: 60 more days.
    expires = '2027-02-09T09:00:00.000Z';
    expect(await j.tick()).toEqual({ state: 'none', action: 'nothing' });
    expect(store.botState.get(LINKEDIN_REMINDER_STATE)).toBe('');
    t = new Date(Date.parse(expires) - 7 * DAY);
    expect((await j.tick()).action).toBe('sent');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('до 09.02.2027');
  });

  it('another token that is also close to its end is told anew (the expiry is part of the mark)', async () => {
    let expires = EXPIRES;
    const j = job({ expiresAt: () => expires });
    t = before(3 * DAY);
    expect((await j.tick()).action).toBe('sent');
    // Replaced by a token that ends two days later: the same state, another end.
    expires = '2026-12-13T09:00:00.000Z';
    expect(await j.tick()).toMatchObject({ state: 'in_7_days', action: 'sent' });
    expect((await j.tick()).action).toBe('already_sent');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('до 13.12.2026');
  });

  it('no connected account: nothing is sent', async () => {
    const j = job({ expiresAt: () => undefined });
    expect(await j.tick()).toEqual({ state: 'none', action: 'nothing' });
    const throwing = job({
      expiresAt: () => {
        throw new Error('store is down');
      },
    });
    expect(await throwing.tick()).toEqual({ state: 'none', action: 'nothing' });
    expect(sent).toEqual([]);
  });
});

describe('when the link or the chat is not there', () => {
  it('no link can be made: the message asks the owner to write to the director', async () => {
    t = before(7 * DAY);
    for (const connectLink of [
      undefined,
      () => undefined,
      async () => undefined,
      () => {
        throw new Error('PUBLIC_BASE is not set');
      },
    ]) {
      store.botState.set(LINKEDIN_REMINDER_STATE, '');
      const r = await job({ connectLink }).tick();
      expect(r).toEqual({ state: 'in_7_days', action: 'sent', withLink: false });
    }
    expect(sent).toHaveLength(4);
    for (const text of sent) {
      expect(text).toContain('напишите директору: он пришлёт ссылку');
      expect(text).not.toContain('http');
    }
  });

  it('the message does not reach the owner: one alert, tried again, sent when the chat is back', async () => {
    t = before(7 * DAY);
    const j = job();
    reply = { ok: false, error: 'OWNER_CHAT_ID is not set' };
    expect(await j.tick()).toEqual({
      state: 'in_7_days',
      action: 'failed',
      error: 'OWNER_CHAT_ID is not set',
    });
    await j.tick();
    await job().tick();
    expect(alerts()).toEqual([
      [
        'expiry_reminder_failed',
        `linkedin token in_7_days (ends ${EXPIRES}): the reminder did not reach the owner's chat (OWNER_CHAT_ID is not set); it is tried again with the next check. Send the owner a connect link by hand`,
      ],
    ]);
    reply = { ok: true };
    expect((await j.tick()).action).toBe('sent');
    expect((await j.tick()).action).toBe('already_sent');
    expect(sent).toHaveLength(1);
    // The next state that cannot be told is told to the director again.
    t = before(DAY);
    reply = { ok: false, error: 'sendMessage: failed' };
    await j.tick();
    expect(alerts().map((a) => a[0])).toEqual(['expiry_reminder_failed', 'expiry_reminder_failed']);
  });

  it('a send that throws is a failure, and secrets are scrubbed from the alert', async () => {
    t = before(DAY);
    const j = job({
      send: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await j.tick()).toMatchObject({ action: 'failed', error: 'TypeError' });
    const scrubbed = job({
      send: async () => ({ ok: false, error: 'bad token SECRET-MARKER-123456' }),
      scrub: (s) => s.split('SECRET-MARKER-123456').join('[X]'),
    });
    store.botState.set(LINKEDIN_REMINDER_STATE, '');
    await scrubbed.tick();
    expect(JSON.stringify(alerts())).not.toContain('SECRET-MARKER');
  });
});

describe('the ports as the service wires them', () => {
  const OWNER = 555000111;
  const PROD = '@Channel1';
  let fake: FakeBotApi;
  beforeEach(async () => {
    fake = await new FakeBotApi(BOT_TOKEN).start();
    fake.chats = {
      [PROD]: { id: -1001, type: 'channel' },
      [String(OWNER)]: { id: OWNER, type: 'private' },
    };
  });
  afterEach(async () => {
    await fake.stop();
  });
  const owner = (chat: number | null = OWNER) => ({
    chatId: chat ?? undefined,
    channel: PROD,
    api: createBotApi({ token: BOT_TOKEN, baseUrl: fake.baseUrl, timeoutMs: 1000 }),
    sleep: async () => undefined,
    scrub: (s: string) => s.split(BOT_TOKEN).join('[REDACTED]'),
  });
  const notice = (o: ReturnType<typeof owner> | undefined) => (text: string) =>
    sendOwnerNotice(store, o, { text, label: 'linkedin', ref: 'linkedin-token-expiry' });

  it("the reminder is one plain message in the owner's private chat, recorded like a draft", async () => {
    t = before(7 * DAY);
    const r = await job({ send: notice(owner()) }).tick();
    expect(r).toEqual({ state: 'in_7_days', action: 'sent', withLink: true });
    const messages = fake.sent('sendMessage');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toMatchObject({
      chat_id: OWNER,
      link_preview_options: { is_disabled: true },
    });
    expect(messages[0]!.body.parse_mode).toBeUndefined();
    expect(messages[0]!.body.text).toContain(`${LINK}-1`);
    // Never the channel: the only message the Bot API saw went to the owner's chat.
    expect(fake.requests.filter((q) => q.method !== 'getChat').map((q) => q.body.chat_id)).toEqual([
      OWNER,
    ]);
    // The owner's reply to it will carry this ref in GET /v1/inbox.
    expect(store.ownerDrafts.get(1)).toMatchObject({
      status: 'sent',
      label: 'linkedin',
      ref: 'linkedin-token-expiry',
    });
    expect(store.ownerDrafts.messageIds(1)).toHaveLength(1);
    expect(store.publications.listForPlan('2026-12-04')).toEqual([]);
  });

  it('no owner chat, a chat that is not private, or the channel itself: nothing is sent, one alert', async () => {
    t = before(7 * DAY);
    expect((await job({ send: notice(owner(null)) }).tick()).action).toBe('failed');
    expect((await job({ send: notice(undefined) }).tick()).action).toBe('failed');
    fake.chats[String(OWNER)] = { id: OWNER, type: 'group' };
    expect((await job({ send: notice(owner()) }).tick()).action).toBe('failed');
    fake.chats[String(-1001)] = { id: -1001, type: 'channel' };
    expect((await job({ send: notice({ ...owner(), chatId: -1001 }) }).tick()).action).toBe(
      'failed',
    );
    expect(fake.sent('sendMessage')).toEqual([]);
    expect(alerts().map((a) => a[0])).toEqual(['expiry_reminder_failed']);
    // The guard answers; it does not throw. (The owner chat is a group at this point.)
    await expect(sendOwnerNotice(store, owner(), { text: 'Привет' })).resolves.toEqual({
      ok: false,
      error: 'OWNER_CHAT_ID is not a private chat or is the production channel',
    });
    expect(store.ownerDrafts.get(1)).toBeUndefined();
    expect(alerts()[0]![1]).toContain('OWNER_CHAT_ID is not set');
  });

  it('a Bot API failure fails the notice with a scrubbed error; the draft row says failed', async () => {
    fake.queue('sendMessage', { status: 400, description: `bad request ${BOT_TOKEN}` });
    const r = await sendOwnerNotice(store, owner(), { text: 'Привет' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(BOT_TOKEN);
    expect(store.ownerDrafts.get(1)).toMatchObject({ status: 'failed' });
    expect(await sendOwnerNotice(store, owner(), { text: '  ' })).toMatchObject({ ok: false });
    expect(await sendOwnerNotice(store, owner(), { text: 'x'.repeat(4097) })).toMatchObject({
      ok: false,
    });
  });

  it('the expiry comes from the token store of the account, else from the last health check', async () => {
    const linkedin = fakeAdapter('linkedin');
    const tokens = createMemoryTokenStore('LIMARKER0fake0token0for0tests', EXPIRES);
    const withStore = createPlatforms({
      config: loadConfig({}),
      store,
      blocks,
      adapters: { linkedin },
      tokens: { linkedin: tokens },
    });
    expect(withStore.tokenExpiresAt('linkedin')).toBe(EXPIRES);
    expect(withStore.tokenExpiresAt('threads')).toBeUndefined();
    // A store without a token knows no expiry.
    tokens.set('', EXPIRES);
    expect(withStore.tokenExpiresAt('linkedin')).toBeUndefined();

    const viaHealth = createPlatforms({
      config: loadConfig({}),
      store,
      blocks,
      adapters: { linkedin },
    });
    expect(viaHealth.tokenExpiresAt('linkedin')).toBeUndefined();
    linkedin.healthState = { ok: true, detail: 'ok', tokenExpiresAt: '2026-12-20T00:00:00.000Z' };
    await viaHealth.probe();
    expect(viaHealth.tokenExpiresAt('linkedin')).toBe('2026-12-20T00:00:00.000Z');

    // End to end with the registry as the source of the expiry.
    t = before(DAY);
    tokens.set('LIMARKER0fake0token0for0tests', EXPIRES);
    const r = await job({ expiresAt: () => withStore.tokenExpiresAt('linkedin') }).tick();
    expect(r).toMatchObject({ state: 'in_1_day', action: 'sent' });
  });
});
