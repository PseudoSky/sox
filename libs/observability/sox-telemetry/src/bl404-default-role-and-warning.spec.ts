/**
 * bl404-default-role-and-warning.spec.ts — BL-404 acceptance for runtime.ts's
 * two independent defects found alongside the memory-server composition-root
 * gap (see `extensions/bundles/sox-memory-bundle/members/memory-server/src/
 * bl404-telemetry-composition-root.spec.ts` for the composition-root fix
 * itself):
 *
 *   1. `defaultRole()` had three branches that ALL returned `'test'` — the two
 *      env probes (`NODE_ENV==='test'`, `VITEST_WORKER_ID !== undefined`) were
 *      dead code that made the function READ as environment-detecting while
 *      being a hardcoded constant. This is exactly how a live production
 *      process (never under NODE_ENV=test, never a Vitest worker) ended up
 *      reporting `role:'test'` without anyone noticing on inspection.
 *
 *   2. The uninitialised fallback state was silent — no error, no warning —
 *      which is precisely how it shipped unnoticed. The first emission made
 *      while `initTelemetry()` has never been called now prints a one-shot
 *      stderr warning.
 *
 * `VITEST_WORKER_ID` is set by vitest itself for the whole test process, so
 * every test here explicitly saves/deletes/restores both env vars rather than
 * relying on the ambient test environment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetTelemetryForTest, currentRuntimeState, log } from './index.js';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('BL-404: defaultRole() genuinely detects its environment', () => {
  afterEach(() => {
    _resetTelemetryForTest();
  });

  it('NODE_ENV=test → role "test"', () => {
    withEnv({ NODE_ENV: 'test', VITEST_WORKER_ID: undefined }, () => {
      _resetTelemetryForTest();
      expect(currentRuntimeState().role).toBe('test');
    });
  });

  it('VITEST_WORKER_ID set → role "test"', () => {
    withEnv({ NODE_ENV: undefined, VITEST_WORKER_ID: '3' }, () => {
      _resetTelemetryForTest();
      expect(currentRuntimeState().role).toBe('test');
    });
  });

  it(
    'neither env probe set → role "harness", NOT "test" ' +
      '(THE regression: before BL-404 all three branches returned \'test\' ' +
      'unconditionally — a live production process, matching neither probe, ' +
      'still got labelled \'test\')',
    () => {
      withEnv({ NODE_ENV: undefined, VITEST_WORKER_ID: undefined }, () => {
        _resetTelemetryForTest();
        expect(currentRuntimeState().role).toBe('harness');
      });
    },
  );
});

describe('BL-404: one-shot stderr warning on first emission while uninitialised', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetTelemetryForTest();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    _resetTelemetryForTest();
  });

  it('warns exactly once, to stderr (never stdout), the first time log.* is called with no initTelemetry()', () => {
    log.info('first_call_while_unlabeled', {});
    log.warn('second_call_while_unlabeled', {});
    log.error('third_call_while_unlabeled', {});

    const warnings = stderrSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((line: string) => line.includes('WARNING') && line.includes('initTelemetry'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('BL-404');
  });

  it('does NOT warn once a real service has been initialised via initTelemetry()', async () => {
    const { initTelemetry } = await import('./index.js');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl404-nowarn-'));
    try {
      initTelemetry({ service: 'memory-server', role: 'live-service', logDir: dir });
      log.info('should_not_warn', {});
      const warnings = stderrSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((line: string) => line.includes('WARNING') && line.includes('initTelemetry'));
      expect(warnings).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
