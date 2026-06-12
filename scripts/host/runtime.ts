/**
 * scripts/host/runtime.ts — sox host runtime manager.
 *
 * Bridges the install (lockfile) and the live runtime:
 *   - startRuntime(): call loadFromLockfile, activate every installed+enabled extension,
 *     persist the runtime record so other commands can see what's running.
 *   - stopRuntime(): gracefully stop all supervised processes, update runtime record.
 *   - getRuntimeRecord(): read the current runtime record without side effects.
 *   - stopExtension(): stop one extension by id (for disable/uninstall workflows).
 *
 * Runtime record location (per-scope, overridable):
 *   Default: <scope-lockfile-dir>/runtime.json  (e.g. .extensions/runtime.json)
 *   Override: SOX_RUNTIME_FILE env var or explicit runtimeFilePath option.
 *
 * Singleton guarantee: startRuntime() is idempotent within a process — calling it
 *   twice for the same scope reads the existing runtime record and returns without
 *   double-spawning (the supervisor's own singleton enforcement also catches this).
 *
 * Design: thin orchestration layer on top of scripts/host/loader.ts +
 *   scripts/host/supervisor.ts + scripts/host/registrar.ts. Does NOT rewrite those.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadFromLockfile, type LoaderResult } from './loader.js';
import { McpRegistrar } from './registrar.js';
import type { McpAdapterHandle } from './adapters/mcp.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RuntimeEntry {
  /** Extension key (id@version from lockfile). */
  key: string;
  /** Base id (strip @version). */
  id: string;
  /** Extension type (mcp-server, hook, agent, etc.). */
  type: string;
  /** Scope the extension was started in. */
  scope: string;
  /** Source from the lockfile entry. */
  source: string;
  /** PID of the supervised process (for mcp-server type). null for in-process types. */
  pid: number | null;
  /** Whether the process is currently running/healthy. */
  running: boolean;
  /** ISO timestamp when this entry was activated. */
  activatedAt: string;
  /** The health endpoint (for mcp-server type). */
  healthEndpoint?: string | undefined;
}

export interface RuntimeRecord {
  version: 1;
  scope: string;
  startedAt: string;
  entries: RuntimeEntry[];
  /** PID of the long-lived supervisor process (runtime-cli start). Teardown signals THIS, not children. */
  supervisorPid?: number | undefined;
}

export interface StartRuntimeOptions {
  /** Scope name (user | project | local). */
  scope: string;
  /** Absolute path to the scope's lockfile. */
  lockfilePath: string;
  /** Absolute path to the scope's config. */
  configPath: string;
  /** Where to persist the runtime record. */
  runtimeFilePath: string;
  /** Root directory for resolving extension dirs. */
  root: string;
  /**
   * Extra env vars forwarded to spawned processes.
   */
  env?: Record<string, string> | undefined;
  /**
   * When true, override health check type to 'stdio-ping' for all MCP servers.
   * This is needed when the manifest's health.endpoint points to a socket that
   * the stdio MCP server does not create (e.g. memoryd.sock is only for the daemon).
   */
  overrideHealthToStdioPing?: boolean | undefined;
}

export interface StopRuntimeOptions {
  /** Scope name. */
  scope: string;
  /** Where the runtime record lives. */
  runtimeFilePath: string;
  /** Specific extension id to stop (if absent, stop all). */
  id?: string | undefined;
}

// ─── In-process state ─────────────────────────────────────────────────────────

// Maps runtimeFilePath → { loaderResult, registrar } for the current process.
// This allows stop to find the same supervisor objects that start created.
const _activeRuntimes = new Map<string, {
  loaderResult: LoaderResult;
  registrar: McpRegistrar;
}>();

// ─── Start ────────────────────────────────────────────────────────────────────

/**
 * Start the runtime for a scope.
 *
 * 1. Read the runtime record. If entries are already running (same process), return early.
 * 2. Load the lockfile via loadFromLockfile.
 * 3. For each mcp-server handle, register it with McpRegistrar.
 * 4. Write the runtime record.
 */
