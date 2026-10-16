import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('OWNER_CHAT_ID: optional positive integer; empty is unset; independent of TEST_CHANNEL', () => {
    expect(loadConfig({}).OWNER_CHAT_ID).toBeUndefined();
    expect(loadConfig({ OWNER_CHAT_ID: '' }).OWNER_CHAT_ID).toBeUndefined();
    expect(loadConfig({ OWNER_CHAT_ID: '123456789' }).OWNER_CHAT_ID).toBe(123456789);
    for (const bad of ['-1001', '0', 'abc', '1.5']) {
      expect(() => loadConfig({ OWNER_CHAT_ID: bad })).toThrow(/OWNER_CHAT_ID/);
    }
    expect(loadConfig({ TEST_CHANNEL: '123' }).OWNER_CHAT_ID).toBeUndefined();
  });

  it('applies defaults with empty env', () => {
    const c = loadConfig({});
    expect(c.PORT).toBe(8080);
    expect(c.HOST).toBe('127.0.0.1');
    expect(c.TZ_PLAN).toBe('Europe/Moscow');
    expect(c.TELEGRAM_CHANNEL).toBe('@Channel1');
    expect(c.DRY_RUN).toBe(true);
    expect(c.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('parses overrides and treats empty as unset', () => {
    const c = loadConfig({ PORT: '9000', DRY_RUN: 'false', OPENROUTER_API_KEY: '' });
    expect(c.PORT).toBe(9000);
    expect(c.DRY_RUN).toBe(false);
    expect(c.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('has LLM defaults: estimate 0.10, OpenRouter base URL, no bake-off models', () => {
    const c = loadConfig({});
    expect(c.LLM_ESTIMATE_USD).toBe(0.1);
    expect(c.OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1');
    expect(c.BAKEOFF_MODELS).toEqual([]);
    expect(c.LLM_DAILY_CAP_USD).toBeUndefined();
  });

  it('parses LLM settings and the bake-off model list', () => {
    const c = loadConfig({
      LLM_ESTIMATE_USD: '0.25',
      LLM_DAILY_CAP_USD: '1',
      BAKEOFF_MODELS: ' a/one , b/two,,c/three ',
    });
    expect(c.LLM_ESTIMATE_USD).toBe(0.25);
    expect(c.LLM_DAILY_CAP_USD).toBe(1);
    expect(c.BAKEOFF_MODELS).toEqual(['a/one', 'b/two', 'c/three']);
    expect(() => loadConfig({ LLM_ESTIMATE_USD: '-1' })).toThrow();
    expect(() => loadConfig({ OPENROUTER_BASE_URL: 'not a url' })).toThrow();
  });

  it('L-1: refuses LLM_ESTIMATE_USD=0 (with no usage.cost the cap would never trip)', () => {
    expect(() => loadConfig({ LLM_ESTIMATE_USD: '0' })).toThrow(/LLM_ESTIMATE_USD/);
    expect(() => loadConfig({ LLM_ESTIMATE_USD: '0.0' })).toThrow(/LLM_ESTIMATE_USD/);
    expect(loadConfig({ LLM_ESTIMATE_USD: '0.01' }).LLM_ESTIMATE_USD).toBe(0.01);
  });

  it('validates TZ_PLAN as an IANA zone', () => {
    expect(loadConfig({}).TZ_PLAN).toBe('Europe/Moscow');
    expect(loadConfig({ TZ_PLAN: 'Asia/Tbilisi' }).TZ_PLAN).toBe('Asia/Tbilisi');
    expect(() => loadConfig({ TZ_PLAN: 'Mars/Olympus' })).toThrow(/TZ_PLAN/);
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow();
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['Yes', true],
    ['1', true],
    ['false', false],
    ['False', false],
    ['NO', false],
    ['0', false],
  ])('accepts DRY_RUN=%s', (raw, expected) => {
    expect(loadConfig({ DRY_RUN: raw }).DRY_RUN).toBe(expected);
  });

  it('fails clearly on an invalid DRY_RUN without echoing secrets', () => {
    expect(() => loadConfig({ DRY_RUN: 'maybe', TELEGRAM_BOT_TOKEN: 'SECRETVALUE123' })).toThrow(
      /Invalid configuration: DRY_RUN: must be one of true, false, 1, 0, yes, no/,
    );
    expect(() =>
      loadConfig({ DRY_RUN: 'maybe', TELEGRAM_BOT_TOKEN: 'SECRETVALUE123' }),
    ).not.toThrow(/SECRETVALUE123/);
  });
  it('has publisher defaults: Bot API base URL, empty TG_TRAILER (D-17)', () => {
    const c = loadConfig({});
    expect(c.TELEGRAM_API_BASE_URL).toBe('https://api.telegram.org');
    expect(c.TG_TRAILER).toBe('');
    expect(loadConfig({ TG_TRAILER: '#тег' }).TG_TRAILER).toBe('#тег');
    expect(() => loadConfig({ TELEGRAM_API_BASE_URL: 'nope' })).toThrow();
  });
  it('D-24: DRY_RUN absent or empty (as deploy.yml may write it) means dry run; garbage is a config error', () => {
    expect(loadConfig({}).DRY_RUN).toBe(true);
    expect(loadConfig({ DRY_RUN: '' }).DRY_RUN).toBe(true);
    expect(loadConfig({ DRY_RUN: 'true' }).DRY_RUN).toBe(true);
    expect(loadConfig({ DRY_RUN: 'false' }).DRY_RUN).toBe(false);
    // A typo never turns publishing on: the service refuses to start (exit 78, nothing sent).
    expect(() => loadConfig({ DRY_RUN: 'flase' })).toThrow(/DRY_RUN/);
  });

  // WP-PLAT-02: the platforms outside Telegram.
  it('platform defaults: both dry, link inline, the scheduler rules of Telegram', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      DRY_RUN_THREADS: true,
      DRY_RUN_LINKEDIN: true,
      THREADS_GRACE_MIN: 90,
      THREADS_MIN_GAP_MIN: 20,
      LINKEDIN_GRACE_MIN: 90,
      LINKEDIN_MIN_GAP_MIN: 20,
      THREADS_DISCLAIMER: false,
      LINKEDIN_LINK_URL: 'https://t.me/Channel1/57',
      LINKEDIN_LINK_MODE: 'inline',
      LINKEDIN_VERSION: '202609',
      LINKEDIN_TEXT_LIMIT: 3000,
      LINKEDIN_API_BASE_URL: 'https://api.linkedin.com',
      LINKEDIN_OAUTH_BASE_URL: 'https://www.linkedin.com',
      PLATFORM_CONFIG_IGNORED: [],
    });
    // The base URLs are the connect package's fields and serve the adapters too.
    expect(c.THREADS_API_BASE_URL).toBe('https://graph.threads.net');
    expect(c.LINKEDIN_AUTHOR_URN).toBeUndefined();
  });

  it('the platform modes are independent of DRY_RUN and of each other', () => {
    const c = loadConfig({ DRY_RUN: 'false', DRY_RUN_LINKEDIN: 'no' });
    expect([c.DRY_RUN, c.DRY_RUN_THREADS, c.DRY_RUN_LINKEDIN]).toEqual([false, true, false]);
    const d = loadConfig({ DRY_RUN_THREADS: '0' });
    expect([d.DRY_RUN, d.DRY_RUN_THREADS, d.DRY_RUN_LINKEDIN]).toEqual([true, false, true]);
  });

  it('parses platform overrides', () => {
    const c = loadConfig({
      THREADS_GRACE_MIN: '30',
      LINKEDIN_MIN_GAP_MIN: '0',
      THREADS_DISCLAIMER: 'yes',
      LINKEDIN_LINK_MODE: 'comment',
      LINKEDIN_VERSION: '202701',
      LINKEDIN_AUTHOR_URN: 'urn:li:person:782bbtaQ',
      LINKEDIN_LINK_URL: 'https://t.me/Channel1/99',
    });
    expect(c).toMatchObject({
      THREADS_GRACE_MIN: 30,
      LINKEDIN_MIN_GAP_MIN: 0,
      THREADS_DISCLAIMER: true,
      LINKEDIN_LINK_MODE: 'comment',
      LINKEDIN_VERSION: '202701',
      LINKEDIN_AUTHOR_URN: 'urn:li:person:782bbtaQ',
      LINKEDIN_LINK_URL: 'https://t.me/Channel1/99',
      PLATFORM_CONFIG_IGNORED: [],
    });
  });

  it('a wrong platform value never fails the boot: the safe default applies and the key is named', () => {
    const c = loadConfig({
      TELEGRAM_BOT_TOKEN: 'tg',
      DRY_RUN: 'false',
      DRY_RUN_THREADS: 'flase',
      DRY_RUN_LINKEDIN: 'nope',
      LINKEDIN_LINK_MODE: 'coment',
      LINKEDIN_VERSION: '2026-09',
      THREADS_MIN_GAP_MIN: '-5',
      LINKEDIN_GRACE_MIN: 'soon',
      LINKEDIN_AUTHOR_URN: 'SECRETLOOKINGVALUE',
      LINKEDIN_LINK_URL: 'two words',
    });
    // A typo in a platform mode never turns that platform on.
    expect(c).toMatchObject({
      DRY_RUN: false,
      DRY_RUN_THREADS: true,
      DRY_RUN_LINKEDIN: true,
      LINKEDIN_LINK_MODE: 'inline',
      LINKEDIN_VERSION: '202609',
      THREADS_MIN_GAP_MIN: 20,
      LINKEDIN_GRACE_MIN: 90,
      LINKEDIN_LINK_URL: 'https://t.me/Channel1/57',
    });
    expect(c.LINKEDIN_AUTHOR_URN).toBeUndefined();
    // Names only, never the values.
    expect(c.PLATFORM_CONFIG_IGNORED).toEqual([
      'DRY_RUN_THREADS',
      'DRY_RUN_LINKEDIN',
      'THREADS_MIN_GAP_MIN',
      'LINKEDIN_GRACE_MIN',
      'LINKEDIN_LINK_URL',
      'LINKEDIN_LINK_MODE',
      'LINKEDIN_VERSION',
      'LINKEDIN_AUTHOR_URN',
    ]);
    expect(JSON.stringify(c.PLATFORM_CONFIG_IGNORED)).not.toContain('SECRETLOOKINGVALUE');
    // The fingerprint follows the values without holding them.
    const sig = (env: Record<string, string>) => loadConfig(env).PLATFORM_CONFIG_IGNORED_SIG;
    expect(sig({})).toBe('');
    expect(sig({ DRY_RUN_THREADS: 'false' })).toBe('');
    expect(sig({ DRY_RUN_THREADS: 'flase' })).toMatch(/^[0-9a-f]{64}$/);
    expect(sig({ DRY_RUN_THREADS: 'flase' })).toBe(sig({ DRY_RUN_THREADS: 'flase', PORT: '9000' }));
    expect(sig({ DRY_RUN_THREADS: 'flase' })).not.toBe(sig({ DRY_RUN_THREADS: 'fasle' }));
    expect(sig({ DRY_RUN_THREADS: 'flase' })).not.toBe(sig({ DRY_RUN_LINKEDIN: 'flase' }));
    expect(c.PLATFORM_CONFIG_IGNORED_SIG).not.toContain('SECRETLOOKINGVALUE');
    // Telegram's own settings stay strict.
    expect(() => loadConfig({ DRY_RUN: 'flase', DRY_RUN_THREADS: 'flase' })).toThrow(/DRY_RUN/);
  });
});
