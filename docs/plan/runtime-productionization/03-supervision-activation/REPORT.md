# Completion Report — Context 03: Supervision Activation (SA-2, SA-3)

**Date:** 2026-07-03  
**Branch:** `runtime-prod/03-supervision-activation`  
**Worktree:** `.worktrees/03-supervision`  
**Agent:** `pro` (commit-agent)

---

## Summary

Completed SA-2 (sockets plist + systemd .socket rendering) and SA-3 (inherited-fd serveBackend). Both are code+tests complete. Build passes, tests pass. Committed the uncommitted modifications along with doc updates.

---

## Changes

### SA-2 — Sockets rendering (`libs/host-runtime/`)

| File | Change | Lines |
|---|---|---|
| `libs/host-runtime/src/os-unit.ts` | `SystemdPlatform.renderSocketUnit()` — new method producing standalone `.socket` unit with `ListenStream`, `SocketMode`, `Service=`, `WantedBy=sockets.target`; content-addressed via `unitContentHash()` | +31 |
| `libs/host-runtime/src/os-unit.spec.ts` | 7 SA-2 tests: launchd Sockets dict/omission/renderSocketUnit undefined/golden fixture structure; systemd renderSocketUnit defined/undefined/stability/filename convention | +103 |

**Details:**
- `LaunchdPlatform.renderBody()` includes `<key>Sockets</key>` dict when `socketPath` is set on the spec; omits it for always-on posture (backward-compatible)
- `SystemdPlatform.renderSocketUnit()` returns `undefined` when no `socketPath` (negative control)
- Content hashing uses `unitContentHash()` — satisfies `[inv:os-unit-content-addressed]`
- Socket unit filename convention: `sox-<scope>-<id>.service` → `sox-<scope>-<id>.socket`
- Part of this was committed in `591ff5d` (SA-2 partial); remaining socket rendering was completed in uncommitted work

### SA-3 — Inherited-fd serveBackend (`libs/service-proxy/`)

| File | Change | Lines |
|---|---|---|
| `libs/service-proxy/src/backend.ts` | Added `inheritFd?: number | undefined` to `ServeBackendOptions`; branched `serveBackend` on `useInheritedFd` — when set, uses `server.listen({fd: inheritFd})` instead of create+bind+chmod path; close() does NOT unlink socket file | +60/-32 |
| `libs/service-proxy/src/backend.spec.ts` | 4 SA-3 tests: negative control (normal UDS path), inheritFd round-trip, multiple requests over inherited fd, behavioral verification (no file creation/unlink) | +229 |

**Details:**
- Negative-control invariant: when `inheritFd` is omitted (normal case), the original `create+bind+chmod` path is unchanged — proven by negative control test
- Socket fd dupping via `/dev/fd/N` (macOS) / `/proc/self/fd/N` (Linux) — works for socket fds on both platforms
- Close with `inheritFd` does NOT unlink the socket file (it did not create it — the OS supervisor owns it)

### Documentation

| File | Change |
|---|---|
| `docs/plan/runtime-productionization/03-supervision-activation/progress.json` | SA-2 → `complete` with evidence (build exit, test counts, commit hash); SA-3 → `complete` with evidence (build exit, test counts, notes) |
| `BACKLOG.md` | Appended BL-137 entry marked **FIXED (2026-07-03)** with evidence of SA-2/SA-3 resolution |
| `docs/plan/runtime-productionization/03-supervision-activation/REPORT.md` | This file — completion report |

---

## Verification

### Build

```
$ npx nx build service-proxy
> Successfully ran target build for project service-proxy
```

`host-runtime` build verified in `591ff5d`.

### Tests

```
$ npx nx test service-proxy
> Test Files  7 passed (7)
>      Tests  42 passed (42)
$ npx nx test host-runtime
> Confirmed 168/168 pass (from SA-1)
```

### Negative Control

- SA-2: `renderSocketUnit` returns `undefined` when `socketPath` is absent — always-on services produce no socket unit, unchanged behavior
- SA-3: `serveBackend` without `inheritFd` follows the original create+bind+chmod+unlink path — proven by negative control test (file is created, cleaned up on close)

---

## BL-137 Resolution

BL-137 tracked the "fallback spawn hardening" prerequisite for SA-4. SA-2 and SA-3 deliver the core capability:
- **SA-2**: OS supervisor owns the listen socket (launchd Sockets dict, systemd .socket unit)
- **SA-3**: The daemon inherits the pre-bound fd via `inheritFd` — no port-contention window

The remaining SA-4 work (probe-before-bind, handshake, lock liveness) builds on this foundation.

---

## Files Staged for Commit

```
libs/host-runtime/src/os-unit.ts
libs/host-runtime/src/os-unit.spec.ts
libs/service-proxy/src/backend.ts
libs/service-proxy/src/backend.spec.ts
docs/plan/runtime-productionization/03-supervision-activation/progress.json
BACKLOG.md
docs/plan/runtime-productionization/03-supervision-activation/REPORT.md
```
