import { threadsLength } from '../lib/threads-length.js';
import type { VariantLang, VariantPlatform } from '../plan/schema.js';

// The profile frame of a variant (BRIEF 8, D-1 of program journalist-platforms): what the code
// adds around the stored text (the author's body plus the signature line) when the variant goes
// out. It is never stored in the plan; the plan intake keeps room for it (`src/plan/variants.ts`).
//
//   linkedin  header, empty line, body + signature, empty line, disclaimer. The disclaimer has
//             one wording per link mode: with the link inline (`LINKEDIN_LINK_MODE=inline`) it
//             ends with the link to the owner's Telegram post (`{link}`), with the link in the
//             first comment it says so.
//   threads   body + signature only (D-1: no first comment and no link on Threads; the link is in
//             the profile). The disclaimer line is added only when `THREADS_DISCLAIMER` is on.
// Pure.

export interface FrameLines {
  /** The first line of a LinkedIn post. */
  header: string;
  /** The disclaimer line, by where the link to the owner's Telegram post goes. */
  disclaimer: {
    /** The link is in the first comment (and on Threads, which has no link at all). */
    comment: string;
    /** The link is in the post itself: the wording ends with it (`{link}`). */
    inline: string;
  };
}

/** Owner's wording (D-38 of program journalist): not changed by code. */
const RU_HEADER = 'Новости от Корпорации всевластия';
const RU_DISCLAIMER =
  'пост в рамках исследовательского проекта ИИ-middle-manager, детали: в первом комментарии';

/**
 * Every fixed line of the frame in one table: per language, and for the disclaimer per link
 * mode. The texts are the director's decision of 14.10 (`journalist/kb/linkedin-frame.md` of the
 * workspace), byte for byte; the Russian header and the Russian disclaimer for a link in the
 * first comment are the owner's (D-38) and did not change. `{link}` is where the service puts
 * the link to the owner's original post (`LINKEDIN_LINK_URL`).
 */
export const FRAME_TEXTS: Record<VariantLang, FrameLines> = {
  ru: {
    header: RU_HEADER,
    disclaimer: {
      comment: RU_DISCLAIMER,
      inline:
        'пост в рамках исследовательского проекта ИИ-middle-manager, с чего всё началось: {link}',
    },
  },
  en: {
    header: 'News from Omnipotence Corp.',
    disclaimer: {
      comment:
        "This post is part of a research project: can an AI agent do a middle manager's job? Details in the first comment.",
      inline:
        "This post is part of a research project: can an AI agent do a middle manager's job? How it started: {link}",
    },
  },
};

/** Where a disclaimer takes the link to the owner's original post. */
export const LINK_PLACEHOLDER = '{link}';

/** What stands between two blocks of the frame: one empty line. */
export const FRAME_GAP = '\n\n';

export interface FrameOptions {
  /** `THREADS_DISCLAIMER`: add the disclaimer line to a Threads post (off by default). */
  threadsDisclaimer?: boolean;
  /** LinkedIn: the link is in the post itself (`LINKEDIN_LINK_MODE=inline`). */
  linkInline?: boolean;
  /** The link to the owner's original post, for a disclaimer that carries `{link}`. */
  link?: string;
}

/**
 * True when the frame itself carries the link: LinkedIn with the link inline, a link at hand and
 * a disclaimer with `{link}`. The link is then not handed to the adapter a second time.
 */
export function frameCarriesLink(
  platform: VariantPlatform,
  lang: VariantLang,
  o: FrameOptions = {},
  table: Record<VariantLang, FrameLines> = FRAME_TEXTS,
): boolean {
  return (
    platform === 'linkedin' &&
    Boolean(o.linkInline) &&
    Boolean(o.link?.trim()) &&
    table[lang].disclaimer.inline.includes(LINK_PLACEHOLDER)
  );
}

/**
 * The text that goes to the platform: the stored text inside its frame. `table` is `FRAME_TEXTS`
 * (a parameter so that a test can tell which cell is used).
 */
export function composeVariantText(
  platform: VariantPlatform,
  lang: VariantLang,
  text: string,
  o: FrameOptions = {},
  table: Record<VariantLang, FrameLines> = FRAME_TEXTS,
): string {
  const body = text.trim();
  const f = table[lang];
  if (platform === 'linkedin') {
    // The inline wording names the link; without a link at hand the wording for "no link in the
    // post" is used, so a placeholder never goes out.
    const inline =
      o.linkInline &&
      (frameCarriesLink(platform, lang, o, table) ||
        !f.disclaimer.inline.includes(LINK_PLACEHOLDER));
    const disclaimer = inline
      ? f.disclaimer.inline.split(LINK_PLACEHOLDER).join(o.link?.trim() ?? '')
      : f.disclaimer.comment;
    return [f.header, body, disclaimer].join(FRAME_GAP);
  }
  // Threads has no link: the wording for "no link in the post" applies.
  return o.threadsDisclaimer ? [body, f.disclaimer.comment].join(FRAME_GAP) : body;
}

/**
 * Units (by rule R1) the Threads frame adds to a stored text when the disclaimer is on: the
 * longest of the languages, so one reserve holds for every variant.
 */
export const THREADS_DISCLAIMER_RESERVE = Math.max(
  ...Object.values(FRAME_TEXTS).map((f) => threadsLength(`${FRAME_GAP}${f.disclaimer.comment}`)),
);
