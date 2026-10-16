import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { threadsLength } from '../../src/lib/threads-length.js';
import { SIGNATURE_LINE } from '../../src/plan/pipeline.js';
import { PlanV2Schema } from '../../src/plan/schema.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { DATE } from '../plan/fixtures.js';
import {
  LINKEDIN_EN,
  LINKEDIN_RU,
  signed,
  THREADS_RU,
  v1Input,
  v2Input,
  variant,
  VARIANTS,
} from '../plan/variant-fixtures.js';

// WP-PLAT-01: POST /v1/plans/:date with plan.json v2 (variants per platform and language on a
// slot), how it is stored and rendered, and what the slot PUT does with it.

const TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const EVENING = new Date('2026-10-10T17:00:00Z'); // 20:00 MSK on the 10th

const open: Store[] = [];
function setup() {
  const store = openStore(':memory:');
  open.push(store);
  const c = { store, now: EVENING };
  const app = buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: TOKEN }),
    store,
    logLevel: 'silent',
    now: () => c.now,
  });
  return Object.assign(c, { app });
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});
type Ctx = ReturnType<typeof setup>;

const post = (c: Ctx, payload: unknown) =>
  c.app.inject({
    method: 'POST',
    url: `/v1/plans/${DATE}`,
    headers: auth,
    payload: payload as object,
  });
const put = (c: Ctx, slotId: string, payload: unknown) =>
  c.app.inject({
    method: 'PUT',
    url: `/v1/plans/${DATE}/slots/${slotId}`,
    headers: auth,
    payload: payload as object,
  });
const errors = (res: { json(): { errors: { path: string; code: string }[] } }) =>
  res.json().errors.map((e) => `${e.path}:${e.code}`);
const planJson = (c: Ctx) => JSON.parse(c.store.plans.get(DATE)!.json);
const variantRows = (c: Ctx) =>
  c.store.slotVariants
    .listForPlan(DATE)
    .map((v) => [v.slotId, v.platform, v.lang, v.at, v.status, JSON.parse(v.json)]);
const stored = (c: Ctx) => ({
  plan: c.store.plans.get(DATE),
  slots: c.store.slots.listForPlan(DATE),
  variants: c.store.slotVariants.listForPlan(DATE),
});

