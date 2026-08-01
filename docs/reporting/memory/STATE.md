# Memory Restoration — Resumable State

> Single source of truth for **where we are**. Update the `→` marker and the status column
> whenever a state changes. Anyone (or any agent) picking this up cold should read only this file
> plus the linked ones.
>
> **Entry point:** [`README.md`](./README.md) — read that first if you are new here.
>
> Companion docs: [`PLAN.md`](./PLAN.md) (build order) · [`sandbox/README.md`](./sandbox/README.md) (sandbox spec)
> · [`../../observability/README.md`](../../observability/README.md) (how to read the logs) · `BACKLOG.md` (all items)

**Last updated:** 2026-07-31 18:00 local · **Branch:** `wip/turso-live-metrics`

---

## Current position

```
→ S5  Re-enable SOX_DISABLE_EMBED_HEAL (BL-339)   ← unblocked; S4 shipped
```

**S4 is done.** `ProcessType` is no longer hardcoded — it is resolved by unit kind
(`resolveProcessType()`), with a `processType` spec field a manifest can declare as
`lifecycle.process_type`. Tick units keep `Background`; everything else gets `Standard`.
Deployed and **verified by PID**: proxy/backend/fastembed-host are now `91239 / 91785 / 91786`,
all at **pri 20** (was 4). Live embed p50 **6422 ms → 333 ms**; length-matched in the dominant
300–600-char band, **6412 ms → 339 ms = 18.9x**, against a predicted ~18x.

> ⚠️ **`Adaptive` would have silently re-introduced the defect.** launchd.plist(5) promotes an
> Adaptive job out of Background based on activity over **XPC connections**; sox services speak
> UDS and TCP and never open one, so it would have stayed in the Background class. `Standard` is
> documented as "equivalent to no ProcessType being set" — the neutral class. Do not "improve"
> this to Adaptive later.

**BL-331 stays open** on its other two defects (BL-369 wall-clock durations, BL-322 head-of-line
blocking) and on the throughput benchmark, which must run **under the service's actual scheduling
policy** — one run at terminal priority would have passed throughout the entire incident.

---

## ⚠️ The plan does not cover most of the backlog (measured 2026-08-01)

Of **85 open items, 53 (62%) are named in neither `PLAN.md` nor this file.** They are real,
cited defects with nowhere to be scheduled. The plan was written against the state of the world on
2026-07-31 and has not absorbed anything found since — including all thirteen items filed on
08-01 (BL-387 through BL-400).

`PLAN.md` also still lists **11 BL ids that are no longer open**: BL-320, BL-323, BL-324, BL-325,
BL-340, BL-343, BL-344, BL-347, BL-352, BL-377, BL-381. Two entire plan sections — **P0.6**
(test-infrastructure integrity) and **P0.7** (adapter self-heal) — are complete, and P2.1's BL-347
is done. A reader following the plan today would work on finished items and miss 62% of the real
queue.

**Do not treat `PLAN.md` as the work queue until it is reconciled.** `BACKLOG.md` is authoritative
for what is open; the plan is authoritative only for *sequencing* the subset it names.

---

## Deploy 2026-08-01 #2 — the first artifact of the day with establishable provenance

`90c7bb000580` → **`5e8e1fcc8625`**, pid 3040 → **18521**, via `sox service restart` (BL-372's new
verb, first real use). Built from a **clean tree at commit `4f963d2`**, and the running artifact now
matches both the on-disk bundle and `registry/index.json`.

That equality is the point. The previous running artifact `90c7bb000580` existed in **no file and no
commit** — it was an intermediate bundle the proxy respawned onto when a build deleted the file the
backend was executing (BL-393). Production had been running unreproducible code for roughly two hours.

The new verb behaved exactly as specified, including the step that used to live in prose:
```
before: main=32395  matching-pids=[3040]
kickstart: exit 0
reaper: SIGTERM → pid 3040 (grace 5000ms)
deployed — pid(s) rotated ([3040] -> [18521])     exit 0
```

