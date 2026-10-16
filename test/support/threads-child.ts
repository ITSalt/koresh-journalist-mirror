// A process for the Threads restart tests: one `publish` against the fake Threads server, the
// outcome printed as one JSON line, then exit.
// Env: BASE_URL (the fake), THREADS_TOKEN (the tests' made-up marker), STEPS_FILE (a JSON file
// standing in for the caller's intent row), KEY, TEXT, and CRASH_AFTER_STEP=container|publish to
// SIGKILL itself right after that step is on disk (before the next request leaves).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createMemoryTokenStore,
  createThreadsAdapter,
  type PublishStep,
  type PublishStepStore,
} from '../../src/platforms/threads/index.js';

const env = process.env;
const file = env.STEPS_FILE!;

const read = (): Record<string, PublishStep> =>
  existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, PublishStep>) : {};

const steps: PublishStepStore = {
  get: (key) => read()[key],
  set(key, step) {
    writeFileSync(file, JSON.stringify({ ...read(), [key]: step }), { flush: true });
    if (env.CRASH_AFTER_STEP === step.step) process.kill(process.pid, 'SIGKILL');
  },
};

const adapter = createThreadsAdapter({
  tokens: createMemoryTokenStore(env.THREADS_TOKEN!),
  steps,
  baseUrl: env.BASE_URL!,
  timeoutMs: 10_000,
  sleep: async () => undefined,
});
const outcome = await adapter.publish({ key: env.KEY!, text: env.TEXT!, lang: 'ru' });
process.stdout.write(`${JSON.stringify(outcome)}\n`);
