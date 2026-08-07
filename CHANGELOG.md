# Changelog

---

## [Unreleased] — BL-444: one release train — and a release note that states what breaks

`@adhd/sox-graph-store` has four in-repo `workspace:*` runtime dependents pinned exactly at publish
(`@adhd/sox-analysis`, `@adhd/sox-vector-store`, `@adhd/sox-hybrid-search`, `@adhd/sox-memory-core`),
and five separate packets touched it in this wave alone (BL-438/439/440/441/448). Publishing each as
its own train would have meant five root releases cascading four downstream releases apiece — the
same multiplier that made one dependency fix cost eight npm releases on 2026-08-04 (BL-452). This
entry is the wave-level release note BL-444 exists to produce: one train, 18 packages, every break
named with its migration, before any of it ships to npm.

### Three source-breaking changes

- **`EdgeRel`** (`@adhd/sox-graph-store` 0.5.3 → 0.6.0): widened from a closed 10-member union to
  additionally accept `(string & {})`. Breaks in **return position**: `const r: EdgeRel = rec.rel`
  and any exhaustive `switch (rel) { … default: assertNever(rel) }` idiom over `EdgeRecord.rel` stops
  compiling, because the `default` arm's type is no longer `never`. Demonstrated, not merely
  described, by `libs/data/graph/graph-store/src/open-rel-check.bl448.spec.ts`'s `AC-Type` case
  (merged `f1c421ce`) — a `@ts-expect-error` fixture that fails to compile pre-widen and compiles
  post-widen. **Migration:** replace an exhaustive `default: assertNever(rel)` arm with one that
  handles the open case (e.g. treat an unrecognized `rel` as an extension value, not an error).

- **`LanceDbVectorBackend` / `openLanceDbVectorStore`** (`@adhd/sox-vector-store` 0.3.3 → 0.4.0):
  constructor config's `db: Database.Database` (raw `better-sqlite3` handle) replaced by a required
  `adapter: StoreAdapter`. Neither field is optional, so old call sites fail on two independent
  counts (`db` excess, `adapter` missing). **Migration:** construct the adapter the same way
  `@adhd/sox-store-adapter`'s own consumers already do, and pass it as `adapter` in place of `db`.

- **`warmupTimeoutMs`** (`@adhd/sox-embedding-provider` 0.1.0 → 0.2.0): gained a required
  `cacheHit: boolean` parameter (BL-376). Any zero-arg call site — the only legal call under
  0.1.0 — stops compiling. **Migration:** pass the cache-hit boolean at the call site.

### A non-compile-break behavior change, easy to miss

`node.kind` / `edge.rel` open (their SQL `CHECK` constraints drop) on **new stores only** —
`CREATE TABLE IF NOT EXISTS` no-ops against an existing table (ADR-0010 D1/D4). An existing store —
**including the live `~/.memory/memory.db`** — keeps rejecting a consumer kind/rel at the SQLite
layer until an operator explicitly runs the offline migration, never automatic, never on connection
open (ADR-0010 D3):

```bash
node tools/graph-store-migrate-open-schema.mjs --db <path> --confirm
```

This is the sole remaining path by which any store alive today can accept a consumer type — already
shipped, see the `BL-442` entry above, cross-referenced here rather than duplicated.

### A fourth surface change, added by this packet after the gate caught it

`@adhd/sox-memory-core` (0.5.0 → 0.6.0) shipped a new `ontology.js`/`graph-backend.js` composition
point (`MemoryOntologyPolicy`, `getMemoryGraphBackend`, `registerOntologyExtension`,
`getOntologySnapshot`, `translateStoreVocabularyError` — BL-441) with no changeset naming it;
`scripts/check-changeset-surface.ts` (BL-460) correctly FAILed this train on that gap. Purely
additive — no removed or narrowed export — so it bumps `minor`, matching the same
additive/minor convention already used elsewhere in this train (`@adhd/sox-host-registry`,
`@adhd/sox-service-proxy`). Filed as `.changeset/bl460-sox-memory-core-ontology-ownership.md`.

### Backwards-compatibility, verified not claimed

