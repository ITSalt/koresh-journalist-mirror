-- One row per (job, plan date): the in-process scheduler claims it before running the job, so a
-- job never runs twice for a date, across restarts and across processes on one DB file.
CREATE TABLE job_runs (
  job    TEXT NOT NULL,
  date   TEXT NOT NULL,
  at     TEXT NOT NULL,
  result TEXT,
  PRIMARY KEY (job, date)
);

-- sha256 of the canonical JSON body of POST /v1/plans/:date (idempotency); NULL for the fallback.
ALTER TABLE plans ADD COLUMN input_sha256 TEXT;

-- When the plan row was last written; the 23:00 job approves only a draft stored before 22:00.
ALTER TABLE plans ADD COLUMN updated_at TEXT;
