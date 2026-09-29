/**
 * vitest.home-scratch-setup.ts — BL-bae70da4: redirect os.homedir() for the
 * whole memory-core test worker to a scratch directory, BEFORE any other
 * setup file or spec module runs.
 *
 * ## The hazard
 *
 * Every `~/.memory`-shaped path in memory-core is built from `os.homedir()`
 * at CALL time, not at module-load time:
 *   - `backup.ts:97-98` `memoryAllowlistRoot()` → `os.homedir()/.memory` — the
 *     allowlist backupStore() enforces on both source and destination.
 *   - `reembed.ts:119-120` `defaultMemoryDbPath()` → `os.homedir()/.memory/memory.db`.
 *   - `store-registry.ts:49-50` `getRegistryPath()` → `os.homedir()/.memory/registry.json`.
 *   - `restore-neardup.ts:573-574` `reportRoots()` → includes `os.homedir()/.memory`.
 *   - `db.ts:230-231` `expandDbPath()` expands a bare `~` / `~/...` prefix via `os.homedir()`.
 *   - `recall.ts:2224` expands a `~`-prefixed path the same way.
 * `backup.spec.ts`'s own helpers (`freshDbInsideAllowlist` at line 82-90,
 * `destPathInsideAllowlist` at line 92-99, the BL-385 Turso spec at line
 * 320-327, and the `autoBackup` spec at line 535-541) all call `os.homedir()`
 * directly and build a real `~/.memory/sox-backup-test-*` directory ON
 * PURPOSE, specifically so `isPathInMemoryAllowlist()` accepts it — that is
 * the mechanism that created
 * `/Users/nix/.memory/sox-backup-test-bl385-1790579878384-zsap0j7ml2s/` during
 * `npx nx test memory-core --skip-nx-cache` on 2026-09-28.
 *
 * ## The fix
 *
 * Node's `os.homedir()` reads `process.env.HOME` (POSIX) / `USERPROFILE`
 * (Windows) on EVERY call — it is not cached at process start (verified:
 * `HOME=/tmp/x node -e "console.log(os.homedir())"` prints `/tmp/x`). Setting
 * `HOME` once, here, before any other setup file or spec imports, therefore
 * redirects every call-site above — present and future — to a scratch tree
 * with zero per-spec changes required. `backup.spec.ts`'s helpers keep
 * calling `os.homedir()` exactly as before; they just no longer resolve to
 * the operator's real home.
 *
 * `os.userInfo().homedir` is a direct OS passwd-DB / API lookup and
 * deliberately IGNORES `HOME`/`USERPROFILE` (verified the same way) — it
 * stays anchored to the operator's real home even inside this worker. That
 * is exactly what `vitest.home-guard-setup.ts` (installed after this file)
 * and the BL-bae70da4 regression spec use as ground truth to prove the
 * redirect actually took effect, and what `vitest.global-guard.ts` uses to
 * snapshot the real `~/.memory` from the (unaffected) globalSetup process.
 *
 * ## Preserving unrelated behaviour
 *
 * Two other subsystems key off `os.homedir()`/`HOME` and are NOT part of
 * this bug — redirecting `HOME` without pinning them would silently change
 * their behaviour as a side effect of this fix:
 *   - `embed.ts:109-111` resolves the ONNX model cache dir from
 *     `SOX_EMBED_CACHE_DIR ?? XDG_CACHE_HOME ?? homedir()/.cache`, joined
 *     with `sox/models`. `embed.spec.ts` opts into the REAL bge-base-en-v1.5
 *     backend for a subset of tests; pointing that cache into a scratch dir
 *     that gets deleted at process exit would force a re-download (or an
 *     outright failure in a sandboxed run with no network) on every run.
 *     Pinning `SOX_EMBED_CACHE_DIR` to the dir embed.ts would have resolved
 *     against the real home — `(XDG_CACHE_HOME ?? <real home>/.cache)/sox/models`,
 *     the same derivation — keeps that model cache shared and warm,
 *     unchanged from before this fix.
 *   - `telemetry.ts:81-84` `ecosystemHome()` resolves
 *     `SOX_ECOSYSTEM_HOME ?? homedir()/.adhd/sox-ecosystem`, and
 *     `vitest.setup.ts`'s `initTelemetry()` call relies on that default so
 *     durable JSONL records land under the real
 *     `~/.adhd/sox-ecosystem/sox-tests/logs` (pre-existing behaviour,
 *     unrelated to BL-bae70da4 and out of scope for it). Pinning
 *     `SOX_ECOSYSTEM_HOME` to the real path before the redirect leaves that
 *     behaviour exactly as it was.
 *
 * Both pins read `os.userInfo().homedir` (the HOME-override-proof lookup)
 * rather than `os.homedir()`, so they resolve correctly even if a future
 * setupFiles reordering moved this file later.
 *
 * ## Scratch HOME lifetime
 *
 * `vitest.global-guard.ts` (globalSetup) creates ONE scratch root per run and
 * hands it down with `project.provide`. This file creates each test file's
 * scratch HOME inside that root with `mkdtempSync`, and the globalSetup
 * teardown removes the whole root after every worker has exited. Cleanup is
 * deliberately not tied to the worker's `process.on('exit')`, which does not
 * fire when a fork is torn down by a signal.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inject } from 'vitest';
import { SCRATCH_RUN_ROOT_KEY } from './vitest.global-guard';

const REAL_HOME = os.userInfo().homedir;

// Preserve pre-existing, unrelated-to-this-bug behaviour that would
// otherwise change as a side effect of redirecting HOME below. Same
// derivation as embed.ts resolveConfig(), evaluated against the real home.
if (process.env['SOX_EMBED_CACHE_DIR'] === undefined) {
  process.env['SOX_EMBED_CACHE_DIR'] = path.join(
    process.env['XDG_CACHE_HOME'] ?? path.join(REAL_HOME, '.cache'),
    'sox',
    'models',
  );
}
if (process.env['SOX_ECOSYSTEM_HOME'] === undefined) {
  process.env['SOX_ECOSYSTEM_HOME'] = path.join(REAL_HOME, '.adhd', 'sox-ecosystem');
}

const runRoot = inject(SCRATCH_RUN_ROOT_KEY);
if (typeof runRoot !== 'string' || runRoot === '' || !fs.existsSync(runRoot)) {
  throw new Error(
    'BL-bae70da4: vitest.home-scratch-setup.ts needs the per-run scratch root provided by ' +
      `vitest.global-guard.ts (globalSetup); got ${JSON.stringify(runRoot)}. Run memory-core ` +
      'tests through libs/memory-core/vitest.config.ts.',
  );
}

const scratchHome = fs.mkdtempSync(path.join(runRoot, 'home-'));
fs.mkdirSync(path.join(scratchHome, '.memory'), { recursive: true });

process.env['HOME'] = scratchHome;
// USERPROFILE is the Windows equivalent os.homedir() consults; harmless to
// set on darwin/linux too, and keeps this redirect platform-agnostic.
process.env['USERPROFILE'] = scratchHome;

/**
 * The scratch HOME this file installed. The BL-bae70da4 regression spec
 * asserts `os.homedir()` equals it, which proves the redirect it observes is
 * this file's, not some other HOME that happens to differ from the real one.
 */
process.env['SOX_TEST_SCRATCH_HOME'] = scratchHome;
