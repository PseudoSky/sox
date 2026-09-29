/**
 * vitest.global-guard.ts — BL-bae70da4 whole-run backstop, and owner of the
 * per-run scratch HOME root.
 *
 * `vitest.home-scratch-setup.ts` (per-worker) redirects HOME, and
 * `vitest.home-guard-setup.ts` (per-worker) is the synchronous fs-touch
 * guard. This file is the outermost layer: a vitest `globalSetup`, which runs
 * in the main vitest process, separate from every forked test worker, BEFORE
 * any worker starts and AFTER every worker has exited. It never sees the
 * per-worker `HOME` override, and it reads the real home through
 * `os.userInfo().homedir` (a passwd-DB lookup that ignores `HOME`), so it can
 * snapshot the operator's real `~/.memory` both before any worker runs and
 * after all of them have exited.
 *
 * ## Why this exists in addition to the fs-touch guard
 *
 * The fs-touch guard only sees synchronous `node:fs` calls made from its own
 * worker. It cannot see async `fs`/`fs.promises` calls, a native addon (the
 * SQLite drivers) opening a file through its own syscalls, or a spawned child
 * process. This file cannot attribute a leak to a specific spec, but it
 * observes disk state directly, independent of any Node-level interception.
 *
 * ## What counts as a violation (`classifyMemoryRootDiff`)
 *
 * The real `~/.memory` is the operator's LIVE store: memory-server runs as a
 * background service and mutates this directory on its own for the whole
 * duration of a test run. A naive "any path added or removed" diff therefore
 * fails on runs where no test did anything wrong. The live service churns:
 *   - `memory.db-wal`, `memory.db-shm`, `memory.db-tshm` appearing and
 *     disappearing on checkpoint / close;
 *   - `memory.db-tshm.stale-<YYYY-MM-DD-HHMM>` / `-shm.stale-*` sidecars
 *     created by BL-373 stale-sidecar reconciliation (about one a minute) and
 *     pruned by `sidecar-retention.ts`; `memory.db.sidecar-sweep-marker`;
 *   - the `memory.db.sox-lease.d/` lease directory and its per-connection
 *     entries;
 *   - `backups/memory-<ISO>.db` (+ sidecars, `.auto-backup-<hash>` markers)
 *     added by `autoBackup()` and removed by `pruneRotatedBackups()`
 *     (`src/backup.ts`);
 *   - `.DS_Store` written by Finder.
 * Other stores that live next to `memory.db` (for example `embed-verify.db`)
 * grow and lose the same sidecars whenever any process opens them.
 *
 * So the guard is scoped to TEST-SHAPED artefacts. The rules apply in this
 * order, to every path added or removed between the two snapshots:
 *   1. Any path segment matching a test-artefact name (`TEST_ARTEFACT_PATTERNS`:
 *      `sox-*-test-*`, `sox-noexist-*`, `*.spec*` — the names memory-core's
 *      specs build under `os.homedir()/.memory`) is flagged at ANY depth,
 *      including inside `backups/`. This rule runs first so a test artefact
 *      can never be waved through by the live-family rule (for example
 *      `sox-backup-test-x.db-wal`).
 *   2. `.DS_Store` is ignored at any depth.
 *   3. A TOP-LEVEL entry is flagged unless it belongs to a live-store family
 *      (`isLiveTopLevelName`): `memory.db` itself, any `<stem>.db` sidecar
 *      (`-wal`, `-shm`, `-tshm`, `-journal`, `-(tshm|shm).stale-<stamp>`,
 *      `.sox-lease.d`, `.sidecar-sweep-marker`), or the `backups/` directory.
 *      A new `x.db`, `ro.db`, `raw.db` (the names `db.spec.ts` and
 *      `store-registry.spec.ts` build) or any other new directory is flagged.
 *   4. Everything else nested below the top level is ignored.
 *
 * ### Why `backups/` is covered only by rule 1
 *
 * A test-run backup and a live-server backup are indistinguishable by name:
 * both come from `autoBackup()`, which names every rotated file
 * `memory-<ISO timestamp>.db`. There is no test-run marker in that name, and
 * the live server adds and prunes those files during a run. Flagging every new
 * `backups/memory-*.db` would fail on every run where the live server rotated a
 * backup. A test-named directory or file under `backups/` is still flagged by
 * rule 1; any other test write into `backups/` is caught synchronously, as it
 * happens, by the fs-touch guard in `vitest.home-guard-setup.ts`, which
 * fails the offending test regardless of the file name.
 *
 * ## Failing the run
 *
 * vitest 4.1.8 runs globalSetup teardowns inside `Vitest.close()`, which
 * catches a thrown teardown error, logs it as "error during close", and lets
 * the process exit 0. A throw here therefore cannot fail the run. On a
 * violation the teardown sets `process.exitCode = 1` first, then prints the
 * report to stderr; vitest ends with a bare `process.exit()`, which honours
 * that code.
 *
 * `SOX_BL_BAE70DA4_EXTRA_GUARD_ROOT` (optional) names one ADDITIONAL directory
 * to guard with the same rules. The real `~/.memory` is always guarded; this
 * variable cannot remove or replace it. It exists so the non-zero exit path
 * can be proven end to end under `npx nx test memory-core` against a scratch
 * directory, without writing anything to the real store.
 *
 * This file only ever READS the guarded roots (`readdirSync`). It never
 * creates, modifies or deletes anything there. The only thing it deletes is
 * the per-run scratch root it created itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestProject } from 'vitest/node';

/** `project.provide` key for the per-run scratch root (see vitest.home-scratch-setup.ts). */
export const SCRATCH_RUN_ROOT_KEY = 'soxMemcoreScratchRunRoot';

