// A process for the restart test of scope item 11a (WP-PLAT-02): the merged Threads adapter,
// wired by the registry exactly as the service wires it (its two publish steps recorded on the
// variant's publication row), against the fake Threads server.
// Env: DB (sqlite file), NOW (ISO), BASE_URL (the fake), THREADS_TOKEN (the tests' made-up
// marker), CRASH_AFTER_STEP=container|publish to SIGKILL itself right after that step is on the
// row (before the next request leaves). MODE=loop (default): one `runOnce` of the Threads loop.
// MODE=adapter: one `adapter.publish` for KEY and TEXT, bypassing the loop's own guards, to show
// what the step record alone does.
import { loadConfig } from '../../src/config.js';
import { createPlatforms } from '../../src/platforms/registry.js';
import { createMemoryTokenStore } from '../../src/platforms/threads/index.js';
import { openStore } from '../../src/store/index.js';
import { blocks } from './blocks.js';

const env = process.env;
const store = openStore(env.DB!);
if (env.CRASH_AFTER_STEP) {
  const set = store.publications.setStep.bind(store.publications);
  store.publications.setStep = (key, step) => {
    set(key, step);
    if ((JSON.parse(step) as { step: string }).step === env.CRASH_AFTER_STEP) {
      process.kill(process.pid, 'SIGKILL');
    }
  };
}
const now = new Date(env.NOW!);
const platforms = createPlatforms({
  config: loadConfig({ DRY_RUN_THREADS: 'false', THREADS_API_BASE_URL: env.BASE_URL! }),
  store,
  blocks,
  tokens: { threads: createMemoryTokenStore(env.THREADS_TOKEN!) },
  now: () => now,
  sleep: async () => undefined,
});
const threads = platforms.list.find((r) => r.platform === 'threads')!;
const out =
  env.MODE === 'adapter'
    ? await threads.adapter!.publish({ key: env.KEY!, text: env.TEXT!, lang: 'ru' })
    : await threads.loop!.runOnce();
process.stdout.write(`${JSON.stringify(out)}\n`);
store.close();
