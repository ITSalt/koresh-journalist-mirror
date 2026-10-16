import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SIGNATURE_LINE } from '../../src/plan/pipeline.js';
import type { SlotImage } from '../../src/plan/schema.js';
import { photoHash } from '../../src/publish/compose.js';
import { createPublisher, type PublisherOptions } from '../../src/publish/publisher.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';
import { seedImage } from '../support/images.js';
import { CHANNEL, DATE, longText, msk, seedPlan, TOKEN } from './helpers.js';

// WP-SVC-24 scope 5, acceptance 4 and 7: a slot with an image goes out through the same steps as
// a text part (guarded intent -> send -> result), against the fake Bot API.

const CREDIT = 'zenith-claude';
const CREDIT_ESCAPED = 'Иллюстрация: zenith\\-claude';
const SHORT = 'Утро. Кто первый?';
const SHORT_CAPTION = `Утро\\. Кто первый?\n\nИИ\\-журналист\\-правдорубец Кореш Шпандент\n\n${CREDIT_ESCAPED}`;

let fake: FakeBotApi;
let store: Store;
let t: Date;
let waits: number[];
let img: ReturnType<typeof seedImage>;
let image: SlotImage;

beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
  store = openStore(':memory:');
  t = msk('09:00:30');
  waits = [];
  img = seedImage(store);
  image = { sha256: img.sha256, mime: 'image/png', width: 640, height: 480, credit: CREDIT };
});
afterEach(async () => {
  store.close();
  await fake.stop();
});

function publisher(over: Partial<PublisherOptions> = {}) {
  return createPublisher({
    store,
    blocks,
    // Generous: only the test of a hanging request wants the client to give up quickly.
    api: createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 5000 }),
    channel: CHANNEL,
    dryRun: false,
    tz: 'Europe/Moscow',
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...over,
  });
}

const pubs = () => store.publications.listForPlan(DATE);
const slot = (id: string) => store.slots.listForPlan(DATE).find((s) => s.slotId === id)!;
const alerts = (kind: string) => store.alerts.list().filter((a) => a.kind === kind);
const methods = () => fake.requests.map((r) => r.method);
const key = (part: number, id = 's1') => `telegram:${DATE}:${id}:${part}`;

describe('a short post with an image', () => {
  it('goes out as exactly one sendPhoto: the image, caption = text, signature, credit', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: SHORT, image }]);
    const p = publisher();
    expect(await p.runOnce()).toMatchObject({ slot: 's1', result: 'sent' });

    expect(methods()).toEqual(['sendPhoto']);
    const req = fake.sent('sendPhoto')[0]!;
    expect(req.contentType).toMatch(/^multipart\/form-data/);
    // Parse mode as for a text part; nothing else is sent.
    expect(req.body).toEqual({
      chat_id: CHANNEL,
      caption: SHORT_CAPTION,
      parse_mode: 'MarkdownV2',
    });
    expect(req.files.photo).toEqual({
      filename: 'image.png',
      type: 'image/png',
      size: img.bytes.length,
      sha256: img.sha256,
    });
    expect(fake.channel).toEqual([
      {
        message_id: 100,
        chat_id: CHANNEL,
        method: 'sendPhoto',
        caption: SHORT_CAPTION,
        photoSha256: img.sha256,
        parse_mode: 'MarkdownV2',
      },
    ]);

    expect(pubs()).toEqual([
      expect.objectContaining({
        key: key(0),
        part: 0,
        status: 'sent',
        messageId: '100',
        textSha256: photoHash(
          img.sha256,
          `${SHORT}\n\n${SIGNATURE_LINE}\n\nИллюстрация: ${CREDIT}`,
        ),
      }),
    ]);
    expect(slot('s1').status).toBe('done');

    // The same minute again, and later: nothing more goes out.
    await p.runOnce();
    t = msk('09:05');
    await p.runOnce();
    expect(fake.requests).toHaveLength(1);
  });

  it('the intent row is written before the photo request leaves', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: SHORT, image }]);
    const seen: unknown[] = [];
    fake.onRequest = (r) => {
      seen.push([r.method, store.publications.get(key(0))?.status]);
    };
    await publisher().runOnce();
    expect(seen).toEqual([['sendPhoto', 'intent']]);
  });

  it('the trailer is in the caption, after the signature and before the credit', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: SHORT, image }]);
    await publisher({ trailer: 'хвост' }).runOnce();
    expect(fake.channel[0]!.caption).toBe(
      `Утро\\. Кто первый?\n\nИИ\\-журналист\\-правдорубец Кореш Шпандент\n\nхвост\n\n${CREDIT_ESCAPED}`,
    );
  });
});

