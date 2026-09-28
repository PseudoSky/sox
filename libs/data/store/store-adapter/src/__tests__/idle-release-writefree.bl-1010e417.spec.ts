/**
 * BL-1010e417 — the idle release / reopen cycle must be write-free when
 * nothing was written.
 *
 * Root cause: the gated idle flush (30 s ceiling) is phase-locked with
 * memory-server's drain floor (30 s). Every cycle released the connection
 * (PASSIVE + TRUNCATE + a `-tshm` rename) and the drain's next read reopened
 * it through the FULL open ceremony — which itself WROTE: the open-time
 * integrity pass upserts its verdict (`_adapter_meta.last_integrity`, a new
 * `run_at_ms` every time — measured 1 frame on a small store, 4 on a 115 MB
 * copy of a live snapshot), and `stampAdapterMeta` took `BEGIN IMMEDIATE`
 * on every open. So the next flush always had frames to checkpoint and
 * truncate, and every cycle renamed a `.stale-*` file — whose minute-precision
 * name made each rename inside one minute overwrite the previous one.
 *
 * Pinned here, each naming the item:
 *  T1 shared cadence (BL-1010e417): after cycle 1, a release reopen adds no
 *     WAL frame, issues no BEGIN IMMEDIATE, runs no TRUNCATE and no close-time
 *     `-tshm` rename, is fast, and leaves the lease dir empty between polls.
 *  T2 stampAdapterMeta (595e7daf): unchanged values → no transaction, no WAL
 *     growth; a changed version still upserts.
 *  T3 zero-frame close (BL-1010e417 (d)): frames written → TRUNCATE + rename;
 *     zero frames → neither — via the PASSIVE `log` column and via the
 *     `-wal`-size fallback when that column is absent.
 *  T4 open reason (BL-1010e417): a poison reconnect still runs open-time
 *     integrity; a release reconnect does not.
 *  T5 stale naming (5eacd776): two resets in the same minute leave both files,
 *     and retention ranks and prunes them alongside legacy-named debris.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync, statSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { leaseDirPath } from '../store-lease.js';
import { stampAdapterMeta, readAdapterMeta } from '../adapter-meta.js';
import { getLastIntegrityRunAt } from '../integrity.js';
import { DEFAULT_STALE_SIDECAR_KEEP_N, pruneStaleTshmSidecars, staleSidecarPath } from '../sidecar-retention.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../../package.json') as { version: string };

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bl-1010e417-'));
});
afterEach(() => {
  vi.restoreAllMocks();
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}
const walBytes = (db: string): number => (existsSync(db + '-wal') ? statSync(db + '-wal').size : 0);
/** WAL frames on disk — a 32-byte header alone holds none. */
const walFrames = (db: string, pageSize = 4096): number => {
  const size = walBytes(db);
  return size <= 32 ? 0 : Math.ceil((size - 32) / (pageSize + 24));
};
const staleFiles = (db: string): string[] =>
  readdirSync(dirname(db)).filter((f) => f.startsWith(basename(db)) && f.includes('.stale-'));
const leaseEntries = (db: string): string[] =>
  existsSync(leaseDirPath(db))
    ? readdirSync(leaseDirPath(db)).filter((n) => !n.startsWith('.') && !n.endsWith('.openmark'))
    : [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitReleased(a: TursoAdapterImpl, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!(a as unknown as { _released: boolean })._released && Date.now() < deadline) await sleep(20);
  return (a as unknown as { _released: boolean })._released;
}

/** A store shaped like memory-core's: a node table with a Turso FTS index. */
async function seedStore(dbPath: string): Promise<void> {
  const seed = await TursoAdapterImpl.connect({ dbPath });
  await seed.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, kind TEXT, content TEXT, t_invalid TEXT)');
  await seed.ensureFtsIndex('node', ['content']);
  for (let i = 0; i < 50; i++) {
    await seed.executeRun('INSERT INTO node (kind, content) VALUES (?, ?)', ['episode', `row ${i} alpha memory ${i}`]);
  }
  await seed.close();
}

