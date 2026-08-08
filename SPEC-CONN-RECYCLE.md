# SPEC-CONN-RECYCLE — TursoAdapter fatal-error detection + connection recycling

**BL item:** `BUG-TURSO-WAL-SHORTREAD-WEDGES-BACKEND-001` (repo `sox-ecosystem`). Root cause is
already established there (2026-08-08 note) — this spec builds the fix, it does not re-derive it.

**Worktree:** `/Users/nix/dev/ai/sox-ecosystem/.worktrees/adapter-connection-recycle`, branch
`feat/adapter-connection-recycle`. Toolchain verified: `pnpm install` succeeded, `npx nx test
store-adapter` passed 361/361 (2026-08-08, this session).

**Scope fence:** `libs/data/store/store-adapter/` and `libs/memory-core/src/telemetry.ts` only. Do
**not** touch `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` (sibling
packet owns the embed provider + memory-server health surface). If a change there turns out to be
required, stop and report — do not edit it.

---

## 1. Root cause, in my own words, with citations I opened myself

`TursoAdapterImpl` holds exactly one native connection (`this.db`,
`libs/data/store/store-adapter/src/turso-adapter.ts:79-86`) for the process lifetime. Every one of
its query methods is a bare pass-through with no try/catch:

- `executeGet` — turso-adapter.ts:490-493
- `executeAll` — turso-adapter.ts:495-500 (`await this.db.all(sql, ...args)`, no classification)
- `executeRun` — turso-adapter.ts:502-506
- `exec` — turso-adapter.ts:524-527
- `_runTransaction`'s `BEGIN`/`COMMIT`/`ROLLBACK` — turso-adapter.ts:576, 588, 592 (also bare
  `this.db.exec(...)`, bypassing even the top-level methods above)

`instrumentQueryMethods` (`libs/memory-core/src/telemetry.ts:354-378`, wired into
`instrumentAdapter` at :394-420) is the only wrapper in the whole stack that ever sees these
rejections, and its `catch` block does exactly one thing — `log.error('store.error', {...})` — then
`throw err` unchanged (telemetry.ts:365-374). It observes the failure and does not act on it.

I grepped the adapter file for `reconnect|reopen|recycle|isFatal` — zero hits. `connect()`
(turso-adapter.ts:157-414) is invoked exactly once, from `factory.ts`'s `createStoreAdapter()`, and
never again for the life of the instance.

**Consequence:** once the native driver raises a connection/storage-layer fault on `this.db`, that
same poisoned handle keeps being handed to every subsequent caller — including a `memory_ping` read
that shares no state with the call that failed — because nothing ever notices the handle died.
Recovery requires killing the process, matching the incident (`kill -TERM` on pid 78407 was the only
recovery, per the BL item body).

**Why BL-348's stage isolation didn't help:** it isolates a *pass* (the drain), and the drain's
failure was correctly contained — the drain itself degraded, as designed. But the corrupted resource
is `this.db`, shared global state *underneath* the pass boundary. Isolating the pass cannot isolate a
fault that already poisoned the substrate every pass and every foreground read shares.

## 2. Empirical finding that changes the design — read this before writing the classifier

I probed the real driver directly (`@tursodatabase/database@0.7.1`, the version pinned in this
worktree's lockfile) against a throwaway local store, issuing five representative statement-local
failures plus reading the real error shape:

```
bad SQL syntax      -> code=GenericFailure  message="failed to consume stmt: near \"SELEKT\": syntax error"
unknown table        -> code=GenericFailure  message="prepare failed: Parse error: no such table: nope"
unknown column        -> code=GenericFailure  message="prepare failed: Parse error: no such column: nope"
unique constraint       -> code=GenericFailure  message="step failed: Runtime error: UNIQUE constraint failed: t.name (19)"
type mismatch bind       -> code=GenericFailure  message="step failed: Runtime error: datatype mismatch"
```

**Every one of these is `code: 'GenericFailure'` — including the UNIQUE constraint violation.**

This directly contradicts `errors.ts`'s own docstring (`libs/data/store/store-adapter/src/errors.ts:1-9`,
`:80-88`), which claims `isUniqueConstraintError`/`isForeignKeyError`/`isBusyError` "duck-type across
both" adapters via a shared `SQLITE_*`-prefixed `code` field. **For the live `@tursodatabase/database`
driver, `code` carries zero discriminating information — it is `GenericFailure` for parse errors,
constraint violations, and (per the incident log) the fatal I/O error alike.** `isDatabaseError()`
(`err.code.startsWith('SQLITE_')`, errors.ts:154-157) and every helper built on that prefix are
**silently no-ops against Turso** — they were true only for `SqliteAdapterImpl`'s driver
(`better-sqlite3`, which does emit real `SQLITE_CONSTRAINT_UNIQUE` etc.).

