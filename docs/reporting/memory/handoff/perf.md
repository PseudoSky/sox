# Handoff — performance work (BL-331, BL-369, BL-370, BL-322, BL-375)

> Written 2026-07-31 at context rotation. Assumes you know nothing about today.
> **Entry point for all memory work is [`../README.md`](../README.md)** — read that first; it
> carries the traps list. This file is the performance thread specifically.
>
> **The methodology is the expensive part.** Every wrong turn below cost real time and at least
> two of them produced a *confident wrong answer* that survived several sessions. The numbers are
> replaceable; the ways of getting them are not.

---

## 0. The one rule this whole thread taught

**Measure the thing on the machine you run on. Do not reason from the code, from the docs, or
from a previous number.** Three separate confident conclusions were wrong today:

| Claim | Believed because | What measurement showed |
|---|---|---|
| "Live embeds are slow because of ANE contention" | a warning said so | The warning named **our own leaked orphan** (BL-370). Contention still unproven. |
| "`duration_ms` is wall-clock; use `hrtime` to fix it" | reasonable inference | `hrtime` is the **same clock** and also includes sleep. The fix was a **no-op**. |
| "Live-store vs test-process is the axis" | the pids split that way | The axis is **launchd- vs terminal-spawned**. Several "live" pids were fast. |

Each of these had been repeated into backlog items and docs before being measured.

---

## 1. BL-331 — three defects, not one slowdown · **root-caused; defect 1 fixed**

The symptom was "the embed pipeline is ~18x too slow in production". An average had blended
**three unrelated defects**. Full report: [`../findings/bl331-root-cause.md`](../findings/bl331-root-cause.md).

### 1.1 The median — macOS background QoS · **FIXED, verified 18.9x**

`libs/host-runtime/src/os-unit.ts` emitted `ProcessType: Background` **unconditionally on every
sox launchd unit**. launchd.plist(5): Background jobs get the heaviest resource throttle; on Apple
Silicon that means efficiency cores plus I/O throttling. The live backend **and its fastembed
child** therefore ran at scheduling **priority 4**; a terminal-launched process runs at **31**.

Now resolved by unit kind (`resolveProcessType()`), via a `processType` spec field a manifest
declares as `lifecycle.process_type`: **tick units → `Background`**, **everything else →
`Standard`**.

> ### ⚠ The `Adaptive` trap — a future agent WILL try to "improve" this
>
> `Adaptive` looks like the correct middle ground and was the originally proposed default. It is a
> **silent no-op here.** launchd.plist(5): *"Adaptive jobs move between the Background and
> Interactive classifications based on activity over **XPC connections**."* sox services speak UDS
> and TCP and **never open an XPC connection**, so there is no promotion signal — an Adaptive unit
> sits in the Background class while the plist reads as if it were fixed.
>
> `Standard` is documented as *"equivalent to no ProcessType being set"* — the neutral class, and
> the right default. `Interactive` is reserved by the man page for jobs that cannot be made
> Adaptive and lifts resource limits entirely; a manifest can opt in, but it is not the default.

**Verified at scale on a real workload** (team-lead, both brakes off, backfill draining):

| | before | after |
|---|---|---|
| `embed_duration_ms` p50 | 6898 ms | **451 ms** |
| backfill | — | 1685 → 2105 vectors (17.8% → 22.2%) on the first tick |
| sustained rate | — | **~1.4/s over the full cycle** |
| failures | — | 0 of 50 |

> **The drain is bursty, not continuous — do not project completion from the in-tick rate.** The
> first tick drained hard and then **paused on the per-tick heal time budget**
> (`SOX_EMBED_HEAL_TIME_BUDGET_MS`). The in-burst rate is materially higher than the ~1.4/s
> sustained figure, and quoting the burst would badly under-estimate time-to-full-coverage.
> This is the same shape as BL-331's original framing error: an instantaneous number generalised
> into a steady-state claim.

This **supersedes the thin n=11 sample** the original verification rested on (which was flagged as
thin at the time). The earlier length-matched figure was **18.9x** in the dominant 300–600-char
band (n=328 before, 6412 ms → 339 ms); the production drain confirms it.

### 1.2 The multi-hour "embeds" — a clock artifact, not hangs · **FIXED (BL-369)**

Six embeds of 3154–10953 s were **87–99.7% system sleep**. The famous "3-hour embed" is **503 s of
awake time** on a laptop that slept 2 h 54 m. Across the whole >30 s tail: **88.7% of wall time was
sleep**, versus **1.1%** for the ≤30 s population — so it distorts exactly the tail, which is where
p90/p99 are read. See §3.

