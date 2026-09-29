---
'@adhd/sox-memory-core': patch
---

New `setDbOpHooks()` — a process-wide, typed hook registration (mirrors `setDeepVerifySchedule`)
that forwards `@adhd/sox-store-adapter`'s new per-call DB-op-tracing config
(`onOpStart`/`onOpEnd`/`slowOpThresholdMs`) into every `createStoreAdapter()` call this module
makes, via a new `dbOpHooksOpts()` helper spread into each config-object literal (same pattern as
the existing `deepVerifyStoreOpts()`).

This exists because `getDb`/`openDb` take only a bare `dbPath: string` — there was no way for a
consumer (memory-server) to reach the adapter-construction call site otherwise, since it lives
here (`db.ts`'s 5 call sites) and in `backup.ts`'s 2 call sites, not in the consuming extension.
Call `setDbOpHooks()` once, before the first `getDb`/`openDb`; existing cached adapters are
unaffected. Applies to every open — writable, readonly, and `backup.ts`'s — not just the writable
path `deepVerifyStoreOpts()` targets, since a stall inside a readonly recall query or a backup
`VACUUM INTO` is exactly the kind of event a consumer's main-thread-stall attribution wants
visibility into.
