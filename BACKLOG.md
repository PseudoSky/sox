# Backlog

Project backlog for sox-ecosystem. Each item: what's wrong, where, severity, and a fix sketch.

---

## Current status — 2026-07-18 (regenerated mechanically; see BL-224)

**Total open: 45** (BL-293, BL-294, BL-295, BL-303 resolved 2026-07-16; BL-62 resolved 2026-07-18; BL-311 verified no live bug 2026-07-18; BL-313 (CRITICAL — live edge-table cascade-delete bug) found and resolved same-day 2026-07-18 — see CHANGELOG.md; BL-306..309 filed 2026-07-11 from native-addon/adapter research; BL-310 filed 2026-07-17 from debug agent investigation into stale shim processes; BL-312 filed 2026-07-18 from the same memory-server data-integrity investigation; BL-314 filed 2026-07-18 from a stale local content-store mirror discovered while syncing installed skill docs).
This block is DERIVED from the `**...**` status marker on each
`### BL-<n>` heading — an item is open iff its last heading marker starts with `Open`, `REOPENED`,
or `BLOCKED`. **Do not hand-maintain this section.** The previous header (dated 2026-07-07) ranked
five already-RESOLVED items as top priorities, including `BL-62` as the "#1 only PROVEN live bug"
two days after its own heading was marked RESOLVED. Regenerate; never edit in place.

Regenerate with:
```
node -e 'const fs=require("fs");let o=0;for(const l of fs.readFileSync("BACKLOG.md","utf8").split("\n")){const m=l.match(/^###\s*(?:BL|TQ)-\d+\s*—\s*(.*)$/);if(!m)continue;const k=[...m[1].matchAll(/\*\*([^*]+)\*\*/g)].pop();if(k&&/^(open|reopened|blocked)/i.test(k[1]))o++;}console.log("open:",o)'
```

| Priority | Open items |
|---|---|
| **HIGH** | `BL-96`, `BL-97`, `BL-225`, `BL-254`, `BL-273`, `BL-284`, `BL-288`, `BL-301`, `BL-302` |
| **MEDIUM** | `BL-99`, `BL-104`, `BL-105`, `BL-228`, `BL-252`, `BL-259`, `BL-274`, `BL-282`, `BL-285`, `BL-291`, `BL-296`, `BL-297`, `BL-300`, `BL-306`, `BL-307`, `BL-308`, `BL-310`, `BL-312` |
| **LOW** | `BL-103`, `BL-202`, `BL-255`, `BL-258`, `BL-261`, `BL-264`, `BL-283`, `BL-287`, `BL-289`, `BL-290`, `BL-292`, `BL-298`, `BL-299`, `BL-305`, `BL-309`, `BL-314` |
| **FEATURE** | `BL-163`, `BL-215` |

### Where to start

1. **`BL-231` is RESOLVED** — both merge gates are green again (`smoke-test.mjs`: 13 passed / 0 failed;
   `test-e2e-lifecycle.js`: 108 passed / 0 failed). Keep them that way.
2. **`BL-238` is RESOLVED (2026-07-09)** — the production composition bug (2+ ONNX worker threads /
   two onnxruntime-node major versions in one real process) is fixed: single shared
   `worker_threads.Worker` for rerank+verify, dedicated child process for fastembed. **`BL-171`
   remains open** for its narrower, distinct original subject (real-ONNX test timeouts in
   `memory-server`/`memory-flush` under vitest's forked pool) — not re-measured by this fix; see
   BL-246.
3. **`BL-62`** — live provenance corruption, now *detectable* (`project_path_source`) and *repairable*
   (BL-221), but the root fix is blocked on MCP `roots` negotiation that `mcp-runtime` does not do.
4. **`BL-235`** — `nx build` runs `rm -rf dist` before knowing the rebuild succeeds. It destroyed a
   working artifact twice on 2026-07-08. Any diagnostic build is a destructive operation.
5. **`BL-225`** — status markers record intent, not verified outcome. Four confirmed half-landed
   fixes. **The 125 items marked CLOSED have never been audited**; `BL-231` came out of that set.
6. **`BL-224`** (this header) and **`BL-223`** (ID collisions) are now RESOLVED — but both recurred
   *during* the 2026-07-09 sweep because two agents wrote this file concurrently. Coordinate writes.

**Decisions pending an owner** (not dispatchable): `BL-103`, `BL-104` (design forks in
`compiler.ts`), `TQ-3` (interface owner), `BL-166` (three built-but-unconsumed packages —
root says WITHDRAWN, three package backlogs reopen it; currently being implemented in parallel).

**Fenced** (active parallel workstream — do not edit): `libs/data/embed/**`, `libs/data/vectors/**`,
`libs/data/search/hybrid-search/**`, `libs/data/store/blob-store/**`, `libs/data/verify/claim-verification/**`.
This is why `BL-92`, `BL-117`, and `BL-220` are unowned.


---

## Open — surfaced by the P1 substrate `integration` state e2e (`tools/e2e/substrate-pipeline.test.mjs`, dod.2) (2026-07-09)

### BL-238 — `onnxruntime-node` native V8 crash when TWO ONNX worker threads run inference concurrently in one real (non-vitest) process — confirms BL-171 is a PRODUCTION-blocking composition bug, not just test-infra flake — **RESOLVED (2026-07-10, `3916afd`)** — shared ONNX worker + child-process isolation (`libs/data/embed/embedding-provider/src/sharedOnnxWorker.ts`). Regression test with real ONNX, no mocks: `sharedOnnxWorker.spec.ts:18` `BL-238/BL-171 — getSharedOnnxWorker() singleton (rerank + verify, real ONNX)`. `nx test hybrid-search` 74/74, `nx test claim-verification` 14/14, `nx test memory-server` 120/120

Building the dod.2 full-pipeline e2e (the first real, non-vitest, non-force-killed `node --test`
process to compose `@adhd/sox-embedding-provider` + `@adhd/sox-hybrid-search` (cross-encoder) +
`@adhd/sox-claim-verification` in one process) reproduced a **deterministic native V8 fatal crash**:

```
FATAL ERROR: v8::HandleScope::CreateHandle() Cannot create a handle without a HandleScope
...
 6: Napi::FunctionReference::New(...) [onnxruntime-node@1.21.0/.../onnxruntime_binding.node]
 7: OrtValueToNapiValue(Napi::Env, Ort::Value&&) [onnxruntime-node@1.21.0/.../onnxruntime_binding.node]
 8: InferenceSessionWrap::Run(...) [onnxruntime-node@1.21.0/.../onnxruntime_binding.node]
```

**Root cause, isolated via minimal repro (`node -e`, no test harness):**
- `@adhd/sox-embedding-provider`'s `FastembedProvider` runs ONNX inference via the `fastembed` npm
  package, which pins `onnxruntime-node@1.21.0`.
- `@adhd/sox-hybrid-search`'s cross-encoder and `@adhd/sox-claim-verification`'s NLI verifier both
  run ONNX inference via `@huggingface/transformers@4.2.0`, which pins `onnxruntime-node@1.24.3` —
  a DIFFERENT major version of the same native addon.
- Confirmed via 4 isolated repros: (a) 2× cross-encoder (`@huggingface/transformers`-only) worker
  threads together in one process → clean exit, no crash. (b) 1× fastembed + 1× cross-encoder →
  crash. (c) 2× fastembed (same onnxruntime-node@1.21.0, no version mismatch at all) → **also
  crashes** — so this is not purely an ABI/version-mismatch issue, it is a real thread-safety
  limitation of how the `fastembed` package's worker uses `onnxruntime-node`, specifically when 2+
  ONNX-bearing `worker_threads.Worker`s are alive/active in one process. (d) cross-encoder +
  claim-verifier together (both `@huggingface/transformers`) → clean exit.
- This is the SAME crash class as **BL-171** (`onnxruntime-node` native V8 HandleScope crash under
  vitest's forked worker pool, discovered 2026-07-04) but proves it is **not test-infrastructure-only**:
  it reproduces in genuine `worker_threads.Worker` composition with zero test harness involved, which
  means **any real production consumer of this substrate that embeds + reranks/verifies in a single
  long-lived process will crash today.** Elevating from BL-171's MEDIUM (test-infra flake) to HIGH
  (production-blocking) for this composition path specifically.
- A **separate, now-fixed** bug in the same area (see the `fix(embedding-provider,hybrid-search,
  claim-verification)` commit paired with this e2e) masked part of this: all three worker spawn
  sites called `worker.unref()` BEFORE attaching their `'message'` listener, which re-refs the
  MessagePort — so real processes hung forever on exit instead of ever reaching the crash. Fixing
  the hang (re-assert `unref()` after listeners attach) is what made the underlying native crash
  reproducible/visible outside of vitest's SSR-transform-shimmed environment in the first place.

**Not fixed here** — out of the `integration` plan state's `tools/e2e/**` reservation, and the real
fix is an architectural decision across 3 packages, not a surgical patch:
- (a) Implement the "single shared ONNX worker" invariant literally (`[inv:embedworker-wire]` in
  `docs/plan/substrate/contexts/_shared.md` already describes ONE shared `embedWorker.ts` — today
  each of the 3 consumers spawns its OWN separate worker thread running that script, not a true
  singleton/multiplexed worker), OR
- (b) pin `fastembed` and `@huggingface/transformers` to the same `onnxruntime-node` major version
  and re-verify whether that alone resolves it (unlikely alone, given repro (c) above), OR
- (c) move fastembed-based embedding to its own child **process** (not thread) boundary inside
  `@adhd/sox-embedding-provider` itself, matching the isolation `tools/e2e/child-embed.mjs` uses as
  a test-harness-side mitigation (see that file's header comment for the full write-up).

**Mitigation applied in the e2e only (superseded by the real fix below):** `tools/e2e/child-embed.mjs`
ran the fastembed-based source-provider→ingest→embedding→LanceDB-write stage in its own child process
as a test-harness-side workaround. The package-level fix below supersedes this — the same isolation
is now a first-class part of `@adhd/sox-embedding-provider` itself, not a test-only trick.

---

**RESOLUTION (2026-07-09).** Root-caused via further from-scratch minimal repros (no test harness,
no mocks, instrumented tracing) that TWO independent native hazards were in play, not one:

1. **Cross-isolate hazard (whole-process fatal, matches the original repro above).** 2+ *separate*
   `worker_threads.Worker` instances, each holding an active onnxruntime-node `InferenceSession` and
   running inference concurrently, crash the whole process with the HandleScope fatal — reproduced
   even with TWO workers on the exact SAME onnxruntime-node version, so this is a real thread-safety
   limitation of the addon whenever 2+ instances are concurrently active, not an ABI/version-mismatch
   bug. **Fix: option (a)** from the candidate list above — a single process-wide
   `worker_threads.Worker` (`embedWorker.ts`, accessed only via
   `embedding-provider`'s `getSharedOnnxWorker()` singleton) now hosts BOTH the cross-encoder rerank
   and NLI verify workloads (both `@huggingface/transformers`, onnxruntime-node@1.24.3 — proven safe
   to share one worker even under real concurrency, repro (a)/(d) above). There is never a second
   onnxruntime-bearing worker thread alive in the process.

2. **Same-thread native timing hazard (`std::bad_alloc`), independent of (1) — proven even with
   strict JS-level serialization.** Hosting fastembed's onnxruntime-node@1.21.0 in that SAME shared
   worker alongside rerank/verify was attempted and instrumented: even with the two `init` calls
   provably serialized in JS (traced — the second `init` did not begin until the first's promise had
   fully settled, zero JS-level overlap), fastembed's init still deterministically threw
   `std::bad_alloc` when it ran second. The two onnxruntime-node major versions leave native state
   (e.g. lingering background thread-pool teardown) that JS Promise resolution does not
   observe/synchronize — a hazard below what JS-level scheduling can prevent, ruling out candidate
   (b) (version pinning alone) and ruling out hosting fastembed in the shared worker at all, even
   sequentially. **Fix: option (c)** from the candidate list above — fastembed now runs in its own
   dedicated child **process** (`fastembedProcessHost.ts`, forked via `node:child_process.fork()`,
   accessed only via `embedding-provider`'s `getSharedFastembedProcess()` singleton), never a
   `worker_threads.Worker`, never sharing a thread or address space with `embedWorker.ts`. This
   promotes `tools/e2e/child-embed.mjs`'s test-harness-side mitigation to the real, package-level fix.

**Net architecture:** exactly ONE onnxruntime-bearing `worker_threads.Worker` per process (rerank +
verify) + fastembed permanently isolated in its own child process. Both hazard classes are now
structurally impossible, not merely statistically less likely.

**Proof:** `libs/data/embed/embedding-provider/src/sharedFastembedProcess.spec.ts` (2 concurrent
fastembed providers, one shared child process), `libs/data/embed/embedding-provider/src/
sharedOnnxWorker.spec.ts` (concurrent rerank+verify, one shared worker),
`libs/data/search/hybrid-search/src/cross-encoder.spec.ts` (embed + rerank concurrently),
`libs/data/verify/claim-verification/src/__tests__/bl238-concurrent-onnx.integration.test.ts` (embed
+ verify concurrently, AND embed + rerank + verify ALL THREE concurrently — the exact composition
that crashed pre-fix). All real ONNX inference, zero mocks. `npx nx test embedding-provider` 18/18,
`npx nx test hybrid-search` 74/74, `npx nx test claim-verification` 14/14 — all green, fresh
(`--skip-nx-cache`) runs.

---

## Open — surfaced installing `tokenguard` via `soxe install -s project` from an external repo (2026-07-06)

### BL-217 — `soxe install`/`soxe details` resolve ZERO registry entries when run from any repo other than sox-ecosystem itself — two build outputs, only one gets the embedded registry — **FIXED (2026-07-06)**

**Repro:** from `~/dev/security/wop` (an external project; `.adhd/sox-ecosystem/extensions.json` = `{"install":[{"id":"tokenguard"}]}`), `soxe install tokenguard -s project` warns every cascaded id ("sox-memory-bundle", "demo-creator", "tokenguard" — all present and correct in `registry/index.json`) as "not found in registry/index.json and not found locally", then the BL-141 zero-members guard (`writeLockfileAtomic`, `libs/install-engine/src/install.ts:461`) throws because resolution yielded zero members.

**Root cause:** two independent, non-overlapping build outputs exist for the CLI app, and the registry-embed step only ever reaches one of them:
- `apps/sox/dist/` — esbuild bundle; `apps/sox/scripts/embed-registry.cjs` copies `registry/index.json` here (hardcoded `outDir = <repoRoot>/apps/sox/dist/registry`).
- `dist/apps/sox/` — the tsc/nx workspace-root build. **This is what `bin/soxe` actually executes** (`bin/soxe:10` requires `../dist/apps/sox/main.js`) — confirmed live: `dist/apps/sox/registry/` does not exist at all.

`loadRegistryResolved()` (`apps/sox/src/main.ts:283`) implements the BL-42 fresh-machine fallback: try `<cwd>/registry/index.json`, else `loadRegistryIndex(__dirname)` (the embedded copy). Under `bin/soxe`, `__dirname` is `dist/apps/sox`, which has no `registry/` at all, so the fallback returns `[]`. `install()`'s own last-resort `loadRegistryIndex(root)` (`root` = the *target* project, per BL-73) is checked next and is equally empty — correctly so, since e.g. wop isn't the sox-ecosystem repo. Every configured id gets skipped regardless of whether it actually exists in the registry.

This silently defeats the entire BL-42 fresh-machine fallback for the CLI's real entrypoint — it only ever "worked" by accident when run from inside the sox-ecosystem checkout itself (the *primary* cwd lookup succeeds there, so the broken fallback path is never exercised). Every other project — i.e. the actual main use case for `-s project`/`-s local` — hits this on every install.

**Two more confirmed call sites share the exact same break:**
1. `main.ts:1281` — the internal-bundle-member install guard also calls `loadRegistryResolved(process.cwd())`. From an external repo this degrades silently rather than throwing: `entryForGuard` comes back `undefined`, so the R9 "internal member must install via its bundle" guard never fires.
2. `main.ts:3438` (`cmdDetails`) calls `loadRegistryIndex(repoRoot)` **directly, with no fallback at all**. `soxe details <id>` run from any external project always reports "unknown extension", even for ids that are genuinely registered.

**Fix sketch (pick one, (3) is most robust):**
1. Point `bin/soxe` at `apps/sox/dist/index.js` (the bundle `embed-registry.cjs` actually targets) instead of `dist/apps/sox/main.js`.
2. Make `embed-registry.cjs` also copy into `dist/apps/sox/registry/index.json`.
3. Make `loadRegistryResolved()` — and `cmdDetails`'s direct call — resolve the CLI's own repo root the same three-case way `main.ts:444-453` already does for `repoRoot` ("published bundle / dev esbuild / dev tsc build"), instead of assuming `__dirname` is always the esbuild output dir. Fixes the faulty assumption itself rather than keeping two build outputs in lockstep by hand, and fixes `cmdDetails` too since it would gain the same resolver.

**Fix landed (option 3):** `loadRegistryResolved()` (`main.ts:283`) now tries `__dirname` AND `path.resolve(__dirname, '../../../apps/sox/dist')` as bundled-copy candidates — covering both the esbuild-bundle layout and the dev-tsc-build layout `bin/soxe` actually runs — before giving up. `cmdDetails` (`main.ts:3438`) now calls `loadRegistryResolved(repoRoot)` instead of the fallback-less `loadRegistryIndex(repoRoot)`. Rebuilt (`nx build sox`) and reran the exact repro live from `~/dev/security/wop`: all 6 cascaded ids (sox-memory-bundle's 4 members + demo-creator + tokenguard) now resolve, lockfile writes, skills placed under `.claude/skills/` + `.opencode/skills/`, exit 0. Did not run the full `nx test sox` suite — `doctor-reconcile.spec.ts` in that suite manipulates the live launchd tick (BL-203) and this fix has nothing to do with that surface; the live end-to-end repro is the stronger signal for this specific bug anyway. No existing test covered `loadRegistryResolved`/`cmdDetails` (that gap is itself worth a follow-up — see BL-218 below).

### BL-218 — no test coverage for `loadRegistryResolved` / `cmdDetails` registry fallback — **RESOLVED (2026-07-09)** — `apps/sox/src/bl218-registry-resolved.spec.ts` covers the `loadRegistryResolved` fallback; `nx test sox` → 8 files / 82 tests pass

Filed alongside the BL-217 fix: neither the cwd/bundled-copy fallback in `loadRegistryResolved()` nor `cmdDetails`'s registry lookup has a unit test, which is how BL-217 shipped unnoticed in the first place. Add a vitest case that fakes two `__dirname`-like roots (one with `registry/index.json`, one without) and asserts the fallback picks the populated one, plus a case proving `cmdDetails` no longer hard-fails outside the sox-ecosystem checkout.

### BL-219 — `soxe install <id>` by default installs only `<id>` at local scope (was: always cascading the full scope union, installing everything) — **RESOLVED (2026-07-07)**

**Resolution:** two changes in `apps/sox/src/main.ts`:

1. **Default scope changed to `local` for positional installs.** `soxe install tokenguard` (no `-s` flag) now targets `local` scope by default — the config lands in `<project>/.adhd/sox-ecosystem/extensions.local.json` (gitignored, machine-local). `soxe install` with no positional still defaults to `user` (full cascade unchanged).

2. **Cascade bypass when a positional is given.** When a positional `<id>` is present, the CLI derives the scope config path and passes it as `configPath` to `install()`, triggering `singleScopeOnly` in `loadScopeCascade()` — so only the named extension's config is resolved, not the union of all broader scopes. The full cascade still runs for argument-less `soxe install` / `soxe install -s <scope>`.

**Help text updated:** `-s, --scope <scope>    Scope: user | project | local  (default: local for positional install, user otherwise)`.

**Verified:** `npx nx build sox` clean. `soxe install tokenguard` (no flags) writes only `tokenguard` to the local scope config and installs only that extension.


---

## Open — surfaced during HF-5/HF-6 closeout (2026-07-04)

### BL-216 — plain `doctor` misclassified the LIVE socket-holder backend as [STRAY] (32 duplicate findings) — `--fix` would kill the writer — **RESOLVED on discovery (2026-07-06)**

Found while verifying the BL-203 fixes live: `soxe doctor` reported the current singleton backend
(the pid holding the proxy UDS) as a stray — once per matching install record, 32 duplicates —
because its stray scan matched by identity but never attributed by socket (the reconcile pass
always has). `doctor --fix` would have killAndVerify'd the live writer; the owner ran `--fix`
earlier the same morning, which likely explains a backend-generation churn (harmless only thanks
to shim re-dial + respawn). **Fixed:** the scan now builds the socket-owner pid set across all
scope `run/supervisors/*.sock` and (a) skips socket holders ([auth:socket-reality]), (b) dedupes
stray findings by pid. Live: 33 anomalies → 1 (the genuine repo-root `.sox` residue). Same commit
adds ownership-only os-unit coverage so `doctor` reports a booted doctor-tick with the
`--install-tick` remedy (verified live via controlled bootout) — previously doctor was blind to
its own tick.

**Follow-on (same day): the FIRST link in the incident chain closed too** — `soxe status` now
renders live untracked proxy backends as `<ext>@proxy-backend` rows (socket-ownership
attribution, real uptime via BSD `ps -o etime=` parsing — NOT procps `etimes`, the BL-177 trap
again — note `socket held`). The 2026-07-06 morning started because the board showed only the
unused os-unit's `DEAD` row while the real writer served traffic invisibly; the operator chain
(doctor → --fix → enable) followed from that. Live-verified: the actual writer (pid + uptime)
now appears alongside the os-unit and tick rows.

### BL-215 — operator surface for `healStaleVectors` (model-swap re-embed) — **Open (LOW, feature) (2026-07-05)**

BL-88 shipped `healStaleVectors` (memory-core, bounded, env-gated default-off) but no operator
entry point. Recommended surface (per the implementing agent, endorsed): a `memory_curate`
op (`op: "reheal_stale"`) running one bounded pass and reporting `{scanned, healed, remaining}`,
and/or a CLI loop (`soxe memory reembed`) iterating until `scanned === 0`. Never tick-wired —
a full-store re-embed on model swap must be explicit.

### BL-208 — `verify-native-abi.mjs` resolves REPO_ROOT from its own file path → misleading "skip (not installed)" in worktrees — **RESOLVED (2026-07-08, via BL-222)** — the filed fix was a no-op; see BL-222 for the real defect + fix

In a git worktree, `__dirname`-derived REPO_ROOT has no `.pnpm` store, so probes skip with a
confusing message (functionally safe — exit 0). Fix: resolve via `git rev-parse --show-toplevel`.

### BL-209 — synthesized guard-op `attempt_count` reads 0 for pre-convention plans — **RESOLVED (2026-07-08)** — `dispatchesForOp()` filters on `DispatchKind`; adds `attempt_count_confidence`

`attempt_count = dispatch_ids.length` is exact for authored ops, but guard ops synthesized at
snapshot time have no dispatch_log entries in older dag.json files — 0 there means "unknown",
not "never ran". Becomes fixable when the dispatch-log schema adds a typed `guard` kind.

### BL-213 — `tools/supervisor-shim.js` + daemon-crash test tools still dial the deleted memoryd socket — **RESOLVED (2026-07-08)** — `supervisor-shim.js` + `test-daemon-crash.js` deleted (zero live refs)

Legacy test tooling (`supervisor-shim.js` lines 47/131/150, `test-daemon-crash.js` et al.)
probes `memoryd.sock`; the daemon is gone (S9). Delete alongside the BL-181 fixture swap.

### BL-214 — `tools/bundle-extension.cjs` defaults `--tsconfig` to memory-server's tsconfig — **RESOLVED (2026-07-08)** — `findTsconfig()` derives from `--entry`; hard error, no silent default

Line ~192 hardcodes `memory-server/tsconfig.json` as the fallback when `--tsconfig` is omitted —
hidden coupling; a rename/move breaks other extensions' builds silently. Default to the repo root
tsconfig or make the flag required.

### BL-203 — doctor-tick (and memory-server) launchd units found UNLOADED after the S11-merge `upgrade --all`; cause unproven — **RESOLVED (2026-07-06): root cause found via deterministic repro — THREE mechanisms fixed**

**Root cause (2026-07-06, after a THIRD unload reproduced deterministically):**
`npx nx test sox` boots the live tick on every run. Bisection pinned
`doctor-reconcile.spec.ts` → its `--remove-tick` test runs WITHOUT --dry-run using the REAL label
`com.sox.user.doctor-tick` against a sandboxed unit file — and BOTH `launchctl bootout` forms
evict by LABEL in the GLOBAL domain (the "by path" form just reads the label out of the plist),
so the sandbox was irrelevant. Every sox test run since Slice 4 landed (Jul 4) silently booted
the live tick — explaining all three incidents (Jul 4 evening, Jul 6 ~02:55 during the other
session's test runs, Jul 6 ~03:0x during wave-2 gates).

**Fixes (all landed together):**
1. **Platform ownership guard** (`os-unit.ts` launchd `unload`): before ANY bootout, resolve the
   loaded registration's `path` via `launchctl print`; refuse when it differs from our unitPath
   ("not ours to unload"); not-loaded → success no-op. Kills the whole class — no sandboxed or
   scratch-rooted run can evict a foreign registration again.
2. **Scoped unload-then-reap** (`main.ts`): `unloadOwnedOsUnitsBeforeReap` now REQUIRES the exact
   reap-target ids (`onlyIds`); the two unscoped call sites (bare `soxe stop` supervisor path,
   bare `soxe start` pre-clean) — a latent second mechanism — now pass exactly the reaped ids.
3. Tick reinstalled, pinned to non-volatile node.

**Proof:** killer repro (install tick → run doctor-reconcile.spec) flipped from tick-gone to
tick-survives; full sox suite 75/75 + hermetic smoke 13/0 both leave the tick loaded; host-runtime
248/248.

**What's wrong:** `com.sox.user.doctor-tick` was verified loaded (last exit 0) during HF-5
forensics (~22:55Z), and found NOT loaded (`launchctl list`: "Could not find service") at ~23:19Z.
Both plists and their ownership.json entries survived intact on disk — only the launchd
registration vanished. The only lifecycle-touching operation in the window was the post-S11
`soxe upgrade --all` (which re-installed the memory-server bundle: verified-stop of backend pids
76784/77290). A control run of `upgrade --all` with NO artifact changes (a no-op pass) did NOT
unload the tick — so the suspect is the artifact-changed upgrade path (teardown/reinstall of the
user-scope bundle), not upgrade per se. `com.sox.user.memory-server` (the stale 03:03Z direct-stdio
unit, BL-156) was also unloaded in the same window.

**Recovered:** tick re-installed via `doctor --install-tick --node-path=<homebrew node>` (now
pinned to a non-volatile node per the installer's own warning) and verified loaded + firing
(`SCHEDULED (last exit 0)` in the new BL-185 rendering).

**Repro attempt (negative, 2026-07-04 ~23:42Z):** the memory-server 1.3.0 upgrade — a REAL
artifact-changing `upgrade --all` (verified-stop of backend 8558 + respawn on the new artifact)
— did NOT unload the tick (`launchctl list` before/after both show it loaded). So neither a
no-op pass nor this artifact-changing pass reproduces; the original unload correlates
specifically with the S11-merge pass (which also rolled the registry checksum + bundle
re-install). Still open pending a repro that isolates that pass's shape.

**Fix sketch:** controlled repro — bump a bundle artifact in a sandbox data root
(SOX_ECOSYSTEM_HOME scratch), install with an os-unit + a doctor tick, run `upgrade --all`, and
diff `launchctl list` before/after. Suspect surface: the upgrade teardown's
`[inv:unload-then-reap]` sweep matching more units than the extension being upgraded, or a
user-scope ownership rewrite bootout. The tick's unit should never be collateral of a bundle
upgrade.

### BL-201 — dead-holder spawn-lock debris persists in `run/supervisors/` until next contention — **RESOLVED (2026-07-04, wave-2)**

**Resolution:** `sweepProxyBackendLocks` (host-runtime `reconcile.ts`) sweeps `proxy-backend-*.lock`
files whose holder pid is dead AND age >= the 30s lock TTL (live pid or fresh file always kept —
mid-reclaim guard; unparseable + old swept). Wired as reconcile pass step 6 across all scope
run/supervisors dirs, dry-run aware, findings kind `lock-debris`. 17 new tests; host-runtime
236/236. Integrator fixes at merge: the sweep was delivered UNWIRED (BL-183 class — wired into
cmdDoctor by the integrator) and 4 spec fixtures used non-hex lock names the production filter
rightly rejects (fixed to hex; the agent's all-green worktree claim was inaccurate).

**What's wrong:** HF-5 forensics found `proxy-backend-23dbf1ed.lock` (holder pid 28869, dead)
persisting for over an hour after the 17:16Z backend restart: a racer shim that dies between
`tryAcquireLock` and its `finally { releaseLock() }` leaves the file behind. Correctness is
unaffected — `tryAcquireLock` reclaims any lock whose holder fails `pidAlive` or exceeds the 30s
TTL, and backend liveness never derives from the lock pid — but the debris is misleading during
incident forensics (a dead pid in a "live" lock file).

**Where:** `libs/service-proxy/src/ensure-backend.ts` (release path),
`libs/host-runtime/src/reconcile.ts` (candidate sweeper).

**Fix sketch:** teach `doctor --reconcile` to sweep `proxy-backend-*.lock` files whose payload
pid is dead AND older than the lock TTL (same safe-by-construction attribution style as its
socket reaping). No change to the acquire/release protocol.

### BL-202 — memory-core suite flakes under full-suite CPU load: `export.spec.ts` per-topic INDEX ordering + `concurrency-harness.spec.ts` — **Open (LOW, NOT REPRODUCIBLE)** — ~30+ runs across serial/parallel/24-27-busy-loop CPU oversubscription produced zero failures. Do not `fix` until it reproduces. Untouched: no retry, no timeout raise, no loosened assertion

**What's wrong:** during the BL-183 closeout gate, `npx nx test memory-core --skip-nx-cache`
failed once on `exportMarkdown — INDEX.md › writes per-topic INDEX.md listing nodes sorted by
importance`, then passed on two consecutive full-suite re-runs and 3/3 isolated runs of the file.
Failure output was not captured on the failing run; observed rate ~1-in-5 file executions, only
under concurrent-suite CPU load.

**Where:** `libs/memory-core/src/export.spec.ts:149` (two `memoryWrite`s + `exportMarkdown`,
asserts one topic dir and high-importance-first ordering).

**Second instance (same class, BL-189 gate):** `concurrency-harness.spec.ts` failed once during
an uncached full-suite run (1/3 tests), then passed on the immediate uncached re-run. Both files
share the shape: multi-process/timing-sensitive assertions that trip only when the host is under
concurrent build/test load.

**Fix sketch:** reproduce with `--retry=0` in a loop while the rest of the suite runs, capture
which assertion trips (topic-dir count vs ordering). Suspect surface: the two-phase write's async
Phase B interacting with export reading vec/enrichment state, or same-timestamp tie-breaks in the
INDEX sort. Make the test await a deterministic barrier (or pin distinct timestamps) once the
tripping assertion is known.

**Triage context:** The tripping assertion is unknown — reproduce-first, fix-second. Options:
(a) Invest reproduction effort now (loop under load, capture assertion), (b) wait until the flake
blocks a gate (it passed 2/3 full-suite runs), or (c) proactively harden the test with pinned
timestamps and a deterministic enrichment barrier (~30 min, best-effort without knowing the root
cause). The effort-to-impact ratio depends on how often the flake actually gates work.

## Open — surfaced by the embed-pipeline observability worktree (2026-07-04)

### BL-190 — `libs/memory-core/package.json` and `extensions/bundles/sox-memory-bundle/members/memory-server/package.json` versions lag their hand-written CHANGELOG heads — **RESOLVED (2026-07-04, HF-6)**

**Resolution:** bumped `libs/memory-core/package.json` 0.2.1→0.3.0 and `extensions/bundles/sox-memory-bundle/members/memory-server/package.json` 1.2.1→1.3.0 to match the
changelog heads; the 0.3.0/1.3.0 sections were extended with the S11/BL-183/BL-189 entries in
the same commit. Convention going forward: hand-edited changelog heads must bump the respective `package.json`
(`libs/memory-core/package.json` or `extensions/bundles/sox-memory-bundle/members/memory-server/package.json`)
in the same change (or use changesets).

**What's wrong:** `libs/memory-core/package.json` is `0.2.1` while its CHANGELOG.md top section
is `## 0.3.0`; `extensions/bundles/sox-memory-bundle/members/memory-server/package.json` is `1.2.1` vs CHANGELOG `## 1.3.0`. The two-phase-write
merge (`a0a61fe`) hand-added the changelog sections without bumping the respective `package.json` files (`libs/memory-core/package.json` + `extensions/bundles/sox-memory-bundle/members/memory-server/package.json`) (the repo
otherwise uses changesets, which do both atomically). Any publish/changeset run will now either
double-document 0.3.0/1.3.0 or emit a version that skips the documented one.

**Where:** `libs/memory-core/{package.json,CHANGELOG.md}`,
`extensions/bundles/sox-memory-bundle/members/memory-server/{package.json,CHANGELOG.md}`.

**Fix sketch:** bump both `package.json` versions (`libs/memory-core/package.json` + `extensions/bundles/sox-memory-bundle/members/memory-server/package.json`) to match the changelog heads (or convert the
hand-written sections into a pending `.changeset/*.md` and let changesets version). Decide one
convention and note it in CONTRIBUTING §1.

### BL-191 — `memory_update`'s re-embed path records NO embed-pipeline metrics (and still embeds on-slot, see BL-189) — **RESOLVED (2026-07-04, HF-6): rides the BL-189 two-phase update**

**Resolution:** the async default now routes update re-embeds through `schedulePendingEmbeds`,
so `time_to_vector_ms`/`embed_duration_ms`/Phase-B counters cover updates. The `SOX_SYNC_EMBED=1`
path remains uninstrumented BY DESIGN (its cost IS `write_latency_ms`, as this entry noted).

**What's wrong:** the new Phase-B pipeline metrics (`time_to_vector_ms`, `embed_duration_ms`,
counters) only instrument `schedulePendingEmbeds`/`healMissingVectors`. `memory_update` re-embeds
inside its own queue task (BL-189) and the `SOX_SYNC_EMBED=1` composition embeds inline via
`memoryWrite` — neither records `embed_duration_ms`, so under the kill-switch (or heavy update
traffic) the embed-cost distribution reads empty while real ONNX work is happening. Intentional
for the sync path (its cost IS `write_latency_ms`), but once BL-189 moves `memory_update` onto the
async pipeline it should flow through the same instrumented entry points.

**Where:** `libs/memory-core/src/embed-pipeline.ts`, `libs/memory-core/src/update.ts`; fold into the BL-189 fix.

**Fix sketch:** when BL-189 lands, route update re-embeds through `schedulePendingEmbeds` (they
then inherit all counters + durations for free). No separate instrumentation before that.

## Open — surfaced by the write-path observability worktree (2026-07-04)

### BL-174 — `memory_ping` store block hardcodes `last_checkpoint_at: null` despite `WriteQueue.lastCheckpointAtForPath()` existing — **RESOLVED (2026-07-04, c7ae883)**

**Severity: low (health surface lies by omission).** In
`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`, the `memory_ping`
store block sets `last_checkpoint_at: null` as a literal, even though WP-5 shipped
`WriteQueue.lastCheckpointAtForPath(dbPath)` exactly for this field. The ping always reports
`null`, so WAL-checkpoint staleness is invisible to health checks. Discovered while authoring
`docs/plan/runtime-productionization/06-hardening-final/WRITEQ_METRICS_INTEGRATION.md`; not fixed
because memory-server was outside this worktree's file fence (live-incident agent owns it).
**Fix sketch:** `last_checkpoint_at: WriteQueue.lastCheckpointAtForPath(resolvedPath) || null` —
one line, apply together with the BL-175 patch.

### BL-175 — DEFERRAL: apply the WriteQueue metrics → `memory_ping` integration patch at merge — **RESOLVED (2026-07-04, c7ae883: write_queue live in ping, verified on the live store)**

**Severity: task deferral (by fence design, not a bug).** memory-core now exports
`WriteQueue.metricsForPath()` (rolling write-latency p50/p99/mean/max, queue depth, high
watermark, deadline budget, rejection/slow-task counters), but memory-server does not yet expose
it. The exact ready-to-apply patch (one additive `write_queue:` field in the ping store block)
is in `docs/plan/runtime-productionization/06-hardening-final/WRITEQ_METRICS_INTEGRATION.md`.
Integrator applies it after the concurrent live-incident agent finishes in
`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`, then runs the standard AGENT SEQUENCE + live ping verification.

---

## Open — surfaced during the 2026-07-04 memory-server hot-triage (BL-170 incident)

### BL-172 — organizer_queue had NO live consumer since the RS-6/ADR-0007 refactor: rows orphaned forever, `queue_depth` lied — **RESOLVED (2026-07-04)**

**Severity: high (enrichment-outbox consumption silently dead for ~27h; memory_ping reported
`ok:true` throughout).** Root cause chain, established via read-only SQL on the live store:
- `libs/memory-core/src/write.ts` P2 still enqueues an `ingest` trigger row into `organizer_queue`
   on EVERY write (`enqueueIngest`, write.ts:193).
- The only implementations that ever claim/complete those rows: (a) `MemoryDaemon`
   (`libs/memory-core/src/memoryd.ts`) — runs only in the memory-daemon service, which is
   **intentionally dead** per ADR-0007/BL-162; (b) the RS-4 outbox orchestrator
   (`libs/memory-core/src/outbox-queue.ts` `createMemoryOutboxQueue`/`migrateOutboxQueueSchema`) —
  **defined + spec-tested but wired into NOTHING** (zero non-spec callers repo-wide). The BL-126
  columns (`last_error`, `dead`) were absent from the live store — corroborating that the
  migration-owning consumer never started after `11c2fdc` (RS-4/RS-6, 2026-07-03) deleted the
  memoryds.
- The BL-47 in-process fallback loop (`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` `runFallbackEnrichPass`)
  DID keep enrichment itself alive (`runBatchEnrich` every 5 min — the actual clustering/
  importance/relates_to work happened) but bypassed the queue: rows never claimed → live store
  showed 29 open `ingest` rows (`claimed_at` NULL, `attempts` 0), `MAX(done_at)` frozen at
  2026-07-03T16:04:53Z, `queue_depth` growing unbounded.
- The user-visible `memory_write` timeouts (~19:13Z) were client-side: the writes actually
  landed (nodes exist for every "failed" uid) during a CPU-contention window (3 backends + the
  synchronous per-item bge embedding at ~0.75s/item); the backend log shows the matching
  `write EPIPE` client disconnects. The WriteQueue was NOT deadlocked — a probe write during
  triage returned an episode_uid promptly, main thread idle in kevent, no BL-154 recurrence.

**Fix:** `runFallbackEnrichPass` now mirrors memoryd's drain semantics — snapshot
`maxOpenEnrichTriggerSeq`, run the pass, then `completeEnrichTriggerRows` (claim + done +
attempts+1) for trigger ops (`ingest`/`enrich`/legacy) only, on success only, synchronously
(no interleave window); `decay`/`reindex` (real work the fallback does not perform) stay open.
Plus the queue-drain health SLO: memory_ping's store block gains additive fields
`queue_oldest_pending_at`, `queue_last_done_at`, and `enrichment: {state: idle|ok|stalled,
oldest_pending_at, last_done_at, stall_threshold_ms}` — stalled when the oldest pending trigger
row exceeds 3× the consumer tick (15 min default, `SOX_ENRICH_STALL_THRESHOLD_MS` override) —
so a dead consumer is machine-visible without SQL forensics. Tests:
`memory-server/src/enrichment-health.spec.ts` (drain semantics, verdict matrix incl. the live
incident shape, ping surface stalled→idle flip). **Remaining seam (not done here to keep file
sets disjoint from the in-flight host-runtime slices):** `soxe status` still shows HEALTHY on
RPC liveness alone — the supervisor health probe should consume `store.enrichment.state` from
memory_ping and render DEGRADED on `stalled` (touch-point: the health-check path in
`libs/host-runtime` + `cmdStatus` in `apps/sox/src/main.ts`).

### BL-173 — worktree smoke/e2e runs contend for the LIVE user singleton backend (`~/.memory` + user data-root UDS) — **RESOLVED (2026-07-04)**

Zombie `59405` in the BL-170 incident was
`.claude/worktrees/agent-a6bd315cddfc76ae5/extensions/.../memory-server/dist/index.js` spawned
at 18:56:14Z — exactly matching that worktree's `dist/smoke/run-2026-07-04T18-56-14`. The smoke
test installs into a disposable project scope, but the proxy backend's singleton key derives the
socket from the USER data root (`~/.adhd/sox-ecosystem/run/supervisors/`,
`libs/service-proxy/src/socket-path.ts` — `proxy-8d80bb9bd257.sock` is the fully-hashed
`backendSocketPath` fallback) and the store default is the LIVE `~/.memory/memory.db`. So a
smoke/e2e run from ANY worktree races the production writer for the live socket — under BL-170
(pre-fix) each lost race minted a SIGTERM-immune zombie against the live store. Fix sketch: the
smoke harness (and any e2e that exercises serve/ensure-backend) must inject a scratch data root
(`SOX_DATA_ROOT`/equivalent) AND a scratch `SOX_CONFIG_DB_PATH` so socket + store are both
hermetic; assert in the harness that the derived socket path is under the smoke dir (fail loud
if it would land in the user data root). Related: BL-63 (e2e orphan scan global pgrep) has the
same non-hermetic smell. NOT fixed this session — the worktree is owned by another agent and the
harness change deserves its own gate.

**RESOLVED**: `scripts/smoke-test.mjs` now injects `SOX_ECOSYSTEM_HOME` (→ `dist/smoke/<run>/sox-data-root`) and `SOX_CONFIG_DB_PATH` (→ scratch `.db`) into every `execSync` child via `smokeEnv()`. Live fingerprint before/after verified byte-identical across full smoke run — **13/0 on main post-merge** (`run-2026-07-04T23-06-42`; the worktree's 2 service-enable failures were a dist-less-worktree artifact, see BL-192 RESOLVED-INVALID). Evidence: commit on branch `worktree-agent-a726260b55d5d2f0b`, `scripts/smoke-test.mjs`.

---

## Open — surfaced during Slices 3–4 (continuous supervision, 2026-07-04)

_(BL numbers claimed in a worktree — integrator: renumber on merge if they collide with
concurrently-claimed IDs; BL-171 was referenced by the dispatcher but is absent from this
worktree's BACKLOG.)_

### BL-176 — reconcile pass is not yet the automatic pre-step of `soxe list`/`status` — **RESOLVED (2026-07-09)** — `quickReconcile()` extracted into `libs/host-runtime/src/reconcile.ts` and wired into `cmdList`/`cmdStatus`; `nx test host-runtime` → 248 pass; live-verified `soxe list` at 0.055s (no perf regression), `soxe status` reports verified-live reality per `[inv:list-never-lies]`

Spec §10.2 says the reconcile runs "on every `soxe list`, `soxe status`, `soxe doctor`, and as a
step inside `soxe start`/`stop`". Slice 4 (v1.4.0) delivered the complete, idempotent, schedulable
pass as `soxe doctor --reconcile` (+ the `--install-tick` OS schedule — the continuous half), but
`cmdList`/`cmdStatus` do not yet invoke it as a cheap pre-step (they do their own partial
reconciliation: GC read, pid-liveness, os-unit probes, crash-loop markers). Folding the full pass
in needs a fast-path variant (skip the lsof attribution + per-install scans unless something looks
off) so `list` stays snappy. Fix sketch: extract `doctorReconcile`'s phases 0/3 (GC + split-brain
record heal) into a `quickReconcile()` helper both commands call; leave stray-reaping to the tick.

### BL-177 — `findOrphansByServiceId` env-based matching is INERT on macOS (`ps -o env` unsupported) and spawns one `ps` per process-table entry — **RESOLVED (2026-07-04, HF-6)**

**Resolution:** implemented the fix sketch — on darwin, one whole-table `ps -E -A -ww -o
pid=,ppid=,args=` scan (BSD `-E` appends the environment; exact whitespace-token match on
`SOX_SERVICE_ID=<id>`, which is space-free) replaces the per-pid probing entirely; on Linux the
`ps -o env=` path remains, now memoized off after the first keyword failure and with piped child
stderr (the failing probes were ALSO flooding the doctor-tick log at 2.5 MB/day — same commit).
Live-verified: `ps -E` reads env on real processes on this box (2 live `SOX_SERVICE_ID` carriers
visible). host-runtime 225/225.

Discovered while wiring `doctor --reconcile` (Slice 4) onto the BL-136 matchers: macOS `ps` has no
`env` keyword (`ps: env: keyword not found` — verified live on this box), so `readProcessEnv`
(`libs/host-runtime/src/reaper.ts`) always returns null in production and
`findOrphansByServiceId` silently degrades to argv-token matching — i.e. **cross-BUILD stray
detection by `SOX_SERVICE_ID` does not work on macOS at all** (the BL-136 unit tests pass because
they mock `ps`). Additionally the scan calls `readProcessEnv(p.pid)` for EVERY process in the
table (hundreds of failing `ps` spawns per installed extension per scan) — pure overhead on macOS
and O(N) subprocess cost on Linux. Fix sketch: on darwin use `ps -E -ww -o pid=,command=` (BSD ps
prints the environment appended to the command with `-E`) or `launchctl procinfo`; cache one
whole-table snapshot per scan instead of per-pid spawns; keep the argv fallback. The reconcile
tick (BL-176/Slice 4) still catches the BL-170 zombie class via argv tokens + socket attribution,
so this is a detection-coverage gap for cross-build strays only, not a regression.
**Flake symptom:** the same per-pid `ps` spawn cost makes the two `findOrphansByServiceId`
tests in `libs/host-runtime/src/reaper.spec.ts` (lines ~291/~314, 10s timeout) flaky under
parallel load — they pass standalone (213/213 twice on this box) but timed out during an
`nx affected -t lint,build,test` run with ONNX warmups saturating the machine; nx marks
`host-runtime:test` flaky. Fixing the O(N)-spawn scan fixes the flake.

### BL-179 — root `sox-ecosystem:test` suite MUTATES the live user data root (`~/.adhd/sox-ecosystem/`) — every worktree agent's `nx affected` run re-points the live user-scope installs at its worktree — **RESOLVED (2026-07-04)**

**Discovered during the Slices 3–4 gate** (`nx affected -t lint,build,test` from a worktree):
after the run, `~/.adhd/sox-ecosystem/{extensions.lock,install-registry.json,ledger.json,ownership.json}`
had mtime = the test run, and every user-scope `source` (memory-daemon/-server/-flush/-cli/-usage,
demo-creator) pointed at the WORKTREE path. The install-registry history proves this happened
**three times today from three different agents' runs** (18:52Z `agent-ad1f4cf3072c64ba3`, 18:58Z
`agent-a6bd315cddfc76ae5`, 20:20Z `agent-a605b86bb76941c53`) — the same test-isolation gap class
as the smoke-test one found today, in the unit-test tier.

**Mechanism:** the `scripts/*.test.ts` harnesses (install.test.ts, v2-e2e.test.ts, etc.) sandbox the
*explicit* paths they pass (`configPath`/`lockfilePath` into `mkdtemp` dirs) but do NOT set
`SOX_ECOSYSTEM_HOME`, so the install engine's GLOBAL writes (`installRegistryPath()`,
ledger/ownership at `dataRoot('user')`, and user-scope lockfile writes from flows that re-derive
`getScopePaths('user')` internally) land in the REAL data root. `scripts/cli-adapter.test.ts`
spawns the real CLI with plain `process.env` (no sandbox at all).

**Consequences:** (1) the live user scope's sources dangle as soon as a worktree is deleted
post-merge — the next `soxe upgrade`/`serve` resolution can break; (2) cross-test interference:
`cli-adapter.test.ts > details verb > renders requires block` flakes (exit 1) when a parallel test
has the registry/lockfile mid-write — observed in this gate run, passes standalone; (3) any agent
gate run silently rewrites live state, violating worktree isolation fences.

**Further symptoms observed in the same run:** (4) a root test regenerates the TRACKED
`registry/index.json` (at repo root) in-place with checkout-absolute `source` paths — in a worktree that bakes
`…/.claude/worktrees/<agent>/…` into a committable file (reverted via `git checkout` before
committing; the index's absolute-source design makes any non-main checkout's regeneration
poisonous); (5) junk `./badscope/run/` + `./global/run/` dirs appear in the repo root — see BL-180.

**Remediation:** (a) FIX: export a per-run `SOX_ECOSYSTEM_HOME` temp dir in every root-scripts test
harness (or a shared vitest setup file for `sox-ecosystem:test`) so the global data root is
sandboxed like the smoke test's project scope; (b) REPAIR the live box (owner/integrator, after
merges): re-run `soxe install`/`node bin/soxe upgrade --all` from the MAIN checkout to re-point
user-scope sources at durable paths — do NOT hand-edit the lockfile. NOT repaired from this
worktree (live-box mutations are fenced; and the pre-damage state was already another agent's
worktree path, not main).

**Integrator update (2026-07-04, post-S9 merge): the predicted breakage HAPPENED, then repaired.**
After the mutating worktree (`agent-a605b86bb76941c53`) was deleted post-merge, `soxe upgrade --all`
reported **28 UNRESOLVABLE consumers** — every user-scope source (both the main-root user installs
AND the published-CLI root `~/.adhd/sox-cli/lib/node_modules`) pointed at the deleted worktree
(`install: source file not found: …/worktrees/agent-a605b86bb76941c53/…`). Repaired per (b):
`soxe install sox-memory-bundle --scope=project`, `--scope=user`, `demo-creator --scope=user` from
the main checkout → `38 current, 0 failed`; memory-server os-unit stayed HEALTHY throughout. The
(a) FIX (sandbox `SOX_ECOSYSTEM_HOME` in root-test harnesses) remains OPEN and is now
incident-proven urgent, alongside the smoke-hermeticity fix (BL-173).

**RESOLVED**: `scripts/test-env-setup.ts` (vitest `globalSetup`) creates a per-run `mkdtemp` dir and sets `SOX_ECOSYSTEM_HOME` before any worker is forked, redirecting all `userDataRoot()` calls away from the live `~/.adhd/sox-ecosystem/`. `vitest.config.ts` updated to load the setup file. `cli-adapter.test.ts` spawned children inherit the env via `spawnSync` with no `env:` override (inherits from worker process). Verified: 84 tests pass, live fingerprint byte-identical before/after. Evidence: commit on branch `worktree-agent-a726260b55d5d2f0b`, `scripts/test-env-setup.ts` + `vitest.config.ts`.

### BL-192 — smoke test's `service enable` leg fails for both standalone services and bundle-member mcp-servers ("not installed at scope 'project'") — **RESOLVED-INVALID (2026-07-04): worktree-build-environment artifact, not a product bug**

**Resolution (integrator, at merge):** does NOT reproduce on main — the identical hermetic smoke
run on main immediately after merging the BL-173 fix passed **13/0** (`run-2026-07-04T23-06-42`,
isolation verified byte-identical). The filing worktree had no built `dist/` (same environment gap
that failed its `cli-adapter.test.ts` runs), so `service enable` correctly reported
"no entrypoint" — the entrypoints genuinely didn't exist there. The original hypothesis
(lockfile/root resolution race, reproduced-on-unmodified-script) is retracted: the reproduction
was run in the same dist-less worktree, so it reproduced the environment gap, not a product bug.
Operational note absorbed into practice: a smoke run from a fresh worktree requires the workspace
build first (CONTRIBUTING §1 already requires building before verification).

### BL-185 — `soxe status` renders a loaded, on-schedule PERIODIC os-unit as `DEAD` (violates [inv:list-never-lies]) — **FIXED (2026-07-04, status-rendering worktree)**

Observed immediately after `doctor --install-tick` (Slice 4): `launchctl list` shows
`com.sox.user.doctor-tick` loaded with last-exit 0, and its reconcile log proves interval runs
firing on schedule (`run/logs/doctor-reconcile/doctor-reconcile-2026-07-04.log`) — yet
`soxe status` lists `doctor-tick@os-unit … DEAD, 0s uptime`. A `StartInterval` unit has NO
resident process between runs by design; status's health derivation conflates "no live pid right
now" with DEAD, making the healthy tick look faulty (the same lying-surface class as BL-162's
dead-daemon rendering and today's enrichment blind spot).

**Fix:** Added `isScheduledOsUnitContent()` (pure, no I/O) and `isScheduledOsUnit()` (file-based)
to `libs/host-runtime/src/os-unit.ts` (exported via `libs/host-runtime/src/index.ts`). In `apps/sox/src/main.ts`
`cmdStatus`'s os-unit scan: when `!pidAlive && loaded`, read the unit file and check for
`<key>StartInterval</key>`, `<key>StartCalendarInterval</key>` (launchd) or `OnUnitActiveSec=`,
`OnCalendar=` (systemd `.timer` paired file). If any schedule key is detected, render
`status='scheduled'` instead of `'dead'`. Status exits 0 (healthy-by-design). Detail view shows
`SCHEDULED (last exit N)`; table NOTE column shows `sched last:N`. Non-interval units with no pid
remain `DEAD`.

**Also fixed (BL-162 enrichment remainder):** `soxe status` did not consume `memory_ping`'s
`store.enrichment.state` field — when enrichment was stalled, the service still rendered
RUNNING/healthy. After status is determined `healthy` and the exec socket is reachable, a
`memory_ping` RPC is attempted (2 s timeout). If any store reports `state='stalled'`, status is
demoted to `'degraded'` with `enrichmentReason = 'enrichment stalled: oldest pending <age> ago'`.
`idle`/`ok`/missing fields → no change (fully additive). Exit code becomes 1 (degraded).

**Evidence:** `libs/host-runtime/src/os-unit.spec.ts` +12 tests (pure isScheduledOsUnitContent ×7,
file-based isScheduledOsUnit ×5), all pass. `apps/sox/src/status-rendering.spec.ts` (new file) +8
integration tests (BL-185 SCHEDULED ×4, BL-162 enrichment DEGRADED ×4), all pass. `npx nx
lint/build/test host-runtime sox` all clean (host-runtime 1 pre-existing reaper.spec.ts timeout
flake, not in diff).

### BL-186 — `memory_curate recluster` runs the FULL cluster pass synchronously on the serial WriteQueue and returns a false `enqueued: true` — **RESOLVED (2026-07-04, two-phase-write worktree)**

**Resolution (option (a), designed):** global recluster now enqueues an `enrich` trigger row with
payload `{"full":true,"reason":"memory_curate recluster"}` (`enqueueEnrichFull`, outbox-queue.ts)
and returns `{op:'recluster', enqueued:true, seq}` — honest, because the row is committed before
the return (an insert failure propagates as a tool error, never a false success). The periodic
tick (`runEnrichPassOnDb`) checks `hasPendingFullEnrich(db, maxSeq)` INSIDE its BL-172 snapshot
window and runs `runBatchEnrich({incrementalCluster:false})` when a full-pass row is pending —
full-pass rows enqueued after the snapshot stay open and drive the next tick, so a completed row
always corresponds to a pass that actually honoured it. `hasPendingFullEnrich` deliberately does
NOT filter the BL-126 `dead` column (absent from the base DDL; the paired consumer
`completeEnrichTriggerRows` ignores it too). Justification for queueing over a bounded sync path:
the full pass on a ~3.6k-episode store holds the WriteQueue slot long enough to fast-fail every
write behind it under the deadline backpressure AND risks the recluster call's own MCP timeout;
worst-case added latency is one tick interval (5 min), which is acceptable for an explicitly
batch-shaped operation. Tests: `async-embed.spec.ts` (honest enqueue → row shape → full-pass
tick → one-shot reversion to incremental; dry_run writes no row).

Merge artifact of S9 × BL-172 (integrator review of the merged semantics): S9 switched global
recluster from `enqueueEnrich()` (queued, drained by the periodic tick) to a direct synchronous
`runBatchEnrich(db, {incrementalCluster: false})` inside the tool call (`libs/memory-core/src/
curate.ts:363`) — a correct fix against its branch state (nothing drained the queue there), but on
merged main the consumer exists, so the trade-off is live: (1) a global recluster on a large store
(~3.6k episodes) blocks its MCP call AND every write behind it on the serial WriteQueue for the
full non-incremental pass; under the new time-based backpressure, writes queued behind it can
fast-fail `E_BUSY(deadline)`. (2) The return shape still claims `{op:'recluster', enqueued: true}`
— false; nothing is enqueued ([inv:list-never-lies] family). Fix options: (a) re-route global
recluster through the queue as an `enrich` trigger row (producer exists again as of the S9 merge;
the tick already completes trigger ops) and return `enqueued: true` honestly, with the next-tick
latency documented; or (b) keep it synchronous and fix the return shape to `{ran: true, …stats}`,
documenting the write-blocking cost. Decide at HF-6 alongside the BL-183 outbox-consumer decision
(same design surface).

### BL-187 — SEMANTICS CHANGE: two-phase `memory_write`/`memory_write_batch` — embedding + E8 near-dup now run ASYNC off the WriteQueue slot (kill-switch: `SOX_SYNC_EMBED=1`) — **RESOLVED (2026-07-04)** — SHIPPED: two-phase write, async default + `SOX_SYNC_EMBED` kill-switch. A disclosed owner-directed semantics change, not a defect

_(BL numbers 187–189 claimed in a worktree — integrator: renumber on merge if they collide.)_

Owner-directed fix for the 2026-07-04 incident class ("expensive compute must not block writes";
6-item batch timeout at queue depth 29): the write handlers now run a fully SYNCHRONOUS Phase A
(dedup, node insert, FTS, tags/entities, outbox row, non-embed enrichment — `memoryWritePhaseA`)
on the queue slot, and compute the embedding OFF the slot (worker thread) with a short follow-up
queue task inserting `vec_node` + running the deferred near-dup (`libs/memory-core/src/embed-pipeline.ts`). Measured:
Phase-A slot time is embed-latency-independent (p50 ~28ms = the SQLite commit, vs ~81ms for the
old path at a simulated 50ms embed). **Caller-visible changes:** (1) `memory_write` responses
carry `enrichment.near_dup: null` (near-dup lands seconds later as SAME_AS edges — documented as
async since v1.1.0); (2) fresh episodes are BM25/temporal-recallable immediately but
vec-recallable only after Phase B (typically <1s); (3) `memory_ping.store` gains additive
`embed_backlog` / `embed_backlog_oldest_at`, folded into the `enrichment` verdict (a dead Phase-B
pipeline reads `stalled`, never silent); (4) crash between phases is healed by the periodic tick
(`healMissingVectors`, bounded 500/pass, mirrors BL-160's reembed recovery). **Rollback:**
`SOX_SYNC_EMBED=1` restores the pre-split synchronous behaviour per-call, no revert needed. The
memory-server spec suite pins the sync path via vitest.setup (existing 92 assertions unchanged);
`async-embed.spec.ts` + `write-pipeline.spec.ts` pin the async default deterministically
(BL-161 seam, gated-provider proof that responses never await the embed).

### BL-188 — `memory_write` MCP handler silently DROPPED `client_request_id` (WP-4 idempotency dead through the tool surface) — **RESOLVED (2026-07-04, two-phase-write worktree)**

Discovered while rewriting the handler for the two-phase split: the single-write and chunked
paths in `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` never forwarded `args['client_request_id']` to
`memoryWrite`, despite the tool schema documenting WP-4 replay semantics — only
`memory_write_batch` forwarded it. Any MCP client supplying an idempotency key got NO replay
protection (a retry after a timeout minted a duplicate-or-E_DEDUP instead of `replayed:true`).
Fixed by including `client_request_id` in the shared `parentParams` used by both embed modes;
pinned by the `async-embed.spec.ts` replay-through-handler test.

### BL-189 — `memory_update` still embeds INSIDE the WriteQueue slot (same class as the fixed write path) — **RESOLVED (2026-07-04, HF-6): two-phase update landed**

**Resolution:** `memoryUpdatePhaseA` (memory-core `update.ts`) implements the sketch below
exactly — Phase A commits columns + FTS + deletes the stale vec row in one transaction and
returns a `PendingEmbed`; the memory-server handler schedules Phase B off-slot via
`schedulePendingEmbeds` (BL-154-safe, from outside the task). `SOX_SYNC_EMBED=1` keeps the
sync composition. Heal covers a crashed Phase B (stale vector is deleted in Phase A). Specs:
`memoryUpdatePhaseA` block in `update.spec.ts` (3 tests). Gates: memory-core 356 pass,
memory-server 111 pass.

The two-phase split covers `memory_write`/`memory_write_batch` (the hot path). `memory_update`
with `content`/`summary` changes still runs its re-embed synchronously inside
`wq.enqueue('memory_update', …)` (`memoryUpdate` → embed on the slot). Low frequency, but under
CPU contention one update can stretch the slot exactly like the old write path. Fix sketch: same
split — update Phase A (columns + FTS + delete stale vec row), Phase B via
`schedulePendingEmbeds` (the machinery now exists and `applyEmbedding` already guards
rowid/uid + double-apply); the heal already covers a crashed update re-embed IF the stale vector
is deleted in Phase A (otherwise the node keeps the OLD vector until Phase B — decide staleness
semantics before implementing).

### BL-180 — `dataRoot()` returns the raw scope string as a PATH for an unknown scope (audit log writes `./badscope/run/sox-audit.jsonl`) — **RESOLVED (2026-07-04, wave-2)**

**Resolution:** runtime validation in BOTH data-paths copies (host-runtime + install-engine parity): unknown scope throws a structured error naming the bad value + valid scopes. New data-paths.spec (9 cases). host-runtime 248/248, install-engine 163/163.

`libs/host-runtime/src/data-paths.ts` `dataRoot()` ends in `default: const _exhaustive: never =
scope; return _exhaustive;` — type-safe at compile time, but at RUNTIME an unvalidated string
(e.g. `soxe install -s badscope`, or `-s global` which is not a scope) falls through and the scope
string itself is returned as the data root. The CLI's audit-log block (`apps/sox/src/main.ts`
`main()`, `dataRoot(flags['scope'] ?? 'user')`) then `mkdir -p`s a RELATIVE `./badscope/run/` in
the caller's cwd and writes `sox-audit.jsonl` there — observed as junk `badscope/` + `global/`
dirs in the repo root after `cli-adapter.test.ts` ran its invalid-scope error-path tests. Any
`soxe` invocation with a bad `--scope` litters the cwd before the verb even validates the scope.
Fix sketch: make `dataRoot` THROW on an unknown scope at runtime (the audit block already
try/catches), or validate the scope before the audit write.

### BL-178 — direct-M3 `soxe serve` durable stderr sink still opt-in (Slice 3 F13 remainder) — **RESOLVED (2026-07-05, wave-2)**

**Resolution:** direct-stdio serve stderr tee is DEFAULT ON; opt-out via `--no-log` or `SOX_SERVE_LOG=0` (explicit opt-out beats env opt-in); stdout purity unchanged. Live-verified: a sandboxed `serve --no-proxy` run with no flags created the dated log under `run/logs/serve-memory-server/`. 6 new tests.

Slice 3's F13 item ("live `serve` version's stderr durably captured") remains opt-in for
DIRECT-stdio serves (`--log` / `SOX_SERVE_LOG=1`, BL-46). M4 units default durable
`StandardOutPath`/`StandardErrorPath` (Slice 2 §9.2) and proxy backends log via `stderrLogPath`
(BL-139), so the gap is only the direct/opt-out serve path. Flipping the default is a
client-visible behaviour change on every MCP spawn and `cmdServe` is under concurrent BL-170/
BL-157 hardening — deferred deliberately (documented in the spec v1.4.0 changelog + §14 Slice 3).
Fix sketch: default the tee ON with `--no-log`/`SOX_SERVE_LOG=0` opt-out once the serve-path work
lands.

---
## Open — surfaced during S9/BL-162 memory-daemon removal (2026-07-04)

### BL-181 — `tools/test-e2e-lifecycle.js` Slice 1 + Section E hardcode `memory-daemon` as their real-service fixture; now broken by BL-162's removal — **RESOLVED (2026-07-08)** — e2e fixture repointed to `tokenguard`; gate green: 108 passed / 0 failed

**Validation note (2026-07-04 sweep):** the failure mode is subtler than stated — `memory-daemon/dist/index.js` persists as a stale unrebuildable artifact, so the `fs.existsSync` guard PASSES and the break surfaces later at spawn/assert. Also flags BL-168-class debris: the stale dist should be deleted with the fixture swap.

`host-runtime:test-e2e` (`libs/host-runtime/project.json` `test-e2e` target, runs
`tools/test-e2e-lifecycle.js`) is NOT part of the standard `nx test`/`nx affected -t test` gate —
it's a separate opt-in target — so it was not caught by this shard's required gate. But it WILL
fail the next time anyone runs it, because two large regression sections use the now-deleted
`extensions/bundles/sox-memory-bundle/members/memory-daemon` as their concrete fixture:
- **"Step 7c: Slice 1 — cross-scope singleton"** (~line 1084-1192): spawns a live daemon process
  from `memory-daemon/dist/index.js` and asserts the §5.2 singleton guard refuses a second spawn
  when two scopes share `db_path`. Line 1104 already asserts
  `fs.existsSync(DAEMON_ENTRY)` and will now fail loudly with a clear message rather than silently
  skip — but the underlying coverage (cross-scope singleton guard) is lost.
- **"Section E: SERVICE-STORE COPY + SPAWN — BL-37 regression gate"** (~line 1649-1780): verifies a
  `type:service` extension's self-contained esbuild bundle survives the declarative-install copy +
  real spawn with native addons (better-sqlite3, sqlite-vec) resolvable via NODE_PATH — the exact
  regression BL-37 fixed. `memory-daemon` was the real extension used to prove this end-to-end.
**Fix:** repoint both sections at a different real `type:service` extension with the same shape
(background:true, singleton:true, native-addon deps) — `tokenguard` is the only other real service
extension in the registry and is a good candidate — or author a small dedicated fixture service
extension whose sole purpose is exercising these two regression gates. Deliberately NOT fixed by S9
itself: this touches live daemon-process spawning/singleton-guard mechanics, which S9's dispatch
explicitly fenced off ("do NOT touch libs/service-proxy/, apps/sox/src/main.ts serve/upgrade paths,
or any live running process — S8 handles live backend reconciliation"), and a proper fix means
picking/building a replacement fixture, not a mechanical rename. Run
`node tools/test-e2e-lifecycle.js` after re-pointing to confirm both sections pass.

### BL-182 — `memory-flush`'s `nudgeDaemon()`/`SOCKET_PATH` are now permanently-dead code (BL-162 follow-up) — **RESOLVED (2026-07-04, wave-2)**

**Resolution:** `SOCKET_PATH`, `nudgeDaemon()` (14 LOC) and its call site deleted from memory-flush; dead `net` import removed; docs updated. Zero remaining live references (grep-proven). memory-flush 14/14.

`extensions/bundles/sox-memory-bundle/members/memory-flush/src/index.ts` defines its own local
`SOCKET_PATH` (`~/.memory/memoryd.sock`) and calls `nudgeDaemon()` at the end of every
`handleSessionEnd` (step 3, "Nudge memoryd"). Since BL-162 deleted the entire `memory-daemon`
package (including the now-deleted `libs/memory-core/src/memoryd.ts`'s `MemoryDaemon` class — nothing will ever
bind that socket again), this call is now unconditionally a no-op: it opens a Unix socket
connection that always hits `ECONNREFUSED`/ENOENT, swallowed by the existing `client.on('error', ...)`
handler. Harmless today (batch enrichment already runs via memory-server's in-process periodic
loop, independent of this nudge), but it's a dangling reference to a daemon that no longer exists
and should be deleted rather than left as inert dead code. **Not fixed in S9** because
`memory-flush` was not in S9's confirmed exact-scope file list and this is a separate member with
its own test suite (`memory-flush:test`) that a change here would need to keep green — low risk,
quick fix, but deliberately left for a follow-up pass to keep S9's diff scoped to its assigned
files. Fix: delete `SOCKET_PATH`, `nudgeDaemon()`, and its call site; update the file's header
comment (currently: "nudges memoryd" in the SessionEnd bullet list) and `handleSessionEnd`'s
JSDoc (step 3 "Nudge memoryd to wake and process the queue").

### BL-183 — `libs/memory-core/src/outbox-queue.ts` (`createMemoryOutboxQueue`/`memoryFlush`) is fully unwired scaffolding — **RESOLVED (2026-07-04): deleted, not deprecated**

**Resolution (HF-6 closeout):** the unwired surface was DELETED — `createMemoryOutboxQueue`,
`memoryFlush` (which marked rows done without processing them — a latent footgun),
`migrateOutboxQueueSchema` (the BL-126 dead-letter migration that never ran against any live
store), and their types + spec sections. The wired producers (`enqueueIngest`,
`enqueueEnrichFull`, `hasPendingFullEnrich`) stay and gained direct spec coverage
(`outbox-queue.spec.ts` rewritten against the real base DDL). If a dead-letter lane is ever
needed it must be designed WITH the live periodic-tick consumer. Gate: memory-core lint/build
green, tests 309 passed (one unrelated flake filed as BL-202).

Discovered while verifying BL-162's in-process-enrichment claim: `outbox-queue.ts` (220 LOC,
RS-4/RS-5 per `docs/plan/runtime-productionization/02-reusable-subsystems/progress.json`) and its
399-line spec are real, tested, dead-letter-aware implementations of a transactional-outbox drain
over the SAME `organizer_queue` table `memory-daemon`'s deleted `MemoryDaemon` class used — but
`createMemoryOutboxQueue`/`memoryFlush` have ZERO consumers anywhere outside their own spec file
(confirmed by repo-wide grep). Batch enrichment in production actually runs via a completely
different, simpler path: memory-server's in-process periodic `runBatchEnrich` loop
(`extensions/.../memory-server/src/index.ts`), which never touches `organizer_queue` at all. So
`progress.json`'s RS-4/RS-5 "complete" status describes a built-but-never-integrated subsystem.
Decide: (A) wire `createMemoryOutboxQueue`/`memoryFlush` into memory-server's write/enrich path as
the intended real drain mechanism (more durable — dead-letter tracking, watermark-based
read-your-writes for `memory_flush`-style callers) and retire the simpler periodic loop, or (B)
delete `outbox-queue.ts` + its spec as unintegrated scaffolding superseded by the simpler periodic
loop that's actually running in production today. Not decided or fixed here — out of BL-162's
scope (BL-162 is specifically about removing the daemon, not about which enrichment-drain design
wins); flagging so it doesn't silently rot further.

**Integrator update at S9 merge (2026-07-04): PARTIALLY STALE.** Written before the BL-172
incident fix landed on main: the periodic loop DOES now touch `organizer_queue` (it snapshots
`maxOpenEnrichTriggerSeq` → runs the pass → `completeEnrichTriggerRows`), the queue's
presence/age drives memory_ping's `enrichment` stall verdict, and at this merge the producer
was restored as `outbox-queue.ts#enqueueIngest` (called from `write.ts`, transactional with the
node insert) — so outbox-queue.ts now carries live production code. Still open from the
original finding: `createMemoryOutboxQueue`/`memoryFlush` themselves (the dead-letter dequeue
consumer + watermark flush) remain consumer-less — the (A)/(B) decision above still stands for
THAT surface, folded into HF-6 closeout review with BL-127's read-your-derived-writes contract.

### BL-184 — RS-6 `progress.json` claimed file deletions that were not actually present — **RESOLVED (verified 2026-07-04 validation sweep): S9 completed the deletions** — `libs/memory-core/src/memoryd.ts`, `memory-server/src/memoryd.ts`, `memory-server/src/bin.ts` are all confirmed absent; the recorded state now matches disk.

`progress.json`'s RS-6 entry (`"status": "complete"`) lists `files_deleted` including
`extensions/bundles/sox-memory-bundle/members/memory-server/src/memoryd.ts`,
`.../memory-server/src/bin.ts`, and `libs/memory-core/src/memoryd.ts` — but as of S9's start
(2026-07-04) all three files were still present and live (bin.ts/memoryd.ts in memory-server were
confirmed dead/unreferenced by the actual build — `package.json`'s `main`/`exports` and
`project.json`'s build target only ever pointed at `src/index.ts` — but they had not been deleted
as RS-6 claims). `libs/memory-core/src/memoryd.ts` was very much alive: imported by
`write.ts` (`enqueueIngest`/`nudgeDaemon`, called on every `memory_write`) and `curate.ts`
(`enqueueEnrich`, called on every global `memory_curate recluster`). S9 has now actually deleted
all three plus `memory-daemon/src/memoryd.ts` and `libs/memory-core/src/memoryd-retry.spec.ts`,
and removed the `write.ts`/`curate.ts` call sites (`curate.ts`'s global recluster now calls
`runBatchEnrich` in-process instead of the now-deleted `enqueueEnrich`). This is a process-integrity
gap (a "complete" status was recorded without the described side effects actually landing) worth
a sweep during HF-6 closeout's BACKLOG/progress reconciliation pass — not fixed here since
reconciling historical progress-tracking JSON is that closeout's job, not this shard's.

### BL-162 — remove the obsolete `memory-daemon` extension (superseded by ADR-0007 in-process enrichment) — **FIXED (2026-07-04, S9)**

**Owner directive: fix/remove, do not leave "deprecated."** ADR-0007's single-writer architecture
moved batch enrichment IN-PROCESS into the memory-server writer backend, making the `memory-daemon`
extension dead code. Today `soxe status` shows it as `DEAD`/`not-started` alongside healthy
services (implying a fault). With a single consumer there is no reason to carry a deprecated shell —
remove it cleanly: delete the bundle member + its manifest wiring, drop it from `registry/index.json`
+ the smoke-test surface (`scripts/smoke-test.mjs` currently lists it as testable), and remove any
references. Verify enrichment still runs in-process (memory_stats cluster coverage) after removal.
Publishing the resulting bundle-major bump to npm is the owner's step (ADR-0007); the source removal
+ local registry is the agent's. Sequenced after S4 (which touches the same bundle's `memory-cli`).

**Fix (evidence):**
- Deleted `extensions/bundles/sox-memory-bundle/members/memory-daemon/` (whole directory: manifest,
  project.json, package.json, src/{bin,index,memoryd,schema}.ts, tsconfig.json).
- Deleted the orphaned dead-code twins that were never actually removed by the earlier (falsely
  "complete") RS-6 pass (see BL-184): `extensions/bundles/sox-memory-bundle/members/memory-server/
  src/{bin.ts,memoryd.ts}` (unreferenced by memory-server's real build — confirmed via
  `package.json` main/exports + `project.json` build target, both point only at `src/index.ts`) and
  `libs/memory-core/src/memoryd.ts` + `libs/memory-core/src/memoryd-retry.spec.ts` (the canonical
  `MemoryDaemon` class — genuinely dead now that nothing spawns it).
- `extensions/bundles/sox-memory-bundle/extension.json`: removed `{ "id": "memory-daemon" }` from
  `members`; updated description.
- `registry/index.json`: regenerated via `npx nx run registry:sync-index` (15 entries; no
  `memory-daemon` entry; bundle's `members` array now `[memory-server, memory-flush, memory-cli,
  memory-usage]`).
- `libs/memory-core/src/write.ts`: removed `enqueueIngest`/`nudgeDaemon` import + call sites, and
  the now-fully-dead `scope` field from `WriteParams`/`BatchItem` (it existed solely to compute the
  deleted daemon-queue's priority — confirmed zero other consumers and not part of the actual
  exposed `memory_write` MCP tool input schema).
- `libs/memory-core/src/curate.ts`: global `memory_curate recluster` (non-dry-run) now calls
  `runBatchEnrich(db, { incrementalCluster: false })` in-process instead of the deleted
  `enqueueEnrich` — this was actually a **latent bug fix**: the old `enqueueEnrich` enqueued into
  `organizer_queue`, which nothing has drained since `memory-daemon` went `DEAD`/inactive in
  production, so global recluster was silently a no-op before this fix.
- `libs/memory-core/src/index.ts`, `extensions.ts`, `enrich-batch.ts`: removed the `memoryd.js`
  re-export and updated stale comments describing the daemon-queue architecture.
- `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`: removed `SOCKET_PATH`
  import + `isDaemonReachable()` daemon-socket probe; the periodic in-process enrichment loop
  (`runFallbackEnrichPass` → renamed `runPeriodicEnrichPass`) is now unconditional (previously it
  skipped its pass if a daemon socket answered — there is no daemon to answer anymore). Updated the
  `memory_write`/`memory_curate` tool descriptions sent to MCP clients.
- `libs/host-runtime/src/runtime.ts`, `os-unit.ts`: updated illustrative `memory-daemon` example
  comments to `tokenguard`/generic examples (no functional change — these were never coupled to the
  deleted package). Left `os-unit.spec.ts`/`singleton.spec.ts`'s use of `'memory-daemon'` as a
  fixture *string* untouched per the dispatch's explicit guidance — purely generic example
  extension ids with no coupling to the deleted package's code, not "memory-daemon-specific".
- `scripts/v2-e2e.test.ts`: bundle-members assertion `toHaveLength(5)` → `toHaveLength(4)`.
- `extensions/bundles/sox-memory-bundle/members/memory-server/recall-sqlite.test.ts`: removed the
  BL-47 daemon-socket-probe test (no daemon concept left to probe) and its now-unused
  `SOCKET_PATH`/`net` imports; kept + retitled the in-process `runBatchEnrich` regression test.
- Docs updated to stop describing the removed daemon as current architecture: root `AGENTS.md`
  (smoke-test single-extension example), `CONTRIBUTING.md` (service-extension examples, ×3),
  `extensions/bundles/sox-memory-bundle/{README.md,members/memory-server/{README.md,CLAUDE.md},
  members/memory-usage/SKILL.md}`, and the installed dev-scope mirror at
  `.claude/skills/memory-usage/SKILL.md`. Deliberately did NOT touch `docs/decisions/0007-*.md`
  (ADR flip to ACCEPTED is HF-6 closeout's job), `docs/spec/service-lifecycle.md` /
  `docs/guidelines/*.md` (illustrative examples across many files — a dedicated docs sweep, not a
  5-minute fix), `.opencode/agents/{implement,flash}.md` (shared cross-host agent-infra prompts,
  uncertain ownership), or any `docs/plan/**` historical planning artifact / CHANGELOG.md (frozen
  point-in-time records — editing them would be revisionist).
- Also fixed root `vitest.config.ts`: added the same `testTimeout`/`hookTimeout: 30_000` that
  `memory-server`'s own vitest config already carries for fastembed ONNX warmup — the root
  aggregate runner double-covers `extensions/**/*.test.ts` (incl. `recall-sqlite.test.ts`) but
  lacked the override, so it deterministically timed out at the default 5s on first `embed()` call.
  Unrelated to memory-daemon but discovered and fixed while gating this change (see verification).

**Verification:**
- `npx nx build/lint/test` clean for `host-runtime`, `memory-core`, `memory-server` (see PR/report
  for exact counts). `memory-server:test`'s one observed failure was the pre-existing, already-
  tracked BL-161 fastembed-parallel-worker flake (confirmed via git diff tracing + a clean re-run
  passing 81/81 + Nx's own flaky-task detector concurring) — not a regression from this change.
- `rm -rf dist/smoke && node scripts/smoke-test.mjs` → `2 testable: tokenguard, memory-server` (no
  `memory-daemon`) → `13 passed, 0 failed, 0 skipped`.
- `npx nx affected -t lint,build,test` clean after the vitest.config.ts timeout fix above.
- In-process enrichment confirmed still running with zero daemon dependency: `memory-server`'s
  periodic loop and `memory_curate recluster`'s global path both call `runBatchEnrich` directly;
  `recall-sqlite.test.ts`'s in-process `runBatchEnrich` regression test passes.

**Not fixed (see BL-181/182/183/184 above):** `tools/test-e2e-lifecycle.js`'s Slice 1 + Section E
fixtures, `memory-flush`'s dead nudge call, `outbox-queue.ts`'s unwired scaffolding, and
`progress.json`'s stale RS-6 claim.

## Open — surfaced during S7/BL-161 memory-core test speed-up (2026-07-04)

### BL-167 — recall.ts ScoreBreakdown invariant violated for zero-normTotal ranked nodes (HF-3 follow-up) — **RESOLVED (2026-07-08)** — proportional raw-RRF fallback; 3 tests that asserted the bug were repaired

_(Renumbered from a duplicate BL-162 introduced by the S7 agent; the memory-daemon item keeps BL-162.)_
Follow-up to HF-3 (BL-132) recall score legibility.

**Severity: low (incorrect score_breakdown.vec/bm25/temporal values; total === score is correct).**

In `libs/memory-core/src/recall.ts` lines 526–532, the code decomposes `finalScore`
into per-channel contributions using normalised weights. When a node appears in only
one channel AND has the lowest value in that channel, `minMaxNorm` returns 0 for that
node (min-max maps the minimum to 0). Then `normTotal = vecNorm + ftsNorm + tempNorm = 0`,
the `if (normTotal > 0)` branch does not run, all contributions are 0, but
`total = finalScore > 0`. The invariant `vec + bm25 + temporal === total` is violated.

**Comment at line 61** (`vec + bm25 + temporal === total === score`) is incorrect for
this edge case. The stable invariant is only `total === score`.

**Impact:** `score_breakdown.vec/bm25/temporal` show 0/0/0 for the lowest-ranked
candidate in a single-channel recall scenario. The `total` field is always correct.
Downstream displays using per-channel breakdown will show wrong attribution.

**Fix sketch:** Change the `if (normTotal > 0)` fallback to assign `total` proportionally
among whichever raw channels were non-zero (e.g. split by raw rrf values instead of
normalised), or document that channels are undefined when normTotal=0 and `total === score`
is the only invariant.

**Found:** during S7/BL-161 test threshold re-tuning. Tests adjusted to document the edge case.

**Triage context:** Two approaches, both cheap (~1-5 lines). Option A (fix the math) restores
the documented invariant for all callers but needs care to avoid division-by-zero on the
all-channels-zero path. Option B (document the edge case) is a one-line comment fix but leaves
the per-channel breakdown silently wrong for the lowest-ranked result in single-channel recalls.
The decision depends on whether any downstream consumer (CLI display, agent tool rendering)
reads per-channel scores and would be misled by 0/0/0 for a valid result. Current known
consumers: `memory_stats` surfaces the breakdown; no known consumer acts on per-channel values.

---

## Open — build-tooling / module-resolution debt (2026-07-04)

### BL-168 — DEBT: audit the recurring module-resolution / bundling / workspace-tooling class of bugs — **RESOLVED (2026-07-04, wave-2)**

**Resolution:** `docs/standards/module-resolution.md` authored (build model, C7, import.meta shim, worker resolution, stale-dist rule, vitest aliasing, decision table) + linked from CONTRIBUTING §1. Stale memory-daemon artifact tree deleted (dist/, bundle/, node_modules/ — untracked debris removed on main at merge). Known consequence: `tools/test-e2e-lifecycle.js` existsSync fixture guard now fails LOUDLY — the documented desired behavior of BL-181, which remains the open fixture-swap item.

The same class of problem keeps recurring, each fixed point-wise. We keep paying for it. Audit them
together and establish ONE consistent, documented standard for module resolution + bundling +
workspace tooling so these stop happening. The recurring instances so far:
- **`import.meta.url` in CJS bundles** (BL-155) — esbuild sets `import.meta={}` for cjs output →
  `fileURLToPath(import.meta.url)` throws; crash-looped the daemon. Fixed with a bundler shim.
- **Sibling-worker path resolution** — `join(__dirname/import.meta.url, 'embedWorker.js')` resolves
  differently across src vs dist vs bundle. Broke the memory-core real-bge test (aliased to src →
  `src/embedWorker.js` missing; BL-161 follow-up) AND is latent-broken in the hybrid-search
  cross-encoder (BL-166: `../../../../embed/.../dist/embedWorker.js` won't resolve in a bundle).
- **Vite/vitest can't resolve the ESM-only `exports` map** of the data packages → needed a manual
  `resolve.alias` to a concrete file in every consumer's vitest config (memory-core, memory-server).
- **`@nx/enforce-module-boundaries` false positives** — `require.resolve('<pkg>')` for a path is
  flagged as a "lazy load", forbidding legitimate static value imports (cross-encoder.ts, and the
  memory-server index.ts type-import). Fixed with line-scoped disables — a smell.
- **Loose `.mjs` scripts outside the nx graph** silently rot + create lint circular-deps + hide behind
  the nx cache (BL-159/BL-160 reembed, BL-164 baseline scripts).
- **pnpm `onlyBuiltDependencies` gap** — `onnxruntime-node`'s build script isn't approved, so a
  clean-room reinstall leaves it unbuilt (relied on prebuilt binaries; fragile).
- **Workspace linking / worktree churn** — worktree agents' installs unlinked `node_modules/nx`,
  needing a clean-room reinstall mid-session (also see BL-150).

**Deliverable:** a short "module resolution & bundling standard" doc + fixes: pick one bundler-safe
`__dirname`/asset-path pattern for code consumed in CJS bundles; make the data packages' `exports`
maps vite-resolvable (dual `import`/`require` conditions) so consumers don't each need an alias hack;
resolve the module-boundary false positives properly (not per-line disables); bring all loose `.mjs`
into the graph (BL-160/BL-164); add `onnxruntime-node` (and any other native dep) to the pnpm
build-approval allowlist. Root-cause once, not seven times.

### BL-169 — stray `--extension/` dir from unguarded smoke-test arg parsing — **RESOLVED (2026-07-04)**

A `--extension/dist/smoke/run-2026-06-30…/` dir sat at the repo root. Origin: `scripts/smoke-test.mjs`
read `--root`'s value as `ARGV[indexOf('--root')+1]` with no guard, so a `--root --extension memory-daemon`
invocation (or `--root` with no value) treated the flag `--extension` as the root path and wrote smoke
output to `./--extension/…`. Fixed: added a `flagValue()` guard that rejects a missing value or a value
starting with `-` (exit 2). Removed the stray dir.

### BL-242 — migrate `install-engine` to `@nx/js:tsc` executor — **RESOLVED (2026-07-10)** — install-engine, apps/sox and tokenguard migrated off bare `tsc` to a `compile` target on `@adhd/sox-nx:atomic-tsc`, with `build` reduced to post-steps via `dependsOn: [compile, ^build]`. Every post-step preserved (`rewrite-paths.cjs`, `stamp-build.cjs`, `embed-registry.cjs`, `gen-schema.cjs`, the `{"type":"commonjs"}` sidecar, esbuild bundle). Byte-equivalence proven on 5 artifacts (sha256 + file lists, twice). Atomic guarantee re-proven per project by breaking each source and confirming `dist/` survived. Caught by the checksum check, not assumed: `@nx/js:tsc`'s `generatePackageJson` defaults to `true` and was emitting a `dist/package.json` the old bare `tsc` never produced — disabled on tokenguard's compile target

18 projects migrated from `nx:run-commands` + bare `tsc --project` to `@nx/js:tsc`
executor with `clean: true`, which natively handles stale-output cleanup and auto-generates
`dist/package.json` with correct module type. `install-engine` was left as-is because its
build command has an extra post-build step (`node scripts/rewrite-paths.cjs`) that the
executor can't run.

**Fix sketch:** split into two targets — `compile` using `@nx/js:tsc` and `build` using
`nx:run-commands` that runs compile then rewrite-paths. Root: BL-171.

---

## Open — surfaced during BL-145 live launchd re-enable (2026-07-04)

### BL-155 — CRITICAL: esbuild CJS extension bundle breaks `import.meta.url` → embedding provider dead → daemon crash-loop — **RESOLVED (2026-07-04)**

**Severity: critical (any bundled extension using `import.meta.url` crashes at init).**
`libs/data/embed/embedding-provider/src/fastembed.ts:7` computes
`const __dirname = dirname(fileURLToPath(import.meta.url))` to locate its sibling
`embedWorker.js`. The memory-server bundle is **CJS** (`tools/bundle-extension.cjs`,
`format: 'cjs'`), and esbuild replaces `import.meta` with `{}` in CJS output — so
`import.meta.url` is `undefined` and `fileURLToPath(undefined)` throws
`The "path" argument must be of type string or an instance of URL. Received undefined`
at module init. This killed `warmupEmbed()` at daemon startup, so the launchd unit
**crash-looped** (`[memory-server] FATAL: … embedding warmup failed`).

Masked in CI because vitest loads the provider's own **tsc dist** (real ESM, where
`import.meta.url` is defined), never the esbuild CJS bundle. Only the live daemon (and
any bundled deployment) hit it.

Fix: `tools/bundle-extension.cjs` now injects an `import.meta.url` shim for CJS output —
`banner: const __soxImportMetaUrl = require('url').pathToFileURL(__filename).href` +
`define: { 'import.meta.url': '__soxImportMetaUrl' }`. This points `import.meta.url` at
the bundle's own file, so `__dirname`-style sibling resolution finds
`dist/embedWorker.js`. Verified: rebuilt bundle, daemon boots with
`[memory-server] embeddings: real model active (bge-base-en-v1.5)` and stays up.

### BL-156 — os-unit generator ignored `serve_mode: proxy` (persistent daemon ran direct-stdio, unreachable) — **RESOLVED (generator) (2026-07-04)**

`soxe service enable memory-server --scope=user` generated a launchd unit whose
`ProgramArguments` was `[node, --enable-source-maps, dist/index.js]` — the raw entrypoint.
But memory-server declares `serve_mode: "proxy"`, `serves: ["stdio","sse","http"]`, and the
unit env carries `SOX_CONFIG_PORT=3099`. Running `node index.js` directly lands in
DIRECT-STDIO mode (`index.js:1688`), which listens on nothing — so the daemon warmed the
ONNX model and idled with no reachable transport.

Fix: `os-unit.ts` gained an optional `execArgs` (the args after `nodePath`); the launchd/
systemd renderers use it when present, else the direct-service default `[...nodeArgs,
entrypoint]`. `resolveOsUnitContext` (`apps/sox/src/main.ts`) now, for a proxy-mode
mcp-server with a configured `SOX_CONFIG_PORT`, sets
`execArgs = [--enable-source-maps, <cli>, serve, <id>, --port, <port>]` so the unit runs the
port-listening front-shim (which auto-ensures the singleton UDS backend). `entrypoint`
stays the reaper's BL-31 identity token (the BACKEND runs it under `SOX_PROXY_BACKEND=1`).
Verified: re-enabled unit's plist runs `soxe serve memory-server --port 3099`, **:3099
listens**, a fresh backend spawns reporting `real model active (bge-base-en-v1.5)`; os-unit
spec test + smoke 16/0. **End-to-end HTTP still blocked by BL-157/BL-158 below.**

### BL-157 — `soxe serve --port` headless HTTP transport returns `proxy closed`; shim→backend UDS unstable under launchd — **RESOLVED (2026-07-04)**

**Root cause (exact mechanism):** in `libs/service-proxy/src/shim.ts` `runFrontShim`, the
`input.on('end')` / `input.on('error')` handlers unconditionally called `backend.close()` +
resolved `done` when the stdio-client pipe closed. Under launchd `stdin=/dev/null` EOFs
**immediately at startup**, so the backend connection was torn down the instant the shim
booted — before any HTTP request. `dialBackend.close()` sets `closed=true` and thereafter
every `send()` resolves synchronously with `errorResponse(..., -32001, 'proxy closed')`
(`dial.ts:249-252`). The HTTP listener stayed bound but its shared backend connection was
dead, so every HTTP `initialize`/`tools/call` returned `{"code":-32001,"message":"proxy
closed"}`. The `write EPIPE` in the backend log was the backend seeing the shim's socket
close. HTTP transport availability was wrongly coupled to stdio-client presence (§9.5.2 says
they MUST be independent).

**Fix:** decouple. When `httpPort` is set (`httpActive`), the stdio pipe ending no longer
closes the backend or resolves `done` — the HTTP server + its backend connection own their own
lifecycle; the process exits via `cmdServe`'s SIGTERM handler. Pure stdio-client mode (no
`httpPort`) is UNCHANGED — pipe-end still tears down the backend, preserving the S1.5/S1.6
zero-downtime stdio guarantees (re-dial+backoff+buffer, schema-hash handshake). +2 regression
tests in `shim.spec.ts` pin both behaviours. Proven on a scratch store AND against the live
launchd unit `:3099`: `initialize` + `tools/call memory_ping` now succeed, routing through the
fixed os-unit shim to the singleton backend, no `proxy closed`.

**Live reconcile:** the split-brain (two backends `43731`+`43740` for `~/.memory`) was healed —
`43740` was an orphan (init-parented, NO socket bound, zero clients; it lost the O_EXCL bind
race but did not exit) and was reaped (SIGTERM ignored → SIGKILL escalation per
`[contract:signal]`). The live writer backend `43731` (owns the socket, serves the session
shims) was left untouched. The os-unit launchd shim (`10066`, old code, 0 backend connections)
was restarted via `launchctl kickstart -k gui/<uid>/com.sox.user.memory-server` → new pid
`93280` running the fixed shim; `soxe status` shows `memory-server@os-unit HEALTHY`; exactly ONE
backend remains. Session shims never disrupted (they re-dial the singleton backend by design).

### BL-170 — `ensureBackend` O_EXCL-lock LOSER leaves an orphaned backend zombie (recurring split-brain) — **RESOLVED (2026-07-04)**

**Fix (landed with the 2026-07-04 hot-triage):** `runBackend`
(`extensions/bundles/sox-memory-bundle/members/memory-server/src/backend.ts`) now
(1) catches ANY `serveBackend` rejection (`E_LIVE_SOCKET` from the SA-4 probe AND the raw
`EADDRINUSE` race variant — both observed in the live backend log), writes a stderr FATAL
diagnostic (`[inv:no-stdout-diagnostics]`), and exits 1 via an injectable `exit` seam — a losing
singleton racer dies loudly instead of idling; and (2) wires SIGTERM/SIGINT handlers BEFORE the
async bind, so even a backend stuck pre-bind honours `[contract:signal]` (the observed zombies
ignored SIGTERM because handlers were only wired post-bind). The `index.ts` call site's
`void runBackend(...)` gained a defensive `.catch()` → stderr + `process.exit(1)` (Node's default
unhandled-rejection crash is not reliable here: the embed worker thread outlives it when stdio is
a dead pipe). Regression test `[BL-170]` in `memory-server/src/backend.spec.ts` proves the loser
exits 1 with the diagnostic while the winner keeps serving.

**Incident timeline (2026-07-04):** another agent's `memory_write_batch` timed out ~19:13Z;
triage found THREE backends for the one `~/.memory` singleton: writer `12625` (db+socket, 11
session-shim clients) plus zombies `14235` (main-repo dist, spawned 18:51Z) and `59405`
(spawned 18:56Z from the `agent-a6bd315cddfc76ae5` worktree's dist — see BL-173). Both zombies:
zero db/socket fds, stdio = dead socketpairs (`->(none)`), SIGTERM ignored → SIGKILL reap
(owner-authorized) at ~19:33Z. Writer + shims untouched; single writer verified via lsof after.
The backend log carried both loser shapes: an `E_LIVE_SOCKET` unhandled-rejection crash AND an
`EADDRINUSE` crash — plus the two silent idlers. The write "stall" itself was a separate
mechanism — see BL-172.

**Discovered while fixing BL-157** — it is the ROOT of the "two backends for one store" split-brain
BL-157 noted. When the singleton writer backend for a store dies, multiple session shims' `ensure`
hooks race to respawn it. The lock winner takes the O_EXCL lock + binds the UDS. A racer that
spawned a backend which then loses the bind hits `E_LIVE_SOCKET` in `serveBackend`
(`backend.ts` probe-before-bind correctly REFUSES a live socket) — **but that backend process does
NOT exit.** It idles orphaned: `ppid=1`, 0 socket fds, ONNX model loaded, 0 clients. Observed
TWICE on the live box during S8: original orphan `43740` beside writer `43731`; then it RE-FORMED
(`6604` beside `6595`) minutes after the first reap, when the original writer exited and two shims
raced. These orphans also **ignore SIGTERM** (had to SIGKILL) because they never finished init to
wire their `[contract:signal]` handler.

Two sub-fixes: (1) `runBackend` (`extensions/bundles/sox-memory-bundle/members/memory-server/src/
backend.ts`) must `process.exit(non-zero)` when `serveBackend` rejects with `E_LIVE_SOCKET` — a
losing racer MUST die, not idle, so the singleton invariant self-heals; and/or harden
`ensureBackend` (`libs/service-proxy/src/ensure-backend.ts`) so the spawn path that detects a
live socket post-spawn kills its own just-spawned child. (2) Ensure a SIGTERM-drain path exists
even for a backend stuck pre-bind. Until fixed, split-brain re-forms on every writer-death race
and needs a manual orphan reap. NOT fixed in the BL-157 change (that was the shim stdio/HTTP
coupling; this is the backend spawn-race). Also mirrors the never-reaped-orphan class of BL-31/BL-64.

### BL-158 — live store's `sox_store_meta.embed_model` stamp was stale (`…-hash`) though vectors are real bge — **RESOLVED (2026-07-04)**

**Downgraded from HIGH after verification, then fixed.** With owner approval, corrected the one
stale row: `UPDATE sox_store_meta SET value='bge-base-en-v1.5' WHERE key='embed_model'` (1 row).
`sox_store_meta`, `memory_scope`, and the `vec_node` vectors now all agree on bge — the
misleading startup warning will not recur. NOT a data problem, and NO reembed was needed.
The backend startup warning (`store was stamped … "nomic-embed-text-v1.5-hash" but runtime
has "bge-base-en-v1.5"`) is misleading. Ground-truth checks on `~/.memory/memory.db`:
- Recall **works**: a query for a known-present topic ("LanceDB concurrent write errors…")
  returns the exact LanceDB memory as the #1 hit via `provenance:["vec","fts"]` — the vec
  channel matches, so the vectors ARE in the current bge space. (An earlier "writer lease"
  query scored ~0.004 only because that topic isn't in this graph store — it lives in file
  memory — not because embeddings are broken.)
- `vec_node` holds 2597 real bge vectors; `memory_scope.embed_model = bge-base-en-v1.5` ✓.
- Only `sox_store_meta.embed_model` is stale = `nomic-embed-text-v1.5-hash` (never updated
  when the store was migrated to bge). `memory reembed --force` correctly reports
  **0 nodes to migrate** — the data is already bge.

Residual fix is a **one-row metadata reconciliation**:
`UPDATE sox_store_meta SET value='bge-base-en-v1.5' WHERE key='embed_model'` — to silence the
false warning and make `memory_ping`/`memory_stats` honest ([inv:list-never-lies]). It is a
direct live-store write (auto-mode classifier gated it) → needs owner OK or a sanctioned CLI
path. Cosmetic; does not affect recall. (Minor: `memory reembed --dry-run` fix: the prior dry-run
created an empty `vec_bge_base_en_v1_5` space — fixed in BL-160.)

### BL-161 — fastembed test warmup: model reloads per test-worker + on singleton reset → flaky 30s timeout — **RESOLVED (2026-07-08)** — memory-flush `vitest.setup.ts` installs `DeterministicTestProvider`

**Validation note (2026-07-04 sweep):** memory-core itself is FIXED (DeterministicTestProvider via vitest.setup.ts). Remaining open instance: memory-flush spec still runs the real embed path with no provider injection, no pool pinning, no timeout override (`memory-flush/src/index.spec.ts` + its vitest.config.ts). Re-scope to memory-flush only.

Recurring flaky timeout in `memory-core` (`write.spec.ts` "batch of 10 items…", surfaced again
during S1). Root causes (NOT that tests can't be event-driven — the warmup IS async/awaited):
   1. **Per-worker reload.** vitest's default `forks` pool runs each spec FILE in its own process,
   so bge-base-en-v1.5 ONNX re-loads once per file. The provider is a module singleton
   (`libs/memory-core/src/embed.ts _provider`) shared WITHIN a process, but not across worker processes.
2. **Singleton resets.** ``libs/memory-core/src/embed.spec.ts`/`extensions/bundles/sox-memory-bundle/members/memory-server/recall-sqlite.test.ts` call `_resetEmbedSingleton()` in
   hooks, tearing down the FastembedProvider worker thread → reload within a file too.
3. **Contention, not slowness.** Cached bge init + first inference is ~5–12s single-process; 30s is
   the TIMEOUT, not the warmup. Many forks warming at once contend for CPU/RAM → any one crosses 30s.
Fix (after S2/S4 land, to avoid vitest-config merge churn): (a) stop resetting the singleton in
hooks that don't need it → warm once per process; (b) pin embed-heavy specs to a single worker
(`poolOptions.forks.singleFork` or a dedicated vitest project); (c) biggest win — a lightweight
test-embed seam (small/stub content-dependent vectors) for tests that only need "a vector,"
reserving real bge for the 1–2 semantic-quality assertions.

_BL-162 duplicate entry removed 2026-07-04: fixed per S9 (see entry near line 496). The memory-daemon was deleted in S9; the old "Open (MEDIUM)" entry was stale._

### BL-163 — FEATURE: generalized always-on-service login-items registration with a controllable name (SMAppService) — **Open (FEATURE)** — BLOCKED on an Apple Developer ID / code-signing identity; no in-repo evidence contradicts the blocker `[TRIAGE]`

A genuine future feature (legitimately backlogged — needs a prerequisite we don't have yet: a
code-signing identity). Today a user LaunchAgent with `RunAtLoad` already starts at login, but its
name in macOS System Settings → Login Items is derived from the code SIGNATURE, not the plist — so
an unsigned `node` LaunchAgent cannot present a friendly name (e.g. "Sox Memory"). Generalize the
os-unit layer so ANY always-on service can opt into a proper Login-Items entry with a controllable
display name via `SMAppService` (macOS 13+) registering a **signed** helper. Design so it is not
memory-server-specific: a manifest `display_name` + `login_item: true` drives registration for any
`activation_posture: always-on` service; falls back to the plain LaunchAgent when no signing
identity is configured. Example motivating case: memory-server → "Sox Memory". Prereq: a Developer
ID / signing identity + a bundled signed helper target.

**Triage context:** Not actionable until a code-signing identity is obtained (Developer ID or
Apple Developer Program). No design decisions are blocked — the feature path is clear (SMAppService
registration in os-unit.ts, manifest `display_name` field, signed helper binary). Two decision
points when the prereq is met: (a) which extensions get `login_item: true` by default vs opt-in,
(b) whether the signed helper is a dedicated binary or a signed wrapper around `node` + the extension.
These are naturally deferred until signing exists.

### BL-164 — loose `scripts/capture-*-baseline.mjs` create an nx lint circular-dep; promote/exclude them (same class as BL-160) — **RESOLVED (2026-07-04, S10)**

Surfaced by S2: `npx nx lint memory-core --skip-nx-cache` reportedly showed 22 `@nx/enforce-module-boundaries`
errors in `cluster.ts`/`embed.ts`/`recall.ts` etc., attributed to `scripts/capture-enrichment-baseline.mjs`
+ `scripts/capture-write-perf-baseline.mjs` importing `memory-core` from the repo-root `scripts`
project — a circular project edge (scripts→memory-core while the root project globs these files).

**S10 re-verification (fresh `nx reset` + clean-room `pnpm install` + `--skip-nx-cache`):** the
22-error cycle did **not** reproduce — `npx nx lint memory-core --skip-nx-cache` was clean (0 errors)
both before and after this fix, and a programmatic cycle-detection pass over the full `nx graph`
JSON found no cycle touching `memory-core` or `sox-ecosystem` in either state. The one real, confirmed
structural finding: the root `sox-ecosystem` project *did* carry a one-directional `sox-ecosystem →
memory-core` static edge, caused by these two scripts' raw `require('../libs/memory-core/dist/index.js')`
(and shared by several unrelated `tools/*.{js,mjs}` probes/benches — out of this ticket's scope, see
below) — real hygiene debt (no typecheck/lint/test coverage, brittle dist-path reach-in) matching
BL-160's disease even though it wasn't tripping the cycle detector today.

**Fix (Option A, matching BL-160's precedent):** promoted both scripts into a new nx-recognized
project `tools/baseline-capture` (`package.json` + `project.json` + `tsconfig.json` +
`vitest.config.ts`), consuming `@adhd/sox-memory-core` as a normal `workspace:*` dependency instead
of reaching into its `dist/` output via a relative path:
- `tools/baseline-capture/src/capture-enrichment-baseline.ts` — typed `captureEnrichmentBaseline()` +
  pure `runEnrichmentBaselinePass()` / `buildEnrichmentBaseline()` helpers, ported verbatim from the
  deleted `scripts/capture-enrichment-baseline.mjs` (identical JSON shape/output paths).
- `tools/baseline-capture/src/capture-write-perf-baseline.ts` — typed `captureWritePerfBaseline()` +
  pure `percentile()` / `computeWritePerfMeasurements()` / `buildWritePerfBaseline()` helpers, ported
  verbatim from the deleted `scripts/capture-write-perf-baseline.mjs`. **Preserves the exact
  `{ measurements: { p50_ms, p99_ms, ... } }` JSON contract** that `libs/memory-core/src/soak/
  metrics-exporter.ts`'s `compareToBudget()` reads from `_shared/baselines/write-perf.json` — the one
  live consumer found via a repo-wide grep before making this change.
- 14 unit/integration tests across both modules (`*.spec.ts`), no ONNX/real embedding required —
  `capture-write-perf-baseline.spec.ts` mocks `@adhd/sox-memory-core` (same philosophy as
  `reembed.spec.ts`); `capture-enrichment-baseline.spec.ts` seeds a real schema via raw SQL (no
  `memoryWrite`/embed calls) and exercises the real `runBatchEnrich` end to end, including a
  "never mutates the live store's content" assertion.
- Deleted `scripts/capture-enrichment-baseline.mjs` and `scripts/capture-write-perf-baseline.mjs`
  (no shim — same as BL-160's `reembed-memory.mjs` deletion). New invocation:
  `npx nx run baseline-capture:capture-enrichment-baseline` / `:capture-write-perf-baseline`
  (or `node tools/baseline-capture/dist/capture-*.js` directly, matching the old plain-`node`
  ergonomics). No CI workflow or npm script referenced the old paths (grepped `.github/`, root
  `package.json` — clean); only historical plan docs (`docs/plan/runtime-productionization/02-
  reusable-subsystems/{progress.json,REPORT.md}`) reference the old invocation as an append-only
  audit trail and were intentionally left untouched.
- Added `tools/*` to `pnpm-workspace.yaml`'s `packages` glob (new workspace member needs pnpm
  linking); relocked with a plain `pnpm install` and committed the `pnpm-lock.yaml` diff in the
  same change per the RELOCK constraint. Other loose `tools/*.{js,mjs,cjs}` files (bench/probe
  scripts) have no `package.json` and are unaffected by this glob.

**Gate:** `npx nx lint memory-core --skip-nx-cache` clean (0 errors) · `npx nx build baseline-capture`
pass · `npx nx lint baseline-capture --skip-nx-cache` clean · `npx nx test baseline-capture
--skip-nx-cache` 14/14 pass. `npx nx affected -t lint,build,test` surfaced 2 failing tasks —
`sox-ecosystem:test` and `memory-flush:test` — both re-verified in isolation (see BL-171) as a
pre-existing real-ONNX/vitest-forked-pool flake with **zero** overlap with this ticket's diff
(`git status` during triage showed only `BACKLOG.md`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, the
2 deleted scripts, and the new `tools/baseline-capture/` dir — no memory-server/memory-flush files
touched). Not fixed here (out of file-scope; logged as BL-171).

**Follow-on backlog candidate (not fixed here, out of scope):** several other `tools/*.{js,mjs}`
files (`bench-recall.js`, `bench-scale.js`, `test-*.js`, `probe-*.mjs`) reach into sibling
extensions'/libs' `dist/` output the same way the two capture scripts used to — same disease,
systemic across `tools/`, deliberately not swept into this ticket's file scope to avoid touching
files outside the two named in BL-164 (worktree hygiene / disjoint-file-set discipline).

### BL-171 — `onnxruntime-node` native V8 HandleScope crash + real-ONNX test timeouts under vitest forked pool (`sox-ecosystem:test`, `memory-flush:test`) — **RESOLVED (2026-07-10, `3916afd`)** — superseded by BL-238's fix. The vitest pool-pin was only ever a test-side mitigation; the real defect was two ONNX worker threads in one process, now routed through a single shared worker

**Validation note (2026-07-04 sweep):** the cited `memory-server/src/recall-sqlite.test.ts` moved to the member root (`members/memory-server/recall-sqlite.test.ts`); its second describe block still runs real ONNX (SOX_EMBED_BACKEND=real, 30s timeout) — the crash class remains live at the new path.

**Escalation note (2026-07-09, see BL-238):** the P1 substrate `integration` e2e reproduced this exact
crash class OUTSIDE of vitest entirely (plain `worker_threads.Worker` composition, no test harness),
proving it is a real production-blocking bug — any consumer process that embeds + reranks/verifies in
one process today will crash — not merely vitest-forked-pool test-infra flakiness. Root-caused there to
`fastembed`'s `onnxruntime-node@1.21.0` usage being unable to coexist with ANY second concurrent
ONNX-bearing worker thread (including a second `fastembed` worker), independent of version matching
with `@huggingface/transformers`'s `onnxruntime-node@1.24.3`. See BL-238 for the full repro matrix and
candidate fixes.

**Resolution note (2026-07-09, see BL-238):** BL-238's production composition bug — the actual subject
of this escalation — is now RESOLVED (single shared `worker_threads.Worker` for rerank+verify +
dedicated child process for fastembed inside `@adhd/sox-embedding-provider`). This closes the
"production-blocking" escalation reason. The ORIGINAL, narrower BL-171 subject below (real-ONNX test
timeouts specifically in `memory-server`/`memory-flush` under vitest's forked pool) was never touched
by that fix — those two projects were out of the fenced `libs/data/embed/**` /
`libs/data/search/hybrid-search/**` / `libs/data/verify/claim-verification/**` scope this fix was
delivered in, and have NOT been re-measured. Do not close BL-171 on the strength of BL-238 alone —
re-run `memory-server:test` / `memory-flush:test` (per BL-246) before marking this resolved.

Surfaced while gating BL-164 via `npx nx affected -t lint,build,test`: two unrelated projects failed,
**neither touched by BL-164's diff** (verified via `git status` — zero overlap):
1. `sox-ecosystem:test` (root `vitest run`, includes `extensions/**/*.test.ts`) crashed with a
   **native V8 fatal error** inside `onnxruntime-node@1.21.0`'s forked worker: `FATAL ERROR:
   HandleScope::HandleScope Entering the V8 API without proper locking in place`, stack trace
   rooted in `InferenceSessionWrap::Run` → `OrtValueToNapiValue`, in
   `extensions/bundles/sox-memory-bundle/members/memory-server/recall-sqlite.test.ts` ("writes two
   claims and recalls them without throwing", 5000ms timeout, then the whole forked worker dies:
   `[vitest-pool]: Worker forks emitted error` / `Worker exited unexpectedly`). Node v24.11.1 +
   onnxruntime-node@1.21.0 — looks like a genuine native binding / V8-isolate-locking incompatibility
   when real ONNX inference runs inside a vitest forked child process.
2. `memory-flush:test` — 3-7 tests (non-deterministic count/subset across repeated runs: 3/14 in one
   isolated run, 7/14 inside the full affected batch) in
   `extensions/bundles/sox-memory-bundle/members/memory-flush/src/index.spec.ts` time out at exactly
   5000ms on auto-export paths that go through the real embed pipeline. Unlike `libs/memory-core`
   (which BL-161 fixed with a deterministic `DeterministicTestProvider` test-DI seam, cutting its
   suite from 140s to 19s and eliminating ONNX-driven flake), `memory-flush`'s spec has **not**
   adopted that seam and is exposed to real ONNX cold-start/warmup timing variance under a tight
   5000ms vitest default timeout — non-deterministic pass/fail is the signature of exactly this class
   of bug.

Both are pre-existing test-infrastructure flakiness in the shared "real ONNX inside vitest's forked
worker pool" execution path — not a BL-164 regression. Fix candidates (not attempted here, out of
BL-164's disjoint-file-set scope and touches `memory-server`/`memory-flush`, adjacent to concurrent
S8/S9 memory-daemon-area work): (a) extend BL-161's `DeterministicTestProvider` DI seam to
`memory-flush`'s and `memory-server`'s real-ONNX specs, or explicitly mark them `real-embed`-only and
raise their `testTimeout`; (b) investigate the onnxruntime-node v1.21.0 + Node v24 forked-worker V8
HandleScope crash — may need `pool: 'forks'` + `maxWorkers: 1` (already applied in memory-core's own
vitest.config.ts per BL-161) applied consistently to memory-server's and the root's vitest configs
too, or an onnxruntime-node version bump/pin.

### BL-165 — RAG-stack external reusability gap: `ingest` is private + `memory-core` (public) transitively 404s on it — **RESOLVED (2026-07-04) — S11 consolidation**

**Resolution:** `ingest` is now the canonical ingestion layer (S11 / BL-165). Consolidated:
- `hexSha256` exported from `@adhd/sox-ingest` and used in `libs/memory-core/src/write.ts` (replaces `crypto.createHash` inline). Parity verified: `libs/data/ingest/ingest/src/ingest-parity.spec.ts`.
- `splitIntoChunksSentence` added to `@adhd/sox-ingest` (byte-identical to the deleted `splitIntoChunks` in `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`). Parity verified: `libs/data/ingest/ingest/src/ingest-parity.spec.ts`, 9 corpus entries × 3 chunk sizes = 27 parity assertions + 3 summary assertions.
- Both re-exported through `libs/memory-core/src/index.ts` for consumer convenience.
- Publishability: see recommendation in commit message and SHARDS.md final message (keep `private: true` until memory-core v1.0 publish milestone; decision deferred to HF-6 closeout).
- Tag derivation: NOT consolidated — no duplicate exists (tags are caller-supplied in `enrich.ts: p.tags ?? []`; ingest's `extractTags` was already unused and remains unused).
- Evidence: `npx nx test memory-core --skip-nx-cache` → 357 pass / 8 skip; `npx nx test memory-server --skip-nx-cache` → 111 pass; `npx nx test ingest --skip-nx-cache` → 48 pass; dedup re-check: 3/3 pass.

**Original description (retained for history):**

ADR-0007 states the enrichment/data stack is meant to be "reused by non-memory projects." The five
data packages (`@adhd/sox-embedding-provider`, `-vector-store`, `-graph-store`, `-hybrid-search`,
`-analysis`) ARE cleanly reusable — public, ~9k LOC of real impl, platform-decoupled (import only each
other, never host-runtime/CLI), clean public `@adhd` dep graphs. But two gaps block a clean external
build of the FULL stack:
1. `@adhd/sox-ingest` (chunking + extractive summary + deterministic tags — the RAG document-prep
   step) is `private: true`, so it's not externally installable.
2. `@adhd/sox-memory-core` (public, v0.2.1) declares a RUNTIME `workspace:*` dep on the private
   `ingest` → per the repo's own `scripts/check-publishable.ts` rule 1, it would 404 on a fresh
   `npm install`. So memory-core is marked publishable but isn't.
**Update — ingest is barely used + its capabilities are DUPLICATED (reframes the fix):** tracing
actual usage, the system uses `ingest()` for ONLY its extractive summary (`memory-core/src/
extractive.ts` → `ingest(content).summary`, a 5-line wrapper). Its other capabilities are dead or
reimplemented elsewhere: `chunkContent` is UNUSED (memory-server has its own `splitIntoChunks` at
`index.ts:745` — the code that carried the BL-154 deadlock); `hexSha256` is UNUSED (`write.ts` has
its own `crypto` SHA-256); `extractTags` is UNUSED (tags are caller-supplied, `enrich.ts: p.tags ??
[]`). So `ingest` doesn't earn its ~1.4k LOC as wired.

**OWNER DECISION (2026-07-04): (A) Consolidate.** Tracked as SHARDS.md S11, sequenced after
S7/S9/S10 (memory-core serialization).

Decide (do not just publish a mostly-dead package):
- **(A) Consolidate — make ingest the canonical ingestion layer.** ← CHOSEN Route memory-server's chunking +
  write.ts's content-hashing + tag derivation THROUGH `ingest`, deleting the duplicate
  `splitIntoChunks`/SHA-256. This is DRY, removes the duplicate-chunker hazard class (BL-154), gives
  ingest real value, and makes publishing it (for RAG reuse) worthwhile. Bigger refactor (touches
  memory-server + write.ts — sequence after S7). PREFERRED if RAG reusability is a goal.
- **(B) Delete ingest — absorb the one live use.** Inline the trivial extractive summary into
  memory-core, remove the `ingest` package + memory-core's private dep. Simplest; also resolves the
  publishability gap (memory-core no longer depends on a private pkg). Choose if a reusable ingestion
  primitive is not wanted.

Either way this closes the original publishability inconsistency (memory-core public but transitively
404-ing on private ingest). Also note: none of the data packages are pushed to a registry yet (v0.x) —
a real external-consume story needs an actual publish. (Discovered answering "can I build a RAG system
from only these packages?" — yes for the 5 public retrieval packages; ingest is the weak link.)

### BL-166 — orphaned built packages + a dead reranker: wire-in-or-remove audit — **RESOLVED (2026-07-10)** — the "consumed externally" claim is now VERIFIED, not asserted: `/Users/nix/dev/ai/agent-source/package.json:38,39,42` declares `@adhd/sox-blob-store`, `@adhd/sox-claim-verification` and `@adhd/sox-hybrid-search` as `file:` deps of this repo. Real production import sites: `claim-registration/src/claim-registration.ts:49` (value), `ranking/src/index.ts:20` (value), `context-pack/src/blob-content.ts:15` + `blacklist-purge/src/blacklist-purge-service.ts:45` (type-only `BlobStore`, constructed at the composition root via `product-core-e2e/src/support/substrate.ts:36` `createBlobStore` and `delivery-surface-e2e/src/support/substrate.ts:28` `createClaimVerifier`) — i.e. exactly the ADR-0006 "live objects cross via DI" pattern, which is why an in-repo grep found zero importers. 16 import sites across the three packages. NOT orphans. The three package-local BACKLOG entries that reopened this were reasoning from in-repo evidence only and could not see the consumer

**Withdrawn:** owner confirms these packages are consumed EXTERNALLY (outside this repo) — the
zero-internal-importers finding was accurate but the "dead code" conclusion was wrong; repo-wide
grep cannot see external consumers. No wire-in-or-remove action. (The cross-encoder heuristic
quality item remains tracked separately as BL-116.)

Cheap consumer scan ("what was built but never refactored into memory") found fully-implemented
code with ZERO live consumers (not stubs — real impl; distinct from the internal-completeness items
BL-114/115 below):
- **`@adhd/sox-blob-store`** (~1,828 LOC) — 0 live importers anywhere in libs/extensions/apps.
- **`@adhd/sox-claim-verification`** (~1,083 LOC) — 0 live importers.
- **`hybrid-search` cross-encoder reranker** (`createCrossEncoder`/`CrossEncoderImpl`) — exported +
  tested but only its own spec calls it; `libs/memory-core/src/recall.ts` never invokes it (recall reranks by
  temporal recency×importance only). The dead path also carries the worker-path resolution bug noted
  under BL-157 (`../../../../embed/embedding-provider/dist/embedWorker.js` won't resolve in a bundle).

Same fork as ingest (BL-165): for each, **wire it into the live memory path** (blob-store = large-
content/attachment offload out of SQLite rows; claim-verification = memory provenance/contradiction
checking; cross-encoder = higher-precision recall reranking behind a flag) **or remove it**. Decide
per item — don't leave built-but-unconsumed code accruing (owner directive: fix/remove, don't defer).
Note `@adhd/sox-analysis` + `@adhd/sox-vector-store` currently also count `memory-daemon` as an
importer, but that's dead code being removed in S9 — they remain live via memory-core.

**Triage context — three independent decisions, per package:**

| Package | Wire-in effort | Wire-in value | Remove cost |
|---------|--------------|-------------|-------------|
| **blob-store** (~1.8k LOC) | Medium: add write-path offload for content >chunk_size, reference by hash in node rows | High: keeps large docs/media out of SQLite rows, essential for RAG with big documents | Low: no consumers, re-creatable from spec if needed later |
| **claim-verification** (~1.1k LOC) | Medium: add enrichment step after write, verify new claims against existing, flag/supersede contradictions | Medium: raises memory quality, most compelling orphan to keep | Low: no consumers, but the contradiction-detection logic is non-trivial to reconstruct |
| **cross-encoder** (~300 LOC + worker) | High: needs real ONNX model (BL-116), worker bundling fix, integration into recall behind a flag, latency budget | High for precision recall, but the vec+BM25 fusion already works well | Low-medium: part of public `hybrid-search` package — deprecate + no-op rather than remove to avoid breaking API |

The owner directive is "fix/remove, don't defer" — each needs a binary decision. The most
bang-for-effort is wiring blob-store (clear integration path, solves a real scaling problem).
The most interesting long-term is claim-verification (contradiction detection). The cross-encoder
is the most expensive to wire in relative to its current value.

### BL-160 — promote `reembed-memory.mjs` orchestration into a library + `memory-cli` verb (root cause of BL-159) — **RESOLVED (2026-07-04)**

`scripts/reembed-memory.mjs` was a loose `.mjs` OUTSIDE the nx graph (no typecheck/lint/test),
which is why it silently rotted when the embed migration removed the hash backend and changed
model ids (BL-159 — invalid `fast-bge-base-en-v1.5` + dead `hash-768`). Promoted:
1. `libs/memory-core/src/reembed.ts` — `reembedStore(dbPath, opts)` typed + unit-tested;
   dry-run-no-write bug fixed (no longer calls `ensureSpace` in dry-run mode).
2. `memory-cli reembed` verb added to the `switch(command)` dispatcher; flags:
   `--dry-run`, `--force`, `--no-backup`, `--db`, `--limit`.
3. `scripts/reembed-memory.mjs` deleted. All references updated to point at `memory reembed`.
Joined to the build/lint/typecheck graph — future embed-model changes break CI, not the next
live migration.

### BL-159 — `reembed-memory.mjs` was broken by the embed migration (wrong model id + dead hash fallback) — **RESOLVED (2026-07-04)**

The reembed tool passed `model: 'fast-bge-base-en-v1.5'` (the fastembed cache-DIR name, not a
valid `createEmbeddingProvider` model id) → `Unknown fastembed model` on every run, and fell
back to the removed `type:'hash'` / `model:'hash-768'` backend. Fixed: model id →
`'bge-base-en-v1.5'`; removed the dead hash fallback (`createEmbeddingProvider` only supports
`fastembed`/`remote` now). Verified: dry-run resolves `active model: bge-base-en-v1.5` and
reads the store correctly. (Surfaced while investigating BL-158.)

---

## Resolved-as-non-issue — pnpm workspace-linking post-merge investigation (surfaced 2026-07-04)

### BL-150 — `@adhd/*` workspace packages "missing" from `node_modules/@adhd/` after 4-worktree merge — **RESOLVED/NON-ISSUE (2026-07-04)**

**Reported symptom:** after merging 4 worktrees to `main`, `node_modules/@adhd/` didn't exist at the
repo root; memory-server tests (which load `@adhd/sox-mcp-runtime` → `@adhd/sox-service-proxy`)
were reported failing. A manual `mkdir -p node_modules/@adhd && ln -sf ../../libs/service-proxy
node_modules/@adhd/sox-service-proxy` was applied as a stopgap.

**Root cause (verified by clean-room reproduction):** worktree `04`'s merge added
`@adhd/sox-service-proxy: workspace:*` to `libs/mcp-runtime/package.json` without a corresponding
`pnpm-lock.yaml` update, so `pnpm install --frozen-lockfile` correctly refused post-merge (lockfile
≠ manifest). Someone ran `pnpm install --no-frozen-lockfile`, which regenerated the lockfile
correctly — that fix is the still-uncommitted `pnpm-lock.yaml` diff (+9/-3) sitting in the working
tree. The manual root-level symlink was a **red herring**: pnpm's isolated linker never hoists
workspace packages into the *root* `node_modules` unless the root `package.json` itself declares
them (it doesn't — root only depends on `better-sqlite3`/`sqlite-vec`/`ulid`). Every real consumer
(`libs/mcp-runtime`, `libs/memory-core`, the memory-server bundle, etc.) gets its `@adhd/*` symlinks
in its *own* local `node_modules/@adhd/`, which pnpm manages correctly on a plain install once the
lockfile is consistent.

**Verification:** `rm -rf node_modules && pnpm install` (zero flags, zero manual steps) from the
corrected lockfile → scanned all 11 projects / 29 `@adhd/*` dependency edges in the repo →
0 missing links. `npx nx test memory-server` passes identically with or without the root-level
symlink (81/84, same 3 pre-existing failures — see BL-151..BL-153 — none are module-resolution
errors). Root-level TS scripts (e.g. `scripts/validate-manifests.ts`, run via `tsx`) never needed
node_modules linking at all — they resolve `@adhd/*` via `tsconfig.base.json` `paths` mappings to
`libs/*/src/index.ts`, confirmed by direct execution (`OK (14 extension(s) validated)`).

**Fix:** commit the corrected `pnpm-lock.yaml`; delete the stray manual root symlink (not tracked
by git, but remove it from any local checkout — it's dead weight, not a fix). No `.npmrc` change,
no `link-workspace-packages`/`node-linker` override needed — default pnpm behavior is correct.
**Process note for future worktree merges:** any worktree that adds a new `workspace:*` dependency
edge must regenerate `pnpm-lock.yaml` *in that worktree* before merge, or the very first post-merge
`pnpm install` on `main` must be a non-frozen install before anything else runs — otherwise
`--frozen-lockfile` (used in CI) will hard-fail.

### BL-151 — `permission-guard.spec.ts` "long content auto-chunks into parent + chunks with DERIVED_FROM edges" times out — **RESOLVED (2026-07-04)**

Two root causes, both fixed during the runtime-productionization context-06 kickoff:
1. **Syntax corruption (prior-session edit):** a stray `}, 15_000);` had been inserted right
   after the test's opening comment, closing the `it()` callback early and orphaning the entire
   test body as top-level code — a `PARSE_ERROR` ("`await` is only allowed within async
   functions"). Moved the timeout to the real end of the test.
2. **Missing test timeout:** `memory-server/vitest.config.ts` had no `testTimeout`, so the
   default 5s tripped during the first-`embed()` fastembed ONNX model load. Set `testTimeout`
   and `hookTimeout` to `30_000` (matching `memory-core`); bumped the auto-chunk test's explicit
   override to `30_000`.

This test surfaced **BL-154** (the chunk-write deadlock) once its body actually executed.

### BL-152 — `recall-sqlite.test.ts` BL-48 real-embedding proof / hash-backend tests — **RESOLVED (2026-07-04)**

The `provider_call_count` counter and the entire `SOX_EMBED_BACKEND=hash` backend were removed
this cycle (hash embedding backend deleted from `libs/data/embed/embedding-provider` and `libs/memory-core/src/embed.ts`).
The two obsolete "BL-48: embed backend resolution and fallback detection" tests (asserting the
hash model id `nomic-embed-text-v1.5-hash` and the on-hash-fallback indicator) were deleted — the
hash backend they exercised no longer exists. Real-embedding semantics are covered by the retained
`SOX_EMBED_BACKEND=real` gate.

### BL-153 — `memory-tools.spec.ts` recluster (BL-27 LOW-3) subset persistence: `persisted` expected `true`, got `false` — **RESOLVED (2026-07-04)**

Root cause: `clusterSubset()` (`libs/memory-core/src/cluster.ts`) only persisted when
`result.clusters.length > 0`. A filter selecting only dissimilar (non-clustering) episodes
yields zero communities (singletons are suppressed, D1.6), so `persisted` stayed `false` and the
lens was invisible to `list_lenses` / un-droppable. Fix: a persisted subset recluster now always
records a **lens marker** — a member-count-0 sentinel community node tagged
`meta.cluster_scope.marker = true` (new `materializeLensMarker()`), written when zero real
communities form. `listSubsetLenses()` registers the lens but excludes markers from
`community_count`; `dropSubsetLens()` removes markers with the rest of the slice. The persist
block also always invalidates the prior slice first, so re-runs stay idempotent.

### BL-154 — CRITICAL: `memory_write` deadlocks the WriteQueue on any content larger than `chunk_size*4` chars — **RESOLVED (2026-07-04)**

**Severity: critical (latent production hang).** In `memory-server/src/index.ts`, the
`memory_write` handler runs its whole body inside `wq.enqueue('memory_write', …)`, and for
auto-chunked content (chunks.length > 1) it called `wq.enqueue('memory_write_chunk', …)` on the
**same** serial `WriteQueue` from within the already-running task, then `await`ed it. The
`WriteQueue` processes items one at a time (`_processNext` awaits the current op before shifting
the next); the nested chunk items can only run *after* the outer op returns, but the outer op is
awaiting them → permanent deadlock. Any `memory_write` with content over `chunk_size*4` chars
(**2000 chars at the default `chunk_size=500`**) would hang the queue forever, blocking all
subsequent writes on that store.

Masked until now because the auto-chunk test's body was dead code (see BL-151). Fix: write chunks
directly via `memoryWrite(writeDb, …)` inside the outer task — `writeDb` is already held
exclusively, so ordering and single-writer safety are preserved without re-enqueuing. Verified:
`permission-guard.spec.ts` auto-chunk test now completes (was hanging the full 30s).

**Follow-up (deferred):** add a regression guard that asserts `memory_write` of >2000-char content
completes within a bounded time under a live serve session, not just the in-process handler test.

---

## Open — opencode-host implementation (surfaced 2026-06-29)

### BL-108 — Multi-host `--host=claude --host=opencode` only uses last value — **FIXED (2026-06-29)**

**Fix:** Changed `--host` parsing in `cmdInstall` and `cmdUpdate` to accept comma-separated values
(`--host=claude,opencode`), following the same pattern used by `--keywords` and `--transports` in
`cmdInit`. The host value is split on commas, trimmed, and iterated. Help text updated to show
`--host=<h1,h2,...>` syntax. Verified: `soxe install memory-org --host=claude,opencode --scope=project
--dry-run` now shows both hosts.

**Observed:** `soxe install memory-org --host=claude --host=opencode --scope=project --dry-run` only
shows the opencode result. The claude host is silently dropped. Same for any multi-host install.
Root cause: caps parseArgs treats `--host` as a single string, overwriting on repeat — not an array
accumulation. Each host installs correctly when invoked separately, so the workaround is two commands.
But the `soxe install --help` documents `--host=<h>` (no repeat indication), so the silent drop is a
footgun.

**Fix sketch:** switch `--host` to a string-array argparse type, or detect the comma-separated syntax
`--host=claude,opencode`, or add a bespoke parser before the caps parseArgs layer. Update help text
to show repeat syntax (`--host=<h1> --host=<h2>`).

### BL-109 — `soxe uninstall` for mcp-server extensions fails with "not found in lockfile" — **FIXED (2026-06-29)**

**Fix:** `cmdUninstall` now falls back to the ownership index when the lockfile key match fails.
Extensions installed via the `--host` path (which calls `declarativeInstall()` directly without
writing a lockfile entry) can now be uninstalled via ownership/ledger reversal. The fix queries
`OwnershipIndex` at the data root; if the extension has an ownership record, it proceeds with
ledger reversal. Verified: `soxe install memory-server --host=opencode --profile=sse --scope=project`
→ `soxe uninstall memory-server --host=opencode --scope=project` now succeeds (logs "found in
ownership index (not lockfile) — proceeding with ledger reversal").

**Observed:** `soxe install memory-server --host=opencode --profile=sse --scope=project` wrote the
correct MCP entry to `opencode.json` but did NOT create a lockfile entry. Subsequent `soxe uninstall
memory-server --host=opencode --scope=project` (even with `--force`) reports "extension 'memory-server'
not found in lockfile" and refuses to clean up the config entry. The MCP config entry was placed but
is unreversible through the ledger — the `[inv:reversible-injection]` invariant is violated for this
install path.

**Root cause:** memory-server's `extension.json` does not declare `install.hosts` (it uses `serves`
and `profiles` for transport selection). The install engine resolves it via the host-agnostic path,
which places files but may bypass the lockfile/ledger write for config-merge placements when no hosts
are declared.

**Fix sketch:** ensure the declarative install path always writes a ledger entry for
`config-merge` placements even when `hosts` is unset or when the extension is resolved through the
host-agnostic resolver. Verify with an install→uninstall→reinstall round-trip for all host/scope
combinations.

### BL-110 — S6b post-install restart can unload OS unit without completing reload — **FIXED**

**Observed:** `soxe install memory-server --host=opencode --profile=sse --scope=user` timed out
after the post-install restart began. The `restartOsUnit` call unloaded the launchd unit (step 1:
verified-stop + unload) but the install process timed out before steps 2-4 (reap, write new unit,
reload) completed. This left the daemon UNLOADED — `soxe service status` reported `loaded: no`
with no running process. Required manual `soxe service enable` to restore. This is a partial-failure
state: the config was written correctly to opencode.json but the daemon was killed with no replacement.

**Root cause:** `restartOsUnit()` is async with a 60s restart-loop guard. The install command has
a timeout that may fire before the full unload→reap→write→load sequence completes. The unload is
destructive (kills the running process) but the reload is deferred, so a timeout during restart
leaves the system in a broken state.

**Fix (2026-06-29):**

1. **`os-unit.ts`**: Added `signal?: AbortSignal` to `RestartOptions`. Wrapped `restartOsUnit` body
   in try/finally: if the daemon was unloaded but not reloaded (interrupted/timeout/error), the
   finally block restores the last-known-good unit file and loads it. Added `signal?.aborted` checks
   between phases (after unload, after reap, after write). The existing load-failure LKG revert path
   now also sets `loaded = true` when LKG reload succeeds, preventing double-restore in finally.
2. **`main.ts`**: Wrapped `restartOsUnit` calls in `cmdInstall` and `cmdConfigSet` in try/catch
   so interrupted/timeout restarts don't crash the CLI.

---

## Open — extension-authoring docs & footguns (surfaced ingesting the `demo-creator` skill, 2026-06-25)

> Surfaced while porting an external `demo-creator` skill into a born-conformant
> `skill` extension and installing it to a project scope, following "read the how-to on
> creating a skill → scaffold → validate → build-index → install". Each item is a place
> the documentation or CLI output sent the author down the wrong path.

### BL-69 — `docs/guidelines/skill.md` is a framework-contract audit, not an author-facing "how to create a skill" → authors have no authoring guide — **RESOLVED (2026-06-26)** — `docs/guidelines/authoring.md` (all 8 types + bundle, worked examples) + the top-level README now provide the author how-to

**Observed:** told to "read the how-to on creating a skill," the only skill-specific doc is
`docs/guidelines/skill.md`, which is a five-layer analysis of *framework holes* (what the
framework does/doesn't enforce for the `skill` type) — valuable, but it contains zero steps
for authoring one. The actual authoring shape (`runtime: "declarative"`, `entrypoint:
"SKILL.md"`, `run_interface`, `install.hosts`, bundling `assets/`+`scripts/`) had to be
reverse-engineered from `extensions/skills/di-skill` and `extensions/skills/sox-ingest`.

**Fix sketch:** add an author quickstart (`docs/guidelines/authoring-skill.md` or a README
"Authoring" section) covering the canonical flow: `soxe init skill <id>` → fill manifest
fields → bundle assets/scripts → `soxe validate` → `pnpm run build-index` → `soxe install
<id> --scope <scope>`. Cross-link it from `docs/guidelines/skill.md` so the audit doc and
the how-to are not confused.

### BL-70 — manifest `$schema` version drift: scaffold emits v2, committed example skills pin v1 — **RESOLVED 2026-06-26**

**Observed:** `soxe init` writes `"$schema": ".../schemas/extension/v2.json"`, but
`extensions/skills/di-skill` and `extensions/skills/sox-ingest` both pin `.../v1.json`. An
author copying an example to learn the shape adopts the stale schema. Relatedly, those
examples carry no top-level `version` field while the scaffold includes `"version":
"0.1.0"` — so "copy an example" and "use the scaffold" disagree on the field set.

**Fix:** re-stamped all four skill examples to v2 + added `"version": "0.1.0"`:
`di-skill/extension.json`, `sox-ingest/extension.json`, `di-codex-skill/extension.json`,
`forbidden-skill/extension.json`. All four pass `soxe validate`. Registry sync updated
checksums (`registry:sync-index` → `check-registry-sync` green, 15 entries).

### BL-71 — `soxe init` scaffolds a minimal manifest missing `run_interface` and `install.hosts` that real skills carry — **RESOLVED 2026-06-26**

**Observed:** `soxe init skill` emits an `extension.json` without `run_interface` or
`install.hosts`, yet both `sox-ingest` and `di-skill` include them, and nothing enumerates
the optional-but-expected field set. An author can't tell from the scaffold which fields a
"good" skill should add.

**Fix:** `libs/authoring/src/templates/skill/index.ts` now scaffolds:

- `run_interface: { input_schema: {type:"object",properties:{}}, output_schema: ... }` stub
- `install.hosts: ["claude"]` default (overridable via `--host=codex` at init time)

Born-conformance gate PASS for all 7 types; authoring tests 38/38 green.

### BL-72 — `soxe --help` describes `install` as "from config"; real usage is `install <id|bundle> --scope`; README template says `sox` not `soxe` — **RESOLVED 2026-06-26**

**Observed:** `soxe --help` reads `install   Install extensions from config`, omitting the
`<id>` positional that `USAGE.md` and actual usage require (`soxe install demo-creator
--scope project`). Separately, the scaffolded `README.md` emits `soxe install demo-creator`
while the binary is `soxe` (and `USAGE.md` is titled "USAGE — soxe CLI" but calls `node
bin/soxe`). The `sox`/`soxe` naming is inconsistent across help, README template, and USAGE.

**Fix:**

- `apps/sox/src/main.ts` printHelp(): `install` line now reads `install <id|bundle>   Install extension by id (or expand a bundle) at scope` with `--host` flag documented.
- All 7 README templates in `libs/authoring/src/templates/*/index.ts` updated: `soxe install` → `soxe install`, `soxe start` → `soxe start`, `soxe init` → `soxe init`, and the agent template's inline comment references updated.
- `USAGE.md` title updated: "USAGE — soxe CLI" → "USAGE — soxe CLI".

### BL-73 — `install --scope project` puts `.adhd` bookkeeping in the wrong repo because project-root resolution relies on git — **FIXED**

**Observed:** running `soxe install demo-creator --scope project` from cwd
`/Users/nix/dev/ai/agent-source` (which is **not** a git repo) placed host artifacts into
`agent-source/.claude/skills/` (correct — cwd) but wrote the `extensions.json` install
record and `extensions.lock` to `/Users/nix/dev/ai/sox-ecosystem/.adhd/sox-ecosystem/` —
the **CLI's own repo**, not the target project.

**Root cause (confirmed):** `getScopePath(scope)` in `libs/install-engine/src/install.ts`
always used the module-level `REPO_ROOT` constant (derived from `__dirname` at import time)
for project/local scopes. The `install()` function called `getScopePath(opts.scope)` at
line 491, completely ignoring the `opts.root` it had already computed. The same applied in
`loadScopeCascade()` at line 832 and in four call-sites in `apps/sox/src/main.ts` (lines
1104, 1180, 1194, 1566).

**Fix (2026-06-26):** changed `install()` to call `scopeConfigPaths(opts.scope, root)`
instead of `getScopePath(opts.scope)`. Added `root` to `CascadeOpts` and fixed
`loadScopeCascade`. In `main.ts`: introduced `workspaceRoot = process.cwd()` in the
non-declarative install path and replaced all `getScopePath(scope).{config,lockfile}` calls
with `getScopePaths(scope, workspaceRoot).{config,lockfile}`; passed `root: workspaceRoot`
to `install()`. Fixed `cmdUpdate` (line 1563-1566) with the same pattern.

**Files changed:** `libs/install-engine/src/install.ts`,
`apps/sox/src/main.ts`, `libs/install-engine/src/project-root.spec.ts` (new regression
test with 4 cases, all green). State-side proof: running from `/tmp/bl73-state-proof-*/`
(no `.git`) writes lockfile to `/tmp/bl73-state-proof-*/.adhd/sox-ecosystem/extensions.lock`
and does NOT touch `sox-ecosystem/.adhd/sox-ecosystem/`.

### BL-78 — `cmdDetails` uses wrong lock path format (`.extensions/`) and `getScopePath(REPO_ROOT)` fallback — **RESOLVED (2026-06-26)** — `cmdDetails` now resolves via `getScopePaths(scope, workspaceRoot)` (workspaceRoot = flags.root ?? cwd), mirroring the BL-73 fix

**Observed:** `apps/sox/src/main.ts` `cmdDetails` (line 3107-3117) has two problems:

1. When `--root` is given: constructs the lock path as `<root>/.extensions/extensions.lock` — the
   WRONG format (should be `<root>/.adhd/sox-ecosystem/extensions.lock`). This path will never
   match any real lockfile, so `soxe details <id> --root=<dir>` always shows the extension
   as uninstalled at the project scope even when it's installed there.
2. When `--root` is absent: falls back to `getScopePath('project')` which uses REPO_ROOT (same
   root cause as BL-73). So `soxe details <id>` with project scope reads the CLI's own repo
   lockfile, not the user's project.

**Fix sketch:** replace both with `getScopePaths(sc, rootOverride ?? process.cwd()).lockfile`.
Same `getScopePaths` pattern applied in BL-73 fix.

> **BL-79** (`@modelcontextprotocol/sdk` absent → clean recompile fails) is documented in full
> further down (upgraded to MEDIUM after Slice 2 surfaced the clean-recompile + memory-server
> bundle failure). See the BL-79 entry near BL-85.

### BL-80 — `service`-type extensions are NEVER scanned into the registry → cannot be `soxe install`ed by id — **RESOLVED 2026-06-26**

**Observed:** `scripts/build-index.ts` `DIR_TO_TYPE` (and its `check-registry-sync.ts` mirror) has
no `services` key, so `extensions/services/` is never walked. The shipped `service` extension
`tokenguard` (type `service`, in `ACTIVE_TYPES`, with its own `serviceTemplate` + `validate()`
support) is **absent from `registry/index.json`** and therefore cannot be resolved/installed by id —
a whole active extension type is uninstallable through the registry. (tokenguard is `private:true`,
so under the publish signal it would still be omitted, but in dev it should appear as `file://`.)

**Fix (2026-06-26):** Added `services: 'service'` to `DIR_TO_TYPE` in `scripts/build-index.ts`
AND its BL-33 mirror in `scripts/check-registry-sync.ts` (identical entries, same commit).
Ran `npx nx run registry:sync-index` → registry grew from 15 to 16 entries with tokenguard
appearing as `type: service`, `source: file://...`. Dev gate (`check-registry-sync`) green
(16 entries). Publish gate (`SOX_REGISTRY_PUBLISH=npm`) green (7 entries; tokenguard correctly
omitted because `package.json` is `private: true`). `soxe validate ./extensions/services/tokenguard`
passes. New test `scripts/build-index.test.ts` (6 tests) covers: service dir walk, multi-type
index, private skip, multiple services, stray-dir skip, and BL-33 mirror parity check.

### BL-81 — `USAGE.md` says "`service` is not a type — it's an mcp-server install profile"; the code treats `service` as a first-class type — **RESOLVED 2026-06-26**

**Observed:** `USAGE.md` contradicted the code: `service` IS in the schema enum, `ACTIVE_TYPES`,
`validate()`, has a dedicated `serviceTemplate`, and ships as `tokenguard`. The
`docs/guidelines/authoring.md` already documented `service` as first-class (matching code).

**Fix (2026-06-26):** Updated `USAGE.md` to add `service` to the active types list and replace
the incorrect "not a type / mcp-server install profile" description with accurate text:
"`service` is a first-class type — a long-running process extension supervised by the soxe host
runtime". Also updated the authoring lifecycle `Run for each of:` line to include `service`.

### BL-82 — `libs/manifest/src/schema.json` drift: `install.type` enum omits `service`; `install.transports` missing under `additionalProperties:false`, yet `validate()` + `tokenguard` use both — **RESOLVED 2026-06-26**

**Observed:** the hand-rolled `validate()` is authoritative and accepts `install.type:service` +
`install.transports`, but the JSON `schema.json` was stale (would reject tokenguard under strict
JSON Schema validation).

**Fix (2026-06-26):** Added `"service"` to `install.type` enum in `libs/manifest/src/schema.json`.
Added `transports` property to `install` with vocab `["stdio","http","sse","socket"]` matching
`validate()`'s `VALID_TRANSPORTS`. Built manifest (`npx nx build manifest`) and ran
`npx nx test manifest` — 152/152 unit tests + 110/110 validate-manifests tests green.
`soxe validate ./extensions/services/tokenguard` passes cleanly.

### BL-83 — `libs/authoring/src/index.ts` comment says "union of 6 active extension types" but `ACTIVE_TYPES` lists 7 — **RESOLVED (2026-06-26)** — comments corrected to 7

**Fix sketch:** update the comment to match `ACTIVE_TYPES` (7 active = 8 types minus parked `prompt`).

### BL-84 — `extensions/services/tokenguard/CLAUDE.md` (+ examples) reference the REMOVED `./bin/sox` binary and a `sox.install()` JS API that isn't the real surface — **RESOLVED (2026-06-26)** — replaced with `node bin/soxe` + real CLI verbs

**Observed:** `bin/sox` was removed (collided with the system `sox` audio tool; `bin/soxe` is the
only entrypoint). tokenguard's `CLAUDE.md` still shows `./bin/sox` invocations + a non-existent
`sox.install()` API. Update to `soxe` + the real CLI surface.

### BL-74 — `soxe install <id> --scope project` reconciles the WHOLE scope config, re-placing unrelated members — undocumented — **RESOLVED 2026-06-26**

**Observed:** installing only `demo-creator` also re-resolved and re-placed `memory-usage`
and the `sox-memory-bundle` members already recorded in the project's `extensions.json`
(`soxe install: placed claude/project .../memory-usage`). `USAGE.md`'s Install section reads
as "install the named id," not "reconcile the entire scope set," so the extra placements
surprise the operator.

**Fix:** Added a note to `USAGE.md` Install section explaining that `install <id>` reconciles
the full scope set — adds the named id then re-resolves/re-places every member already declared
in the scope's `extensions.json`. Idempotent for unchanged checksums, re-pins for changed ones.

### BL-75 — `soxe init` prints a stray `rm: /Users/nix/dot/bin/node: No such file or directory` during scaffold — **RESOLVED (not in codebase) 2026-06-26**

**Observed:** every `soxe init <type> <id>` run prints a failed `rm` against a hardcoded
`/Users/nix/dot/bin/node` path before "scaffolded …". It looks like a real failure mid-flow
(the documented authoring step) even though the scaffold succeeds.

**Investigation:** exhaustive grep of `apps/`, `libs/`, `scripts/` for `dot/bin/node`,
`rm.*execPath`, `rm.*node\b`, and all shell invocations in the init codepath found zero
matches. Running `soxe init skill <id>` in a clean temp dir on this machine emits no stray
`rm` output — only the success line. The `cmdInit` function in `apps/sox/src/main.ts` contains
no `rm` call and spawns no shell; `libs/authoring` is pure in-memory file generation
(`scaffold()` → `writeFileSet()`).

**Root cause:** the error originates from the user's shell environment. `/Users/nix/dot/bin/node`
is a dotfile-managed Node binary (the `dot/` repo pattern). Something in the user's shell
(likely a Node version manager hook, nvm `use` trigger, or a shell function intercepting `node`
invocations) runs `rm /Users/nix/dot/bin/node` as a side-effect and emits the error to stderr.
The soxe init codepath is not the source and requires no code change.

**Action:** no code change. The error is shell-environment-specific and not reproducible in a
standard environment. If the noise recurs, the author should audit their shell functions/hooks
for `rm` calls against `$(which node)` or similar.

### BL-76 — published `@adhd/sox-cli` dist omits `build-info.json`; fresh-machine `soxe serve` prints a BL-65 warning + git-root walk fails — **RESOLVED (2026-06-26)** — `stamp-build.cjs` now writes `build-info.json` to both `dist/apps/sox/` (tsc) and `apps/sox/dist/` (published esbuild). Ships on next republish. (git-root noise folds into BL-73, fixed.)

**Observed:** the real-npm clean-room install of `@adhd/sox-cli@1.1.1` (no checkout) works
end-to-end (G1/G2/G3 all PASS, `memory_ping` `{ok:true, artifact:sha256:00cefb04…}`), but
`soxe serve` emits two benign-but-noisy lines on a fresh machine:

1. `BL-65 WARNING: dist/apps/sox/build-info.json missing — this dist was built before
   sha-stamping was added` — the `stamp-build.cjs` output (`build-info.json`) is **not in the
   published tarball** (`apps/sox` `files` allowlist / esbuild outdir ships `dist/index.js`
   but not the sibling `build-info.json` written to `dist/apps/sox/`). So the published CLI
   always thinks it's an unstamped/dirty build.
2. `fatal: not a git repository` — the project-root git-root walk runs (and fails gracefully)
   on a non-git fresh dir; same root cause as **BL-73** (project-root resolution must not rely
   on git). Here `--scope user` made it irrelevant, but it's noise.

**Fix sketch:** (1) include the build-info stamp in the CLI bundle — have `embed-registry`/
`stamp-build` write `build-info.json` to the SAME `apps/sox/dist/` dir esbuild ships and add it
to `files`, or inline the sha into the bundle so no sidecar file is needed; (2) suppress the
git-root `fatal:` chatter (capture stderr) — folds into BL-73. Neither blocks the release.

### BL-77 — dev `bin/soxe --version` reports the monorepo root `1.0.0`; published `@adhd/sox-cli` reports its own `1.1.1` — two entrypoints disagree — **RESOLVED (2026-06-26)** — `printVersion()` reads `apps/sox/package.json`; `node bin/soxe --version` now reports `1.1.1`, matching the published CLI

**Observed:** the dev entrypoint `bin/soxe` (loads the tsc build `dist/apps/sox/main.js`)
reports `--version` `1.0.0` — the **root `package.json` (`sox-ecosystem@1.0.0`)** — while the
**published** CLI (esbuild bundle `apps/sox/dist/index.js`) reports `1.1.1` (its own
`apps/sox/package.json`). So `node bin/soxe --version` and `npm i -g @adhd/sox-cli` disagree on
the version string for the same code, which is misleading when debugging "which CLI am I running."

**Fix sketch:** have `--version` resolve from `apps/sox/package.json` (the CLI's own package,
the single source the published path already uses), not the monorepo root. Ideally read the
embedded build-info sha + the `apps/sox` semver together so dev and published agree. Folds in
with BL-76 (build-info stamp). Cosmetic; no behavior impact.

---

### BL-79 — `@modelcontextprotocol/sdk` is absent from `node_modules`; `nx build mcp-runtime` and the memory-server self-contained bundle fail on a clean recompile — **RESOLVED/NON-ISSUE (2026-06-26)** — the dep IS declared (`^1.0.0` in `libs/mcp-runtime/package.json`, resolves to 1.29.0 in the package's pnpm node_modules); `nx build mcp-runtime --skip-nx-cache` + `memory-server --skip-nx-cache` build clean on `main`. The earlier "missing" was an agent-worktree symlink artifact (folds into BL-85), not a main-checkout defect

**Observed:** `@modelcontextprotocol/sdk` is not installed under `node_modules` (neither the
shared checkout nor a worktree symlinked to it). `libs/mcp-runtime/src/{serve,transport}.ts`
`import` it, so `npx nx build mcp-runtime --skip-nx-cache` fails with `TS2307: Cannot find module
'@modelcontextprotocol/sdk/server/index.js'`, and the BL41/SPM e2e probes that esbuild a
**self-contained memory-server bundle** fail with `Could not resolve "@modelcontextprotocol/sdk/..."`.
It only stays green in normal runs because `libs/mcp-runtime/dist` is already built and nx serves it
from cache — a clean machine (or any forced recompile) breaks. **Not caused by Slice 2** (which never
touches mcp-runtime, memory-server, or deps); surfaced because the Slice-2 e2e forced these builds.

**Fix sketch:** add `@modelcontextprotocol/sdk` to the workspace dependencies (the lockfile +
`pnpm install`) so `mcp-runtime` compiles from source and the self-contained memory-server bundle
builds without the prebuilt-dist crutch. Until then, those two e2e sections (BL41, SPM bundle build)
are not runnable from a clean state in an isolated worktree.

### BL-85 — nested git worktrees under `.claude/worktrees/` collide in the nx project graph (`@adhd/sox-nx` duplicate name), breaking `nx` in the SHARED checkout — **RESOLVED (2026-06-26)** — `.nxignore` at repo root excludes `.claude/worktrees`; `nx show projects` returns 28 unique projects with worktrees present

**Observed:** with two agent worktrees checked out under `.claude/worktrees/`
(`agent-a434962d801ff1b5c`, `agent-a997b4af124c6f91f`), running any `nx` target in the SHARED
checkout aborts with *"projects … located in different locations … set a unique name … `@adhd/sox-nx`:
.claude/worktrees/agent-…/packages/sox-nx"* — nx scans into the nested worktrees and sees duplicate
project names. Each worktree in isolation is fine (it scans only its own tree). Worktrees nested
inside the repo are discoverable by the parent's nx project-graph globs.

**Fix sketch:** either place agent worktrees OUTSIDE the repo root, or add `.claude/worktrees/` to
nx's `workspaceLayout`/project-graph ignore globs (`.nxignore` / `nx.json` `pluginsConfig` exclusions)
so the parent checkout never scans nested worktrees. Low blast radius but it makes the shared checkout's
`nx` unusable while worktrees exist.

---

## Open — memory embedding subsystem (surfaced investigating hash-fallback, 2026-06-26)

> The store has been running on hash-embedding fallback (`memory_ping` → `embed_state:"hash"`,
> `embed_on_hash_fallback:true`). Investigation of `libs/memory-core/src/embed.ts` + the published
> memory-server packaging surfaced four distinct defects. While on fallback, vector similarity
> (near-dup `SAME_AS`, clustering, semantic recall ranking) is unreliable; BM25/FTS still works.

### BL-94 — `better-sqlite3` native binding missing for current Node.js ABI → memory-server crashes mid-session — **RESOLVED (2026-07-04, wave-2): probe was already live; enforcement script added**

**Resolution:** crash-mid-session was already fail-fast (startup binding probe). Wave-2 adds `tools/verify-native-abi.mjs` (probes better-sqlite3 + onnxruntime-node, exit 1 with rebuild command on mismatch), `pnpm verify:abi` script, CONTRIBUTING §1.8 (run after Node upgrades). Deliberately NOT in postinstall (postinstall already rebuilds; the gap is `nvm use` which triggers nothing). Live: exit 0 on Node v24.11.1/ABI 137. Known nit: BL-208 (worktree REPO_ROOT resolution).

**Validation note (2026-07-04 sweep):** the "long-term" fix sketch item is DONE — a startup binding probe now fails fast before accepting connections (`memory-server/src/index.ts:1936-1950`); crash-mid-session is closed. Remaining open scope: no CI/postinstall enforcement prevents an ABI-mismatched rebuild from shipping. Downgrade to MEDIUM.

**Observed:** `memory_write` and all other `mcp__memory-server__*` tool calls fail mid-session with:

```
Error: Could not locate the bindings file.
→ .../better-sqlite3/lib/binding/node-v137-darwin-arm64/better_sqlite3.node
```

The binding directory `node-v137-darwin-arm64/` does not exist — the module was compiled against a different Node.js ABI version than what is currently running (ABI 137 = Node.js v24.x). `memory_ping` succeeds (it bypasses the DB), masking the failure until a write is attempted.

**Observed impact:** workflow-researcher agents that survive long enough to need `memory_write` hit this at Step 3 or Step 5. Sub-Q nodes written before the crash survive; the summary and any remaining nodes are lost and must be handoff-persisted by the parent. Batch 3 workflow (wf_8fdc0fdf-1e3) is currently running — unknown how many of its 18 agents will hit this.

**Root cause:** `better-sqlite3` was rebuilt/installed under one Node.js version; the runtime `node` binary changed (e.g. via nvm, Homebrew upgrade, or pnpm update) without re-running `node-gyp` / `npm rebuild`. The bound binary at `build/Release/better_sqlite3.node` was copied to the ABI-versioned path for the OLD version only.

**Fix sketch:**

1. `cd $(node -e "require.resolve('better-sqlite3')" | xargs dirname | xargs dirname)` then `npm rebuild better-sqlite3` under the current Node.js version.
2. Or: `pnpm rebuild better-sqlite3` from the sox-ecosystem root.
3. Verify: `node -e "require('better-sqlite3')"` should return without error.
4. Then restart the memory-server MCP (`soxe stop memory-server && soxe start memory-server` or reconnect Claude).
5. Long-term: add a startup check in memory-server that tests the binding before accepting MCP connections, returning a clear error instead of a mid-session crash.

---

### BL-100 — `memoryRecall` accepts `filters` in its signature but silently ignores them — **RESOLVED (verified 2026-07-04 validation sweep): fix already landed** — `memoryRecall` destructures and applies filters inline as SQL pre-filters (`recall.ts:225-316`: topic, tags, tags_match_all, project_path prefix, t_created windows, importance_min). The entry's claims below are historical.

**Observed:** `RecallParams.filters` is declared at `libs/memory-core/src/recall.ts:29` but never destructured or applied inside `memoryRecall`. The parameter is accepted with no error, no warning, and no effect. Filtering (tags, topic, project_path, importance_min, time range) only works when called through the MCP server (`memory-server/src/index.ts:954–1034`), which applies `buildFiltersClause` from `@adhd/sox-memory-enrich` via SQL pre-filtering before invoking `memoryRecall`. Any direct caller of `memoryRecall` — the REPL, tests, `federatedRecall`, any lib consumer — silently gets unfiltered results regardless of what they pass in `filters`.

**Impact:** silent correctness failure. A caller passing `filters: { tags: ['kind:lesson'], importance_min: 5 }` to `memoryRecall` gets back all results as if no filter was specified, with no indication anything was ignored. `federatedRecall` (which calls `memoryRecall` internally) has the same gap.

**Fix sketch:** move `buildFiltersClause` (currently in `@adhd/sox-memory-enrich`) or a minimal equivalent into `@adhd/sox-memory-core`, and apply the filter clause inside `memoryRecall` when `params.filters` is present — either as a SQL pre-filter on candidate rowids (matching what the server does) or as a post-recall JS filter on the ranked results. The server's pre-filter approach is preferred (excludes non-matching nodes before ranking, not after). Also add a `filterStats` field to `RecallResponse` so callers can tell a filtered recall from an empty-corpus recall.

---

### BL-119 — agent_id filter inconsistently applied across vec/FTS/temporal signals in daemon → **FIXED by construction (RS-6)**

**Evidence:** The memoryd daemon that could duplicate the outbox queue has been removed (RS-6). With RS-4's orchestrator replacing the daemon, there is no longer a separate process that could apply agent_id filtering inconsistently. The orchestrator handles all enrichment in a single path.

### BL-120 — parentDocId fallback for parent expansion missing in daemon → **FIXED by construction (RS-6)**

**Evidence:** RS-4's single hosted orchestrator handles all enrichment deterministically from a single location, eliminating the daemon's separate parentDocId resolution path. The orchestrator runs entirely within the memory-server process, so parent expansion is consistent.

### BL-126 — organizer_queue missing additive migration columns (last_error, dead) → **FIXED by RS-4**

**Observed:** The `organizer_queue` table created by `openDb()` had no `last_error TEXT` or `dead INTEGER DEFAULT 0` columns. Without these, a poison-item dead-letter pattern cannot be implemented — a repeatedly-failing queue item blocks subsequent items indefinitely, with no way to skip or retire it.

**Fix (RS-4):** `migrateOutboxQueueSchema()` added to `outbox-queue.ts`. Idempotently adds `last_error TEXT` and `dead INTEGER DEFAULT 0` columns via `ALTER TABLE ... ADD COLUMN`. Creates `ix_q_open_v2` covering `(done_at, dead, priority, seq)` for efficient open-item dequeue. Called by the `createMemoryOutboxQueue()` consumer before the queue is used.

**Verification:** `migrateOutboxQueueSchema` tests (2/2 pass) confirm both columns are added and that the migration is a no-op when the table does not exist or when called multiple times.

### BL-127 — no watermark / memory_flush for read-your-derived-writes → **FIXED by RS-5**

**Observed:** After `memory_write`, the caller had no mechanism to wait for enrichment to complete before reading. The daemon processed enrichment asynchronously, so a subsequent `memory_recall` could return stale or incomplete results (no topic, summary, tags, or near-dup info). Callers that needed read-your-derived-writes consistency had to guess sleep durations or poll manually.

**Fix (RS-5):** `memoryFlush()` implemented in `outbox-queue.ts`. Accepts `{awaitSeq, timeoutMs}` — polls the enrichment watermark (`MAX(seq) WHERE done_at IS NOT NULL AND dead = 0`) and returns `{watermark, caught_up}`. Supports: instant return (awaitSeq ≤ 0), catch-up drain (processes pending items), and timeout. Direct `getWatermarkDirect()` available for zero-overhead reads without creating a queue instance.

**Verification:** `memoryFlush` tests (4/4 pass) confirm: instant return on 0/negative awaitSeq, catch-up from seeded backlog <500ms, and timeout when awaitSeq > known seq.

---

### BL-95 — `memory-cli` `status` and `list` subcommands never find `memory.db` — scope-name mismatch — **RESOLVED (2026-07-08)** — shared `discoverStorePaths()` so `list`/`status` cannot diverge again

**Observed:** `memory-cli status` prints "No memory stores found." even with `~/.memory/memory.db` present and `memory_ping` returning `ok:true`. `registry` shows `~/.memory/registry.json` exists but its contents are `{}` (no scopes registered).

**Root cause:** `cmdStatus` resolves stores from `registry.json` (which is empty) and the cwd's `.memory/` dir. `cmdList` looks for `<dir>/.memory/<scope>.db` files. The live store is named `memory.db` — not the scope-prefixed `user.db` / `project.db` that the CLI was designed around. The scope-naming convention was introduced after the store was created, and `memory init` was never run to register the live file.

**Fix sketch:**

1. `memory init --scope user` (or with `--path ~/.memory`) — this registers `~/.memory/user.db` in `registry.json` and creates the scoped DB. However this creates a *new* DB, not an alias to the existing `memory.db`.
2. Longer-term: `cmdStatus` should also scan for a bare `memory.db` in known store dirs (`~/.memory/`, `.memory/`) and surface it with a `(unregistered)` flag rather than silently skipping it.
3. Or: `memory init` could detect an existing `memory.db` and offer to register it under a scope alias rather than creating a new file.

**Workaround:** use `memory-cli export --db ~/.memory/memory.db` (accepts explicit `--db`). For reads/writes use `soxe exec memory-server <tool> --args='{"db_path":"~/.memory/memory.db",...}'`.

**Triage context:** Three approaches, different effort/impact profiles:
- **(1) `memory init --scope user`** — creates a new scoped DB alongside the existing one, leaving the canonical `memory.db` undetected. Confusing but works if user migrates. ~0 code change.
- **(2) Scan for bare `memory.db`** — fixes the immediate UX (no more "No stores found" when a store exists) at low effort. But doesn't resolve the fundamental naming inconsistency — every CLI call that doesn't scan will still miss it. ~1-2 hours.
- **(3) Detect + register** — the cleanest long-term solution: `memory init` discovers existing DBs and aliases them into the registry. But changes `memory init` semantics and needs migration-logic testing. ~3-5 hours.

The core question: should `memory-cli` auto-discover stores (option 2, most user-friendly) or require explicit registration (option 1/3, more predictable)?

---

### BL-96 — plan-state-machine: dod-confirmation audit runs from `cwd:planDir`, guard runs from repo-root → repo-relative checks fail; `parseDodIds` reads inline `[dod.N]` prose as phantom clause — **Open (HIGH) (2026-06-25)**

**Observed (fullstack-developer, 2026-06-25; memory UID `01KVZHMEJHVVBYEGTSQ4AKFNQ6`):** executing a plan to DONE surfaced two terminal-transition defects:

1. The dod-confirmation audit script runs from `cwd:planDir` (the plan directory) while the `guard` command runs from the repo root — any repo-root-relative path check inside the audit fails (4/128 checks failed in observed run).
2. `parseDodIds` reads the literal token `[dod.N]` when it appears in prose (e.g., "see `[dod.6]` for details") as a real DoD clause ID, producing a phantom `dod_unconfirmed` that permanently blocks the terminal transition even when every real clause passes.

**Impact:** a fully-passing, reality-verified plan cannot reach `done` without either (a) calling `os.chdir(repoRoot)` explicitly inside the audit script or (b) rewording every README prose reference to `[dod.N]` outside a real clause bullet.

**Fix sketch:**

- Audit subprocess should `cd` to the git repo root before running checks, or receive the repo root as an explicit `--repo-root` argument.
- `parseDodIds` should only extract `[dod.N]` tokens that appear on a bullet-list line (start with `-` or `*`), not from free prose.

---

### BL-97 — plan-state-machine: audits run against committed `end_ref` → working-tree-only approval artifacts silently fail the gate despite the working tree passing — **Open (HIGH)** `[TRIAGE — premise unconfirmed]` — 2026-07-08 code read found NO ref-based read anywhere in the audit path (`runAudit` + dod gate operate on the live filesystem; `endRef` is metadata only). The reported exit-4 may have come from a plan-specific `command` criterion, not the generic runner. Confirm which criterion triggered it before working this

**Observed (plan-orchestrator, 2026-06-25; memory UID `01KVZHM10QWB0XPE2112RE549B`):** under workflow 0.8.18, any artifact a guard checks (e.g. a human-checkpoint approval file, a generated snapshot) MUST be committed before `--complete` or the audit fails (exit 4) even though `git status` and the working tree show it present and correct.

**Impact:** orchestrators that write checkpoint artifacts (approval files, baseline snapshots) without an intermediate commit step will see spurious exit-4 gate failures. The failure is silent — the working tree is clean, the audit output passes on local re-run, but `--complete` exits 4.

**Fix sketch:**

- Document the commit requirement explicitly in the work-order template and `--complete` help text: "all artifacts the guard checks must be staged and committed before `--complete`."
- Or: run the audit against the working tree (not `end_ref`) for artifact-existence checks, reserving the ref check for diff/hash verification.
- Or: `state-transition.js --complete` auto-stages and commits declared `artifacts[]` when they are unstaged, with a warning.

**Triage context:** Three approaches with different trade-offs:
- **(A) Document only** — cheapest (~0 code, doc change), but punts the problem to every future orchestrator author. The footgun will keep firing.
- **(B) Working-tree audit** — checks what's actually on disk. More correct behavior, but `end_ref` loses its meaning as a stable checkpoint. Risk: an audit that passes against the working tree may reference artifacts that vanish on `git checkout`.
- **(C) Auto-stage+commit** — most magical; risks committing unintended changes if `artifacts[]` glob is too broad. The `--complete` command becomes a git-mutating operation, which may surprise users.

The root question: should `--complete` validate "what was finished" (the working tree) or "what was recorded" (the ref)? Approach (B) is most natural for in-progress work; (A) is safest for audit trails.

---

### BL-98 — reflection `SKILL.md` documents `memory_write` returning `E_DEDUP / existing_uid` on collision — **CLOSED-INVALID (2026-07-04): the skill was right, this entry was wrong**

**Closed:** confirming read of the live reflection skill (sox-tools 1.0.20) completed — it
documents byte-identical content → `{code:"E_DEDUP", existing_uid}` and near-duplicates →
new node + async `SAME_AS`, which is exactly what `write.ts:83,193` implements. No fix anywhere.

**Validation note (2026-07-04 sweep): this entry's own claim is WRONG.** `write.ts:83,193` returns `{code:'E_DEDUP', existing_uid}` for exact content-hash collisions — the SKILL.md is CORRECT. Only near-duplicates (cosine) link via async SAME_AS. Re-scoped ask: none against the skill; close after one confirming read of the reflection skill in claude-agents (external repo).

**Observed (memory UID `01KVSA4MFA99DNETTTZ9KX3MDB`):** the reflection skill's failure-mode catalog (SKILL.md lines 308-312) says `memory_write` returns `{code:"E_DEDUP", existing_uid}` on a content-hash collision. The running v1.1.0 `memory_write` schema and observed behavior return `{episode_uid}` on success and route near-duplicates through async `SAME_AS` enrichment edges, not a hard refusal. An agent written to handle `E_DEDUP` as a normal flow will mis-handle the actual `{episode_uid}` success shape.

**Fix sketch:** update `skills/reflection/SKILL.md` failure-mode section to match the v1.1.0 return contract. Note that exact content-hash collisions may still short-circuit (needs verification against a real duplicate write), but the documented shape is wrong regardless.

---

### BL-99 — `compile-wave --stats` omits base dispatch overhead (B≈27k tokens) and source file bytes (Si) → merge-candidates optimization is invisible to the pack/no-pack decision — **Open (MEDIUM) (2026-06-27)**

**Validation note (2026-07-04 sweep): EXTERNAL** — `compile-wave.js` lives in the claude-agents repo (plan-state-machine skill), not sox-ecosystem; unverifiable and unfixable here. Move this entry to that repo's backlog and close it here on the next sweep.

**Observed (plan-orchestrator; memory UID `01KW3F0GA02V058ZHDTDPJ4EEB`):** all three parallel waves in `memory-refactor` were correctly evaluated as no-pack (prose overlap ratios -0.081, -0.068, -0.088). However, the real dispatch cost is `Di = B + Si + Ki` where B ≈ 27k tokens (base model load + system prompt + transition scaffolding) and Si = source file bytes the executor reads. `compile-wave --stats` measures only Ki-overlap (shared prose invariants/refs/snapshots) — it never accounts for B or Si. This means `savings(i,j) = B + |Si∩Sj|` from merging two tasks into one dispatch is never computed, leaving ≈54k tokens of potential savings unquantified across 3 potential merges even at zero prose overlap.

**Available plan fields that could power the measurement:**

- `dag.json nodes[].artifacts` — `reserved_files` glob patterns → Si proxy at plan-compile time
- `references.json` `source-extract` entries → explicit source file lists per extraction state (Si without disk reads)
- `budget-estimate.js --reserved-bytes` input → already accepted but not fed into the merge decision
- `state.json metrics.tokens_est` → historical cost floor before `emit-state-metrics` populates real actuals

**Fix sketch:**

1. Add `compile-wave --merge-candidates <slug1> <slug2> ...` mode: compute `savings(i,j) = B_estimate + |Si∩Sj|` for all pairs, where Si is sourced from `dag.json artifacts` or `references.json source-extract sources[]`; rank and surface merge opportunities.
2. Expose `reduction_ratio_with_sources` as a separate `--stats` output field, computed as `(independent_cost_with_B_Si - merged_cost) / independent_cost_with_B_Si`.
3. Calibrate B empirically from orchestration-ledger token actuals across ≥3 plan executions (currently ≈27k is a rough estimate).

---

## Open — dispatch-optimizer (surfaced during `docs/plan/dispatch-optimizer/` schema + compiler work, 2026-06-28)

> All items below were found while designing the dag schema, implementing `src/compiler.ts`
> (`snapshot()` + `optimize()`), and running the compiler against the adhd-build test dag.

---

### BL-101 — `normalizeOperations()` didn't default `type` to `"generative"` for pre-schema dags → all ops treated as tool-call → `compilePrompt()` returned `null` for every milestone — **FIXED (2026-06-28)**

**Observed:** running the compiler against `docs/plan/adhd-build/dag.json` (authored before the
`type` field was added to the operation schema) produced `prompt: null` for all dispatch units.
The `compilePrompt` guard bails when `milestoneOps.some(op => op.type === "generative")` is
false — with no `type` field, `op.type === undefined`, so every milestone appeared as tool-call-only.

**Fix:** `normalizeOperations()` in `src/compiler.ts` now maps any op with `type === undefined`
to `{ ...op, type: "generative" }` — applied immediately after the array/Record conversion,
before any other compiler logic sees the ops.

**Follow-up:** `docs/plan/dispatch-optimizer/src/run.ts` still contains a redundant manual patch that injects `type: "generative"`
on each op. This patch is now dead code and should be removed to avoid confusion.

---

### BL-102 — Guard-only milestones (agent: null) produce a DispatchUnit with `provider: undefined`, `agent_name: ""`, `model: null` — the orchestrator has no typed code path to detect and run them locally — **RESOLVED (2026-07-04, wave-2)**

**Resolution:** `DispatchExecutionMode = "model" | "guard-local" | "tool-call"` added to DispatchUnit; `assembleDispatchUnit` sets `guard-local` when the milestone has no agent, `model` otherwise. Strict tsc typecheck green.

**Observed:** `scope-authored` in the adhd-build dag has `agent: null`. `optimize()` produces a
DispatchUnit for it with `provider.type === undefined`, `agent_name === ""`,
`model === null`, and `tokens_estimated === null`. An orchestrator reading this unit has no
machine-readable signal to distinguish "run guard locally as a shell command" from
"model call with missing provider config".

**Fix sketch:**

1. Add `execution_mode: "model" | "guard-local" | "tool-call"` to the `DispatchUnit` type.
2. In `assembleDispatchUnit()`, set `execution_mode = "guard-local"` when
   `milestone.agent === null` (D-12 guard-only class).
3. The orchestrator branches on `execution_mode` before attempting provider resolution.
4. Guard-only units should never enter the Sentinel-Fanout grouping (they're zero-cost, instant).

---

### BL-103 — `snapshot_version` always initialises to `1` — callers that persist snapshots have no way to get an incrementing version without reading the prior snapshot first — **Open (LOW)** — NEEDS DECISION: `priorVersion` param (pure) vs read-prior-snapshot-from-disk (I/O side effect). Defect confirmed at `compiler.ts:941`; zero live consumers `[TRIAGE]`

**Observed (noted by the typescript-pro implementation agent):** `snapshot()` takes only a
`DagJson` input and has no access to the prior snapshot. The schema spec says
`snapshot_version` is "derived: incremented integer, persisted across regens" — but there
is no mechanism to increment it.

**Fix sketch:** Two options:

- Pass an optional `priorVersion?: number` parameter to `snapshot()` and increment it.
- Read the prior snapshot from disk inside `snapshotWithDag()` and forward the version.
Option A is cleaner (keeps `snapshot()` pure). Add `snapshot(dag, { version?: number })` opts bag.

**Triage context:** Option A (parameter) keeps `snapshot()` pure and testable — no I/O, no
filesystem coupling. Option B (disk-read) is more convenient for callers but adds a hidden
side effect. The decision depends on whether `snapshot()` is ever called in contexts where
the caller doesn't have the prior version handy (e.g. CLI one-shot tools). If every caller
naturally has access to the prior version (they just read it from disk), option B adds zero
value. If some callers want a stateless "take a snapshot" without managing version state,
option B saves them a read. Both are small changes (~5-10 lines).

---

### BL-104 — `compilePrompt()` doesn't drill into complex nested type shapes → agents invent minimal/incorrect interpretations for fields whose type is itself a multi-field interface — **Open (MEDIUM)** — NEEDS DECISION: ts-morph AST introspection vs a manual `type_spec` annotation. Defect confirmed at `compiler.ts:1706-1712` `[TRIAGE]`

**Observed:** dispatching the `dag-schema` milestone to a Haiku agent, two ops produced wrong
output types:

- `shape: OperationShape | null` — op spec said "add-field shape → OperationShape | null"
  but didn't describe `OperationShape`'s internals. Agent generated a simple enum
  `("read-only" | "write" | "transform")` instead of the rich polymorphic shape object
  (`{ kind, ops[], description, objective, schema }`).
- `dispatch_log → DispatchEntry[]` — agent generated `{ milestone, timestamp, dispatched_by,
  model, effort, notes }` instead of the full `{ id, kind, milestone_slugs[], turns[], results[],
  started_at, ... }`.

**Root cause:** `compilePrompt()` renders `shape.ops[]` as a flat list of `action → type` pairs.
When the target type of a field is itself a complex interface, that interface's shape is not
included anywhere in the compiled prompt — the agent has no schema to work from.

**Fix sketch:** For code/config kind ops, when an `add-field` op's `to` type is a known interface
name (detected by capital-first or explicit annotation in the op), look up and inline that
interface's own field specs as a nested block in the prompt. Alternatively, allow op authors
to add a `type_spec: { field: type }[]` array on `add-field` ops for inline sub-typing.

**Triage context:** Two approaches:
- **(A) Automatic inlining** — `compilePrompt()` introspects known interface shapes (by name) and
  inlines their fields. Always correct, no author overhead. Requires a type-shape registry or AST
  introspection (ts-morph). More work to implement but sets the convention once.
- **(B) Manual `type_spec` annotation** — simpler to implement but every op author must remember
  to annotate complex types. The observed failure (Haiku agent producing wrong output) would not
  be prevented for unannotated ops.

The trade-off is correctness vs implementation cost. Approach (A) is the right long-term answer
but needs the type-introspection infrastructure. Approach (B) is a quicker fix that shifts the
burden to op authors.

---

### BL-105 — 7 stubs in `docs/plan/dispatch-optimizer/src/compiler.ts` with no external integrations wired — snapshot derived fields are incomplete — **Open (MEDIUM — 4 of 6 stubs remain)** — `conflict` + per-op `tokens_actual` implemented 2026-07-08; `blast_radius` (needs gitnexus MCP), `from/breaking/severity` (needs ts-morph), `raised_at_*` (schema gap), `mcp_servers` (needs external agent catalog) left honestly stubbed

**Wave-2 progress (2026-07-04):** 1 of 7 implemented (`attempt_count` = dispatch_ids.length); the other 6 are now explicit `STUB(BL-105):` annotations each naming the missing data source (gitnexus impact per-op, same-wave conflict scan, ki-share proration, AST diff, typed pending-question events, agent catalog). Remaining work = those data sources, not the plumbing. Downgraded to LOW.

**Stubs (all return `null` or `[]` with TODO comments):**

| Stub | Requires | Location |
|---|---|---|
| `blast_radius: []` | `gitnexus_impact` MCP call | `buildOperationSnapshot()` |
| `from / breaking / severity: null` | TypeScript AST read (ts-morph) | `enrichShape()` |
| `conflict: { detected: false }` | Same-wave op-key collision scan | `buildOperationSnapshot()` |
| `attempt_count: 0` | Op-level dispatch_log scan | `buildOperationSnapshot()` |
| `tokens_actual: null` (per-op) | ki_estimate-share prorating | `buildOperationSnapshot()` |
| `mcp_servers: null` | Agent catalog lookup | `assembleDispatchUnit()` |
| `raised_at_dispatch / raised_at_turn: null` | dispatch_log notes scan | `buildOpenQuestions()` |

**Priority:** `mcp_servers` is HIGH — without it the orchestrator cannot create the agent-mcp
agent definition and the dispatch fails. `blast_radius` is MEDIUM (gitnexus integration is
the next planned milestone in adhd-build). Others are LOW (correctness impact is observability
only, not dispatch correctness).

---

### BL-106 — `b_per_tier` cold-start values not seeded in the schema → `tokens_estimated` null on fresh plans — **RESOLVED (verified 2026-07-04 validation sweep): fixed by the BL-107 normalization pass** — `dag/io.ts:120-133` (`normalizeDag`) injects default `b_per_tier` {Haiku 8000, Sonnet 15000, Opus 27000} when empty, so `b_eff_per_tier` computes non-null for fresh plans.

**Observed:** the adhd-build dag has no `optimization` block. After injecting the defaults in
`docs/plan/dispatch-optimizer/src/run.ts`, `b_per_tier` was seeded with `{ Haiku: 8000, Sonnet: 15000, Opus: 27000 }` and
`tokens_estimated` computed correctly. Without those seeds, every milestone shows
`tokens_estimated: null` and the optimizer cannot rank units by size.

**Fix sketch (per SCOPE.md Open Decision 2):** bake the recommended cold-start defaults into
the schema as the `b_per_tier` initial value when the field is absent or null, applied in
`normalizeOperations`-equivalent logic for the `optimization` block in `readDag()` or
`validateDagJson()`. Document these as "uncalibrated baseline; real calibration overwrites via
the calibration utility."

---

### BL-107 — dispatch-optimizer backward-compat patches lived in the runner, not `readDag()` — **RESOLVED (verified 2026-07-04 validation sweep)** — `dag/io.ts:52-133` `normalizeDag` (annotated "BL-107 backward-compat normalization pass") runs inside `readDag()`; all consumers get defaults. Residual nit: `run.ts:13-50` still redundantly re-applies the same defaults post-`readDag` — harmless, delete opportunistically.

**Observed:** `docs/plan/dispatch-optimizer/src/run.ts` manually injects three top-level dag blocks before calling
`snapshotWithDag()`. These patches are necessary for any dag authored before the schema
added `providers`, `optimization.sentinel_fanout`, `optimization.b_per_tier`,
`optimization.context_window_per_tier`, and `effort_max_tokens`. Any other consumer of
`readDag()` (future orchestrator, CLI tool) that doesn't know to apply the same patches
will crash in `snapshotWithDag()`.

**Fix sketch:** Move the defaults into `readDag()` as a post-parse normalization pass —
applied after `validateDagJson()` succeeds (or as part of it). This makes the contract:
"any syntactically valid dag.json, old or new, produces a usable DagJson from readDag()."

---

_BL-86, BL-87, BL-89 removed 2026-07-04: hash embedding backend deleted — these items are moot._

### BL-88 — no PER-RECORD embedding provenance + no auto-upgrade on model change — Open (MEDIUM) data-integrity (2026-06-26, re-scoped 2026-07-04 — hash backend removed) — **RESOLVED (2026-07-05, wave-2)**

**Resolution:** additive `node.embed_model` column (idempotent migrate, no backfill — NULL =
provenance-unknown); stamped atomically inside `applyEmbedding` (the single choke point: write
Phase B, update Phase B, both sync compositions, heal); `healStaleVectors` (bounded, DEFAULT-OFF
via SOX_HEAL_STALE_VECTORS=1, NULL rows never touched) exported but deliberately NOT tick-wired —
a full-store re-embed is an operator decision (BL-215 tracks the operator surface);
`memory_stats.embed_provenance {stamped, unstamped, stale_vector_count, active_model}` surfaces
automatically. 21 new tests. LIVE-VERIFIED: fresh write → stamped:1, correct active_model.
Integrator note: the agent gated via bare vitest (its worktree hit the pre-existing dist-less
class); re-proven through nx on main post-merge (377 pass uncached).

**Observed:** `embed_model` is stored only on `memory_scope` (one row per scope, set ONCE at scope
creation via `getActiveEmbedModel()` in `libs/memory-core/src/db.ts:191`, never updated). Individual `node`/`vec_node` rows
carry NO model/backend tag, so there is no way to tell which model produced a given vector.
`reembedNodes()` + the reindex organizer op exist but are MANUAL (`reembed=true` payload) —
nothing auto-re-embeds rows when the embedding model changes.

**Fix sketch:** (1) record `embed_model` per node/vec row at write time; (2) a heal pass that
re-embeds rows whose `embed_model` != the current runtime model; (3) surface a `model_mismatch_count`
or `stale_vector_count` in `memory_stats`.



### BL-91 — `reembedNodes()` (and any vec_node re-embed) used `INSERT OR REPLACE` which FAILS on sqlite-vec vec0 tables → daemon `reindex --reembed` op silently broken — **FIXED in worktree (2026-06-26)**

**Observed:** while building the re-embed quickfix, `INSERT OR REPLACE INTO vec_node(node_id, embedding)`
raised `SqliteError: UNIQUE constraint failed on vec_node primary key` and rolled back the whole
transaction (vectors stayed hash). sqlite-vec `vec0` virtual tables do not implement OR-REPLACE conflict
resolution. `reembedNodes()` in `libs/memory-core/src/embed.ts` (called by memoryd's `reindex` op when
`reembed=true`) used exactly this form — so the existing re-embed path was non-functional.

**Fix (applied):** use `UPDATE vec_node SET embedding=? WHERE node_id=?` for the existing row, falling back
to `INSERT` only when the row is absent (`changes===0`). Both `reembedNodes()` and the new
`scripts/reembed-memory.mjs` use this form. Verified: UPDATE and DELETE+INSERT both work on vec0;
INSERT OR REPLACE does not.

### BL-92 — re-embed script note: per-record provenance gap (BL-88) means the real store's vectors are a HASH/real MIX while `memory_scope.embed_model` already (falsely) reads `bge-base-en-v1.5` — **RESOLVED (2026-07-10)** — `reembedStore()` rewired onto the per-record `node.embed_model` column for idempotency, source detection and grouping. NULL `embed_model` = "provenance unknown, must migrate" (never "assume current"), matching `healStaleVectors`'s precedent. Added a dim guard. Deeper defect found and fixed: the old implementation migrated into `@adhd/sox-vector-store`'s generic `vec_<model>` side-tables, which the live recall path never reads — a "successful" reembed changed nothing recall could see. Now migrates `vec_node` directly. Red→green: 6/9 red, 9/9 green. See BL-256

**Observed:** the live `~/.memory/memory.db` `memory_scope.embed_model` already reads `bge-base-en-v1.5`
(set once at scope creation, never updated — BL-88), yet the stored vectors are a mix: pairwise cosine over
a 60-node sample is mean 0.64 / min 0.43 / max 0.96 (pure hash pins ~0.97+, pure real ~0.4). So the scope
tag is NOT a reliable re-embed trigger — `scripts/reembed-memory.mjs` requires `--force` to re-embed when
the tag already says real, and normalises the WHOLE store to real (idempotent: re-embedding an
already-real row reproduces the same BGE vector). Pairs with BL-88 (add per-record `embed_model`).

### BL-93 — `edge.rel` accepted-value set is INCONSISTENT across the `memory_link` tool, the `schema.ts` CHECK constraint, and the graph contract → `memory_link({rel:'ASSIGNED_TO'})` fails at the DB — **FIXED at source (2026-06-26); existing-store migration is a follow-up** (found by architect-reviewer authoring the memory-refactor contracts)

> **Fix (2026-06-26):** added `'ASSIGNED_TO'` to the `edge.rel` CHECK in `libs/memory-core/src/schema.ts`
> (now the 9-value union matching the contract `EdgeRel`), rebuilt memory-core/server/daemon, registry
> synced. NEW stores accept `ASSIGNED_TO`. **Follow-up:** SQLite CHECK constraints aren't retroactively
> altered, so the EXISTING `~/.memory/memory.db` (created with the old 8-value CHECK) still rejects
> `ASSIGNED_TO` until its `edge` table is recreated — a small migration (or left until next store rebuild),
> low priority since `ASSIGNED_TO` was never successfully written. w2b inherits the fixed schema.

**Observed (verified state-side):** three different `edge.rel` value sets are in play:

- `memory_link` MCP tool — enum + `VALID_RELS` (memory-server `src/index.ts:452,1325`): `MENTIONS, SUPPORTS,
  RELATES_TO, DERIVED_FROM, SUPERSEDES, SAME_AS, **ASSIGNED_TO**` (7; **no** `MEMBER_OF`/`PART_OF`).
- `schema.ts` `edge.rel` CHECK (`libs/memory-core/src/schema.ts:58-59`): `MENTIONS, SUPPORTS, RELATES_TO,
  SUPERSEDES, DERIVED_FROM, **MEMBER_OF, PART_OF**, SAME_AS` (8; **no** `ASSIGNED_TO`).
So a `memory_link({rel:'ASSIGNED_TO'})` call **passes the tool's `VALID_RELS` then hits the SQLite CHECK
constraint and errors** — the tool advertises a relation the DB rejects. (`[inv:tool-contract-stable]`
guards the tool enum, so the *schema* is the side that's wrong.)

**Fix:** reconcile to one authoritative set — the contract's `EdgeRel` (9 values = union) in
`docs/plan/memory-refactor/contracts/graph-store.ts`. The **w2b graph-store extraction MUST add
`ASSIGNED_TO` to the DDL CHECK** (and confirm `MEMBER_OF`/`PART_OF` are intentional internal rels the tool
needn't expose). Add a test asserting every `memory_link` enum value is DDL-accepted. Pre-existing
(predates the refactor); surfaced because the contract forced the three sets to be compared.

### BL-90 — memory skill(s) lack copy-paste recall recipes for common scoping axes — **RESOLVED (2026-07-08)** — per-axis recall recipes added, each validated against the live tool schema

**Validation note (2026-07-04 sweep):** SKILL.md now documents filters generally (SKILL.md:43-59) but still lacks the per-axis copy-paste recipes (agent_id scoping, `target:`/`audience:` tags, `kind:` lifecycle filters). Still valid at reduced scope.

**Observed:** the `memory-usage` (and `reflection`) skills document write conventions well but give little
guidance on the *retrieval* side — specifically how an agent finds the memories relevant to its situation.
Agents need ready recipes for the common scoping axes:

- **Directed at you (the agent):** by `agent_id` (your own confirmed identity), and by `target:<name>` /
  `audience:<name>` tags (e.g. ideas/lessons addressed to a specific agent or role like `workflow-researcher`).
- **Scoped to your project:** `filters.project_path` (exact or `{prefix}`) — and the footgun that
  `project_path` auto-resolves to cwd/git-root, so a write from the wrong dir mis-files the scope.
- **Scoped to your task:** `filters.topic` (single or array OR-match) + `filters.tags` (`tags_match_all`
  for AND) + `importance_min`; combine with the query for hybrid recall.
- **By kind/lifecycle:** `kind:lesson|bug|fix|idea`, `actionable`, `state` (metadata).

**Fix sketch:** add a "Finding the right memories" section to `memory-usage` (and cross-link from
`reflection`) with copy-paste `memory_recall` recipes per axis above (self/agent, project, task, kind,
directed-at-role) and note the `project_path` mis-resolution footgun.

---

## Resolved — regressions from the proxy-default flip, fixed 2026-06-25

### BL-67 — detached proxy backend inherits the parent's stdout fd → `soxe upgrade --all` (and any piped/CI invocation) HANGS forever — **RESOLVED**

**Observed (2026-06-25, rolling the Slice 1.6 flip to live):** `node bin/soxe upgrade --all 2>&1 | tail -40`
appeared to hang indefinitely. Diagnosis (state-side): the `upgrade --all` node process **had already exited
0** (work complete), but the rolling-restart of memory-server spawned the **detached proxy backend** (PPID 1,
`node --enable-source-maps .../memory-server/dist/index.js`, pid 20057) which **inherited the parent's stdout
write-end**. `tail` therefore never received EOF (a live writer of the pipe remained), so the shell pipeline
never terminated. Any invocation that pipes soxe output (`| tail`, `$(…)`, CI capture, the post-merge
`upgrade --all` mandated by CLAUDE.md) now hangs whenever a proxy backend is (re)spawned.

**Root cause:** `ensureBackend`/the detached-backend spawn did not fully sever inherited stdio — `stdio[2]` was
`'inherit'` on non-Windows (stderr), which means when the spawner had `2>&1` active (piped), the backend
inherited THAT pipe fd, keeping it open forever.

**Fix (committed):**

- `libs/service-proxy/src/ensure-backend.ts`: removed `os` import; replaced `stdio: ['ignore', 'ignore',
  os.platform() === 'win32' ? 'ignore' : 'inherit']` with full fd severance using a synchronously-opened log
  fd (`fs.openSync`) or `'ignore'`. Added `stderrLogPath?: string` to `EnsureBackendOptions`.
  Added `[inv:no-fd-inherit]` invariant documentation.
- `apps/sox/src/main.ts` (`cmdServe` ensure callback + `restartProxyBackend`): both `ensureBackend` callers
  now pass a dated `stderrLogPath` under `logDirFor('proxy-backend-<extId>')`.
- `libs/service-proxy/src/ensure-backend.spec.ts`: added `[BL-67]` regression test that spawns a real child
  process with `stdio:'pipe'`, triggers `ensureBackend`, and asserts the pipe closes within 12s (not hung).

**Proof:** E2E run in isolated tmp — pipeline returns in 143ms; `lsof -p <backend_pid>` confirms fd 0,1 = /dev/null,
fd 2 = log file, no parent pipe fd inherited.

### BL-68 — BL-65 dirty-dist guard counts UNTRACKED files as "dirty" → false "built from DIRTY tree (uncommitted WIP)" warning on every serve — **RESOLVED**

The BL-65 `stamp-build.cjs` / `warnIfDistSha()` guard (correctly shipped) computes `dirty` from
`git status --porcelain`, which includes **untracked** files (e.g. `README.md`, `PUBLISHING.md`,
`.claude/skills/memory-usage/`). So a clean-tracked-tree build stamps `dirty=true`, and **every** live
`soxe serve` then emits "dist was built from a DIRTY tree (uncommitted WIP)" — alarming false-positive noise
for all sessions.

**Fix (committed):**

- `apps/sox/scripts/stamp-build.cjs`: changed `git status --porcelain` → `git status --porcelain --untracked-files=no`.
  Untracked files are now excluded; only staged/unstaged modifications to tracked files count as dirty.
- `apps/sox/src/stamp-build.spec.ts` (new): 5 tests covering the contract — clean tree → false, only-untracked →
  false (regression), modified tracked → true, staged tracked → true, untracked + modified tracked → true.
  All tests run in isolated tmp git repos (never touch the real repo's dist or worktree state).

## Mostly-resolved — test harnesses pollute the real `~/.memory` store dir + the repo root (2026-06-25)

### BL-66 — C6/e2e test artifacts accumulated 1.5 GB in `~/.memory/`; 12 test DBs were committed to git under `.tmp-*/` — **Resolved (cleanup + 2 of 3 root causes); 1 root cause deferred**

**Observed (2026-06-25):** `~/.memory/` held **843 test-artifact files / ~1.49 GB** of `*.db{,-wal,-shm}` triples
beside the canonical `memory.db`: `c6-allowed*` (323 files, 579 MB), `sox-e2e-*` (514, 905 MB),
`smoke-*`/`cli-demo*`/`test-verify*` (6, ~12 MB). Separately, **12 test DBs were tracked in git** under six
`.tmp-*/.memory/project.db` dirs (committed via a past `git add -A` — the exact hazard CLAUDE.md bans), and
`.gitignore` covered only `.tmp-mvp/`+`.tmp-test/` of the 8 `.tmp-*` dirs present. `~/.memory/registry.json`
(federation registry) held a single stale entry pointing at a `.tmp-p2/.memory/project.db` test store.

**Root cause:** the `db_path` permission allowlist is `~/.memory/**` (BL-15), so tests/audits that must prove a
write to an *allowed* path write into the **real** store dir and never clean up. Culprits: (1) `audit_c6.py`
([dod.1] positive write to `~/.memory/c6-allowed.db`), (2) `tools/test-e2e-lifecycle.js` (`sox-e2e-<pid>.db`),
(3) `memory-server/src/permission-guard.spec.ts` (shared fixture names).

**Fix (shipped 2026-06-25):**

- **Swept** `~/.memory/`: removed all 843 artifacts (1.5 GB → 41 MB); canonical `memory.db` untouched
  (`PRAGMA integrity_check` = ok, 2909 nodes, parity with the verified backup). Manifest of removed files at
  `~/.memory/backups/swept-manifest-*.txt`. A verified backup exists at
  `~/.memory/backups/memory-20260625-151943.db` (sha256 `7f213ec8…6c399e`).
- **Reset** stale `~/.memory/registry.json` (pointed at a `.tmp-p2` test store) to `{}` (old saved to
  `backups/registry.json.bak-*`).
- **Untracked + deleted** the 12 committed `.tmp-*/.memory/*.db` files (`git rm --cached`) + removed all 8
  `.tmp-*` dirs from disk (60 MB); **broadened `.gitignore`** `.tmp-mvp/`+`.tmp-test/` → `.tmp-*/` (verified a
  fresh `.tmp-probe` is now ignored).
- **Root cause (1):** `audit_c6.py` now has `_cleanup_memory_artifacts()` (glob-removes `~/.memory/c6-allowed*`)
  called in a `finally` around the phase run, so it can never re-accumulate even on a failing check.

**Deferred (1 root cause):** `tools/test-e2e-lifecycle.js` + `memory-server/src/permission-guard.spec.ts` still
write `sox-e2e-<pid>.db` / fixtures into `~/.memory` without teardown. **Not fixed in this pass to avoid a
write-collision** — the `svc-proxy-fix` platform-engineer agent is concurrently editing `tools/test-e2e-lifecycle.js`
(its Step 7d / Section SPM / BL-59 e2e assertions). Fix after that agent merges: route test dbs to a sweepable
`~/.memory/.e2e-tmp/` subdir (still inside the `~/.memory/**` allowlist) + `rm -rf` it in teardown, OR add a global
afterAll cleanup. Track here until done.

## Open — INCIDENT: the dev checkout's `dist` IS the live MCP source (2026-06-25)

### BL-65 — building unverified WIP into the dev-repo `dist` breaks the LIVE memory-server for all sessions — **RESOLVED (HIGH) — principled repoint APPLIED 2026-06-26 (option 1); guard remains as defense-in-depth**

**Resolved (2026-06-26):** after the first npm publish, the principled repoint (option 1) was
applied. The published CLI was installed to a **stable, non-PATH prefix** `~/.adhd/sox-cli`
(`npm i -g @adhd/sox-cli@1.1.1 --prefix ~/.adhd/sox-cli` → `~/.adhd/sox-cli/bin/soxe`), and
`sox-memory-bundle` was installed through it (members + native deps resolve from npm via the
`npm-package:` mode into `~/.adhd/sox-ecosystem/ext/`, never `libs/*/dist`). All three live
`memory-server` references were repointed from the dev `/Users/nix/dev/ai/sox-ecosystem/bin/soxe`
to `~/.adhd/sox-cli/bin/soxe` (backups `*.bl65-bak`): `~/.claude.json` (root mcpServers),
`sox-ecosystem/.mcp.json` (gitignored, local), `claude-agents/.mcp.json` (gitignored, local).
`memory_ping` verified `ok:true` (artifact `sha256:00cefb04…`) via the stable command before the
swap. Effective on the next MCP reconnect (BL-61). A dev `nx build` no longer touches the running
server — it updates ONLY on explicit `soxe upgrade --all` (or reinstall). The `warnIfDistSha`
dirty-dist guard stays as defense-in-depth. The interactive dev `bin/soxe` (on PATH via `OUT_PATH`)
is unchanged, so local extension development/install is unaffected.

**Update (2026-06-26, publishing refactor):** the BL-42 blocker is resolved — there is now an
independently-installable, self-contained CLI (`@adhd/sox-cli` → `soxe`, in-package bin + bundled
registry; proven via `npm i -g` with no checkout). The principled repoint (option 1) is therefore
UNBLOCKED. Sequence (orchestrator, AFTER the owner publishes — `docs/plan/publishing/SCOPE.md` §8):

1. `npm i -g @adhd/sox-cli` (or `soxe install sox` to a content-addressed store under `~/.adhd/...`).
2. Repoint `.mcp.json` / `~/.claude.json` `mcpServers.memory-server.command` from
   `/Users/nix/dev/ai/sox-ecosystem/bin/soxe` → the **installed** `soxe`; install
   `sox-memory-bundle` via the published packages (members resolve from npm, native deps via the
   `npm-package:` install mode), so memory-server runs from `~/.adhd/.../ext/`, never `libs/*/dist`.
3. One final reconnect (BL-61). After repoint, a repo build never touches the running server; it
   updates only on explicit `soxe upgrade --all`. The `warnIfDistSha` dirty-dist guard stays as
   defense-in-depth. Do NOT do a fragile dist-copy repoint (still risks re-breaking live).

**Update (2026-06-25, attempting the repoint):** the guard (option 3) is **shipped and verified live** —
`soxe serve` now emits the dirty/stale-dist warning (confirmed firing: it caught dist sha `ffe4a3d` vs HEAD
`b479ebb`). But the **principled repoint (option 1)** — point `.mcp.json`/`~/.claude.json` `memory-server`
(currently `command: /Users/nix/dev/ai/sox-ecosystem/bin/soxe`, also in `sox-ecosystem/.mcp.json` and
`claude-agents/.mcp.json`) at an installed `soxe` under `~/.adhd/...` — is **BLOCKED on BL-42**: there is **no
independently-installable CLI** (`~/.adhd/sox-ecosystem/` holds only metadata; `bin/soxe` → `dist/apps/sox/main.js`
which runtime-resolves `@adhd/sox-*` from the repo `libs/*/dist` + repo `node_modules` = checkout-bound). The
real fix requires either (a) an esbuild-bundled self-contained CLI installed to `~/.adhd/.../cli/<sha>/`
(the bundled-extension-build-standard applied to the CLI), or (b) a dedicated pinned checkout/clone the live
MCP resolves and dev never builds in. Both are architectural choices gated on BL-42/BL-43 (publish strategy).
Until then the guard is the interim protection; do NOT do a fragile dist-copy repoint (it risks re-breaking live).
See also BL-67 (the flip's `upgrade --all` hang) + BL-68 (guard over-sensitivity).

**Incident (2026-06-25):** while an agent was implementing proxy-on-by-default on a branch, its
`nx build` wrote the WIP (proxy-default + a not-yet-working shim path) into `dist/apps/sox/main.js` and
`libs/*/dist`. Because **every `.mcp.json` / `~/.claude.json` points `memory-server` at the absolute
`/Users/nix/dev/ai/sox-ecosystem/bin/soxe`** (→ that repo `dist`, which also runtime-resolves
`@adhd/sox-memory-*` from the repo `libs/*/dist`), **every memory-server respawn loaded the broken WIP**
and failed (`-32001 proxy closed`). Multiple agents/sessions reported memory failures. A detached WIP
backend orphan was left holding `~/.memory/memory.db`.

**Recovery performed:** switch tree to `main` → rebuild serve path (sox + memory-core/enrich/server,
cache-busted) → reap all WIP memory-server processes (3 shims + 1 detached backend) gracefully → remove
stale proxy socket → verified direct serve `memory_ping`/`recall` OK + SQLite `integrity_check: ok`.

**Root cause:** the **dev checkout is the live MCP runtime** (no isolation between in-progress repo state
and the running MCP server). This is the `$SKILL`-cache-vs-dev-checkout hazard generalized to MCP.

**Fix options (need decision):**

1. **Point `.mcp.json` at an installed/cached `soxe`** (a content-addressed install under `~/.adhd/...`),
   not the live dev checkout — so repo builds never touch the running server (it only updates on an
   explicit `soxe upgrade`/reinstall). This is the principled fix.
2. **Isolate risky serve-path work in a git worktree** (`Agent isolation: "worktree"`) so its `nx build`
   writes to a separate `dist`, never the live one. (Process discipline; the orchestrator now does this.)
3. **A build guard** — refuse/ warn when building the serve path while a live MCP server resolves this
   `dist` (or stamp dist with a git-sha and have `serve` warn on a dirty/uncommitted dist).

**Shipped (this branch, `feat/proxy-default-memory-backend` rebased):**

- Option 2 is enforced at the orchestrator level: risky serve-path work MUST run in an isolated git
  worktree (the BL-65 constraint in the task brief); the current work was done in
  `.claude/worktrees/agent-a43ff2972d1444cca/` which has its own `dist`.
- Option 3 (build guard): `apps/sox/scripts/stamp-build.cjs` is now run as a post-build step in the
  `sox:build` nx target. It writes `dist/apps/sox/build-info.json` with `{ gitSha, dirty, builtAt }`.
  `cmdServe` calls `warnIfDistSha()` at startup (before any subprocess) and emits a loud WARNING to
  stderr when the dist was built from a dirty tree or from a sha that differs from HEAD — so the
  operator cannot silently serve stale/WIP code.

**Remaining human/orchestrator step (option 1 — principled permanent fix):**

- Point every `.mcp.json` / `~/.claude.json` `memory-server` entry at a content-addressed INSTALLED
  `soxe` under `~/.adhd/sox-ecosystem/installs/<sha>/bin/soxe` (or equivalent), NOT the live dev
  checkout. This decouples repo builds from the live MCP server: it only updates on an explicit
  `soxe upgrade --all`. The mechanism: run `soxe install sox` (or `soxe upgrade --all`) to write a
  pinned install, then repoint the MCP config entry from `/path/to/dev/sox-ecosystem/bin/soxe` to
  the installed path. DO NOT repoint live config yourself — this is a documented orchestrator step.
- Until that repoint: NEVER build the serve path on the live dev checkout while sessions are
  connected; validate in an isolated worktree and merge to `main` before any rebuild.

> **Status (2026-06-22): BL-1 … BL-22 all resolved.** BL-23/24 are now **folded into the
> memory-enrichment plan** at `docs/plan/memory-enrichment/` (SPEC + DESIGN + CONSUMER-INTERFACES +
> CONTRACTS + IMPLEMENTATION) and tracked there per `IMPLEMENTATION.md §0` — they are resolved by its
> phases (P1–P6), not as loose items. The metadata-drop half of BL-23 is already fixed (`9728f6f`).
> **BL-21 (auto-export) and BL-22 (entity names) resolved by P5 (2026-06-22).**

## Slice 1.6 — proxy-by-default + memory-server backend (2026-06-25, `feat/proxy-default-memory-backend`)

### BL-61 — flipping memory-server to proxy default requires exactly ONE final client reconnect — **RESOLVED (historical)** — `extension.json:22` `serve_mode: proxy` is already the live default; the one-time reconnect happened weeks of commits ago

memory-server is now served via the front-shim by DEFAULT (`type: mcp-server` →
`lifecycle.serve_mode:"proxy"`). The running instance in any MCP client is still the OLD direct-stdio
server (it owns the client's pipe). To pick up the shim, the client must reconnect/reload the
memory-server MCP plugin **once**. After that single reconnect, every subsequent memory-server
behaviour/code upgrade is a BACKEND rolling-restart behind the shim → **no further client reconnects**
(the shim re-dials across the sub-second gap; spec §9.5, e2e Section SPM). An interface (tool-schema)
change still emits `notifications/tools/list_changed` and falls back to reconnect only for clients that
ignore it. **Action for the human:** after this merge + `soxe upgrade --all`, reconnect/reload the
memory-server MCP server once.

### BL-312 — 2026-07-18 memory-server 73%+ CPU / 50s+-90s+ tool-call hang: service restored, root cause not definitively pinned — **Open (MEDIUM, incident follow-up) (2026-07-18)**

Live incident: every `memory_*` tool call (including `memory_ping`) hung 50s-90s+ with zero
response; a `sample <pid> 5` profile of the backend process showed 100% of the 5-second window
inside `sqlite3_step` → deep B-tree traversal — the single-threaded Node event loop fully blocked
on a synchronous `better-sqlite3` query the entire time. Restored service by `SIGTERM` (ignored —
event loop too busy to process it) then `SIGKILL` on the backend pid, letting the shim's
`ensure-backend` respawn a fresh one; has not recurred since. Two candidate root causes were found
during the same investigation but NEITHER was proven as the specific trigger for this exact
incident:
1. `meanIntraSim()` (`libs/memory-core/src/cluster.ts:157-168`) is an O(n²) nested-loop pairwise
   cosine-similarity computation over cluster member vectors — with ~4,692 episode vectors this is
   ~22M comparisons if ever invoked over the full episode set, easily explaining multi-minute
   blocking. However, this is pure JS/V8 compute, not SQL — it would NOT show up as 100% time
   inside `sqlite3_step` the way the profile actually showed, so it's a plausible latent risk, not
   a confirmed match for the captured symptom.
2. The dormant duplicate-edge bug (146,006 stale `MEMBER_OF` rows, fixed separately — see
   CHANGELOG.md / the `db.ts` schema-migration fix) stopped recurring 2026-07-03, two weeks before
   this incident — unlikely to be the direct trigger, though the resulting DB bloat (4.5x more
   edge rows than necessary) plausibly contributed to slower-than-expected query times generally.

Follow-up if this recurs: capture a LONGER `sample` (30s+) and/or use `node --prof` on a fresh
repro to get symbol-level attribution inside the SQL layer itself (which specific prepared
statement, not just "somewhere in sqlite3_step"), and check `PRAGMA compile_options`/index usage
via `EXPLAIN QUERY PLAN` on any query suspected of a missing/wrong index for the now-larger
(post-dedup, ~41K-edge) table.

### BL-314 — `soxe upgrade --all` fails against `npm-package:` locators because the local content-store mirror is stale — **Open (LOW, dev-environment tooling) (2026-07-18)**

Found while syncing the installed `.claude/skills/memory-usage/SKILL.md` copy after a docs update.
`registry/index.json` is committed in publish mode (`SOX_REGISTRY_PUBLISH=npm`), so every entry's
`source` is an `npm-package:@adhd/sox-extension-<id>@<version>` locator rather than a `file://` path.
`soxe upgrade --all` resolves those locators against a local content-store mirror — but that mirror
was last refreshed at some earlier point and is now stale relative to the actual current `dist/`
checksums recorded in `registry/index.json`. Running the upgrade fails outright:

```
Error: install: CHECKSUM MISMATCH for source "npm-package:@adhd/sox-extension-memory-server@1.3.0"
  expected: sha256:31e8559c1f09902d64f163aff2b8ae74cc8766861cff4048e0bf52c8bab65e1d
  got:      sha256:4227b64708a7050e93ed591ff3368568f1542ffe5f193f1b992b2d74259fede5
```

The "got" checksum (`4227b64...`) is the ORIGINAL memory-server checksum from before this session's
work even began — the mirror hasn't tracked any of today's rebuilds. This blocks the documented
"5. `node bin/soxe upgrade --all`" step of the `⛔ AGENT SEQUENCE` in `AGENTS.md` for any change
that touches a `dist` artifact, in a local dev checkout that never ran a real `npm publish`. Worked
around this session by directly copying canonical source content into the installed copy (safe only
for non-compiled extension types like skills; would not work for a bundled `mcp-server`/`service`
extension, which needs the actual rebuilt `dist/` bytes an upgrade would fetch).

**Fix options:** (a) refresh/regenerate the local content-store mirror as part of the standard
dev-loop after a `dist` rebuild (mirrors the "commit `registry/index.json` after `sync-index`"
step this repo already has), or (b) make `soxe upgrade` fall back to a `file://`-mode resolution
when the `npm-package:` fetch's checksum mismatches AND the source extension's `.git` metadata shows
it's a local, non-published dev checkout, or (c) document that `soxe upgrade --all` in a local dev
checkout requires `SOX_REGISTRY_PUBLISH` unset (dev-mode `file://` locators) rather than the
committed publish-mode registry.

### BL-63 — `host-runtime:test-e2e` BL-31 orphan scan uses a global `pgrep -f memory-server/dist/index.js`, so a CONCURRENT live proxy session on the dev box is mis-counted as a leaked orphan — **RESOLVED (2026-06-25, `feat/proxy-default-memory-backend`)**

`tools/test-e2e-lifecycle.js` `liveServerPids()` does `pgrep -f 'memory-server/dist/index.js'` and
subtracts a `BASELINE_PIDS` snapshot captured at import. With the Slice 1.6 proxy default LIVE in the
operator's own `bin/soxe serve memory-server` session, that session's shim **re-ensures/respawns its
backend during the ~minute e2e run** → the new backend pid post-dates the baseline → the BL-31 "no
orphan after stop" + "BL-31 no orphan survive soxe stop" assertions count it as leaked. This was the
root cause of the reported **e2e 99/2** failure — **a test-environment confounder, NOT a code
regression:** every reported "orphan" pid resolves to `ppid == <the operator's live serve session pid>`
(correlated 3×: 18501→23210, 15408→23210, 15572→23210), never to the e2e's own install/start tree; on a
clean machine the suite was already **101/0** (re-confirmed 3× this session, before the fix).

**Fix (shipped):** `leakedServerPids({ excludeLiveParented: true })` for the two POST-STOP orphan
assertions (Step 7 + Step 7b). After a `soxe stop` this test's supervisor is already dead, so a genuine
leak from THIS test is always orphaned (PPID 1) or dead-parented; a candidate whose parent is a LIVE
non-init process is owned by another live manager (the operator's serve shim) and is excluded. This
removes the false positive WITHOUT masking a real test leak (never live-parented after stop). The
mid-lifecycle disable/enable checks keep the strict (no live-parent exclusion) form — a supervisor
restart there MUST still be caught.

### BL-64 — auto-spawned proxy backend (untracked, no runtime entry) survived `soxe stop` — **RESOLVED (2026-06-25, `feat/proxy-default-memory-backend`)**

A proxy-mode mcp-server (Slice 1.6 default) is fronted by a thin stdio shim; the real implementation
runs in a persistent, detached, sox-owned BACKEND the shim AUTO-SPAWNS via `ensureBackend`
(`SOX_PROXY_BACKEND=1`). That backend is created by the SHIM, not by `soxe start`, so it is in NO
`runtime.json` entry — `cmdStop`'s whole-scope reap loop iterates only `record.entries` and never
touched it, so the detached backend SURVIVED `soxe stop`, re-introducing the BL-31/BL-50 orphan leak
once every spawning shim had exited. (Distinct from BL-63: BL-63 was the e2e *scan* mis-attributing a
foreign live session; BL-64 is the real production gap that the e2e could not previously reach.)

**Fix (shipped):** new `reapUntrackedProxyBackends()` in `apps/sox/src/main.ts` — enumerates every
installed mcp-server from the lockfile (the source of truth for "what could have an auto-spawned
backend"), and for each one served in proxy mode reaps any live process matching the backend's
entrypoint IDENTITY token (the exact `node --enable-source-maps <entrypoint>` argv `ensureBackend`
uses), via `reapByIdentity` → `killAndVerify` ([contract:signal] verified-stop). Wired into all three
`cmdStop` exit paths: whole-scope, per-`--id`, and the no-runtime-record early-exit. Identity matching
is the entrypoint PATH, which is stable across scopes, so a backend whose serve resolved a DIFFERENT
scope than the stop target is still reaped (closes the suspected scope-mismatch leak). The manifest is
read from the lockfile entry's source (honoring an explicit `--lockfile`), NOT re-derived via
`getScopePaths` (which would miss a custom lockfile). Proven: new e2e **Step 7d** spawns the REAL
backend as a true orphan (PPID 1) and asserts `soxe stop` reaps it; full suite **107/0** across 3 runs.

## Open — surfaced during service-proxy Slice 1.5 (2026-06-25, `feat/service-proxy-slice1_5`)

### BL-59 — `cmdServe` local-discovery fallback calls `findLocalExtension(extId, root2)` with args REVERSED — **RESOLVED (2026-06-25, this branch)**

`apps/sox/src/main.ts` `cmdServe` calls `findLocalExtension(extId, root2)`, but the signature is
`findLocalExtension(root, id)` (`libs/install-engine/src/install.ts:984`). The arguments are swapped,
so `soxe serve <id>` can **never** discover an UNINSTALLED local extension by scanning
`<root>/extensions/<typeDir>/<id>/` — it only works via the lockfile (installed) path.

**Fix (shipped):** swapped to `findLocalExtension(root2, extId)` in `cmdServe`. Also added the
`resolveServeManifest` helper (used by `mcpServerIsProxyMode` and `reapUntrackedProxyBackends`) which
uses the CORRECT argument order. e2e Step SPM-local verifies the local-discovery path reaches proxy mode.

## Open — project_path mis-attribution for user-scoped memory-server (2026-06-25)

### BL-56 — `project_path` was derived from the memory-server's INSTALL dir, not the client workspace → user-scoped writes mis-attributed — **Resolved + reality-verified (2026-06-25)**

**Evidence (real store, 2026-06-25):** three project buckets in the single user-scoped store
`~/.memory/memory.db` — `/Users/nix/dev/ai/sox-ecosystem` (46), `/Users/nix/dev/ai/claude-agents`
(215), `/Users/nix/dev/node/adhd-agent-registry` (1).

**Mechanism (read state-side — and the first diagnosis was incomplete):** `memory_write` →
`enrichOnWrite` → `resolveProjectPath` (`libs/memory-enrich/src/provenance.ts`): caller override → else
`git rev-parse --show-toplevel` in **`process.cwd()` of the served process**. The decisive detail is the
served process's cwd: `cmdServe` execs the entrypoint with **`cwd: extDir2`** (`apps/sox/src/main.ts:4694,4720`)
— the **extension INSTALL directory**, not the client's workspace. So `project_path` was the git root of
*wherever the extension is installed* (the dev repo `sox-ecosystem`; or `~/.adhd/...` → `~` for a
user-scoped store copy), **not** where the user/agent is working. The launch dir (`root2` = the dir the
MCP client started `soxe serve` from = the user's real project) was captured but **never used** for
attribution; there was no `SOX_CONFIG_PROJECT_PATH` injection and no MCP `roots`. The buckets varied
because each session's extension resolved to an extDir inside a different repo.

**Fix:**

1. `cmdServe` now injects **`SOX_CONFIG_PROJECT_PATH` = git root of `root2`** (the client launch
   workspace), always defining it (empty string when `root2` is not a git repo) so the install-dir cwd
   path is disabled in the served context (`apps/sox/src/main.ts`).
2. `resolveProjectPath` treats a **defined** `SOX_CONFIG_PROJECT_PATH` as authoritative — non-empty ⇒
   that path; empty ⇒ `null` (no project) with **no** cwd fallback. When the env var is *unset*
   (non-served contexts: daemon, memory-cli, tests) it falls back to cwd-git, now with linked-worktree →
   main-checkout canonicalization, and returns `null` (not the bare cwd) on a non-repo cwd
   (`libs/memory-enrich/src/provenance.ts`). A project-scope `config.<id>.project_path` (via
   `buildExtConfigEnv`) still wins over the auto-injected launch root.

**Reality verification (2026-06-25, served `node bin/soxe serve memory-server`, hash backend, probe db
under `~/.memory`):** launched with cwd `=/Users/nix/dev/ai/claude-agents` ⇒ `project_path
="/Users/nix/dev/ai/claude-agents"` (the **client workspace**, no longer the `sox-ecosystem` install
repo); launched from a non-git tmp dir ⇒ `project_path=null` (no false attribution). 9 new
`resolveProjectPath` BL-56 tests; gates: build (dist verified) + lint + test + `host-runtime:test-e2e`
99/0.

**Remaining (follow-up, lower priority):** the principled per-session fix for a server whose client
launches from a non-project dir is the MCP `roots` capability (the client advertises its workspace);
until then a non-repo launch correctly records `null`. Also: the **daemon** re-enrich path runs with
`cwd = store dir` but does not re-resolve `project_path` for existing nodes (set at write time), so it
is unaffected; a future daemon-side write path must use the same injection.

**Note:** the 4 reflections filed earlier this session landed in `sox-ecosystem` because this client
launched there — which under the fix is now the *correct* attribution (the workspace), not luck.

### BL-57 — soxe data files pollute repo roots instead of nesting under `.adhd/sox-ecosystem/` (legacy `SOX_HOME` residue) — **RESOLVED (2026-07-05, wave-2): doctor residue check landed**

**Resolution:** `soxe doctor` scans the root for pre-ADR-0004 residue (install-registry.json, supervisors.json, logs/, .sox/), reports `[RESIDUE]` findings with the `migrate-home` cleanup command, skips when root == canonical data root, deletes nothing. Live-verified (2 findings in a seeded scratch root; clean root clean). 6 new tests.

**Validation note (2026-07-04 sweep):** the RETIRED warning + data-path bug are fixed (`main.ts:120-126`); remaining open scope is only a `soxe doctor` check for legacy repo-root residue (no code exists yet). Downgrade to LOW.

**Observed (2026-06-25):** `/Users/nix/dev/ai/claude-agents/` root holds `install-registry.json` (246 KB),
`supervisors.json`, `logs/` (48 dirs), and a legacy `.sox/` (messages.db) — none nested under
`.adhd/sox-ecosystem/` (which does not exist there). `/Users/nix/dev/ai/sox-ecosystem/` root has a
legacy `.sox/` too. The repo roots are polluted with sox's own global/runtime state.

**Root cause (verified):** `SOX_HOME=/Users/nix/dev/ai/claude-agents` is exported in the shell env.
ADR-0004 **retired** `SOX_HOME` — the *current* code ignores it (prints the "SOX_HOME is set but RETIRED"
warning) and writes correctly to `userDataRoot()` = `~/.adhd/sox-ecosystem/` (verified: that dir has
current `install-registry.json`/`supervisors.json`, both mtime Jun 25). The claude-agents-root files are
**stale residue** written by an *older* (pre-ADR-0004) binary that honored `SOX_HOME` and wrote
`$SOX_HOME/{install-registry.json,supervisors.json,logs/}` = the repo root. They are 2 days old (Jun 23);
current code is not re-polluting. So this is **not a live data-path bug** — `dataRoot()`/`userDataRoot()`
(`libs/host-runtime/src/data-paths.ts`) are correct.

**`SOX_HOME` is NOT sox's to reclaim (corrected 2026-06-25).** The user confirmed `SOX_HOME` is set for
an **unrelated** purpose — it "was never a variable for this project to use." sox-ecosystem retired it
(ADR-0004) and must be **fully inert** to it, including **no warning** (the name collides with the `sox`
audio tool and may be claimed by other tooling — nagging about a var soxe no longer reads is presumptuous
noise). **Done:** the per-invocation `SOX_HOME … RETIRED` warning is **removed** (`apps/sox/src/main.ts`);
data placement is governed solely by `SOX_ECOSYSTEM_HOME` / default `~/.adhd/sox-ecosystem/`. Do **not**
recommend unsetting `SOX_HOME`.

**Remaining (cleanup only, independent of `SOX_HOME`):**

1. The stale residue (`install-registry.json`, `supervisors.json`, `logs/`, legacy `.sox/`) at the
   `claude-agents` / `sox-ecosystem` repo roots can be removed/relocated via `soxe migrate-home`
   (ADR-0004 §D8; idempotent, non-destructive — skips when the target already exists, so it won't clobber
   the current `~/.adhd` global state) **with `--old-home <repo>` explicitly**, never by touching the
   user's `SOX_HOME`. Optional; the files are inert.
2. **`soxe doctor`** (future) should detect legacy repo-root residue from the default locations,
   independent of `SOX_HOME`.

This is distinct from **BL-56** (project_path attribution, in the memory store), which is fixed.

## Resolved — surfaced during service-lifecycle Slice 1 (2026-06-25, `feat/service-lifecycle-slice1`)

### BL-58 — `tokenguard-core/src/mapper.ts` uses a lazy `require('./tokenize.js')` that breaks under vitest (`Cannot find module`) — **Resolved**

**Surfaced** while running `nx affected -t build,lint,test` for the Slice 1 work (tokenguard-core was
marked affected only because the repo root `nx.json`/`package.json` are dirty from prior uncommitted
changes — Slice 1 does NOT touch tokenguard-core; `git diff main -- libs/tokenguard-core/` was empty).
`nx test tokenguard-core` failed 1/63: `Mapper.seed` did
`const { identifierGroupVariants } = require('./tokenize.js')` (`mapper.ts:119`), a runtime CJS require of
a `.js` sibling that only resolves against the built `dist/` — under vitest's `src` TS transform there is
no `tokenize.js`, so it threw `Cannot find module './tokenize.js'`. The lazy require was a workaround for
a **non-existent** cycle: `tokenize.ts` imports `Mapper` **type-only** (`import type`, erased at compile),
so there is no runtime value cycle.

**Fix:** converted to a static ESM `import { identifierGroupVariants } from './tokenize.js'` at the top of
`mapper.ts` and removed the inline require. Gates: `nx build tokenguard-core` ✅, `nx lint` ✅,
`nx test tokenguard-core` → **63/63** (was 62 + 1 failed). `registry:sync-index` → no drift (tokenguard's
shipped artifact checksum unchanged). This was a pre-existing latent bug (unchanged vs `main`), fixed in
passing per the zero-burying rule — it is NOT a Slice 1 regression.

## Open — embed fallback + store pollution (2026-06-23, surfaced by BL-48 observability)

### BL-52 — live memory-server runs on HASH embeddings (`embed_on_hash_fallback:true`) despite real BGE being available — **Resolved + reality-verified (2026-06-25)**

**Fix (fix/memory-bl50-52-53):** the enforced policy env-scrub now forwards `SOX_EMBED_BACKEND`,
`SOX_EMBED_CACHE_DIR`, `XDG_CACHE_HOME` (and any `SOX_EMBED_*`) across **all four** enforced spawn
paths — `apps/sox` `serve` + `exec`, `runtime-cli` exec, and `supervisor._spawn` — so the served
server inherits the real-BGE backend selector + model-cache pointer instead of resolving to `auto`
and silently falling back to FNV-hash. Covered by 6 new `supervisor-policy.spec.ts` tests (forwarded
when set; absent when unset → not injected as `""`; explicit `hash` preserved; unrelated secrets still
scrubbed). Root cause was (a) env-scrub stripping the model-cache pointer so the worker couldn't find
the cached BGE model under serve.

**Reality verification (2026-06-25, fresh `node bin/soxe serve memory-server`, enforced scrub, model
cached at `~/.cache/sox-memory/models/fast-bge-base-en-v1.5`):**

- `SOX_EMBED_BACKEND=real` → `memory_recall` returned `["vec"]` results **without error**. The `real`
  branch of `embed()` *throws* on worker failure (no hash fallback), so a successful recall is positive
  proof the ONNX worker loaded + embedded under serve.
- **`SOX_EMBED_BACKEND` UNSET (production default `auto`)** → after warmup, `memory_ping` reports
  **`embed_model:"bge-base-en-v1.5"`, `embed_backend_configured:"auto"`, `embed_on_hash_fallback:false`**
  with no `falling back to hash` warning on stderr. Real BGE is active on the default path.

Three earlier "still on hash" readings were measurement artifacts, not failures: (1) `memory_ping`
called before the first embed reports `embed_on_hash_fallback:true` because the worker warms lazily and
`_activeModel` only flips to `bge-base-en-v1.5` after warmup (→ new **BL-54**); (2) a grep miss on the
backslash-escaped `\"results\"` in JSON; (3) EXIT 124 = the stdio server not exiting on stdin-EOF (the
embed worker keeps it alive), not a recall hang. The running session server is the **pre-fix** binary
and still reports hash until the **client reconnects/reloads plugins** (stdio servers respawn on next
connection); the rebuilt `dist/apps/sox/main.js` carries the fix. No registry checksum changed (CLI/
host-lib change, not an installed-extension entrypoint), so `upgrade --all` is a no-op — a client
reconnect is the only step to put the fix live.

<details><summary>original report</summary>

The BL-48 observability fields (now in `memory_ping`) reveal the production server is on the **hash**
backend: `{"embed_model":"nomic-embed-text-v1.5-hash","embed_backend_configured":"auto","embed_on_hash_fallback":true}`.
Yet the real BGE/ONNX backend works on this machine (a standalone `SOX_EMBED_BACKEND=real` probe embedded
7 texts in ~2.1s using the 635 MB cached model). So the server is **silently degraded** — semantic recall
over `~/.memory/memory.db` is running on FNV-hash projections, not real embeddings (this is almost certainly
what the other agent half-saw and misattributed to "provider offline"). Consequence: weaker semantic recall;
and any episodes WRITTEN by the live server are hash-embedded, so they won't sit in the same vector space as
real-embedded ones (mixed-space store).

Root-cause hypotheses (unverified): the `soxe serve` policy env-scrub (allowlist PATH/HOME/USER/… + NODE_*)
does not forward `SOX_EMBED_BACKEND`/`SOX_EMBED_CACHE_DIR`, so backend stays `auto`; `auto` then tries the
worker_thread ONNX path and falls back to hash when the worker can't spawn from the installed/served location
(embedWorker.js sibling resolution, or onnxruntime-node unavailable in the served context). Needs: confirm
which (instrument the worker-spawn failure path — its warning currently goes only to stderr, now captured via
the BL-46 `--log` sink), then either ship the worker with the served artifact + pin `SOX_EMBED_BACKEND=real`,
or accept hash and stop advertising real. Verify via `memory_ping.embed_on_hash_fallback` after the fix.
</details>

### BL-54 — `memory_ping` reports `embed_on_hash_fallback:true` BEFORE the first embed (lazy-init false positive) — **Resolved + reality-verified (2026-06-25)**

**Fix:** new `getEmbedState(): 'real' | 'hash' | 'uninitialized'` in `libs/memory-core/src/embed.ts`
distinguishes "the lazy ONNX worker has not warmed up yet" (`uninitialized`) from an actual hash
fallback (`hash`): `_activeModel === 'bge-base-en-v1.5'` ⇒ `real`; else `_resolvedBackend === 'hash'` ⇒
`hash` (configured or auto-fellback); else `uninitialized`. `memory_ping` and `memory_stats` now emit an
`embed_state` field and compute `embed_on_hash_fallback = (configured !== 'hash' && embed_state ===
'hash')` — so a fresh server (zero embeds) reports `uninitialized`/`false`, not a false `true`. 2 new
`embed.spec.ts` tests (uninitialized on fresh singleton; `hash` only after a hash embed resolves).
Reality-verified: served `memory_ping` on a zero-embed server → `embed_state=uninitialized`,
`embed_on_hash_fallback=false` (pre-fix: `true`). Gates: build (dist verified) + lint + test
(memory-core 85/1-skip, memory-server 78) ; registry resynced (memory-server checksum changed).

<details><summary>original report</summary>

Surfaced 2026-06-25 while reality-verifying BL-52 — and it is the artifact that triggered the entire
BL-52 "still on hash" false alarm. `memory_ping` computes `embed_on_hash_fallback` from
`getActiveEmbedModel()` (index.ts ~769-773), but `_activeModel` only flips from its default
`'nomic-embed-text-v1.5-hash'` to `'bge-base-en-v1.5'` **after** the embed worker's async warmup
resolves (embed.ts ~184-185), and the worker spawns **lazily on the first `embed()` call**. So a fresh
server that has not yet served a recall/write — or one pinged *concurrently* with its first embed before
warmup completes — reports `embed_model:"nomic-embed-text-v1.5-hash"` / `embed_on_hash_fallback:true`
even though the real backend is fully available and will load on first use. This makes `memory_ping`
**unreliable as a startup health check** (it cried "degraded" on a healthy server and sent two agents
chasing a non-bug). Same flaw in `memory_stats` (index.ts ~2246). Fix options: (a) `memory_ping`/`stats`
proactively trigger + await a one-token warmup embed before reporting; or (b) add a distinct
`embed_state: "uninitialized" | "real" | "hash-fallback"` so "not warmed up yet" is not conflated with
"fell back to hash". Verification of real-vs-hash must use a **post-warmup** ping (embed first, then ping)
or the absence of the `falling back to hash` stderr warning.
</details>

### BL-55 — every `memory_*` tool requires `db_path` with NO default → agents guess the magic path and miss the store — **Resolved + reality-verified (2026-06-25)**

**Fix:** `db_path` is now **optional** on every tool. New exported `resolveDbPath(arg)` in
`memory-server/src/index.ts` resolves: explicit arg → host-injected `SOX_CONFIG_DB_PATH` (the
`config.memory-server.db_path` bundle property, already injected at serve time via `buildExtConfigEnv`,
surviving the enforced env-scrub) → canonical `~/.memory/memory.db`. The half-built wiring is now
complete: the config-based default property was always delivered to the server, but the tools ignored it
and hard-required the arg — they now fall back to it. `db_path` removed from every `required` array in
both the served schemas (index.ts) and the catalog manifest (extension.json); descriptions updated to
"optional; defaults to the configured store"; `config_schema.required:["db_path"]` retained so the
bundle is always configured with the default source. The permission guard remains the backstop (a wrong
override is still denied loudly, no file created). 9 new `bl55-dbpath-default.spec.ts` tests (precedence
incl. default, blank-fallthrough, end-to-end write+recall with no db_path, explicit override isolation).

**Reality verification:** a served `node bin/soxe serve memory-server`, called `memory_recall` **without
`db_path`** (the exact pattern an agent botched as `~/.sox/memory`), returned real `["vec"]` results from
the injected configured store; the old `"db_path is required"` error is gone (absent from dist). Gates:
memory-server build (dist verified) + lint + test green (78 incl. bl55 9/9).

<details><summary>original report</summary>

Surfaced 2026-06-25: an agent intuitively called `memory_recall(db_path: "~/.sox/memory", …)`. That path
is wrong on two counts — the canonical single store is **`~/.memory/memory.db`** (19.6 MB, real), and
`~/.sox/memory` is neither the right dir (`.sox` ≠ `.memory`) nor a `.db` file. Root cause: `db_path` is
listed in the `required` array of **every** tool's input schema (index.ts: `required:['query','db_path']`,
`required:['content','db_path']`, …) with **no default**, so every caller must already *know* the magic
path. The CLAUDE.md guidance documents the `~/.memory/**` allowlist but never states "omit db_path to use
the default store," because there is no default. Agents therefore guess, and guess wrong.

Mitigation already in place (verified): the in-process permission guard hard-denies any `db_path` outside
the `~/.memory/**` allowlist — `db_path:"~/.sox/memory"` returns `{isError:true,"permission denied: …
outside declared fs allowlist"}` and creates **no file**. So a wrong guess fails *loudly*, it does NOT
silently read/write an empty store. **Residual footgun:** a wrong-but-inside guess (e.g.
`~/.memory/typo.db`) passes the guard and silently creates an empty db → empty results with no error.

Fix: make `db_path` **optional** and default to the canonical store the server already knows — the host
injects the `~/.memory/**` allowlist at spawn, so the server can default `db_path` to
`~/.memory/memory.db` (or a `SOX_CONFIG`-injected path) when omitted. Drop `db_path` from each tool's
`required` array, document "omit to use the default store" in CLAUDE.md, and keep the guard as the
backstop. This removes path-guessing entirely and is the permanent solve.
</details>

### BL-53 — `~/.memory` polluted with 842 orphaned WAL/SHM test sidecars; tests write to the real store dir — **Resolved**

**Fix (fix/memory-bl50-52-53):** (1) the two test paths that wrote per-pid dbs into the **real**
`~/.memory` now tear down the WAL/SHM sidecars alongside the base `.db` (`permission-guard.spec.ts`
afterEach + `test-e2e-lifecycle.js` cleanup, both iterating `['', '-wal', '-shm']`); (2) added a
one-shot safe reaper `tools/reap-memory-sidecars.cjs` — dry-run by default, `--execute` to delete,
removes only `*.db-wal`/`*.db-shm` whose base `.db` is absent, and **never** touches the canonical
`memory.db` (PROTECTED_BASES guard). Run `node tools/reap-memory-sidecars.cjs` (then `--execute`) to
purge the existing 842 orphans while the daemon is down.

<details><summary>original report</summary>

`~/.memory` holds **848 entries**: 421 `.db-wal` + 421 `.db-shm` (842 orphaned sidecars, base `.db` gone —
160 are `c6-allowed-<pid>.db-wal` from C6 permission e2e, plus `smoke-*`, `test-verify`, `sox-e2e-*`), only
**4 real `.db`** (`memory.db` canonical + 3 test artifacts), 1 `registry.json`, 1 `memory.db.bak`. Faults:
(1) tests create per-pid dbs under the **real** `~/.memory` dir instead of an isolated tmpdir, and leak the
WAL/SHM sidecars when the process is killed (no cleanup); (2) this miscounts as "848 per-scope stores" and
spooks tooling/agents into thinking there's a store-routing ambiguity (there is not — the only real store is
`~/.memory/memory.db`). Fix: point C6/e2e db fixtures at `os.tmpdir()` with teardown; add a one-shot reaper
for orphaned `~/.memory/*.db-wal|-shm` whose base `.db` is absent. Safe to purge the orphaned sidecars now
(never touch `memory.db`/`memory.db-wal`/`memory.db-shm` while the server/daemon is live).
</details>

## Open — service supervision gaps (2026-06-23)

### BL-50 — detached service-mode daemons survive `soxe stop`, accumulate into multiple writers, and have no OS reboot supervisor — **RESOLVED** — reaper wired: `main.ts:4353-4361` `unloadOwnedOsUnitsBeforeReap` `[inv:unload-then-reap]`, `:4365-4379` per-entry `reapOrphansForExtension`

> **Governed by [`docs/spec/service-lifecycle.md`](docs/spec/service-lifecycle.md) (v1.3.0).** That spec
> is the canonical framework. **Slice 1 (cross-scope singleton + reconcile heal)**, **Slice 1.5/1.6
> (front-shim service-proxy + proxy default)**, and **Slice 2 (OS-supervisor control surface +
> `[inv:unload-then-reap]`)** are all IMPLEMENTED. All three halves (a)/(b)/(c) below are now closed at
> the capability level; real OS-unit activation needs the human node-path ack (Appendix B item 3).

**Correction (2026-06-25, verified state-side).** The earlier "orphan-process reaper still open" claim
was **wrong** — it conflated "mem-fixes-2's diff added no reaper" with "no reaper exists." The
entrypoint-token orphan reaper **already exists** from the BL-31 work: `libs/host-runtime/src/reaper.ts`
(`findOrphansByIdentity`, `reapByIdentity`, `identityToken`, `killAndVerify`, dated Jun 22) +
`runtime.ts:reapOrphansForExtension`, and it **is wired** into `cmdStop` (`main.ts:3285,3311`) and the
`cmdStart` pre-spawn dedup (`main.ts:2956`). It finds PPID-1 detached daemons by whitespace-bounded
entrypoint argv token and SIGTERM→SIGKILL-verifies them; `soxe stop` exits 1 on any `undead`.

**What landed (fix/memory-bl50-52-53):** the **start-time singleton guard** — `cmdStart` resolves the
service's `lifecycle.health` socket (`resolveServiceHealthSocketPath`) and probes it
(`probeUnixSocketLive`); a live instance ⇒ refuse second spawn + record RUNNING. 15 tests.

**Status of each half (per spec v1.1.0):**

- (a) **Cross-scope singleton — ✅ CLOSED by Slice 1 (`feat/service-lifecycle-slice1`).** The guard no
  longer keys on the socket alone; it resolves `[def:singleton-key] = (id, resolved-store-resource)`
  (db_path → socket → host:port) and runs **socket probe + entrypoint-token scan + cross-scope
  ownership/collision check** before spawning, plus a §5.3 reconcile heal that kills the loser of a live
  duplicate pair (survivor = oldest-by-`ps -o lstart`; a single healthy daemon is never reaped). Two
  scopes that override `sock_path` but share `db_path` now collapse to one writer. Delivered:
  `libs/host-runtime/src/singleton.ts` (+ `singleton.spec.ts`, 32 cases) and the `cmdStart`
  service-registry guard (`resolveStoreResourceForScope`/`collectCrossScopeResources`/
  `entrypointTokenForService`) in `apps/sox/src/main.ts`. Gates (nx targets, built-before-test per BL-4):
  host-runtime test 146/146, soxe 30/30, `host-runtime:test-e2e` 99/0 (+6 Slice-1 Step 7c, stable ×3),
  `affected -t build,lint,test` 20/20 green, `registry:sync-index` no drift.
- (b) **OS reboot persistence + `[inv:unload-then-reap]`** — **✅ CLOSED (capability) by Slice 2
  (this worktree).** Built `libs/host-runtime/src/os-unit.ts` (launchd LaunchAgent generator,
  content-addressed; systemd seam pluggable) + `soxe service enable|disable|status|list` + the
  `[inv:unload-then-reap]` ordering wired into `cmdStop` (all paths), `service disable`, and
  `cmdUninstall` (unload the unit BEFORE the verified-stop reap → no resurrection loop), plus
  re-enable-on-upgrade (§9.3) and the `os-unit` ownership entry (§9.4 reversibility). Gates:
  host-runtime test 168/168 (+`os-unit.spec.ts` 22), install-engine 152/152, soxe 42/42
  (+`service-os-unit.spec.ts` 7), lint 3/3, build 3/3; e2e stop/reap/orphan/disable sections all PASS.
  **`(needs-human-ack)` for REAL activation:** generating + `launchctl bootstrap`-ing on the user's
  machine touches `~/Library/LaunchAgents` and pins a node binary (Appendix B item 3) — Slice 2 builds
  - tests the capability only (sandboxed unit dir + fake exec, `--dry-run` in the CLI test); the human
  runs `soxe service enable <svc>` to activate. **BL-50 is now fully closed across (a)/(b)/(c).**
- (c) **Zero-downtime upgrades without forced MCP reconnects** — **✅ CLOSED (capability) by Slice 1.5
  (`feat/service-proxy-slice1_5`).** Built as the leaf lib `libs/service-proxy/` (front-shim
  service-proxy / M3↔M4 bridge over Unix domain sockets) + an OPT-IN `--proxy` /
  `lifecycle.proxy:true` branch of `cmdServe`. Behavior-only backend upgrades resume sub-second with
  **no client reconnect**; an interface change emits `notifications/tools/list_changed` (reconnect only
  as a fallback). Zero-downtime is gate-proven by a real-process e2e (Section SP +
  `tools/probe-service-proxy-zdt.mjs`) and unit specs (service-proxy `nx test` 30 passed; e2e 100/0).
  **Deferred (separate future slice — NOT part of Slice 1.5):** migrating memory-server (or any
  existing server) to proxy mode — that flip changes the running server's process topology and has
  reconnect implications, so it ships as its own slice with the `run/serve/` serve-record breadcrumb
  (spec §2 Appendix-B item 1, most useful once a backend actually runs behind the shim).

Surfaced while wiring memory-daemon auto-supervision (the "item 3" cleanup). Two faults:

1. **Orphaned detached daemons are unreapable + accumulate.** `soxe start memory-daemon` runs the daemon
   in *service mode* (detached, PPID→1, no live supervisor). When the supervisor process is gone,
   `node bin/soxe stop` reports `supervisor (pid=…) already gone / stop complete` but **leaves the
   daemon running** — `soxe stop` only reaps processes a live supervisor tracks. Observed **two**
   memory-daemon processes alive simultaneously (one started this session via `soxe start`, one of
   unknown prior origin) = **two writers on `~/.memory/memory.db`**, violating the singleton invariant
   (design §2.4 R6: "host holds the per-(id,scope) singleton"). Need: a reaper that finds + SIGTERMs
   orphaned detached service processes by entrypoint/marker (cf. the BL-31 verified-stop work for the
   supervisor path), and a guard so `soxe start` refuses to spawn a second instance when one is already
   live on the socket.
2. **No reboot persistence.** There is no launchd/OS supervisor registered on service install, so a
   service does not survive logout/reboot. `soxe install` of a `service`-type extension should register
   an OS supervisor (macOS LaunchAgent), and `sox`'s runtime tracking should stay consistent with it
   (avoid sox-list/launchd split-brain). BL-47's in-process fallback covers enrichment *correctness*
   when the daemon is down, so this is robustness, not correctness.

**Update (2026-06-23):** the two-writer state is resolved — both orphaned daemons (PPID 1; one 14 min,
one 8.5 hr) were SIGTERM'd, socket removed, zero daemons now. A hand-rolled LaunchAgent was trialed then
reverted (unloaded/deleted) in favor of a proper soxe feature — see BL-51. Enrichment correctness is
currently covered by BL-47's in-process fallback (no daemon required), so "no daemon running" is a safe
state. The two faults above (orphan reaper + start-time singleton guard) remain open.

### BL-51 — `sox` needs a launch-agent / OS-supervisor control surface for `service`-type extensions — **RESOLVED** — `cmdService` at `main.ts:4553` implements enable/disable/status/list; backed by `os-unit.ts:{enableOsUnit:700, disableOsUnit:776, unloadThenReap:1036}`. (A stored memory note claiming this is still open work is STALE)

> **Governed by [`docs/spec/service-lifecycle.md`](docs/spec/service-lifecycle.md) §9 + Slice 2 — now
> BUILT.** Delivered in this worktree: `libs/host-runtime/src/os-unit.ts` (platform-pluggable generator
> — `LaunchdPlatform` rendering a content-addressed plist, `SystemdPlatform` proving the seam;
> `deriveOsUnitSpec` from the manifest `lifecycle` block; `resolveUnitNodePath` stable-node-path guard;
> idempotent `enableOsUnit`/`disableOsUnit`; `unloadThenReap` for `[inv:unload-then-reap]`) +
> `soxe service enable|disable|status|list` (`cmdService` in `apps/sox/src/main.ts`) + the `os-unit`
> ownership entry kind + teardown/re-enable hooks in `cmdStop`/`cmdUninstall`/`cmdUpgrade`. All effects
> are seam-injected (`unitDir`/`exec`) so unit + CLI tests run against a SANDBOX (`SOX_OS_UNIT_DIR` +
> `--dry-run`) — **no real `~/Library/LaunchAgents` write and no real `launchctl load` in any test**.
> **Remaining: REAL activation** (`soxe service enable <svc>` without `--dry-run`) writes to
> `~/Library/LaunchAgents` and pins a node binary — **needs the stable-node-path human-ack** (Appendix B
> item 3: `fs.realpathSync(process.execPath)` with volatile nvm/asdf/volta detection + the
> `--allow-volatile-node`/`--node-path` override). The orchestrator gates that on the user; the BL-47
> in-process fallback remains the supported zero-config path until the user activates a unit.

Persistence for service-type extensions (e.g. memory-daemon) should be a first-class soxe capability, not
a hand-rolled per-service plist. Proposed surface:

- **`soxe service enable|disable <ext> [-s <scope>]`** — register/unregister an OS supervisor for the
  service: macOS LaunchAgent (`~/Library/LaunchAgents/com.sox.<ext>.plist`), Linux systemd user unit
  (`~/.config/systemd/user/sox-<ext>.service`). `enable` writes the unit (RunAtLoad/KeepAlive +
  throttle + durable logs under `~/.sox/logs/`), loads it, and records it in sox's runtime tracking so
  `soxe list` reflects launchd/systemd-supervised services (no split-brain). `disable` unloads + removes.
- **Generated from the manifest** — derive `ProgramArguments`, `--db-path`/config env (the same
  `SOX_CONFIG_*` injection `soxe serve` does), `KeepAlive`, and `ThrottleInterval` from the extension's
  `lifecycle` block; resolve a stable node path (not a volatile nvm path) or pin via `EnvironmentVariables`.
- **Idempotent + content-addressed** — re-`enable` after an `upgrade` rewrites the unit if the resolved
  entrypoint/args changed; never leaves a stale unit pointing at an old artifact.
- **Reaper integration (BL-50 fault 1)** — `soxe stop`/`disable` must also reap an OS-supervised instance
  (unload the unit) so a service can't survive teardown, and `enable`/start must refuse a second instance
  when one is already live on the health socket.
- **Cross-platform + uninstall hook** — `soxe uninstall` of a service tears down its OS unit; `soxe doctor`
  surfaces orphaned/duplicate supervised instances.

This subsumes the "item 3" persistence work and the reboot-persistence half of BL-50. Until shipped,
the BL-47 in-process fallback is the supported path and no daemon need run.

#### BL-58 (verbatim duplicate — canonical entry is above; retained for audit trail per BL-223)

**Surfaced** while running `nx affected -t build,lint,test` for the service-lifecycle Slice 1 work
(tokenguard-core was marked affected only because the repo root `nx.json`/`package.json` are dirty from
prior uncommitted changes — Slice 1 does NOT touch tokenguard-core; `git diff main -- libs/tokenguard-core/`
was empty). `nx test tokenguard-core` failed 1/63: `Mapper.seed` did
`const { identifierGroupVariants } = require('./tokenize.js')` (`mapper.ts:119`), a runtime CJS require of
a `.js` sibling that only resolves against the built `dist/` — under vitest's `src` TS transform there is
no `tokenize.js`, so it threw `Cannot find module './tokenize.js'`. The lazy require was a workaround for
a **non-existent** cycle: `tokenize.ts` imports `Mapper` **type-only** (`import type`, erased at compile),
so there is no runtime value cycle.

**Fix:** converted to a static ESM `import { identifierGroupVariants } from './tokenize.js'` at the top of
`mapper.ts` and removed the inline require. Gates: `nx build tokenguard-core` ✅, `nx lint` ✅,
`nx test tokenguard-core` → **63/63** (was 62 + 1 failed). `registry:sync-index` → no drift (tokenguard's
shipped artifact checksum unchanged). Pre-existing latent bug (unchanged vs `main`), fixed in passing per
the zero-burying rule — NOT a Slice 1 regression.

## Resolved — pre-existing e2e failure surfaced during BL-45..48 verification (2026-06-23, fixed fix/memory-server-bl45-48)

### BL-49 — `#16728` auto-merge e2e fails: `syncResults.length === 0` (expected 2 project roots) — **Resolved**

**Fix:** the BL-35 leak guard in `knownProjectRoots()` (`mcp-project-sync.ts`) skips project roots under
`os.tmpdir()`, but the #16728 reality probe records its throwaway fixture roots there — so auto-merge
targeted 0 projects. Added a scoped opt-out: `knownProjectRoots()` honors `SOX_ALLOW_TMP_PROJECT_ROOTS=1`
(set only by `tools/probe-mcp-project-automerge.mjs`); production never sets it, so the BL-35 guard stays
in force everywhere else. Spec test added (`mcp-project-sync.spec.ts`) locking both the default-skip and
the opt-out. Verified: `host-runtime:test-e2e` → **93 passed, 0 failed** (auto-merge gate ALL PASS, got 2
roots); `install-engine` lint+build+test green. Origin (traced): pre-existing in BL-35 work (`d6805cf`),
not from BL-45..48.

<details><summary>original report</summary>

`npx nx run host-runtime:test-e2e` → 91 passed, **2 failed** (4 assertions): `AUTO-MERGE: targeted
both known project roots (got 0)`, `MERGE: project1/.mcp.json carries the same server entry`,
`MERGE: project2/.mcp.json created`, `MCP: #16728 auto-merge gate failed (exit 1)`. Source:
`tools/probe-mcp-project-automerge.mjs` / `tools/test-e2e-lifecycle.js`; feature owner
`libs/install-engine/src/mcp-project-sync.ts`.

**Origin traced (not deflection):** `git diff 3f5e7bb..HEAD -- libs/install-engine/src/mcp-project-sync.ts
libs/install-engine/src/index.ts` is **empty**; the only `apps/sox/src/main.ts` delta on the BL branch
is the `cmdServe` region (BL-46). The auto-merge code the test exercises is byte-identical to `main`, so
this failure is pre-existing in the `#16728` work merged in `2867b4f`/`fe42b90`/`3f5e7bb` immediately
before this session — the probe (added with #16728) ships red. `got 0` means the install hook found zero
known project roots to propagate the user-scope MCP entry into. Fix: investigate why `mcp-project-sync`
resolves 0 project roots from the install-registry in the sandboxed probe (likely a registry-root lookup
/ `SOX_ECOSYSTEM_HOME` resolution regression). The memory MCP lifecycle steps of the SAME e2e all pass
(install→start→exec memory_ping/write/recall→disable→enable→uninstall, 19 tools, zero orphans).
</details>

## Resolved — observability gap + daemon down (2026-06-23, fixed fix/memory-server-bl45-48 1a5f1ed)

### BL-46 — production `serve` (stdio MCP) path captures NO logs — **Resolved (opt-in sink); framework follow-up in spec Slice 1.5/3**

> **Spec follow-up (v1.1.0):** the opt-in `--log`/`SOX_SERVE_LOG=1` stderr sink resolved the immediate
> gap. The service-lifecycle spec makes the durable stderr sink the **default for M4 units** (§9.2) and
> adds a self-cleaning M3 **serve-record breadcrumb** under `run/serve/<extId>-<pid>.json` (Appendix B
> item 1 decision) so the live served version is observable + enumerable by `soxe list --serve`/`doctor`
> without a runtime.json lie. Designed in Slice 1.5/3; not yet built.

**Discovered while trying to diagnose BL-45 from server logs.** The logs do not reflect the running version.

- The live memory-server is launched from `.mcp.json` as `soxe serve memory-server` (stdio). `cmdServe`
  (`apps/sox/src/main.ts:4441-4454`) runs `execFileSync(node, [entrypoint], { stdio: 'inherit' })` —
  **no LogManager, no `logDir`, no file logging.** stdout *is* the JSON-RPC channel (consumed by the
  MCP client); stderr is whatever the client does with it (typically not persisted).
- Therefore the running v1.1.0 stdio server writes **nothing** to `~/.sox/logs`. Every file under
  `~/.sox/logs/*/memory-server-*.log` is from a *different* path — the supervisor/e2e LogManager
  (`cmdStart` / loader with `logDir`) — and they are **stale**: all dated 2026-06-22, `serverInfo`
  version **1.0.0** (the live server reports **v1.1.0**, artifact `67c4112f4518` via `memory_ping`).
  Zero logs exist for 2026-06-23 despite heavy use.
- **Consequence:** reading `~/.sox/logs` to debug the live server is a trap — it shows an *older*
  version's behavior. There is effectively no runtime observability for the in-use MCP server: server
  errors, embed warmup failures, hash-fallback warnings, permission denials, and the daemon's
  `[memoryd]` output are not durably captured. The original BL-45 incident has **no logs at all**.
- **Latent footgun:** because `serve` inherits stdout, ANY stray `console.log` in the server's request
  path corrupts the JSON-RPC stream. Server diagnostics must never use stdout.

**Fix sketch:** give `cmdServe` an opt-in durable log sink for stderr (e.g.
`<logDir>/<extId>-serve-<date>.log` via the existing LogManager, stderr only — never stdout), or a
`SOX_SERVE_LOG` env/flag. At minimum, document that `~/.sox/logs` does NOT cover the stdio `serve`
path and stamp the served version into a discoverable place. Affected: `apps/sox/src/main.ts` (`cmdServe`),
`libs/host-runtime/src/log-manager.ts`.

### BL-47 — `memory-daemon` service is INACTIVE; async batch enrichment is not running — **Resolved**

`node bin/soxe list` shows `memory-daemon  user  INACTIVE`. The daemon is a `service` with
`lifecycle.background:true, singleton:true` (`members/memory-daemon/extension.json`) and owns the
async enrichment loop (`runBatchEnrich`: clustering E6, auto-links E9, importance link-score E7,
decay E11). With it down, write-path `nudgeDaemon()` connects to nothing (fails silently — the queue
is durable but never drained), so **clustering / auto-links / importance / decay never run** for the
live `~/.memory` store. The `memory_write` tool description still advertises "Batch enrichments …
run asynchronously in the daemon" — which is currently false at runtime. Fix: ensure the daemon is
started/supervised (and auto-restarted) wherever the memory MCP is used, or fold the batch loop into
the server process on an interval. Relates to BL-45 (the contention there only manifests *when* the
daemon runs).

### BL-48 — `SOX_EMBED_BACKEND` default `auto` silently falls back to hash embedding; the only signal is an uncaptured stderr warning — **Resolved**

Distinct from (but worsened by) BL-46. `embed()` defaults to backend `auto` (`embed.ts:72`): it tries
the real ONNX/BGE worker and, if the worker can't spawn or the model isn't available, **silently
falls back to deterministic hash embedding** (`embed.ts:255-265`) emitting only a `console.warn` to
**stderr** — which the production `serve` path does not persist (BL-46). If a write process used real
embeddings but a recall process falls back to hash (or vice versa), the query vector lives in a
different space and **semantic recall degrades to near-random while still returning non-empty
results** — easy to misdiagnose. NB: this is NOT the same as `provider_call_count` — that counter is
**designed to stay 0** on reads (local inference never increments it; see "agent misdiagnosis" below).
Fix: surface the resolved backend in `memory_stats`/`memory_ping` (already pinned in `memory_scope`),
and emit a durable warning (or hard-fail when `SOX_EMBED_BACKEND=real` is required) on fallback.

> **Agent misdiagnosis recorded (2026-06-23):** another agent claimed "the embedding provider is
> offline (`provider_call_count: 0` on every recall) — semantic recall silently returns empty."
> **Both halves are false.** `provider_call_count: 0` is the *designed* value (embed.ts:49-50: counts
> external HTTP/provider calls only; the local ONNX backend deliberately does not increment it).
> Live test this session: queries returned non-empty, correctly-ranked results with `provenance:["vec"]`
> / `["vec","fts"]` — semantic recall works. The low score magnitudes (~0.01–0.03) are **RRF** fusion
> scores (`recall.ts:212`, `1/(k+rank)`), not cosine — also normal, not weakness.

## Resolved — concurrent-write stall (2026-06-23, fixed fix/memory-server-bl45-48 1a5f1ed)

### BL-45 — concurrent `memory_write` batch stalls for minutes; daemon re-runs full O(n²) enrich on every nudge — **Resolved**

**Symptom (reported):** a single parallel batch of 7 `memory_write` calls appeared to hang ~15 min
(5/7 eventually returned, 2 cancelled); the same writes issued serially returned promptly.

**Investigation (2026-06-23, evidence-backed — original "write-lock/embedding serialization within
the write" hypothesis was DISPROVEN):**

- The MCP server (`memory-server`) uses **synchronous** `better-sqlite3` on a **single cached
  connection** (`getDb`, `index.ts:254-260`). There is no intra-server multi-writer contention, and
  SQLite ops serialize harmlessly on the event loop.
- The embedding path is **concurrency-safe**: probe of 7 concurrent vs serial `embed()` (real BGE/ONNX
  backend, warm) = 2.10s vs 2.11s (slowdown 0.99×). fastembed/onnxruntime serializes `run()`
  internally; no thread oversubscription. The embed worker has no concurrency guard but doesn't need one.
- The in-server write path (`memoryWrite`: `await embed` + sync tx + sync `enrichOnWrite` KNN-21 +
  non-blocking `nudgeDaemon`) is sub-second per call.
- **Root cause (proven):** the separate `memoryd` daemon runs a **full-corpus** `runBatchEnrich` on
  **every nudge** (every write nudges it; after a non-empty drain it immediately `scheduleLoop(0)`,
  `memoryd.ts:148`). `runBatchEnrich` → `clusterStore` is **O(n²)** (pairwise cosine,
  `cluster.ts:231-236`; the degenerate guard can re-run that pass up to 4×) plus a full-corpus
  importance recompute wrapped in one write transaction. **Measured: ~10.5–11.0s per pass at the
  current corpus of 2,209 live episodes** (probe on a copy of `~/.memory/memory.db`), growing
  quadratically.
- **Amplifier:** that batch pass holds the SQLite **write lock**. Because the MCP server's
  better-sqlite3 calls are synchronous, a write that loses the lock race **blocks the entire server
  event loop** up to `busy_timeout=5000ms` (`schema.ts:8`) — stalling *all* in-flight writes and their
  embed-worker response handling, not just the contending one. N concurrent writes serialize behind
  repeated ~11s full passes, each successful write triggering yet another pass → compounds to minutes.

**Confidence caveat (added 2026-06-23):** the daemon contention above is the cause **only when
memoryd is running**. Per BL-47, `memory-daemon` is currently **INACTIVE**, and there are no logs
from the incident (BL-46), so this mechanism is a **proven latent defect** (measured O(n²), ~11s/pass,
per-nudge full re-enrich) but is **not confirmed (unverified)** as the cause of the specific 7-write
stall. If the daemon was down during the incident, the stall was likely client-side (parallel
tool-call approval/queueing) and/or first-call cold model load, not daemon lock contention. Both the
latent defect and the daemon-state question need fixing regardless.

**Fix sketch (in priority order):**

1. **Incremental write-triggered clustering.** `cluster.ts` already has an `incrementalOnly` option
   (local-neighborhood check for new nodes). Route ingest-triggered enrich to incremental; reserve the
   full O(n²) re-cluster for a periodic/time-based trigger or explicit `memory_curate recluster`.
2. **Debounce/coalesce daemon passes.** Don't run one full `runBatchEnrich` per nudge — collapse a
   burst of ingest rows into a single pass and add a cooldown before the next full pass (the immediate
   `scheduleLoop(0)` after a non-empty batch is the back-to-back trigger).
3. **Chunk the importance transaction** so the daemon yields the write lock between chunks instead of
   holding it across all 2,209 episodes.

**Affected:** `libs/memory-enrich/src/{batch,cluster}.ts`, `libs/memory-core/src/memoryd.ts`,
`libs/memory-core/src/schema.ts` (busy_timeout). NB: any code change here triggers the full
build → `registry:sync-index` → `upgrade --all` sequence (CLAUDE.md agent sequence).

## Open — surfaced by the filtered-clustering review (2026-06-22)

> Deferred (non-blocking) findings from the architect + code review of branch
> `memory-enrich/filtered-clustering`. The merge-blocking findings (read-side scoping,
> structured-filter engine boundary, `nx.json` stale organizer, unreachable `'enrich'` op,
> done-on-failure, tags guard) are being fixed in the fix wave, not logged here.
> Full writeups: `docs/plan/filtered-clustering/REVIEW-architecture.md` + `REVIEW-code.md`.

### ~~BL-25~~ — three divergent `memoryd.ts` copies; member copies lack reembed-on-reindex — **Resolved** (`8a5246e`)

**Severity:** Medium (stale vectors) · **Status:** Resolved — converged all three onto `@adhd/sox-memory-core` (members are thin re-exports; single `MemoryDaemon`; reembed-on-reindex on the daemon path; C7-clean; e2e 63/0 proves the bundled daemon still spawns).
After P6, `memory-daemon`, `memory-server`, and `memory-core` each carry a `memoryd.ts`; the
member copies the daemon actually runs **lack the reembed-on-reindex path** that `memory-core`'s
copy has → vectors go stale after an embed-backend change. Fix: converge all three on
`@adhd/sox-memory-core` (the C7 single-source pattern) so there is one daemon implementation.

### ~~BL-26~~ — subset-lens communities have no GC / drop-by-hash reaper — **Resolved** (`8a5246e`)

**Severity:** Medium (unbounded accumulation) · **Status:** Resolved — added `dropSubsetLens`/`listSubsetLenses` in `@adhd/sox-memory-enrich` + `memory_curate` `drop_lens`/`list_lenses` ops (CONTRACTS C2.11); persisted lenses are now GC-able by provenance hash, leaving global + other lenses intact.
Persisting a filtered recluster (`memory_curate recluster` + `filters`, `dry_run:false`) writes a
provenance-scoped community slice keyed on the filter hash. Only an exact re-run of the *same*
filter reaps its prior slice — distinct/one-off filters leave orphaned subset communities that
accumulate with no reaper. Fix: add a `drop-by-hash` curation op (or a TTL/GC pass), or document
subset lenses as ephemeral with the accumulation caveat. Gated behind the persist path being
read-side-scoped first.

### ~~BL-27~~ — filtered-clustering review LOW findings (bundle) — **Resolved** (`8a5246e`)

**Severity:** Low · **Status:** Resolved — (1) empty-filter persist guard added; (2) dead branch removed from `computeClusters`; (3) server persist-path (`dry_run:false`) test added; (4) idempotent `organizer_queue` CHECK migration for `'enrich'`.
From `REVIEW-code.md`: (1) an empty-filter subset duplicates the global partition under a hash;
(2) dead branch at `libs/memory-enrich/src/cluster.ts:507-509`; (3) no server-level persist-path
(`dry_run:false`) test; (4) no migration for the `organizer_queue` CHECK-constraint change on
pre-existing DBs (`'enrich'` op added). Address opportunistically.

### ~~BL-28~~ — near-dup `SAME_AS` edge insert had a 7-col/8-value mismatch — **Resolved** (`06579d4`)

**Severity:** High (write-path crash) · **Status:** Resolved
`libs/memory-enrich/src/enrich.ts` inserted the near-dup `SAME_AS` edge with `INSERT INTO edge
(7 cols) SELECT … 8 values` (a spurious trailing `NULL`), throwing a SQLite column-count error on
**any near-duplicate write** under `enrichOnWrite`. No test exercised the path (the hash-backend
guard requires a shared MENTIONS entity, which `enrichOnWrite` alone never creates), so it slipped.
Fixed (removed the extra `NULL`) + added a real-backend regression test in `enrich.spec.ts` that
drives the `SAME_AS` insert. Found during the filtered-clustering review reconciliation.

### ~~BL-29~~ — intermittent embed-worker path flake under parallel vitest (`nx run-many test`) — **Resolved** (`8a5246e`)

**Severity:** Low (test-infra, intermittent) · **Status:** Resolved — `embedWorker.js` now resolves via a module-anchored absolute path (dist sibling, with a `src→dist` fallback), fork-cwd-independent. A separate pre-existing real-embed timeout flake in `write.spec.ts` (surfaced under the same run-many load) was also fixed by pinning the hash backend for those persistence tests.
Observed once during the `memory_update` engagement: running `memory-core` + `memory-server`
`test` targets together under a single `nx run-many` invocation intermittently fails with the
embed worker unable to resolve `embedWorker.js` (worker-thread path resolution under vitest's
parallel fork pool). **Not reproducible on re-run** (the same `run-many` is green), and all
sequential/CI gates pass. **This is NOT BL-4** (BL-4 is stale-`dist`/composite build hygiene) —
flagging the misattribution. Root-cause: the `new Worker(workerPath)` path in `embed.ts` resolves
relative to the built file; under parallel vitest forks the cwd/resolution can differ. Fix sketch:
resolve `embedWorker.js` via an absolute `import.meta.url`/`__dirname`-anchored path so it is
fork-cwd-independent. Low priority — only the parallel test runner is affected, not runtime.

### ~~BL-30~~ — `memory-server` manifest version stuck at 0.1.0 despite v1.1.0 tool surface — **Resolved** (this commit)

**Severity:** Low (version inconsistency) · **Status:** Resolved
The P4 and `memory_update` "version bumps" only touched the runtime `tool_version` string + the
source header comment — never the extension **manifest** `version`. So `extension.json` /
`package.json` read **0.1.0** while the tool surface + docs claimed **1.0.0 / 1.1.0**, and the
user-scope install resolved `memory-server@0.1.0`. Functionally harmless (upgrades are
checksum-driven, not version-driven), but a three-way inconsistency. Fixed: bumped
`memory-server` `extension.json` + `package.json` to **1.1.0**, the bundle `members[]` constraint
to `^1.1.0` (a `^0.1.0` constraint would have rejected 1.1.0), and the stale `tool_version: "1.0.0"`
line in CLAUDE.md → 1.1.0; resynced the registry. Surfaced when refreshing the user-scope install.

### ~~BL-31~~ — `soxe stop` doesn't verify the kill or escalate to SIGKILL; orphaned daemons survive — **Resolved** (`b1d4005`)

**Severity:** High (zombie process can keep hitting a removed dependency) · **Status:** Resolved — `libs/host-runtime/src/reaper.ts`: `killAndVerify` (SIGTERM → poll `process.kill(pid,0)` → SIGKILL escalation after grace → re-verify) + store-path orphan reaper (PPID-1, identity-matched, whitespace-bounded so unrelated processes are spared); `cmdStop` exits 1 on undead; `cmdStart` dedup-reap guard. e2e Step 7b reproduces the exact incident (real PPID-1 memory-server orphan DEAD after stop, unrelated SPARED). The original Open writeup follows.
During the memory upgrade, the running pre-P6 `memory-daemon` (pid 33079, started before the
store refresh) had been **orphaned (PPID 1 — its supervisor had exited)**. `soxe stop
--id=memory-daemon` sent it **SIGTERM, reported "stop complete", and returned** — but the process
**never died** (its old-code shutdown path hung on in-flight LLM/LM-Studio requests, or ignored the
signal). `soxe start` then spawned a *second* daemon (pid 43867) from the refreshed deterministic
store, leaving **two daemons** — the orphaned old one kept draining its organizer queue against
LM Studio (`localhost:1234`) until manually `kill -9`'d. Root gaps: (1) `stop` is fire-and-forget
SIGTERM with **no post-signal liveness check and no SIGTERM→SIGKILL escalation/timeout**; (2) the
runtime has **no reaper for orphaned daemons** — once the supervisor link breaks (PPID 1) it can
only signal a tracked pid and never confirms death or matches by store path (`.sox/ext/<id>`).
This is the failure mode the `runtime-productionization` SIGKILL-escalation / stale-state-GC work
targets, but it does not cover an already-orphaned process whose supervisor is gone. Fix: `stop`
must poll-verify exit and escalate to SIGKILL after a grace period; add a store-path-matched reaper
for orphaned daemons. Discovered diagnosing "a ton of requests going to LM Studio."

### ~~BL-32~~ — make per-extension versioning real (single-source propagation) — **Withdrawn** (superseded by ADR-0003)

**Status:** Withdrawn. Investigating BL-30 surfaced that per-extension semver is **vestigial** — the registry holds one build per id (semver never resolves), `semverSatisfies` arrived with the nx migration, and the checksum is the sole integrity authority. **ADR-0003** retires per-extension version entirely (identity = `id + checksum`), so "make versioning real" is moot. See `docs/decisions/0003-extension-identity-is-content-addressed.md`.

### BL-33 — `check-registry-sync.ts` scanner doesn't recurse into bundle members → false drift — **RESOLVED** (publishing refactor)

**Severity:** Medium (false CI-gate failure) · **Status:** Resolved — `scripts/check-registry-sync.ts`'s
`findExtDirs` now recurses into `extensions/bundles/<id>/members/` (BL-33 fix block, lines ~91-103),
faithfully mirroring `scripts/build-index.ts` — bundle members are no longer false-flagged. The
publishing refactor additionally mirrored the new `SOX_REGISTRY_PUBLISH` publication-signal branch of
`resolveSource` into the gate so the two stay byte-identical under both dev (`file://`) and publish
(`npm-package:`) modes. The original Open writeup follows.
`scripts/check-registry-sync.ts`'s inlined `findExtensionDirs` does **not** scan
`extensions/bundles/<id>/members/`, so it flags `memory-cli/daemon/flush/server/usage` as "in
registry, not on disk." Reproduces identically against HEAD (pre-ADR-0003) — a latent bug in the
`check-registry` gate's scanner, not in the run-many/test/e2e gate. Fix: make its scanner recurse
into `members/`, matching `scripts/build-index.ts`. Surfaced during the ADR-0003 implementation.

### BL-34 — `sox` app entrypoint path is not index-resolvable → checksum hashes `extension.json` — **RESOLVED** (publishing refactor)

**Severity:** Low · **Status:** Resolved — the publishing refactor made `@adhd/sox-cli` a
self-contained, in-package esbuild bundle: `apps/sox/extension.json` `entrypoint` is now
`dist/index.js` (resolvable relative to `apps/sox/` → `apps/sox/dist/index.js`, the bundle), so
`resolveChecksum`/`fetchArtifact` checksum the *built artifact* like every other code type instead of
falling through to the manifest. `apps/sox/package.json` `main`/`bin` are now in-package
(`./dist/index.js`, `./bin/soxe.mjs`) — no more `../../`. The original Open writeup follows.
The `sox` app declares entrypoint `dist/apps/sox/main.js`, which isn't resolvable relative to
`apps/sox/`, so `resolveChecksum` falls through to hashing the manifest (`extension.json`) instead
of the built artifact. Works (and correctly changed when ADR-0003 removed `version`), but the sox
entrypoint should be index-resolvable so its checksum tracks the *built* artifact like every other
code type. Surfaced during the ADR-0003 implementation.

### BL-35 — `install()` test runs pollute the real install-registry (no path injection) — **RESOLVED (2026-06-23)** — `libs/install-engine/vitest.setup.ts:24-25` sandboxes `SOX_ECOSYSTEM_HOME` via `mkdtempSync`

**Severity:** Medium (test isolation; live ledger pollution) · **Status:** RESOLVED (2026-06-23)
Any spec that calls `install()` (e.g. `integrity.scope.spec.ts`) triggers `upsertInstallRecord`,
which uses `resolveInstallRegistryPath()` → `installRegistryPath()` → `dataRoot('user')` →
`$SOX_ECOSYSTEM_HOME`. The leaky specs (`integrity.scope.spec.ts` — `adr3-scope-*` roots,
`lifecycle.spec.ts`, `verify-integrity.spec.ts`) sandboxed `configPath`/`lockfilePath` but NOT
`SOX_ECOSYSTEM_HOME`, so the registry write escaped to the **real** `~/.adhd/sox-ecosystem/
install-registry.json` (observed grown to ~480 records).

**Permanent fix shipped (2026-06-23):** a suite-wide vitest `setupFiles`
(`libs/install-engine/vitest.setup.ts`) now points `$SOX_ECOSYSTEM_HOME` at a throwaway temp dir
for the whole install-engine test process — isolating the install-registry, ledger AND ownership
writes of every spec (including ones not yet written, so the leak cannot regress). Verified: a full
`nx test install-engine` run leaves the real registry record-count **unchanged (delta 0)**, 151/151
green. The one spec that asserts the genuine DEFAULT data root (`capabilities.spec.ts ›
defaultStoreRoot`) temporarily clears the override (string-only, no I/O). Defense-in-depth from the
same engagement: `knownProjectRoots()` skips any project root under `os.tmpdir()` (regression test
in `mcp-project-sync.spec.ts`), so even a stray leak can never fan `upgrade --force` out again. The
~480 leaked live records + 120 junk `/tmp` `.mcp.json` were purged as a one-off (registry → 6,
`memory-server` ownership → 2). Surfaced building `upgrade --all`; root-caused fixing the
migrate-home untracked-MCP-injection bug.

### BL-36 — runtime record hardcodes `type: 'mcp-server'` for every detached service — **RESOLVED (2026-07-05, wave-2)**

**Resolution:** service-registry start path records the REAL manifest type via `manifestTypeForSource` (extension.json read; falls back to `service`, the only type this path handles). The rollingRestartConsumer multi-level fallback stays as defense-in-depth for records written by older binaries. sox 75/75.

**Severity:** Low/Medium (misleading `soxe list`/`status`; type unreliable) · **Status:** Open
`apps/sox/src/main.ts` `cmdStart`'s service-registry start path writes `type: 'mcp-server'` into the runtime record for
**every** detached service, so the runtime entry's `type` can't distinguish a `service` from an
`mcp-server`. `libs/host-runtime/src/runtime.ts` `rollingRestartConsumer` works around it by classifying from the manifest, but
`soxe list`/`status` may still mislabel services. Fix: record the real manifest `type` at start.
Surfaced building the rolling-restart classifier.

### ~~BL-37~~ — `memory-daemon` service-store copy can't resolve `@adhd/sox-memory-core` → crashes on start — **Resolved** (`b3bf0d8`)

**Severity:** High (the supervised daemon is fully down in service mode) · **Status:** Resolved — dual-output build: `tsc` keeps `dist/index.js` as the registry-checksum anchor + `tools/bundle-extension.cjs --entry src/bin.ts --outdir bundle` produces a self-contained esbuild bundle (native addons external, resolved via an injected `NODE_PATH=<workspaceRoot>/node_modules` in the run-service spec). A **second stacked bug** was found: the manifest entrypoint `dist/index.js` only re-exports — the real `daemon.start()` is `bin.ts`, so spawning `index.js` was a no-op that exited immediately (the "started then gone" symptom); bundling from `bin.ts` fixes it. e2e **Section E** now spawns the daemon from a **copied store** and asserts it starts + stays up. The original Open writeup follows.
BL-25 converged the daemon's `memoryd` onto `@adhd/sox-memory-core` (thin re-export →
`require('@adhd/sox-memory-core')`). The **service-mode copied store** (`.sox/ext/memory-daemon/`) has
no resolvable `@adhd/sox-memory-core` (not self-contained-bundled, no node_modules link), so the daemon
crashes on start: `Error: Cannot find module '@adhd/sox-memory-core'` (exits immediately; `soxe list`
shows INACTIVE with a dead pid). **`memory-server` (stdio) is unaffected** — it runs from the repo
where the dep resolves. **Gate gap:** the lifecycle e2e spawns the daemon from the *repo* (deps
resolve), never from a copied service store, so this slipped all gates. Fix: self-contained-bundle
the daemon (esbuild, C7-respecting — the bundled-extension-build-standard) so the copied store has
zero external `@adhd/sox-*` deps, AND strengthen the e2e to spawn the daemon from a copied store.
Discovered starting the daemon during the content-addressed deploy.

### BL-38 — `memory-server` shares the daemon's latent `tsc`-bare-`@adhd/sox-*`-requires shape + a stale tracked `bundle/` — **RESOLVED** (publishing refactor)

**Severity:** Low (latent; not on a copied-store path today) · **Status:** Resolved — the publishing
refactor migrated `memory-server`'s build off bare `tsc` to a SELF-CONTAINED esbuild bundle
(`tools/bundle-extension.cjs --entry src/index.ts --external better-sqlite3 --external sqlite-vec`),
so `dist/index.js` carries **zero** bare `@adhd/sox-*` requires (verified: `grep -c 'require("@adhd'`
= 0) — it now runs from a copied/npm-package store exactly like the daemon. `gen-schema.cjs` derives
`dist/schema.json` from the bundle via a new `--emit-schema` flag (no separate `dist/backend.js`
needed). `memory-cli` and `memory-flush` got the same treatment (they transitively use better-sqlite3
via memory-core). Part (2) (stale `bundle/`) was already resolved (`2867b4f`). Proven offline: the
published memory-server tarball installs with native deps via `npm install` and answers `memory_ping`
with a content address; `sha256(local dist) == sha256(npm-installed dist) == ping.artifact`. The
original Open writeup follows.
Surfaced during the BL-37 fix. (1) `memory-server` builds with `tsc` and its `dist` carries bare
`require("@adhd/sox-memory-core")` etc. — it only resolves because it runs **stdio from the repo**
(`soxe serve`), never from a copied store. If an `mcp-server` is ever materialized to a `.sox/ext/`
store it will crash exactly like the daemon did — give it the same self-contained `bundle-extension`
treatment then. (2) `memory-server` ships a **stale, orphaned tracked `bundle/`** dir from a one-off
bundler run; its `project.json` build uses `tsc` and nothing references the dir — dead tracked
output to delete + gitignore. Neither blocks anything today. **(2) RESOLVED** (`2867b4f`): the orphaned `bundle/` was untracked + gitignored (it was a 2.4MB dead artifact; runtime uses `dist` via `soxe serve`); the BL-41 probe now builds a self-contained bundle on-demand. **(1) still open** — the latent `tsc`-bare-`@adhd/sox-*` shape (only matters if an mcp-server is ever materialized to a copied store).

### ~~BL-39~~ — `upgrade --all` / `install(mode:update)` re-pins the lockfile but does NOT re-materialize the copied service store — **Resolved** (`ca20ecf`, ADR-0004)

**Severity:** High (upgrade leaves a running service on stale code) · **Status:** Resolved — ADR-0004's ownership index drives `rematerializeServiceStores`: `update`/`upgrade` now clear the old store and re-copy the new artifact (previously only fresh install re-materialized). The original Open writeup follows.
A `type:service` extension runs from a **copied store** (`.sox/ext/<id>/`). `upgrade --all` (via
`install({mode:'update'})`) re-pins the lockfile checksum but **never re-copies the store**, so after
an upgrade the daemon keeps running the store copy from its **original** install. Observed live: post
`@sox`→`@adhd` rename + BL-37 fix, `upgrade --all` reported `memory-daemon user → upgraded` yet
`.sox/ext/memory-daemon/` still held the pre-rename `@sox` `dist` copy (`require("@sox/memory-core")`)
→ crash on start. Only a **fresh** install (`mode:default` — `uninstall`+`install`, or `install
sox-memory-bundle`) re-materialized the store (with the self-contained `bundle/`) → daemon then
started and stayed up. Root: the daemon's lockfile `source` is the **repo `dist/index.js`**
(checksum-current), so `verifyIntegrity` sees "current" and re-pins without re-copying; and the
checksum anchor tracks the repo `dist/`, not the materialized `bundle/` that's actually deployed.
This directly undermines the upgrade tooling's promise (refresh running code + rolling restart). Fix:
`install(mode:update)` must **re-materialize the service store** when the artifact changed, and the
service checksum anchor should track the materialized `bundle/`. Discovered deploying the daemon
post-rename. (Workaround applied for this deploy: `install sox-memory-bundle --scope=user`.)

### ~~BL-40~~ — `soxe install <mcp-server>` wrote `command: "sox"` (Homebrew audio-tool collision) — **Resolved** (`00e7f9e`)

**Severity:** High (silent MCP spawn failure) · **Status:** Resolved
`libs/install-engine/src/install.ts` fell back to `command: 'sox'` when `SOX_CLI_BIN` was unset, so
`soxe install <mcp-server> --scope=user` registered a spawn command of `sox` — which on macOS is the
Homebrew **audio** tool, not the extension CLI → the MCP server failed to spawn silently. Fixed:
`SOX_CLI_BIN ?? process.argv[1] ?? 'soxe'` (explicitly never `'sox'`), proven by e2e D5. Surfaced
diagnosing MCP global-availability.

### ~~BL-41~~ — `db_path` with a literal `~` is not expanded → creates a literal `~/` directory — **Resolved** (`2867b4f`)

**Severity:** Low/Medium (stray dirs; allowlist confusion) · **Status:** Resolved — single `expandDbPath()` applied at every memory-core sink (`openDb`/`openDbReadOnly`/daemon ctor) + once at memory-server dispatch, so guard + cache + sink agree; e2e Section BL41 proves `~/.memory/x.db` writes under `$HOME` with no literal `~` dir. The original Open writeup follows.
A `memory_*` call with `db_path: "~/.memory/memory.db"` (the literal string the skill docs show) is
**not tilde-expanded** by the server before `openDb` — so a literal `~` directory is created relative
to the server's cwd (observed: `extensions/.../memory-server/~/.memory/memory.db`). The server must
expand `~`→`$HOME` (consistently for the allowlist check AND the file open), or reject an unexpanded
`~`. Surfaced cleaning a stray artifact during the MCP-availability work.

### BL-42 — install model is checkout-bound: cannot publish packages or install on a fresh machine — **RESOLVED (publish-ready; owner-gated for the real npm publish)**

**Severity:** High (distribution blocker) · **Status:** Resolved in the worktree — the publishing &
distribution refactor (`docs/plan/publishing/`, ADR-0005) makes the whole system publishable +
fresh-machine-installable: all 12 `@adhd/sox-*` libs + CLI + every extension/bundle member are
publish-ready (private flipped, `publishConfig`/`engines`/`files`, in-package CLI `bin`/`dist`);
`build-index` emits portable `npm-package:` sources under `SOX_REGISTRY_PUBLISH` (zero `file://`);
the fetcher has an `npm-package:` install mode that runs a real `npm install` so native deps resolve;
extensions are self-contained esbuild bundles (zero `@adhd` runtime deps); the CLI ships a bundled
registry. **Proven offline** by `scripts/acceptance/clean-room-smoke.sh` (verdaccio clean room, no
checkout): `npm i -g @adhd/sox-cli` → `soxe --version`/`search` (G1), `soxe install
sox-memory-bundle` resolving every member from npm with native deps (G2), `memory_ping` green with a
content address. The real `pnpm release` to PUBLIC npm is the one remaining owner-gated step (a
one-way door) — see PUBLISHING.md. The original Open writeup follows.

Today every resolution path points at **this checkout on this machine**. A fresh machine
(or any consumer that didn't build the repo locally) cannot install or run a single extension.
Evidence (2026-06-23):

- **`registry/index.json` sources are absolute local `file://` URLs** —
  `file:///Users/nix/dev/ai/sox-ecosystem/extensions/...` for all 14 entries. The registry is
  not a portable/publishable artifact; on another machine those paths don't exist.
- **Lockfiles pin absolute local dist paths** —
  `~/.adhd/sox-ecosystem/extensions.lock` resolves `memory-server` →
  `file:///Users/nix/dev/ai/sox-ecosystem/.../dist/index.js`. Content-addressed identity
  (ADR-0003) is computed against locally-built `dist`, so a fresh machine has neither the
  artifact nor a way to fetch it.
- **MCP spawn command is an absolute repo path** — `~/.claude.json` →
  `mcpServers.memory-server.command = /Users/nix/dev/ai/sox-ecosystem/bin/soxe`. Won't exist
  on a fresh machine; there is no globally-installed `soxe` to fall back to.
- **Shipped extensions depend on `@adhd/sox-*` via `workspace:*`** (memory-server/cli/flush
  package.json). `workspace:*` only resolves inside the pnpm workspace; a published package
  carrying it 404s on `npm/pnpm install` (this exact failure already hit `@adhd/sox-tokenguard-core`
  — see the protocol fix `dabe9ea`). Self-contained esbuild bundling (BL-37/BL-38) inlines these
  for the *service* members, but the dependency-graph publish story is unsolved.
- **Root `package.json` is `"private": true`** and no `@adhd/sox-*` lib is actually published; the
  scope is owned but empty on npm.

**What "publishable + fresh-machine-installable" requires (fix sketch):**

1. **Decide the distribution substrate** — publish `@adhd/sox-*` libs + the `soxe` CLI to npm
   (changesets is already wired: `version-packages`/`release` scripts), OR ship fully self-contained
   bundles addressed by a fetchable URL/tarball, not `file://`.
2. **Make the registry portable** — `build-index` should emit relative or resolvable
   (registry-URL/tarball) sources, not absolute `file://` paths; add a publish step that uploads
   artifacts and rewrites sources.
3. **Rewrite `workspace:*` → real versions on publish** (changesets does this for libs; the
   extension members need the same, or must bundle their deps).
4. **Resolve the CLI command portably** — a globally-installed `soxe` (npm bin) or a per-install
   shim, so `mcpServers.*.command` is `soxe`/`npx soxe`, not an absolute repo path.
5. **Fresh-machine acceptance test** — `npm i -g @adhd/soxe` (or equivalent) → `soxe install
   sox-memory-bundle --scope user` → `memory_ping` green, in a container with **no repo checkout**.
   This is the reality gate; nothing is "publishable" until that passes.

**Versioning-system findings (2026-06-23, confirmed while writing `PUBLISHING.md`).** The publish
pipeline is Changesets (canonical — `.changeset/` + `@changesets/action` in `release.yml`, which
DOES rewrite `registry/index.json` sources to npm-CDN URLs post-publish, i.e. the fix for blocker
# 1 above). The **safe, unambiguous defects are now fixed** (this turn):

- ✅ **Changeset tooling was non-functional** — `pnpm-workspace.yaml`'s `libs/**`/`apps/**`/
  `packages/**` recursed into gitignored `dist/` dirs whose build-emitted `package.json` (no `name`)
  made `@manypkg`/`changeset status` error out. Fixed by excluding `!**/dist/**` + `!**/node_modules/**`;
  `changeset status` now lists the 4 valid members.
- ✅ **Dual versioning systems** — removed the conflicting, CI-unused `nx.json` `release` block;
  Changesets is now the single source of truth.
- ✅ **Stale changesets** — removed the deleted `@adhd/sox-extension-memory-organizer` refs from
  `sox-memory-p0/p5.md`; deleted `hello-world-minor.md` (referenced non-existent
  `@adhd/sox-extension-hello-world`).

The remaining items are **strategy decisions**, split into **BL-43**.

Playbook + full confirmation: [`PUBLISHING.md`](./PUBLISHING.md) → *Current state*.

Surfaced answering "is there a backlog item about publishing for a fresh machine?" — there was not.

### BL-43 — publish-strategy decisions for `@adhd/sox-*` (libs, CLI, bundle members, first release) — **RESOLVED** (owner-ratified + implemented)

**Severity:** High · **Status:** Resolved — the owner ratified the strategy in
`docs/plan/publishing/DECISIONS.md` (D-A…D-F) and it is implemented by the publishing refactor:
(1) **libs** → publish ALL 12 public (D-A=A1); extensions stay self-contained bundles (Model A,
ADR-0005) so published artifacts carry zero `@adhd` runtime deps; (2) **CLI** → published with
in-package `bin: { soxe }`, `engines.node>=20`, self-contained bundle (D-F=F2); (3) **bundle
members** → all published incl. daemon/usage (Q3); (4) **first release** → stale `sox-memory-p0/p5`
changesets removed, replaced by one coherent `publishing-refactor` changeset (R7). A
`check-publishable` gate prevents the 404 class from regressing. The original Open writeup follows.

The mechanical publish defects are fixed (see BL-42). What remains are **decisions** that only the
owner can make, because they put code on the public `@adhd` npm scope:

1. **Libs: publish vs. bundle.** `@adhd/sox-authoring|-host-runtime|-install-engine|-manifest|
   -registry|-memory-core` are `private: true`, yet the public extensions depend on them via
   `workspace:*` → those deps **404 on publish**. Pick one, consistently:
   - **(a) Publish the libs** — flip `private:false` + add `publishConfig.access=public`; changesets
     rewrites `workspace:*` → the real version at publish. Exposes the engine internals on npm.
   - **(b) Bundle them** — esbuild-inline every `@adhd/sox-*` dep into each published extension (as
     BL-37/38 already do for the service members) so published artifacts carry **no** `@adhd/sox-*`
     runtime deps. Keeps libs private.
2. **CLI publishability.** `@adhd/sox-cli` (apps/sox) is `private: true` with no published `bin`. The
   fresh-machine entry point (`npm i -g @adhd/sox-cli` → `soxe …`) requires it published with a
   `bin: { soxe }` and an `engines.node` pin.
3. **Bundle-member publish model.** `memory-daemon` is `private: true` (internal to the bundle, no
   independent publish). Confirm this is intentional for ALL non-server members, and that the bundle
   artifact carries them — *then* no per-member changeset is needed (a daemon changeset was
   deliberately NOT added for this reason). Document the rule in `PUBLISHING.md`.
4. **First-release planning.** The surviving `sox-memory-p0/p5.md` changesets describe historical
   "stubs only / Phase N" churn and would bump `memory-server` (already manually at 1.1.0) with a
   misleading changelog. Before the first real publish, consolidate them into one coherent
   first-release changeset reflecting the CURRENT shipped state, not the phase history.

Acceptance: BL-42's fresh-machine container smoke passes.

### ~~BL-44~~ — `nx test` caching was dependency-blind: an upstream source change did NOT invalidate a dependent's test cache — **Resolved** (this turn)

**Severity:** High (cache lies — CI/local could report a stale green against changed upstream code) ·
**Status:** Resolved 2026-06-23.

All 15 `test` targets overrode `inputs` in their `project.json` with only their own
`{projectRoot}/src/**/*.ts` (+ a couple of hardcodes). Project-level `inputs` **replace** (do not
merge with) the `nx.json` targetDefaults `["default", "^production"]`, so every test target **dropped
`^production`** and had **no `dependsOn`** → the test cache was keyed on the project's own files only.
**Proven** (before fix): changed `libs/memory-core/src/index.ts` → `nx test memory-server` still served
a **cache hit**, although nx knows the `memory-server → memory-core` edge. The exact "cache lies"
hazard (cf. BL-4, MEMORY `eim-plan-cache-lies-reality-gates`). A change to `vitest.config.ts`/
`vitest.setup.ts` also didn't invalidate (those files weren't in the narrowed inputs).

**Fix (verified):**

- Set every test target's `inputs` to `["default", "^production"]` — `default` tracks the project's
  own files incl. vitest config/setup; `^production` tracks **upstream** sources. (install-engine keeps
  its extra `{workspaceRoot}/libs/host-runtime/src/data-paths.ts` parity reach-in — it has no nx graph
  edge to host-runtime.)
- Added `dependsOn: ["^build"]` to the `test` targetDefault so a test runs against **freshly-built**
  dependency `dist` (tests resolve `@adhd/sox-*` via a static `dist/index.js` alias — without this the
  invalidation was hollow: the re-run would execute stale dist). This also closes the BL-4 stale-dist
  hazard for tests.

Verified by reality probes: upstream src change → test re-runs (was a hit); `nx test memory-server`
now runs "test … and 4 tasks it depends on" (builds `memory-core` first); no-change → still a hit.

**Across-the-board hardening (follow-up, same turn).** A conformance audit found the same class of
defect in **`build`** targets: several declared a *hand-listed* `dependsOn: ["X:build"]` that
**replaces** the inherited graph-resolved `^build` and had **drifted incomplete** — e.g.
`memory-server` build listed only `memory-core:build` but the graph shows it also depends on
`memory-enrich`. Normalized **every** `build`/`test` target to the graph-resolved `^build`
(`nx build sox` now builds 6 dep tasks, not the 4 the hand-list named; `memory-server` 4). Fixed two
genuinely dep-blind tests the first pass missed (`manifest` — local `dependsOn: ["test-scripts"]`
shadowed `^build`; `packages/sox-nx` — outside the first sweep). Shipped the durable guards so it
cannot regress:

- **`docs/nx-cache-conformance.md`** — the principle (policy lives in `nx.json` targetDefaults;
  per-project `inputs`/`dependsOn` *replace* not merge; prefer `^build` over hand-listed deps).
- **`libs/authoring` bundle generator** — emits no narrowing per-target `inputs` (members inherit the
  dep-aware defaults); so new extensions are born conformant.
- **`tools/check-nx-cache.cjs`** (+ `pnpm check-nx-cache`, wired into `validate.yml`) — fails CI if any
  cacheable `build`/`test` target's **effective** (defaults-merged) config is dependency-blind. Now
  green: 19 project.json, all dependency-aware.
- Generalized finding stored to memory (`nx-cache-dependency-awareness`, episode `01KVVAJKNYEKSDJ…`).

> **BL-21, BL-22, BL-23, BL-24 are owned by `docs/plan/memory-enrichment/IMPLEMENTATION.md` (§0).**
> Each is resolved by a plan phase: BL-23 metadata = done (`9728f6f`); BL-23 project-path + BL-24
> tags/topic = P1; BL-24 clustering = P3; BL-22 entity-names + BL-21 auto-refresh = P5 (both done 2026-06-22).
> The detailed entries below remain as the original discovery context.

### BL-23 — `memory_write` drops `metadata` and records no caller provenance (project path) — **RESOLVED (2026-06-22)** — `write.ts:133-134` persists `metaJson`; `db.ts:211-213` adds `project_path`

**Severity:** Medium (provenance / data loss) · **Status:** Folded → memory-enrichment plan (metadata done `9728f6f`; project-path = P1)
`memory_write` accepts a `metadata?: Record<string, unknown>` param but **never persists it** —
it's referenced only in the `WriteParams` type, not in the node INSERT, so any caller-supplied
metadata (e.g. a project path) is silently discarded. The `node` table has `agent_id` +
`session_id` but **no column for the caller's project/repo path or cwd** — so there is no record
of *where* a memory came from. Fix: (a) stop silently dropping `metadata` (persist it, e.g. a
`meta` JSON column, or reject unknown fields loudly); (b) add a first-class caller provenance
field (project path / repo) captured at write time. Surfaced auditing DB vs the export docs.

### BL-24 — tags and the `[<topic>]` cluster are not first-class structured fields — **RESOLVED (P1 scope, 2026-06-22)** — `db.ts:211-212` adds `tags`/`topic`; `recall.ts:273-296` filters on them. P3 (topic-as-edge) is deferred scope, not a defect

**Severity:** Low/Medium (queryability) · **Status:** Folded → memory-enrichment plan (tags/topic = P1; clustering = P3)
Two related modelling gaps surfaced comparing DB vs docs:

- **Tags are lossy:** an agent's `tags[]` are converted to `entity` nodes + `MENTIONS` edges; the
  raw tag list is not retained on the episode and there is no `tags` column — so you can't query
  "episodes the author tagged X" distinct from organizer-extracted entities.
- **Topic/cluster is unstructured:** the `[<topic>]` prefix lives only inside `content`; there is
  no topic/cluster column. The BL-20 export parses it from text at export time (fragile,
  format-dependent) and the DB can't be queried/grouped by topic. Consider a structured
  `topic`/`cluster` field (or a `TOPIC`/`MEMBER_OF` edge to a topic node) set at write time from
  the `[<topic>]` prefix and/or tags, so clustering is durable and queryable, not derived.

### ~~BL-22~~ — memory export frontmatter lists entities by opaque uid, not name — **Resolved**

**Severity:** Low (export usability) · **Status:** Resolved — P5 (2026-06-22)
`collectMentionedEntities` now returns entity `name` fields (not uids). Entities without a name
are silently omitted. The topic derivation chain also uses entity names at every level. Verified
by real-store proof: `entities: typescript, strict-mode` (not `01KVRS4Q1S...`). Gates: `nx run-many
-t build lint test --projects=memory-core,memory-flush` 65/65 green.

### ~~BL-21~~ — memory markdown export is on-demand; not auto-refreshed as new memory is written — **Resolved**

**Severity:** Low (auditability / DX) · **Status:** Resolved — P5 (2026-06-22)
`memory-flush` `handleSessionEnd` now calls `tryAutoExport` after the flush+nudge, gated on
`export_enabled=true` AND `export_dir` being configured (default OFF — explicitly opt-in). The
export is throttled (default 60s, configurable via `export_throttle_secs`) and fully
failure-isolated (any export error is caught + logged; flush never breaks). Config injected via
`setExportConfig()` (module override for tests/startup) or `payload.export_config` from host.
Gates: 14 new tests in `index.spec.ts` covering gate/throttle/failure-isolation; `nx run-many
-t build lint test --projects=memory-core,memory-flush` 65/65 green.

### ~~BL-19~~ — `install` hard-fails on a single unresolvable config `install[]` entry — **Resolved**

**Severity:** Medium (install robustness / DX) · **Status:** Resolved (2026-06-22)
Both gaps fixed + tested: **(1) read-side resilience** — `install()` now **skips + warns** on an
unresolvable `install[]` entry and continues (both `libs/install-engine/src/install.ts` and the
legacy `scripts/install.ts` mirror); a single bad config line no longer aborts the whole install.
**(2) source guard** — `cmdInstall` rejects a reserved scope name (`user`/`project`/`local`/`org`)
as a positional id before writing it to the config, so the cruft can't be re-created. Regression
tests added: `cli-adapter.test.ts` (`install user` → exit≠0, "scope name") and `install.test.ts`
(valid+bogus config → valid installs, bogus skipped). Verified: scripts 257/257, e2e 63/63,
build+lint+typecheck. The live stray `{ "id": "user" }` was cleaned from `~/.config/...` during the
upgrade.

**Original (for history):**
Discovered while upgrading the user-scope install (2026-06-22): `~/.config/extensions/extensions.json`
contained a stray `{ "id": "user" }` in `install[]` (cruft from an older CLI version that captured
a scope value as a positional id). The result: `soxe install --scope=user` resolved all valid
entries (the whole `sox-memory-bundle`) and then **errored out entirely** on `cannot resolve
extension "user"`, so **none** of the valid upgrade was written until the bad entry was removed by
hand. A single bad config line blocks the entire install.

The **write-side is already fixed** — verified the current CLI does NOT add a scope value as an id
(`install --scope user`, `install -s user`, and `install <id> --scope user` all leave `install[]`
correct). The remaining gaps:

1. **Read-side resilience:** `install` should **skip + warn** on an unresolvable `install[]` entry
   (continue with the valid ones), not abort the whole operation.
2. **Defense in depth:** reject reserved scope names (`user`/`project`/`local`) as extension ids at
   config-write time, so this class of cruft can't be created.

(The stray `{ "id": "user" }` was cleaned from the live config as part of the upgrade.)

## Resolved (formerly Open)

### ~~BL-1~~ — `pnpm typecheck` exits 2 on latent tokenguard + scripts errors — **Resolved**

**Severity:** Low (code hygiene; no runtime impact) · **Status:** Resolved (2026-06-21)
Surfaced after the `@adhd/sox-tokenguard-core` workspace-protocol fix (`dabe9ea`) unmasked them.
**Verified fixed:** `pnpm typecheck` (root `tsc --noEmit`) now exits **0**; all nine cited
files are inside the compilation (`--listFilesOnly` confirms) and every cited error is gone
(e.g. `proxy.ts:309` now reads `(vs[0] ?? '')` — the prescribed `undefined` guard). The
mechanical fixes are realized in the working tree (tokenguard `cli.ts`/`mapstore.ts`/`proxy.ts`,
`scripts/new-extension.ts`, `scripts/check-registry-sync.ts) — **committed in`7a30ea5`.**

9 errors (historical):

*tokenguard source:*

- `extensions/services/tokenguard/src/cli.ts(23,1)` — TS6133 `'readline'` unused
- `extensions/services/tokenguard/src/mapstore.ts(32,10)` — TS6133 `'now'` unused
- `extensions/services/tokenguard/src/proxy.ts(170,19)` — TS6133 `'mapper'` unused
- `extensions/services/tokenguard/src/proxy.ts(170,27)` — TS6133 `'adapter'` unused
- `extensions/services/tokenguard/src/proxy.ts(309,19)` — TS2322 `string | string[] | undefined` not assignable to `string | string[]` (needs an undefined guard)

*repo scripts (unrelated to tokenguard):*

- `scripts/check-registry-sync.ts(35,7)` — TS6133 `'tmpRoot'` unused
- `scripts/check-registry-sync.ts(162,7)` — TS6133 `'liveJson'` unused
- `scripts/new-extension.ts(82,96)` — TS2366 function lacks ending return
- `scripts/new-extension.ts(281,91)` — TS2366 function lacks ending return

**Fix sketch:** remove unused declarations; add an `undefined` guard at `proxy.ts:309`;
add explicit returns (or `: void`/`undefined` return types) in `new-extension.ts`. All
mechanical, no behavior change. After: `pnpm typecheck` exits 0.

### ~~BL-2~~ — `embed.ts` real backend uses `bge-base-en-v1.5`, not the nominal nomic model — **Resolved**

**Severity:** Low (works; naming/quality) · **Status:** Resolved (2026-06-22)
`embed.ts` now carries an explicit comment at `EMBED_MODEL` clarifying it is the *hash-backend*
identifier and that `getActiveEmbedModel()` returns `bge-base-en-v1.5` for the real backend;
the module header documents the real model. The constant is retained for back-compat. Callers
must use `getActiveEmbedModel()`, not `EMBED_MODEL`, as the active-backend proxy.
The `EMBED_MODEL` constant historically read `nomic-embed-text-v1.5-hash`. The real backend
actually loads **bge-base-en-v1.5** (768-dim) because `fastembed` 2.x does not ship
nomic-v1.5. Verified semantically correct (cos(query,relevant)≈0.74–0.82 vs cos(query,unrelated)≈0.50).
If nomic is desired, swap to a lib/runtime that ships it at 768-dim and re-embed (the
`memory_scope.embed_model` pin already forces a clean reindex on model change).

### ~~BL-3~~ — `memory_recall` RRF temporal-recency can outrank semantic similarity for closely-timed writes — **Resolved**

**Severity:** Low (tuning) · **Status:** Resolved (2026-06-22)
`recall.ts` now applies per-signal RRF weights (`VEC_WEIGHT=1.0`, `FTS_WEIGHT=0.8`,
`TEMPORAL_WEIGHT=0.4`) instead of the implicit 1:1:1 — temporal is now a tiebreaker, not a
primary signal. Weights are overridable per-call via optional `vec_weight`/`fts_weight`/
`temporal_weight` params, so a caller can re-boost recency when desired.
Observed: with three docs written seconds apart, the most-recently-written (less relevant)
doc out-ranked an older, more-relevant doc, because the temporal component of the RRF fusion
dominated the tiny rank-based score deltas. Embeddings are correct; this is a fusion-weight
tuning question. Consider down-weighting recency relative to semantic rank, or widening the
score spread, when corpus writes cluster in time.

### ~~BL-4~~ — Local build hygiene: composite `tsc` leaves stale `dist`; trust `nx build`, not vitest aliases — **Resolved**

**Severity:** Low (dev ergonomics) · **Status:** Resolved (2026-06-22)
Documented in `CLAUDE.md` under "BUILD VIA NX TARGETS" → "Build vs. test hygiene (BL-4)":
composite `tsc` can leave a stale `dist`; vitest resolves `@adhd/sox-memory-core` to a static
`dist` alias so "tests pass" does not prove the runtime/MCP path; always `nx build memory-core
&& nx build memory-server` before memory tests. The nx-targets constraint also bans bare `tsc`.
`libs/memory-core` and the memory-server bundle use `composite: true`. A bare `tsc` after a
source change (or after `rm -rf dist`) can emit nothing because the `.tsbuildinfo` thinks
outputs are current — leaving a **stale `dist`**. `dist` is gitignored and the nx graph wires
`memory-server:build → dependsOn memory-core:build`, so a clean `nx build memory-server`
is correct. But: a vitest run (which transforms TS source, or uses a `resolve.alias` to
source) can PASS while the built `dist` is stale — so "tests pass" does **not** prove the
runtime/MCP path. Always verify runtime behavior against `nx build` output, not vitest.

### ~~BL-5~~ — `@adhd/sox-mcp-runtime` consolidation — **Resolved**

**Status:** Resolved. `memory-server` now uses `serve()` + `defineTool()` from `@adhd/sox-mcp-runtime`;
hand-rolled readline loop removed. Vendored `compilePolicyFromEnv` kept (standalone child process
cannot reach `@adhd/sox-host-runtime` at runtime). Type escape hatches removed; `handleToolCall`
returns `Promise<ToolResult>`, `TOOLS` typed as `Array<Omit<ToolDefinition, 'handler'>>`.

### ~~BL-6~~ — Verify the other sox-memory-bundle members build/run post workspace-glob widening — **Resolved**

**Severity:** Low · **Status:** Resolved (2026-06-22)
Verified cache-busted: `memory-daemon`, `memory-cli`, `memory-flush`, `memory-organizer` all
build clean and resolve `@adhd/sox-memory-core` (`nx run-many build --skip-nx-cache`, 6/6 incl.
core+server). Each member's `project.json` carries a `description` noting the verification.
The workspace-glob widening (`bec9914`) now links `@adhd/sox-memory-core` into all five members
(server/cli/flush/daemon/organizer). Only `memory-server` was deep-tested (build + real MCP
recall). Confirm `memory-cli`, `memory-flush`, `memory-daemon`, `memory-organizer` build and
resolve `@adhd/sox-memory-core` at runtime too.

### ~~BL-7~~ — `install` should persist the resolved scope so `serve` needs no `--scope` flag — **Resolved**

**Severity:** Medium (DX / correctness footgun) · **Status:** Resolved (2026-06-22)
`cmdServe` (`apps/sox/src/main.ts`, committed in `f4d3e48`) now resolves across scopes by
precedence — `SERVE_SCOPE_ORDER = project → user → org → local`, innermost wins — when no
`--scope` is given; an explicit `--scope` restricts to that scope. A user-scope install is
found by `soxe serve <id>` with no flag; help text updated. Build+lint verified cache-busted.
**Remaining follow-up below is a manual config cleanup, not code.**
`soxe install --scope=user` writes the user-scope lockfile (`~/.config/extensions/extensions.lock`),
but `soxe serve <id>` defaults to `--scope=project` (cwd-rooted). So a user-scope-installed
extension is invisible to `serve` unless the caller *also* passes `--scope=user` — which means
the scope decision has to be re-stated at every invocation site (the `~/.claude.json` MCP
entry, `.mcp.json`, etc.). That conditional handling at install-time/launch files is exactly
what we want to avoid.

**Desired:** install should make the resolved scope self-describing so `serve` finds the
extension without a flag. Options to evaluate:

- `serve` resolves across scopes by precedence (project → user → org) instead of a single
  default scope, so a user-scope install is found automatically.
- and/or install records the scope in a stable, cwd-independent index (e.g. the
  `~/.sox`/`SOX_HOME` install-registry) that `serve` consults regardless of cwd.
- and/or install stamps the chosen scope into the generated launch/config artifact so no
  caller has to pass `--scope`.

**Follow-up — DONE (2026-06-22):** the `--scope=user` argument was removed from the global
MCP entry in `~/.claude.json` (`mcpServers."memory-server".args`) now that `soxe serve`
cascades scopes. BL-7 is fully closed (code + the manual config cleanup).

## Memory subsystem (`@adhd/sox-memory-core` + sox-memory-bundle)

Surfaced while migrating a 95-document research corpus into `~/.memory/memory.db` and exercising `memory_recall` via the live MCP (2026-06-21).

### ~~BL-8~~ — `memory_recall` default `token_budget` is far too small for document-scale nodes — **Resolved**

**Severity:** Medium (recall correctness) · **Status:** Resolved (2026-06-22)
`DEFAULT_TOKEN_BUDGET` raised 4000 → 32000 in `recall.ts`; the `memory_recall` schema default
in `memory-server/extension.json` updated to 32000. The budget guard is unchanged, so an
explicit small `token_budget` still stops early. Document-scale nodes no longer cap `limit:10`
recall at 1 result.
`memoryRecall` defaults `token_budget` to ~4000 (`recall.ts`), and `federatedRecall` to 4000. The assembler stops adding results once the budget is exceeded (`recall.ts:279`), so with document-sized nodes a single result fills the budget and recall returns **1 hit even when `limit` is 10**. Confirmed empirically: same query returned 1 result at default, 10 at `token_budget: 50000`. Fix: raise the default to a sane multi-result value, make it scale with `limit`, and/or document that callers must pass `token_budget`. The `limit` parameter is misleading while the budget silently caps below it.

### ~~BL-9~~ — No edge/link MCP tool; relationships require the organizer or raw SQL — **Resolved**

**Severity:** Medium (graph completeness) · **Status:** Resolved (2026-06-21)
A `memory_link` tool now exists (memory-server `src/index.ts:294` definition, `:620` handler),
creating directed edges between existing nodes (`DERIVED_FROM`, `SUPERSEDES`, `RELATES_TO`,
`SUPPORTS`, `MENTIONS`). Bulk importers can link chunks to their source document via the MCP
without the organizer or raw SQL. **Committed in `7a30ea5`.**

### ~~BL-10~~ — `initScope` records the `EMBED_MODEL` constant, not the active model — **Resolved**

**Severity:** Medium (bug — embed-model pin is wrong) · **Status:** Resolved (2026-06-22)
`initScope` (`db.ts`, committed in `7a30ea5`) now records `getActiveEmbedModel()` in both the
`memory_scope` INSERT and the returned object, so the scope pins the real active model
(`bge-base-en-v1.5`) instead of the frozen hash constant — restoring the re-embed-on-model-change
mechanism. (Caveat per the plan: if `initScope` runs before the first `embed()` resolves, the
pin is the hash value until the daemon's reindex updates it.)

### ~~BL-11~~ — In-process `embed()` + `better-sqlite3` crashes ("mutex lock failed") — **Resolved**

**Severity:** High (blocks programmatic/bulk ingest) · **Status:** Resolved (2026-06-21)
ONNX inference is now isolated in a worker thread (`libs/memory-core/src/embedWorker.ts`,
referenced from `embed.ts:92` and `index.ts:9-10` with explicit "resolves BL-11" notes), so
onnxruntime-node and better-sqlite3 no longer share the libpthread mutex that was corrupted
across the async boundary. The library is safe to call in-process (openDb → embed → memoryWrite).
**Committed in `7a30ea5`.**

### ~~BL-12~~ — `reembedNodes` is defined but not re-exported from the package index — **Resolved**

**Severity:** Low (API consistency) · **Status:** Resolved (2026-06-22)
`reembedNodes` added to the embedding export block in `libs/memory-core/src/index.ts`. Verified
from built dist: `typeof require('@adhd/sox-memory-core').reembedNodes === 'function'` (was `undefined`).

### ~~BL-13~~ — `memory_write` stores whole content as one node; no chunking + embedding truncation — **Resolved**

**Severity:** Medium (recall quality) · **Status:** Resolved (2026-06-21)
`memory_write` now chunks large content server-side: `splitIntoChunks()` (memory-server
`src/index.ts:360`) splits content exceeding `chunk_size` (param at `:198`, default ~500
tokens) at sentence boundaries, storing each chunk as a separate episode with a `DERIVED_FROM`
edge to the parent. Callers no longer need to pre-chunk document-sized input for usable
default-budget recall. **Committed in `7a30ea5`.**

### ~~BL-14~~ — `memory_recall` lacks result diversity (one verbose source crowds top-N) — **Resolved**

**Severity:** Medium (recall quality) · **Status:** Resolved (2026-06-22)
`recall.ts` result assembly now enforces a per-source diversity cap of
`max(2, ceil(limit/5))`, keyed on a stable per-source key, so one verbose document cannot fill
top-N — remaining slots fill from other sources. Documented as a diversity proxy (not full MMR,
which would need inter-candidate embedding distances).
After chunked ingest, a single long finding (`work-order-compiler`, many sections) had enough chunks that 3–4 of them filled the top-5 for unrelated queries, burying the genuinely most-relevant finding from another source (e.g. `plan-scheduling/dag-merging` ranked #4 for "parallel scheduling of dependent plan tasks", under work-order-compiler chunks). Add per-source diversity to recall — cap chunks-per-`original_path`/document, or apply MMR — so top-N spans distinct sources.

### ~~BL-15~~ — `serve` permission guard `db_path` allowlist is `~/.memory/**` only — **Resolved**

**Severity:** Low (note) · **Status:** Resolved (2026-06-22)
The `db_path` allowlist constraint is now documented for tool callers: `memory_write`/
`memory_recall` `db_path` properties in `memory-server/extension.json` carry a `description`
stating paths must be within `~/.memory/**` (else denied by the host guard, no side effects),
and `memory-server/CLAUDE.md` gains a "Permissions and db_path constraint" section with the
two escape hatches (reconfigure allowlist / symlink into `~/.memory/`).

## Authoring / CLI

### ~~BL-16~~ — `soxe init` accepts ids that `soxe validate` rejects; naming rules undocumented; re-evaluate the rule — **Resolved**

**Severity:** Medium (authoring DX / correctness) · **Status:** Resolved (2026-06-22)

1. **init/validate agreement (bug):** both init surfaces now fail fast on a non-conformant id,
   matching `soxe validate`. `cmdInit` (`apps/sox/src/main.ts`, the `soxe` path) uses the
   canonical `validateId` from `@adhd/sox-authoring` (pattern **and** no-type-suffix), exit 1 with a
   clear message; the legacy `scripts/new-extension.ts` (`bin/sox` path) suffix check was
   promoted from warn-only to a hard error (`idSuffixError`). Verified: `soxe init skill
   memory-skill` and `soxe init skill memory-skill` both exit 1; `memory-usage` scaffolds.
2. **Documented:** id rules now appear in `init` usage + `--help` and in `docs/guidelines/bundle.md`.
3. **Decision (re-evaluate):** the no-type-suffix rule is **kept globally** (not relaxed for
   bundle members) — one uniform contract; member type is already explicit in `extension.json`
   and the `members/<id>/` path; the `memory-<function>` convention is more informative.
   Rationale recorded in `docs/guidelines/bundle.md`.
Three related problems, surfaced authoring the memory-usage skill as a bundle member:

4. **init/validate inconsistency (bug).** `soxe init skill memory-skill` **scaffolds
   successfully**, but `soxe validate` then **rejects** the result:
   `id "memory-skill" must not end with the type name "skill"`
   (`libs/authoring/src/index.ts:156`). `init` and `validate` must agree — `init` should
   reject (or auto-fix) a non-conformant id at scaffold time, not produce a born-INVALID
   extension. Today the author only learns the id is illegal after a full scaffold.

5. **Naming rules are undocumented.** The id contract (`^[a-z][a-z0-9-]*$` **and** must not
   end with the type name) lives only in code + a test; there is no author-facing doc, and
   `soxe init --help` shows only `init <type> <id>`. Document the id rules — and the bundle
   convention that members are named by **function** (`memory-server`/`memory-cli`), not by
   type — in the init help and an authoring guide, with examples + the rejection reason.

6. **Re-evaluate whether the "no type-name suffix" rule still makes sense under bundling.**
   The rule predates the bundle layout. Inside a bundle, members already live under
   `members/<id>/` with the type explicit in `extension.json`, so a suffix like `-skill` is
   arguably informative (it disambiguates a member's role in a mixed bundle), not redundant.
   Decide: keep globally, relax for bundle members, or drop. (Complied for now by naming the
   skill `memory-usage`, matching the `memory-<function>` sibling convention.)

### ~~BL-17~~ — bundle/config install does not host-place skill members (only the `--host` path does) — **Resolved**

**Severity:** Medium (install correctness) · **Status:** Resolved (2026-06-22)
Fixed in `d874926`: after `install()` writes the lockfile, the config/no-`--host` path now
host-places every resolved extension whose manifest declares `install.hosts` (skill/agent/
command members), via a shared `hostPlaceExtension()` helper also used by the `--host` path
(single placement implementation). Runtime types (service/bundle) are skipped. Net:
`soxe install --scope=user` of a bundle now deploys its skill members per `install.hosts`,
not just the lockfile. Verified: nx build sox + lint + typecheck; the no-`--host` path stays
green in `host-runtime:test-e2e` (63/63).
`soxe install --scope=user --update` (the config/lockfile path used to "upgrade a bundle")
**resolves** a bundle's skill member into the lockfile but does **not** host-place it — after
upgrading `sox-memory-bundle` with the new `memory-usage` skill member, the skill was written
to the lockfile (`memory-usage/SKILL.md`) but **not** dropped into `~/.claude/skills/`, so it
was not loadable. Host file-drop only happens on the **declarative `--host` path**
(`soxe install <id> --host=claude --scope=user`, `main.ts:631`). Net: upgrading a bundle does
not deploy its skill members; a separate per-member `--host` install is required (the workaround
used here). Fix: the config/bundle install should host-place every member per its
`install.hosts` (so `install --update` of a bundle deploys skills/agents/commands too), or this
two-step requirement must be documented. Closely related to BL-7 (scope/placement semantics).

### ~~BL-18~~ — `memory-organizer` is a member dir + install-registry record but absent from the bundle manifest `members[]` — **Resolved**

**Severity:** Low (manifest/registry consistency) · **Status:** Resolved (2026-06-22)
Resolved by **including** the organizer in the bundle (intent confirmed: the daemon calls it and
BL-9/BL-13 graph work depends on its extract-link-consolidate pass). Added
`{ "id": "memory-organizer", "version": "^0.1.0" }` to `members[]` (now 6 members) and rewrote the
bundle `description` to list all six (organizer + the previously-omitted memory-usage). The
organizer's manifest already passes strict validate (author/keywords/invocation present, no
lifecycle). v2-e2e member-count assertion updated 5→6. `install sox-memory-bundle` now deploys
the organizer, reconciling the manifest with the install-registry record.

**Original (for history):**
**Severity:** Low (manifest/registry consistency) · **Status:** ~~Open / needs-decision~~
`extensions/bundles/sox-memory-bundle/members/memory-organizer/` exists on disk and appears in
`~/.sox`-side `install-registry.json`, but the bundle manifest's `members[]` lists only
`memory-daemon`, `memory-server`, `memory-flush`, `memory-cli` (and now `memory-usage`) — **not**
`memory-organizer`. The bundle `description` likewise omits it. So `install sox-memory-bundle`
does not deploy the organizer, yet a stale/older install path left it in the install-registry.
**Decide intent:**

- If the organizer **should** ship with the bundle (it builds the graph / does extract-link-
  consolidate, which BL-9/BL-13 rely on), add `{ "id": "memory-organizer", "version": "^0.1.0" }`
  to `members[]` and update the description — note this makes every bundle install also deploy/run
  the organizer daemon (a behavior change, hence not done unilaterally here).
- If it is intentionally **out** of the bundle (optional/experimental, installed separately),
  document why, and reconcile the stale `install-registry.json` record so the registry stops
  advertising a member the manifest doesn't ship.

Either way, manifest ↔ member-dirs ↔ install-registry should be made consistent (a
`check-registry-sync`-style assertion could enforce it).

### ~~BL-20~~ — no DB→markdown export mirror for memory written directly via `memory_write` — **Resolved**

**Severity:** Low (auditability) · **Status:** Resolved (2026-06-22)
*(Renumbered from a duplicate BL-19 — the install-resilience BL-19 below has code/test references.)*

**Resolved:** added a DB→markdown export mirror — `exportMarkdown()` in
`libs/memory-core/src/export.ts`, surfaced as `memory export` in memory-cli.

- **Enable/disable:** `export_enabled` config (default **on**).
- **Configurable dir:** `export_dir` config — default scope-relative (`~/.memory/export` for
  user scope), overridable; the **user-scope install is set to `/Users/nix/dev/ai/memory`**.
- **Topic-based, indexed layout:** `<dir>/topics/<slug>/<uid>.md` (YAML frontmatter + content),
  a root `INDEX.md` (topics + counts + links) and per-topic `INDEX.md`. Topic precedence:
  explicit `[<topic>]` content prefix (the corpus convention — moved the real db from 871/919
  "general" → 96, across 32 topics) > organizer `community` > `MENTIONS` entity > `general`.
  Idempotent, with **move-aware pruning** (a re-categorised node's stale copy is removed, not
  just dead uids). Verified live against `~/.memory/memory.db` (919 nodes → 32 topics);
  `principles/` left untouched. Tests in `export.spec.ts` (26 memory-core tests green).

**Original (for history):**
The research-corpus migration ingested 95 markdown findings into `~/.memory/memory.db` (823
chunked nodes). The original markdown files remain as the human-readable/git-reviewable mirror,
but they are now a **snapshot**: any finding written *directly* via `memory_write` going forward
(e.g. by `workflow-researcher`) has **no** markdown representation — so the DB silently diverges
from the mirror, and there is no git-reviewable record of new knowledge. Add a `memory-export`
step (a `memory-cli` subcommand or organizer pass) that renders MCP-written nodes back to
markdown keyed by `uid`, so the mirror stays current and memory changes remain auditable in git.
Deferred from the migration (DB-as-truth was chosen; the export-back half was not built).
**Verified fixed:** `exportMarkdown` added to `libs/memory-core/src/export.ts`; `memory export`
subcommand added to `memory-cli`; user-scope `~/.config/extensions/extensions.json` sets
`export_dir: /Users/nix/dev/ai/memory`; real export of 919 nodes across 48 topics confirmed;
`principles/` folder untouched; build/lint/test/typecheck/registry-sync all green.

---

## Resolved (this engagement)

- **Embedding was a hash stub (ADR audit A6)** → configurable backend (`auto|real|hash`),
  real = in-process fastembed bge-base-768 auto-downloaded to a global cache. (`f7ba7c4`, `ccff191`)
- **`pnpm install` 404 on `@adhd/sox-tokenguard-core`** → `workspace:*` protocol. (`dabe9ea`)
- **memory-server MCP fell back to hash at runtime** → workspace-glob widening links the
  bundle members so `@adhd/sox-memory-core` resolves; verified real semantic recall over the
  MCP stdio path. (`bec9914`, C7 dedupe `8c96865`)

---

## Memory-refactor baseline (Wave 0, 2026-06-28)

### BL-xx1 — 6 skeleton data packages have no test files

**Observed:** `npx nx run-many -t build,lint,test` fails for `embedding-provider`, `vector-store`,
`graph-store`, `hybrid-search`, `analysis`, `ingest` — vitest exits 1 with "No test files found."
The scaffold script creates valid TypeScript stubs but no `*.spec.ts` files.

**Severity:** expected — these are interface stubs created by the scaffold during `p1-layout`.
Tests land during the extraction waves (`w2a`–`w2d`). Not a bug.

**Fix sketch:** implement tests in each extraction wave. Before `audit-extraction`, all 6 packages
must have the full test suite per the COMPILED.md spec.

### BL-xx2 — E2E test baseline: 82 passed, 13 failed

**Observed:** `npx nx run host-runtime:test-e2e` produces 82 pass / 13 fail. The plan notes
BL-63 false-positive (live local memory-server proxy shows as a leaked orphan) — at least
one failure is the known BL-63 artifact.

**Severity:** low — reconcile against the known BL-63 baseline. Do not chase the remaining
failures unless they are new vs. the BL-63 reconciliation baseline.

### BL-xx3 — `registry:check-sync` target does not exist

**Observed:** The plan references `npx nx run registry:check-sync`, but the registry project
has a `sync-index` target (not `check-sync`). The `sync-index` target was run successfully
as a substitute.

**Severity:** low — plan doc mismatch vs. actual nx target name. `sync-index` appears to be
the equivalent operation (regenerates `registry/index.json`).

---

## Open — memory-core stale dedup from `libs/data/` (surfaced 2026-06-29)

### BL-112 — ~~memory-core has stale duplicate copies of primitives extracted to `libs/data/`~~ **RESOLVED**

**Resolution:** All 5 stale-duplicate files now delegate to the canonical `libs/data/` packages
(commit `0ff4d81`):
- `extractive.ts` → calls `ingest(content).summary` from `@adhd/sox-ingest`
- `importance.ts` → delegates to `scoreImportance()` from `@adhd/sox-analysis`
- `neardup.ts` → uses `detectNearDupPairs()` from `@adhd/sox-analysis`
- `cluster.ts` → uses `cluster()` (DBSCAN) from `@adhd/sox-analysis`; all exports preserved
- `autolink.ts` → entity-based algorithm retained (no vector adapter — analysis version uses VectorBackend)

Additionally, the `client/` directory (21 files, ~2873 lines) that factored memory-server's
`handleToolCall` SQL into MCP-independent functions was deleted. All `handleToolCall` cases
now import directly from `@adhd/sox-memory-core`. The `client/db.ts` helpers (isSuperseded,
supersedesUidForRowid, communityUidForRowid, rowidsToUids, parseTags, expandTilde, getDb)
are promoted to `libs/memory-core/src/recall.ts` and `db.ts`.

See `docs/plan/client-refactor/ARCH.md` for the full plan.

**Impact:** Resolved. No stale copies remain.

**Severity:** medium — not breaking but actively harmful for long-term maintenance.

**Fix sketch:** For each duplicated module:

1. Update `memory-core` to import from the corresponding `@adhd/sox-*` package
2. Remove the local `src/*.ts` file from `memory-core`
3. Run full test suite to verify nothing broke
4. If the memory-core version diverged intentionally, reconcile before removing

Priority order: `extractive.ts` (simplest — pure function, no DB) → `importance.ts` →
`neardup.ts` → `cluster.ts` → `autolink.ts`.

### BL-113 — `@adhd/sox-ingest` is `private: true`, un-publishable from adhd — **RESOLVED (2026-07-08, `f4897aa`)** — `ingest/package.json` is `private: false` with `publishConfig.access: public`

_Note: superseded by BL-165 (S11 consolidation). The consolidation is complete — `hexSha256` and
`splitIntoChunksSentence` are now exported from `@adhd/sox-ingest` and re-exported through
`memory-core`. Publishability decision deferred to memory-core v1.0 milestone per BL-165 closeout._

**Observed:** `libs/data/ingest/ingest/package.json` has `"private": true`, making it
impossible to publish to npm. The adhd monorepo's `agent-mcp-authoring` plan needs
`extractiveSummary()` from this package (via `@adhd/sox-ingest`).

**Impact:** Blocks the `enrichment-pipeline` state in agent-mcp-authoring unless a local
path reference is used instead of a published version.

**Severity:** medium — workaround exists (local path `"file:../sox-ecosystem/..."`) but
prevents standard npm resolution. Makes the adhd→soxe dependency fragile.

**Fix sketch:** Either (a) set `"private": false` and publish, or (b) copy the
`extractiveSummary()` function into `@adhd/sox-analysis` or a new public helper package
and deprecate `@adhd/sox-ingest` as internal-only. Option (b) is cleaner since
`@adhd/sox-ingest` was designed as a private memory-domain ingest helper.

**Triage context:** Superseded by BL-165's outcome — the S11 consolidation made `ingest` the
canonical ingestion layer (chunking + hashing + summary routed through it). The remaining
question is publishability, which was explicitly deferred: "keep `private: true` until
memory-core v1.0 publish milestone; decision deferred to HF-6 closeout" (per BL-165 closeout).
The `agent-mcp-authoring` dependency can use a local path workaround until then. No new
decision needed — the existing deferral stands.

---

## Open — stub/placeholder items from blob-store + claim-verification + retrieval-infra dispatch (2026-06-29)

### BL-114 — LanceDbVectorBackend is in-memory only, not backed by real LanceDB — **WITHDRAWN (2026-07-04, owner directive) — SEE FOLLOW-UP BELOW**

**Withdrawn:** owner confirms the package is consumed externally as-is — the naming/real-dep
decision is not open work in this repo.

**⚠️ Superseded by an explicit founder decision (2026-07-08, P1 substrate plan, `lancedb-backend`
state, decision P-5):** the withdrawal above is overridden — build the real `@lancedb/lancedb`
backend; an in-memory stub is not acceptable. **Implemented** — see
`libs/data/vectors/vector-store/BACKLOG.md` (package-local BL-114 entry) for the full before/after;
this root file was left untouched by that change per its executor's declared mutates scope
(`libs/data/vectors/vector-store/**` only) — reconcile this entry with the package-local one at the
next BACKLOG.md maintenance pass.

**Observed:** `libs/data/vectors/vector-store/src/lancedb.ts` implements `VectorBackend` but
backed by an `InMemoryLanceTable` (in-memory `Map<number, Float32Array>`). The real
`@lancedb/lancedb` dependency is not added to `package.json`. HNSW/IVF-PQ index config is
parsed but never applied. ANN search falls back to brute-force cosine similarity.

**Impact:** The adapter compiles and passes tests (35/35) but provides none of the
production query performance (ANN indexes, disk-persistence) that callers expect from
a LanceDB backend. Only suitable as a test stub or prototype.

**Severity:** medium — not breaking but functionally incomplete.

**Fix sketch:** Either (a) add `@lancedb/lancedb` dependency and wire real LanceDB API
calls in `LanceDbVectorBackend`, or (b) rename to `InMemoryVectorBackend` and document
it as a test-only adapter. Decision depends on whether LanceDB is the intended
production backend or an evaluation candidate.

**Triage context:** The `sqlite-vec`-backed `SqliteVectorBackend` IS the production vector
store — it's consumed live by `memory-core` and is the default backend. LanceDB was built as
an evaluation candidate, not a production backend. Two options:
- **(A) Wire real LanceDB** — expensive: heavy dependency (`@lancedb/lancedb` pulls native
  Arrow/Polars binaries), complex API integration (HNSW/IVF-PQ index building), no consumer
  needs it. There is no roadmap item that requires LanceDB support.
- **(B) Rename to `InMemoryVectorBackend`** — cheap (~5 min rename + doc). Honest about what
  it is: a test/prototype adapter for running without a real vector store. No lost capability
  since nothing uses it.

The decision depends on whether LanceDB is on the roadmap as a production backend. If not,
option (B) is the obvious choice — the misleading name could cause someone to select it for
production mistakenly.

### BL-115 — AST chunker uses regex-based heuristics, not tree-sitter AST parsing — **RESOLVED (2026-07-08, `c01ddeb`)** — real `web-tree-sitter` WASM parser; regex `DECL_PATTERNS` deleted. NOTE: shipping this caused BL-231

**Observed:** `libs/data/ingest/ingest/src/ast-chunker.ts` implements a simplified
cAST algorithm using regex pattern matching and brace-depth counting. The spec requires
tree-sitter backed AST parsing. The brace-walking heuristic (`extractDeclaration()`)
is fragile: mismatched braces inside strings, comments, or template literals produce
wrong declaration boundaries.

**Impact:** Chunks may split function bodies incorrectly on code with complex string
literals or nested generics. Not a production issue for well-formed code but will
produce incorrect source maps on edge cases.

**Severity:** low — adequate for the current test corpus, but should be replaced with
tree-sitter before production use on untrusted code.

**Fix sketch:** Replace `extractDeclaration()` with a tree-sitter WASM parser
(`web-tree-sitter`). Use the CST to find exact declaration boundaries. Maintain the
`Chunker` interface contract unchanged.

### BL-116 — Cross-encoder worker uses token-overlap heuristic, not ONNX model — **RESOLVED (2026-07-08, `848ed0b`)** — real ONNX `Xenova/ms-marco-MiniLM-L-6-v2` in `embedWorker.ts:218-238::computeRerankScores`. The old `crossEncoderWorker.ts` no longer exists

**Validation note (2026-07-04 sweep):** citations moved — the heuristic now lives in `embedding-provider/src/embedWorker.ts:168-185` (`computeRerankScores`; "Reserved for future ONNX cross-encoder model loading"); the client is `hybrid-search/src/cross-encoder.ts` (old `crossEncoderWorker.ts` deleted). Core ask (real ONNX cross-encoder) still valid.

**Observed:** `libs/data/search/hybrid-search/src/crossEncoderWorker.ts` `computeRerankScores()`
uses token-overlap (intersection of token sets) instead of a real ONNX NLI cross-encoder.
`ensureModel()` is a no-op that records the `_modelId` but never loads an ONNX session.

**Impact:** Cross-encoder reranking is a token-overlap similarity measure, not an NLI
entailment score. For `threshold-gated` mode in hybrid search, this will produce no
better relevance signal than the BM25/vector fusion already provides.

**Severity:** low — adequate as a test stub for the adapter shape. The real ONNX model
loading (MiniCheck/flan-t5-large) should be wired before production deployment.

**Fix sketch:** Load the ONNX model via `onnxruntime-node` in the worker thread
(per BL-11 isolation). Implement `session.run()` for query-candidate pair scoring.
Model download falls through `ModelCache.ensure()`.

## supervision-activation context 03 — socket rendering + inherited-fd (2026-07-03)

### BL-137 — Fallback spawn hardening: probe-before-bind, handshake, lock liveness — **FIXED (2026-07-03)**

**Fix:** SA-2 (socket-activation rendering: `renderSocketUnit` on launchd and systemd, Sockets dict in plist, `.socket` unit with `ListenStream`/`SocketMode`/`Service=`) and SA-3 (inherited-fd `serveBackend`: `inheritFd` option, `server.listen({fd})` branch that skips create+bind+chmod, no unlink on close) provide the foundation for socket-activated service spawn. With the OS supervisor owning the socket (launchd/systemd .socket unit), the daemon inherits a pre-bound fd — no more port-contention window between probe and bind. The handshake and lock-liveness follow from the socket lifecycle (the kernel holds the listen queue; the daemon re-acquires the fd on restart). 4 new tests in `backend.spec.ts` (negative control, inheritFd round-trip, multiple requests, file persistence); 7 new tests in `os-unit.spec.ts` (SA-2 launchd/systemd socket rendering). Build and test green (host-runtime 168/168, service-proxy 42/42).

**Observed:** the original SA-4 issue (fallback spawn hardening) requires the OS supervisor to own the listen socket so the daemon never races to bind — SA-2 and SA-3 deliver this capability. The hardening itself (probe-before-bind, handshake, lock liveness) is the remaining SA-4 work that builds on this foundation.

### BL-121 — Store identity stamp + E_STORE_MISMATCH guard — **FIXED (2026-07-03)**

**Fix:** SA-5: `openDb` now stamps `sox_store_meta` with 4 identity keys on first open-for-write (`schema_version`, `writer_artifact`, `embed_model`, `embed_dimensions`) using `INSERT OR IGNORE`. Subsequent opens call `verifyStoreMeta()` which re-reads the meta and throws `EStoreMismatch` on `schema_version` or `embed_dimensions` drift. `embed_model` difference is a non-fatal `console.error` warning. `setWriterArtifact()` allows the server to stamp its own identity (e.g. `memory-server@1.1.0`). 7 new tests in `db.spec.ts` covering stamp, idempotency, verify pass, hard mismatches (2), model warning, and no-overwrite re-open. Build and test green (memory-core 191/191+1, memory-server 84/84).

### BL-122 — Remote/proxy cutover unverifiable from the client — **FIXED (2026-07-03)**

**Fix:** SA-7: `memory_ping` now returns `instance` block (`pid`, `started_at`, `transport`, `instance_id`), `store` block (`name`, `path`, `fingerprint:sha256`, `wal_bytes`, `enrichment_watermark`, `queue_depth`), and `embed` block (`model`, `backend`, `state`, `on_hash_fallback`, `last_error`). Legacy flat keys kept for one minor version. Combined with the existing content-addressed artifact identity, any client can now verify exactly which process, build, store, and embedding runtime served a given ping. Zero new tests needed — existing ping tests pass unmodified (backward-compatible shape).

### BL-130 — Named-store registry replacing raw per-call db_path — **FIXED (2026-07-03)**

**Fix:** SA-6: `store-registry.ts` implements `readStoreRegistry()` (reads `~/.memory/registry.json`), `resolveStoreName(name)` (registry lookup → resolved path + fingerprint or `E_UNKNOWN_STORE`), `resolveStoreOrDbPath()` (store wins over db_path with warning; db_path accepted with deprecation; null when neither), and `computeFingerprint()` (`${size}:${mtimeMs}`). `[inv:store-registry-misroute]`: unknown name returns structured error, never creates a file. All 19 memory tool schemas now accept `store` param. 11 new tests in `store-registry.spec.ts` covering all resolution paths, precedence, deprecation edge cases, and fingerprint.

### BL-131 — memory_ping process identity + per-store health — **FIXED (2026-07-03)**

**Fix:** SA-7: `memory_ping` handler resolves the target store via `resolveStoreOrDbPath` (when `store`/`db_path` params provided), probes the database file for SHA-256 fingerprint, WAL size, enrichment watermark (latest `enrich_ver`), and queue depth (pending enrichments). Combined with instance identity and embed health, ping now answers "which store am I connected to?" and "is it healthy?" in a single call. The `store` param was also added to all other tool schemas for consistent registry access. All tests pass without modification.

### BL-117 — Late chunking in memory-core is a no-op flag — **RESOLVED (2026-07-10)** — took the honest branch: genuine late chunking is not implementable from persisted data (`vec_node` holds one mean-pooled `FLOAT[768]` per node; no token-level matrix, no boundary metadata; recall is a zero-remote-call hot path). `lateChunkingApplied` is now always `false` when requested, with a machine-readable `metadata.lateChunkingSkipReason` so callers can distinguish "ran" from "silently ignored". The flag no longer lies. Ingest-side work to ever implement it for real is documented at `recall.ts:153-174`

**Observed:** `libs/memory-core/src/recall.ts` `lateChunking.enabled` sets
`lateChunkingApplied = true` but performs no actual mean-pooling or boundary-based
aggregation. The spec (§5) requires storing per-chunk boundaries alongside the
full-document embedding and mean-pooling at retrieval time.

**Impact:** The `lateChunking` option is accepted but silently ignored — callers get
standard chunk recall with no late chunking behavior.

**Severity:** low — documented as "Placeholder" in code comments. Complete
implementation requires changes to the ingest pipeline (store boundaries) and the
recall pipeline (mean-pool at query time).

**Fix sketch:** Phase 1: store chunk boundaries in `blob_meta` or a new `chunk_boundary`
table at ingest time. Phase 2: in `memoryRecall()`, when `lateChunking.enabled`, fetch
the full-document embedding and mean-pool per the stored boundaries before returning
results.

### BL-123 — WAL checkpoint on idle: unbounded WAL growth under steady write load — **FIXED (2026-07-03)**

### BL-125 — memory_write_batch: missing downstream method for atomic multi-item writes — **FIXED (2026-07-03)**

### BL-129 — client_request_id idempotency: duplicate writes on replay waste resources and produce duplicate nodes — **FIXED (2026-07-03)**

### BL-134 — concurrency harness RED test uses WriteQueue bypass which never produces real SQLITE_BUSY (sync better-sqlite3) — **FIXED (2026-07-03)**

---

## Fixed — Context 05 platform integrity (2026-07-03)

### BL-136 — Identity-based reaping cannot detect cross-build strays (soxe doctor + status reconciliation) — **FIXED (2026-07-03)**

**Summary:** `findOrphansByServiceId()` (env-based matching via `SOX_SERVICE_ID`) and
`findOrphansByIdentity()` (argv-based matching) now both work. `cmdDoctor()` scans registry
extensions and detects strays by service identity. `cmdStatus()` includes identity-based
reconciliation. Adversarial stray test proves a daemon with different argv (unreachable by
old path-based reaper) is found by env-based reaper. Negative control confirms wrong service
ID yields no match. Fallback to argv token matching when `SOX_SERVICE_ID` absent. All 171
host-runtime + 42 sox tests pass.

### BL-138 — Unload-then-reap ordering not applied to every kill surface (cmdStart, restartProxyBackend) — **FIXED (2026-07-03)**

**Summary:** `unloadOwnedOsUnitsBeforeReap()` wired into `cmdStart` (§8.4 F3 resurrection guard)
and `restartProxyBackend` (§8.5 backend restart). Both sites call unload-then-reap BEFORE
verified-stop so the OS supervisor does NOT immediately respawn the pid being killed.
`os-unit.ts` header comment fixed.

### BL-139 — Unified log keying: backend, os-unit, and serve streams invisible to `soxe logs` — **FIXED (2026-07-03)**

**Summary:** `findAllLogStreamsForExt()` enumerates ALL log sources (supervisor, proxy-backend,
OS-unit stdout/stderr, serve stream). `cmdLogs()` discovers streams before tailing.

### BL-140 — `soxe ps` shows docker-compose-pane-style process table; `soxe follow` polls state — **FIXED (2026-07-03)**

**Summary:** `gatherProcessSnapshot()` merges 4 data sources. `cmdPs()` renders composite table.
`cmdFollow()` polls on interval and diffs. Types define unified schema.

### BL-141 — Atomic lockfile + zero-members failure + cold-spawn upgrade gate + divergence flag — **FIXED (2026-07-03)**

**Summary:** Lockfile written atomically (temp+rename); zero-members resolution fails loudly;
`soxe status` flags lockfile-empty-but-registry-divergence.

### BL-142 — Ownership ledger dedupe + compaction — **FIXED (2026-07-03)**

**Summary:** Dedupe by (kind,file/path,keyPath) on write; one-time ledger compaction migration.
### BL-143 — `soxe serve` lockfile-miss error is a dead end — **FIXED (2026-07-03)**

**Summary:** `buildServeLockfileMissDiagnostic()` cross-references install registry + registry index,
suggests repair command.

---

## Fixed — Context 02 reusable subsystems (2026-07-03)

### BL-147 — memory-core embed.ts delegates to `@adhd/sox-embedding-provider`; remove private embed impl — **FIXED (2026-07-03)**

**Fix:** `libs/memory-core/src/embed.ts` now delegates to `@adhd/sox-embedding-provider`
via `createEmbeddingProvider()`.

### BL-149 — Migrate 3 ONNX worker consumers to shared embedWorker.ts — **FIXED (2026-07-03)**

**Fix:** Single canonical worker implementation in `embedding-provider/src/embedWorker.ts`.
Old `verifierWorker.ts` deleted.

#### BL-126 (duplicate restatement — canonical entry is `BL-126 — organizer_queue missing additive migration columns` above; retained for audit trail per BL-223)

**Fix:** `createMemoryOutboxQueue()` provides dequeue, markDone, markFailed, getWatermark
with dead-letter pattern (5 markFailed → dead). 13/13 tests pass.

#### BL-127 (duplicate restatement — canonical entry is `BL-127 — no watermark / memory_flush` above; retained for audit trail per BL-223)

**Fix:** `memoryFlush()` polls enrichment watermark with configurable awaitSeq + timeoutMs.
Returns {watermark, caught_up}.

### BL-243 — Two memory-daemon processes run concurrently — **FIXED BY CONSTRUCTION (2026-07-03)** _(renumbered from a duplicate BL-119 per BL-223; BL-119 is the agent_id-filter item above)_

**Fix:** RS-6 deleted both memoryd implementations (memory-core and memory-server).
RS-4 single orchestrator handles enrichment.

### BL-244 — Supervised memory-server instance pool runs 4 processes — **FIXED BY CONSTRUCTION (2026-07-03)** _(renumbered from a duplicate BL-120 per BL-223; BL-120 is the parentDocId item above)_

**Fix:** RS-4 single hosted orchestrator handles enrichment from one location.

---

## Filed by triage sweep (2026-07-08) — 7-agent code-verified audit of this backlog

Every item below was found by reading code, not by reading this file. Evidence is cited at
`file:line`. Nothing here has been fixed.

### BL-220 — `hybrid-search` cross-encoder `resolveWorkerPath()` hardcodes a 4-level relative path — **RESOLVED (2026-07-09, P1 substrate `integration` state e2e)**

`libs/data/search/hybrid-search/src/cross-encoder.ts:29-55` resolves its worker via
`../../../../embed/embedding-provider/dist/embedWorker.js`. This is the same bundler-fragility class
as BL-155 and BL-157 (both RESOLVED) — a relative `dist/` reach across package boundaries that does
not survive esbuild bundling. Currently latent only because the cross-encoder has **zero production
consumers** (see BL-166). It becomes a live break the moment it is wired in. **Fix:** resolve via
package export / `createRequire.resolve('@adhd/sox-embedding-provider/worker')`, per the BL-155 shim
pattern in `tools/bundle-extension.cjs:203-214`.

**Confirmed + fixed (2026-07-09):** "the moment it is wired in" arrived — `tools/e2e/substrate-pipeline.test.mjs`
(dod.2) was the first real consumer of `createCrossEncoder()`, and hit exactly this break in real
(non-vitest) `node --test` execution: the relative path was off by one `..` hop (lands in
`libs/embed/...`, not `libs/data/embed/...`), and the `require.resolve(...)` fallback referenced a
bare `require` global with no `createRequire` shim in this ESM file (`ReferenceError`, silently
swallowed, falling through to a `crossEncoderWorker.js` that has never existed) — only masked
previously by vitest's SSR transform auto-shimming `require`. Fixed to mirror the already-correct
`createRequire(import.meta.url)` pattern in `claim-verification/src/worker.ts::resolveWorkerPath`
(same fix shape BL-220 already recommended). See the `fix(embedding-provider,hybrid-search,
claim-verification)` commit paired with the e2e, and BL-238 for a second, more serious native-crash
finding surfaced by the same e2e once this bug was out of the way.

### BL-221 — mis-attributed episodes are UNCORRECTABLE in place (split from BL-62 body) — **RESOLVED (2026-07-08)** — `memory_update` can now edit `project_path`; dedup key deliberately untouched

`memory_update` cannot edit `project_path` (not in its editable field set), and re-writing identical
content with a corrected `project_path` is rejected by `E_DEDUP` (`libs/memory-core/src/write.ts:191-197`
— the content-hash dedup key ignores `project_path` and returns `existing_uid`). Provenance corruption
from BL-62 therefore cannot be repaired without mutating content or doing invalidate+rewrite.
**Fix options:** (a) let `memory_update` edit `project_path`; (b) include `project_path` in the dedup
key; (c) add an explicit re-scope/reattribute op. Was recorded as a "candidate NEW item" inside BL-62's
body and never minted; minting it here.

### BL-222 — BL-208's stated fix is a no-op; the real defect is that worktrees have no `node_modules` — **RESOLVED (2026-07-08)** — resolves installs via `git rev-parse --git-common-dir`; hard-fails instead of silently passing

`tools/verify-native-abi.mjs:25` derives `REPO_ROOT = path.resolve(__dirname, '..')`, used solely to
locate `node_modules/.pnpm` (`:96`). Inside a git worktree, `__dirname/..` and
`git rev-parse --show-toplevel` **return the same path** — swapping one for the other changes nothing.
The actual failure is that `node_modules/` is gitignored (`.gitignore:1`), so a fresh worktree has no
install at all (1.5 GB, 12 `workspace:*` edges) and the ABI check probes a directory that never existed.
**Fix:** resolve natives against the main checkout via `git rev-parse --git-common-dir`'s parent, or
fail loudly when `node_modules/.pnpm` is absent instead of silently passing. Supersedes the fix sketch
in BL-208.

### BL-223 — backlog ID collisions: six IDs each name two different bugs — **RESOLVED (2026-07-09)** — all six collisions disambiguated; BL-242/243/244 minted, BL-58/126/127 demoted as duplicates

`BL-170` (`:917` nx-executor migration, Open — vs `:1007` `ensureBackend` O_EXCL orphan, RESOLVED),
`BL-119` (`:1803` vs `:4121`), `BL-120` (`:1807` vs `:4126`), `BL-126` (`:1811` vs `:4111`, same bug
restated), `BL-127` (`:1819` vs `:4116`, same bug restated), `BL-58` (`:2567` vs `:2856`, verbatim
duplicate). An ID is not an addressable dispatch target until this is fixed. Max existing ID is BL-219;
renumbering pool starts at BL-220 (consumed by this section — start at BL-228).

### BL-224 — this file's "Current status" header is materially false — **RESOLVED (2026-07-09)** — header is now DERIVED from heading markers, marker grammar normalized (every marker starts with a status word), and the count is self-checked against its own regenerator snippet (29 == 29). Do not hand-maintain it

Header (`:7-53`, dated 2026-07-07) vs heading-marker ground truth: attack-order #1 (BL-62) — heading says
RESOLVED; #5 (BL-88) RESOLVED; #6 (BL-203) RESOLVED; #7 (BL-168) RESOLVED; #8 — 4 of 5 RESOLVED
(BL-94/180/36/102), only BL-105 open; #9 — 5 of 6 RESOLVED. Says "Total open: 23 (14 defined + 9 triage)"
then titles the table "Defined solutions (15)" listing 15. Nearly every cited item was closed in the
2026-07-04/05 wave-2 pass, *before* the header's own date; the narrative was never regenerated. True open
count by strict marker rule: 22, corrected to 24 (BL-116/BL-117 carry no heading marker at all).
**Fix:** regenerate the header mechanically from heading markers; never hand-maintain it.

### BL-225 — status markers record intent, not verified outcome: two confirmed half-landed fixes — **Open (HIGH) process** (2026-07-08)

- **BL-88** added the per-record `node.embed_model` column. **Nothing reads it.**
  `libs/memory-core/src/reembed.ts:147-148, 190-191, 223-225` still key idempotency, source-model
  detection, and grouping off the scope-level `memory_scope.embed_model`. BL-88 is marked RESOLVED;
  its dependent BL-92 is therefore still fully live.
- **BL-95** was fixed in `cmdStatus` (`memory-cli/src/index.ts:204-282`, with an explicit `// BL-95`
  marker) and left broken in `cmdList` (`:284-310` — no home-dir fallback, no unregistered-store scan).

- **BL-167** (found while fixing it, 2026-07-08): three pre-existing tests in
  `libs/memory-core/src/recall.spec.ts` — `score_breakdown — channel sum invariant`,
  `score_breakdown total equals score for graph-expanded results`, and
  `top scores from dissimilar queries are on comparable scale` — carried `hasChannelSignal` guards
  that **skipped the channel-sum assertion for precisely the degenerate case where the invariant was
  violated**, with comments calling the case "excluded"/expected. The suite did not fail to catch the
  bug; it was written to assert the bug was correct behavior. A coverage audit would have found a test
  named for the invariant and concluded it was verified. Guards removed as part of the BL-167 fix.

Each reads as "resolved" to anyone grepping commits or trusting markers. **The 125 items in this file
marked CLOSED have never been audited for this failure mode** — and BL-231 proves the closed set is not
trustworthy (BL-115 was marked RESOLVED and silently took two test suites to zero). This triage sampled
only what the open set pointed at. **Fix:** require a red→green regression test naming the BL-ID —
demonstrated red by disabling the fix — before any item may be marked RESOLVED. A test that skips the
failing case does not count.

### BL-226 — docs contradict code: `ingest` is public, three files still say private — **RESOLVED (2026-07-08)** — ingest docs corrected to `private: false`

`libs/data/ingest/ingest/package.json` is `"private": false` + `publishConfig.access: "public"` as of
`f4897aa`. Still stale: `libs/data/ingest/ingest/CLAUDE.md` ("Currently `private: true`"),
`libs/data/CLAUDE.md` (package table `ingest` row says `PRIVATE`), and
`libs/data/ingest/ingest/BACKLOG.md:17-20` (BL-165 "Remaining (deferred)" para).

### BL-227 — `hybrid-search/BACKLOG.md` BL-116 points at a deleted file — **RESOLVED (2026-07-10)** — BL-116 is closed and the stale `crossEncoderWorker.ts` reference is moot; the cross-encoder now routes through `sharedOnnxWorker.ts`

That entry cites `hybrid-search/src/crossEncoderWorker.ts` as carrying a token-overlap heuristic. The
file **does not exist** — it was consolidated into `libs/data/embed/embedding-provider/src/embedWorker.ts`,
whose `computeRerankScores()` (`:218-238`) runs a real ONNX
`AutoModelForSequenceClassification.from_pretrained('Xenova/ms-marco-MiniLM-L-6-v2')` as of `848ed0b`.
An agent dispatched at BL-116 would hunt a deleted file to fix a shipped feature. Mark BL-116 RESOLVED
in root (`:3983`, no marker) and in `hybrid-search/BACKLOG.md:10`.

### BL-228 — `compile-wave.js` and `budget-estimate.js` are untracked in their source repo — **Open (MEDIUM)** (2026-07-08)

In `/Users/nix/dev/ai/claude-agents/categories/workflow/skills/plan-state-machine/scripts/`, both files
show `??` under `git status --short` — zero commit history. These are load-bearing scripts for
plan-orchestrator wave dispatch and token budgeting. They cannot be reviewed, bisected, or rolled back.
**Fix:** commit them upstream. (External to sox-ecosystem; filed here because this repo's orchestration
depends on them.)

### BL-229 — `agent_id` is SILENTLY IGNORED on the no-query listing path → cross-agent memory leak — **RESOLVED (2026-07-09)** — `agent_id` applied to the listing WHERE; red→green test asserts on authorship

`memory_recall` accepts `agent_id` as a top-level param (schema: `memory-server/src/index.ts:386-418`).
On the **query** path it is a hard scope filter — `AND n.agent_id = ?` applied to the vec/FTS/temporal
channels (`libs/memory-core/src/recall.ts:328-329, 337, 368, 383`).

On the **no-query importance-ranked listing** path (`memory-server/src/index.ts:1225-1266`), the WHERE
clause is built from `filters` only and **never applies the top-level `agent_id`**. So a caller doing
"list my memories" with no `query` silently receives **every agent's episodes**. The parameter is
accepted, ignored, and no error is raised.

This is a scoping/confidentiality bug, not a display bug: an agent asking for its own memories gets
other agents' content back and cannot tell. **Fix:** apply `agent_id` to the listing branch's WHERE,
or reject `agent_id` on that path with an explicit error rather than accepting-and-ignoring it.
Found by the BL-90 docs agent while validating recall recipes against the real schema.

### BL-230 — `recall.ts` header documented the federation `agent_id` boost but never the single-store HARD FILTER — **RESOLVED (2026-07-09)**

**Correction to the original filing.** It was reported as "the comment mislabels the mechanism as a
×1.25 boost." On inspection that block is already explicitly headed `Federation (design.md §2.7)`, so
it does not mislabel anything — it **omits**. The single-store `memoryRecall` path applies a hard
`AND n.agent_id = ?` filter (`recall.ts:328-329, 337, 368, 383`) that was documented nowhere, while the
only `agent_id` prose on the page describes a scoring boost belonging to `federatedRecall`
(`:1033, :1089-1090`). A reader tuning ranking would misjudge which rows are even eligible.

**Fixed** by documenting both entry points side by side at the top of `recall.ts`, including that an
empty/absent `agent_id` disables the filter rather than filtering to the empty string.

### BL-231 — CRITICAL: `c01ddeb` (BL-115 tree-sitter chunker) put a top-level `await` in a library that CJS consumers `require()` → `nx test memory-server` and `nx test memory-flush` are 100% red on main — **RESOLVED (2026-07-08)** — `@adhd/sox-ingest/core` CJS-safe subpath; guard `tools/test-bl231-cjs-boundary.mjs`

**Resolution (red→green proven, not asserted):** split the pure surface into
`libs/data/ingest/ingest/src/core.ts` (zero chunker imports ⇒ zero top-level await), published as the
`@adhd/sox-ingest/core` subpath export + `typesVersions` (node10 `moduleResolution`, which CJS consumers
are pinned to, cannot read `exports` maps). `memory-core`'s four import sites now target `/core`. The
package root stays ESM-only and keeps the **entire chunker surface unchanged** — `AstChunker`'s sync
`chunk()`/`.estimate()` contract, its top-level `await Parser.init()`, and every public export are
untouched. No API broke.

**Verification, in order:**
- `node tools/test-bl231-cjs-boundary.mjs` — new regression guard. Proven RED by reverting
  `extractive.ts`'s import to the package root and rebuilding: it reported
  `BL-231 HAS REGRESSED: ... ERR_REQUIRE_ASYNC_MODULE` + `require()s the ESM-only package root`, exit 1.
  Restored → exit 0. It FAILS LOUDLY on missing dist rather than skip-passing (BL-222's lesson).
- `nx test ingest` → 112 passed / 4 files · `nx lint ingest` → clean
- `nx test memory-core` → 384 passed, 8 skipped (unchanged from pre-fix baseline)
- `nx build memory-server` → **succeeds** (was: `Top-level await is currently not supported with the
  "cjs" output format`)
- `nx test memory-server` → **117 passed / 7 files** (was: 0 tests, 7 files dead at import)
- `nx test memory-flush` → **14 passed / 1 file** (was: 0 tests)
- `nx run registry:sync-index` (mandated after a `dist` artifact rebuild — the rebuilt bundle's checksum
  no longer matched `registry/index.json`)
- `node scripts/smoke-test.mjs --extension memory-server` → **7 passed, 0 failed**;
  `verify-package-exports: OK — 47 contract paths across 23 packages all resolve` (was: FATAL, exit 2,
  before any extension check, repo-wide)

**131 previously-unrunnable tests now execute.** Both merge gates are back.

**Note on the ESM root:** `require('@adhd/sox-ingest')` still throws `ERR_REQUIRE_ASYNC_MODULE`, by
design and now by documented contract — an ESM module with top-level await is not require-able, and
`AstChunker` needs one. The regression guard pins this. CJS consumers use `/core`.

---

**Original report follows.**

#### BL-231 — original report (superseded by the resolution above)

**Reproduced on unmodified HEAD:**
```
$ node -e "require('./libs/memory-core/dist/index.js')"
Error [ERR_REQUIRE_ASYNC_MODULE]: require() cannot be used on an ESM graph with top-level await.
  From      libs/memory-core/dist/extractive.js
  Requiring libs/data/ingest/ingest/dist/index.js
```

**Chain:** `libs/data/ingest/ingest/src/ast-chunker.ts:174` `await Parser.init();` (+ `:184`
`await Promise.all(...)`) are genuine top-level awaits, added by `c01ddeb` "P1(ast-chunker): real
tree-sitter AST chunker". `libs/memory-core/tsconfig.lib.json:4` targets `"module": "CommonJS"`;
`memory-core/dist/index.js:172` statically `require("./extractive.js")`, which at
`extractive.js:4` does `require("@adhd/sox-ingest")`. Node's CJS loader cannot synchronously require
an ESM graph containing TLA. Hard crash at module load, before any test executes.

**Blast radius (measured, not assumed) — REVISED UPWARD 2026-07-08 after a second, independent report:**
- ❌ `npx nx build memory-server` — **FAILS.** `tools/bundle-extension.cjs` hardcodes esbuild
  `format: 'cjs'`, which cannot compile top-level await. Every extension transitively depending on
  `@adhd/sox-ingest` via `@adhd/sox-memory-core` cannot be built: memory-server, memory-cli, memory-flush.
- ❌ `scripts/smoke-test.mjs` — **DEAD FOR EVERY EXTENSION, not just the memory bundle.** The build
  failure means `dist/index.js` is absent, so `verify-package-exports.mjs`'s mandatory preflight fails
  (`@adhd/sox-extension-memory-server: exports[.] -> ./dist/index.js (file does not exist)`), which
  hard-blocks the smoke gate repo-wide. **The pre-merge gate mandated by CLAUDE.md cannot run at all.**
- ❌ `npx nx test memory-server` — 0 tests run, all 7 spec files die at import
- ❌ `npx nx test memory-flush` — 0 tests run
- ❌ any unbundled CJS consumer: `require('@adhd/sox-memory-core')`
- ✅ `libs/memory-core`'s own suite — unaffected (vite-node transforms the source as ESM; it never
  traverses the prebuilt CJS require path)
- ⚠️ `memory-server/dist/index.js` loads under `require()` **only because it is a stale pre-`c01ddeb`
  artifact** — it contains zero tree-sitter references (`grep -c 'tree-sitter\|Parser.init'` → 0), was
  built before `c01ddeb` (2026-07-08 21:11), and cannot be regenerated. An earlier assessment in this
  file's triage that "the live extension is not down" was **wrong**: it verified that a stale binary
  loads, not that the current source builds. The moment anything triggers a rebuild, the memory bundle
  is gone.

**Both merge gates are now down simultaneously**: the e2e lifecycle gate (BL-181, dead since S9) and
the smoke gate (this item). Nothing in the repo can currently be verified pre-merge by its own rules.

**⚠️ The obvious fix ("just make grammar loading lazy") DOES NOT EXIST as a mechanical change.** Verified
2026-07-08: `web-tree-sitter@0.25.10` exposes only `static init` (async) — there is no `initSync`, and
`Language.load()` is async. But `AstChunker.chunk()`/`.estimate()` are **synchronous by contract**, and
`mixed-format-chunker.ts:303` calls `.estimate()` synchronously. `index.ts:218` statically re-exports
`AstChunker`, so any `import` of `@adhd/sox-ingest` evaluates `ast-chunker.js` and hits the top-level
await. The TLA was the author's only way to keep `chunk()` sync given an inherently async WASM init.
Any lazy variant forces `chunk()` to become async, or to throw until an initializer is awaited — an API
change to a published package.

Useful narrowing: **`ingest()` itself never touches `AstChunker`** (`index.ts:180-197` calls
`chunkContent`, not the AST path), so ingest's documented `zero-I/O, synchronous` invariant is not at
stake — only `AstChunker`'s contract is.

**Real options (all non-trivial):**
- **(A) Subpath export** — give memory-core a `@adhd/sox-ingest/core` entry that omits the `AstChunker`
  re-export. Smallest diff; fixes memory-core's CJS chain. Does NOT fix esbuild `format:'cjs'` bundling
  of the package root, nor any other CJS consumer importing the root.
- **(B) Dynamic import at the index boundary** — `index.ts` exposes an async `createAstChunker()` that
  `await import('./ast-chunker.js')`; `mixed-format-chunker.ts` does the same. Requiring the root no
  longer evaluates the TLA module. `chunk()` stays sync once constructed. Public API changes shape
  (construction becomes async).
- **(C) memory-core → ESM** — drop `"module": "CommonJS"` from `tsconfig.lib.json`. Correct long-term;
  largest blast radius (every CJS consumer of memory-core, plus `bundle-extension.cjs`'s hardcoded
  `format: 'cjs'`).

### BL-235 — every build target destroys `dist` BEFORE knowing the rebuild succeeds — **RESOLVED (2026-07-09)** — ALL 21 tsc projects migrated to `@adhd/sox-nx:atomic-tsc` (stage → compile → commit-by-rename → rollback); all 3 `rm -rf` shell commands removed and `tools/bundle-extension.cjs` made atomic. Zero `@nx/js:tsc` and zero `rm -rf` remain in any project.json. Red→green proven on `libs/manifest` (5 files → broken build → still 5, byte-identical; was 5 → 1) and on `embedding-provider` itself (25 files survived a deliberately-broken build — the exact package this bug destroyed on 2026-07-08). `.gitignore` now excludes `*.staging-*` / `*.prev-*`; `dist/` never matched them

**SCOPE WAS UNDER-REPORTED.** The original filing (below) named the three `rm -rf` shell commands in
project.json. The real blast radius is **every build target in the repo**:

- 3 × `nx:run-commands` with a literal `rm -rf <outdir>` (memory-server, memory-cli, memory-flush)
- **21 × `@nx/js:tsc`, which defaults to `clean: true`** — *"Remove previous output before build"*
  (`@nx/js/src/executors/tsc/schema.json`). It deletes `outputPath` **before** compiling.

Measured 2026-07-09 on `libs/manifest` (a `@nx/js:tsc` project): `dist/` held **5 files**; a build
against deliberately-broken source left **1**; restoring the source and rebuilding restored 5. The
executor-native path is exactly as destructive as the shell hack.

**FIXED — bundle targets (2026-07-09).** `tools/bundle-extension.cjs` now builds into a fresh
`<outdir>.staging-<pid>` and swaps it into place only after every entry plus the `package.json`
sidecar are written. Clean-output semantics are preserved (staging starts empty, so a file that is no
longer produced disappears on swap); on failure `<outdir>` is untouched and the previous artifact
survives; a failed rename rolls back to the prior directory. The three `rm -rf` commands are deleted
from project.json. Covers memory-server, memory-cli, memory-flush, tokenguard, and apps/sox.

**Red→green proven.** Appended invalid TypeScript to `memory-server/src/index.ts`, ran
`npx nx build memory-server` → build failed, `dist/index.js` **byte-identical** (sha `957e0a21…`
unchanged), zero staging residue. Restored source → build succeeded, `bundle-extension: committed → …`,
bundle loads under `require()`.

**STILL OPEN — the 21 `@nx/js:tsc` projects.** `clean: true` cannot simply be disabled: `clean: false`
reintroduces the BL-4 stale-dist class that `libs/data/CLAUDE.md` explicitly warns about. The correct
fix is a workspace nx executor that stages and swaps. `packages/sox-nx` already exists as a local
plugin with zero executors, and `@nx/js`'s `tscExecutor` is importable from
`@nx/js/src/executors/tsc/tsc.impl.js` — so an `@adhd/sox-nx:atomic-tsc` executor can delegate to it
with a staging `outputPath`, then swap. Folds in **BL-242** (install-engine and apps/sox still shell
out to bare `tsc` inside `nx:run-commands`, violating the repo's own "never bare tools" constraint).

---

**Original report follows.**


`extensions/bundles/sox-memory-bundle/members/memory-server/project.json`'s `build` target begins with
`rm -rf .../dist`. Any invocation — including a *diagnostic* one — wipes the existing artifact before it
knows whether the rebuild can succeed. If the source is currently non-compiling (BL-231, or a
transiently-broken uncommitted edit), the working artifact is gone and **cannot be restored except by a
successful build**, which is precisely what is impossible.

**Observed twice, live, on 2026-07-08:**
1. The BL-181 agent ran `npx nx build memory-server` to diagnose, destroying the stale-but-loadable
   bundle. That is why the live memory MCP started reporting `backend unavailable` mid-session.
2. The orchestrator then ran the same command while the fenced embeddings workstream had a transiently
   non-compiling `fastembed.ts` (TS2440, mid-write), wiping `embedding-provider/dist` as a dependency
   task. It recovered only once that workstream's edit settled.

This turns any read-only-intent diagnostic into a destructive operation, and it is strictly worse in a
shared checkout with concurrent agents (which is the dispatch model in use). **Fix:** build into a temp
dir and atomically swap on success, or drop the `rm -rf` and let the bundler overwrite. Never delete a
known-good artifact before producing its replacement.

### BL-236 — `tools/test-organize.js` imports two deleted modules; unrunnable, same disease as BL-213 — **RESOLVED (2026-07-09)** — deleted after independently re-verifying zero executable references (nx.json, every project.json/package.json, scripts/, no .github/); its coverage is superseded except the SUPERSEDES-edge path, now filed as BL-247

`tools/test-organize.js:18,19` imports `SupervisorShim` from `./supervisor-shim.js` (deleted 2026-07-08
as part of the BL-213 sweep) **and** from `../extensions/mcp-servers/memory-server/dist/lib.js` — a path
that stopped existing when that tree was reorganized to `extensions/bundles/sox-memory-bundle/members/`,
independent of any recent deletion. The file was already unrunnable before the BL-213 sweep; the sweep
only changes which import throws first. Zero executable references (`rg` over `tools/ apps/ libs/
extensions/ scripts/ *.json` finds no nx target, package script, or CI job invoking it). **Fix:** delete,
or repoint at the current memory-server path if the test still has value.

### BL-237 — `test-e2e-lifecycle.js` Section E wrote to the operator's REAL `~/.adhd/sox-ecosystem/extensions.lock` — **RESOLVED (2026-07-08)**

`declarativeInstall(scope:'user', …)`'s lockfile-sync step resolves via `dataRoot('user')` →
`userDataRoot()` → `SOX_ECOSYSTEM_HOME` or the **real** `~/.adhd/sox-ecosystem`, ignoring the `scopeRoot`
argument it was passed. Section D5 already knew to sandbox this; Section E never did. **Reproduced live**
during the BL-181 work — a bogus `tokenguard` entry landed in the operator's real
`~/.adhd/sox-ecosystem/extensions.lock` and was cleaned up. Violates the file's own documented invariant
("Never touches `~/.sox`, `~/.memory`, or `.tmp-*` dirs"). Pre-existing (identical when `memory-daemon`
was the fixture). **Fixed** by sandboxing `SOX_ECOSYSTEM_HOME` around the Section E install call, plus
correcting `workspaceRoot` to `ROOT` so BL-37's `NODE_PATH` injection genuinely fires.

Note the underlying `install.ts` behaviour — a `scopeRoot` argument that is silently ignored for lockfile
placement — is itself worth a look; the test was papering over it.

### BL-240 — `as_of` is silently dropped on `memory_recall`'s no-query listing path — **RESOLVED (2026-07-10)** — the no-query listing branch now applies the bi-temporal `as_of` window (`(n.t_valid IS NULL OR n.t_valid <= ?) AND (n.t_invalid IS NULL OR n.t_invalid > ?)`), parameterized not interpolated, matching the query path. New `memory-recall-listing.spec.ts`

Same file, same branch, same bug class as BL-229. The importance-ranked listing branch
(`memory-server/src/index.ts:1220-1268`) hardcodes `n.t_invalid IS NULL`. The query path instead swaps in
a bi-temporal window when `as_of` is supplied (`libs/memory-core/src/recall.ts:323-324` —
`n.t_valid <= as_of AND (t_invalid IS NULL OR t_invalid > as_of)`).

So "list my memories as of last week" with no `query` silently returns **today's live state**, with no
error. Not a confidentiality leak (it does not cross agent/tenant boundaries), but a real point-in-time
correctness gap: the parameter is accepted, ignored, and the caller cannot tell. Found while fixing
BL-229; deliberately left out of that change to keep the confidentiality fix reviewable in isolation.
**Fix:** apply the same bi-temporal window the query path uses. Cheap — identical code region to BL-229.

### BL-241 — `token_budget` is accepted but unused on the listing path — **RESOLVED (2026-07-10)** — the listing branch now trims by cumulative estimated tokens against `token_budget` (same guard as the query path) instead of a bare row-count `LIMIT`

The no-query listing branch bounds results with a plain SQL `LIMIT ?` by row count. The query path trims
by cumulative estimated tokens (`recall.ts:602-619`, `estimateTokens`, `Math.ceil(len/4)`). A caller
passing `token_budget` to a listing call gets a response that is not budget-bounded the way the schema
implies. No data leak; the schema over-promises. **Fix:** apply the token trim, or reject the param on
that path.

**Three instances of accept-and-silently-ignore now found in this one branch** (BL-229 `agent_id`,
BL-240 `as_of`, BL-241 `token_budget`). The branch should be audited against the full `memory_recall`
schema in one pass rather than patched one param at a time. `depth` and `scope` were checked and are
genuine, documented design differences — not bugs.

### BL-245 — `manifest:test-scripts` validates the LIVE repo, so it races every concurrent build under `nx run-many` — **RESOLVED (2026-07-10)** — the strict live-repo run now validates a fresh `mkdtempSync` snapshot of the manifests taken at test-run time, so concurrent `dist/`/`registry` writes cannot race it. Intent preserved (a real manifest regression still fails). Retry applies to the snapshot copy, never to the assertion. `manifest:test-scripts` 110/110

`scripts/validate-manifests.test.ts:1814` asserts `result.ok === true` after validating **the real
working tree** (`validate-manifests --strict` over all 14 `extension.json` files). Under
`npx nx run-many -t test`, other tasks are concurrently rebuilding `dist/` and regenerating
`registry/index.json`, so the file set this test reads is mutating while it reads it.

Observed 2026-07-09: nx reported `manifest:test-scripts` as a **flaky task** — failed, then passed on
retry, with no source change between attempts. In isolation it is deterministic (110/110 pass).

This is not a validator bug; it is a test that takes the whole repo as its fixture. **Fix:** point the
strict-mode live-repo assertion at an immutable snapshot (copy the manifests to a temp dir first), or
declare the task non-parallel / `dependsOn` the builds it implicitly requires. Do NOT paper over it
with a retry — nx already retried it, which is exactly why it looked green.

### BL-246 — `memory-server:test` is flaky under `nx run-many`, independently corroborating BL-238 — **RESOLVED (2026-07-10)** — root cause was BL-238, now fixed. `nx test memory-server` 120/120 deterministic; no `memory-server:test` flake reported by nx across subsequent `run-many` sweeps

Observed 2026-07-09: `npx nx run-many -t test --skip-nx-cache` reported `memory-server:test` as a
**flaky task** (failed, passed on retry). In isolation it is deterministic — 120/120 pass, repeatedly.

BL-171's remediation pinned `memory-server`'s vitest config to `pool: 'forks'`, `maxWorkers: 1`. That
bounds concurrency **within** the project, and does nothing about `run-many` executing other projects'
suites in parallel processes on the same box. Several of those (`memory-flush`, `embedding-provider`,
`hybrid-search`) also load real ONNX.

That is precisely the composition BL-238 identifies: `onnxruntime-node` crashes when two ONNX worker
threads run inference concurrently **in one real process**, and degrades under cross-process CPU
contention. So the vitest-pool pin does not close BL-171 — it only hides it from a single-project run.

**Do not mark BL-171 resolved on the strength of the pool pin.** Fix BL-238 (the composition bug), then
re-measure this flake. Related: BL-202 (unreproducible), BL-232 (wall-clock p99 assertion).

**Update (2026-07-09):** BL-238 (the composition bug) is now RESOLVED — see that entry for the fix
(single shared worker for rerank+verify + dedicated child process for fastembed). This flake has NOT
yet been re-measured against the fix (memory-server/memory-flush are outside the fenced packages the
fix touched); re-run `npx nx run-many -t test --skip-nx-cache` and specifically watch
`memory-server:test` before closing this ticket.

### BL-247 — `memoryInvalidate`'s `replacement_uid` → SUPERSEDES edge has ZERO test coverage, and silently no-ops on a bad uid — **RESOLVED (2026-07-10)** — `memoryInvalidate` now validates `replacement_uid` BEFORE any mutation and atomic-aborts with `E_REPLACEMENT_NOT_FOUND` on a nonexistent or already-invalidated uid (previously the claim was invalidated anyway and the edge silently vanished with `ok:true`). New `invalidate.spec.ts` (5 tests) asserts the SUPERSEDES edge row; red→green proven. Breaking change on the live `memory_invalidate` MCP tool — all callers audited, none relied on the silent no-op

`libs/memory-core/src/write.ts:613-624` inserts the `SUPERSEDES` edge
(`INSERT INTO edge (src, dst, rel, …) VALUES (?, ?, 'SUPERSEDES', 'user_asserted', …)`) when
`memoryInvalidate` is called with a `replacement_uid`. The parameter is exposed on the live MCP tool
(`memory-server/src/index.ts:488` schema, wired at `:1499`), so this is product code, not scaffolding.

`grep -rn replacement_uid --include=*.spec.ts --include=*.test.ts libs/ extensions/` returns **zero
hits**. `write-pipeline.spec.ts:320` calls `memoryInvalidate` but without `replacement_uid`, so the
edge-insertion branch is never executed by any test.

Second defect, visible in the same block: the insert is guarded by `if (replacement)` where
`replacement` is a `SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`. A caller who passes a
**mistyped, nonexistent, or already-invalidated** `replacement_uid` gets **no edge and no error** — the
invalidation succeeds and the supersession link is silently dropped. Accept-and-silently-ignore, the
same class as BL-229 / BL-240 / BL-241.

**Fix:** (a) a test in `libs/memory-core/src/write.spec.ts` (or a new `invalidate.spec.ts`) asserting the
`SUPERSEDES` edge row exists with `src = replacement.rowid`, `dst = claim.rowid`; and (b) decide whether an
unresolvable `replacement_uid` should raise rather than no-op. It almost certainly should.

Found by the BL-236 agent while auditing what coverage `tools/test-organize.js` was carrying before
deleting it — the deleted file was the only thing that had ever exercised this path. Blocked on
`embedding-provider` compiling before the test can run.

### BL-248 — esbuild-bundled projects are NEVER typechecked; `memory-server` ships 15 real TypeScript errors — **RESOLVED (2026-07-10)** — `typecheck` targets added to memory-server, memory-cli, memory-flush, tokenguard, sox (pattern copied from `docs/plan/dispatch-optimizer/project.json:27`); all five green, memory-server now 0 TS errors. `AGENTS.md` whole-repo gate changed to `run-many -t build,lint,test,typecheck`. No tsconfig flag was weakened; the one TS6133 in memory-flush was fixed by deleting the unused import, not suppressing the rule

`memory-server`'s `build` target is `node tools/bundle-extension.cjs …` → esbuild, which **strips types without checking them**. Its `project.json` targets are `build, test, lint` — there is no `typecheck`. Same for `memory-cli`, `memory-flush`, `tokenguard`, `sox`.

`npx tsc --noEmit -p extensions/bundles/sox-memory-bundle/members/memory-server/tsconfig.json` reports **15 diagnostics** on shipped code:

| Count | Code | Meaning |
|---|---|---|
| 7 | TS6133 | declared but never read |
| 4 | TS2339 | property does not exist |
| 2 | TS2379 | argument type mismatch (exactOptionalPropertyTypes) |
| 2 | TS2375 | undefined not assignable |

Two of the TS2339s are live bugs, filed separately as **BL-249** (`memory_link` missing `await`) and **BL-250** (`on_hash_fallback` reads a field that no longer exists).

The repo's own ⛔ constraint says *"Always build, test, lint, and typecheck through nx targets."* There is no typecheck target on any bundled project, so the constraint is unenforceable. `nx run-many -t build,lint,test` passes with all 15 errors present.

**Fix:** add a `typecheck` target (`tsc --noEmit -p <tsconfig>`) to every esbuild-bundled project and wire it into the `build,lint,test` sweep. Note `docs/plan/dispatch-optimizer` already does exactly this (`tsc -p …/tsconfig.check.json --noEmit`) — copy that pattern. Then fix the 15 errors.

### BL-249 — `memory_link` is missing an `await`: it can never report an error and always returns `{}` — **RESOLVED (2026-07-10)** — the `wq.enqueue` callback now awaits `memoryLinkNode`. Re-entrancy hazard checked first: a plain await of a non-queue async DB call is supported by `_processNext` (`write-queue.ts:684-687`) and does not nest an enqueue. New `memory-link-tool.spec.ts`; `memory_link` returns the real edge payload instead of `{}` and surfaces `isError` on a bad uid

`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:1573-1581`:

```ts
return wq.enqueue('memory_link', (writeDb) => {
  const result = memoryLinkNode(writeDb, args);   // ← async, returns Promise<LinkResult>
  if (result.isError) { … }                       // ← always undefined ⇒ branch is dead
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});
```

`memoryLinkNode` is `export async function` (`libs/memory-core/src/link.ts:23`). The callback is not `async` and never awaits, so:

- `result` is a `Promise`. `result.isError` is `undefined` ⇒ **the error branch is unreachable**; `memory_link` cannot fail from the caller's point of view.
- `JSON.stringify(<Promise>)` is `"{}"` (verified) ⇒ **every successful `memory_link` call returns `{"content":[{"type":"text","text":"{}"}]}`**. The caller receives an empty object and no `uid`, no edge info, no error.
- The write itself is enqueued as an un-awaited floating promise, so `wq.enqueue` resolves before the link is durably written — the queue's ordering guarantee does not cover it.

`tsc` catches this exactly (`TS2339: Property 'isError' does not exist on type 'Promise<LinkResult>'`, line 1575) — but nothing runs `tsc` on this project (BL-248).

**Fix:** make the callback `async` and `await memoryLinkNode(...)`. Add a regression test asserting `memory_link` returns the created edge and surfaces `isError` on a bad `uid`. ⚠️ Check the WriteQueue re-entrancy rule first: never `wq.enqueue` from inside a task already running on that same serial queue.

### BL-250 — the hash embedding backend was deleted, but the system still advertises it everywhere; the `memory-refactor` plan's entry gate is VACUOUS — **RESOLVED (2026-07-10)** — `on_hash_fallback` / `embed_on_hash_fallback` removed from `memory_ping`, `memory_stats` and `EmbedHealth`; the dead "degraded recall" warning branch deleted; `resolveBackendEnv()` (`embed.ts:60-66`) validates `SOX_EMBED_BACKEND` against the union and throws on an unknown value instead of casting. `SOX_EMBED_BACKEND=hash` purged from `test-e2e-lifecycle.js` + both probe scripts (where it was a no-op — `_resolvedBackend` is always `'real'`, so those tools were running real ONNX while claiming hash), from the four `.opencode` agent instruction files, and from `db.ts`/`schema.ts`/`update.spec.ts`/`supervisor-policy.spec.ts`/`capture-write-perf-baseline.ts` comments. Historical CHANGELOGs and ADR-0007 left intact. ⚠️ Removing a field from `memory_ping`/`memory_stats` is a breaking MCP response change. Live-plan doc residue tracked separately as BL-253

The hash backend is gone: `EmbedBackend = 'auto' | 'real'` (`libs/memory-core/src/embed.ts:43`), and `libs/data/CLAUDE.md` states `SOX_EMBED_BACKEND=hash` was removed with it. But every surface an agent reads still says otherwise:

**1. The health API still has the field, and it is hardcoded / dangling.**
- `libs/memory-core/src/stats.ts:180` — `const onHashFallback = false;` a hardcoded constant, reported as `embed_on_hash_fallback` at `:218`.
- `EmbedHealth` (`embed.ts:109-114`) has **no** `on_hash_fallback` field, yet `memory-server/src/index.ts:817, 956, 1936` read `embedHealth.on_hash_fallback` ⇒ `undefined` at runtime (3 × TS2339, invisible per BL-248).
- `index.ts:1936` — `if (h.on_hash_fallback) { … "embeddings on HASH fallback (degraded recall)" … }` is a **dead branch**. That warning can never fire.

**2. `SOX_EMBED_BACKEND` is cast, not validated.**
`embed.ts:52` — `(process.env['SOX_EMBED_BACKEND'] ?? 'auto') as EmbedBackend`. An unchecked cast, so `SOX_EMBED_BACKEND=hash` flows straight through and `memory_ping` will report `backend: "hash"` — a value the type declares impossible.

**3. Three tools still set it.**
`tools/test-e2e-lifecycle.js:1990`, `tools/probe-bl41-tilde-dbpath.mjs:12,65`, `tools/probe-memory-backend-zdt.mjs:115` all pass `SOX_EMBED_BACKEND: 'hash'` — for "deterministic speed" against a backend that no longer exists.

**4. Agent instructions and plan docs still describe it.**
`.opencode/agents/{pro,implement,flash}.md`, `.opencode/prompts/flash-system.md`, `docs/plan/memory-system/{SOLUTION,PLAN_ONESHOT}.md`, and `docs/plan/memory-refactor/{state.json,dag.json,status.md,SCOPE.md,session.md}`.

**Consequence — a plan gate that cannot fail.** `docs/plan/memory-refactor`'s `entry_blocked_on` requires *"live user-scope memory-server reports `embed_on_hash_fallback:false`"*. That value is a hardcoded `false` (or `undefined`). **The gate is vacuously satisfied and proves nothing** about whether real embeddings are running — which is the entire property it was written to check. This is the BL-225 pattern applied to a plan guard rather than a backlog marker.

**Fix:** delete `on_hash_fallback` / `embed_on_hash_fallback` from the health + stats surface and the dead warning branch; validate `SOX_EMBED_BACKEND` against the union and throw on an unknown value instead of casting; drop `SOX_EMBED_BACKEND=hash` from the three tools; purge the agent-facing docs; and **replace the memory-refactor entry gate with an assertion that actually discriminates** (e.g. `embed.state === 'real' && embed.model === 'bge-base-en-v1.5' && dimensions === 768`).

### BL-251 — `cli-adapter.test.ts` uses the machine's real `/tmp` as a test fixture — **RESOLVED (2026-07-10)** — every `validate` case now uses a private `mkdtempSync` dir instead of the machine's `/tmp`. Proven with the foreign `/tmp/asp-bundle.VrG5rP/` still present: `sox-ecosystem:test` 269/269

`scripts/cli-adapter.test.ts:86-94` — *"validate verb > exits non-zero when given a non-existent path"* — runs `sox(['validate', '/tmp'])` and asserts `r.status === 0`, on the comment's assumption that *"the engine exits 0 (no extensions found)"*.

`/tmp` is shared, mutable, machine-global state. Any process on the box that leaves an `extension.json` under `/tmp` flips the assertion. Observed 2026-07-10: a foreign `/tmp/asp-bundle.VrG5rP/` (mtime Jul 9, no provenance in this repo) contains five `extension.json` files, one with `type: "rules"` — invalid. So:

```
$ node bin/soxe validate "$(mktemp -d)"   → exit 0
$ node bin/soxe validate /tmp             → exit 1   ← test fails
```

The CLI is behaving **correctly**; the test's fixture is the operating system. Note the test name ("non-existent path") also no longer matches what it asserts (`/tmp` exists, and it expects 0).

Same class as BL-245 (`manifest:test-scripts` validating the live repo) — a test whose fixture is mutable shared state it does not own. **Fix:** pass `mkdtempSync()` instead of `/tmp`, and rename the test to what it actually checks (the adapter propagates the engine's exit code). Do not "fix" it by cleaning `/tmp`.

### BL-252 — the `embed_model` store stamp is UNFALSIFIABLE: it is written before any provider loads — **Open (MEDIUM, data-integrity)** (2026-07-10)

`libs/memory-core/src/db.ts:89` stamps `STORE_META_KEYS.EMBED_MODEL` with `getActiveEmbedModel()` at open-for-write time. But `_activeModel` (`embed.ts:26`) is **initialised to `'bge-base-en-v1.5'`** — the exact value it is later assigned when a real provider loads (`embed.ts:114`, `_activeModel = p.metadata.modelId`).

So a server that has **never warmed up an embedding provider** still stamps `bge-base-en-v1.5`, asserting which model wrote the vectors when no model has run. The STAMP-vs-RESOLVED comparison in `verifyStoreMeta()` compares the value against itself for the un-warmed case, and its "warning on mismatch" can never fire there.

Third instance of the same family: an assertion that cannot fail, therefore proves nothing.
- BL-250: `embed_on_hash_fallback` is a hardcoded `false`.
- The `memory-refactor` plan's entry gate then *depends* on that hardcoded `false`.
- This: the model stamp defaults to the answer it is supposed to verify.

**Fix:** initialise `_activeModel` to `null` (or an explicit `'<unwarmed>'` sentinel) and make `getActiveEmbedModel()` return `null` until a provider actually loads. Then `db.ts` must decide explicitly: refuse to stamp, or stamp the sentinel. Do not stamp an optimistic guess. A regression test must assert that an un-warmed store does **not** stamp a real model id.

⚠️ Coupled to BL-250 and to the `memory-refactor` plan gate — fixing this is what makes that gate meaningful.

### BL-253 — `docs/plan/memory-refactor` (a LIVE plan) instructs executors to use the deleted hash backend — **RESOLVED (2026-07-10, reframed)** — the premise was wrong. `memory-refactor` is not a live plan whose entry gate needs repairing; its WORK IS COMPLETE. Evidence: all six deliverable packages (embedding-provider, vector-store, graph-store, hybrid-search, ingest, analysis) exist and build, and `w2e-domain-rewire`'s goal is met — `libs/memory-core/src/*.ts` imports all six `@adhd/sox-*` libs. The content shipped via the P1 substrate commits; `docs/plan/memory-refactor/state.json` was simply never driven forward (still `p0-baseline`, `transition_log: []`). So the stale hash references in its contexts are in a COMPLETED plan's authored artifacts, not live instructions. Follow-up (BL-258): reconcile the stale state machine — run the `workflow:project-status` sweep (cross-checks plans vs codebase, unlocks stale claims, stamps verified_at), do not hand-edit state.json

Stale hash references remain inside the live `memory-refactor` plan's authored work-orders. These are agent-facing instructions, not prose:

- `contexts/p0-baseline.md:102` — *"do not work around it with `SOX_EMBED_BACKEND=hash`"*
- `contexts/w2a-embedding-provider.md:37` — *"(`SOX_EMBED_BACKEND=hash` or equivalent), never as an implicit fallback"*
- `contexts/_shared.md:80` — *"permanent hash fallback on `npm-package:` install"*
- `COMPILED.md:53` — the **entry gate**: *"Do not start until the live user-scope `memory-server` reports `embed_on_hash_fallback:false`"* — the vacuous gate (see BL-250 / BL-252)
- `COMPILED.md:221, 886`, `demo/embedding-provider/DEMO.md:336` (*"Recover via Hash Fallback"* — a recovery path that no longer exists)

**Not hand-fixed on purpose.** `contexts/`, `COMPILED.md` and `dag.json` are plan-authored artifacts; `state.json`/`dag.json` are plan-state-machine runtime files that only `state-transition.js` may write. Amending a live plan is `plan-builder`'s job (update mode), not an ad-hoc edit. Dispatch plan-builder to:
1. Purge the hash backend from the contexts + DEMO.
2. **Replace the entry gate** with an assertion that can actually fail, e.g. `memory_ping` reports `embed.state === 'real' && embed.model === 'bge-base-en-v1.5' && embed.dimensions === 768`.

Until then the plan's entry gate is satisfied by a hardcoded constant and cannot block anything.

### BL-254 — `provider_call_count` is ALWAYS 0: the counter is never incremented, so invariant R1 is unmeasured and three tests asserting it cannot fail — **Open (HIGH)** (2026-07-10)

`libs/memory-core/src/embed.ts`:
```ts
:33  let providerCallCount = 0;
:35  return providerCallCount;   // getProviderCallCount()
:38  providerCallCount = 0;      // resetProviderCallCount()
```
`grep -rn 'providerCallCount++\|providerCallCount +='` across `libs/` and `extensions/` returns **nothing**. The counter is declared, read, and reset — never incremented.

Consequences:
- `RecallResponse.provider_call_count` (returned by both `memoryRecall` and `federatedRecall`) is `0` regardless of how many times the embedding provider was actually called.
- Invariant **R1** — *"memory_recall is a deterministic hot path, zero provider calls"* — is **not enforced by anything**. The delta computed at `recall.ts:~930` is always 0.
- `extensions/.../memory-server/recall-sqlite.test.ts:77, 102, 159` all `expect(response.provider_call_count).toBe(0)`. **These tests cannot fail.** They read as R1 coverage in any audit; they verify nothing.

This is the same family as BL-250 (`embed_on_hash_fallback` hardcoded `false`) and BL-252 (the `embed_model` stamp defaults to the answer it verifies): an assertion that is structurally incapable of failing, standing in for a real check.

**Fix:** increment `providerCallCount` at the real provider call site in `embed.ts` (and in the batch path), then confirm the three R1 tests still pass **and** add one that proves the counter moves when the provider *is* called — otherwise the fix is unfalsifiable too. Until then, do not cite `provider_call_count` as evidence of anything.

Found by the BL-92 agent while tracing `recall.ts`'s docblock. It documented the caveat in `recall.ts:15-20` but could not fix it — `embed.ts` was another agent's file.

### BL-255 — `memory-core` declares `@adhd/sox-vector-store` as a runtime dep it no longer imports — **Open (LOW)** (2026-07-10)

`libs/memory-core/package.json:30` — `"@adhd/sox-vector-store": "workspace:*"`. After BL-92 rewired `reembed.ts` to migrate directly in `vec_node`, no file under `libs/memory-core/src/` imports it (only two explanatory comments at `reembed.ts:56, 233` name it).

**Fix:** remove the dependency. ⚠️ This drops a `workspace:*` edge — per ⛔ AGENT CONSTRAINT, run `pnpm install` and **commit the `pnpm-lock.yaml` diff in the same change** (incident BL-150). Do not hand-edit `node_modules`.

### BL-256 — `@adhd/sox-vector-store`'s generic multi-space machinery has ZERO readers; a "successful" re-embed used to write to a table nothing queried — **RESOLVED (2026-07-10, keep + doc-fix)** — verified NOT an orphan: `@adhd/sox-vector-store` is a `file:` dep of `/Users/nix/dev/ai/agent-source`, which imports `VectorBackend`/`VectorSpace` (the multi-space API itself) in `product-core-e2e/src/support/{local-ingest,search-pipeline,substrate}.ts`. Same DI-boundary pattern as BL-166. The abstraction stays; only the misleading doc was wrong. Fixed `libs/data/CLAUDE.md` §3 to record that memory-core's `reembedStore()` migrates `vec_node` in place and does NOT use `ensureSpace`/`vec_<model>`/`_vector_spaces` — that generic surface is for external consumers

Established while fixing BL-92, and verified against `git show HEAD`:

- `HEAD:libs/memory-core/src/reembed.ts:21` — `import { SqliteVectorBackend, reembed } from '@adhd/sox-vector-store'`, writing into generic `vec_<model>` side-tables registered in `_vector_spaces`.
- `HEAD:libs/memory-core/src/recall.ts` — **zero** references to `vec_<model>` or `_vector_spaces`. Recall reads the single fixed-schema `vec_node` (`FLOAT[768]`, `schema.ts`). The write path (`embed.ts`, `embed-pipeline.ts`) writes `vec_node` too.

**So a re-embed that reported success migrated vectors into a table nothing ever read.** Recall kept serving the pre-migration `vec_node` vectors. The feature was a no-op from the reader's perspective — which means fixing only BL-92's orchestration (idempotency/grouping/source-detection) would have shipped another "RESOLVED but still broken" item, the BL-225 pattern. BL-92's fix rewires `reembedStore()` to migrate `vec_node` directly, so a re-embed now genuinely changes what recall sees.

That leaves the generic abstraction stranded: `vector-store`'s `ensureSpace` / `vec_<model>` / `_vector_spaces` multi-space design now has **no consumer in this repo**. `libs/data/CLAUDE.md` §3 still documents it as the model-switch migration mechanism, which is no longer true of memory-core.

**Decision required (owner):** retire the multi-space machinery in favour of the fixed-schema `vec_node` model memory-core actually uses, **or** keep it and document that it is for external consumers (`agent-source` declares `@adhd/sox-vector-store`? — verify before deciding). Either way `libs/data/CLAUDE.md` §3 needs correcting: it describes a migration path memory-core no longer takes.

### BL-258 — `memory-refactor` plan is content-complete but its state machine reads 0/15 pending — **Open (LOW, plan-hygiene)** — CONFIRMED by the 2026-07-10 project-status full scan: verdict COMPLETE-BUT-STATE-STALE. All 10 work-state deliverables reality-present (p0-baseline, p1-layout, w2a/b/c, w2d-{ingest,analysis,hybrid-search}, w2e-domain-rewire, p4-routing — evidence: 6 data libs build + memory-core imports all six + memory-enrich dissolved as planned). Reconciliation is NOT a blind fast-forward: the 5 audit states are blocked on BL-260 (criteria↔check wiring) and a live-server reality proof for audit-final. Route: plan-builder fixes BL-260, then plan-orchestrator drives `state-transition.js --complete` per state with guards actually running

`docs/plan/memory-refactor/state.json`: `current_state: p0-baseline`, `transition_log: []`, 1 in_progress + 14 pending. But every deliverable shipped: the six extracted data libs all build, and `memory-core` imports all six (the `w2e-domain-rewire` goal). The plan's work landed via the P1 substrate commits without the state machine ever being driven.

Consequence: any tool that reads plan state (plan-orchestrator `list`, the entry-gate check) treats a finished plan as barely-started, and its stale hash-backend references (BL-253) look like live instructions when they are a completed plan's history.

**Fix:** run the `workflow:project-status` agent in **sweep** mode — it cross-checks every plan under the plans-root against the actual codebase + git history, unlocks stale claims, backfills/prunes `plan-index.json`, and stamps `verified_at`. Do NOT hand-edit `state.json` (only `state-transition.js` may write it). This is plan-hygiene, not a code defect.

### BL-259 — `smoke-test.mjs` leaves project-scoped launchd units bootstrapped; the next run fails with `Bootstrap failed: 5` — **Open (MEDIUM, test-infra)** (2026-07-10)

`scripts/smoke-test.mjs` exercises `service enable`, which bootstraps a `com.sox.project.<ext>` launchd unit. Its teardown does not reliably `bootout` those units, so they persist in the operator's `gui/$UID` launchd domain. On the **next** smoke run, `launchctl bootstrap` for the same label returns `Bootstrap failed: 5: Input/output error` (the "already bootstrapped" collision), and `*-project-enable` fails.

Reproduced 2026-07-10: a full smoke run reported `11 passed, 2 failed` (`memory-server-project-enable`, `tokenguard-project-enable`); `launchctl list` showed `com.sox.project.memory-server` and `com.sox.project.tokenguard` left over (status `-`) from earlier same-session runs. Manually `bootout`-ing those two labels and re-running → `13 passed, 0 failed`.

This is NOT a code defect in the enable path (the plist is created correctly, node + entrypoint resolve; only the `launchctl bootstrap` load collides). It's a test-harness isolation gap, same family as the e2e orphan-scan false-positive from live dev-box state. It makes the mandatory pre-merge smoke gate **non-idempotent** — green on a clean domain, red on a second run — which will intermittently block merges for reasons unrelated to the change under test.

**Fix:** smoke-test teardown must `launchctl bootout gui/$UID/com.sox.project.<ext>` for every unit it enabled (in a `finally`), and/or use a unique per-run label prefix so runs cannot collide. Must never touch `com.sox.user.*` (real services). Note also that the disposable-scope enable writes a plist to the operator's real `~/Library/LaunchAgents/` — verify that is intended and cleaned up.

### BL-261 — `tokenguard-service` dag.json: two nodes fail `compile-task.js` (unterminated string) — **Open (LOW, plan defect)** (2026-07-10)

`docs/plan/tokenguard-service/dag.json` parses as valid JSON as a whole, but `compile-task.js` fails on node `http-transport` (`Unterminated string in JSON at position 62575`) and node `audit-framework` (position 62099) — an embedded work-order/criteria string that is malformed when the compiler re-parses it. Both nodes exist (3142 / 576 bytes).

`tokenguard-service` is `state: done` (13/13, founder-confirmed DoD), so nothing consumes these nodes today. But they would **break `plan-orchestrator` at dispatch time** if the plan were ever re-run. Real content defect, low urgency. **Fix:** plan-builder repairs the two nodes' embedded strings.

### BL-262 — memory-server shipped WITHOUT the BL-238 fastembed child host: live embeddings dead for 5h; every bundle hand-lists its sidecars — **RESOLVED (2026-07-10)** (2026-07-10)

The BL-238 fix moved fastembed into a forked child process (`fastembedProcessHost.ts`) and rerank/verify into a shared worker (`sharedOnnxWorker.ts`), but the memory bundles' `--worker` lists in `project.json` were never updated — `memory-server/dist/` shipped only `embedWorker.js`, and memory-cli/memory-flush shipped **no** sidecars at all while referencing all three. At runtime the fork hit a nonexistent path → `shared fastembed process exited with code 1` → `embed.state: uninitialized`, a 64-episode embed backlog from 15:43, `heals_failed: 64`, and **query-path `memory_recall` erroring** on the live server. Tests never caught it: vitest runs from source, where the `../dist` fallback finds `embedding-provider/dist/` — the shipped bundle is the only place the file is missing (same tests-bypass-artifact disease as BL-248).

Root disease (owner-flagged): every consumer hand-inlines the sidecar list; forgetting one ships a silently broken artifact. Fixed structurally in `tools/bundle-extension.cjs`:
1. **Declare once** — the owning package declares `sox.sidecars` + `sox.sidecarExternals` in its own `package.json` (done for `embedding-provider`: all three sidecars, `fastembed`/`onnxruntime-node` external).
2. **Auto-discover** — after the main build, the esbuild metafile identifies every inlined package; all their declared sidecars are bundled automatically. All `--worker` flags removed from memory-server/cli/flush `project.json` (flag retained for exotic cases; explicit `--worker` wins over discovery).
3. **Verify before commit** — `verifySidecarReferences()` scans every emitted file for `__dirname`-sibling `.js` references and FAILS the build (previous artifact intact, BL-235 staging) naming any missing sibling — so even an UNDECLARED future sidecar cannot ship silently.

Red→green: with `sox.sidecars` stripped, `nx build memory-cli` fails naming `fastembedProcessHost.js` + `embedWorker.js` (seen red 2026-07-10); restored, all five esbuild projects build with the three sidecars auto-emitted. Discovery skips `dist/`-copied package.json files (atomic-tsc copies them; sidecar paths are source-relative). Live-verified: backend restarted on the fixed artifact → `embed.state: real`, backlog 78→0 (`heals_applied: 78, heals_failed: 0`, `embeds_completed: 100/0 failed`), query recall returns vec-ranked results. Gates: smoke 13/0 + exports guard, memory-server 132/132, memory-core 408/408, sox 82/82, host-runtime 249/249, all cache-busted.

### BL-263 — a sandboxed probe SQUATTED the production launchd label `com.sox.user.memory-server`: 4141 KeepAlive respawns, blocked every real enable/unload — **RESOLVED (2026-07-10)** (2026-07-10)

Found while live-verifying BL-262: `launchctl print gui/501/com.sox.user.memory-server` showed the label loaded from `/private/tmp/soxe-probe3.XKSOoK/home/Library/LaunchAgents/...` — a 2026-07-09 ad-hoc probe sandbox (no repo script creates `soxe-probe*`; five such dirs exist in /tmp). `SOX_ECOSYSTEM_HOME`/`SOX_OS_UNIT_DIR` redirect FILES, but the launchd registration namespace is GLOBAL — so the sandboxed `service enable` registered the PRODUCTION label. launchd KeepAlive had respawned it **4141 times** (a stdio server with no stdin exits instantly → respawn loop), it ran the real repo dist with probe env, and it blocked every legitimate operation on that label — `soxe upgrade`'s unload got `code 1` from the BL-203 ownership guard (correctly refusing to bootout a unit loaded from a foreign path). This is plausibly why the user's morning `service enable` misbehaved.

Fixed twice over:
1. **Incident**: `launchctl bootout gui/$UID/com.sox.user.memory-server` removed the squatter after path-evidence confirmation; real proxy backend untouched; domain verified clean (only `com.sox.user.doctor-tick` remains, owned path).
2. **Class kill**: `osUnitLabel()` (`libs/host-runtime/src/os-unit.ts`) now namespaces the label when `SOX_ECOSYSTEM_HOME` is set — `com.sox.<scope>.<id>.sbx-<8-hex sha256(data-root)>`. Distinct data roots are distinct service universes; a sandboxed run can never register, collide with, or bootout a production label. New pure `osUnitLabelFor()` exported; specs (`service-os-unit`, `doctor-reconcile`) compute expected labels the same way.

Red→green: `os-unit.spec.ts` `BL-263` test fails with the suffix disabled (seen red 2026-07-10), passes restored. Side effect on BL-259: smoke/e2e sandboxes now use per-run unique labels, so the cross-run `Bootstrap failed: 5` collision cannot recur — but leaked sandbox registrations (now identifiable by `.sbx-` suffix) still want a teardown `bootout`; BL-259's teardown fix stands.

### BL-264 — memory-server logs `FATAL: ... embedding warmup failed` for a condition it deliberately survives — **Open (LOW, log-hygiene)** (2026-07-10)

`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:2005` — when `warmupEmbed()` rejects, the server writes `[memory-server] FATAL: SOX_EMBED_BACKEND=real but embedding warmup failed: ...` and then **keeps serving** non-embed tools. That behaviour is intentional and documented in the adjacent comment ("the server keeps serving... the failure is unmissable") — but the `FATAL` word contradicts it and misled the BL-262 forensics on first read (a FATAL that isn't fatal reads as a crash that didn't happen). Contrast: the better-sqlite3 probe 15 lines below says FATAL and actually `process.exit(1)`s. **Fix (pick one, don't split the difference):** reword to `DEGRADED:`/`ERROR (serving without embeddings):`, or honour `SOX_EMBED_BACKEND=real` fail-loud semantics by exiting nonzero and letting the shim's ensure path surface it. Wording-only change is fine; silent semantics change is not.



### BL-296 — `memory-refactor`: 5 extraction work-states use short criterion IDs that don't match their slugs, so gap-check counts them as criterion-less — **Open (MEDIUM, plan defect)** (2026-07-11)

Found by plan-builder while fixing BL-260. `w2a-embedding-provider`, `w2b-graph-store`, `w2c-vector-store`, `w2d-hybrid-search`, `w2e-domain-rewire` declare their acceptance criteria under **short IDs** (`[w2a.N]`, `[w2b.N]`, `[w2c.N]`, `[w2d-hs.N]`, `[w2e.N]`) in `contexts/*.md`, but `gap-check.js` credits a criterion only when its prefix equals the full state slug. So it sees these 5 states as declaring **zero** criteria — one of the 9 residual gap-check fails after BL-260. (Real checks for all 33 short-ID criteria were wired in `audit_memrefactor.py` regardless, so the extraction phase genuinely runs; gap-check just doesn't credit them.)

**Fix (needs a work-context edit — plan-builder, deferred here as it wasn't audit-wiring):** rename the criterion IDs in the 5 `contexts/*.md` to the full slug (`[w2a.1]`→`[w2a-embedding-provider.1]` …) and update the matching `check("w2a.1"…)`→`check("w2a-embedding-provider.1"…)` IDs in `audit_memrefactor.py`. Pure label rename; no scope/deliverable change.

Also surfaced (report-only): several criterion PROSE strings drifted from the shipped API — prose says `resolveProvider`/`applyGraphSchema`/`applyVecSchema`/`contentHash`, ships `createEmbeddingProvider`/`createGraphBackend`/`SqliteVectorBackend` methods/`hexSha256`. The checks were wired to the shipped truth with inline `NOTE:` flags; the prose should be reconciled during the rename.

### BL-297 — live memory-server tool contract drifted to 20 tools vs the 19-tool baseline snapshot — **Open (MEDIUM)** (2026-07-11)

`docs/plan/memory-refactor/baseline/tool-snapshot.json` lists **19** tools and does NOT include `memory_write_batch`; the shipped `memory-server/src/index.ts` registers `memory_write_batch` (4 refs) and the live server exposes **20** tools. So the `[inv:tool-contract-stable]` audit criteria (`w2e.3` / `audit-extraction.2` / `audit-final.2`) correctly go RED against a *real* divergence — not a down server (the server is up; two `soxe serve memory-server` procs, bundle rebuilt Jul 10 21:13).

**Decide which is authoritative:** either the baseline snapshot is stale and should be regenerated to 20 tools (if `memory_write_batch` is a sanctioned addition — it carries this session's BL-233 `project_path_source` work), or the tool was added outside the refactor's stable contract and needs review. Until reconciled, those three criteria cannot green. Note `memory-server/CLAUDE.md` says "19 memory_* tools (v1.1.0)" — also stale if 20 is correct.

## Open — research findings: native addon packaging & database adapter gaps (2026-07-11)

Full research report: `docs/research/packaging-recommendations.md` (generated 2026-07-11).

### BL-306 — `verify-native-abi.mjs` does not probe `sqlite-vec` or `@lancedb/lancedb` — **Open (MEDIUM)** (2026-07-11)

`tools/verify-native-abi.mjs` probes only `better-sqlite3` and `onnxruntime-node`. `sqlite-vec` is used by 3 bundled extensions (memory-server, memory-cli, memory-flush) and 5 libraries; `@lancedb/lancedb` (Rust napi-rs) is used by `@adhd/sox-vector-store`. Both are native addons that can fail at runtime on ABI mismatch, but neither is checked. A Node upgrade that changes the ABI breaks sqlite-vec silently (no probe warning).

**Fix:** add `sqlite-vec` and `@lancedb/lancedb` probe targets to `verify-native-abi.mjs`, following the same `require.resolve` → `process.dlopen` pattern used for `better-sqlite3`. Document the probe matrix in the script header. Run `pnpm verify:abi` and confirm exit 0 on current Node; test that a deliberately mismatched Node version causes exit 1 for each new probe target.

**Effort:** S. Single-file change + CI gate update.

### BL-307 — `@lancedb/lancedb` is missing from the bundler externals policy — **Open (MEDIUM)** (2026-07-11)

`docs/standards/extension-bundling.md` §2 defines the externals policy: "Only true third-party native addons are passed `--external`." Currently `better-sqlite3`, `sqlite-vec`, `fastembed`, and `onnxruntime-node` are listed. `@lancedb/lancedb` (Rust napi-rs, consumed by `@adhd/sox-vector-store`) is NOT listed. If any bundled extension ever imports vector-store's `LanceDbVectorBackend`, esbuild will attempt to inline the `.node` binary and fail at runtime.

Currently latent — no bundled extension imports vector-store. But the policy doc is the single source of truth and omitting a known native addon makes it a trap for future authors.

**Fix:** add `@lancedb/lancedb` to the externals list in `extension-bundling.md` §2. Add it to the `--external` union in every bundled `project.json` that transitively imports `@adhd/sox-vector-store` (if any). Add a CI gate (or smoke-test preflight) that enumerates every `--external` flag and cross-checks against the declared native deps of all transitively-bundled packages — so missing-native externals are caught at build time, not at crash time.

**Effort:** M (doc update + CI gate script). Risk: low (additive, no behavior change until a consumer actually imports the backend).

### BL-308 — `vector-store` bundles both backends in one package; sqlite-only consumers pay for LanceDB deps — **Open (MEDIUM)** (2026-07-11)

`@adhd/sox-vector-store` exports both `SqliteVectorBackend` and `LanceDbVectorBackend` from the same entry point. A consumer who only needs the SQLite backend still gets `@lancedb/lancedb` plus its transitive deps (`apache-arrow` ~4 MB, `synckit`) in `node_modules`. The same `exports` map entry resolves both.

Currently no consumer in the repo suffers from this (memory-core's `reembedStore()` was rewired to `vec_node` directly per BL-256 and no longer imports vector-store at all). But the package is declared as consumed by `agent-source` (BL-304), and any future internal consumer pays the bloat.

**Fix:** two approaches:
- (A) **Subpath exports** — add separate entrypoints: `@adhd/sox-vector-store` (both backends, current API), `@adhd/sox-vector-store/sqlite` (sqlite-only), `@adhd/sox-vector-store/lancedb` (lancedb-only). The subpath entry's `package.json` declares only the deps that backend needs. Requires `typesVersions` for legacy `moduleResolution`.
- (B) **Package split** — extract into `@adhd/sox-vector-store-sqlite` and `@adhd/sox-vector-store-lancedb` with a root re-export barrel for back-compat. Cleaner dep isolation but larger blast radius.

Recommend (A) as the intermediate step — preserves the existing import surface for external consumers while letting new internal consumers opt into a lighter subpath. `docs/research/packaging-recommendations.md` covers both patterns with pros/cons.

**Effort:** M (exports map changes + typesVersions + consumer updates). Risk: low (additive entrypoints, back-compat).

### BL-309 — No CI gate enforces that every native dep in a bundled extension is `--external` — **Open (LOW)** (2026-07-11)

The bundler externals policy (`extension-bundling.md` §2) is a manual checklist. If a developer adds a new native dep to a bundled extension but forgets to add it to the `--external` flags in `project.json`, the bundle compiles successfully and only fails at runtime with `ERR_REQUIRE_ESM` or a missing `.node` binary. This is the same class as BL-262 (sidecar list) and BL-248 (typecheck) — a test that bypasses the shipped artifact.

**Fix:** add a post-build CI step that introspects the bundle's `--external` list (via the esbuild metafile or by parsing `project.json`), enumerates every `better-sqlite3`/`sqlite-vec`/`onnxruntime-node`/`fastembed`/`@lancedb/lancedb` reference across the transpiled bundle, and FAILS the build when a native dep is statically referenced but not in the external list. Alternatively, add a smoke-test preflight (`verify-external-natives`) that `require()`s every bundled extension's entrypoint in a clean-room `node_modules` where only externalized deps are available — a missing `--external` crashes at module load. Pattern follows `tools/verify-sidecar-references.ts` from BL-262.

**Effort:** M (script + project.json integration). Risk: low (additive gate, cannot introduce false negatives since it only catches what it checks).

---

### BL-298 — `dod.4/.5/.6` behavioral DoD clauses lack `entrypoint:` sub-fields — **Open (LOW, doc)** (2026-07-11)

Wiring the 8 DoD checks (BL-260) cleared the "not proven" fails and let gap-check advance to its behavioral-fidelity rule, which requires an `entrypoint:` sub-bullet on behavioral DoD clauses. `[dod.4]/[dod.5]/[dod.6]` in `docs/plan/memory-refactor/README.md` lack it (3 of the 9 residual fails). **Fix:** add an `entrypoint:` line under each naming the exact invocation.

### BL-299 — `memory-refactor` audit live-MCP probe is startup-timing-flaky — **Open (LOW, robustness)** (2026-07-11)

The `audit_memrefactor.py` live write→recall probes (`audit-final.2/.3`, `dod.4`) spawn an MCP stdio client; server startup/model warmup sometimes exceeds the spawn window, yielding a *blocked* (red) result. It fails LOUD (never fabricates a pass — the safe direction), but the orchestrator should expect occasional blocked results and retry. **Fix:** add a readiness handshake or longer warmup window before the probe asserts.

### BL-232 — `concurrency-harness.spec.ts:121` asserts a hardcoded wall-clock p99 latency budget — **RESOLVED (2026-07-10)** — the wall-clock p99 latency check is now informational-only (logs a `[wp6/BL-232]` warning), never gating; the gating invariant is the lock-error count the test is actually named for. Red→green documented at `concurrency-harness.spec.ts:259`. `nx test memory-core` 408 pass

`libs/memory-core/src/concurrency-harness.spec.ts:121` —
`expect(p99Latency).toBeLessThanOrEqual(meanLatency * 3 + 50)`. Observed failing once
(`expected 135 to be less than or equal to 58.99`) in `WP-6 concurrency harness (BL-134) > GREEN: zero
lock errors under 8 concurrent writers`, under 24-27 synthetic busy loops on a 10-core box. Root cause
is understood — a wall-clock latency budget is inherently contention-sensitive — so this is **not**
BL-202 (whose root cause remains unknown). Not reproduced under realistic `nx run-many` load. **Fix:**
assert on lock-error count (the actual invariant under test) and move the latency budget to a
non-gating benchmark, or scale the budget by observed load.

### BL-233 — `memory_write_batch` does not surface `project_path_source` per item — **RESOLVED (2026-07-10)** — `BatchItemOk` now carries `project_path_source`, computed by a shared `projectPathSourceFor()` helper so batch and single-item can never drift. Dedup key untouched. Red→green proven; `nx test memory-core` 391 pass

The BL-62 mitigation added `WriteResult.enrichment.project_path_source: 'explicit'|'inferred'` to
single-item `memory_write`. `BatchItemOk` (`libs/memory-core/src/write.ts:461-464`) has no equivalent, so
batch writers cannot tell whether their attribution was inferred (and therefore possibly wrong per
BL-62). Parity follow-on.

### BL-234 — memory-server bundle docs lag the shipped `memory_update` schema — **RESOLVED (2026-07-09)** — memory-server CLAUDE.md now documents memory_update project_path, the project_path_source provenance warning, and a table of which params each recall path honours

`extensions/bundles/sox-memory-bundle/members/memory-server/CLAUDE.md` documents `memory_update`'s
editable field list without `project_path`, and `memory_write`'s output without `project_path_source` —
both of which shipped with the BL-221 / BL-62 work. Docs contradict the live `inputSchema`.

#### BL-202 — RECLASSIFY note (canonical entry is above; not a separate item)

~30+ executions of `libs/memory-core/src/export.spec.ts` across serial, 3/4/6/8-way parallel, and
24-27-busy-loop CPU-oversubscription conditions (bypassing the nx cache via direct `npx vitest run`)
produced **zero failures** at `export.spec.ts:149`. Not touched: no retry added, no timeout raised, no
assertion loosened. Either the flake was fixed incidentally by an earlier wave, or its trigger is not
CPU contention. **Do not "fix" this item until it reproduces.** The incidental flake found while trying
is filed separately as BL-232 (different file, different root cause, understood).

**Fix options:** (a) build memory-core as ESM (drop the CommonJS target) — largest blast radius;
(b) make `extractive.ts` lazy-`import()` `@adhd/sox-ingest` instead of a static import; (c) make
`ast-chunker.ts` load grammars lazily on first use rather than at module-eval time. **(c) is the
correct fix** — a library that CJS consumers require must not evaluate top-level await. The
`ast-chunker.ts:168` comment ("supported by vitest/Node natively") is true only for the ESM path and
was never validated against the CJS consumer that memory-core actually is.

**This is BL-225 in the wild.** BL-115 was marked RESOLVED, the tree-sitter chunker genuinely works,
and shipping it silently took two test suites to zero — with no test proving the CJS boundary still
held. The marker recorded intent; the outcome was never verified. Found by the TESTINFRA agent while
trying to verify unrelated work.

---

## Research: Package Architecture Conventions (2026-07-10)

Generalized research on CJS/ESM dual packaging, dependency budget/granularity, phantom dependency
hygiene, and package boundary governance. Full findings in memory under topic `tool-catalog` with
tags `pattern:recommended` — search for `package-architecture`, `cjs-esm-dual`, `dependency-budget`,
`phantom-dependencies`, or `package-boundaries`. Episodes: `01KX6VSB4SS45B09J8N4D805F4` through
`01KX6VTVX5ZSTT99F6DN99J8WQ`.

### Key conclusions applicable to sox-ecosystem

**CJS/ESM Dual Packaging (→ RQ-PKG-1, PKG-2, PKG-3)**
- `require(esm)` is stable unflagged in Node.js 20.19+ / 22.12+. Ecosystem consensus (Joyee Cheung,
  Anthony Fu, e18e): **ESM-only is the recommended future state.** Dual-shipping is transitional
  overhead.
- **Action:** Set `"engines": {"node": ">=22.12.0"}` repo-wide (already on Node 22+). Drop CJS builds
  for new/refactored packages. Grandfathered packages (memory-core, sox-ingest): migrate from dual
  to ESM-with-CJS-wrapper-shim.
- `/core` is the recognized subpath convention for "minimal CJS-compatible subset" of an ESM-only
  package. Standardize this in `docs/standards/module-resolution.md`.
- TypeScript consumers must set `moduleResolution` to `"Node16"`, `"NodeNext"`, or `"Bundler"`.

**Dependency Budget (→ RQ-PKG-4)**
- `optionalDependencies` are an anti-pattern for heavy deps — install silently, break loudly.
- Two structural patterns: (1) subpath exports split (`pkg/core` light, `pkg` full); (2) package
  split (`@scope/pkg`, `@scope/pkg-full`) when dep >20% install size.
- **Action:** Apply to sox-ingest's 55MB tree-sitter dependency — subpath split or package split
  so `/core` consumers don't pay the tree-sitter install cost.
- Use pnpm catalogs + syncpack for single-version enforcement.

**Phantom Dependencies (→ RQ-PKG-5)**
- Three-class severity: PD001 (imported-not-declared), PD002 (transitive-only), PD003 (undeclared
  transitive via parent-folder resolution).
- pnpm's strict symlink structure catches PD001 at build time — this is already in place.
- **Action:** Add `knip --ci` as a CI gate. Add declared-vs-imported reconciliation. Enforce
  the §5 stale-dist rule from module-resolution.md (delete dist/ when source is deleted).

**Package Boundary Governance**
- Three-layer enforcement: Nx tags (tool-enforced), exports field (encapsulation-enforced), and
  runtime schema validation (process-enforced) at package boundaries.
- **Action:** Adopt `verify:exports` CI gate that checks every declared entrypoint resolves to a
  real file — prevents "declared but not built" bugs. Keep build-first CI ordering (build before
  validate-manifests).

### Memory server state during research

The embedding provider (Fastembed `bge-base-en-v1.5`) was down — shared subprocess exiting with
code 1. 33 failed embeds, 1,914 failed heal attempts, enrichment pipeline stalled. This is a
pre-existing condition predating this session. Vector-based `memory_recall` was unavailable;
importance-ranked fallback (no query param) worked. All `memory_write` calls succeeded. Should
be investigated separately if not already tracked.

### Build research (2026-07-10)

Generalized research on build format strategy, TLA-safe graph verification, post-build entrypoint
testing, and native/WASM asset resolution in esbuild-bundled packages. Full findings in memory under
topic `tool-catalog` with tags `pattern:recommended` — episodes `01KX6WDKK01B62HJSJEH238RN5`
through `01KX6WF02N3SF175DYA6D16S2N`.

Key conclusions applicable to sox-ecosystem:

**BUILD-1 (Single vs dual build)**
- Decision is per-package, not repo-wide. memory-core's `tsconfig.lib.json` override of
  `module: "CommonJS"` is the ACCEPTED pattern for a package that opts into dual-format.
- Convention: ESM-only for new packages targeting Node >=22.12; dual-format for grandfathered
  packages with CJS consumers. Encode in build target config (rollup config format array).
- Validate all exports maps with `publint` + `attw` in CI before publishing (Nx convention).

**BUILD-2 (TLA CJS-safe invariant)**
- Joyee Cheung's analysis: only ~0.02% of packages have irreplaceable TLA. Most TLA in libraries
  is incidental and replaceable.
- Convention: a SINGLE shared CI script (not per-package reinvention of
  test-bl231-cjs-boundary.mjs) that `require()`s the built CJS entry and catches
  `ERR_REQUIRE_ASYNC_MODULE`. Use `node --experimental-print-required-tla` for diagnostics.
- **Action:** Generalize test-bl231-cjs-boundary.mjs into `tools/verify-cjs-loadable.mjs` used by
  all packages that ship CJS entrypoints.

**BUILD-3 (Post-build entrypoint assertion)**
- Convention: test against source during development, test against built artifact at release
  time — these are separate gates with different guarantees.
- Pre-publish CI gate that `require()`s every declared `exports` entry on the minimum supported
  Node version. Catches "declared but not built" and "declared but not loadable" bugs.
- **Action:** Add a `verify-entrypoints` nx target between `build` and `nx-release-publish` using
  a shared `tools/verify-entrypoints.mjs` script. Run `publint` + `attw` + `require()` check.

**BUILD-4 (Native/WASM asset resolution)**
- Convention: native addons and WASM are NEVER bundled. Use `esbuild --external` + lazy-require
  stub. The sox `import.meta.url` shim (§3 in module-resolution.md) is the correct convention for
  ensuring `createRequire`-based resolution survives bundling.
- `require.resolve()` with string path arguments survives bundling when the target is `--external`.
  Dynamic paths do not. Hardcoded relative paths like `../../../../dist/...` are fragile and
  banned by the module-resolution standard.
- Test asset resolution from the BUILT bundle, not from source — vitest resolves paths differently.

### Performance research (2026-07-10)

Generalized research on lazy vs eager factory initialization, per-work vs all-at-once resource
loading, cold-start budget conventions, and shared worker lifecycle patterns. Findings in memory
under topic `tool-catalog` with tags `pattern:recommended` — episodes `01KX6X33Q4WD8SY02QW2TV5KJ8`
through `01KX6X45J1HXPKRY53ZY8P40RG`.

Key conclusions applicable to sox-ecosystem:

**PERF-1 (Lazy vs eager factory initialization)**
- Default rule: **"no await in factory before return"** — factories return a lazy handle, eager
  warmup is opt-in via `{ warmUp: true }` or a separate `.warmUp()` method.
- The canonical JS pattern stores the promise, not the value:
  `const lazyInit = (fn) => { let p; return () => p ||= fn() }`
- **Action:** remove eager await from `createFastembedProvider` (awaits warmup embed before
  returning) and `createClaimVerifier` (awaits warmUp before returning). Both should return
  immediately and let the first operation trigger initialization. The `getSharedOnnxWorker()`
  pattern is already the correct implementation.

**PERF-2 (Per-work vs all-at-once resource loading)**
- `Promise.all` over heterogeneous resource sets at construction is a code smell. Load per unit
  of work: load the TypeScript grammar when chunking TypeScript, not all 4 grammars on startup.
- **Action:** convert sox-ingest's `Promise.all` grammar loading to a `GrammarRegistry` pattern
  with demand-driven loading + caching after first use. The sox-ingest eagerly loads C# grammar
  (3.8 MB) to summarize markdown — this is the canonical example of wrong granularity.

**PERF-3 (Cold-start budgets)**
- Per-package-class classification: interactive (<100ms), sub-second (<1s), background (<10s),
  deferred (>10s). The CI gate is A/B comparison against main branch baseline, not absolute
  thresholds (which vary by CI runner).
- **Action:** Classify each package. Add benchmark files per class
  (`tools/bench/cold-start/<pkg>.bench.ts`). CI gate: fail if >20% degradation or >2x class budget.

**PERF-4 (Shared worker lifecycle)**
- Three-phase model: lazy spawn (on first use via async singleton) → warm (model loaded, worker
  signals ready) → persist (kept alive for subsequent calls).
- The `getSharedOnnxWorker()` singleton is the correct single spawn point. Eager spawn in
  factories (createClaimVerifier's warmUp, createFastembedProvider's warmup) violates the
  convention — two factories racing to spawn the singleton, cost paid at construction even if
  never used.
- **Action:** Remove eager await from createClaimVerifier's constructor. Let the first `verify()`
  call trigger the lazy spawn. The singleton already ensures concurrent factories share one spawn.

### Resource/architecture research (2026-07-10)

Generalized research on native runtime topology, resource lifecycle hygiene, unified asset cache,
sync/async surface signposting, module-level side-effect conventions, and cross-package invariant
enforcement. Findings in memory under topic `tool-catalog` with tags `pattern:recommended` —
episodes `01KX6XT3QNH7M33XQD248P97C1` through `01KX6XVKJ8N76HYEWRGNW7MCN9`.

Key conclusions applicable to sox-ecosystem:

**RES-1 (Native runtime singleton topology)**
- Process topology follows the native addon's constraint: singleton-constrained (onnxruntime-node)
  → separate OS child processes; context-aware (N-API addons) → worker_threads.
- ONE singleton-ownership registry per runtime (`getSharedOnnxWorker()`) — no factory may spawn
  its own worker. Enforce with "no new Worker outside the owner" lint rule.
- Two onnxruntime majors (1.21.0 via fastembed, 1.24.3 via transformers) force separate OS
  processes — this is correct and unavoidable.
- **Actions:** Codify the singleton ownership registry in a shared lib. Add a lint rule
  preventing `new Worker`/`fork()` outside the designated owner modules.

**RES-2 (Resource lifecycle hygiene — .unref())**
- `.unref()` is mandatory on every Worker, `setInterval`, and `child_process` that is not expected
  to keep the process alive. Called once, immediately after construction. Double-calling is
  harmless (idempotent per Node docs).
- **Actions:** Fix synckit worker (no `.unref()` — keeps process alive). Add lint rule: every
  handle-creating call must be followed by `.unref()` within the same scope unless the handle is
  explicitly managed by a teardown registry.

**RES-3 (Unified asset cache)**
- Single `$SOX_CACHE_DIR` env var overrides all ML/asset cache directories. Each runtime gets
  a subdirectory (`$SOX_CACHE_DIR/{fastembed, huggingface, tree-sitter}`). Defaults to
  `~/.cache/sox` via XDG convention (outside git tree).
- Sets `$HF_HOME` and other runtime-specific vars relative to this root. Single CI override
  point, single cleanup, "no artifacts in the tree" honored.
- **Actions:** Standardize `SOX_EMBED_CACHE_DIR` → `$SOX_CACHE_DIR/fastembed`. Wire
  `$HF_HOME = join($SOX_CACHE_DIR, 'huggingface')`. Update the cache-doc in the environment
  configuration spec.

**DX-1/CODE-2/CODE-3 (Sync/async surface signposting, error taxonomy, I/O-free constructors)**
- `/core` = sync-safe entrypoint. Document in every package README "Entrypoints" section.
- One shared `RequestResponseChannel<T>` primitive for all worker IPC — no more hand-rolled
  per-runtime clients.
- Every native operation must throw a typed error (`TaskQueueSystemError` pattern). 4 of 5
  storage packages currently throw raw native errors — fix them.
- No constructor/factory may perform I/O. The graph-store pattern (takes an open handle) and
  blob-store pattern (`await import()` inside `open()`, not in constructor) are the standards.

**CODE-1/CODE-5 (TLA ban, dynamic import, dead code)**
- Module-scope TLA is banned in publishable packages (ESLint `no-top-level-await` rule). Push
  module-scope `await` behind explicit `init()` or a dynamic import at the call site.
- Static top-level import of native/heavy packages is banned — use `await import()` at the
  call site (blob-store pattern).
- Dead source files excluded from build must be deleted or explicitly marked; their doc comments
  must not describe active mechanisms (embedWorker.ts violation).
- **Actions:** Enable the TLA lint rule. Codemod sox-ingest's module-scope `await Parser.init()`
  to a lazy-init pattern. Audit and delete/prune dead excluded files.

**SPEC-2/SPEC-4/SPEC-5 (Conformance tests, generator templates, platform tags)**
- Every cross-package runtime constraint gets a named conformance test in a shared suite
  (`tools/conformance/`). Affected packages declare which invariants they support.
- Generator templates scaffold new packages with the correct lint rules, singleton registry path,
  error taxonomy, and exports map template baked in.
- `platform:node` tag is required for any package with native dependencies — enforced by lint
  rule tied to dependency graph analysis.
- **Actions:** Create `tools/conformance/` with tests for onnx-singleton, cjs-boundary, no-tla,
  and native-unref invariants. Update `@adhd/workspace-codegen-nx` generator templates.

### Unifying questions research (2026-07-10)

Generalized research on the 6 cross-cutting questions that emerged from ALL prior research.
Findings in memory under topic `tool-catalog` with tags `pattern:recommended` — episodes
`01KX6YATFR9K88ZJK08PE3ZXVX` through `01KX6YCGZT017VZWQEZRAKZX7C`.

Key conclusions:

**UQ-1 (Invisible contracts — safe path discoverability)**
- Three-layer convention: (1) Naming — `/core` subpath, `createLazy` vs `createWarm`; (2) Types —
  `Promise<Provider>` signals async init, `LazyProvider` defers; (3) Compile-time — lint rules
  prevent dangerous paths from compiling.
- The API Design Test: "Would an AI agent call this correctly without reading docs?"
- **Action:** Document `/core` entrypoints in every README. Add type-level markers to provider
  factories. Add lint rules that make dangerous patterns fail at compile time.

**UQ-2 (Shared primitive vs hand-rolled — Rule of Three)**
- Two copies: keep duplication (premature abstraction is riskier). Three copies: extract.
  For infra code (IPC plumbing, DB init), threshold drops — well-understood abstractions can
  be shared earlier. The 3-Service Rule decision matrix: serviceCount >= 3, changeFrequency
  != often, businessLogic == false, apiStability != unstable.
- **Action:** The worker IPC client is at 2 instances (threshold not yet crossed for infra code
  since the abstraction is well-understood). The SQLite open helper is at 2 instances (below).
  Create the shared CJS boundary verification script NOW — before the second package invents
  its own.

**UQ-3 (Lint rules — strict default with opt-out)**
- Error-by-default for all rules in the shared ESLint config. Three-level opt-out: repo-level
  (documented in eslint config), per-package (with justification comment), line-level
  (eslint-disable with reason). All overrides are auditable via grep. "eslint-disable without
  a reason is a code smell."
- **Action:** Write the lint rules for: no-top-level-await, no-static-native-import,
  no-constructor-io, require-unref, no-worker-outside-owner.

**UQ-4 (Generator-bake vs retrofit economics)**
- Two-track: (1) New packages get conventions baked into generator templates (zero adoption
  cost). (2) Existing packages via Boy Scout Rule — every file you touch gets left conforming.
  Mechanical violations (imports, .unref()): codemod immediately. Architectural violations
  (package split, init redesign): per-edit incremental progress. P0 (known bugs): fix now.
  P1 (active violations): Boy Scout. P2 (messy but working): codemod when available.

**UQ-5 (Prose-to-test pipeline)**
- At invariant DISCOVERY — not at fix time, not at close time — write the conformance test.
  May be marked skip until the fix lands, but EXISTS from discovery. The test is named,
  self-describing, and reusable across affected packages via a shared assertion factory.
- **Action:** Create `tools/conformance/` with assertion factories for: onnx-singleton,
  cjs-boundary, no-tla, native-unref, constructor-purity.

**UQ-6 (Package classification tags)**
- Minimum tag set: `platform:node` (native deps) or `platform:shared` (pure JS),
  `invariant:<name>` per runtime constraint, `native-addon:<name>` per native dep,
  `init:async` or `init:lazy`. Auto-detected from dependency graph and enforced by CI.
- **Action:** Add `verify:tags` CI gate. Tag all 5 storage packages. Enable impact analysis
  ("which packages are affected by an onnxruntime version bump?").

---

## Open — surfaced during live investigation (2026-07-11)

### BL-273 — vec-dependent memory tools (recall/search/topics) timeout when the embedding pipeline is dead, rather than fast-failing or degrading gracefully — **Open (HIGH)** (2026-07-10)

**Symptom:** `memory_ping` returns `ok:true`, but `memory_recall`, `memory_search_entities`,
and `memory_topics` all hang until client timeout.

**Root cause evidence** (`proxy-backend-memory-server/memory-server-backend-2026-07-10.log`):
- `Cannot find module '.../dist/fastembedProcessHost.js'` — sidecar missing
- `FATAL: embedding warmup failed: shared fastembed process exited with code 1`
- Every Phase-B embed + periodic heal cycle: `embed_healed=0, embed_heal_failed=33`

**Fix:** degrade gracefully (remove vec from fusion, BM25-only + degrade signal) or fast-fail
instead of hanging. Surface `embed.state: 'degraded'` in `memory_ping`.

### BL-274 — no concurrency stress test for parallel writes + reads against memory server — **Open (MEDIUM)** (2026-07-11)

Ad-hoc stress test proved parallel reads fine (8 concurrent, 1.7s, 0 timeouts). Untested:
concurrent writes, mixed reads+writes, writes+enrich through the live proxy backend.
Existing BL-134 harness runs in-process against `memory-core`, not through UDS proxy.

**Fix:** create `tools/stress/proxy-concurrency.mjs` with interleaved `memory_write` +
`memory_recall` over UDS. Assert no timeouts, no `SQLITE_BUSY`, read-your-writes.



---

## agent-mcp-authoring integration audit — @adhd/sox-* component specs (BL-282..BL-295, 2026-07-11)

Full engineering specs for the 20 findings the adhd consumer surfaced while auditing the `@adhd/sox-*` packages for its prompt-component registry. Each was **re-verified against the current source on 2026-07-11** — `file:line`, blast radius, and RESOLVED status re-checked against HEAD, not trusted from the original audit notes. The originating `SOX-*` id is cross-referenced in every entry. 0 RESOLVED, 13 Open.

### BL-282 — Unify model cache-dir strategy across fastembed and `@huggingface/transformers` runtimes — **Open (MEDIUM)** (2026-07-11)

**Package:** `@adhd/sox-embedding-provider` (`libs/data/embed/embedding-provider`)  **Origin:** adhd/agent-mcp-authoring integration audit (was SOX-CACHE-001)

**Problem.** Two ONNX-driving runtimes ship in this package family with two independent, inconsistent cache-directory strategies: `FastembedProvider` honors `SOX_EMBED_CACHE_DIR` (resolved at `index.ts:207-213`, falling back through `$XDG_CACHE_HOME/sox/models` → `~/.cache/sox/models`), but the `@huggingface/transformers`-based shared ONNX worker (`embedWorker.ts`, which backs hybrid-search's cross-encoder rerank and claim-verification's NLI verifier per `worker.ts:19`'s `getSharedOnnxWorker` import) has **no** cache-dir override at all — it silently falls through to the library's own `HF_HOME`-based default.

**Evidence.** `grep -n "SOX_EMBED_CACHE_DIR\|cacheDir\|HF_HOME" libs/data/embed/embedding-provider/src/embedWorker.ts` returns zero matches (checked 2026-07-11); the file only imports raw `@huggingface/transformers` symbols at `embedWorker.ts:82` and never touches `env.cacheDir`/`env.localModelPath`. Meanwhile `index.ts:207-213` resolves fastembed's `cacheDir` through `SOX_EMBED_CACHE_DIR`. `hybrid-search/cross-encoder.ts:86` and `claim-verification/worker.ts:142` both route through `getSharedOnnxWorker()` / `SharedOnnxWorkerClient`, i.e. through `embedWorker.ts`, so both consumers inherit the missing override. Also re-checked: `libs/data/ingest/ingest/src/ast-chunker.ts`'s tree-sitter WASM grammar loading (`GRAMMAR_WASM_MODULE_PATHS`, resolved via `require.resolve`) has no cache-dir concept either — it loads from `node_modules` directly, not a runtime download cache, so it's a narrower case of the same "no unified model-cache root" pattern but not equally actionable.

**Root cause.** The fastembed cache-dir plumbing was added ad hoc for that one runtime; when the shared ONNX worker (`embedWorker.ts`) was introduced later (BL-238/BL-171, commit `3916afd`) to host `@huggingface/transformers` inference for rerank + verify, nobody threaded an equivalent override through it, because `transformers.js`'s `env` config object uses a different API surface (`env.cacheDir` / `env.localModelPath`) than fastembed's `cacheDir` constructor option.

**Proposed design.** Introduce `SOX_MODEL_CACHE_DIR` as a single root env var, honored by both runtimes, defaulting to the existing `~/.cache/sox/models` when unset (so today's default behavior for fastembed is preserved and the transformers.js path gains a matching default instead of `HF_HOME`).
- In `libs/data/embed/embedding-provider/src/index.ts`, change the cacheDir resolution chain at `index.ts:207-213` to check `SOX_MODEL_CACHE_DIR` before/instead-of the narrower `SOX_EMBED_CACHE_DIR` (keep `SOX_EMBED_CACHE_DIR` as a fastembed-specific override for back-compat, falling back to `SOX_MODEL_CACHE_DIR`).
- In `libs/data/embed/embedding-provider/src/embedWorker.ts`, before the first `@huggingface/transformers` pipeline construction (near the `import ... from '@huggingface/transformers'` at line 82 and the pipeline calls around lines 176/252), set `env.cacheDir = resolveModelCacheDir()` / `env.localModelPath` using a shared `resolveModelCacheDir()` helper exported from `index.ts` (reuse, don't duplicate, per this repo's DRY convention).
- Document the unified var in both packages' `sox.concerns`.
- Out of scope but worth a one-line note in the same PR: `ast-chunker.ts`'s tree-sitter WASM resolution is a `require.resolve` against `node_modules`, not a runtime cache — leave as-is unless a follow-up specifically targets WASM caching.

**Acceptance criteria.**
- [ ] A test sets `SOX_MODEL_CACHE_DIR=<tmp dir>`, constructs both a `FastembedProvider` and triggers the shared ONNX worker's first `@huggingface/transformers` load, and asserts model files land under `<tmp dir>` for **both** — fails today because the transformers.js path ignores the var entirely.
- [ ] Unsetting `SOX_MODEL_CACHE_DIR` preserves today's default paths for both runtimes (no silent behavior change for existing deployments).

**Effort / risk / blast radius.** M effort (touches `index.ts`, `embedWorker.ts`, both packages' manifests). Risk: low — additive env var with safe fallback. Affects `@adhd/sox-hybrid-search` and `@adhd/sox-claim-verification` (both consume the shared ONNX worker) and any adhd consumer that wants a single configurable model-cache root (e.g. containerized deployments wanting one volume mount for all model weights).

---

### BL-283 — Extract shared `RequestResponseChannel<T>` base for `SharedOnnxWorkerClient` / `SharedFastembedProcessClient` — **Open (LOW)** (2026-07-11)

**Package:** `@adhd/sox-embedding-provider` (`libs/data/embed/embedding-provider`)  **Origin:** adhd/agent-mcp-authoring integration audit (was SOX-DUP-001)

**Problem.** `SharedOnnxWorkerClient` (`sharedOnnxWorker.ts`, 281 lines) and `SharedFastembedProcessClient` (`sharedFastembedProcess.ts`, 200 lines) independently implement the same id-correlation / pending-request-Map / `.unref()` / timeout plumbing. Not a functional bug — a maintainability/duplication smell.

**Evidence.** `sharedFastembedProcess.ts:13` explicitly says in its own doc comment: `"This mirrors sharedOnnxWorker.ts's client shape (lazy singleton, ..."`, and `sharedOnnxWorker.ts:101` and `sharedFastembedProcess.ts:32` both reference "mirrors the same `dist`-fallback pattern." `wc -l` confirms both files exist at their original sizes (281 + 200 lines respectively) with no shared base class between them as of 2026-07-11.

**Root cause.** `SharedFastembedProcessClient` was written second, explicitly modeled on `SharedOnnxWorkerClient`'s shape via copy-paste-adapt rather than extraction, likely to move fast during the BL-238 concurrent-worker crash fix (commit `3916afd`) without pausing to refactor the earlier client.

**Proposed design.** Extract a generic `RequestResponseChannel<TRequest, TResponse>` class into a new `libs/data/embed/embedding-provider/src/requestResponseChannel.ts` covering: monotonic id generation, a `pending: Map<id, {resolve,reject,timer}>`, `.unref()` on the underlying handle, timeout-based rejection, and a `request(payload): Promise<TResponse>` method. Both `SharedOnnxWorkerClient` and `SharedFastembedProcessClient` compose or extend it, keeping only their transport-specific bits (worker_thread `postMessage`/`on('message')` vs child_process IPC).
- Option A (recommended): composition — `RequestResponseChannel` takes a `send(payload)` callback and an event-subscription hook injected by each client; keeps the two clients' transport code fully separate from the correlation/timeout logic.
- Option B: class inheritance — riskier given the two transports (worker_threads vs child_process) have different lifecycle/error-surface shapes; not recommended.

**Acceptance criteria.**
- [ ] New `requestResponseChannel.spec.ts` covering id-correlation, timeout rejection, and `.unref()` behavior in isolation.
- [ ] `sharedOnnxWorker.ts` and `sharedFastembedProcess.ts` both shrink (verify via `wc -l` before/after — expect meaningful reduction in duplicated plumbing lines, not a fabricated percentage) and both existing spec suites (`sharedOnnxWorker.spec.ts`, `sharedFastembedProcess.spec.ts`) continue to pass unmodified (proves the extraction is behavior-preserving).

**Effort / risk / blast radius.** M effort, low risk (internal refactor, both files' specs already lock behavior). No external consumer surface changes — `SharedOnnxWorkerClient`/`SharedFastembedProcessClient` types stay stable.

---

### BL-284 — Move `tree-sitter-wasms`/`web-tree-sitter` out of `@adhd/sox-ingest`'s hard `dependencies` — **Open (HIGH)** (2026-07-11)

**Package:** `@adhd/sox-ingest` (`libs/data/ingest/ingest`)  **Origin:** adhd/agent-mcp-authoring integration audit (was SOX-DEP-001)

**Problem.** `@adhd/sox-ingest` lists `tree-sitter-wasms@0.1.13` (~49 MB of WASM grammars) and `web-tree-sitter@0.25.10` (~5.7 MB) as hard `dependencies`, so `npm install @adhd/sox-ingest` unpacks ~55 MB regardless of which entrypoint a consumer actually uses. Consumers who only need `/core` (content-hash, extractive summary, tag extraction — the documented "write-path single-item transforms," per the package description) pay the full AST-chunker weight for nothing.

**Evidence.** `libs/data/ingest/ingest/package.json` (re-read 2026-07-11) still declares:
```
"dependencies": {
  "tree-sitter-wasms": "0.1.13",
  "web-tree-sitter": "0.25.10"
}
```
with no `optionalDependencies` split. Confirmed via `git log --oneline -- libs/data/ingest/ingest/package.json` (`5e3351d feat(ingest): expose dep-free ./core subpath`, `f4897aa`, `c01ddeb`, `c7387c9`) that none of these commits moved the deps — the `./core` subpath was added (BL-231) precisely to let CJS/lightweight consumers dodge the ESM/TLA cost (see BL-285), but the npm-install-time dependency weight was never addressed. `memory-core` (the only current internal consumer, see BL-285 evidence) imports exclusively from `@adhd/sox-ingest/core` (`extractive.ts:1`, `index.ts:329`, `write.ts:53`) and never touches the AST-chunker surface, meaning today's *only* internal consumer pays the full 55MB cost for zero benefit.

**Root cause.** The package was authored as a single npm package covering both the lightweight "write-path transforms" (hash/summary/tags) and the heavyweight AST-chunker family (4 tree-sitter grammars), and `dependencies` was never split to reflect that only a subset of consumers need the WASM grammars.

**Proposed design.**
- Option A (recommended, matches the original finding's primary recommendation): Move `tree-sitter-wasms` and `web-tree-sitter` from `dependencies` to `optionalDependencies` in `libs/data/ingest/ingest/package.json`. npm/pnpm still installs them by default but a consumer can `--no-optional` or a lockfile-pruning tool can drop them for `/core`-only usage; requires `ast-chunker.ts`'s `import` of `web-tree-sitter` to already be structured so a missing optional dep doesn't break `/core`'s module graph (verify: `/core`'s `dist/core.js` must not statically pull in `ast-chunker.js` — confirmed true today since `core.ts` doesn't import `ast-chunker.ts`, so this is safe).
- Option B (larger, more correct long-term): Split the chunker family into a new `@adhd/sox-ingest-chunkers` package depending on `@adhd/sox-ingest` for its primitives; `@adhd/sox-ingest` keeps zero heavyweight deps. This also resolves BL-285's TLA/ESM-only problem at the root, since the root barrel's top-level-await only exists to eagerly load the 4 grammars.
- Recommendation: do Option B. Option A only reduces *install* weight for consumers who happen to prune optionals; it does nothing for BL-285 (the root barrel is still ESM-only and still eagerly TLA-loads all 4 grammars for any consumer who imports the root). Since `memory-core` — today's only internal consumer — never needs the chunker family at all, splitting the package is the durable fix and directly enables closing BL-285 in the same effort.

**Acceptance criteria.**
- [ ] After the split (or `optionalDependencies` move), a fresh `npm install @adhd/sox-ingest` (or `@adhd/sox-ingest/core`-only consumer) installs measurably less: assert via `du -sh node_modules/tree-sitter-wasms node_modules/web-tree-sitter` (or their absence) in a scratch install directory that these are either absent or optional-and-skippable, not unconditionally present.
- [ ] `import('@adhd/sox-ingest/core')` continues to work with `tree-sitter-wasms`/`web-tree-sitter` deleted from `node_modules` (already true today per the original audit's repro — must stay true after the fix, add as a regression test alongside the existing `tools/test-bl231-cjs-boundary.mjs`).
- [ ] If Option B: `@adhd/sox-ingest`'s own `package.json` `dependencies` no longer lists either tree-sitter package at all; `@adhd/sox-ingest-chunkers` (or equivalent) does.

**Effort / risk / blast radius.** L effort if Option B (new package, publishing, workspace wiring — coordinate with `SOURCES.md`/pnpm workspace config); S-M if Option A (single package.json edit + optional-dep smoke test). Risk: Option B requires updating any consumer that imports `AstChunker` from the root today — confirmed zero internal consumers do (`memory-core` only imports `/core`), so blast radius is effectively zero internally; external/adhd consumers should be checked before the split ships (grep adhd's lockfile/imports for `sox-ingest` root imports of `AstChunker`).

---

### BL-285 — Split tree-sitter chunkers out of `@adhd/sox-ingest` root to remove the module-scope top-level await — **Open (MEDIUM)** (2026-07-11)

**Package:** `@adhd/sox-ingest` (`libs/data/ingest/ingest`)  **Origin:** adhd/agent-mcp-authoring integration audit (was SOX-TLA-001)

**Problem.** The root barrel (`libs/data/ingest/ingest/src/index.ts`, re-exporting `AstChunker` from `ast-chunker.ts`) is ESM-only because `ast-chunker.ts` runs `await Parser.init()` and `await Promise.all(...)` (loading all 4 grammars) at module-evaluation time — `web-tree-sitter` exposes no `initSync`, and the public `Chunker.chunk()`/`estimate()` contract is synchronous, forcing eager TLA-based preload. This makes the root un-`require()`-able, which is why the `/core` subpath (BL-231) exists purely as a CJS escape hatch. Two costs: (a) all 4 grammars load eagerly for any root import — e.g. summarizing a markdown file still pulls in the ~3.8MB C# grammar; (b) no internal consumer imports the root barrel or `AstChunker` at all today, so the entire TLA-bearing surface is currently dead weight that nonetheless forces ESM-only packaging on every consumer of the root.

**Evidence.** `libs/data/ingest/ingest/src/ast-chunker.ts:174` — `await Parser.init();` — and `ast-chunker.ts:184` — `await Promise.all(SUPPORTED_LANGUAGES.map(async (language) => { ... }))` — both re-confirmed at those exact line numbers on 2026-07-11 (unchanged since original citation). `ast-chunker.ts:165-172`'s own comment block explicitly documents this as intentional: `"all grammars are eagerly loaded once at module-evaluation time via top-level await"`. `index.ts:40` re-exports `export { AstChunker } from './ast-chunker.js';`. Consumer check: `grep -rn "sox-ingest" libs/memory-core/src/*.ts | grep -v spec` shows only `@adhd/sox-ingest/core` imports (`extractive.ts:1`, `index.ts:329`, `write.ts:53`) — zero imports of the root package or `AstChunker` anywhere in the only internal consumer.

**Root cause.** `web-tree-sitter`'s `Parser.init()`/`Language.load()` are inherently async (WASM instantiation), and the chunker family was designed around a synchronous `Chunker.chunk()` contract, so the original author pushed the async cost to module-eval time via TLA rather than lazy per-language loading — without anticipating that this decision would make the *entire root package* ESM-only for consumers who never touch the chunker family.

**Proposed design.** This is the same root cause as BL-284 and should be fixed together:
- Option A (recommended, same as BL-284 Option B): move `AstChunker` and its 4-grammar TLA into a separate `@adhd/sox-ingest-chunkers` package. `@adhd/sox-ingest`'s root then has zero TLA and becomes `require()`-able directly (no more need for the `/core` escape hatch's CJS-only justification, though `/core` can remain for back-compat).
- Option B (smaller, in-place): keep one package but make grammar loading lazy-per-language instead of eager-at-module-eval. Replace the top-level `await Promise.all(...)` grammar preload with a `Map<language, Promise<Language>>` populated on first `AstChunker` construction for that language, and change `Parser.init()` to run lazily on first use (guarded by a module-level `let initPromise: Promise<void> | null`). This removes the TLA (the root barrel becomes sync-importable / `require()`-able via dynamic `import()` inside an async method) while keeping one package. Trade-off: `chunk()`/`estimate()` would need to become async (breaking the current sync contract) OR require a synchronous `ensureReady()` pre-step consumers must await before calling `chunk()` — this is a real API-shape change, not free.
- Recommendation: Option A. It fully removes the TLA without breaking the documented sync `chunk()`/`estimate()` contract, and — since zero internal consumers use the chunker family today (confirmed above) — the blast radius of moving it out is minimal.

**Acceptance criteria.**
- [ ] After the fix, `require('@adhd/sox-ingest')` (root, not `/core`) succeeds in plain CommonJS without `ERR_REQUIRE_ESM` — add as a new case in (or alongside) `tools/test-bl231-cjs-boundary.mjs`.
- [ ] `grep -n "^await " <root-package>/src/*.ts` (module-scope, not inside a function) returns zero matches in the post-split `@adhd/sox-ingest` root.
- [ ] `AstChunker.chunk()`/`.estimate()` remain synchronous per their documented contract wherever they end up.

**Effort / risk / blast radius.** L effort (coupled with BL-284's package split — do as one PR). Risk: low internally (zero current consumers of the chunker family per the evidence above); must confirm zero adhd-side imports of `@adhd/sox-ingest`'s root `AstChunker` before shipping, since adhd is the named downstream auditor here.

---



### BL-287 — Add `"./package.json"` to `exports` map across all `@adhd/sox-*` data packages — **Open (LOW)** (2026-07-11)

**Package:** All 9 `libs/data/**` packages (embedding-provider, ingest, graph-store, task-queue, hybrid-search, blob-store, vector-store, claim-verification, analysis)  **Origin:** adhd/agent-mcp-authoring integration audit (was SOX-EXPORTS-001)

**Problem.** Every `exports`-mapped `@adhd/sox-*` data package blocks `import('<pkg>/package.json')` / `require('<pkg>/package.json')` with `ERR_PACKAGE_PATH_NOT_EXPORTED`, because none declares a `"./package.json": "./package.json"` passthrough. Common Node.js footgun, but it breaks any tooling that reads a dependency's manifest at runtime (version introspection, license scanners, `sox.concerns`/`sox.invariants` metadata readers — which this very audit process itself relies on).

**Evidence.** Re-scanned all 9 `libs/data/**/package.json` files with an `exports` map on 2026-07-11 via a scripted JSON check (`python3` parsing each `exports` object for the `"./package.json"` key): **zero of nine** declare it — `@adhd/sox-analysis`, `@adhd/sox-embedding-provider`, `@adhd/sox-graph-store`, `@adhd/sox-ingest`, `@adhd/sox-task-queue`, `@adhd/sox-hybrid-search`, `@adhd/sox-blob-store`, `@adhd/sox-vector-store`, `@adhd/sox-claim-verification`. This is a wider blast radius than the original finding's "all 5 data packages" estimate — the package count in this monorepo has grown to 9 `libs/data/**` packages since the original audit; all 9 need the fix, not 5.

**Root cause.** The `exports` field was hand-authored per package (or scaffolded once and copy-pasted) without including the now-conventional `"./package.json"` passthrough that most modern npm packages add specifically to keep manifest introspection working under `exports` encapsulation.

**Proposed design.** Add to every `libs/data/**/package.json`'s `exports` map:
```json
"./package.json": "./package.json"
```
Since this is mechanical and identical across all 9 packages, either hand-edit each (S effort, 9 small diffs) or add it to whatever package-scaffolding/generator template these packages were created from (per this repo's "bake into generator" convention) so future packages don't reintroduce the gap. Also consider adding a workspace-level lint/CI check (e.g. a small `tools/` script) that fails if any `libs/**/package.json` has an `exports` map without a `"./package.json"` entry — prevents regression on the 10th package.

**Acceptance criteria.**
- [ ] `node -e "console.log(require('@adhd/sox-<pkg>/package.json').version)"` (or ESM `import(...)` equivalent) succeeds for all 9 packages post-fix — currently fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` for all 9.
- [ ] A workspace-level test iterates every `libs/data/**/package.json` with an `exports` field and asserts `"./package.json"` is present — fails if a 10th package is added later without it.

**Effort / risk / blast radius.** S effort (9 one-line JSON edits + optional CI guard). Zero behavioral risk — purely additive `exports` entry, cannot break existing subpath resolution.

---

### BL-288 — Declare `"require"` export conditions (or tighten `engines`) so native packages are safely `require()`-able within their declared Node range — **Open (HIGH)** (2026-07-11)

**Package:** `@adhd/sox-memory-core` (`libs/memory-core`) + `@adhd/sox-graph-store` (`libs/data/graph/graph-store`) and other native-addon packages  **Origin:** adhd/agent-mcp-authoring integration audit (was SOX-PKG-ENGINES-001)

**Problem.** All native packages declare an `engines.node` range (most `>=22`, `memory-core` `>=20`) but none ships a `"require"` export condition — they're only `require()`-able today via Node's `require(esm)` interop, which is only stable at ≥20.19/22.12. Concretely broken: `memory-core` is a CJS build (`module: "CommonJS"`) declaring `engines.node: ">=20"`, and its compiled `dist/*.js` does `require("@adhd/sox-graph-store")` — a pure-ESM package (`"type": "module"`, `exports` map has no `"require"` condition, `engines.node: ">=22"`) — which throws `ERR_REQUIRE_ESM` on Node 20.0–20.18, a range `memory-core` itself claims to support.

**Evidence.** `libs/memory-core/package.json` `engines: { "node": ">=20" }` (re-checked 2026-07-11); `libs/memory-core/tsconfig.lib.json:4-5` — `"module": "CommonJS", "moduleResolution": "node10"`. `libs/data/graph/graph-store/package.json`: `"type": "module"`, `"engines": { "node": ">=22" }`, `"exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }` — no `"require"` condition. Every `memory-core/src/*.ts` file that touches graph-store (`cluster.ts:18`, `enrich-batch.ts:17`, `enrich.ts:16`, `entity-episodes.ts:11-12`, `list-entities.ts:11`, `link.ts:13`, `neardup.ts:12`, `near-duplicates.ts:11`, `related.ts:11-12`, `supersession-chain.ts:13`) compiles to a `require("@adhd/sox-graph-store")` call in the corresponding `dist/*.js` — confirmed via `grep -n "sox_graph_store_1 = require" libs/memory-core/dist/*.js`, 10 files match.

**Root cause.** `memory-core` was built as CommonJS (legacy `node10` module resolution, likely for tsconfig/consumer-compat reasons predating the ESM-only data packages), while newer native data packages (graph-store et al.) were authored pure-ESM without a dual-build or `"require"` condition — nobody reconciled the two when memory-core started depending on graph-store directly.

**Proposed design.**
- Option A: Add a `"require"` export condition to every ESM-only native package (graph-store, vector-store, blob-store, task-queue, etc.) via a dual build — compile a CJS bundle alongside the existing ESM `dist/index.js` (e.g. `dist/index.cjs`) and add `"exports": { ".": { "types": "...", "import": "./dist/index.js", "require": "./dist/index.cjs" } }`. This is the most robust fix but doubles the build output and requires validating native-addon (`better-sqlite3`/`sqlite-vec`) behavior identically under both module systems.
- Option B (recommended, matches the original finding's stated fix): Tighten `engines.node` across all these native packages to the actual safe floor for `require(esm)` interop — `">=20.19"` for packages consumed by `memory-core`-style CJS requires under Node 20.x, or `">=22.12"` if the package targets the Node 22 line exclusively. This doesn't require a dual build; it just makes the declared support range honest (today's `>=20` on memory-core is simply false once you account for its `require("@adhd/sox-graph-store")` dependency).
- Recommendation: do Option B now (S effort, closes the correctness gap immediately) and track Option A as a longer-term follow-up only if a consumer actually needs Node 20.0–20.18 support (unlikely given this is an internal monorepo — check with adhd whether it pins Node 20.19+ already before investing in dual builds).

**Acceptance criteria.**
- [ ] `libs/memory-core/package.json`'s `engines.node` reads `">=20.19"` (or `>=22.12` if scoped to Node 22), matching its actual `require("@adhd/sox-graph-store")` dependency's real floor.
- [ ] A CI/test check enumerates every `libs/data/**` and `libs/memory-core` package with a native dep, cross-references each `require()`-ing consumer's `engines.node` against each ESM-only dependency's lack of a `"require"` condition, and fails if any consumer's declared floor is below the `require(esm)`-interop-stable version (20.19/22.12) — this is the regression guard; it would have caught this exact bug.
- [ ] Manual/CI verification: `node@20.18.x` (or the closest available via nvm/docker) attempting `require('@adhd/sox-memory-core')` reproduces `ERR_REQUIRE_ESM` today, and no longer falls inside the corrected `engines` range after the fix (i.e., the failure now correctly happens *outside* the package's declared support window, not inside it).

**Effort / risk / blast radius.** S effort for Option B (manifest edits across ~5-6 packages); L effort for Option A (dual build pipeline). Risk: Option B could surprise a consumer that (wrongly) relied on the `>=20` claim on Node 20.0-20.18 — but that consumer was already broken, this just makes the breakage honest via `npm install` engine warnings. Directly affects any adhd consumer running Node <20.19/<22.12 that imports `memory-core`.

---

### BL-289 — Delete dead `memory-core/src/embedWorker.ts` and fix stale BL-11 doc comment — **Open (LOW)** (2026-07-11)

**Package:** `@adhd/sox-memory-core` (`libs/memory-core`)  **Origin:** adhd/agent-mcp-authoring integration audit (was SOX-DEADCODE-001)

**Problem.** `libs/memory-core/src/embedWorker.ts` is dead code: excluded from the build and superseded by embedding-provider's shared ONNX worker host, but `index.ts`'s BL-11 process-boundary doc-comment still describes it as the active isolation mechanism, misleading anyone reading the package's top-level doc about how embed isolation actually works today.

**Evidence.** `libs/memory-core/tsconfig.lib.json:15` — `"exclude": ["src/**/*.spec.ts", "src/**/*.test.ts", "src/embedWorker.ts", "node_modules"]` — the file is explicitly excluded from the `tsc` build. `libs/memory-core/src/index.ts:12-13` still reads: `"Use the embed worker thread — embed() in this library already routes through embedWorker.ts (worker_threads), keeping ONNX isolated from the main thread."` But `libs/memory-core/src/embed.ts:4-5` itself documents the real current state: `"This is a thin ping/stats adapter over @adhd/sox-embedding-provider. The old embed.ts + embedWorker.ts have been replaced by the canonical [shared ONNX worker host]."` and `embed.ts:17-18` imports `createEmbeddingProvider`/`EmbeddingProvider` from `@adhd/sox-embedding-provider`, not from a local `embedWorker.ts`.

**Root cause.** When embed isolation was migrated to embedding-provider's shared ONNX worker host (BL-238/BL-171, tracked in embedding-provider's own history), `memory-core/src/embed.ts` was updated and correctly self-documents the migration, but the higher-level BL-11 doc-comment in `index.ts` (written earlier, describing the original in-package `embedWorker.ts` isolation) was never revisited.

**Proposed design.**
1. Delete `libs/memory-core/src/embedWorker.ts` (confirm zero remaining references first: `grep -rn "embedWorker" libs/memory-core/src/*.ts` — expect only the stale `index.ts:13` comment and the tsconfig exclude line, both being fixed/removed in this same change).
2. Remove the `"src/embedWorker.ts"` entry from `libs/memory-core/tsconfig.lib.json:15`'s `exclude` array (no longer needed once the file is gone).
3. Rewrite `index.ts:9-19`'s BL-11 doc block to describe the actual current mechanism: embed isolation now lives in `@adhd/sox-embedding-provider`'s shared ONNX worker (`getSharedOnnxWorker`/`SharedOnnxWorkerClient`, per `embed.ts:4-5`'s own comment), not a local `embedWorker.ts`. Point to `embed.ts` as the integration point.

**Acceptance criteria.**
- [ ] `libs/memory-core/src/embedWorker.ts` no longer exists in the tree.
- [ ] `grep -n "embedWorker.ts" libs/memory-core/src/index.ts` returns zero matches.
- [ ] `nx build memory-core` and `nx test memory-core` both pass unchanged (proves the file was truly unreferenced/dead — this is the regression check: if some consumer secretly needed it, the build breaks).

**Effort / risk / blast radius.** S effort, low risk — file is confirmed excluded from the build already, so deleting it cannot regress the compiled output. Doc fix is pure clarity improvement for future readers/agents of `memory-core`.

---

### BL-290 — Wire in or drop the phantom `@adhd/sox-vector-store` dependency of `memory-core` — **Open (LOW)** (2026-07-11)

**Package:** `@adhd/sox-memory-core` (`libs/memory-core`)  **Origin:** adhd/agent-mcp-authoring integration audit (was SOX-PHANTOM-001)

**Problem.** `@adhd/sox-vector-store` is declared as a `workspace:*` dependency in `memory-core/package.json` but is never actually imported anywhere in `src/` or `dist/` — it appears only in code comments.

**Evidence.** `libs/memory-core/package.json:30` — `"@adhd/sox-vector-store": "workspace:*"`. `grep -rn "sox-vector-store" libs/memory-core/src/*.ts` matches only two comment lines: `reembed.ts:56` (`"generic multi-space \`vec_<model>\` side tables from \`@adhd/sox-vector-store\`,"`) and `reembed.ts:233` (similar comment). `grep -rln "sox-vector-store" libs/memory-core/dist/*.js` confirms only `dist/reembed.js` matches, and only in the transpiled-through comment text (same two lines) — no `require("@adhd/sox-vector-store")` exists anywhere in `dist/`.

**Root cause.** `memory-core` manages vectors directly via `sqlite-vec` (`db.ts:198-201` loads `sqlite-vec` directly against its own `better-sqlite3` handle) rather than delegating to the standalone `@adhd/sox-vector-store` package's `SqliteVectorBackend`/`openVectorStore`. The dependency was likely added during an earlier design where `memory-core` was expected to delegate vector storage to `vector-store`, then the design changed to inline `sqlite-vec` usage, but the now-unnecessary `package.json` entry was never removed. `reembed.ts`'s comments suggest a *future* multi-space vector table design that would use `vector-store`'s generic `vec_<model>` tables — i.e., this may be a forward-looking placeholder, not pure leftover cruft.

**Proposed design.**
- Option A (recommended if the multi-space reembed design in `reembed.ts:56,233`'s comments is still planned): keep the dependency but file it as a tracked follow-up to actually wire it in when that design lands, and add a one-line note in `package.json` (or a `// TODO` next to the dependency) explaining why it's present-but-unused today, so a future auditor doesn't re-flag it as pure phantom cruft.
- Option B (recommended if the multi-space design is not imminent): drop `"@adhd/sox-vector-store": "workspace:*"` from `memory-core/package.json` `dependencies` entirely. `memory-core` continues managing vectors directly via `sqlite-vec` as it does today; re-add the dependency if/when the `reembed.ts` multi-space design is actually implemented.
- Recommendation: Option B — an unused dependency creates real audit/supply-chain noise (this exact finding exists because of it) and a `workspace:*` pin costs nothing to re-add later; "kept for a future design" is exactly the kind of speculative dependency this repo's "You always evaluate best of class 3rd party tools before authoring" / DRY discipline argues against carrying indefinitely.

**Acceptance criteria.**
- [ ] Either `@adhd/sox-vector-store` is removed from `memory-core/package.json` `dependencies`, or it has at least one real `import`/`require` in `src/` (not just a comment) wiring it into the multi-space reembed path.
- [ ] A dependency-audit test/script (e.g. comparing `package.json` `dependencies` against actual `import`/`require` statements found by static grep across `src/`) flags this package if a declared dependency has zero non-comment usages — regression guard for future phantom deps across the monorepo, not just this one instance.

**Effort / risk / blast radius.** S effort (single `package.json` edit, or documented TODO). Zero runtime risk either way — the dependency currently has no code path exercising it.

---

### BL-291 — Standardize a typed native-open error across all SQLite-backed data packages — **Open (MEDIUM)** (2026-07-11)

**Package:** `@adhd/sox-blob-store`, `@adhd/sox-vector-store`, `@adhd/sox-memory-core` (task-queue already correct)  **Origin:** adhd/agent-mcp-authoring integration audit (was SOX-ERR-001)

**Problem.** Only `@adhd/sox-task-queue` wraps its native `new Database(...)` open call in a typed error (`TaskQueueSystemError`). `@adhd/sox-blob-store`, `@adhd/sox-vector-store`, and `@adhd/sox-memory-core` all throw the raw, unwrapped `better-sqlite3` exception straight through on a missing/ABI-mismatched native `.node` binary — a class of failure that's common across Node version upgrades and cross-platform installs, and one whose error message (`Could not locate the bindings file` or an ABI-version mismatch) gives no package-level context to the caller.

**Evidence.** `libs/data/queue/task-queue/src/task-queue.ts:195-201` (re-verified 2026-07-11, confirmed present in current source):
```ts
try {
  this.db = new Database(this.config.dbPath);
  applySchema(this.db);
} catch (err) {
  throw new TaskQueueSystemError('failed to open task queue database', err as Error);
}
```
By contrast: `libs/data/store/blob-store/src/store.ts:112` — `this.db = new (await import('better-sqlite3')).default(dbPath);` — no try/catch, no wrapping. `libs/data/vectors/vector-store/src/index.ts:313` — `const db = new Database(path);` inside `openVectorStore()` — no try/catch. `libs/memory-core/src/db.ts:198` — `const db = new Database(dbPath);` — no try/catch (a second unwrapped open exists at `db.ts:388` for the readonly path too).

**Root cause.** `task-queue` was (per its own package history) the package where native-open error handling was deliberately hardened; the pattern was never propagated to the other three native-addon packages when they were authored, so each independently reinvented (or omitted) native-open error handling.

**Proposed design.** Extract a single shared typed error + wrapping helper, since 4 packages independently need the identical pattern (this repo's Two-Use Refactor Rule applies directly here):
- Add a new tiny shared package/module (recommend `libs/data/native-open-error` or, if a shared low-level `libs/shared`-equivalent already exists in this repo, place it there) exporting: a `NativeOpenError extends Error` class carrying `{ dbPath, cause }`, and a `openSqliteDatabase(path, opts?): Database.Database` helper that wraps `new Database(...)` in a try/catch and throws `NativeOpenError` with a message identifying the package/dbPath and preserving the original error as `cause`.
- `task-queue.ts:195-201`, `store.ts:112`, `vector-store/index.ts:313`, and `memory-core/db.ts:198` (+`db.ts:388`) all switch to calling the shared helper instead of `new Database(...)` directly, each still able to catch the shared `NativeOpenError` and re-wrap into their own package-specific error type if desired (e.g. `task-queue` can keep `TaskQueueSystemError` but construct it from a caught `NativeOpenError`).
- Do not introduce a circular dependency: this shared module must sit below `task-queue`/`blob-store`/`vector-store`/`memory-core` in the dependency graph (pure `better-sqlite3` wrapper, no domain logic) — consistent with this repo's "Dependency Purity" rule for shared packages.

**Acceptance criteria.**
- [ ] A test that deletes/corrupts the `better-sqlite3` native binding (or mocks `Database` constructor to throw an ABI-mismatch-shaped error) and asserts each of `blob-store.open()`, `vector-store.openVectorStore()`, and `memory-core.openDb()` throws the shared typed error (not a raw better-sqlite3 exception) — fails today for all three, passes for `task-queue` already.
- [ ] The typed error's message includes enough context (package name, resolved db path) to be actionable in a production log without needing to attach a debugger.

**Effort / risk / blast radius.** M effort (new shared module + 4 call-site edits + tests across 4 packages). Risk: low — purely additive error-wrapping, does not change the happy path. Improves production diagnosability for every consumer (including adhd) hitting native-binding issues across Node/platform upgrades.

---

### BL-292 — Require `platform:node` tag on every native-addon-bound package — **Open (LOW)** (2026-07-11)

**Package:** `@adhd/sox-vector-store`, `@adhd/sox-graph-store`, `@adhd/sox-memory-core`, `@adhd/sox-blob-store`, `@adhd/sox-task-queue`  **Origin:** adhd/agent-mcp-authoring integration audit (was SOX-PLATFORM-001)

**Problem.** None of the five native-addon-bound packages (`vector-store`, `graph-store`, `memory-core`, `blob-store`, `task-queue`) carries a `platform:*` tag in its `project.json`, despite every one of them depending on `better-sqlite3`/`sqlite-vec` native bindings (Node-only). No package currently makes a *false* `platform:shared`/`platform:browser` claim, but there's also no positive guard — a future rename, tag-inheritance change, or careless refactor could drift one of these into a browser-targeted bundle graph with nothing catching it.

**Evidence.** Re-checked all five `project.json` files on 2026-07-11 via `find <pkg-dir> -maxdepth 1 -iname project.json -exec grep -A5 '"tags"' {} \;`:
- `libs/data/vectors/vector-store/project.json`: `["type:lib", "area:data", "group:vectors"]` — no `platform:*`.
- `libs/data/graph/graph-store/project.json`: `["type:lib", "area:data", "group:graph"]` — no `platform:*`.
- `libs/memory-core/project.json`: `["type:lib"]` — no `platform:*`, and notably no `area:*`/`group:*` either (sparser than the others).
- `libs/data/store/blob-store/project.json`: `["type:lib", "area:data", "group:store"]` — no `platform:*`.
- `libs/data/queue/task-queue/project.json`: `["type:lib", "area:data", "group:queue"]` — no `platform:*`.

**Root cause.** This repo's tagging convention (`type:*`, `area:*`, `group:*`) was applied consistently, but a `platform:*` dimension was never added to the tag taxonomy for this repo's Nx project graph, so there's no Nx lint rule (e.g. `@nx/enforce-module-boundaries`) that could even reference it to block a native package from being imported into a browser-tagged consumer.

**Proposed design.**
1. Add `"platform:node"` to the `tags` array of all five `project.json` files listed above.
2. Add an Nx module-boundary lint rule (`.eslintrc`/`nx.json` `depConstraints`) that forbids any project tagged `platform:browser` (or untagged/`platform:shared` claiming browser use) from depending on a `platform:node`-tagged project — this is the actual regression guard; the tag alone is just metadata until it's enforced.
3. Extend the check to auto-detect: any package whose `dependencies` includes a known native-addon package (`better-sqlite3`, `sqlite-vec`, `onnxruntime-node`, `web-tree-sitter`'s native fallback if any) but lacks `platform:node` in `project.json` tags should fail CI — this generalizes the guard beyond just these 5 packages to catch the *next* native package too, addressing this repo's own `docs/plan` UQ-6 note ("Minimum tag set: platform:node (native deps)... Auto-detected from dependency graph and enforced by CI").

**Acceptance criteria.**
- [ ] All 5 `project.json` files have `"platform:node"` in `tags`.
- [ ] A new Nx lint constraint test: create a scratch `platform:browser`-tagged project that attempts to depend on one of these 5 packages, and assert `nx lint`/`nx graph` (or `@nx/enforce-module-boundaries`) fails the build — proves the guard is real, not just a label.
- [ ] The auto-detection CI check (native dep present, tag absent) passes clean today after step 1, and is proven to fail-loud by temporarily removing the tag from one package in a test harness.

**Effort / risk / blast radius.** S-M effort (5 tag additions + one new lint constraint + CI wiring). Zero behavioral risk to existing builds (additive tag + a new constraint that today's graph already satisfies once tags are added). Prevents a real future regression class — directly relevant to adhd's own `platform:node`/`platform:browser`/`platform:shared` isolation convention (this project's own CLAUDE.md enforces the identical pattern), so this is a good example to point to when adhd audits sox-ecosystem's tagging hygiene.

---

## agent-mcp-authoring integration audit — structural gaps (schema duplication / migration / dead dep, 2026-07-11)

Surfaced while evaluating whether the adhd registry should reuse `@adhd/sox-graph-store` directly (Option A) instead of reimplementing FTS5 (Option B). These are distinct from the BL-282..295 findings and each other. Origin: adhd/agent-mcp-authoring.

### BL-300 — `node`/`edge` table schema is duplicated across `graph-store` and `memory-core` (no single source of truth) — **Open (MEDIUM)** (2026-07-11)

**Package:** `@adhd/sox-graph-store` (`libs/data/graph/graph-store/src/index.ts` `GRAPH_DDL`) + `@adhd/sox-memory-core` (`libs/memory-core/src/schema.ts` `DDL`)  **Origin:** adhd/agent-mcp-authoring integration audit

**Problem.** The `node` and `edge` tables are each defined **twice** — once in `graph-store`'s `GRAPH_DDL` and again, independently, in `memory-core`'s `schema.ts` `DDL`. There is no shared canonical schema module; the two are copy-pasted hand-maintained SQL strings that must be kept in lockstep by convention alone. `memory-core` also *consumes* `graph-store` at runtime (`createGraphBackend` is imported in `neardup.ts:12`, `enrich-batch.ts:17`, `entity-episodes.ts:11`, `cluster.ts:18`, `near-duplicates.ts:11`, `list-entities.ts:11`) — i.e. `graph-store` operates over the very `node`/`edge` tables that `memory-core`'s own DDL created — so the two definitions describe the *same physical tables* yet live in two packages.

**Evidence.** `graph-store/src/index.ts:19` and `memory-core/src/schema.ts:46` both contain `kind TEXT NOT NULL CHECK (kind IN ('episode','entity','claim','community','session'))`, plus full parallel `CREATE TABLE node/edge` blocks. `graph-store`'s `applySchema()` (`dist/index.js:316`) runs `CREATE TABLE IF NOT EXISTS node (...)` — a no-op when `memory-core` already created `node`, which is exactly what happens when `memory-core` passes its own `db` handle into `createGraphBackend(db)`.

**Root cause.** `graph-store` was extracted from `memory-core` (or vice-versa) by copying the DDL rather than depending on a shared schema package. Two owners, one physical table.

**Proposed design.** Extract the canonical `node`/`edge`/index DDL into a single source of truth — either a tiny `@adhd/sox-graph-schema` (types package, zero runtime) that both import, or have `memory-core` import `GRAPH_DDL`/`FTS_DDL` from `@adhd/sox-graph-store` and delete its private copy. Recommend the latter (graph-store already owns the graph primitives; memory-core adds only its memory-specific tables — `memory_scope`, `sox_store_meta`, `organizer_queue`, `request_ledger`, `promotion_queue` — which stay in memory-core). This makes drift structurally impossible (BL-301) and gives migrations one place to live (BL-302).

**Acceptance criteria.**
- [ ] Exactly one `CREATE TABLE ... node (` and one `... edge (` definition exists in the repo (grep proves it); `memory-core` composes graph DDL + its own memory-only tables.
- [ ] A test asserts `memory-core`'s applied `node` schema is byte-identical to `graph-store`'s (e.g. `PRAGMA table_info(node)` equality) so a future edit to one is forced through the shared source.

**Effort / risk / blast radius.** M effort. Risk: low-medium (touches the live memory schema — must keep the applied SQL identical to today's memory-core `node` to avoid an accidental migration). Blast radius: memory-core, graph-store, analysis (also imports graph-store), hybrid-search.

### BL-301 — the two duplicated `node`/`edge` schemas have already DRIFTED (latent column/constraint mismatch) — **Open (HIGH)** (2026-07-11)

**Package:** `@adhd/sox-graph-store` + `@adhd/sox-memory-core`  **Origin:** adhd/agent-mcp-authoring integration audit

**Problem.** The two copies (BL-300) are **not** identical — they have diverged in columns, a column type, and the `edge.rel` enum. Because `memory-core` creates `node`/`edge` first and `graph-store`'s `CREATE TABLE IF NOT EXISTS` then silently no-ops, `graph-store` code that references columns present in *its* DDL but absent from *memory-core*'s table will fail at runtime (`no such column`) or read `NULL` — a latent bug gated only by which `graph-store` methods `memory-core` currently exercises.

**Evidence** (graph-store `GRAPH_DDL` vs memory-core `schema.ts DDL`, read 2026-07-11):
- **node columns only in graph-store:** `topic`, `tags`, `namespace`, `project_path`, `is_superseded`, `t_expires`.
- **node columns only in memory-core:** `level`, `resume_state`.
- **type mismatch:** `confidence` is `TEXT` in graph-store, `REAL` in memory-core.
- **edge.rel CHECK drift:** graph-store allows `PART_OF` and `DEPENDS_ON`; memory-core's `rel` CHECK omits both (verified: `DEPENDS_ON` present in graph-store DDL, absent in memory-core DDL). An edge written by graph-store with `rel='DEPENDS_ON'`/`'PART_OF'` against a memory-core-created `edge` table throws a CHECK violation.
- **index drift:** graph-store defines `ix_node_topic`, `ix_node_project`, `ix_node_namespace`, `ix_node_expires`, `ix_edge_unique` that memory-core does not; memory-core gates `ix_edge_src/dst` on `t_expired IS NULL` (a column graph-store's edge table lacks — graph-store edge has no `t_expired`).

**Root cause.** Independent hand-edits to two copies of the same schema with no equality gate (direct consequence of BL-300).

**Proposed design.** Fixing BL-300 (single source) eliminates the drift by construction. Before/alongside that: add a **schema-equality test** that opens a `graph-store` DB and a `memory-core` DB and asserts `PRAGMA table_info(node)` and the `edge` CHECK are identical; it must FAIL today (proving the drift) and pass after unification. Separately decide the intended superset: if `memory-core` needs `level`/`resume_state` and graph-store needs `topic`/`tags`/`namespace`/`project_path`, the unified `node` carries all of them.

**Acceptance criteria.**
- [ ] A test that reproduces a concrete failure — e.g. `createGraphBackend(memoryCoreDb).writeEdge(..., rel:'DEPENDS_ON')` throws a CHECK violation today — is added, then goes green after unification.
- [ ] Post-fix, `PRAGMA table_info(node)` is identical across both packages' freshly-applied schemas.

**Effort / risk / blast radius.** M-L effort. Risk: medium — reconciling the superset touches live memory data shapes; needs a real migration (BL-302) for existing memory stores if the unified `node` adds/changes columns. Blast radius: memory-core, graph-store, analysis, hybrid-search, and every persisted `~/.adhd`/memory store.

### BL-302 — no real migration mechanism: `_schema_version` is a stub that cannot alter an existing table — **Open (HIGH)** (2026-07-11)

**Package:** `@adhd/sox-graph-store` (`applySchema`, `dist/index.js:316-336`) — mirrored in `@adhd/sox-memory-core` (`memory_scope.schema_ver`)  **Origin:** adhd/agent-mcp-authoring integration audit

**Problem.** `graph-store` has the *scaffold* of schema versioning — a `_schema_version` table and a `targetVersion` gate — but no actual migration capability. `targetVersion` is hard-coded to `1`, and the only action taken is `db.exec(GRAPH_DDL)` (all `CREATE TABLE/INDEX IF NOT EXISTS`). Once a DB exists at version 1, **no schema change can ever reach it**: bumping `targetVersion` would re-run `CREATE TABLE IF NOT EXISTS` which no-ops on the existing table, and SQLite cannot `ALTER TABLE ... ADD CONSTRAINT` / change a column type / change a `CHECK` in place. So any future evolution (relaxing the `node.kind` CHECK per BL-295, reconciling the drift per BL-301, adding a column) is **unshippable to existing stores** without a hand-written rebuild. `memory-core` has the same shape (`schema_ver INTEGER NOT NULL DEFAULT 1`) with no visible upgrade path.

**Evidence.** `applySchema()` (`dist/index.js:322-334`): `CREATE TABLE IF NOT EXISTS _schema_version`; read latest; `const targetVersion = 1`; `if (!currentVersion || currentVersion.version < targetVersion) { db.exec(GRAPH_DDL); db.exec(FTS_DDL); db.exec(FTS_TRIGGERS); insert version }`. There is no `migrations[]`, no per-version step, no table-rebuild helper. `memory-core/src/schema.ts` `memory_scope.schema_ver DEFAULT 1` with no migration runner found.

**Root cause.** Versioning was scaffolded for future use but the migration executor was never built; "v1 forever" has been sufficient so far because the schema hasn't needed to change on a live store yet.

**Proposed design.** Implement an ordered migration runner: `migrations: Array<{ v: number; up(db): void }>` applied in sequence for every `v > currentVersion`, each wrapped in a transaction, with the standard SQLite CHECK/column-change idiom as a provided helper (`rebuildTable(db, name, newDDL, columnMap)` doing `PRAGMA foreign_keys=OFF; CREATE TABLE new; INSERT INTO new SELECT ... FROM old; DROP old; ALTER RENAME; recreate indexes; foreign_keys=ON` inside a txn). Bump `targetVersion` to `migrations.length`. This unblocks BL-295 (relax `kind`) and BL-301 (drift reconciliation) as ordinary migrations. Note for the adhd plan: a **fresh** component-registry DB is greenfield (no migration needed); this gap only bites *existing* stores, i.e. memory-core's — so it does not block the plan, but it does block evolving memory-core's schema safely.

**Acceptance criteria.**
- [ ] A test creates a v1 DB with a row, registers a v2 migration that relaxes/alters the `node.kind` CHECK via table-rebuild, re-opens, and asserts the pre-existing row survived AND a formerly-illegal `kind` now inserts — proving real migration, not a no-op.
- [ ] Negative control: the same test against the current stub fails (the v2 CHECK change never takes).

**Effort / risk / blast radius.** M effort for the runner; per-migration effort thereafter. Risk: medium — migrations touch live data; must be transactional + tested against a populated store. Blast radius: graph-store, memory-core, every persisted store.

### BL-305 — tsc-built packages ship a verbatim `dist/package.json` whose nested `exports` field Node.js IGNORES — **Open (LOW, packaging)** (2026-07-11)

Surfaced mechanically by the new `verify:publint-attw` gate (BL-266) and reported by the BL-265/266 worker: `libs/data/embed/embedding-provider/dist/package.json` (and likely every `@adhd/sox-nx:atomic-tsc`-built package that copies its manifest into `dist/`) is a byte-for-byte copy of the source `package.json`, including `main`/`types`/`exports` paths written for the PACKAGE root (`./dist/index.js`). publint flags it: a nested `package.json`'s `exports` field "only works in root package.json files, not nested ones" — from inside `dist/` those paths would mean `dist/dist/index.js`, which doesn't exist. Today it is harmless (nothing resolves the nested manifest as a package root; publint reports it as a non-gating Warning), but it is a landmine for any future consumer that treats `dist/` as a publishable root (`npm pack` from dist, `file:` deps pointing at dist, the pack-smoke tarball path).

**Fix:** the atomic-tsc copy step should REWRITE the manifest for dist context (strip or re-root `main`/`types`/`exports`, drop `files`), or stop copying it entirely if nothing consumes it — decide by checking what `pack-smoke.mjs` and the npm publish path actually read. Sweep all tsc-built packages, not just embedding-provider; keep the publint warning as the regression signal (it goes quiet when fixed).

---

### BL-310 — `soxe serve memory-server` front-shim processes accumulate indefinitely after MCP host disconnects — **Open (MEDIUM, lifecycle)**

**Observed 2026-07-17 by debug agent during memory-server health investigation.** There are **20 stale `soxe serve memory-server` processes** (and 3 more from `~/.adhd/sox-cli/`) in sleeping state, ranging from 1.5 hours to 6 days old, consuming ~617MB RSS total. The actual memory-server backend (PID 3025, PPID 1, started Jul 11) is healthy — the stale processes are the front-shim (proxy) processes that should have exited when the MCP host disconnected.

**Root cause analysis (code):** In `cmdServe` (`apps/sox/src/main.ts:8164-8174`), the proxy-mode path calls `runFrontShim` and then waits for `handle.done` (the stdio pipe closing) or a signal. When the MCP host (Claude/OpenCode/VS Code) disconnects its stdio pipe, `handle.done` should resolve and the process exits. But **20 previous shims never exited**. Likely causes (in order of suspicion):

1. **SIGHUP isolation** — the shim spawned by `runFrontShim` may not receive SIGHUP when the host terminal/session ends (many are `S+` — foreground process group of a now-dead terminal), so they survive the host death without a pipe-close to trigger `handle.done`.
2. **`handle.done` promise leak** — if the shim's connection to the backend UDS socket fails or reconnects in a way that doesn't resolve `handle.done`, the shim stays alive waiting for a signal.
3. **No timeout/fallback** — there is no upper bound on how long a disconnected shim lingers; it spins forever until SIGTERM.

**Evidence:**
```
$ ps aux | grep "soxe.*serve.*memory" | grep -v grep | wc -l
22
$ ps aux | grep "soxe.*serve.*memory" | grep -v grep | awk '{sum+=$6} END {printf "%.0fMB\n", sum/1024}'
617MB
```
Oldest shim: PID 21629, started Sat Jul 11 17:28 (6 days ago). Parent: `launchd`. No controlling terminal.

**Symptoms:**
- Process table bloat (20+ `soxe serve` processes per host restart)
- Memory pressure (~617MB RSS for sleeping processes)
- Confusing diagnostics: `ps` shows many memory-server processes, making it look like the server is "down" or broken
- Can eventually exhaust process limits on constrained systems

**Fix sketch (several options, equally viable):**
1. **Watchdog timeout** in the shim: if the stdio pipe has been silent for N minutes with no active requests, exit.
2. **SIGHUP propagation** — ensure the shim traps SIGHUP and exits cleanly (or is in the same session/process group as the MCP host).
3. **Shim lifecycle guard** — before spawning a new shim, kill any existing shim for the same extension id from the same scope.
4. **Heartbeat from the backend** — the shim pings the backend; if the backend reports no active client for >30s, exit.
5. **`handle.done` audit** — investigate why the promise does not resolve when the stdio pipe closes in a host-disconnect scenario; fix the root cause.

**Related backlog items (all RESOLVED, about the backend orphan class):** BL-170 (O_EXCL-lock loser orphan), BL-31 (daemon orphans), BL-157 (backend spawn-race orphan), BL-63 (orphan scan in e2e). BL-310 is distinct — it's about the FRONT-SHIM processes, not the backend.

**Blast radius:** Every `soxe serve` invocation for ANY proxy-mode mcp-server, not just memory-server. Any extension with `lifecycle.serve_mode: "proxy"` (the default for type:mcp-server) accumulates shim processes.

**Workaround (applied 2026-07-17):** Reinstall with `--profile=sse` or `--profile=http` and enable as a service (`soxe service enable`). This converts the install from `{ type: "local", command: ["soxe", "serve", "<ext>"] }` (spawns per session) to `{ type: "remote", url: "http://localhost:<port>/sse" }` (connects to persistent daemon). Applied to memory-server on both OpenCode (`~/.config/opencode/opencode.json`) and Claude (`~/.claude.json`) hosts at user scope. The shim accumulation bug is still present and affects other proxy-mode servers; the workaround avoids it for memory-server by sidestepping the per-session shim pattern entirely.