### 1.3 The real 30–160 s tail — head-of-line blocking · **OPEN (BL-322)**

See §4.

---

## 2. Methodology that must survive

### 2.1 Interleave A/B arms — never run A-then-B

The machine is shared with several agents; load swings by hundreds of percent within minutes. A
sequential A-then-B comparison measures the load, not the change. **Alternate arms round-by-round**
and compare medians across rounds. Absolute numbers stay **contended and labelled not-a-baseline**;
the *ratio* is the result.

`taskpolicy -b <cmd>` reproduces launchd's `ProcessType: Background` — **verified to produce the
same `pri 4`** as the live service, which is what makes it a faithful stand-in.

### 2.2 Verify by PID, never by plist or by exit code

A deploy that "succeeded" three times today did not deploy. This is now
**`[inv:deploy-verified]`** — see [`docs/spec/service-lifecycle.md` §9.4a](../../../spec/service-lifecycle.md)
rather than a restatement here. The short version: `launchctl kickstart -k` restarts the **proxy**;
the backend survives as a `PPID 1` orphan serving the old code while every check reads green.
`kill -TERM <backend-pid>` is required.

Check `ps -o pid,ppid,pri` on **the backend and its fastembed child**. The child inherits the
scheduling class, and it is where inference actually runs.

### 2.3 Classify processes by SPAWN METHOD, not by store path

The "live-store vs test-process" split that framed this investigation for days is the wrong axis.
**Ten terminal-launched pids touching the same live store ran at p50 0.3–0.9 s.** The axis is
**launchd-spawned vs terminal-spawned**.

**Corollary that matters for the still-owed BL-331 benchmark: a perf benchmark run from a terminal
would have passed throughout this entire incident and proved nothing.** Any acceptance test for a
service must run under the service's actual scheduling policy.

### 2.4 The baseline correction — half the "test" population is not inference

**899 of 1755 "test" embeds completed in <10 ms**, with *nothing* between 10 and 100 ms. That
bimodal low population is a deterministic/hash provider, not an ONNX forward pass, and must be
excluded from any baseline. **The honest real-inference reference is ~423 ms (n=856)** — which
independently matches the clean-room figure (~2.1–2.8/s) and the BL-328 measurement (2.25–2.60/s).

### 2.5 Prove your change is clean; never assert it

`memory-core` showed **162 failing tests and a broken build** while I was working in it. The
tempting move is to call that pre-existing and move on. **Measure it instead** — it takes two
minutes and it is the difference between a claim and a fact:

1. Back up your edits, remove them (`git restore --source=HEAD -- <file>`, move new files aside).
2. Run the suite. Record the numbers. → **162 failed / 299 passed**
3. Restore your edits. Run again. → **162 failed / 312 passed**
4. Identical failures, **+13 passing** ⇒ your change is neutral and adds only green.

Same for the build break: `export.ts` had **62 insertions / 65 deletions uncommitted in the
working tree** — another agent's in-flight BL-325 async conversion, and not even at HEAD. That is
an attribution *proven by `git diff --stat HEAD`*, not a guess.

Two corollaries worth keeping:

- **A failed `nx build` does not necessarily destroy the artifact.** `atomic-tsc` stages to
  `dist.staging-*` and only commits on success, so BL-235's "diagnostic build is destructive"
  warning does not apply to those targets. Verify rather than assuming either way.
- The repo constraint *"never claim a bug is pre-existing"* is not asking you to fix everything
  you find — it is asking you not to **assert** provenance you have not measured.

### 2.6 Probe scripts (all read-only; they refuse any path under `~/.memory`)

`~/.adhd/sox-ecosystem/memory/log-analysis/`

| script | answers |
|---|---|
| `bl331-textlen.py` | is it text length? (no — flat, with a hard floor) |
| `bl331-shape.py` | distribution shape by pid / age / length |
| `bl331-within-pid.py` | the floor, within one process |
| `bl331-sleep-overlap.py` | overlap with `pmset -g log` sleep intervals |
| `bl331-inflight.py` | duration vs in-flight concurrency (BL-322) |
| `bl331-qos-round.mjs` | one interleaved A/B round |
| `bl331-after.py` | before/after, length-matched |
| `bl369-clock-truth.py` | **does the clock include sleep?** (§3) |

