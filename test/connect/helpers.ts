import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../../src/config.js';
import { createConnectService, type ConnectService } from '../../src/connect/service.js';
import { buildPublicServer, buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { FakeLinkedInOAuth, FakeThreadsOAuth } from '../support/fake-oauth.js';

// One service (the main listener `app` and the public listener `pub`, as src/index.ts builds
// them) with a database file, the two fake platforms and a captured log, for the connect tests. Every secret here is a made-up marker; nothing reaches a real platform.

export const API_TOKEN = 'fake-api-token-for-tests-0123456789';
export const BEARER = { authorization: `Bearer ${API_TOKEN}` };
/** A fake store key: base64 of 32 fixed bytes. */
export const STORE_KEY = Buffer.alloc(32, 0x5a).toString('base64');
export const PUBLIC_BASE = 'https://public.example/koresh';
export const PREFIX = '/koresh';
/** What Caddy adds to every request it forwards. */
export const VIA_PROXY = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' };
export const T0 = new Date('2026-10-16T09:00:00.000Z');

export interface Harness {
  /** The main listener: director API, /health, /ready. */
  app: FastifyInstance;
  /** The public listener: the four public routes. Throws when PUBLIC_BASE gave none. */
  pub: FastifyInstance;
  /** The same, or `undefined` when there is no public listener. */
  publicApp: FastifyInstance | undefined;
  store: Store;
  connect: ConnectService;
  config: Config;
  threads: FakeThreadsOAuth;
  linkedin: FakeLinkedInOAuth;
  dbFile: string;
  /** The test clock; move it with `advance`. */
  now: () => Date;
  advance(ms: number): void;
  /** Everything written to the log so far. */
  logs(): string;
  /** POST /v1/connect/<platform>/start as the director; the state is read out of the link. */
  start(platform: string): Promise<{ url: string; state: string; expiresAt: string }>;
  /** GET the public callback on the public listener, the way Caddy forwards it. */
  callback(
    platform: string,
    query: Record<string, string>,
  ): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }>;
  /** The bytes of the database file and its write-ahead log, as one latin1 string. */
  dbBytes(): string;
  /** A second service over the same file and fakes (a restart). Closes the first store. */
  reopen(): Promise<Harness>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  env?: Record<string, string>;
  rate?: { max?: number; windowMs?: number; now?: () => number };
  /** Reuse a directory and fakes (restart tests). */
  from?: Pick<Harness, 'dbFile' | 'threads' | 'linkedin'> & { at: Date };
}

export async function harness(o: HarnessOptions = {}): Promise<Harness> {
  const dir = o.from ? undefined : mkdtempSync(join(tmpdir(), 'jrn-connect-'));
  const dbFile = o.from?.dbFile ?? join(dir as string, 'journalist.db');
  const threads = o.from?.threads ?? (await new FakeThreadsOAuth().start());
  const linkedin = o.from?.linkedin ?? (await new FakeLinkedInOAuth().start());
  threads.redirectUri = `${PUBLIC_BASE}/oauth/threads/callback`;
  linkedin.redirectUri = `${PUBLIC_BASE}/oauth/linkedin/callback`;
  const config = loadConfig({
    JOURNALIST_API_TOKEN: API_TOKEN,
    TELEGRAM_BOT_TOKEN: 'fake-telegram-token-value',
    PUBLIC_BASE,
    TOKEN_STORE_KEY: STORE_KEY,
    THREADS_APP_ID: threads.appId,
    THREADS_APP_SECRET: threads.appSecret,
    LINKEDIN_CLIENT_ID: linkedin.clientId,
    LINKEDIN_CLIENT_SECRET: linkedin.clientSecret,
    THREADS_API_BASE_URL: threads.baseUrl,
    THREADS_AUTHORIZE_URL: 'https://threads.example/oauth/authorize',
    LINKEDIN_OAUTH_BASE_URL: linkedin.baseUrl,
    LINKEDIN_API_BASE_URL: linkedin.baseUrl,
    ...o.env,
  });
  let clock = (o.from?.at ?? T0).getTime();
  const now = () => new Date(clock);
  const store = openStore(dbFile);
  const lines: string[] = [];
  const connect = createConnectService({
    config,
    store,
    now,
    sleep: async () => {},
    timeoutMs: 400,
  });
  const app = buildServer({
    config,
    store,
    connect,
    now,
    logStream: { write: (l: string) => void lines.push(l) },
    logLevel: 'info',
  });
  const publicApp = buildPublicServer({
    config,
    connect,
    logStream: { write: (l: string) => void lines.push(l) },
    logLevel: 'info',
    publicRate: o.rate ?? { max: 10_000 },
  });
  let closed = false;
  const closeStore = async () => {
    if (closed) return;
    closed = true;
    await app.close();
    await publicApp?.close();
    store.close();
  };

  const h: Harness = {
    app,
    publicApp,
    get pub() {
      if (!publicApp) throw new Error('no public listener: PUBLIC_BASE is not usable');
      return publicApp;
    },
    store,
    connect,
    config,
    threads,
    linkedin,
    dbFile,
    now,
    advance(ms) {
      clock += ms;
    },
    logs: () => lines.join(''),
    async start(platform) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/connect/${platform}/start`,
        headers: BEARER,
      });
      if (res.statusCode !== 200) throw new Error(`start answered ${res.statusCode}: ${res.body}`);
      const body = res.json() as { url: string; expiresAt: string };
      const state = new URL(body.url).searchParams.get('state') ?? '';
      return { ...body, state };
    },
    async callback(platform, query) {
      const res = await h.pub.inject({
        method: 'GET',
        url: `${PREFIX}/oauth/${platform}/callback?${new URLSearchParams(query).toString()}`,
        headers: VIA_PROXY,
      });
      return { statusCode: res.statusCode, body: res.body, headers: res.headers };
    },
    dbBytes() {
      return [dbFile, `${dbFile}-wal`]
        .filter((f) => existsSync(f))
        .map((f) => readFileSync(f).toString('latin1'))
        .join('\n');
    },
    async reopen() {
      await closeStore();
      return harness({ ...o, from: { dbFile, threads, linkedin, at: now() } });
    },
    async close() {
      await closeStore();
      if (!o.from) {
        await threads.stop();
        await linkedin.stop();
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

/** Connects a platform through the real flow; returns what the fake handed out. */
export async function connectNow(h: Harness, platform: 'threads' | 'linkedin') {
  const { state } = await h.start(platform);
  const code = h[platform].issueCode();
  const res = await h.callback(platform, { code, state });
  return { state, code, res, token: h[platform].token };
}
