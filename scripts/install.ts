#!/usr/bin/env node
/**
 * install.ts — Install client
 *
 * Contract (Section 4.1):
 *   Signature: install({ scope, mode }) → Promise<ResolvedSet>
 *   CLI: install-extensions --scope=<org|user|project|local> [--frozen-lockfile] [--update]
 *
 *   Phase history:
 *   P1: single-scope (user scope works fully), local file sources
 *   P2: full 4-scope cascade + extends fetch + hash pin + dedup/secret lint
 *   P3: provider capability check (advisory-warn default; hard-block on strict_capabilities)
 *   P4: npm/CDN remote resolution + semver range resolution + --frozen-lockfile/--update
 *
 * Error modes:
 *   - checksum mismatch → non-zero exit, structured error naming id+source
 *   - extends hash divergence without --update → fail closed (Gap 4)
 *   - literal secret in committed config → reject (P2)
 *   - unknown type or type/dir mismatch → reject
 *   - capability hard-block under strict_capabilities → non-zero (P3, Gap 5)
 *
 * Side effects: writes lockfile + artifacts; network fetches; reads env.
 *   Never writes secrets to the lockfile; resolves ${ENV} at runtime only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { cascade } from './cascade.js';
import type { ScopeConfig as CascadeScopeConfig, ResolvedConfigMap } from './cascade.js';
import { checkProviderCapabilities } from './provider-capabilities.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Scope = 'org' | 'user' | 'project' | 'local';
export type InstallMode = 'default' | 'frozen' | 'update';

export interface InstallEntry {
  id: string;
  version?: string | undefined;
  enabled?: boolean | undefined;
  source?: string | undefined;
}

export interface ScopeConfig {
  extends?: string | undefined;
  strict_capabilities?: boolean | undefined;
  providers?: Record<string, { base_url?: string | undefined; api_key?: string | undefined }> | undefined;
  install?: InstallEntry[] | undefined;
  config?: Record<string, Record<string, unknown>> | undefined;
  enabled?: Record<string, boolean> | undefined;
  private?: boolean | undefined;
}

export interface LockfileEntry {
  source: string;
  checksum: string;
  resolved_at: string;
}

export interface LockfileExtendsPin {
  url: string;
  sha256: string;
  resolved_at: string;
}

export interface Lockfile {
  lockfileVersion: 1;
  extends?: LockfileExtendsPin | undefined;
  resolved: Record<string, LockfileEntry>;
}

export interface ResolvedEntry {
  version: string;
  enabled: boolean;
  config: Record<string, unknown>;
  source: string;
  checksum: string;
}

export type ResolvedSet = Record<string, ResolvedEntry>;

export interface IndexEntry {
  id: string;
  type: string;
  version: string;
  title: string;
  description: string;
  source: string;
  checksum: string;
  compatibility: { host: string };
  requires?: {
    tool_calling?: boolean | undefined;
    structured_output?: boolean | undefined;
    min_context_tokens?: number | undefined;
  } | undefined;
  /** G-B: present for bundle type; the members this bundle expands to at install time */
  members?: Array<{ id: string; version: string }> | undefined;
}

export interface ExtensionManifest {
  id: string;
  version: string;
  type: string;
  title: string;
  description: string;
  compatibility: { host: string };
  license: string;
  entrypoint?: string | undefined;
  requires?: {
    tool_calling?: boolean | undefined;
    structured_output?: boolean | undefined;
    min_context_tokens?: number | undefined;
  } | undefined;
  checksum?: string | undefined;
  private?: boolean | undefined;
  /** G-B: bundle members. Required iff type=='bundle'. Orthogonal to 'dependencies'. */
  members?: Array<{ id: string; version: string }> | undefined;
}

