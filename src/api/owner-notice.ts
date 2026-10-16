import type { Store } from '../store/index.js';
import { sendWithRetry } from '../telegram/bot-api.js';
import { ownerTarget, type OwnerDeps } from './director.js';

// A message the service itself sends to the owner's private chat (WP-PLAT-02: the LinkedIn token
// expiry reminder). It goes through the one guard of every write to OWNER_CHAT_ID (`ownerTarget`:
// configured, a private chat with that very id, never the channel) and is recorded like a draft,
// so the owner's reply to it shows up in `GET /v1/inbox` with its `ref`. One plain message, no
// parse mode, link previews off. It never writes a publication row and never touches the channel.

const TG_TEXT_LIMIT = 4096;

export type OwnerNoticeResult =
  { ok: true; draftId: number; messageId: number } | { ok: false; error: string };

export async function sendOwnerNotice(
  store: Pick<Store, 'ownerDrafts'>,
  owner: OwnerDeps | undefined,
  n: { text: string; label?: string; ref?: string },
): Promise<OwnerNoticeResult> {
  const text = n.text.trim();
  if (text === '' || text.length > TG_TEXT_LIMIT) {
    return { ok: false, error: 'the notice is empty or longer than one message' };
  }
  const g = await ownerTarget(owner);
  if (!g.ok) return { ok: false, error: g.error };
  const o = g.o;
  const scrub = (x: string) => (o.scrub ? o.scrub(x) : x);
  const draft = store.ownerDrafts.add({ label: n.label, ref: n.ref, text, status: 'partial' });
  const r = await sendWithRetry<{ message_id: number }>(
    o.api,
    'sendMessage',
    { chat_id: o.chatId, text, link_preview_options: { is_disabled: true } },
    { ...(o.sleep ? { sleep: o.sleep } : {}), ...o.retry },
  );
  if (!r.ok) {
    const error = scrub(`sendMessage: ${r.outcome}: ${r.description}`).slice(0, 1000);
    store.ownerDrafts.setStatus(draft.id, 'failed', error);
    return { ok: false, error };
  }
  store.ownerDrafts.addPart(draft.id, 0, r.result.message_id);
  store.ownerDrafts.setStatus(draft.id, 'sent');
  return { ok: true, draftId: draft.id, messageId: r.result.message_id };
}
