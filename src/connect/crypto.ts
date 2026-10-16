import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Cryptography of the account connect (WP-PLAT-06), in one place:
//   - tokens at rest: AES-256-GCM, key = the 32 bytes behind env TOKEN_STORE_KEY (base64), a
//     fresh 12-byte IV per write, the platform name as additional authenticated data (a row
//     copied to another platform does not decrypt);
//   - OAuth states: 32 random bytes, handed out base64url-encoded, stored only as SHA-256.
// Nothing here logs, and no error message holds a key, a token or a state.

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
export const STATE_BYTES = 32;

const b64url = (b: Buffer) => b.toString('base64url');

/**
 * The key behind TOKEN_STORE_KEY: standard or URL-safe base64 of exactly 32 bytes
 * (`openssl rand -base64 32`). `undefined` when the value is anything else.
 */
export function parseTokenStoreKey(raw: string | undefined): Buffer | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return undefined;
  const key = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return key.length === KEY_BYTES ? key : undefined;
}

/** `v1.<iv>.<ciphertext>.<tag>`, each part base64url. */
export function encryptToken(key: Buffer, platform: string, token: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`platform_tokens:${platform}`, 'utf8'));
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [VERSION, b64url(iv), b64url(body), b64url(cipher.getAuthTag())].join('.');
}

/** The token, or `undefined` when the text is not ours, was altered, or the key is another one. */
export function decryptToken(key: Buffer, platform: string, stored: string): string | undefined {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return undefined;
  try {
    const iv = Buffer.from(parts[1]!, 'base64url');
    const tag = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== 16) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(`platform_tokens:${platform}`, 'utf8'));
    decipher.setAuthTag(tag);
    const body = Buffer.concat([
      decipher.update(Buffer.from(parts[2]!, 'base64url')),
      decipher.final(),
    ]);
    return body.toString('utf8');
  } catch {
    return undefined;
  }
}

/** A new one-time state: 32 random bytes as 43 base64url characters. */
export function newState(): string {
  return b64url(randomBytes(STATE_BYTES));
}

/** What a state looks like; anything else is not looked up at all. */
export function isStateShaped(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * The stored form of a state. The lookup is by this hash (a primary key), so the secret itself
 * is never compared byte by byte and never sits in the database.
 */
export function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}
