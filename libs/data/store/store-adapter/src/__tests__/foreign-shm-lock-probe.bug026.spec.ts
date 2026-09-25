/**
 * BUG-026 — FOREIGN `-shm` LOCK PROBE (reconcile under live peers) + the
 * readonly preflight's own-sidecar cleanup.
 *
 * The defect: a persistent classic `-shm` beside a TURSO store was reconciled
 * only when the store was quiescent; under ANY live turso peer the open threw
 * `EForeignSqliteSidecar` and never recovered, so a store with residue was
 * unopenable for as long as a peer held it (adhd backlog 7825b4b5).
 *
 * The fix is a LOCK PROBE (`probeForeignShmLock`): a live classic opener holds
 * a SHARED lock on the store, so an EXCLUSIVE better-sqlite3 open succeeds iff
 * no live classic opener exists — even while live TURSO peers hold the store
 * (turso never reads the classic `-shm`). The probe runs in a short-lived child
 * that opens read-write, takes the exclusive lock, and exits WITHOUT close()
 * so it can never checkpoint/delete the shared `-wal` (the exp9 poisoner).
 *
 * Teeth (BL-225): each integration arm is RED on the pre-fix code —
 *   - the abandoned-residue arm THROWS `EForeignSqliteSidecar` pre-fix;
 *   - the non-destructive arm fails pre-fix (no probe existed);
 *   - the negative control fails if the reconcile ever ignores the probe.
 *
 * No sleeps for ordering: readiness is a file latch, and liveness is inferred
 * from the probe's own verdict. Temp stores are cleaned up.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, chmodSync, rmSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { log } from '@adhd/sox-telemetry';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { EForeignSqliteSidecar } from '../wal-ownership.js';
import { probeForeignShmLock } from '../foreign-shm-lock.js';
import { preflightSchemaSanity } from '../preflight.js';

/** SHA-256 of a file's full bytes — used where "byte-identical" must mean the
 *  entire content, not merely the same length (two different WAL frames can
 *  coincidentally share a byte count). */
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const require = createRequire(import.meta.url);
const BETTER_SQLITE3 = require.resolve('better-sqlite3');

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
  tmpDir = mkdtempSync(join(tmpdir(), 'bug026-shm-lock-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function tempPath(label: string): string {
  return join(tmpDir, `${label}-${seq++}.db`);
}

/** Wait until `pred()` holds, on a bounded deadline — never a bare sleep. */
async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out after ${ms}ms waiting for: ${what}`);
}

/**
 * Spawn a classic better-sqlite3 opener on `dbPath` that materialises a real
 * `-shm` (a WAL read) and then either holds the connection open (a LIVE classic
 * reader) or is SIGKILLed by the caller (leaving abandoned residue). Mirrors
 * exactly what this package's own schema hatches / a stock `sqlite3` do.
 */
function spawnClassicOpener(
  dbPath: string,
  readyPath: string,
  opts: { hold: boolean; rows?: number },
): ChildProcess {
  const writes = opts.rows
    ? `const ins = db.prepare('INSERT INTO t (v) VALUES (?)'); for (let i=0;i<${opts.rows};i++) ins.run('v'+i);`
    : '';
  const src = `
const Database = require(${JSON.stringify(BETTER_SQLITE3)});
const fs = require('node:fs');
const db = new Database(${JSON.stringify(dbPath)});
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
${writes}
db.prepare('SELECT count(*) AS n FROM sqlite_master').get(); // WAL read => -shm materialises
fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
${
  opts.hold
    ? 'setTimeout(() => { db.close(); process.exit(0); }, 60000);'
    : 'setTimeout(() => process.exit(0), 60000);' // hold briefly so the parent can SIGKILL with the -shm on disk
}
`;
  return spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'ignore', 'ignore'] });
}

async function killAndWait(child: ChildProcess): Promise<void> {
  child.kill('SIGKILL');
  await Promise.race([
    new Promise((r) => child.once('exit', r)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
}

const staleDebris = (dbPath: string): string[] =>
  readdirSync(dirname(dbPath)).filter(
    (f) => f.startsWith(basename(dbPath) + '-shm.stale-'),
  );

// ═══════════════════════════════════════════════════════════════════════════
// probeForeignShmLock — the primitive
// ═══════════════════════════════════════════════════════════════════════════

describe('probeForeignShmLock — exclusive-lock probe primitive', () => {
  it('returns absent (a single statSync) when there is no -shm', () => {
    const dbPath = tempPath('absent');
    const probe = probeForeignShmLock(dbPath);
    expect(probe.state).toBe('absent');
    expect(probe.method).toBe('none');
  });

  it('returns locked while a LIVE classic opener holds the store', async () => {
    const dbPath = tempPath('locked');
    const ready = `${dbPath}.ready`;
    const holder = spawnClassicOpener(dbPath, ready, { hold: true });
    try {
      await until(() => existsSync(ready), 15000, 'the classic opener to be ready');
      expect(existsSync(dbPath + '-shm')).toBe(true);
      const probe = probeForeignShmLock(dbPath);
      expect(probe.state).toBe('locked');
      expect(probe.method).toBe('exclusive-better-sqlite3');
    } finally {
      await killAndWait(holder);
    }
  });

  it('returns unlocked for abandoned residue, and leaves a populated -wal BYTE-IDENTICAL (non-destructive)', async () => {
    const dbPath = tempPath('unlocked');
    const ready = `${dbPath}.ready`;
    const writer = spawnClassicOpener(dbPath, ready, { hold: false, rows: 2000 });
    await until(() => existsSync(ready), 15000, 'the classic opener to be ready');
    await killAndWait(writer); // SIGKILL: -shm + a populated -wal survive

    expect(existsSync(dbPath + '-shm'), 'residue precondition: a -shm survives its creator').toBe(
      true,
    );
    const shmPath = dbPath + '-shm';
    const walPath = dbPath + '-wal';
    expect(statSync(walPath).size, 'precondition: a populated WAL').toBeGreaterThan(0);
    const walHashBefore = sha256(walPath);
    const shmHashBefore = sha256(shmPath);

    const probe = probeForeignShmLock(dbPath);
    expect(probe.state).toBe('unlocked');

    // The probe's read-write child must NEVER checkpoint/delete the shared WAL
    // (the exp9 poisoner). "Byte-identical" is checked over the FULL content
    // (a hash), not merely the size — two different WAL states can coincide on
    // size while differing in content.
    expect(sha256(walPath), 'the probe must not mutate a single byte of the shared -wal').toBe(
      walHashBefore,
    );
    expect(sha256(shmPath), 'the probe must not mutate a single byte of the -shm').toBe(
      shmHashBefore,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// probeForeignShmLock — the stat() failure branch (untraced-catch fix)
// ═══════════════════════════════════════════════════════════════════════════

describe('probeForeignShmLock — stat() failure handling', () => {
  it('ENOENT (no -shm at all) → absent, and never logs (the hot no-op path)', () => {
    const dbPath = tempPath('stat-enoent');
    const debugSpy = vi.spyOn(log, 'debug');
    try {
      const probe = probeForeignShmLock(dbPath);
      expect(probe.state).toBe('absent');
      expect(probe.method).toBe('none');
      expect(
        debugSpy.mock.calls.some(([event]) => String(event).startsWith('store_adapter.foreign_shm')),
      ).toBe(false);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('a non-ENOENT stat failure (EACCES-like) is logged and degrades safely to indeterminate', () => {
    const blockedDir = mkdtempSync(join(tmpDir, 'stat-eacces-'));
    const dbPath = join(blockedDir, 'store.db');
    // Remove all permissions on the CONTAINING directory so statSync(<dbPath>-shm)
    // fails with EACCES rather than ENOENT (the file's own existence is
    // unknowable without traversing the now-unreadable directory).
    chmodSync(blockedDir, 0o000);
    const debugSpy = vi.spyOn(log, 'debug');
    try {
      const probe = probeForeignShmLock(dbPath);
      // Must degrade to the safe direction — never wrongly report `absent`
      // (which would let a caller believe there is nothing to reconcile) or
      // `unlocked` (which would let a caller touch a sidecar it never proved
      // safe to touch).
      expect(probe.state).toBe('indeterminate');
      expect(probe.method).toBe('none');
      expect(probe.detail).toMatch(/stat of -shm sidecar failed/);
      const logged = debugSpy.mock.calls.find(
        ([event]) => event === 'store_adapter.foreign_shm.probe_stat_failed',
      );
      expect(logged, 'the non-ENOENT stat failure must be traced, never swallowed silently').toBeTruthy();
      expect(logged?.[1]).toMatchObject({ db_path: dbPath });
    } finally {
      debugSpy.mockRestore();
      chmodSync(blockedDir, 0o700); // restore so afterAll's rmSync(tmpDir) can clean up
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration — reconcile under live turso peers
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BUG-026 — abandoned -shm is reconciled even while a turso peer holds the store', () => {
  it('POSITIVE (RED pre-fix): live turso peer + abandoned classic -shm → the open SUCCEEDS and the -shm is renamed aside', async () => {
    const dbPath = tempPath('reconcile-under-peers');
    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await seed.executeRun('INSERT INTO t (v) VALUES (?)', ['seed']);
    await seed.close();

    const peer = await TursoAdapterImpl.connect({ dbPath });
    await peer.executeGet('SELECT 1 AS one'); // live turso peer holds the store

    const ready = `${dbPath}.ready`;
    const classic = spawnClassicOpener(dbPath, ready, { hold: false });
    await until(() => existsSync(ready), 15000, 'the classic opener to be ready');
    await killAndWait(classic); // leave an abandoned, unlocked -shm
    expect(existsSync(dbPath + '-shm')).toBe(true);

    try {
      // Pre-fix this throws EForeignSqliteSidecar (live peer + foreign -shm).
      const late = await TursoAdapterImpl.connect({ dbPath });
      try {
        const row = await late.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
        expect(row!.c).toBe(1);
      } finally {
        await late.close().catch(() => undefined);
      }
      // Reconciled: the -shm was renamed to a .stale- forensic record.
      expect(existsSync(dbPath + '-shm')).toBe(false);
      expect(staleDebris(dbPath).length).toBeGreaterThanOrEqual(1);
    } finally {
      await peer.close();
    }
  });

  it('NEGATIVE CONTROL: live turso peer + LIVE classic opener → the open REFUSES and the -shm is NOT renamed', async () => {
    const dbPath = tempPath('refuse-live-classic');
    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await seed.executeGet('SELECT 1');
    await seed.close();

    const peer = await TursoAdapterImpl.connect({ dbPath });
    await peer.executeGet('SELECT 1 AS one');

    const ready = `${dbPath}.ready`;
    const classic = spawnClassicOpener(dbPath, ready, { hold: true }); // STAYS ALIVE
    await until(() => existsSync(ready), 15000, 'the classic opener to be ready');
    const walBefore = statSync(dbPath + '-wal').size;
    expect(existsSync(dbPath + '-shm')).toBe(true);

    try {
      const late = await TursoAdapterImpl.connect({ dbPath });
      try {
        await expect(late.executeGet('SELECT 1 AS one')).rejects.toBeInstanceOf(
          EForeignSqliteSidecar,
        );
      } finally {
        await late.close().catch(() => undefined);
      }
      // The live opener's sidecar must be left strictly alone.
      expect(
        existsSync(dbPath + '-shm'),
        'a live classic opener’s -shm must never be reconciled',
      ).toBe(true);
      expect(staleDebris(dbPath), 'nothing may be renamed out from under a live reader').toHaveLength(0);
      expect(statSync(dbPath + '-wal').size).toBe(walBefore);
    } finally {
      await killAndWait(classic);
      await peer.close();
    }
  });

  it('NEGATIVE CONTROL (quiescent): a live classic holder with NO turso peer → REFUSES and does NOT rename the -shm', async () => {
    const dbPath = tempPath('refuse-quiescent-classic');
    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await seed.executeGet('SELECT 1');
    await seed.close();

    // A live classic opener holds the store, but NO turso peer does — so the
    // adapter sees the store as QUIESCENT. This is the sharp case: the pre-fix
    // quiescence gate would rename this sidecar out from under the live reader.
    // Only the lock probe protects it.
    const ready = `${dbPath}.ready`;
    const classic = spawnClassicOpener(dbPath, ready, { hold: true });
    await until(() => existsSync(ready), 15000, 'the classic opener to be ready');
    expect(existsSync(dbPath + '-shm')).toBe(true);

    try {
      const late = await TursoAdapterImpl.connect({ dbPath });
      try {
        await expect(late.executeGet('SELECT 1 AS one')).rejects.toBeInstanceOf(
          EForeignSqliteSidecar,
        );
      } finally {
        await late.close().catch(() => undefined);
      }
      expect(
        existsSync(dbPath + '-shm'),
        'a live reader’s -shm must never be renamed, even on a quiescent store',
      ).toBe(true);
      expect(staleDebris(dbPath), 'nothing may be renamed out from under a live reader').toHaveLength(
        0,
      );
    } finally {
      await killAndWait(classic);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix #2 — the readonly preflight removes its OWN -shm on close
// ═══════════════════════════════════════════════════════════════════════════

describe('BUG-026 — readonly preflight does not leave a -shm residue', () => {
  it('removes its own -shm on close (a read-only SQLite handle cannot unlink it itself)', async () => {
    const dbPath = tempPath('preflight-cleanup');
    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await seed.close();
    expect(existsSync(dbPath + '-shm')).toBe(false);

    // The readonly reader materialises a -shm; the fix removes it before returning.
    const result = preflightSchemaSanity(dbPath);
    expect(result.ran).toBe(true);
    expect(
      existsSync(dbPath + '-shm'),
      'the preflight must not leave its own -shm behind',
    ).toBe(false);
  });

  it('NEGATIVE CONTROL: leaves a LIVE classic opener’s -shm in place', async () => {
    const dbPath = tempPath('preflight-negative');
    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await seed.close();

    const ready = `${dbPath}.ready`;
    const classic = spawnClassicOpener(dbPath, ready, { hold: true });
    try {
      await until(() => existsSync(ready), 15000, 'the classic opener to be ready');
      expect(existsSync(dbPath + '-shm')).toBe(true);

      const result = preflightSchemaSanity(dbPath);
      expect(result.ran).toBe(true);
      expect(
        existsSync(dbPath + '-shm'),
        'the cleanup must not remove a live reader’s -shm',
      ).toBe(true);
    } finally {
      await killAndWait(classic);
    }
  });
});
