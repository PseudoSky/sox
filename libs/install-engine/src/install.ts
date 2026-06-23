/**
 * libs/install-engine/src/install.ts — Install client (lib version)
 *
 * Ported from scripts/install.ts. Imports adapted for lib-relative paths.
 * No CLI entry point here — that lives in apps/sox.
 * [def:session-fixes] registry drift gate carried forward (unchanged from scripts/).
 *
 * [inv:fix-carry-forward]: NEVER re-grab code from before pre-nx-baseline tag.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ScopeConfig as CascadeScopeConfig, ResolvedConfigMap } from './cascade.js';
import { cascade } from './cascade.js';
import { upsertInstallRecord } from './install-registry.js';
import { scopeConfigPaths } from './data-paths.js';
import { checkProviderCapabilities } from './provider-capabilities.js';
// verify-integrity imports from this module (install.ts); the cycle is safe
// because verifyIntegrity is only invoked at runtime, never at module-eval time.
import { verifyIntegrity } from './verify-integrity.js';

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
  bundle_id?: string | undefined;
}

export interface LockfileExtendsPin {
  url: string;
  sha256: string;
  resolved_at: string;
}

export interface Lockfile {
  /**
   * Lockfile FORMAT version (not an extension version).
   *   1 — legacy: keys are `id@version`.
   *   2 — ADR-0003: keys are the bare `id`; integrity is the entrypoint checksum.
   * `loadLockfile` reads both; `install` always writes 2 (migrating v1 on next install).
   */
  lockfileVersion: 1 | 2;
  extends?: LockfileExtendsPin | undefined;
  resolved: Record<string, LockfileEntry>;
}

/** Current lockfile format version written by `install`. */
export const LOCKFILE_VERSION = 2 as const;

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
  /** ADR-0003: derived display-only label (from package.json); never an identity input. */
  version?: string | undefined;
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
  members?: Array<{ id: string }> | undefined;
  /** R9: "public" (default if absent) or "internal" (bundle member, not independently installable). */
  visibility?: 'public' | 'internal' | undefined;
  /** R9: populated when visibility is "internal". The owning bundle's id. */
  bundleId?: string | undefined;
}

export interface ExtensionManifest {
  id: string;
  /** ADR-0003: removed as an authored field; optional/deprecated for back-compat reads. */
  version?: string | undefined;
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
  members?: Array<{ id: string }> | undefined;
  /**
   * JSON Schema (draft-07 subset) for install-time configuration.
   * Sox recognises two non-standard extension properties:
   *   x-sox-prompt  — prompt text shown during interactive install
   *   x-sox-default — value used when user enters nothing
   */
  config_schema?: {
    type?: string;
    additionalProperties?: boolean;
    required?: string[];
    properties?: Record<string, {
      type?: string;
      description?: string;
      'x-sox-prompt'?: string;
      'x-sox-default'?: unknown;
    }>;
  } | undefined;
}

// ─── Scope path resolution ────────────────────────────────────────────────────

// REPO_ROOT is resolved at import time from this file's location in the built dist/
// libs/install-engine/dist/install.js → three levels up = repo root
// Use __dirname (CJS, provided by tsconfig module=CommonJS)
declare const __dirname: string;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export function getScopePath(scope: Scope): { config: string; lockfile: string } {
  // ADR-0004 §D2: single resolver — all scopes under `.adhd/sox-ecosystem/`.
  // project/org/local root = REPO_ROOT (this CLI's workspace); user = data root.
  return scopeConfigPaths(scope, REPO_ROOT);
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
    const parsed = JSON.parse(raw) as Lockfile;
    return normalizeLockfile(parsed);
  } catch (_e) {
    return null;
  }
}

/**
 * ADR-0003 back-compat reader. A legacy v1 lockfile keys entries by `id@version`.
 * Normalize to the v2 shape — keys become the bare `id` — so every consumer
 * (frozen verification, findLockKey, buildResolvedSet) is uniform regardless of
 * the on-disk format. The on-disk file is NOT rewritten here; the next `install`
 * writes v2 with bare keys. If a (corrupt) v1 file carries two `id@vA`/`id@vB`
 * keys for one id, the first wins — the checksum gate will catch any real drift.
 */
export function normalizeLockfile(lock: Lockfile): Lockfile {
  // v2 (or already-bare keys): nothing to do.
  if (lock.lockfileVersion >= 2) return lock;

  const normalized: Record<string, LockfileEntry> = {};
  for (const [key, entry] of Object.entries(lock.resolved)) {
    const atIdx = key.indexOf('@');
    const bareId = atIdx === -1 ? key : key.slice(0, atIdx);
    if (!(bareId in normalized)) {
      normalized[bareId] = entry;
    }
  }
  return { ...lock, resolved: normalized };
}

// ─── Env-var resolution ───────────────────────────────────────────────────────

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
 * ADR-0003: resolution is a pure `id` lookup over the single registry build.
 * Per-extension semver is retired — there is exactly one build per id (the
 * invariant the registry already holds), so version-range matching is dead code
 * and `semverSatisfies`/`compareSemver` are deleted. A future multi-build-per-id
 * registry is an explicit, separately-decided change, not a latent capability we
 * keep dead code for. `compatibility.host` (a different axis) is untouched.
 */
export function resolveFromRegistry(
  id: string,
  index: IndexEntry[],
): IndexEntry | null {
  const candidates = index.filter((e) => e.id === id);
  return candidates[0] ?? null;
}

