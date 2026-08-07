# SPEC-CHANGESETS-2 — close out BL-460 (gate is red: 2 packages, not the 9 already fixed)

Architect packet for `feat/bl460-changeset-close`. Worktree:
`/Users/nix/dev/ai/sox-ecosystem/.worktrees/bl460-changeset-close`, branched from `main`
(`1d260f72`) then merged with `feat/bl460-changeset-backfill` (`9295c09c`) — carries the 9 already-
reviewed changesets and `SPEC-CHANGESETS.md` unmodified. **Do not re-litigate the 9; this packet
adds exactly 2 more.**

Toolchain verified in-worktree: `pnpm install` completed (rebuilt `better-sqlite3`/`sqlite-vec`
postinstall, ~5s, shared store hit — no `node_modules` hand-fixing needed). No nx target was run
(none is required — see §5/§8; this packet, like its predecessor, is `.changeset/*.md`-only).

## 1. Root cause — measured fresh against current `main`, not inherited

`scripts/check-changeset-surface.ts` (unmodified, read in full at
`/Users/nix/dev/ai/sox-ecosystem/.worktrees/bl460-changeset-close/scripts/check-changeset-surface.ts:1-423`)
byte-diffs every publishable package's local `dist/*.d.ts` against the `.d.ts` extracted from the
`dist-tags.latest` tarball on the npm registry, and fails (`:397-401`) if any package differs with
no `.changeset/*.md` in the tree naming it. The 9 changesets from the prior packet are real and
correct (reviewer already re-derived §3.1–3.9 of `SPEC-CHANGESETS.md` independently) — but the
prior implementer's claimed `exit 0` was never reproduced by a working invocation. I re-ran the
**corrected scratch-root procedure** (`SPEC-CHANGESETS.md:325–351`) myself, this run, against
this worktree's merged tree:

```
SCRATCH=/private/tmp/claude-502/-Users-nix-dev-ai-sox-ecosystem/1a711339-d48c-4ab9-9448-75f55573747a/scratchpad/bl460-verify2
mkdir -p "$SCRATCH"
ln -s /Users/nix/dev/ai/sox-ecosystem/{libs,apps,extensions} "$SCRATCH/"
mkdir -p "$SCRATCH/.changeset"
cp /Users/nix/dev/ai/sox-ecosystem/.worktrees/bl460-changeset-close/.changeset/bl460-*.md "$SCRATCH/.changeset/"
npx tsx /Users/nix/dev/ai/sox-ecosystem/.worktrees/bl460-changeset-close/scripts/check-changeset-surface.ts "$SCRATCH"
```

Exit **1**. Every one of the 9 already-filed packages now reports `NOTE ... covered by a pending
changeset` (confirms the prior packet's content is correct and does not need to be touched). The
gate fails on exactly two packages that were never part of the original 9-package finding:

```
check-changeset-surface: FAIL — publishable surface changed with no changeset:
  - "@adhd/sox-graph-store": dist/*.d.ts differs from the published 0.5.3 (dist/index.d.ts) and no
    .changeset/*.md in this tree names this package.
  - "@adhd/sox-vector-store": dist/*.d.ts differs from the published 0.3.3 (dist/index.d.ts,
    dist/lancedb.d.ts) and no .changeset/*.md in this tree names this package.
```

This matches the task brief's "currently 11" reading exactly (9 covered + 2 uncovered = 11 total
drifted packages measured against the registry). `@adhd/sox-graph-store`'s local `dist/index.d.ts`
was rebuilt 2026-08-06 23:36 and `@adhd/sox-vector-store`'s 2026-08-06 23:51 (`ls -la` timestamps,
both after this worktree's own `main` merge base) — consistent with the brief's claim that
`PKT-74`/BL-448 and `PKT-07`/BL-389 landing on `main` rebuilt these two `dist/`s and is what grew
the set from 9 to 11. **I did not run `nx build` to produce these artifacts** — they were already
present, git-ignored, on disk in the shared checkout (`/Users/nix/dev/ai/sox-ecosystem`, not this
worktree) from whichever agent's build landed them; the scratch-root symlinks read them, nothing
writes them.

**The set may have grown again by the time the implementer runs this.** Re-run the exact scratch-
root command above (fresh `$SCRATCH`, current timestamp) as the FIRST implementation step, before
touching anything else, and diff its FAIL list against the two packages named here. If a third
package appears, that is new work this spec does not cover — stop and escalate back to architect
rather than inventing a bump for it unreviewed.

