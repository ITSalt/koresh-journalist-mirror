import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { signText } from '../../src/plan/pipeline.js';
import { PlanV1Schema, type PlanSlot } from '../../src/plan/schema.js';
import { createPublisher } from '../../src/publish/publisher.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { CHANNEL, DATE, msk, seedPlan, TOKEN as BOT_TOKEN } from '../publish/helpers.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';

// WP-SVC-25: PUT /v1/plans/:date/slots/:slotId may move a slot (`at`) and change its `eventDate`.
// The `at` column, the slot json, the plan json and plan.md change together; the publisher
// follows the new time and never the old one.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const S1_TEXT = 'Утро. Кто первый?';
const S2_TEXT = 'Вечер. Что думаете?';
const NEW_AT = `${DATE}T20:07:41+03:00`;
const REASON = 'director timing decision D-33';

let dir: string;
let store: Store;
let t: Date;
let fake: FakeBotApi | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jrn-replace-at-'));
  store = openStore(join(dir, 'journalist.db'));
  t = msk('08:00');
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
    logLevel: 'silent',
    now: () => t,
  });
}

/** s1 at 09:07:21; s2 at the legacy round 19:00 (stored before the lint existed). */
const seed = (status: 'approved' | 'draft' = 'approved') =>
  seedPlan(
    store,
    [
      { id: 's1', at: '09:07:21', text: S1_TEXT },
      { id: 's2', at: '19:00', text: S2_TEXT },
    ],
    { status },
  );

const put = (payload: unknown, slotId = 's2') =>
  server().inject({
    method: 'PUT',
    url: `/v1/plans/${DATE}/slots/${slotId}`,
    headers: auth,
    payload: payload as object,
  });
const move = (at: unknown, over: Record<string, unknown> = {}) => ({ at, reason: REASON, ...over });

const slotRow = (id: string) => store.slots.listForPlan(DATE).find((s) => s.slotId === id)!;
const planDoc = () => PlanV1Schema.parse(JSON.parse(store.plans.get(DATE)!.json));
const dayRows = () =>
  JSON.stringify([
    store.plans.get(DATE),
    store.slots.listForPlan(DATE),
    store.publications.listForPlan(DATE),
    store.alerts.list(),
  ]);
const replacedAlerts = () => store.alerts.list().filter((a) => a.kind === 'slot_replaced');
const errorCodes = (res: { json(): { errors: { code: string }[] } }) =>
  res.json().errors.map((e) => e.code);

