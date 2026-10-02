# SPEC — `@adhd/sox-store-adapter` batch 0.10.0 (probe atomicity · WAL fold · close drain · error taxonomy)

> **Status:** PROPOSED (uncommitted). One spec, one changeset, one publish for this package.
> **Target version:** `0.9.2` → **`0.10.0` (minor)** — justification in §8.
> **Author:** architect agent, 2026-09-22.
> **Research:** corroborated against the external-findings sweep (SQLite isolation/WAL/pragma docs,
> Turso `multiprocess_wal` docs + issue tracker, driver sources). Corroborations and two corrections
> are folded in at §5.1 (snapshot pins at first read; Turso's open TRUNCATE races violate its own
> snapshot guarantee), §4.2 (recognition order + `cause` chain; the same marker covers
> better-sqlite3), §5.2 (`integrity_check` is authoritative; the count probe is a pre-filter) and
> §5.4 (never delete a `-wal`; SQLite 3.51.3). See §10.6–10.7.
> **Scope lock:** `libs/data/store/store-adapter/**` only. `vector-store` and `hybrid-search` are
> being edited concurrently — this batch touches neither.

## TL;DR for the next agent

Four defects in one package, sequenced because they interact. **1** (probe atomicity) and **2**
(WAL fold) both destroy-or-declare on a *transient* observation and share the open/close paths and
the `storeQuiescence` primitive — the shared rule is *re-probe immediately before any destructive or
verdict-bearing act*. **3** (close doesn't drain) and **4** (taxonomy misses the closed-connection
`TypeError`) are one failure family: 3 removes the cause, 4 makes the residual legible. Fix 1 = one
SQL statement instead of two auto-committed reads. Fix 2 = re-probe WAL identity *after* the fold and
never stamp a clean shutdown over a deferred checkpoint. Fix 3 = drain `_inFlightOps` before teardown,
with a typed close-drain error. Fix 4 = recognise the driver's code-less `TypeError` by its exact
message marker, in `isDatabaseError` only.

---

## 1. Summary

`probeBtreeIndexes` compares an index count to a table count across two separately-committed
statements, so a concurrent commit inflates the second count and the probe declares a healthy index
`damaged`; `verifyAndRepair` then REINDEXes with no re-probe, converting a false positive into a
racing write (live evidence: `backlog.cli-2026-09-22.jsonl:3684-3685` — `ix_edge_dst_live` 19376 vs
19374 — then `:3691-3692` reindexed). The close-time WAL fold can claim a clean shutdown over a
deferred/failed checkpoint and can truncate a WAL whose identity moved under it. `close()` never
waits for `_inFlightOps`, so an in-flight transaction is abandoned and rejects with the driver's
opaque `TypeError: The database connection is not open` — which `isDatabaseError` cannot see because
the error carries `code: undefined`.

The batch makes the probe atomic in one statement, re-probes before every destructive act, drains
in-flight operations before close, and widens the taxonomy by exactly one message marker.

## 2. ADR check

Read in full: `docs/decisions/0012` (authoritative), `0007` (superseded by 0012 for the invariant,
D2/D5/D9), `0013`, `0015` (PROPOSED, never accepted). Verdict: **no violation; this batch implements
ADR-0012's intent and complies with ADR-0013.**

- **ADR-0012 §1** — multi-process concurrent writers to a Turso store are sanctioned; a *reader*
  may therefore legitimately observe a store moving under it. This is precisely why fix 1 is a
  *probe* fix (make the observation consistent), not a *lock* fix (forbid the writer). Any design
  that serialised writers to make the probe safe would contradict §1. Rejected.
- **ADR-0012 §3** — the adapter owns driver-shaped **detection**, memory-core owns the **taxonomy**.
  Fix 4 therefore lands the new predicate in `store-adapter/src/errors.ts` and exports it; it does
  **not** add a memory-core `StorageErrorCode` in this batch (§8 cascade).
- **ADR-0012 §4 / §2** — silent loss is the thing this design must never do. Fix 2's
  "never stamp a clean shutdown over a deferred checkpoint" and fix 3's "never resolve close with an
  operation abandoned" are both direct applications.
- **ADR-0013 D1/D2** — no new env toggle. Fix 3's drain bound is a **typed** config field
  (`AdapterConfig.closeDrainTimeoutMs`), mirroring `walOwnershipHeartbeatMs`'s precedent (D3 numeric
  tuning, clamped, no "disable" value). No `SOX_*` feature switch is introduced anywhere.
- **ADR-0013 D3** — `SOX_STORE_VERIFY_SKIP` is untouched. Fix 1 does not add a skip list.
- **ADR-0015** is a never-accepted proposal; nothing here reasons from it. No single-writer claim is
  made or repeated: every gate in this spec is a *quiescence* gate on a **destructive sidecar act**,
  not a claim that the store is single-writer.

## 3. Files

| Path | Change | Read tokens | Output tokens |
|---|---|---|---|
| `src/errors.ts` | modify | 350 | 220 |
| `src/integrity.ts` | modify | 900 | 700 |
| `src/turso-adapter.ts` | modify | 700 | 800 |
| `src/sqlite-adapter.ts` | modify | 250 | 250 |
| `src/types.ts` | modify | 200 | 120 |
| `src/index.ts` | modify | 60 | 60 |
| `src/__tests__/probe-atomicity.bug-probe-desync.spec.ts` | create | 0 | 900 |
| `src/__tests__/close-drains-inflight.d677a575.spec.ts` | create | 0 | 500 |
| `src/__tests__/wal-fold-hardening.spec.ts` | create | 0 | 500 |
| `src/__tests__/fixtures/probe-concurrent-writer-child.ts` | create | 0 | 250 |
| `src/__tests__/fixtures/sigkill-midwrite-child.ts` | create | 0 | 200 |
| `src/errors.spec.ts` | modify | 200 | 200 |
| `package.json` | modify (version via changeset) | 0 | 20 |

Paths are relative to `libs/data/store/store-adapter/`.

---

## 4. Interface changes

### 4.1 `src/errors.ts` — new exports

