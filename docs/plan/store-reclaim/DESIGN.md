# DESIGN — Automatic, Safe, Unattended Page Reclamation, Packaged With Properly-Expiring Backups

**Status:** authored (design spec) · **Repo:** `sox-ecosystem` (branch `main`) · **Plan:** `docs/plan/store-reclaim/`
**Scope:** the **memory store** (`~/.memory/memory.db`, bundle-configured) and the **backlog store**
(`~/.adhd/backlog/production/data/backlog-v2.db`), both Turso `@tursodatabase/database` 0.7.1-backed.
**Design only.** This file is the work order body; `STATE.md` is the resumable runtime; `contexts/` holds
per-segment work + audit contexts. The ADR (`docs/decisions/0026-…`) is **PROPOSED, not written** — it needs
owner approval (see §15).

> **Anchor provenance.** Every `file:line` below was read in this authoring session **except** the ones
> explicitly marked `(UNVERIFIED)`. Unverified anchors are listed in `STATE.md` "Anchor gaps" and must be
> confirmed before the segment that relies on them executes.

---

## §0 — Premise corrections (read the code first — do not build on an unverified premise)

| # | Premise | Reality found | Consequence |
|---|---|---|---|
| P1 | backlog store is `~/.adhd/sox-ecosystem/backlog/` | **False.** That is the backlog telemetry log dir (`@adhd/backlog` `src/index.ts:311-312`, `serve.ts:270`). Live store = `~/.adhd/backlog/production/data/backlog-v2.db` (`~/.adhd/backlog/production/config.yaml` sets `db.path`; `env.ts:256-258` `resolveBacklogDbPath`). | Target the real path. |
| P2 | an async embed-host may hold the backlog store | **False.** Backlog embedding is in-process fire-and-forget (`write/embedding-observer.ts:144`), drained in `closeGraphBacklogStore` (`store/graph-backlog-store.ts:171-193`). The shared funnel host is compute-only, no store handle (ADR-0020 D3). | Backlog holders = CLI + `serve` processes only. |
| P3 | the backlog tool is in this repo | **False.** It is `/Users/nix/dev/node/adhd/entrypoint/backlog/` (`@adhd/backlog` v1.0.6, bin `adhd-backlog`→`./dist/index.js`, `package.json:2-6`). | The backlog binding is cross-repo (Blocker B1). |
| P4 | `supervisors.json` empty ⇒ no unit to stop | **Confirmed.** `~/.adhd/sox-ecosystem/supervisors.json` is `{"version":1,"supervisors":[]}`; backlog has no daemon (ADR-0015). | Backlog quiescence is proven, not commanded. |
| P5 | the intended fix is written at `docs/spec/sox-executor.md:658` | **Confirmed** verbatim (§6.6 #2: "Independent backups via `VACUUM INTO` on a schedule (ADR 0007 D6 precedent) until Turso 1.0"). | Charter for the backup half. |
| **P6** | "`autoBackup` already calls `backupStore()`… we already vacuum automatically; we just never replace" | **FALSE as wired code.** `autoBackup` is defined (`libs/memory-core/src/backup.ts:602`) and re-exported (`libs/memory-core/src/index.ts:593`) but has **no production call site** — only tests and manual invocation (`docs/ops/memory-server-playbook.md:51`). Both shutdown paths unconditionally skip it (`backend.ts:462-473`; `index.ts:4767-4784`), and `bl-ff7d9e24-no-vacuum-on-shutdown.spec.ts` asserts it is never called. `pruneRotatedBackups` is reachable **only** through `autoBackup` ⇒ **no rotation runs in production today**; the count-only logic is dead code. | Expiry must be **invoked**, not merely fixed. No current periodic-backup cost exists to reclaim (the old 17.1 GB figure was hypothetical). The reclaimer (not `autoBackup`) becomes the compaction mechanism. |
| **P7** | "the proxy funnel path backlog uses" implies the backlog *store* is served through front-shim → single backend | **FALSE for the store; TRUE for embeddings only.** **Store:** `@adhd/sox-service-proxy` is **not** a dependency of `@adhd/backlog` (`entrypoint/backlog/package.json:7-41`, no proxy line); zero imports of `ensureBackend`/`serveBackend`/`runFrontShim`/`dialBackend`/`probeSocketLive`/`handshakeBackend` anywhere in the package; no UDS listener/dialler; `serve.ts:142-176` accepts only `--transport/--port/--host/--ready-file/--probe`, `:160-169` restricts transport to `mcp\|http\|both`; the store is opened **per-process in the serving process** (`server.ts:777` `resolveBacklogDbPath`, `:792` `openGraphBacklogStore`, handle at `:804-805`/`:842`, stdio MCP mount `:897-910`, HTTP mount `:859-895`); `.mcp.json:12-16` spawns `serve --transport mcp` stdio ⇒ **one full server per client**. ADR-0015 is **PROPOSED — design only, no code shipped** (`docs/decisions/0015…:1-3`); its `serve-lock.ts` was deleted (`serve.ts:57-59`); git shows no daemon work landed or in-flight. **Embeddings:** the funnel IS live — `embedHostMain.ts:407-415` calls `serveBackend` with `onClientCountChange`; but per ADR-0020 D3 it is **compute-only, holds no store handle**. | §4.2 rewritten: today there are **no dialers** — every `serve`/CLI process *is* a real store holder. Design is future-proofed for the ADR-0015 flip. |

---

## §1 — Summary

The substrate already owns a correct, offline, sanctioned reclaim (`rebuildStoreOffline`,
`libs/data/store/store-adapter/src/store-rebuild.ts:721`, running `VACUUM INTO` through the adapter's
`backupTo` and swapping under an exclusive cold-open gate). The design adds a **domain-free reclaim engine**
(`store-reclaim.ts`: policy + crash-safe single-flight lock + throttle), binds it to the memory policy, and
drives it with a **two-phase trigger** — a **live builder** (no downtime) followed by a **short gated swap** —
which structurally defeats **5b29f533** (the long `VACUUM` runs in a child the watchdog does not observe)
while preserving the existing `source_changed` identity gate that defeats **e92196e2**. It is **packaged with
one expiry mechanism**: the reclaimer's pre-swap set and every rotate-out backup expire under a single
count-AND-age-AND-companion policy, with checkpoint-then-rename-aside so no companion is orphaned or
half-deleted, and a structurally protected never-expire set.

---

## §2 — Hazard map (each constraint → where honored)

| Constraint / hazard | How honored |
|---|---|
| Never a stock/raw sqlite path (`9ae11d20`; vec0 experimental-index) | The only `VACUUM INTO` is `adapter.backupTo` via `rebuildStoreOffline` (`store-rebuild.ts:865`). Expiry's checkpoint step opens the backup **through the sanctioned adapter**, not stock `sqlite3`. |
| Never delete `-wal`/`-tshm`/pre-image/sidecar | Expiry **renames aside** (`staleSidecarPath`, `sidecar-retention.ts:58`) — never `unlink` — any companion; the live store's sidecars are never touched. `sidecar-retention.ts` (extended) is the only unlinker, and only of `.stale-*`. |
| **5b29f533** (long `VACUUM` on the main thread → SIGKILL; `driver-stall-watchdog.ts`) | The VACUUM runs in a **detached child process** spawned by the live builder; no watchdog observes it. `mainthread-monitor.ts:88-96` names the autoBackup `VACUUM INTO` path as the unmeasured near-bound case; `DEFAULT_MAINTHREAD_KILL_AFTER_MS = 5*60_000` (`:97`). |
| **e92196e2** (writes after snapshot silently dropped) | The `source_changed` identity guard: `expectedSource = readFileIdentity(canonical)` at build time; swap requires equality else refuse (`store-rebuild.ts:556`). A live build does **not** weaken this — it is the whole reason a live build is safe. |
| A store that will not quiesce is a REPORT, never a force | `reclaimStoreIfNeeded` returns `refused` with pids; never signals a holder. |
| **`1dd4c870`** — rotated backups retain orphaned WAL sidecars; `.db`-only restore near-empty | Expiry **checkpoints the `.db` before expiring it**, so any retained backup is self-contained; companions renamed aside as one unit; an orphan companion whose `.db` is gone is renamed aside and reported (§8.3). |
| No two divergent retention mechanisms | One *policy pass* (`pruneBackupSets`) + one *unlinker* (`sidecar-retention.ts`), on disjoint filename classes (§8.1). |
| BL-235 / BL-456 (`nx build`/`test`/`typecheck` have no dry-run; rebuild upstream `dist/`) | Verification runs in an isolated worktree; `node tools/check-suite-tree-state.mjs --project <p>` quoted with every result. |
| ADR-0021 (registry release-only) | No `registry/index.json` write; `git diff --exit-code registry/index.json` stays clean; no `registry:sync-index`. |
| ADR-0013 (no behavior-switching env) | Thresholds/intervals are typed config with explicit defaults, reported; **no toggle**; one-shot ops are CLI subcommands (D4). |
| Commit by pathspec only | Explicit paths; hooks on; never `--no-verify`, never `git add -A`. |

---

## §3 — Interface changes (exact signatures)

### 3.1 NEW `libs/data/store/store-adapter/src/store-reclaim.ts` (domain-free engine)

```ts
import type { StoreAdapter } from './types.js';
import type { StorePageStats, StoreRebuildReport } from './store-rebuild.js';

export interface StoreReclaimPolicy {
  minLiveNodes: number;
  bytesPerLiveNodeAlarm: number;
  optimizePassesSinceRebuildAlarm: number;
  minIntervalMs: number;                 // throttle floor (tuning constant, ADR-0013 D3)
}
export interface StoreReclaimFacts {
  file_bytes: number;
  live_nodes: number;
  bytes_per_live_node: number | null;
  fts_optimize_passes_since_rebuild: number | null;
  last_rebuild_at: string | null;        // persisted rebuild stamp doubles as the throttle anchor
}
export type ReclaimSkipReason =
  | 'below_threshold' | 'throttled' | 'lock_held' | 'not_quiescent' | 'no_live_nodes';
export type StoreReclaimStatus = 'reclaimed' | 'dry_run' | 'skipped' | 'refused' | 'failed';

export interface StoreReclaimReport {
  status: StoreReclaimStatus;
  db_path: string;
  reason?: ReclaimSkipReason;
  pids?: number[];                       // holders observed when refused (never signalled)
  before: StorePageStats;
  after?: StorePageStats;
  bytes_reclaimed?: number;
  rebuild?: StoreRebuildReport;
  retention?: RetentionResult;           // expiry pass invoked after a successful swap
  duration_ms: number;
  error?: string;
}
export interface StoreReclaimOptions {
  policy: StoreReclaimPolicy;
  countLiveNodes: (adapter: StoreAdapter) => Promise<number>;   // domain-specific
  dryRun?: boolean;
  now?: Date;
  lockMaxWaitMs?: number;                // default 0 — try once, then refuse
  log?: ReclaimLogger;
}
export function evaluateReclaim(
  facts: StoreReclaimFacts, policy: StoreReclaimPolicy, now: Date,
): { reclaim: boolean; skip?: ReclaimSkipReason; reasons: string[] };
export async function reclaimStoreIfNeeded(
  dbPath: string, opts: StoreReclaimOptions,
): Promise<StoreReclaimReport>;
export const STORE_RECLAIM_LOCK_SUFFIX = '.reclaim-lock';
export function acquireReclaimLock(
  dbPath: string, maxWaitMs: number,
): Promise<{ ok: true; release: () => void } | { ok: false; holderPid: number | null }>;
```

**Lock semantics (crash-safe; mirrors `deep-verify.ts` `DEEP_VERIFY_LOCK_NAME` + `ensure-backend.ts`):**
O_EXCL create writing `{pid, startedAt}`; on EEXIST read holder pid + `process.kill(pid,0)` — `ESRCH` ⇒
**steal** (unlink + retry once), alive ⇒ `{ok:false, holderPid}`. Released on `finally` + `process.on('exit')`.
A dead reclaimer's lock is auto-stolen; the swap is a single atomic `renameSync`, so a mid-swap death leaves
the canonical store untouched and only a `.rebuild-<ts>` temp for the next run's `cleanupSourceArtifacts`.

### 3.2 NEW `libs/memory-core/src/store-reclaim.ts`

```ts
export function memoryReclaimPolicy(
  cfg: import('./config.js').StoreGrowthConfig,
  overrides?: { minIntervalMs?: number },
): StoreReclaimPolicy;
/** SELECT COUNT(*) FROM node WHERE t_invalid IS NULL  (same query as store-growth.ts:81). */
export async function countMemoryLiveNodes(adapter: StoreAdapter): Promise<number>;
export async function reclaimMemoryStoreIfNeeded(
  dbPath: string, opts?: { dryRun?: boolean; now?: Date; log?: ReclaimLogger },
): Promise<StoreReclaimReport>;
```

### 3.3 REWRITTEN `pruneRotatedBackups` → `pruneBackupSets` (the single policy pass)

`libs/memory-core/src/backup.ts` (current `pruneRotatedBackups` at `:542`; regex `:430`; header `:421`; tmp
regex `:462`; loop `:559`).

```ts
export interface BackupRetentionPolicy {
  retentionCount: number;         // keep-N  (BackupConfig.retentionCount, default 24)
  maxAgeMs: number;               // keep-age, whichever binds first
  maxTotalBytes: number;          // byte ceiling (new; bounds renamed companions too)
}
export interface RetentionResult {
  scanned: number; expired: number; kept: number;
  expiredNames: string[];
  orphanedCompanions: { name: string; bytes: number }[];   // .db gone, companion present
  totalBytesAfter: number; oldestAgeMs: number | null;
  renameAsideFailures: string[];
}
export function pruneBackupSets(
  backupDir: string, policy: BackupRetentionPolicy,
  opts?: { now?: Date; protectedRefs?: string[]; log?: ReclaimLogger },
): RetentionResult;   // synchronous, best-effort, never throws (existing idiom)
```

The anchored match set expands from `ROTATED_BACKUP_RE` (`.db` alone) to a **set matcher** enumerating each
`memory-<ISO>.db` **and its companions** `memory-<ISO>.db-wal`, `.db-shm`, `.db-tshm`, and `.pre-repair-*`/
`.pre-restore-*` pre-images bearing the same `<ISO>` stem. Human-dropped files remain untouched.

### 3.4 `libs/memory-core/src/config.ts`

Typed, defaulted, telemetry-surfaced fields (ADR-0013 D2/D3):
`BackupConfig.retentionMaxAgeMs` (default `14d`, env `SOX_AUTO_BACKUP_MAX_AGE_MS`);
`BackupConfig.retentionMaxTotalBytes` (default `6 GiB`, env `SOX_AUTO_BACKUP_MAX_BYTES`);
`StoreGrowthConfig.reclaimMinIntervalMs` (default `6h`, env `SOX_STORE_GROWTH_RECLAIM_MIN_INTERVAL_MS`);
`DEFAULT_STALE_SIDECAR_MAX_BYTES` (default `512 MiB`, env `SOX_SIDECAR_MAX_BYTES`).

### 3.5 `libs/data/store/store-adapter/src/sidecar-retention.ts` (extend, don't replace)

- Extend the anchored companion pattern from `-(tshm|shm)` to `-(tshm|shm|wal)` so **renamed-aside WAL
  companions are actually reclaimed** (today they would not match — a silent leak).
- Add the byte cap (§3.4): policy becomes count ∧ age ∧ bytes, whichever binds first.
- `pruneStaleTshmSidecars` return gains `expiredBytes`/`totalBytes`.

### 3.6 Memory wiring (`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`)

- `index.ts:4532` `scheduleNextCompactionTick()` chain (calls `runCompactionPass` at `:4545`, armed at
  `:4559`): add an **expiry pass** call on the same cadence. This is the sanctioned scheduled-maintenance
  home (`compaction.ts` precedent; owner directive "there can only be 1 running debounced vacuum" — expiry
  is a filesystem pass, not a vacuum).
- `index.ts:1765` (the `memory_ping` branch, sole `readStoreGrowthGauge` call): add the backup-retention
  gauge to the ping payload (§8.7). This branch also writes the `reclaim_owed` obligation on the rising edge.
- Boot obligation consume: before `getDb` first opens the store, read `_adapter_meta.reclaim_owed`; if set,
  run the two-phase trigger (§6.3). Ordered to precede any writable open.
- `index.ts:88` import block: add `reclaimMemoryStoreIfNeeded`, `pruneBackupSets` (lazy/value-import per the
  store-adapter lint rule).

### 3.7 Backlog binding (cross-repo — Blocker B1)

`/Users/nix/dev/node/adhd/entrypoint/backlog/`: NEW `src/store/reclaim.ts`; `src/env.ts` typed
`store.maintenance.*`; `src/cli.ts` `store-reclaim` verb beside `store-check` (`cli.ts:633`);
`src/serve.ts`/`src/server.ts:792` consume the obligation opportunistically. Plus the same expiry pass
against the backlog backup dir.

**ADR-0015 flip note:** when the funnel lands, the obligation consumer becomes the **backend**
(`ensureBackend`-spawned, `libs/service-proxy/src/ensure-backend.ts:288`), front-shims are **dialers not
holders**, and the backend must be stopped for the swap (§4.2).

---

## §4 — Holder enumeration + derived proof of quiescence (per store)

Substrate gates reused: `storeQuiescence(dbPath)` (`.sox-lease.d/` scan + `process.kill(pid,0)`),
`storeOpeners(dbPath)`, `statSync(db+'-wal').size === 0`, and `swapIntoPlace`'s own re-checks
(`store-rebuild.ts:556`). **These are SWAP-time gates, not stage-time gates (§5).**

### 4.1 Memory store (`~/.memory/memory.db`)

Holders: (1) the supervised **UDS backend** for `(memory-server, canonical db_path)` (`[def:singleton-key]`,
`[inv:singleton]`), stopped via `soxe service disable memory-server` (M4 unload-then-reap); (2) M3 stdio
sessions funnel through the proxy shim to the one backend (**dialers, not holders** — memory-server *does*
use the funnel, §9.5); (3) transient `memory-cli`/`memory-flush` openers.
Proof (derived): the builder records the source identity at T0; the swapper takes the reclaim lock →
`openOfflineExclusive` returns `{ok, reason, pids}` → **swap** only if clear ∧ `storeQuiescence().quiescent`
∧ no live openers ∧ `-wal == 0` ∧ identity unchanged; else `refused` with pids.

### 4.2 Backlog store (`~/.adhd/backlog/production/data/backlog-v2.db`) — derived

**Topology from code (P7): the store is NOT reached through the funnel today.** ADR-0015 is PROPOSED and
unbuilt. Current shape: **one full `serve` process per MCP client** (`.mcp.json:12-16` → `server.ts:777,792`),
plus every CLI invocation opening its own short-lived store (`cli.ts:819-838`).

- **Who holds a writer connection:** every live `adhd-backlog serve` process (one per MCP session) and every
  in-flight `adhd-backlog <cmd>`. **There are no dialers to exclude** — the earlier §4.2 listing was correct.
- **Proof of quiescence = the same gates**, evaluated at the **swap** instant. Holders are client-spawned and
  untracked, so there is **no `soxe service disable` to run** (P4). A non-quiescent store is a **report**:
  `refused/not_quiescent` with pids and the remedy *"close MCP sessions / stop `adhd-backlog serve`
  processes, then run `adhd-backlog store-reclaim`."*
- **Obligation consumer:** there is **no single owner process**, so the obligation is consumed by **the
  process that finds the store quiesced** — the operator verb `adhd-backlog store-reclaim`, or the first
  `serve` after quiescence. A front-shim that boots before a backend exists holds nothing and consumes
  nothing.
- **Future-proofing (the ADR-0015 flip):** exactly **one** process owns the store (the `ensureBackend`
  backend); front-shims become dialers (`shim.ts` `runFrontShim` + `dial.ts` `dialBackend`); the **backend**
  consumes the obligation; and because a persistent backend holds one long-lived connection, `storeOpeners`
  never empties and the WAL never reaches `0` while it lives ⇒ **the reclaim must stop the backend** before
  the swap (mirror of `soxe service disable memory-server`). The daemon tier makes quiescence *reachable*.
- **Embedding cannot hold or corrupt mid-reclaim:** the funnel host is compute-only, no store handle
  (ADR-0020 D3; `service-proxy/src/backend.ts:68,100-113` `onClientCountChange`, wired only for diagnostics
  at `embedHostMain.ts:411-414`). Backlog's embed work is in-process fire-and-forget, drained in
  `closeGraphBacklogStore` (`graph-backlog-store.ts:171-193`). **The writer is the process being quiesced**,
  so the drain is sufficient by construction; `-wal == 0` at swap is the positive proof. No separate
  embedding barrier is needed.

---

## §5 — Swap atomicity, failure path, rollback (copy built live)

The owner's external fact: **`VACUUM INTO` is safe from a live reader** — implicit read transaction for the
copy's duration, destination reflects a single snapshot under concurrent writes, no experimental flag; only
**in-place** `VACUUM` needs exclusive access. Consistent with `store-rebuild.ts:5-18` (only `VACUUM INTO`
reclaims) and ADR-0012 (multiprocess WAL serializes writers).

### 5.1 Stage (BUILD) — exclusivity-free, writers running
`adapter.backupTo(<db>.rebuild-<ts>, {skipIntegrityCheck:true})` runs against the **live** store; the steps
that mutate only the copy (`stampRebuildMeta`, `store-rebuild.ts:373`) are unchanged. **None of
`storeQuiescence`/`storeOpeners`/`-wal == 0` is required to build** — they were entangled with the build only
because `openOfflineExclusive` gated the whole `rebuildStoreOffline`.

### 5.2 The correctness fence a live build still needs (the e92196e2 answer)
A live-built copy is a snapshot at **T0**; writes after T0 are not in it. Swapping it in unconditionally
would silently drop them — exactly **e92196e2**. The fence is the **existing identity guard**: record
`expectedSource = readFileIdentity(canonical)` (`{dev,ino,size,mtime_ns}`) at T0; at swap require equality,
else `reason:'source_changed'`. **This guard is load-bearing and unchanged.**

### 5.3 Swap (GATED) — all three gates remain load-bearing here
`swapIntoPlace(canonical, replacement, backupPath, event, expectedSource)` (`store-rebuild.ts:556`):
`acquireColdOpenLock` → re-check `storeQuiescence().quiescent` **and** `storeOpeners()` → src `-wal == 0`
**and** replacement `-wal == 0` → identity == `expectedSource` (else `source_changed`) → move stale `-tshm`
aside via `staleSidecarPath` (rename, never delete) → `linkSync(canonical, backupPath)` → `renameSync(
replacement, canonical)`; on rename failure `unlink(backupPath)`.

| Gate | Stage | Swap | Why |
|---|---|---|---|
| `storeQuiescence` (lease peers) | **redundant** | **load-bearing** | a peer connection points at the pre-rename inode; after rename it would write to what is now the hard-linked backup (lost) |
| `storeOpeners` (live pids) | **redundant** | **load-bearing** | same inode-identity reason |
| `-wal == 0` | **redundant** | **load-bearing** | no un-checkpointed frame is lost across the rename |
| `source_changed` identity | — | **load-bearing** | the e92196e2 fence (§5.2) |

### 5.4 Not-torn, 4 KB stub, rollback
`verifyStagedBackupIsNotTorn` (`backup.ts:354`, `sqlite_master` count > 0 — a 4 KB stub fails ⇒ refused);
`verifyReplacement` table counts + FTS sentinels + classified `PRAGMA integrity_check`; pre-swap canonical
preserved as a **hard link** at `backup_path`; `restoreStoreOffline` (`store-rebuild.ts:1159`) rolls back.
Expiry runs post-swap under the retention lock with `protectedRefs:[backupPath]` (§8.5).

### 5.5 Trigger-shape consequence
The cold-start child that did build+swap under one exclusivity window is no longer necessary. Because the
build is live and only the swap needs fencing, the trigger becomes **two-phase** (§6.3). **Honest caveat:**
the swap's identity guard demands **no write in [T0, Tswap]**. Two resolutions, in order:
1. **Preferred — a write-quiesce barrier (memory only):** memory-server pauses its write path (WriteQueue
   barrier: stop admitting writes → drain → checkpoint WAL → hold) and the swap runs in the millisecond
   pause **with the process alive**. New typed memory-server surface (ADR-0013 D2/D4); the clean zero-downtime
   win. **Open question Q6** (interaction with `[contract:signal]`/`SHUTDOWN_SAFETY_NET_MS`).
2. **Fallback — identity-guarded retry (both stores):** if a write lands in the window the swap refuses
   `source_changed`; the design treats this as **normal**, discards the stale copy, and rebuilds at the next
   quiesced window (the §6.3 stop→build→swap path). For backlog (bursty writes, no barrier) this is the mode.

Neither relaxes the fence: the swap **never** proceeds across a write.

---

## §6 — Trigger + throttle

### 6.1 Policy (pure, per store)
`evaluateReclaim` fires when any leg holds: `bytes_per_live_node > alarm ∧ live_nodes >= minLiveNodes`;
**or** `fts_optimize_passes_since_rebuild > alarm`; **or** (backlog) a persisted growth-rate leg. Memory
defaults `24576 / 32 / 500` (`resolveStoreGrowthConfig`).

### 6.2 The unmeasured backlog calibration question
Observed backlog `bytes_per_live_node = 23,845` @ `14,821` nodes = **0.97×** the `24,576` constant ⇒ **the
ratio leg does not fire.** Root cause: `24576` is calibrated on memory's compacted density (~8.3 KB/node,
`config.ts:198-223`); backlog's per-node density is **unmeasured**. **Decision:** backlog's
`bytesPerLiveNodeAlarm` is calibrated from a first `--dry-run` rebuild (`k ≈ 2.5–3 ×` measured compacted
density). Until measured, backlog relies on the `optimize passes` leg and the growth-rate leg. The design
must not pretend `24576` works for backlog.

