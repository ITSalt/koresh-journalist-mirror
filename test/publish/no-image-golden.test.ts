import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createPublisher, type PublisherOptions } from '../../src/publish/publisher.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';
import { CHANNEL, DATE, longText, msk, seedPlan, TOKEN, type SlotSpec } from './helpers.js';

// WP-SVC-24 acceptance 1: a slot without `image` behaves byte for byte as before the package.
// The snapshot of this file was recorded on main (0fa915d, WP-SVC-23 merged) BEFORE any image
// change, in a commit of its own that touches no file under src/, and is never updated by this
// package: it holds every Bot API request, every publication row (key, part, hash, status,
// message id), the slot statuses, the alerts, the preview answer and the test-publish requests of
// one day made of slots without an image. The test uses only what existed then, so it runs
// unchanged on main.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const OWNER_CHAT = '123456789';
const TRAILER = 'Обсуждение: https://t.me/example_chat (вход свободный).';

const DAY: SlotSpec[] = [
  { id: 's1', at: '09:00', text: 'Утро. Счёт 3:1, а кто считал?' },
  {
    id: 's2',
    at: '12:00',
    text: `**Дело №2. Хроника _от_ 08.10**\n\n> цитата один [a](b)\n> цитата **два**\n\n${longText()}`,
  },
  {
    id: 'q1',
    at: '15:00',
    kind: 'poll',
    text: 'Опрос к делу №2: кто прав?',
    poll: { question: 'Кто прав?', options: ['я', 'ты', 'никто'], allowsMultiple: true },
  },
  { id: 's4', at: '19:00', text: 'Вечер: 1+1=2, a*b, `код`, ~нет~, #тег. Что дальше?' },
];
const TIMES = ['09:00:30', '09:00:40', '12:00:30', '15:00:30', '19:00:30', '19:30'];

let fake: FakeBotApi;
let store: Store;
let t: Date;
beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
  fake.chats = {
    [CHANNEL]: { id: -1001, type: 'channel' },
    [OWNER_CHAT]: { id: 123456789, type: 'private' },
  };
  store = openStore(':memory:');
  t = msk('08:00');
});
afterEach(async () => {
  store.close();
  await fake.stop();
});

const api = () => createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 1000 });

function publisher(over: Partial<PublisherOptions> = {}) {
  return createPublisher({
    store,
    blocks,
    api: api(),
    channel: CHANNEL,
    dryRun: false,
    tz: 'Europe/Moscow',
    now: () => t,
    sleep: async () => undefined,
    ...over,
  });
}

const state = () => ({
  requests: fake.requests.map((r) => ({
    method: r.method,
    contentType: r.contentType,
    body: r.body,
    files: r.files,
  })),
  channel: fake.channel,
  publications: store.publications.listForPlan(DATE),
  slots: store.slots.listForPlan(DATE).map((s) => [s.slotId, s.status]),
  alerts: store.alerts.list(),
});

async function runDay(p: ReturnType<typeof publisher>) {
  const iterations = [];
  for (const at of TIMES) {
    t = msk(at);
    iterations.push(await p.runOnce());
  }
  return iterations;
}

describe('a day of slots without an image (golden, recorded before WP-SVC-24)', () => {
  it('live, no trailer', async () => {
    seedPlan(store, DAY);
    expect({ iterations: await runDay(publisher()), ...state() }).toMatchSnapshot();
  });

  it('live, with TG_TRAILER', async () => {
    seedPlan(store, DAY);
    expect({
      iterations: await runDay(publisher({ trailer: TRAILER })),
      ...state(),
    }).toMatchSnapshot();
  });

  it('DRY_RUN', async () => {
    seedPlan(store, DAY);
    expect({
      iterations: await runDay(publisher({ dryRun: true, api: undefined, trailer: TRAILER })),
      ...state(),
    }).toMatchSnapshot();
  });

  it('a lost answer and a refused (unsigned) slot', async () => {
    seedPlan(store, [DAY[0]!, { id: 's2', at: '12:00', text: 'Без подписи. Как так?' }], {
      raw: true,
    });
    // s1 is stored unsigned too: refused. Then a signed day with a dropped answer.
    const first = await runDay(publisher());
    const refused = state();
    store.close();
    store = openStore(':memory:');
    seedPlan(store, DAY);
    fake.queue('sendMessage', { drop: true });
    expect({ first, refused, iterations: await runDay(publisher()), ...state() }).toMatchSnapshot();
  });

  it('preview and test-publish', async () => {
    seedPlan(store, DAY);
    const app = buildServer({
      config: loadConfig({ JOURNALIST_API_TOKEN: API_TOKEN, TELEGRAM_BOT_TOKEN: TOKEN }),
      store,
      logLevel: 'silent',
      preflight: {
        blocks,
        channel: CHANNEL,
        testChannel: OWNER_CHAT,
        trailer: TRAILER,
        api: api(),
        sleep: async () => undefined,
      },
    });
    const previews = [];
    for (const at of ['09:00:30', '12:00:30', '15:00:30']) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/plans/${DATE}/preview?now=${encodeURIComponent(msk(at).toISOString())}`,
        headers: auth,
      });
      previews.push({ status: res.statusCode, body: res.json() });
      // The preview does not move the day: mark the slot done by hand to see the next one.
      const id = (res.json() as { slot?: { id: string } }).slot?.id;
      if (id) store.slots.setStatus(DATE, id, 'done');
    }
    const sends = [];
    for (const slotId of ['s1', 's2', 'q1']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/test-publish',
        headers: auth,
        payload: { date: DATE, slotId },
      });
      sends.push({ status: res.statusCode, body: res.json() });
    }
    expect({
      previews,
      sends,
      requests: fake.requests.map((r) => ({ method: r.method, body: r.body })),
      publications: store.publications.listForPlan(DATE),
      alerts: store.alerts.list().map((a) => [a.kind, a.message]),
    }).toMatchSnapshot();
  });
});
