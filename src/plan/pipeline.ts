import { createHash } from 'node:crypto';
import type { SlotVariantInput, Store } from '../store/index.js';
import { lintText } from './lint.js';
import { SIGNATURE } from './prompt.js';
import { renderPlanMd } from './render.js';
import {
  ImageRefSchema,
  PlanV1Schema,
  PlanV2Schema,
  SlotSchema,
  VARIANT_PLATFORMS,
  type PlanDoc,
  type PlanSlot,
  type PlanSlotV2,
  type PlanV1,
  type SlotImage,
} from './schema.js';
import { VARIANT_GAP_CODE, VARIANT_LIMITS, variantGapIssues, variantLength } from './variants.js';
import { isRoundAt, ROUND_TIME_MESSAGE, timingWarnings, type PlanWarning } from './timing.js';

// The one post-processing pipeline every plan goes through, whoever wrote it (D-14): the
// director's subagent via POST /v1/plans/:date, or the OpenRouter fallback (buildPlan).
// schema -> question check -> signature by code (D-9) -> raw length limit -> render plan.md;
// `saveDraft` then stores it. There is no second copy of these rules anywhere.
//
// plan.json v2 (WP-PLAT-01): a slot of a plan POST may carry `variants`, one text per platform
// and language outside Telegram. Each variant goes through the same lint, question rule and
// signature as a Telegram text, and through the length rule of its platform. A plan without
// variants takes exactly the v1 path and is stored as before.

/** The signature line every post ends with (D-9). It is the AI disclosure. */
export const SIGNATURE_LINE = SIGNATURE;
/** Raw length limit after signing; leaves a margin for MarkdownV2 escaping (WP-SVC-11). */
export const TEXT_MAX_RAW = 3500;

/** One validation problem; all of them are reported at once. */
export interface PlanIssue {
  /**
   * Dotted path in the submitted body, e.g. `slots.0.text`, `slots.0.variants.1.text` for a
   * variant of a slot; `(body)` for the root.
   */
  path: string;
  /** Id of the slot the issue is in, when the slot has a string id. */
  slotId?: string;
  code: string;
  message: string;
  /** Lint codes only: the offending piece of the text. */
  excerpt?: string;
  /** `lone_surrogate` only: index of the offending UTF-16 unit in the text as it was sent. */
  index?: number;
}

export type PlanBase = Omit<PlanV1, 'arc' | 'slots'>;

export type Finalized =
  | { plan: PlanDoc; md: string; warnings: PlanWarning[]; errors?: undefined }
  | { plan?: undefined; md?: undefined; warnings?: undefined; errors: PlanIssue[] };

/** The text with every line containing the signature removed (L-2), trailing space trimmed. */
export function stripSignature(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.includes(SIGNATURE))
    .join('\n')
    .trimEnd();
}

/** Signature stripped (with or without dash or decoration), then appended on its own line (D-26). */
export function signText(text: string): string {
  return `${stripSignature(text)}\n\n${SIGNATURE_LINE}`;
}

