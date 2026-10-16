import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { bearerOf, tokenMatches } from '../../src/api/auth.js';

const TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const DAY = '2026-10-10';

const open: Store[] = [];
function setup(extra: { logStream?: { write(l: string): void }; auth?: object } = {}) {
  const store = openStore(':memory:');
  open.push(store);
  const app = buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: TOKEN, TELEGRAM_BOT_TOKEN: 'fake-telegram-token' }),
    store,
    logLevel: extra.logStream ? 'info' : 'silent',
    ...extra,
  });
  return { app, store };
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

function seedPlan(store: Store, status: 'draft' | 'approved' = 'approved') {
  store.plans.upsert({ date: DAY, status, json: '{"slots":2}', md: '# Plan\n\ntext' });
  store.slots.replaceForPlan(DAY, [
    { slotId: 's1', at: '2026-10-10T06:00:00Z', kind: 'post', json: '{}' },
    { slotId: 's2', at: '2026-10-10T10:00:00Z', kind: 'post', json: '{}' },
    { slotId: 's3', at: '2026-10-10T15:00:00Z', kind: 'post', json: '{}' },
  ]);
}

const entry = (over: object = {}) => ({
  id: 'e1',
  at: '2026-10-08T10:00:00+03:00',
  source: 'observer/LOG.md',
  text: 'First line\nsecond line',
  ...over,
});

describe('auth helpers', () => {
  it('compares tokens', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abd')).toBe(false);
    expect(tokenMatches('abc', 'abcd')).toBe(false);
  });
  it('parses the bearer header', () => {
    expect(bearerOf('Bearer xyz')).toBe('xyz');
    expect(bearerOf('Basic xyz')).toBeUndefined();
    expect(bearerOf(undefined)).toBeUndefined();
  });
});

