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
  droppedShellEnvKeys,
  enableOsUnit,
  extractUnitEnv,
  findNonVolatileNode,
  getOsUnitPlatform,
  isScheduledOsUnit,
  isScheduledOsUnitContent,
  osUnitLabel,
  osUnitLabelFor,
  readUnitMeta,
  resolveUnitNodePath,
  restartAndVerify,
  unitContentHash,
  unloadThenReap,
  updateOsUnit,
  type EnableResult,
  type OsExec,
  type OsExecResult,
  type OsUnitSpec,
  type RestartAndVerifyResult,
  type RestartMatch,
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

// `over` is spread into deriveOsUnitSpec's OWN opts (id/scope/nodePath/env/...
// plus SA-1/SA-2 inputs like `activation_posture`/`socketPath`), not into the
// OsUnitSpec it returns — those are two different shapes (e.g. `socketPath`
// on the *returned* spec is conditionally derived, only set when
// `activation_posture === 'on-demand'`; `activation_posture` itself never
// appears on OsUnitSpec at all). `Partial<OsUnitSpec>` was the wrong type for
// this parameter — TS accepted it only because none of these call sites had
// been typechecked (no `typecheck` target existed for host-runtime before
// this fix; see CLAUDE.md's BL-248 note). Filed as BL-471.
function makeSpec(over: Partial<Parameters<typeof deriveOsUnitSpec>[0]> = {}): OsUnitSpec {
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

  it('BL-263: a sandboxed data root namespaces the label — a probe can never squat the production label', () => {
    const production = osUnitLabelFor('user', 'memory-server', undefined);
    expect(production).toBe('com.sox.user.memory-server');
    // Any SOX_ECOSYSTEM_HOME override → suffixed label, deterministic per root.
    const sandboxed = osUnitLabelFor('user', 'memory-server', '/tmp/soxe-probe3.XKSOoK/dataroot');
    expect(sandboxed).not.toBe(production);
    expect(sandboxed).toMatch(/^com\.sox\.user\.memory-server\.sbx-[0-9a-f]{8}$/);
    expect(osUnitLabelFor('user', 'memory-server', '/tmp/soxe-probe3.XKSOoK/dataroot')).toBe(sandboxed);
    // Distinct roots → distinct universes.
    expect(osUnitLabelFor('user', 'memory-server', '/tmp/other-root')).not.toBe(sandboxed);
    // osUnitLabel reads the override from the environment.
    const prev = process.env['SOX_ECOSYSTEM_HOME'];
    try {
      process.env['SOX_ECOSYSTEM_HOME'] = '/tmp/soxe-probe3.XKSOoK/dataroot';
      expect(osUnitLabel('user', 'memory-server')).toBe(sandboxed);
    } finally {
      if (prev === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
      else process.env['SOX_ECOSYSTEM_HOME'] = prev;
    }
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

  it('BL-156: execArgs overrides ProgramArguments while entrypoint stays the identity token', () => {
    // A serve_mode:proxy mcp-server runs the port-listening front-shim, not the
    // bare entrypoint. The BACKEND still runs `entrypoint`, so the reaper token
    // (spec.entrypoint) is preserved even though it is absent from the unit args.
    const cli = path.join(tmpDir, 'bin', 'soxe');
    const spec = makeSpec({
      execArgs: ['--enable-source-maps', cli, 'serve', 'memory-server', '--port', '3099'],
    });
    const plist = platform.render(spec);
    // The unit launches the front-shim on the port…
    expect(plist).toContain(`<string>${cli}</string>`);
    expect(plist).toContain('<string>serve</string>');
    expect(plist).toContain('<string>--port</string>');
    expect(plist).toContain('<string>3099</string>');
    // …and NOT the bare entrypoint as a ProgramArguments element.
    expect(plist).not.toContain(`<string>${spec.entrypoint}</string>`);
    // But the identity token is still carried on the spec for the reaper.
    expect(spec.entrypoint).toContain('dist/index.js');
    // execArgs changes the content hash (drift-proof re-enable).
    const bare = platform.render(makeSpec());
    expect(readUnitMeta(plist).contentHash).not.toBe(readUnitMeta(bare).contentHash);
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

// ─── BL-375 [inv:env-preserved-on-regenerate] — regeneration must never silently
// drop a previously-baked shell-sourced env key (PKT-38) ─────────────────────────

describe('BL-375 — enableOsUnit refuses to silently drop shell-sourced env on regenerate', () => {
  const platform = new LaunchdPlatform();

  it('AC1: a second enable that omits a previously-baked SOX_* key is BLOCKED — unit file untouched', () => {
    const fake1 = makeFakeExec();
    const first = makeSpec({ env: { SOX_CONFIG_DB_PATH: 'x', SOX_EMBED_DRAIN_FLOOR_MS: '30000' } });
    const r1 = enableOsUnit(first, platform, { unitDir, exec: fake1.exec, load: false });
    expect(r1.action).toBe('created');
    const bytesAfterFirst = fs.readFileSync(r1.unitPath, 'utf8');

    // Second enable: the SOX_EMBED_DRAIN_FLOOR_MS key is gone (as if
    // regenerated from a shell that no longer exports it), but an unrelated
    // field changes so
    // content-hash comparison alone would NOT be a no-op (mirrors the real
    // incident: a ProcessType/processType edit forced a rewrite).
    const second = makeSpec({
      env: { SOX_CONFIG_DB_PATH: 'x' },
      processType: 'Background',
    });
    const fake2 = makeFakeExec();
    const r2 = enableOsUnit(second, platform, { unitDir, exec: fake2.exec, load: false });

    expect(r2.action).toBe('blocked');
    expect(r2.droppedEnvKeys).toContain('SOX_EMBED_DRAIN_FLOOR_MS');
    // Nothing was overwritten — byte-identical to what the first call wrote.
    const bytesAfterSecond = fs.readFileSync(r1.unitPath, 'utf8');
    expect(bytesAfterSecond).toBe(bytesAfterFirst);
    // No launchctl call at all — the guard fires before any load/unload.
    expect(fake2.calls.length).toBe(0);
  });

  it('AC2: --unset acknowledgment lets the drop proceed, and the key is genuinely gone on disk', () => {
    const fake1 = makeFakeExec();
    const first = makeSpec({ env: { SOX_CONFIG_DB_PATH: 'x', SOX_EMBED_DRAIN_FLOOR_MS: '30000' } });
    enableOsUnit(first, platform, { unitDir, exec: fake1.exec, load: false });

    const second = makeSpec({ env: { SOX_CONFIG_DB_PATH: 'x' }, processType: 'Background' });
    const fake2 = makeFakeExec();
    const r2 = enableOsUnit(second, platform, {
      unitDir,
      exec: fake2.exec,
      load: false,
      unsetKeys: ['SOX_EMBED_DRAIN_FLOOR_MS'],
    });

    expect(r2.action).not.toBe('blocked');
    expect(r2.action).toBe('updated');
    const written = fs.readFileSync(r2.unitPath, 'utf8');
    const envOnDisk = extractUnitEnv(written, 'launchd');
    expect(envOnDisk['SOX_EMBED_DRAIN_FLOOR_MS']).toBeUndefined();
  });

  it('AC3 (guards D2): dropping a SOX_CONFIG_* key never blocks — config-cascade keys are exempt', () => {
    const fake1 = makeFakeExec();
    const first = makeSpec({ env: { SOX_CONFIG_DB_PATH: 'x', SOX_CONFIG_PORT: '4000' } });
    enableOsUnit(first, platform, { unitDir, exec: fake1.exec, load: false });

    // A legitimate `sox config unset` between calls — SOX_CONFIG_PORT is gone,
    // no --unset passed, but an unrelated field still forces a rewrite.
    const second = makeSpec({ env: { SOX_CONFIG_DB_PATH: 'x' }, processType: 'Background' });
    const fake2 = makeFakeExec();
    const r2 = enableOsUnit(second, platform, { unitDir, exec: fake2.exec, load: false });

    expect(r2.action).not.toBe('blocked');
    expect(r2.action).toBe('updated');
  });

  it('AC3 mutation guard: droppedShellEnvKeys must exclude SOX_CONFIG_*/SOX_PERM_* keys', () => {
    // A same-PR regression guard on the pure function directly (D2's losing
    // alternative is "diff everything, including SOX_CONFIG_*") — if the
    // prefix exclusion were ever widened away, this must go red.
    const prior = { SOX_CONFIG_PORT: '4000', SOX_PERM_ENFORCE: '1', SOX_EMBED_DRAIN_FLOOR_MS: '30000' };
    const next = { SOX_EMBED_DRAIN_FLOOR_MS: '30000' }; // both config + perm keys dropped
    expect(droppedShellEnvKeys(prior, next)).toEqual([]);
  });

  it('AC4: extractUnitEnv round-trips XML-escaped launchd env values', () => {
    const spec = makeSpec({ env: { SOX_CONFIG_X: 'a & b < c > d' } });
    const rendered = platform.render(spec);
    const parsed = extractUnitEnv(rendered, 'launchd');
    expect(parsed['SOX_CONFIG_X']).toBe('a & b < c > d');
  });

  it('AC4: extractUnitEnv round-trips systemd env values, splitting only on the FIRST =', () => {
    const systemd = new SystemdPlatform();
    const spec = makeSpec({ env: { SOX_CONFIG_X: 'a=b=c' } });
    const rendered = systemd.render(spec);
    const parsed = extractUnitEnv(rendered, 'systemd');
    expect(parsed['SOX_CONFIG_X']).toBe('a=b=c');
  });

  it('extractUnitEnv degrades to {} on a malformed/foreign unit rather than throwing (D7)', () => {
    expect(extractUnitEnv('not a unit file at all', 'launchd')).toEqual({});
    expect(extractUnitEnv('not a unit file at all', 'systemd')).toEqual({});
    expect(extractUnitEnv('<plist><dict></dict></plist>', 'launchd')).toEqual({});
  });

  it('the "unchanged" (content-identical) re-enable path is exempt — nothing could have been dropped', () => {
    const fake1 = makeFakeExec();
    const spec = makeSpec({ env: { SOX_CONFIG_DB_PATH: 'x', SOX_EMBED_DRAIN_FLOOR_MS: '30000' } });
    enableOsUnit(spec, platform, { unitDir, exec: fake1.exec, load: false });
    const fake2 = makeFakeExec();
    const r2 = enableOsUnit(spec, platform, { unitDir, exec: fake2.exec, load: false });
    expect(r2.action).toBe('unchanged');
  });
});

// ─── BL-259: consecutive smoke-test.mjs runs must never collide ──────────────────

describe('BL-259 — two smoke-test.mjs runs never hit "Bootstrap failed: 5"', () => {
  const platform = new LaunchdPlatform();

  it('smoke-test.mjs derives a unique SOX_ECOSYSTEM_HOME per timestamped run — labels never collide', () => {
    // scripts/smoke-test.mjs sets SOX_ECOSYSTEM_HOME to `<TEST_ROOT>/sox-data-root`,
    // where TEST_ROOT embeds an ISO timestamp — so two consecutive runs always pass
    // a DIFFERENT dataRootOverride to osUnitLabelFor (BL-263), which lands in two
    // different launchd labels that can never contend for the same bootstrap slot.
    const run1Root = '/repo/dist/smoke/run-2026-07-10T10-00-00/sox-data-root';
    const run2Root = '/repo/dist/smoke/run-2026-07-10T10-05-00/sox-data-root';
    const label1 = osUnitLabelFor('project', 'tokenguard', run1Root);
    const label2 = osUnitLabelFor('project', 'tokenguard', run2Root);
    expect(label1).not.toBe(label2);
  });

  it('even under a SHARED label, re-enabling a still-loaded unit (no disable in between) unloads before reloading — never a raw double-bootstrap', () => {
    // Defense in depth beyond BL-263's label namespacing: this is the ACTUAL
    // mechanism that stops `launchctl bootstrap` from returning "Bootstrap failed:
    // 5" (EIO — label already bootstrapped). BL-259 was filed against a run where a
    // prior smoke run's unit was left loaded and the next `service enable` — same
    // label, different content-hash because --root (and thus workingDirectory)
    // changed — collided. `enableOsUnit` treats a content change on an
    // already-loaded label as "unload stale, THEN reload", never a bare bootstrap
    // against a live label.
    const specForRoot = (root: string) => makeSpec({ workingDirectory: root });

    const fake1 = makeFakeExec();
    const run1 = enableOsUnit(specForRoot('/repo/dist/smoke/run-1'), platform, { unitDir, exec: fake1.exec, load: true });
    expect(run1.loaded).toBe(true);

    // Run 2: run 1's unit is STILL loaded (no disable happened — the exact
    // leftover-from-a-crashed-run scenario BL-259 describes) and the content
    // differs (new workingDirectory ⇒ new content-hash).
    const fake2 = makeFakeExec({ loaded: true });
    const run2 = enableOsUnit(specForRoot('/repo/dist/smoke/run-2'), platform, { unitDir, exec: fake2.exec, load: true });
    expect(run2.action).toBe('updated');
    expect(run2.loaded).toBe(true);

    // The critical ordering: bootout happens BEFORE the second bootstrap.
    const bootoutIdx = fake2.calls.findIndex((c) => c.args.includes('bootout'));
    const bootstrapIdx = fake2.calls.findIndex((c) => c.args.includes('bootstrap'));
    expect(bootoutIdx).toBeGreaterThanOrEqual(0);
    expect(bootstrapIdx).toBeGreaterThan(bootoutIdx);
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

// ─── SA-2: Socket-activation rendering (golden fixtures) ─────────────────────────

describe('SA-2 socket-activation rendering — launchd', () => {
  const platform = new LaunchdPlatform();

  it('on-demand posture includes Sockets dict in plist', () => {
    const spec = makeSpec({ activation_posture: 'on-demand', socketPath: '/tmp/test-on-demand.sock' });
    const plist = platform.render(spec);
    expect(plist).toContain('<key>Sockets</key>');
    expect(plist).toContain('<key>SockPathName</key>');
    expect(plist).toContain('<string>/tmp/test-on-demand.sock</string>');
    expect(plist).toContain('<integer>0600</integer>');
    expect(plist).toContain('SOCK_STREAM');
  });

  it('always-on posture (no socketPath) omits Sockets dict', () => {
    // `runAtLoad`/`keepAlive` are fields of the RETURNED OsUnitSpec, not of
    // deriveOsUnitSpec's opts — passing them here was always a no-op (opts has
    // no such fields; deriveOsUnitSpec computes them itself from the manifest
    // lifecycle block below, which already sets background:true/singleton:true
    // ⇒ runAtLoad/keepAlive both true, matching what this line redundantly
    // asked for). See BL-471.
    const spec = makeSpec({ socketPath: undefined });
    const plist = platform.render(spec);
    expect(plist).not.toContain('Sockets');
    expect(plist).not.toContain('SockPathName');
  });

  it('renderSocketUnit returns undefined (sockets are embedded)', () => {
    const spec = makeSpec({ socketPath: '/tmp/x.sock' });
    expect(platform.renderSocketUnit(spec)).toBeUndefined();
  });

  it('golden fixture: on-demand plist structure matches expected shape', () => {
    const spec = makeSpec({
      activation_posture: 'on-demand',
      socketPath: '/tmp/memory-daemon.sock',
      id: 'memory-daemon',
    });
    const plist = platform.render(spec);
    // Verify the structural ordering: Sockets dict appears before StandardOutPath.
    expect(plist.indexOf('Sockets')).toBeGreaterThan(0);
    expect(plist.indexOf('StandardOutPath')).toBeGreaterThan(plist.indexOf('Sockets'));
    // Verify the content hash is stable for identical specs.
    const hash1 = readUnitMeta(plist).contentHash;
    const hash2 = readUnitMeta(platform.render(spec)).contentHash;
    expect(hash1).toBe(hash2);
  });
});

describe('SA-2 socket-activation rendering — systemd', () => {
  const platform = new SystemdPlatform();

  it('renderSocketUnit with socketPath returns .socket unit with ListenStream, SocketMode, Service=', () => {
    const spec = makeSpec({ activation_posture: 'on-demand', socketPath: '/tmp/memory-daemon.sock' });
    const socketUnit = platform.renderSocketUnit(spec);
    expect(socketUnit).toBeDefined();
    expect(socketUnit!).toContain('[Socket]');
    expect(socketUnit!).toContain('ListenStream=/tmp/memory-daemon.sock');
    expect(socketUnit!).toContain('SocketMode=0600');
    expect(socketUnit!).toContain('Service=sox-user-memory-daemon.service');
    expect(socketUnit!).toContain('[Install]');
    expect(socketUnit!).toContain('WantedBy=sockets.target');
    // Must embed a content hash.
    expect(readUnitMeta(socketUnit!).contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('renderSocketUnit without socketPath returns undefined', () => {
    const spec = makeSpec({ socketPath: undefined });
    expect(platform.renderSocketUnit(spec)).toBeUndefined();
  });

  it('renderSocketUnit content-hash is stable for same spec, changes with different socketPath', () => {
    const spec1 = makeSpec({ activation_posture: 'on-demand', socketPath: '/tmp/a.sock' });
    const spec2 = makeSpec({ activation_posture: 'on-demand', socketPath: '/tmp/b.sock' });
    const u1 = platform.renderSocketUnit(spec1)!;
    const u2 = platform.renderSocketUnit(spec2)!;
    expect(readUnitMeta(u1).contentHash).not.toBe(readUnitMeta(u2).contentHash);
    // Same spec twice is stable.
    const u1b = platform.renderSocketUnit(spec1)!;
    expect(readUnitMeta(u1).contentHash).toBe(readUnitMeta(u1b).contentHash);
  });

  it('service unit (render) for on-demand posture does NOT contain socket config', () => {
    const spec = makeSpec({ activation_posture: 'on-demand', socketPath: '/tmp/x.sock' });
    const serviceUnit = platform.render(spec);
    // The service unit should NOT contain socket directives.
    expect(serviceUnit).not.toContain('ListenStream');
    expect(serviceUnit).not.toContain('SocketMode');
    // The socket config lives in the separate .socket unit.
    const socketUnit = platform.renderSocketUnit(spec);
    expect(socketUnit).toBeDefined();
    expect(socketUnit!).toContain('ListenStream');
  });

  it('golden fixture: socket unit filename convention', () => {
    const spec = makeSpec({ activation_posture: 'on-demand', socketPath: '/tmp/x.sock' });
    // The socket unit file should replace .service with .socket.
    const serviceName = platform.unitFileName(spec.label);
    expect(serviceName).toBe('sox-user-memory-daemon.service');
    // The socket unit name can be derived by replacing the suffix.
    const socketName = serviceName.replace(/\.service$/, '.socket');
    expect(socketName).toBe('sox-user-memory-daemon.socket');
    // The socket unit references the service by its unit name.
    const socketUnit = platform.renderSocketUnit(spec)!;
    expect(socketUnit).toContain(`Service=${serviceName}`);
  });
});

// ─── Slice 4: periodic tick rendering (StartInterval / .timer) ───────────────────

describe('Slice 4 periodic tick rendering — launchd StartInterval', () => {
  const platform = new LaunchdPlatform();

  it('startIntervalSec renders a StartInterval key and changes the content hash', () => {
    const tick = makeSpec({ startIntervalSec: 300 });
    const plist = platform.render(tick);
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>300</integer>');
    const plain = platform.render(makeSpec());
    expect(plain).not.toContain('StartInterval');
    expect(readUnitMeta(plist).contentHash).not.toBe(readUnitMeta(plain).contentHash);
  });

  it('deriveOsUnitSpec floors + drops non-positive intervals', () => {
    const derived = deriveOsUnitSpec({
      id: 'x', scope: 'user', manifestPath: '', nodePath: '/n', entrypoint: '/e.js',
      env: {}, workingDirectory: '/w', logDir, startIntervalSec: 60.9,
    });
    expect(derived.startIntervalSec).toBe(60);
    const none = deriveOsUnitSpec({
      id: 'x', scope: 'user', manifestPath: '', nodePath: '/n', entrypoint: '/e.js',
      env: {}, workingDirectory: '/w', logDir, startIntervalSec: 0,
    });
    expect(none.startIntervalSec).toBeUndefined();
  });

  it('an absent manifest (pseudo-unit like doctor-tick) derives runAtLoad=true, keepAlive=false', () => {
    const derived = deriveOsUnitSpec({
      id: 'doctor-tick', scope: 'user', manifestPath: path.join(tmpDir, 'no-such-manifest.json'),
      nodePath: '/n', entrypoint: '/cli/main.js', env: {}, workingDirectory: '/w', logDir,
      startIntervalSec: 300,
    });
    expect(derived.runAtLoad).toBe(true);
    expect(derived.keepAlive).toBe(false); // a tick job exits; launchd relaunches on interval
  });

  it('launchd renderTimerUnit is undefined (interval embedded in the plist)', () => {
    expect(platform.renderTimerUnit(makeSpec({ startIntervalSec: 300 }))).toBeUndefined();
  });
});

describe('Slice 4 periodic tick rendering — systemd .timer seam', () => {
  const platform = new SystemdPlatform();

  it('renderTimerUnit renders a content-addressed .timer paired to the service unit', () => {
    const spec = makeSpec({ startIntervalSec: 300 });
    const timer = platform.renderTimerUnit(spec);
    expect(timer).toBeDefined();
    expect(timer!).toContain('[Timer]');
    expect(timer!).toContain('OnBootSec=300');
    expect(timer!).toContain('OnUnitActiveSec=300');
    expect(timer!).toContain('Unit=sox-user-memory-daemon.service');
    expect(timer!).toContain('WantedBy=timers.target');
    expect(readUnitMeta(timer!).contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('renderTimerUnit is undefined without startIntervalSec; hash tracks the interval', () => {
    expect(platform.renderTimerUnit(makeSpec())).toBeUndefined();
    const a = platform.renderTimerUnit(makeSpec({ startIntervalSec: 300 }))!;
    const b = platform.renderTimerUnit(makeSpec({ startIntervalSec: 60 }))!;
    expect(readUnitMeta(a).contentHash).not.toBe(readUnitMeta(b).contentHash);
    const a2 = platform.renderTimerUnit(makeSpec({ startIntervalSec: 300 }))!;
    expect(readUnitMeta(a).contentHash).toBe(readUnitMeta(a2).contentHash);
  });
});

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

// ─── BL-185: isScheduledOsUnitContent / isScheduledOsUnit ──────────────────────

describe('BL-185 — isScheduledOsUnitContent (pure, schedule-key detection)', () => {
  it('detects launchd StartInterval key', () => {
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '  <key>Label</key><string>com.sox.user.doctor-tick</string>',
      '  <key>StartInterval</key><integer>300</integer>',
      '</dict></plist>',
    ].join('\n');
    expect(isScheduledOsUnitContent(plist)).toBe(true);
  });

  it('detects launchd StartCalendarInterval key', () => {
    const plist = [
      '<plist version="1.0"><dict>',
      '  <key>Label</key><string>com.sox.user.foo</string>',
      '  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>2</integer></dict>',
      '</dict></plist>',
    ].join('\n');
    expect(isScheduledOsUnitContent(plist)).toBe(true);
  });

  it('returns false for a long-lived service plist without schedule keys', () => {
    const plist = [
      '<plist version="1.0"><dict>',
      '  <key>Label</key><string>com.sox.user.memory-server</string>',
      '  <key>KeepAlive</key><true/>',
      '  <key>RunAtLoad</key><true/>',
      '</dict></plist>',
    ].join('\n');
    expect(isScheduledOsUnitContent(plist)).toBe(false);
  });

  it('detects systemd timer OnUnitActiveSec directive', () => {
    const timerUnit = [
      '[Unit]',
      'Description=SOX doctor tick timer',
      '[Timer]',
      'OnBootSec=300',
      'OnUnitActiveSec=300',
      '[Install]',
      'WantedBy=timers.target',
    ].join('\n');
    expect(isScheduledOsUnitContent(timerUnit)).toBe(true);
  });

  it('detects systemd timer OnCalendar directive', () => {
    const timerUnit = '[Timer]\nOnCalendar=*:0/5\n';
    expect(isScheduledOsUnitContent(timerUnit)).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isScheduledOsUnitContent('')).toBe(false);
  });

  it('returns false for a plain systemd .service unit with no timer directives', () => {
    const serviceUnit = '[Service]\nExecStart=/usr/local/bin/node /foo/bar.js\n';
    expect(isScheduledOsUnitContent(serviceUnit)).toBe(false);
  });
});

describe('BL-185 — isScheduledOsUnit (file-based, additive)', () => {
  it('returns true when the unit file contains StartInterval', () => {
    const plist = '<plist><dict><key>StartInterval</key><integer>300</integer></dict></plist>';
    const unitFile = path.join(tmpDir, 'com.sox.user.tick.plist');
    fs.writeFileSync(unitFile, plist);
    expect(isScheduledOsUnit(unitFile)).toBe(true);
  });

  it('returns false when the unit file is a long-lived service (no schedule key)', () => {
    const plist = '<plist><dict><key>KeepAlive</key><true/></dict></plist>';
    const unitFile = path.join(tmpDir, 'com.sox.user.server.plist');
    fs.writeFileSync(unitFile, plist);
    expect(isScheduledOsUnit(unitFile)).toBe(false);
  });

  it('returns false for a non-existent unit file (additive — never throws)', () => {
    expect(isScheduledOsUnit(path.join(tmpDir, 'does-not-exist.plist'))).toBe(false);
  });

  it('returns true for a systemd .service when the paired .timer carries OnUnitActiveSec', () => {
    const serviceUnit = '[Service]\nExecStart=/usr/local/bin/node /foo/bar.js\n';
    const timerUnit = '[Timer]\nOnBootSec=300\nOnUnitActiveSec=300\n';
    const servicePath = path.join(tmpDir, 'sox-user-tick.service');
    const timerPath = path.join(tmpDir, 'sox-user-tick.timer');
    fs.writeFileSync(servicePath, serviceUnit);
    fs.writeFileSync(timerPath, timerUnit);
    expect(isScheduledOsUnit(servicePath)).toBe(true);
  });

  it('returns false for a systemd .service when the paired .timer is absent', () => {
    const serviceUnit = '[Service]\nExecStart=/usr/local/bin/node /foo/bar.js\n';
    const servicePath = path.join(tmpDir, 'sox-user-server.service');
    fs.writeFileSync(servicePath, serviceUnit);
    expect(isScheduledOsUnit(servicePath)).toBe(false);
  });
});

// ─── BL-331: ProcessType must be manifest-driven, not hardcoded Background ───────

describe('BL-331 — launchd ProcessType is service-kind aware', () => {
  const platform = new LaunchdPlatform();

  // WHY THIS EXISTS: `ProcessType: Background` was emitted unconditionally for
  // EVERY sox unit. launchd.plist(5): "Background jobs are generally processes
  // that do work that was not directly requested by the user. The resource
  // limits applied to Background jobs are intended to prevent them from
  // disrupting the user experience." On Apple Silicon that means efficiency
  // cores + I/O throttling. Measured on the live memory-server: scheduling
  // priority 4 instead of 31, and an interleaved A/B put real ONNX embedding at
  // ~470 ms (pri 31) vs ~8400 ms (pri 4) — an 18x throttle on a service whose
  // whole job is answering interactive agent requests.

  it('does NOT mark a long-lived service as Background (BL-331)', () => {
    const plist = platform.render(makeSpec());
    expect(plist).toContain('<key>ProcessType</key>');
    expect(plist).not.toContain('<string>Background</string>');
    expect(plist).toContain('<string>Standard</string>');
  });

  it('DOES mark a periodic tick unit as Background (BL-331)', () => {
    // The doctor reconcile tick is exactly the "work not directly requested by
    // the user" launchd.plist(5) describes — Background is correct here.
    const plist = platform.render(makeSpec({ startIntervalSec: 300 }));
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<string>Background</string>');
  });

  it('honours an explicit manifest-declared process_type over the default (BL-331)', () => {
    const mp = path.join(tmpDir, 'extension-interactive.json');
    fs.writeFileSync(
      mp,
      JSON.stringify({
        id: 'memory-daemon',
        type: 'service',
        lifecycle: { background: true, singleton: true, process_type: 'Interactive' },
      }),
    );
    const spec = deriveOsUnitSpec({
      id: 'memory-daemon', scope: 'user', manifestPath: mp, nodePath: '/n',
      entrypoint: '/e.js', env: {}, workingDirectory: '/w', logDir,
    });
    expect(spec.processType).toBe('Interactive');
    expect(platform.render(spec)).toContain('<string>Interactive</string>');
  });

  it('rejects a process_type the OS does not define, rather than emitting it (BL-331)', () => {
    const mp = path.join(tmpDir, 'extension-bogus.json');
    fs.writeFileSync(
      mp,
      JSON.stringify({ id: 'x', type: 'service', lifecycle: { process_type: 'Turbo' } }),
    );
    const spec = deriveOsUnitSpec({
      id: 'x', scope: 'user', manifestPath: mp, nodePath: '/n',
      entrypoint: '/e.js', env: {}, workingDirectory: '/w', logDir,
    });
    // Unknown value falls back to the kind-derived default; it is never emitted.
    expect(spec.processType).toBe('Standard');
    expect(platform.render(spec)).not.toContain('Turbo');
  });

  it('systemd parity: only a Background unit is de-prioritised with Nice (BL-331)', () => {
    const sysd = new SystemdPlatform();
    expect(sysd.render(makeSpec())).not.toContain('Nice=');
    expect(sysd.render(makeSpec({ startIntervalSec: 300 }))).toContain('Nice=10');
  });
});

// ─── BL-372/§9.4a: [inv:deploy-verified] — restartAndVerify ─────────────────────
//
// A `kickstart -k` restarts the front-shim proxy, but the zero-downtime backend it
// keeps alive across restarts (§9.5) can survive as a `PPID 1` orphan still
// executing the OLD bundle — a kickstart exit code of 0 is NOT evidence of a
// deploy. These tests drive `restartAndVerify` entirely through its injectable
// seams (`exec`, `findMatches`, `reapFn`, `sleepFn`) — no real process table, no
// real launchctl/systemctl — and prove BOTH arms of the invariant:
//
//   RED  — the backend survives the reap / never rotates → `ok:false`, non-zero.
//   GREEN — a genuinely new pid appears for the token       → `ok:true`, zero.
describe('restartAndVerify — BL-372 [inv:deploy-verified]', () => {
  const platform = new LaunchdPlatform();
  const label = 'com.sox.user.memory-server';
  const token = '/store/memory-server/dist/index.js';

  function fakeExec(kickstartCode = 0): OsExec {
    return (_cmd, args) => ({
      code: args.includes('kickstart') ? kickstartCode : 0,
      stdout: '',
      stderr: '',
    });
  }

  it('RED — kickstart succeeds but the old backend survives the reap (undead): fails, does not report rotation', async () => {
    // The backend (pid 111) never dies — killAndVerify's honest 'undead' outcome.
    const findMatches = (): RestartMatch[] => [{ pid: 111 }];
    const reapFn = async (tok: string): Promise<ReapResult> => ({
      token: tok,
      killed: [{ pid: 111, ppid: 1, orphaned: true, outcome: 'undead' }],
    });

    const result = await restartAndVerify({
      label,
      token,
      platform,
      exec: fakeExec(),
      findMatches,
      reapFn,
      waitMs: 50,
    });

    expect(result.ok).toBe(false);
    expect(result.rotated).toBe(false);
    expect(result.undead).toEqual([111]);
    expect(result.reason).toMatch(/undead/);
  });

  it('RED — kickstart succeeds, reap clears the old survivor, but NOTHING new ever appears (no respawn): fails with [inv:deploy-verified] violated', async () => {
    // This is the exact BL-372 no-op-deploy shape: same pid set before AND after —
    // the unit "restarted" (kickstart exit 0) but the running process never changed.
    const findMatches = (): RestartMatch[] => [{ pid: 222 }];
    const reapFn = async (tok: string): Promise<ReapResult> => ({
      token: tok,
      killed: [{ pid: 222, ppid: 1, orphaned: true, outcome: 'already-dead' }],
    });

    const result = await restartAndVerify({
      label,
      token,
      platform,
      exec: fakeExec(),
      findMatches,
      reapFn,
      waitMs: 50,
      pollMs: 10,
      sleepFn: async () => { /* instant — no real timers in the test */ },
    });

    expect(result.ok).toBe(false);
    expect(result.rotated).toBe(false);
    expect(result.before).toEqual([222]);
    expect(result.after).toEqual([222]); // same pid — nothing rotated
    expect(result.reason).toMatch(/\[inv:deploy-verified\] violated/);
  });

  it('RED — kickstart itself fails: fails immediately, no reap attempted', async () => {
    let reapCalled = false;
    const findMatches = (): RestartMatch[] => [];
    const reapFn = async (tok: string): Promise<ReapResult> => {
      reapCalled = true;
      return { token: tok, killed: [] };
    };

    const result = await restartAndVerify({
      label,
      token,
      platform,
      exec: fakeExec(1), // launchctl kickstart exits non-zero
      findMatches,
      reapFn,
      waitMs: 50,
    });

    expect(result.ok).toBe(false);
    expect(result.kickstart.code).toBe(1);
    expect(reapCalled).toBe(false);
    expect(result.reason).toMatch(/kickstart FAILED/);
  });

  it('GREEN — the backend rotates to a genuinely new pid after the reap: succeeds, exit-code-mapped ok:true', async () => {
    // Simulate the real recovery sequence: before=[333] (old bundle), reap kills
    // it, and polling observes the respawned backend at a NEW pid (444, new bundle).
    let pollCount = 0;
    const findMatches = (): RestartMatch[] => {
      pollCount += 1;
      // First call is the "before" snapshot (old pid still there); every call
      // after the reap sees the new pid.
      return pollCount === 1 ? [{ pid: 333 }] : [{ pid: 444 }];
    };
    const reapFn = async (tok: string): Promise<ReapResult> => ({
      token: tok,
      killed: [{ pid: 333, ppid: 1, orphaned: true, outcome: 'term' }],
    });

    const result = await restartAndVerify({
      label,
      token,
      platform,
      exec: fakeExec(),
      findMatches,
      reapFn,
      waitMs: 1000,
      pollMs: 10,
      sleepFn: async () => { /* instant */ },
    });

    expect(result.ok).toBe(true);
    expect(result.rotated).toBe(true);
    expect(result.before).toEqual([333]);
    expect(result.after).toEqual([444]);
    expect(result.reason).toBeUndefined();
  });

  it('GREEN — a direct-mode service (no proxy split) rotates on the very first post-reap poll', async () => {
    // For a plain `service` (not mcp-server proxy-mode), the OS unit IS the
    // managed process — kickstart alone gives it a fresh pid immediately.
    let calls = 0;
    const findMatches = (): RestartMatch[] => {
      calls += 1;
      return calls === 1 ? [{ pid: 55 }] : [{ pid: 999 }];
    };
    const reapFn = async (tok: string): Promise<ReapResult> => ({ token: tok, killed: [] });

    const result = await restartAndVerify({
      label: 'com.sox.user.memory-daemon',
      token: '/store/memory-daemon/dist/index.js',
      platform,
      exec: fakeExec(),
      findMatches,
      reapFn,
      waitMs: 1000,
      sleepFn: async () => { /* instant */ },
    });

    expect(result.ok).toBe(true);
    expect(result.after).toEqual([999]);
  });
});

// ─── BL-593/§9.4b: `updateOsUnit` — `soxe service update`, enable + verified rotation ──
//
// `update` = `enableOsUnit` FOLLOWED BY a verified rotation check whenever the
// enable step's content actually changed, reusing `restartAndVerify` verbatim.
// These tests drive `updateOsUnit` entirely through its injectable seams
// (`enableFn`, `restartFn`) — no real fs write, no real launchctl/systemctl call —
// and prove every branch of the decision tree the spec's §9.4b pseudocode lays out:
//
//   blocked    — BL-375 guard fired: ok:false, restartFn is NEVER called.
//   unchanged  — nothing to reconcile: ok:true, restartFn is NEVER called.
//   dry-run    — content WOULD change but load:false: ok:true, wouldRotate:true,
//                restartFn is NEVER called (mirrors `enable --dry-run`).
//   RED        — content changed, load:true, but the rotation-verify reports
//                `ok:false` (the backend never adopted the new config — the exact
//                false-positive §9.4b exists to close): updateOsUnit must NOT
//                report success. This is the case a bare re-`enable` could not
//                catch and BL-593 exists to prevent.
//   GREEN      — content changed, load:true, rotation-verify reports `ok:true`
//                (a genuinely new pid appeared): updateOsUnit reports success with
//                the rotated pid evidence attached.
describe('updateOsUnit — BL-593 [inv:deploy-verified] extended to config drift (§9.4b)', () => {
  const platform = new LaunchdPlatform();
  // A static spec (NOT `makeSpec()` — that helper writes a manifest under the
  // `beforeEach`-created `tmpDir`, which does not exist at describe-body
  // evaluation time). Every test here drives `updateOsUnit` purely through its
  // `enableFn`/`restartFn` seams, so the spec's exact field values are inert —
  // only `spec.label` is asserted on downstream.
  const spec: OsUnitSpec = {
    id: 'test-daemon',
    scope: 'user',
    label: 'com.sox.user.test-daemon',
    nodePath: '/usr/bin/node',
    nodeArgs: ['--enable-source-maps'],
    entrypoint: '/store/test/dist/index.js',
    env: {},
    workingDirectory: '/store/test',
    runAtLoad: true,
    keepAlive: true,
    throttleIntervalSec: 10,
    stdoutPath: '/logs/test.out.log',
    stderrPath: '/logs/test.err.log',
  };

  function makeEnableResult(action: EnableResult['action'], over: Partial<EnableResult> = {}): EnableResult {
    return {
      action,
      unitPath: '/units/com.sox.user.test.plist',
      label: spec.label,
      contentHash: 'deadbeefcafef00d',
      loaded: action !== 'blocked',
      ...over,
    };
  }

  function makeRestartResult(over: Partial<RestartAndVerifyResult> = {}): RestartAndVerifyResult {
    return {
      label: spec.label,
      token: '/store/test/dist/index.js',
      kickstart: { code: 0, stdout: '', stderr: '' },
      before: [111],
      after: [222],
      reap: { token: '/store/test/dist/index.js', killed: [] },
      undead: [],
      rotated: true,
      ok: true,
      ...over,
    };
  }

  it('blocked (BL-375 guard fired) — reports ok:false without ever invoking restartFn', async () => {
    let restartCalled = false;
    const enableFn = (): EnableResult => makeEnableResult('blocked', {
      droppedEnvKeys: ['SOX_CONFIG_FOO'],
    });
    const restartFn = async (): Promise<RestartAndVerifyResult> => {
      restartCalled = true;
      return makeRestartResult();
    };

    const result = await updateOsUnit(spec, platform, {
      load: true,
      token: '/store/test/dist/index.js',
      enableFn,
      restartFn,
    });

    expect(result.action).toBe('blocked');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/env-preserved-on-regenerate/);
    expect(result.restart).toBeUndefined();
    expect(restartCalled).toBe(false);
  });

  it('unchanged — nothing to reconcile: ok:true, restartFn is NEVER invoked', async () => {
    let restartCalled = false;
    const enableFn = (): EnableResult => makeEnableResult('unchanged');
    const restartFn = async (): Promise<RestartAndVerifyResult> => {
      restartCalled = true;
      return makeRestartResult();
    };

    const result = await updateOsUnit(spec, platform, {
      load: true,
      token: '/store/test/dist/index.js',
      enableFn,
      restartFn,
    });

    expect(result.action).toBe('unchanged');
    expect(result.ok).toBe(true);
    expect(result.restart).toBeUndefined();
    expect(restartCalled).toBe(false);
  });

  it('dry-run (load:false) — content would change but nothing is loaded/kickstarted: ok:true, wouldRotate:true, restartFn NEVER invoked', async () => {
    let restartCalled = false;
    const enableFn = (): EnableResult => makeEnableResult('updated');
    const restartFn = async (): Promise<RestartAndVerifyResult> => {
      restartCalled = true;
      return makeRestartResult();
    };

    const result = await updateOsUnit(spec, platform, {
      load: false,
      token: '/store/test/dist/index.js',
      enableFn,
      restartFn,
    });

    expect(result.action).toBe('updated');
    expect(result.ok).toBe(true);
    expect(result.wouldRotate).toBe(true);
    expect(result.restart).toBeUndefined();
    expect(restartCalled).toBe(false);
  });

  it('RED — content changed, unit reloaded, but the backend never rotates (rotation-verify ok:false): updateOsUnit reports ok:false, NOT success', async () => {
    // This is the exact §9.4b gap: `enableOsUnit` alone would have reported a
    // successful reload of the FRONT-SHIM unit while the persistent, independently
    // detached BACKEND (§8.6/§9.5) — which never re-reads its env except at its own
    // next spawn — is still running under the OLD config. A bare re-`enable` cannot
    // see this; `updateOsUnit` MUST catch it via the same rotation-verify §9.4a uses.
    const enableFn = (): EnableResult => makeEnableResult('updated');
    const restartFn = async (): Promise<RestartAndVerifyResult> => makeRestartResult({
      ok: false,
      rotated: false,
      before: [111],
      after: [111], // same pid — the backend never rotated onto the new config
      reason: '[inv:deploy-verified] violated: no pid rotated within 50ms (before=[111] after=[111])',
    });

    const result = await updateOsUnit(spec, platform, {
      load: true,
      token: '/store/test/dist/index.js',
      waitMs: 50,
      enableFn,
      restartFn,
    });

    expect(result.action).toBe('updated');
    expect(result.ok).toBe(false);
    expect(result.restart).toBeDefined();
    expect(result.restart!.ok).toBe(false);
    expect(result.reason).toMatch(/did not rotate/);
    expect(result.reason).toMatch(/\[inv:deploy-verified\] violated/);
  });

  it('GREEN — content changed, unit reloaded, and the backend rotates to a genuinely new pid: updateOsUnit reports success with the rotation evidence', async () => {
    const enableFn = (): EnableResult => makeEnableResult('updated');
    const restartFn = async (): Promise<RestartAndVerifyResult> => makeRestartResult({
      before: [111],
      after: [222],
      rotated: true,
      ok: true,
    });

    const result = await updateOsUnit(spec, platform, {
      load: true,
      token: '/store/test/dist/index.js',
      enableFn,
      restartFn,
    });

    expect(result.action).toBe('updated');
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.restart).toBeDefined();
    expect(result.restart!.before).toEqual([111]);
    expect(result.restart!.after).toEqual([222]);
  });

  it('created (first-ever enable under `update`) is treated identically to `updated` — still verified', async () => {
    const enableFn = (): EnableResult => makeEnableResult('created');
    const restartFn = async (): Promise<RestartAndVerifyResult> => makeRestartResult({ ok: true, rotated: true });

    const result = await updateOsUnit(spec, platform, {
      load: true,
      token: '/store/test/dist/index.js',
      enableFn,
      restartFn,
    });

    expect(result.action).toBe('created');
    expect(result.ok).toBe(true);
    expect(result.restart).toBeDefined();
  });

  it('passes the token, exec, waitMs, pollMs, excludePids, and identity seams straight through to restartFn', async () => {
    let seen: Parameters<typeof restartAndVerify>[0] | undefined;
    const fakeExec: OsExec = () => ({ code: 0, stdout: '', stderr: '' });
    const findMatches = (): RestartMatch[] => [];
    const reapFn = async (tok: string): Promise<ReapResult> => ({ token: tok, killed: [] });
    const sleepFn = async (): Promise<void> => { /* instant */ };

    const enableFn = (): EnableResult => makeEnableResult('updated');
    const restartFn = async (opts: Parameters<typeof restartAndVerify>[0]): Promise<RestartAndVerifyResult> => {
      seen = opts;
      return makeRestartResult();
    };

    await updateOsUnit(spec, platform, {
      load: true,
      token: '/store/test/dist/index.js',
      exec: fakeExec,
      waitMs: 1234,
      pollMs: 56,
      excludePids: [999],
      findMatches,
      reapFn,
      sleepFn,
      enableFn,
      restartFn,
    });

    expect(seen).toBeDefined();
    expect(seen!.token).toBe('/store/test/dist/index.js');
    expect(seen!.exec).toBe(fakeExec);
    expect(seen!.waitMs).toBe(1234);
    expect(seen!.pollMs).toBe(56);
    expect(seen!.excludePids).toEqual([999]);
    expect(seen!.findMatches).toBe(findMatches);
    expect(seen!.reapFn).toBe(reapFn);
    expect(seen!.sleepFn).toBe(sleepFn);
  });
});

// ─── BL-584: the unit stamps its own service identity ────────────────────────
//
// RED→GREEN proof (BL-225): with `env: opts.env` (pre-fix), both assertions
// below fail — `SOX_SERVICE_ID` is absent from the spec and from the rendered
// unit on disk. With `env: { ...opts.env, SOX_SERVICE_ID: opts.id }` they pass.
//
// Why this matters beyond tidiness: the in-process supervisor already sets
// `SOX_SERVICE_ID` on every service it spawns, so before this fix the SAME
// extension saw a DIFFERENT environment depending on which supervisor started
// it, and an OS-unit service had no supervisor-authoritative way to know it
// was running as a service. tokenguard consequently inferred its mode from the
// absence of `SOX_CONFIG_PORT`, matched the MCP-exec branch under launchd
// (where stdin is never a TTY), read EOF and exited 0 — reported as
// `loaded: yes` / `live pids: (none)`.
describe('BL-584 — OS units carry SOX_SERVICE_ID', () => {
  it('buildUnitSpec puts the service id in the unit environment', () => {
    const spec = makeSpec({ env: { SOX_CONFIG_DB_PATH: 'x' } });
    expect(spec.env['SOX_SERVICE_ID']).toBe(spec.id);
  });

  it('the rendered launchd unit exposes SOX_SERVICE_ID to the spawned process', () => {
    const spec = makeSpec({ env: { SOX_CONFIG_DB_PATH: 'x' } });
    const rendered = new LaunchdPlatform().render(spec);
    const env = extractUnitEnv(rendered, 'launchd');
    expect(env['SOX_SERVICE_ID']).toBe(spec.id);
  });

  it('the rendered systemd unit exposes SOX_SERVICE_ID too', () => {
    const spec = makeSpec({ env: { SOX_CONFIG_DB_PATH: 'x' } });
    const rendered = new SystemdPlatform().render(spec);
    expect(rendered).toContain(`Environment=SOX_SERVICE_ID=${spec.id}`);
  });

  it('does not clobber caller-supplied config env', () => {
    const spec = makeSpec({ env: { SOX_CONFIG_DB_PATH: 'x', SOX_CONFIG_PORT: '4000' } });
    expect(spec.env['SOX_CONFIG_DB_PATH']).toBe('x');
    expect(spec.env['SOX_CONFIG_PORT']).toBe('4000');
    expect(spec.env['SOX_SERVICE_ID']).toBe(spec.id);
  });
});

describe('BL-592 (§8.1a part A/B) — deriveOsUnitSpec reads lifecycle.stop_timeout_ms', () => {
  it('RED (pre-fix behavior would be: spec.stopTimeoutMs is always undefined) — carries a declared stop_timeout_ms onto the returned spec', () => {
    const manifestPath = writeManifest({ background: true, singleton: true, stop_timeout_ms: 9000 });
    const spec = deriveOsUnitSpec({
      id: 'memory-daemon',
      scope: 'user',
      manifestPath,
      nodePath: '/usr/local/bin/node',
      entrypoint: path.join(tmpDir, 'ext', 'memory-daemon', 'dist', 'index.js'),
      env: { SOX_CONFIG_DB_PATH: 'x' },
      workingDirectory: path.join(tmpDir, 'ext', 'memory-daemon'),
      logDir,
    });
    expect(spec.stopTimeoutMs).toBe(9000);
  });

  it('a manifest declaring nothing leaves spec.stopTimeoutMs undefined (unchanged default preserved)', () => {
    const manifestPath = writeManifest({ background: true, singleton: true });
    const spec = deriveOsUnitSpec({
      id: 'memory-daemon',
      scope: 'user',
      manifestPath,
      nodePath: '/usr/local/bin/node',
      entrypoint: path.join(tmpDir, 'ext', 'memory-daemon', 'dist', 'index.js'),
      env: { SOX_CONFIG_DB_PATH: 'x' },
      workingDirectory: path.join(tmpDir, 'ext', 'memory-daemon'),
      logDir,
    });
    expect(spec.stopTimeoutMs).toBeUndefined();
  });

  it('an untrusted/invalid stop_timeout_ms (string, 0, negative) is ignored, not coerced', () => {
    for (const bad of ['9000', 0, -500, null]) {
      const manifestPath = writeManifest({ background: true, singleton: true, stop_timeout_ms: bad });
      const spec = deriveOsUnitSpec({
        id: 'memory-daemon',
        scope: 'user',
        manifestPath,
        nodePath: '/usr/local/bin/node',
        entrypoint: path.join(tmpDir, 'ext', 'memory-daemon', 'dist', 'index.js'),
        env: { SOX_CONFIG_DB_PATH: 'x' },
        workingDirectory: path.join(tmpDir, 'ext', 'memory-daemon'),
        logDir,
      });
      expect(spec.stopTimeoutMs).toBeUndefined();
    }
  });

  it('RED (pre-fix: SOX_CONFIG_STOP_TIMEOUT_MS was never injected) — always stamps the resolved value into spec.env as SOX_CONFIG_STOP_TIMEOUT_MS (part B)', () => {
    const withDeclared = makeSpec({ env: { SOX_CONFIG_DB_PATH: 'x' } }); // makeSpec's manifest declares stop_timeout_ms:5000
    expect(withDeclared.env['SOX_CONFIG_STOP_TIMEOUT_MS']).toBe('5000');

    const manifestPath = writeManifest({ background: true, singleton: true, stop_timeout_ms: 9000 });
    const spec = deriveOsUnitSpec({
      id: 'memory-daemon',
      scope: 'user',
      manifestPath,
      nodePath: '/usr/local/bin/node',
      entrypoint: path.join(tmpDir, 'ext', 'memory-daemon', 'dist', 'index.js'),
      env: { SOX_CONFIG_DB_PATH: 'x' },
      workingDirectory: path.join(tmpDir, 'ext', 'memory-daemon'),
      logDir,
    });
    expect(spec.env['SOX_CONFIG_STOP_TIMEOUT_MS']).toBe('9000');
  });

  it('a manifest declaring nothing still stamps the 5000ms fallback (a service never has to guess whether the var is set)', () => {
    const manifestPath = writeManifest({ background: true, singleton: true });
    const spec = deriveOsUnitSpec({
      id: 'memory-daemon',
      scope: 'user',
      manifestPath,
      nodePath: '/usr/local/bin/node',
      entrypoint: path.join(tmpDir, 'ext', 'memory-daemon', 'dist', 'index.js'),
      env: { SOX_CONFIG_DB_PATH: 'x' },
      workingDirectory: path.join(tmpDir, 'ext', 'memory-daemon'),
      logDir,
    });
    expect(spec.env['SOX_CONFIG_STOP_TIMEOUT_MS']).toBe('5000');
  });
});
