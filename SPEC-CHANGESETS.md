# SPEC-CHANGESETS — backfill 9 missing `.changeset/*.md` (BL-460 gate is RED)

Architect packet for `feat/bl460-changeset-backfill`. Worktree:
`/Users/nix/dev/ai/sox-ecosystem/.worktrees/bl460-changeset-backfill`.

Toolchain verified in-worktree: `pnpm install` succeeded (6.2s, shared store hit). `npx nx test
memory-core` ran to completion (54/55 files passed; the one failing file,
`telemetry-crash-durability.spec.ts`, is a pre-existing flaky-under-load spawn test unrelated to this
packet — do not touch it, do not "fix" it as part of this work).

## 1. Root cause

`scripts/check-changeset-surface.ts` (read in full — `/Users/nix/dev/ai/sox-ecosystem/.worktrees/bl460-changeset-backfill/scripts/check-changeset-surface.ts:1-422`)
byte-diffs each publishable package's local `dist/*.d.ts` against the `.d.ts` extracted from the
tarball at `dist-tags.latest` on the npm registry, and fails if any package differs with no
`.changeset/*.md` in the tree naming it (`check-changeset-surface.ts:377-401`). Run against `main`
(root = `/Users/nix/dev/ai/sox-ecosystem`, script invoked from the worktree but pointed at main's
root — see §6), it reproduces the finding's exact 9-package list and confirms `ls .changeset/*.md`
is empty (`check-changeset-surface.ts:389,397-401` — the `pending` set built from
`pendingChangesetPackages()` at line 336/138-162 is empty because no `.md` file exists under
`.changeset/`).

The 9 packages carry real, un-recorded source changes — landed across several recent BLs (BL-376,
BL-405/410/432/471 in embedding-provider; BL-461 in store-adapter; TR-1/TR-2/BL-146 in mcp-runtime;
BL-62/SA-3/SA-4 in service-proxy; the opencode host in host-registry/manifest/install-engine;
crash-loop/env-policy/os-unit/reconcile in host-runtime) — with zero corresponding `pnpm changeset`
run. That is BL-460 exactly as filed: shape shipped, changeset never recorded.

## 2. The diff mechanism I used, and why it's trustworthy here

`node_modules/.cache/check-changeset-surface/<name>@<version>.tar` (populated by the script itself
on the run I made against main's root) holds the exact tarball bytes the gate diffs against —
immutable per the script's own cache contract (`check-changeset-surface.ts:36-40`). I extracted each
cached tarball with `tar -xzf` into a scratch dir and ran `diff -ru` against the corresponding
package's live `dist/`, excluding `*.js`/`*.map`/`*.cjs`/`*.mjs` (script `diffone.sh` under
`/private/tmp/claude-502/.../scratchpad/bl460/`) — i.e. the SAME bytes the gate itself compared,
read directly rather than re-derived. No `nx build` was run; every `dist/` inspected is whatever was
already on disk in `/Users/nix/dev/ai/sox-ecosystem` (main checkout — dist/ is git-ignored
everywhere per `.gitignore:4`, so this worktree has none of these artifacts and none were built to
produce this spec).

## 3. Per-package finding and ruling (the semver decision, and why)

### 3.1 `@adhd/sox-authoring` — **patch**, and this is a deliberate exception to "always something real"

