/**
 * dc6261c1 — `soxe service restart <id> --backend-only` found no backend.
 *
 * Mechanism (reproduced live 2026-09-24): the unit's front-shim
 * (`soxe serve memory-server --port 3099`) resolved its backend entrypoint ONCE
 * at start (the dev checkout's `.../members/memory-server/dist/index.js`) and
 * respawns every backend on that path. Later the user lockfile was re-pointed
 * to an npm-installed copy under `~/.adhd/.../ext/.../dist/index.js`.
 * `service restart` re-derives its identity token from the CURRENT lockfile, so
 * it searched for the `~/.adhd` path, matched nothing (`before=[]`), reaped
 * nothing, and failed `[inv:deploy-verified]` with `before=[] after=[]`.
 *
 * The fix discovers the live backend from the process table
 * (`findLiveUnitBackends`: direct children of the unit's mainPid whose manifest
 * declares the same extension id) and reaps it BY PID ONLY, re-validated at
 * kill time. Its path is never widened into a path-wide reap (another scope can
 * run the same path, S2 §3.1), and a rotation on that path is never deploy
 * evidence.
 */
import { describe, expect, it } from 'vitest';

import { LaunchdPlatform, restartAndVerify } from './os-unit.js';
import type { OsUnitPlatform, RestartAndVerifyOptions, RestartMatch } from './os-unit.js';
import {
  argvContainsToken,
  findLiveUnitBackends,
  revalidateLiveUnitBackend,
} from './reaper.js';
import type { BackendTokenFs, KillOutcome, LiveUnitBackend, ProcessIdentity, PsProcess, ReapResult } from './reaper.js';

const NODE = '/opt/homebrew/Cellar/node/26.5.1/bin/node';
const DEV_EXT = '/dev/checkout/extensions/bundles/sox-memory-bundle/members/memory-server';
const DEV_ENTRY = `${DEV_EXT}/dist/index.js`;
const NPM_EXT = '/home/.adhd/sox-ecosystem/ext/memory-server/node_modules/@adhd/sox-extension-memory-server';
const NPM_ENTRY = `${NPM_EXT}/dist/index.js`;
const OTHER_EXT = '/dev/checkout/extensions/mcp-servers/backlog';
const OTHER_ENTRY = `${OTHER_EXT}/dist/index.js`;
const SHIM = 14742;
const BACKEND = 60640;
const PROJECT_SHIM = 20000;
const PROJECT_BACKEND = 20001;

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

const shimArgs = `${NODE} --enable-source-maps /dev/checkout/bin/soxe serve memory-server --port 3099`;
const backendArgs = (entry: string) => `${NODE} --enable-source-maps ${entry}`;
const identityFrom = (procs: PsProcess[]) => (pid: number): ProcessIdentity | undefined => {
  const p = procs.find((x) => x.pid === pid);
  return p ? { pid: p.pid, ppid: p.ppid, args: p.args, startedAt: `t${p.pid}` } : undefined;
};

