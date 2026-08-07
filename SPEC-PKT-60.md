# SPEC-PKT-60 — memory-core owns the ontology graph-store put down, through one seam

Authorisation: [`docs/decisions/0010-open-node-and-edge-typing.md`](../../docs/decisions/0010-open-node-and-edge-typing.md)
D2 (injected policy closure). Closes **BL-441**. Depends on merged PKT-59 (BL-440, `TypePolicy`,
commit `9ba8ec70`/`3db7ff46`), PKT-74 (BL-448, open `rel`, commit `e1d6d759`), PKT-58 (BL-439, open
`kind`, commit `ae262a2d`), PKT-73 (BL-447, structural CHECK gate, commit `37863fee`). All four are
on `main` at this worktree's base (`e1d6d759`), verified by `git log -3` before writing this spec.

Branch: `feat/pkt60-memory-ontology-seam`. Worktree:
`/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt60-memory-ontology-seam`.

---

## 1. Root cause — three distinct findings, not one

### 1a. The concrete, currently-shippable hole: `graphifyImport`'s v2 `kind` field

`libs/memory-core/src/extensions.ts:615-618` reads a caller-supplied `kind` string straight off
imported JSON with **zero validation**:

```ts
const kind =
  shapeName === 'v2'
    ? (node['kind'] as string)          // ← no check against any vocabulary
    : _mapGraphifyType(node['type'] as string | undefined);   // v1: closed 3-value map, safe
```

and raw-SQL `INSERT`s it at `extensions.ts:637-642`:

```ts
const row = await tx.executeGet<{ rowid: number }>(
  `INSERT INTO node (uid, kind, content, ...) VALUES (?, ?, ?, ...) RETURNING rowid`,
  [uid, kind, content, ...],
);
```

This function never goes through `@adhd/sox-graph-store`'s `writeNode`/`TypePolicy` at all — it is
raw SQL against the shared `node` table. Before PKT-58 (BL-439, `ae262a2d`), that raw INSERT was
still backstopped by the table's own `CHECK (kind IN (...))` constraint
(`libs/data/graph/graph-store/src/index.ts:62,181` — now `TEXT NOT NULL`, no CHECK, on every
freshly-created store). After PKT-58, **nothing** validates `node['kind']` on this path on a fresh
store: `graphifyImport({version:2, nodes:[{uid:'x', kind:'entitiy', content:'y'}], edges:[]})`
silently mints a `kind:'entitiy'` node. This is exactly BL-441's stated scenario, and it is real,
grounded code — `graphifyImport` is exported from `libs/memory-core/src/index.ts:261` and bundled
into `memory-server`'s and `memory-cli`'s shipped `dist/` (confirmed via
`grep -rln graphifyImport extensions/bundles/sox-memory-bundle/members/*/dist/index.js`). It is not
wired to a live MCP tool today (`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`
has 20 `case 'memory_*':` tool handlers, none named for graphify; GitNexus's own call-graph for
`graphifyImport` resolves only to `tools/test-graphify.js` and its own spec) — but it is public,
exported API on a published-shape package, reachable by anyone importing `@adhd/sox-memory-core`
directly (memory-cli does this in-process per ADR-0006), so "unwired today" is not "safe."

