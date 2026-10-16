import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { THREADS_LIMIT, threadsLength } from '../../src/lib/threads-length.js';
import { finalizePlan, SIGNATURE_LINE, type PlanBase } from '../../src/plan/pipeline.js';
import type { PlanV2 } from '../../src/plan/schema.js';
import {
  configureVariantFrame,
  LINKEDIN_FRAME_RESERVE,
  LINKEDIN_TEXT_LIMIT,
  VARIANT_LIMITS,
  variantLength,
} from '../../src/plan/variants.js';
import {
  composeVariantText,
  frameCarriesLink,
  FRAME_TEXTS,
  THREADS_DISCLAIMER_RESERVE,
  type FrameLines,
} from '../../src/platforms/frame.js';
import { escapeLittleText } from '../../src/platforms/linkedin/escape.js';
import { createPlatforms } from '../../src/platforms/registry.js';
import { openStore } from '../../src/store/index.js';
import { DATE, validPlan } from '../plan/fixtures.js';
import {
  LINKEDIN_EN,
  LINKEDIN_RU,
  THREADS_RU,
  v2Input,
  variant,
} from '../plan/variant-fixtures.js';
import { blocks } from '../support/blocks.js';

// WP-PLAT-02 scope items 3, 8 and 10: the profile frame the core composes at publish time, and
// the promise of the plan intake that a variant accepted in the evening still fits its platform
// with that frame in the morning. `validate` is the merged adapters' own (pure, no network).

const SIGN = `\n\n${SIGNATURE_LINE}`;
const LINK = 'https://t.me/Channel1/57';
const base: PlanBase = { version: 1, date: DATE, sourceWindow: validPlan().sourceWindow };
const finalize = (input: ReturnType<typeof v2Input>) =>
  finalizePlan(input, base, { variants: true });
const stored = (v: unknown) => (finalize(v2Input([v])).plan as PlanV2).slots[0]!.variants![0]!.text;
const codes = (v: unknown) => (finalize(v2Input([v])).errors ?? []).map((e) => e.code);

afterEach(() => configureVariantFrame({ threadsDisclaimer: false }));

/** The platforms as the service builds them (no account: `validate` works without a token). */
function runtimes(env: Record<string, string> = {}) {
  const store = openStore(':memory:');
  const p = createPlatforms({ config: loadConfig(env), store, blocks });
  store.close();
  return Object.fromEntries(p.list.map((r) => [r.platform, r]));
}

