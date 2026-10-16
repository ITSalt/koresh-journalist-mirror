import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { openStore } from '../src/store/index.js';

describe('GET /health', () => {
  it('returns ok with version and uptime', async () => {
    const app = buildServer({ config: loadConfig({}), version: 'abc123', logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('abc123');
    expect(typeof body.uptimeS).toBe('number');
  });
});

describe('GET /ready', () => {
  it('returns 503 with component map when TELEGRAM_BOT_TOKEN is missing', async () => {
    const app = buildServer({ config: loadConfig({}), logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.components.telegram).toMatchObject({ ok: false, required: true });
  });

  it('returns 200 when required components are configured', async () => {
    const app = buildServer({
      config: loadConfig({ TELEGRAM_BOT_TOKEN: 'fake-telegram-token-value' }),
      store: openStore(':memory:'),
      logLevel: 'silent',
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /ready telegram component (D-16, D-17)', () => {
  it('reports linked_chat_id presence from the channel probe', async () => {
    const app = buildServer({
      config: loadConfig({ TELEGRAM_BOT_TOKEN: 'fake-telegram-token-value', DRY_RUN: 'false' }),
      store: openStore(':memory:'),
      logLevel: 'silent',
      channelProbe: () => ({
        checkedAt: '2026-10-11T06:00:00.000Z',
        ok: true,
        linkedChatId: 'present',
        detail: 'getChat ok: type=channel, linked_chat_id present',
      }),
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.json().components.telegram).toEqual({
      ok: true,
      required: true,
      dryRun: false,
      linkedChatId: 'present',
      detail: 'getChat ok: type=channel, linked_chat_id present',
    });
  });

  it('says getChat is not checked in DRY_RUN', async () => {
    const app = buildServer({
      config: loadConfig({ TELEGRAM_BOT_TOKEN: 'fake-telegram-token-value' }),
      logLevel: 'silent',
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.json().components.telegram.detail).toBe('getChat not checked (DRY_RUN)');
    expect(res.json().components.telegram.dryRun).toBe(true);
  });
});

describe('GET /ready db component', () => {
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: 'fake-telegram-token-value' });

  it('reports db ok when the store answers', async () => {
    const app = buildServer({ config, store: openStore(':memory:'), logLevel: 'silent' });
    const body = (await app.inject({ method: 'GET', url: '/ready' })).json();
    expect(body.components.db).toMatchObject({ ok: true, required: true });
  });

  it('is 503 when the store is missing', async () => {
    const app = buildServer({ config, logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().components.db).toMatchObject({ ok: false, required: true });
  });

  it('is 503 when the store is closed', async () => {
    const store = openStore(':memory:');
    store.close();
    const app = buildServer({ config, store, logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().components.db.ok).toBe(false);
  });
});

const secrets = {
  TELEGRAM_BOT_TOKEN: 'FAKE-TG-SECRET-aaaa1111',
  OPENROUTER_API_KEY: 'FAKE-OR-SECRET-bbbb2222',
  JOURNALIST_API_TOKEN: 'FAKE-API-SECRET-cccc3333',
};

function capture() {
  const lines: string[] = [];
  const logStream = { write: (l: string) => void lines.push(l) };
  const app = buildServer({ config: loadConfig(secrets), logStream });
  return { app, out: () => lines.join('') };
}

function expectNoSecrets(out: string) {
  expect(out.length).toBeGreaterThan(0);
  for (const v of Object.values(secrets)) expect(out).not.toContain(v);
}

describe('log redaction (production logger config)', () => {
  it('redacts secret config keys logged as fields', async () => {
    const { app, out } = capture();
    app.log.info({ TELEGRAM_BOT_TOKEN: secrets.TELEGRAM_BOT_TOKEN, cfg: secrets }, 'config');
    await app.close();
    expectNoSecrets(out());
    expect(out()).toContain('[REDACTED]');
  });

  it('redacts the authorization header in logged request headers', async () => {
    const { app, out } = capture();
    await app.inject({
      method: 'GET',
      url: '/ready',
      headers: { authorization: `Bearer ${secrets.JOURNALIST_API_TOKEN}` },
    });
    await app.close();
    const o = out();
    expect(o).toContain('"headers"'); // request headers really are logged
    expectNoSecrets(o);
    expect(o).toContain('"authorization":"[REDACTED]"');
  });

  it('scrubs a token inside err.message (Telegram URL)', async () => {
    const { app, out } = capture();
    const err = new Error(
      `fetch failed: https://api.telegram.org/bot${secrets.TELEGRAM_BOT_TOKEN}/sendMessage`,
    );
    app.log.error({ err }, 'telegram call failed');
    await app.close();
    expectNoSecrets(out());
    expect(out()).toContain('api.telegram.org/bot[REDACTED]/sendMessage');
  });

  it('scrubs a token inside a query string in req.url', async () => {
    const { app, out } = capture();
    await app.inject({ method: 'GET', url: `/health?token=${secrets.OPENROUTER_API_KEY}` });
    await app.close();
    expectNoSecrets(out());
    expect(out()).toContain('/health?token=[REDACTED]');
  });
});