**Correction to BL-393's scope, measured here:** the `nx build memory-server` in *this* deploy did
**not** bounce the backend — pid 3040 survived it, continuing to execute the old unlinked inode. So
"any build silently redeploys" is too strong; the build alone is necessary but not sufficient, and
BL-393's trigger needs narrowing to whatever additionally killed the backend at 13:25:56.

**Behaviour verified post-deploy, not just liveness:** a real write ran Phase A 88 ms → embed 332 ms
→ apply 27 ms with zero embed failures; `memory_search_entities` returned `search_mode: "fts"`
(BL-384 live); `memory_near_duplicates({threshold: 0.5})` returned real cosine values where the same
call returned `{"pairs":[],"total":0}` this morning (BL-386 live). Integrity `ok`, all five probes
validated, 9509 nodes, backlog 0.

Two defects were found **by** this verification and filed rather than glossed: **BL-398** (the
`weight`-as-cosine read fabricates `1.0` for manually-merged pairs, which then outrank measured ones)
and **BL-399** (a live, swallowed `no such column: meta` on the graph tables).

---

## Deploy 2026-08-01 — `6a0c13cda152` → `6d1b2abc1c12`, verified by artifact and pid

Six fixes shipped in one deploy: BL-373, BL-374, BL-365, BL-324, BL-381, BL-382 (+ `sox`/BL-344).

**`[inv:deploy-verified]` earned its place — the documented failure reproduced live.** After
`launchctl kickstart -k`, `pgrep` showed the proxy had rotated (67303 → 32395) while **backend 69947
survived, still executing the previous bundle**. Only `kill -TERM 69947` actually deployed. Had the
run stopped at kickstart, every check an operator would plausibly run would have been green and no
code would have changed — for the third time.

| check | before | after |
|---|---|---|
| artifact | `6a0c13cda152` | **`6d1b2abc1c12`** (matches the on-disk `dist/index.js` hash) |
| proxy / backend / fastembed pids | 67303 / 69947 / 69948 | **32395 / 32640 / 32641** |
| store fingerprint | `e352aaa3…` | `e352aaa3…` (unchanged — same store, no data movement) |
| embed backlog | 0 | 0 |
| integrity | ok | ok, all 5 probes `validated: true` |

**Behaviour verified, not just liveness.** A fresh `memory_write` reached a vector in **355 ms**
end-to-end — Phase A 80 ms → embed 330 ms → apply 24 ms — with `embeds_failed: 0`.

**BL-381 verified by A/B on the live telemetry**, which is the only evidence that distinguishes
"fixed" from "never ran":

| build | `no such column: k` | `topKQuery` undefined |
|---|---|---|
| 2026-07-31 (old, 3,249 embeds) | **113** | 8 |
| 2026-08-01 pre-deploy | 0 | **13** |
| 2026-08-01 post-deploy | **0** | **0** |

Absence of an error line alone would have proven nothing — the old build logged these too, so the
comparison against the prior day is what carries the claim. A read-only probe against a **copy** of
the live store (`.db` + `-wal` together, BL-330) then confirmed the KNN returns **21 real neighbours**
ranked by `vector_distance_cos`, top match 0.9453 — below the 0.95 `SAME_AS` threshold, so the
absence of an edge on the probe pair is the threshold working, not a defect. That probe is also what
surfaced **BL-386**.

---

## States

