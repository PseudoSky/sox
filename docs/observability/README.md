# Memory Observability — Logs, Traces, Metrics

> **What exists today**, where it lands, what is in it, and how to actually read it.
> Implementation: `libs/memory-core/src/telemetry.ts` (BL-320).
> Successor design (multi-package substrate): **BL-351**, `docs/reporting/memory/sandbox/PLAN.md` §P1.0.

**This documentation did not exist until 2026-07-31.** The system had been writing structured
telemetry to disk since 2026-07-30 — 17.2 MB on day one — and **nothing in the repo referenced
it, no analysis had ever been run against it, and no backlog item cited its contents.** The
first time anyone read it (§6) it immediately answered a HIGH-priority question that had been
open for two days. Treat that as the standing lesson: *the logs are only worth their write cost
if someone reads them.*

---

## 1. Where the logs are

```
~/.adhd/sox-ecosystem/memory/logs/
├── memory-core-2026-07-30.jsonl          ← today's active file (per component, per UTC day)
├── memory-core-2026-07-31.jsonl
└── memory-core-2026-07-31.<epoch>-<seq>.jsonl   ← size-rotated overflow
```

Root follows this machine's convention — personal tool/service state under `~/.adhd/<tool>/`,
not XDG paths. Override with `SOX_ECOSYSTEM_HOME` or `SOX_MEMORY_LOG_DIR`.

**Naming:** `<component>-<UTC date>.jsonl`. Rotation is **both** daily (date in the filename)
and size-based (default 20 MB → renamed to `.<epoch>-<seq>.jsonl`, retaining 7 files per
component). The `<seq>` suffix exists so two rotations in the same millisecond cannot clobber
each other.

---

## 2. Design guarantees — and why each exists

Every one of these is a reaction to a specific way the 2026-07-30 incident went blind. They are
load-bearing; do not "simplify" them away.

| Guarantee | Why |
|---|---|
| **START is logged before the operation is awaited** | A hang leaves `try/finally` unreached and produces *zero* trace. Logging the start first means an operation that never returns is already durably visible. This is the single most important property of the module — see §5.2. |
| **Never throws, never blocks** | Every write is fire-and-forget inside a try/catch, silently dropped on failure. A logging fault must never break or slow the caller. |
| **Never logs content** | No episode content, no embedding vectors, no raw query parameters. Only ids, counts, byte lengths, durations, and error text. |
| **Env read per-call, not cached** | Operators and tests can flip level/dir/disable without restarting the process. |
| **SQL text captured on error** | `instrumentAdapter` proxies `executeGet`/`executeAll`/`executeRun`/`exec` **and** the transaction object, so any SQL failure anywhere — open-time DDL, Phase-A insert, recall query — is logged with its (truncated) SQL and `adapter_type`, then re-thrown **unchanged**. Pure passthrough on success. |

---

## 3. Record shape

Every line is one JSON object. Five fields are always present:

```jsonc
{ "ts": "2026-07-31T00:14:58.464Z", "level": "info", "event": "embed.finish",
  "trace_id": "01KYTRCCD5D60MT9KBXDK8RJ8R", "pid": 23182,
  "text_len": 443, "duration_ms": 5771 }
```

`level` is one of `debug|info|warn|error` (default threshold `info`). `trace_id` is a ULID or
`null`.

### 3.1 Trace-id propagation

A trace id is threaded end-to-end via `AsyncLocalStorage`. Whichever code path establishes the
root context — normally `WriteQueue.enqueue` — causes **every nested `log.*` call** in
`write.ts`, `embed.ts`, `embed-pipeline.ts` and `db.ts` to carry the same `trace_id`, with **no
signature changes** on any function in between.

**Known gap:** `embed.start` / `embed.finish` currently emit `trace_id: null` — the embed path
runs outside the enqueue-established context, so embeds cannot be correlated to the write that
requested them. This is a real limitation for BL-331-class analysis and must be closed by
BL-351's substrate work.

---

## 4. Event catalog

Complete, derived from the events actually present on disk (not from reading the source — these
are the ones that really fire). Counts are 2026-07-30 + 07-31 combined.

### Write queue
| Event | Fields | Count |
|---|---|---|
| `writequeue.enqueue` | `kind`, `label`, `queue_depth`, `store` | 11126 |
| `writequeue.task.start` | `kind`, `label`, `mode`, `queue_depth`, `store` | 22275 |
| `writequeue.task.finish` | + `duration_ms` | 22134 |
| `writequeue.task.error` | + `duration_ms`, `error` | 140 |

`queue_depth` is the closest thing we currently have to a contention signal — see §5.3.

