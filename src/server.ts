import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { SECRET_KEYS, type Config } from './config.js';
import type { PlatformStatus } from './platforms/registry.js';
import type { Store } from './store/index.js';
import type { ChannelProbe } from './telegram/channel.js';
import { registerDirectorApi, type DirectorApiOptions } from './api/director.js';
import {
  registerPublicSurface,
  rejectForwarded,
  safeLogUrl,
  sendFixed,
  type RateOptions,
} from './connect/public.js';
import {
  createConnectService,
  type ConnectService,
  type PlatformOverview,
} from './connect/service.js';

/** What `/ready` says about one platform of the account connect: never more than this. */
type ReadyConnect = Pick<PlatformOverview, 'connected' | 'configured' | 'tokenExpiresAt'>;

export interface ReadyComponent {
  ok: boolean;
  required: boolean;
  detail?: string;
  /** connect only (WP-PLAT-06): informational, per platform. */
  threads?: ReadyConnect;
  linkedin?: ReadyConnect;
  /** telegram only: the publishing mode (D-24): true = nothing is sent. */
  dryRun?: boolean;
  /** telegram only: `getChat(TELEGRAM_CHANNEL).linked_chat_id` presence (D-16, D-17). */
  linkedChatId?: 'present' | 'absent';
  /** inbox only. */
  enabled?: boolean;
  lastPollAt?: string;
  lastError?: string;
  /** threads, linkedin only: whether the adapter exists (its account has a token store). */
  adapter?: 'present' | 'absent';
  /** threads, linkedin only: expiry of the account token, when the platform reports it. */
  tokenExpiresAt?: string;
}

export interface BuildOptions {
  config: Config;
  /** State store; /ready reports `db` from it (not ready when absent). */
  store?: Pick<Store, 'ping'>;
  version?: string;
  /** Rate-limit tuning for failed bearer auth (tests). */
  auth?: DirectorApiOptions['auth'];
  /** Clock for the director API (tests). */
  now?: () => Date;
  /** Destination for log lines (default: stdout). The production logger config is always used. */
  logStream?: { write(line: string): void };
  logLevel?: string;
  /** Pre-flight routes (scope item 15). */
  preflight?: DirectorApiOptions['preflight'];
  /** Owner inbox routes (drafts to OWNER_CHAT_ID). */
  owner?: DirectorApiOptions['owner'];
  /** Inbox poller state for /ready (absent: the poller is disabled). */
  inboxStatus?: () => import('./telegram/inbox.js').InboxStatus | undefined;
  /** Latest getChat probe of the channel (absent: not checked yet, or DRY_RUN). */
  channelProbe?: () => ChannelProbe | undefined;
  /** Account connect (WP-PLAT-06); built from `config` and `store` when absent. */
  connect?: ConnectService;
  /**
   * The platforms outside Telegram (WP-PLAT-02): `/ready` shows one component each, never
   * required. Absent: `/ready` has no such components.
   */
  platformStatus?: () => Record<string, PlatformStatus> | undefined;
}

export interface PublicBuildOptions {
  config: Config;
  /** The same connect service the main listener uses (one store, one set of states). */
  connect: ConnectService;
  logStream?: { write(line: string): void };
  logLevel?: string;
  /** Tuning of the public surface (tests): request limit, directory of the two pages. */
  publicRate?: RateOptions;
  publicDir?: string;
}

const REDACTED = '[REDACTED]';
/** Values shorter than this are not scrubbed by value, to avoid mangling ordinary text. */
const MIN_SCRUB_LENGTH = 6;

/** Returns a function replacing every known secret value (raw and JSON-escaped) in a string. */
export function makeScrubber(config: Config): (line: string) => string {
  const needles = new Set<string>();
  for (const key of SECRET_KEYS) {
    const v = config[key];
    if (typeof v === 'string' && v.length >= MIN_SCRUB_LENGTH) {
      needles.add(v);
      needles.add(JSON.stringify(v).slice(1, -1));
      needles.add(encodeURIComponent(v));
    }
  }
  // Longest first so a secret containing another is replaced whole.
  const list = [...needles].sort((a, b) => b.length - a.length);
  return (line) => list.reduce((acc, n) => acc.split(n).join(REDACTED), line);
}

