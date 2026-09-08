import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const repositoriesDir = join(__dirname, 'repositories');

/**
 * Regression guard for a real, widespread defect found across nearly every
 * repository file: chaining Drizzle conditions with the JS `&&` operator
 * instead of the `and()` combinator, e.g.
 *
 *   .where(eq(a, x) && eq(b, y))
 *
 * `eq()` returns a truthy SQL object, so `&&` silently evaluates to just
 * its LAST operand — every earlier condition is computed (for its side
 * effects) and then discarded. `.where()` receives only the final
 * condition, so the query silently drops every filter but the last one.
 *
 * This is invisible to TypeScript (both operands and the `&&` result are
 * structurally valid SQL types) and invisible to any test that doesn't
 * specifically construct a case where the dropped condition(s) would have
 * excluded a row the kept condition still matches — which is exactly the
 * kind of scenario cross-tenant/cross-application isolation tests are
 * supposed to cover. It was found in tenant-application-links.ts (the
 * exact function backing `TenantRegistry.assertTenantAccess`), users.ts
 * (application-scoped login lookup), transactions.ts (idempotency key
 * lookup), suppliers.ts, conversations.ts, and others — see
 * docs/IMPLEMENTATION_CHANGELOG.md for the full list and fix.
 *
 * Rather than trust that every future PR remembers this, statically scan
 * every repository source file for the pattern and fail loudly if it
 * reappears.
 */
describe('repository .where() clauses use and(), never &&, to combine conditions', () => {
  const files = readdirSync(repositoriesDir).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );

  // Matches a Drizzle condition call (eq/ne/gt/gte/lt/lte/and/or/...)
  // immediately followed by `&&` — the specific shape that silently drops
  // every earlier operand. A trailing `&&` on its own line is the other
  // half of the same chain and is caught by the same regex on the next
  // line's leading condition, so scanning per-file (not per-line) is
  // simplest and sufficient.
  const CONDITION_THEN_AND = /\b(?:eq|ne|gt|gte|lt|lte|and|or|isNull|isNotNull|inArray|notInArray|like|ilike)\([^)]*\)\s*&&/;

  for (const file of files) {
    it(`${file} does not chain conditions with &&`, () => {
      const source = readFileSync(join(repositoriesDir, file), 'utf-8');
      expect(source).not.toMatch(CONDITION_THEN_AND);
    });
  }

  it('found at least one repository file to check (sanity check the scan itself runs)', () => {
    expect(files.length).toBeGreaterThan(5);
  });
});
