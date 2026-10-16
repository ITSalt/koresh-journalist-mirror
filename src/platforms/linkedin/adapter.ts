// The LinkedIn adapter behind the `PlatformAdapter` contract: validate -> publish -> { id, url },
// comment, health. One post as the member through the Posts API, text escaped as little text,
// the link placed by `LINKEDIN_LINK_MODE` (see link-mode.ts for the first-comment probe).
// Nothing here writes a log line or touches a database: the core records the outcomes.

import type { LinkedInClient } from './client.js';
import { DEFAULT_LINKEDIN_TEXT_LIMIT, type LinkMode } from './config.js';
import { escapeLittleText } from './escape.js';
import { expiryReminder } from './expiry.js';
import { commentaryLength, isPostUrn, personUrn, postUrl } from './facts.js';
import type { Outcome, PlatformAdapter, PublishInput } from '../types.js';

/** What stands between the text and the link when the link is the last line of the post. */
export const LINK_SEPARATOR = '\n\n';

/**
 * The plain text of the post as readers see it: the text, and in `inline` mode the link as the
 * last line after an empty line. In `comment` mode the link is left to the first comment.
 */
export function composePlainText(input: PublishInput, mode: LinkMode): string {
  const text = input.text.trimEnd();
  const link = input.link?.trim();
  return mode === 'inline' && link ? `${text}${LINK_SEPARATOR}${link}` : text;
}

/** The `commentary` field: the composed text with every reserved character escaped. */
export function composeCommentary(input: PublishInput, mode: LinkMode): string {
  return escapeLittleText(composePlainText(input, mode));
}

export interface LinkedInAdapter extends PlatformAdapter {
  platform: 'linkedin';
  /** Where this adapter puts the link (`LINKEDIN_LINK_MODE`). */
  readonly linkMode: LinkMode;
  /** The escaped-text limit `validate` checks against (`LINKEDIN_TEXT_LIMIT`). */
  readonly textLimit: number;
  comment(postId: string, text: string, key?: string): Promise<Outcome<{ id: string }>>;
}

export interface LinkedInAdapterOptions {
  client: LinkedInClient;
  /** `urn:li:person:<id>`; when absent it is read once from userinfo and kept. */
  authorUrn?: string;
  linkMode?: LinkMode;
  textLimit?: number;
  now?: () => Date;
}

const refused = (description: string) => ({ ok: false, outcome: 'refused', description }) as const;

export function createLinkedInAdapter(o: LinkedInAdapterOptions): LinkedInAdapter {
  const linkMode = o.linkMode ?? 'inline';
  const textLimit = o.textLimit ?? DEFAULT_LINKEDIN_TEXT_LIMIT;
  const now = o.now ?? (() => new Date());
  let author = o.authorUrn;

  /** The member the token belongs to: one userinfo call, repeated only until it succeeds. */
  async function resolveAuthor(): Promise<Outcome<string>> {
    if (author) return { ok: true, result: author };
    const r = await o.client.userinfo();
    if (!r.ok) return r;
    author = personUrn(r.result.sub);
    return { ok: true, result: author };
  }

  function validate(input: PublishInput): { code: string; message: string }[] {
    const problems: { code: string; message: string }[] = [];
    if (input.text.trim() === '') {
      problems.push({ code: 'empty_text', message: 'the post text is empty' });
    }
    const link = input.link?.trim();
    if (link !== undefined && !/^https?:\/\/\S+$/.test(link)) {
      problems.push({ code: 'bad_link', message: 'the link must be one http(s) address' });
    }
    const length = commentaryLength(composeCommentary(input, linkMode));
    if (length > textLimit) {
      problems.push({
        code: 'too_long',
        message: `the escaped text is ${length} characters, the limit is ${textLimit}`,
      });
    }
    return problems;
  }

  return {
    platform: 'linkedin',
    linkMode,
    textLimit,
    validate,

    async publish(input) {
      const problems = validate(input);
      if (problems.length > 0) {
        return refused(`invalid_input: ${problems.map((p) => p.code).join(', ')}`);
      }
      const who = await resolveAuthor();
      if (!who.ok) return who;
      // The only call that makes something public. It is made once: an unknown outcome is
      // returned as it is and nothing in this module sends the post again.
      const r = await o.client.createPost(who.result, composeCommentary(input, linkMode));
      if (!r.ok) return r;
      return { ok: true, result: { id: r.result.id, url: postUrl(r.result.id) } };
    },

    async comment(postId, text) {
      if (!isPostUrn(postId)) return refused('invalid_input: the post id is not a post URN');
      if (text.trim() === '') return refused('invalid_input: the comment text is empty');
      const who = await resolveAuthor();
      if (!who.ok) return who;
      return o.client.createComment(postId, who.result, text.trim());
    },

    async health() {
      const r = await o.client.introspect();
      if (!r.ok) return { ok: false, detail: r.description };
      const { active, status, expiresAt } = r.result;
      const tokenExpiresAt = expiresAt ? { tokenExpiresAt: expiresAt.toISOString() } : {};
      if (!active) {
        return {
          ok: false,
          detail: `token not active (${status ?? 'no status'})`,
          ...tokenExpiresAt,
        };
      }
      if (!expiresAt) return { ok: true, detail: 'token active, expiry not reported' };
      const reminder = expiryReminder(now(), expiresAt);
      return {
        ok: reminder !== 'expired',
        detail: `token active until ${expiresAt.toISOString()}, reminder: ${reminder}`,
        ...tokenExpiresAt,
      };
    },
  };
}
