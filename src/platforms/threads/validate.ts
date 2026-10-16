import { countLinks, MAX_LINKS } from './platform-facts.js';
import { THREADS_LIMIT, threadsLength } from '../../lib/threads-length.js';
import type { PublishInput } from '../types.js';

export interface Issue {
  code: 'empty_key' | 'empty_text' | 'too_long' | 'too_many_links';
  message: string;
}

/**
 * Pure, no network: everything the platform would refuse at publish time and that can be known
 * the evening before. All issues are listed at once. The text is checked exactly as it will be
 * sent; `link` is not sent to Threads (D-1: the link lives in the profile), so it is not counted.
 */
export function validate(input: PublishInput): Issue[] {
  const issues: Issue[] = [];
  if (typeof input.key !== 'string' || input.key.trim() === '') {
    issues.push({ code: 'empty_key', message: 'the publication key is empty' });
  }
  if (typeof input.text !== 'string' || input.text.trim() === '') {
    issues.push({ code: 'empty_text', message: 'the text is empty' });
    return issues;
  }
  const length = threadsLength(input.text);
  if (length > THREADS_LIMIT) {
    issues.push({
      code: 'too_long',
      message: `the text counts ${length} by rule R1, the limit is ${THREADS_LIMIT}`,
    });
  }
  const links = countLinks(input.text);
  if (links > MAX_LINKS) {
    issues.push({
      code: 'too_many_links',
      message: `the text holds ${links} links, the limit is ${MAX_LINKS}`,
    });
  }
  return issues;
}
