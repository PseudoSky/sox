# Backlog

Project backlog for sox-ecosystem. Each item: what's wrong, where, severity, and a fix sketch.

---

## Current status — 2026-07-18 (regenerated mechanically; see BL-224)

**Total open: 91.** (BL-287 resolved 2026-07-30; BL-293, BL-294, BL-295, BL-303 resolved 2026-07-16; BL-62 resolved 2026-07-18; BL-311 verified no live bug 2026-07-18; BL-313 (CRITICAL — live edge-table cascade-delete bug) found and resolved same-day 2026-07-18 — see CHANGELOG.md; BL-306..309 filed 2026-07-11 from native-addon/adapter research; BL-310 filed 2026-07-17, resolved 2026-07-23; BL-312 filed 2026-07-18 from the same memory-server data-integrity investigation; BL-314 filed 2026-07-18 from a stale local content-store mirror discovered while syncing installed skill docs; BL-316, BL-273, BL-254, BL-252, BL-264, BL-297 all resolved 2026-07-23 — see CHANGELOG.md).
This block is DERIVED from the `**...**` status marker on each
`### BL-<n>` heading — an item is open iff its last heading marker starts with `Open`, `REOPENED`,
or `BLOCKED`. **Do not hand-maintain this section.** The previous header (dated 2026-07-07) ranked
five already-RESOLVED items as top priorities, including `BL-62` as the "#1 only PROVEN live bug"
two days after its own heading was marked RESOLVED. Regenerate; never edit in place.

Regenerate with:
```
node -e 'const fs=require("fs");let o=0;for(const l of fs.readFileSync("BACKLOG.md","utf8").split("\n")){const m=l.match(/^###\s*(?:BL|TQ)-\d+\s*—\s*(.*)$/);if(!m)continue;const k=[...m[1].matchAll(/\*\*([^*]+)\*\*/g)].pop();if(k&&/^(open|reopened|blocked)/i.test(k[1]))o++;}console.log("open:",o)'
```

Check for duplicate ids (must print nothing) — see BL-359:
```
grep -o '^### BL-[0-9]*' BACKLOG.md | sort -V | uniq -d
```

Regenerated 2026-07-31: **91 open**.

| Priority | Open items |
|---|---|
| **CRITICAL** | BL-348 |
| **HIGH** | BL-225, BL-284, BL-288, BL-301, BL-302, BL-319, BL-322, BL-324, BL-325, BL-326, BL-327, BL-329, BL-330, BL-331, BL-334, BL-335, BL-336, BL-338, BL-339, BL-340, BL-342, BL-345, BL-346, BL-347, BL-349, BL-351, BL-352, BL-353, BL-356, BL-357, BL-358, BL-364, BL-367, BL-372, BL-373, BL-374, BL-375, BL-377, BL-380, BL-381, BL-382 |
| **MEDIUM** | BL-99, BL-104, BL-105, BL-228, BL-259, BL-274, BL-282, BL-285, BL-291, BL-296, BL-300, BL-306, BL-307, BL-308, BL-312, BL-315, BL-317, BL-318, BL-328, BL-332, BL-333, BL-337, BL-341, BL-350, BL-359, BL-360, BL-361, BL-362, BL-376, BL-378 |
| **LOW** | BL-103, BL-202, BL-215, BL-255, BL-258, BL-261, BL-283, BL-289, BL-290, BL-292, BL-298, BL-299, BL-305, BL-309, BL-314, BL-355, BL-363, BL-379 |
| **UNSET** | BL-163 |

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

**✅ QUESTION 1 ANSWERED 2026-07-31 (BL-331 investigation) — yes, measurably.** Reconstructing in-flight concurrency per pid from `embed.start`/`embed.finish` in the BL-320 telemetry, with system-sleep time subtracted (BL-369), awake embed duration is **monotone in the number of requests outstanding on the same shared child**:[1]

| in-flight on the shared child | n | awake p50 |
|---|---|---|
| 1 | 619 | **6.0 s** |
| 2 | 10 | 53.7 s |
| 5 | 2 | 61.6 s |
| 6 | 2 | 91.2 s |
| 7 | 3 | **149.8 s** |

Per-pid: pid 73540 reached `max_in_flight = 7` with awake p50 **131 s**; every pid that stayed at in-flight 1 sat at **6–8 s**. This is the whole of BL-331's 30–160 s tail. *Stated limit:* 7 × 6 s = 42 s but observed is 149.8 s — **~3.5x beyond strict serialization**, and that residual is not yet attributed.

**Two corrections this forces on the framing above.** (a) The 97% CPU / MCP-timeout symptom has a confirmed contributor that is neither Turso nor a deadlock: the live service runs at **background QoS** (`ProcessType: Background`, hardcoded at `os-unit.ts:458-459`), making every unit of inference ~18x slower and therefore holding the serial queue ~18x longer — see BL-331. (b) The `[fastembed] WARNING … another fastembed host process is ALREADY RUNNING` message, repeatedly cited as evidence of cross-process ANE contention, has been partly self-inflicted by the process leak in **BL-370**; cross-process ANE contention remains **unproven**.

**Still open here:** questions 2–4, the read-only embed queue, and whether bounding/parallelizing the child is the right fix versus simply not saturating it. At minimum, **in-flight depth must be reported through `memory_ping`** — today it can only be reconstructed by hand from a log.

**Severity:** HIGH — agents getting timeouts is a production reliability issue that undermines the entire memory system. The root cause might be a single-threaded bottleneck, not a Turso limitation.

**Related:** BL-331 (root cause of the per-unit cost), BL-369, BL-370, BL-345, BL-351.

Citations: [wip/turso-live-metrics, performance-engineer, claude, BL-331 investigation, 1: ~/.adhd/sox-ecosystem/memory/log-analysis/bl331-inflight.py, 2: libs/data/embed/embedding-provider/src/sharedFastembedProcess.ts, 3: docs/reporting/memory/bl331-root-cause.md §3]

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

**✅ OWNER DECISION (2026-07-31) — resolved as a design, tracked for implementation in BL-349.** Neither of the originally-offered options was taken. The chosen strategy is **write-triggered cluster association executed in the background** — not a periodic full pass, not an inline call — with hard isolation from the embedding path: *"the execution of clustering should never block an embedding from being written. Failing clustering should never drop an embedding."* That isolation is a prerequisite, filed separately as **BL-348** (CRITICAL). The unresolved algorithmic tail — clusters are not constant-time splits and do not self-reorganize — is **BL-350** (research).

**Fix sketch:** implement per BL-349 (background trigger) on top of BL-348 (committed-stage boundary). The original options — the `// TODO: local neighborhood check per D1.3`, or automatic full passes on a cadence — remain relevant to BL-350's research, not to the near-term mechanism.

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

### BL-328 — Cluster threshold 0.82 is mis-calibrated — but UPWARD, not downward — **Open (MEDIUM)** (2026-07-30, re-measured 2026-07-31)

**MEASURED 2026-07-31 (P0.5). The original driver below was wrong on both of its factual claims, and the error runs in the opposite direction from the one suspected.** Full report with distributions, sweeps and reproduction: [`docs/reporting/memory/sandbox/cluster-calibration.md`](docs/reporting/memory/sandbox/cluster-calibration.md). Probes: `~/.adhd/sox-ecosystem/memory/bl328-*.mjs`.

**Corrections to the original driver.**
- *"intra-group cosine … is 0.67–0.70"* — **false for the corpus cited.** Real `bge-base-en-v1.5` measurement over `clustering-e2e.test.ts`'s own corpus: intra 0.7321–0.9013, mean **0.8087**; per-group means 0.8174 / 0.7947 / 0.8141. This reproduces that file's own documented header numbers to 4 decimals.[1]
- *"At 0.82 a 24-episode / 3-topic corpus produced **zero** clusters"* — **not reproducible.** The live test's own step-3.5 probe reports `clusters_at_default: 4, total_clustered_at_default: 21`, confirmed independently by a standalone probe against the production `cluster()` primitive.[1][2]

**What is actually wrong: 0.82 is too LOW at production scale.** Swept over the live store's own 1616 production `vec_node` vectors (read from a copy; no re-embedding):[3]

| τ | clusters | coverage | largest ratio | topic purity |
|---|---|---|---|---|
| 0.65 | 2 | 1.000 | **0.978** | 0.410 |
| 0.80 | 48 | 0.868 | **0.733** | 0.809 |
| **0.82** | 55 | 0.837 | **0.684** | 0.864 |
| 0.85 | 94 | 0.761 | 0.368 | 0.939 |
| **0.87** | 128 | 0.651 | 0.207 | 0.943 |
| 0.90 | 157 | 0.447 | 0.022 | 0.968 |

τ=0.82 is **degenerate** on the real store — 68% of the corpus in one cluster. The degenerate guard (`cluster.ts:465-484`) is the only thing preventing that: it retries once and lands on 0.87. **τ=0.65 — the value `clustering-e2e.test.ts` calls "measured-safe" — puts 97.8% of the real store in a single cluster at purity 0.410.** It is safe on that fixture and nowhere else, and must not be proposed as a production default.

**Why the original inference failed.** The synthetic fixture is the only corpus with a clean separation window (inter max 0.5652 < intra min 0.7321). Real content has a much higher *floor* — inter-group mean 0.6384 (distinct topics) / 0.6803 (adjacent) vs 0.4742 synthetic — while its intra-group means are *higher* than the fixture's (0.8144 / 0.8495 vs 0.8087). Real prose does not fall below the bar; it raises the floor.

Also measured, and load-bearing for any future calibration: in a general 288-row stratified sample across 67 topics, **intra-topic cosine (0.5971) is LOWER than inter-topic (0.6125)**. `topic` is per-write enrichment, not a semantic partition — it is not valid clustering ground truth on an arbitrary sample.

**Fix sketch (revised):** raise the nominal default to **0.85–0.87** so the guard rarely has to fire (0.87 is the value the guard already discovers unaided: 128 clusters, 0.943 purity, 20.7% largest). Do not lower it. The permanent fix is not a constant at all — see **BL-356**.

**Acceptance (red→green, must name BL-328):** a calibration test that asserts, at the shipped default, both (a) coverage > 0 and 100% community purity on a curated multi-topic cohort, AND (b) **non-degeneracy at scale** — `largest_cluster_size / total <= 0.5` on a corpus of ≥1000 real vectors *before* the degenerate guard runs. Criterion (a) alone is what let 0.65 look correct.

**Severity:** MEDIUM — quality ceiling, not an outage.

**Related:** BL-356 (a fixed τ is not calibratable at all), BL-350, BL-349, BL-327.

Citations: [wip/turso-live-metrics, performance-engineer, claude, sandbox P0.5, 1: extensions/bundles/sox-memory-bundle/members/memory-server/clustering-e2e.test.ts:124-141,351-374, 2: libs/memory-core/src/cluster.ts:172-183,918-920, 3: libs/data/analysis/analysis/src/index.ts:143-180, 4: docs/reporting/memory/sandbox/cluster-calibration.md]


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


**UPDATE 2026-07-31 (database-administrator) — reproduced, and the loss is WORSE than recorded. Fixed in the adapter.**

Re-run against `@tursodatabase/database@0.7.1`: create a table, commit 140 rows, unlink the `-wal`, keep writing, `close()`. The close returned **with no error**, and the reopened store did not merely lose rows — **the table itself was gone** (`Parse error: no such table: t`). Total loss of everything since the last checkpoint, not "90 of 140". The control run with the WAL in place retained 140/140.

**A recovery path exists and is cheap:** `PRAGMA wal_checkpoint(PASSIVE)` issued after the unlink copies the orphaned WAL's pages into the still-linked main database file through the fd already held — **140/140 recovered**. `TRUNCATE` also recovers. This is better than the "sustained write pressure drains it (93.7%)" workaround recorded above, and it is what shipped.

**Shipped** (commit `fa786a2`): `captureWalIdentity()` snapshots the WAL's dev+inode at open; `TursoAdapterImpl.close()` re-checks it, and on a vanished or replaced inode emits a loud `store.integrity.damaged` event and checkpoints before closing rather than refusing (refusing would strand the data in an inode nothing can reach). Red→green test naming BL-330 in `integrity-selfheal.test.ts` — verified failing with the close-path guard removed (reopen threw `no such table: t`) and passing with it restored.

**Not yet done, so this item stays open:** sub-finding (a), the documented consistent-snapshot procedure for a live Turso store, and sub-finding (b), the maintenance guard against confusing orphaned `*-wal` debris for a live WAL. `~/.memory/` still holds `memory-turso.db-wal` and `memory-turso-live.db-wal`.

**Note on the citations above:** the two preserved experiment files (`wal-unlink-test.mjs`, `wal-autockpt-test2.mjs`) **do not exist** at the cited path — `~/.adhd/sox-ecosystem/memory/corrections-20260730/turso-concurrency/` contains only `exp.mjs`, `exp2.mjs`, `exp3.mjs`, `count-vecnode.mjs`. The evidence above is a fresh reproduction, not a re-read of those.

Citations: [wip/turso-live-metrics, database-administrator, claude, sandbox P0.1, 3: WAL unlink/control/checkpoint reproduction 2026-07-31, 4: libs/data/store/store-adapter/src/turso-adapter.ts (close path), 5: libs/data/store/store-adapter/src/__tests__/integrity-selfheal.test.ts]

---

### BL-331 — Embed pipeline is now CORRECT but ~18x too slow in production — **Open (HIGH)** (2026-07-30)

**Driver:** after the enrich reentrancy fix (`9d4cf0a`) the pipeline wastes nothing — live counters `embeds_completed: 84, applies_applied: 84, applies_exists: 0, embeds_failed: 0, heals_failed: 0` (previously **6721 discarded vs 169 applied**, ~98% waste). But throughput is **`embed_throughput_per_sec: 0.133`** with **`embed_duration_ms` p50 = 7253ms**, against **~2.1–2.8 embeds/sec measured in a clean-room harness on the same machine with the same CoreML execution provider** (`turso-clean-room.test.ts`). That ~18x gap turns the remaining ~3151-item backlog into roughly 6.6 hours instead of ~20 minutes, and starves concurrent reads (recall degrades to BM25/temporal via the read-path timeout guard).

**Unverified candidate causes** — none confirmed:
1. Head-of-line blocking on the single shared `fastembedProcessHost` child process (serial IPC queue), which is also BL-322's residual open question.
2. Per-item overhead in the heal loop (`embed-pipeline.ts` `healMissingVectors`) versus the harness's tight batch.
3. The per-tick time budget (`SOX_EMBED_HEAL_TIME_BUDGET_MS`) leaving the worker idle between passes.

**✅ MEASURED 2026-07-31 (BL-353) — the fix sketch below was finally executed; results reframe this item.**

Splitting the BL-320 JSONL by whether a pid touches the live store (same code, same machine, same day):

| population | n | p50 | p90 | max |
|---|---|---|---|---|
| test processes | 250 | **297 ms** | 315 ms | 1070 ms |
| live-store processes | 80 | **6936 ms** | **91186 ms** | **10953175 ms (3 h)** |

21 of 80 live embeds exceeded 30 s; 2 exceeded 5 minutes. **So this is ~23x on the median PLUS a catastrophic tail — not a uniform 18x slowdown.** The tail is the more alarming half and was invisible in every aggregate reported to date.

**It is neither queue-wait nor the DB write:** median gap from an embed finishing to the next starting is **9 ms**, and `writequeue.task` p50 is **0 ms** (mean 28–50 ms). The time is inside embed compute, in the live process specifically. Since the code is identical, the cause is contextual — long-lived process state, EP/ANE contention, or memory pressure — and that is the next thing to isolate. Note `embed.*` events carry `trace_id: null`, so embeds cannot yet be correlated to their originating write (BL-351).

**✅ ROOT-CAUSED 2026-07-31 (performance-engineer). Full evidence: [`docs/reporting/memory/bl331-root-cause.md`](docs/reporting/memory/bl331-root-cause.md). Probes: `~/.adhd/sox-ecosystem/memory/log-analysis/bl331-*.{py,mjs}`.**

**This item is THREE defects that an average had blended into one "18x slowdown."**

**(1) The median shift is macOS background QoS — and it is a one-line product defect.**
`os-unit.ts:458-459` emits `<key>ProcessType</key><string>Background</string>` **unconditionally, for every sox launchd unit** — no conditional, no spec field.[1] The live backend and its fastembed child therefore run at scheduling **priority 4**; a terminal-launched process runs at **31**.[2] On Apple Silicon that confines CPU-bound ONNX inference to efficiency cores.

