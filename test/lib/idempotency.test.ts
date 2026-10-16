// idempotency.test.ts v1 - SPDX-License-Identifier: MIT - author zenith-claude
// node:test. Run: node --test idempotency.test.ts (Node 24 strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PublicationKeyError, publicationKey, textHash } from '../../src/lib/idempotency.js';

const cp = (...c: number[]) => String.fromCodePoint(...c);
const CR = cp(13),
  LF = cp(10),
  TAB = cp(9);
const KORESH = cp(0x41a, 0x43e, 0x440, 0x435, 0x448);
const I_NFC = cp(0x439); // CYRILLIC SMALL LETTER SHORT I
const I_NFD = cp(0x438, 0x306); // I + COMBINING BREVE
const ok = { platform: 'telegram', planDate: '2026-10-09', slotId: 'morning', part: 0 };

test('fixed vectors (computed independently with Python hashlib)', () => {
  assert.equal(textHash(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(
    textHash(KORESH),
    '075678e19c70ca6739a1aa5d14724e21ae09a7d7a36547eecc6c75870ee96916',
  );
  assert.equal(
    textHash('line one' + LF + 'line  two'),
    '63d842fc7f46ab3e94b21d1fb007270817dabdbb772ec5ab24b9a6732aeebf70',
  );
});

test('NFC and NFD input give the same hash', () => {
  assert.notEqual(I_NFC, I_NFD);
  assert.equal(textHash(I_NFD), textHash(I_NFC));
  assert.equal(textHash(I_NFD), '15f2ccabeb425c29c67317f181d744944e9c477d09fb42aacdbb4f64e1afcc3f');
});

test('edges and line endings are ignored', () => {
  const h = textHash('line one' + LF + 'line  two');
  assert.equal(textHash('line one' + LF + 'line  two' + LF), h);
  assert.equal(textHash(' ' + TAB + 'line one' + CR + LF + 'line  two' + CR + LF), h);
  assert.equal(textHash(' ' + LF), textHash(''));
});

test('inner whitespace is significant', () => {
  const h = textHash('line one' + LF + 'line  two');
  assert.notEqual(textHash('line one' + LF + 'line two'), h);
  assert.notEqual(textHash('line one' + LF + LF + 'line  two'), h);
  assert.notEqual(textHash('line one line  two'), h);
  // a lone CR is not a line ending under the contract (only CRLF is)
  assert.notEqual(textHash('line one' + CR + 'line  two'), h);
});

test('key format', () => {
  assert.equal(publicationKey(ok), 'telegram:2026-10-09:morning:0');
  assert.equal(
    publicationKey({ ...ok, platform: 'threads', slotId: 's-2', part: 3 }),
    'threads:2026-10-09:s-2:3',
  );
  for (const platform of ['telegram', 'threads', 'linkedin', 'facebook']) {
    assert.ok(publicationKey({ ...ok, platform }).startsWith(platform + ':'));
  }
  assert.equal(publicationKey({ ...ok, planDate: '2028-02-29' }), 'telegram:2028-02-29:morning:0');
  assert.equal(publicationKey({ ...ok, planDate: '0099-12-31' }), 'telegram:0099-12-31:morning:0');
});

test('the key does not depend on the text', () => {
  const draft = { ...ok, text: 'first draft' };
  const edited = { ...ok, text: 'edited' };
  assert.equal(publicationKey(draft), publicationKey(edited));
});

function refuses(patch: object, code: string) {
  assert.throws(
    () => publicationKey({ ...ok, ...patch } as typeof ok),
    (e: unknown) => {
      assert.ok(e instanceof PublicationKeyError);
      assert.equal(e.code, code);
      assert.equal(e.message, 'publication key: ' + code);
      return true;
    },
  );
}

test('bad platform', () => {
  for (const platform of ['twitter', '', 'Telegram', ' telegram', undefined, 7]) {
    refuses({ platform }, 'BAD_PLATFORM');
  }
});

test('bad date', () => {
  for (const planDate of [
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2027-02-29',
    '2026-10-9',
    '09.10.2026',
    '2026-10-09T00:00:00Z',
    ' 2026-10-09',
    '',
    undefined,
    20261009,
  ]) {
    refuses({ planDate }, 'BAD_DATE');
  }
});

test('bad slot', () => {
  for (const slotId of ['', ' ', 'a:b', ':', ' morning', 'morning' + LF, undefined, 5]) {
    refuses({ slotId }, 'BAD_SLOT');
  }
});

test('bad part', () => {
  for (const part of [-1, 1.5, NaN, Infinity, 2 ** 53, '1', undefined, null]) {
    refuses({ part }, 'BAD_PART');
  }
});

test('different slots never share a key', () => {
  const keys = new Set<string>();
  for (const platform of ['telegram', 'threads']) {
    for (const planDate of ['2026-10-09', '2026-10-10']) {
      for (const slotId of ['a', 'b', '1']) {
        for (const part of [0, 1, 10])
          keys.add(publicationKey({ platform, planDate, slotId, part }));
      }
    }
  }
  assert.equal(keys.size, 2 * 2 * 3 * 3);
});

// J-D1 (board task, theone, accepted 13.10.2026): the Date-based check read 0000-02-29 as
// 1900-02-29 and refused it. Leap years follow the Gregorian rule, year 0000 included.
test('J-D1 regression dates', () => {
  for (const planDate of ['0000-02-29', '0400-02-29']) {
    assert.equal(publicationKey({ ...ok, planDate }), `telegram:${planDate}:morning:0`);
  }
  for (const planDate of ['0100-02-29', '1900-02-29']) refuses({ planDate }, 'BAD_DATE');
});
