import { describe, expect, it } from 'vitest';
import {
  decodeImage,
  IMAGE_MAX_RATIO,
  IMAGE_MAX_SIDE_SUM,
  IMAGE_MIN_SIDE,
  imageSize,
  sizeProblem,
} from '../../src/lib/image.js';
import { b64, jpeg, png } from '../support/images.js';

describe('decodeImage', () => {
  const MAX = 1000;
  const small = png(4, 4);

  it('returns the bytes of a strict base64 image whose magic agrees with the mime', () => {
    const r = decodeImage(b64(small), 'image/png', MAX);
    expect(r.ok && r.bytes.equals(small)).toBe(true);
    const j = jpeg(4, 4);
    const rj = decodeImage(b64(j), 'image/jpeg', MAX);
    expect(rj.ok && rj.bytes.equals(j)).toBe(true);
  });

  it.each([
    ['whitespace', `${b64(small).slice(0, 8)}\n${b64(small).slice(8)}`],
    ['a wrong length', `${b64(small)}A`],
    ['url-safe characters', b64(small).replace(/.$/, '-')],
    ['padding in the middle', `ab==${b64(small)}`],
  ])('bad_base64 (422) on %s', (_name, text) => {
    expect(decodeImage(text, 'image/png', MAX)).toMatchObject({
      ok: false,
      status: 422,
      code: 'bad_base64',
    });
  });

  it('too_large (413) is decided from the text length: max passes, max + 1 does not', () => {
    for (const pad of [0, 1, 2]) {
      const size = 300 + pad; // 300, 301, 302 bytes: padding '', '==', '='
      const bytes = Buffer.concat([png(1, 1), Buffer.alloc(400)]).subarray(0, size);
      expect(decodeImage(b64(bytes), 'image/png', size).ok).toBe(true);
      expect(decodeImage(b64(bytes), 'image/png', size - 1)).toMatchObject({
        ok: false,
        status: 413,
        code: 'too_large',
      });
    }
  });

  it('mime_mismatch (422) when the leading bytes are another format or too short', () => {
    const no = { ok: false, status: 422, code: 'mime_mismatch' };
    expect(decodeImage(b64(small), 'image/jpeg', MAX)).toMatchObject(no);
    expect(decodeImage(b64(jpeg(4, 4)), 'image/png', MAX)).toMatchObject(no);
    expect(decodeImage(b64(Buffer.from('GIF89a........')), 'image/png', MAX)).toMatchObject(no);
    expect(decodeImage(b64(Buffer.from('%PDF-1.7 ....')), 'image/jpeg', MAX)).toMatchObject(no);
    expect(decodeImage(b64(small.subarray(0, 7)), 'image/png', MAX)).toMatchObject(no);
    // Every byte of the magic counts.
    for (let i = 0; i < 8; i++) {
      const b = Buffer.from(small);
      b[i] = b[i]! ^ 1;
      expect(decodeImage(b64(b), 'image/png', MAX)).toMatchObject(no);
    }
    for (let i = 0; i < 3; i++) {
      const b = jpeg(4, 4);
      b[i] = b[i]! ^ 1;
      expect(decodeImage(b64(b), 'image/jpeg', MAX)).toMatchObject(no);
    }
  });
});

describe('imageSize', () => {
  it('reads width and height of a PNG from IHDR', () => {
    expect(imageSize(png(640, 480), 'image/png')).toEqual({ width: 640, height: 480 });
    expect(imageSize(png(1, 300), 'image/png')).toEqual({ width: 1, height: 300 });
    const big = png(1, 1);
    big.writeUInt32BE(70_000, 16);
    big.writeUInt32BE(3_000_000_000, 20);
    expect(imageSize(big, 'image/png')).toEqual({ width: 70_000, height: 3_000_000_000 });
  });

  it('a PNG without a readable IHDR has no size', () => {
    const p = png(640, 480);
    expect(imageSize(p.subarray(0, 23), 'image/png')).toBeUndefined();
    const notIhdr = Buffer.from(p);
    notIhdr.write('IDAT', 12, 'latin1');
    expect(imageSize(notIhdr, 'image/png')).toBeUndefined();
    const badLength = Buffer.from(p);
    badLength.writeUInt32BE(12, 8);
    expect(imageSize(badLength, 'image/png')).toBeUndefined();
  });

  it('reads width and height of a JPEG from its frame header', () => {
    expect(imageSize(jpeg(640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 });
    expect(imageSize(jpeg(300, 2000, { sof: 0xc2 }), 'image/jpeg')).toEqual({
      width: 300,
      height: 2000,
    });
    // A long APP1 (EXIF) before the frame, and a fill byte before the marker.
    expect(imageSize(jpeg(800, 600, { app1: 60_000, fill: true }), 'image/jpeg')).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('a JPEG without a readable frame header has no size', () => {
    const j = jpeg(640, 480);
    const sof = j.indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof).toBeGreaterThan(0);
    // Cut inside the frame header, and right before it.
    expect(imageSize(j.subarray(0, sof + 8), 'image/jpeg')).toBeUndefined();
    expect(imageSize(j.subarray(0, sof), 'image/jpeg')).toBeUndefined();
    // The scan starts before any frame header.
    const scanFirst = Buffer.from(j);
    scanFirst[sof + 1] = 0xda;
    expect(imageSize(scanFirst, 'image/jpeg')).toBeUndefined();
    // Not a marker where one must be.
    const broken = Buffer.from(j);
    broken[2] = 0x00;
    expect(imageSize(broken, 'image/jpeg')).toBeUndefined();
    // A segment length below 2 would never advance.
    const zeroLength = Buffer.from(j);
    zeroLength.writeUInt16BE(1, 4);
    expect(imageSize(zeroLength, 'image/jpeg')).toBeUndefined();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg')).toBeUndefined();
  });

  it('DHT (C4) is not taken for a frame header', () => {
    // The test JPEG has a DHT segment before SOF0 filled with 0x02: a wrong read would be 514.
    expect(imageSize(jpeg(640, 480), 'image/jpeg')!.width).toBe(640);
  });
});

describe('sizeProblem', () => {
  it('each side must be at least 200', () => {
    expect(sizeProblem({ width: IMAGE_MIN_SIDE, height: IMAGE_MIN_SIDE })).toBeUndefined();
    expect(sizeProblem({ width: 199, height: 200 })?.code).toBe('too_small');
    expect(sizeProblem({ width: 200, height: 199 })?.code).toBe('too_small');
    expect(sizeProblem({ width: 100, height: 100 })?.code).toBe('too_small');
    expect(sizeProblem({ width: 0, height: 0 })?.code).toBe('too_small');
  });

  it('width plus height must be at most 10000', () => {
    expect(sizeProblem({ width: 5000, height: 5000 })).toBeUndefined();
    expect(sizeProblem({ width: 5001, height: 5000 })?.code).toBe('too_big');
    expect(sizeProblem({ width: 9000, height: 2000 })?.code).toBe('too_big');
    expect(IMAGE_MAX_SIDE_SUM).toBe(10_000);
  });

  it('the ratio of the sides must be at most 20, either way round', () => {
    expect(IMAGE_MAX_RATIO).toBe(20);
    expect(sizeProblem({ width: 4000, height: 200 })).toBeUndefined();
    expect(sizeProblem({ width: 200, height: 4000 })).toBeUndefined();
    expect(sizeProblem({ width: 4001, height: 200 })?.code).toBe('bad_ratio');
    expect(sizeProblem({ width: 200, height: 4001 })?.code).toBe('bad_ratio');
    expect(sizeProblem({ width: 250, height: 5100 })?.code).toBe('bad_ratio');
  });
});
