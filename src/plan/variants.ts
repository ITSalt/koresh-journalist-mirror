import { publicationKey } from '../lib/idempotency.js';
import { THREADS_LIMIT, threadsLength } from '../lib/threads-length.js';
import { THREADS_DISCLAIMER_RESERVE } from '../platforms/frame.js';
import { escapeLittleText } from '../platforms/linkedin/escape.js';
import type { VariantLang, VariantPlatform } from './schema.js';

// Variants of a slot (plan.json v2, WP-PLAT-01): the per-platform facts the plan pipeline, the
// plan.md rendering and the publish loop share. Pure.
//
// The stored text of a variant is the author's body plus the signature line (D-9). What the code
// adds around it at publish time (the profile frame: header, disclaimer, link line) is not in the
// stored text; `frameReserve` keeps room for it, so a text accepted in the evening still fits
// the platform when it goes out.

/**
 * Longest LinkedIn post text. The number is not in LinkedIn's documentation: it is kept in this
 * one constant.
 */
export const LINKEDIN_TEXT_LIMIT = 3000;
/**
 * Room kept in a LinkedIn post for the profile frame the adapter core composes at publish time.
 * The frame must stay within it.
 */
export const LINKEDIN_FRAME_RESERVE = 300;
/**
 * A Threads post is the stored text as is (body and signature): nothing is added to it while the
 * Threads disclaimer is off (the default).
 */
export const THREADS_FRAME_RESERVE = 0;

let threadsDisclaimer = false;
/**
 * Called once at boot with `THREADS_DISCLAIMER` (WP-PLAT-02): when the publish loop adds the
 * disclaimer line to a Threads post, the intake keeps room for it, so a variant accepted in the
 * evening still fits when it goes out. Off: the reserve is 0, as before.
 */
export function configureVariantFrame(o: { threadsDisclaimer: boolean }): void {
  threadsDisclaimer = o.threadsDisclaimer;
}
/** Units kept in a Threads post for the frame: follows `configureVariantFrame`. */
export const threadsFrameReserve = (): number =>
  threadsDisclaimer ? THREADS_DISCLAIMER_RESERVE : THREADS_FRAME_RESERVE;

/** Default minimum gap between two variants of one platform, in minutes (as the scheduler's). */
export const DEFAULT_VARIANT_MIN_GAP_MIN = 20;

const minGapMin: Record<VariantPlatform, number> = {
  threads: DEFAULT_VARIANT_MIN_GAP_MIN,
  linkedin: DEFAULT_VARIANT_MIN_GAP_MIN,
};
/**
 * Called once at boot with `THREADS_MIN_GAP_MIN` and `LINKEDIN_MIN_GAP_MIN` (WP-PLAT-02): the
 * intake refuses what the publish loop of the platform would hold back, so the two read the
 * same numbers.
 */
export function configureVariantGaps(o: Partial<Record<VariantPlatform, number>>): void {
  for (const p of ['threads', 'linkedin'] as const) {
    const v = o[p];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) minGapMin[p] = v;
  }
}
/** The minimum gap of a platform, in minutes: follows `configureVariantGaps`. */
export const variantMinGapMin = (platform: VariantPlatform): number => minGapMin[platform];

export const VARIANT_GAP_CODE = 'variant_gap';

export interface VariantGapIssue {
  /** Index of the slot and of the variant (the later of the two) in the submitted body. */
  slot: number;
  variant: number;
  message: string;
}

