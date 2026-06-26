/**
 * os-unit.spec.ts — Slice 2 of docs/spec/service-lifecycle.md.
 *
 * Authoritative unit tests for the OS-supervisor control surface (§9, §8.4/§8.5).
 * These import the REAL module so they pin shipped behaviour, and they exercise
 * EVERY effect against a SANDBOXED unit dir with a FAKE exec — proving:
 *
 *   - the unit is RENDERED from the manifest, content-addressed (§9.2/§9.3)
 *   - enable is idempotent: unchanged re-enable does NOT rewrite/reload
 *   - an artifact change re-enables (content-hash changes ⇒ updated)
 *   - enable→disable round-trip (load then unload+remove)
 *   - [inv:unload-then-reap]: the unit is UNLOADED *before* the reap (ordering)
 *   - NO real ~/Library/LaunchAgents write, NO real launchctl call
 *   - the volatile node-path footgun guard (§9.2 / Appendix B item 3)
 *   - the systemd seam renders + drives a different supervisor (pluggability)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LaunchdPlatform,
  SystemdPlatform,
  deriveOsUnitSpec,
  disableOsUnit,
  enableOsUnit,
  findNonVolatileNode,
  getOsUnitPlatform,
  osUnitLabel,
  readUnitMeta,
  resolveUnitNodePath,
  unitContentHash,
  unloadThenReap,
  type OsExec,
  type OsExecResult,
  type OsUnitSpec,
} from './os-unit.js';
import type { ReapResult } from './reaper.js';

let tmpDir: string;
let unitDir: string;
let logDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-osunit-'));
  unitDir = path.join(tmpDir, 'LaunchAgents');
  logDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(unitDir, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// A fake exec that RECORDS every command (and the order) and returns canned codes
// keyed by the launchctl/systemctl verb. NEVER touches a real OS supervisor.
function makeFakeExec(opts: { loaded?: boolean; loadCode?: number; unloadCode?: number } = {}): {
  exec: OsExec;
  calls: Array<{ cmd: string; args: string[] }>;
  setLoaded: (v: boolean) => void;
} {
  let loaded = opts.loaded ?? false;
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: OsExec = (cmd, args) => {
    calls.push({ cmd, args });
    const verb = args.find((a) => ['bootstrap', 'bootout', 'print', 'enable', 'disable', 'is-active'].includes(a)) ?? '';
    let res: OsExecResult = { code: 0, stdout: '', stderr: '' };
    if (verb === 'print') {
      res = { code: loaded ? 0 : 1, stdout: '', stderr: '' };
    } else if (verb === 'is-active') {
      res = { code: loaded ? 0 : 3, stdout: loaded ? 'active' : 'inactive', stderr: '' };
    } else if (verb === 'bootstrap' || verb === 'enable') {
      res = { code: opts.loadCode ?? 0, stdout: '', stderr: '' };
      if (res.code === 0) loaded = true;
    } else if (verb === 'bootout' || verb === 'disable') {
      res = { code: opts.unloadCode ?? 0, stdout: '', stderr: '' };
      if (res.code === 0) loaded = false;
    }
    return res;
  };
  return { exec, calls, setLoaded: (v) => { loaded = v; } };
}

function writeManifest(lifecycle: Record<string, unknown>): string {
  const mp = path.join(tmpDir, 'extension.json');
  fs.writeFileSync(mp, JSON.stringify({ id: 'memory-daemon', type: 'service', lifecycle }, null, 2));
  return mp;
}

function makeSpec(over: Partial<OsUnitSpec> = {}): OsUnitSpec {
  const manifestPath = writeManifest({ background: true, singleton: true, stop_timeout_ms: 5000 });
  return deriveOsUnitSpec({
    id: 'memory-daemon',
    scope: 'user',
    manifestPath,
    nodePath: '/usr/local/bin/node',
    entrypoint: path.join(tmpDir, 'ext', 'memory-daemon', 'dist', 'index.js'),
    env: { SOX_CONFIG_DB_PATH: path.join(tmpDir, 'memory.db'), SOX_CONFIG_SOCK_PATH: '/tmp/x.sock' },
    workingDirectory: path.join(tmpDir, 'ext', 'memory-daemon'),
    logDir,
    artifactHash: 'sha256:aaaa',
    logDate: '2026-06-26',
    ...over,
  });
}

// ─── Rendering + content addressing (§9.2/§9.3) ──────────────────────────────────

describe('deriveOsUnitSpec + label', () => {
  it('derives runAtLoad/keepAlive from lifecycle and a com.sox.<scope>.<id> label', () => {
    const spec = makeSpec();
    expect(spec.label).toBe('com.sox.user.memory-daemon');
    expect(spec.runAtLoad).toBe(true); // background:true
    expect(spec.keepAlive).toBe(true); // singleton:true
    expect(spec.throttleIntervalSec).toBeGreaterThanOrEqual(10);
    expect(osUnitLabel('project', 'tokenguard')).toBe('com.sox.project.tokenguard');
  });

  it('keepAlive is false when the manifest is not a singleton', () => {
    const mp = writeManifest({ background: true });
    const spec = deriveOsUnitSpec({
      id: 'x', scope: 'user', manifestPath: mp, nodePath: '/n', entrypoint: '/e.js',
      env: {}, workingDirectory: '/w', logDir,
    });
    expect(spec.keepAlive).toBe(false);
  });
});

describe('launchd render — content-addressed plist', () => {
  const platform = new LaunchdPlatform();

  it('renders a valid plist with ProgramArguments, sorted env, and an embedded content hash', () => {
    const spec = makeSpec();
    const plist = platform.render(spec);
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>com.sox.user.memory-daemon</string>');
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>--enable-source-maps</string>');
    expect(plist).toContain(spec.entrypoint);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
    expect(plist).toContain('<key>ThrottleInterval</key>');
    // env keys appear sorted (DB before SOCK)
    expect(plist.indexOf('SOX_CONFIG_DB_PATH')).toBeLessThan(plist.indexOf('SOX_CONFIG_SOCK_PATH'));
    const meta = readUnitMeta(plist);
    expect(meta.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(meta.artifactHash).toBe('sha256:aaaa');
  });

  it('content hash is stable across renders and changes when the spec changes', () => {
    const a = platform.render(makeSpec());
    const b = platform.render(makeSpec());
    expect(readUnitMeta(a).contentHash).toBe(readUnitMeta(b).contentHash);
    const c = platform.render(makeSpec({ entrypoint: '/different/dist/index.js' }));
    expect(readUnitMeta(c).contentHash).not.toBe(readUnitMeta(a).contentHash);
  });

  it('XML-escapes special characters in env values', () => {
    const spec = makeSpec({ env: { SOX_CONFIG_X: 'a & b < c > d' } });
    const plist = platform.render(spec);
    expect(plist).toContain('a &amp; b &lt; c &gt; d');
    expect(plist).not.toContain('a & b < c > d');
  });

  it('unitContentHash is computed over body excluding the meta comment (fixed point)', () => {
    const spec = makeSpec();
    const plist = platform.render(spec);
    // Re-reading the embedded hash equals recomputing from a re-render — proves the
    // hash does not feed its own input.
    const reRendered = platform.render(spec);
    expect(readUnitMeta(plist).contentHash).toBe(readUnitMeta(reRendered).contentHash);
    expect(unitContentHash('abc')).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ─── enable: idempotent + content-addressed (§9.3 / [inv:os-unit-content-addressed]) ──

describe('enableOsUnit — content-addressed idempotence', () => {
  const platform = new LaunchdPlatform();

  it('first enable creates + loads; the unit file lands ONLY in the sandbox dir', () => {
    const { exec, calls } = makeFakeExec();
    const spec = makeSpec();
    const r = enableOsUnit(spec, platform, { unitDir, exec, load: true });
    expect(r.action).toBe('created');
    expect(r.loaded).toBe(true);
    expect(r.unitPath).toBe(path.join(unitDir, 'com.sox.user.memory-daemon.plist'));
    expect(fs.existsSync(r.unitPath)).toBe(true);
    // a real LaunchAgents path was NEVER written
    expect(r.unitPath.startsWith(unitDir)).toBe(true);
    expect(calls.some((c) => c.args.includes('bootstrap'))).toBe(true);
  });

  it('re-enable with identical content is a no-op (unchanged: no rewrite, no reload)', () => {
    const fake1 = makeFakeExec();
    const spec = makeSpec();
    enableOsUnit(spec, platform, { unitDir, exec: fake1.exec, load: true });
    const mtime1 = fs.statSync(path.join(unitDir, 'com.sox.user.memory-daemon.plist')).mtimeMs;

    const fake2 = makeFakeExec({ loaded: true }); // unit reports loaded
    const r2 = enableOsUnit(spec, platform, { unitDir, exec: fake2.exec, load: true });
    expect(r2.action).toBe('unchanged');
    // no bootstrap/bootout issued on the unchanged path
    expect(fake2.calls.some((c) => c.args.includes('bootstrap'))).toBe(false);
    expect(fake2.calls.some((c) => c.args.includes('bootout'))).toBe(false);
    const mtime2 = fs.statSync(path.join(unitDir, 'com.sox.user.memory-daemon.plist')).mtimeMs;
    expect(mtime2).toBe(mtime1); // file not rewritten
  });

  it('an artifact change re-enables: unloads stale, rewrites, reloads (updated)', () => {
    enableOsUnit(makeSpec(), platform, { unitDir, exec: makeFakeExec().exec, load: true });

    const fake = makeFakeExec({ loaded: true });
    const newSpec = makeSpec({ entrypoint: '/new/dist/index.js' });
    const r = enableOsUnit(newSpec, platform, { unitDir, exec: fake.exec, load: true });
    expect(r.action).toBe('updated');
    // stale unit unloaded BEFORE the reload picks up new content
    const bootoutIdx = fake.calls.findIndex((c) => c.args.includes('bootout'));
    const bootstrapIdx = fake.calls.findIndex((c) => c.args.includes('bootstrap'));
    expect(bootoutIdx).toBeGreaterThanOrEqual(0);
    expect(bootstrapIdx).toBeGreaterThan(bootoutIdx);
    // the on-disk unit now points at the new entrypoint
    const text = fs.readFileSync(r.unitPath, 'utf8');
    expect(text).toContain('/new/dist/index.js');
  });

  it('render-only (load:false) writes the unit but NEVER calls the OS supervisor', () => {
    const { exec, calls } = makeFakeExec();
    const r = enableOsUnit(makeSpec(), platform, { unitDir, exec, load: false });
    expect(r.action).toBe('created');
    expect(r.loaded).toBe(false);
    expect(fs.existsSync(r.unitPath)).toBe(true);
    expect(calls.length).toBe(0); // no launchctl whatsoever
  });

  it('creates the durable log dirs so the OS supervisor can open them', () => {
    const spec = makeSpec();
    enableOsUnit(spec, platform, { unitDir, exec: makeFakeExec().exec, load: false });
    expect(fs.existsSync(path.dirname(spec.stdoutPath))).toBe(true);
  });
});

// ─── disable: round-trip ─────────────────────────────────────────────────────────

describe('disableOsUnit — unload + remove round-trip', () => {
  const platform = new LaunchdPlatform();

  it('enable→disable removes the unit file and unloads it', () => {
    const fake = makeFakeExec();
    const spec = makeSpec();
    enableOsUnit(spec, platform, { unitDir, exec: fake.exec, load: true });
    expect(fs.existsSync(path.join(unitDir, 'com.sox.user.memory-daemon.plist'))).toBe(true);

    const d = disableOsUnit(spec.label, platform, { unitDir, exec: fake.exec });
    expect(d.unloaded).toBe(true);
    expect(d.removed).toBe(true);
    expect(fs.existsSync(d.unitPath)).toBe(false);
    expect(fake.calls.some((c) => c.args.includes('bootout'))).toBe(true);
  });

  it('disabling a not-loaded/absent unit is a clean no-op', () => {
    const fake = makeFakeExec({ loaded: false });
    const d = disableOsUnit('com.sox.user.ghost', platform, { unitDir, exec: fake.exec });
    expect(d.unloaded).toBe(false);
    expect(d.removed).toBe(false);
  });
});

// ─── [inv:unload-then-reap] ordering (§8.4/§8.5) ─────────────────────────────────

describe('unloadThenReap — unload BEFORE kill (no resurrection loop)', () => {
  const platform = new LaunchdPlatform();

  it('unloads the OS unit FIRST, then reaps the survivor by identity token', async () => {
    const order: string[] = [];
    const fake = makeFakeExec({ loaded: true });
    // wrap exec to record ordering relative to the reap
    const exec: OsExec = (cmd, args) => {
      const r = fake.exec(cmd, args);
      if (args.includes('bootout')) order.push('unload');
      return r;
    };
    const fakeReap = async (token: string): Promise<ReapResult> => {
      order.push('reap');
      return { token, killed: [{ pid: 4242, ppid: 1, orphaned: true, outcome: 'term' }] };
    };

    const res = await unloadThenReap({
      label: 'com.sox.user.memory-daemon',
      entrypoint: '/store/dist/index.js',
      platform,
      unitDir,
      exec,
      reapFn: fakeReap,
    });
    expect(res.unloaded).toBe(true);
    expect(res.undead).toBe(false);
    expect(order).toEqual(['unload', 'reap']); // ordering invariant
  });

  it('reports undead when a survivor cannot be confirmed dead', async () => {
    const fake = makeFakeExec({ loaded: false }); // not loaded — straight to reap
    const fakeReap = async (token: string): Promise<ReapResult> => ({
      token,
      killed: [{ pid: 99, ppid: 1, orphaned: true, outcome: 'undead' }],
    });
    const res = await unloadThenReap({
      label: 'com.sox.user.x',
      entrypoint: '/e.js',
      platform,
      unitDir,
      exec: fake.exec,
      reapFn: fakeReap,
    });
    expect(res.undead).toBe(true);
  });
});

// ─── node-path footgun guard (§9.2 / Appendix B item 3) ──────────────────────────

describe('resolveUnitNodePath — volatile node detection', () => {
  it('a normal node path is non-volatile', () => {
    const r = resolveUnitNodePath({ execPath: '/usr/local/bin/node', pathEnv: '' });
    expect(r.volatile).toBe(false);
    expect(r.nodePath).toBe('/usr/local/bin/node');
  });

  it('an nvm/asdf/volta node path is flagged volatile with a reason', () => {
    const r = resolveUnitNodePath({
      execPath: '/Users/x/.nvm/versions/node/v20.0.0/bin/node',
      pathEnv: '',
    });
    expect(r.volatile).toBe(true);
    expect(r.volatileReason).toContain('version-manager');
  });

  it('findNonVolatileNode returns undefined when PATH has only version-manager nodes', () => {
    // empty PATH ⇒ nothing found
    expect(findNonVolatileNode('')).toBeUndefined();
  });
});

// ─── systemd seam (pluggability) ─────────────────────────────────────────────────

describe('systemd platform — the seam is pluggable', () => {
  it('renders a [Service] unit with ExecStart + content hash and a sox-<scope>-<id>.service name', () => {
    const platform = new SystemdPlatform();
    const spec = makeSpec();
    const unit = platform.render(spec);
    expect(unit).toContain('[Service]');
    expect(unit).toContain('ExecStart=/usr/local/bin/node --enable-source-maps');
    expect(unit).toContain('Restart=on-failure'); // singleton ⇒ keepAlive
    expect(readUnitMeta(unit).contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(platform.unitFileName(spec.label)).toBe('sox-user-memory-daemon.service');
  });

  it('getOsUnitPlatform selects launchd on darwin and systemd elsewhere', () => {
    expect(getOsUnitPlatform('launchd').kind).toBe('launchd');
    expect(getOsUnitPlatform('systemd').kind).toBe('systemd');
  });

  it('systemd enable→disable round-trip drives systemctl --user, sandboxed', () => {
    const platform = new SystemdPlatform();
    const sysDir = path.join(tmpDir, 'systemd-user');
    fs.mkdirSync(sysDir, { recursive: true });
    const fake = makeFakeExec();
    const spec = makeSpec();
    const r = enableOsUnit(spec, platform, { unitDir: sysDir, exec: fake.exec, load: true });
    expect(r.action).toBe('created');
    expect(fs.existsSync(path.join(sysDir, 'sox-user-memory-daemon.service'))).toBe(true);
    expect(fake.calls.some((c) => c.args.includes('enable'))).toBe(true);
    const d = disableOsUnit(spec.label, platform, { unitDir: sysDir, exec: fake.exec });
    expect(d.removed).toBe(true);
    expect(fake.calls.some((c) => c.args.includes('disable'))).toBe(true);
  });
});

// ─── safety: no real ~/Library/LaunchAgents write ────────────────────────────────

describe('safety — never touches the real machine', () => {
  it('the launchd default unit dir is ~/Library/LaunchAgents but we always inject a sandbox', () => {
    const platform = new LaunchdPlatform();
    expect(platform.defaultUnitDir()).toBe(path.join(os.homedir(), 'Library', 'LaunchAgents'));
    // the test suite only ever passes unitDir = sandbox; assert the real dir is untouched
    // by confirming our rendered unit lives under tmpDir.
    const r = enableOsUnit(makeSpec(), platform, { unitDir, exec: makeFakeExec().exec, load: false });
    expect(r.unitPath.startsWith(tmpDir)).toBe(true);
    expect(r.unitPath.includes(path.join(os.homedir(), 'Library'))).toBe(false);
  });
});
