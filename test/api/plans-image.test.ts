import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { finalizePlan } from '../../src/plan/pipeline.js';
import { renderPlanMd } from '../../src/plan/render.js';
import { PlanV1Schema } from '../../src/plan/schema.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { b64, png, seedImage } from '../support/images.js';
import { DATE, validPlan } from '../plan/fixtures.js';

// WP-SVC-24 scope 2, acceptance 3: a slot of a plan POST may carry `image: {sha256, credit}`.

const TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date('2026-10-10T17:00:00Z'); // 20:00 MSK on the 10th

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
  return { app, store, img: seedImage(store, 1280, 720) };
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});
type Ctx = ReturnType<typeof setup>;

/** The plan body with `image` on the post slot s1 (s2 is a poll). */
function body(image?: unknown, onPoll?: unknown) {
  const p = validPlan();
  const slots = p.slots.map((s) => ({ ...s })) as Record<string, unknown>[];
  if (image !== undefined) slots[0]!.image = image;
  if (onPoll !== undefined) slots[1]!.image = onPoll;
  return { arc: p.arc, slots };
}
const post = (c: Ctx, payload: unknown) =>
  c.app.inject({
    method: 'POST',
    url: `/v1/plans/${DATE}`,
    headers: auth,
    payload: payload as object,
  });
const errors = (res: { json(): { errors: { path: string; code: string; slotId?: string }[] } }) =>
  res.json().errors.map((e) => `${e.path}:${e.code}`);
const slotJson = (c: Ctx, id: string) =>
  JSON.parse(c.store.slots.listForPlan(DATE).find((s) => s.slotId === id)!.json);
const nothingStored = (c: Ctx) => {
  expect(c.store.plans.get(DATE)).toBeUndefined();
  expect(c.store.slots.listForPlan(DATE)).toEqual([]);
};

