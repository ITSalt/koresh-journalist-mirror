import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { textHash } from '../../src/lib/idempotency.js';
import { sha256Hex, SIGNATURE_LINE, signText } from '../../src/plan/pipeline.js';
import { REPLACE_MIN_LEAD_MS } from '../../src/plan/replace.js';
import { PlanV1Schema, type PlanSlot } from '../../src/plan/schema.js';
import { createPublisher } from '../../src/publish/publisher.js';
import { buildServer } from '../../src/server.js';
import { openStore, type PlanStatus, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { CHANNEL, DATE, msk, seedPlan, TOKEN as BOT_TOKEN } from '../publish/helpers.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';

// WP-SVC-22: PUT /v1/plans/:date/slots/:slotId replaces the text of one not-yet-started slot of
// an approved plan. Everything else of the day stays as it was.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const OLD_S1 = 'Утро. Кто первый?';
const OLD_S2 = 'Вечер, старый текст. Что думаете?';
const NEW_S2 = 'Вечер, правка владельца. Кто согласен?';
const POLL = {
  question: 'Почему партии одинаковые?',
  options: ['ИИ ленится', 'так задумано'],
  allowsMultiple: false,
};

let dir: string;
let store: Store;
let t: Date;
let lines: string[];
let fake: FakeBotApi | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jrn-replace-'));
  store = openStore(join(dir, 'journalist.db'));
  t = msk('08:00');
  lines = [];
});
afterEach(async () => {
  store.close();
  await fake?.stop();
  fake = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function server() {
  return buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: API_TOKEN }),
    store,
    logLevel: 'info',
    logStream: { write: (l) => void lines.push(l) },
    now: () => t,
  });
}

const TWO_SLOTS = [
  { id: 's1', at: '09:00', text: OLD_S1 },
  { id: 's2', at: '19:00', text: OLD_S2 },
];
const seed = (status: PlanStatus = 'approved') => seedPlan(store, TWO_SLOTS, { status });

const put = (payload: unknown, slotId = 's2', headers: Record<string, string> = auth) =>
  server().inject({
    method: 'PUT',
    url: `/v1/plans/${DATE}/slots/${slotId}`,
    headers,
    payload: payload as object,
  });
const body = (over: Record<string, unknown> = {}) => ({
  text: NEW_S2,
  reason: 'owner edit 23:45',
  ...over,
});

const slotRow = (id: string) => store.slots.listForPlan(DATE).find((s) => s.slotId === id)!;
const planJson = () => PlanV1Schema.parse(JSON.parse(store.plans.get(DATE)!.json));
const rawPlanSlots = () =>
  (JSON.parse(store.plans.get(DATE)!.json) as { slots: unknown[] }).slots.map((s) =>
    JSON.stringify(s),
  );
/** Everything a replacement of s2 must leave alone, as one string. */
const untouched = () =>
  JSON.stringify({
    s1: slotRow('s1'),
    s1InPlan: rawPlanSlots()[0],
    pubs: store.publications.listForPlan(DATE),
    feedback: store.feedback.listForPlan(DATE),
  });
const dayRows = () =>
  JSON.stringify([
    store.plans.get(DATE),
    store.slots.listForPlan(DATE),
    store.publications.listForPlan(DATE),
    store.alerts.list(),
  ]);
const replacedAlerts = () => store.alerts.list().filter((a) => a.kind === 'slot_replaced');
const logged = () =>
  lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.msg === 'slot replaced');
const codesOf = (res: { json(): { errors: { code: string }[] } }) =>
  res.json().errors.map((e) => e.code);

async function publisher(target: Store = store) {
  fake ??= await new FakeBotApi(BOT_TOKEN).start();
  return createPublisher({
    store: target,
    blocks,
    api: createBotApi({ token: BOT_TOKEN, baseUrl: fake.baseUrl, timeoutMs: 500 }),
    channel: CHANNEL,
    dryRun: false,
    tz: 'Europe/Moscow',
    now: () => t,
    sleep: async () => undefined,
  });
}

