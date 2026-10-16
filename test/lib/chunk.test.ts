import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { chunkText } from '../../src/lib/chunk.js';

// WP-SVC-04. Invariants checked on every result (`check`):
//  - every chunk is non-empty, trimmed and fits: measure(chunk) <= limit - reserve;
//  - the chunks are the input's own substrings, in order, and what lies between two chunks (and
//    before the first, after the last) is whitespace only;
//  - joining the chunks with a single space equals the input with whitespace runs collapsed;
//    the one exception is a hard cut inside a token longer than the limit, where the gap is
//    empty (the halves join with '') and that token itself does not fit;
//  - no chunk starts or ends inside a grapheme (surrogate pair, combining or ZWJ sequence).

const utf16 = (s: string) => s.length;
const collapse = (s: string) => s.trim().replace(/\s+/g, ' ');
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const boundaries = (s: string) =>
  new Set([...segmenter.segment(s)].map((g) => g.index).concat(s.length));

interface Opts {
  limit: number;
  reserve?: number;
  measure?: (s: string) => number;
}

/** Checks the invariants; returns the number of hard cuts. */
function check(text: string, chunks: string[], opts: Opts, strictTrim = true): number {
  const max = opts.limit - (opts.reserve ?? 0);
  const measure = opts.measure ?? utf16;
  const cuts = boundaries(text);
  let at = 0;
  let hard = 0;
  const glued: string[] = [];
  for (const [i, c] of chunks.entries()) {
    expect(c.length, `chunk ${i} empty`).toBeGreaterThan(0);
    if (strictTrim) expect(c, `chunk ${i} not trimmed`).toBe(c.trim());
    expect(measure(c), `chunk ${i} too long`).toBeLessThanOrEqual(max);
    const start = text.indexOf(c, at);
    expect(start, `chunk ${i} not found in order`).toBeGreaterThanOrEqual(at);
    const gap = text.slice(at, start);
    expect(/^\s*$/.test(gap), `non-whitespace dropped before chunk ${i}`).toBe(true);
    expect(cuts.has(start) && cuts.has(start + c.length), `chunk ${i} splits a grapheme`).toBe(
      true,
    );
    if (i > 0 && gap === '') {
      hard++;
      // The token across the boundary is longer than the limit.
      const left = /\S*$/.exec(text.slice(0, start))![0];
      const right = /^\S*/.exec(text.slice(start))![0];
      expect(measure(left + right), `soft split without whitespace at chunk ${i}`).toBeGreaterThan(
        max,
      );
      glued[glued.length - 1] += c;
    } else glued.push(c);
    at = start + c.length;
  }
  expect(/^\s*$/.test(text.slice(at)), 'non-whitespace dropped at the end').toBe(true);
  expect(collapse(glued.join(' '))).toBe(collapse(text));
  if (hard === 0) expect(collapse(chunks.join(' '))).toBe(collapse(text));
  return hard;
}

function run(text: string, opts: Opts): string[] {
  const chunks = chunkText(text, opts);
  check(text, chunks, opts);
  return chunks;
}

const words = (n: number, w = 'слово') => Array.from({ length: n }, () => w).join(' ');

