/**
 * libs/host-runtime/src/data-paths.ts — ADR-0004 single data-root resolver.
 *
 * THE one place every soxe data path is computed. Before ADR-0004 these were
 * scattered across three roots (~/.sox, ~/.config/extensions, <scopeRoot>/.sox)
 * and overloaded onto SOX_HOME. This module collapses them into the canonical
 * per-scope layout `<scopeRoot>/.adhd/sox-ecosystem/` (ADR-0004 §D2).
 *
 * Leaf module — imports ONLY node builtins (os, path). NO import from any sox
 * package, so install-engine / apps/sox / host-registry can all resolve through it.
 *
 * ── Two orthogonal env vars (ADR-0004 §D1, §D3) ──────────────────────────────
 *   SOX_ECOSYSTEM_HOME  — DATA ROOT override (this module). Default
 *                         ~/.adhd/sox-ecosystem/. Governs where soxe keeps its OWN
 *                         bookkeeping. NEVER reroutes host placements.
 *   SOX_SANDBOX_ROOT    — test isolation switch (host-registry). The ONLY thing
 *                         that reroutes host discovery paths. NOT read here.
 *
 * [inv:data-root-never-reroutes]: setting SOX_ECOSYSTEM_HOME must never change a
 * single host placement path — that is SOX_SANDBOX_ROOT's exclusive job. This
 * module computes data paths only; it has no knowledge of host discovery paths.
 *
 * Reads process.env at CALL time (never at module load) so env vars set after
 * import are honoured (tests, e2e harness).
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** Installation scopes (ADR-0002/0003). */
export type DataScope = 'org' | 'user' | 'project' | 'local';

/** The canonical data subdir under every scope root. */
export const DATA_SUBDIR = path.join('.adhd', 'sox-ecosystem');

/**
 * The USER/global data root (ADR-0004 §D1).
 *   $SOX_ECOSYSTEM_HOME if set, else ~/.adhd/sox-ecosystem/.
 * This is the home for the global install-registry, supervisors, locks, runtime
 * records, and logs, plus the user-scope config/lockfile/ledger/ownership/store.
 */
export function userDataRoot(): string {
  const override = process.env['SOX_ECOSYSTEM_HOME'];
  if (override !== undefined && override !== '') return override;
  return path.join(os.homedir(), DATA_SUBDIR);
}

/**
 * The data root for a given scope (ADR-0004 §D2 table).
 *   user / org-without-root  → userDataRoot()      ($SOX_ECOSYSTEM_HOME)
 *   project / local          → <root>/.adhd/sox-ecosystem/   (deterministic)
 *   org (with root)          → <root>/.adhd/sox-ecosystem/
 *
 * `root` is the workspace/scope root (e.g. the repo root for project scope, or an
 * org root). It is required for project/local/org-with-root; ignored for user.
 */
export function dataRoot(scope: DataScope, root?: string): string {
  switch (scope) {
    case 'user':
      return userDataRoot();
    case 'project':
    case 'local':
      if (root === undefined || root === '') {
        throw new Error(`[data-paths] scope '${scope}' requires a root directory`);
      }
      return path.join(root, DATA_SUBDIR);
    case 'org':
      // org defaults to the user/global root when no explicit org root is given.
      if (root === undefined || root === '') return userDataRoot();
      return path.join(root, DATA_SUBDIR);
    default: {
      // TypeScript exhaustiveness guard at compile time; at runtime an unvalidated
      // string can reach this branch (e.g. soxe install -s badscope). Throw a
      // structured error rather than silently returning the raw string as a path.
      const _exhaustive: never = scope;
      // _exhaustive carries the bad value at runtime despite the `never` type.
      const bad = _exhaustive as string;
      throw new Error(
        `[data-paths] unknown scope "${bad}". Valid scopes: org, user, project, local.`,
      );
    }
  }
}

/**
 * Per-scope config + lockfile paths (ADR-0004 §D2). Replaces the three duplicate
 * resolvers (install-engine getScopePath, host-runtime getScopePaths, and the
 * `~/.config/extensions` user path). local scope uses a distinct lockfile name so
 * project + local coexist under the same project data root.
 */
export function scopeConfigPaths(
  scope: DataScope,
  root?: string,
): { config: string; lockfile: string } {
  const base = dataRoot(scope, root);
  if (scope === 'local') {
    return {
      config: path.join(base, 'extensions.local.json'),
      lockfile: path.join(base, 'extensions.local.lock'),
    };
  }
  if (scope === 'org') {
    return {
      config: path.join(base, 'org.extensions.json'),
      lockfile: path.join(base, 'org.extensions.lock'),
    };
  }
  return {
    config: path.join(base, 'extensions.json'),
    lockfile: path.join(base, 'extensions.lock'),
  };
}

/** Per-scope provenance ledger path (ADR-0004 §D2). */
export function ledgerPathFor(scope: DataScope, root?: string): string {
  return path.join(dataRoot(scope, root), 'ledger.json');
}

/** Per-scope ownership index path (ADR-0004 §D5). */
export function ownershipPathFor(scope: DataScope, root?: string): string {
  return path.join(dataRoot(scope, root), 'ownership.json');
}

/** Per-scope materialized service-store root: <dataRoot>/ext/ (ADR-0004 §D2). */
export function storeRootFor(scope: DataScope, root?: string): string {
  return path.join(dataRoot(scope, root), 'ext');
}

// ── Global (user-root) state — install-registry, supervisors, run/ ────────────

/** Global install ledger path (ADR-0004 §D7): $userDataRoot/install-registry.json. */
export function installRegistryPath(): string {
  return path.join(userDataRoot(), 'install-registry.json');
}

/** Global supervisor registry path: $userDataRoot/supervisors.json. */
export function supervisorsPath(): string {
  return path.join(userDataRoot(), 'supervisors.json');
}

/**
 * The runtime "run" dir under the user data root — locks, runtime.json, sockets,
 * logs. Was ~/.sox/{logs,supervisors,…}. Now $userDataRoot/run/.
 */
export function runDir(): string {
  return path.join(userDataRoot(), 'run');
}

/** Log directory for a given supervisor: $userDataRoot/run/logs/<supervisorId>/. */
export function logDirFor(supervisorId: string): string {
  return path.join(runDir(), 'logs', supervisorId);
}

/** Exec-socket directory: $userDataRoot/run/supervisors/. */
export function socketDir(): string {
  return path.join(runDir(), 'supervisors');
}
