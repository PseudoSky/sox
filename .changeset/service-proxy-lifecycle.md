---
'@adhd/sox-service-proxy': minor
---

Lifecycle primitives for long-lived backends (8468f7b1). All additions are
backward compatible: one-argument handlers, existing options and the 0.5.0 lock
file keep working unchanged.

- Connection identity: `BackendHandler` receives a second argument
  `ctx: ConnectionContext` (`{ connectionId }`, opaque and unique per accepted
  connection), and `serveBackend` accepts `onClientConnect(connectionId)` and
  `onClientDisconnect(connectionId, reason)` where `reason` is a
  `ClientDisconnectReason` (`'end' | 'error' | 'closed-by-backend'`). The
  existing `onClientCountChange` sequence is unchanged. A throwing hook is
  isolated and reported through `onDiagnostic`.
- Pid-reuse-safe spawn lock: new `readProcessStartToken` and `isSameProcess`.
  The `ensureBackend` lock file gains an optional `startToken` (`ps -o lstart=`,
  read with `LC_ALL=C` and `TZ=UTC`), so a lock held by a recycled pid is
  reclaimed immediately. Locks without a token and any `ps` failure behave
  exactly as in 0.5.0.
- Work-driven idle retirer: new `createIdleRetirer` and `idleDueInMs`. The
  host calls `arm()` once, `touch()` or `work()` on real work, and the retirer
  runs its ordered `steps` after `idleWindowMs` of no work. Connection counts and
  presence never keep it alive (ADR-0022).
- Circuit breaker: new `createCircuitBreaker` with a pluggable `BreakerStore`,
  consecutive or windowed failure counting, and a single half-open probe after
  the cooldown.

`@adhd/stealth-browser` is now listed in `sox.externalConsumers`.