| # | State | Status | Evidence / blocker |
|---|---|---|---|
| S0 | Diagnose Turso migration failures | **done** | 90 backlog items filed, all cited |
| S1 | Recover lost `db.ts` Turso wiring | **done** | `2ad196f` — 208 lines recovered from sourcemaps |
| S2 | Adapter self-verify + repair (BL-352) | **done** | `fa786a2` — probes + repair, 279/279; BL-352 closed 2026-08-01 (integrity.ts implements verify **and** `repairStoreIntegrity`) |
| S2b | **Unlinked-WAL data loss (BL-330)** | **OPEN** | ⚠️ S2 previously bundled BL-330 with BL-352 and reported both done. They are different defects: BL-352 is "adapters must verify their artifacts"; BL-330 is "a graceful `close()` silently discarded 90 of 140 committed rows." The second is unfixed and is PLAN.md **P0.1** |
| S3 | Deploy it; live store self-heals (BL-347) | **done** | verified below |
| S4 | Fix `ProcessType: Background` (BL-331) | **done** | pri 4 → 20 by PID; p50 6422 ms → 333 ms (18.9x length-matched) |
| S5 | Re-enable `SOX_DISABLE_EMBED_HEAL` (BL-339) | **done** | brake removed; 3,246 heals applied, 0 failed |
| S6 | Re-enable `SOX_DISABLE_PERIODIC_ENRICH` (BL-346) | **done** | brake removed; neither var is present in the live plist |
| S7 | Drain embed backlog to full vector coverage | **done** | backlog 3,246 → **0**, 3,249 embeds, **0 failed**; see below |
| **S8** | **Clustering actually runs (BL-349/BL-326)** | **→ unblocked** | S6, S7 done. τ still unresolved (BL-356) |
| S9 | Tracing substrate (BL-351) | pending | **unblocked** — BL-344 shipped (one `env-policy.ts`, was 5 copies); design in `docs/research/observability-substrate.md` |
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

**Running:** artifact `5e8e1fcc8625`, backend pid 18521 (re-check; it changes on restart).

---

## Live service — current reality

| | |
|---|---|
| Keyword search (FTS) | ✅ working |
| Vector recall | ✅ backlog **0**; 4,934 vectors / 9,496 nodes — the remainder are communities and other non-episode kinds, not a shortfall |
| Near-duplicate detection | ✅ KNN live on Turso via `vector_distance_cos` (BL-381 verified); ⚠️ reported `cosine_sim` is always 0 and the `threshold` param returns an empty set (BL-386) |
| Embed drain | ✅ write-triggered wake, no 5-min wait (BL-382); fresh write → vector in **355 ms** |
| Integrity surface | ✅ in `memory_ping`, deployed; all 5 probes validated, `overall: ok` |
| Telemetry | ✅ crash-durable (BL-365), writing to `~/.adhd/sox-ecosystem/memory/logs/` |
| Embed heal | ✅ ON — brake removed; 3,246 heals, 0 failed |
| Periodic enrich / clustering | ✅ ON — brake removed |
| Scheduling | ✅ priority 20 (`ProcessType: Standard`) — 18.9x faster embeds (BL-331) |
| Backup | ❌ **impossible on a Turso store** — `VACUUM INTO` fails, no destination file produced (BL-385, CRITICAL) |
| Entity search | ⚠️ silently a substring scan since the migration (BL-384) |

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

## Deploy procedure

**Canonical: [`docs/spec/service-lifecycle.md` §9.4a](../../spec/service-lifecycle.md) —
`[inv:deploy-verified]`.** Do not restate it here or anywhere else; that is the one copy.

Two things it exists to stop, both of which fired on 2026-07-31:
- `launchctl kickstart -k` restarts the **proxy only**; the backend survives as a `PPID 1` orphan
  still serving the old bundle while every check reads green. `kill -TERM <backend-pid>` is
  required, and the **artifact hash** is the only proof (BL-372).
- `soxe service enable` rebuilds the unit env **from your shell** and silently drops what it does
  not find — it dropped both live emergency brakes while printing success. Export what you intend
  to keep, and diff the plist (BL-375).

## ⚠ BL-367 — cross-backend recall parity: leaning CORRECTNESS problem, not proven

**The biggest open unknown in the project.** `recall-parity.test.ts` compared `RecallResult.uid`
across two independent stores, but `memoryWrite` mints a fresh `ulid()` per episode — overlap was
**0 by construction**. The test could never have passed, so **cross-backend recall parity has never
actually been tested.** Corrected to compare on content, the first honest measurement is
**0.52 against a 0.80 bar**.

**Harness artifact is ruled out** (2026-07-31): corpus identical (same `EPISODES` array to both
stores), queries identical, embeddings deterministic and identical (`DeterministicTestProvider` +
`SOX_SYNC_EMBED=1`), both backends return results, and the test skips any query where either side
is empty with `queriesRan > 0` passing. So it is not differing corpora, not embedding
non-determinism, not one-side-empty.

