---
"@adhd/sox-host-runtime": minor
---

Additive: crash-loop guard, env-policy scrubbing, OS-unit control surface, and reconcile helpers.

Four wholly new modules, each re-exported from `index.d.ts`:

- `crash-loop.d.ts` — `CrashLoopGuard`, `CRASH_LOOP_MAX_FAILURES`, `CRASH_LOOP_WINDOW_MS`, marker
  read/write helpers.
- `env-policy.d.ts` — `scrubEnv`, `scrubEnvReported`, `isDeniedEnvKey`, `formatDeniedEnvWarning`,
  `ENV_BASE_ALLOW`, `ENV_ALLOW_PREFIXES`, `ENV_DENY_PREFIXES`, type `ScrubbedEnv`.
- `os-unit.d.ts` — `detectOsSupervisor`, `deriveOsUnitSpec`, `enableOsUnit`, `disableOsUnit`,
  `restartOsUnit`, `unloadThenReap`, `restartAndVerify`, plus ~10 associated types.
- `reconcile.d.ts` — `classifyReconcileTargets`, `sweepProxyBackendLocks`, `quickReconcile`, plus
  associated types.

Additive extensions to existing modules: `reaper.d.ts` gains `readProcessEnv`,
`findOrphansByServiceId`, `gatherProcessSnapshot` and types `ProcessRowSource`,
`ProcessSnapshotRow`. `log-manager.d.ts` gains `findAllLogStreamsForExt`, `findMostRecentLogFile`
and type `LogStreamDescriptor`. `supervisor.d.ts`'s `SupervisorOptions` gains an optional
`crashLoop?: {...}` block and `ProcessSupervisor` gains a public `isCrashLooped(): boolean` method —
both additive, nothing removed or narrowed. `index.d.ts`'s re-export list only ever grows (every
diffed line appends a new named export or widens an existing `export {...}` clause). Remaining hunks
are `sox`→`soxe` comment rebrand or a doc example string change (`"memory-daemon"` →
`"tokenguard"` in a `@param` example — text only). No removed or narrowed export anywhere in this
package's diff — minor.
