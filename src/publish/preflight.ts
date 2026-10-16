import type { PlanSlot, SlotImage, VariantPlatform } from '../plan/schema.js';
import { VARIANT_PLATFORMS } from '../plan/schema.js';
import { variantId } from '../plan/variants.js';
import type { PlatformRuntime } from '../platforms/registry.js';
import type { Plan, Publication, SlotVariant, Store } from '../store/index.js';
import type { BotApi, RetryOptions } from '../telegram/bot-api.js';
import { pollParams, RefusedPost } from './compose.js';
import { itemMethod, sendItem, slotItems, type SlotItem } from './items.js';
import { mdv2Problems } from './mdv2-check.js';
import { decideInput, DEFAULT_RULES, PART_GAP_MS } from './publisher.js';
import type { Blocks, DecideOutput } from './types.js';
import { variantDecideInput, variantInput, variantKeyOf, variantsOf } from './variant-publisher.js';

// Scope item 15: pre-flight for the first issue, behind the director's bearer token.
//   previewDay   what the loop would do at `now` for a stored day, with the composed parts of the
//                slot it would publish. Reads only.
//                For a day with variants (WP-PLAT-02) it also shows, per platform, what that
//                platform's loop would do at `now` and every variant that is due, with the text
//                it would send (the stored text inside its frame) and the adapter's `validate`
//                result. A day without variants answers exactly as before.
//   testPublish  composes one slot through the same path and really sends it to TEST_CHANNEL,
//                never to TELEGRAM_CHANNEL; writes no publication row, changes no slot, writes
//                one `test_publish` alert for the audit trail.
// Both build the slot's items with `slotItems`, the function the publisher uses, so a slot with an
// image (WP-SVC-24) shows and sends its photo here exactly as it would go to the channel.

export interface PreflightDeps {
  store: Store;
  blocks: Blocks;
  /** TELEGRAM_CHANNEL. */
  channel: string;
  /** TEST_CHANNEL (D-25): @name or a numeric chat id, e.g. the owner's private chat. */
  testChannel?: string;
  trailer?: string;
  api?: BotApi;
  rules?: { graceMin?: number; minGapMin?: number };
  retry?: RetryOptions;
  scrub?: (s: string) => string;
  sleep?: (ms: number) => Promise<void>;
  /** The platforms outside Telegram (rules, frame, link, `validate`); absent: defaults. */
  platforms?: () => PreviewPlatform[];
}

export type PreviewPlatform = Pick<
  PlatformRuntime,
  'platform' | 'dryRun' | 'validate' | 'rules' | 'frame' | 'link'
> & { adapter?: unknown };

/** One variant that is due at `now`: what its loop would send. */
export interface PreviewVariant {
  /** `<slot>-<lang>`: the id the platform's scheduler uses. */
  id: string;
  slotId: string;
  lang: string;
  at: string;
  /** The publication key of the post. */
  key: string;
  /** The composed text: the stored text inside its frame. */
  text?: string;
  length?: number;
  /** `PublishInput.link`: where the adapter puts it depends on its link mode. */
  link?: string;
  /** The adapter's `validate` result for that input (empty: it would be accepted). */
  issues?: { code: string; message: string }[];
  refused?: { code: string; message: string };
}

export interface PlatformPreview {
  dryRun?: boolean;
  adapter?: 'present' | 'absent';
  /** What the platform's loop would do at `now`; ids are `<slot>-<lang>`. */
  decision?: DecideOutput;
  schedulerError?: { code: string; message: string };
  /** Planned variants whose time has come and that have no publication row, by time. */
  due: PreviewVariant[];
}

export interface PreviewPart {
  index: number;
  kind: 'photo' | 'text' | 'poll';
  /** Rendered MarkdownV2: a text part, or the caption of the photo. */
  text?: string;
  length?: number;
  problems?: string[];
  poll?: Record<string, unknown>;
  /** The photo part: the image it sends. */
  image?: SlotImage;
}

