# w2e-domain-rewire — Facade-then-dissolve; rewire the memory domain onto data/*

> **Slug is identity.** `w2e-domain-rewire` is immutable.

**Phase:** extraction · **Depends on:** `w2d-ingest`, `w2d-analysis`, `w2d-hybrid-search`
**Guard:** `nx build memory-core && nx build memory-server && nx build memory-daemon && nx run-many -t test && nx run registry:sync-index && nx run host-runtime:test-e2e`

---

## Goal

Re-point the memory domain onto the six extracted `data/*` packages via
[def:facade-then-dissolve], leaving a slim [def:domain-composer] (`memory-core`, name
kept) and **fully dissolving** `memory-enrich`. The external **19-tool `memory_*`
contract is byte-unchanged** ([inv:tool-contract-stable]); the bundle is rebuilt, the
registry resynced, and consumers upgraded. This is the convergence point of the
extraction phase — after it, `data/*` is the source of truth and `memory-core` is only
the domain glue.

---

## Semantic Distillation

- **Primitive:** REWIRE (3 sub-steps, each independently green) + REBUILD + RESYNC.
- **Reference Pattern:** the composer surface in `libs/memory-core/src/index.ts` (the
  re-exports the 4 bundle members consume); the 4 members at
  `extensions/bundles/sox-memory-bundle/members/{memory-server,memory-daemon,memory-cli,
  memory-flush}`; the bundle manifest; `registry/index.json`; the AGENT SEQUENCE in
  `CLAUDE.md` (lint→build→registry:sync-index→commit→upgrade --all).
- **Delta Spec — [def:facade-then-dissolve] in order:**
  1. **Facade (green checkpoint #1):** rewrite `memory-core` + `memory-enrich` internals
     to **re-export** from `data/*` (e.g. `export { embed } from '@adhd/sox-embedding-provider'`,
     `openDb` composes `applyGraphSchema`+`applyVecSchema` per [def:connection-seam]).
     ZERO consumer change — the 4 members still import `@adhd/sox-memory-core`/`-enrich`
     and behave identically. Run `nx run-many -t test` + e2e: must be green. This proves
     the extraction is behavior-identical before touching consumers.
  2. **Flip (green checkpoint #2):** change the 4 bundle members to import `data/*`
     directly where appropriate (`@adhd/sox-vector-store`, `-graph-store`,
     `-embedding-provider`, `-hybrid-search`, `-analysis`, `-ingest`) and the slim
     `memory-core` only for domain glue (session-state, scope/promotion, federation,
     `openDb`, the `memory_*` composition). Wire the [def:reembed-core] **daemon op** in
     `memory-daemon` + make `scripts/reembed-memory.mjs` a **thin wrapper** over
     `vector-store.reembed` (one core, two entry points). Conform to
     `docs/spec/service-lifecycle.md` §13 ([inv:lifecycle-spec]) for any daemon-op wiring.
  3. **Dissolve (green checkpoint #3):** delete the dead facade re-exports; **delete the
     `@adhd/sox-memory-enrich` package** entirely (its code now lives in analysis+ingest);
     leave `memory-core` slim — verify nothing remains in it that belongs in `data/*`.
  4. **Rebuild + resync:** `nx build` the affected projects, `nx run registry:sync-index`
     ([inv:registry-current] — never hand-edit `registry/index.json`), commit source +
     regenerated registry together by explicit path, then `node bin/soxe upgrade --all`
     (per the CLAUDE.md AGENT SEQUENCE; flag that the MCP client may need a reconnect).
- **Invariants added:** [inv:tool-contract-stable], [inv:registry-current],
  [inv:lifecycle-spec], [inv:no-regress], [inv:reality], [inv:boundary] (the composer may
  import data/* + platform; data/* must not import the composer).
- **Validation:** the multi-gate guard (build the trio, full test, registry sync, e2e).

---

## Acceptance criteria

Checked by `audit-extraction`.

- [ ] **[w2e.1]** Slim `memory-core` builds + the 3 trio builds pass; the 4 bundle members
      import `data/*` directly (verified by import grep) and `memory-core` only for domain
      glue.
- [ ] **[w2e.2]** `@adhd/sox-memory-enrich` is **deleted** (package + project gone); no
      `import '@adhd/sox-memory-enrich'` remains anywhere.
      `! grep -rl "@adhd/sox-memory-enrich" --include=*.ts libs apps extensions packages`
- [ ] **[w2e.3]** [inv:tool-contract-stable]: a fresh `tools/list` against the rebuilt
      `memory-server` DIFFS clean (19 tools, identical names + inputSchemas) vs
      `baseline/tool-snapshot.json`.
- [ ] **[w2e.4]** [def:reembed-core] is single-sourced: `scripts/reembed-memory.mjs` is a
      thin wrapper over `vector-store.reembed` (no duplicated walk logic) AND a daemon op
      exists; both invoke the same core.
      `! grep -q "node_id\|vec_node" scripts/reembed-memory.mjs || grep -q "reembed" scripts/reembed-memory.mjs`
      (the script delegates; it does not re-implement the SQL walk.)
- [ ] **[w2e.5]** `registry:sync-index` regenerated; `check-registry-sync` green; commit
      includes source + `registry/index.json`. [inv:registry-current]
- [ ] **[w2e.6]** `nx run-many -t test` green + `host-runtime:test-e2e` green with zero
      orphans (reconciled vs BL-63). [inv:no-regress]
- [ ] **[w2e.7]** Boundary: no `data/*` package imports `memory-core` (the composer);
      `nx lint` green. [inv:boundary]

---

## Reservations

```text
read_only:  ["docs/plan/memory-refactor/baseline/tool-snapshot.json",
             "docs/spec/service-lifecycle.md"]
mutates:    ["libs/memory-core/src/**",
             "libs/memory-enrich/** (deleted)",
             "extensions/bundles/sox-memory-bundle/members/memory-server/src/**",
             "extensions/bundles/sox-memory-bundle/members/memory-daemon/src/**",
             "extensions/bundles/sox-memory-bundle/members/memory-cli/src/**",
             "extensions/bundles/sox-memory-bundle/members/memory-flush/src/**",
             "scripts/reembed-memory.mjs",
             "registry/index.json"]
```

---

## Notes for executor

- **Do the three sub-steps in order and keep each green.** The facade step is what makes
  the risky consumer-flip safe — skip it and a broken extraction surfaces as a tangle of
  failing consumers with no clean checkpoint to bisect against.
- **Never hand-edit `registry/index.json`** and **never `git add -A`** (CLAUDE.md hard
  constraints). Stage by explicit path; commit source + registry together.
- The tool-contract diff ([w2e.3]) is the single most important check — if a tool's
  inputSchema shifted, you changed the domain contract, which is out of scope. Fix the
  composer, not the snapshot.
- stdio MCP (memory-server) respawns with new code on the client's next connection — note
  the reconnect in the transition log.
- Budget: 2-3 sessions (the integration crux).