```typescript
// NEW — thrown by close() when it cannot finish draining in time (fix 3).
export class EStoreAdapterCloseDrainTimeout extends Error {
  public readonly code = 'E_STORE_CLOSE_DRAIN_TIMEOUT';
  constructor(
    public readonly dbPath: string | undefined,
    public readonly inFlightOps: number,
    public readonly waitedMs: number,
  ) { /* message names the count + the bound + how to widen it */ }
}

// NEW — thrown by any tracked operation that arrives after close() began (fix 3).
// Replaces the driver's opaque `TypeError: The database connection is not open`
// on every path that goes through the adapter's own API.
export class EStoreAdapterClosed extends Error {
  public readonly code = 'E_STORE_ADAPTER_CLOSED';
  constructor(public readonly dbPath: string | undefined) { /* … */ }
}

// NEW — the driver's closed-connection marker, exported for consumers (fix 4).
// Scalpel: matches ONLY the driver's exact phrasing, and only on an Error instance.
export function isClosedConnectionError(err: unknown): boolean;
```

### 4.2 `src/errors.ts` — `isDatabaseError` widening (fix 4)

```typescript
// BEFORE (errors.ts:274-278)
export function isDatabaseError(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  if (err.code.startsWith('SQLITE_')) return true;
  return err.code === CODE_GENERIC_FAILURE && isTursoPhasePrefixedMessage(err.message);
}

// AFTER
export function isDatabaseError(err: unknown): boolean {
  if (isErrorWithCode(err)) {
    if (err.code.startsWith('SQLITE_')) return true;
    if (err.code === CODE_GENERIC_FAILURE) return isTursoPhasePrefixedMessage(err.message);
    return false;
  }
  // The driver's closed-connection fault is a bare TypeError carrying
  // `code: undefined` (@tursodatabase/database-common/dist/promise.js:152,242,345,464),
  // so the isErrorWithCode shape gate can never see it. Research RQ3 confirms the
  // same message and the same absent code in better-sqlite3
  // (lib/methods/wrappers.js:5), so one marker covers both drivers; the native
  // equivalent is SQLITE_MISUSE (21), which neither driver surfaces.
  // Recognition order, strongest signal first: structured code (above) →
  // Error.cause chain → anchored message marker (last resort). Never match
  // `code === undefined` (every code-less Error), never `name === 'TypeError'`
  // (every TypeError in the process), never a bare substring.
  return isClosedConnectionError(err);
}
```

`isClosedConnectionError`:

```typescript
function isClosedConnectionMessage(message: string): boolean {
  return /the database connection is not open/i.test(message);
}
export function isClosedConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (isClosedConnectionMessage(err.message)) return true;
  // The `cause` chain is the stronger signal when a driver or wrapper nests the
  // original — check it before falling back to a bare marker on the outer message.
  return err.cause instanceof Error && isClosedConnectionError(err.cause);
}
```

`isErrorWithCode` (:141-146) is **unchanged** — it is the shared shape gate for the busy/unique/fk/
fatal helpers, and widening *it* would let those match a code-less error for the wrong reason. Only
`isDatabaseError` gains the branch. Strict widening: every previously-`true` input stays `true`.

### 4.3 `src/integrity.ts` — probe + repair seams

```typescript
// RepairAction gains an optional, honest "not done, and why" marker (BL-225:
// a status records a verified outcome, never an intention).
export interface RepairAction {
  probe: IntegrityProbe;
  object: string;
  action: string;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** NEW — set when the action was deliberately NOT taken. `ok` stays `true`
   *  (nothing failed); `RepairReport.ok` therefore does not flip on a skip. */
  skipped?: 'transient_divergence' | 'live_peers';
}

/** NEW — the adapter's quiescence oracle, declared ONCE and shared by the probe
 *  and the repair path. Supplied by the adapter (which owns `coordPath` + the
 *  lease token); integrity.ts must never import store-lease or read
 *  `adapter.config.dbPath` (that raw spelling is the
 *  BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY class). */
export type QuiescenceOracle = () => {
  quiescent: boolean;
  livePeers: readonly { token: string; pid: number }[];
};

// (declared on the existing VerifyOptions at integrity.ts:~225)
export interface VerifyOptions {
  // …existing depth / only / skip / walBaseline / ftsSampleSize / emptyArrayIsNull…
  /** NEW — threaded into `probeBtreeIndexes`, so a persistent count divergence
   *  observed while live peers hold the store reports `unknown`, never `damaged`
   *  (§5.1's unstable-snapshot guard). */
  quiescence?: QuiescenceOracle;
}

export interface RepairOptions {
  // …existing only / verify / walBaseline…
  /** NEW — gates the destructive REINDEX (§5.2). */
  quiescence?: QuiescenceOracle;
}

export interface VerifyAndRepairOptions extends VerifyOptions {
  verifyOnly?: boolean;
  onReport?: (event: 'damaged' | 'repaired' | 'repair_failed' | 'repair_skipped', detail: string) => void;
  // `quiescence` is inherited from VerifyOptions and forwarded to the repair.
}

export async function runOpenTimeIntegrity(
  adapter: StoreAdapter,
  opts: {
    uncleanShutdown: boolean;
    walBaseline: WalIdentity | null;
    onReport?: VerifyAndRepairOptions['onReport'];
    quiescence?: QuiescenceOracle;   // NEW
  },
): Promise<VerifyAndRepairResult>;
```

### 4.4 `src/types.ts` — typed tuning (ADR-0013 D3)

```typescript
export interface AdapterConfig {
  // …existing…
  /**
   * NEW — how long `close()` waits for in-flight operations to settle before
   * failing loudly with `EStoreAdapterCloseDrainTimeout`. Clamped to
   * [1000, 60000]; default 5000. Numeric tuning, never a toggle — there is no
   * value that disables the drain (ADR-0013 D3). Tests pass a small value.
   */
  closeDrainTimeoutMs?: number;
}
```

`TursoAdapter`/`SqliteAdapter` doc comments for `close()` are updated to state the new completion
contract: *close resolves only after in-flight operations have settled; it rejects with
`EStoreAdapterCloseDrainTimeout` rather than abandoning one.*

### 4.5 `src/index.ts`

Export `EStoreAdapterClosed`, `EStoreAdapterCloseDrainTimeout`, `isClosedConnectionError` alongside
the existing `errors.js` re-exports. **This is a real surface change** — the
`check-changeset-surface` gate (BL-460) will compare `dist/*.d.ts` against the last-published
surface; the changeset must declare it (§8).

---

## 5. Behavioral changes

### 5.1 `integrity.ts` — `probeBtreeIndexes()` (fix 1, primary)

- **Change:** the table count and the index count are read in **one SQL statement**, so they share
  one implicit read transaction and therefore one WAL snapshot.
