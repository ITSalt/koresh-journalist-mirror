import type { BotApi } from './bot-api.js';

// D-16/D-17: `/ready` reports whether the channel has a linked discussion group
// (`getChat(TELEGRAM_CHANNEL).linked_chat_id`). Nothing is posted there (D-17).

export interface ChannelProbe {
  checkedAt: string;
  /** getChat answered. */
  ok: boolean;
  /** `present` / `absent` when getChat answered. */
  linkedChatId?: 'present' | 'absent';
  detail: string;
}

export async function probeChannel(
  api: BotApi,
  channel: string,
  o: { now?: () => Date; scrub?: (s: string) => string } = {},
): Promise<ChannelProbe> {
  const checkedAt = (o.now ?? (() => new Date()))().toISOString();
  const r = await api.call<{ type?: string; linked_chat_id?: number }>('getChat', {
    chat_id: channel,
  });
  if (!r.ok) {
    const d = o.scrub ? o.scrub(r.description) : r.description;
    return { checkedAt, ok: false, detail: `getChat failed: ${d}` };
  }
  const linked = typeof r.result?.linked_chat_id === 'number' ? 'present' : 'absent';
  return {
    checkedAt,
    ok: true,
    linkedChatId: linked,
    detail: `getChat ok: type=${r.result?.type ?? '?'}, linked_chat_id ${linked}`,
  };
}
