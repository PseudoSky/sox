/**
 * vitest.global-guard.ts — BL-bae70da4 whole-run backstop.
 *
 * `vitest.home-scratch-setup.ts` (per-worker) is the primary fix, and
 * `vitest.home-guard-setup.ts` (per-worker) is the synchronous fs-touch
 * guard. This file is the outermost layer: a vitest `globalSetup`, which
 * runs in its OWN process, separate from every forked test worker, BEFORE
 * any worker starts and AFTER every worker has exited. It never sees the
 * per-worker `HOME` override, so `os.userInfo().homedir` (used here for
 * consistency with the other two guard files, though `os.homedir()` would
 * be equally correct in this process) always resolves the operator's real
 * home, and it can snapshot the real `~/.memory` both before ANY worker
 * runs and after ALL of them have finished and exited.
 *
 * ## Why this exists in addition to the fs-touch guard
 *
 * The fs-touch guard only sees `node:fs` calls made from ITS OWN worker
 * process, wrapped via CommonJS interop. It cannot see:
 *   - A native addon (e.g. better-sqlite3) making a raw syscall that never
 *     goes through Node's own `fs` bindings in a way the CJS-interop trick
 *     reaches.
 *   - A spawned child process that escapes the parent's env scrub AND
 *     inherits an unredirected `HOME` some other way.
 * This file cannot attribute a leak to a specific spec (it has no
 * per-test boundary — it wraps the whole run), but it observes disk state
 * directly, independent of any Node-level interception.
 *
 * ## Why this is a NAME-EXISTENCE diff, not a full listing+mtime diff
 *
 * `/Users/nix/.memory` is the operator's LIVE, actively-running production
 * store (memory-server is a persistent background service). Evidence
 * gathered 2026-09-28 04:26–04:29, two `readdirSync`-based recursive
 * snapshots taken ~2.5 minutes apart with NO test suite running, proves
 * the live service mutates this directory on its own, unprompted by any
 * test:
 *   - `memory.db`, `memory.db-wal`, `.sox-lease.d/*` — content/mtime
 *     changes essentially continuously (the live server is actively
 *     writing). A snapshot that tracked mtimes on every entry would
 *     therefore fail on EVERY run regardless of test behaviour, which
 *     would make the whole gate worthless (the team would just disable
 *     it) — so mtimes are deliberately not compared here.
 *   - New TOP-LEVEL files matching `memory.db-tshm.stale-<timestamp>`
 *     appeared roughly once a minute during the observation window
 *     (`memory.db-tshm.stale-2026-09-28-0829/0830/0831`), part of the
 *     BL-373 stale-sidecar reconciliation the live server runs
 *     continuously. These are excluded by name pattern below.
 *   - New/removed entries under `memory.db.sox-lease.d/` (both
 *     `.openers/<pid>` and `<uuid>` / `<uuid>.openmark` lease files)
 *     churned during the same window — normal per-connection lease
 *     bookkeeping, never a plausible name for a test-written artifact
 *     (nothing in memory-core's backup/write path ever creates a
 *     `*.sox-lease.d` entry). The whole subtree is excluded.
 * Every other path in both snapshots was byte-identical in name and
 * count (426 entries each run, zero adds/removes outside the two
 * excluded families) — see docs/reporting/memory/ findings for BL-bae70da4
 * for the raw before/after listings this class is derived from.
 *
 * The result: this guard fires on any ADDED or REMOVED path anywhere
 * under the real `~/.memory` tree that is NOT one of those two proven-
 * benign, continuously-churning families — including a brand-new
 * `sox-backup-test-*`/`sox-prune-test-*`/etc. directory landing directly
 * under `~/.memory`, or inside `backups/` (the default `autoBackup`
 * destination — deliberately NOT excluded, since it is exactly where a
 * leak would land; see `config.spec.ts`'s `resolveBackupConfig().dir`
 * default). It does not compare file CONTENTS or mtimes, only the set of
 * paths that exist — a "cheaper equivalent" of a full listing+mtime diff.
 *
 * This file only ever READS `~/.memory` (`readdirSync`/`statSync`). It
 * never creates, modifies, or deletes anything there.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const IGNORE_BASENAME_PATTERNS: readonly RegExp[] = [
  // BL-373 stale-sidecar reconciliation markers — created by the live
  // server roughly once a minute, proven churny by direct observation
  // (see file header). Never written by any memory-core spec or helper.
  /^memory\.db-tshm\.stale-/,
  // Per-connection lease bookkeeping directory — its contents churn
  // continuously while the live server is running; nothing in
  // memory-core's backup/write path ever creates a `*.sox-lease.d` entry.
  /\.sox-lease\.d$/,
];

function isIgnored(basename: string): boolean {
  return IGNORE_BASENAME_PATTERNS.some((re) => re.test(basename));
}

function snapshotPaths(root: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(root)) return out;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // Directory vanished or became unreadable mid-walk (e.g. the live
      // server pruned it between our readdir and a child's stat) — not a
      // guard failure, just an unreadable branch we skip. Traced, not
      // swallowed, per the repo's no-empty-catch rule.
      process.stderr.write(
        `[vitest.global-guard] BL-bae70da4: skipping unreadable dir during snapshot: ${dir}: ${String(err)}\n`,
      );
      return;
    }
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const full = path.join(dir, entry.name);
      out.add(full + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // os.userInfo().homedir ignores any per-worker HOME/USERPROFILE
  // redirect; this globalSetup process never gets one applied to it in
  // the first place (it runs outside every forked worker), but reading
  // it this way keeps the three guard files consistent and makes the
  // "real home" derivation obviously override-proof by inspection.
  const realMemRoot = path.join(os.userInfo().homedir, '.memory');
  const before = snapshotPaths(realMemRoot);

  return async function teardown(): Promise<void> {
    const after = snapshotPaths(realMemRoot);

    const added = [...after].filter((p) => !before.has(p));
    const removed = [...before].filter((p) => !after.has(p));

    if (added.length > 0 || removed.length > 0) {
      throw new Error(
        `BL-bae70da4 REGRESSION: the memory-core test run added/removed paths under the ` +
          `operator's real ${realMemRoot} — this must never happen.\n` +
          `added (${added.length}): ${JSON.stringify(added, null, 2)}\n` +
          `removed (${removed.length}): ${JSON.stringify(removed, null, 2)}\n` +
          `Investigate the offending spec before re-running. Do NOT delete or modify anything ` +
          `under ${realMemRoot} to "fix" this — report it instead.`,
      );
    }
  };
}
