# BL-393 Phase 2 handoff — respawn trigger investigation (STOPPED FOR BUDGET)

Status: **in progress, not complete**. Stopped mid-investigation on an explicit
budget-exhaustion instruction from the coordinator. Worktree:
`.claude/worktrees/agent-a9032294d951a0cc9` (branch `worktree-agent-a9032294d951a0cc9`).
**Keep this worktree** — the mitigation commit below is untested and needs a
typecheck/build/lint/test pass before it can be trusted or merged.

## What I actually MEASURED (hard log evidence, not inference)

All timestamps cross-checked against two independent sources that agree to
within ~1s once you apply a **+5h UTC offset** to the backend's own embedded
local-time log lines (anchor: `service restart` audit entry at
`2026-08-01T23:47:16.192Z` UTC = backend log `2026-08-01 18:47:21` local).

1. **`/Users/nix/.adhd/sox-ecosystem/run/logs/doctor-reconcile/doctor-reconcile-2026-08-02.log`**
   (the doctor-tick reconcile daemon's own durable action log, timestamps are
   real UTC, written by `doctorReconcile()` in `apps/sox/src/main.ts`):

   ```
   2026-08-02T00:09:36.040Z [reconcile] memory-server@project: pid 8820 REPORT+SKIP — single-unaccounted-report-only
   2026-08-02T00:14:39.224Z [reconcile] pass starting (root=/Users/nix/.adhd/sox-ecosystem)
   2026-08-02T00:14:42.253Z [reconcile] [singleton-violation] memory-server@project: 2 live, no socket — survivor=8820 losers=56514
   2026-08-02T00:14:42.254Z [reconcile] heal memory-server pid 56514: SIGTERM → pid 56514 (grace 5000ms)
   2026-08-02T00:14:42.765Z [reconcile] [singleton-violation healed] memory-server pid 56514 → term
   2026-08-02T00:14:43.303Z [reconcile] pass complete: 1 healed, 0 would-heal (dry-run), 0 report-only, 0 failed
   2026-08-02T00:19:44.574Z [reconcile] memory-server@project: pid 65352 REPORT+SKIP — single-unaccounted-report-only
   ```

   **This is a real, autonomous SIGTERM sent by the doctor-tick reconcile
   daemon** (launchd `StartInterval=300`, i.e. every 5 minutes — confirmed via
   `plutil -p ~/Library/LaunchAgents/com.sox.user.doctor-tick.plist`), acting on
   its own §5.3 singleton-violation self-heal logic
   (`apps/sox/src/main.ts` ~line 5484, `chooseSurvivor`/`killAndVerify` from
   `libs/host-runtime/src/{reconcile,reaper}.ts`). It fired 47 seconds BEFORE
   the ticket's stated respawn time.