const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?\+03:00$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The `variant_gap` rule of the plan intake (director's decision of 13.10): two variants of the
 * same platform on one day that are closer than that platform's minimum gap are refused, because
 * the publish loop would silently hold the second one back until the gap has passed. Works on the
 * raw slots of a submitted plan (so it reports together with every other fault) and across
 * slots. A variant that is refused by a rule of its own is left to that rule: an invalid platform
 * or `at`, a variant on a poll slot, the second variant of one (platform, lang) in a slot. Each
 * pair of neighbours in time that is too close yields one issue, on the later variant. Pure.
 */
export function variantGapIssues(slots: unknown): VariantGapIssue[] {
  if (!Array.isArray(slots)) return [];
  type Item = { slot: number; variant: number; name: string; at: string; ms: number };
  const byPlatform: Record<VariantPlatform, Item[]> = { threads: [], linkedin: [] };
  slots.forEach((s: unknown, slot) => {
    if (!isRecord(s) || !Array.isArray(s.variants) || s.kind === 'poll') return;
    const seen = new Set<string>();
    s.variants.forEach((v: unknown, variant) => {
      if (!isRecord(v) || typeof v.at !== 'string' || !AT_RE.test(v.at)) return;
      if (v.platform !== 'threads' && v.platform !== 'linkedin') return;
      const pair = `${v.platform}/${String(v.lang)}`;
      if (seen.has(pair)) return; // `duplicate_variant` speaks for it
      seen.add(pair);
      const ms = Date.parse(v.at);
      if (!Number.isFinite(ms)) return;
      const name = `${typeof s.id === 'string' ? s.id : `slots.${slot}`}/${String(v.lang)}`;
      byPlatform[v.platform].push({ slot, variant, name, at: v.at.slice(11, -6), ms });
    });
  });
  const out: VariantGapIssue[] = [];
  for (const platform of ['threads', 'linkedin'] as const) {
    const gap = variantMinGapMin(platform);
    // Stable: variants at the same instant keep the order of the body.
    const items = byPlatform[platform].sort((a, b) => a.ms - b.ms);
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1]!;
      const b = items[i]!;
      const apartS = Math.round((b.ms - a.ms) / 1000);
      if (apartS >= gap * 60) continue;
      out.push({
        slot: b.slot,
        variant: b.variant,
        message:
          `${platform} variants ${a.name} at ${a.at} and ${b.name} at ${b.at} are ` +
          `${Math.floor(apartS / 60)} min ${apartS % 60} s apart; the minimum gap on ${platform} is ` +
          `${gap} min, so the second one would wait instead of going out at its time. ` +
          `Put them at least ${gap} min apart`,
      });
    }
  }
  return out.sort((x, y) => x.slot - y.slot || x.variant - y.variant);
}

export interface VariantLimit {
  /** The platform's limit for one post, in units of `measure`. */
  limit: number;
  /** Units kept for what the code adds around the stored text at publish time. */
  frameReserve: number;
  /** Length of a text in the platform's own arithmetic. */
  measure(text: string): number;
  /** What `measure` counts, for the message of a too long text. */
  counting: string;
}

export const VARIANT_LIMITS: Record<VariantPlatform, VariantLimit> = {
  // Rule R1 of board task J-C3.
  threads: {
    limit: THREADS_LIMIT,
    get frameReserve() {
      return threadsFrameReserve();
    },
    measure: threadsLength,
    counting: 'units as Threads counts (an emoji takes its UTF-8 bytes)',
  },
  // As the LinkedIn adapter counts at publish time (WP-PLAT-02 item 10): UTF-16 code units of
  // the text after "little text" escaping, where each reserved character takes a backslash. A
  // text full of brackets and `#` that is accepted here therefore still passes `validate`.
  linkedin: {
    limit: LINKEDIN_TEXT_LIMIT,
    frameReserve: LINKEDIN_FRAME_RESERVE,
    measure: (text) => escapeLittleText(text).length,
    counting: 'chars as LinkedIn counts (a reserved character such as ( ) # _ * takes two)',
  },
};

/** `used`: length of a stored variant text (body and signature); `max`: what it may use. */
export function variantLength(
  platform: VariantPlatform,
  text: string,
): { used: number; max: number } {
  const rule = VARIANT_LIMITS[platform];
  return { used: rule.measure(text), max: rule.limit - rule.frameReserve };
}

/** How a variant is named inside its platform for one plan date: `<slot>-<lang>`. */
export const variantId = (slotId: string, lang: VariantLang) => `${slotId}-${lang}`;

/**
 * The idempotency key of one publication of a variant: `<platform>:<date>:<slot>-<lang>:<part>`.
 * Two variants never share a key: a slot has one variant per (platform, lang), and the language
 * is always the last three characters of the third field.
 */
export function variantPublicationKey(v: {
  platform: VariantPlatform;
  planDate: string;
  slotId: string;
  lang: VariantLang;
  part: number;
}): string {
  return publicationKey({
    platform: v.platform,
    planDate: v.planDate,
    slotId: variantId(v.slotId, v.lang),
    part: v.part,
  });
}
