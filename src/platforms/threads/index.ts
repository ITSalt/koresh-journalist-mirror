// Threads adapter (WP-PLAT-03). Self-contained but for the two things that exist once in the
// service (WP-PLAT-02): the adapter contract (`../types.ts`) and the Threads length counter
// (`../../lib/threads-length.ts`). The registry (`../registry.ts`) wires it into the publish loop.
export {
  createThreadsAdapter,
  type ThreadsAdapter,
  type ThreadsAdapterOptions,
} from './adapter.js';
export {
  createThreadsClient,
  TOKEN_INVALID,
  type PublishCallOutcome,
  type RetryOptions,
  type ThreadsClient,
  type ThreadsClientOptions,
} from './client.js';
export { createMemoryStepStore, type PublishStep, type PublishStepStore } from './step-store.js';
export { createMemoryTokenStore, type TokenStore } from './token-store.js';
export { fitsThreads, THREADS_LIMIT, threadsLength } from '../../lib/threads-length.js';
export { validate, type Issue } from './validate.js';
export type { Outcome, Platform, PlatformAdapter, PublishInput } from '../types.js';
