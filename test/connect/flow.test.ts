import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptToken, parseTokenStoreKey } from '../../src/connect/crypto.js';
import { DONE_TEXT, failText } from '../../src/connect/public.js';
import { STATE_TTL_MS } from '../../src/connect/service.js';
import { createThreadsAdapter } from '../../src/platforms/threads/adapter.js';
import { createMemoryStepStore } from '../../src/platforms/threads/step-store.js';
import { BEARER, connectNow, harness, PUBLIC_BASE, STORE_KEY, type Harness } from './helpers.js';

// WP-PLAT-06 acceptance 1, 4, 9 and the mutations of 6 that concern the flow: start -> callback
// with the right state -> token stored encrypted; every wrong state ends on the fixed error page
// with zero calls to the platform and nothing stored; disconnect deletes at once.

const made: Harness[] = [];
async function setup(o: Parameters<typeof harness>[0] = {}) {
  const h = await harness(o);
  made.push(h);
  return h;
}
afterEach(async () => {
  for (const h of made.splice(0).reverse()) await h.close();
});

const overview = async (h: Harness) =>
  (await h.app.inject({ method: 'GET', url: '/v1/connect', headers: BEARER })).json();
const alerts = (h: Harness) => h.store.alerts.list();
const nothingStored = (h: Harness) => {
  expect(h.store.connect.tokens.get('threads')).toBeUndefined();
  expect(h.store.connect.tokens.get('linkedin')).toBeUndefined();
};

