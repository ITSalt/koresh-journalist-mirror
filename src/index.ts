import { join } from 'node:path';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createConnectService } from './connect/service.js';
import { createScheduler } from './jobs/evening.js';
import { sendOwnerNotice } from './api/owner-notice.js';
import { planDepsFromConfig } from './plan/build.js';
import { configureVariantFrame, configureVariantGaps } from './plan/variants.js';
import { createExpiryReminder } from './platforms/expiry-reminder.js';
import {
  connectWiring,
  createPlatforms,
  reportIgnoredPlatformSettings,
  type Platforms,
} from './platforms/registry.js';
import { blocks } from './publish/blocks.js';
import { createPublisher, type Publisher } from './publish/publisher.js';
import { buildPublicServer, buildServer, makeScrubber } from './server.js';
import { openStore, type Store } from './store/index.js';
import { inboxPollerFor } from './telegram/inbox.js';
import { createBotApi } from './telegram/bot-api.js';
import { probeChannel, type ChannelProbe } from './telegram/channel.js';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    // 78 = EX_CONFIG: lets a supervisor (RestartPreventExitStatus=78) avoid a restart loop.
    process.exit(78);
  }
  throw err;
}

let store: Store;
try {
  store = openStore(join(config.DATA_DIR ?? './data', 'journalist.db'));
} catch (err) {
  // The production logger (with secret scrubbing) is built without a store just to report this.
  buildServer({ config }).log.error({ err }, 'failed to open the state store');
  process.exit(1);
}
const scrub = makeScrubber(config);
// The plan intake keeps room in a Threads variant for the disclaimer line when it is switched on.
configureVariantFrame({ threadsDisclaimer: config.THREADS_DISCLAIMER });
// ... and refuses two variants of one platform that are closer than the gap its loop keeps.
configureVariantGaps({
  threads: config.THREADS_MIN_GAP_MIN,
  linkedin: config.LINKEDIN_MIN_GAP_MIN,
});
const botApi = config.TELEGRAM_BOT_TOKEN
  ? createBotApi({ token: config.TELEGRAM_BOT_TOKEN, baseUrl: config.TELEGRAM_API_BASE_URL })
  : undefined;
// Long-poll client for getUpdates: its timeout must exceed the 25 s long poll.
const pollApi = config.TELEGRAM_BOT_TOKEN
  ? createBotApi({
      token: config.TELEGRAM_BOT_TOKEN,
      baseUrl: config.TELEGRAM_API_BASE_URL,
      timeoutMs: 35_000,
    })
  : undefined;
