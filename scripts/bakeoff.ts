// Model bake-off (D-7): the same buildPlan for one date and one set of entries through 2-4
// models from BAKEOFF_MODELS, under the service's daily cap (same store, same llm_spend).
// Writes bakeoff/<date>/<model>.{json,md} and summary.md. Never stores plans.
//
//   npm run bakeoff -- --date 2026-10-11 [--entries file.json] [--out bakeoff]
//
// Env: OPENROUTER_API_KEY, LLM_DAILY_CAP_USD, BAKEOFF_MODELS, DATA_DIR (as the service).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { feedSchema } from '../src/api/feed-schema.js';
import { loadConfig, type Config } from '../src/config.js';
import type { FeedEntry } from '../src/lib/feed-types.js';
import { buildPlan, planDepsFromConfig } from '../src/plan/build.js';
import { mskDay, openStore, type Store } from '../src/store/index.js';

export const DEFAULT_ENTRIES = 'scripts/fixtures/bakeoff-entries.json';

export interface BakeoffOptions {
  date: string;
  entries: FeedEntry[];
  models: string[];
  outDir: string;
  store: Store;
  config: Config;
  now?: Date;
}

export interface BakeoffRow {
  model: string;
  status: 'draft' | 'failed';
  slots: number;
  costUsd: number;
  reason?: string;
}

/** `vendor/model:tag` -> `vendor__model_tag`. */
export const modelFileName = (model: string) =>
  model.replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '_');

const usd = (n: number) => `$${n.toFixed(4)}`;

export async function runBakeoff(o: BakeoffOptions): Promise<BakeoffRow[]> {
  if (o.models.length < 2 || o.models.length > 4) {
    throw new Error(`bake-off needs 2-4 models, got ${o.models.length}`);
  }
  const dir = join(o.outDir, o.date);
  mkdirSync(dir, { recursive: true });
  const rows: BakeoffRow[] = [];
  for (const model of o.models) {
    const r = await buildPlan(
      { date: o.date, entries: o.entries, now: o.now ?? new Date() },
      planDepsFromConfig(o.config, o.store, { model }),
    );
    const row: BakeoffRow = {
      model,
      status: r.status,
      slots: r.plan?.slots.length ?? 0,
      costUsd: r.costUsd,
      ...(r.reason ? { reason: r.reason } : {}),
    };
    rows.push(row);
    const base = join(dir, modelFileName(model));
    writeFileSync(`${base}.json`, JSON.stringify({ ...row, plan: r.plan }, null, 2) + '\n');
    writeFileSync(
      `${base}.md`,
      r.md ?? `# ${model}\n\nПлан не построен: ${r.reason ?? r.status}\n`,
    );
  }
  const total = rows.reduce((s, r) => s + r.costUsd, 0);
  const summary = [
    `# Bake-off ${o.date}`,
    '',
    '| Модель | Статус | Слотов | Стоимость | Причина |',
    '|---|---|---|---|---|',
    ...rows.map(
      (r) => `| ${r.model} | ${r.status} | ${r.slots} | ${usd(r.costUsd)} | ${r.reason ?? ''} |`,
    ),
    '',
    `Итого: ${usd(total)}`,
    '',
  ].join('\n');
  writeFileSync(join(dir, 'summary.md'), summary);
  return rows;
}

/** CLI entry; returns the exit code. */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  print: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      date: { type: 'string' },
      entries: { type: 'string', default: DEFAULT_ENTRIES },
      out: { type: 'string', default: 'bakeoff' },
    },
  });
  const now = new Date();
  const date = values.date ?? mskDay(new Date(now.getTime() + 86_400_000));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    print(`--date must be YYYY-MM-DD, got "${date}"`);
    return 2;
  }
  const config = loadConfig(env);
  if (config.BAKEOFF_MODELS.length < 2 || config.BAKEOFF_MODELS.length > 4) {
    print('BAKEOFF_MODELS must list 2-4 comma-separated OpenRouter model ids');
    return 2;
  }
  const entries = feedSchema.parse(JSON.parse(readFileSync(values.entries, 'utf8')));
  const store = openStore(join(config.DATA_DIR ?? './data', 'journalist.db'));
  try {
    const rows = await runBakeoff({
      date,
      entries,
      models: config.BAKEOFF_MODELS,
      outDir: values.out,
      store,
      config,
      now,
    });
    for (const r of rows) {
      print(`${r.model}\t${r.status}\t${r.slots} slots\t${usd(r.costUsd)}\t${r.reason ?? ''}`);
    }
    print(
      `spent today (MSK): ${usd(store.spend.today(now))}; outputs in ${join(values.out, date)}`,
    );
    return rows.some((r) => r.status === 'draft') ? 0 : 1;
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