The edge half of the same function (`extensions.ts:673`, `_mapGraphifyRel` at `:716-719`) **does**
validate `rel` — against yet another hand-rolled set, `extensions.ts:705-714`'s `VALID_RELS` (8
members: missing `ASSIGNED_TO` and `DEPENDS_ON` relative to graph-store's 10). This is the third
independent rel vocabulary in the repo (the others: `libs/memory-core/src/link.ts:15`
`PUBLIC_EDGE_RELS`, 7 members; graph-store's own `DEFAULT_EDGE_RELS`, 10 members). None share a
source of truth. Fixing `extensions.ts`'s three drifting copies is out of scope for this packet
(§3, decision 6) but the node-`kind` hole in the same function is in scope because it is the literal
BL-441 reproduction.

### 1b. The nine `createGraphBackend` call sites are a real leaky-seam risk, but not a currently-live one

Confirmed by reading every one of the nine sites (`cluster.ts:749,820,886`, `enrich-batch.ts:189`,
`entity-episodes.ts:119`, `list-entities.ts:63`, `near-duplicates.ts:44`, `related.ts:95`,
`supersession-chain.ts:49`): **none of them ever call `.writeNode()` or `.writeEdge()` on the
returned backend.** `cluster.ts`'s three call sites don't even bind the return value
(`createGraphBackend(adapter);` as a bare statement) — their own comments say why:
`// GraphBackend ensures the canonical DDL (including ix_edge_unique) is applied.` (`:748`) and
`// GraphBackend instance (sibling pattern)` (`:819`, `:885`). The other six bind `const backend =`
but only call read methods (`queryNodes`, `getNode`, `getNeighbors`, etc. — grepped for
`backend\.(writeNode|writeEdge|supersede|invalidate|touch|writeGraph|writeNodeBatch)` across all six
files, zero matches). `TypePolicy.validateKind`/`validateRel` fire **only** inside `writeNode`
(`graph-store/src/index.ts:970`) and `writeEdgeInternal` (`:1179`) — read paths never reach them.

So today, **zero live behaviour depends on a policy at these nine sites.** The risk PKT-59's
reviewer flagged is prospective, and graph-store's own doc-comment says so explicitly
(`graph-store/src/index.ts:566-570`): `DEFAULT_TYPE_POLICY` is described as an interim
backward-compatible stand-in, not graph-store's intended permanent default — a future graph-store
change widening its own default to "syntactic-only" is explicitly gated on "every memory-core call
site injects its own `MemoryOntologyPolicy` explicitly (PKT-60)." This packet closes that seam
*before* it is needed, not because it is exploitable today.

### 1c. Three independent, undocumented rel/kind vocabularies already exist in memory-core

`link.ts:15` (`PUBLIC_EDGE_RELS`, 7), `extensions.ts:705-714` (`VALID_RELS`, 8),
graph-store's `DEFAULT_EDGE_RELS` (10). This is evidence that "one seam" has to mean more than
literally wrapping `createGraphBackend` — it must also be the single place memory-core's *own*
canonical vocabulary is declared, so a future consumer has one obvious place to read it from, even
though (decision 6) this packet does not migrate `link.ts`'s or `extensions.ts`'s existing
independent checks onto it.

---

## 2. The change, file by file

### NEW `libs/memory-core/src/ontology.ts`

The vocabulary + policy. No DDL access, no adapter reference — pure in-process validation, matching
`TypePolicy`'s contract (`graph-store/src/index.ts:558-561`) and D2's "no path to DDL" ruling.

```ts
import { ConstraintError, type TypePolicy } from '@adhd/sox-graph-store';

/** Byte-identical to graph-store's DEFAULT_NODE_KINDS (index.ts:257) — memory's six kinds. */
export const MEMORY_NODE_KINDS = ['episode', 'entity', 'claim', 'community', 'session', 'generic'] as const;

/** Byte-identical to graph-store's DEFAULT_EDGE_RELS (index.ts:538-549) — memory's ten rels. */
export const MEMORY_EDGE_RELS = [
  'MENTIONS', 'SUPPORTS', 'RELATES_TO', 'SUPERSEDES', 'DERIVED_FROM',
  'MEMBER_OF', 'PART_OF', 'SAME_AS', 'ASSIGNED_TO', 'DEPENDS_ON',
] as const;

export interface OntologyExtension {
  kinds?: string[];
  rels?: string[];
}

/**
 * memory-core's own TypePolicy (ADR-0010 D2). Constructed once per process by
 * graph-backend.ts's composition point — never instantiated ad hoc at a call site.
 * Accepts an optional extension set so a consumer can register additional kinds/rels
 * (BL-441's "registration surface") without forking the base vocabulary.
 */
export class MemoryOntologyPolicy implements TypePolicy {
  private readonly kinds: Set<string>;
  private readonly rels: Set<string>;

  constructor(extension?: OntologyExtension) {
    this.kinds = new Set([...MEMORY_NODE_KINDS, ...(extension?.kinds ?? [])]);
    this.rels = new Set([...MEMORY_EDGE_RELS, ...(extension?.rels ?? [])]);
  }

  validateKind(kind: string): void {
    if (!this.kinds.has(kind)) {
      throw new ConstraintError(
        `Unknown node kind "${kind}". Allowed kinds: ${[...this.kinds].join(', ')}.`,
      );
    }
  }

  validateRel(rel: string): void {
    if (!this.rels.has(rel)) {
      throw new ConstraintError(
        `Unknown edge rel "${rel}". Allowed rels: ${[...this.rels].join(', ')}.`,
      );
    }
  }
}

/**
 * Rewrites a raw SQLite CHECK-constraint failure on kind/rel into an operator-facing
 * message naming the migration that removes the CHECK on this store (BL-442/PKT-61).
 * Pure string inspection — no adapter, no DDL, no schema read. Call this in the catch
 * block of any write path that can hit graph-store's writeNode/writeEdgeInternal, so a
 * kind/rel the POLICY permits but a not-yet-migrated store's CHECK still forbids produces
 * a comprehensible error instead of a raw "CHECK constraint failed: kind" string.
 *
 * NOTE (BL-442 not yet landed): until PKT-61 ships the migration command, the message
 * below names the *future* command as not-yet-available. Update the wording once BL-442
 * lands (tracked so this doesn't ship a dangling pointer to a nonexistent command).
 */
export function translateStoreVocabularyError(err: unknown): never {
  if (err instanceof Error && /CHECK constraint failed/.test(err.message)) {
    throw new ConstraintError(
      `${err.message} — this store still enforces the closed kind/rel vocabulary. ` +
      `A policy-permitted kind or rel was rejected by the store's schema; run the ` +
      `open-schema migration (BL-442) on this store to lift the CHECK, or use one of ` +
      `today's built-in kinds/rels in the meantime.`,
    );
  }
  throw err;
}
```

**Decision on `translateStoreVocabularyError`'s wiring**: it is called explicitly, by name, only
from `graphifyImport`'s node-insert catch block (§2, `extensions.ts`) — the one place this packet
gives a validated write a path to actually hit a legacy CHECK. It is **not** wired into
`writeEdgeInternal`'s existing `ConstraintError` translation inside graph-store (that file must not
import memory-core — §3 decision 3) and it is **not** retrofitted onto `write.ts`/`link.ts`, whose
kind/rel values are always closed-set literals today (§3 decision 5) and therefore can never hit
this branch.

### NEW `libs/memory-core/src/graph-backend.ts`

The single composition point. This is the **only** file in `libs/memory-core/src/` permitted to
call `createGraphBackend` from `@adhd/sox-graph-store` — enforced by the structural test in §4.

```ts
import { createGraphBackend, type GraphBackend } from '@adhd/sox-graph-store';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { MemoryOntologyPolicy, type OntologyExtension } from './ontology.js';

