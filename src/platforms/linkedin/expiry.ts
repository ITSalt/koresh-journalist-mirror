// The LinkedIn token of a self-serve app lives 60 days and has no refresh token, so the owner
// repeats the browser consent before it ends. The core asks `expiryReminder` on its own schedule
// and sends `reminderText` to the owner's chat when the state changes (once per state). The
// owner never handles a token (D-5): he opens one link and allows; the service does the rest.
// Pure: no clock, no network.

export type ExpiryReminder = 'none' | 'in_7_days' | 'in_1_day' | 'expired';

const DAY_MS = 86_400_000;

/**
 * `expired` from the expiry instant on; `in_1_day` when one day or less is left; `in_7_days`
 * when seven days or less are left; `none` before that. A date that cannot be read counts as
 * `expired`: an unreadable expiry must never look like a healthy token.
 */
export function expiryReminder(now: Date, expiresAt: Date | string): ExpiryReminder {
  const end = typeof expiresAt === 'string' ? Date.parse(expiresAt) : expiresAt.getTime();
  const left = end - now.getTime();
  if (!Number.isFinite(left) || left <= 0) return 'expired';
  if (left <= DAY_MS) return 'in_1_day';
  if (left <= 7 * DAY_MS) return 'in_7_days';
  return 'none';
}

function formatDate(expiresAt: Date | string, timeZone: string): string {
  const d = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
  const p = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

/** What the owner does: one link, one press. With no link at hand he asks for one. */
function how(link: string | undefined): string {
  const url = link?.trim();
  if (!url) {
    return 'Чтобы продлить доступ, напишите директору: он пришлёт ссылку, по которой нужно только нажать "Разрешить".';
  }
  return (
    `Чтобы продлить доступ, откройте ссылку и нажмите "Разрешить": ${url}\n` +
    'Ссылка одноразовая и действует недолго. Если она уже не открывается, напишите директору, он пришлёт новую.'
  );
}

/**
 * The fixed Russian text for the owner's chat (no long dashes); `null` when nothing is due.
 * The date is shown in `timeZone` (the owner's, Moscow by default). `link` is a fresh connect
 * link of the service; without one the text asks the owner to write to the director.
 */
export function reminderText(
  state: ExpiryReminder,
  expiresAt: Date | string,
  timeZone = 'Europe/Moscow',
  link?: string,
): string | null {
  if (state === 'none') return null;
  const HOW = how(link);
  if (state === 'expired') {
    return `Токен LinkedIn закончился: посты в LinkedIn остановлены, пока доступ не продлён. ${HOW}`;
  }
  const zone = timeZone === 'Europe/Moscow' ? 'по Москве' : `(${timeZone})`;
  const when = `${formatDate(expiresAt, timeZone)} ${zone}`;
  const left = state === 'in_1_day' ? 'не больше суток' : 'не больше 7 дней';
  return `Токен LinkedIn действует до ${when}: осталось ${left}. ${HOW}`;
}
