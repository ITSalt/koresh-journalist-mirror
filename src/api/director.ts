import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { submitPlan } from '../plan/intake.js';
import { REPLACE_MIN_LEAD_MS, replaceSlot } from '../plan/replace.js';
import { chunkText } from '../lib/chunk.js';
import { decodeImage, imageSize, sizeProblem } from '../lib/image.js';
import { PART_GAP_MS } from '../publish/publisher.js';
import { sendPhoto, sendWithRetry, type BotApi, type RetryOptions } from '../telegram/bot-api.js';
import { previewDay, testPublish, type PreflightDeps } from '../publish/preflight.js';
import type { Store } from '../store/index.js';
import { bearerAuth, type AuthOptions } from './auth.js';
import { registerConnectRoutes } from './connect.js';
import { registerOwnerInboxRoutes } from './owner-inbox.js';
import type { ConnectService } from '../connect/service.js';
import { feedSchema, toStoreEntry } from './feed-schema.js';

export const FEED_BODY_LIMIT = 2 * 1024 * 1024;
const SMALL_BODY_LIMIT = 64 * 1024;
/** A day plan: a few posts of up to 3500 chars each, with a wide margin. */
export const PLAN_BODY_LIMIT = 512 * 1024;
export const ALERTS_LIMIT = 500;
export const INBOX_LIMIT = 500;
const TG_TEXT_LIMIT = 4096;
/**
 * An image (the owner photo, and an upload for a channel post): 5 MB decoded; base64 grows it by
 * 4/3, so the JSON limit of these routes is 8 MB.
 */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_BODY_LIMIT = 8 * 1024 * 1024;
const PHOTO_CAPTION_LIMIT = 1024;

/** Owner drafts: private messages from the bot to OWNER_CHAT_ID (never the channel). */
export interface OwnerDeps {
  chatId?: number;
  api?: BotApi;
  /** TELEGRAM_CHANNEL: drafts must never resolve to it. */
  channel: string;
  scrub?: (s: string) => string;
  sleep?: (ms: number) => Promise<void>;
  retry?: RetryOptions;
  /** Cap of an inbox picture download (default 20 MB; tests make it small). */
  fileMaxBytes?: number;
}

export interface DirectorApiOptions {
  config: Pick<Config, 'JOURNALIST_API_TOKEN'> & Partial<Pick<Config, 'TZ_PLAN'>>;
  store: Store;
  auth?: Partial<Pick<AuthOptions, 'maxFailures' | 'windowMs' | 'now'>>;
  /** Clock for the plan intake (tests). */
  now?: () => Date;
  /** Pre-flight routes (scope item 15); without it they answer 503. */
  preflight?: Omit<PreflightDeps, 'store'>;
  /** Owner inbox routes; without it POST /v1/owner/drafts answers 409. */
  owner?: OwnerDeps;
  /** Account connect routes (WP-PLAT-06), see ./connect.ts; without it they do not exist. */
  connect?: ConnectService;
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    const t = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(d);
  }, 'not a calendar date');

const testPublishSchema = z.object({ date: dateSchema, slotId: z.string().min(1).max(64) });

const draftSchema = z.object({
  text: z.string().min(1).max(20000),
  label: z.string().max(64).optional(),
  ref: z.string().max(200).optional(),
});

/** Strict: a chat id (or any other unknown key) is refused, the target is OWNER_CHAT_ID only. */
const photoSchema = z.strictObject({
  imageBase64: z.string().min(1),
  mime: z.enum(['image/png', 'image/jpeg']),
  caption: z.string().max(PHOTO_CAPTION_LIMIT).optional(),
  label: z.string().max(64).optional(),
  ref: z.string().max(200).optional(),
});

/** WP-SVC-24: an illustration for a channel post. Strict: nothing but the image and its type. */
const imageSchema = z.strictObject({
  imageBase64: z.string().min(1),
  mime: z.enum(['image/png', 'image/jpeg']),
});

const rejectSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
const feedbackSchema = z.object({
  planDate: dateSchema,
  slotId: z.string().min(1).max(200).optional(),
  verdict: z.enum(['like', 'dislike']),
  note: z.string().max(2000).optional(),
});

/** Publication statuses meaning a post may already be out (a stuck/unknown one counts). */
const STARTED = new Set(['sent', 'intent', 'unknown']);
/** The order in which the reject route names the platforms that have started. */
const PLATFORM_ORDER = ['telegram', 'threads', 'linkedin'];

function bad(reply: FastifyReply, error: z.ZodError | string, code = 400) {
  const detail =
    typeof error === 'string'
      ? error
      : error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
  return reply.code(code).send({ error: detail });
}

/** What a failed owner-chat check answers (always 409). */
export type OwnerTarget =
  { ok: true; o: OwnerDeps & { chatId: number; api: BotApi } } | { ok: false; error: string };

/**
 * The one guard of every route that writes to OWNER_CHAT_ID: it must be configured, and getChat
 * must say it is a private chat with that very id and not the production channel. Called before
 * any send.
 */
export async function ownerTarget(o: OwnerDeps | undefined): Promise<OwnerTarget> {
  if (!o?.chatId) return { ok: false, error: 'OWNER_CHAT_ID is not set' };
  if (!o.api) return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not set' };
  const api = o.api;
  const chat = String(o.chatId);
  const resolve = async (c: string) => {
    const r = await api.call<{ id?: number; type?: string }>('getChat', { chat_id: c });
    return r.ok ? r.result : undefined;
  };
  const [ownerChat, prodChat] = await Promise.all([resolve(chat), resolve(o.channel)]);
  if (!ownerChat || !prodChat || typeof ownerChat.id !== 'number') {
    return {
      ok: false,
      error: 'cannot verify OWNER_CHAT_ID against TELEGRAM_CHANNEL (getChat failed)',
    };
  }
  if (
    ownerChat.type !== 'private' ||
    ownerChat.id !== o.chatId ||
    ownerChat.id === prodChat.id ||
    chat.trim().toLowerCase() === o.channel.trim().toLowerCase()
  ) {
    return { ok: false, error: 'OWNER_CHAT_ID is not a private chat or is the production channel' };
  }
  return { ok: true, o: { ...o, chatId: o.chatId, api } };
}

