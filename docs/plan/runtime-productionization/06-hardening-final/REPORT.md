# context-06 — hardening + closeout REPORT

> Status: IN PROGRESS — HF-5 section final; closeout sections land with HF-6.

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