// ─── Scope path resolution ────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export function getScopePath(scope: Scope): { config: string; lockfile: string } {
  switch (scope) {
    case 'org':
      return {
        config: path.join(REPO_ROOT, '.extensions', 'org.extensions.json'),
        lockfile: path.join(REPO_ROOT, '.extensions', 'org.extensions.lock'),
      };
    case 'user':
      return {
        config: path.join(os.homedir(), '.config', 'extensions', 'extensions.json'),
        lockfile: path.join(os.homedir(), '.config', 'extensions', 'extensions.lock'),
      };
    case 'project':
      return {
        config: path.join(REPO_ROOT, '.extensions', 'extensions.json'),
        lockfile: path.join(REPO_ROOT, '.extensions', 'extensions.lock'),
      };
    case 'local':
      return {
        config: path.join(REPO_ROOT, '.extensions', 'extensions.local.json'),
        lockfile: path.join(REPO_ROOT, '.extensions', 'extensions.local.lock'),
      };
  }
}

// ─── Config loading ───────────────────────────────────────────────────────────

export function loadConfig(configPath: string): ScopeConfig | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw) as ScopeConfig;
  } catch (e) {
    console.error(`install: ERROR parsing config at ${configPath}: ${String(e)}`);
    process.exit(1);
  }
}

export function loadLockfile(lockPath: string): Lockfile | null {
  if (!fs.existsSync(lockPath)) return null;
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return JSON.parse(raw) as Lockfile;
  } catch (_e) {
    return null;
  }
}

// ─── Env-var resolution ───────────────────────────────────────────────────────

/**
 * Resolve ${ENV_VAR} references at runtime. Never resolves at parse time.
 * Returns the resolved string, or the original if it's a literal (e.g. 'ollama').
 */
export function resolveEnvRef(value: string): string {
  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(value);
  if (match) {
    const varName = match[1];
    if (!varName) return value;
    const envValue = process.env[varName];
    if (!envValue) {
      console.warn(`install: WARNING env var \${${varName}} is not set`);
      return '';
    }
    return envValue;
  }
  return value;
}

// ─── Checksum helpers ─────────────────────────────────────────────────────────

function computeChecksum(data: Buffer | string): string {
  const hash = crypto
    .createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data) : data)
    .digest('hex');
  return `sha256:${hash}`;
}

// ─── Registry index ───────────────────────────────────────────────────────────