// ─── Fetch + verify artifact ──────────────────────────────────────────────────

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
        const extJson = path.join(filePath, 'extension.json');
        let contentPath = extJson;

        // C4 / lockfile artifact fix: pin the declared entrypoint (the built artifact),
        // not the TypeScript source. This handles Vite-style builds where the checksum
        // target is the compiled JS entrypoint, not the TS source.
        //
        // Resolution order:
        //  1. manifest.entrypoint (explicit declaration — e.g. dist/index.js, SKILL.md)
        //  2. dist/index.js (built artifact fallback for code types)
        //  3. prompt.md (declarative prompt types)
        //  4. extension.json (final fallback for bundles / bare manifests)
        if (fs.existsSync(extJson)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(extJson, 'utf8')) as { entrypoint?: string };
            if (typeof manifest.entrypoint === 'string' && manifest.entrypoint.trim() !== '') {
              const declared = path.join(filePath, manifest.entrypoint);
              if (fs.existsSync(declared)) contentPath = declared;
            }
          } catch { /* unparseable extension.json — fall through */ }
        }

        if (contentPath === extJson) {
          // No entrypoint declared or file missing — use fallback chain.
          const distJs = path.join(filePath, 'dist', 'index.js');
          const promptMd = path.join(filePath, 'prompt.md');
          if (fs.existsSync(distJs)) contentPath = distJs;
          else if (fs.existsSync(promptMd)) contentPath = promptMd;
          // else stays as extension.json
        }

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
  /**
   * Called for each required config key that has no cascade-resolved value.
   * The CLI layer provides a readline implementation in interactive mode.
   * Return the string value to persist, or undefined to skip (with a warning).
   *
   * @param extId    Extension id
   * @param key      Config key that is required but unset
   * @param prompt   x-sox-prompt text from the config_schema property (or a generated default)
   * @param defaultVal  x-sox-default from the schema (or undefined)
   */
  onMissingConfig?: (
    extId: string,
    key: string,
    prompt: string,
    defaultVal: unknown,
  ) => Promise<string | undefined>;
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

  const singleScopeOnly = opts.configPath !== undefined;
  const allScopeConfigs = await loadScopeCascade({
    scope: opts.scope,
    primaryConfig: scopeConfig,
    singleScopeOnly,
    existingLock,
    mode: opts.mode,
  });
  const cascadedConfig = cascade(allScopeConfigs as CascadeScopeConfig[]);

  const strictCapabilities = scopeConfig.strict_capabilities ?? false;
  const activeProvider = opts.overrideProvider ?? resolveActiveProvider(allScopeConfigs);

  const rawEntries = buildInstallList(scopeConfig, cascadedConfig);
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

      // ADR-0003 B1: --frozen-lockfile verifies the CHECKSUM, not merely key
      // presence. This INHERITS the `verifyIntegrity` primitive (the sole
      // is-this-current check) rather than reimplementing the comparison — so
      // frozen-verify, `update`, and `upgrade --all` share one code path and
      // the scope-parity suite tests one primitive. There is no version
      // comparison; the content address IS the identity.
      const lockEntryFrozen = existingLockForFrozen.resolved[lockKey];
      if (lockEntryFrozen === undefined) {
        console.error(
          `install: --frozen-lockfile: lockfile entry for "${entry.id}" is missing at ${lockPath}.`,
        );
        process.exit(1);
      }
      const verdict = await verifyIntegrity(opts.scope, entry.id, { lockfilePath: lockPath });
      if (verdict.status === 'unresolvable') {
        console.error(
          `install: --frozen-lockfile: could not verify checksum for "${entry.id}": ${verdict.error ?? 'unresolvable'}`,
        );
        process.exit(1);
      }
      if (verdict.status === 'stale') {
        console.error(
          `install: --frozen-lockfile: CHECKSUM MISMATCH (drift) for "${entry.id}" at ${lockPath}\n` +
          `  source:   ${verdict.source ?? lockEntryFrozen.source}\n` +
          `  expected: ${verdict.expected ?? lockEntryFrozen.checksum}\n` +
          `  got:      ${verdict.actual ?? '(unknown)'}\n` +
          `The installed artifact has changed. Re-run without --frozen-lockfile to re-pin.`,
        );
        process.exit(1);
      }
    }
    console.log(`install: --frozen-lockfile: lockfile verified (checksum) (${lockPath})`);
    return buildResolvedSetFromLock(existingLockForFrozen);
  }

  const newResolved: Record<string, LockfileEntry> = {};

  for (const entry of entriesToInstall) {
    if (!entry.enabled) {
      console.log(`install: skipping disabled extension "${entry.id}"`);
      continue;
    }

    // R9: visibility guard has moved to the CLI layer (cmdInstall in apps/sox/src/main.ts).
    // Entries explicitly listed in the scope config are allowed through here — that
    // covers both user-curated configs and the e2e test that lists members directly.
    // The CLI blocks bare `sox install <member>` positionals before they reach install().

    let source: string;
    let expectedChecksum: string | undefined;

    if (entry.source !== undefined && entry.source.startsWith('file://')) {
      source = entry.source;
    } else if (entry.source !== undefined) {
      source = entry.source;
    } else {
      const indexEntry = resolveFromRegistry(entry.id, registryIndex);
      if (!indexEntry) {
        const localPath = findLocalExtension(root, entry.id);
        if (localPath) {
          source = `file://${localPath}`;
        } else {
          // BL-19 resilience: skip + warn on an unresolvable entry instead of aborting the
          // whole install. One bad config line must not block every valid entry.
          console.warn(
            `install: WARNING skipping "${entry.id}" — ` +
            `not found in registry/index.json and not found locally. ` +
            `Run 'pnpm run build-index' to rebuild the registry, or remove this entry from the config.`,
          );
          continue;
        }
      } else {
        source = indexEntry.source;
        expectedChecksum = indexEntry.checksum;
      }
    }

    const extManifest = loadExtensionManifest(root, entry.id);

    // ── Install-time config capture ─────────────────────────────────────────
    // If the extension declares a config_schema with required keys, check the
    // cascade-resolved config and prompt (or warn) for missing values.
    if (extManifest?.config_schema) {
      const schema = extManifest.config_schema;
      const requiredKeys: string[] = schema.required ?? [];
      const properties = schema.properties ?? {};
      // Get the cascade-resolved config for this extension
      const cascadedEntryConfig: Record<string, unknown> = cascadedConfig[entry.id]?.config ?? {};
      const configPath5 = opts.configPath ?? scopePaths.config;

      for (const reqKey of requiredKeys) {
        if (reqKey in cascadedEntryConfig) continue; // already set in some scope

        const propDef = properties[reqKey] ?? {};
        const promptText = propDef['x-sox-prompt'] ?? `Enter value for ${entry.id}.${reqKey}:`;
        const defaultVal = propDef['x-sox-default'];

        if (opts.onMissingConfig) {
          // CLI layer handles the interactive prompt
          const captured = await opts.onMissingConfig(entry.id, reqKey, promptText as string, defaultVal);
          if (captured !== undefined) {
            // Persist to the scope config file
            const existing = loadConfig(configPath5) as Record<string, unknown> ?? {};
            const cfgBlock = (existing['config'] as Record<string, Record<string, unknown>> | undefined) ?? {};
            const extBlock = cfgBlock[entry.id] ?? {};
            extBlock[reqKey] = captured;
            cfgBlock[entry.id] = extBlock;
            existing['config'] = cfgBlock;
            const configDir = path.dirname(configPath5);
            if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(configPath5, JSON.stringify(existing, null, 2) + '\n', 'utf8');
            console.log(`install: config: set ${entry.id}.${reqKey} (scope: ${opts.scope})`);
          } else {
            console.warn(
              `install: warning: required config key '${reqKey}' for '${entry.id}' was not set. ` +
              `Run: sox config set ${entry.id} ${reqKey} <value>`,
            );
          }
        } else {
          // Non-interactive: warn
          console.warn(
            `install: warning: required config key '${reqKey}' for '${entry.id}' is not set in any scope.\n` +
            `  Run: sox config set ${entry.id} ${reqKey} <value>`,
          );
        }
      }
    }

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

    try {
      const { checksum, source: resolvedSource } = await fetchArtifact(source, expectedChecksum);

      // ADR-0003: the lockfile key is the BARE id. The checksum is the integrity
      // authority; there is no `@version` decoration. One id ⇒ one artifact.
      const indexEntry = resolveFromRegistry(entry.id, registryIndex);
      const lockKey = entry.id;

      const lockEntry: LockfileEntry = {
        source: resolvedSource,
        checksum,
        resolved_at: new Date().toISOString(),
      };
      if (entry.bundleId !== undefined) {
        lockEntry.bundle_id = entry.bundleId;
      }
      newResolved[lockKey] = lockEntry;

      console.log(`install: resolved ${lockKey} from ${resolvedSource} (${checksum})`);

      // P9: upsert into global install ledger (~/.sox/install-registry.json).
      // Best-effort: a failed write must never fail the install. The ledger's
      // `version` is mechanical release-bookkeeping ONLY (ADR-0003 Decision 6) —
      // a derived display label, never an identity/integrity input. Derived from
      // the registry's optional display version; empty when none is published.
      try {
        upsertInstallRecord({
          extId: entry.id,
          version: indexEntry?.version ?? '',
          scope: opts.scope as 'user' | 'project' | 'local',
          root,
          source: resolvedSource,
        });
      } catch (regErr) {
        console.warn(`install: warning: could not update install registry: ${String(regErr)}`);
      }
    } catch (e) {
      console.error(String(e));
      process.exit(1);
    }
  }

  let extendsPin: LockfileExtendsPin | undefined;
  const firstScope = allScopeConfigs[0];
  if (firstScope?.extendsUrl !== undefined) {
    extendsPin = firstScope.extendsPin;
  }

  const lockfile: Lockfile = {
    lockfileVersion: LOCKFILE_VERSION,
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
  singleScopeOnly: boolean;
  existingLock: Lockfile | null;
  mode: InstallMode;
}

