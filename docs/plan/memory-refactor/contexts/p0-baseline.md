# p0-baseline — Baseline capture & space-invariant guardrail

> **Slug is identity.** `p0-baseline` is immutable. Ordering comes from
> `dag.json` (`depends_on`), not this name.

**Phase:** baseline · **Depends on:** (none — root) · **Guard:** see dag.json

> ⛔ **ENTRY-BLOCKED on [inv:quickfix-landed].** Do not begin this state until the
> [def:quickfix] is merged to `main` AND the live **user-scope** `memory-server`
> reports `embed_on_hash_fallback:false` + `embed_model:"bge-base-en-v1.5"`. The
> quickfix is currently half-landed (live store re-embedded; server still hash
> pending an owner-gated npm republish). The orchestrator will release this block.

---

## Goal

Freeze a **trustworthy green baseline** the whole refactor is measured against, and
author the one machine check that encodes the plan's hardest invariant
([def:space-invariant]). This state does **no source refactor** — it captures reality
and builds a guardrail, so every later state has an objective "did I regress it?"
reference.

Three deliverables:
1. **Green-baseline capture** — record the exact pass state of
   `nx run-many -t build,lint,test`, `host-runtime:test-e2e` (zero orphans, mind
   **BL-63**), and `registry:check-sync` into `baseline/baseline.md`.
2. **Tool contract snapshot** ([fix:tool-snapshot]) — capture the 19 `memory_*` tool
   names + JSON input schemas from a live `tools/list` against the **built** server
   into `baseline/tool-snapshot.json`. This is the diff target for
   [inv:tool-contract-stable].
3. **Space-invariant machine check** — `scripts/space_invariant_check.mjs`: given a
   memory DB, assert every `vec_node` row's owning `node` was embedded under the
   scope's `embed_model`/`embed_dim` (no mixed-model vectors), and that a synthetic
   mismatched-dim insert is rejectable. Run it against a [fix:memory-db] copy.

---

## Semantic Distillation

- **Primitive:** CAPTURE baseline + CREATE the space-invariant check. No `libs/`
  source edits.
- **Reference Pattern:** the live server's `memory_ping`/`memory_stats` already expose
  `embed_on_hash_fallback` + `embed_model` — use them for the real-model probe. Schema
  shapes in `libs/memory-core/src/schema.ts` (`memory_scope.embed_model/embed_dim`,
  `vec_node`). The [fix:cosine-sanity] probe: embed two unrelated strings via the live
  server and assert cosine ~0, not ~0.99.
- **Delta Spec:**
  - `baseline/baseline.md` records command + exit code + headline counts for each gate
    (build/lint/test project counts; e2e pass/total + orphan count reconciled against
    the BL-63 known false-positive; registry sync result).
  - `baseline/tool-snapshot.json` = `{ tools: [{ name, inputSchema }] }` for all 19
    `memory_*` tools, captured from the real built server (not source).
  - `scripts/space_invariant_check.mjs` — Node ESM, no new dep; opens a DB read-only,
    joins `vec_node`→`node`→`memory_scope`, flags any vector whose implied model ≠ the
    scope model; exits non-zero on a violation. Includes a `--self-test` that builds a
    tiny in-memory store and proves a mismatched-dim insert throws.
- **Invariants added:** [inv:quickfix-landed] (entry gate), [inv:reality] (snapshot from
  the built server, not source), [inv:no-regress] (this IS the baseline).
- **Validation:** the guard runs the full green-baseline command set + `audit … --phase
  baseline`.

---

## Acceptance criteria

Checked by `audit-baseline` as slug-keyed criterion IDs.

- [ ] **[p0-baseline.1]** Live user-scope server real model on: `memory_ping` →
      `embed_on_hash_fallback:false` AND `embed_model:"bge-base-en-v1.5"`.
- [ ] **[p0-baseline.2]** [fix:cosine-sanity]: cosine of two unrelated strings is
      `< 0.5` (real), NOT `> 0.95` (hash). (Probe recorded in baseline.md.)
- [ ] **[p0-baseline.3]** `baseline/tool-snapshot.json` exists and lists exactly **19**
      `memory_*` tools, each with a non-empty `inputSchema`, captured from the built
      server.
- [ ] **[p0-baseline.4]** `scripts/space_invariant_check.mjs --self-test` exits 0 (a
      mismatched-dim insert is rejected) and a run against a [fix:memory-db] copy exits 0
      (no mixed-model vectors in the live store post-quickfix-reembed).
- [ ] **[p0-baseline.5]** Green baseline captured: `nx run-many -t build,lint,test` +
      `host-runtime:test-e2e` (orphans reconciled vs BL-63) + `registry:check-sync` all
      pass, recorded in `baseline/baseline.md`.

---

## Reservations

```text
read_only:  ["libs/memory-core/src/schema.ts", "libs/memory-core/src/embed.ts",
             "registry/index.json"]
mutates:    ["docs/plan/memory-refactor/scripts/space_invariant_check.mjs",
             "docs/plan/memory-refactor/baseline/tool-snapshot.json",
             "docs/plan/memory-refactor/baseline/baseline.md"]
```

---

## Notes for executor

- This state proves the *world before* the refactor. Do not "fix" anything you find —
  log it to BACKLOG.md and proceed; the baseline is the baseline.
- If [p0-baseline.1] fails, STOP — the republish has not landed; the plan cannot enter.
  Report to the orchestrator, do not work around it with `SOX_EMBED_BACKEND=hash`.
- The tool snapshot MUST come from the built server's live `tools/list`, not from
  reading source — that is what makes [inv:tool-contract-stable] a reality check.
- Budget: 1 session.
