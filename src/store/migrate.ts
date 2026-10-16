import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const NAME_RE = /^(\d{3,})_[a-z0-9_]+\.sql$/;

/** `migrations/` at the repository root; works from both `src/store` and `dist/store`. */
export const DEFAULT_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);

/**
 * Applies pending forward-only migrations (`NNN_name.sql`, in numeric order).
 * Each file runs in its own IMMEDIATE transaction together with its bookkeeping row,
 * so a failure leaves that file entirely unapplied. Returns the names applied now.
 */
export function runMigrations(
  db: Database.Database,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const names = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const numbered = names.map((f) => {
    const m = NAME_RE.exec(f);
    if (!m) throw new Error(`Bad migration file name "${f}": expected NNN_name.sql`);
    return { f, n: Number(m[1]) };
  });
  const seen = new Map<number, string>();
  for (const { f, n } of numbered) {
    const other = seen.get(n);
    if (other) throw new Error(`Duplicate migration number ${n}: "${other}" and "${f}"`);
    seen.set(n, f);
  }
  const files = numbered.sort((a, b) => a.n - b.n).map((x) => x.f);
  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?');
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  const applied: string[] = [];
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const apply = db.transaction(() => {
      // Re-check inside the write lock: another process may have just applied it.
      if (isApplied.get(f)) return;
      db.exec(sql);
      record.run(f, new Date().toISOString());
      applied.push(f);
    });
    apply.immediate();
  }
  return applied;
}