This is a **pre-existing, separate defect** in `errors.ts` (its helpers have never actually worked
against Turso constraint violations) — not introduced by this packet, but this packet's classifier
cannot rely on those helpers or on `code` at all. **File this as a new backlog item before you
finish** (`backlog_create_item`, family `BUG`, title along the lines of "errors.ts SQLITE_*-code
helpers never match against the live Turso driver — code is always GenericFailure"), citing
`errors.ts:83-88,154-157` and this probe output, and link it related to
`BUG-TURSO-WAL-SHORTREAD-WEDGES-BACKEND-001`. Do not silently work around it without recording it —
per this repo's disclosure rules every discovered defect gets filed at time of discovery.

The good news: **the message text already carries the taxonomy Turso needs, in its own
vocabulary** — `Parse error:` (statement-shape), `Runtime error:` (constraint/type at execution),
and, per the incident's own log line, `I/O error:` (storage/filesystem layer):

```
Error: reset failed: I/O error: short read on WAL frame at offset 4152: expected 4096 bytes, got 0
```

## 3. The classifier — ruled, with losing alternatives named

**Decision: classify fatal-vs-statement-local by matching the `I/O error:` category marker in the
driver's own `message`, never by `code`, and never by matching the WAL/short-read specifics.**

```ts
// libs/data/store/store-adapter/src/errors.ts (new export)

/**
 * True if `err` is a Turso driver-level fault that has poisoned the shared
 * connection and requires reconnecting before the NEXT statement runs — as
 * opposed to a statement-local failure (bad SQL, constraint violation, type
 * mismatch) that leaves the connection perfectly usable for the next caller.
 *
 * MUST NOT be based on `err.code` — empirically (2026-08-08, against
 * @tursodatabase/database@0.7.1) EVERY Turso driver error carries
 * `code: 'GenericFailure'`, including UNIQUE constraint violations. `code`
 * carries zero discriminating information for this driver; see the BUG-*
 * item filed against errors.ts's SQLITE_*-prefix helpers for the same gap.
 *
 * MUST NOT match on "WAL"/"short read"/frame-offset specifics — the fix this
 * guards is required to catch disk pressure, a transient I/O error, or a
 * future driver bug identically, not just the one incident's shape.
 *
 * Turso's own error messages embed a category prefix after the phase verb
 * (`prepare failed:` / `step failed:` / `reset failed:`) — `Parse error:` for
 * statement-shape faults, `Runtime error:` for constraint/type faults at
 * execution, and `I/O error:` for storage/filesystem-layer faults. Matching
 * that THIRD category, and only that category, is the fatal signal: it is
 * the driver's own admission that the failure came from below the SQL layer,
 * not from what was asked of it.
 */
export function isFatalConnectionError(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  return /\bI\/O error\b/i.test(err.message) || /database disk image is malformed/i.test(err.message);
}
```

**Alternatives considered and why they lose:**

- **`code === 'GenericFailure'` → fatal.** Loses: this is the code for *every* Turso error observed
  in the probe above, including a plain UNIQUE violation. This is exactly the "too broad" failure
  mode the item warns against — it would reconnect on every ordinary constraint violation in the
  store, and on a store this size a reconnect is not free.
- **Match the exact WAL-short-read text.** Loses: this is exactly the "too narrow" failure mode named
  in the item — the next unclassified driver fault (disk pressure, a different I/O path, a future
  driver version's wording) reproduces the identical total wedge. `I/O error:` is Turso's own
  category label for the whole class this incident belongs to, not a symptom of this one bug.
- **`SQLITE_*`-prefix check (reuse `isDatabaseError`).** Loses: per §2, this driver never emits a
  `SQLITE_*`-prefixed code — the check is permanently false for Turso and would classify nothing as
  fatal ever, reproducing the outage exactly.
- **Allowlist of "known safe" message prefixes (`Parse error`/`Runtime error` → never fatal,
  everything else → fatal).** Rejected as the *shape* of the rule (deny-by-default is right — see
  next point) but not as literal text: a bare allowlist of two prefixes is one Turso wording change
  away from silently reclassifying a real statement error as fatal. The chosen rule inverts this
  safely: it is an **allowlist of fatal signatures** (`I/O error`, disk-image-malformed), default
  **not fatal** for everything else, INCLUDING messages this project has never seen. That default is
  deliberate — see next section for why "unknown → fatal" also loses.

**Why default-fatal-on-unknown loses too (the residual risk, named honestly):** a genuinely new,
unclassified driver fault that does NOT contain `I/O error` in its message will NOT trigger a
reconnect under this rule — the same class of gap the item warns about, just moved one level.
Accepting this: the fatal-signature list (`I/O error`, `database disk image is malformed`) is
Turso's own vocabulary for its `SQLITE_IOERR`/`SQLITE_CORRUPT`-lineage failures ported from upstream
SQLite's own message conventions (verified against the actual incident text) — it is a *category*,
not an *instance*, so it already generalizes across WAL frames, page reads, and any other I/O
surface the driver touches through the same message-formatting path. A rule that defaults to
"reconnect on anything unrecognized" reintroduces the "too broad" failure mode for the much larger
space of driver errors this project has NOT yet characterized (which, per §2, is apparently most of
them). Between a known-narrow gap (a hypothetical future I/O fault that doesn't self-report as
`I/O error:`) and a known-broad regression (churning connections on every unclassified error,
including whatever the *next* uncharacterized `Runtime error:` turns out to be), the narrow gap is
the smaller, more honest risk — and it is directly extensible: if a future incident produces a fatal
error that misses this pattern, add its category marker to the regex with the same evidence standard
(a probe against the real driver, not a guess), exactly as this packet did.

Add `isFatalConnectionError` to `libs/data/store/store-adapter/src/errors.ts` next to the existing
duck-type helpers, exported from `index.ts` (check `src/index.ts` — add the export if not already
wildcard-re-exported).

## 4. Reconnection mechanism — ruled

**Decision: mark-unhealthy-and-reconnect-lazily on next use, not eager.**

Losing alternative — eager reconnect (reconnect synchronously inside the failing call's catch
block, before rethrowing): loses because (a) it couples the original caller's error path to a second
fallible async operation, complicating what gets thrown when reconnect *also* fails; (b) it spends a
reconnect even when the process is about to exit or nothing else will touch the store, which is
wasted work exactly where lazy is free; (c) the item's own text names this tradeoff and lazy is the
side that "avoids reconnecting a store nothing is about to touch." Lazy still satisfies the
acceptance bar (a *later* unrelated read succeeds) because nothing requires the reconnect to happen
before the triggering call's own promise settles — only before the *next* call's query runs.

**Decision: reconnect via a full re-run of `TursoAdapterImpl.connect()` with the original `opts`,
not a narrower "just reopen the handle" path.**

Store the exact `opts` object passed to `connect()` on the instance (`this._connectOpts`, frozen) —
do not reconstruct it field-by-field from `this.config`, because `config` does not carry
`allowFtsInReadonly` (turso-adapter.ts:339-346 builds `config` without that field; only
`_softReadonly` derives from it, and `_softReadonly` alone can't be replayed back into a fresh
`connect()` call). Reusing the exact original `opts` also means reconnect gets the full existing
ceremony for free: the BL-361 out-of-process preflight, the BL-461 in-process FTS orphan guard, and
`runOpenTimeIntegrity`'s BL-352 verify-and-repair pass all run again on the fresh connection. This is
the "adapter already has a health concept… nothing wires a runtime I/O failure into it" opportunity
named in the task — reconnecting through the *real* `connect()` path wires it in for free, with zero
duplicated logic, rather than inventing a second, narrower "just reopen" code path that would need
its own integrity story.

Losing alternative — a bespoke lightweight reopen that skips the integrity ceremony: loses because it
reintroduces exactly the two BL-361/BL-461 hazards (schema-panic-on-open, orphaned FTS index) on the
connection this incident's own forensics show may be in a compromised state — the WAL was mid-write
when the fault hit. Skipping the checks that exist precisely for "may be compromised" states to save
a few ceremony statements is not a trade worth making on a recovery path.

**Concurrency: single in-flight reconnect, shared by all callers.** Multiple concurrent callers can
observe `_poisoned === true` in the same tick (this driver is async, and the adapter has no
per-caller isolation — see the existing BL-321 `_txMutexChain` comment at turso-adapter.ts:102-127
for the established precedent of one shared promise chain guarding one shared resource on this exact
class). Use the same shape: a single `_reconnectPromise: Promise<void> | null`; the first caller to
see `_poisoned` starts `_reconnect()` and stores the promise; every caller (including the starter)
`await`s it before issuing its own query. On success, clear `_poisoned` and the promise. On failure,
leave `_poisoned = true`, clear the promise (so the *next* call gets a fresh attempt rather than being
permanently stuck on one failed promise), and rethrow the reconnect failure to every awaiting caller
that arrived while it was in flight — an unreachable store should not fake success.

**Decision: never let the stale, poisoned connection's own `close()` block or fail recovery.**

Do not route the stale handle through the adapter's existing `close()` method
(turso-adapter.ts:627-669) — that method itself issues `verifyStoreIntegrity` and
`PRAGMA wal_checkpoint(PASSIVE)` against `this.db` (turso-adapter.ts:633,640), i.e. more queries
against the very connection that just proved it can hang or error on I/O. The incident's own
"only `kill -TERM` recovered it" symptom is consistent with a synchronous wait on exactly this kind
of call. Instead: fire a **bare, un-awaited, best-effort** `staleDb.close()` (catch and log, never
propagate) after the fresh connection is already live and assigned — this is cleanup, not part of the
recovery critical path. Log if it fails or does not settle; do not add a timeout race for v1 (the
call is detached from the promise chain entirely, so it cannot block anything even if it never
settles — no timeout is needed for correctness, only for eventually reclaiming the fd, which is a
lesser goal than not reproducing the wedge). Note for the record, not action: skipping this close
entirely risks leaving a stale WAL-index sidecar behind (BL-373's failure mode) — attempting the
close (even detached) is worth the attempt precisely to avoid compounding into that adjacent, already
-documented defect.

## 5. The change, file by file

### `libs/data/store/store-adapter/src/errors.ts` — IN SCOPE, additive only

- Add `isFatalConnectionError(err: unknown): boolean` per §3. Export it.
- Do **not** touch `isUniqueConstraintError`/`isForeignKeyError`/`isBusyError`/`isDatabaseError` or
  their docstrings in this packet — the fact that they don't work against Turso is real but is a
  **separate, already-filed** defect (§2). Fixing it here would silently expand this packet's blast
  radius into every caller of those helpers across the codebase; that fix needs its own review.

### `libs/data/store/store-adapter/src/turso-adapter.ts` — IN SCOPE, the core change

Add to `TursoAdapterImpl`:

- `private _connectOpts!: Parameters<typeof TursoAdapterImpl.connect>[0]` — set once, at the end of
  `connect()` (turso-adapter.ts:413, just before `return instance;`), to the **exact `opts` argument
  `connect()` received** (`Object.freeze(opts)` is fine — nothing in `connect()` mutates its own
  `opts` parameter today; verify that stays true).
- `private _poisoned = false;`
- `private _reconnectPromise: Promise<void> | null = null;`
- `private async _ensureHealthy(): Promise<void>` — if `_poisoned`, await-or-start
  `_reconnectPromise` per §4.
- `private async _reconnect(): Promise<void>` — call `TursoAdapterImpl.connect(this._connectOpts)`,
  adopt the fresh instance's `db`, `_walBaseline`, `_softReadonly` onto `this` (do **not** replace
  `this.config`/`this.capabilities`/`this._connectOpts` — those describe the adapter's identity, not
  its live connection, and must stay stable across a reconnect so callers holding a reference to
  `config`/`capabilities` never see them change under them); clear `_poisoned`; detached best-effort
  close of the stale handle per §4.
- `private _markIfFatal(err: unknown): void` — `if (isFatalConnectionError(err)) { this._poisoned =
  true; log.error('store_adapter.turso.connection.poisoned', { error: ... }); }` (use the same
  `@adhd/sox-telemetry` `log` import pattern already established in `retry.ts:3` — add the import to
  `turso-adapter.ts` if not already present).

Wire both into every direct `this.db.*` call site:

- `executeGet`, `executeAll`, `executeRun`, `exec` (turso-adapter.ts:490-527): `await
  this._ensureHealthy();` at the top; wrap the existing body in try/catch, calling `this._markIfFatal(err)`
  before rethrowing. `executeRun`/`exec` already call `this._assertWritable()` first — `_ensureHealthy`
  goes after that (a read-only-mode rejection is not a connection question).
- `_runTransaction` (turso-adapter.ts:550-601): `await this._ensureHealthy();` once at the top,
  before the retry loop (a transaction should never begin against a known-poisoned handle). Inside
  the loop, call `this._markIfFatal(err)` in the `BEGIN` catch (turso-adapter.ts:577-583) AND in the
  `fn(tx)`/`COMMIT` catch (turso-adapter.ts:590-596) before the existing rethrow. Additionally: if
  `isFatalConnectionError` is true in the BEGIN catch, **do not continue retrying that same doomed
  connection** — `throw err` immediately instead of `continue`, even if `attempt < maxRetries`
  (retrying BEGIN against a poisoned connection cannot succeed and only delays the caller). Leave the
  existing bare-catch `ROLLBACK` (turso-adapter.ts:591-595, "Ignore rollback errors") as-is — a
  rollback attempt against an already-poisoned connection failing is expected and already handled by
  being ignored; do not add fatal-classification there, since by that point `_poisoned` is already
  set from the `fn(tx)` catch above it.
- `TursoTransactionImpl` (turso-adapter.ts:44-71) — leave unchanged. It shares `this.db` by
  reference with its owning `TursoAdapterImpl`, so a fatal error inside a transaction body already
  surfaces through `_runTransaction`'s own catch (previous bullet) and marks the *adapter* poisoned.
  A transaction that dies mid-flight from a connection fault cannot itself be saved by a reconnect —
  `BEGIN`/`COMMIT` are tied to the specific connection they started on — so there is nothing for
  `TursoTransactionImpl` to do differently; the value of marking `_poisoned` here is entirely for
  callers *after* this transaction.

Add a **new, additive-only** optional member to the `TursoAdapter` interface in `types.ts` (see
next file) and implement it on `TursoAdapterImpl`:

```ts
get connectionHealth(): 'healthy' | 'poisoned' | 'reconnecting' {
  if (this._reconnectPromise) return 'reconnecting';
  return this._poisoned ? 'poisoned' : 'healthy';
}
```

This exists so the sibling packet (memory-server health surface, explicitly out of bounds for you)
can wire `memory_ping`'s store section to this without needing you to touch their file at all — you
expose the seam, you do not consume it. Do not add anything to `StoreAdapter` (the base interface) —
`SqliteAdapter`/`MockAdapter` have no connection-poisoning concept and must not be forced to
implement a getter that means nothing for them.

### `libs/data/store/store-adapter/src/types.ts` — IN SCOPE, additive only

- `TursoAdapter` interface (types.ts:341-345): add `readonly connectionHealth: 'healthy' |
  'poisoned' | 'reconnecting';`. This is a **new required member on a narrow, Turso-only interface**
  — additive from the consumer's point of view (nothing currently implements `TursoAdapter` other
  than `TursoAdapterImpl`; grep to confirm before merging) but still a public-type change, hence the
  changeset requirement below.

### `libs/data/store/store-adapter/src/index.ts` — IN SCOPE, check and extend if needed

- Confirm `isFatalConnectionError` is re-exported (this file is 15 lines; read it, don't guess its
  export shape).

### `libs/memory-core/src/telemetry.ts` — IN SCOPE per the task, but the ruling is: **no code
change needed, verify only.**

`instrumentQueryMethods`/`instrumentAdapter` (telemetry.ts:354-420) already do the one thing they're
supposed to: log and rethrow, unchanged, on every failure — including the ones that will now also
mark the adapter poisoned underneath them. The proxy wraps `executeGet`/`executeAll`/`executeRun`/
`exec`, which is exactly the set that now calls `_ensureHealthy()`/`_markIfFatal()` internally before/
after the real `this.db` call — the proxy is transparent to that, since it calls `bound(...args)`
(the real, now-guarded method) and only observes the result. **Read this file, run its consuming
suite, and confirm no change is required** rather than editing it speculatively — editing a file the
task explicitly calls out when the actual fix doesn't require it would be scope creep for no
behavioral gain.

### Explicitly OUT OF BOUNDS — do not touch, and why

- `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` — sibling packet's file
  (embed provider + health surface). `connectionHealth` (above) is the seam left for them.
- `libs/data/store/store-adapter/src/sqlite-adapter.ts` — `SqliteAdapterImpl` uses
  `better-sqlite3`, a **synchronous** driver with genuinely correct `SQLITE_*` error codes (unlike
  Turso — see §2). It has no analogous single-shared-async-connection poisoning failure mode this
  incident describes, and BL-154's WriteQueue re-entrancy note plus the "never flip
  needsWriteSerialization" constraint both signal that SQLite's concurrency story is settled and
  separate. Do not "generalize" this fix onto it.
- `libs/data/store/store-adapter/src/factory.ts` — creates the adapter once; nothing about
  creation changes, only what happens to the instance after a fatal error. Read it to confirm
  `createStoreAdapter()` calls `TursoAdapterImpl.connect()` with a plain `opts`-shaped object (so
  `_connectOpts` capture in `connect()` itself, not in the factory, is the right place) but do not
  edit it.
- `libs/data/store/store-adapter/src/mock-adapter.ts` — test double, no real connection to poison.

## 6. Acceptance criteria — each names a BL-id, each has a stated RED arm

All four live in a new test file:
`libs/data/store/store-adapter/src/__tests__/connection-recycle.bug-turso-wal.test.ts`. Use the
`hasTurso`/`tursoDescribe` skip-gate pattern already established in
`crash-recovery.bl338.test.ts:59-67`. Use `TursoAdapterImpl.connect()` against a real temp file (not
`MockAdapter` — the whole point is exercising the real driver's error shape).

**Fault injection technique (mandatory, do not invent an alternative):** obtain the raw driver handle
via the adapter's own public `unwrap()` (turso-adapter.ts:416-418 — this returns `this.db` directly,
the same object reference the adapter calls internally). Monkey-patch one method on that returned
object (e.g. `raw.all = async () => { throw fabricatedError; };`) to reject exactly once with a
fabricated error object shaped like the real driver's (`{ code: 'GenericFailure', message: '...' }`,
`Object.setPrototypeOf` onto `Error.prototype` or just `Object.assign(new Error(msg), {code:...})` so
`isErrorWithCode` sees it correctly). Because `unwrap()` returns the live object by reference, this
requires zero new production test-hooks and exercises the exact call path a real fault would take.

