import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { VariantLang, VariantPlatform } from '../plan/schema.js';
import { buildConnectStore, type ConnectStore } from './connect.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from './migrate.js';

export { runMigrations } from './migrate.js';

// ---------- types ----------

export type PlanStatus = 'draft' | 'approved' | 'rejected' | 'failed';
export type PublicationStatus = 'intent' | 'sent' | 'failed' | 'unknown' | 'dry' | 'skipped';
export type SlotStatus = 'planned' | 'skipped' | 'done';
export type Verdict = 'like' | 'dislike';

export interface Plan {
  date: string;
  status: PlanStatus;
  json: string;
  md: string;
  createdAt: string;
  /** sha256 of the canonical POST body that produced the plan; null otherwise. */
  inputSha256: string | null;
  /** Last write of the row (ISO); `createdAt` for rows older than migration 003. */
  updatedAt: string;
}
export type PlanInput = Pick<Plan, 'date' | 'status' | 'json' | 'md'> & {
  inputSha256?: string | null;
};

/** Thrown when a write would move a `rejected` plan to another status. */
export class PlanRejected extends Error {
  constructor(readonly date: string) {
    super(`plan "${date}" is rejected and stays rejected`);
    this.name = 'PlanRejected';
  }
}

export interface Slot {
  planDate: string;
  slotId: string;
  at: string;
  kind: string;
  json: string;
  status: SlotStatus;
}
export type SlotInput = Omit<Slot, 'planDate' | 'status'>;

/**
 * One variant of a slot (WP-PLAT-01): the text of the slot for one platform and language outside
 * Telegram. `json` is the variant of the plan json, `{platform, lang, at, text}`.
 */
export interface SlotVariant {
  planDate: string;
  slotId: string;
  platform: VariantPlatform;
  lang: VariantLang;
  at: string;
  json: string;
  status: SlotStatus;
}
export type SlotVariantInput = Omit<SlotVariant, 'planDate' | 'status'>;

export interface Publication {
  key: string;
  platform: string;
  planDate: string;
  slotId: string;
  part: number;
  status: PublicationStatus;
  messageId: string | null;
  textSha256: string;
  createdAt: string;
  sentAt: string | null;
  error: string | null;
  /** Public address of the post (WP-PLAT-02); present only on a row that has one. */
  url?: string;
  /** Last recorded step of a multi-request publish, as JSON; present only when recorded. */
  step?: string;
}
export interface IntentInput {
  key: string;
  platform: string;
  planDate: string;
  slotId: string;
  part?: number;
  textSha256: string;
  /**
   * The slot json the text was composed from (the publisher always passes it). The intent is
   * then written only while the plan is `approved` and the slot is `planned` and still holds
   * exactly this json, checked in the same statement as the insert: a slot replaced meanwhile
   * (WP-SVC-22) is never sent with its old text. Otherwise `SlotNotClaimable` is thrown.
   */
  expectSlotJson?: string;
}

export interface Feedback {
  id: number;
  planDate: string;
  slotId: string | null;
  verdict: Verdict;
  note: string | null;
  at: string;
}
export interface FeedbackInput {
  planDate: string;
  slotId?: string;
  verdict: Verdict;
  note?: string;
}

export interface Alert {
  id: number;
  at: string;
  kind: string;
  message: string;
}
export interface AlertInput {
  kind: string;
  message: string;
}

/**
 * The claim of one publication of a variant (WP-PLAT-02). The row is written only while the plan
 * is `approved` and the variant row of (planDate, slotId, platform, lang) is `planned` and still
 * holds exactly `expectVariantJson`, in the same statement as the insert. It never looks at the
 * `slots` table: the Telegram slot and its variants are claimed independently.
 */
export interface VariantIntentInput {
  key: string;
  platform: VariantPlatform;
  planDate: string;
  slotId: string;
  lang: VariantLang;
  part?: number;
  textSha256: string;
  expectVariantJson: string;
}

/**
 * The claim of the first comment under a variant's post (WP-PLAT-02): its own item with its own
 * key. The row is written only while the post row `postKey` is `sent`, the plan is `approved`
 * and the variant is still `planned` (a variant with a comment to come stays `planned` until the
 * comment has its result, so a reject of the day, which skips what is planned, stops it), in
 * one statement.
 */
export interface CommentIntentInput {
  key: string;
  platform: VariantPlatform;
  planDate: string;
  slotId: string;
  lang: VariantLang;
  part: number;
  textSha256: string;
  postKey: string;
}

/** Result of `spend.reserve`: `day` is the MSK day the estimate was booked on. */
export type OwnerDraftStatus = 'sent' | 'failed' | 'partial';
export interface OwnerDraft {
  id: number;
  at: string;
  label: string | null;
  ref: string | null;
  text: string;
  status: OwnerDraftStatus;
  error: string | null;
}
export interface OwnerDraftInput {
  label?: string | null;
  ref?: string | null;
  text: string;
  status: OwnerDraftStatus;
  error?: string | null;
}
export type InboxKind = 'text' | 'other' | 'photo' | 'document';
/** A file of an inbox message as the API may show it: no Telegram file id. */
export interface InboxFileMeta {
  idx: number;
  mime: string | null;
  width: number | null;
  height: number | null;
}
/** The stored reference: `fileId` is what getFile needs; never returned by the API or logged. */
export interface InboxFile extends InboxFileMeta {
  inboxId: number;
  fileId: string;
  fileUniqueId: string;
}
export type InboxFileInput = Omit<InboxFile, 'inboxId'>;
export interface InboxMessage {
  id: number;
  updateId: number;
  messageId: number;
  at: string;
  text: string;
  replyToMessageId: number | null;
  draftId: number | null;
  draftRef: string | null;
  draftLabel: string | null;
  kind: InboxKind;
  /** Telegram's `media_group_id`: the pictures of one album share it. */
  mediaGroupId: string | null;
}
export interface InboxInput {
  updateId: number;
  messageId: number;
  at: string;
  text: string;
  replyToMessageId?: number | null;
  draftId?: number | null;
  kind: InboxKind;
  mediaGroupId?: string | null;
  /** Stored with the row, in the same statement batch; only when the row is new. */
  files?: InboxFileInput[];
}