Reproduced by an **interleaved** A/B (arms alternated round-by-round so the shared machine's load hits both equally; `taskpolicy -b` verified to produce the same pri 4):[3]

| round | normal (pri 31) p50 | background (pri 4) p50 | model init normal | model init background |
|---|---|---|---|---|
| 1 | 417 ms | 8174 ms | 642 ms | 8176 ms |
| 2 | 568 ms | 9097 ms | 686 ms | 12012 ms |
| 3 | 435 ms | 7990 ms | 686 ms | 9447 ms |

**~470 ms → ~8400 ms = 18x**, and 14x on model load — so it is a general CPU throttle, not embed-specific. The live server's own figure agrees: p50 **6.0 s** awake at in-flight 1 (n=619).

**The "live vs test" framing was itself wrong.** Ten *terminal-launched* pids that touch the **same live store** sit at awake p50 **0.3–0.9 s** (pids 32380, 58252, 31280, 30385, 34188, 38845, 41373, 49850, 58453, 33499). The split that matters is **launchd-spawned vs terminal-spawned**, not live-store vs test-store.

**(2) The multi-hour "embeds" are a wall-clock instrumentation artifact, not hangs.** `duration_ms` is wall-clock, so it accrues while the machine sleeps. Intersected with `pmset -g log`: the six multi-thousand-second events were **87.2 / 88.3 / 99.7 / 95.4 / 94.7 / 77.9 % system sleep**. The 3-hour embed is **503 s of awake time**. Across the whole >30 s tail: 35130 s wall, **31175 s (88.7%) asleep**; against the ≤30 s population, only **1.1%**. Filed as **BL-369**.

**(3) The remaining 30–160 s tail is head-of-line blocking in the single shared fastembed child** — this item's own candidate cause 1, and BL-322 fix-sketch item 1, finally measured. Awake duration is monotone in in-flight concurrency on the same child: **1→6.0 s, 2→53.7 s, 5→61.6 s, 6→91.2 s, 7→149.8 s**.[4] *Stated limit:* 7×6 s = 42 s but observed p50 is 149.8 s — **~3.5x more than strict serialization predicts**; the residual amplification is NOT yet attributed. Do not report the tail as fully explained.

**Ruled out, with numbers:** text length (within pid 23182 duration is flat across 100→1000 chars with a **5451 ms floor in every bucket** — a floor, not a slope); process age (stable p50 over 763 min, and the A/B reproduced it in a *fresh* process); store size/content (the A/B process opened **no store at all**); sleep as the cause of the median (1.1%); foreground contention as the cause of the tail (zero concurrent non-live events).

**Baseline correction that any future comparison must apply:** **899 of 1755 "test" embeds completed in <10 ms**, with *nothing* between 10 and 100 ms. That population is a deterministic/hash provider, not an ONNX forward pass. The honest real-inference reference is **~423 ms** (n=856), which independently matches the clean-room ~2.1–2.8/s and the BL-328 measurement of 2.25–2.60/s.

**Fix sketch (revised):**
1. ~~Make `ProcessType` a per-unit spec field~~ — **SHIPPED, see below.** (Note the sketch originally proposed defaulting to `Adaptive`; that would have been wrong — see the implementation note.)
2. Move telemetry durations to `process.hrtime.bigint()` (**BL-369**). *Still open.*
3. Bound/parallelize the shared fastembed child and report in-flight depth via `memory_ping` (**BL-322**). *Still open.*
4. Fix the fork IPC-channel leak (**BL-370**). *Still open.*

---

**✅ DEFECT 1 FIXED AND VERIFIED LIVE — 2026-07-31 (performance-engineer). Measured 18.9x, matching the prediction.**

`ProcessType` is now resolved by unit kind via a `processType` spec field that a manifest may declare as `lifecycle.process_type` (`resolveProcessType()`): periodic tick units → `Background`; everything else → **`Standard`**.[7]

**Implementation note — `Adaptive` would have re-introduced the defect silently.** The sketch above proposed it as the obvious middle ground. launchd.plist(5) is explicit that Adaptive promotes a job out of Background **based on activity over XPC connections**; sox services speak UDS and TCP and never open an XPC connection, so there is no promotion signal and an Adaptive unit would sit in the Background class. `Standard` is documented as "equivalent to no ProcessType being set" — the neutral class, and the correct default. Unknown manifest values coerce to undefined rather than reaching the plist.

**Deployed and verified BY PID, not by plist contents** (the BL-372 trap): the regenerated unit loaded, but the old backend survived as a `PPID 1` orphan still serving at pri 4 until it was explicitly `kill -TERM`ed. After the full sequence, proxy/backend/fastembed-host are pids **91239 / 91785 / 91786, all at pri 20** (was 4) — and the fastembed child inherits the class, which is where the inference actually runs.

**Live before/after**, both populations launchd-spawned against the same store and the same code, differing only in scheduling class. AFTER samples come from `memory_recall` **query** embeds (zero writes to the live store):[8]

| | n | min | p50 | p90 |
|---|---|---|---|---|
| BEFORE — pri 4, `Background` | 453 | 3785 ms | **6422 ms** | 12158 ms |
| AFTER — pri 20, `Standard` | 11 | 319 ms | **333 ms** | 343 ms |

**Length-matched** (so the ratio cannot be an artifact of query text being shorter than write content):

| text_len | BEFORE n | BEFORE p50 | AFTER n | AFTER p50 | ratio |
|---|---|---|---|---|---|
| 0–100 | 11 | 10528 ms | 8 | 331 ms | 31.8x |
| 300–600 | 328 | 6412 ms | 3 | 339 ms | **18.9x** |

The 300–600 band is the honest headline: **18.9x**, against a predicted ~18x. The AFTER distribution is very tight (319–383 ms across all 11 samples, no length sensitivity) and lands on the independently-established ~423 ms real-inference reference, so the small AFTER n is not load-bearing — but it **is** small, and the >30 s BEFORE tail was excluded as the BL-369 sleep artifact.

**What this does NOT fix:** defects 2 and 3 above are untouched. Head-of-line blocking (BL-322) still multiplies latency by in-flight depth — now from a ~0.33 s base instead of a ~6 s one, which is precisely why it is worth fixing next.

**Found while deploying this — filed as BL-375:** `soxe service enable` rebuilds the unit's `EnvironmentVariables` from the **invoking shell**, and silently dropped `SOX_DISABLE_EMBED_HEAL=1` and `SOX_DISABLE_PERIODIC_ENRICH=1` — **both live emergency brakes** — while reporting success. Caught only by diffing the regenerated plist against a snapshot.

**Acceptance (red→green, must name BL-331):** ~~a benchmark asserting production heal throughput…~~ **partially met.** The unit-level red→green exists (`os-unit.spec.ts`, verified 4 failed → 56 passed): a service manifest must not render `Background`, a tick unit must, an explicit `process_type` wins, an unknown value is never emitted. **Still owed:** the throughput benchmark itself, which must run **under the service's actual scheduling policy** — a benchmark at terminal priority would have passed throughout this entire incident and proved nothing. That, plus defects 2 and 3, is why this item stays open.

**Severity:** HIGH — downgraded in practice by the fix above, but the item remains open on defects 2 and 3 and the missing benchmark.

**Related:** BL-370, BL-369, BL-322 (head-of-line blocking), BL-339/BL-346 (the brakes this gates), BL-351, BL-353.

Citations: [wip/turso-live-metrics, performance-engineer, claude, turso-go-live, 1: libs/host-runtime/src/os-unit.ts:458-459 (pre-fix), 2: ~/Library/LaunchAgents/com.sox.user.memory-server.plist + live `ps -o pri` on pids 7687/7721/7724 (before) and 91239/91785/91786 (after), 3: ~/.adhd/sox-ecosystem/memory/log-analysis/bl331-qos-round.mjs, 4: ~/.adhd/sox-ecosystem/memory/log-analysis/bl331-inflight.py, 5: libs/data/embed/embedding-provider/src/sharedFastembedProcess.ts, 6: docs/reporting/memory/findings/bl331-root-cause.md, 7: libs/host-runtime/src/os-unit.ts (resolveProcessType) + libs/host-runtime/src/os-unit.spec.ts (BL-331 red->green), 8: ~/.adhd/sox-ecosystem/memory/log-analysis/bl331-after.py, 9: launchd.plist(5) ProcessType semantics]

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


**UPDATE 2026-07-31 (database-administrator) — the INTEGRITY half of this item has shipped** (commit `0d2d629`). The capability/contention/EP fields remain open.

`memory_ping.store.integrity` and the same block on `memory_stats` now report per-probe status, the damaged artifacts with their BL ids, the repairs performed, when the pass ran, its tier and duration, plus a one-line `store.integrity_headline`.

**Health is earned, never inferred.** `healthy: true` requires a pass that ran, completed, found no damage, AND whose every probe demonstrably exercised its artifact. No pass, an aborted pass, an unvalidated probe, or `SOX_STORE_VERIFY=off` each render `unknown` — and `unknown` is explicitly not healthy. `repaired` is a distinct verdict from `ok`: the store is correct *now* but did not open correct, which is what an operator needs to see when the same damage recurs every restart. There is deliberately no code path that infers health from a missing report or an empty findings array — that inference is exactly what let BL-347 run for a day.

**This item's own FTS proposal was unimplementable and has been replaced.** "index present + document count + last-built" cannot be built: the Tantivy backing-table count reads 0 in every state (BL-347 update), so `populated`/`doc count` do not exist as readable quantities. The shipped field derives from a rowid-targeted `fts_match` round-trip instead.

**Do not read the verdict from the in-process registry.** It is unreachable from `memory_ping` for two independent measured reasons (BL-368): `getDb` returns a Proxy, and memory-core reaches store-adapter via `require()` while an ESM consumer gets a second module instance with its own Maps. The verdict is persisted to `_adapter_meta.last_integrity` and read back from the store.

**Verified end-to-end through `handleToolCall` against a copy of the real damaged live store** (the live store itself untouched):
- `SOX_STORE_REPAIR=off` → `store integrity DAMAGED — 2 artifact(s)`, `healthy: false`, naming `[BL-347] idx_fts_node` ("2/3 sentinel rows … NOT matchable") and `[BL-336] _adapter_meta`.
- default → `store integrity REPAIRED at open`, `healthy: true`, `repair.ok: true`, `reverified: ok`, and `fts_match('memory')` 0 → 1148 against 1074 `LIKE` hits.

**Still open here:** capabilities, contention accounting, EP facts, and the BL-319 timing fields. Also note `memory_stats` **still throws on the live store** (BL-342), so its new integrity block is unreachable there until that lands.

Citations: [wip/turso-live-metrics, database-administrator, claude, sandbox P0.7, 4: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts (memory_ping store block, memory_stats), 5: libs/data/store/store-adapter/src/integrity-status.ts, 6: libs/data/store/store-adapter/src/__tests__/integrity-status.test.ts, 7: handleToolCall('memory_ping') against a copy of `~/.memory/memory.db` 2026-07-31]

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

**Acceptance (red→green, must name BL-335) — AMENDED 2026-07-31 per BL-360:** bulk-insert N rows through the same path the restore used, then assert `integrity_check` is clean **after filtering Turso's unconditional `wrong # of entries in index __turso_internal_fts_dir_*_key` message**, iterating past the 100-message cap. A literally-clean `integrity_check` is **not a reachable state** on a Turso store carrying a Tantivy index — BL-360 measured that message emitted against a freshly built, fully working index (200/200 `fts_match` hits alongside it). The original wording asked for something no correct implementation can satisfy.

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


**UPDATE 2026-07-31 (database-administrator) — both defects addressed; the recommended dedupe does not work as written.**

**`DELETE` cannot remove the duplicates.** Measured on a copy of the live store: `DELETE FROM _adapter_meta WHERE rowid NOT IN (SELECT MIN(rowid) …)` fails with `Corrupt database: IdxDelete: no matching index entry found for key [Text("adapter_type"), Integer(4)] while seeking` — the rows have no index entry to remove, so the delete cannot complete. `REINDEX _adapter_meta` fails first with `UNIQUE constraint failed`. **The only repair that works is a table rebuild**: read the rows ordered by rowid, keep the first per key, create a replacement table, drop and rename. Measured 7.4 ms, after which `_adapter_meta` is clean under `integrity_check`.

**The obvious detection query is ALSO blind.** `SELECT key, COUNT(*) FROM _adapter_meta GROUP BY key HAVING COUNT(*) > 1` is planned as `SCAN _adapter_meta USING COVERING INDEX sqlite_autoindex__adapter_meta_1` — through the very index whose inconsistency let the duplicates in — and returns **one row per key on a table visibly holding six rows under three keys**. Detection must read `SELECT key FROM _adapter_meta ORDER BY rowid` (table btree) and count in JS.

**Shipped** (commit `fa786a2`): `stampAdapterMeta` is now `INSERT … ON CONFLICT(key) DO UPDATE` (`created_at` uses `DO NOTHING`, so the first stamp survives); `probeAdapterMetaUnique` + the rebuild repair run on every adapter open. Two red→green tests naming BL-336.

**Defect 2 (constraint enforcement was bypassed) remains OPEN and un-investigated** — that a UNIQUE/PK constraint can silently not apply while its index is inconsistent exposes every other table, and nothing here proves otherwise.

Citations: [wip/turso-live-metrics, database-administrator, claude, sandbox P0.7, 3: DELETE/REINDEX/rebuild probes against a copy of `~/.memory/memory.db` 2026-07-31, 4: libs/data/store/store-adapter/src/adapter-meta.ts, 5: libs/data/store/store-adapter/src/integrity.ts (probeAdapterMetaUnique, repairAdapterMeta)]

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


**UPDATE 2026-07-31 (database-administrator) — the repair helper this item asks for now ships.** `repairStoreIntegrity()` enumerates btree indexes from `sqlite_master`, skips every custom-method index (`USING …`) and `__turso_internal_*`/`sqlite_*` object, and issues `REINDEX "<index-name>"` individually; the FTS index is rebuilt separately via `DROP INDEX` + the dialect's own `createIndexDDL` — the step whose omission caused BL-347. `REINDEX <table>` is never issued.

**The stated acceptance ("returns a table with a Tantivy index to a clean `integrity_check`") is UNACHIEVABLE as written** and must be amended — see the new item on Turso's unconditional `integrity_check` false positive for `__turso_internal_fts_dir_*_key`. A clean `integrity_check` on such a table is not a reachable state; the assertion has to be "clean after filtering that message."

Citations: [wip/turso-live-metrics, database-administrator, claude, sandbox P0.7, 4: libs/data/store/store-adapter/src/integrity.ts (repairStoreIntegrity, probeBtreeIndexes), 5: integrity_check on a freshly built healthy Turso FTS store 2026-07-31]

---

### BL-347 — Keyword search is silently dead on the live store: `idx_fts_node` exists with an EMPTY Tantivy directory — **Open (HIGH)** (2026-07-31)

**Driver:** on the live store, `fts_match` returns **zero rows for every term**, with no error, while the same terms match plainly via `LIKE`:

| term | `fts_match("content","name","summary", ?)` | `content LIKE '%term%'` |
|---|---|---|
| `turso` | **0** | 137 |
| `memory` | **0** | 1074 |
| `server` | **0** | 628 |
| `backlog` | **0** | 83 |

against `node` = 9420 rows.[1] The index is present and well-formed in `sqlite_master`:
`CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content","name","summary") WITH (weights = ...)`.[1] Its backing directory `__turso_internal_fts_dir_idx_fts_node` holds **0 rows / 0 bytes**.[1] The index is a shell.

**This is not a Turso design limitation — clean-room A/B disproves that.**[2] On a fresh db, `CREATE INDEX ... USING fts` over an already-populated table **does** backfill (50/50 rows matched), and rows inserted *after* the index exists **are** indexed incrementally (60/60). Both directions work. The live store's index is therefore broken *state*, not broken *behavior* — which is why no error is ever raised.

**Root cause — this is the delayed detonation of BL-337.** `REINDEX node` is impossible on a table carrying a Tantivy index, so during the 2026-07-30 crash repair every btree index was rebuilt individually **explicitly skipping `idx_fts_node`**. It was the one index the manual repair could not touch, and nothing rebuilt it afterward. BL-337 recorded the blocked repair path; this item records the damage that path left behind.

**Fix is verified and cheap.** On an offline copy of the live store: `DROP INDEX idx_fts_node` + recreate via the dialect DDL completes in **0.26 s** and restores matching — `memory` 0 → **1148**, `turso` 0 → **136** (slightly above the `LIKE` counts, as expected: FTS also searches `name`/`summary` and tokenizes).[3]

**Second defect found while probing, do not lose it:** after a *successful* rebuild that demonstrably returns matches, `SELECT COUNT(*) FROM __turso_internal_fts_dir_idx_fts_node` **still reports 0**.[3] The backing-table row count is therefore **not a valid health signal** — it reads 0 both when FTS is dead and when FTS is working. Any status surface that checks FTS health by counting backing rows will report a false alarm forever. **The only sound probe is an actual `fts_match` against a known-present token.** This directly constrains BL-334's proposed "FTS index present + populated + doc count" status field — `populated` and `doc count` as specified are not obtainable this way.

**Blast radius:** every keyword/BM25 recall path degrades to whatever fallback exists, silently. Combined with vector coverage frozen at ~36% (BL-339/346), the live store has been serving recall with **both** retrieval strategies impaired and reporting healthy throughout.

**⛔ OWNER DIRECTIVE (2026-07-31) — DO NOT MANUALLY REBUILD THIS INDEX.** A manual `DROP`+`CREATE` was proposed, verified, and **rejected**, verbatim: *"This is very much the exact reason that the store adapter migration strategy was designed and built, so if the tables are not 100% accurate and resolved when that auto migrator runs that is a product defect that should not be manually corrected. This is also on generated data so it seems somewhat wild that isn't already handled. So no, I don't approve manually dropping the index because the adapters should be verifying their store and migrating any missing data + generating missing indexes etc."*

The live store therefore **stays broken until the adapter fixes it itself.** Hand-repairing it would destroy the only reproduction we have of the real defect and leave the store one crash away from an identical, equally silent outage.

**The real defect — why the migrator cannot currently catch this.** `applySchema()` issues `CREATE INDEX IF NOT EXISTS idx_fts_node ...`. The index **does** exist — it is its Tantivy directory that is empty. `IF NOT EXISTS` therefore **no-ops**, the version gate is already satisfied, and the adapter concludes the store is fully migrated while a generated artifact it owns is empty.[5] This is BL-302's missing migration executor (`targetVersion` hard-coded to `1`, no `migrations[]`, DDL-only reconciliation) meeting BL-335's "nothing detects or repairs it." **Existence is not integrity.** No `IF NOT EXISTS` DDL can ever detect a present-but-empty derived structure.

**Fix (reframed per the directive) — the adapter must verify and self-heal what it generates:**
1. **Verification on open** — the adapter validates its own generated artifacts, not merely their presence: FTS index *matches*, secondary indexes *populated* (BL-335), vectors *consistent*. Existence checks are insufficient by construction.
2. **Repair as migration** — a detected-empty derived artifact is rebuilt through the migration path (BL-302's executor), transactionally, logged, and reported — never by hand, never by an operator.
3. **Report it** — the outcome surfaces in status (BL-334) so a degraded store cannot present as healthy, which it did here for at least a day.
4. Probe FTS via `fts_match` on a sentinel token — **never** a backing-row count (see the second defect above).

**Acceptance (red→green, must name BL-347):** build a Turso store with rows + `idx_fts_node`, empty the backing directory, **re-open it through the normal adapter path** and assert the adapter **detects and repairs** it unprompted — `fts_match` returns 0 before open (**red**) and >0 after (**green**), with no manual DDL anywhere in the test. Re-running `applySchema()` alone must be shown **not** to fix it, proving the `IF NOT EXISTS` no-op is the mechanism. A further assertion must prove the health probe *fails* in the damaged state — a probe that passes there is the BL-167 failure mode repeating.

**Severity:** HIGH — silent, total loss of keyword retrieval on the live store, undetected for at least a day, on the system every agent depends on for recall.

**Related:** **BL-302 (the missing migration executor — this is the mechanism)**, BL-337 (the blocked repair that caused this), BL-335 (the crash index damage), BL-334 (status surface must report this — and its proposed FTS field is unobtainable as specified), BL-329 (the same index blocks better-sqlite3), BL-338 (crash recovery must be automatic), BL-352 (adapter self-verification, the item this fix now lands in).

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: live `~/.memory/memory.db` fts_match/LIKE/sqlite_master probe 2026-07-31, 2: clean-room A/B backfill-vs-incremental probe 2026-07-31, 3: offline-copy DROP+CREATE rebuild probe 2026-07-31, 4: libs/data/store/store-adapter/src/fts-dialect.ts:187-257, 5: BL-302 (`applySchema` DDL-only reconciliation, `CREATE INDEX IF NOT EXISTS` no-op on a present-but-empty index), 6: owner directive 2026-07-31 rejecting manual repair]


**UPDATE 2026-07-31 (database-administrator, BL-352 implementation) — the "EMPTY Tantivy directory" framing in this item's title and driver is FACTUALLY WRONG and must not be relied on.** `SELECT COUNT(*) FROM __turso_internal_fts_dir_idx_fts_node` reads **0 rows / 0 bytes in every state measured**: on the damaged live store, on a *repaired* copy of it whose `fts_match` returns 1148 hits, and on a freshly built 200-row store whose `fts_match` returns 200/200.[7] It reads 0 through better-sqlite3 as well as through Turso.[7] The Tantivy content does not live in that table in `@tursodatabase/database@0.7.1`. The index is damaged — the *description* of how is not established, and "the directory is empty" should be struck.

**A "does FTS match anything at all" probe is ALSO unsound on this damage.** Measured on the live copy: `fts_match('the')` returns **3** while `fts_match('memory')` returns 0 against 1074 `LIKE` hits.[7] The rows written after the index was orphaned ARE indexed, so an any-match probe reports healthy on a store where keyword search is dead for 99.9% of the corpus. The only sound probe is a **rowid-targeted sentinel round-trip**: take a token from a specific row's own indexed text and assert THAT row comes back. Sampling the rowid extremes matters — rowid 1 was unmatchable while rowid 9424 matched.[7]

**Detection and repair now ship in the adapter** (`libs/data/store/store-adapter/src/integrity.ts`, commit `fa786a2`), with a red→green test naming BL-347. Verified against a copy of the real damaged live store: opening through `createTursoAdapter()` detected `2/3 sentinel rows … NOT matchable` and repaired it unprompted in 256 ms — `memory` 0 → 1148, `turso` 0 → 136, `backlog` 0 → 84, and rowid 1 matchable again.[8]

**This item stays OPEN because the live store is still damaged.** The fix is in `store-adapter`'s source and `dist`, but the running memory-server is a *bundled* artifact that has not been rebuilt (the live service is up and a rebuild is destructive per BL-235). The live store is auto-repaired on the first open after memory-server is rebuilt and restarted — not before.

Citations: [wip/turso-live-metrics, database-administrator, claude, sandbox P0.7, 7: backing-directory row-count probes across damaged/repaired/fresh stores 2026-07-31 (Turso and better-sqlite3), 8: `createTursoAdapter()` open against a copy of `~/.memory/memory.db` 2026-07-31, 9: libs/data/store/store-adapter/src/integrity.ts, 10: libs/data/store/store-adapter/src/__tests__/integrity-selfheal.test.ts]

---

### BL-348 — Enrichment/clustering can block and lose an embedding: the write pipeline has no stage isolation — **Open (CRITICAL)** (2026-07-31)

**Owner directive, verbatim (2026-07-31):** *"Embedding and other enrichment should really never block each other — they are independent features enabled by different components. Generating an embedding and writing it should be an isolatable operation from topic enrichment and edge drawing. … the execution of clustering should never block an embedding from being written. Failing clustering should never drop an embedding. Embedding vector loss is a critical failure."*

**Driver:** embedding, topic enrichment, edge drawing, and clustering currently share one enrich/write path with no isolation boundary between them. Three distinct failure modes follow, and we have observed all three:

1. **Blocking** — a clustering pass monopolizes the loop and starves everything behind it. BL-345 established that **any** in-process background job starves foreground reads, not merely embed heal; BL-346's live hang (`enrich.tick.start` with no `.finish`) is this shape.
2. **Loss** — a failure in a *downstream* stage can abort the unit of work that carried a *successfully computed* embedding. An embedding costs real ANE/CPU time and is the single most expensive artifact in the pipeline; discarding one because an unrelated stage threw is unacceptable.
3. **Attribution** — with the stages fused, a slow or failing pipeline cannot be attributed to a component, which is exactly why BL-331's 18x slowdown remains unexplained.

**Requirement.** Embedding generation and vector persistence form a **committed stage**. Once a vector is computed it is durably written before any enrichment stage runs, and no subsequent stage failure can roll it back, skip it, or delay it. Enrichment, topic assignment, edge drawing and clustering each become independently schedulable, independently failable, independently retryable stages downstream of that commit.

**Explicitly: vector loss is a CRITICAL-severity failure class, not an error to be logged and moved past.**

**Fix sketch:** split the write path into committed stages with an explicit boundary after vector persist. Downstream stages consume from a durable queue (`organizer_queue` already exists) rather than executing inline within the write. Each stage carries its own failure isolation, retry policy, and metrics (BL-351). Pairs with BL-349 (clustering as a backgrounded trigger) and BL-345 (foreground/background lanes).

**Acceptance (red→green, must name BL-348):** a test that writes an episode with a clustering/enrichment stage forced to throw, and asserts the embedding is **still durably present in `vec_node`** after the failure. Must fail today. A second test asserts a deliberately slow enrichment stage does **not** increase `write_to_vector_ms` for concurrent writes — proving the blocking boundary is real and not merely nominal.

**Severity:** CRITICAL — the failure mode is silent loss of the most expensive artifact in the system, on a store where vector coverage is already frozen at ~36%.

**Related:** BL-345 (background jobs starve foreground), BL-346/BL-339 (both live mitigations exist because of this), BL-326/BL-349 (clustering trigger), BL-331 (unattributable slowness), BL-351 (per-stage metrics), BL-330 (durability of the committed write).

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: owner directive 2026-07-31, 2: BL-345, 3: BL-346 (live enrich.tick hang), 4: libs/memory-core/src/enrich-batch.ts, 5: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts (runEnrichPassOnDb / runPeriodicEnrichPassGuarded)]

---

### BL-349 — Clustering must run as a backgrounded post-write trigger, never inline — **Open (HIGH)** (2026-07-31)

**Owner decision on BL-326 (2026-07-31), verbatim:** *"shouldn't this be a backgrounded insert trigger? … For now I'm okay with doing the write triggered cluster association but the execution of clustering should never block an embedding from being written."*

**Resolves the BL-326 design gap** — clustering is currently unreachable from any ordinary write (the incremental path is a dead stub; full passes run only off an explicit `organizer_queue` row). The chosen strategy is **write-triggered cluster association executed in the background**, not a periodic full pass and not an inline call.

**Constraints, all load-bearing:**
- The trigger is **enqueued** by the write; the write does not await it (BL-348's committed-stage boundary).
- Clustering failure or slowness has **zero effect** on embedding persistence.
- The trigger is idempotent and coalescing — N rapid writes must not queue N full passes.
- It carries its own traceability and metrics as a distinct stage (BL-351).

**Not settled by this decision:** how cluster *membership* is maintained as the corpus grows. See BL-350 — the owner explicitly flagged that clusters are not constant-time splits and do not self-reorganize, and that the long-term strategy needs research. This item is the near-term mechanism; BL-350 is the algorithm.

**Acceptance (red→green, must name BL-349):** write N clusterable episodes through the ordinary path only (no explicit recluster row, no manual pass) and assert `total_clustered > 0` — the BL-326 acceptance. Additionally assert the write's `write_to_vector_ms` is unaffected by clustering work, and that a thrown clustering error leaves the vectors intact.

**Severity:** HIGH — clustering is inert in production; paired with BL-327 it fully explains the live `cluster_count: 139 / total_clustered: 0 / coverage: 0`.

**Related:** BL-326 (the gap this decides), BL-348 (the isolation it depends on), BL-350 (the unresolved algorithm), BL-328 (threshold calibration), BL-327 (orphaned communities).

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: owner decision 2026-07-31, 2: BL-326, 3: libs/memory-core/src/cluster.ts:437-441]

---

### BL-350 — RESEARCH: cluster maintenance is not a constant-time split and does not self-reorganize — **Open (MEDIUM, research)** (2026-07-31)

**Owner framing, verbatim (2026-07-31):** *"your idea is great to produce constant time insert clustering agreed, but it silently ignores that the clusters are not constant time splits and self reorganizing - I'm thinking that strategy could be researched."*

**The problem this names.** Any incremental/write-triggered association (BL-349) answers *"which existing cluster does this new episode join?"* It does **not** answer what happens when the corpus shifts underneath the clusters:
- A cluster grows until it should **split** into two coherent sub-topics — an O(1) insert never triggers that.
- Two clusters drift **together** and should **merge**.
- Deleting or invalidating episodes leaves clusters **stale or orphaned** (BL-327 is the observed instance).
- Incremental association **drifts** from what a full pass over the same corpus would produce, and nothing measures the divergence.

The consequence of ignoring it is not an error — it is a slowly degrading cluster quality that never surfaces as a failure. That is the same silent-degradation class as BL-347.

**Research scope:** survey incremental/streaming clustering with maintenance (split/merge criteria, drift detection, periodic-reconciliation hybrids); define a measurable **drift metric** between incremental state and a full-pass ground truth; recommend a maintenance cadence or trigger. Per the DRY directive, query memory for prior internal work and prior tool research before any live search; log the evaluation with topic + language tags and the final decision.

**Acceptance:** a written recommendation with a measurable drift metric and a maintenance trigger, plus a harness that can compute incremental-vs-full-pass divergence on a real corpus. No code change is in scope for this item.

**Severity:** MEDIUM — not blocking go-live, but BL-349 ships a strategy with a known unaddressed tail, and this is that tail. Filing it is what keeps it from becoming folklore.

**⚡ BL-356 is the measured proof this item is real, not speculative (2026-07-31).** `minPts=2` makes the algorithm **single-linkage**, so a fixed τ fixes edge *probability* and mean degree grows linearly with N. On identical content, largest-cluster ratio at τ=0.82: N=200 → 0.085, 400 → 0.222, 800 → 0.459, 1200 → 0.595, 1616 → **0.684**. Projected mean degree at the full store (4841) is 32.6 @ τ=0.82 and still 5.9 @ τ=0.95. **A fixed global threshold is therefore not calibratable at all** — the correct τ is a function of corpus size, which is precisely the "clusters are not constant-time splits and do not self-reorganize" tail this item was filed to research. Any maintenance strategy that assumes a stable τ is already disproven.

