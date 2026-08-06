# SPEC — PKT-59 (BL-440): injected `TypePolicy`, behaviour-preserving

**Authorisation:** `docs/decisions/0010-open-node-and-edge-typing.md` D2 (injected policy closure,
validated at the write boundary, no CHECK, no registry table, no path to DDL) and D4 (edge.rel opens
in the same pass as node.kind — recorded here as future-state context; **this packet does not open
`rel`, it only adds the validator that PKT-74 will stand behind**). PKT-59 is the first packet in the
nine-packet wave and gates PKT-58/PKT-74, which both edit this same file next.

**Mandatory reading before writing a line (already done for this spec, re-do it yourself):**
`git show 0ce39c7 -- libs/data/graph/graph-store/src/index.ts` (the reverted BL-295
implementation) and the current `libs/data/graph/graph-store/src/ensure-check-constraints.bl447.spec.ts`
(the pattern this packet's new spec file should follow for populated-store, real-file-backed testing).

---

## 1. Root cause

`writeNode` (`libs/data/graph/graph-store/src/index.ts:886-894`) validates `kind` against
`DEFAULT_NODE_KINDS`, a module-level constant of memory's own six node types
(`index.ts:257`: `['episode', 'entity', 'claim', 'community', 'session', 'generic']`). On rejection it
throws `ConstraintError` with a message that instructs every consumer of this generic, published
storage library to abandon typing and fall back to `kind:'generic'` plus a tags sub-kind
(`index.ts:889-893`, verbatim: *"Non-memory reuse (e.g. a component registry) should write
kind:'generic' and carry a sub-kind in tags/metadata instead of registering a new kind."*). Per
ADR-0010 D1/D2, the vocabulary a store enforces belongs to the consumer (memory-core), injected into
graph-store — not hardcoded inside it.

The `rel` side has no analogue to replace, because none exists: `writeEdgeInternal`
(`index.ts:1102-1121`) performs **zero** runtime validation of `rel`. It inserts the raw string
directly (`index.ts:1106-1112`) and only *translates* a SQLite `CHECK constraint failed` error into a
`ConstraintError` after the fact (`index.ts:1114-1116`). The closed `EdgeRel` TypeScript union
(`index.ts:364-374`) is a compile-time-only guard — it does nothing for a JS caller or a JSON tool
payload. So `validateKind` **replaces** a guard that has existed for years; `validateRel` **creates
the first one that has ever existed** for edges. Treat these as different-risk changes, not mirror
images of each other (BL-448).

Both write paths funnel through exactly two internal methods — verified in source, not by inference
from the docstrings:
- **Node:** `writeNode` (`index.ts:886`) ← `writeNodeBatch` (`index.ts:1000-1006`, loops calling
  `writeNode`) ← `writeGraph` (`index.ts:1008-1028`, loops calling `writeNode` at `:1014`).
- **Edge:** `writeEdgeInternal` (`index.ts:1102`, private) ← `writeEdge` (`index.ts:1098-1100`,
  public, delegates) ← `writeGraph` (`index.ts:1024`, calls `writeEdgeInternal` directly — it does
  **not** go through public `writeEdge`).

There is no third funnel. `getEdges`/`getNeighbors*`/`isReachable`/`getSubgraph` are all reads.

## 2. The change, file by file

**Single file touched: `libs/data/graph/graph-store/src/index.ts`.** No other file in the repo
changes as part of this packet.

### 2.1 New exports (insert after `PUBLIC_EDGE_RELS`, currently `index.ts:505-513` — i.e. after line
513, before `interface DbNodeRow`)

```ts
/**
 * The rels baked into every store's CHECK (rel IN (...)) clause today — the full ten-member
 * EdgeRel vocabulary (index.ts:364-374), NOT PUBLIC_EDGE_RELS (which is memory-core's own
 * 7-member tool-surface subset, unrelated to this constant and untouched by this packet).
 * This is DEFAULT_TYPE_POLICY's validateRel() vocabulary — see BL-440.
 */
export const DEFAULT_EDGE_RELS: readonly EdgeRel[] = [
  'MENTIONS',
  'SUPPORTS',
  'RELATES_TO',
  'SUPERSEDES',
  'DERIVED_FROM',
  'MEMBER_OF',
  'PART_OF',
  'SAME_AS',
  'ASSIGNED_TO',
  'DEPENDS_ON',
];

/**
 * Injected type-vocabulary policy (ADR-0010 D2). graph-store owns no vocabulary of its own —
 * a TypePolicy is pure in-process validation with NO reference to DDL, rebuildTable, or the
 * adapter. It is called at the write boundary (writeNode / writeEdgeInternal) and throws
 * ConstraintError to reject. See BL-440's "no path to DDL" requirement — a TypePolicy
 * implementation MUST NOT be able to alter the schema under any input.
 */
export interface TypePolicy {
  validateKind(kind: string): void;
  validateRel(rel: string): void;
}

/**
 * The default TypePolicy every SqliteGraphBackend gets when no typePolicy is supplied. This is
 * deliberately the CLOSED six-kind / ten-rel vocabulary the CHECK constraints enforce today —
 * NOT the "syntactic-only" default ADR-0010 D2 describes as graph-store's eventual built-in
 * default. That eventual shift only becomes safe once every memory-core call site injects its
 * own MemoryOntologyPolicy explicitly (PKT-60) — until then, a caller supplying no typePolicy
 * (all 8 memory-core call sites, today) MUST see byte-identical behaviour to pre-PKT-59. Do not
 * widen this default in this packet.
 */
export const DEFAULT_TYPE_POLICY: TypePolicy = {
  validateKind(kind: string): void {
    if (!DEFAULT_NODE_KINDS.includes(kind as (typeof DEFAULT_NODE_KINDS)[number])) {
      throw new ConstraintError(
        `Unknown node kind "${kind}". Allowed kinds: ${DEFAULT_NODE_KINDS.join(', ')}.`,
      );
    }
  },
  validateRel(rel: string): void {
    if (!DEFAULT_EDGE_RELS.includes(rel as EdgeRel)) {
      throw new ConstraintError(
        `Unknown edge rel "${rel}". Allowed rels: ${DEFAULT_EDGE_RELS.join(', ')}.`,
      );
    }
  },
};

/** Options accepted by createGraphBackend() / the SqliteGraphBackend constructor. */
export interface GraphBackendOpts {
  /** Injected type-vocabulary policy. Defaults to DEFAULT_TYPE_POLICY (today's six kinds, ten rels). */
  typePolicy?: TypePolicy;
}
```

Note the deliberate ordering: `DEFAULT_EDGE_RELS`'s type annotation (`readonly EdgeRel[]`) requires
`EdgeRel` (`index.ts:364-374`) already declared, which it is — this insertion point is after both
`DEFAULT_NODE_KINDS` (:257) and `EdgeRel` (:364-374), so both are in scope.

### 2.2 `SqliteGraphBackend` — constructor (`index.ts:797-809`)

```ts
export class SqliteGraphBackend implements GraphBackend {
  readonly capabilities: GraphBackendCapabilities = { /* unchanged */ };

  private adapter: StoreAdapter;
  private schemaApplied = false;
  private typePolicy: TypePolicy;

  constructor(adapter: StoreAdapter, opts?: GraphBackendOpts) {
    this.adapter = adapter;
    this.typePolicy = opts?.typePolicy ?? DEFAULT_TYPE_POLICY;
  }
```

**No other line in the constructor or in `applySchema()`/`ensureCheckConstraints()` changes.** This
is the load-bearing property that makes this packet safe: `opts` is stored and never read anywhere
near DDL. Confirm by grep after implementing: `this.typePolicy` must appear ONLY inside `writeNode`
and `writeEdgeInternal` — zero occurrences in `applySchema`, `ensureCheckConstraints`,
`addColumnIfMissing`, or anywhere that calls `rebuildTable`/`this.adapter.exec` with DDL text.

### 2.3 `writeNode` (`index.ts:886-894`) — replace the inline check

Before:
```ts
async writeNode(content: string, meta: NodeMeta): Promise<number> {
  const kind = meta.kind ?? 'episode';
  if (!DEFAULT_NODE_KINDS.includes(kind as (typeof DEFAULT_NODE_KINDS)[number])) {
    throw new ConstraintError(
      `Unknown node kind "${kind}". Allowed kinds: ${DEFAULT_NODE_KINDS.join(', ')}. ` +
        `Non-memory reuse (e.g. a component registry) should write kind:'generic' and ` +
        `carry a sub-kind in tags/metadata instead of registering a new kind.`,
    );
  }
```

After:
```ts
async writeNode(content: string, meta: NodeMeta): Promise<number> {
  const kind = meta.kind ?? 'episode';
  this.typePolicy.validateKind(kind);
```

The rest of `writeNode` (hash lookup, INSERT, etc.) is unchanged. `DEFAULT_NODE_KINDS` itself is
**not deleted** — it remains exported and is now `DEFAULT_TYPE_POLICY`'s own vocabulary source (§2.1).

### 2.4 `writeEdgeInternal` (`index.ts:1102-1121`) — add the first-ever `rel` validation

Before:
```ts
private async writeEdgeInternal(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): Promise<void> {
  try {
    const now = nowISO();
    ...
```

After:
```ts
private async writeEdgeInternal(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): Promise<void> {
  this.typePolicy.validateRel(rel);
  try {
    const now = nowISO();
    ...
```

`validateRel` runs **before** the `try` block, not inside it — it must throw its own `ConstraintError`
directly and must NOT be caught and re-wrapped by the existing `catch` at `:1114-1119` (that catch
exists to translate *SQLite's* CHECK/FK failures; a policy rejection is already the right error type
and must not pass through string-matching on `err.message`).

### 2.5 `createGraphBackend` factory (`index.ts:1306-1308`)

Before:
```ts
export function createGraphBackend(adapter: StoreAdapter): GraphBackend {
  return new SqliteGraphBackend(adapter);
}
```

After:
```ts
export function createGraphBackend(adapter: StoreAdapter, opts?: GraphBackendOpts): GraphBackend {
  return new SqliteGraphBackend(adapter, opts);
}
```

Source-compatible: every existing call site (`libs/memory-core/src/{cluster.ts:749,820,886,
enrich-batch.ts:189, entity-episodes.ts:119, list-entities.ts:63, near-duplicates.ts:44,
related.ts:95, supersession-chain.ts:49}`) calls `createGraphBackend(adapter)` with one argument and
continues to compile and behave identically.

### 2.6 New spec file

`libs/data/graph/graph-store/src/type-policy.bl440.spec.ts` — see §4 for required cases. Follow the
real-file-backed-adapter pattern in `ensure-check-constraints.bl447.spec.ts` (temp dir via
`mkdtempSync`/`tmpdir()`, tracked adapters closed in `afterEach`) for the populated-store test; the
default-policy unit tests can use `:memory:` per `graph-store.spec.ts`'s existing convention.

### 2.7 Files that do NOT change, and why

- **`NODE_TABLE_DDL`, `EDGE_TABLE_DDL`, `graphDdl()`, `INLINE_MIGRATION_DDL`** (`index.ts:55-120,
  177-255, 259-303`) — no CHECK is dropped in this packet. That is PKT-58 (`kind`) and PKT-74
  (`rel`), serialized after this one.
- **`applySchema()` / `ensureCheckConstraints()` / `hasEnumCheckConstraint()`**
  (`index.ts:793-876`) — PKT-73's BL-447 structural-presence gate is unaffected; this packet gives it
  nothing new to detect, because no DDL changed.
- **`rebuild-table.ts`** — untouched. `TypePolicy` never calls it, imports it, or references it.
- **`GraphBackend` interface** (`index.ts:458-503`) — no method signature changes. `typePolicy` is a
  construction-time concern (constructor / factory options), not a per-call parameter; none of
  `writeNode`/`writeEdge`/`writeGraph`'s public signatures change.
- **`PUBLIC_EDGE_RELS`** (`index.ts:505-513`) — this is memory-core's own 7-value tool-surface
  subset (consumed by `libs/memory-core/src/link.ts:15`), unrelated to the ten-value CHECK
  vocabulary. Do not conflate it with `DEFAULT_EDGE_RELS` and do not edit its value or its existing
  7-value spec assertion (`graph-store.spec.ts:28-39`).
- **Any file under `libs/memory-core/`** — every `createGraphBackend()` call site there keeps
  passing zero or one argument; none is touched. Wiring `MemoryOntologyPolicy` through those eight
  call sites is PKT-60/BL-441's job, not this packet's. If you find yourself editing a memory-core
  file, stop — you have drifted into PKT-60's scope.
- **`drizzle/schema.ts`** — no DDL changed, so no migration-management mirror is needed.

## 3. Every decision, ruled

**D-A. `TypePolicy` throws `ConstraintError` directly; it does not return a boolean/result type.**
Ruled by BL-440's own fix text ("`TypePolicy.validateKind(kind)` and `TypePolicy.validateRel(rel)`
throw `ConstraintError`") — not an open fork. Rejected alternative: return `{ ok: boolean; message?:
string }` and have the caller construct the error. Loses because it forces every implementer
(including test fixtures) to duplicate error-construction logic that the interface should own, and
because `writeNode`'s existing shape already throws directly — matching it is zero-cost.

**D-B. The default policy enforces the CLOSED six-kind/ten-rel vocabulary, not ADR-0010 D2's
eventual "syntactic-only" description.** ADR-0010 D2 says *"graph-store's own default policy is
syntactic-only"* — but that describes the **end state of the whole nine-packet wave**, once PKT-60
has made every memory-core call site inject `MemoryOntologyPolicy` explicitly. PKT-59's own
acceptance criteria (§4 below, from `PLAN.md:2652`) require "a caller passing no `typePolicy`
observes today's six-kind and ten-rel behaviour unchanged" — and today, every one of the eight
memory-core call sites passes no `typePolicy`. If `DEFAULT_TYPE_POLICY` were merely syntactic
(format-only, no vocabulary), every memory-core write would silently accept any well-formed string
as a `kind`/`rel` the moment this packet lands — a real behaviour change, and the exact regression
BL-441 exists to prevent memory-core's ontology from going unenforced. **Rejected alternative:**
ship the syntactic-only default now, on the reasoning that D2 says so. Loses because it contradicts
this packet's own "changes no behaviour" acceptance bar and would leave memory's ontology unenforced
for the entire window between PKT-59 landing and PKT-60 landing. The syntactic-only shift is
explicitly PKT-60's transition to make, in the same change that gives memory-core its own injected
policy.

**D-C. "Malformed identifier" rejection (acceptance criterion (d)) needs no separate shape/regex
check in `DEFAULT_TYPE_POLICY`.** Because the default policy is a closed-set membership test, any
malformed string (empty, mixed case, SQL-looking, whatever) is already rejected by the same
`!DEFAULT_NODE_KINDS.includes(...)` / `!DEFAULT_EDGE_RELS.includes(...)` check that rejects
`'entitiy'`. **Rejected alternative:** port the reverted commit's `KIND_NAME_RE =
/^[a-z][a-z0-9_]*$/` shape validator into `DEFAULT_TYPE_POLICY`. Loses because it is redundant work
solving a problem the closed-set check already solves for this packet's default policy, and because
inventing shape rules not requested by BL-440/ADR-0010 risks encoding an assumption (e.g. lowercase
kinds vs uppercase rels use different shapes) that a later packet would have to unwind.

**D-D. `validateRel` runs before the `try` block in `writeEdgeInternal`, and is never caught by the
existing SQLite-error-translation `catch`.** Rejected alternative: call `validateRel` inside the
`try` and let a thrown `ConstraintError` fall through the `catch`'s `instanceof Error &&
err.message.includes('CHECK constraint failed')` check (which it would fail, since it's not that
message, and re-throw unchanged via the `throw err;` fallthrough) — functionally arrives at the same
outcome today, but is fragile: it makes the correctness of policy-rejection depend on the string
`.message.includes(...)` checks never matching a `ConstraintError`'s own message text, an invariant
nothing enforces. Placing the call before `try` removes the dependency entirely and is also the
faster path (SQL round-trip skipped on a policy violation) — directly satisfies "before the INSERT"
in the acceptance text.

**D-E. `GraphBackendOpts`/constructor second parameter is an options object (`{ typePolicy? }`), not
a bare positional `TypePolicy` argument.** Matches the exact shape `PLAN.md:2451` cites
(`createGraphBackend(adapter, { typePolicy?: TypePolicy })`) and mirrors the reverted BL-295 commit's
`GraphBackendOpts` shape (`kinds?: readonly string[]`) for continuity — same options-bag pattern,
different field. **Rejected alternative:** `createGraphBackend(adapter, typePolicy?: TypePolicy)`
positional. Loses because it is not what the packet text specifies and because an options bag is
what every other multi-field construction site in this codebase uses; a bare positional argument also
has no room to add a second optional field later without a breaking signature change.

**D-F. `DEFAULT_NODE_KINDS` is kept as-is (not renamed, not deleted) and becomes
`DEFAULT_TYPE_POLICY`'s vocabulary source; a new `DEFAULT_EDGE_RELS` is added alongside it rather
than reusing `PUBLIC_EDGE_RELS`.** Ruled in §2.7 above — `PUBLIC_EDGE_RELS` is a different vocabulary
(memory-core's 7-value tool surface) owned by a different consumer for a different purpose; reusing
it as `DEFAULT_TYPE_POLICY`'s 10-value default would silently reject three rels
(`MEMBER_OF`/`PART_OF`/`DEPENDS_ON`) that `writeGraph`/`writeEdge` calls in memory-core (e.g. cluster
`MEMBER_OF` edges) use today — a real behaviour break, exactly what this packet must not do.

**D-G. No new column, no new index, no `NodeFilter`/`EdgeFilter` field.** Not actually a fork — no
part of BL-440's text asks for one — stated here only because it is the same discipline PKT-58's spec
enforces and worth being explicit that this packet inherits it: `TypePolicy` is pure in-process
validation, it touches no schema surface at all, forward or otherwise.

## 4. Acceptance criteria (naming BL-440), each with its red arm

All four live in the new `type-policy.bl440.spec.ts`. "Red" means: written against the CURRENT
pre-PKT-59 source (i.e., what fails to compile or fails the assertion before this packet's changes
land) — verify each one actually fails first, per BL-225.

**AC-1 (the most important test in the packet — BL-295 regression guard, "no path to DDL").**
Using a real file-backed adapter (temp dir, `ensure-check-constraints.bl447.spec.ts` pattern — not
`:memory:`, because the point is proving identity survives a construction against a store that
already has committed rows and an established `sqlite_master` entry): create a store with the
current closed DDL, insert a couple of rows directly, capture `{ rootpage, sql }` for both `node` and
`edge` from `sqlite_master`. Construct `createGraphBackend(adapter, { typePolicy: <custom policy
that accepts a novel kind 'component' and a novel rel 'CUSTOM_REL' in addition to the defaults> })`
and call `applySchema()`. Re-capture identity: **`rootpage` and `sql` text for both tables must be
byte-identical to before construction** — no rebuild fired merely because a permissive policy was
supplied. Then: write a node using one of today's default kinds through the new backend (proves the
backend still works normally) — succeeds. Then: attempt to write a node using the novel `'component'`
kind the custom policy permits — **this must still fail**, with a `ConstraintError` translated from
SQLite's CHECK (since no DDL changed, the CHECK still enforces the closed six), proving the custom
policy's permissiveness does not — and structurally cannot — reach the schema.
*Red today:* `{ typePolicy: ... }` does not compile — `createGraphBackend`/`SqliteGraphBackend`
accept no second argument at all.

**AC-2 (`validateRel` exists and rejects before the INSERT — no precedent, per BL-448).** Call
`DEFAULT_TYPE_POLICY.validateRel('BOGUS_REL')` directly and assert it throws `ConstraintError`. Then,
through the public API, call `backend.writeEdge(srcId, dstId, 'BOGUS_REL' as EdgeRel)` on a fresh
store and assert it throws `ConstraintError` — and assert (via a spy/count on the adapter, or by
using an adapter whose `executeRun` throws if ever called with an INSERT into `edge`) that the SQL
INSERT was never attempted.
*Red today:* `DEFAULT_TYPE_POLICY` does not exist — does not compile. (Today, `writeEdge` with a
bogus rel *does* already throw `ConstraintError`, but only via the SQL CHECK + `:1114-1116`
translation, i.e. only *after* attempting the INSERT — the "never attempted" half of this assertion
is the part that is red today.)

**AC-3 (default-policy behaviour unchanged for callers who pass nothing).** With
`createGraphBackend(adapter)` (no `opts`), assert: each of the six `DEFAULT_NODE_KINDS` values and
each of the ten `DEFAULT_EDGE_RELS` values round-trips through `writeNode`/`writeEdge` +
`getNode`/`getEdges` unchanged; `kind: 'entitiy'` (typo) throws `ConstraintError`; an edge rel not in
the ten (e.g. `'BOGUS_REL'`) throws `ConstraintError`.
*Red today:* the `'BOGUS_REL'` sub-case is already green today (via the CHECK), so this alone isn't
red — but assert it anyway as the positive/negative pair alongside AC-2, which is red. The six-kind
sub-cases are green today too (that's the point — "unchanged"), so this criterion's purpose is a
regression fence, not a red→green proof by itself; AC-1 and AC-2 carry the red arms for this packet.

**AC-4 (the `ConstraintError` message no longer steers toward `kind:'generic'`).** Trigger
`ConstraintError` via an unregistered kind on the default policy and assert
`error.message` does **not** contain the substring `'Non-memory reuse'` and does **not** contain
`"instead of registering a new kind"`. Positive assertion too: message contains `'Allowed kinds:'`
and the six kind names.
*Red today:* the current message (`index.ts:889-893`) contains exactly that steering sentence —
this assertion fails against current source.

## 5. Risks

- **`nx build`/`nx test graph-store` are destructive on this package (`"clean": true` in
  `libs/data/graph/graph-store/project.json:19`, BL-235/BL-456).** Never run a bare `npx nx build
  graph-store` to "see if it compiles" — read the source instead. Use
  `npx nx test graph-store -- src/type-policy.bl440.spec.ts` to scope runs during development, full
  `npx nx test graph-store` before the final commit. Report
  `node tools/check-suite-tree-state.mjs --project graph-store` alongside any result you cite.
- **Never open `~/.memory/*`.** AC-1's populated-store test uses a fresh temp file created by the
  test itself (`mkdtempSync`), never a copy of or path into the live store.
- **The one failure mode this packet exists to avoid (BL-295 recurrence) is a design defect, not a
  test-coverage gap — if AC-1 ever needs a change to `applySchema()`/`ensureCheckConstraints()` to
  pass, stop and report rather than making that change.** Per the dispatch's explicit instruction: if
  review finds any path from `TypePolicy` to DDL, the design is wrong.
- **Lint boundary (`data→memory-core` forbidden, `libs/data/CLAUDE.md`).** `TypePolicy` must not
  import anything from `@adhd/memory-core` or any `libs/memory-core/*` path — it is a generic
  interface implemented by a caller. `npx nx lint graph-store` is the enforcement gate.
- **Commit hygiene.** Explicit pathspec only (`git commit libs/data/graph/graph-store/src/index.ts
  libs/data/graph/graph-store/src/type-policy.bl440.spec.ts -m "..."` and the SPEC file separately).
  No `git add -A`. Conventional-commit, lowercase subject, scope `memory-core` is wrong here — this
  is a `libs/data` change; there is no `data` scope listed in the house rules' allowed-scope list
  (`[memory-core, sox, extensions, scripts, host-runtime, registry, ci, release, manifest,
  authoring, install-engine, nx-migration]`) — **use `memory-core` anyway is wrong too.** Use no
  scope prefix (`fix: ...` / `feat: ...`) rather than inventing or misusing one; if the house rules'
  scope list is later extended to include a `data` scope, prefer it.

## 6. The gate — exact nx targets

Run in this order, each one green before the next:

1. `npx nx lint graph-store` — catches the `data→memory-core` boundary violation if one snuck in.
2. `npx nx typecheck graph-store` — this package's dedicated typecheck target
   (`tsc -p libs/data/graph/graph-store/tsconfig.json --noEmit`); do not rely on `test` alone (see
   root `CLAUDE.md`'s "`typecheck` is not optional" constraint).
3. `npx nx test graph-store` (scope to the new file first with `-- src/type-policy.bl440.spec.ts`
   while iterating, full target before considering the packet done). Confirm every AC-1..AC-4 case
   fails against `git stash`-free pre-change source is not applicable here (no stash) — instead,
   verify red by reading the diff and reasoning per case above, or by checking out the pre-edit
   `index.ts` into a scratch copy and running the spec against it if you want an empirical red run;
   do not use `git stash` to do this (banned). The cheapest empirical red check: temporarily comment
   out just the new `this.typePolicy.validateRel(rel);` line and rerun AC-2 to see it fail, then
   restore it — this satisfies BL-225 without needing git gymnastics.
4. `npx nx build graph-store` **only once**, as the final step before considering the packet
   shippable — not as a diagnostic tool mid-work (BL-235). If it fails, fix the source and go back to
   step 2; do not re-run `build` speculatively.
5. Report `node tools/check-suite-tree-state.mjs --project graph-store` alongside the test result.

No `registry:sync-index` — `graph-store` is a `libs/data` package, not a registered extension
(`libs/data/CLAUDE.md`: "data packages are NOT registered in `registry/index.json`").