/** A stored illustration without its bytes (WP-SVC-24). */
export interface ImageMeta {
  /** sha256 (hex) of the bytes: the primary key. */
  sha256: string;
  mime: 'image/png' | 'image/jpeg';
  size: number;
  width: number;
  height: number;
  createdAt: string;
}
export interface StoredImage extends ImageMeta {
  bytes: Buffer;
}
export type ImageInput = Pick<StoredImage, 'mime' | 'bytes' | 'width' | 'height'>;

export interface Reservation {
  ok: boolean;
  day: string;
  /** Spend of `day` before this reservation. */
  spent: number;
}

export interface FeedEntry {
  id: string;
  source: string;
  url: string | null;
  title: string;
  summary: string | null;
  publishedAt: string | null;
  fetchedAt: string;
}
export interface FeedEntryInput {
  /** External FeedEntry.id. */
  id: string;
  source: string;
  /** Private entries are never stored; `feedEntries.upsert` throws. */
  private?: boolean;
  url?: string;
  title: string;
  summary?: string;
  publishedAt?: string;
}

/** Thrown by `publications.beginIntent` when the idempotency key already exists. */
export class AlreadyExists extends Error {
  constructor(readonly key: string) {
    super(`publication with key "${key}" already exists`);
    this.name = 'AlreadyExists';
  }
}

/**
 * Thrown by `publications.beginIntent` with `expectSlotJson` when the slot may not be published
 * as read: its json changed, it is not `planned`, or the plan is not `approved`.
 */
export class SlotNotClaimable extends Error {
  constructor(readonly key: string) {
    super(`publication "${key}": the slot changed or is no longer publishable`);
    this.name = 'SlotNotClaimable';
  }
}

/**
 * Thrown by `publications.beginVariantIntent` when the variant may not be published as read: its
 * json changed, it is not `planned`, or the plan is not `approved`.
 */
export class VariantNotClaimable extends Error {
  constructor(readonly key: string) {
    super(`publication "${key}": the variant changed or is no longer publishable`);
    this.name = 'VariantNotClaimable';
  }
}

// ---------- helpers ----------

const MSK = 'Europe/Moscow';

/** Calendar day (YYYY-MM-DD) of an instant in Moscow time (fixed UTC+3, no DST). */
export function mskDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MSK,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

const nowIso = () => new Date().toISOString();

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

interface Row {
  [k: string]: unknown;
}

const toPlan = (r: Row): Plan => ({
  date: r.date as string,
  status: r.status as PlanStatus,
  json: r.json as string,
  md: r.md as string,
  createdAt: r.created_at as string,
  inputSha256: (r.input_sha256 as string | null) ?? null,
  updatedAt: (r.updated_at as string | null) ?? (r.created_at as string),
});
const toSlot = (r: Row): Slot => ({
  planDate: r.plan_date as string,
  slotId: r.slot_id as string,
  at: r.at as string,
  kind: r.kind as string,
  json: r.json as string,
  status: r.status as SlotStatus,
});
const toSlotVariant = (r: Row): SlotVariant => ({
  planDate: r.plan_date as string,
  slotId: r.slot_id as string,
  platform: r.platform as VariantPlatform,
  lang: r.lang as VariantLang,
  at: r.at as string,
  json: r.json as string,
  status: r.status as SlotStatus,
});
const toPub = (r: Row): Publication => ({
  key: r.key as string,
  platform: r.platform as string,
  planDate: r.plan_date as string,
  slotId: r.slot_id as string,
  part: r.part as number,
  status: r.status as PublicationStatus,
  messageId: r.message_id as string | null,
  textSha256: r.text_sha256 as string,
  createdAt: r.created_at as string,
  sentAt: r.sent_at as string | null,
  error: r.error as string | null,
  // Only when set: a row without them (every Telegram row) has exactly the keys it always had.
  ...(typeof r.url === 'string' ? { url: r.url } : {}),
  ...(typeof r.step === 'string' ? { step: r.step } : {}),
});
const toFeedback = (r: Row): Feedback => ({
  id: r.id as number,
  planDate: r.plan_date as string,
  slotId: r.slot_id as string | null,
  verdict: r.verdict as Verdict,
  note: r.note as string | null,
  at: r.at as string,
});
const toAlert = (r: Row): Alert => ({
  id: r.id as number,
  at: r.at as string,
  kind: r.kind as string,
  message: r.message as string,
});
const toFeedEntry = (r: Row): FeedEntry => ({
  id: r.id as string,
  source: r.source as string,
  url: r.url as string | null,
  title: r.title as string,
  summary: r.summary as string | null,
  publishedAt: r.published_at as string | null,
  fetchedAt: r.fetched_at as string,
});

