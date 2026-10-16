import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptToken,
  encryptToken,
  hashState,
  isStateShaped,
  newState,
  parseTokenStoreKey,
} from '../../src/connect/crypto.js';

const KEY = Buffer.alloc(32, 0x11);
const TOKEN = 'FAKE-TOKEN-for-the-crypto-test-0123456789';

describe('TOKEN_STORE_KEY', () => {
  it('is base64 (standard or URL-safe) of exactly 32 bytes', () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => 250 - i));
    expect(parseTokenStoreKey(bytes.toString('base64'))).toEqual(bytes);
    expect(parseTokenStoreKey(bytes.toString('base64url'))).toEqual(bytes);
    expect(parseTokenStoreKey(` ${bytes.toString('base64')}\n`)).toEqual(bytes);
    for (const bad of [
      undefined,
      '',
      'not a key',
      Buffer.alloc(31).toString('base64'),
      Buffer.alloc(33).toString('base64'),
      Buffer.alloc(16).toString('hex'),
      `${bytes.toString('base64')}!`,
    ]) {
      expect(parseTokenStoreKey(bad)).toBeUndefined();
    }
  });
});

describe('token encryption (AES-256-GCM)', () => {
  it('round-trips, and the stored text holds nothing of the token', () => {
    const stored = encryptToken(KEY, 'threads', TOKEN);
    expect(stored).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(Buffer.from(TOKEN).toString('base64url').slice(0, 12));
    expect(decryptToken(KEY, 'threads', stored)).toBe(TOKEN);
  });

  it('uses a fresh IV every time', () => {
    const all = new Set(Array.from({ length: 50 }, () => encryptToken(KEY, 'threads', TOKEN)));
    expect(all.size).toBe(50);
    expect(new Set([...all].map((s) => s.split('.')[1])).size).toBe(50);
  });

  it('does not decrypt with another key, for another platform, or after any change', () => {
    const stored = encryptToken(KEY, 'threads', TOKEN);
    expect(decryptToken(Buffer.alloc(32, 0x12), 'threads', stored)).toBeUndefined();
    expect(decryptToken(KEY, 'linkedin', stored)).toBeUndefined();
    const parts = stored.split('.');
    for (let i = 1; i < 4; i++) {
      const changed = [...parts];
      const b = Buffer.from(changed[i]!, 'base64url');
      b[0] = b[0]! ^ 1;
      changed[i] = b.toString('base64url');
      expect(decryptToken(KEY, 'threads', changed.join('.'))).toBeUndefined();
    }
    for (const junk of ['', TOKEN, 'v1.a.b', 'v2.' + parts.slice(1).join('.'), 'v1....']) {
      expect(decryptToken(KEY, 'threads', junk)).toBeUndefined();
    }
  });
});

describe('OAuth state', () => {
  it('is 32 random bytes as 43 base64url characters, different every time', () => {
    const states = new Set(Array.from({ length: 200 }, () => newState()));
    expect(states.size).toBe(200);
    for (const s of states) {
      expect(isStateShaped(s)).toBe(true);
      expect(Buffer.from(s, 'base64url')).toHaveLength(32);
    }
    for (const bad of [
      '',
      'a'.repeat(42),
      'a'.repeat(44),
      `${'a'.repeat(42)}+`,
      `${'a'.repeat(42)}%`,
    ]) {
      expect(isStateShaped(bad)).toBe(false);
    }
  });

  it('is stored as its SHA-256', () => {
    const s = newState();
    expect(hashState(s)).toBe(createHash('sha256').update(s).digest('hex'));
    expect(hashState(s)).toHaveLength(64);
    expect(hashState(s)).not.toContain(s);
  });
});