describe('POST /v1/connect/<platform>/start', () => {
  it('threads: the authorize link with our id, the two fixed scopes, the redirect and a state', async () => {
    const h = await setup();
    const { url, state, expiresAt } = await h.start('threads');
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://threads.example/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: h.threads.appId,
      redirect_uri: `${PUBLIC_BASE}/oauth/threads/callback`,
      scope: 'threads_basic,threads_content_publish',
      response_type: 'code',
      state,
    });
    expect(url).not.toContain('threads_manage_replies');
    expect(url).not.toContain(h.threads.appSecret);
    // 32 random bytes, base64url.
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(state, 'base64url')).toHaveLength(32);
    expect(expiresAt).toBe(new Date(h.now().getTime() + STATE_TTL_MS).toISOString());
    expect(STATE_TTL_MS).toBe(30 * 60_000);
  });

  it('linkedin: always openid profile w_member_social', async () => {
    const h = await setup();
    const { url, state } = await h.start('linkedin');
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(`${h.linkedin.baseUrl}/oauth/v2/authorization`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      client_id: h.linkedin.clientId,
      redirect_uri: `${PUBLIC_BASE}/oauth/linkedin/callback`,
      state,
      scope: 'openid profile w_member_social',
    });
    expect(url).toContain('scope=openid%20profile%20w_member_social');
    expect(url).not.toContain(h.linkedin.clientSecret);
  });

  it('the scopes are never taken from the request (query or body)', async () => {
    const h = await setup();
    for (const platform of ['threads', 'linkedin']) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/connect/${platform}/start?scope=threads_manage_replies,r_emailaddress&redirect_uri=https://evil.example/`,
        headers: BEARER,
        payload: { scope: 'threads_manage_replies r_emailaddress', scopes: ['email'] },
      });
      expect(res.statusCode).toBe(200);
      const u = new URL(res.json().url);
      expect(u.searchParams.get('scope')).toBe(
        platform === 'threads'
          ? 'threads_basic,threads_content_publish'
          : 'openid profile w_member_social',
      );
      expect(u.searchParams.get('redirect_uri')).toBe(`${PUBLIC_BASE}/oauth/${platform}/callback`);
      expect(res.body).not.toMatch(/threads_manage_replies|r_emailaddress|evil\.example/);
    }
  });

  it('every link has its own state, and the database holds only its SHA-256', async () => {
    const h = await setup();
    const a = await h.start('threads');
    const b = await h.start('threads');
    expect(a.state).not.toBe(b.state);
    const rows = h.store.db
      .prepare('SELECT state_hash, platform, expires_at, used_at FROM oauth_states')
      .all() as { state_hash: string; platform: string; expires_at: string; used_at: null }[];
    expect(rows.map((r) => r.state_hash).sort()).toEqual(
      [a.state, b.state].map((s) => createHash('sha256').update(s).digest('hex')).sort(),
    );
    expect(rows.every((r) => r.platform === 'threads' && r.used_at === null)).toBe(true);
    // Not in the file in any form but the hash.
    h.store.db.pragma('wal_checkpoint(TRUNCATE)');
    const bytes = h.dbBytes();
    expect(bytes).not.toContain(a.state);
    expect(bytes).not.toContain(b.state);
  });

  it('needs the bearer, and 404s an unknown platform', async () => {
    const h = await setup();
    const none = await h.app.inject({ method: 'POST', url: '/v1/connect/threads/start' });
    expect(none.statusCode).toBe(401);
    const other = await h.app.inject({
      method: 'POST',
      url: '/v1/connect/facebook/start',
      headers: BEARER,
    });
    expect(other.statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/v1/connect' })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'DELETE', url: '/v1/connect/threads' })).statusCode).toBe(
      401,
    );
  });

  it.each([
    ['THREADS_APP_ID', 'threads'],
    ['THREADS_APP_SECRET', 'threads'],
    ['LINKEDIN_CLIENT_ID', 'linkedin'],
    ['LINKEDIN_CLIENT_SECRET', 'linkedin'],
    ['TOKEN_STORE_KEY', 'threads'],
    ['PUBLIC_BASE', 'linkedin'],
  ])('without %s the start of %s is 409 and names it', async (name, platform) => {
    const h = await setup({ env: { [name]: '' } });
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/connect/${platform}/start`,
      headers: BEARER,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().missing).toEqual([`${name} is not set`]);
    expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get()).toEqual({ n: 0 });
    const o = (await overview(h))[platform];
    expect(o).toMatchObject({ connected: false, configured: false });
  });

  it('a wrong TOKEN_STORE_KEY or PUBLIC_BASE switches the connect off, not the service', async () => {
    const h = await setup({
      env: { TOKEN_STORE_KEY: 'not-a-key', PUBLIC_BASE: 'http://x.example' },
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/connect/threads/start',
      headers: BEARER,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().missing).toEqual([
      'PUBLIC_BASE must be an https address with a path prefix',
      'TOKEN_STORE_KEY must be base64 of 32 bytes',
    ]);
    expect(res.body).not.toContain('not-a-key');
    expect((await h.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});

describe('the callback, threads', () => {
  it('exchanges the code (short-lived, then long-lived, inside the callback), reads the profile, stores the token encrypted', async () => {
    const h = await setup();
    const { res, token, code, state } = await connectNow(h, 'threads');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(DONE_TEXT);
    // One callback: code -> short-lived -> long-lived -> profile, in that order, nothing else.
    expect(h.threads.ops()).toEqual(['code', 'long', 'me']);
    const [first, second] = h.threads.requests;
    expect(first!.params).toEqual({
      client_id: h.threads.appId,
      client_secret: h.threads.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: `${PUBLIC_BASE}/oauth/threads/callback`,
      code,
    });
    expect(second!.params.grant_type).toBe('th_exchange_token');
    expect(second!.params.access_token).toMatch(/^FAKE-THREADS-SHORT-TOKEN-/);
    expect(token).toMatch(/^FAKE-THREADS-LONG-TOKEN-/);

    // Encrypted at rest: the file holds neither token, and the row decrypts to the long one.
    const bytes = h.dbBytes();
    expect(bytes).not.toContain(token);
    expect(bytes).not.toContain('FAKE-THREADS-SHORT-TOKEN');
    expect(bytes).not.toContain('FAKE-THREADS-LONG-TOKEN');
    expect(bytes).not.toContain(code);
    expect(bytes).not.toContain(state);
    const row = h.store.connect.tokens.get('threads')!;
    expect(row.tokenEnc).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const key = parseTokenStoreKey(STORE_KEY)!;
    expect(decryptToken(key, 'threads', row.tokenEnc)).toBe(token);
    expect(decryptToken(key, 'linkedin', row.tokenEnc)).toBeUndefined();
    expect(h.connect.tokenStore('threads').get()).toBe(token);

    const expiresAt = new Date(h.now().getTime() + h.threads.expiresInS * 1000).toISOString();
    expect((await overview(h)).threads).toEqual({
      connected: true,
      configured: true,
      account: { id: h.threads.userId, name: h.threads.username },
      tokenExpiresAt: expiresAt,
      connectedAt: h.now().toISOString(),
    });
    expect(alerts(h).map((a) => [a.kind, a.message])).toEqual([
      [
        'platform_connected',
        `threads connected: @fake_profile (id ${h.threads.userId}), token expires ${expiresAt} (no expected account is set: confirm it is the right one)`,
      ],
    ]);
    const ready = (await h.app.inject({ method: 'GET', url: '/ready' })).json();
    expect(ready.components.connect).toEqual({
      ok: true,
      required: false,
      threads: { connected: true, configured: true, tokenExpiresAt: expiresAt },
      linkedin: { connected: false, configured: true },
    });
  });

  it('a second use of the same state: fixed error page, zero calls, nothing changes', async () => {
    const h = await setup();
    const first = await connectNow(h, 'threads');
    const before = h.store.connect.tokens.get('threads');
    const calls = h.threads.requests.length;
    const again = await h.callback('threads', { code: h.threads.issueCode(), state: first.state });
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain(failText('link_used'));
    expect(h.threads.requests).toHaveLength(calls);
    expect(h.store.connect.tokens.get('threads')).toEqual(before);
    expect(alerts(h)).toHaveLength(1);
  });

  it('an unknown state, a malformed one, none at all: error page, zero calls, nothing stored', async () => {
    const h = await setup();
    await h.start('threads');
    const code = h.threads.issueCode();
    const unknown = Buffer.alloc(32, 1).toString('base64url');
    for (const query of [{ code, state: unknown }, { code, state: 'short' }, { code }]) {
      const res = await h.callback('threads', query as Record<string, string>);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(failText('link_unknown'));
    }
    expect(h.threads.requests).toHaveLength(0);
    nothingStored(h);
    expect(alerts(h)).toEqual([]);
    // The link that was handed out is still good.
    expect(
      h.store.db.prepare('SELECT COUNT(*) AS n FROM oauth_states WHERE used_at IS NULL').get(),
    ).toEqual({ n: 1 });
  });

  it('an expired state (30 minutes): error page, zero calls, nothing stored', async () => {
    const h = await setup();
    const { state } = await h.start('threads');
    h.advance(STATE_TTL_MS);
    const res = await h.callback('threads', { code: h.threads.issueCode(), state });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(failText('link_expired'));
    expect(h.threads.requests).toHaveLength(0);
    nothingStored(h);
  });

  it('one millisecond before the end the state is still good', async () => {
    const h = await setup();
    const { state } = await h.start('threads');
    h.advance(STATE_TTL_MS - 1);
    const res = await h.callback('threads', { code: h.threads.issueCode(), state });
    expect(res.statusCode).toBe(200);
  });

  it('a state of the other platform: error page, zero calls on both, nothing stored, and it is used up', async () => {
    const h = await setup();
    const { state } = await h.start('linkedin');
    const res = await h.callback('threads', { code: h.threads.issueCode(), state });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(failText('link_wrong_platform'));
    expect(h.threads.requests).toHaveLength(0);
    expect(h.linkedin.requests).toHaveLength(0);
    nothingStored(h);
    const own = await h.callback('linkedin', { code: h.linkedin.issueCode(), state });
    expect(own.body).toContain(failText('link_used'));
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it('two callbacks with one state at the same moment: one connects, one is refused', async () => {
    const h = await setup();
    const { state } = await h.start('threads');
    const [a, b] = await Promise.all([
      h.callback('threads', { code: h.threads.issueCode(), state }),
      h.callback('threads', { code: h.threads.issueCode(), state }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    expect(h.threads.sent('code')).toHaveLength(1);
  });

  it.each([
    ['a 500 on the code exchange', 'code', { status: 500 }, 'exchange_failed', ['code']],
    ['a refusal of the code', 'code', { echo: 400 }, 'exchange_failed', ['code']],
    [
      'no answer to the code exchange (timeout)',
      'code',
      { hang: true },
      'platform_unreachable',
      ['code'],
    ],
    [
      'a dropped connection on the long-lived exchange',
      'long',
      { drop: true },
      'platform_unreachable',
      ['code', 'long'],
    ],
    [
      'a 503 on the long-lived exchange',
      'long',
      { status: 503 },
      'exchange_failed',
      ['code', 'long'],
    ],
    [
      'a profile that cannot be read',
      'me',
      { status: 400, body: { error: { message: 'no', code: 10 } } },
      'account_unreadable',
      ['code', 'long', 'me'],
    ],
  ] as const)(
    '%s: fixed error page, nothing stored, the state is consumed',
    async (_name, op, reply, reason, ops) => {
      const h = await setup();
      const { state } = await h.start('threads');
      h.threads.queue(op, reply);
      const res = await h.callback('threads', { code: h.threads.issueCode(), state });
      expect(res.statusCode).toBe(502);
      expect(res.body).toContain(failText(reason));
      // No call is repeated: a code is single use.
      expect(h.threads.ops()).toEqual(ops);
      nothingStored(h);
      expect(alerts(h).map((a) => a.kind)).toEqual(['platform_connect_failed']);
      expect((await overview(h)).threads).toMatchObject({ connected: false });
      expect((await overview(h)).threads.lastError).toContain(reason);
      // The owner asks for a new link: the old state is used up.
      const calls = h.threads.requests.length;
      const again = await h.callback('threads', { code: h.threads.issueCode(), state });
      expect(again.body).toContain(failText('link_used'));
      expect(h.threads.requests).toHaveLength(calls);
      // And a new link works.
      expect((await connectNow(h, 'threads')).res.statusCode).toBe(200);
      expect((await overview(h)).threads.lastError).toBeUndefined();
    },
  );

  it('the owner pressed Cancel: error page, zero calls, nothing stored, an alert', async () => {
    const h = await setup();
    const { state } = await h.start('threads');
    const res = await h.callback('threads', {
      error: 'access_denied',
      error_reason: 'user_denied',
      error_description: 'The user denied your request',
      state,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(failText('denied'));
    expect(res.body).not.toContain('user denied');
    expect(h.threads.requests).toHaveLength(0);
    nothingStored(h);
    expect(alerts(h).map((a) => a.message)).toEqual([
      'threads connect failed: denied: the platform sent access_denied instead of a code',
    ]);
  });

  it('an error redirect without a state we issued does nothing at all', async () => {
    const h = await setup();
    const res = await h.callback('threads', { error: 'access_denied' });
    expect(res.body).toContain(failText('link_unknown'));
    expect(alerts(h)).toEqual([]);
  });

  it('without the app secret the callback shows the fixed error page and calls nobody', async () => {
    const h = await setup({ env: { THREADS_APP_SECRET: '' } });
    const res = await h.callback('threads', {
      code: h.threads.issueCode(),
      state: Buffer.alloc(32, 2).toString('base64url'),
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain(failText('not_configured'));
    expect(h.threads.requests).toHaveLength(0);
  });
});

describe('the expected account', () => {
  it('threads: another account is refused, nothing stored, an alert', async () => {
    const h = await setup({ env: { THREADS_EXPECTED_USERNAME: '@owner_profile' } });
    const { res, token } = await connectNow(h, 'threads');
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain(failText('wrong_account'));
    nothingStored(h);
    expect(h.dbBytes()).not.toContain(token);
    expect(alerts(h).map((a) => [a.kind, a.message])).toEqual([
      [
        'platform_connect_failed',
        `threads connect failed: wrong_account: @fake_profile (id ${h.threads.userId}) is not the expected account, nothing was stored`,
      ],
    ]);
    expect((await overview(h)).threads).toMatchObject({ connected: false });
  });

  it('threads: the expected account connects (case and the @ do not matter)', async () => {
    const h = await setup({ env: { THREADS_EXPECTED_USERNAME: '@Fake_Profile' } });
    const { res } = await connectNow(h, 'threads');
    expect(res.statusCode).toBe(200);
    expect(alerts(h)[0]!.message).not.toContain('confirm it is the right one');
  });

  it('linkedin: another member is refused, the expected one connects', async () => {
    const wrong = await setup({ env: { LINKEDIN_EXPECTED_SUB: 'someone-else' } });
    const a = await connectNow(wrong, 'linkedin');
    expect(a.res.statusCode).toBe(403);
    nothingStored(wrong);
    expect(wrong.dbBytes()).not.toContain(a.token);
    expect(alerts(wrong).map((x) => x.kind)).toEqual(['platform_connect_failed']);

    const right = await setup({ env: { LINKEDIN_EXPECTED_SUB: '782bbtaQ' } });
    expect((await connectNow(right, 'linkedin')).res.statusCode).toBe(200);
  });
});

describe('the callback, linkedin', () => {
  it('exchanges the code for the 60-day token, reads userinfo, stores the token encrypted', async () => {
    const h = await setup();
    const { res, token, code } = await connectNow(h, 'linkedin');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(DONE_TEXT);
    expect(h.linkedin.ops()).toEqual(['token', 'userinfo']);
    expect(h.linkedin.requests[0]!.params).toEqual({
      grant_type: 'authorization_code',
      code,
      client_id: h.linkedin.clientId,
      client_secret: h.linkedin.clientSecret,
      redirect_uri: `${PUBLIC_BASE}/oauth/linkedin/callback`,
    });
    expect(h.linkedin.requests[1]!.authorization).toBe(`Bearer ${token}`);
    const bytes = h.dbBytes();
    expect(bytes).not.toContain(token);
    expect(bytes).not.toContain('FAKE-LINKEDIN-ACCESS-TOKEN');
    expect(bytes).not.toContain('FAKE-LINKEDIN-ID-TOKEN');
    expect(h.connect.tokenStore('linkedin').get()).toBe(token);
    const expiresAt = new Date(h.now().getTime() + 5184000 * 1000).toISOString();
    expect((await overview(h)).linkedin).toEqual({
      connected: true,
      configured: true,
      account: { id: '782bbtaQ', name: 'John Doe' },
      tokenExpiresAt: expiresAt,
      connectedAt: h.now().toISOString(),
      reminder: 'none',
    });
    expect(alerts(h).map((a) => a.kind)).toEqual(['platform_connected']);
    // Threads is untouched.
    expect(h.threads.requests).toHaveLength(0);
    expect((await overview(h)).threads).toEqual({ connected: false, configured: true });
  });

  it.each([
    ['a 500 on the token exchange', 'token', { status: 500 }, 'exchange_failed'],
    ['a refused code', 'token', { echo: 401 }, 'exchange_failed'],
    ['no answer (timeout)', 'token', { hang: true }, 'platform_unreachable'],
    [
      'userinfo refused',
      'userinfo',
      { status: 403, body: { message: 'no' } },
      'account_unreadable',
    ],
  ] as const)('%s: error page, nothing stored, state consumed', async (_n, op, reply, reason) => {
    const h = await setup();
    const { state } = await h.start('linkedin');
    h.linkedin.queue(op, reply);
    const res = await h.callback('linkedin', { code: h.linkedin.issueCode(), state });
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain(failText(reason));
    expect(h.linkedin.sent('token')).toHaveLength(1);
    nothingStored(h);
    const again = await h.callback('linkedin', { code: h.linkedin.issueCode(), state });
    expect(again.body).toContain(failText('link_used'));
  });

  it('a second connect replaces the first token', async () => {
    const h = await setup();
    const first = await connectNow(h, 'linkedin');
    h.advance(86_400_000);
    const second = await connectNow(h, 'linkedin');
    expect(second.token).not.toBe(first.token);
    expect(h.connect.tokenStore('linkedin').get()).toBe(second.token);
    expect(h.dbBytes()).not.toContain(first.token);
  });
});

describe('DELETE /v1/connect/<platform>', () => {
  it('deletes the token and the account at once; the adapter is not ok; a second DELETE is 200', async () => {
    const h = await setup();
    const { token } = await connectNow(h, 'threads');
    await connectNow(h, 'linkedin');
    const ciphertext = h.store.connect.tokens.get('threads')!.tokenEnc;
    const pending = await h.start('threads');
    const adapter = createThreadsAdapter({
      tokens: h.connect.tokenStore('threads'),
      steps: createMemoryStepStore(),
      baseUrl: h.threads.baseUrl,
      now: h.now,
    });
    expect((await adapter.health()).detail).toContain('profile ok (@fake_profile)');

    const res = await h.app.inject({
      method: 'DELETE',
      url: '/v1/connect/threads',
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ platform: 'threads', disconnected: true });

    // Nothing of the token is left in the file: not the token, not even its ciphertext.
    const bytes = h.dbBytes();
    expect(bytes).not.toContain(token);
    expect(bytes).not.toContain(ciphertext);
    expect(
      h.store.db
        .prepare("SELECT COUNT(*) AS n FROM platform_tokens WHERE platform = 'threads'")
        .get(),
    ).toEqual({ n: 0 });
    expect((await overview(h)).threads).toEqual({ connected: false, configured: true });
    expect((await overview(h)).linkedin).toMatchObject({ connected: true });

    // The adapter has no token: not ok, and it sends nothing with a token to the platform.
    const calls = h.threads.requests.length;
    const health = await adapter.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('token_invalid');
    expect(h.threads.requests).toHaveLength(calls);
    expect(h.connect.tokenStore('threads').get()).toBe('');

    // A link handed out before the disconnect connects nothing.
    const late = await h.callback('threads', { code: h.threads.issueCode(), state: pending.state });
    expect(late.body).toContain(failText('link_unknown'));
    expect(h.store.connect.tokens.get('threads')).toBeUndefined();

    const kinds = () => alerts(h).map((a) => a.kind);
    expect(kinds()).toEqual(['platform_connected', 'platform_connected', 'platform_disconnected']);
    expect(alerts(h)[2]!.message).toBe(
      `threads disconnected: the stored token and the account record of fake_profile (id ${h.threads.userId}) were deleted`,
    );

    const again = await h.app.inject({
      method: 'DELETE',
      url: '/v1/connect/threads',
      headers: BEARER,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ platform: 'threads', disconnected: false });
    expect(kinds()).toHaveLength(3);
  });

  it('is 200 when nothing was ever stored, 404 for an unknown platform', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/v1/connect/linkedin',
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ platform: 'linkedin', disconnected: false });
    expect(alerts(h)).toEqual([]);
    const other = await h.app.inject({ method: 'DELETE', url: '/v1/connect/x', headers: BEARER });
    expect(other.statusCode).toBe(404);
  });

  it('a refresh that ends after the disconnect cannot bring the token back', async () => {
    const h = await setup();
    await connectNow(h, 'threads');
    const seam = h.connect.tokenStore('threads');
    h.connect.disconnect('threads');
    expect(() => seam.set('FAKE-LATE-TOKEN', h.now().toISOString())).toThrow(/not connected/);
    expect(h.store.connect.tokens.get('threads')).toBeUndefined();
    expect(h.dbBytes()).not.toContain('FAKE-LATE-TOKEN');
  });
});

describe('GET /v1/connect', () => {
  it('a token stored under another key reads as not connected, with a reason and no token', async () => {
    const h = await setup();
    const { token } = await connectNow(h, 'threads');
    const other = await h.reopen();
    made.push(other);
    expect((await overview(other)).threads).toMatchObject({ connected: true });
    const rekeyed = await harness({
      env: { TOKEN_STORE_KEY: Buffer.alloc(32, 9).toString('base64') },
      from: {
        dbFile: other.dbFile,
        threads: other.threads,
        linkedin: other.linkedin,
        at: other.now(),
      },
    });
    made.push(rekeyed);
    const o = (await overview(rekeyed)).threads;
    expect(o.connected).toBe(false);
    expect(o.lastError).toContain('token_unreadable');
    expect(rekeyed.connect.tokenStore('threads').get()).toBe('');
    expect(JSON.stringify(o)).not.toContain(token);
  });
});