describe('chunkText: basics', () => {
  test('text under the limit: one chunk, unchanged (Russian, English)', () => {
    const ru = 'Корешь проснулся.\n\nИ пошёл писать: «Всё будет хорошо!» 😀';
    expect(run(ru, { limit: 4096 })).toEqual([ru]);
    const en = 'Short text, e.g. this one. It fits!';
    expect(run(en, { limit: 500, reserve: 40 })).toEqual([en]);
  });

  test('exactly at the limit: one chunk', () => {
    const s = 'a'.repeat(30) + ' ' + 'b'.repeat(19);
    expect(run(s, { limit: 50 })).toEqual([s]);
    expect(run(s, { limit: 60, reserve: 10 })).toEqual([s]);
    expect(run(s, { limit: 49 })).toEqual(['a'.repeat(30), 'b'.repeat(19)]);
  });

  test('empty and whitespace-only text give no chunks', () => {
    expect(chunkText('', { limit: 100 })).toEqual([]);
    expect(chunkText(' \n\t\n ', { limit: 100 })).toEqual([]);
  });

  test('chunk edges are trimmed', () => {
    expect(run('  \n привет мир \n\n', { limit: 100 })).toEqual(['привет мир']);
    expect(run('\n\nаааа бббб\n\nвввв гггг\n', { limit: 10 })).toEqual(['аааа бббб', 'вввв гггг']);
  });

  test('default measure is UTF-16 length (an emoji counts 2)', () => {
    expect(run('😀😀😀😀😀', { limit: 4 })).toEqual(['😀😀', '😀😀', '😀']);
    expect(run('😀 😀 😀', { limit: 5 })).toEqual(['😀 😀', '😀']);
  });

  test('a custom measure is used (escaped length: specials count 2)', () => {
    const measure = (s: string) => s.length + (s.match(/[.!]/g)?.length ?? 0);
    const s = 'Раз. Два. Три. Четыре. Пять!';
    const out = run(s, { limit: 12, measure });
    expect(out).toEqual(['Раз. Два.', 'Три.', 'Четыре.', 'Пять!']);
  });

  test('reserve lowers the limit', () => {
    const s = words(20, 'abcd'); // 99 chars
    for (const c of run(s, { limit: 50, reserve: 20 })) expect(c.length).toBeLessThanOrEqual(30);
  });

  test('bad options: RangeError', () => {
    expect(() => chunkText('abc', { limit: 10, reserve: 10 })).toThrow(RangeError);
    expect(() => chunkText('abc', { limit: 0 })).toThrow(RangeError);
    expect(() => chunkText('abc', { limit: Number.NaN })).toThrow(RangeError);
    expect(() => chunkText('abc', { limit: 10, reserve: -1 })).toThrow(RangeError);
    // Checked before the text, also when nothing would be measured.
    expect(() => chunkText('', { limit: 5, reserve: 5 })).toThrow(RangeError);
    expect(() => chunkText('abc', { limit: 0.5, measure: () => 0 })).toThrow(RangeError);
  });

  test('a single grapheme that does not fit: RangeError', () => {
    expect(() => chunkText('👨‍👩‍👧‍👦', { limit: 5 })).toThrow(RangeError);
  });
});

describe('chunkText: split order', () => {
  test('a paragraph break wins over a later sentence end', () => {
    const p1 = 'Первый абзац. Короткий.';
    const p2 = 'Второй абзац, первая фраза. Вторая фраза длиннее, чем можно.';
    const s = `${p1}\n\n${p2}`;
    // The second sentence end of p2 does not fit, the first does; the paragraph break still wins.
    expect(run(s, { limit: p1.length + 2 + 30 })[0]).toBe(p1);
  });

  test('the last paragraph break that fits', () => {
    const s = 'Один.\n\nДва.\n\nТри три три три.';
    expect(run(s, { limit: 16 })).toEqual(['Один.\n\nДва.', 'Три три три три.']);
  });

  test('a single line break is not a paragraph break', () => {
    const s = 'Строка без точки\nдальше идёт текст. Хвост хвост хвост.';
    expect(run(s, { limit: 40 })[0]).toBe('Строка без точки\nдальше идёт текст.');
  });

  test('a paragraph break may carry spaces or CRLF', () => {
    expect(run('Раз раз\n  \nдва.\r\n\r\nТри три.', { limit: 13 })).toEqual([
      'Раз раз',
      'два.',
      'Три три.',
    ]);
  });

  test('a sentence end wins over a later space', () => {
    const s = 'Раз два три. Четыре пять шесть семь восемь девять.';
    expect(run(s, { limit: 30 })).toEqual([
      'Раз два три.',
      'Четыре пять шесть семь восемь',
      'девять.',
    ]);
  });

  test.each([
    ['.', 'Конец.'],
    ['!', 'Конец!'],
    ['?', 'Конец?'],
    ['…', 'Конец…'],
    ['?!', 'Конец?!'],
    ['!!!', 'Конец!!!'],
    ['...', 'Конец...'],
    ['.»', '«Конец.»'],
    ['!)', '(Конец!)'],
  ])('sentence end %s', (_, end) => {
    const s = `Начало ${end} Середина середина середина середина.`;
    expect(run(s, { limit: `Начало ${end} Середина`.length + 3 })[0]).toBe(`Начало ${end}`);
  });

  test('a sentence end followed by a newline', () => {
    const s = 'Начало начало.\nДальше дальше дальше дальше.';
    expect(run(s, { limit: 25 })[0]).toBe('Начало начало.');
  });

  test('whitespace when there is no sentence end', () => {
    const s = words(30);
    const out = run(s, { limit: 40 });
    expect(out.every((c) => /^(слово ?)+$/.test(c))).toBe(true);
    expect(out[0]).toBe(words(6));
  });

  test('English text', () => {
    const s =
      'The bot wakes up. It reads the feed! Does it post? Yes, at nine e.g. on Sunday… Then it sleeps.';
    const out = run(s, { limit: 40 });
    expect(out).toEqual([
      'The bot wakes up. It reads the feed!',
      'Does it post?',
      'Yes, at nine e.g. on Sunday…',
      'Then it sleeps.',
    ]);
  });
});