### AC-1 (BUG-TURSO-WAL-SHORTREAD-WEDGES-BACKEND-001, primary) — a fatal fault does not wedge a later unrelated read

1. Connect a real `TursoAdapterImpl` against a temp file; create a table; insert one row.
2. Monkey-patch `unwrap().all` to reject once with `{ code: 'GenericFailure', message: 'reset
   failed: I/O error: short read on WAL frame at offset 4152: expected 4096 bytes, got 0' }` — the
   incident's own text, verbatim, from the BL item body.
3. Call `adapter.executeAll('SELECT * FROM t')` — assert it **rejects** with that exact error
   (the classifier must never swallow or transform the original failure the caller asked about).
4. Call `adapter.executeGet('SELECT 1 AS x')` (stands in for `memory_ping`) — assert it **resolves**
   `{ x: 1 }`.
5. Assert `adapter.unwrap()` at step 4 is a **different object reference** than the handle captured
   before step 2 — proves an actual reconnect happened, not that the same handle happened to recover.
6. Assert `adapter.connectionHealth === 'healthy'` after step 4.

**RED arm:** with `_ensureHealthy`/`_markIfFatal`/`_reconnect` absent (current `main`), step 4 either
throws (the monkey-patch left `.all` broken, but note: only `.all` was patched, not `.get` — so on
`main` step 4 might actually still succeed if it uses a different db method!). **Sharpen the fault
injection to make RED unambiguous on `main`:** monkey-patch **all four** of `raw.all`/`raw.get`/
`raw.run`/`raw.exec` to reject with the fatal error on their first call each (simulating "the
connection itself is dead, every operation on it fails," which is what the incident actually showed
— `memory_ping`'s own probes failed too, not just the drain's query). Re-run step 4 against `.get` —
on `main` this now provably rejects (no reconnect exists to replace the broken handle); with the fix,
`_ensureHealthy()` reconnects before the `.get` call reaches the (still-broken) old handle at all, so
it resolves. Confirm this by actually running the test against `main` (stash the fix out via `git
stash` is banned — instead run it in the worktree *before* implementing, or temporarily comment out
the `_ensureHealthy()`/`_markIfFatal` call sites) and observing the failure, per BL-225.