describe('a long post with an image', () => {
  it('sends the photo with the credit, then the text parts; rows sent with ids in order', async () => {
    const text = longText();
    seedPlan(store, [{ id: 's1', at: '09:00', text, image }]);
    expect(await publisher().runOnce()).toMatchObject({ slot: 's1', result: 'sent' });

    const n = fake.requests.length;
    expect(n).toBeGreaterThan(2);
    expect(methods()).toEqual(['sendPhoto', ...Array.from({ length: n - 1 }, () => 'sendMessage')]);
    expect(fake.sent('sendPhoto')[0]!.body).toEqual({
      chat_id: CHANNEL,
      caption: CREDIT_ESCAPED,
      parse_mode: 'MarkdownV2',
    });
    expect(fake.sent('sendPhoto')[0]!.files.photo!.sha256).toBe(img.sha256);
    const texts = fake.sent('sendMessage').map((r) => r.body.text as string);
    expect(texts[texts.length - 1]).toContain('Кореш Шпандент');
    expect(texts.join('\n')).not.toContain('Иллюстрация');
    for (const r of fake.sent('sendMessage')) {
      expect(r.body).toMatchObject({ chat_id: CHANNEL, parse_mode: 'MarkdownV2' });
    }

    expect(pubs().map((p) => [p.key, p.part, p.status, p.messageId])).toEqual(
      fake.channel.map((m, i) => [key(i), i, 'sent', String(m.message_id)]),
    );
    expect(fake.channel.map((m) => m.message_id)).toEqual(
      Array.from({ length: n }, (_, i) => 100 + i),
    );
    expect(pubs()[0]!.textSha256).toBe(photoHash(img.sha256, `Иллюстрация: ${CREDIT}`));
    expect(slot('s1').status).toBe('done');
    // ~1 msg/s per chat between the items, the photo included.
    expect(waits.filter((w) => w === 1100)).toHaveLength(n - 1);
  });

  it('the text parts are those of the same slot without an image', async () => {
    const text = longText();
    seedPlan(store, [{ id: 's1', at: '09:00', text, image }]);
    await publisher().runOnce();
    const withImage = fake.sent('sendMessage').map((r) => r.body);

    const other = openStore(':memory:');
    try {
      seedPlan(other, [{ id: 's1', at: '09:00', text }]);
      await publisher({ store: other }).runOnce();
    } finally {
      other.close();
    }
    const plain = fake.sent('sendMessage').slice(withImage.length);
    expect(plain.length).toBe(withImage.length);
    expect(plain.map((r) => r.body)).toEqual(withImage);
  });
});

describe('approval gate and DRY_RUN', () => {
  it.each(['draft', 'rejected', 'failed'] as const)('a %s plan sends no photo', async (status) => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: SHORT, image }], { status });
    await publisher().runOnce();
    expect(fake.requests).toHaveLength(0);
    expect(pubs()).toEqual([]);
  });

  it('a slot skipped after the approval sends no photo', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: SHORT, image }]);
    store.slots.setStatus(DATE, 's1', 'skipped');
    await publisher().runOnce();
    expect(fake.requests).toHaveLength(0);
  });

  it('a plan rejected between the read and the intent sends no photo and writes no row', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: SHORT, image }]);
    // The last status check before the intent still sees `approved`; the insert must not.
    const begin = store.publications.beginIntent.bind(store.publications);
    store.publications.beginIntent = (i, at) => {
      store.plans.setStatus(DATE, 'rejected');
      return begin(i, at);
    };
    expect(await publisher().runOnce()).toMatchObject({ slot: 's1', result: 'stopped' });
    expect(fake.requests).toHaveLength(0);
    expect(pubs()).toEqual([]);
  });

  it('a reject after the photo stops the text parts', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: longText(), image }]);
    fake.onRequest = () => {
      if (store.plans.get(DATE)?.status === 'approved') store.plans.setStatus(DATE, 'rejected');
    };
    expect((await publisher().runOnce()).result).toBe('stopped');
    expect(methods()).toEqual(['sendPhoto']);
    expect(pubs().map((p) => p.status)).toEqual(['sent']);
  });

  it('DRY_RUN sends nothing and writes `dry` for every item, the photo included', async () => {
    seedPlan(store, [
      { id: 's1', at: '09:00', text: SHORT, image },
      { id: 's2', at: '09:30', text: longText(), image },
    ]);
    const p = publisher({ dryRun: true, api: undefined });
    expect(await p.runOnce()).toMatchObject({ slot: 's1', result: 'dry' });
    t = msk('09:30:30');
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'dry' });
    expect(fake.requests).toHaveLength(0);
    const rows = pubs();
    expect(
      rows.filter((r) => r.slotId === 's1').map((r) => [r.part, r.status, r.messageId]),
    ).toEqual([[0, 'dry', null]]);
    const s2 = rows.filter((r) => r.slotId === 's2');
    expect(s2.length).toBeGreaterThan(2);
    expect(s2.every((r) => r.status === 'dry' && r.messageId === null)).toBe(true);
    expect(s2[0]!.textSha256).toBe(photoHash(img.sha256, `Иллюстрация: ${CREDIT}`));
    expect(slot('s1').status).toBe('done');
    expect(slot('s2').status).toBe('done');
  });

  it('DRY_RUN with a Bot API client configured (as in production) still sends nothing', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: longText(), image }]);
    // The default publisher of this file has a working client; only the mode differs.
    expect(await publisher({ dryRun: true }).runOnce()).toMatchObject({
      slot: 's1',
      result: 'dry',
    });
    expect(fake.requests).toHaveLength(0);
    expect(pubs().length).toBeGreaterThan(2);
    expect(pubs().every((r) => r.status === 'dry')).toBe(true);
  });
});

