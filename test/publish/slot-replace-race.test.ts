import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replaceSlot } from '../../src/plan/replace.js';
import { createPublisher } from '../../src/publish/publisher.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';
import { CHANNEL, DATE, longText, msk, seedPlan, TOKEN } from './helpers.js';

// WP-SVC-22 acceptance 3: a publisher iteration and a slot replacement interleaved on one SQLite
// file through two store handles. The slot goes out either with the old or with the new text,
// never a mix, and a replacement that loses is refused (`slot_started`).
//
// The replacement runs on a clock 15 minutes before the slot while the publisher's clock is
// already past it: the 10 minute rule is deliberately out of the way, so only the store-level
// guards decide.

const OLD = 'Вечер, старый текст. Что думаете?';
const NEW = 'Вечер, правка владельца. Кто согласен?';
const PUT_NOW = msk('18:45');
const PUB_NOW = msk('19:00:30');

let fake: FakeBotApi;
let dir: string;
let db: string;
let a: Store; // the publisher's handle
let b: Store; // the API's handle

beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
  dir = mkdtempSync(join(tmpdir(), 'jrn-race-'));
  db = join(dir, 'journalist.db');
  a = openStore(db);
  b = openStore(db);
  seedPlan(a, [{ id: 's2', at: '19:00', text: OLD }]);
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
    api: createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 500 }),
    channel: CHANNEL,
    dryRun: false,
    tz: 'Europe/Moscow',
    now: () => PUB_NOW,
    sleep: async () => undefined,
  });

const replace = (text = NEW) =>
  replaceSlot(b, DATE, 's2', { text, reason: 'owner edit' }, PUT_NOW).kind;

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

const texts = () => fake.channel.map((m) => m.text ?? '');
const hasOld = (s: string) => s.includes('старый текст');
const hasNew = (s: string) => s.includes('правка владельца');

/** The acceptance invariant for one slot: one consistent post, matching the PUT's answer. */
function expectNoMix(put: string) {
  const out = texts();
  expect(out.length).toBeGreaterThan(0);
  expect(out.every(hasOld) || out.every(hasNew)).toBe(true);
  expect(out.some((x) => hasOld(x) && hasNew(x))).toBe(false);
  if (put === 'replaced') expect(out.every(hasNew)).toBe(true);
  else {
    expect(put).toBe('slot_started');
    expect(out.every(hasOld)).toBe(true);
  }
  const pubs = a.publications.listForPlan(DATE);
  expect(pubs.map((p) => p.status)).toEqual(out.map(() => 'sent'));
}

