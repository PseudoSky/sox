# Orchestration ledger — memory-refactor

**Skill version:** 0.8.24 (installed cache, upgraded from 0.8.21 via /reload-plugins)  
**Orchestrator session:** 2026-06-27  
**Plan dir:** `docs/plan/memory-refactor/`  
**Branch:** `feat/memory-refactor`

---

## Preflight run — 2026-06-27

### compile-task --board
- 15 states · critical-path cost 12 · **all states unrated** (tier fallback to routing-table defaults)
- Parallel waves: 0–11 (wave 4: w2a‖w2b; wave 5: w2c‖w2d-ingest; wave 6: w2d-analysis‖w2d-hybrid-search)

### gap-check (post plan-builder repair)
- Original: **87 FAILs** (F1–F6 structural + F7 forward-refs)
- After repair: **34 FAILs** — all F7 forward-reference class (audit check IDs that live in `audit_memrefactor.py`, authored by `audit-baseline`; DoD clauses unmapped until script exists; final-review boxes correctly unchecked). **None blocking.**
- Structural defects cleared: F1 glob/explicit mismatch (60), F2 p1-layout project.json (9), F3 references.json schema (1), F4 missing DoD (1), F5 missing final-review.md (1).

### env-pin-check --strict
- Original: **7 UNPINNED** (bare `npx nx` in w2a–w2e guards)
- After repair: **0 UNPINNED** — all guards pinned to `npx --yes nx`

### Script availability note
- `compile-wave.js` — present in 0.8.24 ✅
- `budget-estimate.js` — present in 0.8.24 ✅

### Wave pack decisions (compile-wave --stats)
| Wave | Slugs | reduction_ratio | Decision |
|---|---|---|---|
| 4 | w2a ‖ w2b | **-0.081** | ❌ no pack (negative — pack adds bytes) |
| 5 | w2c ‖ w2d-ingest | **-0.068** | ❌ no pack |
| 6 | w2d-analysis ‖ w2d-hybrid-search | **-0.088** | ❌ no pack |

All parallel waves share zero invariants, zero refs, zero snapshots — the pack header is pure overhead. Every executor gets a full independent work order.

---

## Compiled packet stats — all 15 states

| Wave | Slug | Kind | Tier (default) | work_order_bytes | reduction_ratio | wave_pack | pre-loaded bytes | budget est. |
|---|---|---|---|---|---|---|---|---|
| 0 | p0-baseline | work | sonnet | 42,440 | 0.627 | n/a (single) | 0 (files new) | ~17k in + ~6k out = ~23k |
| 1 | audit-baseline | audit | opus | 1,977 | 0.983 | n/a (single) | 0 (file new) | ~6k in + ~4k out = ~10k |
| 2 | p1-layout | work | sonnet | 4,561 | 0.960 | n/a (single) | varies | ~4k in + ~6k out = ~10k |
| 3 | audit-layout | audit | opus | 1,950 | 0.983 | n/a (single) | ~4k (audit script) | ~6k in + ~4k out = ~10k |
| 4 | w2a-embedding-provider | work | sonnet | 2,505 | 0.978 | **no** (ratio -0.081) | 0 (files new) | ~4k in + ~6k out = ~10k |
| 4 | w2b-graph-store | work | sonnet | 2,491 | 0.978 | **no** (ratio -0.081) | 0 (files new) | ~4k in + ~6k out = ~10k |
| 5 | w2c-vector-store | work | sonnet | 3,517 | 0.969 | **no** (ratio -0.068) | 0 (files new) | ~4k in + ~6k out = ~10k |
| 5 | w2d-ingest | work | sonnet | 2,227 | 0.980 | **no** (ratio -0.068) | 0 (files new) | ~4k in + ~6k out = ~10k |
| 6 | w2d-analysis | work | sonnet | 3,246 | 0.972 | **no** (ratio -0.088) | 0 (files new) | ~4k in + ~6k out = ~10k |
| 6 | w2d-hybrid-search | work | sonnet | 1,257 | 0.989 | **no** (ratio -0.088) | 0 (files new) | ~4k in + ~6k out = ~10k |
| 7 | w2e-domain-rewire | work | sonnet | 2,144 | 0.981 | n/a (single) | varies (existing src) | ~4k in + ~6k out = ~10k |
| 8 | audit-extraction | audit | opus | 1,449 | 0.987 | n/a (single) | ~12k (audit script) | ~6k in + ~4k out = ~10k |
| 9 | p4-routing | work | sonnet | 3,581 | 0.969 | n/a (single) | 0 (files new) | ~4k in + ~6k out = ~10k |
| 10 | audit-routing | audit | opus | 1,919 | 0.983 | n/a (single) | ~16k (audit script) | ~6k in + ~4k out = ~10k |
| 11 | audit-final | audit | opus | 1,861 | 0.984 | n/a (single) | ~20k (audit script + pack-smoke) | ~6k in + ~4k out = ~10k |

