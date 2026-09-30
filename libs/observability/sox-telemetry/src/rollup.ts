/**
 * rollup.ts — durable-metrics **S8** (`6df0d673-2dd5-488f-9539-9a33c6f3866d`):
 * the PURE continuous-rollup aggregation over the `metrics.snapshot` stream.
 *
 * WHAT THIS IS
 * ────────────
 * The `metrics.snapshot` series (S1–S4) is a per-process checkpoint stream:
 * one row per snapshot, each carrying a point-in-time reading (process RSS/CPU,
 * the store-metrics families, the self-check projection, release identity). It
 * is a *checkpoint* series, never an *aggregate* — reading "what was the p99
 * write latency over the last hour" from it means replaying N rows by hand.
 *
 * This module is the missing fold: given the snapshot records inside a trailing
 * window, it emits ONE row per release identity summarising that window. It is
 * the deliverable that makes the durable stream continuously useful, with no
 * human `--apply` and no external repo tool — the LIBRARY owns continuous
 * rollup (owner directive: "I want the snapshots properly continuously rolled
 * up and aggregated into adhd env by the telemetry library").
 *
 * PURITY (the deliberate, load-bearing constraint)
 * ────────────────────────────────────────────────
 * This file has **no `fs`, no timers, and no globals** — not even `process`
 * (which is why the emit envelope's `pid`/`service`/`role`/`reason` are stamped
 * by `runtime.ts`, not here). Everything it needs arrives through its two
 * arguments, and `now` is INJECTED rather than read from the clock. That is
 * what makes the whole aggregation unit-testable with zero filesystem and no
 * clock mocking (acceptance (c)), and it is why this module can be reasoned
 * about as a pure function `(records, {windowMs, now}) -> rows`.
 *
 * It imports only a sibling TYPE module (`./otel-types.js`, which itself never
 * imports `@opentelemetry/*` — see its header). It MUST NOT import
 * `@opentelemetry/*` (the repo rule at `otel-types.ts:6`) and MUST NOT
 * `node:fs` (the reads live in `runtime.ts`).
 *
 * WINDOWING — re-derived, not a delta bucket
 * ──────────────────────────────────────────
 * `windowMs` is a TRAILING window re-derived on every tick: `from = now −
 * windowMs`, `to = now`. Consecutive rows therefore OVERLAP by design, and each
 * row is fully self-describing via `window.from`/`window.to`. A reader takes
 * the newest row per release and never stitches rows together; overlap is not a
 * double-count because no consumer sums rows. This is the same shape
 * `docs/observability/README.md` documents for the snapshot series, applied to
 * the aggregate.
 *
 * KEYING — one row per (release, process instance)
 * ────────────────────────────────────────────────
 * The window's records are grouped by their S3 `release` identity AND the
 * writer's `pid` (the process-instance discriminator every `metrics.snapshot`
 * row already carries: `runtime.ts`'s `processStats()` line). ONE ROW IS
 * EMITTED PER DISTINCT GROUP, so:
 *
 *   - a release boundary landing mid-window yields two rows rather than one
 *     blended number — the whole point of the S3 field, consumed here — and
 *   - TWO LIFETIMES OF THE SAME BUILD (a restart: same release, a NEW pid)
 *     yield two rows rather than one. This is not cosmetic: blending two
 *     lifetimes silently corrupts every aggregate. `cumulative_delta`
 *     (`max − min`) straddles a counter that RESET at the restart, so it is
 *     not a delta at all; `counter_max` reports only the further-advanced
 *     process; `sum` double-counts (`records_covered`); `gauge_max` reports a
 *     dead process's `uptime_s`. Splitting by process instance keeps each row
 *     internally consistent — the same reason the release boundary splits at
 *     all, extended to the restart axis S1 exists for.
 *
 * `release` is copied verbatim (null-filled, never `''`: the BL-433 contract).
 * The group's `pid` is surfaced on the row as `process_pid`; the emit envelope
 * keeps its own `pid`, the process that WROTE the row (`runtime.ts`).
 *
 * DERIVED CACHE (retention rationale — NOT ADR-0014 primary retention)
 * ────────────────────────────────────────────────────────────────────
 * The rollup files `runtime.ts` writes are a **derived cache**. Every row is
 * recomputable from the retained `metrics.snapshot` records it was folded from,
 * so pruning a rollup file destroys NO information — it is unlike a snapshot,
 * which is itself the recomputation source for the event stream, and unlike a
 * primary store snapshot subject to ADR-0014's report-first / no-auto-delete
 * rule. `rollupMaxFiles` (default 30) is therefore a cache-size knob, not a
 * retention policy for primary data.
 */