describe('PUT slot: at', () => {
  it('moves s2: the at column, the slot json, the plan json and plan.md all say the new time', async () => {
    seed();
    const oldS2 = JSON.parse(slotRow('s2').json) as PlanSlot;
    const before = slotRow('s1');
    const res = await put(move(NEW_AT));
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json();
    expect(out).toMatchObject({ date: DATE, slotId: 's2', status: 'approved' });

    const row = slotRow('s2');
    expect(row.at).toBe(NEW_AT);
    expect(row.status).toBe('planned');
    const stored = JSON.parse(row.json) as PlanSlot;
    expect(stored.at).toBe(NEW_AT);
    // only `at` changed: the text is the stored (signed) text, not rewritten
    expect({ ...stored, at: oldS2.at }).toEqual(oldS2);
    expect(stored.text).toBe(signText(S2_TEXT));
    const inPlan = planDoc().slots.find((s) => s.id === 's2')!;
    expect(inPlan).toEqual(stored);
    expect(store.plans.get(DATE)!.md).toBe(out.md);
    expect(out.md).toContain('20:07 МСК · пост · s2');
    expect(out.md).not.toContain('19:00 МСК');
    expect(store.plans.get(DATE)!.status).toBe('approved');
    expect(store.plans.get(DATE)!.updatedAt).toBe(t.toISOString());
    expect(slotRow('s1')).toEqual(before);
    expect(store.publications.listForPlan(DATE)).toEqual([]);
  });

  it('writes one slot_replaced alert that names the changed fields and the move', async () => {
    seed();
    expect((await put(move(NEW_AT))).statusCode).toBe(200);
    const alerts = replacedAlerts();
    expect(alerts).toHaveLength(1);
    const msg = alerts[0]!.message;
    expect(msg).toContain('changed: at;');
    expect(msg).toContain(`at ${DATE}T19:00:00+03:00 -> ${NEW_AT}`);
    expect(msg).toContain(`reason: ${REASON}`);
    expect(msg).not.toContain('eventDate');
  });

  it('keeps plan.json sorted by at when the slot jumps over another one', async () => {
    seed();
    expect((await put(move(`${DATE}T08:41:09+03:00`))).statusCode).toBe(200);
    expect(planDoc().slots.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(store.slots.listForPlan(DATE).map((s) => s.slotId)).toEqual(['s2', 's1']);
    expect(store.plans.get(DATE)!.md.indexOf('· s2')).toBeLessThan(
      store.plans.get(DATE)!.md.indexOf('· s1'),
    );
  });

  it('at and text together; the new text goes through the text rules', async () => {
    seed();
    const res = await put(move(NEW_AT, { text: 'Новая версия вечера. Кто согласен?' }));
    expect(res.statusCode, res.body).toBe(200);
    const stored = JSON.parse(slotRow('s2').json) as PlanSlot;
    expect(stored.at).toBe(NEW_AT);
    expect(stored.text).toBe(signText('Новая версия вечера. Кто согласен?'));
    expect(replacedAlerts()[0]!.message).toContain('changed: text, at;');

    const bad = await put(move(`${DATE}T20:09:09+03:00`, { text: 'Ответ — 12.10. Кто первый?' }));
    expect(bad.statusCode).toBe(422);
    expect(errorCodes(bad)).toEqual(['em_dash']);
    expect(slotRow('s2').at).toBe(NEW_AT);
  });

  it('text is not needed for at or eventDate, but something must change', async () => {
    seed();
    const none = await put({ reason: REASON });
    expect(none.statusCode).toBe(422);
    expect(none.json().errors).toMatchObject([{ path: 'text', code: 'invalid_type' }]);
    expect(replacedAlerts()).toEqual([]);
  });

  it('the stored text is not checked again when only the time moves', async () => {
    // A text that the lint of today would refuse (an em dash) was approved earlier.
    seedPlan(store, [{ id: 's2', at: '19:00', text: 'Старый пост — без правки. Кто первый?' }]);
    const res = await put(move(NEW_AT));
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(slotRow('s2').json) as PlanSlot).text).toContain('—');
  });

  it('the same at again is a 200 that writes nothing, even when the old time is round', async () => {
    seed();
    const rows = dayRows();
    const res = await put(move(`${DATE}T19:00:00+03:00`));
    expect(res.statusCode, res.body).toBe(200);
    expect(dayRows()).toBe(rows);
    expect(replacedAlerts()).toEqual([]);
  });

  it('seconds are honoured to the second: 19:09:53 is stored as sent', async () => {
    seed();
    expect((await put(move(`${DATE}T19:09:53+03:00`))).statusCode).toBe(200);
    expect(slotRow('s2').at).toBe(`${DATE}T19:09:53+03:00`);
  });

  it('exactly 10 minutes of lead is enough', async () => {
    seed();
    t = new Date(msk('08:00').getTime() + 1000);
    expect((await put(move(`${DATE}T08:10:01+03:00`))).statusCode).toBe(200);
  });
});

describe('PUT slot: eventDate', () => {
  it('changes only eventDate (no text): json, plan json and md follow, at stays', async () => {
    seed();
    const res = await put({ eventDate: '2026-10-09', reason: REASON });
    expect(res.statusCode, res.body).toBe(200);
    const row = slotRow('s2');
    expect(row.at).toBe(`${DATE}T19:00:00+03:00`);
    expect((JSON.parse(row.json) as PlanSlot).eventDate).toBe('2026-10-09');
    expect(planDoc().slots[1]!.eventDate).toBe('2026-10-09');
    expect(res.json().md).toContain('события от 09.10');
    const msg = replacedAlerts()[0]!.message;
    expect(msg).toContain('changed: eventDate;');
    expect(msg).toContain('eventDate 2026-10-08 -> 2026-10-09');
  });

  it('a bad eventDate is a 422 from the slot schema', async () => {
    seed();
    const before = dayRows();
    const res = await put({ eventDate: '09.10.2026', reason: REASON });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors).toMatchObject([{ path: 'eventDate', slotId: 's2' }]);
    expect(dayRows()).toBe(before);
  });
});

