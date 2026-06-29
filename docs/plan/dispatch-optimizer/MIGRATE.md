# MIGRATE.md — dispatch-optimizer migration issues

Each entry describes a discovered data/design gap that must be resolved before the
dispatch optimizer can operate correctly. Fields per entry:

- **Situation** — what is wrong and why it matters to the optimizer
- **Skill scripts** — which scripts in `plan-state-machine/scripts/` are involved
- **Data source** — where the correct data already lives and what to extract
- **Current shape** — what the data looks like today (broken/incomplete)
- **Correct shape** — what it needs to look like
- **Expectations** — which `audit.js` expectations are affected (wrong check, missing check, or blocked)

---

## § 0 — Agent Decision Surface at Plan Creation and Update

This section defines the three-layer data model, what an authoring agent must
explicitly decide, and what is computed at each layer. Maintained as the schema evolves.

### Three-layer model

| Layer | File | Mutated by | Contains |
|---|---|---|---|
| **Intent + execution log** | `dag.json` | Plan-builder (authored fields); orchestrator (appends to `attempts[]` on each operation) | The authored nucleus and the full execution attempt log. Single persistent document — no separate state file. |
| **Compiled snapshot** | `dag-snapshot.json` | Orchestrator (regen each scheduling cycle) | `dag.json` + gitnexus annotation + filesystem stats + all derived fields. The source of truth for scheduling decisions. Never checked in as source. |

### Authored nucleus — the agent must decide these

**Node-level:**

| Field | Why authored |
|---|---|
| `kind` | Intent — work, audit, or review |
| `phase` | Structural grouping |
| `depends_on[]` | Ordering constraints — only the agent knows the semantic dependency |
| `guard` | The specific pinned command that proves the state is done |
| `context` | Which context file the executor reads |
| `notes` | Human-readable rationale |
| `model`, `effort` | Dispatch tier selection |
| `two_stage`, `eligible` | Execution mode flags |

**Per `changes[]` item — the agent must decide these:**

| Field | Why authored |
|---|---|
| `action` | High-level operation intent: `create \| delete \| move \| rename \| modify-signature \| modify-body \| add-export \| remove-export` |
| `file` | The file being touched |
| `symbol` | The exported symbol (code files) or `null` (non-code files) |
| `provenance` | How this change was discovered: `gitnexus \| manual \| assumed \| vendored` — applies to any change, not only typed contracts |
| `confidence` | How certain we are in the declared shape: `verified \| vendored \| documented \| assumed` |
| `audit_check` | Criterion ID that verifies this change is complete, or `null` |
| `shape.kind` | Artifact type: `function \| interface \| type \| class \| enum \| const \| config \| env \| doc \| schema \| manifest \| script` — confirms which op vocabulary applies |
| `shape.ops[].op` | The specific structural operation (e.g. `add-param`, `set-key`, `rename-column`) |
| `shape.ops[].target` | The named element being changed: param name, field name, key path, section heading, var name, `table.column` |
| `shape.ops[].to` | The **intended new** value, type, or name — this is the forward intent the agent declares |
| `shape.ops[].position` | Ordering index for param reorder or column position ops |
| `shape.ops[].required` | Optionality of new params or fields — required to derive `breaking` |
| `to_file` | Destination path for `move` |
| `to_symbol` | New name for `rename` |

### Inferrable at authoring time — annotation pass derives these

After the agent writes the nucleus, a `dag annotate` pass populates the following.
The agent **may** supply these for override; if absent the pass fills them in.

| Field | Source | How |
|---|---|---|
| `shape.kind` | File extension + symbol kind | `.ts` + `function` keyword → `function`; `.json` → `config`; `.md` → `doc` etc. (TypeScript AST or MIME heuristic) |
| `shape.ops[].from` | Current value/type at `file::symbol` | TypeScript AST parse for code; file read + key lookup for config/env; gitnexus `context` for interface shape |
| `shape.ops[].breaking` | Op semantics table | Deterministic: `(op, required, from→to)` lookup — no LLM required |
| `shape.ops[].severity` | Same table | Same pass as `breaking` |
| `blast_radius[].file/symbol/impact` | gitnexus | `gitnexus_impact({ target: symbol, direction: "upstream" })` for `consumer: "current"` items |
| `blast_radius[].consumer: "future"` | Cross-node scan | Scan sibling nodes' `changes[]` for `action: create \| add-export` entries whose new symbol references this one |
| `artifacts[]` (node level) | `changes[]` | Union of `changes[].file` for write actions (`create`, `modify-*`, `add-export`, `remove-export`, `rename`); `to_file` for `move`; `delete` source excluded |
| `si_bytes` (node level) | Filesystem | `sum(bytesize(f) for f in artifacts[])` — stat pass after `artifacts[]` is resolved |

