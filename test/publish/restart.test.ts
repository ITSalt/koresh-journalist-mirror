import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../../src/store/index.js';
import { FakeBotApi } from '../support/fake-bot-api.js';
import { DATE, msk, seedPlan, TOKEN } from './helpers.js';

// Acceptance 2: the publisher runs in a real child process that is SIGKILLed mid-publish, then a
// new process starts on the same SQLite file. The fake Bot API counts the channel's messages.

const CHILD = fileURLToPath(new URL('../support/publisher-child.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

let fake: FakeBotApi;
let dir: string;
let db: string;
beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
  dir = mkdtempSync(join(tmpdir(), 'jrn-restart-'));
  db = join(dir, 'journalist.db');
  const store = openStore(db);
  seedPlan(store, [{ id: 's1', at: '09:00', text: 'Утро. Кто первый?' }]);
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
          BOT_TOKEN: TOKEN,
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

const rows = () => {
  const s = openStore(db);
  try {
    return { pubs: s.publications.listForPlan(DATE), alerts: s.alerts.list() };
  } finally {
    s.close();
  }
};

describe('restart between intent and result', () => {
  it('killed after the request left: a restart yields exactly one message', async () => {
    fake.queue('sendMessage', { hang: true }); // posted, but the answer never comes
    fake.onRequest = (r) => {
      if (r.method === 'sendMessage') setTimeout(() => current?.kill('SIGKILL'), 50);
    };
    const first = await run(msk('09:00:30'));
    expect(first.signal).toBe('SIGKILL');
    expect(rows().pubs.map((p) => p.status)).toEqual(['intent']);

    // Restart 30 s later: the intent is fresh, the slot is blocked, nothing is sent.
    const second = await run(msk('09:01:00'));
    expect(second.code, second.out).toBe(0);
    // Restart 3 min later: the intent becomes unknown with an alert, nothing is sent.
    const third = await run(msk('09:03:30'));
    expect(third.code, third.out).toBe(0);

    expect(fake.sent('sendMessage')).toHaveLength(1);
    expect(fake.channel).toHaveLength(1);
    const { pubs, alerts } = rows();
    expect(pubs.map((p) => p.status)).toEqual(['unknown']);
    expect(alerts.filter((a) => a.kind === 'publish_unknown')).toHaveLength(1);
  }, 30_000);

  it('killed right after beginIntent, before the request: no resend, unknown and an alert', async () => {
    const first = await run(msk('09:00:30'), { CRASH_AFTER_INTENT: '1' });
    expect(first.signal).toBe('SIGKILL');
    expect(rows().pubs.map((p) => p.status)).toEqual(['intent']);
    const second = await run(msk('09:03:30'));
    expect(second.code, second.out).toBe(0);
    expect(fake.requests).toHaveLength(0);
    const { pubs, alerts } = rows();
    expect(pubs.map((p) => p.status)).toEqual(['unknown']);
    expect(alerts.filter((a) => a.kind === 'publish_unknown')).toHaveLength(1);
  }, 30_000);

  it('a normal run after a clean one sends nothing new', async () => {
    expect((await run(msk('09:00:30'))).code).toBe(0);
    expect((await run(msk('09:00:40'))).code).toBe(0);
    expect(fake.channel).toHaveLength(1);
    expect(rows().pubs.map((p) => p.status)).toEqual(['sent']);
  }, 30_000);
});
