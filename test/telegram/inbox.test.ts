import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import {
  CONFLICT_ALERT_EVERY_MS,
  createInboxPoller,
  inboxPollerFor,
  OFFSET_KEY,
  type InboxPoller,
} from '../../src/telegram/inbox.js';
import { TOKEN } from '../publish/helpers.js';
import { FakeBotApi } from '../support/fake-bot-api.js';

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
const api = () => createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 2000 });
const poller = (o: { now?: () => Date } = {}): InboxPoller =>
  createInboxPoller({
    api: api(),
    store,
    ownerChatId: OWNER,
    log,
    sleep: async () => undefined,
    now: o.now,
  });

const msg = (
  update_id: number,
  over: Record<string, unknown> = {},
  chat: Record<string, unknown> = { id: OWNER, type: 'private' },
  from: Record<string, unknown> | null = { id: OWNER },
) => ({
  update_id,
  message: {
    message_id: update_id + 1000,
    date: 1_790_000_000,
    chat,
    ...(from ? { from } : {}),
    text: `text-${update_id}`,
    ...over,
  },
});

beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
  dir = mkdtempSync(join(tmpdir(), 'journalist-inbox-'));
  store = openStore(join(dir, 'state.db'));
  logs = [];
});
afterEach(async () => {
  try {
    store.close();
  } catch {
    // already closed by the test
  }
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('inbox poller', () => {
  it('stores the owner private message; getUpdates carries offset/timeout/allowed_updates', async () => {
    fake.pushUpdate(msg(10));
    await poller().pollOnce();
    const rows = store.inbox.listAfter(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: 'text-10', kind: 'text', draftId: null });
    expect(fake.sent('getUpdates')[0]!.body).toMatchObject({
      timeout: 25,
      allowed_updates: ['message'],
    });
    expect(store.botState.get(OFFSET_KEY)).toBe('11');
  });

  it('stores a non-text message as kind other with its caption', async () => {
    fake.pushUpdate(msg(1, { text: undefined, photo: [{}], caption: 'cap' }));
    fake.pushUpdate(msg(2, { text: undefined, sticker: {} }));
    await poller().pollOnce();
    expect(store.inbox.listAfter(0).map((m) => [m.kind, m.text])).toEqual([
      ['other', 'cap'],
      ['other', ''],
    ]);
  });

  it('drops strangers, groups, channel posts and foreign "from": no row, no reply, no text in logs', async () => {
    fake.pushUpdate(msg(1, {}, { id: STRANGER, type: 'private' }, { id: STRANGER }));
    fake.pushUpdate(msg(2, {}, { id: -100500, type: 'group' }, { id: OWNER }));
    fake.pushUpdate(msg(3, {}, { id: -100600, type: 'supergroup' }, { id: OWNER }));
    fake.pushUpdate({ update_id: 4, channel_post: msg(4).message });
    // the owner's chat, but written by someone else / no sender
    fake.pushUpdate(msg(5, {}, { id: OWNER, type: 'private' }, { id: STRANGER }));
    fake.pushUpdate(msg(6, {}, { id: OWNER, type: 'private' }, null));
    // the owner's id in a chat that is not private
    fake.pushUpdate(msg(7, {}, { id: OWNER, type: 'group' }, { id: OWNER }));
    // a private chat that is not the owner's, with the owner's id as sender
    fake.pushUpdate(msg(8, {}, { id: STRANGER, type: 'private' }, { id: OWNER }));
    await poller().pollOnce();
    expect(store.inbox.listAfter(0)).toEqual([]);
    expect(fake.sent().every((r) => r.method === 'getUpdates')).toBe(true);
    expect(fake.requests).toHaveLength(1);
    const all = logs.join('\n');
    expect(all).not.toMatch(/text-\d/);
    expect(all).not.toContain(String(STRANGER));
    expect(all).not.toContain(String(OWNER));
    expect(all).toContain('"dropped":8');
    expect(store.botState.get(OFFSET_KEY)).toBe('9'); // dropped updates are still confirmed
  });

  it('maps a reply to the draft through its part; unknown replies get no draft', async () => {
    const d = store.ownerDrafts.add({ label: 'L', ref: 'R', text: 't', status: 'sent' });
    store.ownerDrafts.addPart(d.id, 0, 41);
    store.ownerDrafts.addPart(d.id, 1, 42);
    fake.pushUpdate(msg(1, { reply_to_message: { message_id: 42 } }));
    fake.pushUpdate(msg(2, { reply_to_message: { message_id: 9999 } }));
    await poller().pollOnce();
    const [a, b] = store.inbox.listAfter(0);
    expect(a).toMatchObject({
      draftId: d.id,
      replyToMessageId: 42,
      draftRef: 'R',
      draftLabel: 'L',
    });
    expect(b).toMatchObject({ draftId: null, replyToMessageId: 9999 });
  });

  it('persists the offset across a restart and does not re-store', async () => {
    fake.pushUpdate(msg(5));
    await poller().pollOnce();
    store.close();
    store = openStore(join(dir, 'state.db'));
    fake.pushUpdate(msg(6));
    await poller().pollOnce();
    expect(fake.sent('getUpdates').at(-1)!.body.offset).toBe(6);
    expect(store.inbox.listAfter(0).map((m) => m.text)).toEqual(['text-5', 'text-6']);
  });

  it('ignores a duplicate update_id', async () => {
    fake.pushUpdate(msg(5));
    await poller().pollOnce();
    store.botState.set(OFFSET_KEY, '0'); // Telegram redelivers the same update
    await poller().pollOnce();
    expect(store.inbox.listAfter(0)).toHaveLength(1);
  });

  it('a batch that fails to store does not advance the offset and stores nothing', async () => {
    fake.pushUpdate(msg(1));
    fake.pushUpdate(msg(2));
    const real = store.inbox.add;
    let n = 0;
    store.inbox.add = (m) => {
      if (++n === 2) throw new Error('disk full');
      return real(m);
    };
    await expect(poller().pollOnce()).rejects.toThrow('disk full');
    store.inbox.add = real;
    expect(store.inbox.listAfter(0)).toEqual([]);
    expect(store.botState.get(OFFSET_KEY)).toBeUndefined();
    await poller().pollOnce();
    expect(store.inbox.listAfter(0)).toHaveLength(2);
  });

  it('409 writes one alert per hour at most, backs off, never touches webhooks', async () => {
    let t = Date.parse('2026-10-11T10:00:00Z');
    const p = poller({ now: () => new Date(t) });
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      fake.queue('getUpdates', { status: 409, description: 'Conflict: terminated by other' });
      waits.push((await p.pollOnce()).waitMs);
    }
    const conflicts = () => store.alerts.list().filter((a) => a.kind === 'inbox_conflict');
    expect(conflicts()).toHaveLength(1);
    expect(waits[1]).toBeGreaterThan(waits[0]!);
    t += CONFLICT_ALERT_EVERY_MS + 1;
    fake.queue('getUpdates', { status: 409 });
    await p.pollOnce();
    expect(conflicts()).toHaveLength(2);
    const methods = fake.sent().map((r) => r.method);
    expect(methods).not.toContain('deleteWebhook');
    expect(methods).not.toContain('setWebhook');
    expect(p.status().lastError).toContain('409');
  });

  it('backs off on 401 (long) and on 5xx (growing), without an alert', async () => {
    const p = poller();
    fake.queue('getUpdates', { status: 401 }, { status: 500 }, { status: 500 });
    const a = await p.pollOnce();
    const b = await p.pollOnce();
    const c = await p.pollOnce();
    expect(a.outcome).toBe('fatal');
    expect(a.waitMs).toBeGreaterThanOrEqual(60_000);
    expect(c.waitMs).toBeGreaterThan(b.waitMs);
    expect(store.alerts.list()).toEqual([]);
  });

  it('the start/stop loop stores messages and stops without waiting for the long poll', async () => {
    fake.pushUpdate(msg(1));
    const p = poller();
    p.start();
    await vi.waitFor(() => expect(store.inbox.listAfter(0)).toHaveLength(1));
    await p.stop();
    expect(p.status().enabled).toBe(true);
    expect(p.status().lastPollAt).toBeDefined();
  });

  it('no poller and no getUpdates without the owner id or without a token', () => {
    const deps = { store, log };
    expect(inboxPollerFor({ OWNER_CHAT_ID: undefined }, api(), deps)).toBeUndefined();
    expect(inboxPollerFor({ OWNER_CHAT_ID: OWNER }, undefined, deps)).toBeUndefined();
    expect(inboxPollerFor({ OWNER_CHAT_ID: OWNER }, api(), deps)).toBeDefined();
    expect(fake.sent('getUpdates')).toHaveLength(0);
  });

  it('setWebhook / deleteWebhook are never called in src', () => {
    const root = new URL('../../src', import.meta.url).pathname;
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    const hits = files.filter((f) =>
      /['"`](set|delete)Webhook/.test(readFileSync(join(root, f), 'utf8')),
    );
    expect(files.length).toBeGreaterThan(10);
    expect(hits).toEqual([]);
  });
});
