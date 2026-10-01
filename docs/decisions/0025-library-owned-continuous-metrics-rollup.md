# ADR-0025 — Library-owned continuous rollup of the metrics snapshot stream

**Status:** Accepted (2026-09-30). The mechanism this ADR governs is **implemented** in
`libs/observability/sox-telemetry` (durable-metrics S8, `6df0d673`), and the owner has ratified this
decision.
**Owner:** pseudosky (authored by the doc-steward agent, durable-metrics S7).
**Relates to:** ADR-0004 (data-root placement — `ecosystemHome()` and the adhd env), ADR-0013
(feature switches are typed config, never env vars), ADR-0014 (pre-operation memory-snapshot
retention — report-first / no-auto-delete; **explicitly not conflated** here), ADR-0018
(`sox-telemetry` process-wide singleton slot), and the durable-metrics program (S1–S8) under the
documents component.

## Context

The durable `metrics.snapshot` series (durable-metrics S1–S4) is a **per-process checkpoint stream**:
one row per snapshot, each carrying a point-in-time reading — process RSS/CPU, the memory-server
store-metrics families, the self-check projection, and the release identity. It is a checkpoint
series, never an aggregate. Answering "what was the p99 write latency over the last hour" from it
means replaying N rows by hand, and it is bounded by how far back retention reaches.

Two forces converge:

1. **A library, not a tool, owns the data.** The snapshot stream is written by the telemetry library
   on its own cadence, inside every process that calls `initTelemetry`. The natural home for its
   aggregate is the same library — an external repo tool would need the same file format, the same
   root resolution, and a second liveness signal, and would drift from the writer.
2. **A prior design carried a human mutation step.** An earlier framing treated rollup as a
   standalone tool a human invoked with `--apply --confirm` to "perform the rollup". That shape is
   redundant once the library writes continuously, and it is a mutation surface where none is
   needed.

The owner directive is explicit: *"I want the snapshots properly continuously rolled up and
aggregated into adhd env by the telemetry library."* This ADR records the decision that follows.

## Decision

### D1 — The telemetry library derives and writes rollups continuously on its own timer

