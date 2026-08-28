/**
 * BUG-026 — LIFETIME WAL-ownership protocol.
 *
 * The turso 0.7.1 engine deleted the shared `-wal` under a long-lived
 * connection during a concurrent CLI close burst; the connection kept writing
 * to the orphaned inode for ~11.5h because `wal_identity` was captured ONLY at
 * open and compared ONLY at close. The poisoner that made the store reachable
 * by a foreign engine was graph-store's `engineIdentity` getter, whose
 * `getEngineIdentitySync` opened better-sqlite3 readonly on the turso store on
 * EVERY construction — creating the classic `-shm` (the 'exp9 poisoner').
 *
 * This suite pins the lifetime fix (red→green against real engines):
 *  - the WRITE path detects a replaced WAL immediately, folds the orphaned
 *    frames (PASSIVE), and recycles the connection;
 *  - the HEARTBEAT detects a replaced WAL while idle and bounds the crash
 *    window with a PASSIVE checkpoint;
 *  - the sqlite adapter gains the same write-path fail-loud + close-time fold;
 *  - a foreign `-shm` beside a turso store is reconciled (quiescent) or
 *    refused (live peers);
 *  - `getEngineIdentitySync` never opens a turso store with better-sqlite3.
 *
 * Modeled on `integrity-selfheal.test.ts` (BL-330) — same real-engine
 * `tursoDescribe` gate, same temp-store helpers, same "unlink the WAL then
 * assert the rows survive" shape.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  mkdtempSync,
  existsSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import { EStoreWalReplaced, EForeignSqliteSidecar } from '../wal-ownership.js';
import { walOwnershipHeartbeatMs, verifyWalIdentityNow } from '../wal-ownership.js';
import { getEngineIdentitySync } from '../engine-guard.js';
import { setIntegrityReportSink } from '../integrity.js';
import type { IntegrityReportEvent } from '../integrity.js';

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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bug026-'));
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (open.length > 0) {
    try {
      await open.pop()!.close();
    } catch {
      // already closed
    }
  }
});

function track<T extends { close(): Promise<void> }>(a: T): T {
  open.push(a);
  return a;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Capture every integrity event emitted during `fn`. */
async function captureEvents(
  fn: () => Promise<void>,
): Promise<{ event: IntegrityReportEvent; detail: string }[]> {
  const events: { event: IntegrityReportEvent; detail: string }[] = [];
  setIntegrityReportSink((event, detail) => events.push({ event, detail }));
  try {
    await fn();
  } finally {
    setIntegrityReportSink(null);
  }
  return events;
}

