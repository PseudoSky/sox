# IMPLEMENTATION — runtime-productionization

This document is the concrete design for all nine production-readiness gaps (R1–R9) identified
in SCOPE.md, plus two additional items uncovered during the architecture review. Every decision
is made here. Implementers should not need to re-open design questions — if something is
ambiguous, this document is wrong and must be updated before code is written.

The design is grounded in the actual current state of the codebase: `libs/host-runtime/src/`
(supervisor, runtime, loader), `apps/sox/src/main.ts` (CLI), and the lockfile/registry schemas
as they exist on `feat/nx-migration`.

---

## 0. Command Boundary: `soxe list` vs `soxe status`

These two commands answer different questions and must not be conflated.

**`soxe list`** is an inventory command. It has three modes:

- `soxe list` (no flags) — reads the lockfile and `runtime.json` for the current project.
  Fast: disk reads only, one `process.kill(pid, 0)` per entry to flag dead entries. Answers:
  "what is installed here, at what version, is the supervisor running?"
- `soxe list --all` — reads `~/.sox/supervisors.json` and merges the runtime records of every
  live supervisor on the machine. Answers: "what is running across all my projects right now?"
  Requires at least one supervisor to be running to show anything useful.
- `soxe list --global` — reads `~/.sox/install-registry.json` (the install ledger written by
  `soxe install`). No live probing. Answers: "across every project I have ever installed
  extensions in, what is installed and when was it last updated?" Works without any supervisor
  running.

`soxe list` is analogous to `npm list` or `dpkg -l`. All three modes support `--id=<ext>`,
`--scope=<scope>`, and `--json`.

**`soxe status`** is a health command. It reads `~/.sox/supervisors.json` (the global supervisor
registry) and live-probes each registered supervisor and its running extensions via pid check
and exec socket ping. It answers: "what is running right now, is it healthy, how long has it
been up?" It is analogous to `systemctl status`. It is slower — it opens a socket connection
per supervisor to probe liveness. `soxe status` can only show extensions that a supervisor has
activated; extensions that are installed but whose supervisor is not running will not appear.

The two commands share the `--scope` and `--json` flags but are otherwise entirely independent
pipelines. A summary of the distinction:

| Dimension | `soxe list` | `soxe list --all` | `soxe list --global` | `soxe status` |
|-----------|-----------|-----------------|---------------------|--------------|
| Data source | Local lockfile + runtime.json | All supervisor runtime.json files | Install ledger (~/.sox/install-registry.json) | Supervisor registry + live socket probe |
| Requires running supervisor | No | Yes | No | Yes |
| Speed | Fast (disk) | Fast (disk) | Fast (disk) | Slower (socket I/O) |
| Primary question | What is installed here? | What is running everywhere? | What have I ever installed? | Is it healthy? |
| Shows stopped extensions | Yes (INACTIVE) | No | Yes | No |

---

## 1. Global Supervisor Registry (R1)

### File location

```
~/.sox/supervisors.json
```

The `SOX_HOME` environment variable (already respected for user-scope paths in `runtime.ts`
`getScopePaths`) overrides the `~/.sox/` prefix, producing `$SOX_HOME/supervisors.json`.
This keeps the existing SOX_HOME redirect contract intact.

### Locking strategy: atomic rename

Use write-to-temp-then-rename (`fs.writeFileSync` to `~/.sox/supervisors.json.tmp` followed
by `fs.renameSync`) rather than advisory flock. Rationale: `flock(2)` is a POSIX call that
requires either a native addon or `fs.openSync` with a busy-wait loop in Node.js. Atomic
rename is available in all Node.js versions without addons, is crash-safe (the OS guarantees
rename atomicity on the same filesystem), and is already the correct pattern for the
`writeRuntimeRecord` helper in `runtime.ts` (which currently does NOT use atomic write — that
is a bug fixed as part of this work, see Section 11).

For the global registry specifically: concurrent writers will last-write-win on the temp-rename
race, which is acceptable because each writer only adds or removes its own entry. The supervisorId
(defined below) makes entries self-identifying, so a lost concurrent update means a supervisor's
entry appears on the next write cycle. Given that registrations happen once at start and
deregistrations happen once at clean stop, the collision window is negligible.

### Schema

```typescript
// ~/.sox/supervisors.json
interface SupervisorsFile {
  version: 1;
  supervisors: SupervisorRegistryEntry[];
}

interface SupervisorRegistryEntry {
  /** Stable ID: sha256(scope + ":" + root)[0..12] — short, deterministic, human-readable */
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
```

The `supervisorId` is the first 12 hex characters of `sha256(scope + ":" + root)`. This is
deterministic, collision-resistant for any realistic number of concurrent supervisors on one
machine, and survives process restarts (a restarted supervisor for the same scope+root gets the
same ID, which simplifies deduplication).

### Self-registration

Called at the end of `startRuntime()`, after the exec socket is listening and
`writeRuntimeRecord` has written `runtime.json`. The registration writes to
`~/.sox/supervisors.json` using the atomic-rename pattern. Steps:

1. Read `~/.sox/supervisors.json` (or start with `{ version: 1, supervisors: [] }` if absent).
2. Remove any existing entry whose `supervisorId` matches the new one (handles restart after
   unclean shutdown without a prior GC pass).
3. Append the new entry.
4. Write atomically to `~/.sox/supervisors.json.tmp`, then rename.

### Self-deregistration

Called inside `stopRuntime()` after all extensions are stopped and the exec socket is closed.
Steps: read the file, filter out the entry whose `supervisorId` matches, write atomically.
If the file is absent, skip silently.

### `soxe list --all`

Reads `~/.sox/supervisors.json`, then for each entry:

1. Runs the stale-GC probe (see Section 2).
2. If alive: reads its `runtimeFilePath` and merges entries into the output table with an
   additional `ROOT` column.
3. If stale: removes the entry from the file and marks it as `[STALE — removed]` in stderr.

The existing `cmdList` in `apps/sox/src/main.ts` (line 1349) only scans scopes relative to
`process.cwd()`. With `--all`, it instead iterates the global registry. Without `--all`, it
continues scanning the three scopes for the current root (existing behaviour, unchanged).

---

## 2. Stale State GC (R2)

### Strategy: lazy GC on every read

Eager GC (background sweep) requires a persistent daemon or a cron job, neither of which fits
the current architecture where supervisors themselves are the daemons. Lazy GC on every read
adds a small constant probe overhead per listed entry and is correct by construction — callers
always see reality, never stale state.

