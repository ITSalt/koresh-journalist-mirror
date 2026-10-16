import { z } from 'zod';
import { textHash } from '../lib/idempotency.js';
import type { PlanStatus, SlotStatus, Store } from '../store/index.js';
import {
  finalizeSlot,
  resolveImage,
  sha256Hex,
  type PlanIssue,
  type SlotIssue,
} from './pipeline.js';
import { sameInstant } from '../lib/msk-instant.js';
import { cleanText } from './intake-texts.js';
import { renderPlanMd } from './render.js';
import { MSK_AT_RE, type PlanDoc } from './schema.js';
import { isRoundAt, ROUND_TIME_MESSAGE, timingWarnings, yesterdayTimes } from './timing.js';

// PUT /v1/plans/:date/slots/:slotId (WP-SVC-22): the text of one slot of an approved plan is
// replaced before the slot starts. For an owner-requested edit after approval only (P-10).
//
// Allowed while the plan is `approved`, the slot is `planned` with no publication row of any
// status, and the slot is at least 10 minutes away. The new text goes through the same rules as
// a plan POST (`finalizeSlot`). The slot keeps its id, at, platform, kind and eventDate; the plan
// stays `approved`; no other slot is written. The checks and the writes are one IMMEDIATE
// transaction, and the publisher writes its intent only while the slot still holds the json it
// read (`IntentInput.expectSlotJson`), so a slot never goes out as a mix of the two texts.
//
// WP-SVC-24: the body may also carry `image`: `{sha256, credit}` sets or replaces the slot's
// illustration, `null` removes it, an absent key keeps what is stored. The image lives inside the
// slot json, so the same guards and the same claim cover it: a slot never goes out as the old
// image with the new text or the other way round.
//
// WP-PLAT-01: the variants of the slot (plan.json v2) are not part of the slot row and cannot be
// sent here (`variants` is an unknown key). They stay in the plan json, in `slot_variants` and
// in plan.md exactly as approved.
//
// WP-SVC-25 (D-33): the body may also carry `at` and `eventDate`. `at` moves the slot in time: it
// must be on the plan date with +03:00, at least 10 minutes after now, not a round time, and
// different from every other slot's time. The `at` column (what the scheduler reads), the slot
// json (what the claim compares), the plan json (kept sorted by `at`) and plan.md are written in
// the same IMMEDIATE transaction, so the publisher sends the slot once, at the old or at the new
// time. `text` may be absent when `at`, `eventDate`, `poll` or `image` is sent; the stored text
// then stays untouched and is not checked again.

/** The slot must be at least this far away. */
export const REPLACE_MIN_LEAD_MS = 10 * 60_000;
export const REPLACE_BODY_KEYS = ['text', 'poll', 'image', 'at', 'eventDate', 'reason'] as const;
/** At least one of these must be sent; `reason` always is. */
const CHANGE_KEYS = ['text', 'poll', 'at', 'eventDate', 'image'] as const;
export const REASON_MAX = 1000;

const reasonSchema = z.string().trim().min(1).max(REASON_MAX);

/** What the route logs once: the only copy of the old slot besides its hashes in the alert. */
export interface ReplaceAudit {
  reason: string;
  oldSlotJson: string;
  oldSlotSha256: string;
  newSlotSha256: string;
  oldTextSha256: string;
  newTextSha256: string;
  /** Which of text, poll, image, at, eventDate differ from the stored slot. */
  fields: string[];
}

export type ReplaceResult =
  | { kind: 'no_plan' }
  | { kind: 'no_slot' }
  | { kind: 'not_approved'; status: PlanStatus }
  | { kind: 'slot_started'; slotStatus: SlotStatus; publications: number }
  | { kind: 'too_close'; at: string }
  | { kind: 'invalid'; errors: PlanIssue[] }
  /** The stored slot already equals the result: nothing written, no alert. */
  | { kind: 'unchanged'; md: string }
  | { kind: 'replaced'; md: string; audit: ReplaceAudit };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** sha256 of a stored slot's image, or `none`. */
const imageOf = (slot: Record<string, unknown>) =>
  isObj(slot.image) && typeof slot.image.sha256 === 'string' ? slot.image.sha256 : 'none';

/** Which of the editable parts of the slot differ between the stored slot and the result. */
function changedFields(old: Record<string, unknown>, slot: Record<string, unknown>): string[] {
  const differs = (k: string) => JSON.stringify(old[k]) !== JSON.stringify(slot[k]);
  return ['text', 'poll', 'image', 'at', 'eventDate'].filter(differs);
}

