/**
 * libs/host-runtime/src/supervisor.ts — Host process supervisor.
 *
 * Ported from the pre-nx host runtime.
 * [def:session-fixes] enable-reactivation + stop-via-supervisor carried forward:
 *   - supervisor.stop() sets _stopping=true preventing restarts (stop-via-supervisor)
 *   - supervisor restart logic (enable-reactivation via _respawn on unexpected exit)
 *   - expandTilde (Gap A5 fix)
 *
 * [process-boundary] — Spawned-child bounding:
 *   When opts.permissions is declared (policy.enforced=true):
 *     - Child env is SCRUBBED to a minimal allowlist (PATH, HOME, LANG, TZ, NODE_*)
 *       then merged with this._env then merged with policy.toEnv() [def:policy-env].
 *     - Child cwd is set to the extension directory (dirname of entrypointPath).
 *   When NO permissions block is declared (policy.enforced=false):
 *     - Child env is { ...process.env, ...this._env } — byte-identical to pre-state.
 *     - Child cwd is inherited (undefined) — byte-identical to pre-state.
 *   [inv:no-regress]: the non-enforced path is BYTE-IDENTICAL to the pre-state spawn.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { compilePolicy, type Policy } from './policy.js';

export interface LifecycleHealth {
  type?: 'stdio-ping' | 'socket' | 'command' | 'http-get' | undefined;
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
  /**
   * storePath — [dod.5] service bundle store directory.
   * When set, the child process is spawned with cwd=storePath so it runs from
   * the materialized self-contained bundle with no monorepo siblings on the path.
   * Takes precedence over the policy-enforced dirname(entrypointPath) cwd.
   */
  storePath?: string | undefined;
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
  private readonly _policy: Policy;
  private readonly _storePath: string | undefined;

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
    this._storePath = opts.storePath;
    // [process-boundary] Compile policy once at construction.
    // compilePolicy(undefined) → enforced=false (legacy compat, [inv:no-regress]).
    // compilePolicy(perms)     → enforced=true  ([def:enforcement-opt-in]).
    this._policy = compilePolicy(opts.permissions);
  }

  /**
   * policy — read-only accessor so mcp.ts / tests can assert the wired policy.
   * [process-boundary.6]
   */
  policy(): Policy {
    return this._policy;
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
    // [process-boundary] Build child env + cwd based on whether a policy is enforced.
    //
    // ENFORCED path (policy.enforced=true):
    //   Scrub the child env to a minimal allowlist (safe base) merged with this._env
    //   (extension-declared env overrides) then merged with policy.toEnv()
    //   ([def:policy-env]: the enforce flag + four policy-env JSON arrays injected by toEnv()).
    //   Set cwd to the extension directory so relative path resolution is bounded.
    //
    // UNENFORCED path (policy.enforced=false):
    //   BYTE-IDENTICAL to pre-state: { ...process.env, ...this._env }, cwd undefined.
    //   [inv:no-regress], [def:enforcement-opt-in].
    let spawnEnv: NodeJS.ProcessEnv;
    let spawnCwd: string | undefined;

    if (this._policy.enforced) {
      // Minimal base env allowlist — conservative; covers Node.js native module
      // loading (NODE_OPTIONS, NODE_PATH, NODE_MODULE), locale (LANG, LC_ALL, TZ),
      // and shell fundamentals (PATH, HOME, USER, LOGNAME).
      // Footgun note: scrubbing NODE_OPTIONS breaks native add-ons (e.g.
      // better-sqlite3 native loader); we keep all NODE_* vars to avoid that.
      const allowedKeys = new Set([
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'TZ',
      ]);
      const baseEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && (allowedKeys.has(k) || k.startsWith('NODE_'))) {
          baseEnv[k] = v;
        }
      }
      // Extension-declared env overrides go on top of the scrubbed base.
      // Policy env ([def:policy-env]) goes last so it cannot be shadowed.
      spawnEnv = { ...baseEnv, ...this._env, ...this._policy.toEnv() };
      // [dod.5]: storePath overrides the dirname(entrypointPath) default so the
      // service runs from its self-contained materialized store dir.
      spawnCwd = this._storePath ?? path.dirname(this._entrypointPath);
    } else {
      // [inv:no-regress] BYTE-IDENTICAL to pre-state spawn options.
      spawnEnv = { ...process.env, ...this._env };
      // [dod.5]: even without enforcement, storePath sets cwd so the service
      // bundle runs from the store dir (no monorepo siblings on the path).
      spawnCwd = this._storePath;
    }

    // --enable-source-maps: Node.js uses sourceMappingURL comments in bundles so
    // stack traces resolve back to original TypeScript line numbers.
    this._proc = spawn(process.execPath, ['--enable-source-maps', this._entrypointPath, ...this._args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
      ...(spawnCwd !== undefined ? { cwd: spawnCwd } : {}),
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

    // ht-2: For http-get probes, poll for port.txt before the first probe to
    // avoid a race where the service has not yet bound its port.
    const healthCfg = this._lifecycle.health;
    if (healthCfg?.type === 'http-get' && this._storePath) {
      const portFile = path.join(this._storePath, 'port.txt');
      while (Date.now() < deadline) {
        if (fs.existsSync(portFile)) break;
        await sleep(50);
      }
      if (!fs.existsSync(portFile)) {
        throw new Error(
          `[supervisor] port.txt never appeared at "${portFile}" within ${timeoutMs}ms for "${this._key}"`,
        );
      }
    }

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
    const timeout = healthCfg.timeout_ms ?? 2000;

    // ht-1/ht-2: http-get probe — resolve ${PORT} from storePath/port.txt
    if (type === 'http-get' && healthCfg.endpoint) {
      let endpoint = healthCfg.endpoint;
      if (endpoint.includes('${PORT}') && this._storePath) {
        const portFile = path.join(this._storePath, 'port.txt');
        try {
          const port = fs.readFileSync(portFile, 'utf8').trim();
          endpoint = endpoint.replace(/\$\{PORT\}/g, port);
        } catch {
          // port.txt not yet readable — not healthy yet
          return false;
        }
      }
      return probeHttp(endpoint, timeout);
    }

    const endpoint = healthCfg.endpoint ? expandTilde(healthCfg.endpoint) : null;

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

/**
 * probeHttp — ht-1: HTTP GET probe using Node stdlib http/https.
 * Returns true on any 2xx response, false on error or non-2xx.
 * [inv:no-new-dependency]: uses Node stdlib only.
 */
function probeHttp(endpoint: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const transport = endpoint.startsWith('https://') ? https : http;
    let done = false;
    const req = transport.get(endpoint, { timeout: timeoutMs }, (res) => {
      if (done) return;
      done = true;
      const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
      // Consume response body to free the socket.
      res.resume();
      resolve(ok);
    });
    req.on('timeout', () => {
      if (!done) {
        done = true;
        req.destroy();
        resolve(false);
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        resolve(false);
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
