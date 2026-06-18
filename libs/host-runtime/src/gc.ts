/**
 * libs/host-runtime/src/gc.ts — Stale state GC (R2 / P5).
 *
 * Lazy GC: runs on every read of the global supervisor registry. Each call to
 * readGlobalRegistry() probes every registered supervisor for liveness and
 * removes dead entries before returning.
 *
 * Probe protocol (probeEntryLiveness):
 *   Step 1: process.kill(pid, 0) — synchronous OS process table check (~0ms).
 *   Step 2: socket connect — confirms the exec socket is still listening.
 *           If the pid is alive but the socket is gone the supervisor is in a
 *           bad state; treat as dead to force cleanup.
 *
 * Cleanup on dead entry:
 *   1. Remove entry from ~/.sox/supervisors.json (atomic write).
 *   2. If runtimeFilePath exists: mark every entry running=false (preserves
 *      historical timestamps for diagnostics).
 *   3. Remove execSocketPath if it exists (safe to unlink a dead socket).
 *   4. Log to stderr: [sox] stale supervisor removed: ...
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import {
  type SupervisorRegistryEntry,
  readSupervisorsFile,
  writeSupervisorsFile,
  getSupervisorsFilePath,
} from './registry.js';

// ─── Socket probe (extracted from supervisor.ts, shared utility) ──────────────

/**
 * Attempt to connect to a Unix socket. Resolves true if the connection
 * succeeds, false on error or timeout.
 *
 * This is the same implementation as the private probeSocket in supervisor.ts,
 * extracted here so both modules can share it without a circular dependency.
 */
export function probeSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, timeoutMs);
    client.on('connect', () => {
      clearTimeout(timer);
      client.end();
      resolve(true);
    });
    client.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ─── Liveness probe ───────────────────────────────────────────────────────────

/**
 * Probe whether a registered supervisor is still alive.
 *
 * Returns 'alive' only when BOTH the pid exists in the OS process table AND
 * the exec socket is reachable. A pid-alive-but-no-socket supervisor is
 * treated as 'dead' to force cleanup rather than leaving a ghost entry.
 */
export async function probeEntryLiveness(
  entry: SupervisorRegistryEntry,
  opts: { socketTimeoutMs?: number } = {},
): Promise<'alive' | 'dead'> {
  // Step 1: OS process table check (synchronous, ~0ms).
  const pidAlive = (() => {
    try { process.kill(entry.pid, 0); return true; }
    catch { return false; }
  })();

  if (!pidAlive) return 'dead';

  // Step 2: exec socket ping (async, timeout 1000ms by default).
  // If the pid is alive but the socket is gone, the supervisor is in a bad
  // state. Treat it as dead to force cleanup rather than leaving a ghost entry.
  const socketAlive = await probeSocket(
    entry.execSocketPath,
    opts.socketTimeoutMs ?? 1000,
  );
  return socketAlive ? 'alive' : 'dead';
}

// ─── GC cleanup ───────────────────────────────────────────────────────────────

/**
 * Clean up a dead supervisor entry:
 *
 *   1. Remove the entry from ~/.sox/supervisors.json (atomic write).
 *   2. If the runtimeFilePath exists, read it and set every entry's
 *      running=false (marks as definitively stopped without deleting).
 *   3. Remove the exec socket file if it exists.
 *   4. Log to stderr.
 */
function cleanUpDeadEntry(entry: SupervisorRegistryEntry): void {
  // 1. Remove from global registry (already done by the caller, this is the
  //    write step after the caller has built the filtered list).
  const filePath = getSupervisorsFilePath();
  const file = readSupervisorsFile(filePath);
  const before = file.supervisors.length;
  file.supervisors = file.supervisors.filter(
    (e) => e.supervisorId !== entry.supervisorId,
  );
  if (file.supervisors.length !== before) {
    writeSupervisorsFile(file, filePath);
  }

  // 2. Mark all runtime.json entries as running=false.
  if (fs.existsSync(entry.runtimeFilePath)) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(entry.runtimeFilePath, 'utf8'),
      ) as {
        entries?: Array<Record<string, unknown>>;
        [k: string]: unknown;
      };
      if (Array.isArray(raw['entries'])) {
        for (const e of raw['entries']) {
          e['running'] = false;
        }
      }
      const tmp = entry.runtimeFilePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, entry.runtimeFilePath);
    } catch { /* best-effort — don't fail GC on corrupt runtime.json */ }
  }

  // 3. Remove the stale socket file.
  if (fs.existsSync(entry.execSocketPath)) {
    try { fs.unlinkSync(entry.execSocketPath); } catch { /* ignore */ }
  }

  // 4. Log.
  process.stderr.write(
    `[sox] stale supervisor removed: ${entry.supervisorId}` +
    ` (scope=${entry.scope}, root=${entry.root}, pid=${entry.pid})\n`,
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read the global supervisor registry with lazy GC applied.
 *
 * For each registered entry:
 *   - If alive: include in the returned list.
 *   - If dead: run cleanUpDeadEntry() and exclude from the returned list.
 *
 * Callers always receive only live supervisors. Dead entries are removed from
 * the file as a side-effect.
 *
 * Used by: cmdList (--all mode), cmdStatus (P5+), and any future consumer
 * that needs the live supervisor set.
 */
export async function readGlobalRegistry(
  opts: { socketTimeoutMs?: number } = {},
): Promise<SupervisorRegistryEntry[]> {
  const file = readSupervisorsFile();
  const live: SupervisorRegistryEntry[] = [];

  for (const entry of file.supervisors) {
    const status = await probeEntryLiveness(entry, opts);
    if (status === 'alive') {
      live.push(entry);
    } else {
      cleanUpDeadEntry(entry);
    }
  }

  return live;
}
