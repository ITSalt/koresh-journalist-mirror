// A variant publisher process for the restart tests of WP-PLAT-02: one `runOnce` of one
// platform's loop over a scripted adapter, then exit. No platform code, no network: a post that
// is "carried out" is one line appended to POSTS_FILE, which is what readers would see.
// Env: DB (sqlite file), NOW (ISO), PLATFORM (threads | linkedin), POSTS_FILE,
// CRASH_AFTER_INTENT=1 to SIGKILL itself right after the claim (before the adapter is asked),
// CRASH_AFTER_PUBLISH=1 to SIGKILL itself right after the post is public (before the result is
// recorded), COMMENT=1 for an adapter with `comment` and a first comment that is always due,
// CRASH_AFTER_COMMENT=1 to SIGKILL itself right after the comment is public.
import { appendFileSync } from 'node:fs';
import type { VariantPlatform } from '../../src/plan/schema.js';
import type { PlatformAdapter } from '../../src/platforms/types.js';
import { createVariantPublisher } from '../../src/publish/variant-publisher.js';
import { openStore } from '../../src/store/index.js';
import { blocks } from './blocks.js';

const env = process.env;
const platform = env.PLATFORM as VariantPlatform;
const store = openStore(env.DB!);
const die = () => process.kill(process.pid, 'SIGKILL');

if (env.CRASH_AFTER_INTENT === '1') {
  const begin = store.publications.beginVariantIntent.bind(store.publications);
  store.publications.beginVariantIntent = (i, at) => {
    const p = begin(i, at);
    die();
    return p;
  };
}

const record = (line: object) =>
  appendFileSync(env.POSTS_FILE!, `${JSON.stringify(line)}\n`, { flush: true });

const adapter: PlatformAdapter = {
  platform,
  validate: () => [],
  async publish(input) {
    record({ kind: 'post', key: input.key, text: input.text });
    if (env.CRASH_AFTER_PUBLISH === '1') die();
    return { ok: true, result: { id: `${platform}-1`, url: `https://${platform}.example/1` } };
  },
  async health() {
    return { ok: true, detail: 'child' };
  },
};
if (env.COMMENT === '1') {
  adapter.comment = async (postId, text, key) => {
    record({ kind: 'comment', key, postId, text });
    if (env.CRASH_AFTER_COMMENT === '1') die();
    return { ok: true, result: { id: `${platform}-c1` } };
  };
}

const now = new Date(env.NOW!);
const publisher = createVariantPublisher({
  store,
  blocks,
  platform,
  adapter,
  dryRun: false,
  tz: 'Europe/Moscow',
  now: () => now,
  ...(env.COMMENT === '1'
    ? { link: 'https://t.me/Channel1/57', firstComment: { due: () => true } }
    : {}),
});
const it = await publisher.runOnce();
process.stdout.write(`${JSON.stringify(it)}\n`);
store.close();
