# SPEC-PKT-63 — cut the 0.6.0 release train (BL-444)

Architect: architect-reviewer. Worktree: `.worktrees/pkt63-release-060`, branch
`feat/pkt63-release-060`, based on `main` @ `42689fdf`. Verified clean, `pnpm install` succeeds,
`npx nx test memory-core` green (58 files / 581 passed / 8 skipped), tree-state CLEAN per
`tools/check-suite-tree-state.mjs --project memory-core`.

This packet does **no functional code changes**. All six prerequisite packets (PKT-73/BL-447,
PKT-59/BL-440, PKT-58/BL-439, PKT-74/BL-448, PKT-60/BL-441, PKT-62/BL-443) plus PKT-61/BL-442 are
already merged to `main` — verified: `86d758ed`/`ae262a2d` (BL-439), `9ba8ec70`/`3db7ff46` (BL-440),
`b64bc3d8`/`e1d6d759` (BL-448), `179d9a04`/`d64175f5` (BL-441), `9df240d2`/`f73fdc8d` (BL-443),
`893b42c4` + close-out `6c484957` (BL-447), `b4b9c54a`/`af03143c` + close-out `c40b186b` (BL-442).
PKT-63 is pure **release mechanics**: fix a versioning-policy defect in already-committed
changesets, materialize the version bump, write the wave-level release note, gate, and stop one
command short of `npm publish`.

---

## 1. Root cause (two, both grounded in what I read)

### 1a. BL-444's stated problem — already true, already evidenced

`@adhd/sox-graph-store` (`libs/data/graph/graph-store/package.json:2-3`, `0.5.3`, `"private":
false`) has four in-repo `workspace:*` runtime dependents pinned exactly at publish
(`updateInternalDependencies: "patch"`, `.changeset/config.json:9`): `@adhd/sox-analysis`
(`libs/data/analysis/analysis/package.json:28`), `@adhd/sox-vector-store`
(`libs/data/vectors/vector-store/package.json:27`), `@adhd/sox-hybrid-search`
(`libs/data/search/hybrid-search/package.json:28`), `@adhd/sox-memory-core`
(`libs/memory-core/package.json:28`). Five packets in this wave changed
`@adhd/sox-graph-store`/`@adhd/sox-vector-store` source. Published as separate trains that is
five root publishes cascading four downstream releases each — the exact multiplier that made a
one-line dependency fix cost eight npm releases on 2026-08-04 (BL-452, cited in BL-444's own
citation list). **This part of BL-444 needs no new proof — `scripts/cascade-plan.ts` (already
built, PKT-79/BL-452) computes the real closure directly:**

```
npx tsx scripts/cascade-plan.ts   # auto-detects targets from pending .changeset/*.md
```

I ran it. Auto-detected 11 direct-changeset targets, cross-checked clean (`cascade-plan: OK —
targets [...] cross-checked against changeset status`), and printed the leaves-first publish
order: **23 packages total in the static workspace graph**, of which **18 actually receive a
version bump under `changeset status --output=<json>`** (verified by running both and diffing —
see §1c). The 5 in the static closure but not in the bump set (`@adhd/sox-cli`,
`@adhd/sox-baseline-capture`, `@adhd/sox-extension-memory-{cli,flush,server}`) reach the changed
packages **only via `devDependencies`** (`apps/sox/package.json:21-29`,
`extensions/bundles/sox-memory-bundle/members/memory-server/package.json:27-33`) — Model A
bundling (ADR-0006): those packages inline the libs at build time and carry zero `@adhd/sox-*`
runtime deps, so a graph-store/vector-store bump does not force their npm semver to move, only
their bundled `dist/` to be rebuilt (registry-checksum concern, not a publish-set concern — §6).

### 1b. BL-444 is right that a train is needed, but its stated deliverable already exists in draft

**11 `.changeset/*.md` files are already committed** (`.changeset/bl460-sox-*.md`, all dated into
this branch history via `79934ea7`), one per changed package, each with a body that already names
what breaks and why, in more detail than BL-444 asked for. I read all 11 in full. They are
correct **except for one shared, load-bearing defect** — §1c.

### 1c. The changeset-type defect (mine, not previously identified in BACKLOG/PLAN)

Three of the 11 changesets declare bump type `major`:

- `.changeset/bl460-sox-graph-store-edgerel-open.md:2` — `"@adhd/sox-graph-store": major`
- `.changeset/bl460-sox-vector-store-adapter.md:2` — `"@adhd/sox-vector-store": major`
- `.changeset/bl460-sox-embedding-provider-warmup.md:2` — `"@adhd/sox-embedding-provider": major`

All three target packages are pre-1.0 (`0.5.3`, `0.3.3`, `0.1.0` respectively). `@changesets/cli`
does **not** special-case 0.x semver — `major` always computes `(X+1).0.0` regardless of the
current major being `0`. I verified this is exactly what would ship: `npx changeset status
--verbose` in this worktree (before any edit) printed

```
info Packages to be bumped at major
- @adhd/sox-embedding-provider 1.0.0
- @adhd/sox-graph-store 1.0.0
- @adhd/sox-vector-store 1.0.0
```

