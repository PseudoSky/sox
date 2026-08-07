---
"@adhd/sox-service-proxy": minor
---

Additive: client-context propagation, socket activation, and handshake helper (BL-62, SA-3, SA-4).

New `ClientContext` interface (`{ project_path: string }`, BL-62) re-exported from `index.d.ts`.
`ServeBackendOptions` gains optional `inheritFd?: number` (SA-3, socket activation). New `` handshakeBackend(socketPath,
timeoutMs?): Promise<boolean> `` export (SA-4). `FrontShimOptions` gains optional `httpPort?: number`
and `clientProjectPath?: string`. No removed or narrowed export.

**Behavior note, does not change the bump:** `serveBackend`'s stale-socket handling changed from
"always unlink a stale socket file before bind" to "probe-connect first; refuse with a structured
`E_LIVE_SOCKET` error if the socket answers" (SA-4 hardening) — a real new failure mode for any
caller not already going through `ensureBackend()`, which the docstring now says is the required
entry point. This is invisible to a `.d.ts` diff (still `Promise<BackendHandle>`, just may now reject
with a new error shape at runtime) and is out of this gate's detection scope. Flagged here so callers
bypassing `ensureBackend()` know to check for the new `E_LIVE_SOCKET` rejection path.
