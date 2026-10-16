import { chunkText } from '../lib/chunk.js';
import { decide } from '../lib/scheduler.js';
import { escapeMdV2, md } from '../lib/tg-markdown.js';
import type { Blocks } from './types.js';

/** The real pure blocks (WP-SVC-03, 04, 05) bound to the publisher's `Blocks` port. */
export const blocks: Blocks = { escapeMdV2, md, chunkText, decide };
