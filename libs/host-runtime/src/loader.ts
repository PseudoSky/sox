/**
 * libs/host-runtime/src/loader.ts — Host-runtime unified loader.
 *
 * Ported from the pre-nx host runtime. Imports adapted for lib-relative paths.
 * The validateConfigAgainstSchema import is stubbed — the full manifest validation
 * lives in scripts/validate-manifests.ts (not yet migrated to a lib).
 * In this lib, we skip config_schema validation when the function is unavailable.
 *
 * [def:session-fixes] all fixes carried forward:
 *   - resolveExtensionDir no-stat fix (already in scripts/)
 *   - fireIsolated dispatch via event-bus
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentAdapterHandle, SkillAdapterHandle } from './adapters/agent.js';
import { activateAgent, activateSkill } from './adapters/agent.js';
import type { CommandAdapterHandle } from './adapters/command.js';
import { activateCommand, CommandRegistry } from './adapters/command.js';
import type { HookAdapterHandle } from './adapters/hook.js';
import { activateHook } from './adapters/hook.js';
import type { McpAdapterHandle } from './adapters/mcp.js';
import { activateMcp } from './adapters/mcp.js';
import { HookLoader } from './hook-loader.js';
import { LogManager } from './log-manager.js';
import { assertWithinBase, PathEscapeError } from './path-safety.js';
import { ProcessSupervisor } from './supervisor.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LockfileEntry {
  source: string;
  checksum: string;
  resolved_at: string;
  bundle_id?: string | undefined;
}

interface Lockfile {
  lockfileVersion: 1;
  resolved: Record<string, LockfileEntry>;
}

interface LifecycleHealth {
  type?: 'stdio-ping' | 'socket' | 'command' | 'http-get' | undefined;
  endpoint?: string | undefined;
  interval_ms?: number | undefined;
  timeout_ms?: number | undefined;
}

interface LifecycleBlock {
  background?: boolean | undefined;
  singleton?: boolean | undefined;
  health?: LifecycleHealth | undefined;
  stop_timeout_ms?: number | undefined;
}

interface PermissionsBlock {
  fs?: { read?: string[] | undefined; write?: string[] | undefined } | undefined;
  network?: { outbound?: string[] | undefined } | undefined;
  socket?: { paths?: string[] | undefined } | undefined;
}

interface InvocationDeclaration {
  protocol?: string | undefined;
  handler?: string | undefined;
  verb?: string | undefined;
}

interface ExtensionManifest {
  id: string;
  version: string;
  type: string;
  entrypoint?: string | undefined;
  order?: number | undefined;
  lifecycle?: LifecycleBlock | undefined;
  permissions?: PermissionsBlock | undefined;
  config_schema?: Record<string, unknown> | undefined;
  invocation?: InvocationDeclaration | undefined;
  [key: string]: unknown;
}

/**
 * ServiceAdapterHandle — ht-3: handle returned when a type:service extension is activated.
 * Carries the supervisor so the runtime can track pid/health.
 */
export interface ServiceAdapterHandle {
  key: string;
  supervisor: ProcessSupervisor;
  permissions: PermissionsBlock | undefined;
  type: 'service';
}

export type ActivatedHandle =
  | McpAdapterHandle
  | HookAdapterHandle
  | AgentAdapterHandle
  | SkillAdapterHandle
  | CommandAdapterHandle
  | ServiceAdapterHandle;

export interface LoaderResult {
  activated: ActivatedHandle[];
  skipped: Array<{ key: string; reason: string }>;
  errors: Array<{ key: string; error: unknown }>;
  hookLoader: HookLoader;
  commandRegistry: CommandRegistry;
}