async function loadScopeCascade(opts: CascadeOpts): Promise<ScopeConfigWithMeta[]> {
  const { scope, primaryConfig, singleScopeOnly, existingLock, mode } = opts;
  const configs: ScopeConfigWithMeta[] = [];

  if (primaryConfig.extends !== undefined) {
    const url = primaryConfig.extends;
    const { config: orgConfig, sha256: fetchedSha256 } = await fetchOrgBaseline(url);

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
    configs.push(primaryConfig);
    return configs;
  }

  const scopeOrder: Scope[] = ['org', 'user', 'project', 'local'];
  const scopeIndex = scopeOrder.indexOf(scope);

  for (let i = 0; i <= scopeIndex; i++) {
    const s = scopeOrder[i];
    if (s === undefined || s === 'org') continue;

    const paths = getScopePath(s);
    const config = loadConfig(paths.config);
    if (config !== null) {
      configs.push(config);
    }
  }

  if (configs.length === 0) {
    configs.push(primaryConfig);
  }

  return configs;
}

// ─── G-B: Bundle expansion ────────────────────────────────────────────────────

const BUNDLE_MAX_DEPTH = 10;

function resolveBundleMembers(
  bundleId: string,
  registryIndex: IndexEntry[],
  root: string,
): Array<{ id: string }> | null {
  const indexEntry = registryIndex.find((e) => e.id === bundleId && e.type === 'bundle');
  if (indexEntry?.members !== undefined && indexEntry.members.length > 0) {
    return indexEntry.members;
  }

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
        // fall through
      }
    }
  }

  return null;
}

