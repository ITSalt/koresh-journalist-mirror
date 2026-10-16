import { describe, expect, it } from 'vitest';
import { composeTelegram, TG_TEXT_LIMIT } from '../../src/publish/compose.js';
import { mdv2Problems } from '../../src/publish/mdv2-check.js';
import { renderPlanText } from '../../src/publish/render.js';
import { SIGNATURE_LINE, signText } from '../../src/plan/pipeline.js';
import { blocks } from '../support/blocks.js';
import { PLAN_2026_10_11 } from './fixtures/plan-2026-10-11.js';

const r = (t: string) => renderPlanText(t, blocks);
const e = (t: string) => blocks.escapeMdV2(t);

const unescaped = mdv2Problems;

describe('renderPlanText (D-21)', () => {
  it('**text** becomes bold', () => {
    expect(r('До **Дело №1.** после.')).toBe(
      `${e('До ')}${blocks.md.bold('Дело №1.')}${e(' после.')}`,
    );
    expect(r('**a** и **b**')).toBe(`${blocks.md.bold('a')}${e(' и ')}${blocks.md.bold('b')}`);
  });

  it('a "> " line becomes a quote; consecutive lines form one quote', () => {
    expect(r('Текст:\n> «Раз.»\nдальше')).toBe(
      `${e('Текст:')}\n${blocks.md.quote(['«Раз.»'])}\n${e('дальше')}`,
    );
    expect(r('> один\n> два\n> три')).toBe(blocks.md.quote(['один', 'два', 'три']));
    expect(r('> один\nне цитата\n> два')).toBe(
      `${blocks.md.quote(['один'])}\n${e('не цитата')}\n${blocks.md.quote(['два'])}`,
    );
    // only "> " opens a quote; ">" without a space is text
    expect(r('>нет')).toBe(e('>нет'));
  });

  it('an unclosed ** is escaped literally', () => {
    expect(r('**не закрыто')).toBe(e('**не закрыто'));
    expect(r('**да** и **нет')).toBe(`${blocks.md.bold('да')}${e(' и **нет')}`);
  });

  it('a single * between digits or inside a word stays literal', () => {
    expect(r('2*3*4')).toBe(e('2*3*4'));
    expect(r('a*b и сло*во')).toBe(e('a*b и сло*во'));
  });

  it('consecutive quote lines are one md.quote call', () => {
    const calls: string[][] = [];
    const spy = {
      ...blocks,
      md: { ...blocks.md, quote: (l: string[]) => (calls.push(l), blocks.md.quote(l)) },
    };
    renderPlanText('> один\n> два\n> три\nтекст\n> четыре', spy);
    expect(calls).toEqual([['один', 'два', 'три'], ['четыре']]);
  });

  it('** inside a quote line is escaped (md.quote takes raw lines)', () => {
    expect(r('> **жирно** в цитате')).toBe(blocks.md.quote(['**жирно** в цитате']));
  });

  it('nested or other markup is not interpreted', () => {
    expect(r('**a **b** c**')).toBe(e('**a **b** c**'));
    expect(r('***x***')).toBe(e('***x***'));
    expect(r('** a**')).toBe(e('** a**'));
    expect(r('**a ** b')).toBe(e('**a ** b'));
    expect(r('_курсив_ __подч__ ~зач~ ||спойлер|| `код` [ссылка](http://x.y)')).toBe(
      e('_курсив_ __подч__ ~зач~ ||спойлер|| `код` [ссылка](http://x.y)'),
    );
  });

  it('a plain URL stays text (escaped)', () => {
    expect(r('см. https://t.me/Channel1/1?x=1')).toBe(e('см. https://t.me/Channel1/1?x=1'));
  });

  it('the 2026-10-11 plan texts render with no unescaped forbidden character', () => {
    for (const [id, text] of Object.entries(PLAN_2026_10_11)) {
      const md = r(text);
      expect(unescaped(md), id).toEqual([]);
      expect(md.length, id).toBeLessThanOrEqual(TG_TEXT_LIMIT);
    }
    // the fixture really exercises the subset
    expect(r(PLAN_2026_10_11.s1!)).toContain(blocks.md.bold('Дело №1. Тишина. Хроника от 07.10'));
    expect(r(PLAN_2026_10_11.s2!)).toContain(
      blocks.md.quote(['«Восстанови историю проекта… возьми на себя роль этого агента».']),
    );
  });
});

describe('the 4096 limit is measured after rendering', () => {
  it('splits by rendered length, not raw length', () => {
    // Raw under 4096, rendered well over it: many special characters per phrase.
    const body = Array.from({ length: 140 }, (_, i) => `**Ф${i}** (a-b)+(c-d)=e!.`).join(' ');
    const text = signText(`${body} Итог?`);
    expect(text.length).toBeLessThan(TG_TEXT_LIMIT);
    expect(r(text).length).toBeGreaterThan(TG_TEXT_LIMIT);
    const parts = composeTelegram(text, { blocks });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.escaped).toBe(r(p.raw));
      expect(p.escaped.length).toBeLessThanOrEqual(TG_TEXT_LIMIT);
      expect(unescaped(p.escaped)).toEqual([]);
    }
    expect(parts[parts.length - 1]!.raw).toContain(SIGNATURE_LINE);
  });

  it('a post that fits once rendered stays one part even if its plain escape would not', () => {
    const body = Array.from({ length: 300 }, (_, i) => `**слово${i}**`).join(' ');
    const text = signText(`${body} Итог?`);
    expect(r(text).length).toBeLessThanOrEqual(TG_TEXT_LIMIT);
    expect(e(text).length).toBeGreaterThan(TG_TEXT_LIMIT);
    expect(composeTelegram(text, { blocks })).toHaveLength(1);
  });

  it('a composed post is sent rendered: bold and quote reach Telegram', () => {
    const [p] = composeTelegram(signText('**Жирно.**\n> цитата\nВопрос?'), { blocks });
    expect(p!.escaped.startsWith(blocks.md.bold('Жирно.'))).toBe(true);
    expect(p!.escaped).toContain(blocks.md.quote(['цитата']));
  });
});
