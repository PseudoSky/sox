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

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_MAIN = path.resolve(__dirname, '../../../dist/apps/sox/main.js');

let home: string;
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

    const unitPath = path.join(unitDir, 'com.sox.user.doctor-tick.plist');
    expect(fs.existsSync(unitPath)).toBe(true);
    const plist = fs.readFileSync(unitPath, 'utf8');
    expect(plist).toContain('sox-os-unit content-hash:');
    expect(plist).toContain('<string>com.sox.user.doctor-tick</string>');
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
    const plist = fs.readFileSync(path.join(unitDir, 'com.sox.user.doctor-tick.plist'), 'utf8');
    expect(plist).toContain('<integer>60</integer>');

    const own = JSON.parse(fs.readFileSync(path.join(home, 'ownership.json'), 'utf8')) as {
      owned: Array<{ extId: string; entries: Array<{ kind: string; label?: string; appliedHash?: string }> }>;
    };
    const rec = own.owned.find((o) => o.extId === 'doctor-tick');
    expect(rec).toBeDefined();
    const osUnit = rec!.entries.find((e) => e.kind === 'os-unit');
    expect(osUnit).toBeDefined();
    expect(osUnit!.label).toBe('com.sox.user.doctor-tick');
    expect(osUnit!.appliedHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('systemd seam: renders the paired content-addressed .timer unit', () => {
    const r = runCli(['doctor', '--install-tick', '--supervisor', 'systemd', '--allow-volatile-node', '--dry-run']);
    expect(r.code).toBe(0);
    const svc = path.join(unitDir, 'sox-user-doctor-tick.service');
    const timer = path.join(unitDir, 'sox-user-doctor-tick.timer');
    expect(fs.existsSync(svc)).toBe(true);
    expect(fs.existsSync(timer)).toBe(true);
    const timerText = fs.readFileSync(timer, 'utf8');
    expect(timerText).toContain('OnUnitActiveSec=300');
    expect(timerText).toContain('Unit=sox-user-doctor-tick.service');
    expect(timerText).toContain('sox-os-unit content-hash:');
  });

  it('--remove-tick removes the unit file and clears the ownership entry', () => {
    runCli(['doctor', '--install-tick', ...TICK_ARGS]);
    const unitPath = path.join(unitDir, 'com.sox.user.doctor-tick.plist');
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