import type { OtelMetricPoint, OtelState } from './otel-types.js';

/**
 * The closed set of aggregation functions a declared series may name. Kept a
 * closed union (not a string) so a declaration that misspells an aggregator is
 * a compile error, and so every emitted `series` entry carries an explicit,
 * checkable `agg` tag — a bare number with no aggregation provenance is the
 * unfalsifiable-number failure (BL-334) this design is written against.
 *
 * - `gauge`               point-in-time reading; headline `value` is the MEAN.
 * - `gauge_max`           point-in-time reading; headline `value` is the MAX.
 * - `cumulative_delta`    a monotonically increasing counter; `value` is
 *                         `max − min` over the window (the work done in it).
 *                         With FEWER THAN TWO samples the delta is unmeasurable,
 *                         so `value` is `null` — never a fabricated `0` that
 *                         reports "no work" for a process that plainly worked
 *                         (a freshly-started process, a release/restart
 *                         boundary's first row).
 * - `sum`                 an additive per-snapshot quantity; `value` is the sum.
 * - `counter_max`         a monotonic counter; `value` is its latest/highest.
 * - `max_of_percentiles`  an unsummable percentile; `value` is the MAX across
 *                         samples and `sum` is deliberately `null`, so a p99 is
 *                         never falsely summed into a meaningless total.
 */
export type RollupAgg =
  | 'gauge'
  | 'gauge_max'
  | 'cumulative_delta'
  | 'sum'
  | 'counter_max'
  | 'max_of_percentiles';

/**
 * The S3 release identity as a rollup input/row field. Structurally identical to
 * `runtime.ts`'s `ReleaseIdentity`; declared here so this module stays
 * dependency-free of `runtime.ts` (which imports THIS module — importing back
 * would be a cycle). Every field is `string | null`, never `''` (BL-433).
 */
export interface RollupRelease {
  version: string | null;
  artifact_sha256: string | null;
  git_sha: string | null;
}

/** The `process` block a `metrics.snapshot` row carries (`runtime.ts`'s
 *  `processStats()`), narrowed to what a series extracts. */
export interface SnapshotProcess {
  rss_bytes?: number;
  heap_used_bytes?: number;
  external_bytes?: number;
  cpu_user_ms?: number;
  cpu_system_ms?: number;
  uptime_s?: number;
}

/** The self-check projection a `metrics.snapshot` row carries. A rollup row
 *  folds these across its window (union of the zero-sample lists, max of the
 *  declared count) and projects the latest OTel state. */
export interface SnapshotSelfCheck {
  stages_declared?: number;
  stages_with_zero_samples?: readonly string[];
  paths_with_zero_samples?: readonly string[];
  otel?: { state?: OtelState; spans_enabled?: boolean };
}

/**
 * One persisted `metrics.snapshot` record, as decoded from a JSONL line. Only
 * the fields a declared series reads are typed; the rest pass through under the
 * index signature. Every field is optional because the reader tolerates
 * partially-shaped or foreign rows (it never throws on one).
 */
