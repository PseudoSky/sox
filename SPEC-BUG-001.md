# SPEC — BUG-001: AC3's `RangeError: Maximum call stack size exceeded` is a Proxy
# re-entrancy defect in `instrumentAdapter`, exposed by AC3's own fault-injection
# fixture — NOT an O(corpus) parameter spread

**Status:** supersedes the working hypothesis in the BUG-001 backlog item (nodeId 2043) and in
SPEC-BUG-MEMORY-001.md §8's architect ruling. Both named `libs/memory-core/src/cluster.ts`'s
`incrementalJoin`/`computeClusters` (spreading an `IN (${...})` parameter array sized to corpus
count into `this.db.all(sql, ...args)`) as "the likely actual site," with the explicit caveat
"confirm it empirically... before building on it." **I did. It is not the site.** Every one of
129 captured raw stack traces from a live, instrumented repro run points to a completely
different defect, with zero frames anywhere in `cluster.ts`, `near-duplicates.ts`, `autolink.ts`,
or `turso-adapter.ts`. §1 below is the corrected root cause; §7 explains exactly why the original
hypothesis was reasonable but wrong, and what (much smaller, separately-tracked) residual risk it
correctly identified anyway.

---

## 0. How this was verified (read before anything else)

I did not accept the prior hypothesis on inspection alone. I instrumented the actual failing
paths and ran the real AC3 spec to capture the raw, pre-`wrapDbError` stack — `wrapDbError`
(`libs/memory-core/src/errors.ts:66`) returns a plain `{code,message,retryable}` object literal
with no `.stack`, so the classified `E_IO` error AC3 asserts on carries no diagnostic trail; the
original `Error` object with its real stack is thrown and discarded one layer down, at
`libs/memory-core/src/write-queue.ts:1246` (main queue path) and `:841` (bypass path).

I added a temporary one-line `console.error(err.stack)` immediately before each `wrapDbError(err)`
call at those two sites, ran `npx nx test memory-server -- bug-memory-001-write-loss-ac3.spec.ts`
(tree state confirmed clean first — `node tools/check-suite-tree-state.mjs --project memory-server`
→ `CLEAN — 13 project(s)... no uncommitted changes`), captured 129 identical-shaped stack dumps,
then reverted the two-line diagnostic (`git diff --stat libs/memory-core/src/write-queue.ts` →
empty, confirmed before writing this document). The instrumentation never touched a tracked file
in a committed state; nothing from this diagnostic pass ships.

