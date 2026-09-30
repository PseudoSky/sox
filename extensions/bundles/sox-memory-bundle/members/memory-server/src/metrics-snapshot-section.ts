/**
 * metrics-snapshot-section.ts — durable-metrics **S4**
 * (backlog `4436adec-ea37-4ff2-a379-1ab30f48d73d`, component memory-server).
 *
 * THE GAP THIS CLOSES
 * ───────────────────
 * Several of memory-server's most operationally load-bearing metric families
 * existed ONLY on the live `memory_ping` response — a pure in-memory view that
 * a crash takes with it. S4 promotes them into a durable
 * `sections.store_metrics` block on every persisted `metrics.snapshot` line, so
 * the families survive a restart and an N-release comparison is possible:
 *
 *   write_latency_ms      — rolling write-kind task latency (WriteQueue)
 *   apply_latency_ms      — rolling apply-kind (Phase-B) task latency
 *   slow_tasks            — WriteQueue's cumulative slow-task counter
 *   recall_degradations   — cumulative degraded-recall counters (index.ts)
 *   embed_backlog         — live episodes still awaiting a vec_node (Phase-B)
 *   embeds_completed      — Phase-B successful embeds
 *   embeds_failed         — Phase-B failed embeds
 *   time_to_vector        — Phase-A commit → vec applied (eventual consistency)
 *   embed_duration        — the embed() call duration
 *   growth                — the store-growth gauge (BL-c5249cdd)
 *
 * SAME SOURCES, NO PARALLEL COMPUTATION
 * ─────────────────────────────────────
 * Every family is read from the EXACT source `memory_ping` already reads —
 * `WriteQueue.metricsForPath()`, `getEmbedPipelineMetrics()`, the recall
 * degradation counters (owned by index.ts) and the store-growth evaluator
 * (`readStoreGrowthGauge()`). Nothing is recomputed here.
 *
 * THE SYNCHRONOUS-PROVIDER CONSTRAINT
 * ───────────────────────────────────
 * The telemetry runtime calls a snapshot section provider SYNCHRONOUSLY
 * (`runtime.ts` `collectSnapshotSections()`). Eight of the ten families above
 * are synchronous reads of process-local state, so the provider reads them
 * directly. The remaining two — `embed_backlog` and `growth` — have no
 * synchronous source: their only honest source is an ASYNC probe through the
 * open store adapter (`embedBacklogStats()` / `readStoreGrowthGauge()`). Rather
 * than re-run that probe inside a synchronous provider (impossible) or invent a
 * parallel sampler (a new data path), `memory_ping` records its already-paid
 * probe result here via {@link recordStoreMetricsSample}, and the provider
 * projects the cached sample. This is the same value `memory_ping` returns for
 * the same store, by construction.
 *
 * STORE IDENTITY — RESOLVE ONCE (backlog 51995ade, HIGH)
 * ──────────────────────────────────────────────────────
 * The section must report on the store the ping ACTUALLY probed, never a second,
 * independently-derived path. `memory_ping` resolves a store from its call args
 * (an explicit `store`/`db_path`, else the host `SOX_CONFIG_DB_PATH`) through the
 * shared `resolveStoreDbPath`, and records its sample under that ONE resolved
 * path. The provider reads the SAME recorded path ({@link getSampledStorePath}),
 * falling back to `resolveStoreDbPath` only when this process has not pinged yet.
 * Keying the sample map on the recorded path — rather than re-deriving it from
 * `SOX_CONFIG_DB_PATH` at snapshot time — is what keeps an explicit `db_path`
 * (env unset) and a `~`-bearing config from splitting into two keys and silently
 * reading `null` for the two async-sourced families.
 *
 * A provider that throws is the telemetry runtime's problem, not this module's:
 * `collectSnapshotSections()` catches it and records `{ error: <message> }`
 * in-place, never breaking the snapshot write (S4 acceptance (d)).
 */
import { registerSnapshotSection } from '@adhd/sox-telemetry';
import { WriteQueue, getEmbedPipelineMetrics, type StoreGrowthGauge } from '@adhd/sox-memory-core';

/**
 * The rule-required section name (the S4 plan's `registerSnapshotSection`
 * registration key). A snapshot consumer reads the block at
 * `metrics.snapshot.sections.store_metrics`.
 */
export const STORE_METRICS_SECTION_NAME = 'store_metrics';

/**
 * The ping-probed, async-sourced subset of the section, cached per store path.
 * Populated by `memory_ping` (the one path that already opens the store and pays
 * for `embedBacklogStats` + `readStoreGrowthGauge`) and read by the synchronous
 * snapshot provider. See the module header for why a cache is the honest bridge
 * rather than a synchronous re-probe.
 */
export interface StoreMetricsSample {
  /** Live episodes without a vec_node row (Phase-B backlog). */
  embed_backlog: number;
  /** `t_created` of the oldest backlog episode, or null when the backlog is empty. */
  embed_backlog_oldest_at: string | null;
  /** The store-growth gauge, or null when the probe failed (see `growth_error`). */
  growth: StoreGrowthGauge | null;
  /** The store-growth probe's error, or null on success. */
  growth_error: string | null;
  /** When this sample was recorded (ms epoch) — surfaced as `sample_age_ms`. */
  observed_at_ms: number;
}

const samples = new Map<string, StoreMetricsSample>();

/**
 * The store path of the most recently recorded sample — the ping's OWN
 * resolution of the store it just probed (see {@link recordStoreMetricsSample}).
 * The synchronous snapshot provider reuses this instead of re-deriving a path
 * from `SOX_CONFIG_DB_PATH`, which is a DIVERGENT resolution whenever the ping
 * was given an explicit `db_path`/`store` (env may be unset) or the config
 * carries a `~`. Reading the recorded path is the "resolve the store ONCE"
 * contract: the section reports the store `memory_ping` actually probed, never a
 * second, independent guess. Null until the first ping in this process.
 */
