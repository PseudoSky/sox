# NOTES — defects and deferrals from the ML agent trio build

Items observed on 2026-09-21/22 while building and execution-testing the ML agent trio
(`ml-research-scout`, `ml-system-architect`, `ml-algorithm-implementer`; claude-agents
commit `c69d86c0`).

**All of these are now filed in the backlog graph — the graph is the source of truth and
this file is a frozen narrative record with repro steps.** Work the items from the graph,
not from here. The `backlog` MCP server is still down (item 1), but the `backlog` CLI
binary reaches the same store and is what filed them.

| # | Backlog UID | Project | Pri | Item |
|---|---|---|---|---|
| 1 | `c98f2ba9-243b-4b31-bade-68ad4509e817` | sox-ecosystem | HIGH | backlog MCP `CONNECTION_CLOSED` while the CLI works |
| 2 | `148601b7-8dbd-46e5-81d2-62abf26e6b9e` | sox-ecosystem | HIGH | near-dup pass silently invalidates the older node of any ≥0.95 pair |
| 3 | `1f6ed3d6-b4e6-4bba-b534-ee9e4f258897` | sox-ecosystem | MEDIUM | `memory_entity_episodes.total` counts episodes the array omits |
| 4 | `045a82d3-96c0-4668-ab40-508cbabbf335` | sox-ecosystem | MEDIUM | default `chunk_size` 500 → child chunks with `topic:null, tags:[]` |
| 5 | `0a9becb4-68cb-4e00-85b8-7927afecc835` | sox-ecosystem | HIGH | `E_BUSY` recurrence at parallelism 3 (recurrence of `030d7736`) |
| 6 | `24cc0c97-e336-4b14-a0a6-14dca938f462` | claude-agents | MEDIUM | `ml-engineer` vs `machine-learning-engineer` undifferentiated |
| 7 | `2a90406d-0333-4225-8cd1-f09a5df3071a` | claude-agents | MEDIUM | root README has no per-agent listing; stale agent counts |
| 8 | — | — | — | CUSUM ARL contract defect — **resolved in spec**, not deferred: the fix is the statistical-test protocol requirement now in `ml-system-architect.md` |
| 9 | `e200554d-a4d1-49ab-8d71-206094423f0b` | claude-agents | LOW | two scout watch-list research follow-ups |
| 10 | `0331b34a-3969-470c-9cca-78d0a088b0d1` | claude-agents | LOW | scout intake brief has no "data availability" field |
| 11 | `0a26860e-2264-4dd9-ac4e-af29197a8c3a` | sox-ecosystem | LOW | iterative-research-refinement runtime gate is opencode-only |
| + | `56865633-22ca-4636-aa8a-c2b88866cfd3` | sox-ecosystem | MEDIUM | the `backlog` skill documents a command surface the binary lacks (found while filing the above) |

Refinement record with all run evidence: `claude-agents/.research-trace/2026-09-21-ml-agent-trio.md`.

---

## 1. backlog MCP — `CONNECTION_CLOSED` at session start, every session that day

**Repo:** sox-ecosystem (backlog server) · **Severity:** high — blocks the "file every deferral at discovery" rule fleet-wide

**Observed:** the claude-agents session started with `backlog (CONNECTION_CLOSED): "Connection closed"`; every dispatched subagent (6 runs, sonnet and opus) reported the same. The memory-server on the same machine connected fine.

**Repro:**

1. Open a Claude Code session in `~/dev/ai/claude-agents` (its `.mcp.json` registers `backlog`).
2. Read the MCP status block in the first system reminder, or run `/mcp`.
3. Expected: `backlog` connected. Actual: `CONNECTION_CLOSED`.
4. Check the server's own log / start it by hand with the command from `.mcp.json` to capture the exit reason (not done in-session — the failing command's stderr was not surfaced by the harness).

