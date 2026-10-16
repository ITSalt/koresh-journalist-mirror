import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { textHash } from '../../src/lib/idempotency.js';
import { SIGNATURE_LINE } from '../../src/plan/pipeline.js';
import { FRAME_TEXTS } from '../../src/platforms/frame.js';
import { createPublisher } from '../../src/publish/publisher.js';
import {
  createVariantPublisher,
  type FirstComment,
  type VariantPublisherOptions,
} from '../../src/publish/variant-publisher.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { blocks } from '../support/blocks.js';
import {
  failed,
  fakeAdapter,
  refused,
  unknown,
  type FakeAdapter,
} from '../support/fake-adapter.js';
import { FakeBotApi } from '../support/fake-bot-api.js';
import { CHANNEL, DATE, msk, TOKEN } from './helpers.js';
import { seedVariantPlan, variantKey, variantRow } from './variant-helpers.js';

// WP-PLAT-02 scope items 3, 4, 5 and 7 (acceptance 2, 3, 4): the publish loop of a platform
// outside Telegram, driven with two scripted fake adapters. No platform code, no network.

const API_TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const LINK = 'https://t.me/Channel1/57';

let fake: FakeBotApi;
let store: Store;
let t: Date;
let threads: FakeAdapter;
let linkedin: FakeAdapter;
beforeEach(async () => {
  fake = await new FakeBotApi(TOKEN).start();
  store = openStore(':memory:');
  t = msk('08:00');
  threads = fakeAdapter('threads');
  linkedin = fakeAdapter('linkedin', { comment: true });
});
afterEach(async () => {
  store.close();
  await fake.stop();
});

const loop = (adapter: FakeAdapter, over: Partial<VariantPublisherOptions> = {}) =>
  createVariantPublisher({
    store,
    blocks,
    platform: adapter.platform,
    adapter,
    dryRun: false,
    tz: 'Europe/Moscow',
    now: () => t,
    ...(adapter.platform === 'linkedin' ? { link: LINK } : {}),
    ...over,
  });
const telegram = () =>
  createPublisher({
    store,
    blocks,
    api: createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 1000 }),
    channel: CHANNEL,
    dryRun: false,
    tz: 'Europe/Moscow',
    now: () => t,
    sleep: async () => undefined,
  });
const server = () =>
  buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: API_TOKEN, TELEGRAM_BOT_TOKEN: TOKEN }),
    store,
    logLevel: 'silent',
    now: () => t,
  });
const reject = () =>
  server().inject({
    method: 'POST',
    url: `/v1/plans/${DATE}/reject`,
    headers: auth,
    payload: { reason: 'off topic' },
  });

const rows = (platform?: string) =>
  store.publications.listForPlan(DATE).filter((p) => !platform || p.platform === platform);
const row = (key: string) => store.publications.get(key)!;
const alerts = (kind?: string) => store.alerts.list().filter((a) => !kind || a.kind === kind);
/** A comment is always due / never due. */
const always: FirstComment = { due: () => true };

const DAY = [
  { id: 's1', at: '09:00', text: 'Утро. Кто первый?' },
  { id: 's2', at: '19:00', text: 'Вечер. Кто последний?' },
];
const BODY = 'Тишина третий день. Кто нарушит её первым?';
const VARIANTS = [
  { slot: 's1', platform: 'threads', at: '09:07:41', text: BODY },
  { slot: 's1', platform: 'linkedin', at: '10:12:09', text: BODY },
  { slot: 's1', platform: 'linkedin', lang: 'en', at: '10:40', text: 'Silence. Who breaks it?' },
] as const;
const signed = (text: string) => `${text}\n\n${SIGNATURE_LINE}`;

