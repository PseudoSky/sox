<!-- SCRATCH / living ledger — real per-dispatch token actuals, recorded after each
     subagent completes, to calibrate the ~4–8M total-execution estimate (which is
     n=0 / model-of-a-model). Updated by the orchestrator after every subdispatch. -->
# Execution cost ledger — tokenguard-service

Real `subagent_tokens` recorded **after each subdispatch**, to replace the n=0
estimate with measured data. "Tokens" = the subagent's reported total
(input+output) for that run, including its guard/build-iterate cycles.

## Estimate being calibrated
- Pre-execution estimate: **~4–8M tokens** total (midpoint ~5–6M) to a green final audit.
- Read-only anchor (planning phase): `architect-reviewer` plan review = **84,407** tokens (73 tool-uses, ~365s). A *write* agent that build-iterates is expected 3–8× this.

## Ledger

| # | Phase | State / task | Agent | subagent_tokens | tool_uses | duration | guard | notes |
|---|---|---|---|---|---|---|---|---|
| A0 | plan | (plan architecture review) | architect-reviewer | 84,407 | 73 | ~365s | n/a | read-only anchor; GO-WITH-CHANGES, 7 findings |
| 1 | core | core-engine | sox-active:typescript-pro | **52,751** | 37 | ~370s | **PASS** (`nx build` exit 0) | ported core.py → 9 files; smooth (no build-fix loop); 3 in-spec deviations (seed type label/id, DetectorConfig re-export, 1 intra-pkg require for circular dep) |

## Transition-engine note (v0.8.13 — skill-feedback candidate)
`state-transition.js --complete core-engine` returned `status: audit_failed (0/20)` **even though the state completed correctly** (state.json `core-engine: complete`, `end_ref` set, `nx build` green, `core-engine.1–5` all PASS). The 0/20 is a *forward-looking* run of the **framework**-phase audit (20 criteria) after `current_state` advanced — it can't pass mid-plan. A `--complete` should report on the **completed** state's guard/criteria, not a look-ahead phase; the misleading `audit_failed` could make an orchestrator falsely halt. → file as a fix for plan-state-machine.

## Running totals
- Execution dispatches recorded: **1** (core-engine verified complete)
- Execution `subagent_tokens` so far: **52,751**
- Mean per coding-state (so far): **52,751** (n=1, a Hard-tier state that ran clean)

## Recalibration log

**After #1 (core-engine):** 52,751 — **6–10× under** my 300–500k guess for this state.
Two things were wrong in the original estimate:
1. **Metric mismatch.** `subagent_tokens` (what I can measure) ≠ the loose "combined
   input+output throughput" I estimated in. The original 4–8M figure was in the wrong,
   broader unit. **Recalibrating in `subagent_tokens` from here.**
2. **Overestimate even so.** core-engine is a Hard state (porting a 27KB engine) and
   still came in at ~53k because it ran *clean* — no audit-fix loop, no build failures.

**Re-projected full plan (in `subagent_tokens`, executor dispatches only):**

| Tier | States | Est. each | Subtotal |
|---|---|---|---|
| Easy | decouple-generalize | ~25k | 25k |
| Med | service-type, core-invariants, tg-cli, code-review | ~50k | 200k |
| Hard | http-transport, tg-service | ~90k | 180k |
| V.Hard / debug-loop risk | mcp-as-service | ~120k | 120k |
| Hard (actual) | core-engine | 52,751 | 53k |
| Audits ×4 | clean→cheap, fix-loops→expensive | ~35k | 140k |
| **Executor total** | | | **~720k** (range 0.5M–1.5M) |

- **Orchestrator (my own tokens)** are separate and not in `subagent_tokens`; they accumulate across the loop.
- **Dominant variance = failure loops.** core-engine ran clean; if `mcp-as-service` (C6 non-regression) or `tg-service` (streaming) hit repeated build/audit failures, those states alone could 2–4× their estimate. The risk is asymmetric (upside).
- **Net:** the realistic executor-side total is **~0.7M `subagent_tokens` (range 0.5–1.5M)** — an order of magnitude below the original 4–8M, which was both the wrong metric and too high. Next datapoint (`service-type`) tests whether a *framework-edit* state (vs. a greenfield port) holds the ~50k figure.
