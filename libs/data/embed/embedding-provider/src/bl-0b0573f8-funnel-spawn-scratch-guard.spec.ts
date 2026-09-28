/**
 * BL-0b0573f8 — spawn-time scratch-root assertion in the funnel.
 *
 * `FunneledFastembedClient.doEnsure()` is the one place that probes, spawns
 * (`ensureBackend`) and dials a machine-wide embedding host. Resolver-level
 * guards fire only after a spawn has happened. This item moves the check to
 * spawn time: when a TYPED, test-only guard (`__setFunnelSpawnGuardForTests`,
 * never an env var — ADR-0013) carries a `scratchRoot`, the funnel refuses to
 * probe, spawn or dial a host whose `--cache-dir` or `--socket` resolves
 * outside that root, throwing `EmbedHostScratchRootViolationError`.
 *
 * The project harness (`vitest.setup-scratch.ts`) arms the guard for every
 * spec in this project, so the behavioural cases below run with NO local
 * setup: they prove the guard is live project-wide.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { __resetEmbedHostConfigForTests } from './embedHostConfig.js';
import { FunneledFastembedClient } from './funnelClient.js';
import {
  applyEnv,
  destroyFunnelDir,
  funnelEnvVars,
  hostPids,
  makeFunnelDir,
  type FunnelDir,
} from './test-support/funnelHarness.js';
import { EMBED_SCRATCH_KEY, embedScratchOrNull } from './test-support/scratchModelCache.js';

const scratch = embedScratchOrNull(inject(EMBED_SCRATCH_KEY));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  __resetEmbedHostConfigForTests();
});

/** A stub-host funnel sandbox INSIDE the scratch root (os.tmpdir() is redirected there). */
function sandbox(prefix: string): FunnelDir {
  const f = makeFunnelDir(prefix);
  cleanups.push(() => destroyFunnelDir(f));
  cleanups.push(applyEnv(funnelEnvVars(f)));
  return f;
}

