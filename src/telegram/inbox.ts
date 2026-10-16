// Owner inbox poller: reads the owner's private messages to the bot with getUpdates.
//
// Only a message from the owner in their private chat is stored. Everything else (strangers,
// groups, channel posts, other update kinds) is dropped: no row, no reply, and only a count in the
// log (never text or ids). The rows of one batch and the new offset are written in one
// transaction, so a restart neither loses nor repeats an update. deleteWebhook is never called:
// on a conflict (another poller or a webhook) the poller backs off and writes one alert.
//
// A photo (its largest size) or an image document (JPEG, PNG, WebP) of the owner is kept as a
// Telegram file reference next to its row, never as bytes; the director fetches the bytes on
// demand (GET /v1/owner/inbox/<id>/files/<idx>). An album arrives as one message per picture;
// they share `media_group_id`. File ids, captions and texts never reach a log line.

import type { BotApi } from './bot-api.js';
import type { InboxFileInput, InboxKind, Store } from '../store/index.js';

export const OFFSET_KEY = 'tg_updates_offset';
/** Long-poll seconds; below the API client's 30 s request timeout. */
export const POLL_TIMEOUT_S = 25;

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** Auth / not-found errors will not fix themselves soon: wait long. */
const FATAL_BACKOFF_MS = 10 * 60_000;
const CONFLICT_BACKOFF_MIN_MS = 30_000;
const CONFLICT_BACKOFF_MAX_MS = 10 * 60_000;
/** At most one inbox_conflict alert per this long. */
export const CONFLICT_ALERT_EVERY_MS = 60 * 60_000;

interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface InboxPollerDeps {
  api: BotApi;
  store: Pick<Store, 'db' | 'inbox' | 'ownerDrafts' | 'botState' | 'alerts'>;
  ownerChatId: number;
  log: Logger;
  scrub?: (s: string) => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface InboxStatus {
  enabled: true;
  lastPollAt?: string;
  lastError?: string;
}

export type PollOutcome = 'ok' | 'conflict' | 'fatal' | 'error';

export interface InboxPoller {
  start(): void;
  /** For /ready: never makes the service not-ready. */
  status(): InboxStatus;
  stop(): Promise<void>;
  /** One getUpdates round; the loop calls it. Exposed for tests. */
  pollOnce(): Promise<{ outcome: PollOutcome; waitMs: number }>;
}

interface TgMessage {
  message_id?: unknown;
  date?: unknown;
  text?: unknown;
  caption?: unknown;
  chat?: { id?: unknown; type?: unknown };
  from?: { id?: unknown };
  reply_to_message?: { message_id?: unknown };
  photo?: unknown;
  document?: unknown;
  media_group_id?: unknown;
}
interface TgUpdate {
  update_id?: unknown;
  message?: TgMessage;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';
const size = (v: unknown): number | null => (isInt(v) && v > 0 ? v : null);

/** The image types an inbox document is kept for; anything else stays kind 'other'. */
export const INBOX_IMAGE_MIMES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * The file of a message worth keeping: the largest size of a photo, or an image document.
 * `undefined` for everything else (a sticker, a voice, a PDF, a photo without usable ids).
 */
export function inboxFilesOf(m: {
  photo?: unknown;
  document?: unknown;
}): { kind: Extract<InboxKind, 'photo' | 'document'>; files: InboxFileInput[] } | undefined {
  if (Array.isArray(m.photo)) {
    const sizes = m.photo.filter(
      (p): p is Record<string, unknown> =>
        isRecord(p) && nonEmpty(p.file_id) && nonEmpty(p.file_unique_id),
    );
    // Telegram lists the sizes smallest first; the pixel count decides, then the byte size.
    const area = (p: Record<string, unknown>) => (size(p.width) ?? 0) * (size(p.height) ?? 0);
    const largest = sizes.reduce<Record<string, unknown> | undefined>((best, p) => {
      if (!best) return p;
      if (area(p) !== area(best)) return area(p) > area(best) ? p : best;
      return (size(p.file_size) ?? 0) >= (size(best.file_size) ?? 0) ? p : best;
    }, undefined);
    if (largest) {
      return {
        kind: 'photo',
        files: [
          {
            idx: 0,
            fileId: largest.file_id as string,
            fileUniqueId: largest.file_unique_id as string,
            // A photo message does not say its type; the download reads it from the bytes.
            mime: null,
            width: size(largest.width),
            height: size(largest.height),
          },
        ],
      };
    }
  }
  const d = m.document;
  if (isRecord(d) && nonEmpty(d.file_id) && nonEmpty(d.file_unique_id)) {
    const mime = typeof d.mime_type === 'string' ? d.mime_type.trim().toLowerCase() : '';
    if (INBOX_IMAGE_MIMES.includes(mime)) {
      return {
        kind: 'document',
        // A document carries no pixel size of its own (only of its thumbnail).
        files: [
          {
            idx: 0,
            fileId: d.file_id,
            fileUniqueId: d.file_unique_id,
            mime,
            width: null,
            height: null,
          },
        ],
      };
    }
  }
  return undefined;
}

export function createInboxPoller(d: InboxPollerDeps): InboxPoller {
  const scrub = d.scrub ?? ((s: string) => s);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let running = false;
  let closed = false;
  let loop: Promise<void> | undefined;
  let wake: () => void = () => undefined;
  const stopped = new Promise<'stop'>((r) => {
    wake = () => r('stop');
  });
  let failures = 0;
  let conflicts = 0;
  let lastAlertAt = -Infinity;
  const now = d.now ?? (() => new Date());
  let lastPollAt: string | undefined;
  let lastError: string | undefined;

  const readOffset = (): number | undefined => {
    const v = d.store.botState.get(OFFSET_KEY);
    const n = v === undefined ? NaN : Number(v);
    return Number.isSafeInteger(n) ? n : undefined;
  };

  const errorWait = () =>
    Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(failures - 1, 10));

  function handle(updates: TgUpdate[]): { stored: number; dropped: number } {
    let stored = 0;
    let dropped = 0;
    let maxId: number | undefined;
    const tx = d.store.db.transaction(() => {
      for (const u of updates) {
        if (!isInt(u.update_id)) {
          dropped++;
          continue;
        }
        maxId = maxId === undefined ? u.update_id : Math.max(maxId, u.update_id);
        const m = u.message;
        if (
          !m ||
          m.chat?.type !== 'private' ||
          m.chat.id !== d.ownerChatId ||
          m.from?.id !== d.ownerChatId ||
          !isInt(m.message_id)
        ) {
          dropped++;
          continue;
        }
        const text = typeof m.text === 'string' ? m.text : undefined;
        const caption = typeof m.caption === 'string' ? m.caption : '';
        const replyTo = isInt(m.reply_to_message?.message_id)
          ? m.reply_to_message.message_id
          : null;
        const draft = replyTo === null ? undefined : d.store.ownerDrafts.byMessageId(replyTo);
        const at = isInt(m.date) ? new Date(m.date * 1000) : new Date();
        const media = text === undefined ? inboxFilesOf(m) : undefined;
        const added = d.store.inbox.add({
          updateId: u.update_id,
          messageId: m.message_id,
          at: at.toISOString(),
          text: text ?? caption,
          replyToMessageId: replyTo,
          draftId: draft?.id ?? null,
          kind: text !== undefined ? 'text' : (media?.kind ?? 'other'),
          mediaGroupId: nonEmpty(m.media_group_id) ? m.media_group_id : null,
          ...(media ? { files: media.files } : {}),
        });
        if (added) stored++;
      }
      if (maxId !== undefined) d.store.botState.set(OFFSET_KEY, String(maxId + 1));
    });
    tx.immediate();
    return { stored, dropped };
  }

  async function pollOnce(): Promise<{ outcome: PollOutcome; waitMs: number }> {
    const offset = readOffset();
    const r = await d.api.call<TgUpdate[]>('getUpdates', {
      ...(offset !== undefined ? { offset } : {}),
      timeout: POLL_TIMEOUT_S,
      allowed_updates: ['message'],
    });
    // The store may be closed by now (stop() does not wait for a long poll).
    if (closed) return { outcome: 'ok', waitMs: 0 };
    if (r.ok) {
      failures = 0;
      conflicts = 0;
      lastPollAt = now().toISOString();
      lastError = undefined;
      const updates = Array.isArray(r.result) ? r.result : [];
      if (updates.length > 0) {
        const { stored, dropped } = handle(updates);
        d.log.info({ stored, dropped }, 'owner inbox: updates handled');
      }
      return { outcome: 'ok', waitMs: 0 };
    }
    failures++;
    const status = 'status' in r ? r.status : undefined;
    lastPollAt = now().toISOString();
    lastError = scrub(`${r.kind}${status ? ` ${status}` : ''}`);
    if (status === 409) {
      conflicts++;
      if (now().getTime() - lastAlertAt >= CONFLICT_ALERT_EVERY_MS) {
        lastAlertAt = now().getTime();
        d.store.alerts.add({
          kind: 'inbox_conflict',
          message: scrub(
            `getUpdates conflict (another poller or an active webhook): ${r.description}`,
          ).slice(0, 500),
        });
      }
      d.log.warn({ status }, 'owner inbox: getUpdates conflict');
      return {
        outcome: 'conflict',
        waitMs: Math.min(
          CONFLICT_BACKOFF_MAX_MS,
          CONFLICT_BACKOFF_MIN_MS * 2 ** Math.min(conflicts - 1, 10),
        ),
      };
    }
    if (status === 401 || status === 404) {
      d.log.error({ status }, 'owner inbox: the bot token is refused');
      return { outcome: 'fatal', waitMs: FATAL_BACKOFF_MS };
    }
    d.log.warn({ status, kind: r.kind }, 'owner inbox: getUpdates failed');
    return { outcome: 'error', waitMs: errorWait() };
  }

  async function run(): Promise<void> {
    while (running) {
      let waitMs: number;
      try {
        const r = await Promise.race([pollOnce(), stopped]);
        if (r === 'stop') return;
        waitMs = r.waitMs;
      } catch (err) {
        failures++;
        lastError = 'store error';
        d.log.error(
          { err: scrub(String((err as Error)?.message ?? err)) },
          'owner inbox: poll crashed',
        );
        waitMs = errorWait();
      }
      if (running && waitMs > 0 && (await Promise.race([sleep(waitMs), stopped])) === 'stop')
        return;
    }
  }

  return {
    pollOnce,
    status: () => ({
      enabled: true,
      ...(lastPollAt ? { lastPollAt } : {}),
      ...(lastError ? { lastError } : {}),
    }),
    start() {
      if (running || closed) return;
      running = true;
      loop = run();
    },
    async stop() {
      running = false;
      closed = true;
      wake();
      await loop;
    },
  };
}

/** The poller, or undefined (nothing polls) without OWNER_CHAT_ID or without a Bot API client. */
export function inboxPollerFor(
  config: { OWNER_CHAT_ID?: number },
  api: BotApi | undefined,
  deps: Omit<InboxPollerDeps, 'api' | 'ownerChatId'>,
): InboxPoller | undefined {
  if (!config.OWNER_CHAT_ID || !api) return undefined;
  return createInboxPoller({ ...deps, api, ownerChatId: config.OWNER_CHAT_ID });
}