let channelProbe: ChannelProbe | undefined;
// Account connect (WP-PLAT-06): callback, encrypted token store, weekly Threads refresh.
const connect = createConnectService({ config, store });
// The four public routes have a listener of their own; `undefined` without a usable PUBLIC_BASE.
const publicApp = buildPublicServer({ config, connect });
/** The owner's private chat: drafts, and the reminder that the LinkedIn token is about to end. */
const owner = {
  chatId: config.OWNER_CHAT_ID,
  api: botApi,
  channel: config.TELEGRAM_CHANNEL,
  scrub,
};
// Threads and LinkedIn (WP-PLAT-02): built below, after the Telegram publisher.
let platforms: Platforms | undefined;
const app = buildServer({
  config,
  store,
  connect,
  channelProbe: () => channelProbe,
  inboxStatus: () => inbox?.status(),
  platformStatus: () => platforms?.status(),
  // Pre-flight (scope item 15): preview reads only; test-publish sends only to TEST_CHANNEL.
  preflight: {
    blocks,
    channel: config.TELEGRAM_CHANNEL,
    testChannel: config.TEST_CHANNEL,
    trailer: config.TG_TRAILER,
    api: botApi,
    scrub,
    platforms: () => platforms?.list ?? [],
  },
  owner,
});
// Evening plan jobs (20:30 fallback, 21:00 no_plan, 23:00 approve). The feed window port stays
// the default "unavailable" one until WP-SVC-17, so the fallback makes no LLM call yet.
const scheduler = createScheduler({
  store,
  tz: config.TZ_PLAN,
  plan: planDepsFromConfig(config, store),
  log: app.log,
});
// Telegram publisher (WP-SVC-11). DRY_RUN (the default) records `dry` rows and sends nothing.
let publisher: Publisher | undefined;
if (config.DRY_RUN || botApi) {
  publisher = createPublisher({
    store,
    blocks,
    api: botApi,
    channel: config.TELEGRAM_CHANNEL,
    dryRun: config.DRY_RUN,
    trailer: config.TG_TRAILER,
    tz: config.TZ_PLAN,
    scrub,
    log: app.log,
  });
} else {
  app.log.error({}, 'DRY_RUN=false without TELEGRAM_BOT_TOKEN: the publisher does not run');
  store.alerts.add({
    kind: 'publisher_disabled',
    message: 'DRY_RUN=false without TELEGRAM_BOT_TOKEN: nothing is published',
  });
}
// The registry of platforms (WP-PLAT-02): Telegram's publisher as built above, plus one variant
// loop per platform outside Telegram. DRY_RUN_THREADS and DRY_RUN_LINKEDIN (default true) record
// `dry` rows and call nothing. The account tokens come from the encrypted token store of the
// account-connect package (WP-PLAT-06); an account that is not connected answers "not
// connected" and `/ready` says so. Nothing here may keep Telegram from starting.
if (config.PLATFORM_CONFIG_IGNORED.length > 0) {
  const names = config.PLATFORM_CONFIG_IGNORED.join(', ');
  app.log.error({ names }, 'invalid platform settings ignored: their defaults are used');
}
try {
  // The log line above is written on every boot; the alert once per changed value.
  reportIgnoredPlatformSettings(store, config);
} catch (err) {
  app.log.error({ err }, 'the platform_config alert could not be written');
}
try {
  platforms = createPlatforms({
    config,
    store,
    blocks,
    telegram: publisher,
    // The accounts' encrypted tokens and the LinkedIn app credentials of the connect package.
    ...connectWiring(connect, config),
    scrub,
    log: app.log,
  });
} catch (err) {
  app.log.error({ err }, 'the platform registry could not be built: Telegram runs alone');
}
// Owner inbox: reads the owner's replies to drafts; runs only with OWNER_CHAT_ID and a token.
const inbox = inboxPollerFor(config, pollApi, { store, log: app.log, scrub });
// getChat (linked discussion group, D-16/D-17) only when live: CI and dry runs make no Bot API call.
const PROBE_MS = 60 * 60_000;
const probe = async () => {
  if (config.DRY_RUN || !botApi) return;
  try {
    channelProbe = await probeChannel(botApi, config.TELEGRAM_CHANNEL, { scrub });
    app.log.info({ telegram: channelProbe.detail }, 'channel probe');
  } catch (err) {
    app.log.error({ err }, 'channel probe failed');
  }
};
// The LinkedIn token lives 60 days and cannot be renewed by the service: 7 days and 1 day
// before it ends (and when it has ended) the owner gets one message in his private chat. By the
// director's decision of 13.10 the message carries no link (a connect link lives 30 minutes): it
// asks the owner to write to the director, who sends a fresh one. `connectLink` stays a port.
const expiryReminder = createExpiryReminder({
  store,
  expiresAt: () => platforms?.tokenExpiresAt('linkedin'),
  send: (text) =>
    sendOwnerNotice(store, owner, { text, label: 'linkedin', ref: 'linkedin-token-expiry' }),
  tz: config.TZ_PLAN,
  scrub,
});
// Health of the connected platforms for /ready; an absent adapter is never called. The reminder
// is looked at after it, so it reads the expiry the check has just reported.
const probePlatforms = () =>
  void (platforms?.probe() ?? Promise.resolve())
    .then(() => expiryReminder.tick())
    .catch((err: unknown) => app.log.error({ err }, 'platform probe failed'));
const probeTimer = setInterval(() => {
  void probe();
  probePlatforms();
}, PROBE_MS);
probeTimer.unref();
// Connect upkeep, hourly: the Threads token is refreshed once a week (the call itself is the
// adapter's), LinkedIn expiry reminders become alerts, used-up states are removed.
const connectTick = async () => {
  try {
    await connect.tick(app.log);
  } catch (err) {
    // The error's class only: nothing of a platform answer may reach a log line this way.
    app.log.error({ error: (err as { name?: string } | null)?.name ?? 'Error' }, 'connect tick');
  }
};
const connectTimer = setInterval(() => void connectTick(), 60 * 60_000);
connectTimer.unref();

app.addHook('onReady', async () => {
  scheduler.start();
  // The registry starts Telegram first, exactly as `publisher.start()`, then the variant loops.
  if (platforms) platforms.start();
  else publisher?.start();
  inbox?.start();
  void probe();
  void connectTick();
  probePlatforms();
});
app.addHook('onClose', async () => {
  clearInterval(probeTimer);
  clearInterval(connectTimer);
  // The public listener shares the store: it stops before the store is closed below.
  await publicApp?.close();
  if (platforms) await platforms.stop();
  else await publisher?.stop();
  await inbox?.stop();
  await scheduler.stop();
  store.close();
});

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
// The public listener (WP-PLAT-07): only with a usable PUBLIC_BASE, only the four public routes.
// If its port cannot be opened the service keeps running and publishing; the connect callback
// and the policy pages are then unreachable, which the alert says.
if (publicApp) {
  try {
    await publicApp.listen({ port: config.PUBLIC_PORT, host: config.HOST });
  } catch (err) {
    app.log.error({ err }, 'public listener failed to start');
    store.alerts.add({
      kind: 'public_listener_failed',
      message: `the public listener could not open port ${config.PUBLIC_PORT}: the connect callback and the policy pages are unreachable, everything else runs`,
    });
  }
}
