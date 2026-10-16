// LinkedIn "little text" escaping for the `commentary` field of the Posts API.
// The reserved characters of the format are | { } @ [ ] ( ) < > # \ * _ ~ ; each one that is
// meant as plain text is written with a backslash in front of it. Everything the Journalist
// writes is plain text: this adapter builds no mention and no hashtag elements.
//
// Apply exactly once, to the plain text: the function is not idempotent. A second pass escapes
// the backslashes of the first one and readers would see them.
//
// Pure, no imports. The file may later be replaced by the board's version with the same
// signature (`escapeLittleText(text: string): string`).

/** The reserved characters of the little text format, in the order the documentation lists. */
export const LITTLE_TEXT_RESERVED = '|{}@[]()<>#\\*_~';

const RESERVED = new Set(LITTLE_TEXT_RESERVED);

/** Puts a backslash before every reserved character; all other text is left as it is. */
export function escapeLittleText(text: string): string {
  let out = '';
  for (const ch of text) out += RESERVED.has(ch) ? `\\${ch}` : ch;
  return out;
}