describe('dc6261c1: findLiveUnitBackends — the backend the unit actually runs, pid-scoped', () => {
  const procs: PsProcess[] = [
    { pid: SHIM, ppid: 1, args: shimArgs },
    { pid: BACKEND, ppid: SHIM, args: backendArgs(DEV_ENTRY) },
  ];

  it('returns the backend pid + the dev-checkout entrypoint the shim spawned, not the lockfile path', () => {
    const found = findLiveUnitBackends({
      extId: 'memory-server', mainPid: SHIM, procs, fsImpl: TREE, identityFn: identityFrom(procs),
    });
    expect(found.map((b) => [b.pid, b.ppid, b.token, b.startedAt])).toEqual([[BACKEND, SHIM, DEV_ENTRY, `t${BACKEND}`]]);
  });

  it('never returns the same entrypoint under a different parent (orphan or another scope\'s shim)', () => {
    const others: PsProcess[] = [
      { pid: SHIM, ppid: 1, args: shimArgs },
      { pid: BACKEND, ppid: 1, args: backendArgs(DEV_ENTRY) },
      { pid: PROJECT_BACKEND, ppid: PROJECT_SHIM, args: backendArgs(DEV_ENTRY) },
    ];
    expect(findLiveUnitBackends({
      extId: 'memory-server', mainPid: SHIM, procs: others, fsImpl: TREE, identityFn: identityFrom(others),
    })).toEqual([]);
  });

  it('never returns a child whose manifest id differs, whose script is not the declared entrypoint, or the shim itself', () => {
    const fsI = fakeFs({
      [`${DEV_EXT}/extension.json`]: JSON.stringify({ id: 'memory-server', entrypoint: 'dist/index.js' }),
      [`${DEV_EXT}/dist/other.js`]: '',
      [`${OTHER_EXT}/extension.json`]: JSON.stringify({ id: 'backlog', entrypoint: 'dist/index.js' }),
      [OTHER_ENTRY]: '',
      '/tmp/loose/script.js': '',
    });
    const kids: PsProcess[] = [
      { pid: SHIM, ppid: SHIM, args: backendArgs(DEV_ENTRY) },
      { pid: 555, ppid: SHIM, args: backendArgs(OTHER_ENTRY) },
      { pid: 556, ppid: SHIM, args: backendArgs(`${DEV_EXT}/dist/other.js`) },
      { pid: 557, ppid: SHIM, args: backendArgs('/tmp/loose/script.js') },
    ];
    expect(findLiveUnitBackends({
      extId: 'memory-server', mainPid: SHIM, procs: kids, fsImpl: fsI, identityFn: identityFrom(kids),
    })).toEqual([]);
    expect(findLiveUnitBackends({
      extId: 'memory-server', mainPid: undefined, procs, fsImpl: TREE, identityFn: identityFrom(procs),
    })).toEqual([]);
  });
});

describe('dc6261c1: revalidateLiveUnitBackend — kill-time identity re-check', () => {
  const b: LiveUnitBackend = {
    pid: BACKEND, ppid: SHIM, startedAt: 'tA', args: backendArgs(DEV_ENTRY), token: DEV_ENTRY,
  };
  const id = (over: Partial<ProcessIdentity>) => () => ({ pid: BACKEND, ppid: SHIM, startedAt: 'tA', args: b.args, ...over });

  it('accepts only the exact discovered process still under the discovered shim', () => {
    expect(revalidateLiveUnitBackend(b, { identityFn: id({}) })).toBe(true);
    expect(revalidateLiveUnitBackend(b, { identityFn: () => undefined })).toBe(false); // gone
    expect(revalidateLiveUnitBackend(b, { identityFn: id({ startedAt: 'tB' }) })).toBe(false); // pid reused
    expect(revalidateLiveUnitBackend(b, { identityFn: id({ args: backendArgs(NPM_ENTRY) }) })).toBe(false);
    expect(revalidateLiveUnitBackend(b, { identityFn: id({ ppid: PROJECT_SHIM }), aliveFn: () => true })).toBe(false);
  });

  it('accepts re-parenting only when allowed AND the discovered shim is dead', () => {
    const reparented = id({ ppid: 1 });
    expect(revalidateLiveUnitBackend(b, { identityFn: reparented, aliveFn: () => false })).toBe(false);
    expect(revalidateLiveUnitBackend(b, {
      identityFn: reparented, aliveFn: () => true, allowReparentAfterParentExit: true,
    })).toBe(false);
    expect(revalidateLiveUnitBackend(b, {
      identityFn: reparented, aliveFn: () => false, allowReparentAfterParentExit: true,
    })).toBe(true);
  });
});

/**
 * A fake process table. `findMatches`/`reapFn` use the REAL `argvContainsToken`
 * (path-wide, exactly like `findOrphansByIdentity`). A killed backend is
 * respawned by the shim it was connected to, on THAT shim's cached entrypoint
 * (shim.ts onDisconnect -> ensureBackendLive). `kickstart` replaces the unit
 * shim with a fresh one that resolves `kickstartEntry`; the old shim's backend
 * is re-parented to PPID 1 and adopted by the new shim's connection.
 */
