# AGENTS.md — data/verify/claim-verification

> `CLAUDE.md` is a symlink to this file. Edits here, both hosts see the same guidance.

Claim verification (`@adhd/sox-claim-verification`), a `data`-layer library. Intended for
provenance / contradiction checking — verifying a new claim (memory) against existing ones and
flagging or superseding contradictions.

## ⚠️ STATUS: orphaned — wire-in-or-remove pending

This package is fully built (~1.1k LOC, not a stub) but has **zero live consumers**. Before extending
it, read **[`BACKLOG.md`](./BACKLOG.md)** — the open decision (BL-166) is whether to wire it into the
memory write/enrich path (contradiction detection — the most valuable of the orphaned packages) or
remove it. Resolve the decision before adding features.

## Boundaries

- `area:data` may import `area:data` + `area:shared` only — NEVER `area:platform` (nx module-boundary lint).
- Build/test/lint via nx targets only: `npx nx {build,test,lint} claim-verification`.

## Backlog

Package findings live in **[`BACKLOG.md`](./BACKLOG.md)**; they cross-reference the root
[`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs. Current: **BL-166 (HIGH)** — built but never consumed.
