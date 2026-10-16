import { saveDraft, signText } from '../../src/plan/pipeline.js';
import type { PlanSlot, PlanV2, VariantLang, VariantPlatform } from '../../src/plan/schema.js';
import { variantPublicationKey } from '../../src/plan/variants.js';
import type { PlanStatus, Publication, SlotVariant, Store } from '../../src/store/index.js';
import { validPlan } from '../plan/fixtures.js';
import { DATE, msk, type SlotSpec } from './helpers.js';

// A stored day with variants (plan.json v2) for the publish tests of WP-PLAT-02, written through
// `saveDraft` exactly as a plan POST writes it. `helpers.ts` (the v1 day) is left as it is.

export interface VariantSpec {
  /** The slot the variant belongs to. */
  slot: string;
  platform: VariantPlatform;
  lang?: VariantLang;
  /** `HH:MM[:SS]` MSK on DATE. */
  at: string;
  text?: string;
}

const iso = (at: string) =>
  at.length <= 8 ? `${DATE}T${at.length === 5 ? `${at}:00` : at}+03:00` : at;

/** Stores an approved (or `status`) plan for DATE: the slots and, on them, the variants. */
export function seedVariantPlan(
  store: Store,
  slots: SlotSpec[],
  variants: VariantSpec[],
  o: { status?: PlanStatus } = {},
): void {
  const v1 = validPlan(DATE);
  const base = v1.slots[0]!;
  const plan: PlanV2 = {
    ...v1,
    version: 2,
    slots: slots.map((s) => {
      const own = variants
        .filter((v) => v.slot === s.id)
        .map((v) => ({
          platform: v.platform,
          lang: v.lang ?? 'ru',
          at: iso(v.at),
          text: signText(v.text ?? 'Короткий вариант. Что думаете?'),
        }));
      return {
        ...base,
        kind: 'post',
        ...s,
        at: iso(s.at),
        text: signText(s.text ?? 'Короткий пост. Что думаете?'),
        ...(own.length ? { variants: own } : {}),
      } as PlanSlot;
    }),
  };
  saveDraft(store, { plan, md: '' }, null, msk('20:00', '2026-10-10'));
  const status = o.status ?? 'approved';
  if (status !== 'draft') store.plans.setStatus(DATE, status);
}

export const variantRow = (
  store: Store,
  slotId: string,
  platform: VariantPlatform,
  lang: VariantLang = 'ru',
): SlotVariant =>
  store.slotVariants
    .listForPlan(DATE)
    .find((v) => v.slotId === slotId && v.platform === platform && v.lang === lang)!;

export const variantKey = (
  slotId: string,
  platform: VariantPlatform,
  lang: VariantLang = 'ru',
  part = 0,
) => variantPublicationKey({ platform, planDate: DATE, slotId, lang, part });

/**
 * Writes the publication row of a variant as the variant loop does: claimed against the variant
 * row at `at`, then left as an intent or moved to `status`. The row carries the slot's own id.
 */
export function variantPublication(
  store: Store,
  slotId: string,
  platform: VariantPlatform,
  status: 'intent' | 'sent' | 'unknown' | 'failed' | 'dry',
  at: Date,
  lang: VariantLang = 'ru',
): Publication {
  const v = variantRow(store, slotId, platform, lang);
  const key = variantKey(slotId, platform, lang);
  store.publications.beginVariantIntent(
    {
      key,
      platform,
      planDate: DATE,
      slotId,
      lang,
      textSha256: 'f'.repeat(64),
      expectVariantJson: v.json,
    },
    at,
  );
  if (status === 'sent') store.publications.markSent(key, `${platform}-post-1`, at);
  if (status === 'dry') store.publications.markDry(key, at);
  if (status === 'unknown') store.publications.markUnknown(key, 'no answer');
  if (status === 'failed') store.publications.markFailed(key, 'refused');
  if (status === 'sent' || status === 'dry') {
    store.slotVariants.setStatus(DATE, slotId, platform, lang, 'done');
  }
  return store.publications.get(key)!;
}
