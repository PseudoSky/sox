# Hardened verification — the evidence contract

Phase 6 runs `scripts/verify-research-run.mjs <run_dir>`. The verifier is the gate: it reconstructs
what happened from **disk artifacts, the memory read-back, and the tool manifest** — never from a
prose summary. It exits `1` if any check fails, printing each failure.

## Required layout

```
<run_dir>/
  manifest.json
  questions.json
  routing.json
  findings/<qid>.md            # one per research question (inline or dispatched)
  memory-readback.json
  trace.md
```

## manifest.json

`capabilities` is a **top-level** object: what is **available** here and what is **absent**
(ADR-0026 D6). Nesting it under a phase object fails the verifier.

```json
{
  "run_id": "2026-10-02-<slug>",
  "cwd": "/abs/path",
  "phases": [0,1,2,3,4,5,6,7],
  "capabilities": { "available": ["memory", "search", "backlog"], "absent": [{"name": "code-intel", "why": "not exposed"}] },
  "min_sources_per_finding": 1,
  "min_questions": 1,
  "tool_use": {
    "search_terms": 9, "sources_verified": 4, "rate_limit_events": 0,
    "calls": [ { "capability": "search", "tool": "<name>", "query": "<query or URL>", "outcome": "success" } ]
  }
}
```

`manifest.json` is a top-level **object**; `questions.json` is a top-level **array**; `routing.json`
is a top-level **object** keyed by question id. A plain `capabilities` array is accepted and read as
all-available. A question whose playbook needs an absent capability routes
`not-research (capability <name> absent)`.

`tool_use.sources_verified` is a **global** distinct-source count (never per-finding).
`tool_use.calls` records every external call: every citation URL must match a successful entry, and
`tool_use.search_terms` must be ≥ 3 × the number of `research` questions.

## questions.json

An array; each item:

```json
{ "id": "q0001", "question": "…", "domain": "db-storage",
  "resolution": "memory|research|not-research",
  "regen_history": [ { "from": "…", "reason": "…", "to": "…" } ],
  "memory_uids": ["<uid>", "…"] }
```

`regen_history.length <= 2` (hard cap). `resolution: "memory"` requires non-empty `memory_uids`, and
those uids must be the episode(s) the resolution was actually drawn from — a question with no
episode behind it is not memory-resolved. `research` means the question is researched (inline or
dispatched — the word does not imply a subagent).

## routing.json

```json
{ "q0001": ["P2", "P5"], "q0002": "not-research (capability code-intel absent)", "q0003": "memory (resolved in Phase 2)" }
```

**Every** question id has an entry. Every `research` question maps to one or more playbook ids in
`P1..P7` (a list when more than one domain applies); every `not-research` question carries a
parenthesised reason; a memory-resolved question reads `memory (resolved in Phase 2)`.

## findings/<qid>.md

One file per research question, non-empty, containing at least: a `confidence:` line with
`HIGH|MEDIUM|LOW`, at least one citation line (`file:…` or `http…`), and — when the `memory`
capability is available — a `memory_uid:` line. Unless confidence is LOW, at least one citation
must be present. A LOW finding must be listed in the answer's "Conflicts / LOW-confidence items"
section. A citation either pins a revision (tag/sha/permalink) for a versioned source, or reads
`retrieved <ISO date> from <URL>` labelled `living-doc` — a living page has no per-revision URL.

## memory-readback.json

Required iff the manifest declares `memory` available. It re-reads what **this run wrote** — the
`memory_uid:` recorded on each finding — via a `run:<run_id>` tag recall, or, where the memory
capability has no tag-scoped recall, by re-reading each written uid the way the capability allows.
Uids recalled in Phase 2 for context belong to earlier runs and are **not** part of the read-back.
Each is recorded with its resolution status:

```json
{ "run_id": "2026-10-02-<slug>",
  "uids": { "<uid>": { "status": "resolved" }, "<uid2>": { "status": "BLOCKED" } } }
```

The verifier requires **every written uid** to be a key whose status is not `BLOCKED` — an absent
or BLOCKED uid is a failed write and fails the run.

## trace.md

Must contain one Position-Declaration block per phase, naming `Phase: 0` … `Phase: 7` and
`Previous Phase completed: Yes`.

## What the verifier checks (in order)

1. `manifest.json` exists, parses, and has `run_id`, `phases`, `capabilities`, `tool_use`.
2. `questions.json` exists, parses, and has ≥ `min_questions`; every `regen_history` ≤ 2;
   every `resolution` is `memory|research|not-research`.
3. `routing.json` exists and parses; **every** question id has an entry; every `research` question
   maps to one or more `P1..P7` playbooks; every `not-research` question a parenthesised reason; a
   memory-resolved question reads `memory (...)`.
4. For every `research` question: `findings/<qid>.md` exists and is non-empty; carries a
   `confidence:` label and ≥1 citation (unless LOW); citations meet `min_sources_per_finding`;
   **when `memory` is available, a `memory_uid:` line is required**.
5. If `memory` is available: `memory-readback.json` exists and every uid **this run wrote** (each
   finding's `memory_uid:`) is present with a non-BLOCKED status.
6. `trace.md` names phases 0–7 with `Previous Phase completed: Yes`.
7. `tool_use.sources_verified` (global) ≥ the number of distinct citations across findings, where
   each citation is trimmed of trailing prose punctuation (a declared under-count is a contradiction
   → fail).
8. `tool_use.rate_limit_events <= 2`.
9. `tool_use.search_terms` ≥ 3 × the number of `research` questions.
10. **tool provenance** — `tool_use.calls` is a non-empty array when there is ≥1 `research`
    question, and every citation URL matches a `calls` entry whose `outcome` is not a failure. A
    citation with no matching call fails (a fabricated citation cannot pass).

Exit `0` only when all pass; otherwise exit `1` with the failure list. The run is **not complete**
until it exits `0`.
