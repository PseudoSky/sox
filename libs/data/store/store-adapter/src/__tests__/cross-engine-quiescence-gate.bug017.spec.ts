/**
 * BUG-017 — the cross-engine quiescence gate (SPEC §T1 Change 1, INV-1).
 *
 * The BUG-014 poisoner (deterministic repro, `/tmp/bug014-lab` exp9): a
 * WRITABLE better-sqlite3 open+close — even with ZERO writes — against a store
 * held by live turso multiprocess peers checkpoints/deletes the WAL at classic
 * close-time (classic SQLite cannot see `-tshm` clients, believes it is the
 * last connection). The fix: `deleteSchemaRowsViaBetterSqlite3` — the ONLY
 * writable classic-engine repair path — gates its open on
 * `storeQuiescence(dbPath, ownLeaseToken)` and DECLINES loudly under live
 * peers (typed `failed: 'declined: …'` + a `schema_repair_declined_live_peers`
 * warn, INV-5), deferring the repair until the store is quiescent.
 *
 * Harness: a REAL child process (fixture `bug017-quiescence-child.ts`) holds a
 * turso multiprocess connection with a populated WAL on a temp store carrying
 * deletable schema rows (fts5 residue).
 *
 * RED (pre-fix code): the unguarded delete runs and DESTROYS the WAL — the
 * exp9 assertion (`WAL 0 bytes after`) fails the run. GREEN (fix): the delete
 * is declined, the WAL is byte-identical before/after, and once the child is
 * killed (its lease swept as a dead pid) the SAME delete PROCEEDS and drops
 * the rows for real.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { deleteSchemaRowsViaBetterSqlite3 } from '../preflight.js';

const require = createRequire(import.meta.url);

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const CHILD = resolve(HERE, 'fixtures', 'bug017-quiescence-child.ts');

const FTS5_RESIDUE = [
  'fts_node',
  'fts_node_data',
  'fts_node_idx',
  'fts_node_docsize',
  'fts_node_config',
  'fts_node_ai',
  'fts_node_ad',
  'fts_node_au',
];

/** Build a store carrying the SQLite-era fts5 residue (via better-sqlite3,
 *  which has FTS5 compiled in) plus a real `node` table the child writes to. */
function buildResidueStore(dbPath: string): void {
  const Database = require('better-sqlite3') as new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): void };
    close(): void;
  };
  const db = new Database(dbPath);
  db.exec('CREATE TABLE node (rowid INTEGER PRIMARY KEY, uid TEXT, content TEXT)');
  db.exec(`CREATE VIRTUAL TABLE fts_node USING fts5(content,
    content='node', content_rowid='rowid', tokenize='unicode61')`);
  db.exec(`CREATE TRIGGER fts_node_ai AFTER INSERT ON node BEGIN
INSERT INTO fts_node (rowid, content) VALUES (new.rowid, new.content);
END`);
  db.exec(`CREATE TRIGGER fts_node_ad AFTER DELETE ON node BEGIN
INSERT INTO fts_node (fts_node, rowid, content) VALUES ('delete', old.rowid, old.content);
END`);
  db.exec(`CREATE TRIGGER fts_node_au AFTER UPDATE ON node BEGIN
INSERT INTO fts_node (fts_node, rowid, content) VALUES ('delete', old.rowid, old.content);
INSERT INTO fts_node (rowid, content) VALUES (new.rowid, new.content);
END`);
  db.prepare('INSERT INTO node (uid, content) VALUES (?, ?)').run('u1', 'hello world');
  db.close();
}

/** Resolve when the child prints `READY=<pid>` (or fail on early exit). */
function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for the peer child READY')),
      30000,
    );
    timer.unref();
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes('READY=')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`peer child exited before READY (code ${code})`));
    });
  });
}

/** Resolve when the child has exited — immediately if it already has. */
function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => child.once('exit', () => done()));
}

function walSizeBytes(dbPath: string): number {
  const walPath = `${dbPath}-wal`;
  return existsSync(walPath) ? statSync(walPath).size : 0;
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bug017-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

tursoDescribe('BUG-017 — the writable better-sqlite3 repair is quiescence-gated (INV-1)', () => {
  it(
    'declines under a live turso peer (WAL byte-identical; the exp9 poison does not fire), then proceeds after the peer dies',
    async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const dbPath = join(tmpDir, `gate-${suffix}.db`);
      buildResidueStore(dbPath);

      // Spawn the REAL turso multiprocess peer: connects, seeds a populated
      // WAL, idles holding the store (its lease entry stays live).
      const child: ChildProcess = spawn(
        process.execPath,
        ['--import', 'tsx', CHILD, dbPath],
        { stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd() },
      );
      await waitForReady(child);

      const walBefore = walSizeBytes(dbPath);
      expect(walBefore, 'the peer must have populated the WAL').toBeGreaterThan(0);

      // THE CALL UNDER TEST — on pre-fix code this is the exp9 poisoner.
      const result = deleteSchemaRowsViaBetterSqlite3(dbPath, FTS5_RESIDUE);

      // exp9 assertion (the RED diagnostic): an ungated writable classic
      // open+close under a live peer destroys the WAL (0 bytes on disk).
      const walAfter = walSizeBytes(dbPath);
      expect(
        walAfter,
        'BUG-017 (exp9): the WAL must survive the repair byte-for-byte — an ungated writable open destroys it',
      ).toBe(walBefore);

      // GREEN contract: typed decline (INV-1), nothing dropped (INV-5 loud).
      expect(
        result.failed,
        'BUG-017: the writable delete must be DECLINED while live peers hold the store',
      ).toMatch(/declined/);
      expect(
        result.dropped,
        'BUG-017: nothing may be dropped while a live peer holds the store',
      ).toEqual([]);

      // Kill the peer; its lease entry dies with it and storeQuiescence
      // sweeps the dead pid — the store is now quiescent.
      child.kill('SIGKILL');
      await waitForExit(child);

      // The SAME call now proceeds: quiescent ⇒ the delete drops the rows.
      const after = deleteSchemaRowsViaBetterSqlite3(dbPath, FTS5_RESIDUE);
      expect(after.failed, 'once quiescent, the repair must proceed').toBeNull();
      expect([...after.dropped].sort()).toEqual([...FTS5_RESIDUE].sort());
    },
    90000,
  );
});
