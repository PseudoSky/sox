# Service & Daemon Lifecycle — Canonical Specification

**Spec version:** 1.5.0
**Status:** Binding. Slice 1 (§14) is IMPLEMENTED on branch `feat/service-lifecycle-slice1`; Slice 1.5 (the front-shim service-proxy, §9.5) is IMPLEMENTED (lib + OPT-IN serve mode); **Slice 1.6 (the M3→M4 DEFAULT FLIP, §9.5) is IMPLEMENTED** on branch `feat/proxy-default-memory-backend`; **Slice 2 (the OS-supervisor control surface, §9.1–§9.4 + `[inv:unload-then-reap]`) is IMPLEMENTED** (`libs/host-runtime/src/os-unit.ts` + `soxe service enable|disable|status|list` in `apps/sox/src/main.ts`) — launchd LaunchAgent generator (systemd seam pluggable), content-addressed idempotent enable, ownership-tracked `os-unit` entry, unload-then-reap teardown in `cmdStop`/`service disable`/`cmdUninstall`, and re-enable-on-upgrade. **Slice 3 (the `[inv:crash-loop-cap]` restart bound, §11.3) and Slice 4 (the universal doctor reconcile + its OS-scheduled tick, §10.2/§14) are IMPLEMENTED** — `libs/host-runtime/src/{crash-loop,reconcile}.ts` + `soxe doctor --reconcile|--install-tick|--remove-tick` and the `soxe status`/`doctor` give-up surfacing (v1.4.0 changelog below). **§8.1a (grace-margin discipline, BUG-018) is IMPLEMENTED** (BL-592, 2026-08-18: `apps/sox/src/main.ts` `cmdService`'s `graceMs` resolution, `libs/host-runtime/src/{shutdown,os-unit}.ts`, `extensions/bundles/sox-memory-bundle/members/memory-server/src/{backend,shutdown-margin}.ts`, `extensions/services/tokenguard/src/{index,shutdown-margin}.ts`, `apps/sox/src/serve-shutdown.ts`) — live-verified: `soxe service disable memory-server` now exits cleanly on SIGTERM with no SIGKILL escalation. **§9.4b (`service update`) is IMPLEMENTED** (BL-593, 2026-08-19: `libs/host-runtime/src/os-unit.ts` `updateOsUnit` — `enableOsUnit` reused as-is followed by a verified rotation check via `restartAndVerify` whenever the enable step's content actually changed — and `soxe service update <id>` in `apps/sox/src/main.ts` `cmdServiceUpdate`).
**Date:** 2026-08-18
**Owner:** platform-engineering
**Applies to:** every code path that spawns, supervises, stops, reaps, health-checks, or persists a `service`- or `mcp-server`-type extension, across all scopes (`org` / `user` / `project` / `local`, plus the notion of *global*).

### Changelog

- **1.5.0 (2026-08-18)** — **DESIGN ONLY (triage, not implemented)**, prompted by BUG-018 (measured
  SIGKILL on every `memory-server` `service disable`) and a routine redeploy that needed a manual
  disable→enable pair because there is no first-class config/node-path reconcile verb. Added:
  **§8.1a — grace-margin discipline**, closing three concrete, code-confirmed gaps: (1) the
  manifest's `lifecycle.stop_timeout_ms` is parsed and asserted by the authoring scaffold but is
  **never read** by `cmdService`'s `disable`/`restart` `graceMs` resolution
  (`apps/sox/src/main.ts:4950-4954` reads only `--grace-ms`/`SOX_STOP_GRACE_MS`, default 5000,
  regardless of what the manifest declares); (2) no shared invariant requires a service's own
  internal safety-net timeout to sit *strictly inside* its grace window with a defined margin —
  `memory-server`'s backend does (`SHUTDOWN_SAFETY_NET_MS=4000` vs the assumed 5000ms grace,
  `extensions/bundles/sox-memory-bundle/members/memory-server/src/backend.ts:156`) but `tokenguard`
  race-condition-ties its own safety net to the exact same value it assumes the reaper will use
  (`extensions/services/tokenguard/src/index.ts:284-292`, `extension.json:22`, both `5000`) with **no
  margin at all**; (3) `coordinatedShutdown`'s own steps are inconsistently bounded — step 0 (embed
  drain) races a 750ms timeout, step 1 (`terminateEmbedWorkers`) does not, and none of them are
  individually logged with timestamps, so a real stall cannot be attributed to a step after the
  fact. Also documents a fourth, independently provable defect found while reading the shutdown path
  for BUG-018: `cmdServe`'s SIGTERM handler in `--port` mode never calls `handle.close()`
  (`apps/sox/src/main.ts:8646-8650`) where the non-port branch does (`:8656-8668`) — the front-shim
  exits without tearing down its backend connection. **§9.4b — `soxe service update`**, a new verb
  that composes the already-implemented idempotent `service enable` (§9.3, env-drift-safe per
  `[inv:env-preserved-on-regenerate]`) with the already-implemented verified `service restart`
  (§9.4a, `[inv:deploy-verified]`) so a config/node-path change to a proxy-mode service is guaranteed
  to reach the **backend**, not just the front-shim — closing the same class of gap §9.4a closed for
  code deploys, but for config deploys. Neither section changes the invariants in §13.1; §8.1a adds
  no new invariant name (it tightens existing ones), §9.4b's guarantee is stated as an extension of
  `[inv:deploy-verified]`.
- **1.4.0 (2026-07-04)** — **Implemented Slices 3 + 4** (the continuous-supervision layer;
  motivated by the 2026-07-04 zombie-backend incident, BL-170 — the machinery was verb-triggered
  only, nothing watched between invocations).
  **Slice 3 — `[inv:crash-loop-cap]` (§11.3):** (1) New leaf module
  `libs/host-runtime/src/crash-loop.ts` — `CrashLoopGuard`, the §11.3 "restart counter with a
  rolling-window timestamp ring" (defaults **5-in-60s**, the Appendix-B item 4a decision).
  Failures are counted on unexpected process EXIT only (a slow-but-successful start can never trip
  the cap); the cap is **sticky** — window expiry never silently un-caps
  ([inv:list-never-lies]); only an explicit start/enable (`clear()`/`recordSuccess()`) clears. On
  the cap transition a **durable JSON marker** is written under `run/crash-loop/<key>.json` so a
  separate CLI process can render the give-up. (2) Wired into the `supervisor.ts` unexpected-exit
  seam (the spec-designated location): a capped service stops respawning, logs the durable
  `[crash-loop]` give-up line (console + LogManager), exposes `isCrashLooped()`, and
  `start()`/`restart()` clear the state + marker. (3) **Surfacing:** `soxe status` renders a
  marker as **DEGRADED** with the crash-loop reason (exit ≥1, never a silent stop); `soxe doctor`
  reports it as a `CRASH-LOOP` anomaly; both report-only — the clear stays explicit. The
  `ensureBackend` respawn seam gets the same primitive via a documented one-line integration
  (applied by the integrator to avoid colliding with the live BL-170 hardening of
  `ensure-backend.ts`). *Slice 3's remaining F13 item (durable M3 serve stderr) is unchanged:
  the opt-in `--log`/`SOX_SERVE_LOG=1` sink exists (BL-46) and M4 units already default to
  durable `StandardOutPath`/`StandardErrorPath` (Slice 2, §9.2); flipping the M3 default is
  deferred with the serve-path work.*
  **Slice 4 — universal doctor reconcile, scheduled (§10.2, F4/F6/F12/F15 + the BL-170 zombie
  class):** (1) New leaf module `libs/host-runtime/src/reconcile.ts` — `socketOwnerPids`
  (lsof-based UDS holder attribution, injectable exec) + `classifyReconcileTargets`, the
  SAFE-BY-CONSTRUCTION stray classification: never touch an accounted pid
  ([auth:supervisor-then-os-then-os-reality]); never touch the live writer-socket holder; a live
  socket whose holder cannot be positively attributed reaps NOTHING (report + skip); a
  token-matched process with zero fds on the live socket (the exact BL-170 spawn-race-loser
  zombie) is reaped via `killAndVerify` ([contract:signal]); with no socket, a lone unaccounted
  process is report-only and a ≥2 set is healed by the EXISTING §5.3 `chooseSurvivor` rule
  (oldest survives) — no reimplemented scan/kill. (2) **`soxe doctor --reconcile [--dry-run]`**
  (`doctorReconcile`, `apps/sox/src/main.ts`): non-interactive, idempotent — GC pass
  (`readGlobalRegistry`), per-install identity-stray heal (BL-136 env+argv matchers), split-brain
  runtime.json heal (running:true with no process reality → running:false; a LIVE supervisor's
  record is never touched), os-unit ⇄ ownership reconcile (missing file / stale content-hash /
  stale artifact-hash F12 / orphaned unit F15 — report-only with the exact remedy command, since
  loading a unit needs the human node-path ack), and crash-loop marker surfacing. Every action
  lands in the durable `run/logs/doctor-reconcile/doctor-reconcile-<date>.log`; `--dry-run`
  reports what WOULD be done; exit 1 only on an `undead` verification failure (report-only
  findings never flap a scheduled tick). (3) **Scheduling — `soxe doctor --install-tick
  [--interval <sec>]` / `--remove-tick`:** renders a content-addressed unit through the standard
  os-unit layer ([inv:os-unit-generated]) that runs `soxe doctor --reconcile` every N seconds
  (default 300; env `SOX_DOCTOR_TICK_INTERVAL`; clamped ≥10s) — launchd `StartInterval` (new
  `OsUnitSpec.startIntervalSec`), systemd paired `.timer` unit (new `renderTimerUnit` seam,
  mirror of `renderSocketUnit`); ownership-tracked as an `os-unit` OwnedEntry under the pseudo-id
  `doctor-tick` ([inv:reversible-injection]) and also removable via the standard
  `soxe service disable doctor-tick` path; same `--dry-run`/`--unit-dir`/`SOX_OS_UNIT_DIR`/
  `--supervisor`/`--node-path`/`--allow-volatile-node` surface as `service enable`.
  **Env note (§13.2.5):** the tick unit forwards `SOX_ECOSYSTEM_HOME` when set (tick-unit-only —
  the scheduled reconcile must see the same data root; the supervisor scrub allowlist is NOT
  widened). (4) **Safety:** all tests sandboxed (temp marker dirs, `SOX_OS_UNIT_DIR`,
  `--dry-run`, fake lsof exec) — no real `~/Library/LaunchAgents` write, no real
  `launchctl load`, no live-process reaping in tests. Gates in §14 (Slices 3–4).
- **1.3.0 (2026-06-26)** — **Implemented Slice 2** (§9.1–§9.4, §8.4/§8.5, the OS-supervisor control
  surface — subsumes BL-51 + the reboot half of BL-50). (1) New leaf module
  `libs/host-runtime/src/os-unit.ts`: a platform-pluggable OS-unit generator
  (`LaunchdPlatform` first; `SystemdPlatform` proves the seam) rendering a unit from the manifest
  `lifecycle` block + resolved config env (§9.2), **content-addressed** (every unit embeds a
  `sox-os-unit content-hash`), with `deriveOsUnitSpec`, `resolveUnitNodePath` (the §9.2/Appendix-B
  item 3 stable-node-path footgun guard — flags nvm/asdf/volta/`versions/node` and prefers a
  non-volatile `node`), idempotent `enableOsUnit` ([inv:os-unit-content-addressed]: re-enable rewrites
  only on content change, unloading the stale unit first), `disableOsUnit`, and **`unloadThenReap`**
  ([inv:unload-then-reap]: unload the unit BEFORE the verified-stop reap so the OS supervisor cannot
  resurrect the killed pid — the F3 fix). (2) New top-level **`soxe service enable|disable|status|list`**
  verb (`cmdService`, `apps/sox/src/main.ts`) — the ONLY sanctioned OS-unit path
  ([inv:os-unit-generated]); records the unit in the ownership index as a new `os-unit` `OwnedEntry`
  kind ([inv:reversible-injection], §9.4); `--dry-run` renders-without-loading; `--unit-dir` /
  `SOX_OS_UNIT_DIR` inject the unit dir for hermetic testing; volatile-node load is gated behind
  `--allow-volatile-node` (the human ack, Appendix B item 3). (3) **`[inv:unload-then-reap]` wired
  into the teardown paths**: `cmdStop` (all three exit paths) unloads any owned OS unit before the
  identity reap; `service disable` does unload-then-reap then removes the unit + clears ownership;
  `cmdUninstall` tears the unit down before store removal (§9.4); `cmdUpgrade`'s rolling-restart
  re-`enable`s an owned unit so it tracks the new artifact (§9.3). (4) **Safety**: no real
  `~/Library/LaunchAgents` write and no real `launchctl load` in any test — all unit tests
  (`os-unit.spec.ts`, 22 cases) use a sandboxed unit dir + a fake `exec`; the CLI integration
  (`service-os-unit.spec.ts`, 7 cases) drives the built CLI with `SOX_OS_UNIT_DIR` + `--dry-run`.
  Gates in §14 (Slice 2).