describe('publisher and replacement interleaved (two store handles)', () => {
  it('replacement after the publisher read the slot: the old text is not sent, the new one is', async () => {
    let put = '';
    // 1st listForPlan: runOnce reads the slots (with the old text) for the scheduler.
    after(a.slots, 'listForPlan', 1, () => (put = replace()));
    const p = publisher();
    const first = await p.runOnce();
    expect(put).toBe('replaced');
    expect(first).toMatchObject({ slot: 's2', result: 'stopped', again: true });
    expect(fake.requests).toHaveLength(0);
    expect(a.publications.listForPlan(DATE)).toEqual([]);

    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    expectNoMix(put);
    expect(texts()).toHaveLength(1);
  });

  it('replacement right before the intent (after the last status check): same outcome', async () => {
    let put = '';
    // plans.get is the publisher's own "still approved?" read, the last one before the intent.
    let seen = 0;
    const get = a.plans.get.bind(a.plans);
    a.plans.get = (date) => {
      const out = get(date);
      if (++seen === 2) put = replace();
      return out;
    };
    const p = publisher();
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'stopped' });
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(put).toBe('replaced');
    expect(fake.requests).toHaveLength(0);
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    expectNoMix(put);
  });

  it('replacement right after the intent: 409 slot_started, the old text goes out', async () => {
    let put = '';
    after(a.publications, 'beginIntent', 1, () => (put = replace()));
    const p = publisher();
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    expect(put).toBe('slot_started');
    expectNoMix(put);
    expect(JSON.parse(b.slots.listForPlan(DATE)[0]!.json).text).toContain('старый текст');
    expect(b.alerts.list().filter((x) => x.kind === 'slot_replaced')).toEqual([]);
  });

  it('a multi-part slot: a replacement between the parts is refused, all parts are old', async () => {
    seedPlan(a, [{ id: 's2', at: '19:00', text: `Вечер, старый текст. ${longText()}` }]);
    let put = '';
    after(a.publications, 'markSent', 1, () => (put = replace(`${NEW} ${longText()}`)));
    const p = publisher();
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    expect(put).toBe('slot_started');
    expect(texts().length).toBeGreaterThan(1);
    expect(texts().some(hasNew)).toBe(false);
    expect(hasOld(texts()[0]!)).toBe(true);
  });

  it('an unsigned old text: a replacement before the refusal wins, the slot is not skipped', async () => {
    // Stored without the signature on purpose: the publisher refuses such a slot (D-9).
    seedPlan(a, [{ id: 's2', at: '19:00', text: OLD }], { raw: true });
    let put = '';
    after(a.slots, 'listForPlan', 1, () => (put = replace()));
    const p = publisher();
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'stopped' });
    expect(put).toBe('replaced');
    expect(a.publications.listForPlan(DATE)).toEqual([]);
    expect(a.slots.listForPlan(DATE)[0]!.status).toBe('planned');
    expect(a.alerts.list().filter((x) => x.kind === 'publish_refused')).toEqual([]);
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    expectNoMix(put);
  });

  it('an unsigned old text refused first: the replacement loses', async () => {
    seedPlan(a, [{ id: 's2', at: '19:00', text: OLD }], { raw: true });
    expect(await publisher().runOnce()).toMatchObject({ slot: 's2', result: 'refused' });
    expect(replace()).toBe('slot_started');
    expect(fake.requests).toHaveLength(0);
  });

  it('takes the write lock before it reads: nothing is decided while another writer holds it', () => {
    b.db.pragma('busy_timeout = 0');
    let reads = 0;
    const get = b.plans.get.bind(b.plans);
    b.plans.get = (date) => {
      reads++;
      return get(date);
    };
    a.db.exec('BEGIN IMMEDIATE');
    try {
      expect(() => replace()).toThrow(/database is locked/);
      expect(reads).toBe(0);
    } finally {
      a.db.exec('ROLLBACK');
    }
    expect(replace()).toBe('replaced');
    expect(reads).toBe(1);
  });
});

// ---------- real concurrency: the publisher in its own process ----------

