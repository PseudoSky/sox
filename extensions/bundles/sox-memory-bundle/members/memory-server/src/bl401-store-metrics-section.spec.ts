/**
 * bl401-store-metrics-section.spec.ts — durable-metrics **S4**, BL-225.
 *
 * Backlog item `4436adec-ea37-4ff2-a379-1ab30f48d73d` (component memory-server).
 *
 * WHAT THIS GOLDEN CATCHES
 * ────────────────────────
 * Several of memory-server's most operationally load-bearing metric families
 * existed ONLY on the live `memory_ping` response — a purely in-memory view a
 * crash takes with it. S4 promotes them into a durable `sections.store_metrics`
 * block on every persisted `metrics.snapshot` line. This spec proves that
 * promotion end-to-end:
 *
 *   memory_ping's sources ──▶ registerStoreMetricsSnapshotSection() ──▶
 *   snapshotMetrics('pull') ──▶ <service>.<role>.metrics-snapshot-<date>.jsonl
 * on disk under a pinned scratch ecosystem home, with every family present and
 * every value equal to the `memory_ping` field it was promoted from.
 *
 * ACCEPTANCE (all asserted here)
 * ──────────────────────────────
 *   (a) a persisted `metrics.snapshot` row carries `sections.store_metrics`
 *       with write_latency_ms, apply_latency_ms, slow_tasks,
 *       recall_degradations, embed_backlog, embeds_completed, embeds_failed,
 *       time_to_vector, embed_duration, and a non-empty `growth` object — and
 *       each value equals the same field on `memory_ping` for the same store.
 *   (b) the section provider opens NO sink of its own: no extra file appears
 *       and the persisted-record count rises by exactly the number of
 *       `snapshotMetrics` calls.
 *   (c) section registered + `logSink:'none'` ⇒ `snapshotMetrics` creates no
 *       directory and writes nothing.
 *   (d) a provider that throws records `{ error: <message> }` inside the
 *       section and MUST NOT break the snapshot write.
 *   (e) this spec's uid-named test names the item id.
 *
 * SANDBOX — the S5 KNOWN TRAP applies here too
 * ────────────────────────────────────────────
 * Pinning `SOX_ECOSYSTEM_HOME` off the run scratch root ALSO moves the derived
 * embed-host socket dir (`$SOX_ECOSYSTEM_HOME/run`). Unless
 * `SOX_MEMSRV_TEST_SCRATCH_ROOT` AND `SOX_EMBED_CACHE_DIR` are re-homed under
 * the same temp tree, `assertEmbedPathsIsolated` (vitest.setup.ts, afterEach)
 * trips and masks every assertion here. All three are re-homed in `beforeAll`.
 * The artifact is asserted to land under the temp root and the production
 * `~/.adhd/sox-ecosystem/<service>/` tree is asserted absent.
 *
 * BL-225 RED→GREEN (both captured on this exact tree):
 *   RED — with the section registration neutralised (the
 *         `registerSnapshotSection('store_metrics', …)` call inside
 *         `metrics-snapshot-section.ts` commented out, so the provider never
 *         runs): the uid-named test fails on
 *         `a persisted metrics.snapshot row must carry sections.store_metrics`
 *         (the pull row has no `store_metrics` block).
 *   GREEN — registration restored: every family is present and equals its
 *         `memory_ping` counterpart, read back off disk.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _resetTelemetryForTest, initTelemetry, snapshotMetrics } from '@adhd/sox-telemetry';
import { WriteQueue, flushPendingEmbeds, type StoreGrowthGauge } from '@adhd/sox-memory-core';
import {
  handleToolCall,
  registerStoreMetricsSnapshotSection,
  resolveStoreDbPath,
  resolveStoreMetricsSectionPath,
  unregisterStoreMetricsSnapshotSection,
} from './index.js';
import {
  _resetStoreMetricsSamplesForTest,
  buildStoreMetricsSection,
  getSampledStorePath,
  recordStoreMetricsSample,
  registerStoreMetricsSection,
} from './metrics-snapshot-section.js';
import { SCRATCH_ROOT_ENV } from './test-support/bl-26291f21-embed-scratch-env.js';

const SERVICE = 's4-store-metrics';
const ROLE = 'test';
/** This item's own uid — the BL-225 test title must name it verbatim. */
const UID = '4436adec-ea37-4ff2-a379-1ab30f48d73d';
const REAL_SERVICE_ROOT = path.join(os.homedir(), '.adhd', 'sox-ecosystem', SERVICE);