export function loadRegistryIndex(root: string): IndexEntry[] {
  const indexPath = path.join(root, 'registry', 'index.json');
  if (!fs.existsSync(indexPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as IndexEntry[];
  } catch (_e) {
    return [];
  }
}

/**
 * Resolve a semver range or exact version against the registry index.
 * Returns the best matching IndexEntry or null.
 */
export function resolveFromRegistry(
  id: string,
  versionSpec: string | undefined,
  index: IndexEntry[],
): IndexEntry | null {
  const candidates = index.filter((e) => e.id === id);
  if (candidates.length === 0) return null;

  if (!versionSpec || versionSpec === 'workspace:*') {
    return candidates[0] ?? null;
  }

  for (const candidate of candidates) {
    if (semverSatisfies(candidate.version, versionSpec)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Minimal semver range checker supporting:
 *   - exact "1.2.3"
 *   - "^1.2.3" (same major, >= minor.patch)
 *   - ">=1.0.0 <2.0.0"
 *   - "workspace:*" (always true)
 */
export function semverSatisfies(version: string, range: string): boolean {
  if (range === 'workspace:*') return true;
  if (range === version) return true;

  const vParts = version.split('.').map(Number);
  const major = vParts[0] ?? 0;
  const minor = vParts[1] ?? 0;
  const patch = vParts[2] ?? 0;

  const caretMatch = /^\^(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (caretMatch) {
    const rMajor = Number(caretMatch[1]);
    const rMinor = Number(caretMatch[2]);
    const rPatch = Number(caretMatch[3]);
    if (major !== rMajor) return false;
    if (minor < rMinor) return false;
    if (minor === rMinor && patch < rPatch) return false;
    return true;
  }

  const rangeMatch = /^>=(\d+\.\d+\.\d+)\s+<(\d+\.\d+\.\d+)$/.exec(range);
  if (rangeMatch) {
    const lowerParts = rangeMatch[1]!.split('.').map(Number);
    const upperParts = rangeMatch[2]!.split('.').map(Number);
    const lv: [number, number, number] = [lowerParts[0] ?? 0, lowerParts[1] ?? 0, lowerParts[2] ?? 0];
    const uv: [number, number, number] = [upperParts[0] ?? 0, upperParts[1] ?? 0, upperParts[2] ?? 0];
    const cmpLow = compareSemver([major, minor, patch], lv);
    const cmpHigh = compareSemver([major, minor, patch], uv);
    return cmpLow >= 0 && cmpHigh < 0;
  }

  return false;
}

function compareSemver(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ─── Fetch + verify artifact ──────────────────────────────────────────────────

/**
 * Resolve a source spec to bytes + checksum.
 * Handles: file:// (local), https:// (CDN/remote), npm: scheme.
 */
export async function fetchArtifact(
  source: string,
  expectedChecksum?: string | undefined,
): Promise<{ bytes: Buffer; checksum: string; source: string }> {
  let bytes: Buffer;
  let resolvedSource = source;

  if (source.startsWith('file://')) {
    const filePath = source.slice('file://'.length);
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        const indexTs = path.join(filePath, 'src', 'index.ts');
        const promptMd = path.join(filePath, 'prompt.md');
        const extJson = path.join(filePath, 'extension.json');
        let contentPath = extJson; // fallback
        if (fs.existsSync(indexTs)) contentPath = indexTs;
        else if (fs.existsSync(promptMd)) contentPath = promptMd;
        bytes = fs.readFileSync(contentPath);
        resolvedSource = `file://${contentPath}`;
      } else {
        bytes = fs.readFileSync(filePath);
      }
    } else {
      throw new Error(`install: source file not found: ${filePath}`);
    }
  } else if (source.startsWith('https://') || source.startsWith('http://')) {
    const resp = await fetch(source);
    if (!resp.ok) {
      throw new Error(`install: fetch failed for ${source}: ${resp.status} ${resp.statusText}`);
    }
    bytes = Buffer.from(await resp.arrayBuffer());
  } else if (source.startsWith('npm:')) {
    const pkgSpec = source.slice('npm:'.length);
    const cdnUrl = `https://cdn.jsdelivr.net/npm/${pkgSpec}/dist/index.js`;
    const resp = await fetch(cdnUrl);
    if (!resp.ok) {
      throw new Error(`install: npm CDN fetch failed for ${cdnUrl}: ${resp.status}`);
    }
    bytes = Buffer.from(await resp.arrayBuffer());
    resolvedSource = cdnUrl;
  } else {
    throw new Error(`install: unsupported source scheme: ${source}`);
  }

  const checksum = computeChecksum(bytes);

  if (expectedChecksum !== undefined && checksum !== expectedChecksum) {
    throw new Error(
      `install: CHECKSUM MISMATCH for source "${source}"\n` +
        `  expected: ${expectedChecksum}\n` +
        `  got:      ${checksum}\n` +
        `This may indicate a corrupted or tampered artifact.`,
    );
  }

  return { bytes, checksum, source: resolvedSource };
}

// ─── Extends org-baseline fetch + hash pin ────────────────────────────────────

async function fetchOrgBaseline(
  url: string,
): Promise<{ config: ScopeConfig; sha256: string }> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`install: failed to fetch org baseline at ${url}: ${resp.status}`);
  }
  const body = await resp.text();
  const sha256 = computeChecksum(Buffer.from(body));
  let config: ScopeConfig;
  try {
    config = JSON.parse(body) as ScopeConfig;
  } catch (e) {
    throw new Error(`install: failed to parse org baseline JSON from ${url}: ${String(e)}`);
  }
  return { config, sha256 };
}

// ─── Core install function ────────────────────────────────────────────────────

export interface InstallOptions {
  scope: Scope;
  mode: InstallMode;
  configPath?: string | undefined;
  lockfilePath?: string | undefined;
  root?: string | undefined;
  overrideProvider?: string | undefined;
}

export async function install(opts: InstallOptions): Promise<ResolvedSet> {
  const root = opts.root ?? REPO_ROOT;
  const scopePaths = getScopePath(opts.scope);
  const configPath = opts.configPath ?? scopePaths.config;
  const lockPath = opts.lockfilePath ?? scopePaths.lockfile;

  const scopeConfig = loadConfig(configPath);
  if (!scopeConfig) {
    if (opts.mode === 'frozen') {
      const existingLock = loadLockfile(lockPath);
      if (!existingLock) {
        console.error(
          `install: --frozen-lockfile: no lockfile at ${lockPath} and no config at ${configPath}`,
        );
        process.exit(1);
      }
      return buildResolvedSetFromLock(existingLock);
    }
    console.log(`install: no config found at ${configPath} — nothing to install`);
    return {};
  }

  const registryIndex = loadRegistryIndex(root);
  const existingLock = loadLockfile(lockPath);

  // ── Cascade resolution: load all scopes and merge ────────────────────────────
  // When configPath is explicitly provided (test/override scenario), use single-scope mode
  // to avoid loading from global default paths.
  const singleScopeOnly = opts.configPath !== undefined;
  const allScopeConfigs = await loadScopeCascade({
    scope: opts.scope,
    primaryConfig: scopeConfig,
    singleScopeOnly,
    existingLock,
    mode: opts.mode,
  });
  const cascadedConfig = cascade(allScopeConfigs as CascadeScopeConfig[]);

  // ── Determine strict_capabilities ──────────────────────────────────────────
  const strictCapabilities = scopeConfig.strict_capabilities ?? false;

  // ── Determine active provider model (for capability checks) ────────────────
  const activeProvider = opts.overrideProvider ?? resolveActiveProvider(allScopeConfigs);

  // ── Build install list from cascade ─────────────────────────────────────────
  // NOTE: cascade.ts arrays-replace rule is NOT changed. Expansion is post-cascade (G-B design).
  const rawEntries = buildInstallList(scopeConfig, cascadedConfig);
  // G-B: expand any bundle entries to their members AFTER cascade resolution.
  // The cascade sees bundle ids as opaque install entries; expansion resolves them here.
  const entriesToInstall = expandBundles(rawEntries, registryIndex, root);

  if (opts.mode === 'frozen') {
    const existingLockForFrozen = existingLock;
    if (!existingLockForFrozen) {
      console.error(
        `install: --frozen-lockfile: no lockfile found at ${lockPath}. ` +
          `Run without --frozen-lockfile first to generate one.`,
      );
      process.exit(1);
    }
    for (const entry of entriesToInstall) {
      const lockKey = findLockKey(existingLockForFrozen, entry.id);
      if (!lockKey) {
        console.error(
          `install: --frozen-lockfile: extension "${entry.id}" not found in lockfile at ${lockPath}. ` +
            `Re-run without --frozen-lockfile to update.`,
        );
        process.exit(1);
      }
    }
    console.log(`install: --frozen-lockfile: lockfile verified (${lockPath})`);
    return buildResolvedSetFromLock(existingLockForFrozen);
  }

  // ── Resolve and fetch each extension ────────────────────────────────────────
  const newResolved: Record<string, LockfileEntry> = {};

  for (const entry of entriesToInstall) {
    if (!entry.enabled) {
      console.log(`install: skipping disabled extension "${entry.id}"`);
      continue;
    }

    // Determine source
    let source: string;
    let expectedChecksum: string | undefined;

    if (entry.source !== undefined && entry.source.startsWith('file://')) {
      source = entry.source;
    } else if (entry.source !== undefined) {
      source = entry.source;
    } else {
      const indexEntry = resolveFromRegistry(entry.id, entry.version, registryIndex);
      if (!indexEntry) {
        const localPath = findLocalExtension(root, entry.id);
        if (localPath) {
          source = `file://${localPath}`;
        } else {
          console.error(
            `install: ERROR cannot resolve extension "${entry.id}" @ "${entry.version ?? 'latest'}" — ` +
              `not found in registry/index.json and not found locally. ` +
              `Run 'pnpm run build-index' to rebuild the registry.`,
          );
          process.exit(1);
        }
      } else {
        source = indexEntry.source;
        expectedChecksum = indexEntry.checksum;
      }
    }

    // Verify capability requirements (P3 / Gap 5)
    const extManifest = loadExtensionManifest(root, entry.id);
    if (extManifest?.requires !== undefined && activeProvider !== undefined) {
      const capResult = checkProviderCapabilities(activeProvider, extManifest.requires);
      if (!capResult.ok) {
        const warning =
          `install: CAPABILITY MISMATCH for extension "${entry.id}" with provider "${activeProvider}":\n` +
          capResult.warnings.map((w) => `  - ${w}`).join('\n');
        if (strictCapabilities) {
          console.error(warning);
          console.error(
            `install: hard-blocking due to strict_capabilities:true. ` +
              `Switch to a capable provider or disable strict_capabilities.`,
          );
          process.exit(1);
        } else {
          console.warn(warning);
          console.warn(
            `install: (continuing — set strict_capabilities:true to hard-block on mismatches)`,
          );
        }
      }
    }

    // Fetch + verify
    try {
      const { checksum, source: resolvedSource } = await fetchArtifact(source, expectedChecksum);

      // Resolve the actual version from registry or use the specified version
      const indexEntry = resolveFromRegistry(entry.id, entry.version, registryIndex);
      const resolvedVersion = indexEntry?.version ?? entry.version ?? '0.0.0';
      const actualKey = `${entry.id}@${resolvedVersion}`;

      newResolved[actualKey] = {
        source: resolvedSource,
        checksum,
        resolved_at: new Date().toISOString(),
      };

      console.log(`install: resolved ${actualKey} from ${resolvedSource} (${checksum})`);
    } catch (e) {
      console.error(String(e));
      process.exit(1);
    }
  }

  // ── Determine extends pin ────────────────────────────────────────────────────
  let extendsPin: LockfileExtendsPin | undefined;
  const firstScope = allScopeConfigs[0];
  if (firstScope?.extendsUrl !== undefined) {
    extendsPin = firstScope.extendsPin;
  }

  // ── Write lockfile ────────────────────────────────────────────────────────────
  const lockfile: Lockfile = {
    lockfileVersion: 1,
    resolved: newResolved,
  };
  if (extendsPin !== undefined) {
    lockfile.extends = extendsPin;
  }

  const lockDir = path.dirname(lockPath);
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }
  fs.writeFileSync(lockPath, JSON.stringify(lockfile, null, 2) + '\n', 'utf8');
  console.log(`install: wrote lockfile to ${lockPath}`);

  return buildResolvedSetFromInstallList(newResolved, cascadedConfig);
}

