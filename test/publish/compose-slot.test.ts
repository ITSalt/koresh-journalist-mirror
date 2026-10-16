import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { textHash } from '../../src/lib/idempotency.js';
import { SIGNATURE_LINE, signText } from '../../src/plan/pipeline.js';
import type { PlanSlot, SlotImage } from '../../src/plan/schema.js';
import {
  composeSlot,
  composeTelegram,
  creditLine,
  hasSignatureLine,
  photoHash,
  RefusedPost,
  TG_CAPTION_LIMIT,
  type ComposedItem,
} from '../../src/publish/compose.js';
import { mdv2Problems } from '../../src/publish/mdv2-check.js';
import { blocks } from '../support/blocks.js';
import { longText } from './helpers.js';

// WP-SVC-24 scope 4: the items of one slot. Without an image they are what main sends; with an
// image the photo comes first, with the whole post as its caption when that fits 1024.

const IMAGE: SlotImage = {
  sha256: 'ab'.repeat(32),
  mime: 'image/png',
  width: 1280,
  height: 720,
  credit: 'zenith-claude',
};
const CREDIT = 'Иллюстрация: zenith-claude';
const POLL = { question: 'Кто прав?', options: ['я', 'ты'], allowsMultiple: false };

type In = Parameters<typeof composeSlot>[0];
const post = (text: string, over: Partial<In> = {}): In => ({
  kind: 'post',
  text: signText(text),
  ...over,
});
const compose = (s: In, trailer?: string) => composeSlot(s, { trailer, blocks });

/** What main's publisher built for a slot (`items()` before WP-SVC-24), kept here as the oracle. */
function mainItems(s: Pick<PlanSlot, 'text' | 'kind' | 'poll'>, trailer?: string): ComposedItem[] {
  const parts = composeTelegram(s.text, { trailer, blocks });
  const out: ComposedItem[] = parts.map((part) => ({ kind: 'text', part }));
  if (s.kind === 'poll' && s.poll) out.push({ kind: 'poll' });
  return out;
}

/** A signed text whose composed caption with CREDIT is exactly `n` escaped chars. */
function textForCaption(n: number, trailer?: string): string {
  const base = compose(post('Что?', { image: IMAGE }), trailer);
  const first = base[0]!;
  if (first.kind !== 'photo') throw new Error('expected a photo');
  // 'я' is one char raw and one char escaped.
  const text = `${'я'.repeat(n - first.caption.escaped.length)}Что?`;
  return text;
}

