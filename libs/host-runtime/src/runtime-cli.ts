/**
 * libs/host-runtime/src/runtime-cli.ts — canonical CLI entry for soxe start/stop/status/exec.
 *
 * Canonical re-homing of the runtime CLI into the libs/host-runtime library.
 * Compiled to libs/host-runtime/dist/runtime-cli.js by the existing host-runtime build target.
 *
 * Invoked as: node libs/host-runtime/dist/runtime-cli.js <verb> [options]
 *
 * Verbs:
 *   start  --scope=<scope> [--root=<root>] [--runtime-file=<path>]
 *          [--lockfile=<path>] [--config=<path>]
 *   stop   --scope=<scope> [--runtime-file=<path>] [--id=<extension-id>]
 *   status --runtime-file=<path>
 *   exec   --runtime-file=<path> --id=<ext-id> --tool=<tool-name> --args='<json>'
 *
 * Exit codes: 0 = success, 1 = error
 *
 * [def:session-fixes] preserved: stop-via-supervisor, reconcile, expandTilde —
 * all implemented in the lib's own runtime.ts / supervisor.ts.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compilePolicy } from './policy.js';
import { scrubEnvReported } from './env-policy.js';
import {
  getRuntimeFilePath,
  getRuntimeRecord,
  getScopePaths,
  reconcileRuntime,
  startRuntime,
  stopRuntime,
} from './runtime.js';
import type { PermissionsBlock } from './supervisor.js';

// __dirname is available because tsconfig.lib.json compiles to CommonJS.
// dist/runtime-cli.js lives at libs/host-runtime/dist/, so three levels up is the repo root.
const ROOT = path.resolve(__dirname, '..', '..', '..');

/** Build SOX_CONFIG_* env vars from cascade-resolved config for an extension. */
function buildExtConfigEnv(extId: string, root: string): Record<string, string> {
  const configEnv: Record<string, string> = {};
  const merged: Record<string, unknown> = {};
  for (const cs of ['org', 'user', 'project', 'local'] as const) {
    try {
      const csp = getScopePaths(cs, root);
      if (!fs.existsSync(csp.config)) continue;
      const raw = JSON.parse(fs.readFileSync(csp.config, 'utf8')) as {
        config?: Record<string, Record<string, unknown>>;
      };
      Object.assign(merged, raw.config?.[extId] ?? {});
    } catch { /* skip missing scope */ }
  }
  const homeDir = os.homedir();
  for (const [k, v] of Object.entries(merged)) {
    const envKey = `SOX_CONFIG_${k.toUpperCase().replace(/[-\s]/g, '_')}`;
    let strVal = typeof v === 'string' ? v : (v == null ? '' : JSON.stringify(v));
    if (strVal.startsWith('~/')) strVal = homeDir + strVal.slice(1);
    strVal = strVal.replace(/\$\{([A-Z0-9_]+)\}/g, (_m: string, n: string) => process.env[n] ?? _m);
    configEnv[envKey] = strVal;
  }
  return configEnv;
}

/** Is a pid currently alive? (signal 0 = existence check) */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until pid is gone or timeout. Returns true if gone. */
async function waitForPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        const val = arg.slice(eq + 1);
        result[key] = val;
      } else {
        const key = arg.slice(2);
        result[key] = 'true';
      }
    }
  }
  return result;
}

