---
'@adhd/sox-telemetry': patch
---

fix(sox-telemetry): keep the runtime state and the one-shot unlabeled-warning latch in a
`globalThis` slot, so two module instances in one realm share a single process-wide state
(BL-404 / ADR-0018).

`runtime.ts` held its snapshot counters (`_snapshotsWritten`, `_snapshotInFlight`) and the
`_warnedUnlabeled` latch in module scope. Under a duplicate module load — a bundled extension
inlining `@adhd/sox-telemetry` while the host also resolves it — every copy got its own counters
and its own latch, so `initTelemetry()` state and the once-per-realm warning were per-copy instead
of per-process. The state now lives on
`globalThis[Symbol.for('@adhd/sox-telemetry.runtime.v1')]`: a second copy reads the first
instance's initialised state and does not re-emit the warning. A slot-keyed runtime object memoizes
per process, not per call, so the increment accumulates exactly as the module-level `let` did.

Covered by `bl404-duplicate-module-singleton.spec.ts`, which loads a second module instance via
`vi.resetModules()` plus a fresh dynamic import and asserts the shared state and the one-shot latch.
Its negative control — replacing `Symbol.for` with an unregistered `Symbol` — turns both assertions
red, so the test has teeth. ADR-0018 records the decision.
