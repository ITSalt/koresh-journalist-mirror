import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLinkedInAdapter,
  type LinkedInAdapter,
} from '../../../src/platforms/linkedin/adapter.js';
import {
  createLinkedInClient,
  type LinkedInClientOptions,
} from '../../../src/platforms/linkedin/client.js';
import type { LinkMode } from '../../../src/platforms/linkedin/config.js';
import {
  linkPlan,
  nextLinkMode,
  publishWithLink,
} from '../../../src/platforms/linkedin/link-mode.js';
import type { Outcome, PublishInput } from '../../../src/platforms/types.js';
import { FakeLinkedIn } from './fake-linkedin.js';

const TOKEN = 'fake-linkedin-member-token-MARKER-TOKEN-for-tests-only';
const LINK = 'https://t.me/Channel1/57';

const ok: Outcome<{ id: string }> = { ok: true, result: { id: 'urn:li:comment:(a,1)' } };
const no = (outcome: 'refused' | 'failed' | 'unknown', description: string) =>
  ({ ok: false, outcome, description }) as const;
const forbidden = no('refused', 'comment_forbidden: create comment: HTTP 403 ACCESS_DENIED');

describe('linkPlan', () => {
  it('inline before the probe: the link in the post and one comment attempt', () => {
    expect(linkPlan('inline', false)).toEqual({
      inlineLink: true,
      commentAfter: true,
      probe: true,
    });
  });
  it('inline after the probe: the link in the post, no comment', () => {
    expect(linkPlan('inline', true)).toEqual({
      inlineLink: true,
      commentAfter: false,
      probe: false,
    });
  });
  it('comment: the link only in the first comment, whatever the probe flag says', () => {
    for (const settled of [false, true]) {
      expect(linkPlan('comment', settled)).toEqual({
        inlineLink: false,
        commentAfter: true,
        probe: false,
      });
    }
  });
});

describe('nextLinkMode', () => {
  it('probe accepted: switch to comment, with the alert for the director', () => {
    const d = nextLinkMode(ok);
    expect(d).toMatchObject({ mode: 'comment', settled: true });
    expect(d.alert?.kind).toBe('linkedin_comment_works');
    expect(d.alert?.text).toContain('comment works, switch LINKEDIN_LINK_MODE to comment');
  });

  it('probe refused with 403: stays inline, with the alert', () => {
    const d = nextLinkMode(forbidden);
    expect(d).toMatchObject({ mode: 'inline', settled: true });
    expect(d.alert?.kind).toBe('linkedin_comment_forbidden');
    expect(d.alert?.text).toContain('comment forbidden, staying inline');
  });

  it.each([
    ['rejected', 'rejected: create comment: HTTP 400 MISSING_FIELD message.text'],
    ['token_invalid', 'token_invalid: create comment: HTTP 401 INVALID_ACCESS_TOKEN'],
    ['version_sunset', 'version_sunset: create comment: HTTP 426 NONEXISTENT_VERSION'],
    ['invalid_input', 'invalid_input: the post id is not a post URN'],
    ['forbidden', 'forbidden: create comment: HTTP 403'],
    ['no code', 'something without a code'],
  ])('a refusal that is not comment_forbidden (%s) settles nothing', (code, description) => {
    const probe = nextLinkMode(no('refused', description));
    expect(probe).toMatchObject({ mode: 'inline', settled: false });
    expect(probe.alert?.kind).toBe('linkedin_comment_refused');
    expect(probe.alert?.text).toContain(`(${code}: ${description})`);
    expect(probe.alert?.text).toContain('the probe is not settled');
    const later = nextLinkMode(no('refused', description), 'comment');
    expect(later).toMatchObject({ mode: 'comment', settled: false });
    expect(later.alert?.kind).toBe('linkedin_comment_refused');
    expect(later.alert?.text).toContain('This post has no link');
  });

  it('probe without an answer: stays inline, not settled, an alert each', () => {
    const unknown = nextLinkMode(no('unknown', 'no_answer: create comment: TimeoutError'));
    expect(unknown).toMatchObject({ mode: 'inline', settled: false });
    expect(unknown.alert?.kind).toBe('linkedin_comment_unknown');
    const failed = nextLinkMode(no('failed', 'server_error: create comment: HTTP 500'));
    expect(failed).toMatchObject({ mode: 'inline', settled: false });
    expect(failed.alert?.kind).toBe('linkedin_comment_failed');
  });

  it('comment mode: a comment that worked needs no alert', () => {
    expect(nextLinkMode(ok, 'comment')).toEqual({ mode: 'comment', settled: true, alert: null });
  });

  it('comment mode: a refusal sends the link back into the post', () => {
    const d = nextLinkMode(forbidden, 'comment');
    expect(d).toMatchObject({ mode: 'inline', settled: true });
    expect(d.alert?.text).toContain('Switch LINKEDIN_LINK_MODE back to inline');
  });

  it('comment mode: a passing failure does not flip the mode', () => {
    expect(nextLinkMode(no('failed', 'server_error: x'), 'comment')).toMatchObject({
      mode: 'comment',
      settled: false,
    });
    expect(nextLinkMode(no('unknown', 'no_answer: x'), 'comment')).toMatchObject({
      mode: 'comment',
      settled: false,
    });
  });
});

