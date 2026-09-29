/**
 * (BL-d509dbe6) Test host for the off-thread watchdog kill path.
 * NOT part of the server — spawned only by
 * mainthread-watchdog-kill.bl-d509dbe6.spec.ts.
 *
 * Usage: node --import tsx mainthread-kill-host.fixture.ts <killAfterMs> <blockMs>
 *
 * Starts the REAL `MainThreadMonitor` with a small typed kill threshold, lets
 * the heartbeat run, then parks the main thread in `Atomics.wait` for
 * `blockMs` — the shape of a native Turso step. If the process is still alive
 * afterwards it prints SURVIVED and exits 0.
 */
import { MainThreadMonitor } from './mainthread-monitor.js';

const killAfterMs = Number(process.argv[2]);
const blockMs = Number(process.argv[3]);
const monitor = new MainThreadMonitor({
  intervalMs: 600_000,
  blockedThresholdMs: 100_000,
  stallThresholdMs: 300,
  killAfterMs,
});
monitor.start();
// Keep the loop alive until the block starts (the monitor's timers are unref'd).
const keepAlive = setInterval(() => undefined, 1_000);
setTimeout(() => {
  process.stdout.write(`BLOCKING pid=${process.pid}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
  clearInterval(keepAlive);
  process.stdout.write('SURVIVED\n');
  void monitor.stop().then(() => process.exit(0));
}, 400);
