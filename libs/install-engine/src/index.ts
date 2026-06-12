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
  semverSatisfies,
  fetchArtifact,
  install,
} from './install.js';

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

// ─── parseArgs (A12 fix) ──────────────────────────────────────────────────────

/**
 * Parse CLI arguments — handles BOTH forms (A12 fix):
 *   --flag=value     (equals form)
 *   --flag value     (space-separated form)
 *   --flag           (boolean flag, value = 'true')
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
        if (next !== undefined && !next.startsWith('--')) {
          // --flag value form (space-separated)
          result[key] = next;
          i += 2;
        } else {
          // boolean flag
          result[key] = 'true';
          i++;
        }
      }
    } else {
      // positional — skip
      i++;
    }
  }
  return result;
}
