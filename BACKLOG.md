# Backlog

Project backlog for sox-ecosystem. Each item: what's wrong, where, severity, and a fix sketch.

---

## Open — surfaced by the write-path observability worktree (2026-07-04)

### BL-174 — `memory_ping` store block hardcodes `last_checkpoint_at: null` despite `WriteQueue.lastCheckpointAtForPath()` existing — **RESOLVED (2026-07-04, c7ae883)**

**Severity: low (health surface lies by omission).** In
`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`, the `memory_ping`
store block sets `last_checkpoint_at: null` as a literal, even though WP-5 shipped
`WriteQueue.lastCheckpointAtForPath(dbPath)` exactly for this field. The ping always reports
`null`, so WAL-checkpoint staleness is invisible to health checks. Discovered while authoring
`docs/plan/runtime-productionization/06-hardening-final/WRITEQ_METRICS_INTEGRATION.md`; not fixed
because memory-server was outside this worktree's file fence (live-incident agent owns it).
**Fix sketch:** `last_checkpoint_at: WriteQueue.lastCheckpointAtForPath(resolvedPath) || null` —
one line, apply together with the BL-175 patch.

### BL-175 — DEFERRAL: apply the WriteQueue metrics → `memory_ping` integration patch at merge — **RESOLVED (2026-07-04, c7ae883: write_queue live in ping, verified on the live store)**

**Severity: task deferral (by fence design, not a bug).** memory-core now exports
`WriteQueue.metricsForPath()` (rolling write-latency p50/p99/mean/max, queue depth, high
watermark, deadline budget, rejection/slow-task counters), but memory-server does not yet expose
it. The exact ready-to-apply patch (one additive `write_queue:` field in the ping store block)
is in `docs/plan/runtime-productionization/06-hardening-final/WRITEQ_METRICS_INTEGRATION.md`.
Integrator applies it after the concurrent live-incident agent finishes in
`memory-server/src/index.ts`, then runs the standard AGENT SEQUENCE + live ping verification.

---

## Open — surfaced during the 2026-07-04 memory-server hot-triage (BL-170 incident)

### BL-172 — organizer_queue had NO live consumer since the RS-6/ADR-0007 refactor: rows orphaned forever, `queue_depth` lied — **RESOLVED (2026-07-04)**

**Severity: high (enrichment-outbox consumption silently dead for ~27h; memory_ping reported
`ok:true` throughout).** Root cause chain, established via read-only SQL on the live store:
- `memory-core/src/write.ts` P2 still enqueues an `ingest` trigger row into `organizer_queue`
  on EVERY write (`enqueueIngest`, write.ts:193).
- The only implementations that ever claim/complete those rows: (a) `MemoryDaemon`
  (`memory-core/src/memoryd.ts`) — runs only in the memory-daemon service, which is
  **intentionally dead** per ADR-0007/BL-162; (b) the RS-4 outbox orchestrator
  (`memory-core/src/outbox-queue.ts` `createMemoryOutboxQueue`/`migrateOutboxQueueSchema`) —
  **defined + spec-tested but wired into NOTHING** (zero non-spec callers repo-wide). The BL-126
  columns (`last_error`, `dead`) were absent from the live store — corroborating that the
  migration-owning consumer never started after `11c2fdc` (RS-4/RS-6, 2026-07-03) deleted the
  memoryds.
- The BL-47 in-process fallback loop (`memory-server/src/index.ts` `runFallbackEnrichPass`)
  DID keep enrichment itself alive (`runBatchEnrich` every 5 min — the actual clustering/
  importance/relates_to work happened) but bypassed the queue: rows never claimed → live store
  showed 29 open `ingest` rows (`claimed_at` NULL, `attempts` 0), `MAX(done_at)` frozen at
  2026-07-03T16:04:53Z, `queue_depth` growing unbounded.
- The user-visible `memory_write` timeouts (~19:13Z) were client-side: the writes actually
  landed (nodes exist for every "failed" uid) during a CPU-contention window (3 backends + the
  synchronous per-item bge embedding at ~0.75s/item); the backend log shows the matching
  `write EPIPE` client disconnects. The WriteQueue was NOT deadlocked — a probe write during
  triage returned an episode_uid promptly, main thread idle in kevent, no BL-154 recurrence.

**Fix:** `runFallbackEnrichPass` now mirrors memoryd's drain semantics — snapshot
`maxOpenEnrichTriggerSeq`, run the pass, then `completeEnrichTriggerRows` (claim + done +
attempts+1) for trigger ops (`ingest`/`enrich`/legacy) only, on success only, synchronously
(no interleave window); `decay`/`reindex` (real work the fallback does not perform) stay open.
Plus the queue-drain health SLO: memory_ping's store block gains additive fields
`queue_oldest_pending_at`, `queue_last_done_at`, and `enrichment: {state: idle|ok|stalled,
oldest_pending_at, last_done_at, stall_threshold_ms}` — stalled when the oldest pending trigger
row exceeds 3× the consumer tick (15 min default, `SOX_ENRICH_STALL_THRESHOLD_MS` override) —
so a dead consumer is machine-visible without SQL forensics. Tests:
`memory-server/src/enrichment-health.spec.ts` (drain semantics, verdict matrix incl. the live
incident shape, ping surface stalled→idle flip). **Remaining seam (not done here to keep file
sets disjoint from the in-flight host-runtime slices):** `soxe status` still shows HEALTHY on
RPC liveness alone — the supervisor health probe should consume `store.enrichment.state` from
memory_ping and render DEGRADED on `stalled` (touch-point: the health-check path in
`libs/host-runtime` + `cmdStatus` in `apps/sox/src/main.ts`).

### BL-173 — worktree smoke/e2e runs contend for the LIVE user singleton backend (`~/.memory` + user data-root UDS) — **Open (HIGH) (2026-07-04)**

Zombie `59405` in the BL-170 incident was
`.claude/worktrees/agent-a6bd315cddfc76ae5/extensions/.../memory-server/dist/index.js` spawned
at 18:56:14Z — exactly matching that worktree's `dist/smoke/run-2026-07-04T18-56-14`. The smoke
test installs into a disposable project scope, but the proxy backend's singleton key derives the
socket from the USER data root (`~/.adhd/sox-ecosystem/run/supervisors/`,
`libs/service-proxy/src/socket-path.ts` — `proxy-8d80bb9bd257.sock` is the fully-hashed
`backendSocketPath` fallback) and the store default is the LIVE `~/.memory/memory.db`. So a
smoke/e2e run from ANY worktree races the production writer for the live socket — under BL-170
(pre-fix) each lost race minted a SIGTERM-immune zombie against the live store. Fix sketch: the
smoke harness (and any e2e that exercises serve/ensure-backend) must inject a scratch data root
(`SOX_DATA_ROOT`/equivalent) AND a scratch `SOX_CONFIG_DB_PATH` so socket + store are both
hermetic; assert in the harness that the derived socket path is under the smoke dir (fail loud
if it would land in the user data root). Related: BL-63 (e2e orphan scan global pgrep) has the
same non-hermetic smell. NOT fixed this session — the worktree is owned by another agent and the
harness change deserves its own gate.

---

## Open — surfaced during Slices 3–4 (continuous supervision, 2026-07-04)

_(BL numbers claimed in a worktree — integrator: renumber on merge if they collide with
concurrently-claimed IDs; BL-171 was referenced by the dispatcher but is absent from this
worktree's BACKLOG.)_

### BL-176 — reconcile pass is not yet the automatic pre-step of `soxe list`/`status` (§10.2 remainder) — **Open (LOW) (2026-07-04)**

Spec §10.2 says the reconcile runs "on every `soxe list`, `soxe status`, `soxe doctor`, and as a
step inside `soxe start`/`stop`". Slice 4 (v1.4.0) delivered the complete, idempotent, schedulable
pass as `soxe doctor --reconcile` (+ the `--install-tick` OS schedule — the continuous half), but
`cmdList`/`cmdStatus` do not yet invoke it as a cheap pre-step (they do their own partial
reconciliation: GC read, pid-liveness, os-unit probes, crash-loop markers). Folding the full pass
in needs a fast-path variant (skip the lsof attribution + per-install scans unless something looks
off) so `list` stays snappy. Fix sketch: extract `doctorReconcile`'s phases 0/3 (GC + split-brain
record heal) into a `quickReconcile()` helper both commands call; leave stray-reaping to the tick.

### BL-177 — `findOrphansByServiceId` env-based matching is INERT on macOS (`ps -o env` unsupported) and spawns one `ps` per process-table entry — **Open (MEDIUM) (2026-07-04)**

Discovered while wiring `doctor --reconcile` (Slice 4) onto the BL-136 matchers: macOS `ps` has no
`env` keyword (`ps: env: keyword not found` — verified live on this box), so `readProcessEnv`
(`libs/host-runtime/src/reaper.ts`) always returns null in production and
`findOrphansByServiceId` silently degrades to argv-token matching — i.e. **cross-BUILD stray
detection by `SOX_SERVICE_ID` does not work on macOS at all** (the BL-136 unit tests pass because
they mock `ps`). Additionally the scan calls `readProcessEnv(p.pid)` for EVERY process in the
table (hundreds of failing `ps` spawns per installed extension per scan) — pure overhead on macOS
and O(N) subprocess cost on Linux. Fix sketch: on darwin use `ps -E -ww -o pid=,command=` (BSD ps
prints the environment appended to the command with `-E`) or `launchctl procinfo`; cache one
whole-table snapshot per scan instead of per-pid spawns; keep the argv fallback. The reconcile
tick (BL-176/Slice 4) still catches the BL-170 zombie class via argv tokens + socket attribution,
so this is a detection-coverage gap for cross-build strays only, not a regression.
**Flake symptom:** the same per-pid `ps` spawn cost makes the two `findOrphansByServiceId`
tests in `libs/host-runtime/src/reaper.spec.ts` (lines ~291/~314, 10s timeout) flaky under
parallel load — they pass standalone (213/213 twice on this box) but timed out during an
`nx affected -t lint,build,test` run with ONNX warmups saturating the machine; nx marks
`host-runtime:test` flaky. Fixing the O(N)-spawn scan fixes the flake.

### BL-179 — root `sox-ecosystem:test` suite MUTATES the live user data root (`~/.adhd/sox-ecosystem/`) — every worktree agent's `nx affected` run re-points the live user-scope installs at its worktree — **Open (HIGH) (2026-07-04)**

**Discovered during the Slices 3–4 gate** (`nx affected -t lint,build,test` from a worktree):
after the run, `~/.adhd/sox-ecosystem/{extensions.lock,install-registry.json,ledger.json,ownership.json}`
had mtime = the test run, and every user-scope `source` (memory-daemon/-server/-flush/-cli/-usage,
demo-creator) pointed at the WORKTREE path. The install-registry history proves this happened
**three times today from three different agents' runs** (18:52Z `agent-ad1f4cf3072c64ba3`, 18:58Z
`agent-a6bd315cddfc76ae5`, 20:20Z `agent-a605b86bb76941c53`) — the same test-isolation gap class
as the smoke-test one found today, in the unit-test tier.

**Mechanism:** the `scripts/*.test.ts` harnesses (install.test.ts, v2-e2e.test.ts, etc.) sandbox the
*explicit* paths they pass (`configPath`/`lockfilePath` into `mkdtemp` dirs) but do NOT set
`SOX_ECOSYSTEM_HOME`, so the install engine's GLOBAL writes (`installRegistryPath()`,
ledger/ownership at `dataRoot('user')`, and user-scope lockfile writes from flows that re-derive
`getScopePaths('user')` internally) land in the REAL data root. `scripts/cli-adapter.test.ts`
spawns the real CLI with plain `process.env` (no sandbox at all).

**Consequences:** (1) the live user scope's sources dangle as soon as a worktree is deleted
post-merge — the next `soxe upgrade`/`serve` resolution can break; (2) cross-test interference:
`cli-adapter.test.ts > details verb > renders requires block` flakes (exit 1) when a parallel test
has the registry/lockfile mid-write — observed in this gate run, passes standalone; (3) any agent
gate run silently rewrites live state, violating worktree isolation fences.

**Further symptoms observed in the same run:** (4) a root test regenerates the TRACKED
`registry/index.json` in-place with checkout-absolute `source` paths — in a worktree that bakes
`…/.claude/worktrees/<agent>/…` into a committable file (reverted via `git checkout` before
committing; the index's absolute-source design makes any non-main checkout's regeneration
poisonous); (5) junk `./badscope/run/` + `./global/run/` dirs appear in the repo root — see BL-180.

**Remediation:** (a) FIX: export a per-run `SOX_ECOSYSTEM_HOME` temp dir in every root-scripts test
harness (or a shared vitest setup file for `sox-ecosystem:test`) so the global data root is
sandboxed like the smoke test's project scope; (b) REPAIR the live box (owner/integrator, after
merges): re-run `soxe install`/`node bin/soxe upgrade --all` from the MAIN checkout to re-point
user-scope sources at durable paths — do NOT hand-edit the lockfile. NOT repaired from this
worktree (live-box mutations are fenced; and the pre-damage state was already another agent's
worktree path, not main).

**Integrator update (2026-07-04, post-S9 merge): the predicted breakage HAPPENED, then repaired.**
After the mutating worktree (`agent-a605b86bb76941c53`) was deleted post-merge, `soxe upgrade --all`
reported **28 UNRESOLVABLE consumers** — every user-scope source (both the main-root user installs
AND the published-CLI root `~/.adhd/sox-cli/lib/node_modules`) pointed at the deleted worktree
(`install: source file not found: …/worktrees/agent-a605b86bb76941c53/…`). Repaired per (b):
`soxe install sox-memory-bundle --scope=project`, `--scope=user`, `demo-creator --scope=user` from
the main checkout → `38 current, 0 failed`; memory-server os-unit stayed HEALTHY throughout. The
(a) FIX (sandbox `SOX_ECOSYSTEM_HOME` in root-test harnesses) remains OPEN and is now
incident-proven urgent, alongside the smoke-hermeticity fix (BL-173).

### BL-185 — `soxe status` renders a loaded, on-schedule PERIODIC os-unit as `DEAD` (violates [inv:list-never-lies]) — **Open (MEDIUM) (2026-07-04)**

Observed immediately after `doctor --install-tick` (Slice 4): `launchctl list` shows
`com.sox.user.doctor-tick` loaded with last-exit 0, and its reconcile log proves interval runs
firing on schedule (`run/logs/doctor-reconcile/doctor-reconcile-2026-07-04.log`) — yet
`soxe status` lists `doctor-tick@os-unit … DEAD, 0s uptime`. A `StartInterval` unit has NO
resident process between runs by design; status's health derivation conflates "no live pid right
now" with DEAD, making the healthy tick look faulty (the same lying-surface class as BL-162's
dead-daemon rendering and today's enrichment blind spot). Fix sketch: os-unit entries whose unit
carries an interval schedule (StartInterval/StartCalendarInterval/systemd timer) should render a
schedule-aware status (e.g. `SCHEDULED (last run <t>, exit 0)`) derived from `launchctl list`
exit status + the unit's own log/marker, not pid-liveness.

### BL-186 — `memory_curate recluster` runs the FULL cluster pass synchronously on the serial WriteQueue and returns a false `enqueued: true` — **RESOLVED (2026-07-04, two-phase-write worktree)**

**Resolution (option (a), designed):** global recluster now enqueues an `enrich` trigger row with
payload `{"full":true,"reason":"memory_curate recluster"}` (`enqueueEnrichFull`, outbox-queue.ts)
and returns `{op:'recluster', enqueued:true, seq}` — honest, because the row is committed before
the return (an insert failure propagates as a tool error, never a false success). The periodic
tick (`runEnrichPassOnDb`) checks `hasPendingFullEnrich(db, maxSeq)` INSIDE its BL-172 snapshot
window and runs `runBatchEnrich({incrementalCluster:false})` when a full-pass row is pending —
full-pass rows enqueued after the snapshot stay open and drive the next tick, so a completed row
always corresponds to a pass that actually honoured it. `hasPendingFullEnrich` deliberately does
NOT filter the BL-126 `dead` column (absent from the base DDL; the paired consumer
`completeEnrichTriggerRows` ignores it too). Justification for queueing over a bounded sync path:
the full pass on a ~3.6k-episode store holds the WriteQueue slot long enough to fast-fail every
write behind it under the deadline backpressure AND risks the recluster call's own MCP timeout;
worst-case added latency is one tick interval (5 min), which is acceptable for an explicitly
batch-shaped operation. Tests: `async-embed.spec.ts` (honest enqueue → row shape → full-pass
tick → one-shot reversion to incremental; dry_run writes no row).

Merge artifact of S9 × BL-172 (integrator review of the merged semantics): S9 switched global
recluster from `enqueueEnrich()` (queued, drained by the periodic tick) to a direct synchronous
`runBatchEnrich(db, {incrementalCluster: false})` inside the tool call (`libs/memory-core/src/
curate.ts:363`) — a correct fix against its branch state (nothing drained the queue there), but on
merged main the consumer exists, so the trade-off is live: (1) a global recluster on a large store
(~3.6k episodes) blocks its MCP call AND every write behind it on the serial WriteQueue for the
full non-incremental pass; under the new time-based backpressure, writes queued behind it can
fast-fail `E_BUSY(deadline)`. (2) The return shape still claims `{op:'recluster', enqueued: true}`
— false; nothing is enqueued ([inv:list-never-lies] family). Fix options: (a) re-route global
recluster through the queue as an `enrich` trigger row (producer exists again as of the S9 merge;
the tick already completes trigger ops) and return `enqueued: true` honestly, with the next-tick
latency documented; or (b) keep it synchronous and fix the return shape to `{ran: true, …stats}`,
documenting the write-blocking cost. Decide at HF-6 alongside the BL-183 outbox-consumer decision
(same design surface).

### BL-187 — SEMANTICS CHANGE: two-phase `memory_write`/`memory_write_batch` — embedding + E8 near-dup now run ASYNC off the WriteQueue slot (kill-switch: `SOX_SYNC_EMBED=1`) — **SHIPPED (2026-07-04, two-phase-write worktree; disclosure entry)**

_(BL numbers 187–189 claimed in a worktree — integrator: renumber on merge if they collide.)_

Owner-directed fix for the 2026-07-04 incident class ("expensive compute must not block writes";
6-item batch timeout at queue depth 29): the write handlers now run a fully SYNCHRONOUS Phase A
(dedup, node insert, FTS, tags/entities, outbox row, non-embed enrichment — `memoryWritePhaseA`)
on the queue slot, and compute the embedding OFF the slot (worker thread) with a short follow-up
queue task inserting `vec_node` + running the deferred near-dup (`embed-pipeline.ts`). Measured:
Phase-A slot time is embed-latency-independent (p50 ~28ms = the SQLite commit, vs ~81ms for the
old path at a simulated 50ms embed). **Caller-visible changes:** (1) `memory_write` responses
carry `enrichment.near_dup: null` (near-dup lands seconds later as SAME_AS edges — documented as
async since v1.1.0); (2) fresh episodes are BM25/temporal-recallable immediately but
vec-recallable only after Phase B (typically <1s); (3) `memory_ping.store` gains additive
`embed_backlog` / `embed_backlog_oldest_at`, folded into the `enrichment` verdict (a dead Phase-B
pipeline reads `stalled`, never silent); (4) crash between phases is healed by the periodic tick
(`healMissingVectors`, bounded 500/pass, mirrors BL-160's reembed recovery). **Rollback:**
`SOX_SYNC_EMBED=1` restores the pre-split synchronous behaviour per-call, no revert needed. The
memory-server spec suite pins the sync path via vitest.setup (existing 92 assertions unchanged);
`async-embed.spec.ts` + `write-pipeline.spec.ts` pin the async default deterministically
(BL-161 seam, gated-provider proof that responses never await the embed).

### BL-188 — `memory_write` MCP handler silently DROPPED `client_request_id` (WP-4 idempotency dead through the tool surface) — **RESOLVED (2026-07-04, two-phase-write worktree)**

Discovered while rewriting the handler for the two-phase split: the single-write and chunked
paths in `memory-server/src/index.ts` never forwarded `args['client_request_id']` to
`memoryWrite`, despite the tool schema documenting WP-4 replay semantics — only
`memory_write_batch` forwarded it. Any MCP client supplying an idempotency key got NO replay
protection (a retry after a timeout minted a duplicate-or-E_DEDUP instead of `replayed:true`).
Fixed by including `client_request_id` in the shared `parentParams` used by both embed modes;
pinned by the `async-embed.spec.ts` replay-through-handler test.

### BL-189 — `memory_update` still embeds INSIDE the WriteQueue slot (same class as the fixed write path) — **Open (LOW-MEDIUM) (2026-07-04)**

The two-phase split covers `memory_write`/`memory_write_batch` (the hot path). `memory_update`
with `content`/`summary` changes still runs its re-embed synchronously inside
`wq.enqueue('memory_update', …)` (`memoryUpdate` → embed on the slot). Low frequency, but under
CPU contention one update can stretch the slot exactly like the old write path. Fix sketch: same
split — update Phase A (columns + FTS + delete stale vec row), Phase B via
`schedulePendingEmbeds` (the machinery now exists and `applyEmbedding` already guards
rowid/uid + double-apply); the heal already covers a crashed update re-embed IF the stale vector
is deleted in Phase A (otherwise the node keeps the OLD vector until Phase B — decide staleness
semantics before implementing).

### BL-180 — `dataRoot()` returns the raw scope string as a PATH for an unknown scope (audit log writes `./badscope/run/sox-audit.jsonl`) — **Open (MEDIUM) (2026-07-04)**

`libs/host-runtime/src/data-paths.ts` `dataRoot()` ends in `default: const _exhaustive: never =
scope; return _exhaustive;` — type-safe at compile time, but at RUNTIME an unvalidated string
(e.g. `soxe install -s badscope`, or `-s global` which is not a scope) falls through and the scope
string itself is returned as the data root. The CLI's audit-log block (`apps/sox/src/main.ts`
`main()`, `dataRoot(flags['scope'] ?? 'user')`) then `mkdir -p`s a RELATIVE `./badscope/run/` in
the caller's cwd and writes `sox-audit.jsonl` there — observed as junk `badscope/` + `global/`
dirs in the repo root after `cli-adapter.test.ts` ran its invalid-scope error-path tests. Any
`soxe` invocation with a bad `--scope` litters the cwd before the verb even validates the scope.
Fix sketch: make `dataRoot` THROW on an unknown scope at runtime (the audit block already
try/catches), or validate the scope before the audit write.

### BL-178 — direct-M3 `soxe serve` durable stderr sink still opt-in (Slice 3 F13 remainder) — **Open (LOW) (2026-07-04)**

Slice 3's F13 item ("live `serve` version's stderr durably captured") remains opt-in for
DIRECT-stdio serves (`--log` / `SOX_SERVE_LOG=1`, BL-46). M4 units default durable
`StandardOutPath`/`StandardErrorPath` (Slice 2 §9.2) and proxy backends log via `stderrLogPath`
(BL-139), so the gap is only the direct/opt-out serve path. Flipping the default is a
client-visible behaviour change on every MCP spawn and `cmdServe` is under concurrent BL-170/
BL-157 hardening — deferred deliberately (documented in the spec v1.4.0 changelog + §14 Slice 3).
Fix sketch: default the tee ON with `--no-log`/`SOX_SERVE_LOG=0` opt-out once the serve-path work
lands.

---
## Open — surfaced during S9/BL-162 memory-daemon removal (2026-07-04)

### BL-181 — `tools/test-e2e-lifecycle.js` Slice 1 + Section E hardcode `memory-daemon` as their real-service fixture; now broken by BL-162's removal — **Open (HIGH) (2026-07-04)**

`host-runtime:test-e2e` (`libs/host-runtime/project.json` `test-e2e` target, runs
`tools/test-e2e-lifecycle.js`) is NOT part of the standard `nx test`/`nx affected -t test` gate —
it's a separate opt-in target — so it was not caught by this shard's required gate. But it WILL
fail the next time anyone runs it, because two large regression sections use the now-deleted
`extensions/bundles/sox-memory-bundle/members/memory-daemon` as their concrete fixture:
- **"Step 7c: Slice 1 — cross-scope singleton"** (~line 1084-1192): spawns a live daemon process
  from `memory-daemon/dist/index.js` and asserts the §5.2 singleton guard refuses a second spawn
  when two scopes share `db_path`. Line 1104 already asserts
  `fs.existsSync(DAEMON_ENTRY)` and will now fail loudly with a clear message rather than silently
  skip — but the underlying coverage (cross-scope singleton guard) is lost.
- **"Section E: SERVICE-STORE COPY + SPAWN — BL-37 regression gate"** (~line 1649-1780): verifies a
  `type:service` extension's self-contained esbuild bundle survives the declarative-install copy +
  real spawn with native addons (better-sqlite3, sqlite-vec) resolvable via NODE_PATH — the exact
  regression BL-37 fixed. `memory-daemon` was the real extension used to prove this end-to-end.
**Fix:** repoint both sections at a different real `type:service` extension with the same shape
(background:true, singleton:true, native-addon deps) — `tokenguard` is the only other real service
extension in the registry and is a good candidate — or author a small dedicated fixture service
extension whose sole purpose is exercising these two regression gates. Deliberately NOT fixed by S9
itself: this touches live daemon-process spawning/singleton-guard mechanics, which S9's dispatch
explicitly fenced off ("do NOT touch libs/service-proxy/, apps/sox/src/main.ts serve/upgrade paths,
or any live running process — S8 handles live backend reconciliation"), and a proper fix means
picking/building a replacement fixture, not a mechanical rename. Run
`node tools/test-e2e-lifecycle.js` after re-pointing to confirm both sections pass.

### BL-182 — `memory-flush`'s `nudgeDaemon()`/`SOCKET_PATH` are now permanently-dead code (BL-162 follow-up) — **Open (LOW) (2026-07-04)**

`extensions/bundles/sox-memory-bundle/members/memory-flush/src/index.ts` defines its own local
`SOCKET_PATH` (`~/.memory/memoryd.sock`) and calls `nudgeDaemon()` at the end of every
`handleSessionEnd` (step 3, "Nudge memoryd"). Since BL-162 deleted the entire `memory-daemon`
package (including `libs/memory-core/src/memoryd.ts`'s `MemoryDaemon` class — nothing will ever
bind that socket again), this call is now unconditionally a no-op: it opens a Unix socket
connection that always hits `ECONNREFUSED`/ENOENT, swallowed by the existing `client.on('error', ...)`
handler. Harmless today (batch enrichment already runs via memory-server's in-process periodic
loop, independent of this nudge), but it's a dangling reference to a daemon that no longer exists
and should be deleted rather than left as inert dead code. **Not fixed in S9** because
`memory-flush` was not in S9's confirmed exact-scope file list and this is a separate member with
its own test suite (`memory-flush:test`) that a change here would need to keep green — low risk,
quick fix, but deliberately left for a follow-up pass to keep S9's diff scoped to its assigned
files. Fix: delete `SOCKET_PATH`, `nudgeDaemon()`, and its call site; update the file's header
comment (currently: "nudges memoryd" in the SessionEnd bullet list) and `handleSessionEnd`'s
JSDoc (step 3 "Nudge memoryd to wake and process the queue").

### BL-183 — `libs/memory-core/src/outbox-queue.ts` (`createMemoryOutboxQueue`/`memoryFlush`) is fully unwired scaffolding — **Open (MEDIUM) (2026-07-04)**

Discovered while verifying BL-162's in-process-enrichment claim: `outbox-queue.ts` (220 LOC,
RS-4/RS-5 per `docs/plan/runtime-productionization/02-reusable-subsystems/progress.json`) and its
399-line spec are real, tested, dead-letter-aware implementations of a transactional-outbox drain
over the SAME `organizer_queue` table `memory-daemon`'s deleted `MemoryDaemon` class used — but
`createMemoryOutboxQueue`/`memoryFlush` have ZERO consumers anywhere outside their own spec file
(confirmed by repo-wide grep). Batch enrichment in production actually runs via a completely
different, simpler path: memory-server's in-process periodic `runBatchEnrich` loop
(`extensions/.../memory-server/src/index.ts`), which never touches `organizer_queue` at all. So
`progress.json`'s RS-4/RS-5 "complete" status describes a built-but-never-integrated subsystem.
Decide: (A) wire `createMemoryOutboxQueue`/`memoryFlush` into memory-server's write/enrich path as
the intended real drain mechanism (more durable — dead-letter tracking, watermark-based
read-your-writes for `memory_flush`-style callers) and retire the simpler periodic loop, or (B)
delete `outbox-queue.ts` + its spec as unintegrated scaffolding superseded by the simpler periodic
loop that's actually running in production today. Not decided or fixed here — out of BL-162's
scope (BL-162 is specifically about removing the daemon, not about which enrichment-drain design
wins); flagging so it doesn't silently rot further.

**Integrator update at S9 merge (2026-07-04): PARTIALLY STALE.** Written before the BL-172
incident fix landed on main: the periodic loop DOES now touch `organizer_queue` (it snapshots
`maxOpenEnrichTriggerSeq` → runs the pass → `completeEnrichTriggerRows`), the queue's
presence/age drives memory_ping's `enrichment` stall verdict, and at this merge the producer
was restored as `outbox-queue.ts#enqueueIngest` (called from `write.ts`, transactional with the
node insert) — so outbox-queue.ts now carries live production code. Still open from the
original finding: `createMemoryOutboxQueue`/`memoryFlush` themselves (the dead-letter dequeue
consumer + watermark flush) remain consumer-less — the (A)/(B) decision above still stands for
THAT surface, folded into HF-6 closeout review with BL-127's read-your-derived-writes contract.

### BL-184 — `docs/plan/runtime-productionization/02-reusable-subsystems/progress.json` RS-6 claims file deletions that were not actually present — **Open (LOW) (2026-07-04)**

`progress.json`'s RS-6 entry (`"status": "complete"`) lists `files_deleted` including
`extensions/bundles/sox-memory-bundle/members/memory-server/src/memoryd.ts`,
`.../memory-server/src/bin.ts`, and `libs/memory-core/src/memoryd.ts` — but as of S9's start
(2026-07-04) all three files were still present and live (bin.ts/memoryd.ts in memory-server were
confirmed dead/unreferenced by the actual build — `package.json`'s `main`/`exports` and
`project.json`'s build target only ever pointed at `src/index.ts` — but they had not been deleted
as RS-6 claims). `libs/memory-core/src/memoryd.ts` was very much alive: imported by
`write.ts` (`enqueueIngest`/`nudgeDaemon`, called on every `memory_write`) and `curate.ts`
(`enqueueEnrich`, called on every global `memory_curate recluster`). S9 has now actually deleted
all three plus `memory-daemon/src/memoryd.ts` and `libs/memory-core/src/memoryd-retry.spec.ts`,
and removed the `write.ts`/`curate.ts` call sites (`curate.ts`'s global recluster now calls
`runBatchEnrich` in-process instead of the now-deleted `enqueueEnrich`). This is a process-integrity
gap (a "complete" status was recorded without the described side effects actually landing) worth
a sweep during HF-6 closeout's BACKLOG/progress reconciliation pass — not fixed here since
reconciling historical progress-tracking JSON is that closeout's job, not this shard's.

### BL-162 — remove the obsolete `memory-daemon` extension (superseded by ADR-0007 in-process enrichment) — **FIXED (2026-07-04, S9)**

**Owner directive: fix/remove, do not leave "deprecated."** ADR-0007's single-writer architecture
moved batch enrichment IN-PROCESS into the memory-server writer backend, making the `memory-daemon`
extension dead code. Today `soxe status` shows it as `DEAD`/`not-started` alongside healthy
services (implying a fault). With a single consumer there is no reason to carry a deprecated shell —
remove it cleanly: delete the bundle member + its manifest wiring, drop it from `registry/index.json`
+ the smoke-test surface (`scripts/smoke-test.mjs` currently lists it as testable), and remove any
references. Verify enrichment still runs in-process (memory_stats cluster coverage) after removal.
Publishing the resulting bundle-major bump to npm is the owner's step (ADR-0007); the source removal
+ local registry is the agent's. Sequenced after S4 (which touches the same bundle's `memory-cli`).

**Fix (evidence):**
- Deleted `extensions/bundles/sox-memory-bundle/members/memory-daemon/` (whole directory: manifest,
  project.json, package.json, src/{bin,index,memoryd,schema}.ts, tsconfig.json).
- Deleted the orphaned dead-code twins that were never actually removed by the earlier (falsely
  "complete") RS-6 pass (see BL-184): `extensions/bundles/sox-memory-bundle/members/memory-server/
  src/{bin.ts,memoryd.ts}` (unreferenced by memory-server's real build — confirmed via
  `package.json` main/exports + `project.json` build target, both point only at `src/index.ts`) and
  `libs/memory-core/src/memoryd.ts` + `libs/memory-core/src/memoryd-retry.spec.ts` (the canonical
  `MemoryDaemon` class — genuinely dead now that nothing spawns it).
- `extensions/bundles/sox-memory-bundle/extension.json`: removed `{ "id": "memory-daemon" }` from
  `members`; updated description.
