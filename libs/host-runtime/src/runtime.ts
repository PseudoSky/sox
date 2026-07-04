/**
 * libs/host-runtime/src/runtime.ts — soxe host runtime manager.
 *
 * Ported from the pre-nx host runtime. Imports adapted for lib-relative paths.
 * [def:session-fixes] stop-via-supervisor: supervisor.stop() prevents restart on teardown.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpAdapterHandle } from './adapters/mcp.js';
import { logDirFor, scopeConfigPaths, socketDir, type DataScope } from './data-paths.js';
import { loadFromLockfile, type LoaderResult } from './loader.js';
import { acquireStartLock, computeSupervisorId } from './lock.js';
import { identityToken, killAndVerify, reapByIdentity, reapBySource, type KillOutcome } from './reaper.js';
import { McpRegistrar } from './registrar.js';
import { deregisterSupervisor, readSupervisorsFile, registerSupervisor } from './registry.js';

export interface RuntimeEntry {
  key: string;
  id: string;
  type: string;
  scope: string;
  source: string;
  pid: number | null;
  running: boolean;
  activatedAt: string;
  healthEndpoint?: string | undefined;
}

export interface RuntimeRecord {
  version: 1;
  scope: string;
  startedAt: string;
  entries: RuntimeEntry[];
  supervisorPid?: number | undefined;
  /**
   * Path to the exec control socket opened by the supervisor process.
   * [inv:exec-socket]: present only in supervisor mode (lockfile-based start);
   * absent in service mode (detached spawn) and on old runtime records.
   * soxe exec connects here to route tool calls through the live session.
   */
  execSocketPath?: string | undefined;
}

export interface StartRuntimeOptions {
  scope: string;
  lockfilePath: string;
  configPath: string;
  runtimeFilePath: string;
  root: string;
  env?: Record<string, string> | undefined;
  overrideHealthToStdioPing?: boolean | undefined;
  /**
   * When set, only activate extensions whose id matches one of the provided ids.
   * All other lockfile entries are skipped. Used by `soxe start --id=<ext>`.
   */
  filterIds?: string[] | undefined;
}

export interface StopRuntimeOptions {
  scope: string;
  runtimeFilePath: string;
  id?: string | undefined;
}

const _activeRuntimes = new Map<string, {
  loaderResult: LoaderResult;
  registrar: McpRegistrar;
  execServer?: net.Server | undefined;
  execSocketPath?: string | undefined;
}>();

export async function startRuntime(opts: StartRuntimeOptions): Promise<RuntimeRecord> {
  const existing = _activeRuntimes.get(opts.runtimeFilePath);
  if (existing) {
    console.log(`[runtime] Already started for ${opts.scope} (idempotent — returning existing runtime)`);
    return readRuntimeRecord(opts.runtimeFilePath) ?? buildEmptyRecord(opts.scope);
  }

  // ── Concurrent-start lock (R3) ────────────────────────────────────────────
  // Acquired as the very first action. Released after writeRuntimeRecord writes
  // the final runtime record with execSocketPath set, at which point subsequent
  // startRuntime calls see the idempotent guard above.
  const supervisorId = computeSupervisorId(opts.scope, opts.root);
  const lock = acquireStartLock(supervisorId);

  try {
    return await _startRuntimeLocked(opts, supervisorId, lock);
  } catch (e) {
    lock.release();
    throw e;
  }
}

