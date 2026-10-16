-- Owner inbox files: the photos and image files the owner sends the bot are kept as Telegram
-- file references (never the bytes), so the director can fetch them later. An album arrives as
-- one message per picture; `media_group_id` puts them back together.
--
-- The CHECK on `kind` cannot be changed in place in SQLite, so owner_inbox is rebuilt: same
-- columns and ids, `kind` may also be 'photo' or 'document', plus `media_group_id` (nullable).
-- Every existing row is copied as it is; nothing references owner_inbox before this migration.
CREATE TABLE owner_inbox_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id           INTEGER NOT NULL UNIQUE,
  message_id          INTEGER NOT NULL,
  at                  TEXT NOT NULL,
  text                TEXT NOT NULL,
  reply_to_message_id INTEGER,
  draft_id            INTEGER REFERENCES owner_drafts (id),
  kind                TEXT NOT NULL CHECK (kind IN ('text', 'other', 'photo', 'document')),
  media_group_id      TEXT
);
INSERT INTO owner_inbox_new
  (id, update_id, message_id, at, text, reply_to_message_id, draft_id, kind)
  SELECT id, update_id, message_id, at, text, reply_to_message_id, draft_id, kind
    FROM owner_inbox;
-- Ids go on where they were: an id is the director's cursor, it is never given twice.
UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT seq FROM sqlite_sequence WHERE name = 'owner_inbox'))
 WHERE name = 'owner_inbox_new'
   AND EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'owner_inbox');
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'owner_inbox_new', seq FROM sqlite_sequence
   WHERE name = 'owner_inbox'
     AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'owner_inbox_new');
DROP TABLE owner_inbox;
ALTER TABLE owner_inbox_new RENAME TO owner_inbox;
CREATE INDEX owner_inbox_media_group ON owner_inbox (media_group_id);

-- One row per file of an inbox message (a photo: its largest size; an image document: the
-- file). `file_id` is what getFile needs; it is never returned by the API or logged.
CREATE TABLE owner_inbox_files (
  inbox_id       INTEGER NOT NULL REFERENCES owner_inbox (id),
  idx            INTEGER NOT NULL CHECK (idx >= 0),
  file_id        TEXT NOT NULL,
  file_unique_id TEXT NOT NULL,
  mime           TEXT,
  width          INTEGER,
  height         INTEGER,
  PRIMARY KEY (inbox_id, idx)
);
