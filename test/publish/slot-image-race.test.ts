import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replaceSlot } from '../../src/plan/replace.js';
import type { SlotImage } from '../../src/plan/schema.js';
import { createPublisher } from '../../src/publish/publisher.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';
import { seedImage } from '../support/images.js';
import { CHANNEL, DATE, longText, msk, seedPlan, TOKEN } from './helpers.js';

// WP-SVC-24 acceptance 6: a publisher iteration and a slot PUT that changes the image, interleaved
// on one SQLite file through two store handles (as test/publish/slot-replace-race.test.ts does for
// the text). The slot goes out with the old image and the old text, or with the new image and the
// new text: never the old image with the new text, nor the other way round. A PUT that comes
// after any publication row is refused (`slot_started`).

const OLD = 'Вечер, старый текст. Что думаете?';
const NEW = 'Вечер, правка владельца. Кто согласен?';
const PUT_NOW = msk('18:45');
const PUB_NOW = msk('19:00:30');

let fake: FakeBotApi;
let dir: string;
let db: string;
let a: Store; // the publisher's handle
let b: Store; // the API's handle
let oldImg: ReturnType<typeof seedImage>;
let newImg: ReturnType<typeof seedImage>;
let image: SlotImage;

beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
  dir = mkdtempSync(join(tmpdir(), 'jrn-img-race-'));
  db = join(dir, 'journalist.db');
  a = openStore(db);
  b = openStore(db);
  oldImg = seedImage(a, 640, 480, 1);
  newImg = seedImage(a, 800, 600, 2);
  image = {
    sha256: oldImg.sha256,
    mime: 'image/png',
    width: 640,
    height: 480,
    credit: 'старый автор',
  };
  seedPlan(a, [{ id: 's2', at: '19:00', text: OLD, image }]);
});
afterEach(async () => {
  a.close();
  b.close();
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

const publisher = () =>
  createPublisher({
    store: a,
    blocks,
    api: createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 5000 }),
    channel: CHANNEL,
    dryRun: false,
    tz: 'Europe/Moscow',
    now: () => PUB_NOW,
    sleep: async () => undefined,
  });

/** The owner's edit: a new image with its credit and a new text, or only one of them. */
const replace = (o: { text?: string; image?: unknown } = {}) =>
  replaceSlot(
    b,
    DATE,
    's2',
    {
      text: o.text ?? NEW,
      image: 'image' in o ? o.image : { sha256: newImg.sha256, credit: 'новый автор' },
      reason: 'owner edit',
    },
    PUT_NOW,
  ).kind;

/** Calls `fn` once, right after the `n`-th call of `obj[method]` returned. */
function after<T extends object, K extends keyof T>(obj: T, method: K, n: number, fn: () => void) {
  const original = (obj[method] as (...args: unknown[]) => unknown).bind(obj);
  let calls = 0;
  (obj as Record<K, unknown>)[method] = (...args: unknown[]) => {
    const out = original(...args);
    if (++calls === n) fn();
    return out;
  };
}

/** Which versions of the slot are in the channel: by image, credit and text markers. */
function versions(): ('old' | 'new')[] {
  const out = new Set<'old' | 'new'>();
  for (const m of fake.channel) {
    const text = m.caption ?? m.text ?? '';
    if (m.photoSha256 === oldImg.sha256) out.add('old');
    if (m.photoSha256 === newImg.sha256) out.add('new');
    if (/старый текст|старый автор|СТАРЫЙ/.test(text)) out.add('old');
    if (/правка владельца|новый автор|НОВЫЙ/.test(text)) out.add('new');
  }
  return [...out];
}

/** The acceptance invariant: one consistent post that matches the PUT's answer. */
function expectNoMix(put: string) {
  expect(fake.channel.length).toBeGreaterThan(0);
  expect(fake.channel[0]!.method).toBe('sendPhoto');
  expect(fake.channel.filter((m) => m.method === 'sendPhoto')).toHaveLength(1);
  if (put !== 'replaced') expect(put).toBe('slot_started');
  // Old image with old text, or new image with new text: never both versions in the channel.
  expect(versions()).toEqual([put === 'replaced' ? 'new' : 'old']);
  expect(a.publications.listForPlan(DATE).map((p) => p.status)).toEqual(
    fake.channel.map(() => 'sent'),
  );
}

