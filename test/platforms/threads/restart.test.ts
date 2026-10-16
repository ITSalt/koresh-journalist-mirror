import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublishStep } from '../../../src/platforms/threads/step-store.js';
import { FakeThreads } from '../../support/fake-threads.js';
import { KEY, TOKEN } from './helpers.js';

// The adapter runs in a real child process that is SIGKILLed at a chosen point of the publish
// item; then a new process starts over the same step records (a JSON file standing in for the
// caller's intent row). The fake Threads server counts what readers would see.

const CHILD = fileURLToPath(new URL('../../support/threads-child.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TEXT = 'Утро. Кто первый?';

let fake: FakeThreads;
let dir: string;
let stepsFile: string;
let current: ChildProcess | undefined;
beforeEach(async () => {
  fake = await new FakeThreads(TOKEN).start();
  dir = mkdtempSync(join(tmpdir(), 'jrn-threads-restart-'));
  stepsFile = join(dir, 'steps.json');
});
afterEach(async () => {
  fake.onRequest = undefined;
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

function run(extra: Record<string, string> = {}) {
  return new Promise<{ signal: NodeJS.Signals | null; outcome?: Record<string, unknown> }>(
    (resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          BASE_URL: fake.baseUrl,
          THREADS_TOKEN: TOKEN,
          STEPS_FILE: stepsFile,
          KEY,
          TEXT,
          ...extra,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      current = child;
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.on('exit', (_code, signal) => {
        const line = out.trim().split('\n').pop();
        resolve({
          signal,
          ...(line ? { outcome: JSON.parse(line) as Record<string, unknown> } : {}),
        });
      });
    },
  );
}

const recorded = (): PublishStep | undefined =>
  existsSync(stepsFile)
    ? (JSON.parse(readFileSync(stepsFile, 'utf8')) as Record<string, PublishStep>)[KEY]
    : undefined;
const published = () => [...fake.containers.values()].filter((c) => c.published).length;

describe('a restart in the middle of one publish item', () => {
  it('killed while the container is being created: the restart publishes exactly one post', async () => {
    fake.queue('container', { hang: true });
    fake.onRequest = (r) => {
      if (r.op === 'container') setTimeout(() => current?.kill('SIGKILL'), 50);
    };
    const first = await run();
    expect(first.signal).toBe('SIGKILL');
    expect(recorded()).toBeUndefined();
    expect(fake.posts).toHaveLength(0);

    fake.onRequest = undefined;
    const second = await run();
    expect(second.outcome).toMatchObject({ ok: true });
    expect(fake.posts).toHaveLength(1);
    expect(fake.containers.size).toBe(2);
    expect(published()).toBe(1);
  }, 30_000);

  it('killed between the two steps: a fresh container is published, the first one never is', async () => {
    const first = await run({ CRASH_AFTER_STEP: 'container' });
    expect(first.signal).toBe('SIGKILL');
    const old = recorded()!;
    expect(old.step).toBe('container');
    expect(fake.sent('publish')).toHaveLength(0);

    const second = await run();
    expect(second.outcome).toMatchObject({ ok: true, result: { id: fake.posts[0]!.id } });
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]!.text).toBe(TEXT);
    expect(fake.containers.size).toBe(2);
    expect(fake.containers.get(old.containerId)!.published).toBe(false);
    expect(fake.sent('publish')).toHaveLength(1);

    // And a third start leaves it at one.
    const third = await run();
    expect(third.outcome).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.posts).toHaveLength(1);
  }, 30_000);

  it('killed after the publish step was recorded, before the request left: no post, never sent', async () => {
    const first = await run({ CRASH_AFTER_STEP: 'publish' });
    expect(first.signal).toBe('SIGKILL');
    expect(recorded()!.step).toBe('publish');
    expect(fake.sent('publish')).toHaveLength(0);
    const before = fake.requests.length;

    const second = await run();
    expect(second.outcome).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(fake.requests).toHaveLength(before);
    expect(fake.posts).toHaveLength(0);
  }, 30_000);

  it('killed after the publish request left: the post is public once, the restart sends nothing', async () => {
    fake.queue('publish', { hang: true }); // published, but the answer never comes
    fake.onRequest = (r) => {
      if (r.op === 'publish') setTimeout(() => current?.kill('SIGKILL'), 50);
    };
    const first = await run();
    expect(first.signal).toBe('SIGKILL');
    expect(recorded()!.step).toBe('publish');
    expect(fake.posts).toHaveLength(1);
    const before = fake.requests.length;

    fake.onRequest = undefined;
    const second = await run();
    expect(second.outcome).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(String(second.outcome!.description)).toMatch(/^publish_already_started: /);
    expect(fake.requests).toHaveLength(before);
    expect(fake.posts).toHaveLength(1);
    expect(fake.containers.size).toBe(1);
  }, 30_000);
});
