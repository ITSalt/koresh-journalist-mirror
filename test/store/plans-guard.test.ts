import { describe, expect, it } from 'vitest';
import { AlreadyExists, openStore, PlanRejected, SlotNotClaimable } from '../../src/store/index.js';

describe('plans rejected guard (WP-SVC-09 review I-2)', () => {
  it('upsert keeps rejected for any written status', () => {
    const s = openStore(':memory:');
    s.plans.upsert({ date: '2026-10-10', status: 'draft', json: '{}', md: 'a' });
    s.plans.setStatus('2026-10-10', 'rejected');
    expect(
      s.plans.upsert({ date: '2026-10-10', status: 'draft', json: '{}', md: 'b' }),
    ).toMatchObject({ status: 'rejected', md: 'b' });
    for (const status of ['approved', 'failed'] as const) {
      expect(s.plans.upsert({ date: '2026-10-10', status, json: '{}', md: 'c' }).status).toBe(
        'rejected',
      );
    }
    s.close();
  });

  it('setStatus refuses rejected -> approved (and any other status)', () => {
    const s = openStore(':memory:');
    s.plans.upsert({ date: '2026-10-10', status: 'draft', json: '{}', md: 'a' });
    s.plans.setStatus('2026-10-10', 'rejected');
    expect(() => s.plans.setStatus('2026-10-10', 'approved')).toThrow(PlanRejected);
    expect(() => s.plans.setStatus('2026-10-10', 'draft')).toThrow(PlanRejected);
    s.plans.setStatus('2026-10-10', 'rejected'); // idempotent
    expect(s.plans.get('2026-10-10')?.status).toBe('rejected');
    expect(() => s.plans.setStatus('1999-01-01', 'approved')).toThrow(/not found/);
    s.close();
  });

  it('updatedAt follows every write; createdAt stays the first one', () => {
    const s = openStore(':memory:');
    const t1 = new Date('2026-10-10T17:00:00Z');
    const t2 = new Date('2026-10-10T19:30:00Z');
    s.plans.upsert({ date: '2026-10-11', status: 'draft', json: '{}', md: 'a' }, t1);
    s.plans.upsert({ date: '2026-10-11', status: 'draft', json: '{}', md: 'b' }, t2);
    expect(s.plans.get('2026-10-11')).toMatchObject({
      createdAt: t1.toISOString(),
      updatedAt: t2.toISOString(),
    });
    s.close();
  });

  it('other transitions still work, and the input hash round-trips', () => {
    const s = openStore(':memory:');
    s.plans.upsert({ date: '2026-10-10', status: 'failed', json: '{}', md: 'a' });
    expect(s.plans.get('2026-10-10')?.inputSha256).toBeNull();
    s.plans.upsert({ date: '2026-10-10', status: 'draft', json: '{}', md: 'b', inputSha256: 'h1' });
    s.plans.setStatus('2026-10-10', 'approved');
    expect(s.plans.get('2026-10-10')).toMatchObject({ status: 'approved', inputSha256: 'h1' });
    s.close();
  });
});