interface ResolvedInstallEntry {
  id: string;
  version: string | undefined;
  enabled: boolean;
  source: string | undefined;
  bundleId?: string | undefined;
}

function expandBundles(
  entries: ResolvedInstallEntry[],
  registryIndex: IndexEntry[],
  root: string,
): ResolvedInstallEntry[] {
  const explicitIds = new Set<string>();
  for (const entry of entries) {
    const members = resolveBundleMembers(entry.id, registryIndex, root);
    if (members === null) {
      explicitIds.add(entry.id);
    }
  }

  const result: ResolvedInstallEntry[] = [];
  const seenIds = new Set<string>();

  function expandEntry(
    entry: ResolvedInstallEntry,
    depth: number,
    ancestorChain: ReadonlySet<string>,
    _currentBundleId: string | undefined,
  ): void {
    if (depth > BUNDLE_MAX_DEPTH) {
      console.warn(`install: bundle expansion depth exceeded for "${entry.id}" — skipping`);
      return;
    }

    const members = resolveBundleMembers(entry.id, registryIndex, root);
    if (members === null) {
      if (!seenIds.has(entry.id)) {
        seenIds.add(entry.id);
        result.push(entry);
      }
      return;
    }

    if (ancestorChain.has(entry.id)) {
      const chain = Array.from(ancestorChain).join(' → ');
      throw new Error(
        `install: bundle cycle detected: ${chain} → ${entry.id}. ` +
        `Bundles must not reference each other cyclically.`,
      );
    }

    const newChain = new Set(ancestorChain);
    newChain.add(entry.id);
    const thisBundleId = entry.id;

    for (const member of members) {
      if (explicitIds.has(member.id) && !ancestorChain.has(member.id)) {
        continue;
      }

      // ADR-0003: members are referenced by id only. With one build per id there is
      // exactly one artifact to resolve, and the checksum gate catches any mismatch.
      // The old "bundle version conflict" warning path is deleted — there is no
      // per-member version to disagree about. De-dup on id is structural.
      if (seenIds.has(member.id)) {
        continue;
      }

      expandEntry(
        {
          id: member.id,
          version: undefined,
          enabled: entry.enabled,
          source: undefined,
          bundleId: thisBundleId,
        },
        depth + 1,
        newChain,
        thisBundleId,
      );
    }
  }

  for (const entry of entries) {
    expandEntry(entry, 0, new Set(), undefined);
  }

  for (const entry of entries) {
    if (explicitIds.has(entry.id) && !seenIds.has(entry.id)) {
      seenIds.add(entry.id);
      result.push(entry);
    }
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * copyDirSync — recursively copy src directory into dest.
 * dest is created if absent. Existing files are overwritten.
 * [dod.5]: used to materialize the extension bundle into the service store dir.
 */
function copyDirSync(src: string, dest: string): void {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcChild = path.join(src, entry.name);
    const destChild = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcChild, destChild);
    } else {
      fs.copyFileSync(srcChild, destChild);
    }
  }
}

