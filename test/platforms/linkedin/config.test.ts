import { describe, expect, it } from 'vitest';
import {
  LINKEDIN_SECRET_KEYS,
  LinkedInConfigError,
  loadLinkedInConfig,
} from '../../../src/platforms/linkedin/config.js';

describe('loadLinkedInConfig', () => {
  it('has safe defaults: inline link, version 202609, limit 3000, the real hosts', () => {
    expect(loadLinkedInConfig({})).toEqual({
      LINKEDIN_VERSION: '202609',
      LINKEDIN_LINK_MODE: 'inline',
      LINKEDIN_TEXT_LIMIT: 3000,
      LINKEDIN_API_BASE_URL: 'https://api.linkedin.com',
      LINKEDIN_OAUTH_BASE_URL: 'https://www.linkedin.com',
    });
  });

  it('reads the settings by name and treats an empty value as unset', () => {
    const cfg = loadLinkedInConfig({
      LINKEDIN_TOKEN: 'fake-token',
      LINKEDIN_CLIENT_ID: 'fake-client-id',
      LINKEDIN_CLIENT_SECRET: '',
      LINKEDIN_AUTHOR_URN: 'urn:li:person:782bbtaQ',
      LINKEDIN_VERSION: '202701',
      LINKEDIN_LINK_MODE: 'comment',
      LINKEDIN_TEXT_LIMIT: '1300',
      UNRELATED: 'x',
    });
    expect(cfg).toMatchObject({
      LINKEDIN_TOKEN: 'fake-token',
      LINKEDIN_CLIENT_ID: 'fake-client-id',
      LINKEDIN_AUTHOR_URN: 'urn:li:person:782bbtaQ',
      LINKEDIN_VERSION: '202701',
      LINKEDIN_LINK_MODE: 'comment',
      LINKEDIN_TEXT_LIMIT: 1300,
    });
    expect(cfg.LINKEDIN_CLIENT_SECRET).toBeUndefined();
    expect(cfg).not.toHaveProperty('UNRELATED');
  });

  it.each([
    ['LINKEDIN_LINK_MODE', 'first-comment'],
    ['LINKEDIN_VERSION', '2026-09'],
    ['LINKEDIN_VERSION', '202613'],
    ['LINKEDIN_TEXT_LIMIT', '-17'],
    ['LINKEDIN_AUTHOR_URN', 'urn:li:organization:1'],
    ['LINKEDIN_API_BASE_URL', 'not a url'],
  ])('refuses %s=%s and names the key without the value', (key, value) => {
    let thrown: unknown;
    try {
      loadLinkedInConfig({ [key]: value });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LinkedInConfigError);
    expect((thrown as Error).message).toContain(key);
    expect((thrown as Error).message).not.toContain(value);
  });

  it('lists the secret keys for redaction', () => {
    expect(LINKEDIN_SECRET_KEYS).toEqual(['LINKEDIN_TOKEN', 'LINKEDIN_CLIENT_SECRET']);
  });
});
