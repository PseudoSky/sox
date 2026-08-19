/**
 * service-update.bl593.spec.ts — BL-593 / docs/spec/service-lifecycle.md §9.4b.
 *
 * CLI-level integration for `soxe service update`, driving the REAL built
 * `dist/apps/sox/main.js` as a subprocess against SANDBOXED dirs — same harness
 * as `service-os-unit.spec.ts` (SOX_ECOSYSTEM_HOME / SOX_OS_UNIT_DIR).
 *
 * Uses `--dry-run` throughout (same reason `service-os-unit.spec.ts` does): a
 * live (`load:true`) run calls the REAL `launchctl bootstrap`, which would
 * register a REAL LaunchAgent on the host machine running this suite — never
 * safe to do from an automated test. `--dry-run` still exercises the FULL
 * decision tree `cmdServiceUpdate`/`updateOsUnit` implement — content-address
 * comparison, action classification (created/updated/unchanged), and ownership
 * recording — everything except the final `launchctl` call and the
 * rotation-verify step that follows a REAL load. That step (proving BL-593's
 * core claim — a content change that never rotates a pid is `ok:false`, not
 * silent success) is proven at the unit level in `os-unit.spec.ts`'s
 * `updateOsUnit` describe block via `updateOsUnit`'s injectable `enableFn`/
 * `restartFn` seams (RED: backend never rotates -> ok:false; GREEN: pid
 * rotates -> ok:true) — same division of labor `cmdServiceRestart`/
 * `restartAndVerify` already use (no CLI-level test loads a real launchd unit
 * for `restart` either).
 *
 * Proves at the CLI level:
 *   - `update --dry-run` on a never-enabled extension reports action 'created'
 *     and does NOT call any launchctl (RED against a naive implementation that
 *     required an existing unit, or that always loaded regardless of --dry-run).
 *   - `update --dry-run` re-run against unchanged content reports 'unchanged'.
 *   - `update --dry-run` after the manifest changes (content differs) reports
 *     the new action and a changed content-hash.
 *   - ownership index is recorded (mirrors `enable`'s [inv:reversible-injection]).
 *   - refuses an unknown extension.
 *   - `--help` documents `update` alongside `restart`.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { osUnitLabelFor } from '@adhd/sox-host-runtime';

const CLI_MAIN = path.resolve(__dirname, '../../../dist/apps/sox/main.js');

let home: string;
let unitDir: string;
let storeDir: string;

const label = () => osUnitLabelFor('user', 'test-daemon', home);

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

function writeExtension(entrypointBody: string): void {
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
  fs.writeFileSync(path.join(storeDir, 'dist', 'index.js'), entrypointBody);

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

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-svc-update-'));
  home = path.join(base, 'home');
  unitDir = path.join(base, 'units');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(unitDir, { recursive: true });
  writeExtension('process.exit(0);\n');
});

afterEach(() => {
  try {
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('soxe service update — BL-593 §9.4b (CLI, --dry-run only — never touches real launchctl)', () => {
  it('on a never-enabled extension: reports action would-create, writes the unit, but issues NO launchctl call', () => {
    const realLaunchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label()}.plist`);
    const before = fs.existsSync(realLaunchAgents);

    const r = runCli(['service', 'update', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('created');
    expect(r.stdout).toContain('--dry-run');
    expect(r.stdout).toMatch(/would verify pid/);

    const unitPath = path.join(unitDir, `${label()}.plist`);
    expect(fs.existsSync(unitPath)).toBe(true);

    // the REAL LaunchAgents dir was never touched
    expect(fs.existsSync(realLaunchAgents)).toBe(before);
  });

  it('re-running update --dry-run against unchanged content reports "no change"', () => {
    runCli(['service', 'update', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    const r2 = runCli(['service', 'update', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain('no change');
  });

  it('a manifest content change (new stop_timeout_ms) is detected as an update on the next --dry-run', () => {
    runCli(['service', 'update', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);

    // Change the manifest — same as a routine config redeploy would.
    fs.writeFileSync(
      path.join(storeDir, 'extension.json'),
      JSON.stringify({
        id: 'test-daemon',
        type: 'service',
        entrypoint: 'dist/index.js',
        lifecycle: { background: true, singleton: true, stop_timeout_ms: 9999 },
      }),
    );

    const r2 = runCli(['service', 'update', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain('updated');
    expect(r2.stdout).not.toContain('no change');
  });

  it('records the os-unit in the ownership index, same as enable ([inv:reversible-injection])', () => {
    runCli(['service', 'update', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    const ownPath = path.join(home, 'ownership.json');
    expect(fs.existsSync(ownPath)).toBe(true);
    const own = JSON.parse(fs.readFileSync(ownPath, 'utf8')) as {
      owned: Array<{ extId: string; entries: Array<{ kind: string; label?: string; appliedHash?: string }> }>;
    };
    const rec = own.owned.find((o) => o.extId === 'test-daemon');
    expect(rec).toBeDefined();
    const osUnit = rec!.entries.find((e) => e.kind === 'os-unit');
    expect(osUnit).toBeDefined();
    expect(osUnit!.label).toBe(label());
    expect(osUnit!.appliedHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses an unknown extension', () => {
    const r = runCli(['service', 'update', 'no-such-ext', '-s', 'user', '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not installed');
  });

  it('--help documents update alongside restart', () => {
    const r = runCli(['service', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('service update');
    expect(r.stdout).toContain('service restart');
    expect(r.stdout).toMatch(/BL-593/);
  });

  it('an unknown subcommand error message lists update', () => {
    const r = runCli(['service', 'bogus', 'test-daemon']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('update');
  });
});
