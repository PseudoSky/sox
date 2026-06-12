/**
 * scripts/host/loader.ts — Host-runtime unified loader.
 *
 * CONTRACT GAP CLOSED (audit Gap C1 — "single most consequential finding"):
 *   Turns `installed` (lockfile entries) into `running` (activated adapters).
 *   This is analysis.md row #8 (`install → activated runtime`) becoming Defined.
 *
 * Responsibilities:
 *   1. Read the scope lockfile produced by `bin/sox install`.
 *   2. Resolve each entry's BUILT entrypoint path (dist/index.js, never .ts).
 *   3. Validate the resolved config against config_schema (PB — validateConfigAgainstSchema).
 *   4. Log declared permissions{} at activation (P4 scope; enforcement is P5).
 *   5. Dispatch to the correct per-type adapter.
 *   6. Enforce lockfile hygiene: stale entries (uninstalled, entrypoint missing) are skipped.
 *
 * Lockfile hygiene (Gap C5 fix):
 *   An entry is considered stale and SKIPPED if:
 *   a. The extension is disabled (enabled === false in the scope config), OR
 *   b. The built entrypoint path does not exist on disk (artifact missing after uninstall).
 *   Stale entries are logged as warnings — they are NOT errors (the lockfile is a snapshot).
 *
 * Socket-endpoint convention (Gap A5 fix):
 *   Tilde paths in lifecycle.health.endpoint are expanded via expandTilde() in supervisor.ts
 *   before being used as Node socket paths. The loader passes the raw manifest value through;
 *   the supervisor performs the expansion at probe time.
 *
 * Permission enforcement (PB — P4 scope):
 *   validateConfigAgainstSchema() from scripts/validate-manifests.ts is called after
 *   scope-cascade resolution. The permissions{} block is recorded/logged but NOT yet
 *   runtime-sandboxed (that is P5 scope per the plan).
 *
 * Design: integrates BELOW bin/sox — does not touch bin/sox or the engine. The engine
 *   (install.ts, cascade.ts) remains the lockfile producer; the loader is its missing callee.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HookLoader } from '../hook-loader.js';
import { activateMcp } from './adapters/mcp.js';
import { activateHook } from './adapters/hook.js';
import { activateAgent, activateSkill } from './adapters/agent.js';
import { activateCommand, CommandRegistry } from './adapters/command.js';
import { validateConfigAgainstSchema } from '../validate-manifests.js';
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
  /** Absolute path to the lockfile. Defaults to the project-scope lockfile. */
  lockfilePath?: string | undefined;
  /**
   * Root directory for resolving extension dirs from file:// sources.
   * Defaults to the repo root (one level above scripts/).
   */
  root?: string | undefined;
  /**
   * External HookLoader to use. If absent, a new one is created.
   * Pass an existing loader to share the registry with other subsystems.
   */
  hookLoader?: HookLoader | undefined;
  /**
   * External CommandRegistry to use. If absent, a new one is created.
   */
  commandRegistry?: CommandRegistry | undefined;
  /**
   * Extra env vars forwarded to spawned process-type extensions.
   */
  env?: Record<string, string> | undefined;
  /**
   * Enabled extension IDs (from scope config). If absent, all lockfile entries are enabled.
   * An entry whose id is mapped to false is treated as disabled (skipped — Gap C5 hygiene).
   */
  enabledOverrides?: Record<string, boolean> | undefined;
  /**
   * Cascade-resolved config map (from cascade.ts) — keyed by extension id.
   * When present, the loader validates each extension's resolved config against its
   * declared config_schema (closes Gap F3 — PB/P5 enforcement).
   * The resolved config entry's `config` field is passed to validateConfigAgainstSchema.
   */
  resolvedConfigMap?: Record<string, { config: Record<string, unknown>; enabled: boolean; version: string | undefined }> | undefined;
  /**
   * When true, override health.type to 'stdio-ping' for all mcp-server extensions.
   * Use this when the manifest's health.endpoint points to a socket that the stdio MCP
   * server does not create (e.g. memoryd.sock is only for the daemon, not the stdio server).
   * 'stdio-ping' health means: is the process alive? (no socket probe).
   */
  overrideMcpHealthToStdioPing?: boolean | undefined;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

const DEFAULT_LOCKFILE = path.join(
  REPO_ROOT,
  '.extensions',
  'extensions.lock',
);

// Extension types that are NOT loaded by this runtime loader (install-time-only)
const INSTALL_ONLY_TYPES = new Set(['bundle', 'prompt']);

// ─── Main loader ──────────────────────────────────────────────────────────────

/**
 * Load all activated extensions from the lockfile and return their handles.
 *
 * Call order:
 *   1. Read lockfile
 *   2. For each entry:
 *      a. Skip if stale (disabled / entrypoint missing)
 *      b. Resolve entrypoint path
 *      c. Load manifest (for lifecycle/permissions/config_schema)
 *      d. Validate config (PB — validateConfigAgainstSchema)
 *      e. Dispatch to per-type adapter
 */