interface Row extends PsProcess { conn?: number }
function world(opts: { kickstartEntry: string }) {
  let nextPid = 70000;
  const shims = new Map<number, string>([[SHIM, DEV_ENTRY], [PROJECT_SHIM, DEV_ENTRY]]);
  let unitShim = SHIM;
  let table: Row[] = [
    { pid: SHIM, ppid: 1, args: shimArgs },
    { pid: BACKEND, ppid: SHIM, args: backendArgs(DEV_ENTRY), conn: SHIM },
    { pid: PROJECT_SHIM, ppid: 1, args: shimArgs },
    { pid: PROJECT_BACKEND, ppid: PROJECT_SHIM, args: backendArgs(DEV_ENTRY), conn: PROJECT_SHIM },
  ];
  const killed: number[] = [];
  const kill = (pid: number): void => {
    const row = table.find((p) => p.pid === pid);
    table = table.filter((p) => p.pid !== pid);
    killed.push(pid);
    const shimPid = row?.conn;
    const entry = shimPid !== undefined ? shims.get(shimPid) : undefined;
    if (shimPid !== undefined && entry !== undefined && table.some((p) => p.pid === shimPid)) {
      const np = nextPid++;
      table.push({ pid: np, ppid: shimPid, args: backendArgs(entry), conn: shimPid });
    }
  };
  const findMatches = (tok: string, o: { excludePids?: number[] }): RestartMatch[] =>
    table
      .filter((p) => !(o.excludePids ?? []).includes(p.pid) && argvContainsToken(p.args, tok))
      .map((p) => ({ pid: p.pid }));
  const reapFn = async (tok: string, o: { excludePids?: number[] }): Promise<ReapResult> => {
    const hit = findMatches(tok, o);
    hit.forEach((m) => kill(m.pid));
    return { token: tok, killed: hit.map((m) => ({ pid: m.pid, ppid: 0, orphaned: false, outcome: 'term' as const })) };
  };
  const killFn = async (pid: number): Promise<KillOutcome> => { kill(pid); return 'term'; };
  const identityFn = (pid: number) => identityFrom(table)(pid);
  const alive = (pid: number) => table.some((p) => p.pid === pid);
  const revalidateFn: RestartAndVerifyOptions['revalidateFn'] = (b, o) =>
    revalidateLiveUnitBackend(b, { ...o, identityFn, aliveFn: alive });
  const platform = new LaunchdPlatform();
  const stubPlatform: OsUnitPlatform = Object.assign(
    Object.create(Object.getPrototypeOf(platform)) as OsUnitPlatform,
    platform,
    {
      mainPid: () => unitShim,
      kickstart: () => {
        const oldShim = unitShim;
        table = table.filter((p) => p.pid !== oldShim);
        shims.delete(oldShim);
        unitShim = nextPid++;
        shims.set(unitShim, opts.kickstartEntry);
        table.push({ pid: unitShim, ppid: 1, args: shimArgs });
        for (const p of table) {
          if (p.ppid === oldShim) { p.ppid = 1; p.conn = unitShim; }
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  );
  const discover = (mainPid: number): LiveUnitBackend[] =>
    findLiveUnitBackends({ extId: 'memory-server', mainPid, procs: table, fsImpl: TREE, identityFn });
  return { findMatches, reapFn, killFn, revalidateFn, stubPlatform, discover, killed, procs: () => table };
}

const base = {
  label: 'com.sox.user.memory-server',
  token: NPM_ENTRY, // what resolveOsUnitContext re-derives from the re-pointed user lockfile
  exec: () => ({ code: 0, stdout: '', stderr: '' }),
  waitMs: 50,
  sleepFn: async () => { /* instant */ },
};
/**
 * The e9cdd54d call shape (`extraTokens: <live path>`), spread in so the same
 * test runs against that commit and demonstrates the path-wide reap / rotation
 * it performed. The current API ignores it; `liveBackends` is authoritative.
 */
const legacy = (tokens: string[]) => ({ extraTokens: tokens }) as Record<string, unknown>;

describe('dc6261c1: restartAndVerify scopes the divergent live backend to its pid', () => {
  it('two scopes sharing the dev-checkout path: only THIS unit\'s backend is reaped, never the other scope\'s', async () => {
    const w = world({ kickstartEntry: NPM_ENTRY });
    const liveBackends = w.discover(SHIM);
    const result = await restartAndVerify({
      ...base, ...legacy([DEV_ENTRY]),
      liveBackends, platform: w.stubPlatform, kickstart: false, mainPid: SHIM,
      findMatches: w.findMatches, reapFn: w.reapFn, killFn: w.killFn, revalidateFn: w.revalidateFn,
      findLiveBackends: () => w.discover(SHIM),
    });
    expect(result.before).toEqual([BACKEND]);
    expect(w.killed).toContain(BACKEND);
    expect(w.killed).not.toContain(PROJECT_BACKEND);
    expect(w.procs().some((p) => p.pid === PROJECT_BACKEND)).toBe(true);
    expect(w.procs().some((p) => p.pid === SHIM)).toBe(true); // [inv:singleton] shim untouched
  });

  it('a pid that no longer is the discovered process at kill time is not signalled', async () => {
    const w = world({ kickstartEntry: NPM_ENTRY });
    const stale: LiveUnitBackend[] = w.discover(SHIM).map((b) => ({ ...b, startedAt: 'earlier-process' }));
    await restartAndVerify({
      ...base, liveBackends: stale, platform: w.stubPlatform, kickstart: false, mainPid: SHIM,
      findMatches: w.findMatches, reapFn: w.reapFn, killFn: w.killFn, revalidateFn: w.revalidateFn,
    });
    expect(w.killed).toEqual([]);
  });
});

describe('dc6261c1: [inv:deploy-verified] never accepts a rotation on the divergent entrypoint', () => {
  it('full restart: rotation ONLY on the live (stale) path is ok:false', async () => {
    // kickstart brings up a shim that still resolves the stale path (e.g. the
    // lockfile was re-pointed back), so the only respawn is on DEV_ENTRY.
    const w = world({ kickstartEntry: DEV_ENTRY });
    const result = await restartAndVerify({
      ...base, ...legacy([DEV_ENTRY]),
      liveBackends: w.discover(SHIM), platform: w.stubPlatform,
      findMatches: w.findMatches, reapFn: w.reapFn, killFn: w.killFn, revalidateFn: w.revalidateFn,
    });
    expect(w.killed).toContain(BACKEND);
    expect(w.killed).not.toContain(PROJECT_BACKEND);
    expect(result.ok).toBe(false);
    expect(result.rotated).toBe(false);
    expect(result.reason).toContain(NPM_ENTRY);
  });

  it('full restart: reaps the re-parented stale backend by pid and verifies the respawn on the RESOLVED path', async () => {
    const w = world({ kickstartEntry: NPM_ENTRY });
    const result = await restartAndVerify({
      ...base, liveBackends: w.discover(SHIM), platform: w.stubPlatform,
      findMatches: w.findMatches, reapFn: w.reapFn, killFn: w.killFn, revalidateFn: w.revalidateFn,
    });
    expect(w.killed).toEqual([BACKEND]);
    expect(result.ok).toBe(true);
    expect(result.rotated).toBe(true);
    const fresh = w.procs().find((p) => result.after.includes(p.pid));
    expect(fresh?.args).toBe(backendArgs(NPM_ENTRY));
  });

  it('--backend-only with a divergent entrypoint: rotates but reports rotatedOnDivergentEntrypoint, ok:false', async () => {
    const w = world({ kickstartEntry: NPM_ENTRY });
    const result = await restartAndVerify({
      ...base, ...legacy([DEV_ENTRY]),
      liveBackends: w.discover(SHIM), platform: w.stubPlatform, kickstart: false, mainPid: SHIM,
      findMatches: w.findMatches, reapFn: w.reapFn, killFn: w.killFn, revalidateFn: w.revalidateFn,
      findLiveBackends: () => w.discover(SHIM),
    });
    expect(result.before).toEqual([BACKEND]);
    expect(result.ok).toBe(false);
    expect(result.rotatedOnDivergentEntrypoint?.running).toEqual([DEV_ENTRY]);
    expect(result.rotatedOnDivergentEntrypoint?.resolved).toBe(NPM_ENTRY);
    expect(result.rotatedOnDivergentEntrypoint?.pids).toHaveLength(1);
    expect(result.reason).toContain('full restart');
  });

  it('with no divergence, behaves exactly as before (single resolved token)', async () => {
    const w = world({ kickstartEntry: DEV_ENTRY });
    const result = await restartAndVerify({
      ...base, token: DEV_ENTRY, liveBackends: w.discover(SHIM).filter((b) => b.token !== DEV_ENTRY),
      platform: w.stubPlatform, kickstart: false, mainPid: SHIM,
      findMatches: w.findMatches, reapFn: w.reapFn, killFn: w.killFn, revalidateFn: w.revalidateFn,
    });
    expect(result.before).toEqual([BACKEND, PROJECT_BACKEND]); // pre-existing S2 path-wide match, unchanged
    expect(result.ok).toBe(true);
  });
});
