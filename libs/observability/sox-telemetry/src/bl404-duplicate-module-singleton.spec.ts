/**
 * bl404-duplicate-module-singleton.spec.ts — BL-404 acceptance for the
 * DUPLICATE-MODULE half of the defect (the role/warning half is covered by
 * `bl404-default-role-and-warning.spec.ts`).
 *
 * The live defect: `@adhd/sox-telemetry` was installed twice in one process —
 * a top-level copy whose `initTelemetry()` the composition root called, and a
 * nested copy under a dependency's own `node_modules`, through which that
 * dependency's records routed. Module-level `let` state meant the two copies
 * were strangers: the nested copy's first emission saw its OWN
 * `service:'unlabeled'` fallback and printed the BL-404 "no initTelemetry()"
 * warning, which no amount of initialising the top-level copy could silence.
 *
 * The fix (ADR-0018) keys ALL mutable runtime state on
 * `globalThis[Symbol.for('@adhd/sox-telemetry.runtime.v1')]`, so every module
 * instance in a realm resolves to ONE shared runtime object.
 *
 * This test simulates the second installed copy the only honest way available
 * in-process: `vi.resetModules()` clears the module registry, so the fresh
 * dynamic `import()` below is a genuinely NEW evaluation of the module (a
 * second `TelemetryRuntime`-owning module instance), while `globalThis` — and
 * therefore the `Symbol.for` slot — is shared. It asserts the second instance
 * READS the first's state rather than re-creating it, and that it does NOT
 * emit the BL-404 warning.
 *
 * A note on `Symbol.for`: the negative control for this test (see the commit
 * message / report) swaps `Symbol.for(...)` for an unregistered `Symbol(...)`,
 * which makes each module instance mint its own key — exactly the pre-fix
 * per-module shape. Under that variant both assertions below go RED.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type TelemetryModule = typeof import('./index.js');

/** Fresh module instance of the package under test (a "second installed copy"). */
async function freshModuleInstance(): Promise<TelemetryModule> {
  vi.resetModules();
  return (await import('./index.js')) as TelemetryModule;
}

function bl404Warnings(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((line: string) => line.includes('WARNING') && line.includes('initTelemetry'));
}

describe('BL-404 duplicate-module hazard — one shared globalThis runtime per realm', () => {
  let dir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl404-dupmod-'));
  });

  afterEach(async () => {
    stderrSpy?.mockRestore();
    stderrSpy = undefined;
    // Reset through whatever instance the registry now holds — the slot is
    // process-global, so this resets the ONE runtime every instance sees.
    const current = (await import('./index.js')) as TelemetryModule;
    current._resetTelemetryForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a second module instance READS the first instance\'s initTelemetry state and emits no BL-404 warning', async () => {
    const first = (await import('./index.js')) as TelemetryModule;
    first._resetTelemetryForTest();

    // The composition root initialises through the FIRST installed copy.
    const handle = first.initTelemetry({ service: 'svc-A', role: 'test', logSink: 'file', logDir: dir });
    expect(first.currentRuntimeState().service).toBe('svc-A');

    // Load the SECOND copy. `expect(second).not.toBe(first)` is the control
    // that proves this really is a distinct module instance and not the
    // registry handing back the cached one — without it, the assertions below
    // would pass vacuously.
    const second = await freshModuleInstance();
    expect(second).not.toBe(first);

    // THE REGRESSION: the second copy resolves the SAME shared slot, so it
    // sees the first copy's initialised state instead of its own fresh
    // `service:'unlabeled'` default.
    expect(second.currentRuntimeState().service).toBe('svc-A');
    expect(second.currentRuntimeState().role).toBe('test');

    // …and therefore its first emission does NOT trip the BL-404 warning.
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    second.log.info('emitted_from_second_instance', {});

    expect(bl404Warnings(stderrSpy)).toHaveLength(0);

    // The record the SECOND instance emitted landed in the SAME sink the
    // FIRST instance configured — proving the shared object, not merely a
    // shared latch.
    await handle.flush();
    const filePath = handle.currentLogFilePath();
    expect(filePath).not.toBeNull();
    const events = fs
      .readFileSync(filePath as string, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.some((r) => r['event'] === 'emitted_from_second_instance')).toBe(true);
  });

  it('the _warnedUnlabeled latch is shared across instances: the warning fires once per REALM, not once per module copy', async () => {
    const first = (await import('./index.js')) as TelemetryModule;
    first._resetTelemetryForTest();

    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // First copy emits while uninitialised -> exactly one BL-404 warning.
    first.log.info('first_unlabeled_emission', {});
    expect(bl404Warnings(stderrSpy)).toHaveLength(1);

    const second = await freshModuleInstance();
    expect(second).not.toBe(first);

    // Second copy emits while uninitialised -> the SHARED latch suppresses a
    // second warning. Pre-fix (per-module latch) this would be 2.
    second.log.info('second_unlabeled_emission', {});
    expect(bl404Warnings(stderrSpy)).toHaveLength(1);
  });
});
