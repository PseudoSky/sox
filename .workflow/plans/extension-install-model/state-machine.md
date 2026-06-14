<!-- markdownlint-disable MD013 MD033 -->
# Extension Install & Reinjection Model — State Machine

> A **human-readable render of `dag.json`**. `dag.json` is the machine source of truth for topology;
> `state.json` is the live runtime instance. Regenerate this file after any structural change
> (insert/split/retire a state, re-edge the graph) so the three never drift.

---

## States

Identity is the **slug** (immutable). Order below is a topological render of `dag.json` — a view,
not the source. Inserting a state never renumbers another.

| Slug | Name | Phase | One-line goal |
|---|---|---|---|
| `schema-delta` | Host-keyed descriptor + lifecycle deprecation | foundation | Hybrid install descriptor; validator rejects `agent.lifecycle` |
| `capability-engine` | Six capabilities + ledger | foundation | apply/reverse/update/verify caps + provenance ledger |
| `host-registry` | claude + codex modules | foundation | Pluggable host registry; the only place host paths live |
| `audit-foundation` | FOUNDATION_AUDIT | **Audit** | Verify foundation criteria; fix before advancing |
| `mcp-runtime` | `@sox/mcp-runtime` wrapper | enforcement | SDK wrapper + uniform C6 enforcement on both transports |
| `install-lifecycle` | install/update/diff/uninstall | enforcement | Declarative placement wired to engine+registry+ledger |
| `generators` | nx-style `init` options | enforcement | Appendix-A options emit the hybrid descriptor |
| `rehome-memory-server` | memory onto the wrapper | enforcement | Vendored MCP loop + guard gone; behavior identical |
| `audit-enforcement` | ENFORCEMENT_AUDIT | **Audit** | Verify enforcement criteria; fix before advancing |
| `ingestion-skill` | `sox-ingest` skill | convergence | Dogfooded skill replaces `docs/ingestion/` |
| `dod-reconcile` | Split B2 "run" | convergence | DOD.md/CLAUDE.md split process vs placed/declarative |
| `audit-final` | FINAL_AUDIT | **Audit** | Prove every `[dod.*]` + `[ref:*]` + no-regress; founder accepts |
| `done` | TERMINAL | — | The system is a working cross-scope package-manager/reinjector |

**Audit states are mandatory hold points.** `audit-foundation` gates foundation → enforcement;
`audit-enforcement` gates enforcement → convergence; `audit-final` gates convergence → `done` (and
the founder signs off before `state: complete`). There are no deferrable items in any audit state.

---

## Topology

```text
schema-delta ──┬─► capability-engine ─┐
               └─► host-registry ─────┴─► audit-foundation ──┬─► mcp-runtime ─────► rehome-memory-server ─┐
                                                             ├─► install-lifecycle ───────────────────────┤
                                                             └─► generators ──────────────────────────────┤
                                                                                                          ▼
                                                                                                  audit-enforcement
                                                                                                          │
                                                          ┌───────────────────────────────────────────────┤
                                                          ▼                                               ▼
                                                   ingestion-skill                                  dod-reconcile
                                                          │                                               │
                                                          └──────────────────► audit-final ◄─────────────┘
                                                                                    │
                                                                                    ▼
                                                                                   done
```

Structural properties (edges live in `dag.json` `depends_on`; this diagram renders them):

- **Foundation fan-out/fan-in:** `schema-delta` unblocks `capability-engine` ∥ `host-registry`
  (disjoint files, genuinely parallel); both converge on `audit-foundation`.
- **Enforcement parallelism:** after `audit-foundation`, `mcp-runtime` ∥ `install-lifecycle` ∥
  `generators` run in parallel. `rehome-memory-server` is the one sequential enforcement state — it
  depends on `mcp-runtime` (the wrapper it collapses onto). `install-lifecycle` + `generators` share
  `bin/sox` + `apps/sox/src/main.ts` (merge protocol: lifecycle first).
- **Convergence:** `ingestion-skill` (needs `generators` + `install-lifecycle`) ∥ `dod-reconcile`
  (needs `install-lifecycle`); both converge on `audit-final`.

---

## Transitions and guards

| From (slug) | Guard | Unlocks |
|---|---|---|
| `schema-delta` | `nx run manifest:test && nx run manifest:build` | capability-engine, host-registry |
| `capability-engine` | `nx run install-engine:test` | audit-foundation |
| `host-registry` | `nx run host-registry:test` | audit-foundation |
| `audit-foundation` | `python3 scripts/audit_eim.py --phase foundation` — every foundation criterion; exits 0 | mcp-runtime, install-lifecycle, generators |
| `mcp-runtime` | `nx run mcp-runtime:test` | rehome-memory-server, audit-enforcement |
| `install-lifecycle` | `nx run install-engine:test && nx run host-runtime:test-e2e` | audit-enforcement, ingestion-skill, dod-reconcile |
| `generators` | `nx run sox-nx:test && nx run authoring:test` | audit-enforcement, ingestion-skill |
| `rehome-memory-server` | `nx run memory-server:test && nx run host-runtime:test-e2e` | audit-enforcement |
| `audit-enforcement` | `python3 scripts/audit_eim.py --phase enforcement` — foundation + enforcement; exits 0 | ingestion-skill, dod-reconcile |
| `ingestion-skill` | `test -d extensions/skills/sox-ingest && test ! -e docs/ingestion/migration-plan.md && test ! -d docs/ingestion/prompts && nx run-many -t lint` | audit-final |
| `dod-reconcile` | `python3 .../scripts/check_docs_split.py` (DOD.md + CLAUDE.md carry the run/placed split) | audit-final |
| `audit-final` | `python3 scripts/audit_eim.py --phase final` — all DoD + references + live; exits 0 | done (after founder review) |

