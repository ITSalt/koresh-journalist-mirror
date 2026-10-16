import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { SIGNATURE_LINE, TEXT_MAX_RAW } from '../../src/plan/pipeline.js';
import { PlanV1Schema } from '../../src/plan/schema.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { DATE, validPlan } from '../plan/fixtures.js';

const TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date('2026-10-10T17:00:00Z'); // 20:00 MSK on the 10th

const open: Store[] = [];
function setup(clock: () => Date = () => NOW) {
  const store = openStore(':memory:');
  open.push(store);
  const app = buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: TOKEN }),
    store,
    logLevel: 'silent',
    now: clock,
  });
  return { app, store };
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

/** The body the director's subagent posts: plan.json v1 without version, date, sourceWindow. */
function body(over: Record<string, unknown> = {}) {
  const p = validPlan();
  return { arc: p.arc, slots: p.slots, sourceEntryIds: ['e1', 'e2'], ...over };
}

function seedFeed(app: ReturnType<typeof setup>['app']) {
  return app.inject({
    method: 'POST',
    url: '/v1/feed',
    headers: auth,
    payload: [
      { id: 'e1', at: '2026-10-08T22:02:00+03:00', source: 'observer/LOG.md', text: 'one' },
      { id: 'e2', at: '2026-10-08T22:38:00+03:00', source: 'STATUS-TABLE.md', text: 'two' },
    ],
  });
}

const post = (app: ReturnType<typeof setup>['app'], payload: unknown, date = DATE) =>
  app.inject({
    method: 'POST',
    url: `/v1/plans/${date}`,
    headers: auth,
    payload: payload as object,
  });