- **Why one statement, not `BEGIN; SELECT; SELECT; COMMIT`:** research (RQ1) confirms a deferred read
  transaction does yield one snapshot, but the snapshot is pinned by the **first read**, not by
  `BEGIN` — so the explicit form is only correct because both reads sit inside it. A single statement
  is simpler and strictly stronger: it has exactly one read, so the "pins at first read" caveat
  cannot bite, and it needs no transaction lifecycle on a `StoreAdapter` that exposes no
  read-only-transaction seam. The explicit transaction is the **fallback** if the planner ever
  declines the `INDEXED BY` subquery form — in which case `planUsesIndex` returns false and the probe
  reports `unknown`, never a wrong verdict, so that failure mode is safe by construction.
- **Unstable-snapshot guard (the "quiesced store" half of fix 1):** research RQ1 also found that
  Turso's own docs claim snapshot stability while its **open TRUNCATE-vs-reader races (#7833, #8348)
  violate it** — so a persistent divergence under a live peer is not provably a torn read. Therefore
  when the confirmation re-probes (§5.1 bullet 2) still disagree **and** the quiescence oracle reports
  live peers, report the finding as `unknown` — never `damaged` — with a detail naming the live peers
  and stating that a divergence was observed but could not be confirmed on an unstable snapshot. On a
  quiescent store the same observation reports `damaged` and proceeds to the §5.2 repair gate.
  `probeBtreeIndexes` therefore gains an optional second parameter
  `opts?: { quiescence?: () => { quiescent: boolean; livePeers: readonly { token: string; pid: number }[] } }`,
  and `verifyStoreIntegrity` threads `VerifyOptions.quiescence` into it (the same oracle as §4.3 —
  declared once on `VerifyOptions` and inherited by `RepairOptions`).
- **Replace** the two reads (`tableCount` at :1319/:1388 and the `executeGet(probeSql)` at :1450)
  with one combined `executeGet` per index:

  ```sql
  SELECT
    (SELECT COUNT(*) FROM (SELECT rowid FROM "edge"
       WHERE t_invalid IS NULL ORDER BY rowid))                          AS __table,
    (SELECT COUNT(*) FROM (SELECT "dst" FROM "edge" INDEXED BY "ix_edge_dst_live"
       WHERE t_invalid IS NULL ORDER BY "dst"))                          AS __index
  ```

  i.e. `SELECT (SELECT COUNT(*) FROM (<tableSql>)) AS __table,
  (SELECT COUNT(*) FROM (<indexSql>)) AS __index`, where `<tableSql>` is today's `tableCount` SQL
  body and `<indexSql>` is today's `probeSql` body — both unchanged internally (the `INDEXED BY`
  hint, the partial predicate, and the `ORDER BY` on the leading indexed column are all preserved;
  they are load-bearing per :1418-1426).
- **Delete the `baseCounts` cache** (:1365, :1386-1390). It cannot be shared across two separately
  read counts without re-introducing the torn read; the table count is now computed once per index.
  Accepted cost, to be measured (see §7 arm A3): a table count via `ORDER BY rowid` is sub-ms at
  this store's scale (~14k rows), and `planUsesIndex` already issues one `EXPLAIN QUERY PLAN` per
  index. If measurement shows a regression, batch per `(tbl_name, predicate)` into one statement
  with N subqueries — same atomicity, strictly fewer scans — as a follow-up, not in this batch.
- `planUsesIndex(adapter, probeSql, ix.name)` is unchanged and still runs on the index-only SQL
  before the combined read (the planner's choice inside a subquery is determined by that subquery's
  text).
- **Confirm-before-damaged (new, small):** when `__index !== __table`, re-run the combined read up
  to `PROBE_CONFIRM_ATTEMPTS = 2` additional times (bounded, no sleep — await the next statement).
  Report `damaged` only if the divergence **persists**. If it clears, report `ok` with a detail that
  names the transient observation (never silent — a transient divergence is a real signal about
  store behaviour worth a log line). This is the in-production form of the discriminating test
  (§7 arm B) and the second layer of defence behind the atomic read.
- **Never touch:** `parsePartialPredicate`, `parseFirstIndexedColumn`, `isInternalObject`,
  `isFtsIndex`, `isCustomMethodIndex`, `planUsesIndex`, the `unknown`-finding branches, the
  `probeFtsIndexes` / `probeJsonColumns` / `probeIntegrityCheck` probes.

### 5.2 `integrity.ts` — `repairStoreIntegrity()` (fix 1, layers 3+4)

- **Change:** for `case 'btree_index_populated'` (:2839-2843), do **not** call `REINDEX` on the
  strength of the finding alone.
  1. **Quiescence gate.** If `opts.quiescence` is supplied and reports `!quiescent`, push a
     `RepairAction` with `ok: true`, `skipped: 'live_peers'`, action
     `'REINDEX declined: N live peer(s) hold the store'`, and `continue` — do not REINDEX. (This is
     the same posture `RepairDeclinedLivePeersError` takes for the writable classic-engine repair:
     a destructive index rewrite is never taken under a live peer.) Emit `repair_skipped` through
     `onReport`.
  2. **Re-probe immediately before the act.** Re-run the *atomic* single-index probe for
     `finding.object`. If it now agrees, push `ok: true`, `skipped: 'transient_divergence'`, action
     `'re-probe found "<ix>" consistent; REINDEX skipped'`, and `continue`. Emit `repair_skipped`.
     Only if the divergence persists does `REINDEX` run.
- The existing BL-379 reverify (`:2875-2881`) is unchanged and now inherits the atomic probe for
  free — the post-repair verdict is consistent by construction.
- **Scope of the count probe, restated from research RQ2.** "Index entries > table rows" is *not* a
  reliable standalone corruption signature: `PRAGMA integrity_check` checks far more (missing index
  entries, out-of-order records, malformed records, UNIQUE/CHECK/NOT NULL) and `quick_check`
  deliberately **skips** the index-vs-table check. Legitimate count divergences exist for **partial**
  indexes (already handled — the predicate is part of the probe) and **expression** indexes (already
  excluded — `parseFirstIndexedColumn` returns null and the finding is `unknown`), plus FTS/shadow
  tables (already excluded — `isFtsIndex`). So the count probe is a **fast pre-filter**, and
  `probeIntegrityCheck` (the `deep` `pragma_integrity_check` probe) remains the **authoritative**
  primitive. This is exactly why §7 arm A2 uses `integrity_check` as its ground truth, and why the
  batch does not replace the count probe with it (the count probe is cheap and runs on the default
  `fast` depth; `integrity_check` is `deep`-only).