### Inferrable at execution time — orchestrator derives these

Computed at wave-scheduling time after prior nodes have completed:

| Computation | Source | How |
|---|---|---|
| Current resolved shape of `file::symbol` | Completed node `changes[]` | Walk completed nodes in topological order; last entry matching `(file, symbol)` gives the live delta; baseline from `interfaces.json` if no completed node has touched it |
| Conflict detection | Cross-node op analysis | For nodes scheduled in the same wave, group ops by `(target, op-category)` — collision = potential conflict |
| Merge vs error classification | `breaking` + `severity` on conflicting ops | Same `to` → deduplicate (info); orthogonal `op-category` → safe merge; same target + different `to` → error; one breaking + one non-breaking same target → warning, sequenceable |
| `pairwise_overlap` (plan level) | Resolved `artifacts[]` sets | `\|Si ∩ Sj\|` computed across wave-scheduled nodes at scheduling time |
| `wave` assignment | Topological sort + conflict graph | Orchestrator assigns; agent never authors this |

### What the agent must NOT hand-author

These fields must be left null/absent for the annotation pass to own:

- `shape.ops[].from` — always read from current source state; hand-authoring creates drift
- `shape.ops[].breaking` / `severity` — deterministic from op table; hand-authoring creates inconsistency
- `blast_radius[]` — gitnexus pass; hand-authoring goes stale immediately
- `artifacts[]` — derived from `changes[]`; if you hand-author it separately from `changes[]`, they diverge
- `si_bytes` — filesystem stat; stale the moment any file is edited
- `wave` — orchestrator assigns at scheduling time

---

## M-001 — plan-index.json collapses per-state mutations to a flat plan-level union

**Situation**

`plan-scan.js::mutateSet()` unions every node's `artifacts[]` across all states
into a single flat array stored as `mutate_set` in plan-index.json. This is
sufficient to answer "do these two plans conflict at all?" but destroys the
per-state granularity required for:

1. **Cross-plan state-level scheduling** — the dispatch optimizer packs states from
   multiple plans into waves. Without knowing which specific state of plan A touches
   which files, it cannot determine whether `plan-A/state-X` and `plan-B/state-Y`
   can safely run in the same wave. It is forced to either treat entire plans as
   atomic units (massive parallelism loss) or ignore cross-plan reservations (unsafe).

2. **Mutation-type-aware ordering** — `dag.json` nodes carry a `changes` object with
   typed mutations (`deletes`, `resigns`, `renames`, `adds_set_members`). A rename of
   file X → Y creates a hard ordering dependency for any downstream state that reads X.
   With the flat union, all artifact relationships look like plain write conflicts —
   rename-induced ordering constraints are invisible to the cross-plan scheduler.

3. **Step-splitting context** — the original within-plan conflict resolver used per-state
   reservation data to determine which steps of the same phase could run in parallel.
   `compile-task.js --board` recomputes this on demand from `dag.json`, but there is
   no persistent store, and plan-index.json (which should serve as that store) only
   carries the plan-level blob.

The agent implementing Phase 7 (commit `37a651e`, `workflow-agent-builder`) designed
`plan-scan.js` to solve only the coarse plan-level conflict question and never emitted
per-state data. The underlying data (per-state artifacts and changes) exists in every
`dag.json` — `plan-scan.js` simply does not read it at that granularity.

**Skill scripts**

| Script | Role | Problem |
|---|---|---|
| `scripts/lib/plan-scan.js` | Derives the plan-index row | `mutateSet()` collapses all states; no `stateMutations()` function |
| `scripts/plan-index.js` | Writes plan-index.json | Passes through whatever `scanPlan()` returns; no schema change needed here once scan is fixed |
| `scripts/cross-plan-check.js` | Conflict + dependency derivation | `conflicts()` returns plan-level pairs; needs state-level pairs with mutation types |

**Data source**

`dag.json` — already contains per-state data in `nodes`:

