import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  DEFAULT_LINKEDIN_TEXT_LIMIT,
  DEFAULT_LINKEDIN_VERSION,
  linkModeSchema,
} from './platforms/linkedin/config.js';

const DRY_RUN_MSG = 'must be one of true, false, 1, 0, yes, no (case-insensitive)';

const bool = z.string().transform((v, ctx) => {
  const t = v.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(t)) return true;
  if (['false', '0', 'no'].includes(t)) return false;
  ctx.addIssue({ code: 'custom', message: DRY_RUN_MSG });
  return z.NEVER;
});

const minutes = z.coerce
  .number()
  .min(0)
  .max(24 * 60);

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const optionalText = z.string().trim().min(1).optional();

/**
 * Account connect (WP-PLAT-06). Lenient on purpose: PUBLIC_BASE and TOKEN_STORE_KEY are checked
 * by src/connect/, and a wrong value there switches the connect off with a named reason in
 * `GET /v1/connect`. It never stops the service, which keeps publishing to Telegram.
 */
const connectFields = {
  /** `https://<host>/<prefix>`: the only address the public routes answer under. */
  PUBLIC_BASE: optionalText,
  /**
   * Port of the public listener (WP-PLAT-07): the four public routes and nothing else, on the
   * same HOST as PORT. It is opened only when PUBLIC_BASE is usable.
   */
  PUBLIC_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  /** Base64 of 32 random bytes: the key the platform tokens are encrypted with at rest. */
  TOKEN_STORE_KEY: optionalText,
  THREADS_APP_ID: optionalText,
  THREADS_APP_SECRET: optionalText,
  LINKEDIN_CLIENT_ID: optionalText,
  LINKEDIN_CLIENT_SECRET: optionalText,
  /** When set, a connect by any other account is refused and nothing is stored. */
  THREADS_EXPECTED_USERNAME: optionalText,
  LINKEDIN_EXPECTED_SUB: optionalText,
  /** Platform addresses (tests point them at local fakes). */
  THREADS_AUTHORIZE_URL: z.url().default('https://threads.com/oauth/authorize'),
  THREADS_API_BASE_URL: z.url().default('https://graph.threads.net'),
  LINKEDIN_OAUTH_BASE_URL: z.url().default('https://www.linkedin.com'),
  LINKEDIN_API_BASE_URL: z.url().default('https://api.linkedin.com'),
};

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default('127.0.0.1'),
  /** Zone of the evening plan jobs (20:30, 21:00, 23:00). */
  TZ_PLAN: z
    .string()
    .min(1)
    .refine(isTimeZone, 'must be an IANA time zone')
    .default('Europe/Moscow'),
  DATA_DIR: z.string().min(1).optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHANNEL: z.string().min(1).default('@Channel1'),
  /** D-25: target of POST /v1/test-publish (@name or a numeric chat id); unset -> refused. */
  TEST_CHANNEL: z.string().trim().min(1).optional(),
  /** Private chat of the owner with the bot: drafts go there, replies are read from there. */
  OWNER_CHAT_ID: z.coerce.number().int().positive().optional(),
  /** Bot API base URL (tests point it at a local fake). */
  TELEGRAM_API_BASE_URL: z.url().default('https://api.telegram.org'),
  /** D-16: per-platform trailer appended after the signature at publish time; empty by D-17. */
  TG_TRAILER: z.string().default(''),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().min(1).optional(),
  OPENROUTER_BASE_URL: z.url().default('https://openrouter.ai/api/v1'),
  LLM_DAILY_CAP_USD: z.coerce.number().nonnegative().optional(),
  /** Booked against the daily cap before each LLM call; replaced by `usage.cost` after it.
   *  Must be positive: with 0 and no `usage.cost` the cap would never trip (L-1). */
  LLM_ESTIMATE_USD: z.coerce.number().positive().default(0.1),
  /** Comma-separated OpenRouter model ids for `npm run bakeoff`. */
  BAKEOFF_MODELS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
    ),
  JOURNALIST_API_TOKEN: z.string().min(1).optional(),
  DRY_RUN: bool.default(true),
  ...connectFields,
  // ---- platforms outside Telegram (WP-PLAT-02). The account tokens are not here: they live in
  // the token store of the account-connect package and never pass through the environment. The
  // platform base URLs (THREADS_API_BASE_URL, LINKEDIN_API_BASE_URL, LINKEDIN_OAUTH_BASE_URL)
  // are the connect package's fields above and serve both.
  /** Per-platform publishing mode (default true): `dry` rows, no call to the platform. */
  DRY_RUN_THREADS: bool.default(true),
  DRY_RUN_LINKEDIN: bool.default(true),
  /** Scheduler rules per platform (minutes): how late a variant may go, and the gap between two. */
  THREADS_GRACE_MIN: minutes.default(90),
  THREADS_MIN_GAP_MIN: minutes.default(20),
  LINKEDIN_GRACE_MIN: minutes.default(90),
  LINKEDIN_MIN_GAP_MIN: minutes.default(20),
  /** Adds the disclaimer line to Threads posts; the plan intake then keeps room for it. */
  THREADS_DISCLAIMER: bool.default(false),
  /** The owner's original Telegram post (D-2): the last line of a LinkedIn post, or its first comment. */
  LINKEDIN_LINK_URL: z
    .string()
    .regex(/^https?:\/\/\S+$/, 'must be one http(s) address')
    .default('https://t.me/Channel1/57'),
  /** D-2: `inline` (the link ends the last line of the post) or `comment` (the first comment). */
  LINKEDIN_LINK_MODE: linkModeSchema.default('inline'),
  /** Monthly API version, YYYYMM. Each version lives about a year: bump it before the sunset. */
  LINKEDIN_VERSION: z
    .string()
    .regex(/^20\d{2}(0[1-9]|1[0-2])$/, 'must be YYYYMM')
    .default(DEFAULT_LINKEDIN_VERSION),
  LINKEDIN_TEXT_LIMIT: z.coerce.number().int().positive().default(DEFAULT_LINKEDIN_TEXT_LIMIT),
  /** `urn:li:person:<id>`; when unset it is read once from `GET /v2/userinfo`. */
  LINKEDIN_AUTHOR_URN: z
    .string()
    .regex(/^urn:li:person:[A-Za-z0-9_-]+$/, 'must look like urn:li:person:<id>')
    .optional(),
});