describe('a due variant is published once', () => {
  it('Threads: at its second, the stored text as is, one sent row with id and url', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const p = loop(threads);

    t = msk('09:07:40');
    const early = await p.runOnce();
    expect(early).toEqual({
      platform: 'threads',
      date: DATE,
      skipped: [],
      wakeAt: msk('09:07:41').toISOString(),
    });
    expect(threads.calls).toEqual([]);

    t = msk('09:07:41');
    const it = await p.runOnce();
    expect(it).toMatchObject({ variant: 's1-ru', item: 'post', result: 'sent', again: true });
    expect(threads.calls).toEqual(['validate', 'publish']);
    // Body and signature only: no header, no disclaimer, no link on Threads (D-1).
    expect(threads.posts).toEqual([
      { key: `threads:${DATE}:s1-ru:0`, text: signed(BODY), lang: 'ru' },
    ]);
    expect(rows('threads')).toEqual([
      {
        key: `threads:${DATE}:s1-ru:0`,
        platform: 'threads',
        planDate: DATE,
        slotId: 's1',
        part: 0,
        status: 'sent',
        messageId: 'threads-post-1',
        textSha256: textHash(signed(BODY)),
        createdAt: t.toISOString(),
        sentAt: t.toISOString(),
        error: null,
        url: 'https://threads.example/p/1',
      },
    ]);
    expect(variantRow(store, 's1', 'threads').status).toBe('done');

    // Later iterations send nothing more for it.
    for (const at of ['09:07:42', '09:30', '12:00']) {
      t = msk(at);
      expect((await p.runOnce()).result).toBeUndefined();
    }
    expect(threads.posts).toHaveLength(1);
    expect(alerts()).toEqual([]);
  });

  it('LinkedIn: header, body with signature, disclaimer; the link goes to the adapter apart', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const p = loop(linkedin);
    t = msk('10:12:09');
    expect((await p.runOnce()).result).toBe('sent');
    const f = FRAME_TEXTS.ru;
    expect(linkedin.posts).toEqual([
      {
        key: `linkedin:${DATE}:s1-ru:0`,
        text: `${f.header}\n\n${signed(BODY)}\n\n${f.disclaimer.comment}`,
        lang: 'ru',
        link: LINK,
      },
    ]);
    expect(row(`linkedin:${DATE}:s1-ru:0`)).toMatchObject({
      status: 'sent',
      messageId: 'linkedin-post-1',
      url: 'https://linkedin.example/p/1',
      slotId: 's1',
    });
    // The English variant of the same slot is its own item with its own key and time.
    t = msk('10:40');
    expect(await p.runOnce()).toMatchObject({ variant: 's1-en', result: 'sent' });
    expect(linkedin.posts[1]).toMatchObject({ key: `linkedin:${DATE}:s1-en:0`, lang: 'en' });
    expect(rows('linkedin').map((r) => [r.key, r.status])).toEqual([
      [`linkedin:${DATE}:s1-en:0`, 'sent'],
      [`linkedin:${DATE}:s1-ru:0`, 'sent'],
    ]);
  });

  it('the intent row is written before the adapter is asked to publish', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    let seen: unknown;
    threads.onPublish = (input) => {
      seen = store.publications.get(input.key);
    };
    t = msk('09:07:41');
    await loop(threads).runOnce();
    expect(seen).toMatchObject({ key: `threads:${DATE}:s1-ru:0`, status: 'intent' });
  });

  it('a draft or rejected day and a day without variants publish nothing', async () => {
    for (const status of ['draft', 'rejected'] as const) {
      store.close();
      store = openStore(':memory:');
      seedVariantPlan(store, DAY, [...VARIANTS], { status });
      t = msk('12:00');
      expect(await loop(threads).runOnce()).toEqual({
        platform: 'threads',
        date: DATE,
        skipped: [],
      });
    }
    store.close();
    store = openStore(':memory:');
    seedVariantPlan(store, DAY, []);
    expect(await loop(threads).runOnce()).toEqual({ platform: 'threads', date: DATE, skipped: [] });
    expect(threads.calls).toEqual([]);
    expect(rows()).toEqual([]);
  });
});