let registeredExtension: OntologyExtension = {};

/**
 * Registration surface (BL-441): an in-process consumer sharing this store (per
 * ADR-0006, DI for live objects — never a new module boundary) can extend the base
 * vocabulary before any backend is constructed. Last-registration-wins is deliberate:
 * this is a process-wide policy, not a per-call override, so there is exactly one
 * vocabulary in force for the life of the process — call this once, at startup, before
 * the first getMemoryGraphBackend() call. Calling it after backends already exist does
 * NOT retroactively change them (each SqliteGraphBackend captures its TypePolicy at
 * construction, graph-store/src/index.ts:888-890) — it only affects backends
 * constructed after the call.
 */
export function registerOntologyExtension(extension: OntologyExtension): void {
  registeredExtension = {
    kinds: [...(registeredExtension.kinds ?? []), ...(extension.kinds ?? [])],
    rels: [...(registeredExtension.rels ?? []), ...(extension.rels ?? [])],
  };
}

/** Read-only snapshot for observability (memory_stats — see index.ts change below). */
export function getOntologySnapshot(): { kinds: string[]; rels: string[] } {
  const policy = new MemoryOntologyPolicy(registeredExtension);
  // MemoryOntologyPolicy doesn't expose its internal Sets; rebuild the union directly
  // from the same inputs it was constructed from, so the snapshot and the policy can
  // never drift relative to each other.
  return {
    kinds: [...new Set(['episode', 'entity', 'claim', 'community', 'session', 'generic', ...(registeredExtension.kinds ?? [])])],
    rels: [...new Set(['MENTIONS', 'SUPPORTS', 'RELATES_TO', 'SUPERSEDES', 'DERIVED_FROM', 'MEMBER_OF', 'PART_OF', 'SAME_AS', 'ASSIGNED_TO', 'DEPENDS_ON', ...(registeredExtension.rels ?? [])])],
  };
}

/**
 * memory-core's ONE composition point for graph-store backends. Every memory-core
 * module that needs a GraphBackend calls this — never createGraphBackend directly.
 * See ontology-seam.pkt60.spec.ts for the structural test enforcing that invariant.
 */
export function getMemoryGraphBackend(adapter: StoreAdapter): GraphBackend {
  return createGraphBackend(adapter, { typePolicy: new MemoryOntologyPolicy(registeredExtension) });
}
```

**Export `MEMORY_NODE_KINDS`/`MEMORY_EDGE_RELS` directly from `getOntologySnapshot`'s own module
constants instead of re-deriving the literal arrays inline** — implementer note: the inline literals
above are written out for spec clarity; the actual implementation MUST import `MEMORY_NODE_KINDS`/
`MEMORY_EDGE_RELS` from `./ontology.js` rather than re-typing the six/ten strings a third time. (Two
copies — `ontology.ts`'s constants and `MemoryOntologyPolicy`'s constructor reading them — is the
single source of truth; a hand-typed third copy in `getOntologySnapshot` is exactly the drift this
packet exists to stop. Fix this before committing; it is called out here because the spec's own
example must not become the fourth vocabulary copy in the codebase.)

### MODIFIED — the nine `createGraphBackend` call sites

Replace `createGraphBackend(adapter)` → `getMemoryGraphBackend(adapter)`, and the import
`import { createGraphBackend } from '@adhd/sox-graph-store';` → 
`import { getMemoryGraphBackend } from './graph-backend.js';`, in:

- `cluster.ts:18` (import), `:749`, `:820`, `:886` (three call sites — bare statements, keep them bare)
- `enrich-batch.ts:21` (import), `:189`
- `entity-episodes.ts:11` (import), `:119`
- `list-entities.ts:11` (import), `:63`
- `near-duplicates.ts:11` (import), `:44`
- `related.ts:11` (import), `:95`
- `supersession-chain.ts:13` (import), `:49`

No other line in any of these seven files changes. These are read-heavy modules; this change alters
zero runtime behaviour today (§1b) — it only removes graph-store's `@adhd/sox-graph-store` import of
`createGraphBackend` from seven files and centralises it in one.

### MODIFIED `libs/memory-core/src/extensions.ts` — the actual BL-441 fix

At `extensions.ts:614-618` (the v2-shape kind derivation), add validation before the value is used:

```ts
const kind =
  shapeName === 'v2'
    ? (node['kind'] as string)
    : _mapGraphifyType(node['type'] as string | undefined);
