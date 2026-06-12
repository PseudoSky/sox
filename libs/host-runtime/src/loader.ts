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
import * as path from 'node:path';
import * as os from 'node:os';
import { HookLoader } from './hook-loader.js';
import { activateMcp } from './adapters/mcp.js';
import { activateHook } from './adapters/hook.js';
import { activateAgent, activateSkill } from './adapters/agent.js';
import { activateCommand, CommandRegistry } from './adapters/command.js';
import type { McpAdapterHandle } from './adapters/mcp.js';
import type { HookAdapterHandle } from './adapters/hook.js';
import type { AgentAdapterHandle, SkillAdapterHandle } from './adapters/agent.js';
import type { CommandAdapterHandle } from './adapters/command.js';

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
  type?: 'stdio-ping' | 'socket' | 'command' | undefined;
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

export type ActivatedHandle =
  | McpAdapterHandle
  | HookAdapterHandle
  | AgentAdapterHandle
  | SkillAdapterHandle
  | CommandAdapterHandle;

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

  const entrypointPath = path.resolve(extDir, manifest.entrypoint);

  if (!fs.existsSync(entrypointPath)) {
    return {
      type: 'skipped',
      reason: `built entrypoint not found at ${entrypointPath} (stale lockfile entry — run 'sox install' to refresh)`,
    };
  }

  // Config schema validation is deferred — validate-manifests is not yet a lib.
  // When resolvedConfigMap is provided, log a note; enforcement is migrate-rest state.
  if (manifest.config_schema && ctx.hasResolvedConfigMap) {
    const resolvedEntry = ctx.resolvedConfigMap[baseId] ?? ctx.resolvedConfigMap[key];
    const resolvedConfig = resolvedEntry?.config ?? {};
    console.log(
      `[loader] "${key}": config_schema validation deferred (${Object.keys(resolvedConfig).length} key(s) — validate-manifests not yet a lib)`,
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

  const handle = await dispatchToAdapter(key, extType, entrypointPath, manifest, ctx, ctx.overrideMcpHealthToStdioPing);
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
): Promise<ActivatedHandle> {
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

      return activateMcp({
        key,
        entrypointPath,
        env: ctx.env,
        lifecycle: effectiveLifecycle,
        permissions: manifest.permissions,
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

    default:
      throw new Error(
        `[loader] Unknown extension type "${extType}" for "${key}". ` +
          `Supported runtime types: mcp-server, hook, agent, skill, command.`,
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
