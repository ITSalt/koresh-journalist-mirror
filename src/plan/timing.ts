import type { Store } from '../store/index.js';

// Human timing (WP-SVC-25, D-33): round publication times read as a robot. One pure rule for the
// plan intake (POST and the fallback, via `finalizePlan`) and for the slot PUT.

/** A slot's `at` is round when its seconds are `00` (or absent) and its minutes are on a quarter. */
const ROUND_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:(?:00|15|30|45)(?::00)?(?:\+03:00)?$/;

export const ROUND_TIME_MESSAGE =
  'a round time reads as a robot: pick a time inside the reading window that is not on a quarter ' +
  'of the hour (:00, :15, :30, :45) or give it seconds, e.g. 19:07:34';

/** True for `…T19:00`, `…T19:00:00`, `…T09:15:00+03:00`; false for `…T19:00:07`, `…T19:07`. */
export function isRoundAt(at: string): boolean {
  return ROUND_AT_RE.test(at);
}

/** `HH:MM` of an `at` string (`YYYY-MM-DDTHH:MM[:SS]+03:00`). */
export const hhmmOf = (at: string): string => at.slice(11, 16);

export const SAME_TIME_CODE = 'same_time_as_yesterday';

/** A non-blocking finding returned with the stored draft and shown at the top of plan.md. */
export interface PlanWarning {
  /** Dotted path in the submitted body, e.g. `slots.0.at`. */
  path: string;
  slotId?: string;
  code: typeof SAME_TIME_CODE;
  message: string;
}

/** The calendar day before `date` (YYYY-MM-DD). */
export function previousDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * The `HH:MM` values of the previous day's stored plan; empty when there is none or it failed.
 * A draft or a rejected plan counts: the director chose those times.
 */
export function yesterdayTimes(store: Store, date: string): Set<string> {
  // One read of the slot rows (the `at` column is what the publisher follows, and a PUT moves it).
  const rows = store.db
    .prepare(
      `SELECT s.at AS at FROM slots s JOIN plans p ON p.date = s.plan_date
       WHERE s.plan_date = ? AND p.status <> 'failed'`,
    )
    .all(previousDay(date)) as { at: string }[];
  return new Set(rows.map((r) => hhmmOf(r.at)));
}

/** `same_time_as_yesterday` for every slot whose HH:MM equals one of yesterday's. */
export function timingWarnings(
  slots: readonly { id: string; at: string }[],
  yesterday: ReadonlySet<string>,
): PlanWarning[] {
  const out: PlanWarning[] = [];
  slots.forEach((s, i) => {
    if (typeof s.at !== 'string' || !yesterday.has(hhmmOf(s.at))) return;
    out.push({
      path: `slots.${i}.at`,
      slotId: s.id,
      code: SAME_TIME_CODE,
      message: `slot ${s.id} goes out at ${hhmmOf(s.at)}, the same minute as a slot of yesterday's plan; pick another time`,
    });
  });
  return out;
}
