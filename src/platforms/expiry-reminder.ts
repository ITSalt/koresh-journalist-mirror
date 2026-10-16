import type { Store } from '../store/index.js';
import { expiryReminder, reminderText, type ExpiryReminder } from './linkedin/expiry.js';

// The LinkedIn token expiry reminder (WP-PLAT-02, resubmission 1, item 2). The token of a
// self-serve app lives 60 days and the service cannot renew it, so the owner repeats the consent
// before it ends. This job tells him in his private chat with the bot: once 7 days before, once
// 1 day before, and once when it has ended, each time with a fresh connect link when one can be
// made. He never handles a token (D-5): he opens the link and allows.
//
// Everything outside is a port: where the expiry comes from (the token store of the connected
// account), who makes the link (the account-connect package's `start`), and how a message reaches
// the owner's chat. The job holds no state of its own: what was sent is one `bot_state` value, so
// a restart never sends a reminder twice.

/** `bot_state` key: `sent:<state>|<expiry>` or `failed:<state>|<expiry>` of the last attempt. */
export const LINKEDIN_REMINDER_STATE = 'linkedin_expiry_reminder';

export type SendResult = { ok: true } | { ok: false; error: string };

export interface ExpiryReminderOptions {
  store: Pick<Store, 'botState' | 'alerts'>;
  /** When the LinkedIn token ends (ISO); undefined when no account is connected. */
  expiresAt(): string | undefined;
  /** A fresh one-time connect link for the owner; undefined when it cannot be made now. */
  connectLink?(): { url: string } | undefined | Promise<{ url: string } | undefined>;
  /** Sends one plain message to the owner's private chat. */
  send(text: string): Promise<SendResult>;
  /** The zone the date is shown in (TZ_PLAN). */
  tz?: string;
  scrub?: (s: string) => string;
  now?: () => Date;
}

export type ExpiryReminderTick =
  /** Nothing is due (more than 7 days left, or no token). */
  | { state: 'none'; action: 'nothing' }
  /** This state of this token was told already. */
  | { state: Exclude<ExpiryReminder, 'none'>; action: 'already_sent' }
  | { state: Exclude<ExpiryReminder, 'none'>; action: 'sent'; withLink: boolean }
  /** The message did not reach the owner: tried again on the next tick. */
  | { state: Exclude<ExpiryReminder, 'none'>; action: 'failed'; error: string };

export interface ExpiryReminderJob {
  tick(): Promise<ExpiryReminderTick>;
}

const errorName = (err: unknown) => (err as { name?: string } | null)?.name ?? 'Error';

export function createExpiryReminder(o: ExpiryReminderOptions): ExpiryReminderJob {
  const { store } = o;
  const now = o.now ?? (() => new Date());
  const scrub = (s: string) => (o.scrub ? o.scrub(s) : s).slice(0, 500);

  return {
    async tick() {
      let at: string | undefined;
      try {
        at = o.expiresAt();
      } catch {
        at = undefined;
      }
      const state: ExpiryReminder = at ? expiryReminder(now(), at) : 'none';
      const stored = store.botState.get(LINKEDIN_REMINDER_STATE) ?? '';
      if (state === 'none' || !at) {
        // A fresh token (or none): the next approach of an end starts from the beginning.
        if (stored !== '') store.botState.set(LINKEDIN_REMINDER_STATE, '');
        return { state: 'none', action: 'nothing' };
      }
      // The expiry is part of the mark: a new token that is close to its end is told anew.
      const mark = `${state}|${at}`;
      if (stored === `sent:${mark}`) return { state, action: 'already_sent' };

      let link: string | undefined;
      try {
        link = (await o.connectLink?.())?.url;
      } catch {
        link = undefined; // the message then asks the owner to write to the director
      }
      const text = reminderText(state, at, o.tz ?? 'Europe/Moscow', link) as string;
      let sent: SendResult;
      try {
        sent = await o.send(text);
      } catch (err) {
        sent = { ok: false, error: errorName(err) };
      }
      if (sent.ok) {
        store.botState.set(LINKEDIN_REMINDER_STATE, `sent:${mark}`);
        return { state, action: 'sent', withLink: Boolean(link) };
      }
      const error = scrub(sent.error);
      // One alert per state that could not be told; the send itself is tried again every tick.
      if (stored !== `failed:${mark}`) {
        store.botState.set(LINKEDIN_REMINDER_STATE, `failed:${mark}`);
        store.alerts.add(
          {
            kind: 'expiry_reminder_failed',
            message: `linkedin token ${state} (ends ${at}): the reminder did not reach the owner's chat (${error}); it is tried again with the next check. Send the owner a connect link by hand`,
          },
          now(),
        );
      }
      return { state, action: 'failed', error };
    },
  };
}
