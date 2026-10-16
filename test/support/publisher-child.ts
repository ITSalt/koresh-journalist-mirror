// A publisher process for the restart tests: one `runOnce` against the fake Bot API, then exit.
// Env: DB (sqlite file), BASE_URL (fake Bot API), BOT_TOKEN, NOW (ISO), CRASH_AFTER_INTENT=1 to
// SIGKILL itself right after the first beginIntent (before the request leaves). CRASH_AFTER_SENT=n
// to SIGKILL itself right after the n-th markSent (between two parts of a slot). GO_FILE: print
// `ready`, then start the iteration the moment that file appears (the slot replacement race).
import { existsSync } from 'node:fs';
import { createPublisher } from '../../src/publish/publisher.js';
import { openStore } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { blocks } from './blocks.js';

const env = process.env;
const store = openStore(env.DB!);
if (env.CRASH_AFTER_INTENT === '1') {
  const begin = store.publications.beginIntent.bind(store.publications);
  store.publications.beginIntent = (i, at) => {
    const p = begin(i, at);
    process.kill(process.pid, 'SIGKILL');
    return p;
  };
}
if (env.CRASH_AFTER_SENT) {
  const sent = store.publications.markSent.bind(store.publications);
  let left = Number(env.CRASH_AFTER_SENT);
  store.publications.markSent = (key, messageId, at) => {
    const p = sent(key, messageId, at);
    if (--left === 0) process.kill(process.pid, 'SIGKILL');
    return p;
  };
}
const now = new Date(env.NOW!);
const publisher = createPublisher({
  store,
  blocks,
  api: createBotApi({ token: env.BOT_TOKEN!, baseUrl: env.BASE_URL!, timeoutMs: 10_000 }),
  channel: '@test_channel',
  dryRun: false,
  tz: 'Europe/Moscow',
  now: () => now,
  sleep: async () => undefined,
});
if (env.GO_FILE) {
  process.stdout.write('ready\n');
  const deadline = Date.now() + 20_000;
  while (!existsSync(env.GO_FILE) && Date.now() < deadline);
}
const it = await publisher.runOnce();
process.stdout.write(`${JSON.stringify(it)}\n`);
store.close();