export async function startRuntime(opts: StartRuntimeOptions): Promise<RuntimeRecord> {
  // Idempotency: if we already have a runtime in this process for this file, return it.
  const existing = _activeRuntimes.get(opts.runtimeFilePath);
  if (existing) {
    console.log(`[runtime] Already started for ${opts.scope} (idempotent — returning existing runtime)`);
    return readRuntimeRecord(opts.runtimeFilePath) ?? buildEmptyRecord(opts.scope);
  }

  // Read enabled overrides from config
  const enabledOverrides = readEnabledOverrides(opts.configPath);

  // Load lockfile source map for scope/source info
  const sourceMap = readLockfileSourceMap(opts.lockfilePath);

  // Override lifecycle health for stdio MCP servers if requested
  const loaderEnv = opts.env ?? {};

  const loaderResult = await loadFromLockfile({
    lockfilePath: opts.lockfilePath,
    root: opts.root,
    env: loaderEnv,
    enabledOverrides,
    // Override health type to 'stdio-ping' for stdio MCP servers.
    // The manifest health.endpoint may point to a daemon socket (memoryd.sock) that
    // the stdio MCP server never creates. 'stdio-ping' means: is the process alive?
    overrideMcpHealthToStdioPing: opts.overrideHealthToStdioPing ?? true,
  });

  console.log(
    `[runtime] Activated ${loaderResult.activated.length} extension(s), ` +
    `skipped ${loaderResult.skipped.length}, errors ${loaderResult.errors.length}`,
  );

  // For each activated mcp-server: if overrideHealthToStdioPing is requested,
  // the supervisor was already started with the original health config.
  // For the runtime record we just record what's running.

  const registrar = new McpRegistrar();

  // Register MCP servers with the registrar
  for (const handle of loaderResult.activated) {
    if (handle.type === 'mcp-server') {
      const mcpHandle = handle as McpAdapterHandle;
      const pid = mcpHandle.supervisor.pid();
      if (pid !== null) {
        try {
          // Get the child process from the supervisor for registrar
          // The supervisor holds the ChildProcess; we access it via a helper
          const proc = getProcessFromSupervisor(mcpHandle.supervisor);
          if (proc) {
            await registrar.register(mcpHandle.key, proc);
          }
        } catch (e) {
          console.warn(`[runtime] Failed to register ${mcpHandle.key} with MCP registrar: ${String(e)}`);
        }
      }
    }
  }

  // Build runtime record
  const now = new Date().toISOString();
  const entries: RuntimeEntry[] = [];

  for (const handle of loaderResult.activated) {
    const key = handle.key;
    const baseId = key.includes('@') ? key.slice(0, key.lastIndexOf('@')) : key;
    const source = sourceMap[key] ?? sourceMap[`${baseId}@`] ?? '';

    let pid: number | null = null;
    let running = false;

    if (handle.type === 'mcp-server') {
      const mcpHandle = handle as McpAdapterHandle;
      pid = mcpHandle.supervisor.pid();
      running = mcpHandle.supervisor.isHealthy() || pid !== null;
    } else {
      // In-process types (hook, agent, skill, command) are always "running" once activated
      running = true;
    }

    entries.push({
      key,
      id: baseId,
      type: handle.type,
      scope: opts.scope,
      source,
      pid,
      running,
      activatedAt: now,
    });
  }

  const record: RuntimeRecord = {
    version: 1,
    scope: opts.scope,
    startedAt: now,
    entries,
    // The current process is the long-lived supervisor (runtime-cli start keeps it alive).
    // Teardown (stop/disable/uninstall) signals THIS pid so the supervisor tears down its
    // children cleanly (and does not fight them with restarts).
    supervisorPid: process.pid,
  };

  writeRuntimeRecord(opts.runtimeFilePath, record);

  _activeRuntimes.set(opts.runtimeFilePath, { loaderResult, registrar });

  console.log(`[runtime] Runtime record written to ${opts.runtimeFilePath}`);
  return record;
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

/**
 * Stop the runtime (all or one extension).
 *
 * Finds supervised processes from in-process state and calls supervisor.stop().
 * Updates the runtime record to reflect the stopped state.
 */
export async function stopRuntime(opts: StopRuntimeOptions): Promise<void> {
  const active = _activeRuntimes.get(opts.runtimeFilePath);
  const record = readRuntimeRecord(opts.runtimeFilePath);

  if (!active && !record) {
    console.log(`[runtime] No active runtime for ${opts.scope}`);
    return;
  }

  if (active) {
    const { loaderResult, registrar } = active;

    for (const handle of loaderResult.activated) {
      const baseId = handle.key.includes('@')
        ? handle.key.slice(0, handle.key.lastIndexOf('@'))
        : handle.key;

      // If a specific id was requested, skip others
      if (opts.id && baseId !== opts.id && handle.key !== opts.id) continue;

      if (handle.type === 'mcp-server') {
        const mcpHandle = handle as McpAdapterHandle;
        try {
          registrar.deregister(handle.key);
          await mcpHandle.supervisor.stop();
          console.log(`[runtime] Stopped ${handle.key}`);
        } catch (e) {
          console.warn(`[runtime] Error stopping ${handle.key}: ${String(e)}`);
        }
      }
    }

    if (!opts.id) {
      _activeRuntimes.delete(opts.runtimeFilePath);
    }
  }

  // Update the runtime record
  if (record) {
    if (opts.id) {
      for (const entry of record.entries) {
        if (entry.id === opts.id || entry.key === opts.id) {
          entry.running = false;
          entry.pid = null;
        }
      }
    } else {
      for (const entry of record.entries) {
        entry.running = false;
        entry.pid = null;
      }
    }
    writeRuntimeRecord(opts.runtimeFilePath, record);
  }
}

/**
 * Stop a single extension by id.
 * Called by `disable` and `uninstall` to stop a running extension.
 */
export async function stopExtension(runtimeFilePath: string, id: string): Promise<boolean> {
  const active = _activeRuntimes.get(runtimeFilePath);
  if (!active) {
    // Try to kill by PID from the runtime record
    const record = readRuntimeRecord(runtimeFilePath);
    if (!record) return false;

    const entry = record.entries.find((e) => e.id === id || e.key === id);
    if (!entry || !entry.running) return false;

    if (entry.pid !== null) {
      try {
        process.kill(entry.pid, 'SIGTERM');
        console.log(`[runtime] Sent SIGTERM to pid ${entry.pid} for ${id}`);
        // Mark stopped in record
        entry.running = false;
        entry.pid = null;
        writeRuntimeRecord(runtimeFilePath, record);
        return true;
      } catch (e) {
        console.warn(`[runtime] Could not kill pid ${String(entry.pid)}: ${String(e)}`);
        entry.running = false;
        entry.pid = null;
        writeRuntimeRecord(runtimeFilePath, record);
        return false;
      }
    }
    return false;
  }

  // In-process: find the handle and stop it
  const { loaderResult, registrar } = active;
  for (const handle of loaderResult.activated) {
    const baseId = handle.key.includes('@') ? handle.key.slice(0, handle.key.lastIndexOf('@')) : handle.key;
    if (baseId !== id && handle.key !== id) continue;

    if (handle.type === 'mcp-server') {
      const mcpHandle = handle as McpAdapterHandle;
      try {
        registrar.deregister(handle.key);
        await mcpHandle.supervisor.stop();
        console.log(`[runtime] Stopped ${handle.key}`);
        // Update record
        const record = readRuntimeRecord(runtimeFilePath);
        if (record) {
          const entry = record.entries.find((e) => e.id === id || e.key === handle.key);
          if (entry) { entry.running = false; entry.pid = null; }
          writeRuntimeRecord(runtimeFilePath, record);
        }
        return true;
      } catch (e) {
        console.warn(`[runtime] Error stopping ${handle.key}: ${String(e)}`);
      }
    }
  }
  return false;
}

/**
 * Reconcile running extensions against the current config.
 *
 * Stops any activated extension that is NO LONGER in the config's "should-run" set
 * (i.e. it was disabled — `enabled:false` — or removed from `install[]` entirely).
 * Because this runs IN the supervisor process, it calls `supervisor.stop()` directly,
 * which sets the supervisor's `_stopping` flag — so the child is stopped and NOT restarted.
 *
 * Triggered by the supervisor's SIGHUP handler, which `sox disable`/`uninstall` raise
 * after they update the config. Returns the list of ids stopped.
 */
export async function reconcileRuntime(
  runtimeFilePath: string,
  configPath: string,
): Promise<string[]> {
  const active = _activeRuntimes.get(runtimeFilePath);
  if (!active) return [];

  const shouldRun = readShouldRunSet(configPath);
  const record = readRuntimeRecord(runtimeFilePath);
  const stopped: string[] = [];

  for (const handle of active.loaderResult.activated) {
    const baseId = handle.key.includes('@')
      ? handle.key.slice(0, handle.key.lastIndexOf('@'))
      : handle.key;
    if (shouldRun.has(baseId)) continue; // still wanted — leave running

    if (handle.type === 'mcp-server') {
      const mcpHandle = handle as McpAdapterHandle;
      try {
        active.registrar.deregister(handle.key);
        await mcpHandle.supervisor.stop(); // sets _stopping → no restart
      } catch (e) {
        console.warn(`[runtime] reconcile: error stopping ${handle.key}: ${String(e)}`);
      }
    }
    if (record) {
      const entry = record.entries.find((e) => e.id === baseId || e.key === handle.key);
      if (entry) {
        entry.running = false;
        entry.pid = null;
      }
    }
    stopped.push(baseId);
  }

  if (record) writeRuntimeRecord(runtimeFilePath, record);
  return stopped;
}

/** The set of extension ids that SHOULD be running per config (present + not disabled). */
function readShouldRunSet(configPath: string): Set<string> {
  const set = new Set<string>();
  if (!fs.existsSync(configPath)) return set;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      install?: Array<{ id: string; enabled?: boolean }>;
    };
    for (const e of raw.install ?? []) {
      if (e.enabled !== false) set.add(e.id);
    }
  } catch {
    /* ignore malformed config */
  }
  return set;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read the current runtime record for a scope without side effects.
 */