export interface Preview {
  date: string;
  now: string;
  planStatus: string | null;
  decision?: DecideOutput;
  schedulerError?: { code: string; message: string };
  slot?: { id: string; at: string; kind: string; image?: SlotImage; parts: PreviewPart[] };
  refused?: { code: string; message: string };
  /** Only for a day with variants: one entry per platform that has variants that day. */
  variants?: Partial<Record<VariantPlatform, PlatformPreview>>;
}

/** The items of a slot, exactly as the publisher builds them; throws RefusedPost. */
const itemsOf = (d: PreflightDeps, s: PlanSlot): SlotItem[] =>
  slotItems(d.store, s, { trailer: d.trailer, blocks: d.blocks });

/** A rendered text (a text part or a photo caption) with its length and markup problems. */
const rendered = (text: string) => ({ text, length: text.length, problems: mdv2Problems(text) });

function previewPart(d: PreflightDeps, s: PlanSlot, item: SlotItem, index: number): PreviewPart {
  if (item.kind === 'poll') return { index, kind: 'poll', poll: pollParams(d.channel, s.poll!) };
  if (item.kind === 'photo') {
    return { index, kind: 'photo', ...rendered(item.caption.escaped), image: item.image };
  }
  return { index, kind: 'text', ...rendered(item.part.escaped) };
}

const refusal = (err: unknown) =>
  err instanceof RefusedPost
    ? { code: err.code, message: err.message }
    : { code: 'compose_error', message: `${(err as Error)?.name}: ${(err as Error)?.message}` };

/** What each platform's loop would do at `now` with the variants of the day (reads only). */
function previewVariants(
  d: PreflightDeps,
  x: { date: string; plan: Plan; all: SlotVariant[]; pubs: Publication[]; now: Date },
): Preview['variants'] {
  const out: NonNullable<Preview['variants']> = {};
  const runtimes = d.platforms?.() ?? [];
  for (const platform of VARIANT_PLATFORMS) {
    const variants = variantsOf(x.all, platform);
    if (variants.length === 0) continue;
    const rt = runtimes.find((r) => r.platform === platform);
    const p: PlatformPreview = {
      ...(rt ? { dryRun: rt.dryRun, adapter: rt.adapter ? 'present' : 'absent' } : {}),
      due: [],
    };
    out[platform] = p;
    try {
      p.decision = d.blocks.decide(
        variantDecideInput({
          date: x.date,
          plan: x.plan,
          platform,
          variants,
          pubs: x.pubs,
          now: x.now,
          rules: { ...DEFAULT_RULES, ...rt?.rules },
        }),
      );
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string };
      p.schedulerError = { code: e.code ?? e.name ?? 'error', message: e.message ?? '' };
    }
    const keys = new Set(x.pubs.map((row) => row.key));
    for (const v of variants) {
      const key = variantKeyOf(v, 0);
      if (v.status !== 'planned' || keys.has(key) || Date.parse(v.at) > x.now.getTime()) continue;
      const item: PreviewVariant = {
        id: variantId(v.slotId, v.lang),
        slotId: v.slotId,
        lang: v.lang,
        at: v.at,
        key,
      };
      try {
        const input = variantInput(v, { frame: rt?.frame, link: rt?.link });
        item.text = input.text;
        item.length = input.text.length;
        if (input.link) item.link = input.link;
        if (rt) item.issues = rt.validate(input);
      } catch (err) {
        item.refused = refusal(err);
      }
      p.due.push(item);
    }
  }
  return out;
}

