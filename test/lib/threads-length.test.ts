import { describe, expect, it } from 'vitest';
import { fitsThreads, THREADS_LIMIT, threadsLength } from '../../src/lib/threads-length.js';

// Rule R1 of board task J-C3: the recorded examples of the task, all of them.

const ZWJ = '\u200D';
const EXAMPLES: [string, number][] = [
  ['', 0],
  ['Привет', 6],
  ['Кто пришёл на дискотеку?', 24],
  ['ok 👍', 7], // 3 + 4 bytes
  ['👍🏽', 8], // 4 + 4
  [`👨${ZWJ}👩${ZWJ}👧`, 18], // 4+3+4+3+4
  ['🇷🇺', 8], // two regional indicators
  ['1\uFE0F\u20E3', 7], // digit, U+FE0F, U+20E3: 1+3+3
  ['©', 2], // Extended_Pictographic
  ['™ и ®', 8], // 3+1+1+1+2
  ['e\u0301', 1], // NFC makes it one code point
  ['й', 1],
  ['и\u0306', 1],
  ['a\nb', 3],
  ['Чайник ушёл ☕ в 20:15', 23],
  ['😀😀😀', 12],
  ['x'.repeat(496) + '👍', 500],
  ['x'.repeat(497) + '👍', 501],
];

describe('threadsLength (rule R1)', () => {
  it.each(EXAMPLES)('%j -> %i', (text, n) => {
    expect(threadsLength(text)).toBe(n);
  });

  it('counts by code points, not UTF-16 units, outside the emoji classes', () => {
    // U+1D11E (a musical symbol) is two UTF-16 units and no emoji: it counts 1.
    expect('𝄞'.length).toBe(2);
    expect(threadsLength('𝄞')).toBe(1);
  });
});

describe('fitsThreads', () => {
  it('the limit is 500 units, inclusive', () => {
    expect(THREADS_LIMIT).toBe(500);
    expect(fitsThreads('x'.repeat(496) + '👍')).toBe(true);
    expect(fitsThreads('x'.repeat(497) + '👍')).toBe(false);
  });

  it('keeps `reserve` units free', () => {
    expect(fitsThreads('x'.repeat(480), 20)).toBe(true);
    expect(fitsThreads('x'.repeat(480), 21)).toBe(false);
  });
});
