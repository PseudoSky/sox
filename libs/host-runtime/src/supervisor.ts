/**
 * libs/host-runtime/src/supervisor.ts — Host process supervisor.
 *
 * Ported from scripts/host/supervisor.ts.
 * [def:session-fixes] enable-reactivation + stop-via-supervisor carried forward:
 *   - supervisor.stop() sets _stopping=true preventing restarts (stop-via-supervisor)
 *   - supervisor restart logic (enable-reactivation via _respawn on unexpected exit)
 *   - expandTilde (Gap A5 fix)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';

export interface LifecycleHealth {
  type?: 'stdio-ping' | 'socket' | 'command' | undefined;
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
  key: string;
  entrypointPath: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  lifecycle: LifecycleBlock;
  permissions?: PermissionsBlock | undefined;
  onRestart?: ((restartCount: number) => void) | undefined;
}

export interface SupervisedProcess {
  key: string;
  entrypointPath: string;
  lifecycle: LifecycleBlock;
  permissions: PermissionsBlock | undefined;
  supervisor: ProcessSupervisor;
}

/**
 * expandTilde — Gap A5 fix [def:session-fixes].
 * Expand ~/path to the actual home directory.
 */
export function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

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

  /**
   * stop — [def:session-fixes] stop-via-supervisor.
   * Sets _stopping=true → prevents restart loop on exit.
   */
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

  async kill(): Promise<void> {
    if (!this._proc || this._proc.exitCode !== null) return;
    this._proc.kill('SIGKILL');
    await this._waitForExit(2000);
    this._healthy = false;
  }

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

  private async _spawn(): Promise<void> {
    this._proc = spawn(process.execPath, [this._entrypointPath, ...this._args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this._env },
    });

    this._proc.stdout?.on('data', (_d: Buffer) => {
      // P5 logging hook
    });
    this._proc.stderr?.on('data', (_d: Buffer) => {
      // P5 logging hook
    });

    this._proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this._healthy = false;
      if (!this._stopping) {
        // [def:session-fixes] enable-reactivation: restart on unexpected exit
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
    if (!healthCfg) return true;

    const type = healthCfg.type ?? 'socket';
    const endpoint = healthCfg.endpoint ? expandTilde(healthCfg.endpoint) : null;
    const timeout = healthCfg.timeout_ms ?? 2000;

    if (type === 'socket' && endpoint) {
      return probeSocket(endpoint, timeout);
    }

    if (type === 'stdio-ping') {
      return this._proc !== null && this._proc.exitCode === null;
    }

    if (type === 'command') {
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