The existing `cmdList` in `apps/sox/src/main.ts` already performs a partial version of this
at line 1422–1423 (`process.kill(pid, 0)` check). This design formalizes and extends it.

### Probe protocol

A function `probeEntryLiveness(entry: SupervisorRegistryEntry): Promise<'alive' | 'dead'>`
in a new `libs/host-runtime/src/gc.ts`:

```typescript
async function probeEntryLiveness(
  entry: SupervisorRegistryEntry,
  opts: { socketTimeoutMs?: number } = {},
): Promise<'alive' | 'dead'> {
  // Step 1: OS process table check (synchronous, ~0ms).
  // Returns false if pid does not exist or we lack permission to signal it.
  const pidAlive = (() => {
    try { process.kill(entry.pid, 0); return true; }
    catch { return false; }
  })();

  if (!pidAlive) return 'dead';

  // Step 2: exec socket ping (async, timeout 1000ms).
  // If the pid is alive but the socket is gone, the supervisor is in a bad state.
  // Treat it as dead to force cleanup rather than leaving a ghost entry.
  const socketAlive = await probeSocket(entry.execSocketPath, opts.socketTimeoutMs ?? 1000);
  return socketAlive ? 'alive' : 'dead';
}
```

The `probeSocket` helper already exists in `supervisor.ts` (`libs/host-runtime/src/supervisor.ts`
line 396) and will be extracted to a shared utility in `gc.ts`.

### What GC cleans up

When `probeEntryLiveness` returns `'dead'`:

1. Remove the entry from `~/.sox/supervisors.json` (atomic write).
2. If the `runtimeFilePath` exists on disk, read it and set every entry's `running = false`,
   then overwrite (marks record as definitively stopped without deleting it, preserving
   historical start timestamps for diagnostics).
3. Remove the exec socket file at `entry.execSocketPath` if it exists (safe to unlink a socket
   that belongs to a dead process).
4. Log to stderr: `[sox] stale supervisor removed: ${entry.supervisorId} (scope=${scope}, root=${root}, pid=${pid})`.

The log directory is intentionally NOT cleaned up by GC. Log files are rotated separately
(Section 4) and belong to the operator to archive or delete.

### Who triggers GC

Every call to `cmdList`, `cmdStatus`, and the new `readGlobalRegistry()` helper runs
lazy GC before returning results. No background sweep. GC runs are low-cost (one
`process.kill(0)` + one socket connect per entry) and terminate within the socket timeout.

---

## 3. Concurrent Start Safety (R3)

### Lock file location

```
~/.sox/locks/<supervisorId>.lock
```

Where `supervisorId` is the same deterministic hash as Section 1 (`sha256(scope + ":" + root)[0..12]`).
One lock file per scope+root combination. Lock files are never deleted — they are zero-byte
marker files whose sole purpose is to be held open.

### Lock acquisition: `O_EXCL` create with pid inside

```typescript
// libs/host-runtime/src/lock.ts

export function acquireStartLock(
  supervisorId: string,
  opts: { timeoutMs?: number } = {},
): { release: () => void } {
  const lockDir = path.join(os.homedir(), '.sox', 'locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${supervisorId}.lock`);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      // O_EXCL: fails with EEXIST if the file already exists.
      const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return {
        release: () => {
          try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        },
      };
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;

      // Lock exists — check if the holder is still alive.
      const holderPid = readLockPid(lockPath);
      if (holderPid !== null) {
        const holderAlive = (() => {
          try { process.kill(holderPid, 0); return true; }
          catch { return false; }
        })();
        if (!holderAlive) {
          // Stale lock from a crashed process — remove and retry immediately.
          try { fs.unlinkSync(lockPath); } catch { /* lost the race, try again */ }
          continue;
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `[runtime] Cannot start: another soxe start is already running for this ` +
          `scope+root (lock held for ${timeoutMs}ms). ` +
          `If you are sure no other start is running, delete: ${lockPath}`,
        );
      }
      // Spin-wait with 50ms sleep.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
```

Rationale for `O_EXCL` over `flock`: `flock` requires keeping a file descriptor open for the
lifetime of the lock, which works but adds state to track. `O_EXCL` + pid-inside is simpler,
universally portable, and provides stale-lock detection (if the holder PID is dead, the lock
is unconditionally stale). The 50ms spin is acceptable because `soxe start` is a human-invoked
command, not a hot path.

### Integration point

`startRuntime()` in `runtime.ts` acquires the lock as its very first action, before reading
`runtime.json` or spawning anything. The lock is released after `writeRuntimeRecord` writes
the final runtime record with `execSocketPath` set. At that point the supervisor is
fully registered and subsequent `startRuntime` calls will see it in the idempotent check
(`_activeRuntimes.has(runtimeFilePath)`).

### Error to the loser

```
sox: start: another supervisor is already starting for scope=project root=/path/to/project
     (timeout after 10s). If no soxe start is running, delete ~/.sox/locks/<id>.lock
```

---

## 4. Log Pipeline (R4, R8 dependency)

### Log file path template

```
~/.sox/logs/<supervisorId>/<extId>-<YYYY-MM-DD>.log
```

Example: `~/.sox/logs/a3f7b2c9d1e4/memory-server-2026-06-18.log`

The `supervisorId` directory groups all extensions for a given supervisor together, making it
trivial to find all logs for a given scope+root. The date suffix enables daily rotation without
an external log rotation daemon.

Startup log (the supervisor's own stdout/stderr, not extension output):

```
~/.sox/logs/<supervisorId>/supervisor-<YYYY-MM-DD>.log
```

### Rotation policy

- **Max size per file:** 50 MB. When the active log file exceeds 50 MB mid-write, the supervisor
  closes it, renames it to `<base>.<epoch>.log`, and opens a new file.
- **Max files per extension:** 7 files (one week of daily rotation at typical verbosity).
  On rotation, if more than 7 files exist for the same extId prefix, the oldest is deleted.
- **Compressed archives:** not in scope for this phase. Files are kept plain text.

These numbers are concrete defaults. Extensions may not override them in `extension.json` in
this phase — a per-extension override mechanism can be added later.

### Routing: pipe → writable stream

The supervisor's `_spawn()` in `supervisor.ts` currently creates the child with
`stdio: ['pipe', 'pipe', 'pipe']` and attaches no-op data handlers at lines 257–260. The
logging hook (`// P5 logging hook`) comment is the intended integration point.

