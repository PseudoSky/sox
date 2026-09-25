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
 * (BUG-026, later) The verdict is now a LOCK PROBE, not "does the file clear":
 * an ORPHANED sidecar (its creator SIGKILLed) is provably unlocked and is
 * RECONCILED, even under live turso peers — it is no longer refused. Only a
 * LIVE classic holder (a shared lock is held) still refuses. These two tests
 * pin BOTH halves of that contract, deterministically (a file latch, never a
 * sleep-and-hope):
 *   1. an ABANDONED sidecar -> the open succeeds and the sidecar is reclaimed
 *   2. a LIVE classic holder -> the open still refuses (and is `retryable`)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { EForeignSqliteSidecar } from '../wal-ownership.js';

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
function spawnShmHolder(
  dbPath: string,
  readyPath: string,
  releasePath: string,
  opts: { hold?: boolean } = {},
): ChildProcess {
  const src = `
const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
const fs = require('node:fs');
const path = require('node:path');
const HOLD = ${opts.hold === true};
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
  if (HOLD) return; // a persistent LIVE holder (used by the refusal arm)
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

describe('BUG-031 — abandoned vs. live-holder foreign -shm', () => {
  it('an ABANDONED sidecar is RECONCILED — the open succeeds (BUG-026 supersedes refuse-on-sight)', async () => {
    const dbPath = join(tmpDir, 'abandoned.db');
    const ready = `${dbPath}.ready`;
    const release = `${dbPath}.release`;

    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await seed.close();

    // A live turso peer holds the store — under the OLD BUG-026 gate that was
    // enough to refuse; under the lock probe it is NOT (turso never reads the
    // classic -shm). Establish the peer first so the sidecar appears while it
    // is live.
    const peer = await TursoAdapterImpl.connect({ dbPath });
    await peer.executeGet('SELECT 1 AS one');

    // Create a real `-shm`, then orphan it: SIGKILL the creator so SQLite never
    // removes it. No live classic holder remains, so the probe proves it
    // unlocked and it is reconciled.
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
        // Lazy connect (DEBT-003): the guard runs on first real use. It must NOT
        // throw now — the abandoned sidecar is reclaimed.
        const row = await late.executeGet<{ one: number }>('SELECT 1 AS one');
        expect(row!.one).toBe(1);
      } finally {
        await late.close().catch(() => undefined);
      }
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
    } finally {
      await peer.close();
      if (existsSync(release)) unlinkSync(release);
    }
  }, 60000);

  it('a LIVE classic holder is refused, and the refusal is marked retryable', async () => {
    const dbPath = join(tmpDir, 'live-holder.db');
    const ready = `${dbPath}.ready`;
    const release = `${dbPath}.release`;

    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await seed.close();

    const peer = await TursoAdapterImpl.connect({ dbPath });
    await peer.executeGet('SELECT 1 AS one');

    // A persistent LIVE holder — `hold: true` disables the causal auto-release,
    // so it keeps its shared lock for the whole assertion window.
    const holder = spawnShmHolder(dbPath, ready, release, { hold: true });
    try {
      await until(() => existsSync(ready), 15000, 'the -shm holder to be ready');
      expect(existsSync(`${dbPath}-shm`)).toBe(true);

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
      expect(caught).toBeInstanceOf(EForeignSqliteSidecar);
      // BUG-031: the sidecar refusal is a bounded-retry exhaustion, not a hard
      // failure — it must carry `retryable` like the other transient open
      // races (ADR-0012 §4) so a caller may retry beyond the adapter's bound.
      expect((caught as { retryable?: boolean }).retryable).toBe(true);
      // The live holder's sidecar is left strictly alone.
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
    } finally {
      holder.kill('SIGKILL');
      await Promise.race([
        new Promise((r) => holder.once('exit', r)),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      await peer.close();
    }
  }, 60000);
});
