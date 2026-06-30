# TokenGuard Service — State Machine

> A human render of `dag.json`. `dag.json` is the machine source of truth for topology; `state.json` is the live runtime. Regenerate this after any structural change.

---

## States

| Slug | Name | Phase | One-line goal |
|---|---|---|---|
| `service-type` | SERVICE_PRIMITIVE | framework | `type: "service"` is declarable with a `transports` block; `soxe init service` scaffolds it born-conformant |
| `http-transport` | HTTP_TRANSPORT | framework | http transport routes through the unified service model; `http-get` health probe + clean stop on a port-holder |
| `mcp-as-service` | MCP_AS_SERVICE | framework | `mcp-server` folded onto the unified model as `service[transport=stdio]`; memory-server non-regresses |
| `audit-framework` | FRAMEWORK_AUDIT | **Audit** | Verify the service primitive, http transport, and stdio non-regression |
| `core-engine` | CORE_ENGINE | core | `@adhd/sox-tokenguard-core` engine library ported (Mapper + detectors + tokenize/detokenize + SSE) |
| `core-invariants` | CORE_INVARIANTS | core | round-trip / zero-leak / SSE-split / passthrough invariants ported as red→green tests |
| `audit-core` | CORE_AUDIT | **Audit** | Verify the engine invariants + no red-team vocabulary in the lib |
| `tg-service` | TOKENGUARD_SERVICE | service | tokenguard `service` extension: http proxy on the engine, provider adapters, standardized config, live map |
| `tg-cli` | TOKENGUARD_CLI | service | simple CLI to seed + inspect the live map; running proxy reflects CLI seeds without restart |
| `audit-service` | SERVICE_AUDIT | **Audit** | Verify real soxe lifecycle + live round-trip + CLI live-seed |
| `decouple-generalize` | DECOUPLE | final | zero WOP coupling (negative checks) + generic config-driven docs |
| `code-review` | CODE_REVIEW | final | orchestrator code review of every touched project; reviewer gate |
| `audit-final` | FINAL_AUDIT | **Audit** | Every `[dod.N]` + `[ref:]` proven; live demo produces the four founder-facing artifacts |
| `done` | TERMINAL | — | service primitive + generalized tokenguard shipped; mcp-server non-regressed |

**Audit states are mandatory hold points.** `audit-framework` gates `tg-service` (with `audit-core`); `audit-core` gates `tg-service`; `audit-service` gates `decouple-generalize`; `audit-final` gates `done`. No deferrable items in any audit.

---

## Topology

```text
framework:  service-type ──► http-transport ──► mcp-as-service ──► audit-framework ──┐
                                                                                     ├──► tg-service ──► tg-cli ──► audit-service ──► decouple-generalize ──► code-review ──► audit-final ──► done
core:       core-engine ──► core-invariants ──► audit-core ───────────────────────── ┘
```

Two parallel tracks (framework, core) over disjoint files converge at `tg-service`, then a linear final tail. Edges live in `dag.json` (`depends_on`); this diagram renders them.

---

## Transitions and guards

| From (slug) | Guard | Unlocks |
|---|---|---|
| `service-type` | `python3 …/scripts/guard_service_type.py` — `soxe init service` scaffolds + builds + validates | `http-transport` |
| `http-transport` | `python3 …/scripts/guard_http_transport.py` — http install routes + `http-get` health + clean stop | `mcp-as-service` |
| `mcp-as-service` | `python3 …/scripts/guard_mcp_as_service.py` — memory-server full lifecycle + C6 green | `audit-framework` |
| `audit-framework` | `python3 …/scripts/audit_tokenguard.py --phase framework` | `tg-service` |
| `core-engine` | `npx --yes nx build tokenguard-core` | `core-invariants` |
| `core-invariants` | `npx --yes nx test tokenguard-core` | `audit-core` |
| `audit-core` | `python3 …/scripts/audit_tokenguard.py --phase core` | `tg-service` |
| `tg-service` | `python3 …/scripts/guard_tg_service.py` — install/start/http-health/stop + live round-trip | `tg-cli` |
| `tg-cli` | `python3 …/scripts/guard_tg_cli.py` — CLI seed reflected in running proxy | `audit-service` |
| `audit-service` | `python3 …/scripts/audit_tokenguard.py --phase service` | `decouple-generalize` |
| `decouple-generalize` | `python3 …/scripts/guard_decouple.py` — zero WOP coupling | `code-review` |
| `code-review` | `python3 …/scripts/guard_code_review.py` — review PASS + clean typecheck/lint/test | `audit-final` |
| `audit-final` | `python3 …/scripts/audit_tokenguard.py --phase final` | `done` |

---

## File model

| File | Role | Mutated when |
|---|---|---|
| `dag.json` | Structure — nodes (slug → phase, depends_on, guard, artifacts, context) | reorder/insert/split/retire a state |
| `state.json` | Runtime — current_state, per-slug status+timestamps, logs | every session |
| `references.json` | Reference Pattern Catalog | a `[ref:]` idiom is added/changed |
| `contexts/<slug>.md` | Work order per state | the state is authored/amended |
| `contexts/_shared.md` | Centralized definitions | a shared definition changes (once) |

`transition_log` entries are appended on advancement; `amendment_log` entries when the plan itself changes (executor-class in place; planner-class stop+escalate), per the skill.

---

## Rollback

Every plan write is committed (R1), so rollback is `git revert` of the relevant plan + source commits on `feat/nx-migration`.

- **Reversible by revert:** all source under `libs/tokenguard-core`, `extensions/services/tokenguard`, and the additive framework changes.
- **Highest-risk irreversible-ish action:** the `mcp-as-service` refactor of the install/run routing. The mitigation is `[inv:no-regress-mcp]` proven at `audit-framework` and re-proven at `audit-final`; if memory-server regresses, **halt** ([dod.11]) and revert the framework commits before proceeding — the engine/service tracks do not depend on the refactor landing to remain individually revertible.
