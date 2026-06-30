/**
 * libs/install-engine/src/data-paths.ts — ADR-0004 data-root resolver (install-engine copy).
 *
 * This is a BYTE-FOR-BYTE MIRROR of the authoritative resolver at
 * libs/host-runtime/src/data-paths.ts. It exists because this repo's cross-package
 * access pattern is lazy `require('@adhd/...')` + cast (static imports of a `@adhd/*`
 * package fail typecheck — the tsconfig path maps to `dist/index.js`, not `.d.ts`),
 * and a lazy require is NOT intercepted by vitest's `resolve.alias` in source-mode
 * tests. Rather than thread a fragile require through these hot path helpers
 * (getScopePath, resolveInstallRegistryPath, ledgerPath), install-engine keeps its
 * own dependency-free copy of the PURE path logic.
 *
 * DRIFT GUARD: `data-paths.parity.spec.ts` asserts this file is byte-identical to the
 * host-runtime original (below the header), so the two cannot silently diverge.
 *
 * Leaf module — node builtins only. No soxe imports.
 */

import * as os from 'node:os';
import * as path from 'node:path';

// ─── PARITY REGION START (must match libs/host-runtime/src/data-paths.ts) ─────

/** Installation scopes (ADR-0002/0003). */
export type DataScope = 'org' | 'user' | 'project' | 'local';

/** The canonical data subdir under every scope root. */
export const DATA_SUBDIR = path.join('.adhd', 'sox-ecosystem');

/**
 * The USER/global data root (ADR-0004 §D1).
 *   $SOX_ECOSYSTEM_HOME if set, else ~/.adhd/sox-ecosystem/.
 */
export function userDataRoot(): string {
  const override = process.env['SOX_ECOSYSTEM_HOME'];
  if (override !== undefined && override !== '') return override;
  return path.join(os.homedir(), DATA_SUBDIR);
}

/**
 * The data root for a given scope (ADR-0004 §D2 table).
 *   user / org-without-root → userDataRoot()
 *   project / local         → <root>/.adhd/sox-ecosystem/
 *   org (with root)         → <root>/.adhd/sox-ecosystem/
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
      if (root === undefined || root === '') return userDataRoot();
      return path.join(root, DATA_SUBDIR);
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

/** Per-scope config + lockfile paths (ADR-0004 §D2). */
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

/** Global install ledger path (ADR-0004 §D7): $userDataRoot/install-registry.json. */
export function installRegistryPath(): string {
  return path.join(userDataRoot(), 'install-registry.json');
}

/** Global supervisor registry path: $userDataRoot/supervisors.json. */
export function supervisorsPath(): string {
  return path.join(userDataRoot(), 'supervisors.json');
}

/** The runtime "run" dir under the user data root — locks, runtime.json, sockets, logs. */
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

// ─── PARITY REGION END ────────────────────────────────────────────────────────
