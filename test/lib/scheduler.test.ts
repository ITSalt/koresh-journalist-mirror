import { test } from 'vitest';
import assert from 'node:assert/strict';
import { decide, SchedulerError } from '../../src/lib/scheduler.js';

const day = { date: '2026-10-09', approved: true, rejected: false };
const S = (id: string, at: string) => ({ id, at });
const slots = [
  S('morning', '2026-10-09T09:00:00+03:00'),
  S('noon', '2026-10-09T13:00:00+03:00'),
  S('evening', '2026-10-09T19:00:00+03:00'),
];
const tight = { graceMin: 10, minGapMin: 20 };
const code = (c: string) => (e: unknown) => e instanceof SchedulerError && e.code === c;

test('normal day: before the first slot nothing is published, wake at the slot', () => {
  const d = decide({ day, slots, done: [], now: '2026-10-09T08:00:00+03:00' });
  assert.deepEqual(d, { skip: [], wakeAt: '2026-10-09T06:00:00.000Z' });
});

test('normal day: a slot due exactly now is published', () => {
  const d = decide({ day, slots, done: [], now: '2026-10-09T09:00:00+03:00' });
  assert.deepEqual(d, { publish: 'morning', skip: [] });
});

test('normal day: after morning is done, wake for noon', () => {
  const d = decide({
    day,
    slots,
    done: ['morning'],
    lastPublishedAt: '2026-10-09T09:00:05+03:00',
    now: '2026-10-09T09:30:00+03:00',
  });
  assert.deepEqual(d, { skip: [], wakeAt: '2026-10-09T10:00:00.000Z' });
});

test('all slots done: no publish, no wake', () => {
  const d = decide({
    day,
    slots,
    done: new Set(['morning', 'noon', 'evening']),
    now: '2026-10-09T20:00:00+03:00',
  });
  assert.deepEqual(d, { skip: [] });
});

test('rejected day publishes nothing and skips nothing', () => {
  const d = decide({
    day: { ...day, rejected: true },
    slots,
    done: [],
    now: '2026-10-09T09:00:00+03:00',
  });
  assert.deepEqual(d, { skip: [] });
});

test('unapproved day publishes nothing', () => {
  const d = decide({
    day: { ...day, approved: false },
    slots,
    done: [],
    now: '2026-10-09T09:00:00+03:00',
  });
  assert.deepEqual(d, { skip: [] });
});

test('restart 3 h late: the stale slot is skipped, wake for the next', () => {
  const d = decide({ day, slots, done: [], now: '2026-10-09T12:00:00+03:00' });
  assert.deepEqual(d, { skip: ['morning'], wakeAt: '2026-10-09T10:00:00.000Z' });
});

test('grace boundary: exactly 90 min old is still fresh, one ms more is stale', () => {
  const one = [S('a', '2026-10-09T09:00:00+03:00')];
  assert.deepEqual(decide({ day, slots: one, done: [], now: '2026-10-09T10:30:00+03:00' }), {
    publish: 'a',
    skip: [],
  });
  assert.deepEqual(decide({ day, slots: one, done: [], now: '2026-10-09T10:30:00.001+03:00' }), {
    skip: ['a'],
  });
});

test('two fresh due slots: only the earliest is published, the other is neither published nor skipped', () => {
  const two = [S('a', '2026-10-09T09:00:00+03:00'), S('b', '2026-10-09T09:10:00+03:00')];
  const d = decide({ day, slots: two, done: [], now: '2026-10-09T09:15:00+03:00' });
  assert.deepEqual(d, { publish: 'a', skip: [] });
});

test('slots out of order give the same decision', () => {
  const rev = [...slots].reverse();
  const a = decide({ day, slots: rev, done: [], now: '2026-10-09T13:05:00+03:00' });
  assert.deepEqual(a, { publish: 'noon', skip: ['morning'] });
  assert.deepEqual(a, decide({ day, slots, done: [], now: '2026-10-09T13:05:00+03:00' }));
});

test('MSK across midnight: instants are compared, not wall-clock text', () => {
  const night = [S('late', '2026-10-09T23:50:00+03:00'), S('after', '2026-10-10T00:10:00+03:00')];
  // 21:00Z is 00:00 MSK of the next day: "late" is due, "after" is not
  const d = decide({ day, slots: night, done: [], now: '2026-10-09T21:00:00Z' });
  assert.deepEqual(d, { publish: 'late', skip: [] });
  // as text, 21:05Z sorts before 23:50+03:00; as instants it is after it
  const e = decide({
    day,
    slots: night,
    done: ['late'],
    lastPublishedAt: '2026-10-09T21:00:00Z',
    now: '2026-10-09T21:05:00Z',
  });
  assert.deepEqual(e, { skip: [], wakeAt: '2026-10-09T21:20:00.000Z' });
});

test('the same instant in three notations is one instant', () => {
  const one = [S('a', '2026-10-09T09:00:00+03:00')];
  const want = { publish: 'a', skip: [] };
  assert.deepEqual(decide({ day, slots: one, done: [], now: '2026-10-09T06:00:00Z' }), want);
  assert.deepEqual(
    decide({ day, slots: one, done: [], now: Date.parse('2026-10-09T06:00:00Z') }),
    want,
  );
  assert.deepEqual(
    decide({ day, slots: one, done: [], now: new Date('2026-10-09T06:00:00Z') }),
    want,
  );
});

