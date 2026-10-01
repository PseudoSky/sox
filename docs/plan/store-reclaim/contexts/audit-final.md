# audit-final — prove every `[dod.N]` (must run before DONE)

**Kind:** audit (terminal hold point) · **Runs after:** all segments. **Read-only.**

Each check executes the DoD clause's declared interaction and asserts its observable — a clause proven only
by a grep/`test -e` is a forged proof and fails this audit.

| Check | dod | Kind | What it runs / asserts |
|---|---|---|---|
| `dod.1` | engine | test | `npx nx test store-adapter` (engine spec) + lock/the police unit tests green |
| `dod.2` | reclaim works | live-data | build a leaked fixture (or the live gauged store), reclaim, assert `after.file_bytes < before.file_bytes` and alarm clears |
| `dod.3` | no write lost | test | write-between-build-and-swap ⇒ `refused/source_changed`, write survives (`e92196e2` named) |
| `dod.4` | no watchdog kill | live | a build exceeding the kill budget emits no `mainthread.watchdog_kill`/`driver_stall` (`5b29f533` named) |
| `dod.5` | no orphan companion | test | rotation+expiry ⇒ zero orphaned companions (`1dd4c870` named) |
| `dod.6` | never-expire survives | test | newest verified + live `protectedRefs` survive `retentionCount=1`/`maxAge=0`/`maxBytes=0` |
| `dod.7` | refuses, never forces | test | live peer ⇒ `refused/not_quiescent` with pids, store byte-identical |
| `dod.8` | live gauge | tier-3 | `memory_ping` on the **live** service shows `alarm:false`, ratio below threshold, `backup_retention.orphaned_companion_count === 0` |
| `dod.9` | artifact verified | tier-3 | running service build hash == `shasum -a 256 …/memory-server/dist/index.js` (`[inv:deploy-verified]`) |
| `dod.10` | registry clean | structural | `git diff --exit-code registry/index.json` clean; no `registry:sync-index` in history |

**Negative checks (the old system must be gone):**
- `pruneRotatedBackups` no longer exists as an export (grep `src/` must be empty for the old symbol).
- No `autoBackup` call added to any shutdown path (`bl-ff7d9e24` still green).

## Exit

Prints `[dod.N] PASS/FAIL`. Advances to DONE only when **every** clause shows an executed PASS. A clause
whose check never executed its entrypoint is a FAIL.
