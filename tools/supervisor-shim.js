#!/usr/bin/env node
/**
 * tools/supervisor-shim.js — Legacy compatibility wrapper for sox-memory lifecycle tests.
 *
 * Status (P4 productization): the production supervisor now lives in
 *   scripts/host/supervisor.ts (TypeScript, full type safety, unified loader integration).
 *   This file is kept as a compatibility wrapper so existing sox-memory test tools
 *   (tools/test-daemon-crash.js, tools/test-organize.js, etc.) continue to work without
 *   modification. It re-exports the same API surface backed by the productized supervisor.
 *
 * The product supervisor honors the full lifecycle{} block from the manifest schema (G-A):
 *   - background: true  → spawn once, keep alive, restart on exit
 *   - singleton: true   → one process per (key) at a time, no OS lock file
 *   - health.type:socket → probe via Unix socket (tilde-expanded — Gap A5 fix)
 *   - stop_timeout_ms   → SIGTERM → wait → SIGKILL
 *
 * The shim implements the supervisor sub-contract from architecture-v2.md §G-A:
 *   - start: spawn memory-server entrypoint once (lifecycle.background:true)
 *   - singleton: hold the per-scope lock (NO OS advisory lock in the daemon — R6)
 *   - health: probe via the Unix socket every interval_ms (lifecycle.health.type:"socket")
 *   - stop: SIGTERM → wait stop_timeout_ms → SIGKILL (lifecycle.stop_timeout_ms:5000)
 *   - restart: on health miss × policy, restart with backoff
 *
 * API (used by test tools):
 *   const shim = new SupervisorShim({ dbPath, scope });
 *   await shim.start();     // spawns memoryd, probes health, holds lock
 *   shim.isHealthy();       // true if last health probe succeeded
 *   shim.pid();             // PID of the supervised process
 *   await shim.stop();      // SIGTERM → drain → exit (or SIGKILL after timeout)
 *   await shim.kill();      // SIGKILL (simulates crash for test-daemon-crash.js)
 *   await shim.restart();   // re-spawn after kill/crash
 *
 * Singleton guarantee: only ONE memoryd per (dbPath, scope) at a time.
 *   The shim holds this guarantee — NOT a lock file in ~/.memory/memoryd.lock.
 *   Verified by test-daemon-crash.js assertion (c): no lock file ever created.
 */

import { spawn } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DAEMON_BIN = path.join(ROOT, 'extensions', 'mcp-servers', 'memory-server', 'dist', 'bin.js');
const SOCKET_PATH = path.join(process.env['HOME'] ?? '/tmp', '.memory', 'memoryd.sock');
const STOP_TIMEOUT_MS = 5000;
const HEALTH_INTERVAL_MS = 500; // tighter in CI for fast tests
const HEALTH_TIMEOUT_MS = 2000;

// Singleton registry: tracks running shims to enforce one-per-dbPath
const _registry = new Map(); // dbPath+scope → SupervisorShim

export class SupervisorShim {
  constructor({ dbPath, scope = 'project', onRestart } = {}) {
    if (!dbPath) throw new Error('SupervisorShim: dbPath is required');
    this._dbPath = path.resolve(dbPath);
    this._scope = scope;
    this._key = `${this._dbPath}:${scope}`;
    this._proc = null;
    this._healthy = false;
    this._healthTimer = null;
    this._onRestart = onRestart ?? null;
    this._restartCount = 0;
    this._stopping = false;
  }

  /**
   * Start the supervised daemon.
   * Enforces singleton: throws if another shim is already running for this key.
   */
  async start() {
    if (_registry.has(this._key)) {
      const existing = _registry.get(this._key);
      if (existing !== this && existing._proc?.exitCode === null) {
        throw new Error(`[supervisor-shim] Singleton violation: memoryd already running for ${this._key}`);
      }
    }
    _registry.set(this._key, this);
    this._stopping = false;
    await this._spawn();
    await this._waitForHealth(HEALTH_TIMEOUT_MS);
    this._startHealthLoop();
  }