describe('chunkText: not a sentence end', () => {
  // `trap` would be the last sentence end that fits; the real one is earlier.
  const first = 'Раз два три.';
  test.each([
    ['decimal', 'цена 3.5 млн'],
    ['т.е.', 'то есть т.е.'],
    ['т.д.', 'и так т.д.'],
    ['т. е.', 'это т. е.'],
    ['e.g.', 'like e.g.'],
    ['i.e.', 'that is i.e.'],
    ['Mr.', 'dear Mr.'],
    ['г.', 'в 2026 г.'],
    ['гг.', 'в 2025-2026 гг.'],
    ['initials А. С.', 'поэт А. С.'],
    ['initials А.С.', 'поэт А.С.'],
    ['URL', 'см. https://example.com/a.b?x=1.'],
  ])('%s', (_, trap) => {
    const s = `${first} ${trap} Пушкин пишет длинное продолжение фразы.`;
    const out = run(s, { limit: `${first} ${trap} Пушкин`.length });
    expect(out[0]).toBe(first);
  });

  test('a decimal is never split even with no other break', () => {
    expect(run('3.5 3.25 10.75', { limit: 9 })).toEqual(['3.5 3.25', '10.75']);
  });
});

describe('chunkText: hard cut and graphemes', () => {
  const url = 'https://example.com/' + 'a1b2c3/'.repeat(83) + 'end'; // 604 chars

  test('a single 600-char URL at limit 500: hard cut, no characters lost', () => {
    expect(url.length).toBeGreaterThanOrEqual(600);
    const out = chunkText(url, { limit: 500 });
    expect(check(url, out, { limit: 500 })).toBe(1);
    expect(out.map((c) => c.length)).toEqual([500, url.length - 500]);
    expect(out.join('')).toBe(url);
  });

  test('a long URL between words: words split softly, URL hard', () => {
    const s = `Ссылка: ${url} — читайте.`;
    const out = chunkText(s, { limit: 500 });
    expect(check(s, out, { limit: 500 })).toBe(1);
    expect(out[0]).toBe('Ссылка:');
    expect(out[1]).toBe(url.slice(0, 500));
  });

  test('a hard cut never splits a surrogate pair', () => {
    const s = '😀'.repeat(10);
    const out = chunkText(s, { limit: 5 });
    check(s, out, { limit: 5 });
    expect(out).toEqual(Array.from({ length: 5 }, () => '😀😀'));
  });

  test('a hard cut never splits a combining sequence', () => {
    const i = 'й'; // й as и + combining breve
    const s = i.repeat(7);
    const out = chunkText(s, { limit: 5 });
    check(s, out, { limit: 5 });
    expect(out).toEqual([i.repeat(2), i.repeat(2), i.repeat(2), i]);
  });

  test('a hard cut never splits a ZWJ sequence or a flag', () => {
    const fam = '👨‍👩‍👧'; // 8 UTF-16 units
    const flag = '🇷🇺'; // 4
    const s = (fam + flag).repeat(4);
    const out = chunkText(s, { limit: 13 });
    check(s, out, { limit: 13 });
    expect(out).toEqual(Array.from({ length: 4 }, () => fam + flag));
  });
});