**Related:** BL-356 (the measured scaling proof — read it first), BL-349 (the near-term mechanism), BL-328 (threshold calibration), BL-327 (orphaned communities), BL-326.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: owner framing 2026-07-31, 2: BL-349, 3: BL-327]

---

### BL-351 — No per-package tracing/metrics architecture: every component reimplements or omits observability — **Open (HIGH)** (2026-07-31)

**Owner directive, verbatim (2026-07-31):** *"All of these operations need independent tracability & metrics at their sox package level."* and *"We should architect the tracing package so that we are reusing and implementing the metrics + logging + function level tracing correctly."*

**Driver.** Observability is currently ad hoc and per-consumer, and the gaps are load-bearing:
- BL-320's telemetry lives in `memory-core/src/telemetry.ts` — useful, but **memory-core's**, not a shared capability. `embedding-provider`, `store-adapter`, `graph-store`, `host-runtime` have no equivalent.
- Its four env controls (`SOX_MEMORY_LOG_LEVEL` / `_DISABLE` / `_DIR` / `_MAX_BYTES`) are **silently scrubbed** by six duplicated allowlists (BL-344), so the tracing that exists cannot be turned on where it matters.
- `time_to_vector_ms` exists and has **0 samples** because the heal path bypasses write-path instrumentation (BL-319) — an instrument wired to one code path is indistinguishable from no instrument.
- BL-334 documents nine questions during go-live that required host archaeology, several of which produced **wrong** answers that had to be walked back.
- Stage-level attribution is impossible today, which is why BL-331's 18x slowdown is still unexplained.

