// WP-SVC-03: Telegram MarkdownV2 (https://core.telegram.org/bots/api#markdownv2-style). Pure, no
// dependencies. The one place that knows the syntax (A-4): inputs are raw text, outputs are valid
// MarkdownV2.
//
// Outside entities every character of `_ * [ ] ( ) ~ ` > # + - = | { } . ! \` must be escaped
// with a preceding `\`; inside the URL part of an inline link only `)` and `\`.

const SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const URL_SPECIAL = /[)\\]/g;

/** Escapes raw text for use outside entities. Every other character is left as it is. */
export function escapeMdV2(text: string): string {
  return text.replace(SPECIAL, '\\$&');
}

/** Wraps escaped `s` in `marker`; an empty `s` gives '' (no empty entity, no stray markers). */
const wrap = (marker: string, s: string) => (s ? `${marker}${escapeMdV2(s)}${marker}` : '');

/** Quote lines: each raw line escaped and prefixed with `>`, joined by newlines. */
const quoteLines = (lines: string[]) => lines.map((l) => `>${escapeMdV2(l)}`).join('\n');

/**
 * Entity helpers: raw text in, MarkdownV2 out. A caller that puts an italic right before or after
 * an underline must separate them (Telegram reads `___` greedily as underline first).
 */
export const md = {
  bold: (s: string): string => wrap('*', s),
  italic: (s: string): string => wrap('_', s),
  underline: (s: string): string => wrap('__', s),
  spoiler: (s: string): string => wrap('||', s),
  /** Inline link: `text` is escaped as plain text, `url` only for `)` and `\`. */
  link: (text: string, url: string): string =>
    `[${escapeMdV2(text)}](${url.replace(URL_SPECIAL, '\\$&')})`,
  /** Block quote; must start at the beginning of a line of the message. No lines give ''. */
  quote: (lines: string[]): string => quoteLines(lines),
  /** Expandable block quote: `**>` first line, `>` lines, `||` at the end. No lines give ''. */
  expandableQuote: (lines: string[]): string => (lines.length ? `**${quoteLines(lines)}||` : ''),
};
