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
import { ownershipPathFor, scopeConfigPaths, storeRootFor, type DataScope } from './data-paths.js';
import { upsertInstallRecord } from './install-registry.js';
import { assertWithinBase } from './path-safety.js';
import { checkProviderCapabilities } from './provider-capabilities.js';
// verify-integrity imports from this module (install.ts); the cycle is safe
// because verifyIntegrity is only invoked at runtime, never at module-eval time.
import { verifyIntegrity } from './verify-integrity.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Scope = 'org' | 'user' | 'project' | 'local';
export const SCOPES: Scope[] = ['org', 'user', 'project', 'local'];
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
  /**
   * The MATERIALIZED artifact the runtime loads (`file://` into a repo checkout
   * or into the per-extension content store). Every loader/exec/reaper consumer
   * reads this as a filesystem location — it is the runtime contract and never
   * carries a non-path locator.
   */
  source: string;
  checksum: string;
  resolved_at: string;
  bundle_id?: string | undefined;
  /**
   * BL-cd1fe520: where `source`'s bytes came FROM — the locator resolution
   * fetched (`npm-package:<name>@<version>`, `npm:…`, `https://…`, or a
   * `file://` repo path). For an `npm-package:` install `source` is the copy
   * npm materialized into `<dataRoot>/ext/<id>/node_modules/…`, so hashing it
   * only proves the copy matches itself; `origin` is what `verifyIntegrity`
   * compares against the current registry pin to decide staleness. Absent on
   * entries written before BL-cd1fe520 (the legacy self-referential shape).
   */
  origin?: string | undefined;
  /**
   * BL-cd1fe520: the directory whose `registry/index.json` supplied this pin
   * (absent when the entry was not resolved from a registry row). `upgrade`
   * judges the pin against THIS registry — never against whatever registry the
   * upgrading shell's cwd, or the CLI's bundled copy, happens to hold.
   */
  registry_root?: string | undefined;
  /** BL-cd1fe520: the registry row's display version at pin time; orders pins so upgrade never downgrades. */
  version?: string | undefined;
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
   *   x-sox-scope-default — per-install-scope value for a REQUIRED key, e.g.
   *     `{ "user": "~/.memory/memory.db", "project": "~/.memory/memory-dev.db" }`.
   *     Seeded without prompting on a non-interactive install and offered as the
   *     prompt default on an interactive one (see resolveRequiredConfigSeed).
   */
  config_schema?: {
    type?: string;
    additionalProperties?: boolean;
    required?: string[];
    properties?: Record<string, ConfigSchemaProperty>;
  } | undefined;
}

/** One `config_schema.properties` entry, with the sox-specific annotations. */
export interface ConfigSchemaProperty {
  type?: string;
  description?: string;
  'x-sox-prompt'?: string;
  'x-sox-default'?: unknown;
  'x-sox-scope-default'?: Partial<Record<Scope, string>>;
}

/**
 * Where install-time config capture gets a value for a REQUIRED key that no
 * scope in the cascade sets yet.
 *   - `env`: the operator exported `SOX_CONFIG_<KEY>` for this install — an
 *     explicit value, persisted without prompting. (Hermetic harnesses such as
 *     the smoke test pin their scratch store this way.)
 *   - `scope-default`: the manifest's `x-sox-scope-default[<scope>]` — persisted
 *     without prompting when non-interactive, offered as the default when
 *     interactive.
 *   - `null`: nothing to seed; the caller prompts (interactive) or warns.
 */
export type RequiredConfigSeed =
  | { source: 'env'; value: string; envKey: string }
  | { source: 'scope-default'; value: string }
  | null;

/** `db_path` → `SOX_CONFIG_DB_PATH` — the same key mapping buildExtConfigEnv uses. */
export function configEnvKey(key: string): string {
  return `SOX_CONFIG_${key.toUpperCase().replace(/[-\s]/g, '_')}`;
}

/**
 * BL 0c3522c2: resolve the install-time seed for a required config key. Pure —
 * no fs, no prompting. Blank values count as absent at every tier.
 */
