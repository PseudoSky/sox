# Memory server recovery — 2026-08-11 — confusions that need fixing

> Durable record of the operational confusions encountered while restoring the live memory server
> after the BL-373 stale-sidecar incident (third recurrence, Aug 11). Each item is a tooling or
> operational gap, not a one-off. Backlog graph is read-only (live FK incident) so these are filed
> here pending a writable graph.

## Outcome (for the record)
- Recovery SUCCEEDED: renamed `~/.memory/memory.db-tshm` → `memory.db-tshm.stale-2026-08-11-recovery-20260811-163017` (never deleted; precedent files exist), killed the orphaned backend + respawning proxies, bootstrapped the launchd unit, verified `memory_ping` store block fully healthy (turso, integrity overall ok, wal stable, fts live) on pid 70323.
- **Runtime change made during recovery (surface to owner):** the unit now runs node **v26.5.1** (Homebrew) instead of the previous **nvm v24.11.1** — `soxe service enable` refused the volatile nvm pin, so I re-enabled with `--node-path=/opt/homebrew/Cellar/node/26.5.1/bin/node`. Plist content-hash changed to c4b09491. Not a bug in the guard (the guard is correct), but the recovery silently changed the service runtime; must be confirmed acceptable.
- `memory_ping` shows `status:'degraded'` — this is the PRE-fix bundle (6eff093e3991) whose status derives only from embed health; the store block (previously null) is now healthy. The ping-honesty fix (unmerged) will make status truthful. Verify embed state after warmup.

## Confusions / gaps to fix

### 1. `soxe service stop` does not exist (CLI gap)
Attempted `soxe service stop memory-server` → `unknown subcommand 'stop' (enable|disable|restart|status|list)`. The lifecycle CLI has enable/disable/restart/status/list but NO stop. `restart` also refuses on an unloaded unit ("not loaded — run enable first"), so the only stop path is `launchctl bootout` — which is not documented in the service CLI surface.
**Fix:** add `stop` (verified-stop per lifecycle spec `[inv:list-never-lies]`), or make `disable`/`restart` clearly perform a verified stop of the full process tree; document the launchctl fallback.

### 2. `launchctl bootout` exits 0 but the backend survives (verified-stop violation)
After `launchctl bootout gui/502/com.sox.user.memory-server` returned exit=0, the backend (91094) AND its fastembed child (91168) were still alive and serving. The proxy died; the backend didn't. I had to manually `kill -TERM` both. The tool's success exit code actively misled me into believing the service was stopped.
**Fix:** bootout/disable must verify the whole process tree is gone (or explicitly report survivors) — this is the `[inv:list-never-lies]` / verified-stop invariant from the lifecycle spec, apparently not enforced on this path.

### 3. Orphaned adhd-side serve proxies respawn the backend — the Aug-8 zombie sweep missed them
After killing 91094/91168, a NEW backend appeared (60520 at 4:30PM) that I first attributed to launchd KeepAlive or doctor-tick. Investigation showed the real respawn source: **pid 83087 — an adhd-side `node ~/.adhd/sox-cli/bin/soxe serve memory-server` proxy from a Wednesday session** (plus 84637, 40788). The Aug 8 "12 zombie backlog serve processes killed" sweep cleared backlog proxies but these memory-server proxies survived, and they spawn a backend whenever one dies.
**Fix:** (a) complete the zombie sweep for adhd-side `soxe serve memory-server` proxies; (b) a serve proxy should not respawn its backend unboundedly outside the unit's lifecycle; (c) document that two serve stacks may exist (project `bin/soxe` and adhd `~/.adhd/sox-cli/bin/soxe`).

### 4. `soxe service status` reports a live pid for a NON-loaded unit (confusing signal)
While launchd said `loaded: no / owner: none`, status still showed `live pids: 64006` (that pid was the zombie-proxy-spawned backend, not the unit's). Status mixes "unit not loaded" with "some process is running" without flagging that the process is orphaned/respawned.
**Fix:** status must distinguish `unit-loaded + owned pid` from `unloaded + orphaned process`, and warn when an orphaned process matches the entrypoint.

### 5. `soxe service enable` volatile-node refusal (correct guard, awkward recovery)
The guard refusing to pin the nvm node is GOOD (a version switch would orphan the unit). But it forced a runtime change during incident recovery (nvm 24.11.1 → Homebrew 26.5.1) with no way to say "keep the previous node". Consider: allow `--keep-existing-node` or surface the previous node path in the error so recovery doesn't silently alter the runtime.

### 6. Minor: zsh `PPID` is read-only
My bash line `PPID=$(ps -p ...)` failed with `read-only variable: PPID` — a footgun when scripting process-tree inspection. Use a different variable name in scripts/playbooks.

## Related deferred (unchanged)
- Backlog graph read-only (FK incident) — these items must be filed/resolved once D lands.
- Ping-honesty + engine-identity fixes are implemented on unmerged branches; `status:'degraded'` on a healthy store will be fixed by the ping-honesty merge.
- Smoke tests pending for the three weave branches; the gate task is in flight.