describe('POST /v1/plans/:date', () => {
  it('stores a valid plan as draft (201) with md, signed texts, slots and sourceWindow', async () => {
    const { app, store } = setup();
    expect((await seedFeed(app)).statusCode).toBe(200);
    const res = await post(app, body());
    expect(res.statusCode).toBe(201);
    const out = res.json();
    expect(out.status).toBe('draft');
    expect(out.date).toBe(DATE);
    expect(out.md).toContain('План Кореша на 11.10.2026');
    expect(out.md).toContain('Источники: записей 2, 08.10 22:02 – 08.10 22:38 МСК');

    const row = store.plans.get(DATE)!;
    expect(row.status).toBe('draft');
    expect(row.md).toBe(out.md);
    const plan = PlanV1Schema.parse(JSON.parse(row.json));
    expect(plan.version).toBe(1);
    expect(plan.sourceWindow).toEqual({
      from: '2026-10-08T22:02:00+03:00',
      to: '2026-10-08T22:38:00+03:00',
      entryIds: ['e1', 'e2'],
    });
    for (const s of plan.slots) {
      expect(s.text.endsWith(`\n\n${SIGNATURE_LINE}`)).toBe(true);
      expect(s.text.split(SIGNATURE_LINE)).toHaveLength(2);
    }
    expect(store.slots.listForPlan(DATE).map((s) => [s.slotId, s.kind, s.status])).toEqual([
      ['s1', 'post', 'planned'],
      ['s2', 'poll', 'planned'],
    ]);

    const md = await app.inject({ method: 'GET', url: `/v1/plans/${DATE}.md`, headers: auth });
    expect(md.headers['x-plan-status']).toBe('draft');
    expect(md.body).toBe(out.md);
  });

  it('accepts a plan without sourceEntryIds (empty window at the request time)', async () => {
    const { app, store } = setup();
    const b = body();
    delete (b as { sourceEntryIds?: unknown }).sourceEntryIds;
    expect((await post(app, b)).statusCode).toBe(201);
    expect(JSON.parse(store.plans.get(DATE)!.json).sourceWindow).toEqual({
      from: NOW.toISOString(),
      to: NOW.toISOString(),
      entryIds: [],
    });
  });

  it('422 for a post without a question at the end, naming the slot', async () => {
    const { app, store } = setup();
    await seedFeed(app);
    const p = validPlan();
    p.slots[0]!.text = 'Новости от Корпорации всевластия\n\nВопросов нет.';
    const res = await post(app, body({ slots: p.slots }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      errors: [
        {
          path: 'slots.0.text',
          slotId: 's1',
          code: 'no_question',
          message: expect.stringMatching(/question/),
        },
      ],
    });
    expect(store.plans.get(DATE)).toBeUndefined();
  });

  it('422 lists every fault at once', async () => {
    const { app } = setup();
    await seedFeed(app);
    const p = validPlan();
    p.slots[0]!.text = 'Без вопроса. https://example.org/?a=1';
    delete (p.slots[1] as { poll?: unknown }).poll;
    const long = {
      ...validPlan().slots[0]!,
      id: 's3',
      at: '2026-10-12T21:03:11+03:00',
      text: 'а'.repeat(TEXT_MAX_RAW) + '\n❓ Вопрос?',
    };
    const res = await post(app, {
      arc: { title: 'Дело' },
      slots: [...p.slots, long],
      sourceEntryIds: ['e1', 'nope', 7],
      version: 1,
    });
    expect(res.statusCode).toBe(422);
    const errs = (res.json().errors as { path: string; slotId?: string; code: string }[]).map(
      (e) => `${e.path}|${e.slotId ?? ''}|${e.code}`,
    );
    expect(errs).toEqual(
      expect.arrayContaining([
        'version||unrecognized_key',
        'sourceEntryIds.1||unknown_entry',
        'sourceEntryIds.2||invalid_type',
        'arc.beat||invalid_type',
        'slots.0.text|s1|no_question',
        'slots.1.poll|s2|custom',
        'slots.2.at|s3|custom',
        'slots.2.text|s3|too_long',
      ]),
    );
    expect(errs).toHaveLength(8);
  });

  it(`${TEXT_MAX_RAW} raw limit holds after signing`, async () => {
    const { app } = setup();
    const tail = '\n\n❓ Вопрос?';
    const room = TEXT_MAX_RAW - `\n\n${SIGNATURE_LINE}`.length - tail.length;
    const p = validPlan();
    p.slots[0]!.text = 'а'.repeat(room + 1) + tail;
    const bad = await post(app, body({ slots: p.slots, sourceEntryIds: undefined }));
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0]).toMatchObject({ code: 'too_long', slotId: 's1' });
    p.slots[0]!.text = 'а'.repeat(room) + tail;
    expect((await post(app, body({ slots: p.slots, sourceEntryIds: undefined }))).statusCode).toBe(
      201,
    );
  });

  it('refuses unknown feed entry ids; a private entry is never stored, so it is unknown', async () => {
    const { app } = setup();
    const feed = await app.inject({
      method: 'POST',
      url: '/v1/feed',
      headers: auth,
      payload: [{ id: 'p1', at: NOW.toISOString(), source: 'dm', text: 'SECRET', private: true }],
    });
    expect(feed.statusCode).toBe(422);
    const res = await post(app, body({ sourceEntryIds: ['p1'] }));
    expect(res.statusCode).toBe(422);
    expect(res.json().errors).toEqual([expect.objectContaining({ code: 'unknown_entry' })]);
    expect(res.body).not.toContain('SECRET');
  });

  it('the same body again is a 200 and changes nothing (key order does not matter)', async () => {
    const { app, store } = setup();
    await seedFeed(app);
    const first = await post(app, body());
    expect(first.statusCode).toBe(201);
    const before = store.plans.get(DATE)!;
    const slotsBefore = store.slots.listForPlan(DATE);
    store.slots.setStatus(DATE, 's1', 'skipped'); // a replace would reset this to planned

    const b = body();
    const reordered = { sourceEntryIds: b.sourceEntryIds, slots: b.slots, arc: b.arc };
    const again = await post(app, reordered);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(store.plans.get(DATE)).toEqual(before);
    expect(store.slots.listForPlan(DATE).map((s) => s.status)).toEqual(['skipped', 'planned']);
    expect(slotsBefore).toHaveLength(2);
  });

  it('a different body over a draft replaces it, slots included', async () => {
    const { app, store } = setup();
    await seedFeed(app);
    await post(app, body());
    const p = validPlan();
    const one = [{ ...p.slots[0]!, id: 'only', text: 'Другой текст.\n❓ А теперь?' }];
    const res = await post(app, body({ slots: one, arc: { title: 'Дело №2', beat: 'прогрев' } }));
    expect(res.statusCode).toBe(201);
    expect(res.json().md).toContain('Дело №2');
    expect(store.slots.listForPlan(DATE).map((s) => s.slotId)).toEqual(['only']);
    expect(JSON.parse(store.plans.get(DATE)!.json).arc.title).toBe('Дело №2');
  });

  it('any POST over approved or rejected is a 409 and changes nothing', async () => {
    for (const status of ['approved', 'rejected'] as const) {
      const { app, store } = setup();
      await seedFeed(app);
      await post(app, body());
      store.plans.setStatus(DATE, status);
      const before = store.plans.get(DATE)!;
      for (const b of [body(), body({ arc: { title: 'Новое', beat: 'x' } }), { junk: 1 }]) {
        const res = await post(app, b);
        expect(res.statusCode).toBe(409);
        expect(res.json().status).toBe(status);
      }
      expect(store.plans.get(DATE)).toEqual(before);
    }
  });

  it('a POST over a failed plan replaces it', async () => {
    const { app, store } = setup();
    store.plans.upsert({ date: DATE, status: 'failed', json: '{}', md: 'failed' });
    const res = await post(app, body({ sourceEntryIds: undefined }));
    expect(res.statusCode).toBe(201);
    expect(store.plans.get(DATE)?.status).toBe('draft');
  });

  it('review I-2: a plan for today or a past date is a 422 date_not_future', async () => {
    const { app, store } = setup();
    for (const d of ['2026-10-10', '2026-10-09', '2025-01-01']) {
      const p = validPlan(d);
      const res = await post(app, { arc: p.arc, slots: p.slots }, d);
      expect(res.statusCode).toBe(422);
      expect(res.json().errors).toEqual([expect.objectContaining({ code: 'date_not_future' })]);
      expect(store.plans.get(d)).toBeUndefined();
    }
  });

  it('P-7: the plan for tomorrow is accepted until 22:00 MSK, then 409 too_late', async () => {
    let now = new Date('2026-10-10T21:59:59+03:00');
    const { app, store } = setup(() => now);
    expect((await post(app, body({ sourceEntryIds: undefined }))).statusCode).toBe(201);
    now = new Date('2026-10-10T22:00:00+03:00');
    const late = await post(
      app,
      body({ sourceEntryIds: undefined, arc: { title: 'x', beat: 'y' } }),
    );
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe('too_late');
    expect(JSON.parse(store.plans.get(DATE)!.json).arc.title).not.toBe('x');
    // A later day is still open at 22:00.
    const p = validPlan('2026-10-12');
    expect((await post(app, { arc: p.arc, slots: p.slots }, '2026-10-12')).statusCode).toBe(201);
    expect(store.plans.get('2026-10-12')?.updatedAt).toBe(now.toISOString());
  });

  it('validates the date and the body shape', async () => {
    const { app } = setup();
    expect((await post(app, body(), '2026-13-01')).statusCode).toBe(400);
    const arr = await post(app, []);
    expect(arr.statusCode).toBe(422);
    expect(arr.json().errors[0].path).toBe('(body)');
  });

  it('needs the bearer token', async () => {
    const { app, store } = setup();
    const res = await app.inject({ method: 'POST', url: `/v1/plans/${DATE}`, payload: body() });
    expect(res.statusCode).toBe(401);
    expect(store.plans.get(DATE)).toBeUndefined();
  });
});

describe('GET /v1/alerts', () => {
  it('lists alerts after `since`, needs the token, validates since', async () => {
    const { app, store } = setup();
    store.alerts.add({ kind: 'no_plan', message: 'a' }, new Date('2026-10-10T18:00:00Z'));
    store.alerts.add({ kind: 'llm_cap', message: 'b' }, new Date('2026-10-10T19:00:00Z'));
    const get = (url: string, headers: object = auth) =>
      app.inject({ method: 'GET', url, headers: headers as Record<string, string> });

    const all = await get('/v1/alerts');
    expect(all.statusCode).toBe(200);
    expect(all.json().alerts.map((a: { kind: string }) => a.kind)).toEqual(['no_plan', 'llm_cap']);
    const since = await get('/v1/alerts?since=2026-10-10T21:00:00%2B03:00');
    expect(since.json().alerts.map((a: { kind: string }) => a.kind)).toEqual(['llm_cap']);
    expect((await get('/v1/alerts?since=yesterday')).statusCode).toBe(400);
    expect((await get('/v1/alerts', {})).statusCode).toBe(401);
  });
});