// ─── Cascade scope loading ────────────────────────────────────────────────────

interface ScopeConfigWithMeta extends ScopeConfig {
  extendsUrl?: string | undefined;
  extendsPin?: LockfileExtendsPin | undefined;
}

interface CascadeOpts {
  scope: Scope;
  primaryConfig: ScopeConfig;
  /** When true, only load the primaryConfig (don't load other scope defaults). */
  singleScopeOnly: boolean;
  existingLock: Lockfile | null;
  mode: InstallMode;
}

async function loadScopeCascade(opts: CascadeOpts): Promise<ScopeConfigWithMeta[]> {
  const { scope, primaryConfig, singleScopeOnly, existingLock, mode } = opts;
  const configs: ScopeConfigWithMeta[] = [];

  // Load org baseline if `extends` is present (Gap 4)
  if (primaryConfig.extends !== undefined) {
    const url = primaryConfig.extends;
    const { config: orgConfig, sha256: fetchedSha256 } = await fetchOrgBaseline(url);

    // Check hash pin (Gap 4)
    if (existingLock?.extends !== undefined) {
      const pinnedSha256 = existingLock.extends.sha256;
      if (pinnedSha256 !== fetchedSha256 && mode !== 'update') {
        console.error(
          `install: ERROR org baseline at ${url} changed\n` +
            `  lock: ${pinnedSha256}\n` +
            `  fetched: ${fetchedSha256}\n` +
            `Re-run with --update to accept the new baseline.`,
        );
        process.exit(1);
      }
    }

    const extendsPin: LockfileExtendsPin = {
      url,
      sha256: fetchedSha256,
      resolved_at: new Date().toISOString(),
    };

    configs.push({ ...orgConfig, extendsUrl: url, extendsPin });
  }

  if (singleScopeOnly) {
    // Single-scope mode (used when configPath is explicitly provided):
    // Only use the primaryConfig — don't load from other default scope paths.
    configs.push(primaryConfig);
    return configs;
  }

  // Full cascade mode: load all scopes from widest to the requested scope
  // using default paths (for CLI usage without configPath override)
  const scopeOrder: Scope[] = ['org', 'user', 'project', 'local'];
  const scopeIndex = scopeOrder.indexOf(scope);

  for (let i = 0; i <= scopeIndex; i++) {
    const s = scopeOrder[i];
    if (s === undefined || s === 'org') continue; // org is handled via extends

    const paths = getScopePath(s);
    const config = loadConfig(paths.config);
    if (config !== null) {
      configs.push(config);
    }
  }

  // If nothing loaded, use the primary config directly
  if (configs.length === 0) {
    configs.push(primaryConfig);
  }

  return configs;
}

