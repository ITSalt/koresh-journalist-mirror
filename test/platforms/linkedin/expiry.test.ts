import { describe, expect, it } from 'vitest';
import { expiryReminder, reminderText } from '../../../src/platforms/linkedin/expiry.js';

const DAY = 86_400_000;
const expiresAt = new Date('2026-12-11T09:00:00.000Z');
const before = (ms: number) => new Date(expiresAt.getTime() - ms);

describe('expiryReminder', () => {
  it('8 days before: none', () => {
    expect(expiryReminder(before(8 * DAY), expiresAt)).toBe('none');
  });

  it('7 days before: in_7_days, and not a millisecond earlier', () => {
    expect(expiryReminder(before(7 * DAY), expiresAt)).toBe('in_7_days');
    expect(expiryReminder(before(7 * DAY + 1), expiresAt)).toBe('none');
    expect(expiryReminder(before(3 * DAY), expiresAt)).toBe('in_7_days');
  });

  it('1 day before: in_1_day, and not a millisecond earlier', () => {
    expect(expiryReminder(before(DAY), expiresAt)).toBe('in_1_day');
    expect(expiryReminder(before(DAY + 1), expiresAt)).toBe('in_7_days');
    expect(expiryReminder(before(1), expiresAt)).toBe('in_1_day');
  });

  it('0 days: expired, and stays expired afterwards', () => {
    expect(expiryReminder(before(0), expiresAt)).toBe('expired');
    expect(expiryReminder(before(-30 * DAY), expiresAt)).toBe('expired');
  });

  it('reads an ISO string; an unreadable date counts as expired, never as healthy', () => {
    expect(expiryReminder(before(8 * DAY), expiresAt.toISOString())).toBe('none');
    expect(expiryReminder(before(DAY), expiresAt.toISOString())).toBe('in_1_day');
    expect(expiryReminder(new Date(), 'not a date')).toBe('expired');
    expect(expiryReminder(new Date(), new Date(NaN))).toBe('expired');
  });
});

describe('reminderText', () => {
  it('says nothing when nothing is due', () => {
    expect(reminderText('none', expiresAt)).toBeNull();
  });

  it('names the date in Moscow time and what to do', () => {
    const week = reminderText('in_7_days', expiresAt)!;
    expect(week).toContain('до 11.12.2026 12:00 по Москве');
    expect(week).toContain('не больше 7 дней');
    expect(week).toContain('напишите директору');
    const day = reminderText('in_1_day', expiresAt.toISOString())!;
    expect(day).toContain('до 11.12.2026 12:00 по Москве');
    expect(day).toContain('не больше суток');
    expect(reminderText('expired', expiresAt)).toContain('закончился');
  });

  // WP-PLAT-02 r1 item 2 (D-5): the owner never handles a token; he opens one link.
  it('carries the fresh connect link when there is one, and never a token generator or a secret', () => {
    const link = 'https://www.linkedin.com/oauth/v2/authorization?state=abc';
    for (const state of ['in_7_days', 'in_1_day', 'expired'] as const) {
      const withLink = reminderText(state, expiresAt, 'Europe/Moscow', link)!;
      expect(withLink).toContain(`откройте ссылку и нажмите "Разрешить": ${link}`);
      const without = reminderText(state, expiresAt)!;
      expect(without).not.toContain('http');
      expect(without).toContain('напишите директору: он пришлёт ссылку');
      for (const text of [withLink, without]) {
        expect(text).not.toMatch(/generator|генератор|LINKEDIN_TOKEN|GitHub|секрет/i);
      }
    }
    // A blank link is no link.
    expect(reminderText('in_1_day', expiresAt, 'Europe/Moscow', '  ')).toBe(
      reminderText('in_1_day', expiresAt),
    );
  });

  it('shows the date in another zone when asked', () => {
    expect(reminderText('in_1_day', expiresAt, 'UTC')).toContain('до 11.12.2026 09:00 (UTC)');
  });

  it('has no long dashes and three different texts', () => {
    const texts = (['in_7_days', 'in_1_day', 'expired'] as const).map((s) =>
      reminderText(s, expiresAt)!,
    );
    // U+2012..U+2015: figure dash, en dash, em dash, horizontal bar.
    const longDash = new RegExp('[\\u2012-\\u2015]');
    for (const t of texts) expect(t).not.toMatch(longDash);
    expect(new Set(texts).size).toBe(3);
  });
});
