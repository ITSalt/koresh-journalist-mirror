// J05: pure publication scheduler. No clock reads, no I/O, no dependence on the host time zone.
// Times are instants: epoch milliseconds, a Date, or an ISO string that carries its own offset.

export type Instant = number | string | Date;
export interface Slot {
  id: string;
  at: Instant;
}
export interface Day {
  date: string;
  approved: boolean;
  rejected: boolean;
}
export interface Rules {
  graceMin?: number;
  minGapMin?: number;
}
export interface Input {
  day: Day;
  slots: Slot[];
  done: Iterable<string>; // ids already published or skipped
  lastPublishedAt?: Instant | null;
  now: Instant;
  rules?: Rules;
}
export interface Decision {
  publish?: string;
  skip: string[];
  wakeAt?: string;
}

export class SchedulerError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
  }
}

const MIN = 60_000;
const HAS_OFFSET = /T.*(Z|[+-][0-9]{2}:?[0-9]{2})$/;

function ms(t: Instant, what: string): number {
  let v = NaN;
  if (typeof t === 'number') v = t;
  else if (t instanceof Date) v = t.getTime();
  else if (typeof t === 'string' && HAS_OFFSET.test(t)) v = Date.parse(t); // no offset = local time = not pure
  if (!Number.isFinite(v))
    throw new SchedulerError('BAD_TIME', what + ' is not an instant with an offset');
  return v;
}

function minutes(x: unknown, dflt: number, what: string): number {
  if (x === undefined) return dflt * MIN;
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) {
    throw new SchedulerError('BAD_RULES', what + ' must be a finite number >= 0');
  }
  return x * MIN;
}

export function decide(input: Input): Decision {
  const now = ms(input.now, 'now');
  const grace = minutes(input.rules?.graceMin, (90 * MIN) / MIN, 'graceMin');
  const minGap = minutes(input.rules?.minGapMin, 20, 'minGapMin');
  const done = new Set(input.done);

  const seen = new Set<string>();
  const pending: { id: string; at: number }[] = [];
  for (const s of input.slots) {
    if (seen.has(s.id)) throw new SchedulerError('DUP_SLOT', 'slot id repeats: ' + s.id);
    seen.add(s.id);
    const at = ms(s.at, 'slot ' + s.id);
    if (!done.has(s.id)) pending.push({ id: s.id, at });
  }
  pending.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // A rejected or not yet approved day: nothing is published and nothing is skipped.
  // Approval is an external event, so there is no instant to wake for.
  if (input.day.rejected || !input.day.approved) return { skip: [] };

  const last = input.lastPublishedAt == null ? null : ms(input.lastPublishedAt, 'lastPublishedAt');
  const gapEnd = last === null ? -Infinity : last + minGap;
  const blocked = gapEnd > now;

  // A slot can still be published at instant t when it is due (at <= t) and not older than grace.
  // The first instant it could go out is max(at, gapEnd); it is doomed if that is already past grace.
  const firstChance = (s: { at: number }) => Math.max(s.at, gapEnd);
  const doomed = (s: { at: number }) => firstChance(s) - s.at > grace;

  const skip: string[] = [];
  const alive: { id: string; at: number }[] = [];
  for (const s of pending) {
    const due = s.at <= now;
    if (due && (now - s.at > grace || doomed(s))) skip.push(s.id);
    else alive.push(s);
  }

  if (!blocked) {
    const first = alive[0];
    if (first !== undefined && first.at <= now) return { publish: first.id, skip };
  }

  // Nothing goes out now. Wake at the first instant when the answer can change:
  // a slot that can be published then, or a doomed future slot that becomes due and must be skipped.
  let wake = Infinity;
  for (const s of alive) wake = Math.min(wake, doomed(s) ? s.at : firstChance(s));
  return Number.isFinite(wake) ? { skip, wakeAt: new Date(wake).toISOString() } : { skip };
}