### 6.3 Trigger sites (automatic, unattended) — two-phase
- **Phase A — live build (zero downtime).** A **detached builder child** is spawned by the maintenance tick
  (memory: `index.ts:4532/4545`; backlog: the operator verb / first quiesced `serve`) when the obligation is
  owed. It runs §5.1 against the **live** store and writes a **build record** sidecar
  (`<db>.rebuild-<ts>.json`) carrying `expectedSource` + `builtAt`. It holds the reclaim lock for the build
  but **does not** take the cold-open gate. No watchdog observes it (5b29f533).
- **Phase B — gated swap (short).** At the next controlled stop (memory: the idle-gated restart or the
  §5.5.1 barrier; backlog: the operator verb while quiet), the swapper takes the cold-open lock, re-checks
  all three gates + identity, swaps. Success ⇒ clears `reclaim_owed`, runs expiry (§8), releases.
- **Obligation producer:** rising edge of `alarm` in `readStoreGrowthGauge` (`index.ts:1765`) and the tick
  write `_adapter_meta.reclaim_owed='1'` + `store.reclaim.owed`.
- **A `source_changed` refusal does not clear the obligation** (it will retry), and does not thrash because
  the throttle floor and the write condition gate the retry.

### 6.4 Throttle and why it cannot loop/thrash
Floor `now - last_rebuild_at >= policy.minIntervalMs` (reuses the persisted rebuild stamp). A successful
rebuild resets `FTS_OPTIMIZE_PASSES_SINCE_REBUILD=0`, drops the ratio below threshold (existing test
`store-growth.bl-c5249cdd.spec.ts:150-156`), clears `reclaim_owed`. Single-flight lock ⇒ concurrent attempts
`refused/lock_held`. Rising-edge obligation + throttle floor bound restarts per interval.

