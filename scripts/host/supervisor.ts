/**
 * scripts/host/supervisor.ts — Host process supervisor.
 *
 * Productized from tools/supervisor-shim.js (was CI-only scaffolding; now product code).
 *
 * Contract (analysis.md row #8 → Defined; audit Gap C1):
 *   Honors the lifecycle{} block from extension manifests:
 *     - background: true  → spawn once, keep alive
 *     - singleton: true   → enforce one process per (entrypoint, key) at a time
 *     - health.type       → probe strategy (socket | stdio-ping | command)
 *     - health.endpoint   → socket path or command (tilde-expanded — Gap A5 fix)
 *     - stop_timeout_ms   → SIGTERM → wait → SIGKILL
 *
 * Transport: child_process.spawn for out-of-process extensions (mcp-server).
 *            In-process adapters (hook, agent, skill, command) do not use the supervisor.
 *
 * Permission recording: the lifecycle{} block is read; the permissions{} block from the
 *   manifest is attached to every SupervisedProcess entry so P5 can enforce sandbox boundaries.
 *   P4 scope: recorded/logged at activation. P5 scope: runtime sandboxing (fs, network, socket).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LifecycleHealth {
  type?: 'stdio-ping' | 'socket' | 'command' | undefined;
  /** Socket path or command string. Tilde-expanded by the supervisor (Gap A5 fix). */
  endpoint?: string | undefined;
  interval_ms?: number | undefined;
  timeout_ms?: number | undefined;
}

export interface LifecycleBlock {
  background?: boolean | undefined;
  singleton?: boolean | undefined;
  health?: LifecycleHealth | undefined;
  stop_timeout_ms?: number | undefined;
}

export interface PermissionsBlock {
  fs?: { read?: string[] | undefined; write?: string[] | undefined } | undefined;
  network?: { outbound?: string[] | undefined } | undefined;
  socket?: { paths?: string[] | undefined } | undefined;
}

export interface SupervisorOptions {
  /** Unique key identifying this supervised extension (typically `id@version`). */
  key: string;
  /** Absolute path to the built entrypoint (must be .js). */
  entrypointPath: string;
  /** CLI args passed to the entrypoint. */
  args?: string[] | undefined;
  /** Environment additions (merged with process.env). */
  env?: Record<string, string> | undefined;
  /** The extension's lifecycle block. */
  lifecycle: LifecycleBlock;
  /** The extension's permissions block — recorded at activation (P4 scope). */
  permissions?: PermissionsBlock | undefined;
  /** Called when the process restarts after an unexpected exit. */
  onRestart?: ((restartCount: number) => void) | undefined;
}

export interface SupervisedProcess {
  key: string;
  entrypointPath: string;
  lifecycle: LifecycleBlock;
  /** Declared permissions — recorded at activation; enforcement is P5 scope. */
  permissions: PermissionsBlock | undefined;
  supervisor: ProcessSupervisor;
}

// ─── Tilde expansion (Gap A5 fix) ────────────────────────────────────────────

/**
 * Expand a leading `~/` to the actual home directory.
 * Node's path module does not do this automatically — raw tilde paths crash connect().
 * This is the fix for Gap A5: `~/.memory/memoryd.sock` in the manifest health endpoint.
 */
export function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// ─── ProcessSupervisor ────────────────────────────────────────────────────────

/**
 * Supervises a single long-running process per the lifecycle{} block.
 *
 * Singleton guarantee: the Supervisor class maintains a global registry —
 * only ONE supervised process per key is permitted at a time.
 * No OS lock files are created (per the R6 requirement from the shim design).
 */
export class ProcessSupervisor {
  private static readonly _registry = new Map<string, ProcessSupervisor>();

  private readonly _key: string;
  private readonly _entrypointPath: string;
  private readonly _args: string[];
  private readonly _env: Record<string, string>;
  private readonly _lifecycle: LifecycleBlock;
  private readonly _onRestart: ((n: number) => void) | undefined;

  private _proc: ChildProcess | null = null;
  private _healthy = false;
  private _stopping = false;
  private _healthTimer: ReturnType<typeof setInterval> | null = null;
  private _restartCount = 0;

  constructor(opts: SupervisorOptions) {
    this._key = opts.key;
    this._entrypointPath = opts.entrypointPath;
    this._args = opts.args ?? [];
    this._env = opts.env ?? {};
    this._lifecycle = opts.lifecycle;
    this._onRestart = opts.onRestart;
  }

  /**
   * Start the supervised process.
   * Enforces singleton: throws if another supervisor is running for this key.
   */
  async start(): Promise<void> {
    if (ProcessSupervisor._registry.has(this._key)) {
      const existing = ProcessSupervisor._registry.get(this._key);
      if (existing !== this && existing?._proc?.exitCode === null) {
        throw new Error(
          `[supervisor] Singleton violation: process already running for key "${this._key}"`,
        );
      }
    }
    ProcessSupervisor._registry.set(this._key, this);
    this._stopping = false;
    await this._spawn();

    const healthCfg = this._lifecycle.health;
    if (healthCfg) {
      const timeout = healthCfg.timeout_ms ?? 5000;
      await this._waitForHealth(timeout);
      this._startHealthLoop(healthCfg.interval_ms ?? 5000);
    }
  }

