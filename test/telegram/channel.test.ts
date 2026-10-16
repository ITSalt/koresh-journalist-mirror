import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { probeChannel } from '../../src/telegram/channel.js';
import { FakeBotApi } from '../support/fake-bot-api.js';

const TOKEN = '123456789:fake-bot-token-for-tests';
let fake: FakeBotApi;
beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
});
afterEach(async () => {
  await fake.stop();
});
const api = () => createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 1000 });

describe('probeChannel', () => {
  it('reports a linked discussion group as present', async () => {
    fake.getChatResult = { id: -1001, type: 'channel', linked_chat_id: -1002 };
    const p = await probeChannel(api(), '@test_channel');
    expect(p).toMatchObject({ ok: true, linkedChatId: 'present' });
    expect(p.detail).toBe('getChat ok: type=channel, linked_chat_id present');
    expect(fake.sent('getChat')[0]!.body).toEqual({ chat_id: '@test_channel' });
  });

  it('reports absent without linked_chat_id', async () => {
    const p = await probeChannel(api(), '@test_channel');
    expect(p).toMatchObject({ ok: true, linkedChatId: 'absent' });
  });

  it('reports a failure without the token', async () => {
    fake.queue('getChat', { status: 400, description: `chat not found ${TOKEN}` });
    const p = await probeChannel(api(), '@x', { scrub: (s) => s.split(TOKEN).join('[REDACTED]') });
    expect(p.ok).toBe(false);
    expect(p.detail).toBe('getChat failed: chat not found [REDACTED]');
  });
});