export interface MetricsSnapshotRecord {
  ts?: string;
  event?: string;
  service?: string;
  role?: string;
  reason?: string;
  release?: RollupRelease | null;
  records_covered?: number;
  snapshot_seq?: number;
  self_check?: SnapshotSelfCheck | null;
  otel_metrics?: readonly OtelMetricPoint[] | null;
  process?: SnapshotProcess | null;
  sections?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * One emitted `series` entry — the aggregate of a single declared series across
 * a window's samples. `agg` is the aggregation that produced `value`; every
 * statistic is present (or `null` when the window held no finite sample) so a
 * consumer never has to guess which fields an aggregator populates. `samples`
 * counts the finite samples that contributed. `sum` is `null` for
 * `max_of_percentiles` (an unsummable percentile is never summed).
 */
export interface RollupSeries {
  agg: RollupAgg;
  samples: number;
  min: number | null;
  mean: number | null;
  p50: number | null;
  p99: number | null;
  max: number | null;
  sum: number | null;
  value: number | null;
}

/**
 * A declaration in the CLOSED series list. `extract` is a pure projection from
 * one snapshot record to a single finite number (or `null` when the record does
 * not carry that series). Keeping the list closed (a `const` array, not a
 * caller-supplied map) is what makes every rollup row's `series` object have a
 * stable, identical key set.
 */
export interface RollupSeriesSpec {
  readonly name: string;
  readonly agg: RollupAgg;
  readonly extract: (record: MetricsSnapshotRecord) => number | null;
}

/** The folded self-check projection on a rollup row. */
export interface RollupSelfCheck {
  stages_declared: number;
  stages_with_zero_samples: string[];
  paths_with_zero_samples: string[];
}

/**
 * One aggregated rollup row (the analysis half of the emitted record; the
 * envelope's `ts`/`level`/`event`/`service`/`role`/`pid`/`reason` are stamped
 * by `runtime.ts`, the only place that may read the clock and `process`).
 */
export interface RollupRow {
  release: RollupRelease;
  /**
   * The process INSTANCE this row aggregates — the `pid` every record in the
   * group carried (the S8 restart discriminator). `null` when the group's
   * records carried none (a foreign/legacy row). Deliberately distinct from the
   * emit envelope's `pid`, which identifies the process that WROTE the row
   * (`runtime.ts`): after a restart those two differ, and a consumer comparing
   * rows wants the former.
   */
  process_pid: number | null;
  window: { from: number; to: number; kind: 'trailing' };
  snapshots_in_window: number;
  series: Record<string, RollupSeries>;
  self_check: RollupSelfCheck;
  otel: { state: OtelState };
}

// ── Sample extraction helpers (pure) ────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A finite number, or `null` for anything else (NaN/Infinity included). */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A non-empty string, else `null` — the BL-433 contract (`''` is not a value). */
function nullField(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The `sections.store_metrics` block, or `null` when absent/foreign (S4 adds
 *  it; before S4 — and for any composition root that never registers it — the
 *  `store_metrics.*` series simply report `samples: 0`). */
function storeMetrics(r: MetricsSnapshotRecord): Record<string, unknown> | null {
  const sections = r.sections;
  if (sections === null || sections === undefined) return null;
  const sm = sections['store_metrics'];
  return isRecord(sm) ? sm : null;
}

/** A latency sample from either a bare number or a `{p50,p99,mean,max}` block:
 *  the tail (`p99`) when there is one, else the number, else `null`. */
function latencySample(v: unknown): number | null {
  const direct = num(v);
  if (direct !== null) return direct;
  if (isRecord(v)) return num(v['p99']);
  return null;
}

/**
 * Derived average CPU utilisation since process start, as a percentage of one
 * core: `(cpu_user_ms + cpu_system_ms) / (uptime_s * 1000) * 100`. Both inputs
 * are cumulative-since-start on the snapshot row, so the ratio is a genuine
 * gauge (`cpu.percent` in the declared list), not a delta.
 */
function cpuPercent(r: MetricsSnapshotRecord): number | null {
  const user = num(r.process?.cpu_user_ms);
  const system = num(r.process?.cpu_system_ms);
  const uptime = num(r.process?.uptime_s);
  if (user === null || system === null || uptime === null || uptime <= 0) return null;
  return ((user + system) / (uptime * 1000)) * 100;
}

/**
 * THE CLOSED DECLARED SERIES LIST. Adding a series is a deliberate, reviewable
 * edit here — never a runtime registration — so the key set of every rollup
 * row's `series` object is fixed and identical for every release.
 *
 * `store_metrics.*` families are present only after S4 (`memory-server`'s
 * `metrics-snapshot-section.ts`); before then (and in this package's own specs)
 * they simply report `samples: 0` with `null` statistics, which is the honest
 * "no samples in this window" — never a fabricated zero.
 */
export const ROLLUP_SERIES: readonly RollupSeriesSpec[] = [
  { name: 'process.rss_bytes', agg: 'gauge', extract: (r) => num(r.process?.rss_bytes) },
  { name: 'process.heap_used_bytes', agg: 'gauge', extract: (r) => num(r.process?.heap_used_bytes) },
  { name: 'cpu.user_ms', agg: 'cumulative_delta', extract: (r) => num(r.process?.cpu_user_ms) },
  { name: 'cpu.system_ms', agg: 'cumulative_delta', extract: (r) => num(r.process?.cpu_system_ms) },
  { name: 'cpu.percent', agg: 'gauge', extract: cpuPercent },
  { name: 'process.uptime_s', agg: 'gauge_max', extract: (r) => num(r.process?.uptime_s) },
  { name: 'records_covered', agg: 'sum', extract: (r) => num(r.records_covered) },
  // `snapshot_seq` IS the monotonic "snapshots written" counter on each row;
  // `counter_max` takes its highest value in the window.
  { name: 'snapshots_written', agg: 'counter_max', extract: (r) => num(r.snapshot_seq) },
  // Latency percentiles are unsummable — `max_of_percentiles` keeps them maxed.
  { name: 'write_latency_ms', agg: 'max_of_percentiles', extract: (r) => latencySample(storeMetrics(r)?.['write_latency_ms']) },
  { name: 'apply_latency_ms', agg: 'max_of_percentiles', extract: (r) => latencySample(storeMetrics(r)?.['apply_latency_ms']) },
  { name: 'time_to_vector', agg: 'max_of_percentiles', extract: (r) => latencySample(storeMetrics(r)?.['time_to_vector']) },
  { name: 'embed_duration', agg: 'max_of_percentiles', extract: (r) => latencySample(storeMetrics(r)?.['embed_duration']) },
  { name: 'embed_backlog', agg: 'gauge', extract: (r) => num(storeMetrics(r)?.['embed_backlog']) },
  { name: 'slow_tasks', agg: 'counter_max', extract: (r) => num(storeMetrics(r)?.['slow_tasks']) },
  { name: 'embeds_completed', agg: 'counter_max', extract: (r) => num(storeMetrics(r)?.['embeds_completed']) },
  { name: 'embeds_failed', agg: 'counter_max', extract: (r) => num(storeMetrics(r)?.['embeds_failed']) },
];

// ── Aggregation ─────────────────────────────────────────────────────────────

/** Nearest-rank percentile over an ascending array (rank = ceil(q·n), 1-based).
 *  Nearest-rank is used deliberately: it returns an ACTUAL sample, never an
 *  interpolated value between two, so a reported p99 is always a latency that
 *  really happened. */
function nearestRank(ascending: readonly number[], q: number): number {
  const n = ascending.length;
  if (n === 0) return 0;
  const rank = Math.ceil(q * n);
  const idx = Math.min(Math.max(rank - 1, 0), n - 1);
  return ascending[idx] ?? 0;
}

/** Fold one series' samples according to its declared aggregator. */
function aggregateSeries(agg: RollupAgg, samples: readonly number[]): RollupSeries {
  const n = samples.length;
  if (n === 0) {
    return { agg, samples: 0, min: null, mean: null, p50: null, p99: null, max: null, sum: null, value: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const min = sorted[0] ?? 0;
  const max = sorted[n - 1] ?? 0;
  const mean = sum / n;
  const p50 = nearestRank(sorted, 0.5);
  const p99 = nearestRank(sorted, 0.99);
  let value: number | null;
  switch (agg) {
    case 'gauge':
      value = mean;
      break;
    case 'gauge_max':
    case 'counter_max':
    case 'max_of_percentiles':
      value = max;
      break;
    case 'sum':
      value = sum;
      break;
    case 'cumulative_delta':
      // A delta needs two points. One sample cannot distinguish "did no work"
      // from "did work" — `max − min` would be a fabricated `0` — so it is
      // reported as `null` (unmeasurable), never as a measured zero (BL-334).
      value = n < 2 ? null : max - min;
      break;
  }
  return {
    agg,
    samples: n,
    min,
    mean,
    p50,
    p99,
    max,
    // `max_of_percentiles` must never present a summable-looking `sum`.
    sum: agg === 'max_of_percentiles' ? null : sum,
    value,
  };
}

/** Normalise a raw `release` (as decoded from a record) to the all-present
 *  `RollupRelease`, every field `string | null` — never `''`, never
 *  `undefined` (the S3/BL-433 contract). */
function normalizeRelease(raw: unknown): RollupRelease {
  if (!isRecord(raw)) return { version: null, artifact_sha256: null, git_sha: null };
  return {
    version: nullField(raw['version']),
    artifact_sha256: nullField(raw['artifact_sha256']),
    git_sha: nullField(raw['git_sha']),
  };
}

/** A stable grouping key for a normalised release (identical identity ⇒
 *  identical key; the all-null release is one group). */
function releaseKey(rel: RollupRelease): string {
  return JSON.stringify([rel.version, rel.artifact_sha256, rel.git_sha]);
}

/** The process-instance discriminator a `metrics.snapshot` record carries in
 *  its `pid` field, or `null` when it carries none (a foreign/legacy row). Two
 *  lifetimes of the same build differ only here — which is why it joins the
 *  release key: a restart must be two rows, not one blended one. */
function recordPid(r: MetricsSnapshotRecord): number | null {
  return num(r['pid']);
}

/** Parse an ISO timestamp to epoch-ms, or `null` when absent/unparseable. */
function parseTs(ts: unknown): number | null {
  if (typeof ts !== 'string' || ts.length === 0) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/** Fold the window's `self_check` blocks: max declared count, union of the
 *  zero-sample lists (a stage zero-sampled at ANY point in the window is worth
 *  surfacing), and the LATEST OTel state (a current-state field, not a fold). */
function aggregateSelfCheck(recs: readonly MetricsSnapshotRecord[]): RollupSelfCheck {
  let stagesDeclared = 0;
  const zeroStages = new Set<string>();
  const zeroPaths = new Set<string>();
  for (const r of recs) {
    const sc = r.self_check;
    if (sc === null || sc === undefined) continue;
    const declared = num(sc.stages_declared);
    if (declared !== null) stagesDeclared = Math.max(stagesDeclared, declared);
    for (const s of sc.stages_with_zero_samples ?? []) zeroStages.add(s);
    for (const p of sc.paths_with_zero_samples ?? []) zeroPaths.add(p);
  }
  return {
    stages_declared: stagesDeclared,
    stages_with_zero_samples: [...zeroStages].sort(),
    paths_with_zero_samples: [...zeroPaths].sort(),
  };
}

function isOtelState(v: unknown): v is OtelState {
  return v === 'disabled' || v === 'pending' || v === 'ready' || v === 'failed';
}

/** The OTel state of the chronologically-latest record that reports one, else
 *  `disabled` (the honest "OTel never came up" default). */
function latestOtelState(recs: readonly MetricsSnapshotRecord[]): OtelState {
  for (let i = recs.length - 1; i >= 0; i--) {
    const state = recs[i]?.self_check?.otel?.state;
    if (isOtelState(state)) return state;
  }
  return 'disabled';
}

/** Build one rollup row from a single (release, process-instance) group's
 *  records (already chronologically ordered and window-filtered). */
function buildRow(
  recs: readonly MetricsSnapshotRecord[],
  from: number,
  to: number,
  processPid: number | null,
): RollupRow {
  const series: Record<string, RollupSeries> = {};
  for (const spec of ROLLUP_SERIES) {
    const samples: number[] = [];
    for (const r of recs) {
      const v = spec.extract(r);
      if (v !== null && Number.isFinite(v)) samples.push(v);
    }
    series[spec.name] = aggregateSeries(spec.agg, samples);
  }
  const latest = recs[recs.length - 1];
  return {
    release: normalizeRelease(latest?.release),
    process_pid: processPid,
    window: { from, to, kind: 'trailing' },
    snapshots_in_window: recs.length,
    series,
    self_check: aggregateSelfCheck(recs),
    otel: { state: latestOtelState(recs) },
  };
}

/**
 * Fold the `metrics.snapshot` records inside the trailing `windowMs` into one
 * {@link RollupRow} per distinct `(release, process instance)` group.
 *
 * Pure: `now` is injected, nothing is read from disk or the clock. Records
 * whose `ts` is missing/unparseable, or falls outside `[now − windowMs, now]`,
 * are dropped. Rows are ordered by group key (release, then process instance —
 * deterministic, independent of input order). An empty window yields `[]` —
 * never a row of nulls.
 */
export function aggregateSnapshots(
  records: readonly MetricsSnapshotRecord[],
  opts: { windowMs: number; now: number },
): RollupRow[] {
  const from = opts.now - opts.windowMs;
  const inWindow = records
    .map((r) => ({ r, t: parseTs(r.ts) }))
    .filter((x): x is { r: MetricsSnapshotRecord; t: number } => x.t !== null && x.t >= from && x.t <= opts.now)
    .sort((a, b) => a.t - b.t)
    .map((x) => x.r);

  if (inWindow.length === 0) return [];

  // Group on (release, process instance): a release boundary AND a restart each
  // split the window, because a counter reset (or a dead process) blended into
  // another lifetime's row is a misleading number — see the file header.
  const groups = new Map<string, MetricsSnapshotRecord[]>();
  const pids = new Map<string, number | null>();
  for (const r of inWindow) {
    const rel = normalizeRelease(r.release);
    const pid = recordPid(r);
    const key = `${releaseKey(rel)}|${pid === null ? 'null' : pid}`;
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [r]);
      pids.set(key, pid);
    } else {
      bucket.push(r);
    }
  }

  const rows: RollupRow[] = [];
  for (const key of [...groups.keys()].sort()) {
    rows.push(buildRow(groups.get(key) ?? [], from, opts.now, pids.get(key) ?? null));
  }
  return rows;
}
