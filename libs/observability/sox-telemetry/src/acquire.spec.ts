/**
 * acquire.spec.ts — 621a11c5 AC2: idempotent single-owner, ref-counted
 * telemetry acquisition.
 *
 * Everything here runs the REAL stack: a real `BasicTracerProvider`, the real
 * `JsonlSpanProcessor` writing to a real temp directory, and the real OTel API
 * global registry. The only instrument is a spy on
 * `trace.setGlobalTracerProvider` — the OTel API boundary, not the code under
 * test — used to count provider registrations.
 *
 * The "single registration" assertion lives in ONE helper
 * ({@link assertSingleRegistration}). The negative control feeds that SAME
 * helper the observations from two raw `initTelemetry` calls and requires it to
 * throw, proving the assertion has teeth: bypass the guard and it goes red.
 *
 * Deterministic by construction: no sleeps. Every wait is an awaited promise
 * (`otelReady()`, `release()`), and the sink is `durable` (sync writes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _initTelemetryOwned } from './runtime.js';
import {
  _activeLeaseCountForTest,
  _resetTelemetryForTest,
  acquireTelemetry,
  initTelemetry,
  otelReady,
  withSpan,
  type TelemetryLease,
} from './index.js';

type TelemetryModule = typeof import('./index.js');

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-acquire-'));
  dirs.push(d);
  return d;
}

interface Rec {
  event: string;
  service?: string;
  span_id?: string;
}

/** Every JSONL record in `dir`'s top-level files (the event stream). */
function records(dir: string): Rec[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .flatMap((e) =>
      fs
        .readFileSync(path.join(dir, e.name), 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Rec),
    );
}

const delegateName = (): string =>
  (trace.getTracerProvider() as unknown as { getDelegate(): object }).getDelegate().constructor.name;
const delegateOf = (): object => (trace.getTracerProvider() as unknown as { getDelegate(): object }).getDelegate();

/** Counts SUCCESSFUL global tracer-provider registrations at the OTel API boundary. */
function watchRegistrations(): { count: () => number } {
  const spy = vi.spyOn(trace, 'setGlobalTracerProvider');
  return { count: () => spy.mock.results.filter((r) => r.type === 'return' && r.value === true).length };
}

/** THE single-provider assertion — shared by the guarded tests and the negative control. */
function assertSingleRegistration(observed: { registrations: number; distinctProviders: number }): void {
  expect(observed.registrations).toBe(1);
  expect(observed.distinctProviders).toBe(1);
}

/** Records with this exact event name. */
const count = (dir: string, event: string): number => records(dir).filter((r) => r.event === event).length;

