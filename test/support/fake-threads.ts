import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

// A local stand-in for https://graph.threads.net. Tests never reach the real API.
//
// Written from the documented behaviour of the Threads API as read on 12.10.2026 and from the
// Graph API error shape. Nobody has a tester account yet, so where the documentation gives no
// exact spelling the fake follows src/platforms/threads/platform-facts.ts (the [assumed] items
// there); error texts marked "invented" below are placeholders, not recordings.
//
//   POST /v1.0/{user}/threads            media_type=TEXT, text       -> { id }  (a container)
//   POST /v1.0/{user}/threads_publish    creation_id                 -> { id }  (a public post)
//   GET  /v1.0/{user}/threads_publishing_limit?fields=quota_usage,config
//                                        -> { data: [{ quota_usage, config: { quota_total, quota_duration } }] }
//   GET  /v1.0/me?fields=id,username     -> { id, username }
//   GET  /v1.0/{post-id}?fields=id,permalink -> { id, permalink }
//   GET  /refresh_access_token?grant_type=th_refresh_token -> { access_token, token_type, expires_in }
//
// The token is accepted as the `access_token` parameter (query or form body) or as a Bearer
// header. Parameters are accepted in the query string or in a form body.
// `posts` holds what readers would see: a post is in it when the fake accepted the publish call,
// including when the answer is then lost (`drop`, `hang`).

export type ThreadsOp = 'container' | 'publish' | 'quota' | 'me' | 'permalink' | 'refresh' | 'none';

export interface FakeError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
}

export type ThreadsReply =
  /** Carry the call out and answer normally (the default when an operation's queue is empty). */
  | { accept: true }
  /** Answer with this HTTP status and a Graph error body. Nothing is carried out, unless
   *  `applied: true`: then the call takes effect first and the error answer follows (a platform
   *  that did the work and still answered 429, for instance). */
  | { status: number; error?: FakeError; retryAfter?: number; applied?: boolean }
  /** Carry the call out (unless `applied: false`), then answer with this body as is (e.g. not
   *  JSON, or JSON without the expected fields) and these extra headers. */
  | { raw: string; rawStatus?: number; headers?: Record<string, string>; applied?: boolean }
  /** Carry the call out (unless `applied: false`), then close the socket without an answer. */
  | { drop: true; applied?: boolean }
  /** Carry the call out (unless `applied: false`) and never answer. */
  | { hang: true; applied?: boolean };

export interface ThreadsRequest {
  op: ThreadsOp;
  method: string;
  path: string;
  /** Query and form parameters, without `access_token`. */
  params: Record<string, string>;
  /** True when the request carried the currently valid token. */
  tokenOk: boolean;
  tokenIn: 'query' | 'body' | 'header' | 'none';
}

export interface FakePost {
  id: string;
  containerId: string;
  text: string;
  permalink: string;
}

const DAY_S = 24 * 3600;

export class FakeThreads {
  readonly requests: ThreadsRequest[] = [];
  /** Containers by id: invisible until published. */
  readonly containers = new Map<string, { text: string; published: boolean }>();
  /** Public posts, in the order they were published. */
  readonly posts: FakePost[] = [];
  /** Reply queues per operation; an empty queue accepts. */
  readonly replies: Partial<Record<ThreadsOp, ThreadsReply[]>> = {};
  userId = '17841400000000001';
  username = 'fake_profile';
  quotaUsage = 0;
  quotaTotal = 250;
  /** The token the fake accepts now; replaced by a refresh. */
  token: string;
  tokenIssuedAt = new Date('2026-10-01T00:00:00.000Z');
  tokenExpiresAt = new Date('2026-11-30T00:00:00.000Z');
  /** Tokens handed out by refresh calls, in order (the default is `<old>-r<n>`). */
  readonly nextTokens: string[] = [];
  now: () => Date = () => new Date('2026-10-12T12:00:00.000Z');
  /** Called with every request before it is answered (e.g. to kill a child process). */
  onRequest?: (r: ThreadsRequest) => void;
  private seq = 0;
  private refreshes = 0;
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;