export function getRuntimeRecord(runtimeFilePath: string): RuntimeRecord | null {
  return readRuntimeRecord(runtimeFilePath);
}

/**
 * Get the McpRegistrar for a running runtime (for tool calls).
 */
export function getRegistrar(runtimeFilePath: string): McpRegistrar | null {
  return _activeRuntimes.get(runtimeFilePath)?.registrar ?? null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readRuntimeRecord(filePath: string): RuntimeRecord | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RuntimeRecord;
  } catch {
    return null;
  }
}

function writeRuntimeRecord(filePath: string, record: RuntimeRecord): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n', 'utf8');
}

function buildEmptyRecord(scope: string): RuntimeRecord {
  return {
    version: 1,
    scope,
    startedAt: new Date().toISOString(),
    entries: [],
  };
}

function readEnabledOverrides(configPath: string): Record<string, boolean> {
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      install?: Array<{ id: string; enabled?: boolean }>;
    };
    const overrides: Record<string, boolean> = {};
    for (const entry of raw.install ?? []) {
      if (entry.enabled === false) {
        overrides[entry.id] = false;
      }
    }
    return overrides;
  } catch {
    return {};
  }
}

function readLockfileSourceMap(lockfilePath: string): Record<string, string> {
  if (!fs.existsSync(lockfilePath)) return {};
  try {
    const lock = JSON.parse(fs.readFileSync(lockfilePath, 'utf8')) as {
      resolved?: Record<string, { source: string }>;
    };
    const map: Record<string, string> = {};
    for (const [key, entry] of Object.entries(lock.resolved ?? {})) {
      map[key] = entry.source;
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Get the ChildProcess from a ProcessSupervisor via the internal _proc field.
 * This is a deliberate internal access — the runtime is the one orchestration
 * layer that needs the process handle for MCP protocol registration.
 *
 * We use a type cast rather than modifying the supervisor's public API to avoid
 * breaking other callers.
 */
function getProcessFromSupervisor(
  supervisor: import('./supervisor.js').ProcessSupervisor,
): import('node:child_process').ChildProcess | null {
  // Access internal _proc field. The supervisor doesn't expose this publicly.
  const internal = supervisor as unknown as { _proc: import('node:child_process').ChildProcess | null };
  return internal['_proc'];
}

/**
 * Derive runtime file path from lockfile path (sibling in same directory).
 */
export function runtimeFilePathFromLockfile(lockfilePath: string): string {
  return path.join(path.dirname(lockfilePath), 'runtime.json');
}

/**
 * Derive runtime file path from scope (for CLI use).
 * Respects SOX_RUNTIME_FILE env override.
 */
export function getRuntimeFilePath(scopeLockfilePath: string): string {
  const envOverride = process.env['SOX_RUNTIME_FILE'];
  if (envOverride) return path.resolve(envOverride);
  return runtimeFilePathFromLockfile(scopeLockfilePath);
}

// ─── Scope paths helper (mirrors bin/sox getScopePaths) ───────────────────────

export function getScopePaths(
  scope: string,
  root: string,
): { config: string; lockfile: string } {
  const homedir = os.homedir();
  switch (scope) {
    case 'user':
      return {
        config: path.join(homedir, '.config', 'extensions', 'extensions.json'),
        lockfile: path.join(homedir, '.config', 'extensions', 'extensions.lock'),
      };
    case 'project':
      return {
        config: path.join(root, '.extensions', 'extensions.json'),
        lockfile: path.join(root, '.extensions', 'extensions.lock'),
      };
    case 'local':
      return {
        config: path.join(root, '.extensions', 'extensions.local.json'),
        lockfile: path.join(root, '.extensions', 'extensions.local.lock'),
      };
    default:
      throw new Error(`[runtime] Unknown scope '${scope}'. Valid: user, project, local`);
  }
}