```jsonc
// dag.json
{
  "nodes": {
    "p0-baseline": {
      "artifacts": ["CLAUDE.md", "libs/memory-core/src/db.ts"],
      "changes": {
        "deletes": [],
        "resigns": [],
        "renames": [],
        "adds_set_members": ["libs/memory-core"]
      }
    },
    "p1-embedding-provider": {
      "artifacts": ["libs/data/embed/embedding-provider/src/index.ts"],
      "changes": {
        "renames": [{ "from": "libs/memory-core/src/embed.ts", "to": "libs/data/embed/embedding-provider/src/index.ts" }]
      }
    }
  }
}
```

`plan-scan.js` reads `dag.json` already — it just stops at the flat union.

**Current shape** (plan-index.json per plan entry)

```jsonc
{
  "plan": "memory-refactor",
  "dir": "memory-refactor",
  "status": "in-progress",
  "mutate_set": [
    "CLAUDE.md",
    "libs/data/embed/embedding-provider/src/index.ts",
    "libs/data/vectors/vector-store/src/index.ts"
    // ... 50+ files from all states merged, unattributed
  ],
  "references": [],
  "assumed_baseline": [],
  "depends_on": [],
  "updated_at": "2026-06-27T00:41:22.977Z"
}
```

**Correct shape**

```jsonc
{
  "plan": "memory-refactor",
  "dir": "memory-refactor",
  "status": "in-progress",
  "mutate_set": [ /* flat union — kept for backward compat with cross-plan-check */ ],
  "state_mutations": {
    "p0-baseline": {
      "artifacts": ["CLAUDE.md", "libs/memory-core/src/db.ts"],
      "changes": {
        "deletes": [],
        "resigns": [],
        "renames": [],
        "adds_set_members": ["libs/memory-core"]
      }
    },
    "p1-embedding-provider": {
      "artifacts": ["libs/data/embed/embedding-provider/src/index.ts"],
      "changes": {
        "renames": [{ "from": "libs/memory-core/src/embed.ts", "to": "..." }]
      }
    }
    // one entry per node slug
  },
  "references": [],
  "assumed_baseline": [],
  "depends_on": [],
  "updated_at": "..."
}
```

`cross-plan-check.js::conflicts()` output should also change from plan-level to state-level:

```jsonc
// current (plan-level):
{ "a": "memory-refactor", "b": "tokenguard-service", "files": ["apps/sox/src/main.ts"] }

// correct (state-level):
{
  "a": "memory-refactor/p1-package-layout",
  "b": "tokenguard-service/p0-scaffold",
  "files": ["apps/sox/src/main.ts"],
  "mutation_types": { "a": "adds_set_members", "b": "add" }
}
```

**Expectations affected**

| Expectation slug | Impact |
|---|---|
| `plan-index-mutate-set-populated` | **Wrong check** — verifies the flat union is non-empty, which proves only that `plan-index.js` was run, not that per-state data is present. Needs a companion expectation `plan-index-state-mutations-populated` |
| `plan-index-registered` | Unaffected — slug presence check is independent of shape |
| `plan-index-exists` | Unaffected |
| `overlap-matrix-exists` | **Blocked** — `overlap-matrix.json` (SCOPE.md Gap 2) is supposed to contain `|Si ∩ Sj|` computed at state granularity. Without per-state `state_mutations` in plan-index.json, the overlap matrix generator has no source for cross-plan state pairs and would have to re-read every `dag.json` independently. |
| `dispatch-calibration-exists` | Unaffected |

**New expectation needed**

`plan-index-state-mutations-populated` (category: `plan-index`, severity: `warning`) —
`state_mutations` must be present and have one entry per node slug. An absent or empty
`state_mutations` means the plan-index was generated by the old flat-union `plan-scan.js`
and is not usable for state-level cross-plan scheduling.

---

## M-002 — interfaces.json is a standalone file; per-state interface mutations and blast radius are not in dag.json

**Situation**

`interfaces.json` stores interface mutation records keyed by iface-slug. Each record
describes a contract being created, modified, or deleted by the plan — including the
source file, shape (type signature), provenance, confidence, and audit check. However:

1. **Per-state attribution is missing from dag.json.** `interfaces.json` is flat —
   entries are not attributed to which state performs the mutation. `plan-scaffold.js
   link-iface` links an iface entry to a state via a `[iface:X]` citation token in the
   context file, but this link is prose-embedded (in `contexts/<slug>.md`), not
   machine-readable in `dag.json`. The optimizer cannot determine from `dag.json` alone
   which state performs which interface mutation.