---

## §7 — Cross-process coordination (reclaim)

- **Where:** `<storeDb>.reclaim-lock` (content `{pid, startedAt}`), in `store-reclaim.ts`.
- **Acquired:** O_EXCL; pid-liveness decides steal (dead) vs refuse (alive).
- **Released:** `finally` + `process.on('exit')`.
- **Death mid-swap:** lock with dead pid ⇒ next attempt steals; the swap is one atomic `renameSync`.
- Mirrors `deep-verify.ts` (O_EXCL pid-liveness + durable obligation) and `ensure-backend.ts`
  (`:270-308` `tryAcquireLock`/`releaseLock`, `:353` `ensureBackend`).

---

## §8 — Backup expiry — the single mechanism

### 8.1 One mechanism, not two
- **Single policy pass:** `pruneBackupSets` (§3.3) — successor to `pruneRotatedBackups` (`backup.ts:542`).
  Owns count **and** age **and** byte ceiling, companion enumeration, never-expire, and observability.
  `pruneRotatedBackups` is **removed** (replaced, not aliased).
- **Single unlinker:** `sidecar-retention.ts` remains the **only** code that `unlink`s, and only files
  matching the anchored `*.stale-*` class (extended to include `wal`). `pruneBackupSets` never `unlink`s a
  companion — it **renames aside** into that class (or, for a checkpointed self-contained `.db`, unlinks the
  `.db` only, which is not a sidecar).
