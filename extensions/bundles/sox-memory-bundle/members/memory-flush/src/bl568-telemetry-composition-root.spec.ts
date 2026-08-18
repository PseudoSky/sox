/**
 * bl568-telemetry-composition-root.spec.ts — BL-568 acceptance.
 *
 * BEFORE this fix: `extensions/bundles/sox-memory-bundle/members/memory-flush/
 * src/index.ts` never called `initTelemetry()` at all — a repo-wide grep for
 * `initTelemetry(` found exactly two production call sites (memory-server,
 * fastembedProcessHost's forked child) and memory-flush was not one of them.
 * Every `@adhd/sox-telemetry` `log.*` call reachable from `handleSessionEnd`/
 * `handleScopePromotionProposed` — via `memCoreOpenDb` into store-adapter's
 * retry/preflight/engine-marker instrumentation, the identical code path
 * memory-server and memory-cli both go through — ran on the module-level
 * fallback (`service:'unlabeled'`, `logSink:'none'`) and was silently
 * dropped, the same root cause as BL-404.
 *
 * This spec proves, white-box (memory-flush is loaded IN-PROCESS by the host
 * runtime's hook adapter via a plain `import()` — never `require.main ===
 * module` — so there is no separate real-process entrypoint to black-box spawn
 * the way BL-404's memory-server spec does):
 *
 *   1. Fresh-loading `./index.js` while telemetry is in its uninitialised
 *      fallback state (`service:'unlabeled'`) causes the module's own
 *      composition-root guard to fire and claim it —
 *      `currentRuntimeState().service` becomes `'memory-flush'`.
 *   2. The exact options object the module passes to `initTelemetry()` —
 *      `MEMORY_FLUSH_TELEMETRY_INIT_OPTIONS`, exported from `index.ts` so this
 *      test asserts against the SAME object the composition root uses, not a
 *      copy that could drift — is shaped `service:'memory-flush'`,
 *      `logSink:'file'`.
 *   3. A `log.*` call made after that fresh load durably lands a JSONL record
 *      on disk carrying `service:'memory-flush'`.
 *   4. The guard is NOT a clobber: fresh-loading `./index.js` while telemetry
 *      has ALREADY been claimed by something else in the same process (the
 *      normal case — `vitest.setup.ts` claims it as `service:'sox-tests'`
 *      before any spec file's first import, exactly as production's host
 *      process may have another extension claim it first) leaves that
 *      existing claim untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  currentRuntimeState,
  initTelemetry,
  log,
  _resetTelemetryForTest,
} from '@adhd/sox-telemetry';

describe('BL-568: memory-flush telemetry composition root', () => {
  afterEach(() => {
    _resetTelemetryForTest();
    vi.resetModules();
  });

  describe('white-box: fresh-loaded from the uninitialised fallback state', () => {
    beforeEach(() => {
      // Force the exact starting condition the real defect shipped under:
      // nothing in this process has ever called initTelemetry().
      _resetTelemetryForTest();
      vi.resetModules();
    });

    it('claims telemetry as service:"memory-flush" on first load', async () => {
      expect(currentRuntimeState().service).toBe('unlabeled');

      const mod = await import('./index.js');

      // THE regression: before BL-568, this stayed 'unlabeled' forever — no
      // production call site anywhere in memory-flush ever called
      // initTelemetry(), so every store-adapter emission reachable from this
      // module ran on the logSink:'none' fallback and was silently dropped.
      expect(currentRuntimeState().service).toBe('memory-flush');
      expect(mod.MEMORY_FLUSH_TELEMETRY_INIT_OPTIONS).toEqual({
        service: 'memory-flush',
        role: 'cli',
        logSink: 'file',
      });
    });

    it('durably persists a service:"memory-flush" JSONL record after fresh load', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl568-whitebox-'));
      try {
        // Re-init with a scratch logDir so this test's record doesn't land in
        // the real ~/.adhd/sox-ecosystem/memory-flush/logs/ that the module's
        // own default-path initTelemetry() call already claimed a moment ago.
        const mod = await import('./index.js');
        const handle = initTelemetry({ ...mod.MEMORY_FLUSH_TELEMETRY_INIT_OPTIONS, logDir: dir });
        expect(currentRuntimeState().service).toBe('memory-flush');

        log.info('bl568_test_event', {});
        handle.close();

        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
        expect(files.length).toBeGreaterThan(0);
        const lines = fs
          .readFileSync(path.join(dir, files[0]!), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        const rec = lines.find((l) => l['event'] === 'bl568_test_event');
        expect(rec).toBeDefined();
        expect(rec!['service']).toBe('memory-flush');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('the guard does not clobber an existing composition root', () => {
    beforeEach(() => {
      _resetTelemetryForTest();
      vi.resetModules();
    });

    it('leaves service unchanged when telemetry was already claimed before load', async () => {
      initTelemetry({ service: 'some-other-extension', role: 'harness', logSink: 'none' });
      expect(currentRuntimeState().service).toBe('some-other-extension');

      await import('./index.js');

      // Not a regression this ticket introduces, but the property the guard
      // exists to protect: a hook module sharing a process with another
      // extension that already claimed telemetry must not silently relabel
      // every subsequent log record under a name that isn't the process's
      // real identity.
      expect(currentRuntimeState().service).toBe('some-other-extension');
    });
  });
});
