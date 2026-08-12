/**
 * bl328-calibration-observability.spec.ts — BL-328 / PKT-30: the τ a full
 * clustering pass actually ran at must be visible in the pass's own log line.
 *
 * THE DEFECT. PKT-30 shipped target-mean-degree calibration and its commit
 * message claims "the pass now reports cluster_calibration /
 * cluster_guard_retries / cluster_effective_threshold". That is true only of
 * the in-memory `BatchEnrichResult` the isolated child hands back — the ONLY
 * durable record of a pass, `enrich.pass.finish` in `runEnrichPassOnDb`, logged
 * `communities_upserted` and friends and dropped all three calibration fields
 * on the floor. Measured on the live store 2026-08-05: a genuine full pass
 * (`full_pass: true`, `communities_upserted: 443`) emitted a log line with no
 * calibration field of any kind, so the only observable was a cluster count —
 * which is IDENTICAL whether calibration ran and chose the floor, or never ran
 * at all. Three sessions concluded from that line that calibration was inert in
 * production; running the deployed sidecar against a copy of the same store
 * proved it had in fact run and reported `reason: 'floor'`, τ=0.87, projected
 * mean degree 1.98977 against a budget of 2.0. The defect is not the τ — it is
 * that the operating τ was unobservable, which is BL-328 §5.4's original
 * finding ("the operating τ was undocumented and unasserted") reappearing one
 * layer above the layer PKT-30 fixed it at.
 *
 * RED→GREEN. Both tests below fail against the pre-fix `log.info('enrich.pass.
 * finish', …)` payload — `cluster_effective_threshold` is `undefined` there —
 * and pass once the pass line forwards the fields the child already returns.
 *
 * The second test is the one that would have caught the live incident: it runs
 * a REAL full pass through the REAL isolated child fork (no fake host), the
 * same path `memory_curate {op:'recluster'}` drives in production, and asserts
 * the calibration is reported end to end rather than only inside the child.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getDb,
  _setEmbedProviderForTest,
  _setEnrichHostForkResolverForTest,
  DeterministicTestProvider,
  flushPendingEmbeds,
  WriteQueue,
  CLUSTER_THRESHOLD_FLOOR,
  CLUSTER_THRESHOLD_CEILING,
} from '@adhd/sox-memory-core';
import { handleToolCall, runEnrichPassOnDb, wakeDrain } from './index.js';

const LOG_ENV = [
  'SOX_MEMORY_LOG_DIR',
  'SOX_MEMORY_LOG_COMPONENT',
  'SOX_MEMORY_LOG_LEVEL',
] as const;

const cleanups: Array<() => void> = [];
const saved: Record<string, string | undefined> = {};
let logDir: string;

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Every JSONL record written to the temp log dir this test owns. */
function readRecords(): Record<string, unknown>[] {
  if (!fs.existsSync(logDir)) return [];
  return fs
    .readdirSync(logDir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(logDir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );
}

function passFinishRecords(): Record<string, unknown>[] {
  return readRecords().filter((r) => r['event'] === 'enrich.pass.finish');
}

/** Fake host reporting a calibrated full-pass result — the exact `BatchEnrichResult`
 *  shape the real child returns on the live store, with a NON-floor τ so an
 *  assertion cannot pass by accidentally reading a hard-coded default. */
function calibratedHostScript(): { modulePath: string; execArgv: string[] } {
  const dir = tmpDir('sox-bl328-host-');
  const p = path.join(dir, 'fake-host.js');
  fs.writeFileSync(
    p,
    `
process.on('message', (msg) => {
  if (typeof process.send === 'function') {
    process.send({
      id: msg.id,
      result: {
        communities_upserted: 506, member_of_edges: 3006, importance_updated: 0,
        relates_to_edges: 0, topics_backfilled: 0, legacy_nodes_stamped: 0,
        embed_model_backfilled: 0, cluster_pass_skipped: false, incremental_joined: 0,
        cluster_calibration: {
          metric: 'pairwise', target_mean_degree: 2, sample_size: 400,
          pair_count: 79800, target_n: 4963, threshold: 0.89,
          edge_probability: 0.00040100, projected_mean_degree: 1.9898,
          reason: 'target-degree',
        },
        cluster_guard_retries: 0,
        cluster_effective_threshold: 0.89,
      },
    });
  }
  setImmediate(() => process.exit(0));
});
`,
  );
  return { modulePath: p, execArgv: [] };
}

beforeEach(() => {
  for (const k of LOG_ENV) saved[k] = process.env[k];
  logDir = path.join(tmpDir('sox-bl328-'), 'logs');
  process.env['SOX_MEMORY_LOG_DIR'] = logDir;
  process.env['SOX_MEMORY_LOG_COMPONENT'] = 'bl328';
  process.env['SOX_MEMORY_LOG_LEVEL'] = 'info';
  delete process.env['SOX_SYNC_EMBED'];
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  _setEnrichHostForkResolverForTest(null);
  await flushPendingEmbeds();
  WriteQueue.clearInstances();
  _setEmbedProviderForTest(new DeterministicTestProvider());
  process.env['SOX_SYNC_EMBED'] = '1'; // restore the suite-wide pin other specs rely on
  for (const k of LOG_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const c of cleanups.splice(0)) c();
});

describe('BL-328 — the pass log line reports the τ the partition was produced at', () => {
  it('forwards cluster_calibration / cluster_effective_threshold / cluster_guard_retries from the child into enrich.pass.finish', async () => {
    const dbPath = path.join(tmpDir('sox-bl328-store-'), 'store.db');
    await handleToolCall('memory_ping', { db_path: dbPath });
    const adapter = await getDb(dbPath);

    _setEnrichHostForkResolverForTest(() => calibratedHostScript());
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });

    const finishes = passFinishRecords();
    expect(finishes.length).toBeGreaterThan(0);
    const rec = finishes[finishes.length - 1]!;

    // THE ASSERTION: the operating τ is in the durable record, not just in the
    // child's return value. Pre-fix these are all `undefined`.
    expect(rec['cluster_effective_threshold']).toBe(0.89);
    expect(rec['cluster_guard_retries']).toBe(0);
    const calibration = rec['cluster_calibration'] as Record<string, unknown> | undefined;
    expect(calibration).toBeDefined();
    expect(calibration!['reason']).toBe('target-degree');
    expect(calibration!['metric']).toBe('pairwise');
    expect(calibration!['projected_mean_degree']).toBe(1.9898);
    expect(calibration!['target_mean_degree']).toBe(2);
  });

  it('records the fields as explicit null on an incremental pass, so "not calibrated" is distinguishable from "not instrumented"', async () => {
    const dbPath = path.join(tmpDir('sox-bl328-store-'), 'store.db');
    await handleToolCall('memory_ping', { db_path: dbPath });
    const adapter = await getDb(dbPath);

    // No pending full-enrich trigger → the tick runs incrementally, and the
    // incremental path never recalibrates (cluster.ts §2.2).
    const dir = tmpDir('sox-bl328-host-');
    const p = path.join(dir, 'incremental-host.js');
    fs.writeFileSync(
      p,
      `process.on('message', (msg) => {
         process.send({ id: msg.id, result: {
           communities_upserted: 0, member_of_edges: 0, importance_updated: 0,
           relates_to_edges: 0, topics_backfilled: 0, legacy_nodes_stamped: 0,
           embed_model_backfilled: 0, cluster_pass_skipped: false, incremental_joined: 3 } });
         setImmediate(() => process.exit(0));
       });`,
    );
    _setEnrichHostForkResolverForTest(() => ({ modulePath: p, execArgv: [] }));
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });

    const rec = passFinishRecords().pop()!;
    expect(Object.keys(rec)).toContain('cluster_effective_threshold');
    expect(rec['cluster_effective_threshold']).toBeNull();
    expect(rec['cluster_calibration']).toBeNull();
    expect(rec['cluster_guard_retries']).toBeNull();
  });
});

