import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

// Local stand-ins for the OAuth side of Threads and LinkedIn (WP-PLAT-06). Tests never reach the
// real platforms. Written from the official pages read on 13.10.2026 (see src/connect/oauth.ts):
//
// Threads (one host, like graph.threads.net):
//   POST /oauth/access_token   form: client_id, client_secret, grant_type=authorization_code,
//                              redirect_uri, code -> { access_token (short-lived), user_id }
//                              error: { error_type, code, error_message }
//   GET  /access_token?grant_type=th_exchange_token&client_secret=&access_token=<short>
//                              -> { access_token (long-lived), token_type, expires_in }
//   GET  /v1.0/me?fields=id,username&access_token=   -> { id, username }
//   GET  /refresh_access_token?grant_type=th_refresh_token&access_token=
//                              -> { access_token, token_type, expires_in }
// LinkedIn (one fake serves both the OAuth host and the API host):
//   POST /oauth/v2/accessToken form: grant_type=authorization_code, code, client_id,
//                              client_secret, redirect_uri -> { access_token, expires_in, scope }
//                              error: { error, error_description }
//   GET  /v2/userinfo          Authorization: Bearer -> { sub, name, given_name, ... }
//
// A code is single use, as on the platforms. The refusal texts are the documented ones where the
// pages give one; an `echo` reply answers with an error body that repeats the request's code and
// secret, which is what the leak tests feed the service.

export type FakeReply =
  /** Answer with this status and JSON body instead of carrying the call out. */
  | { status: number; body?: unknown }
  /** An error body that echoes every parameter of the request (code, secret, token). */
  | { echo: number }
  /** Never answer. */
  | { hang: true }
  /** Close the socket without an answer. */
  | { drop: true };

export interface FakeRequest {
  op: string;
  method: string;
  path: string;
  /** Query and form parameters together. */
  params: Record<string, string>;
  authorization?: string;
}

type Handler = (r: FakeRequest) => { status: number; body: unknown };

abstract class FakeHttp {
  readonly requests: FakeRequest[] = [];
  private readonly replies = new Map<string, FakeReply[]>();
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;

