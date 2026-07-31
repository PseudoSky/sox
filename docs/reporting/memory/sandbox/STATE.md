# Memory Restoration — Resumable State

> Single source of truth for **where we are**. Update the `→` marker and the status column
> whenever a state changes. Anyone (or any agent) picking this up cold should read only this file
> plus the linked ones.
>
> Companion docs: [`PLAN.md`](./PLAN.md) (build order) · [`README.md`](./README.md) (sandbox spec)
> · `../../../observability/README.md` (how to read the logs) · `BACKLOG.md` (all items)

**Last updated:** 2026-07-31 18:00 local · **Branch:** `wip/turso-live-metrics`

---

## Current position

```
→ S4  Fix ProcessType:Background   ← BLOCKED, needs owner approval
```

**The one decision outstanding:** `ProcessType: Background` is hardcoded on every sox launchd
unit (`os-unit.ts:458-459`), forcing the live service to scheduling priority 4 instead of 31 —
efficiency cores only, measured **18x** slower (~470 ms → ~8400 ms). It gates re-enabling both
emergency brakes. Changing it affects **every** sox service, which is why it has not been done
unilaterally.

---

## States

| # | State | Status | Evidence / blocker |
|---|---|---|---|
| S0 | Diagnose Turso migration failures | **done** | 90 backlog items filed, all cited |
| S1 | Recover lost `db.ts` Turso wiring | **done** | `2ad196f` — 208 lines recovered from sourcemaps |
| S2 | Adapter self-verify + repair (BL-352/330) | **done** | `fa786a2` — probes + repair, 279/279 |
| S3 | Deploy it; live store self-heals (BL-347) | **done** | verified below |
| **S4** | **Fix `ProcessType: Background` (BL-331)** | **→ blocked** | **owner approval — see above** |
| S5 | Re-enable `SOX_DISABLE_EMBED_HEAL` (BL-339) | pending | needs S4 |
| S6 | Re-enable `SOX_DISABLE_PERIODIC_ENRICH` (BL-346) | pending | needs S4, S5 |
| S7 | Drain embed backlog to full vector coverage | pending | needs S5; backlog 3,246, coverage ~36% |
| S8 | Clustering actually runs (BL-349/BL-326) | pending | needs S6, S7; τ unresolved (BL-356) |
| S9 | Tracing substrate (BL-351) | pending | **blocked on BL-344** (6 env allowlists) |
| S10 | Sandbox harness (P0–P4 in `PLAN.md`) | pending | needs S9 for real instrumentation |

---

## S3 — verified restored (2026-07-31)

Ground truth, measured on the live store after the adapter repaired it on first open:

| check | before | after |
|---|---|---|
| `fts_match('memory')` | 0 | **1156** (LIKE 1081) |
| `fts_match('turso')` | 0 | **138** (LIKE 139) |
| `fts_match('backlog')` | 0 | **84** (LIKE 83) |
| `_adapter_meta` duplicate keys | 3 keys ×2 | **none** (5 rows) |

`memory_recall` returns `"provenance":["fts"]` with non-zero BM25. No manual DDL was used — the
adapter repaired itself, which was the owner's explicit requirement.

**Running:** artifact `6a0c13cda152`, backend pid 48826 (re-check; it changes on restart).

---

## Live service — current reality

| | |
|---|---|
| Keyword search (FTS) | ✅ working |
| Vector recall | ⚠️ coverage ~36%, backlog 3,246 |
| `memory_stats` | ❌ throws — `malformed JSON` (BL-342) |
| Integrity surface | ✅ in `memory_ping`; ⚠️ false-alarms DAMAGED (BL-374) |
| Embed heal | 🛑 OFF — `SOX_DISABLE_EMBED_HEAL=1` (BL-339) |
| Periodic enrich / clustering | 🛑 OFF — `SOX_DISABLE_PERIODIC_ENRICH=1` (BL-346) |
| Scheduling | 🛑 priority 4 (background), 18x throttle (BL-331) |

---

## Rollback points

| Path | Contents |
|---|---|
| `~/.adhd/sox-ecosystem/memory/prerebuild-20260731-150126/` | db + WAL, **working `dist/`**, store-adapter + memory-core dists, plist |
| `~/.adhd/sox-ecosystem/memory/prerestart-20260731-174637/` | db + WAL, stale `-shm` / `-tshm` / empty `-wal` |
| `~/.memory/memory.db.20260731-132556.pre-fts-rebuild` | pre-repair store + WAL |
| `~/.memory/memory.db.20260730-123926.golive-verified` | last known-good go-live snapshot |

The `dist/` copy matters: `nx build` deletes the artifact **before** knowing the rebuild
succeeds (BL-235), and that has already taken this server down once.

---

## Deploy procedure (learned the hard way — BL-372)

`launchctl kickstart -k` restarts the **proxy only**. The backend survives as an orphan
(`PPID 1`) and keeps serving the old bundle, while every check reads green. The full sequence:

```
1. snapshot db + WAL + dist/           # BL-235, BL-330
2. npx nx build memory-server
3. npx nx run registry:sync-index      # else smoke fails on CHECKSUM MISMATCH
4. launchctl kickstart -k gui/$(id -u)/com.sox.user.memory-server
5. kill -TERM <backend-pid>            # ← REQUIRED. kickstart alone does not deploy.
6. verify memory_ping reports the NEW artifact hash   # ← the only real proof
7. verify behaviour (fts_match, recall provenance)
```

**Step 6 is not optional.** Steps 2–4 all succeeded on the first attempt while the old code kept
running.

---

## Traps that cost real time (don't rediscover these)

- **`grep` is a shell function** and silently returns nothing on a file with a raw NUL byte. Use
  `/usr/bin/grep` when proving something is *absent*. (BL-371, now guarded.)
- **A stale `-tshm`** makes the store unopenable with an error naming the *wrong* file
  (`short read on WAL frame` while the WAL is 0 bytes). Move it aside. (BL-373.)
- **Classify processes by spawn method, not by store path.** launchd-spawned vs terminal-spawned
  is the axis; the store is not the variable. (BL-331.)
- **`duration_ms` is wall-clock** and accrues during system sleep — every p90/p99/max from the
  telemetry is inflated. (BL-369.)
- **~half the "test" embed population is a hash provider**, not inference. Honest reference is
  ~423 ms. (BL-331.)
- **BL ids collide** — allocate with `max(existing)+1` programmatically, never by eye. Three
  collisions in one afternoon. (BL-359.)

---

## Guards to run before any commit

```
node tools/check-backlog-markers.mjs     # OK — 93 items, 89 open
node tools/check-no-nul-bytes.mjs        # OK — 984 source files
grep -o '^### BL-[0-9]*' BACKLOG.md | sort -V | uniq -d    # must be empty
git diff --cached --name-only            # must be EMPTY before you stage
```

The last one matters in a shared checkout: a pre-populated index sweeps another agent's
in-flight work into your commit. It has happened.

---

## Agents

All four hit session limits (reset 16:40). Work is committed; nothing is in flight.

| Agent | Left off at |
|---|---|
| `p0-test-infra` | BL-325 at 232 failures; owes BL-323/342/343 verdicts before wave 2 |
| `p0-adapter-integrity` | BL-352 shipped; BL-352 items 2–5 open |
| `p1-tracing-research` | BL-351 research complete; implementation blocked on BL-344 |
| `p0-cluster-calibration` | BL-331 root-caused; two leaked fastembed orphans it could not kill |
