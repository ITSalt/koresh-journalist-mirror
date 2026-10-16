import { describe, expect, it } from 'vitest';
import { countLinks } from '../../../src/platforms/threads/platform-facts.js';
import type { PublishInput } from '../../../src/platforms/types.js';
import { validate } from '../../../src/platforms/threads/validate.js';

const THUMB = String.fromCodePoint(0x1f44d);
const input = (text: string, over: Partial<PublishInput> = {}): PublishInput => ({
  key: 'threads:2026-10-20:s1:0',
  text,
  lang: 'ru',
  ...over,
});
const codes = (i: PublishInput) => validate(i).map((x) => x.code);

describe('validate', () => {
  it('accepts an ordinary short post', () => {
    expect(validate(input('Чайник ушёл в 20:15. Кто его видел?'))).toEqual([]);
  });

  it('refuses an empty or blank text', () => {
    expect(codes(input(''))).toEqual(['empty_text']);
    expect(codes(input(' \n\t '))).toEqual(['empty_text']);
  });

  it('refuses an empty key (the steps are recorded under it)', () => {
    expect(codes(input('текст', { key: '' }))).toEqual(['empty_key']);
  });

  it('length: exactly 500 by rule R1 passes, 501 does not', () => {
    expect(validate(input('x'.repeat(500)))).toEqual([]);
    expect(codes(input('x'.repeat(501)))).toEqual(['too_long']);
  });

  it('length follows R1, not the number of characters: an emoji counts by its bytes', () => {
    // 498 characters on screen, 501 by R1.
    const text = 'x'.repeat(497) + THUMB;
    expect([...text]).toHaveLength(498);
    expect(validate(input(text))).toEqual([
      { code: 'too_long', message: 'the text counts 501 by rule R1, the limit is 500' },
    ]);
    expect(validate(input('x'.repeat(496) + THUMB))).toEqual([]);
  });

  it('500 Cyrillic letters pass (a letter counts 1, whatever its bytes)', () => {
    expect(validate(input('я'.repeat(500)))).toEqual([]);
  });

  it('at most 5 links', () => {
    const links = (n: number) =>
      Array.from({ length: n }, (_, i) => `https://example.com/${i}`).join(' ');
    expect(validate(input(links(5)))).toEqual([]);
    expect(validate(input(links(6)))).toEqual([
      { code: 'too_many_links', message: 'the text holds 6 links, the limit is 5' },
    ]);
  });

  it('lists every issue at once', () => {
    const text = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`).join(' ');
    expect(codes(input(text + 'x'.repeat(500), { key: ' ' }))).toEqual([
      'empty_key',
      'too_long',
      'too_many_links',
    ]);
  });

  it('`link` is not sent to Threads, so it is neither counted nor required', () => {
    expect(validate(input('x'.repeat(500), { link: 'https://t.me/Channel1/57' }))).toEqual([]);
  });

  it('is pure: the input is not changed', () => {
    const i = Object.freeze(input('текст'));
    expect(() => validate(i)).not.toThrow();
  });
});

describe('countLinks', () => {
  it.each([
    ['no link', 'Кто пришёл на дискотеку?', 0],
    ['scheme', 'см. https://t.me/Channel1/57', 1],
    ['bare host with a path', 'см. t.me/Channel1/57', 1],
    ['www', 'www.example.com и http://example.org', 2],
    ['the same link twice counts twice', 'example.com example.com', 2],
    ['a time, a number and an abbreviation are not links', 'в 20:15, 3.14, и т.д. e.g. so', 0],
    ['an e-mail address is not a link', 'пишите на koresh@example.com', 0],
  ])('%s', (_name, text, n) => {
    expect(countLinks(text)).toBe(n);
  });
});
