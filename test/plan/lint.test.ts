import { describe, expect, it } from 'vitest';
import { STOP_PHRASES, lintText, parseStopPhrases } from '../../src/plan/lint.js';

const codes = (t: string, phrases?: string[]) => lintText(t, phrases).map((i) => i.code);

describe('lintText (D-26)', () => {
  it.each([
    ['em_dash', 'Тишина — это страшно'],
    ['en_dash', 'С 09:00–10:00'],
    ['guillemets', 'Слово «тишина» вернулось'],
    ['guillemets', 'Слово тишина»'],
    ['list_line', '- пункт'],
    ['list_line', 'Раз.\n  - пункт'],
    ['list_line', '• пункт'],
    ['list_line', '* пункт'],
    ['list_line', '1. пункт'],
    ['list_line', '2) пункт'],
    ['stop_phrase', 'Важно отметить, что тихо'],
    ['stop_phrase', 'СТОИТ ОТМЕТИТЬ тишину'],
    ['stop_phrase', 'Да, в современном мире так'],
  ])('%s fires on %j', (code, text) => {
    expect(codes(text)).toContain(code);
  });

  it('em dash as a line start fires both em_dash and list_line', () => {
    expect(codes('— пункт').sort()).toEqual(['em_dash', 'list_line']);
  });

  it.each([
    ['hyphen: ИИ-журналист и кто-то'],
    ['spaced hyphen: тихо - очень тихо'],
    ['plain "quote" здесь'],
    ['Слово в начале строки\nи ещё одна'],
    ['**Дело №1. Тишина.** жирный'],
    ['Дата 12.10 в 09:00, год 2026. И всё'],
    ['Что дальше?'],
  ])('clean text passes: %s', (t) => {
    expect(codes(t)).toEqual([]);
  });

  it('reports the offending excerpt', () => {
    const [i] = lintText('Начало текста. Тишина — это страшно. Конец текста.');
    expect(i).toMatchObject({ code: 'em_dash' });
    expect(i!.excerpt).toContain('Тишина — это');
  });

  it('the stop list loaded at boot has the starting phrases', () => {
    expect(STOP_PHRASES).toEqual(['важно отметить', 'стоит отметить', 'в современном мире']);
  });

  it('parses a stop list: comments, blanks, case-insensitive', () => {
    const phrases = parseStopPhrases('# c\n\nТест Фраза\r\n  # x\nдругая\n');
    expect(phrases).toEqual(['тест фраза', 'другая']);
    expect(codes('Тут ТЕСТ фраза.', phrases)).toEqual(['stop_phrase']);
    expect(codes('Важно отметить', phrases)).toEqual([]);
  });
});
