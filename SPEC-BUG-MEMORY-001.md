# SPEC — BUG-MEMORY-001: `memory_write` drops a write at parallelism 4; raw SQLite-flavoured error on Turso

**Author:** architect stage. **Worktree:** `.worktrees/bug-memory-001-write-loss`, branch `feat/bug-memory-001-write-loss`.
**Do not re-derive the root cause.** It is proven below with citations I personally opened and re-verified
(line numbers below were re-checked against this worktree's current HEAD — re-check again before editing,
they drift). Your job is to implement exactly this spec, run the gate, and report deviations — not to
re-investigate.

---

## 1. Root cause — three independent, compounding defects

**(A) The bypass write path never wraps errors.** `libs/memory-core/src/write-queue.ts`: `enqueue()`
(:724-775) branches on `_noop` (:737) — true for Turso, since `WriteQueue._create()` sets it whenever
`adapter.capabilities.needsWriteSerialization` is false (:589-590, confirmed `false` for Turso at
`libs/data/store/store-adapter/src/turso-adapter.ts:465-469`, and `true` for SQLite at
`sqlite-adapter.ts:168`/`mock-adapter.ts:183`). When `_noop`, every write runs through `_runBypass` (:780-838),
**never** through `_processNext`. `_runBypass` catches the operation's rejection and **rethrows it verbatim**
at :816 (async path) and :835 (sync-throw path) — it never calls `wrapDbError`. Compare `_processNext`
(the FIFO/SQLite-only path), which **does** wrap at :1218-1227 (`const wrapped = wrapDbError(err); …
item.reject(wrapped);`). This asymmetry is the entire explanation for the incident's literal surface —
`Tool error: Error: database is locked` is a raw `Error`, not a `{code,retryable}` envelope, precisely
because the path that produced it (Turso, `_noop=true`) is the one path with zero wrapping.

**(B) Even wrapped, the classifier is SQLite-only and dead on Turso.**
`libs/memory-core/src/errors.ts`'s own header (:2-5) states the invariant it fails: *"A raw driver
exception … reaching a caller is a defect."* `wrapDbError` (:28-64) has three tiers:
- :33 `isSqliteError(err)` duck-types a better-sqlite3 error (`code` starts with `SQLITE_` or
  `constructor.name === 'SqliteError'`). Turso's driver (`@tursodatabase/database@0.7.1`) emits
  `code: 'GenericFailure'` on **every** error, proven in-repo at
  `libs/data/store/store-adapter/src/errors.spec.ts:4-26` (a real captured UNIQUE-violation:
  `{code:'GenericFailure', message:'step failed: Runtime error: UNIQUE constraint failed: t.name (19)'}`).
  So the switch at :37-49 — including the **only** branch that ever produces `E_BUSY` (:38-40,
  `SQLITE_BUSY`/`SQLITE_LOCKED`) — is unreachable on Turso.
- :53-59 catches only `ENOENT`/`EACCES`/`EPERM`. `GenericFailure` matches none of them.
- :62-63 fallthrough: `{code:'E_IO', retryable:false}` for anything else, including a genuinely
  transient Turso lock/contention condition.

**(C) Even a wrapped, correctly-classified `StorageError` is destroyed at the MCP boundary.**
`libs/mcp-runtime/src/serve.ts`'s `buildToolDispatch` (:118-166) catches **any** exception a tool
handler throws and converts it with `text: \`Tool error: ${String(err)}\`` (:158-163) — `String()` on a
plain `{code,message,retryable}` object yields `"[object Object]"`, and on an `Error` yields
`"Error: <message>"`; either way the structured shape is gone by the time it reaches the caller.
`extensions/bundles/sox-memory-bundle/members/memory-server/src/backend.ts`'s `handleBackendRequest`
(:122-137) — the **actual live JSON-RPC dispatcher** memory-server uses for `tools/call` — duplicates the
identical pattern at :130-137 (its own comment at :138 says so: *"Shape … exactly as serve() does"*).
Fixing (A) and (B) alone still produces `"Tool error: [object Object]"` at the caller unless (C) is
also fixed. **All three must be fixed together; any one alone still loses/mangles the write.**

Where `case 'memory_write'` lives and confirms the call path: `extensions/…/memory-server/src/index.ts:1163`
onward; both the sync-embed branch (:1249-1250, `wq.enqueue('memory_write', …)`) and the default two-phase
branch (:1309, `await wq.enqueue<…>('memory_write', …)`) call `enqueue()` with **no** local try/catch —
a rejection propagates straight up to whichever dispatcher (backend.ts or serve.ts) invoked the handler.

### Why `wrapDbError` alone (fixing only B) is not enough, and why (A) alone is not enough

- Fix only (B): `_runBypass` still rethrows raw at :816/:835 — the fixed classifier is never called on
  the live (Turso, bypass) path. No behavior change.
- Fix only (A): `_runBypass` now calls the *existing*, still-SQLite-only `wrapDbError` — the Turso
  `GenericFailure` lock error still falls through to the :62-63 tier, producing a **structured but wrong**
  `{code:'E_IO', retryable:false}`. Structured, but still permanently misclassifies a transient condition
  as permanent, and nothing retries it — the write is still lost, just with a nicer error shape.
- Fix (A)+(B) but not (C): the caller now receives a correctly-shaped `E_BUSY, retryable:true` object —
  and it is silently destroyed into `"Tool error: [object Object]"` before it leaves the process.

All three are required. None is optional. None is suf ficient alone.

### The subsumed item: `BUG-ERRORS-TS-CODE-HELPERS-NEVER-MATCH-TURSO-001`

Already has a RED test at `libs/data/store/store-adapter/src/errors.spec.ts:20-26`, explicit and
deliberate: *"This test is deliberately RED-as-shipped… Do not resolve the filed backlog item from this
assertion alone."* It documents that `isUniqueConstraintError`/`isForeignKeyError`/`isBusyError`/
`isDatabaseError` (all in the same file, :106-157) are keyed on `SQLITE_*`-prefixed `err.code` — dead
on Turso for the identical reason (A)/(B) above are dead. **This item is subsumed and resolved as part
of this work** — see §2 file-by-file. The existing test at :20-26 is the seam: making it pass (flip
`.toBe(false)` → `.toBe(true)`, remove the "deliberately RED" framing from its comment since it will no
longer be true) is one of this packet's acceptance assertions.