### AC-2 (BUG-TURSO-WAL-SHORTREAD-WEDGES-BACKEND-001, negative arm) — a statement-local fault never reconnects

1. Connect a real `TursoAdapterImpl`; create a table with a `UNIQUE` column; insert one row.
2. Issue a **genuine** duplicate insert (no monkey-patching — let the real driver raise it) and
   assert it rejects with a message containing `UNIQUE constraint failed` (confirms the probe in §2
   is still accurate against whatever driver version is actually installed — if this assertion
   itself fails, the driver's error shape changed and `isFatalConnectionError` needs re-verifying
   before anything else in this spec is trustworthy).
3. Capture `adapter.unwrap()`'s reference before and after step 2 — assert **same reference**
   (no reconnect).
4. Assert `adapter.connectionHealth === 'healthy'` throughout (never transitions to `'poisoned'` or
   `'reconnecting'`).
5. Repeat steps 1–4 with a monkey-patched `{ code: 'GenericFailure', message: 'failed to consume
   stmt: near "SELEKT": syntax error' }` (bad-SQL shape from §2's probe) to cover the syntax-error
   family without depending on the driver rejecting malformed SQL a particular way.

**RED arm:** this criterion is RED under the "too broad" alternative design named in §3
(`code === 'GenericFailure'` → always fatal) — implement that alternative first, confirm AC-2 step 3
fails (reference changes, i.e. an unwanted reconnect fired on a plain constraint violation), THEN
switch to the message-marker classifier and confirm it passes. This is the concrete proof that the
chosen design is not "too broad," not just an assertion in prose.

### AC-3 (BUG-TURSO-WAL-SHORTREAD-WEDGES-BACKEND-001, concurrency) — concurrent callers share one reconnect

1. Connect a real `TursoAdapterImpl`.
2. Monkey-patch `unwrap().all`/`.get` to reject once each with the fatal I/O error (as AC-1).
3. Fire two concurrent calls that will both observe `_poisoned` after the first failure — e.g.
   `Promise.allSettled([adapter.executeAll('SELECT * FROM t'), adapter.executeGet('SELECT 1')])` — or
   more directly, wrap `TursoAdapterImpl.connect` (module-level `vi.spyOn` on the static method, NOT
   monkey-patching a driver method this time) to count invocations, then trigger poisoning and issue
   two concurrent post-poisoning calls.
4. Assert `TursoAdapterImpl.connect` was called **exactly once** more than the initial connect (i.e.,
   exactly one reconnect for two racing callers), and both calls eventually resolve.

**RED arm:** without the shared `_reconnectPromise` gate (i.e., each caller starting its own
`_reconnect()` independently), this assertion fails with `connect` called twice — implement the
naïve "always reconnect in `_ensureHealthy` with no promise memoization" version first, observe the
double-call, then add the memoization and observe exactly one call. If this is too costly to build as
a genuinely separate RED/GREEN pass given the turn budget, it is acceptable to demonstrate RED by
temporarily removing only the `if (!this._reconnectPromise)` guard (one-line deletion) rather than
building a whole naive implementation — document which method was used.

### AC-4 (new item you file per §2) — regression coverage for the errors.ts finding

Not required to block this packet's merge (it is a pre-existing defect, not introduced here), but
**do** add one `it.skip`-free assertion to `errors.spec.ts` (create if absent) asserting
`isUniqueConstraintError({ code: 'GenericFailure', message: 'step failed: Runtime error: UNIQUE
constraint failed: t.name (19)' })` is currently `false` — i.e., a test that **documents** the gap
rather than silently leaving it undiscovered by the next reader. Name it after the new BL-id from
§2 in the test description. This is deliberately RED-as-shipped (it documents a known-broken
helper) — do not mark the new backlog item RESOLVED from this packet; it stays OPEN, filed and
linked, for whoever picks it up next.

## 7. Risks

- **Data-destructive risk: none of this touches `~/.memory/*`.** All tests run against
  `mkdtempSync`-created temp files, same pattern as `crash-recovery.bl338.test.ts:76`. Verify every
  new test file follows this — grep the new test file for any hardcoded path before treating it as
  done.
- **`nx build`/`nx test` are destructive/build-triggering (BL-235/BL-456).** Do not run `npx nx build
  store-adapter` speculatively "to see an error" — read the TypeScript directly. Report
  `node tools/check-suite-tree-state.mjs --project store-adapter` alongside every test result you
  cite, per the house rules.
- **Reconnect-storm risk:** if `_connectOpts` were ever accidentally captured wrong (e.g., pointing
  at a stale/relative path), `_reconnect()` could loop marking itself poisoned again immediately.
  Mitigate by reusing the literal `opts` object `connect()` already received — never reconstructing
  it — per §4's ruling, and by AC-1 asserting the reconnected handle is genuinely usable (a wrong
  path would fail AC-1 outright, not silently).