- **Why two code files but one mechanism:** they act on **disjoint filename classes** and cannot diverge —
  the backup pass has no unlink path for companions and the sidecar sweep has no match for a non-`.stale-`
  name.

### 8.2 Age expiry policy shape and defaults
- **Policy:** keep newest `retentionCount` **AND** drop older than `retentionMaxAgeMs` **AND** stay under
  `retentionMaxTotalBytes` — **whichever binds first** (intersection, matching `sidecar-retention.ts`).
- **Defaults:** `retentionCount = 24`; `retentionMaxAgeMs = 14d`; `retentionMaxTotalBytes = 6 GiB`.
- **Clock:** `now` is **injected** (`opts.now`, default `new Date()`); ranking uses the **timestamp embedded
  in the filename** (lexicographic == chronological, per `backup.ts:430`'s anchored rationale) — never
  `mtime` (an `rsync`/`cp` would falsify it), mirroring `sidecar-retention.ts`'s rename-time ranking.
- **Steady-state count / bytes (memory compacted = 183.0 MB):**
  - Count cap: `24 × 183.0 MB = 4,392 MB ≈ 4.29 GiB`.
  - Age cap: at ~1/day, `14 × 183.0 MB = 2,562 MB ≈ 2.50 GiB` — binds first.
  - **Typical steady state ≈ 2.5 GiB**; hard ceiling = **4.29 GiB**.
  - **Worst-case total** = `4.29 GiB` + pre-swap hard links (`keep 3 × 712.7 MB ≈ 2.09 GiB`) + renamed
    companions (`≤ 512 MiB`) ≈ **6.9 GiB**, bounded by the byte ceiling.

### 8.3 Companion-atomic expiry (checkpoint-then-rename-aside; never unlink a live sidecar)
For each victim set, **oldest-first**:
1. **Checkpoint first.** If `memory-<ISO>.db-wal` is non-empty, open the backup **through the sanctioned
   adapter** and run `wal_checkpoint(TRUNCATE)`. On success the `.db` is self-contained → **any retained
   backup is restorable** (the direct `1dd4c870` fix). If the checkpoint fails or a holder is detected, **do
   not proceed with this set** — leave it intact and record the failure.
2. **Rename companions aside** (never unlink) via `staleSidecarPath`: `.db-wal`, `.db-shm`, `.db-tshm`, plus
   any pre-image bearing the stem.
3. **Unlink the `.db`** — now checkpointed/self-contained, not a sidecar, no live holder.
4. The renamed `.stale-*` companions are reaped later by `sidecar-retention.ts`.

**Orphan companion (the `.db` already gone):** a file matching the backup-companion pattern with no
`<stem>.db` (the 342 MB `-wal` case) is an **orphan**: rename it aside into `.stale-*` (never unlink) and
report `orphanedCompanions[{name, bytes}]`.

### 8.4 Never-expire set (structural, not count-based)
`isStructurallyProtected(name, {newestVerified, protectedRefs})`:
- **Newest verified backup** — highest-timestamp set whose `.db` passed `verifyStagedBackupIsNotTorn` (and
  integrity when not skipped). Persisted as a pointer file `~/.memory/backups/.last-verified` (atomic
  tmp+rename); **always** skipped regardless of age/count/bytes.
- **Rollback references** — the reclaimer's live pre-swap hard link, named in `opts.protectedRefs`
  (cross-checked against `_adapter_meta.reclaim_owed`), skipped while live.
- A test asserts survival even under `retentionCount=1`, `maxAgeMs=0`, `maxTotalBytes=0`.

### 8.5 Expiry ↔ reclaimer interlock
- **Lock:** a directory-scoped `~/.memory/backups/.retention.lock` (same O_EXCL + pid-liveness helper). The
  reclaimer holds it for the `linkSync` → `renameSync` → `pruneBackupSets` window; the scheduled pass and
  the ping path try once and **skip if held**.
- **No window that deletes the reclaimer's target:** three guards — (a) mutual exclusion for the whole
  link+rename; (b) the reclaimer's fresh link is the **newest** entry (§8.4 protects it); (c)
  `pruneBackupSets` targets **oldest-first**, re-`stat`s each candidate before acting, and never targets a
  name in `protectedRefs`.

### 8.6 Crash-safety of expiry itself
- **Companions before `.db`** — a crash after step 2 but before step 3 leaves the `.db` present and
  self-contained (valid); the next pass re-expires it. A crash mid-rename leaves the file under its
  `.stale-*` name (reaped later). **Never** `.db`-unlinked-before-companions (the only ordering that could
  strand a companion — structurally impossible here).
- The `.retention.lock` is pid-liveness-stealable, so a crashed pass never wedges the next one.

### 8.7 Observability
Add a `backup_retention` section to the store-growth gauge / ping telemetry (surfaced at `index.ts:1765` and
`metrics-snapshot-section.ts`): `{ expired_count, oldest_backup_age_ms, total_backup_bytes,
orphaned_companion_count, orphaned_companion_bytes, protected_count, last_expiry_at, last_expiry_error }`.

---

## §9 — Refusal taxonomy (a store that will not quiesce is a REPORT, never a force)

`StoreReclaimReport.status` is one of `reclaimed | dry_run | skipped | refused | failed`. Refusal reasons:
`below_threshold` (policy), `throttled` (min interval), `lock_held` (another reclaimer), `not_quiescent`
(live peers/openers — carries `pids`), `no_live_nodes`, and — surfaced from `swapIntoPlace` — `sidecars_dirty`
| `cold_open_lock` | `peers` | `openers` | `source_changed`. **No code path signals a holder, deletes a
sidecar, or proceeds across a write.** A refusal leaves `reclaim_owed` set and reports loudly.

---

## §10 — Observability & telemetry

- Reclaim: `store.reclaim.owed`, `store.reclaim.built`, `store.reclaim.swapped`, `store.reclaim.refused`
  (`{reason,pids}`), `store.reclaim.failed`.
- Expiry: the `backup_retention` section (§8.7) + `backup.expiry.orphan_companion` when an orphan is found.
- Gauge: `StoreGrowthGauge` extended with `reclaim` + `backup_retention` sub-objects; surfaced in
  `memory_ping.store` (`index.ts:1765`) and `metrics-snapshot-section.ts`.

---

## §11 — Double-disk arithmetic, re-derived WITH expiry

**Baseline correction (P6):** `autoBackup` never runs, so there is **no** current periodic-backup cost.

| Component | Arithmetic | Bound |
|---|---|---|
| Backup sets (count cap) | `24 × 183.0 MB` | **4.29 GiB** |
| Backup sets (age cap, typical) | `14 × 183.0 MB` | **2.50 GiB** ← binds first |
| Reclaimer pre-swap hard links | `keep 3 × 712.7 MB` | **2.09 GiB** (transient) |
| Renamed-aside companions | sidecar byte cap | **512 MiB** |
| **Worst-case total** | byte-ceiling-bounded | **≈ 6.9 GiB** (`6 GiB` ceiling is the binding guarantee) |

**Decision:** keep `autoBackup` as the *independent* (distinct-inode) backup half of sox-executor §6.6 #2,
reached through the reclaimer/maintenance path and **only useful once its copies are compacted** (183 MB,
not 712 MB) — hence reclaim precedes the periodic backup. The pre-swap hard links to **leaked** files are the
only real doubling, bounded to `keep 3 / 3-day`.

---

## §12 — Phased, independently-executable segments (+ persistence)

**Segments 3′, 4′, (4.5), 5 touch overlapping memory-server files and MUST be serialized. Segment 8
overlaps Segment 6 (shares `RetentionResult`) — serialize.**

| # | Segment | Files | Done-state | Deps | Tokens |
|---|---|---|---|---|---|
| 1 | Reclaim engine (store-adapter) | `libs/data/store/store-adapter/src/store-reclaim.ts` (create), `src/index.ts`, spec | engine tests green in isolated worktree; registry diff clean | — | ~250 R / ~900 W |
| 2 | memory policy binding | `libs/memory-core/src/store-reclaim.ts` (create), `src/index.ts`, `src/config.ts`, spec | `countMemoryLiveNodes` matches `store-growth.ts:81` | 1 | ~150 R / ~400 W |
| **3′** | two-phase trigger: **live builder** + build-record sidecar (**SERIALIZE 4′,5**) | memory-server `src/index.ts` (4532/4545 chain, 1765 ping, 4827 boot), NEW `src/store-reclaim-builder.ts` | a live build produces `<db>.rebuild-<ts>` + identity sidecar while serving; no watchdog kill | 1,2 | ~280 R / ~750 W |
| **4′** | **gated swapper** at controlled stop (**SERIALIZE 3′,5**) | same memory-server files | swap refuses on `source_changed`/peer/`-wal`; succeeds when quiesced; obligation clearing correct | 3′ | ~150 R / ~350 W |
| **4.5** | write-quiesce barrier (memory, optional zero-downtime) | `libs/memory-core/src/write-queue.ts`, memory-server | typed `quiesceForSwap()`; test proves the swap runs with the process alive and no write lost | 4′ | ~180 R / ~450 W |
| 5 | memory CLI report verb (**SERIALIZE 3′,4′**) | `memory-cli/src/index.ts` (B3) | `memory fts-rebuild --dry-run` prints `StoreReclaimReport` | 2 | ~120 R / ~250 W |
| 6 | reclaimer post-swap expiry hook (**SERIALIZE 8**) | `store-reclaim.ts`, `store-adapter/src/index.ts` | `StoreReclaimReport.retention` populated; protected-refs honored | 1,8 | ~120 R / ~250 W |
| 7 | backlog binding (CROSS-REPO, B1) | `/Users/nix/dev/node/adhd/entrypoint/backlog/src/{store/reclaim.ts,env.ts,cli.ts,serve.ts,server.ts}` | `adhd-backlog store-reclaim --dry-run` reports; refuses when a `serve` holds it; expiry wired | 1 | cross-repo |
| 8 | Backup expiry (age + companion-atomic + never-expire + observability) | `backup.ts`, `sidecar-retention.ts`, `config.ts`, `memory-core/index.ts`, memory-server `index.ts`/`metrics-snapshot-section.ts`/`store-growth.ts`, specs | `1dd4c870` orphan test green; never-expire survives; crash ordering safe; gauge exposes expired/oldest/total | 1 (shares `RetentionResult` with 6) | ~350 R / ~900 W |
| 9 | docs + ADR proposal | §15 | ADR-0026 **proposed** (not written); docs updated | all | ~150 R / ~500 W |
| **10** | **PERSISTENCE** (this plan dir) | `docs/plan/store-reclaim/**` | files exist + committed by pathspec; `state.json`/`STATE.md` resumable | 1–9 or standalone | ~60 R / ~400 W |

**Persistence done-state (Segment 10):** `docs/plan/store-reclaim/{README.md,STATE.md,DESIGN.md,contexts/**}`
exist; committed **by explicit pathspec** with hooks on; `STATE.md` carries the objective, per-segment
acceptance criteria, serialization constraints, Blocker B1, and open questions Q2/Q6.

---

## §13 — Red→green test plan

Every regression test is written, **seen red with the fix disabled, then green**, and **names the id it
attaches to** (`*.bl-<id>.spec.ts` / `*.<id>.spec.ts`). A test that skips the failing case does not count.

| Test | Names | Red→green assertion |
|---|---|---|
| `store-reclaim.bl-<newid>.spec.ts` | new engine id | fires per leg; leaked fixture ⇒ `reclaimed`; below-threshold/throttled ⇒ `skipped`; lock held ⇒ `refused/lock_held`; live peer ⇒ `refused/not_quiescent` **with pid, no data loss** |
| reclaim-lock crash test | new engine id | dead-pid lock stolen; canonical store unchanged |
| `fts-rebuild-cli.bl-c5249cdd.spec.ts` extension | `c5249cdd` (confirmed by filename) | alarm clears after a reclaim via the CLI verb |
| **5b29f533** test | `5b29f533` (verify body first) | with the kill budget armed, a >5-min reclaim never kills the server — the VACUUM ran in the child |
| **e92196e2** test | `e92196e2` (verify body first) | a write between snapshot and swap ⇒ `source_changed` refusal; the write survives; **no record lost** |
| **`pruneBackupSets` companion test** | **`1dd4c870`** | after rotation+expiry, **NO orphaned companion**; no `.db` unlinked before its companions; an orphan companion is renamed aside + reported |
| expiry age test | new expiry id | `keep-N AND max-age` — 20-day-old backup expired under `retentionCount=24`; ranking uses filename timestamp, not mtime |
| **never-expire test** | new expiry id | with `retentionCount=1`, `maxAgeMs=0`, `maxTotalBytes=0`, newest verified + live `protectedRefs` survive |
| expiry↔reclaimer interlock test | new expiry id | while the retention lock is held, the scheduled pass skips; the reclaimer's fresh link is never targeted |
| expiry crash-ordering test | new expiry id | crash after companion-rename / before `.db`-unlink leaves a self-contained `.db`; no `db-gone-companion-present` state produced |
| checkpoint-before-expire test | `1dd4c870` | a backup with a non-empty `-wal` is checkpointed (restore from `.db`-only is complete) before expiry; a checkpoint failure leaves the set intact + reported |
| observability test | new expiry id | ping/gauge exposes `expired_count`, `oldest_backup_age_ms`, `total_backup_bytes` |
| backlog gauge test | in-flight backlog uid (verify) | alarm fires on the **calibrated** threshold |

**Isolation (BL-456):** run in a worktree under `.worktrees/`; quote `node tools/check-suite-tree-state.mjs
--project <p>` with every result.

---

## §14 — Operational verification + deploy ordering

- **Artifact-hash proof (`[inv:deploy-verified]`, service-lifecycle §9.4a):** `npx nx build memory-server` →
  `soxe service disable memory-server` → (reclaim + expiry) → `soxe service enable memory-server` → compare
  the **running** process's reported build/artifact hash (telemetry/`memory_ping` buildId) against
  `shasum -a 256 …/memory-server/dist/index.js`. `loaded:yes` and exit 0 are not evidence.
- **Reclaim + expiry proof live:** the gauge from the **live** service shows `alarm:false`,
  `bytes_per_live_node` below threshold, `file_bytes` ≈ compacted, and
  `backup_retention.orphaned_companion_count === 0`.
- **Deploy ordering (services run from this worktree, `file://`):** build → isolated-worktree tests → disable
  → reclaim → expiry → enable → verify artifact hash (BUG-028 shape).
- **Registry:** no `registry:sync-index`; `git diff --exit-code registry/index.json` clean. Commit by
  **explicit pathspec**, hooks on.

---

## §15 — Documentation updates

| Doc | Section |
|---|---|
| `docs/spec/sox-executor.md` | §6.6 mitigation #2 (L658) — name the built two-phase reclaim **and the expiry packaging**. |
| `docs/ops/memory-server-playbook.md` | **Expiry policy, not just reclaim**; **correct the "auto-backup runs on every restart" claim (P6)**. |
| `docs/spec/service-lifecycle.md` | §8 — the idle-gated maintenance/restart path; note the future ADR-0015 backend is the stop target for the backlog swap. |
| `docs/decisions/0015-…` | annotate (via the ADR revision loop — **not** part of this landing). |
| `libs/data/CLAUDE.md` | note `store-reclaim.ts` + `pruneBackupSets`. |
| **`docs/decisions/0026-<slug>.md`** | **PROPOSE, do not write** (owner approval first). Must **cite the P7 topology correction** so a future reader does not design against an assumed store funnel. Next = max 0025 + 1. |
| ADR-0007 | annotate D6 as implemented by ADR-0026. |

**Item-id home for the 342 MB orphan:** `1dd4c870` (its title names the exact root cause); `b1ac8ebd`
related/moved only after reading both bodies.

---

## §16 — Self-check against acceptance criteria

| Requirement | Where |
|---|---|
| Exact paths + `file:line`; new interface signatures | §3, §12 |
| Holder enumeration + derived quiescence, per store | §4.1/§4.2 |
| Backlog shape differs; empty `supervisors.json` meaning; funnel topology | P4, P7, §4.2 |
| Swap atomicity + failure + rollback; real verify names | §5 |
| Trigger + throttle + backlog calibration | §6 |
| Cross-process coordination + crash-safety | §7 |
| One retention mechanism | §8.1 |
| Age expiry, defaults, steady-state, clock | §8.2 |
| Companion-atomic expiry; orphan handling; checkpoint-then-rename-aside | §8.3 |
| Never-expire set + guard name | §8.4 |
| Expiry↔reclaimer interlock | §8.5 |
| Expiry crash-safety ordering | §8.6 |
| Observability | §8.7, §10 |
| Double-disk re-derived | §11 |
| Segments + done-state + deps + tokens + serialization + persistence | §12 |
| Red→green tests incl. `1dd4c870`, never-expire, crash-ordering | §13 |
| Operational verification + deploy ordering | §14 |
| Docs + ADR proposal | §15 |
| Premise corrections P1–P7 | §0 |
