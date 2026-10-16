import type { Outcome, PlatformAdapter, PublishInput } from '../../src/platforms/types.js';

// A scripted adapter for the tests of the adapter core (WP-PLAT-02 scope item 7): no platform
// code, no network. Every call of every method is recorded; `publish` and `comment` answer from
// a queue (an empty queue accepts) and can run a hook first, which is how a test looks at the
// database at the very moment the request would leave.

export type Scripted<T> =
  /** Answer with this outcome. */
  | Outcome<T>
  /** Carry the call out and answer normally. */
  | 'ok'
  /** Carry the call out and never answer. */
  | 'hang'
  /** Throw instead of answering. */
  | 'throw';

export interface FakeAdapter extends PlatformAdapter {
  platform: 'threads' | 'linkedin';
  /** Every method call, in order. */
  calls: string[];
  /** What readers would see: the inputs of the posts that were carried out. */
  posts: PublishInput[];
  /** The comments that were carried out. */
  comments: { postId: string; text: string; key: string }[];
  publishQueue: Scripted<{ id: string; url?: string }>[];
  commentQueue: Scripted<{ id: string }>[];
  /** What `validate` answers (default: no issue). */
  issues: (input: PublishInput) => { code: string; message: string }[];
  onPublish?: (input: PublishInput) => void | Promise<void>;
  onComment?: (postId: string, text: string, key: string) => void | Promise<void>;
  healthState: { ok: boolean; detail: string; tokenExpiresAt?: string };
}

const never = () => new Promise<never>(() => undefined);

export function fakeAdapter(
  platform: 'threads' | 'linkedin',
  o: { comment?: boolean } = {},
): FakeAdapter {
  const a: FakeAdapter = {
    platform,
    calls: [],
    posts: [],
    comments: [],
    publishQueue: [],
    commentQueue: [],
    issues: () => [],
    healthState: { ok: true, detail: 'fake ok' },
    validate(input) {
      a.calls.push('validate');
      return a.issues(input);
    },
    async publish(input) {
      a.calls.push('publish');
      await a.onPublish?.(input);
      const next = a.publishQueue.shift() ?? 'ok';
      if (next === 'throw') throw new TypeError('fetch failed');
      if (typeof next === 'object') {
        if (next.ok) a.posts.push(input);
        return next;
      }
      a.posts.push(input);
      if (next === 'hang') return never();
      const n = a.posts.length;
      return {
        ok: true,
        result: { id: `${platform}-post-${n}`, url: `https://${platform}.example/p/${n}` },
      };
    },
    async health() {
      a.calls.push('health');
      return a.healthState;
    },
  };
  if (o.comment) {
    a.comment = async (postId, text, key) => {
      a.calls.push('comment');
      await a.onComment?.(postId, text, key);
      const next = a.commentQueue.shift() ?? 'ok';
      if (next === 'throw') throw new TypeError('fetch failed');
      if (typeof next === 'object') {
        if (next.ok) a.comments.push({ postId, text, key });
        return next;
      }
      a.comments.push({ postId, text, key });
      if (next === 'hang') return never();
      return { ok: true, result: { id: `${platform}-comment-${a.comments.length}` } };
    };
  }
  return a;
}

export const unknown = (description = 'no_answer: create post: TimeoutError') =>
  ({ ok: false, outcome: 'unknown', description }) as const;
export const refused = (description = 'rejected: HTTP 400') =>
  ({ ok: false, outcome: 'refused', description }) as const;
export const failed = (description = 'rate_limited: HTTP 429', retryAfterS?: number) =>
  ({
    ok: false,
    outcome: 'failed',
    description,
    ...(retryAfterS !== undefined ? { retryAfterS } : {}),
  }) as const;
