/**
 * turso-driver-realm-guard.spec.ts — packet TUR-B, plan `862129b5`.
 *
 * The worker (`turso-driver-worker.ts`) exists so the native Turso driver chain
 * is absent from every main-thread module graph (ADR-0019, the plan's D3). That
 * property is invisible to the runtime in the happy path — the bundle still
 * loads and the tests still pass if the worker quietly grows an import of
 * `store-lease` (whose module-scope `localOpeners`/`registerStoreOpener` are
 * main-thread process state), of `deep-verify` (`scheduleDeepVerify`), or of any
 * other `store-adapter` module. So it is asserted structurally, twice:
 *
 *   1. a STATIC SCAN of the source's import specifiers — only Node builtins and
 *      `./turso-driver-protocol.js` are legal, the native driver is reached
 *      ONLY through a non-literal dynamic import, and no empty catch exists;
 *   2. a scan of the BUILT `dist/turso-driver-worker.js` (emitted by
 *      `nx build store-adapter`) for the exact main-thread-only symbols the
 *      realm must never carry.
 *
 * The specifier scan reads specifiers, never raw text — the module's own header
 * comment deliberately names the forbidden modules to explain their exclusion,
 * and a substring scan would flag its own documentation (the same discipline as
 * `turso-driver-protocol.spec.ts`).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE_PATH = fileURLToPath(new URL('../turso-driver-worker.ts', import.meta.url));
const DIST_PATH = fileURLToPath(new URL('../../dist/turso-driver-worker.js', import.meta.url));

/** The only legal non-`node:` import specifier for the worker realm. */
const LEGAL_NON_NODE_SPECIFIERS = new Set(['./turso-driver-protocol.js']);

/** Main-thread concerns that must never appear as an import specifier here. */
const FORBIDDEN_SPECIFIER_PATTERNS: readonly RegExp[] = [
  /@adhd\/sox-telemetry/,
  /store-lease/,
  /deep-verify/,
  /turso-adapter/,
  /sqlite-adapter/,
  /mock-adapter/,
  /factory/,
  /engine-guard/,
  /store-rebuild/,
  /op-tracing/,
  /integrity/,
  /cold-open-lock/,
  /preflight/,
  /wal-ownership/,
];

/**
 * Every static import specifier in a source file: `from 'x'` clauses and
 * LITERAL `import('x')` calls. A non-literal dynamic import has no specifier to
 * report — which is exactly the point (ADR-0019).
 */
function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]!);
}

describe('turso-driver-worker — realm isolation (source)', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');

  it('imports nothing but node builtins and ./turso-driver-protocol.js', () => {
    const specifiers = importSpecifiers(source);

    for (const spec of specifiers) {
      if (spec.startsWith('node:')) continue;
      expect(
        LEGAL_NON_NODE_SPECIFIERS.has(spec),
        `illegal import specifier in the worker realm: "${spec}"`,
      ).toBe(true);
    }

    // Positive control: the scan is non-vacuous — the protocol module (the one
    // legal non-node import) is genuinely present.
    expect(specifiers).toContain('./turso-driver-protocol.js');
    expect(specifiers.some((s) => s === 'node:worker_threads')).toBe(true);
  });

  it('names no main-thread module as an import specifier', () => {
    for (const spec of importSpecifiers(source)) {
      for (const pattern of FORBIDDEN_SPECIFIER_PATTERNS) {
        expect(pattern.test(spec), `forbidden specifier "${spec}" matched ${pattern}`).toBe(false);
      }
    }
  });

  it('reaches the native driver ONLY through a non-literal dynamic import (ADR-0019)', () => {
    // The specifier is held in a variable...
    expect(source).toMatch(/=\s*['"]@tursodatabase\/database['"]/);
    // ...and consumed by import(<identifier>), never a literal.
    expect(source).toMatch(/\bawait\s+import\(\s*[A-Za-z_$][\w$]*\s*\)/);
    // No static `from` import and no literal dynamic import of the driver.
    expect(source).not.toMatch(/\bfrom\s+['"]@tursodatabase\/database['"]/);
    expect(source).not.toMatch(/\bimport\(\s*['"]@tursodatabase\/database['"]\s*\)/);
  });

  it('contains no empty catch blocks', () => {
    expect(source).not.toMatch(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/);
  });
});

describe('turso-driver-worker — built artifact (dist)', () => {
  it('is emitted by the build (nx build store-adapter)', () => {
    expect(
      existsSync(DIST_PATH),
      `missing ${DIST_PATH} — run \`npx nx build store-adapter\` before the suite`,
    ).toBe(true);
  });

  it('carries none of the main-thread-only symbols', () => {
    const built = readFileSync(DIST_PATH, 'utf8');
    for (const symbol of ['localOpeners', 'registerStoreOpener', 'scheduleDeepVerify']) {
      expect(built).not.toContain(symbol);
    }
  });

  it('keeps the driver import non-literal in the emitted artifact', () => {
    const built = readFileSync(DIST_PATH, 'utf8');
    // The emitted JS must not eagerly require the native chain...
    expect(built).not.toMatch(/require\(\s*['"]@tursodatabase\/database['"]\s*\)/);
    // ...and must carry the specifier in a variable consumed by a dynamic import.
    expect(built).toMatch(/=\s*['"]@tursodatabase\/database['"]/);
    expect(built).toMatch(/\bimport\(\s*[A-Za-z_$][\w$]*\s*\)/);
  });
});