**Requirement.** A shared tracing/metrics package every sox data package depends on, providing: structured logging, function/stage-level spans with a propagated trace-id (extending BL-320's AsyncLocalStorage), counters/gauges/histograms, and a **uniform export into the status surface** (BL-334) rather than into a log a human must grep. Each package instruments **its own** operations and owns those metrics — embedding, vector persist, enrichment, clustering, edge drawing each independently traceable end to end (BL-348).

Critically, the **wait-vs-work split** (`write_queue_wait`, `embed_enqueue_wait`) must be a first-class primitive, not a per-consumer convention — it is the measurement Theme 2's resource governance is blocked on, and the one thing no current instrument reports.

**⛔ OWNER DIRECTIVE (2026-07-31) — ADOPT, DO NOT AUTHOR.** Verbatim: *"I do not want to rewrite distributed tracing / metric aggregation from scratch for obvious reasons so we should find tools that handle 99% of the lift but put our wrapper and semantics around them so we're eliminating the risk of incorrectly integrating those tools."*

The deliverable is therefore **a researched tool selection plus a thin wrapper/semantic layer**, never a bespoke tracing implementation. The wrapper's purpose is to make correct usage the default and mis-integration structurally hard — every layer it adds must be justified by a specific failure it prevents, not by abstraction for its own sake.

**Priority:** this item **blocks most of the sandbox project's reporting** (`docs/reporting/memory/sandbox/`), placing it on the critical path. Research dispatched 2026-07-31.

**⛔ OWNER REQUIREMENT (2026-07-31) — EVENTS MUST BE WRITTEN TO DISK.** Logging, tracing and metric events are **persisted to disk**, not held in memory, not exposed only through a live scrape endpoint, and not dependent on a collector process being up. Disk is the system of record; the status surface (BL-334) is a *view* over it. Rationale: every forensic question during the 2026-07-30 go-live was answered — or lost — based on what had been durably written. An in-memory ring buffer or a scrape-only exporter loses exactly the window that matters, because the process that crashed is the one holding the evidence.

**Existing precedent to build on, not replace.** BL-320 already writes JSONL to `~/.adhd/sox-ecosystem/memory/logs/` (`libs/memory-core/src/telemetry.ts:12,78`), and it is live right now — `memory-core-2026-07-30.jsonl` is **17.2 MB** (incident day) and `memory-core-2026-07-31.jsonl` reached **2.1 MB by 14:24**.[6] Two consequences for the design:
- **Volume is a real constraint, and rotation/retention is load-bearing, not a nicety.** ~17 MB/day from a *single* package; BL-351 extends instrumentation to six or more. `SOX_MEMORY_LOG_MAX_BYTES` exists for this — and is one of the four controls silently scrubbed by the allowlists (BL-344), so today the cap cannot be set where it matters.
- The chosen tool must support a **file/disk exporter as a first-class path**, not as an afterthought or a debug mode. A candidate that only exports over OTLP to a running collector fails this requirement unless it also ships a durable local sink.

**Hard constraint that disqualifies candidates outright:** MCP stdio servers use **stdout as the JSON-RPC protocol channel**. Any library that writes to stdout — even once, even at init — corrupts the protocol and breaks the server. Telemetry must go to stderr, a file, or a socket, and this must be *verified* per candidate rather than assumed.

**Per the DRY directive:** before authoring, query memory for prior internal tracing work and prior tool research; if absent, run a live search for current Node tracing/metrics options and log the evaluation with tags + the final decision. Do not hand-roll what a standard covers, and do not adopt a heavyweight dependency into bundled extensions without checking the externals policy (BL-307/BL-309) — bundled extensions are self-contained CJS built by esbuild, so native addons need an explicit externals story or the candidate is out.

**⚠ Two implementation constraints found by inspection (2026-07-31) — neither is observable today, both bite whoever implements this.** Recorded here rather than as separate items because they are defects *of this item's own design*, and this is where the implementer looks.

1. **"Metrics are recomputable by replaying the JSONL" is bounded by RETENTION, not durability.** `_pruneOldFiles` unlinks the oldest files beyond `MAX_FILES` (default 7) on every size-triggered rotation (`telemetry.ts:236-261`). Recent histograms replay perfectly, but **lifetime cumulative counters cannot be reconstructed once the window holding their early history is pruned.** So the periodic snapshot line is **not purely a cache** past the retention horizon — beyond it, the snapshot is the *only* durable record of cumulative state, and therefore needs its **own** retention (separate component file, or last-N snapshots preserved). Otherwise checkpoints get pruned alongside the events they were meant to outlive and the replay property quietly becomes false at exactly the ages where it mattered. Corollary: any status field derived from a cumulative counter **must be labelled with its window** ("since process start" vs "since oldest retained record"), or it becomes another plausible unfalsifiable number — the BL-334 pattern again.

2. **Role routing as specified would introduce a pruner prefix collision.** `_pruneOldFiles` selects on `f.startsWith(`${component}-`)`. Role routing varies the component (`memory-core-live`, `memory-core-test`), which is clean **only if every writer is migrated** — a process still using the legacy component `memory-core` prunes on `memory-core-`, which **also matches `memory-core-live-2026-07-31.jsonl`**. One un-migrated writer could therefore **delete the live-service forensic logs it knows nothing about**, while the BL-365 fix is busy making those same records crash-durable. Mitigation is trivial but must be explicit: use a separator that cannot collide (`memory-core.live`), or anchor the filter on the full `<component>-<ISO-date>` shape rather than a bare prefix.

**Acceptance (must name BL-351):** two different packages emit spans that join on one trace-id through the shared API; the wait-vs-work split is reported for a real write; every emitted metric is reachable from the status surface without reading a log file; and the env controls survive the allowlists (BL-344) — verified on a real spawned service, not in-process.

**Severity:** HIGH — this is the enabling gap beneath BL-319, BL-322, BL-331, BL-334 and BL-345. Each is individually blocked on measurement that does not exist.

**Related:** BL-320 (the memory-core-only precedent to generalize), BL-319, BL-322, BL-331, BL-334, BL-344 (controls scrubbed), BL-345, BL-348 (per-stage attribution), BL-353 (role field + start/finish accounting, folded into the design), BL-358 (the concrete missing wait measurement), and `docs/reporting/memory/sandbox/PLAN.md` §P1.

---

#### RESEARCH COMPLETE (2026-07-31) — recommendation in [`docs/research/observability-substrate.md`](./docs/research/observability-substrate.md)

**Memory-first, per the DRY directive:** `memory_recall` found **no prior internal tracing work and no prior tool research** — top hits scored 0.0056 and were off-topic. Vector recall functioned; keyword/FTS returned zero-to-one rows, consistent with BL-347. A live search was therefore required and performed; the evaluation is logged to memory.[6]

**Recommendation:** adopt the **OpenTelemetry API facade** (`@opentelemetry/api` 1.9.1, Apache-2.0, **zero runtime dependencies**) in every library; confine the **SDK** (`sdk-trace-base` + `sdk-metrics` + `context-async-hooks`, all 2.10.0) to the composition root; export through a **pull-only `MetricReader` driven by `memory_ping`**. **No collector, no daemon, no background timer.** Wrapped in `@adhd/sox-telemetry`, the only module permitted to import `@opentelemetry/*` (lint-enforced).

**Hard constraints verified by local prototype, not by marketing claim:**[7]
- **stdout:** bundled the full recommended set to CJS and executed it with stdout redirected — **0 occurrences of `process.stdout`, 0 bytes written at runtime.** The entire stdout hazard surface reduces to three opt-in exports (`DiagConsoleLogger`, `ConsoleMetricExporter`, `ConsoleSpanExporter`), which a lint rule bans outright. `pino` **fails** this by default (writes to fd 1).
- **Bundling:** **0 `.node` references, 0 externals required.** 573,358 bytes unminified CJS (+23.7% on the 2,418,414-byte `memory-server/dist/index.js`); the API facade alone is 52,962 bytes (+2.2%).
- **BL-345 (no background work):** the pull-only reader reports **`process.getActiveResourcesInfo()` → `[]`** — zero timers, zero handles. `collect()` costs **0.635 ms** for 3 instruments × 10,000 samples, run synchronously inside the `memory_ping` that asked for it. The *default* OTel configuration (`PeriodicExportingMetricReader`) would have failed this — which is why `@opentelemetry/sdk-node` is rejected.
- **Overhead, measured at 500k iterations:** span with **no SDK registered 96 ns**; SDK sampled-on **859 ns**; `histogram.record` **42 ns** (attribute-count-independent). Against a live `embed_duration_ms.mean` of **7,910 ms**, a span is **1.1 × 10⁻⁵ %**. Note: a *sampled-off* span still costs **508 ns** — turning the sampler down is not how you turn the cost off; only "no SDK registered" is genuinely cheap, which the facade-only library architecture gives us for free in tests and the CLI.

**Acceptance criterion #1 already demonstrated in prototype:** two tracers with different scope names, separated by an `await`, with no parent passed across the call, joined on **one trace-id**. The same prototype demonstrates the failure mode the wrapper exists to prevent — **without `AsyncLocalStorageContextManager` registered, traces silently shatter into separate roots**: no error, no warning, spans still emitted. That single forgettable line is the strongest argument for the wrapper, and `initTelemetry()` makes it unreachable to get wrong.

**How the design defeats the BL-319 class of mistake structurally:** stages are a **closed union declared once per package**, naming *both* code paths up front (`embed: { paths: ['write','heal'] }`), so an undeclared stage is a **compile error** and a second differently-named metric for the sibling path cannot be invented at a call site. `telemetrySelfCheck()` — exposed through `memory_stats` — reports **which declared paths have produced zero samples**, turning BL-319's invisible defect (`0` is indistinguishable from idle) into a named machine-readable finding. Plus `instrumentBoundary`, generalising the existing `instrumentAdapter` Proxy so methods written later are instrumented by construction.

**wait-vs-work:** made first-class by exposing **no API that can record work without wait** — `withContendedStage(stage, admit, work)` emits `sox.stage.wait_ms` and `sox.stage.work_ms` as a pair or not at all.

**Rejected:** `@opentelemetry/sdk-node` (~30 deps incl. gRPC; default periodic reader is the BL-345 failure mode), `auto-instrumentations-node` (`require-in-the-middle` monkey-patching is incompatible with a self-contained esbuild bundle; auto-instrumenting `fs` on a SQLite hot path is an unbounded bet), `dd-trace` 6.8.0 (same bundling objection via `import-in-the-middle`; vendor sink; data never reaches `memory_ping`), `pino` (stdout default; `thread-stream` workers; we would have to reimplement `withTimedEvent`'s log-START-before-await contract on top of it anyway), `prom-client` (HTTP scrape model we have no consumer for; does not declare Node 24), and **a collector/backend daemon** — argued explicitly rather than defaulted away from: it answers the wrong question at the wrong time for a 3am `memory_ping` operator, reintroduces the background batch timer, and adds a second source of truth that can disagree with the status surface, which is precisely BL-334's walked-back-wrong-answers pattern. The design keeps OTLP-shaped data so an **opt-in, off-by-default** `SOX_TRACE_OTLP_ENDPOINT` remains available for a deliberate debugging session.

**RE-SCORED against the disk-durability requirement (rev 2).** The requirement **does not change the pick**, but it changes the weighting decisively and produced three findings:

1. **OpenTelemetry JS ships NO durable local sink.** Enumerated every exporter it publishes: OTLP over http/grpc/proto, Zipkin, Prometheus — all network to a running collector — plus `ConsoleSpanExporter`/`ConsoleMetricExporter`. There is no file exporter (`npm view otlp-file-exporter` → 404). And I measured `ConsoleSpanExporter` writing **778 bytes to stdout** — the exact MCP-fatal behaviour. **The only local sink OpenTelemetry ships is the one we can never use.** This converts "keep the BL-320 JSONL sink" from a preference into the only available answer. Re-scored: `dd-trace` **FAILS** (Agent sink), `prom-client` **FAILS** (scrape-only — a crashed process takes its counters with it, precisely the "the process that crashed is the one holding the evidence" failure), a collector/backend **FAILS**.

2. **An OTel span never reaches disk if the operation hangs.** Measured: 2 spans started, **1 exported** — spans emit on `end()`, so the hung one never exported. Adopting plain OTel would have destroyed `docs/observability/README.md` §2's "single most important property". **Resolved inside the standard's own extension point:** `SpanProcessor.onStart` fires before the span body runs (confirmed firing for the hung span), so the `.start` record is written there and `.finish` on `onEnd`. `starts − (finishes + errors)` keeps working — now computed into `memory_ping` automatically instead of waiting two days for someone to write a script.

3. **The ~17 MB/day is 97.3% test processes, not the live service.** Read-only analysis of the real logs: **82,541 events, 814 distinct pids, 16 live** — live pids account for **2,729 events (3.3%) and 0.57 MB of 21.43 MB (2.7%)**, ~0.3 MB/day. Projected to six packages with stage spans at the measured 310 bytes/span: **~2.1 MB/day live, ~15 MB at 7-day retention.** The durability requirement is essentially free for the population that matters, and the existing defaults (20 MB × 7 files) already bound it with three orders of magnitude of headroom. **Retention routes by `role`, not by volume** — live/test/cli land in *different files*, which solves the volume concern and BL-353's population-mixing with one mechanism.

**KEEP / WRAP / REPLACE verdict on the existing JSONL sink: WRAP.** On the merits, not sentiment. OTel gives us none of: a durable local sink, START-before-await, never-throws/never-blocks (its `BatchSpanProcessor` buffers on a timer — BL-345's failure mode *and* loses the buffered window on crash), env-read-per-call, or SQL-on-error with `this` preserved. It gives us the one thing `telemetry.ts` never attempted: **metrics aggregation, percentiles, throughput.** That is the half worth adopting for. Note from `docs/observability/README.md` §5.3 that wait-vs-work is *already reconstructible from events on disk* (join `writequeue.enqueue`→`writequeue.task.start` on `trace_id`+`label`) and nobody ever computed it — **the gap is aggregation and reach, not collection.** The prototyped `JsonlSpanExporter` emits the same five always-present fields, so the existing event catalog and the `log-analysis/` scripts keep working.

**Designing against BL-353 ("on disk and correct" is proven insufficient):** derived metrics are computed in-process and appear in `memory_ping` unconditionally — no script, no file path, no knowledge that the log exists (0.635 ms on the call that asked). Secondary: the self-check reports its own gaps (unsampled paths, unaccounted start/finish deltas, **dropped-record counts** — the sink drops silently on disk-full today, which must be counted or a degraded sink is indistinguishable from an idle one). Tertiary: move the analysis scripts from `~/.adhd/.../log-analysis/` into the repo behind an nx target. **(1) is the fix; (3) alone is what we already had.**

**On the `embed.* trace_id: null` gap (README §3.1) — honest assessment: adopting OTel does not fix it by itself.** 535 live `embed.start` records on the incident day carry no trace id. `AsyncLocalStorage` and OTel's `AsyncLocalStorageContextManager` are the same primitive; the context is lost because the embed crosses a dispatch boundary no in-process mechanism survives. What OTel adds is the standard, tested explicit carrier (`propagation.inject`/`extract`) instead of the hand-threaded `PendingEmbed.traceId`. It is better only because the wrapper forces the hand-off — the library alone reproduces the same `null`.

**REV 3 — span + metric durability (the disk requirement was only half-met).** Rev 2 persisted logs but left spans specified inconsistently and metrics pull-only, i.e. never written. Closed, and it surfaced a live defect:

- **The existing sink is not crash-durable — filed as BL-365.** `RotatingJsonlWriter` uses fire-and-forget `createWriteStream`. **Measured: 10,000 records written, SIGKILL, 0 survived.** Realistic exposure is the current synchronous burst plus ~1–5 ms (measured: kill at +0/+1 ms → 1,024 of 5,000 survived; +5 ms → all 5,000). A *hang* loses nothing; a `SIGKILL`/panic/power-cut loses exactly the pre-crash window the log exists for — and the host lost power mid-backfill on 2026-07-30 (BL-338). Fix: `fs.writeSync` for the `live-service` role, measured at **+2.2 µs/record (3,254 vs 1,043 ns) ≈ 15 ms CPU/day** at the projected rate; keep the buffered path for the `test` role, which is 97.3% of volume and near-zero forensic value. **This is the third distinct problem the `role` attribute solves.**
- **Spans: all of them go to disk** — `.start` from `onStart` (hang-visible), `.finish` from `onEnd`, via `SimpleSpanProcessor` straight through. The in-memory ring is demoted to an **index over the disk stream**, so eviction is not data loss. `BatchSpanProcessor` stays banned: it converts a ~5 ms crash window into a full flush-interval window (5,000 ms default) on the signal that matters most.
- **Metrics: activity-triggered snapshots, not a timer.** Reframing that makes this cheap — metrics here are *derived*, and since every span is durably on disk the stage histograms and `starts − (finishes + errors)` counts are **recomputable by replaying the JSONL**. Only non-span-backed state (dropped-record counters, gauges) needs independent persistence. Four options costed against the `getActiveResourcesInfo() → []` zero-handle property: (A) snapshot on the `memory_ping` pull — 0 handles, free, but *"written when somebody looks"* is the BL-353 failure with extra steps; (B) piggyback an existing tick — **rejected**, the only candidate is the periodic enrich pass, which is *currently disabled by an emergency brake*, so persistence would stop silently when an unrelated subsystem is braked; (C) **every N records — 0 handles, ~7 snapshots/day ≈ 4.4 ms/day, staleness bounded by work done rather than wall-clock, and it degrades in the right direction (busier ⇒ more frequent)**; (D) interval timer — 1 handle, **off by default**, opt-in via `SOX_TRACE_SNAPSHOT_MS`. **Adopt C as primary, A opportunistically, plus graceful-shutdown, D opt-in.** The snapshot is one JSONL line into the same sink, inheriting role routing, rotation, retention and durability — no second mechanism.
- **Crash-window acceptance table** (live-service role, after the BL-365 fix): logs **nothing lost**; span starts **nothing lost** — a hung span's `.start` is already durable; span finishes **nothing lost**; metrics at most the deltas since the last snapshot, **and those are recoverable by replaying the spans**.

**Also found:** SDK 2.x **removed the `View` and `ExplicitBucketHistogramAggregation` classes** — `new ExplicitBucketHistogramAggregation(...)` throws `TypeError: not a constructor` on 2.10.0. Any pre-2.0 tutorial or model recall produces code that does not run, which is a concrete demonstration of why the live-search directive exists.

**Prerequisite, blocking:** BL-344. Read directly, the allowlist is duplicated in at least four places — `libs/host-runtime/src/supervisor.ts:308-325`, `apps/sox/src/main.ts:4632-4642`, `apps/sox/src/main.ts:8728-8738`, `libs/host-runtime/src/runtime-cli.ts:542` — and the source itself admits it at `main.ts:8731-8735`. Naming our vars `SOX_TRACE_*` and adding one `startsWith` clause would work, **but would be the fifth instance of the bug rather than a fix.**

Citations: [wip/turso-live-metrics, architect-reviewer, claude, BL-351, 6: memory_recall 2026-07-31 (zero on-topic results, both queries), 7: prototype /Users/nix/.claude/jobs/1557bcef/tmp/otel-probe on Node v24.11.1 darwin arm64 — bundle sizes, stdout byte counts, ns/op benchmarks, collect() latency, getActiveResourcesInfo, cross-package trace join, exponential-histogram percentile error (p50 512 vs true 500, p99 1024 vs true 990), 8: npm registry 2026-07-31 (versions/licences/deps/publish dates), 9: docs/research/observability-substrate.md, 10: measured ConsoleSpanExporter stdout = 778 bytes; hung-span export test = 2 started / 1 exported (prototype), 11: read-only analysis of ~/.adhd/sox-ecosystem/memory/logs/memory-core-2026-07-{30,31}.jsonl — 82541 events, 814 pids, 16 live, 2729 live events (3.3%), 0.57MB of 21.43MB (2.7%), 272 bytes/event mean, 12: docs/observability/README.md §2, §3.1, §5.2, §5.3, 13: libs/memory-core/src/telemetry.ts:109-262 (RotatingJsonlWriter), :132-156 + :202-206 (silent drop on sink failure)]

---

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: owner directive 2026-07-31, 2: libs/memory-core/src/telemetry.ts, 3: BL-344 (allowlist scrubbing of SOX_MEMORY_LOG_*), 4: BL-319 (time_to_vector_ms 0 samples), 5: BL-334 (nine archaeology questions), 6: live `ls -la ~/.adhd/sox-ecosystem/memory/logs/` 2026-07-31 14:24 (17.2MB + 2.1MB JSONL), 7: owner requirement 2026-07-31]

---

### BL-352 — Store adapters do not verify or self-heal the artifacts they generate; "exists" is treated as "correct" — **Open (HIGH)** (2026-07-31)

**Owner directive, verbatim (2026-07-31):** *"the store adapter migration strategy was designed and built, so if the tables are not 100% accurate and resolved when that auto migrator runs that is a product defect that should not be manually corrected. This is also on generated data so it seems somewhat wild that isn't already handled. … the adapters should be verifying their store and migrating any missing data + generating missing indexes etc."*

**Driver.** The adapter's migration path reconciles by **existence**, never by **integrity**. `applySchema()` issues `CREATE TABLE/INDEX IF NOT EXISTS` and stamps a version; `targetVersion` is hard-coded to `1` with no `migrations[]` (BL-302). Consequence, observed in production: a structure that **exists but is empty or unpopulated** is invisible to the migrator forever, because `IF NOT EXISTS` no-ops on it.

Confirmed instances, all on **generated/derived data the adapter owns**:
- `idx_fts_node` present with an **empty Tantivy directory** — keyword search returned zero rows for every query for at least a day, silently (BL-347).
- Nine secondary indexes on `node` **unpopulated** after bulk insert; `PRAGMA integrity_check` reported 100+ issues and nothing detected or repaired it (BL-335).
- Duplicate `_adapter_meta` PRIMARY KEY rows — schema-impossible, and they block `REINDEX` (BL-336).

**The general defect:** the adapter generates derived artifacts (indexes, FTS directories, vectors) but has **no verification pass over its own output** and **no repair path**, so damage from a crash, a bulk insert, or a partial repair is permanent and undetectable through the normal open path.

**Requirement.** Adapter open performs a verification pass over generated artifacts — presence *and* integrity — and repairs what it owns through the migration executor (BL-302), transactionally, reporting the outcome into status (BL-334). No operator, no manual DDL. Verification must be cheap enough to run on every open, or explicitly staged (fast checks always, deep checks on a cadence or on a crash-recovery flag) — that tradeoff is part of the work.

**Note on probe design:** integrity probes must be validated against the damaged state. The obvious FTS probe — counting rows in the Tantivy backing table — reads **0 both when FTS is dead and when it works** (BL-347), so it detects nothing. Every probe added here requires a negative control proving it fails on damage.

**Acceptance (red→green, must name BL-352):** damage a generated artifact (empty the FTS directory; blank a secondary index), re-open through the **normal adapter path**, and assert detection and repair with no manual DDL in the test. Prove `applySchema()` alone does **not** fix it — that no-op is the mechanism. Each probe carries a negative control.

**Severity:** HIGH — this is the shared root of BL-347/335/336 and the reason a damaged store presents as healthy. It is also the item the owner has designated as the correct home for the live FTS repair, in place of manual intervention.

**Related:** BL-302 (the migration executor this needs), BL-347 (live instance, manual fix rejected), BL-335, BL-336, BL-337 (repair helper), BL-338 (recovery must be automatic), BL-341 (integrity-check message cap), BL-334 (report it).

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: owner directive 2026-07-31, 2: BL-302 (applySchema DDL-only reconciliation), 3: BL-347, 4: BL-335, 5: BL-336]


**UPDATE 2026-07-31 (database-administrator) — the verification/repair surface has SHIPPED (commit `fa786a2`); this item stays OPEN for the tail listed at the end.**

**What ships.** `libs/data/store/store-adapter/src/integrity.ts` interrogates the CONTENT of every artifact the adapter generates, discovered by introspecting `sqlite_master` — no schema knowledge from any consumer, so it works on the live store without memory-core declaring anything:

| Probe | Detects | Repair |
|---|---|---|
| `wal_identity` | WAL unlinked/replaced under a live connection (BL-330) | `wal_checkpoint(PASSIVE)` + loud report |
| `adapter_meta_unique` | duplicate PK rows (BL-336) | table rebuild, earliest row per key |
| `btree_index_populated` | index exists but is unpopulated (BL-335) | `REINDEX "<name>"` individually (BL-337) |
| `fts_index_live` | FTS index exists but does not match its own rows (BL-347) | `DROP INDEX` + dialect `createIndexDDL` |
| `pragma_integrity_check` (deep) | everything else, cap-aware (BL-341) | `REINDEX` by named object |

Wired into `TursoAdapterImpl.connect()` and `SqliteAdapterImpl.init()`, so it runs on the normal open path. `StoreAdapter.init()` is now a declared interface member instead of an `as any` call in the factory.

**Cost tradeoff, measured on a copy of the live 43 MB store (9 428 nodes, 47 038 edges, 19 probeable indexes), median of three:**

| | cost |
|---|---|
| `adapter_meta_unique` | < 0.5 ms |
| `fts_index_live` | 9.3 ms |
| `btree_index_populated` | 78.5 ms |
| **fast total (every open)** | **91 ms** |
| **deep total** | **392 ms** |

`fast` runs on every open — it is a fraction of the store open it sits inside and it catches all four production defects. `deep` adds `PRAGMA integrity_check` and runs when the previous session did not record a clean shutdown (a new `_adapter_meta` `clean_shutdown` marker, the BL-338 crash-recovery flag), or on request. Controls: `SOX_STORE_VERIFY=off|fast|deep`, `SOX_STORE_REPAIR=off`.

**Three probe-design traps were measured and are defended against structurally, not by convention.** Each would have produced a green probe on a damaged store — the BL-167 failure mode:
1. **The Tantivy backing-table row count reads 0 in every state** — damaged, repaired, and freshly built. It detects nothing. See the BL-347 update.
2. **Turso silently ignores `INDEXED BY` on a PARTIAL index** — `SELECT COUNT(*) FROM t INDEXED BY ix_part` plans as a bare `SCAN t` (real SQLite raises "no query solution"), so the count matches the table trivially and every partial index reports healthy. **8 of the live store's 20 indexes are partial.** The probe now appends the index's own predicate and requires `EXPLAIN QUERY PLAN` to name the index; when it does not, the finding is `unknown`, never `ok`.
3. **A bare `COUNT(*)` baseline is itself corrupted by the damage it is meant to detect.** SQLite optimises `SELECT COUNT(*) FROM t` by scanning the smallest index — the unpopulated one — so the first version of the probe reported `fully populated (0/0)` on a table holding 40 rows. Baselines now count through the table btree (`ORDER BY rowid`). `INDEXED BY` alone also does not force a full scan through an index on either engine; the probe orders by the leading indexed column so both planners choose `SCAN … USING COVERING INDEX`.

**Red→green evidence.** `src/__tests__/integrity-selfheal.test.ts`, 17 tests, all naming their BL-IDs. Verified failing then passing, not asserted:
- With the three probes stubbed to return no findings, **7 tests fail** (detection, repair, auto-heal-on-open, and the two Turso soundness guards); restored, all pass. Full suite 257/257.
- With the `close()` WAL guard removed, the BL-330 test fails with `Parse error: no such table: t` on reopen — total silent loss; restored, 140/140 retained.
- Each test asserts the healthy negative control first, then the damage, then that **re-running the schema DDL does not fix it**, then repair. The `IF NOT EXISTS` no-op is asserted, not assumed.
- A dedicated test pins that the naive "does FTS match anything at all" probe is GREEN on the damage shape where the sentinel probe is red.

**Acceptance against the REAL live damage.** A copy of `~/.memory/memory.db` (the live store was not touched) opened through `createTursoAdapter()`:
```
[damaged] [BL-336] _adapter_meta: Duplicate PRIMARY KEY rows: adapter_type×2, adapter_version×2, created_at×2
[damaged] [BL-347] idx_fts_node: 2/3 sentinel rows (rowid 1, 7961) are present in "node" but NOT matchable
[repaired] _adapter_meta: rebuilt keeping the earliest row per key (2.5ms)
[repaired] idx_fts_node: dropped and rebuilt FTS index (256ms)
open took 461.6ms · post-repair damaged: 0
```
Ground truth before → after: `fts_match('memory')` **0 → 1148** (LIKE 1074), `turso` **0 → 136** (LIKE 137), `backlog` **0 → 84** (LIKE 83); the oldest row (rowid 1) matchable again; `_adapter_meta` 6 rows → 3.

**⚠️ The live store is NOT yet auto-repaired.** The fix is in `store-adapter`'s source and `dist`, but the running memory-server is a **bundled** artifact that has not been rebuilt (the live service is up; a rebuild is destructive per BL-235). The live store self-heals on the first open after memory-server is rebuilt and restarted — not before.

**Remaining, why this stays open:**
1. ~~**Report into status (BL-334).**~~ **DONE 2026-07-31** (commit `0d2d629`) — `memory_ping.store.integrity` + `memory_stats` now report the verdict, read from `_adapter_meta.last_integrity` rather than the in-process registry (which is unreadable from there, BL-368). A damaged store can no longer present as healthy. Note the reporting layer also caught a defect in this engine: page-accounting messages (`Page N: never used`) are reclaimable free space, not damage, and counting them kept the live copy at `reverified: damaged` forever after a fully successful repair — fixed in the same commit.
2. **Route through the migration executor (BL-302).** Repairs currently run as direct adapter operations, not as versioned migrations. BL-302's executor does not exist.
3. **No committable Turso FTS damage fixture** — the Turso side of the FTS negative control exists only against the live copy. Filed separately.
4. **Vectors are not verified.** `vec_node` consistency (row present, correct byte length, no orphans) is named in this item's requirement and is not probed.
5. **Deep verification is not on a cadence** — only on unclean shutdown or on request.

Citations: [wip/turso-live-metrics, database-administrator, claude, sandbox P0.7, 6: libs/data/store/store-adapter/src/integrity.ts, 7: libs/data/store/store-adapter/src/__tests__/integrity-selfheal.test.ts, 8: libs/data/store/store-adapter/src/turso-adapter.ts, 9: libs/data/store/store-adapter/src/sqlite-adapter.ts, 10: libs/data/store/store-adapter/src/adapter-meta.ts, 11: `createTursoAdapter()` acceptance run against a copy of `~/.memory/memory.db` 2026-07-31, 12: probe-trap measurements (partial-index INDEXED BY, COUNT(*) baseline, Tantivy backing count) 2026-07-31]

---

### BL-353 — Telemetry is written to disk and never read: 75k events, two days, zero analysis — **Open (HIGH)** (2026-07-31)

**Driver.** BL-320's structured JSONL telemetry has been writing since 2026-07-30 — **17.2 MB / 66887 events** on day one, **2.1 MB / 8500** by 14:24 on day two. Until 2026-07-31 **nothing in the repo referenced it, no analysis had ever been run against it, and no backlog item cited its contents.** No documentation existed describing the format, the event catalog, or how to read it (now written: `docs/observability/README.md`).

The owner's observation that prompted this: *"I've been requesting logs for a while but clearly there's just missing documentation of what we've built."*

**The cost of not reading them.** A single analysis pass, run once against data already two days old, immediately produced findings that had been open and blocking:

- **BL-331's central open question — answered.** Its own fix sketch proposed *"instrument the gap using the BL-320 JSONL trace (`embed.start`/`embed.finish` durations vs wall-clock between them) to separate queue-wait from compute."* Nobody ran it. The data says: median gap between an embed finishing and the next starting is **9 ms**, and `writequeue.task` p50 is **0 ms** — so it is **neither** queue-wait **nor** the DB write. The time is inside embed compute.[1]
- **Same code, same machine, same day**, split by whether the pid touches the live store: test-process embeds p50 **297 ms** (p90 315, max 1070); live-store embeds p50 **6936 ms**, p90 **91186 ms**, max **10953175 ms (3 hours)**, with 21 of 80 exceeding 30 s.[1] BL-331's "~18x too slow" is confirmed as **~23x on the median plus a catastrophic tail** — a materially different defect than a uniform slowdown.
- **BL-323 confirmed firing at volume in production** — `store.open.error: Cannot read properties of undefined (reading 'load')`, 200 occurrences.[1]
- **BL-342 confirmed live** — `step failed: Parse error: malformed JSON`.[1]
- **Schema drift confirmed live** (BL-300/301) — `no such column: meta`, `no such column: k`, `no such table: main.fts_node`.[1]
- **`embed_pipeline.phaseB.error: wq.enqueue is not a function`, 73 occurrences** — a plain TypeError on the vector-persist path: embedding computed, then fails to be written. This is the BL-348 loss scenario, observed. Scope on the live path still to be confirmed.[1]

**Second finding — start/finish accounting gaps.** The always-log-the-start guarantee makes hangs countable as `starts − (finishes + errors)`:

| Operation | start | finish | error | unaccounted |
|---|---|---|---|---|
| `store.open` | 7514 | 1406 | 1549 | **4559 (61%)** |
| `write.phaseA` | 3910 | 1058 | 82 | **2770 (71%)** |
| `embed` | 1898 | 1838 | 20 | 40 |
| `writequeue.task` | 22275 | 22134 | 140 | 1 |

The write queue accounts for essentially all its work; `store.open` and `write.phaseA` do not, by a wide margin. Some share is processes killed mid-operation (test runners exiting) and this method cannot distinguish that — **an upper bound and a lead, not a verdict.**

**⚠ These figures are further distorted by BL-365 (found 2026-07-31, after this item was filed).** The sink buffers in userspace and loses everything unflushed on a hard kill — measured, **0 of 10,000 records survived SIGKILL**. So an operation whose `.start` was still buffered when its process died is counted as **"never started"** rather than "never finished", which biases the unaccounted percentages **in an unknown direction**. The 61% / 71% figures cannot be trusted quantitatively until BL-365 lands; the *shape* of the finding (write-queue accounts for its work, `store.open` and `write.phaseA` do not) is still the lead worth chasing. It needs a real answer, because 61% of store opens never completing is either a large instrumentation lie or a large resource leak, and both matter.[1]

**Third finding — the log is a single stream shared by the live server and every test process on the machine**, with no field distinguishing them; they must be separated by inferring which pids touch the live store path. Analysed together the populations are meaningless in both directions: the combined embed mean of 69476 ms describes neither the 297 ms test median nor the 6936 ms live median.[1] A `role`/`env` field on every record would remove the inference.

**Fix sketch:**
1. Tag records with the emitting role (live service / test / CLI) so populations never need to be inferred (see third finding).
2. Periodic automated analysis with the derived metrics surfaced through the status surface (BL-334) rather than requiring a human to run a script — an operator must not have to know this file exists.
3. Alert on the countable conditions: error-rate spikes, start-without-finish ratios, embed p95 regressions.
4. Keep `docs/observability/README.md` current as the event catalog changes.

**Acceptance (must name BL-353):** the start/finish accounting and per-population embed percentiles are derivable from a committed script **and** reachable from `memory_ping` without reading a file by hand; a regression in either surfaces without a human initiating the query.

**Severity:** HIGH — this is the observability gap *behind* the observability gap. We paid the full write cost of telemetry (17 MB/day, hot-path instrumentation, a whole module) and took none of the value, while running blind investigations against the same defects the log had already recorded.

**Related:** BL-365 (the sink is not crash-durable — biases this item's own numbers), BL-351 (the substrate that must not repeat this), BL-334 (surfacing), BL-319 (metrics), BL-331 (answered by this data), BL-342, BL-348, BL-300/301, BL-344 (controls scrubbed, so the live service cannot be tuned).

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: ~/.adhd/sox-ecosystem/memory/log-analysis/{analyze-events.py,analyze-live-vs-test.py} run against ~/.adhd/sox-ecosystem/memory/logs/memory-core-2026-07-{30,31}.jsonl, 2: libs/memory-core/src/telemetry.ts, 3: docs/observability/README.md]

---

### BL-358 — `WriteQueue` never computes queue wait time; `estimated_wait_ms` is a prediction reported as if it were an observation — **Open (HIGH)** (2026-07-31)

**Driver.** BL-351 requires the wait-vs-work split as a first-class primitive and names `write_queue_wait` as the measurement Theme 2's resource governance is blocked on. Reading the code, the reason nothing reports it is concrete and small: **the queue never records when an item was enqueued.**

`enqueue()` pushes `{ label, kind, operation, resolve, reject, traceId }` — **no timestamp**.[1] `_recordLatencySample(latencyMs, kind)` is called from `_processNext` with *execution* latency only, and feeds both the reporting rings and the admission-control estimator.[2] Every latency number the status surface reports for the write queue (`write_latency_ms`, `apply_latency_ms`, `recent_avg_task_latency_ms`) is therefore **work time exclusively**. The time an item spends sitting in the queue behind other work — the entire quantity of interest under contention — is never observed by anything.

**The subtler defect.** `estimated_wait_ms` **is** reported, in the `E_BUSY(deadline)` rejection payload and its `details` block, and it reads like a measurement.[3] It is not: it is `(queue.length + in_flight + 1) × recentMean(work_latency)` — a *prediction* derived from work latency, computed only on the admission path, and **never compared against what actually happened**. Under a load where work latency and wait latency diverge (exactly the BL-345 starvation regime), the estimator is wrong in an unknown direction and nothing in the system can tell. This is the BL-334 pattern — a plausible number nobody can falsify.

**Requirement.** Stamp the enqueue instant on the queue item; on dequeue, record `wait_ms = dequeued_at − enqueued_at` alongside the existing work sample, as a *paired* emission (BL-351 §5.2 — there must be no API that records one without the other). Report both through the status surface. Additionally record estimator error (`estimated_wait_ms` vs observed `wait_ms`) so the admission-control heuristic becomes falsifiable.

**Note — do not replace `LatencyRing` with the OTel histogram here.** The admission-control estimator depends on `recentMean(RECENT_AVG_WINDOW)`, a *rolling window*; OTel histograms are cumulative and cannot express it. The histogram is for reporting, the ring is a control input. Swapping them would silently change admission behaviour.[4]

**Acceptance (red→green, must name BL-358):** enqueue N tasks against a queue with a deliberately slow head-of-line task; assert the reported `write_queue.wait_ms` for the trailing tasks is non-zero and >> their `work_ms`. Must fail today (no such field exists). A second assertion: with an idle queue, `wait_ms ≈ 0` while `work_ms > 0` — proving the two are actually distinguished and not the same clock reported twice.

**Severity:** HIGH — this is the single concrete missing measurement behind BL-351's wait-vs-work requirement and BL-322/BL-345's resource governance. Two emergency brakes are currently ON in production because of contention nothing measures.

**Related:** BL-351 (the substrate; this is its first real consumer), BL-322, BL-345 (the contention this would quantify), BL-319, BL-334 (unfalsifiable numbers in the status surface), BL-353.

Citations: [wip/turso-live-metrics, architect-reviewer, claude, BL-351, 1: libs/memory-core/src/write-queue.ts:615 (queue.push — no enqueue timestamp), 2: libs/memory-core/src/write-queue.ts:657-664 (_recordLatencySample — execution latency only), 3: libs/memory-core/src/write-queue.ts:576-612 (admission control estimator + E_BUSY details), 4: libs/memory-core/src/latency-stats.ts:99-113 (recentMean — rolling window), 5: docs/research/observability-substrate.md §3.5, §3.6]

---

### BL-355 — `tools/bundle-extension.cjs` does not minify; every dependency costs ~2.7x its minified footprint — **Open (LOW)** (2026-07-31)

**Observation.** `tools/bundle-extension.cjs` passes no `--minify` to esbuild (grep for `minify` in the file returns nothing). Consequence, measured: `extensions/bundles/sox-memory-bundle/members/memory-server/dist/index.js` is **2,418,414 bytes**.[1] In a side-by-side test of the same entry, esbuild 0.25.0 produced **573,358 bytes** unminified vs **209,001 bytes** minified — a **2.7x** ratio.[2]

**Why it is worth filing rather than ignoring.** It is not a defect and nothing is broken. But it sets the price of every future dependency at ~2.7x its real cost, and that price is now being paid on a live decision: BL-351's recommended OpenTelemetry set is +573 KB unminified (+23.7%) where minified it would be +209 KB (+8.6%). Enabling minification would recover more from the *existing* bundle than the new dependency adds.

**Caveats that must be checked before flipping it**, not after: `--enable-source-maps` is already passed to the spawned entrypoint (`apps/sox/src/main.ts` exec path), so minification without `--sourcemap` would degrade stack traces from the exact production surface we debug against; and the registry checksums in `registry/index.json` change on every artifact, so this requires `npx nx run registry:sync-index` and a smoke-test pass in the same change.

**Acceptance:** either minification is enabled with source maps and the smoke test passes with regenerated checksums, or a note is added to `docs/standards/extension-bundling.md` recording the deliberate decision not to and why.

**Severity:** LOW — no functional impact.

**Related:** BL-351 (the decision that surfaced it), BL-307/BL-309 (externals policy), `docs/standards/extension-bundling.md`.

Citations: [wip/turso-live-metrics, architect-reviewer, claude, BL-351, 1: `ls -l extensions/bundles/sox-memory-bundle/members/memory-server/dist/index.js` 2026-07-31, 2: prototype /Users/nix/.claude/jobs/1557bcef/tmp/otel-probe (esbuild 0.25.0, same entry, with and without --minify), 3: tools/bundle-extension.cjs (no minify flag)]

---

### BL-357 — Library builds compile `__tests__/*.test.ts`: one test-file type error takes down the build and every downstream consumer — **Open (HIGH)** (2026-07-31)

**Driver.** `store-adapter`'s `build` target failed to compile — not on library code, but on a **test file**:

```
libs/data/store/store-adapter/src/__tests__/integrity-selfheal.test.ts:345:17 - error TS2339:
  Property 'init' does not exist on type 'SqliteAdapter'.
NX  Running target test for project memory-core and 7 tasks it depends on failed
Failed tasks: - store-adapter:build
```

Because `memory-core:test` depends on `store-adapter:build`, a type error in a **store-adapter test file** made `npx nx test memory-core` unrunnable for a different agent working in a different package.[1] Work was blocked on a file the blocked party had no reason to read.

**Root cause — two test-file naming conventions, one exclude.** `libs/data/store/store-adapter/tsconfig.lib.json`:
```json
"include": ["src/**/*.ts"],
"exclude": ["src/**/*.spec.ts"]
```
`*.spec.ts` is excluded; **`__tests__/**/*.test.ts` is not**. Any test written with the `.test.ts` convention is therefore compiled *into the library build*, and its type errors are build errors with the full downstream blast radius.[2] This is not new — `src/__tests__/turso-fts-index-method.test.ts` already existed under the same convention; the configuration has simply never been exercised by a test file that failed to typecheck.

**Blast radius:** every consumer of a package whose `tsconfig.lib.json` uses a `*.spec.ts`-only exclude. This must be audited repo-wide — the same two-convention split is likely present elsewhere, and it converts an ordinary red test into a cross-package build outage.

**Repo-wide audit COMPLETE (2026-07-31, `p0-test-infra`).** All 21 `tsconfig.lib.json` files outside worktrees were parsed and their `exclude` arrays compared. **Exactly 3 of 21 are affected** — all three under `libs/data/`, all three excluding `src/**/*.spec.ts` and nothing else:[4]

| Package | `exclude` | Affected |
|---|---|---|
| `libs/data/store/store-adapter` | `['src/**/*.spec.ts']` | **yes** — the outage package |
| `libs/data/store/blob-store` | `['src/**/*.spec.ts']` | **yes** |
| `libs/data/verify/claim-verification` | `['src/**/*.spec.ts']` | **yes** |
| the other 18 | include `src/**/*.test.ts` | no |

So this is a localised drift, not a repo-wide convention failure — the 18 correct configs are the norm and these 3 are the outliers, which is why it went unnoticed for so long: only a package that *both* omits the pattern *and* has a `.test.ts` file under `src/` can ever trip it, and until `integrity-selfheal.test.ts` was written with a type error, none had.

**Related but distinct from BL-340.** BL-340 is *tests are never typechecked*; this is *tests are typechecked as if they were library code*. Same family — no deliberate boundary between test and lib type-checking — opposite failure. Fixing one does not fix the other, and BL-340's new `typecheck-tests` target is the correct home for test type errors, precisely so `build` stops being it.

**Fix sketch:** exclude both conventions from every `tsconfig.lib.json` (`src/**/*.spec.ts`, `src/**/*.test.ts`, `src/__tests__/**`); audit every package for the same gap; standardise on one test-file convention and lint for it. Test type errors then surface in `typecheck-tests` (BL-340) where they belong, without taking a build down.

**Acceptance (red→green, must name BL-357):** introduce a deliberate type error in a `__tests__/*.test.ts` file and assert `nx build <pkg>` still SUCCEEDS while `nx run <pkg>:typecheck-tests` FAILS. Today the first fails.

**Severity:** HIGH — a red test in one package silently becomes a build outage in every downstream package. It cost a concurrent agent its ability to measure at all.

**Numbering note:** originally filed as BL-354 in commit `83b0483`; renumbered to BL-357 after `p1-tracing-research` filed a different BL-354 in `0e9026b` minutes earlier. That item has since moved again — to BL-356, then BL-358 — as two further agents claimed the same ids. **There is no BL-354 any more.** References to "BL-354" in `83b0483`'s commit message mean this item. See BL-359 for the allocation race that caused all of it.

**Related:** BL-340 (tests never typechecked — the inverse), BL-235 (destructive builds; note `atomic-tsc` correctly left the existing `dist/` intact here, which is the behaviour BL-235 wants everywhere).

Citations: [wip/turso-live-metrics, team-lead + p0-test-infra, claude, turso-go-live, 1: live `npx nx test memory-core` failure 2026-07-31, 2: libs/data/store/store-adapter/tsconfig.lib.json:10-11, 3: libs/data/store/store-adapter/src/sqlite-adapter.ts:150 (`init()` exists on the class but is not declared on the interface `createSqliteAdapter()` returns), 4: libs/data/store/blob-store/tsconfig.lib.json, libs/data/verify/claim-verification/tsconfig.lib.json, and the 18 correct configs (libs/{tokenguard-core,install-engine,host-runtime,service-proxy,source-provider,manifest,mcp-runtime,authoring,host-registry,registry,memory-core}/tsconfig.lib.json + libs/data/{analysis/analysis,embed/embedding-provider,ingest/ingest,graph/graph-store,vectors/vector-store,search/hybrid-search,queue/task-queue}/tsconfig.lib.json)]

---

### BL-359 — BL ids are allocated by a read-then-write race: three agents, two collisions, one dangling cross-reference — **Open (MEDIUM, process)** (2026-07-31)

**Driver.** A new backlog id is chosen by reading the current maximum `### BL-<n>` from a shared file and adding one. There is no reservation and no uniqueness check, so any two agents who read before either writes will pick the **same id**. On 2026-07-31, three agents filing within roughly an hour produced **two collisions**:

- **BL-344** — filed by `mitigate-reads`, then independently by the team lead minutes later. Resolved by renumbering the second to BL-346.
- **BL-354** — filed by `p1-tracing-research` (`0e9026b`), then independently by the team lead (`83b0483`). The lead's renumbered to BL-357; the researcher's then had to move *again* — to BL-356, which was **also** concurrently claimed by `p0-cluster-calibration` — and finally to **BL-358**. One id, four agents, three renumbers. **There is no BL-354 any longer.**

**Why this is worse than untidy.** An id is a citation target the moment it is written. `BL-328`'s "Related" line cited "BL-354 (a fixed τ is not calibratable at all)" — correct when written, and silently pointing at a *different item* once the renumbering settled.[1] Cross-references, commit messages, code comments and agent handoffs all capture ids by value; renumbering cannot chase them. Every collision therefore risks a permanently wrong reference in a document whose entire purpose is to be authoritative, and this one produced exactly that. Commit messages are immutable, so `83b0483`'s body will name BL-354 forever.

**Detection is trivial and was not in place:**
```
grep -o '^### BL-[0-9]*' BACKLOG.md | sort -V | uniq -d      # must print nothing
```
Verified empty as of this filing. The check has been added to the status-header block next to the regenerate command, but a documented command is not a guard — nothing runs it.

**Fix sketch (ranked):**
1. **Pre-commit hook** rejecting any commit that leaves duplicate `### BL-<n>` headings, and rejecting a reference to an id that has no heading. Cheap, catches both failure modes at the only moment that matters, requires no coordination between agents.
2. **Reservation** — an allocator (a `BL-NEXT:` line bumped atomically, or a tiny script that appends a placeholder heading in one write) so the id is claimed before the item body is written.
3. Longer term this disappears into the backlog MCP tool, where ids are server-allocated — the markdown→tool import is already authorized and deferred. Note it does **not** disappear on its own: until the import happens, every agent-heavy session reproduces this.

**Acceptance (red→green, must name BL-359):** a hook or CI check that fails on a BACKLOG.md containing two identical `### BL-<n>` headings, and passes once deduplicated. Must be demonstrated failing.

**Severity:** MEDIUM — no runtime impact, but it corrupts the reference integrity of the project's own record, and it recurs on every parallel-agent session. It has already produced one wrong cross-reference and three renumbers in a single day.

**Related:** BL-346 (first collision), BL-357 (second), BL-358 (the thrice-renumbered item), BL-224/BL-225 (status-header and marker integrity — same family: the backlog's own metadata not being trustworthy).

Citations: [wip/turso-live-metrics, team-lead + p1-tracing-research, claude, turso-go-live, 1: BACKLOG.md BL-328 "Related" line (since corrected to BL-356), 2: commits 0e9026b / 83b0483 / 79c2c4f / be8a526, 3: BACKLOG.md status-header regenerate block]

---

### BL-371 — A literal NUL byte in `integrity.ts` made `grep` silently return NOTHING for the whole file — **RESOLVED (HIGH)** (2026-07-31)

**Driver.** `libs/data/store/store-adapter/src/integrity.ts:445` contained a **raw NUL byte** in a string literal (`ix.tbl_name + '<0x00>' + predicate`) rather than the `'\0'` escape. `grep` applies binary-content detection, and this shell's `grep` wrapper suppresses the *"Binary file matches"* notice entirely — so a search of that file returned **no output and exit status 0**, indistinguishable from "the symbol is not there."

Measured before the fix:
```
/usr/bin/grep -c 'tbl_name' integrity.ts   →  8
grep -c 'tbl_name' integrity.ts            →  (nothing)
```

**Why this is HIGH despite being a one-character bug.** It produces **silent false negatives in the primary tool agents use to establish that code does or does not exist.** An agent that greps this file and finds nothing concludes the symbol is absent and acts on it. `p1-tracing-research` hit exactly this twice — got `NOT FOUND` for a symbol that was demonstrably present — and reported that **one of its earlier "nothing uncommitted" status claims to the team lead was made through that broken path.** So the defect did not merely waste time; it put an unreliable claim into a coordination channel, and neither party could have detected it.

This is the same family as BL-347 (a probe that reads 0 both when the artifact is dead and when it works) and BL-319 (`time_to_vector_ms` populated on one of two paths): **a signal whose failure mode is indistinguishable from a legitimate negative result.**

**Fix.** Replaced the raw byte with the `'\0'` escape. The runtime value is **byte-identical** — `'\0'` in a TypeScript string literal *is* a NUL character, so the key separator's behaviour is unchanged; only the on-disk encoding differs. Verified: `grep -c 'tbl_name'` now returns 8, no NUL bytes remain in the file, and `nx run-many -t typecheck,lint -p store-adapter` passes.

**Acceptance (red→green, must name BL-371) — SATISFIED.** `tools/check-no-nul-bytes.mjs` scans every source file under `libs/`, `extensions/`, `apps/`, `tools/`, `docs/`, `scripts/` and fails on any raw `0x00`, reporting `file:line`. Demonstrated in **both** directions, run not asserted:

```
GREEN  check-no-nul-bytes: OK — 984 source files, no raw NUL bytes.
RED    (byte reintroduced) libs/data/store/store-adapter/src/integrity.ts:445   exit=1
GREEN  (fix restored)      OK — 984 source files                                exit=0
```

A repo-wide scan confirmed `integrity.ts` was the **only** affected file. `nx run-many -t typecheck,lint -p store-adapter` passes with the fix in place.

**Follow-up worth considering separately:** agents in this checkout use a `grep` that is a **shell function from the Claude Code shell snapshot**, not `/usr/bin/grep`. Any negative grep result from that function is only as trustworthy as its handling of the file's encoding. Agents validating an absence claim on a file they have not read should prefer `/usr/bin/grep` or an explicit `-a`.

**Severity:** HIGH — silent false negatives in the tool used to establish absence, on a file central to the integrity engine, which already put one incorrect status claim into an agent coordination channel.

**Related:** BL-347 (probe indistinguishable from healthy), BL-319 (instrument wired to one of two paths), BL-352 (the engine this file implements).

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: libs/data/store/store-adapter/src/integrity.ts:445, 2: measured `grep` vs `/usr/bin/grep` divergence 2026-07-31, 3: p0-adapter-integrity + p1-tracing-research reports 2026-07-31]

---

### BL-372 — Restarting the service does NOT deploy new code: the backend survives as an orphan and keeps serving the old bundle — **Open (HIGH)** (2026-07-31)

**Driver.** A verified, correct deploy silently did nothing. Sequence, all measured on the live host:

1. `npx nx build memory-server` — succeeded, new bundle written (artifact `6a0c13cda152`).
2. `launchctl kickstart -k gui/$(id -u)/com.sox.user.memory-server` — exit 0.
3. `pgrep` afterwards: proxy is a **new pid (43302)**, but backend **7721** and its fastembed child **7724** are the **same pids as before**, started five hours earlier.
4. `ps -o ppid` on 7721: **PPID 1** — reparented to init, an orphan of the pre-restart proxy.
5. `pgrep -P 43302`: **no children.** The new proxy had spawned nothing.
6. `memory_ping` reported `instance.pid: 7721`, artifact `288f38cc10ce` (**the old bundle**), and **no `store.integrity` field** — proving the old code was still serving.

**So the unit restarted, reported success, and the running code did not change.** Every check an operator would plausibly run — build succeeded, `kickstart` exit 0, service shows as running — was green while the deploy had not happened.

**Root cause is not yet pinned** and must not be guessed: the front-shim service-proxy (Slice 1.5) deliberately keeps the backend alive across proxy restarts for zero-downtime, so this may be *designed* behaviour whose consequence for code deploys was never considered — or it may be a genuine orphan-reaper failure (`[inv:singleton]`, `[inv:unload-then-reap]`). Either way, **there is no documented deploy procedure that actually deploys.**

**What worked:** `kill -TERM <backend-pid>`, after which the proxy respawned the backend on the new bundle. That is the missing step, and it is nowhere in the runbook.

**Fix sketch:** either `kickstart` must reap the backend (verified-stop, per the lifecycle spec), or a `sox service deploy`/`--reload-backend` verb must exist that does, and the runbook must state that a bundle change requires it. **The status surface must also report the running artifact hash against the on-disk one** — `memory_ping` already returns `artifact`, so a mismatch is trivially detectable and would have made this self-evident.

**Acceptance (red→green, must name BL-372):** rebuild with a detectable change, restart via the documented procedure, assert the running instance reports the NEW artifact hash. Must fail against today's procedure.

**Severity:** HIGH — silent no-op deploys. Any fix shipped this way was never actually live, and everyone involved would reasonably believe it was.

**Related:** BL-332 (`soxe list` reports a running service as INACTIVE — same family: lifecycle surfaces that do not reflect reality), `docs/spec/service-lifecycle.md`, BL-334.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: live pgrep/ps/pgrep -P + memory_ping artifact comparison 2026-07-31, 2: ~/Library/LaunchAgents/com.sox.user.memory-server.plist]