describe('publisher and an image replacement interleaved (two store handles)', () => {
  it('PUT after the publisher read the slot: the old photo is not sent, the new post is', async () => {
    let put = '';
    after(a.slots, 'listForPlan', 1, () => (put = replace()));
    const p = publisher();
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'stopped', again: true });
    expect(put).toBe('replaced');
    expect(fake.requests).toHaveLength(0);
    expect(a.publications.listForPlan(DATE)).toEqual([]);

    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    expectNoMix(put);
    expect(fake.channel).toEqual([
      expect.objectContaining({
        method: 'sendPhoto',
        photoSha256: newImg.sha256,
        caption: expect.stringContaining('правка владельца'),
      }),
    ]);
    expect(fake.channel[0]!.caption).toContain('Иллюстрация: новый автор');
  });

  type Change = { text?: string; image?: unknown };
  const same = () => ({ sha256: oldImg.sha256, credit: 'старый автор' });
  const cases: [string, () => Change][] = [
    ['only the image changes (same text)', () => ({ text: OLD })],
    ['only the credit changes', () => ({ text: OLD, image: { ...same(), credit: 'новый автор' } })],
    ['the image is removed', () => ({ text: OLD, image: null })],
    ['only the text changes (same image)', () => ({ image: same() })],
  ];
  it.each(cases)(
    'PUT right before the intent, %s: nothing of the old slot leaves',
    async (_n, change) => {
      let put = '';
      // plans.get is the publisher's own "still approved?" read, the last one before the intent.
      let seen = 0;
      const get = a.plans.get.bind(a.plans);
      a.plans.get = (date) => {
        const out = get(date);
        if (++seen === 2) put = replace(change());
        return out;
      };
      const p = publisher();
      expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'stopped' });
      expect(put).toBe('replaced');
      expect(fake.requests).toHaveLength(0);
      expect(a.publications.listForPlan(DATE)).toEqual([]);

      expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
      // What goes out is exactly the slot as the PUT left it.
      const stored = JSON.parse(b.slots.listForPlan(DATE)[0]!.json) as { image?: SlotImage };
      const first = fake.channel[0]!;
      if (stored.image) {
        expect(first.method).toBe('sendPhoto');
        expect(first.photoSha256).toBe(stored.image.sha256);
        expect(first.caption).toContain(`Иллюстрация: ${stored.image.credit}`);
      } else {
        expect(fake.channel.map((m) => m.method)).toEqual(['sendMessage']);
        expect(first.text).not.toContain('Иллюстрация');
      }
      expect(fake.channel).toHaveLength(1);
    },
  );

  it('PUT right after the photo intent: 409 slot_started, the old photo with the old text', async () => {
    let put = '';
    after(a.publications, 'beginIntent', 1, () => (put = replace()));
    expect(await publisher().runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    expect(put).toBe('slot_started');
    expectNoMix(put);
    expect(fake.channel[0]).toMatchObject({ photoSha256: oldImg.sha256 });
    expect(fake.channel[0]!.caption).toContain('старый текст');
    expect(JSON.parse(b.slots.listForPlan(DATE)[0]!.json).image.sha256).toBe(oldImg.sha256);
    expect(b.alerts.list().filter((x) => x.kind === 'slot_replaced')).toEqual([]);
  });

  it('photo then text parts: a PUT between the photo and the text is refused, all of it is old', async () => {
    seedPlan(a, [{ id: 's2', at: '19:00', text: `СТАРЫЙ. ${longText()}`, image }]);
    let put = '';
    after(a.publications, 'markSent', 1, () => (put = replace({ text: `НОВЫЙ. ${longText()}` })));
    expect(await publisher().runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    expect(put).toBe('slot_started');
    expect(fake.channel.length).toBeGreaterThan(2);
    expectNoMix(put);
    expect(fake.channel[0]).toMatchObject({ method: 'sendPhoto', photoSha256: oldImg.sha256 });
    expect(fake.channel[1]!.text).toContain('СТАРЫЙ');
    expect(fake.channel.some((m) => (m.text ?? '').includes('НОВЫЙ'))).toBe(false);
  });

  it('a restart between the photo and the text cannot pick up a changed slot', async () => {
    seedPlan(a, [{ id: 's2', at: '19:00', text: `СТАРЫЙ. ${longText()}`, image }]);
    // The first process sent the photo and died.
    class Killed extends Error {}
    after(a.publications, 'markSent', 1, () => {
      throw new Killed();
    });
    await expect(publisher().runOnce()).rejects.toBeInstanceOf(Killed);
    expect(fake.channel.map((m) => m.method)).toEqual(['sendPhoto']);
    // The owner's edit now comes too late: one row exists.
    expect(replace({ text: `НОВЫЙ. ${longText()}` })).toBe('slot_started');
    // The resume sends the old text parts under the old photo, and no second photo.
    expect(await publisher().runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    expectNoMix('slot_started');
  });

  it('with any publication row present the PUT is refused, whatever its status', () => {
    for (const status of ['intent', 'sent', 'unknown', 'dry', 'failed'] as const) {
      a.db.exec('DELETE FROM publications');
      const key = `telegram:${DATE}:s2:0`;
      a.publications.beginIntent({
        key,
        platform: 'telegram',
        planDate: DATE,
        slotId: 's2',
        textSha256: 'a'.repeat(64),
      });
      if (status === 'sent') a.publications.markSent(key, '42');
      if (status === 'unknown') a.publications.markUnknown(key, 'timeout');
      if (status === 'dry') a.publications.markDry(key);
      if (status === 'failed') a.publications.markFailed(key, 'boom');
      expect(replace(), status).toBe('slot_started');
    }
    expect(JSON.parse(b.slots.listForPlan(DATE)[0]!.json).image.sha256).toBe(oldImg.sha256);
  });
});

// ---------- real concurrency: the publisher in its own process ----------

const CHILD = fileURLToPath(new URL('../support/publisher-child.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function child(go: string) {
  const proc = spawn(process.execPath, ['--import', 'tsx', CHILD], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      DB: db,
      BASE_URL: fake.baseUrl,
      BOT_TOKEN: TOKEN,
      NOW: PUB_NOW.toISOString(),
      GO_FILE: go,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stderr.on('data', (c: Buffer) => (out += c.toString()));
  const ready = new Promise<void>((resolve) => {
    proc.stdout.on('data', (c: Buffer) => {
      out += c.toString();
      if (out.includes('ready')) resolve();
    });
  });
  const exit = new Promise<{ code: number | null; out: string }>((resolve) => {
    proc.on('close', (code) => resolve({ code, out }));
  });
  return { ready, exit };
}

const spin = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

describe('publisher process against an image replacement (real concurrency)', () => {
  // As in slot-replace-race.test.ts: the delays straddle the few milliseconds the child needs
  // between reading the slot and writing its intent, so over the rounds the PUT lands on both
  // sides of the intent. Whichever happens, the invariant must hold.
  it.each([0, 5, 10, 16, 28])(
    'PUT %s ms after the start signal: old image with old text or new with new, never a mix',
    async (delayMs) => {
      const go = join(dir, 'go');
      const first = child(go);
      await first.ready;
      expect(existsSync(go)).toBe(false);
      writeFileSync(go, '');
      spin(delayMs);
      const put = replace();
      const one = await first.exit;
      expect(one.code, one.out).toBe(0);
      if (fake.channel.length === 0) {
        expect(put).toBe('replaced');
        const second = child(go);
        const two = await second.exit;
        expect(two.code, two.out).toBe(0);
      }
      expectNoMix(put);
      expect(fake.channel).toHaveLength(1);
    },
    30_000,
  );
});