describe('POST /v1/plans/:date with variants', () => {
  it('stores a Threads RU variant and a LinkedIn RU + EN pair and renders them', async () => {
    const c = setup();
    const res = await post(c, v2Input());
    expect(res.statusCode, res.body).toBe(201);

    // The plan json is plan.json v2 with the signed variants on their slot.
    const plan = PlanV2Schema.parse(planJson(c));
    expect(plan.version).toBe(2);
    const want = VARIANTS.map((v) => ({ ...v, text: signed(v.text) }));
    expect(plan.slots[0]!.variants).toEqual(want);
    expect(plan.slots[1]).not.toHaveProperty('variants');

    // One row per variant, planned, by time; the json is the variant of the plan json.
    expect(variantRows(c)).toEqual([
      ['s1', 'threads', 'ru', THREADS_RU.at, 'planned', want[0]],
      ['s1', 'linkedin', 'ru', LINKEDIN_RU.at, 'planned', want[1]],
      ['s1', 'linkedin', 'en', LINKEDIN_EN.at, 'planned', want[2]],
    ]);
    expect(c.store.slotVariants.listForPlan(DATE)[0]!.json).toBe(JSON.stringify(want[0]));

    // plan.md: under the slot, one block per variant with platform, language, time, length.
    const md = res.json().md as string;
    const s1 = md.split('\n\n---\n\n')[1]!;
    const heads = s1.split('\n').filter((l) => l.startsWith('### '));
    expect(heads).toEqual([
      `### Threads · RU · 09:07:41 МСК · длина ${threadsLength(want[0]!.text)}/500`,
      `### LinkedIn · RU · 10:12:09 МСК · длина ${want[1]!.text.length}/2700`,
      `### LinkedIn · EN · 10:41 МСК · длина ${want[2]!.text.length}/2700`,
    ]);
    for (const [i, v] of want.entries()) expect(s1).toContain(`${heads[i]}\n\n${v.text}`);
    expect(s1.indexOf('Площадка: Telegram')).toBeLessThan(s1.indexOf(heads[0]!));
    expect(md.split('\n\n---\n\n')[2]).not.toContain('### ');
    expect(c.store.plans.get(DATE)!.md).toBe(md);

    const got = await c.app.inject({ method: 'GET', url: `/v1/plans/${DATE}`, headers: auth });
    expect(got.json().plan).toEqual(plan);
  });

  it('the Telegram slot rows of a v2 plan are those of the same plan without variants', async () => {
    const v2 = setup();
    const v1 = setup();
    expect((await post(v2, v2Input())).statusCode).toBe(201);
    expect((await post(v1, v1Input())).statusCode).toBe(201);
    expect(v2.store.slots.listForPlan(DATE)).toEqual(v1.store.slots.listForPlan(DATE));
    for (const s of v2.store.slots.listForPlan(DATE)) expect(s.json).not.toContain('variants');
    expect(v1.store.slotVariants.listForPlan(DATE)).toEqual([]);
    expect(planJson(v1).version).toBe(1);
  });

  it('acceptance 2: every fault of every variant in one 422, nothing stored', async () => {
    const c = setup();
    const room = 500 - threadsLength(`\n\n${SIGNATURE_LINE}`);
    const res = await post(
      c,
      v2Input(
        [
          variant(THREADS_RU, { text: 'Тишина — это знак. Кто согласен?' }),
          variant(THREADS_RU, { text: 'я'.repeat(room - 4) + '👍?' }),
          variant(LINKEDIN_RU, { at: '2026-10-12T10:12:09+03:00' }),
        ],
        [LINKEDIN_EN],
      ),
    );
    expect(res.statusCode).toBe(422);
    expect(errors(res)).toEqual([
      'slots.0.variants.1:duplicate_variant',
      'slots.0.variants.2.at:wrong_date',
      'slots.1.variants:variants_not_allowed',
      'slots.0.variants.0.text:em_dash',
      'slots.0.variants.1.text:too_long',
    ]);
    expect(res.json().errors[4]).toEqual({
      path: 'slots.0.variants.1.text',
      slotId: 's1',
      code: 'too_long',
      message: expect.stringContaining('501 units'),
    });
    expect(stored(c)).toEqual({ plan: undefined, slots: [], variants: [] });
  });

  it('a Threads text of exactly 500 units with the signature is stored', async () => {
    const c = setup();
    const room = 500 - threadsLength(`\n\n${SIGNATURE_LINE}`);
    const res = await post(
      c,
      v2Input([variant(THREADS_RU, { text: 'я'.repeat(room - 5) + '👍?' })]),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().md).toContain('### Threads · RU · 09:07:41 МСК · длина 500/500');
  });

  it('the idempotency hash covers the variants', async () => {
    const c = setup();
    expect((await post(c, v2Input())).statusCode).toBe(201);
    const first = stored(c);
    c.now = new Date(EVENING.getTime() + 60_000);
    expect((await post(c, v2Input())).statusCode).toBe(200);
    expect(stored(c)).toEqual(first);

    // Only one variant text differs: the plan is stored again.
    const edited = variant(THREADS_RU, { text: 'Тишина третий день. Кто нарушит её первым?' });
    const res = await post(c, v2Input([edited, LINKEDIN_RU, LINKEDIN_EN]));
    expect(res.statusCode).toBe(201);
    expect(c.store.plans.get(DATE)!.inputSha256).not.toBe(first.plan!.inputSha256);
    expect(variantRows(c)[0]![5]).toEqual({ ...edited, text: signed(edited.text) });
    expect(res.json().md).toContain(edited.text);
    expect(res.json().md).not.toContain(THREADS_RU.text);
  });

  it('a new POST of a draft replaces its variants', async () => {
    const c = setup();
    await post(c, v2Input());
    c.store.slotVariants.setStatus(DATE, 's1', 'threads', 'ru', 'skipped');
    expect(variantRows(c)).toHaveLength(3);

    const moved = variant(THREADS_RU, { at: `${DATE}T11:03:17+03:00` });
    expect((await post(c, v2Input([moved]))).statusCode).toBe(201);
    expect(variantRows(c)).toEqual([
      ['s1', 'threads', 'ru', moved.at, 'planned', { ...moved, text: signed(moved.text) }],
    ]);

    // Back to a plan without variants: no rows are left, and the plan is the v1 plan again.
    expect((await post(c, v1Input())).statusCode).toBe(201);
    expect(variantRows(c)).toEqual([]);
    const v1 = setup();
    await post(v1, v1Input());
    expect(c.store.plans.get(DATE)!.json).toBe(v1.store.plans.get(DATE)!.json);
    expect(c.store.plans.get(DATE)!.md).toBe(v1.store.plans.get(DATE)!.md);
  });

  it.each(['approved', 'rejected'] as const)('a %s plan stays locked, variants too', async (s) => {
    const c = setup();
    await post(c, v2Input());
    c.store.plans.setStatus(DATE, s);
    const before = stored(c);
    for (const body of [v2Input([THREADS_RU]), v1Input()]) {
      const res = await post(c, body);
      expect(res.statusCode).toBe(409);
      expect(res.json().status).toBe(s);
    }
    expect(stored(c)).toEqual(before);
    expect(before.variants).toHaveLength(3);
  });

  it('an empty or null variants list is a plan without variants', async () => {
    const c = setup();
    const input = v1Input();
    input.slots[0]!.variants = [];
    input.slots[1]!.variants = null;
    expect((await post(c, input)).statusCode).toBe(201);
    const v1 = setup();
    await post(v1, v1Input());
    expect(c.store.plans.get(DATE)!.json).toBe(v1.store.plans.get(DATE)!.json);
    expect(variantRows(c)).toEqual([]);
  });
});

