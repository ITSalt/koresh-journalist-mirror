import { z } from 'zod';
import type { FeedEntry } from '../lib/feed-types.js';

// Runtime validation of the WP-SVC-07 FeedEntry contract (type in ../lib/feed-types.ts).
export const feedEntrySchema: z.ZodType<FeedEntry> = z.object({
  id: z.string().min(1).max(300),
  at: z.iso.datetime({ offset: true }),
  source: z.string().min(1).max(200),
  title: z.string().max(500).optional(),
  text: z.string().refine((t) => t.trim().length > 0, 'must not be blank'),
  private: z.boolean().optional(),
});

export const feedSchema = z.array(feedEntrySchema).max(5000);

const firstLine = (text: string): string => (text.trim().split(/\r?\n/)[0] ?? '').trim();

/** FeedEntry -> store row: title defaults to the first line of the text, text becomes the summary. */
export function toStoreEntry(e: FeedEntry) {
  const title = e.title?.trim() ? e.title : firstLine(e.text);
  return {
    id: e.id,
    source: e.source,
    title: title.slice(0, 500),
    summary: e.text,
    publishedAt: e.at,
  };
}
