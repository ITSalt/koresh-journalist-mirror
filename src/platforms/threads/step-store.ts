// The two recorded steps of one Threads publish item. Threads publishes in two calls: a container
// (invisible until published) and the publish call that makes it public. The adapter keeps no
// state: it writes each step here, and the caller backs this interface with its intent row.
//
//   container  a container exists and no publish request is out for it. Safe to start over: a
//              restart creates a fresh container and the old one stays invisible.
//   publish    written BEFORE the publish request leaves. From here on the post may be public, so
//              a later `publish` for the same key sends nothing and answers `unknown`.
//
// `set` must be durable when it returns: the adapter sends the publish request right after it.
//
// What this seam does NOT do: `set` is unconditional and `get` followed by `set` is not one
// atomic step, so two processes (or two adapters) that work on the same key at the same moment
// would both pass. The adapter's own guard against overlapping calls is per process only. The
// protection across processes is the caller's intent row: ONE guarded claim per key (a single
// SQL statement that succeeds for one claimant only) BEFORE `publish` is called, as the publish
// loop already does for Telegram. An implementation of this interface must sit behind that
// claim; it must never be the only thing between two workers and one key.

export interface PublishStep {
  step: 'container' | 'publish';
  containerId: string;
  /** ISO 8601 instant of the record. */
  at: string;
}

export interface PublishStepStore {
  get(key: string): PublishStep | undefined;
  set(key: string, step: PublishStep): void;
}

/** Protects within one process only; across restarts the caller's persistent store is needed. */
export function createMemoryStepStore(): PublishStepStore {
  const steps = new Map<string, PublishStep>();
  return {
    get: (key) => steps.get(key),
    set(key, step) {
      steps.set(key, step);
    },
  };
}
