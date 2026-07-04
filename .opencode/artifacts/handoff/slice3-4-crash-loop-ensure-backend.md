# Handoff — Slice 3 crash-loop cap: the `ensureBackend` seam integration (for the integrator)

**From:** worktree agent `worktree-agent-a605b86bb76941c53` (Slices 3–4, service-lifecycle spec v1.4.0)
**To:** integrator (and/or the live-incident agent owning `libs/service-proxy/src/ensure-backend.ts` for BL-170)

## Why this is a handoff, not a commit

The crash-loop primitive (`CrashLoopGuard`, `libs/host-runtime/src/crash-loop.ts`) is implemented,
exported, and wired into the `supervisor.ts` respawn seam. The remaining spec-designated seam is the
shim's backend re-ensure loop (`ensureBackend` re-called on every dropped connection) — but:

1. `libs/service-proxy` is a **dependency-free leaf** (spec §9.5.4, node builtins only) — it must
   NOT import `@adhd/sox-host-runtime`, so the guard cannot live inside `ensure-backend.ts`.
2. `ensure-backend.ts` and the serve path are under concurrent BL-170/BL-157 hardening by the
   live-incident agent — my file set must stay disjoint.

The correct integration point is therefore the **caller**: the `ensure` closure `cmdServe` builds
in `apps/sox/src/main.ts` (the proxy branch, ~line 6806, `runFrontShim({ ensure … })`), which
already lives in a package that imports host-runtime.

## The integration (≈6 lines in cmdServe's proxy branch)

```ts
// once, next to where backendSock/key are derived:
const backendCrashLoop = new CrashLoopGuard({ key: `${extId}@proxy-backend` }); // 5-in-60s defaults

// inside the `ensure` callback, wrapping the existing ensureBackend(...) call:
if (backendCrashLoop.isCapped()) {
  diag(backendCrashLoop.giveUpLine()); // stderr only — [inv:no-stdout-diagnostics]
  return; // stop the re-ensure storm; marker already written for status/doctor
}
const r = await ensureBackend({ ... });                       // (unchanged call)
if (r.disposition === 'failed') backendCrashLoop.recordFailure();
else backendCrashLoop.recordSuccess();                        // spawned | already-live | adopted-after-wait
```

Semantics this buys (matches §11.3 exactly):

- 5 failed ensure attempts within 60s ⇒ the shim STOPS respawning the backend (no spawn-fail-spawn
  storm across reconnect loops), and the durable marker under `run/crash-loop/` makes the give-up
  visible in `soxe status` (DEGRADED + `[crash-loop]` reason) and `soxe doctor` (CRASH-LOOP anomaly)
  — the surfacing is already wired and tested on my branch.
- Any successful ensure resets the counter (`recordSuccess`), so a transient blip never latches.
- An explicit re-serve / `soxe start` clears via `CrashLoopGuard.clear()` semantics (a fresh shim
  constructs a fresh guard; the marker is cleared on the next `recordSuccess`/`clear`).

`CrashLoopGuard` is exported from `@adhd/sox-host-runtime` (already in main.ts's import surface —
just add `CrashLoopGuard` to the existing import list).

## Everything already delivered on my branch (no action needed)

- `crash-loop.ts` + guard wired into `ProcessSupervisor` (M1 respawn path) with real-process tests.
- `soxe status` / `soxe doctor` / `soxe doctor --reconcile` give-up surfacing (report-only; explicit
  start clears).
- Slice 4: `doctor --reconcile` (safe stray heal incl. the BL-170 zero-fd-zombie class via socket
  attribution), `doctor --install-tick/--remove-tick` (launchd StartInterval / systemd .timer),
  reconcile classification lib (`reconcile.ts`), spec v1.4.0.
