import { intakeText } from '../lib/intake-text.js';
import type { PlanIssue } from './pipeline.js';

// J-N1: every text of a plan is cleaned once, when it arrives (CR LF and CR become LF, Unicode
// NFC), and from then on that one string is stored, measured, hashed and sent. A text with a
// lone surrogate cannot be sent as UTF-8 unchanged, so it is refused, naming the slot, the
// variant and the index. A value that is not a string is left to the schema.

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Cleans `text` in place of a copy; a refusal is pushed onto `errors`. */
function clean(
  holder: Record<string, unknown>,
  path: string,
  slotId: string | undefined,
  what: string,
  errors: PlanIssue[],
): Record<string, unknown> {
  if (typeof holder.text !== 'string') return holder;
  const r = intakeText(holder.text);
  if (r.ok) return r.text === holder.text ? holder : { ...holder, text: r.text };
  if (r.reason === 'lone_surrogate') {
    errors.push({
      path,
      ...(slotId !== undefined ? { slotId } : {}),
      code: 'lone_surrogate',
      index: r.at,
      message: `${what} has a lone surrogate at index ${r.at} (a broken emoji or a cut character): it cannot be sent, fix the text`,
    });
  }
  return holder;
}

/** The slots with every slot and variant text cleaned, and the refusals. Never mutates. */
export function cleanSlotTexts(slots: unknown): { slots: unknown; errors: PlanIssue[] } {
  const errors: PlanIssue[] = [];
  if (!Array.isArray(slots)) return { slots, errors };
  const out = slots.map((raw: unknown, i) => {
    if (!isObj(raw)) return raw;
    const slotId = typeof raw.id === 'string' ? raw.id : undefined;
    const name = slotId !== undefined ? `slot "${slotId}"` : `slot ${i}`;
    let s = clean(raw, `slots.${i}.text`, slotId, `${name}: the text`, errors);
    if (Array.isArray(s.variants)) {
      const variants = s.variants.map((v: unknown, j) => {
        if (!isObj(v)) return v;
        const which =
          typeof v.platform === 'string' && typeof v.lang === 'string'
            ? `${v.platform}/${v.lang}`
            : String(j);
        return clean(
          v,
          `slots.${i}.variants.${j}.text`,
          slotId,
          `${name}, variant ${which}: the text`,
          errors,
        );
      });
      if (variants.some((v, j) => v !== (s.variants as unknown[])[j])) s = { ...s, variants };
    }
    return s;
  });
  return { slots: out.some((s, i) => s !== slots[i]) ? out : slots, errors };
}

/** One text (the slot PUT): the cleaned string, or the refusal. */
export function cleanText(
  text: string,
  path: string,
  slotId: string,
): { ok: true; text: string } | { ok: false; error: PlanIssue } {
  const errors: PlanIssue[] = [];
  const holder = clean({ text }, path, slotId, `slot "${slotId}": the text`, errors);
  return errors[0] ? { ok: false, error: errors[0] } : { ok: true, text: holder.text as string };
}