- `registry/index.json`: regenerated via `npx nx run registry:sync-index` (15 entries; no
  `memory-daemon` entry; bundle's `members` array now `[memory-server, memory-flush, memory-cli,
  memory-usage]`).
- `libs/memory-core/src/write.ts`: removed `enqueueIngest`/`nudgeDaemon` import + call sites, and
  the now-fully-dead `scope` field from `WriteParams`/`BatchItem` (it existed solely to compute the
  deleted daemon-queue's priority — confirmed zero other consumers and not part of the actual
  exposed `memory_write` MCP tool input schema).
- `libs/memory-core/src/curate.ts`: global `memory_curate recluster` (non-dry-run) now calls
  `runBatchEnrich(db, { incrementalCluster: false })` in-process instead of the deleted
  `enqueueEnrich` — this was actually a **latent bug fix**: the old `enqueueEnrich` enqueued into
  `organizer_queue`, which nothing has drained since `memory-daemon` went `DEAD`/inactive in
  production, so global recluster was silently a no-op before this fix.
- `libs/memory-core/src/index.ts`, `extensions.ts`, `enrich-batch.ts`: removed the `memoryd.js`
  re-export and updated stale comments describing the daemon-queue architecture.
- `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`: removed `SOCKET_PATH`
  import + `isDaemonReachable()` daemon-socket probe; the periodic in-process enrichment loop
  (`runFallbackEnrichPass` → renamed `runPeriodicEnrichPass`) is now unconditional (previously it
  skipped its pass if a daemon socket answered — there is no daemon to answer anymore). Updated the
  `memory_write`/`memory_curate` tool descriptions sent to MCP clients.
- `libs/host-runtime/src/runtime.ts`, `os-unit.ts`: updated illustrative `memory-daemon` example
  comments to `tokenguard`/generic examples (no functional change — these were never coupled to the
  deleted package). Left `os-unit.spec.ts`/`singleton.spec.ts`'s use of `'memory-daemon'` as a
  fixture *string* untouched per the dispatch's explicit guidance — purely generic example
  extension ids with no coupling to the deleted package's code, not "memory-daemon-specific".
- `scripts/v2-e2e.test.ts`: bundle-members assertion `toHaveLength(5)` → `toHaveLength(4)`.
- `extensions/bundles/sox-memory-bundle/members/memory-server/recall-sqlite.test.ts`: removed the
  BL-47 daemon-socket-probe test (no daemon concept left to probe) and its now-unused
  `SOCKET_PATH`/`net` imports; kept + retitled the in-process `runBatchEnrich` regression test.
- Docs updated to stop describing the removed daemon as current architecture: root `AGENTS.md`
  (smoke-test single-extension example), `CONTRIBUTING.md` (service-extension examples, ×3),
  `extensions/bundles/sox-memory-bundle/{README.md,members/memory-server/{README.md,CLAUDE.md},
  members/memory-usage/SKILL.md}`, and the installed dev-scope mirror at
  `.claude/skills/memory-usage/SKILL.md`. Deliberately did NOT touch `docs/decisions/0007-*.md`
  (ADR flip to ACCEPTED is HF-6 closeout's job), `docs/spec/service-lifecycle.md` /
  `docs/guidelines/*.md` (illustrative examples across many files — a dedicated docs sweep, not a
  5-minute fix), `.opencode/agents/{implement,flash}.md` (shared cross-host agent-infra prompts,
  uncertain ownership), or any `docs/plan/**` historical planning artifact / CHANGELOG.md (frozen
  point-in-time records — editing them would be revisionist).
- Also fixed root `vitest.config.ts`: added the same `testTimeout`/`hookTimeout: 30_000` that
  `memory-server`'s own vitest config already carries for fastembed ONNX warmup — the root
  aggregate runner double-covers `extensions/**/*.test.ts` (incl. `recall-sqlite.test.ts`) but
  lacked the override, so it deterministically timed out at the default 5s on first `embed()` call.
  Unrelated to memory-daemon but discovered and fixed while gating this change (see verification).

**Verification:**
- `npx nx build/lint/test` clean for `host-runtime`, `memory-core`, `memory-server` (see PR/report
  for exact counts). `memory-server:test`'s one observed failure was the pre-existing, already-
  tracked BL-161 fastembed-parallel-worker flake (confirmed via git diff tracing + a clean re-run
  passing 81/81 + Nx's own flaky-task detector concurring) — not a regression from this change.
- `rm -rf dist/smoke && node scripts/smoke-test.mjs` → `2 testable: tokenguard, memory-server` (no
  `memory-daemon`) → `13 passed, 0 failed, 0 skipped`.
- `npx nx affected -t lint,build,test` clean after the vitest.config.ts timeout fix above.
- In-process enrichment confirmed still running with zero daemon dependency: `memory-server`'s
  periodic loop and `memory_curate recluster`'s global path both call `runBatchEnrich` directly;
  `recall-sqlite.test.ts`'s in-process `runBatchEnrich` regression test passes.

**Not fixed (see BL-181/182/183/184 above):** `tools/test-e2e-lifecycle.js`'s Slice 1 + Section E
fixtures, `memory-flush`'s dead nudge call, `outbox-queue.ts`'s unwired scaffolding, and
`progress.json`'s stale RS-6 claim.

## Open — surfaced during S7/BL-161 memory-core test speed-up (2026-07-04)

### BL-167 — recall.ts ScoreBreakdown invariant violated for zero-normTotal ranked nodes (HF-3 follow-up) — **Open (LOW) (2026-07-04)**

_(Renumbered from a duplicate BL-162 introduced by the S7 agent; the memory-daemon item keeps BL-162.)_
Follow-up to HF-3 (BL-132) recall score legibility.

**Severity: low (incorrect score_breakdown.vec/bm25/temporal values; total === score is correct).**

In `libs/memory-core/src/recall.ts` lines 526–532, the code decomposes `finalScore`
into per-channel contributions using normalised weights. When a node appears in only
one channel AND has the lowest value in that channel, `minMaxNorm` returns 0 for that
node (min-max maps the minimum to 0). Then `normTotal = vecNorm + ftsNorm + tempNorm = 0`,
the `if (normTotal > 0)` branch does not run, all contributions are 0, but
`total = finalScore > 0`. The invariant `vec + bm25 + temporal === total` is violated.

**Comment at line 61** (`vec + bm25 + temporal === total === score`) is incorrect for
this edge case. The stable invariant is only `total === score`.

**Impact:** `score_breakdown.vec/bm25/temporal` show 0/0/0 for the lowest-ranked
candidate in a single-channel recall scenario. The `total` field is always correct.
Downstream displays using per-channel breakdown will show wrong attribution.

**Fix sketch:** Change the `if (normTotal > 0)` fallback to assign `total` proportionally
among whichever raw channels were non-zero (e.g. split by raw rrf values instead of
normalised), or document that channels are undefined when normTotal=0 and `total === score`
is the only invariant.

**Found:** during S7/BL-161 test threshold re-tuning. Tests adjusted to document the edge case.

---

## Open — build-tooling / module-resolution debt (2026-07-04)

### BL-168 — DEBT: audit the recurring module-resolution / bundling / workspace-tooling class of bugs — **Open (HIGH) (2026-07-04)**

The same class of problem keeps recurring, each fixed point-wise. We keep paying for it. Audit them
together and establish ONE consistent, documented standard for module resolution + bundling +
workspace tooling so these stop happening. The recurring instances so far:
- **`import.meta.url` in CJS bundles** (BL-155) — esbuild sets `import.meta={}` for cjs output →
  `fileURLToPath(import.meta.url)` throws; crash-looped the daemon. Fixed with a bundler shim.
- **Sibling-worker path resolution** — `join(__dirname/import.meta.url, 'embedWorker.js')` resolves
  differently across src vs dist vs bundle. Broke the memory-core real-bge test (aliased to src →
  `src/embedWorker.js` missing; BL-161 follow-up) AND is latent-broken in the hybrid-search
  cross-encoder (BL-166: `../../../../embed/.../dist/embedWorker.js` won't resolve in a bundle).
- **Vite/vitest can't resolve the ESM-only `exports` map** of the data packages → needed a manual
  `resolve.alias` to a concrete file in every consumer's vitest config (memory-core, memory-server).
- **`@nx/enforce-module-boundaries` false positives** — `require.resolve('<pkg>')` for a path is
  flagged as a "lazy load", forbidding legitimate static value imports (cross-encoder.ts, and the
  memory-server index.ts type-import). Fixed with line-scoped disables — a smell.
- **Loose `.mjs` scripts outside the nx graph** silently rot + create lint circular-deps + hide behind
  the nx cache (BL-159/BL-160 reembed, BL-164 baseline scripts).
- **pnpm `onlyBuiltDependencies` gap** — `onnxruntime-node`'s build script isn't approved, so a
  clean-room reinstall leaves it unbuilt (relied on prebuilt binaries; fragile).
- **Workspace linking / worktree churn** — worktree agents' installs unlinked `node_modules/nx`,
  needing a clean-room reinstall mid-session (also see BL-150).

**Deliverable:** a short "module resolution & bundling standard" doc + fixes: pick one bundler-safe
`__dirname`/asset-path pattern for code consumed in CJS bundles; make the data packages' `exports`
maps vite-resolvable (dual `import`/`require` conditions) so consumers don't each need an alias hack;
resolve the module-boundary false positives properly (not per-line disables); bring all loose `.mjs`
into the graph (BL-160/BL-164); add `onnxruntime-node` (and any other native dep) to the pnpm
build-approval allowlist. Root-cause once, not seven times.

### BL-169 — stray `--extension/` dir from unguarded smoke-test arg parsing — **RESOLVED (2026-07-04)**

A `--extension/dist/smoke/run-2026-06-30…/` dir sat at the repo root. Origin: `scripts/smoke-test.mjs`
read `--root`'s value as `ARGV[indexOf('--root')+1]` with no guard, so a `--root --extension memory-daemon`
invocation (or `--root` with no value) treated the flag `--extension` as the root path and wrote smoke
output to `./--extension/…`. Fixed: added a `flagValue()` guard that rejects a missing value or a value
starting with `-` (exit 2). Removed the stray dir.

---

## Open — surfaced during BL-145 live launchd re-enable (2026-07-04)

### BL-155 — CRITICAL: esbuild CJS extension bundle breaks `import.meta.url` → embedding provider dead → daemon crash-loop — **RESOLVED (2026-07-04)**

**Severity: critical (any bundled extension using `import.meta.url` crashes at init).**
`libs/data/embed/embedding-provider/src/fastembed.ts:7` computes
`const __dirname = dirname(fileURLToPath(import.meta.url))` to locate its sibling
`embedWorker.js`. The memory-server bundle is **CJS** (`tools/bundle-extension.cjs`,
`format: 'cjs'`), and esbuild replaces `import.meta` with `{}` in CJS output — so
`import.meta.url` is `undefined` and `fileURLToPath(undefined)` throws
`The "path" argument must be of type string or an instance of URL. Received undefined`
at module init. This killed `warmupEmbed()` at daemon startup, so the launchd unit
**crash-looped** (`[memory-server] FATAL: … embedding warmup failed`).

Masked in CI because vitest loads the provider's own **tsc dist** (real ESM, where
`import.meta.url` is defined), never the esbuild CJS bundle. Only the live daemon (and
any bundled deployment) hit it.

Fix: `tools/bundle-extension.cjs` now injects an `import.meta.url` shim for CJS output —
`banner: const __soxImportMetaUrl = require('url').pathToFileURL(__filename).href` +
`define: { 'import.meta.url': '__soxImportMetaUrl' }`. This points `import.meta.url` at
the bundle's own file, so `__dirname`-style sibling resolution finds
`dist/embedWorker.js`. Verified: rebuilt bundle, daemon boots with
`[memory-server] embeddings: real model active (bge-base-en-v1.5)` and stays up.

### BL-156 — os-unit generator ignored `serve_mode: proxy` (persistent daemon ran direct-stdio, unreachable) — **RESOLVED (generator) (2026-07-04)**

`soxe service enable memory-server --scope=user` generated a launchd unit whose
`ProgramArguments` was `[node, --enable-source-maps, dist/index.js]` — the raw entrypoint.
But memory-server declares `serve_mode: "proxy"`, `serves: ["stdio","sse","http"]`, and the
unit env carries `SOX_CONFIG_PORT=3099`. Running `node index.js` directly lands in
DIRECT-STDIO mode (`index.js:1688`), which listens on nothing — so the daemon warmed the
ONNX model and idled with no reachable transport.

Fix: `os-unit.ts` gained an optional `execArgs` (the args after `nodePath`); the launchd/
systemd renderers use it when present, else the direct-service default `[...nodeArgs,
entrypoint]`. `resolveOsUnitContext` (`apps/sox/src/main.ts`) now, for a proxy-mode
mcp-server with a configured `SOX_CONFIG_PORT`, sets
`execArgs = [--enable-source-maps, <cli>, serve, <id>, --port, <port>]` so the unit runs the
port-listening front-shim (which auto-ensures the singleton UDS backend). `entrypoint`
stays the reaper's BL-31 identity token (the BACKEND runs it under `SOX_PROXY_BACKEND=1`).
Verified: re-enabled unit's plist runs `soxe serve memory-server --port 3099`, **:3099
listens**, a fresh backend spawns reporting `real model active (bge-base-en-v1.5)`; os-unit
spec test + smoke 16/0. **End-to-end HTTP still blocked by BL-157/BL-158 below.**

### BL-157 — `soxe serve --port` headless HTTP transport returns `proxy closed`; shim→backend UDS unstable under launchd — **RESOLVED (2026-07-04)**

**Root cause (exact mechanism):** in `libs/service-proxy/src/shim.ts` `runFrontShim`, the
`input.on('end')` / `input.on('error')` handlers unconditionally called `backend.close()` +
resolved `done` when the stdio-client pipe closed. Under launchd `stdin=/dev/null` EOFs
**immediately at startup**, so the backend connection was torn down the instant the shim
booted — before any HTTP request. `dialBackend.close()` sets `closed=true` and thereafter
every `send()` resolves synchronously with `errorResponse(..., -32001, 'proxy closed')`
(`dial.ts:249-252`). The HTTP listener stayed bound but its shared backend connection was
dead, so every HTTP `initialize`/`tools/call` returned `{"code":-32001,"message":"proxy
closed"}`. The `write EPIPE` in the backend log was the backend seeing the shim's socket
close. HTTP transport availability was wrongly coupled to stdio-client presence (§9.5.2 says
they MUST be independent).

**Fix:** decouple. When `httpPort` is set (`httpActive`), the stdio pipe ending no longer
closes the backend or resolves `done` — the HTTP server + its backend connection own their own
lifecycle; the process exits via `cmdServe`'s SIGTERM handler. Pure stdio-client mode (no
`httpPort`) is UNCHANGED — pipe-end still tears down the backend, preserving the S1.5/S1.6
zero-downtime stdio guarantees (re-dial+backoff+buffer, schema-hash handshake). +2 regression
tests in `shim.spec.ts` pin both behaviours. Proven on a scratch store AND against the live
launchd unit `:3099`: `initialize` + `tools/call memory_ping` now succeed, routing through the
fixed os-unit shim to the singleton backend, no `proxy closed`.

**Live reconcile:** the split-brain (two backends `43731`+`43740` for `~/.memory`) was healed —
`43740` was an orphan (init-parented, NO socket bound, zero clients; it lost the O_EXCL bind
race but did not exit) and was reaped (SIGTERM ignored → SIGKILL escalation per
`[contract:signal]`). The live writer backend `43731` (owns the socket, serves the session
shims) was left untouched. The os-unit launchd shim (`10066`, old code, 0 backend connections)
was restarted via `launchctl kickstart -k gui/<uid>/com.sox.user.memory-server` → new pid
`93280` running the fixed shim; `soxe status` shows `memory-server@os-unit HEALTHY`; exactly ONE
backend remains. Session shims never disrupted (they re-dial the singleton backend by design).

### BL-170 — `ensureBackend` O_EXCL-lock LOSER leaves an orphaned backend zombie (recurring split-brain) — **RESOLVED (2026-07-04)**

**Fix (landed with the 2026-07-04 hot-triage):** `runBackend`
(`extensions/bundles/sox-memory-bundle/members/memory-server/src/backend.ts`) now
(1) catches ANY `serveBackend` rejection (`E_LIVE_SOCKET` from the SA-4 probe AND the raw
`EADDRINUSE` race variant — both observed in the live backend log), writes a stderr FATAL
diagnostic (`[inv:no-stdout-diagnostics]`), and exits 1 via an injectable `exit` seam — a losing
singleton racer dies loudly instead of idling; and (2) wires SIGTERM/SIGINT handlers BEFORE the
async bind, so even a backend stuck pre-bind honours `[contract:signal]` (the observed zombies
ignored SIGTERM because handlers were only wired post-bind). The `index.ts` call site's
`void runBackend(...)` gained a defensive `.catch()` → stderr + `process.exit(1)` (Node's default
unhandled-rejection crash is not reliable here: the embed worker thread outlives it when stdio is
a dead pipe). Regression test `[BL-170]` in `memory-server/src/backend.spec.ts` proves the loser
exits 1 with the diagnostic while the winner keeps serving.

