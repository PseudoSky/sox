/**
 * Pid-reuse sweep and the fts-rebuild guard inputs (backlog 8ca41f1d AC2, AC8).
 *
 * Failure mode: recycled-pid opener/lease entries keep `storeOpeners` /
 * `storeQuiescence` reporting a live holder, so the rebuild guard
 * (store-rebuild.ts refuses on `livePids.length > 0`) never proceeds.
 * Tier: S. `node:child_process` is mocked, so the production ps reader runs but
 * no process is spawned; the start-time table is the injected "OS".
 * Gap statement: the real ps binary and a real recycled pid are not exercised
 * at tier S; the mocked execFileSync pins the command, args and TZ/LC_ALL env.
 * Cites: 8ca41f1d AC2, AC8.
 * Light risk map: real holder must keep refusing (AC8 first half); sweeping
 * only unlinks bookkeeping files.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const startTexts = new Map<number, string>();
const psCalls: { args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
vi.mock('node:child_process', () => ({
  execFileSync: (_cmd: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
    psCalls.push({ args, env: opts.env });
    const text = startTexts.get(Number(args[args.length - 1]));
    if (text === undefined) throw new Error('ps: no such pid');
    return `${text}\n`;
  },
}));

import { openerDirPath, leaseDirPath, storeOpeners, storeQuiescence } from '../store-lease.js';

const dirs: string[] = [];
afterEach(() => {
  startTexts.clear();
  psCalls.length = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'store-lease-sweep-'));
  dirs.push(dir);
  return join(dir, 'store.db');
}

const HOLDER = process.ppid; // alive, not this process
const RECYCLED = 1; // alive (EPERM or ok), not this process
const WRITTEN = '2026-10-10T00:00:00.000Z';
const BEFORE_WRITE = 'Fri Oct  9 23:00:00 2026'; // started before the entry: genuine holder
const AFTER_WRITE = 'Tue Oct 20 13:24:35 2026'; // started days after: recycled

function writeOpener(dbPath: string, pid: number): string {
  mkdirSync(openerDirPath(dbPath), { recursive: true });
  const p = join(openerDirPath(dbPath), String(pid));
  writeFileSync(p, `${pid}\n${WRITTEN}\n`);
  return p;
}

describe('store-lease sweep and rebuild-guard inputs — 8ca41f1d', () => {
  it('precondition: holder and recycled pids are distinct, alive, and not this process', () => {
    expect(new Set([HOLDER, RECYCLED, process.pid]).size).toBe(3);
    for (const pid of [HOLDER, RECYCLED]) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('EPERM');
      }
    }
  });

  it('8ca41f1d AC2: storeQuiescence sweeps a lease entry older than its live pid start, keeps a genuine one', () => {
    const dbPath = tempDbPath();
    const dir = leaseDirPath(dbPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stale-token'), `${RECYCLED}\n${WRITTEN}\n`);
    writeFileSync(join(dir, 'real-token'), `${HOLDER}\n${WRITTEN}\n`);
    startTexts.set(RECYCLED, AFTER_WRITE);
    startTexts.set(HOLDER, BEFORE_WRITE);

    const q = storeQuiescence(dbPath);
    expect(q.livePeers).toEqual([{ token: 'real-token', pid: HOLDER }]);
    expect(existsSync(join(dir, 'stale-token'))).toBe(false);
    expect(existsSync(join(dir, 'real-token'))).toBe(true);
  });

  it('8ca41f1d AC8: the rebuild guard inputs refuse with a real holder and clear once only recycled-pid entries remain', () => {
    const dbPath = tempDbPath();
    const holderFile = writeOpener(dbPath, HOLDER);
    const recycledFile = writeOpener(dbPath, RECYCLED);
    startTexts.set(HOLDER, BEFORE_WRITE);
    startTexts.set(RECYCLED, AFTER_WRITE);

    // The guard (store-rebuild.ts) refuses iff livePids.length > 0 || unknown.
    const withHolder = storeOpeners(dbPath);
    expect(withHolder.livePids).toEqual([HOLDER]);
    expect(withHolder.unknown).toBe(false);
    expect(existsSync(recycledFile)).toBe(false);
    expect(existsSync(holderFile)).toBe(true);

    // The real holder goes away; only a recycled-pid entry remains.
    rmSync(holderFile);
    const recycledOnly = writeOpener(dbPath, RECYCLED);
    const cleared = storeOpeners(dbPath);
    expect(cleared.livePids).toEqual([]);
    expect(cleared.unknown).toBe(false);
    expect(existsSync(recycledOnly)).toBe(false);
  });

  it('8ca41f1d AC8: the production ps reader asks for lstart of that pid under TZ=UTC', () => {
    const dbPath = tempDbPath();
    writeOpener(dbPath, HOLDER);
    startTexts.set(HOLDER, BEFORE_WRITE);
    storeOpeners(dbPath);
    expect(psCalls).toHaveLength(1);
    expect(psCalls[0]?.args).toEqual(['-o', 'lstart=', '-p', String(HOLDER)]);
    expect(psCalls[0]?.env?.TZ).toBe('UTC');
  });

  it('8ca41f1d AC5: a ps failure through the production reader leaves the opener live and unswept', () => {
    const dbPath = tempDbPath();
    const file = writeOpener(dbPath, RECYCLED); // no startTexts entry => mocked ps throws
    const res = storeOpeners(dbPath);
    expect(res.livePids).toEqual([RECYCLED]);
    expect(existsSync(file)).toBe(true);
  });
});