/** A directory guaranteed OUTSIDE the scratch root: a sibling of it under /tmp. */
function outsideDir(tag: string): string {
  const d = fs.mkdtempSync(path.join('/tmp', `sox-epo-${tag}-`));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function violation(err: unknown): { name: string; code: unknown; field: unknown } {
  const e = err as { name?: string; code?: unknown; field?: unknown };
  return { name: String(e?.name), code: e?.code, field: e?.field };
}

describe('BL-0b0573f8 — the funnel refuses to spawn a host outside the armed scratch root', () => {
  it('--cache-dir outside the scratch root: request rejects typed, no host is spawned', async () => {
    const f = sandbox('sox-0b0573f8-cache');
    const outside = outsideDir('cache');
    const client = new FunneledFastembedClient();
    const err = await client.request({ type: 'init', model: 'stub', cacheDir: outside }, 15_000).then(
      (r) => ({ resolved: r }),
      (e: unknown) => e,
    );
    expect(violation(err)).toEqual({
      name: 'EmbedHostScratchRootViolationError',
      code: 'E_EMBED_HOST_OUTSIDE_SCRATCH_ROOT',
      field: 'cache-dir',
    });
    expect(hostPids(f.shimPath), 'no host may be spawned for a refused target').toEqual([]);
  }, 30_000);

  it('--socket outside the scratch root (SOX_ECOSYSTEM_HOME outside it): request rejects typed, no host is spawned', async () => {
    const f = sandbox('sox-0b0573f8-sock');
    const outsideHome = outsideDir('home');
    cleanups.push(applyEnv({ SOX_ECOSYSTEM_HOME: outsideHome }));
    __resetEmbedHostConfigForTests();
    const client = new FunneledFastembedClient();
    const err = await client.request({ type: 'init', model: 'stub', cacheDir: f.cache }, 15_000).then(
      (r) => ({ resolved: r }),
      (e: unknown) => e,
    );
    expect(violation(err)).toEqual({
      name: 'EmbedHostScratchRootViolationError',
      code: 'E_EMBED_HOST_OUTSIDE_SCRATCH_ROOT',
      field: 'socket',
    });
    expect(hostPids(f.shimPath)).toEqual([]);
    expect(fs.existsSync(path.join(outsideHome, 'run')) ? fs.readdirSync(path.join(outsideHome, 'run')) : []).toEqual([]);
  }, 30_000);

  it('control: cache and socket inside the scratch root spawn and serve normally', async () => {
    const f = sandbox('sox-0b0573f8-ok');
    const client = new FunneledFastembedClient();
    const res = await client.request<Record<string, unknown>>({ type: 'init', model: 'stub', cacheDir: f.cache }, 30_000);
    expect(res['initOk']).toBe(true);
    expect(hostPids(f.shimPath)).toHaveLength(1);
  }, 60_000);
});

describe('BL-0b0573f8 — the typed guard seam', () => {
  it('the project harness armed the guard with the run scratch root', async () => {
    const g = await import('./spawnScratchGuard.js');
    expect(scratch).not.toBeNull();
    expect(g.__getFunnelSpawnGuardForTests()).toEqual({ scratchRoot: scratch!.root });
  });

  it('assertSpawnInsideScratchRoot: inside passes; outside, traversal and sibling-prefix are refused; /private spellings agree', async () => {
    const { assertSpawnInsideScratchRoot, EmbedHostScratchRootViolationError } = await import('./spawnScratchGuard.js');
    const { PermanentEmbeddingError } = await import('./errors.js');
    const root = fs.mkdtempSync('/tmp/sox-ep-guard-');
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const guard = { scratchRoot: root };
    const ok = { cacheDir: path.join(root, 'models'), socketPath: path.join(root, 'home', 'run', 'x.sock') };
    expect(() => assertSpawnInsideScratchRoot(ok, guard)).not.toThrow();
    // /private spelling of an inside path (macOS /tmp → /private/tmp).
    if (process.platform === 'darwin') {
      expect(() =>
        assertSpawnInsideScratchRoot({ ...ok, cacheDir: path.join('/private', root, 'models') }, guard),
      ).not.toThrow();
    }
    const cases: Array<[string, { cacheDir: string; socketPath: string }, 'cache-dir' | 'socket']> = [
      ['cache outside', { ...ok, cacheDir: '/tmp/elsewhere/models' }, 'cache-dir'],
      ['cache traversal', { ...ok, cacheDir: path.join(root, '..', 'escape') }, 'cache-dir'],
      ['sibling prefix', { ...ok, cacheDir: `${root}-sibling/models` }, 'cache-dir'],
      ['socket outside', { ...ok, socketPath: '/tmp/elsewhere/x.sock' }, 'socket'],
    ];
    for (const [what, target, field] of cases) {
      let caught: unknown;
      try {
        assertSpawnInsideScratchRoot(target, guard);
      } catch (e) {
        caught = e;
      }
      expect(caught, what).toBeInstanceOf(EmbedHostScratchRootViolationError);
      expect(caught, what).toBeInstanceOf(PermanentEmbeddingError);
      expect((caught as InstanceType<typeof EmbedHostScratchRootViolationError>).field, what).toBe(field);
    }
    // A symlink inside the root that points outside it is outside.
    const link = path.join(root, 'link-out');
    const target = fs.mkdtempSync('/tmp/sox-epo-link-');
    cleanups.push(() => fs.rmSync(target, { recursive: true, force: true }));
    fs.symlinkSync(target, link);
    expect(() => assertSpawnInsideScratchRoot({ ...ok, cacheDir: path.join(link, 'models') }, guard)).toThrow(
      EmbedHostScratchRootViolationError,
    );
  });

  it('unset guard (production default) never throws, whatever the paths', async () => {
    const { assertSpawnInsideScratchRoot } = await import('./spawnScratchGuard.js');
    expect(() => assertSpawnInsideScratchRoot({ cacheDir: '/anywhere', socketPath: '/anywhere/x.sock' }, null)).not.toThrow();
  });
});
