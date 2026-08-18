/**
 * bl592-grace-margin.spec.ts — BL-592 / docs/spec/service-lifecycle.md §8.1a
 * part A.
 *
 * CLI-level integration for `cmdService`'s `disable` `graceMs` resolution,
 * driving the REAL built `dist/apps/sox/main.js` as a subprocess against
 * SANDBOXED dirs — same harness as `service-os-unit.spec.ts`
 * (SOX_ECOSYSTEM_HOME / SOX_OS_UNIT_DIR), plus a REAL live child process
 * (never launchd/systemd — `service disable` reaps by entrypoint identity
 * token regardless of whether an OS unit was ever loaded) so
 * `unloadThenReap`'s reap step actually SIGTERMs something and logs the
 * `(grace <N>ms)` line this suite asserts on.
 *
 * Precedence under test: `--grace-ms` flag > `SOX_STOP_GRACE_MS` env >
 * manifest `lifecycle.stop_timeout_ms` > `5000` fallback.
 *
 * RED against pre-fix code (`main.ts:4950-4954` read only the flag/env,
 * defaulting to a bare 5000 regardless of the manifest): every one of these
 * cases except the "manifest declares nothing" one would have printed
 * `(grace 5000ms)` instead of the declared/expected value.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_MAIN = path.resolve(__dirname, '../../../dist/apps/sox/main.js');

let home: string;
let unitDir: string;
let storeDir: string;
let child: ChildProcess | undefined;

function writeExtension(lifecycle: Record<string, unknown>): void {
  storeDir = path.join(home, 'ext', 'test-daemon');
  fs.mkdirSync(path.join(storeDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, 'extension.json'),
    JSON.stringify({
      id: 'test-daemon',
      type: 'service',
      entrypoint: 'dist/index.js',
      lifecycle: { background: true, singleton: true, ...lifecycle },
    }),
  );
  // Handles SIGTERM by exiting immediately — the test only asserts the
  // RESOLVED grace value printed in the reap log line, never actually needs
  // to wait out a real multi-second grace window.
  fs.writeFileSync(
    path.join(storeDir, 'dist', 'index.js'),
    "process.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\n",
  );

  fs.writeFileSync(
    path.join(home, 'extensions.lock'),
    JSON.stringify({
      version: 1,
      resolved: {
        'test-daemon@1.0.0': { version: '1.0.0', source: `file://${storeDir}`, checksum: 'sha256:test' },
      },
    }),
  );
}

/**
 * Runs the CLI ASYNCHRONOUSLY (not `spawnSync`), deliberately. `spawnSync`
 * blocks this test process's whole event loop for the duration of the call —
 * and this suite ALSO holds a real live child (`spawnLiveEntrypoint`) it
 * spawned moments earlier via async `child_process.spawn`, whose exit Node
 * only reaps (calls `waitpid`) when the event loop actually turns. A blocked
 * event loop means that child sits as a ZOMBIE for the CLI subprocess's
 * entire run — still present in the process table, `kill(pid, 0)` and `ps`
 * both still reporting it "alive" — so the CLI's own liveness poll can never
 * observe the death its own SIGTERM already caused, and reports a false
 * `survived → SIGKILL → undead`. Reproduced and diagnosed while writing this
 * suite: the target's own SIGTERM handler provably ran (a marker file it
 * writes on signal existed immediately), yet `spawnSync`-based polling still
 * reported it alive through the full grace window. Using async `spawn` here
 * keeps the event loop turning, so Node's own SIGCHLD reaping keeps up.
 */
function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child2 = spawn(process.execPath, [CLI_MAIN, ...args], {
      env: {
        ...process.env,
        SOX_ECOSYSTEM_HOME: home,
        SOX_OS_UNIT_DIR: unitDir,
        ...extraEnv,
      },
      cwd: home,
    });
    let stdout = '';
    let stderr = '';
    child2.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child2.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child2.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Spawn the REAL live entrypoint process so unloadThenReap's identity-token
 * reap has something to SIGTERM and log a grace line against. Waits briefly
 * for the process to actually be up (and its SIGTERM handler installed)
 * before returning, so the CLI's ps-snapshot-based identity match — and the
 * reap's own confirm-dead poll — never race a process that is still starting. */
async function spawnLiveEntrypoint(): Promise<void> {
  child = spawn(process.execPath, [path.join(storeDir, 'dist', 'index.js')], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 400));
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-svc-grace-'));
  home = path.join(base, 'home');
  unitDir = path.join(base, 'units');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(unitDir, { recursive: true });
});

afterEach(() => {
  if (child && child.pid) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      /* already dead */
    }
  }
  child = undefined;
  try {
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('BL-592 §8.1a part A — soxe service disable graceMs precedence', () => {
  it('RED (pre-fix: always (grace 5000ms) regardless of the manifest) — resolves to the manifest lifecycle.stop_timeout_ms when no flag/env override is given', async () => {
    writeExtension({ stop_timeout_ms: 9000 });
    await spawnLiveEntrypoint();

    const r = await runCli(['service', 'disable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\(grace 9000ms\)/);
  });

  it('--grace-ms flag takes precedence over the manifest', async () => {
    writeExtension({ stop_timeout_ms: 9000 });
    await spawnLiveEntrypoint();

    const r = await runCli(['service', 'disable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--grace-ms', '1234']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\(grace 1234ms\)/);
  });

  it('SOX_STOP_GRACE_MS env takes precedence over the manifest (but not the flag)', async () => {
    writeExtension({ stop_timeout_ms: 9000 });
    await spawnLiveEntrypoint();

    const r = await runCli(
      ['service', 'disable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd'],
      { SOX_STOP_GRACE_MS: '2222' },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\(grace 2222ms\)/);
  });

  it('a manifest declaring nothing falls back to the unchanged 5000ms default', async () => {
    writeExtension({});
    await spawnLiveEntrypoint();

    const r = await runCli(['service', 'disable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\(grace 5000ms\)/);
  });
});
