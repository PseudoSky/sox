/**
 * `releaseIdleConnection()` — idle connection release (store-connection-
 * lifetime design, 2026-08-17).
 *
 * Defect this exists to fix: `close()`'s `wal_checkpoint(TRUNCATE)` is
 * gated on zero live peers (`storeQuiescence`). A long-lived `backlog serve
 * --transport mcp` process holds its connection open for its ENTIRE
 * session — hours to days, per
 * `docs/reporting/memory/findings/2026-08-17-store-connection-lifetime-forensics.md`
 * — so the gate is essentially never quiescent, and 1,409
 * `store_adapter.turso.close_checkpoint_busy` events fired over 4 days
 * (2026-08-12..17), with real data loss (BUG-BACKLOG-PHANTOM-WRITES-ACKED-
 * NOT-DURABLE-001). The forensics ruled out orphaned leases (dead pids are
 * swept with zero grace) — the gate is correctly finding REAL live peers.
 *
 * The fix is not per-operation connection scoping (measured non-starter,
 * `tools/bench-connect-cost.mjs`, 450-530x cost vs a reused connection) —
 * it is giving a long-lived idle connection a way to voluntarily let go of
 * its lease during idle periods, so ANOTHER connection's close() finds a
 * genuinely quiescent store.
 *
 * What this file pins — the actual goal (BL-225: assert the property whose
 * absence caused the loss), NOT the proxy of "release returned true":
 *  1. Two connections open on the same store (non-quiescent) — a peer's
 *     close() defers TRUNCATE (the exact `close_checkpoint_busy` symptom).
 *  2. One connection calls `releaseIdleConnection()` — its lease entry is
 *     gone from the lease dir afterward.
 *  3. The SURVIVING connection's close() now finds the store quiescent and
 *     ACTUALLY TRUNCATES the WAL to ~0 bytes — the property that failed to
 *     hold for 4 days on the live store, now proven to hold.
 *  4. The released connection is NOT dead — it transparently reconnects on
 *     its next operation and can still read the data it wrote earlier.
 *  5. Negative controls: release is a no-op (`false`) when the connection
 *     is closed, already released, or has an operation in flight — it must
 *     never release mid-request.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { leaseDirPath } from '../store-lease.js';

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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-release-idle-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

tursoDescribe('releaseIdleConnection() — idle release produces a real quiescent window', () => {
  it('a peer releasing lets the survivor actually TRUNCATE the WAL, and the released connection keeps working', async () => {
    const dbPath = tempPath('release-truncate');

    // (1) Two connections open on the same store — the multi-serve-process
    // topology the forensics found live on this machine (4/4 leases were
    // `serve` pids).
    const server = await TursoAdapterImpl.connect({ dbPath }); // stands in for a long-lived `backlog serve` connection
    const cli = await TursoAdapterImpl.connect({ dbPath }); // stands in for a short-lived CLI connection

    await server.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await server.executeRun('INSERT INTO t (v) VALUES (?)', ['before-release']);

    const walPath = dbPath + '-wal';
    expect(existsSync(walPath), 'the write must have created the -wal file').toBe(true);
    expect(statSync(walPath).size, 'precondition: the WAL holds the uncheckpointed frame').toBeGreaterThan(0);

    // Precondition: NOT quiescent — two live connections.
    expect(readdirSync(leaseDirPath(dbPath)).filter((n) => !n.startsWith('.') && !n.endsWith('.openmark')).length).toBe(2);

    // (control) With BOTH connections still live, cli's close() must defer
    // the TRUNCATE — this is the exact close_checkpoint_busy symptom this
    // whole incident is about. Reproduce it as a control before the fix
    // path runs, on a THIRD connection so we don't tear down `server` yet.
    const control = await TursoAdapterImpl.connect({ dbPath });
    await control.close();
    expect(
      statSync(walPath).size,
      'control: closing one of THREE live connections must NOT truncate — server and cli are still live peers',
    ).toBeGreaterThan(0);

    // (2) The long-lived `server` connection releases while idle.
    const released = await server.releaseIdleConnection();
    expect(released, 'releaseIdleConnection() must succeed when idle and healthy').toBe(true);

    // server's lease entry must be gone — this is what creates the window.
    const remaining = readdirSync(leaseDirPath(dbPath)).filter((n) => !n.startsWith('.') && !n.endsWith('.openmark'));
    expect(remaining.length, 'the released connection\'s lease entry must be gone').toBe(1);

    // (3) THE assertion that is the actual goal: cli's close() now finds a
    // genuinely quiescent store (excluding cli's OWN entry, exactly like
    // close()'s internal `storeQuiescence(coordDb, this._lease.token)` call
    // — only `server`'s entry mattered as a peer, and it's gone) and
    // ACTUALLY TRUNCATES — the property that failed to hold for 4 days on
    // the live store (1,409 deferred events).
    await cli.close();
    expect(
      statSync(walPath).size,
      'the real goal: with the server connection released, cli close() must TRUNCATE the WAL to ~0 bytes',
    ).toBe(0);

    // (4) The released connection is not dead — it transparently
    // reconnects on its next operation and still sees its own earlier
    // write (the main db file, not WAL replay — cli already truncated it).
    const row = await server.executeGet<{ v: string }>('SELECT v FROM t WHERE v = ?', ['before-release']);
    expect(row?.v, 'a released connection must transparently reconnect and keep working').toBe('before-release');
    expect(server.connectionHealth).toBe('healthy');

    await server.close();
  });

  it('negative controls: release is a no-op when closed, already released, or an op is in flight', async () => {
    const dbPath = tempPath('release-negative-controls');
    const a = await TursoAdapterImpl.connect({ dbPath });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    // Busy: an in-flight operation must block release — never mid-request.
    const slowWrite = a.executeRun('INSERT INTO t (v) VALUES (?)', ['x']);
    const releasedWhileBusy = await a.releaseIdleConnection();
    expect(releasedWhileBusy, 'release must refuse while an operation is in flight').toBe(false);
    await slowWrite;

    // Idle now — release should succeed.
    const releasedOk = await a.releaseIdleConnection();
    expect(releasedOk).toBe(true);

    // Already released — idempotent no-op, not an error.
    const releasedAgain = await a.releaseIdleConnection();
    expect(releasedAgain, 'a second release call while already released must no-op, not double-teardown').toBe(false);

    // Permanently closed — release must refuse (close() is the right call).
    await a.close();
    const releasedAfterClose = await a.releaseIdleConnection();
    expect(releasedAfterClose, 'release must refuse on a permanently closed adapter').toBe(false);
  });

  it('mid-transaction: releaseIdleConnection() never tears down a connection with an open transaction', async () => {
    const dbPath = tempPath('release-mid-transaction');
    const a = await TursoAdapterImpl.connect({ dbPath });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    let releasedDuringTx = false;
    const tx = a.transaction(async (t) => {
      // Fire a release attempt WHILE inside the transaction body — it must
      // observe the connection as busy and refuse.
      releasedDuringTx = await a.releaseIdleConnection();
      await t.executeRun('INSERT INTO t (v) VALUES (?)', ['tx-row']);
    });
    await tx;

    expect(releasedDuringTx, 'release must refuse while a transaction is in flight').toBe(false);

    const row = await a.executeGet<{ v: string }>('SELECT v FROM t WHERE v = ?', ['tx-row']);
    expect(row?.v, 'the transaction must have completed normally, undisturbed by the refused release').toBe('tx-row');

    await a.close();
  });
});