- **1.2.0 (2026-06-25)** — **Implemented Slice 1.6** (§9.5, the M3→M4 default flip). (1) **Proxy is
  now the DEFAULT for `type: mcp-server`** in `cmdServe` (`apps/sox/src/main.ts`); explicit opt-OUT
  via `--no-proxy` / `lifecycle.serve_mode:"direct"` / `lifecycle.proxy:false` (the rollback path
  without a code revert). (2) **memory-server runs as a persistent UDS BACKEND**
  (`SOX_PROXY_BACKEND=1` → `runBackend` in
  `extensions/bundles/sox-memory-bundle/members/memory-server/src/backend.ts`, wrapping the existing
  `TOOLS`+`handleToolCall` with `serveBackend`); it **publishes `dist/schema.json`**
  (`lifecycle.schema_path`, generated postbuild from the canonical tool list) so the shim serves
  `initialize`/`tools/list` instantly during a backend restart. (3) **Auto-managed backend
  lifecycle**: new leaf primitive `ensureBackend` (`libs/service-proxy/src/ensure-backend.ts`) —
  probe-then-spawn the backend detached, **singleton-guarded by an O_EXCL spawn lock keyed on
  `[def:singleton-key]`** so many sessions' shims collapse to ONE backend per store (single-writer);
  the shim ensures on start and re-ensures on a dropped connection (crash recovery). (4) **Upgrade =
  zero reconnect**: a proxy-mode `mcp-server` upgrade now **rolling-restarts the BACKEND**
  (verified-stop by entrypoint token + re-ensure on new code) and reports the new
  `backend-restarted` disposition instead of `reconnect-needed`; the shims re-dial across the
  sub-second gap. Proven by a real-process e2e (`tools/probe-memory-backend-zdt.mjs`, e2e Section
  SPM): two shims share one backend, a backend rolling-restart, both `tools/call` succeed with the
  stdio pipes never closing, single-writer holds before+after. **Migration note:** flipping
  memory-server requires **exactly ONE final client reconnect** (to replace the running direct-stdio
  server with the shim); thereafter behaviour upgrades restart only the backend → no further
  reconnects. Gates in §14 (Slice 1.6).

- **1.1.1 (2026-06-25)** — **Implemented Slice 1.5** (§9.5, the front-shim service-proxy / M3↔M4
  bridge) as the dependency-free leaf lib `libs/service-proxy/` (`runFrontShim`, `serveBackend`,
  `dialBackend`, `computeSchemaHash`, `backendSocketPath`, frame codec; node `net`/`crypto`/`fs`
  only) plus an **OPT-IN** `--proxy` / `lifecycle.proxy:true` / `lifecycle.serve_mode:"proxy"`
  branch of `cmdServe` (`apps/sox/src/main.ts`). Default `cmdServe` behaviour is UNCHANGED;
  **no existing server (incl. memory-server) is flipped to proxy mode** — that migration is a
  separate future slice. Zero-downtime proven by a real-process e2e probe
  (`tools/probe-service-proxy-zdt.mjs`, wired as a new e2e Section): a backend rolling-restart
  with the client's `tools/call` succeeding across it and the stdio pipe never closing. Gates
  recorded in §14 (Slice 1.5).
- **1.1.0 (2026-06-25)** — Resolved all six Appendix-B `(unverified)` assumptions with decisions
  - rationale (one, the OS-unit node-path, retains a recommended default needing a human ack).
  **Implemented Slice 1** (cross-scope singleton + reconcile heal) in
  `libs/host-runtime/src/singleton.ts` + the `cmdStart` service-registry guard
  (`apps/sox/src/main.ts`); this closes the live half of BL-50 (F1/F7). Added **§9.5 (M3↔M4
  bridge: the stdio front-shim / service-proxy)** and a new roadmap **Slice 1.5** answering the
  zero-downtime-upgrade question (behavior changes with no client reconnect; only a
  tool-schema change forces a reconnect). Build/lint/test/e2e gates recorded in §14.
- **1.0.0 (2026-06-25)** — Initial spec.

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
   — incl. **§9.5 Zero-downtime upgrades / front-shim service-proxy (M3↔M4 bridge)**
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

4. **Split-brain between soxe runtime.json/global-registry and the OS supervisor.** Once an OS unit
   exists, `soxe list` reading runtime.json can disagree with launchd reality. There is no authority
   order and no reconcile pass that includes the OS supervisor. (§10.)

This spec defines the framework that closes all four, building on §1.2 primitives, never re-proposing them.

---

## 2. Service taxonomy & execution models

A "service" in this ecosystem is any extension that runs as a **long-lived process**. There are four
distinct execution models. Conflating them is the root of most lifecycle defects, so they are named
and contracted separately.

| # | Model | Manifest signal | Who owns lifecycle | How liveness is known | How it is stopped |
|---|---|---|---|---|---|
| **M1** | **In-supervisor (tracked)** | `type: service`/`mcp-server`, started via `soxe start` lockfile path → `startRuntime` (`main.ts:3144`) | The live soxe supervisor process (`ProcessSupervisor`, `supervisor.ts:93`) | In-process `_proc.exitCode === null` + `_probeHealth` (`supervisor.ts:411-449`); registry GC verifies the **supervisor's** pid/socket | `supervisor.stop()` → `-pgid` SIGTERM→SIGKILL (`supervisor.ts:165-217`) |
| **M2** | **Detached service-mode daemon (PPID→1)** | `type: service` started via the service-registry path (`main.ts:3030-3128`): `spawnChild(..., {detached:true, stdio:'ignore'}); child.unref()` (`main.ts:3084-3092`) | **Nobody live** — the spawning soxe process exits 0; the daemon reparents to PID 1 | Health socket probe (`probeUnixSocketLive`, `main.ts:3537`) + identity-token process scan (`findOrphansByIdentity`, `reaper.ts:216`) | Identity-token reap (`reapOrphansForExtension`, `runtime.ts:575`) — find by entrypoint argv token, `killAndVerify` |
| **M3** | **stdio / on-demand mcp-server (client-spawned)** | `type: mcp-server`, `lifecycle.health.type: stdio-ping` (e.g. `memory-server/extension.json`) | The **MCP client** (Claude Code) spawns `soxe serve <id>` (`cmdServe`, `main.ts:4433`) per connection; lifetime = the stdio pipe | The client owns the pipe; soxe does not track it. (No durable pid record — see BL-46.) | Client closes stdin/the pipe → process exits. soxe does not stop it. |
| **M4** | **OS-supervised unit (launchd / systemd)** *(proposed, §9)* | `type: service` with `soxe service enable` having generated a unit | The OS supervisor (launchd `KeepAlive` / systemd `Restart`) | OS query (`launchctl print` / `systemctl --user is-active`) **plus** the health socket | `soxe service disable` (unload the unit) **then** identity reap any survivor |

**Key consequences of the taxonomy:**

- **M2 is the dangerous one.** Because no live process tracks it, every guarantee (singleton, stop,
  health) must be reconstructed from OS reality (process table + socket + ownership index). This is
  the model behind the BL-50 two-writer incident (`BACKLOG.md:166-175`).
- **M3 is intentionally untracked by sox.** soxe must **never** try to "stop" an M3 server — the
  client owns it. sox's only M3 responsibility is the singleton guard at *spawn* time (a second
  client connection must reuse, not duplicate, the writer — see §5.4) and durable stderr logging.
  **BL-46 status:** `cmdServe` now has an **opt-in** durable stderr sink (`--log` flag or
  `SOX_SERVE_LOG=1` env tees stderr to `<logDir>/<extId>-serve-<date>.log` while leaving stdout — the
  JSON-RPC channel — untouched; default remains `stdio:'inherit'`, `main.ts:4552-4561`). The framework
  should make this sink the **default for M4** units (§9.2) so the live served version is always
  observable (BL-46, `BACKLOG.md:246-264`).
- **M4 supersedes M2 for persistence.** Once §9 ships, a `service` that needs reboot persistence runs
  as M4, and M2 becomes a transitional/`--daemon`-only fallback. M4's stop is *unload-then-reap*.
- A single extension may be **promoted** M2 → M4 by `soxe service enable` (§9) or run as M1 under an
  attached `soxe start`. The framework must reconcile whichever model is live (§10).

**Decision (Appendix B item 1) — M3 stays untracked by a runtime.json *entry*; `cmdServe` writes a
lightweight *serve-record* breadcrumb instead.** M3 has no durable runtime.json entry today
(`cmdServe` `execFileSync`s the entrypoint with `stdio:'inherit'`, `main.ts:4566-4572`; opt-in stderr
sink via `--log`/`SOX_SERVE_LOG=1`, `main.ts:4566-4575`). A full runtime.json entry is the **wrong**
model — the client owns the pid, so a `running:true` entry would routinely lie when the client
disconnects (it would need GC on every read). **Resolution:** keep M3 out of the runtime.json
`entries[]` (the supervisor-owned record), but have `cmdServe` write a *best-effort serve-record* under
`run/serve/<extId>-<pid>.json` (pid, extId, scope, resolved store-resource, schema-hash, startedAt) on
spawn and unlink it on exit. This is enumerable by `soxe list --serve`/`soxe doctor` for observability,
self-cleans (pid-liveness GC like `gc.ts`), and never feeds the `[auth:...]` RUNNING decision (M3 is
rendered `owner:client`, liveness from pid+socket only). The §5.4 shared-store guard still relies on the
health-socket probe + entrypoint scan, which is sufficient for the one-writer-per-store invariant.
*Scope:* the serve-record is part of Slice 1.5 (it is most useful once the front-shim of §9.5 exists);
until then M3 remains acceptably untracked because BL-47's in-process fallback means no daemon need run.

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
> outranks an OS unit (2), which outranks bare socket/process reality (3–4). `soxe list` MUST render
> the descriptor's `liveness`/`owner`, never a raw runtime.json `running` flag. This is the
> generalization of the existing C4 pid-liveness gate (`soxe list` validates `process.kill(pid,0)`
> before reporting RUNNING) to the OS-supervisor world.

**Note (resolved):** step 2 (OS unit) depends on §9, not yet built; **today the order is 1 → 3 → 4 →
5**, which is exactly what Slice 1's `cmdStart` guard (`healSingletonDuplicates` entrypoint scan + socket
probe + cross-scope check) and `cmdStop`'s reap implement. When §9/Slice 2 lands, step 2 inserts between
1 and 3 with no change to the lower steps. This is settled, not unverified.

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
3. **`soxe stop` at a scope** stops/reaps only instances whose singleton key is owned by that scope's
   install **unless** the instance is shared (rule 1), in which case stop is refused with a notice
   that another scope still references the store (prevents one scope's stop from yanking the store out
   from under another). `soxe stop --all` / `soxe doctor` may force-reap.

**Decision (Appendix B item 2) — REFUSE-IF-SHARED is the policy.** A scoped `soxe stop` whose target
instance is shared with another scope (rule 1) **refuses** and prints which scope(s) still reference the
store; only `soxe stop --all` / `soxe doctor --force` may force-reap a shared instance. Rationale: the
invariant being protected is *one writer per store*; "last-stop-wins" lets one scope's teardown silently
yank a store another scope is actively using (the dual of the two-writer bug — a zero-writer surprise).
Refuse-if-shared is the conservative, surprise-free stance and matches the team's standing guidance.
**Status:** designed; the *guard* (Slice 1, this branch) already prevents the second *spawn*; the
refuse-on-*stop* half lands with Slice 2's reconcile-aware `cmdStop` (it needs the cross-scope descriptor
the reconcile pass computes). Until then `cmdStop` reaps by token (the existing safe behavior — it never
creates a two-writer state, it only declines to *protect* a shared one, which is acceptable while no OS
unit can resurrect a killed daemon).

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
   **oldest by start time** (`ps -o lstart`), with **lowest-pid only as a fallback** when start times are
   unavailable/equal. **Decision (Appendix B item 5):** oldest-by-`lstart` is the tiebreak — it is
   BSD/macOS + Linux portable and meaningful (the older live process is the one with warm
   state/connections; pids wrap and carry no age signal). Implemented in `chooseSurvivor`
   (`singleton.ts`, `processStartTime` reads `ps -o lstart=`).
2. `killAndVerify` the loser(s) (`reaper.ts:111`).
3. Log a `[singleton-violation healed]` line and surface it in `soxe doctor`.

Implemented as `healSingletonDuplicates` (`singleton.ts`): finds live pids for the entrypoint token,
no-ops on ≤1 (never thrashes a healthy daemon), kills all but the survivor on ≥2.

### 5.4 M3 (stdio mcp-server) singleton

M3 servers (`memory-server`) are spawned per client connection and `singleton` is **not** set. The
invariant they must still honor is **shared-store safety**: many M3 server processes may exist (one
per client) but they all use **synchronous single-connection better-sqlite3** on the same db, which
serializes harmlessly (`BACKLOG.md:316-321`). The actual writer-contention danger is an M3 server
**plus** an M2/M4 daemon both writing — which §5.1's key catches because they share the db resource.
So: an M3 server may coexist with *other M3 servers* but its spawn (`cmdServe`) MUST NOT proceed to
*also start a daemon* on the same store without the §5.2 guard.

**Verified — `cmdServe` does NOT auto-start a daemon.** Read end-to-end (`cmdServe`,
`main.ts:4433-4600`): it resolves the entrypoint, builds config env, compiles policy, and
`execFileSync`/spawns **the server entrypoint only** — there is no `spawn` of `memory-daemon` or any
service. The BL-47 in-process fallback means no daemon need run for enrichment correctness. **Rule
(binding):** if `cmdServe` ever gains daemon-autostart, it MUST first run the §5.2 singleton guard
(socket probe + entrypoint scan + cross-scope check) — captured as agent rule §13.2.1.

