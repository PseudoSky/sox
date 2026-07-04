# context-06 — hardening + closeout REPORT

> Status: **COMPLETE** (2026-07-04). ADR-0007 flipped to ACCEPTED in this closeout.

## Summary

Context-06 finished the runtime productionization: the four remaining shards (S8–S11), a live
write-saturation incident that re-prioritized the middle of the phase, the structural fix that
incident demanded (two-phase write), continuous supervision, backpressure, full write-path
observability, test hermeticity, and closeout. All work merged to main; every shard was
live-verified against the running system, not just unit-tested.

## Shards

- **S8 (BL-157)** — headless serve: stdio-EOF no longer tears down an HTTP-active backend
  (`shim.ts` gates the stdin close handlers on `httpPort`), plus BL-170 zombie-class fix
  (`runBackend` exits 1 on `E_LIVE_SOCKET`; SIGTERM wired pre-bind).
- **S9 (BL-162)** — memory-daemon extension removed; batch enrichment runs in-process in the
  memory-server writer (periodic tick). Integrator restored the `enqueueIngest` transactional
  producer the shard had over-removed — the enrichment heartbeat depends on it.
- **S10 (BL-164)** — baseline scripts promoted to `tools/baseline-capture/` (lint circular-dep
  resolved).
- **S11 (BL-165)** — `ingest` is the canonical ingestion layer: memory-server chunking
  (`splitIntoChunksSentence`) and memory-core's dedup hash (`hexSha256`) route through it,
  byte-identical parity locked by a permanent regression spec (39 assertions) + live E_DEDUP
  verification. Publishability decision: keep `ingest` private until the memory-core v1.0
  publish milestone (BL-113 tracks it).

## Incident-driven work (2026-07-04 write saturation)

Root cause was two mechanisms: CPU contention from ONNX embeds running INSIDE the serial
WriteQueue slot (client timeouts on writes that actually committed), and a dead outbox consumer
(built, unit-tested, wired to nothing since RS-6). Response, all landed on main:

- **Two-phase write (the core fix)** — Phase A holds the slot fully synchronously; embedding
  runs off-slot on the worker with a short `applyEmbedding` task. `SOX_SYNC_EMBED=1`
  kill-switch; `healMissingVectors` covers crashed Phase Bs (drained 1,129 legacy vectorless
  episodes live). Proven under load: 30 concurrent MCP writes during a full uncached ONNX test
  suite → 30/30 ok, client max 2.9s (incident era: 30–60s timeouts), embed latency p50 7.3s
  absorbed entirely off the write path, zero rejections, backlog self-drained to 0.
- **Time-based admission control** — estimated-wait E_BUSY with `retry_after_ms`
  (SOX_WRITEQ_DEADLINE_MS, default 20s under client timeouts).
- **Observability** — `memory_ping.store` carries `write_queue` (latency percentiles per task
  kind, depth/watermark, rejection counters), `enrichment` (queue-drain SLO: idle/ok/stalled),
  `embed_pipeline` (`time_to_vector_ms`, `embed_duration_ms`, `heal_lag_ms`, Phase-B counters,
  `embed_backlog`).