---

### BL-373 — A stale `-tshm` makes the store permanently unopenable, with a diagnostic that points at the wrong file — **Open (HIGH)** (2026-07-31)

**Driver.** After restarting the backend, every store open failed, in a tight retry loop, with:

```
failed to open database /Users/nix/.memory/memory.db:
  I/O error: short read on WAL frame at offset 383192: expected 4096 bytes, got 0
```

At that moment `memory.db-wal` was **0 bytes** and the database had been cleanly checkpointed. The error names a WAL frame that cannot exist in an empty WAL.

**Root cause: `memory.db-tshm`** — Turso's own WAL index sidecar, 86016 bytes, **stale from the previous day (Jul 30 18:04)**. It recorded frame metadata for a WAL that no longer had content. Moving it aside made the store open immediately and correctly (9478 nodes). Confirmed by direct driver open before and after, outside the service.

The ordinary `-shm` (also stale, 15:20) was **not** sufficient on its own — removing it alone left the failure unchanged. It is specifically the Turso `-tshm` that must be reconciled.

**Three distinct defects here, worth separating:**
1. **No self-recovery.** A stale sidecar is trivially reconcilable — it is a derived index — yet the store is permanently unopenable and the backend crash-loops. Nothing detects or clears it. This is BL-352's thesis (verify and repair what we generate) applied to a file BL-352 does not currently cover.
2. **The diagnostic points at the wrong artifact.** It names `memory.db` and a WAL offset. Nothing mentions `-tshm`. Recovery required knowing Turso keeps a second index sidecar and guessing it was stale — nothing in the error, the logs, or any doc says so.
3. **It is invisible in the telemetry as anything but a repeated error.** `store.open.error` fired identically for three separate pids with no escalation and no distinct signal — indistinguishable from any other open failure.

**Fix sketch:** detect a `-tshm`/`-shm` that disagrees with the WAL at open, and reconcile it (remove and let it rebuild) rather than failing; name the actual offending file in the error; add it to the BL-352 integrity probes and to BL-330's orphaned-sidecar maintenance guard, which already covers stray `*-wal` files and should cover `*-tshm` too.

**Acceptance (red→green, must name BL-373):** seed a store with a stale `-tshm` and an empty WAL, open it through the normal adapter path, and assert it opens successfully (or fails with an error naming `-tshm`). Must fail today.

**Severity:** HIGH — total, unrecoverable-without-expert-knowledge outage of the store, triggered by an ordinary restart, on a defect the system generates itself.

**Related:** BL-330 (unlinked WAL / orphaned sidecars — same family, adjacent file), BL-352 (verify and self-heal generated artifacts), BL-372 (the restart that exposed it).

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: live store.open.error across pids 46080/47203 2026-07-31, 2: direct driver open before/after moving ~/.memory/memory.db-tshm, 3: preserved at ~/.adhd/sox-ecosystem/memory/prerestart-20260731-174637/stale-tshm-jul30]


**FIXED IN SOURCE 2026-07-31 (database-administrator, commit `8fe0571`). Stays OPEN until deployed.**

Reproduced exactly from the preserved artifacts (`prerestart-20260731-174637/memory.db` + `stale-tshm-jul30` + `stale-wal-empty`): `failed to open database …: I/O error: short read on WAL frame at offset 383192: expected 4096 bytes, got 0`. Moving the `-tshm` aside opens it immediately with 9478 nodes.

**All three sub-defects addressed, in `TursoAdapterImpl.connect()` — not in a post-open probe, because `connect()` itself is what fails, so nothing downstream ever runs:**
1. **Self-recovery.** On a WAL-frame open failure the sidecar is moved aside and the open retried once. It is **renamed, never deleted** — the stale file is the only forensic record of why the store would not open, and preserving it is what made this item diagnosable. Recovery acts **only when the WAL is absent or 0 bytes**; a non-empty WAL may be legitimately described by the sidecar, so that case is declined and reported rather than guessed at.
2. **The diagnostic names the right file.** `describeStaleWalIndexFailure()` names `<db>-tshm` explicitly, explains that it is derived state Turso rebuilds, and preserves the original driver text as primary evidence.
3. **Distinct telemetry.** Emits through the integrity report sink as `[BL-373] stale WAL-index sidecar blocked the open …` / `… store opened after reconciling …`, so it is no longer indistinguishable from any other `store.open.error`.

**Committable repro derived** (the live artifact is 43 MB and cannot be a fixture): seed ≥900 rows, capture the `-tshm`, `PRAGMA wal_checkpoint(TRUNCATE)`, close, restore the captured sidecar. Measured — 300 and 600 rows do **not** reproduce, 900 and 1200 do. The seed must use the **raw driver**: going through the adapter writes `_adapter_meta` after the checkpoint and puts fresh frames back into the WAL, defeating the fixture.

**Red→green (names BL-373):** with the recovery disabled the test fails with the live signature (`short read on WAL frame at offset 2447312`); with it, the store opens and all 1200 rows are intact. The test's precondition calls `expect.fail()` — not `skip` — if a future driver stops exhibiting the defect, so it can never pass vacuously (BL-167).

**Still open beyond the adapter fix:** BL-330's orphaned-sidecar maintenance guard should cover stray `*-tshm` alongside `*-wal`; `~/.memory/` still holds debris from earlier migrations.

Citations: [wip/turso-live-metrics, database-administrator, claude, BL-373, 4: libs/data/store/store-adapter/src/integrity.ts (isStaleWalIndexError, recoverStaleWalIndex, describeStaleWalIndexFailure), 5: libs/data/store/store-adapter/src/turso-adapter.ts (connect recovery path), 6: libs/data/store/store-adapter/src/__tests__/integrity-selfheal.test.ts (BL-373 describe), 7: reproduction against ~/.adhd/sox-ecosystem/memory/prerestart-20260731-174637/ 2026-07-31]

---

### BL-374 — Post-repair reverification reports DAMAGED on a store whose repairs demonstrably succeeded — **Open (HIGH)** (2026-07-31)

**Driver.** On the first live open after the integrity engine shipped, `memory_ping` reported:

```
integrity_headline : store integrity DAMAGED — 2 artifact(s)
overall            : damaged        healthy: false
repair.attempted   : true           repair.ok: false      reverified: damaged
actions            : _adapter_meta rebuilt (8.5ms)            ok: true
                     idx_fts_node dropped and rebuilt (982.6ms) ok: true
```

**Both repair actions individually report `ok: true`, and ground truth confirms both genuinely worked.** Measured directly against the live store immediately afterwards:

| check | before | after |
|---|---|---|
| `fts_match('memory')` | 0 | **1156** (LIKE 1081) |
| `fts_match('turso')` | 0 | **138** (LIKE 139) |
| `fts_match('backlog')` | 0 | **84** (LIKE 83) |
| `_adapter_meta` duplicate keys | 3 keys ×2 | **none** (5 rows total) |

`memory_recall` independently confirms it — results now carry `"provenance":["fts"]` with non-zero BM25 contributions, where BM25 was previously 0.

**So the store is healthy and the status surface says it is damaged.**

**Why this is HIGH and not cosmetic.** This is precisely the failure the engine's own author warned about while fixing an earlier instance of it: *"A verdict that can never return to ok after a correct repair trains operators to ignore it."* An always-damaged verdict is worse than no verdict — it is a permanent false alarm on the one surface built to make silent damage visible, and it will be tuned out exactly like BL-360's unconditional message.

Note a **prior, distinct cause of the same symptom was already fixed** in `0d2d629` (page-accounting `Page N: never used` messages counted as damage after a `DROP INDEX`). This is therefore **the second cause of an identical symptom**, and the acceptance below must cover the general property, not this instance.

**Fix sketch:** find why reverify disagrees with ground truth — likely another benign-message class, or reverify reading state cached from the pre-repair pass rather than re-querying. Then assert the general invariant: **after a repair whose actions all report `ok: true`, reverification must agree with a direct ground-truth probe.**

**Acceptance (red→green, must name BL-374):** damage both artifacts, open through the normal adapter path with repair enabled, and assert `repair.ok === true`, `reverified === "ok"`, `overall === "repaired"`, `healthy === true` — cross-checked against direct `fts_match` and duplicate-key queries in the same test. Must fail today.

**Severity:** HIGH — the status surface reports a false alarm it cannot clear, on the exact signal built to stop silent damage going unnoticed.

**Related:** BL-352 (the engine), BL-334 (the surface), BL-360 (unconditional false positive — same "trains operators to ignore it" outcome), BL-347.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: live memory_ping integrity block 2026-07-31T22:50:11Z, 2: direct fts_match/_adapter_meta ground-truth probe immediately after, 3: memory_recall returning provenance:["fts"] with non-zero bm25, 4: commit 0d2d629 (the earlier, distinct cause)]


**ROOT-CAUSED AND FIXED IN SOURCE 2026-07-31 (database-administrator, commit `8fe0571`). Stays OPEN until deployed — the live service still runs the old bundle, so the false alarm is still firing.**

**It was not reverify, and it was not a benign-message class. The probe itself manufactured the miss.** `pickSentinelToken` matched `/[A-Za-z][A-Za-z]{5,19}/`, which caps at 20 characters and therefore **silently truncates any longer letter run**. Live row 9478 contains `sharedFastembedProcess` (22 letters); the probe extracted **`sharedFastembedProce`**, a 20-character fragment that is not a term in any tokenizer. `fts_match` correctly returned nothing, and the row was reported unindexed on a perfectly healthy index — **deterministically**, which is exactly why the repair could not clear it.

Read back from the store's own persisted verdict (`_adapter_meta.last_integrity`, the durable record added for BL-334), the failing pass says:
```
verify.depth: deep | PRE damaged: fts_index_live/idx_fts_node
repair.ok: false | actions: idx_fts_node=true(361.5ms)
POST damaged: 1/3 sentinel rows (rowid 9478) … NOT matchable
```
and rowid 9478 (`t_created` 2026-07-31T20:19:53Z, three hours before the pass) **is matchable now** with an ordinary token — confirming the index was never the problem.

**Quantified on the live store, 400 consecutive rows against a known-good index:**

| probe | false misses |
|---|---|
| truncating single token (shipped) | **29 / 400 = 7.3 %** |
| whole-word, up to 3 candidates (fix) | **0 / 400** |

At three sampled rows per pass that is roughly a **1-in-5 chance of a spurious `DAMAGED` on every open** — matching the observed behaviour.

**Fix — structural, not another filter:**
1. Tokens must be **complete letter runs** (`(?<![A-Za-z])[A-Za-z]{6,20}(?![A-Za-z])`), so a 22-letter identifier is not a candidate rather than being chopped into a non-word.
2. A row counts as indexed if **any** of up to three of its own tokens round-trips. One token is not enough evidence to condemn an index — tokenizers legitimately drop or re-split individual terms.

**The general invariant is asserted, per this item's acceptance:** a test damages both artifacts, repairs through the normal path, and asserts `repair.ok === true`, `reverified.damaged === []`, `overall === 'repaired'`, `healthy === true` — cross-checked against direct `fts_match` and duplicate-key queries **in the same test**, so it cannot pass on a summariser that merely agrees with itself.

**Red→green (names BL-374):** three tests fail with the truncating picker restored, pass with the fix. Verified on the live store copy: **0 spurious verdicts across 20 consecutive passes**, fast and deep both clean (21/22 findings, 0 damaged, 0 unknown).

Citations: [wip/turso-live-metrics, database-administrator, claude, BL-374, 5: libs/data/store/store-adapter/src/integrity.ts (pickSentinelTokens, probeFtsIndexes), 6: libs/data/store/store-adapter/src/__tests__/integrity-selfheal.test.ts (BL-374 describe), 7: `_adapter_meta.last_integrity` read from a copy of `~/.memory/memory.db` 2026-07-31, 8: 400-row false-miss measurement against the live index]

---

### BL-376 — One 180 s budget covers both a network download and a cached local load, so it can never detect a regression — **Open (MEDIUM)** (2026-07-31)

**Driver.** `warmupTimeoutMs()` (`libs/data/embed/embedding-provider/src/index.ts:261-264`) defaults to **180 000 ms** and bounds two very different operations through one number — the outer `createFastembedProvider()` wrapper around `embedSingle('warmup')`, and the inner `FastembedProvider` worker-init `readyPromise` that bounds the actual ONNX model load.

Measured model-init cost with the model **already cached** on disk (`~/.cache/sox/models/fast-bge-base-en-v1.5/model_optimized.onnx`):

| scheduling class | model init |
|---|---|
| normal (pri 31/20) | **642 / 686 / 686 ms** |
| background (pri 4) | **8176 / 12012 / 9447 ms** |

So the steady-state cost is **~650 ms** and the budget is **277x** that.

**The number is not obviously wrong for what it was written for.** Its own comment states it bounds *"a cold ONNX model download"* — a first-ever run pulling weights over the network, which is legitimately slow and legitimately hard to bound. The defect is that **one budget covers both that and a cached local load**, and the two differ by roughly three orders of magnitude.