describe('outcomes: nothing is ever resent', () => {
  it('unknown blocks only that variant, raises one alert, and is never sent again', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    linkedin.publishQueue.push(unknown('no_answer: create post: TimeoutError'));
    const p = loop(linkedin);
    t = msk('10:12:09');
    expect((await p.runOnce()).result).toBe('unknown');
    expect(row(`linkedin:${DATE}:s1-ru:0`)).toMatchObject({
      status: 'unknown',
      error: 'no_answer: create post: TimeoutError',
    });
    expect(variantRow(store, 's1', 'linkedin').status).toBe('planned');
    expect(alerts().map((a) => [a.kind, a.message])).toEqual([
      [
        'publish_unknown',
        `linkedin:${DATE}:s1-ru:0: no_answer: create post: TimeoutError; it may be posted on linkedin. Not resent: check the linkedin profile`,
      ],
    ]);
    // Every later iteration of the day: the blocked variant is not offered again, the other
    // variant of the platform goes out at its own time.
    for (const at of ['10:12:10', '10:13', '10:39:59']) {
      t = msk(at);
      expect((await p.runOnce()).result).toBeUndefined();
    }
    expect(linkedin.calls.filter((c) => c === 'publish')).toHaveLength(1);
    t = msk('10:40');
    expect(await p.runOnce()).toMatchObject({ variant: 's1-en', result: 'sent' });
    expect(linkedin.calls.filter((c) => c === 'publish')).toHaveLength(2);
    expect(alerts()).toHaveLength(1);
    // A new process on the same day does not send it either.
    t = msk('11:00');
    await loop(linkedin).runOnce();
    expect(linkedin.calls.filter((c) => c === 'publish')).toHaveLength(2);
    // The blocked variant is still what it was: planned, with its unknown row, no comment.
    expect(variantRow(store, 's1', 'linkedin').status).toBe('planned');
    expect(row(`linkedin:${DATE}:s1-ru:0`).status).toBe('unknown');
    expect(linkedin.calls).not.toContain('comment');
  });

  it('an adapter that throws is an unknown outcome, not a clean miss', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    threads.publishQueue.push('throw');
    t = msk('09:07:41');
    expect((await loop(threads).runOnce()).result).toBe('unknown');
    expect(row(`threads:${DATE}:s1-ru:0`).status).toBe('unknown');
    expect(alerts('publish_unknown')).toHaveLength(1);
  });

  it.each([
    ['refused', refused('rejected: HTTP 400'), ''],
    ['failed', failed('rate_limited: HTTP 429', 3600), ' (the platform asked to wait 3600 s)'],
  ] as const)(
    '%s marks the row failed, skips the variant and alerts once',
    async (name, o, wait) => {
      seedVariantPlan(store, DAY, [...VARIANTS]);
      threads.publishQueue.push(o);
      const p = loop(threads);
      t = msk('09:07:41');
      expect((await p.runOnce()).result).toBe('failed');
      expect(row(`threads:${DATE}:s1-ru:0`)).toMatchObject({
        status: 'failed',
        error: o.description,
      });
      expect(variantRow(store, 's1', 'threads').status).toBe('skipped');
      // The text says the cost: the variant is not retried, it is lost for the day.
      expect(alerts().map((a) => [a.kind, a.message])).toEqual([
        [
          'publish_failed',
          `threads:${DATE}:s1-ru:0: ${name}: ${o.description}${wait}; nothing was sent on threads. Not resent: this variant is lost for the day`,
        ],
      ]);
      for (const at of ['09:07:42', '09:30', '10:00']) {
        t = msk(at);
        await p.runOnce();
      }
      expect(threads.calls.filter((c) => c === 'publish')).toHaveLength(1);
      expect(threads.posts).toEqual([]);
    },
  );

  it('a text the adapter does not validate is refused without a publish call', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    threads.issues = () => [{ code: 'too_long', message: 'the text counts 501, the limit is 500' }];
    t = msk('09:07:41');
    expect((await loop(threads).runOnce()).result).toBe('refused');
    expect(threads.calls).toEqual(['validate']);
    expect(row(`threads:${DATE}:s1-ru:0`)).toMatchObject({
      status: 'failed',
      error: 'refused: too_long (the text counts 501, the limit is 500)',
    });
    expect(variantRow(store, 's1', 'threads').status).toBe('skipped');
    expect(alerts('publish_refused')).toHaveLength(1);
  });

  it('secrets are scrubbed from what is stored and alerted', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    threads.publishQueue.push(unknown('timeout with SECRET-MARKER-123456 inside'));
    t = msk('09:07:41');
    await loop(threads, { scrub: (s) => s.split('SECRET-MARKER-123456').join('[X]') }).runOnce();
    expect(JSON.stringify([rows(), alerts()])).not.toContain('SECRET-MARKER');
  });
});