/** Body keys and the reason; the text and the poll are checked by `finalizeSlot`. */
function bodyIssues(body: Record<string, unknown>, slotId: string): PlanIssue[] {
  const errors: PlanIssue[] = [];
  for (const k of Object.keys(body)) {
    if (!(REPLACE_BODY_KEYS as readonly string[]).includes(k)) {
      errors.push({
        path: k,
        slotId,
        code: 'unrecognized_key',
        message: `unknown key "${k}"; only text, poll, image, at, eventDate and reason can be sent, the slot keeps its id, platform and kind`,
      });
    }
  }
  const reason = reasonSchema.safeParse(body.reason);
  if (!reason.success) {
    for (const i of reason.error.issues) {
      errors.push({ path: 'reason', slotId, code: i.code, message: `reason: ${i.message}` });
    }
  }
  if (CHANGE_KEYS.every((k) => body[k] === undefined)) {
    errors.push({
      path: 'text',
      slotId,
      code: 'invalid_type',
      message: 'send at least one of text, poll, at, eventDate, image',
    });
  }
  return errors;
}

/**
 * The rules of a new `at` (WP-SVC-25), on top of the slot schema: the plan date, 10 minutes of
 * lead, no round time, no other slot at the same instant. A value that is not a well-formed
 * string is left to the schema. The same instant as the stored one is no move: nothing is checked.
 */
function atIssues(
  at: unknown,
  o: { date: string; slotId: string; oldAt: string; others: string[]; now: Date },
): PlanIssue[] {
  if (typeof at !== 'string' || !MSK_AT_RE.test(at)) return [];
  const t = Date.parse(at);
  // J-T1: two spellings of one instant are the same time.
  if (Number.isNaN(t) || sameInstant(at, o.oldAt)) return [];
  const mk = (code: string, message: string): PlanIssue => ({
    path: 'at',
    slotId: o.slotId,
    code,
    message,
  });
  const errors: PlanIssue[] = [];
  if (at.slice(0, 10) !== o.date) {
    errors.push(mk('at_not_on_plan_date', `at must be on the plan date ${o.date}`));
  }
  if (!(t - o.now.getTime() >= REPLACE_MIN_LEAD_MS)) {
    errors.push(
      mk('at_too_soon', `at must be at least ${REPLACE_MIN_LEAD_MS / 60_000} minutes from now`),
    );
  }
  if (isRoundAt(at)) errors.push(mk('round_time', ROUND_TIME_MESSAGE));
  if (o.others.some((other) => Date.parse(other) === t)) {
    errors.push(mk('at_not_unique', 'another slot of the plan goes out at that time'));
  }
  return errors;
}

/**
 * Replaces the text (and, for a poll slot, optionally the poll; for a post, optionally the
 * image) of one slot. Synchronous: the whole decision and every write happen inside one
 * IMMEDIATE transaction on `store`.
 */
