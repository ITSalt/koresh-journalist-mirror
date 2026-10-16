import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotApi, sendPhoto, sendWithRetry } from '../../src/telegram/bot-api.js';
import { FakeBotApi } from '../support/fake-bot-api.js';

const TOKEN = '123456789:fake-bot-token-for-tests';

let fake: FakeBotApi;
beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
});
afterEach(async () => {
  await fake.stop();
});

const api = (over: { timeoutMs?: number; baseUrl?: string } = {}) =>
  createBotApi({ token: TOKEN, timeoutMs: 2000, ...over, baseUrl: over.baseUrl ?? fake.baseUrl });

describe('createBotApi.call', () => {
  it('posts JSON to /bot<token>/<method> and returns the result', async () => {
    const r = await api().call<{ message_id: number }>('sendMessage', {
      chat_id: '@x',
      text: 'hi',
    });
    expect(r).toEqual({ ok: true, result: expect.objectContaining({ message_id: 100 }) });
    expect(fake.requests[0]).toMatchObject({
      method: 'sendMessage',
      tokenOk: true,
      body: { chat_id: '@x', text: 'hi' },
    });
  });

  it('classifies 429 with retry_after', async () => {
    fake.queue('sendMessage', { status: 429, description: 'Too Many Requests', retryAfter: 7 });
    const r = await api().call('sendMessage', {});
    expect(r).toMatchObject({ ok: false, kind: 'rate_limited', status: 429, retryAfterS: 7 });
  });

  it('classifies 5xx as server and 4xx as client', async () => {
    fake.queue(
      'sendMessage',
      { status: 502 },
      { status: 400, description: "can't parse entities" },
    );
    expect(await api().call('sendMessage', {})).toMatchObject({ kind: 'server', status: 502 });
    expect(await api().call('sendMessage', {})).toMatchObject({
      kind: 'client',
      status: 400,
      description: "can't parse entities",
    });
  });

  it('a refused connection is not_sent (the request never left)', async () => {
    const port = Number(new URL(fake.baseUrl).port);
    await fake.stop();
    const r = await api({ baseUrl: `http://127.0.0.1:${port}` }).call('sendMessage', {});
    expect(r).toMatchObject({ ok: false, kind: 'not_sent' });
    fake = await new FakeBotApi(TOKEN).start(); // for afterEach
  });

  it('a socket closed after the request is unknown (it may have been posted)', async () => {
    fake.queue('sendMessage', { drop: true });
    const r = await api().call('sendMessage', { text: 'x' });
    expect(r).toMatchObject({ ok: false, kind: 'unknown' });
    expect(fake.channel).toHaveLength(1);
  });

  it('a timeout after the request is unknown', async () => {
    fake.queue('sendMessage', { hang: true });
    const r = await api({ timeoutMs: 200 }).call('sendMessage', {});
    expect(r).toMatchObject({ ok: false, kind: 'unknown' });
  });

  it('never puts the token in a description', async () => {
    fake.queue('sendMessage', { drop: true });
    const r = await api().call('sendMessage', {});
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const port = Number(new URL(fake.baseUrl).port);
    await fake.stop();
    const r2 = await api({ baseUrl: `http://127.0.0.1:${port}` }).call('sendMessage', {});
    expect(JSON.stringify(r2)).not.toContain(TOKEN);
    fake = await new FakeBotApi(TOKEN).start();
  });
});