async function cmdStart(flags: Record<string, string>): Promise<void> {
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? ROOT;

  let scopePaths: { config: string; lockfile: string };
  try {
    scopePaths = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`soxe start: ${String(e)}\n`);
    process.exit(1);
  }

  const lockfilePath = flags['lockfile'] ?? scopePaths.lockfile;
  const configPath = flags['config'] ?? scopePaths.config;
  const runtimeFilePath =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath);

  process.stdout.write(`sox: starting runtime for scope '${scope}'\n`);
  process.stdout.write(`  lockfile:     ${lockfilePath}\n`);
  process.stdout.write(`  config:       ${configPath}\n`);
  process.stdout.write(`  runtime-file: ${runtimeFilePath}\n`);

  try {
    const record = await startRuntime({
      scope,
      lockfilePath,
      configPath,
      runtimeFilePath,
      root,
      // Do NOT force overrideHealthToStdioPing here — honour whatever the extension declares.
      // memory-server correctly declares "stdio-ping" in extension.json; other extensions
      // may legitimately declare "socket" or "command" health checks.
    });

    const runningCount = record.entries.filter((e) => e.running).length;
    process.stdout.write(
      `sox: runtime started — ${record.entries.length} extension(s) activated, ${runningCount} running\n`,
    );

    for (const entry of record.entries) {
      const pidStr = entry.pid !== null ? ` pid=${entry.pid}` : '';
      const status = entry.running ? 'RUNNING' : 'INACTIVE';
      process.stdout.write(`  [${status}] ${entry.key} (${entry.type})${pidStr}\n`);
    }

    // Keep the process alive to maintain supervised children.
    // Exit when the parent (bin/soxe start) closes or sends SIGTERM/SIGINT.
    process.stdout.write(
      `sox: runtime supervisor running (pid=${process.pid}) — Ctrl-C or 'soxe stop' to stop\n`,
    );

    // Handle graceful shutdown
    const shutdown = async (signal: string): Promise<void> => {
      process.stdout.write(`\nsox: received ${signal}, stopping runtime...\n`);
      try {
        await stopRuntime({ scope, runtimeFilePath });
        process.stdout.write(`sox: runtime stopped\n`);
      } catch (e) {
        process.stderr.write(`sox: error during stop: ${String(e)}\n`);
      }
      process.exit(0);
    };

    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });

    // SIGHUP = reconcile against config (raised by `soxe disable` / `soxe uninstall`
    // after they update the config). The supervisor stops any extension that is no
    // longer in the should-run set — in-process, so _stopping is set and there is NO restart.
    process.on('SIGHUP', () => {
      void (async () => {
        try {
          const stoppedIds = await reconcileRuntime(runtimeFilePath, configPath);
          process.stdout.write(
            `sox: reconciled — stopped ${stoppedIds.length} extension(s): ${stoppedIds.join(', ') || '(none)'}\n`,
          );
        } catch (e) {
          process.stderr.write(`sox: reconcile error: ${String(e)}\n`);
        }
      })();
    });

    // Keep alive — heartbeat every 5 s (no-op; supervisor manages process state internally)
    setInterval(() => {
      // no-op
    }, 5000);
  } catch (e) {
    process.stderr.write(`soxe start: failed — ${String(e)}\n`);
    process.exit(1);
  }
}

