/**
 * libs/host-runtime/src/ext-config-cascade.ts — SCOPE-DETERMINISTIC extension
 * config cascade (backlog 5f98a1ff-eb07-4399-9369-6dba0ca57e7c).
 *
 * ── The bug this module exists to kill ───────────────────────────────────────
 * Both cascade implementations (`apps/sox/src/main.ts` and
 * `libs/host-runtime/src/runtime-cli.ts`) merged the four scopes
 * org→user→project→local keyed on a `root` that callers defaulted to
 * `process.cwd()`. `scopeConfigPaths('project', cwd)` then reads
 * `<cwd>/.adhd/sox-ecosystem/extensions.json`, so a `soxe service enable …
 * -s user` invoked from a repo root silently bound that repo's *project* config
 * (e.g. `db_path=~/.memory/memory-dev.db`) into a **user** OS unit — a persistent
 * unit whose store binding depended on where soxe happened to be run. Re-running
 * from `$HOME` resolved a different store. That is silent config drift.
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 * A unit's config cascade is a function of the unit's SCOPE alone, never of the
 * process CWD:
 *   - `user` / `org`   → only org+user participate; `project`/`local` NEVER do,
 *                        and the (cwd-derived) `root` is not consulted.
 *   - `project`/`local`→ require an explicit `root`; a missing/empty root REFUSES
 *                        (`CwdScopeMismatchError`) rather than falling back to cwd.
 *
 * `soxe service enable --root` / `--scope` is the operator's explicit statement of
 * the resolution root. When the resolved store would come from a scope outside the
 * unit's own participating set, {@link assertScopeConsistent} refuses with the
 * typed {@link E_CWD_SCOPE_MISMATCH} code and the caller writes NOTHING.
 *
 * Leaf module: imports only `node:fs`/`node:os` and the ADR-0004 path resolver, so
 * both apps/sox and host-runtime can share one definition (never two).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';

import { scopeConfigPaths, type DataScope } from './data-paths.js';

/**
 * Typed refusal code (ADR-0013: typed config only, NO new env var). Raised when a
 * config cascade for a persistent unit would resolve through a scope that is not
 * the unit's own scope — i.e. a cwd-derived store binding.
 */
export const E_CWD_SCOPE_MISMATCH = 'E_CWD_SCOPE_MISMATCH' as const;

/** Error carrying {@link E_CWD_SCOPE_MISMATCH}; callers translate it to stderr + a non-zero exit. */
export class CwdScopeMismatchError extends Error {
  readonly code = E_CWD_SCOPE_MISMATCH;
  constructor(message: string) {
    super(message);
    this.name = 'CwdScopeMismatchError';
  }
}

/** A persistent unit's install scope — the same four scopes as {@link DataScope}. */
export type UnitScope = DataScope;

/**
 * The config scopes a unit of `scope` may draw from, broad→narrow (narrowest wins).
 *
 * `user`/`org` deliberately EXCLUDE `project`/`local`: those resolve through the
 * caller's `root` (historically cwd), and letting them participate is exactly the
 * silent dev-store binding this module exists to prevent.
 */
export function cascadeScopesForUnitScope(scope: UnitScope): DataScope[] {
  switch (scope) {
    case 'org':
      return ['org'];
    case 'user':
      return ['org', 'user'];
    case 'project':
      return ['org', 'user', 'project'];
    case 'local':
      return ['org', 'user', 'project', 'local'];
  }
}

/** Scopes whose config path is resolved relative to the caller's (cwd-derived) `root`. */
export function isRootDerivedScope(scope: DataScope): boolean {
  return scope === 'project' || scope === 'local';
}

/** A resolved cascade: the `SOX_CONFIG_*` env plus, per key, the scope that won. */
export interface ExtConfigCascade {
  env: Record<string, string>;
  provenance: Record<string, DataScope>;
}

/**
 * Refuse when a resolved cascade drew a `SOX_CONFIG_*` value from a scope that is
 * not in the unit's participating set (req. #3 — the write-boundary guard).
 *
 * The builder below already filters to the participating set, so this is a
 * defence-in-depth invariant: if a future edit widens the cascade, the refusal is
 * a loud typed error instead of a silent cross-scope store binding.
 */
export function assertScopeConsistent(
  scope: UnitScope,
  provenance: Record<string, DataScope>,
): void {
  const allowed = new Set<DataScope>(cascadeScopesForUnitScope(scope));
  for (const [envKey, from] of Object.entries(provenance)) {
    if (!allowed.has(from)) {
      throw new CwdScopeMismatchError(
        `refusing to bind ${envKey} into a '${scope}' unit: it resolved from the ` +
        `'${from}' scope, which is not part of a '${scope}' unit's config cascade ` +
        `(a root-derived scope must never be inferred from the current working ` +
        `directory when writing a persistent unit) [${E_CWD_SCOPE_MISMATCH}]`,
      );
    }
  }
}

/**
 * Build the scope-deterministic `SOX_CONFIG_*` env for a persistent unit.
 *
 * @throws CwdScopeMismatchError when `scope` is root-derived (project/local) and
 *         no explicit `root` was supplied, or if the resulting provenance carries
 *         a scope outside the unit's participating set.
 */
export function buildScopeDeterministicExtConfigEnv(
  extId: string,
  scope: UnitScope,
  root: string | undefined,
): ExtConfigCascade {
  if (isRootDerivedScope(scope) && (root === undefined || root === '')) {
    throw new CwdScopeMismatchError(
      `scope '${scope}' requires an explicit --root: refusing to derive the ` +
      `extension-config cascade root from the current working directory (the ` +
      `resolved store would silently depend on where soxe happens to be invoked) ` +
      `[${E_CWD_SCOPE_MISMATCH}]`,
    );
  }

  const merged: Record<string, unknown> = {};
  const winner: Record<string, DataScope> = {};
  for (const cs of cascadeScopesForUnitScope(scope)) {
    let configPath: string;
    try {
      // user/org resolve to the global data root and IGNORE root (req. #1 — the
      // root for those scopes is never the cwd); project/local use the explicit root.
      configPath = scopeConfigPaths(cs, isRootDerivedScope(cs) ? root : undefined).config;
    } catch {
      continue; // scope has no resolvable path — skip
    }
    if (!fs.existsSync(configPath)) continue;
    let raw: { config?: Record<string, Record<string, unknown>> };
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as typeof raw;
    } catch {
      continue; // unreadable/malformed config — skip (matches prior behaviour)
    }
    const block = raw.config?.[extId];
    if (!block || typeof block !== 'object') continue;
    for (const [k, v] of Object.entries(block)) {
      merged[k] = v;
      winner[k] = cs;
    }
  }

  const homeDir = os.homedir();
  const env: Record<string, string> = {};
  const provenance: Record<string, DataScope> = {};
  for (const [k, v] of Object.entries(merged)) {
    const envKey = `SOX_CONFIG_${k.toUpperCase().replace(/[-\s]/g, '_')}`;
    let strVal = typeof v === 'string' ? v : (v === null || v === undefined ? '' : JSON.stringify(v));
    if (strVal.startsWith('~/')) strVal = homeDir + strVal.slice(1);
    strVal = strVal.replace(/\$\{([A-Z0-9_]+)\}/g, (_m: string, varName: string) => process.env[varName] ?? _m);
    env[envKey] = strVal;
    provenance[envKey] = winner[k]!;
  }

  assertScopeConsistent(scope, provenance);
  return { env, provenance };
}
