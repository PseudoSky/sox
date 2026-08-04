# ADR 0009 — Backlog source of truth: `BACKLOG.md` is authoritative for sox-ecosystem, despite the tool reporting phase-3

- **Status:** ACCEPTED (2026-08-04). Supersedes nothing; it *scopes* a global setting that
  was silently wrong for this repo.
- **Owner:** pseudosky.
- **Drives:** `DEBT-BACKLOG-TOOL-MARKDOWN-SPLIT-BRAIN-001` (graph, CRITICAL, OPEN).

## TL;DR for the next agent

**`BACKLOG.md` is the source of truth for `BL-*` items in this repo, today.**
File, claim, transition and resolve `BL-*` items by editing `BACKLOG.md` and running the
guards. Do **not** believe `backlog_migration_status` when it says the graph is
authoritative here — see below for exactly why it is wrong, and why that is not a bug you
should "fix" by regenerating `BACKLOG.md`.

The `BUG-*` / `DEBT-*` / `FEAT-*` / `INVESTIGATION-*` families in this repo **are**
graph-native and should be managed through the backlog CLI/MCP as normal. The split is by
family, not by repo.

## Context

`mcp__backlog__backlog_migration_status` returns, store-globally:

> `phase-3: the graph is authoritative. File/claim/transition/resolve via the backlog
> CLI/MCP — every BACKLOG.md is a generated projection, never hand-edited.`
> `toolIsAuthoritative: true`

That statement is **false for this repo's `BL-*` family**, and the phase marker is a
property of the whole store (`backlog_migration_status` takes no repo argument), so it
cannot be corrected by downgrading it without asserting a falsehood about every *other*
repo sharing `~/.adhd/backlog/production`.

Measured 2026-08-04:

| | `BL-*` items |
|---|---|
| `BACKLOG.md` | **82** (`BL-99` … `BL-426`), 78 open |
| graph (`backlog_list_items {repo:"sox-ecosystem", family:"BL"}`) | **1** (`BL-001`, nodeId 564, RESOLVED) |

The graph holds 31 items total for this repo; 30 of them are `BUG-*`/`DEBT-*`/`FEAT-*`/
`INVESTIGATION-*` and are genuinely graph-native. Only the `BL-*` series is split-brained.

Meanwhile every piece of tooling in this repo reads the markdown, not the graph:
`tools/plan-status.mjs` (which generates the derived status blocks in `PLAN.md` and
`docs/reporting/memory/STATE.md`), `tools/check-backlog-markers.mjs`,
`tools/allocate-bl-id.mjs`, `tools/check-bl-id-integrity.mjs`.

So the declared source of truth and the enforced source of truth were different systems.

## Decision

1. **`BACKLOG.md` remains the working ledger for `BL-*`.** The repo's guards enforce it and
   the derived `PLAN.md` / `STATE.md` blocks depend on it.
2. **Do not regenerate `BACKLOG.md` from the graph.** This is not a preference; it is
   mechanically impossible without turning the repo's own gates red. Evidence below.
3. **Mirror the markdown into the graph, read-only**, via
   `backlog_import_from_markdown` — so tool-side dedupe can finally *see* the `BL-*`
   items — while continuing to write through the markdown. The mirror is refreshed by
   re-running the import; it is never rendered back.
4. **Leave the store-global migration phase alone.** Downgrading it to phase-2 to make it
   honest here would make it dishonest everywhere else. This ADR is the correction instead.

## Why regeneration is not viable (measured, not argued)

`renderItemsToMarkdown` (`entrypoint/backlog/src/markdown.ts:261-274`) emits:

```
### BL-99 — some title

**Status:** OPEN
**Priority:** HIGH
```

The status lands on a **separate line**. But `tools/check-backlog-markers.mjs` rule 1
requires **exactly one `**...**` bold span on the `###` heading line itself**, and rule 2
requires it to begin with a status word; rule 4 requires a `**Total open: N.**` header line
that the renderer never emits at all.

Applying the guard's exact regexes to actual rendered output:

```
FAIL  BL-001 (line 1): heading has NO status marker. It is invisible to the header.
FAIL  header is missing its `**Total open: N.**` line — it cannot be checked.
```

Across all 82 items that is **83 violations** (82 × rule 1, plus rule 4), and
`plan-status.mjs --check` goes red with it, since the derived blocks are computed from those
same markers. Baseline before any change is green:
`check-backlog-markers: OK — 82 items, 78 open, grammar intact.`

Round-trip is therefore **lossy in the render direction** — the markdown carries status *in
the heading grammar*, the graph carries it as a field, and the renderer does not know how to
put it back. Import fidelity is the opposite: title and body are preserved verbatim, so
markdown → graph loses nothing that matters.

## Id collision: none

The prior concern was that the graph's existing `BL-001` would collide with a markdown
`BL-001`. It does not:

- `importFromMarkdown` passes `idOverride: item.humanId` (`client.ts:295-306`), so markdown
  ids are preserved **exactly** — there is no renumbering, and no cross-reference in the
  repo can be invalidated by the import.
- The markdown id space is `BL-99` … `BL-426`, 82 unique ids, zero duplicates. There is no
  `BL-1`, `BL-01`, or `BL-001` anywhere in it (`grep -nE '^### BL-(0*1|001)\b' BACKLOG.md`
  → no match).

The two `BL-001`s cannot meet. Had they met, the collision would have been silent and
destructive: an existing node with `importedFrom === undefined` is treated as
"unowned, let this import claim it" (`client.ts:363`), and its title and body would have
been overwritten in place.

Related: because the graph's `BL-001` is *not* part of this repo's `BL-*` series, any future
`renderToMarkdown({repo, family:'BL'})` would inject it into `BACKLOG.md` as an 83rd item.
Another reason regeneration is the wrong direction.

## Import safety properties (verified in source)

- **Idempotent.** A second run is a no-op per item; an already-live `humanId` takes the
  upsert-diff branch and only writes fields that actually changed (`client.ts:331-424`).
- **Convergent.** If `BACKLOG.md` moves ahead, re-importing re-syncs title/body/priority/
  status rather than being a permanent insert-only no-op.
- **Non-destructive to the working tree.** The import reads `BACKLOG.md` and writes only to
  `~/.adhd/backlog/production`. No file in the repo is modified.
- **Parses cleanly.** `dryRun` reports `parsed: 82, errors: [], malformedHeaders: []`. The
  previously-suspected silent drop of `BL-114` / `BL-319` / `BL-322` (recorded in
  `DEBT-BACKLOG-TOOL-MARKDOWN-SPLIT-BRAIN-001` when the file had 45 items) **no longer
  reproduces** — 82 headings in, 82 parsed out.
- **Rollback.** Store backup at `~/.adhd/backlog/backup-preimport-20260804/` with
  `CHECKSUMS.txt`, taken 2026-08-04 17:58.

## What would have to change to make the graph authoritative here

1. `renderItemsToMarkdown` must emit the heading-line marker grammar
   (`### BL-<n> — <title> — **<STATUS> (<date>, <context>)**`) and the
   `**Total open: N.**` header, so `check-backlog-markers.mjs` and `plan-status.mjs --check`
   stay green on generated output.
2. `tools/allocate-bl-id.mjs` and `tools/check-bl-id-integrity.mjs` must allocate and
   validate against the graph rather than the file.
3. Only then does regenerating `BACKLOG.md` become safe, and only then does phase-3 stop
   asserting a false guarantee for this repo.

Until all three land, this ADR is the answer.