2. **Blast radius is not stored.** `interfaces.json` has no `blast_radius` field. The
   files that import, implement, or consume a given interface — and must therefore be
   read or re-verified when it changes — are never recorded. For a `modify` op the
   blast radius is the implicit `read_only` set for all downstream states. For a
   `create` op it is empty (no consumers yet). Without it, the optimizer cannot
   correctly compute Sᵢ for states that depend on an interface change.

3. **Op type (create / modify / delete) is not recorded.** `interfaces.json` records
   `provenance` (`gitnexus | manual | assumed | vendored`) and `confidence`, but not
   the mutation operator. A `create` has zero blast radius; a `modify` has all
   consumers; a `delete` has all consumers plus requires them to be removed. The
   optimizer's dependency derivation needs the op type to determine implicit artifacts.

**Skill scripts**

| Script | Role | Problem |
|---|---|---|
| `scripts/plan-scaffold.js` (`link-iface`) | Writes to `interfaces.json` and cites `[iface:X]` in context | Does not write per-state attribution or blast radius to dag.json |
| `scripts/gap-check.js` | Validates `[iface:X]` citations against interfaces.json | Checks presence only; does not validate blast_radius coverage |
| `scripts/compile-task.js` | Builds per-state work-order | Does not read interfaces.json; interface mutations are invisible to the compiler |

**Data source**

- **Op type and shape**: `interfaces.json` entries have `interface` (name), `shape`,
  `provenance`, `confidence`, `source`, `audit_check` — but no `op` field. Must be
  inferred or added by `link-iface`.
- **Blast radius**: derivable from gitnexus (`npx gitnexus context <iface-slug>`) at
  authoring time, same pass as `dependents[]` in `compile-task.js`. Currently not
  derived or stored anywhere.
- **Per-state attribution**: the `[iface:X]` citation in `contexts/<slug>.md` is the
  only existing link. Machine-readable per-state attribution requires `dag.json`
  `nodes[slug].interface_mutations[]`.

**Current shape** (`interfaces.json`)

```jsonc
{
  "<iface-slug>": {
    "interface": "<human name>",
    "shape": "<type signature or schema>",
    "provenance": "gitnexus | manual | assumed | vendored",
    "confidence": "verified | vendored | documented | assumed",
    "source": "<file:line or null>",
    "spike_state": "<slug or null>",
    "audit_check": "<criterion-id or null>"
  }
}
```

**Correct shape** — `iface` object eliminated; `provenance`, `confidence`, and
`audit_check` promoted to top-level fields on the `changes[]` item; `interfaces.json`
demoted to a generated index:

```jsonc
{
  "nodes": {
    "<slug>": {
      "changes": [
        {
          "action": "modify-signature",
          "file": "<file-path>",
          "symbol": "<symbol>",
          "provenance": "gitnexus | manual | assumed | vendored",
          "confidence": "verified | vendored | documented | assumed",
          "audit_check": "<criterion-id | null>",
          "shape": { "kind": "interface", "ops": [ /* ... */ ] },
          "blast_radius": [ /* ... */ ]
        }
      ]
    }
  }
}
```

`file` + `symbol` is the natural stable identifier for any contract — no additional
slug is needed. `provenance`, `confidence`, and `audit_check` apply to any change,
not only typed interface mutations; they describe how well the authoring agent knows
this change rather than what kind of change it is.

`interfaces.json` is no longer a source of truth. It becomes an optional generated
summary produced by scanning `changes[]` entries with `shape.kind` in
`["interface", "type"]` across all nodes — useful for gap-check reporting but carries
no data that isn't already in `dag.json`.

**Expectations affected**

| Expectation slug | Impact |
|---|---|
| *(none currently)* | No existing expectation checks interface mutation coverage |

**New expectations needed**

- `interface-mutations-attributed` (category: `structural`, severity: `warning`) —
  every `[iface:X]` cited in any context file must have a matching entry in that
  state's `dag.json nodes[slug].interface_mutations[]`. An unattributed citation
  means the optimizer cannot see the interface's blast radius.
- `interface-blast-radius-non-empty-on-modify` (category: `structural`, severity:
  `info`) — every `interface_mutations[]` entry with `op: "modify"` must have a
  non-empty `blast_radius`. A modify with empty blast radius either has no consumers
  (suspicious for an established interface) or the gitnexus pass was skipped.

---

## M-003 — `changes[]` schema overhaul: keyed-object → structured flat-array with op-level deltas

**Situation**

