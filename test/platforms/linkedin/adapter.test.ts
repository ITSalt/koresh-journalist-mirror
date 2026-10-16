import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  composeCommentary,
  composePlainText,
  createLinkedInAdapter,
  type LinkedInAdapterOptions,
} from '../../../src/platforms/linkedin/adapter.js';
import {
  createLinkedInClient,
  errorCodeOf,
  type LinkedInClientOptions,
} from '../../../src/platforms/linkedin/client.js';
import { expiryReminder } from '../../../src/platforms/linkedin/expiry.js';
import type { PlatformAdapter, PublishInput } from '../../../src/platforms/types.js';
import { FakeLinkedIn } from './fake-linkedin.js';

const TOKEN = 'fake-linkedin-member-token-MARKER-TOKEN-for-tests-only';
const CLIENT_ID = 'fake-client-id-77abc';
const CLIENT_SECRET = 'fake-client-secret-MARKER-SECRET-for-tests-only';
const LINK = 'https://t.me/Channel1/57';
const DAY = 86_400_000;

let fake: FakeLinkedIn;
const sleep = async () => undefined;

beforeEach(async () => {
  fake = await new FakeLinkedIn({
    token: TOKEN,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  }).start();
});
afterEach(async () => {
  await fake.stop();
});

const adapter = (
  over: Partial<LinkedInAdapterOptions> = {},
  clientOver: Partial<LinkedInClientOptions> = {},
) =>
  createLinkedInAdapter({
    client: createLinkedInClient({
      token: TOKEN,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      apiBaseUrl: fake.baseUrl,
      oauthBaseUrl: fake.baseUrl,
      timeoutMs: 2000,
      retry: { sleep },
      ...clientOver,
    }),
    ...over,
  });

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  key: 'linkedin:2026-10-20:s1:0',
  text: 'Новости от Корпорации всевластия (выпуск #3)\n\nТекст [поста] про ИИ_менеджера.',
  lang: 'ru',
  link: LINK,
  ...over,
});

describe('the adapter contract', () => {
  it('is a PlatformAdapter for linkedin with a comment method', () => {
    const a: PlatformAdapter = adapter();
    expect(a.platform).toBe('linkedin');
    expect(typeof a.comment).toBe('function');
    expect(adapter().linkMode).toBe('inline');
    expect(adapter().textLimit).toBe(3000);
  });
});

describe('composing the post', () => {
  it('inline: the link is the last line after an empty line', () => {
    expect(composePlainText(input({ text: 'Текст \n\n' }), 'inline')).toBe(`Текст\n\n${LINK}`);
    expect(
      composePlainText(input({ text: 'Текст' }), 'inline')
        .split('\n')
        .at(-1),
    ).toBe(LINK);
  });

  it('comment mode and a post without a link: the text alone', () => {
    expect(composePlainText(input({ text: 'Текст' }), 'comment')).toBe('Текст');
    const noLink: PublishInput = { key: 'k', text: 'Текст', lang: 'ru' };
    expect(composePlainText(noLink, 'inline')).toBe('Текст');
  });

  it('the commentary is the composed text, escaped', () => {
    expect(
      composeCommentary(input({ text: 'a (b) #c', link: 'https://e.com/x_y' }), 'inline'),
    ).toBe('a \\(b\\) \\#c\n\nhttps://e.com/x\\_y');
  });
});

