import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

/**
 * Epic 7 — Reporting owns no tables. Every figure must come from the owning
 * module's public read, so "hours", "support" and "delivered" keep exactly one
 * definition each. A direct table query here is how a second, divergent
 * definition gets introduced without anyone noticing.
 */
describe('reporting boundary (Epic 7, structural)', () => {
  const FILES = ['src/modules/reporting/service.ts'];

  it('never imports the database schema or a db handle for querying tables', () => {
    for (const f of FILES) {
      const src = read(f);
      expect(src).not.toMatch(/from '@\/db\/schema'/);
      expect(src).not.toMatch(/\.query\.\w+\.find/);
      expect(src).not.toMatch(/\bdb\.select\(/);
    }
  });

  it('reads only through other modules public barrels', () => {
    const src = read('src/modules/reporting/service.ts');
    const moduleImports = [...src.matchAll(/from '(@\/modules\/[^']+)'/g)].map((m) => m[1]!);
    expect(moduleImports.length).toBeGreaterThan(0);
    for (const imp of moduleImports) {
      // '@/modules/x' is the barrel; '@/modules/x/service' reaches past it.
      expect(imp.split('/')).toHaveLength(3);
    }
  });
});
