/**
 * dc6261c1 — `soxe service restart <id> --backend-only` found no backend.
 *
 * Mechanism (reproduced live 2026-09-24): the unit's front-shim
 * (`soxe serve memory-server --port 3099`) resolved its backend entrypoint ONCE
 * at start — the dev checkout's `.../members/memory-server/dist/index.js` — and
 * respawns every backend on that path. Hours later the user lockfile was
 * re-pointed to an npm-installed copy under `~/.adhd/.../ext/.../dist/index.js`.
 * `service restart` re-derives its identity token from the CURRENT lockfile, so
 * it searched for the `~/.adhd` path, matched nothing (`before=[]`), reaped
 * nothing, and failed `[inv:deploy-verified]` with `before=[] after=[]` while
 * the stale backend kept serving.
 *
 * The fix derives the live backend's token from the process table
 * (`findLiveUnitBackendTokens`: direct children of the unit's mainPid whose
 * manifest declares the same extension id) and matches it alongside the
 * resolved token in every `restartAndVerify` phase.
 */
import { describe, expect, it } from 'vitest';

import { LaunchdPlatform, restartAndVerify } from './os-unit.js';
import type { OsUnitPlatform, RestartMatch } from './os-unit.js';
import { argvContainsToken, findLiveUnitBackendTokens } from './reaper.js';
import type { BackendTokenFs, PsProcess, ReapResult } from './reaper.js';

const NODE = '/opt/homebrew/Cellar/node/26.5.1/bin/node';
const DEV_EXT = '/dev/checkout/extensions/bundles/sox-memory-bundle/members/memory-server';
const DEV_ENTRY = `${DEV_EXT}/dist/index.js`;
const NPM_EXT = '/home/.adhd/sox-ecosystem/ext/memory-server/node_modules/@adhd/sox-extension-memory-server';
const NPM_ENTRY = `${NPM_EXT}/dist/index.js`;
const OTHER_EXT = '/dev/checkout/extensions/mcp-servers/backlog';
const OTHER_ENTRY = `${OTHER_EXT}/dist/index.js`;
const SHIM = 14742;
const BACKEND = 60640;
const RESPAWNED = 70001;

/** A fake file tree: path → contents (manifests) or '' (plain files). Realpath is identity. */
function fakeFs(files: Record<string, string>): BackendTokenFs {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    realpathSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
      return p;
    },
  };
}

const TREE = fakeFs({
  [`${DEV_EXT}/extension.json`]: JSON.stringify({ id: 'memory-server', entrypoint: 'dist/index.js' }),
  [DEV_ENTRY]: '',
  [`${NPM_EXT}/extension.json`]: JSON.stringify({ id: 'memory-server', entrypoint: 'dist/index.js' }),
  [NPM_ENTRY]: '',
  [`${OTHER_EXT}/extension.json`]: JSON.stringify({ id: 'backlog', entrypoint: 'dist/index.js' }),
  [OTHER_ENTRY]: '',
});

const shimProc: PsProcess = {
  pid: SHIM,
  ppid: 1,
  args: `${NODE} --enable-source-maps /dev/checkout/bin/soxe serve memory-server --port 3099`,
};
const backendProc = (pid: number): PsProcess => ({
  pid,
  ppid: SHIM,
  args: `${NODE} --enable-source-maps ${DEV_ENTRY}`,
});

describe('dc6261c1: findLiveUnitBackendTokens — identity of the backend the unit actually runs', () => {
  it('returns the dev-checkout entrypoint the shim spawned, even though the lockfile now resolves elsewhere', () => {
    const tokens = findLiveUnitBackendTokens({
      extId: 'memory-server',
      mainPid: SHIM,
      procs: [shimProc, backendProc(BACKEND)],
      fsImpl: TREE,
    });
    expect(tokens).toEqual([DEV_ENTRY]);
    expect(tokens).not.toContain(NPM_ENTRY);
  });

  it('never matches the same entrypoint under a different parent (PPID 1 orphan or foreign parent)', () => {
    expect(
      findLiveUnitBackendTokens({
        extId: 'memory-server',
        mainPid: SHIM,
        procs: [shimProc, { ...backendProc(BACKEND), ppid: 1 }, { ...backendProc(BACKEND + 1), ppid: 4242 }],
        fsImpl: TREE,
      }),
    ).toEqual([]);
  });

  it('never matches a child of the shim whose manifest declares a different extension id', () => {
    expect(
      findLiveUnitBackendTokens({
        extId: 'memory-server',
        mainPid: SHIM,
        procs: [shimProc, { pid: 555, ppid: SHIM, args: `${NODE} ${OTHER_ENTRY}` }],
        fsImpl: TREE,
      }),
    ).toEqual([]);
  });

  it('never matches a child whose script is not the manifest-declared entrypoint, or has no manifest', () => {
    const fsI = fakeFs({
      [`${DEV_EXT}/extension.json`]: JSON.stringify({ id: 'memory-server', entrypoint: 'dist/index.js' }),
      [`${DEV_EXT}/dist/other.js`]: '',
      '/tmp/loose/script.js': '',
    });
    expect(
      findLiveUnitBackendTokens({
        extId: 'memory-server',
        mainPid: SHIM,
        procs: [
          { pid: 556, ppid: SHIM, args: `${NODE} ${DEV_EXT}/dist/other.js` },
          { pid: 557, ppid: SHIM, args: `${NODE} /tmp/loose/script.js` },
          { pid: 558, ppid: SHIM, args: `/usr/bin/tee ${DEV_ENTRY}` },
        ],
        fsImpl: fsI,
      }),
    ).toEqual([]);
  });

  it('never returns the shim itself and returns [] when the unit mainPid is unknown', () => {
    const selfParented: PsProcess = { ...shimProc, ppid: SHIM, args: `${NODE} ${DEV_ENTRY}` };
    expect(
      findLiveUnitBackendTokens({ extId: 'memory-server', mainPid: SHIM, procs: [selfParented], fsImpl: TREE }),
    ).toEqual([]);
    expect(
      findLiveUnitBackendTokens({
        extId: 'memory-server',
        mainPid: undefined,
        procs: [shimProc, backendProc(BACKEND)],
        fsImpl: TREE,
      }),
    ).toEqual([]);
  });
});