### 5.5 Detection & healing summary

| When | Mechanism | Where |
|---|---|---|
| Start | §5.2 guard (socket + process scan + cross-scope) | `cmdStart` |
| Reconcile / `soxe list` / `soxe doctor` | §5.3 — recompute descriptor, heal duplicates | reconcile pass (§10) |
| Stop | identity reap by token (`reapOrphansForExtension`) | `cmdStop` |
| Crash | GC marks runtime.json `running:false`; next start re-guards | `gc.ts` |

---

## 6. Lifecycle state machine

States and the **only** legal transitions. Each transition names the command/event that drives it.

```
                 install                 soxe start / service enable
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
                                      │ STOPPING ◀── soxe stop / service disable / SIGTERM
                                      │   │
                                      │   ▼ verified exit (killAndVerify)
                                      └ STOPPED ──(orphan survives)──▶ REAPED ──▶ STOPPED
```

| Transition | Driver | Implementation anchor |
|---|---|---|
| absent → INSTALLED | `install()` | install-engine; ownership index recorded (ADR-0004 §D5) |
| INSTALLED → STARTING | `soxe start` / `soxe service enable` | `cmdStart` (`main.ts:2851`) / §9 |
| STARTING → HEALTHY | spawn ok + first health probe passes | `supervisor.start` → `_waitForHealth` (`supervisor.ts:135-154`) |
| STARTING → STOPPED (failed) | spawn fails / health timeout | `_waitForHealth` throws (`supervisor.ts:406`) |
| HEALTHY → DEGRADED | periodic health probe fails | `_startHealthLoop` (`supervisor.ts:451-458`) |
| DEGRADED → HEALTHY | probe recovers | health loop |
| DEGRADED → STARTING | restart on unexpected exit (backoff) | `_respawn` (`supervisor.ts:366`); §11.3 crash-loop guard |
| any → STOPPING | `soxe stop` / `service disable` / SIGTERM | `cmdStop` (`main.ts:3191`), `supervisor.stop` (`supervisor.ts:165`) |
| STOPPING → STOPPED | verified exit | `killAndVerify` (`reaper.ts:111`) |
| STOPPED → REAPED → STOPPED | orphan survives stop, reaped by identity | `reapOrphansForExtension` (`runtime.ts:575`) |
| INSTALLED ⇄ (disabled) | `soxe disable` / `soxe enable` | `cmdDisable`/`cmdEnable` (`main.ts:2161-2326`) — config flag + SIGHUP reconcile |

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
   This serializes concurrent `soxe start` for the same scope+root (R3). Released after the runtime
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
   so `soxe list --all` and the GC pass can see it. Release the start lock.

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

### 8.1a Grace-margin discipline (BUG-018 design, 2026-08-18) — IMPLEMENTED (BL-592, 2026-08-18)

**Trigger.** Measured live 2026-08-18: `soxe service disable memory-server --scope user` produced
`[unload-then-reap] reap com.sox.user.memory-server: SIGTERM -> pid 85032 (grace 5000ms)` followed
by `pid 85032 survived SIGTERM after 5000ms -> SIGKILL` (BUG-018 citation 1). The reaper itself did
exactly what `[inv:unload-then-reap]` specifies — the defect is upstream of it. A SIGKILL skips
`memory-server`'s adapter close ceremony (PASSIVE checkpoint, quiescence-gated TRUNCATE, lease
release, marker clear) — after DEBT-004 deleted `memory-core`'s private checkpoint timer, that
ceremony and the store-adapter's idle-flush debounce (§ the `libs/data/store/store-adapter`
`DEFAULT_IDLE_FLUSH_MS`, see BL-590) are the only two mechanisms that durably flush the store, so a
process that never runs it durably-flushes only by luck of idle timing.

**What the current source promises, read end-to-end.** `runBackend()`
(`extensions/bundles/sox-memory-bundle/members/memory-server/src/backend.ts:389-415`) wires
`process.on('SIGTERM', …)`/`process.on('SIGINT', …)` **before** the async bind (BL-170), both
pointing at the single `coordinatedShutdown` function (`backend.ts:232-371`, BL-405/BL-472). That
function starts a `setTimeout` "safety net" at **4000ms**
(`SHUTDOWN_SAFETY_NET_MS`, `backend.ts:156`) that force-`exit(0)`s regardless of what the awaited
steps are doing, with a doc comment stating it is deliberately "strictly inside the reaper's 5000ms
SIGTERM grace." Reading that code in isolation, the process should always exit at or before 4000ms —
1000ms of margin inside the observed 5000ms grace. The measured behavior (full 5000ms, then SIGKILL)
contradicts that promise. Two things independently undermine it, both found by reading the actual
code paths a `service disable` traverses, neither fully diagnosable from a static read alone (no
live process was available to inspect at review time — see the Not Determined note below):

1. **The manifest's declared grace is dead data for this call path.** `memory-server`'s
   `extension.json` `lifecycle` block declares no `stop_timeout_ms` at all, and even if it did,
   `cmdService`'s `disable`/`restart` `graceMs` resolution (`apps/sox/src/main.ts:4950-4954`) reads
   **only** `flags['grace-ms']` / `process.env['SOX_STOP_GRACE_MS']`, defaulting to a bare `5000` —
   it never consults `resolveOsUnitContext`'s resolved manifest at all. §8.1's own prose
   ("`stop_timeout_ms` (default 5000ms, `memory-daemon`/`tokenguard` both declare 5000)") describes
   an intent the code does not implement for the `service disable`/`restart` path — only `cmdStop`
   and `service disable`/`restart` share the same unwired default-or-flag resolver. A service that
   legitimately needs longer than 5000ms (a large-WAL checkpoint, a slow-to-terminate fastembed
   child) has no way to declare that; an operator has to remember `--grace-ms` by hand every time.
2. **No shared invariant enforces "internal safety net < declared/assumed grace, with margin."**
   `memory-server`'s backend picked 4000 vs an assumed 5000 (1000ms margin, itself just a comment,
   not derived from anything the reaper actually enforces). `tokenguard`
   (`extensions/services/tokenguard/src/index.ts:284-292`) sets its own internal
   `setTimeout(() => process.exit(0), 5000).unref()` as its *own* safety net, identical in magnitude
   to its declared `lifecycle.stop_timeout_ms: 5000` (`extension.json:22`) — a **race**, not a
   margin: if the service's own timer and the reaper's poll both resolve at t=5000ms, which wins is
   scheduler-dependent. This is the same defect FAMILY as BUG-018 (an internal safety net that
   cannot be trusted to preempt the reaper's SIGKILL), independently confirmed in a second,
   unrelated service — see "Is this systemic?" below.
3. **`coordinatedShutdown`'s own steps are unevenly bounded.** Step 0 (`flushPendingEmbeds()` +
   `waitForDrainSettled()`, `backend.ts:282-299`) races a 750ms timeout
   (`SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS`). Step 1 (`terminateEmbedWorkers()`, `backend.ts:301-307`,
   which awaits `Promise.all([getSharedFastembedProcess().terminate(), getSharedOnnxWorker().terminate()])`,
   `libs/memory-core/src/embed.ts:492-497`) has **no timeout of its own** — it is a bare `await`
   inside a `try`. The overall 4000ms safety-net `setTimeout` should still fire regardless (Node
   timers are not blocked by a *pending* promise, only by synchronous CPU-bound work on the same
   thread), so this alone does not explain a full 5000ms stall under the code as read — but it means
   that if any future change makes worker `.terminate()` do synchronous work, or if a native binding
   invoked transitively blocks the thread, there is no per-step backstop to catch it, only the
   whole-sequence one. No step logs a timestamp on entry/exit, so a real stall today cannot be
   attributed to a step after the fact — this is the single largest reason the exact 2026-08-18 stall
   could not be pinned down further in this design pass.

**A fourth, independently provable defect** found while tracing this path (not itself sufficient to
explain the 5000ms stall, but a real bug in the same subsystem, in the code that runs *before*
`coordinatedShutdown` ever gets invoked): `cmdServe`'s SIGTERM/SIGHUP handling in proxy mode
branches on whether `--port` was passed (`apps/sox/src/main.ts:8646-8671`). `memory-server`'s
os-unit is generated with a port (`SOX_CONFIG_PORT`, resolved via `resolveOsUnitContext`,
`main.ts:4869-4881`, because it serves `stdio+http+sse` per its `install.serves`), which selects
the **`httpPort` branch**:

```ts
if (httpPort !== undefined && !Number.isNaN(httpPort)) {
  await new Promise<void>((resolve) => {
    process.on('SIGTERM', () => resolve());
    process.on('SIGINT', () => resolve());
  });
} else {
  // pure-stdio branch — DOES call handle.close() before resolving (BL-310)
  ...
}
process.exit(0);
```

The `httpPort` branch resolves and falls through to `process.exit(0)` **without ever calling
`handle.close()`** — the non-port branch three lines below it does. `FrontShimHandle.close()` is
documented as "Force-close the shim (tears down the backend connection)"
(`libs/service-proxy/src/shim.ts:106-115`). This means the front-shim for a port-configured
proxy-mode mcp-server (currently only `memory-server` — see "Is this systemic?" below) exits on
SIGTERM without any attempt to tear down its UDS connection to the backend — an asymmetry with no
justifying comment, and inconsistent with the pure-stdio branch's own BL-310 fix three lines away.
This does not by itself explain the backend's 5000ms stall (the shim and backend are separate
processes, and the reap step signals the backend directly by identity token, not through the shim —
§8.6), but it is a real regression in the shim's own teardown contract and must be fixed regardless
of what BUG-018's root cause turns out to be.

**Not determined by this design pass.** Whether the specific pid 85032 was running the current
(BL-405/BL-472-hardened) build of `backend.ts` at all could not be confirmed retroactively — the
process is gone. `dist/index.js` on disk was rebuilt 2026-08-18 16:34 and *does* contain
`coordinatedShutdown`/`SHUTDOWN_SAFETY_NET_MS=4000`
(confirmed: `rg -c coordinatedShutdown extensions/bundles/sox-memory-bundle/members/memory-server/dist/index.js` → 11 hits, `SHUTDOWN_SAFETY_NET_MS = 4e3` present) — but per this repo's own standing
hazard (CLAUDE.md "A REVERT IS NOT FINISHED UNTIL YOU REBUILD", BUG-028: a reverted change stayed
live in a running process for ~2h after the *source* was already fixed on disk), a backend process
that was already running before that rebuild would still be executing whatever it loaded at spawn
time, unaffected by the disk change. This is the single most likely explanation consistent with
"the code as written should self-terminate at 4000ms, but observed behavior went the full 5000ms and
required a SIGKILL" — and it is exactly the kind of gap §14/§7 diagnostics below now close.