function buildInstallList(
  scopeConfig: ScopeConfig,
  cascadedConfig: ResolvedConfigMap,
): ResolvedInstallEntry[] {
  const entries: ResolvedInstallEntry[] = [];
  const seenIds = new Set<string>();

  for (const [id, resolved] of Object.entries(cascadedConfig)) {
    // Skip config-only entries: they provide configuration for extensions installed
    // transitively (e.g. bundle members) but carry no install: directive in any scope.
    // Including them here would treat them as explicit installs and interfere with
    // bundle-member visibility enforcement (R9 / P8).
    if (resolved.configOnly) {
      continue;
    }
    seenIds.add(id);
    entries.push({
      id,
      version: resolved.version,
      enabled: resolved.enabled,
      source: undefined,
    });
  }

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

/**
 * Resolve the lockfile key for an id. `loadLockfile` normalizes to bare-`id`
 * keys (ADR-0003 v2), so an exact match is the common case; the `id@…` prefix
 * fallback handles a raw v1 lockfile passed without normalization (defensive).
 */
function findLockKey(lockfile: Lockfile, id: string): string | undefined {
  if (id in lockfile.resolved) return id;
  return Object.keys(lockfile.resolved).find((k) => k.startsWith(`${id}@`));
}

/** Split a (possibly legacy) lockfile key into id + optional display version. */
function splitLockKey(key: string): { id: string; version: string } {
  const atIdx = key.lastIndexOf('@');
  if (atIdx === -1) return { id: key, version: '' };
  return { id: key.slice(0, atIdx), version: key.slice(atIdx + 1) };
}

function buildResolvedSetFromLock(lockfile: Lockfile): ResolvedSet {
  const result: ResolvedSet = {};
  for (const [key, entry] of Object.entries(lockfile.resolved)) {
    const { id, version } = splitLockKey(key);
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
    const { id, version } = splitLockKey(key);
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

export function findLocalExtension(root: string, id: string): string | null {
  // ht-8: 'services' added so extensions/services/<id>/ is discoverable.
  const typeDirs = ['agents', 'skills', 'mcp-servers', 'prompts', 'hooks', 'commands', 'bundles', 'services'];
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

      // R9: also search inside bundle members/ subdirectory
      if (typeDir === 'bundles') {
        const membersPath = path.join(extPath, 'members');
        if (fs.existsSync(membersPath) && fs.statSync(membersPath).isDirectory()) {
          for (const memberId of fs.readdirSync(membersPath)) {
            const memberPath = path.join(membersPath, memberId);
            const memberManifestPath = path.join(memberPath, 'extension.json');
            if (!fs.existsSync(memberManifestPath)) continue;
            try {
              const memberManifest = JSON.parse(fs.readFileSync(memberManifestPath, 'utf8')) as { id?: string };
              if (memberManifest.id === id) return memberPath;
            } catch (_e) {
              // Skip malformed manifests
            }
          }
        }
      }
    }
  }
  return null;
}

export function loadExtensionManifest(root: string, id: string): ExtensionManifest | null {
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

// ─── Declarative install (descriptor-driven, Role B) ─────────────────────────
//
// [def:role-b] — sox materialises bytes at the host's discovery path for the
// right scope. Execution is deferred to the host. [inv:boundary].
//
// [ref:host-keyed-target]: all target paths resolved from libs/host-registry.
// [inv:host-agnostic-type]: type is host-agnostic; capability+target are host-specific.
// [inv:never-managed]: managed/forbidden keys are blocked in the registry itself.
// [inv:ledger-reversible]: every placement is recorded in the per-scope ledger.
import { Ledger } from './ledger.js';
// [inv:no-untracked-injection]: every placement is ALSO recorded in the ownership index.
import { OwnershipIndex, type OwnedEntry } from './ownership.js';

// ─── Host-registry: loaded at runtime from dist to avoid cross-lib rootDir ──
// [ref:host-keyed-target]: all literal host paths live in libs/host-registry.
// We load the compiled dist at runtime so the TypeScript compiler does not
// need to traverse outside rootDir (libs/install-engine/src).
// The type shapes are declared locally below for compile-time safety.

/** Minimal local shape for a host surface (mirrors [shape:capability] in _shared.md). */
interface HostSurface {
  capability: string;
  format?: string;
  paths: Partial<Record<string, string>>;
}

/** Minimal local shape for a host module (mirrors HostModule in host-registry). */
interface HostModuleLocal {
  host: string;
  detect(workspaceRoot: string): boolean;
  scopePaths(scope: string): Partial<Record<string, string>>;
  readonly surfaces: Record<string, HostSurface>;
}

export type RegistryHostScope = 'project' | 'user' | 'local' | 'org';

/** Load host-registry at runtime.
 *
 * Source imports the clean '@adhd/sox-host-registry' scope — C7: no cross-package
 * ../dist reach-in, and lint-clean under @nx/enforce-module-boundaries. There
 * are no node_modules symlinks for workspace libs at runtime, so the build's
 * post-tsc step (scripts/rewrite-paths.cjs) rewrites this specifier in the
 * compiled dist to the correct relative path. nx orders host-registry's build
 * first via implicitDependencies in project.json.
 *
 * Loaded lazily (function-scoped require) so host-registry is only pulled in
 * when a declarative install actually runs.
 *
 * [ref:host-keyed-target]: all literal host paths live in libs/host-registry.
 */
function loadHostRegistry(): {
  getHost(name: string): HostModuleLocal;
  expandHome(p: string): string;
} {
  const mod = require('@adhd/sox-host-registry') as {
    getHost(name: string): HostModuleLocal;
    expandHome(p: string): string;
  };
  return mod;
}

/**
 * Thrown when a declarative install is denied at policy check time.
 * [dod.2] — stdio mcp-server into .mcp.json must be denied.
 */
export class DeclarativeDeniedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly ext: string,
    public readonly host: string,
    public readonly scope: string,
  ) {
    super(`[declarative-install] DENIED: ${reason} (ext=${ext}, host=${host}, scope=${scope})`);
    this.name = 'DeclarativeDeniedError';
  }
}

/**
 * Install descriptor — the hybrid install block on a manifest.
 * [shape:install-descriptor] from _shared.md.
 *
 * The engine resolves the per-host target at install time using libs/host-registry.
 * No literal host paths appear here ([ref:host-keyed-target]).
 */
export interface InstallDescriptor {
  /** Extension id. */
  ext: string;
  /** Host-agnostic extension type ("agent", "skill", "mcp-server", "service", etc.) */
  type: string;
  /** Which hosts to install on. */
  hosts: string[];
  /**
   * Bundle this extension is being installed as part of, if any (ADR-0004 §D5).
   * Recorded in the ownership index so a bundle's owned things are grouped and
   * removed as a unit on uninstall.
   */
  bundleId?: string | undefined;
  /** Source content path (absolute) for file-drop types. */
  srcPath?: string | undefined;
  /**
   * For config-merge types: the key path within the config file and the value.
   * [inv:never-managed]: callers must not pass managed/forbidden keyPaths.
   */
  configKeyPath?: string | undefined;
  configValue?: unknown;
  /**
   * Transport for mcp-server: "stdio" | "sse" | "http".
   * Used for the stdio-in-.mcp.json denial check.
   */
  transport?: 'stdio' | 'sse' | 'http' | undefined;
  /** Profile: "standalone" | "shared" | "service" (for mcp-server profile selection). */
  profile?: string | undefined;
  /**
   * ht-5: cascade-resolved config for the extension, used to inject SOX_CONFIG_* into
   * the run-service spec.env at registration time ([inv:standard-config]).
   */
  resolvedConfig?: Record<string, unknown> | undefined;
}

