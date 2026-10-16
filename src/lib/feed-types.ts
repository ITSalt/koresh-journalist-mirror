// Copied from the WP-SVC-07 contract (work-packages/WP-SVC-07-log-window.md, Contract row).
// The board's `src/lib/feed.ts` will import this type later.
export type FeedEntry = {
  id: string;
  at: string; // ISO
  source: string;
  title?: string;
  text: string;
  private?: boolean;
};