const CHILD = fileURLToPath(new URL('../support/publisher-child.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Starts a publisher process that waits for `go` to exist, then runs one iteration. */
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

describe('publisher process against a replacement (real concurrency)', () => {
  // The child needs some milliseconds between reading the slot and writing its intent (about 14
  // on the build machine): the delays straddle that window, so over the rounds the replacement
  // lands before the intent (it wins, the iteration stops) and after it (it is refused).
  // Whichever happens, the invariant must hold.
  it.each([0, 3, 6, 10, 14, 18, 25, 40])(
    'replacement %s ms after the start signal: old or new, never a mix',
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
      // A replacement that won may have stopped that iteration: the next one sends the new text.
      if (fake.channel.length === 0) {
        expect(put).toBe('replaced');
        const second = child(go);
        const two = await second.exit;
        expect(two.code, two.out).toBe(0);
      }
      expectNoMix(put);
      expect(texts()).toHaveLength(1);
    },
    30_000,
  );
});

// ---------- WP-SVC-25: a PUT of `at` against the publisher's claim ----------
//
// The scheduler reads the `at` column, the claim compares the slot json (which holds `at` too).
// A move that lands between the publisher's read and its intent changes both, so the claim fails;
// the slot is then sent once, at the old or at the new time, never twice.

const LATER = `${DATE}T19:30:41+03:00`;
const EARLIER = `${DATE}T18:58:07+03:00`;
const moveAt = (at: string) =>
  replaceSlot(b, DATE, 's2', { at, reason: 'director timing decision D-33' }, PUT_NOW).kind;

describe('a PUT of at interleaved with the publisher (two store handles)', () => {
  let clock = PUB_NOW;
  beforeEach(() => {
    clock = PUB_NOW;
  });
  const timedPublisher = () =>
    createPublisher({
      store: a,
      blocks,
      api: createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 500 }),
      channel: CHANNEL,
      dryRun: false,
      tz: 'Europe/Moscow',
      now: () => clock,
      sleep: async () => undefined,
    });
  const sentOnce = () => {
    expect(fake.channel).toHaveLength(1);
    expect(a.publications.listForPlan(DATE).map((p) => p.status)).toEqual(['sent']);
  };

  it('moved later after the publisher read the slot: the claim fails, nothing at the old time, one post at the new', async () => {
    let put = '';
    after(a.slots, 'listForPlan', 1, () => (put = moveAt(LATER)));
    const p = timedPublisher();
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'stopped', again: true });
    expect(put).toBe('replaced');
    expect(fake.requests).toHaveLength(0);
    expect(a.publications.listForPlan(DATE)).toEqual([]);
    expect(a.slots.listForPlan(DATE)[0]!.at).toBe(LATER);

    expect((await p.runOnce()).slot).toBeUndefined(); // 19:00:30 is before 19:30:41
    expect(fake.requests).toHaveLength(0);

    clock = msk('19:30:41');
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    sentOnce();
  });

  it('moved earlier after the publisher read the slot: the claim fails, then one post, not two', async () => {
    let put = '';
    after(a.slots, 'listForPlan', 1, () => (put = moveAt(EARLIER)));
    const p = timedPublisher();
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'stopped' });
    expect(put).toBe('replaced');
    expect(fake.requests).toHaveLength(0);
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    expect(await p.runOnce()).not.toMatchObject({ result: 'sent' });
    sentOnce();
  });

  it('moved right before the intent (after the last status check): same outcome', async () => {
    let put = '';
    let seen = 0;
    const get = a.plans.get.bind(a.plans);
    a.plans.get = (date) => {
      const out = get(date);
      if (++seen === 2) put = moveAt(LATER);
      return out;
    };
    const p = timedPublisher();
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'stopped' });
    expect(put).toBe('replaced');
    expect(fake.requests).toHaveLength(0);
    clock = msk('19:30:41');
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    sentOnce();
  });

  it('moved right after the intent: 409 slot_started, the old time stands, one post', async () => {
    let put = '';
    after(a.publications, 'beginIntent', 1, () => (put = moveAt(LATER)));
    const p = timedPublisher();
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    expect(put).toBe('slot_started');
    expect(b.slots.listForPlan(DATE)[0]!.at).toBe(`${DATE}T19:00:00+03:00`);
    expect(JSON.parse(b.slots.listForPlan(DATE)[0]!.json).at).toBe(`${DATE}T19:00:00+03:00`);
    sentOnce();
  });

  it.each([0, 6, 14, 25])(
    'real process, move %s ms after the start signal: sent once, at the old or the new time',
    async (delayMs) => {
      const go = join(dir, 'go');
      const first = child(go);
      await first.ready;
      writeFileSync(go, '');
      spin(delayMs);
      const put = moveAt(EARLIER);
      const one = await first.exit;
      expect(one.code, one.out).toBe(0);
      if (fake.channel.length === 0) {
        // the move won and stopped that iteration: the next one sends at the (past) new time
        expect(put).toBe('replaced');
        const second = child(go);
        const two = await second.exit;
        expect(two.code, two.out).toBe(0);
      }
      expect(fake.channel).toHaveLength(1);
      expect(a.publications.listForPlan(DATE).map((p) => p.status)).toEqual(['sent']);
      expect(['replaced', 'slot_started']).toContain(put);
      const row = b.slots.listForPlan(DATE)[0]!;
      expect(row.at).toBe(put === 'replaced' ? EARLIER : `${DATE}T19:00:00+03:00`);
      expect(JSON.parse(row.json).at).toBe(row.at);
    },
    30_000,
  );
});