describe('composeSlot without an image: exactly what main builds', () => {
  it('a post: its text parts; a poll: its text parts, then the poll', () => {
    expect(compose(post('Привет. Как дела?'))).toEqual(mainItems(post('Привет. Как дела?')));
    expect(compose(post('Привет. Как дела?'))).toEqual([
      { kind: 'text', part: expect.objectContaining({ raw: signText('Привет. Как дела?') }) },
    ]);
    const long = post(longText());
    expect(compose(long).length).toBeGreaterThan(1);
    expect(compose(long)).toEqual(mainItems(long));
    const poll = post('Опрос дня.', { kind: 'poll', poll: POLL });
    expect(compose(poll)).toEqual(mainItems(poll));
    expect(compose(poll).map((i) => i.kind)).toEqual(['text', 'poll']);
    expect(compose(long, 'хвост')).toEqual(mainItems(long, 'хвост'));
  });

  it('never a photo, whatever the text (property)', () => {
    const piece = fc.oneof(
      fc.string({ maxLength: 40 }),
      fc.constantFrom('**жирный**', '> цитата', '\n', '\n\n', '_', '*', '[a](b)', '`', '.', '!'),
      fc.constant('Слово за слово, фраза номер (a-b). '),
    );
    fc.assert(
      fc.property(
        fc.array(piece, { maxLength: 400 }),
        fc.boolean(),
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
        (pieces, isPoll, trailer) => {
          const s: In = {
            kind: isPoll ? 'poll' : 'post',
            text: signText(`${pieces.join('')} Что?`),
            ...(isPoll ? { poll: POLL } : {}),
          };
          let expected: ComposedItem[] | string;
          let actual: ComposedItem[] | string;
          try {
            expected = mainItems(s, trailer);
          } catch (e) {
            expected = `${(e as Error).name}: ${(e as Error).message}`;
          }
          try {
            actual = compose(s, trailer);
          } catch (e) {
            actual = `${(e as Error).name}: ${(e as Error).message}`;
          }
          expect(actual).toEqual(expected);
          if (Array.isArray(actual)) expect(actual.some((i) => i.kind === 'photo')).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('`image: undefined` is no image', () => {
    const s = post('Привет. Как дела?', { image: undefined });
    expect(compose(s)).toEqual(mainItems(s));
  });
});

describe('composeSlot with an image', () => {
  it('a short post is ONE item: the photo, caption = text, signature, credit', () => {
    const items = compose(post('Утро. Кто первый?', { image: IMAGE }));
    expect(items).toHaveLength(1);
    const [photo] = items;
    expect(photo).toEqual({
      kind: 'photo',
      image: IMAGE,
      caption: {
        raw: `Утро. Кто первый?\n\n${SIGNATURE_LINE}\n\n${CREDIT}`,
        escaped: `Утро\\. Кто первый?\n\nИИ\\-журналист\\-правдорубец Кореш Шпандент\n\nИллюстрация: zenith\\-claude`,
      },
    });
    expect(hasSignatureLine((photo as { caption: { raw: string } }).caption.raw)).toBe(true);
  });

  it('the trailer stays after the signature, the credit is the last line', () => {
    const [photo] = compose(post('Утро. Кто первый?', { image: IMAGE }), 'хвост');
    expect(photo).toMatchObject({
      kind: 'photo',
      caption: { raw: `Утро. Кто первый?\n\n${SIGNATURE_LINE}\n\nхвост\n\n${CREDIT}` },
    });
  });

  it('the caption limit is exact: 1024 rendered chars is one item, 1025 is photo then text', () => {
    for (const trailer of [undefined, 'хвост (a-b)']) {
      const fits = compose(
        post(textForCaption(TG_CAPTION_LIMIT, trailer), { image: IMAGE }),
        trailer,
      );
      expect(fits).toHaveLength(1);
      expect(fits[0]).toMatchObject({ kind: 'photo' });
      expect((fits[0] as { caption: { escaped: string } }).caption.escaped).toHaveLength(1024);

      const text = textForCaption(TG_CAPTION_LIMIT + 1, trailer);
      const over = compose(post(text, { image: IMAGE }), trailer);
      expect(over.map((i) => i.kind)).toEqual(['photo', 'text']);
      expect(over[0]).toEqual({
        kind: 'photo',
        image: IMAGE,
        caption: { raw: CREDIT, escaped: 'Иллюстрация: zenith\\-claude' },
      });
      // The text parts are exactly those of the same slot without an image.
      expect(over.slice(1)).toEqual(mainItems(post(text), trailer));
    }
  });

  it('the limit is measured on the rendered MarkdownV2, not on the raw text', () => {
    // 600 dots are 600 raw chars and 1200 escaped ones.
    const dots = compose(post(`${'.'.repeat(600)} Что?`, { image: IMAGE }));
    expect(dots.map((i) => i.kind)).toEqual(['photo', 'text']);
    const letters = compose(post(`${'я'.repeat(600)} Что?`, { image: IMAGE }));
    expect(letters.map((i) => i.kind)).toEqual(['photo']);
  });

  it('a long post: the photo with the credit alone, then the text parts as without an image', () => {
    const text = longText();
    const items = compose(post(text, { image: IMAGE }), 'хвост');
    const plain = mainItems(post(text), 'хвост');
    expect(plain.length).toBeGreaterThan(1);
    expect(items).toEqual([
      { kind: 'photo', image: IMAGE, caption: { raw: CREDIT, escaped: expect.any(String) } },
      ...plain,
    ]);
    const last = items[items.length - 1] as { part: { raw: string } };
    expect(hasSignatureLine(last.part.raw)).toBe(true);
    expect(last.part.raw).not.toContain('Иллюстрация');
  });

  it('the credit is plain text: markup in it is escaped, never rendered', () => {
    const credit = '**не жирный** _x_ [a](b) > q `c` #1 a.b';
    for (const text of ['Утро. Кто первый?', longText()]) {
      const [photo] = compose(post(text, { image: { ...IMAGE, credit } }));
      const caption = (photo as { caption: { raw: string; escaped: string } }).caption;
      expect(caption.raw.endsWith(`Иллюстрация: ${credit}`)).toBe(true);
      expect(caption.escaped.endsWith(blocks.escapeMdV2(`Иллюстрация: ${credit}`))).toBe(true);
      expect(caption.escaped).toContain('\\*\\*не жирный\\*\\*');
      expect(mdv2Problems(caption.escaped)).toEqual([]);
    }
  });

  it('any credit yields a valid MarkdownV2 caption (property)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 80 }), fc.boolean(), (credit, long) => {
        fc.pre(!/[\r\n]/.test(credit) && credit.trim().length > 0);
        const items = compose(
          post(long ? longText(100) : 'Утро. Кто первый?', {
            image: { ...IMAGE, credit: credit.trim() },
          }),
        );
        const photo = items[0] as { kind: string; caption: { raw: string; escaped: string } };
        expect(photo.kind).toBe('photo');
        expect(mdv2Problems(photo.caption.escaped)).toEqual([]);
        expect(photo.caption.escaped.length).toBeLessThanOrEqual(TG_CAPTION_LIMIT);
        expect(photo.caption.raw.endsWith(creditLine(credit.trim()))).toBe(true);
        expect(items.filter((i) => i.kind === 'photo')).toHaveLength(1);
      }),
      { numRuns: 300 },
    );
  });

  it('refuses what the text compose refuses, before any item exists (guard D-9)', () => {
    const refused = (s: In) => {
      try {
        compose(s);
      } catch (e) {
        return e instanceof RefusedPost ? e.code : `not a RefusedPost: ${String(e)}`;
      }
      return 'composed';
    };
    expect(refused({ kind: 'post', text: 'Без подписи. Как так?', image: IMAGE })).toBe('unsigned');
    expect(refused({ kind: 'post', text: '   ', image: IMAGE })).toBe('empty');
    // The signature is not on the last part.
    expect(
      refused({ kind: 'post', text: `${SIGNATURE_LINE}\n\n${longText()}`, image: IMAGE }),
    ).toBe('unsigned');
  });

  it('refuses an image on a poll slot', () => {
    expect(() =>
      compose(post('Опрос дня.', { kind: 'poll', poll: POLL, image: IMAGE })),
    ).toThrowError(expect.objectContaining({ name: 'RefusedPost', code: 'image_on_poll' }));
  });
});

describe('photoHash', () => {
  it('covers the image and the caption: either one changing changes the hash', () => {
    const h = photoHash(IMAGE.sha256, 'подпись');
    expect(h).toBe(textHash(`${IMAGE.sha256}\nподпись`));
    expect(photoHash('cd'.repeat(32), 'подпись')).not.toBe(h);
    expect(photoHash(IMAGE.sha256, 'другая')).not.toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
