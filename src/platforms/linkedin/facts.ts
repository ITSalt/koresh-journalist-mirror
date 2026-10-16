// Every LinkedIn platform fact the adapter depends on, one function or constant per fact, so a
// fact that turns out different on the first live call is changed in exactly one place.
// Marks: [read] = taken from LinkedIn's documentation on 12.10.2026 (platforms-plan.md, or the
// builder's own pass over the public pages through a page-extraction tool);
// [assumed] = the documentation did not settle it and nobody has a token yet: each such item is
// listed in the pull request and is to be checked on the first live call.
// Pure: no network, no clock.

/** [read] Create a post as the member. */
export const POSTS_PATH = '/rest/posts';
/** [read] Member id (`sub`) of the token's owner. */
export const USERINFO_PATH = '/v2/userinfo';
/** [read] Token introspection, on the OAuth host (www.linkedin.com), not the API host. */
export const INTROSPECT_PATH = '/oauth/v2/introspectToken';
/** [read] */
export const RESTLI_PROTOCOL_VERSION = '2.0.0';

/** [read] Headers of every `/rest/` call: bearer token, monthly version, Rest.li 2.0.0. */
export function restHeaders(token: string, version: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'linkedin-version': version,
    'x-restli-protocol-version': RESTLI_PROTOCOL_VERSION,
    'content-type': 'application/json',
  };
}

/**
 * [read] Body of a public text post, field for field as in the "Text-Only Post Creation Sample
 * Request" of the Posts API page (raw page read 12.10.2026, view li-lms-2026-09):
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api#text-only-post-creation-sample-request
 * The sample's author is an organization URN; here it is the member's person URN.
 * `PUBLISHED` is the only state accepted on creation.
 */
export function postBody(authorUrn: string, commentary: string): Record<string, unknown> {
  return {
    author: authorUrn,
    commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
}

/** [read] The id of the created post (a share or ugcPost URN) is in the `x-restli-id` header. */
export function postIdFromResponse(headers: Headers): string | undefined {
  const id = headers.get('x-restli-id')?.trim();
  return id ? id : undefined;
}

/** Public address of a post (work package, scope 3). */
export function postUrl(postUrn: string): string {
  return `https://www.linkedin.com/feed/update/${postUrn}/`;
}

/**
 * [read] `x-restli-id` holds `urn:li:share:<n>` or `urn:li:ugcPost:<n>`; an activity URN is
 * accepted too because the comment samples use one. Anything else is not put into a path.
 */
export function isPostUrn(value: string): boolean {
  return /^urn:li:(share|ugcPost|activity):[0-9]+$/.test(value);
}

/**
 * [assumed] `sub` of userinfo is the member id of the person URN. The pages only say "see Sign In
 * with LinkedIn using OpenID Connect to retrieve the Person URN"; `LINKEDIN_AUTHOR_URN` overrides.
 */
export function personUrn(sub: string): string {
  return `urn:li:person:${sub}`;
}

/** [read] Comment on a post: the URN is one path segment, percent-encoded (Rest.li 2.0.0). */
export function commentPath(postUrn: string): string {
  return `/rest/socialActions/${encodeURIComponent(postUrn)}/comments`;
}

/**
 * [read] fields `actor`, `object`, `message.text`; `object` is "the share or the ugcPost which
 * contains the comment", the same URN as in the path.
 * [assumed] `message.text` is plain text (mentions go into `message.attributes`), not little
 * text, so it is sent unescaped.
 */
export function commentBody(
  actorUrn: string,
  postUrn: string,
  text: string,
): Record<string, unknown> {
  return { actor: actorUrn, object: postUrn, message: { text } };
}

/**
 * [read] The answer carries the numeric comment id in `x-restli-id` and in `id`, and the full
 * `commentUrn` (`urn:li:comment:(<thread urn>,<id>)`) in the body. The URN is preferred: it is
 * the key every later call on the comment needs. When the body cannot be read the header alone
 * is enough: the comment exists and its numeric id is known.
 */
export function commentIdFromResponse(headers: Headers, body: unknown): string | undefined {
  const b = body as { commentUrn?: unknown; id?: unknown } | null;
  for (const v of [b?.commentUrn, headers.get('x-restli-id')?.trim(), b?.id]) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/** [read] Introspection is a form post with the app's id and secret and the token. */
export function introspectForm(clientId: string, clientSecret: string, token: string): string {
  return new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    token,
  }).toString();
}