describe('Bot API failures on the photo', () => {
  it('a lost answer after the request left: unknown, alert, never resent, the text not sent', async () => {
    seedPlan(store, [
      { id: 's1', at: '09:00', text: longText(), image },
      { id: 's2', at: '10:00', text: SHORT },
    ]);
    fake.queue('sendPhoto', { drop: true });
    const p = publisher();
    expect((await p.runOnce()).result).toBe('unknown');
    expect(pubs()).toEqual([expect.objectContaining({ key: key(0), status: 'unknown' })]);
    expect(alerts('publish_unknown')).toHaveLength(1);
    expect(alerts('publish_unknown')[0]!.message).toContain(key(0));

    for (const at of ['09:00:40', '09:03', '09:30']) {
      t = msk(at);
      await p.runOnce();
    }
    // One photo is in the channel (the answer was lost), nothing else left the service.
    expect(methods()).toEqual(['sendPhoto']);
    expect(fake.channel).toHaveLength(1);
    expect(pubs().map((r) => r.status)).toEqual(['unknown']);
    expect(alerts('publish_unknown')).toHaveLength(1);

    // An unknown photo blocks only its own slot.
    t = msk('10:00:10');
    expect(await p.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
    expect(methods()).toEqual(['sendPhoto', 'sendMessage']);
  });

  it('a timeout with no answer is unknown too and is never resent', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: SHORT, image }]);
    fake.queue('sendPhoto', { hang: true });
    const p = publisher({
      api: createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 300 }),
    });
    expect((await p.runOnce()).result).toBe('unknown');
    t = msk('09:04');
    await p.runOnce();
    expect(fake.sent('sendPhoto')).toHaveLength(1);
    expect(pubs().map((r) => r.status)).toEqual(['unknown']);
  });

  it('429 and 5xx are retried as for a text part: one photo in the end', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: SHORT, image }]);
    fake.queue('sendPhoto', { status: 429, retryAfter: 4 }, { status: 502 });
    expect((await publisher().runOnce()).result).toBe('sent');
    expect(waits).toEqual([4000, 1000]);
    expect(fake.sent('sendPhoto')).toHaveLength(3);
    expect(fake.channel).toHaveLength(1);
    expect(fake.channel[0]!.photoSha256).toBe(img.sha256);
    expect(pubs().map((r) => r.status)).toEqual(['sent']);
  });

  it('4xx on the photo: failed, alert, slot skipped, the text parts never sent', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: longText(), image }]);
    fake.queue('sendPhoto', { status: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' });
    const p = publisher();
    expect((await p.runOnce()).result).toBe('failed');
    expect(pubs()).toEqual([
      expect.objectContaining({
        key: key(0),
        status: 'failed',
        error: expect.stringContaining('PHOTO'),
      }),
    ]);
    expect(slot('s1').status).toBe('skipped');
    expect(alerts('publish_failed')[0]!.message).toContain('nothing was sent');
    t = msk('09:05');
    await p.runOnce();
    expect(methods()).toEqual(['sendPhoto']);
    expect(fake.channel).toHaveLength(0);
  });

  it('a failed text part after the photo: the alert says earlier parts are out', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: longText(), image }]);
    fake.queue('sendMessage', { status: 400, description: 'Bad Request' });
    expect((await publisher().runOnce()).result).toBe('failed');
    expect(pubs().map((r) => r.status)).toEqual(['sent', 'failed']);
    expect(alerts('publish_failed')[0]!.message).toContain('earlier parts are out');
    expect(slot('s1').status).toBe('planned');
  });
});

