/**
 * bl-a621aeac — runEmbedHost() (embedHostMain.ts) calls
 * bootstrapChildTelemetry({ service: 'embed-host', role: 'live-service',
 * logSink: 'file' }) as the composition-root call for this forked process.
 * Without it, this detached child starts with @adhd/sox-telemetry's default
 * module state (service: 'unlabeled', logSink: 'none') and every
 * `fastembed_process.request.*` / `embedding_provider.embed_host.*` record
 * is silently dropped — no error, just missing telemetry.
 *
 * Unit-tests that the call happens, with the right args, unconditionally at
 * the top of runEmbedHost() — before the argv validation (parseEmbedHostArgs)
 * that can short-circuit the rest of the function via process.exit(2).
 * Driving it through the exit path lets this assert the ordering without
 * standing up a real UDS listener (avoids the fork/socket harness other
 * embedHostMain specs need).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const bootstrapChildTelemetry = vi.fn();

vi.mock('@adhd/sox-telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adhd/sox-telemetry')>();
  return {
    ...actual,
    bootstrapChildTelemetry,
  };
});

describe('bl-a621aeac — runEmbedHost() initializes child telemetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    bootstrapChildTelemetry.mockReset();
    vi.resetModules();
  });

  it('calls bootstrapChildTelemetry with service/role/logSink before the bad-args exit', async () => {
    const exitError = new Error('EXIT_2');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw exitError;
    }) as never);

    const { runEmbedHost } = await import('./embedHostMain.js');

    // No argv: parseEmbedHostArgs throws, and the host exits 2 — after telemetry init.
    await expect(runEmbedHost([])).rejects.toThrow(exitError);

    expect(bootstrapChildTelemetry).toHaveBeenCalledTimes(1);
    expect(bootstrapChildTelemetry).toHaveBeenCalledWith({
      service: 'embed-host',
      role: 'live-service',
      logSink: 'file',
    });
    expect(exitSpy).toHaveBeenCalledWith(2);
    // Telemetry init must precede the exit — a fix that guards the call
    // behind the socket check (or drops it) must fail this ordering.
    const telemetryOrder = bootstrapChildTelemetry.mock.invocationCallOrder[0];
    const exitOrder = exitSpy.mock.invocationCallOrder[0];
    expect(telemetryOrder).toBeLessThan(exitOrder as number);
  });
});
