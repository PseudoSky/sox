# ADR-0012 — Turso multi-process concurrent-write invariant and a driver-agnostic storage error taxonomy

**Status:** ACCEPTED (2026-08-08).
**Owner:** pseudosky.
**Supersedes:** [ADR-0007](./0007-memory-single-writer-architecture.md) (its invariant, D2, D5, and D9
are reversed/extended for the Turso adapter specifically; D1/D3/D4/D6/D7/D8 are untouched and still
hold — this ADR does not reopen reusable-subsystem, activation-posture, transport, store-identity,
topology, or platform-lifecycle decisions).
**Drives:** BUG-MEMORY-001 (`memory_write` drops a write at parallelism 4; raw SQLite-flavoured error
on Turso), subsumes BUG-ERRORS-TS-CODE-HELPERS-NEVER-MATCH-TURSO-001.
**Grounding:** SPEC-BUG-MEMORY-001.md (the implementation spec this ADR formalizes), the BL-321/BL-394/
BL-445 write-queue work already live on `main` before this ADR, and `SPEC-CONN-RECYCLE.md`'s
`isFatalConnectionError` precedent this ADR extends.

## Context

ADR-0007's invariant — *"at most one process may hold a write connection to a given store, and that
process is the one activated on the store's socket"* — was written against a SQLite-backed store and a
single in-process `WriteQueue` FIFO as the mechanism that made it true. Since then the factory default
flipped to `STORE_ADAPTER=turso` (`TursoAdapterImpl.connect()` sets `needsWriteSerialization: false`),
and `WriteQueue._create()` reads that capability flag and sets `queue._noop = true` — every Turso write
now bypasses the FIFO queue entirely and runs directly against the adapter (`_runBypass`). This was a
deliberate, owner-ruled architecture change (BL-394's "fork D of PKT-65" ruling, quoted in full below),
**not a bug** — but ADR-0007's invariant statement never caught up to it, and the code path the ruling
approved carried a real, separate defect: the bypass path never wrapped a raw driver exception into the
CONTRACTS §B `StorageError` shape, and never retried a classified-transient failure. A caller-visible
`Tool error: Error: database is locked` — a raw driver string reaching an MCP caller, exactly the
condition ADR-0007's own D5 named as a defect — was the direct, reproducible consequence
(BUG-MEMORY-001).

Investigating that incident also surfaced a second, structurally independent defect
(BUG-ERRORS-TS-CODE-HELPERS-NEVER-MATCH-TURSO-001): every helper in `store-adapter/src/errors.ts` keyed
off an `SQLITE_*`-prefixed `err.code`, a shape the live `@tursodatabase/database@0.7.1` driver never
produces (it emits `code: 'GenericFailure'` on every error). Those helpers were dead code on the
backend production actually runs, discovered only because `errors.spec.ts:20-26` had already captured
it as a deliberately-RED, uncorrected test.

## 1. The real invariant

Replacing ADR-0007's single-process invariant:

> **Multiple processes may hold concurrent write connections to the same Turso-backed store.**
> Writers are **serialized**, not concurrent: `multiprocess_wal` extends classic single-writer WAL
> across process boundaries via a `.tshm` coordinator holding a single-writer slot, so at any instant
> one process holds the writer slot and the rest block. What makes that survivable is the adapter's
> always-on busy timeout (`turso-adapter.ts` :70-91 — waits out the block instead of failing),
> `_runTransaction`'s bounded exponential-backoff retry on BEGIN failures, and the
> connection-poisoning/recycle machinery (`SPEC-CONN-RECYCLE.md`, `errors.ts`
> `isFatalConnectionError` :159-193) — not a queue. A queue never existed for this to be gated
> behind: `_noop = true` means `WriteQueue.enqueue()` never enters its FIFO path for a Turso-backed
> store at all.
>
> **This is NOT MVCC.** MVCC and `multiprocess_wal` are distinct, non-composable mechanisms, and
> Turso's own documentation says to use one or the other, never both. MVCC requires
> `PRAGMA journal_mode='mvcc'` **and then** `BEGIN CONCURRENT`; it is single-process only
> (in-memory `MvStore`, no cross-process coordination) and upstream marks it "not production-ready".
> Verified against this codebase: `journal_mode` is only ever set to `WAL`; the adapter enables
> exactly `['index_method', 'multiprocess_wal']`; `BEGIN CONCURRENT` exists as a capability
> (`db.ts` :1090) but the transaction default is `'deferred'` and **no production caller requests
> `mode: 'concurrent'`**. Turso's `experimental` flag enum contains no `mvcc` entry at all.
>
> The distinction is load-bearing, not pedantic: "optimistic concurrency with automatic conflict
> retry" is a materially stronger safety story than "writers queue and we wait", and neither one
> defends against the TRUNCATE-checkpoint races inside `multiprocess_wal` itself
> (upstream #7833 / #8348, open on every released line) that caused two store corruptions and a
> silent loss of ~15 records in 2026-08. Do not cite this invariant as evidence that concurrent
> writers are safe by construction.

What is explicitly **NOT** guaranteed by this invariant, stated so no reader assumes more than is true:

- **Ordering across processes is not FIFO.** Two racing writers may commit in either order. This was
  already true the moment `_noop` was set for Turso (BL-321/BL-394 predate this ADR); it is not a new
  relaxation this ADR introduces — it is being named explicitly for the first time.
- **A store opened in `needsWriteSerialization: true` mode (the SQLite fallback adapter) is still
  single-writer by construction** — `SqliteAdapterImpl` sets this flag `true`
  (`sqlite-adapter.ts:168`), which keeps `_noop = false` and routes every write through the FIFO queue
  exactly as ADR-0007 originally described. **The new invariant is Turso-specific, not universal across
  adapters** — do not read this ADR as retracting single-writer semantics for the SQLite path.
- **`mock-adapter.ts` also declares `needsWriteSerialization: false` (:183ff)**, matching Turso's
  capability shape, but it is a test double with no real concurrency underneath it — a mock reporting
  the same capability as Turso does not imply anything about production concurrency guarantees; it only
  means `WriteQueue` exercises the same bypass code path in tests that it does in production against
  the real adapter.

## 2. Write-queue consequence: `bypass` mode is correct and unchanged

`mode: 'bypass'` with `admission_control: 'inactive — adapter handles concurrency natively'` is
**CORRECT and remains unchanged by this ADR or by BUG-MEMORY-001's fix.** This was already the
owner's ruling, recorded verbatim in `write-queue-turso-concurrency.spec.ts:293-297` (2026-08-05,
"fork D of PKT-65"):

> "OWNER RULING 2026-08-05 (fork D of PKT-65): no admission control is added. Turso handles concurrent
> writes natively, the live store shows zero rejections, and there is no evidence a bound is needed. If
> a stress harness later shows a knee, a bound gets added then and sized from data. What is fixed here
> is the claim, not the mechanism."

This ADR restates that ruling formally rather than reopening it: the fix this ADR's implementation work
(SPEC-BUG-MEMORY-001.md §2.3) makes is error-wrapping and retry PARITY between the bypass path and the
FIFO path — bringing `_runBypass` up to the same `wrapDbError`-on-every-rejection contract
`_processNext` already had — never a change to whether writes serialize. **This bug was never about
bypass being the wrong mode; it was bypass having no error-wrapping/retry parity with the FIFO path.**
Nothing in this ADR or its implementation touches `needsWriteSerialization`, `concurrentTransactions`,
or `multiprocessWal` on any adapter.

## 3. Driver-agnostic taxonomy: adapter detects, memory-core classifies

Formal ruling (SPEC-BUG-MEMORY-001.md §2.2's reasoning, restated as ADR policy):

- **`@adhd/sox-store-adapter` owns driver-shaped DETECTION** — message-marker predicates
  (`isBusyError`, `isConcurrentConflict`, `isUniqueConstraintError`, `isForeignKeyError`,
  `isDatabaseError`, all in `errors.ts`) that recognize a specific driver's error SHAPE, keyed on
  whatever signal that driver actually gives (SQLite: `err.code`; Turso: message text, since `err.code`
  carries zero discriminating information for that driver).
- **`memory-core` (`wrapDbError`) owns the STABLE TAXONOMY** every `memory_*` tool contracts on
  (`E_BUSY`/`E_IO`/`E_DEDUP`/…, `{retryable, retry_after_ms}`) — it composes the adapter's detection
  helpers rather than re-implementing driver duck-typing itself.

This **extends an already-proven precedent** rather than inventing a new convention: connection
recycling's `isFatalConnectionError` (`store-adapter/src/errors.ts:159-193`, landed for
SPEC-CONN-RECYCLE before this ADR) already established "match the driver's own message-text markers,
never `err.code`" as the correct technique for a driver that gives no other signal. `isBusyOrLockedMessage`,
`isTursoUniqueConstraintMessage`, `isTursoForeignKeyMessage`, and the phase-prefix check in
`isDatabaseError` are the same technique applied to the four gaps
BUG-ERRORS-TS-CODE-HELPERS-NEVER-MATCH-TURSO-001 named. Extending a proven pattern beats inventing a
second one for the same problem: there is one technique to learn, one place (`isFatalConnectionError`'s
own doc comment, which already records the driver version this was empirically verified against) to
keep in sync the next time the driver's message format changes — which SPEC-BUG-MEMORY-001.md §1
already notes has happened once. A second, memory-core-local Turso regex would duplicate that
maintenance burden AND leave every OTHER store-adapter consumer (`retry.ts`'s `withRetry`, any future
adapter-level caller — `libs/data/CLAUDE.md` names `agent-source` as an external consumer of this
package) with the same dead helpers BUG-ERRORS-TS-CODE-HELPERS-NEVER-MATCH-TURSO-001 documented; fixing
detection in the adapter package resolves the subsumed item for everyone who imports it, not just
memory-core's write path.

## 4. Retry semantics

The write-queue (`_runBypass`) retries a classified-retryable failure up to **3 total attempts** (1
initial + 2 retries) with **linear backoff seeded from `retry_after_ms`** (250ms, then 500ms — matching
`TursoAdapterImpl._runTransaction`'s own `maxRetries=3` default for consistency between the two
independent retry loops that now exist at different layers — see SPEC-BUG-MEMORY-001.md §2.5 for why
both are needed and neither subsumes the other).

A still-retryable failure after 3 attempts is surfaced to the caller as a **structured, retryable
`StorageError`** — the CALLER (the MCP client / calling agent) is responsible for any retry beyond that
bound, and is told so explicitly: `retryable: true` remains present in the final envelope even on
exhaustion. Retrying the whole `operation` closure from scratch on every attempt (never a
resumable/checkpointed retry) is safe by construction for every memory-core write path — content-hash
dedup runs BEFORE the transaction opens, inserts happen INSIDE a transaction that ROLLBACKs on any
thrown error before rethrowing (`turso-adapter.ts` `_runTransaction` :761-774), so a failed attempt
never partially commits and a retry re-runs cleanly (SPEC-BUG-MEMORY-001.md §2.3's proof, re-verified
against `write.ts` and `turso-adapter.ts` during implementation, per the house constraint that this
specific claim be re-checked rather than trusted).

**Silent loss — an exhausted retry disappearing without any error reaching the caller — is explicitly
named as the thing this design must never do**, and is exactly what the pre-fix bug produced: defect
(A) rethrew raw with no wrapping and no retry at all; even fixing only (A)+(B) (wrapping and
classification, no MCP-boundary fix) would have exhausted retries into a correctly-shaped
`StorageError` that then got silently collapsed to `"Tool error: [object Object]"` by defect (C)
(`String()` on a structured object at the MCP dispatch boundary). All three defects are closed
together; SPEC-BUG-MEMORY-001.md §1 states why none is sufficient alone.

## 5. How this rot gets caught next time

Two concrete coverage gaps this investigation found and closed — named here so a future reviewer
recognizes the SHAPE of the next one, not just this instance:

1. **`libs/memory-core/src/errors.spec.ts`'s entire taxonomy suite pinned `process.env.STORE_ADAPTER =
   'sqlite'` explicitly**, with its own comment acknowledging *"the factory default is now
   STORE_ADAPTER=turso"* — i.e. the ONLY existing regression coverage for the entire storage error
   taxonomy deliberately opted OUT of the backend production actually uses. `wrapDbError`'s
   classification logic had never once been exercised, in any test, against the live default backend.
   `libs/memory-core/src/errors-turso.spec.ts` (added by this work) is the sibling that should have
   existed the day the default flipped.

   **Acceptance requirement going forward:** any FUTURE `StorageError` code path — a new error tier, a
   new classification branch, a new `StorageErrorCode` value — gets a test against BOTH backends
   (SQLite AND Turso), not just SQLite. A test suite covering `wrapDbError` or the store-adapter
   classification helpers may not silently skip the live-default backend the way this one did for as
   long as it did. A reviewer seeing a taxonomy-suite PR that pins `STORE_ADAPTER=sqlite` without an
   accompanying Turso-mode assertion should treat that as the same class of gap this ADR closes.

2. **`store-adapter/src/errors.spec.ts:20-26` was already RED-and-known, sitting uncorrected** — its own
   comment said, verbatim, "this test is deliberately RED-as-shipped… do not resolve the filed backlog
   item from this assertion alone." It was discovered, documented, and then left in that state until
   this work.

   **Acceptance requirement going forward:** a RED test documenting a known gap is not "coverage" —
   it is a TODO with a test harness attached, and per this repo's own BL-225 constraint (a status marker
   records a verified outcome, never an intention), a deliberately-red assertion sitting in a merged
   test file is structurally equivalent to an open CRITICAL backlog item. CI and review should treat it
   that way: a red-by-design test is a live defect with a reproduction case already written, not a
   documentation comment that happens to be executable.

## What does NOT change (unaffected ADR-0007 sections)

D1 (reusable subsystems), D3 (activation posture), D4 (remote-first transport), D6 (store identity),
D7 (topology enforcement/observability), D8 (platform lifecycle) are **not superseded** by this ADR —
none of them made any claim this ADR's investigation touched. Four sections are marked superseded, and
only for the specific claims this ADR revises:

- **The invariant statement** — replaced per §1 above (single-process → cross-process writers
  serialized by `multiprocess_wal`'s writer slot, with busy-timeout + retry absorbing the block).
- **D2** (single-writer hosting), insofar as it asserted single-writer as the concurrency-safety
  MECHANISM for Turso. D2's in-process-hosting-of-the-enrichment-orchestrator claim is untouched.
- **D5** (write path hardening) — its error-taxonomy sentence (*"Structured storage error taxonomy
  `E_BUSY/E_IO/E_ALLOWLIST` with `{retryable, retry_after_ms}` — a raw driver exception reaching a
  caller is a bug (BL-124)"*) stated the CONTRACT correctly but the implementation silently failed to
  honor it on the bypass path, exactly as BUG-MEMORY-001 documents. This ADR does not change the
  contract D5 states — it extends its DETECTION to be driver-agnostic (§3) and closes the parity gap
  that let the bypass path violate it (§2, §4). D5's other claims (`PRAGMA busy_timeout`/WAL/
  `synchronous=NORMAL`, `memory_write_batch` transactional array writes, idempotency keys, the
  enrichment watermark) are untouched.
- **D9** (storage engine exit ramp), insofar as it framed the write-queue/outbox seam as "the
  storage-agnostic boundary" without naming that Turso's own cross-process writer-slot serialization
  is now part of that boundary for the write path specifically.
