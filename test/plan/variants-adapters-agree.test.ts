import { describe, expect, it } from 'vitest';
import * as planCount from '../../src/lib/threads-length.js';
import {
  LINKEDIN_FRAME_RESERVE,
  LINKEDIN_TEXT_LIMIT,
  VARIANT_LIMITS,
} from '../../src/plan/variants.js';
import { DEFAULT_LINKEDIN_TEXT_LIMIT } from '../../src/platforms/linkedin/config.js';
import { escapeLittleText, LITTLE_TEXT_RESERVED } from '../../src/platforms/linkedin/escape.js';
import { commentaryLength } from '../../src/platforms/linkedin/facts.js';
import * as threads from '../../src/platforms/threads/index.js';

// The plan intake (WP-PLAT-01) and the adapters (WP-PLAT-03, WP-PLAT-04) must count a text the
// same way, or a variant accepted in the evening is refused in the morning. Since WP-PLAT-02
// (scope items 10 and 11c) there is one copy of each fact: the Threads counter lives in
// `src/lib/threads-length.ts` and the adapter re-exports it; the intake counts a LinkedIn text
// after the adapter's own escaping.

describe('the plan intake and the adapters count alike', () => {
  it('Threads: one counter and one limit, the same objects on both sides', () => {
    expect(threads.threadsLength).toBe(planCount.threadsLength);
    expect(threads.fitsThreads).toBe(planCount.fitsThreads);
    expect(threads.THREADS_LIMIT).toBe(planCount.THREADS_LIMIT);
    expect(VARIANT_LIMITS.threads.measure).toBe(planCount.threadsLength);
    expect(VARIANT_LIMITS.threads.limit).toBe(planCount.THREADS_LIMIT);
  });

  it('LinkedIn: one limit; the intake keeps the frame reserve under it', () => {
    expect(LINKEDIN_TEXT_LIMIT).toBe(DEFAULT_LINKEDIN_TEXT_LIMIT);
    expect(VARIANT_LIMITS.linkedin.limit).toBe(DEFAULT_LINKEDIN_TEXT_LIMIT);
    expect(LINKEDIN_FRAME_RESERVE).toBeGreaterThan(0);
    expect(LINKEDIN_FRAME_RESERVE).toBeLessThan(DEFAULT_LINKEDIN_TEXT_LIMIT);
  });

  it('LinkedIn: the intake counts as the adapter does, on the escaped text', () => {
    const texts = [
      'Обычный текст без особых знаков. Что дальше?',
      'Скобки (раз) и [два], решётка #тег, под_черк, зв*зда, тильда ~, труба |, собака @.',
      LITTLE_TEXT_RESERVED.repeat(40),
      'a\\b',
      '',
    ];
    for (const t of texts) {
      expect(VARIANT_LIMITS.linkedin.measure(t), t).toBe(commentaryLength(escapeLittleText(t)));
    }
    // Each reserved character takes two; nothing else changes.
    expect(VARIANT_LIMITS.linkedin.measure('(#_*)')).toBe(10);
    expect(VARIANT_LIMITS.linkedin.measure('привет')).toBe(6);
  });
});