## 2. The diff mechanism — same cached-tarball technique as the original packet

The scratch-root run above populated `$SCRATCH/node_modules/.cache/check-changeset-surface/` with
the exact tarball bytes the gate diffs against (immutable per the script's own cache contract,
`check-changeset-surface.ts:36-40`). I extracted both packages' cached tarballs with `tar -xzf` and
ran `diff -u` against the live `dist/*.d.ts` in the main checkout — the same bytes the gate itself
compared, read directly:

```
tar -xzf "$SCRATCH/node_modules/.cache/check-changeset-surface/@adhd__sox-graph-store@0.5.3.tar" -C "$SCRATCH/extract-gs"
tar -xzf "$SCRATCH/node_modules/.cache/check-changeset-surface/@adhd__sox-vector-store@0.3.3.tar" -C "$SCRATCH/extract-vs"
diff -u "$SCRATCH/extract-gs/package/dist/index.d.ts" /Users/nix/dev/ai/sox-ecosystem/libs/data/graph/graph-store/dist/index.d.ts
diff -u "$SCRATCH/extract-vs/package/dist/index.d.ts"  /Users/nix/dev/ai/sox-ecosystem/libs/data/vectors/vector-store/dist/index.d.ts
diff -u "$SCRATCH/extract-vs/package/dist/lancedb.d.ts" /Users/nix/dev/ai/sox-ecosystem/libs/data/vectors/vector-store/dist/lancedb.d.ts
```

## 3. Per-package finding and ruling — **the brief's "additive-only" premise is wrong for both; I overrule it**

