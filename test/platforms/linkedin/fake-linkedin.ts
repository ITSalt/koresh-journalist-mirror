import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

// A local stand-in for https://api.linkedin.com and https://www.linkedin.com/oauth, written from
// LinkedIn's public documentation as read on 12.10.2026. Tests never reach the real LinkedIn.
//   POST /rest/posts                         create a post as the member
//   POST /rest/socialActions/{urn}/comments  create a comment
//   GET  /v2/userinfo                        the member id (`sub`)
//   POST /oauth/v2/introspectToken           token state and expiry
// `feed` and `comments` hold what readers would see: an item is in them when the fake accepted
// it, including when the answer is then lost (`drop`, `hang`, `noId`, `cutBody`).
//
// Where the documentation shows a body it is used as shown (VERSION_MISSING, NONEXISTENT_VERSION,
// "Empty oauth2_access_token", the comment answer, the introspection answer, userinfo). Where it
// gives only a status and a message (403, 429, the duplicate 422, wrong introspection
// credentials) the body is built in the general error shape { status, code, message }.
// The fake is stricter than the documentation in two places, on purpose: it refuses a call
// without `X-Restli-Protocol-Version: 2.0.0` and a comment path whose URN is not percent-encoded.

export type Route = 'posts' | 'comments' | 'userinfo' | 'introspect';

export type FakeReply =
  /** Answer with this status and body; nothing is created unless `accepted: true`. */
  | {
      status: number;
      body?: unknown;
      headers?: Record<string, string>;
      raw?: string;
      accepted?: true;
    }
  /** Create the item (unless `accepted: false`), then close the socket without an answer. */
  | { drop: true; accepted?: boolean }
  /** Create the item (unless `accepted: false`) and never answer. */
  | { hang: true; accepted?: boolean }
  /** Create the item and answer 201 without the id header and without a body. */
  | { noId: true }
  /**
   * Create the item and answer 201 with the id header (unless `withoutId`) and a body that is
   * cut off: the socket closes before the announced length has arrived.
   */
  | { cutBody: true; withoutId?: true };

export interface FakeRequest {
  route: Route | 'other';
  method: string;
  /** The path exactly as it came (still percent-encoded). */
  path: string;
  headers: IncomingHttpHeaders;
  /** The raw body. */
  raw: string;
  /** The body as JSON, or the form fields of a form post. */
  body: Record<string, unknown>;
}

export interface FakePost {
  urn: string;
  author: string;
  /** The `commentary` field as received (little text). */
  commentary: string;
  /** The text a reader sees: escapes removed. */
  text: string;
  /** Reserved characters that came without a backslash (none for plain text). */
  unescapedReserved: string[];
}

export interface FakeComment {
  id: string;
  commentUrn: string;
  postUrn: string;
  actor: string;
  text: string;
}

const RESERVED = new Set('|{}@[]()<>#\\*_~');

/** Reads little text the way a reader sees it and lists reserved characters left unescaped. */
export function readLittleText(commentary: string): { text: string; unescapedReserved: string[] } {
  let text = '';
  const unescapedReserved: string[] = [];
  const chars = [...commentary];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const next = chars[i + 1];
    if (ch === '\\' && next !== undefined && RESERVED.has(next)) {
      text += next;
      i++;
    } else {
      if (RESERVED.has(ch)) unescapedReserved.push(ch);
      text += ch;
    }
  }
  return { text, unescapedReserved };
}

export interface FakeLinkedInOptions {
  token: string;
  clientId: string;
  clientSecret: string;
  /** Member id of the token's owner (`sub`). */
  sub?: string;
}

