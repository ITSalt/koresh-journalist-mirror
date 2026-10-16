import type { Config } from '../config.js';
import type { ConnectService } from '../connect/service.js';
import type { VariantPlatform } from '../plan/schema.js';
import type { Publisher, PublisherLogger } from '../publish/publisher.js';
import type { Blocks } from '../publish/types.js';
import {
  createVariantPublisher,
  type FirstComment,
  type VariantPublisher,
} from '../publish/variant-publisher.js';
import type { Store } from '../store/index.js';
import type { FrameOptions } from './frame.js';
import {
  createLinkedInAdapter,
  createLinkedInClient,
  linkPlan,
  nextLinkMode,
  type LinkedInAdapter,
  type LinkedInClient,
  type LinkMode,
} from './linkedin/index.js';
import {
  createThreadsAdapter,
  validate as validateThreads,
  type PublishStep,
  type PublishStepStore,
  type TokenStore,
} from './threads/index.js';
import type { Outcome, Platform, PlatformAdapter, PublishInput } from './types.js';

// The registry of platforms (WP-PLAT-02): what the service publishes to, built from the config
// and from the token stores of the connected accounts.
//
//   telegram  the existing publisher, exactly as `src/index.ts` built it before. It is wrapped,
//             not rewritten: the registry only starts and stops it with the others. It does not
//             go through `PlatformAdapter.publish`: a Telegram slot is photos, polls and
//             multi-part texts with MarkdownV2, which `PublishInput` does not carry.
//   threads, linkedin  one variant loop each (`src/publish/variant-publisher.ts`) over its
//             adapter. An adapter exists only when the account has a token store; a platform
//             without one is absent: `/ready` says so, it is never `required`, and in a dry run
//             its loop still records `dry` rows.
// A platform that cannot be built or started never keeps Telegram from starting.

/**
 * Where a platform's account token lives: the seam of the adapters (`TokenStore` of the Threads
 * adapter). The persistent, encrypted store is the account-connect package's (WP-PLAT-06,
 * `connectWiring`); this file only reads through the seam. `get` throws (or returns '') when no
 * token is stored.
 */
export type PlatformTokenStore = TokenStore;
export type TokenStores = Partial<Record<VariantPlatform, PlatformTokenStore>>;

export interface PlatformStatus {
  /** The adapter exists and its last health check was fine. */
  ok: boolean;
  /** Always false: a platform outside Telegram never makes the service not ready. */
  required: false;
  /** `DRY_RUN_<PLATFORM>`: true = nothing is sent. */
  dryRun: boolean;
  /** False when the adapter is absent (no token store for the account). */
  adapter: 'present' | 'absent';
  detail: string;
  tokenExpiresAt?: string;
}

export interface PlatformRuntime {
  platform: VariantPlatform;
  dryRun: boolean;
  /** Absent when the account has no token store, or when the adapter could not be built. */
  adapter?: PlatformAdapter;
  /** The adapter's pure `validate`: available without a token (the preview uses it). */
  validate(input: PublishInput): { code: string; message: string }[];
  rules: { graceMin: number; minGapMin: number };
  frame: FrameOptions;
  /** `PublishInput.link` of this platform, when it has one. */
  link?: string;
  firstComment?: FirstComment;
  /** Absent when the platform is live without an adapter, or its loop could not be built. */
  loop?: VariantPublisher;
  status(): PlatformStatus;
}

export interface Platforms {
  /** Threads and LinkedIn, in that order. */
  list: PlatformRuntime[];
  /** Starts Telegram first, then each variant loop; a loop that throws stops only itself. */
  start(): void;
  stop(): Promise<void>;
  /** One `health()` per present adapter; the results feed `status()`. Never throws. */
  probe(): Promise<void>;
  status(): Record<VariantPlatform, PlatformStatus>;
  /**
   * When the account token of a platform ends (ISO): what its token store says, else what the
   * last health check reported; undefined when neither knows (or no account is connected).
   */
  tokenExpiresAt(platform: VariantPlatform): string | undefined;
}

