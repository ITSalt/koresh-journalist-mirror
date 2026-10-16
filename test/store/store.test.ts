import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/store/migrate.js';
import { AlreadyExists, mskDay, openStore, type Store } from '../../src/store/index.js';

let dir: string;
let file: string;
const open: Store[] = [];
function mk(f = file): Store {
  const s = openStore(f);
  open.push(s);
  return s;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'journalist-store-'));
  file = join(dir, 'state.db');
});
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const intent = (key: string) => ({
  key,
  platform: 'telegram',
  planDate: '2026-10-09',
  slotId: 's1',
  part: 0,
  textSha256: 'a'.repeat(64),
});

const names = (s: Store) =>
  s.db
    .prepare('SELECT name FROM schema_migrations ORDER BY name')
    .all()
    .map((r) => (r as { name: string }).name);

describe('migrations', () => {
  it('apply once and are idempotent on second boot', () => {
    const a = mk();
    const first = names(a);
    expect(first.length).toBeGreaterThan(0);
    expect(a.migrationsApplied).toEqual(first);
    a.close();
    const b = mk();
    expect(b.migrationsApplied).toEqual([]);
    expect(names(b)).toEqual(first);
  });

  it('uses WAL and has all contract tables', () => {
    const s = mk();
    expect(s.db.pragma('journal_mode', { simple: true })).toBe('wal');
    const tables = s.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['feed_entries', 'plans', 'slots', 'publications', 'feedback', 'llm_spend']) {
      expect(tables).toContain(t);
    }
  });

  it('rolls back a failing migration entirely', () => {
    const mdir = join(dir, 'm');
    mkdirSync(mdir);
    writeFileSync(join(mdir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');
    writeFileSync(
      join(mdir, '002_b.sql'),
      'CREATE TABLE b (x INTEGER); INSERT INTO nope VALUES (1);',
    );
    const s = mk();
    expect(() => runMigrations(s.db, mdir)).toThrow();
    const t = s.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('a','b')").all();
    expect(t).toEqual([{ name: 'a' }]);
  });

  it('rejects a non-numbered migration file name', () => {
    const mdir = join(dir, 'm2');
    mkdirSync(mdir);
    writeFileSync(join(mdir, 'init.sql'), 'SELECT 1;');
    expect(() => runMigrations(mk().db, mdir)).toThrow(/NNN_name\.sql/);
  });

  it('sorts numerically (1000 after 999) and refuses duplicate numbers', () => {
    const mdir = join(dir, 'm3');
    mkdirSync(mdir);
    writeFileSync(join(mdir, '1000_late.sql'), 'CREATE TABLE late (x INTEGER);');
    writeFileSync(join(mdir, '999_early.sql'), 'CREATE TABLE early (x INTEGER);');
    expect(runMigrations(mk().db, mdir)).toEqual(['999_early.sql', '1000_late.sql']);

    const dup = join(dir, 'm4');
    mkdirSync(dup);
    writeFileSync(join(dup, '002_a.sql'), 'SELECT 1;');
    writeFileSync(join(dup, '002_b.sql'), 'SELECT 1;');
    expect(() => runMigrations(mk(join(dir, 'other.db')).db, dup)).toThrow(
      /Duplicate migration number 2/,
    );
  });

  it('survives restart: data persists', () => {
    const a = mk();
    a.plans.upsert({ date: '2026-10-09', status: 'draft', json: '{}', md: '# x' });
    a.close();
    expect(mk().plans.get('2026-10-09')?.md).toBe('# x');
  });
});

describe('publications', () => {
  it('beginIntent creates an intent row', () => {
    const s = mk();
    const p = s.publications.beginIntent(intent('k1'));
    expect(p).toMatchObject({ key: 'k1', status: 'intent', messageId: null });
  });

  it('duplicate key throws typed AlreadyExists', () => {
    const s = mk();
    s.publications.beginIntent(intent('k1'));
    let err: unknown;
    try {
      s.publications.beginIntent(intent('k1'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AlreadyExists);
    expect((err as AlreadyExists).key).toBe('k1');
  });

  it('two concurrent beginIntent with one key: exactly one succeeds', async () => {
    const a = mk();
    const b = mk(); // second connection to the same file
    const attempt = (s: Store) =>
      new Promise<'ok' | 'dup'>((resolve, reject) =>
        setImmediate(() => {
          try {
            s.publications.beginIntent(intent('race'));
            resolve('ok');
          } catch (e) {
            if (e instanceof AlreadyExists) resolve('dup');
            else reject(e as Error);
          }
        }),
      );
    const res = await Promise.all([attempt(a), attempt(b), attempt(a), attempt(b)]);
    expect(res.filter((r) => r === 'ok')).toHaveLength(1);
    expect(res.filter((r) => r === 'dup')).toHaveLength(3);
    expect(a.db.prepare('SELECT COUNT(*) c FROM publications').get()).toEqual({ c: 1 });
  });

  it('markSent / markFailed / markUnknown transition only from intent', () => {
    const s = mk();
    s.publications.beginIntent(intent('a'));
    s.publications.beginIntent(intent('b'));
    s.publications.beginIntent(intent('c'));
    expect(s.publications.markSent('a', '42')).toMatchObject({ status: 'sent', messageId: '42' });
    expect(s.publications.get('a')?.sentAt).toBeTruthy();
    expect(s.publications.markFailed('b', 'boom')).toMatchObject({
      status: 'failed',
      error: 'boom',
    });
    expect(s.publications.markUnknown('c', 'timeout')).toMatchObject({ status: 'unknown' });
    expect(() => s.publications.markSent('a', '43')).toThrow(/intent/);
    expect(() => s.publications.markSent('zzz', '1')).toThrow(/not found/);
  });

  it('listForSlot returns parts in order', () => {
    const s = mk();
    s.publications.beginIntent({ ...intent('p1'), part: 1 });
    s.publications.beginIntent({ ...intent('p0'), part: 0 });
    expect(s.publications.listForSlot('2026-10-09', 's1').map((p) => p.key)).toEqual(['p0', 'p1']);
  });
});

describe('plans, slots, feedback, feed entries', () => {
  it('plan upsert replaces and status can be set', () => {
    const s = mk();
    s.plans.upsert({ date: '2026-10-09', status: 'draft', json: '{"a":1}', md: 'a' });
    s.plans.upsert({ date: '2026-10-09', status: 'draft', json: '{"a":2}', md: 'b' });
    expect(s.plans.get('2026-10-09')).toMatchObject({ json: '{"a":2}', md: 'b', status: 'draft' });
    s.plans.setStatus('2026-10-09', 'approved');
    expect(s.plans.get('2026-10-09')?.status).toBe('approved');
    expect(s.plans.get('1999-01-01')).toBeUndefined();
    expect(() =>
      s.plans.upsert({ date: 'x', status: 'bogus' as never, json: '', md: '' }),
    ).toThrow();
  });

  it('slots replace per plan and list in time order', () => {
    const s = mk();
    s.plans.upsert({ date: '2026-10-09', status: 'draft', json: '{}', md: '' });
    s.slots.replaceForPlan('2026-10-09', [
      { slotId: 's2', at: '2026-10-09T15:00:00+03:00', kind: 'post', json: '{}' },
      { slotId: 's1', at: '2026-10-09T10:00:00+03:00', kind: 'post', json: '{}' },
    ]);
    expect(s.slots.listForPlan('2026-10-09').map((x) => x.slotId)).toEqual(['s1', 's2']);
    s.slots.replaceForPlan('2026-10-09', [
      { slotId: 's3', at: '2026-10-09T12:00:00+03:00', kind: 'post', json: '{}' },
    ]);
    expect(s.slots.listForPlan('2026-10-09').map((x) => x.slotId)).toEqual(['s3']);
  });

  it('feedback add and list', () => {
    const s = mk();
    s.feedback.add({ planDate: '2026-10-09', verdict: 'like' });
    s.feedback.add({ planDate: '2026-10-09', slotId: 's1', verdict: 'dislike', note: 'meh' });
    const l = s.feedback.listForPlan('2026-10-09');
    expect(l).toHaveLength(2);
    expect(l[1]).toMatchObject({ slotId: 's1', verdict: 'dislike', note: 'meh' });
    expect(l[0]?.slotId).toBeNull();
  });

  it('feed entries upsert by external id: an edited re-send updates the row', () => {
    const s = mk();
    s.feedEntries.upsert({ id: 'e1', source: 'rss1', title: 'T', summary: 'old' });
    s.feedEntries.upsert({ id: 'e1', source: 'rss1', title: 'T2', summary: 'new' });
    s.feedEntries.upsert({ id: 'e2', source: 'rss1', title: 'Other' });
    const all = s.feedEntries.recent(10);
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.id === 'e1')).toMatchObject({ title: 'T2', summary: 'new' });
  });

  it('feed entries refuse private entries', () => {
    const s = mk();
    expect(() => s.feedEntries.upsert({ id: 'p', source: 'x', title: 'T', private: true })).toThrow(
      /private/,
    );
    expect(s.feedEntries.recent(10)).toHaveLength(0);
  });

  it('accepts the plan status failed and publication statuses dry and skipped', () => {
    const s = mk();
    s.plans.upsert({ date: '2026-10-09', status: 'failed', json: '{}', md: '' });
    expect(s.plans.get('2026-10-09')?.status).toBe('failed');
    for (const st of ['dry', 'skipped']) {
      s.publications.beginIntent(intent(st));
      s.db.prepare('UPDATE publications SET status = ? WHERE key = ?').run(st, st);
      expect(s.publications.get(st)?.status).toBe(st);
    }
  });

  it('slots default to planned; status can be set; bad status rejected', () => {
    const s = mk();
    s.plans.upsert({ date: '2026-10-09', status: 'draft', json: '{}', md: '' });
    s.slots.replaceForPlan('2026-10-09', [
      { slotId: 's1', at: '2026-10-09T10:00:00+03:00', kind: 'post', json: '{}' },
    ]);
    expect(s.slots.listForPlan('2026-10-09')[0]?.status).toBe('planned');
    s.slots.setStatus('2026-10-09', 's1', 'skipped');
    expect(s.slots.listForPlan('2026-10-09')[0]?.status).toBe('skipped');
    expect(() => s.slots.setStatus('2026-10-09', 'nope', 'done')).toThrow(/not found/);
    expect(() => s.slots.setStatus('2026-10-09', 's1', 'bogus' as never)).toThrow();
  });

  it('foreign keys are enforced: a slot without its plan fails', () => {
    const s = mk();
    expect(() =>
      s.slots.replaceForPlan('2099-01-01', [
        { slotId: 's1', at: '2099-01-01T10:00:00+03:00', kind: 'post', json: '{}' },
      ]),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('publication timestamps and stale intents', () => {
  it('beginIntent sets created_at; markStaleIntentsUnknown only touches old intents', () => {
    const s = mk();
    s.publications.beginIntent(intent('old'));
    s.publications.beginIntent(intent('fresh'));
    s.publications.beginIntent(intent('done'));
    s.publications.markSent('done', '1');
    const created = s.publications.get('old')?.createdAt as string;
    expect(Number.isNaN(Date.parse(created))).toBe(false);
    s.db
      .prepare('UPDATE publications SET created_at = ? WHERE key = ?')
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), 'old');
    s.db
      .prepare('UPDATE publications SET created_at = ? WHERE key = ?')
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), 'done');
    expect(s.publications.markStaleIntentsUnknown(2 * 60_000)).toBe(1);
    expect(s.publications.get('old')?.status).toBe('unknown');
    expect(s.publications.get('fresh')?.status).toBe('intent');
    expect(s.publications.get('done')?.status).toBe('sent');
    expect(s.publications.markStaleIntentsUnknown(2 * 60_000)).toBe(0);
  });
});

describe('busy_timeout', () => {
  it('waits for a write lock held by another process instead of failing with SQLITE_BUSY', async () => {
    const s = mk();
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const D=require('better-sqlite3');const d=new D(process.argv[1]);
         d.exec('BEGIN IMMEDIATE');console.log('locked');
         setTimeout(()=>{d.exec('COMMIT');d.close();},700);`,
        file,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'], cwd: process.cwd() },
    );
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once('data', () => resolve());
      holder.once('error', reject);
    });
    const t0 = Date.now();
    s.plans.upsert({ date: '2026-10-09', status: 'draft', json: '{}', md: 'waited' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(s.plans.get('2026-10-09')?.md).toBe('waited');
    await new Promise((r) => holder.once('exit', r));
  });
});

describe('llm spend', () => {
  it('mskDay maps instants to the Moscow calendar day', () => {
    expect(mskDay(new Date('2026-10-08T20:59:59Z'))).toBe('2026-10-08');
    expect(mskDay(new Date('2026-10-08T21:00:00Z'))).toBe('2026-10-09');
  });

  it('sums per MSK day, across the UTC midnight boundary', () => {
    const s = mk();
    s.spend.add(0.1, new Date('2026-10-08T20:59:00Z')); // 23:59 MSK, 8th
    s.spend.add(0.2, new Date('2026-10-08T21:01:00Z')); // 00:01 MSK, 9th
    s.spend.add(0.3, new Date('2026-10-09T10:00:00Z')); // 9th
    expect(s.spend.forDay('2026-10-08')).toBeCloseTo(0.1);
    expect(s.spend.forDay('2026-10-09')).toBeCloseTo(0.5);
    expect(s.spend.forDay('2026-10-10')).toBe(0);
    expect(s.spend.today(new Date('2026-10-09T12:00:00Z'))).toBeCloseTo(0.5);
  });

  it('rejects negative amounts', () => {
    expect(() => mk().spend.add(-1)).toThrow();
  });
});
