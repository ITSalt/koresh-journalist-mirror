import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotApi, sendPhoto } from '../../src/telegram/bot-api.js';
import { FakeBotApi } from '../support/fake-bot-api.js';

// WP-SVC-24: what `sendPhoto` puts on the wire. The caption of a channel post is rendered,
// measured (1024) and hashed with LF line breaks, so it must leave byte for byte: the multipart
// body is written by hand because `FormData` turns the line breaks of a text field into CRLF.

const TOKEN = '123456789:fake-bot-token-for-tests';
let fake: FakeBotApi;
beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
});
afterEach(() => fake.stop());

const api = () => createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 10_000 });
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 13, 10, 13, 10, 255]);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('sendPhoto on the wire', () => {
  it('a caption with line breaks arrives byte for byte (LF stays LF)', async () => {
    const caption = 'Строка один\\.\n\n>цитата\n>ещё\n\nИллюстрация: a\\-b "q" \\\\ конец';
    const r = await sendPhoto(api(), '@ch', bytes, 'image/png', caption, {}, 'MarkdownV2');
    expect(r).toMatchObject({ ok: true });
    const req = fake.sent('sendPhoto')[0]!;
    expect(req.body).toEqual({ chat_id: '@ch', caption, parse_mode: 'MarkdownV2' });
    expect(req.body.caption).not.toContain('\r');
    expect(req.files.photo).toEqual({
      filename: 'image.png',
      type: 'image/png',
      size: bytes.length,
      sha256: sha(bytes),
    });
  });

  it('the raw body holds the caption once, between its part header and the next boundary', async () => {
    let raw = Buffer.alloc(0);
    let type = '';
    const capture: typeof fetch = async (input, init) => {
      raw = Buffer.from(init!.body as Uint8Array);
      type = new Headers(init!.headers).get('content-type') ?? '';
      return fetch(input, init);
    };
    const caption = 'a\nb\n\nc';
    await sendPhoto(
      createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, fetch: capture }),
      7,
      bytes,
      'image/jpeg',
      caption,
      {},
      'MarkdownV2',
    );
    const boundary = /^multipart\/form-data; boundary=(----journalist[0-9a-f]{32})$/.exec(
      type,
    )?.[1];
    expect(boundary).toBeDefined();
    const text = raw.toString('latin1');
    expect(text).toContain(
      `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n--${boundary}`,
    );
    expect(text).toContain(
      `Content-Disposition: form-data; name="photo"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    );
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    expect(raw.includes(bytes)).toBe(true);
    // The fake parses it with the standard multipart parser.
    expect(fake.sent('sendPhoto')[0]!.body).toEqual({
      chat_id: '7',
      caption,
      parse_mode: 'MarkdownV2',
    });
  });

  it('no parse_mode unless the caller asks for it, and never without a caption', async () => {
    await sendPhoto(api(), 1, bytes, 'image/png', 'подпись *как есть*');
    await sendPhoto(api(), 1, bytes, 'image/png', undefined, {}, 'MarkdownV2');
    await sendPhoto(api(), 1, bytes, 'image/png', '', {}, 'MarkdownV2');
    expect(fake.sent('sendPhoto').map((r) => r.body)).toEqual([
      { chat_id: '1', caption: 'подпись *как есть*' },
      { chat_id: '1' },
      { chat_id: '1' },
    ]);
  });

  it('a retry sends the same bytes and caption again', async () => {
    fake.queue('sendPhoto', { status: 500 }, { status: 429, retryAfter: 0 });
    const r = await sendPhoto(
      api(),
      1,
      bytes,
      'image/png',
      'x\ny',
      { sleep: async () => undefined },
      'MarkdownV2',
    );
    expect(r).toMatchObject({ ok: true, attempts: 3 });
    const sent = fake.sent('sendPhoto');
    expect(sent).toHaveLength(3);
    for (const s of sent) {
      expect(s.body).toEqual({ chat_id: '1', caption: 'x\ny', parse_mode: 'MarkdownV2' });
      expect(s.files.photo!.sha256).toBe(sha(bytes));
    }
    expect(fake.channel).toHaveLength(1);
  });

  it('an image of 5 MB goes out whole', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 0x5a);
    await sendPhoto(api(), 1, big, 'image/jpeg', 'c');
    expect(fake.sent('sendPhoto')[0]!.files.photo).toMatchObject({
      size: big.length,
      sha256: sha(big),
    });
  });
});
