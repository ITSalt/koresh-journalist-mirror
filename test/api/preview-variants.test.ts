import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { SIGNATURE_LINE } from '../../src/plan/pipeline.js';
import { FRAME_TEXTS } from '../../src/platforms/frame.js';
import { createPlatforms, type Platforms } from '../../src/platforms/registry.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { DATE, msk, seedPlan } from '../publish/helpers.js';
import { seedVariantPlan } from '../publish/variant-helpers.js';
import { blocks } from '../support/blocks.js';
import { fakeAdapter } from '../support/fake-adapter.js';

// WP-PLAT-02 scope item 6: GET /v1/plans/:date/preview shows, per platform, the variants due at
// `now` with the composed text and the adapter's `validate` result. It reads only.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const BODY = 'Тишина третий день. Кто нарушит её первым?';
const signed = (text: string) => `${text}\n\n${SIGNATURE_LINE}`;

let store: Store;
let platforms: Platforms | undefined;
beforeEach(() => {
  store = openStore(':memory:');
  platforms = createPlatforms({ config: loadConfig({}), store, blocks });
});
afterEach(() => store.close());

const app = (withPlatforms = true) =>
  buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: API_TOKEN }),
    store,
    logLevel: 'silent',
    preflight: {
      blocks,
      channel: '@test_channel',
      ...(withPlatforms ? { platforms: () => platforms?.list ?? [] } : {}),
    },
  });
const preview = async (at: string, withPlatforms = true) => {
  const res = await app(withPlatforms).inject({
    method: 'GET',
    url: `/v1/plans/${DATE}/preview?now=${encodeURIComponent(msk(at).toISOString())}`,
    headers: auth,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
};
const everything = () =>
  JSON.stringify([
    store.plans.get(DATE),
    store.slots.listForPlan(DATE),
    store.slotVariants.listForPlan(DATE),
    store.publications.listForPlan(DATE),
    store.alerts.list(),
  ]);

const DAY = [{ id: 's1', at: '09:00', text: 'Утро. Кто первый?' }];
const VARIANTS = [
  { slot: 's1', platform: 'threads', at: '09:07:41', text: BODY },
  { slot: 's1', platform: 'linkedin', at: '10:12:09', text: BODY },
  { slot: 's1', platform: 'linkedin', lang: 'en', at: '10:40', text: 'Silence. Who breaks it?' },
] as const;

describe('GET /v1/plans/:date/preview with variants', () => {
  it('shows per platform what is due, with the composed text and the validate result', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const before = everything();

    const early = await preview('09:07:41');
    expect(early.variants).toEqual({
      threads: {
        dryRun: true,
        adapter: 'absent',
        decision: { publish: 's1-ru', skip: [] },
        due: [
          {
            id: 's1-ru',
            slotId: 's1',
            lang: 'ru',
            at: `${DATE}T09:07:41+03:00`,
            key: `threads:${DATE}:s1-ru:0`,
            text: signed(BODY),
            length: signed(BODY).length,
            issues: [],
          },
        ],
      },
      linkedin: {
        dryRun: true,
        adapter: 'absent',
        decision: { skip: [], wakeAt: msk('10:12:09').toISOString() },
        due: [],
      },
    });
    // The Telegram part of the answer is what it always was.
    expect(early.decision).toEqual({ publish: 's1', skip: [] });
    expect(early.slot.id).toBe('s1');

    const later = await preview('10:40');
    const f = FRAME_TEXTS.ru;
    expect(later.variants.linkedin.decision).toEqual({ publish: 's1-ru', skip: [] });
    expect(later.variants.linkedin.due.map((v: { id: string }) => v.id)).toEqual([
      's1-ru',
      's1-en',
    ]);
    expect(later.variants.linkedin.due[0]).toMatchObject({
      key: `linkedin:${DATE}:s1-ru:0`,
      // The default link mode is inline: the wording for a link in the post.
      text: `${f.header}\n\n${signed(BODY)}\n\n${f.disclaimer.inline.replace('{link}', 'https://t.me/Channel1/57')}`,
      issues: [],
    });
    expect(everything()).toBe(before);
  });

  it("the adapter's validate result is shown for a variant it would refuse", async () => {
    // Stored directly: such a text does not pass the plan POST.
    seedVariantPlan(store, DAY, [
      { slot: 's1', platform: 'threads', at: '09:07:41', text: `${'я'.repeat(600)}?` },
    ]);
    const body = await preview('09:07:41');
    expect(body.variants.threads.due[0].issues.map((i: { code: string }) => i.code)).toEqual([
      'too_long',
    ]);
  });

  it('a variant that is out, skipped or not yet due is not listed', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const threads = fakeAdapter('threads');
    platforms = createPlatforms({
      config: loadConfig({ DRY_RUN_THREADS: 'false' }),
      store,
      blocks,
      adapters: { threads },
      now: () => msk('09:07:41'),
    });
    await platforms.list[0]!.loop!.runOnce();
    store.slotVariants.setStatus(DATE, 's1', 'linkedin', 'ru', 'skipped');
    const body = await preview('10:30');
    expect(body.variants.threads).toMatchObject({ dryRun: false, adapter: 'present', due: [] });
    expect(body.variants.linkedin.due).toEqual([]);
    expect(body.variants.linkedin.decision).toEqual({
      skip: [],
      wakeAt: msk('10:40').toISOString(),
    });
  });

  it('a rejected day: nothing would be published on any platform', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS], { status: 'rejected' });
    const body = await preview('10:40');
    expect(body.variants.threads.decision).toEqual({ skip: [] });
    expect(body.variants.linkedin.decision).toEqual({ skip: [] });
  });

  it('without the registry the variants are still listed, with the default rules', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const body = await preview('09:07:41', false);
    expect(body.variants.threads.due[0]).toEqual({
      id: 's1-ru',
      slotId: 's1',
      lang: 'ru',
      at: `${DATE}T09:07:41+03:00`,
      key: `threads:${DATE}:s1-ru:0`,
      text: signed(BODY),
      length: signed(BODY).length,
    });
    expect(body.variants.threads.dryRun).toBeUndefined();
  });

  it('a day without variants has no `variants` key at all', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: 'Утро. Кто первый?' }]);
    const body = await preview('09:00:30');
    expect(Object.keys(body).sort()).toEqual(['date', 'decision', 'now', 'planStatus', 'slot']);
  });
});
