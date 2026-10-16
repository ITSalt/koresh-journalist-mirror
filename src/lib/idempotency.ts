// idempotency.ts v1 - SPDX-License-Identifier: MIT - author zenith-claude
//
// publicationKey does NOT depend on the text. A slot is identified by platform, plan date,
// slot id and part number only, so editing a planned text never yields a second post for
// the same slot. textHash is for detecting that the text changed, not for building the key.
import { createHash } from 'node:crypto';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

export const PLATFORMS = ['telegram', 'threads', 'linkedin', 'facebook'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type KeyErrorCode = 'BAD_PLATFORM' | 'BAD_DATE' | 'BAD_SLOT' | 'BAD_PART';

export class PublicationKeyError extends Error {
  readonly code: KeyErrorCode;
  constructor(code: KeyErrorCode) {
    super('publication key: ' + code); // fixed text, never the offending value
    this.name = 'PublicationKeyError';
    this.code = code;
  }
}

/** sha256 hex of the text in NFC, with CRLF turned into LF and both edges trimmed. */
export function textHash(text: string): string {
  const canonical = text
    .normalize('NFC')
    .split(CR + LF)
    .join(LF)
    .trim();
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// J-D1 by theone, board task J-D1, accepted 13.10.2026. Proleptic Gregorian years 0000 through
// 9999. Replaces a Date-based check that read 0000-02-29 as 1900-02-29 and refused it.
function isCalendarDate(s: unknown): s is string {
  if (typeof s !== 'string' || s.length !== 10 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s))
    return false;
  const y = +s.slice(0, 4),
    m = +s.slice(5, 7),
    d = +s.slice(8, 10);
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
  return d <= last;
}

export function publicationKey(p: {
  platform: string;
  planDate: string;
  slotId: string;
  part: number;
}): string {
  if (typeof p.platform !== 'string' || !(PLATFORMS as readonly string[]).includes(p.platform)) {
    throw new PublicationKeyError('BAD_PLATFORM');
  }
  if (!isCalendarDate(p.planDate)) throw new PublicationKeyError('BAD_DATE');
  // ':' is the separator: a slot id holding it could make two different slots share a key
  if (typeof p.slotId !== 'string' || !/^[^:]+$/.test(p.slotId) || p.slotId.trim() !== p.slotId) {
    throw new PublicationKeyError('BAD_SLOT');
  }
  if (typeof p.part !== 'number' || !Number.isSafeInteger(p.part) || p.part < 0) {
    throw new PublicationKeyError('BAD_PART');
  }
  return p.platform + ':' + p.planDate + ':' + p.slotId + ':' + p.part;
}
