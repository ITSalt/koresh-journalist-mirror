-- Illustrations of channel posts (WP-SVC-24, D-32): each image is stored once under the sha256 of
-- its bytes. A plan slot names its image by that sha256 inside the slot json, so the publisher's
-- claim (slot json unchanged) covers the image together with the text. Rows are never changed.
CREATE TABLE images (
  sha256     TEXT PRIMARY KEY,
  mime       TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  bytes      BLOB NOT NULL,
  size       INTEGER NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