Diff is `dist/index.d.ts`, `dist/templates/service/index.d.ts`, `dist/writer.d.ts` — every hunk is
either a `sox` → `soxe` rebrand in a comment/docstring, or a stale doc count fixed from "6 active
types" to "7 active types" (the `ActiveType` union itself — `export type ActiveType = 'agent' |
'skill' | 'mcp-server' | 'hook' | 'command' | 'bundle' | 'service';` — is **byte-identical** between
the published tarball and local `dist/index.d.ts:34`; I diffed the two `grep -n "ActiveType"` outputs
directly and confirmed identity). **Ruling: no consumer-observable change.** Per the gate's own
documented policy (`check-changeset-surface.ts:62-65`, "Decision C... never fewer [changesets]"),
still file one — **patch**, summary states explicitly this is comment/doc-only with zero surface
delta, so the changelog reader isn't misled into expecting behavior change. Do NOT skip filing this
one; the gate will stay red on this package otherwise (§6 acceptance criterion 2).

### 3.2 `@adhd/sox-embedding-provider` — **major**

Real breaking signature change, quoted:

```
-constructor(model: string, dimensions: number, cacheDir: string);
+constructor(model: string, dimensions: number, cacheDir: string, sharedClient?: SharedFastembedProcessClient);
```
(additive, optional — not the breaking one)

```
-export declare function warmupTimeoutMs(): number;
+export declare function warmupTimeoutMs(cacheHit: boolean): number;
```
(`libs/data/embed/embedding-provider/dist/index.d.ts` vs published `0.1.0` — file:
`/Users/nix/dev/ai/sox-ecosystem/libs/data/embed/embedding-provider/dist/index.d.ts:167` region)

`warmupTimeoutMs` gained a **required, non-optional parameter**. Any TS consumer calling
`warmupTimeoutMs()` with zero arguments (the only legal call under the published `0.1.0` signature)
fails to compile against the new `dist/index.d.ts`. This is exactly the class of change the BL-376
context note in the task calls "known-real" — MAJOR bump is correct, no alternative reading survives
(it is not additive: the old call site is now a type error, not merely unused).

Everything else in this package is additive and does NOT change the bump (still worth naming in the
changeset body for changelog quality): new exports `isPidAlive`, `checkAndClaimFastembedLock`
(`fastembedProcessHost.d.ts:60,67`), `isModelCached` (`index.d.ts:167` region), new module
`fastembedLock.d.ts` exporting `FastembedLockInfo` + `resolveFastembedLockPath` (BL-471), new
`EmbeddingProviderMetadata.execution_provider?: string` optional field, new `SharedFastembedProcess`
constructor overload, new telemetry-carrying JSDoc on `request()`/`terminate()` (BL-432/BL-405 —
comment-only, no signature change on those two).

**Losing alternative considered and rejected:** treating this as minor because the added param has
an obvious call-site fix. Rejected — semver major is about "does the published type signature reject
code that compiled against the old one," not about fix difficulty. It does; major stands.

### 3.3 `@adhd/sox-store-adapter` — **minor**

All hunks additive: `canonicalFtsIndexName(table): string` and `resolveExistingFtsIndexName(adapter,
table): Promise<string | null>` new exports in `fts-dialect.d.ts` (BL-461); an entirely new module
`fts-orphan-guard.d.ts` (types `OrphanedFtsIndex`, `FtsOrphanRepair`, `FtsOrphanGuardResult`,
functions `findOrphanedFtsIndexes`, `nextShadowIndexName`, `guardSucceeded`,
`guardOrphanedFtsIndexes`, `describeFtsOrphanGuard`) re-exported from `index.d.ts` via `export *
from './fts-orphan-guard.js'`. No removed or narrowed export found in any of the 3 flagged files.

Curiosity worth recording, not blocking: the published `0.2.0` tarball's embedded `dist/package.json`
itself carries `"version": "0.1.2"` — a stale artifact from whatever built that publish — while the
registry's own packument correctly reports `dist-tags.latest = 0.2.0` and the local source
`package.json` also says `0.2.0`. This is an embedded-metadata inconsistency in a *previous* publish,
not something this packet's changeset can or should correct (the implementer must NOT hand-edit
`dist/package.json`; it regenerates from `libs/data/store/store-adapter/package.json` at build time,
and no build runs in this packet — see §5).

### 3.4 `@adhd/sox-host-registry` — **minor**

All hunks additive: new `opencodeHost` export from a new `opencode.d.ts` module; new `McpConfig`
interface (`keyPath`, `value` methods) re-exported as a type; `Surface` interface gains two optional
fields (`mcpConfig?: McpConfig`, `postInstallHint?: string`); `CapabilityId` union widened with
`'object-array-merge'`. No removed or narrowed export. `claude.d.ts`/`codex.d.ts`/`internal.d.ts`
carry only `sox`→`soxe` comment rebrands plus real doc content about the new BL-471-adjacent
`mcp-trust-sync` behavior (documentation of already-shipped-elsewhere behavior, not a type change in
THIS package).

**Union-widening judgment call, ruled explicitly:** `CapabilityId` gaining a member is treated as
additive/minor, not major, by the same convention npm/TS ecosystems apply to string-union widening on
a type that flows as *data* (surfaces declare which capability they use; nothing in this package
exhaustively switches over `CapabilityId` in a way whose compile would break — verified: the only
`case 'file-drop'` / etc. exhaustive switches over `CapabilityId` live in `@adhd/sox-install-engine`'s
own source, which is being updated in the same wave — see 3.6). A consumer of `@adhd/sox-host-registry`
alone who writes an exhaustive switch over `CapabilityId` with no `default` arm could theoretically
break; this is the standard "widening a public discriminant union" risk every TS library ships with
new enum-like values, and is called out in the changeset body rather than escalated to major.

### 3.5 `@adhd/sox-host-runtime` — **minor**

Largest diff of the 9 (14 files) but every substantive hunk is additive. Four wholly new modules,
each re-exported from `index.d.ts`:

- `crash-loop.d.ts` — `CrashLoopGuard`, `CRASH_LOOP_MAX_FAILURES`, `CRASH_LOOP_WINDOW_MS`, marker
  read/write helpers.
- `env-policy.d.ts` — `scrubEnv`, `scrubEnvReported`, `isDeniedEnvKey`, `formatDeniedEnvWarning`,
  `ENV_BASE_ALLOW`, `ENV_ALLOW_PREFIXES`, `ENV_DENY_PREFIXES`, type `ScrubbedEnv`.
- `os-unit.d.ts` — `detectOsSupervisor`, `deriveOsUnitSpec`, `enableOsUnit`, `disableOsUnit`,
  `restartOsUnit`, `unloadThenReap`, `restartAndVerify`, and ~10 associated types.
- `reconcile.d.ts` — `classifyReconcileTargets`, `sweepProxyBackendLocks`, `quickReconcile`, and
  associated types.

Plus additive extensions to existing modules: `reaper.d.ts` gains `readProcessEnv`,
`findOrphansByServiceId`, `gatherProcessSnapshot` + types `ProcessRowSource`, `ProcessSnapshotRow`
(`reaper.d.ts:203-271` region); `log-manager.d.ts` gains `findAllLogStreamsForExt`,
`findMostRecentLogFile` + type `LogStreamDescriptor`; `supervisor.d.ts`'s `SupervisorOptions` gains
an optional `crashLoop?: {...}` block and `ProcessSupervisor` gains a public `isCrashLooped(): boolean`
method (`supervisor.d.ts:376-414` region) — both additive, no existing member of either interface
removed or narrowed. `index.d.ts` re-export list only ever grows (`index.d.ts:29-53` — every line
diffed is `+` appending new named exports or widening an existing `export {...}` clause; nothing was
removed from any existing export clause). Everything else is `sox`→`soxe` comment rebrand or a doc
example string change (`"memory-daemon"` → `"tokenguard"` in a `@param` example — text only, not a
type).

No removed or narrowed export found anywhere in this package's diff. Minor stands.

### 3.6 `@adhd/sox-install-engine` — **minor**

All hunks additive. New module `mcp-trust-sync.d.ts` (`syncMcpTrustToProjects`,
`reverseMcpTrustFromProjects`, types `TrustSyncResult`, `SyncTrustOptions`) re-exported from
`index.d.ts`. New capability module `capabilities/object-array-merge.d.ts` (new file, not diffed
line-by-line since it has no prior version to diff against — entirely new). `install.d.ts` gains
`SCOPES: Scope[]` constant, `writeLockfileAtomic(lockPath, lockfile): void` function, and
`InstallDescriptor` gains four new optional fields (`configValues?`, `configEntries?`,
`configIdentityField?`, `configIdentityValue?`); `ApplyResult` (actually `DeclarativeInstallResult`
per the type export list) gains optional `hints?: string[]`. `ledger.d.ts`'s `CapabilityId` union
widened with `'object-array-merge'` (same union-widening judgment as 3.4, ruled minor for the same
reason) and `LedgerAction` gains optional `meta?: Record<string, unknown>`. `ownership.d.ts`'s
`OwnedEntry` discriminated union gains two new tagged variants (`kind: 'object-array-values'`, `kind:
'os-unit'`) — additive per the same "new union member ≠ major for a data-flow discriminant" reasoning
as 3.4, plus two new methods on the ownership index class (`static dedupeEntries`, `compact()`, both
new, nothing removed).

No removed or narrowed export found. Minor stands.

### 3.7 `@adhd/sox-manifest` — **minor**

`ExtensionManifest.hosts?: Array<'claude' | 'codex'>` widened to `Array<'claude' | 'codex' |
'opencode'>` (`index.d.ts` — array-of-union widening, the least risky variant of union widening
since it types a field CONSUMERS WRITE INTO when authoring a manifest, not one they narrow-match
against — old manifests remain valid, new manifests may now legally include `'opencode'`). Four new
top-level exports: `VALID_TYPES`, `VALID_RUNTIMES`, `VALID_HOOK_EVENTS` (all `Set<string>`), and
`KNOWN_HOSTS: Set<string>`. No removed or narrowed export. Minor stands.

### 3.8 `@adhd/sox-mcp-runtime` — **minor**

`serves` tuple widened `readonly ["stdio", "sse"]` → `readonly ["stdio", "sse", "http"]` (a value
constant's inferred literal type, additive — appended, not reordered). `TransportMode` union widened
`'stdio' | 'sse'` → `'stdio' | 'uds' | 'http' | 'sse'`. `TransportOptions` interface gains 4 optional
fields (`transports?`, `bindAddress?`, `socketPath?`, `authToken?`) — `mode?`/`port?`/`host?` retained
unchanged. `TransportHandle` gains optional `socketPath?`. New exports: `buildToolDispatch`,
`connectStreamableHttp`, `connectUds`, `connectStdioTransport`, `resolveTransports`,
`validateBindAuth`, `authMiddleware`, `isLoopback`, `resolveBindHost`, new type `ToolDispatch`.

**The one export that looks like a removal and is ruled NOT one:** `connectSse` changes from
`export declare function connectSse(server: Server, opts?: TransportOptions): Promise<TransportHandle>;`
to `export declare const connectSse: typeof connectStreamableHttp;` — I checked `connectStreamableHttp`'s
own declared signature and it is `(server: Server, opts?: TransportOptions): Promise<TransportHandle>`,
i.e. structurally identical to the old `connectSse` signature. A caller with `import { connectSse }
from '@adhd/sox-mcp-runtime'; connectSse(server, opts)` compiles unchanged before and after. Ruled:
**not a breaking change**, function→const-of-matching-type is a rename-preserving-shape, correctly
marked `@deprecated` in the new JSDoc rather than removed.

**Behavioral note that does NOT change the bump but MUST be in the changeset body:** the documented
default HTTP port changed (comment: "then 0 (random)" → "then 3000") and the underlying wire protocol
served on that port changed from raw SSE (`GET /sse`, `POST /message`) to StreamableHTTP session
framing — this is a real behavior change for anything depending on the OLD literal SSE endpoint shape
at runtime, but it is invisible to a byte-diff of `.d.ts` files (same declared function signature,
different implementation) and therefore correctly out of this gate's detection scope. Recorded here so
the reviewer doesn't treat "the diff mechanism didn't catch a behavior change" as a defect in this
packet — it's a known, documented limit of Decision C (`check-changeset-surface.ts:15-20`,
"a byte diff may false-positive on comment churn... but never false-negatives a real TYPE change" —
it explicitly does NOT claim to catch behavior changes with an unchanged type signature). **Flag this
explicitly in the changeset prose** so a human reading the changelog knows to check for SSE-endpoint
dependents, even though the semver bump itself stays minor.

No removed or narrowed TYPE found. Minor stands.

### 3.9 `@adhd/sox-service-proxy` — **minor**

All hunks additive: new `ClientContext` interface (`{ project_path: string }`, BL-62) re-exported
from `index.d.ts`; `ServeBackendOptions` gains optional `inheritFd?: number` (SA-3, socket
activation); new `handshakeBackend(socketPath, timeoutMs?): Promise<boolean>` export (SA-4);
`FrontShimOptions` gains optional `httpPort?: number` and `clientProjectPath?: string`. No removed or
narrowed export.

**Behavioral note, same treatment as 3.8:** `serveBackend`'s stale-socket handling changed from
"always unlink a stale socket file before bind" to "probe-connect first; refuse with a structured
`E_LIVE_SOCKET` error if the socket answers" (SA-4 hardening) — a real new failure mode for any
caller not already going through `ensureBackend()` (which the docstring says is now the required
entry point). Same reasoning as 3.8: invisible to a `.d.ts` diff (still `Promise<BackendHandle>`,
just may now reject with a new error shape at runtime), correctly out of gate scope, must be named in
the changeset body.

No removed or narrowed TYPE found. Minor stands.

## 4. Decisions ruled (collected, for quick implementer reference)

| # | Decision | Ruling | Losing alternative & why it loses |
|---|---|---|---|
| D1 | Bump for comment-only diff (`sox-authoring`) | **patch**, filed anyway | Skipping it entirely loses — the gate's own Decision C (line 62-65) says file even for comment churn; a skip leaves the gate red (acceptance §6.1). Calling it "no changeset needed" is not an option this gate accepts. |
| D2 | Bump for a new REQUIRED parameter on an existing exported function (`warmupTimeoutMs`) | **major** | "Minor because trivial to fix" loses — semver major is defined by whether OLD call sites still compile, not by fix cost. |
| D3 | Bump for widening a string-literal union that is data consumers WRITE (`CapabilityId`, `hosts`, `TransportMode`, `OwnedEntry.kind`) | **minor** across all 4 occurrences | "Major, because an external exhaustive switch could break" loses — this is the standard, ecosystem-wide treatment of union/enum widening in a published `.d.ts`; treating every additive union member as major would make the gate cry wolf on nearly every capability/mode addition this repo makes, defeating its own signal value. Verified no in-repo exhaustive switch over these types breaks (3.4, 3.6). |
| D4 | Whether a `function` → `const: typeof otherFn` rename with an identical call signature is a removal (`connectSse`) | **not a removal**; minor-compatible | Treating it as removed-then-readded loses — TypeScript structurally accepts the same call at the same call sites; nothing observable to a consumer changed except a new `@deprecated` tag. |
| D5 | Whether a same-`.d.ts`-signature runtime behavior change (SSE→StreamableHTTP wire protocol; unlink-stale→refuse-live socket policy) escalates the semver bump | **no** — stays minor, but MUST be narrated in the changeset body | Escalating to major loses — the gate's own documented scope (Decision C) is a type-shape diff, not a behavior diff; conflating the two would require rebuilding the gate's entire mechanism (out of bounds for this packet) and isn't what BL-460 asked for. The correct remediation for a real behavior-only break is a *separate* BL against the gate's scope, not silently majoring an unrelated package here. |
| D6 | Whether to hand-correct the stale `0.1.2` embedded in published `sox-store-adapter`'s `dist/package.json` | **no-op**; note only | It is a previous publish's artifact, immutable per npm; nothing in this worktree can retroactively fix an already-published tarball, and the current source `package.json` is already correct at `0.2.0`. Not this packet's problem to solve. |
| D7 | Whether any of the 9 needs a **coordinated cross-package changeset** (one `.md` naming multiple packages) vs. 9 independent files | **9 independent files**, one per package | Each package's change is independently attributable to a different BL/feature line (embedding-provider↔BL-376/432/471, store-adapter↔BL-461, host-registry+manifest+install-engine↔the opencode host addition — related but each package's public surface changed for a locally coherent reason). Coordinating them into one changeset would obscure per-package attribution in `CHANGELOG.md` and violates the precedent set by `0f63dfe0` (grouped changeset used only when the SAME logical feature spans packages with the SAME bump — not the case here: bumps differ, D2 is major and the rest are minor/patch). |

## 5. File-by-file: what changes, what must NOT change

**In scope — create these 9 files, nothing else:**

```
.changeset/bl460-sox-authoring-rebrand.md              (patch)
.changeset/bl460-sox-embedding-provider-warmup.md       (major)
.changeset/bl460-sox-store-adapter-fts-orphan-guard.md  (minor)
.changeset/bl460-sox-host-registry-opencode.md          (minor)
.changeset/bl460-sox-host-runtime-crashloop-osunit.md   (minor)
.changeset/bl460-sox-install-engine-object-array-merge.md (minor)
.changeset/bl460-sox-manifest-opencode.md               (minor)
.changeset/bl460-sox-mcp-runtime-multi-transport.md     (minor)
.changeset/bl460-sox-service-proxy-sa3-sa4.md           (minor)
```

Filenames are free-form per changesets convention (any unique `.md` under `.changeset/`) — the names
above are suggestions for traceability back to this spec; the implementer may use `pnpm changeset`
interactively and let it generate random slugs instead, AS LONG AS each file's YAML frontmatter names
exactly the one package it covers (D7) with the exact bump ruled in §3/§4, and the body quotes the
`.d.ts` line(s) that justify the bump (mirroring the `0f63dfe0` precedent shown in §"toolchain
verification" above). Each `.md` MUST use the frontmatter format:

```markdown
---
"@adhd/sox-<pkg>": <major|minor|patch>
---

