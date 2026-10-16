import { textHash } from '../lib/idempotency.js';
import type { PlanSlot } from '../plan/schema.js';
import type { Store } from '../store/index.js';
import {
  sendPhoto,
  sendWithRetry,
  type BotApi,
  type PhotoMime,
  type RetryOptions,
  type SendResult,
} from '../telegram/bot-api.js';
import {
  composeSlot,
  messageParams,
  photoHash,
  pollHash,
  pollParams,
  RefusedPost,
  type ComposedItem,
} from './compose.js';
import type { Blocks } from './types.js';

// What one slot sends, shared by the publisher, the preview and test-publish, so the three can
// not drift apart: the composed items (`composeSlot`), the stored bytes of the photo, the Bot
// API method, the hash of the publication row and the send itself.

/** A composed item ready to send: a photo carries the stored bytes of its image. */
export type SlotItem =
  | (Extract<ComposedItem, { kind: 'photo' }> & { bytes: Uint8Array; mime: PhotoMime })
  | Exclude<ComposedItem, { kind: 'photo' }>;

export type SendMethod = 'sendPhoto' | 'sendMessage' | 'sendPoll';

/**
 * The items of a slot. Throws `RefusedPost` when the text cannot be composed or when the slot
 * names an image that is not in the store (nothing of such a slot is sent).
 */
export function slotItems(
  store: Pick<Store, 'images'>,
  s: PlanSlot,
  o: { trailer?: string; blocks: Blocks },
): SlotItem[] {
  return composeSlot(s, o).map((item) => {
    if (item.kind !== 'photo') return item;
    const stored = store.images.get(item.image.sha256);
    if (!stored) {
      throw new RefusedPost(
        'image_missing',
        `the image ${item.image.sha256.slice(0, 12)} of the slot is not in the store`,
      );
    }
    return { ...item, bytes: stored.bytes, mime: stored.mime };
  });
}

export const itemMethod = (item: SlotItem): SendMethod =>
  item.kind === 'photo' ? 'sendPhoto' : item.kind === 'poll' ? 'sendPoll' : 'sendMessage';

/** `text_sha256` of the item's publication row. */
export function itemHash(item: SlotItem, s: PlanSlot): string {
  if (item.kind === 'photo') return photoHash(item.image.sha256, item.caption.raw);
  return item.kind === 'poll' ? pollHash(s.poll!) : textHash(item.part.raw);
}

/** One logical send of an item to `chat` (retries as `sendWithRetry`). */
export function sendItem(
  api: BotApi,
  chat: string,
  item: SlotItem,
  s: PlanSlot,
  retry: RetryOptions,
): Promise<SendResult<{ message_id: number }>> {
  if (item.kind === 'photo') {
    // The caption is rendered MarkdownV2, as a text part is.
    return sendPhoto(api, chat, item.bytes, item.mime, item.caption.escaped, retry, 'MarkdownV2');
  }
  const params = item.kind === 'poll' ? pollParams(chat, s.poll!) : messageParams(chat, item.part);
  return sendWithRetry<{ message_id: number }>(api, itemMethod(item), params, retry);
}
