import { describe, expect, it } from 'vitest';
import {
  composeTelegram,
  composeText,
  hasSignatureLine,
  messageParams,
  pollParams,
  splitPlanText,
  TG_TEXT_LIMIT,
} from '../../src/publish/compose.js';
import { mdv2Problems } from '../../src/publish/mdv2-check.js';
import { renderPlanText } from '../../src/publish/render.js';
import { SIGNATURE_LINE, signText } from '../../src/plan/pipeline.js';
import { blocks } from '../support/blocks.js';

const signed = (t: string) => signText(t);

describe('composeText', () => {
  it('appends the trailer after the signature, never when empty', () => {
    const t = signed('Текст. Что думаете?');
    expect(composeText(t, '')).toBe(t);
    expect(composeText(t, '   ')).toBe(t);
    expect(composeText(t, '#тег')).toBe(`${t}\n\n#тег`);
  });
});

describe('composeTelegram (guard D-9, 4096 escaped limit)', () => {
  it('one part for a short signed post, escaped for MarkdownV2', () => {
    const parts = composeTelegram(signed('Привет. Как дела?'), { blocks });
    expect(parts).toHaveLength(1);
    expect(parts[0]!.raw).toContain(SIGNATURE_LINE);
    expect(parts[0]!.escaped).toContain('Привет\\.');
  });

  it('refuses a post without the signature line', () => {
    expect(() => composeTelegram('Без подписи. Ну?', { blocks })).toThrow(/signature/);
  });

  it('D-26: refuses the old dashed signature form (an un-replaced old draft)', () => {
    const old = 'Текст. Ну?\n\n— ИИ-журналист-правдорубец Кореш Шпандент';
    expect(() => composeTelegram(old, { blocks })).toThrow(/signature/);
    expect(() => composeTelegram(old, { blocks })).toThrowError(
      expect.objectContaining({ code: 'unsigned' }),
    );
  });

  it('refuses a signature that is only mentioned inside a line', () => {
    expect(() => composeTelegram(`Текст ${SIGNATURE_LINE} в строке. Ну?`, { blocks })).toThrowError(
      expect.objectContaining({ code: 'unsigned' }),
    );
  });

  it('refuses a multi-part post whose last part has no signature', () => {
    // The signature sits early, the long tail follows it: the last part lacks it.
    const tail = Array.from({ length: 400 }, (_, i) => `Фраза номер ${i}.`).join(' ');
    const text = `${SIGNATURE_LINE}\n\n${tail}`;
    expect(() => composeTelegram(text, { blocks })).toThrowError(
      expect.objectContaining({ code: 'unsigned' }),
    );
  });

  it('splits a long post so every escaped part fits and the last is signed', () => {
    // Many special characters: the escaped length is about double the raw length.
    const body = Array.from({ length: 300 }, (_, i) => `Пункт ${i}: (a-b) = c!`).join(' ');
    const parts = composeTelegram(signed(`${body} Что скажете?`), { blocks });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.escaped.length).toBeLessThanOrEqual(TG_TEXT_LIMIT);
    expect(hasSignatureLine(parts[parts.length - 1]!.raw)).toBe(true);
  });

  it('refuses a part over 4096 escaped chars even if the chunker returned it', () => {
    const big = `${'x.'.repeat(2100)}\n\n${SIGNATURE_LINE}`;
    const oneChunk = { ...blocks, chunkText: (t: string) => [t] };
    expect(() => composeTelegram(big, { blocks: oneChunk })).toThrowError(
      expect.objectContaining({ code: 'too_long' }),
    );
  });

  it('applies the guard and the limit to the composed text with the trailer', () => {
    const parts = composeTelegram(signed('Коротко. Да?'), { blocks, trailer: 'хвост' });
    expect(parts).toHaveLength(1);
    expect(parts[0]!.raw.endsWith(`${SIGNATURE_LINE}\n\nхвост`)).toBe(true);
  });
});

describe('Bot API parameters', () => {
  it('sendMessage: MarkdownV2 and link previews off', () => {
    expect(messageParams('@c', { raw: 'a.', escaped: 'a\\.' })).toEqual({
      chat_id: '@c',
      text: 'a\\.',
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
    });
  });

  it('sendPoll: regular, anonymous, options as InputPollOption', () => {
    expect(
      pollParams('@c', { question: 'Q?', options: ['a', 'b'], allowsMultiple: false }),
    ).toEqual({
      chat_id: '@c',
      question: 'Q?',
      options: [{ text: 'a' }, { text: 'b' }],
      is_anonymous: true,
      type: 'regular',
      allows_multiple_answers: false,
    });
  });
});

describe('chunk boundaries and markup (scope item 12)', () => {
  const SPAN = '**Начало жирного. Середина жирного. Конец жирного.**';
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `Фраза ${i} тут.`).join(' ');
  const collapse = (t: string) => t.replace(/\s+/g, ' ').trim();

  /** A text where the chunker's natural boundary falls inside SPAN. */
  function acrossBoundary(after = 40): string {
    for (let n = 200; n < 400; n++) {
      const text = signText(`${filler(n)} ${SPAN} ${filler(after)} Итог?`);
      const natural = blocks.chunkText(text, {
        limit: TG_TEXT_LIMIT,
        measure: (s) => renderPlanText(s, blocks).length,
      });
      const first = natural[0]!;
      if (first.includes('**Начало') && !first.includes('жирного.**')) return text;
    }
    throw new Error('no text found with the boundary inside the bold span');
  }

  it('moves a boundary inside **…** before the opening **; every part renders and passes the check', () => {
    const text = acrossBoundary();
    const parts = composeTelegram(text, { blocks });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(mdv2Problems(p.escaped)).toEqual([]);
      expect(p.escaped.length).toBeLessThanOrEqual(TG_TEXT_LIMIT);
    }
    expect(parts[0]!.raw).not.toContain('**');
    expect(parts[1]!.raw.startsWith(SPAN)).toBe(true);
    expect(parts[1]!.escaped).toContain(blocks.md.bold(SPAN.slice(2, -2)));
    expect(collapse(parts.map((p) => p.raw).join(' '))).toBe(collapse(text));
  });

  it('re-chunks when the moved span no longer fits with the next part', () => {
    const text = acrossBoundary(600);
    const parts = composeTelegram(text, { blocks });
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(p.escaped.length).toBeLessThanOrEqual(TG_TEXT_LIMIT);
      expect(mdv2Problems(p.escaped)).toEqual([]);
    }
    expect(parts.some((p) => p.escaped.includes(blocks.md.bold(SPAN.slice(2, -2))))).toBe(true);
    expect(collapse(parts.map((p) => p.raw).join(' '))).toBe(collapse(text));
  });

  it('a bold span that starts a part and cannot fit stays literal and valid', () => {
    const big = `**${filler(500)}**`;
    const text = signText(`${big}\n\nИтог?`);
    const parts = splitPlanText(text, { blocks });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(mdv2Problems(renderPlanText(p, blocks))).toEqual([]);
    expect(collapse(parts.join(' '))).toBe(collapse(text));
  });

  it('refuses a part whose rendering is not valid MarkdownV2 (would be a 400)', () => {
    const broken = { ...blocks, md: { ...blocks.md, bold: (s: string) => `*${s}` } };
    expect(() => composeTelegram(signText('**x** ок?'), { blocks: broken })).toThrowError(
      expect.objectContaining({ code: 'bad_markup' }),
    );
  });
});