- **Compounding into BL-373 (stale `-tshm`):** covered in §4 — the detached best-effort close of the
  stale handle exists specifically to minimize this, not eliminate it. If a future incident shows a
  reconnect leaving a stale sidecar, that is BL-373's existing recovery path (already handled in
  `connect()`'s own catch block, turso-adapter.ts:298-337) — the reconnect goes through the SAME
  `connect()`, so it inherits that recovery for free.
- **Changeset gate:** `TursoAdapter` gains a new required member (`connectionHealth`) — this is a
  public type change. Run `npx tsx scripts/check-changeset-surface.ts` (after building, since it
  diffs `dist/*.d.ts`) and add a `.changeset/*.md` for `@adhd/sox-store-adapter` (minor bump, 0.x
  policy) before merging if the gate demands one.

## 8. The gate — exactly what to run, and in what order

1. `npx nx lint store-adapter`
2. Read-only inspection of `libs/memory-core/src/telemetry.ts` (no edit expected — confirm via
   reading, not building).
3. `npx nx build store-adapter` — ONE TIME, after all edits are believed complete (BL-235: this is
   destructive; do not run it speculatively mid-edit).
4. `npx nx test store-adapter` — full suite, including the new
   `connection-recycle.bug-turso-wal.test.ts`. Report alongside
   `node tools/check-suite-tree-state.mjs --project store-adapter`.
