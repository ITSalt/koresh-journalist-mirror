import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrub } from '../../../src/platforms/threads/scrub.js';
import { createMemoryTokenStore } from '../../../src/platforms/threads/token-store.js';
import { FakeThreads, type ThreadsOp, type ThreadsReply } from '../../support/fake-threads.js';
import { input, rig, TOKEN } from './helpers.js';

// Acceptance 2: the token is never in an error, a log line or a thrown message. TOKEN is a
// made-up marker; every scenario below collects all the adapter gives back and all it prints.

let fake: FakeThreads;
let printed: string[];
beforeEach(async () => {
  fake = await new FakeThreads(TOKEN).start();
  printed = [];
  const keep = (...args: unknown[]) => {
    printed.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    return true;
  };
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, m).mockImplementation(keep);
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(keep);
  vi.spyOn(process.stderr, 'write').mockImplementation(keep);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake.stop();
});

/** The platform echoing the token back, as it does for a malformed one. */
const echo = (token: string): ThreadsReply => ({
  status: 400,
  error: { message: `Malformed access token ${token}`, code: 190 },
});
const echoInUrl = (token: string): ThreadsReply => ({
  status: 400,
  error: {
    message: `Bad request: /v1.0/me/threads?access_token=${encodeURIComponent(token)}&text=x`,
    code: 100,
  },
});

const OPS: ThreadsOp[] = ['quota', 'container', 'publish', 'permalink', 'me', 'refresh'];
const replies = (token: string): ThreadsReply[] => [
  echo(token),
  echoInUrl(token),
  { status: 500, error: { message: `server error for ${token}` } },
  { status: 429, error: { message: `slow down ${token}` }, retryAfter: 1 },
  { raw: `<html>${token}</html>`, applied: false },
  { drop: true, applied: false },
];

async function everything(token: string): Promise<string> {
  const out: unknown[] = [];
  let n = 0;
  for (const op of OPS) {
    for (const reply of replies(token)) {
      fake.replies[op] = [reply];
      const { adapter } = rig(fake, {
        tokens: createMemoryTokenStore(token),
        retry: { maxAttempts: 1 },
      });
      try {
        out.push(await adapter.publish(input({ key: `k${n++}` })));
        out.push(await adapter.health());
        out.push(await adapter.refreshToken());
      } catch (err) {
        out.push({ thrown: String(err), stack: (err as Error).stack });
      }
      for (const o of OPS) fake.replies[o] = [];
    }
  }
  return JSON.stringify(out);
}

describe('the token never leaves the adapter', () => {
  it('not in any outcome, health detail, thrown message or printed line', async () => {
    fake.tokenIssuedAt = new Date('2026-09-01T00:00:00.000Z');
    fake.nextTokens.push(...Array.from({ length: 100 }, () => TOKEN));
    const out = await everything(TOKEN);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('"thrown"');
    expect(out).toContain('[redacted]');
    expect(printed.join('\n')).not.toContain(TOKEN);
    expect(printed).toEqual([]);
  }, 30_000);

  it('not when the token holds characters that are encoded in a URL', async () => {
    const odd = 'THMARKER/odd+token=with|signs&more';
    fake.token = odd;
    fake.tokenIssuedAt = new Date('2026-09-01T00:00:00.000Z');
    fake.nextTokens.push(...Array.from({ length: 100 }, () => odd));
    const out = await everything(odd);
    expect(out).not.toContain(odd);
    expect(out).not.toContain(encodeURIComponent(odd));
    expect(out).not.toContain('"thrown"');
  }, 30_000);

  it('not when the network layer throws an error that carries the URL', async () => {
    const leaking: typeof fetch = async (url) => {
      throw Object.assign(new Error(`request to ${String(url)} failed`), {
        name: `FetchError ${String(url)}`,
        cause: new Error(String(url)),
      });
    };
    const { adapter } = rig(fake, { fetch: leaking, retry: { maxAttempts: 1 } });
    const out = JSON.stringify([
      await adapter.publish(input()),
      await adapter.health(),
      await adapter.refreshToken(),
    ]);
    expect(out).not.toContain(TOKEN);
    expect(printed).toEqual([]);
  });

  it('not when a step record itself carries the token', async () => {
    const { adapter, steps } = rig(fake);
    steps.set(input().key, { step: 'publish', containerId: TOKEN, at: 'earlier' });
    expect(JSON.stringify(await adapter.publish(input()))).not.toContain(TOKEN);
  });
});

describe('scrub', () => {
  it('removes a secret as it is and URL-encoded', () => {
    expect(scrub('a s3cr/t b s3cr%2Ft c', ['s3cr/t'])).toBe('a [redacted] b [redacted] c');
  });

  it('removes any access_token or client_secret pair, whatever its value', () => {
    expect(scrub('GET /x?access_token=abc123&fields=id client_secret=zzz', [])).toBe(
      'GET /x?access_token=[redacted]&fields=id client_secret=[redacted]',
    );
  });

  it('leaves other text alone and ignores an empty secret', () => {
    expect(scrub('threads: Param text is bad (code 100)', [''])).toBe(
      'threads: Param text is bad (code 100)',
    );
  });
});
