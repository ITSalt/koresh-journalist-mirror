CREATE TABLE feed_entries (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  url          TEXT,
  title        TEXT NOT NULL,
  summary      TEXT,
  published_at TEXT,
  fetched_at   TEXT NOT NULL
);

CREATE TABLE plans (
  date       TEXT PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'rejected', 'failed')),
  json       TEXT NOT NULL,
  md         TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE slots (
  plan_date TEXT NOT NULL REFERENCES plans (date),
  slot_id   TEXT NOT NULL,
  at        TEXT NOT NULL,
  kind      TEXT NOT NULL,
  json      TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'skipped', 'done')),
  PRIMARY KEY (plan_date, slot_id)
);

CREATE TABLE publications (
  key         TEXT NOT NULL UNIQUE,
  platform    TEXT NOT NULL,
  plan_date   TEXT NOT NULL,
  slot_id     TEXT NOT NULL,
  part        INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL CHECK (status IN ('intent', 'sent', 'failed', 'unknown', 'dry', 'skipped')),
  message_id  TEXT,
  text_sha256 TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  sent_at     TEXT,
  error       TEXT
);
CREATE INDEX publications_slot ON publications (plan_date, slot_id);

CREATE TABLE feedback (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_date TEXT NOT NULL,
  slot_id   TEXT,
  verdict   TEXT NOT NULL CHECK (verdict IN ('like', 'dislike')),
  note      TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX feedback_plan ON feedback (plan_date);

CREATE TABLE llm_spend (
  day TEXT PRIMARY KEY,
  usd REAL NOT NULL DEFAULT 0
);
