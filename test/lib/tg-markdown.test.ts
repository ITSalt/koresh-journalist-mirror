import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { escapeMdV2, md } from '../../src/lib/tg-markdown.js';

// WP-SVC-03. The escape set is spelled out here independently of the module, from
// https://core.telegram.org/bots/api#markdownv2-style, so dropping one character from the
// module's set fails the `test.each` row of that character.
const SPECIALS = [
  '_',
  '*',
  '[',
  ']',
  '(',
  ')',
  '~',
  '`',
  '>',
  '#',
  '+',
  '-',
  '=',
  '|',
  '{',
  '}',
  '.',
  '!',
  '\\',
] as const;
const SPECIAL_SET = new Set<string>(SPECIALS);

/** Removes the escapes: every `\x` becomes `x`. */
const unescape = (s: string) => s.replace(/\\(.)/gsu, '$1');

/**
 * Problems of an escaped plain-text run (no entities): a `\` must escape a special character and
 * every special character must be escaped.
 */
function plainProblems(s: string): string[] {
  const bad: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') {
      if (!SPECIAL_SET.has(s[i + 1] ?? '')) bad.push(`stray \\ at ${i}`);
      i++;
    } else if (SPECIAL_SET.has(c)) bad.push(`unescaped ${c} at ${i}`);
  }
  return bad;
}

const RU =
  'Корешь сказал: «Это (не) шутка»! Цена — 3.5 млн, т.е. 1+1=2? #тег {x} [y] ~z~ `код` |a| _b_ *c* > d';

describe('escapeMdV2', () => {
  test.each(SPECIALS)('escapes %s alone', (c) => {
    expect(escapeMdV2(c)).toBe(`\\${c}`);
  });

  test.each(SPECIALS)('escapes %s inside Russian text', (c) => {
    expect(escapeMdV2(`Привет${c}мир`)).toBe(`Привет\\${c}мир`);
  });

  test('a Russian post: every special escaped, nothing else touched', () => {
    const out = escapeMdV2(RU);
    expect(plainProblems(out)).toEqual([]);
    expect(unescape(out)).toBe(RU);
    expect(out).toBe(
      'Корешь сказал: «Это \\(не\\) шутка»\\! Цена — 3\\.5 млн, т\\.е\\. 1\\+1\\=2? \\#тег \\{x\\} \\[y\\] \\~z\\~ \\`код\\` \\|a\\| \\_b\\_ \\*c\\* \\> d',
    );
  });

  test('a backslash is escaped once, before the character it precedes', () => {
    expect(escapeMdV2('a\\.b')).toBe('a\\\\\\.b');
    expect(escapeMdV2('\\\\')).toBe('\\\\\\\\');
  });

  test('characters outside the set are untouched (letters, digits, ?, quotes, newlines)', () => {
    const s = 'abc АБВ 123 ?,:;\'"«»—…@$%^&/ \n\t';
    expect(escapeMdV2(s)).toBe(s);
  });

  test('emoji, surrogate pairs, ZWJ sequences and combining marks are untouched', () => {
    const s = '😀 👨‍👩‍👧 🇷🇺 й 𝔘 ❤️';
    expect(escapeMdV2(s)).toBe(s);
    expect(escapeMdV2('😀.👍')).toBe('😀\\.👍');
  });

  test('empty string', () => {
    expect(escapeMdV2('')).toBe('');
  });

  test('property: removing the escapes gives the input back', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => unescape(escapeMdV2(s)) === s),
      { numRuns: 2000 },
    );
  }, 60_000);

  test('property: output is valid plain MarkdownV2 (no stray \\, no unescaped special)', () => {
    const special = fc.constantFrom(...SPECIALS);
    const any = fc.oneof(fc.string({ unit: 'binary' }), fc.string({ unit: special }));
    fc.assert(
      fc.property(any, (s) => plainProblems(escapeMdV2(s)).length === 0),
      { numRuns: 2000 },
    );
  }, 60_000);
});

describe('md helpers', () => {
  test('bold, italic, underline, spoiler wrap the escaped text', () => {
    expect(md.bold('Корешь.')).toBe('*Корешь\\.*');
    expect(md.italic('a_b')).toBe('_a\\_b_');
    expect(md.underline('x*y')).toBe('__x\\*y__');
    expect(md.spoiler('конец!')).toBe('||конец\\!||');
  });

  test('nested: bold of text full of specials escapes the inside, the markers stay bare', () => {
    const out = md.bold('*жирно* и _курсив_ (1.0)');
    expect(out).toBe('*\\*жирно\\* и \\_курсив\\_ \\(1\\.0\\)*');
    expect(out.startsWith('*') && out.endsWith('*')).toBe(true);
    expect(plainProblems(out.slice(1, -1))).toEqual([]);
  });

  test('helpers of an empty string give an empty string (no empty entity)', () => {
    expect(md.bold('')).toBe('');
    expect(md.italic('')).toBe('');
    expect(md.underline('')).toBe('');
    expect(md.spoiler('')).toBe('');
  });

  test('helpers keep emoji and surrogate pairs', () => {
    expect(md.bold('🔥 огонь 🇷🇺')).toBe('*🔥 огонь 🇷🇺*');
  });

  test('link: text escaped fully, URL escapes only ) and \\', () => {
    expect(md.link('Сайт (тут).', 'https://example.com/a_(b)?q=1.2&x=\\')).toBe(
      '[Сайт \\(тут\\)\\.](https://example.com/a_(b\\)?q=1.2&x=\\\\)',
    );
  });

  test('link: a URL without ) or \\ is passed through', () => {
    const url = 'https://t.me/s/channel-name_1?a=b#c';
    expect(md.link('x', url)).toBe(`[x](${url})`);
  });

  test('quote: every line starts with > and is escaped', () => {
    expect(md.quote(['> уже цитата', 'вторая строка.', ''])).toBe(
      '>\\> уже цитата\n>вторая строка\\.\n>',
    );
  });

  test('quote: one line, and no lines', () => {
    expect(md.quote(['раз'])).toBe('>раз');
    expect(md.quote([])).toBe('');
  });

  test('expandableQuote: starts with **>, every line starts with >, ends with ||', () => {
    const out = md.expandableQuote(['первая', 'вторая|', 'третья!']);
    expect(out).toBe('**>первая\n>вторая\\|\n>третья\\!||');
    expect(out.endsWith('||')).toBe(true);
    for (const line of out.slice(2).split('\n')) expect(line.startsWith('>')).toBe(true);
  });

  test('expandableQuote: one line, and no lines', () => {
    expect(md.expandableQuote(['a.b'])).toBe('**>a\\.b||');
    expect(md.expandableQuote([])).toBe('');
  });

  test('property: helper output minus its markers is a valid escaped run of the input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', minLength: 1 }), (s) => {
        const inner = [
          md.bold(s).slice(1, -1),
          md.italic(s).slice(1, -1),
          md.underline(s).slice(2, -2),
          md.spoiler(s).slice(2, -2),
        ];
        return inner.every((x) => unescape(x) === s && plainProblems(x).length === 0);
      }),
      { numRuns: 500 },
    );
  }, 60_000);
});
