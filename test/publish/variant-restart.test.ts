import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../../src/store/index.js';
import { DATE, msk } from './helpers.js';
import { seedVariantPlan } from './variant-helpers.js';

// WP-PLAT-02 acceptance 2: the variant loop runs in a real child process that SIGKILLs itself at
// a chosen point, then a new process starts on the same SQLite file. The adapter is scripted
// (test/support/variant-child.ts): every post or comment that was carried out is one line of a
// file, which is what readers of the platform would see.

const CHILD = fileURLToPath(new URL('../support/variant-child.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

let dir: string;
let db: string;
let postsFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jrn-variant-restart-'));
  db = join(dir, 'journalist.db');
  postsFile = join(dir, 'posts.jsonl');
  const store = openStore(db);
  seedVariantPlan(
    store,
    [{ id: 's1', at: '09:00', text: 'Утро. Кто первый?' }],
    [
      { slot: 's1', platform: 'threads', at: '09:07:41' },
      { slot: 's1', platform: 'linkedin', at: '09:07:41' },
    ],
  );
  store.close();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(platform: 'threads' | 'linkedin', now: Date, extra: Record<string, string> = {}) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>(
    (resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          DB: db,
          PLATFORM: platform,
          POSTS_FILE: postsFile,
          NOW: now.toISOString(),
          ...extra,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.stderr.on('data', (c: Buffer) => (out += c.toString()));
      child.on('exit', (code, signal) => resolve({ code, signal, out }));
    },
  );
}

const published = (kind = 'post') =>
  (existsSync(postsFile) ? readFileSync(postsFile, 'utf8').trim().split('\n') : [])
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind: string; key: string })
    .filter((l) => l.kind === kind);
const state = (platform: string) => {
  const s = openStore(db);
  try {
    return {
      pubs: s.publications.listForPlan(DATE).filter((p) => p.platform === platform),
      alerts: s.alerts.list(),
      variants: s.slotVariants.listForPlan(DATE).filter((v) => v.platform === platform),
    };
  } finally {
    s.close();
  }
};

describe('a variant loop killed between intent and result', () => {
  it('killed between the intent and the send: no post, then unknown and one alert', async () => {
    const first = await run('threads', msk('09:07:41'), { CRASH_AFTER_INTENT: '1' });
    expect(first.signal).toBe('SIGKILL');
    expect(state('threads').pubs.map((p) => p.status)).toEqual(['intent']);
    expect(published()).toEqual([]);

    // 30 s later the intent is fresh: the variant is blocked, nothing is sent.
    const second = await run('threads', msk('09:08:11'));
    expect(second.code, second.out).toBe(0);
    expect(state('threads').pubs.map((p) => p.status)).toEqual(['intent']);
    // 3 min later it becomes unknown with an alert; it is not sent then or later.
    for (const at of ['09:10:41', '09:11:41', '10:00']) {
      const next = await run('threads', msk(at));
      expect(next.code, next.out).toBe(0);
    }
    expect(published()).toEqual([]);
    const { pubs, alerts, variants } = state('threads');
    expect(pubs.map((p) => [p.key, p.status])).toEqual([[`threads:${DATE}:s1-ru:0`, 'unknown']]);
    expect(alerts.map((a) => a.kind)).toEqual(['publish_unknown']);
    expect(alerts[0]!.message).toContain('threads');
    expect(variants.map((v) => v.status)).toEqual(['planned']);
  }, 60_000);

  it('killed after the send, before the result is recorded: exactly one post', async () => {
    const first = await run('linkedin', msk('09:07:41'), { CRASH_AFTER_PUBLISH: '1' });
    expect(first.signal).toBe('SIGKILL');
    expect(published()).toHaveLength(1);
    expect(state('linkedin').pubs.map((p) => p.status)).toEqual(['intent']);

    for (const at of ['09:08:11', '09:10:41', '09:30', '12:00']) {
      const next = await run('linkedin', msk(at));
      expect(next.code, next.out).toBe(0);
    }
    expect(published().map((p) => p.key)).toEqual([`linkedin:${DATE}:s1-ru:0`]);
    const { pubs, alerts } = state('linkedin');
    expect(pubs.map((p) => p.status)).toEqual(['unknown']);
    expect(alerts.map((a) => a.kind)).toEqual(['publish_unknown']);
  }, 60_000);

  it('the other platform is not disturbed by the crash of the first', async () => {
    await run('threads', msk('09:07:41'), { CRASH_AFTER_INTENT: '1' });
    const li = await run('linkedin', msk('09:07:41'));
    expect(li.code, li.out).toBe(0);
    // Threads' stale intent is reconciled by Threads' loop only.
    const later = await run('linkedin', msk('09:15'));
    expect(later.code, later.out).toBe(0);
    expect(published().map((p) => p.key)).toEqual([`linkedin:${DATE}:s1-ru:0`]);
    expect(state('linkedin').pubs.map((p) => p.status)).toEqual(['sent']);
    expect(state('threads').pubs.map((p) => p.status)).toEqual(['intent']);
    expect(state('threads').alerts).toEqual([]);
  }, 60_000);

  it('a normal run after a clean one sends nothing new', async () => {
    expect((await run('threads', msk('09:07:41'))).code).toBe(0);
    expect((await run('threads', msk('09:07:51'))).code).toBe(0);
    expect((await run('threads', msk('09:30'))).code).toBe(0);
    expect(published()).toHaveLength(1);
    const { pubs, variants } = state('threads');
    expect(pubs.map((p) => [p.status, p.messageId, p.url])).toEqual([
      ['sent', 'threads-1', 'https://threads.example/1'],
    ]);
    expect(variants.map((v) => v.status)).toEqual(['done']);
  }, 60_000);

  it('killed after the comment went out: one post and one comment, the post row stays sent', async () => {
    const env = { COMMENT: '1' };
    expect((await run('linkedin', msk('09:07:41'), env)).code).toBe(0);
    const killed = await run('linkedin', msk('09:07:42'), { ...env, CRASH_AFTER_COMMENT: '1' });
    expect(killed.signal).toBe('SIGKILL');
    for (const at of ['09:08:12', '09:10:42', '09:30']) {
      const next = await run('linkedin', msk(at), env);
      expect(next.code, next.out).toBe(0);
    }
    expect(published('post')).toHaveLength(1);
    expect(published('comment')).toHaveLength(1);
    const { pubs, alerts, variants } = state('linkedin');
    expect(pubs.map((p) => [p.part, p.status])).toEqual([
      [0, 'sent'],
      [1, 'unknown'],
    ]);
    // The alert is about the comment, not about the post (which is out and recorded).
    expect(alerts.map((a) => a.kind)).toEqual(['comment_unknown']);
    expect(alerts[0]!.message).toContain(`linkedin:${DATE}:s1-ru:1`);
    expect(alerts[0]!.message).toContain('the first comment may be posted on linkedin');
    // The post is sent and the comment has a final state: the variant is done.
    expect(variants.map((v) => v.status)).toEqual(['done']);
  }, 60_000);
});