- **Never touch:** the `wal_identity`, `adapter_meta_unique`, `json_column_valid`,
  `json_empty_array_null`, `fts_index_live` cases; the `push()` closure; the `ok` computation.

### 5.3 `turso-adapter.ts` — `close()` drain (fix 3)

- **Split `close()` (:2962-3217) into two methods:**
  - `async close()` — the public contract: idempotence guard, `_neverOpened` short-circuit
    (unchanged, :2975-2979), then **`await this._drainInFlightOps()`**, then
    `await this._closeCeremony()`.
  - `private async _closeCeremony()` — today's body from `this.closed = true;` (:2980) through the
    driver close and cleanup (:3185-3217), unchanged except as noted below.
- **`private async _drainInFlightOps(): Promise<void>`** — bounded wait until `_inFlightOps === 0`.
  Implement with a waiter array resolved in `_trackOp`'s `finally` when the count reaches 0 (the
  same edge that arms the idle flush, :1034-1035):
  - on settle → return;
  - on timeout (`closeDrainTimeoutMs`, clamped, default 5000) → **throw
    `EStoreAdapterCloseDrainTimeout(this.coordPath, this._inFlightOps, waitedMs)`**. Never resolve
    with an operation abandoned (ADR-0012 §4).
- **The ceremony must not be tracked.** `_closeCeremony` sets `this.closed = true` at its top, so the
  checkpoint pragmas must bypass `_trackOp`. Add
  `private async _walCheckpointUntracked(mode: 'PASSIVE' | 'TRUNCATE'): Promise<{ busy?: number }>`
  calling `this.db.all('PRAGMA wal_checkpoint(' + mode + ')')` directly (no `_trackOp`, no
  `_markIfFatal`) and replace the five `this.executeAll('PRAGMA wal_checkpoint(…)')` call sites
  (:3018, :3062, :3126, :3135, :3155) with it. `verifyStoreIntegrity(this, {only:['wal_identity']})`
  at :3001 needs **no** change: `probeWalIdentity` is a pure fs check (`integrity.ts:1153-1195`) and
  issues zero adapter queries.
- **`_trackOp` gains a closed gate** (:1008, before `_cancelIdleFlush`):
  `if (this.closed) throw new EStoreAdapterClosed(this.coordPath);`
  This is what makes a post-close operation fail with a typed, legible error instead of the driver's
  opaque `TypeError` — the adapter's own paths stop producing the error fix 4 has to recognise.
- **`withConnectionClosedForRepair` (:3380-3448) must call `this._closeCeremony()` at :3405, not
  `this.close()`.** It already holds `_inFlightOps++` (:3390) for the whole close-repair-reopen
  window, so calling the draining `close()` would wait for a count its own caller is holding —
  a guaranteed deadlock. The `finally` at :3443 already resets `this.closed = false`.
- **`releaseIdleConnection()` (:2947-2960)** is unchanged in shape: it already bails on
  `_inFlightOps > 0`, so the drain is a no-op for it; its `await this.close()` then
  `this.closed = false` (:2957) still works because `close()` no longer leaves the latch set after
  the ceremony returns.

### 5.4 `turso-adapter.ts` — close-time WAL fold hardening (fix 2)

Inside `_closeCeremony`'s writable branch (:2999-3168), all three changes are additive and use only
the existing probe + typed reports:

1. **Track the fold result.** Introduce `let foldOk = false;` set `true` after the PASSIVE
   checkpoint succeeds (:3018-3019), and leave `false` when `reportFailedPassiveCheckpoint` runs.
2. **Never stamp a clean shutdown over a deferred checkpoint.** Gate `markCleanShutdown(this)`
   (:3037-3039) on `foldOk && !damaged` (today it is `!damaged` only). A deferred PASSIVE means
   frames were not folded; writing the clean-shutdown stamp over that is the silent-loss shape
   ADR-0012 §4 forbids.
3. **Re-probe WAL identity immediately before the destructive TRUNCATE.** Just before
   `PRAGMA wal_checkpoint(TRUNCATE)` in both branches, re-check
   `captureWalIdentity(this.coordPath)` against `this._walBaseline` (the same comparison
   `probeWalIdentity` makes). If the inode/dev moved or the `-wal` vanished **after** the pre-check
   already run at :3001-3004, skip the TRUNCATE and emit `checkpoint_deferred` with a detail naming
   the close-burst replacement — truncating a WAL whose identity moved under us is the BUG-008
   class this gate exists to prevent.
4. **Post-fold identity re-probe.** After the PASSIVE→TRUNCATE→`resetTshmAfterTruncate` sequence,
   run `verifyWalIdentityNow(this._walBaseline)` once more:
   - `replaced` **and** `!foldOk` → `emitIntegrityReport(dbPath, 'repair_failed', …)` — frames went
     to an orphaned inode and were never folded. This is the SIGKILL-adjacent / failed-checkpoint
     case, and it must never be silent.
   - `replaced` **and** `foldOk` → `emitIntegrityReport(dbPath, 'repaired', …)` — the PASSIVE fold
     copied the frames through the fd we hold.
   - `intact` → no report (healthy, and silence here is the correct signal).
5. **Never delete a `-wal`.** Audit result: the adapter never unlinks one (the turso engine does, on
   TRUNCATE). No new deletion is introduced; item 3 is the guard against acting on a WAL that a peer
   already replaced. Research RQ4 corroborates the rule from the SQLite docs — the only safe way to
   remove a WAL is to open the database and immediately close it; `SQLITE_FCNTL_PERSIST_WAL` governs
   retention. RQ4 also flags the classic-SQLite **WAL-reset bug (3.7.0–3.51.2, fixed 3.51.3)** for
   the `SqliteAdapterImpl` half of this fix: the bundled SQLite version is therefore worth pinning
   ≥ 3.51.3 (recorded as an open question, §10.6 — it is a dependency decision, not a code change in
   this batch).
6. **SIGKILL is the open path's job, and it already works** — the `-wal` survives, the BL-361 open
   marker is present, `hasUncleanShutdown` forces a `deep` pass, and the open-time content-dead
   reconcile handles a stale `-tshm`. Fix 2 adds no open-path code; it asserts the behaviour with a
   test (§7 arm D2).