Design: the `ProcessSupervisor` constructor receives an optional `logStream: fs.WriteStream`
parameter. In `_spawn()`, the stdout and stderr data handlers pipe chunks to that stream:

```typescript
// In ProcessSupervisor._spawn()
this._proc.stdout?.on('data', (chunk: Buffer) => {
  if (this._logStream) this._logStream.write(chunk);
});
this._proc.stderr?.on('data', (chunk: Buffer) => {
  if (this._logStream) this._logStream.write(chunk);
});
```

The `LogManager` (new class in `libs/host-runtime/src/log-manager.ts`) owns the write stream:

```typescript
// libs/host-runtime/src/log-manager.ts

export interface LogManagerOptions {
  logDir: string;   // e.g. ~/.sox/logs/<supervisorId>
  extId: string;    // e.g. "memory-server"
  maxSizeBytes?: number;   // default 50_000_000
  maxFiles?: number;       // default 7
}

export class LogManager {
  private _stream: fs.WriteStream | null = null;
  private _currentPath: string = '';
  private _currentDate: string = '';
  private _bytesWritten: number = 0;

  constructor(private readonly opts: LogManagerOptions) {}

  /** Returns the write stream for the current log file. Opens/rotates as needed. */
  stream(): fs.WriteStream { ... }

  /** Returns the path of the currently active log file. */
  currentPath(): string { ... }

  /** Close the current stream. Called on supervisor stop. */
  close(): void { ... }
}
```

The write stream is opened with `fs.createWriteStream(path, { flags: 'a' })` so that log
files survive across supervisor restarts (append, not truncate).

### `soxe logs` command

```
soxe logs --id=<extId> [--scope=<scope>] [--follow] [--lines=<n>] [--json]
```

Implementation in `apps/sox/src/main.ts`:

1. Resolve the log directory: read `~/.sox/supervisors.json`, find the entry matching the
   scope (or current scope if `--scope` not given), derive `logDir`.
2. Find the most recent log file: `ls ~/.sox/logs/<supervisorId>/<extId>-*.log | sort | tail -1`.
3. Without `--follow`: print the last `--lines` lines (default 100) using a streaming read
   from the end of the file (read the file size, seek back, read chunks).
4. With `--follow`: use `fs.watch` on the log file to detect new writes, then `fs.read`
   new bytes incrementally. This is a pure Node.js equivalent of `tail -f` without spawning
   a shell process.

### Log line format

Plain text. Each line is a raw byte-for-byte copy of the extension's stdout/stderr. Sox does
not inject structured prefixes into extension output — extensions own their own log format.
The supervisor's own diagnostic lines (e.g. `[supervisor] SIGKILL for "..."`) are written
to the supervisor's own log stream, not the extension's stream.

No JSON wrapping of log lines. JSON wrapping adds complexity, is opaque to `cat` and `grep`,
and the extensions in this ecosystem write their own formats. The log file is a transcript,
not a structured event log.

---

## 5. Daemon Mode (R8)

### `--daemon` flag behavior: `child_process.spawn` detached + unref

```
soxe start --daemon [--scope=<scope>] [--root=<root>] [--id=<extId>]
```

Node.js's `child_process.spawn` with `detached: true` + `stdio: 'ignore'` + `.unref()` is the
correct cross-platform daemonization mechanism in Node.js. Double-fork (the Unix
`fork()→setsid()→fork()` pattern) is not available in pure Node.js without a native addon and
is unnecessary because `spawn(..., { detached: true })` already calls `setsid()` on Linux/macOS
when `detached: true` is set.

The daemon invocation re-runs the same `soxe start` command without `--daemon`, with an
additional internal flag `--_daemon-child` that suppresses the daemonize step:

```typescript
// In cmdStart(), when --daemon is present:
const logPath = resolveLogPath(supervisorId, 'supervisor', today);
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const logFd = fs.openSync(logPath, 'a');  // open BEFORE fork so parent can print the path

const child = spawn(process.execPath, [
  '--enable-source-maps',
  process.argv[1],       // dist/apps/sox/main.js
  'start',
  `--scope=${scope}`,
  `--root=${root}`,
  '--_daemon-child',     // internal flag — suppresses re-daemonize
  ...(id ? [`--id=${id}`] : []),
], {
  detached: true,
  stdio: ['ignore', logFd, logFd],   // stdout+stderr → log file
});
child.unref();
fs.closeSync(logFd);  // parent closes its fd; child keeps its copy

process.stdout.write(
  `[sox] Supervisor started in background.\n` +
  `  PID:     ${child.pid}\n` +
  `  Logs:    ${logPath}\n` +
  `  Follow:  soxe logs --id=<ext> --follow\n`,
);
process.exit(0);
```

Key: the log file is opened by the PARENT before spawning, so `logPath` is known and printable.
The child inherits the fd and writes to it from the start of execution — no output is lost.

### What the caller sees

```
[sox] Supervisor started in background.
  PID:     84213
  Logs:    ~/.sox/logs/a3f7b2c9d1e4/supervisor-2026-06-18.log
  Follow:  soxe logs --id=<ext> --follow
```

Exit code: 0. The caller's shell is returned immediately.

### How `soxe stop` finds the daemon

`soxe stop` does not use signals from the terminal. It reads `~/.sox/supervisors.json`, finds
the entry for the scope+root, and sends the stop request via the exec socket (existing
`callViaExecSocket` pattern in `apps/sox/src/main.ts`). If the exec socket is unreachable,
falls back to `process.kill(entry.pid, 'SIGTERM')`. The global registry is what makes daemon
stop work without a terminal reference.

### Interaction with R4

The log file path is computed from the `supervisorId` and today's date. The parent computes
this path before spawning. The child's `startRuntime()` call instantiates `LogManager` with
the same deterministic path. No IPC required between parent and child to convey the path.

---

## 6. Process Group / Worker Containment (R5)

### Strategy: `detached: true` + negative-pgid SIGTERM/SIGKILL

When the supervisor spawns an extension, it uses `detached: true` in the `spawn` call.
On Linux and macOS, `detached: true` causes Node.js to call `setsid()` in the child, making
the child the leader of a new process group. `process.kill(-pgid, signal)` then delivers
the signal to every process in that group — the child AND all of its descendants.

Change to `ProcessSupervisor._spawn()` in `supervisor.ts`:

```typescript
this._proc = spawn(process.execPath, ['--enable-source-maps', this._entrypointPath, ...this._args], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: spawnEnv,
  detached: true,           // ← new: creates new process group
  ...(spawnCwd !== undefined ? { cwd: spawnCwd } : {}),
});
// Do NOT call this._proc.unref() — the supervisor must keep the child alive.
```

