import type Database from 'better-sqlite3';

// Rows of the account connect (WP-PLAT-06): encrypted platform tokens and one-time OAuth states.
// This file knows nothing about encryption or hashing: it stores what it is given. The callers
// (src/connect/) hand it ciphertext and state hashes only.

export type ConnectPlatform = 'threads' | 'linkedin';
export const CONNECT_PLATFORMS: readonly ConnectPlatform[] = ['threads', 'linkedin'];

export interface PlatformTokenRow {
  platform: ConnectPlatform;
  /** Ciphertext, never the token. */
  tokenEnc: string;
  expiresAt: string;
  accountId: string;
  accountName: string;
  connectedAt: string;
  lastRefreshAt: string | null;
  updatedAt: string;
}

export type StateUse = 'ok' | 'unknown' | 'expired' | 'used' | 'wrong_platform';

export interface ConnectStore {
  tokens: {
    get(platform: ConnectPlatform): PlatformTokenRow | undefined;
    /** A new connect: inserts or replaces the whole row (token, account, expiry). */
    put(
      row: Pick<
        PlatformTokenRow,
        'platform' | 'tokenEnc' | 'expiresAt' | 'accountId' | 'accountName'
      >,
      at?: Date,
    ): void;
    /**
     * A refresh: replaces token and expiry of an EXISTING row and stamps `last_refresh_at`.
     * False (and nothing written) when the platform is not connected, so a refresh that ends
     * after a disconnect can never bring a token back.
     */
    replaceToken(
      platform: ConnectPlatform,
      tokenEnc: string,
      expiresAt: string,
      at?: Date,
    ): boolean;
    /** Deletes the row; false when there was none. The freed pages are zeroed. */
    delete(platform: ConnectPlatform): boolean;
  };
  states: {
    add(stateHash: string, platform: ConnectPlatform, expiresAt: Date, at?: Date): void;
    /**
     * Uses a state up. `ok` only for a known, unused, unexpired state of this platform, and only
     * once: the row is marked used in the same guarded statement. A valid state presented at the
     * other platform's callback is used up too (`wrong_platform`).
     */
    consume(stateHash: string, platform: ConnectPlatform, at?: Date): StateUse;
    /** Removes the unused states of a platform (after a disconnect). */
    revoke(platform: ConnectPlatform): number;
    /** Removes states whose validity ended before `before`. */
    prune(before: Date): number;
  };
}

type Row = Record<string, unknown>;

const toToken = (r: Row): PlatformTokenRow => ({
  platform: r.platform as ConnectPlatform,
  tokenEnc: r.token_enc as string,
  expiresAt: r.expires_at as string,
  accountId: r.account_id as string,
  accountName: r.account_name as string,
  connectedAt: r.connected_at as string,
  lastRefreshAt: (r.last_refresh_at as string | null) ?? null,
  updatedAt: r.updated_at as string,
});

export function buildConnectStore(db: Database.Database): ConnectStore {
  // Deleted and replaced tokens must not linger in free pages of the file (per connection).
  db.pragma('secure_delete = ON');
  /** Moves the write-ahead log into the main file and empties it; best effort. */
  const flush = () => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // A busy reader only delays the checkpoint; the next one does it.
    }
  };
  return {
    tokens: {
      get(platform) {
        const r = db.prepare('SELECT * FROM platform_tokens WHERE platform = ?').get(platform) as
          Row | undefined;
        return r ? toToken(r) : undefined;
      },
      put(row, at = new Date()) {
        const now = at.toISOString();
        db.prepare(
          `INSERT INTO platform_tokens
             (platform, token_enc, expires_at, account_id, account_name, connected_at,
              last_refresh_at, updated_at)
           VALUES (@platform, @tokenEnc, @expiresAt, @accountId, @accountName, @now, NULL, @now)
           ON CONFLICT(platform) DO UPDATE SET
             token_enc = excluded.token_enc, expires_at = excluded.expires_at,
             account_id = excluded.account_id, account_name = excluded.account_name,
             connected_at = excluded.connected_at, last_refresh_at = NULL,
             updated_at = excluded.updated_at`,
        ).run({
          platform: row.platform,
          tokenEnc: row.tokenEnc,
          expiresAt: row.expiresAt,
          accountId: row.accountId,
          accountName: row.accountName,
          now,
        });
        flush();
      },
      replaceToken(platform, tokenEnc, expiresAt, at = new Date()) {
        const now = at.toISOString();
        const res = db
          .prepare(
            `UPDATE platform_tokens
                SET token_enc = ?, expires_at = ?, last_refresh_at = ?, updated_at = ?
              WHERE platform = ?`,
          )
          .run(tokenEnc, expiresAt, now, now, platform);
        flush();
        return res.changes > 0;
      },
      delete(platform) {
        const res = db.prepare('DELETE FROM platform_tokens WHERE platform = ?').run(platform);
        flush();
        return res.changes > 0;
      },
    },
    states: {
      add(stateHash, platform, expiresAt, at = new Date()) {
        db.prepare(
          'INSERT INTO oauth_states (state_hash, platform, created_at, expires_at) VALUES (?, ?, ?, ?)',
        ).run(stateHash, platform, at.toISOString(), expiresAt.toISOString());
      },
      consume(stateHash, platform, at = new Date()) {
        const now = at.toISOString();
        return db
          .transaction((): StateUse => {
            const r = db
              .prepare(
                'SELECT platform, expires_at, used_at FROM oauth_states WHERE state_hash = ?',
              )
              .get(stateHash) as Row | undefined;
            if (!r) return 'unknown';
            if (r.used_at !== null) return 'used';
            // Guarded: of two processes with the same state only one sees `changes = 1`.
            const res = db
              .prepare(
                'UPDATE oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL',
              )
              .run(now, stateHash);
            if (res.changes !== 1) return 'used';
            if ((r.expires_at as string) <= now) return 'expired';
            if (r.platform !== platform) return 'wrong_platform';
            return 'ok';
          })
          .immediate();
      },
      revoke(platform) {
        return db
          .prepare('DELETE FROM oauth_states WHERE platform = ? AND used_at IS NULL')
          .run(platform).changes;
      },
      prune(before) {
        return db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(before.toISOString())
          .changes;
      },
    },
  };
}