export interface PlatformsOptions {
  config: Config;
  store: Store;
  blocks: Pick<Blocks, 'decide'>;
  /** The Telegram publisher as the entry point built it (absent: it does not run). */
  telegram?: Pick<Publisher, 'start' | 'stop'>;
  /** Token stores of the connected accounts; a platform without one has no adapter. */
  tokens?: TokenStores;
  /** Replaces the adapters built from the config (tests: scripted fakes). */
  adapters?: Partial<Record<VariantPlatform, PlatformAdapter>>;
  /** App credentials for LinkedIn token introspection (`health`), when the config has them. */
  linkedinApp?: { clientId?: string; clientSecret?: string };
  scrub?: (s: string) => string;
  now?: () => Date;
  log?: PublisherLogger;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
}

/**
 * What the registry takes from the account-connect package (WP-PLAT-06): the encrypted token
 * store of each account (`get` answers '' while nothing is stored: the adapter is then "not
 * connected") and the LinkedIn app id and secret, which token introspection (`health`) needs.
 */
export function connectWiring(
  connect: Pick<ConnectService, 'tokenStore'>,
  config: Pick<Config, 'LINKEDIN_CLIENT_ID' | 'LINKEDIN_CLIENT_SECRET'>,
): Pick<PlatformsOptions, 'tokens' | 'linkedinApp'> {
  return {
    tokens: { threads: connect.tokenStore('threads'), linkedin: connect.tokenStore('linkedin') },
    linkedinApp: {
      ...(config.LINKEDIN_CLIENT_ID ? { clientId: config.LINKEDIN_CLIENT_ID } : {}),
      ...(config.LINKEDIN_CLIENT_SECRET ? { clientSecret: config.LINKEDIN_CLIENT_SECRET } : {}),
    },
  };
}

/** `bot_state` key: the fingerprint of the ignored platform settings that was last told. */
export const PLATFORM_CONFIG_TOLD = 'platform_config_ignored_sig';

/**
 * One `platform_config` alert per changed value: written when the ignored platform settings
 * (names and values, by their fingerprint) differ from what the last boot told, never again for
 * the same values on a later boot. Settings that were put right are remembered as such, so the
 * same mistake made again later is told again. Returns true when an alert was written.
 */
export function reportIgnoredPlatformSettings(
  store: Pick<Store, 'botState' | 'alerts'>,
  config: Pick<Config, 'PLATFORM_CONFIG_IGNORED' | 'PLATFORM_CONFIG_IGNORED_SIG'>,
  now: Date = new Date(),
): boolean {
  const sig = config.PLATFORM_CONFIG_IGNORED_SIG;
  if ((store.botState.get(PLATFORM_CONFIG_TOLD) ?? '') === sig) return false;
  store.botState.set(PLATFORM_CONFIG_TOLD, sig);
  if (config.PLATFORM_CONFIG_IGNORED.length === 0) return false;
  store.alerts.add(
    {
      kind: 'platform_config',
      message: `invalid values ignored, the defaults are used: ${config.PLATFORM_CONFIG_IGNORED.join(', ')}`,
    },
    now,
  );
  return true;
}

/** `bot_state` key: '1' once LinkedIn answered whether this token may comment (D-2). */
export const LINKEDIN_PROBE_SETTLED = 'linkedin_comment_probe_settled';

const NOT_CONNECTED = 'not_connected: no account token is stored; nothing was sent';
const notConnected = { ok: false, outcome: 'refused', description: NOT_CONNECTED } as const;