describe('a reject of the day wins', () => {
  /** Rejects the day right after the scheduler has decided, before the claim. */
  const rejectAfterDecide = (): Pick<typeof blocks, 'decide'> => ({
    decide(input) {
      const d = blocks.decide(input);
      if (d.publish) store.plans.setStatus(DATE, 'rejected');
      return d;
    },
  });

  it('a reject between decide and send: nothing is sent and no row is written', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    t = msk('09:07:41');
    const it = await loop(threads, { blocks: rejectAfterDecide() }).runOnce();
    expect(it).toMatchObject({ variant: 's1-ru', result: 'stopped' });
    expect(threads.calls).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it('the 409 branch (the plan stays approved): the skipped variant is not sent either', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const skipAfterDecide: Pick<typeof blocks, 'decide'> = {
      decide(input) {
        const d = blocks.decide(input);
        if (d.publish) store.slotVariants.setStatus(DATE, 's1', 'threads', 'ru', 'skipped');
        return d;
      },
    };
    t = msk('09:07:41');
    expect((await loop(threads, { blocks: skipAfterDecide }).runOnce()).result).toBe('stopped');
    expect(threads.calls).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it('reject after the Telegram slot s1 is sent: no variant of the day goes out on any platform', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    t = msk('09:00');
    expect((await telegram().runOnce()).result).toBe('sent');
    expect((await reject()).statusCode).toBe(409);
    const loops = [loop(threads), loop(linkedin)];
    for (const at of ['09:07:41', '10:12:09', '10:40', '12:00', '19:00', '23:00']) {
      t = msk(at);
      for (const p of loops) expect((await p.runOnce()).result).toBeUndefined();
    }
    expect([...threads.calls, ...linkedin.calls]).toEqual([]);
    expect(rows().map((r) => r.platform)).toEqual(['telegram']);
    // Skipped by the reject, not by the grace window: no alert for them.
    expect(alerts('variant_skipped')).toEqual([]);
  });

  it('reject before anything is sent (200): the same on every platform', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    expect((await reject()).statusCode).toBe(200);
    for (const at of ['09:07:41', '10:12:09', '10:40']) {
      t = msk(at);
      await loop(threads).runOnce();
      await loop(linkedin).runOnce();
    }
    expect([...threads.calls, ...linkedin.calls]).toEqual([]);
    expect(rows()).toEqual([]);
  });
});

describe('the scheduler per platform', () => {
  it("each platform's min gap counts only its own rows", async () => {
    seedVariantPlan(
      store,
      [
        { id: 's1', at: '12:00' },
        { id: 's2', at: '12:04' },
      ],
      [
        { slot: 's1', platform: 'threads', at: '12:00' },
        { slot: 's2', platform: 'threads', at: '12:05' },
        { slot: 's2', platform: 'linkedin', at: '12:05' },
      ],
    );
    const th = loop(threads);
    const li = loop(linkedin);
    t = msk('12:00');
    expect((await telegram().runOnce()).result).toBe('sent');
    expect((await th.runOnce()).result).toBe('sent');

    t = msk('12:05');
    // LinkedIn has no row of its own yet: neither the Threads post nor the Telegram one delays it.
    expect(await li.runOnce()).toMatchObject({ variant: 's2-ru', result: 'sent' });
    // The second Threads variant waits for the Threads gap (20 minutes after 12:00).
    const waiting = await th.runOnce();
    expect(waiting.result).toBeUndefined();
    expect(waiting.wakeAt).toBe(msk('12:20').toISOString());
    t = msk('12:20');
    expect(await th.runOnce()).toMatchObject({ variant: 's2-ru', result: 'sent' });
  });

  it('grace and min gap come from the options of the platform', async () => {
    seedVariantPlan(
      store,
      [{ id: 's1', at: '12:00' }],
      [
        { slot: 's1', platform: 'linkedin', at: '12:00' },
        { slot: 's1', platform: 'linkedin', lang: 'en', at: '12:03' },
      ],
    );
    const p = loop(linkedin, { rules: { minGapMin: 2, graceMin: 5 } });
    t = msk('12:00');
    expect((await p.runOnce()).result).toBe('sent');
    t = msk('12:03');
    expect(await p.runOnce()).toMatchObject({ variant: 's1-en', result: 'sent' });
  });

  it('a variant past its grace window is skipped with an alert; the Telegram slot is not touched', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    t = msk('10:40'); // 09:07:41 + 90 min = 10:37:41
    const it = await loop(threads).runOnce();
    expect(it.skipped).toEqual(['s1-ru']);
    expect(variantRow(store, 's1', 'threads').status).toBe('skipped');
    expect(alerts().map((a) => [a.kind, a.message])).toEqual([
      [
        'variant_skipped',
        `variant ${DATE}/s1-ru on threads is past its grace window and was skipped`,
      ],
    ]);
    expect(threads.calls).toEqual([]);
    expect(store.slots.listForPlan(DATE).map((s) => s.status)).toEqual(['planned', 'planned']);
    expect(variantRow(store, 's1', 'linkedin').status).toBe('planned');
  });

  it('reconciles only its own stale intents, with an alert that names the platform', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const claim = (platform: 'threads' | 'linkedin') =>
      store.publications.beginVariantIntent(
        {
          key: variantKey('s1', platform),
          platform,
          planDate: DATE,
          slotId: 's1',
          lang: 'ru',
          textSha256: 'f'.repeat(64),
          expectVariantJson: variantRow(store, 's1', platform).json,
        },
        msk('09:08'),
      );
    claim('threads');
    claim('linkedin');
    store.publications.beginIntent(
      {
        key: `telegram:${DATE}:s1:0`,
        platform: 'telegram',
        planDate: DATE,
        slotId: 's1',
        textSha256: 'a'.repeat(64),
      },
      msk('09:08'),
    );
    t = msk('09:09'); // one minute: nothing is stale yet
    expect(loop(threads).reconcile()).toEqual([]);
    t = msk('09:11');
    expect(loop(threads).reconcile()).toEqual([`threads:${DATE}:s1-ru:0`]);
    expect(rows().map((r) => [r.platform, r.status])).toEqual([
      ['linkedin', 'intent'],
      ['telegram', 'intent'],
      ['threads', 'unknown'],
    ]);
    expect(alerts().map((a) => [a.kind, a.message])).toEqual([
      [
        'publish_unknown',
        `threads:${DATE}:s1-ru:0: an intent was left without a result (restart); it may be posted on threads. Not resent: check the threads profile`,
      ],
    ]);
    // ... and the variant stays blocked: the loop sends nothing for it.
    expect((await loop(threads).runOnce()).result).toBeUndefined();
    expect(threads.calls).toEqual([]);
  });
});