> **`pmset` parse trap.** Do **not** pair a `Sleep` line with the next line whose first token is
> `Wake` — pmset emits a **`Wake Requests`** line ~2 s after every `Sleep`, truncating every
> interval to seconds. It reported 0.1 h asleep instead of 11.31 h and briefly produced a **false
> refutation** of the whole sleep finding. pmset states the duration on the `Sleep` line itself
> (`... 598 secs`) — use that.

---

## 3. BL-369 — **its stated remedy was wrong.** Hand this over carefully.

**Status: RESOLVED and in CHANGELOG.** The item (mine) said *"`duration_ms` is wall-clock, fix by
using `process.hrtime.bigint()`"*. The symptom was right. **The fix was a literal no-op** and would
have shipped, closed the item, and moved nothing — the BL-88/BL-95 failure mode exactly.

### The three measurements — cite these, not the libuv issue

1. **No emitter ever used `Date.now()`.** They all already used `performance.now()`.
2. **`performance.now()` and `process.hrtime.bigint()` are the SAME clock** — measured **0.002 ms
   apart** over a 250 ms interval (independently reproduced by `p1-tracing-research` at 0.016 ms).
   Both are `uv_hrtime()`.
3. **That clock INCLUDES system sleep** on Node v24.11.1 / darwin-arm64. Decisive test against data
   already on disk: pair each `embed.start` with its `embed.finish` and compare the **true wall gap
   between the two `ts` fields** against the reported `duration_ms` —
   **n=28 long ops, median ratio 1.000**, including the 3-hour span that was 95% asleep
   (10953310 ms wall vs 10953175 ms reported). Control: **n=3532 short ops, ratio 1.000**.

> ### ⚠ The documentation contradicts this machine — cite the measurement
>
> libuv issue #2891 states macOS `uv_hrtime` uses `mach_absolute_time` / `CLOCK_UPTIME_RAW`, which
> **excludes** sleep. On Node 24 here it demonstrably does not. **Quote the n=28 pairing above, not
> the issue link** — otherwise the next reader "corrects" this back on the strength of the docs and
> reintroduces the no-op.

`Date.now()`, `performance.now()`, `hrtime.bigint()` and `process.uptime()` all include sleep.
**There is no drop-in sleep-excluding clock in JS on macOS.** That is why the fix is a ledger.

### What shipped — `libs/memory-core/src/suspension.ts`

One process-global **`.unref()`'d heartbeat**. A late tick means the process did not run; a
**`process.cpuUsage()` delta over the same gap discriminates the cause**:

```
~zero CPU consumed  ->  SYSTEM SUSPEND    (machine slept / SIGSTOP / VM pause)
 CPU consumed       ->  EVENT-LOOP BLOCK  (synchronous work starved the loop)
```

**The event-loop-block half is a first-class deliverable, not a debug aid** — it is BL-345's whole
subject and the measurement Theme 2 was blocked on. `p1-tracing-research` has removed their
separate lag sampler in favour of it: **one heartbeat, not two.**

**Annotate, never subtract** — and the reasoning is in the code comment, not just here: a
subtracted duration is neither wall time nor compute time and **can no longer be reconciled against
the record's own `ts`**. `duration_ms` stays raw; `suspended_ms` / `blocked_ms` are emitted
alongside. Same principle as BL-343's `malformed_rows` — the skipped thing must be counted, or a
loud failure has been traded for a quietly wrong number.

Wired at the **logging boundary** (`emit()`), not at the ~12 call sites, so every emitter present
and future is correct by construction — a call-site convention is exactly what left BL-344's
allowlist duplicated six times.

Cost, measured by `p1-tracing-research`: `cpuUsage()` 403 ns + delta 563 ns + `now()` 76 ns ≈
**104 ms of CPU per day**. Negligible; not literally zero, and "negligible" is the defensible claim.
An `.unref()`'d interval is invisible to `getActiveResourcesInfo()` and does not hold the loop
open, so BL-345's zero-handles property survives.

### Field contract — agreed with `p1-tracing-research`, do not fork it

| field | unit | semantics |
|---|---|---|
| `duration_ms` | ms | **Unchanged meaning.** Wall-clock, includes suspend. Never adjusted. |
| `suspended_ms` | ms | Overlap with system-suspend intervals. |
| `blocked_ms` | ms | Overlap with event-loop-block intervals. |

All three are `_ms`, so `duration_ms - suspended_ms - blocked_ms` is meaningful arithmetic.
`blocked_ms` is a **first-class sibling, not folded into `suspended_ms`** — different defects,
different owners.

