import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { textHash } from '../../src/lib/idempotency.js';
import { SIGNATURE_LINE } from '../../src/plan/pipeline.js';
import { createPublisher, type PublisherOptions } from '../../src/publish/publisher.js';
import { makeScrubber } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';
import { CHANNEL, DATE, longText, msk, seedPlan, TOKEN } from './helpers.js';

let fake: FakeBotApi;
let dir: string;
let store: Store;
let t: Date;
let waits: number[];

beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
  dir = mkdtempSync(join(tmpdir(), 'jrn-pub-'));
  store = openStore(join(dir, 'journalist.db'));
  t = msk('09:00:30');
  waits = [];
});
afterEach(async () => {
  store.close();
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

function publisher(over: Partial<PublisherOptions> = {}) {
  return createPublisher({
    store,
    blocks,
    api: createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 500 }),
    channel: CHANNEL,
    dryRun: false,
    tz: 'Europe/Moscow',
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
    },
    scrub: makeScrubber(loadConfig({ TELEGRAM_BOT_TOKEN: TOKEN })),
    ...over,
  });
}

const pubs = () => store.publications.listForPlan(DATE);
const slot = (id: string) => store.slots.listForPlan(DATE).find((s) => s.slotId === id)!;
const alerts = (kind: string) => store.alerts.list().filter((a) => a.kind === kind);

describe('normal day', () => {
  it('publishes the due slot once with MarkdownV2, records message id and text hash', async () => {
    seedPlan(store, [
      { id: 's1', at: '09:00', text: 'Утро. Кто первый?' },
      { id: 's2', at: '13:00' },
    ]);
    const p = publisher();
    const it1 = await p.runOnce();
    expect(it1).toMatchObject({ slot: 's1', result: 'sent' });
    expect(fake.channel).toHaveLength(1);
    const req = fake.sent('sendMessage')[0]!.body;
    expect(req).toMatchObject({
      chat_id: CHANNEL,
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
    });
    expect(req.text).toContain('Утро\\. Кто первый?');
    const [row] = pubs();
    expect(row).toMatchObject({
      key: `telegram:${DATE}:s1:0`,
      status: 'sent',
      messageId: String(fake.channel[0]!.message_id),
    });
    expect(row!.textSha256).toBe(textHash(`Утро. Кто первый?\n\n${SIGNATURE_LINE}`));
    expect(slot('s1').status).toBe('done');

    // Same minute again: nothing more goes out; the loop wakes at the next slot.
    const it2 = await p.runOnce();
    expect(it2.result).toBeUndefined();
    expect(it2.wakeAt).toBe(msk('13:00').toISOString());
    expect(fake.channel).toHaveLength(1);
  });

  it('a day without a plan publishes nothing', async () => {
    const it = await publisher().runOnce();
    expect(it).toEqual({ date: DATE, skipped: [] });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('approval gate (D-2, I-2)', () => {
  it('a rejected day publishes nothing and returns no wakeAt (poll interval)', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00' }], { status: 'rejected' });
    const it = await publisher().runOnce();
    expect(it.wakeAt).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
    expect(pubs()).toHaveLength(0);
  });

  it('a draft (not approved) day publishes nothing', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00' }], { status: 'draft' });
    await publisher().runOnce();
    expect(fake.requests).toHaveLength(0);
  });

  it('re-reads the plan status before every part: a reject mid-post stops the rest', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: longText() }]);
    fake.onRequest = () => {
      if (store.plans.get(DATE)?.status === 'approved') store.plans.setStatus(DATE, 'rejected');
    };
    const it = await publisher().runOnce();
    expect(it.result).toBe('stopped');
    expect(fake.sent('sendMessage')).toHaveLength(1);
    expect(pubs().map((p) => p.status)).toEqual(['sent']);
  });

  it('a slot skipped by a reject after the plan was approved is not sent', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00' }]);
    store.slots.setStatus(DATE, 's1', 'skipped');
    await publisher().runOnce();
    expect(fake.requests).toHaveLength(0);
  });
});