In `ProcessSupervisor.stop()`:

```typescript
async stop(): Promise<void> {
  this._stopping = true;
  // ... (clear health timer, remove from registry — unchanged)

  if (!this._proc || this._proc.exitCode !== null) return;

  const stopTimeoutMs = this._lifecycle.stop_timeout_ms ?? 5000;
  const pid = this._proc.pid;

  if (pid !== undefined) {
    try {
      // Negative pgid: send to entire process group (child + workers)
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Group may already be dead — fall through to wait
    }
  } else {
    this._proc.kill('SIGTERM');
  }

  const stopped = await this._waitForExit(stopTimeoutMs);
  if (!stopped) {
    console.log(`[supervisor] SIGKILL for "${this._key}" process group (stop_timeout_ms exceeded)`);
    if (pid !== undefined) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
    } else {
      this._proc.kill('SIGKILL');
    }
    await this._waitForExit(2000);
  }
}
```

### Fallback for non-process-group extensions

Not every extension will have sub-processes. The `process.kill(-pid, ...)` call is made
regardless — if the process has no group members other than itself, it behaves identically to
`process.kill(pid, ...)`. The `catch` on `process.kill(-pid, ...)` handles the case where the
process group no longer exists (process already dead).

### What this does NOT handle

Extensions that use `child_process.fork` without `detached: true` in their own code produce
children in the SAME process group as their parent (the extension process), so those children
are already covered. Extensions that explicitly call `setsid()` to escape their process group
are responsible for their own shutdown contract (this is the R6 signal contract concern).

---

## 7. Two-Phase Shutdown (R6)

### Sequence

The two-phase sequence is already implemented in `supervisor.ts` `stop()` (lines 162–168). The
current implementation sends SIGTERM to `this._proc` only (the direct child), then SIGKILL
after `stop_timeout_ms`. This section extends it to cover the process group (R5) and defines
the signal contract precisely.

```
T+0ms       SIGTERM → process group (-pgid)
T+stop_timeout_ms   (default 5000ms) check if process exited
            If exited: done.
            If NOT exited:
T+stop_timeout_ms   SIGKILL → process group (-pgid)
T+stop_timeout_ms+2000ms  check again
            If still not exited: log error, mark as dead, move on.
```

### `stop_timeout_ms` location

Declared in `extension.json` under `lifecycle.stop_timeout_ms`. Already parsed at lines 38–39
of `supervisor.ts` (`LifecycleBlock.stop_timeout_ms`). Already read in `stop()` at line 161.
No schema change required. Default: **5000ms**. The 5s default is already in place.

### SIGKILL failure handling

If `this._waitForExit(2000)` returns false after SIGKILL (PID still alive):

```typescript
console.error(
  `[supervisor] CRITICAL: could not kill "${this._key}" (pid ${String(pid)}) even with SIGKILL. ` +
  `Process may be in uninterruptible sleep (D state). Manual intervention required.`
);
// Mark as stopped in our bookkeeping so the runtime record is updated,
// even though the process may still be running at the OS level.
this._healthy = false;
```

Log and move on. The process is in an uninterruptible state (kernel I/O wait) and requires
operator intervention. Sox cannot do more from user space without OS-kernel sandboxing (explicit
non-goal).

### Signal contract for extensions (R6)

The framework requires that all `mcp-server` and `service` type extensions handle `SIGTERM` by:

1. Completing any in-flight request (or timing it out within 2000ms).
2. Flushing any buffered writes.
3. Sending `SIGTERM` to any child processes they own.
4. Exiting within `stop_timeout_ms`.

This contract is enforced at two levels:

**Authoring-time enforcement:** `libs/authoring/src/templates/mcp-server/` and
`libs/authoring/src/templates/service/` generate a compliant signal handler stub in the
scaffolded entrypoint:

```typescript
// Generated in soxe init mcp-server / service entrypoints:
process.on('SIGTERM', () => {
  // TODO: complete in-flight requests, flush writes.
  // soxe guarantees SIGKILL after stop_timeout_ms if this handler does not exit.
  process.exit(0);
});
```

**Validate-time enforcement:** `soxe validate` (and the `--strict` flag) checks that any
`background: true` extension's entrypoint source file contains a `SIGTERM` handler. The check
is textual (grep for `'SIGTERM'` or `"SIGTERM"`), not semantic. This is explicitly a weak
check — it prevents accidental omission, not intentional bypass. The warning text:

```
validate: WARNING: no SIGTERM handler found in entrypoint.
  mcp-server and service extensions must handle SIGTERM gracefully.
  See docs/guidelines/signal-contract.md
```

This is a warning, not a hard error in this phase. Making it a hard error requires a survey of
all existing extensions to ensure compliance first.

---

## 8. Health Surface (R7)

### `soxe status` command

```
soxe status [--id=<extId>] [--project=<path>] [--scope=user|project|local] [--json] [--lines=<n>]
```

**Default behavior (no flags):** read `~/.sox/supervisors.json`, run the stale-GC probe on
every entry (see Section 2), then for each live supervisor read its `runtimeFilePath` and
live-probe every extension it manages. Output is a multi-row health table with one row per
extension across all supervisors on the machine.

**Filtering flags:**

- `--id=<extId>` — filter rows to extensions whose id matches. May match across multiple
  projects (e.g. two projects both running `memory-server`). When exactly one match is found,
  the output switches to the detailed single-extension view (log tail, full uptime, run history).
  When multiple matches exist, the table view is shown with all matching rows.
- `--project=<path>` — filter to extensions whose supervisor's `root` equals or is a prefix
  of the given path. Accepts absolute path or a basename that is unambiguous.
- `--scope=<scope>` — filter by scope (`user`, `project`, `local`).
- `--json` — emit a JSON array of `HealthRecord` objects, one per extension.

Filters are ANDed. `--id=memory-server --scope=project` returns only project-scope
memory-server instances.

### `HealthRecord` interface

