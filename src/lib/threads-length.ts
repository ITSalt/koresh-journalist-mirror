// Length of a text as Threads counts it: rule R1 of board task J-C3 (our reading of the Threads
// documentation: 500 characters per post, emoji counted by their UTF-8 bytes). A local
// implementation until the board's `threads-length.ts` is accepted; the names and signatures are
// the task's, so that file replaces this one. Pure, no imports.
//
// R1: the text is normalized to NFC and walked by Unicode code points. A code point counts as
// the number of bytes of its UTF-8 encoding when it is Extended_Pictographic, an emoji modifier,
// a regional indicator, U+200D (zero width joiner), U+FE0F (variation selector 16) or U+20E3
// (combining keycap). Every other code point counts 1.

export const THREADS_LIMIT = 500;

const BY_BYTES =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0F\u20E3]/u;

/** Bytes of the UTF-8 encoding of one code point. */
const utf8Bytes = (cp: number) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/** Rule R1 for one code point: the one place to change if the live API counts differently. */
function units(ch: string): number {
  return BY_BYTES.test(ch) ? utf8Bytes(ch.codePointAt(0) as number) : 1;
}

export function threadsLength(text: string): number {
  let n = 0;
  for (const ch of text.normalize('NFC')) n += units(ch);
  return n;
}

/** True when the text and `reserve` more units fit one Threads post. */
export function fitsThreads(text: string, reserve = 0): boolean {
  return threadsLength(text) + reserve <= THREADS_LIMIT;
}