**Related:** an earlier session (memory `01M33E3G4C8X94SKZYP143TN4R`, 2026-09-18 and 2026-09-21) recorded `adhd-backlog` **writes** failing with `Write I/O failure … retryable: true` while reads worked. Check whether this is the same store-level fault progressing to a connection-level failure.

---

## 2. memory-server — near-duplicate pass silently invalidates the OLDER of any ≥0.95-cosine pair, including a parent vs its own chunk; `reason: null`, no supersession edge, `is_current: true`

**Repo:** sox-ecosystem (`packages/memory*`, near-dup / SAME_AS enrichment) · **Severity:** HIGH — silent destruction of divergent findings; the tagged node of a chunked episode is the one that dies

**Verified live 2026-09-22 03:5xZ via MCP only (`memory_supersession_chain`, `memory_related`, `memory_near_duplicates`; the store is Turso, not sqlite — do not use the sqlite3 CLI):**

Mechanism (7 `already_merged: true` pairs in `memory_near_duplicates({project_path: "/Users/nix/dev/ai/claude-agents", topic: "technique-catalog"})`): for every SAME_AS pair with cosine ≥ ~0.95 the pass sets `t_invalid` on the **older** node and keeps the newer, with `reason: null`, no `supersedes_uid`, and no chain link. The chain API then reports the dead node as `is_current: true`.