The `changes` field on dag.json nodes has been redesigned in multiple passes during
this session. Existing dag.json files (e.g. `docs/plan/memory-refactor/dag.json`,
`docs/plan/tokenguard-service/dag.json`) carry the old keyed-object shape. All tooling
that reads or writes `changes` — `plan-scan.js`, `compile-task.js`, `compile-wave.js`,
`cross-plan-check.js`, `gap-check.js` — must migrate to the new schema.

The redesign resolves five compounding gaps in the original shape:

1. **Action-as-key prevented uniform iteration.** `changes.deletes[]`, `changes.resigns[]`,
   `changes.renames[]`, `changes.adds_set_members[]` required callers to check four separate
   arrays. A single flat `changes[]` with `action` as an attribute enables iteration,
   filtering, and conflict detection with a single loop.

2. **`target` was a single untyped string mixing file paths and symbol names.** The
   conflict key for the scheduler needs `file` and `symbol` separately — `file` for
   artifact-level reservation; `symbol` for op-category conflict keying.

3. **One entry per file lost per-symbol blast radius.** A file `delete` or `move` was
   recorded as one entry, hiding which exported symbols break which downstream consumers.
   The new rule: one entry per exported symbol. A file `delete` expands to N entries
   (one per export), each with that symbol's individual blast radius.

4. **`interface_mutations[]` was a parallel structure that duplicated `changes[]`.**
   Every interface mutation is a code/structure change on a named symbol in a file.
   Maintaining two arrays created synchronization drift. The `iface` and `shape` fields
   on `changes[]` items absorb the interface contract dimension. `interfaces.json`
   becomes a lookup registry only; per-state attribution lives in `changes[]`.

5. **`shape` as an opaque string prevented conflict detection and merge grading.**
   Two nodes both modifying the same function's signature appeared as a raw string
   conflict. The structured `shape.ops[]` model decomposes the signature change into
   named operations (`add-param`, `retype-field`, `set-key`, etc.) each targeting a
   specific named element. Conflicts are detected by `(target, op-category)` collision,
   and can be classified as safe-merge, warning, or error without human inspection.

**Skill scripts**

| Script | Role | Migration required |
|---|---|---|
| `scripts/lib/plan-scan.js` | Reads `dag.json` changes for plan-index | Must iterate `changes[]` flat array; read `changes[].file` for artifact union; read `changes[].action` for mutation type |
| `scripts/compile-task.js` | Derives per-state reserved_files and work-order | Must read `changes[]` for `artifacts[]` derivation; must identify interface mutations via `shape.kind: "interface | type"` rather than a separate `interface_mutations[]` array or `iface` field |
| `scripts/compile-wave.js` | Deduplicates shared context across waves | Must use derived `artifacts[]` from `changes[]`; `si_bytes` derivation changes |
| `scripts/cross-plan-check.js` | Conflict + dependency derivation | Must use `(file, symbol, action)` for state-level conflict keying; rename-induced ordering now visible via `action: "move"` + `to_file` |
| `scripts/gap-check.js` | Validates `[iface:X]` citations | Must check `changes[]` entries where `shape.kind` is `interface` or `type`; `interfaces.json` read becomes optional (generated index only, no longer source of truth) |
| `scripts/plan-scaffold.js` (`link-iface`) | Writes interface attribution | Must write `provenance`, `confidence`, `audit_check` directly onto the `changes[]` item; no `iface` sub-object; generating `interfaces.json` becomes a derived step |

**Current shape** (all existing dag.json files)

```jsonc
{
  "nodes": {
    "<slug>": {
      "artifacts": ["<file-path>"],
      "changes": {
        "deletes": ["<file-path>"],
        "resigns": ["<symbol>"],
        "renames": [{ "from": "<file-path>", "to": "<file-path>" }],
        "adds_set_members": ["<file-path | symbol>"]
      }
    }
  }
}
```

**Correct shape** (PROPOSED_DAG_STRUCTURE.md schema_version 3)

