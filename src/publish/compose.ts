import { textHash } from '../lib/idempotency.js';
import { SIGNATURE_LINE } from '../plan/pipeline.js';
import type { PlanSlot, Poll, SlotImage } from '../plan/schema.js';
import { mdv2Problems } from './mdv2-check.js';
import { renderPlanText } from './render.js';
import type { Blocks } from './types.js';

// Telegram composition at publish time (D-16, D-17): plan text (already signed by the pipeline)
// + the optional `TG_TRAILER` after the signature, never stored in the plan. The signature guard
// (D-9) and the 4096 limit apply to the composed text, measured after rendering the D-21 markup
// subset to MarkdownV2 (`renderPlanText`); chunking (04) splits the readable text by that measure.

/** Bot API limit for `sendMessage` text, counted on the escaped text. */
export const TG_TEXT_LIMIT = 4096;
/** Bot API limit for a `sendPhoto` caption, counted on the escaped text as well. */
export const TG_CAPTION_LIMIT = 1024;

export class RefusedPost extends Error {
  constructor(
    readonly code:
      | 'unsigned'
      | 'too_long'
      | 'empty'
      | 'bad_markup'
      | 'compose_error'
      | 'image_on_poll'
      | 'image_missing',
    message: string,
  ) {
    super(message);
    this.name = 'RefusedPost';
  }
}

export interface TextPart {
  /** Human text of the part (hashed into the publication row). */
  raw: string;
  /** MarkdownV2 payload sent as `text` (`renderPlanText` of `raw`). */
  escaped: string;
}

/**
 * True when one line of `text` is exactly the signature line (D-9, D-26). The old form with a
 * leading dash is not the signature, so an un-replaced old draft is refused at publish.
 */
export function hasSignatureLine(text: string): boolean {
  return text.split('\n').some((l) => l.trim() === SIGNATURE_LINE);
}

/** The text that goes out: plan text, then the trailer (if any) after the signature. */
export function composeText(text: string, trailer = ''): string {
  const t = trailer.trim();
  return t ? `${text.trimEnd()}\n\n${t}` : text.trim();
}

const BOLD = '**';
const boldTokens = (line: string) => line.split(BOLD).length - 1;
const lastLine = (s: string) => s.slice(s.lastIndexOf('\n') + 1);
const firstLine = (s: string) => s.split('\n', 1)[0]!;

/**
 * Scope item 12: the raw (readable) text is split by the chunker (04), measured by its rendered
 * length. When a split falls inside a `**…**` span (the last line of a part has an odd number of
 * `**` and the first line of the next part too), the boundary moves before the opening `**`;
 * if the moved tail no longer fits with the next part, that is chunked again. A span that starts
 * a part cannot move: it then renders literally (unclosed `**`), which is still valid MarkdownV2.
 */
export function splitPlanText(
  composed: string,
  o: { blocks: Pick<Blocks, 'escapeMdV2' | 'md' | 'chunkText'> },
): string[] {
  const measure = (s: string) => renderPlanText(s, o.blocks).length;
  const chunk = (s: string) =>
    o.blocks.chunkText(s, { limit: TG_TEXT_LIMIT, measure }).filter((p) => p.trim());
  const queue = chunk(composed);
  const out: string[] = [];
  for (let guard = 0; queue.length; guard++) {
    let cur = queue.shift()!;
    const next = queue[0];
    const tailLine = lastLine(cur);
    if (
      next !== undefined &&
      guard < 1000 &&
      boldTokens(tailLine) % 2 === 1 &&
      boldTokens(firstLine(next)) % 2 === 1
    ) {
      const open = cur.length - tailLine.length + tailLine.lastIndexOf(BOLD);
      const head = cur.slice(0, open).trimEnd();
      if (head) {
        // Inside one line the chunker only drops whitespace, so a space rejoins the halves.
        const merged = `${cur.slice(open)} ${queue.shift()!}`;
        queue.unshift(...(measure(merged) <= TG_TEXT_LIMIT ? [merged] : chunk(merged)));
        cur = head;
      }
    }
    out.push(cur);
  }
  return out;
}

/**
 * Splits the composed text into Telegram parts of at most 4096 escaped chars. Throws `RefusedPost`
 * when the last part (the whole text for a single part) lacks the signature line, a part does
 * not fit, or a rendered part fails the MarkdownV2 check (`mdv2Problems`).
 */