  constructor() {
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

  protected abstract route(method: string, path: string): string;
  protected abstract handlers(): Record<string, Handler>;
  /** True when `error` of an error body is an object (Graph API), false when it is a word. */
  protected abstract readonly graphErrors: boolean;

  get baseUrl(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  queue(op: string, ...r: FakeReply[]): this {
    this.replies.set(op, [...(this.replies.get(op) ?? []), ...r]);
    return this;
  }

  sent(op?: string): FakeRequest[] {
    return this.requests.filter((r) => op === undefined || r.op === op);
  }

  ops(): string[] {
    return this.requests.map((r) => r.op);
  }

  private handle(req: IncomingMessage, raw: string, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://fake');
    const params: Record<string, string> = {};
    for (const [k, v] of url.searchParams) params[k] = v;
    if (String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
      for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
    }
    const method = req.method ?? 'GET';
    const r: FakeRequest = {
      op: this.route(method, url.pathname),
      method,
      path: url.pathname,
      params,
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    };
    this.requests.push(r);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const reply = this.replies.get(r.op)?.shift();
    if (reply) {
      if ('hang' in reply) return;
      if ('drop' in reply) return void res.socket?.destroy();
      if ('echo' in reply) {
        // Every free-text field of every error shape the clients read repeats the whole
        // request: the code, the app secret, the token, the bearer header.
        const all = `Bad request: ${JSON.stringify(params)} ${new URLSearchParams(params).toString()} ${r.authorization ?? ''}`;
        return json(reply.echo, {
          error_type: 'OAuthException',
          code: reply.echo,
          error: this.graphErrors
            ? { message: all, type: 'OAuthException', code: 100, fbtrace_id: all }
            : 'invalid_request',
          error_message: all,
          error_description: all,
          message: all,
        });
      }
      return json(reply.status, reply.body ?? { error: { message: 'fake error', code: 1 } });
    }
    const handler = this.handlers()[r.op];
    if (!handler) return json(404, { error: { message: 'Unsupported request.', code: 100 } });
    const a = handler(r);
    json(a.status, a.body);
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

const DAY_S = 24 * 3600;

export class FakeThreadsOAuth extends FakeHttp {
  protected readonly graphErrors = true;
  appId = 'fake-threads-app-id';
  appSecret = 'FAKE-THREADS-APP-SECRET-0001';
  redirectUri = '';
  userId = '17841400000000001';
  username = 'fake_profile';
  expiresInS = 5183944;
  /** Codes handed out by `issueCode` and not used yet. */
  readonly codes = new Set<string>();
  readonly shortTokens = new Set<string>();
  /** The long-lived token the fake accepts now. */
  token = '';
  private seq = 0;

  issueCode(): string {
    const code = `FAKE-THREADS-CODE-${++this.seq}-AQBxhBsH3`;
    this.codes.add(code);
    return code;
  }

  protected route(method: string, path: string): string {
    if (method === 'POST' && path === '/oauth/access_token') return 'code';
    if (method === 'GET' && path === '/access_token') return 'long';
    if (method === 'GET' && path === '/refresh_access_token') return 'refresh';
    if (method === 'GET' && path === '/v1.0/me') return 'me';
    return 'none';
  }

  protected handlers(): Record<string, Handler> {
    const oauthError = (message: string) => ({
      status: 400,
      body: { error_type: 'OAuthException', code: 400, error_message: message },
    });
    const graphError = (message: string, code: number) => ({
      status: 400,
      body: { error: { message, type: 'OAuthException', code, fbtrace_id: 'FAKE' } },
    });
    return {
      code: ({ params: p }) => {
        if (p.client_id !== this.appId || p.client_secret !== this.appSecret) {
          return oauthError('Error validating client secret.');
        }
        if (p.grant_type !== 'authorization_code') return oauthError('Invalid grant_type');
        if (p.redirect_uri !== this.redirectUri) {
          return oauthError('Error validating verification code. redirect_uri mismatch');
        }
        if (!p.code || !this.codes.delete(p.code)) {
          return oauthError('Matching code was not found or was already used');
        }
        const short = `FAKE-THREADS-SHORT-TOKEN-${++this.seq}`;
        this.shortTokens.add(short);
        return { status: 200, body: { access_token: short, user_id: Number(this.userId) } };
      },
      long: ({ params: p }) => {
        if (p.grant_type !== 'th_exchange_token') return graphError('Invalid grant_type', 100);
        if (p.client_secret !== this.appSecret) {
          return graphError('Error validating client secret.', 1);
        }
        if (!p.access_token || !this.shortTokens.delete(p.access_token)) {
          return graphError('Invalid OAuth access token - Cannot parse access token', 190);
        }
        this.token = `FAKE-THREADS-LONG-TOKEN-${++this.seq}`;
        return {
          status: 200,
          body: { access_token: this.token, token_type: 'bearer', expires_in: this.expiresInS },
        };
      },
      me: ({ params: p }) => {
        if (!this.token || p.access_token !== this.token) {
          return graphError('Invalid OAuth access token - Cannot parse access token', 190);
        }
        return { status: 200, body: { id: this.userId, username: this.username } };
      },
      refresh: ({ params: p }) => {
        if (p.grant_type !== 'th_refresh_token') return graphError('Invalid grant_type', 100);
        if (!this.token || p.access_token !== this.token) {
          return graphError('Invalid OAuth access token - Cannot parse access token', 190);
        }
        this.token = `FAKE-THREADS-REFRESHED-TOKEN-${++this.seq}`;
        return {
          status: 200,
          body: { access_token: this.token, token_type: 'bearer', expires_in: 60 * DAY_S },
        };
      },
    };
  }
}

export class FakeLinkedInOAuth extends FakeHttp {
  protected readonly graphErrors = false;
  clientId = 'fake-linkedin-client-id';
  clientSecret = 'FAKE-LINKEDIN-CLIENT-SECRET-0001';
  redirectUri = '';
  sub = '782bbtaQ';
  name = 'John Doe';
  expiresInS = 5184000;
  readonly codes = new Set<string>();
  token = '';
  private seq = 0;

  issueCode(): string {
    const code = `FAKE-LINKEDIN-CODE-${++this.seq}-AQTQmah11lalyH65`;
    this.codes.add(code);
    return code;
  }

  protected route(method: string, path: string): string {
    if (method === 'POST' && path === '/oauth/v2/accessToken') return 'token';
    if (method === 'GET' && path === '/v2/userinfo') return 'userinfo';
    return 'none';
  }

  protected handlers(): Record<string, Handler> {
    const bad = (status: number, error: string, description: string) => ({
      status,
      body: { error, error_description: description },
    });
    return {
      token: ({ params: p }) => {
        if (p.grant_type !== 'authorization_code') {
          return bad(400, 'invalid_request', 'A required parameter "grant_type" is missing');
        }
        if (p.client_id !== this.clientId || p.client_secret !== this.clientSecret) {
          return bad(401, 'invalid_client', 'Client authentication failed');
        }
        if (p.redirect_uri !== this.redirectUri) {
          return bad(
            400,
            'invalid_redirect_uri',
            'Unable to retrieve access token: appid/redirect uri/code verifier does not match authorization code. Or authorization code expired. Or external member binding exists',
          );
        }
        if (!p.code || !this.codes.delete(p.code)) {
          return bad(
            401,
            'invalid_request',
            'Unable to retrieve access token: authorization code not found',
          );
        }
        this.token = `FAKE-LINKEDIN-ACCESS-TOKEN-${++this.seq}`;
        return {
          status: 200,
          body: {
            access_token: this.token,
            expires_in: this.expiresInS,
            scope: 'openid,profile,w_member_social',
            token_type: 'Bearer',
            id_token: `FAKE-LINKEDIN-ID-TOKEN-${this.seq}`,
          },
        };
      },
      userinfo: (r) => {
        if (!this.token || r.authorization !== `Bearer ${this.token}`) {
          return {
            status: 401,
            body: { status: 401, code: 'INVALID_ACCESS_TOKEN', message: 'Invalid access token' },
          };
        }
        return {
          status: 200,
          body: {
            sub: this.sub,
            name: this.name,
            given_name: 'John',
            family_name: 'Doe',
            picture: 'https://media.licdn-ei.com/dms/image/fake/',
            locale: 'en-US',
          },
        };
      },
    };
  }
}
