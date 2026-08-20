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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  osUnitLabelFor,
  updateOsUnit,
  restartAndVerify,
  LaunchdPlatform,
  identityToken,
} from '@adhd/sox-host-runtime';
import type { OsExec, OsExecResult, OsUnitSpec, RestartMatch } from '@adhd/sox-host-runtime';

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
  it('on a never-enabled extension: PREVIEWS action would-create, writes NOTHING (true render-only, BUG-SOX-DRYRUN-CLAIMS-UNIT-UPDATED-001) and issues NO launchctl call', () => {
    // BUG-SOX-DRYRUN-CLAIMS-UNIT-UPDATED-001 (upgraded to CRITICAL 2026-08-20):
    // `service update --dry-run` used to WRITE the rendered unit to disk (only
    // skipping the launchctl load) — against a real target that repointed a
    // LIVE production LaunchAgent plist a --dry-run preview was never supposed
    // to touch. Fixed upstream in `enableOsUnit`'s `EnableOptions.dryRun` seam
    // (`libs/host-runtime/src/os-unit.ts`, threaded through by `updateOsUnit`
    // whenever `load !== true`) — a preview must render + hash + classify the
    // action WITHOUT ever calling `writeFileAtomic`. This test asserts the
    // fixed contract: the preview text still names the action ('created') but
    // NOTHING lands on disk.
    const realLaunchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label()}.plist`);
    const before = fs.existsSync(realLaunchAgents);

    const r = runCli(['service', 'update', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('created');
    expect(r.stdout).toContain('--dry-run');
    expect(r.stdout).toMatch(/would verify pid/);

    const unitPath = path.join(unitDir, `${label()}.plist`);
    expect(fs.existsSync(unitPath)).toBe(false);

    // the REAL LaunchAgents dir was never touched
    expect(fs.existsSync(realLaunchAgents)).toBe(before);
  });

  it('re-running update --dry-run against unchanged content reports "no change" (baseline seeded via a REAL on-disk write, not a --dry-run phantom one)', () => {
    // A true render-only --dry-run (see the test above) never persists
    // anything, so two consecutive `update --dry-run` calls can no longer
    // observe each other — that was only ever possible because of the bug
    // this file's other test now guards against. "Unchanged" must be judged
    // against REAL on-disk content, so seed one the same way an operator's
    // first real deploy would: `service enable --dry-run` (unchanged by this
    // fix — see BUG-SOX-DRYRUN-CLAIMS-UNIT-UPDATED-001's body, its `--dry-run`
    // writes the unit but still skips the launchctl load, exactly the harness
    // primitive every other test in this file already relies on for a
    // launchctl-free real write).
    runCli(['service', 'enable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    const r2 = runCli(['service', 'update', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain('no change');
  });

  it('a manifest content change (new stop_timeout_ms) is detected as an update on the next --dry-run', () => {
    // Same real-baseline seeding as above.
    runCli(['service', 'enable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);

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

    // And the fixed render-only contract still holds: even detecting a real
    // content diff, the --dry-run preview must not overwrite the seeded unit.
    const unitPath = path.join(unitDir, `${label()}.plist`);
    const seededContent = fs.readFileSync(unitPath, 'utf8');
    expect(seededContent).not.toContain('9999'); // the NEW stop_timeout_ms never got written
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

// ─── Acceptance criteria 2/3/4 — driven through the SAME `updateOsUnit` seam
// `cmdServiceUpdate` calls in `apps/sox/src/main.ts` (§9.4b), unmocked at the
// `enableOsUnit`/`restartAndVerify` layer (the default `enableFn`/`restartFn`
// updateOsUnit uses when the caller omits them — the exact composition
// `cmdServiceUpdate` invokes for a real, non-`--dry-run` `service update`).
//
// The CLI-level tests above stay `--dry-run`-only (see file header — a live
// run's `cmdServiceUpdate` always drives `realOsExec`, which would touch the
// REAL `launchctl`, forbidden in an automated suite). These tests get the
// exact same "did the real content-diff/restart machinery run, not a stub"
// coverage WITHOUT a CLI subprocess by calling `updateOsUnit` in-process with
// a real `LaunchdPlatform` + a sandboxed unit dir + an injected FAKE `exec`
// (never `realOsExec`) — the identical injection seam `os-unit.spec.ts`'s own
// `updateOsUnit` describe block uses, just exercising the REAL `enableOsUnit`
// content-hash diff and the REAL `restartAndVerify` pid-rotation polling
// (itself given injected `findMatches`/`reapFn`/`sleepFn`) instead of stubbing
// them out — proving the actual composition wired into `cmdServiceUpdate`,
// not a re-description of it.
describe('updateOsUnit via cmdServiceUpdate\'s real composition — BL-593 criteria 2/3/4 (no CLI subprocess, no real launchctl)', () => {
  let updDir: string;
  let stdoutDir: string;

  function makeFakeExec(loaded: { value: boolean }): OsExec {
    // Models `launchctl print`/`bootstrap`/`bootout`/`kickstart` — every call
    // succeeds (code 0); `print` reflects `loaded.value` so `isLoaded`/`unload`
    // behave like a real, currently-loaded unit without ever shelling out.
    return (cmd: string, args: string[]): OsExecResult => {
      expect(cmd).toBe('launchctl'); // never any other binary — proves no real process spawn slips through
      const sub = args[0];
      if (sub === 'print') {
        return loaded.value
          ? { code: 0, stdout: '\tpath = /fake/unit.plist\n', stderr: '' }
          : { code: 1, stdout: '', stderr: 'Could not find service' };
      }
      if (sub === 'bootstrap') {
        loaded.value = true;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (sub === 'bootout') {
        loaded.value = false;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (sub === 'kickstart') {
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected launchctl subcommand in test fake: ${sub}`);
    };
  }

  // A proxy-mode mcp-server-shaped spec — the exact scenario criterion 2 names.
  // `token` (computed below via `identityToken(entrypoint)`, at each call site)
  // is derived from the SAME `spec.entrypoint` `cmdServiceUpdate` passes to
  // `identityToken(ctx.entrypoint)` — per §9.4b's design note in
  // `apps/sox/src/main.ts` `cmdServiceUpdate`, that one manifest entrypoint is
  // what BOTH the front-shim unit's `ProgramArguments` AND the independently
  // detached backend process exec, so matching on it catches a backend that
  // survives a bare unit reload as a stale orphan.
  const fixtureEntrypoint = '/store/memory-server-fixture/dist/index.js';
  function makeSpec(env: Record<string, string>): OsUnitSpec {
    return {
      id: 'memory-server-fixture',
      scope: 'user',
      label: 'com.sox.user.memory-server-fixture',
      nodePath: '/usr/bin/node',
      nodeArgs: [],
      entrypoint: fixtureEntrypoint,
      env,
      workingDirectory: '/store/memory-server-fixture',
      runAtLoad: true,
      keepAlive: true,
      throttleIntervalSec: 10,
      stdoutPath: path.join(stdoutDir, 'out.log'),
      stderrPath: path.join(stdoutDir, 'err.log'),
    };
  }

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-update-osunit-'));
    updDir = path.join(base, 'units');
    stdoutDir = path.join(base, 'logs');
    fs.mkdirSync(updDir, { recursive: true });
    fs.mkdirSync(stdoutDir, { recursive: true });
  });

  /**
   * A stateful `findMatches` stand-in: returns `sequences[0]` on the first
   * call (restartAndVerify's pre-kickstart snapshot), `sequences[1]` on every
   * call after (the polling loop) — so `rotated` is computed by
   * `restartAndVerify`'s own before/after comparison against a pid table that
   * genuinely changes mid-call, never asserted by hand.
   */
  function seqFindMatches(before: RestartMatch[], after: RestartMatch[]): () => RestartMatch[] {
    let calls = 0;
    return (): RestartMatch[] => {
      calls += 1;
      return calls === 1 ? before : after;
    };
  }

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(updDir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('[criterion 2] proxy-mode fixture, only an env var changed: rewrites the unit AND invokes restartAndVerify (not just enableOsUnit) to confirm the pid rotated', async () => {
    const loaded = { value: false };
    const exec = makeFakeExec(loaded);
    const platform = new LaunchdPlatform();
    const token = identityToken(fixtureEntrypoint);

    // Seed a "previously enabled" unit — same content path `enable` would have
    // produced, via the SAME real `enableOsUnit` `updateOsUnit` calls by default.
    const seed = await updateOsUnit(makeSpec({ SOX_LOG_LEVEL: 'info' }), platform, {
      unitDir: updDir,
      exec,
      load: true,
      token,
      findMatches: seqFindMatches([], [{ pid: 111 }]),
      reapFn: async (tok: string) => ({ token: tok, killed: [] }),
      sleepFn: async () => { /* instant */ },
    });
    expect(seed.action).toBe('created');
    expect(seed.ok).toBe(true);
    const unitPath = seed.enableResult.unitPath;
    const contentBefore = fs.readFileSync(unitPath, 'utf8');

    // Wrap the REAL `restartAndVerify` in a spy — proves updateOsUnit invoked
    // the actual §9.4a rotation-verify machinery, not merely `enableOsUnit`.
    let restartCallArgs: unknown[] | undefined;
    const restartSpy = vi.fn(async (opts: Parameters<typeof restartAndVerify>[0]) => {
      restartCallArgs = [opts.label, opts.token];
      return restartAndVerify(opts);
    });

    // ONLY an env var changed — same manifest shape, one new value. This is
    // exactly the class of change a bare unit reload cannot, by itself, prove
    // reached a proxy-mode mcp-server's independently detached BACKEND.
    //
    // `findMatches` is stateful: `restartAndVerify` calls it ONCE for the
    // pre-kickstart snapshot (must see the OLD pid, 111) and then repeatedly
    // while polling for a rotation (must see the NEW pid, 222) — so `rotated`
    // is a genuine computation of restartAndVerify's own polling logic against
    // a pid table that actually changes mid-call, not an assertion by hand.
    let findMatchesCalls = 0;
    const result = await updateOsUnit(makeSpec({ SOX_LOG_LEVEL: 'debug' }), platform, {
      unitDir: updDir,
      exec,
      load: true,
      token,
      restartFn: restartSpy,
      findMatches: (): RestartMatch[] => {
        findMatchesCalls += 1;
        return findMatchesCalls === 1 ? [{ pid: 111 }] : [{ pid: 222 }];
      },
      reapFn: async (tok: string) => ({ token: tok, killed: [] }),
      sleepFn: async () => { /* instant */ },
    });

    // The unit was actually rewritten...
    expect(result.action).toBe('updated');
    const contentAfter = fs.readFileSync(unitPath, 'utf8');
    expect(contentAfter).not.toEqual(contentBefore);
    expect(contentAfter).toContain('SOX_LOG_LEVEL');

    // ...AND restartAndVerify (not just enableOsUnit) was invoked, with the
    // fixture's identity token — the exact distinction criterion 2 requires.
    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(restartCallArgs).toEqual(['com.sox.user.memory-server-fixture', token]);
    expect(result.restart).toBeDefined();
    expect(result.restart!.rotated).toBe(true);
    expect(result.restart!.before).toEqual([111]);
    expect(result.restart!.after).toEqual([222]);
    expect(result.ok).toBe(true);
  });

  it('[criterion 3] exits non-zero (ok:false) when unit content changed but no new pid appears within --wait-ms — mirrors restart\'s [inv:deploy-verified]', async () => {
    const loaded = { value: false };
    const exec = makeFakeExec(loaded);
    const platform = new LaunchdPlatform();
    const token = identityToken(fixtureEntrypoint);

    const seed = await updateOsUnit(makeSpec({ SOX_LOG_LEVEL: 'info' }), platform, {
      unitDir: updDir,
      exec,
      load: true,
      token,
      findMatches: seqFindMatches([], [{ pid: 111 }]),
      reapFn: async (tok: string) => ({ token: tok, killed: [] }),
      sleepFn: async () => { /* instant */ },
    });
    expect(seed.ok).toBe(true);

    // Content changes again, but this time the "backend" NEVER rotates — the
    // exact BUG-018/§9.4b false-positive scenario: the front-shim unit reloads
    // fine, but the persistent backend process never re-spawns onto pid 111's
    // replacement within the wait window.
    const result = await updateOsUnit(makeSpec({ SOX_LOG_LEVEL: 'trace' }), platform, {
      unitDir: updDir,
      exec,
      load: true,
      token,
      waitMs: 20,
      pollMs: 5,
      findMatches: (): RestartMatch[] => [{ pid: 111 }], // same pid, forever — never rotates
      reapFn: async (tok: string) => ({ token: tok, killed: [] }),
      sleepFn: async () => { /* instant, still bounded by waitMs deadline check */ },
    });

    expect(result.action).toBe('updated'); // the unit itself DID change
    expect(result.restart).toBeDefined();
    expect(result.restart!.rotated).toBe(false);
    expect(result.ok).toBe(false); // updateOsUnit refuses to report success
    expect(result.reason).toMatch(/did not rotate/);
    expect(result.reason).toMatch(/\[inv:deploy-verified\] violated/);
    // `apps/sox/src/main.ts` `cmdServiceUpdate`'s live-path branch
    // (`if (!result.ok || !result.restart) { ...; process.exit(1); }`) maps
    // this exact shape — ok:false with a defined `restart` — to a non-zero
    // process exit; asserted directly on that branch's guard condition here
    // since a CLI subprocess cannot reach this branch without real launchctl.
    expect(!result.ok || !result.restart).toBe(true);
  });

  it('[criterion 4] a manifest change that would silently drop a previously-set shell-sourced env key is BLOCKED with the same BL-375 message `enable` produces, and neither reload nor kickstart occurs', async () => {
    const loaded = { value: false };
    // Track launchctl subcommands by kind rather than a bare count: BL-375's
    // guard fires AFTER enableOsUnit's `platform.isLoaded` reality check (a
    // harmless `print`, needed to know whether an unload-before-rewrite would
    // even apply) but BEFORE any mutating call — so the assertion that matters
    // is "no reload/kickstart", not "zero launchctl calls of any kind".
    const launchctlSubcommands: string[] = [];
    const exec: OsExec = (cmd, args) => {
      launchctlSubcommands.push(args[0] ?? '(none)');
      return makeFakeExec(loaded)(cmd, args);
    };
    const platform = new LaunchdPlatform();
    const token = identityToken(fixtureEntrypoint);

    // Seed with a shell-sourced env key present — NODE_* / SOX_* minus the
    // SOX_CONFIG_*/SOX_PERM_* deny-prefixes are the exact keys BL-375's
    // `isShellSourcedEnvKey` protects (`libs/host-runtime/src/os-unit.ts`).
    const seed = await updateOsUnit(makeSpec({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), platform, {
      unitDir: updDir,
      exec,
      load: true,
      token,
      findMatches: seqFindMatches([], [{ pid: 111 }]),
      reapFn: async (tok: string) => ({ token: tok, killed: [] }),
      sleepFn: async () => { /* instant */ },
    });
    expect(seed.ok).toBe(true);
    const unitPath = seed.enableResult.unitPath;
    const contentBefore = fs.readFileSync(unitPath, 'utf8');
    launchctlSubcommands.length = 0;

    let restartCalled = false;
    const restartSpy = vi.fn(async (opts: Parameters<typeof restartAndVerify>[0]) => {
      restartCalled = true;
      return restartAndVerify(opts);
    });

    // The manifest regeneration this time OMITS the previously-set key
    // entirely (e.g. a routine manifest edit that silently drops a shell-only
    // var) — never explicitly `--unset`.
    const result = await updateOsUnit(makeSpec({}), platform, {
      unitDir: updDir,
      exec,
      load: true,
      token,
      restartFn: restartSpy,
      findMatches: (): RestartMatch[] => [{ pid: 222 }],
      reapFn: async (tok: string) => ({ token: tok, killed: [] }),
      sleepFn: async () => { /* instant */ },
    });

    expect(result.action).toBe('blocked');
    expect(result.ok).toBe(false);
    // Same reason text `cmdServiceUpdate` surfaces, sourced from the identical
    // BL-375 [inv:env-preserved-on-regenerate] guard `enable` enforces.
    expect(result.reason).toMatch(/\[inv:env-preserved-on-regenerate\]/);
    expect(result.enableResult.droppedEnvKeys).toEqual(['NODE_TLS_REJECT_UNAUTHORIZED']);

    // Neither reload (unit content untouched) nor kickstart (restartAndVerify
    // never invoked) occurred.
    const contentAfter = fs.readFileSync(unitPath, 'utf8');
    expect(contentAfter).toEqual(contentBefore);
    expect(restartCalled).toBe(false);
    expect(restartSpy).not.toHaveBeenCalled();
    // At most the reality-check `print` may run (to know if a stale unit is
    // loaded); `bootstrap`/`bootout`/`kickstart` — reload or kickstart — never do.
    expect(launchctlSubcommands).not.toContain('bootstrap');
    expect(launchctlSubcommands).not.toContain('bootout');
    expect(launchctlSubcommands).not.toContain('kickstart');
  });
});