export interface Introspection {
  active: boolean;
  /** `active`, `expired`, `revoked` when LinkedIn reports it. */
  status?: string;
  expiresAt?: Date;
}

/**
 * [read] The introspection answer: `active` (boolean), `status` (`active`, `expired`, `revoked`)
 * and the optional `expires_at` in seconds since the epoch. Returns `undefined` when `active` is
 * not a boolean.
 */
export function parseIntrospection(body: unknown): Introspection | undefined {
  const b = body as { active?: unknown; status?: unknown; expires_at?: unknown } | null;
  if (!b || typeof b.active !== 'boolean') return undefined;
  const out: Introspection = { active: b.active };
  if (typeof b.status === 'string') out.status = b.status;
  const s = Number(b.expires_at);
  if (b.expires_at !== undefined && b.expires_at !== null && Number.isFinite(s) && s > 0) {
    out.expiresAt = new Date(s * 1000);
  }
  return out;
}

/** Fields of LinkedIn's JSON error body that are safe and useful in a description. */
export function errorSummary(body: unknown): string {
  const b = body as { code?: unknown; message?: unknown; error?: unknown } | null;
  if (!b || typeof b !== 'object') return '';
  const parts = [b.code, b.error, b.message].filter(
    (p): p is string => typeof p === 'string' && p !== '',
  );
  return parts.join(' ');
}

/**
 * [read] A version that is no longer served answers 426 with code `NONEXISTENT_VERSION`
 * ("Requested version ... is not active"); a call without the header answers 400 with code
 * `VERSION_MISSING`.
 */
export function isVersionError(status: number, body: unknown): boolean {
  if (status === 426) return true;
  const code = (body as { code?: unknown } | null)?.code;
  return code === 'NONEXISTENT_VERSION' || code === 'VERSION_MISSING';
}

/**
 * [assumed] LinkedIn refuses a post whose content repeats one of the last 10 minutes with 422
 * and the message "Content is a duplicate of {share or UGC URN}". Read on the legacy UGC Post
 * page only; the Posts API page lists a plain 422.
 */
export function isDuplicateError(status: number, body: unknown): boolean {
  const message = (body as { message?: unknown } | null)?.message;
  return status === 422 && typeof message === 'string' && /duplicate/i.test(message);
}

/**
 * Decision D-3 of the program: only a 429 answer to a call that creates a post or a comment
 * means "nothing was created, the same call may be sent again". A 5xx is NOT in this list: it
 * can follow a create that LinkedIn accepted, and the one failure that is not accepted is the
 * same post appearing twice on the owner's profile. So a 5xx on a write is `unknown` and stops
 * at once. (LinkedIn's own 422 for an exact duplicate within 10 minutes is not relied on.)
 */
export function createdNothing(status: number): boolean {
  return status === 429;
}

/**
 * [assumed] A 429 may carry `Retry-After` in whole seconds. The documentation only says the
 * daily limits reset at midnight UTC, so without the header the client backs off on its own.
 */
export function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null || raw.trim() === '') return undefined;
  const s = Number(raw);
  return Number.isFinite(s) && s >= 0 ? Math.ceil(s) : undefined;
}

/**
 * [assumed] How the commentary limit is counted: on the escaped text (as the work package says)
 * in UTF-16 code units, the larger of the usual ways to count, so a text that passes here is
 * not too long for LinkedIn. The limit itself (3000, `LINKEDIN_TEXT_LIMIT`) is read on the
 * legacy UGC Post page only; the Posts API answers 400 FIELD_LENGTH_TOO_LONG above its limit.
 */
export function commentaryLength(escaped: string): number {
  return escaped.length;
}
