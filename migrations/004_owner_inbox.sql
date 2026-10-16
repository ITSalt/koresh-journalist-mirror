-- Owner inbox: drafts the bot sent to the owner's private chat, and the owner's replies.
CREATE TABLE owner_drafts (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  label  TEXT,
  ref    TEXT,
  text   TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'partial')),
  error  TEXT
);

CREATE TABLE owner_draft_parts (
  draft_id   INTEGER NOT NULL REFERENCES owner_drafts (id),
  part       INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (draft_id, part),
  UNIQUE (message_id)
);

CREATE TABLE owner_inbox (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id           INTEGER NOT NULL UNIQUE,
  message_id          INTEGER NOT NULL,
  at                  TEXT NOT NULL,
  text                TEXT NOT NULL,
  reply_to_message_id INTEGER,
  draft_id            INTEGER REFERENCES owner_drafts (id),
  kind                TEXT NOT NULL CHECK (kind IN ('text', 'other'))
);

-- Small key/value state of the bot (the getUpdates offset).
CREATE TABLE bot_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
