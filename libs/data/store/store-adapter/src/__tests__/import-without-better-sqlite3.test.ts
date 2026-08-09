/**
 * Regression: @adhd/sox-store-adapter must be importable where better-sqlite3
 * is not installed (a Turso-only consumer).
 *
 * better-sqlite3 is a SOFT dependency (optionalDependencies) used only by the
 * sqlite adapter path — it must never be imported at module scope. Before the
 * fix, the package's entry graph statically imported it
 * (src/sqlite-adapter.ts:1 → dist/sqlite-adapter.js), so a Turso-only
 * consumer's `import '@adhd/sox-store-adapter'` died with
 * ERR_MODULE_NOT_FOUND ("Cannot find package 'better-sqlite3'").
 *
 * This test builds a scratch consumer holding a REAL COPY of the package's
 * built dist (realpath isolation — a symlink would resolve back into the
 * workspace, where better-sqlite3 exists), provides the hard deps
 * (@adhd/sox-telemetry, @tursodatabase/database) but NOT better-sqlite3, and
 * imports the package entry in a child node process. It asserts the import
 * succeeds, the sqlite adapter path fails LOUD with the clear
 * "better-sqlite3 is not installed" message, and the Turso factory is intact.
 *
 * RED→GREEN: against the old module-scope-import dist the child exits 1 with
 * ERR_MODULE_NOT_FOUND; with the lazy-load dist it exits 0.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// nx runs vitest with cwd at the workspace root (project.json test target:
// `vitest run --config ...`, cwd "."). `import.meta.url` is NOT reliable here
// (vitest transforms test modules), so resolve the built dist from cwd.
const REPO_ROOT = process.cwd();
const DIST_DIR = join(REPO_ROOT, 'libs/data/store/store-adapter/dist');

describe('package import without better-sqlite3 (SOFT dep, lazy load)', () => {
  it('imports the package entry with better-sqlite3 absent; sqlite path fails loud', () => {
    // Precondition: the built dist exists (nx build store-adapter).
    expect(existsSync(join(DIST_DIR, 'index.js'))).toBe(true);

    const scratch = mkdtempSync(join(tmpdir(), 'store-adapter-no-bsql3-'));
    const pkgDir = join(scratch, 'node_modules', '@adhd', 'sox-store-adapter');
    const pkgDistDir = join(pkgDir, 'dist');
    mkdirSync(dirname(pkgDir), { recursive: true });
    // REAL COPY of the package — not a symlink, so bare-specifier resolution
    // walks up from the scratch tree, where better-sqlite3 does not exist.
    // package.json is required too: dist/adapter-meta.js reads ../package.json
    // (version stamp) and npm always ships it inside the installed package.
    cpSync(DIST_DIR, pkgDistDir, { recursive: true });
    cpSync(
      join(REPO_ROOT, 'libs/data/store/store-adapter/package.json'),
      join(pkgDir, 'package.json'),
    );

    // Hard deps only (they never import better-sqlite3) — deliberately NO
    // better-sqlite3 anywhere on the scratch resolution path. sox-telemetry is
    // a workspace package; @tursodatabase is linked per-package by pnpm (never
    // hoisted to the root), so both targets are the real dirs the workspace
    // itself resolves.
    mkdirSync(join(scratch, 'node_modules', '@adhd'), { recursive: true });
    const telemetryDir = join(REPO_ROOT, 'libs/observability/sox-telemetry');
    const tursoDir = join(
      REPO_ROOT,
      'libs/data/store/store-adapter/node_modules/@tursodatabase',
    );
    expect(existsSync(join(telemetryDir, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(tursoDir, 'database'))).toBe(true);
    symlinkSync(telemetryDir, join(scratch, 'node_modules', '@adhd', 'sox-telemetry'));
    symlinkSync(tursoDir, join(scratch, 'node_modules', '@tursodatabase'));

    const child = `
      (async () => {
        const m = await import('file://${pkgDistDir}/index.js');
        console.log('IMPORT_OK exports=' + Object.keys(m).length);
        let sqliteMsg = '(no error)';
        try { m.createSqliteAdapter({ dbPath: ':memory:' }); } catch (e) { sqliteMsg = String(e && e.message); }
        console.log('SQLITE_ERR ' + sqliteMsg);
        if (typeof m.createStoreAdapter !== 'function') throw new Error('missing createStoreAdapter export');
        console.log('API_OK');
      })().catch((e) => { console.error('CHILD_FAIL ' + (e && e.message)); process.exit(1); });
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
      encoding: 'utf8',
    });

    expect(run.status, `child stderr: ${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('IMPORT_OK');
    expect(run.stdout).toContain('SQLITE_ERR better-sqlite3 is not installed');
    expect(run.stdout).toContain('API_OK');
  });
});
