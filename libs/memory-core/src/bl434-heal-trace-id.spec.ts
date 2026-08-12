/**
 * bl434-heal-trace-id.spec.ts — BL-434: the heal/reembed ticks must establish
 * their own ambient trace context.
 *
 * THE DEFECT. Trace ids propagate ambiently via `AsyncLocalStorage`
 * (`@adhd/sox-telemetry`'s `trace.ts`), and the logger resolves `trace_id` as
 * `fields.trace_id ?? currentTraceId() ?? null`. `_embedWork` logs
 * `embed.start` / `embed.finish` with no explicit id, so the value is entirely
 * determined by whether the CALLER established a context:
 *
 *   - write path  → `WriteQueue.enqueue` / `schedulePendingEmbeds` establish one
 *                   → `embed.start` carries a real ULID.
 *   - heal path   → `healMissingVectors` runs OUTSIDE any WriteQueue task
 *                   (BL-154) and used to establish nothing → `trace_id: null`.
 *
 * `withContendedStage` PROPAGATES ambient context, it never CREATES it, so the
 * BL-401 stage split gave heal embeds a `sox_path: 'heal'` label but still no
 * trace id: you could tell a heal embed from a write embed, but not WHICH heal
 * tick, nor join it to the row it re-embedded.
 *
 * RED→GREEN. With the `withTrace` wrappers removed from `healMissingVectors` /
 * `healStaleVectors` in `embed-pipeline.ts`, every assertion below on
 * `embed.start`'s `trace_id` fails with the received value `null` (verified by
 * running this file against the reverted source, 2026-08-04). They pass with
 * the wrappers restored.
 *
 * BL-154 safety: every heal call here is made from the top-level test body,
 * outside any WriteQueue task.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './db.js';
import { healMissingVectors, healStaleVectors, _resetEmbedPipelineMetricsForTest } from './embed-pipeline.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest, _resetEmbedSingleton, vecToJson } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';
import { _resetTelemetryForTest, _flushTelemetryForTest, currentLogFilePath } from './telemetry.js';
import { initTelemetry, _resetTelemetryForTest as _resetSubstrateForTest } from '@adhd/sox-telemetry';

const LOG_ENV = [
  'SOX_MEMORY_LOG_DIR',
  'SOX_MEMORY_LOG_COMPONENT',
  'SOX_MEMORY_LOG_LEVEL',
] as const;

function readRecords(filePath: string | null): Record<string, unknown>[] {
  if (filePath === null || !fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let dir: string;
let logDir: string;
let dbPath: string;
let db: StoreAdapter;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of LOG_ENV) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl434-'));
  logDir = path.join(dir, 'logs');
  process.env['SOX_MEMORY_LOG_DIR'] = logDir;
  process.env['SOX_MEMORY_LOG_COMPONENT'] = 'bl434';
  process.env['SOX_MEMORY_LOG_LEVEL'] = 'info';
  _resetTelemetryForTest();

  dbPath = path.join(dir, 'm.db');
  db = await openDb(dbPath);
  await WriteQueue.clearInstances();
  WriteQueue.setBypass(false);
  _resetEmbedPipelineMetricsForTest();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  _resetTelemetryForTest();
  _resetEmbedSingleton();
  await WriteQueue.clearInstances();
  await db.close().catch(() => { /* already closed */ });
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of LOG_ENV) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** An episode row with NO vec_node row — the crashed-Phase-B shape healMissingVectors targets. */
async function insertOrphan(uid: string, content: string): Promise<void> {
  await db.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'))`,
    [uid, content, `hash-${uid}`],
  );
}

/** An episode row WITH a vec_node row stamped with a foreign model — healStaleVectors' target. */
async function insertStale(uid: string, content: string): Promise<void> {
  const info = await db.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid, embed_model)
     VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'), 'some-other-model')`,
    [uid, content, `hash-${uid}`],
  );
  const rowid = info.lastInsertRowid as number;
  await db.executeRun('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)', [
    rowid,
    vecToJson(new Float32Array(768).fill(0)),
  ]);
}

