# Service & Daemon Lifecycle — Canonical Specification

**Spec version:** 1.0.0
**Status:** Draft — binding on merge (design/standards only; no production code changed by this document)
**Date:** 2026-06-25
**Owner:** platform-engineering
**Applies to:** every code path that spawns, supervises, stops, reaps, health-checks, or persists a `service`- or `mcp-server`-type extension, across all scopes (`org` / `user` / `project` / `local`, plus the notion of *global*).

> **This document is the law.** Any agent modifying `libs/host-runtime/src/supervisor.ts`,
> `libs/host-runtime/src/runtime.ts`, `libs/host-runtime/src/reaper.ts`,
> `libs/host-runtime/src/{lock,registry,gc,log-manager}.ts`, or the
> `cmdStart` / `cmdStop` / `cmdServe` / `cmdList` / `cmdStatus` / `cmdEnable` / `cmdDisable` /
> `cmdUninstall` / `cmdUpgrade` regions of `apps/sox/src/main.ts` **MUST** read this spec first and
> conform to the invariants in §13. Deviations require an ADR superseding the relevant section.

---

## Table of Contents

1. [Scope & relationship to runtime-productionization](#1-scope--relationship-to-runtime-productionization)
2. [Service taxonomy & execution models](#2-service-taxonomy--execution-models)
3. [Identity & discovery](#3-identity--discovery)
4. [Scope semantics](#4-scope-semantics)
5. [The singleton invariant](#5-the-singleton-invariant)
6. [Lifecycle state machine](#6-lifecycle-state-machine)
7. [Start](#7-start)
8. [Stop & reap](#8-stop--reap)
9. [Reboot persistence & the OS-supervisor control surface](#9-reboot-persistence--the-os-supervisor-control-surface)
10. [Split-brain avoidance](#10-split-brain-avoidance)
11. [Health model](#11-health-model)
12. [Failure-mode catalog](#12-failure-mode-catalog)
13. [Invariants checklist + Rules agents MUST follow](#13-invariants-checklist--rules-agents-must-follow)
14. [Phased refactor roadmap](#14-phased-refactor-roadmap)
15. [Appendix A — proposed CLAUDE.md pointer](#appendix-a--proposed-claudemd-pointer)
16. [Appendix B — `(unverified)` assumptions a human should confirm](#appendix-b--unverified-assumptions-a-human-should-confirm)

Supporting material that does not fit the authoritative flow lives under
[`docs/spec/service-lifecycle/`](./service-lifecycle/) and is referenced inline. This file is the
single authoritative entry point.

---

## 1. Scope & relationship to runtime-productionization

### 1.1 What this spec governs

The end-to-end lifecycle of long-lived extension processes: **identity**, **discovery**,
**singleton enforcement**, **start**, **health**, **stop**, **reap**, **reboot persistence**, and
**split-brain reconciliation** between sox's own runtime tracking and any OS supervisor.

It does **not** re-specify already-shipped primitives — it builds on them and names precisely where
they fall short.

### 1.2 What runtime-productionization (P1–P9) already delivers

The `runtime-productionization` plan shipped all nine phases (`.workflow/plans/runtime-productionization/SCOPE.md:3-13`, verified 2026-06-21). The primitives this spec builds **on**:

| Primitive | File | What it gives us |
|---|---|---|
| Start lock (R3) | `libs/host-runtime/src/lock.ts` — `acquireStartLock`, `computeSupervisorId` | O_EXCL-create lock under `runDir()/locks/<supervisorId>.lock` with stale-holder detection via `process.kill(pid,0)` (`lock.ts:50-104`). |
| Global supervisor registry (R1) | `libs/host-runtime/src/registry.ts` — `registerSupervisor`, `deregisterSupervisor`, `SupervisorRegistryEntry` | Machine-wide `supervisors.json` (atomic write, dedup by `supervisorId`); records `pid`, `runtimeFilePath`, `execSocketPath`, `logDir`, `hostname` (`registry.ts:25-147`). |
| Stale-state GC (R2) | `libs/host-runtime/src/gc.ts` — `readGlobalRegistry`, `probeEntryLiveness` | Lazy GC: every registry read probes `process.kill(pid,0)` **AND** exec-socket connect; pid-alive-but-socket-dead ⇒ treated dead (`gc.ts:68-88`), cleans entry + marks runtime.json `running=false` + unlinks stale socket (`gc.ts:101-144`). |
| Log pipeline (R4) | `libs/host-runtime/src/log-manager.ts` | Per-extension rotating logs + `run-history.json`; supervisor pipes child stdout/stderr (`supervisor.ts:317-330`). |
| Process-group + two-phase shutdown (R5/R7) | `libs/host-runtime/src/supervisor.ts` — `stop()` | `detached:true` (`supervisor.ts:310`) → new pgid; `stop()` signals `-pgid` SIGTERM, waits `stop_timeout_ms`, escalates `-pgid` SIGKILL (`supervisor.ts:165-217`). |
| Verified-stop + identity reaper (BL-31) | `libs/host-runtime/src/reaper.ts` — `killAndVerify`, `findOrphansByIdentity`, `reapByIdentity`, `snapshotProcesses`, `identityToken`, `argvContainsToken` | SIGTERM → poll `process.kill(pid,0)` → SIGKILL escalation → re-verify (`reaper.ts:111`); orphan discovery by **entrypoint path as a whitespace-bounded argv token** so PPID-1 detached daemons are found and unrelated processes spared (`reaper.ts:216-250`). |
| Per-extension identity reap (BL-31) | `libs/host-runtime/src/runtime.ts` — `reapOrphansForExtension` | Resolves the entrypoint `source` from runtime.json then lockfile, derives the token, reaps by identity **excluding the live supervisor pid** (`runtime.ts:575-616`). |
| Daemon mode (R8) | `apps/sox/src/main.ts` `cmdStart` `--daemon` branch (`main.ts:2978-3017`) | Re-spawns detached supervisor child with `--_daemon-child`, logs to `supervisor-<date>.log`, returns exit 0. |
| Health surface (R7) | `apps/sox/src/main.ts` `cmdStatus` (`main.ts:3731`) | pid liveness + socket reachability + run stats. |
| Data-root model (ADR-0004) | `libs/host-runtime/src/data-paths.ts` (`runDir`, `supervisorsPath`, `logDirFor`) | One resolver for locks/runtime/logs/registry under `$SOX_ECOSYSTEM_HOME` (default `~/.adhd/sox-ecosystem/`). |

### 1.3 Where P1–P9 fall short (this spec's mandate)

P1–P9 productionized the **in-supervisor** path. They do not close these four gaps:

1. **Detached service-mode reaping at the OS-supervisor boundary.** The BL-31 identity reaper *does*
   find and SIGTERM PPID-1 orphaned daemons by entrypoint token, and it *is* wired into both
   `cmdStop` (`main.ts:3284-3298`) and the `cmdStart` pre-spawn dedup guard (`main.ts:2941-2968`).
   **What is missing** is reaping an instance that an **OS supervisor (launchd/systemd) will
   immediately respawn** — killing the pid without unloading the unit produces an infinite
   resurrection loop. The reaper has no notion of "first unload the OS unit, then kill." (§8.4, §9.)
   > **Correction to BACKLOG BL-50.** BL-50's "Still open: the orphan-process reaper" (`BACKLOG.md:159-162`)
   > is **stale relative to the code** — the entrypoint-token reaper exists and is wired in.
   > The *genuinely* open half of fault-1 is the **OS-supervisor-aware** reap (unload-then-kill),
   > which only matters once §9 lands. This spec re-scopes BL-50 accordingly (§14, Slice 1).

2. **Cross-scope singleton enforcement.** The new start-time guard (`resolveServiceHealthSocketPath` +
   `probeUnixSocketLive`, `main.ts:3060-3081`, `main.ts:3537-3599`) probes the declared health socket
   before spawning — but the socket path is derived from the *scope-resolved* config env. Two scopes
   that resolve the **same** `db_path`/`sock_path` (e.g. user and project both pointing at
   `~/.memory/memory.db`) get two daemons on one store. The singleton key today is effectively
   per-`(socket-path)`, not per-`(id, scope, store)`, and there is no cross-scope collision check. (§4, §5.)

3. **OS reboot persistence.** There is no launchd/systemd control surface (BL-51). A `service`-type
   extension does not survive logout/reboot, and a hand-rolled plist was trialed then reverted
   (`BACKLOG.md:182-186`). (§9.)

4. **Split-brain between sox runtime.json/global-registry and the OS supervisor.** Once an OS unit
   exists, `sox list` reading runtime.json can disagree with launchd reality. There is no authority
   order and no reconcile pass that includes the OS supervisor. (§10.)

This spec defines the framework that closes all four, building on §1.2 primitives, never re-proposing them.

---

## 2. Service taxonomy & execution models

A "service" in this ecosystem is any extension that runs as a **long-lived process**. There are four
distinct execution models. Conflating them is the root of most lifecycle defects, so they are named
and contracted separately.

| # | Model | Manifest signal | Who owns lifecycle | How liveness is known | How it is stopped |
|---|---|---|---|---|---|
| **M1** | **In-supervisor (tracked)** | `type: service`/`mcp-server`, started via `sox start` lockfile path → `startRuntime` (`main.ts:3144`) | The live sox supervisor process (`ProcessSupervisor`, `supervisor.ts:93`) | In-process `_proc.exitCode === null` + `_probeHealth` (`supervisor.ts:411-449`); registry GC verifies the **supervisor's** pid/socket | `supervisor.stop()` → `-pgid` SIGTERM→SIGKILL (`supervisor.ts:165-217`) |
| **M2** | **Detached service-mode daemon (PPID→1)** | `type: service` started via the service-registry path (`main.ts:3030-3128`): `spawnChild(..., {detached:true, stdio:'ignore'}); child.unref()` (`main.ts:3084-3092`) | **Nobody live** — the spawning sox process exits 0; the daemon reparents to PID 1 | Health socket probe (`probeUnixSocketLive`, `main.ts:3537`) + identity-token process scan (`findOrphansByIdentity`, `reaper.ts:216`) | Identity-token reap (`reapOrphansForExtension`, `runtime.ts:575`) — find by entrypoint argv token, `killAndVerify` |
| **M3** | **stdio / on-demand mcp-server (client-spawned)** | `type: mcp-server`, `lifecycle.health.type: stdio-ping` (e.g. `memory-server/extension.json`) | The **MCP client** (Claude Code) spawns `soxe serve <id>` (`cmdServe`, `main.ts:4433`) per connection; lifetime = the stdio pipe | The client owns the pipe; sox does not track it. (No durable pid record — see BL-46.) | Client closes stdin/the pipe → process exits. sox does not stop it. |
| **M4** | **OS-supervised unit (launchd / systemd)** *(proposed, §9)* | `type: service` with `sox service enable` having generated a unit | The OS supervisor (launchd `KeepAlive` / systemd `Restart`) | OS query (`launchctl print` / `systemctl --user is-active`) **plus** the health socket | `sox service disable` (unload the unit) **then** identity reap any survivor |

**Key consequences of the taxonomy:**

- **M2 is the dangerous one.** Because no live process tracks it, every guarantee (singleton, stop,
  health) must be reconstructed from OS reality (process table + socket + ownership index). This is
  the model behind the BL-50 two-writer incident (`BACKLOG.md:166-175`).
- **M3 is intentionally untracked by sox.** sox must **never** try to "stop" an M3 server — the
  client owns it. sox's only M3 responsibility is the singleton guard at *spawn* time (a second
  client connection must reuse, not duplicate, the writer — see §5.4) and durable stderr logging.
  **BL-46 status:** `cmdServe` now has an **opt-in** durable stderr sink (`--log` flag or
  `SOX_SERVE_LOG=1` env tees stderr to `<logDir>/<extId>-serve-<date>.log` while leaving stdout — the
  JSON-RPC channel — untouched; default remains `stdio:'inherit'`, `main.ts:4552-4561`). The framework
  should make this sink the **default for M4** units (§9.2) so the live served version is always
  observable (BL-46, `BACKLOG.md:246-264`).
- **M4 supersedes M2 for persistence.** Once §9 ships, a `service` that needs reboot persistence runs
  as M4, and M2 becomes a transitional/`--daemon`-only fallback. M4's stop is *unload-then-reap*.
- A single extension may be **promoted** M2 → M4 by `sox service enable` (§9) or run as M1 under an
  attached `sox start`. The framework must reconcile whichever model is live (§10).

`(unverified)` — M3 has no durable pid/runtime record today; `cmdServe` writes no runtime.json entry
and defaults to `stdio:'inherit'` (an opt-in stderr sink exists via `--log`/`SOX_SERVE_LOG=1`,
`main.ts:4552-4561`). The §5.4 M3 singleton guard therefore relies on the health-socket probe alone,
which is sufficient for the *shared-store* invariant but cannot enumerate M3 servers in `sox list`.
Confirm acceptable.

---

## 3. Identity & discovery

The canonical question is: **"Is instance X already running, and which `(id, scope, root, store)` is
it?"** Five signals exist today; they must be combined into one source of truth with a defined
authority order.

### 3.1 The five signals

| Signal | Source | Strength | Weakness |
|---|---|---|---|
| **S1 — content address** | `artifactChecksum` (ADR-0003; ownership index `appliedHash`, ADR-0004 §D5) | Identifies *which code* an instance runs | Says nothing about whether it is *running* |
| **S2 — entrypoint argv token** | `identityToken(source)` → absolute `dist/index.js` path, matched whitespace-bounded in `ps` argv (`reaper.ts:190-250`) | Finds **any** live process running this exact artifact, even PPID-1, even absent from runtime.json | Cannot distinguish two scopes running the *same* artifact path; relies on `ps` |
| **S3 — health socket** | `lifecycle.health.endpoint` (socket type) resolved through `${SOX_CONFIG_*}`+tilde (`resolveServiceHealthSocketPath`, `main.ts:3560`) | Confirms the service is *answering* | Only meaningful for socket-health services; a shared socket path conflates scopes |
| **S4 — pid record** | `runtime.json` entry `pid` + `supervisorPid`; global `supervisors.json` (`registry.ts`) | Authoritative *when the supervisor is live* and GC-verified (`gc.ts`) | Goes stale on M2/crash; M2 records `pid:null` for a pre-existing instance (`main.ts:3075`) |
| **S5 — ownership index** | `ownership.json` `(extId, scope)` → materialize store path + config keys (ADR-0004 §D5) | The authoritative record of *what an install owns*, per scope | Records ownership, not runtime state |

### 3.2 The single source of truth: the **Instance Descriptor**

Define a derived, in-memory **Instance Descriptor** computed on demand (never persisted as a new
file — it is a *view* over S1–S5):

```
InstanceDescriptor {
  id            // extension id
  scope         // org|user|project|local
  root          // the scope root used to resolve config/store
  storePath     // materialized store dir (S5)  ── the SINGLETON KEY anchor (§5)
  entrypoint    // absolute dist/index.js (S2 token)
  artifactHash  // content address (S1)
  model         // M1 | M2 | M3 | M4 (§2)
  pid           // best-known pid (S4 / S2 scan); null if unknown-but-live
  healthSocket  // resolved socket path (S3) or null
  liveness      // 'healthy' | 'live-unverified' | 'dead'  (§3.3)
  owner         // 'supervisor' | 'os-unit' | 'client' | 'none'
}
```

### 3.3 Reconciliation procedure (the authority order)

To answer "is X running and which instance is it," compute liveness in this **fixed order**, taking
the first authoritative answer:

1. **Live supervisor (S4 + GC).** If `supervisors.json` has a GC-live entry
   (`readGlobalRegistry`, `gc.ts:161` — pid alive **and** exec socket reachable) whose runtime.json
   lists `id` with `running:true` and a live pid → **model M1**, `owner: supervisor`,
   `liveness: healthy`. Authoritative; stop here.
2. **OS unit (S-launchd/systemd)** *(when §9 lands).* If an OS unit exists for `(id, scope)` and the
   OS reports it loaded/active → **model M4**, `owner: os-unit`. Liveness then refined by S3.
3. **Health socket (S3).** If a socket-health endpoint resolves and `probeUnixSocketLive` succeeds →
   `liveness: healthy`. If no live supervisor/unit claims it → **model M2**, `owner: none`.
4. **Entrypoint scan (S2).** If `findOrphansByIdentity(token)` returns a live process not claimed
   above → **model M2**, `owner: none`, `liveness: live-unverified`, `pid` = the matched pid,
   `orphaned` if PPID 1.
5. **Else** → `liveness: dead`.

> **Authority rule `[auth:supervisor-then-os-then-os-reality]`:** a live, GC-verified supervisor (1)
> outranks an OS unit (2), which outranks bare socket/process reality (3–4). `sox list` MUST render
> the descriptor's `liveness`/`owner`, never a raw runtime.json `running` flag. This is the
> generalization of the existing C4 pid-liveness gate (`sox list` validates `process.kill(pid,0)`
> before reporting RUNNING) to the OS-supervisor world.

`(unverified)` — step 2 depends on §9 not yet built; today the order is effectively 1 → 3 → 4 → 5,
which is what `cmdStart`'s guard and `cmdStop`'s reap already implement piecewise.

---

## 4. Scope semantics

### 4.1 The four scopes + "global"

Per CLAUDE.md and ADR-0004 §D2, each scope resolves to a distinct data root via
`dataRoot(scope, root)`:

| Scope | Data root | Notes |
|---|---|---|
| `org` | `<orgRoot>/.adhd/sox-ecosystem/` | |
| `user` (a.k.a. **global**) | `$SOX_ECOSYSTEM_HOME` (default `~/.adhd/sox-ecosystem/`) | "global" = the user/machine-wide scope; reachable by every session (ADR-0004 §D4) |
| `project` | `<project>/.adhd/sox-ecosystem/` | deterministic; no per-project override |
| `local` | `<project>/.adhd/sox-ecosystem/` (shares project root, distinct lockfile) | |

Each scope therefore has its **own** lockfile, config, runtime.json, ownership index, and materialize
store (`ext/<id>/`). The supervisor id is `sha256(scope + ":" + root)[0..12]`
(`computeSupervisorId`, `lock.ts:24-27`) — so scope+root already key the lock, runtime record, and
global-registry entry distinctly.

### 4.2 Per-scope sockets, db_paths, runtime.json

The runtime/lock/registry layer is **correctly scope-partitioned** (distinct `supervisorId`). The
hazard is in **config-derived resource paths**: `db_path`, `sock_path`, `port` come from
`buildExtConfigEnv` which merges **all four scopes** narrowest-wins (`main.ts:204-225`). So:

- A user-scope and project-scope install of `memory-daemon` that both leave `sock_path` at its default
  (`~/.memory/memoryd.sock`, `memory-daemon/extension.json` config_schema) resolve the **same socket**
  and the **same db**. The S3 singleton guard then *correctly* prevents the second spawn — but only
  because the socket collides; if a project overrides `sock_path` but not `db_path`, you get **two
  sockets, one db = two writers** (the exact BL-50 fault, generalized cross-scope).

### 4.3 The singleton key

> **Definition `[def:singleton-key]`:** the singleton key is **`(id, resolved-store-resource)`**,
> where the store-resource is the **canonical absolute `db_path`** (or, for non-store services, the
> canonical bound resource — socket path for socket services, `host:port` for http services). It is
> **NOT** `(id, scope)` and **NOT** the socket path alone.

Rationale: the invariant being protected is **"one writer per backing store"** (one daemon per
`memory.db`, one proxy per port). Two scopes pointing at the same db must collapse to one instance;
one scope pointing at two dbs (unusual but legal) is two instances. Keying on the store resource —
not the scope, not the socket — is the only key that expresses the real invariant.

### 4.4 Cross-scope collision rules

1. **Same store, different scopes ⇒ one instance.** The first start (any scope) wins; subsequent
   starts in other scopes that resolve the same `[def:singleton-key]` **MUST NOT spawn**; they record
   the existing instance as RUNNING in their own runtime.json (mirroring the current S3 guard at
   `main.ts:3063-3080`) and emit a "shared with scope X" notice.
2. **Different store, same id ⇒ independent instances** (legal; each has its own singleton key).
3. **`sox stop` at a scope** stops/reaps only instances whose singleton key is owned by that scope's
   install **unless** the instance is shared (rule 1), in which case stop is refused with a notice
   that another scope still references the store (prevents one scope's stop from yanking the store out
   from under another). `sox stop --all` / `sox doctor` may force-reap.

`(unverified)` — rule 3's "shared-store refuse-to-stop" is a new policy; today `cmdStop` reaps by
entrypoint token regardless of cross-scope sharing. Confirm this is the desired safety stance vs.
"last-stop-wins."

---

## 5. The singleton invariant

### 5.1 Formal statement

> **`[inv:singleton]`** — For every singleton key `K = (id, store-resource)` (§4.3), **at most one**
> service process may be live at any instant. A service declares it opts into this with
> `lifecycle.singleton: true` (`memory-daemon`, `tokenguard` both set it; `memory-server` does not —
> it is M3, see §5.4).

### 5.2 Enforcement at start

The start path MUST, **before spawning**, in order:

1. Resolve `K` (canonical `db_path`/bound resource, expanded through `buildExtConfigEnv` +
   tilde + `${VAR}`).
2. **Probe the health socket** if declared (`resolveServiceHealthSocketPath` + `probeUnixSocketLive`,
   already implemented, `main.ts:3060-3081`).
3. **Scan the process table** for the entrypoint token (`findOrphansByIdentity`, `reaper.ts:216`) —
   catches a live instance whose socket is not yet bound or is a non-socket service.
4. **Check cross-scope ownership** (§4.4 rule 1): consult ownership indices of all scopes for the same
   store-resource.
5. If any of 2–4 finds a live instance → **do not spawn**; record it RUNNING; emit notice. Else
   acquire the start lock (`acquireStartLock`, `lock.ts:50`) and spawn.

> **Gap closed:** today only step 2 runs in the M2 service-registry path. Steps 3–4 must be added so
> a socket-overriding-but-db-sharing collision (§4.2) cannot produce two writers. The
> `cmdStart` pre-spawn dedup *reap* (`main.ts:2941-2968`) handles a *stale* instance; the singleton
> *guard* must handle a *live* instance (don't reap a healthy shared daemon, reuse it).

### 5.3 Enforcement at reconcile

The reconcile pass (§10) recomputes the Instance Descriptor for every installed singleton service. If
it finds **two live processes for one `K`** (two pids matching the entrypoint token on the same store):

1. Pick the **survivor** deterministically: prefer the one a live supervisor/OS-unit owns; else the
   oldest by start time (lowest pid as a tiebreak is `(unverified)` portable — prefer `ps -o lstart`).
2. `killAndVerify` the loser(s) (`reaper.ts:111`).
3. Log a `[singleton-violation healed]` line and surface it in `sox doctor`.

### 5.4 M3 (stdio mcp-server) singleton

M3 servers (`memory-server`) are spawned per client connection and `singleton` is **not** set. The
invariant they must still honor is **shared-store safety**: many M3 server processes may exist (one
per client) but they all use **synchronous single-connection better-sqlite3** on the same db, which
serializes harmlessly (`BACKLOG.md:316-321`). The actual writer-contention danger is an M3 server
**plus** an M2/M4 daemon both writing — which §5.1's key catches because they share the db resource.
So: an M3 server may coexist with *other M3 servers* but its spawn (`cmdServe`) MUST NOT proceed to
*also start a daemon* on the same store without the §5.2 guard.

`(unverified)` — whether `cmdServe` ever auto-starts a daemon today; it does not appear to
(`cmdServe` runs the server entrypoint only, `main.ts:4433`). The BL-47 in-process fallback means no
daemon need run. Confirm `cmdServe` will not gain daemon-autostart without the guard.

### 5.5 Detection & healing summary

| When | Mechanism | Where |
|---|---|---|
| Start | §5.2 guard (socket + process scan + cross-scope) | `cmdStart` |
| Reconcile / `sox list` / `sox doctor` | §5.3 — recompute descriptor, heal duplicates | reconcile pass (§10) |
| Stop | identity reap by token (`reapOrphansForExtension`) | `cmdStop` |
| Crash | GC marks runtime.json `running:false`; next start re-guards | `gc.ts` |

---

## 6. Lifecycle state machine

States and the **only** legal transitions. Each transition names the command/event that drives it.

```
                 install                 sox start / service enable
   (absent) ───────────────▶ INSTALLED ───────────────────────────▶ STARTING
                                  │  ▲                                   │
                          uninstall  │ disable (config)                 │ spawn ok + lock held
                                  ▼  │                                   ▼
                              (absent)│                            ┌── HEALTHY ◀──┐
                                      │            health ok       │              │ health recovers
                                      │   ┌────────────────────────┘              │
                                      │   │  health fails (probe)                 │
                                      │   ▼                                       │
                                      │ DEGRADED ──────────────────────────────▶─┘
                                      │   │  crash-loop / give-up                  ▲
                                      │   ▼                                        │ restart (backoff)
                                      │ STOPPING ◀── sox stop / service disable / SIGTERM
                                      │   │
                                      │   ▼ verified exit (killAndVerify)
                                      └ STOPPED ──(orphan survives)──▶ REAPED ──▶ STOPPED
```

| Transition | Driver | Implementation anchor |
|---|---|---|
| absent → INSTALLED | `install()` | install-engine; ownership index recorded (ADR-0004 §D5) |
| INSTALLED → STARTING | `sox start` / `sox service enable` | `cmdStart` (`main.ts:2851`) / §9 |
| STARTING → HEALTHY | spawn ok + first health probe passes | `supervisor.start` → `_waitForHealth` (`supervisor.ts:135-154`) |
| STARTING → STOPPED (failed) | spawn fails / health timeout | `_waitForHealth` throws (`supervisor.ts:406`) |
| HEALTHY → DEGRADED | periodic health probe fails | `_startHealthLoop` (`supervisor.ts:451-458`) |
| DEGRADED → HEALTHY | probe recovers | health loop |
| DEGRADED → STARTING | restart on unexpected exit (backoff) | `_respawn` (`supervisor.ts:366`); §11.3 crash-loop guard |
| any → STOPPING | `sox stop` / `service disable` / SIGTERM | `cmdStop` (`main.ts:3191`), `supervisor.stop` (`supervisor.ts:165`) |
| STOPPING → STOPPED | verified exit | `killAndVerify` (`reaper.ts:111`) |
| STOPPED → REAPED → STOPPED | orphan survives stop, reaped by identity | `reapOrphansForExtension` (`runtime.ts:575`) |
| INSTALLED ⇄ (disabled) | `sox disable` / `sox enable` | `cmdDisable`/`cmdEnable` (`main.ts:2161-2326`) — config flag + SIGHUP reconcile |

**Rule `[inv:no-illegal-transition]`:** code MUST NOT report or assume a state not reachable by an
edge above. In particular, "RUNNING" in any UI maps to HEALTHY **or** DEGRADED with a live pid — never
to a runtime.json flag alone (`[auth:...]`, §3.3).

---

## 7. Start

The authoritative start sequence (unifying the lockfile/M1 path and the service-registry/M2 path,
and the future M4 path):

1. **Resolve scope paths** (`getScopePaths`, `main.ts:2858`) and the runtime/lock/log paths via the
   ADR-0004 data-root resolver.
2. **Acquire the start lock** (`acquireStartLock(computeSupervisorId(scope, root))`, `lock.ts:50`).
   This serializes concurrent `sox start` for the same scope+root (R3). Released after the runtime
   record is written.
3. **Build config env** (`buildExtConfigEnv`, `main.ts:204`) → `SOX_CONFIG_*` for db_path, sock_path,
   port, etc. (cascade org→user→project→local, tilde + `${VAR}` expanded).
4. **Singleton guard** (§5.2): resolve `[def:singleton-key]`, probe socket (`probeUnixSocketLive`),
   scan entrypoint token, check cross-scope ownership. If live → record-and-skip; if stale →
   pre-spawn reap (`reapOrphansForExtension`, already wired `main.ts:2941-2968`).
5. **Env-scrub allowlist** (enforced path only): the supervisor scrubs child env to a minimal
   allowlist + `NODE_*` + `SOX_EMBED_*` + `XDG_CACHE_HOME`, then layers extension env, then policy env
   (`supervisor.ts:269-290`). **BL-52 note:** `SOX_EMBED_BACKEND`, `SOX_EMBED_CACHE_DIR`,
   `XDG_CACHE_HOME`, and any `SOX_EMBED_*` are explicitly forwarded so the embed backend resolves to
   real BGE/ONNX instead of silently falling back to hash (`supervisor.ts:266-284`). Any future
   service-required env var added to the scrub allowlist MUST be documented here.
6. **Spawn** `detached: true` (new pgid, `supervisor.ts:307-312` for M1; `main.ts:3084-3092` for M2),
   cwd = materialized store dir (`storePath`, ADR-0004) so no monorepo siblings are on the path.
7. **Health gate** (§11): wait for first health probe (`_waitForHealth`, socket / stdio-ping /
   http-get / port.txt), then start the periodic loop.
8. **Write the runtime record + register the supervisor** (`registerSupervisor`, `registry.ts:108`)
   so `sox list --all` and the GC pass can see it. Release the start lock.

> **Concurrent-start safety** is the start lock (step 2) **plus** the singleton guard (step 4): the
> lock prevents two *supervisors* for one scope+root; the guard prevents two *daemons* for one store
> across scopes/models.

---

## 8. Stop & reap

### 8.1 The signal contract

> **`[contract:signal]`** — every service process MUST treat **SIGTERM** as "drain and exit": stop
> accepting work, flush buffers, release locks/db connections/sockets, propagate SIGTERM to its own
> workers, and exit within `lifecycle.stop_timeout_ms` (default 5000ms,
> `memory-daemon`/`tokenguard` both declare 5000). A service that ignores SIGTERM **will** be SIGKILLed
> and may corrupt state — that is the service's bug, not the framework's. The authoring scaffold MUST
> generate a compliant SIGTERM handler (R6).

### 8.2 Two-phase, process-group teardown (M1)

`supervisor.stop()` (`supervisor.ts:165-217`):

1. set `_stopping=true` (prevents the restart loop), clear the health timer, deregister from the
   in-process registry.
2. **Phase 1:** `process.kill(-pid, 'SIGTERM')` — the **whole process group** (child + workers),
   enabled by `detached:true` at spawn. Falls back to `proc.kill` if pid unassigned.
3. Wait `stop_timeout_ms`.
4. **Phase 2:** `process.kill(-pid, 'SIGKILL')` if still alive; wait 2000ms; if *still* alive, log
   `CRITICAL ... D state ... manual intervention` and mark unhealthy (`supervisor.ts:204-212`).
5. Close the log stream.

### 8.3 Verified stop (BL-31, M1 + M2)

`cmdStop` (`main.ts:3191-3326`):

- **Supervisor path** (no `--id`, supervisorPid recorded): `killAndVerify(supervisorPid)` (SIGTERM →
  poll ESRCH → SIGKILL → re-verify, `reaper.ts:111`), then **for every entry**, identity-reap orphans
  (`reapOrphansForExtension`) — so a daemon whose supervisor already died (PPID-1) is still killed.
- **Per-id path:** `stopRuntime` (verifies + escalates internally) **plus** a belt-and-suspenders
  identity reap (`main.ts:3307-3323`).
- **Exit code is honest:** `cmdStop` exits **1** if any reap returns `undead` (`main.ts:3300`, `:3324`)
  — `sox stop` does not lie about success.

### 8.4 The orphan reaper (closing the genuinely-open half of BL-50)

The entrypoint-token reaper (`reapByIdentity` / `findOrphansByIdentity`) already finds PPID-1 M2
daemons and `killAndVerify`s them, whitespace-bounded so unrelated processes are spared
(`reaper.ts:236-250`). **What §9 adds** is the **OS-supervisor-aware** reap:

> **`[inv:unload-then-reap]`** — before killing a pid that an OS unit may own, the stop path MUST
> first **unload the OS unit** (`launchctl bootout` / `systemctl --user stop+disable`), THEN
> `killAndVerify` any survivor by identity token. Killing first guarantees an immediate launchd/systemd
> respawn (resurrection loop). This is the missing piece the BACKLOG calls "the reaper" — the
> token reaper exists; the *unload-first ordering* does not, because there is no OS unit yet.

### 8.5 `sox stop` reap ordering (authoritative)

```
stop(scope, [id]):
  for each target instance descriptor D (§3):
    if D.owner == 'os-unit':  unload unit (§9)            # [inv:unload-then-reap]
    if D.owner == 'supervisor': killAndVerify(supervisorPid); supervisor signals its groups
    reapOrphansForExtension(D.id)                          # identity-token reap survivors (M2)
    verify: findOrphansByIdentity(token) == []            # nothing left
  exit 1 if any 'undead'                                   # honest exit code
```

---

## 9. Reboot persistence & the OS-supervisor control surface

This subsumes **BL-51** and the reboot half of **BL-50**.

### 9.1 The control surface

```
sox service enable  <ext> [-s <scope>]   # generate + load an OS unit; record ownership; record in runtime tracking
sox service disable <ext> [-s <scope>]   # unload + remove the unit; reap survivor; clear ownership
sox service status  <ext> [-s <scope>]   # show the unit state reconciled with sox (§10)
sox service list                          # all sox-owned OS units across scopes
```

`sox service` is a **new top-level verb** routed in `apps/sox/src/main.ts` (alongside `start`/`stop`,
`main.ts:98-144`). It is the **only** sanctioned way to create an OS unit. **Hand-writing a plist or
unit file is forbidden** (`[inv:os-unit-generated]`) — exactly the trial-and-revert the BACKLOG
records (`BACKLOG.md:182-186`).

### 9.2 Unit generation (from the manifest)

The unit is **derived from the `lifecycle` block + resolved config env**, never hand-authored:

| Manifest / resolved value | launchd key | systemd key |
|---|---|---|
| node path + `--enable-source-maps` + entrypoint | `ProgramArguments` | `ExecStart` |
| `buildExtConfigEnv` output (SOX_CONFIG_*) + BL-52 SOX_EMBED_* | `EnvironmentVariables` | `Environment=` |
| store dir (ADR-0004 `ext/<id>`) | `WorkingDirectory` | `WorkingDirectory=` |
| `lifecycle.background:true` ⇒ run at load | `RunAtLoad: true` | `WantedBy=default.target` |
| `lifecycle.singleton:true` ⇒ keep alive | `KeepAlive: true` (+ `Crashed`) | `Restart=on-failure` |
| crash-loop guard (§11.3) | `ThrottleInterval` (≥10s) | `RestartSec` + `StartLimitIntervalSec`/`StartLimitBurst` |
| durable logs (ADR-0004 `run/logs/`) | `StandardOutPath`/`StandardErrorPath` | `StandardOutput=append:` |

- **Unit paths:** macOS `~/Library/LaunchAgents/com.sox.<scope>.<ext>.plist`; Linux
  `~/.config/systemd/user/sox-<scope>-<ext>.service`. Scope is in the label so per-scope instances do
  not collide.
- **Stable node path:** resolve a non-volatile node (not a transient nvm shim) and pin it in
  `EnvironmentVariables`/`Environment`. `(unverified)` — exact resolution strategy (e.g.
  `process.execPath` realpath'd, or a `which node` snapshot) needs a human decision; a volatile nvm
  path in a plist is a known footgun (BL-51, `BACKLOG.md:200`).

### 9.3 Idempotent + content-addressed re-enable on upgrade

> **`[inv:os-unit-content-addressed]`** — `sox service enable` is idempotent: re-running it (or an
> `upgrade` that changes the resolved entrypoint/args/artifactHash) **rewrites** the unit only if the
> generated content differs, then reloads it. It MUST NEVER leave a unit pointing at a stale artifact
> (this is the launchd analogue of the BL-39 re-materialize fix, ADR-0004 §D6). The ownership index
> (ADR-0004 §D5) records the unit as an owned `os-unit` entry with its `appliedHash`.

The `upgrade --all` flow (CLAUDE.md AGENT SEQUENCE step 5) MUST, after re-materializing a changed
service store, re-run `sox service enable` for any extension that has an owned OS unit, so the unit
follows the new artifact.

### 9.4 Teardown hooks

- `sox uninstall <service>` MUST tear down its OS unit (consume the ownership `os-unit` entry →
  unload + delete file) before removing the store — `[inv:reversible-injection]` (ADR-0004 §D6a)
  generalizes to OS units.
- `sox doctor` MUST surface orphaned/duplicate OS units and units whose artifact no longer matches the
  installed checksum (stale unit detection).

---

## 10. Split-brain avoidance

"Split-brain" = sox's runtime.json/global-registry disagreeing with OS-supervisor reality, so
`sox list` lies.

### 10.1 Authority order

The reconcile authority order is `[auth:supervisor-then-os-then-os-reality]` (§3.3): live GC-verified
supervisor > OS unit state > bare socket/process reality. Whichever is highest and authoritative wins
the descriptor's `owner`/`liveness`.

### 10.2 The reconcile pass

Run on every `sox list`, `sox status`, `sox doctor`, and as a step inside `sox start`/`stop`:

1. `readGlobalRegistry()` — GC-prune dead supervisors (already implemented, `gc.ts:161`).
2. For each installed singleton service across all scopes, compute the Instance Descriptor (§3.3).
3. **Reconcile runtime.json ⇄ OS unit:**
   - runtime.json says running, OS unit says not loaded, no live process → mark `running:false`
     (stale; GC already does this for dead supervisors, `gc.ts:114-132`).
   - OS unit loaded + healthy, runtime.json missing the entry → adopt it (write a runtime entry with
     `owner: os-unit`) so `sox list` shows it.
   - **Two live processes for one singleton key** → heal per §5.3.
4. Render `sox list` strictly from the reconciled descriptors. `running:true` in a file is **never**
   sufficient to render RUNNING (`[auth:...]`, the C4 generalization).

### 10.3 `sox list` never lies

> **`[inv:list-never-lies]`** — `sox list` MUST render reality-verified descriptors only. A pid is
> RUNNING iff `process.kill(pid,0)` succeeds **and** (for socket-health services) the socket answers
> **and** (for M4) the OS unit is loaded. This already holds for M1 (C4); §9/§10 extend it to M4.

---

## 11. Health model

### 11.1 Declared health types

From the real manifests + supervisor (`supervisor.ts:411-449`):

| `lifecycle.health.type` | Probe semantics | Example | Source |
|---|---|---|---|
| `socket` | Unix-socket connect (no protocol bytes); healthy iff connect succeeds within `timeout_ms` | `memory-daemon` (`endpoint: ${SOX_CONFIG_SOCK_PATH}`) | `probeSocket` (`supervisor.ts:481-498`), `probeUnixSocketLive` (`main.ts:3537`) |
| `stdio-ping` | Process-alive proxy: healthy iff `_proc.exitCode === null` | `memory-server` (M3) | `supervisor.ts:440-442` |
| `http-get` | HTTP GET, healthy on any 2xx; `${PORT}` resolved from `storePath/port.txt` | `tokenguard` (`http://127.0.0.1:${PORT:-9099}/_tokenguard/health`) | `probeHttp` (`supervisor.ts:505-531`), port.txt poll (`supervisor.ts:386-397`) |
| `command` | Process-alive proxy (placeholder) | — | `supervisor.ts:444-446` |

Defaults: `interval_ms` 5000 (loop), `timeout_ms` 5000 (first probe) / 2000 (per probe)
(`supervisor.ts:148-152`, `:416`). Manifests override (memory-daemon: 30000/5000).

### 11.2 Probe ⇒ state

- First probe within `_waitForHealth` deadline → STARTING → HEALTHY (`supervisor.ts:380-409`).
- Periodic probe in `_startHealthLoop` sets `_healthy` each tick (`supervisor.ts:451-458`); a false
  result is DEGRADED (the descriptor reflects it; restart policy below).

### 11.3 Restart / backoff / crash-loop guard

- On **unexpected** exit (`!_stopping`), the supervisor restarts with exponential backoff
  `min(5000, 200 * 2^restartCount)` ms (`supervisor.ts:351-362`).
- **Crash-loop guard `[inv:crash-loop-cap]`** *(to standardize):* after N restarts within a window
  (proposed N=5 within 60s), stop restarting, mark the service **DEGRADED (give-up)**, log a durable
  `[crash-loop]` line, and surface it in `sox status`/`doctor`. For M4, this maps to launchd
  `ThrottleInterval` / systemd `StartLimitBurst`. `(unverified)` — the in-supervisor path currently
  has unbounded backoff-capped restarts (no give-up); confirm N/window before implementing.

### 11.4 Restart-on-unhealthy

A DEGRADED service (health probe failing but process alive) is **not** auto-killed today — the health
loop only flips the flag. Standardize: a service that stays DEGRADED for `>` (proposed) 3 consecutive
intervals MAY be restarted (`supervisor.restart`, `supervisor.ts:226-236`) under the crash-loop cap.
`(unverified)` — confirm whether degraded-restart is desired or whether DEGRADED should be reported
only (operator decides). Default recommendation: **report, do not auto-restart on health-only
degradation** (auto-restart only on actual process exit) to avoid thrashing a slow-but-alive service.

---

## 12. Failure-mode catalog

In the style of the CLAUDE.md constraint catalogs: each concrete failure, its detection, and remedy.

| # | Failure | Detection | Remedy |
|---|---|---|---|
| F1 | **Two writers on one store** (two daemons on `~/.memory/memory.db`) — BL-50 | `findOrphansByIdentity(token)` returns ≥2 live, or two pids on same `[def:singleton-key]` | §5.2 start guard prevents the *new* one; §5.3 reconcile heals an existing pair (kill loser); cross-scope check (§4.4) covers socket-overriding-db-sharing |
| F2 | **Orphan survives `sox stop`** (PPID-1, supervisor gone) — BL-50/BL-31 | `cmdStop` runs `reapOrphansForExtension` per entry; post-stop `findOrphansByIdentity` non-empty | identity-token `killAndVerify` (implemented `main.ts:3284-3298`); exit 1 if `undead` |
| F3 | **OS unit respawns a killed pid** (resurrection loop) — §9 | killed pid reappears with new pid under same token within seconds | `[inv:unload-then-reap]`: unload unit *before* kill (§8.4/§8.5) |
| F4 | **Stale runtime.json** (RUNNING for a dead pid) | GC: `process.kill(pid,0)` fail OR socket dead (`gc.ts:68-88`) | `cleanUpDeadEntry`: mark `running:false`, unlink socket (`gc.ts:101-144`); `sox list` reconcile (§10) |
| F5 | **Socket leak** (stale `.sock` after crash) | socket file exists but connect fails (`probeUnixSocketLive` false) | GC unlinks stale socket (`gc.ts:135-137`); start guard distinguishes live-socket from stale-file |
| F6 | **Split-brain** (runtime.json ⇄ launchd disagree) — §10 | reconcile pass compares descriptor `owner`/`liveness` vs runtime.json flag | §10.2 reconcile; `[auth:...]` authority order; `[inv:list-never-lies]` |
| F7 | **Scope collision** (user + project resolve same db, different sockets) — §4.2 | cross-scope ownership-index check at start (§5.2 step 4) | refuse second spawn; record shared (§4.4 rule 1) |
| F8 | **Download/build-on-spawn hang** | health first-probe timeout (`_waitForHealth` throws, `supervisor.ts:406`) | self-contained materialized store (ADR-0004 / bundled-extension-build-standard memory) — no network/build at spawn; fail fast on timeout |
| F9 | **Concurrent `sox start` race** (two supervisors, one scope) — R3 | second `acquireStartLock` blocks/throws (`lock.ts:50-104`) | start lock; stale-holder auto-clear via `kill(pid,0)` |
| F10 | **Worker orphaned on stop** (child spawned grandchildren) — R5 | only direct child killed | `detached:true` pgid + `-pgid` signal (`supervisor.ts:182-202`) |
| F11 | **SIGTERM ignored** (hung/D-state process) | `killAndVerify` still alive after grace | SIGKILL escalation; CRITICAL log + `undead` + exit 1 (`supervisor.ts:204-212`, `main.ts:3300`) |
| F12 | **Stale OS unit after upgrade** (unit → old artifact) — §9.3 | `sox doctor`: unit `appliedHash` ≠ installed checksum | `[inv:os-unit-content-addressed]`: re-`enable` on upgrade rewrites unit |
| F13 | **M3 stderr lost** (stdio serve has no logs by default) — BL-46 | no `~/.sox/logs` entry for live `serve` version when neither `--log` nor `SOX_SERVE_LOG=1` is set | opt-in stderr sink exists (`main.ts:4552-4561`); make it the **default** for M4 units (§9.2); never write diagnostics to stdout (corrupts JSON-RPC) |
| F14 | **Hash-fallback embedding** (scrubbed SOX_EMBED_*) — BL-48/BL-52 | `memory_ping` `embed_on_hash_fallback:true` | SOX_EMBED_* in scrub allowlist (`supervisor.ts:266-284`) + unit `EnvironmentVariables` (§9.2) |
| F15 | **`sox list` reports RUNNING for OS-unit service it doesn't track** — §10 | reconcile finds OS unit not in runtime.json | adopt into descriptor with `owner:os-unit` (§10.2) |

---

## 13. Invariants checklist + Rules agents MUST follow

### 13.1 Invariants (testable)

- `[inv:singleton]` — at most one live process per `[def:singleton-key] = (id, store-resource)` (§5.1).
- `[def:singleton-key]` — the key is the canonical backing resource (db_path / socket / host:port), **not** scope, **not** socket-alone (§4.3).
- `[auth:supervisor-then-os-then-os-reality]` — liveness authority order: live GC-verified supervisor > OS unit > socket/process reality (§3.3).
- `[inv:list-never-lies]` — RUNNING requires reality-verified liveness; a file flag is never sufficient (§10.3, generalizes C4).
- `[inv:unload-then-reap]` — unload the OS unit before killing the pid (§8.4).
- `[inv:os-unit-generated]` — OS units are generated by `sox service enable` from the manifest; hand-authoring is forbidden (§9.1).
- `[inv:os-unit-content-addressed]` — re-enable on artifact change; never point a unit at a stale artifact (§9.3).
- `[inv:reversible-injection]` (ADR-0004) extends to OS units — uninstall reverses the owned `os-unit` entry (§9.4).
- `[inv:crash-loop-cap]` — bounded restarts; give up + report after N-in-window (§11.3).
- `[contract:signal]` — services drain+exit on SIGTERM within `stop_timeout_ms`, propagating to workers (§8.1).
- `[inv:no-illegal-transition]` — only the §6 state edges are legal.

### 13.2 Rules agents MUST follow when modifying supervisor/service code

1. **Never spawn a service without the §5.2 singleton guard.** Socket probe **and** entrypoint-token
   scan **and** cross-scope ownership check, before `spawn`. (Reaping a *stale* instance is not the
   same as reusing a *live* one — do both correctly.)
2. **Never report RUNNING without reality verification** (`process.kill(pid,0)` + socket/OS as
   applicable). `sox list`/`status` render reconciled descriptors, never raw `running` flags
   (`[inv:list-never-lies]`).
3. **All teardown goes through verified-stop + the identity reaper.** Use `killAndVerify` and
   `reapOrphansForExtension`; honor exit-code honesty (`exit 1` on `undead`). Never signal-and-exit
   without verifying death.
4. **OS units are generated, never hand-edited.** Only `sox service enable|disable` may create/remove
   them. Unload before reaping (`[inv:unload-then-reap]`).
5. **Never widen the env-scrub allowlist silently.** Any new forwarded var (cf. BL-52 SOX_EMBED_*)
   must be added to `supervisor.ts` allowlist **and** documented in §7 step 5 **and** mirrored into
   §9.2 unit env.
6. **Never write service diagnostics to stdout** for an M3 stdio server — it corrupts the JSON-RPC
   channel (BL-46). Use the durable stderr sink.
7. **Respect the singleton key, not the scope.** Cross-scope installs sharing a store collapse to one
   instance (§4.4); do not key singleton logic on scope or socket alone.
8. **Build via nx targets; follow the CLAUDE.md AGENT SEQUENCE** for any artifact change (lint →
   build → `registry:sync-index` → commit → `upgrade --all`), and on upgrade re-`enable` owned OS
   units so they track the new artifact (§9.3).
9. **Reconcile, don't trust.** Any command that displays or acts on service state runs the §10
   reconcile pass first (it is cheap: GC + descriptor compute).
10. **Mark conjecture.** Behavioral claims in code comments and PRs must cite the enforcing
    file/symbol; label unverified assumptions `(unverified)`.

---

## 14. Phased refactor roadmap

BL-50 and BL-51 map onto the framework as the first two slices. Each slice: goal, touched files,
acceptance.

### Slice 1 — Cross-scope singleton + reconcile pass (closes the live half of BL-50/F1/F7)

- **Goal:** the §5.2 start guard scans the entrypoint token and checks cross-scope ownership (not just
  the socket), and a §10 reconcile pass heals an existing duplicate pair.
- **Touched:** `apps/sox/src/main.ts` (`cmdStart` guard region `~3052-3092`, new reconcile helper),
  `libs/host-runtime/src/runtime.ts` (descriptor compute), reuse `reaper.ts` + `gc.ts` + ownership
  index (install-engine).
- **Acceptance:** two scopes resolving the same `db_path` (different sockets) ⇒ exactly one daemon
  (e2e); an injected duplicate pair ⇒ reconcile kills the loser; `sox list` shows the shared instance
  once with `owner` set. No reaping of a healthy shared daemon.

### Slice 2 — `sox service enable|disable` (OS-supervisor control surface, subsumes BL-51 + reboot half of BL-50)

- **Goal:** generate/load/unload launchd (macOS) + systemd (Linux) units from the manifest;
  idempotent + content-addressed; ownership-tracked; `[inv:unload-then-reap]`.
- **Touched:** new `libs/host-runtime/src/os-unit.ts` (generator + load/unload, platform-split),
  `apps/sox/src/main.ts` (new `service` verb routing + `cmdService*`), install-engine ownership index
  (`os-unit` entry kind), `cmdUninstall`/`cmdUpgrade` teardown/re-enable hooks, authoring scaffold
  (signal handler R6, manifest lifecycle defaults).
- **Acceptance:** `sox service enable memory-daemon` writes + loads a plist/unit, survives a simulated
  reboot (unit reload), `sox list` reconciles it (`owner:os-unit`); `disable` unloads + reaps + clears
  ownership; `upgrade` rewrites the unit to the new artifact; `uninstall` leaves zero unit residue
  (reversibility gate, ADR-0004 §D6b style).

### Slice 3 — Crash-loop cap + degraded policy + durable M3 logs (F13/F14, BL-46 closure in-framework)

- **Goal:** `[inv:crash-loop-cap]`, standardized DEGRADED reporting, durable stderr sink for
  `cmdServe`.
- **Touched:** `supervisor.ts` (restart cap), `log-manager.ts` + `cmdServe` (stderr sink),
  `cmdStatus`/`doctor` surfacing.
- **Acceptance:** a crash-looping service gives up + reports after N-in-window; live `serve` version's
  stderr is durably captured; `memory_ping` hash-fallback is impossible to miss.

### Slice 4 — `sox doctor` + full reconcile authority across all scopes (F6/F12/F15)

- **Goal:** one command that computes every descriptor across all scopes, surfaces split-brain, stale
  units, duplicates; the reconcile pass becomes the universal pre-step.
- **Touched:** `apps/sox/src/main.ts` (`cmdDoctor`), reconcile helper, `os-unit.ts` query.
- **Acceptance:** doctor detects an artifact-stale unit, an orphaned unit, a duplicate, a split-brain
  runtime.json, and proposes/executes the remedy.

> **Sequencing rationale:** Slice 1 closes the *correctness* hole (two writers) using only existing
> primitives — highest leverage, lowest risk, no new OS surface. Slice 2 adds the OS surface that
> Slices 3–4 then harden. This ordering means the dangerous F1/F7 bug is gone before the larger M4
> machinery lands.

---

## Appendix A — proposed CLAUDE.md pointer

> **Do not edit `CLAUDE.md` as part of this spec.** The snippet below is the exact `AGENT CONSTRAINT`
> block proposed for insertion (after the existing "BUILD VIA NX TARGETS" constraint), to make this
> spec mandatory reading before any supervisor/service edit.

```markdown
## ⛔ AGENT CONSTRAINT — SERVICE/SUPERVISOR EDITS MUST CONFORM TO THE LIFECYCLE SPEC

Any change to service/daemon lifecycle code — `libs/host-runtime/src/{supervisor,runtime,reaper,
lock,registry,gc,log-manager}.ts`, the `os-unit` generator, or the `cmdStart`/`cmdStop`/`cmdServe`/
`cmdList`/`cmdStatus`/`cmdEnable`/`cmdDisable`/`cmdUninstall`/`cmdUpgrade`/`cmdService*` regions of
`apps/sox/src/main.ts` — **MUST first be read against [`docs/spec/service-lifecycle.md`](./docs/spec/service-lifecycle.md)**
and conform to its §13 invariants. In particular:

- **Never spawn a service without the singleton guard** (socket probe + entrypoint-token scan +
  cross-scope ownership check) — `[inv:singleton]`, key on `(id, store-resource)`, never on scope.
- **Never report RUNNING without reality verification** (`process.kill(pid,0)` + socket/OS unit) —
  `[inv:list-never-lies]`. Render reconciled descriptors, never a raw `running` flag.
- **All teardown goes through verified-stop + the identity reaper** (`killAndVerify` +
  `reapOrphansForExtension`), exit 1 on `undead`. For OS-supervised services, **unload the unit
  before killing the pid** — `[inv:unload-then-reap]`.
- **OS units are generated from the manifest by `sox service enable`, never hand-edited** —
  `[inv:os-unit-generated]` / `[inv:os-unit-content-addressed]` (re-enable on artifact change).
- **Never widen the supervisor env-scrub allowlist silently** — document it in the spec §7 and mirror
  it into the OS unit env (§9.2).

Deviating from the spec requires an ADR superseding the relevant section. The spec is versioned;
cite the section you relied on in your PR.
```

---

## Appendix B — `(unverified)` assumptions a human should confirm

1. **M3 has no durable pid/runtime record** today (`cmdServe` `stdio:'inherit'`, no runtime.json
   entry — BL-46). The M3 singleton guard relies on the socket probe alone and M3 servers are not
   enumerable in `sox list`. Confirm this is acceptable, or whether `cmdServe` should write a
   lightweight runtime entry. (§2, §5.4)
2. **Cross-scope "shared-store ⇒ refuse to stop"** (§4.4 rule 3) is a *new* policy; today `cmdStop`
   reaps by token regardless of cross-scope sharing. Confirm the safety stance (refuse-if-shared vs.
   last-stop-wins). (§4.4)
3. **Stable node path for OS units** — exact resolution strategy (realpath of `process.execPath` vs.
   pinned `which node` snapshot) needs a decision; a volatile nvm path in a plist is a footgun. (§9.2)
4. **Crash-loop cap N / window** (proposed 5-in-60s) and **degraded-restart policy** (proposed:
   report-only, restart only on actual exit) are not yet implemented (the supervisor currently has
   unbounded backoff-capped restarts). Confirm thresholds. (§11.3, §11.4)
5. **Singleton survivor tiebreak** (§5.3) — preferring oldest by `ps -o lstart` is more portable than
   lowest-pid; confirm the tiebreak. (§5.3)
6. **BACKLOG BL-50 re-scope** — this spec asserts the entrypoint-token orphan reaper is *implemented*
   (`reaper.ts` + `reapOrphansForExtension`, wired into `cmdStop`/`cmdStart`), contradicting BL-50's
   "Still open: orphan-process reaper." The genuinely-open half is the OS-unit-aware
   `[inv:unload-then-reap]` ordering, which only matters once §9 lands. Confirm the BACKLOG should be
   updated to reflect this. (§1.3, §8.4)