> **SETTLED — both counters are ALWAYS present, `0` rather than omitted** (`af45f77`). I shipped
> omit-when-zero first; `p1-tracing-research` argued for always-emit and team-lead decided it.
> **They were right:** an absent field is indistinguishable from "not instrumented", which is the
> exact ambiguity behind BL-319 (`time_to_vector_ms` existing with zero samples), BL-347 (an FTS
> probe reading 0 whether the index was dead or healthy), BL-376 and BL-378. In every one of those,
> silence was read as health. A `0` is a **positive claim** that the ledger looked and found
> nothing. Absence now means one thing only: a **pre-boundary record**.
>
> Two related facts settled in the same commit:
>
> - **Clock domain.** The ledger stores `Date.now()` endpoints and `annotateSuspension` computes
>   its window from `Date.now()` — a same-domain subtraction. **Do not "improve" one side to
>   `performance.now()`**: the two are identical in *rate* (0.002 ms over 250 ms) but have different
>   *epochs*, so a mixed-domain overlap returns garbage **silently** rather than failing. The
>   warning is at the call site.
> - **Resolution floor.** `suspensionResolutionFloorMs()` (heartbeat + slack = **1750 ms**) is
>   readable at runtime. `suspended_ms: 0` means "no suspension longer than the floor", not "no
>   suspension" — quote the bound rather than implying infinite precision.

**Effective-date boundary is recorded** in `docs/observability/README.md` §5.1(b), with the
**corrected mechanism** (not just the date) — the section previously told readers the wrong reason.
Records before ~2026-07-31 18:40 local must still be reconstructed by hand against `pmset`;
**historical percentiles do not become correct retroactively.**

---

## 4. BL-322 — head-of-line blocking · **OPEN, next up. Lead with the anomaly.**

`sharedFastembedProcess` routes every request through **one** forked child, so a request's measured
duration includes everything queued ahead of it. Measured (sleep-corrected per BL-369):

| in-flight on the shared child | n | awake p50 |
|---|---|---|
| 1 | 619 | 6.0 s |
| 2 | 10 | 53.7 s |
| 5 | 2 | 61.6 s |
| 6 | 2 | 91.2 s |
| 7 | 3 | **149.8 s** |

This answers BL-322's own fix-sketch question 1 — *"does the singleton fastembed process cause
head-of-line blocking?"* — **yes, measurably.**

> ### The interesting part, and where to start
>
> **7 × 6 s = 42 s predicted by strict serialization. Observed p50 at in-flight 7 is 149.8 s —
> ~3.5x unattributed.** Serialization is demonstrated; the amplification is not. Untested
> candidates: per-request state thrash in the child when requests interleave, or a worse-than-linear
> interaction between queueing and the (then-active) QoS throttle.
>
> **Re-measure rather than carrying these numbers over.** They were all taken at **pri 4**. The
> per-unit base is now ~0.33–0.45 s instead of ~6 s, so the absolute figures will differ and the
> ~3.5x may or may not survive — which is itself the first thing worth knowing.

Minimum ask regardless of the fix: **report in-flight depth through `memory_ping`**, so this stops
being reconstructible only by hand from a log.

---

## 5. BL-370 — **fixed, but the narrative it corrupted matters more than the fix**

`fork()` with `'ipc'` creates a **separate** libuv handle for the channel; `ChildProcess.unref()`
does not release it. `ensureProcess()` called `unref()` twice with a comment promising the parent
could exit — it never could. **Every process that embedded even once stayed alive forever.**
Observed: two probe processes alive **40+ minutes** after their final output, each holding a
resident ONNX model. Fix: `c.channel?.unref()`.

> ### The part to carry forward
>
> The orphans this created produced the
> `[fastembed] WARNING … another fastembed host process (pid N) is ALREADY RUNNING … severe
> (25-50x) embed latency due to Neural Engine contention` message that was cited **across several
> sessions** as evidence of real cross-process ANE contention. At least one such warning named an
> orphan **this defect created**, idle at 0% CPU.
>
> **Cross-process ANE contention remains UNPROVEN.** The measured cause of the live slowdown was
> scheduling QoS. The narrative was partly confirming itself off our own litter — treat any
> contention claim resting on that warning as unsupported until re-measured.

Red→green harness lives in `sharedFastembedProcess-leak.spec.ts`, with **two harness traps
documented in the file** because each produced a wrong answer first:

