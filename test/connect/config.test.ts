import { describe, expect, it } from 'vitest';
import { loadConfig, SECRET_KEYS } from '../../src/config.js';
import { DEFAULT_THREADS_AUTHORIZE_URL } from '../../src/connect/oauth.js';
import { DEFAULT_BASE_URL } from '../../src/platforms/threads/platform-facts.js';
import { makeScrubber, redactPaths } from '../../src/server.js';

describe('connect settings (WP-PLAT-06)', () => {
  it('are all optional: an empty environment still loads', () => {
    const c = loadConfig({});
    for (const k of [
      'PUBLIC_BASE',
      'TOKEN_STORE_KEY',
      'THREADS_APP_ID',
      'THREADS_APP_SECRET',
      'LINKEDIN_CLIENT_ID',
      'LINKEDIN_CLIENT_SECRET',
      'THREADS_EXPECTED_USERNAME',
      'LINKEDIN_EXPECTED_SUB',
    ] as const) {
      expect(c[k]).toBeUndefined();
    }
  });

  it('a wrong PUBLIC_BASE or TOKEN_STORE_KEY does not stop the service from starting', () => {
    // Checked by src/connect/ (start answers 409 and names it); loading must not throw.
    const c = loadConfig({ PUBLIC_BASE: 'not a url', TOKEN_STORE_KEY: 'short' });
    expect(c.PUBLIC_BASE).toBe('not a url');
    expect(c.DRY_RUN).toBe(true);
  });

  it('the platform addresses default to the documented ones', () => {
    const c = loadConfig({});
    expect(c.THREADS_AUTHORIZE_URL).toBe(DEFAULT_THREADS_AUTHORIZE_URL);
    // One base URL for every Threads call of the service: the adapter's own fact.
    expect(c.THREADS_API_BASE_URL).toBe(DEFAULT_BASE_URL);
    expect(c.LINKEDIN_OAUTH_BASE_URL).toBe('https://www.linkedin.com');
    expect(c.LINKEDIN_API_BASE_URL).toBe('https://api.linkedin.com');
  });

  it('the app secrets and the store key are secrets: redacted by key and scrubbed by value', () => {
    for (const k of ['THREADS_APP_SECRET', 'LINKEDIN_CLIENT_SECRET', 'TOKEN_STORE_KEY'] as const) {
      expect(SECRET_KEYS).toContain(k);
      expect(redactPaths()).toContain(k);
      expect(redactPaths()).toContain(`*.${k}`);
    }
    const key = 'a+b/c' + 'A'.repeat(38) + '=';
    const scrub = makeScrubber(
      loadConfig({
        THREADS_APP_SECRET: 'FAKE-THREADS-SECRET-1',
        LINKEDIN_CLIENT_SECRET: 'FAKE-LINKEDIN-SECRET-2',
        TOKEN_STORE_KEY: key,
      }),
    );
    const line = `a FAKE-THREADS-SECRET-1 b FAKE-LINKEDIN-SECRET-2 c ${key} d ${encodeURIComponent(key)}`;
    expect(scrub(line)).toBe('a [REDACTED] b [REDACTED] c [REDACTED] d [REDACTED]');
  });
});