describe('composeVariantText', () => {
  it('LinkedIn: header, body with signature, disclaimer, one empty line between them', () => {
    const f = FRAME_TEXTS.ru;
    expect(composeVariantText('linkedin', 'ru', `Текст. Кто?${SIGN}\n`)).toBe(
      `${f.header}\n\nТекст. Кто?${SIGN}\n\n${f.disclaimer.comment}`,
    );
    // D-1: the disclaimer of the owner's decision, word for word.
    expect(f.disclaimer.comment).toBe(
      'пост в рамках исследовательского проекта ИИ-middle-manager, детали: в первом комментарии',
    );
    expect(f.header).toBe('Новости от Корпорации всевластия');
  });

  // Resubmission 1, item 6: every fixed line in one table, per language and per link mode.
  describe('the table of frame texts', () => {
    /** A table whose every cell is different, to see which one is used. */
    const table: Record<'ru' | 'en', FrameLines> = {
      ru: { header: 'H-ru', disclaimer: { comment: 'D-ru-comment', inline: 'D-ru-inline' } },
      en: { header: 'H-en', disclaimer: { comment: 'D-en-comment', inline: 'D-en-inline' } },
    };
    const compose = (
      platform: 'threads' | 'linkedin',
      lang: 'ru' | 'en',
      o: Parameters<typeof composeVariantText>[3],
    ) => composeVariantText(platform, lang, 'B', o, table);

    it('LinkedIn takes the header of the language and the disclaimer of the link mode', () => {
      expect(compose('linkedin', 'ru', { linkInline: true })).toBe('H-ru\n\nB\n\nD-ru-inline');
      expect(compose('linkedin', 'ru', { linkInline: false })).toBe('H-ru\n\nB\n\nD-ru-comment');
      expect(compose('linkedin', 'ru', {})).toBe('H-ru\n\nB\n\nD-ru-comment');
      expect(compose('linkedin', 'en', { linkInline: true })).toBe('H-en\n\nB\n\nD-en-inline');
      expect(compose('linkedin', 'en', { linkInline: false })).toBe('H-en\n\nB\n\nD-en-comment');
    });

    it('Threads has no link: its disclaimer, when on, is the one of its language for no inline link', () => {
      expect(compose('threads', 'ru', { threadsDisclaimer: true, linkInline: true })).toBe(
        'B\n\nD-ru-comment',
      );
      expect(compose('threads', 'en', { threadsDisclaimer: true })).toBe('B\n\nD-en-comment');
      expect(compose('threads', 'en', { linkInline: true })).toBe('B');
    });

    it('has both languages, and both link modes for each', () => {
      expect(Object.keys(FRAME_TEXTS).sort()).toEqual(['en', 'ru']);
      for (const f of Object.values(FRAME_TEXTS)) {
        expect(Object.keys(f).sort()).toEqual(['disclaimer', 'header']);
        expect(Object.keys(f.disclaimer).sort()).toEqual(['comment', 'inline']);
      }
    });

    it("holds the director's texts of 14.10 byte for byte; the Russian ones of D-38 unchanged", () => {
      expect(FRAME_TEXTS).toEqual({
        ru: {
          header: 'Новости от Корпорации всевластия',
          disclaimer: {
            comment:
              'пост в рамках исследовательского проекта ИИ-middle-manager, детали: в первом комментарии',
            inline:
              'пост в рамках исследовательского проекта ИИ-middle-manager, с чего всё началось: {link}',
          },
        },
        en: {
          header: 'News from Omnipotence Corp.',
          disclaimer: {
            comment:
              "This post is part of a research project: can an AI agent do a middle manager's job? Details in the first comment.",
            inline:
              "This post is part of a research project: can an AI agent do a middle manager's job? How it started: {link}",
          },
        },
      });
      // The apostrophe is the plain one, as in the file.
      expect(FRAME_TEXTS.en.disclaimer.comment).toContain("manager's");
    });

    it('{link} is filled with the link; the frame then carries it, and nothing else does', () => {
      const o = { linkInline: true, link: LINK };
      expect(composeVariantText('linkedin', 'ru', 'B', o)).toBe(
        `Новости от Корпорации всевластия\n\nB\n\nпост в рамках исследовательского проекта ИИ-middle-manager, с чего всё началось: ${LINK}`,
      );
      expect(composeVariantText('linkedin', 'en', 'B', o)).toBe(
        `News from Omnipotence Corp.\n\nB\n\nThis post is part of a research project: can an AI agent do a middle manager's job? How it started: ${LINK}`,
      );
      expect(frameCarriesLink('linkedin', 'ru', o)).toBe(true);
      // The first comment carries it: the comment wording, no link in the text.
      const comment = composeVariantText('linkedin', 'en', 'B', { linkInline: false, link: LINK });
      expect(comment).not.toContain(LINK);
      expect(comment.endsWith('Details in the first comment.')).toBe(true);
      expect(frameCarriesLink('linkedin', 'en', { linkInline: false, link: LINK })).toBe(false);
      expect(frameCarriesLink('threads', 'en', o)).toBe(false);
    });

    it('no placeholder ever goes out: without a link the wording for a link elsewhere is used', () => {
      for (const lang of ['ru', 'en'] as const) {
        for (const link of [undefined, '', '  ']) {
          const text = composeVariantText('linkedin', lang, 'B', { linkInline: true, link });
          expect(text).not.toContain('{link}');
          expect(text.endsWith(FRAME_TEXTS[lang].disclaimer.comment)).toBe(true);
          expect(frameCarriesLink('linkedin', lang, { linkInline: true, link })).toBe(false);
        }
      }
    });
  });

  it('Threads: body and signature only; the disclaimer line only when switched on', () => {
    expect(composeVariantText('threads', 'ru', `Текст. Кто?${SIGN}`)).toBe(`Текст. Кто?${SIGN}`);
    expect(composeVariantText('threads', 'ru', `Текст. Кто?${SIGN}`, {})).toBe(
      `Текст. Кто?${SIGN}`,
    );
    expect(
      composeVariantText('threads', 'ru', `Текст. Кто?${SIGN}`, { threadsDisclaimer: true }),
    ).toBe(`Текст. Кто?${SIGN}\n\n${FRAME_TEXTS.ru.disclaimer.comment}`);
    // The switch is about Threads: LinkedIn always has its frame.
    expect(composeVariantText('linkedin', 'en', 'Text?', { threadsDisclaimer: false })).toContain(
      FRAME_TEXTS.en.disclaimer.comment,
    );
  });

  it('the frame holds no character LinkedIn reserves and no long dash', () => {
    for (const f of Object.values(FRAME_TEXTS)) {
      for (const line of [f.header, f.disclaimer.comment, f.disclaimer.inline]) {
        // LinkedIn would show the backslash of an escaped character: the lines need none.
        expect(escapeLittleText(line.split('{link}').join(LINK))).toBe(
          line.split('{link}').join(LINK),
        );
        expect(line).not.toMatch(/[—–]/);
      }
    }
  });
});

