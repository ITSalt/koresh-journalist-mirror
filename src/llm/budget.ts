import type { Store } from '../store/index.js';

// Daily LLM spend cap that fails closed (D-7).
//
// SQLite cannot hold a transaction open across an HTTP call, so the check is a reservation:
// one IMMEDIATE transaction checks spent(today MSK) + estimate <= cap and books the estimate;
// after the call the estimate is replaced by the actual `usage.cost`. When the actual cost is
// unknown (no usage.cost, error, timeout) the estimate stays booked: the cap errs on the safe side.

export interface BudgetOptions {
  store: Store;
  /** LLM_DAILY_CAP_USD; undefined means no cap is configured, and then nothing is spent. */
  capUsd: number | undefined;
  /** LLM_ESTIMATE_USD. */
  estimateUsd: number;
  /** The MSK day of this instant is the spend day. */
  now: Date;
}

export type Guarded<T> =
  { ok: true; result: T; costUsd: number } | { ok: false; reason: 'cap'; costUsd: 0 };

export async function guardedCall<T extends { costUsd: number | undefined }>(
  opts: BudgetOptions,
  call: () => Promise<T>,
): Promise<Guarded<T>> {
  const { store, capUsd, estimateUsd, now } = opts;
  if (capUsd === undefined) {
    store.alerts.add(
      { kind: 'llm_cap', message: 'LLM call refused: LLM_DAILY_CAP_USD is not set' },
      now,
    );
    return { ok: false, reason: 'cap', costUsd: 0 };
  }
  const r = store.spend.reserve(estimateUsd, capUsd, now);
  if (!r.ok) {
    store.alerts.add(
      {
        kind: 'llm_cap',
        message: `LLM call refused on ${r.day}: spent ${r.spent} + estimate ${estimateUsd} > cap ${capUsd} USD`,
      },
      now,
    );
    return { ok: false, reason: 'cap', costUsd: 0 };
  }
  const result = await call(); // on a throw the estimate stays booked
  if (result.costUsd === undefined) return { ok: true, result, costUsd: estimateUsd };
  store.spend.settle(r.day, estimateUsd, result.costUsd);
  return { ok: true, result, costUsd: result.costUsd };
}