export interface DeclarativeInstallResult {
  host: string;
  scope: string;
  capability: string;
  target: string;
  applied: boolean;
  denied?: boolean;
  denialReason?: string;
}

/**
 * declarativeInstall — place extension content at the host's discovery path.
 *
 * This is the descriptor-driven install entrypoint ([install-lifecycle.3]).
 * It replaces the old single-string `install-target` consumer.
 *
 * Steps:
 *   1. Resolve target path from host-registry ([ref:host-keyed-target]).
 *   2. Policy check: deny stdio mcp-server into .mcp.json ([dod.2]).
 *   3. Apply the capability (file-drop or config-merge).
 *   4. Record in the per-scope ledger ([inv:ledger-reversible]).
 *
 * @param descriptor  the install descriptor (type, hosts, srcPath, etc.)
 * @param scope       the installation scope ("project" | "user")
 * @param workspaceRoot  absolute workspace root (for project-scope relative paths)
 * @param scopeRoot   absolute path to the scope root (for the ledger)
 * @param opts        optional: isProject flag, injected ledger for tests
 * @throws Error if the installation descriptor is invalid
 */
export async function declarativeInstall(
  descriptor: InstallDescriptor,
  scope: RegistryHostScope,
  workspaceRoot: string,
  scopeRoot: string,
  opts?: { isProject?: boolean; ledger?: Ledger },
): Promise<DeclarativeInstallResult[]> {
  const results: DeclarativeInstallResult[] = [];
  const isProject = opts?.isProject ?? (scope === 'project');

  // ── service: materialize bundle → store-dir + run-service registry ─────────
  // [mcp-install-modes.5]: runService is called from install.ts for type:service.
  // [def:store-dir]: materialized extension at <dataDir>/ext/<id>/ (ADR-0004 §D2;
  // scopeRoot is the resolved `.adhd/sox-ecosystem` data dir for the scope).
  // Order:
  //   1. Materialize bundle (srcPath/bundle/ → storePath/)
  //   2. Copy extension.json (entrypoint updated to 'index.js')
  //   3. Register with run-service (command = node <storePath>/index.js)
  //
  // mcp-server types are NOT supervised — they go through the host surface lookup
  // below (config-merge → .mcp.json with "sox serve <id>" as the command).
  const isServiceInstall = descriptor.type === 'service';

  if (isServiceInstall) {
    const { apply: runServiceApply } = await import('./capabilities/run-service.js');
    const storeDir = path.join(scopeRoot, 'ext');
    const storePath = path.join(storeDir, descriptor.ext);

    // 1. Materialize bundle: copy <srcPath>/bundle/ → <storePath>/
    //    Fall back to <srcPath>/dist/ if no bundle dir exists yet.
    if (descriptor.srcPath) {
      const bundleSrcDir = path.join(descriptor.srcPath, 'bundle');
      const distSrcDir = path.join(descriptor.srcPath, 'dist');
      const materializeSrc = fs.existsSync(bundleSrcDir) ? bundleSrcDir
        : fs.existsSync(distSrcDir) ? distSrcDir
          : null;
      if (materializeSrc) {
        copyDirSync(materializeSrc, storePath);
      }
      // 2. Copy extension.json to store dir, updating entrypoint to 'index.js'
      //    so that sox exec can locate the bundle entry without knowing the source.
      const srcManifestPath = path.join(descriptor.srcPath, 'extension.json');
      if (fs.existsSync(srcManifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(srcManifestPath, 'utf8')) as Record<string, unknown>;
        manifest['entrypoint'] = 'index.js';
        fs.writeFileSync(
          path.join(storePath, 'extension.json'),
          JSON.stringify(manifest, null, 2) + '\n',
          'utf8',
        );
      }
    }

    // ht-5: Build SOX_CONFIG_* env from cascade-resolved config for this extension.
    // [inv:standard-config]: config flows only through SOX_CONFIG_* env at runtime.
    const specEnv: Record<string, string> = {};
    if (descriptor.resolvedConfig && Object.keys(descriptor.resolvedConfig).length > 0) {
      const homeDir = os.homedir();
      for (const [cfgKey, cfgVal] of Object.entries(descriptor.resolvedConfig)) {
        const envKey = `SOX_CONFIG_${cfgKey.toUpperCase().replace(/[-\s]/g, '_')}`;
        let strVal = typeof cfgVal === 'string'
          ? cfgVal
          : (cfgVal === null || cfgVal === undefined ? '' : JSON.stringify(cfgVal));
        // Tilde expansion
        if (strVal.startsWith('~/')) strVal = homeDir + strVal.slice(1);
        // Env ref resolution: ${VAR}
        strVal = strVal.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, varName: string) =>
          process.env[varName] ?? _m,
        );
        specEnv[envKey] = strVal;
      }
    }

    // BL-37: a self-contained service bundle inlines all @adhd/sox-* workspace
    // deps but CANNOT inline native addons (.node binaries — better-sqlite3,
    // sqlite-vec). The bundle resolves those at runtime via createRequire, which
    // walks up from the materialized store file (<scopeRoot>/.sox/ext/<id>/index.js)
    // and consults NODE_PATH. For user/org scope the store lives under ~/.sox/ext/
    // with no node_modules up-tree, so we inject NODE_PATH pointing at the
    // workspace node_modules where pnpm hoists the native addons. createRequire
    // honours NODE_PATH, so this resolves the addons portably across every scope.
    // The supervisor preserves NODE_* env vars (it scrubs everything else under
    // the enforced policy), so this reaches the spawned process intact.
    const workspaceNodeModules = path.join(workspaceRoot, 'node_modules');
    if (fs.existsSync(workspaceNodeModules)) {
      const existingNodePath = specEnv['NODE_PATH'] ?? process.env['NODE_PATH'];
      specEnv['NODE_PATH'] = existingNodePath
        ? `${workspaceNodeModules}${path.delimiter}${existingNodePath}`
        : workspaceNodeModules;
    }

    // 3. Register with run-service — command always targets the store dir bundle.
    // [ref:run-service-spec]: preserve the registry entry shape {id,command,args,env,cwd,status,storePath}.
    await runServiceApply({
      host: descriptor.hosts[0] ?? 'claude',
      scope,
      target: { scopeRoot, serviceId: descriptor.ext },
      payload: {
        spec: {
          command: 'node',
          args: [path.join(storePath, 'index.js')],
          env: specEnv,
          cwd: storePath,
        },
      },
    });
    results.push({
      host: descriptor.hosts[0] ?? 'claude',
      scope,
      capability: 'run-service' as DeclarativeInstallResult['capability'],
      target: storeDir,
      applied: true,
    });

    // [inv:no-untracked-injection]: record the materialized store as an owned thing.
    recordOwnership(scopeRoot, descriptor, scope, [
      { kind: 'materialize', path: storePath },
    ]);
    return results;
  }

  // [inv:no-untracked-injection]: accumulate every owned thing placed below.
  const ownedEntries: OwnedEntry[] = [];

  for (const hostName of descriptor.hosts) {
    const { getHost: _getHost, expandHome: _expandHome } = loadHostRegistry();
    const hostMod = _getHost(hostName);
    const surface = hostMod.surfaces[descriptor.type];
    if (surface === undefined) {
      // No surface defined for this type on this host — skip.
      continue;
    }

    const rawTarget = surface.paths[scope];
    if (rawTarget === undefined) {
      // No path for this scope on this host — skip.
      continue;
    }

    // Resolve the absolute target path.
    // [ref:host-keyed-target]: literal paths only in libs/host-registry.
    const absTarget = path.isAbsolute(rawTarget)
      ? _expandHome(rawTarget)
      : path.join(workspaceRoot, rawTarget);

    // [dod.2] Policy check: deny stdio mcp-server into .mcp.json.
    // Claude's .mcp.json only accepts SSE/HTTP transports. A stdio mcp-server placed
    // into .mcp.json would expose an unmediated spawn path outside sox supervision.
    // Throw DeclarativeDeniedError BEFORE writing any file so there is no side effect.
    if (
      descriptor.type === 'mcp-server' &&
      (descriptor.transport === 'stdio' || descriptor.transport === undefined && descriptor.profile === 'stdio') &&
      absTarget.endsWith('.mcp.json')
    ) {
      throw new DeclarativeDeniedError(
        'stdio mcp-server cannot be placed into .mcp.json (only SSE/HTTP transports are allowed); ' +
        'use transport=sse or transport=http for .mcp.json placement',
        descriptor.ext,
        hostName,
        scope,
      );
    }

    const ledger = opts?.ledger ?? Ledger.load(scopeRoot, { isProject });

    if (surface.capability === 'file-drop') {
      // file-drop: copy srcPath to the target path.
      if (descriptor.srcPath === undefined) {
        throw new Error(
          `[declarative-install] file-drop requires srcPath for ext=${descriptor.ext} type=${descriptor.type}`,
        );
      }
      if (!fs.existsSync(descriptor.srcPath)) {
        throw new Error(
          `[declarative-install] srcPath not found: ${descriptor.srcPath}`,
        );
      }

      // Idempotent: copy only if hash differs.
      const srcHash = hashPathForInstall(descriptor.srcPath);

      // Determine the destination: if absTarget is a directory (or should be),
      // place the file as <dir>/<basename>. If the surface path includes a filename
      // extension (like CLAUDE.md), use absTarget directly.
      let destPath: string;
      const srcBasename = path.basename(descriptor.srcPath);
      const targetHasExt = path.extname(absTarget) !== '';
      if (targetHasExt) {
        destPath = absTarget;
      } else {
        destPath = path.join(absTarget, srcBasename);
      }

      const destHash = fs.existsSync(destPath) ? hashPathForInstall(destPath) : '';
      let applied = false;
      if (srcHash !== destHash) {
        // src can be a file (single-file agent/rules drop) or a directory
        // (skill/command/hook directory drop). Use cpSync for directory support.
        // fs.cpSync is available in Node 16.7+; it handles both.
        const srcStat = fs.statSync(descriptor.srcPath);
        if (srcStat.isDirectory()) {
          // For a directory srcPath the destPath IS the directory to create/replace.
          // cpSync with recursive:true copies the contents into destPath.
          if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
          fs.cpSync(descriptor.srcPath, destPath, { recursive: true, force: true });
        } else {
          const dir = path.dirname(destPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.copyFileSync(descriptor.srcPath, destPath);
        }
        applied = true;
      }

      // Record in ledger ([inv:ledger-reversible]).
      // [inv:ledger-reversible]: project ledger must store repo-relative paths so
      // the ledger is portable (committed to repo). User/local scope store absolute.
      const appliedHash = hashPathForInstall(destPath);
      const ledgerFilePath = isProject
        ? path.relative(workspaceRoot, destPath)
        : destPath;
      ledger.record({
        ext: descriptor.ext,
        host: hostName,
        scope,
        action: { cap: 'file-drop', file: ledgerFilePath, keyPath: '', appliedHash },
      });
      ledger.save();

      results.push({ host: hostName, scope, capability: 'file-drop', target: destPath, applied });
      // [inv:no-untracked-injection]: the placed file/dir is owned.
      ownedEntries.push({ kind: 'file-drop', path: destPath });

    } else if (surface.capability === 'config-merge') {
      // config-merge: set keyPath to value in the shared config file.
      //
      // For mcp-server types, auto-derive configKeyPath+configValue from the profile
      // when the caller does not provide them explicitly (common for CLI installs).
      // [mcp-install-modes.1/2]: sse/http → .mcp.json; stdio → .claude.json.
      let resolvedKeyPath = descriptor.configKeyPath;
      let resolvedValue = descriptor.configValue;
      if (descriptor.type === 'mcp-server' && (resolvedKeyPath === undefined || resolvedValue === undefined)) {
        const profile = descriptor.profile ?? 'stdio';
        resolvedKeyPath = `mcpServers.${descriptor.ext}`;
        if (profile === 'sse' || profile === 'http') {
          resolvedValue = { type: profile, url: 'http://localhost:3000/' + profile };
        } else {
          // stdio — sox serve <ext> keeps sox in the spawn chain so cascade config
          // (SOX_CONFIG_*) is injected fresh at each Claude Code session start.
          //
          // CLI bin resolution order (BL-mcp-cmd):
          //   1. SOX_CLI_BIN env var (explicit override, useful in CI / tests)
          //   2. process.argv[1] (the actual running CLI — bin/soxe or its abs path)
          //   3. 'soxe' (last resort; requires soxe to be on PATH)
          //
          // We intentionally do NOT fall back to 'sox' — that collides with the
          // system sox audio tool and causes every MCP server entry written during
          // `soxe install` to spawn the wrong binary.
          const cliBin =
            process.env['SOX_CLI_BIN'] ??
            (process.argv[1] && process.argv[1].length > 0 ? process.argv[1] : undefined) ??
            'soxe';
          resolvedValue = { type: 'stdio', command: cliBin, args: ['serve', descriptor.ext] };
        }
      }

      if (resolvedKeyPath === undefined || resolvedValue === undefined) {
        throw new Error(
          `[declarative-install] config-merge requires configKeyPath+configValue for ext=${descriptor.ext}`,
        );
      }

      const { apply: configMergeApply } = await import('./capabilities/config-merge.js');
      await configMergeApply({
        host: hostName,
        scope,
        scopeRoot,
        workspaceRoot,
        isProject,
        ext: descriptor.ext,
        ledger,
        target: { filePath: absTarget, keyPath: resolvedKeyPath },
        payload: { value: resolvedValue },
      });

      results.push({
        host: hostName,
        scope,
        capability: 'config-merge',
        target: absTarget,
        applied: true,
      });
      // [inv:no-untracked-injection]: the merged config key is owned. The applied-hash
      // is recorded so update/uninstall reverse exactly the value sox set (the ledger
      // holds the deny-wins reversal logic; the ownership index holds the inventory).
      ownedEntries.push({
        kind: 'config-key',
        file: absTarget,
        keyPath: resolvedKeyPath,
      });
    }
  }

  // [inv:no-untracked-injection]: persist the complete owned set for this install.
  if (ownedEntries.length > 0) {
    recordOwnership(scopeRoot, descriptor, scope, ownedEntries);
  }

  return results;
}

