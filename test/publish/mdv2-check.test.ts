import { describe, expect, it } from 'vitest';
import { mdv2Problems } from '../../src/publish/mdv2-check.js';

describe('mdv2Problems', () => {
  it('accepts escaped text, balanced bold and a quote line start', () => {
    expect(mdv2Problems('a\\.b *жирно* \\(x\\)\n>цитата\\!')).toEqual([]);
  });

  it('finds an unescaped special, an unbalanced bold and a stray backslash', () => {
    expect(mdv2Problems('a.b')).toEqual(['unescaped . at 1']);
    expect(mdv2Problems('*a')).toEqual(['unbalanced bold']);
    expect(mdv2Problems('a\\b')).toEqual(['stray backslash at 1']);
    expect(mdv2Problems('a > b')).toEqual(['unescaped > at 2']);
    for (const c of '_[]()~`#+-=|{}!') expect(mdv2Problems(`x${c}`), c).not.toEqual([]);
  });
});
