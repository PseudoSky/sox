---
name: "Probe a missing capability AND check the tracker before explaining — the absence may be a filed defect"
topic: tool-catalog
tags: [agent-methodology, verification, epistemics, audience:researcher]
summary: "A capability's absence must be probed and its cause confirmed against primary evidence. But do not over-attribute an absence to your own negligence: when memory-server's tool surface silently dropped mid-session, a filed CRITICAL defect (a1410770) explained it — the observation was right, only the causal explanation (permission scoping) was wrong."
importance: 7
project_path: /Users/nix/dev/ai/sox-ecosystem
source: reflection
agent_id: researcher
supersedes_uid: "01M3Q02NA0PV5RQ156K1Y2GF94"
related_backlog: "a1410770"
fallback_reason: "memory MCP tool surface withdrawn mid-session (a1410770 reproduced live 2026-09-29); memory_write/memory_update unavailable — ingest this file via memory_write, then memory_invalidate 01M3Q02NA0PV5RQ156K1Y2GF94 with replacement_uid"
---

# Corrected finding — memory-server tool drop was a filed defect, not (only) operator error

**Supersedes** memory episode `01M3Q02NA0PV5RQ156K1Y2GF94` ("Never infer a capability is unavailable — probe it; a partial config read is not evidence for a cause"), which over-attributed the incident to the agent's own negligence.

## What happened (corrected)

- I declared an MCP capability "not exposed on this host" from skimmed tool-list knowledge.
- Challenged, I blamed **per-agent permission scoping** from ONE config layer. That explanation was **false**: the global config contained no `memory_*` deny; the explicit per-agent allow was redundant with the default.
- **Correction:** the *observation* was **right**. A filed CRITICAL defect — `a1410770` (opencode's per-session MCP client to `memory-server` silently drops mid-session, "proxy closed" / `-32001`, and never reconnects; tool surface withdrawn for the session though the server is UP) — explains it. The tool surface **genuinely disappeared**; the server was fine.
- **Live re-confirmation:** the same defect reproduced again in this session — `memory_ping`/`memory_recall`/`memory_write`/`memory_invalidate` worked for ~20 minutes, then every `memory_*` call became "unavailable tool" while the server stayed up. That is `a1410770`.

## Rules (revised)

1. To assert a capability is unavailable, **PROBE it** and report the error. Absence from a skimmed tool list is *weak, not zero* evidence — a real defect can cause it.
2. Before explaining **WHY** a capability is missing, **check the tracker for a known defect**. This one was already filed, CRITICAL.
3. Config is **layered** (global + project + per-agent); reading one layer and concluding is an unverified inference.
4. Keep **observation** separate from **inference**; make causal claims falsifiable.
5. **Do not over-attribute** an absence to your own negligence when a filed defect explains it — and do not under-attribute either. Calibrate to the evidence.

data_quality: verified (against the global+project config AND filed defect `a1410770`; reproduced live in-session).

## Ingest instruction

1. `memory_write` the frontmatter+body above (topic `tool-catalog`).
2. `memory_invalidate({ claim_uid: "01M3Q02NA0PV5RQ156K1Y2GF94", replacement_uid: <new uid>, reason: "over-attributed a filed CRITICAL defect (a1410770) to operator negligence; observation was correct, cause was a real client-side tool-surface drop" })`.