```typescript
interface HealthRecord {
  /** Extension ID as declared in extension.json */
  id: string;
  /** Versioned key as stored in the lockfile (e.g. "memory-server@0.1.0") */
  key: string;
  scope: string;
  /** The supervisor's root directory (--root used at soxe start time).
   *  Required to distinguish two memory-server instances in different projects. */
  root: string;
  /** Basename of root — used in the table PROJECT column for readability */
  project: string;
  /** Stable supervisor identifier: sha256(scope + ":" + root)[0..12] */
  supervisorId: string;
  /** ISO 8601 timestamp when the supervisor activated this extension */
  activatedAt: string;
  /** Elapsed seconds since activatedAt (current session only) */
  uptimeSeconds: number;
  /** OS process check: process.kill(pid, 0) returned true */
  pidAlive: boolean;
  pid: number | null;
  /** Exec socket connectivity (JSON ping round-trip succeeded within 2s) */
  socketReachable: boolean;
  /** Round-trip latency in ms for the socket ping, or null if unreachable */
  socketLatencyMs: number | null;
  /** Last N lines of the extension's log file (default 20, only in detail view) */
  logTail: string[];
  /** Path to the active log file */
  logPath: string | null;
  /** ISO 8601 timestamp when the supervisor last spawned this extension */
  lastStartedAt: string | null;
  /** ISO 8601 timestamp when the extension last stopped, or null if currently running */
  lastStoppedAt: string | null;
  /** Duration in ms of the last completed run, or null if still running or no prior run */
  lastRunDurationMs: number | null;
  /** Cumulative uptime in ms across all runs recorded in the current supervisor session */
  totalUptimeMs: number;
  /** Derived: 'healthy' | 'degraded' | 'dead' */
  status: 'healthy' | 'degraded' | 'dead';
}
```

Status derivation:

| pidAlive | socketReachable | status   | exit code |
|----------|-----------------|----------|-----------|
| true     | true            | healthy  | 0         |
| true     | false           | degraded | 1         |
| false    | (n/a)           | dead     | 2         |

When multiple extensions are probed and any is degraded, the process exits 1. When any is dead,
the process exits 2. When all are healthy, exit 0.

### Socket reachability probe

The exec socket already exists. Sox status sends a `{ list: true }` JSON request to the exec
socket (the existing list protocol in `runtime.ts` line 200). If the round-trip succeeds within
2000ms and returns a valid JSON response, `socketReachable = true`. The latency is measured
from connection open to response parse complete.

This reuses the existing exec socket protocol without any new protocol extension. A dedicated
`ping` MCP call is not needed — the `list` request exercises the full socket stack without
invoking any extension code.

### Run history tracking

The supervisor writes a per-supervisor session file at:

```
~/.sox/logs/<supervisorId>/run-history.json
```

Schema:

```typescript
interface RunHistoryFile {
  version: 1;
  runs: RunRecord[];
}

interface RunRecord {
  extId: string;
  /** ISO 8601 timestamp when the supervisor spawned this extension */
  startedAt: string;
  /** ISO 8601 timestamp when the extension stopped, or null if currently running */
  stoppedAt: string | null;
  /** Exit code from the process, or null if killed by signal or still running */
  exitCode: number | null;
  /** How the process ended */
  stopReason: 'clean' | 'sigterm' | 'sigkill' | 'crash' | null;
}
```

Write path: the supervisor appends a new `RunRecord` (with `stoppedAt: null`) when `_spawn()`
completes. On `stop()`, it patches the most recent matching record with `stoppedAt`, `exitCode`,
and `stopReason`. Writes use the atomic-rename pattern.

`soxe status` reads this file to populate `lastStartedAt`, `lastStoppedAt`, `lastRunDurationMs`,
and `totalUptimeMs` on the `HealthRecord`. If the file is absent (new supervisor, pre-P4), all
four fields default to null/0.

`soxe logs --id=<extId> --history` prints the run history table:

```
EXT             STARTED                   STOPPED                   DURATION  REASON
memory-server   2026-06-18T10:00:00Z      —                         running   —
memory-server   2026-06-17T09:00:00Z      2026-06-17T18:30:00Z      9h 30m    clean
```

### Multi-extension table output (default, no filters or filters matching multiple)

```
ID               VERSION  SCOPE    PROJECT        STATUS    PID     UPTIME      SOCKET
memory-server    0.1.0    project  sox-ecosystem  HEALTHY   84213   2h 14m      12ms
memory-organizer 0.1.0    project  sox-ecosystem  HEALTHY   84214   2h 14m      —
memory-server    0.1.0    project  client-app     DEGRADED  91042   0h 03m      unreachable
```

Columns: ID, VERSION, SCOPE, PROJECT (basename of `root`), STATUS, PID, UPTIME, SOCKET (latency
or `—` for non-socket types, `unreachable` if socketReachable=false).

### Single-extension detail view (when `--id` matches exactly one extension)

```
Extension:    memory-server
Key:          memory-server@0.1.0
Scope:        project
Project:      sox-ecosystem (/Users/nix/dev/ai/sox-ecosystem)
Supervisor:   a3f7b2c9d1e4
Status:       HEALTHY
PID:          84213  (alive)
Socket:       reachable (latency: 12ms)
Uptime:       2h 14m 33s  (started 2026-06-18T10:00:00Z)
Last stop:    never
Total uptime: 2h 14m 33s (this session)
Log:          ~/.sox/logs/a3f7b2c9d1e4/memory-server-2026-06-18.log

--- Last 20 log lines ---
[memory-server] Listening on stdio
[memory-server] memory_ping: ok
...
```

### JSON output (`--json`)

Emits a JSON array. Single-element arrays are still arrays — callers always get consistent
structure regardless of filter result count.

```json
[
  {
    "id": "memory-server",
    "key": "memory-server@0.1.0",
    "scope": "project",
    "root": "/Users/nix/dev/ai/sox-ecosystem",
    "project": "sox-ecosystem",
    "supervisorId": "a3f7b2c9d1e4",
    "activatedAt": "2026-06-18T10:00:00Z",
    "uptimeSeconds": 8073,
    "pidAlive": true,
    "pid": 84213,
    "socketReachable": true,
    "socketLatencyMs": 12,
    "logTail": ["[memory-server] Listening on stdio", "..."],
    "logPath": "/Users/nix/.sox/logs/a3f7b2c9d1e4/memory-server-2026-06-18.log",
    "lastStartedAt": "2026-06-18T10:00:00Z",
    "lastStoppedAt": null,
    "lastRunDurationMs": null,
    "totalUptimeMs": 8073000,
    "status": "healthy"
  }
]
```

---

## 9. Bundle Co-location and Visibility (R9)

### Target filesystem layout