const CLOSERS_TAIL = /[\s»"”'’)\]}]+$/;
const URL_RE = /(?:https?:\/\/|www\.)/i;

/** True when the `?` at `i` belongs to a URL (its whitespace-delimited token is a link). */
function inUrl(line: string, i: number): boolean {
  const start = line.lastIndexOf(' ', i) + 1;
  return URL_RE.test(line.slice(start, i + 1));
}

/**
 * True when the last non-empty body line (signature lines ignored) is a plain question (D-26):
 * it ends with `?` after closing quotes and brackets are trimmed. A `?` inside a URL is no
 * question. There is no answer-deadline tail any more.
 */
export function endsWithQuestion(text: string): boolean {
  const last = stripSignature(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!last) return false;
  const line = last.replace(CLOSERS_TAIL, '');
  const i = line.length - 1;
  return (line[i] === '?' || line[i] === '？') && !inUrl(line, i);
}

/** `sourceWindow` of entries: earliest and latest `at`, ids in the given order. */
export function sourceWindowOf(
  entries: { id: string; at: string }[],
  now: Date,
): PlanV1['sourceWindow'] {
  if (!entries.length) {
    return { from: now.toISOString(), to: now.toISOString(), entryIds: [] };
  }
  const byTime = [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    from: byTime[0]!.at,
    to: byTime[byTime.length - 1]!.at,
    entryIds: entries.map((e) => e.id),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** `variants` of a submitted slot that names at least one variant (not absent, null or `[]`). */
const hasVariants = (v: unknown) => v != null && !(Array.isArray(v) && v.length === 0);

/** A copy of `o` without `key`; the other keys keep their order. */
function omit(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const rest = { ...o };
  delete rest[key];
  return rest;
}

/** The code of a schema issue: the rule's own code when it names one (`params.code`). */
function issueCode(i: { code: string; params?: Record<string, unknown> }): string {
  const own = i.code === 'custom' ? i.params?.code : undefined;
  return typeof own === 'string' ? own : i.code;
}

function slotIdAt(slots: unknown, i: unknown): string | undefined {
  if (!Array.isArray(slots) || typeof i !== 'number') return undefined;
  const s: unknown = slots[i];
  return isObj(s) && typeof s.id === 'string' ? s.id : undefined;
}

function issue(path: (string | number)[], code: string, message: string, slots: unknown) {
  const out: PlanIssue = { path: path.join('.') || '(body)', code, message };
  const id = path[0] === 'slots' ? slotIdAt(slots, path[1]) : undefined;
  if (id !== undefined) out.slotId = id;
  return out;
}

const LINT_HINT: Record<string, string> = {
  em_dash: 'em dash (U+2014) is not allowed; use a comma, a colon, a period or a hyphen',
  en_dash: 'en dash (U+2013) is not allowed; use a hyphen',
  guillemets: 'guillemets are not allowed; use plain "quotes"',
  list_line: 'a line must not start like a list item (-, •, *, —, "1." or "1)"); write prose',
  stop_phrase: 'stop phrase from prompts/stop-phrases.txt',
};

const NO_QUESTION =
  'a post must end with a plain question: the last line before the signature ends with "?" (a "?" inside a link does not count)';

/** Builds an issue for a path inside one slot (relative to the slot). */
export type SlotIssue = (path: (string | number)[], code: string, message: string) => PlanIssue;

/** Anti-machine lint (D-26) of one string; every fault becomes an issue at `path`. */
function lintInto(
  text: string,
  path: (string | number)[],
  mk: SlotIssue,
  errors: PlanIssue[],
): void {
  for (const l of lintText(text)) {
    const e = mk(path, l.code, `${LINT_HINT[l.code]}: "${l.excerpt}"`);
    e.excerpt = l.excerpt;
    errors.push(e);
  }
}

/** Lint of a text of a slot (post text, poll question or option); the signature is excluded. */
function lintValue(
  value: unknown,
  path: (string | number)[],
  mk: SlotIssue,
  errors: PlanIssue[],
): void {
  if (typeof value === 'string') lintInto(stripSignature(value), path, mk, errors);
}

/** Anti-machine lint (D-26) of one slot: text, poll question and options. Signature excluded. */
function lintSlot(s: Record<string, unknown>, mk: SlotIssue, errors: PlanIssue[]) {
  const check = (value: unknown, path: (string | number)[]) => lintValue(value, path, mk, errors);
  check(s.text, ['text']);
  if (isObj(s.poll)) {
    check(s.poll.question, ['poll', 'question']);
    if (Array.isArray(s.poll.options)) {
      s.poll.options.forEach((o: unknown, j) => check(o, ['poll', 'options', j]));
    }
  }
}

/**
 * The text rules of one raw slot, the same for a whole plan and for a single replaced slot
 * (WP-SVC-22): lint (D-26), the question rule, the signature by code (D-9) and the raw length
 * after signing. Problems go to `errors`; returns the signed text when the slot has one.
 */
function slotTextRules(
  s: Record<string, unknown>,
  mk: SlotIssue,
  errors: PlanIssue[],
): string | undefined {
  lintSlot(s, mk, errors);
  if (typeof s.text !== 'string' || !s.text.trim()) return undefined;
  if (s.kind !== 'poll' && !endsWithQuestion(s.text)) {
    errors.push(mk(['text'], 'no_question', NO_QUESTION));
  }
  const text = signText(s.text);
  if (text.length > TEXT_MAX_RAW) {
    errors.push(
      mk(
        ['text'],
        'too_long',
        `${text.length} chars after the signature, max ${TEXT_MAX_RAW}; shorten it`,
      ),
    );
  }
  return text;
}

/**
 * The text rules of one raw variant of a slot (plan.json v2): lint (D-26), the question rule,
 * the signature by code (D-9) and the length rule of its platform, measured on the signed text
 * with room kept for the frame added at publish time (`VARIANT_LIMITS`). `mk` builds issues
 * relative to the variant. Returns the signed text when the variant has one.
 */
function variantTextRules(
  v: Record<string, unknown>,
  mk: SlotIssue,
  errors: PlanIssue[],
): string | undefined {
  // WP-SVC-25: the `round_time` rule of a slot's `at` applies to a variant's `at` too.
  if (typeof v.at === 'string' && isRoundAt(v.at)) {
    errors.push(mk(['at'], 'round_time', ROUND_TIME_MESSAGE));
  }
  lintValue(v.text, ['text'], mk, errors);
  if (typeof v.text !== 'string' || !v.text.trim()) return undefined;
  if (!endsWithQuestion(v.text)) errors.push(mk(['text'], 'no_question', NO_QUESTION));
  const text = signText(v.text);
  // An unknown platform is the schema's error; there is no length rule to apply then.
  const platform = VARIANT_PLATFORMS.find((p) => p === v.platform);
  if (platform) {
    const { used, max } = variantLength(platform, text);
    if (used > max) {
      const { limit, frameReserve, counting } = VARIANT_LIMITS[platform];
      const frame = frameReserve ? ` (${limit} minus ${frameReserve} kept for the frame)` : '';
      errors.push(
        mk(
          ['text'],
          'too_long',
          `${used} ${counting} after the signature, max ${max} on ${platform}${frame}; shorten it`,
        ),
      );
    }
  }
  return text;
}

/** The stored facts of an uploaded image by its sha256; undefined when it is not stored. */
export type ImageLookup = (sha256: string) => Omit<SlotImage, 'credit'> | undefined;

/**
 * Checks a submitted illustration `{sha256, credit}` of a slot (WP-SVC-24) and returns the form
 * that is stored in the slot json. The credit goes through the same lint as a text (D-26). Any
 * problem goes to `errors` (paths under `image`) and nothing is returned.
 */
export function resolveImage(
  raw: unknown,
  kind: unknown,
  lookup: ImageLookup,
  mk: SlotIssue,
  errors: PlanIssue[],
): SlotImage | undefined {
  if (kind === 'poll') {
    errors.push(mk(['image'], 'image_not_allowed', 'a poll slot cannot carry an image'));
    return undefined;
  }
  const before = errors.length;
  const parsed = ImageRefSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      errors.push(mk(['image', ...(i.path as (string | number)[])], i.code, i.message));
    }
  }
  // The whole credit is linted: no signature line is cut out of it first.
  if (isObj(raw) && typeof raw.credit === 'string') {
    lintInto(raw.credit, ['image', 'credit'], mk, errors);
  }
  const meta = parsed.success ? lookup(parsed.data.sha256) : undefined;
  if (parsed.success && !meta) {
    errors.push(
      mk(
        ['image', 'sha256'],
        'unknown_image',
        `image "${parsed.data.sha256}" is not stored (upload it with POST /v1/images first)`,
      ),
    );
  }
  if (!parsed.success || !meta || errors.length > before) return undefined;
  return {
    sha256: meta.sha256,
    mime: meta.mime,
    width: meta.width,
    height: meta.height,
    credit: parsed.data.credit,
  };
}

/**
 * Validates `arc` and `slots` against plan.json v1 on top of `base`, checks every post ends with
 * a question, lints the texts (D-26), signs every text and checks the raw length after signing. Every problem is
 * collected (no short-circuit). On success returns the signed plan and its plan.md.
 *
 * Illustrations (WP-SVC-24): with `o.images` (the plan POST) a slot's `image: {sha256, credit}`
 * is checked and replaced by its stored form. Without it (the fallback) a slot never carries an
 * image: the key is dropped like any other key the schema does not know.
 *
 * Variants (WP-PLAT-01): with `o.variants` (the plan POST) a slot's `variants` are checked and
 * kept, and the plan becomes plan.json v2; an absent, `null` or empty `variants` means none.
 * Without it (the fallback) the key is dropped: the fallback writes Telegram only. A plan with
 * no variants is validated and returned exactly as plan.json v1.
 *
 * Variant gap (WP-PLAT-02): two variants of one platform closer than that platform's minimum
 * gap are an error `variant_gap` on the later one (`variantGapIssues`).
 *
 * Human timing (WP-SVC-25, D-33): a round `at` (seconds 00 or none, minutes on a quarter) is an
 * error `round_time`, for posts and polls alike. With `o.yesterday` (the HH:MM values of the
 * previous day's plan) a slot at one of those minutes yields a `same_time_as_yesterday` warning;
 * warnings do not block, are returned and are shown at the top of plan.md.
 */
export function finalizePlan(
  input: { arc: unknown; slots: unknown },
  base: PlanBase,
  o: { images?: ImageLookup; variants?: boolean; yesterday?: ReadonlySet<string> } = {},
): Finalized {
  const { arc } = input;
  const errors: PlanIssue[] = [];

  const slots = !Array.isArray(input.slots)
    ? input.slots
    : input.slots.map((raw: unknown, i) => {
        if (!isObj(raw)) return raw;
        const keep = o.variants && hasVariants(raw.variants);
        const s = 'variants' in raw && !keep ? omit(raw, 'variants') : raw;
        if (!('image' in s)) return s;
        const { image, ...rest } = s;
        if (image === undefined || image === null || !o.images) return rest;
        const mk: SlotIssue = (path, code, message) =>
          issue(['slots', i, ...path], code, message, input.slots);
        const stored = resolveImage(image, s.kind, o.images, mk, errors);
        return stored ? { ...rest, image: stored } : rest;
      });

  // One slot with variants makes the plan v2; without any it is v1, checked as it always was.
  const v2 = Array.isArray(slots) && slots.some((s: unknown) => isObj(s) && 'variants' in s);
  const parsed = v2
    ? PlanV2Schema.safeParse({ ...base, version: 2, arc, slots })
    : PlanV1Schema.safeParse({ ...base, arc, slots });
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      errors.push(issue(i.path as (string | number)[], issueCode(i), i.message, slots));
    }
  }

  // Text rules run on the raw slots too, so a schema error elsewhere does not hide them.
  const signed: (string | undefined)[] = [];
  const signedVariants: (string | undefined)[][] = [];
  if (Array.isArray(slots)) {
    slots.forEach((s: unknown, i) => {
      if (!isObj(s)) return;
      const mk: SlotIssue = (path, code, message) =>
        issue(['slots', i, ...path], code, message, slots);
      if (typeof s.at === 'string' && isRoundAt(s.at)) {
        errors.push(mk(['at'], 'round_time', ROUND_TIME_MESSAGE));
      }
      const text = slotTextRules(s, mk, errors);
      if (text !== undefined) signed[i] = text;
      if (!Array.isArray(s.variants)) return;
      signedVariants[i] = s.variants.map((v: unknown, m) =>
        isObj(v)
          ? variantTextRules(
              v,
              (path, code, message) => mk(['variants', m, ...path], code, message),
              errors,
            )
          : undefined,
      );
    });
  }

  // WP-PLAT-02: two variants of one platform closer than its minimum gap are refused here,
  // in the evening, instead of the second one waiting silently in the morning.
  for (const g of variantGapIssues(slots)) {
    errors.push(
      issue(['slots', g.slot, 'variants', g.variant, 'at'], VARIANT_GAP_CODE, g.message, slots),
    );
  }

  if (errors.length || !parsed.success) return { errors };
  const plan = parsed.data;
  plan.slots.forEach((s: PlanSlot | PlanSlotV2, i) => {
    s.text = signed[i] ?? signText(s.text);
    if (!('variants' in s)) return;
    s.variants?.forEach((v, m) => {
      v.text = signedVariants[i]?.[m] ?? signText(v.text);
    });
  });
  const warnings = timingWarnings(plan.slots, o.yesterday ?? new Set());
  return { plan, md: renderPlanMd(plan, warnings), warnings };
}

