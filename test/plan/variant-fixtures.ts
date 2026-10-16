import { SIGNATURE_LINE } from '../../src/plan/pipeline.js';
import type { Variant } from '../../src/plan/schema.js';
import { DATE, validPlan } from './fixtures.js';

// plan.json v2 fixtures (WP-PLAT-01): the fixture plan with variants on its post slot s1.

export const THREADS_RU: Variant = {
  platform: 'threads',
  lang: 'ru',
  at: `${DATE}T09:07:41+03:00`,
  text: 'Третий день в офисе тишина, даже чайник молчит ☕\n\nКто нарушит её первым?',
};
export const LINKEDIN_RU: Variant = {
  platform: 'linkedin',
  lang: 'ru',
  at: `${DATE}T10:12:09+03:00`,
  text: 'Дело №1. Тишина.\n\nТри дня команда работает молча: ни одного сообщения в общем чате, задачи при этом закрываются.\n\nЭто зрелость процесса или усталость, которую пора заметить?',
};
export const LINKEDIN_EN: Variant = {
  platform: 'linkedin',
  lang: 'en',
  // At least the minimum gap (20 min) after the Russian one: the `variant_gap` rule.
  at: `${DATE}T10:41+03:00`,
  text: 'Case 1. Silence.\n\nThree days without a single message in the team chat, and the tasks still get closed.\n\nIs that a mature process, or fatigue nobody has named yet?',
};
export const VARIANTS = [THREADS_RU, LINKEDIN_RU, LINKEDIN_EN];

/** The text as the server stores it: the body and the signature line. */
export const signed = (text: string) => `${text}\n\n${SIGNATURE_LINE}`;

/** `{arc, slots}` of the fixture plan as a v1 body: no slot has `variants`. */
export function v1Input() {
  const p = validPlan();
  return { arc: p.arc, slots: p.slots.map((s) => ({ ...s })) as Record<string, unknown>[] };
}

/** The fixture plan with `variants` on the post slot s1 and, when given, on the poll slot s2. */
export function v2Input(variants: unknown = VARIANTS, onPoll?: unknown) {
  const input = v1Input();
  input.slots[0]!.variants = structuredClone(variants);
  if (onPoll !== undefined) input.slots[1]!.variants = structuredClone(onPoll);
  return input;
}

/** A variant with some fields replaced. */
export const variant = (base: Variant, over: Record<string, unknown>) => ({ ...base, ...over });
