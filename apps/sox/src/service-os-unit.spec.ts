/**
 * service-os-unit.spec.ts — Slice 2 of docs/spec/service-lifecycle.md (§9).
 *
 * CLI-level integration for `soxe service enable|disable|status|list`, driving the
 * REAL built `dist/apps/sox/main.js` as a subprocess against SANDBOXED dirs:
 *
 *   SOX_ECOSYSTEM_HOME → temp data root (user-scope lockfile/ownership/store)
 *   SOX_OS_UNIT_DIR    → temp unit dir   (NEVER ~/Library/LaunchAgents)
 *
 * Proves end-to-end (resolveServeManifest → resolveOsUnitContext → enableOsUnit):
 *   - `service enable --dry-run` renders a content-addressed unit into the SANDBOX
 *     unit dir (never the real LaunchAgents dir), with the resolved entrypoint, and
 *     makes ZERO launchctl calls.
 *   - the os-unit is recorded in the ownership index ([inv:reversible-injection]).
 *   - `service list --json` enumerates it; `service status` reconciles owner/loaded.
 *   - `service disable` removes the unit file + clears the ownership entry.
 *   - NO file is ever written under the real ~/Library/LaunchAgents.
 *
 * Uses --dry-run so enable never loads (no real launchctl). status/list issue only
 * a read-only `launchctl print` probe (harmless; returns not-loaded for our label).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// dist/apps/sox/main.js is what bin/soxe loads (rewrite-paths makes it runnable).
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
      // force launchd rendering regardless of host platform so the test is stable
      // on Linux CI too (the plist content-address is what we assert).
    },
    cwd: home,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-svc-osunit-'));
  home = path.join(base, 'home');
  unitDir = path.join(base, 'units');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(unitDir, { recursive: true });

  // Materialize a fake installed `service` extension under the user-scope store.
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

  // User-scope lockfile pins the store as the resolved source.
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

describe('soxe service — OS-unit control surface (Slice 2)', () => {
  it('enable --dry-run renders a content-addressed plist into the SANDBOX (no real LaunchAgents, no launchctl)', () => {
    const realLaunchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.sox.user.test-daemon.plist');
    const before = fs.existsSync(realLaunchAgents);

    const r = runCli(['service', 'enable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    expect(r.code).toBe(0);

    const unitPath = path.join(unitDir, 'com.sox.user.test-daemon.plist');
    expect(fs.existsSync(unitPath)).toBe(true);
    const plist = fs.readFileSync(unitPath, 'utf8');
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain('sox-os-unit content-hash:');
    expect(plist).toContain('<string>com.sox.user.test-daemon</string>');
    expect(plist).toContain(path.join(storeDir, 'dist', 'index.js'));
    // dry-run wrote the unit but did NOT load it
    expect(r.stdout).toContain('--dry-run');

    // the REAL LaunchAgents dir was never touched by this test
    expect(fs.existsSync(realLaunchAgents)).toBe(before);
  });

  it('records the os-unit in the ownership index ([inv:reversible-injection])', () => {
    runCli(['service', 'enable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    const ownPath = path.join(home, 'ownership.json');
    expect(fs.existsSync(ownPath)).toBe(true);
    const own = JSON.parse(fs.readFileSync(ownPath, 'utf8')) as {
      owned: Array<{ extId: string; entries: Array<{ kind: string; label?: string; supervisor?: string; appliedHash?: string }> }>;
    };
    const rec = own.owned.find((o) => o.extId === 'test-daemon');
    expect(rec).toBeDefined();
    const osUnit = rec!.entries.find((e) => e.kind === 'os-unit');
    expect(osUnit).toBeDefined();
    expect(osUnit!.label).toBe('com.sox.user.test-daemon');
    expect(osUnit!.supervisor).toBe('launchd');
    expect(osUnit!.appliedHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('list --json enumerates the sox-owned unit', () => {
    runCli(['service', 'enable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    const r = runCli(['service', 'list', '--json']);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{ id: string; label: string; supervisor: string }>;
    const row = rows.find((x) => x.id === 'test-daemon');
    expect(row).toBeDefined();
    expect(row!.label).toBe('com.sox.user.test-daemon');
  });

  it('status reconciles owner/loaded for the unit', () => {
    runCli(['service', 'enable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    const r = runCli(['service', 'status', 'test-daemon', '-s', 'user', '--supervisor', 'launchd']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('com.sox.user.test-daemon');
    expect(r.stdout).toContain('unit file:');
    expect(r.stdout).toContain('loaded:');
    expect(r.stdout).toContain('owner:');
  });

  it('re-enable is idempotent — content-addressed unchanged', () => {
    runCli(['service', 'enable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    const r2 = runCli(['service', 'enable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain('unchanged');
  });

  it('disable removes the unit file and clears the ownership entry', () => {
    runCli(['service', 'enable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    const unitPath = path.join(unitDir, 'com.sox.user.test-daemon.plist');
    expect(fs.existsSync(unitPath)).toBe(true);

    const r = runCli(['service', 'disable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(unitPath)).toBe(false);

    const own = JSON.parse(fs.readFileSync(path.join(home, 'ownership.json'), 'utf8')) as {
      owned: Array<{ extId: string; entries: Array<{ kind: string }> }>;
    };
    const rec = own.owned.find((o) => o.extId === 'test-daemon');
    // either the record is gone or it has no os-unit entry left
    const leftover = rec?.entries.filter((e) => e.kind === 'os-unit') ?? [];
    expect(leftover.length).toBe(0);
  });

  it('refuses an unknown extension', () => {
    const r = runCli(['service', 'enable', 'no-such-ext', '-s', 'user', '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not installed');
  });
});
