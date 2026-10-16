import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

// WP-PLAT-07 acceptance 2 and 3: the service as it really starts (src/index.ts in a child
// process) with its two listeners, and the port mappings of the image. Nothing outside the
// machine is called: no bot token that works, DRY_RUN by default, the Bot API pointed at a
// closed local port. The child gets a short, explicit environment, never the test runner's.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INDEX = join(ROOT, 'src/index.ts');
const API_TOKEN = 'fake-api-token-for-boot-tests-0123456789';
const BEARER = { authorization: `Bearer ${API_TOKEN}` };

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

interface Booted {
  port: number;
  publicPort: number;
  child: ChildProcess;
  output: () => string;
}
const children: ChildProcess[] = [];
const dirs: string[] = [];
const servers: Server[] = [];

async function boot(env: Record<string, string>, publicPort?: number): Promise<Booted> {
  const port = await freePort();
  const pub = publicPort ?? (await freePort());
  const dir = mkdtempSync(join(tmpdir(), 'jrn-boot-'));
  dirs.push(dir);
  let out = '';
  const child = spawn(process.execPath, ['--import', 'tsx', INDEX], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_PORT: String(pub),
      DATA_DIR: dir,
      JOURNALIST_API_TOKEN: API_TOKEN,
      TELEGRAM_BOT_TOKEN: 'fake-telegram-token-value',
      TELEGRAM_API_BASE_URL: 'http://127.0.0.1:1',
      GIT_SHA: 'boot-test',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (out += c.toString('utf8')));
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the service exited ${child.exitCode}: ${out}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`the service did not start: ${out}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, publicPort: pub, child, output: () => out };
}

const get = (port: number, path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: 'manual' });
/** `true` when nothing accepts connections on the port. */
const closed = async (port: number) => {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return false;
  } catch {
    return true;
  }
};

afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null) {
      const gone = new Promise((r) => c.once('exit', r));
      c.kill('SIGKILL');
      await gone;
    }
  }
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the service as it starts (src/index.ts)', () => {
  it('without PUBLIC_BASE: no public listener, and the service boots as before', async () => {
    const s = await boot({});
    expect(await closed(s.publicPort)).toBe(true);
    const health = await get(s.port, '/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', version: 'boot-test' });
    const ready = await get(s.port, '/ready');
    expect(ready.status).toBe(200);
    const body = (await ready.json()) as {
      status: string;
      components: Record<string, { ok: boolean; dryRun?: boolean }>;
    };
    expect(body.status).toBe('ready');
    expect(body.components.db).toMatchObject({ ok: true });
    expect(body.components.telegram).toMatchObject({ ok: true, dryRun: true });
    // The director API answers, the connect says what is missing, nothing complained.
    const connect = await get(s.port, '/v1/connect', BEARER);
    expect(connect.status).toBe(200);
    expect(
      ((await connect.json()) as { threads: { missing: string[] } }).threads.missing,
    ).toContain('PUBLIC_BASE is not set');
    const alerts = (await (await get(s.port, '/v1/alerts', BEARER)).json()) as {
      alerts: unknown[];
    };
    expect(alerts.alerts).toEqual([]);
    expect((await get(s.port, '/koresh/privacy')).status).toBe(404);
    expect(s.output()).not.toContain('public listener');
    expect(s.child.exitCode).toBeNull();
  }, 40_000);

  it('with PUBLIC_BASE: the four routes on the public port only, the rest on the main port only', async () => {
    const s = await boot({ PUBLIC_BASE: 'https://public.example.org/koresh' });
    // The public port: the pages and the callbacks, nothing else, bearer or not.
    const page = await get(s.publicPort, '/koresh/privacy');
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(readFileSync(join(ROOT, 'public/privacy.html'), 'utf8'));
    expect((await get(s.publicPort, '/koresh/data-deletion')).status).toBe(200);
    for (const platform of ['threads', 'linkedin']) {
      // Not configured in this boot: the fixed page of the callback, not the 404.
      const cb = await get(s.publicPort, `/koresh/oauth/${platform}/callback?code=x&state=y`);
      expect(cb.status).toBe(503);
    }
    for (const path of [
      '/health',
      '/ready',
      '/v1/connect',
      '/v1/alerts',
      '/v1/plans/2026-10-16',
      '/',
    ]) {
      for (const headers of [BEARER, { ...BEARER, 'x-forwarded-for': '203.0.113.9' }, {}]) {
        const res = await get(s.publicPort, path, headers);
        expect(res.status, `public ${path}`).toBe(404);
        expect(await res.text()).not.toMatch(/"status"|"connected"|"alerts"/);
      }
    }
    // The main port: everything as before, and none of the four.
    expect((await get(s.port, '/health')).status).toBe(200);
    expect((await get(s.port, '/ready')).status).toBe(200);
    expect((await get(s.port, '/v1/connect', BEARER)).status).toBe(200);
    for (const path of [
      '/koresh/privacy',
      '/koresh/data-deletion',
      '/koresh/oauth/threads/callback',
      '/koresh/oauth/linkedin/callback',
    ]) {
      expect((await get(s.port, path)).status, `main ${path}`).toBe(404);
    }
    expect(s.output()).not.toContain('public listener failed');
  }, 40_000);

  it('the public port is taken: the service still boots, and an alert says the public side is down', async () => {
    const taken = await freePort();
    const squatter = createServer((socket) => socket.destroy());
    servers.push(squatter);
    await new Promise<void>((r) => squatter.listen(taken, '127.0.0.1', r));
    const s = await boot({ PUBLIC_BASE: 'https://public.example.org/koresh' }, taken);
    expect((await get(s.port, '/health')).status).toBe(200);
    expect((await get(s.port, '/ready')).status).toBe(200);
    // The listener is opened right after the main one: give it a moment to fail and record it.
    let kinds: string[] = [];
    for (let i = 0; i < 50 && !kinds.includes('public_listener_failed'); i++) {
      const res = await get(s.port, '/v1/alerts', BEARER);
      kinds = ((await res.json()) as { alerts: { kind: string }[] }).alerts.map((a) => a.kind);
      if (!kinds.includes('public_listener_failed')) await new Promise((r) => setTimeout(r, 100));
    }
    expect(kinds).toEqual(['public_listener_failed']);
    expect(s.output()).toContain('public listener failed to start');
    expect(s.child.exitCode).toBeNull();
  }, 40_000);
});

describe('the image and its port mappings', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

  it('docker-compose.yml maps both ports on 127.0.0.1 only: 8787 main, 8788 public', () => {
    const block = /\n {4}ports:\n((?: {6}.*\n)+)/.exec(compose);
    expect(block).not.toBeNull();
    const entries = block![1]!
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).replace(/^['"]|['"]$/g, ''));
    expect(entries).toEqual(['127.0.0.1:8787:8080', '127.0.0.1:8788:8081']);
    // No other publication of a port anywhere in the file.
    // (`10001:10001` is the uid:gid of `user:`, not a port.)
    expect(
      (compose.match(/\b\d{4,5}:\d{4,5}\b/g) ?? []).filter((m) => m !== '10001:10001'),
    ).toEqual(['8787:8080', '8788:8081']);
    expect(compose).not.toMatch(/0\.0\.0\.0|network_mode|expose:/);
  });

  it('the healthcheck stays on the main port', () => {
    expect(compose).toContain("fetch('http://127.0.0.1:8080/health')");
    expect(compose).not.toContain('8081/health');
  });

  it('the image listens on 8080 and 8081, and the config default matches', () => {
    expect(dockerfile).toMatch(/^EXPOSE 8080 8081$/m);
    expect(dockerfile).toMatch(/^\s+PORT=8080 \\$/m);
    expect(dockerfile).toMatch(/^\s+PUBLIC_PORT=8081 \\$/m);
    expect(loadConfig({}).PUBLIC_PORT).toBe(8081);
    expect(loadConfig({ PUBLIC_PORT: '9001' }).PUBLIC_PORT).toBe(9001);
    for (const bad of ['0', '70000', 'abc']) {
      expect(() => loadConfig({ PUBLIC_PORT: bad })).toThrow(/PUBLIC_PORT/);
    }
  });

  it('the CI docker job still proves /ready on the main port', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('-p 127.0.0.1:18080:8080');
    expect(ci).toContain('http://127.0.0.1:18080/ready');
  });
});