- **Continuous supervision (Slices 3–4)** — CrashLoopGuard (5-in-60s sticky cap) at both spawn
  seams; `soxe doctor --reconcile` (lsof socket attribution, safe-by-construction reaping —
  healed a real zombie + a lying runtime record on its first live run, and a real singleton
  violation during this closeout's upgrade churn); `--install-tick` launchd StartInterval unit.
- **Two-phase update (BL-189/BL-191, this closeout)** — `memory_update` given the same split;
  update re-embeds now flow through the instrumented pipeline.

## Hermeticity (incident-proven, this closeout)

- **BL-173** — smoke test injects a scratch `SOX_ECOSYSTEM_HOME` + `SOX_CONFIG_DB_PATH` into
  every child; asserts live data-root fingerprints byte-identical before/after; refuses to run
  against an unbuilt workspace (the BL-192 mis-filing class). Verified 13/0 on main with
  isolation proof.
- **BL-179** — root `scripts/*.test.ts` suites run under a vitest globalSetup mkdtemp sandbox
  (three live-registry corruptions on 2026-07-04 came from this gap). 268/268 on main.

## HF-5 forensics

See the dedicated section below — PASS, exactly one writer per store, shims are pure
front-ends, launchd accounted, server self-report matches the OS.

## Status surface ([inv:list-never-lies] completions)

- `enrichment.state === 'stalled'` demotes `soxe status` to DEGRADED with reason (BL-162
  remainder); interval os-units render `SCHEDULED (last exit N)` instead of DEAD (BL-185,
  verified live on doctor-tick).
- macOS env-based stray matching actually works now (BL-177): one-shot `ps -E` table scan on
  darwin; the procps per-pid path memoizes off after first failure (was 2.5 MB/day of ps
  errors in the tick log).

## Closeout actions (HF-6)

- ADR-0007 → **ACCEPTED** (status line carries the evidence pointer).
- BACKLOG swept: context-06 resolved BL-157, 162, 164, 165, 170, 172, 173, 174, 175, 177, 179,
  183 (deleted, not deprecated), 185, 186, 188, 189, 190, 191, 192 (resolved-invalid). Top-of-file
  status tables reconciled (39 open).
- Versions aligned (BL-190): memory-core 0.3.0, memory-server 1.3.0, changelog heads extended.
- Newly filed during closeout, left open deliberately: **BL-201** (spawn-lock debris sweep,
  LOW), **BL-202** (memory-core under-load test flakes, LOW), **BL-203** (doctor-tick unloaded
  after an artifact-changing `upgrade --all`; recovered + repinned to a non-volatile node;
  needs a controlled repro — MEDIUM/TRIAGE).
- All plan worktree branches merged and deleted; registry re-synced and all consumers upgraded
  after each dist-bearing merge; final smoke 13/0.

## HF-5 — single-writer forensics (2026-07-04, integrator, owner machine, read-only)

**Verdict: PASS — exactly one writer per store under the final posture.**

Posture at capture time: post S8/S9/S10, hot-triage, supervision Slices 3–4, backpressure,
two-phase write, and embed-pipeline metrics — all merged to main (`daff6f6`). Load probe
(30 concurrent MCP writes under full CPU contention) had completed earlier the same day.

### Evidence chain

1. **File handles (lsof)** — exactly one process holds `~/.memory/memory.db`,
   `-wal`, and `-shm`: pid **28875**
   (`node --enable-source-maps …/members/memory-server/dist/index.js`, started
   2026-07-04 17:16:17 local). A sweep of every `~/.memory/*.db` found no other holder
   of any store.
2. **Socket (lsof)** — the same pid 28875 is the sole binder of the singleton UDS
   `~/.adhd/sox-ecosystem/run/supervisors/proxy-8d80bb9bd257.sock`: one listener fd
   (14u) plus nine accepted peer connections (fds 18–26).
3. **Shim↔backend wiring proven end-to-end** — the integrator session's own stdio shim
   (pid 63861, `soxe serve memory-server --log`) shows fd 12 with kernel peer address
   `0x8a18e8b8a243344a`, which is exactly the backend's accepted-connection fd 23.
   Nine shims total were live (4 Claude sessions from `~/.adhd/sox-cli/bin/soxe`,
   5 from an `opencode web` session via repo `bin/soxe`) — all non-writers by design;
   none holds a db fd.
4. **BL-156 accounting (launchd daemon)** — moot post-S9: the memory-daemon extension
   was removed; `launchctl list | grep -i sox` shows only `com.sox.user.doctor-tick`
   (the Slice-4 reconcile tick), loaded, last exit 0, no resident pid (StartInterval —
   correct).
5. **Server self-report agrees with the OS** — in-session `memory_ping` on the live
   store returned `instance.pid: 28875`, `transport: "backend"`, matching lsof exactly.
   Health at capture: `wal_bytes: 0`, fresh `last_checkpoint_at`, `enrichment.state:
   "idle"`, `embed_backlog: 0`, write-queue `rejections: 0`, `slow_tasks: 0`.
6. **Spawn-lock accounting (anomaly investigated, accounted)** — the spawn lock
   `proxy-backend-23dbf1ed.lock` (key `memory-server db:/Users/nix/.memory/memory.db`)
   records pid 28869, now dead, timestamped 17:16:22 — five seconds AFTER the live
   backend's spawn. Reading `ensure-backend.ts`: this is a racer shim that acquired the
   spawn lock during the 17:16 restart window and died before its `finally
   { releaseLock() }` ran. Correctness is unaffected by construction: backend liveness
   is derived exclusively from socket probe + RPC handshake (never the lock pid), and
   `tryAcquireLock` reclaims any lock whose holder fails `pidAlive` or exceeds the 30s
   TTL. The debris self-heals on next contention. Filed as hygiene item BL-201
   (doctor --reconcile could sweep dead-holder lock files).

### Invariants confirmed

- `[inv:singleton]` — one backend per singleton key, O_EXCL spawn lock + double-checked
  handshake under lock (SA-4 paths read and verified against live state).
- Single writer per store — one process, one set of db fds, one UDS listener.
- Shims are pure front-ends — many concurrent shims, zero db fds among them.
- No orphaned/zombie backend processes matching memory-server entrypoints (the
  BL-170/BL-176 zombie class is absent under the fixed posture).
