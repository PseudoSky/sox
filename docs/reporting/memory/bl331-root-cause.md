# BL-331 root cause — why identical embed code is ~18x slower in the live server

> **Status:** root cause identified and reproduced, 2026-07-31.
> **Method:** existing BL-320 telemetry (93357 events, 2026-07-30 + 07-31) plus an interleaved
> A/B against the real embedding provider. No service restart, no write to `~/.memory`.
> **Probes (reproducible):** `~/.adhd/sox-ecosystem/memory/log-analysis/bl331-*.{py,mjs}`

## Headline

BL-331 is **three separate defects** that an average had blended into one "18x slowdown".

| # | Defect | Share of the symptom | Status |
|---|---|---|---|
| **1** | **macOS background QoS.** `os-unit.ts` hardcodes `ProcessType: Background` on *every* sox launchd unit. The live memory-server and its fastembed child run at scheduling **priority 4**; a terminal-launched process runs at **31**. On Apple Silicon this confines CPU-bound ONNX inference to efficiency cores. | The **entire median shift** (~470 ms → ~8400 ms, **18x**) | **Reproduced** by interleaved A/B |
| **2** | **`duration_ms` is wall-clock across system sleep.** The 6 multi-thousand-second "embeds" — including the 3-hour one — were **88–99.7% system sleep**. They are not hangs and not compute. | 6 of 28 tail events, **88.7% of all tail wall time** | **Measured** against `pmset -g log` |
| **3** | **Head-of-line blocking in the single shared fastembed child.** Awake embed duration grows monotonically with in-flight concurrency on the same child: 1→6.0 s, 2→53.7 s, 5→61.6 s, 6→91.2 s, 7→149.8 s. | The remaining 22 tail events (30–160 s) | **Measured**; this is BL-322 fix-sketch item 1, finally answered |

Defect 1 is the answer to "why is the median 23x". Defects 2 and 3 are the tail, and they are **not** the same phenomenon as each other or as the median — exactly the separation the investigation was asked to make.

A fourth defect was found incidentally and is the reason the contention narrative kept
self-confirming — see §6.

---

## 1. Defect 1 — `ProcessType: Background` (the median)

### The code

`libs/host-runtime/src/os-unit.ts:458-459` emits, unconditionally, for every generated unit:

```
  <key>ProcessType</key>
  <string>Background</string>
```

There is no conditional and no spec field — every sox OS service gets it. The live plist
(`~/Library/LaunchAgents/com.sox.user.memory-server.plist`) carries it verbatim.

### The observed priority

```
 7687  1     pri 4   node ... bin/soxe serve memory-server --port 3099   (launchd child)
 7721  7687  pri 4   node ... memory-server/dist/index.js                (the backend)
 7724  7721  pri 4   node ... memory-server/dist/fastembedProcessHost.js (inherits)
 3203  —     pri 31  node ... bl328-embed.mjs                            (terminal-launched)
```

The fastembed child **inherits** the policy, so the throttle lands directly on ONNX inference.

### The A/B

Same code, same 6-item real-content workload, alternated round-by-round so the machine's
(heavy, shared) load hits both arms equally. `taskpolicy -b` was verified to produce **pri 4** —
identical to the live server — making it a faithful reproduction of the launchd policy.

| round | normal (pri 31) p50 | background (pri 4) p50 | model init, normal | model init, background |
|---|---|---|---|---|
| 1 | 417 ms | 8174 ms | 642 ms | 8176 ms |
| 2 | 568 ms | 9097 ms | 686 ms | 12012 ms |
| 3 | 435 ms | 7990 ms | 686 ms | 9447 ms |

**~470 ms → ~8400 ms: 18x on the median, 14x on model load.** The slowdown is not
embed-specific — it is a general CPU-throughput throttle, which is why model init is hit too.

The live server's own measured figure agrees: **p50 6.0 s** awake at in-flight 1 (n=619). The
A/B's background arm is slightly worse (8.4 s) because the machine was under another agent's
test suite at ~400% CPU throughout — an honest overshoot, in the expected direction.

### Cross-check against the same-machine control

Ten short-lived processes that touch the live store but are **terminal-launched** (pri 31)
appear in the same telemetry: pids 32380, 58252, 31280, 30385, 34188, 38845, 41373, 49850,
58453, 33499 — all with awake **p50 0.3–0.9 s**. Same store, same code, same day, same content
mix. The only difference is who spawned them.

**This also corrects the "live vs test" framing itself.** The split that matters is not
live-store vs test-store, it is **launchd-spawned vs terminal-spawned**. Several "live" pids are
fast, and they are exactly the terminal-launched ones.

---

## 2. Defect 2 — the multi-hour "embeds" are wall-clock across system sleep

`duration_ms` is derived from wall clock, so a suspended process accrues duration while the
machine sleeps. Intersecting each tail window with the sleep intervals from `pmset -g log`:

| window (UTC) | pid | duration | **asleep** | % asleep | awake |
|---|---|---|---|---|---|
| 07-30 17:55→19:12 | 23182 | 4648.1 s | 4052.0 s | **87.2%** | 596.1 s |
| 07-30 17:56→19:12 | 23182 | 4591.0 s | 4052.0 s | **88.3%** | 539.0 s |
| 07-30 20:59→21:52 | 23182 | 3154.0 s | 3143.0 s | **99.7%** | 11.0 s |
| 07-31 00:15→03:18 | 23182 | **10953.2 s** | 10450.0 s | **95.4%** | 503.2 s |
| 07-31 03:35→06:21 | 23182 | 9968.5 s | 9438.6 s | **94.7%** | 530.0 s |
| 07-31 06:37→06:38 | 23182 | 50.9 s | 39.6 s | 77.9% | 11.3 s |

Across the whole >30 s tail: **35130 s wall, 31175 s asleep (88.7%)**. Against the ≤30 s
population, only **1.1%** of wall time was sleep — so this is specific to the tail, not a
uniform correction.

**The "3-hour embed" is 503 s of awake time on a laptop that slept for 2 h 54 m mid-operation.**
It is not a hang. Any future analysis that treats it as one is chasing a clock artifact.

> ⚠ **Parse trap, recorded because it produced a wrong answer here first.** Do not pair a pmset
> `Sleep` line with the next line whose first token is `Wake` — pmset emits a **`Wake Requests`**
> line ~2 s after every `Sleep`, which truncates every interval to seconds and makes the machine
> look permanently awake (it reported 0.1 h asleep instead of 11.31 h, and briefly "refuted" this
> defect). pmset states the sleep duration on the `Sleep` line itself (`... 598 secs`) — use that.

---

## 3. Defect 3 — head-of-line blocking in the shared fastembed child (the real tail)

`sharedFastembedProcess` routes every request through **one** forked child. A request's measured
duration therefore includes everything queued ahead of it. Reconstructing in-flight concurrency
per pid from `embed.start`/`embed.finish`, with sleep time subtracted so defect 2 cannot
contaminate the signal:

| in-flight on the same child | n | awake p50 | awake p90 |
|---|---|---|---|
| 1 | 619 | **6.0 s** | 11.7 s |
| 2 | 10 | 53.7 s | 539.0 s |
| 3 | 2 | 24.9 s | 24.9 s |
| 5 | 2 | 61.6 s | 61.6 s |
| 6 | 2 | 91.2 s | 91.2 s |
| 7 | 3 | **149.8 s** | 157.9 s |

Monotone in concurrency, and the per-pid profile is the same story: pid 73540 reached
`max_in_flight = 7` with awake p50 **131 s**; pid 33533 reached 3 with p50 **53.7 s**; every pid
that stayed at in-flight 1 sat at p50 **6–8 s**.

**Honest limit on this one:** 7 × 6 s = 42 s, but the observed p50 at in-flight 7 is 149.8 s —
**~3.5x more than strict serialization alone predicts.** Serialization is demonstrated; the
additional amplification is not yet attributed. Candidates (untested): per-request state
thrash in the child when requests interleave, or a worse-than-linear interaction between
queueing and the QoS throttle. Do not report the tail as "fully explained by serialization."

This answers BL-322's fix-sketch question 1 — *"Does the singleton fastembed process cause
head-of-line blocking for all embed requests?"* — **yes, measurably.**

---

## 4. Ruled out, with numbers

| Hypothesis | Verdict | Evidence |
|---|---|---|
| **Text length** (live embeds real content, tests embed short fixtures) | **No** | Within pid 23182, duration is flat across length: 100-150 ch → 5809 ms, 200-300 → 7040, 300-500 → 6351, 500-1000 → 6363. The **minimum is 5451 ms in every bucket** — a floor, not a slope. |
| **Long-lived process state / memory pressure / thermal drift** | **No** | pid 23182 ran 763 min with a stable p50 (6.4 s). The A/B reproduced the full slowdown in a **freshly spawned** process whose only difference was QoS. |
| **Store size / content / the live db being special** | **No** | The A/B process opened **no store at all** and still reproduced 18x. |
| **System sleep as the cause of the *median*** | **No** | Only **1.1%** of ≤30 s embed wall time overlapped sleep. Sleep explains the tail's group 1 only. |
| **Foreground contention as the cause of the *tail*** | **No** | Every tail event in group 2 had **zero** concurrent non-live memory-core events. (Caveat: this proxy only sees processes that emit BL-320 telemetry; non-instrumented load is invisible to it.) |
| **ANE / CoreML EP partitioning** | **Not the median** | Whatever CoreML does, it does identically in both A/B arms — the arms differ only in scheduling priority, and that alone produces 18x. Still **untested** as a contributor to the residual amplification in §3. |
| **Queue wait, DB write** | **No** (prior work, unchanged) | 9 ms median inter-embed gap; `writequeue.task` p50 0 ms. |