/** Registers the director routes under /v1; every route needs the bearer token. */
export function registerDirectorApi(app: FastifyInstance, opts: DirectorApiOptions): void {
  const { store } = opts;
  const clock = opts.now ?? (() => new Date());
  const tz = opts.config.TZ_PLAN ?? 'Europe/Moscow';
  const authenticate = bearerAuth({ token: opts.config.JOURNALIST_API_TOKEN, ...opts.auth });

  app.register(async (api) => {
    // onRequest: refused before the body is read or parsed.
    api.addHook('onRequest', authenticate);
    if (opts.connect) registerConnectRoutes(api, opts.connect);
    registerOwnerInboxRoutes(api, {
      store,
      ...(opts.owner?.api ? { api: opts.owner.api } : {}),
      ...(opts.owner?.fileMaxBytes !== undefined ? { maxBytes: opts.owner.fileMaxBytes } : {}),
    });

    api.post('/v1/feed', { bodyLimit: FEED_BODY_LIMIT }, async (req, reply) => {
      const parsed = feedSchema.safeParse(req.body);
      if (!parsed.success) return bad(reply, parsed.error);
      const privateIds = parsed.data.filter((e) => e.private === true).map((e) => e.id);
      if (privateIds.length > 0) {
        // Refused before the store: nothing of this batch is stored (D-6).
        return reply.code(422).send({ error: 'private entries are not accepted', ids: privateIds });
      }
      store.db.transaction(() => {
        for (const e of parsed.data) store.feedEntries.upsert(toStoreEntry(e));
      })();
      return reply.code(200).send({ stored: parsed.data.length });
    });

    const planOr404 = (date: string, reply: FastifyReply) => {
      if (!dateSchema.safeParse(date).success) {
        bad(reply, 'date must be YYYY-MM-DD');
        return undefined;
      }
      const plan = store.plans.get(date);
      if (!plan) reply.code(404).send({ error: 'plan not found' });
      return plan;
    };

    api.get<{ Params: { date: string } }>('/v1/plans/:date', async (req, reply) => {
      const plan = planOr404(req.params.date, reply);
      if (!plan) return reply;
      let body: unknown = plan.json;
      try {
        body = JSON.parse(plan.json);
      } catch {
        // keep the raw string
      }
      const variants = store.slotVariants.listForPlan(plan.date);
      return {
        date: plan.date,
        status: plan.status,
        createdAt: plan.createdAt,
        plan: body,
        slots: store.slots.listForPlan(plan.date).map((s) => ({
          slotId: s.slotId,
          at: s.at,
          kind: s.kind,
          status: s.status,
        })),
        // Only for a plan with variants (v2): a v1 plan answers exactly as before.
        ...(variants.length
          ? {
              variants: variants.map((v) => ({
                slotId: v.slotId,
                platform: v.platform,
                lang: v.lang,
                at: v.at,
                status: v.status,
              })),
            }
          : {}),
      };
    });

    api.get<{ Params: { date: string } }>('/v1/plans/:date.md', async (req, reply) => {
      const plan = planOr404(req.params.date, reply);
      if (!plan) return reply;
      return reply
        .header('x-plan-status', plan.status)
        .type('text/markdown; charset=utf-8')
        .send(plan.md);
    });

    api.post<{ Params: { date: string } }>(
      '/v1/plans/:date',
      { bodyLimit: PLAN_BODY_LIMIT },
      async (req, reply) => {
        const date = dateSchema.safeParse(req.params.date);
        if (!date.success) return bad(reply, 'date must be YYYY-MM-DD');
        const r = submitPlan(store, date.data, req.body, clock(), tz);
        switch (r.kind) {
          case 'too_late':
            return reply.code(409).send({
              error: 'too_late',
              message: `the plan for ${date.data} was due by ${r.deadline} (${tz}) the evening before`,
            });
          case 'locked':
            return reply.code(409).send({
              error: `plan is ${r.status}; it can no longer be replaced`,
              status: r.status,
            });
          case 'invalid':
            return reply.code(422).send({ errors: r.errors });
          case 'bad_text':
            // J-N1: a lone surrogate; `errors[].index` is where it sits in the text as sent.
            return reply.code(400).send({ errors: r.errors });
          case 'unchanged':
            return reply
              .code(200)
              .send({ status: r.status, date: date.data, md: r.md, warnings: r.warnings });
          case 'stored':
            return reply
              .code(201)
              .send({ status: r.status, date: date.data, md: r.md, warnings: r.warnings });
        }
      },
    );

    // WP-SVC-22: an owner-requested edit of one slot after approval (P-10).
    api.put<{ Params: { date: string; slotId: string } }>(
      '/v1/plans/:date/slots/:slotId',
      { bodyLimit: SMALL_BODY_LIMIT },
      async (req, reply) => {
        const date = dateSchema.safeParse(req.params.date);
        if (!date.success) return bad(reply, 'date must be YYYY-MM-DD');
        const { slotId } = req.params;
        const r = replaceSlot(store, date.data, slotId, req.body, clock());
        switch (r.kind) {
          case 'no_plan':
            return reply.code(404).send({ error: 'plan not found' });
          case 'no_slot':
            return reply.code(404).send({ error: 'slot not found' });
          case 'not_approved':
            return reply.code(409).send({
              error: 'not_approved',
              status: r.status,
              message: `plan is ${r.status}; only a slot of an approved plan can be replaced`,
            });
          case 'slot_started':
            return reply.code(409).send({
              error: 'slot_started',
              slotStatus: r.slotStatus,
              publications: r.publications,
              message: 'the slot is not planned any more or has a publication row',
            });
          case 'too_close':
            return reply.code(409).send({
              error: 'too_close',
              at: r.at,
              message: `a slot can be replaced until ${REPLACE_MIN_LEAD_MS / 60_000} minutes before its time`,
            });
          case 'invalid':
            return reply.code(422).send({ errors: r.errors });
          case 'replaced':
            // The only copy of the old slot: the alert holds its sha256 only.
            req.log.info({ date: date.data, slotId, ...r.audit }, 'slot replaced');
            break;
          case 'unchanged':
            break;
        }
        return reply.code(200).send({ date: date.data, slotId, status: 'approved', md: r.md });
      },
    );

    api.get<{ Params: { date: string }; Querystring: { now?: string } }>(
      '/v1/plans/:date/preview',
      async (req, reply) => {
        if (!opts.preflight) return bad(reply, 'preview is not configured', 503);
        const date = dateSchema.safeParse(req.params.date);
        if (!date.success) return bad(reply, 'date must be YYYY-MM-DD');
        const now = z.iso.datetime({ offset: true }).optional().safeParse(req.query.now);
        if (!now.success) return bad(reply, 'query "now" must be an ISO date-time with an offset');
        const at = now.data ? new Date(now.data) : clock();
        return previewDay({ ...opts.preflight, store }, date.data, at);
      },
    );

    api.post('/v1/test-publish', { bodyLimit: SMALL_BODY_LIMIT }, async (req, reply) => {
      if (!opts.preflight) return bad(reply, 'test-publish is not configured', 503);
      const body = testPublishSchema.safeParse(req.body);
      if (!body.success) return bad(reply, body.error);
      const r = await testPublish({ ...opts.preflight, store }, body.data.date, body.data.slotId);
      return reply.code(r.status).send(r.body);
    });

    api.get<{ Querystring: { since?: string } }>('/v1/alerts', async (req, reply) => {
      const since = z.iso.datetime({ offset: true }).optional().safeParse(req.query.since);
      if (!since.success) return bad(reply, 'query "since" must be an ISO date-time');
      const from = since.data ? new Date(since.data) : new Date(0);
      return { alerts: store.alerts.listSince(from, ALERTS_LIMIT) };
    });

    api.get<{ Querystring: { after?: string; limit?: string } }>(
      '/v1/inbox',
      async (req, reply) => {
        const after = z.coerce
          .number()
          .int()
          .nonnegative()
          .safeParse(req.query.after ?? '0');
        if (!after.success || req.query.after === '') {
          return bad(reply, 'query "after" must be a non-negative integer');
        }
        const limit = z.coerce
          .number()
          .int()
          .min(1)
          .max(INBOX_LIMIT)
          .safeParse(req.query.limit ?? '100');
        if (!limit.success || req.query.limit === '') {
          return bad(reply, `query "limit" must be an integer 1..${INBOX_LIMIT}`);
        }
        const messages = store.inbox.listAfter(after.data, limit.data).map((m) => ({
          id: m.id,
          at: m.at,
          text: m.text,
          kind: m.kind,
          replyToMessageId: m.replyToMessageId,
          draftId: m.draftId,
          draftRef: m.draftRef,
          draftLabel: m.draftLabel,
        }));
        return { messages, next: messages.length ? messages[messages.length - 1]!.id : after.data };
      },
    );

    api.post('/v1/owner/drafts', { bodyLimit: SMALL_BODY_LIMIT }, async (req, reply) => {
      const body = draftSchema.safeParse(req.body);
      if (!body.success) return bad(reply, body.error);
      const g = await ownerTarget(opts.owner);
      if (!g.ok) return bad(reply, g.error, 409);
      const o = g.o;
      const scrub = (x: string) => (o.scrub ? o.scrub(x) : x);

      const { text, label, ref } = body.data;
      const head = [label ? `[${label}]` : '', ref ?? ''].filter(Boolean).join(' ');
      const reserve = head ? head.length + 2 : 0;
      const parts = chunkText(text, { limit: TG_TEXT_LIMIT, reserve });
      if (parts.length === 0) return bad(reply, 'text is blank');
      const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const draft = store.ownerDrafts.add({ label, ref, text, status: 'partial' });
      const messageIds: number[] = [];
      for (const [i, part] of parts.entries()) {
        if (i > 0) await sleep(PART_GAP_MS);
        const out = i === 0 && head ? `${head}\n\n${part}` : part;
        const r = await sendWithRetry<{ message_id: number }>(
          o.api,
          'sendMessage',
          { chat_id: o.chatId, text: out, link_preview_options: { is_disabled: true } },
          { sleep, ...o.retry },
        );
        if (!r.ok) {
          const error = scrub(`sendMessage: ${r.outcome}: ${r.description}`).slice(0, 1000);
          const status = messageIds.length > 0 ? 'partial' : 'failed';
          store.ownerDrafts.setStatus(draft.id, status, error);
          return reply.code(502).send({ error, draftId: draft.id, status, messageIds });
        }
        store.ownerDrafts.addPart(draft.id, i, r.result.message_id);
        messageIds.push(r.result.message_id);
      }
      store.ownerDrafts.setStatus(draft.id, 'sent');
      return reply.code(201).send({ draftId: draft.id, messageIds });
    });

    api.post('/v1/owner/drafts/photo', { bodyLimit: PHOTO_BODY_LIMIT }, async (req, reply) => {
      const body = photoSchema.safeParse(req.body);
      if (!body.success) return bad(reply, body.error, 422);
      const { imageBase64, mime, caption, label, ref } = body.data;
      // Base64, then the size (from the text length, before anything is decoded), then the bytes.
      const decoded = decodeImage(imageBase64, mime, PHOTO_MAX_BYTES);
      if (!decoded.ok) return bad(reply, decoded.error, decoded.status);
      const { bytes } = decoded;
      const g = await ownerTarget(opts.owner);
      if (!g.ok) return bad(reply, g.error, 409);
      const o = g.o;
      const scrub = (x: string) => (o.scrub ? o.scrub(x) : x);

      // Only type, size and hash are kept or logged; the bytes live in this request alone.
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const meta = `[photo ${mime} ${bytes.length} B sha256:${sha256}]`;
      const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const draft = store.ownerDrafts.add({
        label,
        ref,
        text: caption ? `${meta}\n${caption}` : meta,
        status: 'partial',
      });
      const r = await sendPhoto(o.api, o.chatId, bytes, mime, caption, { sleep, ...o.retry });
      if (!r.ok) {
        const error = scrub(`sendPhoto: ${r.outcome}: ${r.description}`).slice(0, 1000);
        store.ownerDrafts.setStatus(draft.id, 'failed', error);
        return reply.code(502).send({ error, draftId: draft.id, status: 'failed', messageIds: [] });
      }
      store.ownerDrafts.addPart(draft.id, 0, r.result.message_id);
      store.ownerDrafts.setStatus(draft.id, 'sent');
      req.log.info({ draftId: draft.id, mime, size: bytes.length, sha256 }, 'owner photo sent');
      return reply.code(201).send({ draftId: draft.id, messageIds: [r.result.message_id] });
    });

    // WP-SVC-24: stores an illustration once, under the sha256 of its bytes. A plan slot then
    // names it by that sha256 (`image: {sha256, credit}`); nothing is sent anywhere from here.
    api.post('/v1/images', { bodyLimit: PHOTO_BODY_LIMIT }, async (req, reply) => {
      // Every refusal is `{error: <code>, message}`; nothing is stored on any of them.
      const refuse = (r: { code: string; error: string }, status: number) =>
        reply.code(status).send({ error: r.code, message: r.error });
      const body = imageSchema.safeParse(req.body);
      if (!body.success) {
        const error = body.error.issues
          .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
          .join('; ');
        return refuse({ code: 'invalid_body', error }, 422);
      }
      const { imageBase64, mime } = body.data;
      const decoded = decodeImage(imageBase64, mime, PHOTO_MAX_BYTES);
      if (!decoded.ok) return refuse(decoded, decoded.status);
      const size = imageSize(decoded.bytes, mime);
      if (!size) {
        return refuse(
          { code: 'unreadable_image', error: `cannot read the size from the ${mime} header` },
          422,
        );
      }
      const problem = sizeProblem(size);
      if (problem) return refuse(problem, 422);
      const { image, created } = store.images.add({ mime, bytes: decoded.bytes, ...size }, clock());
      const out = {
        sha256: image.sha256,
        mime: image.mime,
        size: image.size,
        width: image.width,
        height: image.height,
      };
      // Only these facts are logged; the bytes are in the request and in the store row alone.
      req.log.info({ ...out, created }, 'image stored');
      return reply.code(created ? 201 : 200).send(out);
    });

    api.post<{ Params: { date: string } }>(
      '/v1/plans/:date/reject',
      { bodyLimit: SMALL_BODY_LIMIT },
      async (req, reply) => {
        const body = rejectSchema.safeParse(req.body);
        if (!body.success) return bad(reply, body.error);
        const plan = planOr404(req.params.date, reply);
        if (!plan) return reply;

        const slots = store.slots.listForPlan(plan.date);
        // A `done` slot alone (e.g. dry run) does not count: a real post may be out only if
        // a publication is sent, intent or unknown. Rows of every platform count (WP-PLAT-02):
        // a variant that is out on Threads or LinkedIn started the day as a Telegram post does.
        const out = store.publications.listForPlan(plan.date).filter((p) => STARTED.has(p.status));
        const started = out.length > 0;
        // The platforms on which something is (or may be) out, Telegram first.
        const startedOn = PLATFORM_ORDER.filter((name) => out.some((p) => p.platform === name));
        for (const p of out) if (!startedOn.includes(p.platform)) startedOn.push(p.platform);
        const planned = slots.filter((s) => s.status === 'planned').map((s) => s.slotId);
        const plannedVariants = store.slotVariants
          .listForPlan(plan.date)
          .filter((v) => v.status === 'planned');
        // Only for a day with planned variants: a day without them answers exactly as before.
        const skippedVariants = plannedVariants.length
          ? {
              skippedVariants: plannedVariants.map((v) => ({
                slotId: v.slotId,
                platform: v.platform,
                lang: v.lang,
              })),
            }
          : {};

        // Both branches stop what is still planned on every platform: slots and variants.
        const skip = () => {
          for (const id of planned) store.slots.setStatus(plan.date, id, 'skipped');
          for (const v of plannedVariants) {
            store.slotVariants.setStatus(plan.date, v.slotId, v.platform, v.lang, 'skipped');
          }
        };

        if (started) {
          store.db.transaction(skip)();
          return reply.code(409).send({
            error: `already started on ${startedOn.join(', ')}: a post is out or may be out there`,
            startedOn,
            skipped: planned,
            ...skippedVariants,
            status: plan.status,
          });
        }
        const already = plan.status === 'rejected';
        store.db.transaction(() => {
          store.plans.setStatus(plan.date, 'rejected');
          skip();
          if (!already) {
            store.feedback.add({
              planDate: plan.date,
              verdict: 'dislike',
              note: `rejected: ${body.data.reason}`,
            });
          }
        })();
        return { date: plan.date, status: 'rejected', skipped: planned, ...skippedVariants };
      },
    );

    api.post('/v1/feedback', { bodyLimit: SMALL_BODY_LIMIT }, async (req, reply) => {
      const body = feedbackSchema.safeParse(req.body);
      if (!body.success) return bad(reply, body.error);
      const f = body.data;
      if (!store.plans.get(f.planDate)) return reply.code(404).send({ error: 'plan not found' });
      if (f.slotId && !store.slots.listForPlan(f.planDate).some((s) => s.slotId === f.slotId)) {
        return reply.code(404).send({ error: 'slot not found' });
      }
      return reply.code(201).send(store.feedback.add(f));
    });

    api.get<{ Querystring: { date?: string } }>('/v1/publications', async (req, reply) => {
      const date = dateSchema.safeParse(req.query.date);
      if (!date.success) return bad(reply, 'query "date" must be YYYY-MM-DD');
      return { date: date.data, publications: store.publications.listForPlan(date.data) };
    });
  });
}