/** The token of a store, or undefined when none is stored (the store throws or holds ''). */
function tokenOf(tokens: PlatformTokenStore): string | undefined {
  try {
    const t = tokens.get();
    return typeof t === 'string' && t !== '' ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The two recorded steps of a Threads publish on the variant's publication row (scope item
 * 11a): `set` is one UPDATE of the intent row and is durable when it returns, so the record of
 * step `publish` is on disk before the publish request leaves. A restart then finds it and
 * never sends that request again.
 */
export function rowStepStore(store: Pick<Store, 'publications'>): PublishStepStore {
  return {
    get(key) {
      const raw = store.publications.get(key)?.step;
      return raw === undefined ? undefined : (JSON.parse(raw) as PublishStep);
    },
    set(key, step) {
      store.publications.setStep(key, JSON.stringify(step));
    },
  };
}

function threadsAdapter(o: PlatformsOptions, tokens: PlatformTokenStore): PlatformAdapter {
  const inner = createThreadsAdapter({
    tokens,
    steps: rowStepStore(o.store),
    ...(o.config.THREADS_API_BASE_URL ? { baseUrl: o.config.THREADS_API_BASE_URL } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    platform: 'threads',
    validate: (input) => inner.validate(input),
    // Asked first, so that "no account" is one clear refusal and not a failed quota read.
    publish: async (input) => (tokenOf(tokens) ? inner.publish(input) : notConnected),
    health: async () =>
      tokenOf(tokens) ? inner.health() : { ok: false, detail: 'not connected: no token is stored' },
  };
}

/** A client for the adapter that only validates: no call is ever made through it. */
const NO_CLIENT: LinkedInClient = {
  userinfo: async () => notConnected,
  createPost: async () => notConnected,
  createComment: async () => notConnected,
  introspect: async () => notConnected,
};

function linkedinValidator(config: Config): LinkedInAdapter {
  return createLinkedInAdapter({
    client: NO_CLIENT,
    linkMode: config.LINKEDIN_LINK_MODE,
    textLimit: config.LINKEDIN_TEXT_LIMIT,
  });
}

/**
 * The LinkedIn adapter over a token store. The merged client takes its token as a value, so the
 * adapter is built for the token that is stored now and rebuilt when the store holds another one
 * (the owner connects again every 60 days, without a restart).
 */
function linkedinAdapter(
  o: PlatformsOptions,
  tokens: PlatformTokenStore,
): PlatformAdapter & { linkMode: LinkMode } {
  const { config } = o;
  const validator = linkedinValidator(config);
  let built: { token: string; adapter: LinkedInAdapter } | undefined;
  const current = (): LinkedInAdapter | undefined => {
    const token = tokenOf(tokens);
    if (!token) return undefined;
    if (built?.token !== token) {
      const client = createLinkedInClient({
        token,
        version: config.LINKEDIN_VERSION,
        apiBaseUrl: config.LINKEDIN_API_BASE_URL,
        oauthBaseUrl: config.LINKEDIN_OAUTH_BASE_URL,
        ...(o.linkedinApp?.clientId ? { clientId: o.linkedinApp.clientId } : {}),
        ...(o.linkedinApp?.clientSecret ? { clientSecret: o.linkedinApp.clientSecret } : {}),
        ...(o.fetch ? { fetch: o.fetch } : {}),
        ...(o.sleep ? { retry: { sleep: o.sleep } } : {}),
      });
      built = {
        token,
        adapter: createLinkedInAdapter({
          client,
          linkMode: config.LINKEDIN_LINK_MODE,
          textLimit: config.LINKEDIN_TEXT_LIMIT,
          ...(config.LINKEDIN_AUTHOR_URN ? { authorUrn: config.LINKEDIN_AUTHOR_URN } : {}),
          ...(o.now ? { now: o.now } : {}),
        }),
      };
    }
    return built.adapter;
  };
  return {
    platform: 'linkedin',
    linkMode: config.LINKEDIN_LINK_MODE,
    validate: (input) => validator.validate(input),
    publish: async (input) => current()?.publish(input) ?? notConnected,
    comment: async (postId, text, key) => current()?.comment(postId, text, key) ?? notConnected,
    health: async () =>
      current()?.health() ?? { ok: false, detail: 'not connected: no token is stored' },
  };
}

/**
 * The first comment on LinkedIn (D-2) with the core's own intent rows: `linkPlan` says whether a
 * comment follows the post (always in `comment` mode; once, as the probe, in `inline` mode),
 * `nextLinkMode` reads its outcome. The mode itself is a setting changed by a person; only the
 * "probe settled" flag is stored here.
 */
export function linkedinFirstComment(store: Pick<Store, 'botState'>, mode: LinkMode): FirstComment {
  const settled = () => store.botState.get(LINKEDIN_PROBE_SETTLED) === '1';
  return {
    due: () => linkPlan(mode, settled()).commentAfter,
    settled(outcome: Outcome<{ id: string }>) {
      const decision = nextLinkMode(outcome, mode);
      if (decision.settled) store.botState.set(LINKEDIN_PROBE_SETTLED, '1');
      return decision.alert;
    },
  };
}

interface Health {
  ok: boolean;
  detail: string;
  tokenExpiresAt?: string;
}

export function createPlatforms(o: PlatformsOptions): Platforms {
  const { config, store } = o;
  const now = o.now ?? (() => new Date());
  // The tokens are not in the config, so the config scrubber does not know them.
  const scrub = (s: string) => {
    let out = o.scrub ? o.scrub(s) : s;
    for (const t of Object.values(o.tokens ?? {})) {
      const token = tokenOf(t);
      if (token && token.length >= 6) out = out.split(token).join('[REDACTED]');
    }
    return out;
  };
  const alert = (kind: string, message: string) => {
    try {
      store.alerts.add({ kind, message: scrub(message).slice(0, 1000) }, now());
    } catch {
      // an alert that cannot be written must not stop a start or a stop
    }
  };
  const health = new Map<VariantPlatform, Health>();

  function runtime(platform: VariantPlatform): PlatformRuntime {
    const dryRun = platform === 'threads' ? config.DRY_RUN_THREADS : config.DRY_RUN_LINKEDIN;
    const rules =
      platform === 'threads'
        ? { graceMin: config.THREADS_GRACE_MIN, minGapMin: config.THREADS_MIN_GAP_MIN }
        : { graceMin: config.LINKEDIN_GRACE_MIN, minGapMin: config.LINKEDIN_MIN_GAP_MIN };
    // What decides the wording of the frame on each platform: on Threads the disclaimer
    // switch, on LinkedIn where the link goes.
    const frame: FrameOptions =
      platform === 'threads'
        ? { threadsDisclaimer: config.THREADS_DISCLAIMER }
        : { linkInline: config.LINKEDIN_LINK_MODE === 'inline' };
    const validate =
      platform === 'threads'
        ? (input: PublishInput) => validateThreads(input)
        : (input: PublishInput) => linkedinValidator(config).validate(input);

    let adapter: PlatformAdapter | undefined = o.adapters?.[platform];
    let absent = 'no token store for the account (not connected)';
    const tokens = o.tokens?.[platform];
    if (!adapter && tokens) {
      try {
        adapter = platform === 'threads' ? threadsAdapter(o, tokens) : linkedinAdapter(o, tokens);
      } catch (err) {
        absent = `the adapter could not be built (${(err as Error)?.name ?? 'Error'})`;
        alert('platform_disabled', `${platform}: ${absent}; nothing is published there`);
      }
    }
    const link = platform === 'linkedin' ? config.LINKEDIN_LINK_URL : undefined;
    const firstComment =
      platform === 'linkedin' ? linkedinFirstComment(store, config.LINKEDIN_LINK_MODE) : undefined;

    let loop: VariantPublisher | undefined;
    let noLoop: string | undefined;
    if (dryRun || adapter) {
      try {
        loop = createVariantPublisher({
          store,
          blocks: o.blocks,
          platform,
          adapter,
          dryRun,
          tz: config.TZ_PLAN,
          frame,
          rules,
          scrub,
          ...(link ? { link } : {}),
          ...(firstComment ? { firstComment } : {}),
          ...(o.now ? { now: o.now } : {}),
          ...(o.log ? { log: o.log } : {}),
          ...(o.intervalMs !== undefined ? { intervalMs: o.intervalMs } : {}),
        });
      } catch (err) {
        noLoop = `the publish loop could not be built (${(err as Error)?.name ?? 'Error'})`;
        alert('platform_disabled', `${platform}: ${noLoop}; nothing is published there`);
      }
    } else {
      noLoop = `DRY_RUN_${platform.toUpperCase()}=false without a connected account: the publisher does not run`;
      o.log?.error({ platform }, noLoop);
      alert('platform_disabled', `${platform}: ${noLoop}; nothing is published there`);
    }

    return {
      platform,
      dryRun,
      ...(adapter ? { adapter } : {}),
      validate,
      rules,
      frame,
      ...(link ? { link } : {}),
      ...(firstComment ? { firstComment } : {}),
      ...(loop ? { loop } : {}),
      status(): PlatformStatus {
        const base = { required: false as const, dryRun };
        if (!adapter) {
          return { ...base, ok: false, adapter: 'absent', detail: `adapter absent: ${absent}` };
        }
        const h = health.get(platform);
        const loopNote = noLoop ? `; ${noLoop}` : '';
        if (!h) {
          return {
            ...base,
            ok: false,
            adapter: 'present',
            detail: `health not checked yet${loopNote}`,
          };
        }
        return {
          ...base,
          ok: h.ok && !noLoop,
          adapter: 'present',
          detail: `${h.detail}${loopNote}`,
          ...(h.tokenExpiresAt ? { tokenExpiresAt: h.tokenExpiresAt } : {}),
        };
      },
    };
  }

  const list = (['threads', 'linkedin'] as const).map(runtime);
  const loops: { platform: Platform; loop: { start(): void; stop(): Promise<void> } }[] = [
    ...(o.telegram ? [{ platform: 'telegram' as const, loop: o.telegram }] : []),
    ...list.flatMap((r) => (r.loop ? [{ platform: r.platform, loop: r.loop }] : [])),
  ];

  return {
    list,
    start() {
      // Telegram is first in `loops` and is started exactly as before; the others follow.
      for (const { platform, loop } of loops) {
        if (platform === 'telegram') {
          loop.start();
          continue;
        }
        try {
          loop.start();
        } catch (err) {
          o.log?.error({ err, platform }, 'publish loop did not start');
          alert('platform_disabled', `${platform}: the publish loop did not start`);
        }
      }
    },
    async stop() {
      await Promise.allSettled(loops.map(({ loop }) => loop.stop()));
    },
    async probe() {
      await Promise.allSettled(
        list.map(async (r) => {
          if (!r.adapter) return;
          let h: Health;
          try {
            const got = await r.adapter.health();
            h = { ...got, detail: scrub(got.detail).slice(0, 500) };
          } catch (err) {
            h = { ok: false, detail: `health check failed (${(err as Error)?.name ?? 'Error'})` };
          }
          const before = health.get(r.platform);
          health.set(r.platform, h);
          // Told once, when a platform that was fine stops being fine (not on every boot).
          if (before?.ok && !h.ok) {
            alert('platform_unhealthy', `${r.platform}: ${h.detail}`);
          }
        }),
      );
    },
    status() {
      return Object.fromEntries(list.map((r) => [r.platform, r.status()])) as Record<
        VariantPlatform,
        PlatformStatus
      >;
    },
    tokenExpiresAt(platform) {
      const tokens = o.tokens?.[platform];
      if (tokens && tokenOf(tokens)) {
        try {
          const at = tokens.expiresAt?.();
          if (typeof at === 'string' && Number.isFinite(Date.parse(at))) return at;
        } catch {
          // the health check below may still know
        }
      }
      return health.get(platform)?.tokenExpiresAt;
    },
  };
}
