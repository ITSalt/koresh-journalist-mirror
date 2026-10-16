import { z } from 'zod';

// plan.json v1: the contract of WP-SVC-10 (Contract row). Every later package reads this shape.
// plan.json v2 (WP-PLAT-01): v1 plus optional `variants` on a slot, one text per platform and
// language outside Telegram. A plan without variants is stored as v1, byte for byte as before,
// and means Telegram only; a plan with at least one variant is stored with `version: 2`.

/** Slot ids become part of idempotency keys (`src/lib/idempotency.ts`): no ':' and no spaces. */
const SLOT_ID_RE = /^[^:\s]{1,64}$/;
/** `YYYY-MM-DDTHH:MM[:SS]+03:00`: a wall-clock time in Moscow. */
export const MSK_AT_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?\+03:00$/;

export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;

export const PollSchema = z.object({
  question: z.string().trim().min(1).max(POLL_QUESTION_MAX),
  options: z.array(z.string().trim().min(1).max(POLL_OPTION_MAX)).min(2).max(10),
  allowsMultiple: z.boolean(),
});

export const CREDIT_MAX = 80;
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'sha256: 64 lowercase hex chars');
/** One line naming the artist; it is posted as `Иллюстрация: <credit>` (D-32). */
const creditSchema = z
  .string()
  .trim()
  .min(1)
  .max(CREDIT_MAX)
  .regex(/^[^\p{Cc}\u2028\u2029]*$/u, 'credit must be one line without control characters');

/** What a plan POST or a slot PUT sends for an illustration (WP-SVC-24). */
export const ImageRefSchema = z.strictObject({ sha256: sha256Schema, credit: creditSchema });

/**
 * The illustration of a slot as stored in the slot json: the submitted `{sha256, credit}` plus
 * the facts of the stored image, filled by the server. Nothing else of the slot changes shape.
 */
export const SlotImageSchema = z.object({
  sha256: sha256Schema,
  mime: z.enum(['image/png', 'image/jpeg']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  credit: creditSchema,
});

const atSchema = z
  .string()
  .regex(MSK_AT_RE, 'at: ISO time with the +03:00 offset, e.g. 2026-10-11T09:00:00+03:00');
const textSchema = z.string().refine((t) => t.trim().length > 0, 'text must not be empty');

const slotShape = {
  id: z.string().regex(SLOT_ID_RE, 'slot id: 1-64 chars, no ":" and no whitespace'),
  at: atSchema,
  platform: z.literal('telegram'),
  kind: z.enum(['post', 'poll']),
  text: textSchema,
  poll: PollSchema.optional(),
  eventDate: z.iso.date(),
  image: SlotImageSchema.optional(),
};

function pollRequired(s: { kind: string; poll?: unknown }, ctx: z.RefinementCtx): void {
  if (s.kind === 'poll' && !s.poll) {
    ctx.addIssue({ code: 'custom', path: ['poll'], message: 'a poll slot requires poll' });
  }
}

/**
 * The Telegram slot: what a slot row holds and what the publisher, the preview and the slot PUT
 * read. It never carries `variants`; those live in the plan json and in `slot_variants`.
 */
export const SlotSchema = z.object(slotShape).superRefine(pollRequired);

/** Platforms a variant can be written for (Telegram is the slot itself). */
export const VARIANT_PLATFORMS = ['threads', 'linkedin'] as const;
export const VARIANT_LANGS = ['ru', 'en'] as const;
export type VariantPlatform = (typeof VARIANT_PLATFORMS)[number];
export type VariantLang = (typeof VARIANT_LANGS)[number];

/**
 * One text of a slot for one platform and language (plan.json v2), written for that platform by
 * the author, with its own time. Strict: no other key (no image, no first comment). In a stored
 * plan `text` is the body plus the signature line; the profile frame is added at publish time.
 */
export const VariantSchema = z.strictObject({
  platform: z.enum(VARIANT_PLATFORMS),
  lang: z.enum(VARIANT_LANGS),
  at: atSchema,
  text: textSchema,
});

/** A slot of plan.json v2: the Telegram slot plus its optional variants (never an empty list). */
export const SlotV2Schema = z
  .object({ ...slotShape, variants: z.array(VariantSchema).min(1).optional() })
  .superRefine(pollRequired);

const planShape = {
  date: z.iso.date(),
  sourceWindow: z.object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    entryIds: z.array(z.string().min(1)),
  }),
  arc: z.object({ title: z.string().trim().min(1), beat: z.string().trim().min(1) }),
};

