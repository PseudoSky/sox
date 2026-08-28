/**
 * doctor-reconcile.spec.ts — Slices 3–4 of docs/spec/service-lifecycle.md.
 *
 * CLI-level integration for the continuous-supervision surface, driving the REAL
 * built `dist/apps/sox/main.js` as a subprocess against SANDBOXED dirs (the
 * exact `service-os-unit.spec.ts` pattern):
 *
 *   SOX_ECOSYSTEM_HOME → temp data root (lockfile/ownership/runtime/markers/logs)
 *   SOX_OS_UNIT_DIR    → temp unit dir   (NEVER ~/Library/LaunchAgents)
 *   --dry-run          → render-only (ZERO launchctl load calls)
 *
 * Proves:
 *   - `doctor --install-tick --dry-run` renders a content-addressed launchd unit
 *     running `soxe doctor --reconcile` on a StartInterval, into the SANDBOX only,
 *     ownership-tracked under the `doctor-tick` pseudo-id ([inv:reversible-injection]).
 *   - `--interval` + the systemd `.timer` seam render correctly.
 *   - `doctor --remove-tick` reverses it (unit file + ownership entry gone).
 *   - `doctor --reconcile` heals a split-brain runtime.json (F4/F6) — dry-run
 *     reports WITHOUT writing; the real pass writes running:false; a second pass
 *     is an idempotent no-op — and writes the durable reconcile log.
 *   - a Slice 3 crash-loop marker surfaces in `doctor --reconcile --json` AND in
 *     `soxe status` as DEGRADED ([inv:crash-loop-cap] §11.3, [inv:list-never-lies]).
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { osUnitLabelFor, pidAlive, snapshotProcessTable } from '@adhd/sox-host-runtime';

const CLI_MAIN = path.resolve(__dirname, '../../../dist/apps/sox/main.js');

let home: string;

// BL-263: the CLI runs with SOX_ECOSYSTEM_HOME=home, so its labels carry the
// sandbox namespace suffix — compute expected names the same way.
const tickLabel = () => osUnitLabelFor('user', 'doctor-tick', home);
const sysdName = (ext: string) => `sox-${tickLabel().replace(/^com\.sox\./, '').replace(/\./g, '-')}.${ext}`;
let unitDir: string;
let storeDir: string;

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_MAIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SOX_ECOSYSTEM_HOME: home,
      SOX_OS_UNIT_DIR: unitDir,
    },
    cwd: home,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-doctor-reconcile-'));
  home = path.join(base, 'home');
  unitDir = path.join(base, 'units');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(unitDir, { recursive: true });

  // A fake installed `service` extension (store + lockfile) so the reconcile has
  // a real scope layout to walk.
  storeDir = path.join(home, 'ext', 'test-daemon');
  fs.mkdirSync(path.join(storeDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, 'extension.json'),
    JSON.stringify({
      id: 'test-daemon',
      type: 'service',
      entrypoint: 'dist/index.js',
      lifecycle: { background: true, singleton: true, stop_timeout_ms: 5000 },
    }),
  );
  fs.writeFileSync(path.join(storeDir, 'dist', 'index.js'), 'process.exit(0);\n');
  fs.writeFileSync(
    path.join(home, 'extensions.lock'),
    JSON.stringify({
      version: 1,
      resolved: {
        'test-daemon@1.0.0': { version: '1.0.0', source: `file://${storeDir}`, checksum: 'sha256:test' },
      },
    }),
  );
});

afterEach(() => {
  try {
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const TICK_ARGS = ['--supervisor', 'launchd', '--allow-volatile-node', '--dry-run'];

describe('soxe doctor --install-tick / --remove-tick (Slice 4 scheduling)', () => {
  it('renders a content-addressed StartInterval unit running `doctor --reconcile` into the SANDBOX only', () => {
    const realLaunchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.sox.user.doctor-tick.plist');
    const before = fs.existsSync(realLaunchAgents);

    const r = runCli(['doctor', '--install-tick', ...TICK_ARGS]);
    expect(r.code).toBe(0);

    const unitPath = path.join(unitDir, `${tickLabel()}.plist`);
    expect(fs.existsSync(unitPath)).toBe(true);
    const plist = fs.readFileSync(unitPath, 'utf8');
    expect(plist).toContain('sox-os-unit content-hash:');
    expect(plist).toContain(`<string>${tickLabel()}</string>`);
    expect(plist).toContain('<string>doctor</string>');
    expect(plist).toContain('<string>--reconcile</string>');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>300</integer>'); // the 5-min default
    // A tick job exits and is relaunched on the interval — never KeepAlive'd.
    expect(plist).toContain('<key>KeepAlive</key>\n  <false/>');
    expect(r.stdout).toContain('--dry-run');
    // The REAL LaunchAgents dir was never touched.
    expect(fs.existsSync(realLaunchAgents)).toBe(before);
  });

  it('--interval overrides the default and is ownership-tracked under doctor-tick', () => {
    const r = runCli(['doctor', '--install-tick', '--interval', '60', ...TICK_ARGS]);
    expect(r.code).toBe(0);
    const plist = fs.readFileSync(path.join(unitDir, `${tickLabel()}.plist`), 'utf8');
    expect(plist).toContain('<integer>60</integer>');

    const own = JSON.parse(fs.readFileSync(path.join(home, 'ownership.json'), 'utf8')) as {
      owned: Array<{ extId: string; entries: Array<{ kind: string; label?: string; appliedHash?: string }> }>;
    };
    const rec = own.owned.find((o) => o.extId === 'doctor-tick');
    expect(rec).toBeDefined();
    const osUnit = rec!.entries.find((e) => e.kind === 'os-unit');
    expect(osUnit).toBeDefined();
    expect(osUnit!.label).toBe(tickLabel());
    expect(osUnit!.appliedHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('systemd seam: renders the paired content-addressed .timer unit', () => {
    const r = runCli(['doctor', '--install-tick', '--supervisor', 'systemd', '--allow-volatile-node', '--dry-run']);
    expect(r.code).toBe(0);
    const svc = path.join(unitDir, sysdName('service'));
    const timer = path.join(unitDir, sysdName('timer'));
    expect(fs.existsSync(svc)).toBe(true);
    expect(fs.existsSync(timer)).toBe(true);
    const timerText = fs.readFileSync(timer, 'utf8');
    expect(timerText).toContain('OnUnitActiveSec=300');
    expect(timerText).toContain(`Unit=${sysdName('service')}`);
    expect(timerText).toContain('sox-os-unit content-hash:');
  });

  it('--remove-tick removes the unit file and clears the ownership entry', () => {
    runCli(['doctor', '--install-tick', ...TICK_ARGS]);
    const unitPath = path.join(unitDir, `${tickLabel()}.plist`);
    expect(fs.existsSync(unitPath)).toBe(true);

    const r = runCli(['doctor', '--remove-tick', '--supervisor', 'launchd']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(unitPath)).toBe(false);

    const own = JSON.parse(fs.readFileSync(path.join(home, 'ownership.json'), 'utf8')) as {
      owned: Array<{ extId: string; entries: Array<{ kind: string }> }>;
    };
    const rec = own.owned.find((o) => o.extId === 'doctor-tick');
    const leftover = rec?.entries.filter((e) => e.kind === 'os-unit') ?? [];
    expect(leftover.length).toBe(0);
  });
});

describe('soxe doctor --reconcile (Slice 4 universal reconcile)', () => {
  function writeSplitBrainRuntime(): string {
    // running:true for a pid that cannot exist + a dead supervisorPid ⇒ the
    // F4/F6 split-brain a verb-less box accumulates.
    const runtimePath = path.join(home, 'runtime.json');
    fs.writeFileSync(
      runtimePath,
      JSON.stringify({
        version: 1,
        scope: 'user',
        startedAt: new Date().toISOString(),
        supervisorPid: 999999,
        entries: [{
          key: 'test-daemon@1.0.0',
          id: 'test-daemon',
          type: 'service',
          scope: 'user',
          source: `file://${storeDir}`,
          pid: 999999,
          running: true,
          activatedAt: new Date().toISOString(),
        }],
      }, null, 2),
    );
    return runtimePath;
  }

  it('--dry-run reports the split-brain WITHOUT writing; the real pass heals it; a re-run is a no-op', () => {
    const runtimePath = writeSplitBrainRuntime();

    // 1. Dry-run: reported, not written.
    const dry = runCli(['doctor', '--reconcile', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('WOULD heal');
    expect(dry.stdout).toContain('running:true with NO process reality');
    const afterDry = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as { entries: Array<{ running: boolean }> };
    expect(afterDry.entries[0]!.running).toBe(true); // untouched

    // 2. Real pass: healed ([inv:list-never-lies]).
    const real = runCli(['doctor', '--reconcile']);
    expect(real.code).toBe(0);
    expect(real.stdout).toContain('healed');
    const afterReal = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as { entries: Array<{ running: boolean; pid: number | null }> };
    expect(afterReal.entries[0]!.running).toBe(false);
    expect(afterReal.entries[0]!.pid).toBeNull();

    // 3. Idempotent: nothing left to heal.
    const again = runCli(['doctor', '--reconcile']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('0 healed');
  });

  it('writes the durable reconcile log (soxe-logs-visible surface)', () => {
    writeSplitBrainRuntime();
    runCli(['doctor', '--reconcile']);
    const logDir = path.join(home, 'run', 'logs', 'doctor-reconcile');
    expect(fs.existsSync(logDir)).toBe(true);
    const files = fs.readdirSync(logDir).filter((f) => f.startsWith('doctor-reconcile-') && f.endsWith('.log'));
    expect(files.length).toBeGreaterThan(0);
    const text = fs.readFileSync(path.join(logDir, files[0]!), 'utf8');
    expect(text).toContain('[reconcile] pass starting');
    expect(text).toContain('running:false');
    expect(text).toContain('[reconcile] pass complete');
  });

  it('a clean sandbox reconciles with nothing to do (exit 0, idempotent)', () => {
    const r = runCli(['doctor', '--reconcile']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('0 healed');
    expect(r.stdout).toContain('0 failed');
  });
});

describe('Slice 3 crash-loop give-up surfacing (§11.3)', () => {
  function writeGiveUpMarker(): void {
    const dir = path.join(home, 'run', 'crash-loop');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'test-daemon@1.0.0.json'),
      JSON.stringify({
        key: 'test-daemon@1.0.0',
        cappedAt: new Date().toISOString(),
        failures: [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
        maxFailures: 3,
        windowMs: 60000,
        reason: '[crash-loop] "test-daemon@1.0.0" gave up after 3 unexpected exits within 60000ms (cap 3) — DEGRADED (give-up); an explicit start/enable is required to clear',
      }, null, 2),
    );
  }

  it('doctor --reconcile --json reports the give-up as report-only (explicit start clears)', () => {
    writeGiveUpMarker();
    const r = runCli(['doctor', '--reconcile', '--json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout) as { findings: Array<{ kind: string; extId: string; action: string }> };
    const f = report.findings.find((x) => x.kind === 'crash-loop-give-up');
    expect(f).toBeDefined();
    expect(f!.extId).toBe('test-daemon');
    expect(f!.action).toBe('report-only');
  });

  it('soxe status renders the capped service DEGRADED with the crash-loop reason (exit 1)', () => {
    writeGiveUpMarker();
    const r = runCli(['status', '--json']);
    expect(r.code).toBe(1); // degraded
    const records = JSON.parse(r.stdout) as Array<{ id: string; status: string; staleReason?: string }>;
    const rec = records.find((x) => x.id === 'test-daemon');
    expect(rec).toBeDefined();
    expect(rec!.status).toBe('degraded');
    expect(rec!.staleReason).toContain('[crash-loop]');
    expect(rec!.staleReason).toContain('gave up after 3 unexpected exits');
  });

  it('plain doctor lists the give-up as a CRASH-LOOP anomaly', () => {
    writeGiveUpMarker();
    const r = runCli(['doctor']);
    expect(r.code).toBe(1); // findings present
    expect(r.stdout).toContain('CRASH-LOOP');
    expect(r.stdout).toContain('crash-loop give-up');
  });
});

describe('soxe doctor --reconcile — BL-621 ancestry-rooted classification (real processes)', () => {
  const livePids: number[] = [];
  let sockPath: string;

  function writeBackendFixture(): void {
    // A socket service: manifest declares a literal health-socket endpoint so
    // the reconcile probes THIS socket for liveness + holder attribution.
    sockPath = path.join(home, 'test-daemon.sock');
    fs.writeFileSync(
      path.join(storeDir, 'extension.json'),
      JSON.stringify({
        id: 'test-daemon',
        type: 'service',
        entrypoint: 'dist/index.js',
        lifecycle: {
          background: true,
          singleton: true,
          stop_timeout_ms: 5000,
          health: { type: 'socket', endpoint: sockPath },
        },
      }),
    );
    // The install ledger the reconcile actually walks (install-registry.json,
    // NOT extensions.lock).
    fs.writeFileSync(
      path.join(home, 'install-registry.json'),
      JSON.stringify({
        version: 1,
        installs: [{
          extId: 'test-daemon', version: '1.0.0', scope: 'user', root: home,
          installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          source: `file://${storeDir}`,
        }],
      }),
    );
    // The child (forked by the backend) — sleeps, zero socket fds, inherits env.
    fs.writeFileSync(path.join(storeDir, 'child.js'), 'setInterval(() => {}, 60000);\n');
    // The backend: binds the health socket (the live writer holder), forks a
    // child (which inherits SOX_SERVICE_ID but holds no socket fd), and stays up.
    fs.writeFileSync(
      path.join(storeDir, 'backend.js'),
      [
        `const net = require('node:net');`,
        `const fs = require('node:fs');`,
        `const { fork } = require('node:child_process');`,
        `const server = net.createServer(() => {});`,
        `server.listen(process.env.SOX_TEST_SOCK, () => {`,
        `  const child = fork(process.env.SOX_TEST_CHILD_SCRIPT, [], { stdio: 'ignore' });`,
        `  try { fs.writeFileSync(process.env.SOX_TEST_CHILD_PID_FILE, String(child.pid)); } catch {}`,
        `  child.unref();`,
        `});`,
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
    );
  }

  async function waitForFile(p: string, timeoutMs = 8000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { return fs.readFileSync(p, 'utf8').trim(); } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout waiting for ${p}`);
  }

  async function waitForPpid(pid: number, want: number, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (snapshotProcessTable().get(pid) === want) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`pid ${pid} never reached ppid ${want}`);
  }

  beforeEach(() => {
    writeBackendFixture();
  });

  afterEach(() => {
    for (const pid of livePids.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  });

  /** Spawn the socket-holding backend; returns its forked child's pid. */
  async function startBackend(): Promise<number> {
    const childPidFile = path.join(storeDir, 'child.pid');
    const b = spawn(process.execPath, [path.join(storeDir, 'backend.js')], {
      env: {
        ...process.env,
        SOX_SERVICE_ID: 'test-daemon',
        SOX_TEST_SOCK: sockPath,
        SOX_TEST_CHILD_SCRIPT: path.join(storeDir, 'child.js'),
        SOX_TEST_CHILD_PID_FILE: childPidFile,
      },
      detached: true,
      stdio: 'ignore',
    });
    b.unref();
    livePids.push(b.pid!);
    const childPid = Number(await waitForFile(childPidFile));
    livePids.push(childPid);
    return childPid;
  }

  /** Spawn a grandchild whose parent exits — reparented to init (PPID 1), a true orphan. */
  async function startOrphan(): Promise<number> {
    const orphanPidFile = path.join(storeDir, 'orphan.pid');
    const helper = spawn(process.execPath, ['-e', [
      `const { spawn } = require('node:child_process');`,
      `const fs = require('node:fs');`,
      `const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},60000)'], {`,
      `  env: { ...process.env, SOX_SERVICE_ID: 'test-daemon' },`,
      `  detached: true,`,
      `  stdio: 'ignore',`,
      `});`,
      `try { fs.writeFileSync(${JSON.stringify(orphanPidFile)}, String(c.pid)); } catch {}`,
      `c.unref();`,
    ].join('\n')], { stdio: 'ignore' });
    helper.unref();
    const orphanPid = Number(await waitForFile(orphanPidFile));
    livePids.push(orphanPid);
    // The helper has now exited; wait until the grandchild is reparented to init.
    await waitForPpid(orphanPid, 1);
    return orphanPid;
  }

  it('BL-621: forked child with zero socket fds survives; true orphan is reaped; markers written', async () => {
    const childPid = await startBackend();
    const orphanPid = await startOrphan();

    const r = runCli(['doctor', '--reconcile', '--json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout) as {
      findings: Array<{ kind: string; pid: number; action: string }>;
    };

    // The fork child (zero fds, descendant of the live backend) survived.
    expect(pidAlive(childPid)).toBe(true);
    // The true orphan (reparented to init) was reaped.
    expect(pidAlive(orphanPid)).toBe(false);

    // The child is reported as a protected descendant, not a stray.
    expect(report.findings.some((f) => f.kind === 'descendant-skip-audit' && f.pid === childPid)).toBe(true);
    // The orphan is reported as a healed zombie-stray.
    expect(report.findings.some((f) => f.kind === 'zombie-stray' && f.pid === orphanPid && f.action === 'healed')).toBe(true);

    // Markers written for both the reap and the descendant-skip.
    const markerDir = path.join(home, 'run', 'reconcile-heals');
    const lastJson = JSON.parse(fs.readFileSync(path.join(markerDir, 'test-daemon@user.json'), 'utf8')) as {
      kind: string; pid: number;
    };
    // The reap loop runs after the skip loop, so the LAST marker is the orphan reap.
    expect(lastJson.kind).toBe('zombie-reap');
    expect(lastJson.pid).toBe(orphanPid);
    // The per-day JSONL holds BOTH events (descendant-skip + zombie-reap).
    const jsonlFiles = fs.readdirSync(markerDir).filter((f) => f.endsWith('.jsonl'));
    expect(jsonlFiles.length).toBeGreaterThan(0);
    const jsonl = fs.readFileSync(path.join(markerDir, jsonlFiles[0]!), 'utf8');
    expect(jsonl).toContain('descendant-skip');
    expect(jsonl).toContain('zombie-reap');
  });

  it('BL-621: --dry-run kills nothing (fork child AND orphan both survive)', async () => {
    const childPid = await startBackend();
    const orphanPid = await startOrphan();

    const r = runCli(['doctor', '--reconcile', '--dry-run', '--json']);
    expect(r.code).toBe(0);
    expect(pidAlive(childPid)).toBe(true);
    expect(pidAlive(orphanPid)).toBe(true);
  });
});