async function cmdStop(flags: Record<string, string>): Promise<void> {
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? ROOT;
  const id = flags['id'];

  let scopePaths: { config: string; lockfile: string };
  try {
    scopePaths = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`soxe stop: ${String(e)}\n`);
    process.exit(1);
  }

  const lockfilePath = flags['lockfile'] ?? scopePaths.lockfile;
  const runtimeFilePath =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath);

  // Read runtime record to find PIDs to kill
  const record = getRuntimeRecord(runtimeFilePath);
  if (!record) {
    process.stdout.write(`sox: no runtime record found at ${runtimeFilePath}\n`);
    process.exit(0);
  }

  // CLEAN FULL STOP: if the supervisor process is alive, signal IT (SIGTERM).
  // Its shutdown handler calls stopRuntime() in-process → supervisor.stop() for every
  // child (sets _stopping → SIGTERM/SIGKILL, NO restart). This is the only path that
  // does not race the supervisor's restart logic and does not leave orphans.
  if (!id && typeof record.supervisorPid === 'number' && isAlive(record.supervisorPid)) {
    const supPid = record.supervisorPid;
    process.stdout.write(`sox: signaling supervisor (pid=${supPid}) to stop...\n`);
    try {
      process.kill(supPid, 'SIGTERM');
    } catch (e) {
      process.stderr.write(`sox: could not signal supervisor: ${String(e)}\n`);
    }
    const gone = await waitForPidGone(supPid, 8000);
    // Reality check: ensure no child survived (SIGKILL any straggler directly).
    for (const e of record.entries) {
      if (e.pid !== null && isAlive(e.pid)) {
        try {
          process.kill(e.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(runtimeFilePath), { recursive: true });
    const cleared = {
      ...record,
      supervisorPid: undefined,
      entries: record.entries.map((e) => ({ ...e, running: false, pid: null })),
    };
    writeFileSync(runtimeFilePath, JSON.stringify(cleared, null, 2) + '\n', 'utf8');
    process.stdout.write(
      gone
        ? `sox: runtime stopped (supervisor exited cleanly)\n`
        : `sox: supervisor did not exit in time — killed children directly\n`,
    );
    process.exit(0);
  }

  const toStop = id
    ? record.entries.filter((e) => e.id === id || e.key === id)
    : record.entries;

  const runningEntries = toStop.filter((e) => e.running && e.pid !== null);

  if (runningEntries.length === 0) {
    process.stdout.write(`sox: no running processes to stop\n`);
    // Still clean up the record
    for (const entry of toStop) {
      entry.running = false;
      entry.pid = null;
    }
    if (!id) {
      // Clear the record file
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(runtimeFilePath), { recursive: true });
      const cleared = {
        ...record,
        entries: record.entries.map((e) => ({ ...e, running: false, pid: null })),
      };
      writeFileSync(runtimeFilePath, JSON.stringify(cleared, null, 2) + '\n', 'utf8');
    }
    process.exit(0);
  }

  let stopped = 0;
  let failed = 0;

  for (const entry of runningEntries) {
    const pid = entry.pid;
    if (pid === null) continue;
    try {
      process.kill(pid, 'SIGTERM');
      process.stdout.write(`sox: sent SIGTERM to ${entry.key} (pid=${pid})\n`);
      // Wait briefly for it to exit
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      // Check if still alive
      try {
        process.kill(pid, 0); // 0 = check existence
        // Still alive — send SIGKILL
        process.kill(pid, 'SIGKILL');
        process.stdout.write(`sox: sent SIGKILL to ${entry.key} (pid=${pid}) — SIGTERM timeout\n`);
      } catch {
        // Process already exited — good
      }
      entry.running = false;
      entry.pid = null;
      stopped++;
    } catch (e) {
      process.stderr.write(`sox: failed to stop ${entry.key} (pid=${pid}): ${String(e)}\n`);
      entry.running = false;
      entry.pid = null;
      failed++;
    }
  }

  // Update non-running entries too
  for (const entry of toStop) {
    if (!entry.running) {
      // already marked
    } else if (entry.pid === null) {
      entry.running = false;
    }
  }

  // Write updated record
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(runtimeFilePath), { recursive: true });
  writeFileSync(runtimeFilePath, JSON.stringify(record, null, 2) + '\n', 'utf8');

  process.stdout.write(`sox: stop complete — stopped ${stopped}, failed ${failed}\n`);

  if (failed > 0) process.exit(1);
  process.exit(0);
}

function cmdStatus(flags: Record<string, string>): void {
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? ROOT;

  let scopePaths: { config: string; lockfile: string };
  try {
    scopePaths = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`soxe status: ${String(e)}\n`);
    process.exit(1);
  }

  const lockfilePath = flags['lockfile'] ?? scopePaths.lockfile;
  const runtimeFilePath =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath);

  const record = getRuntimeRecord(runtimeFilePath);
  if (!record) {
    process.stdout.write(`sox: no runtime record at ${runtimeFilePath} (host not started?)\n`);
    process.exit(0);
  }

  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  process.exit(0);
}

