// Wall-clock helpers in TZ_PLAN (Moscow) for the evening plan step.

/** Deadline for the director's POST of tomorrow's plan (P-7, director's decision: 22:00 MSK). */
export const POST_DEADLINE = '22:00';

export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Local date (YYYY-MM-DD) and minutes since local midnight of `at` in `tz`. */
export function localClock(at: Date, tz: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const shiftDay = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const nextDay = (date: string) => shiftDay(date, 1);
export const prevDay = (date: string) => shiftDay(date, -1);

/** True when `at` is before `hhmm` local time on the evening before plan `date`. */
export function beforeEveningOf(at: Date, date: string, hhmm: string, tz: string): boolean {
  const l = localClock(at, tz);
  const eve = prevDay(date);
  return l.date < eve || (l.date === eve && l.minutes < toMinutes(hhmm));
}