2. **`/Users/nix/.adhd/sox-ecosystem/run/logs/os-user-memory-server/memory-server-os-2026-07-31.err.log`**
   (the persistent shim/proxy's own stderr — no timestamps embedded, ordering
   only): shows exactly 3 `ensuring backend (backend disconnect)` →
   `ensure backend: spawned` cycles after the 23:47Z deliberate deploy:
   `pid 8820` → `pid 56819` → `pid 65352`. The proxy **never logs why** a
   backend disconnected — confirmed no `Error`/`SIGTERM`/`crash` strings
   anywhere in this file. This gap is itself a real finding (matches BL-393's
   own fix-sketch #2).

3. **`/Users/nix/.adhd/sox-ecosystem/run/logs/proxy-backend-memory-server/memory-server-backend-2026-08-0{1,2}.log`**
   (the backend's OWN stdout/stderr, rotated daily but with a rollover-timing
   quirk — the "2026-08-02" file's first entries are still local-clock
   "2026-08-01 19:1x"): confirms `version 4d2773bad484` (the deliberately
   reviewed 23:47Z deploy) is reported **unchanged** across every restart in
   this window, including the final one at local `19:15:30` (= `00:15:30Z`,
   matches ticket's `00:15:29Z` almost exactly). **The respawned process never
   loaded a rebuilt bundle** — it kept re-loading the same already-resident
   `4d2773bad484` code. This directly falsifies "the transitive rebuild
   redeployed the backend" as literally stated for THIS specific respawn.

4. **`/Users/nix/.adhd/sox-ecosystem/run/sox-audit.jsonl`** (every `soxe` CLI
   invocation, real UTC timestamps): the ONLY `soxe service restart` /
   `soxe serve` entries between the 23:47:16Z deliberate deploy and 00:36:43Z
   (well after the incident) are periodic `doctor --reconcile` invocations
   (every ~5 min, matches the doctor-tick schedule) and a few `service status`
   reads. **No operator-initiated restart, and no logged `nx build`/CLI
   rebuild event, appears in this window at all.**

## Conclusion I'm confident in (measured, not inferred)

The **immediate, proximate trigger** of the final backend rotation (pid 65352,
`00:15:29-30Z`) was **doctor-tick's routine singleton-violation self-heal**
killing a duplicate backend process (pid 56514) at `00:14:42.254Z` — 47s
earlier — NOT a build, NOT an operator action, and the artifact hash never
changed across the rotation. This is autonomous, by-design self-healing
behavior in `apps/sox/src/main.ts`'s `doctorReconcile()` — correct in intent
(kill a genuine duplicate to enforce the singleton), but **completely silent**
outside a log file (`doctor-reconcile-<date>.log`) no operator checks by
default. `memory_ping` / `soxe service status` gave zero signal that a
rotation happened.

## What is STILL NOT identified (do not assume this)

**Why did a duplicate backend process (pid 56514, and the also-observed
pid 56819 from the proxy's own log — close but NOT the same pid, unexplained)
exist in the first place**, sometime between `00:09:36Z` (reconcile reports
only pid 8820, single, healthy) and `00:14:39Z` (reconcile finds 2 live)? I
found NO direct log evidence of what spawned it:
- No `nx build` / `registry:sync-index` / `soxe serve` / `service restart`
  audit entry in that 5-minute window.
- `dist/index.js` and `embedding-provider/dist/index.js` mtimes are BOTH
  `2026-08-01 19:3x` local (`00:3x` UTC) — **after** the incident, not during
  it (they were rebuilt again later, most likely by the BL-405 fix commit at
  `19:33:29` local). I cannot forensically inspect what was on disk at
  `00:09-00:14Z` because it has since been overwritten.
- The ticket's original hypothesis (operator's `registry:sync-index` →
  transitive `embedding-provider` rebuild → `memory-server` re-bundle) remains
  a *plausible* explanation for how a second `ensure-backend` spawn could have
  raced in, but it is UNPROVEN — I ruled out that it explains the FINAL
  respawn (§ above: same artifact hash throughout), but I did not rule it in
  or out as the cause of the intermediate duplicate.

## Ruled OUT, with evidence

- **A rebuild directly caused the final respawn** — ruled out: version hash
  `4d2773bad484` unchanged across all 3 restarts in the window (backend's own
  log, `[memory-server backend] listening on ... (version X)` lines).
- **An operator explicitly restarted/redeployed** — ruled out: `sox-audit.jsonl`
  shows no `service restart`/`serve` verb between 23:47:16Z and 00:36:43Z.
- **doctor-tick's reconcile is buggy / guess-killing** — ruled out as a bug in
  itself: it correctly found 2 live processes with no attributable socket and
  killed the deterministically-chosen non-survivor per its documented §5.3
  rule; `chooseSurvivor`/`killAndVerify` behaved as designed and logged
  "→ term" (clean SIGTERM exit, not SIGKILL escalation).
- **BL-405 (racing SIGTERM handlers → SIGKILL)** is a REAL, separate bug fixed
  by commit `9068d16` (committed `2026-08-01T19:33:29` local, i.e. AFTER this
  incident) — it explains why earlier-in-the-day backend restarts (12:33,
  13:19, 13:25, 14:23 local — routine, unrelated to this incident, recurring
  all day) sometimes hung/SIGKILLed, but is NOT itself the trigger for BL-393;
  it's a contributing fragility in how the backend handles being killed, not
  what did the killing at 00:14:42Z (that was doctor-reconcile, cleanly).

## What I changed (UNVERIFIED — do this first)

`apps/sox/src/main.ts` (commit `88f5b1f` in this worktree):
- Added `SingletonHealMarker` + `singletonHealMarkerPath`/
  `writeSingletonHealMarker`/`readSingletonHealMarker` helpers (just before
  `doctorReconcile`).
- `doctorReconcile()`'s singleton-violation heal loop now writes a marker to
  `<runDir>/reconcile-heals/<extId>@<scope>.json` after each successful heal.
- `cmdService`'s `status` subcommand now reads that marker and prints a loud
  `⚠ silent respawn (BL-393): ...` line if one exists for the extId+scope.
- Added `runDir` to the `@adhd/sox-host-runtime` import block (it was already
  exported from `libs/host-runtime/src/index.ts`, just not imported here).

**NOT DONE — required before this can be trusted or before BL-393 can be
touched further:**
1. `npx nx typecheck sox` — never ran (pnpm install had just finished when the
   stop came in). `pnpm-lock.yaml` also came out dirty from that install (3
   deletions/11 insertions net — looked like drift-normalization, NOT a
   dependency I added) — **left uncommitted deliberately**, did not verify it's
   safe to commit.
2. `npx nx lint sox` / `npx nx build sox` — not run.
3. No regression test written yet. The existing test harness to extend is
   `apps/sox/src/doctor-reconcile.spec.ts` (`runCli()` pattern, sandboxed
   `SOX_ECOSYSTEM_HOME`/`SOX_OS_UNIT_DIR`, see its `writeGiveUpMarker()` +
   `soxe status --json` test for the exact pattern to follow: spawn 2 real
   long-lived child processes matching the same identity token with no
   attributable socket, run `doctor --reconcile` for real, assert the marker
   file + the `service status` warning line — a red→green test needs the OLD
   `cmdService status` code (no warning line) to fail first).
4. `node scripts/smoke-test.mjs --extension memory-server` per repo CLAUDE.md
   — not run.
5. BL-393 in `BACKLOG.md` was NOT updated with these findings — do that next,
   append (do not mark RESOLVED — the duplicate-spawn root cause is still
   open).

## Trap for the next agent

- The doctor-reconcile log's `@project`/`@user` scope label is confusing: the
  live launchd unit is `com.sox.user.memory-server`, but the reconcile log
  consistently labels the incident's pids `memory-server@project`. I did not
  resolve why (possibly `doctorReconcile`'s `root=/Users/nix/.adhd/sox-ecosystem`
  causes it to scan the project-scope install registry entry rather than the
  user-scope one — needs checking `registry.installs` for this extId before
  trusting either label).
- Do NOT assume the pid-56514-vs-56819 discrepancy (reconcile log says it
  killed 56514; the proxy's own log shows it respawned to a NEW pid it never
  names, and a separate `56819` appears once) is the same event — I could not
  fully reconcile these two pid numbers against each other with the evidence
  I had; treat them as two close-but-distinct data points, not one.
- Coordinator's message says the live backend is now pid 85177, artifact
  `a4892123287b`, on-disk matches — i.e. the artifact-drift hazard that
  motivated filing BL-393 is currently closed. The **mechanism** (why a
  duplicate backend appears) is still open and could recur.

## Next steps, in order

1. `npx nx typecheck sox && npx nx lint sox && npx nx build sox` against this
   worktree's `apps/sox/src/main.ts` change — fix whatever breaks.
2. Decide the `pnpm-lock.yaml` diff: re-run `pnpm install` clean and check if
   it's reproducible/expected, or revert with `git restore pnpm-lock.yaml` if
   it's worktree-local noise unrelated to this branch.
3. Write the red→green regression test in `doctor-reconcile.spec.ts` per the
   pattern above; name it with BL-393.
4. Resolve the `@project` vs `@user` scope-label question (see trap above)
   before trusting `readSingletonHealMarker(extId, scope)`'s scope argument in
   `cmdService status` actually matches what `doctorReconcile` wrote.
5. Go back to the still-open question: what spawned the duplicate backend
   process between `00:09:36Z` and `00:14:39Z`? Check for any MCP
   client/session reconnect activity in that window (Claude session logs under
   `~/.claude/projects/-Users-nix-dev-ai-sox-ecosystem*` for tool calls to
   `mcp__memory-server__*` in that timestamp range) as an alternative to the
   rebuild hypothesis — not yet checked.
6. Update `BACKLOG.md` BL-393 with these findings (append, cite this handoff
   doc + the log paths above). Do not mark RESOLVED.

## Files touched this session

- `apps/sox/src/main.ts` — committed, `88f5b1f`, UNVERIFIED (see above).
- `pnpm-lock.yaml` — dirty, uncommitted, not yet assessed.
- This handoff doc.

Worktree is safe to keep and resume from; nothing destructive was run (no
builds executed against this worktree's `dist/`, no live service touched).
