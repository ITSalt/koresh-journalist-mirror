import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SIGNATURE_LINE } from '../../src/plan/pipeline.js';
import { openStore } from '../../src/store/index.js';
import { DATE, msk } from '../publish/helpers.js';
import { seedVariantPlan } from '../publish/variant-helpers.js';
import { FakeThreads } from '../support/fake-threads.js';

// WP-PLAT-02 scope item 11a: the two-step protection of the Threads adapter survives a restart,
// because its step record is the variant's publication row. The service's own wiring runs in a
// real child process that is SIGKILLed right after a step is on the row; a new process then
// starts on the same SQLite file. The fake Threads server counts what readers would see.

const CHILD = fileURLToPath(new URL('../support/variant-threads-child.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** A made-up marker, not a real token. */
const TOKEN = 'THMARKER0fake0token0for0tests0only0xxxxxxxxxxxx';
const KEY = `threads:${DATE}:s1-ru:0`;
const BODY = 'Тишина третий день. Кто нарушит её первым?';
const TEXT = `${BODY}\n\n${SIGNATURE_LINE}`;

let fake: FakeThreads;
let dir: string;
let db: string;
beforeEach(async () => {
  fake = await new FakeThreads(TOKEN).start();
  dir = mkdtempSync(join(tmpdir(), 'jrn-threads-row-'));
  db = join(dir, 'journalist.db');
  const store = openStore(db);
  seedVariantPlan(
    store,
    [{ id: 's1', at: '09:00', text: 'Утро. Кто первый?' }],
    [{ slot: 's1', platform: 'threads', at: '09:07:41', text: BODY }],
  );
  store.close();
});
afterEach(async () => {
  fake.onRequest = undefined;
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

let current: ChildProcess | undefined;

function run(now: Date, extra: Record<string, string> = {}) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>(
    (resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          DB: db,
          BASE_URL: fake.baseUrl,
          THREADS_TOKEN: TOKEN,
          NOW: now.toISOString(),
          ...extra,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      current = child;
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.stderr.on('data', (c: Buffer) => (out += c.toString()));
      child.on('exit', (code, signal) => resolve({ code, signal, out }));
    },
  );
}
const last = (out: string) => JSON.parse(out.trim().split('\n').pop()!) as Record<string, unknown>;
const state = () => {
  const s = openStore(db);
  try {
    return { row: s.publications.get(KEY), alerts: s.alerts.list() };
  } finally {
    s.close();
  }
};
const publishRequests = () => fake.sent('publish').length;

describe('killed between the step record and the publish request', () => {
  it('the restart sends no publish request: no second public post, unknown and one alert', async () => {
    const first = await run(msk('09:07:41'), { CRASH_AFTER_STEP: 'publish' });
    expect(first.signal).toBe('SIGKILL');
    // The container exists (invisible), step `publish` is on the row, no publish request left.
    expect(fake.sent('container')).toHaveLength(1);
    expect(publishRequests()).toBe(0);
    const killed = state().row!;
    expect(killed.status).toBe('intent');
    expect(JSON.parse(killed.step!)).toMatchObject({ step: 'publish' });

    for (const at of ['09:08:11', '09:10:41', '09:30']) {
      const next = await run(msk(at));
      expect(next.code, next.out).toBe(0);
    }
    expect(publishRequests()).toBe(0);
    expect(fake.posts).toEqual([]);
    const { row, alerts } = state();
    expect(row!.status).toBe('unknown');
    expect(alerts.map((a) => a.kind)).toEqual(['publish_unknown']);
    expect(JSON.stringify(alerts)).not.toContain(TOKEN);
  }, 60_000);

  it('even asked directly, the adapter refuses to publish again: the row holds the step', async () => {
    await run(msk('09:07:41'), { CRASH_AFTER_STEP: 'publish' });
    // The row is still an intent (30 s old). Bypass the loop and ask the adapter itself.
    const direct = await run(msk('09:08:11'), { MODE: 'adapter', KEY, TEXT });
    expect(direct.code, direct.out).toBe(0);
    const outcome = last(direct.out);
    expect(outcome).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(String(outcome.description)).toMatch(/^publish_already_started/);
    expect(publishRequests()).toBe(0);
    expect(fake.sent('container')).toHaveLength(1);
    expect(fake.posts).toEqual([]);
  }, 60_000);

  it('killed after the publish request left: exactly one public post', async () => {
    fake.queue('publish', { hang: true }); // carried out, but the answer never comes
    fake.onRequest = (r) => {
      if (r.op === 'publish') setTimeout(() => current?.kill('SIGKILL'), 50);
    };
    const first = await run(msk('09:07:41'));
    expect(first.signal).toBe('SIGKILL');
    expect(fake.posts).toHaveLength(1);
    expect(JSON.parse(state().row!.step!)).toMatchObject({ step: 'publish' });

    for (const at of ['09:08:11', '09:10:41', '09:30']) {
      const next = await run(msk(at));
      expect(next.code, next.out).toBe(0);
    }
    expect(publishRequests()).toBe(1);
    expect(fake.posts).toHaveLength(1);
    const { row, alerts } = state();
    expect(row!.status).toBe('unknown');
    expect(alerts.map((a) => a.kind)).toEqual(['publish_unknown']);
  }, 60_000);

  it('killed after the container step only: nothing was public, and the item is not resent', async () => {
    const first = await run(msk('09:07:41'), { CRASH_AFTER_STEP: 'container' });
    expect(first.signal).toBe('SIGKILL');
    for (const at of ['09:08:11', '09:10:41']) await run(msk(at));
    // The core never resends an intent that was left without a result (a missed post is
    // cheaper than a doubled one), so the fresh-container path of the adapter is not taken.
    expect(publishRequests()).toBe(0);
    expect(fake.posts).toEqual([]);
    expect(state().row!.status).toBe('unknown');
  }, 60_000);
});