describe('bearer auth', () => {
  const routes: [string, string][] = [
    ['POST', '/v1/feed'],
    ['GET', `/v1/plans/${DAY}`],
    ['GET', `/v1/plans/${DAY}.md`],
    ['POST', `/v1/plans/${DAY}/reject`],
    ['POST', '/v1/feedback'],
    ['GET', `/v1/publications?date=${DAY}`],
    ['POST', `/v1/plans/${DAY}`],
    ['GET', '/v1/alerts'],
  ];
  it.each(routes)('%s %s is 401 without a token and with a wrong one', async (method, url) => {
    const { app } = setup();
    const none = await app.inject({ method: method as 'GET', url });
    expect(none.statusCode).toBe(401);
    const wrong = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('fails closed when no token is configured', async () => {
    const store = openStore(':memory:');
    open.push(store);
    const app = buildServer({ config: loadConfig({}), store, logLevel: 'silent' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/publications?date=${DAY}`,
      headers: { authorization: 'Bearer ' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('locks out failing clients, lets a correct token through, recovers after the window', async () => {
    let t = 1_000_000;
    const { app } = setup({ auth: { maxFailures: 3, windowMs: 60_000, now: () => t } });
    const url = `/v1/publications?date=${DAY}`;
    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
    const blocked = await app.inject({ method: 'GET', url });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // a correct token bypasses the lock, and does not clear it
    expect((await app.inject({ method: 'GET', url, headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(429);
    t += 61_000;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('refuses before the body is parsed: oversized or malformed bodies are 401', async () => {
    const { app } = setup();
    const big = await app.inject({
      method: 'POST',
      url: '/v1/feed',
      payload: [entry({ text: 'x'.repeat(2_500_000) })],
    });
    expect(big.statusCode).toBe(401);
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/feed',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(401);
  });

  it('never writes the token to the logs', async () => {
    const lines: string[] = [];
    const { app } = setup({ logStream: { write: (l) => void lines.push(l) } });
    await app.inject({ method: 'GET', url: `/v1/publications?date=${DAY}`, headers: auth });
    await app.inject({
      method: 'GET',
      url: `/v1/publications?date=${DAY}`,
      headers: { authorization: `Bearer ${TOKEN}x` },
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).not.toContain(TOKEN);
  });
});

describe('POST /v1/feed', () => {
  it('upserts by id and maps fields to the store', async () => {
    const { app, store } = setup();
    const post = (body: unknown) =>
      app.inject({ method: 'POST', url: '/v1/feed', headers: auth, payload: body as object });
    const r1 = await post([entry(), entry({ id: 'e2', title: 'Given title' })]);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ stored: 2 });
    const r2 = await post([entry({ text: 'Changed\nbody' })]);
    expect(r2.statusCode).toBe(200);
    const rows = store.feedEntries.recent(10);
    expect(rows).toHaveLength(2);
    const e1 = rows.find((r) => r.id === 'e1');
    expect(e1).toMatchObject({
      source: 'observer/LOG.md',
      title: 'Changed',
      summary: 'Changed\nbody',
      publishedAt: '2026-10-08T10:00:00+03:00',
    });
    expect(rows.find((r) => r.id === 'e2')?.title).toBe('Given title');
  });

  it('refuses private entries with 422 and stores nothing of the batch', async () => {
    const { app, store } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/feed',
      headers: auth,
      payload: [entry(), entry({ id: 'p1', private: true })],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().ids).toEqual(['p1']);
    expect(store.feedEntries.recent(10)).toHaveLength(0);
  });

  it('accepts private: false', async () => {
    const { app, store } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/feed',
      headers: auth,
      payload: [entry({ private: false })],
    });
    expect(res.statusCode).toBe(200);
    expect(store.feedEntries.recent(10)).toHaveLength(1);
  });

  it('rejects malformed bodies with 400', async () => {
    const { app } = setup();
    for (const payload of [{ id: 'x' }, [entry({ at: 'yesterday' })], [entry({ text: '  ' })]]) {
      const res = await app.inject({ method: 'POST', url: '/v1/feed', headers: auth, payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('enforces a 2 MB payload limit (1.5 MB passes, 2.5 MB is 413)', async () => {
    const { app } = setup();
    const big = (n: number) => [entry({ text: 'x'.repeat(n) })];
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/feed',
      headers: auth,
      payload: big(1_500_000),
    });
    expect(ok.statusCode).toBe(200);
    const tooBig = await app.inject({
      method: 'POST',
      url: '/v1/feed',
      headers: auth,
      payload: big(2_500_000),
    });
    expect(tooBig.statusCode).toBe(413);
  });
});

describe('GET /v1/plans/:date[.md]', () => {
  it('returns the plan as json and as markdown', async () => {
    const { app, store } = setup();
    seedPlan(store);
    const j = await app.inject({ method: 'GET', url: `/v1/plans/${DAY}`, headers: auth });
    expect(j.statusCode).toBe(200);
    expect(j.json()).toMatchObject({
      date: DAY,
      status: 'approved',
      plan: { slots: 2 },
      slots: [{ slotId: 's1' }, { slotId: 's2' }, { slotId: 's3' }],
    });
    const md = await app.inject({ method: 'GET', url: `/v1/plans/${DAY}.md`, headers: auth });
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.headers['x-plan-status']).toBe('approved');
    expect(md.body).toBe('# Plan\n\ntext');
  });

  it('404 for a missing plan, 400 for a bad date', async () => {
    const { app } = setup();
    expect(
      (await app.inject({ method: 'GET', url: '/v1/plans/2026-01-01', headers: auth })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/plans/2026-02-31.md', headers: auth }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/plans/nope', headers: auth })).statusCode,
    ).toBe(400);
  });
});

describe('POST /v1/plans/:date/reject', () => {
  const reject = (
    app: ReturnType<typeof setup>['app'],
    payload: unknown = { reason: 'off topic' },
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/plans/${DAY}/reject`,
      headers: auth,
      payload: payload as object,
    });

  it('before any send: marks the plan rejected, skips slots, records the reason', async () => {
    const { app, store } = setup();
    seedPlan(store);
    const res = await reject(app);
    expect(res.statusCode).toBe(200);
    expect(store.plans.get(DAY)?.status).toBe('rejected');
    expect(store.slots.listForPlan(DAY).map((s) => s.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(store.feedback.listForPlan(DAY)).toMatchObject([
      { verdict: 'dislike', note: 'rejected: off topic' },
    ]);
    // idempotent: second call is 200 and adds no feedback
    expect((await reject(app)).statusCode).toBe(200);
    expect(store.feedback.listForPlan(DAY)).toHaveLength(1);
  });

  it('after one sent slot: 409 and the remaining slots are skipped', async () => {
    const { app, store } = setup();
    seedPlan(store);
    store.publications.beginIntent({
      key: 'k1',
      platform: 'telegram',
      planDate: DAY,
      slotId: 's1',
      textSha256: 'a'.repeat(64),
    });
    store.publications.markSent('k1', '42');
    store.slots.setStatus(DAY, 's1', 'done');
    const res = await reject(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().skipped).toEqual(['s2', 's3']);
    expect(store.slots.listForPlan(DAY).map((s) => s.status)).toEqual([
      'done',
      'skipped',
      'skipped',
    ]);
    expect(store.plans.get(DAY)?.status).toBe('approved');
  });

  it('a done slot with only a dry publication is not started: reject is 200', async () => {
    const { app, store } = setup();
    seedPlan(store);
    store.publications.beginIntent({
      key: 'k1',
      platform: 'telegram',
      planDate: DAY,
      slotId: 's1',
      textSha256: 'a'.repeat(64),
    });
    store.db.prepare("UPDATE publications SET status = 'dry' WHERE key = 'k1'").run();
    store.slots.setStatus(DAY, 's1', 'done');
    const res = await reject(app);
    expect(res.statusCode).toBe(200);
    expect(store.plans.get(DAY)?.status).toBe('rejected');
    expect(store.slots.listForPlan(DAY).map((s) => s.status)).toEqual([
      'done',
      'skipped',
      'skipped',
    ]);
  });

  it('an unresolved intent counts as started', async () => {
    const { app, store } = setup();
    seedPlan(store);
    store.publications.beginIntent({
      key: 'k1',
      platform: 'telegram',
      planDate: DAY,
      slotId: 's1',
      textSha256: 'a'.repeat(64),
    });
    expect((await reject(app)).statusCode).toBe(409);
  });

  it('validates the reason and the plan', async () => {
    const { app, store } = setup();
    expect((await reject(app)).statusCode).toBe(404);
    seedPlan(store);
    expect((await reject(app, {})).statusCode).toBe(400);
    expect((await reject(app, { reason: '  ' })).statusCode).toBe(400);
    expect(store.plans.get(DAY)?.status).toBe('approved');
  });

  it('a re-posted draft does not undo a reject (store guard)', async () => {
    const { app, store } = setup();
    seedPlan(store);
    await reject(app);
    const again = store.plans.upsert({ date: DAY, status: 'draft', json: '{}', md: 'new' });
    expect(again.status).toBe('rejected');
    expect(again.md).toBe('new');
  });
});

describe('POST /v1/feedback', () => {
  const post = (app: ReturnType<typeof setup>['app'], payload: unknown) =>
    app.inject({ method: 'POST', url: '/v1/feedback', headers: auth, payload: payload as object });

  it('stores feedback for a plan and for a slot', async () => {
    const { app, store } = setup();
    seedPlan(store);
    const a = await post(app, { planDate: DAY, verdict: 'like', note: 'good' });
    expect(a.statusCode).toBe(201);
    const b = await post(app, { planDate: DAY, slotId: 's2', verdict: 'dislike' });
    expect(b.statusCode).toBe(201);
    expect(store.feedback.listForPlan(DAY)).toMatchObject([
      { verdict: 'like', note: 'good', slotId: null },
      { verdict: 'dislike', slotId: 's2' },
    ]);
  });

  it('validates input and references', async () => {
    const { app, store } = setup();
    seedPlan(store);
    expect((await post(app, { planDate: DAY, verdict: 'meh' })).statusCode).toBe(400);
    expect((await post(app, { planDate: 'x', verdict: 'like' })).statusCode).toBe(400);
    expect((await post(app, { planDate: '2026-01-01', verdict: 'like' })).statusCode).toBe(404);
    expect((await post(app, { planDate: DAY, slotId: 'zz', verdict: 'like' })).statusCode).toBe(
      404,
    );
  });
});

describe('GET /v1/publications', () => {
  it('lists publications of the day and validates the date', async () => {
    const { app, store } = setup();
    seedPlan(store);
    store.publications.beginIntent({
      key: 'k1',
      platform: 'telegram',
      planDate: DAY,
      slotId: 's1',
      textSha256: 'a'.repeat(64),
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/publications?date=${DAY}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().publications).toMatchObject([{ key: 'k1', status: 'intent' }]);
    for (const url of ['/v1/publications', '/v1/publications?date=bad']) {
      expect((await app.inject({ method: 'GET', url, headers: auth })).statusCode).toBe(400);
    }
  });
});
