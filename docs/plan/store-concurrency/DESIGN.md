# DESIGN — store-concurrency

Authoritative specification. Two segments, **strictly serialized (S1 → S2)**,
that together make the store-adapter's cross-process sidecar handling
conformant to one ownership invariant and make the two load-flaky cold-open
suites deterministic.

Governing decision:
[ADR-0012](../../decisions/0012-turso-multiprocess-write-and-driver-agnostic-error-taxonomy.md)
(multiple processes may hold concurrent write connections; writers serialized by
`multiprocess_wal`'s `.tshm` coordinator; **not** MVCC; the ADR explicitly warns
it does **not** defend against the TRUNCATE-checkpoint races inside
`multiprocess_wal` itself).

---

## §0 Summary

A store's WAL-index sidecars (`-tshm`, `-wal`, `-shm`) are created as a
**filesystem side effect of opening** the store — including a "read-only"
open, because the substrate's read path is `readonly + allowFtsInReadonly`, a
*native-writable* handle (BL-391, the price of `fts_match`). Cleanup of those
sidecars is currently decided from an **ownership fact taken before the open**,
so a peer that opens in the window has its sidecar removed from under it. S1
states the invariant once and reconciles **every** call site — the two sites in
`store-reclaim.ts` and the one in `store-rebuild.ts` — to a single rule:
snapshot the **full** artifact set before the open, remove only the difference
after it, and when the store is non-quiescent remove nothing (rename-aside a
content-proven-dead sidecar instead, never unlink). S2 establishes, from the
suites themselves, which of the cold-open failures are real races and which are
harness artefacts, and replaces the base-rate gambles with deterministic
reproductions that fail for the right reason (BL-225).

## §1 Scope, serialization, and file ownership

**Order is S1 → S2, strictly.** Rationale: both segments mutate
`libs/data/store/store-adapter/`; S2's deterministic suites encode the invariant
S1 defines and exercise S1's cleanup paths, and S2 may need a test-only seam that
S1 lands in `cold-open-lock.ts`/`turso-adapter.ts`. Authoring them concurrently
would let S2 encode pre-S1 behaviour. S2 is **blocked on** S1's guard being
green.

| Segment | Owns (exclusive) | Reads |
|---|---|---|
| **S1** | `store-reclaim.ts` (worktree `feat/s1-reclaim-engine`), `store-rebuild.ts`, `sidecar-retention.ts`, `foreign-shm-lock.ts`, `preflight.ts`, any new `sidecar-ownership.ts`, the `-tshm`-window code in `cold-open-lock.ts`/`turso-adapter.ts` | DESIGN §2; existing call sites |
| **S2** | `__tests__/turso-cold-open-serialize.6fd60658.spec.ts`, `__tests__/wal-contentdead-reconcile.debt003-bug014.spec.ts`, `__tests__/tshm-init-race.spec.ts`, `__tests__/fixtures/*`, and the test-only seam S2 adds to `cold-open-lock.ts`/`turso-adapter.ts` | DESIGN §2 (the invariant S2 asserts), S1's merged code |

Nothing in this plan edits `registry/index.json`, runs `registry:sync-index`, or
hand-edits a `BACKLOG.md`.

---

## §2 Segment 1 — the sidecar-ownership invariant