if (shapeName === 'v2') {
  new MemoryOntologyPolicy().validateKind(kind);   // throws ConstraintError on unregistered kind
}
```

Wrap the `INSERT INTO node` at `extensions.ts:637-642` (inside the existing `adapter.transaction`
callback) so a legacy-store CHECK failure gets the operator-facing message, not a raw SQLite string:

```ts
let row: { rowid: number } | undefined;
try {
  row = await tx.executeGet<{ rowid: number }>(
    `INSERT INTO node (uid, kind, content, name, summary, agent_id, source, importance, content_hash, t_created, t_valid)
     VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)
     RETURNING rowid`,
    [uid, kind, content, name, summary, agentId, importance, contentHash, now, now],
  );
} catch (err) {
  translateStoreVocabularyError(err);
}
```

Add the two imports (`MemoryOntologyPolicy` from `./ontology.js`, `translateStoreVocabularyError`
from `./ontology.js`) at the top of `extensions.ts`. **This is the only place in `extensions.ts`
that changes.** The `_mapGraphifyRel`/`VALID_RELS` edge-side vocabulary (`:705-719`) is unchanged
(§3 decision 6 — do not touch it in this packet).

### MODIFIED `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`

**Contention check performed**: `git status --porcelain -- .../memory-server/src/index.ts` is clean
at this worktree's base commit (`e1d6d759`); `git log -3` on the file shows no in-flight PKT work
touching it as of this spec's writing. Re-run both before editing — other agents may have landed
work between spec-writing and implementation.

One additive change inside the existing `case 'memory_stats':` handler (`index.ts:1923-1960`),
following the file's own stated convention at `:1929` (*"Additive (HF-3): never rename or remove
existing stats fields"*) and the same pattern used for `integrity`/`telemetry_self_check` two lines
above:

```ts
// BL-441: expose the registered ontology vocabulary — the same additive,
// best-effort pattern as integrity/telemetry_self_check above.
const withOntology = {
  ...withTelemetry,
  ontology: getOntologySnapshot(),
};
return {
  content: [{ type: 'text', text: JSON.stringify(withOntology) }],
};
```

Add one import: `import { getOntologySnapshot } from '@adhd/sox-memory-core';` alongside the
existing `@adhd/sox-memory-core` import block at `index.ts:89-90` (re-export it from
`libs/memory-core/src/index.ts`'s public barrel, next to `graphifyImport` at `:261`, per that
file's existing pattern). **This is the entire `memory-server/src/index.ts` diff for this
packet** — one field addition to one existing case block, plus one import line. Nothing in the
20-line `TOOLS` array, no new tool, no change to any `memory_write`/`memory_write_batch` handler
(the contended block at `index.ts:1154-1430` is explicitly untouched — see decision 5, §3).

**Files explicitly OUT OF BOUNDS for this packet, and why:**

- `libs/data/graph/graph-store/src/index.ts` — PKT-59/PKT-74 already landed everything this packet
  needs there (`TypePolicy`, `DEFAULT_TYPE_POLICY`, open `kind`/`rel`). Editing it here would
  re-touch a file four other packets already finished, and any DDL edit specifically is banned by
  ADR-0010's own "don't re-litigate" framing.
- `libs/memory-core/src/write.ts`, `link.ts` — both write only closed-set literal kinds/rels today
  (`'episode'`, `'entity'`, `'MENTIONS'`, `'DERIVED_FROM'` in `write.ts`; `rel` validated against
  `PUBLIC_EDGE_RELS` before any INSERT in `link.ts`). Adding `MemoryOntologyPolicy` calls to code
  paths that can never receive an invalid value is inert churn, not a fix — decision 5, §3.
- `memory-server/src/index.ts`'s `memory_write`/`memory_write_batch`/`memory_curate` handler bodies
  (`:1154-1430`, `:685-714`) — zero relationship to this packet's scope; this file is explicitly
  called out as heavily contended and the instruction is to keep the edit minimal and localised.

---

## 3. Every decision, ruled

**1. Scope of "the seam": composition-point wrapper only, or also the vocabulary itself?**
**Ruling: both — `ontology.ts` (vocabulary + policy) and `graph-backend.ts` (composition point) are
two files, not one, because they have different reasons to change** (vocabulary changes when memory's
domain model changes; the composition point changes only if graph-store's construction API changes).
**Losing alternative — one file.** Rejected: would conflate "what memory-core's ontology is" with
"how a GraphBackend gets built," and the registration-surface function (`registerOntologyExtension`)
belongs conceptually with construction, not with the pure-validation `MemoryOntologyPolicy` class —
merging them would put mutable process state in the same module as a class whose whole point (D2) is
that it holds no state a DDL operation could reach.

**2. Registration surface shape: threaded parameter vs. module-level mutable registry.**
**Ruling: module-level registry (`registerOntologyExtension` + implicit read inside
`getMemoryGraphBackend`).** **Losing alternative — thread `extension?: OntologyExtension` through
`getMemoryGraphBackend(adapter, extension?)` and every one of the nine call sites.** Rejected because
it reintroduces exactly the leaky-seam defect BL-441 names: nine places that could each independently
forget to pass the extension, reviewed as total when it is partial. A module-level registry set once
at process start (memory-server's init, or an in-process consumer's own bootstrap) means every
`getMemoryGraphBackend(adapter)` call — new or old, forgetting nothing — automatically picks up
whatever is registered. The cost (global mutable state in a library module) is real but bounded: it
is process-lifetime, set-once-at-startup, and read-only after that in every code path this packet
touches; `registerOntologyExtension`'s own doc comment states the "last-registration-wins,
no-retroactive-effect" contract so a caller cannot be surprised by it.

**3. Where does the vocabulary live: memory-core, or a shared package graph-store also depends on?**
**Ruling: memory-core only, injected downward.** This is ADR-0010 D2 verbatim ("policy *descends* by
DI, it is never imported upward") and `libs/data/CLAUDE.md`'s boundary rule ("`data→memory-core` is
also forbidden"). **Losing alternative — a new tiny shared package (`@adhd/sox-memory-ontology`) both
graph-store and memory-core depend on.** Rejected: graph-store's `TypePolicy` interface is already
generic (`validateKind`/`validateRel`, no memory-specific vocabulary baked in) — a shared package
would only be justified if a *second* consumer needed the exact six-kind/ten-rel vocabulary, which
none does. Introducing a package for a single consumer is unnecessary indirection the boundary rule
doesn't require.

**4. Should `MemoryOntologyPolicy`'s vocabulary be a byte-identical copy of graph-store's
`DEFAULT_NODE_KINDS`/`DEFAULT_EDGE_RELS`, or independently curated?**
**Ruling: byte-identical copy, by explicit requirement, not coincidence.** BL-441's acceptance
criterion (c) inherited from BL-440 requires "a caller passing no `typePolicy` observes today's
six-kind and ten-rel behaviour unchanged" — and this packet's whole point is that memory-core no
longer *relies* on that being graph-store's default (§1b), so its own copy must match it exactly
today. **Losing alternative — start curating memory's vocabulary now** (e.g. drop `'generic'` per
its now-discouraged status, BL-440's problem statement). Rejected: out of scope for a seam-closing
packet, and would make this packet a silent behaviour change riding on an architectural one — any
vocabulary curation is a separate, explicitly-flagged decision for a future packet.

**5. Should this packet also validate `write.ts`'s and `link.ts`'s already-closed-set kind/rel
values through `MemoryOntologyPolicy`?**
**Ruling: no.** Both paths only ever write literal, closed-set values today (§2, "out of bounds").
Routing a hardcoded `'episode'` string through a validator that can only ever accept it is dead
weight — it adds an import, a call, and a test surface with no behaviour it protects. **Losing
alternative — do it anyway, for "defense in depth."** Rejected on the packet's own instruction to
keep memory-server's `index.ts` edit minimal and localised, and because "validate everything that
touches the tables" is the audit-every-statement approach BL-440's own problem statement explicitly
rejected in favour of "two enforcement points, both verified funnels."

**6. Should this packet also consolidate `link.ts`'s `PUBLIC_EDGE_RELS` and `extensions.ts`'s
`VALID_RELS` onto `MEMORY_EDGE_RELS`?**
**Ruling: no — file it as backlog, do not fix here.** `PUBLIC_EDGE_RELS` (7 members) is deliberately
a *narrower* tool-surface subset (per graph-store's own doc comment at `:534-535`: "memory-core's own
7-member tool-surface subset, unrelated to this constant"), not a drifted copy of the same
vocabulary — collapsing it into `MEMORY_EDGE_RELS` (10 members) would *change* `memory_link`'s public
contract (accepting `MEMBER_OF`/`PART_OF`/`DEPENDS_ON` where it doesn't today), which is out of this
packet's authorization. `extensions.ts`'s `VALID_RELS` (8 members) IS a drifted duplicate with no
principled reason for its 8-vs-10 shape, and is a genuine latent bug (missing `ASSIGNED_TO`/
`DEPENDS_ON` for graphify imports) — but fixing it is a scope change to `_mapGraphifyRel`'s
behaviour beyond BL-441's stated fix (the node-`kind` hole), and touching it risks widening this
packet's diff into `extensions.ts`'s edge-import path with no acceptance criterion covering it.
**File to BACKLOG.md as a new item** (see §5) rather than fold it in silently.

**7. What does "through the memory-server tool surface" mean when no live MCP tool reaches
`writeNode`/`writeEdge` with a caller-controlled kind/rel?**
**Ruling: "memory-core's real production composition point," not "a bespoke `createGraphBackend()` +
policy built only inside the test file."** The acceptance test for the `getMemoryGraphBackend`
seam (§4, AC-3/AC-4) constructs the backend via `getMemoryGraphBackend()` — the exact function every
memory-server code path would use — rather than calling `createGraphBackend()` directly with an
ad-hoc policy, which is what a pre-PKT-60 regression test would have had to do. The `graphifyImport`
regression test (AC-1/AC-2) calls memory-core's actual exported `graphifyImport()`, which is bundled
into `memory-server`'s own shipped `dist/`, satisfying "not the raw store" literally: no test in this
packet constructs a `SqliteGraphBackend` and calls `.writeNode()` on it directly to prove the
BL-441 scenario — every BL-441 acceptance test goes through a function memory-server itself ships.
**Losing alternative — wire a new `memory_graphify_import` MCP tool in this packet so the test can
call it as a literal `tools/call`.** Rejected: adding a new tool is a product surface decision (name,
schema, docs, `TOOLS` array entry, `CLAUDE.md` update) far outside "close the ontology seam," and the
task's own file list does not authorize a new tool.

**8. Does `translateStoreVocabularyError` belong in `ontology.ts` or `graph-backend.ts`?**
**Ruling: `ontology.ts`**, next to `MemoryOntologyPolicy` — it is pure string-inspection with zero
adapter/DDL access, same category of "no path to DDL" as the policy class itself, and keeping it
beside the policy means anyone reading the policy's contract also sees the one place a CHECK-still-
closed store's error gets translated, instead of hunting across two files.

---

## 4. Acceptance criteria, each naming a BL-id, each with a stated RED arm

All new tests live in `libs/memory-core/src/`, named `<topic>.bl441.spec.ts` per the repo's
established `<topic>.bl<NNN>.spec.ts` convention (e.g. `graph-store/src/type-policy.bl440.spec.ts`,
`graph-store/src/open-rel-check.bl448.spec.ts`).

### AC-1 — unregistered `kind` via `graphifyImport` v2 is rejected (BL-441)
**Assertion:** `graphifyImport(adapter, {version:2, nodes:[{uid:'x', kind:'entitiy', content:'y'}], edges:[]})`
returns `{ ok: false, ... }` (or throws `ConstraintError` — pick whichever `graphifyImport`'s existing
error-return convention uses; it currently returns typed error objects rather than throwing, so the
implementer should catch the `ConstraintError` from `validateKind` at the call site and translate it
into that same `GraphifyImportError` shape, consistent with the function's existing error handling —
**do not let this one validation path throw past the function boundary while every other
`graphifyImport` failure mode returns an object; that inconsistency is itself a defect**), and that
no row exists afterward with `kind = 'entitiy'`.
**RED arm:** on the merge-base commit (`e1d6d759`, before this packet's `extensions.ts` edit), the
identical call **succeeds**, returns `{ ok: true, imported: 1, ... }`, and a
`SELECT kind FROM node WHERE uid = 'x'` returns `'entitiy'`. Run this exact assertion against
`e1d6d759` first (e.g. `git stash`-free — check out the pre-fix `extensions.ts` into a scratch copy,
or simply run the test before writing the fix and confirm it fails) to prove RED, then implement,
then confirm GREEN.

### AC-2 — legitimate v2 kind still works end to end (BL-441 non-regression)
**Assertion:** the same call with `kind: 'entity'` succeeds, `imported: 1`, and the row's `kind`
column reads `'entity'`.
**RED arm:** not applicable as a red/green pair (this is a non-regression guard) — but it MUST be
run in the same suite so a future change to the validation call can't silently reject legitimate
kinds; if this assertion is ever red, that is itself the signal to revert or fix the validation.

### AC-3 — unregistered `kind`/`rel` rejected through memory-core's real composition point (BL-441)
**Assertion:** `const backend = getMemoryGraphBackend(adapter); await backend.applySchema();` then
`await expect(backend.writeNode('x', { kind: 'entitiy' })).rejects.toThrow(ConstraintError)` and
`await expect(backend.writeEdge(n1, n2, 'BOGUS_REL')).rejects.toThrow(ConstraintError)` (using two
prior legitimately-written nodes for the edge case).
**RED arm:** before this packet, no `getMemoryGraphBackend` export exists — the test file itself
does not compile/run without the new module. This satisfies BL-225's red arm in the strict sense
("watch it fail without the fix") because the fix's absence is a compile error, the strongest
possible red. Additionally (for a runtime-red, not just compile-red, demonstration): a variant of
this test constructed with bare `createGraphBackend(adapter)` (no typePolicy) against a **fresh
open-schema store** (post-PKT-58/74 DDL) currently accepts `kind: 'entitiy'` silently — confirm this
variant passes today (i.e., the write succeeds) to demonstrate the exact gap `getMemoryGraphBackend`
closes, then delete that demonstration variant (or keep it clearly labelled as "pre-fix behaviour,
not a target state") before merging, so it doesn't read as an endorsed pattern.

### AC-4 — legitimate registered kind/rel accepted end to end through the composition point (BL-441)
**Assertion:** all six `MEMORY_NODE_KINDS` and all ten `MEMORY_EDGE_RELS` are individually accepted
by `getMemoryGraphBackend(adapter)`'s `writeNode`/`writeEdge` (parametrized test, 16 cases) — writes
succeed, and a subsequent `getNode`/`getEdges` read confirms the value round-tripped.
**RED arm:** not a red/green pair — non-regression coverage proving the byte-identical-vocabulary
ruling (decision 4) actually holds, so any accidental narrowing of `MEMORY_NODE_KINDS`/
`MEMORY_EDGE_RELS` relative to graph-store's own constants shows up immediately.

### AC-5 — the seam is structurally single (BL-441's stated most-valuable test)
**Assertion:** a test that greps (or uses the TS compiler API / a simple regex over file contents —
implementer's choice, document which) every `.ts` file under `libs/memory-core/src/` (excluding
`graph-backend.ts` itself and `*.spec.ts` files) for the literal pattern
`createGraphBackend(` preceded by an import of `createGraphBackend` from `'@adhd/sox-graph-store'`
in that same file, and asserts the match count is **zero**. Equivalently: assert that
`grep -rn "from '@adhd/sox-graph-store'" libs/memory-core/src/*.ts | grep -v graph-backend.ts | grep -v '\.spec\.ts'`
lines that also import `createGraphBackend` number zero, OR (stronger, preferred) parse each file's
import specifiers and named imports directly rather than string-matching, to avoid a false pass if
someone renames the import (`import { createGraphBackend as cgb }`).
**RED arm:** run this exact test against the merge-base commit `e1d6d759` (before this packet's
seven-file edit) — it MUST fail, reporting exactly nine violations (the nine call sites named in
§1b/§2), naming each file:line. Confirm the count is exactly 9, not "some number" — a red arm that
doesn't name the count can't be distinguished from a broken test. After this packet's edit, the same
test must report zero.
**This is the test PKT-60's own task description calls "the most valuable test in the packet"** —
implement it first, watch it go red with a named count of 9 against `e1d6d759`, then make the seven
call-site edits, then watch it go green.

### AC-6 — `TypePolicy` still has no path to DDL (BL-440's invariant, re-verified after this packet)
**Assertion:** `grep -c "this\.typePolicy" libs/data/graph/graph-store/src/index.ts` equals exactly
`3` (constructor default assignment, `writeNode`'s `validateKind` call, `writeEdgeInternal`'s
`validateRel` call), and none of the three lines are inside `applySchema` or `ensureCheckConstraints`
(line-range check: `applySchema` is `:893-913`, `ensureCheckConstraints` is `:915-958` per this
spec's own citations — confirm those ranges haven't shifted before asserting against them).
**RED arm:** this packet does not touch `graph-store/src/index.ts` at all (§2, out of bounds), so
this assertion should already be green before AND after this packet — it is included as a
regression tripwire, not a red→green pair. If it is ever red, STOP: this packet or a concurrent one
has created a path from a consumer's type declaration to DDL, which is the BL-295/BL-313 failure
mode ADR-0010 D2 exists to foreclose, and per the task's own instruction ("If a design review finds
any input by which registering a type can alter the schema, the design is wrong") the implementer
must stop and report rather than proceed.

### AC-7 — `memory_stats` exposes the registered ontology, additively (BL-441 registration surface)
**Assertion:** a `memory_stats` call's JSON response includes an `ontology: { kinds: [...6 values],
rels: [...10 values] }` field, and every field present in `memory_stats`'s response **before** this
packet (per `CLAUDE.md`'s documented output list: `tools, enrich_version, embed_model,
embed_backend_configured, total_episodes, with_topic, with_summary, with_tags, with_project_path,
with_community, legacy_episodes, stale_episodes, cluster_count, largest_cluster_size,
mean_intra_cluster_sim, coverage, cluster_quality, integrity, integrity_headline,
telemetry_self_check`) is still present and unchanged in shape.
**RED arm:** before this packet, `ontology` is absent from the response (`undefined`) — assert this
against the merge-base build first (or simply assert absence in a "before" comment/skipped case,
since a full pre-fix build-and-run round trip for this single field is lower value than AC-1/AC-5's
red arms — the implementer may satisfy this RED arm by demonstrating the field is `undefined` when
`getOntologySnapshot` is not yet wired into `index.ts`'s stats handler, i.e. a unit-level check on
the handler's output shape before vs. after the one-line addition).

---

## 5. Backlog disclosure (file at implementation time, per CLAUDE.md's disclosure protocol)

Decision 6 (§3) identifies a genuine, previously-undiscovered latent bug that this packet
deliberately does not fix: `libs/memory-core/src/extensions.ts:705-714`'s `VALID_RELS` (8 members)
silently rejects `ASSIGNED_TO` and `DEPENDS_ON` on graphify-imported edges, with no principled
reason for the narrower set relative to graph-store's 10-member `DEFAULT_EDGE_RELS`. **File this to
`BACKLOG.md` at implementation time**, citing `libs/memory-core/src/extensions.ts:705-719`, dedupe-
scanned against existing BL-440/BL-441/BL-448 entries first (it is related but distinct — those are
about the CHECK/TypePolicy seam; this is about a fourth, independently-drifted vocabulary copy that
predates all of them) and cross-linked to BL-441.

---

## 6. Risks and sequencing

- **No DDL edit anywhere in this packet** — the single largest risk category from the wider Wave J
  (BL-313-style cascade-delete via `rebuildTable`) categorically cannot occur, because this packet
  never touches `graph-store/src/index.ts`, never calls `rebuildTable`, and `ensureCheckConstraints`
  is not on any path this packet's tests exercise for write purposes beyond what PKT-59/73/74's own
  suites already cover. AC-6 exists specifically to catch a regression that would create such a path.
- **`extensions.ts`'s `adapter.transaction` callback** — the try/catch added around the node INSERT
  (§2) must not swallow the transaction's atomicity: `translateStoreVocabularyError` re-throws
  (it is typed `never` — always throws), so the transaction still aborts on a CHECK failure exactly
  as it did before this packet; only the error's *message* changes, not the transaction's outcome.
  Verify this with a test asserting the transaction rolls back (no partial node/vec_node/edge rows)
  on a translated error, mirroring `graphifyImport`'s existing "atomic import only after full
  validation" invariant stated in its own docstring (`extensions.ts:504-509`).
- **`memory-server/src/index.ts` contention** — re-run `git status --porcelain` and
  `git log -5 -- extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` immediately
  before editing (not just at spec-writing time); if another agent has landed work on the
  `memory_stats` case block since `e1d6d759`, re-read the current state of that block before writing
  the diff in §2 rather than assuming the line numbers cited here still hold.
- **`nx build`/`nx test` destructiveness (BL-235/BL-456)** — this packet touches `memory-core` (a
  dependency of `memory-server`, `memory-cli`, `memory-flush`) and `memory-server` itself. Before any
  `npx nx build memory-server`, confirm `libs/memory-core` and `libs/data/graph/graph-store` compile
  cleanly first via `npx nx typecheck` (non-destructive) — do not run a diagnostic build to "see the
  error." Report `node tools/check-suite-tree-state.mjs --project memory-core` and `--project
  memory-server` alongside every test result, per the house rules.
- **Registry sync** — this packet does not change `memory-server`'s bundled `dist/` checksum surface
  by itself until `npx nx build memory-server` is run as part of the normal ship sequence; when it
  is, run `npx nx run registry:sync-index` and commit the regenerated `registry/index.json` in the
  same commit as the rebuilt bundle, per the repo-wide AGENT SEQUENCE rule.

---

## 7. The gate — exact nx targets, in order

```
npx nx typecheck graph-store          # confirm no accidental drift on the dependency this reads from
npx nx typecheck memory-core
npx nx lint memory-core
npx nx test memory-core -- src/ontology-seam.bl441.spec.ts        # AC-5, run first, confirm RED (9), then GREEN (0)
npx nx test memory-core -- src/graphify-kind.bl441.spec.ts        # AC-1, AC-2
npx nx test memory-core -- src/graph-backend.bl441.spec.ts        # AC-3, AC-4
npx nx test memory-core                                            # full project suite — no regression
npx nx typecheck memory-server
npx nx lint memory-server
npx nx build memory-core              # DESTRUCTIVE — only once source typechecks clean (BL-235)
npx nx build memory-server            # DESTRUCTIVE — only after memory-core build succeeds
node tools/check-suite-tree-state.mjs --project memory-core
node tools/check-suite-tree-state.mjs --project memory-server
npx nx run registry:sync-index        # only if memory-server's dist changed
```

Test filenames above are suggested groupings; the implementer may split/merge them but every AC-1
through AC-7 must be traceable to a named test with "bl441" in its filename or `describe` block, per
`BACKLOG.md`'s citation requirements.

Commit sequence (by pathspec, per house rules): (1) `ontology.ts` + `graph-backend.ts` new files +
their spec(s); (2) the seven call-site edits, one commit, with AC-5 passing; (3) `extensions.ts`'s
`graphifyImport` fix + its spec; (4) `memory-server/src/index.ts`'s one-field `memory_stats` addition
+ the `index.ts` barrel re-export of `getOntologySnapshot`; (5) `registry/index.json` sync, if a
build was run. Do not squash these into one commit — each is independently revertible and each has
its own acceptance criterion.
