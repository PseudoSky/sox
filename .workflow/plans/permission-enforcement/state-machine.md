<!-- markdownlint-disable MD013 -->
# C6 — Runtime Permission Enforcement — State Machine

> A **human-readable render of `dag.json`**. `dag.json` is the machine source of
> truth for topology; `state.json` is the live runtime instance. Regenerate this
> after any structural change so the three never drift.

---

## States

Identity is the **slug** (immutable). Order below is a topological render of
`dag.json` — a view, not the source. Inserting a state never renumbers another.

| Slug | Name | Phase | One-line goal |
|---|---|---|---|
| `consolidate-legacy` | Retire Legacy `scripts/host/` | foundation | Delete the superseded pre-nx duplicate so `libs/host-runtime` is the SINGLE canonical runtime. |
| `policy-core` | Permission Policy Compiler | foundation | A declared permissions block compiles to a queryable Policy (allow/deny). |
| `audit-foundation` | Foundation Audit | **Audit** | Verify every `[consolidate-legacy.*]` + `[policy-core.*]`; fix in source before enforcement begins. |
| `process-boundary` | Spawn-Time Process Bounding | enforcement | The single spawn point injects policy-env + scrubs env + restricts cwd. |
| `inproc-policy` | In-Process Declaration + Audit | enforcement | In-process types get compiled policy + audit log + documented SOFT level. |
| `mcp-path-guard` | Resource-Sink fs Denial | enforcement | The spawned memory-server denies an undeclared `db_path` before the sink. |
| `audit-enforcement` | Enforcement Audit | **Audit** | Verify all enforcement-state criteria; mandatory hold point. |
| `audit-final` | Final Reality Audit | convergence/**Audit** | Spawn the real server, attempt a forbidden access, prove denial + no side effect; prove every `[dod.N]`/`[ref:]`; no regression. |
| `done` | TERMINAL | — | C6 enforced at runtime; founder accepts. |

**Audit states are mandatory hold points.** `audit-foundation` gates the
enforcement phase; `audit-enforcement` gates the final audit; `audit-final`
gates `done` (and the founder review). No deferrable items in any audit.

---

## Topology

```text
consolidate-legacy ──► policy-core ──► audit-foundation ──┬──► process-boundary ──► mcp-path-guard ──┐
                                                          │                                          ├──► audit-enforcement ──► audit-final ──► done
                                                          └──► inproc-policy ─────────────────────────┘
```

Key structural properties:

- `consolidate-legacy` is the **root** state. It deletes the superseded
  `scripts/host/**` duplicate (and `scripts/host-runtime.test.ts`,
  `scripts/host-delivery.test.ts`) left live by the nx migration, so
  `libs/host-runtime` is the SINGLE runtime BEFORE C6 is wired — C6 is enforced
  once, not twice. `policy-core` and `audit-foundation` depend on it.
- `process-boundary` and `inproc-policy` both depend only on `audit-foundation`
  and mutate **disjoint** files (supervisor.ts vs. the agent/hook/command
  adapters + audit-log.ts). They are **parallel** with **no shared mutable
  file** — no merge protocol required.
- `mcp-path-guard` depends on `process-boundary` because it consumes the
  `[def:policy-env]` contract that the supervisor injects into the spawned child.
- `audit-enforcement` converges all three enforcement states before the reality
  audit.

---

## Transitions and guards

| From (slug) | Guard | Unlocks |
|---|---|---|
| `consolidate-legacy` | `test ! -d scripts/host && nx run-many -t test && nx run-many -t build && nx run-many -t lint` — legacy tree gone, suite/build/lint green | `policy-core` |
| `policy-core` | `nx run host-runtime:test` — policy.spec.ts green + lib suite green | `audit-foundation` |
| `audit-foundation` | `python3 .../scripts/audit_c6.py --phase foundation` — every `[consolidate-legacy.*]` + `[policy-core.*]`; exits 0 | `process-boundary`, `inproc-policy` |
| `process-boundary` | `nx run host-runtime:test` — supervisor-policy.spec.ts + carried-forward suite green | `mcp-path-guard` |
| `inproc-policy` | `nx run host-runtime:test` — inproc-policy.spec.ts + suite green | `audit-enforcement` |
| `mcp-path-guard` | `nx run memory-server:test` — permission-guard.spec.ts + suite green | `audit-enforcement` |
| `audit-enforcement` | `python3 .../scripts/audit_c6.py --phase enforcement` — all enforcement criteria; exits 0 | `audit-final` |
| `audit-final` | `python3 .../scripts/audit_c6.py --phase final` — reality + every `[dod.N]`/`[ref:]` + regression; exits 0 | `done` (then founder review) |

---

## File model

| File | Role | Mutated when |
|---|---|---|
| `dag.json` | **Structure** — nodes (slug → phase, depends_on, guard, artifacts, context, changes) | Reorder/insert/split/retire a state. Edit one file. |
| `state.json` | **Runtime** — current_state, per-slug status+timestamps, logs | Every session (status, timestamps, log appends) |
| `references.json` | **Reference catalog** — `[ref:]` idioms as data | A conformance idiom changes |
| `contexts/<slug>.md` | Work order per state | The state is authored or amended |
| `contexts/_shared.md` | Centralized definitions | A shared definition changes (once) |
| `scripts/audit_c6.py` | Phase-cumulative audit runner | A criterion/check is added (by the audit states) |

`dag.json` node schema (per template) plus a `changes` block
(`deletes`/`resigns`/`renames`) on every state that changes a symbol, so
`gap-check --discover` re-derives callers.

`transition_log` and `amendment_log` entry shapes follow the skill templates;
plan mutations go in `amendment_log` (never `transition_log`).

---

## Rollback

Every plan write is committed (R1), so rollback is `git revert` of the relevant
plan commits plus the source they carried. Per state:

- `consolidate-legacy` — deletes the superseded `scripts/host/**` duplicate;
  reverting restores the dead duplicate (no behaviour change, since nothing
  product-facing imported it). The canonical `libs/host-runtime` is untouched. Safe.
- `policy-core` / `inproc-policy` — pure additions; revert the commit. Safe.
- `process-boundary` — the enforcement is gated on a declared `permissions`
  block; reverting restores the unbounded spawn. No data migration. Safe.
- `mcp-path-guard` — reverting restores the unguarded `db_path` sink. Safe.
- Audit states — read-only; reverting drops checks, not behaviour.

No state performs an irreversible action (no data migration, no destructive
filesystem change). The branch (`feat/c6-permissions`) can be abandoned wholesale
without affecting `feat/nx-migration`.