describe('BL-328 — a REAL full pass through the real isolated child reports its calibration', () => {
  it('memory_curate recluster → tick → enrich.pass.finish carries a calibrated τ at or above the floor', async () => {
    const dbPath = path.join(tmpDir('sox-bl328-store-'), 'store.db');
    await handleToolCall('memory_ping', { db_path: dbPath });

    for (let i = 0; i < 12; i++) {
      const res = await handleToolCall('memory_write', {
        db_path: dbPath,
        project_path: '/tmp/bl328',
        content: `BL-328 calibration observability fixture episode ${i} — enough prose to clear the 50-character minimum the cluster episode selector applies.`,
      });
      expect(res.isError).toBeFalsy();
    }
    await flushPendingEmbeds();
    wakeDrain('bl328-setup');
    await new Promise((r) => setTimeout(r, 100));

    // The live trigger: enqueue a full-pass row exactly as production does.
    const curate = await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster' });
    expect(curate.isError).toBeFalsy();

    const adapter = await getDb(dbPath);
    const tick = await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });
    expect(tick.full_pass).toBe(true);
    expect(tick.cluster_ok).toBe(true);

    const rec = passFinishRecords().pop()!;
    expect(rec['full_pass']).toBe(true);

    // THE ASSERTION that would have caught the live incident: after a genuine
    // full pass, an operator can read the τ the partition was produced at
    // straight off the pass line — no copy of the store, no re-run required.
    const tau = rec['cluster_effective_threshold'];
    expect(typeof tau).toBe('number');
    expect(tau as number).toBeGreaterThanOrEqual(CLUSTER_THRESHOLD_FLOOR);
    expect(tau as number).toBeLessThanOrEqual(CLUSTER_THRESHOLD_CEILING);

    const calibration = rec['cluster_calibration'] as Record<string, unknown> | undefined;
    expect(calibration).toBeDefined();
    expect(calibration!['metric']).toBe('pairwise');
    expect(['floor', 'target-degree', 'ceiling', 'sample-too-small']).toContain(
      calibration!['reason'],
    );
    expect(rec['cluster_guard_retries']).toBe(0);
  }, 60_000);
});
