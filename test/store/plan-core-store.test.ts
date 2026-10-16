import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../src/store/index.js';

const open: Store[] = [];
function mk(): Store {
  const s = openStore(':memory:');
  open.push(s);
  return s;
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

describe('migration 002: alerts', () => {
  it('creates the alerts table and records 002', () => {
    const s = mk();
    expect(s.migrationsApplied).toContain('002_alerts.sql');
    s.alerts.add({ kind: 'llm_cap', message: 'over the cap' }, new Date('2026-10-09T10:00:00Z'));
    s.alerts.add({ kind: 'other', message: 'second' });
    const l = s.alerts.list();
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({
      kind: 'llm_cap',
      message: 'over the cap',
      at: '2026-10-09T10:00:00.000Z',
    });
  });
});

describe('feedback.listSince', () => {
  it('returns feedback at or after the instant, oldest first', () => {
    const s = mk();
    s.feedback.add(
      { planDate: '2026-09-20', verdict: 'like', note: 'old' },
      new Date('2026-09-20T10:00:00Z'),
    );
    s.feedback.add(
      { planDate: '2026-10-01', verdict: 'dislike', note: 'edge' },
      new Date('2026-10-01T00:00:00Z'),
    );
    s.feedback.add(
      { planDate: '2026-10-05', verdict: 'like', note: 'new' },
      new Date('2026-10-05T00:00:00Z'),
    );
    const l = s.feedback.listSince(new Date('2026-10-01T00:00:00Z'));
    expect(l.map((f) => f.note)).toEqual(['edge', 'new']);
  });

  it('add still defaults the time to now', () => {
    const s = mk();
    const before = Date.now();
    const f = s.feedback.add({ planDate: '2026-10-05', verdict: 'like' });
    expect(Date.parse(f.at)).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('plans.listBefore', () => {
  it('returns up to N plans before the date, newest first, without rejected and failed', () => {
    const s = mk();
    for (const [date, status] of [
      ['2026-10-01', 'approved'],
      ['2026-10-02', 'approved'],
      ['2026-10-03', 'rejected'],
      ['2026-10-04', 'failed'],
      ['2026-10-05', 'draft'],
      ['2026-10-06', 'approved'],
      ['2026-10-07', 'approved'],
    ] as const) {
      s.plans.upsert({ date, status, json: '{}', md: '' });
    }
    expect(s.plans.listBefore('2026-10-07', 3).map((p) => p.date)).toEqual([
      '2026-10-06',
      '2026-10-05',
      '2026-10-02',
    ]);
  });
});

describe('spend.reserve / settle', () => {
  const at = new Date('2026-10-09T10:00:00Z');

  it('reserves the estimate when spent + estimate <= cap', () => {
    const s = mk();
    s.spend.add(0.8, at);
    const r = s.spend.reserve(0.2, 1, at);
    expect(r).toEqual({ ok: true, day: '2026-10-09', spent: 0.8 });
    expect(s.spend.forDay('2026-10-09')).toBeCloseTo(1.0);
  });

  it('refuses and records nothing when spent + estimate > cap', () => {
    const s = mk();
    s.spend.add(0.85, at);
    const r = s.spend.reserve(0.2, 1, at);
    expect(r.ok).toBe(false);
    expect(s.spend.forDay('2026-10-09')).toBeCloseTo(0.85);
  });

  it('settle replaces the estimate with the actual cost on the reserved day', () => {
    const s = mk();
    const r = s.spend.reserve(0.1, 1, at);
    s.spend.settle(r.day, 0.1, 0.034);
    expect(s.spend.forDay('2026-10-09')).toBeCloseTo(0.034);
    const r2 = s.spend.reserve(0.1, 1, at);
    s.spend.settle(r2.day, 0.1, 0.25);
    expect(s.spend.forDay('2026-10-09')).toBeCloseTo(0.284);
  });

  it('rejects bad amounts', () => {
    const s = mk();
    expect(() => s.spend.reserve(-0.1, 1, at)).toThrow();
    expect(() => s.spend.reserve(Number.NaN, 1, at)).toThrow();
    expect(() => s.spend.settle('2026-10-09', 0.1, -1)).toThrow();
  });
});
