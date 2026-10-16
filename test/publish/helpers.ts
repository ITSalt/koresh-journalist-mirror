import { signText, saveDraft } from '../../src/plan/pipeline.js';
import type { PlanSlot } from '../../src/plan/schema.js';
import type { PlanStatus, Store } from '../../src/store/index.js';
import { validPlan } from '../plan/fixtures.js';

export const DATE = '2026-10-11';
export const TOKEN = '123456789:fake-bot-token-for-tests';
export const CHANNEL = '@test_channel';
/** `HH:MM[:SS]` MSK on DATE as an instant. */
export const msk = (hhmm: string, day = DATE) =>
  new Date(`${day}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}+03:00`);

export type SlotSpec = Partial<PlanSlot> & { id: string; at: string };

/** Stores a plan for DATE with the given slots (texts signed unless `raw`), in `status`. */
export function seedPlan(
  store: Store,
  slots: SlotSpec[],
  o: { status?: PlanStatus; raw?: boolean } = {},
): void {
  const plan = validPlan(DATE);
  const base = plan.slots[0]!;
  plan.slots = slots.map((s) => {
    const text = s.text ?? 'Короткий пост. Что думаете?';
    return {
      ...base,
      kind: 'post',
      ...s,
      at: s.at.length <= 8 ? `${DATE}T${s.at.length === 5 ? `${s.at}:00` : s.at}+03:00` : s.at,
      text: o.raw ? text : signText(text),
    } as PlanSlot;
  });
  saveDraft(store, { plan, md: '' }, null, msk('20:00', '2026-10-10'));
  const status = o.status ?? 'approved';
  if (status !== 'draft') store.plans.setStatus(DATE, status);
}

export const longText = (n = 600) =>
  Array.from({ length: n }, (_, i) => `Фраза номер ${i} (a-b).`).join(' ') + ' Что дальше?';
