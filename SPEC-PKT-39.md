# SPEC-PKT-39 — `soxe list` reports a running service as INACTIVE (BL-332)

Architect stage output. Implementer: read this whole document before touching `main.ts`. Every
decision below is ruled — do not re-litigate; if you hit a case not covered here, stop and escalate
rather than guessing.

## 1. Root cause

`apps/sox/src/main.ts`, `cmdList`, default (non-`--all`, non-`--global`) render path,
`apps/sox/src/main.ts:3685-3702`:

```ts
const rtEntry = runtimeEntries.find((r) => (r.key ?? r.id) === lockKey || r.id === extId);
const pid = (rtEntry?.pid != null && typeof rtEntry.pid === 'number') ? rtEntry.pid : null;
const pidAlive = (p: number): boolean => { try { process.kill(p, 0); return true; } catch { return false; } };
const running = rtEntry?.running === true && pid !== null && pidAlive(pid);
```

`running` is computed **exclusively** from `runtime.json` (`rtEntry`): it requires a runtime-record
`running:true` flag AND a recorded `pid` AND that pid answering `process.kill(pid,0)`. This is the
correct check for an M1/M3 service the CLI itself started and is still supervising (`rtEntry` gets
written by the CLI's own start path) — it is `[inv:list-never-lies]`'s "C4" case, and it already
works, per `docs/spec/service-lifecycle.md:938` ("runtime.json says running, OS unit says not
loaded, no live process → mark running:false").

It has **no fallback** for a service that is alive but was never recorded as `running:true` in this
particular `runtime.json` — the exact shape of an M4 (`launchd`/`systemd`-managed) service adopted
via `soxe service enable`: `service enable` (`main.ts:4800-4862`) never writes a `runtime.json`
entry at all; the process's only record of existence is the OS unit + the live pid itself. Compare
`cmdService`'s `status` subcommand, `main.ts:4918-4960`, which resolves the extension's entrypoint
(`resolveOsUnitContext`, `main.ts:4667-4739`) and asks reality directly:

```ts
// main.ts:4932-4936
let livePids: number[] = [];
if (ctx?.entrypoint) {
  livePids = findOrphansByIdentity(identityToken(`file://${ctx.entrypoint}`), { excludePids: [process.pid] })
    .map((m) => m.pid);
}
```

`findOrphansByIdentity` / `identityToken` (`libs/host-runtime/src/reaper.ts:191-230`) scan the live
process table for a process whose argv contains the entrypoint's absolute path as a whitespace-
bounded token — this is what actually caught pid 42844 in the BL-332 driver's manual `service
status` run. `cmdList`'s default path never calls this. That is the entire defect: **`cmdStatus`'s
`service status` reality-verification path exists and is correct; `cmdList` was never routed
through it — a near-exact repeat of BL-95's shape** (BACKLOG.md:1039-1051, `PLAN.md:1843-1853`).

The `--all` (`main.ts:3523-3604`) and `--global` (`main.ts:3465-3518`) modes are separate code paths
reading different data sources (the global supervisor registry, and the install registry,
respectively) and are **not implicated** by the BL-332 driver, which reproduced against the default
scope-scan path. They are out of scope for this packet (see §2 "Files: out of bounds").

## 2. The change

**File: `apps/sox/src/main.ts` only. Function: `cmdList`, default render path, lines 3656-3703
(the per-scope `for (const lockKey of Object.keys(lf.resolved))` loop). No other function, and no
other block inside `cmdList`, changes.**

### 2.1 What changes

Inside the `for (const lockKey ...)` loop, after the existing `running`/`pid` computation
(current `main.ts:3691-3696`) and before the `allRows.push(...)` (current `main.ts:3701`), add a
reality-verification fallback that fires **only when the runtime.json-derived `running` is
`false`**:

1. Resolve the extension's on-disk entrypoint from data already in scope in the loop — `entry`
   (the `LockfileEntry`, `libs/install-engine/src/install.ts:47-52`, whose `source` field is a
   required `string`, never optional — no null-guard needed on `entry.source` itself, only on the
   manifest read succeeding) and `root`:
   ```ts
   const extDir = resolveExtensionDir(entry.source, root);   // already imported, main.ts:59
   const manifestPath = pathMod.join(extDir, 'extension.json');
   ```
2. If `extension.json` exists and parses, and has a truthy `entrypoint` field, resolve it to an
   absolute path the same way `resolveServeManifest`/`resolveOsUnitContext` do
   (`main.ts:2213`, `:4684`): `pathMod.resolve(extDir, manifest.entrypoint)`.
3. Reality-check it with the **exact same primitives** `cmdService`'s `status` subcommand uses —
   `identityToken` and `findOrphansByIdentity`, both already imported at the top of `main.ts`
   (`main.ts:32`, `:42`):
   ```ts
   const token = identityToken(`file://${entrypointAbs}`);
   const liveMatches = findOrphansByIdentity(token, { excludePids: [process.pid] });
   ```
4. If `liveMatches.length > 0`: this row IS running. Override `running = true` and set
   `pid = Math.min(...liveMatches.map((m) => m.pid))` (deterministic under the `[inv:singleton]`
   assumption of one live pid per key; `Math.min` gives a stable choice on the rare transient
   double-match instead of array order, which is not deterministic across `ps` invocations).
5. Wrap steps 1-3 in `try { ... } catch { /* best-effort reality check; on any failure, keep the
   runtime.json-derived state */ }` — a manifest-read or path-resolution failure must never crash
   `list`; it must fall back to the (already-correct) `running:false` it already had.

Net diff shape (illustrative, not literal — implementer writes the real code):

```ts
for (const lockKey of Object.keys(lf.resolved)) {
  const entry = lf.resolved[lockKey];
  // ... existing extId/ver computation unchanged ...
  const rtEntry = runtimeEntries.find(...);
  const pid = ...;                              // unchanged
  const pidAlive = ...;                         // unchanged
  let running = rtEntry?.running === true && pid !== null && pidAlive(pid);  // unchanged line, now `let`
  let finalPid = pid;                            // was: used pid directly below

  // NEW — [inv:list-never-lies] fallback: runtime.json has no entry for an
  // M4 (OS-unit-adopted) service, so ask reality directly (BL-332).
  if (!running) {
    try {
      const extDir = resolveExtensionDir(entry.source, root);
      const manifestPath = pathMod.join(extDir, 'extension.json');
      if (fsMod.existsSync(manifestPath)) {
        const manifest = JSON.parse(fsMod.readFileSync(manifestPath, 'utf8')) as { entrypoint?: string };
        if (manifest.entrypoint) {
          const entrypointAbs = pathMod.resolve(extDir, manifest.entrypoint);
          const token = identityToken(`file://${entrypointAbs}`);
          const liveMatches = findOrphansByIdentity(token, { excludePids: [process.pid] });
          if (liveMatches.length > 0) {
            running = true;
            finalPid = Math.min(...liveMatches.map((m) => m.pid));
          }
        }
      }
    } catch { /* best-effort; keep runtime.json-derived state on failure */ }
  }

  const rawSrc = rtEntry?.source ?? entry?.source ?? '';   // unchanged
  const source = cleanSource(typeof rawSrc === 'string' ? rawSrc : '');  // unchanged
  allRows.push({ id: extId, key: lockKey, version: ver, scope: sc, running, source, pid: finalPid });
}
```

Add one declaration near the top of `cmdList`, alongside the existing `const fsMod = ...`
(`main.ts:3460`):
```ts
const pathMod = require('node:path') as typeof import('node:path');
```
(Matches the file's existing inline-require style used elsewhere in the same function, e.g.
`main.ts:3494`, `:3512` — do not add a top-of-file `import` for this, it would be inconsistent
with every other `node:path` use in `cmdList` and its siblings.)

### 2.2 What must NOT change

- **`--all` mode** (`main.ts:3520-3604`) and **`--global` mode** (`main.ts:3462-3518`) — different
  data sources, not implicated by the BL-332 driver, and PKT-38 is working on adjacent `main.ts`
  territory concurrently; touching either widens the diff for no acceptance-criteria benefit and
  raises collision risk.
- **`cmdStatus`** (`main.ts:6601+`) and **`cmdService`'s `status` subcommand** (`main.ts:4918-4960`)
  — these are already correct (BL-95 fixed the former; the latter was always correct). Do not
  refactor them to "share code" with `cmdList` beyond the two already-shared primitives
  (`identityToken`, `findOrphansByIdentity`) — see §3.1 for why a shared helper function is
  explicitly rejected.
- **`resolveOsUnitContext`** (`main.ts:4667-4739`) — do not call it from `cmdList`. See §3.2.
- Nothing in `libs/host-runtime/src/` changes. `identityToken`/`findOrphansByIdentity` are consumed
  as-is; if they need a new capability, that is a different packet.
- No other command's rendering (`cmdDetails`, `cmdServiceList`, etc.) changes.

## 3. Decisions, ruled

### 3.1 Extract a shared `verifyRunning(extId, scope, root)` helper vs. inline the check in `cmdList`

**Ruling: inline it in `cmdList`, do not extract a shared helper (yet).**

The packet description says "route its status column through the same reality-verification
`cmdStatus`/`service status` already uses" — read literally that could mean "call
`resolveOsUnitContext` + the same liveness check `service status` calls." I reject that reading in
favor of "reuse the same *primitives* (`identityToken`, `findOrphansByIdentity`) that make
`service status` correct," for a concrete reason in §3.2. A shared wrapper function that both
`cmdList` and `cmdService`'s `status` call would need a signature that satisfies both callers'
different existing-data shapes (`cmdList` already has `entry`/`extDir` from its lockfile-scan loop;
`cmdService status` computes them from `resolveOsUnitContext`, which additionally does node-path/
env/spec derivation `cmdList` has no use for). Forcing a shared signature today means either (a)
`cmdList` pays for `resolveOsUnitContext`'s extra work it doesn't need, or (b) `cmdService status`
gets refactored to stop using `resolveOsUnitContext`, which is out of this packet's file scope and
risks PKT-38 collision. A future packet can extract the true common kernel (`identityToken` +
`findOrphansByIdentity` given an absolute entrypoint) into a two-line helper if a third call site
appears; two call sites sharing two library calls do not yet justify one.

### 3.2 Reuse `resolveOsUnitContext` vs. resolve the entrypoint inline from data already in `cmdList`'s loop

**Ruling: resolve inline (`resolveExtensionDir(entry.source, root)` + read `extension.json`
directly), do not call `resolveOsUnitContext`.**

`resolveOsUnitContext` (`main.ts:4667-4739`) does far more than "find the entrypoint": it calls
`getOsUnitPlatform`/`detectOsSupervisor()`, `resolveUnitNodePath()` (which probes `nvm`/`asdf`/
`volta` paths on disk — `docs/spec/service-lifecycle.md` Appendix B item 3), loads the ownership
index for `artifactHash`, calls `buildOsUnitEnv`, and calls `deriveOsUnitSpec`. None of that output
is used by the fix in §2.1 — only `entrypoint`. Calling it once per non-running row in `cmdList`
would mean every `soxe list` invocation pays for a `nvm`-path filesystem probe and an ownership-
index read per candidate row, for extensions that were never `service enable`d and have no os-unit
at all (most rows, in practice — mcp-servers commonly run stdio/direct, not as OS units). It would
also mean `list`'s correctness silently depends on `resolveUnitNodePath()` continuing to behave the
same way for a purpose (finding a service's live pid) it was never designed for. `cmdList` already
has the lockfile `entry` (with `entry.source`) in scope from its own loop — resolving the entrypoint
from that directly, the same two-step `resolveExtensionDir` + `extension.json` read that
`resolveServeManifest` (`main.ts:2199-2232`) already does for the same purpose elsewhere in this
file, is strictly less code, no new failure surface, and no accidental dependency on node-path
detection succeeding.

### 3.3 Does the `[inv:list-never-lies]` M4 "OS unit is loaded" conjunct (`docs/spec/service-lifecycle.md:948-950`) gate the RUNNING determination in `list`?

**Ruling: no. `running` for `soxe list` is "a live process matches the entrypoint's identity
token," full stop — independent of `platform.isLoaded()`.**

The spec's literal text: *"A pid is RUNNING iff `process.kill(pid,0)` succeeds **and** (for
socket-health services) the socket answers **and** (for M4) the OS unit is loaded."* Applied
literally to `list`, a genuinely alive orphan process (F2 in the failure-mode catalog,
`docs/spec/service-lifecycle.md:1014` — "Orphan survives `soxe stop`") whose OS unit is *not*
loaded (because it was disabled, or never had one) would render INACTIVE despite being alive. That
is a lie in the direction the packet itself calls out as the same invariant: *"the converse... is
the same invariant"* (task brief, "The defect" section) — *"never report INACTIVE for something
demonstrably alive."* Gating on `loaded` would satisfy the RUNNING-when-loaded case (the literal
BL-332 repro) while reintroducing the converse failure for any orphan.

`platform.isLoaded()`'s conjunct exists for `service status`'s `owner` field (`main.ts:4937`:
`owner = loaded ? 'os-unit' : 'none'`) — a different question ("who supervises this pid, if
anyone") than `list`'s question ("is this extension's process alive"). §10.3's governing sentence
is *"MUST render reality-verified descriptors only"* — a live pid matching the entrypoint's
identity token **is** the reality; `loaded` is provenance metadata about it, not a precondition for
it existing. `list` has no `owner` column to populate, so the conjunct has nothing to attach to
here.

This ruling also has a load-bearing practical consequence for §5 (testability): it means the
acceptance test does **not** need a real `launchctl load` (which `service-os-unit.spec.ts`'s own
header comment explicitly avoids: *"Uses `--dry-run` so enable never loads (no real launchctl)"*,
`apps/sox/src/service-os-unit.spec.ts:19`) — a plain detached child process whose argv contains the
resolved entrypoint path reproduces the exact reality gap portably and without OS side effects. See
§5.

### 3.4 Which rows attempt the reality-verification fallback — all rows, or only rows the runtime.json check already found not-running?

**Ruling: only rows where the runtime.json-derived `running` is `false`.**

If `rtEntry?.running === true && pidAlive(pid)` already holds, that IS reality-verified per the
existing, already-correct C4 path — `process.kill(pid,0)` on the recorded pid succeeded. Re-running
`findOrphansByIdentity` (a full process-table snapshot + argv scan, `libs/host-runtime/src/
reaper.ts:224` `snapshotProcesses()`) on every row regardless would double the cost of `soxe list`
for zero correctness benefit, since the auth order (`docs/spec/service-lifecycle.md:1037`,
`[auth:supervisor-then-os-then-os-reality]`) already ranks a live GC-verified supervisor record
above OS/process reality — there is nothing for the fallback to override once the primary check
already succeeded.

### 3.5 What determines the displayed `pid` when multiple live matches are found?

**Ruling: `Math.min(...liveMatches.map(m => m.pid))`.**

`[inv:singleton]` (`docs/spec/service-lifecycle.md:1035`) means there should never legitimately be
more than one live process for one singleton key; a transient double-match (mid-restart, or a
doctor-reconcile heal race) is exactly the kind of split-second window §5.3's survivor tiebreak
(`docs/spec/service-lifecycle.md:1399`, oldest-by-`lstart`, lowest-pid fallback) already exists to
handle deterministically elsewhere. `Math.min` is the cheap, deterministic proxy for "oldest" (pids
are usually — not guaranteed, but usually — monotonically increasing on the host) that avoids
depending on `ps -o lstart` parsing inside `cmdList`'s hot render path; it is not required to be
perfectly correct under pid-wraparound, only to be **deterministic across two consecutive `soxe
list` invocations with the same process set**, which `Math.min` on a JS array is.

### 3.6 Should the reality check apply to every installed extension, or only `type: service` / `type: mcp-server`?

**Ruling: apply to every row; let the manifest-entrypoint check itself be the filter.**

An extension with no `entrypoint` field in `extension.json` (skills, hooks, commands) makes step 2
of §2.1 a no-op — `manifest.entrypoint` is falsy, the `if` body never executes, `running` stays
`false` exactly as it does today. Special-casing on `manifest.type` first would require an *extra*
manifest read (or a second field check) to save nothing — the entrypoint check already is the type
filter, for free.

## 4. Acceptance criteria (name BL-332)

All three live in one new spec file, `apps/sox/src/bl332-list-reality.spec.ts`, following the
existing sandboxed-subprocess pattern (`apps/sox/src/bl36-bl178-bl57.spec.ts:34-73`,
`apps/sox/src/service-os-unit.spec.ts`): `spawnSync(process.execPath, [CLI_MAIN, ...args], { env: {
...process.env, SOX_ECOSYSTEM_HOME: <tmp>, ... } })` against the real built
`dist/apps/sox/main.js`. Do **not** invent a new test-driving mechanism.

Test fixture, shared by all three: a lockfile (`extensions.lock` under the sandboxed
`SOX_ECOSYSTEM_HOME`) with one resolved entry `test-svc@1.0.0` (or lockfile v2 shape, `test-svc`)
pointing `source: file://<tmpExtDir>`, and `<tmpExtDir>/extension.json` = `{ id: 'test-svc', type:
'mcp-server', entrypoint: 'dist/index.js' }`, and `<tmpExtDir>/dist/index.js` = a script that stays
alive (`process.stdin.resume();` — no timers, no network, kill by pid in `afterEach`). This mirrors
`makeServiceStore` in `apps/sox/src/bl36-bl178-bl57.spec.ts:82-91`; reuse that shape, do not
reinvent the lockfile-writing helper — copy/adapt `writeRuntimeRecord`'s lockfile-writing block
(`apps/sox/src/bl36-bl178-bl57.spec.ts:121-134`) for the lockfile, but write NO `runtime.json` at
all for AC-1 (the exact BL-332 shape: no runtime record exists for an OS-unit-adopted service).

**AC-1 (BL-332, primary).** With the fixture above and a real detached child process spawned
(`spawn(process.execPath, [entrypointAbsPath], { detached: true, stdio: 'ignore' }).unref()`,
capture its `pid`), run `soxe list --scope=user --json`. Assert the JSON array contains an entry for
`test-svc` with `running === true` and `pid === <the spawned pid>`.
- **RED arm (must fail before the fix exists):** run this exact test against the unmodified
  `cmdList` (`main.ts:3656-3703` as of `3db7ff46`, before any edit from this spec). It fails because
  `rtEntry` is `undefined` (no `runtime.json` entry was written), so `running` computes to `false`
  and `pid` to `null` — the assertion `running === true` fails. **Run this and observe the failure
  before writing the fix**, per the repo's BL-225 rule; do not proceed to the fix until you have
  seen it fail.
- **GREEN arm:** after §2's change, the fallback resolves `dist/index.js`'s absolute path, finds the
  spawned pid via `findOrphansByIdentity`, and the row renders `running: true, pid: <spawned pid>`.
- Cleanup: `afterEach` must `process.kill(spawnedPid, 'SIGKILL')` in a `try/catch` (already-dead is
  not an error) regardless of test outcome — do not leak the child process across test runs.

**AC-2 (BL-332, converse — required by the packet's own framing, "the same invariant").** Same
fixture (lockfile + manifest + `runtime.json` absent), but do **not** spawn any process. Run `soxe
list --scope=user --json`. Assert the entry for `test-svc` has `running === false` and `pid ===
null`.
- **RED arm:** this assertion already passes on unmodified `main.ts` — the point of AC-2 is not to
  catch today's bug (it doesn't reproduce it) but to **prove the fix does not regress it**. Run
  AC-2 against the *fixed* code with a deliberately broken fallback (e.g. temporarily hardcode
  `running = true` in the new block) to confirm AC-2 fails when the fix is wrong in the optimistic
  direction — this is the red arm for AC-2 specifically, distinct from AC-1's red arm. Do this as a
  manual sanity check while implementing (not a permanent test variant); the committed test asserts
  only the correct behavior.

**AC-3 (non-regression — the existing M1/M3 supervisor-tracked path must be untouched).** Same
lockfile fixture, but this time write a `runtime.json` with a `running:true` entry and `pid:
<spawned pid>` for `test-svc` (the shape `writeRuntimeRecord` already produces,
`apps/sox/src/bl36-bl178-bl57.spec.ts:121-159`, adapted to `running:true`/a real live pid instead of
`false`/`null`), spawn the same kind of live child and record its real pid in that runtime record,
run `soxe list --scope=user --json`. Assert `running === true` and `pid === <spawned pid>` — this
must pass **before and after** the fix (it exercises the pre-existing, already-correct
`main.ts:3691-3696` branch; §3.4 rules that the new fallback must not even execute for this row).
- **RED arm:** none required — this criterion's purpose is proving the fix is a strict addition,
  not a replacement, of the working path. If this test fails after the fix, the fix broke the
  working path — treat that as a new regression to fix immediately (per the repo's Zero Deflection
  rule), not as pre-existing.

## 5. Risks

- **No destructive/data-loss risk in the fix itself.** The change is read-only against the live
  process table and `extension.json`; it writes nothing new to disk.
- **`nx build` is destructive (BL-235)** — do not run `npx nx build sox` speculatively to "see if it
  compiles." Read the diff, run `npx nx typecheck sox` first (non-destructive, no `dist/` wipe),
  fix any type errors from the `let running`/`let finalPid` mutation (TS will likely flag the
  `const running`→`let running` change if any later code in the loop still expects `const`-narrowed
  types — check `main.ts:3701`'s current `pid` reference is fully replaced by `finalPid`, not left
  dangling), and only run `npx nx build sox` once you believe the diff compiles.
- **`nx test sox` rebuilds dependencies (BL-456)** — `sox`'s `dependsOn` includes `service-proxy`,
  `install-engine`, `host-registry`, `host-runtime`, `manifest`, `authoring`, `registry` (per `npx
  nx show project sox`). Before trusting any `nx test sox` result, run and report `node
  tools/check-suite-tree-state.mjs --project sox` alongside it — if it reports dirt in one of those
  upstream libs from a concurrent agent, the result is unattributable, not wrong; do not act on it
  without noting that.
- **PKT-38 collision risk.** PKT-38 also touches `main.ts` for `service enable`. This spec's diff is
  confined to `cmdList`'s default-path loop (`main.ts:3656-3703`) plus one `const pathMod` addition
  near `main.ts:3460` — nowhere near `cmdService`'s `enable` subcommand (`main.ts:4800-4862`).
  Commit by explicit pathspec (`main.ts` only, this file, the new spec file) per the repo's commit-
  by-pathspec rule; do not `git add -A`.
- **Detached test child leaking across a crashed test run.** `AC-1`/`AC-3` spawn real OS processes.
  If the test process itself is killed mid-run (e.g. CI timeout) before `afterEach` fires, the
  spawned `process.stdin.resume()` child leaks as an orphan. Mitigate by keeping the test's own
  `timeout` generous (10-15s, matching `apps/sox/src/bl36-bl178-bl57.spec.ts:70`'s
  `timeout: 10000`) so the CLI subprocess itself cannot hang past it, and killing the spawned pid
  immediately after the `runCli` call returns (not deferred to a shared `afterEach` array) so the
  window is as short as possible. This is the same risk profile every other sandboxed-subprocess
  spec in this file already accepts (`service-os-unit.spec.ts` spawns real launchd-adjacent
  processes too) — not a new category of risk this packet introduces.

## 6. The gate — exact nx targets, in this order

1. `npx nx typecheck sox` — non-destructive, catches the `let`/type-narrowing issues from §5 first.
2. `npx nx lint sox`
3. `npx nx build sox` — **only after 1-2 pass.** This is the destructive step (BL-235); do not run
   it to "check for errors."
4. `npx nx test sox -- apps/sox/src/bl332-list-reality.spec.ts` — scoped run of the new file only,
   first with the fix DISABLED (comment out or revert the `if (!running) { ... }` block, or check
   out `main.ts` from `3db7ff46` into a scratch copy — do not `git checkout --` the real working
   tree file while other edits are uncommitted) to observe AC-1's RED failure, then with the fix
   enabled to observe GREEN. Report `node tools/check-suite-tree-state.mjs --project sox` alongside
   this result per BL-456.
5. `npx nx test sox` — full suite for the project, to catch any incidental regression in
   `status-rendering.spec.ts`, `bl36-bl178-bl57.spec.ts`, `service-os-unit.spec.ts`, etc. that
   exercise `list`. Report tree-state alongside this too.
6. Commit by explicit pathspec: `git commit apps/sox/src/main.ts apps/sox/src/bl332-list-reality.spec.ts -m "fix(sox): route cmdList's status column through identity-based reality verification (BL-332)"` — lowercase subject, scope `sox`. Do not amend, do not `git add -A`.

Do not touch `registry/index.json` — `sox` is the CLI itself, not a bundled extension artifact
consumed by the registry sync step (that step is for `extensions/**` `dist` bundles); `npx nx run
registry:sync-index` is not part of this packet's gate.
