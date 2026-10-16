// MarkdownV2 check for what `renderPlanText` produces (scope item 12): Telegram refuses a whole
// message (400 "can't parse entities") on an unescaped special character or an unbalanced entity.
// Allowed unescaped: `*` of bold (balanced within the message) and `>` at a line start (quote).
// Everything else in the special set must be preceded by `\`, and `\` must escape a special.

const SPECIAL = new Set('_*[]()~`>#+-=|{}.!\\');

/** Problems found in `md` (empty when it is safe to send). */
export function mdv2Problems(md: string): string[] {
  const bad: string[] = [];
  let bold = false;
  for (let i = 0; i < md.length; i++) {
    const c = md[i]!;
    if (c === '\\') {
      if (!SPECIAL.has(md[i + 1] ?? '')) bad.push(`stray backslash at ${i}`);
      i++;
      continue;
    }
    if (!SPECIAL.has(c)) continue;
    if (c === '*') bold = !bold;
    else if (c === '>' && (i === 0 || md[i - 1] === '\n')) continue;
    else bad.push(`unescaped ${c} at ${i}`);
  }
  if (bold) bad.push('unbalanced bold');
  return bad;
}
