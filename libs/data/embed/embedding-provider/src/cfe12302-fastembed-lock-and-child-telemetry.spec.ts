/**
 * cfe12302 — the embed-host stderr log lied twice.
 *
 * (a) "[fastembed] WARNING (BL-331): another fastembed host process (pid N …) is
 *     ALREADY RUNNING" named processes that were not competing hosts. The check
 *     only asked `kill(pid, 0)`: a pid reused by an unrelated process, a zombie,
 *     or a member of the SAME host's pool (an `embedding.reset` starts a new pool
 *     group, so the BL-432 pool-group suppression misses it) all read as a
 *     competitor. The check now probes the holder with `ps` (state, ppid, start
 *     time) and classifies it; only `'competing'` warns.
 * (b) "[sox-telemetry] WARNING: emitting with no initTelemetry() call …" — a
 *     process in the host's tree emitted before bootstrapping telemetry (the
 *     published 0.5.3 host had no bootstrap at all). The real host + real ONNX
 *     child must both write their own jsonl and never print that warning.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyLockHolder, ownProcessStartMs, probeLockHolder, type LockHolderProbe } from './fastembedLock.js';
import { checkAndClaimFastembedLock } from './fastembedProcessHost.js';
import { __resetCompetingHostCacheForTests, detectCompetingFastembedHost } from './sharedFastembedProcess.js';
import { applyEnv, destroyFunnelDir, funnelEnvVars, makeFunnelDir, waitFor } from './test-support/funnelHarness.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function spawnSleeper(): ChildProcess {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  cleanups.push(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  return child;
}

describe('cfe12302 (a) — classifyLockHolder', () => {
  const own = { pid: 100, ppid: 50, poolGroup: 'apool-B', service: 'memory-server' };
  const live = (o: Partial<LockHolderProbe> = {}): LockHolderProbe => ({
    alive: true,
    zombie: false,
    ppid: 7,
    startMs: 1_000_000,
    ...o,
  });
  it.each([
    ['our own pid', { pid: 100 }, live(), 'self'],
    ['a dead pid', { pid: 200 }, { alive: false, zombie: false, ppid: null, startMs: null }, 'dead'],
    ['a zombie (answers kill 0)', { pid: 200 }, live({ zombie: true }), 'zombie'],
    ['a reused pid (start time differs)', { pid: 200, procStartMs: 5_000_000 }, live(), 'pid_reused'],
    ['same start within ps tolerance', { pid: 200, procStartMs: 1_000_900 }, live(), 'competing'],
    ['a child of our own parent (post-reset pool)', { pid: 200, poolGroup: 'apool-A' }, live({ ppid: 50 }), 'own_parent'],
    ['a pool-group sibling', { pid: 200, poolGroup: 'apool-B' }, live(), 'pool_sibling'],
    ['a same-service lock', { pid: 200, service: 'memory-server' }, live(), 'same_service'],
    ['an old-format lock (no identity) held by a live stranger', { pid: 200 }, live(), 'competing'],
    ['a different service', { pid: 200, service: 'backlog' }, live(), 'competing'],
  ] as const)('%s → %s', (_n, prev, probe, verdict) => {
    expect(classifyLockHolder(prev, own, probe)).toBe(verdict);
  });

  it('probeLockHolder reports our own process accurately and a dead pid as dead', () => {
    const me = probeLockHolder(process.pid);
    expect(me.alive).toBe(true);
    expect(me.zombie).toBe(false);
    expect(me.ppid).toBe(process.ppid);
    expect(Math.abs((me.startMs ?? 0) - ownProcessStartMs())).toBeLessThan(2_000);
    expect(probeLockHolder(2 ** 31 - 2).alive).toBe(false);
  });
});

describe('cfe12302 (a) — the BL-331 warning only names a genuinely competing host', () => {
  let lockPath = '';
  let restore: () => void = () => undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    lockPath = path.join(os.tmpdir(), `sox-cfe12302-${process.pid}-${Date.now()}.lock`);
    restore = applyEnv({ SOX_FASTEMBED_LOCK_PATH: lockPath, SOX_FASTEMBED_SERVICE: undefined, SOX_FASTEMBED_POOL_GROUP: undefined });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
    restore();
    fs.rmSync(lockPath, { force: true });
  });
  const warned = (): boolean => errorSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('ALREADY RUNNING'));

  it('a live pid that is NOT the claimant (start time differs) is not warned about', () => {
    const stranger = spawnSleeper();
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: stranger.pid, startedAt: '2026-09-25T00:32:02.647Z', procStartMs: Date.now() - 3_600_000 }),
    );
    checkAndClaimFastembedLock();
    expect(warned()).toBe(false);
    // …and the lock now records the new claimant's identity.
    const now = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    expect(now['pid']).toBe(process.pid);
    expect(now['ppid']).toBe(process.ppid);
    expect(typeof now['procStartMs']).toBe('number');
  });

  it('positive control: a live claimant whose start time matches IS warned about', () => {
    const rival = spawnSleeper();
    const rivalStart = probeLockHolder(rival.pid!).startMs!;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: rival.pid, startedAt: new Date().toISOString(), procStartMs: rivalStart }));
    // Our own parent is not the rival's parent (the rival is OUR child).
    checkAndClaimFastembedLock();
    expect(warned()).toBe(true);
  });

  it('a sibling under the same parent host (a pool member in another pool group) is not warned about', async () => {
    const sibling = spawnSleeper(); // child of this process
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: sibling.pid, startedAt: new Date().toISOString(), poolGroup: 'apool-old' }),
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-cfe12302-sib-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const script = path.join(dir, 'claim.mjs');
    const hostSrc = pathToFileURL(path.join(__dirname, 'fastembedProcessHost.ts')).href;
    fs.writeFileSync(script, `const m = await import(${JSON.stringify(hostSrc)});\nm.checkAndClaimFastembedLock();\nprocess.exit(0);\n`);
    const base = process.env['NODE_OPTIONS'] ?? '';
    // The claimant is ALSO a child of this process — a sibling of the holder.
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let err = '';
      const c = spawn(process.execPath, [script], {
        env: {
          ...process.env,
          NODE_OPTIONS: `${base} --import tsx`.trim(),
          SOX_FASTEMBED_POOL_GROUP: 'apool-new',
          SOX_ECOSYSTEM_HOME: dir,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      c.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
      c.on('exit', (cd) => resolve({ code: cd, stderr: err }));
    });
    expect(code, stderr).toBe(0);
    expect(stderr).not.toContain('ALREADY RUNNING');
  }, 60_000);
});

describe('cfe12302 (a) — the parent-side competing-host reader (no exec on the request path)', () => {
  it('a lock held by one of OUR OWN children (recorded ppid) is not a competing host', () => {
    const lockPath = path.join(os.tmpdir(), `sox-cfe12302-parent-${process.pid}-${Date.now()}.lock`);
    cleanups.push(applyEnv({ SOX_FASTEMBED_LOCK_PATH: lockPath }));
    cleanups.push(() => fs.rmSync(lockPath, { force: true }));
    const ourChild = spawnSleeper();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: ourChild.pid, startedAt: new Date().toISOString(), ppid: process.pid, poolGroup: 'apool-old' }));
    __resetCompetingHostCacheForTests();
    expect(detectCompetingFastembedHost(undefined, 'apool-new')).toBeNull();
    // Positive control: the same live pid recorded under a different parent IS competing.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: ourChild.pid, startedAt: new Date().toISOString(), ppid: 1, poolGroup: 'apool-old' }));
    __resetCompetingHostCacheForTests();
    expect(detectCompetingFastembedHost(undefined, 'apool-new')?.pid).toBe(ourChild.pid);
  });
});

describe('cfe12302 (b) — the real host and its real ONNX child both bootstrap telemetry', () => {
  it('no "[sox-telemetry] WARNING" in the host stderr log; both processes write their own jsonl', async () => {
    const f = makeFunnelDir('sox-cfe12302-b');
    cleanups.push(() => destroyFunnelDir(f));
    const vars = funnelEnvVars(f);
    // The REAL fastembedProcessHost child, not the stub.
    cleanups.push(applyEnv({ ...vars, SOX_FASTEMBED_HOST_PATH: undefined, SOX_FASTEMBED_LOCK_PATH: path.join(f.dir, 'bl331.lock') }));
    const { createEmbeddingProvider } = await import('./index.js');
    const provider = await createEmbeddingProvider({ type: 'fastembed', model: 'bge-small-en-v1.5' });
    const v = await provider.embedSingle('telemetry must not be dropped');
    expect(v.length).toBe(384);

    const stderrLog = path.join(f.home, 'run', 'logs', 'embed-host.stderr.log');
    await waitFor(() => fs.existsSync(stderrLog), 10_000, 'host stderr log');
    const hostLog = path.join(f.home, 'embed-host', 'logs');
    const childLog = path.join(f.home, 'embedding-provider', 'logs');
    await waitFor(
      () => fs.existsSync(childLog) && fs.readdirSync(childLog).some((n) => n.endsWith('.jsonl')),
      10_000,
      'ONNX child jsonl',
    );
    expect(fs.readdirSync(hostLog).some((n) => n.endsWith('.jsonl'))).toBe(true);
    expect(fs.readFileSync(stderrLog, 'utf8')).not.toContain('[sox-telemetry] WARNING');
  }, 180_000);
});
