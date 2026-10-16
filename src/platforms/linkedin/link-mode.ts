// Where the link to the owner's Telegram post goes on LinkedIn (decision D-2 of the program).
//
// The documentation disagrees on whether a self-serve token (`w_member_social`) may comment, so:
//   - from the first post on, the link is the last line of the post (`LINKEDIN_LINK_MODE=inline`,
//     the default);
//   - the first live post also tries the first comment once: the probe;
//   - LinkedIn accepts the comment -> an alert tells the director to set
//     `LINKEDIN_LINK_MODE=comment`; from then on the post goes out without the link and the link
//     is the first comment;
//   - LinkedIn answers 403 (`comment_forbidden`) -> the question is settled: the mode stays
//     `inline` and an alert says so;
//   - anything else (401, a version error, a 400, a lost answer, a 429 that never clears) is not
//     an answer to the question: the mode stays as it is, an alert carries the code, and the
//     probe is not settled, so it can be tried on a later post.
// The mode is a setting changed by a person: nothing here switches it on its own.
//
// How the core (WP-PLAT-02) uses this file:
//   1. keep one stored flag "probe settled" for LinkedIn (false at the start);
//   2. per post either call `publishWithLink(adapter, input, { probeSettled })`, or do the same
//      steps with its own intent rows: `adapter.publish(input)`; when the post is `sent` and
//      `linkPlan(adapter.linkMode, probeSettled).commentAfter` is true, ONE
//      `adapter.comment(postId, linkText, key)`; then `nextLinkMode(commentOutcome, mode)`;
//   3. send `decision.alert` if there is one and store `decision.settled`.
// Rules that hold in both cases: the comment is tried at most once per post; whatever happens to
// the comment, the post is neither sent again nor reported differently; a comment with an
// `unknown` outcome is never resent.

import { errorCodeOf } from './client.js';
import type { LinkMode } from './config.js';
import type { Outcome, PlatformAdapter, PublishInput } from '../types.js';

export interface LinkPlan {
  /** The link is the last line of the post text. */
  inlineLink: boolean;
  /** One comment with the link is tried after the post is public. */
  commentAfter: boolean;
  /** The comment is the probe (the link is in the post as well). */
  probe: boolean;
}

export function linkPlan(mode: LinkMode, probeSettled: boolean): LinkPlan {
  if (mode === 'comment') return { inlineLink: false, commentAfter: true, probe: false };
  return { inlineLink: true, commentAfter: !probeSettled, probe: !probeSettled };
}

export type LinkAlertKind =
  | 'linkedin_comment_works'
  | 'linkedin_comment_forbidden'
  | 'linkedin_comment_refused'
  | 'linkedin_comment_failed'
  | 'linkedin_comment_unknown';

export interface LinkDecision {
  /** The mode to use from the next post on (a recommendation: the variable is set by a person). */
  mode: LinkMode;
  /**
   * True only when LinkedIn answered the question "may this token comment": the comment was
   * created, or it was refused with 403. False means the probe may be tried on a later post.
   */
  settled: boolean;
  /** For the director; `null` when there is nothing to tell. */
  alert: { kind: LinkAlertKind; text: string } | null;
}

/**
 * What a comment outcome means for the link mode. Pure.
 * `current` is the mode the post was made in (`inline` for the probe).
 */
export function nextLinkMode(
  result: Outcome<{ id: string }>,
  current: LinkMode = 'inline',
): LinkDecision {
  if (result.ok) {
    if (current === 'comment') return { mode: 'comment', settled: true, alert: null };
    return {
      mode: 'comment',
      settled: true,
      alert: {
        kind: 'linkedin_comment_works',
        text: 'LinkedIn accepted the first comment: comment works, switch LINKEDIN_LINK_MODE to comment. This one post carries the link twice.',
      },
    };
  }
  const code = errorCodeOf(result);
  if (result.outcome === 'refused' && code === 'comment_forbidden') {
    return {
      mode: 'inline',
      settled: true,
      alert: {
        kind: 'linkedin_comment_forbidden',
        text:
          current === 'comment'
            ? `LinkedIn refused the first comment (${result.description}): this post has no link. Switch LINKEDIN_LINK_MODE back to inline.`
            : `LinkedIn refused the first comment (${result.description}): comment forbidden, staying inline.`,
      },
    };
  }
  const tail =
    current === 'comment'
      ? 'This post has no link; the comment is not sent again automatically.'
      : 'The link is in the post; the mode stays inline and the probe is not settled.';
  if (result.outcome === 'refused') {
    // Not a 403: a dead token, a sunset version, a wrong body or a local refusal says nothing
    // about whether this token may comment.
    return {
      mode: current,
      settled: false,
      alert: {
        kind: 'linkedin_comment_refused',
        text: `The first comment was refused for another reason than 403 (${code ?? 'no code'}: ${result.description}). ${tail}`,
      },
    };
  }
  if (result.outcome === 'unknown') {
    return {
      mode: current,
      settled: false,
      alert: {
        kind: 'linkedin_comment_unknown',
        text: `The first comment may or may not be public (${result.description}). ${tail}`,
      },
    };
  }
  return {
    mode: current,
    settled: false,
    alert: {
      kind: 'linkedin_comment_failed',
      text: `The first comment was not created (${result.description}). ${tail}`,
    },
  };
}

export interface LinkFlowResult {
  /** The outcome of the post, exactly as the adapter returned it. */
  post: Outcome<{ id: string; url?: string }>;
  /** Present only when a comment was tried. */
  comment?: Outcome<{ id: string }>;
  /** Present only when a comment was tried. */
  decision?: LinkDecision;
}

/**
 * One post and, when the plan says so, one comment with the link. The post is published once;
 * the comment is tried at most once and only after the post is known to be public; a comment
 * that fails, is refused, throws or stays unknown changes nothing about the post.
 */
export async function publishWithLink(
  adapter: PlatformAdapter & { readonly linkMode: LinkMode },
  input: PublishInput,
  state: { probeSettled: boolean; commentText?: string },
): Promise<LinkFlowResult> {
  const post = await adapter.publish(input);
  const link = input.link?.trim();
  const plan = linkPlan(adapter.linkMode, state.probeSettled);
  if (!post.ok || !link || !plan.commentAfter || !adapter.comment) return { post };
  let comment: Outcome<{ id: string }>;
  try {
    comment = await adapter.comment(post.result.id, state.commentText ?? link, input.key);
  } catch (err) {
    const name = (err as { name?: string } | null)?.name ?? 'Error';
    comment = { ok: false, outcome: 'unknown', description: `no_answer: create comment: ${name}` };
  }
  return { post, comment, decision: nextLinkMode(comment, adapter.linkMode) };
}