/**
 * callViaExecSocket — send one tool-call request to the supervisor's exec socket.
 *
 * [inv:exec-socket]: The supervisor writes `execSocketPath` into runtime.json when it
 * starts (supervisor mode only). This function connects, sends one JSON line, reads
 * one JSON line back, then closes the connection. The entire round-trip is handled
 * inside the live supervisor process — no throwaway spawn.
 */
async function callViaExecSocket(
  socketPath: string,
  ext: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<unknown> {
  const { createConnection } = await import('node:net');
  const { createInterface } = await import('node:readline');

  return new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const rl = createInterface({ input: socket, crlfDelay: Infinity });

    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl.close();
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`soxe exec: timeout waiting for exec socket response (${timeoutMs}ms)`)));
    }, timeoutMs);

    rl.once('line', (line: string) => {
      finish(() => {
        try {
          const resp = JSON.parse(line) as { result?: unknown; error?: string };
          if (resp.error !== undefined) {
            reject(new Error(resp.error));
          } else {
            resolve(resp.result);
          }
        } catch {
          reject(new Error(`soxe exec: invalid response from exec socket: ${line.slice(0, 120)}`));
        }
      });
    });

    socket.on('error', (e: Error) => {
      finish(() => reject(e));
    });

    socket.on('connect', () => {
      socket.write(JSON.stringify({ ext, tool, args }) + '\n');
    });
  });
}

/**
 * Call a tool on an extension from the activated runtime.
 *
 * Routing priority (mirrors apps/soxe cmdExec):
 *   1. If runtime.json has execSocketPath and the socket file exists →
 *      route through the live supervisor session (zero throwaway spawn).
 *   2. Else → fresh MCP spawn with policy enforcement (service-mode or socket absent).
 *
 * [process-boundary.exec] — Policy env injected into the exec spawn so that a
 * fresh-spawned child self-enforces identically to the supervised child.
 */
