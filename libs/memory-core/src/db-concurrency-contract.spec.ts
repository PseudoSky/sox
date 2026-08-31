/**
 * db-concurrency-contract.spec.ts — BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001
 *
 * META-TEST: memory-core's production `createStoreAdapter` call sites (db.ts,
 * backup.ts) must DECLARE the store-concurrency mode explicitly — via the ONE
 * `STORE_MODE()` helper — rather than leaving it to the adapter's implicit
 * default. A bare `createStoreAdapter({ dbPath })` is exactly the silent
 * "open under an unverified mode" the contract exists to prevent: a future
 * backend added here would open without any caller having said what mode it
 * runs under, and without any compile-time or run-time tripwire to catch it.
 *
 * This spec SCANS THE SOURCE rather than exercising a runtime path, because the
 * defect it guards against is textual (a call site that stops passing
 * `concurrencyMode`), and no runtime assertion can distinguish "declared" from
 * "resolved by the factory's default" after the fact.
 *
 * RED→GREEN (BL-225): against the pre-contract code (bare
 * `createStoreAdapter({ dbPath })` at all seven sites — db.ts's five + backup.ts's
 * one + the test fixture), the `toMatch(/concurrencyMode\s*:/)` assertion fails
 * on every site, and the count assertions fail too (the sites existed but none
 * declared a mode). GREEN: every site now passes `concurrencyMode: STORE_MODE()`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Extract the config-object literal of every `createStoreAdapter({...})` call
 * in a source file. Returns the trimmed brace-body of each site. The `[^}]*`
 * body is safe here because none of the call sites nest braces in their config
 * object (all are flat `{ dbPath, ..., concurrencyMode: STORE_MODE() }`).
 */
function createStoreAdapterConfigBodies(relFile: string): string[] {
  const src = readFileSync(resolve(HERE, relFile), 'utf8');
  const bodies: string[] = [];
  const re = /createStoreAdapter\(\s*\{([^}]*)\}/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    bodies.push(m[1].trim());
  }
  return bodies;
}

describe('db-concurrency-contract — memory-core declares its store mode at every open (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001)', () => {
  it('every createStoreAdapter call in db.ts and backup.ts passes concurrencyMode explicitly', () => {
    for (const relFile of ['db.ts', 'backup.ts']) {
      const bodies = createStoreAdapterConfigBodies(relFile);
      // Non-vacuous: the scan must have found the call sites at all — a broken
      // regex or a renamed symbol must fail loudly, never read as "no bare sites".
      expect(bodies.length, `${relFile}: expected createStoreAdapter({...}) call sites`).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(
          body,
          `${relFile}: bare createStoreAdapter call site (no concurrencyMode): { ${body} }`,
        ).toMatch(/concurrencyMode\s*:/);
      }
    }
  });

  it('the site count is pinned — db.ts: 5, backup.ts: 1 — so a NEW bare site cannot hide behind the regex', () => {
    expect(createStoreAdapterConfigBodies('db.ts').length).toBe(5);
    expect(createStoreAdapterConfigBodies('backup.ts').length).toBe(1);
  });

  it('the declaration is via the ONE STORE_MODE() helper, not a duplicated literal', () => {
    for (const relFile of ['db.ts', 'backup.ts']) {
      const bodies = createStoreAdapterConfigBodies(relFile);
      for (const body of bodies) {
        expect(body, `${relFile}: concurrencyMode must route through STORE_MODE() — { ${body} }`).toMatch(
          /concurrencyMode\s*:\s*STORE_MODE\(\)/,
        );
      }
    }
  });
});
