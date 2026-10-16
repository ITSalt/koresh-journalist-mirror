import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Recorded OpenRouter chat completion; `content` and `usage.cost` are replaced per reply. */
const RECORDED = JSON.parse(
  readFileSync(new URL('../fixtures/openrouter/chat-completion.json', import.meta.url), 'utf8'),
) as {
  model: string;
  choices: { message: { content: string } }[];
  usage: { cost?: number };
};

export type FakeReply =
  { content: string; cost?: number | null } | { status: number; body: unknown } | { hang: true };

export interface FakeRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: {
    model: string;
    messages: { role: string; content: string }[];
    response_format?: unknown;
    usage?: unknown;
  };
}

/**
 * A local stand-in for https://openrouter.ai/api/v1. Replies are taken from a queue in order;
 * with `failOnRequest` every request is an error that the test then asserts on.
 */
export class FakeOpenRouter {
  readonly requests: FakeRequest[] = [];
  readonly replies: FakeReply[] = [];
  failOnRequest = false;
  private server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as FakeRequest['body'];
      this.requests.push({ url: req.url ?? '', headers: req.headers, body });
      if (this.failOnRequest) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'fake: no request was expected' } }));
        return;
      }
      const reply = this.replies.shift();
      if (!reply) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'fake: reply queue is empty' } }));
        return;
      }
      if ('hang' in reply) return; // never answers: exercises the client timeout
      if ('status' in reply) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
        return;
      }
      const out = structuredClone(RECORDED);
      out.model = body.model;
      out.choices[0]!.message.content = reply.content;
      if (reply.cost === null) delete out.usage.cost;
      else if (reply.cost !== undefined) out.usage.cost = reply.cost;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  get baseUrl(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/api/v1`;
  }

  /** Recorded `usage.cost` used when a reply sets none. */
  static readonly recordedCost = RECORDED.usage.cost as number;

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
