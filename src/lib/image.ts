// PNG and JPEG checks without a dependency (WP-SVC-23, WP-SVC-24): the leading bytes must agree
// with the declared mime, and the pixel size is read from the header (PNG IHDR, JPEG SOF). The
// size rules are those of the Bot API `sendPhoto`, plus a minimum side.

export type ImageMime = 'image/png' | 'image/jpeg';

/** Leading bytes of the allowed formats; the declared mime must agree with them. */
const MAGIC: Record<ImageMime, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

/** Strict standard base64 (no whitespace); a flat character class, safe on a multi-MB string. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const IMAGE_MIN_SIDE = 200;
export const IMAGE_MAX_SIDE_SUM = 10_000;
export const IMAGE_MAX_RATIO = 20;

export type Decoded =
  { ok: true; bytes: Buffer } | { ok: false; status: 413 | 422; code: string; error: string };

/**
 * Decodes `imageBase64` after checking, in this order: it is strict base64; the decoded size
 * (computed from the text length, before anything is decoded) is at most `maxBytes`; the bytes
 * start with the magic of `mime`.
 */
export function decodeImage(imageBase64: string, mime: ImageMime, maxBytes: number): Decoded {
  if (imageBase64.length % 4 !== 0 || !BASE64.test(imageBase64)) {
    return { ok: false, status: 422, code: 'bad_base64', error: 'imageBase64 is not valid base64' };
  }
  const pad = imageBase64.endsWith('==') ? 2 : imageBase64.endsWith('=') ? 1 : 0;
  const size = (imageBase64.length / 4) * 3 - pad;
  if (size > maxBytes) {
    return {
      ok: false,
      status: 413,
      code: 'too_large',
      error: `the image is over ${maxBytes} bytes`,
    };
  }
  const bytes = Buffer.from(imageBase64, 'base64');
  const magic = MAGIC[mime];
  if (bytes.length < magic.length || !magic.every((b, i) => bytes[i] === b)) {
    return {
      ok: false,
      status: 422,
      code: 'mime_mismatch',
      error: `the image bytes are not ${mime}`,
    };
  }
  return { ok: true, bytes };
}

export interface ImageSize {
  width: number;
  height: number;
}

const u16 = (b: Uint8Array, i: number) => b[i]! * 256 + b[i + 1]!;
const u32 = (b: Uint8Array, i: number) => u16(b, i) * 65536 + u16(b, i + 2);

/** PNG: the first chunk is IHDR (length 13); width and height are its first two fields. */
function pngSize(b: Uint8Array): ImageSize | undefined {
  if (b.length < 24 || u32(b, 8) !== 13) return undefined;
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return undefined;
  return { width: u32(b, 16), height: u32(b, 20) };
}

/** Frame headers SOF0..SOF15, without DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** JPEG: walks the segments after SOI to the first frame header (SOFn). */
function jpegSize(b: Uint8Array): ImageSize | undefined {
  for (let i = 2; i + 3 < b.length;) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++; // a fill byte before the marker
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2; // TEM, RSTn, SOI: no payload
      continue;
    }
    // End of image or start of scan before any frame header: there is no size to read.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16(b, i + 2);
    if (length < 2) return undefined;
    if (isSof(marker)) {
      if (i + 9 > b.length) return undefined;
      return { height: u16(b, i + 5), width: u16(b, i + 7) };
    }
    i += 2 + length;
  }
  return undefined;
}

/** Pixel size from the header; undefined when the header cannot be read. */
export function imageSize(bytes: Uint8Array, mime: ImageMime): ImageSize | undefined {
  return mime === 'image/png' ? pngSize(bytes) : jpegSize(bytes);
}

/** The size rules of a channel image; undefined when the size is fine. */
export function sizeProblem(s: ImageSize): { code: string; error: string } | undefined {
  const is = `the image is ${s.width}x${s.height}`;
  if (Math.min(s.width, s.height) < IMAGE_MIN_SIDE) {
    return { code: 'too_small', error: `${is}; each side must be at least ${IMAGE_MIN_SIDE} px` };
  }
  if (s.width + s.height > IMAGE_MAX_SIDE_SUM) {
    return {
      code: 'too_big',
      error: `${is}; width plus height must be at most ${IMAGE_MAX_SIDE_SUM}`,
    };
  }
  if (Math.max(s.width, s.height) > IMAGE_MAX_RATIO * Math.min(s.width, s.height)) {
    return {
      code: 'bad_ratio',
      error: `${is}; the ratio of the sides must be at most ${IMAGE_MAX_RATIO}`,
    };
  }
  return undefined;
}
