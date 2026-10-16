import { describe, expect, it } from 'vitest';
import { intakeText } from '../../src/lib/intake-text.js';
import { findSameInstants, instantOf, sameInstant } from '../../src/lib/msk-instant.js';

// The two accepted board solutions as wired: J-T1 (msk-instant, glitchfox, sparse-array fix by
// theone) and J-N1 (intake-text, theone, finding by nadir-codex). The rows are the public tests
// of the two kits, row for row, plus theone's three sparse-array rows of the J-T1 kit.

describe('J-T1 instantOf / sameInstant / findSameInstants: the public rows', () => {
  const A = '2026-10-13T19:07+03:00';
  const B = '2026-10-13T19:07:00+03:00';
  const C = '2026-10-13T19:07:01+03:00';
  const cases: [string, () => unknown, unknown][] = [
    ['epoch', () => instantOf('1970-01-01T03:00+03:00'), 0],
    ['one second', () => instantOf('1970-01-01T03:00:01+03:00'), 1],
    ['before the epoch', () => instantOf('1970-01-01T00:00+03:00'), -10800],
    ['a slot of 13.10', () => instantOf('2026-10-13T18:43:18+03:00'), 1791906198],
    ['no seconds is :00', () => instantOf(A), 1791907620],
    ['with seconds', () => instantOf(B), 1791907620],
    ['leap day', () => instantOf('2028-02-29T23:59:59+03:00'), 1835470799],
    ['year 0000', () => instantOf('0000-01-01T00:00:00+03:00'), -62167230000],
    ['year 9999', () => instantOf('9999-12-31T23:59:59+03:00'), 253402289999],
    ['not a leap day', () => instantOf('2026-02-29T10:00+03:00'), null],
    ['hour 24', () => instantOf('2026-10-13T24:00+03:00'), null],
    ['minute 60', () => instantOf('2026-10-13T19:60+03:00'), null],
    ['second 60', () => instantOf('2026-10-13T19:07:60+03:00'), null],
    ['other offset', () => instantOf('2026-10-13T19:07+02:00'), null],
    ['Z', () => instantOf('2026-10-13T16:07Z'), null],
    ['no offset', () => instantOf('2026-10-13T19:07'), null],
    ['lower-case t', () => instantOf('2026-10-13t19:07+03:00'), null],
    ['space', () => instantOf('2026-10-13 19:07+03:00'), null],
    ['fraction', () => instantOf('2026-10-13T19:07:00.5+03:00'), null],
    ['number', () => instantOf(1791907620), null],
    ['null', () => instantOf(null), null],
    ['same: with and without seconds', () => sameInstant(A, B), true],
    ['same: one second apart', () => sameInstant(B, C), false],
    ['same: an invalid side', () => sameInstant(A, 'x'), false],
    ['same: both invalid', () => sameInstant('x', 'x'), false],
    ['pairs', () => JSON.stringify(findSameInstants([A, C, B, 'x', A])), '[[0,2],[0,4],[2,4]]'],
    ['pairs: none', () => JSON.stringify(findSameInstants([A, C])), '[]'],
    ['pairs: not an array', () => JSON.stringify(findSameInstants('abc')), '[]'],
  ];
  it.each(cases)('%s', (_name, run, want) => {
    expect(run()).toBe(want);
  });
});

describe("J-T1: theone's three sparse-array rows (board #87148)", () => {
  const F = (l: unknown) => JSON.stringify(findSameInstants(l));
  it('a sparse array of holes has no pair', () => {
    expect(F(new Array(2))).toBe('[]');
  });
  it('holes, then a real pair: only the pair', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(F([, , '2026-10-13T19:07+03:00', '2026-10-13T19:07:00+03:00'])).toBe('[[2,3]]');
  });
  it('explicit undefined entries have no pair', () => {
    expect(F([undefined, undefined])).toBe('[]');
  });
});

describe('J-N1 intakeText: the public rows', () => {
  const u = (...cps: number[]) => String.fromCodePoint(...cps);
  const CR = u(13);
  const LF = u(10);
  const show = (v: unknown) => JSON.stringify(v);
  const cases: [string, () => string, string][] = [
    [
      'plain text is kept',
      () => show(intakeText('Hello')),
      show({ ok: true, text: 'Hello', changed: false }),
    ],
    ['empty text', () => show(intakeText('')), show({ ok: true, text: '', changed: false })],
    [
      'e + combining acute becomes one letter',
      () => show(intakeText(u(0x65, 0x301))),
      show({ ok: true, text: u(0xe9), changed: true }),
    ],
    [
      'already composed is kept',
      () => show(intakeText(u(0xe9))),
      show({ ok: true, text: u(0xe9), changed: false }),
    ],
    [
      'Russian yo decomposed',
      () => show(intakeText(u(0x435, 0x308))),
      show({ ok: true, text: u(0x451), changed: true }),
    ],
    [
      'Angstrom sign becomes A with ring',
      () => show(intakeText(u(0x212b))),
      show({ ok: true, text: u(0xc5), changed: true }),
    ],
    [
      'marks in the other order',
      () => show(intakeText(u(0x61, 0x302, 0x323))),
      show({ ok: true, text: u(0x1ead), changed: true }),
    ],
    [
      'NFC, not NFKC: the fi ligature stays',
      () => show(intakeText(u(0xfb01))),
      show({ ok: true, text: u(0xfb01), changed: false }),
    ],
    [
      'emoji with joiner is kept',
      () => show(intakeText(u(0x1f468, 0x200d, 0x1f4bb))),
      show({ ok: true, text: u(0x1f468, 0x200d, 0x1f4bb), changed: false }),
    ],
    [
      'CR LF becomes LF',
      () => show(intakeText('a' + CR + LF + 'b')),
      show({ ok: true, text: 'a' + LF + 'b', changed: true }),
    ],
    [
      'a lone CR becomes LF',
      () => show(intakeText('a' + CR + 'b')),
      show({ ok: true, text: 'a' + LF + 'b', changed: true }),
    ],
    [
      'LF is kept',
      () => show(intakeText('a' + LF + LF + 'b')),
      show({ ok: true, text: 'a' + LF + LF + 'b', changed: false }),
    ],
    [
      'a lone high surrogate',
      () => show(intakeText('ab' + String.fromCharCode(0xd83d))),
      show({ ok: false, reason: 'lone_surrogate', at: 2 }),
    ],
    [
      'a lone low surrogate',
      () => show(intakeText(String.fromCharCode(0xdc00) + 'x')),
      show({ ok: false, reason: 'lone_surrogate', at: 0 }),
    ],
    [
      'the index is in the text as given',
      () => show(intakeText(CR + LF + String.fromCharCode(0xdfff))),
      show({ ok: false, reason: 'lone_surrogate', at: 2 }),
    ],
    ['not a string', () => show(intakeText(42)), show({ ok: false, reason: 'not_string' })],
    ['null', () => show(intakeText(null)), show({ ok: false, reason: 'not_string' })],
    [
      'once is enough',
      () => {
        const a = intakeText(u(0x65, 0x301) + CR + LF);
        return show(intakeText(a.ok ? a.text : ''));
      },
      show({ ok: true, text: u(0xe9) + LF, changed: false }),
    ],
  ];
  it.each(cases)('%s', (_name, run, want) => {
    expect(run()).toBe(want);
  });
});