---

## 2. The change, file by file

### 2.1 `libs/data/store/store-adapter/src/errors.ts` — driver-aware detection (adapter layer)

This file already has the precedent to follow: `isFatalConnectionError` (:190-193) classifies by
**message markers**, never `err.code`, with the doc comment at :165-172 stating in so many words that
`err.code` carries zero discriminating information on this driver. Extend the same technique to busy/lock
detection, and fix the four dead code-keyed helpers the subsumed item names.

**Add** (new, exported, same file, near the existing `isConcurrentConflict`/`isBusyError`):

```ts
/**
 * True if the message carries Turso's lock/busy-contention marker. Matches the
 * literal text observed in the BUG-MEMORY-001 incident report ("database is
 * locked", no phase prefix) AND the phase-prefixed form other Turso runtime
 * errors are known to carry (`step failed: Runtime error: …`, per
 * errors.spec.ts's captured UNIQUE-violation) — deliberately NOT anchored to
 * a phase prefix, since the incident's own raw text had none.
 */
function isBusyOrLockedMessage(message: string): boolean {
  return /database (is|table is) locked/i.test(message) || /database is busy/i.test(message);
}
```

**Modify** `isConcurrentConflict` (:106-109) and `isBusyError` (:117-120) to OR the existing
code-based check with `isErrorWithCode(err) && isBusyOrLockedMessage(err.message)`. Keep the code-based
branch exactly as-is (SQLite parity, existing tests must stay green) — this is a **strict widening**
(more `true`, never fewer), so it cannot regress any current caller. `isBusyError` keeps its documented
distinction from `isConcurrentConflict` (does not treat `SQLITE_BUSY_SNAPSHOT` as busy) — the message-based
branch does not carry that distinction either way (Turso's lock message doesn't disambiguate snapshot vs
plain busy at the text level), so OR it into **both** functions identically; do not try to invent a
textual way to tell them apart that the driver doesn't give you.

**Modify** `isUniqueConstraintError` (:125-128), `isForeignKeyError` (:133-136), `isDatabaseError`
(:154-157) — same widening pattern, using the phase-prefixed `Runtime error:` category confirmed real at
`errors.spec.ts:23` (`step failed: Runtime error: UNIQUE constraint failed: t.name (19)`):

```ts
function isTursoUniqueConstraintMessage(message: string): boolean {
  return /Runtime error:\s*UNIQUE constraint failed/i.test(message);
}
function isTursoForeignKeyMessage(message: string): boolean {
  return /Runtime error:\s*FOREIGN KEY constraint failed/i.test(message);
}
```
`isDatabaseError` widens to also return true when `err.code === 'GenericFailure'` **and** the message
matches the driver's own phase-prefix convention `/^(prepare|step|reset) failed:/i` (confirmed real at
`bl399-autolink-scope-meta-swallow.spec.ts:12` and `stats-bl343-row-resilience.spec.ts:11`) — this is
the honest "is this driver-originated at all" signal, not a guess.

**Fix `errors.spec.ts`**: the RED test at :20-26 must now read `.toBe(true)` and its comment must drop
the "deliberately RED-as-shipped… do not resolve from this assertion alone" framing (that framing is
now false — this assertion, alongside the others below, is exactly what resolves it). Add sibling
assertions for `isForeignKeyError`, `isBusyError`, `isConcurrentConflict`, `isDatabaseError` against
synthetic Turso-shaped fixtures, following the exact fixture style already in this file (literal
`{code:'GenericFailure', message:'…'}` objects, not mocks). Add the incident's own literal text as a
fixture: `{code:'GenericFailure', message:'database is locked'}` → `isBusyError` / `isConcurrentConflict`
both `true`. Do **not** touch `isFatalConnectionError`'s own tests (:28-73) — out of scope, already
correct, already the precedent being followed.

**package/changeset**: `@adhd/sox-store-adapter@0.3.0` is published. This is a strict behavioral widening
of five exported functions (`isBusyError`, `isConcurrentConflict`, `isUniqueConstraintError`,
`isForeignKeyError`, `isDatabaseError`) — additive, non-breaking (nothing that was `true` becomes
`false`). Add `.changeset/bug-memory-001-turso-error-classification.md` with bump `patch`, following the
format of `.changeset/conn-recycle-sox-store-adapter.md` (already in this worktree) — name every widened
function, cite this bug id, and state explicitly "no function changed signature; no previously-true
result becomes false."

### 2.2 `libs/memory-core/src/errors.ts` — driver-agnostic taxonomy (composer layer)

**Ruling (ADR question 3 — where classification belongs):** adapter (2.1) owns *detecting* a driver-shaped
condition; memory-core owns the *stable taxonomy* (`E_BUSY`/`E_IO`/…, `{retryable, retry_after_ms}`)
every `memory_*` tool contracts on. `wrapDbError` must delegate detection to store-adapter's now-fixed
helpers rather than re-implementing driver duck-typing locally. **Losing alternative:** re-implement a
second, memory-core-local Turso message regex inside `wrapDbError` instead of importing store-adapter's
helpers — loses because (a) it does NOT resolve the subsumed item (store-adapter's own helpers, and
`retry.ts`'s `withRetry` which depends on them, stay dead for every OTHER store-adapter consumer, not
just memory-core), and (b) it duplicates the exact regex logic in two packages that will drift the next
time the driver's message format changes (already happened once — `isFatalConnectionError`'s comment
records the driver observed 2026-08-08 against `@tursodatabase/database@0.7.1`; a version bump is a real
future risk).

**Add import**: `import { isConcurrentConflict, isFatalConnectionError, isUniqueConstraintError,
isDatabaseError } from '@adhd/sox-store-adapter';` (memory-core already depends on this package —
`write-queue.ts:98` already imports `StoreAdapter` from it; this is not a new dependency edge).