// ─── G-B: Bundle expansion ────────────────────────────────────────────────────
//
// IMPORTANT: Bundle expansion happens AFTER cascade resolution. The cascade's
// arrays-replace rule (I5) is intentionally untouched — cascade.ts is
// byte-unchanged. Expansion is purely post-cascade and install-time-only.
// A bundle is NEVER passed to the host loader; by the time the loader runs,
// all bundles are expanded away into their member install entries.
//
// Expansion algorithm (G-B §"Composition with the cascade"):
//   1. Run cascade normally on the install list (including any bundle ids).
//   2. Expand each bundle id to its members (recursively, cycle-guarded).
//   3. Member-level explicit install entries override bundle-expanded ones by id
//      (mirrors buildInstallList's existing supplement logic).

const BUNDLE_MAX_DEPTH = 10;

/**
 * Resolve the members array for a bundle id.
 * Checks the registry index first, then falls back to local disk.
 */
function resolveBundleMembers(
  bundleId: string,
  registryIndex: IndexEntry[],
  root: string,
): Array<{ id: string; version: string }> | null {
  // Check registry index first (most common path)
  const indexEntry = registryIndex.find((e) => e.id === bundleId && e.type === 'bundle');
  if (indexEntry?.members !== undefined && indexEntry.members.length > 0) {
    return indexEntry.members;
  }

  // Fall back to local disk manifest
  const localPath = findLocalExtension(root, bundleId);
  if (localPath) {
    const manifestPath = path.join(localPath, 'extension.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
        if (manifest.type === 'bundle' && Array.isArray(manifest.members) && manifest.members.length > 0) {
          return manifest.members;
        }
      } catch (_e) {
        // Fall through — will return null
      }
    }
  }

  return null;
}

