-- Variants of a plan slot (WP-PLAT-01, plan.json v2): one text per platform and language outside
-- Telegram, each with its own time and its own status. `json` is the variant as it stands in the
-- plan json: {platform, lang, at, text}, the text being the body plus the signature line.
-- A variant belongs to its slot row: when the slots of a plan are replaced (a draft is posted
-- again, the fallback writes a plan), the variants of the old slots go with them.
-- Additive: one new table, nothing existing is changed; a plan stored before has no rows here.
CREATE TABLE slot_variants (
  plan_date TEXT NOT NULL,
  slot_id   TEXT NOT NULL,
  platform  TEXT NOT NULL,
  lang      TEXT NOT NULL,
  at        TEXT NOT NULL,
  json      TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'skipped', 'done')),
  PRIMARY KEY (plan_date, slot_id, platform, lang),
  FOREIGN KEY (plan_date, slot_id) REFERENCES slots (plan_date, slot_id) ON DELETE CASCADE
);