The six built-in memory kinds and ten memory rels keep working; the `kind:'generic'` + tags
convention keeps working and no consumer is forced to migrate data; every existing row reads back
byte-identically (no column added or removed); a caller passing no `typePolicy` sees pre-wave
behaviour. Proven by the PKT-62/BL-443 tarball-conformance gate (`npx nx run
graph-store:tarball-conformance`) — packs the real `@adhd/sox-graph-store@0.6.0` tarball, installs it
outside the workspace, registers a consumer kind/rel, writes/reads/traverses/queries by kind, and
asserts `EXPLAIN QUERY PLAN` resolves via `ix_node_kind` with zero `json_each` (AC-1 through AC-5,
all PASS, re-confirmed against the post-version-bump tree in this same packet).

### The version-bump set (18 packages)

| Package | Old | New | Bump | Source |
|---|---|---|---|---|
| `@adhd/sox-graph-store` | 0.5.3 | 0.6.0 | minor (corrected from a mis-filed `major`) | direct changeset |
| `@adhd/sox-vector-store` | 0.3.3 | 0.4.0 | minor (corrected from a mis-filed `major`) | direct changeset |
| `@adhd/sox-embedding-provider` | 0.1.0 | 0.2.0 | minor (corrected from a mis-filed `major`) | direct changeset |
| `@adhd/sox-memory-core` | 0.5.0 | 0.6.0 | minor (own additive surface, gap found by BL-460's gate) | direct changeset |
| `@adhd/sox-host-registry` | 0.2.0 | 0.3.0 | minor | direct changeset |
| `@adhd/sox-host-runtime` | 0.2.0 | 0.3.0 | minor | direct changeset |
| `@adhd/sox-install-engine` | 0.2.0 | 0.3.0 | minor | direct changeset |
| `@adhd/sox-manifest` | 0.2.0 | 0.3.0 | minor | direct changeset |
| `@adhd/sox-mcp-runtime` | 0.2.0 | 0.3.0 | minor | direct changeset |
| `@adhd/sox-service-proxy` | 0.2.0 | 0.3.0 | minor | direct changeset |
| `@adhd/sox-store-adapter` | 0.2.0 | 0.3.0 | minor | direct changeset |
| `@adhd/sox-authoring` | 0.2.0 | 0.2.1 | patch (doc-only) | direct changeset |
| `@adhd/sox-nx` | 0.1.1 | 0.1.2 | patch | cascade (`updateInternalDependencies: "patch"`) |
| `@adhd/sox-hybrid-search` | 0.3.3 | 0.3.4 | patch | cascade (graph-store dependent) |
| `@adhd/sox-claim-verification` | 0.1.0 | 0.1.1 | patch | cascade |
| `@adhd/sox-analysis` | 0.1.4 | 0.1.5 | patch | cascade (graph-store dependent) |
| `@adhd/sox-task-queue` | 0.2.3 | 0.2.4 | patch | cascade |
| `@adhd/sox-blob-store` | 0.2.3 | 0.2.4 | patch | cascade |

Every pre-1.0 (`0.x.y`) package in this table breaks at `minor`, per this repo's own documented
policy (`docs/decisions/0010-open-node-and-edge-typing.md:135-136`, `docs/plan/publishing/SCOPE.md:464`,
`docs/substrate/.catalog/distribution.md:216`) — under 0.x semver, minor is the breaking slot, never
`major`, until a package's own team makes a deliberate, separate decision to cross `1.0.0`.

This entry retires BL-438, BL-439, BL-440, BL-441, BL-443, BL-444, and BL-448. (BL-442 already
retired separately — see its own entry above.)

---

## Earlier history

Every release and fix before 0.6.0 lives in the backlog graph, not in this file.
Query it with the backlog MCP tools (`backlog_list_items`, `backlog_get_item`) scoped to
`repo: sox-ecosystem` — ~320 historical items were migrated there and existence-verified per id.

The full prose archive remains in git history: `git log --follow -- CHANGELOG.md`, or
`git show <sha>:CHANGELOG.md` for any commit before this one. Item citations recorded in the graph
are commit-pinned for exactly this reason.

See `docs/decisions/0011-backlog-tool-write-destination.md`.
