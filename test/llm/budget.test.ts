import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardedCall } from '../../src/llm/budget.js';
import { openStore, type Store } from '../../src/store/index.js';

const now = new Date('2026-10-10T16:00:00Z'); // 19:00 MSK
const DAY = '2026-10-10';
const open: Store[] = [];
function mk(): Store {
  const s = openStore(':memory:');
  open.push(s);
  return s;
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

describe('guardedCall', () => {
  it('books the estimate, calls, then records the actual cost', async () => {
    const store = mk();
    let during = -1;
    const r = await guardedCall({ store, capUsd: 1, estimateUsd: 0.1, now }, async () => {
      during = store.spend.forDay(DAY);
      return { costUsd: 0.034, value: 'x' };
    });
    expect(during).toBeCloseTo(0.1);
    expect(r).toEqual({ ok: true, result: { costUsd: 0.034, value: 'x' }, costUsd: 0.034 });
    expect(store.spend.forDay(DAY)).toBeCloseTo(0.034);
  });

  it('over the cap: no call, reason cap, an alert row, spend unchanged', async () => {
    const store = mk();
    store.spend.add(0.95, now);
    const call = vi.fn();
    const r = await guardedCall({ store, capUsd: 1, estimateUsd: 0.1, now }, call);
    expect(r).toEqual({ ok: false, reason: 'cap', costUsd: 0 });
    expect(call).not.toHaveBeenCalled();
    expect(store.spend.forDay(DAY)).toBeCloseTo(0.95);
    const alerts = store.alerts.list();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe('llm_cap');
    expect(alerts[0]!.message).toMatch(/0\.95.*0\.1.*1/);
  });

  it('allows exactly reaching the cap', async () => {
    const store = mk();
    store.spend.add(0.9, now);
    const r = await guardedCall({ store, capUsd: 1, estimateUsd: 0.1, now }, async () => ({
      costUsd: 0.1,
    }));
    expect(r.ok).toBe(true);
  });

  it('fails closed when no cap is configured', async () => {
    const store = mk();
    const call = vi.fn();
    const r = await guardedCall({ store, capUsd: undefined, estimateUsd: 0.1, now }, call);
    expect(r).toMatchObject({ ok: false, reason: 'cap' });
    expect(call).not.toHaveBeenCalled();
    expect(store.alerts.list()[0]!.message).toMatch(/LLM_DAILY_CAP_USD/);
  });

  it('keeps the estimate when the cost is unknown or the call throws', async () => {
    const store = mk();
    const r = await guardedCall({ store, capUsd: 1, estimateUsd: 0.1, now }, async () => ({
      costUsd: undefined,
    }));
    expect(r).toMatchObject({ ok: true, costUsd: 0.1 });
    await expect(
      guardedCall({ store, capUsd: 1, estimateUsd: 0.1, now }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(store.spend.forDay(DAY)).toBeCloseTo(0.2);
  });
});