**The consequence is the part that matters: this instrument cannot fail informatively.** BL-331's 14x model-load regression (650 ms → ~10 s) sat comfortably inside the 180 s budget for the entire incident. It did not time out, did not warn, and produced no signal in status. It merely looked slow to a human, eventually, if anyone happened to be watching. **A budget that generous is indistinguishable from no budget at all** for any regression short of a total hang — the same failure family as BL-347 (a probe that reads 0 whether the index is dead or healthy) and BL-319 (`time_to_vector_ms` populated on one of two paths).

**Why it survived:** the QoS defect lives in `os-unit.ts` and affects **launchd-spawned processes only**. Anyone developing the embedding provider ran it from a terminal at pri 31 and saw ~650 ms. There was no reason to suspect anything, and no gate that would have told them. This reinforces BL-331's acceptance note — **a benchmark must run under the service's actual scheduling policy**, or it passes throughout an incident and proves nothing.

**Fix sketch:** split the budget by what is actually being bounded — a generous download budget on cache-miss, and a **tight** load budget (single-digit seconds) once the model is on disk. Emit the measured init duration into status (BL-334) rather than only failing at the boundary, so a 14x regression is visible as a number long before it is visible as a timeout. Cache-presence is already determinable at the call site.

**Acceptance (red→green, must name BL-376):** with the model cached, artificially slow model init to ~10 s and assert the warmup path **reports** the regression (status field or warning), rather than silently succeeding inside the budget. Must fail today.

**Severity:** MEDIUM — no outage on its own, but it is the reason a 14x live regression ran unnoticed, and the same blindness applies to any future one.

**Related:** BL-331 (the regression it failed to catch), BL-334 (surface the measurement), BL-319 / BL-347 (same failure family — a signal indistinguishable from normal), BL-282 (three separate model cache dirs exist on this machine, which is its own hazard).

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: libs/data/embed/embedding-provider/src/index.ts:250-264, 2: BL-331 interleaved A/B model-init measurements 2026-07-31, 3: live `find ~/.cache -name model_optimized.onnx` confirming the model is cached locally]

---

### BL-378 — The two emergency brakes are not independent: `SOX_DISABLE_PERIODIC_ENRICH` silently subsumes `SOX_DISABLE_EMBED_HEAL` — **Open (MEDIUM)** (2026-07-31)

**Driver.** Both brakes were documented and operated as independent switches — BL-339 (`SOX_DISABLE_EMBED_HEAL`) and BL-346 (`SOX_DISABLE_PERIODIC_ENRICH`). They are not. The call chain is strictly nested:

```
scheduleNextEnrichTick()          index.ts:2265  ← returns EARLY if SOX_DISABLE_PERIODIC_ENRICH=1
  └─ runPeriodicEnrichPassGuarded()      :2204
       └─ runEnrichPassOnDb()            :2130
            └─ healMissingVectors()      :2086   ← the ONLY production caller
```

`healMissingVectors` has **no other production call site**. So with `SOX_DISABLE_PERIODIC_ENRICH=1` set, clearing `SOX_DISABLE_EMBED_HEAL` **does nothing at all** — the tick that would have called heal never fires.

**Measured, on the live service.** After lifting the embed-heal brake alone and redeploying (verified: brake absent from the running process, pri 20, correct parenting), vector coverage was sampled three times over 90 s:

```
23:25:49  nodes 9488  vectors 1685  17.8%
23:26:34  nodes 9488  vectors 1685  17.8%
23:27:19  nodes 9488  vectors 1685  17.8%
```

Flat. Zero drain. The operator-visible state was "embed heal is enabled" and the actual state was "nothing can run."

**Why this matters beyond the inconvenience.** Restoring a degraded service is exactly when an operator reasons about brakes, and this pair reasons **wrongly**: lifting the brake you believe is blocking backfill produces no error, no warning, and no change — indistinguishable from "backfill is enabled but there is nothing to do." Recovery time is spent looking in the wrong place. Same failure family as BL-347 and BL-376: **an action whose no-op is indistinguishable from success.**

It also makes the brakes coarser than advertised. BL-346's own comment concedes the design problem — *"a flag is whack-a-mole across every background job that exists or ever will"* — and this is that prediction arriving: the flags do not partition the background work they claim to.

**Fix sketch:** either (a) give `healMissingVectors` a scheduling path independent of the enrich tick so the brakes genuinely separate, or (b) collapse them into one honest switch and delete the illusion of independence. Whichever is chosen, **the status surface must report which background jobs are actually running** (BL-334) rather than leaving an operator to infer it from env vars — that is the real fix, and the flags are the stopgap BL-346 already admits they are. Supersedes both brakes if BL-345's resource-governance lane lands.

**Acceptance (red→green, must name BL-378):** with `SOX_DISABLE_PERIODIC_ENRICH=1` and `SOX_DISABLE_EMBED_HEAL` unset, assert either that heal runs, or that the service **reports** heal as disabled-by-dependency. Silently doing nothing must fail the test.

**Severity:** MEDIUM — no data loss, but it costs recovery time at precisely the wrong moment, and it means neither brake's documented behaviour is accurate.

**Related:** BL-339, BL-346 (the two brakes), BL-345 (any in-process background job starves foreground reads — the reason they exist), BL-334 (report what is actually running), BL-376 / BL-347 (same family: a no-op indistinguishable from success).

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:2086,2130,2204,2265-2274, 2: live vector-coverage samples 23:25:49–23:27:19Z with the heal brake lifted and the enrich brake retained]

---

### BL-380 — `(adapter as SqliteAdapter).unwrap()` is an unchecked cast through the storage abstraction, and it is still live in two packages — **Open (HIGH)** (2026-07-31)

**Driver.** BL-377 fixed two call sites that cast a `StoreAdapter` to `SqliteAdapter` and called `unwrap()` to reach the raw `better-sqlite3` handle. **The pattern was never audited, and it is still present in six more production sites:**

| file | sites | form |
|---|---|---|
| `libs/data/vectors/vector-store/src/index.ts` | **143, 200, 359** | `(adapter as SqliteAdapter).unwrap()` |
| `extensions/bundles/sox-memory-bundle/members/memory-cli/src/index.ts` | **180, 218, 322** | `(adapter as any).unwrap()` — casts through `any`, so even the assertion is gone |

**Why the cast is the defect, not the symptom.** `as` is an *assertion*: it silences the compiler without checking anything. On sqlite the handle's `.prepare().all()` is **synchronous and returns an array**; on Turso it is **async and returns a Promise**. So the cast compiles, the call succeeds, and the result is a Promise that the caller iterates as if it were rows — `TypeError: episodes is not iterable`, at runtime, on the **default backend**. The type system was capable of catching this and was explicitly told not to.

**Turso is the default.** Every one of these paths is therefore suspect on the backend the system actually runs, exactly as BL-377 proved for export and re-embed — which had been broken since the migration while everyone read the failures as test debt.

**Strong candidate root cause for BL-364.** `SqliteVectorBackend` crashes with `Cannot read properties of undefined (reading 'nativeVectors')`, taking out **15 `hybrid-search` integration tests** — that package's entire real FTS5+vector coverage, red for four days behind green-looking sweeps. `vector-store/src/index.ts` holds three of these casts. **Verify before assuming**, but the shapes match.

**The architectural question, which is the real one:** *why does a caller need the raw handle at all?* `StoreAdapter` exists precisely so callers do not know or care which engine is underneath. Every `unwrap()` is either (a) a **capability gap** — the adapter does not expose something a legitimate caller needs, which is a missing method, or (b) a caller **reaching around** the abstraction for convenience. Both are fixable; neither is fixed by a cast. BL-377's fix took route (b) → converted to `executeAll`/`executeGet`/`executeRun` and the cast disappeared.

**Legitimate uses that must NOT be swept up in a blanket change:**
- `db.ts:373,896` — loading the `sqlite-vec` extension, correctly **gated on `adapter.capabilities`**. The codebase already knew the pattern; the broken sites simply skipped the guard.
- `backup.ts:171,202` — explicitly `createSqliteAdapter(...)`, i.e. deliberately sqlite-only. **But this raises its own open question, flagged by BL-377 and still unanswered: can a Turso store be backed up at all?**
- `migration.ts:272,587` — sqlite-side of a migration; engine-specific by nature.

**Fix sketch:**
1. Audit all six sites. For each, decide **capability gap** or **reaching around**, and say which in the commit.
2. Convert reach-arounds to the async adapter API (BL-377's pattern). For genuine capability gaps, **add the method to `StoreAdapter`** rather than widening the cast.
3. Make `unwrap()` impossible to misuse: require a capability check, or return a discriminated union the caller must narrow. **A lint rule banning `as SqliteAdapter` and `(x as any).unwrap()` outside the adapter package** is the cheap structural guard — the codebase already demonstrates the correct gated form, so the rule encodes existing practice.

**Acceptance (red→green, must name BL-380):** exercise each converted path against a **Turso** store and assert it works; the guard must reject a newly-introduced unguarded cast. Must fail today for the `vector-store` and `memory-cli` sites.

**Severity:** HIGH — six unchecked casts on the default backend, one of which is the likely cause of 15 permanently-red integration tests. The class already shipped one silent production breakage (BL-377) that went undetected for weeks because its failures were misread as test debt.

**Numbering note:** committed in `dd7a37a` whose message says "BL-379" — that id was claimed concurrently by another agent between my read and my write. This item is **BL-380**; references to BL-379 in `dd7a37a`'s message mean this one. Fourth id collision today — see BL-359.

**Related:** BL-377 (the first two sites, fixed), BL-364 (15 hybrid-search tests — likely the same cause), BL-291 (typed native-open errors across SQLite-backed packages), BL-340 (specs were never typechecked, which is how this class hides).

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: repo-wide audit of `as SqliteAdapter` / `.unwrap()` excluding specs, 2026-07-31, 2: libs/data/vectors/vector-store/src/index.ts:143,200,359, 3: extensions/bundles/sox-memory-bundle/members/memory-cli/src/index.ts:180,218,322, 4: BL-377, 5: libs/memory-core/src/db.ts:373 (the correctly-gated form)]

---

### BL-381 — Near-duplicate detection issues a sqlite-vec `vec0` KNN query against Turso and fails on every call — **Open (HIGH)** (2026-07-31)

**Driver.** `libs/memory-core/src/neardup.ts:46` issues, unconditionally:

```sql
SELECT node_id, embedding
  FROM vec_node
 WHERE embedding MATCH ? AND k = ?
```

`MATCH ... AND k = ?` is **sqlite-vec `vec0` KNN syntax**. Turso stores vectors as a native `F32_BLOB` column with no `vec0` virtual table and no `k` pseudo-column, so the statement fails at prepare time:

```
prepare failed: Parse error: no such column: k     adapter_type: turso
```

**Observed live, on the default backend, today.** Three occurrences at 23:34:01 under a single trace-id (`01KYX8E2SSD7HG94DZ62M3FP7Y`) from the running memory-server (pid 69947) during the first enrich pass after the brakes were lifted. The event catalog in `docs/observability/README.md` already shows `embed_pipeline.neardup.error` firing 10 times historically — **the signal has been in the telemetry since the migration and nobody read it** (BL-353).

**Why it went unnoticed: the enrich pass catches and continues.** `embed_pipeline.neardup.error` is logged and the pass proceeds, so near-duplicate detection has been **silently non-functional on Turso** while every surface reported healthy. No user-visible error, no status field, no failed write — just a feature that quietly does nothing. `memory_near_duplicates` and any supersession logic depending on it are affected.

**Same class as BL-377 and BL-380: sqlite-only code reaching the default backend.** Unlike those two this is not a cast — it is a hardcoded SQL *dialect*. The codebase already has the correct abstraction for exactly this: `VectorDialect` in `@adhd/sox-store-adapter`, the sibling of the `FTSDialect` introduced for the same reason during the migration. `neardup.ts` bypasses it.

This is the fourth distinct instance today of *the same underlying failure*: a sqlite-shaped assumption surviving the Turso migration because nothing typechecked or exercised it on the default backend (BL-377 export/re-embed, BL-380 six unchecked casts, BL-364's inverted constructor, and this). **The pattern is worth a systematic sweep, not four point fixes** — see the fix sketch.

**Fix sketch:**
1. Route the KNN query through `VectorDialect` so the Turso path emits its native distance syntax and the sqlite path keeps `vec0`. The dialect already exists; this is a missing call site, not new design.
2. **Do not let it fail silently.** A caught-and-continued error on a feature path must surface in status (BL-334) or it is indistinguishable from "no duplicates found" — the same shape as BL-347, BL-376 and BL-378.
3. **Sweep for remaining sqlite-only SQL** reaching the adapter — `vec0`/`MATCH`/`k =`/`fts5`/`rank` literals outside a dialect. That sweep is the systematic version of the four point fixes and is the actual deliverable.

**Acceptance (red→green, must name BL-381):** call the near-duplicate path against a **Turso** store with known near-duplicate content and assert duplicates are returned. Must fail today with `no such column: k`. A second assertion must prove the failure is **reported** rather than swallowed.

**Severity:** HIGH — a shipped feature has been silently non-functional on the default backend since the migration, and the error was in the telemetry the whole time.

**Related:** BL-377 (export/re-embed, same class, fixed), BL-380 (six unchecked casts), BL-364 (inverted constructor), BL-353 (the telemetry nobody read), BL-334 (surface it), BL-327 (supersession/communities depend on this path).

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: libs/memory-core/src/neardup.ts:46, 2: live store.error pid 69947 trace 01KYX8E2SSD7HG94DZ62M3FP7Y at 2026-07-31T23:34:01Z, 3: docs/observability/README.md event catalog (`embed_pipeline.neardup.error` ×10), 4: libs/data/store/store-adapter (VectorDialect, the abstraction being bypassed)]

---

### BL-382 — Writes do not wake the drain: work waits up to 5 minutes for a timer that was sized for a 6.9s embed — **Open (HIGH)** (2026-07-31)

**Driver.** `scheduleNextEnrichTick()` is invoked in exactly two places — once at module load (`index.ts:2279`) and once in the pass's own `.finally()` (`:2274`). **There is no write-triggered path.** A write that needs embedding waits for a 5-minute timer (`PERIODIC_ENRICH_INTERVAL_MS`), then competes for the per-tick heal budget.

**The interval was sized for a defect that no longer exists.** At the pre-BL-331 rate of ~6.9s per embed, batching on a 5-minute cadence was reasonable — per-write processing could never have kept up. At the post-fix rate of **451ms p50** the design is inverted: the queue idles for minutes while work waits, then bursts.

**Measured live, 2026-07-31, with both brakes lifted:**

| time | vectors | note |
|---|---|---|
| 23:34 | 1685 → 2105 | first pass: **420 embeds**, then stops on the tick budget |
| 23:38 – 23:46 | **2105, flat** | backend at **0.3% CPU** with **3,199 items pending** |
| 23:46 | 2157 | next tick fires |

So the machine sat effectively idle for five minutes with thousands of items queued and ~19x the throughput now available. **Sustained end-to-end drain, measured over 25.8 minutes with both brakes off: 0.45/s** (+701 vectors, 1685 → 2386). In-burst is ~1.7/s. **The idle gaps dominate by roughly 4x** — the machine spends most of the window doing nothing while thousands of items wait.

Three different rates were quoted during this investigation before the honest one was measured — 1.7/s (in-burst), 1.4/s (estimated over one cycle), and finally **0.45/s (actual, over 25.8 min)**. Only the last is a throughput figure; the first two are instantaneous rates generalised into steady-state claims. **That is the same error as BL-331's original "18x" framing**, repeated within hours of documenting it. Any future rate claim here must state its measurement window.

At 0.45/s the remaining ~3,199-item embed backlog takes **~2 hours**. At the in-burst rate it would be ~30 minutes. The difference is entirely scheduling latency.

**Second-order effect on latency, not just throughput:** a freshly written episode is unsearchable by vector until the next tick. Worst case is the full interval plus queue position. Nothing reports this delay, so it is indistinguishable from an embedding that failed.

**Fix sketch — wake, do not poll:**
1. A write enqueues **and wakes** the drain. Debounced and coalescing: N rapid writes must not schedule N passes (the BL-154 re-entrancy lesson and the BL-346 stampede both apply).
2. Keep the periodic tick as a **floor**, not the only trigger — it still catches work enqueued by paths that do not wake it, and it is the recovery path after a restart.
3. **This is not per-write clustering.** Association is BL-349 and maintenance is BL-350; both are separate and neither is solved by waking the queue. Scope this to the drain only.
4. Re-derive the interval and the per-tick budget from the *current* embed cost rather than inheriting numbers chosen when an embed took 6.9s. Both are now unjustified constants.

**Acceptance (red→green, must name BL-382):** write an episode to an idle store and assert its vector is present in well under the tick interval; assert N rapid writes produce one coalesced pass, not N. Must fail today, where the vector appears only after the next timer fires.

**Severity:** HIGH — not a correctness bug, but it wastes the entire BL-331 performance recovery on scheduling latency and leaves fresh writes unsearchable for minutes with no signal.

**Related:** BL-331 (the fix that inverted the tradeoff), BL-378 (the brakes gating this same tick), BL-349/BL-350 (clustering — explicitly *not* in scope), BL-345 (any background job starves foreground reads — the wake must respect that), BL-154 (re-entrancy: never enqueue from inside a task on the same queue).

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:2265-2279 (the only two scheduleNextEnrichTick call sites), 2: :1928 (PERIODIC_ENRICH_INTERVAL_MS), 3: live vector-coverage samples 23:34-23:46Z with both brakes off, 4: BL-331 (451ms p50 post-fix)]

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

**Acceptance (red→green, must name BL-338):** a crash-recovery test — SIGKILL the server under sustained write load, restart, assert (a) zero lost committed writes, (b) `integrity_check` clean or auto-repaired to clean **after filtering BL-360's unconditional Tantivy false positive** (a literally-clean result is unreachable on this backend), (c) the damage and repair both visible in status/logs without human investigation.

**Note on (c) — BL-365 constrains what this test can even observe.** The telemetry sink buffers in userspace and loses everything unflushed on SIGKILL (measured: 0 of 10,000 records survived). So a crash-recovery test that asserts on log evidence is asserting against a sink that drops precisely the pre-crash window. **BL-365 must land before this acceptance is meaningful** — otherwise (c) passes or fails for reasons unrelated to crash recovery. This is not hypothetical: the host lost power mid-backfill on 2026-07-30 and that window is simply gone.

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

**⚠️ UPDATE 2026-07-31 (same day): the mitigation was measured insufficient, twice, for two different reasons — do not treat this item as "handled" by the env var alone.**
- First: setting `SOX_DISABLE_EMBED_HEAL` on the launchd unit had **zero effect** on the live symptom for an extended window, because the var never reached the backend process at all — a six-copy duplicated env-scrub allowlist across two packages silently dropped it with no warning. Filed separately as **BL-344** (the general defect; also verifies several other shipped tunables are equally non-functional in production today).
- Second: once the var WAS confirmed reaching the backend (`SOX_DISABLE_EMBED_HEAL=1` verified via `ps eww` against the live pid) and the heal pass was genuinely off, reads **still hung** — this time because the periodic batch-enrichment/clustering tick (BL-162) starves reads through the identical mechanism, independent of the embed backfill. Filed separately as **BL-345**, which generalizes re-enable criterion #2 above from "inferred architectural gap" to "measured live-system defect, and it is not specific to the embed backfill."
- **Practical consequence:** re-enable criterion #2 cannot be satisfied by disabling background jobs one at a time as they're discovered (BL-345 explains why). This item stays open pending BL-345's resource-governance fix, not merely pending BL-331.

**Until then:** the backlog does not drain. Any measurement of vector coverage or recall quality must state that the backfill is disabled. Any claim that "reads are restored" for this store must be verified end-to-end against the live process (`ps eww <pid> | grep SOX_DISABLE`, then a real tool call with raw output) — verifying the generated `.plist` or launchd unit config is NOT sufficient and produced a false green during this same incident (see BL-344).

**Acceptance (red→green, must name BL-339):** with the heal pass ENABLED and a full backlog, assert `memory_ping` and `memory_topics` respond within a sane budget (single-digit seconds) throughout. That test failing today is the whole reason this mitigation exists.

**Severity:** HIGH — an intentional, load-bearing degradation of the live system. Must not become permanent by neglect.

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts (SOX_DISABLE_EMBED_HEAL), 2: libs/memory-core/src/embed-pipeline.ts (heal pass + time budget), 3: BL-331, 4: BL-334, 5: BL-344, 6: BL-345]

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


**UPDATE 2026-07-31 (database-administrator) — Turso DOES implement `integrity_check`, and it lies in a specific, permanent way.**

Measured on a copy of the live 43 MB store: `PRAGMA integrity_check` runs in **299 ms** and returns real, actionable findings (`row 4 missing from index sqlite_autoindex__adapter_meta_1`, …); `PRAGMA quick_check` runs in 79 ms with a subset. So the "Turso equivalent unverified" question is answered: it exists and it works.

**But it emits `wrong # of entries in index __turso_internal_fts_dir_<idx>_key` unconditionally on any store carrying a Turso FTS index — including a freshly created one whose `fts_match` returns 200/200.** Any repair loop or health gate that treats `integrity_check` as pass/fail on such a store reports damage forever and will never converge. Filed separately; the filter now lives in `integrity.ts`'s `isKnownFalsePositive()`.

**Second correction:** page-accounting messages (`Page N: never used`, `Page N referenced multiple times`) are **not** index damage — they are free-space leakage, typically left behind by a `DROP`, and no `REINDEX` addresses them. A repair loop that groups them with index findings will spin. The shipped probe classifies them under a distinct `page_accounting` object, marks them non-repairable, and names `VACUUM` as the (offline) remedy. The live copy carries 45 such pages.

The 100-message cap is handled: the shipped probe flags `capped` when it sees ≥100 messages and says so in the finding text rather than reporting the count as a total.

Citations: [wip/turso-live-metrics, database-administrator, claude, sandbox P0.7, 3: integrity_check/quick_check timing and output against a copy of `~/.memory/memory.db` 2026-07-31, 4: integrity_check against a freshly built 200-row Turso FTS store 2026-07-31, 5: libs/data/store/store-adapter/src/integrity.ts (probeIntegrityCheck, isKnownFalsePositive)]

---

### BL-342 — Restore wrote empty-string JSON columns instead of NULL; the column that actually breaks `memory_stats` is `enrich_ver`, not `tags` — **Open (HIGH)** (2026-07-31)

> **⚠️ ROOT CAUSE CORRECTED 2026-07-31 (`p0-test-infra`) — read this before repairing anything.**
> This item's original title and body assert that `tags = ''` breaks `memory_stats`. **It does not.**
> Measured with a per-column fixture (`libs/memory-core/src/stats-bl343-row-resilience.spec.ts`):
> a store containing a `tags = ''` row returns stats normally, because `with_tags` only tests
> `tags IS NOT NULL` (`stats.ts:98`) and never parses the value. A store containing an
> `enrich_ver = ''` row fails with the **verbatim live error**:
> ```
> Error: step failed: Parse error: malformed JSON
>   ❯ memoryGetStats libs/memory-core/src/stats.ts:120:21
> ```
> `stats.ts:120` is the `legacy_episodes` query — `json_extract(enrich_ver, '$.note')`. That is the
> reported line in every trace of this defect, including the 2026-07-31 reconfirmation below.
> **Repairing only `tags` on the live store would leave `memory_stats` dead while appearing to fix
> it.** Any repair must normalise every JSON-typed column — at minimum `enrich_ver`, `tags`, `meta`.
> The live `json_valid(tags)=0` sweep quoted below is real, but it found a *different* bad row than
> the one taking the tool down; a `json_valid(enrich_ver)=0` sweep was never run.
>
> The tool-outage half is now fixed independently (BL-343, resolved — `memory_stats` no longer dies
> on any malformed row, and reports `malformed_rows: { count, columns, sample_rowids }`). **Run
> `memory_stats` on the live store and read `malformed_rows` to get the real column list and rowids
> before repairing** — that field exists precisely so this no longer needs a bespoke sweep.
> This item remains open for the two defects below: the restore path not normalising, and the
> absent schema guard. Per the owner directive, the data repair belongs in the adapter's
> verify-and-repair path (BL-352), never a manual write to `~/.memory/*`.

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