// ---------- store ----------

export interface Store {
  db: Database.Database;
  /** Migrations applied by this boot (empty on a second boot). */
  migrationsApplied: string[];
  /** True when the database answers a trivial query. */
  ping(): boolean;
  close(): void;
  plans: {
    /** Insert or update by date; an existing `rejected` plan keeps its status (never undone). */
    /** `at` is the write time (default now); it becomes `updatedAt`. */
    upsert(p: PlanInput, at?: Date): Plan;
    get(date: string): Plan | undefined;
    /** Throws `PlanRejected` when moving a `rejected` plan to any other status. */
    setStatus(date: string, status: PlanStatus): void;
    /** Replaces `json` and `md` only (WP-SVC-22); status and input hash stay. `at` -> `updatedAt`. */
    setContent(date: string, c: Pick<Plan, 'json' | 'md'>, at?: Date): void;
    /** Up to `limit` plans dated before `date`, newest first; rejected and failed are skipped. */
    listBefore(date: string, limit: number): Plan[];
  };
  slots: {
    replaceForPlan(planDate: string, slots: SlotInput[]): void;
    listForPlan(planDate: string): Slot[];
    setStatus(planDate: string, slotId: string, status: SlotStatus): void;
    /**
     * Replaces the stored json of one slot (WP-SVC-22); `kind` and status stay. With `at`
     * (WP-SVC-25) the `at` column moves in the same statement: the scheduler reads the column,
     * the claim compares the json, and both hold the time.
     */
    setJson(planDate: string, slotId: string, json: string, at?: string): void;
  };
  slotVariants: {
    /**
     * Replaces every variant of the plan date with `variants` (status `planned`). Each variant
     * must belong to a stored slot of that date, so the slots are written first; replacing the
     * slots of a plan (`slots.replaceForPlan`) removes the variants of the old ones.
     */
    replaceForPlan(planDate: string, variants: SlotVariantInput[]): void;
    /**
     * The variants of the plan date, by instant (`09:00+03:00` and `09:00:00+03:00` are the same
     * moment), then slot, platform and language.
     */
    listForPlan(planDate: string): SlotVariant[];
    setStatus(
      planDate: string,
      slotId: string,
      platform: VariantPlatform,
      lang: VariantLang,
      status: SlotStatus,
    ): void;
  };
  publications: {
    /** `at` (default now) becomes `createdAt`. See `IntentInput.expectSlotJson`. */
    beginIntent(i: IntentInput, at?: Date): Publication;
    /**
     * The claim of a variant: one statement against `slot_variants` and `plans` (see
     * `VariantIntentInput`). Throws `VariantNotClaimable` or `AlreadyExists`.
     */
    beginVariantIntent(i: VariantIntentInput, at?: Date): Publication;
    /** The claim of a first comment (see `CommentIntentInput`). Throws as `beginVariantIntent`. */
    beginCommentIntent(i: CommentIntentInput, at?: Date): Publication;
    /**
     * Records the step of a multi-request publish on an intent row. Durable when it returns.
     * Throws when the row is not an intent: a step is only ever written behind the claim.
     */
    setStep(key: string, step: string): void;
    /** `markSent` for a post that has a public address: id and url in one write. */
    markPosted(key: string, post: { id: string; url?: string }, at?: Date): Publication;
    get(key: string): Publication | undefined;
    /** `at` (default now) becomes `sentAt`. */
    markSent(key: string, messageId: string, at?: Date): Publication;
    /** DRY_RUN: the intent is recorded as `dry` (nothing was sent); `at` becomes `sentAt`. */
    markDry(key: string, at?: Date): Publication;
    markFailed(key: string, error: string): Publication;
    markUnknown(key: string, error?: string): Publication;
    /** Rows of a slot id, of every platform unless `platform` is given. */
    listForSlot(planDate: string, slotId: string, platform?: string): Publication[];
    listForPlan(planDate: string): Publication[];
    /**
     * Intents created more than `olderThanMs` before `now`, oldest first; of every platform
     * unless `platform` is given (each publish loop reconciles only its own).
     */
    listStaleIntents(olderThanMs: number, now?: Date, platform?: string): Publication[];
    /**
     * Marks intents created more than `olderThanMs` ago as unknown; returns how many. Of every
     * platform unless `platform` is given.
     */
    markStaleIntentsUnknown(olderThanMs: number, now?: Date, platform?: string): number;
  };
  feedback: {
    add(f: FeedbackInput, at?: Date): Feedback;
    listForPlan(planDate: string): Feedback[];
    /** Feedback given at or after `from`, oldest first. */
    listSince(from: Date): Feedback[];
  };
  feedEntries: {
    /** Insert or update by external id; throws on a private entry. */
    upsert(e: FeedEntryInput): void;
    recent(limit: number): FeedEntry[];
    /** Stored entries with these ids (unknown ids are simply absent). */
    getMany(ids: string[]): FeedEntry[];
  };
  jobRuns: {
    /**
     * Claims (job, date) atomically: true for the one caller that inserted the row, false when
     * the job already ran (or is running) for that date, in this or another process.
     */
    claim(job: string, date: string, at?: Date): boolean;
    finish(job: string, date: string, result: string): void;
    get(job: string, date: string): { at: string; result: string | null } | undefined;
  };
  spend: {
    add(usd: number, at?: Date): void;
    forDay(day: string): number;
    today(now?: Date): number;
    /**
     * In one IMMEDIATE transaction: if spend(MSK day of `at`) + estimate <= cap, books the
     * estimate on that day and returns ok; otherwise books nothing.
     */
    reserve(estimate: number, cap: number, at?: Date): Reservation;
    /** Replaces a booked estimate on `day` with the actual cost (never below zero). */
    settle(day: string, estimate: number, actual: number): void;
  };
  alerts: {
    add(a: AlertInput, at?: Date): Alert;
    list(limit?: number): Alert[];
    /** Alerts strictly after `since` (oldest first), up to `limit`. */
    listSince(since: Date, limit?: number): Alert[];
  };
  ownerDrafts: {
    add(d: OwnerDraftInput, at?: Date): OwnerDraft;
    setStatus(id: number, status: OwnerDraftStatus, error?: string | null): void;
    /** Records the Telegram message that carried part `part` (0-based) of a draft. */
    addPart(draftId: number, part: number, messageId: number): void;
    get(id: number): OwnerDraft | undefined;
    /** The draft one of whose parts is the Telegram message `messageId`. */
    byMessageId(messageId: number): OwnerDraft | undefined;
    messageIds(id: number): number[];
  };
  inbox: {
    /** Stores a message; false (and no row) when the update_id was already stored. */
    add(m: InboxInput): boolean;
    /** Messages with id > `id`, oldest first, up to `limit`. */
    listAfter(id: number, limit?: number): InboxMessage[];
    /** The files of these messages (no file id), by message id, each list in `idx` order. */
    fileMeta(inboxIds: number[]): Map<number, InboxFileMeta[]>;
    /** One stored file reference, with its file id (for getFile only). */
    file(inboxId: number, idx: number): InboxFile | undefined;
  };
  botState: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
  };
  /** Account connect (WP-PLAT-06): encrypted platform tokens and OAuth states; ./connect.ts. */
  connect: ConnectStore;
  images: {
    /**
     * Stores the image under the sha256 of its bytes unless that row exists already (rows are
     * never changed). `created` is false when the image was stored before.
     */
    add(i: ImageInput, at?: Date): { image: ImageMeta; created: boolean };
    /** The row without its bytes. */
    meta(sha256: string): ImageMeta | undefined;
    get(sha256: string): StoredImage | undefined;
  };
}