export function composeTelegram(
  text: string,
  o: { trailer?: string; blocks: Pick<Blocks, 'escapeMdV2' | 'md' | 'chunkText'> },
): TextPart[] {
  const render = (s: string) => renderPlanText(s, o.blocks);
  const composed = composeText(text, o.trailer);
  if (!composed) throw new RefusedPost('empty', 'the post text is empty');
  const raws = splitPlanText(composed, o);
  const last = raws[raws.length - 1];
  if (last === undefined) throw new RefusedPost('empty', 'the post text is empty');
  if (!hasSignatureLine(last)) {
    // Covers a single-part post too: its only part is the whole composed text.
    throw new RefusedPost('unsigned', 'the post (its last part) has no signature line (D-9)');
  }
  return raws.map((raw, i) => {
    const escaped = render(raw);
    if (escaped.length > TG_TEXT_LIMIT) {
      throw new RefusedPost(
        'too_long',
        `part ${i} is ${escaped.length} escaped chars, max ${TG_TEXT_LIMIT}`,
      );
    }
    const problems = mdv2Problems(escaped);
    if (problems.length) {
      throw new RefusedPost('bad_markup', `part ${i} is not valid MarkdownV2: ${problems[0]}`);
    }
    return { raw, escaped };
  });
}

/** The plain line that names the artist under an illustrated post (D-32). */
export const creditLine = (credit: string) => `Иллюстрация: ${credit}`;

/** What a slot sends, in order; the index in the list is the part number of the publication. */
export type ComposedItem =
  | { kind: 'photo'; image: SlotImage; caption: TextPart }
  | { kind: 'text'; part: TextPart }
  | { kind: 'poll' };

/**
 * The items of one slot. Pure. Throws `RefusedPost` exactly as `composeTelegram` does.
 *
 * A slot without `image` yields what it always did: its text parts, then the poll.
 *
 * A slot with `image` (WP-SVC-24) starts with the photo. The credit line is plain text (escaped,
 * never rendered as markup). When the whole text is one part and, rendered, fits the caption
 * limit together with the credit line, the slot is ONE item: the photo with the caption
 * `text + signature (+ trailer) + credit`. Otherwise the photo carries the credit line alone
 * and the text parts follow unchanged, the signature on the last one. Either way the signature
 * guard (D-9) is the one of `composeTelegram`: it runs on the text before anything is built.
 */
export function composeSlot(
  s: Pick<PlanSlot, 'text' | 'kind' | 'poll' | 'image'>,
  o: { trailer?: string; blocks: Pick<Blocks, 'escapeMdV2' | 'md' | 'chunkText'> },
): ComposedItem[] {
  const parts = composeTelegram(s.text, o);
  const texts: ComposedItem[] = parts.map((part) => ({ kind: 'text', part }));
  if (!s.image) {
    if (s.kind === 'poll' && s.poll) texts.push({ kind: 'poll' });
    return texts;
  }
  if (s.kind === 'poll') {
    throw new RefusedPost('image_on_poll', 'a poll slot cannot carry an image');
  }
  const credit = creditLine(s.image.credit);
  const escapedCredit = o.blocks.escapeMdV2(credit);
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only) {
    const escaped = `${only.escaped}\n\n${escapedCredit}`;
    if (escaped.length <= TG_CAPTION_LIMIT) {
      const caption = { raw: `${only.raw}\n\n${credit}`, escaped };
      return [{ kind: 'photo', image: s.image, caption }];
    }
  }
  const caption = { raw: credit, escaped: escapedCredit };
  return [{ kind: 'photo', image: s.image, caption }, ...texts];
}

/** Hash of a photo part: the image (its sha256) and the caption it goes out with. */
export const photoHash = (imageSha256: string, caption: string) =>
  textHash(`${imageSha256}\n${caption}`);

/** `sendPoll` parameters: a regular anonymous poll (channels allow only anonymous polls). */
export function pollParams(chatId: string, poll: Poll): Record<string, unknown> {
  return {
    chat_id: chatId,
    question: poll.question,
    options: poll.options.map((text) => ({ text })),
    is_anonymous: true,
    type: 'regular',
    allows_multiple_answers: poll.allowsMultiple,
  };
}

/** Hash of a poll part: its question and options. */
export const pollHash = (poll: Poll) =>
  textHash(JSON.stringify({ question: poll.question, options: poll.options }));

/** `sendMessage` parameters: MarkdownV2, link previews off. */
export function messageParams(chatId: string, part: TextPart): Record<string, unknown> {
  return {
    chat_id: chatId,
    text: part.escaped,
    parse_mode: 'MarkdownV2',
    link_preview_options: { is_disabled: true },
  };
}
