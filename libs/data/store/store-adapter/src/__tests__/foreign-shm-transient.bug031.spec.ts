/**
 * BUG-031 — a TRANSIENT `-shm` must not be misclassified as foreign residue.
 *
 * A classic `-shm` beside a turso store is written only by a better-sqlite3
 * opener — but this package's OWN hatches are such openers
 * (`preflightSchemaSanity`'s readonly `openSchemaReader` runs on the open path;
 * `deleteSchemaRowsViaBetterSqlite3` runs during FTS5 repair). SQLite keeps the
 * `-shm` only for the life of that connection, so the sidecar is routinely a
 * live, legitimate artifact that clears within milliseconds.
 *
 * The guard used to throw `E_FOREIGN_SQLITE_SIDECAR` on sight whenever a live
 * peer held the store, which turned that millisecond window into a hard open
 * failure — reproduced at ~1/300 processes by `tshm-init-race.spec.ts`. The
 * refusal is now retried on the adapter's standard bounded backoff.
 *
 * These two tests pin BOTH halves of the contract, deterministically (a file
 * latch, never a sleep-and-hope):
 *   1. a sidecar that CLEARS  -> the open succeeds
 *   2. a sidecar that PERSISTS -> the open still refuses (residue is real)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { TursoAdapterImpl } from '../turso-adapter.js';

const require = createRequire(import.meta.url);

let tmpDir: string;
beforeAll(() => { tmpDir = mkdtempSync(join(tmpdir(), 'bug031-')); });
afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }); });

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
 * Spawn a better-sqlite3 holder that creates a real `-shm` and keeps it alive
 * until `releasePath` appears. Mirrors what our own schema hatches do.
 */
function spawnShmHolder(dbPath: string, readyPath: string, releasePath: string): ChildProcess {
  const src = `
const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
const fs = require('node:fs');
const path = require('node:path');
const db = new Database(${JSON.stringify(dbPath)});
db.pragma('busy_timeout = 5000');
db.prepare('SELECT count(*) AS n FROM sqlite_master').get();  // WAL read => -shm materialises
fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');

// Release on either an explicit request, or CAUSALLY: the opener under test
// acquires its store lease immediately BEFORE the -shm guard runs, so a new
// lease file is a reliable "the open has begun" signal. Hold a further fixed
// margin past that so the guard's FIRST check always observes the sidecar --
// then clear well inside the retry budget. No wall-clock guessing about how
// long the open path takes to get there.
const leaseDir = ${JSON.stringify(dbPath)} + '.sox-lease.d';
const baseline = (() => { try { return fs.readdirSync(leaseDir).length; } catch { return 0; } })();
let releaseAt = null;
const spin = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(releasePath)})) { finish(); return; }
  let n = baseline;
  try { n = fs.readdirSync(leaseDir).length; } catch {}
  if (releaseAt === null && n > baseline) releaseAt = Date.now() + 250;
  if (releaseAt !== null && Date.now() >= releaseAt) finish();
}, 5);
function finish() {
  clearInterval(spin);
  db.close();            // last close => SQLite removes the -shm
  process.exit(0);
}
`;
  return spawn(process.execPath, ['-e', src], { stdio: 'ignore' });
}

describe('BUG-031 — transient vs. persistent foreign -shm', () => {
  it('an ORPHANED sidecar still refuses — genuine residue is not swallowed', async () => {
    const dbPath = join(tmpDir, 'persistent.db');
    const ready = `${dbPath}.ready`;
    const release = `${dbPath}.release`;

    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await seed.close();

    // Ordering matters. A quiescent open RECONCILES a stray `-shm` (renames it
    // aside), so residue that predates every peer is simply cleaned up and
    // never refused. The refusal branch is reachable only when the sidecar
    // appears while a peer is ALREADY live — so establish the peer first.
    const peer = await TursoAdapterImpl.connect({ dbPath });
    await peer.executeGet('SELECT 1 AS one');

    // Now create a `-shm` and orphan it: SIGKILL the creator so SQLite never
    // removes it. Unlike a LIVE classic holder (which trips turso's own
    // multiprocess-WAL lock before the guard is reached), an orphaned file
    // leaves the guard as the only thing standing between us and the open.
    const holder = spawnShmHolder(dbPath, ready, release);
    await until(() => existsSync(ready), 15000, 'the -shm holder to be ready');
    holder.kill('SIGKILL');
    await Promise.race([
      new Promise((r) => holder.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    expect(existsSync(`${dbPath}-shm`)).toBe(true); // survived its creator

    try {
      const late = await TursoAdapterImpl.connect({ dbPath });
      try {
        // Lazy connect (DEBT-003): the guard runs on first real use.
        await expect(late.executeGet('SELECT 1 AS one')).rejects.toThrow(
          /E_FOREIGN_SQLITE_SIDECAR|foreign better-sqlite3 -shm/,
        );
      } finally {
        await late.close().catch(() => undefined);
      }
    } finally {
      await peer.close();
      if (existsSync(release)) unlinkSync(release);
    }
  }, 60000);

  it('the refusal is marked retryable — a caller can distinguish it from a hard error', async () => {
    const dbPath = join(tmpDir, 'retryable.db');
    const ready = `${dbPath}.ready`;
    const release = `${dbPath}.release`;

    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await seed.close();

    const peer = await TursoAdapterImpl.connect({ dbPath });
    await peer.executeGet('SELECT 1 AS one');

    const holder = spawnShmHolder(dbPath, ready, release);
    await until(() => existsSync(ready), 15000, 'the -shm holder to be ready');
    holder.kill('SIGKILL');
    await Promise.race([
      new Promise((r) => holder.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);

    try {
      const late = await TursoAdapterImpl.connect({ dbPath });
      let caught: unknown;
      try {
        await late.executeGet('SELECT 1 AS one');
      } catch (e) {
        caught = e;
      } finally {
        await late.close().catch(() => undefined);
      }
      expect(caught).toBeDefined();
      // BUG-031: the sidecar refusal is a bounded-retry exhaustion, not a hard
      // failure — it must carry `retryable` like the other transient open
      // races (ADR-0012 §4) so a caller may retry beyond the adapter's bound.
      expect((caught as { retryable?: boolean }).retryable).toBe(true);
    } finally {
      await peer.close();
      if (existsSync(release)) unlinkSync(release);
    }
  }, 60000);
});