async function cmdExec(flags: Record<string, string>): Promise<void> {
  const runtimeFilePath = flags['runtime-file'] ?? process.env['SOX_RUNTIME_FILE'] ?? '';
  const extId = flags['id'] ?? '';
  const toolName = flags['tool'] ?? '';
  const argsJson = flags['args'] ?? '{}';

  if (!runtimeFilePath) {
    process.stderr.write(`soxe exec: --runtime-file is required\n`);
    process.exit(1);
  }
  if (!extId) {
    process.stderr.write(`soxe exec: --id is required\n`);
    process.exit(1);
  }
  if (!toolName) {
    process.stderr.write(`soxe exec: --tool is required\n`);
    process.exit(1);
  }

  let toolArgs: Record<string, unknown>;
  try {
    toolArgs = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    process.stderr.write(`soxe exec: invalid --args JSON: ${argsJson}\n`);
    process.exit(1);
  }

  const record = getRuntimeRecord(runtimeFilePath);
  if (!record) {
    process.stderr.write(`soxe exec: no runtime record at ${runtimeFilePath}. Run 'soxe start' first.\n`);
    process.exit(1);
  }

  const entry = record.entries.find((e) => e.id === extId || e.key === extId);
  if (!entry) {
    process.stderr.write(`soxe exec: extension '${extId}' not found in runtime record.\n`);
    process.stderr.write(`Available: ${record.entries.map((e) => e.id).join(', ')}\n`);
    process.exit(1);
  }

  const { existsSync, readFileSync } = await import('node:fs');

  // ── Route 1: exec socket (supervisor mode — airtight) ─────────────────────
  // [inv:exec-socket]: present in runtime.json only when startRuntime() opened it.
  if (record.execSocketPath && existsSync(record.execSocketPath)) {
    try {
      const result = await callViaExecSocket(record.execSocketPath, extId, toolName, toolArgs);
      process.stdout.write(JSON.stringify(result) + '\n');
      const mcpResult = result as { isError?: boolean };
      process.exit(mcpResult.isError ? 1 : 0);
    } catch (e) {
      // Socket error — fall through to fresh spawn with a warning.
      process.stderr.write(`soxe exec: exec socket failed (${String(e)}), falling back to fresh spawn\n`);
    }
  }

  // ── Route 2: fresh MCP spawn (service-mode detached, or socket unavailable) ─
  const { resolveExtensionDir } = await import('./loader.js');

  const extDir = resolveExtensionDir(entry.source, ROOT);
  if (!extDir) {
    process.stderr.write(`soxe exec: cannot resolve extension dir from source: ${entry.source}\n`);
    process.exit(1);
  }

  const manifestPath = path.join(extDir, 'extension.json');
  if (!existsSync(manifestPath)) {
    process.stderr.write(`soxe exec: manifest not found at ${manifestPath}\n`);
    process.exit(1);
  }

  // [process-boundary.exec] — Compile policy from the manifest's permissions block
  // and inject it into the child env, mirroring the supervisor's enforced spawn path.
  const manifestFull = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    entrypoint?: string;
    permissions?: PermissionsBlock;
  };
  if (!manifestFull.entrypoint) {
    process.stderr.write(`soxe exec: no entrypoint in manifest at ${manifestPath}\n`);
    process.exit(1);
  }

  const entrypointPath = path.resolve(extDir, manifestFull.entrypoint);
  if (!existsSync(entrypointPath)) {
    process.stderr.write(`soxe exec: entrypoint not found at ${entrypointPath}\n`);
    process.exit(1);
  }

  const { spawn } = await import('node:child_process');
  const { McpClient } = await import('./registrar.js');

  const policy = compilePolicy(manifestFull.permissions);
  const extConfigEnv = buildExtConfigEnv(extId, ROOT);

  let execEnv: NodeJS.ProcessEnv;
  if (policy.enforced) {
    // BL-344: the env scrub is defined ONCE, in env-policy.ts. This copy was the
    // most drifted of the five — it carried NEITHER emergency brake, so any
    // process spawned through this path ignored both mitigations entirely.
    // The comment above it claimed parity with supervisor._spawn; it did not
    // have parity, which is exactly the failure mode of a duplicated allowlist.
    const baseEnv = scrubEnvReported('runtime-cli exec');
    // policy.toEnv() injects the enforce flag + 4 policy JSON arrays ([def:policy-env]).
    execEnv = { ...baseEnv, ...extConfigEnv, ...policy.toEnv() };
  } else {
    // [inv:no-regress] — No permissions block: byte-identical to pre-state.
    execEnv = { ...process.env, ...extConfigEnv };
  }

  const child = spawn(process.execPath, [entrypointPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: execEnv,
  });

  child.stderr?.on('data', (_d: Buffer) => {
    // Suppress startup logs from extension stderr
  });

  const client = new McpClient(child);

  try {
    await client.call(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sox-exec', version: '1.0.0' },
      },
      10000,
    );

    const result = await client.call(
      'tools/call',
      {
        name: toolName,
        arguments: toolArgs,
      },
      30000,
    );

    process.stdout.write(JSON.stringify(result) + '\n');

    client.close();
    child.kill('SIGTERM');
    const mcpResult2 = result as { isError?: boolean };
    process.exit(mcpResult2.isError ? 1 : 0);
  } catch (e) {
    client.close();
    child.kill('SIGTERM');
    process.stderr.write(`soxe exec: tool call failed: ${String(e)}\n`);
    process.exit(1);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const verb = argv[0];
const flags = parseArgs(argv.slice(1));

switch (verb) {
  case 'start':
    void cmdStart(flags);
    break;
  case 'stop':
    void cmdStop(flags);
    break;
  case 'status':
    cmdStatus(flags);
    break;
  case 'exec':
    void cmdExec(flags);
    break;
  default:
    process.stderr.write(`soxe runtime-cli: unknown verb '${String(verb)}'\n`);
    process.exit(1);
}