describe('multi-part and poll slots', () => {
  it('publishes the parts in order under one slot; the last part carries the signature', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: longText() }]);
    const it = await publisher().runOnce();
    expect(it.result).toBe('sent');
    const sent = fake.sent('sendMessage');
    expect(sent.length).toBeGreaterThan(1);
    expect(pubs().map((p) => [p.part, p.status])).toEqual(sent.map((_, i) => [i, 'sent']));
    for (const r of sent) expect((r.body.text as string).length).toBeLessThanOrEqual(4096);
    expect(sent[sent.length - 1]!.body.text as string).toContain('Кореш Шпандент');
    expect(sent[0]!.body.text as string).not.toContain('Кореш Шпандент');
    // ~1 msg/s per chat between parts
    expect(waits.filter((w) => w === 1100)).toHaveLength(sent.length - 1);
  });

  it('a poll slot sends the text, then a regular anonymous sendPoll', async () => {
    seedPlan(store, [
      {
        id: 'q1',
        at: '09:00',
        kind: 'poll',
        text: 'Опрос дня.',
        poll: { question: 'Кто прав?', options: ['я', 'ты'], allowsMultiple: false },
      },
    ]);
    const it = await publisher().runOnce();
    expect(it.result).toBe('sent');
    expect(fake.requests.map((r) => r.method)).toEqual(['sendMessage', 'sendPoll']);
    expect(fake.channel[1]!.poll).toEqual({
      question: 'Кто прав?',
      options: [{ text: 'я' }, { text: 'ты' }],
      is_anonymous: true,
      type: 'regular',
    });
    expect(pubs().map((p) => [p.part, p.status, p.messageId])).toEqual([
      [0, 'sent', String(fake.channel[0]!.message_id)],
      [1, 'sent', String(fake.channel[1]!.message_id)],
    ]);
  });

  it('resumes an interrupted multi-part post with the missing parts only', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: longText() }]);
    // A first process sent part 0 and died before part 1.
    store.publications.beginIntent(
      {
        key: `telegram:${DATE}:s1:0`,
        platform: 'telegram',
        planDate: DATE,
        slotId: 's1',
        part: 0,
        textSha256: 'x',
      },
      msk('09:00:01'),
    );
    store.publications.markSent(`telegram:${DATE}:s1:0`, '42', msk('09:00:02'));
    const it = await publisher().runOnce();
    expect(it.result).toBe('sent');
    const n = pubs().length;
    expect(n).toBeGreaterThan(1);
    expect(fake.sent('sendMessage')).toHaveLength(n - 1);
    expect(slot('s1').status).toBe('done');
  });
});

describe('Bot API failures', () => {
  it('429: waits retry_after, then one message', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00' }]);
    fake.queue('sendMessage', { status: 429, retryAfter: 4 });
    const it = await publisher().runOnce();
    expect(it.result).toBe('sent');
    expect(waits).toContain(4000);
    expect(fake.channel).toHaveLength(1);
    expect(pubs()[0]!.status).toBe('sent');
  });

  it('5xx: backs off and retries, then one message', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00' }]);
    fake.queue('sendMessage', { status: 502 }, { status: 500 });
    const it = await publisher().runOnce();
    expect(it.result).toBe('sent');
    expect(waits).toEqual([1000, 2000]);
    expect(fake.channel).toHaveLength(1);
  });

  it('5xx until the attempts run out: failed, alert, slot skipped, never resent', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00' }]);
    fake.queue('sendMessage', ...Array.from({ length: 5 }, () => ({ status: 500 })));
    const p = publisher();
    expect((await p.runOnce()).result).toBe('failed');
    expect(pubs()[0]).toMatchObject({ status: 'failed' });
    expect(slot('s1').status).toBe('skipped');
    expect(alerts('publish_failed')).toHaveLength(1);
    t = msk('09:05');
    await p.runOnce();
    expect(fake.sent('sendMessage')).toHaveLength(5);
    expect(fake.channel).toHaveLength(0);
  });

  it('4xx: failed at once; the stored error is scrubbed of secret values (L-3)', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00' }]);
    fake.queue('sendMessage', { status: 400, description: `Bad Request: token ${TOKEN} echoed` });
    expect((await publisher().runOnce()).result).toBe('failed');
    expect(fake.sent('sendMessage')).toHaveLength(1);
    const row = pubs()[0]!;
    expect(row.error).toContain('[REDACTED]');
    expect(row.error).not.toContain(TOKEN);
    expect(JSON.stringify(store.alerts.list())).not.toContain(TOKEN);
  });

  it('a lost answer after the request left: unknown, alert, never resent; other slots go on', async () => {
    seedPlan(store, [
      { id: 's1', at: '09:00' },
      { id: 's2', at: '10:00' },
    ]);
    fake.queue('sendMessage', { drop: true });
    const p = publisher();
    expect((await p.runOnce()).result).toBe('unknown');
    expect(pubs()[0]).toMatchObject({ key: `telegram:${DATE}:s1:0`, status: 'unknown' });
    expect(alerts('publish_unknown')).toHaveLength(1);
    t = msk('09:30');
    await p.runOnce();
    expect(fake.channel).toHaveLength(1);
    // unknown blocks only its own slot
    t = msk('10:00:10');
    expect((await p.runOnce()).slot).toBe('s2');
    expect(fake.channel).toHaveLength(2);
    expect(fake.sent('sendMessage')).toHaveLength(2);
  });

  it('a refused connection is retried as not sent', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00' }]);
    let calls = 0;
    const api = createBotApi({
      token: TOKEN,
      baseUrl: fake.baseUrl,
      fetch: async (input, init) => {
        if (calls++ === 0) {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        }
        return fetch(input, init);
      },
    });
    expect((await publisher({ api }).runOnce()).result).toBe('sent');
    expect(fake.channel).toHaveLength(1);
  });
});