5. `npx nx typecheck store-adapter` (and `memory-core`, since it consumes `TursoAdapter` — confirm
   the new `connectionHealth` member doesn't break any structural-typing assumption there).
6. `npx tsx scripts/check-changeset-surface.ts` — add a changeset if it demands one (§7).
7. File the new backlog item from §2 (`backlog_create_item`), link it to
   `BUG-TURSO-WAL-SHORTREAD-WEDGES-BACKEND-001` via `backlog_link_related`, and attach citations
   (`backlog_add_citation`) to both items pointing at the code you actually changed.
8. Do **not** run `node scripts/smoke-test.mjs` for this packet unless a later stage determines the
   `connectionHealth` seam needs to be consumed by memory-server (it is explicitly out of bounds
   here) — smoke-test exercises manifest-driven extension install/serve, not a data-package-only
   change; running it adds no signal for this diff and burns time.

Commit by explicit pathspec only (house rule): expect roughly
`git commit libs/data/store/store-adapter/src/errors.ts libs/data/store/store-adapter/src/turso-adapter.ts libs/data/store/store-adapter/src/types.ts libs/data/store/store-adapter/src/index.ts libs/data/store/store-adapter/src/__tests__/connection-recycle.bug-turso-wal.test.ts .changeset/<slug>.md -m "fix(store-adapter): detect fatal Turso driver faults and recycle the poisoned connection (BUG-TURSO-WAL-SHORTREAD-WEDGES-BACKEND-001)"`.
Never `git add -A`/`.`/bare `git commit`.