tursoDescribe('BUG-026 — turso lifetime WAL ownership', () => {
  it('write path: a replaced WAL is folded + the connection recycled — 144/144 rows survive', async () => {
    const dbPath = tempPath('turso-write-path');
    const a = track(await TursoAdapterImpl.connect({ dbPath }));
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < 140; i++) await a.executeRun('INSERT INTO t (v) VALUES (?)', ['v' + i]);

    // Precondition: the WAL exists and is this connection's baseline.
    expect(existsSync(dbPath + '-wal')).toBe(true);
    unlinkSync(dbPath + '-wal');
    expect(existsSync(dbPath + '-wal')).toBe(false);

    // The next write lands in the orphaned inode, then the write path detects
    // the replacement, folds it (PASSIVE), and poisons the connection.
    const events = await captureEvents(async () => {
      await a.executeRun('INSERT INTO t (v) VALUES (?)', ['orphaned']);
      // Connection recycled: three more writes transparently reconnect + land.
      for (let i = 0; i < 3; i++) await a.executeRun('INSERT INTO t (v) VALUES (?)', ['post' + i]);
    });

    // The damaged/repaired pair was emitted by the write-path recovery.
    expect(events.filter((e) => e.event === 'damaged').length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.event === 'repaired').length).toBeGreaterThanOrEqual(1);

    await a.close();
    open.pop();

    const b = track(await TursoAdapterImpl.connect({ dbPath }));
    const after = await b.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(
      after!.c,
      '140 + 1 orphaned + 3 recycled writes must all survive the WAL replacement',
    ).toBe(144);
  });

  it('heartbeat: a replaced WAL is detected while idle — damaged/repaired emitted and rows survive', async () => {
    const dbPath = tempPath('turso-heartbeat-idle');
    // Clamped to the 1000ms floor — the smallest permitted heartbeat interval.
    const a = track(await TursoAdapterImpl.connect({ dbPath, walOwnershipHeartbeatMs: 1000 }));
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < 10; i++) await a.executeRun('INSERT INTO t (v) VALUES (?)', ['v' + i]);

    expect(existsSync(dbPath + '-wal')).toBe(true);
    unlinkSync(dbPath + '-wal');
    expect(existsSync(dbPath + '-wal')).toBe(false);

    // No further writes — the heartbeat must detect + fold on its own.
    const events: { event: IntegrityReportEvent; detail: string }[] = [];
    setIntegrityReportSink((event, detail) => events.push({ event, detail }));
    try {
      await sleep(1600);
    } finally {
      setIntegrityReportSink(null);
    }

    expect(events.filter((e) => e.event === 'damaged').length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.event === 'repaired').length).toBeGreaterThanOrEqual(1);

    await a.close();
    open.pop();

    const b = track(await TursoAdapterImpl.connect({ dbPath }));
    const after = await b.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(after!.c).toBe(10);
  });

  it('heartbeat PASSIVE bounds the crash window: rows are in the main db before a later unlink+close', async () => {
    const dbPath = tempPath('turso-heartbeat-passive');
    const a = track(await TursoAdapterImpl.connect({ dbPath, walOwnershipHeartbeatMs: 1000 }));
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < 10; i++) await a.executeRun('INSERT INTO t (v) VALUES (?)', ['v' + i]);

    // Advance the heartbeat: an INTACT WAL gets a PASSIVE checkpoint (never
    // TRUNCATE mid-session), folding the rows into the main db file.
    await sleep(1600);

    // Now unlink the WAL and close with NO further write — without the
    // heartbeat's fold the rows would sit uncheckpointed in the (now orphaned)
    // WAL and be lost.
    unlinkSync(dbPath + '-wal');
    await a.close();
    open.pop();

    const b = track(await TursoAdapterImpl.connect({ dbPath }));
    const after = await b.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(after!.c).toBe(10);
  });

  it('stray -shm reconcile (quiescent): renamed to .stale- and the open succeeds', async () => {
    const dbPath = tempPath('shm-reconcile');
    const a = track(await TursoAdapterImpl.connect({ dbPath }));
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.close();
    open.pop();

    // Simulate the poisoner residue: a foreign better-sqlite3 -shm beside the
    // turso store (turso itself never creates or reads `-shm`).
    writeFileSync(dbPath + '-shm', '');
    expect(existsSync(dbPath + '-shm')).toBe(true);

    const events = await captureEvents(async () => {
      const b = track(await TursoAdapterImpl.connect({ dbPath }));
      await b.executeGet('SELECT COUNT(*) AS c FROM t'); // force the real open
    });

    // The foreign -shm was renamed to a .stale- forensic record.
    expect(existsSync(dbPath + '-shm')).toBe(false);
    const debris = readdirSync(dirname(dbPath)).filter((f) =>
      f.startsWith(basename(dbPath) + '-shm.stale-'),
    );
    expect(debris.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.event === 'repaired')).toBe(true);
  });

  it('stray -shm refusal (live peers): the open throws EForeignSqliteSidecar', async () => {
    const dbPath = tempPath('shm-refusal');
    const a = track(await TursoAdapterImpl.connect({ dbPath }));
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.close();
    open.pop();

    // A LIVE peer holds the store.
    const peer = track(await TursoAdapterImpl.connect({ dbPath }));
    await peer.executeGet('SELECT 1'); // real open, holds the lease

    // The poisoner leaves a foreign -shm beside the live store.
    writeFileSync(dbPath + '-shm', '');
    expect(existsSync(dbPath + '-shm')).toBe(true);

    // A third open with a live peer + foreign -shm refuses.
    const third = track(await TursoAdapterImpl.connect({ dbPath }));
    await expect(third.executeGet('SELECT 1')).rejects.toBeInstanceOf(EForeignSqliteSidecar);
  });

  it('probe-level guard: getEngineIdentitySync on a turso store returns null WITHOUT creating a db-shm', async () => {
    const dbPath = tempPath('probe-guard');
    const a = track(await TursoAdapterImpl.connect({ dbPath }));
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.close();
    open.pop();

    expect(existsSync(dbPath + '-shm')).toBe(false);
    const identity = getEngineIdentitySync(dbPath);
    expect(identity).toBeNull();
    // The poisoner is closed: no better-sqlite3 open, so no -shm is created.
    expect(existsSync(dbPath + '-shm')).toBe(false);
  });
});

