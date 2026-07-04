# AGENTS.md — data/store/blob-store

> `CLAUDE.md` is a symlink to this file. Edits here, both hosts see the same guidance.

Content-addressed blob storage (`@adhd/sox-blob-store`), a `data`-layer library. Intended for keeping
large content (documents / attachments / media) out of SQLite `node.content` rows, with graph/vector
rows referencing blob hashes.

## ⚠️ STATUS: orphaned — wire-in-or-remove pending

This package is fully built (~1.8k LOC, not a stub) but has **zero live consumers**. Before extending
it, read **[`BACKLOG.md`](./BACKLOG.md)** — the open decision (BL-166) is whether to wire it into the
memory write path (large-content offload) or remove it. Do not add features to a package that may be
deleted; resolve the decision first.

## Boundaries

- `area:data` may import `area:data` + `area:shared` only — NEVER `area:platform` (nx module-boundary lint).
- Build/test/lint via nx targets only: `npx nx {build,test,lint} blob-store`.

## Backlog

Package findings live in **[`BACKLOG.md`](./BACKLOG.md)**; they cross-reference the root
[`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs. Current: **BL-166 (HIGH)** — built but never consumed.