> Guard `nx ...` invocations above are abbreviations of the env-pinned forms in `dag.json`
> (`./node_modules/.bin/nx …`); the audit `_run` helper PATH-augments `node_modules/.bin` so bare
> `nx` inside a check resolves deterministically.

---

## File model

| File | Role | Mutated when |
|---|---|---|
| `dag.json` | **Structure** — nodes (slug → phase, depends_on, guard, artifacts, context, changes) | Reordering, adding/splitting/retiring a state. Edit one file. |
| `state.json` | **Runtime** — current_state, per-slug status+timestamps, logs | Every session (status, timestamps, log appends) |
| `references.json` | **Reference catalog** — `[ref:]` idioms (anchor + rule + audit_check) | A new idiom is added |
| `contexts/<slug>.md` | Work order per state | The state is authored or amended |
| `contexts/_shared.md` | Centralized `[def:]`/`[inv:]`/`[shape:]`/`[ref:]` | A shared definition changes (once) |
| `scripts/audit_eim.py` | Phase-cumulative audit runner | An audit state is authored/extended |

`dag.json` node schema:

```jsonc
{
  "kind":       "work | audit",
  "phase":      "foundation | enforcement | convergence",
  "depends_on": ["schema-delta"],
  "guard":      "<env-pinned deterministic command>",
  "artifacts":  [],            // files produced or mutated — matches the context mutates set
  "context":    "contexts/<slug>.md",
  "changes":    { "deletes": [], "resigns": [], "renames": [] },
  "notes":      ""             // resume context — what to know before starting
}
```

`state.json` per-state record schema:

```jsonc
{
  "status":     "pending | in_progress | blocked | done",
  "started_at": null,
  "done_at":    null,
  "start_ref":  null,
  "end_ref":    null
}
```

Each `transition_log` entry the executor appends on advancing:

```jsonc
{
  "ts":           "<ISO-8601>",
  "from":         "schema-delta",
  "to":           "capability-engine",
  "guard_result": "<command> — N passed in Xs",
  "executor":     "sox-active:typescript-pro",
  "summary":      "<one sentence: what was done and any notable fixes made>"
}
```

Each `amendment_log` entry — appended when the plan itself changes mid-flight, **not** on
advancement. Executor-class amendments are applied in place; planner-class amendments stop and
escalate. See the skill's "Amending the plan mid-flight" and "Re-planning a live machine" sections.

```jsonc
{
  "ts":           "<ISO-8601>",
  "state":        "install-lifecycle",
  "class":        "executor | planner",
  "type":         "expand-artifacts | add-criterion | fix-guard | insert-state | split-state | retire-state | change-dependency | change-target | replan",
  "reason":       "<why reality diverged from the work order>",
  "files_synced": ["dag.json", "state.json", "state-machine.md", "contexts/install-lifecycle.md"],
  "prior_ref":    "<git ref of the plan before this amendment — required for replan>",
  "by":           "sox-active:<agent-name>"
}
```

---

## Rollback

Because every plan write is committed (R1), rollback is `git revert` of the relevant plan commits
plus the source they carried. State-by-state:

- **schema-delta** — additive (back-compat preserved) except the `agent.lifecycle` rejection; revert
  restores the prior validator. Safe.
- **capability-engine / host-registry / mcp-runtime / generators** — new files only (no destructive
  edits); `git revert` is clean.
- **install-lifecycle** — re-signs `runInstall` + edits `bin/sox`/`main.ts`; revert restores the
  single-string consumer. The *installed* host artifacts are reversed via the ledger (`sox uninstall`),
  not git. **[inv:ledger-reversible]** is the rollback guarantee for anything written to a host.
- **rehome-memory-server** — rewrite; revert restores the vendored loop + guard. Behavior is held
  identical by `[inv:no-regress]`, so a revert does not change runtime behavior.
- **ingestion-skill** — deletes `docs/ingestion/prompts/*` + `migration-plan.md`; revert restores
  them from git history. The new skill is removable via `sox uninstall`.
- **dod-reconcile** — docs only; `git revert`.

**Irreversible action to watch:** any half-applied install whose capability cannot cleanly reverse —
which is exactly why `[dod.12]` requires such capabilities to **abort** rather than partially apply.