**Wave pack decisions:** all three parallel waves evaluated — ratios -0.081, -0.068, -0.088 (all negative, zero shared invariants/refs/snapshots). No pack for any wave; every executor gets a full independent work order.

---

## Dispatch log

*(rows appended as states complete)*

| Wave | Slug | Executor | Tier | Tokens in/out | Guard exit | Retries | Outcome | Notes |
|---|---|---|---|---|---|---|---|---|

---

## Findings

### FND-1 — Skill upgraded 0.8.21 → 0.8.24 via /reload-plugins; compile-wave.js + budget-estimate.js now present
Initial compilation ran against 0.8.21 which lacked both scripts. After plugin reload, 0.8.24 is active and both scripts are available. Wave pack decisions and budget estimates now use the real scripts. All prior manual estimates superseded by the 0.8.24 figures in the table above.

### FND-2 — All 15 states unrated (model/effort)
Board shows `unrated:15`. Orchestrator falls back to routing-table defaults: **sonnet** for work states, **opus** for audit states (`audit-baseline`, `audit-layout`, `audit-extraction`, `audit-routing`, `audit-final`). This is appropriate given the plan's domain: audit states require cross-file synthesis and quality judgment (opus warranted); work states are well-specified extraction tasks (sonnet sufficient). No tier customization needed unless a state hits wrong-tier thrash.

### FND-3 — p0-baseline has highest work_order_bytes (42KB, ratio 0.63)
The p0-baseline packet is the largest by far — 42KB vs <4KB for all other states. This is expected: it carries the full `_shared.md` glossary + all context. Ratio 0.63 means 37% is already excluded (imports, refs). The packet is self-contained and appropriate for the task.

### FND-4 — w2d-hybrid-search context is thin (1.2KB, ratio 0.989)
The hybrid-search work order is suspiciously short (1.2KB) and has no explicit acceptance criteria in the compiled packet. The context file likely has the full spec but the compiled output truncated or the acceptance criteria section is empty. Verify the context file is complete before dispatch.

### FND-5 — Read-only snapshots show `<unresolved>` for all extraction states
Compiled work orders for w2a–w2e and p4-routing show `git show <start_ref>:...` placeholders for read-only source files. This is expected — `start_ref` is set at `--start` time, not compile time. The executor will resolve these at dispatch. No action needed.

### FND-6 — Plan-builder repair loop: 1 attempt used (cap = 2 per defect)
Plan-builder repaired F1–F6 in a single pass. 1 of 2 allowed repair attempts used. Remaining FAILs (34) are all F7 forward-reference class — not plan defects.

### FND-7 — Dispatch cost model gap in compile-wave.js; reflection stored to plan-orchestrator catalog
Observed during wave pack evaluation: `compile-wave.js --stats` `reduction_ratio` does not include base dispatch overhead (B≈27k tokens) or source file bytes (Si) in its measurement. The actual cost formula is `Di = B + Si + Ki`, meaning two tasks with zero prose overlap still save B tokens by merging into one dispatch. All 3 parallel waves were correctly evaluated as no-pack on prose grounds (ratios -0.081, -0.068, -0.088) but the missing merge-candidates analysis left ≈54k tokens of potential savings unquantified.

**Available plan fields not currently used in optimization:**
- `dag.json` `nodes[].artifacts` (reserved_files, read_only) → Si estimation
- `references.json` source-extract `sources[]` → per-state source file inventory at plan time
- `state.json` `metrics.tokens_est` → historical cost floor before emit-state-metrics populates it
- `budget-estimate.js` `--reserved-bytes` input → not fed back into merge decision

**Reflection stored:** `~/.memory/memory.db` · UID `01KW3F0GA02V058ZHDTDPJ4EEB` · `kind:lesson · subject:skill · target:plan-state-machine · actionable` · importance 7

**Tooling note:** `reflect.js` / `sox catalog note` / `REFLECTIONS.json` are deprecated and being removed — the reflection skill writes via `memory_write` to `~/.memory/memory.db`. A second reflection (UID `01KW3F11QS63D2BPQ7HG8MEC05`, `kind:bug · subject:self`) captures the self-diagnostic: wrong tooling path taken because SKILL.md was not read first.
