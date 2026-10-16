import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { runFallback } from '../../src/jobs/evening.js';
import { createOpenRouterClient } from '../../src/llm/openrouter.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { FakeOpenRouter } from '../llm/fake-openrouter.js';
import { seedImage } from '../support/images.js';
import { DATE, ENTRIES, llmPayload, validPlan } from './fixtures.js';

// WP-PLAT-01 acceptance 1: a v1 plan (no slot has `variants`) is stored and rendered byte for
// byte as before plan format v2. The snapshot of this file was recorded on 3d28264 (the head of
// WP-SVC-24, before any change of WP-PLAT-01), in a commit of its own that touches only files
// under test/, and is never updated by this package. It holds, for plans written through the
// plan POST, the slot PUT and the fallback: every answer, the stored plan row (json, md, status,
// input hash, times), the slot rows, the alerts, the 422 error list of a faulty plan and the
// fallback prompt built over stored plans. The test uses only what existed then, so it runs
// unchanged on the base.

const TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const EVENING = new Date('2026-10-10T17:00:00Z'); // 20:00 MSK on the 10th
const MORNING = new Date('2026-10-11T05:00:00Z'); // 08:00 MSK on the plan date

let store: Store;
let t: Date;
beforeEach(() => {
  store = openStore(':memory:');
  t = EVENING;
});
afterEach(() => store.close());

const server = () =>
  buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: TOKEN }),
    store,
    logLevel: 'silent',
    now: () => t,
  });
type App = ReturnType<typeof server>;

const seedFeed = (app: App) =>
  app.inject({
    method: 'POST',
    url: '/v1/feed',
    headers: auth,
    payload: [
      { id: 'e1', at: '2026-10-08T22:02:00+03:00', source: 'observer/LOG.md', text: 'one' },
      { id: 'e2', at: '2026-10-08T22:38:00+03:00', source: 'STATUS-TABLE.md', text: 'two' },
    ],
  });

async function call(app: App, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: auth,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  const type = String(res.headers['content-type'] ?? '');
  return { status: res.statusCode, body: type.includes('json') ? res.json() : res.body };
}

/** Everything the store holds for the plan date. */
const stored = (date = DATE) => ({
  plan: store.plans.get(date),
  slots: store.slots.listForPlan(date),
  alerts: store.alerts.list(),
});

/** A day of three slots: seconds in `at`, markdown, a poll in the middle. */
function threeSlots() {
  const p = validPlan();
  return [
    {
      id: 's1',
      at: `${DATE}T09:07:41+03:00`,
      platform: 'telegram',
      kind: 'post',
      text: '**Дело №3. Чайник**\n\n> цитата из лога\n\nСчёт 3:1 (a-b), а кто считал?',
      eventDate: '2026-10-09',
    },
    { ...p.slots[1]!, id: 'q1', at: `${DATE}T13:12:00+03:00` },
    {
      id: 's3',
      at: `${DATE}T19:09+03:00`,
      platform: 'telegram',
      kind: 'post',
      text: 'Вечер. "Кавычки", 1+1=2 и ссылка https://example.org/a?b=1. Что дальше?',
      eventDate: '2026-10-10',
    },
  ];
}