export function replaceSlot(
  store: Store,
  date: string,
  slotId: string,
  body: unknown,
  now: Date,
): ReplaceResult {
  return store.db
    .transaction((): ReplaceResult => {
      const plan = store.plans.get(date);
      if (!plan) return { kind: 'no_plan' };
      const row = store.slots.listForPlan(date).find((s) => s.slotId === slotId);
      if (!row) return { kind: 'no_slot' };
      if (plan.status !== 'approved') return { kind: 'not_approved', status: plan.status };
      // Any Telegram publication row counts, whatever its status: the publisher has touched the
      // slot. Rows of the slot's variants on other platforms (WP-PLAT-02) are not this text.
      const publications = store.publications.listForSlot(date, slotId, 'telegram').length;
      if (row.status !== 'planned' || publications > 0) {
        return { kind: 'slot_started', slotStatus: row.status, publications };
      }
      const lead = Date.parse(row.at) - now.getTime();
      if (!(lead >= REPLACE_MIN_LEAD_MS)) return { kind: 'too_close', at: row.at };

      if (!isObj(body)) {
        return {
          kind: 'invalid',
          errors: [
            {
              path: '(body)',
              slotId,
              code: 'invalid_type',
              message: 'the body must be a JSON object { text, poll?, image?, reason }',
            },
          ],
        };
      }
      const old = JSON.parse(row.json) as Record<string, unknown>;
      const errors = bodyIssues(body, slotId);
      if (body.poll !== undefined && old.kind !== 'poll') {
        errors.push({
          path: 'poll',
          slotId,
          code: 'poll_not_allowed',
          message: 'the slot is a post and its kind cannot change; send text only',
        });
      }
      const candidate: Record<string, unknown> = { ...old };
      if (typeof body.text === 'string') {
        // J-N1: the text is cleaned as at plan intake; a lone surrogate is refused.
        const t = cleanText(body.text, 'text', slotId);
        if (t.ok) candidate.text = t.text;
        else errors.push(t.error);
      } else if (body.text !== undefined) candidate.text = body.text;
      if (old.kind === 'poll' && body.poll !== undefined) candidate.poll = body.poll;
      if (body.at !== undefined) candidate.at = body.at;
      if (body.eventDate !== undefined) candidate.eventDate = body.eventDate;
      errors.push(
        ...atIssues(body.at, {
          date,
          slotId,
          oldAt: row.at,
          others: store.slots
            .listForPlan(date)
            .filter((s) => s.slotId !== slotId)
            .map((s) => s.at),
          now,
        }),
      );
      if (body.image === null) delete candidate.image;
      else if (body.image !== undefined) {
        const mk: SlotIssue = (path, code, message) => ({
          path: path.join('.'),
          slotId,
          code,
          message,
        });
        const lookup = (sha256: string) => store.images.meta(sha256);
        const image = resolveImage(body.image, old.kind, lookup, mk, errors);
        if (image) candidate.image = image;
      }
      const f = finalizeSlot(candidate, slotId, {
        textRules: body.text !== undefined || body.poll !== undefined,
      });
      if (f.errors) errors.push(...f.errors);
      if (errors.length || !f.slot) return { kind: 'invalid', errors };

      // J-T1: the same instant in another spelling is no move. The slot keeps its stored `at`,
      // so the comparison below (and the claim of the publisher) sees the slot unchanged.
      if (sameInstant(f.slot.at, old.at)) f.slot.at = old.at as string;
      const json = JSON.stringify(f.slot);
      if (json === row.json) return { kind: 'unchanged', md: plan.md };

      const doc = JSON.parse(plan.json) as PlanDoc;
      const i = doc.slots.findIndex((s) => s.id === slotId);
      if (i < 0) throw new Error(`plan "${date}": plan.json has no slot "${slotId}"`);
      // The slot keeps the variants it was approved with (v2); a v1 slot has none.
      const variants = doc.version === 2 ? doc.slots[i]?.variants : undefined;
      doc.slots[i] = variants ? { ...f.slot, variants } : f.slot;
      // plan.json keeps its slots sorted by `at`; a moved slot may change places.
      doc.slots.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const warnings = timingWarnings(doc.slots, yesterdayTimes(store, date));
      const md = renderPlanMd(doc, warnings);

      const audit: ReplaceAudit = {
        reason: reasonSchema.parse(body.reason),
        oldSlotJson: row.json,
        oldSlotSha256: sha256Hex(row.json),
        newSlotSha256: sha256Hex(json),
        oldTextSha256: textHash(typeof old.text === 'string' ? old.text : ''),
        newTextSha256: textHash(f.slot.text),
        fields: changedFields(old, f.slot),
      };
      store.slots.setJson(date, slotId, json, f.slot.at === row.at ? undefined : f.slot.at);
      store.plans.setContent(date, { json: JSON.stringify(doc), md }, now);
      store.alerts.add(
        {
          kind: 'slot_replaced',
          message:
            `slot ${date}/${slotId} replaced after approval; ` +
            `text sha256 ${audit.oldTextSha256} -> ${audit.newTextSha256}; ` +
            `slot json sha256 ${audit.oldSlotSha256} -> ${audit.newSlotSha256}; ` +
            `changed: ${audit.fields.join(', ')}; ` +
            // Times are not secrets: the move itself is what the director must be able to audit.
            (f.slot.at !== old.at ? `at ${String(old.at)} -> ${f.slot.at}; ` : '') +
            (f.slot.eventDate !== old.eventDate
              ? `eventDate ${String(old.eventDate)} -> ${f.slot.eventDate}; `
              : '') +
            // Only when an illustration is involved: other replacements keep their old wording.
            (old.image || f.slot.image
              ? `image sha256 ${imageOf(old)} -> ${f.slot.image?.sha256 ?? 'none'}; `
              : '') +
            `reason: ${audit.reason}`,
        },
        now,
      );
      return { kind: 'replaced', md, audit };
    })
    .immediate();
}