/**
 * recordOwnership — ADR-0004 §D5: upsert the owned-entry set for (ext, scope) into
 * the ownership index at <scopeRoot>/ownership.json (scopeRoot is the data dir).
 * Best-effort: a failure here must not fail the install, but it IS logged loudly
 * because an unrecorded injection violates [inv:no-untracked-injection].
 */
function recordOwnership(
  scopeRoot: string,
  descriptor: InstallDescriptor,
  scope: string,
  entries: OwnedEntry[],
): void {
  try {
    const idx = OwnershipIndex.loadFromFile(path.join(scopeRoot, 'ownership.json'));
    const meta: { host?: string; bundleId?: string } = {};
    if (descriptor.hosts[0] !== undefined) meta.host = descriptor.hosts[0];
    if (descriptor.bundleId !== undefined) meta.bundleId = descriptor.bundleId;
    idx.addEntries(descriptor.ext, scope, entries, meta);
    idx.save();
  } catch (e) {
    console.error(
      `[ownership] WARNING: failed to record ownership for ${descriptor.ext} (${scope}): ${String(e)} ` +
      `— [inv:no-untracked-injection] at risk`,
    );
  }
}

// Internal hash helper for declarative install (does not write ledger).
function hashPathForInstall(p: string): string {
  if (!fs.existsSync(p)) return '';
  const stat = fs.statSync(p);
  if (stat.isDirectory()) return hashDirForInstall(p);
  const data = fs.readFileSync(p);
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

function hashDirForInstall(dirPath: string): string {
  const h = crypto.createHash('sha256');
  const entries = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const child = path.join(dirPath, entry.name);
    h.update(entry.name + ':');
    if (entry.isDirectory()) {
      h.update('dir:' + hashDirForInstall(child));
    } else {
      const data = fs.readFileSync(child);
      h.update('file:sha256:' + crypto.createHash('sha256').update(data).digest('hex'));
    }
  }
  return 'sha256:' + h.digest('hex');
}