### Write path (Phase A = row insert)
| Event | Fields | Count |
|---|---|---|
| `write.phaseA.start` | `client_request_id`, `content_len`, `has_tags`, `project_path`, `session_id`, `source` | 3910 |
| `write.phaseA.finish` | `duration_ms`, `episode_uid`, `has_pending_embed`, `replayed` | 1058 |
| `write.phaseA.dedup` | `duration_ms`, `existing_uid` | 7 |
| `write.phaseA.error` | `code`, `duration_ms` | 75 |

### Embedding
| Event | Fields | Count |
|---|---|---|
| `embed.start` | `text_len` | 1898 |
| `embed.finish` | `text_len`, `duration_ms` | 1838 |
| `embed.error` | + `error` | 20 |

### Embed pipeline (Phase B = vector persist + post-processing)
| Event | Fields | Count |
|---|---|---|
| `embed_pipeline.apply.finish` | `rowid`, `status`, `uid` | 87 |
| `embed_pipeline.apply.discarded` | `reason`, `rowid`, `uid` | 1 |
| `embed_pipeline.phaseB.error` | `error`, `rowid`, `uid` | 73 |
| `embed_pipeline.neardup.error` | `error`, `rowid`, `uid` | 10 |

### Store open / schema
| Event | Fields | Count |
|---|---|---|
| `store.open.start` | `adapter_type`, `db_path` | 7514 |
| `store.open.finish` | + `duration_ms` | 1406 |
| `store.open.error` | + `duration_ms`, `error` | 1549 |
| `store.error` | `adapter_type`, `error`, `method`, `sql` | 142 |
| `store.open.fts_index_create_failed` | `adapter_type`, `db_path`, `error` | 25 |
| `store.open.fts_legacy_residue_drop` | + `residue_count` | 23 |
| `store.open.turso_fts5_residue_drop` | `db_path`, `residue_count` | 3 |
| `store.open.turso_vec0_drop` | `db_path` | 70 |
| `store.open.ddl_statement_skip` | `adapter_type`, `error`, `sql` | 3 |

---

## 5. How to actually read these

### 5.1 ⚠ Separate live-store processes from test processes FIRST

**The log is a single stream shared by the live server and every test/CI process on the
machine.** Mixing them produces numbers that are meaningless in both directions — this is not
hypothetical, it is exactly what made the naive first pass wrong.

Classify by whether a pid ever touches the live store path:

```python
live = {o['pid'] for o in rows
        if '/Users/nix/.memory/memory.db' in str(o.get('store','')) + str(o.get('db_path',''))}
```

On 2026-07-31 that separated **6 live pids** from **100 test pids** — and the two populations
had embed p50s of **6936 ms** and **297 ms** respectively. Reported together, the mean was
69476 ms, which describes neither.

### 5.2 Find hangs: count `.start` without a matching `.finish`/`.error`

This is what the always-log-the-start guarantee is *for*, and it is the highest-value query in
this document.

```
starts − (finishes + errors) = operations that never returned
```

Measured across both files:

| Operation | start | finish | error | **unaccounted** |
|---|---|---|---|---|
| `store.open` | 7514 | 1406 | 1549 | **4559 (61%)** |
| `write.phaseA` | 3910 | 1058 | 75 (+7 dedup) | **2770 (71%)** |
| `embed` | 1898 | 1838 | 20 | **40** |
| `writequeue.task` | 22275 | 22134 | 140 | 1 |

The write-queue accounts for essentially all of its work. `store.open` and `write.phaseA` do
not, by a wide margin. Some fraction is processes killed mid-operation (test runners exiting),
which this method cannot distinguish — **so treat these as an upper bound and a lead, not a
verdict.** Filed as **BL-353**.

> **⚠ The percentages above are additionally biased by BL-365 and must not be quoted as
> measurements.** The sink buffers in userspace: measured, **0 of 10,000 records survived a
> `SIGKILL`**. An operation whose `.start` was still buffered when its process died is therefore
> counted as *"never started"* rather than *"never finished"* — skewing the unaccounted share in
> an **unknown direction**. The technique is sound and the shape of the result stands; the numbers
> are provisional until BL-365 lands.

### 5.3 Contention: `queue_depth` and the wait-vs-work gap

`writequeue.enqueue` and `writequeue.task.start` both carry `queue_depth`. The gap between an
`enqueue` and its matching `task.start` (join on `trace_id` + `label`) is **wait**;
`task.finish.duration_ms` is **work**. Today that split has to be reconstructed by hand —
making it a first-class primitive is BL-351's central requirement, and it is the measurement
Theme 2's resource governance is blocked on.

### 5.4 SQL failures

Every `store.error` carries the offending SQL and `adapter_type`, so backend-specific failures
are directly greppable:

```sh
rg '"adapter_type":"turso"' ~/.adhd/sox-ecosystem/memory/logs/*.jsonl | rg '"level":"error"'
```

### 5.5 A starting analysis script

`~/.adhd/sox-ecosystem/memory/log-analysis/` holds the scripts from the first real pass
(§6): event/level histograms, per-population embed distributions, error rollups, and the
start/finish accounting above. Start there rather than from scratch.

