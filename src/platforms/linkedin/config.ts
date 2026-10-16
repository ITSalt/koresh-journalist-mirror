import { z } from 'zod';

// Settings of the LinkedIn adapter, read from the environment by name. Kept next to the adapter
// (not in `src/config.ts`) so the live service does not change until WP-PLAT-02 wires it in.

/** The default `Linkedin-Version`: 202609 is served until 15.09.2027 (read 12.10.2026). */
export const DEFAULT_LINKEDIN_VERSION = '202609';
/** Commentary limit of a member post, counted on the escaped text. */
export const DEFAULT_LINKEDIN_TEXT_LIMIT = 3000;

export const linkModeSchema = z.enum(['inline', 'comment']);
/** D-2: where the link to the owner's Telegram post goes. */
export type LinkMode = z.infer<typeof linkModeSchema>;

const schema = z.object({
  /** 60-day member token of the owner's self-serve app; there is no refresh token. */
  LINKEDIN_TOKEN: z.string().min(1).optional(),
  /** App credentials: needed only for token introspection (`health`). */
  LINKEDIN_CLIENT_ID: z.string().min(1).optional(),
  LINKEDIN_CLIENT_SECRET: z.string().min(1).optional(),
  /** `urn:li:person:<id>`; when unset it is read once from `GET /v2/userinfo`. */
  LINKEDIN_AUTHOR_URN: z
    .string()
    .regex(/^urn:li:person:[A-Za-z0-9_-]+$/, 'must look like urn:li:person:<id>')
    .optional(),
  /** Monthly API version, YYYYMM. Each version lives about a year: bump it before the sunset. */
  LINKEDIN_VERSION: z
    .string()
    .regex(/^20\d{2}(0[1-9]|1[0-2])$/, 'must be YYYYMM')
    .default(DEFAULT_LINKEDIN_VERSION),
  LINKEDIN_LINK_MODE: linkModeSchema.default('inline'),
  LINKEDIN_TEXT_LIMIT: z.coerce.number().int().positive().default(DEFAULT_LINKEDIN_TEXT_LIMIT),
  /** Base URLs (tests point both at a local fake). */
  LINKEDIN_API_BASE_URL: z.url().default('https://api.linkedin.com'),
  LINKEDIN_OAUTH_BASE_URL: z.url().default('https://www.linkedin.com'),
});

export type LinkedInConfig = z.infer<typeof schema>;

/** Keys whose values are secrets (for log redaction by the core, like `SECRET_KEYS`). */
export const LINKEDIN_SECRET_KEYS = ['LINKEDIN_TOKEN', 'LINKEDIN_CLIENT_SECRET'] as const;

export class LinkedInConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkedInConfigError';
  }
}

export function loadLinkedInConfig(env: Record<string, string | undefined>): LinkedInConfig {
  // Empty strings count as unset, as in the service config.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`)
      .join('; ');
    // Messages never include the offending values, so secrets cannot leak through here.
    throw new LinkedInConfigError(`Invalid LinkedIn configuration: ${issues}`);
  }
  return result.data;
}