test('the gap blocks a fresh due slot and wakes at the end of the gap', () => {
  const two = [S('a', '2026-10-09T09:00:00+03:00'), S('b', '2026-10-09T09:10:00+03:00')];
  const d = decide({
    day,
    slots: two,
    done: ['a'],
    lastPublishedAt: '2026-10-09T09:00:00+03:00',
    now: '2026-10-09T09:10:00+03:00',
  });
  assert.deepEqual(d, { skip: [], wakeAt: '2026-10-09T06:20:00.000Z' });
});

test('gap boundary: last + minGap equal to now does not block', () => {
  const two = [S('a', '2026-10-09T09:00:00+03:00'), S('b', '2026-10-09T09:10:00+03:00')];
  const d = decide({
    day,
    slots: two,
    done: ['a'],
    lastPublishedAt: '2026-10-09T09:00:00+03:00',
    now: '2026-10-09T09:20:00+03:00',
  });
  assert.deepEqual(d, { publish: 'b', skip: [] });
});

test('boundary case: grace of the earliest slot ends before the gap does, so skip it and wake for the next eligible', () => {
  // grace 10, gap 20, last publish 09:00, so the gap ends 09:20.
  // a (09:05) lives until 09:15, before 09:20: doomed. b (09:12) lives until 09:22: goes out at 09:20.
  const two = [S('a', '2026-10-09T09:05:00+03:00'), S('b', '2026-10-09T09:12:00+03:00')];
  const d = decide({
    day,
    slots: two,
    done: [],
    lastPublishedAt: '2026-10-09T09:00:00+03:00',
    now: '2026-10-09T09:13:00+03:00',
    rules: tight,
  });
  assert.deepEqual(d, { skip: ['a'], wakeAt: '2026-10-09T06:20:00.000Z' });
});

test('boundary case, future variant: a doomed slot that is not yet due is not skipped early; wake when it becomes due', () => {
  const one = [S('a', '2026-10-09T09:05:00+03:00')];
  const d = decide({
    day,
    slots: one,
    done: [],
    lastPublishedAt: '2026-10-09T09:00:00+03:00',
    now: '2026-10-09T09:01:00+03:00',
    rules: tight,
  });
  assert.deepEqual(d, { skip: [], wakeAt: '2026-10-09T06:05:00.000Z' });
});

test('boundary case, exact edges: a doomed slot due exactly now is skipped; a slot whose grace ends exactly with the gap survives', () => {
  const last = '2026-10-09T09:00:00+03:00';
  const a = decide({
    day,
    slots: [S('a', '2026-10-09T09:05:00+03:00')],
    done: [],
    lastPublishedAt: last,
    now: '2026-10-09T09:05:00+03:00',
    rules: tight,
  });
  assert.deepEqual(a, { skip: ['a'] });
  const b = decide({
    day,
    slots: [S('b', '2026-10-09T09:10:00+03:00')],
    done: [],
    lastPublishedAt: last,
    now: '2026-10-09T09:15:00+03:00',
    rules: tight,
  });
  assert.deepEqual(b, { skip: [], wakeAt: '2026-10-09T06:20:00.000Z' });
});

test('calling again at wakeAt does what the wake promised', () => {
  const two = [S('a', '2026-10-09T09:05:00+03:00'), S('b', '2026-10-09T09:12:00+03:00')];
  const base = { day, slots: two, lastPublishedAt: '2026-10-09T09:00:00+03:00', rules: tight };
  const first = decide({ ...base, done: [], now: '2026-10-09T09:13:00+03:00' });
  const second = decide({ ...base, done: first.skip, now: first.wakeAt! });
  assert.deepEqual(second, { publish: 'b', skip: [] });
});

test('pure: the same input twice gives the same output and the input is not changed', () => {
  const input = {
    day,
    slots: [...slots].reverse(),
    done: ['morning'],
    now: '2026-10-09T13:00:00+03:00',
  };
  const copy = JSON.stringify(input);
  assert.deepEqual(decide(input), decide(input));
  assert.equal(JSON.stringify(input), copy);
});

test('a time without an offset is refused', () => {
  assert.throws(
    () => decide({ day, slots, done: [], now: '2026-10-09T09:00:00' }),
    code('BAD_TIME'),
  );
  assert.throws(() => decide({ day, slots: [S('x', 'soon')], done: [], now: 0 }), code('BAD_TIME'));
  assert.throws(
    () => decide({ day, slots, done: [], now: 0, lastPublishedAt: '2026-10-09' }),
    code('BAD_TIME'),
  );
});

test('a repeated slot id and bad rules are refused', () => {
  const dup = [S('a', '2026-10-09T09:00:00+03:00'), S('a', '2026-10-09T10:00:00+03:00')];
  assert.throws(() => decide({ day, slots: dup, done: [], now: 0 }), code('DUP_SLOT'));
  assert.throws(
    () => decide({ day, slots, done: [], now: 0, rules: { graceMin: -1 } }),
    code('BAD_RULES'),
  );
  assert.throws(
    () => decide({ day, slots, done: [], now: 0, rules: { minGapMin: NaN } }),
    code('BAD_RULES'),
  );
});