1. The forked grandchild **inherits the parent's stdout**; with `spawnSync` pipes, spawnSync waits
   for pipe EOF as well as process exit, so **both arms look hung regardless of the fix**.
   `stdio: 'ignore'` is load-bearing.
2. Vitest's default **5 s per-test budget** kills the deliberately-hanging arm, and the failure
   reads like a product defect rather than a harness limit.

---

## 6. BL-375 — found while deploying; **raised to HIGH, still open**

`soxe service enable` rebuilds the launchd unit's `EnvironmentVariables` from **the invoking
shell's environment**. It does not read the previous unit, does not diff, does not warn.
Regenerating to change one unrelated key **silently dropped `SOX_DISABLE_EMBED_HEAL=1` and
`SOX_DISABLE_PERIODIC_ENRICH=1` — both live emergency brakes — while printing success.** Caught
only by diffing the regenerated plist against a snapshot.

**Its blast radius grew today.** BL-344 consolidated five allowlists into
`libs/host-runtime/src/env-policy.ts` and now forwards `SOX_*` by prefix — but **ported the
"forward from ambient env" semantics forward unchanged**, so *every* forwardable `SOX_*` tunable is
now droppable by that same path. `p1-tracing-research` flagged this explicitly rather than letting
consolidation imply coverage.

The sharpest form of the defect: the function's own comment says *"never hand-edit the generated
plist to inject env"* — so **the only sanctioned path is the one that loses data.** Any design that
leaves that true has not closed it.

**Fix direction — APPROVED by the owner, and queued ahead of any further S5/S6 work:** service
tunables become a property of the **installation** (scope config), with the ambient-env forward
demoted to an explicit **override**.

**Until then, anyone regenerating the unit must `export` the tunables they intend to keep and diff
the plist afterwards.** Snapshot: `~/.adhd/sox-ecosystem/memory/bl331-predeploy-20260731-180139/`.

---

## 7. State at handoff

- **Live service healthy**, backend + fastembed child at **pri 20**, both brakes **off** (team-lead,
  measuring the drain — see §1.1). Backfill draining in bursts, ~1.4/s sustained, 0 failures.
- **BL-331** open on defects 2/3 and the still-owed throughput benchmark (§2.3 — it must run under
  the service's real scheduling policy).
- **BL-369, BL-370** resolved, moved to CHANGELOG, removed from BACKLOG.
- **BL-322** open, next up. **BL-375** open, HIGH.
- Everything of mine is committed; nothing in flight.

### Shared-checkout notes

- Several agents edit `BACKLOG.md` / `CHANGELOG.md` concurrently. When the index is **not** empty,
  do **not** reset and do **not** wait — `git commit -F <msg> -- <paths>` does a **partial commit**
  of only those paths and leaves other staged entries untouched.
- **BL ids collide** — allocate `max(existing)+1` programmatically (`tools/allocate-bl-id.mjs`).
  Three collisions in one afternoon; one of mine had to be renumbered post-hoc. Delete the
  `RESERVED` placeholder it writes before committing, or the marker check fails on a duplicate id.
- **"Committed" and "committed somewhere that survives" are different claims.** Worktree branches
  (`worktree-agent-*`) are disposable and auto-removed. `git log --oneline -1` confirms your commit
  is at HEAD; it does **not** tell you which branch HEAD is. Two commits (`af45f77`, `e275039`) were
  stranded on a worktree branch on 2026-08-03 and had to be cherry-picked to `wip/turso-live-metrics`
  (`26549db`, `1d5e6a7`). After any change of working directory — **including one the harness makes
  for you mid-session** — run `git branch --show-current` before trusting a commit, and
  `git branch --contains <sha>` if it matters. Same shape as BL-372: a real success signal that
  answers a different question than the one you are asking. Tracked as **BL-422**.
- **When a hot file is genuinely contended, pathspec is not enough.** `git commit <path>` is
  all-or-nothing per file, and the shared index can hold a copy *behind* HEAD (measured: `BACKLOG.md`
  staged 21 lines behind HEAD, where a bare commit would have reverted a fix made minutes earlier).
  Use `node tools/commit-mine.mjs -m "msg" --hunks 'REGEX' -- <paths>` — private `GIT_INDEX_FILE`,
  shared index never written, working tree never modified. Dry-run first. Tracked as **BL-409**.
- **Never assume a failure is someone else's** — see §2.5, which is method, not anecdote.