---

## 6. What the first analysis found (2026-07-31)

Run once, on data that had been sitting on disk for two days. Every item below is measured, not
inferred.

1. **BL-331 ("embed pipeline ~18x too slow in production") is confirmed and quantified — but
   its framing was wrong.** Same code, same machine, same day: test-process embeds ran at p50
   **297 ms** (p90 315, max 1070 → ~4.5/s); live-store embeds ran at p50 **6936 ms**, p90
   **91186 ms**, max **10953175 ms (3 hours)**. 21 of 80 live embeds exceeded 30 s.
   So it is **~23x on the median plus a catastrophic tail**, not a uniform slowdown — and the
   difference is not the code, it is something about the live process context.
2. **It is not queue-wait and not the DB write.** Median gap between an embed finishing and the
   next starting: **9 ms**. `writequeue.task` p50: **0 ms**, mean 28–50 ms. The time is inside
   embed compute. This directly answers BL-331's open "separate queue-wait from compute"
   question, which its own fix sketch had proposed doing *using this log* — and which nobody
   had done.
3. **`embed_pipeline.phaseB.error: wq.enqueue is not a function`** — 73 occurrences. A plain
   TypeError on the vector-persist path: the embedding is computed, then fails to be written.
   That is precisely the BL-348 loss scenario, observed. (Seen on non-live pids in the sample
   examined — scope on the live path still to be confirmed.)
4. **Schema drift, live:** `no such column: meta`, `no such column: k`, `no such table:
   main.fts_node` — all against the live store (BL-300/301).
5. **`store.open.error: Cannot read properties of undefined (reading 'load')`** — 200
   occurrences. This is BL-323's `sqlite-vec` destructure defect, confirmed firing at volume.
6. **`step failed: Parse error: malformed JSON`** — the `tags = ''` defect (BL-342), live.
7. **The start/finish accounting gaps in §5.2** — filed as BL-353.

---

## 7. Configuration

| Variable | Default | Effect |
|---|---|---|
| `SOX_MEMORY_LOG_DIR` | `~/.adhd/sox-ecosystem/memory/logs` | Override directory entirely |
| `SOX_MEMORY_LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |
| `SOX_MEMORY_LOG_COMPONENT` | `memory-core` | Filename prefix |
| `SOX_MEMORY_LOG_DISABLE` | *(unset)* | `1` disables all writes |
| `SOX_MEMORY_LOG_MAX_BYTES` | `20000000` | Size rotation cap |
| `SOX_MEMORY_LOG_MAX_FILES` | `7` | Retained files per component |
| `SOX_ECOSYSTEM_HOME` | `~/.adhd/sox-ecosystem` | Data root |

### ⚠ These controls do not work on the live service

**All four `SOX_MEMORY_LOG_*` variables are silently stripped** before the memory-server is
spawned, by six duplicated env allowlists (**BL-344**) under `policy.enforced`. Setting them in
your shell, in the plist, or in a service config has **no effect** on the running service —
they survive only for in-process/test use. There is no warning; the variable simply is not
there. Until BL-344 lands, the live service's logging is fixed at its defaults, and the 20 MB
rotation cap in particular cannot be tuned where the volume actually accumulates.

---

## 8. Known gaps

| Gap | Tracked |
|---|---|
| **memory-core only** — `embedding-provider`, `store-adapter`, `graph-store`, `host-runtime` have no equivalent | BL-351 |
| **Env controls scrubbed on the live service** | BL-344 |
| **`embed.*` events carry `trace_id: null`** — embeds cannot be correlated to their originating write | BL-351 |
| **No metrics aggregation** — raw events only; nothing computes throughput/percentiles, and nothing surfaces them via `memory_ping` | BL-319, BL-334 |
| **`time_to_vector_ms` exists with 0 samples** — heal path bypasses write-path instrumentation | BL-319 |
| **wait-vs-work not a first-class primitive** — must be reconstructed by hand | BL-351, BL-322, BL-345 |
| **Nothing reads these logs** — no alerting, no periodic analysis, no surfacing; two days of data went unexamined | BL-353 |
| **The sink is not crash-durable** — buffered in userspace; 0 of 10,000 records survived SIGKILL. The host lost power mid-backfill on 2026-07-30, so the pre-crash window is simply gone | BL-365 |
| **`store.open`/`write.phaseA` start-finish accounting gaps** | BL-353 |

---

## 9. Volume

~17.2 MB / 66887 lines on the 2026-07-30 incident day; ~2.1 MB / 8500 lines by 14:24 on
07-31 — from **one** package. BL-351 extends instrumentation to six or more, so retention and
rotation policy is load-bearing, not a nicety. Note this interacts with §7's warning: the
rotation cap is one of the scrubbed variables.