describe('LinkedIn: the longest allowed variant fits with the frame and the link (items 8, 10)', () => {
  const MAX = LINKEDIN_TEXT_LIMIT - LINKEDIN_FRAME_RESERVE;
  /** A body full of reserved characters whose stored text counts exactly `units` at intake. */
  const body = (units: number) => {
    const unit = 'Скобки (раз) и #два_три *четыре*. ';
    const one = escapeLittleText(unit).length;
    const room = units - SIGN.length - 1; // the closing question mark
    const head = unit.repeat(Math.floor(room / one));
    return `${head}${'я'.repeat(room - escapeLittleText(head).length)}?`;
  };

  it('the frame with the inline link stays inside the reserve the intake keeps', () => {
    for (const lang of ['ru', 'en'] as const) {
      for (const linkInline of [true, false]) {
        // With the link at the end of the disclaimer (inline), and without it (the first comment
        // has it).
        const framed = composeVariantText('linkedin', lang, 'X', { linkInline, link: LINK });
        expect(framed.includes(LINK)).toBe(linkInline);
        const added = escapeLittleText(framed).length - 1;
        expect(added, `${lang} ${linkInline}`).toBeLessThanOrEqual(LINKEDIN_FRAME_RESERVE);
        expect(added).toBeGreaterThan(100); // header and disclaimer are really in it
      }
    }
  });

  it.each([
    ['ru', LINKEDIN_RU],
    ['en', LINKEDIN_EN],
  ] as const)('%s: a variant of exactly the intake maximum passes the adapter', (lang, fixture) => {
    const text = stored(variant(fixture, { text: body(MAX) }));
    // The intake counted what the adapter counts: the escaped text, at the maximum.
    expect(variantLength('linkedin', text)).toEqual({ used: MAX, max: MAX });
    expect(text.length).toBeLessThan(MAX - 300); // far fewer raw characters than counted
    for (const mode of ['inline', 'comment']) {
      const { linkedin } = runtimes({ LINKEDIN_LINK_MODE: mode });
      // Composed as the loop composes it: the frame options of the platform and the link, which
      // goes to the adapter only when the frame does not carry it.
      const frame = { ...linkedin!.frame, link: LINK };
      const input = {
        key: `linkedin:${DATE}:s1-${lang}:0`,
        text: composeVariantText('linkedin', lang, text, frame),
        lang,
        ...(frameCarriesLink('linkedin', lang, frame) ? {} : { link: LINK }),
      };
      expect(linkedin!.frame).toEqual({ linkInline: mode === 'inline' });
      expect(linkedin!.validate(input), mode).toEqual([]);
    }
  });

  it('one unit more is refused at intake, in the evening', () => {
    expect(codes(variant(LINKEDIN_RU, { text: body(MAX + 1) }))).toEqual(['too_long']);
    const f = finalize(v2Input([variant(LINKEDIN_RU, { text: body(MAX + 1) })]));
    expect(f.errors![0]!.message).toContain(`${MAX + 1} chars as LinkedIn counts`);
  });

  it('counting raw characters would have let through a text the adapter refuses', () => {
    // The pre-review finding: 2700 raw characters of brackets are 5400 for LinkedIn.
    const raw = `${'('.repeat(MAX - SIGN.length - 1)}?${SIGN}`;
    expect(raw).toHaveLength(MAX);
    const { linkedin } = runtimes();
    const input = {
      key: 'k',
      text: composeVariantText('linkedin', 'ru', raw),
      lang: 'ru' as const,
      link: LINK,
    };
    expect(linkedin!.validate(input).map((i) => i.code)).toEqual(['too_long']);
    expect(variantLength('linkedin', raw).used).toBeGreaterThan(MAX);
  });
});

