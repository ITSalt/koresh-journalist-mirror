import { describe, expect, it } from 'vitest';
import { fitsThreads, THREADS_LIMIT, threadsLength } from '../../../src/platforms/threads/index.js';

// Invisible code points are built by number so that the file shows what is in it.
const cp = (...points: number[]) => String.fromCodePoint(...points);
const ZWJ = cp(0x200d);
const VS16 = cp(0xfe0f);
const KEYCAP = cp(0x20e3);
const THUMB = cp(0x1f44d);
const SKIN = cp(0x1f3fd);
const MAN = cp(0x1f468);
const WOMAN = cp(0x1f469);
const GIRL = cp(0x1f467);
const FLAG_RU = cp(0x1f1f7, 0x1f1fa);
const GRIN = cp(0x1f600);
const COFFEE = cp(0x2615);

// Recorded examples of rule R1 (board task J-C3): all of them.
const RECORDED: [string, string, number][] = [
  ['empty', '', 0],
  ['Cyrillic', 'Привет', 6],
  ['Cyrillic sentence', 'Кто пришёл на дискотеку?', 24],
  ['text and one emoji (3 + 4 bytes)', `ok ${THUMB}`, 7],
  ['emoji with a skin tone (4 + 4)', `${THUMB}${SKIN}`, 8],
  ['family joined by ZWJ (4+3+4+3+4)', `${MAN}${ZWJ}${WOMAN}${ZWJ}${GIRL}`, 18],
  ['flag: two regional indicators', FLAG_RU, 8],
  ['keycap: digit, U+FE0F, U+20E3 (1+3+3)', `1${VS16}${KEYCAP}`, 7],
  ['copyright sign is Extended_Pictographic', '©', 2],
  ['trademark, text, registered (3+1+1+1+2)', '™ и ®', 8],
  ['e + combining acute becomes one code point', `e${cp(0x301)}`, 1],
  ['й', 'й', 1],
  ['и + combining breve becomes й', `и${cp(0x306)}`, 1],
  ['line break', 'a\nb', 3],
  ['sentence with a hot drink', `Чайник ушёл ${COFFEE} в 20:15`, 23],
  ['three emoji', GRIN.repeat(3), 12],
  ['496 x and an emoji', 'x'.repeat(496) + THUMB, 500],
  ['497 x and an emoji', 'x'.repeat(497) + THUMB, 501],
];

describe('threadsLength (rule R1)', () => {
  it('the limit is 500', () => {
    expect(THREADS_LIMIT).toBe(500);
  });

  it.each(RECORDED)('%s', (_name, text, expected) => {
    expect(threadsLength(text)).toBe(expected);
  });

  it('counts by code points, not UTF-16 units, outside the emoji classes', () => {
    // U+1D11E (musical G clef) is two UTF-16 units and not pictographic: it counts 1.
    expect(threadsLength(cp(0x1d11e))).toBe(1);
  });
});

describe('fitsThreads', () => {
  it('500 fits, 501 does not', () => {
    expect(fitsThreads('x'.repeat(496) + THUMB)).toBe(true);
    expect(fitsThreads('x'.repeat(497) + THUMB)).toBe(false);
  });

  it('a reserve is added to the length', () => {
    expect(fitsThreads('x'.repeat(480), 20)).toBe(true);
    expect(fitsThreads('x'.repeat(480), 21)).toBe(false);
  });
});