/** A complete, valid store-growth gauge — used by the ~-resolution unit case
 *  (g), which needs a non-null growth object without opening a store. */
const GROWTH_PROBE: StoreGrowthGauge = {
  file_bytes: 4096,
  wal_bytes: 0,
  page_count: 1,
  page_size: 4096,
  freelist_count: 0,
  page_bytes: 4096,
  live_nodes: 1,
  bytes_per_live_node: 4096,
  fts_optimize_passes_since_rebuild: 0,
  last_rebuild_at: null,
  thresholds: { bytes_per_live_node: 1_000_000, optimize_passes_since_rebuild: 20, min_live_nodes: 10 },
  alarm: false,
  alarm_reasons: [],
  remedy: null,
  config_errors: [],
};

interface SnapshotRow {
  event?: string;
  reason?: string;
  snapshot_seq?: number;
  sections?: Record<string, Record<string, unknown>>;
}

function utcDate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** One macrotask turn — enough for the S1 deferred startup snapshot to land. */
function turn(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r));
}

function snapshotFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.includes('.metrics-snapshot-'));
}

function readRows(dir: string): SnapshotRow[] {
  return snapshotFiles(dir).flatMap((f) =>
    fs
      .readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SnapshotRow),
  );
}

function countSnapshotRecords(dir: string): number {
  return readRows(dir).filter((r) => r.event === 'metrics.snapshot').length;
}

/** Every regular file under `dir`, recursively (for the "no extra sink" proof). */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

function parse(res: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]?.text ?? '{}') as Record<string, unknown>;
}

let tempHome: string;
let savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  // Acceptance (c): pin the persistence root explicitly — never inherit it.
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 's4-store-metrics-'));
  savedEnv = {
    SOX_ECOSYSTEM_HOME: process.env['SOX_ECOSYSTEM_HOME'],
    [SCRATCH_ROOT_ENV]: process.env[SCRATCH_ROOT_ENV],
    SOX_EMBED_CACHE_DIR: process.env['SOX_EMBED_CACHE_DIR'],
    SOX_TRACE_SNAPSHOT_MS: process.env['SOX_TRACE_SNAPSHOT_MS'],
  };
  // The S5 KNOWN TRAP: all three move together, or `assertEmbedPathsIsolated`
  // reds every afterEach (see this file's header).
  process.env['SOX_ECOSYSTEM_HOME'] = tempHome;
  process.env[SCRATCH_ROOT_ENV] = tempHome;
  process.env['SOX_EMBED_CACHE_DIR'] = path.join(tempHome, 'models');
  // Never let a stray debug override arm an interval trigger mid-test.
  delete process.env['SOX_TRACE_SNAPSHOT_MS'];
});

afterEach(async () => {
  await flushPendingEmbeds();
  unregisterStoreMetricsSnapshotSection();
  _resetStoreMetricsSamplesForTest();
  _resetTelemetryForTest();
  delete process.env['SOX_CONFIG_DB_PATH'];
});