export class FakeLinkedIn {
  readonly requests: FakeRequest[] = [];
  readonly feed: FakePost[] = [];
  readonly comments: FakeComment[] = [];
  /** Reply queues per route; an empty queue answers by the rules below. */
  readonly replies: Partial<Record<Route, FakeReply[]>> = {};
  /** Versions that are served; any other value of `Linkedin-Version` answers 426. */
  activeVersions = new Set(['202609', '202608', '202607']);
  /** False models a token that may not comment (403), the open question of decision D-2. */
  commentsAllowed = true;
  /** What introspection reports. */
  tokenStatus: 'active' | 'expired' | 'revoked' = 'active';
  /** Token expiry, seconds since the epoch. */
  expiresAtS = Math.floor(Date.UTC(2026, 11, 11, 9, 0, 0) / 1000);
  /** An exact duplicate of a post already in the feed answers 422. */
  refuseDuplicates = true;
  /** Commentary longer than this answers 400 FIELD_LENGTH_TOO_LONG. */
  commentaryLimit = 3000;
  readonly sub: string;
  private nextId = 7_250_000_000_000_000_001n;
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;

  constructor(private readonly o: FakeLinkedInOptions) {
    this.sub = o.sub ?? '782bbtaQ';
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.handle(
          req.method ?? '',
          req.url ?? '',
          req.headers,
          Buffer.concat(chunks).toString('utf8'),
          res,
        );
      });
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  /** Base URL for both `apiBaseUrl` and `oauthBaseUrl`. */
  get baseUrl(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  get personUrn(): string {
    return `urn:li:person:${this.sub}`;
  }

  queue(route: Route, ...r: FakeReply[]): this {
    (this.replies[route] ??= []).push(...r);
    return this;
  }

  sent(route?: Route): FakeRequest[] {
    return this.requests.filter((r) => route === undefined || r.route === route);
  }

  private route(method: string, path: string): Route | 'other' {
    if (method === 'POST' && path === '/rest/posts') return 'posts';
    if (method === 'POST' && /^\/rest\/socialActions\/[^/]+\/comments$/.test(path)) {
      return 'comments';
    }
    if (method === 'GET' && path === '/v2/userinfo') return 'userinfo';
    if (method === 'POST' && path === '/oauth/v2/introspectToken') return 'introspect';
    return 'other';
  }

  private createPost(author: string, commentary: string): FakePost {
    const post: FakePost = {
      urn: `urn:li:share:${this.nextId++}`,
      author,
      commentary,
      ...readLittleText(commentary),
    };
    this.feed.push(post);
    return post;
  }

  private createComment(postUrn: string, actor: string, text: string): FakeComment {
    const id = String(this.nextId++);
    const activity = `urn:li:activity:${postUrn.split(':').pop()}`;
    const c: FakeComment = {
      id,
      commentUrn: `urn:li:comment:(${activity},${id})`,
      postUrn,
      actor,
      text,
    };
    this.comments.push(c);
    return c;
  }

  private handle(
    method: string,
    path: string,
    headers: IncomingHttpHeaders,
    raw: string,
    res: ServerResponse,
  ) {
    const route = this.route(method, path);
    const type = String(headers['content-type'] ?? '');
    let body: Record<string, unknown> = {};
    try {
      if (type.startsWith('application/x-www-form-urlencoded')) {
        body = Object.fromEntries(new URLSearchParams(raw));
      } else if (raw.trim() !== '') body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // keep the empty body; the route answers 400 for what is missing
    }
    this.requests.push({ route, method, path, headers, raw, body });

    const json = (status: number, b?: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, {
        ...(b === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      });
      res.end(b === undefined ? undefined : JSON.stringify(b));
    };
    const error = (status: number, code: string, message: string) =>
      json(status, { status, code, message });

    if (route === 'other') return error(404, 'NOT_FOUND', 'Resource not found');

    // What the call would create if it is accepted (posts and comments only).
    let accept: (() => FakePost | FakeComment) | undefined;
    // The answer by the rules; computed before the queue so a queued `drop` can still create.
    let answer: () => void;

    if (route === 'introspect') {
      answer = () => this.introspect(type, body, json, error);
    } else {
      const auth = String(headers.authorization ?? '');
      const denied = this.checkAuth(auth);
      if (denied) answer = () => json(401, denied);
      else if (route === 'userinfo') {
        answer = () =>
          json(200, {
            sub: this.sub,
            name: 'John Doe',
            given_name: 'John',
            family_name: 'Doe',
            locale: 'en-US',
            email: 'doe@email.com',
            email_verified: true,
          });
      } else {
        const version = headers['linkedin-version'];
        if (version === undefined) {
          answer = () =>
            error(
              400,
              'VERSION_MISSING',
              'A version must be present. Please specify a version by adding the Linkedin-Version header.',
            );
        } else if (!this.activeVersions.has(String(version))) {
          answer = () =>
            error(426, 'NONEXISTENT_VERSION', `Requested version ${String(version)} is not active`);
        } else if (headers['x-restli-protocol-version'] !== '2.0.0') {
          answer = () =>
            error(400, 'ILLEGAL_ARGUMENT', 'X-Restli-Protocol-Version 2.0.0 is required');
        } else if (!type.startsWith('application/json')) {
          answer = () => error(400, 'ILLEGAL_ARGUMENT', 'Content-Type must be application/json');
        } else if (route === 'posts') {
          const problem = this.checkPost(body);
          if (problem) answer = () => error(problem[0], problem[1], problem[2]);
          else {
            accept = () => this.createPost(String(body.author), String(body.commentary));
            answer = () => {
              const post = accept!() as FakePost;
              json(201, undefined, { 'x-restli-id': post.urn });
            };
          }
        } else {
          const segment = /^\/rest\/socialActions\/([^/]+)\/comments$/.exec(path)![1]!;
          const problem = this.checkComment(segment, body);
          if (problem) answer = () => error(problem[0], problem[1], problem[2]);
          else {
            const postUrn = decodeURIComponent(segment);
            const message = body.message as { text: string };
            accept = () => this.createComment(postUrn, String(body.actor), message.text);
            answer = () => {
              const c = accept!() as FakeComment;
              const now = 1_760_000_000_000;
              json(
                201,
                {
                  actor: c.actor,
                  commentUrn: c.commentUrn,
                  created: { actor: c.actor, time: now },
                  id: c.id,
                  lastModified: { actor: c.actor, time: now },
                  message: { attributes: [], text: c.text },
                  object: c.commentUrn.slice('urn:li:comment:('.length).split(',')[0],
                },
                { 'x-restli-id': c.id },
              );
            };
          }
        }
      }
    }

    const reply = this.replies[route]?.shift();
    if (!reply) return answer();
    if ('status' in reply) {
      if (reply.accepted) accept?.();
      res.writeHead(reply.status, {
        ...(reply.raw === undefined ? { 'content-type': 'application/json' } : {}),
        ...reply.headers,
      });
      res.end(
        reply.raw ??
          JSON.stringify(
            reply.body ?? {
              status: reply.status,
              code: `FAKE_${reply.status}`,
              message: `fake error ${reply.status}`,
            },
          ),
      );
      return;
    }
    if ('noId' in reply) {
      accept?.();
      res.writeHead(201);
      res.end();
      return;
    }
    if ('cutBody' in reply) {
      const made = accept?.();
      const id = made === undefined ? undefined : 'urn' in made ? made.urn : made.id;
      res.writeHead(201, {
        'content-type': 'application/json',
        'content-length': '4096',
        ...(id !== undefined && !reply.withoutId ? { 'x-restli-id': id } : {}),
      });
      res.write('{"id":');
      setTimeout(() => res.socket?.destroy(), 30);
      return;
    }
    if (reply.accepted !== false) accept?.();
    if ('drop' in reply) res.socket?.destroy();
  }

  /** The 401 body for this Authorization header, or `undefined` when the token is good. */
  private checkAuth(auth: string): Record<string, unknown> | undefined {
    if (auth === '')
      return { message: 'Empty oauth2_access_token', serviceErrorCode: 401, status: 401 };
    const invalid = (message: string) => ({
      status: 401,
      serviceErrorCode: 65600,
      code: 'INVALID_ACCESS_TOKEN',
      message,
    });
    if (auth !== `Bearer ${this.o.token}`) return invalid('Invalid access token');
    if (this.tokenStatus === 'expired') return invalid('The token used in the request has expired');
    if (this.tokenStatus === 'revoked')
      return invalid('The token used in the request has been revoked by the user');
    return undefined;
  }

  private checkPost(body: Record<string, unknown>): [number, string, string] | undefined {
    for (const field of ['author', 'commentary', 'visibility', 'distribution', 'lifecycleState']) {
      if (body[field] === undefined) return [400, 'MISSING_FIELD', `${field} is required`];
    }
    if (body.author !== this.personUrn) {
      return [403, 'ACCESS_DENIED', 'Not enough permissions to access: POST /posts'];
    }
    const commentary = body.commentary;
    if (typeof commentary !== 'string' || commentary.trim() === '') {
      return [400, 'INVALID_VALUE_BLANK_FIELD', 'commentary must not be blank'];
    }
    if (commentary.length > this.commentaryLimit) {
      return [400, 'FIELD_LENGTH_TOO_LONG', 'commentary length exceeds the allowed maximum'];
    }
    if (body.visibility !== 'PUBLIC') return [400, 'INVALID_VALUE_FOR_FIELD', 'visibility'];
    if (body.lifecycleState !== 'PUBLISHED') {
      return [
        400,
        'INVALID_VALUE_FOR_FIELD',
        'PUBLISHED is the only accepted field during creation',
      ];
    }
    const feedDistribution = (body.distribution as { feedDistribution?: unknown } | null)
      ?.feedDistribution;
    if (feedDistribution !== 'MAIN_FEED') {
      return [400, 'INVALID_VALUE_FOR_FIELD', 'distribution.feedDistribution'];
    }
    const twin = this.feed.find((p) => p.author === body.author && p.commentary === commentary);
    if (this.refuseDuplicates && twin) {
      return [422, 'UNPROCESSABLE_ENTITY', `Content is a duplicate of ${twin.urn}`];
    }
    return undefined;
  }

  private checkComment(
    segment: string,
    body: Record<string, unknown>,
  ): [number, string, string] | undefined {
    if (!/^urn%3Ali%3A(share|ugcPost|activity)%3A[0-9]+$/.test(segment)) {
      return [400, 'ILLEGAL_ARGUMENT', 'Syntax exception in path variables'];
    }
    const postUrn = decodeURIComponent(segment);
    if (!this.commentsAllowed) {
      return [
        403,
        'ACCESS_DENIED',
        `Not enough permissions to access: POST /socialActions/${postUrn}/comments`,
      ];
    }
    if (!this.feed.some((p) => p.urn === postUrn)) return [404, 'NOT_FOUND', 'Post not found'];
    if (body.actor !== this.personUrn) {
      return [403, 'ACCESS_DENIED', 'actor is not the authenticated member'];
    }
    if (body.object !== postUrn) return [400, 'INVALID_VALUE_FOR_FIELD', 'object'];
    const text = (body.message as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || text.trim() === '')
      return [400, 'MISSING_FIELD', 'message.text'];
    return undefined;
  }

  private introspect(
    type: string,
    body: Record<string, unknown>,
    json: (status: number, b?: unknown) => void,
    error: (status: number, code: string, message: string) => void,
  ) {
    if (!type.startsWith('application/x-www-form-urlencoded')) {
      return error(
        400,
        'invalid_request',
        'Content-Type must be application/x-www-form-urlencoded',
      );
    }
    if (body.client_id !== this.o.clientId || typeof body.token !== 'string' || body.token === '') {
      return error(400, 'invalid_request', 'Invalid client id or token');
    }
    if (body.client_secret !== this.o.clientSecret) {
      return error(401, 'invalid_client', 'Invalid client secret');
    }
    // A token that does not belong to this app: 200 with active false.
    if (body.token !== this.o.token) return json(200, { active: false });
    json(200, {
      active: this.tokenStatus === 'active',
      client_id: this.o.clientId,
      authorized_at: this.expiresAtS - 60 * 86_400,
      created_at: this.expiresAtS - 60 * 86_400,
      status: this.tokenStatus,
      expires_at: this.expiresAtS,
      scope: 'openid,profile,w_member_social',
      auth_type: '3L',
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
