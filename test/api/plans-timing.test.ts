import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { DATE, validPlan } from '../plan/fixtures.js';

// WP-SVC-25: POST /v1/plans/:date refuses round times (422 round_time) and returns a warning,
// not an error, for a slot at a minute of yesterday's plan.

const TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date('2026-10-10T17:00:00Z'); // 20:00 MSK on the 10th
const YESTERDAY = '2026-10-10';

const open: Store[] = [];
function setup() {
  const store = openStore(':memory:');
  open.push(store);
  const app = buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: TOKEN }),
    store,
    logLevel: 'silent',
    now: () => NOW,
  });
  return { app, store };
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

/** Plan POST body with one post slot per time (HH:MM[:SS]); s1 is a post, a poll keeps its kind. */
function body(...times: string[]) {
  const p = validPlan();
  const slots = times.map((t, i) => ({
    ...p.slots[0]!,
    id: `s${i + 1}`,
    at: `${DATE}T${t}+03:00`,
  }));
  return { arc: p.arc, slots };
}
const post = (app: ReturnType<typeof setup>['app'], payload: unknown) =>
  app.inject({
    method: 'POST',
    url: `/v1/plans/${DATE}`,
    headers: auth,
    payload: payload as object,
  });

function seedYesterday(
  store: Store,
  status: 'draft' | 'approved' | 'rejected' | 'failed',
  ...t: string[]
) {
  store.plans.upsert({ date: YESTERDAY, status: 'draft', json: '{}', md: '' });
  store.slots.replaceForPlan(
    YESTERDAY,
    t.map((x, i) => ({ slotId: `y${i}`, at: `${YESTERDAY}T${x}+03:00`, kind: 'post', json: '{}' })),
  );
  if (status !== 'draft') store.plans.setStatus(YESTERDAY, status);
}

describe('POST /v1/plans/:date: round_time', () => {
  it.each(['19:00:00', '19:00', '09:15:00', '12:30', '18:45:00'])(
    '%s: 422 round_time naming the slot, nothing stored',
    async (t) => {
      const { app, store } = setup();
      const res = await post(app, body('08:12:41', t));
      expect(res.statusCode).toBe(422);
      expect(res.json().errors).toEqual([
        {
          path: 'slots.1.at',
          slotId: 's2',
          code: 'round_time',
          message: expect.stringContaining('round time') as string,
        },
      ]);
      expect(store.plans.get(DATE)).toBeUndefined();
      expect(store.slots.listForPlan(DATE)).toEqual([]);
    },
  );

  it.each(['19:00:07', '19:07', '12:03:00', '19:09:53'])('%s is stored', async (t) => {
    const { app, store } = setup();
    const res = await post(app, body(t));
    expect(res.statusCode, res.body).toBe(201);
    expect(store.slots.listForPlan(DATE)[0]!.at).toBe(`${DATE}T${t}+03:00`);
  });

  it('a poll slot is checked too', async () => {
    const { app } = setup();
    const p = validPlan();
    const res = await post(app, {
      arc: p.arc,
      slots: [{ ...p.slots[1]!, at: `${DATE}T19:00:00+03:00` }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors).toMatchObject([
      { path: 'slots.0.at', slotId: 's2', code: 'round_time' },
    ]);
  });
});

describe('POST /v1/plans/:date: same_time_as_yesterday', () => {
  it('yesterday had 19:09, today 19:09:41: stored with one warning, shown at the top of plan.md', async () => {
    const { app, store } = setup();
    seedYesterday(store, 'approved', '09:07:30', '19:09:12');
    const res = await post(app, body('08:12:41', '19:09:41'));
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json();
    expect(out.warnings).toEqual([
      {
        path: 'slots.1.at',
        slotId: 's2',
        code: 'same_time_as_yesterday',
        message: expect.stringContaining('19:09') as string,
      },
    ]);
    expect(out.md).toContain('Предупреждения');
    expect(out.md.indexOf('Предупреждения')).toBeLessThan(out.md.indexOf('## 08:12 МСК'));
    expect(store.plans.get(DATE)!.md).toBe(out.md);
    expect(store.plans.get(DATE)!.status).toBe('draft');
    expect(store.slots.listForPlan(DATE)).toHaveLength(2);
  });

  it('the same body again is a 200 with the same warnings', async () => {
    const { app, store } = setup();
    seedYesterday(store, 'draft', '19:09:12');
    const first = await post(app, body('19:09:41'));
    const again = await post(app, body('19:09:41'));
    expect(again.statusCode).toBe(200);
    expect(again.json().warnings).toEqual(first.json().warnings);
    expect(again.json().warnings).toHaveLength(1);
    expect(again.json().md).toBe(first.json().md);
  });

  it('no match, no yesterday, a failed yesterday: warnings is an empty array', async () => {
    const a = setup();
    const none = await post(a.app, body('19:09:41'));
    expect(none.statusCode).toBe(201);
    expect(none.json().warnings).toEqual([]);
    expect(none.json().md).not.toContain('Предупреждения');

    const b = setup();
    seedYesterday(b.store, 'approved', '19:08:59');
    expect((await post(b.app, body('19:09:41'))).json().warnings).toEqual([]);

    const c = setup();
    seedYesterday(c.store, 'failed', '19:09:12');
    expect((await post(c.app, body('19:09:41'))).json().warnings).toEqual([]);
  });

  it('the day before yesterday does not count, a rejected yesterday does', async () => {
    const a = setup();
    a.store.plans.upsert({ date: '2026-10-09', status: 'approved', json: '{}', md: '' });
    a.store.slots.replaceForPlan('2026-10-09', [
      { slotId: 'y', at: '2026-10-09T19:09:12+03:00', kind: 'post', json: '{}' },
    ]);
    expect((await post(a.app, body('19:09:41'))).json().warnings).toEqual([]);

    const b = setup();
    seedYesterday(b.store, 'rejected', '19:09:12');
    expect((await post(b.app, body('19:09:41'))).json().warnings).toHaveLength(1);
  });

  it('a round time is still an error when yesterday matched', async () => {
    const { app, store } = setup();
    seedYesterday(store, 'approved', '19:00:00');
    const res = await post(app, body('19:00:00'));
    expect(res.statusCode).toBe(422);
    expect(res.json().errors.map((e: { code: string }) => e.code)).toEqual(['round_time']);
  });
});