  /** Graceful stop: SIGTERM → wait stop_timeout_ms → SIGKILL. */
  async stop(): Promise<void> {
    this._stopping = true;
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
    ProcessSupervisor._registry.delete(this._key);

    if (!this._proc || this._proc.exitCode !== null) return;

    const stopTimeoutMs = this._lifecycle.stop_timeout_ms ?? 5000;
    this._proc.kill('SIGTERM');
    const stopped = await this._waitForExit(stopTimeoutMs);
    if (!stopped) {
      console.log(`[supervisor] SIGKILL for "${this._key}" (stop_timeout_ms exceeded)`);
      this._proc.kill('SIGKILL');
      await this._waitForExit(2000);
    }
  }

  /** SIGKILL (for testing / crash simulation). */
  async kill(): Promise<void> {
    if (!this._proc || this._proc.exitCode !== null) return;
    this._proc.kill('SIGKILL');
    await this._waitForExit(2000);
    this._healthy = false;
  }

  /** Restart: kill then re-spawn. */
  async restart(): Promise<void> {
    await this.kill();
    this._stopping = false;
    await sleep(50);
    await this._spawn();
    const healthCfg = this._lifecycle.health;
    if (healthCfg) {
      await this._waitForHealth(healthCfg.timeout_ms ?? 5000);
      this._startHealthLoop(healthCfg.interval_ms ?? 5000);
    }
  }

  isHealthy(): boolean {
    return this._healthy;
  }

  pid(): number | null {
    return this._proc?.pid ?? null;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async _spawn(): Promise<void> {
    this._proc = spawn(process.execPath, [this._entrypointPath, ...this._args], {
      // Use 'pipe' for stdin so that MCP stdio servers (which read from stdin) stay alive.
      // The supervisor does not write to stdin — it holds it open to prevent EOF.
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this._env },
    });

    this._proc.stdout?.on('data', (_d: Buffer) => {
      // Logging hook for P5: forward to structured log
    });
    this._proc.stderr?.on('data', (_d: Buffer) => {
      // Logging hook for P5: forward to structured log
    });

    this._proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this._healthy = false;
      if (!this._stopping) {
        const backoffMs = Math.min(5000, 200 * Math.pow(2, this._restartCount));
        this._restartCount++;
        console.log(
          `[supervisor] "${this._key}" exited (code=${String(code)}, signal=${String(signal)}), ` +
            `restarting in ${backoffMs}ms (attempt ${this._restartCount})`,
        );
        setTimeout(() => {
          void this._respawn();
        }, backoffMs);
      }
    });
  }

  private async _respawn(): Promise<void> {
    if (this._stopping) return;
    await this._spawn();
    const healthCfg = this._lifecycle.health;
    if (healthCfg) {
      try {
        await this._waitForHealth(healthCfg.timeout_ms ?? 5000);
      } catch {
        // Health probe failed — health loop will retry
      }
    }
    if (this._onRestart) this._onRestart(this._restartCount);
  }

  private async _waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this._probeHealth()) {
        this._healthy = true;
        return;
      }
      await sleep(50);
    }
    throw new Error(
      `[supervisor] Health check timed out after ${timeoutMs}ms for "${this._key}"`,
    );
  }

  private async _probeHealth(): Promise<boolean> {
    const healthCfg = this._lifecycle.health;
    if (!healthCfg) return true; // No probe configured — assume healthy

    const type = healthCfg.type ?? 'socket';
    const endpoint = healthCfg.endpoint ? expandTilde(healthCfg.endpoint) : null;
    const timeout = healthCfg.timeout_ms ?? 2000;

    if (type === 'socket' && endpoint) {
      return probeSocket(endpoint, timeout);
    }

    if (type === 'stdio-ping') {
      // P5 refinement: send ping/pong over the process stdio
      // For P4 scope: fall back to checking the process is still alive
      return this._proc !== null && this._proc.exitCode === null;
    }

    if (type === 'command') {
      // P5 refinement: exec a health-check command
      return this._proc !== null && this._proc.exitCode === null;
    }

    return this._proc !== null && this._proc.exitCode === null;
  }

  private _startHealthLoop(intervalMs: number): void {
    if (this._healthTimer) clearInterval(this._healthTimer);
    this._healthTimer = setInterval(() => {
      void this._probeHealth().then((ok) => {
        this._healthy = ok;
      });
    }, intervalMs);
  }

  private _waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this._proc || this._proc.exitCode !== null) {
        resolve(true);
        return;
      }
      let done = false;
      const timer = setTimeout(() => {
        done = true;
        resolve(false);
      }, timeoutMs);
      this._proc.on('exit', () => {
        if (!done) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Probe a Unix socket endpoint: connect → success means alive.
 * Gap A5 fix: the endpoint is already tilde-expanded before passing here.
 */
function probeSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, timeoutMs);
    client.on('connect', () => {
      clearTimeout(timer);
      client.end();
      resolve(true);
    });
    client.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