describe('PUT /v1/plans/:date/slots/:slotId on a plan with variants', () => {
  const MORNING = new Date('2026-10-11T05:00:00Z'); // 08:00 MSK on the plan date

  async function approved() {
    const c = setup();
    await post(c, v2Input());
    c.store.plans.setStatus(DATE, 'approved');
    c.now = MORNING;
    return c;
  }

  it('replaces the Telegram text only; the variants stay as approved', async () => {
    const c = await approved();
    const before = stored(c);
    const res = await put(c, 's1', { text: 'Новый текст. Кто заметил?', reason: 'owner asked' });
    expect(res.statusCode, res.body).toBe(200);

    const plan = PlanV2Schema.parse(planJson(c));
    expect(plan.slots[0]!.text).toBe(signed('Новый текст. Кто заметил?'));
    expect(plan.slots[0]!.variants).toEqual(JSON.parse(before.plan!.json).slots[0].variants);
    expect(stored(c).variants).toEqual(before.variants);
    const row = c.store.slots.listForPlan(DATE).find((s) => s.slotId === 's1')!;
    expect(JSON.parse(row.json)).toEqual({ ...plan.slots[0], variants: undefined });
    expect(row.json).not.toContain('variants');

    // plan.md: the new Telegram text and every variant block, unchanged.
    const md = res.json().md as string;
    expect(md).toContain('Новый текст. Кто заметил?');
    const blocks = (text: string) => {
      const s1 = text.split('\n\n---\n\n')[1]!;
      return s1.slice(s1.indexOf('### Threads'));
    };
    expect(blocks(md)).toBe(blocks(before.plan!.md));
    expect(
      blocks(md)
        .split('\n')
        .filter((l) => l.startsWith('### ')),
    ).toHaveLength(3);
    expect(blocks(md)).toContain(signed(LINKEDIN_EN.text));
  });

  it('refuses `variants` in the body: they cannot be changed after approval', async () => {
    const c = await approved();
    const before = stored(c);
    const res = await put(c, 's1', {
      text: 'Новый текст. Кто заметил?',
      reason: 'x',
      variants: [THREADS_RU],
    });
    expect(res.statusCode).toBe(422);
    expect(errors(res)).toEqual(['variants:unrecognized_key']);
    expect(stored(c)).toEqual(before);
  });
});
