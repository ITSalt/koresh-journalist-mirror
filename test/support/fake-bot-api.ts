import { createHash } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A local stand-in for https://api.telegram.org: `POST /bot<token>/<method>` with a JSON body.
// Tests never reach the real Bot API. `channel` holds what subscribers would see: a message is
// in it when the fake accepted it, including when the reply is then lost (`drop`, `hang`).

export type BotReply =
  /** Accept and answer normally (the default when a method's queue is empty). */
  | { accept: true }
  /** Answer with this HTTP status and Telegram error body; nothing is posted. */
  | { status: number; description?: string; retryAfter?: number }
  /** Post the message, then close the socket without an answer (the reply is lost). */
  | { drop: true; posted?: boolean }
  /** Post the message (unless `posted: false`) and never answer. */
  | { hang: true; posted?: boolean };

export interface BotRequest {
  method: string;
  /** True when the path carried the expected token. */
  tokenOk: boolean;
  /** JSON body, or the text fields of a multipart body (all strings). */
  body: Record<string, unknown>;
  /** Content-Type of the request. */
  contentType: string;
  /** File parts of a multipart body (the bytes are not kept: size and hash only). */
  files: Record<string, { filename: string; type: string; size: number; sha256: string }>;
}

export interface ChannelMessage {
  message_id: number;
  chat_id: unknown;
  method: string;
  text?: string;
  caption?: string;
  /** sendPhoto: sha256 of the posted file. */
  photoSha256?: string;
  parse_mode?: unknown;
  poll?: { question: unknown; options: unknown; is_anonymous: unknown; type: unknown };
}

export class FakeBotApi {
  readonly requests: BotRequest[] = [];
  readonly channel: ChannelMessage[] = [];
  /** Reply queues per method; an empty queue accepts. */
  readonly replies: Record<string, BotReply[]> = {};
  getChatResult: Record<string, unknown> = { id: -1001, type: 'channel', title: 'Test' };
  /** getChat answers per chat_id (as sent); others get `getChatResult`; `null` -> 400. */
  chats: Record<string, Record<string, unknown> | null> = {};
  /** Pending updates for getUpdates; confirmed (dropped) once a call passes a higher offset. */
  readonly updates: Array<{ update_id: number } & Record<string, unknown>> = [];
  /** Called with every request before it is answered (e.g. to kill a child process). */
  onRequest?: (r: BotRequest) => void;
  /**
   * Files for getFile and the download `GET /file/bot<token>/<file_path>`, by file_id. `size`
   * replaces the file_size getFile reports (absent: the real one; null: none); `chunked` sends
   * the bytes without a content-length; `gone` makes the download answer 404 (getFile works).
   */
  readonly files: Record<
    string,
    { path: string; bytes: Buffer; size?: number | null; chunked?: boolean; gone?: boolean }
  > = {};
  /** The paths of the downloads asked for (they are not in `requests`). */
  readonly downloads: string[] = [];
  private nextId = 100;
  private readonly sockets = new Set<import('node:net').Socket>();
  private readonly server: Server;