describe('refusals: nothing is sent', () => {
  const refused = async (p = publisher()) => {
    expect((await p.runOnce()).result).toBe('refused');
    expect(fake.requests).toHaveLength(0);
    expect(alerts('publish_refused')).toHaveLength(1);
    expect(slot('s1').status).toBe('skipped');
    return pubs();
  };

  it('an image that is not in the store', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: SHORT, image }]);
    store.db.exec('DELETE FROM images');
    const p = publisher();
    const rows = await refused(p);
    expect(rows).toEqual([
      expect.objectContaining({
        key: key(0),
        status: 'failed',
        error: expect.stringContaining(`image ${img.sha256.slice(0, 12)}`),
      }),
    ]);
    expect(alerts('publish_refused')[0]!.message).toContain('nothing was sent');
    // Once: the slot is not retried every minute.
    t = msk('09:02');
    await p.runOnce();
    expect(alerts('publish_refused')).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);
  });

  it('a missing image is refused in DRY_RUN too (no `dry` row for a post that cannot go)', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: longText(), image }]);
    store.db.exec('DELETE FROM images');
    const rows = await refused(publisher({ dryRun: true, api: undefined }));
    expect(rows.map((r) => r.status)).toEqual(['failed']);
  });

  it('a text without the signature: the photo is not sent either (D-9)', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: 'Без подписи. Как так?', image }], {
      raw: true,
    });
    const rows = await refused();
    expect(rows[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('signature'),
    });
  });

  it('an image on a poll slot (cannot be stored through the API)', async () => {
    seedPlan(store, [
      {
        id: 's1',
        at: '09:00',
        kind: 'poll',
        text: 'Опрос дня.',
        poll: { question: 'Кто прав?', options: ['я', 'ты'], allowsMultiple: false },
        image,
      },
    ]);
    const rows = await refused();
    expect(rows[0]!.error).toContain('poll slot cannot carry an image');
  });
});

describe('resume after an interruption', () => {
  it('the photo row is `sent`: only the text parts go out, the photo is not sent again', async () => {
    seedPlan(store, [{ id: 's1', at: '09:00', text: longText(), image }]);
    store.publications.beginIntent(
      { key: key(0), platform: 'telegram', planDate: DATE, slotId: 's1', part: 0, textSha256: 'x' },
      msk('09:00:01'),
    );
    store.publications.markSent(key(0), '42', msk('09:00:02'));
    expect(await publisher().runOnce()).toMatchObject({ slot: 's1', result: 'sent' });
    expect(fake.sent('sendPhoto')).toHaveLength(0);
    const n = pubs().length;
    expect(n).toBeGreaterThan(2);
    expect(fake.sent('sendMessage')).toHaveLength(n - 1);
    expect(pubs().map((r) => r.status)).toEqual(Array.from({ length: n }, () => 'sent'));
    expect(slot('s1').status).toBe('done');
  });

  it.each(['intent', 'unknown', 'failed'] as const)(
    'the photo row is `%s`: nothing of the slot is sent',
    async (status) => {
      seedPlan(store, [{ id: 's1', at: '09:00', text: longText(), image }]);
      store.publications.beginIntent(
        {
          key: key(0),
          platform: 'telegram',
          planDate: DATE,
          slotId: 's1',
          part: 0,
          textSha256: 'x',
        },
        msk('09:00:20'),
      );
      if (status === 'unknown') store.publications.markUnknown(key(0), 'lost');
      if (status === 'failed') store.publications.markFailed(key(0), 'refused');
      const p = publisher();
      await p.runOnce();
      t = msk('09:01');
      await p.runOnce();
      expect(fake.requests).toHaveLength(0);
      expect(pubs()).toHaveLength(1);
    },
  );
});

describe('slots with and without an image in one day', () => {
  it('each slot keeps its own numbering: part 0 is the photo only where there is an image', async () => {
    seedPlan(store, [
      { id: 's1', at: '09:00', text: SHORT },
      { id: 's2', at: '10:00', text: SHORT, image },
      {
        id: 'q1',
        at: '11:00',
        kind: 'poll',
        text: 'Опрос дня.',
        poll: { question: 'Кто прав?', options: ['я', 'ты'], allowsMultiple: false },
      },
    ]);
    const p = publisher();
    for (const at of ['09:00:30', '10:00:30', '11:00:30']) {
      t = msk(at);
      await p.runOnce();
    }
    expect(methods()).toEqual(['sendMessage', 'sendPhoto', 'sendMessage', 'sendPoll']);
    expect(pubs().map((r) => r.key)).toEqual([
      key(0, 'q1'),
      key(1, 'q1'),
      key(0, 's1'),
      key(0, 's2'),
    ]);
    expect(fake.sent('sendMessage')[0]!.body).not.toHaveProperty('caption');
    expect(fake.sent('sendMessage')[0]!.contentType).toBe('application/json');
  });
});