describe('PUT slot: refusals of at', () => {
  const refused = async (at: unknown, codes: string[], over: Record<string, unknown> = {}) => {
    const before = dayRows();
    const res = await put(move(at, over));
    expect(res.statusCode, res.body).toBe(422);
    expect(errorCodes(res).sort()).toEqual([...codes].sort());
    expect(dayRows()).toBe(before);
    expect(slotRow('s2').at).toBe(`${DATE}T19:00:00+03:00`);
  };

  it('a time in the past, and a time under 10 minutes away: at_too_soon', async () => {
    seed();
    await refused(`${DATE}T07:41:09+03:00`, ['at_too_soon']);
    await refused(`${DATE}T08:09:59+03:00`, ['at_too_soon']);
    await refused(`${DATE}T08:00:30+03:00`, ['at_too_soon']);
  });

  it.each(['20:00:00', '20:00', '12:15:00', '12:30', '18:45:00'])(
    'a round time %s: round_time',
    async (hhmm) => {
      seed();
      await refused(`${DATE}T${hhmm}+03:00`, ['round_time']);
    },
  );

  it('another day, the day before and the day after: at_not_on_plan_date', async () => {
    seed();
    await refused('2026-10-12T09:07:41+03:00', ['at_not_on_plan_date']);
    await refused('2026-10-10T21:07:41+03:00', ['at_not_on_plan_date', 'at_too_soon']);
  });

  it("another slot's time: at_not_unique; one second apart is fine", async () => {
    seed();
    await refused(`${DATE}T09:07:21+03:00`, ['at_not_unique']);
    const other = await put(move(`${DATE}T09:07:22+03:00`));
    expect(other.statusCode).toBe(200);
  });

  it('every fault at once: past, round and not on the day', async () => {
    seed();
    await refused('2026-10-10T07:00:00+03:00', [
      'at_not_on_plan_date',
      'at_too_soon',
      'round_time',
    ]);
  });

  it.each([
    ['no seconds are fine but a bad shape is not', `${DATE}T20:07`],
    ['another offset', `${DATE}T20:07:41+00:00`],
    ['a number', 1760000000],
    ['an empty string', ''],
    ['null', null],
  ])('%s: the slot schema refuses it', async (_n, at) => {
    seed();
    const before = dayRows();
    const res = await put(move(at));
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().errors[0]).toMatchObject({ path: 'at', slotId: 's2' });
    expect(dayRows()).toBe(before);
  });

  it('an id, a kind or a platform still cannot be sent', async () => {
    seed();
    const res = await put(move(NEW_AT, { id: 'x', kind: 'poll' }));
    expect(res.statusCode).toBe(422);
    expect(errorCodes(res)).toEqual(['unrecognized_key', 'unrecognized_key']);
  });

  it.each(['intent', 'sent', 'unknown', 'dry', 'failed'] as const)(
    'a slot with a %s publication row: 409 slot_started, nothing written',
    async (status) => {
      seed();
      const key = `telegram:${DATE}:s2:0`;
      store.publications.beginIntent({
        key,
        platform: 'telegram',
        planDate: DATE,
        slotId: 's2',
        textSha256: 'a'.repeat(64),
      });
      if (status === 'sent') store.publications.markSent(key, '42');
      if (status === 'unknown') store.publications.markUnknown(key, 'timeout');
      if (status === 'dry') store.publications.markDry(key);
      if (status === 'failed') store.publications.markFailed(key, 'boom');
      const before = dayRows();
      const res = await put(move(NEW_AT));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'slot_started', publications: 1 });
      expect(dayRows()).toBe(before);
    },
  );

  it('the OLD time under 10 minutes away: 409 too_close, even for a valid new time', async () => {
    seed();
    t = msk('18:55:01');
    const before = dayRows();
    const res = await put(move(`${DATE}T21:07:41+03:00`));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'too_close', at: `${DATE}T19:00:00+03:00` });
    expect(dayRows()).toBe(before);
  });

  it('a draft plan: 409 not_approved', async () => {
    seed('draft');
    const res = await put(move(NEW_AT));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_approved', status: 'draft' });
  });

  it('a skipped slot: 409 slot_started', async () => {
    seed();
    store.slots.setStatus(DATE, 's2', 'skipped');
    expect((await put(move(NEW_AT))).statusCode).toBe(409);
  });
});