export function previewDay(d: PreflightDeps, date: string, now: Date): Preview {
  const { store } = d;
  const plan = store.plans.get(date);
  const out: Preview = { date, now: now.toISOString(), planStatus: plan?.status ?? null };
  if (!plan) return out;
  const slots = store.slots.listForPlan(date);
  const pubs = store.publications.listForPlan(date);
  const all = store.slotVariants.listForPlan(date);
  // The key exists only for a day with variants: a day without them answers as it always did.
  if (all.length > 0) out.variants = previewVariants(d, { date, plan, all, pubs, now });
  try {
    out.decision = d.blocks.decide(
      decideInput({ date, plan, slots, pubs, now, rules: { ...DEFAULT_RULES, ...d.rules } }),
    );
  } catch (err) {
    const e = err as { name?: string; code?: string; message?: string };
    out.schedulerError = { code: e.code ?? e.name ?? 'error', message: e.message ?? '' };
    return out;
  }
  const slot = slots.find((s) => s.slotId === out.decision?.publish);
  if (!slot) return out;
  out.slot = { id: slot.slotId, at: slot.at, kind: slot.kind, parts: [] };
  try {
    const s = JSON.parse(slot.json) as PlanSlot;
    if (s.image) out.slot.image = s.image;
    out.slot.parts = itemsOf(d, s).map((item, index) => previewPart(d, s, item, index));
  } catch (err) {
    out.refused = refusal(err);
  }
  return out;
}

export type TestPublishResult =
  | { status: 200; body: { date: string; slotId: string; chat: string; messageIds: number[] } }
  | { status: 404 | 409 | 422 | 502; body: { error: string; messageIds?: number[] } };

const norm = (c: string) => c.trim().toLowerCase();

/** Resolves a chat (@name or id) to its numeric id with getChat; undefined when it fails. */
async function chatId(api: BotApi, chat: string): Promise<number | undefined> {
  const r = await api.call<{ id?: number }>('getChat', { chat_id: chat });
  return r.ok && typeof r.result?.id === 'number' ? r.result.id : undefined;
}

export async function testPublish(
  d: PreflightDeps,
  date: string,
  slotId: string,
): Promise<TestPublishResult> {
  const scrub = (s: string) => (d.scrub ? d.scrub(s) : s);
  const target = d.testChannel?.trim();
  if (!target) return { status: 409, body: { error: 'TEST_CHANNEL is not set' } };
  if (!d.api) return { status: 409, body: { error: 'TELEGRAM_BOT_TOKEN is not set' } };
  if (norm(target) === norm(d.channel)) {
    return { status: 409, body: { error: 'TEST_CHANNEL is the production channel' } };
  }
  // Compare resolved chat ids (D-25): "@Channel1" and "-100…" may name the same chat.
  const [testId, prodId] = await Promise.all([chatId(d.api, target), chatId(d.api, d.channel)]);
  if (testId === undefined || prodId === undefined) {
    return {
      status: 409,
      body: { error: 'cannot verify TEST_CHANNEL against TELEGRAM_CHANNEL (getChat failed)' },
    };
  }
  if (testId === prodId) {
    return { status: 409, body: { error: 'TEST_CHANNEL is the production channel' } };
  }

  const slot = d.store.slots.listForPlan(date).find((s) => s.slotId === slotId);
  if (!slot) return { status: 404, body: { error: 'slot not found' } };
  let planSlot: PlanSlot;
  let sends: SlotItem[];
  try {
    planSlot = JSON.parse(slot.json) as PlanSlot;
    sends = itemsOf(d, planSlot);
  } catch (err) {
    const r = refusal(err);
    return { status: 422, body: { error: scrub(`${r.code}: ${r.message}`).slice(0, 1000) } };
  }
  const messageIds: number[] = [];
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (const [i, item] of sends.entries()) {
    if (i > 0) await sleep(PART_GAP_MS);
    // `target` is TEST_CHANNEL, checked above against the production channel by name and id.
    const r = await sendItem(d.api, target, item, planSlot, { sleep, ...d.retry });
    if (!r.ok) {
      const error = scrub(`${itemMethod(item)}: ${r.outcome}: ${r.description}`).slice(0, 1000);
      d.store.alerts.add({
        kind: 'test_publish',
        message: `${date}/${slotId} -> TEST_CHANNEL failed after ids [${messageIds.join(', ')}]: ${error}`,
      });
      return { status: 502, body: { error, messageIds } };
    }
    messageIds.push(r.result.message_id);
  }
  d.store.alerts.add({
    kind: 'test_publish',
    message: `${date}/${slotId} -> TEST_CHANNEL (${target}): message ids [${messageIds.join(', ')}]`,
  });
  return { status: 200, body: { date, slotId, chat: target, messageIds } };
}
