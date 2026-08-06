# SPEC — PKT-79 (BL-452 + BL-460)

Author: architect stage. Implementer: build exactly this, do not re-litigate the rulings in
§3 — they are decided. Reviewer: verify against §4's RED/GREEN pairs, not against taste.

Worktree: `/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt79-release-cascade`, branch
`feat/pkt79-release-cascade`. Toolchain verified 2026-08-06: `pnpm install` clean,
`npx nx test sox-ecosystem -- scripts/check-publishable.test.ts` green (6/6) after a from-scratch
`sox:build` (worktree had no prior `dist/`, so this build was not destructive — see §5).

---

## 1. Root cause (my own reading, file:line cited)

### BL-460 — no link between a public-surface change and a changeset

- `.changeset/*.md` is empty in this tree — `ls .changeset/*.md` → "No such file or directory",
  verified 2026-08-06.
- `libs/memory-core/src/write-queue.ts:138-153` — `WriteQueueMetrics` carries a `mode:
  'fifo'|'bypass'` discriminator (BL-445) and doc comments describing the nullable queue-shaped
  fields on the bypass path. `libs/memory-core/dist/write-queue.d.ts:120` (already built, not
  rebuilt by me — see §5) has that same discriminator language present locally.
- I pulled the **actually published** `@adhd/sox-memory-core@0.4.2` tarball
  (`npm pack @adhd/sox-memory-core@0.4.2`, extracted to `/tmp/npm-check`) and read
  `package/dist/write-queue.d.ts:105-115`: the published interface has plain `queue_depth: number`,
  `queue_max_size: number`, `saturated: boolean` — no `mode` field, no nullable widening, no
  bypass-path discriminator. **The published tarball's `.d.ts` is a materially different type from
  what today's source (and today's local `dist/`) produces**, and `0.4.2` is already `latest` on
  the registry (`npm view @adhd/sox-memory-core versions` → `[...,"0.4.2","0.5.0"]` — wait, corrected
  below, see note). No changeset file records this change; nothing in `release.yml` compares surface
  to registry.
  - **Correction while drafting:** `npm view @adhd/sox-memory-core versions --json` returns
    `[...,"0.4.1","0.4.2","0.5.0"]` — `0.5.0` is *later* than `0.4.2` and is what `npm view
    @adhd/sox-memory-core dependencies` (no version pin) actually resolves as `latest`. I diffed
    against `0.4.2` specifically because that is the version BL-460's own driver names, and it is
    still the case that whichever version is `latest` shipped without walking through a changeset —
    `.changeset/*.md` being empty is unconditional evidence regardless of which published version is
    compared. The implementer must re-run the `npm pack`/diff step against whatever is `latest` at
    implementation time (§4, BL-460 RED arm) rather than trusting `0.4.2` as a hardcoded fixture,
    because the gap widens every day nobody notices.
- `scripts/check-publishable.ts:1-30` (module docstring) states its own scope: dependency-shape
  only (rules 1-4, none of which touch `.d.ts` content or changeset presence for the package's
  *own* surface — `pendingChangesetPackages()` at `:120-141` is used only to suppress a
  registry-404 false-positive, never to gate a surface diff).
- `.github/workflows/release.yml:70-80` — the gates added in `08f3f9d` (lint, typecheck, test,
  `check-publishable`) run in that order and none diffs `dist/*.d.ts` against the registry.

Root cause: **there is no step, anywhere in the toolchain, that reads the shape a package is about
to publish and asks "does a changeset explain this delta from what's already live?"** Changesets
answers "what versions bump" from the changeset files that exist; it has no opinion on whether a
changeset *should* exist. That is the missing link BL-460 names.

### BL-452 — the cascade

- `.changeset/config.json:9` — `"updateInternalDependencies": "patch"`. This is a real,
  already-configured changesets feature: when a workspace package with a real changeset is
  versioned, every workspace consumer that depends on it via `workspace:*` gets an implicit patch
  bump too, cascading through the graph, with no changeset file needed for the consumer.