describe('Threads: the frame reserve follows the disclaimer switch (item 10)', () => {
  const room = (reserve: number) => THREADS_LIMIT - reserve - threadsLength(SIGN) - 1;
  const text = (reserve: number, extra = 0) => `${'я'.repeat(room(reserve) + extra)}?`;

  it('off (the default): no reserve, a 500-unit variant is accepted and sent as it is', () => {
    expect(VARIANT_LIMITS.threads.frameReserve).toBe(0);
    const full = stored(variant(THREADS_RU, { text: text(0) }));
    expect(threadsLength(full)).toBe(THREADS_LIMIT);
    const { threads } = runtimes();
    const composed = composeVariantText('threads', 'ru', full, threads!.frame);
    expect(composed).toBe(full);
    expect(threads!.validate({ key: 'k', text: composed, lang: 'ru' })).toEqual([]);
    expect(codes(variant(THREADS_RU, { text: text(0, 1) }))).toEqual(['too_long']);
  });

  it('on: the intake keeps room for the line, and the longest variant still fits with it', () => {
    configureVariantFrame({ threadsDisclaimer: true });
    expect(VARIANT_LIMITS.threads.frameReserve).toBe(THREADS_DISCLAIMER_RESERVE);
    // The longest of the languages: one reserve holds for every variant.
    expect(THREADS_DISCLAIMER_RESERVE).toBe(
      Math.max(
        threadsLength(`\n\n${FRAME_TEXTS.ru.disclaimer.comment}`),
        threadsLength(`\n\n${FRAME_TEXTS.en.disclaimer.comment}`),
      ),
    );
    // What was fine with the switch off no longer is.
    const f = finalize(v2Input([variant(THREADS_RU, { text: text(0) })]));
    expect(f.errors!.map((e) => e.code)).toEqual(['too_long']);
    expect(f.errors![0]!.message).toContain(
      `(${THREADS_LIMIT} minus ${THREADS_DISCLAIMER_RESERVE} kept for the frame)`,
    );

    const { threads } = runtimes({ THREADS_DISCLAIMER: 'true' });
    for (const lang of ['ru', 'en'] as const) {
      const longest = stored(variant(THREADS_RU, { lang, text: text(THREADS_DISCLAIMER_RESERVE) }));
      const composed = composeVariantText('threads', lang, longest, threads!.frame);
      expect(composed.endsWith(FRAME_TEXTS[lang].disclaimer.comment)).toBe(true);
      expect(threadsLength(composed)).toBeLessThanOrEqual(THREADS_LIMIT);
      expect(threads!.validate({ key: 'k', text: composed, lang }), lang).toEqual([]);
    }
    expect(codes(variant(THREADS_RU, { text: text(THREADS_DISCLAIMER_RESERVE, 1) }))).toEqual([
      'too_long',
    ]);
  });
});
