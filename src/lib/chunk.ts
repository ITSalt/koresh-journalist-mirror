// WP-SVC-04: split a text into platform-length chunks. Pure, no dependencies.
//
// Every chunk is a trimmed substring of the input, measure(chunk) <= limit - reserve, and chunks
// are cut only where the input has whitespace, in this order of preference:
//   1. a paragraph break (a whitespace run with two or more line breaks),
//   2. a sentence end (`.` `!` `?` `…`, also `?!`, `!!!`, `...`, optionally followed by closing
//      quotes or brackets, then whitespace), except decimals, common abbreviations, initials, URLs,
//   3. any whitespace,
// taking at each level the last break that fits. Only a single token longer than the limit is cut
// inside (a hard cut), and then at a grapheme boundary: a surrogate pair, a combining or a ZWJ
// sequence is never split. The measure is assumed to grow with the text (the result is always
// measured, so a measure that does not only costs the best cut, never the limit).

export interface ChunkOptions {
  /** Platform limit, in units of `measure`. */
  limit: number;
  /** Room kept free in every chunk (header, signature): chunks measure <= limit - reserve. */
  reserve?: number;
  /** Length of a chunk; default UTF-16 code units (`s.length`), as Telegram counts. */
  measure?: (s: string) => number;
}

const PARAGRAPH = 0;
const SENTENCE = 1;
const SPACE = 2;

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/g;
const CLOSERS = /[»"'”’)\]]+$/u;
const OPENERS = /^[«"'“‘„([]+/u;

// Lower-case, compared after stripping opening quotes or brackets.
const ABBREVIATIONS = new Set([
  'т.',
  'е.',
  'д.',
  'п.',
  'т.е.',
  'т.д.',
  'т.п.',
  'т.к.',
  'т.н.',
  'г.',
  'гг.',
  'в.',
  'вв.',
  'др.',
  'пр.',
  'см.',
  'ср.',
  'стр.',
  'рис.',
  'ул.',
  'им.',
  'напр.',
  'тыс.',
  'млн.',
  'млрд.',
  'руб.',
  'проф.',
  'акад.',
  'e.g.',
  'i.e.',
  'etc.',
  'vs.',
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'st.',
  'jr.',
  'sr.',
  'no.',
]);

const isUrl = (word: string) => /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(word);

/** True when the token right before a whitespace run ends a sentence. */
function endsSentence(token: string): boolean {
  const t = token.replace(CLOSERS, '');
  if (!/[.!?…]$/u.test(t)) return false;
  const word = t.replace(OPENERS, '');
  if (isUrl(word)) return false;
  // The rules below only match a word ending in a single `.`: `!`, `?`, `…`, `...` always end.
  if (ABBREVIATIONS.has(word.toLowerCase())) return false;
  if (/^\p{Lu}\.$/u.test(word)) return false; // initial: А.
  if (/^(?:\p{L}\.){2,}$/u.test(word)) return false; // initials or abbreviation: А.С., т.е.
  return true;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const WHITESPACE = /^\s+$/u;

interface Gap {
  /** Grapheme index of the first whitespace grapheme. */
  from: number;
  level: number;
}

/** Splits `text` into chunks of measure <= limit - reserve; see the module comment. */
export function chunkText(text: string, opts: ChunkOptions): string[] {
  const { limit, reserve = 0, measure = (s: string) => s.length } = opts;
  const max = limit - reserve;
  if (!Number.isFinite(limit) || !Number.isFinite(reserve) || reserve < 0 || !(max >= 1)) {
    throw new RangeError(
      `chunkText: need a finite limit > reserve >= 0 (limit ${limit}, reserve ${reserve})`,
    );
  }

  // Graphemes: offsets[i] is the UTF-16 offset of grapheme i, offsets[n] = text.length.
  const offsets: number[] = [];
  const ws: boolean[] = [];
  for (const { index, segment } of segmenter.segment(text)) {
    offsets.push(index);
    ws.push(WHITESPACE.test(segment));
  }
  const n = ws.length;
  offsets.push(text.length);
  const slice = (a: number, b: number) => text.slice(offsets[a], offsets[b]);
  const fits = (a: number, b: number) => measure(slice(a, b)) <= max;

  let begin = 0;
  let end = n;
  while (begin < end && ws[begin]) begin++;
  while (end > begin && ws[end - 1]) end--;
  if (begin === end) return [];

  // Whitespace runs inside the trimmed text, with their break level.
  const gaps: Gap[] = [];
  for (let i = begin; i < end;) {
    if (!ws[i]) {
      i++;
      continue;
    }
    const from = i;
    while (ws[i]) i++;
    const run = slice(from, i);
    let tokenStart = from;
    while (tokenStart > begin && !ws[tokenStart - 1]) tokenStart--;
    const level =
      (run.match(LINE_BREAK)?.length ?? 0) >= 2
        ? PARAGRAPH
        : endsSentence(slice(tokenStart, from))
          ? SENTENCE
          : SPACE;
    gaps.push({ from, level });
  }

  /** The last of `ends` (ascending grapheme indexes > pos) with slice(pos, end) fitting, or -1. */
  const lastFitting = (pos: number, ends: number[]): number => {
    let lo = 0;
    let hi = ends.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fits(pos, ends[mid]!)) {
        best = ends[mid]!;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  };

  const chunks: string[] = [];
  let pos = begin;
  let g = 0; // first gap after pos
  while (pos < end) {
    while (g < gaps.length && gaps[g]!.from <= pos) g++;
    let cut = fits(pos, end) ? end : -1;
    for (let level = PARAGRAPH; cut < 0 && level <= SPACE; level++) {
      const ends: number[] = [];
      for (let k = g; k < gaps.length; k++) if (gaps[k]!.level <= level) ends.push(gaps[k]!.from);
      cut = lastFitting(pos, ends);
    }
    if (cut < 0) {
      // Hard cut inside the token that starts at pos: the most graphemes that fit.
      const tokenEnd = g < gaps.length ? gaps[g]!.from : end;
      const ends: number[] = [];
      for (let k = pos + 1; k <= tokenEnd; k++) ends.push(k);
      cut = lastFitting(pos, ends);
      if (cut < 0) {
        throw new RangeError(
          `chunkText: "${slice(pos, pos + 1)}" alone measures more than ${max} (limit - reserve)`,
        );
      }
    }
    chunks.push(slice(pos, cut));
    pos = cut;
    while (pos < end && ws[pos]) pos++;
  }
  return chunks;
}