async function _startRuntimeLocked(
  opts: StartRuntimeOptions,
  supervisorId: string,
  lock: { release: () => void },
): Promise<RuntimeRecord> {
  const enabledOverrides = readEnabledOverrides(opts.configPath);
  const sourceMap = readLockfileSourceMap(opts.lockfilePath);
  const loaderEnv = opts.env ?? {};

  // R4: log directory for this supervisor's extensions (ADR-0004 §D2: under run/).
  const logDir = logDirFor(supervisorId);

  const loaderResult = await loadFromLockfile({
    lockfilePath: opts.lockfilePath,
    root: opts.root,
    env: loaderEnv,
    enabledOverrides,
    // Default false — honour the extension's declared health.type.
    // Callers that need test-mode override (e.g. test harnesses without a live daemon)
    // can pass overrideHealthToStdioPing: true explicitly.
    overrideMcpHealthToStdioPing: opts.overrideHealthToStdioPing ?? false,
    logDir,
    ...(opts.filterIds !== undefined ? { filterIds: opts.filterIds } : {}),
  });

  console.log(
    `[runtime] Activated ${loaderResult.activated.length} extension(s), ` +
    `skipped ${loaderResult.skipped.length}, errors ${loaderResult.errors.length}`,
  );

  const registrar = new McpRegistrar();

  for (const handle of loaderResult.activated) {
    if (handle.type === 'mcp-server') {
      const mcpHandle = handle as McpAdapterHandle;
      const pid = mcpHandle.supervisor.pid();
      if (pid !== null) {
        try {
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
    supervisorPid: process.pid,
  };

  writeRuntimeRecord(opts.runtimeFilePath, record);

  // ── Exec control socket ────────────────────────────────────────────────────
  // [inv:exec-socket]: The supervisor opens a Unix domain socket so that
  // `soxe exec` (a separate process) can route tool calls through the live
  // McpRegistrar session rather than spawning a throwaway process.
  // Protocol: client sends one JSON line → server replies one JSON line → close.
  // Request:  { "ext": string, "tool": string, "args": object }
  // Response: { "result": McpCallResult } | { "error": string }
  //
  // Add-2: Canonical socket path under the user data root's run/supervisors/ dir
  // (ADR-0004 §D2) — avoids polluting project directories and is discoverable from
  // the global supervisor registry (R1/P4).
  const sockDir = socketDir();
  fs.mkdirSync(sockDir, { recursive: true });
  const execSocketPath = path.join(sockDir, `${supervisorId}.sock`);
  // Remove stale socket file from a previous (unclean) shutdown.
  try { if (fs.existsSync(execSocketPath)) fs.unlinkSync(execSocketPath); } catch { /* ignore */ }

  const execServer = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return; // wait for complete line
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);

      let req: { ext?: unknown; tool?: unknown; args?: unknown; list?: unknown };
      try {
        req = JSON.parse(line) as typeof req;
      } catch {
        socket.write(JSON.stringify({ error: 'invalid JSON request' }) + '\n');
        socket.end();
        return;
      }

      const ext = typeof req.ext === 'string' ? req.ext : '';
      const tool = typeof req.tool === 'string' ? req.tool : '';
      const args = (req.args !== null && typeof req.args === 'object' && !Array.isArray(req.args))
        ? req.args as Record<string, unknown>
        : {};

      // ── List request: { list: true } or { ext: "...", list: true } ────────────
      // Returns all registrar-cached tool descriptors (name, description, inputSchema)
      // without spawning any process.  Used by `soxe exec --list`.
      if (req.list === true) {
        const active2 = _activeRuntimes.get(opts.runtimeFilePath);
        if (!active2) {
          socket.write(JSON.stringify({ error: 'runtime not active' }) + '\n');
          socket.end();
          return;
        }
        const allRegs = active2.registrar.registrations();
        type ExtEntry = {
          key: string;
          id: string;
          serverInfo: { name: string; version: string };
          live: boolean;
          tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
        };
        let extensions: ExtEntry[];
        if (ext) {
          const allKeys2 = allRegs.map((r) => r.serverKey);
          const resolvedKey2 = allKeys2.includes(ext)
            ? ext
            : (allKeys2.find((k) => k.startsWith(`${ext}@`)) ?? ext);
          const reg2 = allRegs.find((r) => r.serverKey === resolvedKey2);
          extensions = reg2
            ? [{ key: reg2.serverKey, id: ext, serverInfo: reg2.serverInfo, live: reg2.live, tools: reg2.tools as ExtEntry['tools'] }]
            : [];
        } else {
          extensions = allRegs.map((reg2) => ({
            key: reg2.serverKey,
            id: reg2.serverKey.includes('@')
              ? reg2.serverKey.slice(0, reg2.serverKey.lastIndexOf('@'))
              : reg2.serverKey,
            serverInfo: reg2.serverInfo,
            live: reg2.live,
            tools: reg2.tools as ExtEntry['tools'],
          }));
        }
        socket.write(JSON.stringify({ result: { extensions } }) + '\n');
        socket.end();
        return;
      }

      if (!ext || !tool) {
        socket.write(JSON.stringify({ error: 'request must include ext and tool fields' }) + '\n');
        socket.end();
        return;
      }

      const active = _activeRuntimes.get(opts.runtimeFilePath);
      if (!active) {
        socket.write(JSON.stringify({ error: 'runtime not active' }) + '\n');
        socket.end();
        return;
      }

      // Resolve the registrar key: callers pass the bare id (e.g. "memory-server")
      // but the registrar stores versioned keys (e.g. "memory-server@0.1.0").
      // Try exact match first, then fall back to the first key that starts with "<ext>@".
      const allKeys = active.registrar.registrations().map((r) => r.serverKey);
      const resolvedKey = allKeys.includes(ext)
        ? ext
        : (allKeys.find((k) => k.startsWith(`${ext}@`)) ?? ext);

      active.registrar.call(resolvedKey, tool, args)
        .then((result) => {
          socket.write(JSON.stringify({ result }) + '\n');
          socket.end();
        })
        .catch((e: unknown) => {
          socket.write(JSON.stringify({ error: String(e) }) + '\n');
          socket.end();
        });
    });

    socket.on('error', (e) => {
      console.warn(`[runtime] exec socket client error: ${String(e)}`);
    });
  });

  execServer.on('error', (e) => {
    console.warn(`[runtime] exec socket server error (exec will fall back to spawn): ${String(e)}`);
  });

  // Await the listen so execSocketPath is in runtime.json before startRuntime() returns.
  // On Unix domain sockets the listen callback fires synchronously within the same
  // event-loop tick once the file descriptor is bound — the await is nearly free but
  // eliminates the race where a caller reads runtime.json before the callback fires.
  // Lock (R3) is released here — after the final writeRuntimeRecord that includes
  // execSocketPath. At this point the idempotent guard in startRuntime() will fire
  // for any concurrent caller that was spin-waiting.
  await new Promise<void>((resolve, reject) => {
    execServer.once('error', reject);
    execServer.listen(execSocketPath, () => {
      console.log(`[runtime] Exec socket listening at ${execSocketPath}`);
      record.execSocketPath = execSocketPath;
      writeRuntimeRecord(opts.runtimeFilePath, record);
      lock.release();
      resolve();
    });
  });

  _activeRuntimes.set(opts.runtimeFilePath, { loaderResult, registrar, execServer, execSocketPath });

  // ── R1: Self-registration in global supervisor registry ────────────────────
  // Called after exec socket is listening and runtime.json is written, so the
  // entry is immediately usable by `soxe list --all` and `soxe stop` (daemon mode).
  try {
    registerSupervisor({
      supervisorId,
      scope: opts.scope,
      root: opts.root,
      pid: process.pid,
      runtimeFilePath: opts.runtimeFilePath,
      execSocketPath,
      logDir,
      startedAt: now,
      hostname: os.hostname(),
    });
    console.log(`[runtime] Registered supervisor ${supervisorId} in global registry`);
  } catch (e) {
    // Registration failure is non-fatal — the supervisor is running; the registry
    // is best-effort. Log the warning and continue.
    console.warn(`[runtime] Warning: could not register in global registry: ${String(e)}`);
  }

  console.log(`[runtime] Runtime record written to ${opts.runtimeFilePath}`);
  return record;
}

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
      // Close exec control socket and remove socket file.
      if (active.execServer) {
        active.execServer.close();
        try {
          const sockPath = active.execSocketPath;
          if (sockPath && fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
        } catch { /* ignore */ }
      }
      _activeRuntimes.delete(opts.runtimeFilePath);

      // ── R1: Self-deregistration from global supervisor registry ─────────────
      // Called after all extensions are stopped and the exec socket is closed.
      // Looks up the supervisorId by matching runtimeFilePath in the registry,
      // then removes that entry. Best-effort — failure does not fail the stop.
      try {
        const registryFile = readSupervisorsFile();
        const regEntry = registryFile.supervisors.find((e) => e.runtimeFilePath === opts.runtimeFilePath);
        if (regEntry) {
          deregisterSupervisor(regEntry.supervisorId);
          console.log(`[runtime] Deregistered supervisor ${regEntry.supervisorId} from global registry`);
        }
      } catch (e) {
        console.warn(`[runtime] Warning: could not deregister from global registry: ${String(e)}`);
      }
    }
  }

  if (record) {
    // ── BL-31: verified kill + escalation + orphan reaping ───────────────────
    // This is the NON-active path: a fresh CLI process (each `soxe stop` is its
    // own process) with no in-memory supervisor. The pre-fix code sent SIGTERM
    // and immediately set running=false — fire-and-forget, no verification, no
    // SIGKILL escalation, no way to find a detached PPID-1 orphan. We now:
    //   1. For every targeted tracked pid: killAndVerify (SIGTERM → poll → SIGKILL).
    //   2. Reap any orphan matching the extension's entrypoint identity, even
    //      when it is detached (PPID 1) and/or absent from runtime.json.
    const targets = opts.id
      ? record.entries.filter((e) => e.id === opts.id || e.key === opts.id)
      : record.entries;

    for (const entry of targets) {
      if (typeof entry.pid === 'number') {
        const outcome = await killAndVerify(entry.pid, {
          log: (m) => console.log(`[runtime] stop ${entry.id}: ${m}`),
        });
        reportKillOutcome(entry.id, entry.pid, outcome);
      }
      // Reap orphans by identity (store path / entrypoint), regardless of
      // whether the tracked pid existed — the orphan may have a different pid
      // than runtime.json last recorded (e.g. a respawn after supervisor death).
      if (entry.source) {
        const reap = await reapBySource(entry.source, {
          excludePids: typeof entry.pid === 'number' ? [entry.pid] : [],
          log: (m) => console.log(`[runtime] reap ${entry.id}: ${m}`),
        });
        for (const k of reap.killed) {
          reportKillOutcome(
            `${entry.id} (orphan${k.orphaned ? ', PPID 1' : ''})`,
            k.pid,
            k.outcome,
          );
        }
      }
      entry.running = false;
      entry.pid = null;
    }
    writeRuntimeRecord(opts.runtimeFilePath, record);
  }
}

