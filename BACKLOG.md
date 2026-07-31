# Backlog

Project backlog for sox-ecosystem. Each item: what's wrong, where, severity, and a fix sketch.

---

## Current status — 2026-07-18 (regenerated mechanically; see BL-224)

**Total open: 39** (BL-287 resolved 2026-07-30; BL-293, BL-294, BL-295, BL-303 resolved 2026-07-16; BL-62 resolved 2026-07-18; BL-311 verified no live bug 2026-07-18; BL-313 (CRITICAL — live edge-table cascade-delete bug) found and resolved same-day 2026-07-18 — see CHANGELOG.md; BL-306..309 filed 2026-07-11 from native-addon/adapter research; BL-310 filed 2026-07-17, resolved 2026-07-23; BL-312 filed 2026-07-18 from the same memory-server data-integrity investigation; BL-314 filed 2026-07-18 from a stale local content-store mirror discovered while syncing installed skill docs; BL-316, BL-273, BL-254, BL-252, BL-264, BL-297 all resolved 2026-07-23 — see CHANGELOG.md).
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
| **HIGH** | BL-225, BL-284, BL-288, BL-301, BL-302, BL-319, BL-322, BL-323, BL-324, BL-325 |
| **MEDIUM** | BL-99, BL-104, BL-105, BL-312, BL-228, BL-259, BL-296, BL-306, BL-307, BL-308, BL-274, BL-282, BL-285, BL-291, BL-300, BL-315, BL-317 |

## Audit

The comprehensive external-filesystem-write audit is at
[`docs/audits/RUNTIME_FS_WRITES.md`](./docs/audits/RUNTIME_FS_WRITES.md). It
catalogs every file/dir written outside the repo, with section 17 proposing a
two-package refactor (`@adhd/sox-config` + `@adhd/sox-log`) and section 19
linking to gap specifications in the adhd repo
(`docs/environment/adoption-survey/GAP_SPECS.md`).
| **LOW** | `BL-103`, `BL-202`, `BL-255`, `BL-258`, `BL-261`, `BL-283`, `BL-289`, `BL-290`, `BL-292`, `BL-298`, `BL-299`, `BL-305`, `BL-309`, `BL-314` |
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

### BL-215 — operator surface for `healStaleVectors` (model-swap re-embed) — **Open (LOW, feature) (2026-07-05)**

BL-88 shipped `healStaleVectors` (memory-core, bounded, env-gated default-off) but no operator
entry point. Recommended surface (per the implementing agent, endorsed): a `memory_curate`
op (`op: "reheal_stale"`) running one bounded pass and reporting `{scanned, healed, remaining}`,
and/or a CLI loop (`soxe memory reembed`) iterating until `scanned === 0`. Never tick-wired —
a full-store re-embed on model swap must be explicit.

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

### BL-114 — LanceDbVectorBackend is in-memory only, not backed by real LanceDB — **CLOSED (WITHDRAWN 2026-07-04, owner directive) — SEE FOLLOW-UP BELOW**

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

### BL-228 — `compile-wave.js` and `budget-estimate.js` are untracked in their source repo — **Open (MEDIUM)** (2026-07-08)

In `/Users/nix/dev/ai/claude-agents/categories/workflow/skills/plan-state-machine/scripts/`, both files
show `??` under `git status --short` — zero commit history. These are load-bearing scripts for
plan-orchestrator wave dispatch and token budgeting. They cannot be reviewed, bisected, or rolled back.
**Fix:** commit them upstream. (External to sox-ecosystem; filed here because this repo's orchestration
depends on them.)

### BL-255 — `memory-core` declares `@adhd/sox-vector-store` as a runtime dep it no longer imports — **Open (LOW)** (2026-07-10)

`libs/memory-core/package.json:30` — `"@adhd/sox-vector-store": "workspace:*"`. After BL-92 rewired `reembed.ts` to migrate directly in `vec_node`, no file under `libs/memory-core/src/` imports it (only two explanatory comments at `reembed.ts:56, 233` name it).

**Fix:** remove the dependency. ⚠️ This drops a `workspace:*` edge — per ⛔ AGENT CONSTRAINT, run `pnpm install` and **commit the `pnpm-lock.yaml` diff in the same change** (incident BL-150). Do not hand-edit `node_modules`.

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

### BL-296 — `memory-refactor`: 5 extraction work-states use short criterion IDs that don't match their slugs, so gap-check counts them as criterion-less — **Open (MEDIUM, plan defect)** (2026-07-11)