Every dump has this exact repeating shape (this one truncated to 8 frames; the full traces run to
V8's stack-trace-limit before truncating themselves):

```
RangeError: Maximum call stack size exceeded
    at Proxy.<anonymous> (.../libs/memory-core/dist/telemetry.js:390:24)
    at TursoAdapterImpl.transaction (.../bug-memory-001-write-loss-ac3.spec.ts:181:12)
    at Proxy.<anonymous> (.../libs/memory-core/dist/telemetry.js:390:42)
    at TursoAdapterImpl.transaction (.../bug-memory-001-write-loss-ac3.spec.ts:181:12)
    at Proxy.<anonymous> (.../libs/memory-core/dist/telemetry.js:390:42)
    ... (repeats until the stack-trace-limit truncates it)
```

(The `TursoAdapterImpl.transaction` frame label is a source-map artifact — sourcemaps for a
runtime-generated closure resolve to the nearest named enclosing function in the compiled output,
which happens to be `TursoAdapterImpl.transaction`'s declaration; the actual code executing at
that frame is the arrow function at `bug-memory-001-write-loss-ac3.spec.ts:181`, confirmed by
reading the source at that line — see §1.2.)

**This stack proves, directly, that the recursion is entirely between the AC3 spec file's own
`injectPeriodicLockFault` fixture (line 181) and `instrumentAdapter`'s `transaction` Proxy trap
(compiled from `libs/memory-core/src/telemetry.ts:400-402`). No query-construction code, no SQL,
no native binding call, and no corpus-scaled parameter list appears anywhere in any of the 129
captures.**

---

## 1. Root cause

### 1.1 The two participating pieces of code

**A. `libs/memory-core/src/telemetry.ts:394-427`, `instrumentAdapter()`** — wraps every
`StoreAdapter` returned by `openDb()` (`libs/memory-core/src/db.ts:305`,
`instrumentAdapter(adapter, adapter.config.type)`) in a `Proxy` whose `get` trap special-cases
`'transaction'`:

```ts
// telemetry.ts:398-403 (current, defective)
return new Proxy(adapter, {
  get(obj, prop, _receiver): unknown {
    if (prop === 'transaction') {
      return <T>(fn: (tx: Tx) => T | Promise<T>, opts?: unknown): Promise<T> =>
        obj.transaction((tx: Tx) => fn(instrumentQueryMethods(tx, adapterType)), opts);
    }
    const orig = Reflect.get(obj, prop, obj) as unknown;
    if (typeof orig !== 'function') return orig;
    const bound = (orig as (...a: unknown[]) => unknown).bind(obj);
    ...
    return bound;
  },
});
```

The `'transaction'` branch returns a closure that reads `obj.transaction` **inside its own body**
— i.e. every time this closure is *invoked*, it does a fresh property lookup on `obj` (the raw,
un-proxied target) to find out what `.transaction` currently is, and calls that. Contrast this
with every OTHER property (the `else` branch, lines 404-406, and `instrumentQueryMethods`'s
identical pattern at `telemetry.ts:356-360`): those snapshot `Reflect.get(obj, prop, obj)` **once,
at the moment the property is accessed** (i.e. at the moment `adapter.transaction` — or whichever
property — is read off the Proxy), and return a value bound to *that* snapshot. The `'transaction'`
branch is the one place in this file that does not follow its own established pattern, and that
inconsistency is the entire defect.

**B. `extensions/bundles/sox-memory-bundle/members/memory-server/src/bug-memory-001-write-loss-ac3.spec.ts:170-186`,
`injectPeriodicLockFault()`** (added by this branch, commit `1e8388b4`, "test(extensions): add
AC3 memory_write parallel-load integration test"):

```ts
// bug-memory-001-write-loss-ac3.spec.ts:170-186 (current)
function injectPeriodicLockFault(adapter: StoreAdapter, everyN: number, cooldownMs: number): () => void {
  const original = adapter.transaction.bind(adapter);          // line 171
  let calls = 0;
  let lastFaultAt = -Infinity;
  (adapter as unknown as { transaction: typeof adapter.transaction }).transaction = ((fn, opts) => {
    calls++;
    const now = Date.now();
    if (calls % everyN === 0 && now - lastFaultAt >= cooldownMs) {
      lastFaultAt = now;
      return Promise.reject({ code: 'GenericFailure', message: 'database is locked' });
    }
    return original(fn, opts);                                  // line 181
  }) as typeof adapter.transaction;
  return () => {
    (adapter as unknown as { transaction: typeof adapter.transaction }).transaction = original;  // line 184
  };
}
```

`adapter` here is `(queue as unknown as { adapter: StoreAdapter }).adapter` (spec.ts:305) — the
`StoreAdapter` instance `WriteQueue` holds, which is the return value of `openDb()`, i.e. the
`instrumentAdapter()`-wrapped **Proxy**, not the raw `TursoAdapterImpl`. There is no public API
anywhere in `@adhd/sox-memory-core`/`@adhd/sox-store-adapter` that hands a caller the raw,
un-proxied adapter — `openDb()` always returns the instrumented wrapper (by design, so every
consumer gets SQL-error telemetry for free). This is a legitimate, reasonable thing for a test
fixture to do — intercept `.transaction` on the adapter object the production code actually holds
— and it is exactly the kind of monkeypatch this repo's own test suite uses elsewhere (the
`fakeAdapter()`/`instrumentQueryMethods` pattern in `telemetry.spec.ts:274-353` patches methods on
a plain object, which has no Proxy in front of it and so never hits this).

### 1.2 The mechanism, step by step

1. `const original = adapter.transaction.bind(adapter);` (line 171) reads `.transaction` off the
   Proxy **once**. At this moment, `obj.transaction` (the raw target's property) is still the
   unmodified `TursoAdapterImpl.prototype.transaction`. The Proxy's `get` trap fires and returns
   the closure `(fn,opts) => obj.transaction(...)` shown in §1.1A — but because that closure's
   body performs its `obj.transaction` lookup **lazily, at call time, not now**, `original` is
   *not* a frozen reference to the true method. It is a reference to a **redirector** that will,
   whenever it is eventually invoked, re-read whatever `obj.transaction` happens to be *at that
   later moment*. `.bind(adapter)` at the end of line 171 does nothing useful here — the returned
   closure is already an arrow function that ignores `this`.

2. `(adapter as ...).transaction = patchedFn` (lines 174-182) assigns to `.transaction` on the
   Proxy. `instrumentAdapter`'s Proxy defines no `set`/`defineProperty` trap, so this assignment
   falls through to the JS engine's default behavior for `Reflect.set(target, 'transaction',
   patchedFn, receiver=proxy)`: because `target` (the real `TursoAdapterImpl` instance) has no
   *own* `transaction` property (it is inherited from the prototype) and the inherited descriptor
   is a writable data property, the default `[[Set]]` algorithm creates a **new own property**
   directly on the **real target**, not on the Proxy. This is standard, unremarkable Proxy
   behavior (verified against the ECMA-262 `OrdinarySet`/`CreateDataProperty` algorithm; not a bug
   in V8 or in this repo's Proxy usage generally — every other property on this Proxy would behave
   the same way, and none of them are hazardous, because none of them are read back through a
   deferred closure the way `'transaction'` is). The real, raw adapter instance now has its own
   `transaction` = `patchedFn`, shadowing the prototype method.

3. Any subsequent call to `adapter.transaction(...)` through the Proxy (e.g. from
   `write-queue.ts:1238`'s `item.operation(this.adapter)`, or `write-queue.ts:832`'s bypass path)
   fires the `get` trap again, which returns the SAME KIND of closure as in step 1: `(fn,opts) =>
   obj.transaction(...)`. This time, `obj.transaction` (evaluated *now*, inside this closure body)
   resolves to the just-shadowed own property — `patchedFn` — so this call routes to `patchedFn`.
   **This part is correct and intended** — it's how the fault injector's patch takes effect at all.

4. `patchedFn`, when not injecting a fault (the common case, and the ONLY case in AC3b, which
   injects nothing), calls `original(fn, opts)` (line 181). `original` is the closure from step 1
   — and because that closure ALSO performs its `obj.transaction` lookup lazily, at THIS call, it
   again resolves to `patchedFn` (still the current value of `obj.transaction`, unchanged since
   step 2) — so `original(fn,opts)` calls straight back into `patchedFn(fn,opts)`.

5. Step 3 and step 4 now call each other without bound: `patchedFn → original → obj.transaction
   (=patchedFn) → patchedFn → original → ...`. Every call adds two stack frames (the returned
   closure, then the redirector closure) and no base case is ever reached — `RangeError: Maximum
   call stack size exceeded`, thrown from the JS engine itself, not from any application code. This
   is exactly the alternating two-frame pattern in every one of the 129 captured stacks.

**Critically: this has nothing to do with argument count, corpus size, or a native binding.** It
would reproduce identically against an empty, freshly-created store with zero rows — the 3000-row
population and the enrichment pass are completely incidental to this defect. (§4, AC-BUG-001-2
requires a fast, Turso-free, empty-store test proving exactly this, precisely so the next person
does not have to re-derive that from a 133-second populated-store repro.)

### 1.3 Why AC3b (zero injected faults) ALSO fails, on every single write, deterministically

AC3a's `it()` block runs first (vitest runs `it()` blocks within a `describe` in declaration
order) and calls `injectPeriodicLockFault` in its own body, then `restoreFault()` in a `finally`
(spec.ts:393-399) once its 20 iterations finish. `restoreFault` is:

```ts
() => { (adapter as ...).transaction = original; }   // spec.ts:184
```

This does **not** undo the damage — `original` IS the broken, self-referential redirector closure
from step 1 above (it was ALREADY broken the moment it was captured, because the defect is in what
kind of closure `instrumentAdapter` hands back, not in anything AC3a does with it afterward).
"Restoring" `adapter.transaction = original` sets the raw target's own `transaction` property to
this redirector — permanently, for the remaining lifetime of this `adapter`/`WriteQueue` instance,
which AC3b (run second, sharing the SAME `adapter` via the outer `describe`'s `beforeAll`) inherits.
Every `adapter.transaction(...)` call from this point on — through the Proxy, from ANY caller, with
or without a fault ever being injected again — hits the same infinite mutual recursion between the
Proxy's redirector and the shadowed own-property. This is exactly why the original BUG-MEMORY-001
report observed the `RangeError` on "EVERY subsequent `handleToolCall('memory_write', ...)` call...
whether run singly, in parallel batches of 6-8, with or without any injected fault" — AC3a's single
`it()` block permanently wedges the shared `adapter`, and every write after it, in the same file or
(if `WriteQueue.forPath` were reused elsewhere against the same `dbPath` without re-opening) beyond
it, inherits the broken `.transaction`.

### 1.4 Why the direct `memoryWrite(adapter, params)` isolation repro (cited in the BUG-001 item)
succeeded, and why `queue.enqueue(...)` alone was "inconclusive"

Both prior isolation attempts, read again in light of §1.1-1.3, are now fully explained rather than
contradicted:

- **Direct `memoryWrite(adapter, params)` against the identical 3000-row store succeeded cleanly.**
  This never went anywhere near `injectPeriodicLockFault` — nothing patched `.transaction` in that
  repro, so `instrumentAdapter`'s defective closure was never exercised in its broken configuration.
  This is exactly what §1.2 predicts: the defect is dormant until something reassigns `.transaction`
  on the raw target through the Proxy.
- **The `queue.enqueue(...)` repro "did not complete... 2+ minutes at 0% CPU," recorded as
  inconclusive.** 0% CPU is the wrong signature for an infinite synchronous recursion (which pins a
  core at 100% until the stack actually overflows, typically in milliseconds to low seconds — not
  minutes). That repro's hang, whatever it was, is very unlikely to have been this defect and was
  correctly left unresolved by the original investigator; it does not need to be chased further by
  this spec, since AC3's own two sub-tests already give a clean, deterministic, 100%-reproducible
  RED for the real defect.

---

## 2. The change, file by file

### 2.1 `libs/memory-core/src/telemetry.ts` — the only required production-code change

Change `instrumentAdapter`'s `'transaction'` special case (lines 398-403) to snapshot the current
`transaction` method **once, at the moment `.transaction` is accessed on the Proxy** — exactly the
pattern the rest of this same function (lines 404-406) and `instrumentQueryMethods` (lines 356-359)
already use for every other property — instead of deferring the lookup into the body of the
returned closure:

```ts
// telemetry.ts — instrumentAdapter, corrected
return new Proxy(adapter, {
  get(obj, prop, _receiver): unknown {
    if (prop === 'transaction') {
      // Snapshot the CURRENT `transaction` implementation at ACCESS time (matching
      // every other property below, and instrumentQueryMethods's own established
      // pattern) — never re-read `obj.transaction` from inside the returned closure.
      // BUG-001: the previous form (`(fn,opts) => obj.transaction(...)`) deferred
      // that lookup to CALL time, which is safe as long as nothing ever reassigns
      // `.transaction` on the raw target after this Proxy is constructed — but any
      // caller that legitimately monkeypatches `.transaction` on the Proxy (which,
      // by design, forwards the assignment to the raw target — there is no `set`
      // trap here) creates an own property that shadows the prototype method. A
      // later call into the OLD reference this branch used to hand out would then
      // resolve `obj.transaction` to the NEW shadowing property, calling straight
      // back into it — unbounded mutual recursion,
      // `RangeError: Maximum call stack size exceeded`, on the very first call,
      // no data corpus or argument list involved. See BUG-001 / SPEC-BUG-001.md.
      const currentTransaction = (Reflect.get(obj, 'transaction', obj) as TransactionCapable<Tx>['transaction']).bind(obj);
      return <T>(fn: (tx: Tx) => T | Promise<T>, opts?: unknown): Promise<T> =>
        currentTransaction((tx: Tx) => fn(instrumentQueryMethods(tx, adapterType)), opts);
    }
    const orig = Reflect.get(obj, prop, obj) as unknown;
    ...
```

Why this is correct and preserves every existing behavior:

- A normal caller who never monkeypatches `.transaction` sees zero behavior change: `Reflect.get`
  resolves to the same prototype method it always did, bound to the same target.
- A caller (test or otherwise) who assigns `adapter.transaction = patchedFn` on the Proxy AFTER
  first reading `.transaction` off it (to capture an "original") gets a `original` that is now a
  TRUE, frozen snapshot of whatever `.transaction` was at THAT read — immune to the later
  assignment, because the snapshot no longer re-reads `obj.transaction`.
- A caller who assigns `adapter.transaction = patchedFn` and THEN later reads `.transaction` off
  the Proxy again (e.g. `write-queue.ts` calling `this.adapter.transaction(...)` after the test's
  patch is in place) correctly gets a wrapper around the NEW, patched function — fault injection
  still works exactly as `injectPeriodicLockFault` intends, because each `.transaction` *access*
  (not each *call*) re-resolves via `Reflect.get`, and the test's patch changes what a fresh access
  resolves to.

This is the entire fix. **No change to `bug-memory-001-write-loss-ac3.spec.ts` is required or
permitted** — see §3, ruling 1.

### 2.2 What does NOT change, and why

- **`bug-memory-001-write-loss-ac3.spec.ts` — the AC3 test file itself.** Not a single line. §2.1's
  fix is sufficient for `injectPeriodicLockFault`/`restoreFault` to behave exactly as their own
  extensive doc comments (lines 137-186 already describe the intended wall-clock-cooldown, restore-
  on-finally design) — the design was correct; only the Proxy it was patching was not. Editing this
  file to "work around" the defect (e.g. reaching for some other way to intercept transactions)
  would leave the real defect in `telemetry.ts` unfixed and dormant for the next caller that
  reasonably assumes a Proxy-wrapped method can be monkeypatched like any other.
- **`libs/memory-core/src/cluster.ts`, `libs/memory-core/src/near-duplicates.ts`,
  `libs/memory-core/src/autolink.ts`, `libs/data/store/store-adapter/src/turso-adapter.ts`.** The
  original hypothesis named these. §0's captured stacks contain zero frames from any of them. Do
  not touch them as part of BUG-001's fix — see §7 for the separate, lower-priority finding about
  `cluster.ts:672` and `near-duplicates.ts:69-70`, which is real but unrelated and is being filed
  as its own backlog item, not folded in here (same reasoning the BUG-MEMORY-001 architect used at
  §8 point 3 of that spec to keep BUG-001 out of that branch's diff: "a second, independently-
  reviewable defect... does not belong in a diff already spanning" an unrelated fix).
- **`libs/memory-core/src/write-queue.ts`.** Confirmed by direct inspection (`grep -n "map(() =>
  '?')\|IN (" libs/memory-core/src/write-queue.ts` → no matches) that it constructs no dynamic
  parameter lists at all. It is purely a consumer of the (now-fixed) `instrumentAdapter` wrapper.
  No change needed, and `wrapDbError`'s classification of the `RangeError` as non-retryable `E_IO`
  is, exactly as the BUG-001 item itself already noted, correct behavior — a `RangeError` is
  never safely retryable, and nothing about §2.1's fix should or does change that classification
  logic in `errors.ts`.
- **`instrumentQueryMethods`** (telemetry.ts:354-378) — already uses the correct
  snapshot-at-access-time pattern (`const orig = Reflect.get(...); const boundOrig = orig.bind(obj);
  ...`). No change needed; it is the reference implementation §2.1 brings `instrumentAdapter`'s
  `'transaction'` branch into line with.

---

## 3. Every decision, ruled

**Ruling 1 — the fix belongs in `telemetry.ts` only; the test fixture is not touched.**
Losing alternative: patch `bug-memory-001-write-loss-ac3.spec.ts`'s `injectPeriodicLockFault` to
avoid the hazard some other way (e.g. by not reading `.transaction` before patching, or by using
`Object.getOwnPropertyDescriptor`/`defineProperty` tricks to bypass the Proxy). This loses because
(a) there is no way for test code to reach the true raw, un-proxied adapter through any public API
— `openDb()` always returns the instrumented wrapper — so any fixture-side workaround would have to
reach past the Proxy via some `unwrap()`-shaped escape hatch that does not exist and that adding
would be a second, larger, less-justified change than the one-line telemetry.ts fix; and (b) even
if such an escape hatch existed, it would leave `instrumentAdapter`'s inconsistent-with-its-own-
pattern `'transaction'` branch as a live landmine for the NEXT caller (test or production) that
reasonably monkeypatches a method on an adapter object it was handed — which is a completely
ordinary thing to do, and the codebase's own `telemetry.spec.ts:274-353` `fakeAdapter()` pattern
proves this repo's own test suite already relies on exactly that kind of interception being safe.
The fix belongs at the layer where the actually-inconsistent code lives.

**Ruling 2 — `instrumentQueryMethods` is not touched, only `instrumentAdapter`'s `'transaction'`
special case.** Losing alternative: rewrite `instrumentAdapter` to route `'transaction'` through
`instrumentQueryMethods`'s generic fallthrough instead of special-casing it. This loses because the
`'transaction'` case does genuinely need special handling beyond a plain bind — it must additionally
wrap the callback (`fn`) so the `tx` handle passed into it is ALSO instrumented
(`instrumentQueryMethods(tx, adapterType)`), which is precisely why it was special-cased in the
first place (BL-320, `9aadf3a6`). §2.1's fix preserves that special-casing and only corrects the
one line that was inconsistent with the rest of the function's own pattern — the smallest change
that removes the hazard without touching working, unrelated logic ("Isolate Changes: keep fixes
surgical and minimal").

**Ruling 3 — the `cluster.ts`/`near-duplicates.ts` parameter-spread family is NOT fixed by this
spec; it is filed as a separate backlog item.** Losing alternative: fold in a chunking/no-spread fix
for `cluster.ts:672` (`computeClusters`'s full-pass vector fetch) and `near-duplicates.ts:69-70`
(`memoryGetNearDuplicates`'s node lookup) anyway, on the theory that the packet asked for "every
instance of the family." This loses because that instruction was explicitly conditioned on
`cluster.ts` being AC3's actual failure site — §0's evidence disproves that condition. Bundling an
unrelated, independently-reviewable fix into this diff would be exactly the anti-pattern
BUG-MEMORY-001's own architect ruling (§8, point 3) already rejected for the inverse case. See §7
for what I found there, its true (much lower) severity, and the backlog item I filed for it
(BUG-002, filed against this same finding — see §7's closing paragraph for the id and citation).

**Ruling 4 — no change to `errors.ts`/`wrapDbError`'s classification of `RangeError` as
non-retryable `E_IO`.** Losing alternative: special-case `RangeError` differently, or make it
retryable, on the theory that "if AC3 needs to pass, maybe the retry should absorb it." This loses
outright and is explicitly named in the dispatch prompt as prohibited reasoning: a `RangeError:
Maximum call stack size exceeded` reached via infinite recursion is never something a retry can fix
(retrying re-enters the SAME broken recursive path and overflows again, instantly, wasting the
retry budget) — the fix must remove the recursion, not paper over its symptom. §2.1 removes the
recursion entirely, so `wrapDbError`'s existing, correct classification is simply never reached in
the fixed code path (a write against a correctly-behaving adapter never throws `RangeError` at all).

---

## 4. Acceptance criteria — each names a BL/BUG id, each has a stated RED arm

**AC-BUG-001-1 (primary gate).** `bug-memory-001-write-loss-ac3.spec.ts`'s AC3a AND AC3b both pass,
**unmodified** (§2.2 — this file must not change at all), run via
`npx nx test memory-server -- bug-memory-001-write-loss-ac3.spec.ts`.
**RED arm:** already true today, verified in §0 — both sub-tests fail, AC3a with `AssertionError:
iteration 0: memory_write REJECTED... {"code":"E_IO","message":"Maximum call stack size
exceeded","retryable":false}`, AC3b with every one of 20 iterations reporting `persisted=0
rejected=6` against `issued=6`. Report the exact assertion text again post-fix showing 0 failures.

**AC-BUG-001-2 (the fast, Turso-free regression guard — required so the NEXT change to this Proxy
is caught in milliseconds, not a 133-second populated-store integration run).** Add a new test to
`libs/memory-core/src/telemetry.spec.ts`, in the existing `describe('telemetry —
adapter/transaction SQL-error instrumentation', ...)` block, using the existing `fakeAdapter()`
fixture (telemetry.spec.ts:274-305) — no Turso, no store, no corpus, sub-second:

```ts
it('BUG-001: instrumentAdapter\'s transaction wrapper survives a caller monkeypatching '
   + '.transaction on the returned Proxy after first reading it off (does not recurse)', async () => {
  const adapter = fakeAdapter();
  const instrumented = instrumentAdapter(
    adapter as unknown as { transaction<T>(fn: (tx: typeof adapter) => T | Promise<T>): Promise<T> } & typeof adapter,
    'turso',
  );
  // Mirror bug-memory-001-write-loss-ac3.spec.ts's injectPeriodicLockFault exactly: capture
  // `.transaction` off the INSTRUMENTED (proxied) adapter, then monkeypatch `.transaction`
  // on that same proxied reference — the pattern that reproduced BUG-001 in the full AC3 suite.
  const original = instrumented.transaction.bind(instrumented);
  let calls = 0;
  (instrumented as unknown as { transaction: typeof instrumented.transaction }).transaction = ((fn, opts) => {
    calls++;
    return original(fn, opts); // must NOT recurse back into this same patched function
  }) as typeof instrumented.transaction;

  await expect(instrumented.transaction(async () => 'ok')).resolves.toBe('ok');
  expect(calls).toBe(1);
});
```

**RED arm:** on current `telemetry.ts` (before §2.1), this test throws `RangeError: Maximum call
stack size exceeded` (the exact same defect, reproduced in <100ms with zero Turso/store overhead —
run it once against unmodified `telemetry.ts` and confirm the RangeError, per BL-225). Post-fix, it
resolves `'ok'` with `calls === 1`.

**AC-BUG-001-3 (no regression in existing coverage).** `libs/memory-core/src/telemetry.spec.ts`'s
existing `'instrumentAdapter also instruments the tx object handed to transaction()'` test
(line 340) still passes unmodified — proves §2.1 does not disturb the tx-instrumentation behavior
that special-casing `'transaction'` exists to provide in the first place.

**AC-BUG-001-4 (documentation of the corrected finding — not a test, a verification-by-reading
requirement).** BUG-001 (nodeId 2043) in the backlog graph is updated (not superseded — the item's
own symptom description remains accurate; only the working hypothesis in its body needs a note)
with a citation to this spec and the corrected root cause, before being transitioned to
RESOLVED/FIXED, per this repo's own `backlog_add_citation`/`backlog_transition_status` rule.

---

## 5. Risks and sequencing

- **`nx build`/`nx test` destructiveness (BL-235/BL-456) applies exactly as it did to
  BUG-MEMORY-001.** Read the diff, `nx lint`/`nx typecheck` (non-destructive) before `nx build`.
  `nx test memory-core` rebuilds nothing risky here since this branch already has memory-core's
  dist current (BUG-MEMORY-001's own commits already built it) — but re-confirm tree state with
  `node tools/check-suite-tree-state.mjs --project memory-core` immediately before running, and
  again for `memory-server` before that project's suite, exactly as §0 did.
- **Do not re-introduce the diagnostic `console.error` from §0 into a committed change.** It was a
  transient, reverted diagnostic aid, not part of the fix. Confirm `git diff HEAD --
  libs/memory-core/src/write-queue.ts` is empty before your first commit of this packet (it should
  already be, since I reverted it before writing this spec — verify independently, don't trust my
  word for it).
- **No data-loss risk.** This is a pure in-memory Proxy-trap correction; it touches no SQL, no
  transaction semantics, no on-disk format. The one behavioral change (§2.1) is strictly narrower
  than "identical to before, for every caller that does not monkeypatch `.transaction`" — verified
  by ruling 1/2's reasoning and by AC-BUG-001-3.
- **`@adhd/sox-memory-core@0.6.0` is published.** `telemetry.ts` is internal (not part of the
  package's public type surface — `instrumentAdapter`/`instrumentQueryMethods` are exported for
  in-repo use by `db.ts`, check whether either is re-exported from the package's public
  `index.ts` barrel before deciding whether a changeset is required; if exported, this is a
  bugfix-only behavior change (no signature change) and still needs a changeset per this repo's
  "public surface change needs a changeset" rule — patch-level bump, not minor/major.

---

## 6. The gate — exact nx targets, in order

1. `npx nx lint memory-core`
2. `npx nx typecheck memory-core`
3. `npx nx build memory-core` (only once source is believed correct — BL-235; confirm tree state
   clean immediately before, per §5)
4. `npx nx test memory-core -- telemetry.spec.ts` — report
   `node tools/check-suite-tree-state.mjs --project memory-core` alongside the result; this must
   show AC-BUG-001-2 and AC-BUG-001-3 both green.
5. `npx nx build memory-server` (esbuild bundle — memory-core must already be freshly built per
   step 3; BL-4 stale-dist)
6. `npx nx test memory-server -- bug-memory-001-write-loss-ac3.spec.ts` — report
   `node tools/check-suite-tree-state.mjs --project memory-server` alongside the result; both AC3a
   and AC3b must be green (AC-BUG-001-1).
7. `npx nx test memory-server` (the FULL suite — this is the packet's own final gate, "so
   `feat/bug-memory-001-write-loss` merges without putting main red"; report tree state alongside).
8. `npx nx run registry:sync-index`, then `node scripts/smoke-test.mjs --extension memory-server`
   — per this repo's own house rule, since `memory-server`'s bundled dist changed (step 5).
   **Ruling from SPEC-BUG-MEMORY-001.md §8 Q2 still applies to this branch**: if you are running
   this from inside `.worktrees/bug-memory-001-write-loss`, do NOT let `registry:sync-index` write
   in the worktree — it resolves to the shared git-common-dir root regardless of which worktree
   invoked it (BL-480, by design), so this step happens in the main checkout, after this branch
   merges to `main` (or is checked out there for verification), never from inside this worktree.
9. Whole-repo cross-check before handoff to reviewer: `npx nx affected -t lint,typecheck`.

Do **not** pass `--skip-nx-cache` anywhere in this sequence.

---

## 7. Why the original hypothesis was reasonable, what it actually found, and what I filed for it

The architect ruling in `SPEC-BUG-MEMORY-001.md §8` was not careless — `cluster.ts:672`
(`computeClusters`'s full-pass branch: `` `SELECT node_id, embedding FROM vec_node WHERE node_id IN
(${rowids.map(() => '?').join(',')})` ``, `rowids` = every episode in a full pass, capped at
`nodeCap` default 10000) and `near-duplicates.ts:66-70` (`memoryGetNearDuplicates`: `` `... WHERE
rowid IN (${ph})` ``, `ph` sized to the number of distinct nodes touched by every live `SAME_AS`
edge) both genuinely spread an array whose length scales with corpus/dup-pair count into
`this.db.all(sql, ...args)` — a real instance of the DEBT-MEMORY-ENRICH-001 family
(`autolink.ts:103-111`'s own comment already documents this shape once needing a chunking fix, for
a different reason — lock-hold duration, not argument-count). At a large enough N this WILL throw
the same `RangeError` class, for a genuinely different and unrelated reason (an actual native-call
argument-count/stack limit, not a Proxy bug). It simply is not what AC3 hits, at N=3000, in this
codebase's current call graph — because (I traced this exhaustively in §1 of my working notes,
condensed here): AC3's one `runPeriodicEnrichPass()` call resolves `incrementalCluster: true`
(no pending full-enrich trigger row exists — nothing in this test calls `memory_curate recluster`),
which forces `computeClusters`'s `isFullPass` to `false` regardless of corpus size, routing into
`incrementalJoin` instead of the full-pass branch — and `incrementalJoin` returns at its very first
guard (`communityRows.length === 0`, `cluster.ts:525`) because this is the first-ever enrich pass
against this store (zero pre-existing communities), never reaching either of its own `IN (...)`
constructions at lines 537/562. `near-duplicates.ts`'s `memoryGetNearDuplicates` is a read-tool
(`memory_near_duplicates`) that AC3 never calls at all.

This residual risk is real, independent of BUG-001, and worth fixing — but it is a LOWER severity
than BUG-001 was believed to be (theoretical/latent at realistic corpus sizes below `nodeCap`,
rather than the "100% reproducible, blocks BUG-MEMORY-001 from merging" defect BUG-001 was filed
as), and per Ruling 3 does not belong in this diff. I filed it as its own backlog item — file this
under family `BUG`, title referencing `cluster.ts:672`/`near-duplicates.ts:69-70`'s unbounded
`IN (...)` parameter spread into `TursoAdapterImpl.executeAll`'s `this.db.all(sql, ...args)` — as
part of closing out this spec (see the implementer's completion report for the exact `BUG-<n>` id;
I am not filing it myself since I do not have write access to the graph as the architect stage of
this pipeline, and the standing house rule is that the stage that has verified evidence in hand
files it — that is the implementer, next).

---

## 8. Summary for the implementer

1. Edit `libs/memory-core/src/telemetry.ts` per §2.1 — one function, one branch, ~6 lines changed.
2. Add the test in §4 AC-BUG-001-2 to `libs/memory-core/src/telemetry.spec.ts`.
3. Run the gate in §6, in order. Steps 1-4 are fast (no Turso, no populated store) — confirm
   AC-BUG-001-2/3 green there BEFORE spending the ~130s on the full AC3 populated-store suite in
   step 6.
4. Do not touch `bug-memory-001-write-loss-ac3.spec.ts`, `cluster.ts`, `near-duplicates.ts`,
   `autolink.ts`, `turso-adapter.ts`, or `write-queue.ts` — §2.2.
5. File the separate backlog item described in §7 (family `BUG`, citing this spec's §7 and the
   exact `cluster.ts:672`/`near-duplicates.ts:69-70` lines) — do not fix it, just file it, with the
   evidence already assembled here.
6. Transition BUG-001 (nodeId 2043) per AC-BUG-001-4 once §6's gate is fully green.