/** The production pino options: path redaction plus value-based scrubbing of every line. */
export function loggerOptions(config: Config, level = 'info') {
  const scrub = makeScrubber(config);
  return {
    level,
    redact: { paths: redactPaths(), censor: REDACTED },
    serializers: {
      req(req: FastifyRequest) {
        return {
          method: req.method,
          // A callback address holds the code and the state: its query never reaches a log.
          url: safeLogUrl(req.url),
          host: req.headers.host,
          remoteAddress: req.ip,
          headers: req.headers,
        };
      },
    },
    hooks: { streamWrite: scrub },
  };
}

/** Paths pino redacts: every secret config key plus auth headers. */
export function redactPaths(): string[] {
  const keys: string[] = [...SECRET_KEYS];
  return [
    ...keys,
    ...keys.map((k) => `*.${k}`),
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-token"]',
  ];
}

function telegramDetail(config: Config, probe?: ChannelProbe): Partial<ReadyComponent> {
  if (!config.TELEGRAM_BOT_TOKEN) return { detail: 'TELEGRAM_BOT_TOKEN missing' };
  if (probe) {
    return {
      detail: probe.detail,
      ...(probe.linkedChatId ? { linkedChatId: probe.linkedChatId } : {}),
    };
  }
  return { detail: config.DRY_RUN ? 'getChat not checked (DRY_RUN)' : 'getChat not checked yet' };
}

function inboxRest(i: import('./telegram/inbox.js').InboxStatus) {
  return {
    ...(i.lastPollAt ? { lastPollAt: i.lastPollAt } : {}),
    ...(i.lastError ? { lastError: i.lastError } : {}),
  };
}

export function readiness(
  config: Config,
  store?: Pick<Store, 'ping'>,
  probe?: ChannelProbe,
  inbox?: import('./telegram/inbox.js').InboxStatus,
  connect?: Record<'threads' | 'linkedin', PlatformOverview>,
  platforms?: Record<string, PlatformStatus>,
): Record<string, ReadyComponent> {
  const dbOk = store?.ping() ?? false;
  const brief = (p: PlatformOverview): ReadyConnect => ({
    connected: p.connected,
    configured: p.configured,
    ...(p.tokenExpiresAt ? { tokenExpiresAt: p.tokenExpiresAt } : {}),
  });
  return {
    db: {
      ok: dbOk,
      required: true,
      ...(dbOk ? {} : { detail: store ? 'database not responding' : 'store not configured' }),
    },
    telegram: {
      ok: Boolean(config.TELEGRAM_BOT_TOKEN),
      required: true,
      dryRun: config.DRY_RUN,
      ...telegramDetail(config, probe),
    },
    // Informational only: never required, so it cannot turn the service not-ready.
    inbox: inbox
      ? { ok: true, required: false, enabled: true, ...inboxRest(inbox) }
      : {
          ok: true,
          required: false,
          enabled: false,
          detail: config.OWNER_CHAT_ID ? 'poller not running' : 'OWNER_CHAT_ID not set',
        },
    llm: {
      ok: Boolean(config.OPENROUTER_API_KEY),
      required: false,
      ...(config.OPENROUTER_API_KEY ? {} : { detail: 'OPENROUTER_API_KEY missing' }),
    },
    // Informational only (WP-PLAT-06): an unconnected platform never makes the service not-ready.
    ...(connect
      ? {
          connect: {
            ok: true,
            required: false,
            threads: brief(connect.threads),
            linkedin: brief(connect.linkedin),
          },
        }
      : {}),
    // Informational only (`required: false` whatever the registry says): a platform outside
    // Telegram that is absent, unhealthy or not connected never makes the service not ready.
    ...Object.fromEntries(
      Object.entries(platforms ?? {}).map(([name, p]) => [name, { ...p, required: false }]),
    ),
  };
}