describe('validate', () => {
  it('accepts a normal post and makes no request', () => {
    expect(adapter().validate(input())).toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses an empty text', () => {
    expect(adapter().validate(input({ text: ' \n ' }))).toEqual([
      expect.objectContaining({ code: 'empty_text' }),
    ]);
  });

  it('counts the length after escaping', () => {
    // 2990 characters as written, 3010 once the twenty brackets are escaped.
    const text = 'я'.repeat(2970) + '('.repeat(20);
    const a = adapter({ linkMode: 'comment' });
    expect(text.length).toBe(2990);
    expect(a.validate(input({ text }))).toEqual([
      expect.objectContaining({
        code: 'too_long',
        message: 'the escaped text is 3010 characters, the limit is 3000',
      }),
    ]);
    expect(a.validate(input({ text: 'я'.repeat(2980) + '('.repeat(10) }))).toEqual([]);
    expect(a.validate(input({ text: 'я'.repeat(2981) + '('.repeat(10) }))).toHaveLength(1);
  });

  it('counts the inline link and its empty line, and not in comment mode', () => {
    const text = 'я'.repeat(3000 - LINK.length - 2);
    expect(adapter().validate(input({ text }))).toEqual([]);
    expect(adapter().validate(input({ text: `${text}я` }))).toEqual([
      expect.objectContaining({ code: 'too_long' }),
    ]);
    expect(adapter({ linkMode: 'comment' }).validate(input({ text: `${text}я` }))).toEqual([]);
  });

  it('takes the limit from the settings', () => {
    const a = adapter({ textLimit: 10, linkMode: 'comment' });
    expect(a.validate(input({ text: '1234567890' }))).toEqual([]);
    expect(a.validate(input({ text: '123456789(' }))).toHaveLength(1);
  });

  it('refuses a link that is not one http(s) address', () => {
    for (const link of ['t.me/Channel1/57', 'https://a.b c', 'javascript:alert(1)', '', '  ']) {
      expect(adapter().validate(input({ link }))).toEqual([
        expect.objectContaining({ code: 'bad_link' }),
      ]);
    }
  });
});

