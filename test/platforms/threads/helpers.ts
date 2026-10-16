import {
  createThreadsAdapter,
  type ThreadsAdapterOptions,
} from '../../../src/platforms/threads/adapter.js';
import {
  createMemoryStepStore,
  type PublishStepStore,
} from '../../../src/platforms/threads/step-store.js';
import {
  createMemoryTokenStore,
  type TokenStore,
} from '../../../src/platforms/threads/token-store.js';
import type { PublishInput } from '../../../src/platforms/types.js';
import type { FakeThreads } from '../../support/fake-threads.js';

/** A made-up marker, not a real token: tests assert it never shows up in any output. */
export const TOKEN = 'THMARKER0fake0token0for0tests0only0xxxxxxxxxxxx';
export const NOW = new Date('2026-10-12T12:00:00.000Z');
export const KEY = 'threads:2026-10-20:s1:0';

export const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  key: KEY,
  text: 'Чайник ушёл в 20:15. Кто его видел?',
  lang: 'ru',
  ...over,
});

export interface Rig {
  adapter: ReturnType<typeof createThreadsAdapter>;
  tokens: TokenStore;
  steps: PublishStepStore;
  /** Every wait the adapter asked for, in ms. */
  waits: number[];
}

export function rig(fake: FakeThreads, over: Partial<ThreadsAdapterOptions> = {}): Rig {
  const waits: number[] = [];
  const tokens = over.tokens ?? createMemoryTokenStore(TOKEN);
  const steps = over.steps ?? createMemoryStepStore();
  const adapter = createThreadsAdapter({
    timeoutMs: 2000,
    now: () => NOW,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...over,
    baseUrl: over.baseUrl ?? fake.baseUrl,
    tokens,
    steps,
  });
  return { adapter, tokens, steps, waits };
}

/** The write calls the fake received, in order. */
export const writes = (fake: FakeThreads) =>
  fake.ops().filter((op) => op === 'container' || op === 'publish');