**Incident timeline (2026-07-04):** another agent's `memory_write_batch` timed out ~19:13Z;
triage found THREE backends for the one `~/.memory` singleton: writer `12625` (db+socket, 11
session-shim clients) plus zombies `14235` (main-repo dist, spawned 18:51Z) and `59405`
(spawned 18:56Z from the `agent-a6bd315cddfc76ae5` worktree's dist — see BL-173). Both zombies:
zero db/socket fds, stdio = dead socketpairs (`->(none)`), SIGTERM ignored → SIGKILL reap
(owner-authorized) at ~19:33Z. Writer + shims untouched; single writer verified via lsof after.
The backend log carried both loser shapes: an `E_LIVE_SOCKET` unhandled-rejection crash AND an
`EADDRINUSE` crash — plus the two silent idlers. The write "stall" itself was a separate
mechanism — see BL-172.

**Discovered while fixing BL-157** — it is the ROOT of the "two backends for one store" split-brain
BL-157 noted. When the singleton writer backend for a store dies, multiple session shims' `ensure`
hooks race to respawn it. The lock winner takes the O_EXCL lock + binds the UDS. A racer that
spawned a backend which then loses the bind hits `E_LIVE_SOCKET` in `serveBackend`
(`backend.ts` probe-before-bind correctly REFUSES a live socket) — **but that backend process does
NOT exit.** It idles orphaned: `ppid=1`, 0 socket fds, ONNX model loaded, 0 clients. Observed
TWICE on the live box during S8: original orphan `43740` beside writer `43731`; then it RE-FORMED
(`6604` beside `6595`) minutes after the first reap, when the original writer exited and two shims
raced. These orphans also **ignore SIGTERM** (had to SIGKILL) because they never finished init to
wire their `[contract:signal]` handler.

Two sub-fixes: (1) `runBackend` (`extensions/bundles/sox-memory-bundle/members/memory-server/src/
backend.ts`) must `process.exit(non-zero)` when `serveBackend` rejects with `E_LIVE_SOCKET` — a
losing racer MUST die, not idle, so the singleton invariant self-heals; and/or harden
`ensureBackend` (`libs/service-proxy/src/ensure-backend.ts`) so the spawn path that detects a
live socket post-spawn kills its own just-spawned child. (2) Ensure a SIGTERM-drain path exists
even for a backend stuck pre-bind. Until fixed, split-brain re-forms on every writer-death race
and needs a manual orphan reap. NOT fixed in the BL-157 change (that was the shim stdio/HTTP
coupling; this is the backend spawn-race). Also mirrors the never-reaped-orphan class of BL-31/BL-64.

### BL-158 — live store's `sox_store_meta.embed_model` stamp was stale (`…-hash`) though vectors are real bge — **RESOLVED (2026-07-04)**

**Downgraded from HIGH after verification, then fixed.** With owner approval, corrected the one
stale row: `UPDATE sox_store_meta SET value='bge-base-en-v1.5' WHERE key='embed_model'` (1 row).
`sox_store_meta`, `memory_scope`, and the `vec_node` vectors now all agree on bge — the
misleading startup warning will not recur. NOT a data problem, and NO reembed was needed.
The backend startup warning (`store was stamped … "nomic-embed-text-v1.5-hash" but runtime
has "bge-base-en-v1.5"`) is misleading. Ground-truth checks on `~/.memory/memory.db`:
- Recall **works**: a query for a known-present topic ("LanceDB concurrent write errors…")
  returns the exact LanceDB memory as the #1 hit via `provenance:["vec","fts"]` — the vec
  channel matches, so the vectors ARE in the current bge space. (An earlier "writer lease"
  query scored ~0.004 only because that topic isn't in this graph store — it lives in file
  memory — not because embeddings are broken.)
- `vec_node` holds 2597 real bge vectors; `memory_scope.embed_model = bge-base-en-v1.5` ✓.
- Only `sox_store_meta.embed_model` is stale = `nomic-embed-text-v1.5-hash` (never updated
  when the store was migrated to bge). `memory reembed --force` correctly reports
  **0 nodes to migrate** — the data is already bge.

Residual fix is a **one-row metadata reconciliation**:
`UPDATE sox_store_meta SET value='bge-base-en-v1.5' WHERE key='embed_model'` — to silence the
false warning and make `memory_ping`/`memory_stats` honest ([inv:list-never-lies]). It is a
direct live-store write (auto-mode classifier gated it) → needs owner OK or a sanctioned CLI
path. Cosmetic; does not affect recall. (Minor: `memory reembed --dry-run` fix: the prior dry-run
created an empty `vec_bge_base_en_v1_5` space — fixed in BL-160.)

### BL-161 — fastembed test warmup: model reloads per test-worker + on singleton reset → flaky 30s timeout — **Open (MEDIUM) (2026-07-04)**

Recurring flaky timeout in `memory-core` (`write.spec.ts` "batch of 10 items…", surfaced again
during S1). Root causes (NOT that tests can't be event-driven — the warmup IS async/awaited):
1. **Per-worker reload.** vitest's default `forks` pool runs each spec FILE in its own process,
   so bge-base-en-v1.5 ONNX re-loads once per file. The provider is a module singleton
   (`embed.ts _provider`) shared WITHIN a process, but not across worker processes.
2. **Singleton resets.** `embed.spec.ts`/`recall-sqlite.test.ts` call `_resetEmbedSingleton()` in
   hooks, tearing down the FastembedProvider worker thread → reload within a file too.
3. **Contention, not slowness.** Cached bge init + first inference is ~5–12s single-process; 30s is
   the TIMEOUT, not the warmup. Many forks warming at once contend for CPU/RAM → any one crosses 30s.
Fix (after S2/S4 land, to avoid vitest-config merge churn): (a) stop resetting the singleton in
hooks that don't need it → warm once per process; (b) pin embed-heavy specs to a single worker
(`poolOptions.forks.singleFork` or a dedicated vitest project); (c) biggest win — a lightweight
test-embed seam (small/stub content-dependent vectors) for tests that only need "a vector,"
reserving real bge for the 1–2 semantic-quality assertions.

### BL-162 — remove the obsolete `memory-daemon` extension (superseded by ADR-0007 in-process enrichment) — **Open (MEDIUM) (2026-07-04)**

**Owner directive: fix/remove, do not leave "deprecated."** ADR-0007's single-writer architecture
moved batch enrichment IN-PROCESS into the memory-server writer backend, making the `memory-daemon`
extension dead code. Today `soxe status` shows it as `DEAD`/`not-started` alongside healthy
services (implying a fault). With a single consumer there is no reason to carry a deprecated shell —
remove it cleanly: delete the bundle member + its manifest wiring, drop it from `registry/index.json`
+ the smoke-test surface (`scripts/smoke-test.mjs` currently lists it as testable), and remove any
references. Verify enrichment still runs in-process (memory_stats cluster coverage) after removal.
Publishing the resulting bundle-major bump to npm is the owner's step (ADR-0007); the source removal
+ local registry is the agent's. Sequenced after S4 (which touches the same bundle's `memory-cli`).

### BL-163 — FEATURE: generalized always-on-service login-items registration with a controllable name (SMAppService) — **Open (FEATURE, blocked on signing) (2026-07-04)**

A genuine future feature (legitimately backlogged — needs a prerequisite we don't have yet: a
code-signing identity). Today a user LaunchAgent with `RunAtLoad` already starts at login, but its
name in macOS System Settings → Login Items is derived from the code SIGNATURE, not the plist — so
an unsigned `node` LaunchAgent cannot present a friendly name (e.g. "Sox Memory"). Generalize the
os-unit layer so ANY always-on service can opt into a proper Login-Items entry with a controllable
display name via `SMAppService` (macOS 13+) registering a **signed** helper. Design so it is not
memory-server-specific: a manifest `display_name` + `login_item: true` drives registration for any
`activation_posture: always-on` service; falls back to the plain LaunchAgent when no signing
identity is configured. Example motivating case: memory-server → "Sox Memory". Prereq: a Developer
ID / signing identity + a bundled signed helper target.

### BL-164 — loose `scripts/capture-*-baseline.mjs` create an nx lint circular-dep; promote/exclude them (same class as BL-160) — **RESOLVED (2026-07-04, S10)**

Surfaced by S2: `npx nx lint memory-core --skip-nx-cache` reportedly showed 22 `@nx/enforce-module-boundaries`
errors in `cluster.ts`/`embed.ts`/`recall.ts` etc., attributed to `scripts/capture-enrichment-baseline.mjs`
+ `scripts/capture-write-perf-baseline.mjs` importing `memory-core` from the repo-root `scripts`
project — a circular project edge (scripts→memory-core while the root project globs these files).

**S10 re-verification (fresh `nx reset` + clean-room `pnpm install` + `--skip-nx-cache`):** the
22-error cycle did **not** reproduce — `npx nx lint memory-core --skip-nx-cache` was clean (0 errors)
both before and after this fix, and a programmatic cycle-detection pass over the full `nx graph`
JSON found no cycle touching `memory-core` or `sox-ecosystem` in either state. The one real, confirmed
structural finding: the root `sox-ecosystem` project *did* carry a one-directional `sox-ecosystem →
memory-core` static edge, caused by these two scripts' raw `require('../libs/memory-core/dist/index.js')`
(and shared by several unrelated `tools/*.{js,mjs}` probes/benches — out of this ticket's scope, see
below) — real hygiene debt (no typecheck/lint/test coverage, brittle dist-path reach-in) matching
BL-160's disease even though it wasn't tripping the cycle detector today.

**Fix (Option A, matching BL-160's precedent):** promoted both scripts into a new nx-recognized
project `tools/baseline-capture` (`package.json` + `project.json` + `tsconfig.json` +
`vitest.config.ts`), consuming `@adhd/sox-memory-core` as a normal `workspace:*` dependency instead
of reaching into its `dist/` output via a relative path:
- `tools/baseline-capture/src/capture-enrichment-baseline.ts` — typed `captureEnrichmentBaseline()` +
  pure `runEnrichmentBaselinePass()` / `buildEnrichmentBaseline()` helpers, ported verbatim from the
  deleted `scripts/capture-enrichment-baseline.mjs` (identical JSON shape/output paths).
- `tools/baseline-capture/src/capture-write-perf-baseline.ts` — typed `captureWritePerfBaseline()` +
  pure `percentile()` / `computeWritePerfMeasurements()` / `buildWritePerfBaseline()` helpers, ported
  verbatim from the deleted `scripts/capture-write-perf-baseline.mjs`. **Preserves the exact
  `{ measurements: { p50_ms, p99_ms, ... } }` JSON contract** that `libs/memory-core/src/soak/
  metrics-exporter.ts`'s `compareToBudget()` reads from `_shared/baselines/write-perf.json` — the one
  live consumer found via a repo-wide grep before making this change.
- 14 unit/integration tests across both modules (`*.spec.ts`), no ONNX/real embedding required —
  `capture-write-perf-baseline.spec.ts` mocks `@adhd/sox-memory-core` (same philosophy as
  `reembed.spec.ts`); `capture-enrichment-baseline.spec.ts` seeds a real schema via raw SQL (no
  `memoryWrite`/embed calls) and exercises the real `runBatchEnrich` end to end, including a
  "never mutates the live store's content" assertion.
- Deleted `scripts/capture-enrichment-baseline.mjs` and `scripts/capture-write-perf-baseline.mjs`
  (no shim — same as BL-160's `reembed-memory.mjs` deletion). New invocation:
  `npx nx run baseline-capture:capture-enrichment-baseline` / `:capture-write-perf-baseline`
  (or `node tools/baseline-capture/dist/capture-*.js` directly, matching the old plain-`node`
  ergonomics). No CI workflow or npm script referenced the old paths (grepped `.github/`, root
  `package.json` — clean); only historical plan docs (`docs/plan/runtime-productionization/02-
  reusable-subsystems/{progress.json,REPORT.md}`) reference the old invocation as an append-only
  audit trail and were intentionally left untouched.
- Added `tools/*` to `pnpm-workspace.yaml`'s `packages` glob (new workspace member needs pnpm
  linking); relocked with a plain `pnpm install` and committed the `pnpm-lock.yaml` diff in the
  same change per the RELOCK constraint. Other loose `tools/*.{js,mjs,cjs}` files (bench/probe
  scripts) have no `package.json` and are unaffected by this glob.

**Gate:** `npx nx lint memory-core --skip-nx-cache` clean (0 errors) · `npx nx build baseline-capture`
pass · `npx nx lint baseline-capture --skip-nx-cache` clean · `npx nx test baseline-capture
--skip-nx-cache` 14/14 pass. `npx nx affected -t lint,build,test` surfaced 2 failing tasks —
`sox-ecosystem:test` and `memory-flush:test` — both re-verified in isolation (see BL-171) as a
pre-existing real-ONNX/vitest-forked-pool flake with **zero** overlap with this ticket's diff
(`git status` during triage showed only `BACKLOG.md`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, the
2 deleted scripts, and the new `tools/baseline-capture/` dir — no memory-server/memory-flush files
touched). Not fixed here (out of file-scope; logged as BL-171).

**Follow-on backlog candidate (not fixed here, out of scope):** several other `tools/*.{js,mjs}`
files (`bench-recall.js`, `bench-scale.js`, `test-*.js`, `probe-*.mjs`) reach into sibling
extensions'/libs' `dist/` output the same way the two capture scripts used to — same disease,
systemic across `tools/`, deliberately not swept into this ticket's file scope to avoid touching
files outside the two named in BL-164 (worktree hygiene / disjoint-file-set discipline).

### BL-171 — `onnxruntime-node` native V8 HandleScope crash + real-ONNX test timeouts under vitest forked pool (`sox-ecosystem:test`, `memory-flush:test`) — **Open (MEDIUM), discovered during S10/BL-164** (2026-07-04)

Surfaced while gating BL-164 via `npx nx affected -t lint,build,test`: two unrelated projects failed,
**neither touched by BL-164's diff** (verified via `git status` — zero overlap):
1. `sox-ecosystem:test` (root `vitest run`, includes `extensions/**/*.test.ts`) crashed with a
   **native V8 fatal error** inside `onnxruntime-node@1.21.0`'s forked worker: `FATAL ERROR:
   HandleScope::HandleScope Entering the V8 API without proper locking in place`, stack trace
   rooted in `InferenceSessionWrap::Run` → `OrtValueToNapiValue`, in
   `extensions/bundles/sox-memory-bundle/members/memory-server/recall-sqlite.test.ts` ("writes two
   claims and recalls them without throwing", 5000ms timeout, then the whole forked worker dies:
   `[vitest-pool]: Worker forks emitted error` / `Worker exited unexpectedly`). Node v24.11.1 +
   onnxruntime-node@1.21.0 — looks like a genuine native binding / V8-isolate-locking incompatibility
   when real ONNX inference runs inside a vitest forked child process.
2. `memory-flush:test` — 3-7 tests (non-deterministic count/subset across repeated runs: 3/14 in one
   isolated run, 7/14 inside the full affected batch) in
   `extensions/bundles/sox-memory-bundle/members/memory-flush/src/index.spec.ts` time out at exactly
   5000ms on auto-export paths that go through the real embed pipeline. Unlike `libs/memory-core`
   (which BL-161 fixed with a deterministic `DeterministicTestProvider` test-DI seam, cutting its
   suite from 140s to 19s and eliminating ONNX-driven flake), `memory-flush`'s spec has **not**
   adopted that seam and is exposed to real ONNX cold-start/warmup timing variance under a tight
   5000ms vitest default timeout — non-deterministic pass/fail is the signature of exactly this class
   of bug.

Both are pre-existing test-infrastructure flakiness in the shared "real ONNX inside vitest's forked
worker pool" execution path — not a BL-164 regression. Fix candidates (not attempted here, out of
BL-164's disjoint-file-set scope and touches `memory-server`/`memory-flush`, adjacent to concurrent
S8/S9 memory-daemon-area work): (a) extend BL-161's `DeterministicTestProvider` DI seam to
`memory-flush`'s and `memory-server`'s real-ONNX specs, or explicitly mark them `real-embed`-only and
raise their `testTimeout`; (b) investigate the onnxruntime-node v1.21.0 + Node v24 forked-worker V8
HandleScope crash — may need `pool: 'forks'` + `maxWorkers: 1` (already applied in memory-core's own
vitest.config.ts per BL-161) applied consistently to memory-server's and the root's vitest configs
too, or an onnxruntime-node version bump/pin.

### BL-165 — RAG-stack external reusability gap: `ingest` is private + `memory-core` (public) transitively 404s on it — **Open (MEDIUM) (2026-07-04)**

ADR-0007 states the enrichment/data stack is meant to be "reused by non-memory projects." The five
data packages (`@adhd/sox-embedding-provider`, `-vector-store`, `-graph-store`, `-hybrid-search`,
`-analysis`) ARE cleanly reusable — public, ~9k LOC of real impl, platform-decoupled (import only each
other, never host-runtime/CLI), clean public `@adhd` dep graphs. But two gaps block a clean external
build of the FULL stack:
1. `@adhd/sox-ingest` (chunking + extractive summary + deterministic tags — the RAG document-prep
   step) is `private: true`, so it's not externally installable.
2. `@adhd/sox-memory-core` (public, v0.2.1) declares a RUNTIME `workspace:*` dep on the private
   `ingest` → per the repo's own `scripts/check-publishable.ts` rule 1, it would 404 on a fresh
   `npm install`. So memory-core is marked publishable but isn't.
**Update — ingest is barely used + its capabilities are DUPLICATED (reframes the fix):** tracing
actual usage, the system uses `ingest()` for ONLY its extractive summary (`memory-core/src/
extractive.ts` → `ingest(content).summary`, a 5-line wrapper). Its other capabilities are dead or
reimplemented elsewhere: `chunkContent` is UNUSED (memory-server has its own `splitIntoChunks` at
`index.ts:745` — the code that carried the BL-154 deadlock); `hexSha256` is UNUSED (`write.ts` has
its own `crypto` SHA-256); `extractTags` is UNUSED (tags are caller-supplied, `enrich.ts: p.tags ??
[]`). So `ingest` doesn't earn its ~1.4k LOC as wired.

**OWNER DECISION (2026-07-04): (A) Consolidate.** Tracked as SHARDS.md S11, sequenced after
S7/S9/S10 (memory-core serialization).

Decide (do not just publish a mostly-dead package):
- **(A) Consolidate — make ingest the canonical ingestion layer.** ← CHOSEN Route memory-server's chunking +
  write.ts's content-hashing + tag derivation THROUGH `ingest`, deleting the duplicate
  `splitIntoChunks`/SHA-256. This is DRY, removes the duplicate-chunker hazard class (BL-154), gives
  ingest real value, and makes publishing it (for RAG reuse) worthwhile. Bigger refactor (touches
  memory-server + write.ts — sequence after S7). PREFERRED if RAG reusability is a goal.
- **(B) Delete ingest — absorb the one live use.** Inline the trivial extractive summary into
  memory-core, remove the `ingest` package + memory-core's private dep. Simplest; also resolves the
  publishability gap (memory-core no longer depends on a private pkg). Choose if a reusable ingestion
  primitive is not wanted.

Either way this closes the original publishability inconsistency (memory-core public but transitively
404-ing on private ingest). Also note: none of the data packages are pushed to a registry yet (v0.x) —
a real external-consume story needs an actual publish. (Discovered answering "can I build a RAG system
from only these packages?" — yes for the 5 public retrieval packages; ingest is the weak link.)

### BL-166 — orphaned built packages + a dead reranker: wire-in-or-remove audit — **Open (MEDIUM) (2026-07-04)**

Cheap consumer scan ("what was built but never refactored into memory") found fully-implemented
code with ZERO live consumers (not stubs — real impl; distinct from the internal-completeness items
BL-114/115 below):
- **`@adhd/sox-blob-store`** (~1,828 LOC) — 0 live importers anywhere in libs/extensions/apps.
- **`@adhd/sox-claim-verification`** (~1,083 LOC) — 0 live importers.
- **`hybrid-search` cross-encoder reranker** (`createCrossEncoder`/`CrossEncoderImpl`) — exported +
  tested but only its own spec calls it; `memory-core/recall.ts` never invokes it (recall reranks by
  temporal recency×importance only). The dead path also carries the worker-path resolution bug noted
  under BL-157 (`../../../../embed/embedding-provider/dist/embedWorker.js` won't resolve in a bundle).

Same fork as ingest (BL-165): for each, **wire it into the live memory path** (blob-store = large-
content/attachment offload out of SQLite rows; claim-verification = memory provenance/contradiction
checking; cross-encoder = higher-precision recall reranking behind a flag) **or remove it**. Decide
per item — don't leave built-but-unconsumed code accruing (owner directive: fix/remove, don't defer).
Note `@adhd/sox-analysis` + `@adhd/sox-vector-store` currently also count `memory-daemon` as an
importer, but that's dead code being removed in S9 — they remain live via memory-core.

### BL-160 — promote `reembed-memory.mjs` orchestration into a library + `memory-cli` verb (root cause of BL-159) — **RESOLVED (2026-07-04)**

`scripts/reembed-memory.mjs` was a loose `.mjs` OUTSIDE the nx graph (no typecheck/lint/test),
which is why it silently rotted when the embed migration removed the hash backend and changed
model ids (BL-159 — invalid `fast-bge-base-en-v1.5` + dead `hash-768`). Promoted:
1. `libs/memory-core/src/reembed.ts` — `reembedStore(dbPath, opts)` typed + unit-tested;
   dry-run-no-write bug fixed (no longer calls `ensureSpace` in dry-run mode).
2. `memory-cli reembed` verb added to the `switch(command)` dispatcher; flags:
   `--dry-run`, `--force`, `--no-backup`, `--db`, `--limit`.
3. `scripts/reembed-memory.mjs` deleted. All references updated to point at `memory reembed`.
Joined to the build/lint/typecheck graph — future embed-model changes break CI, not the next
live migration.

### BL-159 — `reembed-memory.mjs` was broken by the embed migration (wrong model id + dead hash fallback) — **RESOLVED (2026-07-04)**

The reembed tool passed `model: 'fast-bge-base-en-v1.5'` (the fastembed cache-DIR name, not a
valid `createEmbeddingProvider` model id) → `Unknown fastembed model` on every run, and fell
back to the removed `type:'hash'` / `model:'hash-768'` backend. Fixed: model id →
`'bge-base-en-v1.5'`; removed the dead hash fallback (`createEmbeddingProvider` only supports
`fastembed`/`remote` now). Verified: dry-run resolves `active model: bge-base-en-v1.5` and
reads the store correctly. (Surfaced while investigating BL-158.)

---

## Resolved-as-non-issue — pnpm workspace-linking post-merge investigation (surfaced 2026-07-04)

### BL-150 — `@adhd/*` workspace packages "missing" from `node_modules/@adhd/` after 4-worktree merge — **RESOLVED/NON-ISSUE (2026-07-04)**

**Reported symptom:** after merging 4 worktrees to `main`, `node_modules/@adhd/` didn't exist at the
repo root; memory-server tests (which load `@adhd/sox-mcp-runtime` → `@adhd/sox-service-proxy`)
were reported failing. A manual `mkdir -p node_modules/@adhd && ln -sf ../../libs/service-proxy
node_modules/@adhd/sox-service-proxy` was applied as a stopgap.

**Root cause (verified by clean-room reproduction):** worktree `04`'s merge added
`@adhd/sox-service-proxy: workspace:*` to `libs/mcp-runtime/package.json` without a corresponding
`pnpm-lock.yaml` update, so `pnpm install --frozen-lockfile` correctly refused post-merge (lockfile
≠ manifest). Someone ran `pnpm install --no-frozen-lockfile`, which regenerated the lockfile
correctly — that fix is the still-uncommitted `pnpm-lock.yaml` diff (+9/-3) sitting in the working
tree. The manual root-level symlink was a **red herring**: pnpm's isolated linker never hoists
workspace packages into the *root* `node_modules` unless the root `package.json` itself declares
them (it doesn't — root only depends on `better-sqlite3`/`sqlite-vec`/`ulid`). Every real consumer
(`libs/mcp-runtime`, `libs/memory-core`, the memory-server bundle, etc.) gets its `@adhd/*` symlinks
in its *own* local `node_modules/@adhd/`, which pnpm manages correctly on a plain install once the
lockfile is consistent.

**Verification:** `rm -rf node_modules && pnpm install` (zero flags, zero manual steps) from the
corrected lockfile → scanned all 11 projects / 29 `@adhd/*` dependency edges in the repo →
0 missing links. `npx nx test memory-server` passes identically with or without the root-level
symlink (81/84, same 3 pre-existing failures — see BL-151..BL-153 — none are module-resolution
errors). Root-level TS scripts (e.g. `scripts/validate-manifests.ts`, run via `tsx`) never needed
node_modules linking at all — they resolve `@adhd/*` via `tsconfig.base.json` `paths` mappings to
`libs/*/src/index.ts`, confirmed by direct execution (`OK (14 extension(s) validated)`).

**Fix:** commit the corrected `pnpm-lock.yaml`; delete the stray manual root symlink (not tracked
by git, but remove it from any local checkout — it's dead weight, not a fix). No `.npmrc` change,
no `link-workspace-packages`/`node-linker` override needed — default pnpm behavior is correct.
**Process note for future worktree merges:** any worktree that adds a new `workspace:*` dependency
edge must regenerate `pnpm-lock.yaml` *in that worktree* before merge, or the very first post-merge
`pnpm install` on `main` must be a non-frozen install before anything else runs — otherwise
`--frozen-lockfile` (used in CI) will hard-fail.

### BL-151 — `permission-guard.spec.ts` "long content auto-chunks into parent + chunks with DERIVED_FROM edges" times out — **RESOLVED (2026-07-04)**

Two root causes, both fixed during the runtime-productionization context-06 kickoff:
1. **Syntax corruption (prior-session edit):** a stray `}, 15_000);` had been inserted right
   after the test's opening comment, closing the `it()` callback early and orphaning the entire
   test body as top-level code — a `PARSE_ERROR` ("`await` is only allowed within async
   functions"). Moved the timeout to the real end of the test.
2. **Missing test timeout:** `memory-server/vitest.config.ts` had no `testTimeout`, so the
   default 5s tripped during the first-`embed()` fastembed ONNX model load. Set `testTimeout`
   and `hookTimeout` to `30_000` (matching `memory-core`); bumped the auto-chunk test's explicit
   override to `30_000`.

This test surfaced **BL-154** (the chunk-write deadlock) once its body actually executed.

### BL-152 — `recall-sqlite.test.ts` BL-48 real-embedding proof / hash-backend tests — **RESOLVED (2026-07-04)**

The `provider_call_count` counter and the entire `SOX_EMBED_BACKEND=hash` backend were removed
this cycle (hash embedding backend deleted from `embedding-provider` and `memory-core/src/embed.ts`).
The two obsolete "BL-48: embed backend resolution and fallback detection" tests (asserting the
hash model id `nomic-embed-text-v1.5-hash` and the on-hash-fallback indicator) were deleted — the
hash backend they exercised no longer exists. Real-embedding semantics are covered by the retained
`SOX_EMBED_BACKEND=real` gate.

### BL-153 — `memory-tools.spec.ts` recluster (BL-27 LOW-3) subset persistence: `persisted` expected `true`, got `false` — **RESOLVED (2026-07-04)**

Root cause: `clusterSubset()` (`libs/memory-core/src/cluster.ts`) only persisted when
`result.clusters.length > 0`. A filter selecting only dissimilar (non-clustering) episodes
yields zero communities (singletons are suppressed, D1.6), so `persisted` stayed `false` and the
lens was invisible to `list_lenses` / un-droppable. Fix: a persisted subset recluster now always
records a **lens marker** — a member-count-0 sentinel community node tagged
`meta.cluster_scope.marker = true` (new `materializeLensMarker()`), written when zero real
communities form. `listSubsetLenses()` registers the lens but excludes markers from
`community_count`; `dropSubsetLens()` removes markers with the rest of the slice. The persist
block also always invalidates the prior slice first, so re-runs stay idempotent.

### BL-154 — CRITICAL: `memory_write` deadlocks the WriteQueue on any content larger than `chunk_size*4` chars — **RESOLVED (2026-07-04)**

**Severity: critical (latent production hang).** In `memory-server/src/index.ts`, the
`memory_write` handler runs its whole body inside `wq.enqueue('memory_write', …)`, and for
auto-chunked content (chunks.length > 1) it called `wq.enqueue('memory_write_chunk', …)` on the
**same** serial `WriteQueue` from within the already-running task, then `await`ed it. The
`WriteQueue` processes items one at a time (`_processNext` awaits the current op before shifting
the next); the nested chunk items can only run *after* the outer op returns, but the outer op is
awaiting them → permanent deadlock. Any `memory_write` with content over `chunk_size*4` chars
(**2000 chars at the default `chunk_size=500`**) would hang the queue forever, blocking all
subsequent writes on that store.

Masked until now because the auto-chunk test's body was dead code (see BL-151). Fix: write chunks
directly via `memoryWrite(writeDb, …)` inside the outer task — `writeDb` is already held
exclusively, so ordering and single-writer safety are preserved without re-enqueuing. Verified:
`permission-guard.spec.ts` auto-chunk test now completes (was hanging the full 30s).

**Follow-up (deferred):** add a regression guard that asserts `memory_write` of >2000-char content
completes within a bounded time under a live serve session, not just the in-process handler test.

---

## Open — opencode-host implementation (surfaced 2026-06-29)

### BL-108 — Multi-host `--host=claude --host=opencode` only uses last value — **FIXED (2026-06-29)**

**Fix:** Changed `--host` parsing in `cmdInstall` and `cmdUpdate` to accept comma-separated values
(`--host=claude,opencode`), following the same pattern used by `--keywords` and `--transports` in
`cmdInit`. The host value is split on commas, trimmed, and iterated. Help text updated to show
`--host=<h1,h2,...>` syntax. Verified: `soxe install memory-org --host=claude,opencode --scope=project
--dry-run` now shows both hosts.

**Observed:** `soxe install memory-org --host=claude --host=opencode --scope=project --dry-run` only
shows the opencode result. The claude host is silently dropped. Same for any multi-host install.
Root cause: caps parseArgs treats `--host` as a single string, overwriting on repeat — not an array
accumulation. Each host installs correctly when invoked separately, so the workaround is two commands.
But the `soxe install --help` documents `--host=<h>` (no repeat indication), so the silent drop is a
footgun.

**Fix sketch:** switch `--host` to a string-array argparse type, or detect the comma-separated syntax
`--host=claude,opencode`, or add a bespoke parser before the caps parseArgs layer. Update help text
to show repeat syntax (`--host=<h1> --host=<h2>`).

### BL-109 — `soxe uninstall` for mcp-server extensions fails with "not found in lockfile" — **FIXED (2026-06-29)**

**Fix:** `cmdUninstall` now falls back to the ownership index when the lockfile key match fails.
Extensions installed via the `--host` path (which calls `declarativeInstall()` directly without
writing a lockfile entry) can now be uninstalled via ownership/ledger reversal. The fix queries
`OwnershipIndex` at the data root; if the extension has an ownership record, it proceeds with
ledger reversal. Verified: `soxe install memory-server --host=opencode --profile=sse --scope=project`
→ `soxe uninstall memory-server --host=opencode --scope=project` now succeeds (logs "found in
ownership index (not lockfile) — proceeding with ledger reversal").

**Observed:** `soxe install memory-server --host=opencode --profile=sse --scope=project` wrote the
correct MCP entry to `opencode.json` but did NOT create a lockfile entry. Subsequent `soxe uninstall
memory-server --host=opencode --scope=project` (even with `--force`) reports "extension 'memory-server'
not found in lockfile" and refuses to clean up the config entry. The MCP config entry was placed but
is unreversible through the ledger — the `[inv:reversible-injection]` invariant is violated for this
install path.

**Root cause:** memory-server's `extension.json` does not declare `install.hosts` (it uses `serves`
and `profiles` for transport selection). The install engine resolves it via the host-agnostic path,
which places files but may bypass the lockfile/ledger write for config-merge placements when no hosts
are declared.

**Fix sketch:** ensure the declarative install path always writes a ledger entry for
`config-merge` placements even when `hosts` is unset or when the extension is resolved through the
host-agnostic resolver. Verify with an install→uninstall→reinstall round-trip for all host/scope
combinations.

### BL-110 — S6b post-install restart can unload OS unit without completing reload — **FIXED**

**Observed:** `soxe install memory-server --host=opencode --profile=sse --scope=user` timed out
after the post-install restart began. The `restartOsUnit` call unloaded the launchd unit (step 1:
verified-stop + unload) but the install process timed out before steps 2-4 (reap, write new unit,
reload) completed. This left the daemon UNLOADED — `soxe service status` reported `loaded: no`
with no running process. Required manual `soxe service enable` to restore. This is a partial-failure
state: the config was written correctly to opencode.json but the daemon was killed with no replacement.

**Root cause:** `restartOsUnit()` is async with a 60s restart-loop guard. The install command has
a timeout that may fire before the full unload→reap→write→load sequence completes. The unload is
destructive (kills the running process) but the reload is deferred, so a timeout during restart
leaves the system in a broken state.

**Fix (2026-06-29):**

1. **`os-unit.ts`**: Added `signal?: AbortSignal` to `RestartOptions`. Wrapped `restartOsUnit` body
   in try/finally: if the daemon was unloaded but not reloaded (interrupted/timeout/error), the
   finally block restores the last-known-good unit file and loads it. Added `signal?.aborted` checks
   between phases (after unload, after reap, after write). The existing load-failure LKG revert path
   now also sets `loaded = true` when LKG reload succeeds, preventing double-restore in finally.
2. **`main.ts`**: Wrapped `restartOsUnit` calls in `cmdInstall` and `cmdConfigSet` in try/catch
   so interrupted/timeout restarts don't crash the CLI.

---

## Open — extension-authoring docs & footguns (surfaced ingesting the `demo-creator` skill, 2026-06-25)

> Surfaced while porting an external `demo-creator` skill into a born-conformant
> `skill` extension and installing it to a project scope, following "read the how-to on
> creating a skill → scaffold → validate → build-index → install". Each item is a place
> the documentation or CLI output sent the author down the wrong path.

### BL-69 — `docs/guidelines/skill.md` is a framework-contract audit, not an author-facing "how to create a skill" → authors have no authoring guide — **RESOLVED (2026-06-26)** — `docs/guidelines/authoring.md` (all 8 types + bundle, worked examples) + the top-level README now provide the author how-to

**Observed:** told to "read the how-to on creating a skill," the only skill-specific doc is
`docs/guidelines/skill.md`, which is a five-layer analysis of *framework holes* (what the
framework does/doesn't enforce for the `skill` type) — valuable, but it contains zero steps
for authoring one. The actual authoring shape (`runtime: "declarative"`, `entrypoint:
"SKILL.md"`, `run_interface`, `install.hosts`, bundling `assets/`+`scripts/`) had to be
reverse-engineered from `extensions/skills/di-skill` and `extensions/skills/sox-ingest`.

**Fix sketch:** add an author quickstart (`docs/guidelines/authoring-skill.md` or a README
"Authoring" section) covering the canonical flow: `soxe init skill <id>` → fill manifest
fields → bundle assets/scripts → `soxe validate` → `pnpm run build-index` → `soxe install
<id> --scope <scope>`. Cross-link it from `docs/guidelines/skill.md` so the audit doc and
the how-to are not confused.

### BL-70 — manifest `$schema` version drift: scaffold emits **v2**, committed example skills pin **v1** — **RESOLVED 2026-06-26**

**Observed:** `soxe init` writes `"$schema": ".../schemas/extension/v2.json"`, but
`extensions/skills/di-skill` and `extensions/skills/sox-ingest` both pin `.../v1.json`. An
author copying an example to learn the shape adopts the stale schema. Relatedly, those
examples carry no top-level `version` field while the scaffold includes `"version":
"0.1.0"` — so "copy an example" and "use the scaffold" disagree on the field set.

**Fix:** re-stamped all four skill examples to v2 + added `"version": "0.1.0"`:
`di-skill/extension.json`, `sox-ingest/extension.json`, `di-codex-skill/extension.json`,
`forbidden-skill/extension.json`. All four pass `soxe validate`. Registry sync updated
checksums (`registry:sync-index` → `check-registry-sync` green, 15 entries).

### BL-71 — `soxe init` scaffolds a minimal manifest missing `run_interface` and `install.hosts` that real skills carry — **RESOLVED 2026-06-26**

**Observed:** `soxe init skill` emits an `extension.json` without `run_interface` or
`install.hosts`, yet both `sox-ingest` and `di-skill` include them, and nothing enumerates
the optional-but-expected field set. An author can't tell from the scaffold which fields a
"good" skill should add.

**Fix:** `libs/authoring/src/templates/skill/index.ts` now scaffolds:

- `run_interface: { input_schema: {type:"object",properties:{}}, output_schema: ... }` stub
- `install.hosts: ["claude"]` default (overridable via `--host=codex` at init time)

Born-conformance gate PASS for all 7 types; authoring tests 38/38 green.

### BL-72 — `soxe --help` describes `install` as "from config"; real usage is `install <id|bundle> --scope`; README template says `sox` not `soxe` — **RESOLVED 2026-06-26**

**Observed:** `soxe --help` reads `install   Install extensions from config`, omitting the
`<id>` positional that `USAGE.md` and actual usage require (`soxe install demo-creator
--scope project`). Separately, the scaffolded `README.md` emits `soxe install demo-creator`
while the binary is `soxe` (and `USAGE.md` is titled "USAGE — soxe CLI" but calls `node
bin/soxe`). The `sox`/`soxe` naming is inconsistent across help, README template, and USAGE.

**Fix:**

- `apps/sox/src/main.ts` printHelp(): `install` line now reads `install <id|bundle>   Install extension by id (or expand a bundle) at scope` with `--host` flag documented.
- All 7 README templates in `libs/authoring/src/templates/*/index.ts` updated: `soxe install` → `soxe install`, `soxe start` → `soxe start`, `soxe init` → `soxe init`, and the agent template's inline comment references updated.
- `USAGE.md` title updated: "USAGE — soxe CLI" → "USAGE — soxe CLI".

### BL-73 — `install --scope project` puts `.adhd` bookkeeping in the wrong repo because project-root resolution relies on git — **FIXED**

**Observed:** running `soxe install demo-creator --scope project` from cwd
`/Users/nix/dev/ai/agent-source` (which is **not** a git repo) placed host artifacts into
`agent-source/.claude/skills/` (correct — cwd) but wrote the `extensions.json` install
record and `extensions.lock` to `/Users/nix/dev/ai/sox-ecosystem/.adhd/sox-ecosystem/` —
the **CLI's own repo**, not the target project.

**Root cause (confirmed):** `getScopePath(scope)` in `libs/install-engine/src/install.ts`
always used the module-level `REPO_ROOT` constant (derived from `__dirname` at import time)
for project/local scopes. The `install()` function called `getScopePath(opts.scope)` at
line 491, completely ignoring the `opts.root` it had already computed. The same applied in
`loadScopeCascade()` at line 832 and in four call-sites in `apps/sox/src/main.ts` (lines
1104, 1180, 1194, 1566).

**Fix (2026-06-26):** changed `install()` to call `scopeConfigPaths(opts.scope, root)`
instead of `getScopePath(opts.scope)`. Added `root` to `CascadeOpts` and fixed
`loadScopeCascade`. In `main.ts`: introduced `workspaceRoot = process.cwd()` in the
non-declarative install path and replaced all `getScopePath(scope).{config,lockfile}` calls
with `getScopePaths(scope, workspaceRoot).{config,lockfile}`; passed `root: workspaceRoot`
to `install()`. Fixed `cmdUpdate` (line 1563-1566) with the same pattern.

**Files changed:** `libs/install-engine/src/install.ts`,
`apps/sox/src/main.ts`, `libs/install-engine/src/project-root.spec.ts` (new regression
test with 4 cases, all green). State-side proof: running from `/tmp/bl73-state-proof-*/`
(no `.git`) writes lockfile to `/tmp/bl73-state-proof-*/.adhd/sox-ecosystem/extensions.lock`
and does NOT touch `sox-ecosystem/.adhd/sox-ecosystem/`.

### BL-78 — `cmdDetails` uses wrong lock path format (`.extensions/`) and `getScopePath(REPO_ROOT)` fallback — **RESOLVED (2026-06-26)** — `cmdDetails` now resolves via `getScopePaths(scope, workspaceRoot)` (workspaceRoot = flags.root ?? cwd), mirroring the BL-73 fix

**Observed:** `apps/sox/src/main.ts` `cmdDetails` (line 3107-3117) has two problems:

1. When `--root` is given: constructs the lock path as `<root>/.extensions/extensions.lock` — the
   WRONG format (should be `<root>/.adhd/sox-ecosystem/extensions.lock`). This path will never
   match any real lockfile, so `soxe details <id> --root=<dir>` always shows the extension
   as uninstalled at the project scope even when it's installed there.
2. When `--root` is absent: falls back to `getScopePath('project')` which uses REPO_ROOT (same
   root cause as BL-73). So `soxe details <id>` with project scope reads the CLI's own repo
   lockfile, not the user's project.

**Fix sketch:** replace both with `getScopePaths(sc, rootOverride ?? process.cwd()).lockfile`.
Same `getScopePaths` pattern applied in BL-73 fix.

> **BL-79** (`@modelcontextprotocol/sdk` absent → clean recompile fails) is documented in full
> further down (upgraded to MEDIUM after Slice 2 surfaced the clean-recompile + memory-server
> bundle failure). See the BL-79 entry near BL-85.

### BL-80 — `service`-type extensions are NEVER scanned into the registry → cannot be `soxe install`ed by id — **RESOLVED 2026-06-26**

**Observed:** `scripts/build-index.ts` `DIR_TO_TYPE` (and its `check-registry-sync.ts` mirror) has
no `services` key, so `extensions/services/` is never walked. The shipped `service` extension
`tokenguard` (type `service`, in `ACTIVE_TYPES`, with its own `serviceTemplate` + `validate()`
support) is **absent from `registry/index.json`** and therefore cannot be resolved/installed by id —
a whole active extension type is uninstallable through the registry. (tokenguard is `private:true`,
so under the publish signal it would still be omitted, but in dev it should appear as `file://`.)

**Fix (2026-06-26):** Added `services: 'service'` to `DIR_TO_TYPE` in `scripts/build-index.ts`
AND its BL-33 mirror in `scripts/check-registry-sync.ts` (identical entries, same commit).
Ran `npx nx run registry:sync-index` → registry grew from 15 to 16 entries with tokenguard
appearing as `type: service`, `source: file://...`. Dev gate (`check-registry-sync`) green
(16 entries). Publish gate (`SOX_REGISTRY_PUBLISH=npm`) green (7 entries; tokenguard correctly
omitted because `package.json` is `private: true`). `soxe validate ./extensions/services/tokenguard`
passes. New test `scripts/build-index.test.ts` (6 tests) covers: service dir walk, multi-type
index, private skip, multiple services, stray-dir skip, and BL-33 mirror parity check.

### BL-81 — `USAGE.md` says "`service` is not a type — it's an mcp-server install profile"; the code treats `service` as a first-class type — **RESOLVED 2026-06-26**

**Observed:** `USAGE.md` contradicted the code: `service` IS in the schema enum, `ACTIVE_TYPES`,
`validate()`, has a dedicated `serviceTemplate`, and ships as `tokenguard`. The
`docs/guidelines/authoring.md` already documented `service` as first-class (matching code).

**Fix (2026-06-26):** Updated `USAGE.md` to add `service` to the active types list and replace
the incorrect "not a type / mcp-server install profile" description with accurate text:
"`service` is a first-class type — a long-running process extension supervised by the soxe host
runtime". Also updated the authoring lifecycle `Run for each of:` line to include `service`.

### BL-82 — `libs/manifest/src/schema.json` drift: `install.type` enum omits `service`; `install.transports` missing under `additionalProperties:false`, yet `validate()` + `tokenguard` use both — **RESOLVED 2026-06-26**

**Observed:** the hand-rolled `validate()` is authoritative and accepts `install.type:service` +
`install.transports`, but the JSON `schema.json` was stale (would reject tokenguard under strict
JSON Schema validation).

**Fix (2026-06-26):** Added `"service"` to `install.type` enum in `libs/manifest/src/schema.json`.
Added `transports` property to `install` with vocab `["stdio","http","sse","socket"]` matching
`validate()`'s `VALID_TRANSPORTS`. Built manifest (`npx nx build manifest`) and ran
`npx nx test manifest` — 152/152 unit tests + 110/110 validate-manifests tests green.
`soxe validate ./extensions/services/tokenguard` passes cleanly.

### BL-83 — `libs/authoring/src/index.ts` comment says "union of 6 active extension types" but `ACTIVE_TYPES` lists 7 — **RESOLVED (2026-06-26)** — comments corrected to 7

**Fix sketch:** update the comment to match `ACTIVE_TYPES` (7 active = 8 types minus parked `prompt`).

### BL-84 — `extensions/services/tokenguard/CLAUDE.md` (+ examples) reference the REMOVED `./bin/sox` binary and a `sox.install()` JS API that isn't the real surface — **RESOLVED (2026-06-26)** — replaced with `node bin/soxe` + real CLI verbs

**Observed:** `bin/sox` was removed (collided with the system `sox` audio tool; `bin/soxe` is the
only entrypoint). tokenguard's `CLAUDE.md` still shows `./bin/sox` invocations + a non-existent
`sox.install()` API. Update to `soxe` + the real CLI surface.

### BL-74 — `soxe install <id> --scope project` reconciles the WHOLE scope config, re-placing unrelated members — undocumented — **RESOLVED 2026-06-26**

**Observed:** installing only `demo-creator` also re-resolved and re-placed `memory-usage`
and the `sox-memory-bundle` members already recorded in the project's `extensions.json`
(`soxe install: placed claude/project .../memory-usage`). `USAGE.md`'s Install section reads
as "install the named id," not "reconcile the entire scope set," so the extra placements
surprise the operator.

**Fix:** Added a note to `USAGE.md` Install section explaining that `install <id>` reconciles
the full scope set — adds the named id then re-resolves/re-places every member already declared
in the scope's `extensions.json`. Idempotent for unchanged checksums, re-pins for changed ones.

### BL-75 — `soxe init` prints a stray `rm: /Users/nix/dot/bin/node: No such file or directory` during scaffold — **RESOLVED (not in codebase) 2026-06-26**

**Observed:** every `soxe init <type> <id>` run prints a failed `rm` against a hardcoded
`/Users/nix/dot/bin/node` path before "scaffolded …". It looks like a real failure mid-flow
(the documented authoring step) even though the scaffold succeeds.

**Investigation:** exhaustive grep of `apps/`, `libs/`, `scripts/` for `dot/bin/node`,
`rm.*execPath`, `rm.*node\b`, and all shell invocations in the init codepath found zero
matches. Running `soxe init skill <id>` in a clean temp dir on this machine emits no stray
`rm` output — only the success line. The `cmdInit` function in `apps/sox/src/main.ts` contains
no `rm` call and spawns no shell; `libs/authoring` is pure in-memory file generation
(`scaffold()` → `writeFileSet()`).

**Root cause:** the error originates from the user's shell environment. `/Users/nix/dot/bin/node`
is a dotfile-managed Node binary (the `dot/` repo pattern). Something in the user's shell
(likely a Node version manager hook, nvm `use` trigger, or a shell function intercepting `node`
invocations) runs `rm /Users/nix/dot/bin/node` as a side-effect and emits the error to stderr.
The soxe init codepath is not the source and requires no code change.

**Action:** no code change. The error is shell-environment-specific and not reproducible in a
standard environment. If the noise recurs, the author should audit their shell functions/hooks
for `rm` calls against `$(which node)` or similar.

### BL-76 — published `@adhd/sox-cli` dist omits `build-info.json`; fresh-machine `soxe serve` prints a BL-65 warning + git-root walk fails — **RESOLVED (2026-06-26)** — `stamp-build.cjs` now writes `build-info.json` to both `dist/apps/sox/` (tsc) and `apps/sox/dist/` (published esbuild). Ships on next republish. (git-root noise folds into BL-73, fixed.)

**Observed:** the real-npm clean-room install of `@adhd/sox-cli@1.1.1` (no checkout) works
end-to-end (G1/G2/G3 all PASS, `memory_ping` `{ok:true, artifact:sha256:00cefb04…}`), but
`soxe serve` emits two benign-but-noisy lines on a fresh machine:

1. `BL-65 WARNING: dist/apps/sox/build-info.json missing — this dist was built before
   sha-stamping was added` — the `stamp-build.cjs` output (`build-info.json`) is **not in the
   published tarball** (`apps/sox` `files` allowlist / esbuild outdir ships `dist/index.js`
   but not the sibling `build-info.json` written to `dist/apps/sox/`). So the published CLI
   always thinks it's an unstamped/dirty build.
2. `fatal: not a git repository` — the project-root git-root walk runs (and fails gracefully)
   on a non-git fresh dir; same root cause as **BL-73** (project-root resolution must not rely
   on git). Here `--scope user` made it irrelevant, but it's noise.

**Fix sketch:** (1) include the build-info stamp in the CLI bundle — have `embed-registry`/
`stamp-build` write `build-info.json` to the SAME `apps/sox/dist/` dir esbuild ships and add it
to `files`, or inline the sha into the bundle so no sidecar file is needed; (2) suppress the
git-root `fatal:` chatter (capture stderr) — folds into BL-73. Neither blocks the release.

### BL-77 — dev `bin/soxe --version` reports the monorepo root `1.0.0`; published `@adhd/sox-cli` reports its own `1.1.1` — two entrypoints disagree — **RESOLVED (2026-06-26)** — `printVersion()` reads `apps/sox/package.json`; `node bin/soxe --version` now reports `1.1.1`, matching the published CLI

**Observed:** the dev entrypoint `bin/soxe` (loads the tsc build `dist/apps/sox/main.js`)
reports `--version` `1.0.0` — the **root `package.json` (`sox-ecosystem@1.0.0`)** — while the
**published** CLI (esbuild bundle `apps/sox/dist/index.js`) reports `1.1.1` (its own
`apps/sox/package.json`). So `node bin/soxe --version` and `npm i -g @adhd/sox-cli` disagree on
the version string for the same code, which is misleading when debugging "which CLI am I running."

**Fix sketch:** have `--version` resolve from `apps/sox/package.json` (the CLI's own package,
the single source the published path already uses), not the monorepo root. Ideally read the
embedded build-info sha + the `apps/sox` semver together so dev and published agree. Folds in
with BL-76 (build-info stamp). Cosmetic; no behavior impact.

---

### BL-79 — `@modelcontextprotocol/sdk` is absent from `node_modules`; `nx build mcp-runtime` and the memory-server self-contained bundle fail on a clean recompile — **RESOLVED/NON-ISSUE (2026-06-26)** — the dep IS declared (`^1.0.0` in `libs/mcp-runtime/package.json`, resolves to 1.29.0 in the package's pnpm node_modules); `nx build mcp-runtime --skip-nx-cache` + `memory-server --skip-nx-cache` build clean on `main`. The earlier "missing" was an agent-worktree symlink artifact (folds into BL-85), not a main-checkout defect

**Observed:** `@modelcontextprotocol/sdk` is not installed under `node_modules` (neither the
shared checkout nor a worktree symlinked to it). `libs/mcp-runtime/src/{serve,transport}.ts`
`import` it, so `npx nx build mcp-runtime --skip-nx-cache` fails with `TS2307: Cannot find module
'@modelcontextprotocol/sdk/server/index.js'`, and the BL41/SPM e2e probes that esbuild a
**self-contained memory-server bundle** fail with `Could not resolve "@modelcontextprotocol/sdk/..."`.
It only stays green in normal runs because `libs/mcp-runtime/dist` is already built and nx serves it
from cache — a clean machine (or any forced recompile) breaks. **Not caused by Slice 2** (which never
touches mcp-runtime, memory-server, or deps); surfaced because the Slice-2 e2e forced these builds.

**Fix sketch:** add `@modelcontextprotocol/sdk` to the workspace dependencies (the lockfile +
`pnpm install`) so `mcp-runtime` compiles from source and the self-contained memory-server bundle
builds without the prebuilt-dist crutch. Until then, those two e2e sections (BL41, SPM bundle build)
are not runnable from a clean state in an isolated worktree.

### BL-85 — nested git worktrees under `.claude/worktrees/` collide in the nx project graph (`@adhd/sox-nx` duplicate name), breaking `nx` in the SHARED checkout — **RESOLVED (2026-06-26)** — `.nxignore` at repo root excludes `.claude/worktrees`; `nx show projects` returns 28 unique projects with worktrees present

**Observed:** with two agent worktrees checked out under `.claude/worktrees/`
(`agent-a434962d801ff1b5c`, `agent-a997b4af124c6f91f`), running any `nx` target in the SHARED
checkout aborts with *"projects … located in different locations … set a unique name … `@adhd/sox-nx`:
.claude/worktrees/agent-…/packages/sox-nx"* — nx scans into the nested worktrees and sees duplicate
project names. Each worktree in isolation is fine (it scans only its own tree). Worktrees nested
inside the repo are discoverable by the parent's nx project-graph globs.

**Fix sketch:** either place agent worktrees OUTSIDE the repo root, or add `.claude/worktrees/` to
nx's `workspaceLayout`/project-graph ignore globs (`.nxignore` / `nx.json` `pluginsConfig` exclusions)
so the parent checkout never scans nested worktrees. Low blast radius but it makes the shared checkout's
`nx` unusable while worktrees exist.

---

## Open — memory embedding subsystem (surfaced investigating hash-fallback, 2026-06-26)

> The store has been running on hash-embedding fallback (`memory_ping` → `embed_state:"hash"`,
> `embed_on_hash_fallback:true`). Investigation of `libs/memory-core/src/embed.ts` + the published
> memory-server packaging surfaced four distinct defects. While on fallback, vector similarity
> (near-dup `SAME_AS`, clustering, semantic recall ranking) is unreliable; BM25/FTS still works.

### BL-94 — `better-sqlite3` native binding missing for current Node.js ABI → memory-server crashes mid-session — **Open (HIGH) (2026-06-27)**

**Observed:** `memory_write` and all other `mcp__memory-server__*` tool calls fail mid-session with:

```
Error: Could not locate the bindings file.
→ .../better-sqlite3/lib/binding/node-v137-darwin-arm64/better_sqlite3.node
```

The binding directory `node-v137-darwin-arm64/` does not exist — the module was compiled against a different Node.js ABI version than what is currently running (ABI 137 = Node.js v24.x). `memory_ping` succeeds (it bypasses the DB), masking the failure until a write is attempted.

**Observed impact:** workflow-researcher agents that survive long enough to need `memory_write` hit this at Step 3 or Step 5. Sub-Q nodes written before the crash survive; the summary and any remaining nodes are lost and must be handoff-persisted by the parent. Batch 3 workflow (wf_8fdc0fdf-1e3) is currently running — unknown how many of its 18 agents will hit this.

**Root cause:** `better-sqlite3` was rebuilt/installed under one Node.js version; the runtime `node` binary changed (e.g. via nvm, Homebrew upgrade, or pnpm update) without re-running `node-gyp` / `npm rebuild`. The bound binary at `build/Release/better_sqlite3.node` was copied to the ABI-versioned path for the OLD version only.

**Fix sketch:**

1. `cd $(node -e "require.resolve('better-sqlite3')" | xargs dirname | xargs dirname)` then `npm rebuild better-sqlite3` under the current Node.js version.
2. Or: `pnpm rebuild better-sqlite3` from the sox-ecosystem root.
3. Verify: `node -e "require('better-sqlite3')"` should return without error.
4. Then restart the memory-server MCP (`soxe stop memory-server && soxe start memory-server` or reconnect Claude).
5. Long-term: add a startup check in memory-server that tests the binding before accepting MCP connections, returning a clear error instead of a mid-session crash.

---

### BL-100 — `memoryRecall` accepts `filters` in its signature but silently ignores them — filtering only works via the MCP server — **Open (HIGH) (2026-06-27)**

**Observed:** `RecallParams.filters` is declared at `libs/memory-core/src/recall.ts:29` but never destructured or applied inside `memoryRecall`. The parameter is accepted with no error, no warning, and no effect. Filtering (tags, topic, project_path, importance_min, time range) only works when called through the MCP server (`memory-server/src/index.ts:954–1034`), which applies `buildFiltersClause` from `@adhd/sox-memory-enrich` via SQL pre-filtering before invoking `memoryRecall`. Any direct caller of `memoryRecall` — the REPL, tests, `federatedRecall`, any lib consumer — silently gets unfiltered results regardless of what they pass in `filters`.

