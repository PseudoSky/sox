/**
 * libs/install-engine/src/index.ts
 *
 * Re-homes the install/cascade/build-index/lockfile logic from scripts/ into
 * a pure nx lib. No @nx/devkit imports. No CLI entry point — that lives in apps/sox.
 *
 * [def:session-fixes] carried forward:
 *   - Registry drift gate (from install.ts)
 *
 * A12 fix: parseArgs handles BOTH --flag value AND --flag=value.
 */

// ─── Re-export cascade ────────────────────────────────────────────────────────

export type {
  ScopeConfig as CascadeScopeConfig,
  ResolvedConfigMap,
  ResolvedConfigEntry,
} from './cascade.js';
export { cascade, deepMerge } from './cascade.js';

// ─── Re-export install ────────────────────────────────────────────────────────

export type {
  Scope,
  InstallMode,
  InstallEntry,
  ScopeConfig,
  LockfileEntry,
  LockfileExtendsPin,
  Lockfile,
  ResolvedEntry,
  ResolvedSet,
  IndexEntry,
  ExtensionManifest,
  InstallOptions,
} from './install.js';
export {
  getScopePath,
  loadConfig,
  loadLockfile,
  resolveEnvRef,
  loadRegistryIndex,
  resolveFromRegistry,
  normalizeLockfile,
  LOCKFILE_VERSION,
  writeLockfileAtomic,
  fetchArtifact,
  install,
  declarativeInstall,
  DeclarativeDeniedError,
  findLocalExtension,
  loadExtensionManifest,
  SCOPES,
} from './install.js';
export type { InstallDescriptor, DeclarativeInstallResult } from './install.js';

// ─── Re-export verify-integrity (ADR-0003 is-this-current primitive) ──────────

export type {
  IntegrityStatus,
  IntegrityResult,
  VerifyIntegrityOptions,
} from './verify-integrity.js';
export { verifyIntegrity } from './verify-integrity.js';

// ─── Re-export build-index ────────────────────────────────────────────────────

export type { IndexEntry as BuildIndexEntry } from './build-index.js';
export { buildIndex, checksumUrl } from './build-index.js';

// ─── Re-export provider-capabilities ─────────────────────────────────────────

export type {
  RequiresBlock,
  CapabilityResult,
  ModelCapabilityEntry,
} from './provider-capabilities.js';
export { checkProviderCapabilities, loadCapabilityTable } from './provider-capabilities.js';


// ─── Re-export lifecycle (update / uninstall) ─────────────────────────────────

export type { LifecycleCtx, UpdateCtx, UpdateResult, HostScope as LifecycleHostScope } from './lifecycle.js';
export { uninstall, update, ReverseAbortError } from './lifecycle.js';

// ─── ADR-0004: ownership index ───────────────────────────────────────────────
export {
  OwnershipIndex,
  readOwnership,
  writeOwnershipAtomic,
  supersededEntries,
} from './ownership.js';
export type { OwnedEntry, OwnershipRecord, OwnershipFile } from './ownership.js';

// ─── #16728 fix: auto-merge user-scope MCP servers into project .mcp.json ──────
export {
  syncUserMcpToProjects,
  reverseUserMcpFromProjects,
  registerUserMcpServer,
  knownProjectRoots,
  resolveUserMcpConfigPath,
  resolveProjectMcpConfigPath,
  readGlobalServerEntry,
} from './mcp-project-sync.js';
export type { ProjectSyncResult, SyncMcpOptions } from './mcp-project-sync.js';

// ─── ADR-0004: data-paths resolver (leaf) ────────────────────────────────────
export {
  dataRoot,
  userDataRoot,
  scopeConfigPaths,
  ledgerPathFor,
  ownershipPathFor,
  storeRootFor,
  installRegistryPath,
} from './data-paths.js';
export type { DataScope } from './data-paths.js';

// ─── Re-export diff ──────────────────────────────────────────────────────────

export type { ActionDiff, ExtensionDiff, DiffKind } from './diff.js';
export { diff, diffAll } from './diff.js';

// ─── Re-export install-registry (P9) ─────────────────────────────────────────

export type { InstallRecord, InstallRegistry, UpsertInstallRecordOpts } from './install-registry.js';
export {
  resolveInstallRegistryPath,
  readInstallRegistry,
  writeInstallRegistryAtomic,
  upsertInstallRecord,
  removeInstallRecord,
} from './install-registry.js';

// ─── parseArgs (A12 fix) ──────────────────────────────────────────────────────

/**
 * Short-flag aliases: single-char flags map to their long-form names.
 * `-s project` is treated as `--scope=project`.
 */
const SHORT_ALIASES: Record<string, string> = {
  s: 'scope',
};

/**
 * Parse CLI arguments — handles BOTH forms (A12 fix):
 *   --flag=value     (equals form)
 *   --flag value     (space-separated form)
 *   --flag           (boolean flag, value = 'true')
 *   -s value         (short-flag alias, e.g. -s project → scope=project)
 *
 * This is the canonical parseArgs for the engine libs. It is exported and
 * testable independently. The reference pattern is [ref:dual-flag-form].
 *
 * @param argv - raw argv array (e.g. process.argv.slice(2))
 * @returns key-value map of all parsed flags
 */
export function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) { i++; continue; }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        // --flag=value form
        const key = arg.slice(2, eq);
        const val = arg.slice(eq + 1);
        result[key] = val;
        i++;
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          // --flag value form (space-separated)
          result[key] = next;
          i += 2;
        } else {
          // boolean flag
          result[key] = 'true';
          i++;
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Short-flag form: -s project → scope=project
      const shortKey = arg.slice(1);
      const longKey = SHORT_ALIASES[shortKey];
      if (longKey !== undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          result[longKey] = next;
          i += 2;
        } else {
          result[longKey] = 'true';
          i++;
        }
      } else {
        // unknown short flag — skip
        i++;
      }
    } else {
      // positional — store as '_' (first positional wins; subsequent go to '_2', '_3', ...)
      if (result['_'] === undefined) {
        result['_'] = arg;
      } else {
        let n = 2;
        while (result[`_${n}`] !== undefined) n++;
        result[`_${n}`] = arg;
      }
      i++;
    }
  }
  return result;
}