describe('BUG-026 — sqlite lifetime WAL ownership', () => {
  it('write path: write → unlink → next write folds, the following write fails loud, rows survive', async () => {
    const dbPath = tempPath('sqlite-parity');
    const a = new SqliteAdapterImpl(dbPath);
    open.push(a);
    await a.exec('PRAGMA journal_mode = WAL;');
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.init(); // captures the WAL baseline after the schema exists

    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['row1']);
    expect(existsSync(dbPath + '-wal')).toBe(true);
    unlinkSync(dbPath + '-wal');
    expect(existsSync(dbPath + '-wal')).toBe(false);

    const events = await captureEvents(async () => {
      // The next write is written to the orphaned inode, then detected + folded.
      await a.executeRun('INSERT INTO t (v) VALUES (?)', ['row2']);
    });

    expect(events.filter((e) => e.event === 'damaged').length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.event === 'repaired').length).toBeGreaterThanOrEqual(1);

    // The following write fails loud — the connection will not keep writing
    // into an orphaned inode.
    await expect(
      a.executeRun('INSERT INTO t (v) VALUES (?)', ['row3']),
    ).rejects.toBeInstanceOf(EStoreWalReplaced);

    // Reads keep working: row1 + row2 were folded; row3 was rejected.
    const readCount = await a.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(readCount!.c).toBe(2);

    await a.close();
    open.pop();

    const b = new SqliteAdapterImpl(dbPath);
    open.push(b);
    await b.init();
    const after = await b.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(after!.c).toBe(2);
  });

  it('close-time identity fires: a replaced WAL is folded at close with no intervening write', async () => {
    const dbPath = tempPath('sqlite-close-time');
    const a = new SqliteAdapterImpl(dbPath);
    open.push(a);
    await a.exec('PRAGMA journal_mode = WAL;');
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.init();

    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['row1']);
    expect(existsSync(dbPath + '-wal')).toBe(true);
    unlinkSync(dbPath + '-wal');

    // Close with NO intervening write — the close-time identity check (parity
    // with TursoAdapterImpl.close()) must detect + fold.
    const events = await captureEvents(async () => {
      await a.close();
    });
    open.pop();

    expect(events.filter((e) => e.event === 'damaged').length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.event === 'repaired').length).toBeGreaterThanOrEqual(1);

    const b = new SqliteAdapterImpl(dbPath);
    open.push(b);
    await b.init();
    const after = await b.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(after!.c).toBe(1);
  });

  it('heartbeat PASSIVE folds an intact WAL into the main db (idle-flush TRUNCATE path unchanged)', async () => {
    const dbPath = tempPath('sqlite-heartbeat');
    const a = new SqliteAdapterImpl(dbPath, { walOwnershipHeartbeatMs: 1000 });
    open.push(a);
    await a.exec('PRAGMA journal_mode = WAL;');
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.init();

    for (let i = 0; i < 10; i++) await a.executeRun('INSERT INTO t (v) VALUES (?)', ['v' + i]);

    // Advance the heartbeat: intact → PASSIVE fold, then unlink + close with
    // no further write; the rows must survive.
    await sleep(1600);
    unlinkSync(dbPath + '-wal');
    await a.close();
    open.pop();

    const b = new SqliteAdapterImpl(dbPath);
    open.push(b);
    await b.init();
    const after = await b.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(after!.c).toBe(10);
  });

  it('typed tuning: the heartbeat env knob is clamped, never a toggle', () => {
    const prev = process.env.SOX_WAL_OWNERSHIP_HEARTBEAT_MS;
    try {
      delete process.env.SOX_WAL_OWNERSHIP_HEARTBEAT_MS;
      expect(walOwnershipHeartbeatMs()).toBe(10_000);
      process.env.SOX_WAL_OWNERSHIP_HEARTBEAT_MS = '1';
      expect(walOwnershipHeartbeatMs()).toBe(1_000); // clamped to the floor
      process.env.SOX_WAL_OWNERSHIP_HEARTBEAT_MS = '999999';
      expect(walOwnershipHeartbeatMs()).toBe(60_000); // clamped to the ceiling
      process.env.SOX_WAL_OWNERSHIP_HEARTBEAT_MS = 'garbage';
      expect(walOwnershipHeartbeatMs()).toBe(10_000); // non-finite → default
    } finally {
      if (prev === undefined) delete process.env.SOX_WAL_OWNERSHIP_HEARTBEAT_MS;
      else process.env.SOX_WAL_OWNERSHIP_HEARTBEAT_MS = prev;
    }
  });

  it('verifyWalIdentityNow reports no-baseline when nothing was captured at open', () => {
    expect(verifyWalIdentityNow(null).status).toBe('no-baseline');
    expect(verifyWalIdentityNow({ path: 'x-wal', present: false, dev: null, ino: null }).status).toBe(
      'no-baseline',
    );
  });
});
