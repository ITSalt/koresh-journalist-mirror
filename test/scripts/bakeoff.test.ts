import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, modelFileName, runBakeoff } from '../../scripts/bakeoff.js';
import { loadConfig } from '../../src/config.js';
import { openStore, type Store } from '../../src/store/index.js';
import { FakeOpenRouter } from '../llm/fake-openrouter.js';
import { DATE, ENTRIES, llmPayload } from '../plan/fixtures.js';

const KEY = 'fake-openrouter-key-for-tests';
const now = new Date('2026-10-10T16:00:00Z');
let fake: FakeOpenRouter;
let dir: string;
let store: Store;
beforeEach(async () => {
  fake = await new FakeOpenRouter().start();
  dir = mkdtempSync(join(tmpdir(), 'journalist-bakeoff-'));
  store = openStore(':memory:');
});
afterEach(async () => {
  store.close();
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

const config = (over: Record<string, string> = {}) =>
  loadConfig({
    OPENROUTER_API_KEY: KEY,
    OPENROUTER_BASE_URL: fake.baseUrl,
    LLM_DAILY_CAP_USD: '1',
    ...over,
  });

describe('bake-off', () => {
  it('maps model ids to safe file names', () => {
    expect(modelFileName('anthropic/claude-sonnet-4.5')).toBe('anthropic__claude-sonnet-4.5');
    expect(modelFileName('a/b:free')).toBe('a__b_free');
  });

  it('runs 2 models through the fake, writes both outputs and a cost summary, stores no plan', async () => {
    fake.replies.push({ content: llmPayload(), cost: 0.04 });
    fake.replies.push({ content: llmPayload(), cost: 0.06 });
    const rows = await runBakeoff({
      date: DATE,
      entries: ENTRIES,
      models: ['vendor/model-a', 'vendor/model-b'],
      outDir: dir,
      store,
      config: config(),
      now,
    });
    expect(fake.requests.map((r) => r.body.model)).toEqual(['vendor/model-a', 'vendor/model-b']);
    expect(rows.map((r) => [r.model, r.status])).toEqual([
      ['vendor/model-a', 'draft'],
      ['vendor/model-b', 'draft'],
    ]);
    for (const m of ['vendor__model-a', 'vendor__model-b']) {
      const json = JSON.parse(readFileSync(join(dir, DATE, `${m}.json`), 'utf8'));
      expect(json.status).toBe('draft');
      expect(json.plan.slots).toHaveLength(2);
      expect(readFileSync(join(dir, DATE, `${m}.md`), 'utf8')).toContain('План Кореша');
    }
    const summary = readFileSync(join(dir, DATE, 'summary.md'), 'utf8');
    expect(summary).toContain('vendor/model-a');
    expect(summary).toContain('0.0400');
    expect(summary).toContain('Итого: $0.1000');
    expect(store.plans.get(DATE)).toBeUndefined();
    expect(store.spend.forDay('2026-10-10')).toBeCloseTo(0.1);
  });

  it('runs under the same cap: the second model is refused and makes no request', async () => {
    store.spend.add(0.85, now);
    fake.replies.push({ content: llmPayload(), cost: 0.1 });
    const rows = await runBakeoff({
      date: DATE,
      entries: ENTRIES,
      models: ['vendor/model-a', 'vendor/model-b'],
      outDir: dir,
      store,
      config: config(),
      now,
    });
    expect(rows.map((r) => r.status)).toEqual(['draft', 'failed']);
    expect(rows[1]!.reason).toBe('cap');
    expect(fake.requests).toHaveLength(1);
    expect(readFileSync(join(dir, DATE, 'vendor__model-b.md'), 'utf8')).toContain('cap');
  });

  it('needs 2 to 4 models', async () => {
    const o = { date: DATE, entries: ENTRIES, outDir: dir, store, config: config(), now };
    await expect(runBakeoff({ ...o, models: ['one'] })).rejects.toThrow(/2-4/);
    await expect(runBakeoff({ ...o, models: ['a', 'b', 'c', 'd', 'e'] })).rejects.toThrow(/2-4/);
  });

  it('main reads BAKEOFF_MODELS, the entries file and DATA_DIR', async () => {
    fake.replies.push({ content: llmPayload(), cost: 0.01 });
    fake.replies.push({ content: llmPayload(), cost: 0.01 });
    const out = join(dir, 'out');
    const lines: string[] = [];
    const code = await main(
      ['--date', DATE, '--entries', 'scripts/fixtures/bakeoff-entries.json', '--out', out],
      {
        OPENROUTER_API_KEY: KEY,
        OPENROUTER_BASE_URL: fake.baseUrl,
        LLM_DAILY_CAP_USD: '1',
        BAKEOFF_MODELS: 'vendor/model-a,vendor/model-b',
        DATA_DIR: join(dir, 'data'),
      },
      (l) => lines.push(l),
    );
    expect(code).toBe(0);
    expect(existsSync(join(out, DATE, 'vendor__model-a.json'))).toBe(true);
    expect(existsSync(join(out, DATE, 'vendor__model-b.md'))).toBe(true);
    expect(lines.join('\n')).toContain('vendor/model-b');
    const prompt = fake.requests[0]!.body.messages[1]!.content;
    expect(prompt).toContain('pilot-f19');
  });

  it('main fails clearly without models or with a bad date', async () => {
    const lines: string[] = [];
    expect(await main(['--date', DATE], { DATA_DIR: join(dir, 'd') }, (l) => lines.push(l))).toBe(
      2,
    );
    expect(lines.join()).toMatch(/BAKEOFF_MODELS/);
    expect(
      await main(['--date', '11.10'], { BAKEOFF_MODELS: 'a,b', DATA_DIR: join(dir, 'd') }, (l) =>
        lines.push(l),
      ),
    ).toBe(2);
  });
});
