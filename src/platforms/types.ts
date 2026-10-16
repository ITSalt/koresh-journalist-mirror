// The adapter contract (WP-PLAT-02, section 1a): the one copy. The Threads and LinkedIn adapters
// import these types and nothing else from outside their own directory; the publish loop of a
// platform talks to its adapter through `PlatformAdapter` only.
//
// `unknown` = the request may have reached the platform (timeout, reset, unreadable 2xx): never
// resent automatically. `refused` = the platform said no (4xx): not retried. `failed` = retries
// exhausted before any create request was accepted (429 with retry_after, refused connection,
// DNS). D-3: a 5xx answer to a call that creates public content is `unknown`, never retried; 5xx
// may be retried only on calls that create nothing public (reads, an unpublished Threads
// container, token refresh). D-4: on a call that makes content public, an error answer to a
// second or later attempt for the same object is `unknown`, never a clean refusal, because the
// first attempt may have been carried out; EHOSTUNREACH and ENETUNREACH are never "not sent" for
// such calls. Descriptions are scrubbed of tokens.

export type Platform = 'telegram' | 'threads' | 'linkedin';
export type Outcome<T> =
  | { ok: true; result: T }
  | {
      ok: false;
      outcome: 'refused' | 'failed' | 'unknown';
      description: string;
      retryAfterS?: number;
    };
export interface PublishInput {
  key: string;
  text: string;
  lang: 'ru' | 'en';
  link?: string;
}
export interface PlatformAdapter {
  platform: Platform;
  /** Pure, no network. */
  validate(input: PublishInput): { code: string; message: string }[];
  /** Exactly one public post or none. */
  publish(input: PublishInput): Promise<Outcome<{ id: string; url?: string }>>;
  comment?(postId: string, text: string, key: string): Promise<Outcome<{ id: string }>>;
  health(): Promise<{ ok: boolean; detail: string; tokenExpiresAt?: string }>;
}
