import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { submitPlan } from '../../src/plan/intake.js';
import { openStore, type Store } from '../../src/store/index.js';
import { DATE, validPlan } from './fixtures.js';

const NOW = new Date('2026-10-10T17:00:00Z');
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('submitPlan', () => {
  it('re-checks the status under the write lock (another process approved meanwhile)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jrn-intake-'));
    dirs.push(dir);
    const a = openStore(join(dir, 'j.db'));
    const b = openStore(join(dir, 'j.db'));
    stores.push(a, b);
    a.plans.upsert({ date: DATE, status: 'draft', json: '{}', md: 'old' });
    a.feedEntries.upsert({ id: 'e1', source: 'x', title: 't', publishedAt: NOW.toISOString() });

    // The lookup runs after the first status check: the other process approves right then.
    const getMany = a.feedEntries.getMany.bind(a.feedEntries);
    a.feedEntries.getMany = (ids) => {
      b.plans.setStatus(DATE, 'approved');
      return getMany(ids);
    };
    const p = validPlan();
    const r = submitPlan(
      a,
      DATE,
      { arc: p.arc, slots: p.slots, sourceEntryIds: ['e1'] },
      NOW,
      'Europe/Moscow',
    );
    expect(r).toEqual({ kind: 'locked', status: 'approved' });
    expect(b.plans.get(DATE)).toMatchObject({ status: 'approved', md: 'old' });
  });
});