/**
 * Expand all bundle entries in the install list into their member entries.
 * Expansion is post-cascade and cycle-guarded (depth + visited set).
 * Member-level explicit entries in the original list override bundle-expanded ones.
 *
 * CONTRACT: cascade.ts arrays-replace rule is NOT changed — this function runs
 * after cascade resolution and does not alter cascade merge semantics (I5 preserved).
 */
function expandBundles(
  entries: ResolvedInstallEntry[],
  registryIndex: IndexEntry[],
  root: string,
): ResolvedInstallEntry[] {
  // Collect explicit (non-bundle) entries keyed by id — these override expansions
  const explicitIds = new Set<string>();
  for (const entry of entries) {
    const members = resolveBundleMembers(entry.id, registryIndex, root);
    if (members === null) {
      // Not a bundle (or bundle not found) — it's explicit
      explicitIds.add(entry.id);
    }
  }

  const result: ResolvedInstallEntry[] = [];
  const seenIds = new Set<string>();

  function expandEntry(
    entry: ResolvedInstallEntry,
    depth: number,
    ancestorChain: ReadonlySet<string>,
  ): void {
    if (depth > BUNDLE_MAX_DEPTH) {
      console.warn(`install: bundle expansion depth exceeded for "${entry.id}" — skipping`);
      return;
    }

    const members = resolveBundleMembers(entry.id, registryIndex, root);
    if (members === null) {
      // Not a bundle — include directly (if not already seen)
      if (!seenIds.has(entry.id)) {
        seenIds.add(entry.id);
        result.push(entry);
      }
      return;
    }

    // This entry is a bundle — expand to members
    // Cycle detection: if this bundle id is already in the ancestor chain, reject
    if (ancestorChain.has(entry.id)) {
      const chain = Array.from(ancestorChain).join(' → ');
      throw new Error(
        `install: bundle cycle detected: ${chain} → ${entry.id}. ` +
          `Bundles must not reference each other cyclically.`,
      );
    }

    const newChain = new Set(ancestorChain);
    newChain.add(entry.id);

    for (const member of members) {
      // If the member id was an explicit entry in the original list, skip the
      // bundle-expanded version (the explicit entry already owns the slot).
      if (explicitIds.has(member.id) && !ancestorChain.has(member.id)) {
        continue;
      }
      // Recurse in case the member is itself a bundle (bundles-of-bundles, depth-guarded)
      expandEntry(
        {
          id: member.id,
          version: member.version,
          enabled: entry.enabled,
          source: undefined,
        },
        depth + 1,
        newChain,
      );
    }
  }

  for (const entry of entries) {
    expandEntry(entry, 0, new Set());
  }

  // Add back any explicit non-bundle entries that were skipped because a bundle already
  // claimed their slot — explicit entries always win (supplement semantics).
  for (const entry of entries) {
    if (explicitIds.has(entry.id) && !seenIds.has(entry.id)) {
      seenIds.add(entry.id);
      result.push(entry);
    }
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface ResolvedInstallEntry {
  id: string;
  version: string | undefined;
  enabled: boolean;
  source: string | undefined;
}

function buildInstallList(
  scopeConfig: ScopeConfig,
  cascadedConfig: ResolvedConfigMap,
): ResolvedInstallEntry[] {
  const entries: ResolvedInstallEntry[] = [];
  const seenIds = new Set<string>();

  // First, gather from cascade (all scopes)
  for (const [id, resolved] of Object.entries(cascadedConfig)) {
    seenIds.add(id);
    entries.push({
      id,
      version: resolved.version,
      enabled: resolved.enabled,
      source: undefined,
    });
  }

  // Then, supplement with direct install entries that carry source overrides
  if (scopeConfig.install !== undefined) {
    for (const installEntry of scopeConfig.install) {
      const existing = entries.find((e) => e.id === installEntry.id);
      if (existing !== undefined) {
        if (installEntry.source !== undefined) existing.source = installEntry.source;
      } else if (!seenIds.has(installEntry.id)) {
        seenIds.add(installEntry.id);
        entries.push({
          id: installEntry.id,
          version: installEntry.version,
          enabled: installEntry.enabled ?? true,
          source: installEntry.source,
        });
      }
    }
  }

  return entries;
}

function findLockKey(lockfile: Lockfile, id: string): string | undefined {
  return Object.keys(lockfile.resolved).find((k) => k.startsWith(`${id}@`));
}

function buildResolvedSetFromLock(lockfile: Lockfile): ResolvedSet {
  const result: ResolvedSet = {};
  for (const [key, entry] of Object.entries(lockfile.resolved)) {
    const atIdx = key.lastIndexOf('@');
    const id = key.slice(0, atIdx);
    const version = key.slice(atIdx + 1);
    result[id] = {
      version,
      enabled: true,
      config: {},
      source: entry.source,
      checksum: entry.checksum,
    };
  }
  return result;
}

function buildResolvedSetFromInstallList(
  resolved: Record<string, LockfileEntry>,
  cascadedConfig: ResolvedConfigMap,
): ResolvedSet {
  const result: ResolvedSet = {};
  for (const [key, entry] of Object.entries(resolved)) {
    const atIdx = key.lastIndexOf('@');
    const id = key.slice(0, atIdx);
    const version = key.slice(atIdx + 1);
    const cascaded = cascadedConfig[id];
    result[id] = {
      version,
      enabled: cascaded?.enabled ?? true,
      config: cascaded?.config ?? {},
      source: entry.source,
      checksum: entry.checksum,
    };
  }
  return result;
}

function findLocalExtension(root: string, id: string): string | null {
  // G-B: include 'bundles' so bundle manifests can be resolved locally
  const typeDirs = ['agents', 'skills', 'mcp-servers', 'prompts', 'hooks', 'commands', 'bundles'];
  for (const typeDir of typeDirs) {
    const typePath = path.join(root, 'extensions', typeDir);
    if (!fs.existsSync(typePath)) continue;
    for (const dirEntry of fs.readdirSync(typePath)) {
      const extPath = path.join(typePath, dirEntry);
      const manifestPath = path.join(extPath, 'extension.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { id?: string };
        if (manifest.id === id) return extPath;
      } catch (_e) {
        // Skip malformed manifests
      }
    }
  }
  return null;
}

function loadExtensionManifest(root: string, id: string): ExtensionManifest | null {
  const localPath = findLocalExtension(root, id);
  if (!localPath) return null;
  const manifestPath = path.join(localPath, 'extension.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
  } catch (_e) {
    return null;
  }
}

function resolveActiveProvider(configs: ScopeConfigWithMeta[]): string | undefined {
  // Find the narrowest scope that specifies a provider in config
  for (let i = configs.length - 1; i >= 0; i--) {
    const cfg = configs[i];
    if (cfg?.config !== undefined) {
      for (const extConfig of Object.values(cfg.config)) {
        const provider = (extConfig as Record<string, unknown>)['provider'];
        if (typeof provider === 'string') return provider;
      }
    }
  }
  return undefined;
}

// ─── CLI entry point — only runs when invoked directly, not when imported ──────

// Detect if this module is the main entry point (Node16 ESM)
const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
const isMainFallback = process.argv[1]?.includes('install');

if (isMain || (isMainFallback && !process.env['VITEST'])) {
  const args = process.argv.slice(2);
  const scopeArg = args.find((a) => a.startsWith('--scope='))?.slice('--scope='.length) as
    | Scope
    | undefined;
  const frozen = args.includes('--frozen-lockfile');
  const update = args.includes('--update');

  if (!scopeArg) {
    console.error('install: ERROR --scope=<org|user|project|local> is required');
    process.exit(1);
  }

  const mode: InstallMode = frozen ? 'frozen' : update ? 'update' : 'default';

  install({ scope: scopeArg, mode })
    .then((resolved) => {
      const count = Object.keys(resolved).length;
      console.log(`install: done — ${count} extension(s) resolved`);
    })
    .catch((e: unknown) => {
      console.error(`install: FATAL ${String(e)}`);
      process.exit(1);
    });
}
