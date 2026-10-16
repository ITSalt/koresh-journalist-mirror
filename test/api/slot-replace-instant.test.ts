import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { saveDraft, signText } from '../../src/plan/pipeline.js';
import type { PlanSlot } from '../../src/plan/schema.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { validPlan } from '../plan/fixtures.js';

// J-T1 wired into the slot PUT: the "no change" decision compares the slot's instant
// (`sameInstant`), not the stored spelling of `at`. '2026-10-15T18:52+03:00' and
// '2026-10-15T18:52:00+03:00' are the same slot time: no move, no alert, nothing written.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const DAY = '2026-10-15';
const SHORT = '2026-10-15T18:52+03:00';
const LONG = '2026-10-15T18:52:00+03:00';
const TEXT = 'Вечер. Кто сегодня закрыл задачу молча?';

let store: Store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => store.close());

function seed(at: string) {
  const plan = validPlan(DAY);
  const base = plan.slots[0]!;
  plan.slots = [
    { ...base, id: 's1', at: `${DAY}T09:07:21+03:00`, text: signText('Утро. Кто первый?') },
    { ...base, id: 's2', at, kind: 'post', text: signText(TEXT) } as PlanSlot,
  ];
  saveDraft(store, { plan, md: '' }, null, new Date('2026-10-14T17:00:00Z'));
  store.plans.setStatus(DAY, 'approved');
}
const app = () =>
  buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: API_TOKEN }),
    store,
    logLevel: 'silent',
    now: () => new Date('2026-10-15T08:00:00+03:00'),
  });
const put = (payload: Record<string, unknown>) =>
  app().inject({
    method: 'PUT',
    url: `/v1/plans/${DAY}/slots/s2`,
    headers: auth,
    payload: { reason: 'owner asked', ...payload },
  });
const row = () => store.slots.listForPlan(DAY).find((s) => s.slotId === 's2')!;
const snapshot = () => ({
  row: row(),
  plan: store.plans.get(DAY)!.json,
  alerts: store.alerts.list(),
});

describe('slot PUT: two spellings of one instant are the same slot', () => {
  it.each([
    [LONG, SHORT],
    [SHORT, LONG],
  ])('stored %s, sent %s: unchanged, nothing written, no alert', async (stored, sent) => {
    seed(stored);
    const before = snapshot();
    const res = await put({ at: sent });
    expect(res.statusCode).toBe(200);
    expect(snapshot()).toEqual(before);
    expect(row().at).toBe(stored);
    expect(JSON.parse(row().json).at).toBe(stored);
  });

  it('the same text and the same instant in the other spelling: unchanged', async () => {
    seed(LONG);
    const before = snapshot();
    const res = await put({ at: SHORT, text: TEXT });
    expect(res.statusCode).toBe(200);
    expect(snapshot()).toEqual(before);
  });

  it('a new text with the time respelled: the text is replaced, the time is not touched', async () => {
    seed(LONG);
    const res = await put({ at: SHORT, text: 'Вечер. Правка владельца: кто закрыл задачу?' });
    expect(res.statusCode).toBe(200);
    expect(row().at).toBe(LONG);
    expect(JSON.parse(row().json).at).toBe(LONG);
    const [alert] = store.alerts.list();
    expect(alert!.kind).toBe('slot_replaced');
    expect(alert!.message).toContain('changed: text;');
    expect(alert!.message).not.toMatch(/at 2026-10-15T18:52/);
  });

  it('another instant is still a move', async () => {
    seed(LONG);
    const res = await put({ at: '2026-10-15T18:53+03:00' });
    expect(res.statusCode).toBe(200);
    expect(row().at).toBe('2026-10-15T18:53+03:00');
    expect(store.alerts.list()[0]!.message).toContain(`at ${LONG} -> 2026-10-15T18:53+03:00;`);
  });
});