export type Config = z.infer<typeof schema> & {
  /**
   * Names (never values) of platform settings whose value was not valid and was replaced by the
   * default. A wrong value for Threads or LinkedIn must not keep the service from starting, so
   * these keys fall back instead of failing the boot; the entry point writes one alert.
   */
  PLATFORM_CONFIG_IGNORED: string[];
  /**
   * A fingerprint (sha256) of the ignored names with their values, '' when nothing is ignored.
   * The entry point compares it with the one of the last boot, so the alert is written once per
   * changed value and not on every boot. The values themselves are not kept anywhere.
   */
  PLATFORM_CONFIG_IGNORED_SIG: string;
};

/**
 * The settings of the platforms outside Telegram (WP-PLAT-02). Every default is the safe side
 * (dry run, link inline), so an invalid value falls back to it: see `PLATFORM_CONFIG_IGNORED`.
 */
export const PLATFORM_KEYS = [
  'DRY_RUN_THREADS',
  'DRY_RUN_LINKEDIN',
  'THREADS_GRACE_MIN',
  'THREADS_MIN_GAP_MIN',
  'LINKEDIN_GRACE_MIN',
  'LINKEDIN_MIN_GAP_MIN',
  'THREADS_DISCLAIMER',
  'LINKEDIN_LINK_URL',
  'LINKEDIN_LINK_MODE',
  'LINKEDIN_VERSION',
  'LINKEDIN_TEXT_LIMIT',
  'LINKEDIN_AUTHOR_URN',
] as const satisfies readonly (keyof z.infer<typeof schema>)[];

/** Config keys whose values are secrets; used for log redaction. */
export const SECRET_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'OPENROUTER_API_KEY',
  'JOURNALIST_API_TOKEN',
  'THREADS_APP_SECRET',
  'LINKEDIN_CLIENT_SECRET',
  'TOKEN_STORE_KEY',
] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings as unset so `KEY=` in an env file behaves like a missing key.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  // A platform setting that is not valid is dropped (its default applies) and named: it never
  // fails the boot of a service whose Telegram side is fine.
  const ignored: string[] = [];
  const fingerprint = createHash('sha256');
  for (const key of PLATFORM_KEYS) {
    if (cleaned[key] !== undefined && !schema.shape[key].safeParse(cleaned[key]).success) {
      fingerprint.update(`${key}=${cleaned[key]}\n`);
      delete cleaned[key];
      ignored.push(key);
    }
  }
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`)
      .join('; ');
    // Messages never include the offending values, so secrets cannot leak through here.
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  return {
    ...result.data,
    PLATFORM_CONFIG_IGNORED: ignored,
    PLATFORM_CONFIG_IGNORED_SIG: ignored.length > 0 ? fingerprint.digest('hex') : '',
  };
}