```
extensions/bundles/<bundle-id>/
  extension.json           ← bundle manifest (already exists at this path for sox-memory-bundle)
  members/
    memory-server/         ← member extension, replaces extensions/mcp-servers/memory-server/
      extension.json
      src/
      dist/
      package.json
      project.json
    memory-organizer/      ← replaces extensions/agents/memory-organizer/
      extension.json
      ...
    memory-flush/          ← replaces extensions/hooks/memory-flush/
      extension.json
      ...
    memory-cli/            ← replaces extensions/commands/memory-cli/
      extension.json
      ...
```

The current `sox-memory-bundle` directory at `extensions/bundles/sox-memory-bundle/` already
exists and already contains the bundle `extension.json`. The members currently live at
`extensions/mcp-servers/memory-server/`, `extensions/agents/memory-organizer/`, etc. Migration
moves them to `extensions/bundles/sox-memory-bundle/members/<id>/`.

### Migration path

Migration is a one-time filesystem restructuring with lockfile and registry updates:

1. `git mv extensions/mcp-servers/memory-server extensions/bundles/sox-memory-bundle/members/memory-server`
2. Repeat for `memory-organizer`, `memory-flush`, `memory-cli`.
3. Update `project.json` `root` for each member project in the Nx workspace to the new path.
4. Update the `source` field in `registry/index.json` and `extensions.lock` to point to the
   new paths.
5. Rebuild registry: `npx tsx scripts/build-index.ts`.
6. Update any e2e tests that reference the old absolute paths.

Backward compatibility: the lockfile `source` field uses `file://` absolute paths. Existing
lockfiles with old paths will fail at install time because the files have moved. This is a
deliberate breaking change — it is acceptable in this phase because the system is pre-1.0 and
the migration is atomic (all member paths change together). No legacy path alias mechanism is
introduced.

### `visibility` field

The `visibility` field lives in the registry index entry (`registry/index.json`) and is
replicated into the extension's `extension.json` as the authoritative source. Accepted values:
`"public"` (default if absent) or `"internal"`.

Registry index entry schema addition:

```typescript
interface IndexEntry {
  // ... existing fields ...
  /** Default: "public". "internal" means the extension is a bundle member and should
   *  not be independently installed or started. */
  visibility?: 'public' | 'internal';
  /** If visibility is "internal", the bundle that owns this member. */
  bundleId?: string;
}
```

`extension.json` addition:

```typescript
// In extension.json for member extensions:
{
  "visibility": "internal",
  "bundle_id": "sox-memory-bundle"
}
```

The `visibility` field in `extension.json` is the source of truth. `build-index.ts` reads it
when building the registry index. The registry index carries it for fast CLI access without
re-reading extension manifests.

### Enforcement

**`build-index.ts`:** When scanning member extensions at
`extensions/bundles/<bundle-id>/members/<member-id>/extension.json`, automatically sets
`visibility: "internal"` and `bundleId: "<bundle-id>"` in the generated index entry, even if
the `extension.json` does not declare it. Members detected by filesystem location are always
internal.

**Installer (`libs/install-engine/src/install.ts`):** Before resolving any entry, check the
registry index for `visibility: "internal"`. If found, abort with:

```
sox: install: "memory-server" is a member of bundle "sox-memory-bundle".
     Install the bundle instead: soxe install sox-memory-bundle
```

**`soxe search`:** By default excludes `visibility: "internal"` entries. Add `--all` flag to
include them (useful for debugging). Bundle entries show their member types inline:

```
sox-memory-bundle  bundle  0.1.0  [mcp-server, agent, hook, command]  sox-memory graph memory subsystem
```

### Bundle start/stop atomicity

`soxe start <bundle-id>` and `soxe stop <bundle-id>` are implemented as sequential iteration
over members, not as a single atomic supervisor unit. The supervisor model is one process per
member extension — this does not change. "Atomic" from the user's perspective means a single
`soxe start sox-memory-bundle` command starts all four members without requiring four separate
commands. At the OS level there are still four child processes.

Start semantics: `soxe start --id=memory-server --id=memory-organizer --id=memory-flush --id=memory-cli`
(the existing `filterIds` option in `StartRuntimeOptions` already supports this). The CLI
resolves `bundle-id → member ids` by reading the bundle's `extension.json` `members` array,
then passes them as `filterIds`.

Stop semantics: symmetrically iterate and stop each member. If any member fails to stop, log
the error and continue stopping the others. Report the failure count at the end.

Start error: if any member fails to start (health check timeout, entrypoint not found), the
bundle start is considered failed. Members that DID start are NOT automatically rolled back in
this phase — rollback adds complexity without sufficient benefit at current scale. The error
message names which member failed.

### `soxe init bundle` authoring change

`soxe init bundle <bundle-id> --member=<type>:<member-id> [--member=...]` scaffolds:

```
extensions/bundles/<bundle-id>/
  extension.json    (with members array pre-filled)
  members/
    <member-id>/
      extension.json  (with visibility: "internal", bundle_id: "<bundle-id>")
      src/index.ts
      package.json
      project.json
```

The authoring template for bundle members inherits the per-type template logic from
`libs/authoring/src/templates/<type>/` but writes output to the bundle's members subdirectory.

---

## 10. Sequencing / Implementation Order

The dependencies and shared code paths drive the order. R4 (log pipeline) must land before
R8 (daemon mode) because daemon mode requires a pre-existing log file to redirect stderr to.
R1 (global registry) must land before R2 (GC) and R7 (status) because both query the registry.
R3 (start lock) is independent and small — ship it first to prevent the concurrent-start bug
from manifesting during R1/R4 work.

