# Memory Organizer — LLM Guidance

## Purpose

Use this when memoryd needs to promote raw memory episodes into structured graph knowledge — runs batched relation extraction, importance scoring (1–10), contradiction detection, and reflection synthesis. This is the sole LLM caller in the sox-memory subsystem.

## When to delegate to this agent

`memory-organizer` is invoked automatically by `memoryd` on the write path when episodes are dequeued from `organizer_queue`. You do not call it directly from user-facing flows or the read path.

Delegate to this agent only if you are:
- Implementing a custom `memoryd` loop that needs to call the organizer function programmatically.
- Running the organizer in a batch job against a set of pre-inserted episodes.

Do NOT invoke this agent on the hot read path (alongside `memory_recall`) or from hooks. It makes LLM calls and must not block user-facing latency.

## What this agent does

1. Receives a batch of `OrganizerItem` objects (uid, content, kind, agent_id, session_id).
2. **Relation extraction + importance scoring** (LLM call 1): extracts named entities, identifies semantic relations (MENTIONS, SUPPORTS, RELATES_TO, DERIVED_FROM, PART_OF, SAME_AS), assigns importance 1–10 per item.
3. **Entity disambiguation** (within call 1 via cosine bands): auto-merges entities at >0.95 cosine similarity; hands the 0.7–0.95 band to the LLM.
4. **Contradiction detection**: flags items that contradict existing claims via `contradicts_uid`.
5. **Reflection synthesis** (within call 1 response): when a batch's Σimportance ≥ 150, synthesises a one-sentence reflection insight attached to the highest-importance item.

Without a configured provider (`MEMORY_PROVIDER_URL` + `MEMORY_PROVIDER_KEY`), falls back to deterministic extraction: word-count importance, capitalised-word entity extraction, no relations. Provider call count stays zero in this mode.

## Tools required

None — this agent uses `structured_output` (provider JSON schema mode), not tool calling.

## Constraints

- `requires.structured_output: true` and `min_context_tokens: 16384`.
- Every LLM call in sox-memory must originate here (R3 invariant). The read path (`memory_recall`) makes zero provider calls.
- On provider error, falls back to deterministic extraction rather than failing the batch.

## Handoff protocol

Call `organizeItems(items, db)` from `dist/index.js`. The function returns a `Promise<OrganizerResult[]>` — one result per input item.

## Agent id

`memory-organizer`