export function resolveRequiredConfigSeed(
  key: string,
  propDef: ConfigSchemaProperty,
  scope: Scope,
  env: NodeJS.ProcessEnv = process.env,
): RequiredConfigSeed {
  const envKey = configEnvKey(key);
  const fromEnv = (env[envKey] ?? '').trim();
  if (fromEnv) return { source: 'env', value: fromEnv, envKey };
  const scoped = propDef['x-sox-scope-default']?.[scope];
  if (typeof scoped === 'string' && scoped.trim()) return { source: 'scope-default', value: scoped.trim() };
  return null;
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
 * BUG-024: walk upward from `startDir` looking for a `registry/index.json`.
 * Used to recover the real registry root for an out-of-repo consumer — see
 * `recoverRegistryRootFromLockfile` below.
 */
function findRegistryRootUpward(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, 'registry', 'index.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * BUG-024: `loadRegistryIndex(root)` looks for `<root>/registry/index.json`
 * relative to the CONSUMER's project root. That's correct for in-repo
 * consumers (root === the sox-ecosystem checkout) but always comes back empty
 * for a consumer installed OUTSIDE this repo (e.g. a project at
 * `/Users/nix/dev/security/wop`) — there is no `registry/` under an unrelated
 * project's root, and there never will be one. Before this fix that emptiness
 * propagated all the way to a false "not found in registry/index.json"
 * warning and a hard "resolution yielded zero members" abort, even though the
 * registry entry genuinely exists — just not reachable from the consumer's
 * cwd.
 *
 * Recovery: every `LockfileEntry.source` written by `install()` is an
 * ABSOLUTE `file://` URL into the repo/checkout that published the artifact
 * (see the `resolvedSource` assignment in `fetchArtifact`) — it is never
 * relative to the consumer root. So the CONSUMER's own prior (possibly stale)
 * lockfile already records exactly where the real registry lives; walking up
 * from any entry's source path to the nearest `registry/index.json` finds
 * that registry with no rediscovery from the consumer's cwd required, and
 * with no weakening of the "refuse to write an empty lockfile" safety net —
 * this only ever WIDENS what counts as a successful resolution, it never
 * changes what happens when resolution genuinely fails.
 */
function recoverRegistryRootFromLockfile(lock: Lockfile | null): string | null {
  if (!lock) return null;
  // BL-cd1fe520: a `file://` origin points into the publishing checkout even
  // when `source` is a content-store copy (which has no registry above it), so
  // try every origin before any source.
  const candidates: string[] = [];
  for (const entry of Object.values(lock.resolved)) {
    if (entry.origin !== undefined && entry.origin.startsWith('file://')) candidates.push(entry.origin);
  }
  for (const entry of Object.values(lock.resolved)) candidates.push(entry.source);
  for (const candidate of candidates) {
    if (!candidate.startsWith('file://')) continue;
    const sourcePath = candidate.slice('file://'.length);
    // (DEBT-INSTALLENGINE-REGISTRY-RECOVERY-TOCTOU) `existsSync` followed by
    // `statSync` is two syscalls with a window between them: if the path is
    // removed in that window, `statSync` throws ENOENT and the exception
    // escapes `install()` entirely, defeating the accurate not-found warning
    // this whole recovery path exists to reach. Ask once and treat any stat
    // failure as "not a directory" — the `path.dirname` fallback is already
    // the correct behaviour for a vanished path.
    let startDir: string;
    try {
      startDir = fs.statSync(sourcePath).isDirectory() ? sourcePath : path.dirname(sourcePath);
    } catch {
      startDir = path.dirname(sourcePath);
    }
    const found = findRegistryRootUpward(startDir);
    if (found) return found;
  }
  return null;
}

/**
 * The registry `install()` resolves against for a consumer `root`: the root's
 * own `registry/index.json`, else the registry recovered from the consumer's
 * lockfile provenance (BUG-024). Exported so `upgrade` decides staleness
 * against exactly the index its re-install will resolve from (BL-cd1fe520).
 */
export function resolveRegistryIndexForRoot(
  root: string,
  lock: Lockfile | null,
): { index: IndexEntry[]; registryRoot: string | null; recoveredRoot: string | null } {
  const direct = loadRegistryIndex(root);
  if (direct.length > 0) return { index: direct, registryRoot: root, recoveredRoot: null };
  const recoveredRoot = recoverRegistryRootFromLockfile(lock);
  if (recoveredRoot === null) return { index: [], registryRoot: null, recoveredRoot: null };
  const recovered = loadRegistryIndex(recoveredRoot);
  return { index: recovered, registryRoot: recovered.length > 0 ? recoveredRoot : null, recoveredRoot };
}

/**
 * BL-cd1fe520: merge a host-placement/materialize lock write into the entry
 * `install()` may already have written for the same id, instead of replacing it.
 * Replacing dropped `bundle_id` and `origin`, which put the self-referential
 * shape straight back. The origin kept is, in order:
 *   1. the prior origin, when the bytes are unchanged (same artifact ⇒ same provenance);
 *   2. the caller's `origin`, unless it lies inside the content store (a copy of a
 *      copy is never an origin);
 *   3. nothing — an unknown origin is recorded as unknown, never as the copy itself.
 */
export function mergeLockEntry(
  prev: LockfileEntry | undefined,
  next: { source: string; checksum: string; origin?: string | undefined; storeRoot: string },
): LockfileEntry {
  const inStore = (loc: string): boolean => {
    if (!loc.startsWith('file://')) return false;
    const rel = path.relative(path.resolve(next.storeRoot), path.resolve(loc.slice('file://'.length)));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  let origin: string | undefined;
  if (prev?.origin !== undefined && prev.checksum === next.checksum) origin = prev.origin;
  else if (next.origin !== undefined && !inStore(next.origin)) origin = next.origin;
  const merged: LockfileEntry = {
    ...(prev ?? {}),
    source: next.source,
    checksum: next.checksum,
    resolved_at: new Date().toISOString(),
  };
  if (origin !== undefined) merged.origin = origin;
  else delete merged.origin;
  // BL-0ebb23c3: `version`/`registry_root` were pinned against `prev`'s bytes.
  // When the checksum changes (the bundle was rebuilt/re-materialized), the
  // spread of `prev` above silently carries them forward onto the NEW bytes —
  // e.g. a host-placement install from repo bytes inheriting the npm version
  // it happened to have last time, producing a false 'ahead' freeze or
  // spurious re-pin on every subsequent run. Neither caller of
  // mergeLockEntry supplies a fresh version/registry_root, so on a checksum
  // change they must be dropped rather than carried over.
  if (prev !== undefined && prev.checksum !== next.checksum) {
    delete merged.version;
    delete merged.registry_root;
  }
  return merged;
}

/** What a fresh resolution of `id` would install — the pin to compare a lock entry against. */
export interface DesiredPin {
  /** The locator install() would fetch (`npm-package:…`, `file://…`, …). */
  source: string;
  /** The checksum the registry publishes for it; absent for an explicit config source. */
  checksum?: string | undefined;
  /** The registry row's display version, when published — orders pins (never downgrade). */
  version?: string | undefined;
}

/**
 * BL-cd1fe520: mirror `install()`'s source precedence for one id — an explicit
 * `source` on the scope-config entry wins, else the registry row. Returns null
 * when neither exists (a local-checkout fallback install, whose `file://`
 * origin is hashed directly instead).
 */
export function resolveDesiredPin(
  id: string,
  registryIndex: IndexEntry[],
  configSource?: string | undefined,
): DesiredPin | null {
  if (configSource !== undefined && configSource !== '') return { source: configSource };
  const row = resolveFromRegistry(id, registryIndex);
  if (row === null) return null;
  const pin: DesiredPin = { source: row.source, checksum: row.checksum };
  if (typeof row.version === 'string' && row.version !== '') pin.version = row.version;
  return pin;
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

/**
 * Resolve the entrypoint *file* inside an extension directory, using the C4
 * resolution order shared with build-index.resolveChecksum:
 *   1. manifest.entrypoint (explicit — dist/index.js, SKILL.md, …)
 *   2. dist/index.js (built artifact fallback for code types)
 *   3. prompt.md / SKILL.md (declarative content types)
 *   4. extension.json (final fallback for bundles / bare manifests)
 */
export function resolveEntrypointFile(dir: string): string {
  const extJson = path.join(dir, 'extension.json');
  if (fs.existsSync(extJson)) {
    let manifest: { entrypoint?: string } | undefined;
    try {
      manifest = JSON.parse(fs.readFileSync(extJson, 'utf8')) as { entrypoint?: string };
    } catch { /* unparseable extension.json — fall through to the artifact chain */ }
    if (manifest !== undefined && typeof manifest.entrypoint === 'string' && manifest.entrypoint.trim() !== '') {
      // BUG-EPIC-MANIFEST-PATH-ESCAPE-001: manifest.entrypoint is untrusted —
      // refuse anything that resolves outside the extension dir before ever
      // touching the filesystem with it. Deliberately NOT caught by the
      // parse try/catch above: an escape attempt must hard-fail the install,
      // not silently fall through to a default entrypoint.
      const declared = path.join(dir, manifest.entrypoint);
      assertWithinBase(dir, declared);
      if (fs.existsSync(declared)) return declared;
    }
  }
  const distJs = path.join(dir, 'dist', 'index.js');
  if (fs.existsSync(distJs)) return distJs;
  const promptMd = path.join(dir, 'prompt.md');
  if (fs.existsSync(promptMd)) return promptMd;
  const skillMd = path.join(dir, 'SKILL.md');
  if (fs.existsSync(skillMd)) return skillMd;
  return extJson;
}

/**
 * B3 / Slice 3 — `npm-package:` install mode.
 *
 * Native-addon extensions (memory-server → better-sqlite3, sqlite-vec) cannot be
 * delivered by the single-file CDN fetch: a lone dist/index.js on a CDN has no
 * node_modules, so the bundle's lazy createRequire walk finds nothing on a fresh
 * machine. This mode publishes the extension as an npm *package* (tarball with
 * native deps declared as real `dependencies`) and installs it with a real
 * `npm install` into a per-extension content store, so node-gyp/prebuild lands a
 * platform binary next to the bundle.
 *
 * Locator form: `npm-package:<name>@<version>` (e.g.
 * `npm-package:@adhd/sox-extension-memory-server@1.1.0`). The npm REGISTRY is the
 * ambient one (npm config / .npmrc / NPM_CONFIG_REGISTRY) — public npm in
 * production, a local verdaccio in the offline acceptance test. ADR-0003/0005:
 * the version in the locator only SELECTS which bytes to fetch; the checksum the
 * fetcher recomputes over the entrypoint remains the SOLE integrity authority.
 */
function fetchNpmPackage(
  spec: string,
  storeDir: string,
): { entryFile: string; pkgDir: string } {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const at = spec.lastIndexOf('@');
  const pkgName = at > 0 ? spec.slice(0, at) : spec;
  fs.mkdirSync(storeDir, { recursive: true });
  // A minimal package.json so npm treats storeDir as an install root (no warnings).
  const storePkgJson = path.join(storeDir, 'package.json');
  if (!fs.existsSync(storePkgJson)) {
    fs.writeFileSync(
      storePkgJson,
      JSON.stringify({ name: 'sox-ext-store', private: true, version: '0.0.0' }, null, 2) + '\n',
      'utf8',
    );
  }
  execFileSync(
    'npm',
    ['install', spec, '--omit=dev', '--no-audit', '--no-fund', '--save', '--loglevel=error'],
    { cwd: storeDir, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const pkgDir = path.join(storeDir, 'node_modules', ...pkgName.split('/'));
  if (!fs.existsSync(pkgDir)) {
    throw new Error(`install: npm-package "${spec}" did not materialize at ${pkgDir}`);
  }
  return { entryFile: resolveEntrypointFile(pkgDir), pkgDir };
}

export async function fetchArtifact(
  source: string,
  expectedChecksum?: string | undefined,
  opts?: { storeDir?: string | undefined },
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
          let manifest: { entrypoint?: string } | undefined;
          try {
            manifest = JSON.parse(fs.readFileSync(extJson, 'utf8')) as { entrypoint?: string };
          } catch { /* unparseable extension.json — fall through */ }
          if (manifest !== undefined && typeof manifest.entrypoint === 'string' && manifest.entrypoint.trim() !== '') {
            // BUG-EPIC-MANIFEST-PATH-ESCAPE-001: manifest.entrypoint is untrusted.
            // Deliberately NOT caught by the parse try/catch above — an escape
            // attempt must hard-fail fetchArtifact, not silently read some other
            // file's bytes as this extension's checksum content.
            const declared = path.join(filePath, manifest.entrypoint);
            assertWithinBase(filePath, declared);
            if (fs.existsSync(declared)) contentPath = declared;
          }
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
  } else if (source.startsWith('npm-package:')) {
    // Slice 3 / B3: real npm install (tarball + transitive native deps) into a
    // per-extension content store. Required for native-addon extensions whose
    // better-sqlite3/sqlite-vec cannot ride a single-file CDN fetch.
    const spec = source.slice('npm-package:'.length);
    if (opts?.storeDir === undefined) {
      throw new Error(
        `install: npm-package source "${source}" requires a storeDir (internal: pass opts.storeDir)`,
      );
    }
    const { entryFile } = fetchNpmPackage(spec, opts.storeDir);
    bytes = fs.readFileSync(entryFile);
    resolvedSource = `file://${entryFile}`;
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

// ─── Atomic lockfile write ──────────────────────────────────────────────────────

/**
 * PI-5 / BL-141: atomic lockfile write.
 * Prevents partial writes from producing a corrupt lockfile.
 * Also rejects lockfiles with zero resolved entries (hard failure).
 *
 * D-B / B-I1: delegates to the SHARED `atomicWriteFileSync` primitive (unique
 * per-process O_EXCL temp + one atomic rename). This was the SECOND fixed-`.tmp`
 * site; flipping only one would leave the other racing, so both route here.
 */
export function writeLockfileAtomic(lockPath: string, lockfile: Lockfile): void {
  // PI-5: hard failure when resolution yields zero members
  if (Object.keys(lockfile.resolved).length === 0) {
    throw new Error(
      `install: REFUSING to write empty lockfile at ${lockPath} — ` +
      `resolution yielded zero members. Check config or registry.`,
    );
  }
  atomicWriteFileSync(lockPath, JSON.stringify(lockfile, null, 2) + '\n');
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
   * BL-42 fresh-machine fallback: an already-resolved registry index. When the
   * caller (the CLI) runs as a published, self-contained bundle there is no repo
   * checkout under `root`, so the default `loadRegistryIndex(root)` would return
   * `[]`. The CLI resolves the registry (cwd → CLI-bundled copy) and injects it
   * here. When omitted, behaviour is unchanged: `loadRegistryIndex(root)`.
   */
  registryIndex?: IndexEntry[] | undefined;
  /**
   * BL-cd1fe520: the directory `registryIndex` was loaded from. Recorded on every
   * lock entry resolved from a registry row as `registry_root`, so `upgrade`
   * can judge the pin against the registry it actually came from.
   */
  registryRoot?: string | undefined;
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
  // BL-73: derive config/lockfile paths from the caller-supplied root, not from the
  // module-level REPO_ROOT constant. For user scope, scopeConfigPaths ignores root
  // and returns userDataRoot() — unchanged. For project/local, root is honoured so
  // bookkeeping lands under the target project, not the CLI's own repo.
  const scopePaths = scopeConfigPaths(opts.scope, root);
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

  const existingLock = loadLockfile(lockPath);

  let registryIndex: IndexEntry[];
  // BUG-024: root-relative resolution came back empty — try to recover the
  // real registry root from the consumer's own (possibly stale) lockfile
  // provenance before concluding the registry is unreachable. See
  // `recoverRegistryRootFromLockfile` for why this is sound.
  let recoveredRegistryRoot: string | null = null;
  let registryRootUsed: string | undefined;
  if (opts.registryIndex !== undefined && opts.registryIndex.length > 0) {
    registryIndex = opts.registryIndex;
    registryRootUsed = opts.registryRoot;
  } else {
    const resolvedIndex = resolveRegistryIndexForRoot(root, existingLock);
    registryIndex = resolvedIndex.index;
    recoveredRegistryRoot = resolvedIndex.recoveredRoot;
    registryRootUsed = resolvedIndex.registryRoot ?? undefined;
    if (recoveredRegistryRoot !== null && registryIndex.length > 0) {
      console.log(
        `install: registry not found under root ${root} — recovered it from lockfile ` +
        `provenance at ${recoveredRegistryRoot} (BUG-024)`,
      );
    }
  }

  const singleScopeOnly = opts.configPath !== undefined;
  const allScopeConfigs = await loadScopeCascade({
    scope: opts.scope,
    primaryConfig: scopeConfig,
    singleScopeOnly,
    existingLock,
    mode: opts.mode,
    root,
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
    // The CLI blocks bare `soxe install <member>` positionals before they reach install().

    let source: string;
    let expectedChecksum: string | undefined;
    let pinnedFromRow: IndexEntry | undefined;

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
          //
          // BUG-024: the old message ("not found in registry/index.json") was
          // FALSE whenever registryIndex was empty because root has no
          // registry of its own (an out-of-repo consumer) — the entry might be
          // sitting right there in the real registry, just unreachable from
          // this root, and "rebuild the registry" cannot fix that. Name the
          // actual condition instead.
          if (registryIndex.length === 0) {
            console.warn(
              `install: WARNING skipping "${entry.id}" — the registry is not discoverable from ` +
              `consumer root ${root} (no registry/index.json there)` +
              (recoveredRegistryRoot !== null
                ? `, and the registry recovered from lockfile provenance at ${recoveredRegistryRoot} ` +
                  `does not contain "${entry.id}" either`
                : `, and no prior lockfile entry with a file:// source was available to recover the ` +
                  `original registry root from`) +
              `. This is NOT a "rebuild the index" problem — the publishing repo's registry/index.json ` +
              `may be entirely correct. Verify the repo/checkout that originally published "${entry.id}" ` +
              `still exists on disk at the path recorded in its prior lockfile entry, or add an explicit ` +
              `"source" to this entry in the scope config.`,
            );
          } else {
            console.warn(
              `install: WARNING skipping "${entry.id}" — ` +
              `not found in registry/index.json (${registryIndex.length} entries loaded) and not found locally. ` +
              `Run 'pnpm run build-index' to rebuild the registry, or remove this entry from the config.`,
            );
          }
          continue;
        }
      } else {
        source = indexEntry.source;
        expectedChecksum = indexEntry.checksum;
        pinnedFromRow = indexEntry;
      }
    }

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

    try {
      // Slice 3: npm-package sources install into a per-extension content store
      // under <dataRoot>/ext/<id>/ so the native deps land beside the bundle and
      // the runtime can spawn from a node_modules-bearing dir on a fresh machine.
      const fetchOpts =
        source.startsWith('npm-package:')
          ? { storeDir: path.join(storeRootFor(opts.scope, root), entry.id) }
          : undefined;
      const { checksum, source: resolvedSource } = await fetchArtifact(source, expectedChecksum, fetchOpts);

      // ADR-0003: the lockfile key is the BARE id. The checksum is the integrity
      // authority; there is no `@version` decoration. One id ⇒ one artifact.
      const indexEntry = resolveFromRegistry(entry.id, registryIndex);
      const lockKey = entry.id;

      // BL-cd1fe520: `resolvedSource` is where the bytes now LIVE (for
      // npm-package, a copy inside the content store); `source` is where they
      // came FROM. Record both — dropping the origin made the lock entry
      // self-referential and blinded `upgrade` to every later release.
      const lockEntry: LockfileEntry = {
        source: resolvedSource,
        checksum,
        resolved_at: new Date().toISOString(),
        origin: source,
      };
      if (pinnedFromRow !== undefined) {
        if (registryRootUsed !== undefined) lockEntry.registry_root = path.resolve(registryRootUsed);
        if (typeof pinnedFromRow.version === 'string' && pinnedFromRow.version !== '') lockEntry.version = pinnedFromRow.version;
      }
      if (entry.bundleId !== undefined) {
        lockEntry.bundle_id = entry.bundleId;
      }
      newResolved[lockKey] = lockEntry;

      console.log(`install: resolved ${lockKey} from ${resolvedSource} (${checksum})`);

      // ── Install-time config capture ─────────────────────────────────────────
      // If the extension declares a config_schema with required keys, check the
      // cascade-resolved config and prompt (or warn) for missing values.
      //
      // BL 0c3522c2: runs AFTER the fetch so the manifest can be located from the
      // resolved artifact, not only under `root`. `findLocalExtension(root)` only
      // sees an in-repo extension; an install run from any other project dir (a
      // registry `file://` row, or an `npm-package:` materialized into the content
      // store) used to find no manifest and skip this block without a sound —
      // leaving a required key such as memory-server's db_path unset.
      const configManifest =
        extManifest ?? findManifestForSource(resolvedSource, entry.id) ?? findManifestForSource(source, entry.id);
      if (configManifest === null) {
        console.warn(
          `install: warning: could not locate extension.json for '${entry.id}' (root ${root}, source ${resolvedSource}) — ` +
          `required config keys were not checked.`,
        );
      }
      if (configManifest?.config_schema) {
        const schema = configManifest.config_schema;
        const requiredKeys: string[] = schema.required ?? [];
        const properties = schema.properties ?? {};
        // Get the cascade-resolved config for this extension
        const cascadedEntryConfig: Record<string, unknown> = cascadedConfig[entry.id]?.config ?? {};
        const configPath5 = opts.configPath ?? scopePaths.config;

        for (const reqKey of requiredKeys) {
          if (reqKey in cascadedEntryConfig) continue; // already set in some scope

          const propDef = properties[reqKey] ?? {};
          const promptText = propDef['x-sox-prompt'] ?? `Enter value for ${entry.id}.${reqKey}:`;
          const seed = resolveRequiredConfigSeed(reqKey, propDef, opts.scope);
          // A scope default outranks the generic x-sox-default as the prompt default.
          const defaultVal = seed?.source === 'scope-default' ? seed.value : propDef['x-sox-default'];

          const persist = (value: string, how: string): void => {
            const existing = loadConfig(configPath5) as Record<string, unknown> ?? {};
            const cfgBlock = (existing['config'] as Record<string, Record<string, unknown>> | undefined) ?? {};
            const extBlock = cfgBlock[entry.id] ?? {};
            extBlock[reqKey] = value;
            cfgBlock[entry.id] = extBlock;
            existing['config'] = cfgBlock;
            const configDir = path.dirname(configPath5);
            if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(configPath5, JSON.stringify(existing, null, 2) + '\n', 'utf8');
            // The cascade snapshot is read again below (bundle members, later
            // entries) — keep it in step with what was just written.
            cascadedEntryConfig[reqKey] = value;
            console.log(`install: config: set ${entry.id}.${reqKey} (scope: ${opts.scope}, ${how})`);
          };

          if (seed?.source === 'env') {
            // Explicit operator value — never prompt over it.
            persist(seed.value, `from ${seed.envKey}`);
          } else if (opts.onMissingConfig) {
            // CLI layer handles the interactive prompt
            const captured = await opts.onMissingConfig(entry.id, reqKey, promptText as string, defaultVal);
            if (captured !== undefined) {
              persist(captured, 'prompted');
            } else {
              console.warn(
                `install: warning: required config key '${reqKey}' for '${entry.id}' was not set. ` +
                `Run: soxe config set ${entry.id} ${reqKey} <value>`,
              );
            }
          } else if (seed?.source === 'scope-default') {
            // BL 0c3522c2: non-interactive install seeds the manifest's per-scope
            // value instead of leaving a required key unset for the runtime to guess.
            persist(seed.value, `x-sox-scope-default[${opts.scope}]`);
          } else {
            // Non-interactive: warn
            console.warn(
              `install: warning: required config key '${reqKey}' for '${entry.id}' is not set in any scope.\n` +
              `  Run: soxe config set ${entry.id} ${reqKey} <value>`,
            );
          }
        }
      }

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
          origin: source,
        });
      } catch (regErr) {
        console.warn(`install: warning: could not update install registry: ${String(regErr)}`);
      }
    } catch (e) {
      // BL-6e5191e4: a fetch/checksum failure here used to call process.exit(1)
      // directly. cmdUpgrade's per-consumer try/catch (main.ts) awaits
      // install({mode:'update'}) expecting a rejected promise it can catch and
      // report per-consumer — process.exit() cannot be caught, so it killed the
      // whole `soxe upgrade --all` run and skipped every remaining consumer and
      // the rolling restart. In update mode, throw a typed error instead so the
      // caller can recover; other modes (a direct `soxe install`) keep the
      // original fail-fast CLI behavior.
      if (opts.mode === 'update') {
        throw new Error(`install: failed for "${entry.id}": ${String(e)}`);
      }
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

  writeLockfileAtomic(lockPath, lockfile);
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
  /** Project/local root used to derive the correct data-path for each scope (BL-73). */
  root: string;
}

async function loadScopeCascade(opts: CascadeOpts): Promise<ScopeConfigWithMeta[]> {
  const { scope, primaryConfig, singleScopeOnly, existingLock, mode, root } = opts;
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

    // BL-73: use the caller-supplied root so project/local scope reads from the
    // correct project directory, not the CLI's own REPO_ROOT.
    const paths = scopeConfigPaths(s, root);
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

/**
 * BL 0c3522c2: locate the manifest of an extension from a `file://` source (a
 * file or a directory), walking up a few levels until an `extension.json` whose
 * `id` matches is found. Covers a registry `file://…/dist/index.js` row and an
 * `npm-package:` source, whose resolved form is `file://<pkgDir>/dist/index.js`.
 */
export function findManifestForSource(source: string, id: string): ExtensionManifest | null {
  if (!source.startsWith('file://')) return null;
  let dir = source.slice('file://'.length);
  try {
    if (!fs.existsSync(dir)) return null;
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch (err) {
    console.warn(`install: warning: cannot stat source ${source}: ${String(err)}`);
    return null;
  }
  for (let i = 0; i < 4; i++) {
    const manifestPath = path.join(dir, 'extension.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest & { id?: string };
        if (manifest.id === id) return manifest;
      } catch (err) {
        console.warn(`install: warning: malformed ${manifestPath}: ${String(err)}`);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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
// [def:role-b] — soxe materialises bytes at the host's discovery path for the
// right scope. Execution is deferred to the host. [inv:boundary].
//
// [ref:host-keyed-target]: all target paths resolved from libs/host-registry.
// [inv:host-agnostic-type]: type is host-agnostic; capability+target are host-specific.
// [inv:never-managed]: managed/forbidden keys are blocked in the registry itself.
// [inv:ledger-reversible]: every placement is recorded in the per-scope ledger.
import { Ledger } from './ledger.js';
// [inv:no-untracked-injection]: every placement is ALSO recorded in the ownership index.
import { OwnershipIndex, OwnershipWriteError, type OwnedEntry } from './ownership.js';
// D-B / B-I1: the one parallel-safe publish primitive (unique O_EXCL temp + one rename).
import { atomicWriteFileSync } from './atomic-write.js';
// Type-only: the agent-catalog capability's injectable client. It is imported as a
// type so no runtime edge is added — the capability itself is dynamically imported
// at the agent-catalog branch (see DECISION below) and its client defaults to the
// MCP-over-stdio implementation. A caller (e.g. reconcile-agent-mcp) may inject one.
import type { AgentCatalogClient, AgentCatalogPayload } from './capabilities/agent-catalog.js';

// ─── Host-registry: loaded at runtime from dist to avoid cross-lib rootDir ──
// [ref:host-keyed-target]: all literal host paths live in libs/host-registry.
// We load the compiled dist at runtime so the TypeScript compiler does not
// need to traverse outside rootDir (libs/install-engine/src).
// The type shapes are declared locally below for compile-time safety.

/** Minimal local shape for a host surface (mirrors [shape:capability] in _shared.md). */
interface HostSurface {
  capability: string;
  format?: string;
  mcpConfig?: { keyPath(extId: string): string; value(profile: string, cliBin: string, extId: string, port?: number, bindAddress?: string): unknown };
  postInstallHint?: string;
  paths: Partial<Record<string, string>>;
}

/** Minimal local shape for a host renderer (mirrors HostRenderer in host-registry). */
export interface AgentRenderLocal {
  /**
   * Sibling `render.<host>` name to inherit `{provider, model}` from when this
   * host's own render lacks both (bug eb1ab168). Mirrors HostRenderer.providerFrom.
   */
  providerFrom?: string;
  render(ir: unknown, prose: string, overrides?: unknown): { kind: string; content?: string; value?: unknown };
}

/** Minimal local shape for a host module (mirrors HostModule in host-registry). */
interface HostModuleLocal {
  host: string;
  detect(workspaceRoot: string): boolean;
  scopePaths(scope: string): Partial<Record<string, string>>;
  readonly surfaces: Record<string, HostSurface>;
  readonly render?: AgentRenderLocal;
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
  renderSkillFile(
    manifest: unknown,
    prose: string,
  ): { kind: string; content?: string } | null;
} {
  const mod = require('@adhd/sox-host-registry') as {
    getHost(name: string): HostModuleLocal;
    expandHome(p: string): string;
    renderSkillFile(manifest: unknown, prose: string): { kind: string; content?: string } | null;
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
 * Thrown when an `agent` extension is installed into an agent catalog but declares
 * neither an `agent` IR nor a `render.<host>` override — a raw passthrough has no
 * host-rendered header to produce (bug f775d10c). Reaching the renderer with an
 * empty IR instead surfaces an unnamed `AgentProviderUnderivableError`, which a
 * caller cannot distinguish from a genuine provider problem. Named + typed, the
 * reconcile one-shot classifies it as `skipped: not-renderable` rather than failing.
 */
export class AgentNotRenderableError extends Error {
  constructor(public readonly ext: string) {
    super(`[agent-catalog] agent '${ext}' declares no agent IR or render`);
    this.name = 'AgentNotRenderableError';
  }
}

/**
 * Render an `agent` extension into an agent-catalog payload for a host, or throw.
 *
 * CENTRALIZED RENDERABILITY GATE (bug f775d10c): a row with no agent IR and no
 * `render.<host>` override is not renderable and is rejected with the named,
 * typed `AgentNotRenderableError` BEFORE the renderer is invoked — never reached
 * with `ir={}`, which makes `deriveProvider` throw the unnamed
 * `AgentProviderUnderivableError` and, through `reconcileAgentMcpCatalog`, turns a
 * heal into a hard exit-1 failure.
 *
 * Both the apply branch AND the `--dry-run` block call this, so a dry run exercises
 * the SAME renderability decision apply will and cannot promise a rewrite apply
 * would reject (the finding: the dry-run hid the throw because it never rendered).
 */
function renderAgentCatalogPayload(
  descriptor: InstallDescriptor,
  hostName: string,
  render: AgentRenderLocal,
): AgentCatalogPayload {
  if (descriptor.type !== 'agent') {
    throw new Error(
      `[declarative-install] agent-catalog is only defined for type=agent (got type=${descriptor.type} for ext=${descriptor.ext})`,
    );
  }
  if (descriptor.srcPath === undefined) {
    throw new Error(
      `[declarative-install] agent-catalog requires srcPath for ext=${descriptor.ext}`,
    );
  }
  const inputs = readAgentRenderInputs(descriptor.srcPath, hostName, render);
  if (inputs === null) {
    throw new Error(
      `[declarative-install] agent-catalog: cannot read agent IR for '${descriptor.ext}' (no extension.json at ${descriptor.srcPath})`,
    );
  }
  if (!inputs.renderable) {
    throw new AgentNotRenderableError(descriptor.ext);
  }
  // A manifest need not duplicate its id in the IR — fall back to the ext id.
  const override = { ...(inputs.override ?? {}) };
  if (override['name'] === undefined && inputs.ir['name'] === undefined) {
    override['name'] = descriptor.ext;
  }
  const prose = readAgentProse(descriptor.srcPath);
  const rendered = render.render(inputs.ir, prose, override);
  if (rendered.kind !== 'config-value') {
    throw new Error(
      `[declarative-install] agent-catalog host '${hostName}' renderer must return a config-value (got kind=${rendered.kind})`,
    );
  }
  return rendered.value as AgentCatalogPayload;
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
   * For array-merge types: values to append to the target array (deny-wins).
   */
  configValues?: string[] | undefined;
  /**
   * For object-array-merge types: object entries to append to the target array.
   * Each entry is tagged with configIdentityField = configIdentityValue for
   * identity-scoped reversible removal (foreign entries are preserved).
   */
  configEntries?: Record<string, unknown>[] | undefined;
  configIdentityField?: string | undefined;
  configIdentityValue?: string | undefined;
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
  hints?: string[];
  /**
   * BL-? / --dry-run: true when this result is a PLAN only — the target was
   * resolved and reported but NOTHING was written (no file-drop, no config
   * merge, no ledger/ownership/lockfile mutation). The CLI prints "would
   * place" for these and skips post-install side effects.
   */
  dryRun?: boolean;
  /**
   * D-B: set when the best-effort lockfile sync failed AFTER a successful
   * placement. Previously swallowed to a stderr `console.warn`; now surfaced on
   * the result so the caller can see the lockfile is stale (never silent).
   */
  lockSyncWarning?: string;
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
 * @param opts        optional: isProject flag, injected ledger for tests, dryRun
 * @throws Error if the installation descriptor is invalid
 */
export async function declarativeInstall(
  descriptor: InstallDescriptor,
  scope: RegistryHostScope,
  workspaceRoot: string,
  scopeRoot: string,
  opts?: { isProject?: boolean; ledger?: Ledger; dryRun?: boolean; force?: boolean; catalogClient?: AgentCatalogClient },
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
  // below (config-merge → .mcp.json with "soxe serve <id>" as the command).
  const isServiceInstall = descriptor.type === 'service';

  if (isServiceInstall) {
    const { apply: runServiceApply } = await import('./capabilities/run-service.js');
    const storeDir = path.join(scopeRoot, 'ext');
    // BUG-EPIC-MANIFEST-PATH-ESCAPE-001: descriptor.ext is the CLI-supplied
    // extension id (apps/sox/src/main.ts passes the raw positional argument
    // through unvalidated) — refuse an id like "../../etc" before it can steer
    // the materialized store path outside storeDir.
    const storePath = path.join(storeDir, descriptor.ext);
    assertWithinBase(storeDir, storePath);

    // --dry-run: plan only — report the materialize target WITHOUT writing
    // (no bundle copy, no extension.json rewrite, no run-service registration,
    // no ownership/lockfile mutation).
    if (opts?.dryRun) {
      results.push({
        host: descriptor.hosts[0] ?? 'claude',
        scope,
        capability: 'run-service' as DeclarativeInstallResult['capability'],
        target: storePath,
        applied: false,
        dryRun: true,
      });
      return results;
    }

    // 1. Materialize bundle: copy <srcPath>/bundle/ → <storePath>/
    //    Fall back to <srcPath>/dist/ if no bundle dir exists yet.
    // BL-cd1fe520: the artifact the store copy is taken FROM — recorded as the
    // lock entry's origin so staleness is judged against the source, not the copy.
    let materializedFrom: string | undefined;
    if (descriptor.srcPath) {
      const bundleSrcDir = path.join(descriptor.srcPath, 'bundle');
      const distSrcDir = path.join(descriptor.srcPath, 'dist');
      const materializeSrc = fs.existsSync(bundleSrcDir) ? bundleSrcDir
        : fs.existsSync(distSrcDir) ? distSrcDir
          : null;
      if (materializeSrc) {
        copyDirSync(materializeSrc, storePath);
        const fromIndex = path.join(materializeSrc, 'index.js');
        if (fs.existsSync(fromIndex)) materializedFrom = fromIndex;
      }
      // 2. Copy extension.json to store dir, updating entrypoint to 'index.js'
      //    so that soxe exec can locate the bundle entry without knowing the source.
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

    // Lockfile sync: materialized store path → lockfile entry.
    try {
      const indexJs = path.join(storePath, 'index.js');
      if (fs.existsSync(indexJs)) {
        const lockDirPaths = scopeConfigPaths(scope, workspaceRoot);
        const lPath = lockDirPaths.lockfile;
        const lKey = descriptor.ext;
        const artBytes = fs.readFileSync(indexJs);
        const csum = crypto.createHash('sha256').update(artBytes).digest('hex');
        const existing: Lockfile = loadLockfile(lPath) ?? { lockfileVersion: LOCKFILE_VERSION, resolved: {} };
        existing.resolved[lKey] = mergeLockEntry(existing.resolved[lKey], {
          source: `file://${indexJs}`,
          checksum: `sha256:${csum}`,
          origin: materializedFrom !== undefined ? `file://${materializedFrom}` : undefined,
          storeRoot: storeDir,
        });
        writeLockfileAtomic(lPath, existing);
      }
    } catch (e) {
      // D-B: never silent — surface the stale-lockfile warning on the result.
      const warn = `install: could not write lockfile entry for ${descriptor.ext}: ${String(e)}`;
      console.warn(`warning: ${warn}`);
      const last = results[results.length - 1];
      if (last !== undefined) last.lockSyncWarning = warn;
    }

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
    // into .mcp.json would expose an unmediated spawn path outside soxe supervision.
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

    // --dry-run: plan only — resolve + report the placement WITHOUT writing.
    // Placed before ledger load / ownership recording so a dry run creates
    // zero state (no files, no ledger, no ownership entries, no lockfile).
    if (opts?.dryRun) {
      // agent-catalog has no filesystem target — the artifact is a catalog ROW.
      // Render IN-MEMORY (bug f775d10c) so the plan exercises the SAME
      // renderability decision apply will: a raw-passthrough agent throws the
      // named AgentNotRenderableError here, and the caller (reconcile) reports it
      // `skipped: not-renderable` instead of promising a rewrite apply would reject.
      if (surface.capability === 'agent-catalog') {
        if (hostMod.render === undefined) {
          throw new Error(
            `[declarative-install] host '${hostName}' declares capability agent-catalog but exposes no renderer`,
          );
        }
        renderAgentCatalogPayload(descriptor, hostName, hostMod.render);
        results.push({
          host: hostName,
          scope,
          capability: 'agent-catalog',
          target: `agent-mcp catalog row '${descriptor.ext}'`,
          applied: false,
          dryRun: true,
        });
        continue;
      }
      let planTarget = absTarget;
      if (surface.capability === 'file-drop' && descriptor.srcPath) {
        // Mirror the file-drop destPath logic below so the plan names the
        // exact directory/file that WOULD be created.
        // BL-566: agent file-drops land as a single top-level <id>.md, not a dir.
        planTarget = path.extname(absTarget) !== ''
          ? absTarget
          // BUG-EPIC-MANIFEST-PATH-ESCAPE-001: descriptor.ext is the CLI-supplied
          // extension id — assertWithinBase refuses an id like "../../etc" before
          // it can steer the reported plan target outside absTarget.
          : descriptor.type === 'agent'
            ? assertWithinBase(absTarget, path.join(absTarget, `${descriptor.ext}.md`))
            : path.join(absTarget, path.basename(descriptor.srcPath));
      }
      results.push({
        host: hostName,
        scope,
        capability: surface.capability,
        target: planTarget,
        applied: false,
        dryRun: true,
      });
      continue;
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
      // BL-566: for agent type the hashed source is the entrypoint file (the
      // only thing that lands), not the whole extension directory — otherwise
      // the dir-vs-file hash never matches and every install re-copies.
      let contentPath = descriptor.srcPath;
      if (descriptor.type === 'agent' && fs.statSync(descriptor.srcPath).isDirectory()) {
        contentPath = resolveEntrypointFile(descriptor.srcPath);
        // [def:agent-renderer]: render the host-specific header + prose when the
        // manifest declares an `agent` IR / `render` override and the host has a
        // renderer. Raw passthrough otherwise.
        if (hostMod.render !== undefined) {
          const rendered = renderAgentForHost(descriptor.srcPath, descriptor.ext, hostName, hostMod.render);
          if (rendered !== null) contentPath = rendered;
        }
      } else if (descriptor.type === 'skill' && fs.statSync(descriptor.srcPath).isDirectory()) {
        // [def:skill-renderer]: render the host-agnostic header from the manifest
        // so the copied SKILL.md carries a machine-generated YAML header and the
        // source SKILL.md stays prose-only (bug aace3faa). Raw passthrough when
        // the manifest has no usable id/description.
        const staged = renderSkillForHost(descriptor.srcPath, descriptor.ext);
        if (staged !== null) contentPath = staged;
      }
      const srcHash = hashPathForInstall(contentPath);

      // Determine the destination: if absTarget is a directory (or should be),
      // place the file as <dir>/<basename>. If the surface path includes a filename
      // extension (like CLAUDE.md), use absTarget directly.
      // BL-566: for AGENT type the host discovers only a single top-level
      // <id>.md file (opencode scans agents/*.md, not nested dirs), so the drop
      // target is the entrypoint file at <absTarget>/<ext>.md — never a
      // directory. Skills/commands/hooks keep the directory form (their hosts
      // walk nested dirs).
      let destPath: string;
      const targetHasExt = path.extname(absTarget) !== '';
      if (targetHasExt) {
        destPath = absTarget;
      } else if (descriptor.type === 'agent') {
        // BUG-EPIC-MANIFEST-PATH-ESCAPE-001: descriptor.ext is the CLI-supplied
        // extension id — refuse before it can steer the real write target
        // outside absTarget.
        destPath = assertWithinBase(absTarget, path.join(absTarget, `${descriptor.ext}.md`));
      } else {
        destPath = path.join(absTarget, path.basename(descriptor.srcPath));
      }

      const destHash = fs.existsSync(destPath) ? hashPathForInstall(destPath) : '';
      let applied = false;
      // Unowned-file guard (BUG-028): never clobber an existing file this
      // extension does not own.
      // `soxe install` must not silently overwrite a hand-authored / legacy host
      // file (incident: researcher.md — a working opencode agent was replaced by a
      // divergent extension copy and opencode rejected it). If the destination
      // exists AND is not already owned by THIS extension's record, refuse unless
      // the caller explicitly passes force=true.
      if (fs.existsSync(destPath) && !opts?.force) {
        const ownershipIdx = OwnershipIndex.loadFromFile(ownershipPathFor(scope, workspaceRoot));
        const ownedByThis = ownershipIdx
          .get(descriptor.ext, scope)
          ?.entries?.some((e) => e.kind === 'file-drop' && e.path === destPath);
        if (!ownedByThis) {
          throw new Error(
            `[declarative-install] refusing to overwrite unowned file at ${destPath} (BUG-028). ` +
              `This file exists but is not owned by extension '${descriptor.ext}' in scope '${scope}'. ` +
              `It may be a hand-authored or legacy host file. Uninstall it first if it is a stale ` +
              `extension install, or pass force=true to overwrite deliberately.`,
          );
        }
      }
      if (srcHash !== destHash) {
        if (descriptor.type === 'agent') {
          // BL-566 + [def:agent-renderer]: copy the (possibly rendered) entrypoint
          // file to <absTarget>/<ext>.md. contentPath is always a file for agent.
          const dir = path.dirname(destPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.copyFileSync(contentPath, destPath);
        } else {
          // Non-agent: src can be a directory (skill/command/hook) or a file.
          // contentPath is descriptor.srcPath except for skills, where it is the
          // staged directory carrying the rendered header.
          const srcStat = fs.statSync(contentPath);
          if (srcStat.isDirectory()) {
            if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
            fs.cpSync(contentPath, destPath, { recursive: true, force: true });
          } else {
            const dir = path.dirname(destPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.copyFileSync(contentPath, destPath);
          }
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

      const fdResult: DeclarativeInstallResult = { host: hostName, scope, capability: 'file-drop', target: destPath, applied };
      if (surface.postInstallHint) {
        fdResult.hints = [surface.postInstallHint];
      }
      results.push(fdResult);
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
        // Extract http_port and bind_address from cascade-resolved config (TR-3, BL-148).
        // These come from the config_schema defaults (x-sox-default) or user override.
        const httpPort = descriptor.resolvedConfig?.['http_port'] as number | undefined;
        const bindAddress = descriptor.resolvedConfig?.['bind_address'] as string | undefined;

        // If the host provides an mcpConfig builder, use it.
        if (surface.mcpConfig) {
          const cliBin =
            process.env['SOX_CLI_BIN'] ??
            (process.argv[1] && process.argv[1].length > 0 ? process.argv[1] : undefined) ??
            'soxe';
          const profile = descriptor.profile ?? 'stdio';
          resolvedKeyPath = surface.mcpConfig.keyPath(descriptor.ext);
          resolvedValue = surface.mcpConfig.value(profile, cliBin, descriptor.ext, httpPort, bindAddress);
        } else {
          // Default: Claude-format auto-derivation (preserved for backward compat).
          // (Currently dead for host==='claude' — claude.ts now owns an explicit
          // mcpConfig, so this branch only fires for a future host lacking one.)
          const profile = descriptor.profile ?? 'stdio';
          resolvedKeyPath = `mcpServers.${descriptor.ext}`;
          if (profile === 'sse' || profile === 'http') {
            // Build URL from resolved port and bind address (TR-3, BL-148).
            // Port default matches the live memory-server deployment
            // (SOX_CONFIG_PORT=3099, BL-156/157) — 3000 went stale 2026-07-04.
            const port = httpPort ?? 3099;
            const host = bindAddress ?? '127.0.0.1';
            const displayHost = host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
            const endpoint = profile === 'sse' ? 'sse' : 'mcp';
            // `type` is Claude Code's mandatory transport discriminator — the only
            // recognized remote values are "http"/"sse"/"ws"; there is no "remote"
            // type (verified against code.claude.com/docs/en/mcp, 2026-07-18). A
            // url-only entry with a missing/wrong type is silently treated as a
            // broken stdio server and skipped. `profile` IS the correct value.
            resolvedValue = { type: profile, url: `http://${displayHost}:${port}/${endpoint}` };
          } else {
            // stdio — soxe serve <ext> keeps soxe in the spawn chain so cascade config
            // (SOX_CONFIG_*) is injected fresh at each Claude Code session start.
            //
            // CLI bin resolution order (BL-mcp-cmd):
            //   1. SOX_CLI_BIN env var (explicit override, useful in CI / tests)
            //   2. process.argv[1] (the actual running CLI — bin/soxe or its abs path)
            //   3. 'soxe' (last resort; requires soxe to be on PATH)
            //
            // We intentionally do NOT fall back to 'sox' — that collides with the
            // system soxe audio tool and causes every MCP server entry written during
            // `soxe install` to spawn the wrong binary.
            const cliBin =
              process.env['SOX_CLI_BIN'] ??
              (process.argv[1] && process.argv[1].length > 0 ? process.argv[1] : undefined) ??
              'soxe';
            resolvedValue = { type: 'stdio', command: cliBin, args: ['serve', descriptor.ext] };
          }
        }
      }

      // [def:agent-renderer]: codex agent — auto-derive the TOML config value
      // (`agents.<id>`) from the IR + prose when the host has a renderer. Codex
      // agents are config-merge (TOML), not file-drop, so the render result is a
      // config value, not a file.
      if (
        descriptor.type === 'agent' &&
        (resolvedKeyPath === undefined || resolvedValue === undefined) &&
        descriptor.srcPath !== undefined &&
        hostMod.render !== undefined
      ) {
        const inputs = readAgentRenderInputs(descriptor.srcPath, hostName, hostMod.render);
        if (inputs !== null && inputs.renderable) {
          const prose = readAgentProse(descriptor.srcPath);
          const result = hostMod.render.render(inputs.ir, prose, inputs.override);
          if (result.kind === 'config-value') {
            resolvedKeyPath = `agents.${descriptor.ext}`;
            resolvedValue = result.value;
          }
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

      const cmResult: DeclarativeInstallResult = {
        host: hostName,
        scope,
        capability: 'config-merge',
        target: absTarget,
        applied: true,
      };
      if (surface.postInstallHint) {
        cmResult.hints = [surface.postInstallHint];
      }
      results.push(cmResult);
      // [inv:no-untracked-injection]: the merged config key is owned. The applied-hash
      // is recorded so update/uninstall reverse exactly the value soxe set (the ledger
      // holds the deny-wins reversal logic; the ownership index holds the inventory).
      ownedEntries.push({
        kind: 'config-key',
        file: absTarget,
        keyPath: resolvedKeyPath,
      });
    } else if (surface.capability === 'agent-catalog') {
      // agent-catalog: upsert an agent row into a remote catalog over that
      // catalog's own MCP surface (host = agent-mcp). No filesystem target —
      // the renderer produces the create payload ({name, systemPrompt, provider,
      // ...}) and the capability performs an idempotent read→update-or-create.
      if (hostMod.render === undefined) {
        throw new Error(
          `[declarative-install] host '${hostName}' declares capability agent-catalog but exposes no renderer`,
        );
      }
      // f775d10c: the renderability gate lives in the helper, so apply and
      // --dry-run make the identical decision (a non-renderable passthrough
      // throws AgentNotRenderableError here, never reaching render() with {}).
      const payload = renderAgentCatalogPayload(descriptor, hostName, hostMod.render);
      const { apply: agentCatalogApply } = await import('./capabilities/agent-catalog.js');
      await agentCatalogApply({
        host: hostName,
        scope,
        scopeRoot,
        workspaceRoot,
        isProject,
        ext: descriptor.ext,
        target: { filePath: absTarget },
        payload: { value: payload },
        ledger,
        // exactOptionalPropertyTypes: only attach when a client was actually injected.
        ...(opts?.catalogClient !== undefined ? { client: opts.catalogClient } : {}),
      });

      const acResult: DeclarativeInstallResult = {
        host: hostName,
        scope,
        capability: 'agent-catalog',
        target: `agent-mcp catalog row '${descriptor.ext}'`,
        applied: true,
      };
      if (surface.postInstallHint) {
        acResult.hints = [surface.postInstallHint];
      }
      results.push(acResult);
      // [inv:no-untracked-injection]: the catalog row is owned. No filesystem
      // target — the ledger's agent-catalog action reverses it (agent_delete).
      ownedEntries.push({ kind: 'agent-catalog', name: descriptor.ext });
    } else if (surface.capability === 'array-merge') {
      // array-merge: append values to an array in the shared config file.
      // Used for permissions arrays, MCP trust arrays, etc.
      if (!descriptor.configValues || descriptor.configValues.length === 0) {
        throw new Error(
          `[declarative-install] array-merge requires configValues for ext=${descriptor.ext}`,
        );
      }
      const resolvedKeyPath = descriptor.configKeyPath ?? `permissions.allow`;
      const { apply: arrayMergeApply } = await import('./capabilities/array-merge.js');
      await arrayMergeApply({
        host: hostName,
        scope,
        scopeRoot,
        isProject,
        ext: descriptor.ext,
        ledger,
        target: { filePath: absTarget, keyPath: resolvedKeyPath },
        payload: { values: descriptor.configValues },
      });
      results.push({
        host: hostName,
        scope,
        capability: 'array-merge',
        target: absTarget,
        applied: true,
      });
      ownedEntries.push({
        kind: 'array-values',
        file: absTarget,
        keyPath: resolvedKeyPath,
        values: descriptor.configValues,
      });
    } else if (surface.capability === 'object-array-merge') {
      // object-array-merge: append identity-tagged objects to an array.
      // Used for Claude Code PostToolUse hooks (hooks.PostToolUse[] in settings.json).
      // Reversible: identity-scoped removal preserves foreign hooks.
      if (!descriptor.configEntries || descriptor.configEntries.length === 0) {
        throw new Error(
          `[declarative-install] object-array-merge requires configEntries for ext=${descriptor.ext}`,
        );
      }
      const resolvedKeyPath = descriptor.configKeyPath ?? `hooks.PostToolUse`;
      const identityField = descriptor.configIdentityField ?? '_sox';
      const identityValue = descriptor.configIdentityValue ?? descriptor.ext;
      const { apply: oamApply } = await import('./capabilities/object-array-merge.js');
      await oamApply({
        host: hostName,
        scope,
        scopeRoot,
        isProject,
        ext: descriptor.ext,
        ledger,
        target: { filePath: absTarget, keyPath: resolvedKeyPath },
        payload: {
          entries: descriptor.configEntries,
          identityField,
          identityValue,
        },
      });
      results.push({
        host: hostName,
        scope,
        capability: 'object-array-merge',
        target: absTarget,
        applied: true,
      });
      if (surface.postInstallHint) {
        results[results.length - 1]!.hints = [surface.postInstallHint];
      }
      ownedEntries.push({
        kind: 'object-array-values',
        file: absTarget,
        keyPath: resolvedKeyPath,
        entries: descriptor.configEntries,
        identityField,
        identityValue,
      });

      // Secondary surface: hook-script file-drop for type:hook extensions.
      // The hook script is dropped to ~/.claude/hooks/<id>/ using the existing
      // hook-script surface, while the settings entry was handled above.
      if (descriptor.type === 'hook' && descriptor.srcPath) {
        const hookScriptSurface = hostMod.surfaces['hook-script'];
        if (hookScriptSurface) {
          const hookScriptRawTarget = hookScriptSurface.paths[scope];
          if (hookScriptRawTarget) {
            const hookScriptAbsTarget = path.isAbsolute(hookScriptRawTarget)
              ? _expandHome(hookScriptRawTarget)
              : path.join(workspaceRoot, hookScriptRawTarget);
            const srcBasename = path.basename(descriptor.srcPath);
            const hookDestPath = path.join(hookScriptAbsTarget, srcBasename);
            if (!fs.existsSync(hookDestPath)) {
              const srcStat = fs.statSync(descriptor.srcPath);
              if (srcStat.isDirectory()) {
                fs.cpSync(descriptor.srcPath, hookDestPath, { recursive: true, force: true });
              } else {
                const dir = path.dirname(hookDestPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.copyFileSync(descriptor.srcPath, hookDestPath);
              }
            }
            ownedEntries.push({ kind: 'file-drop', path: hookDestPath });
            // Record in ledger for reversal
            const hookScriptLedgerFilePath = isProject
              ? path.relative(workspaceRoot, hookDestPath)
              : hookDestPath;
            ledger.record({
              ext: descriptor.ext,
              host: hostName,
              scope,
              action: { cap: 'file-drop', file: hookScriptLedgerFilePath, keyPath: '', appliedHash: hashPathForInstall(hookDestPath) },
            });
            // Also push a result entry so the CLI knows about the file-drop
            results.push({
              host: hostName,
              scope,
              capability: 'file-drop',
              target: hookDestPath,
              applied: true,
            });
          }
        }
      }
    }
  }

  // [inv:no-untracked-injection]: persist the complete owned set for this install.
  if (ownedEntries.length > 0) {
    recordOwnership(scopeRoot, descriptor, scope, ownedEntries);
  }

  // ── Lockfile sync ───────────────────────────────────────────────────────────
  // Host-placement install (mcp-server via config-merge, service via run-service)
  // writes to the host's config file but NOT to the install-engine's lockfile.
  // Without a lockfile entry, `verifyIntegrity` cannot find the extension, so
  // `soxe upgrade --all` silently skips it ("not in lockfile"). Sync here so
  // that upgrade can detect stale artifacts and restart running services.
  if (!opts?.dryRun && descriptor.srcPath && (descriptor.type === 'mcp-server' || descriptor.type === 'service')) {
    try {
      // Determine the artifact to hash (mirrors fetchArtifact's file:// logic).
      const extJson = path.join(descriptor.srcPath, 'extension.json');
      let artifactPath: string | undefined;
      if (fs.existsSync(extJson)) {
        let manifest: { entrypoint?: string } | undefined;
        try {
          manifest = JSON.parse(fs.readFileSync(extJson, 'utf8')) as { entrypoint?: string };
        } catch { /* unparseable extension.json — fall through */ }
        if (manifest !== undefined && typeof manifest.entrypoint === 'string' && manifest.entrypoint.trim() !== '') {
          // BUG-EPIC-MANIFEST-PATH-ESCAPE-001: manifest.entrypoint is untrusted.
          // Deliberately NOT caught here — propagates to the outer try/catch
          // below, which warns and skips the lockfile sync rather than hashing
          // an attacker-chosen file outside the extension dir into the lockfile.
          const declared = path.join(descriptor.srcPath, manifest.entrypoint);
          assertWithinBase(descriptor.srcPath, declared);
          if (fs.existsSync(declared)) artifactPath = declared;
        }
      }
      if (!artifactPath) {
        const distJs = path.join(descriptor.srcPath, 'dist', 'index.js');
        if (fs.existsSync(distJs)) artifactPath = distJs;
      }
      if (artifactPath) {
        const lockDir = scopeConfigPaths(scope, workspaceRoot);
        const lockPath = lockDir.lockfile;
        const lockKey = descriptor.ext;
        const artifactBytes = fs.readFileSync(artifactPath);
        const checksum = crypto.createHash('sha256').update(artifactBytes).digest('hex');
        const source = `file://${artifactPath}`;

        // Merge into existing lockfile or create new.
        const existing: Lockfile = loadLockfile(lockPath) ?? { lockfileVersion: LOCKFILE_VERSION, resolved: {} };
        existing.resolved[lockKey] = mergeLockEntry(existing.resolved[lockKey], {
          source,
          checksum: `sha256:${checksum}`,
          origin: source,
          storeRoot: storeRootFor(scope as DataScope, workspaceRoot),
        });
        writeLockfileAtomic(lockPath, existing);
      }
    } catch (e) {
      // D-B: never silent — surface the stale-lockfile warning on the result.
      const warn = `install: could not write lockfile entry for ${descriptor.ext}: ${String(e)}`;
      console.warn(`warning: ${warn}`);
      const last = results[results.length - 1];
      if (last !== undefined) last.lockSyncWarning = warn;
    }
  }

  return results;
}

/**
 * recordOwnership — ADR-0004 §D5: upsert the owned-entry set for (ext, scope) into
 * the ownership index at <scopeRoot>/ownership.json (scopeRoot is the data dir).
 *
 * D-B / B-I2 + B-I8: the caller invokes this AFTER the placement it records has
 * succeeded, and a failure here THROWS a typed `OwnershipWriteError` — an install
 * that placed bytes but could not record them must fail loudly rather than ship an
 * untracked artifact nothing can reverse (the old swallow-then-continue is gone).
 */
function recordOwnership(
  scopeRoot: string,
  descriptor: InstallDescriptor,
  scope: string,
  entries: OwnedEntry[],
): void {
  try {
    // Strict load: a corrupt index throws (never reads empty and wipes entries).
    const idx = OwnershipIndex.loadFromFile(path.join(scopeRoot, 'ownership.json'), { strict: true });
    const meta: { host?: string; bundleId?: string } = {};
    if (descriptor.hosts[0] !== undefined) meta.host = descriptor.hosts[0];
    if (descriptor.bundleId !== undefined) meta.bundleId = descriptor.bundleId;
    idx.addEntries(descriptor.ext, scope, entries, meta);
    idx.save();
  } catch (e) {
    // B-I2: the placement already happened; failing here is the correct, loud
    // outcome (artifact is untracked-and-repairable, never silently unrecorded).
    throw new OwnershipWriteError(descriptor.ext, scope, e);
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

// ─── Cross-platform agent rendering (docs/spec/cross-platform-install-rendering.md) ───
// [def:agent-renderer] support: when an `agent` extension declares an `agent` IR
// and/or `render.<host>` overrides, the install engine renders the host-specific
// header instead of copying the entrypoint verbatim. Raw passthrough when the
// host has no renderer or the manifest declares neither block.

export interface AgentRenderInputs {
  ir: Record<string, unknown>;
  override: Record<string, unknown> | undefined;
  renderable: boolean;
}

/**
 * Read the `agent` IR and `render.<host>` override from an extension's manifest.
 *
 * `render` is the host's own agent renderer (optional). When the host's render
 * block lacks BOTH `provider` and `model`, and the renderer declares a
 * `providerFrom` sibling, that sibling's `{provider, model}` is inherited
 * (own fields win). This is how agent-mcp — a catalog that serves whatever host
 * actually runs the agent — picks up the opencode model instead of minting a
 * vendor default (bug eb1ab168). An absent sibling leaves the override unchanged.
 *
 * Exported so it is unit-testable without spawning the catalog server.
 */
export function readAgentRenderInputs(
  srcPath: string,
  hostName: string,
  render?: AgentRenderLocal,
): AgentRenderInputs | null {
  const manifestPath = path.join(srcPath, 'extension.json');
  if (!fs.existsSync(manifestPath)) return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const ir = manifest['agent'];
  const renders = manifest['render'];
  const renderMap =
    renders !== null && typeof renders === 'object' && !Array.isArray(renders)
      ? (renders as Record<string, unknown>)
      : undefined;
  let override = renderMap?.[hostName] as Record<string, unknown> | undefined;

  // Provider inheritance (bug eb1ab168): the host render names a sibling to
  // inherit from when its own override supplies neither provider nor model.
  const siblingName = typeof render?.providerFrom === 'string' ? render.providerFrom : undefined;
  if (siblingName !== undefined && renderMap !== undefined) {
    const ownLacksProviderAndModel =
      override === undefined ||
      (typeof override !== 'object') ||
      Array.isArray(override) ||
      (override['provider'] === undefined && override['model'] === undefined);
    if (ownLacksProviderAndModel) {
      const siblingRaw = renderMap[siblingName];
      const sibling =
        siblingRaw !== null && typeof siblingRaw === 'object' && !Array.isArray(siblingRaw)
          ? (siblingRaw as Record<string, unknown>)
          : undefined;
      if (sibling !== undefined) {
        const inherited: Record<string, unknown> = {};
        if (sibling['provider'] !== undefined) inherited['provider'] = sibling['provider'];
        if (sibling['model'] !== undefined) inherited['model'] = sibling['model'];
        const own =
          override !== null && typeof override === 'object' && !Array.isArray(override)
            ? override
            : {};
        // Own-wins, shallow spread: the host's own fields override the sibling's.
        override = { ...inherited, ...own };
      }
    }
  }

  const hasIr = ir !== null && typeof ir === 'object' && !Array.isArray(ir);
  const hasOverride = override !== undefined && typeof override === 'object' && !Array.isArray(override);
  return {
    ir: hasIr ? (ir as Record<string, unknown>) : {},
    override: hasOverride ? override : undefined,
    renderable: hasIr || hasOverride,
  };
}

/** Read the agent prose body (the entrypoint .md). The renderer strips frontmatter. */
function readAgentProse(srcPath: string): string {
  return fs.readFileSync(resolveEntrypointFile(srcPath), 'utf8');
}

/**
 * Render an agent IR + prose for a host into a deterministic scratch file, or
 * return null when the extension is not renderable (raw passthrough). Only
 * file-body results are handled here (claude/opencode); codex's config-value is
 * handled in the config-merge branch.
 */
function renderAgentForHost(
  srcPath: string,
  ext: string,
  hostName: string,
  render: AgentRenderLocal,
): string | null {
  const inputs = readAgentRenderInputs(srcPath, hostName, render);
  if (inputs === null || !inputs.renderable) return null;
  const prose = readAgentProse(srcPath);
  const result = render.render(inputs.ir, prose, inputs.override);
  if (result.kind !== 'file-body' || typeof result.content !== 'string') return null;
  // Deterministic scratch file: content-hash-named so identical rendered bytes
  // share one file and re-install hashing is byte-stable ([inv:rendered-deterministic]).
  const csum = crypto.createHash('sha256').update(result.content).digest('hex').slice(0, 16);
  const scratchDir = path.join(os.tmpdir(), 'sox-render');
  fs.mkdirSync(scratchDir, { recursive: true });
  const scratchPath = path.join(scratchDir, `${ext}-${hostName}-${csum}.md`);
  // `ext` is caller-supplied and this path is predictable: contain it, and drop any
  // existing entry first, or a planted symlink is followed by writeFileSync and its
  // target clobbered (cf915fee — same shape as the skill stager).
  assertWithinBase(scratchDir, scratchPath);
  fs.rmSync(scratchPath, { force: true });
  fs.writeFileSync(scratchPath, result.content, 'utf8');
  return scratchPath;
}

/**
 * Render a skill's header from its manifest (extension.json) into a staged
 * directory, or return null when the manifest has no usable id/description
 * (raw passthrough). The staged directory's basename equals basename(srcDir)
 * so destPath (path.join(absTarget, basename(srcPath))) and the cpSync
 * semantics are unchanged; the rendered SKILL.md overwrites the source copy
 * inside the staged directory.
 *
 * [def:skill-renderer]: the skill half of "author once, install everywhere" —
 * the header is derived from extension.json through host-registry's
 * renderSkillFile (yamlStringify), making SKILL.md prose-only (bug aace3faa).
 */
function renderSkillForHost(srcDir: string, ext: string): string | null {
  const manifestPath = path.join(srcDir, 'extension.json');
  if (!fs.existsSync(manifestPath)) return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const prosePath = resolveEntrypointFile(srcDir);
  if (!fs.existsSync(prosePath)) return null;
  const prose = fs.readFileSync(prosePath, 'utf8');
  const { renderSkillFile } = loadHostRegistry();
  const result = renderSkillFile(manifest, prose);
  if (result === null || result.kind !== 'file-body' || typeof result.content !== 'string') {
    return null;
  }
  // Deterministic staging dir: content-hash-named so identical rendered bytes
  // share one directory and re-install hashing is byte-stable
  // ([inv:rendered-deterministic]).
  const csum = crypto.createHash('sha256').update(result.content).digest('hex').slice(0, 16);
  const scratchDir = path.join(os.tmpdir(), 'sox-render');
  fs.mkdirSync(scratchDir, { recursive: true });
  const stagedSkillDir = path.join(scratchDir, `${ext}-${csum}`, path.basename(srcDir));
  // `ext` is caller-supplied: contain the staged path before touching it (cf915fee).
  assertWithinBase(scratchDir, stagedSkillDir);
  // Mirror the source EXACTLY: cpSync merges and never deletes, so a file removed from the
  // source would survive in the staged tree, leaving hashPathForInstall unchanged and the
  // install reporting applied=false while stale content installs (e1e98fe0).
  fs.rmSync(stagedSkillDir, { recursive: true, force: true });
  fs.mkdirSync(stagedSkillDir, { recursive: true });
  fs.cpSync(srcDir, stagedSkillDir, { recursive: true, force: true });
  const stagedSkillMd = path.join(stagedSkillDir, 'SKILL.md');
  fs.writeFileSync(stagedSkillMd, result.content, 'utf8');
  return stagedSkillDir;
}