const toOwnerDraft = (r: Row): OwnerDraft => ({
  id: r.id as number,
  at: r.at as string,
  label: (r.label as string | null) ?? null,
  ref: (r.ref as string | null) ?? null,
  text: r.text as string,
  status: r.status as OwnerDraftStatus,
  error: (r.error as string | null) ?? null,
});

const toInboxMessage = (r: Row): InboxMessage => ({
  id: r.id as number,
  updateId: r.update_id as number,
  messageId: r.message_id as number,
  at: r.at as string,
  text: r.text as string,
  replyToMessageId: (r.reply_to_message_id as number | null) ?? null,
  draftId: (r.draft_id as number | null) ?? null,
  draftRef: (r.draft_ref as string | null) ?? null,
  draftLabel: (r.draft_label as string | null) ?? null,
  kind: r.kind as InboxKind,
  mediaGroupId: (r.media_group_id as string | null) ?? null,
});

const toInboxFileMeta = (r: Row): InboxFileMeta => ({
  idx: r.idx as number,
  mime: (r.mime as string | null) ?? null,
  width: (r.width as number | null) ?? null,
  height: (r.height as number | null) ?? null,
});

const toImageMeta = (r: Row): ImageMeta => ({
  sha256: r.sha256 as string,
  mime: r.mime as ImageMeta['mime'],
  size: r.size as number,
  width: r.width as number,
  height: r.height as number,
  createdAt: r.created_at as string,
});

function assertUsd(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
}

export interface OpenStoreOptions {
  migrationsDir?: string;
}

/** Opens (creating if needed) the SQLite file, enables WAL, runs migrations. */
export function openStore(file: string, opts: OpenStoreOptions = {}): Store {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    const migrationsApplied = runMigrations(db, opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
    return build(db, migrationsApplied);
  } catch (e) {
    db.close();
    throw e;
  }
}

