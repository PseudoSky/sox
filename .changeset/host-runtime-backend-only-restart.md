---
'@adhd/sox-host-runtime': minor
---

`service restart` now targets the backend the OS unit is actually running
(dc6261c1), and `restartAndVerify` can skip the kickstart.

- New exports `extractUnitArgv(unitText, kind)` and
  `isFrontShimArgv(argv, extId)` read the argv of the unit file on disk, so a
  caller can tell a front-shim unit from a direct-backend unit without
  re-deriving it from config.
- `restartAndVerify` options gain `kickstart?: boolean` (default `true`) and
  `mainPid?: number`. With `kickstart: false`, only the backend is restarted,
  and the reaper reaps the live backend scoped by pid. A rotation whose
  entrypoint path is stale is rejected.

**Minor, not patch:** `RestartAndVerifyResult.kickstart` is now optional. It is
absent, and `kickstartSkipped: true` is set, when `kickstart: false` skipped
it. Code that reads `result.kickstart` unconditionally has to handle the
absent case.
