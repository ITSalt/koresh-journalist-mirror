CREATE TABLE alerts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX alerts_at ON alerts (at);
