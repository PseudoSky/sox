# P8 — root-distillation

**Decision class.** Distill an open-ended domain's unresolved problems into root classes and
residual gaps — "what is still unsolved in X, and WHY it resists engineering". This is *landscape*
research. It is NOT decision research (choosing between known options) and NOT evaluation (does
this candidate work).

**Scope domains.** Any domain, when the caller asks about unsolved problems / research frontiers /
open challenges / "what does the state of the art still not solve". Reachable only via the
`mode: root-distillation` input; absent that input, routing falls to P1–P7 as before.

**Answer category.** `root-distillation-table` + `synthesis` + `recommendation`.

## When this mode applies (and does not)

- Applies: "research unsolved problems in X", "what are the open problems across domain set Y",
  "find each problem's root complexity and research space", "what does the state of the art still
  not solve".
- Does not apply: "which of A or B should we adopt" (decision — use P1/P4), "is package P good"
  (eval — P1), "why did this system fail" (P2), "summarize the trend in X" (P4). If the caller's
  need is to *choose*, this mode is wrong; say so and route by the answer-category tie-break.

## The ladder (the load-bearing method)

**Step 1 — Enumerate open problems broadly.** Survey the domain's own literature and credible
secondary sources for the problems practitioners name as unresolved. Prefer breadth first. Record
each as a single-line problem statement. Do not yet judge tractability.

**Step 2 — Per problem: root complexity + research space.**
- *Root complexity*: WHY the problem resists engineering — the structural reason, not a restatement
  of the symptom. Ask "what property makes this hard?" (physical bound, underdetermined inference,
  a rate-limiting physical oracle, compounding error, coordination/standards).
- *Research space*: WHICH body of work attacks that root — named papers, standards, formal models,
  open-problem catalogs. A pointer a reader can follow, not a vibe.

**Step 3 — Per problem: residual gap (load-bearing).** State concretely what the state of the art
still does NOT solve — the "SOTA does not solve X" claim. This is where build-vs-buy lives: a
problem whose leaders already close the gap is an integration question; one whose leaders each leave
a named gap is a research bet. A residual gap must be a CONCRETE failing (a measured limit, an
explicitly unmet requirement, an acknowledged open problem), never a generic "it's hard".

**Synthesis — Collapse N → K.** Reduce the problems to K root classes along a named axis, and name
the residual gaps that recur across classes. The axis is mandatory; a synthesis with no axis is a
fail condition. Distinguish classes that are a *bound* (cannot be engineered away) from those that
are merely *unshipped*.

**Report.** The per-item table is the primary artifact; prose is optional.

## Output contract

1. **Per-item table (PRIMARY, compressed):**
   `| Problem | Root complexity | Research space | Residual gap | memory_uid |`
   One row per problem. Every cell resolvable.
2. **Synthesis:** the K root classes with their named axis, and the residual gaps that recur.
3. **Confidence** per item: HIGH / MEDIUM / LOW.
4. **Recommendation:** which class is a buildable frontier, which is a fixed bound, which is
   coordination-only.
5. **Provider caveats** actually encountered (see Warnings).

## Memory-recording contract (generalization-conformant)

This section is the mode's binding, and exists to make the process conform to the system's
generalization + memory-recording policies. It applies to `mode: root-distillation` ONLY.

- **Generalize before writing.** Strip the caller's project/repo specifics; a finding recorded here
  must stand for the domain generally, not for one codebase.
- **Memory-first.** Recall (`memory` capability) for prior work in Phase 2 before any external
  search. A fully-answered question is not researched again.
- **One finding = one separate memory episode.** Never batch multiple findings into a single
  episode. (Dry policy: independent solutions / tool research are recorded independently.)
- **`project_path` is REQUIRED on every write** and passed explicitly (e.g.
  `/Users/nix/dev/ai/sox-ecosystem`). Never inferred.
- **Topic** derived from the domain set (e.g. `root-complexity`, `frontier-root-complexity`).
- **Tags:** `pattern:open-problem` + `root-complexity` + `research-space` + `residual-gap` +
  `domain/<name>` — INSTEAD of `agent:approved` / `agent:blocked` (those are P1-mode only). This is
  the memory-tag half of the mode switch.
- **Every numeric claim** carries `data_quality: verified|estimated|unknown` plus the exact source
  per metric. Never estimate a number that a tool did not return.
- **Write ASCII-only**, and chunk content that exceeds ~2000 chars at section boundaries, chaining
  chunks with `derived_from_uid`.
- **Read back** the written uids; a BLOCKED/absent uid is a failed write, never reported as filed.
- **Mint a term** (`facet-admit`) for a concept with no existing facet term rather than forcing a
  catch-all; never redefine an existing term in place.
- **No fallback store.** Reach the store only through the `memory` capability; if it is absent or a
  ping fails, the run is BLOCKED — findings go in the report marked unfiled, never to a file.

## Verification rules (hard gate)

- Each root complexity carries a resolvable citation.
- Each research-space entry names a real, resolvable source.
- Each residual gap is a concrete "SOTA does not solve X" statement, sourced.
- A claim resting on a single vendor source is at most MEDIUM; HIGH requires triangulation across
  independent sources. Primary sources over aggregators.
- An all-HIGH run is a failure signal (triage was skipped).
- A LOW item is flagged unresolved; it is never presented as settled.

## Warnings (encode as warnings, not steps)

- **Provider reality.** `google` can return a HITL captcha — park it, do not retry. The `arxiv`
  *provider* has timed out repeatedly (4 consecutive sessions); the reliable path is a direct
  `fetch` of the arxiv abstract page. `github` `type:code` search has returned empty for this topic
  class. Disclose every substitution in the report.
- **Cost/verbosity.** The compressed per-item table is mandatory; long prose is optional. The
  values of this mode are the table, the synthesis axis, and the recommendation — not essay length.

## Fail conditions

- A residual gap with no source.
- A synthesis with no stated axis.
- An all-HIGH run (phases/triage skipped).
- Presenting a LOW-confidence item as settled.
- Applying this mode to a decision-or-eval question.

## Agent merge (process borrowed)

Derived from the `researcher` agent's executed root-distillation arc and the `research` skill's
process discipline (memory-first, one-finding-one-episode, cite-what-you-read, no-fallback-store).
