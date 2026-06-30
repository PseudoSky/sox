# SCOPE — runtime-productionization

**Status:** implemented — design + all phases P1–P9 shipped (committed `3282512` P1 … `dc56cc1` P9)  
**Next step:** none for this scope; the architect design lives at [IMPLEMENTATION.md](./IMPLEMENTATION.md) and every requirement R1–R9 is delivered (see [Phase status](#phase-status))  
**Identified by:** fullstack-developer, session 2026-06-15  

> **Phase status (verified 2026-06-21, plan-orchestrator):** all nine phases are committed —
> `3282512` P1 (start lock + atomic write + socket canon), `e495067` P2 (process group +
> two-phase shutdown + SIGTERM stubs), `b9cb982` P3 (log pipeline), `21a754d` P4 (global
> registry + `soxe list --all`), `94e7327` P5 (stale GC), `3a95564` P6 (daemon mode),
> `dbe9439` P7 (health surface / `soxe status`), `24cb5fe` P8 (bundle co-location + visibility),
> `dc56cc1` P9 (global install registry). Deliverable files `lock.ts`, `log-manager.ts`,
> `gc.ts`, `registry.ts` are committed; `soxe status/--all/--daemon/logs` are wired in `main.ts`.
> The "scoping / architect must design" language below is retained as historical record only.  

---

## Problem Statement

The soxe host runtime was built to satisfy the EIM plan's DoD (service lifecycle, permission
enforcement, exec routing). That work is complete and audited. What it did not address is
production-grade process management: the runtime currently cannot guarantee that what it
reports is true, cannot contain extension side-effects, and has no operational story for
logs, workers, or clean shutdown.

The gaps are not theoretical. Any real deployment will hit them.

---

## Identified Gaps

### 1. Global service discovery is blind

There is no machine-wide registry of running soxe supervisors. `soxe list` reads one
`runtime.json` for one scope+directory. Five simultaneous `soxe start --scope=project`
invocations in five different project directories are invisible to each other and to any
top-level `soxe list`.

**Impact:** operators cannot see what is running; monitoring pipelines have no enumeration
point; `soxe list --all` is not implementable without a global index.

---

### 2. Stale state is never cleaned up

`runtime.json` and (if built) a global `supervisors.json` are written on start and
removed on clean stop. An unexpected process death (SIGKILL, OOM, kernel reboot) leaves
stale entries. Nothing reads those files and validates them against reality before
reporting state.

**Impact:** `soxe list` can report RUNNING for a process that died hours ago. Any
health-gate built on top of that output is wrong.

**Partial mitigation available:** lazy GC on every read via `process.kill(pid, 0)` + exec
socket liveness probe. Not yet implemented.

---

### 3. Concurrent `soxe start` for the same scope+directory races

The idempotent check in `startRuntime()` reads `runtime.json` and bails if it exists.
Two simultaneous `soxe start` invocations can both pass that check before either has
written the file, producing two supervisors for the same scope. No advisory lock is held.

**Impact:** duplicate supervisor processes, duplicate socket paths, undefined behavior.

---

### 4. No log management

Extensions write to their own stderr. The supervisor receives it via a pipe and currently
either suppresses it or lets it fall to the parent terminal. There is no log file, no
rotation, no `soxe logs --id=<ext>` command, no structured log format.

**Impact:** production debugging requires attaching to the terminal that ran `soxe start`.
Log output from long-running daemons is permanently lost after the terminal closes.

---

### 5. Worker processes are invisible and unmanaged

soxe spawns one child process per extension (the entrypoint). If that process spawns
workers, soxe has no visibility into them. On `soxe stop`, only the direct child receives
`SIGTERM`. Workers are orphaned — they continue running, potentially holding file locks,
ports, or database connections.

**Impact:** `soxe stop` does not actually stop the service in the presence of workers. The
extension appears stopped; its resources are not released.

---

### 6. No SIGKILL escalation — stop is not guaranteed

`supervisor.ts` `stop()` sends `SIGTERM` and waits. If the extension ignores `SIGTERM`
(bug, hang, or intentional), the supervisor logs a warning and moves on. The process
remains running. `stop_timeout_ms` in the lifecycle block is parsed but not enforced with
a SIGKILL escalation.

**Impact:** `soxe stop` is advisory, not authoritative. Orphaned processes accumulate.

---

### 7. Signal handling is unenforced by contract

There is no framework requirement that extensions handle `SIGTERM` gracefully. Extensions
that do not propagate the signal to their own workers, flush buffers, or release locks
will corrupt state on stop/restart. The framework has no way to detect or enforce this.

---

### 8. No monitoring surface

There is no structured way to ask "is this extension healthy right now?" beyond reading
a JSON file that may be stale (gap 2). The exec socket exists and can be probed, but
there is no `soxe status --id=<ext>` command that combines pid liveness + socket
reachability + last-health-check result into a single authoritative answer.

---

## What "production-grade" looks Like (requirements, not design)

An architect should design a solution that satisfies all of the following. No
implementation decisions are made here.

| Requirement | Success condition |
|-------------|-------------------|
| **R1 — global enumeration** | `soxe list --all` returns every running supervisor on the machine with accurate state, regardless of which directory started it |
| **R2 — self-healing state** | Any `soxe list` or `soxe status` call validates reported state against OS reality before returning it; stale entries are removed |
| **R3 — safe concurrent start** | Two simultaneous `soxe start` invocations for the same scope+directory are serialised; exactly one supervisor starts |
| **R4 — log persistence** | Every extension's stdout+stderr is written to a rotating log file; `soxe logs --id=<ext> [--follow]` streams it |
| **R5 — complete stop** | `soxe stop` terminates the extension's entire process tree (direct child + workers); SIGTERM is followed by SIGKILL after `stop_timeout_ms` |
| **R6 — signal contract** | The framework defines and enforces a minimum signal-handling contract for extensions; the authoring scaffold generates a compliant handler |
| **R7 — live health surface** | `soxe status --id=<ext>` returns a structured, reality-verified health record (pid alive, socket reachable, last tool-call latency, log tail) |

---

---

### 9. No daemon mode — `soxe start` occupies the terminal

`soxe start` keeps the parent process alive and attached to the terminal. There is no
`--daemon` flag to detach the supervisor and return the shell prompt. No log file path
is communicated. Stopping a daemonised supervisor requires knowing its pid or using
`soxe stop` from the same directory.

**Impact:** `soxe start` cannot be used in scripts, CI, or anything that expects the
command to return. Running it in a background shell (`&`) loses stderr entirely.

**Note:** The log path display and `--id` selective start have been partially shipped
(the startup message now prints the runtime record path). Full daemon mode requires
the log pipeline design from gap 4 — they must be designed together.

---

### 10. Bundle members pollute the top-level extension namespace

Bundles expand into multiple independently-addressable extensions at install time
(e.g. `sox-memory-bundle` → `memory-server`, `memory-organizer`, `memory-flush`,
`memory-cli`). Each member lives in its own top-level type directory
(`extensions/mcp-servers/`, `extensions/agents/`, etc.), making a single logical
unit scatter across four separate directories with no on-disk grouping.

The consequence is both structural and UX:

- **Filesystem**: a bundle with 8 members produces 8 top-level directories with no
  obvious relationship. Adding a ninth requires touching 3 files and 3 directories.
- **Registry**: members appear as independently searchable, installable, and startable
  extensions. Users see `memory-server` as a standalone item and may try to install or
  start it directly, which produces confusing or broken behaviour.
- **Authoring**: `soxe init bundle` scaffolds the bundle manifest but does not co-locate
  members; the authoring contract has no concept of "member lives under its bundle".

**Desired model (requirements, not design):**

- Members are co-located under their bundle directory (e.g.
  `extensions/bundles/sox-memory-bundle/members/memory-server/`) so the filesystem
  mirrors the logical grouping.
- Members are invisible to `soxe search` and `soxe install` by default
  (`visibility: internal` or equivalent); only the bundle entry is surfaced.
- A direct `soxe install memory-server` or `soxe start memory-server` produces a helpful
  error: "memory-server is part of sox-memory-bundle — install the bundle instead."
- `soxe start <bundle-id>` / `soxe stop <bundle-id>` operate atomically on all members.
- The registry schema gains a `visibility` field; `build-index.ts` and the installer
  enforce it.
- The authoring scaffold for `bundle` co-scaffolds members inside the bundle directory.

---

## What "production-grade" looks Like (requirements, not design)

An architect should design a solution that satisfies all of the following. No
implementation decisions are made here.

| Requirement | Success condition |
|-------------|-------------------|
| **R1 — global enumeration** | `soxe list --all` returns every running supervisor on the machine with accurate state, regardless of which directory started it |
| **R2 — self-healing state** | Any `soxe list` or `soxe status` call validates reported state against OS reality before returning it; stale entries are removed |
| **R3 — safe concurrent start** | Two simultaneous `soxe start` invocations for the same scope+directory are serialised; exactly one supervisor starts |
| **R4 — log persistence** | Every extension's stdout+stderr is written to a rotating log file; `soxe logs --id=<ext> [--follow]` streams it |
| **R5 — complete stop** | `soxe stop` terminates the extension's entire process tree (direct child + workers); SIGTERM is followed by SIGKILL after `stop_timeout_ms` |
| **R6 — signal contract** | The framework defines and enforces a minimum signal-handling contract for extensions; the authoring scaffold generates a compliant handler |
| **R7 — live health surface** | `soxe status --id=<ext>` returns a structured, reality-verified health record (pid alive, socket reachable, last tool-call latency, log tail) |
| **R8 — daemon mode** | `soxe start --daemon` detaches the supervisor, writes logs to a managed file, prints the log path, and returns exit 0 to the caller; `soxe logs --id=<ext> [--follow]` streams the log |
| **R9 — bundle co-location and visibility** | Bundle members live under their bundle's directory; they are hidden from search/install by default; direct member install/start produces a helpful redirect; `soxe start/stop <bundle-id>` is atomic |

---

## Out of Scope for This Plan

- OS-kernel sandboxing (explicit non-goal from C6)
- Multi-machine / distributed supervisor coordination
- Extension hot-reload
- Resource quotas (CPU/memory limits)

---

## Next Step

**An architect must design the ideal version before any implementation begins.**

The architect's deliverable is a design document at
`.workflow/plans/runtime-productionization/DESIGN.md` covering:

**Runtime & process management (gaps 1–9):**

1. The data model for the global supervisor registry (file format, location, locking strategy)
2. How state is validated and garbage-collected (lazy vs eager, probe protocol)
3. The concurrency model for `soxe start` (lockfile, flock, atomic rename, or other)
4. Log pipeline architecture (pipe routing, file format, rotation policy, streaming API)
5. Daemon mode: how `--daemon` detaches, where logs go, how `soxe logs` streams them
6. Process group strategy for worker containment (pgid, cgroup, or other)
7. Two-phase shutdown protocol (SIGTERM → timeout → SIGKILL; integration with `stop_timeout_ms`)
8. The signal-handling contract for extensions and how it is enforced at authoring time
9. The `soxe status` data model and its API surface

**Bundle architecture (gap 10):**
10. The target filesystem layout for co-located bundle members (migration path from
    current scattered layout; backward compatibility with existing lockfiles and e2e tests)
11. The `visibility` field schema: where it lives (extension.json vs registry only),
    what values it accepts, how `build-index.ts`, the installer, and the CLI each enforce it
12. The atomic start/stop protocol for bundles: whether the supervisor treats the bundle
    as a single unit or whether each member remains individually addressable at the
    process level
13. Authoring changes: how `soxe init bundle` co-scaffolds members, what the generated
    directory layout looks like, and how `soxe validate` enforces co-location

The design must address how each of R1–R9 is satisfied and must explicitly state
any trade-offs made (e.g. lazy GC vs eager GC; flock vs atomic rename; registry-only
visibility vs extension.json field).

Implementation should not begin until the design is reviewed and approved.