describe('publish', () => {
  it('makes one public post as the member and returns the URN and the public URL', async () => {
    const r = await adapter().publish(input());
    const post = fake.feed[0]!;
    expect(r).toEqual({
      ok: true,
      result: { id: post.urn, url: `https://www.linkedin.com/feed/update/${post.urn}/` },
    });
    expect(fake.feed).toHaveLength(1);
    expect(post.author).toBe('urn:li:person:782bbtaQ');
    // What LinkedIn received, character for character.
    expect(post.commentary).toBe(
      'Новости от Корпорации всевластия \\(выпуск \\#3\\)\n\n' +
        'Текст \\[поста\\] про ИИ\\_менеджера.\n\n' +
        'https://t.me/Channel1/57',
    );
    // What a reader sees: the text as written, the link as the last line.
    expect(post.text).toBe(`${input().text}\n\n${LINK}`);
    expect(post.unescapedReserved).toEqual([]);
    const req = fake.sent('posts')[0]!;
    expect(req.headers['linkedin-version']).toBe('202609');
    expect(req.headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(req.body).toEqual({
      author: 'urn:li:person:782bbtaQ',
      commentary: post.commentary,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });

  it('in comment mode the post goes out without the link', async () => {
    await adapter({ linkMode: 'comment' }).publish(input({ text: 'Текст' }));
    expect(fake.feed[0]!.text).toBe('Текст');
  });

  it('asks userinfo for the author once and keeps it', async () => {
    const a = adapter();
    await a.publish(input({ text: 'первый' }));
    await a.publish(input({ text: 'второй' }));
    expect(fake.sent('userinfo')).toHaveLength(1);
    expect(fake.feed).toHaveLength(2);
  });

  it('uses the configured author without asking userinfo', async () => {
    const r = await adapter({ authorUrn: fake.personUrn }).publish(input());
    expect(r.ok).toBe(true);
    expect(fake.sent('userinfo')).toHaveLength(0);
  });

  it('refuses invalid input before any request', async () => {
    const r = await adapter().publish(input({ text: '' }));
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(errorCodeOf(r)).toBe('invalid_input');
    expect(fake.requests).toHaveLength(0);
  });

  it('a timeout of the create is unknown; the post is not sent a second time', async () => {
    fake.queue('posts', { hang: true });
    const a = adapter({ authorUrn: fake.personUrn }, { timeoutMs: 150 });
    const r = await a.publish(input());
    expect(r).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.sent('posts')).toHaveLength(1);
    expect(fake.feed).toHaveLength(1);
  });

  it('a dead token stops at userinfo as token_invalid: no post is tried', async () => {
    const r = await adapter({}, { token: 'another-fake-token' }).publish(input());
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(errorCodeOf(r)).toBe('token_invalid');
    expect(fake.sent('posts')).toHaveLength(0);
  });

  it('401 on the create is token_invalid', async () => {
    const a = adapter({ authorUrn: fake.personUrn }, { token: 'another-fake-token' });
    expect(errorCodeOf(await a.publish(input()))).toBe('token_invalid');
    expect(fake.feed).toHaveLength(0);
  });

  it('a failed userinfo is not remembered: the next publish asks again', async () => {
    fake.queue('userinfo', { status: 401, body: { status: 401, message: 'Invalid access token' } });
    const a = adapter();
    expect((await a.publish(input())).ok).toBe(false);
    expect((await a.publish(input())).ok).toBe(true);
    expect(fake.sent('userinfo')).toHaveLength(2);
    expect(fake.feed).toHaveLength(1);
  });

  it('a sunset version is refused as version_sunset', async () => {
    fake.activeVersions = new Set(['202701']);
    const r = await adapter({ authorUrn: fake.personUrn }).publish(input());
    expect(errorCodeOf(r)).toBe('version_sunset');
    expect(fake.feed).toHaveLength(0);
  });
});

describe('comment', () => {
  it('201: one comment by the member under the post', async () => {
    const a = adapter();
    const post = await a.publish(input());
    if (!post.ok) throw new Error('setup');
    const r = await a.comment(post.result.id, ` ${LINK} `, 'linkedin:2026-10-20:s1:1');
    expect(r).toEqual({ ok: true, result: { id: fake.comments[0]!.commentUrn } });
    expect(fake.comments[0]).toMatchObject({
      postUrn: post.result.id,
      actor: fake.personUrn,
      text: LINK,
    });
    expect(fake.feed).toHaveLength(1);
  });

  it('403: refused as comment_forbidden', async () => {
    const a = adapter();
    const post = await a.publish(input());
    if (!post.ok) throw new Error('setup');
    fake.commentsAllowed = false;
    const r = await a.comment(post.result.id, LINK);
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(errorCodeOf(r)).toBe('comment_forbidden');
    expect(fake.sent('comments')).toHaveLength(1);
  });

  it('refuses a post id that is not a post URN, and an empty text, before any request', async () => {
    const a = adapter({ authorUrn: fake.personUrn });
    for (const id of ['', '123', 'urn:li:share:1/../../posts', 'urn:li:person:782bbtaQ']) {
      expect(errorCodeOf(await a.comment(id, LINK))).toBe('invalid_input');
    }
    expect(errorCodeOf(await a.comment('urn:li:share:1', '  '))).toBe('invalid_input');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('health', () => {
  const expiresAt = new Date('2026-12-11T09:00:00.000Z');
  const at = (daysBefore: number) => () => new Date(expiresAt.getTime() - daysBefore * DAY);

  it('introspection gives the expiry, and the reminder states at 8, 7, 1 and 0 days', async () => {
    const states: string[] = [];
    for (const days of [8, 7, 1, 0]) {
      const now = at(days);
      const h = await adapter({ now }).health();
      expect(h.tokenExpiresAt).toBe('2026-12-11T09:00:00.000Z');
      expect(h.ok).toBe(days > 0);
      const state = expiryReminder(now(), h.tokenExpiresAt!);
      expect(h.detail).toContain(`reminder: ${state}`);
      states.push(state);
    }
    expect(states).toEqual(['none', 'in_7_days', 'in_1_day', 'expired']);
  });

  it('a token LinkedIn calls expired or revoked is not healthy', async () => {
    fake.tokenStatus = 'expired';
    expect(await adapter({ now: at(-1) }).health()).toEqual({
      ok: false,
      detail: 'token not active (expired)',
      tokenExpiresAt: '2026-12-11T09:00:00.000Z',
    });
    fake.tokenStatus = 'revoked';
    expect(await adapter({ now: at(30) }).health()).toMatchObject({
      ok: false,
      detail: 'token not active (revoked)',
    });
  });

  it('a failed introspection is not healthy and says why without secrets', async () => {
    const h = await adapter({}, { clientSecret: 'wrong-fake-secret' }).health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('introspect: HTTP 401');
    expect(h.tokenExpiresAt).toBeUndefined();
    expect(JSON.stringify(h)).not.toContain('wrong-fake-secret');
  });

  it('without the app credentials it says what is missing', async () => {
    const a = createLinkedInAdapter({
      client: createLinkedInClient({ token: TOKEN, oauthBaseUrl: fake.baseUrl }),
    });
    expect(await a.health()).toEqual({
      ok: false,
      detail:
        'not_configured: introspect: LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET are needed',
    });
  });

  it('an active token without a reported expiry is healthy, with no date', async () => {
    fake.queue('introspect', { status: 200, body: { active: true, status: 'active' } });
    expect(await adapter().health()).toEqual({
      ok: true,
      detail: 'token active, expiry not reported',
    });
  });
});