**Is this systemic, or memory-server-specific?**
- The **missing `handle.close()` call** is systemic to *any* proxy-mode `mcp-server` extension
  installed with `--port` — currently that is only `memory-server` (the only extension in this repo
  with `"type": "mcp-server"`; confirmed
  `rg -l '"type": "mcp-server"' extensions/` → only `memory-server`'s `extension.json`). It will
  recur automatically for the next mcp-server extension that opts into dual transport.
- The **unwired manifest `stop_timeout_ms`** is systemic to `service disable`/`service restart` —
  it affects every `service`- and `mcp-server`-type extension identically, confirmed by reading
  `cmdService`'s single shared `graceMs` resolver (`main.ts:4950-4954`), not per-extension code.
- The **race-not-margin internal safety net** is confirmed independently in `tokenguard`
  (`type: "service"`, no proxy/shim involved at all) — proving the *pattern* (ad hoc, undeclared,
  unmarginated internal safety nets) is not particular to `memory-server`'s proxy architecture; it is
  a gap in how every service author is expected to pick a shutdown timeout today (there is no
  scaffold-enforced rule, only §8.1's prose).
- The **5000ms-stall-then-SIGKILL symptom itself** is confirmed live only for `memory-server`. It
  has not been reproduced or measured on `tokenguard` or any other extension.

**Design — three changes, independently shippable, together closing the gap:**

1. **Wire the manifest's `lifecycle.stop_timeout_ms` into `cmdService`'s `graceMs` resolution.**
   Precedence: `--grace-ms` flag (explicit operator override, highest) > `SOX_STOP_GRACE_MS` env >
   `manifest.lifecycle.stop_timeout_ms` (resolved via the same `resolveOsUnitContext` call
   `disable`/`restart` already make) > `5000` (unchanged final fallback, preserves today's behavior
   for a manifest that declares nothing). This makes §8.1's prose true instead of aspirational, with
   zero change to any extension that does not declare the field.
2. **Establish a shared, enforced margin between a service's internal safety net and its resolved
   grace, instead of two independently-chosen numbers that happen to agree today.** Concretely:
   define `SOX_SHUTDOWN_SAFETY_MARGIN_MS` (a host-runtime-exported constant, suggested 1000ms) and
   require every service's own internal safety-net timeout to be `stop_timeout_ms - margin`, not a
   second hand-picked literal. `memory-server`'s `SHUTDOWN_SAFETY_NET_MS` and `tokenguard`'s bare
   `setTimeout(…, 5000)` both become `resolvedStopTimeoutMs - SOX_SHUTDOWN_SAFETY_MARGIN_MS`, sourced
   from the same manifest field wired in (1) via an env var the os-unit generator already injects
   (`SOX_CONFIG_*` pattern) — so the number can never drift out of sync with what the reaper will
   actually wait for. The authoring scaffold's SIGTERM-handler template (R6, referenced in §8.1)
   should generate this pattern by default, not a literal.
3. **Bound and instrument every step of a coordinated-shutdown sequence, not just some of them, and
   log each step's entry/exit with a monotonic timestamp.** Apply to `memory-server`'s
   `coordinatedShutdown` first (add a timeout race around step 1 `terminateEmbedWorkers()`,
   symmetric with step 0's existing 750ms race; log `t+Nms: step <k> <name> started/finished` to
   stderr, same sink as its existing diagnostics) so the *next* occurrence of this symptom is
   attributable to an exact step within one incident, not a second multi-day investigation. This is
   the direct fix for "Not determined by this design pass" above.
4. **Fix the proven `handle.close()` omission** in `cmdServe`'s `httpPort` SIGTERM/SIGHUP branch
   (`main.ts:8646-8650`): call `handle.close()` before resolving, matching the non-port branch three
   lines below and its BL-310 precedent. Independent of (1)–(3); ships regardless of what BUG-018's
   root cause investigation eventually confirms.

None of these weaken `[inv:unload-then-reap]`'s escalation — a genuinely hung process still gets
SIGKILLed at the (now correctly-sourced) grace boundary. They only make the boundary the service
actually races against match the one the operator (or manifest author) declared, give every service
a mechanically-derived rather than hand-copied safety margin, and make the next stall diagnosable
without another multi-file archaeology pass.

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
  — `soxe stop` does not lie about success.

### 8.4 The orphan reaper (closing the genuinely-open half of BL-50)

The entrypoint-token reaper (`reapByIdentity` / `findOrphansByIdentity`) already finds PPID-1 M2
daemons and `killAndVerify`s them, whitespace-bounded so unrelated processes are spared
(`reaper.ts:236-250`). **What §9 adds** is the **OS-supervisor-aware** reap:

> **`[inv:unload-then-reap]`** — before killing a pid that an OS unit may own, the stop path MUST
> first **unload the OS unit** (`launchctl bootout` / `systemctl --user stop+disable`), THEN
> `killAndVerify` any survivor by identity token. Killing first guarantees an immediate launchd/systemd
> respawn (resurrection loop). This is the missing piece the BACKLOG calls "the reaper" — the
> token reaper exists; the *unload-first ordering* does not, because there is no OS unit yet.

### 8.5 `soxe stop` reap ordering (authoritative)

```
stop(scope, [id]):
  for each target instance descriptor D (§3):
    if D.owner == 'os-unit':  unload unit (§9)            # [inv:unload-then-reap]
    if D.owner == 'supervisor': killAndVerify(supervisorPid); supervisor signals its groups
    reapOrphansForExtension(D.id)                          # identity-token reap survivors (M2)
    verify: findOrphansByIdentity(token) == []            # nothing left
  reapUntrackedProxyBackends(scope, [id])                  # §8.6 — auto-spawned, no entry
  exit 1 if any 'undead'                                   # honest exit code
```

### 8.6 Reaping the auto-spawned proxy backend (untracked)

A proxy-mode mcp-server (§9.5, the Slice 1.6 default) is fronted by a thin stdio shim; the tool
implementation runs in a persistent, detached, sox-owned **backend** the shim AUTO-SPAWNS via
`ensureBackend` (`SOX_PROXY_BACKEND=1`). Because the backend is created by the **shim**, not by
`soxe start`, it has **no `runtime.json` entry** — the entry-driven reap in §8.5 never iterates it, so
the detached backend would SURVIVE `soxe stop` once every spawning shim has exited (the BL-31/BL-50
orphan leak, re-opened by the proxy default; resolved as **BL-64**).

> **`[inv:reap-untracked-proxy-backend]`** — `soxe stop` MUST reap auto-spawned proxy backends
> independent of runtime tracking or scope. The stop path enumerates installed mcp-servers from the
> **lockfile** (the source of truth for "what could have a backend"), and for each one served in
> proxy mode reaps any live process matching the backend's **entrypoint identity token** — the exact
> `node --enable-source-maps <entrypoint>` argv `ensureBackend` uses — via `reapByIdentity` →
> `killAndVerify` (`[contract:signal]` verified-stop). Implemented as `reapUntrackedProxyBackends`
> (`apps/sox/src/main.ts`), wired into all three `cmdStop` exit paths (whole-scope, per-`--id`, and
> the no-runtime-record early-exit). The identity is the entrypoint PATH (stable across scopes), so a
> backend whose serve resolved a DIFFERENT scope than the stop target is still reaped. The supervisor
> pid is excluded so a tracked direct-stdio server signalled elsewhere is not double-killed.

This is a **stop**, not a rolling restart: `ensureBackend`'s zero-downtime re-dial / backend
rolling-restart on upgrade (§9.5) is unaffected — that path verified-stops + re-ensures the backend on
new code; this path tears it down with no re-ensure.

---

## 9. Reboot persistence & the OS-supervisor control surface

This subsumes **BL-51** and the reboot half of **BL-50**.

### 9.1 The control surface

```
soxe service enable  <ext> [-s <scope>]   # generate + load an OS unit; record ownership; record in runtime tracking
soxe service disable <ext> [-s <scope>]   # unload + remove the unit; reap survivor; clear ownership
soxe service status  <ext> [-s <scope>]   # show the unit state reconciled with sox (§10)
soxe service list                          # all sox-owned OS units across scopes
```

`soxe service` is a **new top-level verb** routed in `apps/sox/src/main.ts` (alongside `start`/`stop`,
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
- **Stable node path (Appendix B item 3 — recommended default, needs a human ack at Slice-2 build
  time).** Recommended: pin **`fs.realpathSync(process.execPath)`** — the realpath of the node binary
  running `soxe service enable` — into the unit's `ProgramArguments[0]` / `ExecStart`. Realpath strips one
  layer of symlink indirection (e.g. a Homebrew `bin/node` → cellar path) giving a concrete binary.
  **Footgun guard:** if that realpath lies **under an nvm/asdf/volta version dir** (path contains
  `/.nvm/`, `/.asdf/`, `/.volta/`, or `/versions/node/`), the unit is **volatile** — a node version
  switch orphans it. In that case `soxe service enable` MUST (a) warn loudly, and (b) prefer a
  non-volatile node if one is discoverable on `PATH` outside those dirs (`command -v node` snapshot),
  else proceed with the volatile path **only** after the user confirms (or `--allow-volatile-node`).
  `soxe doctor` flags any unit whose pinned node no longer exists (stale-node detection). **Why a human
  ack:** the "right" node on a dev's machine is environment-specific (system vs brew vs version-manager);
  the framework can recommend + guard but should not silently bake a choice that breaks on the next
  `nvm use`. This is the one Appendix-B item that stays advisory until Slice 2 is built on a real
  machine. `(needs-human-ack)`

### 9.3 Idempotent + content-addressed re-enable on upgrade

> **`[inv:os-unit-content-addressed]`** — `soxe service enable` is idempotent: re-running it (or an
> `upgrade` that changes the resolved entrypoint/args/artifactHash) **rewrites** the unit only if the
> generated content differs, then reloads it. It MUST NEVER leave a unit pointing at a stale artifact
> (this is the launchd analogue of the BL-39 re-materialize fix, ADR-0004 §D6). The ownership index
> (ADR-0004 §D5) records the unit as an owned `os-unit` entry with its `appliedHash`.

The `upgrade --all` flow (CLAUDE.md AGENT SEQUENCE step 5) MUST, after re-materializing a changed
service store, re-run `soxe service enable` for any extension that has an owned OS unit, so the unit
follows the new artifact.

### 9.4 Teardown hooks

- `soxe uninstall <service>` MUST tear down its OS unit (consume the ownership `os-unit` entry →
  unload + delete file) before removing the store — `[inv:reversible-injection]` (ADR-0004 §D6a)
  generalizes to OS units.
- `soxe doctor` MUST surface orphaned/duplicate OS units and units whose artifact no longer matches the
  installed checksum (stale unit detection).

### 9.4a Deploying a code change — `[inv:deploy-verified]` (BL-372, BL-375)

> **`[inv:deploy-verified]`** — A deploy is complete only when the **running process** is verified to
> be executing the new artifact. Neither a successful build, nor `launchctl kickstart` exiting 0, nor
> a unit reporting `loaded: yes` is evidence that any code changed.

**This is the canonical deploy procedure. Do not restate it elsewhere** — link here.

**The failure it exists to prevent, observed twice on 2026-07-31.** The front-shim service-proxy
(§9.5) deliberately keeps the backend alive across proxy restarts for zero-downtime. A consequence
never accounted for: **restarting the unit restarts the proxy, and the backend survives as a
`PPID 1` orphan still executing the previous bundle.** The build succeeded, `kickstart` exited 0,
the service showed as running, and the deployed code did not change. Every check an operator would
plausibly run was green. It recurred on the second deploy that day even with the first documented.

```
1. snapshot the store (.db AND -wal together — a .db alone is stale, BL-330)
2. snapshot dist/            # nx build deletes it BEFORE knowing the rebuild succeeds (BL-235)
3. snapshot the unit plist   # regeneration silently drops env, see below
4. npx nx build <project>
5. registry: see AGENTS.md § registry is release-only — a local rebuild does not touch it
6. sox service restart <ext> [-s <scope>]
7. VERIFY: behaviour, not just liveness
```

**Step 6 IS the invariant, enforced by the tool, not by prose.** `sox service restart` (BL-372,
`apps/sox/src/main.ts` `cmdServiceRestart`, backed by `OsUnitPlatform.kickstart`/`mainPid` in
`libs/host-runtime/src/os-unit.ts`):

1. snapshots every pid currently matching the extension's identity token (the entrypoint path —
   this catches a proxy-mode backend even though the OS unit itself runs the front-shim, because the
   backend always execs `entrypoint` directly; for a direct-mode service the token IS the managed
   process),
2. `kickstart`s the unit — `launchctl kickstart -k` / `systemctl restart` — which restarts the
   managed process **without touching the unit file** (no `enable`, no env regeneration, see
   `[inv:env-preserved-on-regenerate]` below),
3. reaps any survivor still matching that token by identity (`reapByIdentity`/`killAndVerify`,
   already in `libs/host-runtime/src/reaper.ts`) — this is the step that forces a zero-downtime
   backend to die, which makes the already-kickstarted proxy's live backend connection notice the
   disconnect and respawn a NEW backend on the current bundle,
4. polls (`--wait-ms`, default 15000) until a pid **not** in the pre-restart snapshot appears for
   that token,
5. **exits non-zero if no such pid appears** — a `kickstart` exit code of 0 and a unit reporting
   `loaded: yes` are not deploy evidence; only a rotated pid is.

Verify **by pid**, never by plist contents — the plist was correct in both original BL-372 incidents
while the running process was not. (A generic running-artifact-hash comparison against the on-disk
bundle checksum — `memory_ping` already returns `artifact` for memory-server — remains a worthwhile
follow-on for extensions that expose it, but is protocol-specific and out of scope for a verb that
must work for every `service`/`mcp-server` extension, not just one.)

**`[inv:env-preserved-on-regenerate]` (BL-375 — FIXED, PKT-38).** `soxe service enable` rebuilds the
unit's `EnvironmentVariables` from the **invoking shell** (`buildOsUnitEnv`). Regenerating a unit to
change one unrelated key used to silently drop any shell-sourced tunable the current shell no longer
exported — it was caught only by diffing the regenerated plist against a snapshot, with `enable`
printing success the whole time.

`enableOsUnit` (`libs/host-runtime/src/os-unit.ts`) now guards every regeneration that is about to
overwrite an existing unit: before writing, it parses the prior unit's `EnvironmentVariables`
(`extractUnitEnv`) and diffs it against the freshly-computed env (`droppedShellEnvKeys`), restricted
to the shell-forwarded half of the merge (`ENV_BASE_ALLOW` ∪ `NODE_*` ∪ `SOX_*`, minus
`SOX_CONFIG_*`/`SOX_PERM_*` — those are a legitimate function of the resolved config cascade, not the
ambient shell, and dropping them via `sox config unset` must never trip this guard). If the diff is
non-empty, the call **refuses to write** — `action: 'blocked'`, the unit file untouched, non-zero CLI
exit, and a message naming every dropped key. The operator either re-exports the key(s) in the
enabling shell, or acknowledges the removal per key with `soxe service enable <ext> --unset
KEY1,KEY2` — there is no blanket bypass flag by design (a copy-pasted `--force` would silently defeat
the guard for every future unrelated drop, which is the original bug with extra steps). See
`libs/host-runtime/src/os-unit.spec.ts`'s `BL-375` describe block for the four acceptance tests
(silent-drop blocked, `--unset` acknowledgment, `SOX_CONFIG_*` exemption, `extractUnitEnv` round-trip
both platforms).

`restartOsUnit` (the LKG-rollback/auto-heal rewrite path, distinct from `enableOsUnit`) carries the
identical exposure and is **not yet fixed** — filed as BL-488, cross-linked to this item.

### 9.4b `soxe service update` — reconciling config/node-path drift (design, 2026-08-18) — IMPLEMENTED (BL-593, 2026-08-19)

**Trigger.** A routine redeploy needed a manual `service disable` → `service enable` pair, and
getting it right depended on the operator remembering to re-pass `--node-path`. That is worse than
either existing verb, not a missing feature layered on top of nothing:

- If the intent was a **code** deploy, §9.4a already specifies and implements the correct single
  verb — `soxe service restart <id>` — with `[inv:deploy-verified]` pid-rotation verification. A
  manual disable→enable does not verify anything; it only reloads the *unit*, and (per §9.4a's own
  motivating incident) the front-shim's persistent backend can survive a naive reload untouched,
  still executing the old bundle as a `PPID 1` orphan.
- If the intent was a **config/node-path** change, §9.3 already specifies `soxe service enable` as
  idempotent and content-addressed: re-running it recomputes the unit from the current manifest +
  config cascade + `--node-path`, and only rewrites/reloads if the content actually changed
  (`enableOsUnit`, `libs/host-runtime/src/os-unit.ts:1006-1066`), guarded against silently dropping a
  previously-set env key by `[inv:env-preserved-on-regenerate]` (BL-375). A disable→enable pair does
  the same rewrite the hard way, minus the idempotence check, plus a window where the unit is fully
  removed.

So neither existing verb is missing — the operator used the wrong (and strictly worse) pair for
both intents, because there is no single documented verb for "reconcile this unit to whatever the
config cascade / node-path resolution says right now, verified." That is the actual gap.

**The gap `service enable` alone does not close, even though it is idempotent.** `enableOsUnit`'s
reload step (`os-unit.ts:1059-1064`) unloads-then-reloads the unit **if currently loaded with old
content** — for a proxy-mode mcp-server, the unit's managed process is the **front-shim**
(`resolveOsUnitContext`, §8.1a above), not the backend. Reloading the shim does not, by itself, force
the already-running, independently-detached **backend** (§8.6, §9.5) to pick up a changed env var —
the backend only re-reads its env at its own next (re)spawn, which a shim reload alone does not
trigger. This is the exact same class of gap §9.4a documents for a *code* change ("the backend
survives a bare kickstart as a `PPID 1` orphan still executing the OLD bundle") applied to a
*config* change instead: `enableOsUnit`'s content-hash only covers what the unit *file* renders
(env, args, node path) — it has no way to know whether a live backend, spawned earlier under
different env, has actually adopted the new value. A bare `service enable` re-run can therefore
report `action: 'unchanged'` or a successful reload while the backend a client is actually talking to
is still running under stale config — exactly the false-positive `[inv:deploy-verified]` was written
to prevent for code, now needed for config too.

**Design.** `soxe service update <id>` = `service enable` (§9.3, unchanged, reused as-is —
idempotent, `[inv:env-preserved-on-regenerate]`-guarded) **followed by a verified backend rotation
check whenever the enable step's content actually changed**, reusing §9.4a's existing
`restartAndVerify` machinery (`main.ts` `cmdServiceRestart`, `libs/host-runtime/src/os-unit.ts`
`kickstart`/`mainPid`) rather than inventing a second verification path:

```
update(id, scope, flags):
  1. resolve ctx = resolveOsUnitContext(id, scope, root, flags)   # re-reads node-path + config cascade
  2. result = enableOsUnit(ctx.spec, ctx.platform, { load: true, unsetKeys, ... })  # §9.3, as today
  3. if result.action == 'blocked':
       exit 1  # BL-375 dropped-env guard fired — same as `enable` today, no bypass added here either
  4. if result.action == 'unchanged':
       report "no change — nothing to reconcile"; exit 0
  5. if result.action in {'created', 'rewritten'}:
       # the unit changed — but for a proxy-mode mcp-server, reloading the unit alone does not
       # guarantee the BACKEND adopted the new env (see gap above). Force + verify it the same way
       # §9.4a already forces + verifies a code change:
       snapshot = pids matching identityToken(ctx.entrypoint)   # catches the backend even in proxy mode
       restartAndVerify({ label, token: identityToken(ctx.entrypoint), platform, waitMs, ... })  # §9.4a, reused verbatim
       if no new pid appears within waitMs:
         exit 1  # "unit rewritten but backend did not rotate — config change NOT verified live"
       report "'<id>' updated — config change verified live (pid rotated [before] -> [after])"; exit 0
```

For a **direct-mode** service (no front-shim — e.g. `tokenguard`), `identityToken(ctx.entrypoint)` IS
the managed process itself, so step 5's rotation check degenerates to exactly what a plain `restart`
already verifies — `update` is then just "`enable`, and if it changed anything, also verify the
managed process rotated," which is strictly safer than today's `enable` alone (which reloads the
unit but never confirms the process under it actually restarted) at negligible extra cost.

**Interaction with existing invariants (per BUG-018's checklist ask):**
- **`[inv:singleton]`** — untouched. `update` reuses `enableOsUnit`'s existing unload-before-rewrite
  step (only unloads if currently loaded with *old* content) and `restartAndVerify`'s existing
  identity-token reap, both of which already respect the singleton key; `update` introduces no new
  spawn path.
- **`[inv:list-never-lies]`** — untouched, and reinforced: `update` never claims success without the
  same pid-rotation reality check `[inv:deploy-verified]` already requires for `restart`. A
  content-changed unit whose backend does not rotate within `waitMs` is a non-zero exit, not a green
  "updated" line.
- **`[inv:unload-then-reap]`** — untouched. `update` never calls `disable`; it never removes the unit
  file or ownership entry, so there is no window where the extension is fully torn down (the actual
  operational problem the manual disable→enable pair caused). The `restartAndVerify` step it invokes
  on a real content change already performs its own identity-based reap of any survivor (§9.4a step
  3), which is a *kickstart-then-reap*, not an unload — no conflict with the disable-path invariant.
- **Node-path / env drift** — this is the primary case `update` exists for: `ctx =
  resolveOsUnitContext(...)` in step 1 re-resolves `--node-path` (or `resolveUnitNodePath()`'s
  pinned default, §9.2/Appendix B item 3) and the full config cascade fresh on every invocation, so
  drift since the unit was last enabled is exactly what step 2's content-hash comparison will catch
  and `[inv:env-preserved-on-regenerate]` will guard.

**CLI surface:**

```
soxe service update <id> [--scope=<scope>] [--node-path=<path>] [--unset KEY1,KEY2]
                          [--wait-ms=<ms>] [--dry-run]
```

Flag surface deliberately mirrors `enable` (node-path, unset) and `restart` (wait-ms) — `update` is
explicitly documented as a composition of both, not a third independent implementation, so its flags
are exactly their union with no new names to learn. `--dry-run` renders the would-be unit content and
reports whether a rotation check *would* be triggered, without loading/kickstarting anything (mirrors
`enable --dry-run`'s existing contract).

---

## 9.5 Zero-downtime upgrades without forced MCP reconnects — the M3↔M4 bridge (front-shim service-proxy)

> **Status: IMPLEMENTED + FLIPPED TO DEFAULT (Slice 1.6, v1.2.0).** Delivered as the leaf lib
> `libs/service-proxy/` (`runFrontShim`, `serveBackend`, `dialBackend`, `ensureBackend`,
> `computeSchemaHash`, `backendSocketPath`, length-prefixed frame codec). As of Slice 1.6 the
> front-shim is the **DEFAULT for `type: mcp-server`** in `cmdServe`, with an explicit opt-out
> (`--no-proxy` / `serve_mode:"direct"` / `proxy:false`). **memory-server is flipped onto it**: it
> runs as a persistent, singleton-guarded UDS BACKEND (`SOX_PROXY_BACKEND=1`) that the shim
> auto-ensures (spawns detached, one per store via an O_EXCL spawn lock on `[def:singleton-key]`).
> A behaviour upgrade rolling-restarts the BACKEND (`backend-restarted` disposition) with NO client
> reconnect. Zero-downtime + multi-shim single-writer are gate-proven (real-process e2e Sections SP
> and **SPM** + unit specs). See §14 Slice 1.5 / Slice 1.6.

This section answers the human's key architecture question: **can we upgrade a running `mcp-server`
service to new code WITHOUT making the MCP client reconnect/reload?** Short answer: **yes, for any
upgrade that does not change the tool *interface* (the JSON-RPC tool schema). An interface change still
needs a reconnect — but the shim can detect it and say so.**

### 9.5.1 Why a client reconnect is mandatory *today* (grounded in our code)

Trace the MCP stdio lifecycle as our code implements it:

1. The client (Claude Code) launches the server per connection from `.mcp.json`:
   `soxe serve memory-server` → `cmdServe` (`main.ts:4433`). `cmdServe` resolves the entrypoint and
   **`execFileSync(node, [entrypoint], {stdio:'inherit'})`** (`main.ts:4566-4572`) — the served process
   **is** the MCP server; its lifetime equals the stdio pipe.
2. At connection open the client sends `initialize` then reads **`tools/list`** — exactly the calls our
   own exec path makes against a served child (`main.ts:4861-4866`). The tool **schema is read once, at
   `initialize`/`tools/list` time**, and cached by the client for the life of the pipe.
3. New artifact code therefore only takes effect when a **fresh `soxe serve` process** loads it — which
   only happens on a **new client connection**. This is precisely why the upgrade flow classifies an
   `mcp-server` as **`reconnect-needed`** with detail *"stdio/on-demand server — respawns with new code
   on next client connection"* (`RestartDisposition`, `main.ts:1583`, `:1599-1600`, `:1647-1648`). sox
   does not own the pid (M3), so it cannot rolling-restart it in place.

So today reconnect is mandatory **because the code that serves JSON-RPC and the code that holds the
tool implementation are the same process, and that process is owned by the client's pipe.** Decouple
those two and the mandate disappears for behavior-only changes.

### 9.5.2 The design: a thin stdio **front-shim** proxying to a persistent backend (M3→M4 bridge)

```
   MCP client ──stdio(JSON-RPC)──▶  soxe serve <id>  (the FRONT-SHIM, M3-shaped to the client)
                                          │
                                          │ Unix domain socket (length-prefixed JSON-RPC frames)
                                          ▼
                                    backend service  (M2/M4 daemon — the real tool impl, sox-owned)
                                    upgraded by rolling restart BEHIND the shim
```

- **Front-shim (`soxe serve <id>` in shim-mode).** A tiny, **rarely-changing** process the client
  spawns over stdio exactly as today. It does **not** load the tool implementation. It:
  1. Serves `initialize` and `tools/list` from a **cached schema** (read once from the backend, or from
     a `schema.json` the backend publishes), so the client gets an instant, stable interface.
  2. Proxies every other JSON-RPC request (`tools/call`, etc.) to the backend over a **Unix domain
     socket** (no TCP port — see §9.5.4), framing each message length-prefixed.
  3. **Survives backend restarts:** on a dropped backend connection it **re-dials with bounded backoff**
     (e.g. 50ms→2s, cap ~10s total) and **buffers** in-flight requests up to a bounded queue; on
     re-connect it replays/forwards them. If the backend stays down past the bound, it **fast-fails**
     the pending calls with a JSON-RPC error (`-32001 backend unavailable`) rather than hanging the
     client — and keeps the stdio pipe **open** so the client need not reconnect once the backend
     returns.
- **Backend (the real server, sox-owned).** Runs as M2 (detached) or M4 (OS-supervised). `soxe upgrade`
  re-materializes its store and **rolling-restarts** it via the BL-31 verified-stop + dedup-start
  (CLAUDE.md AGENT SEQUENCE step 5). The shim's re-dial bridges the ~sub-second restart gap. **Behavior
  changes; the client never reconnects.**

### 9.5.3 Interface-change handshake (`[contract:schema-hash]`)

The one case that still needs a reconnect is a **tool-schema change** (a tool added/removed, or a tool's
input/output schema changed) — the client cached the old `tools/list` and cannot see the new shape.

- Both shim and backend compute a **`schema-hash` = sha256 of the canonical `tools/list` payload**.
- On every backend (re)connect the shim re-reads the backend schema-hash. If it **differs** from the
  hash the shim served at `initialize`, the shim:
  1. Keeps serving the **old** schema to the connected client (so in-flight calls don't break), AND
  2. Emits a durable **stderr** notice (never stdout — `[inv:no-stdout-diagnostics]`) and, if the client
     supports it, an MCP **`notifications/tools/list_changed`** server notification so a capable client
     can refresh `tools/list` **without a full reconnect**. Clients that don't honor the notification get
     the existing `reconnect-needed` disposition from `soxe upgrade`.
- This makes the reconnect requirement **precise**: *behavior change → zero reconnect; interface change →
  a `list_changed` nudge, falling back to reconnect only for clients that ignore it.*

### 9.5.4 Build vs. buy + transport recommendation

**Recommendation: BUILD a minimal in-monorepo `service-proxy` lib over Unix domain sockets. Do not add a
port-based proxy or a third-party dependency.**

- **Transport — Unix domain sockets (chosen).** No port selection problem at all (the human's concern):
  the socket path is derived from the data-root resolver (`socketDir()`, ADR-0004) keyed by
  `[def:singleton-key]`, so there is never a port clash and never a "which port did it pick" lookup. UDS
  is already how soxe does exec/health (`gc.ts probeSocket`, `supervisor.ts probeSocket`,
  `probeUnixSocketLive`) — we reuse the exact pattern. Filesystem permissions (0600 + data-root
  ownership) gate access; no network exposure.
- **Rejected alternatives:**
  - *SO_REUSEPORT / TCP ports* — reintroduces port selection + clash detection + a localhost attack
    surface, for no benefit over UDS on a single host.
  - *systemd socket activation* — Linux-only, doesn't exist on macOS launchd in the same form, and
    couples us to the OS supervisor; UDS is portable and works for the M2 backend too.
  - *An existing proxy/library (Envoy, a generic JSON-RPC router, etc.)* — massive dependency for a
    ~300-line, single-host, single-protocol need; violates the monorepo's leaf-lib hygiene and the
    "self-contained materialized store, no network at spawn" invariant (F8).
- **Where it lives:** new leaf lib **`libs/service-proxy/`** (node builtins only: `net`, `crypto`),
  exporting:
  - `runFrontShim({ id, socketPath, schemaCachePath })` — the stdio↔UDS shim `cmdServe` invokes in
    shim-mode (a new `--proxy` branch of `cmdServe`, or auto when the manifest declares
    `lifecycle.proxy: true`).
  - `dialBackend(socketPath, { backoff })` — bounded re-dial with the buffer/fast-fail semantics above.
  - `computeSchemaHash(toolsListPayload)` and the `list_changed` emission helper.
  - `serveBackend({ socketPath, handler })` — the backend-side UDS listener the daemon entrypoint wraps
    around the existing in-process tool dispatcher.
- **Reconciliation with the M3/M4 taxonomy (§2):** the front-shim is exactly the **M3↔M4 bridge**. It is
  M3-shaped to the client (client-spawned stdio, untracked pid) and M4-shaped to sox (the *backend* is
  the sox-owned, singleton-guarded, optionally OS-supervised service). This makes **M4 the default
  execution model for `mcp-server` services that want zero-downtime upgrades**, with the stdio surface
  preserved for client compatibility. The §5.2 singleton guard keys on the backend's store-resource
  (unchanged); many shims may exist (one per client) but they all dial the **one** backend per store —
  consistent with §5.4 (M3 servers may coexist; one writer per store).

### 9.5.5 Failure semantics (summary)

| Condition | Shim behavior | Client impact |
|---|---|---|
| Backend rolling-restart (upgrade) | re-dial with backoff; buffer in-flight (bounded) | none — calls resume sub-second; no reconnect |
| Backend down past bound | fast-fail pending with `-32001`; keep stdio open; keep re-dialing | errors on in-flight calls; auto-recovers when backend returns; still no reconnect |
| Backend schema-hash changed (interface change) | serve old schema; emit `tools/list_changed` + stderr notice | capable client refreshes `tools/list`; others get `reconnect-needed` |
| Shim crash | client's pipe closes (today's behavior) | client respawns the shim (cheap, no tool code to load) |

> **`[inv:no-stdout-diagnostics]`** (restates §13.2.6 for the shim): the front-shim writes **only**
> framed JSON-RPC to stdout; all diagnostics go to stderr/the durable serve-record. A stray stdout byte
> corrupts the client's JSON-RPC stream.

---

## 10. Split-brain avoidance

"Split-brain" = sox's runtime.json/global-registry disagreeing with OS-supervisor reality, so
`soxe list` lies.

### 10.1 Authority order

The reconcile authority order is `[auth:supervisor-then-os-then-os-reality]` (§3.3): live GC-verified
supervisor > OS unit state > bare socket/process reality. Whichever is highest and authoritative wins
the descriptor's `owner`/`liveness`.

### 10.2 The reconcile pass

Run on every `soxe list`, `soxe status`, `soxe doctor`, and as a step inside `soxe start`/`stop`:

1. `readGlobalRegistry()` — GC-prune dead supervisors (already implemented, `gc.ts:161`).
2. For each installed singleton service across all scopes, compute the Instance Descriptor (§3.3).
3. **Reconcile runtime.json ⇄ OS unit:**
   - runtime.json says running, OS unit says not loaded, no live process → mark `running:false`
     (stale; GC already does this for dead supervisors, `gc.ts:114-132`).
   - OS unit loaded + healthy, runtime.json missing the entry → adopt it (write a runtime entry with
     `owner: os-unit`) so `soxe list` shows it.
   - **Two live processes for one singleton key** → heal per §5.3.
4. Render `soxe list` strictly from the reconciled descriptors. `running:true` in a file is **never**
   sufficient to render RUNNING (`[auth:...]`, the C4 generalization).

### 10.3 `soxe list` never lies

> **`[inv:list-never-lies]`** — `soxe list` MUST render reality-verified descriptors only. A pid is
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
- **Crash-loop guard `[inv:crash-loop-cap]` — Decision (Appendix B item 4a): N=5 restarts within a
  60s rolling window → give up.** After 5 unexpected exits inside 60s, stop restarting, mark the service
  **DEGRADED (give-up)**, log a durable `[crash-loop]` line, surface it in `soxe status`/`doctor`, and
  require an explicit `soxe start`/`enable` to clear. Rationale: 5-in-60s is the de-facto convention —
  systemd's defaults are `StartLimitBurst=5` / `StartLimitIntervalSec=10s`, and launchd throttles
  respawns to ~10s via `ThrottleInterval`; 5-in-60s is slightly more forgiving than systemd's 10s window
  (tolerates a slow-restart service) while still catching a true crash loop fast. The M4 mapping is
  launchd `ThrottleInterval`(≥10s) / systemd `StartLimitBurst=5` + `StartLimitIntervalSec=60`. **Status:
  ✅ IMPLEMENTED (Slice 3, v1.4.0)** — `libs/host-runtime/src/crash-loop.ts` (`CrashLoopGuard`, the
  rolling-window timestamp ring; sticky cap; durable `run/crash-loop/<key>.json` marker) wired into the
  `supervisor.ts` unexpected-exit handler; failures count EXITS only (a slow start never trips it);
  give-up renders DEGRADED in `soxe status` + a `CRASH-LOOP` doctor anomaly; `start()`/`restart()` clear.

### 11.4 Restart-on-unhealthy

A DEGRADED service (health probe failing but process alive) is **not** auto-killed today — the health
loop only flips the flag. **Decision (Appendix B item 4b): REPORT-ONLY on health-only degradation —
do NOT auto-restart.** A process that is alive but failing its health probe is restarted **only on
actual process exit** (the existing `_respawn` path under the crash-loop cap), never on the health flag
alone. Rationale (and the team's standing guidance): auto-restarting a slow-but-alive service thrashes it
— a warming embed worker, a long GC pause, or a transient downstream stall would trigger a kill that
makes things worse. DEGRADED is surfaced in `soxe status`/`doctor`; the operator decides. (A future
opt-in `lifecycle.restart_on_unhealthy_after_n` MAY be added per-service, default off.) This removes the
prior "proposed 3 intervals" auto-restart entirely.

---

## 12. Failure-mode catalog

In the style of the CLAUDE.md constraint catalogs: each concrete failure, its detection, and remedy.

| # | Failure | Detection | Remedy |
|---|---|---|---|
| F1 | **Two writers on one store** (two daemons on `~/.memory/memory.db`) — BL-50 | `findOrphansByIdentity(token)` returns ≥2 live, or two pids on same `[def:singleton-key]` | §5.2 start guard prevents the *new* one; §5.3 reconcile heals an existing pair (kill loser); cross-scope check (§4.4) covers socket-overriding-db-sharing |
| F2 | **Orphan survives `soxe stop`** (PPID-1, supervisor gone) — BL-50/BL-31 | `cmdStop` runs `reapOrphansForExtension` per entry; post-stop `findOrphansByIdentity` non-empty | identity-token `killAndVerify` (implemented `main.ts:3284-3298`); exit 1 if `undead` |
| F3 | **OS unit respawns a killed pid** (resurrection loop) — §9 | killed pid reappears with new pid under same token within seconds | `[inv:unload-then-reap]`: unload unit *before* kill (§8.4/§8.5) |
| F4 | **Stale runtime.json** (RUNNING for a dead pid) | GC: `process.kill(pid,0)` fail OR socket dead (`gc.ts:68-88`) | `cleanUpDeadEntry`: mark `running:false`, unlink socket (`gc.ts:101-144`); `soxe list` reconcile (§10) |
| F5 | **Socket leak** (stale `.sock` after crash) | socket file exists but connect fails (`probeUnixSocketLive` false) | GC unlinks stale socket (`gc.ts:135-137`); start guard distinguishes live-socket from stale-file |
| F6 | **Split-brain** (runtime.json ⇄ launchd disagree) — §10 | reconcile pass compares descriptor `owner`/`liveness` vs runtime.json flag | §10.2 reconcile; `[auth:...]` authority order; `[inv:list-never-lies]` |
| F7 | **Scope collision** (user + project resolve same db, different sockets) — §4.2 | cross-scope ownership-index check at start (§5.2 step 4) | refuse second spawn; record shared (§4.4 rule 1) |
| F8 | **Download/build-on-spawn hang** | health first-probe timeout (`_waitForHealth` throws, `supervisor.ts:406`) | self-contained materialized store (ADR-0004 / bundled-extension-build-standard memory) — no network/build at spawn; fail fast on timeout |
| F9 | **Concurrent `soxe start` race** (two supervisors, one scope) — R3 | second `acquireStartLock` blocks/throws (`lock.ts:50-104`) | start lock; stale-holder auto-clear via `kill(pid,0)` |
| F10 | **Worker orphaned on stop** (child spawned grandchildren) — R5 | only direct child killed | `detached:true` pgid + `-pgid` signal (`supervisor.ts:182-202`) |
| F11 | **SIGTERM ignored** (hung/D-state process) | `killAndVerify` still alive after grace | SIGKILL escalation; CRITICAL log + `undead` + exit 1 (`supervisor.ts:204-212`, `main.ts:3300`) |
| F12 | **Stale OS unit after upgrade** (unit → old artifact) — §9.3 | `soxe doctor`: unit `appliedHash` ≠ installed checksum | `[inv:os-unit-content-addressed]`: re-`enable` on upgrade rewrites unit |
| F13 | **M3 stderr lost** (stdio serve has no logs by default) — BL-46 | no `~/.sox/logs` entry for live `serve` version when neither `--log` nor `SOX_SERVE_LOG=1` is set | opt-in stderr sink exists (`main.ts:4552-4561`); make it the **default** for M4 units (§9.2); never write diagnostics to stdout (corrupts JSON-RPC) |
| F14 | **Hash-fallback embedding** (scrubbed SOX_EMBED_*) — BL-48/BL-52 | `memory_ping` `embed_on_hash_fallback:true` | SOX_EMBED_* in scrub allowlist (`supervisor.ts:266-284`) + unit `EnvironmentVariables` (§9.2) |
| F15 | **`soxe list` reports RUNNING for OS-unit service it doesn't track** — §10 | reconcile finds OS unit not in runtime.json | adopt into descriptor with `owner:os-unit` (§10.2) |

---

## 13. Invariants checklist + Rules agents MUST follow

### 13.1 Invariants (testable)

- `[inv:singleton]` — at most one live process per `[def:singleton-key] = (id, store-resource)` (§5.1).
- `[def:singleton-key]` — the key is the canonical backing resource (db_path / socket / host:port), **not** scope, **not** socket-alone (§4.3).
- `[auth:supervisor-then-os-then-os-reality]` — liveness authority order: live GC-verified supervisor > OS unit > socket/process reality (§3.3).
- `[inv:list-never-lies]` — RUNNING requires reality-verified liveness; a file flag is never sufficient (§10.3, generalizes C4).
- `[inv:unload-then-reap]` — unload the OS unit before killing the pid (§8.4).
- `[inv:os-unit-generated]` — OS units are generated by `soxe service enable` from the manifest; hand-authoring is forbidden (§9.1).
- `[inv:os-unit-content-addressed]` — re-enable on artifact change; never point a unit at a stale artifact (§9.3).
- `[inv:reversible-injection]` (ADR-0004) extends to OS units — uninstall reverses the owned `os-unit` entry (§9.4).
- `[inv:crash-loop-cap]` — bounded restarts; give up + report after N-in-window (§11.3).
- `[contract:signal]` — services drain+exit on SIGTERM within `stop_timeout_ms`, propagating to workers (§8.1).
- `[inv:deploy-verified]` — a deploy is complete only when the RUNNING process is verified to execute the new artifact; build success / `kickstart` exit 0 / `loaded: yes` are not evidence (§9.4a).
- `[inv:env-preserved-on-regenerate]` — regenerating a unit must not silently drop environment it previously carried (§9.4a, BL-375).
- `[inv:no-illegal-transition]` — only the §6 state edges are legal.

### 13.2 Rules agents MUST follow when modifying supervisor/service code

1. **Never spawn a service without the §5.2 singleton guard.** Socket probe **and** entrypoint-token
   scan **and** cross-scope ownership check, before `spawn`. (Reaping a *stale* instance is not the
   same as reusing a *live* one — do both correctly.) **This includes `cmdServe`:** if it ever gains
   daemon-autostart it MUST run the §5.2 guard first (it does not autostart a daemon today — verified
   §5.4). Implemented for the service-registry path in Slice 1 (`healSingletonDuplicates` +
   `findCrossScopeSharers`).
2. **Never report RUNNING without reality verification** (`process.kill(pid,0)` + socket/OS as
   applicable). `soxe list`/`status` render reconciled descriptors, never raw `running` flags
   (`[inv:list-never-lies]`).
3. **All teardown goes through verified-stop + the identity reaper.** Use `killAndVerify` and
   `reapOrphansForExtension`; honor exit-code honesty (`exit 1` on `undead`). Never signal-and-exit
   without verifying death.
4. **OS units are generated, never hand-edited.** Only `soxe service enable|disable` may create/remove
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

### Slice 1 — Cross-scope singleton + reconcile heal (closes the live half of BL-50/F1/F7) — ✅ IMPLEMENTED (`feat/service-lifecycle-slice1`)

- **Goal:** the §5.2 start guard scans the entrypoint token and checks cross-scope ownership (not just
  the socket), and a §5.3 reconcile heal kills the loser of an existing duplicate pair.
- **Delivered:**
  - `libs/host-runtime/src/singleton.ts` — `resolveStoreResource` (`[def:singleton-key]` anchor:
    db_path → socket → host:port, with `x-sox-singleton-key` opt-in), `singletonKey`,
    `findCrossScopeSharers` (§5.2 step 4), `chooseSurvivor` + `processStartTime` (oldest-by-`lstart`
    tiebreak, item 5), `healSingletonDuplicates` (§5.3 — no-op on ≤1, kill loser(s) on ≥2),
    `canonicalizePath`/`expandConfigValue`. Reuses `reaper.ts` (`findOrphansByIdentity`,
    `killAndVerify`, `identityToken`) — no re-implemented process scan/kill.
  - `apps/sox/src/main.ts` — `cmdStart` service-registry guard now runs **socket probe + entrypoint
    scan + cross-scope collision check**, keyed on the store-resource; helper functions
    `resolveStoreResourceForScope`, `collectCrossScopeResources`, `entrypointTokenForService`.
- **Acceptance — MET (gates below):** two scopes resolving the same `db_path` (different sockets) ⇒
  exactly one daemon (e2e Step 7c, 6 assertions); a live duplicate pair ⇒ `healSingletonDuplicates`
  kills the loser (unit test, real spawned procs); a single healthy daemon is **never** reaped (unit +
  e2e); `cmdStart` records the shared instance RUNNING with a §5.2 notice.
- **Gate results (nx targets only; built before testing per BL-4):**
  - `nx build host-runtime` ✅, `nx build sox` ✅ (+ deps), `nx build memory-daemon` ✅.
  - `nx lint host-runtime` ✅, `nx lint sox` ✅.
  - `nx test host-runtime` → **146 passed** (incl. new `singleton.spec.ts`, 32 cases).
  - `nx test sox` → **30 passed**.
  - `nx run host-runtime:test-e2e` → **99 passed, 0 failed** (was 93; +6 Slice-1 Step 7c), stable
    across 3 cache-busted runs.
  - `nx affected -t build,lint,test --base=main` → **20/20 projects green** (this run also surfaced +
    fixed a pre-existing tokenguard-core bug, BL-56 — see BACKLOG).
  - `registry:sync-index` → **no checksum drift** (CLI/lib change, not a shipped extension artifact).
- **Designed-not-built remainder of Slice 1 (folded into later slices):** the reconcile heal is wired
  at *start*; running it on every `soxe list`/`status`/`doctor` (§10.2) and rendering `owner`/`liveness`
  descriptors lands with Slice 4's universal reconcile pass.

### Slice 1.5 — Front-shim service-proxy (M3↔M4 bridge; zero-downtime upgrades) — ✅ IMPLEMENTED (`feat/service-proxy-slice1_5`)

- **Goal:** decouple the JSON-RPC stdio surface from the tool implementation so a backend upgrade is a
  rolling restart with **no client reconnect** for behavior-only changes; an interface change emits
  `tools/list_changed` (reconnect only as a fallback).
- **Delivered:**
  - `libs/service-proxy/` — dependency-free leaf lib (node `net`/`crypto`/`fs`/`path` only):
    - `framing.ts` — `encodeFrame` / `FrameDecoder` (4-byte big-endian length-prefixed JSON frames,
      streaming reassembly, 16 MiB cap).
    - `jsonrpc.ts` — JSON-RPC 2.0 types + guards + `ERR_BACKEND_UNAVAILABLE` (-32001).
    - `schema-hash.ts` — `computeSchemaHash` (canonical/recursive-key-sorted sha256 of `tools/list`;
      `[contract:schema-hash]`).
    - `backend.ts` — `serveBackend({ socketPath, handler })`: UDS listener (0600, stale-socket
      unlink) the daemon wraps around its in-process dispatcher.
    - `dial.ts` — `dialBackend`: bounded re-dial (50ms→2s, cap), in-flight requeue across reconnect,
      bounded queue, fast-fail `-32001` past the give-up bound while keeping re-dialing (auto-recover).
    - `shim.ts` — `runFrontShim`: stdio↔UDS shim; serves `initialize`+`tools/list` from cache; proxies
      everything else; schema-hash handshake + `notifications/tools/list_changed` nudge;
      `[inv:no-stdout-diagnostics]` (only framed JSON-RPC to stdout).
    - `socket-path.ts` — `backendSocketPath(socketDir, singletonKey)`: data-root-derived UDS path
      keyed by `[def:singleton-key]` (no port selection), sun_path-length-bounded.
  - `apps/sox/src/main.ts` — OPT-IN `--proxy` / `lifecycle.proxy:true` / `lifecycle.serve_mode:"proxy"`
    branch of `cmdServe`; backend socket derived via `resolveStoreResource` + `singletonKey` (the SAME
    Slice-1 key) + `backendSocketPath`. **Default exec/`--log` paths unchanged when not opted in.**
  - `tools/probe-service-proxy-zdt.mjs` — real-process zero-downtime e2e probe, wired as e2e Section SP.
- **Acceptance — MET (gates below):** a client `tools/call` succeeds across a backend rolling-restart
  with the stdio pipe never closing and the NEW backend answering (zero reconnect); backend-down past
  the bound → pending fast-fail `-32001`, pipe stays open, auto-recovers; schema-hash change → cached
  schema kept + `tools/list_changed` emitted; UDS path data-root-derived (no port selection);
  no-stdout-diagnostics invariant proven. Sequenced **after** Slice 1 (reuses its store-resource
  singleton key) and **before** Slice 2 (the backend it upgrades becomes the M4 service Slice 2
  supervises). **NOT in scope (deferred):** flipping memory-server (or any server) to proxy mode (a
  separate migration with reconnect implications); the `run/serve/` serve-record breadcrumb (folded
  into the memory-server proxy migration, since it is most useful once a backend actually runs).
- **Gate results (nx targets only; built before testing per BL-4):**
  - `nx build service-proxy` ✅, `nx build sox` ✅ (+ deps, service-proxy ordered first).
  - `nx lint service-proxy` ✅, `nx lint sox` ✅.
  - `nx test service-proxy` → **30 passed** (framing 7, schema-hash 9, dial 5, shim 4, socket-path 5).
  - `nx test sox` → **30 passed**; `nx test host-runtime` → **146 passed**.
  - `nx run host-runtime:test-e2e` → **100 passed, 0 failed** (was 99; +1 Section SP zero-downtime),
    stable across 3 cache-busted runs; standalone probe `node tools/probe-service-proxy-zdt.mjs` → PASS.
  - `registry:sync-index` → **no checksum drift** (CLI/lib change, not a shipped extension artifact).

### Slice 1.6 — M3→M4 DEFAULT FLIP: proxy-by-default + memory-server backend — ✅ IMPLEMENTED (`feat/proxy-default-memory-backend`)

- **Goal:** make the front-shim the DEFAULT for `mcp-server` services and FLIP memory-server onto it,
  so a behaviour/code upgrade of memory-server no longer forces the MCP client to reconnect. Completes
  the M3→M4 bridge that Slice 1.5 left opt-in.
- **Delivered:**
  - `libs/service-proxy/src/ensure-backend.ts` — `ensureBackend({ socketPath, singletonKey, command,
    args, env, … })`: the auto-managed, **singleton-guarded** backend lifecycle. Probe-then-spawn
    (detached + `unref`, stderr inherited, NEVER stdout); an **O_EXCL spawn lock** keyed on the
    `[def:singleton-key]` digest (with pid-liveness + TTL staleness reclaim) serializes concurrent
    shims to ONE spawn per store (single-writer). Dispositions: `already-live` / `spawned` /
    `adopted-after-wait` / `failed`. Also exports `probeSocketLive`.
  - `libs/service-proxy/src/{shim,dial}.ts` — `runFrontShim` gains an `ensure` hook called on START and
    re-called on a dropped backend connection (`dialBackend` gains `onDisconnect`), so a CRASHED
    backend is brought back up (a clean rolling-restart respawns itself; the re-ensure is idempotent).
  - `extensions/.../memory-server/src/backend.ts` — `runBackend` + `handleBackendRequest`: wraps the
    existing `TOOLS` + `handleToolCall` with `serveBackend`, mirroring the MCP `serve()` surface
    (`initialize` / `tools/list` / `tools/call`). The C6 permission guard is unchanged (it runs inside
    `handleToolCall` before any db_path opens). `publishSchema` writes the canonical `tools/list` to
    `dist/schema.json` (atomic tmp+rename). The entrypoint dispatches on `SOX_PROXY_BACKEND=1` (backend
    mode) vs the unchanged direct-stdio `serve()` (opt-out / dev), guarded by `require.main === module`.
  - `extensions/.../memory-server/scripts/gen-schema.cjs` — postbuild step generating `dist/schema.json`
    from `buildToolsListResult()` so the published schema can never drift from the served surface
    (`[contract:schema-hash]` — verified equal in `backend.spec.ts`).
  - `extensions/.../memory-server/extension.json` — `lifecycle.serve_mode:"proxy"` +
    `lifecycle.schema_path:"dist/schema.json"`; `package.json` adds `@adhd/sox-service-proxy` dep.
  - `apps/sox/src/main.ts` — `cmdServe` flips to **proxy DEFAULT for `type: mcp-server`** with opt-out
    (`--no-proxy` / `serve_mode:"direct"` / `proxy:false`); the shim is given the `ensure` callback that
    spawns the backend with `SOX_PROXY_BACKEND=1` + the SAME policy-env + `SOX_CONFIG_*` the direct path
    injects. `rollingRestartConsumer` routes a proxy-mode `mcp-server` upgrade through the new
    `restartProxyBackend` (verified-stop the backend by entrypoint token → unlink stale socket →
    re-ensure on new code), returning the new **`backend-restarted`** disposition. Direct-mode servers
    keep the legacy `reconnect-needed` path.
  - `tools/probe-memory-backend-zdt.mjs` — real-process e2e (Section **SPM**): two shims (two sessions)
    share ONE real memory-server backend (single-writer, test-scoped pid accounting), a backend
    rolling-restart, both `tools/call` succeed with stdio pipes never closing, single-writer holds
    before+after.
- **Acceptance — MET (gates below):** proxy default ON for mcp-server with a working opt-out hatch;
  memory-server runs as a singleton-guarded UDS backend; multi-shim → one backend; behaviour upgrade =
  backend rolling-restart with zero client reconnect.
- **Migration note (one-time):** flipping memory-server requires **exactly ONE final client reconnect**
  to replace the running direct-stdio server with the shim. After that, memory-server upgrades restart
  only the backend → no further reconnects.
- **Gate results (nx targets only; built before testing per BL-4):**
  - `nx build service-proxy memory-core memory-enrich memory-server host-runtime sox` → **6/6 green**.
  - `nx lint` (same 6) → **6/6 green**.
  - `nx test service-proxy` → **37 passed** (was 30; +ensure-backend 5, +shim ensure 2).
  - `nx test memory-server` → **84 passed** (+`backend.spec.ts` 6); `nx test host-runtime` → **146**;
    `nx test sox` → **30**.
  - `nx run host-runtime:test-e2e` → **101 passed, 0 failed** (was 100; +1 Section SPM); standalone
    `node tools/probe-memory-backend-zdt.mjs` → PASS (8/8).
  - `registry:sync-index` → **memory-server checksum drift EXPECTED** (its entrypoint artifact changed)
    → regenerated `registry/index.json` (new `memory-server` checksum `sha256:c04806ae1ace…`); only
    memory-server's checksum changed.
- **RESOLVED 2026-07-18 (BL-62)** — shared-backend project_path attribution (carried from BL-56): the
  original concern below (spawn-time `SOX_CONFIG_PROJECT_PATH` env captured only from the FIRST shim to
  connect to a shared singleton backend) turned out to be one symptom of a broader class — ANY
  server-side fallback for an omitted `project_path` (env tier, shim cwd, or otherwise) mis-attributes
  data for a multi-project shared backend, because the fallback value is fixed at spawn/connect time
  while the actual caller can vary per call. The per-call MCP-roots thread-through mentioned below was
  never built; instead `memory_write`/`memory_write_batch` now REQUIRE `project_path` explicitly on
  every call and reject with `E_MISSING_PROJECT_PATH` if it's omitted — no server-side fallback of any
  kind, so there is no captured-at-spawn value left to be wrong. Reads (`memory_recall`/`memory_topics`/
  etc.) never inferred a per-call `project_path` either; omitting it there was and remains a valid
  "search every project" request, not an attribution concern. See
  `libs/memory-core/src/write.ts`'s top-of-file BL-62 doc comment and
  `extensions/bundles/sox-memory-bundle/members/memory-server/CLAUDE.md` for the full current contract.
  Original note, preserved for history:
  > `(unverified)` — the backend is a shared singleton per store, so a per-connecting-client workspace
  > (`SOX_CONFIG_PROJECT_PATH`) injected at shim spawn does NOT propagate to the already-running shared
  > backend. Each shim still passes its own `SOX_CONFIG_PROJECT_PATH`, but the FIRST shim's value is
  > what the backend captured. Multi-project attribution for a shared backend likely needs the per-call
  > MCP-roots / caller path threaded through `tools/call` — flagged for the human; NOT silently
  > regressed (single-project use is unaffected).

### Slice 2 — `soxe service enable|disable` (OS-supervisor control surface, subsumes BL-51 + reboot half of BL-50) — ✅ IMPLEMENTED

- **Goal:** generate/load/unload launchd (macOS) + systemd (Linux) units from the manifest;
  idempotent + content-addressed; ownership-tracked; `[inv:unload-then-reap]`.
- **Delivered:**
  - `libs/host-runtime/src/os-unit.ts` — platform-pluggable OS-unit generator. `OsUnitPlatform`
    interface + `LaunchdPlatform` (plist, `launchctl bootstrap/bootout/print` via the `gui/<uid>`
    domain) + `SystemdPlatform` (`[Service]` unit, `systemctl --user enable --now/disable/is-active`)
    proving the seam; `detectOsSupervisor`/`getOsUnitPlatform` select per-platform.
    `deriveOsUnitSpec` reads the manifest `lifecycle` block (background→RunAtLoad, singleton→KeepAlive,
    ThrottleInterval≥10 for §11.3) and takes the resolved env/node/entrypoint/store; `render` is
    **content-addressed** (embeds `sox-os-unit content-hash:<16hex> artifact-hash:<…>`); env keys are
    sorted for a stable hash; XML-escaped. `resolveUnitNodePath`+`findNonVolatileNode` implement the
    §9.2/Appendix-B item 3 stable-node-path guard. `enableOsUnit` is idempotent
    ([inv:os-unit-content-addressed]); `disableOsUnit` unloads+removes; **`unloadThenReap`** enforces
    [inv:unload-then-reap] (unload → `reapByIdentity`→`killAndVerify`, `undead`-aware), reusing the
    BL-31 reaper (no re-implemented scan/kill).
  - `apps/sox/src/main.ts` — new top-level **`service`** verb routed to `cmdService`
    (`enable|disable|status|list`); `resolveOsUnitContext`/`buildOsUnitEnv` (the §9.2 env mirrors the
    supervisor scrub allowlist + SOX_CONFIG_*); `--dry-run`/`--unit-dir`/`SOX_OS_UNIT_DIR`/`--supervisor`/
    `--node-path`/`--allow-volatile-node` flags. `unloadOwnedOsUnitsBeforeReap` wired into all three
    `cmdStop` exit paths; `cmdUninstall` tears the unit down before store removal (§9.4);
    `reEnableOwnedOsUnit` in the `cmdUpgrade` rolling-restart (§9.3).
  - `libs/install-engine/src/ownership.ts` — new `os-unit` `OwnedEntry` kind (`label`, `unitPath`,
    `supervisor`, `appliedHash`) + `supersededEntries` case ([inv:reversible-injection]).
- **Acceptance — MET (gates below):** `service enable` renders + records a content-addressed unit;
  re-enable is a content-addressed no-op (idempotent); `service list`/`status` reconcile owner/loaded
  ([inv:list-never-lies]); `disable` unloads-then-reaps + removes the unit + clears ownership;
  `uninstall` leaves zero unit residue; the unload-before-kill ordering is asserted; **no real
  `~/Library/LaunchAgents` write and no real `launchctl load` occurs in any test** (sandboxed unit dir
  - fake exec; CLI integration uses `SOX_OS_UNIT_DIR` + `--dry-run`).
- **Gate results (nx targets only; built before testing per BL-4):**
  - `nx build host-runtime` ✅, `nx build install-engine` ✅, `nx build sox` ✅.
  - `nx lint host-runtime` ✅, `nx lint install-engine` ✅, `nx lint sox` ✅.
  - `nx test host-runtime` → **168 passed** (+`os-unit.spec.ts`, 22 cases; was 146).
  - `nx test install-engine` → **152 passed**; `nx test sox` → **42 passed** (+`service-os-unit.spec.ts`,
    7 cases; was 35).
  - `nx run host-runtime:test-e2e` → all stop/reap/orphan/unload-then-reap/disable sections PASS; the
    only failures are pre-existing/environmental in THIS worktree (the `@modelcontextprotocol/sdk`
    dependency is absent from node_modules so the memory-server self-contained bundle cannot build —
    BL41/SPM-bundle; and the SPM single-writer count is inflated by the dev box's own live
    memory-server backends — BL-63). NONE are caused by Slice 2.
- **`(needs-human-ack)` — real activation:** generating + `launchctl bootstrap`-ing a unit on the
  user's machine touches `~/Library/LaunchAgents` and pins a node binary (Appendix B item 3). Slice 2
  BUILDS + TESTS the capability only (sandboxed); the human must run `soxe service enable <svc>`
  themselves (and accept/override the pinned node path) to activate.
- **Designed-not-built remainder:** the authoring-scaffold lifecycle defaults + R6 SIGTERM handler
  generation are folded into a later authoring pass; the universal `soxe list` os-unit reconcile merge
  lands with Slice 4 (today the reconcile is surfaced via `service status`/`service list`).

### Slice 3 — Crash-loop cap + degraded policy + durable M3 logs (F13/F14, BL-46 closure in-framework) — ✅ IMPLEMENTED (crash-loop cap, v1.4.0)

- **Goal:** `[inv:crash-loop-cap]`, standardized DEGRADED reporting, durable stderr sink for
  `cmdServe`.
- **Touched:** `supervisor.ts` (restart cap), `log-manager.ts` + `cmdServe` (stderr sink),
  `cmdStatus`/`doctor` surfacing.
- **Acceptance:** a crash-looping service gives up + reports after N-in-window; live `serve` version's
  stderr is durably captured; `memory_ping` hash-fallback is impossible to miss.
- **Delivered (v1.4.0):**
  - `libs/host-runtime/src/crash-loop.ts` — `CrashLoopGuard` (5-in-60s rolling-window ring, item 4a;
    sticky give-up; durable `run/crash-loop/<key>.json` marker; `recordFailure`/`recordSuccess`/
    `clear`; marker read/list/clear helpers for status/doctor).
  - `supervisor.ts` — the unexpected-exit handler consults the guard BEFORE scheduling a respawn;
    capped ⇒ DEGRADED (give-up), durable `[crash-loop]` line via console + LogManager, NO respawn;
    `isCrashLooped()` accessor; explicit `start()`/`restart()` clears state + marker. Failures count
    process EXITS only — a health-timeout on a live child records nothing (proven by test (c)).
  - `apps/sox/src/main.ts` — `cmdStatus` renders a marker as DEGRADED + staleReason (exit ≥1);
    `cmdDoctor` reports a `CRASH-LOOP` anomaly. Both report-only ([inv:list-never-lies]).
  - Tests: `crash-loop.spec.ts` (guard: cap / window expiry / success reset / sticky cap / marker
    round-trip), `supervisor-crash-loop.spec.ts` (REAL crashing children: (a) N-in-window ⇒ give-up +
    frozen respawn count + marker, (b) explicit start clears + respawns, (c) slow-but-successful
    start records zero failures), `doctor-reconcile.spec.ts` (CLI surfacing in status/doctor).
- **Remainder (explicit, not silently dropped):** the F13 durable-M3-stderr default flip for direct
  `cmdServe` stays opt-in (`--log`/`SOX_SERVE_LOG=1`, BL-46) — M4 units already default durable logs
  (§9.2, Slice 2) and proxy backends log via `stderrLogPath` (BL-139); the direct-M3 default is
  deferred alongside the serve-path hardening. F14's framework half (SOX_EMBED_* allowlist + §9.2
  unit env) shipped in Slices 1–2; §11.4 REPORT-ONLY degraded policy was already conformant.

### Slice 4 — `soxe doctor` + full reconcile authority across all scopes (F6/F12/F15) — ✅ IMPLEMENTED (v1.4.0)

- **Goal:** one command that computes every descriptor across all scopes, surfaces split-brain, stale
  units, duplicates; the reconcile pass becomes the universal pre-step.
- **Touched:** `apps/sox/src/main.ts` (`cmdDoctor`), reconcile helper, `os-unit.ts` query.
- **Acceptance:** doctor detects an artifact-stale unit, an orphaned unit, a duplicate, a split-brain
  runtime.json, and proposes/executes the remedy.
- **Delivered (v1.4.0):**
  - `libs/host-runtime/src/reconcile.ts` — the safe-by-construction classification
    (`socketOwnerPids` lsof attribution + `classifyReconcileTargets`; see the v1.4.0 changelog for
    the five safety rules). Reuses `killAndVerify`/`chooseSurvivor`/`findOrphansByServiceId` — no
    reimplemented scan/kill.
  - `soxe doctor --reconcile [--dry-run] [--json]` — GC + identity-stray heal (reaps the BL-170
    zero-fd zombie class beside a positively-attributed live writer; heals ≥2 no-socket duplicates
    per §5.3) + split-brain runtime.json heal (F4/F6) + os-unit reconcile (F12 stale
    content/artifact, missing file, F15 orphaned unit — report-only with the exact remedy command) +
    crash-loop surfacing. Durable action log at `run/logs/doctor-reconcile/`; idempotent; exit 1
    only on `undead`.
  - `soxe doctor --install-tick [--interval <sec>]` / `--remove-tick` — the scheduled tick:
    launchd `StartInterval` / systemd `.timer` (new `OsUnitSpec.startIntervalSec` +
    `renderTimerUnit` seam in `os-unit.ts`), ownership-tracked under `doctor-tick`
    ([inv:reversible-injection]; also reversible via `service disable doctor-tick`), default 300s,
    node-path volatility guard identical to `service enable`.
  - Tests: `reconcile.spec.ts` (classification + fake-lsof attribution incl. the BL-170 shape),
    `os-unit.spec.ts` (StartInterval + `.timer` rendering, content-addressed),
    `doctor-reconcile.spec.ts` (CLI: sandboxed tick render/remove, dry-run vs heal vs idempotent
    re-run on a split-brain runtime.json, durable log, marker surfacing) — all sandboxed, zero real
    launchctl/LaunchAgents effects.
- **Remainder (explicit):** the reconcile is not yet the automatic pre-step of `soxe list`/`status`
  (§10.2 "run on every list/status") — it is a complete, schedulable command; folding it into
  list/status as a cheap pre-step is follow-on work (BACKLOG'd).

> **Sequencing rationale:** Slice 1 (DONE) closes the *correctness* hole (two writers) using only
> existing primitives — highest leverage, lowest risk, no new OS surface. Slice 1.5 (the front-shim)
> delivers zero-downtime upgrades and the M3→M4 bridge without yet touching the OS. Slice 2 adds the OS
> supervisor surface that Slices 3–4 then harden. This ordering means the dangerous F1/F7 bug is gone,
> and behavior-only upgrades stop forcing reconnects, **before** the larger OS-unit machinery lands.

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
- **OS units are generated from the manifest by `soxe service enable`, never hand-edited** —
  `[inv:os-unit-generated]` / `[inv:os-unit-content-addressed]` (re-enable on artifact change).
- **Never widen the supervisor env-scrub allowlist silently** — document it in the spec §7 and mirror
  it into the OS unit env (§9.2).

Deviating from the spec requires an ADR superseding the relevant section. The spec is versioned;
cite the section you relied on in your PR.
```

---

## Appendix B — assumptions: RESOLVED in v1.1.0 (one remains advisory)

All six are now decided. Five are settled; item 3 (OS-unit node path) keeps a *recommended default* that
needs a human ack at Slice-2 build time because the right node binary is machine-specific.

| # | Item | Decision (v1.1.0) | Where |
|---|---|---|---|
| 1 | M3 durable record | **Resolved:** no runtime.json *entry* (client owns the pid); `cmdServe` writes a self-cleaning *serve-record* breadcrumb under `run/serve/` for observability, never feeding the RUNNING decision. Ships in Slice 1.5. | §2, §5.4 |
| 2 | Cross-scope stop safety | **Resolved: REFUSE-IF-SHARED.** A scoped stop refuses to reap a store another scope references; `--all`/`doctor --force` overrides. Guard half done (Slice 1); refuse-on-stop half in Slice 2. | §4.4 |
| 3 | Stable node path | **Recommended default (needs human ack):** pin `fs.realpathSync(process.execPath)`; detect + warn on volatile nvm/asdf/volta paths, prefer a non-volatile `command -v node`, else require `--allow-volatile-node`. `(needs-human-ack)` at Slice-2 build. | §9.2 |
| 4 | Crash-loop cap + degraded policy | **Resolved:** cap **5-in-60s → give up** (DEGRADED); **report-only** on health-only degradation (restart only on actual exit). Ships in Slice 3. | §11.3, §11.4 |
| 5 | Singleton survivor tiebreak | **Resolved: oldest-by-`ps -o lstart`**, lowest-pid fallback. **Implemented** (`chooseSurvivor`/`processStartTime`, Slice 1). | §5.3 |
| 6 | BL-50 re-scope | **Resolved + reflected in BACKLOG:** the entrypoint-token reaper *exists*; the open half was the cross-scope singleton (now closed by Slice 1) + the OS-unit `[inv:unload-then-reap]` (Slice 2). | §1.3, §8.4 |

**Remaining for a human:** only item 3's node-path strategy, and only at the moment Slice 2 generates a
real unit on the user's machine (it touches `~/Library/LaunchAgents` / `~/.config/systemd/user`).
