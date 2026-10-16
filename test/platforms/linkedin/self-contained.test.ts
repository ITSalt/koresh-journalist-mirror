import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Acceptance 4 of WP-PLAT-04: the adapter is self-contained. It imports nothing from the publish
// path, the plan or the store (nor from anywhere else in `src`), and no logger. Since WP-PLAT-02
// (scope item 11c) exactly one thing lives once in the service and is imported from outside the
// directory: the adapter contract (`src/platforms/types.ts`).

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../../../src/platforms/linkedin');
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

function imports(source: string): string[] {
  const found: string[] = [];
  const re = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) found.push(m[1]!);
  return found;
}

describe('src/platforms/linkedin is self-contained', () => {
  it('has the files of the package', () => {
    expect(files).toEqual(expect.arrayContaining(['escape.ts', 'client.ts', 'adapter.ts']));
  });

  const CONTRACT = '../types.js';

  it.each(files)('%s imports only its own directory, the contract and zod', (file) => {
    for (const spec of imports(readFileSync(join(dir, file), 'utf8'))) {
      if (spec === CONTRACT) continue;
      if (!spec.startsWith('.')) {
        expect(spec).toBe('zod');
        continue;
      }
      const target = relative(dir, resolve(dir, spec));
      expect(target.startsWith('..'), `${file} imports ${spec}`).toBe(false);
    }
  });

  it('the contract is the one copy: no local types.ts, and it imports nothing itself', () => {
    expect(files).not.toContain('types.ts');
    expect(imports(readFileSync(resolve(dir, '../types.ts'), 'utf8'))).toEqual([]);
    expect(imports(readFileSync(join(dir, 'adapter.ts'), 'utf8'))).toContain(CONTRACT);
  });

  it('escape.ts imports nothing at all (it can be swapped for the board version)', () => {
    expect(imports(readFileSync(join(dir, 'escape.ts'), 'utf8'))).toEqual([]);
  });

  it.each(files)('%s writes no log line', (file) => {
    const source = readFileSync(join(dir, file), 'utf8');
    expect(source).not.toMatch(/console\.|process\.std(out|err)|process\.env/);
  });
});