Continuous rollup is owned by `libs/observability/sox-telemetry`, not by an external repo tool and
not by a human step. The S1 interval tick calls `rollupMetrics('interval')` immediately after
`snapshotMetrics('interval')`; `handle.close()` calls it once with `'shutdown'` after a final
snapshot and before the sinks close. There is **no `--apply`**, no `--confirm`, and no separate
scheduler: the aggregation is a pure function (`rollup.ts`'s `aggregateSnapshots`) driven by the
runtime that already owns the writer. `snapshotEveryMs: 0` disables only the **interval** snapshot
tick — the `'startup'` snapshot still fires, because that path is gated on the snapshot sink
existing (`snapshotSink !== null`), not on this value — and `close()` still writes a `'shutdown'`
snapshot and a `'shutdown'` rollup unconditionally, before the sinks close. The rollup sink is
created whenever `logSink` is `'file'`, so a `0` cadence removes the periodic tick, never the
startup/shutdown fold.

### D2 — The rollup is a derived cache over the durable snapshot stream, never the system of record

Every `metrics.rollup` row is recomputable from the retained `metrics.snapshot` records it folded.
Consequently a bounded rollup horizon destroys **no information**: pruning a rollup file removes only
a materialisation of data that still exists (within its own horizon) in the snapshot stream. The
snapshot stream is the durable source of truth; the rollup is an acceleration of it. This is what
makes the cache-size knob below safe to bound.

### D3 — Primary retention and derived-cache retention are distinct regimes and must not be conflated

**Primary retention** — pre-operation `memory.db` snapshots — is governed by **ADR-0014**: report-first,
explicit human `--apply`, never auto-delete. **Derived-cache retention** — the rollup files — is
bounded and horizon-reporting: it is a count-cap (`rollupMaxFiles`, default 30), it is permitted to
delete automatically because nothing is lost, and its retained horizon tells a reader how far the
cache reaches. The two must never be merged into one policy: applying ADR-0014's report-first rule to
a recomputable cache would leave it unbounded for no benefit, and applying cache-style auto-deletion
to primary snapshots would destroy the one artifact that exists for recovery. The snapshot stream
itself sits between the two: it is the recomputation source for the event stream and persists
cumulative counters past the event-retention horizon, so it has its **own** component and its own
larger cap (`snapshotMaxFiles`, default 30 vs the event stream's 7).

### D4 — Rollups are keyed and grouped by release identity

The window's records are grouped by their **release identity** *and* the writer's **process instance**
(`pid`), so each emitted row covers exactly one `(release, process instance)` group. The `release`
object carries `{ version, artifact_sha256, git_sha }`, each `string | null`, and an unavailable field
is **`null`, never `""`** (the BL-433 contract). This makes cross-release comparison first-class — a
reader compares the newest row of release A against the newest row of release B — and it prevents two
silent corruptions: a release boundary mid-window is two rows rather than one blended number, and a
**restart of the same build** (same release, new pid) is two rows rather than one, because a counter
that reset at the restart is not a delta across the boundary.

### D5 — Cadence and horizon are typed `InitTelemetryOptions` fields, not environment variables

`snapshotEveryMs` (default `60_000`), `rollupWindowMs` (default `3_600_000`), `rollupDir`,
`rollupMaxFiles`, and `release` are all typed fields on `InitTelemetryOptions` (ADR-0013). No new
environment variable is introduced. `SOX_TRACE_SNAPSHOT_MS` remains only as a **debug override** of
the S1 cadence, and it can change the interval, never disable the trigger. The data root is resolved
by exactly one function, `ecosystemHome()` — `$SOX_ECOSYSTEM_HOME` when set and non-empty, otherwise
`~/.adhd/sox-ecosystem` — and the rollup nests under the resolved log directory
(`<logDir>/rollup`), so it inherits the same root and the same test-isolation seam as the snapshots.

### D6 — The read path is a read-only report/compare CLI

The only consumer-facing command is `tools/metrics-report.mjs`, with exactly two subcommands —
`--report` and `--compare <A> <B>` — plus `--root`, `--json`, and `--help`. It performs **zero
writes**: no `index.json`, no rewrite, no rollup, no raw snapshot. The prohibition is by construction
(the module contains no write primitive) and is asserted by test (the data tree is byte-identical
before and after). A human mutation verb is deliberately absent (D1).

## Consequences

- **Cross-release comparison is a first-class read.** `--compare` matches a release by `version`
  string or by full `artifact_sha256` (with or without the `sha256:` prefix) and prints per-series
  absolute and percentage deltas; a selector naming a release with no row exits non-zero rather than
  silently comparing nothing.
- **The rollup is additive and bounded.** It writes one row per group per tick, its retention is a
  cache cap, and its absence (before a first tick, or under a non-file sink) degrades to "no rows"
  rather than an error.
- **The aggregation is testable without a filesystem.** `rollup.ts` has no `fs`, no timers, and no
  `process`; `now` is injected, so `aggregateSnapshots` is unit-tested directly. The filesystem-shaped
  work (enumerate, async-read, mtime-cache, write) lives in `runtime.ts`.
- **The zero-handle property survives.** The rollup rides the S1 timer, which is `.unref()`'d, so it
  adds no live handle and no second timer (`getActiveResourcesInfo()` stays empty).
- **`store_metrics.*` series are honest before S4.** In a process that never registers the
  `store_metrics` section, those series report `samples: 0` with `null` statistics — never a
  fabricated zero.
- **A bounded cache horizon is a real limit.** Past `rollupMaxFiles` rotations, older aggregate rows
  are gone; they are recomputable only while the underlying snapshots remain. A reader wanting a
  longer aggregate history must read the newest row of each retained period, not a single lifetime
  number. This is an accepted consequence of D2/D3, not a defect.

## Alternatives considered

1. **A standalone repo tool with `--apply --confirm` (the earlier framing).** Rejected — D1: the
   library already has the data and the cadence; a human apply step is redundant and a mutation
   surface. This ADR explicitly supersedes that framing.
2. **An external scheduler (cron/launchd).** Rejected — it adds a process whose liveness can diverge
   from the writer's, and the S1 interval tick already exists in-process.
3. **Fold on read inside the CLI.** Rejected — it leaves no durable aggregate, forces each invocation
   to re-read and re-fold the whole snapshot series, and reimplements aggregation outside the library
   that owns the schema.
4. **Piggyback the periodic enrich tick (§5.8 option B).** Rejected — it couples this ledger's
   liveness to an unrelated subsystem's tick, so a change there would silently stop persistence.
5. **Group by release alone.** Rejected — a restart would blend two process lifetimes into one row,
   corrupting `cumulative_delta`, `counter_max`, `sum`, and `gauge_max` (S8 FIX 2).
6. **Unbounded rollup retention.** Rejected — D2/D3: the rollup is a recomputable cache; unbounded
   growth buys nothing that re-folding the retained snapshots does not.

## Open questions (not decided here)

1. **Live re-computation policy.** Whether a reader should be able to force a fresh fold from
   snapshots without waiting for the next tick is not decided; today the CLI is pure-read and the
   library's cadence is the only fold trigger.
2. **Cross-service aggregation.** Rows are per `(service, role, release)`; whether a cross-service
   view belongs in the CLI or a separate consumer is out of scope here.
3. **`snapshots_written` semantics across a restart.** `counter_max` reports the highest
   `snapshot_seq` in a group; whether a group's sequence should continue across a restart is left to
   the substrate, not this ADR.

## Acceptance tests (shipped)

- `libs/observability/sox-telemetry/src/metrics-rollup.spec.ts` — library-owned fold, one row per
  `(release, process instance)`, pure `aggregateSnapshots`, null-never-`""` release, closed series
  list with `agg` tags.
- `libs/observability/sox-telemetry/src/metrics-snapshot-cadence.spec.ts` — the S1 default-on
  cadence, the typed field vs. the `SOX_TRACE_SNAPSHOT_MS` override, and the zero-handle assertion.
- `tools/metrics-report.test.mjs` — the read path performs zero writes (the tree is byte-identical
  before and after; no `index.json`), `--compare` deltas, the selector forms, and non-zero exit on a
  missing release.