**Severity:** HIGH — a single malformed row of 9397 disables an entire tool on the live store. Related: BL-335 (the same restore also left secondary indexes unpopulated).

Citations: [wip/turso-live-metrics, team-lead, claude, turso-go-live, 1: live `memory_stats` error 2026-07-31, 2: live `json_valid(tags)=0` query output, 3: ~/.adhd/sox-ecosystem/memory/corrections-20260730/dbrepair/restore.mjs]


**RECONFIRMED LIVE 2026-07-31 (database-administrator).** Still reproducing on a fresh copy of `~/.memory/memory.db`: `handleToolCall('memory_stats')` throws `step failed: Parse error: malformed JSON` from `libs/memory-core/src/stats.ts:120` via `TursoAdapterImpl.executeGet`. Unfixed.

**New consequence worth recording:** `memory_stats` now carries the BL-334 integrity block, so this one malformed row makes the **store-health verdict unreachable** through that tool on the live store — not merely the coverage percentages. `memory_ping` is unaffected and remains the working path for the integrity verdict. This raises the practical cost of BL-342/BL-343: row-level resilience is now load-bearing for a health surface, not just for statistics.

Citations: [wip/turso-live-metrics, database-administrator, claude, sandbox P0.7, 4: handleToolCall('memory_stats') stack trace against a copy of `~/.memory/memory.db` 2026-07-31, 5: libs/memory-core/src/stats.ts:120]

---

### BL-345 — BL-339's mitigation does not achieve its stated goal: ANY in-process background job starves foreground reads identically, not just the embed backfill — **Open (HIGH)** (2026-07-31)

