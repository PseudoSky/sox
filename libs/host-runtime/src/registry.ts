/**
 * libs/host-runtime/src/registry.ts — global supervisor registry (R1 / P4).
 *
 * Manages ~/.sox/supervisors.json, which tracks every live supervisor on the
 * machine. Used by `soxe list --all` and `soxe stop` (daemon mode) to locate
 * supervisors without requiring a terminal reference.
 *
 * File location: $userDataRoot/supervisors.json (ADR-0004 §D7; default
 * ~/.adhd/sox-ecosystem/supervisors.json, or $SOX_ECOSYSTEM_HOME/supervisors.json)
 *
 * Locking: atomic rename (write to .tmp, then rename). Concurrent writers
 * last-write-win on the temp-rename race, which is acceptable because each
 * writer only adds or removes its own entry (identified by supervisorId).
 *
 * Schema:
 *   { version: 1, supervisors: SupervisorRegistryEntry[] }
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { supervisorsPath } from './data-paths.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export interface SupervisorRegistryEntry {
  /** Stable ID: sha256(scope + ":" + root)[0..12] — short, deterministic */
  supervisorId: string;
  /** Scope this supervisor manages: "user" | "project" | "local" */
  scope: string;
  /** Absolute path to the root directory used at start (the --root flag value) */
  root: string;
  /** PID of the supervisor process itself (process.pid at startRuntime() time) */
  pid: number;
  /** Absolute path to the runtime.json file for this supervisor */
  runtimeFilePath: string;
  /** Absolute path to the exec Unix socket */
  execSocketPath: string;
  /** Absolute path to the log directory for this supervisor's extensions */
  logDir: string;
  /** ISO 8601 timestamp when this supervisor registered */
  startedAt: string;
  /** Host machine hostname — guards against NFS-mounted home directories */
  hostname: string;
}

export interface SupervisorsFile {
  version: 1;
  supervisors: SupervisorRegistryEntry[];
}

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * Returns the path to the global supervisors registry (ADR-0004 §D7).
 * Resolved via the single data-root resolver: $SOX_ECOSYSTEM_HOME/supervisors.json
 * (default ~/.adhd/sox-ecosystem/supervisors.json).
 */
export function getSupervisorsFilePath(): string {
  return supervisorsPath();
}

// ─── Read / Write ─────────────────────────────────────────────────────────────

/**
 * Read the supervisors file. Returns a default empty file if absent or corrupt.
 */
export function readSupervisorsFile(filePath?: string): SupervisorsFile {
  const p = filePath ?? getSupervisorsFilePath();
  if (!fs.existsSync(p)) {
    return { version: 1, supervisors: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<SupervisorsFile>;
    if (raw.version === 1 && Array.isArray(raw.supervisors)) {
      return raw as SupervisorsFile;
    }
    return { version: 1, supervisors: [] };
  } catch {
    return { version: 1, supervisors: [] };
  }
}

/**
 * Write the supervisors file atomically (write to .tmp then rename).
 * On crash the .tmp file is left behind and the original is intact.
 */
export function writeSupervisorsFile(file: SupervisorsFile, filePath?: string): void {
  const p = filePath ?? getSupervisorsFilePath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register a supervisor in the global registry.
 *
 * Steps:
 * 1. Read ~/.sox/supervisors.json (or start with empty).
 * 2. Remove any existing entry whose supervisorId matches (handles restart after
 *    unclean shutdown without a prior GC pass).
 * 3. Append the new entry.
 * 4. Write atomically.
 */
export function registerSupervisor(entry: SupervisorRegistryEntry): void {
  const filePath = getSupervisorsFilePath();
  const file = readSupervisorsFile(filePath);
  // Dedup: remove any prior entry for the same supervisorId.
  file.supervisors = file.supervisors.filter(
    (e) => e.supervisorId !== entry.supervisorId,
  );
  file.supervisors.push(entry);
  writeSupervisorsFile(file, filePath);
}

/**
 * Deregister a supervisor from the global registry.
 *
 * Steps:
 * 1. Read file (skip if absent).
 * 2. Filter out the entry for the given supervisorId.
 * 3. Write atomically.
 */
export function deregisterSupervisor(supervisorId: string): void {
  const filePath = getSupervisorsFilePath();
  if (!fs.existsSync(filePath)) return;
  const file = readSupervisorsFile(filePath);
  const before = file.supervisors.length;
  file.supervisors = file.supervisors.filter((e) => e.supervisorId !== supervisorId);
  if (file.supervisors.length !== before) {
    writeSupervisorsFile(file, filePath);
  }
}

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Read all registered supervisors. Returns an empty array if the file is absent.
 * Callers that want live-probing / GC should use readGlobalRegistry() from gc.ts
 * (P5), which filters stale entries. This function is a raw read — no probing.
 */
export function listRegisteredSupervisors(): SupervisorRegistryEntry[] {
  return readSupervisorsFile().supervisors;
}