describe('dry run per platform (scope item 5, acceptance 4)', () => {
  it('records dry rows and calls no method of the adapter', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const th = loop(threads, { dryRun: true });
    const li = loop(linkedin, { dryRun: true, firstComment: always });
    for (const at of ['09:07:41', '09:07:42', '10:12:09', '10:12:10', '10:40', '10:41', '12:00']) {
      t = msk(at);
      await th.runOnce();
      await li.runOnce();
    }
    expect([...threads.calls, ...linkedin.calls]).toEqual([]);
    expect(rows().map((r) => [r.key, r.status, r.messageId])).toEqual([
      [`linkedin:${DATE}:s1-en:0`, 'dry', null],
      [`linkedin:${DATE}:s1-ru:0`, 'dry', null],
      [`threads:${DATE}:s1-ru:0`, 'dry', null],
    ]);
    expect(store.slotVariants.listForPlan(DATE).map((v) => v.status)).toEqual([
      'done',
      'done',
      'done',
    ]);
    expect(alerts()).toEqual([]);
  });

  it('a dry run needs no adapter at all; a live loop without one is refused at construction', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const p = createVariantPublisher({
      store,
      blocks,
      platform: 'threads',
      dryRun: true,
      tz: 'Europe/Moscow',
      now: () => t,
    });
    t = msk('09:07:41');
    expect((await p.runOnce()).result).toBe('dry');
    expect(() =>
      createVariantPublisher({
        store,
        blocks,
        platform: 'threads',
        dryRun: false,
        tz: 'Europe/Moscow',
      }),
    ).toThrow(/needs an adapter/);
  });

  it('one platform dry, the other live', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const th = loop(threads, { dryRun: true });
    const li = loop(linkedin);
    t = msk('10:12:09');
    await th.runOnce();
    await li.runOnce();
    expect(threads.calls).toEqual([]);
    expect(linkedin.posts).toHaveLength(1);
    expect(rows().map((r) => [r.platform, r.status])).toEqual([
      ['linkedin', 'sent'],
      ['threads', 'dry'],
    ]);
  });
});

