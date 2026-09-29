/**
 * BL-d509dbe6 — the off-thread watchdog SIGKILLs a process whose main thread
 * is blocked synchronously.
 *
 * The incident: a 21-minute `PRAGMA integrity_check` held memory-server's main
 * thread; the pending-request liveness watchdog is a `setInterval` on that
 * same thread and could not fire. This spawns a real process running the real
 * `MainThreadMonitor`, parks its main thread in `Atomics.wait` (nothing on the
 * main thread can run — no timer, no signal handler), and requires the process
 * to die by SIGKILL with the raw fd-2 FATAL line, well before the block ends.
 *
 * RED (fix disabled — the watcher is not given `killAfterMs`): the process
 * sits out the whole block and prints SURVIVED.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import {
  DEFAULT_MAINTHREAD_KILL_AFTER_MS,
  MAINTHREAD_KILL_AFTER_CONFIG_ENV,
  MainThreadMonitor,
  resolveMainThreadKillAfterMs,
} from './mainthread-monitor.js';

const HOST = path.join(__dirname, 'mainthread-kill-host.fixture.ts');
const MEMORY_SERVER_ROOT = path.resolve(__dirname, '..');

function runHost(killAfterMs: number, blockMs: number): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  blockedAt: number | null;
  exitedAt: number;
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', HOST, String(killAfterMs), String(blockMs)], {
      cwd: MEMORY_SERVER_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let blockedAt: number | null = null;
    proc.stdout.on('data', (d: Buffer) => {
      stdout += String(d);
      if (blockedAt === null && stdout.includes('BLOCKING')) blockedAt = Date.now();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += String(d);
    });
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr, blockedAt, exitedAt: Date.now() }));
  });
}

describe('BL-d509dbe6 — off-thread watchdog kill path', () => {
  it('(d) SIGKILLs the process while its main thread is blocked in Atomics.wait', async () => {
    const r = await runHost(1_500, 15_000);
    expect(r.stdout, `stderr: ${r.stderr.slice(-1500)}`).toContain('BLOCKING');
    expect(r.stdout).not.toContain('SURVIVED');
    expect(r.signal).toBe('SIGKILL');
    // Raw fd-2 evidence, written by the worker while the main thread was parked.
    const fatal = r.stderr.split('\n').find((l) => l.includes('"event":"mainthread.watchdog_kill"'));
    expect(fatal, r.stderr.slice(-1500)).toBeDefined();
    const rec = JSON.parse(fatal!) as { blocked_for_ms: number; kill_after_ms: number };
    expect(rec.kill_after_ms).toBe(1_500);
    expect(rec.blocked_for_ms).toBeGreaterThanOrEqual(1_500);
    expect(r.stderr).toContain('[memory-server] FATAL: main thread blocked');
    // Killed near the threshold — long before the 15 s block would have ended.
    expect(r.exitedAt - (r.blockedAt ?? r.exitedAt)).toBeLessThan(8_000);
  }, 40_000);

  it('does not fire for a block shorter than the threshold', async () => {
    const r = await runHost(4_000, 800);
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('SURVIVED');
    expect(r.stderr).not.toContain('mainthread.watchdog_kill');
  }, 40_000);

  it('the kill threshold is typed config: default, cascade value, and loud rejection', () => {
    expect(resolveMainThreadKillAfterMs({})).toBe(DEFAULT_MAINTHREAD_KILL_AFTER_MS);
    expect(resolveMainThreadKillAfterMs({ [MAINTHREAD_KILL_AFTER_CONFIG_ENV]: '90000' })).toBe(90_000);
    for (const bad of ['banana', '0', '500', '1.5', '-1', 'off', String(2 * 60 * 60_000)]) {
      expect(() => resolveMainThreadKillAfterMs({ [MAINTHREAD_KILL_AFTER_CONFIG_ENV]: bad }), bad).toThrow();
    }
    expect(() => new MainThreadMonitor({ killAfterMs: 0 })).toThrow(/no value that disables/);
    expect(new MainThreadMonitor({ killAfterMs: 60_000 }).killAfter).toBe(60_000);
  });
});