describe('PUT slot: the publisher follows the new time', () => {
  async function publisher() {
    fake ??= await new FakeBotApi(BOT_TOKEN).start();
    return createPublisher({
      store,
      blocks,
      api: createBotApi({ token: BOT_TOKEN, baseUrl: fake.baseUrl, timeoutMs: 500 }),
      channel: CHANNEL,
      dryRun: false,
      tz: 'Europe/Moscow',
      now: () => t,
      sleep: async () => undefined,
    });
  }

  it('moved later: nothing at the old time, one post at the new second', async () => {
    seed();
    expect((await put(move(NEW_AT))).statusCode).toBe(200);
    const p = await publisher();
    t = msk('09:07:21');
    expect(await p.runOnce()).toMatchObject({ slot: 's1', result: 'sent' });

    t = msk('19:00:30'); // past the OLD time
    const idle = await p.runOnce();
    expect(idle.slot).toBeUndefined();
    expect(Date.parse(idle.wakeAt!)).toBe(Date.parse(NEW_AT));
    expect(fake!.channel).toHaveLength(1);

    t = msk('20:07:40');
    expect((await p.runOnce()).slot).toBeUndefined();
    expect(fake!.channel).toHaveLength(1);

    t = msk('20:07:41');
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    expect(fake!.channel).toHaveLength(2);
    expect(store.publications.listForPlan(DATE).map((x) => [x.slotId, x.status])).toEqual([
      ['s1', 'sent'],
      ['s2', 'sent'],
    ]);
  });

  it('moved earlier: the old time is not waited for', async () => {
    seed();
    expect((await put(move(`${DATE}T08:41:09+03:00`))).statusCode).toBe(200);
    const p = await publisher();
    t = msk('08:41:09');
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    t = msk('19:00:30');
    await p.runOnce();
    expect(fake!.channel.filter((m) => (m.text ?? '').includes('Вечер'))).toHaveLength(1);
  });

  it("moved close to a sent slot: the scheduler's minimum gap delays it, it is sent once", async () => {
    seed();
    const p = await publisher();
    t = msk('09:07:25');
    expect(await p.runOnce()).toMatchObject({ slot: 's1', result: 'sent' });
    const sentAt = Date.parse(store.publications.listForPlan(DATE)[0]!.sentAt!);

    // 09:19:05 is 12 minutes after s1 went out, inside the 20 minute gap.
    t = msk('09:08:00');
    expect((await put(move(`${DATE}T09:19:05+03:00`))).statusCode).toBe(200);

    t = msk('09:19:10');
    const blocked = await p.runOnce();
    expect(blocked.slot).toBeUndefined();
    expect(Date.parse(blocked.wakeAt!)).toBe(sentAt + 20 * 60_000);
    expect(fake!.channel).toHaveLength(1);

    t = new Date(sentAt + 20 * 60_000);
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    t = new Date(sentAt + 21 * 60_000);
    expect((await p.runOnce()).slot).toBeUndefined();
    expect(fake!.channel).toHaveLength(2);
    expect(store.publications.listForPlan(DATE).map((x) => [x.slotId, x.status])).toEqual([
      ['s1', 'sent'],
      ['s2', 'sent'],
    ]);
  });
});