let lastSampledStorePath: string | null = null;

/**
 * Record the async-sourced families `memory_ping` just computed for `storePath`.
 * Called from the ping store block; never from a synchronous provider.
 */
export function recordStoreMetricsSample(
  storePath: string,
  sample: {
    embed_backlog: number;
    embed_backlog_oldest_at: string | null;
    growth: StoreGrowthGauge | null;
    growth_error: string | null;
  },
): void {
  if (storePath.trim() === '') return;
  samples.set(storePath, { ...sample, observed_at_ms: Date.now() });
  lastSampledStorePath = storePath;
}

/**
 * The store path the ping most recently recorded a sample for — the section's
 * resolve-once store identity, so writer and reader key on the identical string
 * (backlog 51995ade). Null until the first ping in this process.
 */
export function getSampledStorePath(): string | null {
  return lastSampledStorePath;
}

/** Test-only: forget every recorded sample so suites do not inherit one. */
export function _resetStoreMetricsSamplesForTest(): void {
  samples.clear();
  lastSampledStorePath = null;
}

/** Dependencies the composition root injects — never a module-level import of
 *  index.ts, which would be a cycle (index.ts imports THIS module). */
export interface StoreMetricsSectionOptions {
  /** Resolve the store this section reports on. The composition root supplies
   *  the resolve-ONCE identity — the store the last ping actually sampled
   *  ({@link getSampledStorePath}), falling back to the host-configured store
   *  when this process has not pinged yet — so writer and reader never key on
   *  two divergent paths (backlog 51995ade). */
  resolveStorePath: () => string | null;
  /** The ping's recall-degradation counters (index.ts owns the module-local
   *  counters — see its duplicate-module rationale). Returned as `unknown` so
   *  the caller's named interface (no index signature) passes through verbatim
   *  rather than being widened/erased at the boundary. */
  recallDegradations: () => unknown;
}

/**
 * Build the `store_metrics` section from the same sources `memory_ping` uses.
 * Pure and synchronous — the provider the telemetry runtime calls.
 */
export function buildStoreMetricsSection(options: StoreMetricsSectionOptions): Record<string, unknown> {
  const storePath = options.resolveStorePath();
  const writeQueue = storePath !== null ? WriteQueue.metricsForPath(storePath) : null;
  const embedPipeline = storePath !== null ? getEmbedPipelineMetrics(storePath) : null;
  const sample = storePath !== null ? samples.get(storePath) : undefined;

  const writeLatencyMs = writeQueue?.write_latency_ms ?? null;
  const applyLatencyMs = writeQueue?.apply_latency_ms ?? null;
  const slowTasks = writeQueue?.counters.slow_tasks ?? null;
  const embedBacklog = sample?.embed_backlog ?? null;
  // backlog fdd3a304: the ping exposes `store.embed_backlog_oldest_at`; the
  // section must be 1:1 with the ping, so project it (flat AND under `embed`).
  const embedBacklogOldestAt = sample?.embed_backlog_oldest_at ?? null;
  const embedsCompleted = embedPipeline?.counters.embeds_completed ?? null;
  const embedsFailed = embedPipeline?.counters.embeds_failed ?? null;
  const timeToVector = embedPipeline?.time_to_vector_ms ?? null;
  const embedDuration = embedPipeline?.embed_duration_ms ?? null;
  const growth = sample?.growth ?? null;

  return {
    // ── Flat families (S4 acceptance) — identical field names to the families
    //    on `memory_ping`, so a consumer can compare them 1:1. ──────────────
    write_latency_ms: writeLatencyMs,
    apply_latency_ms: applyLatencyMs,
    slow_tasks: slowTasks,
    recall_degradations: options.recallDegradations(),
    embed_backlog: embedBacklog,
    embed_backlog_oldest_at: embedBacklogOldestAt,
    embeds_completed: embedsCompleted,
    embeds_failed: embedsFailed,
    time_to_vector: timeToVector,
    embed_duration: embedDuration,
    growth,
    // ── Nested groups (plan AC (i)): `sections.store_metrics.write_queue.*`,
    //    `.embed.*`, `.growth.*`. Additive — the flat names above stay the
    //    primary contract. ───────────────────────────────────────────────────
    write_queue: { write_latency_ms: writeLatencyMs, apply_latency_ms: applyLatencyMs, slow_tasks: slowTasks },
    embed: {
      embed_backlog: embedBacklog,
      embed_backlog_oldest_at: embedBacklogOldestAt,
      embeds_completed: embedsCompleted,
      embeds_failed: embedsFailed,
      time_to_vector: timeToVector,
      embed_duration: embedDuration,
    },
    // ── Provenance / honesty ────────────────────────────────────────────────
    store_path: storePath,
    // How stale the async-sourced families are. null = this process has never
    // pinged the store (the sync families are still live and accurate).
    sample_age_ms: sample !== undefined ? Math.max(0, Date.now() - sample.observed_at_ms) : null,
    growth_error: sample?.growth_error ?? null,
  };
}

/**
 * Register the `store_metrics` section with the telemetry runtime. Returns the
 * runtime's unregister handle so the composition root can detach it on shutdown
 * (mirrors `MainThreadMonitor.start()`'s `registerSnapshotSection` usage).
 */
export function registerStoreMetricsSection(options: StoreMetricsSectionOptions): () => void {
  return registerSnapshotSection(STORE_METRICS_SECTION_NAME, () => buildStoreMetricsSection(options));
}