**Impact:** silent correctness failure. A caller passing `filters: { tags: ['kind:lesson'], importance_min: 5 }` to `memoryRecall` gets back all results as if no filter was specified, with no indication anything was ignored. `federatedRecall` (which calls `memoryRecall` internally) has the same gap.

**Fix sketch:** move `buildFiltersClause` (currently in `@adhd/sox-memory-enrich`) or a minimal equivalent into `@adhd/sox-memory-core`, and apply the filter clause inside `memoryRecall` when `params.filters` is present — either as a SQL pre-filter on candidate rowids (matching what the server does) or as a post-recall JS filter on the ranked results. The server's pre-filter approach is preferred (excludes non-matching nodes before ranking, not after). Also add a `filterStats` field to `RecallResponse` so callers can tell a filtered recall from an empty-corpus recall.

---

### BL-119 — agent_id filter inconsistently applied across vec/FTS/temporal signals in daemon → **FIXED by construction (RS-6)**

**Evidence:** The memoryd daemon that could duplicate the outbox queue has been removed (RS-6). With RS-4's orchestrator replacing the daemon, there is no longer a separate process that could apply agent_id filtering inconsistently. The orchestrator handles all enrichment in a single path.

### BL-120 — parentDocId fallback for parent expansion missing in daemon → **FIXED by construction (RS-6)**

**Evidence:** RS-4's single hosted orchestrator handles all enrichment deterministically from a single location, eliminating the daemon's separate parentDocId resolution path. The orchestrator runs entirely within the memory-server process, so parent expansion is consistent.

### BL-126 — organizer_queue missing additive migration columns (last_error, dead) → **FIXED by RS-4**

**Observed:** The `organizer_queue` table created by `openDb()` had no `last_error TEXT` or `dead INTEGER DEFAULT 0` columns. Without these, a poison-item dead-letter pattern cannot be implemented — a repeatedly-failing queue item blocks subsequent items indefinitely, with no way to skip or retire it.

**Fix (RS-4):** `migrateOutboxQueueSchema()` added to `outbox-queue.ts`. Idempotently adds `last_error TEXT` and `dead INTEGER DEFAULT 0` columns via `ALTER TABLE ... ADD COLUMN`. Creates `ix_q_open_v2` covering `(done_at, dead, priority, seq)` for efficient open-item dequeue. Called by the `createMemoryOutboxQueue()` consumer before the queue is used.

**Verification:** `migrateOutboxQueueSchema` tests (2/2 pass) confirm both columns are added and that the migration is a no-op when the table does not exist or when called multiple times.

### BL-127 — no watermark / memory_flush for read-your-derived-writes → **FIXED by RS-5**

**Observed:** After `memory_write`, the caller had no mechanism to wait for enrichment to complete before reading. The daemon processed enrichment asynchronously, so a subsequent `memory_recall` could return stale or incomplete results (no topic, summary, tags, or near-dup info). Callers that needed read-your-derived-writes consistency had to guess sleep durations or poll manually.

**Fix (RS-5):** `memoryFlush()` implemented in `outbox-queue.ts`. Accepts `{awaitSeq, timeoutMs}` — polls the enrichment watermark (`MAX(seq) WHERE done_at IS NOT NULL AND dead = 0`) and returns `{watermark, caught_up}`. Supports: instant return (awaitSeq ≤ 0), catch-up drain (processes pending items), and timeout. Direct `getWatermarkDirect()` available for zero-overhead reads without creating a queue instance.

**Verification:** `memoryFlush` tests (4/4 pass) confirm: instant return on 0/negative awaitSeq, catch-up from seeded backlog <500ms, and timeout when awaitSeq > known seq.

---

### BL-95 — `memory-cli` `status` and `list` subcommands never find `memory.db` — scope-name mismatch — **Open (MEDIUM) (2026-06-27)**

**Observed:** `memory-cli status` prints "No memory stores found." even with `~/.memory/memory.db` present and `memory_ping` returning `ok:true`. `registry` shows `~/.memory/registry.json` exists but its contents are `{}` (no scopes registered).

**Root cause:** `cmdStatus` resolves stores from `registry.json` (which is empty) and the cwd's `.memory/` dir. `cmdList` looks for `<dir>/.memory/<scope>.db` files. The live store is named `memory.db` — not the scope-prefixed `user.db` / `project.db` that the CLI was designed around. The scope-naming convention was introduced after the store was created, and `memory init` was never run to register the live file.

**Fix sketch:**

1. `memory init --scope user` (or with `--path ~/.memory`) — this registers `~/.memory/user.db` in `registry.json` and creates the scoped DB. However this creates a *new* DB, not an alias to the existing `memory.db`.
2. Longer-term: `cmdStatus` should also scan for a bare `memory.db` in known store dirs (`~/.memory/`, `.memory/`) and surface it with a `(unregistered)` flag rather than silently skipping it.
3. Or: `memory init` could detect an existing `memory.db` and offer to register it under a scope alias rather than creating a new file.

**Workaround:** use `memory-cli export --db ~/.memory/memory.db` (accepts explicit `--db`). For reads/writes use `soxe exec memory-server <tool> --args='{"db_path":"~/.memory/memory.db",...}'`.

---

### BL-96 — plan-state-machine: dod-confirmation audit runs from `cwd:planDir`, guard runs from repo-root → repo-relative checks fail; `parseDodIds` reads inline `[dod.N]` prose as phantom clause — **Open (HIGH) (2026-06-25)**

**Observed (fullstack-developer, 2026-06-25; memory UID `01KVZHMEJHVVBYEGTSQ4AKFNQ6`):** executing a plan to DONE surfaced two terminal-transition defects:

1. The dod-confirmation audit script runs from `cwd:planDir` (the plan directory) while the `guard` command runs from the repo root — any repo-root-relative path check inside the audit fails (4/128 checks failed in observed run).
2. `parseDodIds` reads the literal token `[dod.N]` when it appears in prose (e.g., "see `[dod.6]` for details") as a real DoD clause ID, producing a phantom `dod_unconfirmed` that permanently blocks the terminal transition even when every real clause passes.

**Impact:** a fully-passing, reality-verified plan cannot reach `done` without either (a) calling `os.chdir(repoRoot)` explicitly inside the audit script or (b) rewording every README prose reference to `[dod.N]` outside a real clause bullet.

**Fix sketch:**

- Audit subprocess should `cd` to the git repo root before running checks, or receive the repo root as an explicit `--repo-root` argument.
- `parseDodIds` should only extract `[dod.N]` tokens that appear on a bullet-list line (start with `-` or `*`), not from free prose.

---

### BL-97 — plan-state-machine: audits run against committed `end_ref` → working-tree-only approval artifacts silently fail the gate despite the working tree passing — **Open (HIGH) (2026-06-25)**

**Observed (plan-orchestrator, 2026-06-25; memory UID `01KVZHM10QWB0XPE2112RE549B`):** under workflow 0.8.18, any artifact a guard checks (e.g. a human-checkpoint approval file, a generated snapshot) MUST be committed before `--complete` or the audit fails (exit 4) even though `git status` and the working tree show it present and correct.

**Impact:** orchestrators that write checkpoint artifacts (approval files, baseline snapshots) without an intermediate commit step will see spurious exit-4 gate failures. The failure is silent — the working tree is clean, the audit output passes on local re-run, but `--complete` exits 4.

**Fix sketch:**

- Document the commit requirement explicitly in the work-order template and `--complete` help text: "all artifacts the guard checks must be staged and committed before `--complete`."
- Or: run the audit against the working tree (not `end_ref`) for artifact-existence checks, reserving the ref check for diff/hash verification.
- Or: `state-transition.js --complete` auto-stages and commits declared `artifacts[]` when they are unstaged, with a warning.

---

### BL-98 — reflection `SKILL.md` documents `memory_write` returning `E_DEDUP / existing_uid` on collision, but v1.1.0 actually returns `{episode_uid}` and links via async `SAME_AS` edge — **Open (LOW) (2026-06-23)**

**Observed (memory UID `01KVSA4MFA99DNETTTZ9KX3MDB`):** the reflection skill's failure-mode catalog (SKILL.md lines 308-312) says `memory_write` returns `{code:"E_DEDUP", existing_uid}` on a content-hash collision. The running v1.1.0 `memory_write` schema and observed behavior return `{episode_uid}` on success and route near-duplicates through async `SAME_AS` enrichment edges, not a hard refusal. An agent written to handle `E_DEDUP` as a normal flow will mis-handle the actual `{episode_uid}` success shape.

**Fix sketch:** update `skills/reflection/SKILL.md` failure-mode section to match the v1.1.0 return contract. Note that exact content-hash collisions may still short-circuit (needs verification against a real duplicate write), but the documented shape is wrong regardless.

---

### BL-99 — `compile-wave --stats` omits base dispatch overhead (B≈27k tokens) and source file bytes (Si) → merge-candidates optimization is invisible to the pack/no-pack decision — **Open (MEDIUM) (2026-06-27)**

**Observed (plan-orchestrator; memory UID `01KW3F0GA02V058ZHDTDPJ4EEB`):** all three parallel waves in `memory-refactor` were correctly evaluated as no-pack (prose overlap ratios -0.081, -0.068, -0.088). However, the real dispatch cost is `Di = B + Si + Ki` where B ≈ 27k tokens (base model load + system prompt + transition scaffolding) and Si = source file bytes the executor reads. `compile-wave --stats` measures only Ki-overlap (shared prose invariants/refs/snapshots) — it never accounts for B or Si. This means `savings(i,j) = B + |Si∩Sj|` from merging two tasks into one dispatch is never computed, leaving ≈54k tokens of potential savings unquantified across 3 potential merges even at zero prose overlap.

**Available plan fields that could power the measurement:**

- `dag.json nodes[].artifacts` — `reserved_files` glob patterns → Si proxy at plan-compile time
- `references.json` `source-extract` entries → explicit source file lists per extraction state (Si without disk reads)
- `budget-estimate.js --reserved-bytes` input → already accepted but not fed into the merge decision
- `state.json metrics.tokens_est` → historical cost floor before `emit-state-metrics` populates real actuals

**Fix sketch:**

1. Add `compile-wave --merge-candidates <slug1> <slug2> ...` mode: compute `savings(i,j) = B_estimate + |Si∩Sj|` for all pairs, where Si is sourced from `dag.json artifacts` or `references.json source-extract sources[]`; rank and surface merge opportunities.
2. Expose `reduction_ratio_with_sources` as a separate `--stats` output field, computed as `(independent_cost_with_B_Si - merged_cost) / independent_cost_with_B_Si`.
3. Calibrate B empirically from orchestration-ledger token actuals across ≥3 plan executions (currently ≈27k is a rough estimate).

---

## Open — dispatch-optimizer (surfaced during `docs/plan/dispatch-optimizer/` schema + compiler work, 2026-06-28)

> All items below were found while designing the dag schema, implementing `src/compiler.ts`
> (`snapshot()` + `optimize()`), and running the compiler against the adhd-build test dag.

---

### BL-101 — `normalizeOperations()` didn't default `type` to `"generative"` for pre-schema dags → all ops treated as tool-call → `compilePrompt()` returned `null` for every milestone — **FIXED (2026-06-28)**

**Observed:** running the compiler against `docs/plan/adhd-build/dag.json` (authored before the
`type` field was added to the operation schema) produced `prompt: null` for all dispatch units.
The `compilePrompt` guard bails when `milestoneOps.some(op => op.type === "generative")` is
false — with no `type` field, `op.type === undefined`, so every milestone appeared as tool-call-only.

**Fix:** `normalizeOperations()` in `src/compiler.ts` now maps any op with `type === undefined`
to `{ ...op, type: "generative" }` — applied immediately after the array/Record conversion,
before any other compiler logic sees the ops.

**Follow-up:** `run.ts` still contains a redundant manual patch that injects `type: "generative"`
on each op. This patch is now dead code and should be removed to avoid confusion.

---

### BL-102 — Guard-only milestones (agent: null) produce a DispatchUnit with `provider: undefined`, `agent_name: ""`, `model: null` — the orchestrator has no typed code path to detect and run them locally — **Open (MEDIUM) (2026-06-28)**

**Observed:** `scope-authored` in the adhd-build dag has `agent: null`. `optimize()` produces a
DispatchUnit for it with `provider.type === undefined`, `agent_name === ""`,
`model === null`, and `tokens_estimated === null`. An orchestrator reading this unit has no
machine-readable signal to distinguish "run guard locally as a shell command" from
"model call with missing provider config".

**Fix sketch:**

1. Add `execution_mode: "model" | "guard-local" | "tool-call"` to the `DispatchUnit` type.
2. In `assembleDispatchUnit()`, set `execution_mode = "guard-local"` when
   `milestone.agent === null` (D-12 guard-only class).