**Restructure `wrapDbError`** (:28-64) — keep the SAME exported signature and SAME final fallback shape
(no breaking change to the function's type), but reorder/extend the classification body:

```ts
export function wrapDbError(err: unknown): StorageError {
  if (isStorageError(err)) return err as StorageError;

  // Transient contention — Turso (message-marker) OR SQLite (SQLITE_BUSY/SQLITE_LOCKED code).
  // MUST be checked before the generic isDatabaseError tier below — a busy condition IS a
  // database error too, and the more specific classification must win.
  if (isConcurrentConflict(err)) {
    const msg = (err as { message?: string })?.message ?? String(err);
    return { code: 'E_BUSY', message: msg, retryable: true, retry_after_ms: 250 };
  }

  // Connection-fatal (Turso poisoned-connection markers, or SQLite SQLITE_IOERR) — not retryable
  // at THIS layer; TursoAdapterImpl already recycles the connection on its own (SPEC-CONN-RECYCLE),
  // so a retry here would race the adapter's own reconnect rather than help it.
  if (isFatalConnectionError(err) || isSqliteIoError(err)) {
    const msg = (err as { message?: string })?.message ?? String(err);
    return { code: 'E_IO', message: msg, retryable: false };
  }

  if (isSqliteError(err)) {
    // existing SQLITE_NOTFOUND / SQLITE_CONSTRAINT / default switch, UNCHANGED —
    // SQLite-only codes with no Turso equivalent handled above.
    …
  }

  if (isDatabaseError(err)) {
    // Turso GenericFailure, driver-originated, not busy, not fatal — e.g. a UNIQUE violation
    // reaching this generic path (constraint violations from the write path are normally caught
    // earlier via the content-hash dedup check, so this is a defensive fallback, not the primary
    // dedup mechanism).
    if (isUniqueConstraintError(err)) return { code: 'E_DEDUP', message: …, retryable: false, details: {} };
    const msg = (err as { message?: string })?.message ?? String(err);
    return { code: 'E_IO', message: msg, retryable: false };
  }

  // system errors (ENOENT/EACCES/EPERM) — UNCHANGED
  …
  // generic fallback — UNCHANGED
  …
}
```

`isSqliteIoError` is a tiny new local helper (`sqlCode === 'SQLITE_IOERR'`) extracted from the existing
switch so the fatal-connection tier can share it — do not duplicate the SQLITE_IOERR literal.

**Existing SQLite-mode tests must not move.** `errors.spec.ts` (memory-core) pins `STORE_ADAPTER=sqlite`
explicitly (:36-41) — re-run it FIRST, unmodified, after this change, to confirm the SQLite `E_BUSY`
path (forced real-lock via a second `better-sqlite3` connection) is byte-identical to before. This is
your regression guard for the restructure.

**Add**: a Turso-mode sibling of the SAME test, in the SAME file or a new
`libs/memory-core/src/errors-turso.spec.ts` (your choice — keep them next to each other; if the SQLite
test's harness — a second raw `better-sqlite3` connection holding `BEGIN EXCLUSIVE` — has no Turso
analogue, use a synthetic fixture instead, matching the store-adapter pattern: call `wrapDbError` directly
against `{code:'GenericFailure', message:'database is locked'}` and assert `{code:'E_BUSY',
retryable:true, retry_after_ms:250}`). **This is criterion 4's RED arm** — run it against the CURRENT
(pre-2.1/2.2) `wrapDbError` first and confirm it fails (`retryable:false` or `code:'E_IO'`), THEN apply
2.1+2.2 and confirm it passes. Record both runs.

**Why this file's existing test suite is the smoking gun for "how does this rot get caught next time"
(ADR question 5):** `errors.spec.ts:36-41` pins `process.env['STORE_ADAPTER'] = 'sqlite'` with the comment
*"the factory default is now STORE_ADAPTER=turso"* — i.e. the ONLY existing regression coverage for the
entire storage error taxonomy deliberately opts OUT of the live default backend. Nothing in the suite
ever ran `wrapDbError`'s classification against the backend production actually uses. The Turso sibling
test above is what should have existed the day the default flipped, and its absence is exactly ADR-0012's
§5 answer — require it in the ADR's acceptance section (§2.4 below), not just here.

### 2.3 `libs/memory-core/src/write-queue.ts` — wrap AND retry the bypass path

**Ruling (ADR question 4 — who retries):** the write-queue, not the adapter's `executeRun`/`transaction`
methods, not each MCP tool handler. **Reasoning:**
- Adapter-level retry (inside `turso-adapter.ts`'s `executeGet`/`executeRun`/`exec`) loses: those methods
  serve **every** store-adapter consumer (per `libs/data/CLAUDE.md`, `agent-source` depends on this
  package externally too), not just memory-core's write path; blind retry there changes latency/behavior
  for read call sites and non-memory consumers who never asked for it, and duplicates policy
  (backoff, telemetry, bounded attempts) the write-queue already owns for the FIFO path. It would also
  retry `fn(tx)` bodies that are not proven idempotent-on-replay by every caller — memory-core's writes
  happen to be safe to replay (see below) precisely *because* memory-core controls what each `operation`
  closure does; a generic adapter-level retry cannot assume that for arbitrary callers.
- Per-handler retry (inside each `case 'memory_write'`/`memory_write_batch'`/… in index.ts) loses: it
  multiplies identical retry/backoff logic across N MCP tool handlers (DRY violation), and the item's own
  "concrete lead" section names the write-queue specifically as the seam that disabled itself
  (`mode: 'bypass'`) without picking up the FIFO path's wrapping — the fix belongs where the asymmetry is.
- Transport-layer retry (serve.ts/backend.ts) is impossible: by the time an exception reaches the
  transport, the original operation closure is gone; only the write-queue still holds it.

**Why retrying the WHOLE `operation(adapter)` closure from scratch is safe** (verified by reading
`libs/memory-core/src/write.ts`): `memoryWritePhaseA`/`memoryWrite` perform their content-hash dedup
`SELECT` (write.ts:295-301) BEFORE opening `adapter.transaction()` (write.ts:334), and the actual
`INSERT`s happen INSIDE that transaction, which — per `turso-adapter.ts:761-774` — ROLLBACKs on any
thrown error before rethrowing. So a failed attempt never partially commits: a retry re-runs the dedup
check (now correctly seeing nothing, since the failed attempt rolled back) and re-inserts cleanly. For
the multi-chunk path (index.ts case, chunks.length > 1: one parent write + N chunk writes + edge-linking,
all inside ONE `operation` closure): each `memoryWrite`/`memoryWritePhaseA` call is independently
content-hash-deduped, so a retry that re-runs an already-succeeded chunk hits `E_DEDUP` and returns the
existing uid (not a duplicate); `linkChunksToParent` (index.ts:1220-1244) uses `INSERT … WHERE NOT
EXISTS`, so re-running it is a no-op for edges already inserted. **The entire write path is
retry-from-scratch safe by construction — do not build a resumable/checkpointed retry; a full replay is
strictly simpler and already correct.**

**Add** a bounded retry loop inside `_runBypass` (:780-838). Preserve the EXACT existing telemetry
contract — `writequeue.task.start`/`writequeue.task.finish`/`writequeue.task.error` must each still fire
exactly ONCE per logical `enqueue()` call (not once per attempt), and `_settleBypass`/counters
(`tasks_completed`, `write_tasks_completed`, `apply_tasks_completed`, the latency ring) must still be
touched exactly once — the existing BL-445 tests (`write-queue-turso-concurrency.spec.ts:147-274`) assert
this precisely and MUST still pass unmodified except where §2.3.1 below says otherwise. Retry attempts
are a NEW, separate log event, `writequeue.task.retry`, one per attempt, nested inside the same timing
window:

```ts
// Inside _runBypass, replacing the single `operation(this.adapter)` call with a bounded retry:
const MAX_ATTEMPTS = 3; // 1 initial + 2 retries — matches TursoAdapterImpl._runTransaction's own
                         // maxRetries=3 default (turso-adapter.ts:731) for consistency.
async function runWithRetry(): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await withTrace(resolvedTraceId, () => operation(this.adapter));
    } catch (err) {
      const wrapped = wrapDbError(err);
      attempt++;
      if (!wrapped.retryable || attempt >= MAX_ATTEMPTS) {
        throw wrapped; // final failure — always a StorageError, never a raw driver exception
      }
      const delayMs = (wrapped.retry_after_ms ?? 250) * attempt; // 250ms, then 500ms
      log.warn('writequeue.task.retry', {
        trace_id: resolvedTraceId, store: storeKey, label, kind, mode: 'bypass',
        attempt, max_attempts: MAX_ATTEMPTS, delay_ms: delayMs, error_code: wrapped.code,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
```

The existing `try { const result = withTrace(...) ...}` synchronous-throw branch (:788-837) and the
`Promise`-branch (:797-819) both call `operation(this.adapter)` directly today — replace BOTH call
sites with `runWithRetry()`'s body (or refactor so both paths share one retry-wrapped invocation; your
call how to structure it, but there must be exactly one retry loop, not two copies). **The final
rejection value change (raw `err` → `StorageError`) is a deliberate, documented behavior change** — see
§2.3.1.

#### 2.3.1 Existing tests that must be updated (not regressions — a ruled behavior change)

`libs/memory-core/src/write-queue-turso-concurrency.spec.ts` — two tests currently assert
`.rejects.toThrow('boom')` / `.rejects.toThrow('sync boom')` (lines ~201-206, ~221-225 as of this
writing — re-locate by test name, don't trust the line number). Post-fix, EVERY bypass-path rejection is
a `StorageError` object (not an `Error` instance) — this is the direct, intended consequence of closing
failure (A). Update both assertions to the pattern already established at
`libs/memory-core/src/errors.spec.ts:69-86` (settle via `.then((v)=>({ok:true,value:v}),
(err)=>({ok:false,error:err as StorageError}))`, then assert on `.error.code`/`.error.message`/
`.error.retryable`). A synthetic `Error('boom')` is not driver-shaped, so it hits `wrapDbError`'s
generic fallback tier — assert `{code:'E_IO', message:'boom', retryable:false}`. Do not weaken these
tests to merely check "it rejected" — that is exactly the BL-167 pattern the house rules forbid; assert
the full wrapped shape.

Every OTHER test in that file (BL-321's 20-way durable-commit test, BL-445's counter/latency tests, the
BL-394 admission-control-inactive tests, the unreachable-if-serialized concurrency test) must pass
**unmodified** — none of them assert on rejection shape, only on success values/counters, which this
change does not touch.

### 2.4 `libs/mcp-runtime/src/serve.ts` and `…/memory-server/src/backend.ts` — stop destroying structure at the MCP boundary

**Ruling:** fix once, in one shared place, reused by both call sites — not two independent patches. Add
an exported helper in `libs/mcp-runtime/src/serve.ts` (new file `libs/mcp-runtime/src/tool-error.ts` is
fine too if you prefer not to grow serve.ts; either way it must be exported from mcp-runtime's public
surface so `backend.ts` can import it):

```ts
/** Detect a StorageError-shaped object (CONTRACTS §B: {code, message, retryable}) without importing
 *  memory-core's type (mcp-runtime is generic; must not depend on any single tool consumer). */
function looksLikeStorageError(err: unknown): err is { code: string; message: string; retryable: boolean } {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return typeof e['code'] === 'string' && e['code'].startsWith('E_')
    && typeof e['message'] === 'string' && typeof e['retryable'] === 'boolean';
}

export function formatToolError(err: unknown): { isError: true; content: [{ type: 'text'; text: string }] } {
  const text = looksLikeStorageError(err) ? JSON.stringify(err) : `Tool error: ${String(err)}`;
  return { isError: true, content: [{ type: 'text', text }] };
}
```

Replace `serve.ts`'s catch body (:158-163) with `return formatToolError(err);`. Replace `backend.ts`'s
catch body (:132-136) with `result = formatToolError(err);`. This is a duck-type check (no cross-package
type import), additive-only (anything that wasn't StorageError-shaped keeps the exact current text), and
fixes the destruction for **every** MCP tool in the ecosystem that ever throws a `StorageError`-shaped
object, not just `memory_write` — matching ADR-0007 D5's original, general intent.

**Out of bounds, explicitly:** do not touch `serve.ts`'s transport binding, listing, or any other function
in that file; do not touch `backend.ts`'s `initialize`/`tools/list` branches or anything above line ~122.

### 2.5 What does NOT change (name + why)

- `libs/memory-core/src/write.ts` — the write path's SQL/transaction structure is already correct and
  already retry-safe (§2.3's proof). No edits.
- `extensions/…/memory-server/src/index.ts` `case 'memory_write'`/`case 'memory_write_batch'` bodies —
  no local try/catch added here; the fix lives one layer down (write-queue) and one layer up (transport).
  Adding a third catch here would be redundant and risks double-wrapping (`wrapDbError` on an
  already-StorageError value is a no-op per `isStorageError` at :30, so it's not unsafe, but it is
  unnecessary surface area — don't add it).
- `libs/data/store/store-adapter/src/turso-adapter.ts`'s `_runTransaction` BEGIN-retry loop (:740-759,
  `maxRetries=3`, blind retry on any non-fatal BEGIN failure) — **leave exactly as-is.** It already
  covers one sub-case (contention at `BEGIN`) unconditionally; §2.3's write-queue-level retry is a
  superset that also covers contention inside `fn(tx)`'s body and in the pre-transaction dedup
  `executeGet` — both of which `_runTransaction` structurally cannot retry (it only wraps `BEGIN`, and
  ROLLBACKs-then-rethrows on any error from the body, and the dedup `SELECT` isn't inside a transaction
  at all). The two retry loops are not redundant; do not remove or "simplify" either one.
- `retry.ts`'s `withRetry` — left unused by the write path (as it is today). It becomes usable by
  `runContractTests` and any future adapter-level consumer now that `isBusyError`/`isConcurrentConflict`
  are fixed (§2.1), which is a free side benefit, but wiring it INTO the write-queue was considered and
  rejected — §2.3 uses `wrapDbError`'s own `.retryable` flag as the single decision authority instead of
  re-deriving from store-adapter's raw predicates a second time. Do not import `withRetry` into
  write-queue.ts.
- `needsWriteSerialization`, `concurrentTransactions`, `multiprocessWal` — **never touched**, per the
  explicit house constraint. Confirmed correct by this investigation, not just asserted: `bypass` mode is
  the right architecture (§2.4 of the ADR content, next section) — the defect was error-handling parity,
  never the concurrency model.
- `libs/memory-core/src/lease.ts`'s `EWriterBusy`/`E_BUSY` — a DIFFERENT mechanism (the D7 writer-lease
  system), unrelated to the storage-driver taxonomy. Confirmed by reading it (:32-37); not in scope, not
  touched.
- `libs/memory-core/src/backup.ts`, `quota.ts` — their own `E_IO` returns are direct business-rule
  refusals (backup integrity failure, quota exceeded), never routed through `wrapDbError`. Not affected
  by this change, not touched.

---

## 3. ADR 0012 — content requirements (author this; `0012` confirmed free as of this writing —
`docs/decisions/` currently ends at `0011-backlog-tool-write-destination.md`, re-confirm before creating)

File: `docs/decisions/0012-turso-multiprocess-write-and-driver-agnostic-error-taxonomy.md` (or a title of
your choosing that captures both halves — it must supersede an invariant AND a taxonomy in one document,
say so in the title). Follow the ADR-0009→ADR-0011 supersession convention **exactly as it exists today**,
verified by reading both files:
- The superseded ADR's **Status** line (only the status line — do not touch its body) becomes:
  `**Status:** SUPERSEDED BY [ADR-0012](./0012-….md) (<date>). Was: ACCEPTED (<original date>). <one
  sentence on what carries forward unchanged>.` — mirror ADR-0009's exact phrasing pattern
  (`docs/decisions/0009-backlog-source-of-truth.md`'s first bullet).
- The new ADR opens with `**Supersedes:** [ADR-0007](./0007-….md) (<one clause on what of it still holds
  vs what this reverses>)` — mirror ADR-0011's header block exactly
  (`docs/decisions/0011-backlog-tool-write-destination.md`'s top few lines).
- Update `docs/decisions/0007-memory-single-writer-architecture.md`'s status header (:3-8) — do not touch
  D1/D3/D4/D6/D7/D8, which are unaffected; only the invariant, D2, D5, D9 are superseded, so say so
  precisely (name the sections, don't blanket-supersede the whole document).

**Required content, ruled (do not leave any of these five open for the implementer):**

1. **The real invariant.** Replace *"at most one process may hold a write connection"* with the actual
   property this system delivers: multiple processes may hold concurrent write connections to the same
   Turso store; the adapter's own MVCC (`BEGIN CONCURRENT`/optimistic conflict + retry, `turso-adapter.ts`
   :722-778) and the connection-poisoning/recycle machinery (`SPEC-CONN-RECYCLE.md`, `errors.ts`
   :159-193) are what make that safe, not a queue. State explicitly what is still NOT guaranteed:
   ordering across processes is not FIFO (two racing writers may commit in either order — this was always
   true and is not new), and a store opened in `needsWriteSerialization:true` mode (SQLite fallback) is
   still single-writer by construction — the new invariant is Turso-specific, not universal across
   adapters. `mock-adapter.ts` also declares `false`/`false` (:183ff) but is a test double with no real
   concurrency — note it explicitly so a reader doesn't assume mock parity implies anything about
   production concurrency guarantees.
2. **Write-queue consequence.** Rule explicitly: `mode: 'bypass'` with `admission_control: 'inactive —
   adapter handles concurrency natively'` is **CORRECT and unchanged** — restate the reasoning from
   §2.3's ruling above (adapter-native concurrency, not queue admission, is the safety mechanism) and
   cite `write-queue-turso-concurrency.spec.ts:276-390`'s BL-394 block as the existing, owner-ruled
   record of this decision (2026-08-05, "fork D of PKT-65" — quote it). State plainly: **this bug was
   never about bypass being the wrong mode; it was bypass having no error-wrapping/retry parity with the
   FIFO path.** That parity is what §2.3 adds.
3. **Driver-agnostic taxonomy — ruling on adapter vs memory-core, restated formally** from §2.2's
   reasoning: adapter package (`@adhd/sox-store-adapter`) owns driver-shaped *detection* (message-marker
   predicates, following `isFatalConnectionError`'s established precedent — cite it); memory-core
   (`wrapDbError`) owns the *stable taxonomy* every tool contracts on. Name explicitly that this
   **extends** the existing precedent (connection-recycling's `isFatalConnectionError`) rather than
   inventing a new convention — say why extending an already-proven pattern beats inventing a second one
   (consistency, one thing to learn, one thing to keep in sync with driver changes).
4. **Retry semantics.** State: the write-queue (`_runBypass`) retries a classified-retryable failure up
   to 3 total attempts with linear backoff seeded from `retry_after_ms` (250ms, 500ms); a
   still-retryable failure after 3 attempts is surfaced to the caller as a structured, retryable
   `StorageError` — the CALLER (the MCP client / calling agent) is responsible for any retry beyond that
   bound, and must be told so via `retryable:true` remaining in the final envelope. Silent loss — an
   exhausted retry disappearing without any error reaching the caller — is explicitly named as the thing
   this design must never do, and is exactly what today's bug produced.
5. **How this rot gets caught next time.** Name the two concrete gaps this investigation found and closed
   (cite them as the "assertion that would have failed the day the engine changed"):
   - `libs/memory-core/src/errors.spec.ts`'s entire taxonomy suite pinned `STORE_ADAPTER=sqlite`
     explicitly (with a comment acknowledging the live default is Turso) and had **zero** Turso-mode
     sibling — §2.2 added one; require in this ADR's acceptance section that any FUTURE `StorageError`
     code path gets a test against BOTH backends, not just SQLite, and that a suite testing
     `wrapDbError`/the classification helpers may not silently skip the live-default backend the way this
     one did.
   - `store-adapter/src/errors.spec.ts:20-26` was already RED-and-known, sitting uncorrected — require in
     this ADR that a RED test documenting a known gap is not "coverage"; it's a TODO with a test harness,
     and CI/review should treat a deliberately-red assertion as equivalent to an open CRITICAL backlog
     item (which, per BL-225 elsewhere in this repo's constraints, it structurally is).

---

## 4. Acceptance criteria — each names a BL/BUG id, each has a stated RED arm

**AC1 (BUG-MEMORY-001 §1).** A Turso-shaped `GenericFailure` lock/contention error reaching the MCP
boundary through `memory_write`'s live (bypass) path produces a structured `{code, message, retryable}`
JSON payload in the tool's `content[0].text` — never a bare `Tool error: Error: …` string, never
`"Tool error: [object Object]"`.
**RED arm:** on current HEAD (before 2.1/2.2/2.3/2.4), a test that drives `_runBypass` with an operation
that throws `{code:'GenericFailure', message:'database is locked'}` and asserts on the REJECTED VALUE
must show it is a raw object with no `.code`/`.retryable` fields (i.e. `wrapDbError` was never called) —
run this once pre-fix, record the failure, then again post-fix asserting `{code:'E_BUSY', retryable:true,
retry_after_ms:250}`.

**AC2 (BUG-MEMORY-001 §1, §2.3).** The write path retries internally on a classified-retryable
contention condition; a transient failure that would succeed on a second attempt does not lose the
episode.
**RED arm:** a deterministic fault-injection test — wrap/stub the adapter's write execution (mock
adapter or a thin wrapper around a real one) so the FIRST call to the operation throws the Turso-shaped
lock error and the SECOND call succeeds; assert `wq.enqueue(...)` resolves with the successful result
and the episode is persisted (query it back by uid). Pre-fix (current `_runBypass`, no retry): this
rejects on the first throw and the operation is never retried — assert that failure explicitly before
implementing §2.3, then re-run green after.

**AC3 (BUG-MEMORY-001 §"Suggested acceptance" #3) — STATUS: BLOCKED by BUG-001 (nodeId 2043), NOT
satisfied by this branch. See §8 (architect ruling, 2026-08-08) for why this is independent of defects
A/B/C and is tracked as a separate follow-on fix rather than folded into this dispatch.** A test drives
the real MCP `memory_write` seam
(through `handleToolCall`/`handleBackendRequest`, not by calling `write.ts` functions directly) under
sustained parallel load against a **populated** store with enrichment active, counting **persisted
uids**, over many iterations — not absence-of-thrown-errors.
**Two required sub-tests, per the item's own warning that a single passing repro proves little:**
- **3a — deterministic (primary evidence):** extend
  `libs/memory-core/src/write-queue-turso-concurrency.spec.ts` with a test that seeds a populated store
  (reuse or adapt the existing 20-write durable-commit test's setup, but seed several thousand rows first
  so enrichment/background work is genuinely active — check `memory-server`'s enrichment tick interval
  and either wait it out or trigger it directly, your call, but it must be REAL enrichment activity, not
  an empty idle store), inject a controlled fraction of synthetic Turso-lock throws (e.g. every 3rd
  concurrent call's underlying `executeRun` throws once), run N=8 parallel `memory_write` calls × 20+
  iterations, and assert `persisted_count === issued_count` every iteration, by SELECT-counting rows
  matching the batch's tag, not by counting resolved promises.
- **3b — best-effort real-timing soak (secondary, required by the item's literal text but not the
  primary red/green gate — timing-dependent, may not reproduce even pre-fix, exactly as the original
  investigator found with 20/20 clean repro attempts):** N=4-8 real parallel `memory_write` calls, no
  injected fault, against the populated store, 20+ iterations, same persisted-uid counting method. Report
  the outcome honestly either way — a clean pass here is not evidence of anything by itself (say so in
  the test's own comment, matching the item's own framing), it exists only because the item asked for it.

**AC4 (BUG-ERRORS-TS-CODE-HELPERS-NEVER-MATCH-TURSO-001, subsumed).**
**RED arm:** `store-adapter/src/errors.spec.ts:20-26`, AS IT EXISTS TODAY, already IS the red arm —
run it once before touching `errors.ts` and confirm it fails exactly as its own comment says. Post-fix
(§2.1), it must pass, with its comment updated to remove the "deliberately RED" framing. Add the sibling
assertions named in §2.1 for the other four helpers plus the literal incident text fixture.

**AC5 (ADR).** `docs/decisions/0012-….md` exists and contains all five numbered items from §3.
`docs/decisions/0007-….md`'s status header points at it. Verification is a document read, not a test —
but state in your completion report exactly which of ADR-0007's sections you marked superseded and
confirm you did NOT touch D1/D3/D4/D6/D7/D8.

---

## 5. Risks and sequencing

- **Do not run `nx build` on `store-adapter` or `memory-core` speculatively** to "see if it compiles" —
  BL-235. Read the diff, run `nx typecheck`/`nx lint` first (non-destructive), then `nx build` only once
  you believe it's correct.
- **`nx test memory-core` rebuilds `store-adapter`'s dist from whatever is on disk** (BL-456,
  `dependsOn: ["^build"]`) — since §2.1 and §2.2 land in the SAME change, this is fine (you want the
  fresh classifier compiled in), but report `node tools/check-suite-tree-state.mjs --project
  memory-core` alongside every suite result so it's clear what tree state produced it. Confirmed clean at
  spec-writing time (both `store-adapter` and `memory-core` dependency sets, 2/9 projects respectively,
  zero uncommitted changes) — if it's dirty when you start, say so and attribute accordingly.
- **`.changeset/` addition (§2.1) is required before this merges** — `@adhd/sox-store-adapter@0.3.0` is
  published; an unreleased behavior change without a changeset is exactly the gap BL-460's changeset
  backfill work (visible as a sibling worktree) exists to prevent recurring.
- **Never open `~/.memory/memory.db` or `~/.memory/concurrency-probe-20260808.db` for writing.** Every
  test in this packet uses `fs.mkdtempSync` scratch stores (the existing pattern in every spec file cited
  above) — do not point any test at a real path under `~/.memory/`. The probe DB stays; do not delete it
  (BL-412 — `openedPaths` registration).
- **The `_runBypass` retry loop must not introduce unbounded latency.** 3 attempts, 250ms/500ms backoff,
  worst case ~750ms added to a single write — bounded and small relative to MCP client timeouts. Do not
  make `MAX_ATTEMPTS` configurable/unbounded in this pass; if you believe it should be, stop and report
  rather than deciding it yourself.
- **Data-loss risk if you get §2.3's "retry from scratch is safe" reasoning wrong.** If, while
  implementing, you find ANY write-path operation that is NOT safely replayable from scratch (a mutation
  that isn't content-hash-deduped or `WHERE NOT EXISTS`-guarded), STOP — do not add retry around it, and
  report the specific operation. This is the one place in this spec where I'm asking you to re-verify a
  claim I made (§2.3's proof) against the actual code before relying on it for every call site, not just
  the ones I walked through.

---

## 6. The gate — exact nx targets, in order

1. `npx nx lint store-adapter` and `npx nx lint memory-core` and `npx nx lint mcp-runtime`
2. `npx nx typecheck store-adapter` and `npx nx typecheck memory-core` and `npx nx typecheck mcp-runtime`
   (and `memory-server` if `backend.ts` changed — it bundles via esbuild, typecheck is not implied by
   build there, per this repo's own house rule)
3. `npx nx build store-adapter` (only once source is believed correct — BL-235)
4. `npx nx build memory-core`
5. `npx nx build mcp-runtime`
6. `npx nx test store-adapter` — report `node tools/check-suite-tree-state.mjs --project store-adapter`
   alongside the result
7. `npx nx test memory-core` — report `node tools/check-suite-tree-state.mjs --project memory-core`
   alongside the result
8. `npx nx test mcp-runtime` (if a test project exists — check `project.json`; if not, note that and
   skip)
9. If `extensions/…/memory-server/src/backend.ts` changed: `npx nx build memory-server` (esbuild bundle,
   BL-4 stale-dist — data packages must already be freshly built per steps 3-5 before this), then
   `npx nx run registry:sync-index`, then confirm `node scripts/smoke-test.mjs --extension memory-server`
   passes.
10. Whole-repo cross-check before handoff to reviewer: `npx nx affected -t lint,typecheck` (not
    `run-many` — scope to what this branch actually touched, per the parallel-dispatch house rule).

Do **not** pass `--skip-nx-cache` anywhere in this sequence.

---

## 7. Handoff notes for the implementer

- Re-open and re-read every cited file yourself before editing — line numbers in this document were
  correct when I wrote it but WILL drift the moment you start editing the same files.
- The three-defect structure in §1 (A/B/C) is the organizing principle for your diff — if your final
  change doesn't touch all three files/layers (`write-queue.ts`, `errors.ts` ×2 packages, `serve.ts`
  + `backend.ts`), you have not closed the bug, regardless of what the tests say.
- If you hit a decision this document doesn't cover, that is this document's failure, not license to
  freelance — stop and report back through the standing escalation path rather than guessing.

---

## 8. ARCHITECT RULING (post-implementation, 2026-08-08) — answers to the implementer's two open questions

Read personally before ruling: `libs/memory-core/src/write-queue.ts:724-838` (the full `enqueue`/
`_runBypass` diff as implemented — confirmed a plain `for (;;)` retry loop, no recursion, bounded at
`BYPASS_MAX_ATTEMPTS=3`), `SPEC-BUG-MEMORY-001.md §1-§7` (this file, re-verified against implemented
`git log --oneline` for this branch: `021852ef`, `1e8388b4`, `83c818c1`, `ec69776b`, `62c72a99`),
`extensions/bundles/sox-memory-bundle/members/memory-server/src/bug-memory-001-write-loss-ac3.spec.ts`
(full file), the `BUG-001` backlog item (`nodeId 2043`, filed correctly with citations), and
`libs/memory-core/src/cluster.ts:504-570` (`incrementalJoin`'s `IN (${…map(()=>'?').join(',')})`
construction), `libs/data/store/store-adapter/src/turso-adapter.ts:615-640` (`this.db.all(sql,
...args)` — the args array is spread into the native Turso binding call, not passed as a bound array).

### Q1 — is this dispatch complete with AC3 blocked, or must BUG-001 be chased inside this branch?

**Ruling: this dispatch (defects A/B/C, AC1/AC2/AC4) is complete and mergeable as-is. AC3 is
correctly marked BLOCKED, not silently downgraded, and BUG-001 is NOT to be freelanced inside this
branch — it gets its own spec and its own dispatch.** Reasoning, in order:

1. **BUG-001 is independent of this spec's three defects — the evidence already rules out
   write-queue.ts as the cause, no bisection needed.** AC3b (the no-injected-fault sub-test) reproduces
   the stack overflow on a SINGLE `handleToolCall('memory_write', …)` call with zero retries taken.
   `_runBypass`'s retry loop (§2.3, this file) only executes its second iteration when
   `wrapDbError(err).retryable === true` — a call that never throws in the first place never enters the
   loop's `catch` branch at all, so a defect that manifests on attempt 1 with no fault injected cannot be
   caused by code that only runs on attempt 2+. The house rule ("never claim a bug is pre-existing without
   verification") is satisfied here not by asserting it, but by this direct logical exclusion: the
   changed code path (the retry loop) is provably not on the execution path that fails. I did not need to
   check out pre-fix `write-queue.ts` and re-run the (2-3 minute) populated-store seed to prove this —
   the loop's own gating condition proves it structurally.
2. **The likely actual site is named, and it is one this spec's own §2.5 explicitly put out of
   bounds.** `libs/memory-core/src/cluster.ts`'s `incrementalJoin` (:504-570, called from the batch-enrich
   path `runPeriodicEnrichPass` exercises) and its siblings in `autolink.ts`/`near-duplicates.ts` build
   `IN (?,?,?,…)` clauses sized to O(corpus candidates) and pass the parameter array through
   `libs/data/store/store-adapter/src/turso-adapter.ts:626`/`659` (`this.db.all(sql, ...args)`) — a
   **spread** of that array into the native `@tursodatabase/database` binding call, not a single bound
   array parameter. `autolink.ts:103-111`'s own `DEBT-MEMORY-ENRICH-001` comment already documents that
   this exact family of query (pairwise/candidate passes sized to corpus count) needed chunking once
   before, for a different reason (lock-hold duration) — this is the same shape of problem
   (an operation whose parameter count scales with corpus size, unguarded) recurring in a sibling
   file, now large enough (3000 candidates) to hit a native-binding argument-spread limit instead of a
   lock-duration limit. This is squarely inside `cluster.ts`/`near-duplicates.ts`/`turso-adapter.ts`'s
   query-construction layer — §2.5 of this spec names `write.ts`'s retry-safety as the only thing
   verified in the write path proper, and explicitly excludes touching the batch-enrichment/clustering
   layer at all. A fix belongs there, not in the three files this spec's diff touches.
3. **This is a materially different class of defect than A/B/C.** A/B/C are error-*handling* defects
   (a real, transient condition reaches the caller malformed or unretried). BUG-001 is a **correctness**
   defect in query construction (an unbounded parameter list overflowing a native binding) — it happens
   to surface *through* `wrapDbError`'s pre-existing, unmodified generic-fallback tier only because that
   tier's job (catch anything not driver-shaped and hand back `E_IO`) is exactly the same before and
   after this branch; nothing this branch changed made a `RangeError` route through `wrapDbError` for the
   first time. Bundling its fix into this branch would violate "Isolate Changes: keep fixes surgical and
   minimal" (a second, independently-reviewable defect in a different subsystem does not belong in a diff
   already spanning three packages) and would delay merging three already-verified, already-RED→GREEN
   fixes behind an open-ended new investigation.
4. **Do not close AC3 as satisfied, and do not silently drop it from the spec's own bar.** AC3 stays
   **BLOCKED**, explicitly, in this document (see the updated §4 marker below) — not deferred by
   omission. `SPEC-BUG-001.md` is the correct vehicle for the fix; it does not exist yet — filing
   `BUG-001` in the backlog graph (already done, `nodeId 2043`, well-cited) is necessary but not
   sufficient close-out for a HIGH-priority write-path defect of this shape. I am opening that as a
   follow-on architect dispatch immediately after this ruling, seeded with the lead in point 2 above so
   the next implementer does not re-derive it from zero. **BUG-MEMORY-001 the incident is not fully
   closed until BUG-001 is fixed and AC3a/AC3b both go green** — this branch merging closes defects
   A/B/C only.
5. **AC3's status, corrected:** §4's AC3 entry above is amended in place — read as `**AC3 — BLOCKED by
   BUG-001 (nodeId 2043), tracked in a follow-on spec, not satisfied by this branch.**` The test file
   (`bug-memory-001-write-loss-ac3.spec.ts`) stays committed, undoctored, and RED — per BL-225, a
   failing test naming the real defect is the honest state, not a defect to hide.

**What the implementer should NOT do:** do not now pivot to fixing `cluster.ts`/`turso-adapter.ts`
inside this same branch/commit sequence without a new spec — that is exactly the "hit a decision this
document doesn't cover, stop and report" case §7 already told you to route back, and you did so
correctly by filing BUG-001 and asking rather than guessing at a fix for an unscoped defect. Proceed to
merge this branch's five commits as the closure of BUG-MEMORY-001 defects A/B/C.

### Q2 — registry:sync-index / smoke-test from a worktree (BL-480)

**Ruling: this happens at merge time in the main checkout — there is no worktree-scoped variant, and
none should be built.** `scripts/build-index.ts` resolving to the shared git-common-dir root is correct,
existing, by-design behavior (BL-480) — a worktree's `registry/index.json` write would attribute a
checksum to a branch that isn't merged yet, which is wrong regardless of which worktree triggers it. The
implementer's handling — ran it once, observed the main-checkout write, reverted with `git -C
<main-checkout> restore registry/index.json` rather than committing an artifact for an unmerged branch
from inside a worktree — was the correct call and is now the documented procedure, not an improvised
workaround. §6 step 9 of this spec is corrected: **run `npx nx build memory-server`, `npx nx run
registry:sync-index`, and `node scripts/smoke-test.mjs --extension memory-server` in the main checkout,
after this branch merges to `main` (or is checked out there for verification) — never from inside
`.worktrees/bug-memory-001-write-loss`.** This is now a pre-close checklist item for whoever performs
the merge, alongside the standard smoke-test/registry-sync house rule at the top of this repo's
`CLAUDE.md`.