export function buildServer(opts: BuildOptions): FastifyInstance {
  const { config } = opts;
  const version = opts.version ?? process.env.GIT_SHA ?? 'dev';
  const app = Fastify({
    logger: {
      ...loggerOptions(config, opts.logLevel ?? process.env.LOG_LEVEL ?? 'info'),
      ...(opts.logStream ? { stream: opts.logStream } : {}),
    },
    // A path the router cannot read (bad percent-encoding, an over-long segment) is answered
    // before any hook runs, by default with the path repeated in the body. Fixed text instead.
    frameworkErrors: (_err, _req, reply) => {
      (reply as unknown as FastifyReply).code(400).send({ error: 'bad request' });
    },
  });

  const fullStore = opts.store && isFullStore(opts.store) ? opts.store : undefined;
  // Account connect (WP-PLAT-06): here only the director's routes and `/ready`. The public
  // routes are NOT on this listener: they have one of their own (`buildPublicServer` below).
  const connect =
    opts.connect ??
    (fullStore ? createConnectService({ config, store: fullStore, now: opts.now }) : undefined);
  // First hook of all, the second lock: a request that came through a proxy reaches nothing here.
  app.addHook('onRequest', rejectForwarded());
  // The default 404 logs the whole URL; this one does not (a query can hold a code).
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));

  /** Informational: a store that does not answer is reported by `db`, not by a failure here. */
  const connectOverview = () => {
    try {
      return connect?.overview();
    } catch {
      return undefined;
    }
  };

  app.get('/health', async () => ({
    status: 'ok',
    version,
    uptimeS: Math.round(process.uptime()),
  }));

  app.get('/ready', async (_req, reply) => {
    const components = readiness(
      config,
      opts.store,
      opts.channelProbe?.(),
      opts.inboxStatus?.(),
      connectOverview(),
      opts.platformStatus?.(),
    );
    const ready = Object.values(components).every((c) => c.ok || !c.required);
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'not_ready', components });
  });

  if (fullStore) {
    registerDirectorApi(app, {
      config,
      store: fullStore,
      auth: opts.auth,
      now: opts.now,
      preflight: opts.preflight,
      owner: opts.owner,
      connect,
    });
  }

  return app;
}

/**
 * The public listener (WP-PLAT-07): a second Fastify instance, for PUBLIC_PORT, that has the
 * four public routes and nothing else. No director route, no `/health`, no `/ready`, no bearer:
 * what is not registered on a port cannot be reached through it, whatever stands in front of it
 * and whatever headers that sends. Same redaction and value scrubbing as the main listener;
 * its lines carry `listener: "public"`.
 *
 * Visitors of the public pages are other people, and the policy says the apps collect no data
 * of other people. So this listener logs one line per request with the method, the path (the
 * values of `code` and `state`, and the whole query of a callback, cut out by `safeLogUrl`) and
 * the status: no header, no client address, no `X-Forwarded-For`, no user agent. The request
 * limit reads `X-Forwarded-For` in memory only. The main listener logs as before.
 * `undefined` when PUBLIC_BASE is not usable: then there is no public listener at all.
 */
export function buildPublicServer(opts: PublicBuildOptions): FastifyInstance | undefined {
  const prefix = opts.connect.publicBase()?.prefix;
  if (prefix === undefined) return undefined;
  const app = Fastify({
    logger: {
      ...loggerOptions(opts.config, opts.logLevel ?? process.env.LOG_LEVEL ?? 'info'),
      // Whatever ever logs a request or a reply here gets these two shapes and nothing more.
      serializers: {
        req: publicRequestLog,
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      mixin: () => ({ listener: 'public' }),
      ...(opts.logStream ? { stream: opts.logStream } : {}),
    },
    // Fastify's own two lines per request carry the headers and the client address.
    disableRequestLogging: true,
    // Answered before any hook runs, by default with the path repeated in the body.
    frameworkErrors: (_err, _req, reply) => {
      sendFixed(reply as unknown as FastifyReply, 'bad_request');
    },
  });
  // The one line per request, after the answer: method, path, status.
  app.addHook('onResponse', async (req, reply) => {
    // `req` goes through the `publicRequestLog` serializer: method and path only.
    req.log.info({ req, status: reply.statusCode }, 'public request');
  });
  registerPublicSurface(app, {
    connect: opts.connect,
    prefix,
    ...(opts.publicRate ? { rate: opts.publicRate } : {}),
    ...(opts.publicDir ? { publicDir: opts.publicDir } : {}),
  });
  return app;
}

/** What the public listener may log about a request: its method and its path. */
function publicRequestLog(req: { method: string; url: string }): { method: string; url: string } {
  return { method: req.method, url: safeLogUrl(req.url) };
}

function isFullStore(s: Pick<Store, 'ping'>): s is Store {
  return 'plans' in s && 'feedEntries' in s;
}
