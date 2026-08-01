/**
 * bl401-telemetry-substrate.spec.ts — BL-401 acceptance.
 *
 * BL-351's stated acceptance line ("two different packages emit spans that
 * join on one trace-id... every emitted metric is reachable from the status
 * surface without reading a log file... verified on a real spawned service,
 * not in-process") was NOT met when `@adhd/sox-telemetry`'s interface shipped
 * (PKT-02) — tracked as BL-401. This spec proves the two gaps a vitest-level
 * test CAN prove:
 *
 *   1. memory-core no longer contains a second `RotatingJsonlWriter` — it is
 *      migrated onto `@adhd/sox-telemetry`'s `DurableJsonlSink`.
 *   2. Two different packages — memory-core's `telemetry.ts` (via its
 *      re-exported `withTrace`/`log`) and `@adhd/sox-store-adapter`'s
 *      `withRetry` (a direct `@adhd/sox-telemetry` consumer, BL-401 gap 2) —
 *      emit log records, written to TWO SEPARATE sink files, that carry the
 *      SAME `trace_id`. This is only possible because both packages resolve
 *      to the ONE shared process-wide `AsyncLocalStorage` instance in
 *      `@adhd/sox-telemetry`'s `trace.ts` — the exact boundary the substrate
 *      exists to unify (see trace.ts's own doc comment).
 *
 * What this spec does NOT prove (explicitly out of scope, tracked as the
 * remaining BL-401 gaps): the OTel SDK wiring (gap 4, optional) and
 * verification against a REAL SPAWNED memory-server process (gap 5) — the
 * latter is blocked by the standing constraint against rebuilding the live
 * memory-server bundle from a shared checkout (BL-393).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTelemetry, _resetTelemetryForTest as _resetSubstrateForTest } from '@adhd/sox-telemetry';
import { log as memCoreLog, withTrace, currentLogFilePath, _resetTelemetryForTest, _flushTelemetryForTest } from './telemetry.js';

// store-adapter is lazy-loaded across memory-core (BL-231: it's an ESM
// package, memory-core compiles to CommonJS) — `@nx/enforce-module-boundaries`
// requires a dynamic import here too, matching db.ts/recall.ts/lease.spec.ts.
async function loadWithRetry(): Promise<typeof import('@adhd/sox-store-adapter')['withRetry']> {
  const mod = await import('@adhd/sox-store-adapter');
  return mod.withRetry;
}

function tmpDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function readLines(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('BL-401: memory-core is migrated onto @adhd/sox-telemetry', () => {
  it('BL-401: memory-core/src/telemetry.ts no longer contains a second RotatingJsonlWriter', () => {
    const src = fs.readFileSync(path.join(__dirname, 'telemetry.ts'), 'utf8');
    // The class declaration specifically — not the migration commentary,
    // which legitimately mentions the retired name for context.
    expect(src).not.toMatch(/class\s+RotatingJsonlWriter/);
    expect(src).toContain('DurableJsonlSink');
  });
});

describe('BL-401: two different packages emit records that join on one trace-id', () => {
  let memCoreDir: string, substrateDir: string;
  let cleanupMemCore: () => void, cleanupSubstrate: () => void;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    const a = tmpDir('bl401-memcore-');
    const b = tmpDir('bl401-substrate-');
    memCoreDir = a.dir;
    cleanupMemCore = a.cleanup;
    substrateDir = b.dir;
    cleanupSubstrate = b.cleanup;

    for (const k of ['SOX_MEMORY_LOG_DIR', 'SOX_MEMORY_LOG_COMPONENT', 'SOX_MEMORY_LOG_DISABLE']) {
      savedEnv[k] = process.env[k];
    }
    process.env['SOX_MEMORY_LOG_DIR'] = memCoreDir;
    process.env['SOX_MEMORY_LOG_COMPONENT'] = 'bl401-memcore';
    delete process.env['SOX_MEMORY_LOG_DISABLE'];
    _resetTelemetryForTest();

    _resetSubstrateForTest();
    initTelemetry({ service: 'bl401-substrate', role: 'test', logSink: 'file', logDir: substrateDir });
  });

  afterEach(() => {
    _resetTelemetryForTest();
    _resetSubstrateForTest();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanupMemCore();
    cleanupSubstrate();
  });

  it('BL-401: a memory-core log.* record and a store-adapter withRetry() log record share the same trace_id', async () => {
    const traceId = 'bl401-join-trace';
    const withRetry = await loadWithRetry();

    await withTrace(traceId, async () => {
      memCoreLog.info('memory_core.bl401_test_event', {});

      // A genuinely retriable error (duck-typed SQLITE_BUSY shape — see
      // store-adapter's isBusyError). maxRetries: 2 guarantees BOTH a
      // 'store_adapter.retry.attempt' log (attempt 0, not yet exhausted) AND
      // a 'store_adapter.retry.exhausted' log (attempt 1, the last one).
      await withRetry(
        async () => {
          const err = new Error('database is locked') as Error & { code: string };
          err.code = 'SQLITE_BUSY';
          throw err;
        },
        { maxRetries: 2, baseDelayMs: 1 },
      ).catch(() => {
        // Expected — the whole point is to exhaust retries and observe both
        // log records that bracket the failure.
      });
    });

    await _flushTelemetryForTest();

    const memCoreRecords = readLines(currentLogFilePath());
    expect(memCoreRecords.length).toBeGreaterThan(0);
    const memCoreRecord = memCoreRecords.find((r) => r['event'] === 'memory_core.bl401_test_event');
    expect(memCoreRecord).toBeDefined();
    expect(memCoreRecord!['trace_id']).toBe(traceId);

    // The substrate sink is a SEPARATE DurableJsonlSink instance, writing to
    // a SEPARATE directory/file — component is `${service}.${role}` per
    // initTelemetry's role-qualification (BL-353).
    const substrateFile = fs
      .readdirSync(substrateDir)
      .find((f) => f.startsWith('bl401-substrate.test-') && f.endsWith('.jsonl'));
    expect(substrateFile).toBeDefined();
    const substrateRecords = readLines(path.join(substrateDir, substrateFile!));
    const retryRecords = substrateRecords.filter((r) => String(r['event']).startsWith('store_adapter.retry.'));
    expect(retryRecords.length).toBeGreaterThan(0);
    for (const rec of retryRecords) {
      expect(rec['trace_id']).toBe(traceId);
    }
    expect(retryRecords.some((r) => r['event'] === 'store_adapter.retry.attempt')).toBe(true);
    expect(retryRecords.some((r) => r['event'] === 'store_adapter.retry.exhausted')).toBe(true);

    // The join: two packages, two independent sink files, ONE trace_id.
    expect(memCoreRecord!['trace_id']).toBe(retryRecords[0]!['trace_id']);
  });
});
