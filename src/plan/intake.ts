import { beforeEveningOf, localClock, POST_DEADLINE } from '../lib/clock.js';
import type { PlanStatus, Store } from '../store/index.js';
import {
  canonicalJson,
  finalizePlan,
  saveDraft,
  sha256Hex,
  sourceWindowOf,
  type PlanIssue,
} from './pipeline.js';
import { cleanSlotTexts } from './intake-texts.js';
import { timingWarnings, yesterdayTimes, type PlanWarning } from './timing.js';

// POST /v1/plans/:date: the director's subagent is the primary author of the plan (D-14).
// The body is plan.json v1 without version, date and sourceWindow; the server fills those and
// runs the shared pipeline (`finalizePlan` -> `saveDraft`), the same one the fallback uses.
// A slot may carry `variants` (plan.json v2, WP-PLAT-01); the stored plan is then `version: 2`.
// The idempotency hash is taken over the whole body, so it covers the variants.
// J-N1: every slot and variant text is cleaned first (`cleanSlotTexts`: LF line ends, NFC); the
// cleaned body is what is hashed, checked, measured, stored and later sent. A lone surrogate is
// refused (`bad_text`, HTTP 400) with the slot, the variant and the index.

export const BODY_KEYS = ['arc', 'slots', 'sourceEntryIds'] as const;
export const SOURCE_IDS_MAX = 5000;

/** Plan statuses a POST (or the fallback) may never overwrite. */
export const LOCKED: ReadonlySet<PlanStatus> = new Set(['approved', 'rejected']);

export type IntakeResult =
  | { kind: 'too_late'; deadline: string }
  | { kind: 'stored'; status: 'draft'; md: string; warnings: PlanWarning[] }
  | { kind: 'unchanged'; status: 'draft'; md: string; warnings: PlanWarning[] }
  | { kind: 'invalid'; errors: PlanIssue[] }
  /** J-N1: a text with a lone surrogate; nothing else was checked or stored. */
  | { kind: 'bad_text'; errors: PlanIssue[] }
  | { kind: 'locked'; status: PlanStatus };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Reads `sourceEntryIds` and looks the entries up in the stored feed; collects issues. */
function sourceEntries(store: Store, raw: unknown, errors: PlanIssue[]) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > SOURCE_IDS_MAX) {
    errors.push({
      path: 'sourceEntryIds',
      code: 'invalid_type',
      message: `sourceEntryIds must be an array of up to ${SOURCE_IDS_MAX} feed entry ids`,
    });
    return [];
  }
  const ids: string[] = [];
  raw.forEach((id: unknown, i) => {
    if (typeof id !== 'string' || !id) {
      errors.push({
        path: `sourceEntryIds.${i}`,
        code: 'invalid_type',
        message: 'an entry id must be a non-empty string',
      });
    } else if (!ids.includes(id)) ids.push(id);
  });
  const found = new Map(store.feedEntries.getMany(ids).map((e) => [e.id, e]));
  raw.forEach((id: unknown, i) => {
    // Private entries are never stored, so they are unknown here too. Only the id is echoed.
    if (typeof id === 'string' && id && !found.has(id)) {
      errors.push({
        path: `sourceEntryIds.${i}`,
        code: 'unknown_entry',
        message: `feed entry "${id}" is not in the stored feed (push it with POST /v1/feed first)`,
      });
    }
  });
  return ids
    .filter((id) => found.has(id))
    .map((id) => {
      const e = found.get(id)!;
      return { id, at: e.publishedAt ?? e.fetchedAt };
    });
}

/**
 * Validates and stores a plan for `date` posted by the director. Idempotent on (date, sha256 of
 * the canonical body): the same body over the stored draft changes nothing.
 */
export function submitPlan(
  store: Store,
  date: string,
  body: unknown,
  now: Date,
  tz: string,
): IntakeResult {
  // Only a future day can be planned: no job would ever approve a plan for today (review I-2).
  if (date <= localClock(now, tz).date) {
    return {
      kind: 'invalid',
      errors: [
        {
          path: 'date',
          code: 'date_not_future',
          message: `the plan date ${date} must be after today (${tz})`,
        },
      ],
    };
  }
  // P-7: the plan for tomorrow is accepted until 22:00 on the evening before.
  if (!beforeEveningOf(now, date, POST_DEADLINE, tz)) {
    return { kind: 'too_late', deadline: POST_DEADLINE };
  }
  const existing = store.plans.get(date);
  if (existing && LOCKED.has(existing.status)) return { kind: 'locked', status: existing.status };

  // J-N1: the texts as they will be stored; the hash, the checks and the store see only these.
  const cleaned = isObj(body) ? cleanSlotTexts(body.slots) : undefined;
  if (cleaned?.errors.length) return { kind: 'bad_text', errors: cleaned.errors };
  if (cleaned && isObj(body) && cleaned.slots !== body.slots) {
    body = { ...body, slots: cleaned.slots };
  }
  const hash = sha256Hex(canonicalJson(body));
  if (existing?.status === 'draft' && existing.inputSha256 === hash) {
    // Same body: the stored draft is returned as it is; its warnings are read off its slots.
    const slots = store.slots.listForPlan(date).map((r) => ({ id: r.slotId, at: r.at }));
    const warnings = timingWarnings(slots, yesterdayTimes(store, date));
    return { kind: 'unchanged', status: 'draft', md: existing.md, warnings };
  }

  const errors: PlanIssue[] = [];
  if (!isObj(body)) {
    return {
      kind: 'invalid',
      errors: [
        {
          path: '(body)',
          code: 'invalid_type',
          message: 'the body must be a JSON object { arc, slots, sourceEntryIds? }',
        },
      ],
    };
  }
  for (const k of Object.keys(body)) {
    if (!(BODY_KEYS as readonly string[]).includes(k)) {
      errors.push({
        path: k,
        code: 'unrecognized_key',
        message: `unknown key "${k}"; the server fills version, date and sourceWindow`,
      });
    }
  }
  const entries = sourceEntries(store, body.sourceEntryIds, errors);
  const f = finalizePlan(
    { arc: body.arc, slots: body.slots },
    { version: 1, date, sourceWindow: sourceWindowOf(entries, now) },
    {
      // WP-SVC-24: a slot's `image: {sha256, credit}` must name an uploaded image.
      images: (sha256) => store.images.meta(sha256),
      // WP-PLAT-01: a slot's `variants` are accepted here (and only here).
      variants: true,
      // WP-SVC-25: a slot at the minute of one of yesterday's slots gets a warning.
      yesterday: yesterdayTimes(store, date),
    },
  );
  if (f.errors) errors.push(...f.errors);
  if (errors.length || !f.plan) return { kind: 'invalid', errors };

  const plan = f.plan;
  const md = f.md;
  const warnings = f.warnings;
  // Re-checked under the write lock: the 23:00 job or a reject may have run meanwhile.
  return store.db
    .transaction((): IntakeResult => {
      const cur = store.plans.get(date);
      if (cur && LOCKED.has(cur.status)) return { kind: 'locked', status: cur.status };
      saveDraft(store, { plan, md }, hash, now);
      return { kind: 'stored', status: 'draft', md, warnings };
    })
    .immediate();
}
