# Memory Organizer

> Use this when memoryd needs to promote raw memory episodes into structured graph knowledge — this is the sole LLM caller in the sox-memory subsystem.

## Overview

`memory-organizer` is the only component in sox-memory that makes provider/LLM calls. It is invoked by `memoryd` on the write path after episodes are enqueued, never on the read path.

For each ingest batch it runs up to 4 LLM calls via structured output:

1. **Relation extraction + importance scoring** — extracts named entities, semantic relations (MENTIONS, SUPPORTS, RELATES_TO, DERIVED_FROM, PART_OF, SAME_AS), and assigns an importance score (1–10) to each episode.
2. **Entity disambiguation** — merges entities with cosine similarity > 0.95 automatically; hands off the 0.7–0.95 band to the LLM for disambiguation.
3. **Contradiction detection** — identifies episodes that contradict existing claims (sets `contradicts_uid`).
4. **Reflection synthesis** — when a batch's total importance reaches ≥ 150, synthesises a higher-level reflection insight and attaches it to the top-importance item.

When no provider is configured (CI, offline), the organizer falls back to a fully deterministic stub: word-count heuristic importance, capitalised-word entity extraction, no relations.

## When to use

This agent is invoked internally by `memoryd` — you do not call it directly. Install it as part of the `sox-memory-bundle` or alongside `memory-server`. It is only needed if you want the LLM-powered graph enrichment path; the read path works without it.

Do NOT invoke this agent on the read path, from a hook, or from user-facing flows. It is an async background worker.

## Capabilities

- Structured output: yes (`requires.structured_output: true`)
- Minimum context tokens: 16384
- Tool calling: no

## Provider configuration

Set via environment variables at lifecycle start (injected by the host):

| Variable                 | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `MEMORY_PROVIDER_URL`    | Base URL of the OpenAI-compatible provider               |
| `MEMORY_PROVIDER_KEY`    | API key (use `${ENV}` ref in extensions config)          |
| `MEMORY_PROVIDER_MODEL`  | Model name (default: `gpt-4o-mini`)                      |

## Inputs (OrganizerItem)

| Field        | Type              | Description                                 |
| ------------ | ----------------- | ------------------------------------------- |
| `uid`        | string            | Unique episode identifier                   |
| `content`    | string            | Raw episode text                            |
| `kind`       | string            | Node kind (e.g. `"episode"`)                |
| `agent_id`   | string \| null    | Agent that produced the episode             |
| `session_id` | string \| null    | Session the episode belongs to              |

## Outputs (OrganizerResult per item)

| Field            | Type                        | Description                                         |
| ---------------- | --------------------------- | --------------------------------------------------- |
| `uid`            | string                      | Episode uid (echoed)                                |
| `importance`     | number (1–10)               | LLM-assigned importance score                       |
| `entities`       | Array\<{name, type, summary}\> | Extracted entity nodes                           |
| `relations`      | Array\<{rel, dst_name, weight}\> | Semantic relation edges                       |
| `contradicts_uid`| string (optional)           | UID of a contradicted existing claim                |
| `reflection`     | string (optional)           | Synthesised reflection (only on Σimportance ≥ 150) |

## Usage

```bash
sox install memory-organizer
# or install the full subsystem:
sox install sox-memory-bundle
```

## License

MIT
