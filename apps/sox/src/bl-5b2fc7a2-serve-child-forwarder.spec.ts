/**
 * bl-5b2fc7a2-serve-child-forwarder.spec.ts
 *
 * Fast, no-subprocess unit coverage for `createServeChildSignalForwarder`
 * (apps/sox/src/serve-shutdown.ts), the piece `cmdServe`'s no-proxy log-tee
 * branch wires up to fix BL 5b2fc7a2-8a94-4c7a-a769-cd90b03e69d1. The
 * end-to-end reproduction (real process, real SIGTERM, real grandchild) lives
 * in bl-5b2fc7a2-serve-noproxy-signal-forward.spec.ts; this covers the
 * escalation-shape edge cases that are impractical to hit reliably with a
 * real timing-sensitive subprocess.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServeChildSignalForwarder, type ServeChildLike } from './serve-shutdown.js';

class FakeChild extends EventEmitter implements ServeChildLike {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal);
    return true;
  }

  /** Simulate the OS process actually exiting in response to a signal. */
  simulateExit(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.exitCode = null;
    this.emit('exit');
  }

  override off(event: 'exit', listener: () => void): this {
    return this.removeListener(event, listener);
  }
}

describe('createServeChildSignalForwarder — BL 5b2fc7a2', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards the received signal to the child immediately', () => {
    const child = new FakeChild();
    const { forward } = createServeChildSignalForwarder(child, { graceMs: 1000 });

    forward('SIGTERM');

    expect(child.killed).toEqual(['SIGTERM']);
  });

  it('does not escalate to SIGKILL if the child exits within the grace period', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { forward } = createServeChildSignalForwarder(child, { graceMs: 1000 });

    forward('SIGTERM');
    child.simulateExit('SIGTERM');
    vi.advanceTimersByTime(5000);

    expect(child.killed).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL if the child survives past the grace period', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { forward } = createServeChildSignalForwarder(child, { graceMs: 1000 });

    forward('SIGTERM');
    // Child never exits.
    vi.advanceTimersByTime(1000);

    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('is idempotent — a second signal while forwarding is in flight is a no-op', () => {
    const child = new FakeChild();
    const { forward } = createServeChildSignalForwarder(child, { graceMs: 1000 });

    forward('SIGTERM');
    forward('SIGINT');
    forward('SIGHUP');

    expect(child.killed).toEqual(['SIGTERM']);
  });

  it('does nothing if the child has no pid (never actually spawned)', () => {
    const child = new FakeChild();
    child.pid = undefined;
    const { forward } = createServeChildSignalForwarder(child, { graceMs: 1000 });

    forward('SIGTERM');

    expect(child.killed).toEqual([]);
  });

  it('dispose() clears a pending escalation timer', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { forward, dispose } = createServeChildSignalForwarder(child, { graceMs: 1000 });

    forward('SIGTERM');
    dispose();
    vi.advanceTimersByTime(5000);

    expect(child.killed).toEqual(['SIGTERM']);
  });

  it('dispose() removes the exit listener forward() registered', () => {
    const child = new FakeChild();
    const { forward, dispose } = createServeChildSignalForwarder(child, { graceMs: 1000 });

    forward('SIGTERM');
    expect(child.listenerCount('exit')).toBe(1);

    dispose();

    expect(child.listenerCount('exit')).toBe(0);
    // And a subsequent real exit doesn't throw / do anything surprising.
    expect(() => child.simulateExit('SIGTERM')).not.toThrow();
  });

  it(
    'logs a CRITICAL diagnostic naming the pid if the child is still alive after SIGKILL (undead path)',
    () => {
      vi.useFakeTimers();
      const child = new FakeChild();
      const logs: string[] = [];
      const { forward } = createServeChildSignalForwarder(child, {
        graceMs: 1000,
        killWaitMs: 500,
        pollMs: 100,
        log: (m) => logs.push(m),
      });

      forward('SIGTERM');
      // Grace elapses with no exit -> SIGKILL fires.
      vi.advanceTimersByTime(1000);
      expect(child.killed).toEqual(['SIGTERM', 'SIGKILL']);

      // Child NEVER reports exit (D-state / EPERM analogue) — advance past
      // the killWaitMs verification window.
      vi.advanceTimersByTime(500);

      expect(logs.some((m) => m.includes('CRITICAL') && m.includes('still alive after SIGKILL') && m.includes('4242'))).toBe(true);
    },
  );

  it('does NOT log CRITICAL if the child dies shortly after SIGKILL', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const logs: string[] = [];
    const { forward } = createServeChildSignalForwarder(child, {
      graceMs: 1000,
      killWaitMs: 500,
      pollMs: 100,
      log: (m) => logs.push(m),
    });

    forward('SIGTERM');
    vi.advanceTimersByTime(1000);
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL']);

    // Child dies partway through the verification window.
    vi.advanceTimersByTime(200);
    child.simulateExit('SIGKILL');
    vi.advanceTimersByTime(500);

    expect(logs.some((m) => m.includes('CRITICAL'))).toBe(false);
  });
});
