-- Account connect (WP-PLAT-06, D-5): the owner's platform tokens and the one-time OAuth states.
-- Additive: two new tables, nothing existing changes. 006 belongs to WP-PLAT-01 (slot variants).

-- One row per connected platform. `token_enc` is the access token encrypted with AES-256-GCM
-- under the key from env TOKEN_STORE_KEY ("v1.<iv>.<ciphertext>.<tag>", base64url, the platform
-- name bound in as additional data). The token itself is never written anywhere in clear.
CREATE TABLE platform_tokens (
  platform        TEXT PRIMARY KEY CHECK (platform IN ('threads', 'linkedin')),
  token_enc       TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  account_name    TEXT NOT NULL,
  connected_at    TEXT NOT NULL,
  last_refresh_at TEXT,
  updated_at      TEXT NOT NULL
);

-- One row per link made by POST /v1/connect/<platform>/start. Only the SHA-256 of the state is
-- kept; a state is valid for 30 minutes and for one use (`used_at`).
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  platform   TEXT NOT NULL CHECK (platform IN ('threads', 'linkedin')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX oauth_states_expires_at ON oauth_states (expires_at);
