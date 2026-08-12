/**
 * telemetry.spec.ts — persisted structured logging + tracing (BL-320).
 *
 * Covers: JSONL emission shape, level filtering, disable switch, trace-id
 * propagation via AsyncLocalStorage (including through awaited async
 * continuations, not just synchronous calls), size-based rotation, and the
 * adapter/transaction SQL-error instrumentation proxy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  log,
  newTraceId,
  currentTraceId,
  traceIdOrNew,
  withTrace,
  runWithNewTrace,
  currentLogFilePath,
  truncateForLog,
  instrumentQueryMethods,
  instrumentAdapter,
  _resetTelemetryForTest,
  _flushTelemetryForTest,
} from './telemetry.js';

function tmpLogDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-telemetry-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function readLines(filePath: string | null): Record<string, unknown>[] {
  // BL-433: currentLogFilePath() is `string | null` — null means logging is off.
  if (filePath === null || !fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('telemetry — structured JSONL logging (BL-320)', () => {
  let cleanup: () => void;
  let dir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    const t = tmpLogDir();
    dir = t.dir;
    cleanup = t.cleanup;
    for (const k of [
      'SOX_MEMORY_LOG_DIR',
      'SOX_MEMORY_LOG_LEVEL',
      'SOX_MEMORY_LOG_COMPONENT',
      'SOX_MEMORY_LOG_MAX_BYTES',
      'SOX_MEMORY_LOG_MAX_FILES',
    ]) {
      savedEnv[k] = process.env[k];
    }
    process.env['SOX_MEMORY_LOG_DIR'] = dir;
    process.env['SOX_MEMORY_LOG_COMPONENT'] = 'test-component';
    delete process.env['SOX_MEMORY_LOG_LEVEL'];
    delete process.env['SOX_MEMORY_LOG_MAX_BYTES'];
    delete process.env['SOX_MEMORY_LOG_MAX_FILES'];
    _resetTelemetryForTest();
  });

  afterEach(() => {
    _resetTelemetryForTest();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanup();
  });

  it('writes one JSON object per line with the documented core fields', async () => {
    log.info('test.event', { foo: 'bar', count: 3 });
    await _flushTelemetryForTest();
    const filePath = currentLogFilePath();
    expect(filePath).not.toBeNull();
    expect(filePath).toContain('test-component-');
    expect(filePath!.endsWith('.jsonl')).toBe(true);
    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
    const rec = lines[0]!;
    expect(rec['event']).toBe('test.event');
    expect(rec['level']).toBe('info');
    expect(rec['foo']).toBe('bar');
    expect(rec['count']).toBe(3);
    expect(typeof rec['ts']).toBe('string');
    expect(typeof rec['pid']).toBe('number');
    expect('trace_id' in rec).toBe(true);
  });

  it('never logs content/embedding-shaped fields implicitly — only what callers explicitly pass', async () => {
    // The API has no special-cased "content" parameter; callers are documented
    // to pass only ids/counts/durations. Verify the module does not inject
    // anything beyond ts/level/event/trace_id/pid + the caller's own fields.
    log.info('write.phaseA.start', { project_path: '/x', content_len: 42 });
    await _flushTelemetryForTest();
    const rec = readLines(currentLogFilePath())[0]!;
    expect(Object.keys(rec).sort()).toEqual(
      ['content_len', 'event', 'level', 'pid', 'project_path', 'trace_id', 'ts'].sort(),
    );
  });

  it('filters by level via SOX_MEMORY_LOG_LEVEL', async () => {
    process.env['SOX_MEMORY_LOG_LEVEL'] = 'warn';
    log.debug('should.be.dropped', {});
    log.info('should.also.be.dropped', {});
    log.warn('should.appear', {});
    log.error('should.also.appear', {});
    await _flushTelemetryForTest();
    const lines = readLines(currentLogFilePath());
    const events = lines.map((l) => l['event']);
    expect(events).toEqual(['should.appear', 'should.also.appear']);
  });

  it('logging is ALWAYS on (ADR-0013) — SOX_MEMORY_LOG_DISABLE was an anti-feature and is gone; a stale value is ignored', async () => {
    process.env['SOX_MEMORY_LOG_DISABLE'] = '1';
    log.error('should.write.anyway', {});
    await _flushTelemetryForTest();
    // The stale env value must NOT suppress the write: the path is always
    // resolvable and the record landed.
    const path = currentLogFilePath();
    expect(path).not.toBeNull();
    expect(fs.existsSync(path!)).toBe(true);
    const lines = readLines(path!);
    expect(lines.some((l) => l['event'] === 'should.write.anyway')).toBe(true);
    delete process.env['SOX_MEMORY_LOG_DISABLE'];
  });

  it('BL-433: reports the path BEFORE the first write — there is no disabled state to null out', async () => {
    // Nothing has been logged in this case yet — the old `currentPath()`-backed
    // accessor returned `''` here, indistinguishable from "logging is off".
    const beforeAnyWrite = currentLogFilePath();
    expect(beforeAnyWrite).not.toBeNull();
    expect(beforeAnyWrite).toContain('test-component-');
    expect(fs.existsSync(beforeAnyWrite!)).toBe(false); // genuinely not written yet

    log.info('bl433.first.write', {});
    await _flushTelemetryForTest();
    // ...and it named the right file all along.
    expect(currentLogFilePath()).toBe(beforeAnyWrite);
    expect(fs.existsSync(beforeAnyWrite!)).toBe(true);
  });

  it('never throws even when fields contain a circular reference', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    expect(() => log.info('circular.event', circular)).not.toThrow();
  });

  it('never throws when the log directory cannot be created', () => {
    // Point at a path whose parent is a FILE, not a directory — mkdirSync must fail.
    const blockerFile = path.join(dir, 'blocker');
    fs.writeFileSync(blockerFile, 'x');
    process.env['SOX_MEMORY_LOG_DIR'] = path.join(blockerFile, 'nested', 'logs');
    _resetTelemetryForTest();
    expect(() => log.info('should.not.throw', {})).not.toThrow();
  });

  it('rotates by size and prunes to the configured max file count', async () => {
    process.env['SOX_MEMORY_LOG_MAX_BYTES'] = '200';
    process.env['SOX_MEMORY_LOG_MAX_FILES'] = '2';
    _resetTelemetryForTest();
    for (let i = 0; i < 40; i++) {
      log.info('rotation.filler', { i, pad: 'x'.repeat(20) });
    }
    await _flushTelemetryForTest();
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('test-component-') && f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(1); // at least one rotation happened
    // Pruning runs BEFORE the fresh active file is reopened (matches
    // host-runtime's LogManager pattern), so the file count settles at
    // maxFiles on the NEXT rotation but can be transiently maxFiles+1
    // right after the last rotation of a burst (the fresh active file
    // counts toward the total but hasn't triggered a prune pass yet).
    expect(files.length).toBeLessThanOrEqual(3);
  });

  it('newTraceId() mints sortable, unique ids', () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThan(10);
  });

  it('currentTraceId()/traceIdOrNew() reflect the active withTrace context', () => {
    expect(currentTraceId()).toBeUndefined();
    withTrace('trace-abc', () => {
      expect(currentTraceId()).toBe('trace-abc');
      expect(traceIdOrNew()).toBe('trace-abc');
    });
    expect(currentTraceId()).toBeUndefined();
  });

  it('propagates the trace id through nested async continuations (the whole point of ALS here)', async () => {
    const seen: (string | undefined)[] = [];
    await withTrace('trace-async', async () => {
      seen.push(currentTraceId());
      await new Promise((r) => setTimeout(r, 5));
      seen.push(currentTraceId());
      await Promise.resolve().then(() => {
        seen.push(currentTraceId());
      });
    });
    expect(seen).toEqual(['trace-async', 'trace-async', 'trace-async']);
  });

  it('log.* auto-injects the active trace id when the caller does not supply one', async () => {
    withTrace('trace-injected', () => {
      log.info('auto.trace', {});
    });
    await _flushTelemetryForTest();
    const rec = readLines(currentLogFilePath())[0]!;
    expect(rec['trace_id']).toBe('trace-injected');
  });

  it('an explicit trace_id field wins over the ambient context', async () => {
    withTrace('trace-ambient', () => {
      log.info('explicit.trace', { trace_id: 'trace-explicit' });
    });
    await _flushTelemetryForTest();
    const rec = readLines(currentLogFilePath())[0]!;
    expect(rec['trace_id']).toBe('trace-explicit');
  });

  it('runWithNewTrace hands the minted id to the callback and to log.*', async () => {
    let captured = '';
    runWithNewTrace((id) => {
      captured = id;
      log.info('minted.trace', {});
    });
    await _flushTelemetryForTest();
    const rec = readLines(currentLogFilePath())[0]!;
    expect(rec['trace_id']).toBe(captured);
  });

  it('truncateForLog bounds long strings and reports the overflow amount', () => {
    const long = 'x'.repeat(600);
    const out = truncateForLog(long, 500);
    expect(out.length).toBeLessThan(600);
    expect(out).toContain('truncated');
    expect(truncateForLog('short')).toBe('short');
  });
});

describe('telemetry — adapter/transaction SQL-error instrumentation', () => {
  let cleanup: () => void;
  let dir: string;

  beforeEach(() => {
    const t = tmpLogDir();
    dir = t.dir;
    cleanup = t.cleanup;
    process.env['SOX_MEMORY_LOG_DIR'] = dir;
    process.env['SOX_MEMORY_LOG_COMPONENT'] = 'sql-test';
    _resetTelemetryForTest();
  });

  afterEach(() => {
    _resetTelemetryForTest();
    delete process.env['SOX_MEMORY_LOG_DIR'];
    delete process.env['SOX_MEMORY_LOG_COMPONENT'];
    cleanup();
  });

  function fakeAdapter(overrides?: Partial<Record<string, unknown>>) {
    const calls: string[] = [];
    return {
      calls,
      async executeGet(sql: string): Promise<unknown> {
        calls.push('executeGet');
        if (sql.includes('BOOM')) throw new Error('SQLITE_ERROR: near "BOOM": syntax error');
        return { ok: true };
      },
      async executeAll(): Promise<unknown> {
        calls.push('executeAll');
        return { rows: [] };
      },
      async executeRun(): Promise<unknown> {
        calls.push('executeRun');
        return { rowsAffected: 1 };
      },
      async exec(): Promise<void> {
        calls.push('exec');
      },
      config: { type: 'sqlite' as const },
      capabilities: {},
      async close(): Promise<void> {},
      unwrap(): unknown {
        return null;
      },
      async transaction<T>(fn: (tx: unknown) => T | Promise<T>): Promise<T> {
        return fn(this);
      },
      ...overrides,
    };
  }

  it('logs a store.error with SQL + adapter_type on failure and re-throws unchanged', async () => {
    const adapter = fakeAdapter();
    const instrumented = instrumentQueryMethods(adapter, 'sqlite');
    await expect(instrumented.executeGet('SELECT * FROM BOOM')).rejects.toThrow('SQLITE_ERROR');
    await _flushTelemetryForTest();
    const rec = readLines(currentLogFilePath())[0]!;
    expect(rec['event']).toBe('store.error');
    expect(rec['level']).toBe('error');
    expect(rec['method']).toBe('executeGet');
    expect(rec['adapter_type']).toBe('sqlite');
    expect(rec['sql']).toContain('BOOM');
  });

  it('is a pure passthrough on success — no log line, same return value', async () => {
    const adapter = fakeAdapter();
    const instrumented = instrumentQueryMethods(adapter, 'sqlite');
    const result = await instrumented.executeGet('SELECT 1');
    expect(result).toEqual({ ok: true });
    await _flushTelemetryForTest();
    expect(readLines(currentLogFilePath())).toHaveLength(0);
  });

  it('preserves `this` binding for unwrapped methods (no state corruption)', async () => {
    const adapter = fakeAdapter();
    const instrumented = instrumentQueryMethods(adapter, 'sqlite') as unknown as {
      close(): Promise<void>;
      unwrap(): unknown;
      config: { type: string };
    };
    await expect(instrumented.close()).resolves.toBeUndefined();
    expect(instrumented.config.type).toBe('sqlite');
  });

  it('instrumentAdapter also instruments the tx object handed to transaction()', async () => {
    const adapter = fakeAdapter();
    const instrumented = instrumentAdapter(
      adapter as unknown as { transaction<T>(fn: (tx: typeof adapter) => T | Promise<T>): Promise<T> } & typeof adapter,
      'turso',
    );
    await expect(
      instrumented.transaction(async (tx) => {
        await tx.executeGet('SELECT * FROM BOOM');
      }),
    ).rejects.toThrow('SQLITE_ERROR');
    await _flushTelemetryForTest();
    const rec = readLines(currentLogFilePath())[0]!;
    expect(rec['event']).toBe('store.error');
    expect(rec['adapter_type']).toBe('turso');
  });

  it(
    "BUG-001: instrumentAdapter's transaction wrapper survives a caller monkeypatching " +
      '.transaction on the returned Proxy after first reading it off (does not recurse)',
    async () => {
      const adapter = fakeAdapter();
      const instrumented = instrumentAdapter(
        adapter as unknown as { transaction<T>(fn: (tx: typeof adapter) => T | Promise<T>): Promise<T> } & typeof adapter,
        'turso',
      );
      // Mirror bug-memory-001-write-loss-ac3.spec.ts's injectPeriodicLockFault exactly: capture
      // `.transaction` off the INSTRUMENTED (proxied) adapter, then monkeypatch `.transaction`
      // on that same proxied reference — the pattern that reproduced BUG-001 in the full AC3 suite.
      const original = instrumented.transaction.bind(instrumented);
      let calls = 0;
      (instrumented as unknown as { transaction: typeof instrumented.transaction }).transaction = ((
        fn,
        opts,
      ) => {
        calls++;
        return original(fn, opts); // must NOT recurse back into this same patched function
      }) as typeof instrumented.transaction;

      await expect(instrumented.transaction(async () => 'ok')).resolves.toBe('ok');
      expect(calls).toBe(1);
    },
  );
});
