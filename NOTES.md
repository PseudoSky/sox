# NOTES — unfiled defects and deferrals

Items observed on 2026-09-21/22 while building and execution-testing the ML agent trio
(`ml-research-scout`, `ml-system-architect`, `ml-algorithm-implementer`; claude-agents
commit `c69d86c0`). None could be filed to the backlog graph because the `backlog` MCP
server failed to connect for the whole session (item 1). Each entry carries repro steps;
file it, then strike it here with the item ID.

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

## 2. memory-server — async near-duplicate pass invalidates a fresh parent episode with `reason: null`, leaving orphan chunks

**Repo:** sox-ecosystem (`packages/memory*`) · **Severity:** medium — silent data loss from the caller's point of view

**Observed (verified live 2026-09-22 03:2x UTC):**

- `memory_write` returned `01M33GZ0NZTF75PY35PGJP2910` at `03:01:17.632Z`; the episode was invalidated at `03:01:20.208Z` (2.6 s later) with `reason: null`.
- `memory_supersession_chain({uid: "01M33GZ0NZTF75PY35PGJP2910"})` returns `{"t_invalid": "2026-09-22T03:01:20.208Z", "reason": null, "is_current": true}` — invalidated *and* current, and nothing in the chain supersedes it.
- Its two child chunks `01M33GZ12J9DP8N6CAT76VVFB1` and `01M33GZ16JN19AP118V370T69W` stayed live (DERIVED_FROM a dead parent).
- `memory_update({uid: "01M33GZ0NZTF75PY35PGJP2910", …})` then fails `E_NOT_FOUND`, so the documented fix-up path cannot repair it; the caller had to rewrite with a new `client_request_id`.

**Repro:**

1. `memory_write` an episode >500 tokens (default `chunk_size`) with `topic: "technique-catalog"`, tags `["kind:architecture-pattern", …]`, `project_path` set. Note the returned UID.
2. Within ~1 s, `memory_write` a second episode with substantially overlapping content (the architect wrote the pattern episode and the design-decision episode back to back; both summarize the same design).
3. Wait 5 s. Call `memory_supersession_chain` on the first UID → `t_invalid` set, `reason: null`, `is_current: true`.
4. `memory_recall({filters: {tags: ["kind:architecture-pattern"], t_created_after: <step-1 time>}})` → the parent is gone; child chunks are recallable by content but carry `topic: null, tags: []`.

**Expected:** either no invalidation (the two episodes are not duplicates — different topic/tags), or an invalidation that names a `reason` and a superseding UID, and that invalidates (or re-parents) the chunks with the parent.

---

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