> **Invariant (normative).** A *read-open* of a store — the substrate's
> `readonly + allowFtsInReadonly` "soft-readonly" adapter connect
> (`verifyStagedBackupIsNotTorn` `store-reclaim.ts:552-557`; fact reads in
> `reclaimStoreIfNeeded` `:718-723`; `restoreStoreOffline`'s backup read
> `store-rebuild.ts:1243`; `readTargetContentCount` `store-rebuild.ts:1084`;
> and any raw driver connect) — **may create, and must never destroy, sidecars**.
> It creates a `-tshm` WAL-index coordination sidecar (and may transiently create
> `-wal`/`-shm`). **A sidecar is owned by the process that created it, for as long
> as that process holds a live connection to the store.** A sidecar that
> pre-existed an open belongs to its prior owner and is never the opener's to
> remove. The only safe cleanup is **difference-of-full-snapshot**:
> 1. **Before** the potentially-side-effectful open, capture the entire artifact
>    **set** with `listFileArtifacts` — never a boolean, never a single path.
> 2. **After** the handle is closed, remove only artifacts present now and
>    **absent from the snapshot**, and never a **non-empty** `-wal`.
> 3. When the pre-open liveness probe (`storeOpeners`) reports **non-quiescent**
>    (a live opener, or an `unknown`), the opener removes **nothing**; the only
>    permitted action is to **rename-aside** (never `unlink`) a sidecar whose
>    content-deadness is proven, via the established `staleSidecarPath` forensic
>    rename.
>
> A boolean *"did `-tshm` exist before?"* plus a WAL-size guard is **forbidden**:
> it cannot distinguish *"this open created it"* from *"a peer created it in the
> window"*, so it deletes a peer's live `-tshm`. Additionally, because a read-open
> can **rename** a pre-existing `-tshm` to `<...>.stale-<stamp>` — a name absent
> from any before-snapshot — difference-based cleanup must **not** delete a
> `.stale-*` that is the rename target of a pre-existing artifact: attribute
> deletions by **creation**, not by post-hoc name absence ([0086e8cd](#backlog-binding)).

### Why this is the right rule, from evidence

- `store-rebuild.ts` already implements steps 1–2 correctly with a **full-set**
  snapshot (`listFileArtifacts` :770) and difference removal
  (`removeCreatedArtifacts(canonical, before, event)` :471) — and the module
  header explicitly documents *why* (BUG-2e232ee9: the soft-readonly open mints a
  `-tshm`, and a `--dry-run` must leave a store it promises not to touch
  byte-identical). S1 generalises *this* discipline to the other sites.
- The substrate's own close path treats a non-empty WAL as owning its index and
  **renames, never deletes**, a content-dead sidecar (`staleSidecarPath`
  `sidecar-retention.ts:142`; `BUG014.T3`). Step 3 matches that.
- [06922862](#backlog-binding) is the same class filed against the production
  backlog store: *"Opening the production store for read verbs bumps the db mtime
  and mints stale sidecars — the turso adapter has no side-effect-free open."*
  It is the mechanism facet; this invariant is the cure.

### Prior art — the coordinator sidecar is engine-owned (research, 2026-09-30)

A `researcher` pass (mandated by the architect workflow) confirms this invariant
and sharpens it:

- **`-tshm` is an engine-owned mmap'd coordinator**, not an open-owned temp file.
  Turso's `multiprocess_wal` docs describe it as tracking WAL state, the active
  writer, the active checkpointer, reader slots, and a shared page→frame index;
  cross-process transitions are gated by **byte-range locks on `-tshm`**
  (`docs.turso.tech/sql-reference/multiprocess-access`). A read-only open is
  **advisory**: `-tshm` "may be left in place — Turso reuses it on the next
  multi-process open and rebuilds its state from the WAL if necessary."
- **Only the last live closer can safely delete a sidecar** (SQLite
  `walformat.html` §1.3–§1.4/§3; `WAL_CKPT_LOCK`/`WAL_RECOVER_LOCK`). A process
  **cannot** decide "this sidecar belongs to my open" from file metadata. The
  substrate's rename-to-`.stale-*` (`reconcileForeignSqliteShm` /
  `recoverStaleWalIndex`) is a *workaround* for the engine not doing its own
  last-close cleanup — so the invariant must not rest on creation attribution
  alone.
- **A read-open does not reliably block a cross-process TRUNCATE.**
  `tursodatabase/turso#7833` (open, milestone 1.0) shows a TRUNCATE checkpoint
  succeeding under a live cross-process reader, then the reader getting
  `Corrupt("Invalid page type: 0")`; upstream's own test is
  `#[ignore = "known bug: a cross-process DB-file reader does not block a truncate
  checkpoint"]`. This *refutes* the docs' opposite claim and means a read-open's
  reader slot is **not** an ownership signal.
- **Cold-open init is serialized by WAL-index recovery, not file existence**
  (`walformat.html` §3): the first opener runs recovery under exclusive WAL locks;
  if an engine initialises the coordinator outside a lock domain every opener
  shares, cold-open under N processes is genuinely racy (see §3).
- **Interop hazard:** never let a second SQLite-family implementation (including
  the stock `sqlite3` CLI) touch the same WAL database — mutually-invisible lock
  domains (`tursodatabase/turso#6454`).

**Consequence for the invariant:** the difference-of-full-snapshot rule (steps 1–2)
is correct **only under proven quiescence**, and the `quiescent: false` posture
(step 3) is the **default** — a read-open that cannot prove it is the last live
user must leave the sidecar in place (reuse is idempotent; Turso rebuilds its state
from the WAL), never unlink it. This is strictly stronger than "did this open
create it", and it is why a *boolean* is not merely lossy but wrong.

### Call-site reconciliation (S1's whole job)

| # | Site | Current behaviour | Reconcile to |
|---|------|-------------------|--------------|
| 1 | `store-reclaim.ts` `verifyStagedBackupIsNotTorn` **:549** | opens soft-readonly (:552), closes (:578), **no snapshot, no cleanup** → leaves the `-tshm` it minted | steps 1–2 (snapshot before :552; difference-remove after :578) |
| 2 | `store-reclaim.ts` `cleanupFactsProbeTshm` **:610** driven by boolean `tshmPreexisted` **:707** | boolean snapshot + WAL-size guard → **deletes a peer's `-tshm`** | steps 1–3; delete the boolean at :706-707 and pass the **set** from `listFileArtifacts` |
| 3 | `store-rebuild.ts` restore path | full-set snapshot (:1241) + difference removal (:1261) | add the **rename-target exclusion** (a `.stale-*` minted by renaming a pre-existing `-tshm` is not attributable to this open) — [0086e8cd](#backlog-binding) |
| 4 | `foreign-shm-lock.ts:259`, `preflight.ts:467` `removeForeignShmIfUnlocked` | `unlink`s an unlocked `-shm`, skipping the `.stale-*` rename | rename-aside via `staleSidecarPath`, never `unlink` — [042a98fa](#backlog-binding) |

`store-rebuild.ts`'s `rebuildStoreOffline` (:770/:778/:879) is already conformant;
S1 records it as the reference and touches it only for site 3.

### Interface changes (S1)

#### `libs/data/store/store-adapter/src/sidecar-ownership.ts` (NEW — preferred), or exported from `store-rebuild.ts`

```typescript
// BEFORE — none (today the primitives are private to store-rebuild.ts)
//   function listFileArtifacts(path: string, event: string): Set<string>          // store-rebuild.ts:450
//   function removeCreatedArtifacts(path: string, before: Set<string>, event: string): void // :471

// AFTER — the ownership primitive is shared; the boolean is gone.
/**
 * Snapshot the full sidecar artifact set beside `path` BEFORE a
 * potentially-side-effectful open. Superset of what removal may consider.
 */
export function snapshotSidecarArtifacts(path: string, event: string): ReadonlySet<string>;

/**
 * Remove only artifacts THIS open created: present now, absent from `before`,
 * and — for the `.stale-*` namespace — NOT the rename target of a `before`
 * member that vanished (the 0086e8cd exclusion). A `-wal` is removed only when
 * empty. When `quiescent` is false, removes NOTHING.
 */
export function removeCreatedArtifacts(
  path: string,
  before: ReadonlySet<string>,
  event: string,
  opts?: { quiescent?: boolean },
): void;
```

#### `store-reclaim.ts` `cleanupFactsProbeTshm`

```typescript
// BEFORE (worktree :610)
function cleanupFactsProbeTshm(canonical: string, tshmPreexisted: boolean): void {
  if (tshmPreexisted) return;
  const tshm = `${canonical}-tshm`;
  if (!existsSync(tshm)) return;
  // ... WAL-size guard, then rmSync(tshm, { force: true })
}

// AFTER
function cleanupFactsProbeTshm(canonical: string, before: ReadonlySet<string>, event: string): void {
  // Difference-of-full-snapshot; removes only what THIS read created,
  // and nothing at all when storeOpeners(canonical) is non-quiescent.
  removeCreatedArtifacts(canonical, before, event, { quiescent: isQuiescent(canonical) });
}
```

#### `store-reclaim.ts` `verifyStagedBackupIsNotTorn`

```typescript
// BEFORE (worktree :549) — opens, closes, no cleanup
export async function verifyStagedBackupIsNotTorn(path: string): Promise<NotTornVerdict> { /* ... */ }

// AFTER — snapshot before the connect; difference-remove in the existing finally
export async function verifyStagedBackupIsNotTorn(path: string): Promise<NotTornVerdict> {
  const before = snapshotSidecarArtifacts(path, 'store.reclaim.not_torn_cleanup_failed');
  try { /* unchanged probe */ }
  finally { /* adapter.close() (unchanged) */ removeCreatedArtifacts(path, before, 'store.reclaim.not_torn_cleanup_failed'); }
}
```

### Behavioral changes (S1)

- **`store-reclaim.ts` `reclaimStoreIfNeeded` (:652).** Replace the boolean at
  `:706-707` with `const before = snapshotSidecarArtifacts(canonical, 'store.reclaim.cleanup_failed')`;
  pass `before` into `cleanupFactsProbeTshm` at `:732`. **Default behaviour for a
  quiescent store is unchanged** (its own `-tshm` is still removed); the change
  is that a peer's sidecar minted during the window survives, and nothing is
  removed under non-quiescence.
- **Never touch:** the lock machinery (:177-454), `evaluateReclaim` (:473), the
  `rebuildStoreOffline` delegation contract (:769-772), the report mapping
  (:774-826).
- **Error paths** keep the existing `log.debug`/`log.warn` traces
  (`store.reclaim.probe_tshm_cleanup_failed`, `store.reclaim.not_torn_probe_failed`,
  `store.reclaim.not_torn_close_failed`). No new empty catch.

---

## §3 Segment 2 — the cold-open / WAL-init flake family

### §3.1 The mechanism, established from the suites (not assumed)

Two **distinct, real** failures:

1. **Uncatchable native abort on simultaneous cold open** — suite
   `turso-cold-open-serialize.6fd60658.spec.ts`. `@tursodatabase/database`
   0.7.x panics in Rust (`core/storage/shared_wal_coordination.rs:1644`) when many
   processes cold-open the **same never-before-opened** store at once. A panic
   across the napi boundary **aborts the process**; the adapter's bounded retry
   (`isTshmCoordinationInitRace`) cannot absorb it. Measured: 16–24 simultaneous
   opens → 4/1920 and 2/960 died; the suite with the lock disabled saw 7 panics
   (15 nonzero exits) in 1536 processes. Base rate ~0.1–0.3 %/process. Fix
   shipped: `acquireColdOpenLock` serializes the real open + coordination init
   (`cold-open-lock.ts:2-37`, `:126`). Recorded as backlog `6fd60658` (HIGH).
2. **Transient, catchable `-tshm` init race** — model suite
   `tshm-init-race.spec.ts`. One process creates the `-tshm`; another stats/reads
   it before the creator wrote its 4096-byte header → `shared WAL coordination
   map magic mismatch` / `... smaller than the coordination header: got 0,
   minimum 4096`. This is **not corruption** (retrying the same path in a fresh
   process succeeds 5/5, 0 sticky). Fix shipped: `isTshmCoordinationInitRace`
   (`errors.ts:468`) + bounded retry in `TursoAdapterImpl.connect()`/`openOnce`.

The suite `wal-contentdead-reconcile.debt003-bug014.spec.ts` exercises a third,
**deterministic-by-construction** path: a content-dead `-tshm` over a 0-byte WAL
under a live peer (`BUG-014`), healed by
`recoverStaleWalIndex({ allowUnderLivePeers: true, requireContentDead: true })`.
Its `truncateSync(walPath, 0)` poison at `:213` is already deterministic; only
its **reachability** is session-dependent (whose session created the `-tshm`).

### §3.2 Which failures are real races vs harness artefacts

| Symptom | Class | Why |
|---|---|---|
| Rust `shared_wal_coordination.rs:1644` SIGABRT across many cold opens | **real race** | native abort, reproducible WITHOUT the lock (negative control in `6fd60658`), 4/1920 base rate |
| `shared WAL coordination … magic mismatch` / `… smaller than the header` | **real race** | catchable, message-keyed, 1/10 & 2/10 measured, fresh-process retry 5/5 |
| `tshm-init-race.spec.ts` `1/300 … 1 other/signal` **under full-suite load**, 0/300 isolated | **harness/resource artefact** | [0387f89b](#backlog-binding): occurs 2/4 full-suite runs, 0/2 isolated; the arm spawns 300 node children alongside the rest of the suite. The spec header already documents low-rate signal deaths as a known turso 0.7.2 class (4 SIGABRT/2400 **without** the retry). The classifier currently buckets it as `other/signal`, **not** `tshm`. |
| `tshm-init-race.spec.ts` **timeout at 180000 ms** under load | **harness/resource artefact** | [56ffdbcb](#backlog-binding): worker-thread-per-cold-open cost, not a violation of the invariant under test. |
| Shared `mkdtemp` tmpdir + many `tsx` cold-start children | **harness contention** | resource saturation, orthogonal to the races |

**Conclusion for the direction's two named suites.** `6fd60658`'s own arm and
`debt003-bug014`'s arm are **not** inherently non-deterministic in their
*assertion* — they are probabilistic in their *trigger*. The "pass in isolation,
fail under load" property is (a) the real base-rate race plus (b) harness
resource contention. The fix is therefore not to weaken the assertion but to
make the trigger deterministic.

### §3.3 Fix + deterministic reproductions

**S2-AC1 / `6fd60658`.** Replace the base-rate gamble (1536 racing processes to
catch a 0.1–0.3 % panic) with a **deterministic mutual-exclusion test**: a
test-only seam at the exact `-tshm` create-then-write instant in the cold-open
path (same shape as `store-rebuild.ts`'s `_beforeSwap` seam :665). Hold process
A after it creates the coordination file but before it writes the header; launch
B; assert that **with** `acquireColdOpenLock` B does not enter `_openReal`'s
critical section until A releases (no overlap), and that **without** it the two
overlap. Because the panic is uncatchable, the repro asserts the *serialization
property* (the invariant that prevents the panic), which is deterministic and
observable — not the abort. Keep the existing statistical wave arm as a
**supplementary** soak, not the gate.

**S2-AC2 / `debt003-bug014`.** Make the content-dead reconcile fire at a
controlled instant: a unit-level test of `isTshmContentDead` + the
`recoverStaleWalIndex({ allowUnderLivePeers: true, requireContentDead: true })`
gate over a **fabricated** tshm/`-wal` pair (0-byte WAL + stale index), asserting
the rename fires **exactly once**; the integration test then asserts the peer
survives unchanged. This removes the dependence on which session minted the
`-tshm` (the `53→3` ambiguity documented in the suite at `:260-291`).

**S2-AC3 / classifier.** Correct the `tshm-init-race.spec.ts` classifier
(`:159-165`) so a signal death is bucketed **exactly** (its own class, asserted),
rather than folded into `other/signal`. The proposal in [0387f89b](#backlog-binding)
— *"allow a bounded signal-death count"* — is **rejected** (BL-225): a bounded
allowance is a test that skips the failing case.

**S2-AC4.** No assertion in either suite may be weakened, relaxed, or guarded to
skip the failing case. Any timing bound that must change (e.g. a load-induced
timeout) is re-derived from an explicit budget, stated in the test.

### §3.4 Deterministic-repro recipe (research)

The recipe that makes S2's suites attributable, from the researcher pass:

1. **Barrier, not a timer** — a ready/done handshake across child processes
   (Turso's own `subprocess_db_file_reader_blocks_truncate_checkpoint` uses
   ready-file/done-file). Establish the precondition *provably*, then trigger.
   Caveat: for the `-tshm` *init* race specifically the naive spawn reproduces and
   a READY/GO barrier narrows the window (`fixtures/tshm-init-race-child.ts:29-40`)
   — so apply the barrier *at the seam*, never as a generic early sync.
2. **Oracle, not timing** — assert an invariant (row count / `integrity_check` / an
   Elle model verdict), never "no crash for N ms".
3. **Seed + replay** — a printed `SEED` reproduces the exact schedule (Whopper
   pattern); record the seed in any failure.
4. **Red→green negative control** — the same test against the pre-fix build must
   fail (already the suites' documented manual control).
5. **Statistical non-detection** — to detect a `p`-per-schedule race with 95 %
   confidence needs `n ≥ ln(0.05)/ln(1-p)` independent seeds (`p=1% ⇒ n≈298`); this
   is why seed-replay + oracle beats "run 1000× and hope".

Adopted references: Turso **Whopper** (engine-native seed-replayable multiprocess
harness), **Elle**/elle-cli (model oracle), **rr** (multi-process record/replay).
`PFX`/`REPLAY` named in the brief are **not real tools** — substitute record/replay
(rr) + a model oracle (Elle).

---

## §4 Files

| Path | Change | Read tokens | Output tokens |
|------|--------|-------------|---------------|
| `libs/data/store/store-adapter/src/sidecar-ownership.ts` | create | ~250 (store-rebuild.ts:421-496) | ~180 |
| `libs/data/store/store-adapter/src/store-reclaim.ts` | modify | ~400 (:30-49, :549-627, :652-744) | ~220 |
| `libs/data/store/store-adapter/src/store-rebuild.ts` | modify | ~120 (:421-496, :1230-1262) | ~90 |
| `libs/data/store/store-adapter/src/foreign-shm-lock.ts` | modify | ~120 (around :259) | ~80 |
| `libs/data/store/store-adapter/src/preflight.ts` | modify | ~100 (around :467) | ~70 |
| `libs/data/store/store-adapter/src/__tests__/turso-cold-open-serialize.6fd60658.spec.ts` | modify | ~205 | ~260 |
| `libs/data/store/store-adapter/src/__tests__/wal-contentdead-reconcile.debt003-bug014.spec.ts` | modify | ~300 | ~200 |
| `libs/data/store/store-adapter/src/__tests__/tshm-init-race.spec.ts` | modify | ~237 | ~120 |
| `libs/data/store/store-adapter/src/__tests__/fixtures/*` | create/modify | ~90 | ~120 |

---

## §5 Independent segments & execution strategies

### Segment S1 — sidecar-ownership reconciliation

1. Read `store-rebuild.ts:421-496` (the `listFileArtifacts`/`removeCreatedArtifacts`
   pair) and `:1230-1262` (the restore-path snapshot/cleanup). These are the
   model.
2. Create `sidecar-ownership.ts` exporting `snapshotSidecarArtifacts` and the
   extended `removeCreatedArtifacts(path, before, event, {quiescent})` (with the
   `.stale-*` rename-target exclusion). Move/duplicate the two private functions
   out of `store-rebuild.ts` **without changing their current behaviour** for
   existing callers.
3. In `store-reclaim.ts`: delete the boolean at `:706-707`; snapshot with
   `snapshotSidecarArtifacts`; thread the set into `cleanupFactsProbeTshm` (`:610`)
   and the not-torn probe (`:549`). **Never touch** the lock machinery or
   `evaluateReclaim`.
4. In `foreign-shm-lock.ts:259` and `preflight.ts:467`, replace `unlink` with the
   `staleSidecarPath` rename-aside.
5. Every new catch logs via `@adhd/sox-telemetry`; no empty catch.

### Segment S2 — deterministic reproductions

1. Add the test-only seam (a `Promise`-returning hook awaited at the `-tshm`
   create-then-write instant), defaulting to a no-op so production is unchanged.
2. Rewrite `6fd60658`'s gate arm to the mutual-exclusion assertion; keep the
   statistical arm as soak.
3. Make `debt003-bug014` fire the reconcile deterministically (unit gate +
   integration peer-survival).
4. Fix the `tshm-init-race.spec.ts` classifier bucket; no bounded-count allowance.

---

## §6 Acceptance criteria (binary; each names its observable)

**S1-AC1** — A soft-readonly read-open performed while `storeOpeners` is
non-quiescent leaves the artifact set **byte-identical**. Observable: the
`Set` from `snapshotSidecarArtifacts` before the open equals the set of existing
artifacts after it (add the `-tshm`/`-wal`/`-shm`/`.stale-*` membership diff as
the assertion).

**S1-AC2** — A `-tshm` created by a **peer** during a `reclaimStoreIfNeeded`
facts-read survives the reclaim. Observable: a peer process creates the store's
`-tshm` mid-read; after `reclaimStoreIfNeeded` returns, the peer's `-tshm` exists
and the reclaim's own artifact does not. RED today (`cleanupFactsProbeTshm`
deletes it); GREEN after S1.

**S1-AC3** — `verifyStagedBackupIsNotTorn` leaves **no** artifact it created.
Observable: artifact set before == after (today the `-tshm` remains → RED).

**S1-AC4** — The restore path does **not** delete a `.stale-*` produced by
renaming a **pre-existing** `-tshm`. Observable: pre-seed a `-tshm`; run the
backup read + `removeCreatedArtifacts`; the `.stale-<ts>` file still exists
(today it is deleted → RED; [0086e8cd](#backlog-binding)).

**S1-AC5** — `removeForeignShmIfUnlocked` never `unlink`s a sidecar; a
content-proven-dead one is rename-aside. Observable: after the call, no `-shm`
was unlinked; a `.stale-*` rename exists when dead ([042a98fa](#backlog-binding)).

**S2-AC1** — `turso-cold-open-serialize.6fd60658`'s gate arm fails
**deterministically** RED with the `acquireColdOpenLock` call removed from
`_openReal`, GREEN with it. Observable: the mutual-exclusion assertion flips
(no overlap observed across N deterministic trials) — not a base-rate panic.

**S2-AC2** — `wal-contentdead-reconcile.debt003-bug014`'s reconcile fires
deterministically RED without the content-dead probe, GREEN with it. Observable:
exactly one `.stale-*` rename in the fabricated unit case; the integration peer
answers after the heal.

**S2-AC3** — `tshm-init-race.spec.ts`'s classifier buckets a signal death
exactly; the assertion requires **0** failures with no bounded-count allowance.
Observable: the bucket label for an injected signal failure is its own class, and
the test's failure assertion is `toBe(0)` with no parameter.

**S2-AC4** — No assertion weakened; no skipped failing case; **both** suites
green in the full-suite run that currently flakes them. Observable: run the full
`store-adapter` suite under concurrent-writer load
(`node tools/check-suite-tree-state.mjs --project store-adapter` quoted with the
result) with 0 failures.

---

## §7 Test cases

### Unit

- Snapshot/difference: `removeCreatedArtifacts(path, before, event)` removes only
  members absent from `before`; leaves a non-empty `-wal`.
- Rename-target exclusion: `-tshm` in `before`, `.stale-<ts>` appears, `-tshm`
  gone → the `.stale-*` survives.
- `quiescent: false` → removes nothing.
- `isTshmContentDead` over a fabricated 0-byte WAL + stale index → true;
  content-live → false (never renamed).
- Classifier: an injected SIGABRT-class result is bucketed exactly.

### Integration

- Peer-during-window: two real processes; A does a read-open, B opens and mints
  its `-tshm`; assert B's `-tshm` survives A's cleanup.
- `reclaimStoreIfNeeded` under a live peer writes no artifact it did not create.
- `debt003` exp8: fabricate the poison, assert exactly-once reconcile + peer
  survival.

### Deterministic race (S2 gate)

- Mutual exclusion at the `-tshm` create-then-write instant: overlap asserted
  absent with the lock, present without it; the test observes the serialization,
  not the abort.

### UX / operator acceptance

- `memory fts-rebuild --dry-run` on a store a peer holds leaves the store
  byte-identical (the BUG-2e232ee9 assertion, now also proving peer safety).
- A read verb against a store under a live server mints no surviving residue.

---

## §8 Anchors

**Read and verified (current pass):**
- `store-rebuild.ts` — `fileSizeOrNull` :144; `readStorePageStats` :168;
  `captureFacts` :254; `stampRebuildMeta` :373; `removeFileArtifacts` :421;
  `listFileArtifacts` :450; `removeCreatedArtifacts` :471;
  `removeFileAndArtifacts` :489; `readFileIdentity` :515; `swapIntoPlace` :556;
  `-tshm` move-aside :606-612; `rebuildStoreOffline` :721; snapshot :770;
  cleanup :771-772/:778/:879; `readTargetContentCount` :1080; backup read :1241;
  restore cleanup :1261; `restoreStoreOffline` :1159.
- `store-reclaim.ts` (worktree `feat/s1-reclaim-engine`, `ce979c8e`) —
  `NotTornVerdict` :526; `verifyStagedBackupIsNotTorn` :549-587;
  `cleanupFactsProbeTshm` :610-627; boolean snapshot :706-707; facts-read
  connect :718-723; cleanup call :730-732; `reclaimStoreIfNeeded` :652;
  `evaluateReclaim` :473; `acquireReclaimLock` :346-454.
- `sidecar-retention.ts` — `staleSidecarPath` :142; `pruneStaleTshmSidecars` :244.
- `cold-open-lock.ts` — `COLD_OPEN_LOCK_STALE_MS` :51; `coldOpenLockPath` :69;
  `acquireColdOpenLock` :126.
- `errors.ts` — `isTshmCoordinationInitRace` :468.
- `turso-cold-open-serialize.6fd60658.spec.ts` — full (205 lines).
- `wal-contentdead-reconcile.debt003-bug014.spec.ts` — full (300 lines).
- `tshm-init-race.spec.ts` — full (237 lines); `fixtures/tshm-init-race-child.ts` — full (90 lines).

**Unverified (marked):**
- Direction's `store-reclaim.ts :481` / `:542` — `(UNVERIFIED — line numbers
  stale)`; mapped to `:549` / `:610`.
- Direction's `store-rebuild.ts :822/:896/:908` in [0086e8cd](#backlog-binding) —
  `(UNVERIFIED against current main)`; mapped to :450/:471/:1241/:1261.
- `foreign-shm-lock.ts:259`, `preflight.ts:467` `removeForeignShmIfUnlocked` —
  cited by [042a98fa](#backlog-binding); **not read** this pass `(UNVERIFIED)`.
- Backlog `d513326d`, `97deb271` — relations, bodies not read `(UNVERIFIED)`.

---

## §9 Backlog binding

Read this pass (via `backlog-operator`, read-only):

- **`06922862`** (debt, DUPLICATE of `97deb271`) — *"Opening the production store
  for read verbs bumps the db mtime and mints stale sidecars — the turso adapter
  has no side-effect-free open."* The mechanism facet of S1. Related `af20d98c`.
- **`042a98fa`** (bug, open) — `removeForeignShmIfUnlocked` unlinks any unlocked
  `-shm` and skips the `.stale-*` forensic rename; `foreign-shm-lock.ts:259`,
  `preflight.ts:467`. S1 call-site #4.
- **`0086e8cd`** (bug, open) — the restore-path rename-vs-snapshot hole;
  `removeCreatedArtifacts`/`listFileArtifacts`. S1 call-site #3 / AC4.
- **`ded8071c`** (OBSERVATION, open) — `memory.db-tshm` renamed `.stale-*` 22× in
  an outage window; actor unidentified. Context for the reconcile churn.
- **`0387f89b`** (debt, open) — `tshm-init-race.spec.ts` flaky under full-suite
  load; classifier buckets signal death as `other/signal`; proposes a bounded
  allowance (rejected here). S2-AC3.
- **`6fd60658`** (bug, open HIGH), **`56ffdbcb`** (bug, open),
  **`c6b2f19d`** (bug, open, wal.rs:4288 candidate), **`0bc05006`** (debt, open,
  `E_FOREIGN_SQLITE_SIDECAR`) — the S2 family.
- Relations: `af20d98c` (-tshm renamed never pruned), `2e232ee9` (fixed —
  fts-rebuild `--dry-run` leaves `-tshm`), `c5249cdd` (in_progress).

Backlog writes (filing the S1/S2 work, relating, resolving) go through
`backlog-operator`; the ADR-0026 proposal is **not** written without owner
approval.

## §10 Risks / blockers

See `STATE.md` §Blockers (B1 unmerged `store-reclaim.ts`; B2 substrate fix
already shipped; B3 cross-repo backlog tool) and §Open questions (Q1 seam
location; Q2 `-shm` scope; Q3 module placement).

**Research (complete).** A `researcher` pass on 2026-09-30 (WAL-index sidecar
ownership; cold-open init races; deterministic multiprocess testing) confirmed and
sharpened the invariant (DESIGN §2 prior-art) and the deterministic-repro recipe
(§3.4). Its memory writes were **blocked mid-catalog** by a live substrate defect
(`BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001`: `E_IO` — the store refuses to
proceed when the mandated `-tshm` coordinator did not appear after open), so its
findings were delivered inline and are recorded here rather than in the graph;
that defect is an **unfiled** item to be filed via `backlog-operator` (STATE
§Blockers B4). Mechanisms above remain grounded in this repo's files (DESIGN §8)
and backlog bodies (§9); the prior-art subsection (§2) cites external sources.