describe('a v1 plan through the plan POST (golden, recorded before WP-PLAT-01)', () => {
  it('the fixture plan with source entries: answer, stored rows, both GET routes', async () => {
    const app = server();
    await seedFeed(app);
    const p = validPlan();
    const posted = await call(app, 'POST', `/v1/plans/${DATE}`, {
      arc: p.arc,
      slots: p.slots,
      sourceEntryIds: ['e1', 'e2'],
    });
    expect({
      posted,
      ...stored(),
      json: await call(app, 'GET', `/v1/plans/${DATE}`),
      md: await call(app, 'GET', `/v1/plans/${DATE}.md`),
    }).toMatchSnapshot();
  });

  it('three slots, one with an image; the same body again; then a changed body', async () => {
    const app = server();
    const img = seedImage(store, 1280, 720);
    const slots = threeSlots() as Record<string, unknown>[];
    slots[0]!.image = { sha256: img.sha256, credit: 'zenith-claude' };
    const body = { arc: validPlan().arc, slots };
    const first = await call(app, 'POST', `/v1/plans/${DATE}`, body);
    const afterFirst = stored();
    const again = await call(app, 'POST', `/v1/plans/${DATE}`, structuredClone(body));
    const afterAgain = stored();
    t = new Date(EVENING.getTime() + 10 * 60_000);
    slots[2]!.text = 'Вечер, вторая редакция. Кто заметил разницу?';
    const changed = await call(app, 'POST', `/v1/plans/${DATE}`, body);
    expect({ first, afterFirst, again, afterAgain, changed, ...stored() }).toMatchSnapshot();
  });

  it('a plan without slots', async () => {
    const app = server();
    const posted = await call(app, 'POST', `/v1/plans/${DATE}`, {
      arc: { title: 'Нет материала', beat: 'пауза' },
      slots: [],
    });
    expect({ posted, ...stored() }).toMatchSnapshot();
  });

  it('a faulty plan: every error in one 422, nothing stored', async () => {
    const app = server();
    const slots = threeSlots() as Record<string, unknown>[];
    slots[0]!.text = 'Важно отметить: длинное тире — и «ёлочки».\n- пункт списка\nВопросов нет.';
    slots[0]!.at = '2026-10-12T09:07:41+03:00';
    slots[0]!.image = { sha256: 'f'.repeat(64), credit: 'автор — никто' };
    (slots[1]!.poll as { options: string[] }).options = ['один'];
    slots[1]!.image = { sha256: 'e'.repeat(64), credit: 'x' };
    slots[2]!.id = 's1';
    slots[2]!.text = 'я'.repeat(3600);
    slots.push({ id: 'bad:id', at: `${DATE}T08:00:00`, platform: 'threads', kind: 'story' });
    const posted = await call(app, 'POST', `/v1/plans/${DATE}`, {
      arc: { title: ' ' },
      slots,
      sourceEntryIds: ['nope'],
      version: 1,
    });
    expect({ posted, ...stored() }).toMatchSnapshot();
  });
});

describe('a v1 plan after approval (golden, recorded before WP-PLAT-01)', () => {
  it('a second POST is refused; the slot PUT replaces one text and keeps the rest', async () => {
    const app = server();
    const body = { arc: validPlan().arc, slots: threeSlots() };
    await call(app, 'POST', `/v1/plans/${DATE}`, body);
    store.plans.setStatus(DATE, 'approved');
    const approved = stored();
    const locked = await call(app, 'POST', `/v1/plans/${DATE}`, { ...body, slots: [] });
    t = MORNING;
    const replaced = await call(app, 'PUT', `/v1/plans/${DATE}/slots/s3`, {
      text: 'Вечер, правка владельца. Кто согласен?',
      reason: 'the owner asked for it',
    });
    const refused = await call(app, 'PUT', `/v1/plans/${DATE}/slots/s3`, {
      text: 'Без вопроса и с тире — вот так.',
      reason: 'x',
      // Not a key of the slot PUT, before and after plan format v2.
      variants: [],
    });
    expect({ approved, locked, replaced, refused, ...stored() }).toMatchSnapshot();
  });
});

describe('a v1 plan from the fallback (golden, recorded before WP-PLAT-01)', () => {
  let fake: FakeOpenRouter;
  beforeEach(async () => {
    fake = await new FakeOpenRouter().start();
  });
  afterEach(() => fake.stop());

  it('stores the draft; the prompt shows the stored plan of the day before', async () => {
    const app = server();
    // The day before: a plan stored through the POST and approved, so the prompt quotes it.
    const before = '2026-10-10';
    t = new Date('2026-10-09T17:00:00Z');
    const prev = threeSlots().map((s) => ({ ...s, at: before + s.at.slice(10) }));
    await call(app, 'POST', `/v1/plans/${before}`, { arc: validPlan().arc, slots: prev });
    store.plans.setStatus(before, 'approved');

    fake.replies.push({ content: llmPayload(), cost: 0.02 });
    const result = await runFallback(
      {
        store,
        plan: {
          store,
          llm: createOpenRouterClient({
            apiKey: 'fake-openrouter-key-for-tests',
            model: 'vendor/writer',
            baseUrl: fake.baseUrl,
          }),
          capUsd: 1,
          estimateUsd: 0.1,
          prompts: { styleBible: 'BIBLE', criteria: 'CRITERIA', rules: 'RULES' },
        },
        windowEntries: async () => ({ available: true, entries: ENTRIES }),
      },
      DATE,
      EVENING,
    );
    expect({
      result,
      prompt: fake.requests.map((r) => r.body.messages),
      ...stored(),
    }).toMatchSnapshot();
  });
});
