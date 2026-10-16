import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PROMPTS_DIR } from './prompt.js';

// Anti-machine lint (D-26, journalist/channel1-criteria.md part 4): one pure function over a text,
// used by `finalizePlan` for every slot text and poll question/option, so POST and the fallback
// get exactly the same rules. It runs on the author's text, before the code adds the signature.

export type LintCode = 'em_dash' | 'en_dash' | 'guillemets' | 'list_line' | 'stop_phrase';

export interface LintIssue {
  code: LintCode;
  /** The offending piece of the text, with a little context. */
  excerpt: string;
}

/** Phrases from a stop-list file: one per line, `#` comments and blank lines skipped, lowercased. */
export function parseStopPhrases(src: string): string[] {
  return src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.toLowerCase());
}

/** Loaded once at boot; a missing file stops the process instead of silently disabling the rule. */
export function loadStopPhrases(dir: string = DEFAULT_PROMPTS_DIR): string[] {
  return parseStopPhrases(readFileSync(join(dir, 'stop-phrases.txt'), 'utf8'));
}

export const STOP_PHRASES: readonly string[] = loadStopPhrases();

const CONTEXT = 15;
const LIST_LINE_RE = /^\s*(?:[-•*—]\s|\d+[.)]\s)/;

const around = (text: string, i: number, len: number) =>
  text.slice(Math.max(0, i - CONTEXT), i + len + CONTEXT).replace(/\s+/g, ' ');

/** At most one issue per code per text (the first offender), in a fixed order. */
export function lintText(text: string, stopPhrases: readonly string[] = STOP_PHRASES): LintIssue[] {
  const out: LintIssue[] = [];
  const dash = (ch: string, code: LintCode) => {
    const i = text.indexOf(ch);
    if (i >= 0) out.push({ code, excerpt: around(text, i, 1) });
  };
  dash('—', 'em_dash');
  dash('–', 'en_dash');
  const g = text.search(/[«»]/);
  if (g >= 0) out.push({ code: 'guillemets', excerpt: around(text, g, 1) });
  const line = text.split('\n').find((l) => LIST_LINE_RE.test(l));
  if (line !== undefined) out.push({ code: 'list_line', excerpt: line.trim().slice(0, 60) });
  const low = text.toLowerCase();
  for (const p of stopPhrases) {
    const i = low.indexOf(p);
    if (i >= 0) out.push({ code: 'stop_phrase', excerpt: around(text, i, p.length) });
  }
  return out;
}
