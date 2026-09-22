# ADR-0018 — The telemetry runtime is a version-stable `globalThis` singleton, not per-module state

**Status:** ACCEPTED (2026-09-22).
**Owner:** pseudosky.
**Relates to:** BL-404 (the defect this records), BL-351 §5.0 (unconditionally-safe instrumentation),
BL-618 (`child-bootstrap.ts`, the cross-realm initialisation convention), ADR-0006 (live objects
cross via DI).

## Context

`@adhd/sox-telemetry` holds process-wide mutable state: the active `RuntimeState` (the `service`,
`role`, `logSink` and the open sink), the OTel bring-up promise, the stage aggregates that back
`telemetrySelfCheck()`, the child-telemetry counters, the metric-snapshot sink/timer, and the
one-shot `warnedUnlabeled` latch.

That state used to live in module-level `let`/`const` bindings. A module binding is **per module
instance**, and a single Node process can contain more than one instance of this package: a
top-level copy (whose `initTelemetry()` a composition root called) plus a nested copy under a
dependency's own `node_modules`, through which that dependency's emitted records routed. Two
instances meant two independent state bindings, so the nested copy's first emission saw its OWN
`service: 'unlabeled'` fallback, printed the BL-404 "emitting with no initTelemetry() call in this
process" warning, and no amount of initialising the top-level copy could silence it — the two
copies were, to each other, strangers. Observed live: `entrypoint/backlog`'s `role: 'cli'`
`initTelemetry` configured the top-level `0.3.0`, while the published `sox-embedding-provider`
declared `^0.2.1` and carried its own nested copy, whose parent-side `fastembed_process.request.*`
emission tripped `warnIfUnlabeled`.

Per-package version alignment had been the fix each time this recurred, and it does not hold: any
future dependency that pins a second range re-creates the split, and nothing in the type system or
the build catches it.

## Decision

1. **All mutable runtime state lives in ONE object keyed on `globalThis`.** A private
   `runtime(): TelemetryRuntime` accessor reads `globalThis[TELEMETRY_RUNTIME_SLOT_KEY]`, creating
   and installing the object on first use and returning the existing one thereafter. Every module
   binding that was mutable (`_state`, `_otelReady`, `_warnedUnlabeled`, the stage maps, the child
   counters/ring, the snapshot sink/timer/counters) becomes a field on that object. No module-level
   `let` remains.

2. **The key is a version-stable `Symbol.for(...)` string.** `Symbol.for()` returns the SAME symbol
   for the same string in every module instance of a realm (it is the global symbol registry), so N
   copies of this file resolve to one shared object. The string is
   `'@adhd/sox-telemetry.runtime.v1'`. It is a **semver-stable contract**: changing it silently
   splits the runtime again (two copies, two states, the warning returns). Bump the `.vN` suffix
   ONLY when the runtime object's SHAPE changes incompatibly, and never reuse an old suffix for a new
   shape.

3. **Separate realms are deliberately unaffected.** A forked child process or a
   `worker_threads.Worker` has its own `globalThis` (and its own symbol registry), so it gets its own
   runtime — correct, because it is a genuinely separate isolate. Those realms are initialised by
   `child-bootstrap.ts`'s `SOX_TELEMETRY_INIT` convention, unchanged.

4. **The public API is unchanged.** The singleton is entirely internal; every exported name, its
   signature, and the `TelemetryHandle` contract are preserved. `_resetTelemetryForTest()` resets the
   shared object's fields in place rather than replacing the slot, so a test that resets through one
   module instance resets the one runtime all instances see.

## Consequences

- The BL-404 duplicate-module warning can no longer fire from a duplicate-module hazard: the first
  copy to initialise is visible to every other copy in the realm, and the latch is shared.
- The fix is **structural, not version-pinned**: it holds for any number of coexisting copies,
  including versions this repo has not published yet, and does not depend on every consumer aligning
  its dependency range.
- A regression test (`libs/observability/sox-telemetry/src/bl404-duplicate-module-singleton.spec.ts`)
  loads a second module instance via `vi.resetModules()` + a fresh dynamic `import()`, asserts the
  second instance reads the first's `initTelemetry`, and asserts the second does NOT emit the BL-404
  warning. It goes red if the slot is re-created per module.
- **Test isolation note:** because the slot is process-global, state set by one test file can be
  visible to another in the same worker until reset. This is the intended process-global semantics;
  suites must call `_resetTelemetryForTest()` in teardown, as they already do.
- **Not covered by this ADR:** `trace.ts` still holds its `AsyncLocalStorage` instance as a
  module-level `const`. Under duplicate module copies that too is duplicated, so `withTrace()` in one
  copy is invisible to `currentTraceId()` in another. Moving it into the same slot is a separate,
  behaviour-affecting change and is tracked on its own.
