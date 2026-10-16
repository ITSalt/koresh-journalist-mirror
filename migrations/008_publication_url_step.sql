-- Publications of the variants of a slot (WP-PLAT-02): two more facts on the publication row.
-- `url`: the public address of the post on its platform, stored with the platform's id
-- (`message_id`) when the row becomes `sent`.
-- `step`: the last recorded step of a publish that takes more than one request (Threads: a
-- container, then the publish call), written while the row is still an intent and BEFORE the
-- request that makes the post public leaves, so a restart never sends that request again.
-- Additive: two nullable columns. A Telegram row never sets them and reads exactly as before.
ALTER TABLE publications ADD COLUMN url TEXT;
ALTER TABLE publications ADD COLUMN step TEXT;