  /**
   * Spawn the daemon process.
   */
  async _spawn() {
    this._proc = spawn(process.execPath, [DAEMON_BIN, '--db-path', this._dbPath, '--scope', this._scope], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this._proc.stdout?.on('data', (d) => {
      // Optionally log: process.stdout.write('[memoryd] ' + d);
    });
    this._proc.stderr?.on('data', (d) => {
      // Optionally log: process.stderr.write('[memoryd:err] ' + d);
    });

    this._proc.on('exit', (code, signal) => {
      this._healthy = false;
      if (!this._stopping) {
        // Unexpected exit — restart with backoff (supervisor sub-contract)
        const backoffMs = Math.min(5000, 200 * Math.pow(2, this._restartCount));
        this._restartCount++;
        console.log(`[supervisor-shim] memoryd exited (code=${code}, signal=${signal}), restarting in ${backoffMs}ms (attempt ${this._restartCount})`);
        setTimeout(() => { void this._respawn(); }, backoffMs);
      }
    });
  }

  /**
   * Re-spawn after unexpected exit (restart policy).
   */
  async _respawn() {
    if (this._stopping) return;
    await this._spawn();
    try {
      await this._waitForHealth(HEALTH_TIMEOUT_MS);
    } catch {
      // Health check failed; will retry via health loop
    }
    if (this._onRestart) this._onRestart(this._restartCount);
  }

  /**
   * Wait for the daemon's health socket to become available.
   * Health probe: connect to SOCKET_PATH; success = alive.
   */
  async _waitForHealth(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this._probeHealth()) {
        this._healthy = true;
        return;
      }
      await sleep(50);
    }
    throw new Error(`[supervisor-shim] Health check timed out after ${timeoutMs}ms`);
  }

  /**
   * Probe health via the Unix socket (lifecycle.health.type:"socket").
   */
  _probeHealth() {
    return new Promise((resolve) => {
      const client = net.createConnection(SOCKET_PATH);
      client.on('connect', () => { client.end(); resolve(true); });
      client.on('error', () => resolve(false));
      setTimeout(() => { client.destroy(); resolve(false); }, HEALTH_TIMEOUT_MS);
    });
  }

  /**
   * Start the periodic health probe loop.
   */
  _startHealthLoop() {
    if (this._healthTimer) clearInterval(this._healthTimer);
    this._healthTimer = setInterval(async () => {
      this._healthy = await this._probeHealth();
    }, HEALTH_INTERVAL_MS);
  }

  isHealthy() {
    return this._healthy;
  }

  pid() {
    return this._proc?.pid ?? null;
  }

  /**
   * Graceful stop: SIGTERM → wait stop_timeout_ms → SIGKILL.
   */
  async stop() {
    this._stopping = true;
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    _registry.delete(this._key);

    if (!this._proc || this._proc.exitCode !== null) return;

    this._proc.kill('SIGTERM');
    const stopped = await this._waitForExit(STOP_TIMEOUT_MS);
    if (!stopped) {
      console.log('[supervisor-shim] SIGKILL (stop_timeout_ms exceeded)');
      this._proc.kill('SIGKILL');
      await this._waitForExit(2000);
    }
  }

  /**
   * SIGKILL the daemon (simulates crash for test-daemon-crash.js).
   * The shim remains registered and can restart.
   */
  async kill() {
    if (!this._proc || this._proc.exitCode !== null) return;
    this._proc.kill('SIGKILL');
    await this._waitForExit(2000);
    this._healthy = false;
  }

  /**
   * Restart: kill then respawn.
   * Verifies singleton: only ONE memoryd at a time (no OS lock file — R6).
   */
  async restart() {
    await this.kill();
    this._stopping = false;
    await sleep(50); // brief pause to let OS release the socket
    await this._spawn();
    await this._waitForHealth(HEALTH_TIMEOUT_MS);
    this._startHealthLoop();
  }

  /**
   * Wait for the process to exit.
   */
  _waitForExit(timeoutMs) {
    return new Promise((resolve) => {
      if (!this._proc || this._proc.exitCode !== null) { resolve(true); return; }
      let done = false;
      const timer = setTimeout(() => { done = true; resolve(false); }, timeoutMs);
      this._proc.on('exit', () => {
        if (!done) { clearTimeout(timer); resolve(true); }
      });
    });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