export type FinalizedSlot =
  { slot: PlanSlot; errors?: undefined } | { slot?: undefined; errors: PlanIssue[] };

/**
 * One slot through the same rules as `finalizePlan` (WP-SVC-22): the slot schema, lint, the
 * question rule, the signature by code and the length limit. Issue paths are relative to the slot
 * (`text`, `poll.options.0`) and carry `slotId`. Every problem is collected.
 *
 * `textRules: false` (WP-SVC-25: a PUT that changes only `at`, `eventDate` or the image) keeps the
 * stored, already signed text and checks the slot schema only, so moving a post in time never
 * fails on its old text.
 */
export function finalizeSlot(
  raw: Record<string, unknown>,
  slotId: string,
  o: { textRules?: boolean } = {},
): FinalizedSlot {
  const errors: PlanIssue[] = [];
  const mk: SlotIssue = (path, code, message) => ({
    path: path.join('.') || '(body)',
    slotId,
    code,
    message,
  });
  const parsed = SlotSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      errors.push(mk(i.path as (string | number)[], i.code, i.message));
    }
  }
  if (o.textRules === false) {
    return errors.length || !parsed.success ? { errors } : { slot: parsed.data };
  }
  const signed = slotTextRules(raw, mk, errors);
  if (errors.length || !parsed.success) return { errors };
  return { slot: { ...parsed.data, text: signed ?? signText(parsed.data.text) } };
}

