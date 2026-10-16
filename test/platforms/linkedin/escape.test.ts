import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LITTLE_TEXT_RESERVED, escapeLittleText } from '../../../src/platforms/linkedin/escape.js';
import { readLittleText } from './fake-linkedin.js';

// The list as LinkedIn's little text page gives it, written out here on purpose (not taken from
// the source constant): | { } @ [ ] ( ) < > # \ * _ ~
const RESERVED = ['|', '{', '}', '@', '[', ']', '(', ')', '<', '>', '#', '\\', '*', '_', '~'];

describe('escapeLittleText', () => {
  it.each(RESERVED)('puts one backslash before %s', (ch) => {
    expect(escapeLittleText(ch)).toBe(`\\${ch}`);
    expect(escapeLittleText(`до ${ch} после`)).toBe(`до \\${ch} после`);
  });

  it('knows exactly the fifteen reserved characters', () => {
    expect([...LITTLE_TEXT_RESERVED].sort()).toEqual([...RESERVED].sort());
  });

  it('escapes Cyrillic text with brackets and a link', () => {
    const text =
      'Новости от Корпорации всевластия (выпуск #3) [черновик]\n' +
      'Подпись: Кореш_бот <ИИ> * 100% ~ почти\n\n' +
      'https://t.me/Channel1/57';
    expect(escapeLittleText(text)).toBe(
      'Новости от Корпорации всевластия \\(выпуск \\#3\\) \\[черновик\\]\n' +
        'Подпись: Кореш\\_бот \\<ИИ\\> \\* 100% \\~ почти\n\n' +
        'https://t.me/Channel1/57',
    );
  });

  it('escapes reserved characters inside a link too', () => {
    expect(escapeLittleText('https://example.com/a_b(c)#d')).toBe(
      'https://example.com/a\\_b\\(c\\)\\#d',
    );
  });

  it('escapes a backslash once and does not touch the backslash it adds', () => {
    expect(escapeLittleText('a\\b')).toBe('a\\\\b');
    expect(escapeLittleText('\\(')).toBe('\\\\\\(');
  });

  it('is applied exactly once: it is not idempotent, a second pass escapes the escapes', () => {
    const once = escapeLittleText('(a)');
    expect(once).toBe(String.raw`\(a\)`);
    const twice = escapeLittleText(once);
    expect(twice).toBe(String.raw`\\\(a\\\)`);
    expect(twice).not.toBe(once);
    // A reader of the twice-escaped text sees the backslashes of the first pass.
    expect(readLittleText(twice).text).toBe(once);
  });

  it('leaves plain text, line breaks, quotes and emoji as they are', () => {
    const plain = 'Привет, мир! «Кавычки», "quotes", 100% & 50/50: да?\nвторая строка 🙂 👨‍👩‍👧';
    expect(escapeLittleText(plain)).toBe(plain);
    expect(escapeLittleText('')).toBe('');
  });

  it('for any text: a reader sees the text as written and nothing reserved is left bare', () => {
    const anyText = fc.string({ unit: 'grapheme', maxLength: 200 });
    const spiced = fc
      .array(fc.oneof(fc.constantFrom(...RESERVED), fc.constantFrom('я', 'a', ' ', '\n', '🙂')), {
        maxLength: 80,
      })
      .map((a) => a.join(''));
    fc.assert(
      fc.property(fc.oneof(anyText, spiced), (text) => {
        const escaped = escapeLittleText(text);
        const seen = readLittleText(escaped);
        expect(seen.text).toBe(text);
        expect(seen.unescapedReserved).toEqual([]);
        const reserved = [...text].filter((ch) => RESERVED.includes(ch)).length;
        expect(escaped.length).toBe(text.length + reserved);
      }),
    );
  });
});
