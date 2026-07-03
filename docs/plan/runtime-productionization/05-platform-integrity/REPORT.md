# REPORT — Context 05 Platform Integrity (PI-1, PI-2)

**Date:** 2026-07-03
**Branch:** `runtime-prod/05-platform-integrity`
**Worktree:** `.worktrees/05-platform`

---

## Summary

Two context-05 items finalized in this session:

| Item | Status | BL | Description |
|------|--------|-----|-------------|
| PI-1 | **complete** | BL-136 | Identity-based reaping + soxe doctor + status reconciliation |
| PI-2 | **complete** | BL-138 | Unload-then-reap on every kill surface (cmdStart, restartProxyBackend) |

---

## PI-1 — Identity-based reaping (BL-136)

### What was done

- **`findOrphansByServiceId()`** — env-based stray detection via `SOX_SERVICE_ID` env var, with argv-token fallback when SOX_SERVICE_ID is absent
- **`adversarial stray test`** (`reaper.spec.ts`): mock ps-based env read proves the OLD path-based reaper (`findOrphansByIdentity`) misses a stray with different argv, while the NEW env-based reaper (`findOrphansByServiceId`) finds it. Negative control (wrong service ID) yields no match.
- **`findOrphansByServiceId` fallback** — when `SOX_SERVICE_ID` is empty/absent, falls back to argv token matching (proven by test spawning a real daemon with no env and matching by marker path)
- **`findOrphansByServiceId` dual match** — when both env AND argv match, the process is found with no false negative (proven by test spawning with both set)
- **`cmdDoctor()`** — scans all registry extensions, builds service env with `SOX_SERVICE_ID`, calls `findOrphansByServiceId`, and reports cross-build strays per `[inv:list-never-lies]`
- **`cmdDoctor()` cleanup** — removed stale `configEnv`/`svcEnv` vars that were unused after the match refactor
- **`cmdStatus()`** — identity-based stray reconciliation included in status output

### Files changed (PI-1)

| File | Change |
|------|--------|
| `libs/host-runtime/src/reaper.spec.ts` | +113 lines: adversarial stray (mock ps), fallback (real spawn no env), dual-match tests |
| `libs/host-runtime/src/reaper.ts` | findOrphansByServiceId (env + argv fallback) |
| `libs/host-runtime/src/index.ts` | re-export findOrphansByServiceId |
| `apps/sox/src/main.ts` | cmdDoctor, cmdStatus identity reconciliation |

### Verification

- `npx nx test host-runtime` → **171 passed**
- `npx nx build sox` → **success**
- `npx nx test sox` → **42 passed**

---

## PI-2 — Unload-then-reap on kill surfaces (BL-138)

### What was done

- **`cmdStart()`** (`main.ts:3593`): wired `unloadOwnedOsUnitsBeforeReap()` BEFORE verified-stop, with `[inv:unload-then-reap]` invariant annotation (§8.4 F3 resurrection guard). Best-effort across all scopes; when `startId` is provided, only that extension's OS unit is unloaded.
- **`restartProxyBackend()`** (`main.ts:1976`): wired `unloadOwnedOsUnitsBeforeReap()` BEFORE verified-stop, with `[inv:unload-then-reap]` invariant annotation (§8.5). Targets only the specific extension (`onlyId: extId`).
- **os-unit.ts comment fix**: stale header "Config-file-driven service provisioning" corrected to "Runtime-unit for sox supervised services" (in prior commit 90f5c77).

### Files changed (PI-2)

| File | Change |
|------|--------|
| `apps/sox/src/main.ts` | +10 lines: unload-then-reap in cmdStart and restartProxyBackend |
| `libs/host-runtime/src/os-unit.ts` | header comment fixed (prior commit 90f5c77) |

### Verification

- `npx nx test host-runtime` → **171 passed**
- `npx nx build sox` → **success**
- `npx nx test sox` → **42 passed**

---

## BACKLOG.md updates

Added `## Fixed — Context 05 platform integrity (2026-07-03)` section with entries:
- **BL-136** — FIXED (2026-07-03): identity-based reaping + soxe doctor + adversarial stray test
- **BL-138** — FIXED (2026-07-03): unload-then-reap on every kill surface

---

## Test results

```
host-runtime: 171 passed
sox:          42 passed (4 files, 42 tests)
```

## Commit

```
feat(sox,host-runtime): soxe doctor + identity reaping + unload-then-reap kill surfaces (PI-1 PI-2, BL-136 BL-138)
```

**Files staged:**
- `apps/sox/src/main.ts`
- `libs/host-runtime/src/reaper.spec.ts`
- `docs/plan/runtime-productionization/05-platform-integrity/progress.json`
- `BACKLOG.md`
- `docs/plan/runtime-productionization/05-platform-integrity/REPORT.md`