describe('POST /v1/plans/:date with an image on a slot', () => {
  it('stores the slot with the facts of the image; plan.md has the illustration line', async () => {
    const c = setup();
    const res = await post(c, body({ sha256: c.img.sha256, credit: 'zenith-claude' }));
    expect(res.statusCode, res.body).toBe(201);
    const image = {
      sha256: c.img.sha256,
      mime: 'image/png',
      width: 1280,
      height: 720,
      credit: 'zenith-claude',
    };
    // Inside the stored slot json: the publisher's claim (slot json unchanged) covers it.
    expect(slotJson(c, 's1').image).toEqual(image);
    expect(Object.keys(slotJson(c, 's1'))).toEqual([
      'id',
      'at',
      'platform',
      'kind',
      'text',
      'eventDate',
      'image',
    ]);
    const plan = PlanV1Schema.parse(JSON.parse(c.store.plans.get(DATE)!.json));
    expect(plan.slots[0]!.image).toEqual(image);
    expect(plan.slots[1]!.image).toBeUndefined();
    expect(slotJson(c, 's2')).not.toHaveProperty('image');

    const line = `Иллюстрация: 1280×720 PNG · sha256 ${c.img.sha256.slice(0, 12)} · автор: zenith-claude`;
    const md = res.json().md as string;
    expect(md.split('\n').filter((l) => l.startsWith('Иллюстрация:'))).toEqual([line]);
    // In the s1 block, before the text.
    const s1 = md.split('\n\n---\n\n')[1]!;
    expect(s1).toContain(`события от 08.10\n\n${line}\n\nНовости от Корпорации`);
    expect(c.store.plans.get(DATE)!.md).toBe(md);
    expect(c.store.plans.get(DATE)!.status).toBe('draft');
  });

  it('the credit is trimmed; exactly 80 chars pass, 81 do not', async () => {
    const c = setup();
    const ok = await post(c, body({ sha256: c.img.sha256, credit: `  ${'я'.repeat(80)}  ` }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(slotJson(c, 's1').image.credit).toBe('я'.repeat(80));
    const long = await post(c, body({ sha256: c.img.sha256, credit: 'я'.repeat(81) }));
    expect(long.statusCode).toBe(422);
    expect(errors(long)).toEqual(['slots.0.image.credit:too_big']);
  });

  it('a JPEG says JPEG in plan.md', () => {
    const p = validPlan();
    p.slots[0]!.image = {
      sha256: 'c'.repeat(64),
      mime: 'image/jpeg',
      width: 200,
      height: 4000,
      credit: 'Автор, студия',
    };
    expect(renderPlanMd(p)).toContain(
      'Иллюстрация: 200×4000 JPEG · sha256 cccccccccccc · автор: Автор, студия',
    );
  });

  describe('422, nothing stored', () => {
    it('unknown_image: a sha256 that was never uploaded', async () => {
      const c = setup();
      const res = await post(c, body({ sha256: 'd'.repeat(64), credit: 'zenith' }));
      expect(res.statusCode).toBe(422);
      expect(errors(res)).toEqual(['slots.0.image.sha256:unknown_image']);
      expect(res.json().errors[0]).toMatchObject({ slotId: 's1' });
      expect(res.json().errors[0].message).toContain('POST /v1/images');
      nothingStored(c);
    });

    it.each([
      ['em_dash', 'Автор — студия'],
      ['en_dash', 'Автор – студия'],
      ['guillemets', 'Студия «Перец»'],
      ['list_line', '- автор'],
      ['stop_phrase', 'Важно отметить, что автор'],
    ])('the credit goes through the text lint: %s', async (code, credit) => {
      const c = setup();
      const res = await post(c, body({ sha256: c.img.sha256, credit }));
      expect(res.statusCode).toBe(422);
      expect(errors(res)).toEqual([`slots.0.image.credit:${code}`]);
      expect(res.json().errors[0]).toMatchObject({ slotId: 's1', excerpt: expect.any(String) });
      nothingStored(c);
    });

    it('the whole credit is linted: a signature line in it hides nothing', async () => {
      const c = setup();
      const credit = 'ИИ-журналист-правдорубец Кореш Шпандент — и «студия»';
      const res = await post(c, body({ sha256: c.img.sha256, credit }));
      expect(res.statusCode).toBe(422);
      expect(errors(res)).toEqual([
        'slots.0.image.credit:em_dash',
        'slots.0.image.credit:guillemets',
      ]);
      nothingStored(c);
    });

    it('image_not_allowed: an image on a poll slot', async () => {
      const c = setup();
      const res = await post(c, body(undefined, { sha256: c.img.sha256, credit: 'zenith' }));
      expect(res.statusCode).toBe(422);
      expect(errors(res)).toEqual(['slots.1.image:image_not_allowed']);
      expect(res.json().errors[0]).toMatchObject({ slotId: 's2' });
      nothingStored(c);
    });

    it.each([
      ['an empty credit', (s: string) => ({ sha256: s, credit: '   ' }), 'image.credit:too_small'],
      ['two lines', (s: string) => ({ sha256: s, credit: 'a\nb' }), 'image.credit:invalid_format'],
      [
        'a carriage return',
        (s: string) => ({ sha256: s, credit: 'a\rb' }),
        'image.credit:invalid_format',
      ],
      [
        'a line separator',
        (s: string) => ({ sha256: s, credit: 'a\u2028b' }),
        'image.credit:invalid_format',
      ],
      ['a tab', (s: string) => ({ sha256: s, credit: 'a\tb' }), 'image.credit:invalid_format'],
      ['no credit', (s: string) => ({ sha256: s }), 'image.credit:invalid_type'],
      ['no sha256', () => ({ credit: 'zenith' }), 'image.sha256:invalid_type'],
      [
        'an upper-case sha256',
        (s: string) => ({ sha256: s.toUpperCase(), credit: 'z' }),
        'image.sha256:invalid_format',
      ],
      [
        'a short sha256',
        (s: string) => ({ sha256: s.slice(0, 12), credit: 'z' }),
        'image.sha256:invalid_format',
      ],
      ['a string', (s: string) => s, 'image:invalid_type'],
      [
        'server-filled or unknown keys',
        (s: string) => ({ sha256: s, credit: 'z', mime: 'image/png', width: 1, height: 1 }),
        'image:unrecognized_keys',
      ],
      [
        'the bytes instead of a reference',
        (s: string) => ({ sha256: s, credit: 'z', imageBase64: b64(png(200, 200)) }),
        'image:unrecognized_keys',
      ],
    ])('%s', async (_name, make, expected) => {
      const c = setup();
      const res = await post(c, body(make(c.img.sha256)));
      expect(res.statusCode).toBe(422);
      expect(errors(res)).toEqual([`slots.0.${expected}`]);
      nothingStored(c);
    });

    it('every fault is reported at once, with the text faults', async () => {
      const c = setup();
      const b = body({ sha256: 'e'.repeat(64), credit: 'Автор — студия' });
      b.slots[0]!.text = 'Без вопроса — совсем.';
      const res = await post(c, b);
      expect(errors(res).sort()).toEqual(
        [
          'slots.0.image.credit:em_dash',
          'slots.0.image.sha256:unknown_image',
          'slots.0.text:em_dash',
          'slots.0.text:no_question',
        ].sort(),
      );
      nothingStored(c);
    });
  });

  it('`image: null` is no image', async () => {
    const c = setup();
    const res = await post(c, body(null, null));
    expect(res.statusCode, res.body).toBe(201);
    expect(slotJson(c, 's1')).not.toHaveProperty('image');
    expect(res.json().md).not.toContain('Иллюстрация');
  });

  it('a re-POST of the draft without `image` removes it; with another image replaces it', async () => {
    const c = setup();
    const other = seedImage(c.store, 800, 600, 9);
    expect((await post(c, body({ sha256: c.img.sha256, credit: 'zenith' }))).statusCode).toBe(201);
    expect(slotJson(c, 's1').image.sha256).toBe(c.img.sha256);

    const swapped = await post(c, body({ sha256: other.sha256, credit: 'другой автор' }));
    expect(swapped.statusCode).toBe(201);
    expect(slotJson(c, 's1').image).toMatchObject({
      sha256: other.sha256,
      width: 800,
      height: 600,
      credit: 'другой автор',
    });

    const removed = await post(c, body());
    expect(removed.statusCode).toBe(201);
    expect(slotJson(c, 's1')).not.toHaveProperty('image');
    expect(c.store.plans.get(DATE)!.json).not.toContain('image');
    expect(removed.json().md).not.toContain('Иллюстрация');

    // The same body again is the idempotent 200.
    expect((await post(c, body())).statusCode).toBe(200);
  });

  it('a credit change alone is a new draft (the body hash covers the image)', async () => {
    const c = setup();
    const one = { sha256: c.img.sha256, credit: 'zenith' };
    expect((await post(c, body(one))).statusCode).toBe(201);
    expect((await post(c, body(one))).statusCode).toBe(200);
    expect((await post(c, body({ ...one, credit: 'zenith-claude' }))).statusCode).toBe(201);
    expect(slotJson(c, 's1').image.credit).toBe('zenith-claude');
  });

  it.each(['approved', 'rejected'] as const)(
    'a POST with an image over an %s plan is a 409: the stored slot does not change',
    async (status) => {
      const c = setup();
      expect((await post(c, body())).statusCode).toBe(201);
      c.store.plans.setStatus(DATE, status);
      const before = JSON.stringify([c.store.plans.get(DATE), c.store.slots.listForPlan(DATE)]);
      const res = await post(c, body({ sha256: c.img.sha256, credit: 'zenith' }));
      expect(res.statusCode).toBe(409);
      expect(res.json().status).toBe(status);
      expect(JSON.stringify([c.store.plans.get(DATE), c.store.slots.listForPlan(DATE)])).toBe(
        before,
      );
      expect(slotJson(c, 's1')).not.toHaveProperty('image');
    },
  );

  it('a plan without images is stored exactly as before: no `image` key anywhere', async () => {
    const c = setup();
    const res = await post(c, body());
    expect(res.statusCode).toBe(201);
    expect(Object.keys(slotJson(c, 's1'))).toEqual([
      'id',
      'at',
      'platform',
      'kind',
      'text',
      'eventDate',
    ]);
    expect(Object.keys(slotJson(c, 's2'))).toEqual([
      'id',
      'at',
      'platform',
      'kind',
      'text',
      'poll',
      'eventDate',
    ]);
    expect(c.store.plans.get(DATE)!.json).not.toContain('image');
    expect(c.store.plans.get(DATE)!.md).not.toContain('Иллюстрация');
  });
});

describe('finalizePlan without an image lookup (the fallback)', () => {
  const base = () => {
    const p = validPlan();
    return { version: 1 as const, date: p.date, sourceWindow: p.sourceWindow };
  };

  it('never yields a slot with an image: the key is dropped, valid or not', () => {
    const b = body({ sha256: 'f'.repeat(64), credit: 'модель — сама' }, { nonsense: true });
    const f = finalizePlan({ arc: b.arc, slots: b.slots }, base());
    expect(f.errors).toBeUndefined();
    expect(f.plan!.slots.map((s) => s.image)).toEqual([undefined, undefined]);
    expect(JSON.stringify(f.plan)).not.toContain('image');
    expect(f.md).not.toContain('Иллюстрация');
    // And it equals the plan built from the same slots without the key.
    const plain = body();
    expect(f).toEqual(finalizePlan({ arc: plain.arc, slots: plain.slots }, base()));
  });
});