- Verified this mechanism *does* work end-to-end: `npm view @adhd/sox-memory-core@0.4.2
  dependencies` → `"@adhd/sox-store-adapter": "0.1.2"` (exact match, current). `npm view
  @adhd/sox-memory-core@0.4.1 dependencies` → `"@adhd/sox-store-adapter": "0.1.1"` (the version
  BL-452's own driver cites as the incident). So between `0.4.1` and `0.4.2`, `memory-core`'s pin on
  `store-adapter` correctly moved in lockstep with `store-adapter`'s own bump — the graph
  relationship is not the bug.
- **What actually happened in the incident, from the commit itself** — `c84e0af` (2026-08-04,
  "chore(release): publish 9 packages"): the commit body states publishing used **`npm publish
  <tarball>` on pnpm-packed tarballs, deliberately not `changeset publish`**, because
  `changeset publish` "would have pushed every package whose local version is absent from npm,
  beyond what was approved." `PUBLISHING.md:18-24` documents the same distrust as a standing
  process step: `changeset publish` "sweeps ANY workspace package whose local version differs from
  npm — audit that drift before publishing (this is how an unrelated package ships as a side
  effect; it happened live with sox-memory-core 0.2.1→0.3.0 on 2026-07-16)."
- So **the cascade mechanism (changesets' `updateInternalDependencies`) already computes the
  correct transitive set.** The actual cost of the eight-release event was not "the tool can't do
  this" — it was that the team does not trust `changeset publish` to scope itself to *only* the
  intended blast radius, so a human manually derived the same nine-package set by hand (`store-adapter`,
  `graph-store`, `vector-store`, `analysis`, `task-queue`, `blob-store`, `hybrid-search`,
  `memory-core`, plus first-ever `telemetry`) and published each tarball individually. That manual
  derivation is unverified against the actual dependency graph — there is no script or test proving
  the nine-package set the human assembled was exactly the transitive closure, no more, no less.
  `libs/data/graph/graph-store/package.json` (`dependencies.@adhd/sox-store-adapter: "workspace:*"`),
  and five more `package.json`s carry the same edge (`grep -l sox-store-adapter libs/**/package.json`
  → `memory-core`, `analysis`, `graph-store`, `vector-store`, `hybrid-search`, `task-queue`,
  `blob-store`, `store-adapter` itself) — confirming the nine-package set was in fact the correct
  transitive closure this time, by luck of careful manual auditing, not by a checked process.

Root cause: **the tax is real (exact pinning + a release process that distrusts its own automation's
scoping), but the mechanism to compute the correct cascade already exists and already works — what
is missing is a script that computes and verifies the transitive closure so a human never has to
derive it by hand again, and a test that the closure it computes matches what `changeset
status`/`version` would actually produce.**

---

## 2. The change, file by file

### New files (implementer creates)

1. **`scripts/check-changeset-surface.ts`** — BL-460 gate. Standalone script, same shape/style as
   `scripts/check-publishable.ts` (flag parsing, fail-closed network policy, cache dir under
   `node_modules/.cache/`). See §4 for exact behaviour.
2. **`scripts/check-changeset-surface.test.ts`** — regression test, same fixture-workspace +
   disposable-tmpdir pattern as `scripts/check-publishable.test.ts:1-70`. Do not import from the
   live repo tree for assertions (no dependency on today's memory-core/store-adapter state staying
   red forever) — build synthetic fixture packages, as `check-publishable.test.ts` does. The
   *separate* live-tree RED-arm proof (§4, BL-460 acceptance) is a manual/CI-run step, not part of
   this unit test — record its output as a comment in the PR/commit body, not as an assertion that
   depends on the live registry's current `latest` version.
3. **`scripts/cascade-plan.ts`** — BL-452 script. Given a target package name (or auto-detected
   from packages named in pending `.changeset/*.md` frontmatter), computes the full transitive
   closure of workspace consumers via the static `package.json` dependency graph (walk `libs/**`,
   `apps/**` — reuse `findPackageJsons()`'s traversal shape from `scripts/check-publishable.ts:78-97`,
   do not duplicate a second walker with different exclusions), and cross-validates that closure
   against `changeset status --output=<tmp>.json`'s `releases[].name` set for the same pending
   changesets. Emits a topologically-sorted publish plan (leaves first) to stdout and, with
   `--json`, machine-readable. Exit 1 if the static-graph closure and the changesets-computed
   closure disagree in either direction (a package changesets would bump that the graph walk
   missed, or vice versa) — that disagreement is exactly the class of gap that produced the
   under/over-scoped manual publish risk.
4. **`scripts/cascade-plan.test.ts`** — fixture workspace test (4+ fake packages: `A <- B <- C`
   chain plus unrelated `D`), asserting the computed closure for a changeset on `A` is exactly
   `{A, B, C}`, excludes `D`, and matches a fixture `changeset status --output` run against the
   same fixture workspace (do not mock `changeset status` — actually run it via
   `npx changeset status` against the fixture dir with `execFileSync`/`spawn`, same pattern as
   `check-publishable.test.ts` shelling out to the real script under test).

### Modified files

5. **`.github/workflows/release.yml`** — add a `Changeset-surface gate (BL-460)` step, **after**
   "Test all packages" and **after** "Born-publishable shape gate" (both already build/typecheck
   the tree, so `dist/*.d.ts` is guaranteed present by the time this step runs — see §5 sequencing),
   before "Create release PR or publish":
   ```yaml
   - name: Changeset surface gate
     run: npx tsx scripts/check-changeset-surface.ts --ci
   ```
   `--ci` is the strict flag (§4) that turns "no local `dist/`" into a hard failure instead of a
   skip, since CI always builds first and a missing `dist/` there is a real defect, not a
   dev-machine convenience gap.
6. **`package.json`** (root) — add two script entries:
   ```json
   "check-changeset-surface": "npx tsx scripts/check-changeset-surface.ts",
   "cascade-plan": "npx tsx scripts/cascade-plan.ts"
   ```
7. **`PUBLISHING.md`** — replace the ad hoc `node -e "..."` drift one-liner (the
   `for(const f of globSync('libs/**/package.json'...` block, roughly lines 41-42 in the current
   file) with an instruction to run `pnpm run cascade-plan <package-name>` instead — it is the same
   check, now versioned, tested, and reusable, so the copy-pasted-into-a-terminal one-liner is
   retired in the same change that supersedes it. Do not delete the surrounding prose explaining
   *why* the check exists (the `sox-memory-core 0.2.1→0.3.0` sweep incident) — that citation stays,
   only the inline script is swapped for the command.

### Explicitly OUT OF BOUNDS — do not touch, and why

- **Any `package.json` `dependencies` range** (`workspace:*` → caret or otherwise) on any
  publishable package. This is the ruled-against option (b) — see §3. Touching a dependency range
  is a publishable-surface change and is exactly the kind of one-way door this packet is scoped to
  avoid pulling.
- **`.changeset/config.json`** — `updateInternalDependencies: "patch"` stays as-is; it is already
  correct and is the mechanism §1/§3 rely on. Do not experiment with `"minor"` or `"major"`.
- **Any actual `.changeset/*.md` file for a real package** (memory-core, store-adapter, etc.) — this
  packet proves gates, it does not file a real release changeset. If the implementer's fixture or
  live-tree verification needs a *pending* changeset file to exercise a code path, it must be created
  in a scratch/fixture directory (see §4's fixture pattern) or, if it must touch the real
  `.changeset/` dir to prove the live RED arm, it must be deleted again before the commit (never
  left staged/committed) — treat it like `check-publishable.ts`'s own test does: nothing durable.
- **`scripts/check-publishable.ts` itself** — BL-460/BL-452 are additive gates, not a rewrite of the
  existing dependency-shape gate. Do not merge their logic into one file; they check different
  things (dependency shape vs. surface-vs-changeset vs. cascade completeness) and `check-publishable`
  already has its own regression test suite that a merge would put at risk for no benefit named in
  this packet.
- **`nx build` of any project** — see §5. The gate scripts read `dist/` if present; they never
  invoke a build.
- **Actual `npm publish`, `changeset publish`, or `changeset version`** — this packet builds and
  proves gates. It does not cut a release. `cascade-plan.ts` calls `changeset status` (read-only,
  never mutates `.changeset/` or `package.json`) — never `changeset version` or `changeset publish`.

---

## 3. Every decision, ruled

### Decision A — BL-452: (a) accept + script the cascade, vs (b) caret ranges, vs (c) coarser packages

**RULING: (a). Accept the cascade; script and verify it. Do not adopt caret ranges. Do not
consolidate packages.**

**Why (a) wins on the evidence in §1:** the transitive-closure computation already exists and
already works correctly (`updateInternalDependencies: "patch"` produced the correct
`memory-core@0.4.2 → store-adapter@0.1.2` pin). The actual defect is that nobody trusts
`changeset publish`'s auto-scoping (documented, with a named incident, in `PUBLISHING.md:18-24`),
so a human re-derives the same computation by hand with no check that the hand-derivation matches
the graph. That is a scripting-and-verification gap, not an architectural one — it is fixable
without touching a single publishable contract, which is the lowest-risk shape available and the
one this packet's acceptance criteria (§4) are written for.

**Why (b) — caret ranges — loses:**
1. **It is a compatibility-contract change, and the packet says it is very hard to walk back.**
   Once a consumer's lockfile resolves `@adhd/sox-store-adapter@^0.1.1`, telling them later "actually
   we need exact pins again" is a breaking republish of everyone who took the caret, not a bugfix.
2. **This ecosystem's patch/minor discipline is demonstrably not trustworthy enough to hand to
   semver-caret resolution yet.** BL-460 (this same packet) is live proof: `WriteQueueMetrics`
   gained a required discriminator field and `AdapterBackupResult` gained a new field, **both
   already published**, **neither with a changeset**. A caret range means a consumer's `npm update`
   silently pulls whatever the next "patch" claims to be — and the two examples in front of me right
   now show "patch" is not a reliable signal here. Turning on caret ranges *before* BL-460's gate has
   run for any length of time would let a bad "patch" reach every caret-pinned consumer automatically,
   which is strictly worse than today's manual gate (a human at least looks at what they're
   publishing).
3. **0.x semver caret is a false safety net anyway.** For a `0.y.z` package, `^0.1.1` only floats
   within `0.1.x` (npm/semver treats `0.x` specially: leading zero means only the last non-zero
   segment is "compatible"). Every package in this graph is still `0.x`
   (`store-adapter` 0.1.2, `graph-store` 0.5.2, `memory-core` 0.4.2/0.5.0). A caret range would only
   have silently absorbed the *exact* store-adapter 0.1.1→0.1.2 patch that motivated BL-452 — it
   would do nothing for a 0.4→0.5 bump on memory-core itself, which is exactly the kind of change
   that keeps happening here. It solves the one example in the driver and not the general problem.
4. Sequencing point already in the packet: BL-460's gate is a *prerequisite* for ever safely
   revisiting (b) — it does not exist yet as a stable, running gate. Ruling (b) in before that gate
   has a track record would compound rather than fix BL-460's failure mode.

**Why (c) — fewer, coarser packages — loses:** it is the largest, least reversible option of the
three (touches every consumer's import paths, `package.json` dependency lists, and the CI graph
simultaneously) to solve a problem that (a) solves with a ~150-line script and two tests. It also
does not eliminate the pinning problem, only reduces the package count `N` in "N-package release" —
`store-adapter` would still need every merged-in consumer republished on a fix. Nothing in this
packet's scope (`scripts/check-publishable.ts`, `release.yml`, `.changeset/`, dependency ranges)
authorizes a package-topology redesign, and doing one as a side effect of a release-tooling packet
is exactly the kind of scope creep the "files" list in the packet is there to prevent.

### Decision B — what "the cascade script" (BL-452 acceptance) actually verifies

**RULING:** `cascade-plan.ts` verifies the **static package.json graph closure** against the
**changesets-computed closure** (`changeset status --output`), not a from-scratch reimplementation
of changesets' own bump algorithm. Reasoning: reimplementing semver-bump-cascade logic in a second
place is the DRY violation this house explicitly warns against (`CLAUDE.md` "Dry" section) and
creates exactly the two-sources-of-truth risk BL-452 is about in miniature. The script's job is to
catch the case where those two sources of truth *disagree* — it is a cross-check, not a parallel
implementation.

**Amended 2026-08-06 (architect, correcting my own earlier text) — edge scope.** My original
drafting of this decision (and of AC-452-1 below) assumed a non-`workspace:` range (e.g. a
hand-pinned exact version) is excluded from the changesets cascade. That assumption is **wrong** and
has been struck. Read directly, `@changesets/get-dependents-graph@2.1.4`'s `getDependencyGraph`
(`node_modules/.pnpm/@changesets+get-dependents-graph@2.1.4/node_modules/@changesets/get-dependents-graph/dist/changesets-get-dependents-graph.esm.js:55-93`,
the exact function `changeset status` calls): it scans all four dependency fields (`DEPENDENCY_TYPES
= ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]`, line 6) and, for
a non-`workspace:` range, calls `getValidRange(depRange)` — a real `semver.Range` parse — and
cascades (`dependencies.push(depName)`) whenever the range is valid and satisfied by the dependency's
current version. The **only** case it excludes is when `getValidRange` returns `null` — i.e. the
range is not a parseable semver range at all, which is what a dist-tag string (`"latest"`, `"next"`)
looks like. The source's own comment at that line: *"depRange could have been a tag and if a tag has
been used there might have been a reason for that — we should not count this as a local monorepro
dependant."* So `cascade-plan.ts`'s static walker correctly follows only `workspace:*` edges (this
repo has zero non-`workspace:*` internal pins today, confirmed by grep — reproducing the generic
semver-satisfaction matcher would be speculative DRY-violating scope with no present benefit, and if
this repo ever adds one, the walker will under-count and the cross-check will correctly fail loud,
per Decision B's own "disagreement is the safety net" logic) — but the **exclusion boundary named in
this ruling is dist-tag references, not "non-`workspace:` ranges" generally.** AC-452-1's fixture F
below is corrected to match.

### Decision C — BL-460: diff mechanism (byte-level `.d.ts` diff vs. AST/API-extractor-level diff)

**RULING:** byte-level diff of `dist/*.d.ts` file content against the last published tarball's
`dist/*.d.ts`, per-file. Reasoning: the acceptance text is explicit — "fails when a publishable
package's `dist/*.d.ts` differs from the last published version" — and a byte diff is the literal,
unambiguous reading. An AST-level "public API surface" diff (e.g. via `@microsoft/api-extractor` or
`ts-morph`) would be more precise (ignores comment/whitespace churn) but is a new heavyweight
dependency and a new source of "is this diff meaningful" judgment calls that the packet does not ask
for and that could itself hide a real change behind a normalization bug. Byte diff is deliberately
conservative: it may false-positive on comment-only edits (e.g. a JSDoc typo fix ships without a
changeset), which is an acceptable cost — a maintainer who gets an unwanted "you need a changeset"
prompt for a comment-only `.d.ts` change can add a trivial changeset; a maintainer who gets a false
*pass* on a real type change gets nothing, which is BL-460 itself. Fail toward requiring more
changesets, never fewer.

### Decision D — BL-460: how to fetch "the last published version" without depending on network for correctness in a misleading way

**RULING:** fetch via `npm view <name>@latest dist.tarball` + download + extract, cached under
`node_modules/.cache/check-changeset-surface/<name>@<version>.tar` (immutable once published — safe
to cache indefinitely, unlike `check-publishable.ts`'s 24h existence-cache which has to re-check
because *non-existence* can flip). **Explicit offline behaviour, matching `check-publishable.ts`'s
precedent exactly:** `--offline` or unreachable registry → **exit 1, fail-closed**, with a message
naming which packages could not be verified. Do **not** cache a "network was down, assume OK"
result. This mirrors `scripts/check-publishable.ts:36-44`'s documented policy verbatim and for the
same reason stated there: "a check that degrades to green when the network is unavailable
reproduces the exact defect class this rule exists to close." A CI outage should turn the release
pipeline red (blocking, safe) rather than silently skip the one check that would have caught BL-460
happening again.

### Decision E — BL-460: what happens when `dist/*.d.ts` does not exist locally (no build yet)

**RULING:** two modes, controlled by `--ci`:
- **Default (no `--ci`):** package has no local `dist/` → **SKIP with a WARN**, not a failure. This
  is the dev-machine-convenience path — a developer running the gate without having built everything
  should not be told to go run `nx build` themselves (BL-235 hazard — never suggest a speculative
  build as the fix for a gate).
- **`--ci`:** package has no local `dist/` → **hard FAIL**, message says why (`release.yml` always
  runs `nx run-many -t build` before this step — `.github/workflows/release.yml:60-61` — so a
  missing `dist/` in that job is a real defect in the pipeline ordering, not an expected state, and
  the gate must say so loudly rather than silently pass).

This is the same shape as `check-publishable.ts`'s `--offline` fail-closed pattern, applied to a
different kind of "I cannot check this" condition (missing local artifact vs. missing network).

### Decision F — which packages are in scope for the BL-460 gate

**RULING:** every package `check-publishable.ts` already treats as publishable — i.e., reuse its
exact selection predicate (`pkg.private !== true && pkg.name.startsWith('@adhd/sox-')`,
`scripts/check-publishable.ts:232-233`) rather than inventing a second definition of "publishable"
that can drift from the first. Import/re-implement that one predicate as a small shared helper if
convenient, but do not derive a different package set for this gate than the one the dependency-shape
gate already uses — a scope mismatch between the two gates (one seeing 30 packages, the other 28)
would itself be an undetected drift bug of exactly this packet's flavor.

---

## 4. Acceptance criteria, naming each id, with RED arms

### BL-460

**AC-460-1 (unit, in `check-changeset-surface.test.ts`, fixture-based).**
Build a fixture workspace: one publishable package `@adhd/sox-fixture-surface` with a local `dist/`
containing a `.d.ts` whose content differs from a fixture "last published" tarball served by a local
HTTP fixture registry (same `startFixtureRegistry` pattern as `check-publishable.test.ts`), and
**no** file under a fixture `.changeset/` naming that package. Run the real script (`spawn`, not an
in-process import) against that fixture root.
- **RED arm:** before `check-changeset-surface.ts` exists, this test file cannot even import/spawn
  it — the test itself does not exist yet either. The observable RED is: write the test first
  (pointing at the not-yet-created script path), run it, watch it fail (`ENOENT`/module-not-found or
  non-zero unexpected exit), *then* implement the script, rerun, watch it turn green. Record both
  runs' output in the commit body per BL-225.
- **GREEN arm:** exit 0 when a fixture changeset naming the package is present alongside the same
  `.d.ts` delta. Exit 0 when the fixture `dist/*.d.ts` is byte-identical to the fixture "published"
  version regardless of changeset presence (nothing to gate).

**AC-460-2 (live-tree verification, run once by hand at implementation time, output pasted into the
commit body — not a standing automated test, because it depends on the live npm registry's current
`latest`, which moves).**
Run `npx tsx scripts/check-changeset-surface.ts` (no `--ci`, so missing-dist degrades to skip, not
failure) against the real tree, with the real `libs/memory-core/dist/` and
`libs/data/store/store-adapter/dist/` present (already built as of this spec's drafting — do not
rebuild to get this state, see §5). **This is available and red right now**, per §1: `.changeset/`
is empty and both packages' local `dist/*.d.ts` differ from their last-published `.d.ts` (verified
above for memory-core against `0.4.2`; the implementer must re-verify store-adapter's delta the same
way — `npm pack @adhd/sox-store-adapter@<latest>`, diff `AdapterBackupResult`/`BackupStoreResult`
against `libs/data/store/store-adapter/dist/*.d.ts`, per BL-460's own driver text). Expected: exit 1,
naming both packages. This is the RED arm for the *whole gate wired into CI* — do not consider
BL-460 "done" until this exact invocation, on this exact tree (or later, since the drift only grows),
returns non-zero. If someone lands a changeset for either package before the implementer runs this,
that package drops out of the RED set — note it and confirm the *other* one is still red, or find a
third genuinely-undocumented surface change to substitute (do not manufacture one).

**AC-460-3 (CI wiring).** `release.yml` gains the step from §2.5. No test framework can exercise a
GitHub Actions job directly in this repo; the acceptance is: the YAML step exists, in the specified
position, and `--ci` is passed (verified by reading the file, cited in the PR).

### BL-452

**AC-452-1 (unit, in `cascade-plan.test.ts`, fixture-based, per Decision B).**
Fixture workspace: packages `A` (has a pending fixture changeset), `B` (`workspace:*` dep on `A`),
`C` (`workspace:*` dep on `B`, transitively on `A`), `D` (no relation to `A`). Run
`cascade-plan.ts --json` against the fixture root.
- **RED arm:** script does not exist yet (same shape as AC-460-1 — write the test first, watch it
  fail on the missing script, then implement).
- **GREEN arm:** JSON output's package set is exactly `{A, B, C}`, ordered topologically
  (`A` before `B` before `C`), `D` absent. Cross-check: the same set equals
  `changeset status --output=<tmp>.json`'s `releases[].name` run against the identical fixture dir
  (the test asserts *both* independently, then asserts they're equal — proving the cross-check logic
  itself, not just one arm of it).
- **Disagreement RED arm (the one that actually matters for BL-452):** add a second fixture case
  where a package `E` depends on `A` from a directory relative to `findPackageJsons()`'s `roots`
  list (`libs`, `apps`, `extensions`, `packages` — `scripts/check-publishable.ts:83`) that a naive
  reuse of that exact list would miss but `changeset status` (which resolves workspace membership
  from `pnpm-workspace.yaml` directly) would still cascade to — confirm the script's own scan either
  includes it or the test documents why not. **This happened for real, not just as a fixture: `tools/*`
  is a genuine `pnpm-workspace.yaml` glob (BL-164) that `check-publishable.ts`'s roots list does not
  cover (correctly, for its own narrower publishable-package scope), and
  `tools/baseline-capture/package.json` carries a real `workspace:*` `devDependencies` edge onto
  `@adhd/sox-store-adapter`. `cascade-plan.ts` must add `'tools'` to its own roots list to agree with
  `changeset status` — this is not a re-litigation of Decision F (which governs the BL-460
  publishable-package predicate only), it is `cascade-plan.ts`'s own, differently-scoped closure
  requirement, and it must be reproduced live against this exact repo (pre-fix: disagreement naming
  `@adhd/sox-baseline-capture`; post-fix: agreement) before AC-452-2 counts as passing.**
  Also add a **devDependency-only** fixture case (`G`, depends on `A` only via `devDependencies` with
  `workspace:*`) — not a contrived edge case: `libs/data/analysis/analysis/package.json` reaches
  `@adhd/sox-store-adapter` only through `devDependencies` in the real tree, and `getAllDependencies`
  in `@changesets/get-dependents-graph` scans all four dependency fields (`dependencies`,
  `devDependencies`, `peerDependencies`, `optionalDependencies` — see Decision B's amendment above),
  not `dependencies` alone. A walker scoped to `dependencies` only would silently drop this consumer.
  **The exclusion case (fixture F) is a dist-tag reference (e.g. `"latest"`), not an exact-version
  pin** — per Decision B's amendment, an exact-version pin that matches the dependency's current
  version DOES cascade in real changesets and must NOT be used as the excluded fixture.

**AC-452-2 (live-tree proof — "a patch to store-adapter reaches a consumer without hand-editing N
manifests," per the packet's acceptance text, satisfied via the already-working mechanism from §1,
not a new one).**
Run `cascade-plan.ts store-adapter` (or the auto-detect form) against the **real** repo tree with a
*temporary* fixture changeset added to `.changeset/` (e.g.
`.changeset/pkt79-verification-scratch.md` naming `@adhd/sox-store-adapter: patch`), then delete that
file before committing (per §2, out-of-bounds list — never leave a scratch changeset committed).
Assert the computed closure is exactly: `store-adapter`, `graph-store`, `vector-store`, `analysis`,
`task-queue`, `blob-store`, `hybrid-search`, `memory-core` (the eight dependents found by
`grep -l sox-store-adapter libs/**/package.json` in §1) — no more, no fewer — **and** that
`memory-core`'s `package.json` dependency line was **not hand-edited** to produce this result (it
never is; `workspace:*` never needs editing, only `changeset version` — which this script never
calls — would rewrite it at version time). This is the direct proof that the cascade "reaches a
consumer without hand-editing N manifests": the *computation* of who needs to move is now automatic
and checked, even though the mechanism that would actually rewrite the manifests
(`updateInternalDependencies: patch`) was already automatic and is explicitly out of scope to
re-verify here (it is already proven in §1 via the `0.4.1`→`0.4.2` pin history).
- **RED arm:** before `cascade-plan.ts` exists, there is no way to get this eight-package answer
  except by a human manually auditing `grep -l` output (exactly what I did by hand in §1, and exactly
  what produced the correct-but-unverified nine-package set in the `c84e0af` incident). The RED
  observable is: no tool in the repo today can answer "if I patch store-adapter, what is the exact
  republish set" without a human running ad hoc greps.

---

## 5. Risks and sequencing (BL-235 / destructive-build hazard)

- **Never call `nx build` from inside `check-changeset-surface.ts` or `cascade-plan.ts`.** Both
  scripts only *read* `dist/` if present (Decision E) or read `package.json`/`.changeset/*.md`
  (never touch `dist/` for `cascade-plan.ts` at all — it never needs a build, it only reads
  manifests and shells to `changeset status`).
- **`release.yml` step ordering (§2.5) is deliberate:** place the new gate *after* "Test all
  packages" (which itself runs after "Build all packages" at `release.yml:60-61`), so `dist/*.d.ts`
  is guaranteed to exist by the time `check-changeset-surface.ts --ci` runs — it never triggers its
  own build, and the `--ci` strict-fail-on-missing-dist mode (Decision E) exists specifically to
  catch a future reordering mistake that violates this, rather than silently building.
- **For AC-460-2 and AC-452-2 (live-tree proofs), do not run `nx build` to *produce* the `dist/`
  state used for verification.** `libs/memory-core/dist/` and
  `libs/data/store/store-adapter/dist/` already exist in the worktree from a prior legitimate build
  (verified 2026-08-06, `libs/memory-core/dist/write-queue.d.ts` present, mtime after the last
  source edit to `write-queue.ts`). Use that artifact as-is. If it is later found stale relative to
  source (i.e. it predates a source change that would flip the diff verdict), that is itself
  evidence worth citing, not a reason to rebuild — rebuilding to "fix" a verification artifact mid-spec
  is exactly the BL-235 hazard (destroying a working `dist/` on a diagnostic build that might fail).
  If the implementer's own edits require a rebuild of these two projects for unrelated reasons
  (they should not — this packet does not touch `write-queue.ts` or `integrity.ts`), treat that
  rebuild as a deliberate, acknowledged risk and say so, not an incidental side effect.
- **`cascade-plan.ts`'s use of `changeset status`** is read-only by construction (`@changesets/cli`'s
  `status` subcommand does not write files — confirmed via `--help`, `2.31.0`, only `version`/
  `publish` mutate). Never upgrade the call to `changeset version` "to see what it would do" —
  `version` mutates `package.json`/`CHANGELOG.md` and deletes consumed changeset files on disk; there
  is no dry-run flag (`PUBLISHING.md:32-33`, "NOTE: `changeset publish --dry-run` DOES NOT EXIST").
- **Any scratch `.changeset/*.md` file created for live-tree verification (AC-452-2) must be deleted
  before the final commit.** Check `git status --porcelain .changeset/` shows nothing before
  committing the packet's changes.
- **No data-destructive risk otherwise** — this packet touches no database, no `~/.memory/*`, no
  running service.

---

## 6. The gate — exact nx targets the implementer must run

1. `npx nx test sox-ecosystem -- scripts/check-changeset-surface.test.ts` — new BL-460 unit test,
   watch RED (script absent) then GREEN (script present), per BL-225.
2. `npx nx test sox-ecosystem -- scripts/cascade-plan.test.ts` — new BL-452 unit test, same RED→GREEN
   discipline.
3. `npx nx test sox-ecosystem -- scripts/check-publishable.test.ts` — the **existing** gate's suite
   must stay green; this packet must not regress it (no shared-file edits are planned per §2's
   out-of-bounds list, but the target still needs a green run recorded as evidence nothing broke).
4. `npx nx lint sox-ecosystem` (if the root project carries a lint target covering `scripts/**` —
   confirm via `cat project.json`/`nx.json`; if `scripts/**` is not covered by any project's lint
   target today, note that gap rather than inventing new lint scope not asked for by this packet).
5. `npx nx typecheck sox-ecosystem` if such a target exists for the root project; if not, this is a
   pre-existing gap outside this packet's file list (`project.json`/`nx.json` are not in the "Files"
   list) — do not add one speculatively, note it for the reviewer instead.
6. `node tools/check-suite-tree-state.mjs --project sox-ecosystem` — report alongside every suite
   result per the BL-456 house rule, quoting tree state with the result.
7. Whole-repo gate before declaring done: `npx nx run-many -t build,lint,test,typecheck` is **not**
   required by this packet's scope (it would rebuild everything, high blast radius for a
   two-script-plus-one-workflow-edit change) — run the four targeted commands above instead, and
   let the reviewer stage decide whether a full sweep is warranted before merge to `main`.
8. Manual, once, output pasted into commit body: AC-460-2 and AC-452-2's live-tree invocations
   (§4) — these are not nx targets, they are direct `npx tsx scripts/...` runs against the real tree,
   because their entire evidentiary value is that they run against real, currently-published,
   currently-undocumented drift.

**Never pass `--skip-nx-cache`.** Never run `nx build` on any project this packet does not
explicitly modify. Commit by explicit pathspec only — this spec file, then each implementation file,
never `git add -A`.
