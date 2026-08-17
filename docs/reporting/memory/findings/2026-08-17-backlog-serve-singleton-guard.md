# `backlog serve` singleton guard — 2026-08-17

**Agent:** `backlog-singleton-enforcement` (platform-engineer). **Repo touched:** the `adhd` monorepo
(`/Users/nix/dev/node/adhd/entrypoint/backlog`) — NOT sox-ecosystem. Filed here per the team-lead's
instruction, because `backlog` (the tool itself) was down for the duration of this work
(`backlog list-items` exits 134 — see the parallel recovery effort in
`2026-08-17-backlog-store-recovery.md`), so the backlog MCP tools could not be used to file this in
their normal home.

## Task

Make `backlog serve` a supervised singleton so the backlog store cannot have concurrent writers —
the structural fix for the corruption incident (see the recovery finding above for the corruption
itself; this finding is the fix for *why it was possible*, not the recovery of what already broke).

## What was implemented

**A store-scoped O_EXCL PID-file lock**, not a full sox-ecosystem OS-unit registration. Details, code,
and the full red→green verification are in the commit message
(`fix(backlog): enforce a single writer per store for \`backlog serve\` ([inv:singleton])`,
`adhd` repo, `entrypoint/backlog/`):

- `entrypoint/backlog/src/store/serve-lock.ts` (new) — `acquireServeLock(dbPath)`. Mirrors
  sox-ecosystem's `libs/host-runtime/src/lock.ts` `acquireStartLock` pattern (O_EXCL create,
  liveness-probed stale-lock reclaim, pid recorded in the lock file) — reimplemented rather than
  imported, because `backlog` is a standalone `@adhd/backlog` npm package built from a separate repo
  and `host-runtime` is sox-ecosystem's unpublished `area:platform` layer.
- `entrypoint/backlog/src/server.ts` (`startBacklogServer`) — acquires the lock BEFORE opening the
  store, releases it only AFTER the store is fully closed (wired into the existing `closeStoreOnce`),
  not merely on signal receipt.
- Fails loud: `ServeLockHeldError` names the holder's pid and the lock file path, and explicitly
  references the corruption incident in its message. Propagates through the existing
  `runBacklogCli().catch()` in `src/index.ts:151` (prints stack, `process.exitCode = 1`) — no new
  error-handling plumbing needed.

### Why not full sox-ecosystem OS-unit supervision (`soxe service enable backlog`)

`backlog` is a globally-installed pnpm binary (`@adhd/backlog@0.1.7` at `~/Library/pnpm/backlog`),
built from a wholly separate repo/monorepo (`adhd`), not a sox-ecosystem extension in
`registry/index.json`. Registering it as a real sox-managed service would require restructuring how
it's built and distributed — becoming an mcp-server extension with sox lifecycle metadata instead of
a bare global CLI/stdio binary `.mcp.json` spawns directly — which is materially larger than this
task and touches a different repo's release/publish pipeline (`tools/nx-plugins/build/executors/`).
That is a legitimate follow-on (would additionally close the `.mcp.json` stdio-reconnect-on-upgrade
gap the way `memory-server`'s M3→M4 front-shim proxy does, per `docs/spec/service-lifecycle.md`
§9.5) but is out of scope here. The store-lock guard is the smallest change that delivers the actual
invariant asked for — **"the backlog store cannot have concurrent writers"** — without touching
`.mcp.json`, existing CLI callers, or `mcp__backlog__*` tool wiring at all.

### Shutdown-window

Addressed explicitly, not left open: the lock is released only after `closeGraphBacklogStoreSafe`
resolves (`server.ts`'s `closeStoreOnce`), never on SIGTERM/SIGINT receipt. Proven in
`serve.singleton.spec.ts`'s "shutdown-window" test — a concurrent start during a still-alive-but-
draining instance is refused; once the instance's `transport.close()` (which waits for real process
exit) resolves, a fresh start succeeds immediately.

### Crash recovery

A `SIGKILL`ed holder's lock file is reclaimed automatically on the next `acquireServeLock` call via a
`process.kill(pid, 0)` liveness probe — no manual cleanup, no restart-until-timeout. Proven in the
"crash recovery" test.

### Existing callers

Unaffected. `mcp__backlog__*` tools and the `backlog` CLI's one-shot commands (`list-items`, etc.) open
the store directly via `openGraphBacklogStore` in `cli.ts`, never through `startBacklogServer` — the
guard is scoped exactly to the `serve` long-lived-listener path (`startBacklogServer`), which only
`serve.ts` and the MCP test fixture (`test/fixtures/mcp-stdio-entry.js`) reach. No opt-in flag needed;
nothing else changes behavior.

## Red→green verification (BL-225 standard)