The task brief hedged both packages toward minor ("additive-only... unless your own diff read says
otherwise" for graph-store; "consider carefully" for vector-store) and told me to read the diffs
myself rather than inherit the reviewer's characterization. I did. **Neither package is additive.
Both are MAJOR.**

### 3.1 `@adhd/sox-vector-store` — **major** (the more clear-cut of the two)

`git log --oneline -- libs/data/vectors/vector-store/src/lancedb.ts` traces the change to
`e4c4eb6e` — "fix(vector-store): route LanceDbVectorBackend through StoreAdapter, not a raw sqlite
handle (BL-389)". Two files diff, both `dist/index.d.ts` and `dist/lancedb.d.ts`, and both show the
**same required-property rename**, not an addition:

`dist/lancedb.d.ts` (constructor config type):
```
-import type Database from 'better-sqlite3';
+import type { StoreAdapter } from '@adhd/sox-store-adapter';
...
     constructor(config: LanceDbVectorBackendConfig & {
-        db: Database.Database;
+        adapter: StoreAdapter;
     });
```

`dist/index.d.ts` (the `openLanceDbVectorStore` factory's config type — same shape, same rename):
```
 export declare function openLanceDbVectorStore(config: LanceDbVectorBackendConfig & {
-    db: import('better-sqlite3').Database;
+    adapter: StoreAdapter;
 }): LanceDbVectorBackend & VectorBackend;
```

Both `db` and `adapter` are **required** members (neither carries `?`). A consumer who wrote
`new LanceDbVectorBackend({ lancedbPath, db: myDb })` or `openLanceDbVectorStore({ lancedbPath, db:
myDb })` against the published `0.3.3` shape fails to compile against the new `dist/lancedb.d.ts` /
`dist/index.d.ts` on two independent counts: `db` is now an excess/unknown property, and `adapter`
is a missing required property. There is no additive reading of a required-field rename — this is
the textbook case the D2 ruling in the prior packet's spec already established the correct test for
("does the published type signature reject code that compiled against the old one" — yes, on both
axes at once).

**Ruling: major.** The brief's own citation of BL-389 as "a constructor signature change" undersold
it — it isn't a widened signature, it's an incompatible one.

### 3.2 `@adhd/sox-graph-store` — **major**, and the source's own docstring says so

`git log --oneline -- libs/data/graph/graph-store/src/index.ts` traces the change to `b64bc3d8` —
"fix(memory-core): open edge.rel CHECK on fresh-store DDL paths, widen EdgeRel (BL-448, PKT-74)".
Only `dist/index.d.ts` differs (confirmed against the gate's own report, which does not flag
`dist/rebuild-table.d.ts`). Three things changed in that file; two are genuinely additive
(`GraphBackendOpts` new optional interface; `constructor(adapter: StoreAdapter, opts?:
GraphBackendOpts)` and `createGraphBackend(adapter, opts?)` both gained an optional trailing
parameter — old call sites with one argument still compile). The third is not additive, and the
shipped code says so itself:

```
export type EdgeRel = 'MENTIONS' | 'SUPPORTS' | 'RELATES_TO' | 'DERIVED_FROM' | 'SUPERSEDES' |
  'SAME_AS' | 'ASSIGNED_TO' | 'MEMBER_OF' | 'PART_OF' | 'DEPENDS_ON' | (string & {});
```
(`libs/data/graph/graph-store/dist/index.d.ts`, `EdgeRel` declaration — published `0.5.3` had the
10-member closed union with no `(string & {})` branch.)

The in-tree JSDoc directly above this declaration (same file) states, verbatim, that this is
**"source-breaking in RETURN position, not additive: a consumer that exhaustively `switch`es on
`EdgeRecord.rel` (or otherwise narrows `EdgeRel` to `never` in a default arm) stops compiling once
this widens, because the `default` arm's type is no longer `never` — it is `string & {}`"** — and
cites its own regression test, `open-rel-check.bl448.spec.ts`'s `AC-Type`, as having *demonstrated*
the compile break, not merely asserted it. This is not a case where I have to independently reason
about whether an external exhaustive switch could exist and go looking for it — the package's own
authors already built and ran the proof that it breaks one, before this changeset was ever written.

**Why this overrules the prior packet's D3 precedent (`SPEC-CHANGESETS.md:243`, union-widening =
minor) rather than being inconsistent with it:** D3 covered `CapabilityId`, `hosts`, `TransportMode`,
`OwnedEntry.kind` — unions that are *data a consumer writes* (a manifest author picks a capability
id; nothing in those packages exhaustively switches over the full vocabulary in a way that breaks).
`EdgeRel` is structurally different: it is the type of a *field returned from queries*
(`EdgeRecord.rel`, `getEdges()` results) — a type callers are expected to narrow and switch over,
which is exactly the pattern D3 checked for and found absent in the four packages it covered. Here
it is present, self-documented, and self-tested. Treating `EdgeRel`'s widening as minor by
mechanically extending D3 would ignore the one piece of evidence D3 itself said would flip the
ruling ("nothing... exhaustively switches over `CapabilityId`... **verified**" — the verification is
the load-bearing part of that ruling, and for `EdgeRel` the verification comes out the other way).

**Losing alternative considered and rejected:** "no in-repo consumer breaks today (confirmed by
grep against `libs/memory-core/src`), so ship minor and let an external break surface as its own
bug report." Rejected — this package is `private: false` or it publishes to npm and BL-460 exists
specifically to catch exactly this shape of change (a real compile-breaking type delta shipping
with an inaccurate/absent severity signal) before it reaches a consumer's dependency bump. The
package's own author already wrote and ran a test proving the break; overriding that with "no
current consumer" would be scoring the changeset against this repo's needs, not the published
package's contract with the outside world, which is what semver bump correctness means.