**What remains is genuine retrieval/ranking divergence — but it is NOT proven.** Recall fuses
vector + BM25 + temporal and **the arms were never isolated.** Leading suspect is the FTS/BM25 arm
(the Turso FTS dialect differs; cf. BL-347). **That isolation is the experiment to run.**

**The 0.80 bar was never validated** — it was written alongside the uid comparison, so its author
never observed the test pass. It is aspirational, not empirical. **This must not be reframed as
threshold tuning:** 52% agreement on the top 5 for identical input is poor on its face regardless
of where the bar sits. Do not lower the bar to fit the measurement.

## ⚠ Do not gate on a memory-core failure COUNT

Measured 2026-07-31: three runs of the **same** configuration returned **109, 95, 91** failures.
The suites are flaky under concurrent DB access (`statement has been finalized`, `cannot start a
transaction within a transaction`), so a count difference between two runs is noise, not signal.

**Diff failing test NAMES instead** (`comm -13` on sorted name lists). That is what proved BL-365's
red→green at whole-suite level: zero tests failed only *with* the change, four failed only
*without* it — exactly the new durability tests.

Consequence for the record: the progression reported through the day — **265 → 178 → 162 → 138** —
contains noise. The direction is real and the **typecheck-error trend (941 → 112) is the steadier
signal**, but no one should quote a count as progress, including the team lead, who did.

If this is a property of BL-325's in-flight state it resolves itself; if it is genuine concurrency
flakiness in the suites it is BL-202's territory and needs an owner.

## Traps that cost real time (don't rediscover these)

- **`grep` is a shell function** and silently returns nothing on a file with a raw NUL byte. Use
  `/usr/bin/grep` when proving something is *absent*. (BL-371, now guarded.)
- **A stale `-tshm`** makes the store unopenable with an error naming the *wrong* file
  (`short read on WAL frame` while the WAL is 0 bytes). Move it aside. The adapter now does this
  itself at open — renaming, never deleting, and only when the WAL is empty. (BL-373, fixed in
  `8fe0571`, pending deploy.)
- **A sentinel token must be a WHOLE word.** The FTS probe capped tokens at 20 letters and
  truncated longer ones, so any row containing e.g. `sharedFastembedProcess` reported as unindexed
  on a healthy index — **7.3% of live rows**, ~1-in-5 spurious `DAMAGED` per open. Never truncate a
  term you are about to search for. (BL-374, fixed in `8fe0571`, pending deploy.)
- **Classify processes by spawn method, not by store path.** launchd-spawned vs terminal-spawned
  is the axis; the store is not the variable. (BL-331.)
- **`duration_ms` is wall-clock** and accrues during system sleep — every p90/p99/max from the
  telemetry is inflated. (BL-369.)
- **~half the "test" embed population is a hash provider**, not inference. Honest reference is
  ~423 ms. (BL-331.)
- **BL ids collide** — allocate with `max(existing)+1` programmatically, never by eye. Three
  collisions in one afternoon. (BL-359.)
- **`soxe service enable` rebuilds unit env from YOUR SHELL** and silently drops anything it does
  not find there. It dropped both emergency brakes while reporting success. Always export the
  brakes when regenerating, and **diff the plist against a snapshot afterwards**. (BL-375.)
- **`ProcessType` must not be "improved" to `Adaptive`** — Adaptive promotes out of Background on
  XPC activity, which sox services never generate. It would look like a fix and change nothing.
  (BL-331.)

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

**When the index is NOT empty** (another agent is mid-work), do not wait and do not reset —
commit by pathspec, which takes only your files and leaves their index untouched:

```
git commit -F <(...) -- path/one path/two     # partial commit; staged files stay staged
```

---

## Agents

All four hit session limits (reset 16:40). Work is committed; nothing is in flight.

| Agent | Left off at |
|---|---|
| `p0-test-infra` | BL-325 at 232 failures; owes BL-323/342/343 verdicts before wave 2 |
| `p0-adapter-integrity` | BL-352 shipped; BL-352 items 2–5 open |
| `p1-tracing-research` | BL-351 research complete; implementation blocked on BL-344 |
| `p0-cluster-calibration` | BL-331 root-caused; two leaked fastembed orphans it could not kill |