This directly contradicts the repo's own **already-documented, owner-set policy**, which I found
independently stated in four places, verbatim-consistent: `docs/decisions/0010-open-node-and-edge-typing.md:135-136`
("Under 0.x semver the minor slot is the breaking slot, so `0.6.0` is still the correct next
version"), `docs/reporting/memory/PLAN.md:2966-2967` (identical wording, PKT-63's own packet
body), `docs/reporting/memory/findings/open-node-typing-design.md:358`, and
`docs/plan/publishing/SCOPE.md:464` ("`0.x` + clear 'minor=breaking' policy"), corroborated by
`docs/substrate/.catalog/distribution.md:216` ("Pre-1.0: All are 0.x.y, so minor version bumps MAY
include breaking changes"). BL-444's own body (`BACKLOG.md:2772`) asserts "0.6.0 is still the
correct number" as settled fact — **but nobody had actually run `changeset status` against the
committed changesets to check that claim holds.** It doesn't, as filed. The fix is one word per
file: `major` → `minor`. Confirmed by semver arithmetic (`X.Y.Z` minor bump is `X.(Y+1).0`,
independent of `changeset`'s internals, since the cascade-tier bump type for dependents is
governed separately by `updateInternalDependencies: "patch"` and is unaffected by this change):
`0.5.3 → 0.6.0`, `0.3.3 → 0.4.0`, `0.1.0 → 0.2.0`. **`0.6.0` for graph-store is not a title someone
picked — it is the literal, correct output of the fix below, and only the fix below.**

I did not find a config-level fix (no `@changesets/config` flag exists for "treat major as minor
pre-1.0" as of `@changesets/cli@2.31.0` — confirmed via `PUBLISHING.md`'s own explicit note that
`changeset publish --dry-run` doesn't exist either, i.e. this CLI version's feature set is already
independently characterized in this repo and nothing resembling a 0.x flag is mentioned anywhere
in `.changeset/config.json` or `PUBLISHING.md`). The fix is per-changeset, by convention, forever:
**any future breaking change to a still-pre-1.0 `@adhd/sox-*` package must be filed as a `minor`
changeset, never `major`, until that package's own team makes an explicit, separate decision to
cross 1.0.0.** This packet does not add tooling to enforce that (out of scope — flagged as a
process note, not a BL item, since `check-changeset-surface.ts`'s job is presence-of-changeset, not
bump-type correctness, and widening its scope is a different packet).

---

## 2. The change, file by file

### In bounds

| File | Change |
|---|---|
| `.changeset/bl460-sox-graph-store-edgerel-open.md` | line 2: `major` → `minor`. Body text unchanged — it already correctly describes the break; only the semver *slot* was wrong, not the description. |
| `.changeset/bl460-sox-vector-store-adapter.md` | line 2: `major` → `minor`. Same reasoning. |
| `.changeset/bl460-sox-embedding-provider-warmup.md` | line 2: `major` → `minor`. Same reasoning. **Note:** this package's break (`warmupTimeoutMs` gains a required param, BL-376) is not one of the two breaks BL-444/the dispatch brief named — it is a third, real, major-flagged-then-corrected-to-minor break riding the same train. The release note (§4) must cover it too; leaving it out because the dispatch brief only named two would be incomplete, and incompleteness is exactly what BL-444 exists to prevent. |
| (all 8 other `.changeset/bl460-*.md` files) | **No change.** Read and verified correct as committed — patch/minor bump types already match their additive-only bodies. |
| `**/package.json` (18 files — see §2a) | Regenerated by `npx changeset version`. **Never hand-edit a version field.** |
| `**/CHANGELOG.md` (18 per-package files) | Regenerated by `npx changeset version` from the changeset bodies. **Never hand-edit.** |
| `pnpm-lock.yaml` | Regenerated by `pnpm install` after `changeset version` (BL-150 relock rule — new internal version pins are a lockfile-relevant change even though no new `workspace:*` edge is added). |
| `CHANGELOG.md` (repo root) | **New** `## [Unreleased] — BL-444: …` section — the wave-level release note. This is the actual deliverable BL-444's title names ("a release note that states what breaks"). Content spec in §4. |
| `registry/index.json` | Regenerated by `npx nx run registry:sync-index` **only if** any bundled extension's `dist/` content changed as a result of the dependency version bumps propagating into `memory-cli`/`memory-flush`/`memory-server`'s inlined build (§6 — check, don't assume). |
| `BACKLOG.md` status header | Regenerated automatically when the 7 backlog items below are transitioned via the graph tool (BL-224 — never hand-edit counts). |

### Out of bounds — and why

- **No `src/**/*.ts` in any of the 18 bumped packages.** Every functional change already shipped
  in the six merged prerequisite packets. If you find yourself editing `index.ts` in graph-store,
  vector-store, embedding-provider, or any dependent, you have left this packet — go find who owns
  that file live (per the repo's own concurrency convention) rather than editing it here.
- **`scripts/check-changeset-surface.ts`, `scripts/cascade-plan.ts`, `scripts/check-publishable.ts`.**
  All three are complete, tested, merged tooling from BL-460/BL-452. Use them; do not modify them.
  `cascade-plan.ts`'s own module docstring explicitly warns against re-deriving
  `check-publishable.ts`'s roots-list logic as a "refactor into shared module" side effect — the
  same discipline applies here: use the tools, don't touch them.
- **`libs/data/graph/graph-store/src/open-schema-migration.ts` / `applySchema()`.** BL-442/BL-447
  territory, merged. `docs/reporting/memory/PLAN.md:2973-2977` explicitly warns two workstreams
  must not both hold `applySchema()` — this packet has no reason to open it and must not.
  `tools/graph-store-migrate-open-schema.mjs` (the operator migration CLI, PKT-61) is similarly
  finished; cite it in the release note, do not edit it.
- **`.github/workflows/release.yml`.** Unrelated to this packet; the CI publish flow already
  matches `PUBLISHING.md`'s documented steps and this packet stops before the step that flow
  automates.
- **Root `package.json` `"version": "1.0.0"`.** Never touched by changesets (the root workspace
  package is private and outside every package's dependency graph) and must not be hand-bumped —
  there is no single "the ecosystem version"; each `@adhd/sox-*` package has its own.

### 2a. The exact 18-package version-bump set (verified via `changeset status --output=<json>`,
cross-checked against `cascade-plan.ts`'s independent static-graph computation — `cascade-plan:
OK`, no disagreement in either direction on this target set)

| Package | Current | New (after the §1c fix) | Bump | Source |
|---|---|---|---|---|
| `@adhd/sox-graph-store` | 0.5.3 | **0.6.0** | minor (corrected from major) | direct changeset |
| `@adhd/sox-vector-store` | 0.3.3 | **0.4.0** | minor (corrected from major) | direct changeset |
| `@adhd/sox-embedding-provider` | 0.1.0 | **0.2.0** | minor (corrected from major) | direct changeset |
| `@adhd/sox-host-registry` | — | +minor | minor | direct changeset |
| `@adhd/sox-host-runtime` | — | +minor | minor | direct changeset |
| `@adhd/sox-install-engine` | — | +minor | minor | direct changeset |
| `@adhd/sox-manifest` | — | +minor | minor | direct changeset |
| `@adhd/sox-mcp-runtime` | — | +minor | minor | direct changeset |
| `@adhd/sox-service-proxy` | — | +minor | minor | direct changeset |
| `@adhd/sox-store-adapter` | — | +minor | minor | direct changeset |
| `@adhd/sox-authoring` | 0.2.0 | +patch | patch | direct changeset (doc-only) |
| `@adhd/sox-nx` | — | +patch | patch | cascade (`updateInternalDependencies:"patch"`) |
| `@adhd/sox-hybrid-search` | 0.3.3 | +patch | patch | cascade (graph-store dependent, BL-444's own list) |
| `@adhd/sox-claim-verification` | — | +patch | patch | cascade |
| `@adhd/sox-memory-core` | 0.5.0 | **0.6.0** | minor (amended §9 Q1 — direct changeset for BL-441's own new surface, *in addition to* the graph-store cascade pin) | direct changeset (filed during implementation; see §9) |
| `@adhd/sox-analysis` | 0.1.4 | +patch | patch | cascade (graph-store dependent, BL-444's own list) |
| `@adhd/sox-task-queue` | — | +patch | patch | cascade |
| `@adhd/sox-blob-store` | — | +patch | patch | cascade |

Run `git diff --stat -- '**/package.json'` after `changeset version` and confirm it touches
**exactly** these 18 `package.json` files, no more, no fewer. If it touches a 19th, or misses one
of these 18, STOP — that is a real disagreement between the static graph and the changeset engine
that `cascade-plan.ts` did not predict, and it needs investigation before you go one step further,
not a shrug.

---

## 3. Every decision, ruled

**D1 — bump-type correction (major → minor on the 3 pre-1.0 packages).** Ruled in §1c. Losing
alternative: leave the changesets as `major` and let graph-store/vector-store/embedding-provider
ship as `1.0.0`/`1.0.0`/`1.0.0`. Loses because it directly contradicts BL-444's own filed text, the
task's own title ("cut the 0.6.0 release train"), and four independent docs stating the pre-1.0
minor-is-breaking policy — publishing `1.0.0` would be a false stability signal for three libraries
whose interfaces are still actively moving (this is the fourth breaking change to graph-store's
type surface in one wave alone) and would need its own separate, deliberate 1.0.0 decision this
packet is not chartered to make.

**D2 — scope: the whole wave (11 changesets / 18 packages), not just graph-store's four named
dependents.** BL-444's body and the original PLAN.md packet framing (`docs/reporting/memory/PLAN.md:2942-2949`)
describe only graph-store's cascade. But `cascade-plan.ts` (which did not exist when BL-444 was
filed) auto-detects targets from **every** pending changeset, and 11 are committed, spanning 8
unrelated packages (host-registry, host-runtime, install-engine, manifest, mcp-runtime,
service-proxy, store-adapter, authoring) that have nothing to do with graph-store. Losing
alternative: publish only the graph-store-cascade subset (graph-store + vector-store +
hybrid-search + analysis + memory-core) now, leave the other 6 changesets pending for a later
train. Loses because it reintroduces exactly the multi-train cost BL-444 exists to eliminate — the
task brief is explicit ("Publish once"), `check-changeset-surface.ts` already treats all 11 as one
coherent surface-covered set, and there is no dependency reason to split them: they don't conflict,
they were all reviewed and merged to `main` already, and splitting only manufactures a second
`changeset version` cycle for no benefit.

**D3 — the wave-level release note lives in root `CHANGELOG.md` under `## [Unreleased] — BL-444:
…`, not a version-numbered header, and not a new file.** Ruled by precedent: I read the root
`CHANGELOG.md`'s actual convention (26+ existing entries, `git log`-verified back to the file's
current head) and **every single entry** uses `## [Unreleased] — BL-<id>: <one-line outcome>` —
never an npm version number. This is the *repo-level* changelog (backlog-lifecycle record per
AGENTS.md's "RESOLVED items move to CHANGELOG.md" rule), and it is structurally distinct from the
**per-package** `CHANGELOG.md` files (e.g. `libs/data/graph/graph-store/CHANGELOG.md`, machine-
generated by `changeset version` from the 11 changeset bodies — I confirmed the existing format
there is `## <version>` / `### Major|Minor|Patch Changes`, changesets' own convention, and that
file must not be hand-edited). Losing alternative A: a version-numbered root header
(`## [0.6.0] — 2026-08-07`), per the `changelog-writer` skill's literal example. Loses because
there is no single "0.6.0" for the repo — 18 packages bump to 18 different numbers in this train,
root `package.json` never moves, and inventing a fictitious repo-wide version number would be the
first one in this file's history and would break the 26-entry precedent for zero benefit (the
BL-id already uniquely identifies the entry, exactly as it does for every other entry). Losing
alternative B: a standalone `RELEASE_NOTES.md` or `docs/reporting/publishing/*.md`. Loses because
`CHANGELOG.md` root already IS the canonical resolved-item record per AGENTS.md, this item is
resolving, and a second parallel doc tree for release notes duplicates a location that already
exists and is already read by every agent.

**D4 — close the 7 backlog items (BL-438/439/440/441/443/444/448) at the END of this packet, after
the release is fully prepared (versions bumped, changelog written, gate green), not before.**
BL-442 is excluded — it is already resolved and moved to CHANGELOG (verified: no `### BL-442`
heading remains in `BACKLOG.md`, and `git log --oneline -- BACKLOG.md` shows `c40b186b docs
(memory-core): resolve BL-442 — operator open-schema migration ships (PKT-61)`). The task brief's
list of "8 items closing together" is stale by one — BL-442 already closed in an earlier commit;
only 7 remain open. Losing alternative: close them as soon as their own code merged (i.e., they'd
already be closed by the six prerequisite packets' own implementers). Loses because that is not
what happened (verified: all 7 headings are still `**Open**` in `BACKLOG.md` right now) and,
more importantly, because per BL-225 a status marker records a **verified outcome** — for BL-444
specifically, "one train" is not verified until the train is actually assembled (versions bumped,
note written, gate green); closing it before that point would be exactly the BL-225 violation this
repo has been burned by four times already (BL-88/95/115/167, per `CLAUDE.md`'s own list).

**D5 — do not attempt to also fix `check-changeset-surface.ts` to catch bump-type errors like §1c
in general.** The gate that exists (BL-460) checks *presence* of a changeset for a `.d.ts` surface
delta; it does not, and per its own docstring is not designed to, judge whether the *declared bump
type* matches this repo's 0.x policy. Losing alternative: extend it in this packet since I found a
real gap. Loses because it is a second, independently-scoped tool change (a new BL item, filed
below) with its own acceptance criteria and its own review — bolting it onto a release-mechanics
packet risks exactly the scope creep BL-444 itself is about (multiple concerns landing in one
train without independent review). **Filed as BL-481** (see §7) instead of silently left
undiscovered.

**D6 — run `npx nx run-many -t build,lint,test,typecheck` (and the smoke test) *before*
`npx changeset version`, not after.** `changeset version` only rewrites `package.json` version
fields and `CHANGELOG.md` bodies — it cannot itself break a build. But BL-235's destructive-build
warning means every `nx build` invocation is a one-way door if source doesn't compile; sequencing
the (expensive, ~18-package) full gate before the (cheap, purely textual) version bump means a gate
failure costs nothing to recover from (nothing was mutated yet) — a gate failure discovered *after*
version bump would leave you needing to decide whether to revert the version files too. Losing
alternative: version first, gate after. Loses on pure risk-minimization with zero offsetting
benefit — there is no dependency from `changeset version`'s correctness on the gate having run.

**D7 — `pnpm-lock.yaml`, the 18 `package.json`s, the 18 per-package `CHANGELOG.md`s, and the root
`CHANGELOG.md` land in one commit; the 7 backlog transitions land as a separate, second commit.**
Losing alternative: one giant commit for everything. Loses because the backlog-graph transitions
are tool-mediated MCP calls (`backlog_resolve_item`), not file edits — they don't produce a diff to
pathspec at all in the same sense, and mixing "prepared a release" with "closed backlog items" in
one commit message would misstate what the commit actually contains if `git log -p` is ever read
for either purpose independently.

---

## 4. The release note — exact required content (root `CHANGELOG.md`, new top section)

Insert as the **first** entry (immediately after `# Changelog`, before the current top entry),
titled `## [Unreleased] — BL-444: one release train — and a release note that states what breaks`.
It must contain, at minimum, in this order:

1. **The "why one train" cost statement** — graph-store's four in-repo runtime dependents pinned
   exactly at publish, the BL-452 eight-releases-for-one-fix precedent, five packets touching the
   package in this wave. One paragraph, citing `BACKLOG.md`'s BL-444/BL-452 by id (do not restate
   their full bodies).
2. **Three source-breaking changes, each with its migration**, verbatim-consistent with what the
   changeset bodies already say (do not re-derive — copy the load-bearing facts forward):
   - `EdgeRel` (`@adhd/sox-graph-store` 0.5.3→0.6.0): widened from a closed 10-member union to
     accept `(string & {})`; breaks in **return position** — `const r: EdgeRel = rec.rel` and any
     exhaustive `switch`/`default: assertNever(rel)` idiom over `EdgeRecord.rel` stops compiling.
     Cite `libs/data/graph/graph-store/src/open-rel-check.bl448.spec.ts`'s `AC-Type` case as the
     test that demonstrated the compile break, not merely asserted it (verified present:
     `f1c421ce`).
   - `LanceDbVectorBackend` / `openLanceDbVectorStore` (`@adhd/sox-vector-store` 0.3.3→0.4.0):
     constructor config's `db: Database.Database` (raw better-sqlite3 handle) replaced by required
     `adapter: StoreAdapter`. Migration: construct the adapter the same way
     `@adhd/sox-store-adapter`'s own consumers do, pass it as `adapter` instead of `db`.
   - `warmupTimeoutMs` (`@adhd/sox-embedding-provider` 0.1.0→0.2.0): gained a required
     `cacheHit: boolean` parameter; any zero-arg call site (the only legal call under 0.1.0) stops
     compiling. Migration: pass the cache-hit boolean at the call site (BL-376).
3. **The non-compile-break behavior change, stated explicitly because it is easy to miss:**
   `node.kind`/`edge.rel` open (their `CHECK` constraints drop) on **new stores only**
   (`CREATE TABLE IF NOT EXISTS` no-ops against an existing table — ADR-0010 D1/D4). An existing
   store — **including the live `~/.memory/memory.db`** — keeps rejecting a consumer kind/rel at
   the SQLite layer until an operator explicitly runs the offline migration:
   ```
   node tools/graph-store-migrate-open-schema.mjs --db <path> --confirm
   ```
   Cite ADR-0010 D3 (never automatic, never on connection open) and that this is the *sole*
   remaining path for any store alive today to accept a consumer type (BL-442, already shipped and
   in `CHANGELOG.md` — cross-reference that entry, do not duplicate its body).
4. **Backwards-compatibility, asserted with evidence, not claimed:** the six built-in memory kinds
   and ten memory rels keep working; the `kind:'generic'` + tags convention keeps working and no
   consumer is forced to migrate data; every existing row reads back byte-identically (no column
   added or removed); a caller passing no `typePolicy` sees pre-wave behaviour. Cite the acceptance
   test that proves this, per BL-444's own acceptance clause (§5, AC-444-2 below).
5. **The full 18-package version table** from §2a (or a link to it — this SPEC file is committed
   in the worktree and can be cited by path once merged, but inline the table is preferred so the
   changelog entry is self-contained without requiring `git show` archaeology later).
6. A closing line naming the 7 backlog items this note retires: BL-438, BL-439, BL-440, BL-441,
   BL-443, BL-444, BL-448 (BL-442 already retired separately — say so, don't re-list it as if new).

---

## 5. Acceptance criteria (per BL-id, each with a stated RED arm)

**AC-444-1 — bump types are policy-correct.** GREEN: `npx changeset status --verbose` on this
branch, after the §1c edit, prints `@adhd/sox-graph-store` under "Packages to be bumped at minor"
targeting `0.6.0`, `@adhd/sox-vector-store` targeting `0.4.0`, `@adhd/sox-embedding-provider`
targeting `0.2.0` — zero packages under "at major". **RED (already reproduced by me, this run,
this worktree, before any edit):** the identical command against the unedited `.changeset/*.md`
files prints all three under "Packages to be bumped at major" targeting `1.0.0`/`1.0.0`/`1.0.0`.
This is not hypothetical — I ran it and pasted the real output above (§1c).

**AC-444-2 — the non-breaking half is genuine, not asserted (BL-444's own acceptance clause).**
GREEN: the PKT-62/BL-443 conformance fixture (`libs/data/graph/graph-store/conformance-fixture/`,
already merged, `9df240d2`/`f73fdc8d`) — which `npm pack`s the built tarball, installs it outside
the workspace, and registers a consumer kind/rel, writes/reads/traverses/queries by kind, and
asserts `EXPLAIN QUERY PLAN` resolves via `ix_node_kind` with no `json_each` — passes when run
against the **rebuilt `dist/`** produced by this packet's gate (§6). **RED:** run it against a
`dist/` built from `main` before BL-439/BL-440/BL-448 merged (i.e. `git show
<pre-wave-sha>:libs/data/graph/graph-store/src` built to a scratch dir) — it must fail (no
`registerKind`/`registerRel` surface exists yet). Do not re-author this test; it already exists
and already went red→green in PKT-62. This packet's job is to confirm it is **still** green
post-version-bump, since `changeset version` never touches `src/`, only `package.json` and
`CHANGELOG.md` — a regression here would indicate the version bump somehow broke the build, which
would be a real and urgent finding, not routine.

**AC-444-3 — the `EdgeRel` compile break is demonstrated, not merely described (BL-444's second
mandatory acceptance half).** GREEN: `libs/data/graph/graph-store/src/open-rel-check.bl448.spec.ts`'s
`AC-Type` case (already merged, `f1c421ce`) is present, named, and passing in the current suite
run — confirm via `npx nx test graph-store` and grep the test list for `AC-Type`. **RED:** the same
assertion run against `EdgeRel`'s pre-widen declaration (10-member closed union, no `(string &
{})`) — i.e. the git blob at the commit immediately before `b64bc3d8` — must fail to compile
(TS error), proving the widen is the actual cause of the break, not an artifact of the test itself.
Already proven in PKT-74; this packet re-confirms it did not regress.

**AC-444-4 — `pnpm install` relock is committed (BL-150 constraint, folded into this AC because
BL-444's own acceptance clause names it explicitly).** GREEN: `pnpm-lock.yaml`'s diff, after
`changeset version` + `pnpm install`, shows the 18 packages' internal pins moved to their new
versions, and that diff is committed in the same change as the version bumps. **RED:** running
`pnpm install --frozen-lockfile` against the bumped `package.json`s with the pre-relock
`pnpm-lock.yaml` fails (`ERR_PNPM_OUTDATED_LOCKFILE` or equivalent) — this is the observable
failure BL-150 exists to prevent, and it is trivial to reproduce: just don't run `pnpm install`
after `changeset version` and try `--frozen-lockfile`.

**AC-444-5 — the release note exists and names all three breaks.** GREEN: root `CHANGELOG.md`
contains the `## [Unreleased] — BL-444: …` section (§4), and grepping it for `EdgeRel`,
`LanceDbVectorBackend`, and `warmupTimeoutMs` all match. **RED:** current root `CHANGELOG.md` (this
worktree, unedited) has no section mentioning any of the three — confirmed:
`grep -c "EdgeRel\|LanceDbVectorBackend\|warmupTimeoutMs" CHANGELOG.md` returns `0` today.

**AC-438/439/440/441/443/448 — backlog lifecycle, not new code.** Each closes as a **bookkeeping**
transition once AC-444-1..5 are green: `backlog_resolve_item` (or `backlog_transition_status`) to
`RESOLVED`, with a citation naming that item's own merge commit (listed in §"Root cause" preamble)
**and** the new root `CHANGELOG.md` section this packet adds (since these 7 items' actual
code-level red→green evidence lives in their *own* PKT's history — re-cite it, don't re-derive it —
but their *backlog-graph status* has never been flipped, which is what "Open by design ... flips
together when 0.6.0 ships" in the dispatch brief means). GREEN: `backlog_get_item` for each of the
7 humanIds returns `status: RESOLVED`. **RED:** `backlog_get_item` for BL-444 right now returns
`status: OPEN` — I ran this and confirmed it (§ tool output, `nodeId 1029`). Do not skip the
`backlog_get_item` re-read after transitioning — a `backlog_resolve_item` call reporting success is
not proof it wrote (per the dispatch brief's own explicit instruction).

---

## 6. Risks, and the sequencing that avoids them

- **`npx nx run-many -t build,lint,test,typecheck` and `nx build` per BL-235 are destructive** —
  `rm -rf dist/` before knowing the rebuild succeeds. This worktree currently has zero uncommitted
  source changes (confirmed: `git status --porcelain` → clean except `pnpm-lock.yaml` from
  `pnpm install`), so there is no unmerged work at risk of being lost — but running the full
  monorepo build is still the single most expensive and highest-blast-radius step in this packet.
  **Sequence it after §1c's tiny, reversible textual edit and before `changeset version`** (D6) so
  a build failure costs nothing but re-running `pnpm install`/re-editing three YAML frontmatter
  lines, never a lost version bump or a half-written changelog.
- **`changeset version` deletes the 11 `.changeset/*.md` files it consumes.** This is expected,
  standard changesets behavior, not data loss — their content is preserved, verbatim, inside the
  newly-written per-package `CHANGELOG.md` sections. Do not attempt to "restore" them afterward.
  If the version bump needs to be redone (e.g. AC-444-1 fails on first attempt), the fix is to
  `git restore --source=HEAD -- .changeset '**/package.json' '**/CHANGELOG.md'` (safe: nothing is
  committed yet at that point, this only discards this packet's own uncommitted local mutation, not
  another agent's work — verify `git status --porcelain` shows only this packet's own files first)
  and re-run from §1c.
- **`registry:sync-index` is the one step where a wrong call order corrupts unrelated entries
  (BL-480, fixed and merged — verified present: `123e5fd3`).** The fix (resolve root via
  `git rev-parse --git-common-dir`) is already live, so running it from this worktree is now safe
  and will not corrupt other extensions' `source` fields the way it did before BL-480. Still: run
  it only if `git diff --stat` shows any of `extensions/bundles/sox-memory-bundle/members/{memory-cli,memory-flush,memory-server}/dist/**`
  actually changed after the full rebuild — check before assuming.
- **Do not re-run `check-changeset-surface.ts` after `changeset version`.** Once `changeset
  version` consumes the 11 `.changeset/*.md` files, the gate's "covered by a pending changeset"
  NOTE path has nothing to point at — it would report these packages as uncovered surface drift,
  which is a **false positive** at this point in the sequence (the coverage moved into the
  materialized version bump + per-package changelog, which is the gate's own intended terminal
  state, not a gap). Run it once, before `changeset version` (§ gate order below), as the actual
  check; treat any run after as informational only, not a gate.
- **Never touch `~/.memory/*`.** Nothing in this packet reads or writes the live store — it is
  pure release mechanics on package manifests and changelogs. Flagging per house rules anyway since
  graph-store/ADR-0010 material is adjacent enough to invite confusion.
- **Do not run `npm publish` or `changeset publish`.** Stop at the point described in §8.

---

## 7. New backlog item filed by this spec

**BL-481 (new, LOW)** — `check-changeset-surface.ts` verifies a changeset *exists* for a `.d.ts`
surface delta but never validates the *declared bump type* against this repo's documented pre-1.0
"minor is the breaking slot" policy (`docs/decisions/0010-open-node-and-edge-typing.md:135-136`,
`docs/plan/publishing/SCOPE.md:464`). Three committed changesets in this exact wave shipped with
`major` against 0.x packages and would have published `1.0.0` silently if `changeset status` had
not been checked by hand (this SPEC, §1c). File this with the implementer's own citations once the
gate runs; it is out of scope for PKT-63 itself (D5) but must not be lost — hand it to the
implementer to file via `backlog_create_item` (family `BL`, priority `LOW`) citing this SPEC file
and `.changeset/config.json` as the fix location (a `pre1_0MinorIsBreaking` boolean-equivalent
check comparing `pkg.version.split('.')[0] === '0'` against the parsed changeset bump type would
close it — do not implement it in this packet).

---

## 8. The gate, in exact order

```bash
cd /Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt63-release-060

# 1. Fix the bump-type defect (§1c/D1) — 3 one-line edits via the Edit tool, not sed.
#    .changeset/bl460-sox-graph-store-edgerel-open.md:2        major -> minor
#    .changeset/bl460-sox-vector-store-adapter.md:2             major -> minor
#    .changeset/bl460-sox-embedding-provider-warmup.md:2        major -> minor

# 2. Confirm AC-444-1 GREEN before anything else.
npx changeset status --verbose
#    expect: graph-store/vector-store/embedding-provider under "at minor", targeting
#    0.6.0 / 0.4.0 / 0.2.0 — zero packages under "at major".

# 3. Full monorepo gate BEFORE any file mutation from changeset version (D6).
npx nx run-many -t build,lint,test,typecheck
node tools/check-suite-tree-state.mjs --project memory-core --require-clean
node tools/check-suite-tree-state.mjs --project graph-store --require-clean
rm -rf dist/smoke && node scripts/smoke-test.mjs

# 4. Publish-readiness checks, online, BEFORE version (per PUBLISHING.md's own dry-run list).
npx tsx scripts/check-publishable.ts
npx tsx scripts/check-changeset-surface.ts          # must be OK/NOTE-only, no FAIL
npx tsx scripts/cascade-plan.ts                     # must print "OK", verify the 18-package
                                                      # bump set from §2a is the changeset-status
                                                      # subset of its printed closure

# 5. Materialize the version bump. One-way local mutation (recoverable — see §6).
npx changeset version
git diff --stat -- '**/package.json'                # must show exactly the 18 files in §2a

# 6. Relock (BL-150 — AC-444-4).
pnpm install
git diff --stat pnpm-lock.yaml                       # must be non-empty

# 7. Registry sync, ONLY if bundled extension dist actually changed (check first).
git status --porcelain -- 'extensions/bundles/**/dist/**'
# if non-empty:
npx nx run registry:sync-index

# 8. Write the wave-level release note (§4) into root CHANGELOG.md by hand (Edit tool).

# 9. Re-run the cheap half of the gate once more (version/changelog files are plain data,
#    but confirm nothing is JSON/YAML-broken from the automated edits).
npx nx run-many -t lint,typecheck

# 10. Publish-readiness proof, without publishing.
npm pack --dry-run --json --workspace @adhd/sox-graph-store
npm pack --dry-run --json --workspace @adhd/sox-vector-store
npm pack --dry-run --json --workspace @adhd/sox-embedding-provider
bash scripts/acceptance/clean-room-smoke.sh          # PUBLISHING.md's canonical gate (verdaccio,
                                                       # no real npm network write)

# 11. Commit — two commits, by explicit pathspec (D7).
git commit .changeset pnpm-lock.yaml CHANGELOG.md \
  $(git diff --name-only -- '**/package.json' '**/CHANGELOG.md' | grep -v '^CHANGELOG.md$') \
  registry/index.json \
  -m "release(train): prepare 0.6.0 release train — graph-store/vector-store/embedding-provider \
breaking, 15 additive/patch riders (BL-444)"
#    (drop registry/index.json from the pathspec if step 7 found nothing to sync)

# 12. Close the 7 backlog items — separate action, not a git commit (D7). For each of
#     BL-438, BL-439, BL-440, BL-441, BL-443, BL-444, BL-448:
#       backlog_resolve_item / backlog_transition_status -> RESOLVED, citing its merge commit
#       (from the "Root cause" preamble above) + the new CHANGELOG.md section.
#     Then backlog_get_item on each — confirm status: RESOLVED (AC, §5). Do not trust the
#     resolve call's own success response.
```

**The single reviewed command that publishes, once a human approves — do not run it:**

```bash
pnpm run release:prepared
```

(= `SOX_REGISTRY_PUBLISH=npm npx tsx scripts/build-index.ts` (portable registry rewrite) →
`nx build sox` → `changeset publish`, per `package.json:16` and `PUBLISHING.md`'s own documented
owner-gated publish sequence — this packet stops here, one command short, as instructed.)

---

## 9. Architect ruling on the implementer's open questions (post-hoc, both GRANTED)

**Q1 — the `@adhd/sox-memory-core` changeset the implementer filed (`bl460-sox-memory-core-ontology-ownership.md`, minor, `0.5.0`→`0.6.0`) is CORRECT. §2a is hereby amended: memory-core row changes from `+patch` / "cascade" to `0.6.0` / minor / "direct changeset (BL-441 surface, filed during PKT-63 — see §1c note below)".**

Read `scripts/check-changeset-surface.ts:1-60` myself: the gate's docstring and Decision C are exactly
as reported — a byte-diff of built `dist/*.d.ts` against the last-published tarball, gated on
*presence* of a naming changeset, with zero bump-type logic. It does not special-case "this package
also happens to be covered by an `updateInternalDependencies` cascade" — cascade coverage exists in
`changeset status`'s internal graph, not in this gate's diff, so a package can legitimately be both
cascade-patched *and* separately need a direct changeset for its own new surface. That is exactly what
happened here: BL-441 (`d64175f5`, merged before this packet started, so its absence from my original
§2a table was my own miss, not a scope violation — I built §2a from `changeset status` output at spec
time, which only reflects packages with pending changesets, and memory-core's BL-441 surface delta had
none until the implementer filed one) added `ontology.d.ts`/`graph-backend.d.ts`, re-exported from
`index.d.ts`, with zero removed or narrowed exports (confirmed via the per-package `libs/memory-core/CHANGELOG.md:1-30`
entry the implementer wrote, which documents the diff against the published `0.5.0` tarball). An
additive-only `.d.ts` delta is textbook minor under ordinary semver — independent of and in addition to
the pre-1.0 "minor is breaking" policy from §1c, which only ever argued for *not* using `major`, never
against using `minor` for a real addition. `0.6.0` is correct, `minor` is correct, and treating it as
cascade-only `0.5.1` would have shipped a real new public surface (a whole new module pair) with no
changeset recording it — precisely the defect class BL-460 exists to catch. No further action needed;
the implementer's own resolution stands as filed.

**Q2 — proceeding to commit (step 11) and backlog close-out (step 12) without a green
`clean-room-smoke.sh` run is APPROVED for this packet, with one binding condition added to the gate.**

Read `scripts/build-index.ts:22,79-139,365-376` myself: BL-390's dirty-tree guard is real, correctly
scoped (it filters to `isChecksumRelevant` files, not a blanket refusal on any dirt — `:139`'s own
comment says as much), and `git status --porcelain -- tmp/apigen` in the shared main checkout
(`/Users/nix/dev/ai/sox-ecosystem`, confirmed by running it myself, *not* the worktree) shows
`?? tmp/apigen/` — untracked, not `.gitignore`d (confirmed: zero hits for `tmp/apigen` or `tmp/` in
`.gitignore`), sitting in the checkout `build-index.ts` resolves to via `git-common-dir` per BL-480.
This is genuinely not this packet's dirt: PKT-63's own worktree diff touches only `.changeset/`,
18 `package.json`s, 18 `CHANGELOG.md`s, `pnpm-lock.yaml`, and root `CHANGELOG.md` — none of which is
`tmp/apigen/ir-cache`. Per house rules ("Never touch/revert/discard changes you did not author") the
implementer was right not to delete or gitignore it out from under whatever concurrent session owns it,
and right not to reach for `--allow-dirty` (that flag exists precisely to produce a `+dirty`-suffixed,
non-authoritative checksum — using it on a *release* gate would silently downgrade the one proof this
step exists to produce). **BL-484 is the correct, sufficient response; filing it and moving on is the
correct call**, for two independent reasons: (a) `clean-room-smoke.sh` is not named by any of
AC-444-1..5 or the 7 backlog ACs in §5 — nothing in this packet's own acceptance surface required it
to go green this run; (b) the packet's entire charter is to stop **one command short of
`npm publish`** (§8 closing note) — `clean-room-smoke.sh` is a pre-publish canary, not a pre-*commit*
gate for a version-bump-only commit that touches no `src/`.

**Binding condition (new, closes the gap rather than silently deferring it forever):** the actual
publish command, `pnpm run release:prepared` (§8 closing block), **must not be run by any human or
agent until `bash scripts/acceptance/clean-room-smoke.sh` has been observed to exit 0 from a clean
tree** (either after BL-484 lands, or once the concurrent session holding `tmp/apigen/` clears it).
This is not a new BL item — it is a precondition folded into the existing "one command short" stop
point this spec already defined in §8, made explicit so it cannot be silently skipped when someone
eventually runs the publish step. Whoever runs `release:prepared` must re-verify §5's ACs are still
green against `main` at that point too (this branch may have moved).