**What does NOT change the bump, named for changelog completeness:** the inline SQL `CHECK
("kind" IN (...))` / `CHECK ("rel" IN (...))` constraints were dropped from `INLINE_MIGRATION_DDL`
(BL-439/BL-448's DDL-open work) — this is a real behavioral change (fresh stores no longer enforce
the closed vocabulary at the SQL layer; a `TypePolicy` is the sole remaining gate, per `DEFAULT_TYPE_
POLICY`'s new docstring) but it is invisible to a `.d.ts` diff two ways: `INLINE_MIGRATION_DDL`'s
declared type stays `string` before and after (only its literal *value* changed), and the DDL is
inline SQL text, not a TS type. Per D5 in the prior packet's spec, this is exactly the "gate scope
is type-shape, not behavior" limit — named in the changeset body, does not independently affect the
major ruling (which already stands on `EdgeRel` alone).

## 4. Decisions ruled

| # | Decision | Ruling | Losing alternative & why it loses |
|---|---|---|---|
| D8 | Bump for `@adhd/sox-vector-store`'s `db` → `adapter` required-property rename | **major** | "Minor because the fix is a one-line call-site edit" loses for the same reason D2 lost in the prior packet — semver major is about whether old code compiles, not fix cost. Here it's worse than D2: TWO independent compile failures (excess `db`, missing `adapter`), not one. |
| D9 | Bump for `@adhd/sox-graph-store`'s `EdgeRel` widening with `(string & {})` | **major**, overruling a mechanical extension of the prior packet's D3 | Extending D3's "union widening on data-flow discriminants = minor" verbatim loses — D3's own ruling was conditioned on "verified no in-repo exhaustive switch breaks," and `EdgeRel`'s own source comment + its own regression test (`open-rel-check.bl448.spec.ts` `AC-Type`) demonstrate that an exhaustive switch DOES break. The distinguishing test is "does anything exhaustively narrow this type," not "is it a string union" — `CapabilityId` failed to trigger it, `EdgeRel` does, by the authors' own admission in-file. |
| D10 | Whether `@adhd/sox-graph-store`'s `GraphBackendOpts`/`opts?` additions and the `INLINE_MIGRATION_DDL` CHECK-removal need their own bump consideration | **no** — additive param stays additive (does not independently justify a bump, subsumed by D9's major), DDL-value change is out of gate scope per D5 precedent, named in changeset body only | Treating the optional-param additions as a separate minor-worthy item is moot once D9 sets the package to major (semver bump is per-package, not per-hunk) — no alternative reading changes the file count or the package's single bump. |
| D11 | One changeset per package or a combined `sox-graph-store` + `sox-vector-store` file | **2 independent files**, same reasoning as the prior packet's D7 | The two changes trace to unrelated BLs (BL-448/PKT-74 vs BL-389) landing on unrelated packages for unrelated reasons (open-typing wave vs. StoreAdapter routing) — they only coincide in bump number (major) and in being discovered in the same gate re-run. Combining them would misattribute two independent root causes to one changelog entry, same failure mode the prior D7 rejected. |
| D12 | Whether to touch the already-filed 9 changesets from `feat/bl460-changeset-backfill` | **no** — leave byte-for-byte as merged | The scratch-root re-run in §1 confirms all 9 already resolve to `NOTE ... covered by a pending changeset`; re-deriving or editing them would be scope creep against an already-reviewed artifact and risks reintroducing exactly the kind of unreviewed change this gate exists to catch. |

## 5. File-by-file: what changes, what must NOT change

**In scope — create exactly these 2 files, nothing else:**

```
.changeset/bl460-sox-graph-store-edgerel-open.md   (major)
.changeset/bl460-sox-vector-store-adapter.md       (major)
```

Filenames are free-form (any unique `.md` under `.changeset/`, consistent with the prior packet's
convention) — the names above are suggestions for traceability. Frontmatter format, identical
convention to the 9 already in the tree:

```markdown
---
"@adhd/sox-graph-store": major
---

<prose, quoting the .d.ts diff line(s) from §3.2>
```

```markdown
---
"@adhd/sox-vector-store": major
---

<prose, quoting the .d.ts diff line(s) from §3.1>
```

Each body MUST:
- Quote at least one real `.d.ts` line (not paraphrased) — for graph-store, the `EdgeRel` union
  declaration line and a sentence naming the exhaustive-switch break; for vector-store, both the
  `db` → `adapter` constructor-config lines from `lancedb.d.ts` (the `index.d.ts` factory function
  carries the identical rename and does not need re-quoting, but may be referenced).
- Name the source BL: `BL-448`/`PKT-74` for graph-store, `BL-389` for vector-store.
- For graph-store: explicitly state the `INLINE_MIGRATION_DDL` CHECK-removal is a real behavior
  change not reflected in the bump (mirrors the prior packet's D5 treatment of SSE/service-proxy
  behavior notes) so a changelog reader checking for "does my store still enforce vocabulary at the
  SQL layer" isn't misled.
- For vector-store: state the migration path explicitly (pass `adapter: StoreAdapter` instead of a
  raw `better-sqlite3` handle; construct the adapter the same way `@adhd/sox-store-adapter`'s own
  consumers already do) so the changelog is actionable, not just descriptive.

**Explicitly OUT OF BOUNDS — do not touch (same list as the prior packet, extended):**

- `scripts/check-changeset-surface.ts` — do not weaken, do not special-case these two packages, do
  not add a "known additive" allowlist. Same rule as `SPEC-CHANGESETS.md:282-285`.
- `scripts/check-publishable.ts` — untouched, same reasoning.
- Any `dist/` under `libs/data/graph/graph-store/` or `libs/data/vectors/vector-store/`, in this
  worktree or in the main checkout. No `nx build` runs in this packet (§7). The main checkout's
  already-built `dist/`s (timestamps 2026-08-06 23:36 / 23:51, §1) are what this spec's findings are
  based on; do not rebuild them, do not touch them, do not `rm` them.