### 5.5 `sqlite-adapter.ts` — parity (fix 3 + fix 2)

Decision: **include `SqliteAdapterImpl` in this batch.** Rationale: same package, same version, same
failure family, and its `_inFlightOps` machinery already mirrors the Turso adapter's
(:296, :819-851). Shipping a hardened Turso close beside an unhardened SQLite close would be a
known-identical defect in the same release.

- **Drain:** split `close()` (:1091-1150) the same way — `close()` = drain + `_closeCeremony()`; the
  `_trackOp` equivalent (:819) gains the `this.closed` gate throwing `EStoreAdapterClosed`. Its
  checkpoint calls are synchronous (`this.db.pragma(...)`), so no untracked-pragma shim is needed.
- **Fold hardening parity:** gate `markCleanShutdown` (:1144) on the PASSIVE result, and re-probe
  identity after the PASSIVE/TRUNCATE pair exactly as in §5.4 items 1–4. `SqliteAdapterImpl` has no
  `storeQuiescence` TRUNCATE gate today (its own comment at :1129-1143 accepts best-effort), so item
  3 is a no-op there; items 1, 2, 4 apply.

### 5.6 `turso-adapter.ts` / `sqlite-adapter.ts` — wire the quiescence oracle

At the `runOpenTimeIntegrity` call sites (`turso-adapter.ts:2279`, `sqlite-adapter.ts:887`) pass:

```typescript
quiescence: () =>
  storeQuiescence(this.coordPath!, this._lease?.token),
```