| Pair (newer keeps, older invalidated) | cosine | What was lost |
|---|---|---|
| `01M33GZ12J9DP8N6CAT76VVFB1` (child chunk, created +0.4 s) vs **parent `01M33GZ0NZTF75PY35PGJP2910`** | 0.951 | **Self-duplicate.** The parent was compared with its own `DERIVED_FROM` chunk (the chunk is the parent's first 500 tokens) and lost. The parent carried `topic`, `tags`, `MENTIONS` edges; the surviving chunks (`…VVFB1`, `…T69W`, both `t_invalid: null`) have `topic: null`, `tags: []`, and `memory_related` returns **zero edges** for them. The knowledge is live but unreachable by any filtered recall. |
| `01M33GSMA9NTK5MZ5ZFE2VAATP` (scout v2 verdict: off-the-shelf rrcf, strict license) vs `01M33FZRMG14QXTW5KEHK85BYP` (scout v1 verdict: compose HST+CUSUM) | 0.951 | **Two different conclusions** for the same use case; the earlier one — which `ml-system-architect` had already consumed as its brief of record — was invalidated at 02:58:23Z. A future recall now shows only the rrcf verdict and no trace that a compose verdict ever existed. |
| `01M33HK9TA7CG41WZ2EHJ2D7RQ` (v3 HST, blocked evidence-untraceable) vs `01M33GR9JK39B6M8Y6XJ0XP1RA` (v2 HST) | 0.953 | Earlier grading with different evidence notes gone (03:12:45Z) |
| `01M33GS0E8WM0MTZ0AZYRH0J0H` vs `01M33FY0ESEAHCQA81Q136C924` (NAB benchmark) | 0.954 | v1 benchmark entry gone (02:58:01Z) |
| `01M33GRDBHJEVF4S4DP8W9JGH6` vs `01M33FX5PW6PQNTGKT450WY1J9` (ADTK) | 0.961 | v1 entry gone (02:57:46Z); note the two disagree on `kind` (model vs algorithm) |
| `01M33GRBQNND9JSKPSRMES4V6J` vs `01M33GRBFYWTZ4X9RF8WQAQNS2` (Online-IF, same run) | 0.951 | Chunk-vs-parent again, same shape as row 1 |
| `01M33FXKTAKC53SMXJ2J42G2HT` vs `01M33FXKJPC49NS8FWCB74J1N3` (DBSCAN, E_BUSY retry) | 0.954 | The only pair that is a true duplicate (client retry after `E_BUSY`; both writes had landed). Even here the caller was told the *first* UID and validated against it; the pass killed that one. |

Every invalidation landed 2–15 s after the newer write, i.e. inside the window in which the writing agent runs its post-write validation.

**Repro (MCP tools, ~1 min):**

1. `memory_write` episode A (>500 tokens, default `chunk_size`, `topic: "t-test"`, `tags: ["k:test"]`, `project_path` set). Note UID A.
2. `memory_related({uid: A, rel: ["DERIVED_FROM"]})` → chunk UIDs C1, C2 (created ~0.4 s after A).
3. Wait ~5 s. `memory_supersession_chain({uid: A})` → `t_invalid` set, `reason: null`, `is_current: true`. `memory_related({uid: A})` shows `SAME_AS` to C1 with cosine ≈ 0.95.
4. `memory_supersession_chain({uid: C1})` → `t_invalid: null`; `memory_related({uid: C1})` → `edges: []`; `memory_recall({filters: {tags: ["k:test"]}})` → nothing.
5. For the divergent-conclusion case: `memory_write` two episodes with the same YAML skeleton and opposite `verdict:` values 10 s apart; the first is invalidated.

**Expected:**
- The pass never compares a node with its own `DERIVED_FROM` descendants (or chunks inherit topic/tags/edges and the parent is exempt).
- A merge is a SUPERSEDES/SAME_AS link plus a `reason`, never a bare `t_invalid`; `is_current` must be false on an invalidated node.
- High cosine on a shared template is not equality: two `selection:verdict` episodes with different `verdict:`/`chosen:` fields must both survive (compare structured fields, or require `content_hash` equality for auto-merge and leave ≥0.95 pairs as SAME_AS suggestions for `memory_curate`).

**Immediate mitigation in the agent specs (already committed, claude-agents `c69d86c0`):** `chunk_size: 1500/4000` so entries are single nodes (removes the self-duplicate case), `client_request_id` on writes. It does **not** protect divergent verdicts; until fixed, a re-run of the scout on a use case overwrites its prior verdict's existence.

## 3. memory-server — `memory_entity_episodes.total` counts invalidated episodes that the `episodes` list omits

**Repo:** sox-ecosystem · **Severity:** low — pagination/UX inconsistency, but it made an agent believe its write was lost

**Observed:**

- 2026-09-22 ~03:03Z (architect run): `memory_entity_episodes({entity_name: "kind:architecture-pattern"})` → `total: 1`, `episodes: []`.
- 2026-09-22 ~03:25Z (verified while writing this note): same call → `total: 3`, `episodes: [2 items]`. The missing one is the invalidated parent from item 2.

**Repro:**

1. Produce an invalidated episode that mentions an entity (item 2 steps 1–3, or `memory_invalidate` on any episode tagged with a unique test tag).
2. `memory_entity_episodes({entity_name: "<that tag>"})`.
3. Expected: `total` equals `episodes.length` (or the response says how many were filtered). Actual: `total` includes the invalidated node; the list does not.

---

## 4. memory-server — default `chunk_size: 500` splits a normal catalog entry into child chunks with `topic: null, tags: []`

**Repo:** sox-ecosystem · **Severity:** medium — filtered recall cannot find the chunk that holds the data; agents mis-diagnose it as a lost write

**Observed (scout v2 run, 2026-09-22 02:5xZ):** a ~1,900-char technique entry was auto-split into two episodes; the child `01M33GRBFYWTZ4X9RF8WQAQNS2`-derived chunk surfaced in a plain-query recall with `topic: null, tags: []`, and the tag-filtered `t_created_after` validation pass missed it entirely. Earlier chunked lessons in this store show the same shape (e.g. `01M33EA5MCTXDPD0HHG7247WPX`, `topic: null, tags: []`).

**Repro:**

1. `memory_write({content: <1,900-char YAML-ish entry>, topic: "technique-catalog", tags: ["technique:approved", "kind:algorithm"], project_path: "<root>"})` with no `chunk_size`.
2. `memory_recall({query: "<a phrase from the second half of the content>", limit: 5})` → the hit is a chunk with `topic: null, tags: []`.
3. `memory_recall({filters: {topic: "technique-catalog", tags: ["technique:approved"]}, limit: 20})` → the parent appears, the chunk does not.

**Expected:** chunks inherit `topic`, `tags`, and `project_path` from the parent (or filtered recall expands parent→chunks). **Workaround now baked into the three agent specs:** pass `chunk_size: 1500` (catalog entries) or `4000` (design episodes) and keep content <2,000 chars.

---

## 5. memory-server — transient `E_BUSY` ("database is locked") on `memory_write` under concurrent agents

**Repo:** sox-ecosystem · **Severity:** low — one retry succeeds

**Observed:** scout v1 run (2026-09-22 02:41–02:45Z) hit `E_BUSY` twice across nine writes while three other subagents were writing; each succeeded on one retry. Ping at the time reported `write_queue.mode: "bypass"`, `admission_control: inactive`, `write_latency_ms.p99: 21727`.

**Repro:**

1. Dispatch three subagents that each issue 5–10 `memory_write` calls within the same minute.
2. Watch for `{"error": {"code": "E_BUSY", "message": "database is locked"}}`.
3. Expected under `multiprocess-wal`: no `E_BUSY` for writes this small, or server-side retry before surfacing. The agent specs now retry once after 2 s with a `client_request_id`.

---

## 6. claude-agents — `ml-engineer` and `machine-learning-engineer` are near-duplicates (now a 5-way routing neighborhood)

**Repo:** claude-agents · **Severity:** medium — auto-routing cannot discriminate

**Observed:** `categories/05-data-ai/ml-engineer.md` and `machine-learning-engineer.md` are both 290/279-line bullet-list imports, both `model: sonnet`, identical tool lists, descriptions "building production ML systems requiring model training pipelines, model serving…" vs "deploy, optimize, or serve machine learning models at scale in production". With the trio added, five agents now answer "build me an ML system".

**Repro:**

1. `rg -n '^description:' categories/05-data-ai/ml-engineer.md categories/05-data-ai/machine-learning-engineer.md`
2. `diff <(sed -n '10,140p' categories/05-data-ai/ml-engineer.md) <(sed -n '10,140p' categories/05-data-ai/machine-learning-engineer.md) | grep -c '^[<>]'` — count the differing lines against ~130.
3. Ask a fresh session "build a production ML training + serving pipeline" and see which of the five it picks; repeat 3×.

**Decision needed (user's call):** merge into one, or retire both in favor of `ml-system-architect` → `ml-algorithm-implementer` + `mlops-engineer`.

---

## 7. claude-agents — root `README.md` has no per-agent listing; CLAUDE.md's "update Main README" contribution step is stale

**Repo:** claude-agents · **Severity:** low — doc drift

**Observed:** `rg -n '^- \[\*\*' README.md` returns nothing; the root README lists plugins (`## Plugin Catalog`), not agents. CLAUDE.md "Contributing a New Subagent" step 1 still says to add `- [**agent-name**](path) - description` there. The `sox-data-ai` row in that table also says `5` agents; the plugin manifest has 17.

**Repro:** `rg -n 'Main README|sox-data-ai' CLAUDE.md README.md` and compare with `jq '.agents|length' categories/05-data-ai/.claude-plugin/plugin.json`.

**Fix:** point step 1 at `docs/catalog/INDEX.md` (which is where cv-developer and the trio were actually registered) and regenerate the plugin counts in the root table.

---

## 8. claude-agents / stall-detector design — one-sided CUSUM ARL band applied to a two-sided detector (contract defect found by the implementer test)

**Repo:** claude-agents (test artifact under `$CLAUDE_JOB_DIR/tmp/exec-test-v1/docs/design/stalled-agent-detection/`, not shipped) · **Severity:** informational — it is why the architect spec now requires a stated simulation protocol for statistical tests

**Observed:** Work-Order test T-M4-2 required "mean run length to false alarm ∈ [500, 1500] (theory ≈ 930)" for k=0.5, h=5. The band is the one-sided tabular CUSUM ARL₀; the Design Record mandates a two-sided bank, whose combined false-alarm ARL is roughly half. Measured: one-sided control 919.1; two-sided 483.3 (200 seeded runs each). The implementer refused to widen the band and escalated.

**Repro (stdlib + numpy, ~20 s):**

```python
import numpy as np
def arl(two_sided, k=0.5, h=5.0, runs=200, cap=20000, seed=42):
    out = []
    for s in np.random.SeedSequence(seed).spawn(runs):
        rng = np.random.default_rng(s); cp = cn = 0.0
        for n in range(1, cap + 1):
            z = rng.standard_normal()
            cp = max(0.0, cp + z - k); cn = max(0.0, cn - z - k)
            if cp > h or (two_sided and cn > h): out.append(n); break
        else: out.append(cap)
    return float(np.mean(out))
print("one-sided", arl(False))   # 917.8 with this snippet (implementer measured 919.1)
print("two-sided", arl(True))    # 471.5 with this snippet (implementer measured 483.3) → outside [500, 1500]
```

---

## 9. ml-research-scout — two Watch-list research items its runs could not file

**Repo:** claude-agents (research follow-ups) · **Severity:** low

- **Benchmark `rrcf` 0.4.4 directly** (NAB or an internal hang corpus). The only public "Random Cut Forest" NAB score (51.7) belongs to AWS SageMaker's closed-source implementation, not the pip package — memory `01M33HK8Z31598ABBEA4TMH9CR`.
- **Re-fetch Tan/Ting/Liu 2011 (Half-Space Trees, IJCAI)** from a clean-text mirror and trace its AUC table; the IJCAI PDF fetched corrupted and Semantic Scholar 429'd — memory `01M33HK9TA7CG41WZ2EHJ2D7RQ`. Also `https://hal.science/hal-02874869v2/document` (Anubis bot-block) and `https://link.springer.com/chapter/10.1007/978-3-030-58811-3_2` (paywall).

**Repro:** `memory_recall({filters: {tags: ["block:evidence-untraceable"]}})` lists both with the exact blocked sources.

---

## 10. ml-research-scout v1.1 candidate — brief lacks a "data availability" field (handoff-gap target not met)

**Repo:** claude-agents · **Severity:** low — spec improvement

**Observed:** the architect's v1 run found that none of the brief's three telemetry streams exist as described in the supervisor (tool-call latency is not recorded — PostToolUse stamps end time only; tokens live only in transcript JSONL; OTel is configured with no collector). Scout→architect handoff produced 10 assumptions on the full task vs a ≤1 target. The scout cannot read project source by design, so the fix is a brief field the *caller* must fill: `Data availability — which streams exist, where, at what resolution`.

**Repro:** dispatch `ml-research-scout` on the stall-detection brief in `.research-trace/2026-09-21-ml-agent-trio.md`, then `ml-system-architect` on its Selection Brief; count `ASSUMED` rows tagged A2/A11 in `DESIGN.md §1.2`.

---

## 11. iterative-research-refinement — runtime-metrics gate is opencode-only

**Repo:** sox-ecosystem (`extensions/skills/iterative-research-refinement/`) · **Severity:** low — the skill's mandatory promotion-gate item 6 cannot be satisfied from Claude Code

**Observed:** `scripts/runtime-metrics.mjs` reads `~/.local/share/opencode/opencode.db` keyed by opencode session ids; Claude Code `Agent` dispatches produce no rows there and the teammate result messages carry no token/cost telemetry. Only wall-clock (from the agents' own phase logs) and call counts were comparable.

**Repro:** run any Loop 3a dispatch from Claude Code, then `node scripts/runtime-metrics.mjs <any id>` — no matching session.

**Fix direction:** accept a JSONL telemetry file the dispatching agent writes (start/end timestamps, tool-call count, tokens when the host exposes them) as an alternative source, and say in §Runtime Metrics which hosts can produce the full table.