**Driver:** BL-339 disabled the embed-heal backfill (`SOX_DISABLE_EMBED_HEAL=1`) on the theory that it was the specific cause of read unavailability. Live measurement after that mitigation was correctly deployed proved the theory too narrow: with the heal pass CONFIRMED disabled (`SOX_DISABLE_EMBED_HEAL=1` verified present in the running backend's actual env via `ps eww`), CPU at 17.8% (not compute-saturated), and machine load at 8.78 (not the elevated multi-agent load seen earlier in this same incident — ruled out as a confound), `memory_ping` still hung for 40s+, and the backend log showed `[memory-server] enrich.tick.start tick_seq=1` with no matching `.finish` — the periodic incremental-clustering/batch-enrichment tick (BL-162, in-process, synchronous better-sqlite3/turso calls) was starving reads through the exact same mechanism, independent of the embed backfill.

This was corroborated independently: `memory_ping` observed hanging past 180s with zero concurrent load from any test, pid alive throughout (not crashed), CPU oscillating 2-53% in bursts, WAL bytes static (ruling out fresh-write volume as the driver) — consistent with a single long-running synchronous CPU-bound pass with no yield point, matching the enrich-tick theory.

**The generalization matters more than either specific symptom:** this is not "the embed backfill is heavy" (BL-331) or "the enrichment tick is heavy" — it is that **the memory-server has no concurrency model protecting the foreground request path from ANY in-process background work.** Node's single-threaded event loop means any synchronous, non-yielding pass (embed backfill, clustering, or the next background job someone adds) blocks every read and write handler for its full duration. `SOX_DISABLE_EMBED_HEAL` silenced one instance of this; the underlying defect immediately resurfaced through a different code path with the exact same operator-facing symptom.

**Consequently, adding more `SOX_DISABLE_*` flags is whack-a-mole, not a fix** — it treats each background job as the problem instead of treating "no resource governance over background CPU work" as the problem. This confirms BL-339's own re-enable criterion #2 ("resource governance exists so background enrichment can never again starve foreground reads") as measured fact, not inference, and BL-339 must not be closed by finding and disabling background job #2, #3, etc. one at a time.

**What production-grade requires (not exhaustive, for scoping):**
- A time-budgeted/yieldable execution model for in-process background passes (chunk the work, yield to the event loop between chunks, or move to a worker thread/child process — see the existing recommendation in the BL-322 investigation notes).
- A concurrency/priority mechanism so foreground request handlers are never blocked behind an arbitrary-length background pass, regardless of which background job is running.
- Observability that names which background pass is currently blocking (the `enrich.tick.start`/`.finish` pairing that surfaced this finding is a good start — it should be a standing health-surface field per BL-334, not something read only by grepping logs mid-incident).

**Acceptance (red→green, must name BL-345):** with `SOX_DISABLE_EMBED_HEAL=1` set and the periodic enrichment tick running against a realistic backlog, assert `memory_ping`/`memory_topics` remain responsive (single-digit seconds) throughout a full tick — today this fails, which is the direct evidence for this item.

**Severity:** HIGH — invalidates the completeness of BL-339's mitigation, confirms Gap-2 resource governance as a measured (not inferred) live-system defect, and blocks BL-339's own re-enable criteria from ever being satisfiable by point-fixing individual background jobs.

Citations: [wip/turso-live-metrics, team-lead, claude (mitigate-reads), turso-go-live, 1: live backend log `enrich.tick.start tick_seq=1` with no `.finish`, pid 73540, 2026-07-31, 2: live `ps eww <pid>` confirming SOX_DISABLE_EMBED_HEAL=1 present, 3: live CPU/load measurement (17.8% CPU, load 8.78) during the hang, 4: independent 180s-hang reproduction with zero concurrent test load, pid CPU 2-53% bursting, WAL bytes static, 5: BL-339, 6: BL-334 Gap-2, 7: BL-322 (CPU-bound clustering pass analysis), 8: BL-331]

---

### BL-346 — SECOND TEMPORARY MITIGATION: `SOX_DISABLE_PERIODIC_ENRICH` — enrichment/clustering is OFF and must be re-enabled — **Open (HIGH)** (2026-07-31)

**Filed so a second deliberate degradation cannot become permanent by neglect. Read together with BL-339.**

**What happened:** BL-339 disabled the embed backfill to restore read availability. It worked for as long as it took a *different* background job to run. On 2026-07-31 the live store was read-unavailable for **15+ minutes with ZERO client load** — process alive, holding its UDS socket, CPU oscillating 2-53% in bursts, WAL bytes static (no new writes landing, so not fresh write volume), and **not one request answered**. `SOX_DISABLE_EMBED_HEAL=1` was confirmed present in that process's env (`ps eww -p 73540`), so the embed backfill was NOT the cause. The backend log showed `enrich.tick.start tick_seq=1` with no matching `.finish`.

**The conclusion that matters:** disabling one background job simply handed the starvation to the next one. This was never "the embed backfill is heavy" — **any in-process background work starves every foreground read.** There is no concurrency model, no yield point, no admission control. CPU was 17.8% and machine load was 8.78 at the time of one measurement, so it is neither compute-bound nor host-contention: the event loop is simply not yielding.

**This moves Gap 2 (resource governance) from INFERRED to MEASURED**, and invalidates the fix shape we were heading toward. Adding a `SOX_DISABLE_*` flag per background job is whack-a-mole across every job that exists or ever will.

**What was done:** added `periodicEnrichDisabled()` (mirroring the existing `healDisabled()` pattern) gating `scheduleNextEnrichTick()` in `memory-server/src/index.ts`, plus the env key in all three `apps/sox/src/main.ts` allowlists. Service restarted with BOTH brakes. Verified: reads stable and fast across the 5-minute tick boundary (ping 0s, topics 1s, recall 0s, recall+query 7s at T+90s; CPU 2.0%).

**Cost, stated plainly:** enrichment and clustering NEVER RUN. No new communities, no importance updates, no `relates_to` edges, and no clustering (already inert per BL-326/327 regardless). Combined with BL-339, the store is now **read/write only** — vector coverage frozen at ~36%, enrichment frozen entirely. Availability over completeness, deliberately.

**Re-enable criteria — same as BL-339 plus:**
1. Resource governance exists (Gap 2): background work bounded, yielding, and unable to starve foreground reads regardless of which job it is.
2. Verified with BOTH brakes released: reads responsive in single-digit seconds while enrichment AND the embed backfill run.
3. The per-job disable flags should then be REMOVED, not left as permanent API — they are scaffolding, not design.

**Acceptance (red→green, must name BL-346):** with enrichment enabled and a real backlog, assert `memory_ping`/`memory_topics` stay responsive throughout a full tick. That test failing today is the entire reason both mitigations exist.

**Severity:** HIGH — second load-bearing degradation of the live system in 24h, same root cause, different trigger.

Citations: [wip/turso-live-metrics, team-lead+mitigate-reads, claude, turso-go-live, 1: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts (scheduleNextEnrichTick / periodicEnrichDisabled), 2: live outage observation 12:27-12:42 2026-07-31, 3: BL-339, 4: BL-331, 5: docs/ideas/themes-2-4-architecture.md Gap 2]

---

### BL-356 — A fixed global cosine threshold is not calibratable: single-linkage chaining makes the correct τ a function of corpus size — **Open (HIGH)** (2026-07-31)

**Driver.** Measured 2026-07-31 (sandbox P0.5, BL-328). Clustering resolves a hard-coded constant, `resolveDefaultThreshold() → 0.82`,[1] and hands it to DBSCAN with `epsilon = 1 − τ` and **`minPts = minClusterSize = 2`**,[2][3] which is single-linkage in all but name. A threshold fixes the *edge probability* between any two vectors; with a fixed probability, **mean node degree grows linearly with N**, and above degree ≈1 the graph percolates into one giant component. So the τ that clusters a corpus correctly at N=200 collapses it at N=1200 — on identical content.

**Measured, not projected.** Sub-sampling the live store's own 1616 production `vec_node` vectors at increasing N, fixed τ, deterministic spacing:[4]

| N | largest-cluster ratio @ τ=0.82 | @ τ=0.87 |
|---|---|---|
| 200 | 0.0850 | 0.0300 |
| 400 | 0.2225 | 0.0275 |
| 800 | 0.4587 | 0.0475 |
| 1200 | **0.5950** | 0.1850 |
| 1616 | **0.6838** | 0.2073 |

Measured edge probability projected to full store size (`vec_node` covers 1616 of 4841 eligible episodes today, so density roughly triples as embed coverage completes): mean degree at 4841 is 32.6 at τ=0.82, 12.7 at 0.87, and **5.9 even at τ=0.95** — every candidate threshold above the percolation point. (Random-graph approximation; the real degree distribution is heterogeneous, so treat the exact figures as a trend bound. The direction is measured, not modelled.)

**Consequence for the two mitigations already in the code.**
1. **The degenerate guard is doing the calibration, silently.** `cluster.ts:465-484` retries at `τ + 0.05` while `max_cluster/total > 0.5`, max 3 times. On the live store it fires once and lands on 0.87 — meaning **the production threshold is not 0.82; it is an undocumented corpus-dependent number that no test asserts and no status surface reports.**
2. **The guard can exhaust and accept a still-degenerate result.** Measured on a 24-row real cohort starting at τ=0.65: after 3 retries it stops at 0.80 with `largest_ratio = 0.625 > 0.5` and returns it anyway, because the loop breaks unconditionally at `attempts === 3`.[3] A backstop that silently gives up is worse than one that fails loudly.

**Fix sketch.** Stop shipping a cosine constant. Options, in preference order: (a) target a **mean-degree / edge budget** and solve for τ per pass — density-aware by construction; (b) target a cluster-size distribution (reject any partition whose largest cluster exceeds a stated fraction) and binary-search τ, replacing the 3-retry ladder with a real search; (c) drop `minPts = 2` — single-linkage chaining is the mechanism, and a higher `minPts` or a non-chaining algorithm removes it directly. In every case the **effective** threshold and the resulting size distribution must be reported through the status surface (BL-334), never left implicit.

**Acceptance (red→green, must name BL-356):** a test that clusters ≥1000 real vectors and asserts `largest_cluster_size / total <= 0.5` **without relying on the degenerate guard**, plus a second assertion that the same configuration stays non-degenerate at 2× that corpus size. Against today's code the first fails at τ=0.82 (0.684) and the guard-exhaustion case is reproducible directly.

**Severity:** HIGH — it is the reason clustering quality cannot be fixed by tuning, and it will silently re-break after any tuning as the store grows. This is the threshold-side instance of BL-350's "clusters do not self-reorganize."

**Related:** BL-328 (the calibration measurement), BL-350 (same problem from the maintenance side), BL-349, BL-327, BL-334 (the effective threshold must be reportable).

Citations: [wip/turso-live-metrics, performance-engineer, claude, sandbox P0.5, 1: libs/memory-core/src/cluster.ts:918-920, 2: libs/memory-core/src/cluster.ts:172-183, 3: libs/memory-core/src/cluster.ts:465-484, 4: libs/data/analysis/analysis/src/index.ts:143-180, 5: docs/reporting/memory/sandbox/cluster-calibration.md]

---

### BL-364 — `SqliteVectorBackend` crashes on a raw `better-sqlite3` handle; 15 `hybrid-search` tests are red — **Open (HIGH)** (2026-07-31)

**Driver:** `npx nx test hybrid-search` fails 15/82 with `TypeError: Cannot read properties of undefined (reading 'nativeVectors')` at `vector-store/src/index.ts:197`, reached from `hybrid-search.spec.ts:451`'s `new SqliteVectorBackend(db)`.[1][2]

The constructor was converted to take a `StoreAdapter` during the store-adapter migration (`83cd0b0`, 2026-07-27) and now reads `adapter.capabilities.nativeVectors` — but the callers still pass a raw `better-sqlite3` `Database` handle, on which `.capabilities` is `undefined`.[3] There is no type error because the spec's local `Database.Database` type flows into an `any`-ish parameter position.

Note the expression itself is also suspect: `adapter.capabilities.nativeVectors || true` is unconditionally `true`, so reading the capability at all is pointless — the crash is the only effect it has.[3]

**Blast radius:** every `SqliteSearchBackend` integration test in the package, including the BL-294 vector-channel-isolation suite and the BL-295 `kind:"generic"` end-to-end test. The whole real-FTS5+vector integration surface of `hybrid-search` has been unexercised since 2026-07-27.

**Fix sketch:** either accept both shapes (wrap a raw handle via `createSqliteAdapter(db)`) or require a `StoreAdapter` and update the callers. Given the `|| true`, deleting the capability read is also viable. Update the spec's helper either way.

**Acceptance (red→green, must name BL-364):** `npx nx test hybrid-search` at 82/82, with the 15 currently-failing integration tests executing (not skipped).

**Severity:** HIGH — 15 red tests hiding the package's only real integration coverage, and it survived four days of green-looking sweeps because the failures are inside one project's suite.

**Related:** BL-357 (library builds compiling test files), BL-324/BL-325 (the same class of post-migration spec drift in memory-core).

Citations: [wip/turso-live-metrics, database-administrator, claude, sandbox P0.7, 1: libs/data/search/hybrid-search/src/hybrid-search.spec.ts:449-464, 2: libs/data/vectors/vector-store/src/index.ts:195-200, 3: commit 83cd0b0 (`feat: full store-adapter migration`), 4: `npx nx test hybrid-search` output 2026-07-31]

---

### BL-360 — Turso's `PRAGMA integrity_check` reports a PERMANENT false positive on every store with an FTS index — **Open (MEDIUM)** (2026-07-31)

**Driver:** `PRAGMA integrity_check` on a **freshly created, fully working** Turso FTS store emits:
```
wrong # of entries in index __turso_internal_fts_dir_idx_fts_node_key
```
Measured on a 200-row store built from scratch whose `fts_match` returned **200/200** immediately before and after the check, and again after a close/reopen cycle.[1] It also persists on a store whose FTS index has just been dropped and successfully rebuilt.[2] The message is unconditional, not a signal.

**Why it matters beyond cosmetics:** it makes `integrity_check` unusable as a pass/fail gate on the only backend that ships. Any of the following, as currently specified, would loop or report damage forever on a healthy store:
- BL-335's acceptance — *"assert `integrity_check` is clean afterward"*.
- BL-337's acceptance — *"a repair routine that returns a table with a Tantivy index to a clean `integrity_check`"*.
- BL-341's repair loop, and BL-334's proposed health field.
- `backup.ts`'s post-`VACUUM INTO` integrity check, if it is ever pointed at a Turso store carrying the FTS index.

**Mitigated, not fixed:** `integrity.ts`'s `isKnownFalsePositive()` filters exactly this message shape and nothing else, with a test that fails if Turso stops emitting it.[3] That is a suppression against a driver bug, not a fix.

**Fix sketch:** report upstream to `@tursodatabase/database` with the reproduction; pin the driver version the suppression is valid for; re-test on upgrade. Amend the acceptance criteria of BL-335/BL-337/BL-341 to "clean after filtering the known false positive."

**Acceptance (red→green, must name BL-360):** on a driver version where it is fixed, the guard test flips and the filter is removed.

**Severity:** MEDIUM — no data risk, but it silently invalidates the acceptance criteria of three open HIGH items and would make an automatic repair loop non-convergent.

**Related:** BL-341, BL-335, BL-337, BL-352, BL-347.

Citations: [wip/turso-live-metrics, database-administrator, claude, sandbox P0.7, 1: integrity_check against a freshly built 200-row Turso FTS store, before and after reopen, 2026-07-31, 2: integrity_check after a successful DROP+CREATE rebuild on a copy of `~/.memory/memory.db` 2026-07-31, 3: libs/data/store/store-adapter/src/integrity.ts (`isKnownFalsePositive`) + integrity-selfheal.test.ts]

---

### BL-361 — Turso PANICS and aborts the process when opening a store whose FTS index row has no backing directory table — **Open (MEDIUM)** (2026-07-31)

**Driver:** while building a damage fixture, an `idx_fts_node` row was reinstated into `sqlite_master` (via `writable_schema`) without its `__turso_internal_fts_dir_idx_fts_node` table. The next `connect()` did not throw a catchable error — it **panicked in Rust and killed the Node process**:
```
thread '<unnamed>' panicked at core/vdbe/execute.rs:13189:51:
internal error: entered unreachable code: invalid transaction state for
SetCookie: TransactionState::Read, should be write
```
[1]

**Why it matters:** this is an unrecoverable, uncatchable failure mode reachable from a partially-damaged store — precisely the population BL-338 says must recover automatically. No adapter-level verification can help, because the process dies inside `connect()` before any code runs. A store in this state cannot be opened, diagnosed, or repaired by anything in-process; recovery would need an out-of-process pre-flight or a `better-sqlite3` (`writable_schema=ON`) rescue path.

Whether a crash can produce this state naturally is **unknown** — it was produced deliberately. That question is the load-bearing one and is not answered here.

**Fix sketch:** report upstream (a `panic!` on malformed schema should be an error). Locally: consider a cheap out-of-process schema sanity pre-flight before the first `connect()` on a store flagged as unclean, or a `better-sqlite3` rescue path that can repair `sqlite_master` when Turso cannot open the file at all.

**Acceptance (red→green, must name BL-361):** a store in this state either opens with a catchable error, or is repaired by a pre-flight before `connect()` is attempted.

**Severity:** MEDIUM — deliberate to produce, catastrophic if reachable naturally. Reclassify to HIGH the moment a natural path is found.

**Related:** BL-338 (recovery must be automatic), BL-352, BL-329.

Citations: [wip/turso-live-metrics, database-administrator, claude, sandbox P0.7, 1: reinstated-fts-index-row fixture attempt against @tursodatabase/database@0.7.1, 2026-07-31]

---

### BL-362 — No committable Turso FTS damage fixture: the BL-347 negative control exists only against the live store — **Open (MEDIUM)** (2026-07-31)

**Driver:** BL-352's shipped FTS probe has a red→green negative control on **SQLite FTS5** (damaged deterministically via the fts5 `'delete-all'` command) and a verified detection+repair run against a **copy of the real damaged live store**. It has **no committable fixture that reproduces the damage on Turso**, so CI proves the Turso probe passes on a healthy index but never that it fails on a damaged one — the precise gap BL-167 warns about.

Four recipes were tried and all failed, and the failures are worth keeping:
1. **Delete the Tantivy directory rows.** Turso refuses: `table __turso_internal_fts_dir_idx_fts_node may not be modified`. Via `better-sqlite3` the delete succeeds but affects nothing — the table holds 0 rows in every state (see the BL-347 update).
2. **Repoint the directory table's rootpage at an empty btree** (`writable_schema`). FTS kept working — the content is not read through that table.
3. **Insert rows through a connection without `experimental:['index_method']`.** Blocked loudly: the INSERT itself throws `index method is an experimental feature`. So this is *not* how the live damage happened.
4. **Reinstate the index's `sqlite_master` row without its directory table.** Panics the driver and aborts the process — filed as BL-361.

**Useful by-product:** `better-sqlite3` **can** open a Turso-FTS store if `PRAGMA writable_schema = ON` is set — a plain open fails with `malformed database schema (__turso_internal_fts_dir_idx_fts_node_key) - near "USING": syntax error`, but with the flag it reads and writes `sqlite_master` normally. That is an escape hatch BL-329 currently says does not exist, and it is how every fixture above was attempted.

**Consequence, stated plainly:** the mechanism that actually killed the live index is still **unknown**. BL-347 blames the crash repair skipping `idx_fts_node`, but that explains why it was never *rebuilt*, not why it went empty in the first place — and recipe 3 rules out the most plausible candidate.

**Fix sketch:** find the real mechanism (a torn WAL over the index? a `VACUUM`? the go-live restore path in `~/.adhd/sox-ecosystem/memory/corrections-20260730/dbrepair/restore.mjs`?) and seed *that*. Failing that, ship a small anonymised damaged fixture derived from the live store.

**Acceptance (red→green, must name BL-362):** a committed test that damages a Turso FTS index in-repo and shows the sentinel probe red, then green after adapter repair.

**Severity:** MEDIUM — the probe is verified against real damage today, but nothing stops a future refactor from silently un-verifying the Turso path.

**Related:** BL-347, BL-352, BL-361, BL-329, BL-338.

Citations: [wip/turso-live-metrics, database-administrator, claude, sandbox P0.7, 1: four damage-recipe attempts against @tursodatabase/database@0.7.1 2026-07-31, 2: better-sqlite3 `writable_schema=ON` open of a Turso-FTS store 2026-07-31, 3: libs/data/store/store-adapter/src/__tests__/integrity-selfheal.test.ts]

---

### BL-363 — Stray `doesnt_exist_yet` table in the live store — **Open (LOW)** (2026-07-31)

**Driver:** `sqlite_master` on the live `~/.memory/memory.db` lists a user table named **`doesnt_exist_yet`** alongside the 12 real tables.[1] It is not in any schema DDL in the repo — almost certainly a probe artifact left by a test or a diagnostic session that ran `CREATE TABLE doesnt_exist_yet` against the production store.

**Why it is worth a line:** it is direct evidence that something wrote arbitrary DDL to the live store, and any schema-completeness or drift check that enumerates tables will have to explain it. It also counts against BL-352's premise that everything in the store is adapter-generated.

**Fix sketch:** identify what created it (grep the repo and the BL-320 telemetry for the name) before dropping it — the provenance is more valuable than the cleanup. Do not drop it while the live store is an incident reproduction.

**Acceptance:** provenance identified and recorded; table removed as part of a supported maintenance path, not by hand.

**Severity:** LOW — harmless in itself.

Citations: [wip/turso-live-metrics, database-administrator, claude, sandbox P0.7, 1: `SELECT type,name FROM sqlite_master` against a copy of `~/.memory/memory.db` 2026-07-31]

---

### BL-366 — `memory-server`'s `lint` target never covered its root-level `*.test.ts` files, so no lint rule could ever have caught the frozen-`{skip}` bug there — **RESOLVED** (2026-07-31)

**Found while:** adding the `sox/no-hook-assigned-skip` ESLint guard for the frozen-`{skip}` trap (BL-340's sibling; the trap that made `recall-parity.test.ts` and `heal-backend-agnostic.test.ts` skip on every run since they were written).[1]

**Driver:** `memory-server`'s `lint` target declared exactly one pattern:
```json
"lintFilePatterns": ["extensions/.../memory-server/src/**/*.ts"]
```
But four cross-backend tests live at the **package root**, not under `src/`: `recall-parity.test.ts`, `heal-backend-agnostic.test.ts`, `clustering-e2e.test.ts`, `recall-sqlite.test.ts`, `turso-clean-room.test.ts`.[2] None of them were linted by any target, in any project. `npx nx lint memory-server` reported success while never opening the files.

This is the second independent blind spot on the *same set of files* in one session — BL-340 established that specs are never **typechecked**; this establishes that memory-server's root tests were never **linted** either. Both blind spots covered exactly the two tests whose purpose was to prove the Turso path, which is a large part of why that path shipped unverified.

**Verified by construction, not by inspection:** the new guard flags the pre-fix files at `15ff307^` at `recall-parity.test.ts:139` and `heal-backend-agnostic.test.ts:150` — the exact two lines fixed in `15ff307`. Under the old `lintFilePatterns` those files were never passed to ESLint, so the rule could have existed for a year and still not fired.

**Fix (shipped, `68f9437`):** added `extensions/.../memory-server/*.test.ts` to `lintFilePatterns`. `npx nx lint memory-server --skip-nx-cache` → `Successfully ran target lint for project memory-server`.

**Red→green naming BL-366:** with the root pattern removed, `npx eslint` is never invoked on `recall-parity.test.ts` and the reintroduced frozen-`{skip}` pattern lints clean; with the pattern restored, `sox/no-hook-assigned-skip` reports it. Demonstrated above against the real pre-fix files.

**Follow-up (NOT fixed here, deliberately):** the same audit should be run for every project — any `lintFilePatterns` narrower than the project root can hide files this way. Only `memory-server` was checked, because it is the only project known to keep tests outside `src/`. Filed as the residual scope of this item; do not close that audit on the strength of this one fix.

**Severity:** MEDIUM — no runtime impact, but it silently voids every lint guarantee for the files where the guarantees mattered most.

**Related:** BL-340 (specs never typechecked — the same blind spot, different tool), BL-357 (tests typechecked as library code — the inverse).

Citations: [wip/turso-live-metrics, p0-test-infra, claude, sandbox P0.6, 1: tools/eslint-local/no-hook-assigned-skip.cjs, 2: extensions/bundles/sox-memory-bundle/members/memory-server/project.json (lint target), 3: commit 15ff307 (the frozen-{skip} fix), 4: commit 68f9437 (the guard + lint pattern)]

---

### BL-367 — `recall-parity.test.ts` compared UIDs across two independent stores, so it could never pass; with that corrected, sqlite↔turso recall overlap measures 0.52 against an 0.80 bar — **Open (HIGH)** (2026-07-31)

**Found while:** fixing the frozen-`{skip}` bug (commit `15ff307`) that had prevented this test from executing since it was written. The moment it actually ran, it failed — and the first failure was the test's own fault, not the product's.[1]

**Defect 1 — the test could not pass under any behaviour of either backend (fixed here).** `compareResults` measured parity as the intersection of `RecallResult.uid` sets across a sqlite store and a turso store. But `memoryWrite` mints a fresh `ulid()` per episode (`libs/memory-core/src/write.ts:301`), so two independent stores writing the same 10-episode corpus share **zero** uids by construction.[2] Measured: `avgOverlap` = **0**, i.e. exactly the structural floor, not a backend signal. Corrected to compare on `content`, the identity that actually crosses the store boundary.

This compounds the frozen-`{skip}` finding in the worst way. The conclusion "the Turso path has never been proven end-to-end" is stronger than first recorded: it is not merely that this test never ran — **it would not have proven anything had it run.** There has never been working cross-backend recall-parity coverage.

**Defect 2 — a real divergence, now measurable and NOT fixed (this item).** With the comparison corrected, the same corpus and the same 5 queries produce:

```
AssertionError: expected 0.52 to be greater than or equal to 0.8
  recall-parity.test.ts:230  expect(avgOverlap).toBeGreaterThanOrEqual(0.80)
```

**sqlite and turso return only ~52% overlapping results for identical input.** Both backends return results (the test's `queriesRan > 0` guard passes, and queries where either side returns nothing are skipped), so this is genuine ranking/retrieval divergence, not one backend being empty.

**The threshold was deliberately NOT lowered.** 0.80 is the contract the test was written to assert. Relaxing it to 0.52 would convert a real defect into a green board — the precise failure mode this session exists to eliminate.

**Not yet attributed.** Recall fuses vector + BM25 + temporal. The divergence could be the FTS/BM25 arm (cf. BL-347, live FTS index dead), the vector arm, or score fusion differing across dialects. Attribution needs a per-arm breakdown — run each arm in isolation across both backends before assuming which one diverges. Do not guess this.

**Acceptance (red→green, must name BL-367):** `npx nx test memory-server` → `recall-parity.test.ts` passes at the unmodified 0.80 threshold, with the per-arm attribution recorded in the fix.

**Severity:** HIGH — cross-backend recall parity is the core correctness claim of the Turso migration, it has never actually been tested, and the first honest measurement of it is well below the stated bar.

**Related:** BL-347 (live FTS index dead — a candidate cause), BL-324 (the memory-server failure set this now joins), BL-366/BL-340 (why nothing caught it).

Citations: [wip/turso-live-metrics, p0-test-infra, claude, sandbox P0.6, 1: extensions/bundles/sox-memory-bundle/members/memory-server/recall-parity.test.ts:104-142 (compareResults, corrected), 2: libs/memory-core/src/write.ts:301 (`const uid = ulid()`), 3: `npx nx test memory-server --skip-nx-cache` 2026-07-31 — avgOverlap 0 before the comparison fix, 0.52 after, 4: commit 15ff307 (frozen-{skip} fix that made this test execute at all)]

---

### BL-368 — Integrity verdict was unreachable from every real consumer: WeakMap keyed on an adapter instance callers never hold — **RESOLVED** (2026-07-31)

**Found while wiring BL-334's status surface.** `recordIntegrityResult`/`getLastIntegrityResult` keyed the retained verdict in a `WeakMap` on the adapter instance.[1] No real consumer holds that instance: `memory-core`'s `openDb()` returns `instrumentAdapter(adapter)` — a **`Proxy`**[2] — and a `Proxy` is a distinct object identity, so the `WeakMap` lookup misses.

**Measured**, using the exact shapes from both files: lookup by the real instance **FOUND**, lookup by the proxy **null**.[3] Every `memory_ping` caller would have read `null` — rendered as "no pass has run" — **forever, on a perfectly verified store.** The feature would have looked wired while reporting nothing, which is the BL-319 shape exactly: an instrument connected to one path and invisible from the path that reads it.

A **second, independent** instance of the same class was found in parallel: memory-core reaches store-adapter through `require()` while an ESM consumer gets a second module instance with its own Maps — so even a correctly-keyed in-process registry is unreadable across that boundary.[4]

**Fix (two layers, both landed):** (a) a path-keyed mirror keyed on `config.dbPath`, which reads through a proxy unchanged, so `getLastIntegrityResult` resolves for wrapped and unwrapped callers alike; (b) the authoritative fix — the verdict is **persisted into `_adapter_meta.last_integrity`** and read back from the store, surviving both the proxy and the module-instance split.[4]

**Red→green (names BL-368):** `integrity-status.test.ts` records a result against an adapter, wraps it in a Proxy of the shape memory-core applies, and asserts the lookup resolves. Verified RED with the path fallback disabled — `AssertionError: expected null not to be null` — and green with it restored. Negative control: an unrelated path still resolves to `null` rather than to another store's report.

**Severity:** HIGH at discovery — it silently nullified the entire BL-334 status wiring. Resolved before that wiring shipped.

**Related:** BL-334 (the surface this feeds), BL-352 (the engine), BL-319 (same "wired to one path" shape), BL-347 (the outage a working surface would have caught).

Citations: [wip/turso-live-metrics, architect-reviewer, claude, BL-334, 1: libs/data/store/store-adapter/src/integrity.ts (lastReports WeakMap, recordIntegrityResult/getLastIntegrityResult), 2: libs/memory-core/src/db.ts:305 (return instrumentAdapter(adapter, adapter.config.type)), 3: /Users/nix/.claude/jobs/1557bcef/tmp/proxykey.mjs + libs/data/store/store-adapter/src/__tests__/integrity-status.test.ts, 4: libs/data/store/store-adapter/src/integrity.ts persistIntegrityResult/readIntegrityResult + INTEGRITY_META_KEY (landed concurrently, commit 52f9c8c)]

---


**✅ RESOLVED 2026-07-31.** Fix is `c.channel?.unref()` alongside the existing unrefs in `ensureProcess()`.

**Red→green naming BL-370**, both arms measured in one harness that forks exactly as `ensureProcess()` does and reports whether the parent exits: **without the fix → hung; with it → exited.** Plus a guard asserting the shipped source carries the call. embedding-provider 28/28, lint clean.

**Two harness traps are documented in the spec because each produced a wrong answer first** — recorded so the next person does not rediscover them:
1. The forked grandchild **inherits the parent's stdout**. If those are `spawnSync` pipes, `spawnSync` waits for pipe EOF as well as process exit, and the surviving grandchild holds the pipe open — so **both** arms report "hung" regardless of the fix. `stdio: 'ignore'` is load-bearing.
2. Vitest's default **5 s per-test budget** kills the deliberately-hanging arm, and the failure reads like a product defect rather than a harness limit. That arm needs an explicit timeout.

**Not closed as cosmetic.** The orphans this created produced the "another fastembed host process is ALREADY RUNNING … Neural Engine contention" warning that was cited across sessions as evidence of real cross-process ANE contention — at least one such warning named an orphan this defect created, idle at 0% CPU. **Cross-process ANE contention remains unproven**; the measured cause of the live slowdown was scheduling QoS (BL-331).

Citations: [wip/turso-live-metrics, performance-engineer, claude, BL-370, 4: libs/data/embed/embedding-provider/src/sharedFastembedProcess.ts (ensureProcess), 5: libs/data/embed/embedding-provider/src/sharedFastembedProcess-leak.spec.ts]
---


**✅ RESOLVED 2026-07-31 — but the fix sketch above was WRONG and is corrected here.** I filed it; the symptom was right and the remedy was not. Measured, not reasoned:

1. **No `duration_ms` emitter ever used `Date.now()`.** They all already use `performance.now()` — `telemetry.ts` (`withTimedEvent`), `embed.ts`, `write.ts` ×5, `write-queue.ts` ×6, `db.ts` ×2.
2. **`performance.now()` and `process.hrtime.bigint()` are the SAME clock.** Measured on Node v24.11.1 darwin/arm64: they agree to **0.002 ms** over a 250 ms interval. Both are `uv_hrtime()`. The proposed swap is a literal no-op — it would have shipped, closed the item, and changed nothing.
3. **That clock INCLUDES system sleep on this platform.** Decisive test against data already on disk: pair each `embed.start` with its `embed.finish` and compare the true wall gap (from the two `ts` fields) against the reported `duration_ms` — **n=28 long ops, median ratio 1.000**, including the 3-hour span that was 95% asleep (10953310 ms wall vs 10953175 ms reported). Control: **n=3532 short ops, ratio 1.000**.[5]

Note the published record disagrees with this machine: libuv#2891 states macOS `uv_hrtime` uses `mach_absolute_time`/`CLOCK_UPTIME_RAW`, which *excludes* sleep. On Node 24 it demonstrably does not. **`Date.now()`, `performance.now()`, `hrtime.bigint()` and `process.uptime()` all include sleep — there is no drop-in sleep-excluding clock in JS on macOS.**

**What shipped instead — a suspension ledger** (`libs/memory-core/src/suspension.ts`):[6] one process-global heartbeat; a late tick means the process did not run, and a `process.cpuUsage()` delta over the same gap discriminates **SYSTEM SUSPEND** (~no CPU) from **EVENT-LOOP BLOCK** (CPU burnt). Both are recorded — they are different defects, and the second is BL-351 §6.4's event-loop-lag measurement for free.

**Records annotate, never subtract.** `duration_ms` stays raw and reconcilable against the record's own `ts`; `suspended_ms` / `blocked_ms` are added alongside and omitted entirely when zero, so their presence is itself the signal and the common case costs no log bytes. A subtracted duration would be neither wall nor compute and could no longer be checked against the timestamps.

**Wired at the logging boundary** (`emit()`), not at the ~12 call sites, so every emitter present and future is correct by construction — a call-site convention is precisely what left BL-344's allowlist duplicated six times. The heartbeat auto-starts from `emit()` and its timer is `unref()`'d; a real process that starts tracking is proven to exit on its own (BL-370's failure shape).

**Red→green naming BL-369:** 13 tests, **verified 6 failing with the mechanism disabled and 13/13 with it restored.** memory-core suite measured before and after: **162 failed / 299 passed → 162 failed / 312 passed** — identical failures, +13 passing, nothing broken. (Those 162 are p0-test-infra's in-flight BL-325 work, verified by measuring at HEAD with my change removed rather than asserted.)

**Historical data is NOT retroactively corrected** — every percentile already published from the existing JSONL stays inflated. `docs/observability/README.md` records the effective-date boundary.

Citations: [wip/turso-live-metrics, performance-engineer, claude, BL-369, 5: ~/.adhd/sox-ecosystem/memory/log-analysis/bl369-clock-truth.py, 6: libs/memory-core/src/suspension.ts + suspension.spec.ts, 7: libs/memory-core/src/telemetry.ts (emit/annotateSuspension)]
---

### BL-375 — `service enable` rebuilds unit env from the INVOKING SHELL, silently dropping any tunable it does not happen to have — **Open (HIGH)** (2026-07-31)

**Driver — hit live while deploying BL-331, and it nearly turned both emergency brakes off on the running memory-server.**

`buildOsUnitEnv()` composes the launchd unit's `EnvironmentVariables` by filtering **`process.env` of whatever shell ran `soxe service enable`** through an allowlist.[1] It does not read the previously-generated unit, does not diff against it, and does not warn about keys that were present before and are absent now. Consequence: **a service's configuration is only as durable as the ambient environment of whoever last regenerated its unit.**

Observed: regenerating the memory-server unit to change one unrelated key (`ProcessType`) produced a plist that had silently lost

```
SOX_DISABLE_EMBED_HEAL=1
SOX_DISABLE_PERIODIC_ENRICH=1
```

— **both live emergency brakes (BL-339, BL-346).** The command reported success (`updated … loaded: yes`) and said nothing. The only reason this was caught is that the deploy procedure diffs the regenerated plist against a snapshot; without that step the next backend spawn would have re-enabled embed heal and periodic enrich on a store with a 3,246-item backlog — reproducing the exact BL-346 outage the brakes exist to prevent.

**Why the allowlist comment makes it worse, not better.** `buildOsUnitEnv` carries the note *"forwarded so the supported `soxe service enable` regeneration path can carry it into the launchd unit — never hand-edit the generated plist to inject env."*[1] The supported path is therefore the **only** sanctioned way to set these, and that same path drops them whenever the operator's shell does not re-supply them. Correct usage requires knowing, from memory, every tunable a unit was ever given.

**This is the same failure shape as BL-372:** a step reports success, every surface reads green, and the thing you actually changed did not survive.

**Fix sketch:**
1. On regeneration, **read the existing unit's env and diff it.** Any allowlisted key present before and absent now must at minimum print a loud warning naming the key; preferably it is **carried forward** unless explicitly cleared (`--unset KEY`).
2. Persist service tunables in the extension's scope config so they are a property of the installation rather than of a shell, and have `buildOsUnitEnv` read *that* — the env forward becomes an override, not the source of truth.
3. `service enable` should print the env diff it is about to apply, the way it already prints the content hash.

**Acceptance (red→green, must name BL-375):** generate a unit with `SOX_DISABLE_EMBED_HEAL=1` in the environment, regenerate it from an environment lacking that key, and assert the key is either preserved or the command fails/warns explicitly. Today it is silently dropped and the command reports success.

**Severity:** HIGH — it silently discards live safety configuration on the supported path, with a success message, and it did so on the production service today.

**Related:** BL-331 (found during its deploy), BL-339 / BL-346 (the brakes at risk), BL-372 (same green-but-not-deployed shape), BL-344 (the six duplicated env allowlists this rides on).

Citations: [wip/turso-live-metrics, performance-engineer, claude, BL-331 deploy, 1: apps/sox/src/main.ts `buildOsUnitEnv()` ~4631-4650, 2: observed plist diff 2026-07-31 — `~/.adhd/sox-ecosystem/memory/bl331-predeploy-20260731-180139/plist.before` vs the regenerated unit, 3: libs/host-runtime/src/os-unit.ts (enableOsUnit rewrite path)]

---

### BL-377 — `export.ts` and `reembed.ts` blind-cast the adapter to `SqliteAdapter` and unwrap it, so both are broken on the DEFAULT Turso backend — **Open (HIGH)** (2026-07-31)

**Found while:** driving BL-325's remaining `memory-core` failures to ground. 30 of the 162 remaining red tests (21 in `export.spec.ts`, 9 in `reembed.spec.ts`) come from this single defect, and none of them are test drift — the specs are correct and the production code is wrong.[1]

**Driver.** Both files do an unguarded cast-and-unwrap:
```ts
const db = (adapter as SqliteAdapter).unwrap();   // export.ts:295, reembed.ts:250
```
`unwrap()` returns whatever native handle the adapter wraps. On `SqliteAdapter` that is a better-sqlite3 `Database`, whose `.prepare(...).all()` is **synchronous and returns an array**. On `TursoAdapter` it is a `@tursodatabase/database` handle, whose equivalent is **asynchronous and returns a Promise**. The cast is a lie the compiler cannot catch — it is asserted, not checked.

Observed consequence, verbatim:
```
TypeError: episodes is not iterable
  ❯ export.ts:317   for (const ep of episodes)      // episodes is a Promise
```
21 occurrences from `export.spec.ts`, 9 more of the same class from `reembed.spec.ts`.[2]

**Why this is worse than a test failure: Turso is the DEFAULT.** These specs set no `STORE_ADAPTER`, and they resolve to `TursoAdapterImpl` — confirmed directly from the stack traces in this same run (`TursoAdapterImpl.executeGet`, `libs/data/store/store-adapter/src/turso-adapter.ts:262`).[3] So the export and re-embed paths are broken on the backend the system actually runs, and have been since the Turso migration.

**Contrast with the two correct sites.** `db.ts:373` and `db.ts:896` perform the same unwrap but are **capability-guarded** — `if (!adapter.capabilities.nativeVectors)` — so they only ever run on the sqlite branch. That guard is exactly what `export.ts`/`reembed.ts` are missing, and it demonstrates the codebase already knows the correct pattern.[4] `backup.ts:171`/`:202` are a third, different case: they explicitly `createSqliteAdapter(...)`, i.e. deliberately sqlite-only rather than accidentally so — that is a separate question (whether Turso stores can be backed up at all) and is NOT this item.

**The generalisable defect:** `unwrap()` returns `unknown` on the base `StoreAdapter` interface precisely so callers cannot assume a backend, and both of these callers defeat that with a cast. Any `as SqliteAdapter` outside a `capabilities` guard is a latent backend assumption.

**Fix sketch:** convert both call paths to the async `StoreAdapter` API (`executeAll`/`executeGet`/`executeRun`) rather than a raw handle. In `export.ts` that means making the four sync helpers async (`deriveTopicName` :98, `collectMentionedEntities` :164, `collectRelatedUids` :184, and the main episode query :302) and awaiting them at :319/:339/:340/:341. `reembed.ts` has a single raw use at :250. Where a raw handle is genuinely required, gate it on `adapter.capabilities` and fail loudly on the unsupported backend instead of casting.

**Acceptance (red→green, must name BL-377):** `npx nx test memory-core` — `export.spec.ts` and `reembed.spec.ts` pass with **no** `STORE_ADAPTER` set (i.e. against the default Turso backend), and continue to pass with `STORE_ADAPTER=sqlite`. Both arms are required; passing only under sqlite is the bug.

**Severity:** HIGH — two production paths are non-functional on the default backend, and the failure mode is a `TypeError` on a Promise rather than a clean unsupported-backend error.

**Related:** BL-325 (this is 30 of its remaining failures, but a distinct root cause — production defect, not spec drift), BL-323 (a different blind-import assumption in the same file family).

Citations: [wip/turso-live-metrics, p0-test-infra, claude, sandbox P0.6, 1: libs/memory-core/src/export.ts:295, libs/memory-core/src/reembed.ts:250, 2: `npx nx test memory-core --skip-nx-cache` 2026-07-31 — 21x "episodes is not iterable" from export.spec, 3: libs/data/store/store-adapter/src/turso-adapter.ts:262 (TursoAdapterImpl.executeGet in the same run's traces), 4: libs/memory-core/src/db.ts:371-373 and :894-896 (the capability-guarded form), 5: libs/memory-core/src/export.ts:98,164,184,302,319,339-341]

---

### BL-379 — Post-repair reverification silently skips the WAL-identity probe — **Open (LOW)** (2026-07-31)

**Driver.** `repairStoreIntegrity()` re-verifies with `verifyStoreIntegrity(adapter, { depth: report.depth })` and does **not** forward `walBaseline`.[1] `probeWalIdentity()` returns `null` without a baseline,[2] so `wal_identity` contributes no finding to any reverification — it is silently absent rather than reported as unverified.

**Consequence.** A WAL unlinked *during* a repair pass (the repair does real work — an FTS rebuild took 982 ms on the live store) is not detected by the reverification that immediately follows. The close-path check still catches it (BL-330), so this is a coverage gap rather than a data-loss path, and no false verdict results.

**Why it is worth filing rather than quietly patching:** it is the same shape as BL-374 and BL-368 — an instrument that appears wired and reports nothing — and the fix has a design question attached: reverify should either forward the baseline or explicitly record `wal_identity` as `unknown`, and "silently omitted" must not remain an option.

**Fix sketch:** forward `walBaseline` through `RepairOptions`, or have `verifyStoreIntegrity` emit an explicit `unknown` finding when a requested probe cannot run for want of an input.

**Acceptance (red→green, must name BL-379):** unlink the WAL between the damage and the repair, and assert the post-repair report contains a `wal_identity` finding rather than omitting it.

**Severity:** LOW — no incorrect verdict and no data loss; a probe that quietly does not run.

**Related:** BL-330 (the probe), BL-352 (the engine), BL-374 (same "wired but silent" family).

Citations: [wip/turso-live-metrics, database-administrator, claude, BL-374 follow-on, 1: libs/data/store/store-adapter/src/integrity.ts (repairStoreIntegrity reverify call), 2: libs/data/store/store-adapter/src/integrity.ts (probeWalIdentity early return on a null baseline)]
