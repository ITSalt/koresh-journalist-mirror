import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotImage } from '../../src/plan/schema.js';
import { openStore } from '../../src/store/index.js';
import { FakeBotApi } from '../support/fake-bot-api.js';
import { seedImage } from '../support/images.js';
import { DATE, longText, msk, seedPlan, TOKEN } from './helpers.js';

// WP-SVC-24 acceptance 5: a slot with an image, the publisher in a real child process that is
// SIGKILLed mid-publish, then a new process on the same SQLite file (as test/publish/restart.test.ts
// does for a text slot). The fake Bot API counts what is in the channel.

const CHILD = fileURLToPath(new URL('../support/publisher-child.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

let fake: FakeBotApi;
let dir: string;
let db: string;
let sha256: string;

function seed(text: string) {
  const store = openStore(db);
  const img = seedImage(store);
  sha256 = img.sha256;
  const image: SlotImage = { sha256, mime: 'image/png', width: 640, height: 480, credit: 'zenith' };
  seedPlan(store, [{ id: 's1', at: '09:00', text, image }]);
  store.close();
}

beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
  dir = mkdtempSync(join(tmpdir(), 'jrn-restart-img-'));
  db = join(dir, 'journalist.db');
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
    return {
      pubs: s.publications.listForPlan(DATE),
      alerts: s.alerts.list(),
      slot: s.slots.listForPlan(DATE)[0]!.status,
    };
  } finally {
    s.close();
  }
};
const statuses = () => rows().pubs.map((p) => p.status);
const photos = () => fake.channel.filter((m) => m.method === 'sendPhoto');
const texts = () => fake.channel.filter((m) => m.method === 'sendMessage');

describe('restart of a slot with an image (photo, then text parts)', () => {
  it('killed after the photo request left: one photo, unknown, alert, the text never sent', async () => {
    seed(longText());
    fake.queue('sendPhoto', { hang: true }); // in the channel, but the answer never comes
    fake.onRequest = (r) => {
      if (r.method === 'sendPhoto') setTimeout(() => current?.kill('SIGKILL'), 50);
    };
    const first = await run(msk('09:00:30'));
    expect(first.signal).toBe('SIGKILL');
    expect(statuses()).toEqual(['intent']);

    // 30 s later the intent is fresh: the slot is blocked. 3 min later it becomes unknown.
    const second = await run(msk('09:01:00'));
    expect(second.code, second.out).toBe(0);
    expect(statuses()).toEqual(['intent']);
    const third = await run(msk('09:03:30'));
    expect(third.code, third.out).toBe(0);
    const fourth = await run(msk('09:10:00'));
    expect(fourth.code, fourth.out).toBe(0);

    expect(fake.sent('sendPhoto')).toHaveLength(1);
    expect(photos()).toHaveLength(1);
    expect(photos()[0]!.photoSha256).toBe(sha256);
    expect(fake.sent('sendMessage')).toHaveLength(0);
    const { pubs, alerts, slot } = rows();
    expect(pubs.map((p) => [p.part, p.status])).toEqual([[0, 'unknown']]);
    expect(alerts.filter((a) => a.kind === 'publish_unknown')).toHaveLength(1);
    expect(slot).toBe('planned');
  }, 40_000);

  it('killed right after the photo intent, before the request: no photo ever, unknown and an alert', async () => {
    seed(longText());
    const first = await run(msk('09:00:30'), { CRASH_AFTER_INTENT: '1' });
    expect(first.signal).toBe('SIGKILL');
    expect(statuses()).toEqual(['intent']);
    const second = await run(msk('09:03:30'));
    expect(second.code, second.out).toBe(0);
    expect(fake.requests).toHaveLength(0);
    expect(statuses()).toEqual(['unknown']);
    expect(rows().alerts.filter((a) => a.kind === 'publish_unknown')).toHaveLength(1);
  }, 30_000);

  it('killed between the photo `sent` and the text part: the restart sends only the text', async () => {
    seed(longText());
    const first = await run(msk('09:00:30'), { CRASH_AFTER_SENT: '1' });
    expect(first.signal).toBe('SIGKILL');
    expect(statuses()).toEqual(['sent']);
    expect(fake.requests.map((r) => r.method)).toEqual(['sendPhoto']);
    const photoId = photos()[0]!.message_id;

    const second = await run(msk('09:00:50'));
    expect(second.code, second.out).toBe(0);
    expect(fake.sent('sendPhoto')).toHaveLength(1);
    expect(photos()).toHaveLength(1);
    const n = texts().length;
    expect(n).toBeGreaterThan(1);
    const { pubs, alerts, slot } = rows();
    expect(pubs.map((p) => [p.part, p.status, p.messageId])).toEqual(
      fake.channel.map((m, i) => [i, 'sent', String(m.message_id)]),
    );
    expect(pubs[0]!.messageId).toBe(String(photoId));
    expect(slot).toBe('done');
    expect(alerts).toEqual([]);

    // A clean rerun sends nothing.
    const third = await run(msk('09:01:10'));
    expect(third.code, third.out).toBe(0);
    expect(fake.channel).toHaveLength(1 + n);
    expect(fake.sent('sendPhoto')).toHaveLength(1);
  }, 40_000);

  it('killed after a text request left: the photo is not sent again, the text is unknown', async () => {
    seed(longText());
    fake.queue('sendMessage', { hang: true });
    fake.onRequest = (r) => {
      if (r.method === 'sendMessage') setTimeout(() => current?.kill('SIGKILL'), 50);
    };
    const first = await run(msk('09:00:30'));
    expect(first.signal).toBe('SIGKILL');
    expect(statuses()).toEqual(['sent', 'intent']);
    const second = await run(msk('09:03:30'));
    expect(second.code, second.out).toBe(0);
    expect(statuses()).toEqual(['sent', 'unknown']);
    expect(fake.sent('sendPhoto')).toHaveLength(1);
    expect(fake.sent('sendMessage')).toHaveLength(1);
    expect(rows().alerts.filter((a) => a.kind === 'publish_unknown')).toHaveLength(1);
  }, 30_000);

  it('a one-item slot (photo with the whole post): a clean rerun sends nothing new', async () => {
    seed('Утро. Кто первый?');
    expect((await run(msk('09:00:30'))).code).toBe(0);
    expect((await run(msk('09:00:40'))).code).toBe(0);
    expect((await run(msk('09:05:00'))).code).toBe(0);
    expect(fake.channel).toHaveLength(1);
    expect(photos()[0]!.caption).toContain('Иллюстрация: zenith');
    expect(statuses()).toEqual(['sent']);
    expect(rows().slot).toBe('done');
  }, 40_000);
});
