import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SERVICE = 'src/modules/messaging/service.ts';
const src = readFileSync(SERVICE, 'utf8');

/**
 * The same source with comments stripped. The bypass guard below asserts
 * something about the *code*; run against the raw file it trips on the doc
 * comment that explains the rule, which would push the next author towards
 * deleting the explanation to get back to green.
 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * US-8.3 — Messaging owns exactly two tables. The relationship gate ("is this
 * corporation involved with this project?") is Commitments' single definition,
 * spread across four tables Messaging does not own; organisation names and
 * author emails are Identity's. If Messaging ever queries those directly it has
 * forked a definition, and nothing else in the suite would notice.
 */
describe('messaging boundary (US-8.3, structural)', () => {
  it('imports only the tables it owns, plus the shared outbox', () => {
    // matchAll, not match: a non-global match only inspects the FIRST schema
    // import, so a second one lower down the file would be invisible to the
    // equality assertion below.
    const importBlocks = [...src.matchAll(/import \{([^}]*)\} from '@\/db\/schema';/g)];
    expect(importBlocks.length).toBeGreaterThan(0);
    const imported = importBlocks
      .flatMap((m) => m[1]!.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    // Asserted as an exact set, not as "does not contain X": a guard that only
    // checks for absence passes trivially if the regex above ever stops
    // matching, which is how this project has been bitten before.
    expect(imported.length).toBeGreaterThan(0);
    expect([...imported].sort()).toEqual(['messageThreads', 'messages', 'outbox']);
  });

  it('never reaches another context’s tables through the query builder', () => {
    const OWNED = ['messageThreads', 'messages'];
    const queried = [...src.matchAll(/(?:exec|tx|db)\.query\.(\w+)\./g)].map((m) => m[1]!);
    expect(queried.length).toBeGreaterThan(0);
    for (const table of queried) expect(OWNED).toContain(table);

    const written = [...src.matchAll(/\.(?:insert|update|delete)\((\w+)\)/g)].map((m) => m[1]!);
    expect(written.length).toBeGreaterThan(0);
    for (const table of written) expect([...OWNED, 'outbox']).toContain(table);

    // `.query.x` is not the only way in. The select-builder and raw SQL bypass
    // the guards above entirely, and `.select().from()` is used elsewhere in
    // this codebase, so it is a realistic drift path rather than a hypothetical.
    const selected = [...src.matchAll(/\.from\((\w+)\)/g)].map((m) => m[1]!);
    for (const table of selected) expect([...OWNED, 'outbox']).toContain(table);
    expect(code).not.toMatch(/\.execute\(/);
  });

  it('is never gated behind a paid plan (MONETISATION_MODEL Principle 3)', () => {
    // Messaging is core-loop. If it ever became an entitlement, a plan tier
    // would decide which corporations a charity is allowed to talk to, which
    // is exactly the merit-integrity line US-10.4 draws.
    expect(src).not.toMatch(/@\/modules\/monetisation/);
    expect(src).not.toMatch(/hasEntitlement|assertEntitlement|upgrade_required/);
  });

  it('reads other contexts only through their public barrels', () => {
    const moduleImports = [...src.matchAll(/from '(@\/modules\/[^']+)'/g)].map((m) => m[1]!);
    expect(moduleImports.length).toBeGreaterThan(0);
    for (const imp of moduleImports) {
      // '@/modules/x' is the barrel; '@/modules/x/service' reaches past it.
      expect(imp.split('/')).toHaveLength(3);
    }
  });

  it('has no platform-admin bypass to get wrong', () => {
    // A platform admin gets 404 because they hold no membership — not because
    // of a branch that could be inverted. Guard the absence of the branch.
    expect(code).not.toMatch(/isPlatformAdmin/);
    expect(code).not.toMatch(/\bbypass\b/i);
    // The stripper must not be silently emptying the file, or both assertions
    // above pass for free — the code still has to contain the check they guard.
    expect(code).toContain('NotFoundError');
  });

  it('never puts message text into an event payload', () => {
    // The outbox payload must carry the project title, never the body. A
    // preview would copy private words into two more jsonb stores and an email.
    const payloadBlock = src.slice(src.indexOf("eventType: 'MessagePosted'"));
    const payload = payloadBlock.slice(0, payloadBlock.indexOf('});'));
    expect(payload).toContain('title:');
    expect(payload).not.toMatch(/\bbody\b/);
    expect(payload).not.toMatch(/preview/i);
  });
});