Found by plan-builder while fixing BL-260. `w2a-embedding-provider`, `w2b-graph-store`, `w2c-vector-store`, `w2d-hybrid-search`, `w2e-domain-rewire` declare their acceptance criteria under **short IDs** (`[w2a.N]`, `[w2b.N]`, `[w2c.N]`, `[w2d-hs.N]`, `[w2e.N]`) in `contexts/*.md`, but `gap-check.js` credits a criterion only when its prefix equals the full state slug. So it sees these 5 states as declaring **zero** criteria — one of the 9 residual gap-check fails after BL-260. (Real checks for all 33 short-ID criteria were wired in `audit_memrefactor.py` regardless, so the extraction phase genuinely runs; gap-check just doesn't credit them.)

**Fix (needs a work-context edit — plan-builder, deferred here as it wasn't audit-wiring):** rename the criterion IDs in the 5 `contexts/*.md` to the full slug (`[w2a.1]`→`[w2a-embedding-provider.1]` …) and update the matching `check("w2a.1"…)`→`check("w2a-embedding-provider.1"…)` IDs in `audit_memrefactor.py`. Pure label rename; no scope/deliverable change.

Also surfaced (report-only): several criterion PROSE strings drifted from the shipped API — prose says `resolveProvider`/`applyGraphSchema`/`applyVecSchema`/`contentHash`, ships `createEmbeddingProvider`/`createGraphBackend`/`SqliteVectorBackend` methods/`hexSha256`. The checks were wired to the shipped truth with inline `NOTE:` flags; the prose should be reconciled during the rename.

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

### BL-315 — memory-server has no REST API — every operation, read or write, single or bulk, requires an agent-mediated MCP round trip — **Open (MEDIUM, feature) (2026-07-18)**

Discovered while correcting ~566 memory-server episodes mis-tagged with a garbled fallback topic string (a cluster-label artifact from the write-time topic-selection chain: explicit `topic` param → `[<topic>]` content prefix → cluster label). Server-side, `curateSetTopic` is a single `SELECT`+`UPDATE` against the `node` table[1], and the write-queue's own latency histogram confirms sub-10ms typical cost even under active load (p50 0.40ms, mean 8.1ms, max 548.9ms across 76 completed tasks, `slow_tasks: 0` against a 20s deadline budget)[2] — the bottleneck was never the server, it was that the *only* access path is per-call MCP tool invocation, which costs ~1s+ of LLM-inference/harness-dispatch overhead per call regardless of how fast the underlying op is. `memory_curate` also accepts exactly one `uid` per call for every mutating op (`retag`, `set_topic`, `set_importance`); only `drop-episodes` takes a `uids` array, and only for hard deletes — so a bulk hygiene pass (566 retags) costs 566 full agent turns.

The real gap is broader than curate: the full tool surface — `memory_write`, `memory_write_batch`, `memory_recall`, `memory_curate`, `memory_search_entities`, `memory_list_entities`, `memory_entity_episodes`, `memory_related`, `memory_supersession_chain`, `memory_near_duplicates`, `memory_topics`, `memory_list_projects`, `memory_get_community`, `memory_link`, `memory_invalidate`, `memory_update`, `memory_get_session_state`, `memory_save_session_state`, `memory_stats`, `memory_ping`[3] — is reachable ONLY through MCP tool calls, i.e. only through an LLM agent in the loop. There is no way for a plain script, CI job, cron task, dashboard, or another service to read or write the memory graph without paying agent-turn overhead on every single call, no matter how trivial the underlying op.

memory-server already runs as a persistent HTTP service (SSE transport at `http://localhost:3099/sse` per the host's `mcpServers` config)[4], so the fix is a full REST API surface on that same server — HTTP endpoints mirroring the complete MCP tool surface (not just a batch-curate endpoint), including array/batch variants of the mutating ops (mirroring `memory_write_batch`'s existing pattern) so scripts can drive bulk work in one request. This lets any caller — agent or not — hit the server directly over HTTP, running through the server's own validation/provenance logic (not raw SQLite), without an LLM turn per call.

Citations: [sox-ecosystem@main, memory-curate-latency-triage (forked subagent) + main session agent, claude, memory-topic-fix bulk-retag data-quality task, 1: libs/memory-core/src/curate.ts:239-254, 2: mcp__memory-server__memory_ping tool output (`write_queue.write_latency_ms`), live call 2026-07-18T21:36Z, 3: mcp__memory-server__memory_stats tool output (`tools` array, 19 entries), live call earlier same session, 4: ~/.claude.json `mcpServers.memory-server` entry (`{"type":"sse","url":"http://localhost:3099/sse"}`)]

**UPDATE (2026-07-18, same day): the fix already exists, unused — `@adhd/apigen-cli`.** A first search only checked the local `sox-ecosystem` checkout and the literal name `@adhd/apigen` and concluded no such tool existed; that was wrong on both counts — the family is published under `@adhd/apigen-*` (not a single `@adhd/apigen` package) and lives on the public npm registry, not in this repo. Confirmed via `npm view @adhd/apigen-cli`: published 3 weeks ago by `pseudosky` (this project's own maintainer), description: "The user-facing CLI for **apigen** — take any `.ts` file and expose its exports as an **MCP server, HTTP API (Fastify/Express), CLI, or JSON Schema**, with **zero changes to the source**. Functions are the single source of truth; everything is derived." It depends on `@adhd/apigen-plugin-api-express` and `@adhd/apigen-plugin-api-fastify` (REST target plugins — "One `POST /<namespace>/<fn>` route per export"), `@adhd/apigen-plugin-mcp` (MCP target — meaning apigen could also regenerate memory-server's existing MCP surface from the same source of truth), `@adhd/apigen-plugin-cli-output`, and `@adhd/apigen-plugin-jsonschema`. None of this family is currently a dependency anywhere in `sox-ecosystem` (not installed, not in any workspace `package.json`).

Concrete next step: point `apigen-cli` at `libs/memory-core/src/index.ts` (confirmed via separate investigation to export a clean function per tool — `memoryWrite`, `memoryRecall`, `memoryCurate`, etc., matching the full MCP tool surface) with `--type api-express` or `--type api-fastify` to auto-generate the REST layer this item asks for, with zero hand-written route code. Verify generated output against `@adhd/apigen-conformance`'s vectors before trusting it in production.

Citations: [5: `npm view @adhd/apigen-cli` output (version 0.1.0, published 3 weeks ago by pseudosky, dependency list including apigen-plugin-api-express/api-fastify/mcp/cli-output/jsonschema), live call 2026-07-18T21:49Z, 6: `npm search apigen` output (full `@adhd/apigen-*` family listing), live call 2026-07-18T21:49Z]

**UPDATE (2026-07-18, same day): tried it — not viable as-is, two real bugs, neither in memory-core.** Built and ran it against live `libs/memory-core/src/index.ts` in an isolated scratch workspace (`~/.claude/jobs/003de74c/tmp/apigen-rest-test/`, own `package.json`, `npm install @adhd/apigen-cli`; `sox-ecosystem` itself untouched — confirmed by `git status` before/after, identical). Two blockers, both self-verified (not just relayed from the dispatched agent):

*Bug A — extractor doesn't follow re-exports, so it only sees 2 of ~19 operations.* `index.ts` locally declares exactly two functions, `write` (line 348) and `recall` (line 364); every other tool (`memoryCurate`, `memoryUpdate`, `memoryGetRelated`, etc.) is a re-export — `export { x } from './other.js'`[7]. `apigen-cli generate --type api-express` (both the default extractor and `--v2`) silently extracted only those two, producing a `routes.ts` with exactly `POST /memory/write` and `POST /memory/recall` and nothing else[8] — no error, no "skipped N re-exports" warning, so this would fail silently in real use, not loudly.

*Bug B — the generated server crashes on import, before binding to a port, on current Node.* Both `apigen-cli run` and running the generated `routes.ts` directly via `tsx` throw immediately: `TypeError: Cannot read properties of undefined (reading 'timeOrigin')` inside `@adhd/apigen-runtime`'s own bundled `index.js`, in a minified TypeScript-compiler tracing module it embeds and imports eagerly[9]. Reproduced on Node v24.11.1[10] — this is a bug in the published `apigen-runtime` package, unrelated to memory-core or the generated route code.

**Verdict: don't wire this into sox-ecosystem yet.** Once `apigen-runtime` is fixed upstream (or pinned to a Node version it tolerates) and either `index.ts`'s tool functions move to local declarations (matching `write`/`recall`'s shape) or the extractor gains re-export support, the plan in the prior update still stands: a `libs/memory-rest/` package generating into its own `package.json`, added to the workspace, with `apigen-cli generate` as a build step (not committed generated output). Not attempted further — this was a feasibility spike, not a ship.

Citations: [7: libs/memory-core/src/index.ts:40-333 (re-exports) vs :348,:364 (`write`/`recall`, the only local declarations) — self-verified via `grep -n "^export "`, 8: ~/.claude/jobs/003de74c/tmp/apigen-rest-test/generated/routes.ts:76,82 (`router.post('/memory/write', ...)`, `router.post('/memory/recall', ...)`, only two routes present) — self-verified by reading the file, 9: ~/.claude/jobs/003de74c/tmp/apigen-rest-test/run3.log (full stack trace: `TypeError: Cannot read properties of undefined (reading 'timeOrigin')` at `node_modules/@adhd/apigen-runtime/index.js:24:5831`, fn `Zj`) — self-verified by reading the log, 10: `node -e "console.log(process.version)"` → v24.11.1 — self-verified, matches run3.log's own `Node.js v24.11.1` footer]

### BL-317 — dormant, not fixed: nothing stops a repeat of the 2026-06-26..29 mass topic-mislabeling incident (BL-315/590 episodes corrected) — **Open (MEDIUM, prevention) (2026-07-18)**

The 590-episode data correction (BL-315's discovery context) fixed historical rows only; no write-time code changed. Checked whether the underlying trigger has recurred since: pulled the 40 most-recently-written topics via `memory_topics(sort_by:"last_written", limit:40)` — spans 2026-07-05 through 2026-07-18, including large batches (`tool-catalog` 282 episodes last written 2026-07-17, `plan-state-machine` 93 episodes last written 2026-07-16) — all clean, well-formed labels, zero recurrence of the truncated-content-fragment pattern[1]. Every corrected instance was dated in a tight 2026-06-26 to 2026-06-29 window. So the bug hasn't fired again in ~3 weeks of subsequent write activity, but that's because the specific trigger pattern (a `workflow-researcher` batch writing many short, formulaic "## Sources"/"## Sub-question" footer episodes via `memory_write_batch` without an explicit `topic`, which then cluster together by format-similarity rather than content and inherit one member's truncated text as the label) hasn't repeated — not because anything prevents it from repeating. If that batch-write pattern recurs, the same mislabeling almost certainly recurs.

**Fix sketch:** have `workflow-researcher` (or whatever calls `memory_write_batch` for multi-part research sessions) always pass an explicit `topic` per item — inherited from the parent research question/session — instead of relying on the `[<topic>]` prefix / cluster-label fallback chain documented in `memory_write`'s own tool schema. Secondary: exclude short formulaic "## Sources"/"## Sub-question" footer sections from cluster-label voting so format-similarity can't override content-similarity when a topic is genuinely missing.

Citations: [sox-ecosystem@main, main session agent, claude, memory-topic-fix bulk-retag data-quality task follow-up, 1: mcp__memory-server__memory_topics tool output (sort_by=last_written, limit=40, 166 total topics post-cleanup vs 181 pre-cleanup), live call 2026-07-18T22:0xZ]

### BL-318 — memory-server enrichment pipeline creates ghost episodes with `content: null`, `importance: 1`, no tags, no topic, no project_path — **Open (MEDIUM, data-integrity) (2026-07-23)**

**Observed 2026-07-23 during Morph Fast Apply research session.** After writing 8 `memory_write` episodes (all confirmed with `episode_uid` responses), a subsequent `memory_recall(query="hashline", limit=30)` returned the 8 real episodes plus **13 additional entries** with all fields null except UID, t_valid, score, provenance, and importance (all importance=1). These ghost episodes have `content: null`, `summary: null`, `topic: null`, `tags: []`, `project_path: null`, `content_hash: null`, `agent_id: null`.

**Evidence:**
```
UID prefix: 01KY8D... (same write session as real episodes)
Shown entries with content: null:
  01KY8DYDNHFPQ6VGJEPEG5FKQK
  01KY8DYDNHFPQ6VGJEPEG5FKQM
  01KY8DY5B9Z07HX5DW324JK98C
  01KY8DY5B9Z07HX5DW324JK98D
  01KY8DY5BA45SRC2122RDNNS5H
  01KY8DXZ83PYSAXMS8JJ85W92X
  01KY8DXZ83PYSAXMS8JJ85W92Y
  01KY8DXZ840BKZR915RK1V5SXD
  01KY8DXQN843F878WVFW3K5KAA
  01KY8DXQN843F878WVFW3K5KAB
  01KY8DXQN9F0DNQWP9J6KMCEDD
  01KY8DXQN9F0DNQWP9J6KMCEDE
  01KY8DXK496B01P8G45R6MXM5Q
```
Total: 13 ghost episodes from a session that wrote 8 real episodes (8 writes produced 13 + 8 = 21 total new episodes, meaning ~62% of new nodes are ghosts).

**Root cause (suspected):** The `memory_write` response showed `chunk_count: 3` for several episodes (content exceeded chunk threshold, auto-split at sentence boundaries). Each chunk creates a `DERIVED_FROM` child episode with its own UID. The parent write returns `{episode_uid, chunk_uids[...]}` — the chunk UIDs are acknowledged. But the 13 ghost episodes have UIDs that do NOT match any `chunk_uids` returned by `memory_write`. They appear to be empty placeholder nodes created by the enrichment pipeline (embedding, near-dup detection, clustering) that were allocated but never filled with content.

**Reproduction steps (verified):**
1. Call `memory_write({ content: <episode with content exceeding ~2000 chars>, tags: [...], topic: "tool-catalog", project_path: "<path>" })`
2. Note the returned `episode_uid` and `chunk_uids`
3. Wait >5 seconds for async enrichment to process
4. Call `memory_recall({ query: "<content keyword>", limit: 30 })` 
5. Observe: results include episodes with `content: null` whose UIDs match neither the parent `episode_uid` nor any declared `chunk_uids`
6. These null-content entries lack `t_occurred`, `project_path`, `tags`, `topic`, and `contant_hash` — all fields that every real episode (including chunks) should have

**Impact:**
- Inflated episode counts in a topic/store (episodes that carry no data)
- `memory_recall` can return stub entries that the caller cannot use (null content)
- Callers iterating `memory_recall` result sets must skip entries where `content === null`, a check that should never be necessary
- Over time, these stubs accumulate without being garbage-collected, silently degrading data density

**Fix sketch (depends on root cause):**
- If the ghosts are orphaned enrichment nodes: the enrichment pipeline should not insert a node record until it has actual content to write, or should clean up placeholder nodes that fail to resolve.
- If the ghosts are from chunk-splitting race conditions: the chunking path should verify that each child chunk UID it allocates receives its content before the write response returns.
- If the ghosts are from `memory_write_batch` partial failures: the batch path should not confirm a write that produced empty children.
- Short-term mitigation: add a `DELETE FROM node WHERE content IS NULL AND t_invalid IS NULL` maintenance query that operators can run to purge stubs. Add to the `soxe maintenance` command family.
- Longer-term: add a regression test that writes several episodes (including multi-chunk ones), waits for enrichment, and asserts `memory_recall` returns zero entries with `content: null`.

**Severity:** MEDIUM — no data loss (the content simply never landed), no crash, but pollutes recall results and inflates episode counts silently. Approximately 13 ghosts per 8 real writes in this session (~1.6 ghosts/write).

---

### BL-319 — Database operation metrics are missing computed throughput fields — **Open (HIGH)** (2026-07-27)

**Driver:** TursoAdapter migration uncovered that `memory_ping` reports raw cumulative counters (`embeds_completed`, `embed_duration_ms`) but no computed throughput metrics. Missing:

- `embed_throughput_per_sec` — rolling embeddings/second (from heal AND write-path Phase B)
- `write_to_vector_ms` — wall-clock time from memory_write enqueue to vec_node INSERT
- `vec_insert_duration_ms` — SQL INSERT time for vec_node (isolated from embed time)
- `embed_tokens_per_sec` — tokens processed per second by the ONNX worker
- `backlog_drain_rate` — rate at which the embed backlog is shrinking

The `time_to_vector_ms` metric exists but has 0 samples because all recent embeddings went through `healMissingVectors` which bypasses the write-path instrumentation.

**Files:** `libs/memory-core/src/embed-pipeline.ts` (heal path instrumentation), `libs/memory-core/src/embed.ts` (embed health metrics), `extensions/.../memory-server/src/index.ts` (ping response shape)

**Fix sketch:**
1. Add a rolling `_embedCompletionTimes` array (analogous to `WriteQueue._completionTimes`) in the embed provider to compute throughput
2. Instrument the heal path's per-node timing (currently only write-path Phase B reports `time_to_vector`)
3. Surface `embed_throughput_per_sec` in `memory_ping.embed_pipeline.metrics`
4. Compute `backlog_drain_rate` from backlog deltas over a rolling window

**Severity:** HIGH — missing observability makes capacity planning and regression detection impossible. The `throughput_writes_per_sec` field on the write queue proved its value detecting the Turso noop-queue improvement; the same is needed for embed throughput now that CoreML is active.

---

### BL-322 — Analyze lock contention between embedding system, daemon, proxy, and agents — **Open (HIGH)** (2026-07-27)

**Driver:** During the TursoAdapter migration, the live memory-server reached 97% CPU with the enrich pipeline processing embeddings, causing agents to get MCP timeouts on `memory_recall` and `memory_ping`. It's unclear whether the bottleneck is:

- Turso's EXCLUSIVE file locking (prevents concurrent readers while the enrich pass writes)
- The single-threaded ONNX embedding worker serializing all embed requests
- The proxy architecture serializing MCP requests through a single backend process
- The enrich pipeline's 5-minute tick blocking the event loop during processing

**Key context on Turso locking (updated):**
`multiprocess_wal` is now **enabled by default** in `turso-adapter.ts:111-115`. The EXCLUSIVE locking observed during the initial migration was Turso's default behavior in local file mode WITHOUT `multiprocess_wal` enabled. Now that it's enabled by default (via `.tshm` shared memory coordination), concurrent readers and serialized writers across processes work without file lock contention. Lock contention should NOT be expected behavior — if observed, investigate other bottlenecks first.

`multiprocess_wal` is supported on both macOS and Linux via `.tshm` shared memory files. To opt out (reverting to EXCLUSIVE locking), set `experimental: { multiprocessWal: false }` in adapter options. SqliteAdapter (`better-sqlite3`) always remains a single-writer fallback via `STORE_ADAPTER=sqlite`.

**Files:** `libs/data/store/store-adapter/src/turso-adapter.ts` (multiprocess_wal enabled by default), `libs/data/embed/embedding-provider/src/sharedFastembedProcess.ts` (singleton worker), `libs/host-runtime/src/supervisor.ts` (proxy architecture), `libs/memory-core/src/embed-pipeline.ts` (enrich tick), `extensions/.../memory-server/src/index.ts` (MCP handler loop)

**Fix sketch:** Analyze remaining bottlenecks (Turso EXCLUSIVE locking is eliminated):
1. Does the singleton fastembed process cause head-of-line blocking for all embed requests? If so, can we have a read-only embed queue?
2. Should the proxy route read-only requests (ping, recall, stats) around the backend when the enrich pipeline is saturated?
3. What's the actual queuing model between MCP request arrival, backend processing, and enrich tick?
4. Is the 97% CPU from ONNX inference (expected) or from a deadlock/livelock between the enrich pass and MCP handler?

**Severity:** HIGH — agents getting timeouts is a production reliability issue that undermines the entire memory system. The root cause might be a single-threaded bottleneck, not a Turso limitation.

---

### BL-323 — `db.ts` sqlite-vec load destructures a non-existent `default` export — every `openDb()` on the sqlite adapter throws `Cannot read properties of undefined (reading 'load')` — **Open (HIGH)** (2026-07-30)

**Found while:** writing recall-live-incident regression tests for the `memory_recall` timeout/FTS-dialect fixes (wip/turso-live-metrics).[1] Not caused by that work — reproduces on `main`-derived `db.ts` as of this commit regardless of the recall.ts changes.

**Root cause.** `libs/memory-core/src/db.ts:328` does:
```ts
const { default: sqliteVec } = await import('sqlite-vec');
sqliteVec.load(rawDb);
```
but the installed `sqlite-vec@0.1.9` CJS module (`node_modules/.pnpm/sqlite-vec@0.1.9/node_modules/sqlite-vec/index.cjs`) exposes `load`/`getLoadablePath` as named exports with **no `default` export at all** — confirmed directly: `node -e "import('sqlite-vec').then(m=>console.log(Object.keys(m), typeof m.default))"` prints `[ 'getLoadablePath', 'load' ] undefined`.[2] So `sqliteVec` is always `undefined`, and every call into this branch throws `TypeError: Cannot read properties of undefined (reading 'load')`.[3]

**Impact.** This branch runs for every adapter `!adapter.capabilities.nativeVectors` — i.e. every `SqliteAdapter` open (the `STORE_ADAPTER=sqlite` test/dev path). `openDb()` on sqlite therefore throws on essentially every call right now, which is why `embed-pipeline-metrics.spec.ts`'s `beforeEach` (which forces `STORE_ADAPTER=sqlite` and calls `openDb`) fails at `ctx.cleanup()` with `ctx` undefined — the `beforeEach` never got past `tmpDb()`.[4] This is very likely the dominant contributor to the ~266/267 pre-existing memory-core test failures reported alongside BL-319, independent of the previously-documented `openDb()`-without-`await` test debt.

**Fix sketch:** use the named export directly instead of destructuring a `default` that doesn't exist:
```ts
const sqliteVecModule = await import('sqlite-vec');
const load = sqliteVecModule.load ?? (sqliteVecModule as unknown as { default: typeof sqliteVecModule }).default?.load;
load(rawDb);
```
or simply `const { load } = await import('sqlite-vec'); load(rawDb);`. Verify with a red→green: the `embed-pipeline-metrics.spec.ts` and `recall-live-incident.spec.ts` `beforeEach` hooks (both call `openDb` with `STORE_ADAPTER=sqlite`) should go from throwing `TypeError: ... reading 'load'` to succeeding.

**Owner note:** `db.ts` is currently owned by another in-flight agent (repairing the Turso wiring regression) per branch coordination on `wip/turso-live-metrics` — this item documents the sqlite-path defect discovered during that work; do not let it get lost as "someone else's problem" once that repair lands, since the destructure bug is orthogonal to the Turso-wiring regression and needs its own fix/verification.

**Severity:** HIGH — blocks essentially all `memory-core` unit tests that open a real sqlite-backed `StoreAdapter`, and would equally break any production code path that opens a fresh sqlite store needing the vec0 extension loaded (fresh installs, `STORE_ADAPTER=sqlite` fallback deployments).

Citations: [wip/turso-live-metrics, backend-developer, claude, recall-live-incident-fix, 1: libs/memory-core/src/embed-pipeline-metrics.spec.ts:60-129, 2: libs/memory-core/src/db.ts:328-330, 3: libs/memory-core/src/db.ts:325-331, 4: libs/memory-core/src/embed-pipeline-metrics.spec.ts:112-129]

---

### BL-324 — `memory-server` full suite: 8 reproducible failures in `write.ts`/`db.ts`/`recall.ts` paths, unrelated to the embed-backfill reentrancy fix — **Open (HIGH)** (2026-07-30)

**Found while:** verifying the embed-backfill self-stampede reentrancy-guard fix (`runPeriodicEnrichPassGuarded`, `extensions/.../memory-server/src/index.ts`) on `wip/turso-live-metrics`.[1] Confirmed NOT caused by that fix: `git diff --name-only` shows the fix touches only `index.ts`; every failure below originates in `write.ts`, `db.ts`, or `recall.ts` (all under concurrent, uncommitted edit by another agent restoring the Turso wiring at the time this was filed) and reproduces identically in an isolated single-file `vitest run` with zero other spec files loaded.[2]

**Symptom group 1 — `TypeError: adapter.executeGet is not a function`, 5 failures, all in `recall-sqlite.test.ts`.**
Every case does `const raw = (await openDb(dbPath)).unwrap(); await memoryWrite(raw, {...})` — i.e. the test passes the **raw better-sqlite3 handle** (`StoreAdapter.unwrap()`'s return value) directly into `memoryWrite`.[3] Current `memoryWritePhaseA` (`write.ts:285`) calls `adapter.executeGet(...)` on whatever it's handed, expecting an async `StoreAdapter`, not a raw `Database`.[4] This is a signature drift from the StoreAdapter migration (commit `65171ad`, "wip: TursoAdapter go-live ... StoreAdapter migration") that never updated this test's call sites — either the test needs to stop unwrapping before calling `memoryWrite`, or `memoryWrite` needs to accept/wrap a raw handle. Every one of the 5 `recall-sqlite.test.ts` cases fails identically.

**Symptom group 2 — `SqliteError: attempt to write a readonly database` (`SQLITE_READONLY_DBMOVED`) inside `openDb`'s `pragmaSet` call.**
`async-embed.spec.ts`'s very first `memory_ping` on a freshly-created tmp store throws this as an **unhandled rejection** from `_openDbInner` → `adapter.pragmaSet` (`db.ts:332`, i.e. the pragma-application loop right after the sqlite-vec load block).[5] Reproduces in complete isolation (`vitest run --run src/async-embed.spec.ts` alone, no other files loaded) — not a cross-file state-pollution artifact. Distinct from BL-323 (which is a `TypeError` at the sqlite-vec `default`-export destructure, one step earlier in the same function) — this fires *after* the vec-load succeeds, during pragma application, meaning something in the current `openDb`/`createStoreAdapter` path can hand back an adapter wrapping a handle SQLite considers to have moved/become readonly before pragmas are applied.

**Symptom group 3 — cascading assertion failures downstream of group 2's silent partial failure:**
- `memory-tools.spec.ts` "returns v1 enrichment fields on each result": `provider_call_count` is `1`, expected `0`.[6]
- `permission-guard.spec.ts` "long content auto-chunks ... with DERIVED_FROM edges": edge count is `1`, expected `3`, PLUS an **unhandled** `SQLITE_BUSY` ("database is locked") rejection from `linkChunksToParent`'s `executeRun` racing a concurrent writer on the same file.[7]

These three symptom groups may share one root cause (an in-flight adapter/handle-lifecycle bug in the StoreAdapter migration) or may be two-to-three independent regressions — needs isolated investigation once `db.ts`/`write.ts`/`recall.ts` settle from their current concurrent-edit state. Re-run the full `memory-server` suite after those land and re-triage before assuming any single fix closes all 8.

**Fix sketch:** (1) fix `recall-sqlite.test.ts` call sites to pass the `StoreAdapter`, not `.unwrap()`'s raw handle, OR restore a raw-handle-compatible overload if that's still a supported call shape. (2) Trace why `pragmaSet` sees `SQLITE_READONLY_DBMOVED` on a brand-new tmp file — check for a raced `close()`/reopen or a WAL/journal file getting moved between adapter creation and pragma application. (3) Audit `linkChunksToParent` (`index.ts:1116`) for a missing await/serialization onto the WriteQueue that lets a concurrent chunk-link race the parent write and hit `SQLITE_BUSY` outside WAL's normal retry window.

**Severity:** HIGH — blocks a clean `npx nx test memory-server` run (the mandated pre-merge gate) independent of any single feature branch; 8/147 tests red as of this filing.

Citations: [wip/turso-live-metrics, backend-developer, claude, embed-backfill-reentrancy-fix, 1: extensions/bundles/sox-memory-bundle/members/memory-server/src/enrich-reentrancy.spec.ts, 2: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts (git diff --name-only confirms sole touched file), 3: extensions/bundles/sox-memory-bundle/members/memory-server/recall-sqlite.test.ts:61-66, 4: libs/memory-core/src/write.ts:285, 5: libs/memory-core/src/db.ts:325-332, 6: extensions/bundles/sox-memory-bundle/members/memory-server/src/memory-tools.spec.ts:193-195, 7: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:1114-1118 and extensions/bundles/sox-memory-bundle/members/memory-server/src/permission-guard.spec.ts:343-345]

---

### BL-325 — `memory-core` (not `memory-server`): 18 spec files never `await` the now-async `openDb()`/`WriteQueue.forPath()`, crashing with `TypeError: adapter.executeGet is not a function` / `queue.enqueue is not a function` — **Open (HIGH)** (2026-07-30)

**Found while:** implementing persisted structured logging/tracing for memory-server (BL-320, this session), running `npx nx test memory-core --skip-nx-cache` to verify the new instrumentation didn't regress anything.[1] **Confirmed NOT caused by that work**: `git diff --stat -- libs/memory-core/src/db.ts` shows zero uncommitted diff (another agent's concurrent "restore lost Turso wiring" commit `2ad196f` already folded in the telemetry wrapper), and `git log --follow -p -- libs/memory-core/src/db.ts` shows `openDb()`'s signature changed from `export function openDb(dbPath): Database.Database` to `export async function openDb(dbPath): Promise<StoreAdapter>` as part of the StoreAdapter migration itself (commit history around `65171ad`/`83cd0b0`) — i.e. long before this session's edits.[2] Same root cause as `WriteQueue.forPath`, which is `static async forPath(...): Promise<WriteQueue>` and likewise never awaited by these same specs.[3]

**Distinct from BL-324**: BL-324 catalogs 8 failures in the **`memory-server`** package (`recall-sqlite.test.ts`, `async-embed.spec.ts`, `memory-tools.spec.ts`, `permission-guard.spec.ts`). This item is the same root cause (the StoreAdapter migration's sync→async signature change) but manifesting across **18 spec files in the `memory-core` package itself** — a much larger blast radius that pre-dates and is independent of BL-324's filing. Also distinct from BL-323 (the sqlite-vec `default`-export destructure bug one step earlier in `openDb`) — BL-325 fires even when BL-323 is fixed, because the test files never even `await` the Promise `openDb()`/`forPath()` return in the first place, so they hold a bare `Promise<StoreAdapter>`/`Promise<WriteQueue>` and call methods that don't exist on a Promise.

**Affected files** (each does `const db = openDb(...)` or `const q = WriteQueue.forPath(...)` without `await`, then calls `.executeGet`/`.enqueue`/`.walBytes`/etc. on the Promise):
`backup.spec.ts`, `compaction.spec.ts`, `concurrency-harness.spec.ts`, `db.spec.ts`, `embed-pipeline-metrics.spec.ts`, `embed-provenance.spec.ts`, `errors.spec.ts`, `export.spec.ts`, `invalidate.spec.ts`, `outbox-queue.spec.ts`, `quota.spec.ts`, `recall.spec.ts`, `reembed.spec.ts`, `update.spec.ts`, `write-pipeline.spec.ts`, `write-queue-backpressure.spec.ts`, `write-queue.spec.ts`, `write.spec.ts` (the last three mix both patterns — some call sites in the same file DO await correctly, e.g. `write.spec.ts` has both `await openDb(...)` and bare `openDb(...)` sites, so it partially passes).[4]

**Representative symptoms observed directly:**
- `write-queue.spec.ts`: `TypeError: queue.enqueue is not a function`, `TypeError: queue.walBytes is not a function`, `TypeError: queue.walCheckpoint is not a function` — 26/40 tests failed in this file alone.[5]
- `embed-pipeline-metrics.spec.ts`: `TypeError: Cannot read properties of undefined (reading 'load')` (compounds with BL-323) then `TypeError: Cannot read properties of undefined (reading 'cleanup')` in `afterEach` once `ctx` never resolved — 12/16 tests failed.[6]
- `embed-provenance.spec.ts` / `write-pipeline.spec.ts`: `TypeError: adapter.executeGet is not a function` inside `memoryWritePhaseA`, and `TypeError: tx.executeGet is not a function` inside `applyEmbedding` — same shape as BL-324's symptom group 1, but in memory-core's own specs rather than memory-server's.[7]

**Fix sketch:** mechanical, file-by-file: add `await` at every `openDb(...)`/`WriteQueue.forPath(...)` call site inside these 18 files (including `beforeEach`/helper functions returning a typed object whose declared type must also change from `Database.Database`/sync to the async `Promise`-resolved type). Given the scale (18 files) this deserves its own dedicated pass with a red→green re-run of the full `memory-core` suite — not a drive-by fix bundled into an unrelated feature commit, per this repo's own review discipline.

**Severity:** HIGH — blocks a clean `npx nx test memory-core --skip-nx-cache` run (the mandated pre-merge gate for this package) independent of any single feature branch; well over 200 individual test cases red as of this filing, across both this item and BL-323/BL-324's overlapping symptoms.

Citations: [wip/turso-live-metrics, logging, claude, BL-320-persisted-logging-tracing, 1: libs/memory-core/src/telemetry.spec.ts, 2: libs/memory-core/src/db.ts (git log --follow -p shows the sync→async signature change predates this session), 3: libs/memory-core/src/write-queue.ts:353, 4: libs/memory-core/src/write-queue.spec.ts, libs/memory-core/src/write-pipeline.spec.ts, libs/memory-core/src/embed-provenance.spec.ts, libs/memory-core/src/embed-pipeline-metrics.spec.ts, libs/memory-core/src/write.spec.ts (grep for `= openDb(` / `= WriteQueue.forPath(` without a preceding `await` across these files), 5: libs/memory-core/src/write-queue.spec.ts:54,82,103,131,206,241,275,286,314, 6: libs/memory-core/src/embed-pipeline-metrics.spec.ts:74,118,129, 7: libs/memory-core/src/embed-provenance.spec.ts:70,84 and libs/memory-core/src/write-pipeline.spec.ts:62,132]

---

### BL-326 — `cluster.ts` incremental path is a dead stub: no ordinary write can ever cluster — **Open (HIGH)** (2026-07-30)

**Driver:** `libs/memory-core/src/cluster.ts:437-441` short-circuits unconditionally:
```ts
const isFullPass = !opts.incrementalOnly && episodes.length <= nodeCap;
if (!isFullPass) return { clusters: [], full_pass: false, unclustered_count: episodes.length };
```
`incrementalOnly: true` returns empty regardless of how many valid vectors exist. `runEnrichPassOnDb` (`extensions/.../memory-server/src/index.ts:2024`) calls `runBatchEnrich({ incrementalCluster: !fullPass })`, and `fullPass` is true only when an explicit `organizer_queue` "enrich" row is pending — which `memory_curate {op:'recluster'}` merely ENQUEUES (`curate.ts` `enqueueEnrichFull`), never runs inline. **Net: the only clustering path an ordinary `memory_write` ever reaches is the dead stub.** Proven at both the pure `clusterStore()` level and the production wrapper by `clustering-e2e.test.ts` (commit `3e0742f`), 18/18 green across sqlite AND turso.

**Fix sketch:** implement the `// TODO: local neighborhood check per D1.3`, or make full passes run automatically on a cadence/threshold. Needs an owner decision — this is a design gap, not a typo.

**Acceptance (red→green, must name BL-326):** a test that writes N clusterable episodes, runs ONLY the ordinary write/enrich path (no explicit recluster row), and asserts `total_clustered > 0`. Must fail today.

**Severity:** HIGH — clustering is inert in production. Paired with BL-327 it fully explains the live `cluster_count: 139 / total_clustered: 0 / coverage: 0`.

Citations: [wip/turso-live-metrics, cluster-proof, claude, turso-go-live, 1: libs/memory-core/src/cluster.ts:437-441, 2: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:2024, 3: libs/memory-core/src/curate.ts (enqueueEnrichFull), 4: extensions/bundles/sox-memory-bundle/members/memory-server/clustering-e2e.test.ts]

---

### BL-327 — Communities orphaned by `memory_invalidate` are never garbage-collected — **Open (HIGH)** (2026-07-30)

**Driver:** `materializeClusters` (`libs/memory-core/src/cluster.ts:274-296`) is the ONLY code that invalidates a community node, and it runs only during a real full pass. `memory_invalidate` — the everyday bi-temporal supersession path — sets `t_invalid` on the EPISODE only; it never touches the community node or its `MEMBER_OF` edges. `clusterStats.total_clustered` requires `src.t_invalid IS NULL` in its JOIN (`cluster.ts:659`), so ordinary churn decays `total_clustered` toward 0 while `cluster_count` stays fixed.

**Reproduced** (`clustering-e2e.test.ts` REPRO A): invalidating 8 of 24 episodes drove `total_clustered` 24→16 with `cluster_count` unchanged at 3, target community confirmed still LIVE with all members gone. REPRO B proved a genuine full pass IS self-healing — it invalidates stale communities rather than abandoning them live.

**SUPERSEDES the earlier "downstream of vector scarcity" theory.** Because a sparse full pass correctly RETIRES stale communities, scarcity alone cannot produce the live signature; it requires member churn plus zero full passes ever running (BL-326). Any item still asserting the scarcity explanation should be corrected.

**Fix sketch:** invalidate/retire a community when its live member count reaches zero, or run GC on the invalidate path. Do not rely on full passes (see BL-326).

**Acceptance (red→green, must name BL-327):** invalidate every member of a community, assert the community node is no longer live without running a full pass.

**Severity:** HIGH.

Citations: [wip/turso-live-metrics, cluster-proof, claude, turso-go-live, 1: libs/memory-core/src/cluster.ts:274-296, 2: libs/memory-core/src/cluster.ts:659, 3: extensions/bundles/sox-memory-bundle/members/memory-server/clustering-e2e.test.ts]

---

### BL-328 — Default cluster threshold 0.82 appears mis-calibrated for naturally-worded prose — **Open (MEDIUM)** (2026-07-30)

**Driver:** measured with the real `bge-base-en-v1.5` model (no mocks), intra-group cosine similarity for topically-related but differently-worded episodes is **0.67–0.70**. At the production default of 0.82 a 24-episode / 3-topic corpus produced **zero** clusters. At an empirically-justified 0.65 the same corpus produced `cluster_count=3`, `coverage=1.0`, `largest=8`, `mean_intra_sim=0.809`, `mean_inter_sim=0.504`, **100% purity, zero cross-contamination**. Identical on both backends (turso `mean_intra_sim` 0.8087392163 vs sqlite 0.8087392161 — float noise only).

Suggests 0.82 is calibrated for near-duplicate content, not topical relatedness. If so, clustering under-performs across the board **even after BL-326 and BL-327 are fixed**.

**Fix sketch:** re-derive the default from a real corpus; consider making it adaptive or per-lens. Do NOT change it blind — pair any change with a purity/coverage measurement, since a lower threshold trades purity for coverage.

**Acceptance (red→green, must name BL-328):** a calibration test asserting a realistic multi-topic corpus clusters with both coverage > 0 and 100% purity at the shipped default.

**Severity:** MEDIUM — quality ceiling, not an outage.

Citations: [wip/turso-live-metrics, cluster-proof, claude, turso-go-live, 1: extensions/bundles/sox-memory-bundle/members/memory-server/clustering-e2e.test.ts]

---

### BL-329 — A Turso FTS index permanently blocks EVERY better-sqlite3 fallback path — **Open (HIGH)** (2026-07-30)

**Driver:** once `idx_fts_node` exists (Turso's native Tantivy index), better-sqlite3 fails on ANY query against the store:
```
malformed database schema (__turso_internal_fts_dir_idx_fts_node_key) - near "USING": syntax error
```
SQLite refuses all queries once a single `sqlite_master` object is unparseable, and better-sqlite3's SQLite build cannot parse `CREATE INDEX ... USING fts`. Verified directly: the Turso driver reads the same store fine (9397 nodes) with AND without the `index_method` flag; better-sqlite3 fails outright.

**Blast radius — every better-sqlite3 fallback in memory-core:** sqlite-vec loading (`db.ts`), `dropVec0ViaBetterSqlite3` (`db.ts:198`), `dropFtsResidueViaBetterSqlite3` (`db.ts:259`), and any sqlite-based forensics or backup tooling. This took the live store fully down after the go-live rebuild (every tool call erroring) and blocked every Turso write on a virgin store, independently reproduced 3/3 runs by the clustering e2e work at `db.ts:218` / `_openDbInner` `db.ts:646`.

The immediate trigger was fixed in commit `c3151f5` (the vec0 predicate no longer matches the native `vec_node` table), **but the architectural constraint remains**: any future code assuming it can fall back to better-sqlite3 on a Turso store is wrong, and will fail the same way.

**Fix sketch:** document the constraint on the adapter interface; add a guard/assertion so a better-sqlite3 open of a Turso-native store fails loudly and early with an explanatory error rather than an opaque schema-parse error; audit remaining fallbacks.

**Acceptance (red→green, must name BL-329):** a test that creates a Turso store with `idx_fts_node`, attempts a better-sqlite3 open, and asserts a clear diagnostic error rather than `malformed database schema`.

**Severity:** HIGH — architectural, survives the `c3151f5` fix.

Citations: [wip/turso-live-metrics, team-lead+cluster-proof, claude, turso-go-live, 1: libs/memory-core/src/db.ts:198, 2: libs/memory-core/src/db.ts:259, 3: libs/memory-core/src/db.ts:646, 4: libs/data/store/store-adapter/src/fts-dialect.ts, 5: commit c3151f5]

---

### BL-330 — Unlinked WAL: graceful close SILENTLY discards committed data — **Open (HIGH)** (2026-07-30)

**Driver:** during the go-live the live store's `~/.memory/memory.db-wal` had **no directory entry** (`find ~/.memory -inum 243613830` returned nothing) while the backend held fd `19u` on it with 3,757,472 bytes. Proven consequence on a scratch DB with the same driver: with the WAL unlinked, a graceful `close()` **silently discarded 90 of 140 committed rows and threw no error**. Control with the WAL in place: 60/60 consistent.

**Also proven:** sustained write pressure DOES drain an orphaned WAL through the still-open fd (93.7% recovered) — so a recovery path exists if detected before shutdown.

**Two sub-findings, both independently costly:**
- (a) `sqlite3 .backup` of a live Turso store **silently omits WAL contents** — its newest record was 13h stale while the live store held newer data. Every file-level snapshot taken during this incident lagged reality and repeatedly corrupted forensic conclusions. A consistent snapshot requires the server stopped.
- (b) `~/.memory/` also holds orphaned `memory-turso.db-wal` and `memory-turso-live.db-wal` from earlier migrations, making "a cleanup mistakes a live WAL for debris" a plausible and repeatable cause.

**Fix sketch:** detect an unlinked/missing WAL at open and refuse-or-recover loudly; document the correct Turso snapshot procedure (stop first, or use an in-process `VACUUM INTO`); add a maintenance guard so orphaned `*-wal` files can't be confused with live ones.

**Acceptance (red→green, must name BL-330):** a test that unlinks the WAL, closes, and asserts either full data retention or a loud failure — never silent loss.

**Severity:** HIGH — silent data loss with no error and no recoverable artifact. Experiments preserved at `~/.adhd/sox-ecosystem/memory/corrections-20260730/turso-concurrency/`.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: ~/.adhd/sox-ecosystem/memory/corrections-20260730/turso-concurrency/wal-unlink-test.mjs, 2: ~/.adhd/sox-ecosystem/memory/corrections-20260730/turso-concurrency/wal-autockpt-test2.mjs]

---

### BL-331 — Embed pipeline is now CORRECT but ~18x too slow in production — **Open (HIGH)** (2026-07-30)

**Driver:** after the enrich reentrancy fix (`9d4cf0a`) the pipeline wastes nothing — live counters `embeds_completed: 84, applies_applied: 84, applies_exists: 0, embeds_failed: 0, heals_failed: 0` (previously **6721 discarded vs 169 applied**, ~98% waste). But throughput is **`embed_throughput_per_sec: 0.133`** with **`embed_duration_ms` p50 = 7253ms**, against **~2.1–2.8 embeds/sec measured in a clean-room harness on the same machine with the same CoreML execution provider** (`turso-clean-room.test.ts`). That ~18x gap turns the remaining ~3151-item backlog into roughly 6.6 hours instead of ~20 minutes, and starves concurrent reads (recall degrades to BM25/temporal via the read-path timeout guard).

**Unverified candidate causes** — none confirmed:
1. Head-of-line blocking on the single shared `fastembedProcessHost` child process (serial IPC queue), which is also BL-322's residual open question.
2. Per-item overhead in the heal loop (`embed-pipeline.ts` `healMissingVectors`) versus the harness's tight batch.
3. The per-tick time budget (`SOX_EMBED_HEAL_TIME_BUDGET_MS`) leaving the worker idle between passes.

**Fix sketch:** instrument the gap using the BL-320 JSONL trace (`embed.start`/`embed.finish` durations vs wall-clock between them) to separate queue-wait from compute; then address whichever dominates.

**Acceptance (red→green, must name BL-331):** a benchmark asserting production heal throughput is within a defined factor of the clean-room baseline.

**Severity:** HIGH — the store is functional but backfill takes hours and degrades read latency throughout.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: live memory_ping counters 2026-07-30, 2: extensions/bundles/sox-memory-bundle/members/memory-server/turso-clean-room.test.ts, 3: libs/memory-core/src/embed-pipeline.ts]

---

### BL-332 — `soxe list` reports a running service as INACTIVE (violates `[inv:list-never-lies]`) — **Open (MEDIUM)** (2026-07-30)

**Driver:** with memory-server demonstrably running (launchd unit `com.sox.user.memory-server`, live pid 42844, answering MCP calls), `node bin/soxe list` reported it as `INACTIVE` with an empty PID column, for both the `user` and `project` scope rows. `node bin/soxe service status memory-server -s user` **correctly** reported `loaded: yes` / `live pids: 42844` — so the reconciliation logic exists but `cmdList` does not use it.

This directly violates the `[inv:list-never-lies]` invariant in `docs/spec/service-lifecycle.md`, and is a near-exact repeat of BL-95 (which fixed `cmdStatus` and left `cmdList` broken).

**Fix sketch:** route `cmdList`'s status column through the same reality-verification `cmdStatus`/`service status` uses.

**Acceptance (red→green, must name BL-332):** start a service, assert `soxe list` reports it RUNNING with the correct pid.

**Severity:** MEDIUM — no data risk, but it misleads operators and agents during exactly the incidents where accurate state matters most.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: apps/sox/src/main.ts (cmdList), 2: docs/spec/service-lifecycle.md]

---

### BL-333 — `--allow-volatile-node` is effectively mandatory: no ABI-compatible stable node exists — **Open (MEDIUM)** (2026-07-30)

**Driver:** `soxe service enable memory-server -s user` refuses to pin `/Users/nix/.nvm/versions/node/v24.11.1/bin/node` because it lives under a version manager, and suggests `/opt/homebrew/Cellar/node/26.5.0/bin/node`. But the extension's native modules (`better-sqlite3`, `@tursodatabase/database`) are compiled against **node 24's** ABI — pinning node 26 would break them at load. So `--allow-volatile-node` is currently the ONLY viable option, and the guard's warning ("a version switch will orphan this unit") is a real, unmitigated risk rather than an avoidable one.

**Fix sketch:** either provide/document an ABI-matched stable node, or have the guard verify ABI compatibility and recommend only compatible binaries instead of any stable one. Recommending an ABI-incompatible node is worse than recommending nothing.

**Acceptance (red→green, must name BL-333):** `soxe service enable` on a project with native modules either succeeds with a compatible pinned node, or fails with an ABI-aware message.

**Severity:** MEDIUM — a `nvm use` orphans the live memory-server unit with no warning at switch time.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: apps/sox/src/main.ts (cmdService enable / node pinning), 2: libs/host-runtime/src/ (os-unit generator)]

---

### BL-334 — `memory_ping`/`memory_stats` must report capability + contention facts directly instead of requiring host archaeology — **Open (HIGH)** (2026-07-30)

**Driver:** during the 2026-07-30 Turso go-live, essentially every question that mattered required manual out-of-band investigation on the host, because the status surface does not report it. Each of the following cost real time and, in several cases, produced a WRONG conclusion that had to be walked back:

| Question that mattered | How it had to be answered | Should have been |
|---|---|---|
| Which ONNX execution provider is active, and is it the fast one? | `grep` a CoreML warning out of a startup log | a status field, with a measured throughput figure |
| Is the graph partitioned across EPs (CoreML can't take `word_embeddings` 30522x768, so it splits CPU/ANE per inference)? | reading `[W:onnxruntime] IsInputSupported` warnings by eye | an explicit `partitioned: true` + which ops fell back |
| Are multiple fastembed/CoreML host processes contending? | `ps -eo pid,ppid,rss` archaeology | a contention field naming conflicting pids |
| Is the machine starved (load avg, free RAM)? | `vm_stat` + `sysctl` by hand | ambient-load fields sampled alongside each latency metric |
| Does this store support concurrent multi-process READS? | trial and error — an incorrect "Locking error" conclusion was drawn because the probing connection omitted `experimental:['multiprocess_wal']` | a capability field stating multiprocess WAL is enabled and reads are shared |
| Does it support concurrent WRITES, and does it degrade under load? | a bespoke 3-round experiment script | a capability field plus measured write concurrency |
| Is the embed backlog actually draining, and at what rate? | polling `vec_node` COUNT(*) from a side connection 45s apart | `backlog_drain_rate` (already requested in BL-319, still absent) |
| Where is per-tick wall time going? | reading `enrich.tick.*` lines out of a backend log | a per-phase tick breakdown in status |
| Is `idx_fts_node` present AND populated? | `sqlite_master` query, then a manual `fts_match` probe that returned 0 rows | an FTS health field: index present + document count + last-built |

**The general defect:** `memory_ping` reports plenty of *counters* but almost no *capabilities*, no *environment*, and no *self-assessment*. It reported `"state":"real"` and `execution_provider: "coreml"` while embedding was running 25x slower than the same model on the same machine — technically true, operationally useless. It reported `wal_bytes: 0` while 3.7MB of committed data sat in an unlinked WAL. It reported `enrichment: "stalled"` for five weeks with nothing acting on it.

**Requested fields** (extend `memory_ping`, and/or a new `memory_health`):
- **Embedding:** active execution provider; whether the graph is EP-partitioned and which ops fell back; measured recent embeds/sec; p50/p99; model + dim; whether any OTHER fastembed host process is alive (pid, age) — the advisory lock added under BL-331 already computes this, it just isn't surfaced.
- **Concurrency capabilities, as facts not guesses:** `multiprocess_wal` on/off; multi-process reads supported; multi-writer supported; `needsWriteSerialization`; whether WriteQueue is bypassed (`_noop`); and the exact connect options a second process must pass to join (this alone would have prevented the false "locking is back" conclusion).
- **Measured under load, not just declared:** concurrent read throughput and concurrent write throughput sampled recently, each stamped with the ambient load average and free memory at sample time. A latency number without its ambient load is not evidence — that mistake was made repeatedly today.
- **Store health:** WAL present/linked/size; last checkpoint; FTS index present + populated + doc count; vector coverage (vectored/total) and drain rate; dangling-edge count.
- **Self-assessment:** for each subsystem, a red/yellow/green with the reason — e.g. "embedding: YELLOW — 0.13/s vs 2.5/s baseline, EP-partitioned".

**Fix sketch:** most of these values are already computed somewhere (the BL-320 telemetry, the BL-331 advisory lock, `clusterStats`, `embedBacklogStats`, adapter `capabilities`) — the work is largely surfacing and stamping them, not deriving them. Sample ambient load once per status call rather than continuously.

**Acceptance (red→green, must name BL-334):** a test asserting a single `memory_ping`/`memory_health` call answers every row of the table above without shelling out to `ps`, `vm_stat`, `sqlite3`, or a log file.

**Severity:** HIGH — this is the meta-defect behind today's incident. A 12-hour investigation was spent rediscovering facts the server already knew, and several intermediate conclusions were wrong *specifically because* the status surface was silent (the "locking is back" false alarm, the "13 hours of at-risk writes" over-alarm, the "25x slower" figure taken without recording ambient load). Related: BL-319 (missing computed throughput fields — same root cause, narrower scope), BL-322, BL-330, BL-331, BL-332.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts (memory_ping response shape), 2: libs/data/embed/embedding-provider/src/fastembedProcessHost.ts:210 (hardcoded darwin EP order), 3: libs/data/store/store-adapter/src/turso-adapter.ts (capability flags, none surfaced), 4: libs/memory-core/src/telemetry.ts (BL-320 events already computed but not aggregated into status)]

---

### BL-335 — Restoring/bulk-inserting rows leaves secondary indexes unpopulated; nothing detects or repairs it — **Open (HIGH)** (2026-07-31)

**Driver:** after the 2026-07-30 go-live restore inserted 846 nodes via the Turso driver, `PRAGMA integrity_check` reported **100+ issues** (the check's own message cap — actual count higher): rows missing from **9 secondary indexes** on `node` (`ix_node_importance`, `ix_node_validity`, `ix_node_session`, `ix_node_agent`, `ix_node_hash`, `ix_node_kind`, `ix_node_enrich_ver`, `ix_node_project`, `ix_node_topic`), plus `ix_edge_*`, `idx_vec_node_embedding`, `sqlite_autoindex_memory_scope_1`, and `__turso_internal_fts_dir_idx_fts_node_key`.

The affected rowids begin at **exactly 8552** — the first restored node (the store held 8551 before the restore). So the rows are physically present and readable, but partially **invisible to any query that uses those indexes**. Zero data corruption; purely index entries.

**Why this is serious beyond the one incident:** nothing in the system detects this. `PRAGMA integrity_check` is never run after a restore, on startup, or on any schedule. The store served queries in this state for hours across a restart and a machine crash, and it was found only because a human asked for a manual check. Any bulk-insert path (restore, migration, import) can silently produce it.

**Also observed:** the damage set changed between passes as indexes were repaired, because `integrity_check` truncates at 100 messages — so a single check UNDERSTATES the problem and cannot be used as a simple pass/fail without iterating.

**Fix sketch:**
1. Run `PRAGMA integrity_check` automatically after any bulk-insert/restore/migration path and fail loudly (this repo already has the precedent — `backupStore()` does an integrity check).
2. Add a startup integrity probe with a bounded cost, surfaced in status (see BL-334).
3. Provide a supported repair entry point (a `soxe memory repair`-style command) so this is never hand-rolled again.
4. Investigate WHY driver-level inserts skip index maintenance — that is the real defect; everything above is mitigation.

**Acceptance (red→green, must name BL-335):** bulk-insert N rows through the same path the restore used, assert `integrity_check` is clean afterward (iterating past the 100-message cap).

**Severity:** HIGH — silent partial query invisibility, undetected indefinitely.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: ~/.adhd/sox-ecosystem/memory/corrections-20260730/dbrepair/restore.mjs, 2: live PRAGMA integrity_check output 2026-07-31, 3: libs/memory-core/src/backup.ts (existing integrity-check precedent)]

---

### BL-336 — `_adapter_meta` accumulates DUPLICATE PRIMARY KEY rows, which is schema-impossible and blocks REINDEX — **Open (HIGH)** (2026-07-31)

**Driver:** `CREATE TABLE _adapter_meta ("key" TEXT PRIMARY KEY, value TEXT NOT NULL)` — yet the live store contains six rows with three duplicated keys:
```
rowid 1  adapter_type    turso
rowid 2  adapter_version 0.1.0
rowid 3  created_at      2026-07-30T01:33:19.613Z
rowid 4  adapter_type    turso        <- duplicate PK
rowid 5  adapter_version 1.3.0        <- duplicate PK
rowid 6  created_at      2026-07-30T17:46:26.025Z   <- duplicate PK
```
The first set was stamped by the pre-go-live server at 01:33; the second by the restarted server at 17:46. **A duplicate PRIMARY KEY should be impossible** — the second stamp landed while the unique index was in the inconsistent state described in BL-335, so the constraint was not enforced.

Consequence: `REINDEX _adapter_meta` now fails permanently with `UNIQUE constraint failed: _adapter_meta...`, because the rebuilt index cannot represent the duplicates. The table is stuck dirty until the duplicates are removed, and `integrity_check` can never come back clean.

**Two distinct defects here:**
1. The stamping path (`libs/data/store/store-adapter/src/adapter-meta.ts`) inserts without an upsert guard, so a re-stamp duplicates rather than updating. It should be `INSERT ... ON CONFLICT(key) DO UPDATE`.
2. Constraint enforcement was bypassed. That is the more alarming one and needs its own investigation — if a UNIQUE/PK constraint can silently not apply on this engine while an index is inconsistent, other tables are exposed too.

**Fix sketch:** make the stamp an upsert; add a dedupe/repair step; investigate the constraint bypass. Recommended dedupe semantics: keep the CURRENT `adapter_type`/`adapter_version` but the EARLIEST `created_at` (first stamp is the meaningful one).

**Acceptance (red→green, must name BL-336):** stamp adapter meta twice against the same store, assert exactly one row per key.

**Severity:** HIGH — a violated PRIMARY KEY constraint on a live store, and it permanently blocks integrity repair of that table.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: libs/data/store/store-adapter/src/adapter-meta.ts, 2: live `select rowid,* from _adapter_meta` output 2026-07-31]

---

### BL-337 — `REINDEX <table>` is impossible on any table carrying a Tantivy FTS index — **Open (MEDIUM)** (2026-07-31)

**Driver:** the standard whole-table repair is unavailable on `node`, the most important table in the store:
```
REINDEX node -> Parse error: REINDEX is not supported for custom index methods without a backing btree
```
because `idx_fts_node` (Turso's native FTS index, added 2026-07-30) is a custom index method. The workaround is to enumerate every btree index on the table and `REINDEX` each by name individually, explicitly skipping `idx_fts_node` — which is what had to be done by hand during this incident.

This compounds BL-335: the damage is bulk-insert-induced, and the obvious repair is blocked precisely on the table that matters most. It also means any future runbook or repair tool cannot simply call `REINDEX <table>`.

**Related, same family:** BL-329 (a Turso FTS index permanently blocks all better-sqlite3 fallbacks). Adding the FTS index has now broken two separate maintenance paths; both were discovered only by hitting them in production.

**Fix sketch:** ship a repair helper that enumerates btree indexes and reindexes them individually, skipping custom-method indexes, and separately rebuilds the FTS index via its own DDL. Document the constraint next to the FTS dialect.

**Acceptance (red→green, must name BL-337):** a repair routine that returns a table with a Tantivy index to a clean `integrity_check`.

**Severity:** MEDIUM — a workaround exists, but it is non-obvious and must not be rediscovered by hand each time.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: live `REINDEX node` failure 2026-07-31, 2: libs/data/store/store-adapter/src/fts-dialect.ts, 3: BL-329]

---

### BL-338 — A machine crash must not be able to damage the store, and recovery must be automatic — **Open (HIGH)** (2026-07-31)

**Driver:** the host lost power / crashed on 2026-07-30 evening while the memory-server was live and mid-backfill. Outcome, verified afterward:
- **Data survived intact** — nodes 9397, episodes 4410, edges 47022 all exactly as restored; vectors had progressed 1356 → 1619. No content loss. Turso's WAL did its job.
- **BUT** the store came back with index damage requiring manual repair (BL-335/336/337), and **nothing detected it**. launchd restarted the service, the server opened the store, reported healthy, and served queries in a damaged state.

**The owner's requirement, recorded verbatim as the bar for this item:** *"In the production grade version — none of this is manual & none of the crash data loss should be possible."*

**What "production grade" means here, concretely:**
1. **Automatic integrity verification on startup**, with results surfaced in status (BL-334) rather than requiring a human to run `PRAGMA integrity_check` by hand.
2. **Automatic repair** of index-level damage — which is losslessly repairable by definition, since the rows are intact — instead of hand-run `REINDEX` loops.
3. **Crash-safety verification as a test, not an assumption:** kill -9 the server mid-write and assert the store comes back clean and complete. This has never been tested.
4. No manual step anywhere in detect → diagnose → repair. Every repair performed by hand during this incident (individual REINDEX per index, `_adapter_meta` dedupe) should be a supported, tested code path.

**Related prior evidence that crash-safety is NOT currently guaranteed:** BL-330 proved that with an unlinked WAL a graceful close silently discards committed data (90 of 140 rows, no error) — i.e. there is at least one known state in which shutdown loses data outright. Crash-safety cannot be claimed while that is reachable.

**Acceptance (red→green, must name BL-338):** a crash-recovery test — SIGKILL the server under sustained write load, restart, assert (a) zero lost committed writes, (b) `integrity_check` clean or auto-repaired to clean, (c) the damage and repair both visible in status/logs without human investigation.

**Severity:** HIGH — this is the umbrella requirement behind BL-330/335/336/337. Today's incident was survivable only because a human was watching.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: live PRAGMA integrity_check after unplanned host crash 2026-07-31, 2: BL-330, 3: BL-335, 4: BL-336, 5: BL-337]

---

### BL-339 — TEMPORARY MITIGATION IN EFFECT: `SOX_DISABLE_EMBED_HEAL` is set on the live memory-server and MUST be re-enabled — **Open (HIGH)** (2026-07-31)

**This item exists to guarantee a deliberate mitigation is not silently forgotten.**

**What was done and why:** on 2026-07-31 the live memory-server became effectively read-unavailable — `memory_ping`, `memory_recall` (both paths) and even `memory_topics` (a trivial SQL query) all failed at a 35s timeout, while `memory_write` still succeeded. The embed backfill (~2842 episodes remaining, running at ~0.13 embeds/sec) was monopolizing the process and starving every foreground read. `SOX_DISABLE_EMBED_HEAL` was set to restore read availability, which the store owner explicitly requires ("we need memory service at least partially available for recall, write, ping").

**Cost of the mitigation, stated plainly:** the embed backfill is STOPPED. Vector coverage is frozen at ~1619 of ~4461 episodes (~36%). Semantic recall quality is degraded for every unvectored episode — recall still works, but falls back to BM25/temporal for them. This is a deliberate availability-over-completeness trade, not a fix.

**Re-enable criteria — ALL must hold:**
1. BL-331 resolved: embed throughput restored to something near the ~2.1-2.8/sec clean-room baseline (the CoreML-vs-CPU execution-provider A/B is the leading candidate — the ONNX graph is EP-partitioned because CoreML cannot execute the 30522x768 `word_embeddings` tensor, so every inference pays a CPU/ANE boundary crossing).
2. Resource governance exists so background enrichment can never again starve foreground reads — a throttle, concurrency cap, or priority separation. **Today the ONLY control is this binary on/off env var; that absence is the actual architectural defect** (see BL-334 and the Gap-2 analysis).
3. Read availability verified under sustained backfill load: `ping`/`recall`/`topics` all responsive WHILE the heal pass runs.

**Until then:** the backlog does not drain. Any measurement of vector coverage or recall quality must state that the backfill is disabled.

**Acceptance (red→green, must name BL-339):** with the heal pass ENABLED and a full backlog, assert `memory_ping` and `memory_topics` respond within a sane budget (single-digit seconds) throughout. That test failing today is the whole reason this mitigation exists.

**Severity:** HIGH — an intentional, load-bearing degradation of the live system. Must not become permanent by neglect.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts (SOX_DISABLE_EMBED_HEAL), 2: libs/memory-core/src/embed-pipeline.ts (heal pass + time budget), 3: BL-331, 4: BL-334]

---

### BL-340 — no `typecheck-tests` nx target exists; specs are never typechecked, which is why BL-325's 18-file `await`-drop shipped undetected — **Open (HIGH)** (2026-07-31)

**Found while:** researching Theme 1 (verification harness design, `docs/ideas/theme-1-verification-harness.md`), tracing why BL-325's missing-`await` pattern across 18 memory-core spec files was never caught before it produced 265 red tests.[1]

**Driver:** both `tsconfig.lib.json` and the newer `tsconfig.typecheck.json` at repo root exclude `*.spec.ts`/`*.test.ts` — confirmed by inspection of both files.[2] CLAUDE.md's own `⛔ AGENT CONSTRAINT — BUILD VIA NX TARGETS` section already states "typecheck is not optional, and build does not imply it," documenting that until 2026-07-10 no project had a `typecheck` target at all and `memory-server` shipped 15 real TypeScript errors with a green sweep (BL-248). That fix added `typecheck` targets for production code, but never extended coverage to spec files — so the exact same class of defect (a signature change TypeScript would reject at compile time) can still ship silently through any spec file, and did: `openDb()`/`WriteQueue.forPath()` became `async` (StoreAdapter migration, commit history around `65171ad`/`83cd0b0`), 18 spec files kept calling them without `await`, and nothing caught it until the specs actually ran and threw `TypeError: X is not a function` at runtime (BL-325). A `typecheck-tests` target running `tsc --noEmit` against `**/*.spec.ts`/`**/*.test.ts` would have reported this as ~150+ compile errors with exact file:line:column, before a single test executed.

**Impact:** every spec file in every project is exempt from typechecking. This is not hypothetical — it already produced BL-325's full blast radius once, and nothing prevents an equivalent signature-drift bug from recurring in any other spec file tomorrow, silently, until someone happens to run the affected suite.

**Fix sketch:** add a separate `typecheck-tests` nx target per project (kept distinct from the existing `typecheck` target so a spec-only failure doesn't get conflated with a production-code typecheck failure in CI triage) that includes `**/*.spec.ts`/`**/*.test.ts` and runs `tsc --noEmit` with the same `strict`/`noUnusedLocals`/`exactOptionalPropertyTypes` settings as the lib tsconfig. Add it to the whole-repo gate: `nx run-many -t build,lint,test,typecheck,typecheck-tests`.

**Acceptance (red→green, must name BL-340):** with BL-325 still unfixed, `npx nx run-many -t typecheck-tests` must fail with compile errors pointing at the un-awaited `openDb`/`WriteQueue.forPath` call sites; once BL-325 is fixed, the same command must pass clean.

**Severity:** HIGH — this is the structural gap that let BL-325 (200+ red tests) go undetected; without this target, an equivalent regression in any other spec file recurs silently.

Citations: [wip/turso-live-metrics, qa-expert, theme-1-verification-harness, 1: BL-325 (libs/memory-core/src/*.spec.ts, 18 files), 2: tsconfig.typecheck.json, tsconfig.base.json, tsconfig.lib.json]

---

### BL-341 — `backup.ts`'s post-`VACUUM INTO` integrity check doesn't handle `PRAGMA integrity_check`'s 100-message cap, and Turso's equivalent check (if any) is unverified — **Open (MEDIUM)** (2026-07-31)

**Found while:** researching Theme 1 (verification harness design), designing the integrity-assertion requirement for a crash-recovery/bulk-operation harness (`docs/ideas/theme-1-verification-harness.md` §C.5).[1]

**Driver:** `PRAGMA integrity_check` caps its result set at 100 messages — SQLite's own documented behavior, and already observed directly in this repo's incident history: BL-335 notes "`integrity_check` truncates at 100 messages — so a single check UNDERSTATES the problem and cannot be used as a simple pass/fail without iterating," and the 2026-07-30 go-live restore in fact reported "100+ issues (the check's own message cap — actual count higher)."[2] `libs/memory-core/src/backup.ts` runs its own `integrityCheck` after `VACUUM INTO` (the value assigned at `backup.ts:197`, type declared at `backup.ts:60`) but does not appear to loop past the cap or otherwise detect/flag a capped result — so a backup taken from a store with >100 integrity violations would report the same capped message set as one with exactly 100, silently understating backup-time damage. This is the same failure class BL-335 already named for the restore path; `backup.ts`'s own check is a separate code path (backup creation, not restore) that needs the identical fix.

**Also unresolved:** whether Turso/libsql exposes any integrity-check equivalent to sqlite's `PRAGMA integrity_check` at all is currently unverified — needs a spike. If no equivalent exists, the cross-backend contract suite (Theme 1 §C.2/§C.5) cannot assert integrity symmetrically across both backends without building a bespoke Turso-side check first.

**Fix sketch:** (1) in `backup.ts`, detect a result set of exactly 100 rows from `PRAGMA integrity_check` and either re-run in chunked/targeted mode or explicitly flag the result as "capped, additional damage may exist" rather than reporting it as a bounded count. (2) Spike Turso/libsql's available pragmas/APIs for an integrity-check equivalent; document findings even if the answer is "none exists" so the harness design in Theme 1 can plan around it.

**Acceptance (red→green, must name BL-341):** a test that VACUUM INTO-backs-up a store seeded with >100 independent integrity violations and asserts the backup's reported `integrityCheck` result is explicitly flagged as capped/incomplete, not silently reported as "100 issues" (which reads as a bounded, understatable number today).

**Severity:** MEDIUM — doesn't cause data loss by itself, but produces a misleadingly-bounded damage report exactly when someone is relying on `backup.ts` to characterize how bad a corrupted store is before deciding on a repair strategy.

Citations: [wip/turso-live-metrics, qa-expert, theme-1-verification-harness, 1: docs/ideas/theme-1-verification-harness.md §C.5, 2: BL-335 (BACKLOG.md), 3: libs/memory-core/src/backup.ts:59-60, libs/memory-core/src/backup.ts:196-197]

---

### BL-342 — Restore wrote `tags = ''` (invalid JSON) instead of NULL, breaking `memory_stats` entirely — **Open (HIGH)** (2026-07-31)

**Driver:** `memory_stats` fails outright on the live store:
```
Tool error: Error: step failed: Parse error: malformed JSON
```
Cause: exactly ONE row has an empty-string `tags` value, which `json_valid()` rejects:
```sql
select rowid,uid,substr(tags,1,60) from node where tags is not null and json_valid(tags)=0;
-- [{"rowid":9284,"uid":"01KYN82P706CP6ANBWK2QGKYP7","v":""}]   (count: 1)
```
rowid 9284 falls inside the restored range (the 2026-07-30 restore inserted rowids 8552-9397), so the restore path wrote `''` where the column expects valid JSON, NULL, or `'[]'`.

**Two distinct defects, both worth fixing:**
1. **The restore/insert path does not normalise `tags`.** An empty string is neither NULL nor valid JSON. Any bulk-insert path (restore, migrate, import) must normalise or reject it. Note the restore scripts are preserved at `~/.adhd/sox-ecosystem/memory/corrections-20260730/dbrepair/` — `restore.mjs` is where this originated.
2. **No schema-level guard.** A `CHECK (tags IS NULL OR json_valid(tags))` constraint would have made this impossible to insert. Worth evaluating for `tags` and any other JSON-typed column.

**Immediate remediation:** set the offending row's `tags` to NULL (or `'[]'`), then re-verify `memory_stats`. Blocked at time of filing — the write was declined by the permission classifier and is awaiting the store owner's decision.

**Acceptance (red→green, must name BL-342):** run the restore path against a fixture whose source has empty-string tags, assert every inserted row satisfies `json_valid(tags)` or is NULL, and assert `memory_stats` succeeds afterward.

**Severity:** HIGH — a single malformed row of 9397 disables an entire tool on the live store. Related: BL-335 (the same restore also left secondary indexes unpopulated), BL-343.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: live `memory_stats` error 2026-07-31, 2: live `json_valid(tags)=0` query output, 3: ~/.adhd/sox-ecosystem/memory/corrections-20260730/dbrepair/restore.mjs]

---

### BL-343 — One malformed row disables an entire tool: no row-level resilience in aggregate queries — **Open (HIGH)** (2026-07-31)

**Driver:** `memory_stats` aggregates over all 9397 nodes. A single row with invalid JSON in `tags` (BL-342, rowid 9284) causes the whole call to fail with `Parse error: malformed JSON` — **no partial result, no indication of which row, no degraded mode.** From the caller's perspective the tool is simply dead, with an error that names neither the column nor the row.

This is the same architectural failure the current Theme-2 work targets, in a new place: the system cannot distinguish "one row is bad" from "everything is broken", and it reports the latter.

**What production-grade looks like here:**
- Aggregate/stats queries should be resilient to individual malformed rows — skip and count them, or use a JSON-safe accessor, rather than aborting.
- The error must identify the offending row and column. Diagnosing this took a bespoke `json_valid()` sweep; the error message alone was useless.
- A malformed-row count belongs in the health surface (BL-334) as a first-class integrity signal — this is exactly the class of silent corruption that self-verification is supposed to catch.

**Audit scope:** this is unlikely to be limited to `tags` in `stats.ts`. Any query using `json_extract`/`json_each`/`json_valid` over a whole table has the same fragility. Sweep for them.

**Acceptance (red→green, must name BL-343):** insert one row with malformed JSON, assert `memory_stats` still returns a result, reports the malformed count, and names the offending rowid.

**Severity:** HIGH — 1 bad row out of 9397 (0.01%) produced a total tool outage.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: libs/memory-core/src/stats.ts, 2: live `memory_stats` failure 2026-07-31, 3: BL-342, 4: BL-334]