describe('the first comment is its own item (scope item 4, acceptance 3)', () => {
  const POST = `linkedin:${DATE}:s1-ru:0`;
  const COMMENT = `linkedin:${DATE}:s1-ru:1`;
  const ONE = [{ slot: 's1', platform: 'linkedin', at: '10:12:09', text: BODY }] as const;

  it('goes out only after the post row is sent, with its own key (part 1)', async () => {
    seedVariantPlan(store, DAY, [...ONE]);
    let postRowAtComment: unknown;
    linkedin.onComment = () => {
      postRowAtComment = store.publications.get(POST);
    };
    const p = loop(linkedin, { firstComment: always });
    t = msk('10:12:09');
    expect(await p.runOnce()).toMatchObject({ item: 'post', result: 'sent', again: true });
    // The post is out and recorded; the comment has not been asked for yet.
    expect(linkedin.calls).toEqual(['validate', 'publish']);
    expect(row(POST).status).toBe('sent');
    expect(variantRow(store, 's1', 'linkedin').status).toBe('planned');

    expect(await p.runOnce()).toMatchObject({ item: 'comment', result: 'sent' });
    expect(linkedin.calls).toEqual(['validate', 'publish', 'comment']);
    expect(postRowAtComment).toMatchObject({ key: POST, status: 'sent' });
    expect(linkedin.comments).toEqual([{ postId: 'linkedin-post-1', text: LINK, key: COMMENT }]);
    expect(rows().map((r) => [r.key, r.part, r.status, r.messageId])).toEqual([
      [POST, 0, 'sent', 'linkedin-post-1'],
      [COMMENT, 1, 'sent', 'linkedin-comment-1'],
    ]);
    expect(variantRow(store, 's1', 'linkedin').status).toBe('done');
    // Nothing more, ever.
    for (const at of ['10:12:10', '10:30', '12:00']) {
      t = msk(at);
      expect((await p.runOnce()).result).toBeUndefined();
    }
    expect(linkedin.calls).toEqual(['validate', 'publish', 'comment']);
    expect(alerts()).toEqual([]);
  });

  it('comment unknown: the post row stays sent, exactly one alert, never resent', async () => {
    seedVariantPlan(store, DAY, [...ONE]);
    linkedin.commentQueue.push(unknown('no_answer: create comment: TimeoutError'));
    const p = loop(linkedin, { firstComment: always });
    t = msk('10:12:09');
    await p.runOnce();
    const post = row(POST);
    expect((await p.runOnce()).result).toBe('unknown');
    expect(row(POST)).toEqual(post);
    expect(row(COMMENT)).toMatchObject({ status: 'unknown', part: 1 });
    expect(alerts().map((a) => [a.kind, a.message])).toEqual([
      [
        'comment_unknown',
        `${COMMENT}: no_answer: create comment: TimeoutError; the first comment may be posted on linkedin. Not resent; the post ${POST} is out`,
      ],
    ]);
    for (const at of ['10:12:10', '10:30', '12:00']) {
      t = msk(at);
      await p.runOnce();
    }
    expect(linkedin.calls.filter((c) => c === 'comment')).toHaveLength(1);
    expect(linkedin.calls.filter((c) => c === 'publish')).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
  });

  it.each([
    ['refused', refused('comment_forbidden: HTTP 403'), 'comment_failed'],
    ['throws', 'throw', 'comment_unknown'],
  ] as const)('comment %s: the post row is not touched', async (_n, scripted, kind) => {
    seedVariantPlan(store, DAY, [...ONE]);
    linkedin.commentQueue.push(scripted);
    const p = loop(linkedin, { firstComment: always });
    t = msk('10:12:09');
    await p.runOnce();
    const post = row(POST);
    await p.runOnce();
    expect(row(POST)).toEqual(post);
    expect(alerts().map((a) => a.kind)).toEqual([kind]);
    expect(variantRow(store, 's1', 'linkedin').status).toBe('done');
  });

  it.each([
    ['unknown', unknown()],
    ['failed', failed()],
    ['refused', refused()],
  ] as const)('a post that is %s gets no comment', async (_n, o) => {
    seedVariantPlan(store, DAY, [...ONE]);
    linkedin.publishQueue.push(o);
    const p = loop(linkedin, { firstComment: always });
    for (const at of ['10:12:09', '10:12:10', '10:13', '11:00']) {
      t = msk(at);
      await p.runOnce();
    }
    expect(linkedin.calls.filter((c) => c === 'comment')).toEqual([]);
    expect(rows().map((r) => r.part)).toEqual([0]);
  });

  it('no comment when the link mode does not ask for one, when the adapter has none, or without a link', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    const never: FirstComment = { due: () => false };
    const li = loop(linkedin, { firstComment: never });
    const th = loop(threads, { firstComment: always, link: LINK }); // Threads has no `comment`
    for (const at of ['09:07:41', '09:07:42', '10:12:09', '10:12:10']) {
      t = msk(at);
      await li.runOnce();
      await th.runOnce();
    }
    expect(linkedin.calls).toEqual(['validate', 'publish']);
    expect(threads.calls).toEqual(['validate', 'publish']);
    expect(rows().every((r) => r.part === 0)).toBe(true);
    expect(variantRow(store, 's1', 'linkedin').status).toBe('done');
    expect(variantRow(store, 's1', 'threads').status).toBe('done');

    store.close();
    store = openStore(':memory:');
    seedVariantPlan(store, DAY, [...ONE]);
    const noLink = fakeAdapter('linkedin', { comment: true });
    const p = loop(noLink, { firstComment: always, link: undefined });
    t = msk('10:12:09');
    await p.runOnce();
    await p.runOnce();
    expect(noLink.calls).toEqual(['validate', 'publish']);
  });

  it('a reject between the post and its comment stops the comment (both branches)', async () => {
    for (const branch of [200, 409] as const) {
      store.close();
      store = openStore(':memory:');
      linkedin = fakeAdapter('linkedin', { comment: true });
      seedVariantPlan(store, DAY, [...ONE]);
      const p = loop(linkedin, { firstComment: always });
      t = msk('10:12:09');
      await p.runOnce();
      // The LinkedIn post is out, so the route answers 409 and skips what is still planned.
      expect((await reject()).statusCode).toBe(409);
      if (branch === 200) store.plans.setStatus(DATE, 'rejected');
      for (const at of ['10:12:10', '10:13', '11:00']) {
        t = msk(at);
        await p.runOnce();
      }
      expect(linkedin.calls, String(branch)).toEqual(['validate', 'publish']);
      expect(rows().map((r) => [r.part, r.status])).toEqual([[0, 'sent']]);
    }
  });

  it('a restart between the post and its comment: the comment goes out once', async () => {
    seedVariantPlan(store, DAY, [...ONE]);
    t = msk('10:12:09');
    await loop(linkedin, { firstComment: always }).runOnce();
    // A new process (a new loop on the same database), a minute later.
    t = msk('10:13:09');
    const p = loop(linkedin, { firstComment: always });
    expect(await p.runOnce()).toMatchObject({ item: 'comment', result: 'sent' });
    await p.runOnce();
    await loop(linkedin, { firstComment: always }).runOnce();
    expect(linkedin.calls.filter((c) => c === 'comment')).toHaveLength(1);
    expect(linkedin.calls.filter((c) => c === 'publish')).toHaveLength(1);
  });

  it('a crash while the comment is in flight: comment_unknown, and the variant is done', async () => {
    seedVariantPlan(store, DAY, [...ONE]);
    t = msk('10:12:09');
    await loop(linkedin, { firstComment: always }).runOnce();
    // The process died right after the comment was claimed: its intent is left behind.
    store.publications.beginCommentIntent(
      {
        key: COMMENT,
        platform: 'linkedin',
        planDate: DATE,
        slotId: 's1',
        lang: 'ru',
        part: 1,
        textSha256: 'c'.repeat(64),
        postKey: POST,
      },
      msk('10:12:10'),
    );
    const post = row(POST);
    // A fresh intent blocks: nothing is sent, the variant waits.
    t = msk('10:13');
    expect((await loop(linkedin, { firstComment: always }).runOnce()).result).toBeUndefined();
    expect(variantRow(store, 's1', 'linkedin').status).toBe('planned');
    // Stale: the comment row becomes unknown under its own alert kind, the variant is done.
    t = msk('10:15');
    const p = loop(linkedin, { firstComment: always });
    await p.runOnce();
    expect(row(COMMENT).status).toBe('unknown');
    expect(row(POST)).toEqual(post);
    expect(alerts().map((a) => [a.kind, a.message])).toEqual([
      [
        'comment_unknown',
        `${COMMENT}: an intent was left without a result (restart); the first comment may be posted on linkedin. Not resent: check the post on the linkedin profile`,
      ],
    ]);
    expect(variantRow(store, 's1', 'linkedin').status).toBe('done');
    for (const at of ['10:16', '11:00']) {
      t = msk(at);
      await p.runOnce();
    }
    expect(linkedin.calls).toEqual(['validate', 'publish']);
    expect(alerts()).toHaveLength(1);
  });

  it('a variant that is not complete stays planned: post unknown, or a comment still in flight', async () => {
    seedVariantPlan(store, DAY, [...ONE]);
    linkedin.publishQueue.push(unknown());
    const p = loop(linkedin, { firstComment: always });
    for (const at of ['10:12:09', '10:13', '10:30']) {
      t = msk(at);
      await p.runOnce();
    }
    expect(variantRow(store, 's1', 'linkedin').status).toBe('planned');
    // Even with a final comment row beside it (the claim never allows this; written by hand): a
    // variant is done only when its post is sent.
    store.publications.beginIntent(
      {
        key: COMMENT,
        platform: 'linkedin',
        planDate: DATE,
        slotId: 's1',
        part: 1,
        textSha256: 'c'.repeat(64),
      },
      msk('10:31'),
    );
    store.publications.markFailed(COMMENT, 'x');
    t = msk('10:32');
    await p.runOnce();
    expect(variantRow(store, 's1', 'linkedin').status).toBe('planned');
  });

  it('a comment that became due only after its window is not sent late', async () => {
    seedVariantPlan(store, DAY, [...ONE]);
    t = msk('10:12:09');
    await loop(linkedin, { firstComment: always }).runOnce();
    t = msk('12:00'); // more than 90 minutes after the variant's time
    expect((await loop(linkedin, { firstComment: always }).runOnce()).result).toBe('skipped');
    expect(linkedin.calls.filter((c) => c === 'comment')).toEqual([]);
    expect(row(COMMENT)).toMatchObject({ status: 'failed' });
    expect(row(POST).status).toBe('sent');
    expect(alerts().map((a) => a.kind)).toEqual(['comment_skipped']);
  });

  it('the policy is told the outcome once and its alert replaces the generic one', async () => {
    seedVariantPlan(store, DAY, [...ONE]);
    const outcomes: unknown[] = [];
    let due = true;
    const policy: FirstComment = {
      due: () => due,
      settled(outcome) {
        outcomes.push(outcome);
        due = false;
        return { kind: 'linkedin_comment_works', text: 'switch the mode' };
      },
    };
    const p = loop(linkedin, { firstComment: policy });
    t = msk('10:12:09');
    await p.runOnce();
    await p.runOnce();
    expect(outcomes).toEqual([{ ok: true, result: { id: 'linkedin-comment-1' } }]);
    expect(alerts().map((a) => [a.kind, a.message])).toEqual([
      ['linkedin_comment_works', `${COMMENT}: switch the mode`],
    ]);
  });
});

