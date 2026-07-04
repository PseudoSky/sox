/**
 * scripts/test-env-setup.ts — BL-179 hermetic data-root sandbox for root test suites.
 *
 * BL-179: scripts/*.test.ts harnesses sandboxed explicit paths (configPath/lockfilePath
 * into mkdtemp dirs) but did NOT set SOX_ECOSYSTEM_HOME, so the install engine's global
 * writes (installRegistryPath(), ledger/ownership at dataRoot('user'), user-scope lockfile
 * writes from getScopePaths('user')) landed in the REAL ~/.adhd/sox-ecosystem/ data root.
 *
 * Fix: this vitest globalSetup file creates a per-run mkdtemp scratch dir and injects
 * SOX_ECOSYSTEM_HOME before any test module loads. Because data-paths.ts reads
 * process.env at CALL time (not at module-load time), setting SOX_ECOSYSTEM_HOME in
 * globalSetup is sufficient to redirect every in-process engine call made during tests.
 *
 * The scratch dir is also exposed as SOX_TEST_ECOSYSTEM_HOME so individual test files
 * can inspect it (e.g. cli-adapter.test.ts passes it to spawned soxe processes).
 *
 * Cleanup: the scratch dir is removed in teardown unless SOX_TEST_KEEP_HOME=1.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let scratchHome: string | undefined;

export function setup(): void {
  // Create a per-run isolated data root that looks like ~/.adhd/sox-ecosystem/
  // but lives in a temp dir that will never be the real user data root.
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-test-home-'));

  // SOX_ECOSYSTEM_HOME is read at call time by data-paths.ts (both host-runtime and
  // install-engine copies) — setting it here redirects ALL userDataRoot() calls made
  // during the test run, including installRegistryPath(), ledgerPathFor('user'),
  // ownershipPathFor('user'), socketDir(), runDir(), and supervisorsPath().
  process.env['SOX_ECOSYSTEM_HOME'] = scratchHome;

  // Expose the path so cli-adapter.test.ts can forward it to spawned soxe processes.
  process.env['SOX_TEST_ECOSYSTEM_HOME'] = scratchHome;

  // Guard: confirm this is NOT the real user data root before proceeding.
  const realUserRoot = path.join(os.homedir(), '.adhd', 'sox-ecosystem');
  if (scratchHome === realUserRoot) {
    throw new Error(
      `[test-env-setup] BUG: scratch home resolved to the real user data root (${realUserRoot}). Aborting.`,
    );
  }

  // eslint-disable-next-line no-console
  console.error(`[test-env-setup] SOX_ECOSYSTEM_HOME → ${scratchHome} (BL-179 sandbox)`);
}

export function teardown(): void {
  if (scratchHome !== undefined && process.env['SOX_TEST_KEEP_HOME'] !== '1') {
    try {
      fs.rmSync(scratchHome, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — never fail teardown.
    }
  }
  delete process.env['SOX_ECOSYSTEM_HOME'];
  delete process.env['SOX_TEST_ECOSYSTEM_HOME'];
}