`sqlite-adapter.ts` has no lease; pass `undefined` there (the gate is Turso-specific, matching
`RepairDeclinedLivePeersError`'s own local-file-only posture, `turso-adapter.ts:3407-3421`).

---

## 6. Interactions (the reason these four ship as one batch)

**1 ↔ 2 — shared principle, shared primitive, shared paths.**
Both are "a concurrent peer's write makes an observation transient, and we then do something
irreversible on the strength of it". Fix 1's destructive act is `REINDEX`; fix 2's is
`wal_checkpoint(TRUNCATE)` and `markCleanShutdown`. Both fixes converge on one rule —
**re-probe immediately before the act, and decline if the store is not quiescent** — and both route
through `storeQuiescence()` (already the TRUNCATE gate at :3052-3059) and through
`captureWalIdentity`/`probeWalIdentity`. They also share the open path: fix 1's atomic probe runs
inside `runOpenTimeIntegrity`, which the same open path calls; fix 2's hardening is in the same
`_closeCeremony` that fix 3 rewrites. Shipping them apart would mean editing `_closeCeremony` twice
and re-deriving the same gate twice.

**3 ↔ 4 — one failure family, prevention + legibility.**
The chain is: `close()` does not drain → `db.close()` runs under an in-flight transaction → the
transaction's next statement throws `TypeError: The database connection is not open` → `code` is
`undefined` → `isErrorWithCode` returns `false` → `isDatabaseError` returns `false` → memory-core's
`wrapDbError` (`libs/memory-core/src/errors.ts:109`) never reaches its driver tier and the error is
classified generically. Fix 3 removes the cause (drain) and additionally makes the adapter's own
post-close operations fail with the typed `EStoreAdapterClosed` rather than the driver's TypeError.
Fix 4 makes the residual legible for every path the adapter does not own (a caller holding
`unwrap()`'s raw handle; a drain that times out; a future driver path). Either alone is
insufficient: 3 alone leaves an opaque error the day any other path races; 4 alone correctly
classifies an error that should not be reachable. Both touch `close()`'s tail and the
`_trackOp`/`_ensureHealthy` gate, which is why they cannot be separate releases.

**3 ↔ 1/2 — the `_closeCeremony` refactor is the intersection.** Fix 3 splits `close()`; fixes 2's
four hardening points all land inside the resulting `_closeCeremony`. Doing 3 first, then 2, means
one edit of the method, not two.

---

## 7. Independent segments

### Segment A — Error taxonomy (fix 4)
- **Files:** `src/errors.ts`, `src/index.ts`, `src/errors.spec.ts`
- **Dependencies:** none
- **Read tokens:** ~350 (`errors.ts:135-200, 264-320` + `index.ts` export block only)
- **Output tokens:** ~480
- **Required context:** read `errors.ts` lines 135-200 and 255-320 ONLY. Do not read the whole file.

### Segment B — Atomic probe + confirm (fix 1 layers 1–2)
- **Files:** `src/integrity.ts` (`probeBtreeIndexes`, :1362-1495)
- **Dependencies:** none (independent of A)
- **Read tokens:** ~300 (lines 1302-1500 only)
- **Output tokens:** ~350
- **Required context:** read `integrity.ts` lines 1302-1500 ONLY.

### Segment C — Repair gate + re-probe (fix 1 layers 3–4) + quiescence seam
- **Files:** `src/integrity.ts` (`RepairAction`, `RepairOptions`, `VerifyAndRepairOptions`,
  `repairStoreIntegrity` :2797-2889, `verifyAndRepair` :2914-2938, `runOpenTimeIntegrity` :3300-3321)
- **Dependencies:** Segment B (the re-probe calls B's atomic single-index read)
- **Read tokens:** ~450 (lines 200-300 and 2790-2940 only)
- **Output tokens:** ~420
- **Required context:** read `integrity.ts` lines 200-300 (the interfaces) and 2790-2940 ONLY.

### Segment D — Close drain (fix 3)
- **Files:** `src/turso-adapter.ts` (close split, `_drainInFlightOps`, `_walCheckpointUntracked`,
  `_trackOp` gate, `withConnectionClosedForRepair`, `releaseIdleConnection`), `src/types.ts`,
  `src/sqlite-adapter.ts`
- **Dependencies:** Segment A (imports `EStoreAdapterClosed` / `EStoreAdapterCloseDrainTimeout`)
- **Read tokens:** ~700 (`turso-adapter.ts` :990-1060, :2940-3220, :3380-3449; `sqlite-adapter.ts`
  :560-620, :1085-1150; `types.ts` :340-400)
- **Output tokens:** ~800
- **Required context:** read those exact ranges ONLY. `close()` is ~255 lines — read it in one pass,
  do not re-read it.

### Segment E — WAL fold hardening (fix 2)
- **Files:** `src/turso-adapter.ts` (`_closeCeremony` writable branch, `reportFailedPassiveCheckpoint`),
  `src/sqlite-adapter.ts` (`close` fold parity)
- **Dependencies:** Segment D (the `_closeCeremony` split must exist first; `foldOk` lives in it)
- **Read tokens:** ~300 (`turso-adapter.ts` :2994-3170, :3242-3258 only)
- **Output tokens:** ~350
- **Required context:** read `turso-adapter.ts` lines 2994-3170 ONLY.

### Segment F — Quiescence wiring at the open path
- **Files:** `src/turso-adapter.ts:2279`, `src/sqlite-adapter.ts:887`
- **Dependencies:** Segment C (the `quiescence` option must exist)
- **Read tokens:** ~80 (20 lines around each call site)
- **Output tokens:** ~60

### Segment G — Tests (see §8; four new files + fixtures)
- **Files:** the four new test files + two fixtures
- **Dependencies:** Segments A–F
- **Read tokens:** ~250 (the existing `integrity-repair-reverify.bl379.test.ts` and
  `close-throw-strands-marker-and-lease.spec.ts` headers only, for house style)
- **Output tokens:** ~2350

---

## 8. Test plan (with teeth)

House rules applied: real components, no mocks of the thing under test; explicit latches, never
sleeps; exit codes, not stdout; every arm must go RED if the bug is reintroduced (BL-225 red→green
staging, as documented in `close-throw-strands-marker-and-lease.spec.ts`).

### Arm A — probe atomicity (new: `probe-atomicity.bug-probe-desync.spec.ts`)

- **A1 (RED on old code):** a real Turso store with `edge`/`node` tables and their live indexes. A
  child fixture (`fixtures/probe-concurrent-writer-child.ts`) inserts/deletes rows continuously
  against the same store while the parent runs the **new** `probeBtreeIndexes` 200 times. Assert
  **zero** `damaged` findings. On the pre-fix two-statement probe this arm goes red — the harness is
  proven to reproduce the race, which is what makes the arm meaningful.
- **A2 (the discriminating test — torn read vs genuine Turso divergence):** if A1 ever reports
  `damaged`, the test asserts **both** (i) an immediate re-probe of that index clears the divergence
  **and** (ii) `PRAGMA integrity_check` (via `verifyStoreIntegrity({depth:'deep',
  only:['pragma_integrity_check']})`) reports no `missing from index` for it. Both hold ⇒ the
  observation was a **torn read** (hypothesis A: two auto-committed reads straddling a commit).
  Either fails ⇒ the observation is a **genuine multi-process-WAL divergence** (hypothesis B) and
  the test fails with a message saying exactly that: *the single-statement read is not sufficient;
  the count probe must be demoted to quiesced-only and `integrity_check` promoted to the
  authoritative index verdict.* Run this arm **twice**: once with live peers writing (expect the new
  unstable-snapshot guard to downgrade a persistent divergence to `unknown`, never `damaged`) and
  once on a quiesced store (expect a persistent divergence to report `damaged`). Research RQ2
  validates `integrity_check` as the ground truth for this arm — it checks missing index entries
  explicitly, where `quick_check` deliberately does not.
- **A3 (perf):** assert the probe's wall time over a seeded ~14k-row store stays within a recorded
  budget (capture the pre-change number in the test header). Guards the dropped `baseCounts` cache.
- **A4 (genuine-divergence control — proves the probe is not blind):** build a store with a
  deliberately under-populated index (the existing BL-335/BL-362 damage recipe:
  `turso-fts-damage-fixture.bl362.test.ts` / `integrity-selfheal.test.ts`'s damaged-store builders).
  Assert the atomic probe reports `damaged`, that it **persists** across re-probes, and that
  `integrity_check` names the index. Without this arm, A1 could pass by the probe simply never
  finding anything.
- **A5 (repair safety):** with a damaged index and a live peer holding the store, call
  `verifyAndRepair` with a `quiescence` oracle returning `{quiescent:false}`. Assert **no `REINDEX`
  ran** (`RepairAction.skipped === 'live_peers'`, `ok === true`) and the index is still damaged
  afterwards. Then drop the peer and re-run: assert the REINDEX runs and the index verifies clean.

### Arm B — close drain (new: `close-drains-inflight.d677a575.spec.ts`, the permanent repro)

Deterministic, latch-based, no sleeps:
1. Open a real `TursoAdapterImpl` on a temp store; create a table.
2. Start a transaction that parks on a test-controlled latch:
   `let release!: () => void; const gate = new Promise<void>(r => (release = r));`
   `const tx = adapter.transaction(async (t) => { await gate; return t.executeGet('SELECT 1'); });`
3. `const closePromise = adapter.close();`
4. **B1 (RED on old code):** assert `closePromise` is still **pending** after a bounded number of
   macrotask turns while the gate is held. On the pre-fix code `close()` resolves in ~3 ms → red.
5. `release();` then assert `await tx` resolves **without** throwing, and
   `await closePromise` resolves. Assert the transaction's rejection (if any) does **not** contain
   `database connection is not open`.
6. **B2 (fail loud, never abandon):** open a second adapter with
   `{ closeDrainTimeoutMs: 50 }` (typed config — this is why the field exists), park a transaction on
   a latch that is never released, and assert `close()` **rejects** with `EStoreAdapterCloseDrainTimeout`
   whose message names the in-flight count. Then release and clean up.
7. **B3 (no opaque TypeError on the adapter's own paths):** after `await close()`, assert
   `adapter.executeGet('SELECT 1')` rejects with `EStoreAdapterClosed` — **not** a bare `TypeError`.
8. **B4 (parity):** repeat B1 against `SqliteAdapterImpl`.
9. **B5 (no deadlock regression):** `withConnectionClosedForRepair(fn)` on a live Turso adapter must
   still complete and the adapter must remain usable — this is the arm that fails if Segment D
   routes the repair path through the draining `close()`.

### Arm C — taxonomy (extend `src/errors.spec.ts`)

- **C1 (real driver error, not a hand-built object):** open a real adapter, `unwrap()` the raw
  driver handle, `await db.close()`, then `await db.get('SELECT 1')`; catch the **real** error and
  assert `isDatabaseError(err) === true` and `isClosedConnectionError(err) === true`. This is the
  repo's "drive the real component" bar — a fabricated `{code:undefined}` object would pass on a
  wrong predicate.
- **C2 (exact shape):** `isDatabaseError({ name:'TypeError', message:'The database connection is not
  open', code: undefined })` → `true`.
- **C3 (no over-matching — the negative controls):**
  `isDatabaseError(new Error('file is not open'))` → `false`;
  `isDatabaseError(new TypeError('x is not a function'))` → `false`;
  `isDatabaseError({ message:'The database connection is not open' })` → `false` (not an `Error`);
  `isDatabaseError('The database connection is not open')` → `false`;
  `isDatabaseError(null|undefined)` → `false`.
- **C4 (strict widening, no regression):** every arm in the existing suite is unchanged —
  re-assert the SQLite `code` arms and the `GenericFailure` phase-prefix arms verbatim.
- **C5:** `isClosedConnectionError` does not match the fatal/busy/unique classes (a `GenericFailure`
  I/O message, `database is locked`, a UNIQUE violation) — it is a scalpel.

### Arm D — WAL fold hardening (new: `wal-fold-hardening.spec.ts`)

- **D1 (never stamp clean over a deferred fold — RED on old code):** force the PASSIVE checkpoint to
  fail (hold a peer reader pinning the WAL, or stub the untracked checkpoint to throw) and assert
  `markCleanShutdown` was **not** written (read `_adapter_meta`'s clean-shutdown key) and that the
  emitted report is `checkpoint_deferred`, never a clean-shutdown claim. On the pre-fix code the
  stamp is written → red.
- **D2 (SIGKILL mid-write, real process):** `fixtures/sigkill-midwrite-child.ts` writes through a
  real `TursoAdapterImpl` and is `SIGKILL`ed while its `-wal` holds un-folded frames. Assert the
  parent's subsequent open (a) replays every frame — read the child's last committed row back, and
  (b) reports `wal_identity` `ok` after the open-time fold, and (c) `integrity_check` is clean. This
  is the case no close-time code can run for, and the assertion that the open path is the real
  backstop.
- **D3 (post-fold identity re-probe):** replace the `-wal` (rename a fresh file over it, the
  `wal-ownership.bug026.spec.ts` technique) between the pre-check and the TRUNCATE; assert the
  TRUNCATE is **skipped** and `checkpoint_deferred` is emitted naming the replacement. On the
  pre-fix code the TRUNCATE runs against the foreign WAL → red.
- **D4 (negative control):** a clean, quiescent close still writes the clean-shutdown stamp and
  truncates the WAL — the hardening must not turn a healthy close into a deferral.

---

## 9. Release plan

### 9.1 Version call — **minor, `0.9.2` → `0.10.0`**

Justification (semver, pre-1.0):

- **Additive public API:** two new exported error classes (`EStoreAdapterClosed`,
  `EStoreAdapterCloseDrainTimeout`), one new exported predicate (`isClosedConnectionError`), one new
  optional config field (`AdapterConfig.closeDrainTimeoutMs`), one new optional `RepairOptions`
  field, and one new optional `RepairAction.skipped`. A patch release may not add public surface.
- **A documented behaviour change:** `close()`'s completion contract changes — it now blocks until
  in-flight operations settle and may reject with a new typed error. `StoreAdapter.close()` is a
  documented public contract (`types.ts:485`), so this is observable by callers.
- **A widened predicate:** `isDatabaseError` returns `true` for a class of input it previously
  rejected. Additive in direction, but a behaviour change in a public helper.
- Consumers pin `^0.9.2` (all `workspace:^` in-repo); `0.10.0` is delivered to them automatically,
  which is the correct outcome for an additive + hardening release.

Not a patch (surface + behaviour change), not a major (nothing is removed or renamed; every
previously-true `isDatabaseError` input stays true; no consumer must change a call site).

### 9.2 The changeset

```bash
pnpm changeset add      # select @adhd/sox-store-adapter → minor
```

Changeset body must state, explicitly, because the gates read it:

- the **new exported surface** (the three symbols + two optional fields) — required for
  `check-changeset-surface` (BL-460, `dist/*.d.ts` vs last-published) to pass rather than flag
  silent drift;
- the **`close()` completion-contract change** and the new `EStoreAdapterCloseDrainTimeout`
  rejection path;
- that `isDatabaseError` is **strictly widened** (no previously-true input becomes false);
- that `closeDrainTimeoutMs` is typed tuning, not a toggle (ADR-0013).

Never hand-edit `package.json`'s `version` — `changeset version` owns it (PUBLISHING.md:67-71).

### 9.3 Gate ordering (PUBLISHING.md:37-65)

1. `pnpm install` (workspace protocol — the dep graph is unchanged, but the doc's rule is absolute).
2. `npx nx affected -t build,lint,test --base=origin/main` (C3 gate). Never `run-many`.
3. `pnpm run check-publishable`, `pnpm run check-changeset-surface`, `pnpm changeset status`.
4. **Only then** `changeset version` — it consumes the changesets the gates read.
5. `release:prepared` (publish half: `release-consumers` → `build-index:publish` → `nx build sox` →
   `changeset publish`).
6. Post-version verification recipe from PUBLISHING.md (the gates are structurally red after
   `version`; that is expected).

Never `--skip-nx-cache` (AGENTS.md §5).

### 9.4 npm-verify (post-publish)

1. `npm view @adhd/sox-store-adapter@0.10.0 version dist.tarball` — the version resolves.
2. `npx nx run @adhd/sox-store-adapter:verify-dist-load` **before** publishing — builds and
   `import()`s the real `dist/` entry the way a consumer does (a green `nx test` resolves to source
   and never loads the shipped bundle).
3. In a throwaway dir outside the workspace: `pnpm add @adhd/sox-store-adapter@0.10.0`, then a
   script that imports `{ isDatabaseError, isClosedConnectionError, EStoreAdapterClosed }` from the
   **published** package and asserts `isDatabaseError({name:'TypeError',
   message:'The database connection is not open', code: undefined}) === true`. This proves the
   widened predicate actually shipped in the bundle, not just in `src`.
4. Confirm the tarball's `dist/index.d.ts` contains the three new exports (the
   `check-changeset-surface` gate's post-publish half).

### 9.5 Cascade — who consumes the adapter, and what must move

| Consumer | Current pin | Action |
|---|---|---|
| `@adhd/sox-graph-store` (`libs/data/graph/graph-store`) | `workspace:^` | **Republish** after the adapter. Its published semver range on the adapter must admit `0.10.0`; if it pins `^0.9`, bump its own patch and republish. It is the transitive path by which `@adhd/backlog` reaches the adapter. |
| `@adhd/memory-core` | `workspace:^` | Republish. It is the consumer of `isDatabaseError` (`libs/memory-core/src/errors.ts:109`). |
| `vector-store`, `hybrid-search`, `analysis`, `semantic`, `blob-store`, `task-queue` | `workspace:^` | **Out of scope for editing** (concurrent executors). They must be included in the changeset's `cascade-plan` closure if they pin a range excluding `0.10.0`; the release tooling computes this — do not hand-bump their manifests. |
| `memory-server`, `memory-flush` (bundle members) | `workspace:*` | Republish as part of the bundle; the bundle's content checksum changes (ADR-0003/0005 — the checksum, not the version, is extension identity). |
| **`@adhd/backlog`** (`/Users/nix/dev/node/adhd`, `entrypoint/backlog`) | **frozen build pins 0.9.1** | **Deployment step, not part of this changeset** (different repo). After publish: bump `entrypoint/backlog`'s adapter pin `0.9.1` → `^0.10.0` (and its `@adhd/sox-graph-store` pin to the republished graph-store), reinstall, rebuild the frozen CLI, and smoke-test `backlog list-items`. The `backlog-v2` worktree already carries `0.9.2` and needs the same bump. Record the smoke-test output. |

---

## 10. Open questions

1. **Torn read vs genuine Turso multi-process-WAL divergence (the one real unknown).** The evidence
   (`backlog.cli-2026-09-22.jsonl:3684-3685`, index > table by 2 and by 1, immediately followed by
   REINDEX at `:3691-3692`, with a concurrent writer's `wal_cap_flush` at `:3686-3690` from a
   different pid) is fully consistent with a torn read across two auto-committed statements, and the
   single-statement fix makes it structurally impossible. It does **not** prove hypothesis B (that
   Turso's `multiprocess_wal` can hand one connection an internally inconsistent snapshot) is false.
   §7 arm A2 is the discriminating test and is the artefact that settles this. **Research has since
   raised the prior on hypothesis B:** RQ1 found Turso's own docs claim snapshot stability while the
   open TRUNCATE-vs-reader races (`#7833`, `#8348` — the same family that caused two store corruptions
   in 2026-08) **violate it**. A persistent divergence under a live peer is therefore not provably a
   torn read, which is why §5.1's unstable-snapshot guard now reports `unknown` rather than `damaged`
   in that case — the design resolves this by construction instead of by contingency, and §5.2's
   `REINDEX` gate means the false positive can never become a racing write. **Remaining decision
   rule:** if A2 shows a persistent divergence that `integrity_check` also names *on a quiesced store*,
   the count probe must be demoted further — quiesced-only, `unknown` everywhere else — and the deep
   `pragma_integrity_check` probe promoted to the authoritative index verdict. Do not merge A1 green
   without A2 having actually been exercised.
2. **`close()` blocking semantics vs the frozen backlog build.** `close()` now waits up to 5 s for
   in-flight operations. The frozen `@adhd/backlog` build calls `close()` per CLI invocation
   (thousands of short-lived processes, per ADR-0015's Context). If any of those hold a transaction
   across close, the bump turns a 3 ms close into a bounded wait. §7 arm B5 plus a cascade smoke test
   (`backlog list-items` timing) must confirm no regression before the adhd pin is bumped.
3. **A distinct `E_STORE_CLOSED` tier in memory-core.** ADR-0012 §3 puts taxonomy in memory-core.
   This batch only widens *detection*; the widened `isDatabaseError` routes the closed-connection
   error into memory-core's existing generic `E_IO` branch (`errors.ts:109-116`), which is
   defensible but loses the distinction between "the adapter was closed" and "an I/O fault". Adding
   a distinct `E_STORE_CLOSED` code is a memory-core change and therefore a **separate package's
   batch**, not this one. Flagged for the owner: is it wanted now, or when memory-core is next
   batched?
4. **Per-table batched count.** §5.1 keeps one statement per index; the per-`(tbl_name, predicate)`
   batch (one statement, N index subqueries) is strictly more efficient with identical atomicity.
   Deferred pending §7 arm A3's measurement. Not a blocker.
5. **`SOX_WAL_OWNERSHIP_HEARTBEAT_MS` interplay.** The heartbeat (`wal-ownership.ts:69-75`) re-checks
   identity every 10 s during a session; fix 2 adds a post-fold re-probe at close. The two use the
   same predicate and cannot disagree. No new knob is introduced — confirm during review that no
   reviewer reads fix 2 as warranting a heartbeat-interval change (it does not).
6. **Bundled SQLite version for the classic adapter.** Research RQ4 flags the classic-SQLite
   WAL-reset bug fixed in **3.51.3** (present 3.7.0–3.51.2). `better-sqlite3` bundles SQLite;
   `SqliteAdapterImpl` inherits whatever that build carries. §5.5's fold hardening makes a *deferred*
   checkpoint safe and loud regardless, but pinning `better-sqlite3` to a build carrying SQLite
   ≥ 3.51.3 is the belt. This is a dependency decision, not a code change in this batch — flagging it
   so the pin is checked (and recorded) rather than assumed.
7. **This is a reinstatement, not a new mechanism.** Prior memory (`01M3598X9PCT0ZZPJ78EHSY15Q`,
   `01M359J8CJKMX8C5CJAG0D63K0`) records a **live reproduction** of the closed-connection `TypeError`
   after a one-shot create together with the **removal of a close-time drain**, and a verdict demanding
   exactly "bounded close-time drain, failure loud and recorded". Segment D therefore restores a
   previously-removed guarantee, not a novel one — worth stating in the changeset so a reviewer does
   not read the drain as new behaviour that needs a flag day.

---

## 11. What must NOT be touched

- `wal-ownership.ts` — its lifetime protocol is correct and orthogonal; fix 2 uses its predicate.
- `store-lease.ts` — the quiescence primitive is reused as-is, not modified.
- `concurrency-mode.ts`, `concurrency-mode-contract.spec.ts` — ADR-0012 §2: nothing here touches
  `needsWriteSerialization`, `concurrentTransactions`, or `multiprocessWal`.
- `preflight.ts`, `engine-guard.ts`, `fts-orphan-guard.ts`, `sidecar-retention.ts`.
- `vector-store` and `hybrid-search` (concurrent executors).
- Any `SOX_*` env var (ADR-0013 D1).