/** Log a per-process kill outcome honestly. 'undead' is surfaced as an error. */
function reportKillOutcome(label: string, pid: number, outcome: KillOutcome): void {
  switch (outcome) {
    case 'already-dead':
      console.log(`[runtime] ${label} (pid=${pid}) already dead — no-op`);
      break;
    case 'term':
      console.log(`[runtime] ${label} (pid=${pid}) exited after SIGTERM`);
      break;
    case 'kill':
      console.log(`[runtime] ${label} (pid=${pid}) survived SIGTERM → killed with SIGKILL`);
      break;
    case 'undead':
      console.error(
        `[runtime] CRITICAL: ${label} (pid=${pid}) could not be killed even with SIGKILL ` +
        `(uninterruptible sleep / EPERM). Manual intervention required.`,
      );
      break;
  }
}

export async function stopExtension(runtimeFilePath: string, id: string): Promise<boolean> {
  const active = _activeRuntimes.get(runtimeFilePath);
  if (!active) {
    const record = readRuntimeRecord(runtimeFilePath);
    if (!record) return false;

    const entry = record.entries.find((e) => e.id === id || e.key === id);
    if (!entry) return false;

    // BL-31: verified kill + orphan reaping (non-active path). Even when the
    // tracked entry is already running=false, an orphan may still survive — so
    // we always run the identity reap.
    let allDead = true;

    if (typeof entry.pid === 'number') {
      const outcome = await killAndVerify(entry.pid, {
        log: (m) => console.log(`[runtime] stop ${id}: ${m}`),
      });
      reportKillOutcome(id, entry.pid, outcome);
      if (outcome === 'undead') allDead = false;
    }

    if (entry.source) {
      const reap = await reapBySource(entry.source, {
        excludePids: typeof entry.pid === 'number' ? [entry.pid] : [],
        log: (m) => console.log(`[runtime] reap ${id}: ${m}`),
      });
      for (const k of reap.killed) {
        reportKillOutcome(`${id} (orphan${k.orphaned ? ', PPID 1' : ''})`, k.pid, k.outcome);
        if (k.outcome === 'undead') allDead = false;
      }
    }

    entry.running = false;
    entry.pid = null;
    writeRuntimeRecord(runtimeFilePath, record);
    return allDead;
  }

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

export interface ReapExtensionResult {
  id: string;
  /** The entrypoint identity token used to match the process table. */
  token: string;
  /** Per-process kill outcomes for everything matched. Empty = nothing found. */
  killed: Array<{ pid: number; ppid: number; orphaned: boolean; outcome: KillOutcome }>;
}

/**
 * BL-31 orphan reaper — the supervisor-independent path.
 *
 * Finds and kills any process running an extension's entrypoint, by matching the
 * OS process table against the entrypoint identity resolved from the lockfile
 * (and/or runtime.json) — even when the supervisor is gone, the process is
 * detached (PPID 1), and the runtime record has been cleaned. This is exactly
 * the failure mode in BL-31: `soxe stop` could only signal a tracked pid and had
 * no way to find a daemon by *what it is*.
 *
 * Resolution order for the identity token:
 *   1. runtime.json entry.source for the id (most authoritative when present).
 *   2. lockfile `resolved[<id|id@ver>].source`.
 * The token is a precise entrypoint path, so an unrelated `node` process is never
 * killed (see argvContainsToken in reaper.ts).
 *
 * @param lockfilePath  path to extensions.lock (for source resolution); optional.
 * @param runtimeFilePath path to runtime.json (for source + excluding the supervisor pid).
 * @param id            bare extension id (e.g. "tokenguard").
 */
export async function reapOrphansForExtension(
  id: string,
  opts: {
    lockfilePath?: string | undefined;
    runtimeFilePath?: string | undefined;
    graceMs?: number | undefined;
    log?: ((msg: string) => void) | undefined;
  } = {},
): Promise<ReapExtensionResult> {
  // 1. Resolve the entrypoint source for this id.
  let source = '';
  let supervisorPid: number | undefined;
  if (opts.runtimeFilePath) {
    const record = readRuntimeRecord(opts.runtimeFilePath);
    if (record) {
      supervisorPid = record.supervisorPid;
      const entry = record.entries.find((e) => e.id === id || e.key === id);
      if (entry?.source) source = entry.source;
    }
  }
  if (!source && opts.lockfilePath) {
    const map = readLockfileSourceMap(opts.lockfilePath);
    source = map[id] ?? map[`${id}@`] ?? '';
    if (!source) {
      // Fall back to a versioned key match (id@x.y.z).
      const k = Object.keys(map).find((key) => key === id || key.startsWith(`${id}@`));
      if (k) source = map[k] ?? '';
    }
  }

  const token = identityToken(source);
  if (!token) return { id, token: '', killed: [] };

  // 2. Reap by identity, never touching the live supervisor process.
  const excludePids = supervisorPid !== undefined ? [supervisorPid] : [];
  const reap = await reapByIdentity(token, {
    excludePids,
    graceMs: opts.graceMs,
    log: opts.log,
  });
  return { id, token, killed: reap.killed };
}

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

    if (shouldRun.has(baseId)) {
      // Extension should run.  If it was stopped (e.g. by a previous disable),
      // restart it in-process so the supervisor keeps ownership and the test's
      // startProcess reference stays alive until `soxe stop` kills it cleanly.
      if (handle.type === 'mcp-server') {
        const mcpHandle = handle as McpAdapterHandle;
        if (!mcpHandle.supervisor.isHealthy()) {
          try {
            // supervisor.restart() clears _stopping, re-spawns, and waits for health.
            await mcpHandle.supervisor.restart();
            const newPid = mcpHandle.supervisor.pid();
            // Re-register the freshly spawned process with the MCP registrar
            // (it was deregistered on the matching disable call).
            const proc = getProcessFromSupervisor(mcpHandle.supervisor);
            if (proc !== null) {
              try {
                await active.registrar.register(mcpHandle.key, proc);
              } catch {
                // Already registered (edge case) — ignore.
              }
            }
            if (record) {
              const entry = record.entries.find(
                (e) => e.id === baseId || e.key === handle.key,
              );
              if (entry) {
                entry.running = newPid !== null;
                entry.pid = newPid ?? null;
              }
            }
          } catch (e) {
            console.warn(
              `[runtime] reconcile: error restarting ${handle.key}: ${String(e)}`,
            );
          }
        }
      }
      continue;
    }

    // Extension should NOT run — stop it.
    if (handle.type === 'mcp-server') {
      const mcpHandle = handle as McpAdapterHandle;
      try {
        active.registrar.deregister(handle.key);
        await mcpHandle.supervisor.stop();
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

export function getRuntimeRecord(runtimeFilePath: string): RuntimeRecord | null {
  return readRuntimeRecord(runtimeFilePath);
}

/**
 * @deprecated getRegistrar() reads the in-process _activeRuntimes Map and is therefore
 * only non-null in the same process that called startRuntime(). Any separate CLI
 * invocation (e.g. `soxe exec`) always sees an empty Map and receives null.
 *
 * Use the exec socket instead: read `record.execSocketPath` from runtime.json and
 * call the supervisor process via the [inv:exec-socket] Unix domain socket protocol.
 * See callViaExecSocket() in apps/sox/src/main.ts for the reference implementation.
 */
export function getRegistrar(runtimeFilePath: string): McpRegistrar | null {
  return _activeRuntimes.get(runtimeFilePath)?.registrar ?? null;
}

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
  // Add-1: atomic write — write to a temp file then rename so that concurrent
  // readers never see partial JSON. A partial write followed by a crash leaves
  // a .tmp file behind, not a corrupt runtime.json.
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
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

function getProcessFromSupervisor(
  supervisor: import('./supervisor.js').ProcessSupervisor,
): import('node:child_process').ChildProcess | null {
  const internal = supervisor as unknown as { _proc: import('node:child_process').ChildProcess | null };
  return internal['_proc'];
}

export function runtimeFilePathFromLockfile(lockfilePath: string): string {
  return path.join(path.dirname(lockfilePath), 'runtime.json');
}

export function getRuntimeFilePath(scopeLockfilePath: string): string {
  const envOverride = process.env['SOX_RUNTIME_FILE'];
  if (envOverride) return path.resolve(envOverride);
  return runtimeFilePathFromLockfile(scopeLockfilePath);
}

export function getScopePaths(
  scope: string,
  root: string,
): { config: string; lockfile: string } {
  // ADR-0004 §D2: single resolver — all scopes under `.adhd/sox-ecosystem/`.
  if (scope !== 'user' && scope !== 'project' && scope !== 'local' && scope !== 'org') {
    throw new Error(`[runtime] Unknown scope '${scope}'. Valid: user, project, local, org`);
  }
  return scopeConfigPaths(scope as DataScope, root);
}