```jsonc
{
  "nodes": {
    "<slug>": {
      "changes": [
        {
          "action": "create | delete | move | rename | modify-signature | modify-body | add-export | remove-export",
          "file": "<file-path>",
          "symbol": "<exported-symbol | null>",
          "provenance": "gitnexus | manual | assumed | vendored | null",
          "confidence": "verified | vendored | documented | assumed | null",
          "audit_check": "<criterion-id | null>",
          "shape": {
            "kind": "function | interface | type | class | enum | const | config | env | doc | schema | manifest | script",
            "ops": [
              {
                "op": "<see op vocabulary>",
                "target": "<param-name | field-name | key-path | section-heading | var-name | table.column | null>",
                "from": "<type-string | value | name | null>",
                "to": "<type-string | value | name | null>",
                "position": "<integer | null>",
                "required": "<boolean | null>",
                "breaking": "<boolean>",
                "severity": "error | warning | info"
              }
            ]
          },
          "to_file": "<file-path | null>",
          "to_symbol": "<symbol | null>",
          "blast_radius": [
            {
              "file": "<file-path>",
              "symbol": "<function | class | method | variable>",
              "impact": "implements | calls | imports | extends | re-exports | overrides",
              "consumer": "current | future"
            }
          ]
        }
      ]
    }
  }
}
```

**Inferrable fields — must NOT be hand-migrated**

The following fields in `changes[]` are populated by the `dag annotate` pass, not by
hand-migration. Hand-migrating them against stale source will immediately create drift:

| Field | Populated by |
|---|---|
| `shape.ops[].from` | TypeScript AST / config file read at annotation time |
| `shape.ops[].breaking` | Op semantics table: `(op, required, from→to)` |
| `shape.ops[].severity` | Same pass as `breaking` |
| `blast_radius[].file/symbol/impact` | `gitnexus_impact` on `(file, symbol)` |
| `blast_radius[].consumer: "current"` | gitnexus upstream pass |
| `blast_radius[].consumer: "future"` | Cross-node scan in same dag.json |
| `artifacts[]` (node level) | Derived from `changes[].file` for write actions |
| `si_bytes` (node level) | Filesystem stat on derived `artifacts[]` |

The hand-migration task is: translate the **authored nucleus only** —
`action`, `file`, `symbol`, `iface`, `shape.kind`, `shape.ops[].op`,
`shape.ops[].target`, `shape.ops[].to`, `to_file`, `to_symbol` — then
run `dag annotate` to fill the rest.

**Migration strategy**

1. Write a `dag-migrate-v3.js` script that reads each existing dag.json and outputs
   the new shape for the authored nucleus only (no `blast_radius`, no `from`, no
   `breaking`/`severity`, no `artifacts`, no `si_bytes`).
   - `changes.deletes[path]` → `{ action: "delete", file: path, symbol: null }`
     (note: must be expanded per-symbol by the agent review pass — the old shape had
     no symbol granularity; the script emits a single `symbol: null` placeholder that
     the authoring agent must expand)
   - `changes.resigns[sym]` → `{ action: "modify-signature", file: "<unknown>", symbol: sym }`
     (the old shape had no file; must be resolved from context file or git blame)
   - `changes.renames[{from, to}]` → `{ action: "rename", file: from, symbol: null, to_file: to }`
   - `changes.adds_set_members[path]` → `{ action: "add-export", file: path, symbol: null }`
2. Agent review pass: expand all `symbol: null` entries to per-exported-symbol entries
   by reading the file's actual exports.
3. Run `dag annotate` to populate `blast_radius`, `from`, `breaking`, `severity`,
   `artifacts[]`, `si_bytes`.
4. Bump `schema_version` to 3 in each migrated dag.json.

**Expectations affected**

| Expectation slug | Impact |
|---|---|
| `dag-changes-typed` | **Wrong check** — validates old keyed-object shape; must be rewritten to validate flat-array shape with required `action` field |
| `interface-mutations-attributed` | **Superseded** — M-002 proposed checking `interface_mutations[]`; now checks `changes[]` entries where `iface` is non-null |
| `interface-blast-radius-non-empty-on-modify` | **Path change** — now checks `changes[].blast_radius` on entries where `iface` is non-null and `action: "modify-signature"` |

**New expectations needed**

- `changes-per-symbol-expanded` (category: `structural`, severity: `warning`) —
  no `changes[]` entry may have `symbol: null` except when `action: "create"` (new file,
  exports not yet known). All other actions require a named symbol.
- `changes-shape-ops-annotated` (category: `structural`, severity: `info`) —
  every `changes[]` entry with `action: "modify-signature"` must have `shape.ops` with
  at least one entry. An empty `ops[]` means the annotation pass was not run or the
  agent did not declare the mutation type.
- `changes-blast-radius-annotated` (category: `structural`, severity: `warning`) —
  every `changes[]` entry with a non-create action and a known `symbol` must have a
  non-empty `blast_radius`. Empty blast radius on a `delete` or `modify-signature`
  means the gitnexus pass was skipped.
