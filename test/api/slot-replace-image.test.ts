import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { signText } from '../../src/plan/pipeline.js';
import { PlanV1Schema, type SlotImage } from '../../src/plan/schema.js';
import { buildServer } from '../../src/server.js';
import { openStore, type PlanStatus, type Store } from '../../src/store/index.js';
import { DATE, msk, seedPlan } from '../publish/helpers.js';
import { seedImage } from '../support/images.js';

// WP-SVC-24 scope 3: PUT /v1/plans/:date/slots/:slotId accepts `image` ({sha256, credit} sets or
// replaces it, null removes it, absent keeps it), under the guards of WP-SVC-22.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const TEXT = 'Вечер, текст поста. Что думаете?';
const POLL = { question: 'Кто прав?', options: ['я', 'ты'], allowsMultiple: false };

let store: Store;
let t: Date;
let one: ReturnType<typeof seedImage>;
let two: ReturnType<typeof seedImage>;
let stored: SlotImage;

beforeEach(() => {
  store = openStore(':memory:');
  t = msk('08:00');
  one = seedImage(store, 1280, 720, 1);
  two = seedImage(store, 800, 600, 2);
  stored = { sha256: one.sha256, mime: 'image/png', width: 1280, height: 720, credit: 'zenith' };
});
afterEach(() => store.close());

const seed = (o: { image?: SlotImage; status?: PlanStatus } = {}) =>
  seedPlan(
    store,
    [
      { id: 's1', at: '09:00', text: 'Утро. Кто первый?' },
      { id: 's2', at: '19:00', text: TEXT, ...(o.image ? { image: o.image } : {}) },
      { id: 'q1', at: '21:00', kind: 'poll', text: 'Опрос дня.', poll: POLL },
    ],
    { status: o.status },
  );

const put = (payload: unknown, slotId = 's2') =>
  buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: API_TOKEN }),
    store,
    logLevel: 'silent',
    now: () => t,
  }).inject({
    method: 'PUT',
    url: `/v1/plans/${DATE}/slots/${slotId}`,
    headers: auth,
    payload: payload as object,
  });
const body = (over: Record<string, unknown> = {}) => ({
  text: TEXT,
  reason: 'owner ok 12:00',
  ...over,
});
const row = (id: string) => store.slots.listForPlan(DATE).find((s) => s.slotId === id)!;
const slot = (id = 's2') => JSON.parse(row(id).json) as Record<string, unknown>;
const planSlot = (id = 's2') =>
  PlanV1Schema.parse(JSON.parse(store.plans.get(DATE)!.json)).slots.find((s) => s.id === id)!;
const day = () =>
  JSON.stringify([
    store.plans.get(DATE),
    store.slots.listForPlan(DATE),
    store.publications.listForPlan(DATE),
    store.alerts.list(),
  ]);
const replaced = () => store.alerts.list().filter((a) => a.kind === 'slot_replaced');
const errors = (res: { json(): { errors: { path: string; code: string }[] } }) =>
  res.json().errors.map((e) => `${e.path}:${e.code}`);