function addPub(slotId: string, status: 'intent' | 'sent' | 'unknown' | 'dry' | 'failed') {
  const key = `telegram:${DATE}:${slotId}:0`;
  store.publications.beginIntent({
    key,
    platform: 'telegram',
    planDate: DATE,
    slotId,
    textSha256: 'a'.repeat(64),
  });
  if (status === 'sent') store.publications.markSent(key, '42');
  if (status === 'unknown') store.publications.markUnknown(key, 'timeout');
  if (status === 'dry') store.publications.markDry(key);
  if (status === 'failed') store.publications.markFailed(key, 'boom');
}

describe('PUT /v1/plans/:date/slots/:slotId', () => {
  it('replaces s2: 200, plan stays approved, s1 byte-identical, md shows the new s2', async () => {
    seed();
    const before = untouched();
    const oldS2 = slotRow('s2');
    const res = await put(body());
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json();
    expect(out).toMatchObject({ date: DATE, slotId: 's2', status: 'approved' });
    expect(Object.keys(out).sort()).toEqual(['date', 'md', 'slotId', 'status']);

    const plan = store.plans.get(DATE)!;
    expect(plan.status).toBe('approved');
    expect(plan.md).toBe(out.md);
    expect(out.md).toContain(NEW_S2);
    expect(out.md).not.toContain('старый текст');
    expect(out.md).toContain(OLD_S1);
    expect(plan.updatedAt).toBe(t.toISOString());
    expect(untouched()).toBe(before);

    const s2 = slotRow('s2');
    const stored = JSON.parse(s2.json) as PlanSlot;
    expect(stored.text).toBe(signText(NEW_S2));
    expect({ ...stored, text: '' }).toEqual({ ...(JSON.parse(oldS2.json) as PlanSlot), text: '' });
    expect([s2.at, s2.kind, s2.status]).toEqual([oldS2.at, oldS2.kind, 'planned']);
    // plan.json and the slot row hold the same slot
    expect(rawPlanSlots()[1]).toBe(s2.json);
    expect(planJson().slots.map((s) => s.id)).toEqual(['s1', 's2']);

    const md = await server().inject({ method: 'GET', url: `/v1/plans/${DATE}.md`, headers: auth });
    expect(md.headers['x-plan-status']).toBe('approved');
    expect(md.body).toBe(out.md);
  });

  it('writes one slot_replaced alert (reason, sha256 only) and logs the old slot once', async () => {
    seed();
    const oldJson = slotRow('s2').json;
    expect((await put(body())).statusCode).toBe(200);
    const alerts = replacedAlerts();
    expect(alerts).toHaveLength(1);
    const msg = alerts[0]!.message;
    expect(alerts[0]!.at).toBe(t.toISOString());
    expect(msg).toContain(`${DATE}/s2`);
    expect(msg).toContain('owner edit 23:45');
    expect(msg).toContain(textHash(signText(OLD_S2)));
    expect(msg).toContain(textHash(signText(NEW_S2)));
    expect(msg).toContain(sha256Hex(oldJson));
    expect(msg).not.toContain('старый текст');
    expect(msg).not.toContain('правка владельца');

    const log = logged();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      level: 30,
      date: DATE,
      slotId: 's2',
      oldSlotJson: oldJson,
      oldTextSha256: textHash(signText(OLD_S2)),
      newTextSha256: textHash(signText(NEW_S2)),
    });
  });

  it('signs by code: a signature in the body is replaced, never doubled', async () => {
    seed();
    const ok = await put(body({ text: `${NEW_S2}\n\n${SIGNATURE_LINE}` }));
    expect(ok.statusCode, ok.body).toBe(200);
    const text = (JSON.parse(slotRow('s2').json) as PlanSlot).text;
    expect(text).toBe(signText(NEW_S2));
    expect(text.split(SIGNATURE_LINE)).toHaveLength(2);
  });

  it('the same body again changes nothing and adds no second alert', async () => {
    seed();
    const first = await put(body());
    const rows = dayRows();
    t = msk('08:30');
    const again = await put(body());
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(dayRows()).toBe(rows);
    expect(replacedAlerts()).toHaveLength(1);
    expect(logged()).toHaveLength(1);
  });

  it('then the publisher sends s1 with the old text hash and s2 with the new text', async () => {
    // Control day: the same plan with no replacement.
    const control = openStore(join(dir, 'control.db'));
    try {
      seedPlan(control, TWO_SLOTS);
      t = msk('09:00:30');
      await (await publisher(control)).runOnce();
      t = msk('19:00:30');
      await (await publisher(control)).runOnce();
      const want = control.publications.listForPlan(DATE).map((p) => p.textSha256);
      expect(want).toHaveLength(2);
      const controlTexts = fake!.channel.splice(0).map((m) => m.text);

      seed();
      t = msk('08:00');
      expect((await put(body())).statusCode).toBe(200);
      const p = await publisher();
      t = msk('09:00:30');
      expect(await p.runOnce()).toMatchObject({ slot: 's1', result: 'sent' });
      t = msk('19:00:30');
      expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });

      const pubs = store.publications.listForPlan(DATE);
      expect(pubs.map((x) => [x.slotId, x.status])).toEqual([
        ['s1', 'sent'],
        ['s2', 'sent'],
      ]);
      expect(pubs[0]!.textSha256).toBe(want[0]);
      expect(pubs[1]!.textSha256).not.toBe(want[1]);
      const texts = fake!.channel.map((m) => m.text ?? '');
      expect(texts).toHaveLength(2);
      expect(texts[0]).toBe(controlTexts[0]);
      expect(texts[1]).toContain('правка владельца');
      expect(texts[1]).not.toContain('старый текст');
      expect(controlTexts[1]).toContain('старый текст');
    } finally {
      control.close();
    }
  });

  it('after s1 is out: s1 and its publication row stay byte-identical, s2 goes out new', async () => {
    seed();
    const p = await publisher();
    t = msk('09:00:30');
    expect(await p.runOnce()).toMatchObject({ slot: 's1', result: 'sent' });
    const before = untouched();
    expect(store.publications.listForPlan(DATE)).toHaveLength(1);
    expect(slotRow('s1').status).toBe('done');

    t = msk('18:49:59');
    expect((await put(body())).statusCode).toBe(200);
    expect(untouched()).toBe(before);
    expect(store.plans.get(DATE)!.status).toBe('approved');

    t = msk('19:00:30');
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    const texts = fake!.channel.map((m) => m.text ?? '');
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('Утро');
    expect(texts[1]).toContain('правка владельца');
    expect(texts.join('\n')).not.toContain('старый текст');
  });

  it('a poll slot keeps its kind; poll may be replaced too, or kept when absent', async () => {
    seedPlan(store, [
      { id: 's1', at: '09:00', text: OLD_S1 },
      { id: 's2', at: '19:00', kind: 'poll', text: 'Опрос к делу.', poll: POLL },
    ]);
    const keep = await put({ text: 'Новый опрос к делу.', reason: 'owner' });
    expect(keep.statusCode, keep.body).toBe(200); // polls are exempt from the question rule
    let s = JSON.parse(slotRow('s2').json) as PlanSlot;
    expect([s.kind, s.poll, s.text]).toEqual(['poll', POLL, signText('Новый опрос к делу.')]);

    const poll = { ...POLL, question: 'Кто прав?', options: ['я', 'не я', 'никто'] };
    const swap = await put({ text: 'Новый опрос к делу.', poll, reason: 'owner' });
    expect(swap.statusCode, swap.body).toBe(200);
    s = JSON.parse(slotRow('s2').json) as PlanSlot;
    expect([s.kind, s.poll]).toEqual(['poll', poll]);
    expect(store.plans.get(DATE)!.md).toContain('Кто прав?');
    expect(slotRow('s2').kind).toBe('poll');
    expect(replacedAlerts()).toHaveLength(2);

    const bad = await put({
      text: 'Опрос.',
      poll: { ...poll, options: ['один — два', 'x'] },
      reason: 'o',
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors).toMatchObject([
      { path: 'poll.options.0', slotId: 's2', code: 'em_dash' },
    ]);
    const one = await put({ text: 'Опрос.', poll: { ...poll, options: ['один'] }, reason: 'o' });
    expect(one.statusCode).toBe(422);
    expect(one.json().errors[0]).toMatchObject({ path: 'poll.options', slotId: 's2' });
    expect(replacedAlerts()).toHaveLength(2);
  });

  it('a post slot cannot become a poll, and id, kind are not accepted', async () => {
    seed();
    const before = dayRows();
    const res = await put(body({ poll: POLL }));
    expect(res.statusCode).toBe(422);
    expect(res.json().errors).toMatchObject([
      { path: 'poll', slotId: 's2', code: 'poll_not_allowed' },
    ]);
    const kind = await put(body({ kind: 'poll', platform: 'telegram', id: 'x' }));
    expect(kind.statusCode).toBe(422);
    expect(codesOf(kind)).toEqual(['unrecognized_key', 'unrecognized_key', 'unrecognized_key']);
    expect(dayRows()).toBe(before);
  });
});