export interface LoaderOptions {
  lockfilePath?: string | undefined;
  root?: string | undefined;
  hookLoader?: HookLoader | undefined;
  commandRegistry?: CommandRegistry | undefined;
  env?: Record<string, string> | undefined;
  enabledOverrides?: Record<string, boolean> | undefined;
  resolvedConfigMap?: Record<string, { config: Record<string, unknown>; enabled: boolean; version: string | undefined }> | undefined;
  overrideMcpHealthToStdioPing?: boolean | undefined;
  /**
   * When set, only activate extensions whose lockfile key or base-id matches one of
   * these strings. All others are skipped. Used by `soxe start --id=<ext>`.
   */
  filterIds?: string[] | undefined;
  /**
   * R4: when set, each background extension gets a LogManager rooted at this directory.
   * Path template: <logDir>/<extId>-<YYYY-MM-DD>.log
   * Typically: ~/.sox/logs/<supervisorId>
   */
  logDir?: string | undefined;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// __dirname is available in CJS (tsconfig module=CommonJS)
// libs/host-runtime/dist/loader.js → three levels up = repo root
declare const __dirname: string;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const DEFAULT_LOCKFILE = path.join(
  REPO_ROOT,
  '.extensions',
  'extensions.lock',
);

const INSTALL_ONLY_TYPES = new Set(['bundle', 'prompt']);

// ─── Main loader ──────────────────────────────────────────────────────────────

export async function loadFromLockfile(opts: LoaderOptions = {}): Promise<LoaderResult> {
  const lockfilePath = opts.lockfilePath ?? DEFAULT_LOCKFILE;
  const root = opts.root ?? REPO_ROOT;
  const hookLoader = opts.hookLoader ?? new HookLoader();
  const commandRegistry = opts.commandRegistry ?? new CommandRegistry();
  const env = opts.env ?? {};
  const enabledOverrides = opts.enabledOverrides ?? {};

  const resolvedConfigMap = opts.resolvedConfigMap ?? {};
  const hasResolvedConfigMap = opts.resolvedConfigMap !== undefined;
  const overrideMcpHealthToStdioPing = opts.overrideMcpHealthToStdioPing ?? false;
  const filterIds = opts.filterIds; // undefined → no filter
  const logDir = opts.logDir; // R4: undefined → no logging
  const activated: ActivatedHandle[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  const errors: Array<{ key: string; error: unknown }> = [];

  if (!fs.existsSync(lockfilePath)) {
    console.log(`[loader] No lockfile at ${lockfilePath} — nothing to load`);
    return { activated, skipped, errors, hookLoader, commandRegistry };
  }

  let lockfile: Lockfile;
  try {
    lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8')) as Lockfile;
  } catch (e) {
    console.error(`[loader] Failed to parse lockfile at ${lockfilePath}: ${String(e)}`);
    return { activated, skipped, errors, hookLoader, commandRegistry };
  }

  if (!lockfile.resolved || typeof lockfile.resolved !== 'object') {
    console.log(`[loader] Lockfile has no resolved entries`);
    return { activated, skipped, errors, hookLoader, commandRegistry };
  }

  for (const [key, _entry] of Object.entries(lockfile.resolved)) {
    // filterIds: skip any entry whose base-id or full key doesn't appear in the filter set.
    if (filterIds !== undefined && filterIds.length > 0) {
      const atIdx = key.lastIndexOf('@');
      const baseId = atIdx === -1 ? key : key.slice(0, atIdx);
      if (!filterIds.includes(key) && !filterIds.includes(baseId)) {
        skipped.push({ key, reason: `filtered by --id (not in [${filterIds.join(', ')}])` });
        continue;
      }
    }
    try {
      const result = await processEntry(key, _entry, {
        root,
        hookLoader,
        commandRegistry,
        env,
        enabledOverrides,
        resolvedConfigMap,
        hasResolvedConfigMap,
        overrideMcpHealthToStdioPing,
        logDir,
      });

      if (result.type === 'activated') {
        activated.push(result.handle);
      } else if (result.type === 'skipped') {
        skipped.push({ key, reason: result.reason });
        console.log(`[loader] Skipping "${key}": ${result.reason}`);
      }
    } catch (e) {
      errors.push({ key, error: e });
      console.error(`[loader] Error activating "${key}": ${String(e)}`);
    }
  }

  return { activated, skipped, errors, hookLoader, commandRegistry };
}

// ─── Per-entry processing ─────────────────────────────────────────────────────

type ProcessResult =
  | { type: 'activated'; handle: ActivatedHandle }
  | { type: 'skipped'; reason: string };

async function processEntry(
  key: string,
  entry: LockfileEntry,
  ctx: {
    root: string;
    hookLoader: HookLoader;
    commandRegistry: CommandRegistry;
    env: Record<string, string>;
    enabledOverrides: Record<string, boolean>;
    resolvedConfigMap: Record<string, { config: Record<string, unknown>; enabled: boolean; version: string | undefined }>;
    hasResolvedConfigMap: boolean;
    overrideMcpHealthToStdioPing: boolean;
    logDir?: string | undefined;
  },
): Promise<ProcessResult> {
  const baseId = key.includes('@') ? key.slice(0, key.lastIndexOf('@')) : key;

  if (ctx.enabledOverrides[baseId] === false || ctx.enabledOverrides[key] === false) {
    return { type: 'skipped', reason: 'disabled in scope config' };
  }

  const extDir = resolveExtensionDir(entry.source, ctx.root);
  if (!extDir) {
    return { type: 'skipped', reason: `cannot resolve extension directory from source: ${entry.source}` };
  }

  const manifestPath = path.join(extDir, 'extension.json');
  if (!fs.existsSync(manifestPath)) {
    return { type: 'skipped', reason: `manifest not found at ${manifestPath}` };
  }

  let manifest: ExtensionManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
  } catch (e) {
    return { type: 'skipped', reason: `failed to parse manifest: ${String(e)}` };
  }

  const extType = manifest.type;

  if (INSTALL_ONLY_TYPES.has(extType)) {
    return { type: 'skipped', reason: `type '${extType}' is install-time-only, not a runtime type` };
  }

  if (!manifest.entrypoint) {
    return { type: 'skipped', reason: 'manifest has no entrypoint declared' };
  }

  // BUG-EPIC-MANIFEST-PATH-ESCAPE-001: manifest.entrypoint is untrusted — a
  // manifest declaring "../../../../.ssh/authorized_keys" (or any path outside
  // extDir) must never reach the spawn/activation below. Skip (not throw) so
  // one malicious/corrupt lockfile entry doesn't crash the whole host loader
  // for every other extension — the security property that matters is that
  // the escaped path is NEVER activated, which "skipped" guarantees exactly
  // as well as a thrown error would.
  const entrypointPath = path.resolve(extDir, manifest.entrypoint);
  try {
    assertWithinBase(extDir, entrypointPath);
  } catch (e) {
    if (e instanceof PathEscapeError) {
      return { type: 'skipped', reason: `manifest entrypoint escapes extension dir: ${e.message}` };
    }
    throw e;
  }

  if (!fs.existsSync(entrypointPath)) {
    return {
      type: 'skipped',
      reason: `built entrypoint not found at ${entrypointPath} (stale lockfile entry — run 'soxe install' to refresh)`,
    };
  }

  // ── Spawn-time config injection ───────────────────────────────────────────
  // Convert cascade-resolved config keys to SOX_CONFIG_<KEY> environment vars
  // so background process types (mcp-server, agent) can read their installation
  // config via process.env without requiring it on every tool call.
  //
  // Key format: uppercased, hyphens/spaces → underscores.
  // e.g. db_path → SOX_CONFIG_DB_PATH, recall-ceiling-ms → SOX_CONFIG_RECALL_CEILING_MS
  //
  // Value transforms (applied in order):
  //   1. Tilde expansion: ~/... → <homedir>/...
  //   2. Env ref resolution: ${VAR} → process.env[VAR] (unchanged if var not set)
  //
  // Config env vars are LOWER priority than the caller's env — any explicit key
  // in opts.env that matches a SOX_CONFIG_* key wins.

  let spawnEnv = ctx.env;
  const resolvedEntry = ctx.resolvedConfigMap[baseId] ?? ctx.resolvedConfigMap[key];
  const resolvedConfig = resolvedEntry?.config ?? {};
  if (Object.keys(resolvedConfig).length > 0) {
    const configEnv: Record<string, string> = {};
    const homeDir = os.homedir();
    for (const [cfgKey, cfgVal] of Object.entries(resolvedConfig)) {
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
      configEnv[envKey] = strVal;
    }
    // Caller env wins over config defaults
    spawnEnv = { ...configEnv, ...ctx.env };
    console.log(
      `[loader] "${key}": injecting ${Object.keys(configEnv).length} config key(s) as SOX_CONFIG_* env vars`,
    );
  }

  if (manifest.permissions) {
    const perms = manifest.permissions;
    if (perms.fs) {
      console.log(
        `[loader] "${key}": fs permissions declared — read=${JSON.stringify(perms.fs.read ?? [])}, write=${JSON.stringify(perms.fs.write ?? [])} (enforcement: advisory for in-process, env-gated for spawned)`,
      );
    }
    if (perms.network) {
      console.log(
        `[loader] "${key}": network permissions declared — outbound=${JSON.stringify(perms.network.outbound ?? [])} (enforcement: advisory)`,
      );
    }
    if (perms.socket) {
      console.log(
        `[loader] "${key}": socket permissions declared — paths=${JSON.stringify(perms.socket.paths ?? [])} (enforcement: advisory)`,
      );
    }
  }

  const handle = await dispatchToAdapter(
    key,
    extType,
    entrypointPath,
    manifest,
    { ...ctx, env: spawnEnv },
    ctx.overrideMcpHealthToStdioPing,
    ctx.logDir,
  );
  return { type: 'activated', handle };
}

// ─── Type dispatch ────────────────────────────────────────────────────────────

async function dispatchToAdapter(
  key: string,
  extType: string,
  entrypointPath: string,
  manifest: ExtensionManifest,
  ctx: {
    hookLoader: HookLoader;
    commandRegistry: CommandRegistry;
    env: Record<string, string>;
  },
  overrideMcpHealthToStdioPing = false,
  logDir?: string | undefined,
): Promise<ActivatedHandle> {
  // R4: derive the bare extension id (without version suffix) for log file naming.
  const extId = key.includes('@') ? key.slice(0, key.lastIndexOf('@')) : key;

  switch (extType) {
    case 'mcp-server': {
      const rawLifecycle = manifest.lifecycle ?? {};
      const effectiveLifecycle: LifecycleBlock = overrideMcpHealthToStdioPing
        ? {
          ...rawLifecycle,
          health: rawLifecycle.health
            ? { ...rawLifecycle.health, type: 'stdio-ping' as const }
            : rawLifecycle.health,
        }
        : rawLifecycle;

      // R4: create a LogManager for background extensions when logDir is provided.
      const logManager = (logDir && rawLifecycle.background)
        ? new LogManager({ logDir, extId })
        : undefined;

      return activateMcp({
        key,
        entrypointPath,
        env: ctx.env,
        lifecycle: effectiveLifecycle,
        permissions: manifest.permissions,
        logManager,
      });
    }

    case 'hook': {
      return activateHook({
        key,
        entrypointPath,
        order: manifest.order,
        permissions: manifest.permissions,
        hookLoader: ctx.hookLoader,
      });
    }

    case 'agent': {
      return activateAgent({
        key,
        entrypointPath,
        permissions: manifest.permissions,
      });
    }

    case 'skill': {
      return activateSkill({
        key,
        entrypointPath,
        permissions: manifest.permissions,
      });
    }

    case 'command': {
      const verb =
        (manifest.invocation as InvocationDeclaration | undefined)?.verb ??
        (key.includes('@') ? key.slice(0, key.lastIndexOf('@')) : key);

      return activateCommand({
        key,
        entrypointPath,
        verb,
        permissions: manifest.permissions,
        registry: ctx.commandRegistry,
      });
    }

    // ht-3: service case — dispatch type:service extensions to the supervisor path.
    // [inv:no-regress-mcp]: the mcp-server case above is UNCHANGED.
    case 'service': {
      const rawLifecycle = manifest.lifecycle ?? {};
      // storePath: the directory of the entrypoint so the supervisor can find port.txt
      // written by the service when it binds its port (ht-2).
      const storePath = path.dirname(entrypointPath);

      // R4: create a LogManager for service types when logDir is provided.
      const serviceLogManager = logDir
        ? new LogManager({ logDir, extId })
        : undefined;

      const supervisor = new ProcessSupervisor({
        key,
        entrypointPath,
        args: [],
        env: ctx.env,
        lifecycle: rawLifecycle,
        permissions: manifest.permissions,
        storePath,
        logManager: serviceLogManager,
      });

      await supervisor.start();
      console.log(`[loader] service "${key}" started (pid=${String(supervisor.pid())})`);

      const handle: ServiceAdapterHandle = {
        key,
        supervisor,
        permissions: manifest.permissions,
        type: 'service',
      };
      return handle;
    }

    default:
      throw new Error(
        `[loader] Unknown extension type "${extType}" for "${key}". ` +
        `Supported runtime types: mcp-server, hook, agent, skill, command, service.`,
      );
  }
}

// ─── Source resolution ────────────────────────────────────────────────────────

/**
 * resolveExtensionDir — [def:session-fixes] no-stat fix carried forward.
 * Resolves extension directory from lockfile source without requiring disk access.
 */
export function resolveExtensionDir(source: string, _root: string): string | null {
  if (source.startsWith('file://')) {
    let p = source.slice('file://'.length);
    p = stripKnownSuffix(p);
    if (p.startsWith('~')) {
      p = path.join(os.homedir(), p.slice(1));
    }
    const FILE_EXTS = ['.ts', '.js', '.cjs', '.mjs'];
    if (FILE_EXTS.some((ext) => p.endsWith(ext))) {
      return path.dirname(p);
    }
    return p;
  }

  if (path.isAbsolute(source)) {
    return source;
  }

  return null;
}

function stripKnownSuffix(p: string): string {
  for (const suffix of ['/src/index.ts', '/dist/index.js', '/dist/index.cjs', '/src/index.js']) {
    if (p.endsWith(suffix)) {
      return p.slice(0, p.length - suffix.length);
    }
  }
  return p;
}