describe('PUT with `image`', () => {
  it('adds an image to a slot that had none: slot json, plan json and plan.md follow', async () => {
    seed();
    const s1Before = row('s1');
    const res = await put(body({ image: { sha256: one.sha256, credit: 'zenith' } }));
    expect(res.statusCode, res.body).toBe(200);
    expect(slot().image).toEqual(stored);
    expect(planSlot().image).toEqual(stored);
    expect(slot().text).toBe(signText(TEXT));
    expect(store.plans.get(DATE)!.status).toBe('approved');
    expect(res.json().md).toContain(
      `Иллюстрация: 1280×720 PNG · sha256 ${one.sha256.slice(0, 12)} · автор: zenith`,
    );
    expect(store.plans.get(DATE)!.md).toBe(res.json().md);
    expect(row('s1')).toEqual(s1Before);
    // The alert names the image change by sha256; no bytes, no text.
    expect(replaced()).toHaveLength(1);
    expect(replaced()[0]!.message).toContain(`image sha256 none -> ${one.sha256}; `);
    expect(replaced()[0]!.message).toContain('reason: owner ok 12:00');
  });

  it('replaces the image and its credit', async () => {
    seed({ image: stored });
    const res = await put(body({ image: { sha256: two.sha256, credit: 'другой автор' } }));
    expect(res.statusCode, res.body).toBe(200);
    expect(slot().image).toEqual({
      sha256: two.sha256,
      mime: 'image/png',
      width: 800,
      height: 600,
      credit: 'другой автор',
    });
    expect(planSlot().image!.sha256).toBe(two.sha256);
    expect(res.json().md).not.toContain(one.sha256.slice(0, 12));
    expect(replaced()[0]!.message).toContain(`image sha256 ${one.sha256} -> ${two.sha256}; `);
  });

  it('`image: null` removes it', async () => {
    seed({ image: stored });
    const res = await put(body({ image: null }));
    expect(res.statusCode, res.body).toBe(200);
    expect(slot()).not.toHaveProperty('image');
    expect(planSlot().image).toBeUndefined();
    expect(res.json().md).not.toContain('Иллюстрация');
    expect(replaced()[0]!.message).toContain(`image sha256 ${one.sha256} -> none; `);
  });

  it('an absent `image` keeps the stored one while the text changes', async () => {
    seed({ image: stored });
    const res = await put(body({ text: 'Новый текст. Кто согласен?' }));
    expect(res.statusCode, res.body).toBe(200);
    expect(slot().image).toEqual(stored);
    expect(slot().text).toBe(signText('Новый текст. Кто согласен?'));
    expect(res.json().md).toContain('автор: zenith');
    expect(replaced()[0]!.message).toContain(`image sha256 ${one.sha256} -> ${one.sha256}; `);
  });

  it('the same image and text again: 200, nothing written, no alert', async () => {
    seed({ image: stored });
    const before = day();
    const res = await put(body({ image: { sha256: one.sha256, credit: 'zenith' } }));
    expect(res.statusCode).toBe(200);
    expect(day()).toBe(before);
    // `null` on a slot without an image is the same no-op.
    store.close();
    store = openStore(':memory:');
    seed();
    const none = day();
    expect((await put(body({ image: null }))).statusCode).toBe(200);
    expect(day()).toBe(none);
  });

  it('a replacement without an image keeps the old wording of the alert', async () => {
    seed();
    expect((await put(body({ text: 'Новый текст. Кто согласен?' }))).statusCode).toBe(200);
    expect(replaced()[0]!.message).not.toContain('image');
  });

  describe('422, nothing written', () => {
    const refused = async (payload: unknown, expected: string[], slotId = 's2') => {
      const before = day();
      const res = await put(payload, slotId);
      expect(res.statusCode, res.body).toBe(422);
      expect(errors(res)).toEqual(expected);
      expect(res.json().errors.every((e: { slotId: string }) => e.slotId === slotId)).toBe(true);
      expect(day()).toBe(before);
    };

    it('unknown_image', async () => {
      seed({ image: stored });
      await refused(body({ image: { sha256: 'd'.repeat(64), credit: 'zenith' } }), [
        'image.sha256:unknown_image',
      ]);
    });

    it('the credit lint, with the text lint', async () => {
      seed();
      await refused(
        body({ text: 'Текст — с тире. Ну?', image: { sha256: one.sha256, credit: '«Студия»' } }),
        ['image.credit:guillemets', 'text:em_dash'],
      );
    });

    it('image_not_allowed on a poll slot; null there is fine', async () => {
      seed();
      await refused(
        { text: 'Опрос дня.', reason: 'r', image: { sha256: one.sha256, credit: 'zenith' } },
        ['image:image_not_allowed'],
        'q1',
      );
      const res = await put({ text: 'Опрос дня, правка.', reason: 'r', image: null }, 'q1');
      expect(res.statusCode, res.body).toBe(200);
      expect(slot('q1')).not.toHaveProperty('image');
    });

    it('a malformed image, or one with server-filled keys', async () => {
      seed();
      await refused(body({ image: 'abc' }), ['image:invalid_type']);
      await refused(body({ image: { ...stored } }), ['image:unrecognized_keys']);
      await refused(body({ image: { sha256: one.sha256 } }), ['image.credit:invalid_type']);
    });

    it('an unknown body key is still refused, and the message names image', async () => {
      seed();
      const res = await put(body({ photo: one.sha256 }));
      expect(res.statusCode).toBe(422);
      expect(errors(res)).toEqual(['photo:unrecognized_key']);
      expect(res.json().errors[0].message).toContain('text, poll, image, at, eventDate and reason');
    });
  });

  describe('the guards of WP-SVC-22 hold for an image change (409, nothing written)', () => {
    const image = () => ({ sha256: two.sha256, credit: 'другой автор' });
    const guarded = async (error: string) => {
      const before = day();
      const res = await put(body({ image: image() }));
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toBe(error);
      expect(day()).toBe(before);
    };

    it.each(['draft', 'rejected', 'failed'] as const)('not_approved: a %s plan', async (status) => {
      seed({ image: stored, status });
      await guarded('not_approved');
    });

    it.each(['intent', 'sent', 'unknown', 'dry', 'failed'] as const)(
      'slot_started: a publication row of the slot is `%s`',
      async (status) => {
        seed({ image: stored });
        const key = `telegram:${DATE}:s2:0`;
        store.publications.beginIntent(
          { key, platform: 'telegram', planDate: DATE, slotId: 's2', textSha256: 'a'.repeat(64) },
          msk('07:00'),
        );
        if (status === 'sent') store.publications.markSent(key, '42', msk('07:00'));
        if (status === 'unknown') store.publications.markUnknown(key, 'timeout');
        if (status === 'dry') store.publications.markDry(key, msk('07:00'));
        if (status === 'failed') store.publications.markFailed(key, 'boom');
        await guarded('slot_started');
      },
    );

    it.each(['done', 'skipped'] as const)('slot_started: the slot is %s', async (status) => {
      seed({ image: stored });
      store.slots.setStatus(DATE, 's2', status);
      await guarded('slot_started');
    });

    it('too_close: less than 10 minutes before the slot; exactly 10 minutes passes', async () => {
      seed({ image: stored });
      t = msk('18:50:01');
      await guarded('too_close');
      t = msk('18:50');
      expect((await put(body({ image: image() }))).statusCode).toBe(200);
      expect(slot().image).toMatchObject({ sha256: two.sha256 });
    });
  });
});