describe('jobRuns, feedEntries.getMany, alerts.listSince', () => {
  it('claims a (job, date) once', () => {
    const s = openStore(':memory:');
    expect(s.jobRuns.claim('approve', '2026-10-11')).toBe(true);
    expect(s.jobRuns.claim('approve', '2026-10-11')).toBe(false);
    expect(s.jobRuns.claim('approve', '2026-10-12')).toBe(true);
    expect(s.jobRuns.claim('no_plan', '2026-10-11')).toBe(true);
    s.jobRuns.finish('approve', '2026-10-11', 'approved');
    expect(s.jobRuns.get('approve', '2026-10-11')?.result).toBe('approved');
    expect(s.jobRuns.get('approve', '2026-10-13')).toBeUndefined();
    s.close();
  });

  it('gets stored feed entries by id', () => {
    const s = openStore(':memory:');
    s.feedEntries.upsert({ id: 'a', source: 'x', title: 't', publishedAt: '2026-10-08T10:00:00Z' });
    s.feedEntries.upsert({ id: 'b', source: 'x', title: 't' });
    expect(
      s.feedEntries
        .getMany(['b', 'a', 'zz', 'a'])
        .map((e) => e.id)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(s.feedEntries.getMany([])).toEqual([]);
    s.close();
  });

  it('lists alerts strictly after a time', () => {
    const s = openStore(':memory:');
    s.alerts.add({ kind: 'a', message: '1' }, new Date('2026-10-10T17:00:00Z'));
    s.alerts.add({ kind: 'b', message: '2' }, new Date('2026-10-10T18:00:00Z'));
    expect(s.alerts.listSince(new Date('2026-10-10T17:00:00Z')).map((a) => a.kind)).toEqual(['b']);
    expect(s.alerts.listSince(new Date(0)).map((a) => a.kind)).toEqual(['a', 'b']);
    s.close();
  });
});

describe('publications.listForPlan', () => {
  it('lists only the publications of that plan date', () => {
    const s = openStore(':memory:');
    const base = { platform: 'telegram', slotId: 's1', textSha256: 'a'.repeat(64) };
    s.publications.beginIntent({ ...base, key: 'a', planDate: '2026-10-10' });
    s.publications.beginIntent({ ...base, key: 'b', planDate: '2026-10-11' });
    expect(s.publications.listForPlan('2026-10-10').map((p) => p.key)).toEqual(['a']);
    expect(s.publications.listForPlan('2026-10-12')).toEqual([]);
    s.close();
  });
});

describe('slot replacement writes and the guarded intent (WP-SVC-22)', () => {
  const D = '2026-10-11';
  const t0 = new Date('2026-10-10T17:00:00Z');
  function seeded() {
    const s = openStore(':memory:');
    s.plans.upsert({ date: D, status: 'draft', json: '{"a":1}', md: 'a', inputSha256: 'h' }, t0);
    s.slots.replaceForPlan(D, [
      { slotId: 's1', at: `${D}T09:00:00+03:00`, kind: 'post', json: '{"t":"one"}' },
      { slotId: 's2', at: `${D}T19:00:00+03:00`, kind: 'post', json: '{"t":"two"}' },
    ]);
    s.plans.setStatus(D, 'approved');
    return s;
  }
  const intent = (slotId: string, expectSlotJson?: string, part = 0) => ({
    key: `telegram:${D}:${slotId}:${part}`,
    platform: 'telegram',
    planDate: D,
    slotId,
    part,
    textSha256: 'a'.repeat(64),
    ...(expectSlotJson === undefined ? {} : { expectSlotJson }),
  });

  it('plans.setContent writes json, md and updatedAt only', () => {
    const s = seeded();
    const t1 = new Date('2026-10-10T20:45:00Z');
    s.plans.setContent(D, { json: '{"a":2}', md: 'b' }, t1);
    expect(s.plans.get(D)).toEqual({
      date: D,
      status: 'approved',
      json: '{"a":2}',
      md: 'b',
      createdAt: t0.toISOString(),
      inputSha256: 'h',
      updatedAt: t1.toISOString(),
    });
    expect(() => s.plans.setContent('1999-01-01', { json: '{}', md: '' })).toThrow(/not found/);
    s.close();
  });

  it('slots.setJson writes one slot json and nothing else', () => {
    const s = seeded();
    const before = s.slots.listForPlan(D);
    s.slots.setJson(D, 's2', '{"t":"new"}');
    expect(s.slots.listForPlan(D)).toEqual([before[0], { ...before[1], json: '{"t":"new"}' }]);
    expect(() => s.slots.setJson(D, 's9', '{}')).toThrow(/not found/);
    s.close();
  });

  it('beginIntent with expectSlotJson: written only for the json the slot still holds', () => {
    const s = seeded();
    expect(() => s.publications.beginIntent(intent('s2', '{"t":"old"}'))).toThrow(SlotNotClaimable);
    expect(s.publications.listForPlan(D)).toEqual([]);
    expect(s.publications.beginIntent(intent('s2', '{"t":"two"}'))).toMatchObject({
      status: 'intent',
      slotId: 's2',
    });
    // the same key again is still "already exists"
    expect(() => s.publications.beginIntent(intent('s2', '{"t":"two"}'))).toThrow(AlreadyExists);
    // the json of another slot does not match
    expect(() => s.publications.beginIntent(intent('s1', '{"t":"two"}'))).toThrow(SlotNotClaimable);
    expect(s.publications.listForPlan(D)).toHaveLength(1);
    s.close();
  });

  it('beginIntent with expectSlotJson: refused unless approved and planned', () => {
    for (const status of ['skipped', 'done'] as const) {
      const s = seeded();
      s.slots.setStatus(D, 's2', status);
      expect(() => s.publications.beginIntent(intent('s2', '{"t":"two"}'))).toThrow(
        SlotNotClaimable,
      );
      s.close();
    }
    for (const status of ['draft', 'failed', 'rejected'] as const) {
      const s = seeded();
      s.plans.setStatus(D, status);
      expect(() => s.publications.beginIntent(intent('s2', '{"t":"two"}'))).toThrow(
        SlotNotClaimable,
      );
      expect(s.publications.listForPlan(D)).toEqual([]);
      s.close();
    }
    const s = openStore(':memory:');
    expect(() => s.publications.beginIntent(intent('s2', '{}'))).toThrow(SlotNotClaimable);
    s.close();
  });

  it('beginIntent without expectSlotJson is unchanged: no slot or plan is needed', () => {
    const s = openStore(':memory:');
    expect(s.publications.beginIntent(intent('s2')).status).toBe('intent');
    s.close();
  });
});