describe('restart safety (reconciliation)', () => {
  const intent = (at: Date) =>
    store.publications.beginIntent(
      {
        key: `telegram:${DATE}:s1:0`,
        platform: 'telegram',
        planDate: DATE,
        slotId: 's1',
        part: 0,
        textSha256: 'x',
      },
      at,
    );

  it('an intent older than 2 min becomes unknown with an alert and is not resent', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00' }]);
    intent(msk('09:00:01'));
    t = msk('09:03');
    const p = publisher();
    expect(p.reconcile()).toEqual([`telegram:${DATE}:s1:0`]);
    await p.runOnce();
    expect(pubs()[0]!.status).toBe('unknown');
    expect(alerts('publish_unknown')).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);
  });

  it('a fresh intent (another process mid-send) is left alone and blocks its slot', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00' }]);
    intent(msk('09:00:01'));
    t = msk('09:01');
    await publisher().runOnce();
    expect(pubs()[0]!.status).toBe('intent');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('catch-up after downtime', () => {
  it('skips stale slots (stored as skipped) and publishes one fresh slot, never a burst', async () => {
    seedPlan(store, [
      { id: 's1', at: '09:00' },
      { id: 's2', at: '11:00' },
      { id: 's3', at: '11:30' },
    ]);
    t = msk('12:00');
    const p = publisher();
    const it = await p.runOnce();
    expect(it.skipped).toEqual(['s1']);
    expect(slot('s1').status).toBe('skipped');
    expect(alerts('slot_skipped')).toHaveLength(1);
    expect(it.slot).toBe('s2');
    const again = await p.runOnce();
    expect(again.result).toBeUndefined();
    expect(fake.channel).toHaveLength(1);
  });
});

describe('scheduler errors (D-20)', () => {
  it('a slot time without an offset: one scheduler_error alert, nothing published', async () => {
    seedPlan(store, [{ id: 's1', at: `${DATE}T09:00:00` }]);
    const p = publisher();
    await p.runOnce();
    await p.runOnce();
    expect(fake.requests).toHaveLength(0);
    expect(alerts('scheduler_error')).toHaveLength(1);
    expect(alerts('scheduler_error')[0]!.message).toContain('BAD_TIME');
  });
});

describe('DRY_RUN', () => {
  it('records dry rows, marks the slot done and sends nothing', async () => {
    seedPlan(store, [
      {
        id: 'q1',
        at: '09:00',
        kind: 'poll',
        text: 'Опрос.',
        poll: { question: 'Да?', options: ['да', 'нет'], allowsMultiple: false },
      },
    ]);
    const it = await publisher({ dryRun: true, api: undefined }).runOnce();
    expect(it.result).toBe('dry');
    expect(pubs().map((p) => [p.part, p.status, p.messageId])).toEqual([
      [0, 'dry', null],
      [1, 'dry', null],
    ]);
    expect(slot('q1').status).toBe('done');
    expect(fake.requests).toHaveLength(0);
  });

  it('a live publisher needs a Bot API client', () => {
    expect(() => publisher({ api: undefined })).toThrow(/Bot API/);
  });
});

describe('signature guard (D-9) and trailer (D-16, D-17)', () => {
  it('refuses a post without the signature line: no request, failed row, alert', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: 'Без подписи. Как так?' }], { raw: true });
    const it = await publisher().runOnce();
    expect(it.result).toBe('refused');
    expect(fake.requests).toHaveLength(0);
    expect(pubs()[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('signature'),
    });
    expect(alerts('publish_refused')).toHaveLength(1);
    expect(slot('s1').status).toBe('skipped');
  });

  it('any compose error (RangeError from chunkText) refuses the slot once with an alert', async () => {
    // One grapheme of 'a' + 4200 combining acute accents: longer than a part, cannot be split.
    seedPlan(store, [{ id: 's1', at: '09:00', text: `a${'\u0301'.repeat(4200)}\n\nЧто это?` }]);
    const p = publisher();
    expect((await p.runOnce()).result).toBe('refused');
    expect(pubs()[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('compose error: RangeError'),
    });
    expect(alerts('publish_refused')).toHaveLength(1);
    expect(slot('s1').status).toBe('skipped');
    t = msk('09:01:30');
    await p.runOnce();
    expect(alerts('publish_refused')).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a multi-part post whose last part lacks the signature', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: `${SIGNATURE_LINE}\n\n${longText()}` }], {
      raw: true,
    });
    expect((await publisher().runOnce()).result).toBe('refused');
    expect(fake.requests).toHaveLength(0);
  });

  it('appends TG_TRAILER after the signature at publish time, not in the stored plan', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: 'Пост. Ну?' }]);
    await publisher({ trailer: 'хвост' }).runOnce();
    expect(fake.sent('sendMessage')[0]!.body.text).toBe(
      `Пост\\. Ну?\n\nИИ\\-журналист\\-правдорубец Кореш Шпандент\n\nхвост`,
    );
    expect(store.plans.get(DATE)!.json).not.toContain('хвост');
  });
});