/** Spies on every adapter instance (the throwaway `fresh` ones included). */
function spyAdapterPrototype() {
  const proto = TursoAdapterImpl.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const calls = { truncate: 0, beginImmediate: 0, tshmReset: 0, dropPassiveLog: false };
  const origAll = proto['executeAll']!;
  vi.spyOn(proto, 'executeAll').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    if (/wal_checkpoint\(TRUNCATE\)/i.test(String(args[0]))) calls.truncate++;
    const r = (await origAll.apply(this, args)) as { rows: Array<Record<string, unknown>> };
    if (calls.dropPassiveLog && /wal_checkpoint\(PASSIVE\)/i.test(String(args[0]))) {
      // Simulate a driver whose PASSIVE result carries no frame count.
      return { ...r, rows: r.rows.map(({ log: _drop, ...rest }) => rest) };
    }
    return r;
  });
  const origTx = proto['transaction']!;
  vi.spyOn(proto, 'transaction').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const mode = (args[1] as { mode?: string } | undefined)?.mode;
    if (mode === 'immediate') calls.beginImmediate++;
    return origTx.apply(this, args);
  });
  const origReset = proto['resetTshmAfterTruncate']!;
  vi.spyOn(proto, 'resetTshmAfterTruncate').mockImplementation(function (this: unknown, ...args: unknown[]) {
    calls.tshmReset++;
    return origReset.apply(this, args);
  });
  return calls;
}