afterAll(async () => {
  await flushPendingEmbeds();
  WriteQueue.clearInstances();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('durable-metrics S4 — store_metrics snapshot section', () => {
  it(`${UID}: store_metrics snapshot section promotes ping-only metric families into durable snapshots`, async () => {
    const dir = fs.mkdtempSync(path.join(tempHome, 'case-a-'));
    const dbPath = path.join(dir, 'store.db');
    process.env['SOX_CONFIG_DB_PATH'] = dbPath;
    const logDir = path.join(dir, 'logs');

    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      logDir,
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
    });

    // Register exactly as the entrypoint does (startup wiring), then let the S1
    // startup snapshot land so the pull below is deterministically the last row.
    registerStoreMetricsSnapshotSection();
    await turn();
    await turn();

    // Create the store and populate the SYNCHRONOUS families (write-queue +
    // Phase-B pipeline). SOX_SYNC_EMBED=1 (the suite pin) settles Phase B inline.
    const write = await handleToolCall('memory_write', {
      db_path: dbPath,
      project_path: dir,
      content: 'S4 store_metrics acceptance episode.',
    });
    expect(write.isError).not.toBe(true);

    // The live ping — the comparison baseline, same store.
    const ping = parse(await handleToolCall('memory_ping', { db_path: dbPath }));
    const store = ping['store'] as Record<string, unknown>;
    expect(store, 'memory_ping must have opened the temp store').toBeTruthy();

    // The durable pull.
    await snapshotMetrics('pull');

    const rows = readRows(logDir);
    const row = [...rows].reverse().find((r) => r.sections?.store_metrics !== undefined);
    expect(row, 'a persisted metrics.snapshot row must carry sections.store_metrics').toBeDefined();
    const section = row!.sections!.store_metrics as Record<string, unknown>;

    // ── (a) every promoted family is present ────────────────────────────────
    const families = [
      'write_latency_ms',
      'apply_latency_ms',
      'slow_tasks',
      'recall_degradations',
      'embed_backlog',
      // backlog fdd3a304: must be 1:1 with `memory_ping.store.embed_backlog_oldest_at`.
      'embed_backlog_oldest_at',
      'embeds_completed',
      'embeds_failed',
      'time_to_vector',
      'embed_duration',
      'growth',
    ];
    for (const family of families) {
      expect(section, `sections.store_metrics must carry ${family}`).toHaveProperty(family);
    }

    // growth must be a NON-EMPTY object with the gauge fields.
    const growth = section['growth'] as Record<string, unknown>;
    expect(growth, 'growth must be a non-empty object').toBeTruthy();
    for (const field of [
      'file_bytes',
      'page_count',
      'freelist_count',
      'live_nodes',
      'bytes_per_live_node',
      'fts_optimize_passes_since_rebuild',
      'alarm',
    ]) {
      expect(growth, `growth must carry ${field}`).toHaveProperty(field);
    }

    // ── (a)(iii) the values equal the same fields on memory_ping ─────────────
    const wq = (store['write_queue'] ?? null) as Record<string, unknown> | null;
    const wqCounters = (wq?.['counters'] ?? null) as Record<string, unknown> | null;
    expect(section['write_latency_ms']).toEqual(wq?.['write_latency_ms'] ?? null);
    expect(section['apply_latency_ms']).toEqual(wq?.['apply_latency_ms'] ?? null);
    expect(section['slow_tasks']).toEqual(wqCounters?.['slow_tasks'] ?? null);
    expect(section['recall_degradations']).toEqual(ping['recall_degradations']);
    expect(section['embed_backlog']).toEqual(store['embed_backlog']);
    // backlog fdd3a304: projected 1:1 with the ping's field.
    expect(section['embed_backlog_oldest_at']).toEqual(store['embed_backlog_oldest_at']);
    const embedPipeline = (store['embed_pipeline'] ?? null) as Record<string, unknown> | null;
    const ep = (embedPipeline?.['metrics'] ?? null) as Record<string, unknown> | null;
    const epCounters = (ep?.['counters'] ?? null) as Record<string, unknown> | null;
    expect(section['embeds_completed']).toEqual(epCounters?.['embeds_completed'] ?? null);
    expect(section['embeds_failed']).toEqual(epCounters?.['embeds_failed'] ?? null);
    expect(section['time_to_vector']).toEqual(ep?.['time_to_vector_ms'] ?? null);
    expect(section['embed_duration']).toEqual(ep?.['embed_duration_ms'] ?? null);
    expect(section['growth']).toEqual(store['growth']);

    // The write must have produced REAL synchronous metrics (not the empty shape).
    expect(wq, 'a write must have created the WriteQueue metrics entry').not.toBeNull();
    expect(section['write_latency_ms']).not.toBeNull();

    // Plan AC (i): the nested groups are present too.
    const nestedWriteQueue = section['write_queue'] as Record<string, unknown>;
    const nestedEmbed = section['embed'] as Record<string, unknown>;
    expect(nestedWriteQueue['write_latency_ms']).toEqual(section['write_latency_ms']);
    expect(nestedEmbed['embed_backlog']).toEqual(section['embed_backlog']);
    // backlog fdd3a304: also projected inside the nested `embed` group.
    expect(nestedEmbed['embed_backlog_oldest_at']).toEqual(section['embed_backlog_oldest_at']);

    // The artifact landed under the pinned temp root, NEVER the real tree.
    expect(snapshotFiles(logDir), `expected a snapshot file in ${logDir}`).toContain(
      `${SERVICE}.${ROLE}.metrics-snapshot-${utcDate()}.jsonl`,
    );
    expect(fs.existsSync(REAL_SERVICE_ROOT), `test telemetry leaked to ${REAL_SERVICE_ROOT}`).toBe(false);
  }, 60_000);

  it('(b) the section provider opens no sink of its own — no extra file, records track the snapshot calls', async () => {
    const dir = fs.mkdtempSync(path.join(tempHome, 'case-b-'));
    const logDir = path.join(dir, 'logs');
    process.env['SOX_CONFIG_DB_PATH'] = path.join(dir, 'store.db');
    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      logDir,
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
    });
    registerStoreMetricsSnapshotSection();
    await turn();
    await turn();

    const before = listFilesRecursive(dir);
    const beforeRecords = countSnapshotRecords(logDir);

    const CALLS = 3;
    for (let i = 0; i < CALLS; i++) await snapshotMetrics('pull');
    await turn();

    const after = listFilesRecursive(dir);

    // The provider opened NO sink of its own: the only files are the
    // metrics-snapshot series (a section-owned sink would add a second
    // component file), and no new file appeared across the calls.
    expect(
      after.every((f) => f.includes('.metrics-snapshot-')),
      `unexpected non-snapshot file(s): ${after.join(', ')}`,
    ).toBe(true);
    expect(after.filter((f) => !before.includes(f)), 'the section must not create its own file').toEqual([]);

    // …and the persisted-record count rises by exactly the number of calls —
    // the counts are governed by `snapshotMetrics` alone, nothing else.
    expect(countSnapshotRecords(logDir) - beforeRecords).toBe(CALLS);
  }, 30_000);

  it('(c) section registered + logSink:"none" ⇒ snapshotMetrics creates no directory and writes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(tempHome, 'case-c-'));
    const logDir = path.join(dir, 'logs'); // must NEVER be created
    process.env['SOX_CONFIG_DB_PATH'] = path.join(dir, 'store.db');
    initTelemetry({ service: SERVICE, role: ROLE, logSink: 'none', logDir, otel: false });
    registerStoreMetricsSnapshotSection();

    await snapshotMetrics('pull');
    await turn();

    expect(fs.existsSync(logDir), 'logSink:"none" must not create the log directory').toBe(false);
    expect(listFilesRecursive(dir), 'logSink:"none" must write nothing').toEqual([]);
  }, 30_000);

  it('(d) a throwing provider records { error } inside the section and never breaks the snapshot write', async () => {
    const dir = fs.mkdtempSync(path.join(tempHome, 'case-d-'));
    const logDir = path.join(dir, 'logs');
    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      logDir,
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
    });
    const unregister = registerStoreMetricsSection({
      resolveStorePath: () => {
        throw new Error('s4-throwing-provider');
      },
      recallDegradations: () => ({}),
    });
    try {
      await snapshotMetrics('pull');
      await turn();

      const rows = readRows(logDir);
      const row = rows.find(
        (r) => (r.sections?.store_metrics as Record<string, unknown> | undefined)?.['error'] === 's4-throwing-provider',
      );
      // The snapshot write still happened, with the section error recorded in place.
      expect(row, 'the snapshot must still be written, with the section error captured').toBeDefined();
      expect(row!.event).toBe('metrics.snapshot');
    } finally {
      unregister();
    }
  }, 30_000);

  /**
   * (f) backlog 51995ade (HIGH) — THE regression. A DIVERGENT store config: the
   * ping names its store via an explicit `db_path` while `SOX_CONFIG_DB_PATH` is
   * UNSET. The sample writer keys on the arg-resolved path; a reader that
   * re-derived the store from `SOX_CONFIG_DB_PATH` resolves `null` and reads the
   * two async-sourced families (`embed_backlog`, `growth`) as `null` forever —
   * a silent partial snapshot. The fix resolves the store ONCE (the section
   * reads the path the ping actually sampled), so they must NOT be null.
   */
  it('(f) divergent config: explicit db_path with SOX_CONFIG_DB_PATH UNSET still yields embed_backlog + growth (51995ade)', async () => {
    const dir = fs.mkdtempSync(path.join(tempHome, 'case-f-'));
    const dbPath = path.join(dir, 'store.db');
    // THE DIVERGENCE — the env names NO store; only the ping's arg names one.
    delete process.env['SOX_CONFIG_DB_PATH'];
    const logDir = path.join(dir, 'logs');

    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      logDir,
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
    });
    registerStoreMetricsSnapshotSection();
    await turn();
    await turn();

    const write = await handleToolCall('memory_write', {
      db_path: dbPath,
      project_path: dir,
      content: 'S4 divergent-config (explicit db_path, env unset) episode.',
    });
    expect(write.isError).not.toBe(true);

    const ping = parse(await handleToolCall('memory_ping', { db_path: dbPath }));
    const store = ping['store'] as Record<string, unknown>;
    expect(store, 'memory_ping must have opened the store named by db_path').toBeTruthy();

    await snapshotMetrics('pull');

    const rows = readRows(logDir);
    const row = [...rows].reverse().find((r) => r.sections?.store_metrics !== undefined);
    expect(row, 'a persisted metrics.snapshot row must carry sections.store_metrics').toBeDefined();
    const section = row!.sections!.store_metrics as Record<string, unknown>;

    // (51995ade HIGH) the async-sourced families must NOT be silently null.
    expect(section['embed_backlog'], 'embed_backlog must equal the pinged store').toEqual(store['embed_backlog']);
    expect(section['embed_backlog']).not.toBeNull();
    const growth = section['growth'] as Record<string, unknown> | null;
    expect(growth, 'growth must be a NON-EMPTY object under divergent config').toBeTruthy();
    expect(Object.keys(growth ?? {}).length).toBeGreaterThan(0);
    expect(section['growth']).toEqual(store['growth']);
    // …and the section reports the store the ping actually probed, not a null path.
    expect(section['store_path']).toBe(store['path']);
    expect(section['sample_age_ms']).not.toBeNull();
  }, 60_000);

  /**
   * (g) backlog 51995ade — the `~` spelling variant, cheaply. A host config may
   * carry a raw, un-expanded `~`. The shared resolver expands it ONCE and the
   * section reads that same recorded path, so the raw value can never become a
   * divergent second key that reads the async families as null. No store is
   * opened here — this pins the resolver + resolve-once identity directly.
   */
  it('(g) a ~-bearing SOX_CONFIG_DB_PATH resolves to ONE key on write and read (51995ade)', () => {
    const home = os.homedir();
    // Raw, un-expanded spelling — exactly what a host config may carry.
    process.env['SOX_CONFIG_DB_PATH'] = '~/s4-tilde-probe/store.db';
    // The shared resolver the ping's sample writer uses expands it ONCE.
    const resolved = resolveStoreDbPath(undefined, undefined);
    expect(resolved, 'the shared resolver must expand the leading ~').toBe(
      path.join(home, 's4-tilde-probe', 'store.db'),
    );

    // The ping records the sample under the resolved path…
    recordStoreMetricsSample(resolved!, {
      embed_backlog: 0,
      embed_backlog_oldest_at: null,
      growth: GROWTH_PROBE,
      growth_error: null,
    });
    expect(getSampledStorePath()).toBe(resolved);

    // …and the section reads the SAME path through the real composition
    // (resolveStoreMetricsSectionPath), never a re-derived raw `~` value.
    const section = buildStoreMetricsSection({
      resolveStorePath: resolveStoreMetricsSectionPath,
      recallDegradations: () => ({}),
    });
    expect(section['store_path']).toBe(resolved);
    expect(section['growth']).toBe(GROWTH_PROBE);
    expect(section['embed_backlog_oldest_at']).toBeNull();
  });
});