| Phase | Items | Rationale |
|-------|-------|-----------|
| **P1** | R3 (start lock) | Isolated change to `runtime.ts` entry point. Prevents the concurrent-start race before any other work begins. Touches one file, zero schema changes. Also includes the `writeRuntimeRecord` atomic-write fix (Section 11, add-1) since both touch `runtime.ts`. |
| **P2** | R5 (process group), R6 (two-phase shutdown + signal contract) | Both are changes to `supervisor.ts` `_spawn()` and `stop()`. They share the same diff. R5 adds `detached: true`; R6 extends the SIGTERM→SIGKILL sequence to use `process.kill(-pgid)`. Signal contract enforcement in `libs/authoring` templates goes here too. |
| **P3** | R4 (log pipeline) | New `LogManager` class, changes to `supervisor.ts` data handlers, new `~/.sox/logs/` directory layout. Also introduces `run-history.json` write path in the supervisor (required by R7/P7). Standalone — no other phase depends on it being first, but R8 and R7 both block on it. |
| **P4** | R1 (global registry) | New `~/.sox/supervisors.json`, self-registration in `startRuntime`, self-deregistration in `stopRuntime`. Also includes socket path canonicalization to `~/.sox/supervisors/<supervisorId>.sock` (Section 11, add-2). No GC logic yet. Adds `soxe list --all`. |
| **P5** | R2 (stale GC) | New `gc.ts` probeEntryLiveness, integrated into `cmdList` and `cmdStatus`. Depends on R1 (registry file must exist). |
| **P6** | R8 (daemon mode) | Depends on R4 (log file path known before spawn). Adds `--daemon` flag to `cmdStart`. Depends on R1 (registry must be written so `soxe stop` can find the daemon). |
| **P7** | R7 (health surface) | New `soxe status` command (multi-row default, filter flags, detail view, run history). Depends on R1 (registry for supervisor enumeration and socket path), R4 (log tail and run-history.json). |
| **P8** | R9 (bundle co-location) | Filesystem migration + registry/installer changes. Most cross-cutting. Isolated last because it requires coordinated changes to `build-index.ts`, `install.ts`, `main.ts`, `loader.ts`, and the authoring templates. A feature branch per-bundle-id is the safest approach. |
| **P9** | Section 12 (global install registry) | New `~/.sox/install-registry.json`, `soxe list --global` mode, and `soxe upgrade --all`. Shares install engine touched in P8. Ships last because it depends on the install engine being stable after the R9 bundle changes, and adds no new runtime coupling. |

### Shared code changes by item

| File | Changed by |
|------|-----------|
| `libs/host-runtime/src/supervisor.ts` | R5, R6, R4 (log stream hookup), P3 (run-history writes) |
| `libs/host-runtime/src/runtime.ts` | R1, R3, R6 (deregistration), add-1 (atomic write fix) |
| `libs/host-runtime/src/lock.ts` (new) | R3 |
| `libs/host-runtime/src/log-manager.ts` (new) | R4 |
| `libs/host-runtime/src/gc.ts` (new) | R2 |
| `libs/host-runtime/src/registry.ts` (new) | R1 |
| `apps/sox/src/main.ts` | R1 (`--all`), R4 (`soxe logs`), R7 (`soxe status`), R8 (`--daemon`), R9 (bundle start/stop dispatch), Section 12 (`--global` mode on `soxe list`, `soxe upgrade --all`) |
| `libs/install-engine/src/install.ts` | R9 (visibility enforcement), Section 12 (install-registry write) |
| `libs/authoring/src/templates/mcp-server/` | R6 (SIGTERM stub) |
| `libs/authoring/src/templates/service/` | R6 (SIGTERM stub) |
| `libs/authoring/src/templates/bundle/` | R9 (member co-scaffolding) |
| `scripts/build-index.ts` | R9 (auto-visibility for bundle members) |
| `registry/index.json` | R9 (visibility + bundleId fields) |
| `extensions/bundles/sox-memory-bundle/` | R9 (member migration) |

### Breaking changes

| Change | Impact |
|--------|--------|
| Moving member extensions to `extensions/bundles/<bundle-id>/members/<id>/` | Existing lockfile `source` paths become invalid. Any installed environment must re-run `soxe install`. |
| `visibility: internal` on bundle members | `soxe search` stops returning them by default. Operators using `soxe install memory-server` directly get a hard error. |
| `detached: true` on spawned extensions | Extensions that assumed their parent PID was the supervisor's PID will see a different PGID. No known extension makes this assumption in the current codebase. |

No lockfile version bump is required for any of these changes. The lockfile schema
(`Lockfile.lockfileVersion: 1`) remains at 1. The `bundle_id` field in `LockfileEntry`
(`libs/install-engine/src/install.ts` line 44) already exists and carries the bundle
association. No new top-level field is added to the lockfile in this phase.

---

## 11. Additions / Improvements

Two issues were identified during the architecture review that are not in R1–R9 but belong
in this phase.

### A11-add-1: Atomic writes for `writeRuntimeRecord`

`writeRuntimeRecord` in `runtime.ts` (line 541) uses `fs.writeFileSync` directly, not an
atomic write. A concurrent reader that opens `runtime.json` mid-write will read partial JSON
and `JSON.parse` will throw. The existing `try/catch` in `readRuntimeRecord` (line 534) masks
this as `null`, which then appears as "no runtime" to `cmdList`. Fix:

```typescript
function writeRuntimeRecord(filePath: string, record: RuntimeRecord): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}
```

This fix should land in P1 alongside R3 (both touch `runtime.ts`).

### A11-add-2: Socket path canonicalization

The exec socket path is currently computed as:

```typescript
const execSocketPath = path.join(path.dirname(opts.runtimeFilePath), '.sox-exec.sock');
```

This places the socket inside the scope's config directory (e.g.
`.extensions/.sox-exec.sock`), which is project-specific. With the global registry (R1),
sockets must be discoverable from `~/.sox/supervisors.json`. The canonical socket path should
be:

```
~/.sox/supervisors/<supervisorId>.sock
```

This is short enough to avoid the 104-byte Unix socket path limit on macOS (the supervisorId
is 12 hex chars; the full path is `~/.sox/supervisors/a3f7b2c9d1e4.sock` = approximately 45
characters even with a long home directory), globally locatable, and does not pollute project
directories.

This change must land in P4 (R1) since R1 reads `execSocketPath` from the registry to
implement `soxe list --all` and `soxe stop` for daemons.

---

## 12. Global Install Registry (P9 — new capability)

### Purpose

The global supervisor registry (Section 1) tracks what is running. The install registry tracks
what has ever been installed, where, at what version, and when. Together they answer the full
operational picture:

- `soxe upgrade memory-server --all` — re-run install for every project that has `memory-server`
  installed, updating to the latest registry version.
- Audit: "which projects are still pinned to `memory-server@0.1.0`?"
- Usage analytics: how widely is each extension deployed across the machine?

The install registry is machine-local and concerns only the current user's installs. It is not
a shared or synced artifact.

### File location

```
~/.sox/install-registry.json
```

`SOX_HOME` overrides the prefix, consistent with all other `~/.sox/` files.

### Schema

```typescript
interface InstallRegistry {
  version: 1;
  installs: InstallRecord[];
}

interface InstallRecord {
  /** Extension ID (bare, no version) */
  extId: string;
  /** Version resolved at install time (e.g. "0.1.0") */
  version: string;
  /** Scope under which the extension was installed */
  scope: 'user' | 'project' | 'local';
  /** Absolute path to the root directory used at install time (the --root value) */
  root: string;
  /** ISO 8601 timestamp of the first install of this extId+scope+root combination */
  installedAt: string;
  /** ISO 8601 timestamp of the most recent `soxe install` that touched this record */
  updatedAt: string;
  /** Source URI from the lockfile entry at install time (file:// or https://) */
  source: string;
}
```