describe('sendWithRetry', () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  beforeEach(() => {
    waits.length = 0;
  });

  it('waits retry_after on 429 and then succeeds', async () => {
    fake.queue('sendMessage', { status: 429, retryAfter: 3 });
    const r = await sendWithRetry(api(), 'sendMessage', { text: 'a' }, { sleep });
    expect(r.ok).toBe(true);
    expect(waits).toEqual([3000]);
    expect(fake.sent('sendMessage')).toHaveLength(2);
    expect(fake.channel).toHaveLength(1);
  });

  it('backs off on 5xx and on a refused connection', async () => {
    fake.queue('sendMessage', { status: 500 }, { status: 503 });
    const r = await sendWithRetry(api(), 'sendMessage', {}, { sleep });
    expect(r.ok).toBe(true);
    expect(waits).toEqual([1000, 2000]);
  });

  it('gives up as failed after maxAttempts of 5xx', async () => {
    fake.queue('sendMessage', { status: 500 }, { status: 500 }, { status: 500 });
    const r = await sendWithRetry(api(), 'sendMessage', {}, { sleep, maxAttempts: 3 });
    expect(r).toMatchObject({ ok: false, outcome: 'failed', attempts: 3 });
    expect(fake.channel).toHaveLength(0);
  });

  it('gives up as failed when retry_after exceeds the wait budget', async () => {
    fake.queue('sendMessage', { status: 429, retryAfter: 600 });
    const r = await sendWithRetry(api(), 'sendMessage', {}, { sleep, maxWaitMs: 60_000 });
    expect(r).toMatchObject({ ok: false, outcome: 'failed' });
    expect(waits).toEqual([]);
  });

  it('never retries a 4xx', async () => {
    fake.queue('sendMessage', { status: 400, description: 'Bad Request: chat not found' });
    const r = await sendWithRetry(api(), 'sendMessage', {}, { sleep });
    expect(r).toMatchObject({ ok: false, outcome: 'failed', status: 400 });
    expect(fake.sent('sendMessage')).toHaveLength(1);
  });

  it('never retries an unknown outcome', async () => {
    fake.queue('sendMessage', { drop: true });
    const r = await sendWithRetry(api(), 'sendMessage', {}, { sleep });
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('sendMessage')).toHaveLength(1);
    expect(fake.channel).toHaveLength(1);
  });
});

describe('sendPhoto', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  it('sends multipart/form-data with the file, chat id and plain caption; no parse_mode', async () => {
    const r = await sendPhoto(api(), 42, png, 'image/png', 'подпись');
    expect(r).toMatchObject({ ok: true, result: { message_id: 100 } });
    const req = fake.sent('sendPhoto')[0]!;
    expect(req.tokenOk).toBe(true);
    expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(req.body).toEqual({ chat_id: '42', caption: 'подпись' });
    expect(req.files.photo).toMatchObject({
      filename: 'image.png',
      type: 'image/png',
      size: png.length,
    });
  });

  it('names a jpeg upload .jpg and leaves the caption out when there is none', async () => {
    await sendPhoto(api(), '@x', new Uint8Array([0xff, 0xd8, 0xff, 1]), 'image/jpeg');
    const req = fake.sent('sendPhoto')[0]!;
    expect(req.body).toEqual({ chat_id: '@x' });
    expect(req.files.photo).toMatchObject({ filename: 'image.jpg', type: 'image/jpeg' });
  });

  it('keeps JSON for calls without a file', async () => {
    await api().call('sendMessage', { chat_id: 1, text: 'x' });
    expect(fake.requests[0]!.contentType).toBe('application/json');
  });

  it('retries a 5xx, never a 4xx or an unknown outcome', async () => {
    const sleep = async () => undefined;
    fake.queue('sendPhoto', { status: 500 });
    expect(await sendPhoto(api(), 1, png, 'image/png', undefined, { sleep })).toMatchObject({
      ok: true,
      attempts: 2,
    });
    fake.queue('sendPhoto', { status: 400, description: 'Bad Request: wrong file' });
    expect(await sendPhoto(api(), 1, png, 'image/png', undefined, { sleep })).toMatchObject({
      ok: false,
      outcome: 'failed',
      status: 400,
    });
    fake.queue('sendPhoto', { drop: true });
    expect(await sendPhoto(api(), 1, png, 'image/png', undefined, { sleep })).toMatchObject({
      ok: false,
      outcome: 'unknown',
    });
    expect(fake.sent('sendPhoto')).toHaveLength(2 + 1 + 1);
  });

  it('a failure description never holds the URL with the token', async () => {
    const r = await sendPhoto(api({ baseUrl: 'http://127.0.0.1:1' }), 1, png, 'image/png');
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});