/** Repair-prompt and log form of an issue: `path: message`. */
export function issueLine(i: PlanIssue): string {
  return `${i.path}: ${i.message}`;
}

/** Keys sorted at every level, so the hash does not depend on key order or whitespace. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The Telegram slot of a plan slot: the slot without its `variants`. This is what a slot row
 * holds, so the row of a slot is the same with and without variants, and the publisher's claim
 * (slot json unchanged) and the slot PUT never see them.
 */
export function telegramSlot(s: PlanSlot | PlanSlotV2): PlanSlot {
  if (!('variants' in s)) return s;
  const slot: PlanSlotV2 = { ...s };
  delete slot.variants;
  return slot;
}

/** The `slot_variants` rows of a plan: one per variant, `json` as it stands in the plan json. */
function variantRows(plan: PlanDoc): SlotVariantInput[] {
  return plan.slots.flatMap((s: PlanSlot | PlanSlotV2) =>
    ('variants' in s ? (s.variants ?? []) : []).map((v) => ({
      slotId: s.id,
      platform: v.platform,
      lang: v.lang,
      at: v.at,
      json: JSON.stringify(v),
    })),
  );
}

/**
 * Stores a finalized plan as `draft` with its slots and their variants, in one transaction. The
 * caller has decided that a draft may be written for this date (see `src/api/director.ts`,
 * `src/jobs/evening.ts`).
 */
export function saveDraft(
  store: Store,
  f: { plan: PlanDoc; md: string },
  inputSha256: string | null = null,
  /** Write time; the 23:00 job approves only drafts stored before 22:00 (P-7). */
  at: Date = new Date(),
): void {
  const { plan, md } = f;
  store.db.transaction(() => {
    store.plans.upsert(
      {
        date: plan.date,
        status: 'draft',
        json: JSON.stringify(plan),
        md,
        inputSha256,
      },
      at,
    );
    store.slots.replaceForPlan(
      plan.date,
      plan.slots.map((s: PlanSlot | PlanSlotV2) => ({
        slotId: s.id,
        at: s.at,
        kind: s.kind,
        json: JSON.stringify(telegramSlot(s)),
      })),
    );
    // Replacing the slots has removed the variants of the old ones (a variant row belongs to
    // its slot row), so a plan without variants (v1, the fallback) runs exactly the statements
    // it always ran. The variants of a v2 plan are written here, in the same transaction as the
    // plan: a stored plan and its variants never disagree.
    const variants = variantRows(plan);
    if (variants.length) store.slotVariants.replaceForPlan(plan.date, variants);
  })();
}