3. The orchestrator branches on `execution_mode` before attempting provider resolution.
4. Guard-only units should never enter the Sentinel-Fanout grouping (they're zero-cost, instant).

---

### BL-103 — `snapshot_version` always initialises to `1` — callers that persist snapshots have no way to get an incrementing version without reading the prior snapshot first — **Open (LOW) (2026-06-28)**

**Observed (noted by the typescript-pro implementation agent):** `snapshot()` takes only a
`DagJson` input and has no access to the prior snapshot. The schema spec says
`snapshot_version` is "derived: incremented integer, persisted across regens" — but there
is no mechanism to increment it.

**Fix sketch:** Two options:

- Pass an optional `priorVersion?: number` parameter to `snapshot()` and increment it.
- Read the prior snapshot from disk inside `snapshotWithDag()` and forward the version.
Option A is cleaner (keeps `snapshot()` pure). Add `snapshot(dag, { version?: number })` opts bag.

---

### BL-104 — `compilePrompt()` doesn't drill into complex nested type shapes → agents invent minimal/incorrect interpretations for fields whose type is itself a multi-field interface — **Open (MEDIUM) (2026-06-28)**

**Observed:** dispatching the `dag-schema` milestone to a Haiku agent, two ops produced wrong
output types:

- `shape: OperationShape | null` — op spec said "add-field shape → OperationShape | null"
  but didn't describe `OperationShape`'s internals. Agent generated a simple enum
  `("read-only" | "write" | "transform")` instead of the rich polymorphic shape object
  (`{ kind, ops[], description, objective, schema }`).
- `dispatch_log → DispatchEntry[]` — agent generated `{ milestone, timestamp, dispatched_by,
  model, effort, notes }` instead of the full `{ id, kind, milestone_slugs[], turns[], results[],
  started_at, ... }`.

**Root cause:** `compilePrompt()` renders `shape.ops[]` as a flat list of `action → type` pairs.
When the target type of a field is itself a complex interface, that interface's shape is not
included anywhere in the compiled prompt — the agent has no schema to work from.

**Fix sketch:** For code/config kind ops, when an `add-field` op's `to` type is a known interface
name (detected by capital-first or explicit annotation in the op), look up and inline that
interface's own field specs as a nested block in the prompt. Alternatively, allow op authors
to add a `type_spec: { field: type }[]` array on `add-field` ops for inline sub-typing.

---

### BL-105 — 7 stubs in `src/compiler.ts` with no external integrations wired — snapshot derived fields are incomplete — **Open (MEDIUM) (2026-06-28)**

**Stubs (all return `null` or `[]` with TODO comments):**

| Stub | Requires | Location |
|---|---|---|
| `blast_radius: []` | `gitnexus_impact` MCP call | `buildOperationSnapshot()` |
| `from / breaking / severity: null` | TypeScript AST read (ts-morph) | `enrichShape()` |
| `conflict: { detected: false }` | Same-wave op-key collision scan | `buildOperationSnapshot()` |
| `attempt_count: 0` | Op-level dispatch_log scan | `buildOperationSnapshot()` |
| `tokens_actual: null` (per-op) | ki_estimate-share prorating | `buildOperationSnapshot()` |
| `mcp_servers: null` | Agent catalog lookup | `assembleDispatchUnit()` |
| `raised_at_dispatch / raised_at_turn: null` | dispatch_log notes scan | `buildOpenQuestions()` |

**Priority:** `mcp_servers` is HIGH — without it the orchestrator cannot create the agent-mcp
agent definition and the dispatch fails. `blast_radius` is MEDIUM (gitnexus integration is
the next planned milestone in adhd-build). Others are LOW (correctness impact is observability
only, not dispatch correctness).

---

### BL-106 — `b_per_tier` cold-start values not seeded in the schema → `b_eff_per_tier` is null → `tokens_estimated` is null for all milestones on a fresh plan — **Open (LOW) (2026-06-28)**

**Observed:** the adhd-build dag has no `optimization` block. After injecting the defaults in
`run.ts`, `b_per_tier` was seeded with `{ Haiku: 8000, Sonnet: 15000, Opus: 27000 }` and
`tokens_estimated` computed correctly. Without those seeds, every milestone shows
`tokens_estimated: null` and the optimizer cannot rank units by size.

**Fix sketch (per SCOPE.md Open Decision 2):** bake the recommended cold-start defaults into
the schema as the `b_per_tier` initial value when the field is absent or null, applied in
`normalizeOperations`-equivalent logic for the `optimization` block in `readDag()` or
`validateDagJson()`. Document these as "uncalibrated baseline; real calibration overwrites via
the calibration utility."

---

### BL-107 — `run.ts` backward-compat patches for missing `providers`, `optimization`, and `effort_max_tokens` blocks live in the runner, not in `readDag()` — consuming code outside `run.ts` gets no defaults — **Open (LOW) (2026-06-28)**

**Observed:** `run.ts` manually injects three top-level dag blocks before calling
`snapshotWithDag()`. These patches are necessary for any dag authored before the schema
added `providers`, `optimization.sentinel_fanout`, `optimization.b_per_tier`,
`optimization.context_window_per_tier`, and `effort_max_tokens`. Any other consumer of
`readDag()` (future orchestrator, CLI tool) that doesn't know to apply the same patches
will crash in `snapshotWithDag()`.

**Fix sketch:** Move the defaults into `readDag()` as a post-parse normalization pass —
applied after `validateDagJson()` succeeds (or as part of it). This makes the contract:
"any syntactically valid dag.json, old or new, produces a usable DagJson from readDag()."

---

### BL-86 — `hashEmbed()` produces near-collinear (degenerate) vectors → ~0.97–0.998 cosine between UNRELATED texts → near-dup flags everything — **Open (HIGH) bug** (2026-06-26)

**Observed (numerically proven):** with `SOX_EMBED_BACKEND=hash`, cosine of three unrelated strings
("the cat sat on the mat" / "quantum chromodynamics lagrangian renormalization" / "npm publish
registry checksum drift") = **0.967 / 0.985 / 0.968** (should be ~0). In production (longer, more
similar texts) this pins ~0.998 — so every `memory_write` reports `near_dup` ~0.998 and an async
`SAME_AS` edge, regardless of content.

**Root cause:** in `hashEmbed` (`libs/memory-core/src/embed.ts:352`), the per-dimension seed is
`seed = (d * 0x9e3779b9 + h1) >>> 0` — the `d * 0x9e3779b9` term depends ONLY on the dimension index
and is therefore IDENTICAL for every token and every text. After `^ h2` + `/2^31 - 1` it dominates the
token-specific signal, so all vectors share a large common "d-pattern" component → near-collinear.

**Consequence:** while on hash fallback, the `SAME_AS` near-dup graph, communities, and semantic recall
ranking are garbage (corroboration metric is an artifact). **The SAME_AS edges written during fallback
should be considered suspect and re-run after BL-87/89 restore real embeddings.**

**Fix sketch:** hash `(token, d)` together with a proper avalanche (e.g. `hash32(token + ':' + d)` or
mix h1/h2/d through an integer finalizer) so dimensions are independent — no shared d-only component.
Add a test asserting cosine of unrelated strings is near 0 (e.g. |cos| < 0.2).

### BL-87 — published `memory-server` omits `fastembed`/`onnxruntime-node` runtime deps → every npm-installed (incl. the BL-65-repointed) server is permanently on hash fallback — **Open (HIGH) packaging** (2026-06-26)

**Observed:** the published `memory-server` `package.json` declares only `better-sqlite3` + `sqlite-vec`
as `dependencies`; `@adhd/sox-memory-core` (which declares `fastembed: ^2.1.0` → pulls onnxruntime-node)
is a **devDependency**, inlined as JS by the esbuild bundle. `fastembed`/`onnxruntime-node` are NOT in
the bundle's `--external` list either. So on an `npm-package:`-mode install, the embed worker has no
embedding runtime → `embed()` (auto) silently falls back to hash. The BL-65 repoint (live server now from
`~/.adhd/.../ext`) therefore runs **permanently degraded**.

**Fix sketch:** declare `fastembed` (and its native onnxruntime-node) as real `dependencies` of the
published memory-server AND externalize them in the esbuild bundle (like better-sqlite3/sqlite-vec), so
the npm-package install resolves them. Add the published-fresh-machine smoke assertion: after install,
`memory_ping` reports `embed_on_hash_fallback:false`. (Native onnxruntime-node also has the Node-version
prebuild matrix concern — verify Node 22/24 coverage, cf. the engines decision.)

**Quickfix IMPLEMENTED (2026-06-26, worktree `agent-ac3165b4897bcaa50`, NOT yet merged/published):**
`fastembed@^2.1.0` + `onnxruntime-node@1.21.0` added as real `dependencies` of both `memory-server` and
`memory-daemon` package.json; both externalized in the esbuild bundle (project.json `--external fastembed
--external onnxruntime-node`). ALSO found a second root cause the deps alone don't fix: `embedWorker.js`
was never emitted into the bundle — `embed.ts` spawns it via a runtime string path
(`new Worker(path.join(__dirname,'embedWorker.js'))`) that esbuild does not trace, so the bundled server
had only `index.js` and the Worker spawn failed → permanent hash fallback. Fixed by a new
`--worker <entry>` flag in `tools/bundle-extension.cjs` that emits each worker as its own self-contained
sibling bundle (`dist/embedWorker.js`, fastembed lazy-required at runtime). Verified onnxruntime-node
ships napi-v3 darwin/arm64 prebuilds → loads on live Node v24.11.1. Clean-room proof (real `npm install`
of the published dep set + the built bundle, temp HOME + temp db): `memory_ping` →
`embed_on_hash_fallback:false`, `embed_model:"bge-base-en-v1.5"`, semantic recall returns the relevant
result; real-model cosine of unrelated strings 0.39–0.42 (vs hash 0.97–0.99). **Landing on the live
user-scope install (`@adhd/sox-extension-memory-server` via BL-65 npm install) REQUIRES an npm republish
(owner-gated) — not done.**

### BL-88 — no PER-RECORD embedding provenance + no auto-upgrade when the real backend returns — **Open (MEDIUM) data-integrity** (2026-06-26)

**Observed:** `embed_model` is stored only on `memory_scope` (one row per scope, set ONCE at scope
creation via `getActiveEmbedModel()` in `db.ts:191`, never updated). Individual `node`/`vec_node` rows
carry NO model/backend tag. So there is no way to tell which records were embedded under hash fallback vs
real, and a scope first created during fallback stays stamped `nomic-embed-text-v1.5-hash` even after real
is restored. `reembedNodes()` + the reindex organizer op exist but are MANUAL (`reembed=true` payload) —
nothing auto-re-embeds stale-model rows when the provider returns.

**Fix sketch:** (1) record `embed_model` (or a backend flag) per node/vec row at write time; (2) a
heal pass that re-embeds rows whose `embed_model` != the current real model once `embed_on_hash_fallback`
clears; (3) surface a `degraded_record_count` in `memory_stats`. Closes "we should know which records were
created on degraded services."

### BL-89 — dev-box real embed worker warmup fails/hangs silently despite onnxruntime-node loading + model cached → silent auto→hash fallback — **Open (HIGH) bug** (2026-06-26)

**Observed:** on the dev box (Node v24.11.1), `require('onnxruntime-node')` LOADS fine and the BGE model
is fully cached (`~/.cache/sox-memory/models/fast-bge-base-en-v1.5/model_optimized.onnx` present), yet
exercising `embed()` (auto) via the built memory-core dist did not return a real embedding within ~20s —
the worker_thread warmup (`embedWorker.ts` / fastembed init) hangs or fails, and `embed()` (auto) swallows
it into a hash fallback (`embed.ts:271-285`). This is why the live store is on hash even where the deps
exist.

**Fix sketch:** make the warmup failure LOUD and diagnosable (surface the worker error/timeout instead of
a one-line warn), add a warmup timeout + health signal, and root-cause the fastembed 2.x / worker_thread
init failure (candidate: the BL-11 onnxruntime libpthread isolation, or a fastembed 2.x API/model-format
mismatch). Until fixed, real embeddings never engage even on a fully-provisioned box.

**Quickfix IMPLEMENTED (2026-06-26, worktree, NOT merged):** Root cause was NOT a fastembed/onnxruntime
hang on the dev box — reproduced `embed()` via the built `memory-core` dist returning a real BGE vector in
~1s (state `real`, cosine 0.46), and the worker_thread path works in isolation (~650ms). The actual
silent-fallback driver is the BUNDLE (the missing `embedWorker.js` — see BL-87). The loud/diagnosable
work landed regardless: `embed.ts` now records `_lastEmbedError` (worker spawn/init/exit/timeout + the
auto-fallback cause), adds a configurable warmup timeout (`SOX_EMBED_WARMUP_TIMEOUT_MS`, default 60s) so
an indefinite hang can't wedge callers, and exposes `getLastEmbedError()` / `getEmbedHealth()` /
`warmupEmbed()`. `backend='real'` now fail-LOUD (throws, never downgrades); `auto` fallback is
`console.error` + recorded. The server warms up at startup (loud stderr) and `memory_ping` / `memory_stats`
now include `last_embed_error`. Reality-verified in clean-room: `backend=real` + fastembed absent →
`memory_ping.last_embed_error` carries the cause + stderr `FATAL`; `auto` + absent →
`embed_on_hash_fallback:true` + cause. Tests added in `embed.spec.ts` (health surface + real-model
non-degeneracy assertion |cos|<0.85).

### BL-91 — `reembedNodes()` (and any vec_node re-embed) used `INSERT OR REPLACE` which FAILS on sqlite-vec vec0 tables → daemon `reindex --reembed` op silently broken — **FIXED in worktree (2026-06-26)**

**Observed:** while building the re-embed quickfix, `INSERT OR REPLACE INTO vec_node(node_id, embedding)`
raised `SqliteError: UNIQUE constraint failed on vec_node primary key` and rolled back the whole
transaction (vectors stayed hash). sqlite-vec `vec0` virtual tables do not implement OR-REPLACE conflict
resolution. `reembedNodes()` in `libs/memory-core/src/embed.ts` (called by memoryd's `reindex` op when
`reembed=true`) used exactly this form — so the existing re-embed path was non-functional.

**Fix (applied):** use `UPDATE vec_node SET embedding=? WHERE node_id=?` for the existing row, falling back
to `INSERT` only when the row is absent (`changes===0`). Both `reembedNodes()` and the new
`scripts/reembed-memory.mjs` use this form. Verified: UPDATE and DELETE+INSERT both work on vec0;
INSERT OR REPLACE does not.

### BL-92 — re-embed script note: per-record provenance gap (BL-88) means the real store's vectors are a HASH/real MIX while `memory_scope.embed_model` already (falsely) reads `bge-base-en-v1.5` — **Observed (2026-06-26)**

**Observed:** the live `~/.memory/memory.db` `memory_scope.embed_model` already reads `bge-base-en-v1.5`
(set once at scope creation, never updated — BL-88), yet the stored vectors are a mix: pairwise cosine over
a 60-node sample is mean 0.64 / min 0.43 / max 0.96 (pure hash pins ~0.97+, pure real ~0.4). So the scope
tag is NOT a reliable re-embed trigger — `scripts/reembed-memory.mjs` requires `--force` to re-embed when
the tag already says real, and normalises the WHOLE store to real (idempotent: re-embedding an
already-real row reproduces the same BGE vector). Pairs with BL-88 (add per-record `embed_model`).

### BL-93 — `edge.rel` accepted-value set is INCONSISTENT across the `memory_link` tool, the `schema.ts` CHECK constraint, and the graph contract → `memory_link({rel:'ASSIGNED_TO'})` fails at the DB — **FIXED at source (2026-06-26); existing-store migration is a follow-up** (found by architect-reviewer authoring the memory-refactor contracts)

> **Fix (2026-06-26):** added `'ASSIGNED_TO'` to the `edge.rel` CHECK in `libs/memory-core/src/schema.ts`
> (now the 9-value union matching the contract `EdgeRel`), rebuilt memory-core/server/daemon, registry
> synced. NEW stores accept `ASSIGNED_TO`. **Follow-up:** SQLite CHECK constraints aren't retroactively
> altered, so the EXISTING `~/.memory/memory.db` (created with the old 8-value CHECK) still rejects
> `ASSIGNED_TO` until its `edge` table is recreated — a small migration (or left until next store rebuild),
> low priority since `ASSIGNED_TO` was never successfully written. w2b inherits the fixed schema.

**Observed (verified state-side):** three different `edge.rel` value sets are in play:

- `memory_link` MCP tool — enum + `VALID_RELS` (memory-server `src/index.ts:452,1325`): `MENTIONS, SUPPORTS,
  RELATES_TO, DERIVED_FROM, SUPERSEDES, SAME_AS, **ASSIGNED_TO**` (7; **no** `MEMBER_OF`/`PART_OF`).
- `schema.ts` `edge.rel` CHECK (`libs/memory-core/src/schema.ts:58-59`): `MENTIONS, SUPPORTS, RELATES_TO,
  SUPERSEDES, DERIVED_FROM, **MEMBER_OF, PART_OF**, SAME_AS` (8; **no** `ASSIGNED_TO`).
So a `memory_link({rel:'ASSIGNED_TO'})` call **passes the tool's `VALID_RELS` then hits the SQLite CHECK
constraint and errors** — the tool advertises a relation the DB rejects. (`[inv:tool-contract-stable]`
guards the tool enum, so the *schema* is the side that's wrong.)

**Fix:** reconcile to one authoritative set — the contract's `EdgeRel` (9 values = union) in
`docs/plan/memory-refactor/contracts/graph-store.ts`. The **w2b graph-store extraction MUST add
`ASSIGNED_TO` to the DDL CHECK** (and confirm `MEMBER_OF`/`PART_OF` are intentional internal rels the tool
needn't expose). Add a test asserting every `memory_link` enum value is DDL-accepted. Pre-existing
(predates the refactor); surfaced because the contract forced the three sets to be compared.

### BL-90 — memory skill(s) lack "how to find memories scoped to YOU / your project / your task" recall recipes (and which work under degraded embeddings) — **Open (MEDIUM) docs/skill** (2026-06-26)

**Observed:** the `memory-usage` (and `reflection`) skills document write conventions well but give little
guidance on the *retrieval* side — specifically how an agent finds the memories relevant to its situation.
Agents need ready recipes for the common scoping axes:

- **Directed at you (the agent):** by `agent_id` (your own confirmed identity), and by `target:<name>` /
  `audience:<name>` tags (e.g. ideas/lessons addressed to a specific agent or role like `workflow-researcher`).
- **Scoped to your project:** `filters.project_path` (exact or `{prefix}`) — and the footgun that
  `project_path` auto-resolves to cwd/git-root, so a write from the wrong dir mis-files the scope.
- **Scoped to your task:** `filters.topic` (single or array OR-match) + `filters.tags` (`tags_match_all`
  for AND) + `importance_min`; combine with the query for hybrid recall.
- **By kind/lifecycle:** `kind:lesson|bug|fix|idea`, `actionable`, `state` (metadata).

**Critical note to include:** **tag/topic/project filters use the FTS/structured index, not vectors — so
they remain reliable even when the embedding backend is degraded (hash fallback, BL-86/87/89).** Semantic
(`query`) recall is the part that degrades. So the recommended pattern when embeddings may be down is
**filter-first** (tags/topic/project), optionally adding a query for ranking — never rely on a bare
semantic query to surface directed/scoped memories.

**Fix sketch:** add a "Finding the right memories" section to `memory-usage` (and cross-link from
`reflection`) with copy-paste `memory_recall` recipes per axis above (self/agent, project, task, kind,
directed-at-role), plus the filter-first-under-degraded-embeddings guidance and the `project_path`
mis-resolution footgun. Pairs with BL-88 (per-record provenance) so "find records made under hash
fallback" becomes a documented recall too.

---

## Resolved — regressions from the proxy-default flip, fixed 2026-06-25

### BL-67 — detached proxy backend inherits the parent's stdout fd → `soxe upgrade --all` (and any piped/CI invocation) HANGS forever — **RESOLVED**

**Observed (2026-06-25, rolling the Slice 1.6 flip to live):** `node bin/soxe upgrade --all 2>&1 | tail -40`
appeared to hang indefinitely. Diagnosis (state-side): the `upgrade --all` node process **had already exited
0** (work complete), but the rolling-restart of memory-server spawned the **detached proxy backend** (PPID 1,
`node --enable-source-maps .../memory-server/dist/index.js`, pid 20057) which **inherited the parent's stdout
write-end**. `tail` therefore never received EOF (a live writer of the pipe remained), so the shell pipeline
never terminated. Any invocation that pipes soxe output (`| tail`, `$(…)`, CI capture, the post-merge
`upgrade --all` mandated by CLAUDE.md) now hangs whenever a proxy backend is (re)spawned.

**Root cause:** `ensureBackend`/the detached-backend spawn did not fully sever inherited stdio — `stdio[2]` was
`'inherit'` on non-Windows (stderr), which means when the spawner had `2>&1` active (piped), the backend
inherited THAT pipe fd, keeping it open forever.

**Fix (committed):**

- `libs/service-proxy/src/ensure-backend.ts`: removed `os` import; replaced `stdio: ['ignore', 'ignore',
  os.platform() === 'win32' ? 'ignore' : 'inherit']` with full fd severance using a synchronously-opened log
  fd (`fs.openSync`) or `'ignore'`. Added `stderrLogPath?: string` to `EnsureBackendOptions`.
  Added `[inv:no-fd-inherit]` invariant documentation.
- `apps/sox/src/main.ts` (`cmdServe` ensure callback + `restartProxyBackend`): both `ensureBackend` callers
  now pass a dated `stderrLogPath` under `logDirFor('proxy-backend-<extId>')`.
- `libs/service-proxy/src/ensure-backend.spec.ts`: added `[BL-67]` regression test that spawns a real child
  process with `stdio:'pipe'`, triggers `ensureBackend`, and asserts the pipe closes within 12s (not hung).

**Proof:** E2E run in isolated tmp — pipeline returns in 143ms; `lsof -p <backend_pid>` confirms fd 0,1 = /dev/null,
fd 2 = log file, no parent pipe fd inherited.

### BL-68 — BL-65 dirty-dist guard counts UNTRACKED files as "dirty" → false "built from DIRTY tree (uncommitted WIP)" warning on every serve — **RESOLVED**

The BL-65 `stamp-build.cjs` / `warnIfDistSha()` guard (correctly shipped) computes `dirty` from
`git status --porcelain`, which includes **untracked** files (e.g. `README.md`, `PUBLISHING.md`,
`.claude/skills/memory-usage/`). So a clean-tracked-tree build stamps `dirty=true`, and **every** live
`soxe serve` then emits "dist was built from a DIRTY tree (uncommitted WIP)" — alarming false-positive noise
for all sessions.

**Fix (committed):**

- `apps/sox/scripts/stamp-build.cjs`: changed `git status --porcelain` → `git status --porcelain --untracked-files=no`.
  Untracked files are now excluded; only staged/unstaged modifications to tracked files count as dirty.
- `apps/sox/src/stamp-build.spec.ts` (new): 5 tests covering the contract — clean tree → false, only-untracked →
  false (regression), modified tracked → true, staged tracked → true, untracked + modified tracked → true.
  All tests run in isolated tmp git repos (never touch the real repo's dist or worktree state).

## Mostly-resolved — test harnesses pollute the real `~/.memory` store dir + the repo root (2026-06-25)

### BL-66 — C6/e2e test artifacts accumulated 1.5 GB in `~/.memory/`; 12 test DBs were committed to git under `.tmp-*/` — **Resolved (cleanup + 2 of 3 root causes); 1 root cause deferred**

**Observed (2026-06-25):** `~/.memory/` held **843 test-artifact files / ~1.49 GB** of `*.db{,-wal,-shm}` triples
beside the canonical `memory.db`: `c6-allowed*` (323 files, 579 MB), `sox-e2e-*` (514, 905 MB),
`smoke-*`/`cli-demo*`/`test-verify*` (6, ~12 MB). Separately, **12 test DBs were tracked in git** under six
`.tmp-*/.memory/project.db` dirs (committed via a past `git add -A` — the exact hazard CLAUDE.md bans), and
`.gitignore` covered only `.tmp-mvp/`+`.tmp-test/` of the 8 `.tmp-*` dirs present. `~/.memory/registry.json`
(federation registry) held a single stale entry pointing at a `.tmp-p2/.memory/project.db` test store.

**Root cause:** the `db_path` permission allowlist is `~/.memory/**` (BL-15), so tests/audits that must prove a
write to an *allowed* path write into the **real** store dir and never clean up. Culprits: (1) `audit_c6.py`
([dod.1] positive write to `~/.memory/c6-allowed.db`), (2) `tools/test-e2e-lifecycle.js` (`sox-e2e-<pid>.db`),
(3) `memory-server/src/permission-guard.spec.ts` (shared fixture names).

**Fix (shipped 2026-06-25):**

- **Swept** `~/.memory/`: removed all 843 artifacts (1.5 GB → 41 MB); canonical `memory.db` untouched
  (`PRAGMA integrity_check` = ok, 2909 nodes, parity with the verified backup). Manifest of removed files at
  `~/.memory/backups/swept-manifest-*.txt`. A verified backup exists at
  `~/.memory/backups/memory-20260625-151943.db` (sha256 `7f213ec8…6c399e`).
- **Reset** stale `~/.memory/registry.json` (pointed at a `.tmp-p2` test store) to `{}` (old saved to
  `backups/registry.json.bak-*`).
- **Untracked + deleted** the 12 committed `.tmp-*/.memory/*.db` files (`git rm --cached`) + removed all 8
  `.tmp-*` dirs from disk (60 MB); **broadened `.gitignore`** `.tmp-mvp/`+`.tmp-test/` → `.tmp-*/` (verified a
  fresh `.tmp-probe` is now ignored).
- **Root cause (1):** `audit_c6.py` now has `_cleanup_memory_artifacts()` (glob-removes `~/.memory/c6-allowed*`)
  called in a `finally` around the phase run, so it can never re-accumulate even on a failing check.

**Deferred (1 root cause):** `tools/test-e2e-lifecycle.js` + `memory-server/src/permission-guard.spec.ts` still
write `sox-e2e-<pid>.db` / fixtures into `~/.memory` without teardown. **Not fixed in this pass to avoid a
write-collision** — the `svc-proxy-fix` platform-engineer agent is concurrently editing `tools/test-e2e-lifecycle.js`
(its Step 7d / Section SPM / BL-59 e2e assertions). Fix after that agent merges: route test dbs to a sweepable
`~/.memory/.e2e-tmp/` subdir (still inside the `~/.memory/**` allowlist) + `rm -rf` it in teardown, OR add a global
afterAll cleanup. Track here until done.

## Open — INCIDENT: the dev checkout's `dist` IS the live MCP source (2026-06-25)

### BL-65 — building unverified WIP into the dev-repo `dist` breaks the LIVE memory-server for all sessions — **RESOLVED (HIGH) — principled repoint APPLIED 2026-06-26 (option 1); guard remains as defense-in-depth**

**Resolved (2026-06-26):** after the first npm publish, the principled repoint (option 1) was
applied. The published CLI was installed to a **stable, non-PATH prefix** `~/.adhd/sox-cli`
(`npm i -g @adhd/sox-cli@1.1.1 --prefix ~/.adhd/sox-cli` → `~/.adhd/sox-cli/bin/soxe`), and
`sox-memory-bundle` was installed through it (members + native deps resolve from npm via the
`npm-package:` mode into `~/.adhd/sox-ecosystem/ext/`, never `libs/*/dist`). All three live
`memory-server` references were repointed from the dev `/Users/nix/dev/ai/sox-ecosystem/bin/soxe`
to `~/.adhd/sox-cli/bin/soxe` (backups `*.bl65-bak`): `~/.claude.json` (root mcpServers),
`sox-ecosystem/.mcp.json` (gitignored, local), `claude-agents/.mcp.json` (gitignored, local).
`memory_ping` verified `ok:true` (artifact `sha256:00cefb04…`) via the stable command before the
swap. Effective on the next MCP reconnect (BL-61). A dev `nx build` no longer touches the running
server — it updates ONLY on explicit `soxe upgrade --all` (or reinstall). The `warnIfDistSha`
dirty-dist guard stays as defense-in-depth. The interactive dev `bin/soxe` (on PATH via `OUT_PATH`)
is unchanged, so local extension development/install is unaffected.

**Update (2026-06-26, publishing refactor):** the BL-42 blocker is resolved — there is now an
independently-installable, self-contained CLI (`@adhd/sox-cli` → `soxe`, in-package bin + bundled
registry; proven via `npm i -g` with no checkout). The principled repoint (option 1) is therefore
UNBLOCKED. Sequence (orchestrator, AFTER the owner publishes — `docs/plan/publishing/SCOPE.md` §8):

1. `npm i -g @adhd/sox-cli` (or `soxe install sox` to a content-addressed store under `~/.adhd/...`).
2. Repoint `.mcp.json` / `~/.claude.json` `mcpServers.memory-server.command` from
   `/Users/nix/dev/ai/sox-ecosystem/bin/soxe` → the **installed** `soxe`; install
   `sox-memory-bundle` via the published packages (members resolve from npm, native deps via the
   `npm-package:` install mode), so memory-server runs from `~/.adhd/.../ext/`, never `libs/*/dist`.
3. One final reconnect (BL-61). After repoint, a repo build never touches the running server; it
   updates only on explicit `soxe upgrade --all`. The `warnIfDistSha` dirty-dist guard stays as
   defense-in-depth. Do NOT do a fragile dist-copy repoint (still risks re-breaking live).

**Update (2026-06-25, attempting the repoint):** the guard (option 3) is **shipped and verified live** —
`soxe serve` now emits the dirty/stale-dist warning (confirmed firing: it caught dist sha `ffe4a3d` vs HEAD
`b479ebb`). But the **principled repoint (option 1)** — point `.mcp.json`/`~/.claude.json` `memory-server`
(currently `command: /Users/nix/dev/ai/sox-ecosystem/bin/soxe`, also in `sox-ecosystem/.mcp.json` and
`claude-agents/.mcp.json`) at an installed `soxe` under `~/.adhd/...` — is **BLOCKED on BL-42**: there is **no
independently-installable CLI** (`~/.adhd/sox-ecosystem/` holds only metadata; `bin/soxe` → `dist/apps/sox/main.js`
which runtime-resolves `@adhd/sox-*` from the repo `libs/*/dist` + repo `node_modules` = checkout-bound). The
real fix requires either (a) an esbuild-bundled self-contained CLI installed to `~/.adhd/.../cli/<sha>/`
(the bundled-extension-build-standard applied to the CLI), or (b) a dedicated pinned checkout/clone the live
MCP resolves and dev never builds in. Both are architectural choices gated on BL-42/BL-43 (publish strategy).
Until then the guard is the interim protection; do NOT do a fragile dist-copy repoint (it risks re-breaking live).
See also BL-67 (the flip's `upgrade --all` hang) + BL-68 (guard over-sensitivity).

**Incident (2026-06-25):** while an agent was implementing proxy-on-by-default on a branch, its
`nx build` wrote the WIP (proxy-default + a not-yet-working shim path) into `dist/apps/sox/main.js` and
`libs/*/dist`. Because **every `.mcp.json` / `~/.claude.json` points `memory-server` at the absolute
`/Users/nix/dev/ai/sox-ecosystem/bin/soxe`** (→ that repo `dist`, which also runtime-resolves
`@adhd/sox-memory-*` from the repo `libs/*/dist`), **every memory-server respawn loaded the broken WIP**
and failed (`-32001 proxy closed`). Multiple agents/sessions reported memory failures. A detached WIP
backend orphan was left holding `~/.memory/memory.db`.

**Recovery performed:** switch tree to `main` → rebuild serve path (sox + memory-core/enrich/server,
cache-busted) → reap all WIP memory-server processes (3 shims + 1 detached backend) gracefully → remove
stale proxy socket → verified direct serve `memory_ping`/`recall` OK + SQLite `integrity_check: ok`.

**Root cause:** the **dev checkout is the live MCP runtime** (no isolation between in-progress repo state
and the running MCP server). This is the `$SKILL`-cache-vs-dev-checkout hazard generalized to MCP.

**Fix options (need decision):**

1. **Point `.mcp.json` at an installed/cached `soxe`** (a content-addressed install under `~/.adhd/...`),
   not the live dev checkout — so repo builds never touch the running server (it only updates on an
   explicit `soxe upgrade`/reinstall). This is the principled fix.
2. **Isolate risky serve-path work in a git worktree** (`Agent isolation: "worktree"`) so its `nx build`
   writes to a separate `dist`, never the live one. (Process discipline; the orchestrator now does this.)
3. **A build guard** — refuse/ warn when building the serve path while a live MCP server resolves this
   `dist` (or stamp dist with a git-sha and have `serve` warn on a dirty/uncommitted dist).

**Shipped (this branch, `feat/proxy-default-memory-backend` rebased):**

- Option 2 is enforced at the orchestrator level: risky serve-path work MUST run in an isolated git
  worktree (the BL-65 constraint in the task brief); the current work was done in
  `.claude/worktrees/agent-a43ff2972d1444cca/` which has its own `dist`.
- Option 3 (build guard): `apps/sox/scripts/stamp-build.cjs` is now run as a post-build step in the
  `sox:build` nx target. It writes `dist/apps/sox/build-info.json` with `{ gitSha, dirty, builtAt }`.
  `cmdServe` calls `warnIfDistSha()` at startup (before any subprocess) and emits a loud WARNING to
  stderr when the dist was built from a dirty tree or from a sha that differs from HEAD — so the
  operator cannot silently serve stale/WIP code.

**Remaining human/orchestrator step (option 1 — principled permanent fix):**

- Point every `.mcp.json` / `~/.claude.json` `memory-server` entry at a content-addressed INSTALLED
  `soxe` under `~/.adhd/sox-ecosystem/installs/<sha>/bin/soxe` (or equivalent), NOT the live dev
  checkout. This decouples repo builds from the live MCP server: it only updates on an explicit
  `soxe upgrade --all`. The mechanism: run `soxe install sox` (or `soxe upgrade --all`) to write a
  pinned install, then repoint the MCP config entry from `/path/to/dev/sox-ecosystem/bin/soxe` to
  the installed path. DO NOT repoint live config yourself — this is a documented orchestrator step.
- Until that repoint: NEVER build the serve path on the live dev checkout while sessions are
  connected; validate in an isolated worktree and merge to `main` before any rebuild.

> **Status (2026-06-22): BL-1 … BL-22 all resolved.** BL-23/24 are now **folded into the
> memory-enrichment plan** at `docs/plan/memory-enrichment/` (SPEC + DESIGN + CONSUMER-INTERFACES +
> CONTRACTS + IMPLEMENTATION) and tracked there per `IMPLEMENTATION.md §0` — they are resolved by its
> phases (P1–P6), not as loose items. The metadata-drop half of BL-23 is already fixed (`9728f6f`).
> **BL-21 (auto-export) and BL-22 (entity names) resolved by P5 (2026-06-22).**

## Slice 1.6 — proxy-by-default + memory-server backend (2026-06-25, `feat/proxy-default-memory-backend`)

### BL-61 — flipping memory-server to proxy default requires exactly ONE final client reconnect — **Migration note (expected, one-time)**

memory-server is now served via the front-shim by DEFAULT (`type: mcp-server` →
`lifecycle.serve_mode:"proxy"`). The running instance in any MCP client is still the OLD direct-stdio
server (it owns the client's pipe). To pick up the shim, the client must reconnect/reload the
memory-server MCP plugin **once**. After that single reconnect, every subsequent memory-server
behaviour/code upgrade is a BACKEND rolling-restart behind the shim → **no further client reconnects**
(the shim re-dials across the sub-second gap; spec §9.5, e2e Section SPM). An interface (tool-schema)
change still emits `notifications/tools/list_changed` and falls back to reconnect only for clients that
ignore it. **Action for the human:** after this merge + `soxe upgrade --all`, reconnect/reload the
memory-server MCP server once.

### BL-62 — shared-backend `project_path` attribution is single-valued for the lifetime of the backend — **Open (MEDIUM) `(unverified)` multi-project correctness**

The proxy backend is a SINGLETON per store (single-writer, by design). The BL-56 fix injects the
client's workspace as `SOX_CONFIG_PROJECT_PATH` at **shim spawn**, but the shared backend captured the
value of whichever shim's `ensure` first spawned it — a second shim from a DIFFERENT project dials the
SAME backend and its `SOX_CONFIG_PROJECT_PATH` does NOT propagate to the already-running backend. So
for a memory store shared across multiple project workspaces, episodes written via the second project's
shim would be attributed to the FIRST project's path. Single-project use is unaffected (the common
case). **Fix sketch:** thread the per-call workspace (MCP `roots` / a caller-supplied `project_path`
arg) through `tools/call` so attribution is per-request, not per-backend-process; until then the shared
backend's `project_path` is `(unverified)` for multi-project setups. Surfaced + flagged during Slice
1.6; NOT silently regressed (BL-56's per-shim injection still happens, it just can't reach a shared
running backend).

### BL-63 — `host-runtime:test-e2e` BL-31 orphan scan uses a global `pgrep -f memory-server/dist/index.js`, so a CONCURRENT live proxy session on the dev box is mis-counted as a leaked orphan — **RESOLVED (2026-06-25, `feat/proxy-default-memory-backend`)**

`tools/test-e2e-lifecycle.js` `liveServerPids()` does `pgrep -f 'memory-server/dist/index.js'` and
subtracts a `BASELINE_PIDS` snapshot captured at import. With the Slice 1.6 proxy default LIVE in the
operator's own `bin/soxe serve memory-server` session, that session's shim **re-ensures/respawns its
backend during the ~minute e2e run** → the new backend pid post-dates the baseline → the BL-31 "no
orphan after stop" + "BL-31 no orphan survive soxe stop" assertions count it as leaked. This was the
root cause of the reported **e2e 99/2** failure — **a test-environment confounder, NOT a code
regression:** every reported "orphan" pid resolves to `ppid == <the operator's live serve session pid>`
(correlated 3×: 18501→23210, 15408→23210, 15572→23210), never to the e2e's own install/start tree; on a
clean machine the suite was already **101/0** (re-confirmed 3× this session, before the fix).

**Fix (shipped):** `leakedServerPids({ excludeLiveParented: true })` for the two POST-STOP orphan
assertions (Step 7 + Step 7b). After a `soxe stop` this test's supervisor is already dead, so a genuine
leak from THIS test is always orphaned (PPID 1) or dead-parented; a candidate whose parent is a LIVE
non-init process is owned by another live manager (the operator's serve shim) and is excluded. This
removes the false positive WITHOUT masking a real test leak (never live-parented after stop). The
mid-lifecycle disable/enable checks keep the strict (no live-parent exclusion) form — a supervisor
restart there MUST still be caught.

### BL-64 — auto-spawned proxy backend (untracked, no runtime entry) survived `soxe stop` — **RESOLVED (2026-06-25, `feat/proxy-default-memory-backend`)**

A proxy-mode mcp-server (Slice 1.6 default) is fronted by a thin stdio shim; the real implementation
runs in a persistent, detached, sox-owned BACKEND the shim AUTO-SPAWNS via `ensureBackend`
(`SOX_PROXY_BACKEND=1`). That backend is created by the SHIM, not by `soxe start`, so it is in NO
`runtime.json` entry — `cmdStop`'s whole-scope reap loop iterates only `record.entries` and never
touched it, so the detached backend SURVIVED `soxe stop`, re-introducing the BL-31/BL-50 orphan leak
once every spawning shim had exited. (Distinct from BL-63: BL-63 was the e2e *scan* mis-attributing a
foreign live session; BL-64 is the real production gap that the e2e could not previously reach.)

**Fix (shipped):** new `reapUntrackedProxyBackends()` in `apps/sox/src/main.ts` — enumerates every
installed mcp-server from the lockfile (the source of truth for "what could have an auto-spawned
backend"), and for each one served in proxy mode reaps any live process matching the backend's
entrypoint IDENTITY token (the exact `node --enable-source-maps <entrypoint>` argv `ensureBackend`
uses), via `reapByIdentity` → `killAndVerify` ([contract:signal] verified-stop). Wired into all three
`cmdStop` exit paths: whole-scope, per-`--id`, and the no-runtime-record early-exit. Identity matching
is the entrypoint PATH, which is stable across scopes, so a backend whose serve resolved a DIFFERENT
scope than the stop target is still reaped (closes the suspected scope-mismatch leak). The manifest is
read from the lockfile entry's source (honoring an explicit `--lockfile`), NOT re-derived via
`getScopePaths` (which would miss a custom lockfile). Proven: new e2e **Step 7d** spawns the REAL
backend as a true orphan (PPID 1) and asserts `soxe stop` reaps it; full suite **107/0** across 3 runs.

## Open — surfaced during service-proxy Slice 1.5 (2026-06-25, `feat/service-proxy-slice1_5`)

### BL-59 — `cmdServe` local-discovery fallback calls `findLocalExtension(extId, root2)` with args REVERSED — **RESOLVED (2026-06-25, this branch)**

`apps/sox/src/main.ts` `cmdServe` calls `findLocalExtension(extId, root2)`, but the signature is
`findLocalExtension(root, id)` (`libs/install-engine/src/install.ts:984`). The arguments are swapped,
so `soxe serve <id>` can **never** discover an UNINSTALLED local extension by scanning
`<root>/extensions/<typeDir>/<id>/` — it only works via the lockfile (installed) path.

**Fix (shipped):** swapped to `findLocalExtension(root2, extId)` in `cmdServe`. Also added the
`resolveServeManifest` helper (used by `mcpServerIsProxyMode` and `reapUntrackedProxyBackends`) which
uses the CORRECT argument order. e2e Step SPM-local verifies the local-discovery path reaches proxy mode.

## Open — project_path mis-attribution for user-scoped memory-server (2026-06-25)

### BL-56 — `project_path` was derived from the memory-server's INSTALL dir, not the client workspace → user-scoped writes mis-attributed — **Resolved + reality-verified (2026-06-25)**

**Evidence (real store, 2026-06-25):** three project buckets in the single user-scoped store
`~/.memory/memory.db` — `/Users/nix/dev/ai/sox-ecosystem` (46), `/Users/nix/dev/ai/claude-agents`
(215), `/Users/nix/dev/node/adhd-agent-registry` (1).

**Mechanism (read state-side — and the first diagnosis was incomplete):** `memory_write` →
`enrichOnWrite` → `resolveProjectPath` (`libs/memory-enrich/src/provenance.ts`): caller override → else
`git rev-parse --show-toplevel` in **`process.cwd()` of the served process**. The decisive detail is the
served process's cwd: `cmdServe` execs the entrypoint with **`cwd: extDir2`** (`apps/sox/src/main.ts:4694,4720`)
— the **extension INSTALL directory**, not the client's workspace. So `project_path` was the git root of
*wherever the extension is installed* (the dev repo `sox-ecosystem`; or `~/.adhd/...` → `~` for a
user-scoped store copy), **not** where the user/agent is working. The launch dir (`root2` = the dir the
MCP client started `soxe serve` from = the user's real project) was captured but **never used** for
attribution; there was no `SOX_CONFIG_PROJECT_PATH` injection and no MCP `roots`. The buckets varied
because each session's extension resolved to an extDir inside a different repo.

**Fix:**

1. `cmdServe` now injects **`SOX_CONFIG_PROJECT_PATH` = git root of `root2`** (the client launch
   workspace), always defining it (empty string when `root2` is not a git repo) so the install-dir cwd
   path is disabled in the served context (`apps/sox/src/main.ts`).
2. `resolveProjectPath` treats a **defined** `SOX_CONFIG_PROJECT_PATH` as authoritative — non-empty ⇒
   that path; empty ⇒ `null` (no project) with **no** cwd fallback. When the env var is *unset*
   (non-served contexts: daemon, memory-cli, tests) it falls back to cwd-git, now with linked-worktree →
   main-checkout canonicalization, and returns `null` (not the bare cwd) on a non-repo cwd
   (`libs/memory-enrich/src/provenance.ts`). A project-scope `config.<id>.project_path` (via
   `buildExtConfigEnv`) still wins over the auto-injected launch root.

**Reality verification (2026-06-25, served `node bin/soxe serve memory-server`, hash backend, probe db
under `~/.memory`):** launched with cwd `=/Users/nix/dev/ai/claude-agents` ⇒ `project_path
="/Users/nix/dev/ai/claude-agents"` (the **client workspace**, no longer the `sox-ecosystem` install
repo); launched from a non-git tmp dir ⇒ `project_path=null` (no false attribution). 9 new
`resolveProjectPath` BL-56 tests; gates: build (dist verified) + lint + test + `host-runtime:test-e2e`
99/0.

**Remaining (follow-up, lower priority):** the principled per-session fix for a server whose client
launches from a non-project dir is the MCP `roots` capability (the client advertises its workspace);
until then a non-repo launch correctly records `null`. Also: the **daemon** re-enrich path runs with
`cwd = store dir` but does not re-resolve `project_path` for existing nodes (set at write time), so it
is unaffected; a future daemon-side write path must use the same injection.

**Note:** the 4 reflections filed earlier this session landed in `sox-ecosystem` because this client
launched there — which under the fix is now the *correct* attribution (the workspace), not luck.

### BL-57 — soxe data files pollute repo roots instead of nesting under `.adhd/sox-ecosystem/` (legacy `SOX_HOME` residue) — **Open (MEDIUM) — cleanup + migration pending**

**Observed (2026-06-25):** `/Users/nix/dev/ai/claude-agents/` root holds `install-registry.json` (246 KB),
`supervisors.json`, `logs/` (48 dirs), and a legacy `.sox/` (messages.db) — none nested under
`.adhd/sox-ecosystem/` (which does not exist there). `/Users/nix/dev/ai/sox-ecosystem/` root has a
legacy `.sox/` too. The repo roots are polluted with sox's own global/runtime state.

**Root cause (verified):** `SOX_HOME=/Users/nix/dev/ai/claude-agents` is exported in the shell env.
ADR-0004 **retired** `SOX_HOME` — the *current* code ignores it (prints the "SOX_HOME is set but RETIRED"
warning) and writes correctly to `userDataRoot()` = `~/.adhd/sox-ecosystem/` (verified: that dir has
current `install-registry.json`/`supervisors.json`, both mtime Jun 25). The claude-agents-root files are
**stale residue** written by an *older* (pre-ADR-0004) binary that honored `SOX_HOME` and wrote
`$SOX_HOME/{install-registry.json,supervisors.json,logs/}` = the repo root. They are 2 days old (Jun 23);
current code is not re-polluting. So this is **not a live data-path bug** — `dataRoot()`/`userDataRoot()`
(`libs/host-runtime/src/data-paths.ts`) are correct.

**`SOX_HOME` is NOT sox's to reclaim (corrected 2026-06-25).** The user confirmed `SOX_HOME` is set for
an **unrelated** purpose — it "was never a variable for this project to use." sox-ecosystem retired it
(ADR-0004) and must be **fully inert** to it, including **no warning** (the name collides with the `sox`
audio tool and may be claimed by other tooling — nagging about a var soxe no longer reads is presumptuous
noise). **Done:** the per-invocation `SOX_HOME … RETIRED` warning is **removed** (`apps/sox/src/main.ts`);
data placement is governed solely by `SOX_ECOSYSTEM_HOME` / default `~/.adhd/sox-ecosystem/`. Do **not**
recommend unsetting `SOX_HOME`.

**Remaining (cleanup only, independent of `SOX_HOME`):**

1. The stale residue (`install-registry.json`, `supervisors.json`, `logs/`, legacy `.sox/`) at the
   `claude-agents` / `sox-ecosystem` repo roots can be removed/relocated via `soxe migrate-home`
   (ADR-0004 §D8; idempotent, non-destructive — skips when the target already exists, so it won't clobber
   the current `~/.adhd` global state) **with `--old-home <repo>` explicitly**, never by touching the
   user's `SOX_HOME`. Optional; the files are inert.
2. **`soxe doctor`** (future) should detect legacy repo-root residue from the default locations,
   independent of `SOX_HOME`.

This is distinct from **BL-56** (project_path attribution, in the memory store), which is fixed.

## Resolved — surfaced during service-lifecycle Slice 1 (2026-06-25, `feat/service-lifecycle-slice1`)

### BL-58 — `tokenguard-core/src/mapper.ts` uses a lazy `require('./tokenize.js')` that breaks under vitest (`Cannot find module`) — **Resolved**

**Surfaced** while running `nx affected -t build,lint,test` for the Slice 1 work (tokenguard-core was
marked affected only because the repo root `nx.json`/`package.json` are dirty from prior uncommitted
changes — Slice 1 does NOT touch tokenguard-core; `git diff main -- libs/tokenguard-core/` was empty).
`nx test tokenguard-core` failed 1/63: `Mapper.seed` did
`const { identifierGroupVariants } = require('./tokenize.js')` (`mapper.ts:119`), a runtime CJS require of
a `.js` sibling that only resolves against the built `dist/` — under vitest's `src` TS transform there is
no `tokenize.js`, so it threw `Cannot find module './tokenize.js'`. The lazy require was a workaround for
a **non-existent** cycle: `tokenize.ts` imports `Mapper` **type-only** (`import type`, erased at compile),
so there is no runtime value cycle.

**Fix:** converted to a static ESM `import { identifierGroupVariants } from './tokenize.js'` at the top of
`mapper.ts` and removed the inline require. Gates: `nx build tokenguard-core` ✅, `nx lint` ✅,
`nx test tokenguard-core` → **63/63** (was 62 + 1 failed). `registry:sync-index` → no drift (tokenguard's
shipped artifact checksum unchanged). This was a pre-existing latent bug (unchanged vs `main`), fixed in
passing per the zero-burying rule — it is NOT a Slice 1 regression.

## Open — embed fallback + store pollution (2026-06-23, surfaced by BL-48 observability)

### BL-52 — live memory-server runs on HASH embeddings (`embed_on_hash_fallback:true`) despite real BGE being available — **Resolved + reality-verified (2026-06-25)**

**Fix (fix/memory-bl50-52-53):** the enforced policy env-scrub now forwards `SOX_EMBED_BACKEND`,
`SOX_EMBED_CACHE_DIR`, `XDG_CACHE_HOME` (and any `SOX_EMBED_*`) across **all four** enforced spawn
paths — `apps/sox` `serve` + `exec`, `runtime-cli` exec, and `supervisor._spawn` — so the served
server inherits the real-BGE backend selector + model-cache pointer instead of resolving to `auto`
and silently falling back to FNV-hash. Covered by 6 new `supervisor-policy.spec.ts` tests (forwarded
when set; absent when unset → not injected as `""`; explicit `hash` preserved; unrelated secrets still
scrubbed). Root cause was (a) env-scrub stripping the model-cache pointer so the worker couldn't find
the cached BGE model under serve.

**Reality verification (2026-06-25, fresh `node bin/soxe serve memory-server`, enforced scrub, model
cached at `~/.cache/sox-memory/models/fast-bge-base-en-v1.5`):**

- `SOX_EMBED_BACKEND=real` → `memory_recall` returned `["vec"]` results **without error**. The `real`
  branch of `embed()` *throws* on worker failure (no hash fallback), so a successful recall is positive
  proof the ONNX worker loaded + embedded under serve.
- **`SOX_EMBED_BACKEND` UNSET (production default `auto`)** → after warmup, `memory_ping` reports
  **`embed_model:"bge-base-en-v1.5"`, `embed_backend_configured:"auto"`, `embed_on_hash_fallback:false`**
  with no `falling back to hash` warning on stderr. Real BGE is active on the default path.

Three earlier "still on hash" readings were measurement artifacts, not failures: (1) `memory_ping`
called before the first embed reports `embed_on_hash_fallback:true` because the worker warms lazily and
`_activeModel` only flips to `bge-base-en-v1.5` after warmup (→ new **BL-54**); (2) a grep miss on the
backslash-escaped `\"results\"` in JSON; (3) EXIT 124 = the stdio server not exiting on stdin-EOF (the
embed worker keeps it alive), not a recall hang. The running session server is the **pre-fix** binary
and still reports hash until the **client reconnects/reloads plugins** (stdio servers respawn on next
connection); the rebuilt `dist/apps/sox/main.js` carries the fix. No registry checksum changed (CLI/
host-lib change, not an installed-extension entrypoint), so `upgrade --all` is a no-op — a client
reconnect is the only step to put the fix live.

<details><summary>original report</summary>

The BL-48 observability fields (now in `memory_ping`) reveal the production server is on the **hash**
backend: `{"embed_model":"nomic-embed-text-v1.5-hash","embed_backend_configured":"auto","embed_on_hash_fallback":true}`.
Yet the real BGE/ONNX backend works on this machine (a standalone `SOX_EMBED_BACKEND=real` probe embedded
7 texts in ~2.1s using the 635 MB cached model). So the server is **silently degraded** — semantic recall
over `~/.memory/memory.db` is running on FNV-hash projections, not real embeddings (this is almost certainly
what the other agent half-saw and misattributed to "provider offline"). Consequence: weaker semantic recall;
and any episodes WRITTEN by the live server are hash-embedded, so they won't sit in the same vector space as
real-embedded ones (mixed-space store).

Root-cause hypotheses (unverified): the `soxe serve` policy env-scrub (allowlist PATH/HOME/USER/… + NODE_*)
does not forward `SOX_EMBED_BACKEND`/`SOX_EMBED_CACHE_DIR`, so backend stays `auto`; `auto` then tries the
worker_thread ONNX path and falls back to hash when the worker can't spawn from the installed/served location
(embedWorker.js sibling resolution, or onnxruntime-node unavailable in the served context). Needs: confirm
which (instrument the worker-spawn failure path — its warning currently goes only to stderr, now captured via
the BL-46 `--log` sink), then either ship the worker with the served artifact + pin `SOX_EMBED_BACKEND=real`,
or accept hash and stop advertising real. Verify via `memory_ping.embed_on_hash_fallback` after the fix.
</details>

### BL-54 — `memory_ping` reports `embed_on_hash_fallback:true` BEFORE the first embed (lazy-init false positive) — **Resolved + reality-verified (2026-06-25)**

**Fix:** new `getEmbedState(): 'real' | 'hash' | 'uninitialized'` in `libs/memory-core/src/embed.ts`
distinguishes "the lazy ONNX worker has not warmed up yet" (`uninitialized`) from an actual hash
fallback (`hash`): `_activeModel === 'bge-base-en-v1.5'` ⇒ `real`; else `_resolvedBackend === 'hash'` ⇒
`hash` (configured or auto-fellback); else `uninitialized`. `memory_ping` and `memory_stats` now emit an
`embed_state` field and compute `embed_on_hash_fallback = (configured !== 'hash' && embed_state ===
'hash')` — so a fresh server (zero embeds) reports `uninitialized`/`false`, not a false `true`. 2 new
`embed.spec.ts` tests (uninitialized on fresh singleton; `hash` only after a hash embed resolves).
Reality-verified: served `memory_ping` on a zero-embed server → `embed_state=uninitialized`,
`embed_on_hash_fallback=false` (pre-fix: `true`). Gates: build (dist verified) + lint + test
(memory-core 85/1-skip, memory-server 78) ; registry resynced (memory-server checksum changed).

<details><summary>original report</summary>

Surfaced 2026-06-25 while reality-verifying BL-52 — and it is the artifact that triggered the entire
BL-52 "still on hash" false alarm. `memory_ping` computes `embed_on_hash_fallback` from
`getActiveEmbedModel()` (index.ts ~769-773), but `_activeModel` only flips from its default
`'nomic-embed-text-v1.5-hash'` to `'bge-base-en-v1.5'` **after** the embed worker's async warmup
resolves (embed.ts ~184-185), and the worker spawns **lazily on the first `embed()` call**. So a fresh
server that has not yet served a recall/write — or one pinged *concurrently* with its first embed before
warmup completes — reports `embed_model:"nomic-embed-text-v1.5-hash"` / `embed_on_hash_fallback:true`
even though the real backend is fully available and will load on first use. This makes `memory_ping`
**unreliable as a startup health check** (it cried "degraded" on a healthy server and sent two agents
chasing a non-bug). Same flaw in `memory_stats` (index.ts ~2246). Fix options: (a) `memory_ping`/`stats`
proactively trigger + await a one-token warmup embed before reporting; or (b) add a distinct
`embed_state: "uninitialized" | "real" | "hash-fallback"` so "not warmed up yet" is not conflated with
"fell back to hash". Verification of real-vs-hash must use a **post-warmup** ping (embed first, then ping)
or the absence of the `falling back to hash` stderr warning.
</details>

### BL-55 — every `memory_*` tool requires `db_path` with NO default → agents guess the magic path and miss the store — **Resolved + reality-verified (2026-06-25)**

**Fix:** `db_path` is now **optional** on every tool. New exported `resolveDbPath(arg)` in
`memory-server/src/index.ts` resolves: explicit arg → host-injected `SOX_CONFIG_DB_PATH` (the
`config.memory-server.db_path` bundle property, already injected at serve time via `buildExtConfigEnv`,
surviving the enforced env-scrub) → canonical `~/.memory/memory.db`. The half-built wiring is now
complete: the config-based default property was always delivered to the server, but the tools ignored it
and hard-required the arg — they now fall back to it. `db_path` removed from every `required` array in
both the served schemas (index.ts) and the catalog manifest (extension.json); descriptions updated to
"optional; defaults to the configured store"; `config_schema.required:["db_path"]` retained so the
bundle is always configured with the default source. The permission guard remains the backstop (a wrong
override is still denied loudly, no file created). 9 new `bl55-dbpath-default.spec.ts` tests (precedence
incl. default, blank-fallthrough, end-to-end write+recall with no db_path, explicit override isolation).

**Reality verification:** a served `node bin/soxe serve memory-server`, called `memory_recall` **without
`db_path`** (the exact pattern an agent botched as `~/.sox/memory`), returned real `["vec"]` results from
the injected configured store; the old `"db_path is required"` error is gone (absent from dist). Gates:
memory-server build (dist verified) + lint + test green (78 incl. bl55 9/9).

<details><summary>original report</summary>

Surfaced 2026-06-25: an agent intuitively called `memory_recall(db_path: "~/.sox/memory", …)`. That path
is wrong on two counts — the canonical single store is **`~/.memory/memory.db`** (19.6 MB, real), and
`~/.sox/memory` is neither the right dir (`.sox` ≠ `.memory`) nor a `.db` file. Root cause: `db_path` is
listed in the `required` array of **every** tool's input schema (index.ts: `required:['query','db_path']`,
`required:['content','db_path']`, …) with **no default**, so every caller must already *know* the magic
path. The CLAUDE.md guidance documents the `~/.memory/**` allowlist but never states "omit db_path to use
the default store," because there is no default. Agents therefore guess, and guess wrong.

Mitigation already in place (verified): the in-process permission guard hard-denies any `db_path` outside
the `~/.memory/**` allowlist — `db_path:"~/.sox/memory"` returns `{isError:true,"permission denied: …
outside declared fs allowlist"}` and creates **no file**. So a wrong guess fails *loudly*, it does NOT
silently read/write an empty store. **Residual footgun:** a wrong-but-inside guess (e.g.
`~/.memory/typo.db`) passes the guard and silently creates an empty db → empty results with no error.

Fix: make `db_path` **optional** and default to the canonical store the server already knows — the host
injects the `~/.memory/**` allowlist at spawn, so the server can default `db_path` to
`~/.memory/memory.db` (or a `SOX_CONFIG`-injected path) when omitted. Drop `db_path` from each tool's
`required` array, document "omit to use the default store" in CLAUDE.md, and keep the guard as the
backstop. This removes path-guessing entirely and is the permanent solve.
</details>

### BL-53 — `~/.memory` polluted with 842 orphaned WAL/SHM test sidecars; tests write to the real store dir — **Resolved**

**Fix (fix/memory-bl50-52-53):** (1) the two test paths that wrote per-pid dbs into the **real**
`~/.memory` now tear down the WAL/SHM sidecars alongside the base `.db` (`permission-guard.spec.ts`
afterEach + `test-e2e-lifecycle.js` cleanup, both iterating `['', '-wal', '-shm']`); (2) added a
one-shot safe reaper `tools/reap-memory-sidecars.cjs` — dry-run by default, `--execute` to delete,
removes only `*.db-wal`/`*.db-shm` whose base `.db` is absent, and **never** touches the canonical
`memory.db` (PROTECTED_BASES guard). Run `node tools/reap-memory-sidecars.cjs` (then `--execute`) to
purge the existing 842 orphans while the daemon is down.

<details><summary>original report</summary>

`~/.memory` holds **848 entries**: 421 `.db-wal` + 421 `.db-shm` (842 orphaned sidecars, base `.db` gone —
160 are `c6-allowed-<pid>.db-wal` from C6 permission e2e, plus `smoke-*`, `test-verify`, `sox-e2e-*`), only
**4 real `.db`** (`memory.db` canonical + 3 test artifacts), 1 `registry.json`, 1 `memory.db.bak`. Faults:
(1) tests create per-pid dbs under the **real** `~/.memory` dir instead of an isolated tmpdir, and leak the
WAL/SHM sidecars when the process is killed (no cleanup); (2) this miscounts as "848 per-scope stores" and
spooks tooling/agents into thinking there's a store-routing ambiguity (there is not — the only real store is
`~/.memory/memory.db`). Fix: point C6/e2e db fixtures at `os.tmpdir()` with teardown; add a one-shot reaper
for orphaned `~/.memory/*.db-wal|-shm` whose base `.db` is absent. Safe to purge the orphaned sidecars now
(never touch `memory.db`/`memory.db-wal`/`memory.db-shm` while the server/daemon is live).
</details>

## Open — service supervision gaps (2026-06-23)

### BL-50 — detached service-mode daemons survive `soxe stop`, accumulate into multiple writers, and have no OS reboot supervisor — **✅ CLOSED (all three halves) by `docs/spec/service-lifecycle.md` Slices 1/1.5/1.6/2**

> **Governed by [`docs/spec/service-lifecycle.md`](docs/spec/service-lifecycle.md) (v1.3.0).** That spec
> is the canonical framework. **Slice 1 (cross-scope singleton + reconcile heal)**, **Slice 1.5/1.6
> (front-shim service-proxy + proxy default)**, and **Slice 2 (OS-supervisor control surface +
> `[inv:unload-then-reap]`)** are all IMPLEMENTED. All three halves (a)/(b)/(c) below are now closed at
> the capability level; real OS-unit activation needs the human node-path ack (Appendix B item 3).

**Correction (2026-06-25, verified state-side).** The earlier "orphan-process reaper still open" claim
was **wrong** — it conflated "mem-fixes-2's diff added no reaper" with "no reaper exists." The
entrypoint-token orphan reaper **already exists** from the BL-31 work: `libs/host-runtime/src/reaper.ts`
(`findOrphansByIdentity`, `reapByIdentity`, `identityToken`, `killAndVerify`, dated Jun 22) +
`runtime.ts:reapOrphansForExtension`, and it **is wired** into `cmdStop` (`main.ts:3285,3311`) and the
`cmdStart` pre-spawn dedup (`main.ts:2956`). It finds PPID-1 detached daemons by whitespace-bounded
entrypoint argv token and SIGTERM→SIGKILL-verifies them; `soxe stop` exits 1 on any `undead`.

**What landed (fix/memory-bl50-52-53):** the **start-time singleton guard** — `cmdStart` resolves the
service's `lifecycle.health` socket (`resolveServiceHealthSocketPath`) and probes it
(`probeUnixSocketLive`); a live instance ⇒ refuse second spawn + record RUNNING. 15 tests.

**Status of each half (per spec v1.1.0):**

- (a) **Cross-scope singleton — ✅ CLOSED by Slice 1 (`feat/service-lifecycle-slice1`).** The guard no
  longer keys on the socket alone; it resolves `[def:singleton-key] = (id, resolved-store-resource)`
  (db_path → socket → host:port) and runs **socket probe + entrypoint-token scan + cross-scope
  ownership/collision check** before spawning, plus a §5.3 reconcile heal that kills the loser of a live
  duplicate pair (survivor = oldest-by-`ps -o lstart`; a single healthy daemon is never reaped). Two
  scopes that override `sock_path` but share `db_path` now collapse to one writer. Delivered:
  `libs/host-runtime/src/singleton.ts` (+ `singleton.spec.ts`, 32 cases) and the `cmdStart`
  service-registry guard (`resolveStoreResourceForScope`/`collectCrossScopeResources`/
  `entrypointTokenForService`) in `apps/sox/src/main.ts`. Gates (nx targets, built-before-test per BL-4):
  host-runtime test 146/146, soxe 30/30, `host-runtime:test-e2e` 99/0 (+6 Slice-1 Step 7c, stable ×3),
  `affected -t build,lint,test` 20/20 green, `registry:sync-index` no drift.
- (b) **OS reboot persistence + `[inv:unload-then-reap]`** — **✅ CLOSED (capability) by Slice 2
  (this worktree).** Built `libs/host-runtime/src/os-unit.ts` (launchd LaunchAgent generator,
  content-addressed; systemd seam pluggable) + `soxe service enable|disable|status|list` + the
  `[inv:unload-then-reap]` ordering wired into `cmdStop` (all paths), `service disable`, and
  `cmdUninstall` (unload the unit BEFORE the verified-stop reap → no resurrection loop), plus
  re-enable-on-upgrade (§9.3) and the `os-unit` ownership entry (§9.4 reversibility). Gates:
  host-runtime test 168/168 (+`os-unit.spec.ts` 22), install-engine 152/152, soxe 42/42
  (+`service-os-unit.spec.ts` 7), lint 3/3, build 3/3; e2e stop/reap/orphan/disable sections all PASS.
  **`(needs-human-ack)` for REAL activation:** generating + `launchctl bootstrap`-ing on the user's
  machine touches `~/Library/LaunchAgents` and pins a node binary (Appendix B item 3) — Slice 2 builds
  - tests the capability only (sandboxed unit dir + fake exec, `--dry-run` in the CLI test); the human
  runs `soxe service enable <svc>` to activate. **BL-50 is now fully closed across (a)/(b)/(c).**
- (c) **Zero-downtime upgrades without forced MCP reconnects** — **✅ CLOSED (capability) by Slice 1.5
  (`feat/service-proxy-slice1_5`).** Built as the leaf lib `libs/service-proxy/` (front-shim
  service-proxy / M3↔M4 bridge over Unix domain sockets) + an OPT-IN `--proxy` /
  `lifecycle.proxy:true` branch of `cmdServe`. Behavior-only backend upgrades resume sub-second with
  **no client reconnect**; an interface change emits `notifications/tools/list_changed` (reconnect only
  as a fallback). Zero-downtime is gate-proven by a real-process e2e (Section SP +
  `tools/probe-service-proxy-zdt.mjs`) and unit specs (service-proxy `nx test` 30 passed; e2e 100/0).
  **Deferred (separate future slice — NOT part of Slice 1.5):** migrating memory-server (or any
  existing server) to proxy mode — that flip changes the running server's process topology and has
  reconnect implications, so it ships as its own slice with the `run/serve/` serve-record breadcrumb
  (spec §2 Appendix-B item 1, most useful once a backend actually runs behind the shim).

Surfaced while wiring memory-daemon auto-supervision (the "item 3" cleanup). Two faults:

1. **Orphaned detached daemons are unreapable + accumulate.** `soxe start memory-daemon` runs the daemon
   in *service mode* (detached, PPID→1, no live supervisor). When the supervisor process is gone,
   `node bin/soxe stop` reports `supervisor (pid=…) already gone / stop complete` but **leaves the
   daemon running** — `soxe stop` only reaps processes a live supervisor tracks. Observed **two**
   memory-daemon processes alive simultaneously (one started this session via `soxe start`, one of
   unknown prior origin) = **two writers on `~/.memory/memory.db`**, violating the singleton invariant
   (design §2.4 R6: "host holds the per-(id,scope) singleton"). Need: a reaper that finds + SIGTERMs
   orphaned detached service processes by entrypoint/marker (cf. the BL-31 verified-stop work for the
   supervisor path), and a guard so `soxe start` refuses to spawn a second instance when one is already
   live on the socket.
2. **No reboot persistence.** There is no launchd/OS supervisor registered on service install, so a
   service does not survive logout/reboot. `soxe install` of a `service`-type extension should register
   an OS supervisor (macOS LaunchAgent), and `sox`'s runtime tracking should stay consistent with it
   (avoid sox-list/launchd split-brain). BL-47's in-process fallback covers enrichment *correctness*
   when the daemon is down, so this is robustness, not correctness.

**Update (2026-06-23):** the two-writer state is resolved — both orphaned daemons (PPID 1; one 14 min,
one 8.5 hr) were SIGTERM'd, socket removed, zero daemons now. A hand-rolled LaunchAgent was trialed then
reverted (unloaded/deleted) in favor of a proper soxe feature — see BL-51. Enrichment correctness is
currently covered by BL-47's in-process fallback (no daemon required), so "no daemon running" is a safe
state. The two faults above (orphan reaper + start-time singleton guard) remain open.

### BL-51 — `sox` needs a launch-agent / OS-supervisor control surface for `service`-type extensions — **✅ IMPLEMENTED (= spec Slice 2, v1.3.0 §9); REAL activation needs human node-path ack**

> **Governed by [`docs/spec/service-lifecycle.md`](docs/spec/service-lifecycle.md) §9 + Slice 2 — now
> BUILT.** Delivered in this worktree: `libs/host-runtime/src/os-unit.ts` (platform-pluggable generator
> — `LaunchdPlatform` rendering a content-addressed plist, `SystemdPlatform` proving the seam;
> `deriveOsUnitSpec` from the manifest `lifecycle` block; `resolveUnitNodePath` stable-node-path guard;
> idempotent `enableOsUnit`/`disableOsUnit`; `unloadThenReap` for `[inv:unload-then-reap]`) +
> `soxe service enable|disable|status|list` (`cmdService` in `apps/sox/src/main.ts`) + the `os-unit`
> ownership entry kind + teardown/re-enable hooks in `cmdStop`/`cmdUninstall`/`cmdUpgrade`. All effects
> are seam-injected (`unitDir`/`exec`) so unit + CLI tests run against a SANDBOX (`SOX_OS_UNIT_DIR` +
> `--dry-run`) — **no real `~/Library/LaunchAgents` write and no real `launchctl load` in any test**.
> **Remaining: REAL activation** (`soxe service enable <svc>` without `--dry-run`) writes to
> `~/Library/LaunchAgents` and pins a node binary — **needs the stable-node-path human-ack** (Appendix B
> item 3: `fs.realpathSync(process.execPath)` with volatile nvm/asdf/volta detection + the
> `--allow-volatile-node`/`--node-path` override). The orchestrator gates that on the user; the BL-47
> in-process fallback remains the supported zero-config path until the user activates a unit.

Persistence for service-type extensions (e.g. memory-daemon) should be a first-class soxe capability, not
a hand-rolled per-service plist. Proposed surface:

- **`soxe service enable|disable <ext> [-s <scope>]`** — register/unregister an OS supervisor for the
  service: macOS LaunchAgent (`~/Library/LaunchAgents/com.sox.<ext>.plist`), Linux systemd user unit
  (`~/.config/systemd/user/sox-<ext>.service`). `enable` writes the unit (RunAtLoad/KeepAlive +
  throttle + durable logs under `~/.sox/logs/`), loads it, and records it in sox's runtime tracking so
  `soxe list` reflects launchd/systemd-supervised services (no split-brain). `disable` unloads + removes.
- **Generated from the manifest** — derive `ProgramArguments`, `--db-path`/config env (the same
  `SOX_CONFIG_*` injection `soxe serve` does), `KeepAlive`, and `ThrottleInterval` from the extension's
  `lifecycle` block; resolve a stable node path (not a volatile nvm path) or pin via `EnvironmentVariables`.
- **Idempotent + content-addressed** — re-`enable` after an `upgrade` rewrites the unit if the resolved
  entrypoint/args changed; never leaves a stale unit pointing at an old artifact.
- **Reaper integration (BL-50 fault 1)** — `soxe stop`/`disable` must also reap an OS-supervised instance
  (unload the unit) so a service can't survive teardown, and `enable`/start must refuse a second instance
  when one is already live on the health socket.
- **Cross-platform + uninstall hook** — `soxe uninstall` of a service tears down its OS unit; `soxe doctor`
  surfaces orphaned/duplicate supervised instances.

This subsumes the "item 3" persistence work and the reboot-persistence half of BL-50. Until shipped,
the BL-47 in-process fallback is the supported path and no daemon need run.

### BL-58 — `tokenguard-core/src/mapper.ts` uses a lazy `require('./tokenize.js')` that breaks under vitest (`Cannot find module`) — **Resolved (`feat/service-lifecycle-slice1`)**

**Surfaced** while running `nx affected -t build,lint,test` for the service-lifecycle Slice 1 work
(tokenguard-core was marked affected only because the repo root `nx.json`/`package.json` are dirty from
prior uncommitted changes — Slice 1 does NOT touch tokenguard-core; `git diff main -- libs/tokenguard-core/`
was empty). `nx test tokenguard-core` failed 1/63: `Mapper.seed` did
`const { identifierGroupVariants } = require('./tokenize.js')` (`mapper.ts:119`), a runtime CJS require of
a `.js` sibling that only resolves against the built `dist/` — under vitest's `src` TS transform there is
no `tokenize.js`, so it threw `Cannot find module './tokenize.js'`. The lazy require was a workaround for
a **non-existent** cycle: `tokenize.ts` imports `Mapper` **type-only** (`import type`, erased at compile),
so there is no runtime value cycle.

**Fix:** converted to a static ESM `import { identifierGroupVariants } from './tokenize.js'` at the top of
`mapper.ts` and removed the inline require. Gates: `nx build tokenguard-core` ✅, `nx lint` ✅,
`nx test tokenguard-core` → **63/63** (was 62 + 1 failed). `registry:sync-index` → no drift (tokenguard's
shipped artifact checksum unchanged). Pre-existing latent bug (unchanged vs `main`), fixed in passing per
the zero-burying rule — NOT a Slice 1 regression.

## Resolved — pre-existing e2e failure surfaced during BL-45..48 verification (2026-06-23, fixed fix/memory-server-bl45-48)

### BL-49 — `#16728` auto-merge e2e fails: `syncResults.length === 0` (expected 2 project roots) — **Resolved**

**Fix:** the BL-35 leak guard in `knownProjectRoots()` (`mcp-project-sync.ts`) skips project roots under
`os.tmpdir()`, but the #16728 reality probe records its throwaway fixture roots there — so auto-merge
targeted 0 projects. Added a scoped opt-out: `knownProjectRoots()` honors `SOX_ALLOW_TMP_PROJECT_ROOTS=1`
(set only by `tools/probe-mcp-project-automerge.mjs`); production never sets it, so the BL-35 guard stays
in force everywhere else. Spec test added (`mcp-project-sync.spec.ts`) locking both the default-skip and
the opt-out. Verified: `host-runtime:test-e2e` → **93 passed, 0 failed** (auto-merge gate ALL PASS, got 2
roots); `install-engine` lint+build+test green. Origin (traced): pre-existing in BL-35 work (`d6805cf`),
not from BL-45..48.

<details><summary>original report</summary>

`npx nx run host-runtime:test-e2e` → 91 passed, **2 failed** (4 assertions): `AUTO-MERGE: targeted
both known project roots (got 0)`, `MERGE: project1/.mcp.json carries the same server entry`,
`MERGE: project2/.mcp.json created`, `MCP: #16728 auto-merge gate failed (exit 1)`. Source:
`tools/probe-mcp-project-automerge.mjs` / `tools/test-e2e-lifecycle.js`; feature owner
`libs/install-engine/src/mcp-project-sync.ts`.

**Origin traced (not deflection):** `git diff 3f5e7bb..HEAD -- libs/install-engine/src/mcp-project-sync.ts
libs/install-engine/src/index.ts` is **empty**; the only `apps/sox/src/main.ts` delta on the BL branch
is the `cmdServe` region (BL-46). The auto-merge code the test exercises is byte-identical to `main`, so
this failure is pre-existing in the `#16728` work merged in `2867b4f`/`fe42b90`/`3f5e7bb` immediately
before this session — the probe (added with #16728) ships red. `got 0` means the install hook found zero
known project roots to propagate the user-scope MCP entry into. Fix: investigate why `mcp-project-sync`
resolves 0 project roots from the install-registry in the sandboxed probe (likely a registry-root lookup
/ `SOX_ECOSYSTEM_HOME` resolution regression). The memory MCP lifecycle steps of the SAME e2e all pass
(install→start→exec memory_ping/write/recall→disable→enable→uninstall, 19 tools, zero orphans).
</details>

## Resolved — observability gap + daemon down (2026-06-23, fixed fix/memory-server-bl45-48 1a5f1ed)

### BL-46 — production `serve` (stdio MCP) path captures NO logs — **Resolved (opt-in sink); framework follow-up in spec Slice 1.5/3**

> **Spec follow-up (v1.1.0):** the opt-in `--log`/`SOX_SERVE_LOG=1` stderr sink resolved the immediate
> gap. The service-lifecycle spec makes the durable stderr sink the **default for M4 units** (§9.2) and
> adds a self-cleaning M3 **serve-record breadcrumb** under `run/serve/<extId>-<pid>.json` (Appendix B
> item 1 decision) so the live served version is observable + enumerable by `soxe list --serve`/`doctor`
> without a runtime.json lie. Designed in Slice 1.5/3; not yet built.

**Discovered while trying to diagnose BL-45 from server logs.** The logs do not reflect the running version.

- The live memory-server is launched from `.mcp.json` as `soxe serve memory-server` (stdio). `cmdServe`
  (`apps/sox/src/main.ts:4441-4454`) runs `execFileSync(node, [entrypoint], { stdio: 'inherit' })` —
  **no LogManager, no `logDir`, no file logging.** stdout *is* the JSON-RPC channel (consumed by the
  MCP client); stderr is whatever the client does with it (typically not persisted).
- Therefore the running v1.1.0 stdio server writes **nothing** to `~/.sox/logs`. Every file under
  `~/.sox/logs/*/memory-server-*.log` is from a *different* path — the supervisor/e2e LogManager
  (`cmdStart` / loader with `logDir`) — and they are **stale**: all dated 2026-06-22, `serverInfo`
  version **1.0.0** (the live server reports **v1.1.0**, artifact `67c4112f4518` via `memory_ping`).
  Zero logs exist for 2026-06-23 despite heavy use.
- **Consequence:** reading `~/.sox/logs` to debug the live server is a trap — it shows an *older*
  version's behavior. There is effectively no runtime observability for the in-use MCP server: server
  errors, embed warmup failures, hash-fallback warnings, permission denials, and the daemon's
  `[memoryd]` output are not durably captured. The original BL-45 incident has **no logs at all**.
- **Latent footgun:** because `serve` inherits stdout, ANY stray `console.log` in the server's request
  path corrupts the JSON-RPC stream. Server diagnostics must never use stdout.

**Fix sketch:** give `cmdServe` an opt-in durable log sink for stderr (e.g.
`<logDir>/<extId>-serve-<date>.log` via the existing LogManager, stderr only — never stdout), or a
`SOX_SERVE_LOG` env/flag. At minimum, document that `~/.sox/logs` does NOT cover the stdio `serve`
path and stamp the served version into a discoverable place. Affected: `apps/sox/src/main.ts` (`cmdServe`),
`libs/host-runtime/src/log-manager.ts`.

### BL-47 — `memory-daemon` service is INACTIVE; async batch enrichment is not running — **Resolved**

`node bin/soxe list` shows `memory-daemon  user  INACTIVE`. The daemon is a `service` with
`lifecycle.background:true, singleton:true` (`members/memory-daemon/extension.json`) and owns the
async enrichment loop (`runBatchEnrich`: clustering E6, auto-links E9, importance link-score E7,
decay E11). With it down, write-path `nudgeDaemon()` connects to nothing (fails silently — the queue
is durable but never drained), so **clustering / auto-links / importance / decay never run** for the
live `~/.memory` store. The `memory_write` tool description still advertises "Batch enrichments …
run asynchronously in the daemon" — which is currently false at runtime. Fix: ensure the daemon is
started/supervised (and auto-restarted) wherever the memory MCP is used, or fold the batch loop into
the server process on an interval. Relates to BL-45 (the contention there only manifests *when* the
daemon runs).

### BL-48 — `SOX_EMBED_BACKEND` default `auto` silently falls back to hash embedding; the only signal is an uncaptured stderr warning — **Resolved**

Distinct from (but worsened by) BL-46. `embed()` defaults to backend `auto` (`embed.ts:72`): it tries
the real ONNX/BGE worker and, if the worker can't spawn or the model isn't available, **silently
falls back to deterministic hash embedding** (`embed.ts:255-265`) emitting only a `console.warn` to
**stderr** — which the production `serve` path does not persist (BL-46). If a write process used real
embeddings but a recall process falls back to hash (or vice versa), the query vector lives in a
different space and **semantic recall degrades to near-random while still returning non-empty
results** — easy to misdiagnose. NB: this is NOT the same as `provider_call_count` — that counter is
**designed to stay 0** on reads (local inference never increments it; see "agent misdiagnosis" below).
Fix: surface the resolved backend in `memory_stats`/`memory_ping` (already pinned in `memory_scope`),
and emit a durable warning (or hard-fail when `SOX_EMBED_BACKEND=real` is required) on fallback.

> **Agent misdiagnosis recorded (2026-06-23):** another agent claimed "the embedding provider is
> offline (`provider_call_count: 0` on every recall) — semantic recall silently returns empty."
> **Both halves are false.** `provider_call_count: 0` is the *designed* value (embed.ts:49-50: counts
> external HTTP/provider calls only; the local ONNX backend deliberately does not increment it).
> Live test this session: queries returned non-empty, correctly-ranked results with `provenance:["vec"]`
> / `["vec","fts"]` — semantic recall works. The low score magnitudes (~0.01–0.03) are **RRF** fusion
> scores (`recall.ts:212`, `1/(k+rank)`), not cosine — also normal, not weakness.

## Resolved — concurrent-write stall (2026-06-23, fixed fix/memory-server-bl45-48 1a5f1ed)

### BL-45 — concurrent `memory_write` batch stalls for minutes; daemon re-runs full O(n²) enrich on every nudge — **Resolved**

**Symptom (reported):** a single parallel batch of 7 `memory_write` calls appeared to hang ~15 min
(5/7 eventually returned, 2 cancelled); the same writes issued serially returned promptly.

**Investigation (2026-06-23, evidence-backed — original "write-lock/embedding serialization within
the write" hypothesis was DISPROVEN):**

- The MCP server (`memory-server`) uses **synchronous** `better-sqlite3` on a **single cached
  connection** (`getDb`, `index.ts:254-260`). There is no intra-server multi-writer contention, and
  SQLite ops serialize harmlessly on the event loop.
- The embedding path is **concurrency-safe**: probe of 7 concurrent vs serial `embed()` (real BGE/ONNX
  backend, warm) = 2.10s vs 2.11s (slowdown 0.99×). fastembed/onnxruntime serializes `run()`
  internally; no thread oversubscription. The embed worker has no concurrency guard but doesn't need one.
- The in-server write path (`memoryWrite`: `await embed` + sync tx + sync `enrichOnWrite` KNN-21 +
  non-blocking `nudgeDaemon`) is sub-second per call.
- **Root cause (proven):** the separate `memoryd` daemon runs a **full-corpus** `runBatchEnrich` on
  **every nudge** (every write nudges it; after a non-empty drain it immediately `scheduleLoop(0)`,
  `memoryd.ts:148`). `runBatchEnrich` → `clusterStore` is **O(n²)** (pairwise cosine,
  `cluster.ts:231-236`; the degenerate guard can re-run that pass up to 4×) plus a full-corpus
  importance recompute wrapped in one write transaction. **Measured: ~10.5–11.0s per pass at the
  current corpus of 2,209 live episodes** (probe on a copy of `~/.memory/memory.db`), growing
  quadratically.
- **Amplifier:** that batch pass holds the SQLite **write lock**. Because the MCP server's
  better-sqlite3 calls are synchronous, a write that loses the lock race **blocks the entire server
  event loop** up to `busy_timeout=5000ms` (`schema.ts:8`) — stalling *all* in-flight writes and their
  embed-worker response handling, not just the contending one. N concurrent writes serialize behind
  repeated ~11s full passes, each successful write triggering yet another pass → compounds to minutes.

**Confidence caveat (added 2026-06-23):** the daemon contention above is the cause **only when
memoryd is running**. Per BL-47, `memory-daemon` is currently **INACTIVE**, and there are no logs
from the incident (BL-46), so this mechanism is a **proven latent defect** (measured O(n²), ~11s/pass,
per-nudge full re-enrich) but is **not confirmed (unverified)** as the cause of the specific 7-write
stall. If the daemon was down during the incident, the stall was likely client-side (parallel
tool-call approval/queueing) and/or first-call cold model load, not daemon lock contention. Both the
latent defect and the daemon-state question need fixing regardless.

**Fix sketch (in priority order):**

1. **Incremental write-triggered clustering.** `cluster.ts` already has an `incrementalOnly` option
   (local-neighborhood check for new nodes). Route ingest-triggered enrich to incremental; reserve the
   full O(n²) re-cluster for a periodic/time-based trigger or explicit `memory_curate recluster`.
2. **Debounce/coalesce daemon passes.** Don't run one full `runBatchEnrich` per nudge — collapse a
   burst of ingest rows into a single pass and add a cooldown before the next full pass (the immediate
   `scheduleLoop(0)` after a non-empty batch is the back-to-back trigger).
3. **Chunk the importance transaction** so the daemon yields the write lock between chunks instead of
   holding it across all 2,209 episodes.

**Affected:** `libs/memory-enrich/src/{batch,cluster}.ts`, `libs/memory-core/src/memoryd.ts`,
`libs/memory-core/src/schema.ts` (busy_timeout). NB: any code change here triggers the full
build → `registry:sync-index` → `upgrade --all` sequence (CLAUDE.md agent sequence).

## Open — surfaced by the filtered-clustering review (2026-06-22)

> Deferred (non-blocking) findings from the architect + code review of branch
> `memory-enrich/filtered-clustering`. The merge-blocking findings (read-side scoping,
> structured-filter engine boundary, `nx.json` stale organizer, unreachable `'enrich'` op,
> done-on-failure, tags guard) are being fixed in the fix wave, not logged here.
> Full writeups: `docs/plan/filtered-clustering/REVIEW-architecture.md` + `REVIEW-code.md`.

### ~~BL-25~~ — three divergent `memoryd.ts` copies; member copies lack reembed-on-reindex — **Resolved** (`8a5246e`)

**Severity:** Medium (stale vectors) · **Status:** Resolved — converged all three onto `@adhd/sox-memory-core` (members are thin re-exports; single `MemoryDaemon`; reembed-on-reindex on the daemon path; C7-clean; e2e 63/0 proves the bundled daemon still spawns).
After P6, `memory-daemon`, `memory-server`, and `memory-core` each carry a `memoryd.ts`; the
member copies the daemon actually runs **lack the reembed-on-reindex path** that `memory-core`'s
copy has → vectors go stale after an embed-backend change. Fix: converge all three on
`@adhd/sox-memory-core` (the C7 single-source pattern) so there is one daemon implementation.

### ~~BL-26~~ — subset-lens communities have no GC / drop-by-hash reaper — **Resolved** (`8a5246e`)

**Severity:** Medium (unbounded accumulation) · **Status:** Resolved — added `dropSubsetLens`/`listSubsetLenses` in `@adhd/sox-memory-enrich` + `memory_curate` `drop_lens`/`list_lenses` ops (CONTRACTS C2.11); persisted lenses are now GC-able by provenance hash, leaving global + other lenses intact.
Persisting a filtered recluster (`memory_curate recluster` + `filters`, `dry_run:false`) writes a
provenance-scoped community slice keyed on the filter hash. Only an exact re-run of the *same*
filter reaps its prior slice — distinct/one-off filters leave orphaned subset communities that
accumulate with no reaper. Fix: add a `drop-by-hash` curation op (or a TTL/GC pass), or document
subset lenses as ephemeral with the accumulation caveat. Gated behind the persist path being
read-side-scoped first.

### ~~BL-27~~ — filtered-clustering review LOW findings (bundle) — **Resolved** (`8a5246e`)

**Severity:** Low · **Status:** Resolved — (1) empty-filter persist guard added; (2) dead branch removed from `computeClusters`; (3) server persist-path (`dry_run:false`) test added; (4) idempotent `organizer_queue` CHECK migration for `'enrich'`.
From `REVIEW-code.md`: (1) an empty-filter subset duplicates the global partition under a hash;
(2) dead branch at `libs/memory-enrich/src/cluster.ts:507-509`; (3) no server-level persist-path
(`dry_run:false`) test; (4) no migration for the `organizer_queue` CHECK-constraint change on
pre-existing DBs (`'enrich'` op added). Address opportunistically.

### ~~BL-28~~ — near-dup `SAME_AS` edge insert had a 7-col/8-value mismatch — **Resolved** (`06579d4`)

**Severity:** High (write-path crash) · **Status:** Resolved
`libs/memory-enrich/src/enrich.ts` inserted the near-dup `SAME_AS` edge with `INSERT INTO edge
(7 cols) SELECT … 8 values` (a spurious trailing `NULL`), throwing a SQLite column-count error on
**any near-duplicate write** under `enrichOnWrite`. No test exercised the path (the hash-backend
guard requires a shared MENTIONS entity, which `enrichOnWrite` alone never creates), so it slipped.
Fixed (removed the extra `NULL`) + added a real-backend regression test in `enrich.spec.ts` that
drives the `SAME_AS` insert. Found during the filtered-clustering review reconciliation.

### ~~BL-29~~ — intermittent embed-worker path flake under parallel vitest (`nx run-many test`) — **Resolved** (`8a5246e`)

**Severity:** Low (test-infra, intermittent) · **Status:** Resolved — `embedWorker.js` now resolves via a module-anchored absolute path (dist sibling, with a `src→dist` fallback), fork-cwd-independent. A separate pre-existing real-embed timeout flake in `write.spec.ts` (surfaced under the same run-many load) was also fixed by pinning the hash backend for those persistence tests.
Observed once during the `memory_update` engagement: running `memory-core` + `memory-server`
`test` targets together under a single `nx run-many` invocation intermittently fails with the
embed worker unable to resolve `embedWorker.js` (worker-thread path resolution under vitest's
parallel fork pool). **Not reproducible on re-run** (the same `run-many` is green), and all
sequential/CI gates pass. **This is NOT BL-4** (BL-4 is stale-`dist`/composite build hygiene) —
flagging the misattribution. Root-cause: the `new Worker(workerPath)` path in `embed.ts` resolves
relative to the built file; under parallel vitest forks the cwd/resolution can differ. Fix sketch:
resolve `embedWorker.js` via an absolute `import.meta.url`/`__dirname`-anchored path so it is
fork-cwd-independent. Low priority — only the parallel test runner is affected, not runtime.

### ~~BL-30~~ — `memory-server` manifest version stuck at 0.1.0 despite v1.1.0 tool surface — **Resolved** (this commit)

**Severity:** Low (version inconsistency) · **Status:** Resolved
The P4 and `memory_update` "version bumps" only touched the runtime `tool_version` string + the
source header comment — never the extension **manifest** `version`. So `extension.json` /
`package.json` read **0.1.0** while the tool surface + docs claimed **1.0.0 / 1.1.0**, and the
user-scope install resolved `memory-server@0.1.0`. Functionally harmless (upgrades are
checksum-driven, not version-driven), but a three-way inconsistency. Fixed: bumped
`memory-server` `extension.json` + `package.json` to **1.1.0**, the bundle `members[]` constraint
to `^1.1.0` (a `^0.1.0` constraint would have rejected 1.1.0), and the stale `tool_version: "1.0.0"`
line in CLAUDE.md → 1.1.0; resynced the registry. Surfaced when refreshing the user-scope install.

### ~~BL-31~~ — `soxe stop` doesn't verify the kill or escalate to SIGKILL; orphaned daemons survive — **Resolved** (`b1d4005`)

**Severity:** High (zombie process can keep hitting a removed dependency) · **Status:** Resolved — `host-runtime/reaper.ts`: `killAndVerify` (SIGTERM → poll `process.kill(pid,0)` → SIGKILL escalation after grace → re-verify) + store-path orphan reaper (PPID-1, identity-matched, whitespace-bounded so unrelated processes are spared); `cmdStop` exits 1 on undead; `cmdStart` dedup-reap guard. e2e Step 7b reproduces the exact incident (real PPID-1 memory-server orphan DEAD after stop, unrelated SPARED). The original Open writeup follows.
During the memory upgrade, the running pre-P6 `memory-daemon` (pid 33079, started before the
store refresh) had been **orphaned (PPID 1 — its supervisor had exited)**. `soxe stop
--id=memory-daemon` sent it **SIGTERM, reported "stop complete", and returned** — but the process
**never died** (its old-code shutdown path hung on in-flight LLM/LM-Studio requests, or ignored the
signal). `soxe start` then spawned a *second* daemon (pid 43867) from the refreshed deterministic
store, leaving **two daemons** — the orphaned old one kept draining its organizer queue against
LM Studio (`localhost:1234`) until manually `kill -9`'d. Root gaps: (1) `stop` is fire-and-forget
SIGTERM with **no post-signal liveness check and no SIGTERM→SIGKILL escalation/timeout**; (2) the
runtime has **no reaper for orphaned daemons** — once the supervisor link breaks (PPID 1) it can
only signal a tracked pid and never confirms death or matches by store path (`.sox/ext/<id>`).
This is the failure mode the `runtime-productionization` SIGKILL-escalation / stale-state-GC work
targets, but it does not cover an already-orphaned process whose supervisor is gone. Fix: `stop`
must poll-verify exit and escalate to SIGKILL after a grace period; add a store-path-matched reaper
for orphaned daemons. Discovered diagnosing "a ton of requests going to LM Studio."

### ~~BL-32~~ — make per-extension versioning real (single-source propagation) — **Withdrawn** (superseded by ADR-0003)

**Status:** Withdrawn. Investigating BL-30 surfaced that per-extension semver is **vestigial** — the registry holds one build per id (semver never resolves), `semverSatisfies` arrived with the nx migration, and the checksum is the sole integrity authority. **ADR-0003** retires per-extension version entirely (identity = `id + checksum`), so "make versioning real" is moot. See `docs/decisions/0003-extension-identity-is-content-addressed.md`.

### BL-33 — `check-registry-sync.ts` scanner doesn't recurse into bundle members → false drift — **RESOLVED** (publishing refactor)

**Severity:** Medium (false CI-gate failure) · **Status:** Resolved — `scripts/check-registry-sync.ts`'s
`findExtDirs` now recurses into `extensions/bundles/<id>/members/` (BL-33 fix block, lines ~91-103),
faithfully mirroring `scripts/build-index.ts` — bundle members are no longer false-flagged. The
publishing refactor additionally mirrored the new `SOX_REGISTRY_PUBLISH` publication-signal branch of
`resolveSource` into the gate so the two stay byte-identical under both dev (`file://`) and publish
(`npm-package:`) modes. The original Open writeup follows.
`scripts/check-registry-sync.ts`'s inlined `findExtensionDirs` does **not** scan
`extensions/bundles/<id>/members/`, so it flags `memory-cli/daemon/flush/server/usage` as "in
registry, not on disk." Reproduces identically against HEAD (pre-ADR-0003) — a latent bug in the
`check-registry` gate's scanner, not in the run-many/test/e2e gate. Fix: make its scanner recurse
into `members/`, matching `scripts/build-index.ts`. Surfaced during the ADR-0003 implementation.

### BL-34 — `sox` app entrypoint path is not index-resolvable → checksum hashes `extension.json` — **RESOLVED** (publishing refactor)

**Severity:** Low · **Status:** Resolved — the publishing refactor made `@adhd/sox-cli` a
self-contained, in-package esbuild bundle: `apps/sox/extension.json` `entrypoint` is now
`dist/index.js` (resolvable relative to `apps/sox/` → `apps/sox/dist/index.js`, the bundle), so
`resolveChecksum`/`fetchArtifact` checksum the *built artifact* like every other code type instead of
falling through to the manifest. `apps/sox/package.json` `main`/`bin` are now in-package
(`./dist/index.js`, `./bin/soxe.mjs`) — no more `../../`. The original Open writeup follows.
The `sox` app declares entrypoint `dist/apps/sox/main.js`, which isn't resolvable relative to
`apps/sox/`, so `resolveChecksum` falls through to hashing the manifest (`extension.json`) instead
of the built artifact. Works (and correctly changed when ADR-0003 removed `version`), but the sox
entrypoint should be index-resolvable so its checksum tracks the *built* artifact like every other
code type. Surfaced during the ADR-0003 implementation.

### BL-35 — `install()` test runs pollute the real install-registry (no path injection)

**Severity:** Medium (test isolation; live ledger pollution) · **Status:** RESOLVED (2026-06-23)
Any spec that calls `install()` (e.g. `integrity.scope.spec.ts`) triggers `upsertInstallRecord`,
which uses `resolveInstallRegistryPath()` → `installRegistryPath()` → `dataRoot('user')` →
`$SOX_ECOSYSTEM_HOME`. The leaky specs (`integrity.scope.spec.ts` — `adr3-scope-*` roots,
`lifecycle.spec.ts`, `verify-integrity.spec.ts`) sandboxed `configPath`/`lockfilePath` but NOT
`SOX_ECOSYSTEM_HOME`, so the registry write escaped to the **real** `~/.adhd/sox-ecosystem/
install-registry.json` (observed grown to ~480 records).

**Permanent fix shipped (2026-06-23):** a suite-wide vitest `setupFiles`
(`libs/install-engine/vitest.setup.ts`) now points `$SOX_ECOSYSTEM_HOME` at a throwaway temp dir
for the whole install-engine test process — isolating the install-registry, ledger AND ownership
writes of every spec (including ones not yet written, so the leak cannot regress). Verified: a full
`nx test install-engine` run leaves the real registry record-count **unchanged (delta 0)**, 151/151
green. The one spec that asserts the genuine DEFAULT data root (`capabilities.spec.ts ›
defaultStoreRoot`) temporarily clears the override (string-only, no I/O). Defense-in-depth from the
same engagement: `knownProjectRoots()` skips any project root under `os.tmpdir()` (regression test
in `mcp-project-sync.spec.ts`), so even a stray leak can never fan `upgrade --force` out again. The
~480 leaked live records + 120 junk `/tmp` `.mcp.json` were purged as a one-off (registry → 6,
`memory-server` ownership → 2). Surfaced building `upgrade --all`; root-caused fixing the
migrate-home untracked-MCP-injection bug.

### BL-36 — runtime record hardcodes `type: 'mcp-server'` for every detached service

**Severity:** Low/Medium (misleading `soxe list`/`status`; type unreliable) · **Status:** Open
`cmdStart`'s service-registry start path writes `type: 'mcp-server'` into the runtime record for
**every** detached service, so the runtime entry's `type` can't distinguish a `service` from an
`mcp-server`. `rollingRestartConsumer` works around it by classifying from the manifest, but
`soxe list`/`status` may still mislabel services. Fix: record the real manifest `type` at start.
Surfaced building the rolling-restart classifier.

### ~~BL-37~~ — `memory-daemon` service-store copy can't resolve `@adhd/sox-memory-core` → crashes on start — **Resolved** (`b3bf0d8`)

**Severity:** High (the supervised daemon is fully down in service mode) · **Status:** Resolved — dual-output build: `tsc` keeps `dist/index.js` as the registry-checksum anchor + `tools/bundle-extension.cjs --entry src/bin.ts --outdir bundle` produces a self-contained esbuild bundle (native addons external, resolved via an injected `NODE_PATH=<workspaceRoot>/node_modules` in the run-service spec). A **second stacked bug** was found: the manifest entrypoint `dist/index.js` only re-exports — the real `daemon.start()` is `bin.ts`, so spawning `index.js` was a no-op that exited immediately (the "started then gone" symptom); bundling from `bin.ts` fixes it. e2e **Section E** now spawns the daemon from a **copied store** and asserts it starts + stays up. The original Open writeup follows.
BL-25 converged the daemon's `memoryd` onto `@adhd/sox-memory-core` (thin re-export →
`require('@adhd/sox-memory-core')`). The **service-mode copied store** (`.sox/ext/memory-daemon/`) has
no resolvable `@adhd/sox-memory-core` (not self-contained-bundled, no node_modules link), so the daemon
crashes on start: `Error: Cannot find module '@adhd/sox-memory-core'` (exits immediately; `soxe list`
shows INACTIVE with a dead pid). **`memory-server` (stdio) is unaffected** — it runs from the repo
where the dep resolves. **Gate gap:** the lifecycle e2e spawns the daemon from the *repo* (deps
resolve), never from a copied service store, so this slipped all gates. Fix: self-contained-bundle
the daemon (esbuild, C7-respecting — the bundled-extension-build-standard) so the copied store has
zero external `@adhd/sox-*` deps, AND strengthen the e2e to spawn the daemon from a copied store.
Discovered starting the daemon during the content-addressed deploy.

### BL-38 — `memory-server` shares the daemon's latent `tsc`-bare-`@adhd/sox-*`-requires shape + a stale tracked `bundle/` — **RESOLVED** (publishing refactor)

**Severity:** Low (latent; not on a copied-store path today) · **Status:** Resolved — the publishing
refactor migrated `memory-server`'s build off bare `tsc` to a SELF-CONTAINED esbuild bundle
(`tools/bundle-extension.cjs --entry src/index.ts --external better-sqlite3 --external sqlite-vec`),
so `dist/index.js` carries **zero** bare `@adhd/sox-*` requires (verified: `grep -c 'require("@adhd'`
= 0) — it now runs from a copied/npm-package store exactly like the daemon. `gen-schema.cjs` derives
`dist/schema.json` from the bundle via a new `--emit-schema` flag (no separate `dist/backend.js`
needed). `memory-cli` and `memory-flush` got the same treatment (they transitively use better-sqlite3
via memory-core). Part (2) (stale `bundle/`) was already resolved (`2867b4f`). Proven offline: the
published memory-server tarball installs with native deps via `npm install` and answers `memory_ping`
with a content address; `sha256(local dist) == sha256(npm-installed dist) == ping.artifact`. The
original Open writeup follows.
Surfaced during the BL-37 fix. (1) `memory-server` builds with `tsc` and its `dist` carries bare
`require("@adhd/sox-memory-core")` etc. — it only resolves because it runs **stdio from the repo**
(`soxe serve`), never from a copied store. If an `mcp-server` is ever materialized to a `.sox/ext/`
store it will crash exactly like the daemon did — give it the same self-contained `bundle-extension`
treatment then. (2) `memory-server` ships a **stale, orphaned tracked `bundle/`** dir from a one-off
bundler run; its `project.json` build uses `tsc` and nothing references the dir — dead tracked
output to delete + gitignore. Neither blocks anything today. **(2) RESOLVED** (`2867b4f`): the orphaned `bundle/` was untracked + gitignored (it was a 2.4MB dead artifact; runtime uses `dist` via `soxe serve`); the BL-41 probe now builds a self-contained bundle on-demand. **(1) still open** — the latent `tsc`-bare-`@adhd/sox-*` shape (only matters if an mcp-server is ever materialized to a copied store).

### ~~BL-39~~ — `upgrade --all` / `install(mode:update)` re-pins the lockfile but does NOT re-materialize the copied service store — **Resolved** (`ca20ecf`, ADR-0004)

**Severity:** High (upgrade leaves a running service on stale code) · **Status:** Resolved — ADR-0004's ownership index drives `rematerializeServiceStores`: `update`/`upgrade` now clear the old store and re-copy the new artifact (previously only fresh install re-materialized). The original Open writeup follows.
A `type:service` extension runs from a **copied store** (`.sox/ext/<id>/`). `upgrade --all` (via
`install({mode:'update'})`) re-pins the lockfile checksum but **never re-copies the store**, so after
an upgrade the daemon keeps running the store copy from its **original** install. Observed live: post
`@sox`→`@adhd` rename + BL-37 fix, `upgrade --all` reported `memory-daemon user → upgraded` yet
`.sox/ext/memory-daemon/` still held the pre-rename `@sox` `dist` copy (`require("@sox/memory-core")`)
→ crash on start. Only a **fresh** install (`mode:default` — `uninstall`+`install`, or `install
sox-memory-bundle`) re-materialized the store (with the self-contained `bundle/`) → daemon then
started and stayed up. Root: the daemon's lockfile `source` is the **repo `dist/index.js`**
(checksum-current), so `verifyIntegrity` sees "current" and re-pins without re-copying; and the
checksum anchor tracks the repo `dist/`, not the materialized `bundle/` that's actually deployed.
This directly undermines the upgrade tooling's promise (refresh running code + rolling restart). Fix:
`install(mode:update)` must **re-materialize the service store** when the artifact changed, and the
service checksum anchor should track the materialized `bundle/`. Discovered deploying the daemon
post-rename. (Workaround applied for this deploy: `install sox-memory-bundle --scope=user`.)

### ~~BL-40~~ — `soxe install <mcp-server>` wrote `command: "sox"` (Homebrew audio-tool collision) — **Resolved** (`00e7f9e`)

**Severity:** High (silent MCP spawn failure) · **Status:** Resolved
`libs/install-engine/src/install.ts` fell back to `command: 'sox'` when `SOX_CLI_BIN` was unset, so
`soxe install <mcp-server> --scope=user` registered a spawn command of `sox` — which on macOS is the
Homebrew **audio** tool, not the extension CLI → the MCP server failed to spawn silently. Fixed:
`SOX_CLI_BIN ?? process.argv[1] ?? 'soxe'` (explicitly never `'sox'`), proven by e2e D5. Surfaced
diagnosing MCP global-availability.

### ~~BL-41~~ — `db_path` with a literal `~` is not expanded → creates a literal `~/` directory — **Resolved** (`2867b4f`)

**Severity:** Low/Medium (stray dirs; allowlist confusion) · **Status:** Resolved — single `expandDbPath()` applied at every memory-core sink (`openDb`/`openDbReadOnly`/daemon ctor) + once at memory-server dispatch, so guard + cache + sink agree; e2e Section BL41 proves `~/.memory/x.db` writes under `$HOME` with no literal `~` dir. The original Open writeup follows.
A `memory_*` call with `db_path: "~/.memory/memory.db"` (the literal string the skill docs show) is
**not tilde-expanded** by the server before `openDb` — so a literal `~` directory is created relative
to the server's cwd (observed: `extensions/.../memory-server/~/.memory/memory.db`). The server must
expand `~`→`$HOME` (consistently for the allowlist check AND the file open), or reject an unexpanded
`~`. Surfaced cleaning a stray artifact during the MCP-availability work.

### BL-42 — install model is checkout-bound: cannot publish packages or install on a fresh machine — **RESOLVED (publish-ready; owner-gated for the real npm publish)**

**Severity:** High (distribution blocker) · **Status:** Resolved in the worktree — the publishing &
distribution refactor (`docs/plan/publishing/`, ADR-0005) makes the whole system publishable +
fresh-machine-installable: all 12 `@adhd/sox-*` libs + CLI + every extension/bundle member are
publish-ready (private flipped, `publishConfig`/`engines`/`files`, in-package CLI `bin`/`dist`);
`build-index` emits portable `npm-package:` sources under `SOX_REGISTRY_PUBLISH` (zero `file://`);
the fetcher has an `npm-package:` install mode that runs a real `npm install` so native deps resolve;
extensions are self-contained esbuild bundles (zero `@adhd` runtime deps); the CLI ships a bundled
registry. **Proven offline** by `scripts/acceptance/clean-room-smoke.sh` (verdaccio clean room, no
checkout): `npm i -g @adhd/sox-cli` → `soxe --version`/`search` (G1), `soxe install
sox-memory-bundle` resolving every member from npm with native deps (G2), `memory_ping` green with a
content address. The real `pnpm release` to PUBLIC npm is the one remaining owner-gated step (a
one-way door) — see PUBLISHING.md. The original Open writeup follows.

Today every resolution path points at **this checkout on this machine**. A fresh machine
(or any consumer that didn't build the repo locally) cannot install or run a single extension.
Evidence (2026-06-23):

- **`registry/index.json` sources are absolute local `file://` URLs** —
  `file:///Users/nix/dev/ai/sox-ecosystem/extensions/...` for all 14 entries. The registry is
  not a portable/publishable artifact; on another machine those paths don't exist.
- **Lockfiles pin absolute local dist paths** —
  `~/.adhd/sox-ecosystem/extensions.lock` resolves `memory-server` →
  `file:///Users/nix/dev/ai/sox-ecosystem/.../dist/index.js`. Content-addressed identity
  (ADR-0003) is computed against locally-built `dist`, so a fresh machine has neither the
  artifact nor a way to fetch it.
- **MCP spawn command is an absolute repo path** — `~/.claude.json` →
  `mcpServers.memory-server.command = /Users/nix/dev/ai/sox-ecosystem/bin/soxe`. Won't exist
  on a fresh machine; there is no globally-installed `soxe` to fall back to.
- **Shipped extensions depend on `@adhd/sox-*` via `workspace:*`** (memory-server/cli/flush
  package.json). `workspace:*` only resolves inside the pnpm workspace; a published package
  carrying it 404s on `npm/pnpm install` (this exact failure already hit `@adhd/sox-tokenguard-core`
  — see the protocol fix `dabe9ea`). Self-contained esbuild bundling (BL-37/BL-38) inlines these
  for the *service* members, but the dependency-graph publish story is unsolved.
- **Root `package.json` is `"private": true`** and no `@adhd/sox-*` lib is actually published; the
  scope is owned but empty on npm.

**What "publishable + fresh-machine-installable" requires (fix sketch):**

1. **Decide the distribution substrate** — publish `@adhd/sox-*` libs + the `soxe` CLI to npm
   (changesets is already wired: `version-packages`/`release` scripts), OR ship fully self-contained
   bundles addressed by a fetchable URL/tarball, not `file://`.
2. **Make the registry portable** — `build-index` should emit relative or resolvable
   (registry-URL/tarball) sources, not absolute `file://` paths; add a publish step that uploads
   artifacts and rewrites sources.
3. **Rewrite `workspace:*` → real versions on publish** (changesets does this for libs; the
   extension members need the same, or must bundle their deps).
4. **Resolve the CLI command portably** — a globally-installed `soxe` (npm bin) or a per-install
   shim, so `mcpServers.*.command` is `soxe`/`npx soxe`, not an absolute repo path.
5. **Fresh-machine acceptance test** — `npm i -g @adhd/soxe` (or equivalent) → `soxe install
   sox-memory-bundle --scope user` → `memory_ping` green, in a container with **no repo checkout**.
   This is the reality gate; nothing is "publishable" until that passes.

**Versioning-system findings (2026-06-23, confirmed while writing `PUBLISHING.md`).** The publish
pipeline is Changesets (canonical — `.changeset/` + `@changesets/action` in `release.yml`, which
DOES rewrite `registry/index.json` sources to npm-CDN URLs post-publish, i.e. the fix for blocker
# 1 above). The **safe, unambiguous defects are now fixed** (this turn):

- ✅ **Changeset tooling was non-functional** — `pnpm-workspace.yaml`'s `libs/**`/`apps/**`/
  `packages/**` recursed into gitignored `dist/` dirs whose build-emitted `package.json` (no `name`)
  made `@manypkg`/`changeset status` error out. Fixed by excluding `!**/dist/**` + `!**/node_modules/**`;
  `changeset status` now lists the 4 valid members.
- ✅ **Dual versioning systems** — removed the conflicting, CI-unused `nx.json` `release` block;
  Changesets is now the single source of truth.
- ✅ **Stale changesets** — removed the deleted `@adhd/sox-extension-memory-organizer` refs from
  `sox-memory-p0/p5.md`; deleted `hello-world-minor.md` (referenced non-existent
  `@adhd/sox-extension-hello-world`).

The remaining items are **strategy decisions**, split into **BL-43**.

Playbook + full confirmation: [`PUBLISHING.md`](./PUBLISHING.md) → *Current state*.

Surfaced answering "is there a backlog item about publishing for a fresh machine?" — there was not.

### BL-43 — publish-strategy decisions for `@adhd/sox-*` (libs, CLI, bundle members, first release) — **RESOLVED** (owner-ratified + implemented)

**Severity:** High · **Status:** Resolved — the owner ratified the strategy in
`docs/plan/publishing/DECISIONS.md` (D-A…D-F) and it is implemented by the publishing refactor:
(1) **libs** → publish ALL 12 public (D-A=A1); extensions stay self-contained bundles (Model A,
ADR-0005) so published artifacts carry zero `@adhd` runtime deps; (2) **CLI** → published with
in-package `bin: { soxe }`, `engines.node>=20`, self-contained bundle (D-F=F2); (3) **bundle
members** → all published incl. daemon/usage (Q3); (4) **first release** → stale `sox-memory-p0/p5`
changesets removed, replaced by one coherent `publishing-refactor` changeset (R7). A
`check-publishable` gate prevents the 404 class from regressing. The original Open writeup follows.

The mechanical publish defects are fixed (see BL-42). What remains are **decisions** that only the
owner can make, because they put code on the public `@adhd` npm scope:

1. **Libs: publish vs. bundle.** `@adhd/sox-authoring|-host-runtime|-install-engine|-manifest|
   -registry|-memory-core` are `private: true`, yet the public extensions depend on them via
   `workspace:*` → those deps **404 on publish**. Pick one, consistently:
   - **(a) Publish the libs** — flip `private:false` + add `publishConfig.access=public`; changesets
     rewrites `workspace:*` → the real version at publish. Exposes the engine internals on npm.
   - **(b) Bundle them** — esbuild-inline every `@adhd/sox-*` dep into each published extension (as
     BL-37/38 already do for the service members) so published artifacts carry **no** `@adhd/sox-*`
     runtime deps. Keeps libs private.
2. **CLI publishability.** `@adhd/sox-cli` (apps/sox) is `private: true` with no published `bin`. The
   fresh-machine entry point (`npm i -g @adhd/sox-cli` → `soxe …`) requires it published with a
   `bin: { soxe }` and an `engines.node` pin.
3. **Bundle-member publish model.** `memory-daemon` is `private: true` (internal to the bundle, no
   independent publish). Confirm this is intentional for ALL non-server members, and that the bundle
   artifact carries them — *then* no per-member changeset is needed (a daemon changeset was
   deliberately NOT added for this reason). Document the rule in `PUBLISHING.md`.
4. **First-release planning.** The surviving `sox-memory-p0/p5.md` changesets describe historical
   "stubs only / Phase N" churn and would bump `memory-server` (already manually at 1.1.0) with a
   misleading changelog. Before the first real publish, consolidate them into one coherent
   first-release changeset reflecting the CURRENT shipped state, not the phase history.

Acceptance: BL-42's fresh-machine container smoke passes.

### ~~BL-44~~ — `nx test` caching was dependency-blind: an upstream source change did NOT invalidate a dependent's test cache — **Resolved** (this turn)

**Severity:** High (cache lies — CI/local could report a stale green against changed upstream code) ·
**Status:** Resolved 2026-06-23.

All 15 `test` targets overrode `inputs` in their `project.json` with only their own
`{projectRoot}/src/**/*.ts` (+ a couple of hardcodes). Project-level `inputs` **replace** (do not
merge with) the `nx.json` targetDefaults `["default", "^production"]`, so every test target **dropped
`^production`** and had **no `dependsOn`** → the test cache was keyed on the project's own files only.
**Proven** (before fix): changed `libs/memory-core/src/index.ts` → `nx test memory-server` still served
a **cache hit**, although nx knows the `memory-server → memory-core` edge. The exact "cache lies"
hazard (cf. BL-4, MEMORY `eim-plan-cache-lies-reality-gates`). A change to `vitest.config.ts`/
`vitest.setup.ts` also didn't invalidate (those files weren't in the narrowed inputs).

**Fix (verified):**

- Set every test target's `inputs` to `["default", "^production"]` — `default` tracks the project's
  own files incl. vitest config/setup; `^production` tracks **upstream** sources. (install-engine keeps
  its extra `{workspaceRoot}/libs/host-runtime/src/data-paths.ts` parity reach-in — it has no nx graph
  edge to host-runtime.)
- Added `dependsOn: ["^build"]` to the `test` targetDefault so a test runs against **freshly-built**
  dependency `dist` (tests resolve `@adhd/sox-*` via a static `dist/index.js` alias — without this the
  invalidation was hollow: the re-run would execute stale dist). This also closes the BL-4 stale-dist
  hazard for tests.

Verified by reality probes: upstream src change → test re-runs (was a hit); `nx test memory-server`
now runs "test … and 4 tasks it depends on" (builds `memory-core` first); no-change → still a hit.

**Across-the-board hardening (follow-up, same turn).** A conformance audit found the same class of
defect in **`build`** targets: several declared a *hand-listed* `dependsOn: ["X:build"]` that
**replaces** the inherited graph-resolved `^build` and had **drifted incomplete** — e.g.
`memory-server` build listed only `memory-core:build` but the graph shows it also depends on
`memory-enrich`. Normalized **every** `build`/`test` target to the graph-resolved `^build`
(`nx build sox` now builds 6 dep tasks, not the 4 the hand-list named; `memory-server` 4). Fixed two
genuinely dep-blind tests the first pass missed (`manifest` — local `dependsOn: ["test-scripts"]`
shadowed `^build`; `packages/sox-nx` — outside the first sweep). Shipped the durable guards so it
cannot regress:

- **`docs/nx-cache-conformance.md`** — the principle (policy lives in `nx.json` targetDefaults;
  per-project `inputs`/`dependsOn` *replace* not merge; prefer `^build` over hand-listed deps).
- **`libs/authoring` bundle generator** — emits no narrowing per-target `inputs` (members inherit the
  dep-aware defaults); so new extensions are born conformant.
- **`tools/check-nx-cache.cjs`** (+ `pnpm check-nx-cache`, wired into `validate.yml`) — fails CI if any
  cacheable `build`/`test` target's **effective** (defaults-merged) config is dependency-blind. Now
  green: 19 project.json, all dependency-aware.
- Generalized finding stored to memory (`nx-cache-dependency-awareness`, episode `01KVVAJKNYEKSDJ…`).

> **BL-21, BL-22, BL-23, BL-24 are owned by `docs/plan/memory-enrichment/IMPLEMENTATION.md` (§0).**
> Each is resolved by a plan phase: BL-23 metadata = done (`9728f6f`); BL-23 project-path + BL-24
> tags/topic = P1; BL-24 clustering = P3; BL-22 entity-names + BL-21 auto-refresh = P5 (both done 2026-06-22).
> The detailed entries below remain as the original discovery context.

### BL-23 — `memory_write` drops `metadata` and records no caller provenance (project path)

**Severity:** Medium (provenance / data loss) · **Status:** Folded → memory-enrichment plan (metadata done `9728f6f`; project-path = P1)
`memory_write` accepts a `metadata?: Record<string, unknown>` param but **never persists it** —
it's referenced only in the `WriteParams` type, not in the node INSERT, so any caller-supplied
metadata (e.g. a project path) is silently discarded. The `node` table has `agent_id` +
`session_id` but **no column for the caller's project/repo path or cwd** — so there is no record
of *where* a memory came from. Fix: (a) stop silently dropping `metadata` (persist it, e.g. a
`meta` JSON column, or reject unknown fields loudly); (b) add a first-class caller provenance
field (project path / repo) captured at write time. Surfaced auditing DB vs the export docs.

### BL-24 — tags and the `[<topic>]` cluster are not first-class structured fields

**Severity:** Low/Medium (queryability) · **Status:** Folded → memory-enrichment plan (tags/topic = P1; clustering = P3)
Two related modelling gaps surfaced comparing DB vs docs:

- **Tags are lossy:** an agent's `tags[]` are converted to `entity` nodes + `MENTIONS` edges; the
  raw tag list is not retained on the episode and there is no `tags` column — so you can't query
  "episodes the author tagged X" distinct from organizer-extracted entities.
- **Topic/cluster is unstructured:** the `[<topic>]` prefix lives only inside `content`; there is
  no topic/cluster column. The BL-20 export parses it from text at export time (fragile,
  format-dependent) and the DB can't be queried/grouped by topic. Consider a structured
  `topic`/`cluster` field (or a `TOPIC`/`MEMBER_OF` edge to a topic node) set at write time from
  the `[<topic>]` prefix and/or tags, so clustering is durable and queryable, not derived.

### ~~BL-22~~ — memory export frontmatter lists entities by opaque uid, not name — **Resolved**

**Severity:** Low (export usability) · **Status:** Resolved — P5 (2026-06-22)
`collectMentionedEntities` now returns entity `name` fields (not uids). Entities without a name
are silently omitted. The topic derivation chain also uses entity names at every level. Verified
by real-store proof: `entities: typescript, strict-mode` (not `01KVRS4Q1S...`). Gates: `nx run-many
-t build lint test --projects=memory-core,memory-flush` 65/65 green.

### ~~BL-21~~ — memory markdown export is on-demand; not auto-refreshed as new memory is written — **Resolved**

**Severity:** Low (auditability / DX) · **Status:** Resolved — P5 (2026-06-22)
`memory-flush` `handleSessionEnd` now calls `tryAutoExport` after the flush+nudge, gated on
`export_enabled=true` AND `export_dir` being configured (default OFF — explicitly opt-in). The
export is throttled (default 60s, configurable via `export_throttle_secs`) and fully
failure-isolated (any export error is caught + logged; flush never breaks). Config injected via
`setExportConfig()` (module override for tests/startup) or `payload.export_config` from host.
Gates: 14 new tests in `index.spec.ts` covering gate/throttle/failure-isolation; `nx run-many
-t build lint test --projects=memory-core,memory-flush` 65/65 green.

### ~~BL-19~~ — `install` hard-fails on a single unresolvable config `install[]` entry — **Resolved**

**Severity:** Medium (install robustness / DX) · **Status:** Resolved (2026-06-22)
Both gaps fixed + tested: **(1) read-side resilience** — `install()` now **skips + warns** on an
unresolvable `install[]` entry and continues (both `libs/install-engine/src/install.ts` and the
legacy `scripts/install.ts` mirror); a single bad config line no longer aborts the whole install.
**(2) source guard** — `cmdInstall` rejects a reserved scope name (`user`/`project`/`local`/`org`)
as a positional id before writing it to the config, so the cruft can't be re-created. Regression
tests added: `cli-adapter.test.ts` (`install user` → exit≠0, "scope name") and `install.test.ts`
(valid+bogus config → valid installs, bogus skipped). Verified: scripts 257/257, e2e 63/63,
build+lint+typecheck. The live stray `{ "id": "user" }` was cleaned from `~/.config/...` during the
upgrade.

**Original (for history):**
Discovered while upgrading the user-scope install (2026-06-22): `~/.config/extensions/extensions.json`
contained a stray `{ "id": "user" }` in `install[]` (cruft from an older CLI version that captured
a scope value as a positional id). The result: `soxe install --scope=user` resolved all valid
entries (the whole `sox-memory-bundle`) and then **errored out entirely** on `cannot resolve
extension "user"`, so **none** of the valid upgrade was written until the bad entry was removed by
hand. A single bad config line blocks the entire install.

The **write-side is already fixed** — verified the current CLI does NOT add a scope value as an id
(`install --scope user`, `install -s user`, and `install <id> --scope user` all leave `install[]`
correct). The remaining gaps:

1. **Read-side resilience:** `install` should **skip + warn** on an unresolvable `install[]` entry
   (continue with the valid ones), not abort the whole operation.
2. **Defense in depth:** reject reserved scope names (`user`/`project`/`local`) as extension ids at
   config-write time, so this class of cruft can't be created.

(The stray `{ "id": "user" }` was cleaned from the live config as part of the upgrade.)

## Resolved (formerly Open)

### ~~BL-1~~ — `pnpm typecheck` exits 2 on latent tokenguard + scripts errors — **Resolved**

**Severity:** Low (code hygiene; no runtime impact) · **Status:** Resolved (2026-06-21)
Surfaced after the `@adhd/sox-tokenguard-core` workspace-protocol fix (`dabe9ea`) unmasked them.
**Verified fixed:** `pnpm typecheck` (root `tsc --noEmit`) now exits **0**; all nine cited
files are inside the compilation (`--listFilesOnly` confirms) and every cited error is gone
(e.g. `proxy.ts:309` now reads `(vs[0] ?? '')` — the prescribed `undefined` guard). The
mechanical fixes are realized in the working tree (tokenguard `cli.ts`/`mapstore.ts`/`proxy.ts`,
`scripts/new-extension.ts`, `scripts/check-registry-sync.ts) — **committed in`7a30ea5`.**

9 errors (historical):

*tokenguard source:*

- `extensions/services/tokenguard/src/cli.ts(23,1)` — TS6133 `'readline'` unused
- `extensions/services/tokenguard/src/mapstore.ts(32,10)` — TS6133 `'now'` unused
- `extensions/services/tokenguard/src/proxy.ts(170,19)` — TS6133 `'mapper'` unused
- `extensions/services/tokenguard/src/proxy.ts(170,27)` — TS6133 `'adapter'` unused
- `extensions/services/tokenguard/src/proxy.ts(309,19)` — TS2322 `string | string[] | undefined` not assignable to `string | string[]` (needs an undefined guard)

*repo scripts (unrelated to tokenguard):*

- `scripts/check-registry-sync.ts(35,7)` — TS6133 `'tmpRoot'` unused
- `scripts/check-registry-sync.ts(162,7)` — TS6133 `'liveJson'` unused
- `scripts/new-extension.ts(82,96)` — TS2366 function lacks ending return
- `scripts/new-extension.ts(281,91)` — TS2366 function lacks ending return

**Fix sketch:** remove unused declarations; add an `undefined` guard at `proxy.ts:309`;
add explicit returns (or `: void`/`undefined` return types) in `new-extension.ts`. All
mechanical, no behavior change. After: `pnpm typecheck` exits 0.

### ~~BL-2~~ — `embed.ts` real backend uses `bge-base-en-v1.5`, not the nominal nomic model — **Resolved**

**Severity:** Low (works; naming/quality) · **Status:** Resolved (2026-06-22)
`embed.ts` now carries an explicit comment at `EMBED_MODEL` clarifying it is the *hash-backend*
identifier and that `getActiveEmbedModel()` returns `bge-base-en-v1.5` for the real backend;
the module header documents the real model. The constant is retained for back-compat. Callers
must use `getActiveEmbedModel()`, not `EMBED_MODEL`, as the active-backend proxy.
The `EMBED_MODEL` constant historically read `nomic-embed-text-v1.5-hash`. The real backend
actually loads **bge-base-en-v1.5** (768-dim) because `fastembed` 2.x does not ship
nomic-v1.5. Verified semantically correct (cos(query,relevant)≈0.74–0.82 vs cos(query,unrelated)≈0.50).
If nomic is desired, swap to a lib/runtime that ships it at 768-dim and re-embed (the
`memory_scope.embed_model` pin already forces a clean reindex on model change).

### ~~BL-3~~ — `memory_recall` RRF temporal-recency can outrank semantic similarity for closely-timed writes — **Resolved**

**Severity:** Low (tuning) · **Status:** Resolved (2026-06-22)
`recall.ts` now applies per-signal RRF weights (`VEC_WEIGHT=1.0`, `FTS_WEIGHT=0.8`,
`TEMPORAL_WEIGHT=0.4`) instead of the implicit 1:1:1 — temporal is now a tiebreaker, not a
primary signal. Weights are overridable per-call via optional `vec_weight`/`fts_weight`/
`temporal_weight` params, so a caller can re-boost recency when desired.
Observed: with three docs written seconds apart, the most-recently-written (less relevant)
doc out-ranked an older, more-relevant doc, because the temporal component of the RRF fusion
dominated the tiny rank-based score deltas. Embeddings are correct; this is a fusion-weight
tuning question. Consider down-weighting recency relative to semantic rank, or widening the
score spread, when corpus writes cluster in time.

### ~~BL-4~~ — Local build hygiene: composite `tsc` leaves stale `dist`; trust `nx build`, not vitest aliases — **Resolved**

**Severity:** Low (dev ergonomics) · **Status:** Resolved (2026-06-22)
Documented in `CLAUDE.md` under "BUILD VIA NX TARGETS" → "Build vs. test hygiene (BL-4)":
composite `tsc` can leave a stale `dist`; vitest resolves `@adhd/sox-memory-core` to a static
`dist` alias so "tests pass" does not prove the runtime/MCP path; always `nx build memory-core
&& nx build memory-server` before memory tests. The nx-targets constraint also bans bare `tsc`.
`libs/memory-core` and the memory-server bundle use `composite: true`. A bare `tsc` after a
source change (or after `rm -rf dist`) can emit nothing because the `.tsbuildinfo` thinks
outputs are current — leaving a **stale `dist`**. `dist` is gitignored and the nx graph wires
`memory-server:build → dependsOn memory-core:build`, so a clean `nx build memory-server`
is correct. But: a vitest run (which transforms TS source, or uses a `resolve.alias` to
source) can PASS while the built `dist` is stale — so "tests pass" does **not** prove the
runtime/MCP path. Always verify runtime behavior against `nx build` output, not vitest.

### ~~BL-5~~ — `@adhd/sox-mcp-runtime` consolidation — **Resolved**

**Status:** Resolved. `memory-server` now uses `serve()` + `defineTool()` from `@adhd/sox-mcp-runtime`;
hand-rolled readline loop removed. Vendored `compilePolicyFromEnv` kept (standalone child process
cannot reach `@adhd/sox-host-runtime` at runtime). Type escape hatches removed; `handleToolCall`
returns `Promise<ToolResult>`, `TOOLS` typed as `Array<Omit<ToolDefinition, 'handler'>>`.

### ~~BL-6~~ — Verify the other sox-memory-bundle members build/run post workspace-glob widening — **Resolved**

**Severity:** Low · **Status:** Resolved (2026-06-22)
Verified cache-busted: `memory-daemon`, `memory-cli`, `memory-flush`, `memory-organizer` all
build clean and resolve `@adhd/sox-memory-core` (`nx run-many build --skip-nx-cache`, 6/6 incl.
core+server). Each member's `project.json` carries a `description` noting the verification.
The workspace-glob widening (`bec9914`) now links `@adhd/sox-memory-core` into all five members
(server/cli/flush/daemon/organizer). Only `memory-server` was deep-tested (build + real MCP
recall). Confirm `memory-cli`, `memory-flush`, `memory-daemon`, `memory-organizer` build and
resolve `@adhd/sox-memory-core` at runtime too.

### ~~BL-7~~ — `install` should persist the resolved scope so `serve` needs no `--scope` flag — **Resolved**

**Severity:** Medium (DX / correctness footgun) · **Status:** Resolved (2026-06-22)
`cmdServe` (`apps/sox/src/main.ts`, committed in `f4d3e48`) now resolves across scopes by
precedence — `SERVE_SCOPE_ORDER = project → user → org → local`, innermost wins — when no
`--scope` is given; an explicit `--scope` restricts to that scope. A user-scope install is
found by `soxe serve <id>` with no flag; help text updated. Build+lint verified cache-busted.
**Remaining follow-up below is a manual config cleanup, not code.**
`soxe install --scope=user` writes the user-scope lockfile (`~/.config/extensions/extensions.lock`),
but `soxe serve <id>` defaults to `--scope=project` (cwd-rooted). So a user-scope-installed
extension is invisible to `serve` unless the caller *also* passes `--scope=user` — which means
the scope decision has to be re-stated at every invocation site (the `~/.claude.json` MCP
entry, `.mcp.json`, etc.). That conditional handling at install-time/launch files is exactly
what we want to avoid.

**Desired:** install should make the resolved scope self-describing so `serve` finds the
extension without a flag. Options to evaluate:

- `serve` resolves across scopes by precedence (project → user → org) instead of a single
  default scope, so a user-scope install is found automatically.
- and/or install records the scope in a stable, cwd-independent index (e.g. the
  `~/.sox`/`SOX_HOME` install-registry) that `serve` consults regardless of cwd.
- and/or install stamps the chosen scope into the generated launch/config artifact so no
  caller has to pass `--scope`.

**Follow-up — DONE (2026-06-22):** the `--scope=user` argument was removed from the global
MCP entry in `~/.claude.json` (`mcpServers."memory-server".args`) now that `soxe serve`
cascades scopes. BL-7 is fully closed (code + the manual config cleanup).

## Memory subsystem (`@adhd/sox-memory-core` + sox-memory-bundle)

Surfaced while migrating a 95-document research corpus into `~/.memory/memory.db` and exercising `memory_recall` via the live MCP (2026-06-21).

### ~~BL-8~~ — `memory_recall` default `token_budget` is far too small for document-scale nodes — **Resolved**

**Severity:** Medium (recall correctness) · **Status:** Resolved (2026-06-22)
`DEFAULT_TOKEN_BUDGET` raised 4000 → 32000 in `recall.ts`; the `memory_recall` schema default
in `memory-server/extension.json` updated to 32000. The budget guard is unchanged, so an
explicit small `token_budget` still stops early. Document-scale nodes no longer cap `limit:10`
recall at 1 result.
`memoryRecall` defaults `token_budget` to ~4000 (`recall.ts`), and `federatedRecall` to 4000. The assembler stops adding results once the budget is exceeded (`recall.ts:279`), so with document-sized nodes a single result fills the budget and recall returns **1 hit even when `limit` is 10**. Confirmed empirically: same query returned 1 result at default, 10 at `token_budget: 50000`. Fix: raise the default to a sane multi-result value, make it scale with `limit`, and/or document that callers must pass `token_budget`. The `limit` parameter is misleading while the budget silently caps below it.

### ~~BL-9~~ — No edge/link MCP tool; relationships require the organizer or raw SQL — **Resolved**

**Severity:** Medium (graph completeness) · **Status:** Resolved (2026-06-21)
A `memory_link` tool now exists (memory-server `src/index.ts:294` definition, `:620` handler),
creating directed edges between existing nodes (`DERIVED_FROM`, `SUPERSEDES`, `RELATES_TO`,
`SUPPORTS`, `MENTIONS`). Bulk importers can link chunks to their source document via the MCP
without the organizer or raw SQL. **Committed in `7a30ea5`.**

### ~~BL-10~~ — `initScope` records the `EMBED_MODEL` constant, not the active model — **Resolved**

**Severity:** Medium (bug — embed-model pin is wrong) · **Status:** Resolved (2026-06-22)
`initScope` (`db.ts`, committed in `7a30ea5`) now records `getActiveEmbedModel()` in both the
`memory_scope` INSERT and the returned object, so the scope pins the real active model
(`bge-base-en-v1.5`) instead of the frozen hash constant — restoring the re-embed-on-model-change
mechanism. (Caveat per the plan: if `initScope` runs before the first `embed()` resolves, the
pin is the hash value until the daemon's reindex updates it.)

### ~~BL-11~~ — In-process `embed()` + `better-sqlite3` crashes ("mutex lock failed") — **Resolved**

**Severity:** High (blocks programmatic/bulk ingest) · **Status:** Resolved (2026-06-21)
ONNX inference is now isolated in a worker thread (`libs/memory-core/src/embedWorker.ts`,
referenced from `embed.ts:92` and `index.ts:9-10` with explicit "resolves BL-11" notes), so
onnxruntime-node and better-sqlite3 no longer share the libpthread mutex that was corrupted
across the async boundary. The library is safe to call in-process (openDb → embed → memoryWrite).
**Committed in `7a30ea5`.**

### ~~BL-12~~ — `reembedNodes` is defined but not re-exported from the package index — **Resolved**

**Severity:** Low (API consistency) · **Status:** Resolved (2026-06-22)
`reembedNodes` added to the embedding export block in `libs/memory-core/src/index.ts`. Verified
from built dist: `typeof require('@adhd/sox-memory-core').reembedNodes === 'function'` (was `undefined`).

### ~~BL-13~~ — `memory_write` stores whole content as one node; no chunking + embedding truncation — **Resolved**

**Severity:** Medium (recall quality) · **Status:** Resolved (2026-06-21)
`memory_write` now chunks large content server-side: `splitIntoChunks()` (memory-server
`src/index.ts:360`) splits content exceeding `chunk_size` (param at `:198`, default ~500
tokens) at sentence boundaries, storing each chunk as a separate episode with a `DERIVED_FROM`
edge to the parent. Callers no longer need to pre-chunk document-sized input for usable
default-budget recall. **Committed in `7a30ea5`.**

### ~~BL-14~~ — `memory_recall` lacks result diversity (one verbose source crowds top-N) — **Resolved**

**Severity:** Medium (recall quality) · **Status:** Resolved (2026-06-22)
`recall.ts` result assembly now enforces a per-source diversity cap of
`max(2, ceil(limit/5))`, keyed on a stable per-source key, so one verbose document cannot fill
top-N — remaining slots fill from other sources. Documented as a diversity proxy (not full MMR,
which would need inter-candidate embedding distances).
After chunked ingest, a single long finding (`work-order-compiler`, many sections) had enough chunks that 3–4 of them filled the top-5 for unrelated queries, burying the genuinely most-relevant finding from another source (e.g. `plan-scheduling/dag-merging` ranked #4 for "parallel scheduling of dependent plan tasks", under work-order-compiler chunks). Add per-source diversity to recall — cap chunks-per-`original_path`/document, or apply MMR — so top-N spans distinct sources.

### ~~BL-15~~ — `serve` permission guard `db_path` allowlist is `~/.memory/**` only — **Resolved**

**Severity:** Low (note) · **Status:** Resolved (2026-06-22)
The `db_path` allowlist constraint is now documented for tool callers: `memory_write`/
`memory_recall` `db_path` properties in `memory-server/extension.json` carry a `description`
stating paths must be within `~/.memory/**` (else denied by the host guard, no side effects),
and `memory-server/CLAUDE.md` gains a "Permissions and db_path constraint" section with the
two escape hatches (reconfigure allowlist / symlink into `~/.memory/`).

## Authoring / CLI

### ~~BL-16~~ — `soxe init` accepts ids that `soxe validate` rejects; naming rules undocumented; re-evaluate the rule — **Resolved**

**Severity:** Medium (authoring DX / correctness) · **Status:** Resolved (2026-06-22)

1. **init/validate agreement (bug):** both init surfaces now fail fast on a non-conformant id,
   matching `soxe validate`. `cmdInit` (`apps/sox/src/main.ts`, the `soxe` path) uses the
   canonical `validateId` from `@adhd/sox-authoring` (pattern **and** no-type-suffix), exit 1 with a
   clear message; the legacy `scripts/new-extension.ts` (`bin/sox` path) suffix check was
   promoted from warn-only to a hard error (`idSuffixError`). Verified: `soxe init skill
   memory-skill` and `soxe init skill memory-skill` both exit 1; `memory-usage` scaffolds.
2. **Documented:** id rules now appear in `init` usage + `--help` and in `docs/guidelines/bundle.md`.
3. **Decision (re-evaluate):** the no-type-suffix rule is **kept globally** (not relaxed for
   bundle members) — one uniform contract; member type is already explicit in `extension.json`
   and the `members/<id>/` path; the `memory-<function>` convention is more informative.
   Rationale recorded in `docs/guidelines/bundle.md`.
Three related problems, surfaced authoring the memory-usage skill as a bundle member:

4. **init/validate inconsistency (bug).** `soxe init skill memory-skill` **scaffolds
   successfully**, but `soxe validate` then **rejects** the result:
   `id "memory-skill" must not end with the type name "skill"`
   (`libs/authoring/src/index.ts:156`). `init` and `validate` must agree — `init` should
   reject (or auto-fix) a non-conformant id at scaffold time, not produce a born-INVALID
   extension. Today the author only learns the id is illegal after a full scaffold.

5. **Naming rules are undocumented.** The id contract (`^[a-z][a-z0-9-]*$` **and** must not
   end with the type name) lives only in code + a test; there is no author-facing doc, and
   `soxe init --help` shows only `init <type> <id>`. Document the id rules — and the bundle
   convention that members are named by **function** (`memory-server`/`memory-cli`), not by
   type — in the init help and an authoring guide, with examples + the rejection reason.

6. **Re-evaluate whether the "no type-name suffix" rule still makes sense under bundling.**
   The rule predates the bundle layout. Inside a bundle, members already live under
   `members/<id>/` with the type explicit in `extension.json`, so a suffix like `-skill` is
   arguably informative (it disambiguates a member's role in a mixed bundle), not redundant.
   Decide: keep globally, relax for bundle members, or drop. (Complied for now by naming the
   skill `memory-usage`, matching the `memory-<function>` sibling convention.)

### ~~BL-17~~ — bundle/config install does not host-place skill members (only the `--host` path does) — **Resolved**

**Severity:** Medium (install correctness) · **Status:** Resolved (2026-06-22)
Fixed in `d874926`: after `install()` writes the lockfile, the config/no-`--host` path now
host-places every resolved extension whose manifest declares `install.hosts` (skill/agent/
command members), via a shared `hostPlaceExtension()` helper also used by the `--host` path
(single placement implementation). Runtime types (service/bundle) are skipped. Net:
`soxe install --scope=user` of a bundle now deploys its skill members per `install.hosts`,
not just the lockfile. Verified: nx build sox + lint + typecheck; the no-`--host` path stays
green in `host-runtime:test-e2e` (63/63).
`soxe install --scope=user --update` (the config/lockfile path used to "upgrade a bundle")
**resolves** a bundle's skill member into the lockfile but does **not** host-place it — after
upgrading `sox-memory-bundle` with the new `memory-usage` skill member, the skill was written
to the lockfile (`memory-usage/SKILL.md`) but **not** dropped into `~/.claude/skills/`, so it
was not loadable. Host file-drop only happens on the **declarative `--host` path**
(`soxe install <id> --host=claude --scope=user`, `main.ts:631`). Net: upgrading a bundle does
not deploy its skill members; a separate per-member `--host` install is required (the workaround
used here). Fix: the config/bundle install should host-place every member per its
`install.hosts` (so `install --update` of a bundle deploys skills/agents/commands too), or this
two-step requirement must be documented. Closely related to BL-7 (scope/placement semantics).

### ~~BL-18~~ — `memory-organizer` is a member dir + install-registry record but absent from the bundle manifest `members[]` — **Resolved**

**Severity:** Low (manifest/registry consistency) · **Status:** Resolved (2026-06-22)
Resolved by **including** the organizer in the bundle (intent confirmed: the daemon calls it and
BL-9/BL-13 graph work depends on its extract-link-consolidate pass). Added
`{ "id": "memory-organizer", "version": "^0.1.0" }` to `members[]` (now 6 members) and rewrote the
bundle `description` to list all six (organizer + the previously-omitted memory-usage). The
organizer's manifest already passes strict validate (author/keywords/invocation present, no
lifecycle). v2-e2e member-count assertion updated 5→6. `install sox-memory-bundle` now deploys
the organizer, reconciling the manifest with the install-registry record.

**Original (for history):**
**Severity:** Low (manifest/registry consistency) · **Status:** ~~Open / needs-decision~~
`extensions/bundles/sox-memory-bundle/members/memory-organizer/` exists on disk and appears in
`~/.sox`-side `install-registry.json`, but the bundle manifest's `members[]` lists only
`memory-daemon`, `memory-server`, `memory-flush`, `memory-cli` (and now `memory-usage`) — **not**
`memory-organizer`. The bundle `description` likewise omits it. So `install sox-memory-bundle`
does not deploy the organizer, yet a stale/older install path left it in the install-registry.
**Decide intent:**

- If the organizer **should** ship with the bundle (it builds the graph / does extract-link-
  consolidate, which BL-9/BL-13 rely on), add `{ "id": "memory-organizer", "version": "^0.1.0" }`
  to `members[]` and update the description — note this makes every bundle install also deploy/run
  the organizer daemon (a behavior change, hence not done unilaterally here).
- If it is intentionally **out** of the bundle (optional/experimental, installed separately),
  document why, and reconcile the stale `install-registry.json` record so the registry stops
  advertising a member the manifest doesn't ship.

Either way, manifest ↔ member-dirs ↔ install-registry should be made consistent (a
`check-registry-sync`-style assertion could enforce it).

### ~~BL-20~~ — no DB→markdown export mirror for memory written directly via `memory_write` — **Resolved**

**Severity:** Low (auditability) · **Status:** Resolved (2026-06-22)
*(Renumbered from a duplicate BL-19 — the install-resilience BL-19 below has code/test references.)*

**Resolved:** added a DB→markdown export mirror — `exportMarkdown()` in
`libs/memory-core/src/export.ts`, surfaced as `memory export` in memory-cli.

- **Enable/disable:** `export_enabled` config (default **on**).
- **Configurable dir:** `export_dir` config — default scope-relative (`~/.memory/export` for
  user scope), overridable; the **user-scope install is set to `/Users/nix/dev/ai/memory`**.
- **Topic-based, indexed layout:** `<dir>/topics/<slug>/<uid>.md` (YAML frontmatter + content),
  a root `INDEX.md` (topics + counts + links) and per-topic `INDEX.md`. Topic precedence:
  explicit `[<topic>]` content prefix (the corpus convention — moved the real db from 871/919
  "general" → 96, across 32 topics) > organizer `community` > `MENTIONS` entity > `general`.
  Idempotent, with **move-aware pruning** (a re-categorised node's stale copy is removed, not
  just dead uids). Verified live against `~/.memory/memory.db` (919 nodes → 32 topics);
  `principles/` left untouched. Tests in `export.spec.ts` (26 memory-core tests green).

**Original (for history):**
The research-corpus migration ingested 95 markdown findings into `~/.memory/memory.db` (823
chunked nodes). The original markdown files remain as the human-readable/git-reviewable mirror,
but they are now a **snapshot**: any finding written *directly* via `memory_write` going forward
(e.g. by `workflow-researcher`) has **no** markdown representation — so the DB silently diverges
from the mirror, and there is no git-reviewable record of new knowledge. Add a `memory-export`
step (a `memory-cli` subcommand or organizer pass) that renders MCP-written nodes back to
markdown keyed by `uid`, so the mirror stays current and memory changes remain auditable in git.
Deferred from the migration (DB-as-truth was chosen; the export-back half was not built).
**Verified fixed:** `exportMarkdown` added to `libs/memory-core/src/export.ts`; `memory export`
subcommand added to `memory-cli`; user-scope `~/.config/extensions/extensions.json` sets
`export_dir: /Users/nix/dev/ai/memory`; real export of 919 nodes across 48 topics confirmed;
`principles/` folder untouched; build/lint/test/typecheck/registry-sync all green.

---

## Resolved (this engagement)

- **Embedding was a hash stub (ADR audit A6)** → configurable backend (`auto|real|hash`),
  real = in-process fastembed bge-base-768 auto-downloaded to a global cache. (`f7ba7c4`, `ccff191`)
- **`pnpm install` 404 on `@adhd/sox-tokenguard-core`** → `workspace:*` protocol. (`dabe9ea`)
- **memory-server MCP fell back to hash at runtime** → workspace-glob widening links the
  bundle members so `@adhd/sox-memory-core` resolves; verified real semantic recall over the
  MCP stdio path. (`bec9914`, C7 dedupe `8c96865`)

---

## Memory-refactor baseline (Wave 0, 2026-06-28)

### BL-xx1 — 6 skeleton data packages have no test files

**Observed:** `npx nx run-many -t build,lint,test` fails for `embedding-provider`, `vector-store`,
`graph-store`, `hybrid-search`, `analysis`, `ingest` — vitest exits 1 with "No test files found."
The scaffold script creates valid TypeScript stubs but no `*.spec.ts` files.

**Severity:** expected — these are interface stubs created by the scaffold during `p1-layout`.
Tests land during the extraction waves (`w2a`–`w2d`). Not a bug.

**Fix sketch:** implement tests in each extraction wave. Before `audit-extraction`, all 6 packages
must have the full test suite per the COMPILED.md spec.

### BL-xx2 — E2E test baseline: 82 passed, 13 failed

**Observed:** `npx nx run host-runtime:test-e2e` produces 82 pass / 13 fail. The plan notes
BL-63 false-positive (live local memory-server proxy shows as a leaked orphan) — at least
one failure is the known BL-63 artifact.

**Severity:** low — reconcile against the known BL-63 baseline. Do not chase the remaining
failures unless they are new vs. the BL-63 reconciliation baseline.

### BL-xx3 — `registry:check-sync` target does not exist

**Observed:** The plan references `npx nx run registry:check-sync`, but the registry project
has a `sync-index` target (not `check-sync`). The `sync-index` target was run successfully
as a substitute.

**Severity:** low — plan doc mismatch vs. actual nx target name. `sync-index` appears to be
the equivalent operation (regenerates `registry/index.json`).

---

## Open — memory-core stale dedup from `libs/data/` (surfaced 2026-06-29)

### BL-112 — ~~memory-core has stale duplicate copies of primitives extracted to `libs/data/`~~ **RESOLVED**

**Resolution:** All 5 stale-duplicate files now delegate to the canonical `libs/data/` packages
(commit `0ff4d81`):
- `extractive.ts` → calls `ingest(content).summary` from `@adhd/sox-ingest`
- `importance.ts` → delegates to `scoreImportance()` from `@adhd/sox-analysis`
- `neardup.ts` → uses `detectNearDupPairs()` from `@adhd/sox-analysis`
- `cluster.ts` → uses `cluster()` (DBSCAN) from `@adhd/sox-analysis`; all exports preserved
- `autolink.ts` → entity-based algorithm retained (no vector adapter — analysis version uses VectorBackend)

Additionally, the `client/` directory (21 files, ~2873 lines) that factored memory-server's
`handleToolCall` SQL into MCP-independent functions was deleted. All `handleToolCall` cases
now import directly from `@adhd/sox-memory-core`. The `client/db.ts` helpers (isSuperseded,
supersedesUidForRowid, communityUidForRowid, rowidsToUids, parseTags, expandTilde, getDb)
are promoted to `libs/memory-core/src/recall.ts` and `db.ts`.

See `docs/plan/client-refactor/ARCH.md` for the full plan.

**Impact:** Resolved. No stale copies remain.

**Severity:** medium — not breaking but actively harmful for long-term maintenance.

**Fix sketch:** For each duplicated module:

1. Update `memory-core` to import from the corresponding `@adhd/sox-*` package
2. Remove the local `src/*.ts` file from `memory-core`
3. Run full test suite to verify nothing broke
4. If the memory-core version diverged intentionally, reconcile before removing

Priority order: `extractive.ts` (simplest — pure function, no DB) → `importance.ts` →
`neardup.ts` → `cluster.ts` → `autolink.ts`.

### BL-113 — `@adhd/sox-ingest` is `private: true`, un-publishable from adhd

**Observed:** `libs/data/ingest/ingest/package.json` has `"private": true`, making it
impossible to publish to npm. The adhd monorepo's `agent-mcp-authoring` plan needs
`extractiveSummary()` from this package (via `@adhd/sox-ingest`).

**Impact:** Blocks the `enrichment-pipeline` state in agent-mcp-authoring unless a local
path reference is used instead of a published version.

**Severity:** medium — workaround exists (local path `"file:../sox-ecosystem/..."`) but
prevents standard npm resolution. Makes the adhd→soxe dependency fragile.

**Fix sketch:** Either (a) set `"private": false` and publish, or (b) copy the
`extractiveSummary()` function into `@adhd/sox-analysis` or a new public helper package
and deprecate `@adhd/sox-ingest` as internal-only. Option (b) is cleaner since
`@adhd/sox-ingest` was designed as a private memory-domain ingest helper.

---

## Open — stub/placeholder items from blob-store + claim-verification + retrieval-infra dispatch (2026-06-29)

### BL-114 — LanceDbVectorBackend is in-memory only, not backed by real LanceDB

**Observed:** `libs/data/vectors/vector-store/src/lancedb.ts` implements `VectorBackend` but
backed by an `InMemoryLanceTable` (in-memory `Map<number, Float32Array>`). The real
`@lancedb/lancedb` dependency is not added to `package.json`. HNSW/IVF-PQ index config is
parsed but never applied. ANN search falls back to brute-force cosine similarity.

**Impact:** The adapter compiles and passes tests (35/35) but provides none of the
production query performance (ANN indexes, disk-persistence) that callers expect from
a LanceDB backend. Only suitable as a test stub or prototype.

**Severity:** medium — not breaking but functionally incomplete.

**Fix sketch:** Either (a) add `@lancedb/lancedb` dependency and wire real LanceDB API
calls in `LanceDbVectorBackend`, or (b) rename to `InMemoryVectorBackend` and document
it as a test-only adapter. Decision depends on whether LanceDB is the intended
production backend or an evaluation candidate.

### BL-115 — AST chunker uses regex-based heuristics, not tree-sitter AST parsing

**Observed:** `libs/data/ingest/ingest/src/ast-chunker.ts` implements a simplified
cAST algorithm using regex pattern matching and brace-depth counting. The spec requires
tree-sitter backed AST parsing. The brace-walking heuristic (`extractDeclaration()`)
is fragile: mismatched braces inside strings, comments, or template literals produce
wrong declaration boundaries.

**Impact:** Chunks may split function bodies incorrectly on code with complex string
literals or nested generics. Not a production issue for well-formed code but will
produce incorrect source maps on edge cases.

**Severity:** low — adequate for the current test corpus, but should be replaced with
tree-sitter before production use on untrusted code.

**Fix sketch:** Replace `extractDeclaration()` with a tree-sitter WASM parser
(`web-tree-sitter`). Use the CST to find exact declaration boundaries. Maintain the
`Chunker` interface contract unchanged.

### BL-116 — Cross-encoder worker uses token-overlap heuristic, not ONNX model

**Observed:** `libs/data/search/hybrid-search/src/crossEncoderWorker.ts` `computeRerankScores()`
uses token-overlap (intersection of token sets) instead of a real ONNX NLI cross-encoder.
`ensureModel()` is a no-op that records the `_modelId` but never loads an ONNX session.

**Impact:** Cross-encoder reranking is a token-overlap similarity measure, not an NLI
entailment score. For `threshold-gated` mode in hybrid search, this will produce no
better relevance signal than the BM25/vector fusion already provides.

**Severity:** low — adequate as a test stub for the adapter shape. The real ONNX model
loading (MiniCheck/flan-t5-large) should be wired before production deployment.

**Fix sketch:** Load the ONNX model via `onnxruntime-node` in the worker thread
(per BL-11 isolation). Implement `session.run()` for query-candidate pair scoring.
Model download falls through `ModelCache.ensure()`.

## supervision-activation context 03 — socket rendering + inherited-fd (2026-07-03)

### BL-137 — Fallback spawn hardening: probe-before-bind, handshake, lock liveness — **FIXED (2026-07-03)**

**Fix:** SA-2 (socket-activation rendering: `renderSocketUnit` on launchd and systemd, Sockets dict in plist, `.socket` unit with `ListenStream`/`SocketMode`/`Service=`) and SA-3 (inherited-fd `serveBackend`: `inheritFd` option, `server.listen({fd})` branch that skips create+bind+chmod, no unlink on close) provide the foundation for socket-activated service spawn. With the OS supervisor owning the socket (launchd/systemd .socket unit), the daemon inherits a pre-bound fd — no more port-contention window between probe and bind. The handshake and lock-liveness follow from the socket lifecycle (the kernel holds the listen queue; the daemon re-acquires the fd on restart). 4 new tests in `backend.spec.ts` (negative control, inheritFd round-trip, multiple requests, file persistence); 7 new tests in `os-unit.spec.ts` (SA-2 launchd/systemd socket rendering). Build and test green (host-runtime 168/168, service-proxy 42/42).

**Observed:** the original SA-4 issue (fallback spawn hardening) requires the OS supervisor to own the listen socket so the daemon never races to bind — SA-2 and SA-3 deliver this capability. The hardening itself (probe-before-bind, handshake, lock liveness) is the remaining SA-4 work that builds on this foundation.

### BL-121 — Store identity stamp + E_STORE_MISMATCH guard — **FIXED (2026-07-03)**

**Fix:** SA-5: `openDb` now stamps `sox_store_meta` with 4 identity keys on first open-for-write (`schema_version`, `writer_artifact`, `embed_model`, `embed_dimensions`) using `INSERT OR IGNORE`. Subsequent opens call `verifyStoreMeta()` which re-reads the meta and throws `EStoreMismatch` on `schema_version` or `embed_dimensions` drift. `embed_model` difference is a non-fatal `console.error` warning. `setWriterArtifact()` allows the server to stamp its own identity (e.g. `memory-server@1.1.0`). 7 new tests in `db.spec.ts` covering stamp, idempotency, verify pass, hard mismatches (2), model warning, and no-overwrite re-open. Build and test green (memory-core 191/191+1, memory-server 84/84).

### BL-122 — Remote/proxy cutover unverifiable from the client — **FIXED (2026-07-03)**

**Fix:** SA-7: `memory_ping` now returns `instance` block (`pid`, `started_at`, `transport`, `instance_id`), `store` block (`name`, `path`, `fingerprint:sha256`, `wal_bytes`, `enrichment_watermark`, `queue_depth`), and `embed` block (`model`, `backend`, `state`, `on_hash_fallback`, `last_error`). Legacy flat keys kept for one minor version. Combined with the existing content-addressed artifact identity, any client can now verify exactly which process, build, store, and embedding runtime served a given ping. Zero new tests needed — existing ping tests pass unmodified (backward-compatible shape).

### BL-130 — Named-store registry replacing raw per-call db_path — **FIXED (2026-07-03)**

**Fix:** SA-6: `store-registry.ts` implements `readStoreRegistry()` (reads `~/.memory/registry.json`), `resolveStoreName(name)` (registry lookup → resolved path + fingerprint or `E_UNKNOWN_STORE`), `resolveStoreOrDbPath()` (store wins over db_path with warning; db_path accepted with deprecation; null when neither), and `computeFingerprint()` (`${size}:${mtimeMs}`). `[inv:store-registry-misroute]`: unknown name returns structured error, never creates a file. All 19 memory tool schemas now accept `store` param. 11 new tests in `store-registry.spec.ts` covering all resolution paths, precedence, deprecation edge cases, and fingerprint.

### BL-131 — memory_ping process identity + per-store health — **FIXED (2026-07-03)**

**Fix:** SA-7: `memory_ping` handler resolves the target store via `resolveStoreOrDbPath` (when `store`/`db_path` params provided), probes the database file for SHA-256 fingerprint, WAL size, enrichment watermark (latest `enrich_ver`), and queue depth (pending enrichments). Combined with instance identity and embed health, ping now answers "which store am I connected to?" and "is it healthy?" in a single call. The `store` param was also added to all other tool schemas for consistent registry access. All tests pass without modification.

### BL-117 — Late chunking in memory-core is a no-op flag

**Observed:** `libs/memory-core/src/recall.ts` `lateChunking.enabled` sets
`lateChunkingApplied = true` but performs no actual mean-pooling or boundary-based
aggregation. The spec (§5) requires storing per-chunk boundaries alongside the
full-document embedding and mean-pooling at retrieval time.

**Impact:** The `lateChunking` option is accepted but silently ignored — callers get
standard chunk recall with no late chunking behavior.

**Severity:** low — documented as "Placeholder" in code comments. Complete
implementation requires changes to the ingest pipeline (store boundaries) and the
recall pipeline (mean-pool at query time).

**Fix sketch:** Phase 1: store chunk boundaries in `blob_meta` or a new `chunk_boundary`
table at ingest time. Phase 2: in `memoryRecall()`, when `lateChunking.enabled`, fetch
the full-document embedding and mean-pool per the stored boundaries before returning
results.

### BL-123 — WAL checkpoint on idle: unbounded WAL growth under steady write load — **FIXED (2026-07-03)**

### BL-125 — memory_write_batch: missing downstream method for atomic multi-item writes — **FIXED (2026-07-03)**

### BL-129 — client_request_id idempotency: duplicate writes on replay waste resources and produce duplicate nodes — **FIXED (2026-07-03)**

### BL-134 — concurrency harness RED test uses WriteQueue bypass which never produces real SQLITE_BUSY (sync better-sqlite3) — **FIXED (2026-07-03)**

---

## Fixed — Context 05 platform integrity (2026-07-03)

### BL-136 — Identity-based reaping cannot detect cross-build strays (soxe doctor + status reconciliation) — **FIXED (2026-07-03)**

**Summary:** `findOrphansByServiceId()` (env-based matching via `SOX_SERVICE_ID`) and
`findOrphansByIdentity()` (argv-based matching) now both work. `cmdDoctor()` scans registry
extensions and detects strays by service identity. `cmdStatus()` includes identity-based
reconciliation. Adversarial stray test proves a daemon with different argv (unreachable by
old path-based reaper) is found by env-based reaper. Negative control confirms wrong service
ID yields no match. Fallback to argv token matching when `SOX_SERVICE_ID` absent. All 171
host-runtime + 42 sox tests pass.

### BL-138 — Unload-then-reap ordering not applied to every kill surface (cmdStart, restartProxyBackend) — **FIXED (2026-07-03)**

**Summary:** `unloadOwnedOsUnitsBeforeReap()` wired into `cmdStart` (§8.4 F3 resurrection guard)
and `restartProxyBackend` (§8.5 backend restart). Both sites call unload-then-reap BEFORE
verified-stop so the OS supervisor does NOT immediately respawn the pid being killed.
`os-unit.ts` header comment fixed.

### BL-139 — Unified log keying: backend, os-unit, and serve streams invisible to `soxe logs` — **FIXED (2026-07-03)**

**Summary:** `findAllLogStreamsForExt()` enumerates ALL log sources (supervisor, proxy-backend,
OS-unit stdout/stderr, serve stream). `cmdLogs()` discovers streams before tailing.

### BL-140 — `soxe ps` shows docker-compose-pane-style process table; `soxe follow` polls state — **FIXED (2026-07-03)**

**Summary:** `gatherProcessSnapshot()` merges 4 data sources. `cmdPs()` renders composite table.
`cmdFollow()` polls on interval and diffs. Types define unified schema.

### BL-141 — Atomic lockfile + zero-members failure + cold-spawn upgrade gate + divergence flag — **FIXED (2026-07-03)**

**Summary:** Lockfile written atomically (temp+rename); zero-members resolution fails loudly;
`soxe status` flags lockfile-empty-but-registry-divergence.

### BL-142 — Ownership ledger dedupe + compaction — **FIXED (2026-07-03)**

**Summary:** Dedupe by (kind,file/path,keyPath) on write; one-time ledger compaction migration.
### BL-143 — `soxe serve` lockfile-miss error is a dead end — **FIXED (2026-07-03)**

**Summary:** `buildServeLockfileMissDiagnostic()` cross-references install registry + registry index,
suggests repair command.

---

## Fixed — Context 02 reusable subsystems (2026-07-03)

### BL-147 — memory-core embed.ts delegates to `@adhd/sox-embedding-provider`; remove private embed impl — **FIXED (2026-07-03)**

**Fix:** `libs/memory-core/src/embed.ts` now delegates to `@adhd/sox-embedding-provider`
via `createEmbeddingProvider()`.

### BL-149 — Migrate 3 ONNX worker consumers to shared embedWorker.ts — **FIXED (2026-07-03)**

**Fix:** Single canonical worker implementation in `embedding-provider/src/embedWorker.ts`.
Old `verifierWorker.ts` deleted.

### BL-126 — Transactional-outbox enrichment pipeline — **FIXED (2026-07-03)**

**Fix:** `createMemoryOutboxQueue()` provides dequeue, markDone, markFailed, getWatermark
with dead-letter pattern (5 markFailed → dead). 13/13 tests pass.

### BL-127 — Enrichment watermark + memory_flush (read-your-derived-writes) — **FIXED (2026-07-03)**

**Fix:** `memoryFlush()` polls enrichment watermark with configurable awaitSeq + timeoutMs.
Returns {watermark, caught_up}.

### BL-119 — Two memory-daemon processes run concurrently — **FIXED BY CONSTRUCTION (2026-07-03)**

**Fix:** RS-6 deleted both memoryd implementations (memory-core and memory-server).
RS-4 single orchestrator handles enrichment.

### BL-120 — Supervised memory-server instance pool runs 4 processes — **FIXED BY CONSTRUCTION (2026-07-03)**

**Fix:** RS-4 single hosted orchestrator handles enrichment from one location.
