# Memory Restoration — START HERE

> **This is the single entry point for all memory-subsystem restoration work.**
> If you are an agent picking this up, read [`STATE.md`](./STATE.md) first, then stop.
> Everything else is reference material you should open only when you need it.

**One path. Do not create a parallel doc tree.** Findings go in `findings/`, program state goes
in `STATE.md`, work order goes in `PLAN.md`, and defects go in the root `BACKLOG.md` — nowhere
else. Earlier work scattered these across `docs/ideas/`, `docs/research/` and two levels of
`docs/reporting/`, and agents read stale copies as a result.

---

## Read in this order

| # | Doc | What it answers | Read when |
|---|---|---|---|
| 1 | **[`STATE.md`](./STATE.md)** | **Where are we? What is next?** | **Always. Start here.** |
| 2 | [`PLAN.md`](./PLAN.md) | What order does the work go in, and why? | Before starting a state |
| 3 | [`../../../BACKLOG.md`](../../../BACKLOG.md) | Every known defect, with citations | Before filing anything |
| 4 | [`../../observability/README.md`](../../observability/README.md) | How do I read the telemetry logs? | Before quoting any measurement |

## Reference — open on demand

| Doc | Contents |
|---|---|
| [`sandbox/README.md`](./sandbox/README.md) | Clean-slate ingestion harness spec (gate ladder, corpus, reports) |
| [`findings/bl331-root-cause.md`](./findings/bl331-root-cause.md) | The 18x slowdown: launchd QoS + wall-clock timers + head-of-line blocking |
| [`findings/cluster-calibration.md`](./findings/cluster-calibration.md) | τ threshold measurements; single-linkage scaling |
| [`../../research/observability-substrate.md`](../../research/observability-substrate.md) | BL-351 tracing/metrics tool selection (OTel facade + JSONL sink) |
| [`../../spec/service-lifecycle.md`](../../spec/service-lifecycle.md) | Service/supervisor invariants — read before touching lifecycle code |
| [`../../ideas/theme-1-verification-harness.md`](../../ideas/theme-1-verification-harness.md) | Superseded by `sandbox/README.md` + `PLAN.md`. Historical. |
| [`../../ideas/themes-2-4-architecture.md`](../../ideas/themes-2-4-architecture.md) | Resource governance / lifecycle / self-verification designs. Partly superseded. |

---

## Rules for agents working here

1. **Update [`STATE.md`](./STATE.md) when a state changes.** It is the only file that must stay
   current. If you finish a state and do not move the `→` marker, the next agent redoes your work.
2. **File every defect in the root `BACKLOG.md`**, even one you fix in a minute. Allocate the id
   programmatically as `max(existing)+1` — reading the max by eye caused three collisions in one
   afternoon (BL-359).
3. **No claim without a measurement.** Cite the file:line or the command output. `grep` hits are
   not reading.
4. **Never mark RESOLVED without a red→green you personally watched fail and then pass** (BL-225).
   Four items shipped as RESOLVED while still broken; that rule exists because of them.
5. **Run the guards before committing:**
   ```
   node tools/check-backlog-markers.mjs
   node tools/check-no-nul-bytes.mjs
   git diff --cached --name-only          # must be EMPTY before you stage
   ```
6. **Do not write to `~/.memory/*`.** It is the live store. Work on copies — and copy the `-wal`
   alongside the `.db`, or the copy is stale (BL-330).

---

## The traps that have each cost hours

Recorded here because none are inferable from the code, and each was rediscovered at least once.

- **`grep` is a shell function** and returns *nothing*, silently, on a file containing a raw NUL
  byte. Use `/usr/bin/grep` whenever you are proving something is **absent**. (BL-371, guarded.)
- **Restarting the service does not deploy new code.** `launchctl kickstart -k` restarts the proxy;
  the backend survives as an orphan and keeps serving the old bundle while every check reads green.
  `kill -TERM <backend-pid>` is required, and the artifact hash in `memory_ping` is the only proof.
  (BL-372 — see `STATE.md` for the full sequence.)
- **A diagnostic `nx build` is destructive.** Targets `rm -rf dist/` *before* knowing the rebuild
  succeeds, and `--dry-run` is silently ignored. Snapshot `dist/` first. (BL-235.)
- **Classify processes by spawn method, not by store path.** launchd-spawned vs terminal-spawned is
  the axis that matters; the store is not the variable. (BL-331.)
- **`duration_ms` is wall-clock** and accrues during system sleep, so every p90/p99/max from the
  telemetry is inflated by an unknown amount. Medians are fine. (BL-369.)
- **⚠️ `soxe service enable` rebuilds the unit's env from YOUR SHELL** and silently drops any
  allowlisted key it does not find there — while printing success. It dropped **both live emergency
  brakes** (`SOX_DISABLE_EMBED_HEAL`, `SOX_DISABLE_PERIODIC_ENRICH`) on 2026-07-31, caught only by
  diffing the regenerated plist against a snapshot. **Export the brakes you intend to keep, and diff
  the plist afterwards.** (BL-375.) This is the highest-consequence trap on the list right now:
  losing the brakes re-enables embed heal and periodic enrich against a 3,246-item backlog and
  reproduces the BL-346 outage.
- **Do not "improve" the launchd `ProcessType` to `Adaptive`.** It looks like the safe middle ground
  and is a silent no-op: launchd.plist(5) promotes an Adaptive job out of `Background` based on
  activity over **XPC connections**, and sox services speak UDS/TCP and never open one. The correct
  value for a service is `Standard`; `Background` is correct only for periodic tick units. (BL-331.)