let open: TelemetryLease[] = [];
beforeEach(() => {
  open = [];
  trace.disable();
});
afterEach(async () => {
  await Promise.all(open.map((l) => l.release()));
  vi.restoreAllMocks();
  _resetTelemetryForTest();
  trace.disable();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function acquire(dir: string, over: Partial<Parameters<typeof acquireTelemetry>[0]> = {}): TelemetryLease {
  const lease = acquireTelemetry({
    service: 'acq',
    role: 'test',
    logDir: dir,
    otel: true,
    snapshotEveryMs: 0,
    snapshotEveryRecords: 0,
    ...over,
  });
  open.push(lease);
  return lease;
}

describe('621a11c5 AC2: acquireTelemetry — one provider, ref-counted close', () => {
  it('621a11c5 AC2: two consumers in one process register exactly ONE provider and emit no duplicated spans', async () => {
    const dir = tmp();
    const reg = watchRegistrations();

    const a = acquire(dir);
    const b = acquire(dir);
    await Promise.all([a.otelReady(), b.otelReady()]);
    expect(a.owned).toBe(true);
    expect(b.owned).toBe(false);
    expect(_activeLeaseCountForTest()).toBe(2);
    assertSingleRegistration({ registrations: reg.count(), distinctProviders: new Set([delegateOf()]).size });

    await withSpan('consumer.a.work', {}, async () => 1);
    await withSpan('consumer.b.work', {}, async () => 2);
    await a.flush();

    for (const name of ['consumer.a.work', 'consumer.b.work']) {
      expect(count(dir, `${name}.start`)).toBe(1);
      expect(count(dir, `${name}.finish`)).toBe(1);
    }
    expect(a.currentLogFilePath()).toBe(b.currentLogFilePath());
  });

  it('621a11c5 AC2: the provider closes only when the LAST lease releases', async () => {
    const dir = tmp();
    const a = acquire(dir);
    const b = acquire(dir);
    await a.otelReady();
    expect(delegateName()).toBe('BasicTracerProvider');

    await a.release();
    // b still holds a lease: provider stays registered and third-party spans (via the
    // GLOBAL API, as an auto-instrumentation would emit them) are still recorded.
    expect(_activeLeaseCountForTest()).toBe(1);
    expect(delegateName()).toBe('BasicTracerProvider');
    trace.getTracer('third-party').startSpan('third.party.alive').end();
    expect(count(dir, 'third.party.alive.start')).toBe(1);

    await b.release();
    expect(_activeLeaseCountForTest()).toBe(0);
    expect(delegateName()).toBe('NoopTracerProvider');
  });

  it('621a11c5 AC2: release() is idempotent — a double release cannot decrement twice or close early', async () => {
    const dir = tmp();
    const a = acquire(dir);
    const b = acquire(dir);
    await a.otelReady();

    await a.release();
    await a.release();
    a.close(); // alias; still a no-op for an already-released lease
    expect(_activeLeaseCountForTest()).toBe(1);
    expect(delegateName()).toBe('BasicTracerProvider');

    await b.release();
    expect(delegateName()).toBe('NoopTracerProvider');
  });

  it('621a11c5 AC2: after the last release the next acquire becomes a fresh owner with one new registration', async () => {
    const dir = tmp();
    const reg = watchRegistrations();

    const first = acquire(dir);
    await first.otelReady();
    await first.release();

    const second = acquire(dir);
    await second.otelReady();
    expect(second.owned).toBe(true);
    expect(reg.count()).toBe(2); // one per ownership epoch — never two within one
    expect(delegateName()).toBe('BasicTracerProvider');
  });

  it('621a11c5 AC2: a later acquirer\'s conflicting options are ignored, reported in `conflicts`, and logged', async () => {
    const dir = tmp();
    const a = acquire(dir, { service: 'owner-svc' });
    const b = acquire(dir, { service: 'other-svc' });
    await a.otelReady();

    expect(b.conflicts).toEqual(['service']);
    expect(a.conflicts).toEqual([]);
    expect(b.service).toBe('owner-svc'); // the owner's configuration stands
    await a.flush();
    expect(count(dir, 'telemetry.acquire.config_conflict')).toBe(1);
  });

  it('621a11c5 AC2: a raw initTelemetry between acquires supersedes the owner; the next acquire owns again', async () => {
    const dir = tmp();
    const a = acquire(dir);
    await a.otelReady();

    const raw = initTelemetry({ service: 'raw', role: 'test', logDir: dir, otel: true });
    await otelReady();

    const b = acquire(dir);
    expect(b.owned).toBe(true);
    await b.otelReady();
    // a's lease belongs to the superseded epoch: releasing it must not tear b's provider down.
    await a.release();
    expect(delegateName()).toBe('BasicTracerProvider');
    raw.close();
  });

  it('621a11c5 AC2: two installed copies of the package (vi.resetModules) share one owner and one provider', async () => {
    const dir = tmp();
    const first = (await import('./index.js')) as TelemetryModule;
    const leaseA = first.acquireTelemetry({
      service: 'dup', role: 'test', logDir: dir, otel: true, snapshotEveryMs: 0, snapshotEveryRecords: 0,
    });
    await leaseA.otelReady();
    const providerA = delegateOf();

    vi.resetModules();
    const second = (await import('./index.js')) as TelemetryModule;
    expect(second).not.toBe(first); // control: genuinely a second module instance
    const leaseB = second.acquireTelemetry({
      service: 'dup', role: 'test', logDir: dir, otel: true, snapshotEveryMs: 0, snapshotEveryRecords: 0,
    });
    await leaseB.otelReady();

    expect(leaseB.owned).toBe(false);
    expect(delegateOf()).toBe(providerA);
    await second.withSpan('dup.span', {}, async () => 1);
    await leaseA.flush();
    expect(count(dir, 'dup.span.start')).toBe(1);

    await leaseA.release();
    expect(delegateName()).toBe('BasicTracerProvider'); // B's lease (other copy) still holds it
    await leaseB.release();
    expect(delegateName()).toBe('NoopTracerProvider');
  });
});

describe('621a11c5 AC2: NEGATIVE CONTROL — bypassing the guard makes the same assertion go red', () => {
  it('621a11c5 AC2: two raw initTelemetry calls register TWO providers, so assertSingleRegistration throws', async () => {
    const dir = tmp();
    const reg = watchRegistrations();
    const seen = new Set<object>();

    const h1 = initTelemetry({ service: 'raw1', role: 'test', logDir: dir, otel: true });
    await otelReady();
    seen.add(delegateOf());
    const h2 = initTelemetry({ service: 'raw2', role: 'test', logDir: dir, otel: true });
    await otelReady();
    seen.add(delegateOf());

    const observed = { registrations: reg.count(), distinctProviders: seen.size };
    expect(observed).toEqual({ registrations: 2, distinctProviders: 2 });
    expect(() => assertSingleRegistration(observed)).toThrow();
    h1.close();
    h2.close();
  });

  it('621a11c5 AC2: a stale raw handle\'s close() no longer tears down the superseding configuration (generation guard)', async () => {
    const dir = tmp();
    // `_initTelemetryOwned` is `initTelemetry` plus the awaitable teardown that
    // `handle.close()` floats, so the test can await the close deterministically.
    const hA = _initTelemetryOwned({ service: 'A', role: 'test', logDir: dir, otel: true });
    await otelReady();
    const hB = initTelemetry({ service: 'B', role: 'test', logDir: dir, otel: true });
    await otelReady();
    expect(delegateName()).toBe('BasicTracerProvider');

    await hA.closeAsync(); // A was superseded by B; this must be a no-op for B's state
    expect(delegateName()).toBe('BasicTracerProvider');
    trace.getTracer('third-party').startSpan('third.party.after.stale.close').end();
    expect(count(dir, 'third.party.after.stale.close.start')).toBe(1);
    hB.close();
  });
});