describe('BL-434: heal-path embeds carry a real trace id', () => {
  it('BL-434: healMissingVectors — every embed.start/finish carries a non-null trace id', async () => {
    await insertOrphan('bl434-a', 'first orphan to heal');
    await insertOrphan('bl434-b', 'second orphan to heal');
    const wq = await WriteQueue.forPath(dbPath);

    const out = await healMissingVectors(db, wq, { limit: 10, logSink: () => { /* quiet */ } });
    expect(out.healed).toBe(2);
    await _flushTelemetryForTest();

    const records = readRecords(currentLogFilePath());
    const embedStarts = records.filter((r) => r['event'] === 'embed.start');
    expect(embedStarts.length).toBeGreaterThanOrEqual(2);
    // THE ASSERTION BL-434 IS ABOUT. Before the fix this was `null` on every record.
    for (const rec of embedStarts) {
      expect(rec['trace_id']).toEqual(expect.any(String));
      expect(rec['trace_id']).not.toBe('');
    }
    for (const rec of records.filter((r) => r['event'] === 'embed.finish')) {
      expect(rec['trace_id']).toEqual(expect.any(String));
    }
  });

  it('BL-434: each healed row gets its OWN trace id, joined to the tick by heal.row.start', async () => {
    await insertOrphan('bl434-c', 'row one');
    await insertOrphan('bl434-d', 'row two');
    const wq = await WriteQueue.forPath(dbPath);

    await healMissingVectors(db, wq, { limit: 10, logSink: () => { /* quiet */ } });
    await _flushTelemetryForTest();

    const records = readRecords(currentLogFilePath());
    const rowStarts = records.filter((r) => r['event'] === 'embed_pipeline.heal.row.start');
    expect(rowStarts).toHaveLength(2);

    // One tick id shared by both rows — the pass is reconstructable from the JSONL.
    const tickIds = new Set(rowStarts.map((r) => r['tick_trace_id']));
    expect(tickIds.size).toBe(1);
    expect([...tickIds][0]).toEqual(expect.any(String));

    // Distinct per-row ids — an embed line identifies ONE row, not the whole pass.
    const rowIds = rowStarts.map((r) => r['trace_id'] as string);
    expect(new Set(rowIds).size).toBe(2);
    expect(rowIds).not.toContain(null);
    // ...and the tick id is not silently reused as the row id.
    expect(rowIds).not.toContain([...tickIds][0]);

    // Every embed.* line joins to exactly one of the row traces.
    const embedTraces = records
      .filter((r) => r['event'] === 'embed.start' || r['event'] === 'embed.finish')
      .map((r) => r['trace_id'] as string);
    expect(embedTraces.length).toBeGreaterThanOrEqual(2);
    for (const t of embedTraces) expect(rowIds).toContain(t);
  });

  it('BL-434: the sox.stage.embed wait/work pair joins the SAME trace as the heal row', async () => {
    // The stage records are emitted by `@adhd/sox-telemetry`'s own runtime, NOT
    // by memory-core's sink — so this test must stand up the substrate sink and
    // join ACROSS the two files. Without initTelemetry the substrate's logSink
    // is 'none' and a filter for `sox.stage.embed.*` returns an empty array,
    // which would make every assertion below pass vacuously: precisely the
    // BL-167 shape where a test named for an invariant asserts nothing.
    const substrateDir = path.join(dir, 'substrate-logs');
    initTelemetry({ service: 'bl434sub', role: 'test', logSink: 'file', logDir: substrateDir, otel: false });
    try {
      await insertOrphan('bl434-e', 'stage correlation');
      const wq = await WriteQueue.forPath(dbPath);

      await healMissingVectors(db, wq, { limit: 10, logSink: () => { /* quiet */ } });
      await _flushTelemetryForTest();

      const memCoreRecords = readRecords(currentLogFilePath());
      const rowStart = memCoreRecords.find((r) => r['event'] === 'embed_pipeline.heal.row.start');
      expect(rowStart).toBeDefined();
      const rowTrace = rowStart!['trace_id'];
      expect(rowTrace).toEqual(expect.any(String));

      const substrateFile = path.join(
        substrateDir,
        fs.readdirSync(substrateDir).find((f) => f.startsWith('bl434sub.test-'))!,
      );
      const stageRecords = readRecords(substrateFile).filter(
        (r) => typeof r['event'] === 'string' && (r['event'] as string).startsWith('sox.stage.embed.'),
      );
      // Guard against the vacuous pass: the stage instrument must really fire.
      expect(stageRecords.length).toBeGreaterThan(0);
      expect(stageRecords.map((r) => r['event'])).toContain('sox.stage.embed.finish');
      // `withContendedStage` only PROPAGATES ambient context; with none
      // established these carried null. They must now inherit the row trace.
      for (const rec of stageRecords) {
        expect(rec['trace_id']).toBe(rowTrace);
        expect(rec['sox_path']).toBe('heal');
      }
    } finally {
      _resetSubstrateForTest();
    }
  });

  it('BL-434: healStaleVectors (the reembed sibling) carries a trace id on its embeds too', async () => {
    await insertStale('bl434-f', 'stale vector to re-embed');
    const wq = await WriteQueue.forPath(dbPath);

    const out = await healStaleVectors(db, wq, { limit: 10, logSink: () => { /* quiet */ } });
    expect(out.healed).toBe(1);
    await _flushTelemetryForTest();

    const records = readRecords(currentLogFilePath());
    const rowStart = records.find((r) => r['event'] === 'embed_pipeline.reembed.row.start');
    expect(rowStart).toBeDefined();
    expect(rowStart?.['tick_trace_id']).toEqual(expect.any(String));

    const embedStarts = records.filter((r) => r['event'] === 'embed.start');
    expect(embedStarts.length).toBeGreaterThanOrEqual(1);
    for (const rec of embedStarts) {
      expect(rec['trace_id']).toBe(rowStart?.['trace_id']);
      expect(rec['trace_id']).not.toBeNull();
    }
  });

  it('BL-434: the heal tick ALWAYS runs (no disable gate — ADR-0013) and mints a trace id on its embeds', async () => {
    await insertOrphan('bl434-g', 'healed unconditionally');
    const wq = await WriteQueue.forPath(dbPath);

    const out = await healMissingVectors(db, wq, { limit: 10, logSink: () => { /* quiet */ } });
    expect(out.healed).toBe(1);
    await _flushTelemetryForTest();

    const records = readRecords(currentLogFilePath());
    expect(records.filter((r) => r['event'] === 'embed_pipeline.heal.row.start').length).toBeGreaterThan(0);
    const embedStarts = records.filter((r) => r['event'] === 'embed.start');
    expect(embedStarts.length).toBeGreaterThanOrEqual(1);
    for (const rec of embedStarts) expect(rec['trace_id']).not.toBeNull();
  });
});