/** Rules across the slots of a plan: every `at` on the plan date, unique ids, sorted by `at`. */
function slotRules(p: unknown, ctx: z.RefinementCtx): void {
  // Runs even when other fields failed (`when` below), so every fault is reported at once
  // (WP-SVC-10); the value may then be partly invalid, hence the defensive reads.
  if (!p || typeof p !== 'object') return;
  const slots: unknown = (p as { slots?: unknown }).slots;
  if (!Array.isArray(slots)) return;
  const date: unknown = (p as { date?: unknown }).date;
  const seen = new Set<string>();
  let prev = -Infinity;
  slots.forEach((raw: unknown, i) => {
    const s = (raw && typeof raw === 'object' ? raw : {}) as { id?: unknown; at?: unknown };
    if (typeof s.at === 'string' && typeof date === 'string' && s.at.slice(0, 10) !== date) {
      ctx.addIssue({
        code: 'custom',
        path: ['slots', i, 'at'],
        message: `at must be on the plan date ${date}`,
      });
    }
    if (typeof s.id === 'string') {
      if (seen.has(s.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['slots', i, 'id'],
          message: `slot ids must be unique ("${s.id}" repeats)`,
        });
      }
      seen.add(s.id);
    }
    const t = typeof s.at === 'string' ? Date.parse(s.at) : NaN;
    if (Number.isNaN(t)) return;
    if (t < prev) {
      ctx.addIssue({
        code: 'custom',
        path: ['slots', i, 'at'],
        message: 'slots must be sorted by at',
      });
    }
    prev = Math.max(prev, t);
  });
}

const asObj = (v: unknown) => (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;

/**
 * Rules of the variants of every slot (plan.json v2): none on a poll slot, every `at` on the
 * plan date, at most one variant per (platform, lang) in a slot. Each issue names its own code
 * in `params.code`. Defensive reads, as in `slotRules`.
 */
function variantRules(p: unknown, ctx: z.RefinementCtx): void {
  const { slots, date } = asObj(p);
  if (!Array.isArray(slots)) return;
  slots.forEach((raw: unknown, i) => {
    const s = asObj(raw);
    if (!Array.isArray(s.variants)) return;
    if (s.kind === 'poll') {
      ctx.addIssue({
        code: 'custom',
        path: ['slots', i, 'variants'],
        message: 'a poll slot cannot have variants',
        params: { code: 'variants_not_allowed' },
      });
    }
    const seen = new Set<string>();
    s.variants.forEach((rawVariant: unknown, m) => {
      const v = asObj(rawVariant);
      // A malformed `at` is reported once, by its own rule.
      const onDay = typeof v.at === 'string' && MSK_AT_RE.test(v.at) ? v.at.slice(0, 10) : date;
      if (typeof date === 'string' && onDay !== date) {
        ctx.addIssue({
          code: 'custom',
          path: ['slots', i, 'variants', m, 'at'],
          message: `at must be on the plan date ${date}`,
          params: { code: 'wrong_date' },
        });
      }
      if (typeof v.platform !== 'string' || typeof v.lang !== 'string') return;
      const key = `${v.platform}/${v.lang}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['slots', i, 'variants', m],
          message: `a slot has at most one variant per platform and language ("${key}" repeats)`,
          params: { code: 'duplicate_variant' },
        });
      }
      seen.add(key);
    });
  });
}

export const PlanV1Schema = z
  .object({ version: z.literal(1), ...planShape, slots: z.array(SlotSchema) })
  .superRefine(slotRules, { when: () => true });

/** plan.json v2: v1 plus optional `variants` on a slot. */
export const PlanV2Schema = z
  .object({ version: z.literal(2), ...planShape, slots: z.array(SlotV2Schema) })
  .superRefine(
    (p, ctx) => {
      slotRules(p, ctx);
      variantRules(p, ctx);
    },
    { when: () => true },
  );

/** A stored plan of either version: what a reader of the `plans.json` column parses. */
export const PlanSchema = z.discriminatedUnion('version', [PlanV1Schema, PlanV2Schema]);

export type PlanV1 = z.infer<typeof PlanV1Schema>;
export type PlanV2 = z.infer<typeof PlanV2Schema>;
/** A plan document of either version. */
export type PlanDoc = PlanV1 | PlanV2;
/** The Telegram slot (see `SlotSchema`). */
export type PlanSlot = PlanV1['slots'][number];
export type PlanSlotV2 = PlanV2['slots'][number];
export type Variant = z.infer<typeof VariantSchema>;
export type Poll = z.infer<typeof PollSchema>;
export type SlotImage = z.infer<typeof SlotImageSchema>;

/** Validation issues as short `path: message` lines (for logs and the repair prompt). */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}
