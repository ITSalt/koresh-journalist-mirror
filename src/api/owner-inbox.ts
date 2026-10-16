import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../store/index.js';
import type { BotApi } from '../telegram/bot-api.js';
import { INBOX_IMAGE_MIMES } from '../telegram/inbox.js';

/**
 * The owner's inbox with its pictures (director API, bearer, main listener only). Registered
 * inside the bearer scope of `registerDirectorApi`; the public listener has no such route.
 *
 *   GET /v1/owner/inbox?since=<id>&limit=      the rows after `since`, each with its files
 *                                              ({idx, mime, width, height}: no Telegram file id)
 *   GET /v1/owner/inbox/<id>/files/<idx>       the bytes of one picture, fetched from Telegram
 *                                              (getFile, then the file download) and streamed
 *                                              through; nothing is stored on the server
 *
 * Only images are served (JPEG, PNG, WebP, read from the first bytes), at most 20 MB, the Bot
 * API's own download limit. The log line of a download holds the status and the size only.
 */

export const INBOX_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const OWNER_INBOX_LIMIT = 500;

export interface OwnerInboxDeps {
  store: Pick<Store, 'inbox'>;
  /** The bot; without it (no TELEGRAM_BOT_TOKEN) a download answers 409. */
  api?: BotApi;
  /** Tests make the cap small. */
  maxBytes?: number;
}

/** JPEG, PNG and WebP by their first bytes; anything else is not served. */
export function sniffImage(
  head: Uint8Array,
): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'image/png';
  }
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

const intParam = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export function registerOwnerInboxRoutes(api: FastifyInstance, d: OwnerInboxDeps): void {
  const cap = d.maxBytes ?? INBOX_FILE_MAX_BYTES;

  api.get<{ Querystring: { since?: string; limit?: string } }>(
    '/v1/owner/inbox',
    async (req, reply) => {
      const since = intParam.safeParse(req.query.since ?? '0');
      if (!since.success || req.query.since === '') {
        return reply.code(400).send({ error: 'query "since" must be a non-negative integer' });
      }
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(OWNER_INBOX_LIMIT)
        .safeParse(req.query.limit ?? '100');
      if (!limit.success || req.query.limit === '') {
        return reply
          .code(400)
          .send({ error: `query "limit" must be an integer 1..${OWNER_INBOX_LIMIT}` });
      }
      const rows = d.store.inbox.listAfter(since.data, limit.data);
      const files = d.store.inbox.fileMeta(rows.map((r) => r.id));
      const messages = rows.map((m) => ({
        id: m.id,
        at: m.at,
        kind: m.kind,
        mediaGroupId: m.mediaGroupId,
        text: m.text,
        replyToMessageId: m.replyToMessageId,
        draftId: m.draftId,
        files: files.get(m.id) ?? [],
      }));
      return { messages, next: messages.length ? messages[messages.length - 1]!.id : since.data };
    },
  );

  api.get<{ Params: { id: string; idx: string } }>(
    '/v1/owner/inbox/:id/files/:idx',
    async (req, reply) => {
      // Only the status and the size are ever logged here.
      const done = (status: number, size?: number) =>
        req.log.info({ status, ...(size !== undefined ? { size } : {}) }, 'owner inbox file');
      const fail = (status: number, error: string) => {
        done(status);
        return reply.code(status).send({ error });
      };
      const id = intParam.safeParse(req.params.id);
      const idx = intParam.safeParse(req.params.idx);
      if (!id.success || !idx.success) return fail(400, 'id and idx must be non-negative integers');
      const file = d.store.inbox.file(id.data, idx.data);
      if (!file) return fail(404, 'file not found');
      if (file.mime !== null && !INBOX_IMAGE_MIMES.includes(file.mime)) {
        return fail(415, 'not an image');
      }
      if (!d.api?.download) return fail(409, 'TELEGRAM_BOT_TOKEN is not set');

      const got = await d.api.call<{ file_path?: unknown; file_size?: unknown }>('getFile', {
        file_id: file.fileId,
      });
      // The kind and the status only: nothing of Telegram's text, which could name the file.
      if (!got.ok) {
        return fail(502, `getFile failed: ${got.kind}${'status' in got ? ` ${got.status}` : ''}`);
      }
      const declared = got.result?.file_size;
      if (typeof declared === 'number' && declared > cap) return fail(413, 'file over 20 MB');
      const path = got.result?.file_path;
      if (typeof path !== 'string' || path === '') return fail(502, 'getFile gave no file path');

      const dl = await d.api.download(path);
      if (!dl.ok) {
        return fail(502, `download failed: ${dl.kind}${dl.status ? ` ${dl.status}` : ''}`);
      }
      if (dl.contentLength !== undefined && dl.contentLength > cap) {
        await dl.body.cancel().catch(() => undefined);
        return fail(413, 'file over 20 MB');
      }

      // Read just enough to know the type; the rest is passed through as it comes.
      const reader = dl.body.getReader();
      const head: Uint8Array[] = [];
      let headLength = 0;
      let ended = false;
      try {
        while (headLength < 12) {
          const r = await reader.read();
          if (r.done) {
            ended = true;
            break;
          }
          head.push(r.value);
          headLength += r.value.byteLength;
        }
      } catch {
        return fail(502, 'download failed: unknown');
      }
      const first = Buffer.concat(head);
      if (first.length > cap) {
        await reader.cancel().catch(() => undefined);
        return fail(413, 'file over 20 MB');
      }
      const mime = sniffImage(first);
      if (!mime) {
        await reader.cancel().catch(() => undefined);
        return fail(415, 'not an image');
      }

      let sent = first.length;
      async function* bytes() {
        try {
          yield first;
          while (!ended) {
            const r = await reader.read();
            if (r.done) break;
            sent += r.value.byteLength;
            // A larger file than declared: stop; the client sees a cut response.
            if (sent > cap) throw new Error('over the cap');
            yield r.value;
          }
          done(200, sent);
        } catch (err) {
          done(sent > cap ? 413 : 502, sent);
          await reader.cancel().catch(() => undefined);
          throw err;
        }
      }
      reply
        .header('content-type', mime)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff');
      if (dl.contentLength !== undefined) reply.header('content-length', String(dl.contentLength));
      return reply.send(Readable.from(bytes()));
    },
  );
}
