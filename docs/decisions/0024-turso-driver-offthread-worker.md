# ADR-0024 — Turso native calls run on one per-process driver thread behind the connection handle

**Status:** PROPOSED — not ratified (2026-09-30). The mechanism this ADR governs is **implemented**
in `libs/data/store/store-adapter` (the off-thread Turso driver, packets TUR-A…TUR-F), but this file
is a proposal: it records the decision and is not binding until the owner accepts it (the same
posture as ADR-0014 and ADR-0023, both PROPOSED ADRs that exist before approval).
**Owner:** pseudosky.
**Driving backlog items:** `862129b5` (off-thread Turso driver host), `5b58b189` (FTS maintenance off
the write path), `3e3ff0ec` (connection-health vs driver-stall deadline).
**Grounding:** `turso-driver-worker.ts:7-11` states this file owns the ONLY value-import of the
native driver; `turso-driver-worker.ts:100-113` is the lazy NON-LITERAL `import(DRIVER_SPECIFIER)`
where `DRIVER_SPECIFIER = '@tursodatabase/database'` (`turso-driver-worker.ts:64`);
`turso-driver-host.ts:204` is the `globalThis[Symbol.for('@adhd/sox-store-adapter/turso-driver-host')]`
slot key and `turso-driver-protocol.ts:51` is `TURSO_DRIVER_PROTOCOL_VERSION = 1`;
`turso-driver-host.ts:343-365` derives the `'stalled'` state from an age deadline against
`DEFAULT_DRIVER_STALL_AFTER_MS = 5_000` (`turso-driver-host.ts:122`);
`extensions/bundles/sox-memory-bundle/members/memory-server/src/driver-stall-watchdog.ts` owns the
kill policy; and `turso-adapter.ts:62-69` shows the adapters binding to the host's async proxy while
never importing the driver.
**Relates to:** ADR-0006 (public packages bundle private internals; live objects cross via DI — the
layering that puts the *kill* in the consumer, not the library), ADR-0012 (Turso multi-process
write invariant and driver-agnostic error taxonomy — **not amended**; §5's duck-type predicates
return the same verdicts over the proxy), ADR-0013 (feature switches are typed config, never env
vars — the stall **interval** is a typed option, not a toggle), ADR-0018 (the telemetry runtime is a
version-stable `globalThis` singleton — the same singleton-slot pattern applied to the driver host),
and ADR-0019 (heavy native-chain deps are `optionalDependencies` resolved by a lazy non-literal
dynamic import — D1's mechanism).

---

## Context

The native `@tursodatabase/database` driver executes synchronously on the thread that calls it. A
long write that crosses the SQLite busy timeout, or an FTS index-maintenance pass, therefore froze
the **main thread** of `memory-server` for the duration — starving the event loop, the HTTP/MCP
listener, and every watchdog that lives on it. Every prior mitigation bounded *which* calls were
made, never *where* they ran.

The competing hazards are structural: (a) several copies of `@adhd/sox-store-adapter` can coexist in
one process (the package is bundled into multiple extensions, and a dependency may nest its own
copy), so a naïve "one worker per module" would spawn a second driver thread and reopen the
multi-process write question ADR-0012 answers; (b) the memory-server is a single-writer process
(ADR-0012), so the off-thread call must not change the write invariant; and (c) the native driver
was declared `optionalDependencies` and reached only through a lazy non-literal dynamic import
(ADR-0019) precisely so the native chain never enters a main-thread module graph. Any design that
hoists it back onto the main thread defeats that guarantee silently.

This ADR records the shipped seam that resolves all three: the driver runs on **one thread per
process**, behind a connection-shaped async proxy, and the library reports liveness while the
consumer owns the kill.

## Decision

### D1 — A handle-level seam: the native driver exists in exactly one module

The native driver is value-imported in **one** file, `turso-driver-worker.ts` — the worker realm
(`turso-driver-worker.ts:7-11`). It is reached through a **lazy, NON-LITERAL** dynamic import
(`turso-driver-worker.ts:100-113`, `DRIVER_SPECIFIER` at `:64`) so a bundler cannot statically
analyse and hoist it back into an eager import (ADR-0019's exact defeat). Every other module —
`turso-adapter.ts` and the factory — sees only a `TursoDriverConnection` async proxy
(`turso-driver-host.ts:91-99`): `run`/`get`/`all`/`exec`/`pragma`/`close` plus a `connId`. The
adapters keep their existing `db.run(...)`-shaped call sites by binding that proxy at
`turso-adapter.ts:62-69`; no adapter imports the driver. A source-scan spec
(`__tests__/turso-driver-realm-guard.spec.ts`, per `turso-driver-worker.ts:29-31`) asserts the closed
import set and scans the **built** `dist/turso-driver-worker.js` for the forbidden symbols.

### D2 — One process-wide driver thread, addressed through a versioned `globalThis` slot

The host is a **singleton** held on `globalThis[Symbol.for('@adhd/sox-store-adapter/turso-driver-host')]`
(`turso-driver-host.ts:204`, rationale `:13-24`). A nested copy of the package under a dependency's
`node_modules` would otherwise be a per-copy singleton that spawns a **second** worker; keying on a
`Symbol.for` slot collapses N bundled copies in one process to one worker. The slot records the
`TURSO_DRIVER_PROTOCOL_VERSION` it was created under (`turso-driver-host.ts:206-213`,
`turso-driver-protocol.ts:51`); a copy that speaks a different version throws
`E_TURSO_DRIVER_PROTOCOL_MISMATCH` (`turso-driver-host.ts:159-170`) rather than spawning a competing
worker. The slot key itself is declared a **semver-stable contract**: the `.vN` suffix is bumped
only on an incompatible shape change (`turso-driver-host.ts:198-203`). Genuinely separate realms
(a forked child, or another `worker_threads.Worker`) have their own `globalThis` and symbol
registry, so each gets its own host — correct, because each is a separate isolate
(`turso-driver-host.ts:26-29`).

### D3 — Realm isolation: the worker's import set is closed

The worker imports only `node:worker_threads`, the protocol module
(`./turso-driver-protocol.js`), and the driver — the latter solely through D1's lazy non-literal
import (`turso-driver-worker.ts:18-24`). It imports **no telemetry** (a worker realm cannot use
`@adhd/sox-telemetry`; marshalling/teardown failures go to `process.stderr`, exactly like
`deep-verify-child.ts`), **no `store-lease`** (whose module-scope opener registry is main-thread
process state), **no `deep-verify`**, and **no other store-adapter module**
(`turso-driver-worker.ts:26-35`). The protocol module that both realms share is itself
dependency-free — it imports only `node:buffer` (`turso-driver-protocol.ts:40`) and carries no
`worker_threads`, no telemetry, and no driver (`turso-driver-protocol.ts:11-26`).

### D4 — No host-side cancellation; liveness is *reported*, never *enforced*

The host never times out a request. A request is dispatched fire-and-forget on a single FIFO port
(`turso-driver-worker.ts:37-44`), and the host explicitly owns no timeout/cancellation
(`turso-driver-host.ts:31-55`). Instead liveness is **reported synchronously and query-free**:
`getTursoDriverStatus(stallAfterMs = DEFAULT_DRIVER_STALL_AFTER_MS)`
(`turso-driver-host.ts:789-795`) derives `'stalled'` as a **deadline verdict** — the oldest in-flight
request has been pending at least the threshold (`turso-driver-host.ts:343-365`), default
`5_000 ms` (`turso-driver-host.ts:122`; ceiling `MAX_DRIVER_STALL_AFTER_MS = 600_000`, `:125`). It
reads only the `peekSlot()` (never spawns a worker, never touches one — `:789-795`), so it is safe
from a watchdog or a `memory_ping` handler on the main thread. The adapter exposes this as
`driverStatus` (`turso-adapter.ts:2070-2086`), and the host emits a `store_adapter.turso.driver_stalled`
telemetry event on the transition with a matching `..._recovered` (`turso-driver-host.ts:126-131`,
`:609-647`). The adapter's **existing** `connectionHealth` getter is **deliberately left unchanged**
(`turso-adapter.ts:2050-2068`, restated in the `driverStatus` comment at `:2070-2086`): it reports
*this adapter's own connection lifecycle*, a different question from the process-wide driver's
liveness.

### D5 — The kill policy belongs to the consumer, not the library

The library **reports**; the consumer **enforces** (ADR-0006 layering). `memory-server`'s
`driver-stall-watchdog.ts` polls `getTursoDriverStatus()` on an interval and, once the oldest
in-flight op exceeds its kill threshold, forces an exit for supervisor restart
(`driver-stall-watchdog.ts`, exit code `DRIVER_STALL_EXIT_CODE = 70` / reason `'driver_stall'`). The
exit routes through `hard-exit.ts`'s `forceExit`, which consults `getTursoDriverStatus()` for the
`SIGKILL`-vs-`process.exit` decision (`hard-exit.ts:47-48`). The worker's own contract states the
same boundary: "there is NO host-side cancellation: the host owns timeouts and the stall policy
(TUR-C/TUR-F), and SIGKILLs a close that parks in native code"
(`turso-driver-worker.ts:37-44`; teardown at `:243-263`). A watchdog interval and kill threshold are
**typed options**, never env toggles (ADR-0013).

### D6 — Per-connection workers are forbidden until upstream declares its core `Database` thread-safe

The decision is **one** driver thread per process, shared across every connection (the worker holds
`const connections = new Map<number, DriverDatabase>()`, `turso-driver-worker.ts:88`). Spawning a
worker per connection is rejected: the upstream driver has not declared its core `Database` (and
the native SQLite handle it wraps) safe to use across threads, so N workers would be N independent
native state machines competing for the same store file — reintroducing, inside one process, exactly
the concurrency the ADR-0012 invariant governs across processes. This stays forbidden until upstream
makes that declaration. *(Upstream's thread-safety statement is external to this repo and is **not
verified here**; the constraint is recorded as the design rule, not as a citation.)*

## Consequences

- **Main-thread blocking is bounded, not eliminated.** The benefit is that the event loop, the
  listener, and the main-thread watchdogs stay responsive while a native call runs. It is **not** a
  latency improvement: with one FIFO driver thread per process, driver operations **serialise** (see
  Non-guarantees).
- **One seam, one protocol.** Because every non-worker module consumes the same proxy and envelope
  (`turso-driver-protocol.ts`), the driver-agnostic error taxonomy of ADR-0012 §5 is preserved: a
  worker death surfaces as `E_TURSO_DRIVER_WORKER_EXITED`, which `errors.ts`'s
  `isFatalConnectionError` already treats as fatal (`errors.ts:311-319`), so call sites classify it
  identically to an in-thread failure.
- **Duplicate-copy safety.** D2 turns the "two bundled copies, two driver threads" hazard into a
  typed refusal (`E_TURSO_DRIVER_PROTOCOL_MISMATCH`) on version skew, and a shared worker
  otherwise.
- **Observability.** Liveness is now a first-class, synchronous, side-effect-free read
  (`getTursoDriverStatus()`), which is what makes an external watchdog possible without the library
  taking on a policy.

### Non-guarantees (explicit)

- **It bounds main-thread BLOCKING, not operation latency.** One FIFO driver thread per process
  serialises driver operations: a second request waits behind the first. This is a responsiveness
  fix, not a throughput one.
- **The 5 s busy timeout persists.** `DEFAULT_BUSY_TIMEOUT_MS = 5000` still applies to every driver
  connect (`turso-adapter.ts:122-128`). Until upstream ships the `0.8` `STEP_SLEEP` behaviour
  (blocked item `809153d1`), a write that loses the busy race still parks for up to that budget.
- **Reads still queue behind a store's writes.** Moving the driver off-thread does not reorder
  work: a read submitted while a write is in flight waits on the same FIFO thread
  (blocked item `56c72ccb`).

## What does NOT change

- **ADR-0012 is not amended.** The cross-process concurrent-write invariant is unchanged; D2
  collapses N **bundled copies in ONE process** to one worker — it does not license a second
  process, and the writer discipline per store is exactly as before.
- **ADR-0018 is not amended.** The host borrows the singleton-slot *pattern*, but the telemetry
  runtime's own slot contract is untouched.
- **ADR-0019 is not amended.** D1 is an *application* of the lazy non-literal import rule, in the
  one place the driver is legitimately value-imported.
- **ADR-0006 is not amended.** The public/private bundle boundary and the DI rule stand; D5 is the
  layering applied — the library reports, the consumer kills.
- **Raw direct `connect()` is untouched.** Code that opens the store through the driver directly
  (setup scripts, migration/verification tools, tests) is unaffected; this ADR governs the
  `@adhd/sox-store-adapter` seam only.

## Alternatives considered

1. **Keep the driver on the main thread and tune the timeouts.** Rejected: it does not stop the
   freeze — it only shortens it, and a correct fix cannot depend on a call never exceeding a budget.
2. **One worker per connection.** Rejected — D6: not safe until upstream declares the core
   `Database` thread-safe; it multiplies native handles against one store file.
3. **One worker per package copy (no `globalThis` slot).** Rejected — D2: a nested dependency copy
   would spawn a second driver thread; version skew would be silent rather than a typed refusal.
4. **Host-side request timeout / cancellation.** Rejected — D4: the host cannot safely cancel a call
   parked in native code, and a timeout that only abandons the caller reintroduces the ambiguity
   between "slow" and "dead". Reporting a deadline verdict and letting the consumer act is the
   honest split.
5. **Library-owned kill (the host SIGKILLs itself on stall).** Rejected — D5/ADR-0006: kill policy
   is process policy and belongs to the embedding service, which knows whether a restart is the
   right remedy.
6. **Surface driver liveness through the existing `connectionHealth` getter.** Rejected — D4:
   `connectionHealth` answers a different question (this adapter's connection lifecycle) and is
   deliberately left unchanged; overloading it would conflate two lifecycles and break the
   `connection-health-deadline` contract (`3e3ff0ec`).
