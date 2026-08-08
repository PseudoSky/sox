/**
 * stages.ts — memory-core's contended-stage inventory (BL-401 consumer migration).
 *
 * This file is the reason `telemetry_self_check.stages_declared` is non-zero.
 * Before it existed, `@adhd/sox-telemetry` shipped `declareStages` /
 * `withContendedStage` with **no production caller anywhere in the repo**: the
 * interface was published, tested, and wired to nothing, so the live service
 * reported `stages_declared: 0` and the wait-vs-work split that BL-351 was
 * filed to obtain still had to be reconstructed by hand from raw events.
 *
 * ## Why these two stages and not more
 *
 * Every stage declared here is wired at a real call site in this same change.
 * Declaring an aspirational stage would reproduce **BL-319 exactly** — an
 * instrument that exists with zero samples is indistinguishable from an
 * instrument that is broken — only now with the self-check reporting it as a
 * permanent `stages_with_zero_samples` entry that nobody can act on. When a
 * third contended resource is instrumented, it gets added here at that time.
 *
 * ## Paths are declared in SIBLING PAIRS, deliberately
 *
 * `paths` is the mechanism that makes an unwired sibling visible
 * (`telemetrySelfCheck().paths_with_zero_samples`). Both entries below name
 * every path the stage can actually be entered through, including the ones
 * that are rare in production:
 *
 * - **`write_queue`** — `queued` vs `bypass`. These are not variants of one
 *   path; they are two different execution models selected by adapter
 *   capability. The **live service runs `bypass`**: the Turso adapter sets
 *   `_noop` (it handles concurrent I/O natively), so `enqueue` executes
 *   immediately instead of taking a FIFO slot. An instrument wired only to the
 *   FIFO path would therefore have read zero on the production server forever
 *   while passing every test — the BL-319 defect, reproduced on the exact code
 *   path it was found in. `bypass` structurally has no admission wait, and its
 *   `wait_ms ≈ 0` is a *positive claim* (it was measured and there was no
 *   queue), not a missing measurement.
 *
 * - **`embed`** — `write` (Phase-B pipeline), `heal` (the periodic
 *   `healMissingVectors` repair pass), and `reembed` (a model migration). BL-319
 *   is *literally* the observation that the heal path bypassed write-path
 *   instrumentation, so `time_to_vector_ms` existed with zero samples. All
 *   three are named here up front.
 *
 * ## What `wait` means for `embed`
 *
 * `admit` is `getOrCreateProvider()` — acquiring the shared fastembed child
 * process — and `work` is `provider.embedSingle()`. That split is the direct
 * measurement of BL-331's open question: cold model load and head-of-line
 * blocking behind the single shared child land in `wait_ms`, while inference
 * lands in `work_ms`. Previously both were fused into one `embed.finish
 * duration_ms`, and separating them required correlating adjacent log lines by
 * hand (`docs/observability/README.md` §5.3).
 *
 * ⚠️ Both durations are wall-clock and accrue during system sleep (BL-369).
 * Medians are fine; do not quote a p99 from them without subtracting
 * `suspended_ms`.
 *
 * ## The third stage: `cluster`
 *
 * Added because clustering was the last major memory-core subsystem with NO
 * instrumentation of any kind — no stage, no counter, no event. Grepping every
 * log file for `cluster_count` / `community` / `communities_invalidated`
 * returned zero matches, which meant a mass community invalidation would have
 * left no trace, and time-to-community had to be hand-measured off
 * `memory_recall`. See `cluster-metrics.ts`'s header for the full motivation
 * and for the domain counters that accompany this stage.
 *
 * - **`cluster`** — `full` (the O(n²) connected-components pass that owns τ
 *   recalibration and community creation), `incremental` (the O(1)-per-episode
 *   local-neighborhood join that runs on the periodic tick and can ONLY join
 *   existing communities, never create one), and `subset` (`clusterSubset`'s
 *   provenance-scoped synthesis slice). All three are wired at real call sites
 *   in this same change, per this file's rule.
 *
 * `wait` for this stage is candidate/vector selection — the queries that
 * assemble what the pass will consider — and `work` is the comparison and
 * persistence. That split matters because the two degrade for different
 * reasons: `wait` grows with corpus size, `work` grows with candidate count.
 *
 * ⚠️ The same BL-369 wall-clock caveat applies to `cluster` durations, and it
 * bites harder here: clustering runs on a periodic tick, so a pass that spans a
 * laptop sleep records the sleep. This is also why `cluster-metrics.ts`'s
 * `time_to_community_ms` is documented as wall-clock rather than presented
 * alongside `time_to_vector_ms` as though the two were the same kind of number.
 */

import { declareStages } from '@adhd/sox-telemetry';

export const MEMORY_CORE_STAGES = declareStages('memory-core', {
  write_queue: { paths: ['queued', 'bypass'] },
  embed: { paths: ['write', 'heal', 'reembed'] },
  cluster: { paths: ['full', 'incremental', 'subset'] },
} as const);

/** The code path an `embed()` call was entered through. Closed union: a new
 *  caller cannot invent a fourth path without adding it to the catalog above,
 *  which is what stops a sibling path from being silently uninstrumented. */
export type EmbedStagePath = (typeof MEMORY_CORE_STAGES.stages.embed.paths)[number];
