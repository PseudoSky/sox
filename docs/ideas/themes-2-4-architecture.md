# Themes 2–4: Resource Governance, Lifecycle Operations, and Status-as-Fact

> Companion to `docs/ideas/theme-1-verification-harness.md` (Theme 1 — self-verification
> primitives / invariant checks). Theme 1 was not yet written at the time this document was
> drafted; where this document assumes an invariant-checking primitive exists, that dependency
> is called out explicitly rather than re-designed here.
>
> Scope discipline per the assignment: **design only, no production code.** Every claim below is
> tagged **MEASURED** (verified against this repo's code, tests, or the incident record) or
> **INFERRED** (reasoned from the design, not yet run). Where a cheap experiment would settle an
> INFERRED claim, that experiment is named.

## How the three gaps actually relate

Gap 1 (self-verification) is the dependency root. Gap 2 (resource governance) needs Gap 1's
facts to make scheduling decisions (you cannot throttle background work based on "foreground is
starving" if nothing measures foreground latency under load). Gap 3 (lifecycle ops) needs Gap 1's
facts to know an operation succeeded (backup/restore/repair are worthless without integrity
verification), and several Gap 3 operations (repair) are themselves consumers of Gap 1's
invariant checks — repair is "run the checks, fix what's red, run the checks again." The build
order in this document is **1 → 3 → 2**, not 1 → 2 → 3, and the reasoning is in
[Sequencing](#sequencing-dependencies-and-effort).

---

## Gap 1 coverage note (boundary with Theme 1)

This document does not design the invariant-checking harness itself — that is Theme 1's job.
What it designs, in the "Gap 1" section below, is **the status-surface half of self-verification**:
where invariant results get reported, at what cadence, and what `memory_ping`/`memory_stats`
must expose so a human or agent never again has to reconstruct system state by grepping logs.
This is exactly BL-334's ask. The actual invariant *implementations* (integrity_check parsing,
throughput baselines, EP-partitioning detection) are Theme 1's deliverable; this document treats
them as a black-box `runInvariantChecks(): CheckResult[]` API and designs everything downstream
of that call.

## Gap 1 — Self-verification: what production systems do, and the design for this store

### What production-grade systems actually do

**MEASURED** via prior repo research (`.opencode/research-trace/2026-07-28-turso-locking-error.md`,
`2026-07-23-libsql-mvcc.md`) plus this session's search — three established patterns apply directly:

1. **Health checks report facts, not liveness.** The distinction the industry draws is
   *liveness* ("the process is running and responding") vs *readiness* ("the process is
   correctly serving its function") vs *health* ("the subsystems are individually verified
   correct"). Kubernetes formalizes exactly these three probe types for this reason — a
   process can be alive and unready, or alive-and-ready-but-unhealthy (serving stale/wrong
   data). This store's `memory_ping` currently only answers the first question. **This is the
   single generalizable lesson: a status endpoint that can only say "I responded" cannot ever
   catch a "responded with the wrong answer" failure — which is exactly what happened for five
   weeks (`enrichment: "stalled"` correctly reported, silently ignored) and what `idx_fts_node`
   existing-but-returning-0-rows demonstrates (readiness ≠ health).**

2. **`PRAGMA integrity_check` / `quick_check` is SQLite's native health-check primitive, and
   it is deliberately NOT run continuously** — it's a full table+index scan
   (**MEASURED**, `PRAGMA integrity_check` is documented as O(pages) and read-locks the whole
   DB [sqlite.org/pragma.html]). Production SQLite guidance (**MEASURED** via the search above)
   converges on: cheap `quick_check` on a fast cadence, full `integrity_check` on startup and
   after any bulk operation (restore/migration), never mid-request. This maps directly onto
   BL-335/336/337/338's requirement.

3. **A watchdog counter must have a "wrong" state, not just an "incrementing" and "stalled"
   state.** The industry pattern here is a **canary/synthetic transaction** — periodically
   perform a real operation with a known expected result and compare (e.g. a synthetic write +
   read-back, a synthetic FTS query against a known-indexed term) rather than trusting an
   internal counter that the failing subsystem itself controls. This is the direct fix for
   `idx_fts_node exists → returns 0 rows`: an index existing is a schema fact, not a functional
   fact, and only a canary query proves the functional fact.

### The specific design for this system

**Three invariant classes**, each with a different cost/cadence, feeding one aggregation point.

| Class | What it checks | Cost | Cadence | Example from this incident |
|---|---|---|---|---|
| **Structural** | schema-level facts: table/index exists, `_adapter_meta` has no dup PKs, FTS index present | O(ms), single-row queries | every `memory_ping` call | `idx_fts_node` existing |
| **Functional (canary)** | a real read/write against the actual data path, result compared to expectation | O(10–100ms) | on a 60–300s self-timer, cached, never on the request path | `idx_fts_node` returning 0 rows for a known-indexed term |
| **Deep** | `PRAGMA integrity_check`/`quick_check`, full backlog/coverage recompute | O(seconds–minutes), full scan | on startup, after bulk ops (restore/migrate/repair), and on an opt-in slow interval (e.g. daily) — **never** inline in a request | BL-335's 100+ index-entry damage |

All three write into one in-process **`HealthRegistry`** — a `Map<subsystem, CheckResult>` where
`CheckResult = { status: 'green'|'yellow'|'red', reason: string, measured_at: ISO, evidence: object }`.
`memory_ping`/`memory_stats` read this map (O(1), no new work per call) rather than recomputing
anything expensive on the hot path — this preserves the "a `memory_ping` call must never be the
thing that's slow" property that's currently violated (BL-334's own ask: "a status call answers
without shelling out").

**Concrete subsystems and their canaries** (closes the specific BL-334 table row by row):

- `embedding`: functional canary = embed one fixed short string every N minutes, compare cosine
  similarity to a stored reference embedding (expect ~1.0; a broken/degraded model drifts).
  Structural = execution provider name + measured recent throughput vs a stored baseline
  (`embed_throughput_per_sec` from BL-319, now with a red/yellow/green band, not just a number).
  This directly answers "is CoreML actually 25x slower" — the number now has a verdict attached.
- `fts`: functional canary = run a `MATCH` query for a term known to be in a specific seeded row
  (stamped once at store creation, e.g. a hidden sentinel episode with a fixed word), assert
  exactly 1 hit. Structural = `idx_fts_node` presence in `sqlite_master`.
- `clustering`: functional = `total_clustered / cluster_count` ratio (BL-327's own reproduction
  metric) plus "has a full pass run in the last N days" (closes BL-326's silent-dead-stub case —
  if incremental clustering is permanently a no-op and no full pass has run, that's `red`, not
  silently `cluster_count: 139`).
- `wal`: structural = WAL file exists AND has a live directory entry (an `fs.stat` + inode
  cross-check closes the exact BL-330 failure mode of an unlinked-but-open WAL — `fstat` on the
  open fd vs `stat` on the path; a mismatch in link count is the unlink signal). This is cheap
  (two syscalls) and can run on every `memory_ping`.
- `concurrency`: structural = read `adapter.capabilities` (already computed,
  `turso-adapter.ts:201-210`, just not surfaced) — `multiprocessWrite`, `needsWriteSerialization`
  — plus the exact connect options a joining process needs. **This is the entire fix for BL-334's
  "locking is back" false alarm: it was a real fact sitting in an already-instantiated object that
  nothing read.**
- `write_queue` / `enrichment` / `embed_backlog`: already computed (`index.ts:894-956`,
  `WriteQueue.metricsForPath`) — fold into the registry with red/yellow/green bands instead of
  bare numbers (BL-334's literal ask: "a red/yellow/green with the reason").

**Cost model:** structural checks are O(1) SQL and syscalls, safe on every `memory_ping`.
Functional canaries run on a self-timer (default 120s) independent of request traffic — a
`memory_ping` never *triggers* one, it only *reads the last result*, so ping latency is
unaffected by canary cost. Deep checks are explicitly operator/lifecycle-triggered (see Gap 3).

**Failing how:** a `red` status on any subsystem is additive to the response — it never blocks
the response itself (a broken FTS index must not make `memory_ping` itself time out; that would
just add a second outage on top of the first). `memory_stats`'s existing `tools` capability list
gets a sibling `health: Record<subsystem, CheckResult>` block.

**Surfaced where:** `memory_ping` gets the cheap structural facts always; a new field
`memory_ping.health_summary: {green: N, yellow: N, red: N}` gives a one-glance verdict; the full
per-subsystem detail lives in `memory_stats` (already the "give me everything" tool per its own
description) to keep `memory_ping` itself fast and small.

### BL items this closes

BL-334 (directly — this *is* the fix), BL-319 (throughput fields get a verdict, not just a
number), BL-322 (concurrency capabilities surfaced), BL-330 (WAL-unlink structural check),
BL-326/327/328 (clustering health canary catches the dead-stub and orphan-community cases without
needing a human to run `clustering-e2e.test.ts` by hand), BL-332 (same *pattern* —
reality-verification instead of trusting a flag — though BL-332 lives in `soxe`/host-runtime, not
memory-core; note it as a sibling fix using the identical principle, not literally closed by this
design).

### What I would NOT build here

- **No external monitoring stack** (Prometheus/Grafana/OpenTelemetry collector). This is a
  single-process, single-user local store. The `HealthRegistry` is an in-process map read by the
  existing MCP tools — that's the entire "observability platform." Anything more is enterprise
  ceremony for a system with one operator.
- **No continuous background `integrity_check`.** It's an O(seconds) full scan; running it more
  than "on startup + after bulk ops + a generous daily/weekly timer" trades the exact
  foreground-starvation problem (Gap 2) for paranoia. The canary pattern exists specifically to
  get *functional* confidence cheaply without needing the *deep* check on a tight cadence.
- **No SLA/alerting/paging system.** Red/yellow/green surfaced in a tool response that an agent
  or human reads is sufficient; there is no on-call rotation for a local memory store.

---

## Gap 2 — Resource governance: what production systems do, and the design for this system

### What production-grade systems actually do

**MEASURED** via this session's search and prior repo research
(`2026-07-28-onnxruntime-execution-providers.md`): the relevant, *directly applicable* patterns
(not generic microservices advice) are:

1. **Priority lanes with admission control**, not raw FIFO — exactly the shape this repo already
   half-built. `WriteQueue` (`libs/memory-core/src/write-queue.ts:1-113`) already implements
   time-based admission control (estimate wait, reject early with `E_BUSY` + `retry_after_ms`)
   and **already has a `kind: 'write' | 'apply'` distinction for metrics segregation** — the
   scaffolding for priority lanes exists; it's declared explicitly NOT to change admission-control
   math (line 58-71, "THE ADMISSION-CONTROL ESTIMATOR IS DELIBERATELY UNCHANGED"). That comment is
   correct for *metrics* but the *scheduling* question (should an `apply`/heal task ever be able to
   sit ahead of a `write`/read task) has never been asked, because heal doesn't go through
   `WriteQueue` for its *read* path at all — reads (`memory_ping`, `memory_recall`, `memory_topics`)
   don't touch `WriteQueue` (writes do; the incident's actual starvation was CPU/ONNX-bound, not
   queue-bound — see point 3).
2. **Separate resource pools for interactive vs batch work**, most commonly via process/thread
   isolation (a worker pool) so a batch job cannot monopolize the same CPU slice as a foreground
   request. This repo already isolates the ONNX embed model into its own child **process**
   (`fastembedProcessHost.ts`, per `libs/data/CLAUDE.md` §BL-11) specifically to avoid crashing
   the main thread — but process isolation solves *crash* isolation, not *CPU* isolation: a
   single-core-pinned ONNX inference in a child process still starves the *parent* Node event
   loop indirectly if the parent is doing synchronous SQLite I/O waiting on results, and directly
   starves *other requests hitting that same child* because fastembed's IPC queue is serial
   (BL-322's open question #1, BL-331's candidate cause #1).
3. **Token-bucket / concurrency-cap throttles on background work**, sized to leave explicit
   headroom for foreground. This is the actual production answer to "background starves
   foreground": not smarter scheduling of a single resource, but a hard cap on how much of the
   resource background work is *allowed* to consume, so foreground always has slack. This is
   precisely what's missing today — `SOX_DISABLE_EMBED_HEAL` (BL-339) is the degenerate 0%-or-100%
   version of this cap.

### The specific design for this system

**Root cause, stated precisely (this matters for the design):** the 12-hour incident's
starvation was **not** a `WriteQueue` problem — reads don't go through `WriteQueue`. It was the
**enrich tick blocking the async chain that reads share**: `runPeriodicEnrichPassGuarded` /
`healMissingVectors` (`embed-pipeline.ts:631`) runs on a self-rescheduling `setTimeout` chain
(`index.ts:2169-2177`, itself a good pattern — no `setInterval` overlap) but each tick does
synchronous-ish work (ONNX inference round-trips through the single shared child process) that
monopolizes the Node event loop's attention for the tick's duration, and every MCP tool call
(`memory_ping`, `memory_recall`, `memory_topics`) is a handler on that **same single event loop**,
so it queues behind the tick's promise chain rather than actually running concurrently. **This is
INFERRED from the code shape** — `runPeriodicEnrichPassGuarded` is `async` and each `await`
point inside it (including the IPC round-trip to the embed child process) *should* yield the
event loop back to pending MCP requests. The measured symptom (35s timeouts on trivial reads
during heal) doesn't match "the event loop is technically free between awaits" — which means the
real mechanism is more likely one of: (a) the child-process IPC queue itself serializing *all*
requests including ones a read handler might indirectly trigger, or (b) synchronous SQLite calls
inside the heal tick holding a lock the read path also needs. **This is exactly the kind of claim
that needs a cheap experiment, not more code reading**: instrument `process.hrtime()` gaps between
`await` yields during a heal tick under concurrent `memory_ping` load, and separately check
whether `memory_ping`'s SQL queries (`index.ts:894-922`) are blocked on a lock the heal path holds
during `applyEmbedding`. Whichever it is, the fix below works either way because it doesn't
depend on diagnosing which:

**Design: a bounded concurrency token + explicit foreground reservation, not a smarter scheduler.**

1. **`ResourceGovernor`** (new, small, in-process — analogous to `WriteQueue` but for CPU/IPC
   slots rather than write serialization): a counting semaphore with two pools —
   `foreground` (reserved slots for `memory_ping`/`memory_recall`/`memory_topics`/any read) and
   `background` (the heal/enrich tick). Background can only acquire a slot when foreground
   pressure (measured via `WriteQueue`'s existing latency-percentile machinery, already computed —
   `libs/memory-core/src/latency-stats.ts`) is below a threshold. This is the direct fix for BL-322's
   open question 2 ("route read-only requests around the backend when saturated") without needing
   a second process or a proxy-level change — it's a cooperative yield inside the single process.
2. **Time-slicing the heal tick itself**: `SOX_EMBED_HEAL_TIME_BUDGET_MS` already exists
   (`embed-pipeline.ts:189-199`, default 240_000ms/4min) — but it bounds *total tick duration*,
   not *per-item pause for foreground*. Add a **per-item yield-and-check**: after each embed
   completes, before starting the next, check `ResourceGovernor.foregroundPressure()`; if a read
   is waiting, `await setImmediate()` (yield) before continuing. This turns the heal tick from "one
   long promise chain that technically yields at IPC boundaries but never checks if anyone's
   waiting" into "a tick that actively steps aside." Cost: negligible (one boolean check + maybe
   one macrotask yield per embedded item, ~1-3ms overhead per item against a ~470ms-1.4s embed
   round trip going by `embed_duration_ms` p50 of 7253ms mentioned in BL-331... actually the
   measured p50 there is 7253ms per item, so a 1-3ms yield check is <0.05% overhead).
3. **A throttle knob that's a *range*, not a binary.** Replace the binary
   `SOX_DISABLE_EMBED_HEAL` with `SOX_EMBED_HEAL_CONCURRENCY` (default: unthrottled == current
   behavior once BL-331's throughput bug is fixed) that caps how many *consecutive* items the heal
   tick processes before it must re-check foreground pressure and potentially back off entirely
   for a cooldown window if reads are still degraded. `SOX_DISABLE_EMBED_HEAL=1` remains as the
   emergency full-stop (BL-339's mitigation stays available as the last resort), but becomes a
   fallback, not the only control — closing BL-339's re-enable criterion #2 verbatim ("a throttle,
   concurrency cap, or priority separation").
4. **Priority is a request property, checked at admission, not a queue reorder.** Extend
   `WriteQueue`'s existing admission-control shape (it already computes `estimated_wait` and
   rejects with `E_BUSY` — `write-queue.ts:22-28`) with the same pattern for `ResourceGovernor`:
   reads get a fast-path check ("is a slot free right now?") rather than joining any queue at all
   — reads that would have to wait for a background-CPU-bound resource instead get served from
   whatever's already cached/computed (the `HealthRegistry` from Gap 1 is exactly this: reads of
   *health* never wait on anything, because they read a cache). This is why Gap 1 must exist
   before Gap 2 is fully effective: without the `HealthRegistry` cache, `memory_ping` still has to
   run live SQL queries that *could* be blocked by the same contention Gap 2 is trying to relieve.

**Why not a full priority-queue library (BullMQ etc.)?** **INFERRED, high confidence**: this is a
single Node process with a single shared child-process IPC channel, not a distributed job
system. BullMQ solves cross-process/cross-machine job distribution over Redis — irrelevant
complexity here. The actual problem is "one process, one CPU-bound resource, needs a cooperative
yield policy" — that's a semaphore plus a yield check, not a queueing framework.

### BL items this closes

BL-339 (its own re-enable criterion #2, directly), BL-322 (both open questions — the answer is
"the tick can starve reads via event-loop/IPC monopolization, fixed by cooperative yielding, not
Turso locking"), BL-331 (doesn't fix the throughput bug itself, but makes the *consequence* of a
slow embed pipeline non-fatal to reads while BL-331 is separately diagnosed — the two are
independent: BL-331 is "why is embed slow", Gap 2 is "why does slow embed break unrelated
reads", and both were true simultaneously).

### What I would NOT build here

- **No separate scheduler process, no cgroups/OS-level CPU quotas.** This is a per-process
  cooperative semaphore. Reaching for OS-level resource control on a single-user local tool is
  the over-engineering risk named explicitly in the brief.
- **No dynamic priority *inheritance* or complex fair-share algorithms** (e.g. weighted fair
  queueing, lottery scheduling). Two lanes (foreground/background) with a hard reservation is
  enough — this store has exactly two request classes in practice (interactive MCP calls, and the
  one periodic enrich tick). A generalized N-priority scheduler solves a problem this system
  doesn't have.
- **No redesign of the child-process IPC protocol** unless the cheap experiment above proves it's
  the actual bottleneck (vs. event-loop/lock contention) — that's exactly the kind of
  "confident conclusion from reading code" this document is required to flag as unproven.

---

## Gap 3 — Lifecycle operations: what production systems do, and the design for this system

### What production-grade systems actually do

**MEASURED** (this repo's own precedent + general SQLite operational practice, consistent with
the search results above): the operation set mature datastores expose is small and well-known —
**backup, restore, migrate, repair, verify** — and the property that makes them "production
grade" is not the existence of the commands but three specific guarantees:

1. **Every destructive/mutating lifecycle op is preceded by an automatic, verified backup of what
   it's about to touch**, so the operation is reversible even if it fails midway. This repo
   already has the primitive (`backupStore()`, `libs/memory-core/src/backup.ts:1-24` — VACUUM INTO
   + integrity_check + allowlist-enforced destination) but per the brief's Gap 3 framing, the
   migration path never called it.
2. **Idempotency**: re-running a lifecycle op after a partial failure must be safe, not
   double-apply. `_adapter_meta`'s stamp already gets this half-right (`INSERT OR IGNORE`,
   `adapter-meta.ts:31`) — but BL-336 shows the *other* half (constraint enforcement) can be
   silently bypassed when the store is already damaged, which is exactly why lifecycle ops need
   their own idempotency, not just a reliance on DB constraints.
3. **Verification is structural to the operation, not a follow-up step a human remembers to run.**
   The single biggest gap named in the brief (`migrateStore()` computing `ok` from
   `totalRows > 0` while ignoring per-table `errored` flags) is exactly this failure mode: the
   operation *has* a verification step, it's just wrong/incomplete, which is arguably worse than
   having none because it produces false confidence.

### The specific design for this system

**Five operations, one shared contract.** Every lifecycle operation returns the same result
shape: `{ ok: boolean, steps: StepResult[], backup_ref?: string, verified: VerificationResult }`
— `ok` is `false` unless *every* step succeeded AND `verified.integrity === 'clean'`. This directly
fixes the `totalRows > 0` bug pattern: `ok` is never computed from a row count, only from an
explicit AND over named booleans.

1. **`backupStore`** (exists, `backup.ts`) — extend, don't replace:
   - Add a **Turso-native path**. Current implementation imports `sqlite-vec`/`SqliteAdapter`
     directly (`backup.ts:26-33`) — it's sqlite-specific. Turso's own operational guidance
     (**MEASURED**, `2026-07-23-libsql-mvcc.md`, `2026-07-27-turso-statfs-macos-*` research) is
     consistent with SQLite's: an in-process `VACUUM INTO` from a live connection is the
     WAL-safe way to get a consistent snapshot without stopping the server — this directly fixes
     BL-330's sub-finding (a) that `sqlite3 .backup` of a live store silently omits WAL contents,
     by *never using an external file-copy tool* for backup, full stop. Document that constraint
     as a load-bearing invariant on the adapter interface (BL-330's fix sketch already says this).
   - **Wire it into every mutating lifecycle op automatically** as a mandatory pre-step (not an
     option a caller can skip) — this is the "reversible" guarantee.
   - **Wire it to run on a schedule** (a low-frequency background timer, e.g. every N hours,
     itself using the Gap 2 background-lane so it never competes with foreground) with retention
     (keep last K, prune older) — closing the "the separate backlog tool's own backups silently
     omit the WAL" finding by making this the *one* backup code path everything uses, not a
     second hand-rolled one.

2. **`restoreStore`** (new — currently hand-written `/tmp` scripts per the brief): a supported
   function with the signature `restoreStore(backupPath, targetPath, opts): RestoreResult` that:
   - Opens the backup read-only first and runs a **deep integrity check** (Gap 1's deep class)
     before touching the target — refuse to restore from a corrupt backup.
   - Performs the restore via the store's own driver/adapter (never raw file copy — this is the
     literal root cause named in BL-335: "investigate WHY driver-level inserts skip index
     maintenance"), and — this is the mandatory fix, not a mitigation — **runs
     `PRAGMA integrity_check` (Gap 1 deep check) as the LAST step of `restoreStore` itself,
     before returning `ok: true`**, and if dirty, **automatically runs the repair operation
     (below) inline** before declaring success. This is what makes BL-335 a *closed* defect
     rather than a documented footgun: the operation cannot report success while leaving
     unpopulated secondary indexes, because it doesn't return until they're populated.
   - Preserves the WAL correctly (restore target starts in WAL mode with a checkpoint, not with
     a dangling/absent WAL file) — directly prevents BL-330's failure mode from being
     re-introduced by the restore path itself.

3. **`migrateStore`** (exists, needs hardening per the brief): add the missing guarantees:
   - Call `backupStore` first, unconditionally (guarantee 1 above).
   - Fix `ok` computation: AND over every table's `errored === false`, never `totalRows > 0`
     (guarantee 3 above — this is a small, surgical fix once the contract is defined, not a
     redesign).
   - Add idempotency: re-running a migration that partially completed must detect prior progress
     (via `_adapter_meta` — but only once BL-336's dedupe/upsert fix lands, since migration is
     exactly the kind of operation that re-stamps meta) and resume/skip rather than duplicate.

4. **`repairStore`** (new — this is BL-335/336/337/338's actual deliverable, "a supported repair
   entry point... so this is never hand-rolled again"):
   - `repairStore(path, opts): RepairResult` runs the **deep integrity check**, and for each
     reported issue class, dispatches a targeted, tested fix:
     - Index damage (BL-335): enumerate btree indexes on the affected table(s), `REINDEX` each by
       name — **skipping any custom-index-method index** (BL-337's exact constraint:
       `REINDEX <table>` fails outright when a Tantivy FTS index is present) — then separately
       rebuild the FTS index via its own DDL path.
     - `_adapter_meta` duplicates (BL-336): dedupe using the documented semantics (keep current
       `adapter_type`/`adapter_version`, earliest `created_at`), then fix the underlying insert to
       an upsert (`INSERT ... ON CONFLICT(key) DO UPDATE`) so the class of damage can't recur —
       this is a genuine code fix, not just a repair-time mitigation, and belongs in
       `adapter-meta.ts:31`'s `STAMP_SQL`, called out here as a **paired code fix**, not a
       repair-command workaround.
     - Re-runs the deep integrity check after repair and only returns `ok: true` if it comes back
       clean — repair that doesn't verify its own result is not repair.
   - Exposed as both a library function (called automatically by `restoreStore`/on startup, Gap
     3 ×1 integration) and a CLI-level command (`soxe memory repair`, per BL-335's fix sketch #3)
     for the rare case a human needs to run it standalone.

5. **`verifyStore`** — the shared primitive all four operations above call: thin wrapper over
   Gap 1's deep-check class (`PRAGMA integrity_check`, iterating past its 100-message cap per
   BL-335's own finding — the loop-until-clean logic belongs here once, not reimplemented per
   caller), returning the same `VerificationResult` shape every operation's `verified` field uses.

**Crash-safety as a *tested*, not assumed, property (BL-338's umbrella requirement):** the
concrete test this design enables — and is designed *for* — is: SIGKILL the server mid-write
under sustained load, restart, call `verifyStore` (not a human running `sqlite3` by hand), and
assert `{ok: true}` either because nothing was damaged or because startup's automatic
`repairStore` call fixed it. This requires exactly two integration points that don't exist today:
(a) `repairStore` gets called automatically on every startup as a Gap-1-cheap **structural**
check first (is there damage at all — fast) gating a **deep** check only if the structural check
is suspicious (never a full scan on every restart — that would itself be a foreground-latency
regression at startup, the same class of mistake this whole document is about avoiding); (b)
`restoreStore`'s trailing verify-and-auto-repair (item 2 above) is the same code path, so there's
exactly one "verify then repair" implementation, not two.

### BL items this closes

BL-330 (WAL-safe backup precept as a hard invariant; restore path preserves WAL correctly),
BL-335 (restore's mandatory trailing verify+repair — this is the actual closer, since BL-335's own
acceptance criterion is "bulk-insert N rows... assert integrity_check is clean afterward"), BL-336
(paired repair-time dedupe + the upstream upsert code fix), BL-337 (repair's index-enumeration
approach, generalized into a reusable function instead of a one-off hand-run loop), BL-338 (the
umbrella — automatic startup verify+repair plus the SIGKILL test this design is built to pass).
Partially BL-339 (criterion 3, "read availability verified under sustained backfill load", is
Gap 2's job, not Gap 3's — noted so it isn't double-counted).

### What I would NOT build here

- **No point-in-time recovery / continuous WAL shipping (Litestream-style replication).** That
  solves "restore to any second in the last N days," which is real durability engineering for a
  server serving paying customers, not a single local memory store with periodic backups. Nightly
  (or N-hourly) full snapshots via `backupStore` plus the crash-safety guarantee (WAL survives a
  crash because Turso's WAL already does its job — **MEASURED**, BL-338: "Data survived intact...
  Turso's WAL did its job") is the right-sized durability story. Continuous replication is the
  line the brief asks to hold.
- **No separate backup/restore service or scheduler process.** These are library functions called
  by the existing periodic-tick machinery (Gap 2's background lane) and by explicit CLI/MCP
  invocation — not a new daemon.
- **No generalized "migration framework" (versioned schema migrations, up/down scripts, migration
  history table) beyond what already exists.** `migrateStore` today does one specific job
  (adapter-to-adapter migration); hardening it per the guarantees above is right-sized. Building a
  Rails/Flyway-style migration framework for a store with one schema owner is unnecessary ceremony.

---

## Sequencing, dependencies, and effort

```
Gap 1 (status-surface half; Theme 1 owns invariant impls)
  │
  ├──► Gap 3 (lifecycle ops) ── needs Gap 1's verifyStore/deep-check primitive
  │                              to make backup/restore/repair verifiable at all
  │
  └──► Gap 2 (resource governance) ── needs Gap 1's HealthRegistry cache so that
                                        reads of *health* don't themselves compete
                                        for the contended resource; benefits from
                                        Gap 3's repairStore existing (a governed
                                        background lane is also where repair runs)
```

**Why 1 → 3 → 2 and not 1 → 2 → 3:** Gap 2 (resource governance) is the most speculative of the
three — its root-cause diagnosis is explicitly INFERRED and needs the experiment named in that
section before real design-to-code commitment. Gap 3's design, by contrast, is almost entirely
"wire an already-built primitive (`backupStore`) into paths that don't call it yet, and fix two
narrow, already-diagnosed bugs (`ok` computation, `_adapter_meta` upsert)" — low speculation, high
value, and it's the umbrella requirement (BL-338) the store owner stated most emphatically
("none of this is manual & none of the crash data loss should be possible"). Doing Gap 3 second
also means the SIGKILL crash-safety test (BL-338's acceptance criterion) exists before Gap 2's
concurrency governor gets layered in — so Gap 2 can be validated against a store that's already
proven crash-safe, rather than debugging two new subsystems' interactions at once.

**Effort estimates** (**INFERRED** — no team velocity data exists to measure against; stated as
rough function-of-scope reasoning, not committed numbers):

| Theme | Scope | Rough size |
|---|---|---|
| Gap 1 status surface | `HealthRegistry` map + wiring 6 subsystem checks + extending `memory_ping`/`memory_stats` response shapes | Medium — mostly plumbing existing computed values (BL-320 telemetry, `WriteQueue.metricsForPath`, `adapter.capabilities`) into one new structure; the *new* work is the canary functions (embedding, FTS) and the WAL-unlink structural check |
| Gap 3 lifecycle ops | Turso-native `backupStore` path; new `restoreStore`, `repairStore`, `verifyStore`; hardening `migrateStore`; `adapter-meta.ts` upsert fix; CLI wiring | Medium-Large — five operations, but `backupStore` and the integrity-check primitive already exist; `repairStore`'s index-enumeration logic was already hand-run once during the incident (documented, not designed from scratch) |
| Gap 2 resource governance | `ResourceGovernor` semaphore; per-item yield checks in `healMissingVectors`; replace binary env var with concurrency-range env var | Small-Medium in code, but **gated on the diagnostic experiment** — if the real bottleneck turns out to be the child-process IPC serialization rather than event-loop/lock contention, the fix shape changes (a governed queue in front of `fastembedProcessHost`'s IPC channel, not just a yield check in the caller) |

## Where this depends on Theme 1

Every `red`/`yellow`/`green` verdict in Gap 1's `HealthRegistry`, every `verified` field in Gap
3's lifecycle-op result shape, and Gap 2's `foregroundPressure()` signal all bottom out in
concrete invariant checks (does the FTS canary return the right row, does `integrity_check` come
back clean, is queue latency within budget). This document treats those checks as an already-
designed black box; Theme 1 is where their actual implementation, failure taxonomy, and cost
budget get specified. If Theme 1's harness ends up expensive to run per-check, Gap 1's cadence
table (structural/every-ping, functional/2min-timer, deep/startup-only) is the mitigation this
document is relying on — worth confirming that split survives contact with Theme 1's actual
design.