  constructor(private readonly token: string) {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const type = String(req.headers['content-type'] ?? '');
        void this.parse(Buffer.concat(chunks), type).then((p) =>
          this.handle(req.url ?? '', p.body, p.files, type, res),
        );
      });
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  /** Base URL for the client, like `https://api.telegram.org`. */
  get baseUrl(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  queue(method: string, ...r: BotReply[]): this {
    (this.replies[method] ??= []).push(...r);
    return this;
  }

  pushUpdate(u: { update_id: number } & Record<string, unknown>): this {
    this.updates.push(u);
    return this;
  }

  sent(method?: string): BotRequest[] {
    return this.requests.filter((r) => method === undefined || r.method === method);
  }

  private async parse(
    raw: Buffer,
    type: string,
  ): Promise<{ body: Record<string, unknown>; files: BotRequest['files'] }> {
    const files: BotRequest['files'] = {};
    const body: Record<string, unknown> = {};
    try {
      if (type.startsWith('multipart/form-data')) {
        const form = await new Response(new Uint8Array(raw), {
          headers: { 'content-type': type },
        }).formData();
        for (const [k, v] of form.entries()) {
          if (typeof v === 'string') body[k] = v;
          else {
            const bytes = Buffer.from(await v.arrayBuffer());
            files[k] = {
              filename: v.name,
              type: v.type,
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            };
          }
        }
      } else Object.assign(body, JSON.parse(raw.toString('utf8') || '{}'));
    } catch {
      // keep what was parsed
    }
    return { body, files };
  }

  private post(
    method: string,
    body: Record<string, unknown>,
    files: BotRequest['files'] = {},
  ): ChannelMessage {
    const m: ChannelMessage = { message_id: this.nextId++, chat_id: body.chat_id, method };
    if (method === 'sendMessage') m.text = body.text as string;
    if (method === 'sendPhoto' && body.caption !== undefined) m.caption = body.caption as string;
    if (method === 'sendPhoto') {
      if (files.photo) m.photoSha256 = files.photo.sha256;
      if (body.parse_mode !== undefined) m.parse_mode = body.parse_mode;
    }
    if (method === 'sendPoll') {
      m.poll = {
        question: body.question,
        options: body.options,
        is_anonymous: body.is_anonymous,
        type: body.type,
      };
    }
    this.channel.push(m);
    return m;
  }

  private handle(
    url: string,
    body: Record<string, unknown>,
    files: BotRequest['files'],
    contentType: string,
    res: ServerResponse,
  ) {
    const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(url);
    if (file) {
      this.downloads.push(file[2]!);
      const f = Object.values(this.files).find((x) => x.path === decodeURIComponent(file[2]!));
      if (file[1] !== this.token || !f || f.gone) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        ...(f.chunked ? {} : { 'content-length': String(f.bytes.length) }),
      });
      if (f.chunked) {
        // Several writes, no length: the client only learns the size by reading.
        for (let i = 0; i < f.bytes.length; i += 64 * 1024)
          res.write(f.bytes.subarray(i, i + 64 * 1024));
        res.end();
      } else res.end(f.bytes);
      return;
    }
    const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url);
    const method = m?.[2] ?? '';
    const r: BotRequest = { method, tokenOk: m?.[1] === this.token, body, contentType, files };
    this.requests.push(r);
    this.onRequest?.(r);
    const json = (status: number, b: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (!r.tokenOk) return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const reply = this.replies[method]?.shift() ?? { accept: true };
    const posts = method === 'sendMessage' || method === 'sendPoll' || method === 'sendPhoto';
    if ('status' in reply) {
      return json(reply.status, {
        ok: false,
        error_code: reply.status,
        description: reply.description ?? `fake error ${reply.status}`,
        ...(reply.retryAfter !== undefined
          ? { parameters: { retry_after: reply.retryAfter } }
          : {}),
      });
    }
    if ('drop' in reply || 'hang' in reply) {
      if (posts && reply.posted !== false) this.post(method, body, files);
      if ('drop' in reply) res.socket?.destroy();
      return;
    }
    if (method === 'getChat') {
      const c = this.chats[String(body.chat_id)];
      if (c === null) {
        return json(400, {
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found',
        });
      }
      return json(200, { ok: true, result: c ?? this.getChatResult });
    }
    if (method === 'getFile') {
      const id = String(body.file_id);
      const f = this.files[id];
      if (!f) {
        return json(400, {
          ok: false,
          error_code: 400,
          description: 'Bad Request: invalid file_id',
        });
      }
      const size = f.size === undefined ? f.bytes.length : f.size;
      return json(200, {
        ok: true,
        result: {
          file_id: id,
          file_unique_id: `u-${id}`,
          ...(size === null ? {} : { file_size: size }),
          file_path: f.path,
        },
      });
    }
    if (method === 'getUpdates') {
      const offset = typeof body.offset === 'number' ? body.offset : undefined;
      if (offset !== undefined) {
        for (let i = this.updates.length - 1; i >= 0; i--) {
          if (this.updates[i]!.update_id < offset) this.updates.splice(i, 1);
        }
      }
      if (this.updates.length > 0) return json(200, { ok: true, result: [...this.updates] });
      // An idle long poll, shortened for tests.
      setTimeout(() => json(200, { ok: true, result: [] }), 20);
      return;
    }
    if (!posts) return json(404, { ok: false, error_code: 404, description: 'Not Found' });
    const msg = this.post(method, body, files);
    json(200, {
      ok: true,
      result: { message_id: msg.message_id, chat: { id: -1001, type: 'channel' }, date: 0 },
    });
  }

  async start(port = 0): Promise<this> {
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', r));
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