Real two-subprocess proof, same pattern as the pre-existing `serve.spec.ts` (spawns the REAL BUILT
`dist/index.js serve --transport mcp`, drives it with a real `@modelcontextprotocol/sdk` client — never
an in-process bypass):

1. **RED**, ad-hoc + manual, against the pre-fix commit (`226074df`) built in an isolated
   `git worktree` (`.worktrees/serve-lock-red`, removed after use): two `serve` subprocesses against
   the same scratch store both connected — `RESULT { aOk: true, bOk: true }`.
2. **GREEN**, same race against the patched build: `RESULT { aOk: true, bOk: false }`, with the refused
   instance's error naming the live holder's pid.
3. Committed as `serve.singleton.spec.ts` (3 tests: live-refusal, shutdown-window, crash-recovery) +
   `store/serve-lock.spec.ts` (11 unit tests: acquire/release, stale reclaim, malformed-lock reclaim,
   never-clobber-a-later-owner, `:memory:` exemption, path canonicalization). All 14 pass when run in
   isolation (`npx vitest run src/serve.singleton.spec.ts src/store/serve-lock.spec.ts`).

## Bug found and disclosed, NOT part of this task: `nx test backlog`'s full sweep intermittently
## reverts `dist/` to a stale (pre-change) build mid-run

**Observed, not yet root-caused — filing as a finding since the backlog tool itself is down.**

Running `npx nx test backlog` (the FULL affected-test sweep, which the `adhd` repo's own
`.githooks/pre-commit` Gate 3 also invokes) produced 2 apparent test failures in
`serve.singleton.spec.ts` that do NOT reproduce when the same two spec files are run in isolation via
`npx vitest run src/serve.singleton.spec.ts src/store/serve-lock.spec.ts` immediately after a fresh
`npx nx build backlog`. Root cause traced partway:

- `npx nx build backlog` run standalone, immediately before the failing sweep, produced
  `dist/index.js` at 425,418 bytes (today's date, contains `ServeLockHeldError` — grep-verified) — the
  correct, patched artifact.
- After the FULL `nx test backlog` sweep ran (which re-invokes `backlog:build` as a dependency, and
  then runs ~30 other spec files across many workers), `dist/index.js` was found at exactly 423,429
  bytes, dated **Aug 14** (three days stale) — the UNPATCHED size/shape, confirmed via
  `grep -c ServeLockHeldError dist/index.js` returning 0.
- Re-running `npx nx build backlog` alone afterward correctly restored the 425,418-byte patched build
  (nx's own cache correctly holds and restores the patched artifact when invoked standalone — the
  corruption only appears as a side effect of the FULL sweep).
- Did **not** find the specific culprit spec file — ruled out `server.published-layout.spec.ts` and
  `install.published-layout.spec.ts` (both only `cpSync` FROM `dist/` into a disposable scratch dir,
  never write back) via `rg` read of both files. Did not have time to bisect the remaining ~30 spec
  files or `.githooks`/nx-plugin executors for a write-back-to-source-`dist/` side effect.
- **Practical impact:** anyone running `npx nx test backlog` (including this repo's own pre-commit
  Gate 3) as their SOLE verification of a `dist/`-consuming change risks a false-negative (a stale,
  reverted `dist/` silently un-verifying whatever they just built) or, worse, a false-positive test
  failure exactly like the one this investigation hit — a real fix reported as broken because the
  artifact under test wasn't the one just built.
- **This finding is NOT a regression from my change** — it reproduces on unrelated pre-existing spec
  files in the same suite and is a property of the `nx test backlog` sweep itself, not of
  `serve-lock.ts`/`server.ts`. Recorded here per the "never bury bugs" disclosure rule; could not file
  to the `adhd` monorepo's own backlog/issue tracker for the same reason as this whole finding — the
  tool is down.
- **Recommendation:** whoever owns `adhd`'s nx build/test pipeline should bisect which spec (or which
  nx executor — `assets`, `dist-manifest`, a publish-simulation step) writes back into the live
  `{projectRoot}/dist` during the full sweep instead of a scratch copy, matching the exact failure
  shape `BUG-BUILD-ASSETS-CACHE-STALE-AFTER-CLEAN-001` (referenced in `backlog`'s own `project.json`
  build-target comments) already documents for a *different* stale-restore mechanism on the SAME
  `dist/` — plausibly the same root cause recurring, not a new one.

## Coordination note

Read `2026-08-17-backlog-store-recovery.md` mid-task: the recovery agent had paused, blocked on
whether I ("backlog-singleton-enforcement") had signaled production pid 22905. I had not — confirmed
directly to the team-lead. All verification in this task ran against scratch temp stores
(`mkdtempSync`-based) or the isolated `.worktrees/serve-lock-red` worktree; `~/.adhd/backlog/production/`
was never touched, read or written, by this task.
