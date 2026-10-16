import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PHOTO_BODY_LIMIT, PHOTO_MAX_BYTES } from '../../src/api/director.js';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { b64, jpeg, png, sha256 } from '../support/images.js';

// WP-SVC-24 scope 1: POST /v1/images stores a PNG or JPEG once, under the sha256 of its bytes.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const NOW = new Date('2026-10-12T10:00:00Z');

let store: Store;
let logs: string[];
beforeEach(() => {
  store = openStore(':memory:');
  logs = [];
});
afterEach(() => store.close());

function app() {
  return buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: API_TOKEN }),
    store,
    logLevel: 'info',
    logStream: { write: (l) => void logs.push(l) },
    now: () => NOW,
  });
}
type App = ReturnType<typeof app>;

const post = (a: App, payload: unknown, headers: Record<string, string> = auth) =>
  a.inject({ method: 'POST', url: '/v1/images', headers, payload: payload as object });
const up = (a: App, bytes: Buffer, mime = 'image/png') =>
  post(a, { imageBase64: b64(bytes), mime });
const rows = () =>
  store.db.prepare('SELECT sha256, mime, size, width, height, created_at FROM images').all();

describe('POST /v1/images', () => {
  it.each([
    ['image/png', png(640, 480)],
    ['image/jpeg', jpeg(1280, 720)],
  ])('stores a %s under its sha256: 201 with the facts of the image', async (mime, bytes) => {
    const res = await up(app(), bytes, mime);
    expect(res.statusCode).toBe(201);
    const [width, height] = mime === 'image/png' ? [640, 480] : [1280, 720];
    expect(res.json()).toEqual({ sha256: sha256(bytes), mime, size: bytes.length, width, height });
    expect(rows()).toEqual([
      {
        sha256: sha256(bytes),
        mime,
        size: bytes.length,
        width,
        height,
        created_at: NOW.toISOString(),
      },
    ]);
    expect(store.images.get(sha256(bytes))!.bytes.equals(bytes)).toBe(true);
  });

  it('the same bytes again: 200 with the same sha256 and still one row', async () => {
    const a = app();
    const bytes = png(640, 480);
    const first = await up(a, bytes);
    const second = await up(a, bytes);
    expect([first.statusCode, second.statusCode]).toEqual([201, 200]);
    expect(second.json()).toEqual(first.json());
    expect(rows()).toHaveLength(1);
    // Another image is another row.
    expect((await up(a, png(640, 480, 7))).statusCode).toBe(201);
    expect(rows()).toHaveLength(2);
  });

  it('accepts the limits exactly: 200x200, 5000x5000, a 20:1 strip', async () => {
    const a = app();
    for (const [w, h] of [
      [200, 200],
      [5000, 5000],
      [4000, 200],
      [200, 4000],
    ] as const) {
      const res = await up(a, jpeg(w, h), 'image/jpeg');
      expect(res.statusCode, `${w}x${h}`).toBe(201);
      expect(res.json()).toMatchObject({ width: w, height: h });
    }
  });

  describe('refusals: nothing is stored', () => {
    afterEach(() => expect(rows()).toEqual([]));

    it.each(['image/gif', 'application/pdf', 'image/webp', 'IMAGE/PNG', '', 5, undefined])(
      '422 on mime %s',
      async (mime) => {
        const res = await post(app(), { imageBase64: b64(png(640, 480)), mime });
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toBe('invalid_body');
        expect(res.json().message).toContain('mime');
      },
    );

    it('422 mime_mismatch: PNG bytes declared jpeg, and the other way round', async () => {
      const a = app();
      const one = await up(a, png(640, 480), 'image/jpeg');
      expect(one.statusCode).toBe(422);
      expect(one.json().error).toBe('mime_mismatch');
      expect((await up(a, jpeg(640, 480), 'image/png')).json().error).toBe('mime_mismatch');
      const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)]);
      expect((await up(a, gif, 'image/png')).json().error).toBe('mime_mismatch');
    });

    it('422 bad_base64', async () => {
      const a = app();
      for (const imageBase64 of ['not base64!', `${b64(png(640, 480))}=`, 'abc']) {
        const res = await post(a, { imageBase64, mime: 'image/png' });
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toBe('bad_base64');
      }
    });

    it('413 too_large over 5 MB decoded; exactly 5 MB is not too large', async () => {
      const a = app();
      const head = png(640, 480);
      const over = Buffer.concat([head, Buffer.alloc(PHOTO_MAX_BYTES + 1 - head.length, 0x41)]);
      const res = await up(a, over);
      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe('too_large');
      expect(rows()).toEqual([]);
      const exact = over.subarray(0, PHOTO_MAX_BYTES);
      expect((await up(a, exact)).statusCode).toBe(201);
      store.db.exec('DELETE FROM images');
    });

    it('413 when the JSON body is over the 8 MB route limit', async () => {
      const res = await post(app(), {
        imageBase64: 'A'.repeat(PHOTO_BODY_LIMIT),
        mime: 'image/png',
      });
      expect(res.statusCode).toBe(413);
    });

    it.each([
      ['a 100x100 image', 100, 100, 'too_small'],
      ['a 199x640 image', 199, 640, 'too_small'],
      ['a 640x199 image', 640, 199, 'too_small'],
      ['a 9000x2000 image', 9000, 2000, 'too_big'],
      ['a 5001x5000 image', 5001, 5000, 'too_big'],
      ['a ratio over 20 (4100x200)', 4100, 200, 'bad_ratio'],
      ['a ratio over 20 (200x4001)', 200, 4001, 'bad_ratio'],
    ])('422 on %s', async (_name, w, h, code) => {
      const a = app();
      for (const [bytes, mime] of [
        [jpeg(w, h), 'image/jpeg'],
        // A PNG header alone is enough to refuse: the size is read from IHDR.
        [png(w, 1).fill(Buffer.from([h >> 8, h & 255]), 22, 24), 'image/png'],
      ] as const) {
        const res = await up(a, bytes, mime);
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toBe(code);
        expect(res.json().message).toContain(`${w}x${h}`);
      }
    });

    it('422 unreadable_image when the header gives no size', async () => {
      const a = app();
      const truncated = png(640, 480).subarray(0, 20);
      expect((await up(a, truncated)).json().error).toBe('unreadable_image');
      const noFrame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const res = await up(a, noFrame, 'image/jpeg');
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('unreadable_image');
    });

    it('422 on an unknown key, a missing field or a body that is no object', async () => {
      const a = app();
      const ok = { imageBase64: b64(png(640, 480)), mime: 'image/png' };
      for (const body of [
        { ...ok, credit: 'x' },
        { ...ok, sha256: 'a'.repeat(64) },
        { ...ok, chatId: 1 },
        { mime: 'image/png' },
        { imageBase64: '', mime: 'image/png' },
        [ok],
      ]) {
        const res = await post(a, body);
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toBe('invalid_body');
      }
      // The message names the unknown key, never its value or the image.
      const res = await post(a, { ...ok, credit: 'x' });
      expect(res.json().message).toContain('credit');
      expect(res.body.length).toBeLessThan(300);
    });

    it('401 without the bearer token, before the body is read', async () => {
      const a = app();
      const ok = { imageBase64: b64(png(640, 480)), mime: 'image/png' };
      expect((await post(a, ok, {})).statusCode).toBe(401);
      expect((await post(a, ok, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
      const huge = await post(a, { imageBase64: 'A'.repeat(PHOTO_BODY_LIMIT) }, {});
      expect(huge.statusCode).toBe(401);
    });
  });

  it('the bytes are never logged: only sha256, mime, size and the pixel size', async () => {
    const bytes = png(640, 480, 3);
    const text = b64(bytes);
    const a = app();
    expect((await up(a, bytes)).statusCode).toBe(201);
    expect((await up(a, bytes)).statusCode).toBe(200);
    expect((await up(a, png(100, 100, 3))).statusCode).toBe(422);
    const all = logs.join('\n');
    expect(all).toContain(sha256(bytes));
    expect(all).toContain('image stored');
    for (const piece of [text.slice(0, 40), text.slice(100, 160), text.slice(-40)]) {
      expect(all).not.toContain(piece);
    }
    const stored = logs.map((l) => JSON.parse(l)).filter((l) => l.msg === 'image stored');
    expect(stored.map((l) => l.created)).toEqual([true, false]);
    expect(Object.keys(stored[0]).sort()).toEqual(
      ['created', 'height', 'hostname', 'level', 'mime', 'msg', 'pid', 'reqId', 'sha256', 'size']
        .concat(['time', 'width'])
        .sort(),
    );
  });

  it('sends nothing and writes no other row', async () => {
    expect((await up(app(), png(640, 480))).statusCode).toBe(201);
    expect(store.alerts.list()).toEqual([]);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM publications').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM owner_drafts').get()).toEqual({ n: 0 });
  });
});