describe('three loops: a failing platform delays nobody (acceptance 2)', () => {
  it('Threads hangs for ever and then always fails; Telegram and LinkedIn go out on time', async () => {
    seedVariantPlan(
      store,
      [
        { id: 's1', at: '09:00', text: 'Утро. Кто первый?' },
        { id: 's2', at: '09:30', text: 'Позже. Кто второй?' },
      ],
      [
        { slot: 's1', platform: 'threads', at: '09:00' },
        { slot: 's1', platform: 'linkedin', at: '09:00' },
        { slot: 's2', platform: 'threads', at: '09:30' },
        { slot: 's2', platform: 'linkedin', at: '09:30' },
      ],
    );
    threads.publishQueue.push('hang', failed('not_sent: ECONNREFUSED'));
    const tg = telegram();
    const th = loop(threads);
    const li = loop(linkedin);

    t = msk('09:00');
    // The Threads iteration never returns: its request hangs.
    let threadsDone = false;
    void th.runOnce().then(() => (threadsDone = true));
    expect((await tg.runOnce()).result).toBe('sent');
    expect(await li.runOnce()).toMatchObject({ variant: 's1-ru', result: 'sent' });
    expect(fake.channel).toHaveLength(1);
    expect(linkedin.posts).toHaveLength(1);

    // Half an hour later Threads still hangs; a second Threads loop (after a restart) fails.
    t = msk('09:30');
    expect(threadsDone).toBe(false);
    expect((await tg.runOnce()).result).toBe('sent');
    expect(await li.runOnce()).toMatchObject({ variant: 's2-ru', result: 'sent' });
    expect(fake.channel).toHaveLength(2);
    expect(linkedin.posts).toHaveLength(2);

    // Each platform's rows are its own: Telegram and LinkedIn are complete and on time.
    const at = (platform: string) =>
      rows(platform)
        .filter((r) => r.status === 'sent')
        .map((r) => r.sentAt);
    expect(at('telegram')).toEqual([msk('09:00').toISOString(), msk('09:30').toISOString()]);
    expect(at('linkedin')).toEqual([msk('09:00').toISOString(), msk('09:30').toISOString()]);
    expect(rows('threads').map((r) => r.status)).toEqual(['intent']);
  });

  it('the three loops run on their own timers and stop cleanly', async () => {
    seedVariantPlan(store, DAY, [...VARIANTS]);
    threads.publishQueue.push('throw');
    t = msk('10:12:09');
    const tg = telegram();
    const th = loop(threads, { intervalMs: 5 });
    const li = loop(linkedin, { intervalMs: 5 });
    tg.start();
    th.start();
    li.start();
    await new Promise((r) => setTimeout(r, 300));
    await Promise.all([tg.stop(), th.stop(), li.stop()]);
    expect(fake.channel).toHaveLength(1);
    expect(linkedin.posts).toHaveLength(1);
    expect(rows('threads').map((r) => r.status)).toEqual(['unknown']);
    expect(threads.calls.filter((c) => c === 'publish')).toHaveLength(1);
  });
});
