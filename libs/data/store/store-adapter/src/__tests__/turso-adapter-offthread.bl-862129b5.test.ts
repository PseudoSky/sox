/**
 * turso-adapter-offthread.bl-862129b5.test.ts — packet TUR-D, plan `862129b5`.
 *
 * TUR-D rewires the Turso adapter (and the two main-thread driver call sites
 * TUR-C filed as `41f2a977`: `engine-guard.getEngineIdentity` and
 * `store-rebuild.stampRebuildMeta`) onto the process-wide off-thread driver host
 * (`turso-driver-host.ts`, TUR-C). The native `@tursodatabase/database` driver
 * must therefore be reachable from the MAIN thread ONLY as a type, never as a
 * value — the driver chain lives solely in the worker realm (`TUR-A`/`TUR-B`,
 * ADR-0019).
 *
 * The (A) invariant below is also the red→green regression guard for `41f2a977`
 * (no plan segment covered engine-guard.ts / store-rebuild.ts, so D3 realm
 * isolation was unachievable as planned): it has NO exemption for those two
 * files, and it fails while either still value-imports the driver.
 *
 * Two properties are pinned here:
 *
 *   A. VALUE-IMPORT INVARIANT — no non-test main-thread module value-imports
 *      `@tursodatabase/database`. The only value reference is the worker's
 *      NON-LITERAL dynamic import. This is asserted structurally (import
 *      specifiers, never raw text — the modules' own doc comments name the
 *      forbidden package to explain its exclusion).
 *
 *   B. ADAPTER-OPS-THROUGH-HOST — a real `TursoAdapterImpl` open + query
 *      genuinely runs on the off-thread host: the host reports a live worker
 *      thread and the connection it believes is open, `unwrap()` yields a host
 *      connection (numeric `connId`, no native `prepare`), `driverStatus` is a
 *      synchronous host snapshot, and the open recorded a `driver_host` phase.
 *
 * RED→GREEN (BL-225). Against the pre-TUR-D source:
 *   - (A) fails: `turso-adapter.ts`, `engine-guard.ts` and `store-rebuild.ts`
 *     each carried a literal `await import('@tursodatabase/database')`.
 *   - (B) fails at the first host assertion: the adapter opened the native
 *     driver in-thread, so no worker ever spawned (`workerThreadId === null`)
 *     and `driverStatus` did not exist.
 * Both pass with the rewiring.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { getTursoDriverStatus } from '../turso-driver-host.js';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch (err) {
    process.stderr.write(`[turso-adapter-offthread test] driver unavailable: ${String(err)}\n`);
    return false;
  }
})();
const itTurso = hasTurso ? it : it.skip;

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));
const WORKER_BASENAME = 'turso-driver-worker.ts';
const DRIVER = '@tursodatabase/database';

/** A source file is main-thread (in scope) unless it is a test/fixture. */
function isMainThreadSource(relPath: string): boolean {
  if (relPath.split(sep).includes('__tests__')) return false;
  if (relPath.endsWith('.spec.ts') || relPath.endsWith('.test.ts')) return false;
  return relPath.endsWith('.ts');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Every VALUE position that could load the driver at runtime:
 *   - a static `from '<driver>'` (or bare `import '<driver>'`), unless it is an
 *     `import type` (erased at emit),
 *   - a LITERAL `import('<driver>')` that is NOT a `.`-suffixed type access,
 *   - a plain `require('<driver>')`.
 * Deliberately NOT matched, both erased-or-inert on the main thread:
 *   - `import('<driver>').Type` / `import type { X } from '<driver>'` — the
 *     type-only forms the plan explicitly permits (a type import is erased at
 *     emit and cannot load the native chain);
 *   - `require.resolve('<driver>')` — resolves the package PATH (engine-guard's
 *     version stamp reads its package.json) without evaluating the native
 *     module, so it never defeats the worker-realm isolation, and there is no
 *     host API that exposes the driver version.
 */
function valueImportsDriver(source: string): boolean {
  const spec = `['"]${DRIVER}['"]`;
  for (const line of source.split('\n')) {
    if (new RegExp(`\\bawait\\s+import\\(\\s*${spec}\\s*\\)`).test(line)) return true;
    if (new RegExp(`\\brequire\\(\\s*${spec}\\s*\\)`).test(line)) return true;
    // A literal dynamic import used as a value (not a `.Type` type access).
    if (new RegExp(`\\bimport\\(\\s*${spec}\\s*\\)(?!\\s*\\.)`).test(line)) return true;
    if (new RegExp(`\\bfrom\\s+${spec}`).test(line) && !/\bimport\s+type\b/.test(line)) return true;
    if (new RegExp(`^\\s*import\\s+${spec}`).test(line)) return true; // side-effect import
    if (new RegExp(`^\\s*export\\s+.*\\bfrom\\s+${spec}`).test(line)) return true;
  }
  return false;
}

describe('TUR-D (A) — the native driver is value-imported ONLY by the worker', () => {
  const files = walk(SRC_DIR)
    .filter((f) => isMainThreadSource(relative(SRC_DIR, f)))
    .sort();

  it('scans a non-vacuous set of main-thread sources', () => {
    // Positive control: the scan found the adapter + the worker among the files.
    const names = files.map((f) => relative(SRC_DIR, f));
    expect(names).toContain('turso-adapter.ts');
    expect(names).toContain(WORKER_BASENAME);
    expect(names.length).toBeGreaterThan(20);
  });

  it('no non-test main-thread module value-imports @tursodatabase/database', () => {
    const offenders = files
      .filter((f) => relative(SRC_DIR, f) !== WORKER_BASENAME)
      .filter((f) => valueImportsDriver(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC_DIR, f));

    expect(offenders, `modules value-importing ${DRIVER} on the main thread`).toEqual([]);
  });

  it('the worker reaches the driver ONLY through a non-literal dynamic import', () => {
    const worker = readFileSync(join(SRC_DIR, WORKER_BASENAME), 'utf8');
    // The specifier is held in a variable and consumed via import(<identifier>).
    expect(worker).toMatch(new RegExp(`=\\s*['"]${DRIVER}['"]`));
    expect(worker).toMatch(/\bawait\s+import\(\s*[A-Za-z_$][\w$]*\s*\)/);
    // No static from-import, no literal dynamic import, no direct require.
    expect(worker).not.toMatch(new RegExp(`\\bfrom\\s+['"]${DRIVER}['"]`));
    expect(worker).not.toMatch(new RegExp(`\\bimport\\(\\s*['"]${DRIVER}['"]\\s*\\)`));
    expect(worker).not.toMatch(new RegExp(`\\brequire\\(\\s*['"]${DRIVER}['"]\\s*\\)`));
  });

  it('the three TUR-D rewired modules carry no literal driver reference at all', () => {
    for (const name of ['turso-adapter.ts', 'engine-guard.ts', 'store-rebuild.ts']) {
      const source = readFileSync(join(SRC_DIR, name), 'utf8');
      expect(
        valueImportsDriver(source),
        `${name} must not value-import ${DRIVER}`,
      ).toBe(false);
      // The `41f2a977` call sites specifically: no literal dynamic import.
      expect(source).not.toMatch(new RegExp(`\\bimport\\(\\s*['"]${DRIVER}['"]\\s*\\)`));
    }
  });
});

describe('TUR-D (B) — adapter ops run on the process-wide off-thread host', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'turso-adapter-offthread-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  itTurso('an adapter open + query completes through the host proxy', async () => {
    const dbPath = join(dir, 'adapter-offthread.db');
    const adapter = await TursoAdapterImpl.connect({ dbPath });

    // Force the deferred (DEBT-003 lazy) open with a real op.
    const row = await adapter.executeGet<{ one?: number }>('SELECT 1 AS one');
    expect(row?.one).toBe(1);

    // (B1) The adapter's connection lives on the host worker — the open spawned
    // it, and the host counts this connection.
    const status = adapter.driverStatus;
    expect(status.workerThreadId, 'the driver worker must be live after an adapter op').not.toBeNull();
    expect(status.openConnections).toBeGreaterThanOrEqual(1);
    expect(['idle', 'busy', 'stalled']).toContain(status.state);

    // `driverStatus` is query-free and never spawns: reading it twice is stable.
    expect(adapter.driverStatus.workerThreadId).toBe(status.workerThreadId);

    // (B2) `unwrap()` is the host connection, not a native `Database`.
    const conn = adapter.unwrap();
    expect(typeof conn.connId).toBe('number');
    expect(conn.connId).toBeGreaterThanOrEqual(0);
    expect(
      (conn as unknown as { prepare?: unknown }).prepare,
      'the native Database.prepare handle must not be reachable from the main thread',
    ).toBeUndefined();

    // (B3) The open recorded the new off-thread phase.
    expect(adapter.lastOpenTiming?.phases['driver_host']).toBeTypeOf('number');

    // (B4) An empty result shape still round-trips a query through the port.
    const empty = await adapter.executeAll('SELECT 1 AS one WHERE 0');
    expect(empty.rows).toEqual([]);
    expect(empty.columns).toEqual([]);

    await adapter.close();

    // The host reported exactly this connection; after close it drops it and the
    // worker is terminated once nothing is in flight.
    const after = getTursoDriverStatus();
    expect(after.openConnections).toBe(0);
  });
});