The natural key for deduplication is `(extId, scope, root)`. If the same extension is
reinstalled or updated at the same scope+root, the existing record is updated in place
(`version`, `updatedAt`, `source` are refreshed; `installedAt` is preserved).

### Write path

`libs/install-engine/src/install.ts` — at the point where a lockfile entry is written (after
`fetchArtifact` succeeds, approximately line 588 in the current file), append or update a
record in `~/.sox/install-registry.json` using atomic rename. The write is best-effort:
if it fails (e.g. permissions, NFS), log a warning and continue — a failed install-registry
write must never fail the install.

```typescript
// In install.ts, after writing the lockfile entry for a resolved extension:
try {
  upsertInstallRecord({
    extId: entry.id,
    version: resolvedVersion,
    scope: opts.scope,
    root: opts.root,
    source: resolvedSource,
  });
} catch (e) {
  console.warn(`install: warning: could not update install registry: ${String(e)}`);
}
```

`upsertInstallRecord` lives in a new `libs/install-engine/src/install-registry.ts` module
(not inlined in `install.ts` to keep the install loop readable).

### CLI

**`soxe list --global`**

Queries `~/.sox/install-registry.json` and displays one row per `InstallRecord`. No live
probing — this mode works without any supervisor running. Accepts the same filter flags as
other `soxe list` modes: `--id=<ext>`, `--scope=<scope>`, `--json`.

```
soxe list --global
soxe list --global --id=memory-server
soxe list --global --scope=project
soxe list --global --json
```

Human table output — note the column set differs from the default `soxe list` view. STATUS and
PID are replaced by INSTALLED and UPDATED because install records carry no live running state:

```
ID               VERSION  SCOPE    PROJECT         INSTALLED             UPDATED
memory-server    0.1.0    project  sox-ecosystem   2026-06-01T09:00Z     2026-06-18T12:00Z
memory-server    0.1.0    project  client-app      2026-06-10T14:00Z     2026-06-10T14:00Z
memory-organizer 0.1.0    project  sox-ecosystem   2026-06-01T09:00Z     2026-06-18T12:00Z
```

Columns: ID, VERSION, SCOPE, PROJECT (basename of `root`), INSTALLED (ISO date, truncated to
minute), UPDATED (ISO date, truncated to minute). Full `root` paths and full timestamps are
available via `--json`.

JSON output: a JSON array of `InstallRecord` objects.

**`soxe upgrade <ext-id> --all`**

For each `InstallRecord` matching `ext-id`, verify the extension is still present in that
project's current lockfile before attempting an upgrade (see "Upgrade safety check" below),
then re-run install with the appropriate `root` and `scope`. Reports success/failure per
project:

```
soxe upgrade memory-server --all

Upgrading memory-server in 2 projects:
  [1/2] /Users/nix/dev/ai/sox-ecosystem (scope: project) ... done (0.1.0 → 0.2.0)
  [2/2] /Users/nix/dev/client-app (scope: project)       ... done (0.1.0 → 0.2.0)

2 upgraded, 0 failed.
```

`soxe upgrade` does not modify `process.cwd()` — it invokes `install()` from
`libs/install-engine` directly with the appropriate `root` and `scope` options, the same
way `cmdInstall` does for the current directory. No shell subprocess is spawned.

### Removal path

`soxe uninstall` must remove the corresponding `InstallRecord` from `~/.sox/install-registry.json`
after successfully removing the lockfile entry.

`libs/install-engine/src/install-registry.ts` exports:

```typescript
export function removeInstallRecord(
  extId: string,
  scope: string,
  root: string,
): void {
  const registryPath = resolveInstallRegistryPath();
  const registry = readInstallRegistry(registryPath);
  const filtered = registry.installs.filter(
    (r) => !(r.extId === extId && r.scope === scope && r.root === root),
  );
  if (filtered.length === registry.installs.length) return; // no-op: no matching record
  writeInstallRegistryAtomic(registryPath, { version: 1, installs: filtered });
}
```

The natural key is `(extId, scope, root)` — the same triple used for upsert. If no matching
record exists the function is a no-op.

Integration in `apps/sox/src/main.ts` `cmdUninstall`: call `removeInstallRecord` immediately
after the lockfile entry is successfully removed. The call is best-effort — a failed registry
write must not fail the uninstall:

```typescript
// In cmdUninstall, after removing the lockfile entry:
try {
  removeInstallRecord(id, scope, root);
} catch (e) {
  process.stderr.write(
    `sox: warning: could not update install registry: ${String(e)}\n`,
  );
}
```

Root resolution: if `soxe uninstall --id=<ext> --scope=<scope>` is invoked without `--root`,
default to `process.cwd()`. This matches the install-time behaviour — `getScopePaths` for
`project` and `local` scopes already uses the cwd-derived root — so the `(extId, scope, root)`
key will align with the record written at install time as long as the user runs `soxe uninstall`
from the same directory they ran `soxe install`.

### Upgrade safety check

Before re-running install for a given `InstallRecord`, `soxe upgrade --all` must verify the
extension still appears in that project's current lockfile. This guards against a race where
`soxe uninstall` ran but `removeInstallRecord` failed (best-effort write), leaving a stale entry
that `soxe upgrade --all` would otherwise blindly reinstall.

```typescript
// In cmdUpgrade, for each InstallRecord before calling install():
import { getScopePaths, loadLockfile } from '@adhd/sox-install-engine';

const { lockfile: lockfilePath } = getScopePaths(record.scope, record.root);
const lockfile = loadLockfile(lockfilePath);
const inLockfile = lockfile !== null &&
  Object.keys(lockfile.resolved).some(
    (k) => k === record.extId || k.startsWith(`${record.extId}@`),
  );

if (!inLockfile) {
  process.stdout.write(
    `soxe upgrade: skipping ${record.extId} @ ${path.basename(record.root)} ` +
    `(not in current lockfile — run soxe install to re-add)\n`,
  );
  continue;
}
```

`loadLockfile` already exists in `libs/install-engine/src/install.ts` and is exported from
the package. `getScopePaths` is already exported from `libs/host-runtime/src/runtime.ts`.
No new dependencies are introduced by this check.
