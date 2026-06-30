# lifecycle — LIFECYCLE

> **Slug is identity.** This filename and the `lifecycle` slug are immutable once assigned.

**Phase:** runtime · **Depends on:** service-runtime · **Guard:** `bash .workflow/plans/extension-install-model/scripts/guards/lifecycle.sh`

---

## Goal

After this state, the full supervised lifecycle CLI works end to end: `install→start→list→details→exec→disable→enable→stop→uninstall`. All nine verbs work; `list` shows `RUNNING`; `details` shows `pid`+`scope`; `exec` returns output; `disable` stops the pid; `enable` restarts it; `stop` leaves zero orphan pids; `uninstall` removes the lockfile/registry entry. This satisfies `[dod.6]`.

---

## Semantic Distillation

- **Primitive:** MODIFY `apps/sox/src/main.ts` + `libs/host-runtime/src/supervisor.ts` — wire `disable`, `enable` verbs; ensure `list`, `details`, `stop`, `uninstall` behave as specified.

- **Reference Pattern:** `service-runtime` already landed `supervisor.ts` with the cwd fix. `cli-wiring` landed `main.ts` with `install`, `build`, `diff`, `update`. This state rebases onto both and adds `disable`/`enable` dispatch plus any missing supervisor methods.

- **Delta Spec:**
  - `main.ts`: wire `disable <id>` → `supervisor.disable(id)` and `enable <id>` → `supervisor.enable(id)`.
  - `supervisor.ts`:
    - `disable(id)`: sends SIGTERM to the running pid; updates the registry entry to `status: 'disabled'`. Does NOT remove the entry.
    - `enable(id)`: respawns the service from the registry entry; updates status to `running`.
    - `list()`: returns all registry entries with their current status; CLI prints `RUNNING` when status is running.
    - `details(id)`: returns the registry entry including `pid`, `scope`, `storePath`.
    - `stop()`: stops ALL running services; waits for them to exit; verifies zero orphan pids.
    - `uninstall(id)`: removes the registry entry + the store dir.
  - `stop` must send SIGTERM, wait for child exit (up to 5s), then SIGKILL if not exited. Leaves zero orphan pids.

- **Invariants:** `[inv:tier3-proof]` — guard drives all nine verbs via the harness. `[inv:sandbox-isolation]` enforced by `probe_done`. Merge: this state rebases onto `service-runtime`'s `supervisor.ts` and `cli-wiring`'s `main.ts`.

- **Validation:** `bash .workflow/plans/extension-install-model/scripts/guards/lifecycle.sh` — runs all nine verbs in sequence; asserts each observable.

---

## Acceptance criteria

Checked by audit-final (terminal gate).

- [ ] **[lifecycle.1]** `soxe install → start → list` shows `RUNNING` for the installed service.
      Via guard: `bash .workflow/plans/extension-install-model/scripts/guards/lifecycle.sh`
- [ ] **[lifecycle.2]** `soxe details <id>` shows `pid` and `scope` in output.
      Via guard.
- [ ] **[lifecycle.3]** `soxe exec <id> memory_recall '{}'` returns tool output (service running).
      Via guard.
- [ ] **[lifecycle.4]** `soxe disable <id>` stops the service; subsequent `list` no longer shows `RUNNING`.
      Via guard.
- [ ] **[lifecycle.5]** `soxe enable <id>` restarts the service; `list` shows `RUNNING` again.
      Via guard.
- [ ] **[lifecycle.6]** `soxe stop` leaves zero orphan pids after the full suite.
      Via guard (probe_done also catches any orphan via sandbox cleanup).
- [ ] **[lifecycle.7]** `soxe uninstall <id>` removes the registry entry.
      Via guard.

---

## Reservations

```text
read_only:  ["libs/install-engine/src/install.ts",
             "libs/install-engine/src/lifecycle.ts",
             "libs/install-engine/src/capabilities/run-service.ts"]
mutates:    ["apps/sox/src/main.ts",
             "libs/host-runtime/src/supervisor.ts",
             "scripts/guards/lifecycle.sh"]
```

**Merge protocol:** This state rebases onto `service-runtime`'s `supervisor.ts` (which fixed the cwd) and `cli-wiring`'s `main.ts` (which wired install/build/diff/update).

---

## Contract Promise

- **Modified:** `main.ts` — adds `disable`, `enable` dispatch; `supervisor.ts` — adds `disable()`, `enable()`, ensures `list()`, `details()`, `stop()`, `uninstall()` behave as specified

---

## Commit points

- [ ] **After disable/enable wiring** — commit `main.ts` + `supervisor.ts`:
      `feat(eim): lifecycle — wire disable/enable; supervisor stop/uninstall hardened`
- [ ] **After the guard passes** (mandatory):
      `feat(eim): lifecycle complete — guard green ([dod.6])`

---

## Notes for executor

- The `stop` command must handle the case where no services are running (empty registry) gracefully — exit 0, no error.
- Orphan detection: after `soxe stop`, check that none of the pids from `details` are still alive via `kill -0 <pid>`. The guard verifies this by checking `list` shows no `RUNNING` entries after stop.
- `uninstall` for a service must also call `soxe stop <id>` first to avoid orphan pids — or refuse if still running. Coordinate the decision with the enforcement state (which runs later).
