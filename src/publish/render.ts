import type { Blocks } from './types.js';

// D-21: the markup subset a plan text may use, rendered to Telegram MarkdownV2 only through the
// helpers of WP-SVC-03 (A-4: `src/lib/tg-markdown.ts` is the one place that knows the syntax).
//   **text**         -> md.bold(text)
//   lines "> ..."    -> md.quote(lines): consecutive lines form one quote. md.quote takes raw
//                       lines, so markup inside a quote line (also `**`) is escaped, not rendered
//   URLs             -> plain text, escaped (Telegram links them itself)
//   everything else  -> escapeMdV2, i.e. literal (`*`, `_`, `__`, `~`, `[]()`, `` ` ``, `||` ...)
// Bold rule, per line: the `**` tokens pair in order (1st with 2nd, 3rd with 4th, ...); a pair is
// bold when its content is non-blank and neither starts nor ends with whitespace or `*`. If any
// pair breaks the rule (nested or ambiguous markup such as `**a **b** c**`), the whole line is
// literal. An unpaired last `**` (unclosed) is literal.

export type RenderBlocks = Pick<Blocks, 'escapeMdV2' | 'md'>;

const QUOTE_START = '> ';
const BOLD = '**';

const validBold = (inner: string) => inner.length > 0 && !/^[\s*]|[\s*]$/.test(inner);

/** One non-quote line with `**bold**` pairs rendered and everything else escaped. */
export function renderLine(line: string, b: RenderBlocks): string {
  const at: number[] = [];
  for (let i = line.indexOf(BOLD); i >= 0; i = line.indexOf(BOLD, i + BOLD.length)) at.push(i);
  const pairs: [number, number][] = [];
  for (let k = 0; k + 1 < at.length; k += 2) pairs.push([at[k]!, at[k + 1]!]);
  if (pairs.some(([o, c]) => !validBold(line.slice(o + BOLD.length, c)))) {
    return b.escapeMdV2(line);
  }
  let out = '';
  let i = 0;
  for (const [o, c] of pairs) {
    out += b.escapeMdV2(line.slice(i, o)) + b.md.bold(line.slice(o + BOLD.length, c));
    i = c + BOLD.length;
  }
  return out + b.escapeMdV2(line.slice(i));
}

/** Renders a plan text (D-21 subset) to MarkdownV2. Pure. */
export function renderPlanText(text: string, b: RenderBlocks): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i]!.startsWith(QUOTE_START)) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(QUOTE_START)) {
        quote.push(lines[i]!.slice(QUOTE_START.length));
        i++;
      }
      out.push(b.md.quote(quote));
    } else {
      out.push(renderLine(lines[i]!, b));
      i++;
    }
  }
  return out.join('\n');
}