describe('PUT slot: refusals', () => {
  /** Runs `fn` and checks that no row of the day and no alert changed, and nothing was logged. */
  const unchanged = async (fn: () => Promise<void>) => {
    const before = dayRows();
    await fn();
    expect(dayRows()).toBe(before);
    expect(logged()).toHaveLength(0);
  };

  it.each(['draft', 'rejected', 'failed'] as const)('%s plan: 409 not_approved', async (status) => {
    seed(status);
    await unchanged(async () => {
      const res = await put(body());
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'not_approved', status });
    });
  });

  it.each(['done', 'skipped'] as const)('slot %s: 409 slot_started', async (status) => {
    seed();
    store.slots.setStatus(DATE, 's2', status);
    await unchanged(async () => {
      const res = await put(body());
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'slot_started' });
    });
  });

  it.each(['intent', 'sent', 'unknown', 'dry', 'failed'] as const)(
    'planned slot with a %s publication row: 409 slot_started',
    async (status) => {
      seed();
      addPub('s2', status);
      expect(slotRow('s2').status).toBe('planned');
      await unchanged(async () => {
        const res = await put(body());
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ error: 'slot_started' });
      });
    },
  );

  it('a publication row of another slot does not block', async () => {
    seed();
    addPub('s1', 'sent');
    expect((await put(body())).statusCode).toBe(200);
  });

  it('less than 10 minutes before at: 409 too_close; exactly 10 minutes is allowed', async () => {
    seed();
    const at = msk('19:00').getTime();
    expect(REPLACE_MIN_LEAD_MS).toBe(600_000);
    for (const now of [at - REPLACE_MIN_LEAD_MS + 1, at - 1000, at, at + 60_000]) {
      t = new Date(now);
      await unchanged(async () => {
        const res = await put(body());
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ error: 'too_close' });
      });
    }
    t = new Date(at - REPLACE_MIN_LEAD_MS);
    expect((await put(body())).statusCode).toBe(200);
  });

  it('em dash: 422 em_dash with the error shape of the plan POST', async () => {
    seed();
    await unchanged(async () => {
      const res = await put(body({ text: 'Ответ — 12.10. Кто первый?' }));
      expect(res.statusCode).toBe(422);
      const errors = res.json().errors as Record<string, string>[];
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ path: 'text', slotId: 's2', code: 'em_dash' });
      expect(errors[0]!.excerpt).toContain('—');
      expect(Object.keys(errors[0]!).sort()).toEqual([
        'code',
        'excerpt',
        'message',
        'path',
        'slotId',
      ]);
    });
  });

  it.each([
    ['en_dash', '09:00–10:00 тишина. Кто первый?'],
    ['guillemets', 'Дело «Тишина». Кто первый?'],
    ['list_line', 'Итоги:\n- пункт\nКто первый?'],
    ['stop_phrase', 'Важно отметить, что тихо. Кто первый?'],
  ])('lint %s: 422', async (code, text) => {
    seed();
    await unchanged(async () => {
      const res = await put(body({ text }));
      expect(res.statusCode).toBe(422);
      expect(codesOf(res)).toContain(code);
    });
  });

  it('no question: 422 no_question; every fault is listed at once', async () => {
    seed();
    await unchanged(async () => {
      const res = await put(body({ text: 'Просто утверждение.' }));
      expect(res.statusCode).toBe(422);
      expect(res.json().errors).toMatchObject([
        { path: 'text', slotId: 's2', code: 'no_question' },
      ]);
      const two = await put(body({ text: 'Ответ — завтра.' }));
      expect(codesOf(two).sort()).toEqual(['em_dash', 'no_question']);
    });
  });

  it('too long after signing: 422 too_long', async () => {
    seed();
    await unchanged(async () => {
      const res = await put(body({ text: `${'а'.repeat(3500)} Кто первый?` }));
      expect(res.statusCode).toBe(422);
      expect(res.json().errors).toMatchObject([{ path: 'text', code: 'too_long' }]);
    });
  });

  it('body shape: text and reason required; unknown keys and a non-object body are 422', async () => {
    seed();
    await unchanged(async () => {
      const codes = async (payload: unknown) => {
        const res = await put(payload);
        expect(res.statusCode, res.body).toBe(422);
        return (res.json().errors as { path: string; code: string }[]).map(
          (e) => `${e.path}:${e.code}`,
        );
      };
      expect(await codes({ reason: 'owner' })).toEqual(['text:invalid_type']);
      expect(await codes({ text: '   ', reason: 'owner' })).toEqual(['text:custom']);
      expect(await codes({ text: NEW_S2 })).toEqual(['reason:invalid_type']);
      expect(await codes({ text: NEW_S2, reason: '  ' })).toEqual(['reason:too_small']);
      expect(await codes({ text: NEW_S2, reason: 'x'.repeat(1001) })).toEqual(['reason:too_big']);
      expect(await codes(body({ status: 'draft' }))).toEqual(['status:unrecognized_key']);
      expect(await codes([body()])).toEqual(['(body):invalid_type']);
    });
  });

  it('unknown plan, unknown slot: 404; bad date: 400', async () => {
    const none = await put(body());
    expect(none.statusCode).toBe(404);
    expect(none.json()).toEqual({ error: 'plan not found' });
    seed();
    await unchanged(async () => {
      const res = await put(body(), 's9');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'slot not found' });
      const bad = await server().inject({
        method: 'PUT',
        url: '/v1/plans/2026-13-40/slots/s2',
        headers: auth,
        payload: body(),
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  it('no bearer or a wrong one: 401, before the body is looked at', async () => {
    seed();
    await unchanged(async () => {
      expect((await put(body(), 's2', {})).statusCode).toBe(401);
      expect((await put(body(), 's2', { authorization: 'Bearer wrong' })).statusCode).toBe(401);
      const malformed = await server().inject({
        method: 'PUT',
        url: `/v1/plans/${DATE}/slots/s2`,
        headers: { 'content-type': 'application/json' },
        payload: '{not json',
      });
      expect(malformed.statusCode).toBe(401);
    });
  });

  it('an oversized body is refused (64 KB limit)', async () => {
    seed();
    await unchanged(async () => {
      const res = await put(body({ text: 'я'.repeat(40_000) }));
      expect(res.statusCode).toBe(413);
    });
  });
});