// Builds a Russian or English post of about `n` chars: paragraphs of sentences.
function post(n: number, lang: 'ru' | 'en'): string {
  const ru = [
    'Корешь сегодня проснулся раньше обычного.',
    'Цена выросла на 3.5 процента, т.е. заметно!',
    'А. С. Пушкин, впрочем, об этом не писал…',
    'Что дальше?!',
    'Смотри https://example.com/news/2026-10-11.html и думай.',
    'В 2026 г. всё будет иначе, и т.д. и т.п.',
    'Эмодзи тоже здесь 😀👨‍👩‍👧🇷🇺 и й.',
  ];
  const en = [
    'The bot wakes up early today.',
    'Prices rose 3.5 percent, i.e. a lot!',
    'Mr. Smith did not comment…',
    'What next?!',
    'See https://example.com/a.b?c=1 for details.',
    'Some e.g. examples follow.',
    'Emoji too 😀👍🏽.',
  ];
  const pool = lang === 'ru' ? ru : en;
  const paras: string[] = [];
  let len = 0;
  for (let k = 0; len < n; k++) {
    const p = Array.from({ length: 2 + (k % 5) }, (_, j) => pool[(k * 3 + j) % pool.length]).join(
      ' ',
    );
    paras.push(p);
    len += p.length + 2;
  }
  return paras.join('\n\n');
}

describe('chunkText: posts', () => {
  test('Telegram: Russian post at limit 4096, cut at paragraph ends', () => {
    const s = post(12000, 'ru');
    const out = run(s, { limit: 4096 });
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const c of out.slice(0, -1)) {
      const end = s.indexOf(c) + c.length;
      expect(s.slice(end, end + 2)).toBe('\n\n');
    }
  });

  test('Threads: English post at limit 500 with reserve 40', () => {
    const s = post(3000, 'en');
    const out = run(s, { limit: 500, reserve: 40 });
    expect(out.length).toBeGreaterThanOrEqual(7);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(460);
  });

  test('Threads: Russian post at limit 500 with reserve 40 ends chunks at sentence ends', () => {
    const s = post(3000, 'ru').replace(/\n\n/g, ' ');
    const out = run(s, { limit: 500, reserve: 40 });
    for (const c of out) expect(c).toMatch(/[.!?…]$/);
  });
});

describe('chunkText: properties', () => {
  const token = fc.oneof(
    {
      weight: 6,
      arbitrary: fc.string({
        unit: fc.constantFrom(...'абвгдеёжзийклмнопрстуфхцчшщъыьэюяabcxyzABC0123456789'),
        minLength: 1,
        maxLength: 12,
      }),
    },
    {
      weight: 2,
      arbitrary: fc.constantFrom(
        '3.5',
        'т.е.',
        'т.д.',
        'e.g.',
        'i.e.',
        'Mr.',
        'г.',
        'А.',
        'С.',
        'https://example.com/a.b?c=1',
        '«цитата»',
        '(скобки)',
      ),
    },
    { weight: 2, arbitrary: fc.constantFrom('😀', '👨‍👩‍👧', '🇷🇺', 'й', 'é', '👍🏽') },
    {
      weight: 1,
      arbitrary: fc.string({
        unit: fc.constantFrom('x', 'я', '😀', '/'),
        minLength: 40,
        maxLength: 700,
      }),
    },
  );
  const punct = fc.constantFrom('', '', '', '.', '!', '?', '…', '?!', '!!!', ',', ':', '.»');
  const sep = fc.constantFrom(' ', ' ', ' ', ' ', '  ', '\n', '\n\n', '\n \n', '\t');
  const text = fc
    .array(fc.tuple(token, punct, sep), { maxLength: 400 })
    .map((parts) => parts.map(([t, p, s]) => t + p + s).join(''));

  test('random text, limit in [50, 5000]: chunks fit and rejoin to the input', () => {
    fc.assert(
      fc.property(
        text,
        fc.integer({ min: 50, max: 5000 }),
        fc.integer({ min: 0, max: 40 }),
        (s, limit, reserve) => {
          const opts = { limit, reserve };
          check(s, chunkText(s, opts), opts);
        },
      ),
      { numRuns: 300 },
    );
  }, 60_000);

  test('any unicode text, limit in [50, 5000]: chunks fit, in order, graphemes whole', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 3000 }),
        fc.integer({ min: 50, max: 5000 }),
        (s, limit) => {
          check(s, chunkText(s, { limit }), { limit }, false);
        },
      ),
      { numRuns: 300 },
    );
  }, 60_000);
});