### A correction to the baseline everyone has been quoting

**899 of 1755 "test" embeds in the telemetry completed in <10 ms.** The distribution is
bimodal with *nothing* between 10 and 100 ms: 899 at <10 ms, then 856 at ≥100 ms with p50
**423 ms**. The sub-10 ms population is a deterministic/hash provider, not an ONNX forward pass,
and must be excluded from any baseline. **The honest real-inference reference is ~423 ms**,
which independently matches the clean-room figure (~2.1–2.8/s) and my own BL-328 measurement
(2.25–2.60/s ≈ 400 ms). It does *not* change BL-331's conclusion — it makes the comparison sound.

---

## 5. What to do

1. **Stop hardcoding `ProcessType: Background`** (`os-unit.ts:458-459`). It is correct for a
   doctor-tick job and wrong for a latency-sensitive server. Make it a spec field defaulting to
   `Adaptive` (or `Standard` for interactive services), and set it per unit. **This one change
   is worth ~18x on live embed throughput** and is the gate on re-enabling BL-339/BL-346.
   Re-measure after the change rather than assuming the full 18x lands.
2. **Make telemetry durations monotonic.** `duration_ms` must come from
   `process.hrtime.bigint()`, not wall clock. Optionally keep wall-clock separately so
   sleep-spanning is *visible* rather than silently inflating compute metrics. This is a
   prerequisite for BL-351's substrate — every span it defines has the same exposure.
3. **Bound or parallelize the shared fastembed child** (BL-322 item 1). At minimum, report
   in-flight depth so head-of-line blocking is visible in `memory_ping` instead of having to be
   reconstructed from a log.
4. **Fix the IPC-channel leak** (§6, BL-370) before it corrupts another investigation.

---

## 6. Incidental defect — every process that embeds once never exits

`sharedFastembedProcess.ts:78,112` calls `c.unref()` twice, with a comment stating the intent:
*"so a real process can exit when its own work is done instead of hanging on this child
forever."* **The intent is not achieved.** `fork()` with `'ipc'` creates a *separate* channel
handle; `ChildProcess.unref()` does not unref it.

Red→green, isolated from the package:

```
arm: unref() only (the shipped pattern)      → exit=124 (never exited)
arm: unref() + channel.unref()               → exit=0   (exited cleanly)
```

Observed in the wild: two of my own probe processes (pids 3203, 25482) were still alive **40+
minutes** after writing their final output, each holding a loaded-model fastembed child.

**This matters beyond the leak.** The `[fastembed] WARNING … another fastembed host process
(pid N) is ALREADY RUNNING` message has been read as evidence of real ANE contention. At least
one instance was self-inflicted: during this session the warning named **pid 25484 — a leaked
process from my own earlier probe**, idle at 0.0% CPU. The contention narrative has been partly
confirming itself off orphans this defect creates. Filed as **BL-370**.

---

## 7. Reproducing

```bash
D=~/.adhd/sox-ecosystem/memory/log-analysis
python3 $D/bl331-textlen.py        # text-length confound (ruled out)
python3 $D/bl331-shape.py          # distribution shape, per-pid, per-age
python3 $D/bl331-within-pid.py     # the floor, within one process
pmset -g log | grep -E "^2026-..-.." | grep -vi assertion > /tmp/pmset.txt
python3 $D/bl331-sleep-overlap.py  # defect 2
python3 $D/bl331-inflight.py       # defect 3
# defect 1 — interleave the arms; a sequential A-then-B confounds on a shared machine
for r in 1 2 3; do
  node                    $D/bl331-qos-round.mjs cohorts.json normal     $r
  /usr/sbin/taskpolicy -b node $D/bl331-qos-round.mjs cohorts.json background $r
done
```

`cohorts.json` comes from `bl328-extract.mjs` (see `sandbox/cluster-calibration.md`).

## 8. Notes on the run

- **The live memory service was not stopped or restarted, and `~/.memory` was never written.**
  Everything in §1–§4 comes from telemetry already on disk plus scratch processes.
- All A/B absolute numbers are **CONTENDED** — another agent's `memory-server` test suite ran at
  ~400% CPU throughout, load average 7.5–10.6. They are **not baselines**. The arms were
  interleaved specifically so the *ratio* survives that; the ratio is the result.
- `taskpolicy -b` sets `nice 10` where launchd's `ProcessType: Background` leaves `nice 0`; both
  produce **pri 4**, which is the scheduling-relevant value. Noted for completeness.
- Two leaked fastembed hosts from my earlier probes (pids 3203/25482 and children) could not be
  cleaned up — process termination is not permitted in this session. They were idle at 0.0% CPU.
  They should be reaped; see §6.
