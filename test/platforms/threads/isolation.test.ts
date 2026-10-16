import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Acceptance 4: the adapter is self-contained. Every import in src/platforms/threads points at a
// file of the same directory: nothing from src/publish, src/plan, src/store or any other part of
// the service, and no package. Since WP-PLAT-02 (scope item 11c) exactly two things live once in
// the service and are imported from outside the directory: the adapter contract
// (`src/platforms/types.ts`, types only) and the Threads length counter
// (`src/lib/threads-length.ts`, a pure file without imports).

const DIR = fileURLToPath(new URL('../../../src/platforms/threads/', import.meta.url));
const files = readdirSync(DIR, { recursive: true, encoding: 'utf8' }).filter((f) =>
  f.endsWith('.ts'),
);

/** Every module specifier of a file: static imports, re-exports and dynamic imports. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const p of patterns) for (const m of source.matchAll(p)) found.push(m[1]!);
  return found;
}

describe('src/platforms/threads is self-contained', () => {
  it('holds the adapter files', () => {
    expect(files).toEqual(expect.arrayContaining(['adapter.ts', 'client.ts', 'index.ts']));
  });

  const CONTRACT = '../types.js';
  const COUNTER = '../../lib/threads-length.js';
  /** The only files that may import the counter: the validator and the re-exporting index. */
  const COUNTER_USERS = ['index.ts', 'validate.ts'];

  it.each(files)('%s imports only from its own directory, the contract and the counter', (file) => {
    const imports = specifiers(readFileSync(`${DIR}${file}`, 'utf8'));
    for (const spec of imports) {
      if (spec === CONTRACT) continue;
      if (spec === COUNTER && COUNTER_USERS.includes(file)) continue;
      expect(spec, `${file} imports ${spec}`).toMatch(/^\.\/[a-z-]+\.js$/);
    }
  });

  it('the contract is imported as types only, and the counter itself imports nothing', () => {
    for (const file of files) {
      const source = readFileSync(`${DIR}${file}`, 'utf8');
      for (const line of source.split('\n').filter((l) => l.includes(`'${CONTRACT}'`))) {
        expect(line, `${file}: ${line}`).toMatch(/^(import|export) type /);
      }
    }
    const counter = fileURLToPath(new URL('../../../src/lib/threads-length.ts', import.meta.url));
    expect(specifiers(readFileSync(counter, 'utf8'))).toEqual([]);
    expect(files).not.toContain('types.ts');
    expect(files).not.toContain('threads-length.ts');
  });

  it('the scan itself sees imports (it is not vacuous)', () => {
    expect(specifiers(readFileSync(`${DIR}adapter.ts`, 'utf8'))).toContain('./client.js');
    expect(specifiers("import { x } from '../../store/index.js';")).toEqual([
      '../../store/index.js',
    ]);
    expect(specifiers("export * from '../publish/x.js'; await import('zod');")).toEqual([
      '../publish/x.js',
      'zod',
    ]);
  });
});