  constructor(token: string) {
    this.token = token;
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => this.handle(req, Buffer.concat(chunks).toString('utf8'), res));
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  /** Base URL for the client, like `https://graph.threads.net`. */
  get baseUrl(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  queue(op: ThreadsOp, ...r: ThreadsReply[]): this {
    (this.replies[op] ??= []).push(...r);
    return this;
  }

  sent(op?: ThreadsOp): ThreadsRequest[] {
    return this.requests.filter((r) => op === undefined || r.op === op);
  }

  /** The operations requested so far, in order. */
  ops(): ThreadsOp[] {
    return this.requests.map((r) => r.op);
  }

  private route(method: string, path: string): ThreadsOp {
    if (method === 'GET' && path === '/refresh_access_token') return 'refresh';
    const m = /^\/v1\.0\/([^/]+)(?:\/([a-z_]+))?$/.exec(path);
    if (!m) return 'none';
    const [, first, edge] = m;
    const isUser = first === 'me' || first === this.userId;
    if (edge === undefined) {
      if (method !== 'GET') return 'none';
      return isUser ? 'me' : 'permalink';
    }
    if (!isUser) return 'none';
    if (method === 'POST' && edge === 'threads') return 'container';
    if (method === 'POST' && edge === 'threads_publish') return 'publish';
    if (method === 'GET' && edge === 'threads_publishing_limit') return 'quota';
    return 'none';
  }

  /** Carries the operation out; returns the HTTP status and JSON body of the normal answer. */
  private apply(
    op: ThreadsOp,
    path: string,
    p: Record<string, string>,
  ): { status: number; body: unknown } {
    const bad = (message: string, code = 100, sub?: number) => ({
      status: 400,
      body: errorBody({ message, code, ...(sub !== undefined ? { error_subcode: sub } : {}) }),
    });
    switch (op) {
      case 'container': {
        if (p.media_type !== 'TEXT') return bad('(#100) The parameter media_type is required.');
        if (!p.text) return bad('(#100) The parameter text is required.');
        // The 500 limit is documented; the fake counts code points and leaves the emoji rule out.
        if ([...p.text].length > 500) {
          return bad('Param text must be at most 500 characters long.');
        }
        const id = `1790${String(++this.seq).padStart(4, '0')}`;
        this.containers.set(id, { text: p.text, published: false });
        return { status: 200, body: { id } };
      }
      case 'publish': {
        const containerId = p.creation_id;
        if (!containerId) return bad('(#100) The parameter creation_id is required.');
        const c = this.containers.get(containerId);
        if (!c) return bad('The requested resource does not exist', 24, 4279009);
        // Invented texts: the documentation shows neither of these two refusals.
        if (c.published) return bad('The media has already been published.');
        if (this.quotaUsage >= this.quotaTotal) return bad('The publishing limit is reached.', 4);
        c.published = true;
        this.quotaUsage += 1;
        const id = `1800${String(++this.seq).padStart(4, '0')}`;
        this.posts.push({
          id,
          containerId,
          text: c.text,
          permalink: `https://www.threads.com/@${this.username}/post/F${id}`,
        });
        return { status: 200, body: { id } };
      }
      case 'quota':
        return {
          status: 200,
          body: {
            data: [
              {
                quota_usage: this.quotaUsage,
                config: { quota_total: this.quotaTotal, quota_duration: DAY_S },
              },
            ],
          },
        };
      case 'me':
        return { status: 200, body: { id: this.userId, username: this.username } };
      case 'permalink': {
        const post = this.posts.find((x) => x.id === path.split('/').pop());
        if (!post) return bad('The requested resource does not exist', 24, 4279009);
        return { status: 200, body: { id: post.id, permalink: post.permalink } };
      }
      case 'refresh': {
        if (p.grant_type !== 'th_refresh_token') {
          return bad('(#100) The parameter grant_type is required.');
        }
        // Invented text: the documentation states the 24 h rule, not the refusal's wording.
        if (this.now().getTime() - this.tokenIssuedAt.getTime() < DAY_S * 1000) {
          return bad('The access token is too young to be refreshed.', 10);
        }
        this.token = this.nextTokens.shift() ?? `${this.token}-r${++this.refreshes}`;
        this.tokenIssuedAt = this.now();
        this.tokenExpiresAt = new Date(this.now().getTime() + 60 * DAY_S * 1000);
        return {
          status: 200,
          body: { access_token: this.token, token_type: 'bearer', expires_in: 60 * DAY_S },
        };
      }
      default:
        return bad('Unsupported request.');
    }
  }

  private handle(req: IncomingMessage, raw: string, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://fake');
    const method = req.method ?? 'GET';
    const params: Record<string, string> = {};
    for (const [k, v] of url.searchParams) params[k] = v;
    let tokenIn: ThreadsRequest['tokenIn'] = 'access_token' in params ? 'query' : 'none';
    const type = String(req.headers['content-type'] ?? '');
    if (raw && type.startsWith('application/x-www-form-urlencoded')) {
      for (const [k, v] of new URLSearchParams(raw)) {
        if (k === 'access_token' && tokenIn === 'none') tokenIn = 'body';
        params[k] = v;
      }
    }
    let presented = params.access_token;
    delete params.access_token;
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
    if (presented === undefined && bearer) {
      presented = bearer[1];
      tokenIn = 'header';
    }
    const op = this.route(method, url.pathname);
    const r: ThreadsRequest = {
      op,
      method,
      path: url.pathname,
      params,
      tokenOk: presented === this.token,
      tokenIn,
    };
    this.requests.push(r);
    this.onRequest?.(r);

    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (!r.tokenOk) {
      return json(
        400,
        errorBody({ message: 'Invalid OAuth access token - Cannot parse access token', code: 190 }),
      );
    }
    if (this.now().getTime() >= this.tokenExpiresAt.getTime()) {
      return json(
        400,
        errorBody({
          message: `Error validating access token: Session has expired on ${this.tokenExpiresAt.toISOString()}.`,
          code: 190,
          error_subcode: 463,
        }),
      );
    }
    const reply = this.replies[op]?.shift() ?? { accept: true };
    if ('status' in reply) {
      if (reply.applied === true) this.apply(op, url.pathname, params);
      return json(
        reply.status,
        errorBody({
          message: `fake error ${reply.status}`,
          code: reply.status === 429 ? 4 : 1,
          ...reply.error,
        }),
        reply.retryAfter !== undefined ? { 'retry-after': String(reply.retryAfter) } : {},
      );
    }
    if ('accept' in reply) {
      const a = this.apply(op, url.pathname, params);
      return json(a.status, a.body);
    }
    if (reply.applied !== false) this.apply(op, url.pathname, params);
    if ('raw' in reply) {
      res.writeHead(reply.rawStatus ?? 200, { 'content-type': 'text/html', ...reply.headers });
      res.end(reply.raw);
      return;
    }
    if ('drop' in reply) res.socket?.destroy();
    // `hang`: no answer at all.
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

/** Graph API error body: `{ error: { message, type, code, error_subcode?, fbtrace_id } }`. */
function errorBody(e: FakeError) {
  return {
    error: { message: e.message ?? 'error', type: 'OAuthException', fbtrace_id: 'FAKE', ...e },
  };
}
