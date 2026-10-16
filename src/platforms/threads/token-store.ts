// Where the Threads token lives: the seam the adapter reads through. The persistent, encrypted
// store is the account-connect package's (`src/connect/service.ts`, `tokenStore`); the in-memory
// implementation here is for tests. No token is read from the environment (D-5); a token value is
// never logged.

export interface TokenStore {
  get(): string;
  /** `expiresAt`: ISO 8601 instant. */
  set(token: string, expiresAt: string): void;
  /** Expiry of the current token, when the store knows it (it does after the first refresh). */
  expiresAt?(): string | undefined;
}

export function createMemoryTokenStore(token: string, expiresAt?: string): TokenStore {
  let current = token;
  let expiry = expiresAt;
  return {
    get: () => current,
    set(next, nextExpiry) {
      current = next;
      expiry = nextExpiry;
    },
    expiresAt: () => expiry,
  };
}