describe('dc6261c1: restartAndVerify({kickstart:false}) rotates the live backend when the lockfile moved', () => {
  const platform = new LaunchdPlatform();
  const stubPlatform: OsUnitPlatform = Object.assign(
    Object.create(Object.getPrototypeOf(platform)) as OsUnitPlatform,
    platform,
    { mainPid: () => SHIM },
  );

  /**
   * A fake process table whose matcher is the REAL `argvContainsToken`, and
   * whose reaper kills the matched backend and lets the shim respawn a new one
   * on the SAME cached (dev-checkout) entrypoint — exactly the live topology.
   */
  function world() {
    let table: PsProcess[] = [shimProc, backendProc(BACKEND)];
    const findMatches = (tok: string, o: { excludePids?: number[] }): RestartMatch[] =>
      table
        .filter((p) => !(o.excludePids ?? []).includes(p.pid) && argvContainsToken(p.args, tok))
        .map((p) => ({ pid: p.pid }));
    const reapFn = async (tok: string, o: { excludePids?: number[] }): Promise<ReapResult> => {
      const hit = findMatches(tok, o).map((m) => m.pid);
      table = table.filter((p) => !hit.includes(p.pid));
      if (hit.length > 0) table.push(backendProc(RESPAWNED)); // shim onDisconnect -> ensureBackendLive
      return {
        token: tok,
        killed: hit.map((pid) => ({ pid, ppid: SHIM, orphaned: false, outcome: 'term' as const })),
      };
    };
    return { findMatches, reapFn, procs: () => table };
  }

  it('reaps backend 60640 and verifies the respawn (was: before=[] after=[] timeout)', async () => {
    const w = world();
    const extraTokens = findLiveUnitBackendTokens({
      extId: 'memory-server',
      mainPid: SHIM,
      procs: w.procs(),
      fsImpl: TREE,
    }).filter((t) => t !== NPM_ENTRY);

    const result = await restartAndVerify({
      label: 'com.sox.user.memory-server',
      token: NPM_ENTRY, // what resolveOsUnitContext re-derives from the re-pointed lockfile
      extraTokens,
      platform: stubPlatform,
      exec: () => ({ code: 0, stdout: '', stderr: '' }),
      kickstart: false,
      mainPid: SHIM,
      excludePids: [],
      findMatches: w.findMatches,
      reapFn: w.reapFn,
      waitMs: 50,
      sleepFn: async () => { /* instant */ },
    });

    expect(result.before).toEqual([BACKEND]);
    expect(result.reap.killed.map((k) => k.pid)).toEqual([BACKEND]);
    expect(result.after).toEqual([RESPAWNED]);
    expect(result.rotated).toBe(true);
    expect(result.ok).toBe(true);
    // [inv:singleton] the shim is never a reap candidate
    expect(w.procs().some((p) => p.pid === SHIM)).toBe(true);
  });

  it('with no divergent live token, behaves exactly as before (single resolved token)', async () => {
    const w = world();
    const result = await restartAndVerify({
      label: 'com.sox.user.memory-server',
      token: DEV_ENTRY,
      extraTokens: [],
      platform: stubPlatform,
      exec: () => ({ code: 0, stdout: '', stderr: '' }),
      kickstart: false,
      mainPid: SHIM,
      findMatches: w.findMatches,
      reapFn: w.reapFn,
      waitMs: 50,
      sleepFn: async () => { /* instant */ },
    });
    expect(result.before).toEqual([BACKEND]);
    expect(result.after).toEqual([RESPAWNED]);
    expect(result.ok).toBe(true);
  });
});
