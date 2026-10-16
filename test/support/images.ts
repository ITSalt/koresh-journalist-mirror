import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { Store } from '../../src/store/index.js';

// Test images built in memory: a real (decodable) PNG of any size, and a JPEG that is a valid
// segment structure up to its frame header. No file and no network is involved.

const be32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([be32(data.length), body, be32(crc32(body))]);
}

/** A valid 8-bit RGB PNG of `width` x `height`; `seed` changes the pixels (and so the sha256). */
export function png(width: number, height: number, seed = 0): Buffer {
  const ihdr = Buffer.concat([be32(width), be32(height), Buffer.from([8, 2, 0, 0, 0])]);
  const raw = Buffer.alloc(height * (1 + width * 3), seed & 0xff);
  for (let y = 0; y < height; y++) raw[y * (1 + width * 3)] = 0; // filter type: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`seed\0${seed}`, 'latin1')),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const segment = (marker: number, data: Buffer) => {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, data]);
};

export interface JpegOptions {
  /** Frame marker: 0xc0 baseline (default), 0xc2 progressive. */
  sof?: number;
  /** Bytes of an APP1 (EXIF-like) segment placed before the frame header. */
  app1?: number;
  /** A 0xFF fill byte before the frame marker. */
  fill?: boolean;
  seed?: number;
}

/** A JPEG header: SOI, APP0 (JFIF), optional APP1, DQT, SOFn, then a scan stub and EOI. */
export function jpeg(width: number, height: number, o: JpegOptions = {}): Buffer {
  const sof = Buffer.from([8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    ...(o.app1 ? [segment(0xe1, Buffer.alloc(o.app1, 0x45))] : []),
    segment(0xdb, Buffer.alloc(65, 1)),
    // A DHT segment (C4) comes before the frame on purpose: it is no frame header.
    segment(0xc4, Buffer.alloc(20, 2)),
    ...(o.fill ? [Buffer.from([0xff])] : []),
    segment(o.sof ?? 0xc0, sof),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([o.seed ?? 0, 0x55, 0xff, 0xd9]),
  ]);
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

/** Stores a PNG of the given size straight in the store; returns its bytes and sha256. */
export function seedImage(store: Store, width = 640, height = 480, seed = 0) {
  const bytes = png(width, height, seed);
  const { image } = store.images.add({ mime: 'image/png', bytes, width, height });
  return { bytes, sha256: image.sha256, width, height, mime: 'image/png' as const };
}