<prose, quoting the .d.ts diff line(s)>
```

**Explicitly OUT OF BOUNDS — do not touch:**

- `scripts/check-changeset-surface.ts` — do not weaken, do not add an ignore-list, do not change the
  diff mechanism. If §3.8/§3.9's "behavior change invisible to `.d.ts` diff" observation is judged
  worth acting on, that is a NEW backlog item against the gate's scope, filed via
  `backlog_create_item`, never a same-packet edit to this file.
- `scripts/check-publishable.ts` — the walker is deliberately duplicated rather than shared
  (`check-changeset-surface.ts:22-28`); do not refactor either into a shared module.
- Any `dist/` — no `nx build` runs in this packet (§ Risks). The 9 packages' `dist/` on disk in
  `/Users/nix/dev/ai/sox-ecosystem` (main checkout) already have the correct, already-built content
  this packet reasons about; the worktree's own `dist/` for these packages does not exist at all
  (gitignored, never built there) and creating it is unnecessary — `check-changeset-surface.ts`
  running from the worktree but pointed at a `root` argument of the main checkout (§6) is how the
  finding was verified without building. The implementer does not need a local build to pass the
  gate; the gate only checks that a changeset EXISTS, not that it matches a specific diff by content.
- Any package's `src/` — this packet is documentation-only (`.changeset/*.md` files). No source
  edit is in scope; if a source edit looks tempting (e.g. "fix" the `sox-store-adapter` stale
  `dist/package.json` version), that is D6 — explicitly ruled a no-op.
- `BACKLOG.md` / `CHANGELOG.md` — per ADR-0011 / house rules, do not hand-edit; if a new finding
  surfaces (e.g. the §3.8/§3.9 behavior-vs-type gate-scope gap), file it with `backlog_create_item`
  and verify with `backlog_get_item`.
- `pnpm-lock.yaml` — no `workspace:*` edges change in this packet; do not run a relock unless
  `pnpm install` unexpectedly modifies it (if it does, that's a signal something else drifted and
  should be reported, not silently committed).

## 6. Acceptance criteria (each names the BL, each has a stated RED arm)

**AC-1 (BL-460 primary).** `npx tsx scripts/check-changeset-surface.ts <path-to-main-checkout>`
exits **0** once all 9 files exist and correctly name their package.
_RED arm, already captured and reproducible right now:_ run it unmodified before any `.changeset/*.md`
exists — exit 1, with the exact 9-package FAIL block quoted in the task and reproduced verbatim in
this worktree's own run (§7 command below). This IS the current state; the implementer's job is to
turn it green by adding files, not by editing the script.

Note: because this worktree's `dist/` for these 9 packages doesn't exist locally (§5), point the
script at the MAIN checkout's root as the positional arg so it diffs real, already-built `dist/`
content: `npx tsx scripts/check-changeset-surface.ts /Users/nix/dev/ai/sox-ecosystem`. Running it
with no argument (defaulting to `process.cwd()`, the worktree) will report all 9 as `WARN ... no
local dist/ ... skipping` and pass trivially WITHOUT proving anything — that is a false green, not
acceptance evidence. The reviewer must re-run pointed at the main checkout's root and quote the `OK`
line, not a WARN-suppressed pass.

**AC-2 (per-package correctness).** For each of the 9 packages, the `.changeset/*.md` frontmatter
bump matches §3's ruling exactly:
`sox-authoring=patch, sox-embedding-provider=major, sox-store-adapter=minor, sox-host-registry=minor,
sox-host-runtime=minor, sox-install-engine=minor, sox-manifest=minor, sox-mcp-runtime=minor,
sox-service-proxy=minor`.
_RED arm:_ any file with a different bump than ruled (e.g. filing `sox-embedding-provider` as minor)
is a spec violation — the reviewer must independently re-derive the `warmupTimeoutMs` signature diff
(§3.2) and confirm major, not trust the filename.

**AC-3 (changeset content honesty — the task's explicit "do not write nine 'internal changes'"
requirement).** Every `.md` body quotes at least one real `.d.ts` line (not paraphrased) that
justifies its bump, per the quotes already extracted in §3. `sox-authoring`'s body explicitly states
there is no consumer-visible change (D1) rather than implying one exists.
_RED arm:_ a changeset body that says only "internal changes" or omits a quoted diff line fails this
criterion even if the bump number is correct — verify by grep: `grep -L '\`' .changeset/bl460-*.md`
must return nothing (every file contains at least one backtick-quoted code reference).

**AC-4 (no scope creep).** `git diff --stat main...feat/bl460-changeset-backfill` (from the worktree)
shows ONLY 9 new files under `.changeset/` plus this `SPEC-CHANGESETS.md` — nothing under `src/`,
`dist/`, `scripts/`, `BACKLOG.md`, `CHANGELOG.md`, or `pnpm-lock.yaml`.
_RED arm:_ any other path in the diff is a violation of §5's out-of-bounds list; the reviewer rejects
the packet back to the implementer rather than trimming it themselves.

## 7. Risks — data/artifact destruction, and the sequencing that avoids it

- **`nx build` risk (BL-235) does not apply to this packet at all** — no build is required or
  permitted (§5). The one command that reads `dist/` (`check-changeset-surface.ts`) only READS; it
  never writes into a package's `dist/`.
- **`nx test` risk (BL-456)** applies only to the toolchain-verification step already done
  (`npx nx test memory-core`, §"toolchain verified" above) and is irrelevant to the rest of this
  packet, which touches no `src/` — there is nothing for the implementer to `nx test` unless they
  want to re-verify the worktree is still healthy, which is optional, not required by AC-1..AC-4.
- **Cross-checkout risk:** running `check-changeset-surface.ts` pointed at the MAIN checkout's root
  (AC-1's note) reads files there but writes nothing there except the registry-tarball cache under
  `/Users/nix/dev/ai/sox-ecosystem/node_modules/.cache/check-changeset-surface/` (already populated
  by this architect pass — reusable, no re-download needed, and harmless: it's a read-through cache
  keyed by immutable published-version tarballs, not a build artifact). Do not `rm -rf` that cache
  dir; do not treat it as something to clean up as part of this packet.
- **Concurrent-agent risk:** other agents are live in the main checkout per the dispatch instructions.
  This packet's only interaction with the main checkout is a read-only diff/cache-populate; it does
  not commit there and does not modify anything under `/Users/nix/dev/ai/sox-ecosystem` outside the
  `node_modules/.cache` path noted above. All actual work product (the 9 `.md` files) is committed in
  the WORKTREE on `feat/bl460-changeset-backfill`, never in main.
- **No data-loss risk in this packet** — it adds files, it does not delete or overwrite anything
  live.

## 8. The gate — exact nx targets / commands the implementer runs

1. `cd /Users/nix/dev/ai/sox-ecosystem/.worktrees/bl460-changeset-backfill`
2. Create the 9 `.changeset/*.md` files per §5/§3 (either `pnpm changeset` interactively, answering
   its prompts per §4's bump table, or hand-write the frontmatter — both are acceptable; AC-2/AC-3
   are the actual bar, not the authoring method).
3. `npx tsx scripts/check-changeset-surface.ts /Users/nix/dev/ai/sox-ecosystem` — must print
   `check-changeset-surface: OK — ...` and exit 0 (AC-1). Do NOT run it with no argument (see AC-1's
   false-green note).
4. `node tools/check-backlog-markers.mjs` and `node tools/plan-status.mjs --check` — not because this
   packet touches `BACKLOG.md`/plan files, but because they are the standard pre-commit hygiene gates
   this repo's hooks run; confirm they're clean before committing so `.husky/pre-commit` doesn't block.
5. No `nx build`/`nx test`/`nx lint`/`nx typecheck` target applies — this packet contains zero
   TypeScript, zero build-graph-relevant files. Do not invent a target to satisfy a "run the gate"
   instinct; `.changeset/*.md` is not nx-tracked.
6. Commit by explicit pathspec: `git commit .changeset/bl460-*.md -m "chore(release): backfill 9
   missing changesets for the BL-460 surface gate"` (lowercase subject, scope `release` per house
   rules). Do not `git add -A`.
7. Hand off to reviewer with: the AC-1 command's exact stdout (the `OK — N publishable package(s)...`
   line), and the `git diff --stat` output proving AC-4.
