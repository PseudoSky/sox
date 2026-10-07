---
"@adhd/sox-telemetry": minor
---

Share process-identity span attributes and add an idempotent, ref-counted `acquireTelemetry` (621a11c5).

**Identity helpers** (upstreamed from the adhd tracing plugins so every consumer stamps identical keys):
`identityAttributes()` returns `{ session_id, worktree, role }`; `processIdentity()` /
`resolveProcessIdentity(env, cwd, sessionId?)` resolve the process-stable identity (`session_id` from
`ADHD_SESSION_ID`, else a `randomUUID()` shared across duplicate installed copies); `classifyWorktree(cwd?)`
reports `'main' | 'linked' | 'none'`; `toOtelAttributes`, `requireTelemetryPrefix` (a required, default-less
product namespace) and `prefixAttributes` complete the surface. There is deliberately no `release.*` helper:
`service.version` / `sox.artifact_sha256` are already OTel resource attributes and the full release object is
already on every record envelope.

**`acquireTelemetry(opts)`** returns a `TelemetryLease` (a `TelemetryHandle` plus `owned`, `conflicts`, and an
idempotent `release(): Promise<void>`). The first acquirer owns the configuration; later acquirers join it, so two
consumers in one process register exactly one provider and emit no duplicated spans, and the provider closes only
when the last lease releases. Owner state lives on the shared `globalThis` runtime slot, so duplicate installed
copies share one owner.

**Fix:** `handle.close()` from `initTelemetry` is now generation-scoped. Previously a handle superseded by a later
`initTelemetry` call tore down the *live* configuration on close (the global tracer provider became a no-op and
third-party spans were lost). `initTelemetry`'s signature and last-wins semantics are unchanged.

Purely additive to the exported surface; no existing export changes shape.