export async function loadFromLockfile(opts: LoaderOptions = {}): Promise<LoaderResult> {
  const lockfilePath = opts.lockfilePath ?? DEFAULT_LOCKFILE;
  const root = opts.root ?? REPO_ROOT;
  const hookLoader = opts.hookLoader ?? new HookLoader();
  const commandRegistry = opts.commandRegistry ?? new CommandRegistry();
  const env = opts.env ?? {};
  const enabledOverrides = opts.enabledOverrides ?? {};

  const resolvedConfigMap = opts.resolvedConfigMap ?? {};
  // Only run config_schema validation when a resolved config map was explicitly provided.
  // When no map is given (runtime startup without cascade), validation is skipped —
  // the user may supply required config at runtime via env vars or CLI flags.
  const hasResolvedConfigMap = opts.resolvedConfigMap !== undefined;
  const overrideMcpHealthToStdioPing = opts.overrideMcpHealthToStdioPing ?? false;
  const activated: ActivatedHandle[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  const errors: Array<{ key: string; error: unknown }> = [];

  // 1. Read lockfile
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

  // 2. Process each resolved entry
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
  // Extract base id (strip @version suffix)
  const baseId = key.includes('@') ? key.slice(0, key.lastIndexOf('@')) : key;

  // Gap C5 hygiene: check if disabled in scope config
  if (ctx.enabledOverrides[baseId] === false || ctx.enabledOverrides[key] === false) {
    return { type: 'skipped', reason: 'disabled in scope config' };
  }

  // Resolve extension directory from the lockfile source
  const extDir = resolveExtensionDir(entry.source, ctx.root);
  if (!extDir) {
    return { type: 'skipped', reason: `cannot resolve extension directory from source: ${entry.source}` };
  }

  // Load manifest
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

  // Skip install-only types (bundle, prompt)
  if (INSTALL_ONLY_TYPES.has(extType)) {
    return { type: 'skipped', reason: `type '${extType}' is install-time-only, not a runtime type` };
  }

  // Resolve built entrypoint path
  if (!manifest.entrypoint) {
    return { type: 'skipped', reason: 'manifest has no entrypoint declared' };
  }

  const entrypointPath = path.resolve(extDir, manifest.entrypoint);

  // Gap C5 hygiene: skip if built entrypoint is missing (stale after uninstall)
  if (!fs.existsSync(entrypointPath)) {
    return {
      type: 'skipped',
      reason: `built entrypoint not found at ${entrypointPath} (stale lockfile entry — run 'sox install' to refresh)`,
    };
  }

  // P5: validateConfigAgainstSchema with cascade-resolved config (closes Gap F3 / PB enforcement).
  // Only run when a resolved config map was explicitly provided — if absent, the runtime
  // is being loaded without cascade context (e.g. during 'sox start') and required fields
  // will be supplied at tool-call time. Skip validation to avoid false positives.
  if (manifest.config_schema && ctx.hasResolvedConfigMap) {
    // Look up cascade-resolved config for this extension (by baseId)
    const resolvedEntry = ctx.resolvedConfigMap[baseId] ?? ctx.resolvedConfigMap[key];
    const resolvedConfig = resolvedEntry?.config ?? {};

    const diags = validateConfigAgainstSchema(resolvedConfig, manifest.config_schema, baseId, manifestPath);
    const configErrors = diags.filter((d) => d.severity === 'error');
    if (configErrors.length > 0) {
      const messages = configErrors.map((d) => d.message).join('; ');
      return {
        type: 'skipped',
        reason: `config_schema validation failed — ${messages}`,
      };
    }
    if (diags.length > 0) {
      for (const d of diags) {
        console.warn(`[loader] "${key}" config warning: ${d.message}`);
      }
    }
    console.log(
      `[loader] "${key}": config_schema validation passed (cascade-resolved config, ${Object.keys(resolvedConfig).length} key(s))`,
    );
  }

  // P5: Begin honoring permissions at the activation boundary.
  // fs/network/socket enforcement: for process-type extensions (mcp-server), permissions are
  // enforced by passing env vars that can gate access. For in-process types (hook/agent/skill/
  // command), enforcement is advisory at this phase — declared permissions are recorded and
  // will be enforced by the per-type sandbox layer in a future iteration.
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

  // Dispatch to per-type adapter
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
      // Build effective lifecycle — override health type for stdio MCP servers when requested.
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
      // Derive verb from invocation.verb or strip @version from key
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
 * Resolve the extension directory from a lockfile source string.
 *
 * Supported source formats:
 *   - file:///absolute/path/to/extension/dir     → /absolute/path/to/extension/dir
 *   - file:///absolute/path/to/extension/src/index.ts → strip /src/index.ts → /absolute/path
 *   - /absolute/path                              → /absolute/path
 *   - npm:// and other remote sources: return null (not yet downloadable by loader — P5 scope)
 */
export function resolveExtensionDir(source: string, _root: string): string | null {
  if (source.startsWith('file://')) {
    let p = source.slice('file://'.length);
    // Remove /src/index.ts or /dist/index.js suffix if present
    p = stripKnownSuffix(p);
    // Normalize tilde (shouldn't appear in lockfile sources but be safe)
    if (p.startsWith('~')) {
      p = path.join(os.homedir(), p.slice(1));
    }
    // If it's a directory, use it directly; if it's a file, use its parent
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      return p;
    }
    const parent = path.dirname(p);
    if (fs.existsSync(parent) && fs.statSync(parent).isDirectory()) {
      return parent;
    }
    return p; // Let the caller decide if it's missing
  }

  if (path.isAbsolute(source)) {
    return source;
  }

  // npm:// and other remote schemes: not supported in P4
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
