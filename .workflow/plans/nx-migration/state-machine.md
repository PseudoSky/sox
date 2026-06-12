<!-- markdownlint-disable MD013 -->
# Nx + self-hosting migration — State Machine

> A **human-readable render of `dag.json`**. `dag.json` is the machine source of
> truth for topology; `state.json` is the live runtime instance. Regenerate this
> file after any structural change so the three never drift.

---

## States

Identity is the **slug** (immutable). The order below is a topological render of
`dag.json`. The "Legacy" column maps the old P0–P10 numbers onto slugs — sequence
comes from `depends_on`, not the numbers.

| Slug | Legacy | Phase | One-line goal |
|---|---|---|---|
| `checkpoint-branch` | P0 | checkpoint | Session fixes committed + tagged `pre-nx-baseline`; `feat/nx-migration` branched |
| `nx-init` | P1 | foundation | Nx alive: graph, target defaults, boundaries, cache, release, commitlint |
| `manifest-lib` | P2 | foundation | `libs/manifest` is the single source of truth for validate() + the 3 flexes |
| `authoring-lib` | P3 | foundation | Pure `scaffold()` core + thin `@sox/nx` generators + born-conformance + parity; demos deleted |
| `audit-foundation` | — | **Audit** | Verify all foundation criteria; fix before the engine phase |
| `engine-libs` | P4 | engine | Engine logic re-homed into 3 libs; fixes carried forward; A12 flag parser fixed |
| `sox-extension` | P5 | engine | `apps/sox` = literal extension #0; conformant manifest; full command surface |
| `audit-engine` | — | **Audit** | Verify foundation + engine criteria; fix before convergence |
| `type-discovery` | P6 | convergence | Templates refined to real corpus shapes; flexes confirmed (additive) |
| `memory-core` | P7 | convergence | 4 memory extensions + `libs/memory-core`; reach-in killed (C7) |
| `migrate-rest` | P8 | convergence | Remaining extensions into the nx graph; `validate-manifests` thin-wrapped |
| `ci-release` | P9 | convergence | `nx affected` CI; `nx release`; commitlint; per-type docs; reality-gates as targets |
| `audit-final` | P10 | **Audit** | Prove D5 scope (every `[dod.N]` + `[ref:]`) against reality from a clean slate |
| `done` | — | — | Terminal; founder accepts; `state: complete` |

**Audit states are mandatory hold points** with no deferrable items:
`audit-foundation` gates the engine phase; `audit-engine` gates convergence;
`audit-final` gates `done`.

---

## Topology

```text
checkpoint-branch ──► nx-init ──► manifest-lib ──► authoring-lib ──► audit-foundation
                                                                          │
                                                                          ▼
                                                  engine-libs ──► sox-extension ──► audit-engine
                                                                                        │
                                                                                        ▼
            type-discovery ──► memory-core ──► migrate-rest ──► ci-release ──► audit-final ──► done
```

The graph is a linear-with-audits topology. The four foundation work states are
serial by data dependency (`manifest-lib` before `authoring-lib` per
[inv:ordering]); `audit-foundation` depends on all four. The engine phase is
serial (`engine-libs → sox-extension`); `audit-engine` depends on both. The
convergence work states are serial by data dependency
(`type-discovery → memory-core → migrate-rest → ci-release`); `audit-final`
depends on all four, then `done`. No two states share a mutable file, so no merge
protocol is required (the only shared-with-read-only file,
`scripts/validate-manifests.ts`, is mutated solely by `migrate-rest`).

---

## Transitions and guards

| From (slug) | Guard | Unlocks |
|---|---|---|
| `checkpoint-branch` | `scripts/guards/checkpoint-branch.sh` — clean tree, tag, branch, suite green | `nx-init` |
| `nx-init` | `scripts/guards/nx-init.sh` — graph + boundaries + release + workspace + suite | `manifest-lib` |
| `manifest-lib` | `scripts/guards/manifest-lib.sh` — build + tests + 3 flexes + nx-free | `authoring-lib` |
| `authoring-lib` | `scripts/guards/authoring-lib.sh` — build + born-conformance + parity + nx-free + demos gone | `audit-foundation` |
| `audit-foundation` | `audit_nx_migration.py --phase foundation` — every foundation criterion; exits 0 | `engine-libs` |
| `engine-libs` | `scripts/guards/engine-libs.sh` — build + tests + A12 + lint | `sox-extension` |
| `sox-extension` | `scripts/guards/sox-extension.sh` — build + self-validate + A1 + A12 | `audit-engine` |
| `audit-engine` | `audit_nx_migration.py --phase engine` — foundation + engine; exits 0 | `type-discovery` |
| `type-discovery` | `scripts/guards/type-discovery.sh` — born-conformance + parity + doc + additive | `memory-core` |
| `memory-core` | `scripts/guards/memory-core.sh` — build + zero reach-in + lint + C5 | `migrate-rest` |
| `migrate-rest` | `scripts/guards/migrate-rest.sh` — full build + lint + 44 tests + thin-wrap | `ci-release` |
| `ci-release` | `scripts/guards/ci-release.sh` — nx affected + release + docs + retire test + suite | `audit-final` |
| `audit-final` | `audit_nx_migration.py --phase final` — every `[dod.N]` + `[ref:]` vs reality; exits 0 | `done` |
| `done` | `audit_nx_migration.py --phase final` — re-assert green | (terminal) |

---

## File model

| File | Role | Mutated when |
|---|---|---|
| `dag.json` | **Structure** — nodes (slug → phase, depends_on, guard, artifacts, changes, context) | Reorder/insert/split/retire a state |
| `state.json` | **Runtime** — current_state, per-slug status+timestamps, logs | Every session |
| `references.json` | Reference Pattern Catalog — `[ref:]` idioms (anchor + rule + audit_check) | An idiom changes |
| `contexts/<slug>.md` | Work order per state | The state is authored or amended |
| `contexts/_shared.md` | Centralized definitions + `[ref:]` fallbacks | A shared definition changes (once) |

`transition_log` entries are appended on advancing; `amendment_log` entries when
the plan itself changes mid-flight (executor-class applied in place; planner-class
escalated). See the skill's "Amending the plan mid-flight" and "Re-planning a live
machine".

---

## Rollback

Because every plan write is committed (R1) and every state's source work is
committed at its named Commit points (R2), rollback is `git revert` of the
relevant plan commits plus the source they carried. The `pre-nx-baseline` tag is
the safe floor: the entire migration lives on `feat/nx-migration` and can be
abandoned without touching `main`. `checkpoint-branch`, the audits, and
`type-discovery`/`migrate-rest`/`ci-release` are fully reversible. The
code-moving states (`engine-libs`, `memory-core`) are reversible by revert but
should be re-run from their guards rather than partially reverted, since they
relocate symbols; GitNexus `detect-changes` confirms the blast radius before and
after. No irreversible action (no publish, no merge to `main`) occurs inside any
state — merge to `main` is the founder's post-acceptance step.