tursoDescribe('BL-1010e417 — idle release/reopen is write-free when nothing was written', () => {
  it('T1 BL-1010e417: shared cadence — N=30 poll/release cycles, reopens add no frames, no BEGIN IMMEDIATE, no TRUNCATE, no close-time rename, stale debris bounded by retention', async () => {
    const dbPath = tempPath('t1-cadence');
    await seedStore(dbPath);
    const POLL_MS = 120;
    const CYCLES = 30; // well above keep-20, so retention has to act
    // Clear the sweep throttle so every open sweeps: the bound below is then
    // keepRecentN + the renames inside one throttle window (one open = one).
    const prevThrottle = process.env['SOX_SIDECAR_SWEEP_THROTTLE_MS'];
    process.env['SOX_SIDECAR_SWEEP_THROTTLE_MS'] = '0';
    // A gated adapter whose idle window equals the poll interval — the
    // production phase-lock (30 s drain floor vs 30 s flush ceiling), scaled.
    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: POLL_MS });
    const calls = spyAdapterPrototype();

    // The drain's idle pass: embedBacklogStats-style reads only.
    const drainIdleRead = async () => {
      await a.executeAll(`SELECT id, content FROM node WHERE kind = 'episode' AND t_invalid IS NULL ORDER BY id LIMIT ?`, [64]);
      await a.executeGet(`SELECT COUNT(*) AS c FROM node WHERE kind = 'episode' AND t_invalid IS NULL`);
    };

    const perCycle: Array<{ frames: number; begin: number; truncate: number; tshmReset: number; openMs: number; reason: string; stale: number; staleTotal: number; leases: number }> = [];
    try {
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const before = { ...calls };
      const staleBefore = staleFiles(dbPath).length;
      await drainIdleRead();
      const frames = walFrames(dbPath);
      const timing = a.lastOpenTiming;
      expect(await waitReleased(a), `cycle ${cycle}: the idle flush must release`).toBe(true);
      perCycle.push({
        frames,
        begin: calls.beginImmediate - before.beginImmediate,
        truncate: calls.truncate - before.truncate,
        tshmReset: calls.tshmReset - before.tshmReset,
        openMs: timing?.totalMs ?? -1,
        reason: timing?.reason ?? 'none',
        stale: staleFiles(dbPath).length - staleBefore,
        staleTotal: staleFiles(dbPath).length,
        leases: leaseEntries(dbPath).length,
      });
      await sleep(POLL_MS);
    }
    await a.close();
    } finally {
      if (prevThrottle === undefined) delete process.env['SOX_SIDECAR_SWEEP_THROTTLE_MS'];
      else process.env['SOX_SIDECAR_SWEEP_THROTTLE_MS'] = prevThrottle;
    }

    // Cycle 1 is the first real open: it may write (integrity verdict).
    for (const [i, c] of perCycle.slice(1).entries()) {
      const cycle = i + 2;
      expect(c.reason, `cycle ${cycle}: reopen reason`).toBe('release');
      expect(c.frames, `cycle ${cycle}: the reopen + drain read added WAL frames`).toBe(0);
      expect(c.begin, `cycle ${cycle}: BEGIN IMMEDIATE on the reconnect path`).toBe(0);
      expect(c.truncate, `cycle ${cycle}: TRUNCATE on a zero-frame release`).toBe(0);
      expect(c.tshmReset, `cycle ${cycle}: close-time -tshm rename on a zero-frame release`).toBe(0);
      // Generous bound (suite runs under load): a release reopen measured
      // 2.6–10.4 ms on a 115 MB store; a full open's integrity pass alone
      // measured ~505 ms there.
      expect(c.openMs, `cycle ${cycle}: release reopen wall time`).toBeGreaterThanOrEqual(0);
      expect(c.openMs, `cycle ${cycle}: release reopen wall time`).toBeLessThan(250);
      expect(c.leases, `cycle ${cycle}: lease dir must be empty between polls`).toBe(0);
      // Renames per cycle are UNCHANGED at one: the tshm the zero-frame close
      // now keeps is renamed by the next quiescent open's BL-373 preflight (a
      // tshm beside a 0-byte WAL is content-dead — that gate is deliberately
      // untouched, see T6). What changed is that each rename now survives
      // under its own name, so retention is what bounds the debris.
      expect(c.stale, `cycle ${cycle}: stale files added per cycle`).toBeLessThanOrEqual(1);
      expect(c.staleTotal, `cycle ${cycle}: .stale-* count vs keepRecentN(20) + one throttle window`).toBeLessThanOrEqual(
        DEFAULT_STALE_SIDECAR_KEEP_N + 1,
      );
    }
    expect(perCycle.length).toBe(CYCLES);
  }, 60_000);

  it('T6 BL-1010e417: a release reopen keeps the full preflight — a content-dead -tshm beside an empty WAL is still reconciled at open', async () => {
    const dbPath = tempPath('t6-preflight');
    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 60_000 });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(await a.releaseIdleConnection()).toBe(true); // frames → TRUNCATE + rename
    await a.executeGet('SELECT 1'); // release reopen, write-free
    expect(await a.releaseIdleConnection()).toBe(true); // zero frames → tshm kept
    expect(existsSync(dbPath + '-tshm'), 'precondition: the zero-frame close kept the -tshm').toBe(true);
    expect(walBytes(dbPath), 'precondition: the -wal is empty').toBe(0);
    const before = staleFiles(dbPath).length;

    await a.executeGet('SELECT 1'); // release reopen: the BL-373 preflight must still run
    expect(a.lastOpenTiming?.reason).toBe('release');
    expect(a.lastOpenTiming?.phases['preflight_sidecar_reconcile']).toBeDefined();
    expect(
      staleFiles(dbPath).length,
      'the proactive reconcile must still move a content-dead -tshm aside on a release reopen',
    ).toBe(before + 1);
    await a.close();
  });

  it('T2 BL-1010e417 595e7daf: stampAdapterMeta — unchanged values take no transaction and grow no WAL; a changed version still upserts', async () => {
    const dbPath = tempPath('t2-stamp');
    const a = await TursoAdapterImpl.connect({ dbPath });
    await a.executeGet('SELECT 1'); // first real open stamps
    await a.executeAll('PRAGMA wal_checkpoint(TRUNCATE)');
    const created = (await readAdapterMeta(a)).created_at;
    expect(created).not.toBeNull();

    const txSpy = vi.spyOn(a, 'transaction');
    const walBefore = walBytes(dbPath);
    await stampAdapterMeta(a, 'turso');
    expect(txSpy, 'unchanged stamp must not open a transaction').not.toHaveBeenCalled();
    expect(walBytes(dbPath), 'unchanged stamp must not grow the WAL').toBe(walBefore);

    await a.executeRun(`UPDATE _adapter_meta SET value = '0.0.0-older' WHERE key = 'adapter_version'`);
    await stampAdapterMeta(a, 'turso');
    expect(txSpy, 'a changed version must still be stamped under BEGIN IMMEDIATE').toHaveBeenCalledTimes(1);
    expect(txSpy.mock.calls[0]?.[1]).toEqual({ mode: 'immediate' });
    const meta = await readAdapterMeta(a);
    expect(meta.adapter_version).toBe(PKG_VERSION);
    expect(meta.adapter_type).toBe('turso');
    expect(meta.created_at, 'created_at is written once, never overwritten').toBe(created);
    await a.close();
  });

  it('T3 BL-1010e417: close — frames written ⇒ TRUNCATE + -tshm rename; zero frames ⇒ neither (PASSIVE log column, and the -wal-size fallback)', async () => {
    const dbPath = tempPath('t3-close');
    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 60_000 });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['x']);
    const calls = spyAdapterPrototype();

    // (a) frames present → today's path exactly.
    expect(walFrames(dbPath)).toBeGreaterThan(0);
    expect(await a.releaseIdleConnection()).toBe(true);
    expect(calls.truncate, 'frames present: TRUNCATE').toBe(1);
    expect(calls.tshmReset, 'frames present: -tshm renamed').toBe(1);
    expect(walBytes(dbPath)).toBe(0);

    // (b) reconnect, read only, release → zero frames → neither.
    await a.executeGet('SELECT COUNT(*) AS c FROM t');
    expect(walFrames(dbPath)).toBe(0);
    expect(await a.releaseIdleConnection()).toBe(true);
    expect(calls.truncate, 'zero frames: no TRUNCATE').toBe(1);
    expect(calls.tshmReset, 'zero frames: no -tshm rename').toBe(1);

    // (c) fallback — the PASSIVE result carries no `log` column.
    calls.dropPassiveLog = true;
    await a.executeGet('SELECT COUNT(*) AS c FROM t');
    expect(await a.releaseIdleConnection()).toBe(true);
    expect(calls.truncate, 'fallback, -wal 0 bytes at start and end: no TRUNCATE').toBe(1);
    expect(calls.tshmReset, 'fallback, -wal 0 bytes: no rename').toBe(1);

    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['y']);
    expect(await a.releaseIdleConnection()).toBe(true);
    expect(calls.truncate, 'fallback, frames present: TRUNCATE').toBe(2);
    expect(calls.tshmReset, 'fallback, frames present: rename').toBe(2);
    expect(walBytes(dbPath)).toBe(0);

    // Data survived every cycle.
    const row = await a.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(row?.c).toBe(2);
    await a.close();
  });

  it('T4 BL-1010e417: a poison reconnect still runs open-time integrity; a release reconnect does not', async () => {
    const dbPath = tempPath('t4-reason');
    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 60_000 });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const first = a.lastOpenTiming;
    expect(first?.reason).toBe('initial');
    expect(first?.skipped['integrity']).toBeUndefined();
    const ranAtInitial = getLastIntegrityRunAt(a.config.dbPath);
    expect(ranAtInitial).not.toBeNull();

    // Release → reconnect: integrity is NOT re-run.
    await sleep(5);
    expect(await a.releaseIdleConnection()).toBe(true);
    await a.executeGet('SELECT 1');
    expect(a.lastOpenTiming?.reason).toBe('release');
    expect(a.lastOpenTiming?.skipped['integrity'], 'release reopen skips the fast pass').toBeDefined();
    expect(getLastIntegrityRunAt(a.config.dbPath), 'release reopen must not re-run integrity').toBe(ranAtInitial);

    // Poison → reconnect: integrity DOES run (full ceremony), even right after a release.
    await sleep(5);
    (a as unknown as { _poisoned: boolean })._poisoned = true;
    await a.executeGet('SELECT 1');
    expect(a.lastOpenTiming?.reason).toBe('poison');
    expect(a.lastOpenTiming?.skipped['integrity'], 'poison reopen never skips integrity').toBeUndefined();
    expect(a.lastOpenTiming?.skipped['cte_probe'], 'poison reopen re-probes').toBeUndefined();
    expect(getLastIntegrityRunAt(a.config.dbPath)!).toBeGreaterThan(ranAtInitial!);
    await a.close();
  });

  it('T5 BL-1010e417 5eacd776: two resets in the same minute leave both stale files, and retention sorts and prunes them', async () => {
    const dbPath = tempPath('t5-stale');
    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 60_000 });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['1']);
    expect(await a.releaseIdleConnection()).toBe(true);
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['2']);
    expect(await a.releaseIdleConnection()).toBe(true);
    await a.close();
    const fresh = staleFiles(dbPath).filter((f) => f.includes('-tshm.stale-'));
    // Two renames, two files — whatever the clock. (The old minute-only name
    // made a second rename inside the same minute overwrite the first.)
    expect(fresh.length, `both renames must survive: ${fresh.join(', ')}`).toBeGreaterThanOrEqual(2);
    expect(new Set(fresh).size).toBe(fresh.length);

    // Same instant, same pid → the no-clobber suffix.
    const now = new Date('2026-09-28T10:00:00.000Z');
    const taken = new Set<string>();
    const n1 = staleSidecarPath('/x/m.db-tshm', { now, pid: 7, exists: (p) => taken.has(p) });
    taken.add(n1);
    const n2 = staleSidecarPath('/x/m.db-tshm', { now, pid: 7, exists: (p) => taken.has(p) });
    expect(n1).toBe('/x/m.db-tshm.stale-2026-09-28-1000-00000-p7');
    expect(n2).toBe('/x/m.db-tshm.stale-2026-09-28-1000-00000-p7-1');

    // Retention: 22 legacy (minute) names + 3 new-format names in one minute;
    // keep-20 keeps the 3 newest-by-ms plus the 17 newest legacy.
    const dir = mkdtempSync(join(tmpdir(), 'bl-1010e417-ret-'));
    const db = join(dir, 'm.db');
    const base = Date.parse('2026-09-28T09:00:00.000Z');
    for (let i = 0; i < 22; i++) {
      const d = new Date(base + i * 60_000).toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
      writeFileSync(`${db}-tshm.stale-${d}`, '');
    }
    const newest: string[] = [];
    for (const ms of [100, 900, 500]) {
      const p = staleSidecarPath(`${db}-tshm`, { now: new Date(Date.parse('2026-09-28T09:30:10.000Z') + ms), pid: 42 });
      writeFileSync(p, '');
      newest.push(basename(p));
    }
    const r = pruneStaleTshmSidecars(db, { now: Date.parse('2026-09-28T10:00:00.000Z') });
    expect(r.scanned).toBe(25);
    expect(r.kept).toBe(20);
    expect(r.pruned).toBe(5);
    const kept = r.entries.filter((e) => e.action === 'kept').map((e) => basename(e.file));
    expect(kept.slice(0, 3), 'new-format names rank newest first, by millisecond').toEqual([newest[1], newest[2], newest[0]]);
    const pruned = r.entries.filter((e) => e.action === 'pruned').map((e) => basename(e.file));
    expect(pruned.every((f) => /stale-2026-09-28-090[0-4]$/.test(f)), `oldest legacy pruned: ${pruned.join(', ')}`).toBe(true);
  });
});