describe('publishWithLink against the fake LinkedIn', () => {
  let fake: FakeLinkedIn;
  const sleep = async () => undefined;

  beforeEach(async () => {
    fake = await new FakeLinkedIn({ token: TOKEN, clientId: 'id', clientSecret: 'secret' }).start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  const adapter = (
    linkMode: LinkMode,
    over: Partial<LinkedInClientOptions> = {},
  ): LinkedInAdapter =>
    createLinkedInAdapter({
      client: createLinkedInClient({
        token: TOKEN,
        apiBaseUrl: fake.baseUrl,
        timeoutMs: 2000,
        retry: { sleep },
        ...over,
      }),
      authorUrn: fake.personUrn,
      linkMode,
    });

  const input = (over: Partial<PublishInput> = {}): PublishInput => ({
    key: 'linkedin:2026-10-20:s1:0',
    text: 'Первый пост (проба)',
    lang: 'ru',
    link: LINK,
    ...over,
  });

  const firstPost = { probeSettled: false };

  it('first post, LinkedIn accepts the comment: link inline AND in the comment, alert to switch', async () => {
    const r = await publishWithLink(adapter('inline'), input(), firstPost);
    expect(r.post).toMatchObject({ ok: true, result: { id: fake.feed[0]!.urn } });
    expect(fake.feed).toHaveLength(1);
    expect(fake.feed[0]!.text).toBe(`Первый пост (проба)\n\n${LINK}`);
    expect(fake.comments).toEqual([
      expect.objectContaining({ postUrn: fake.feed[0]!.urn, text: LINK }),
    ]);
    expect(r.comment).toMatchObject({ ok: true });
    expect(r.decision).toMatchObject({ mode: 'comment', settled: true });
    expect(r.decision?.alert?.kind).toBe('linkedin_comment_works');
  });

  it('first post, LinkedIn answers 403: the link stays inline, one alert, nothing is repeated', async () => {
    fake.commentsAllowed = false;
    const r = await publishWithLink(adapter('inline'), input(), firstPost);
    // The post is public with the link and is reported exactly as published.
    expect(r.post).toEqual({
      ok: true,
      result: {
        id: fake.feed[0]!.urn,
        url: `https://www.linkedin.com/feed/update/${fake.feed[0]!.urn}/`,
      },
    });
    expect(fake.feed).toHaveLength(1);
    expect(fake.feed[0]!.text.endsWith(`\n\n${LINK}`)).toBe(true);
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.sent('comments')).toHaveLength(1);
    expect(fake.comments).toHaveLength(0);
    expect(r.comment).toMatchObject({ ok: false, outcome: 'refused' });
    expect(r.decision).toMatchObject({ mode: 'inline', settled: true });
    expect(r.decision?.alert?.kind).toBe('linkedin_comment_forbidden');
    expect(r.decision?.alert?.text).toContain('comment forbidden, staying inline');
  });

  it('after the probe, inline: the link in the post and no comment call at all', async () => {
    const r = await publishWithLink(adapter('inline'), input(), { probeSettled: true });
    expect(r).toEqual({ post: expect.objectContaining({ ok: true }) });
    expect(fake.feed[0]!.text.endsWith(LINK)).toBe(true);
    expect(fake.sent('comments')).toHaveLength(0);
  });

  it('comment mode: the post without the link, the link as the first comment', async () => {
    const r = await publishWithLink(adapter('comment'), input(), { probeSettled: true });
    expect(fake.feed[0]!.text).toBe('Первый пост (проба)');
    expect(fake.comments).toEqual([expect.objectContaining({ text: LINK })]);
    expect(r.decision).toEqual({ mode: 'comment', settled: true, alert: null });
  });

  it('comment mode with its own comment text', async () => {
    const commentText = `Оригинал в Telegram: ${LINK}`;
    await publishWithLink(adapter('comment'), input(), { probeSettled: true, commentText });
    expect(fake.comments[0]!.text).toBe(commentText);
  });

  it('comment mode, 403 later on: the post stays, the alert says to go back to inline', async () => {
    fake.commentsAllowed = false;
    const r = await publishWithLink(adapter('comment'), input(), { probeSettled: true });
    expect(r.post.ok).toBe(true);
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.sent('comments')).toHaveLength(1);
    expect(r.decision).toMatchObject({ mode: 'inline', settled: true });
  });

  it('a comment that times out is unknown: tried once, the post untouched and not repeated', async () => {
    fake.queue('comments', { hang: true });
    const r = await publishWithLink(adapter('inline', { timeoutMs: 150 }), input(), firstPost);
    expect(r.post.ok).toBe(true);
    expect(r.comment).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(r.decision).toMatchObject({ mode: 'inline', settled: false });
    expect(r.decision?.alert?.kind).toBe('linkedin_comment_unknown');
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.sent('comments')).toHaveLength(1);
    expect(fake.feed).toHaveLength(1);
  });

  it('a 5xx on the comment is unknown at once: one comment call, the post untouched', async () => {
    fake.queue('comments', { status: 500 });
    const r = await publishWithLink(adapter('inline'), input(), firstPost);
    expect(r.post.ok).toBe(true);
    expect(r.comment).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(r.decision).toMatchObject({ mode: 'inline', settled: false });
    expect(r.decision?.alert?.kind).toBe('linkedin_comment_unknown');
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.sent('comments')).toHaveLength(1);
    expect(fake.feed).toHaveLength(1);
    expect(fake.comments).toHaveLength(0);
  });

  it('a comment throttled to the end (429) fails and never blocks or repeats the post', async () => {
    fake.queue('comments', { status: 429 }, { status: 429 }, { status: 429 }, { status: 429 });
    const r = await publishWithLink(adapter('inline'), input(), firstPost);
    expect(r.post.ok).toBe(true);
    expect(r.comment).toMatchObject({ ok: false, outcome: 'failed' });
    expect(r.decision).toMatchObject({ mode: 'inline', settled: false });
    expect(r.decision?.alert?.kind).toBe('linkedin_comment_failed');
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.feed).toHaveLength(1);
    expect(fake.comments).toHaveLength(0);
  });

  it('a comment refused with 401 does not settle the probe: the question stays open', async () => {
    fake.queue('comments', {
      status: 401,
      body: { status: 401, code: 'INVALID_ACCESS_TOKEN', message: 'Invalid access token' },
    });
    const r = await publishWithLink(adapter('inline'), input(), firstPost);
    expect(r.post.ok).toBe(true);
    expect(r.comment).toMatchObject({ ok: false, outcome: 'refused' });
    expect(r.decision).toMatchObject({ mode: 'inline', settled: false });
    expect(r.decision?.alert?.kind).toBe('linkedin_comment_refused');
    expect(r.decision?.alert?.text).toContain('token_invalid');
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.sent('comments')).toHaveLength(1);
  });

  it('a comment method that throws is unknown and still does not touch the post', async () => {
    const real = adapter('inline');
    const throwing = {
      ...real,
      comment: async () => {
        throw new Error('boom');
      },
    };
    const r = await publishWithLink(throwing, input(), firstPost);
    expect(r.post.ok).toBe(true);
    expect(r.comment).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('posts')).toHaveLength(1);
  });

  it('a post with an unknown outcome gets no comment and is not sent again', async () => {
    fake.queue('posts', { hang: true });
    const r = await publishWithLink(adapter('inline', { timeoutMs: 150 }), input(), firstPost);
    expect(r).toEqual({ post: expect.objectContaining({ ok: false, outcome: 'unknown' }) });
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.sent('comments')).toHaveLength(0);
  });

  it('a refused post gets no comment', async () => {
    const r = await publishWithLink(
      adapter('inline', { token: 'another-fake-token' }),
      input(),
      firstPost,
    );
    expect(r).toEqual({ post: expect.objectContaining({ ok: false, outcome: 'refused' }) });
    expect(fake.sent('comments')).toHaveLength(0);
  });

  it('a post without a link gets no comment', async () => {
    const noLink: PublishInput = { key: 'k', text: 'Без ссылки', lang: 'ru' };
    const r = await publishWithLink(adapter('inline'), noLink, firstPost);
    expect(r).toEqual({ post: expect.objectContaining({ ok: true }) });
    expect(fake.feed[0]!.text).toBe('Без ссылки');
    expect(fake.sent('comments')).toHaveLength(0);
  });
});