declare module 'vitest' {
  export interface ProvidedContext {
    soxMemcoreScratchRunRoot: string;
  }
}

/** Names memory-core specs build under `os.homedir()/.memory`. Flagged at any depth. */
export const TEST_ARTEFACT_PATTERNS: readonly RegExp[] = [
  /^sox-.*-test-/, // sox-backup-test-*, sox-backup-test-dest-*, sox-backup-test-bl385-*, sox-memcore-test-*
  /^sox-noexist-/, // backup.spec.ts non-existent-source case
  /\.spec(\.|$)/, // anything named like a spec file
];

const DB_SIDECAR_SUFFIX =
  /\.db(-wal|-shm|-tshm|-journal|-(tshm|shm)\.stale-\d{4}-\d{2}-\d{2}-\d{4}|\.sox-lease\.d|\.sidecar-sweep-marker)$/;

/** True for a top-level entry the live server (or the OS) creates and removes on its own. */
export function isLiveTopLevelName(name: string): boolean {
  if (name === 'memory.db' || name === 'backups' || name === '.DS_Store') return true;
  return DB_SIDECAR_SUFFIX.test(name);
}

export interface GuardViolation {
  readonly change: 'added' | 'removed';
  readonly path: string;
  readonly reason: 'test-artefact-name' | 'unknown-top-level-entry';
}

/**
 * Classify the difference between two snapshots of a guarded root. Paths are
 * root-relative, POSIX-separated, with a trailing `/` on directories (the
 * shape `snapshotPaths` returns). Returns only the violations; live churn is
 * dropped. Pure: no disk access.
 */
export function classifyMemoryRootDiff(before: Iterable<string>, after: Iterable<string>): GuardViolation[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const changes: Array<{ change: 'added' | 'removed'; path: string }> = [];
  for (const p of afterSet) if (!beforeSet.has(p)) changes.push({ change: 'added', path: p });
  for (const p of beforeSet) if (!afterSet.has(p)) changes.push({ change: 'removed', path: p });

  const violations: GuardViolation[] = [];
  for (const { change, path: p } of changes) {
    const segments = p.split('/').filter((s) => s.length > 0);
    if (segments.some((s) => TEST_ARTEFACT_PATTERNS.some((re) => re.test(s)))) {
      violations.push({ change, path: p, reason: 'test-artefact-name' });
      continue;
    }
    const leaf = segments[segments.length - 1];
    if (leaf === '.DS_Store') continue;
    if (segments.length === 1 && leaf !== undefined && !isLiveTopLevelName(leaf)) {
      violations.push({ change, path: p, reason: 'unknown-top-level-entry' });
    }
  }
  return violations;
}

/** Root-relative listing of every path under `root` (directories end in `/`). Read-only. */
export function snapshotPaths(root: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(root)) return out;

  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // The live server can remove a directory between our readdir of its
      // parent and our readdir of it. Skip that branch; trace it.
      process.stderr.write(
        `[vitest.global-guard] BL-bae70da4: skipping unreadable dir during snapshot: ${dir}: ${String(err)}\n`,
      );
      return;
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        out.add(`${childRel}/`);
        walk(path.join(dir, entry.name), childRel);
      } else {
        out.add(childRel);
      }
    }
  };
  walk(root, '');
  return out;
}

/**
 * Snapshot `roots` now; the returned check re-snapshots, classifies, and on
 * any violation sets `process.exitCode = 1` and prints the report to stderr.
 * Returns true when a violation was found.
 */
export function armMemoryRootGuard(roots: readonly string[]): () => boolean {
  const before = new Map(roots.map((r) => [r, snapshotPaths(r)] as const));
  return function checkMemoryRoots(): boolean {
    let violated = false;
    for (const root of roots) {
      const violations = classifyMemoryRootDiff(before.get(root) ?? new Set(), snapshotPaths(root));
      if (violations.length === 0) continue;
      violated = true;
      process.exitCode = 1;
      process.stderr.write(
        `\nBL-bae70da4 REGRESSION: the memory-core test run added/removed test-shaped paths under ` +
          `${root} — this must never happen.\n` +
          `${JSON.stringify(violations, null, 2)}\n` +
          `Investigate the offending spec before re-running. Do NOT delete or modify anything ` +
          `under ${root} to "fix" this — report it instead.\n\n`,
      );
    }
    return violated;
  };
}

export default function globalSetup(project: TestProject): () => void {
  const roots = [path.join(os.userInfo().homedir, '.memory')];
  const extra = process.env['SOX_BL_BAE70DA4_EXTRA_GUARD_ROOT'];
  if (extra !== undefined && extra !== '') roots.push(path.resolve(extra));
  const check = armMemoryRootGuard(roots);

  // One scratch root per run. Each test file's setup creates its own scratch
  // HOME inside it (vitest.home-scratch-setup.ts), and the whole root is
  // removed here, after every worker has exited.
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-memcore-test-run-'));
  project.provide(SCRATCH_RUN_ROOT_KEY, runRoot);

  return function teardown(): void {
    try {
      check();
    } finally {
      fs.rmSync(runRoot, { recursive: true, force: true });
    }
  };
}