function build(db: Database.Database, migrationsApplied: string[]): Store {
  const getPub = db.prepare('SELECT * FROM publications WHERE key = ?');
  const publication = (key: string): Publication | undefined => {
    const r = getPub.get(key) as Row | undefined;
    return r ? toPub(r) : undefined;
  };
  const transition = (
    key: string,
    status: PublicationStatus,
    set: { messageId?: string; error?: string; sentAt?: string },
  ): Publication => {
    const res = db
      .prepare(
        `UPDATE publications SET status = @status,
           message_id = COALESCE(@messageId, message_id),
           error = COALESCE(@error, error),
           sent_at = COALESCE(@sentAt, sent_at)
         WHERE key = @key AND status = 'intent'`,
      )
      .run({
        key,
        status,
        messageId: set.messageId ?? null,
        error: set.error ?? null,
        sentAt: set.sentAt ?? null,
      });
    const p = publication(key);
    if (!p) throw new Error(`publication "${key}" not found`);
    if (res.changes === 0) {
      throw new Error(`publication "${key}" is ${p.status}, expected intent`);
    }
    return p;
  };

  const store: Store = {
    db,
    migrationsApplied,
    ping() {
      try {
        return db.prepare('SELECT 1 AS ok').get() !== undefined;
      } catch {
        return false;
      }
    },
    close() {
      if (db.open) db.close();
    },
    plans: {
      upsert(p, at = new Date()) {
        // A reject is never undone by a write (WP-SVC-09 review I-2): rejected stays rejected.
        const ts = at.toISOString();
        db.prepare(
          `INSERT INTO plans (date, status, json, md, created_at, input_sha256, updated_at)
           VALUES (@date, @status, @json, @md, @ts, @inputSha256, @ts)
           ON CONFLICT(date) DO UPDATE SET
             status = CASE WHEN plans.status = 'rejected' THEN plans.status
                           ELSE excluded.status END,
             json = excluded.json, md = excluded.md, input_sha256 = excluded.input_sha256,
             updated_at = excluded.updated_at`,
        ).run({ ...p, inputSha256: p.inputSha256 ?? null, ts });
        return store.plans.get(p.date) as Plan;
      },
      get(date) {
        const r = db.prepare('SELECT * FROM plans WHERE date = ?').get(date) as Row | undefined;
        return r ? toPlan(r) : undefined;
      },
      setStatus(date, status) {
        const res = db
          .prepare(
            `UPDATE plans SET status = @status
             WHERE date = @date AND (status <> 'rejected' OR @status = 'rejected')`,
          )
          .run({ status, date });
        if (res.changes === 0) {
          if (store.plans.get(date)) throw new PlanRejected(date);
          throw new Error(`plan "${date}" not found`);
        }
      },
      setContent(date, c, at = new Date()) {
        const res = db
          .prepare('UPDATE plans SET json = ?, md = ?, updated_at = ? WHERE date = ?')
          .run(c.json, c.md, at.toISOString(), date);
        if (res.changes === 0) throw new Error(`plan "${date}" not found`);
      },
      listBefore(date, limit) {
        return (
          db
            .prepare(
              `SELECT * FROM plans WHERE date < ? AND status NOT IN ('rejected', 'failed')
               ORDER BY date DESC LIMIT ?`,
            )
            .all(date, limit) as Row[]
        ).map(toPlan);
      },
    },
    slots: {
      replaceForPlan(planDate, slots) {
        db.transaction(() => {
          db.prepare('DELETE FROM slots WHERE plan_date = ?').run(planDate);
          const ins = db.prepare(
            'INSERT INTO slots (plan_date, slot_id, at, kind, json) VALUES (?, ?, ?, ?, ?)',
          );
          for (const s of slots) ins.run(planDate, s.slotId, s.at, s.kind, s.json);
        })();
      },
      setStatus(planDate, slotId, status) {
        const res = db
          .prepare('UPDATE slots SET status = ? WHERE plan_date = ? AND slot_id = ?')
          .run(status, planDate, slotId);
        if (res.changes === 0) throw new Error(`slot "${planDate}/${slotId}" not found`);
      },
      setJson(planDate, slotId, json, at) {
        const res =
          at === undefined
            ? db
                .prepare('UPDATE slots SET json = ? WHERE plan_date = ? AND slot_id = ?')
                .run(json, planDate, slotId)
            : db
                .prepare('UPDATE slots SET json = ?, at = ? WHERE plan_date = ? AND slot_id = ?')
                .run(json, at, planDate, slotId);
        if (res.changes === 0) throw new Error(`slot "${planDate}/${slotId}" not found`);
      },
      listForPlan(planDate) {
        return (
          db
            .prepare('SELECT * FROM slots WHERE plan_date = ? ORDER BY at, slot_id')
            .all(planDate) as Row[]
        ).map(toSlot);
      },
    },
    slotVariants: {
      replaceForPlan(planDate, variants) {
        db.transaction(() => {
          db.prepare('DELETE FROM slot_variants WHERE plan_date = ?').run(planDate);
          const ins = db.prepare(
            `INSERT INTO slot_variants (plan_date, slot_id, platform, lang, at, json)
             VALUES (?, ?, ?, ?, ?, ?)`,
          );
          for (const v of variants) ins.run(planDate, v.slotId, v.platform, v.lang, v.at, v.json);
        })();
      },
      listForPlan(planDate) {
        const rows = (
          db
            .prepare(
              `SELECT * FROM slot_variants WHERE plan_date = ?
               ORDER BY slot_id, platform, lang`,
            )
            .all(planDate) as Row[]
        ).map(toSlotVariant);
        // By instant, not by the `at` string: seconds are optional in it. The sort is stable, so
        // equal instants stay in slot, platform, language order.
        return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      },
      setStatus(planDate, slotId, platform, lang, status) {
        const res = db
          .prepare(
            `UPDATE slot_variants SET status = ?
             WHERE plan_date = ? AND slot_id = ? AND platform = ? AND lang = ?`,
          )
          .run(status, planDate, slotId, platform, lang);
        if (res.changes === 0) {
          throw new Error(`variant "${planDate}/${slotId}/${platform}/${lang}" not found`);
        }
      },
    },
    publications: {
      beginIntent(i, at = new Date()) {
        const { expectSlotJson, ...row } = i;
        const params = { ...row, part: i.part ?? 0, createdAt: at.toISOString() };
        try {
          if (expectSlotJson === undefined) {
            db.prepare(
              `INSERT INTO publications (key, platform, plan_date, slot_id, part, status, text_sha256, created_at)
               VALUES (@key, @platform, @planDate, @slotId, @part, 'intent', @textSha256, @createdAt)`,
            ).run(params);
          } else {
            // One statement: the check and the insert cannot be separated by another writer.
            const res = db
              .prepare(
                `INSERT INTO publications (key, platform, plan_date, slot_id, part, status, text_sha256, created_at)
                 SELECT @key, @platform, @planDate, @slotId, @part, 'intent', @textSha256, @createdAt
                 WHERE EXISTS (
                   SELECT 1 FROM slots s JOIN plans p ON p.date = s.plan_date
                   WHERE s.plan_date = @planDate AND s.slot_id = @slotId
                     AND s.status = 'planned' AND s.json = @expectSlotJson
                     AND p.status = 'approved')`,
              )
              .run({ ...params, expectSlotJson });
            if (res.changes === 0) throw new SlotNotClaimable(i.key);
          }
        } catch (e) {
          if (isUniqueViolation(e)) throw new AlreadyExists(i.key);
          throw e;
        }
        return publication(i.key) as Publication;
      },
      beginVariantIntent(i, at = new Date()) {
        try {
          // One statement, as `beginIntent` with `expectSlotJson`, against the variant row.
          const res = db
            .prepare(
              `INSERT INTO publications (key, platform, plan_date, slot_id, part, status, text_sha256, created_at)
               SELECT @key, @platform, @planDate, @slotId, @part, 'intent', @textSha256, @createdAt
               WHERE EXISTS (
                 SELECT 1 FROM slot_variants v JOIN plans p ON p.date = v.plan_date
                 WHERE v.plan_date = @planDate AND v.slot_id = @slotId
                   AND v.platform = @platform AND v.lang = @lang
                   AND v.status = 'planned' AND v.json = @expectVariantJson
                   AND p.status = 'approved')`,
            )
            .run({ ...i, part: i.part ?? 0, createdAt: at.toISOString() });
          if (res.changes === 0) throw new VariantNotClaimable(i.key);
        } catch (e) {
          if (isUniqueViolation(e)) throw new AlreadyExists(i.key);
          throw e;
        }
        return publication(i.key) as Publication;
      },
      beginCommentIntent(i, at = new Date()) {
        try {
          const res = db
            .prepare(
              `INSERT INTO publications (key, platform, plan_date, slot_id, part, status, text_sha256, created_at)
               SELECT @key, @platform, @planDate, @slotId, @part, 'intent', @textSha256, @createdAt
               WHERE EXISTS (
                 SELECT 1 FROM publications post
                   JOIN plans p ON p.date = post.plan_date
                   JOIN slot_variants v ON v.plan_date = post.plan_date AND v.slot_id = post.slot_id
                 WHERE post.key = @postKey AND post.status = 'sent'
                   AND post.plan_date = @planDate AND post.slot_id = @slotId
                   AND post.platform = @platform
                   AND v.platform = @platform AND v.lang = @lang AND v.status = 'planned'
                   AND p.status = 'approved')`,
            )
            .run({ ...i, createdAt: at.toISOString() });
          if (res.changes === 0) throw new VariantNotClaimable(i.key);
        } catch (e) {
          if (isUniqueViolation(e)) throw new AlreadyExists(i.key);
          throw e;
        }
        return publication(i.key) as Publication;
      },
      setStep(key, step) {
        const res = db
          .prepare(`UPDATE publications SET step = ? WHERE key = ? AND status = 'intent'`)
          .run(step, key);
        if (res.changes === 0) throw new Error(`publication "${key}" is not an intent`);
      },
      markPosted(key, post, at = new Date()) {
        const res = db
          .prepare(
            `UPDATE publications SET status = 'sent', message_id = @id, url = @url, sent_at = @sentAt
             WHERE key = @key AND status = 'intent'`,
          )
          .run({ key, id: post.id, url: post.url ?? null, sentAt: at.toISOString() });
        const p = publication(key);
        if (!p) throw new Error(`publication "${key}" not found`);
        if (res.changes === 0)
          throw new Error(`publication "${key}" is ${p.status}, expected intent`);
        return p;
      },
      get: publication,
      markSent: (key, messageId, at = new Date()) =>
        transition(key, 'sent', { messageId, sentAt: at.toISOString() }),
      markDry: (key, at = new Date()) => transition(key, 'dry', { sentAt: at.toISOString() }),
      markFailed: (key, error) => transition(key, 'failed', { error }),
      markUnknown: (key, error) => transition(key, 'unknown', error ? { error } : {}),
      listStaleIntents(olderThanMs, now = new Date(), platform) {
        const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
        return (
          db
            .prepare(
              `SELECT * FROM publications WHERE status = 'intent' AND created_at < @cutoff
                 AND (@platform IS NULL OR platform = @platform)
               ORDER BY created_at, key`,
            )
            .all({ cutoff, platform: platform ?? null }) as Row[]
        ).map(toPub);
      },
      markStaleIntentsUnknown(olderThanMs, now = new Date(), platform) {
        const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
        return db
          .prepare(
            `UPDATE publications SET status = 'unknown',
               error = COALESCE(error, 'intent left unresolved')
             WHERE status = 'intent' AND created_at < @cutoff
               AND (@platform IS NULL OR platform = @platform)`,
          )
          .run({ cutoff, platform: platform ?? null }).changes;
      },
      listForPlan(planDate) {
        return (
          db
            .prepare('SELECT * FROM publications WHERE plan_date = ? ORDER BY slot_id, part, key')
            .all(planDate) as Row[]
        ).map(toPub);
      },
      listForSlot(planDate, slotId, platform) {
        return (
          db
            .prepare(
              `SELECT * FROM publications WHERE plan_date = @planDate AND slot_id = @slotId
                 AND (@platform IS NULL OR platform = @platform)
               ORDER BY part, key`,
            )
            .all({ planDate, slotId, platform: platform ?? null }) as Row[]
        ).map(toPub);
      },
    },
    feedback: {
      add(f, at = new Date()) {
        const res = db
          .prepare(
            'INSERT INTO feedback (plan_date, slot_id, verdict, note, at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(f.planDate, f.slotId ?? null, f.verdict, f.note ?? null, at.toISOString());
        return toFeedback(
          db.prepare('SELECT * FROM feedback WHERE id = ?').get(res.lastInsertRowid) as Row,
        );
      },
      listForPlan(planDate) {
        return (
          db
            .prepare('SELECT * FROM feedback WHERE plan_date = ? ORDER BY id')
            .all(planDate) as Row[]
        ).map(toFeedback);
      },
      listSince(from) {
        return (
          db
            .prepare('SELECT * FROM feedback WHERE at >= ? ORDER BY at, id')
            .all(from.toISOString()) as Row[]
        ).map(toFeedback);
      },
    },
    feedEntries: {
      upsert(e) {
        if (e.private) throw new Error(`feed entry "${e.id}" is private and cannot be stored`);
        db.prepare(
          `INSERT INTO feed_entries (id, source, url, title, summary, published_at, fetched_at)
           VALUES (@id, @source, @url, @title, @summary, @publishedAt, @fetchedAt)
           ON CONFLICT(id) DO UPDATE SET source = excluded.source, url = excluded.url,
             title = excluded.title, summary = excluded.summary,
             published_at = excluded.published_at, fetched_at = excluded.fetched_at`,
        ).run({
          id: e.id,
          source: e.source,
          url: e.url ?? null,
          title: e.title,
          summary: e.summary ?? null,
          publishedAt: e.publishedAt ?? null,
          fetchedAt: nowIso(),
        });
      },
      recent(limit) {
        return (
          db
            .prepare('SELECT * FROM feed_entries ORDER BY fetched_at DESC, id LIMIT ?')
            .all(limit) as Row[]
        ).map(toFeedEntry);
      },
      getMany(ids) {
        if (!ids.length) return [];
        return (
          db
            .prepare('SELECT * FROM feed_entries WHERE id IN (SELECT value FROM json_each(?))')
            .all(JSON.stringify([...new Set(ids)])) as Row[]
        ).map(toFeedEntry);
      },
    },
    jobRuns: {
      claim(job, date, at = new Date()) {
        const res = db
          .prepare('INSERT OR IGNORE INTO job_runs (job, date, at) VALUES (?, ?, ?)')
          .run(job, date, at.toISOString());
        return res.changes === 1;
      },
      finish(job, date, result) {
        db.prepare('UPDATE job_runs SET result = ? WHERE job = ? AND date = ?').run(
          result,
          job,
          date,
        );
      },
      get(job, date) {
        return db
          .prepare('SELECT at, result FROM job_runs WHERE job = ? AND date = ?')
          .get(job, date) as { at: string; result: string | null } | undefined;
      },
    },
    spend: {
      add(usd, at = new Date()) {
        if (!Number.isFinite(usd) || usd < 0)
          throw new Error('spend must be a non-negative number');
        db.prepare(
          `INSERT INTO llm_spend (day, usd) VALUES (?, ?)
           ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd`,
        ).run(mskDay(at), usd);
      },
      forDay(day) {
        const r = db.prepare('SELECT usd FROM llm_spend WHERE day = ?').get(day) as
          { usd: number } | undefined;
        return r?.usd ?? 0;
      },
      today: (now = new Date()) => store.spend.forDay(mskDay(now)),
      reserve(estimate, cap, at = new Date()) {
        assertUsd('estimate', estimate);
        assertUsd('cap', cap);
        const day = mskDay(at);
        const tx = db.transaction((): Reservation => {
          const spent = store.spend.forDay(day);
          // Small epsilon: 0.9 + 0.1 must fit a cap of 1 despite float rounding.
          if (spent + estimate > cap + 1e-9) return { ok: false, day, spent };
          store.spend.add(estimate, at);
          return { ok: true, day, spent };
        });
        return tx.immediate();
      },
      settle(day, estimate, actual) {
        assertUsd('estimate', estimate);
        assertUsd('actual', actual);
        db.prepare(
          `INSERT INTO llm_spend (day, usd) VALUES (@day, MAX(0, @delta))
           ON CONFLICT(day) DO UPDATE SET usd = MAX(0, usd + @delta)`,
        ).run({ day, delta: actual - estimate });
      },
    },
    alerts: {
      add(a, at = new Date()) {
        const res = db
          .prepare('INSERT INTO alerts (at, kind, message) VALUES (?, ?, ?)')
          .run(at.toISOString(), a.kind, a.message);
        return toAlert(
          db.prepare('SELECT * FROM alerts WHERE id = ?').get(res.lastInsertRowid) as Row,
        );
      },
      list(limit = 100) {
        return (db.prepare('SELECT * FROM alerts ORDER BY id LIMIT ?').all(limit) as Row[]).map(
          toAlert,
        );
      },
      listSince(since, limit = 500) {
        return (
          db
            .prepare('SELECT * FROM alerts WHERE at > ? ORDER BY id LIMIT ?')
            .all(since.toISOString(), limit) as Row[]
        ).map(toAlert);
      },
    },
    ownerDrafts: {
      add(d, at = new Date()) {
        const res = db
          .prepare(
            'INSERT INTO owner_drafts (at, label, ref, text, status, error) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(at.toISOString(), d.label ?? null, d.ref ?? null, d.text, d.status, d.error ?? null);
        return toOwnerDraft(
          db.prepare('SELECT * FROM owner_drafts WHERE id = ?').get(res.lastInsertRowid) as Row,
        );
      },
      setStatus(id, status, error = null) {
        db.prepare('UPDATE owner_drafts SET status = ?, error = ? WHERE id = ?').run(
          status,
          error,
          id,
        );
      },
      addPart(draftId, part, messageId) {
        db.prepare(
          'INSERT INTO owner_draft_parts (draft_id, part, message_id) VALUES (?, ?, ?)',
        ).run(draftId, part, messageId);
      },
      get(id) {
        const r = db.prepare('SELECT * FROM owner_drafts WHERE id = ?').get(id) as Row | undefined;
        return r ? toOwnerDraft(r) : undefined;
      },
      byMessageId(messageId) {
        const r = db
          .prepare(
            `SELECT d.* FROM owner_drafts d
               JOIN owner_draft_parts p ON p.draft_id = d.id WHERE p.message_id = ?`,
          )
          .get(messageId) as Row | undefined;
        return r ? toOwnerDraft(r) : undefined;
      },
      messageIds(id) {
        return (
          db
            .prepare('SELECT message_id FROM owner_draft_parts WHERE draft_id = ? ORDER BY part')
            .all(id) as Row[]
        ).map((r) => r.message_id as number);
      },
    },
    inbox: {
      add(m) {
        const res = db
          .prepare(
            `INSERT OR IGNORE INTO owner_inbox
               (update_id, message_id, at, text, reply_to_message_id, draft_id, kind,
                media_group_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            m.updateId,
            m.messageId,
            m.at,
            m.text,
            m.replyToMessageId ?? null,
            m.draftId ?? null,
            m.kind,
            m.mediaGroupId ?? null,
          );
        if (res.changes === 0) return false;
        const file = db.prepare(
          `INSERT INTO owner_inbox_files
             (inbox_id, idx, file_id, file_unique_id, mime, width, height)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const f of m.files ?? []) {
          file.run(res.lastInsertRowid, f.idx, f.fileId, f.fileUniqueId, f.mime, f.width, f.height);
        }
        return true;
      },
      fileMeta(inboxIds) {
        const out = new Map<number, InboxFileMeta[]>();
        if (inboxIds.length === 0) return out;
        const rows = db
          .prepare(
            `SELECT inbox_id, idx, mime, width, height FROM owner_inbox_files
              WHERE inbox_id IN (SELECT value FROM json_each(?)) ORDER BY inbox_id, idx`,
          )
          .all(JSON.stringify(inboxIds)) as Row[];
        for (const r of rows) {
          const id = r.inbox_id as number;
          out.set(id, [...(out.get(id) ?? []), toInboxFileMeta(r)]);
        }
        return out;
      },
      file(inboxId, idx) {
        const r = db
          .prepare('SELECT * FROM owner_inbox_files WHERE inbox_id = ? AND idx = ?')
          .get(inboxId, idx) as Row | undefined;
        if (!r) return undefined;
        return {
          ...toInboxFileMeta(r),
          inboxId: r.inbox_id as number,
          fileId: r.file_id as string,
          fileUniqueId: r.file_unique_id as string,
        };
      },
      listAfter(id, limit = 500) {
        return (
          db
            .prepare(
              `SELECT i.*, d.ref AS draft_ref, d.label AS draft_label
                 FROM owner_inbox i LEFT JOIN owner_drafts d ON d.id = i.draft_id
                WHERE i.id > ? ORDER BY i.id LIMIT ?`,
            )
            .all(id, limit) as Row[]
        ).map(toInboxMessage);
      },
    },
    botState: {
      get(key) {
        const r = db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as
          Row | undefined;
        return r ? (r.value as string) : undefined;
      },
      set(key, value) {
        db.prepare(
          `INSERT INTO bot_state (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(key, value);
      },
    },
    connect: buildConnectStore(db),
    images: {
      add(i, at = new Date()) {
        const sha256 = createHash('sha256').update(i.bytes).digest('hex');
        const res = db
          .prepare(
            // Only the key conflict is silent (the image is there already); a CHECK fails loudly.
            `INSERT INTO images (sha256, mime, bytes, size, width, height, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`,
          )
          .run(sha256, i.mime, i.bytes, i.bytes.length, i.width, i.height, at.toISOString());
        return { image: store.images.meta(sha256) as ImageMeta, created: res.changes > 0 };
      },
      meta(sha256) {
        const r = db
          .prepare(
            'SELECT sha256, mime, size, width, height, created_at FROM images WHERE sha256 = ?',
          )
          .get(sha256) as Row | undefined;
        return r ? toImageMeta(r) : undefined;
      },
      get(sha256) {
        const r = db.prepare('SELECT * FROM images WHERE sha256 = ?').get(sha256) as
          Row | undefined;
        return r ? { ...toImageMeta(r), bytes: r.bytes as Buffer } : undefined;
      },
    },
  };
  return store;
}