- The 9 already-filed `.changeset/bl460-sox-*.md` files carried over from
  `feat/bl460-changeset-backfill` — per D12, byte-for-byte unchanged.
- Any package's `src/` — this packet is `.changeset/*.md`-only, identical constraint to the prior
  packet (`SPEC-CHANGESETS.md:295-297`). The `INLINE_MIGRATION_DDL` CHECK-removal noted in §3.2 is
  **not** a defect to "fix" in this packet — it already shipped on `main` via BL-439/BL-448; the
  changeset records it, it does not revert it.
- `BACKLOG.md` / `CHANGELOG.md` — do not hand-edit. If the implementer or reviewer surfaces a new
  finding (e.g. a third package joining the failing set per §1's "moving target" warning, or a
  gate-scope gap), file it with `backlog_create_item` and verify with `backlog_get_item`.
- `pnpm-lock.yaml` — no `workspace:*` edges change in this packet.
- `SPEC-CHANGESETS.md` (the prior packet's spec) — read-only reference, not part of this packet's
  deliverable.

## 6. Acceptance criteria (each names a BL/decision, each has a stated RED arm)

**AC-1 (BL-460, the actual gate, run for real).** The scratch-root procedure from §1, re-run FRESH
(new `$SCRATCH`, current timestamp, current `main` state — do not reuse a stale scratch dir or trust
this spec's captured output as a substitute for your own run) with all 11 `.changeset/bl460-*.md`
files (9 carried + 2 new) present, must print `check-changeset-surface: OK — N publishable
package(s)...` and exit **0**.
_RED arm, captured in this spec (§1):_ the same procedure with only the 9 carried-over files present
exits 1 naming exactly `@adhd/sox-graph-store` and `@adhd/sox-vector-store`. Re-run that exact RED
state yourself first (temporarily `mv` or omit the 2 new files from `$SCRATCH/.changeset/`, confirm
exit 1 and the 2-package list, then restore them and confirm exit 0) — do not skip the RED
observation just because this spec already captured it once; BL-225 requires the implementer to have
personally watched it fail.
**Do NOT run this against main's root directly** (main has no `.changeset/*.md` pre-merge — see the
prior packet's AC-1 correction, `SPEC-CHANGESETS.md:314-323`, which still applies) and **do NOT run
with no argument** (defaults to `process.cwd()`, reports all packages `WARN ... no local dist/ ...
skipping`, passes trivially without proving anything — reproduced by me in §"toolchain verified"
below).

**AC-2 (per-package correctness).** `@adhd/sox-graph-store`'s changeset says `major`;
`@adhd/sox-vector-store`'s changeset says `major`. Neither is minor.
_RED arm:_ either file bumped as `minor` is a spec violation — the reviewer must independently
reproduce §3.1's `db`→`adapter` diff and §3.2's `EdgeRel`/`(string & {})` diff (not trust the
filename or this spec's prose) and confirm neither reading survives as additive.

**AC-3 (changeset content honesty).** Both new `.md` bodies quote a real `.d.ts` line (not
paraphrased) per §5. `grep -L '`' .changeset/bl460-*.md` (backtick check, all 11 files) returns
nothing.
_RED arm:_ a body that says "internal changes" or "breaking change" with no quoted line fails this
even if the bump number is correct.

**AC-4 (no scope creep, extended for this packet).** `git diff --stat main...feat/bl460-changeset-
close` (from the worktree, after merging `main`) shows exactly: the 9 carried files, the 2 new
files, `SPEC-CHANGESETS.md` (carried), and `SPEC-CHANGESETS-2.md` (this file) — nothing under
`src/`, `dist/`, `scripts/`, `BACKLOG.md`, `CHANGELOG.md`, or `pnpm-lock.yaml`.
_RED arm:_ any other path in the diff violates §5's out-of-bounds list; reject back to implementer
rather than trimming it in review.

**AC-5 (moving-target discipline — the acceptance criterion this packet exists to add).** The
implementer's final report quotes the *actual* stdout of their own final AC-1 run, not a copy of
this spec's §1 output. If the failing set has grown to 3+ packages by the time they run it, the
report states that explicitly and does not claim exit 0 without covering every failing package
named in that fresh run.
_RED arm:_ a report that says "gate passes, see architect's spec for the output" without an
independently-executed, independently-quoted run is exactly the failure mode that got the prior
attempt refused (per this task's brief) — treat a report without a freshly-quoted exit code as
unverified, full stop.

## 7. Risks — data/artifact destruction, and the sequencing that avoids it

- **`nx build` risk (BL-235) does not apply** — no build is required or permitted. The gate script
  only reads `dist/`; it never writes into a package's `dist/`. This packet adds 2 files under
  `.changeset/`, nothing else.
- **`nx test` risk (BL-456)** does not apply — this packet touches no `src/`, so there is nothing to
  `nx test`. If the implementer wants to re-verify worktree health, `npx nx test memory-core` is
  optional, not required by any AC here (same posture as the prior packet).
- **Cross-checkout risk:** the scratch-root procedure's symlinks read `/Users/nix/dev/ai/sox-
  ecosystem`'s `libs/apps/extensions` read-only; the only write outside `$SCRATCH` is the registry-
  tarball cache under `/Users/nix/dev/ai/sox-ecosystem/node_modules/.cache/check-changeset-surface/`
  (already populated for the 11 packages named in §1 — reusable, immutable-keyed, harmless). Do not
  `rm -rf` that cache dir. Use a FRESH `$SCRATCH` directory per re-run (do not reuse
  `bl460-verify2` from this spec — pick a new name) so a stale scratch tarball cache from a
  since-superseded published version can never mask a real failure; the cache key already includes
  the version string so this is a defense-in-depth precaution, not a correctness requirement.
- **Concurrent-agent risk:** other agents are live in the main checkout (`/Users/nix/dev/ai/sox-
  ecosystem`) and in sibling worktrees per the dispatch instructions — this includes agents who may
  rebuild `dist/` for other packages (growing the failing set further, per §1's moving-target
  warning) or for `graph-store`/`vector-store` themselves (changing the exact byte diff quoted in
  §3, though not the ruling — a rebuild without a source change reproduces the same `.d.ts`; a
  rebuild WITH a new source change would need its own re-read, not a reuse of §3's diff). This
  packet's only interaction with the main checkout is read-only (symlink traversal + cache-populate
  under `node_modules/.cache`); it commits nothing there.
- **No data-loss risk** — this packet adds files only.

## 8. The gate — exact commands the implementer runs, in order

1. `cd /Users/nix/dev/ai/sox-ecosystem/.worktrees/bl460-changeset-close`
2. `git fetch origin main && git merge origin/main --no-edit` (or local `main` if not tracking a
   remote) — re-confirm you are measuring against CURRENT main, not this spec's snapshot. If this
   merge brings in new `dist/` rebuilds, §1's "moving target" warning applies — re-run step 3 below
   BEFORE writing any new changeset, so you know the true current failing set.
3. Run the fresh scratch-root RED-arm procedure (§6 AC-1) with only the 9 carried changesets present
   — confirm exit 1 and record the exact failing-package list.
4. Create the 2 new `.changeset/*.md` files per §5 (either `pnpm changeset` interactively, selecting
   `@adhd/sox-graph-store` = major and `@adhd/sox-vector-store` = major, or hand-write the
   frontmatter — AC-2/AC-3 are the bar, not the authoring method). If step 3 found a 3rd+ package,
   stop here and escalate rather than filing an unreviewed bump for it.
5. Re-run the scratch-root procedure with all 11 files present — confirm `OK — N publishable
   package(s)...` and exit 0. This is the GREEN arm for AC-1.
6. `node tools/check-backlog-markers.mjs` and `node tools/plan-status.mjs --check` — standard
   pre-commit hygiene (this packet touches neither file, but the hooks run regardless).
7. No `nx build`/`nx test`/`nx lint`/`nx typecheck` target applies — same reasoning as the prior
   packet (`SPEC-CHANGESETS.md:424-426`); `.changeset/*.md` is not nx-tracked.
8. Commit by explicit pathspec:
   `git commit .changeset/bl460-sox-graph-store-edgerel-open.md .changeset/bl460-sox-vector-store-adapter.md -m "chore(release): backfill changesets for sox-graph-store and sox-vector-store (BL-460)"`
   (lowercase subject, scope `release`, ≤100 chars). Do not `git add -A`. Do not re-commit the 9
   carried files or `SPEC-CHANGESETS.md` — they are already committed on this branch via the merge
   in step 2's ancestry.
9. Hand off to reviewer with: the RED-arm output (step 3), the GREEN-arm output (step 5) verbatim,
   and `git diff --stat main...feat/bl460-changeset-close` proving AC-4.
