/**
 * BUG-026 follow-on — the foreign-`-shm` probe child opens the store
 * READ-WRITE with better-sqlite3. SQLite's pager, on a read-write open that
 * finds a `-wal` beside a main file of ZERO pages, DELETES the `-wal`
 * (`pagerOpenWalIfPresent`: `nPage == 0` → `sqlite3OsDelete(zWal)`). A Turso
 * store whose writes have never been checkpointed has exactly that shape: the
 * main file is 0 bytes (or under one page) and every row lives only in the
 * `-wal`. Probing such a store must never cost its data.
 *
 * Fixture: a child process writes rows through the RAW Turso driver and exits
 * WITHOUT closing (no close-time checkpoint), so the rows exist only in the
 * WAL. Turso itself always writes page 1 to the main file at create, so the
 * realistic Turso shape is a 1-page main (guarded, survives on its own); the
 * 0-byte and missing-main shapes are produced by truncating / omitting the main
 * file (a crashed copy, a partial restore, an external truncation). Each
 * precondition is asserted explicitly. A `-shm` is left beside the store so the
 * probe takes its spawning path.
 *
 * Teeth (BL-225): with the `size < 4096` guard in `probeForeignShmLock`
 * removed, the probe child deletes the `-wal` in both the 0-byte and the
 * missing-main case (and creates an empty main file in the latter).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, readFileSync, truncateSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { probeForeignShmLock } from '../foreign-shm-lock.js';

const require = createRequire(import.meta.url);
const resolveOrNull = (id: string): string | null => {
  try {
    return require.resolve(id);
  } catch {
    return null;
  }
};
const tursoPath = resolveOrNull('@tursodatabase/database');
const b3Path = resolveOrNull('better-sqlite3');
const d = tursoPath && b3Path ? describe : describe.skip;

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bug026-empty-main-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write `n` rows through the raw driver and exit WITHOUT close(). */
function writeWalOnlyRows(dbPath: string, n: number): void {
  const src = `
const { connect } = await import(${JSON.stringify(pathToFileURL(tursoPath!).href)});
const db = await connect(${JSON.stringify(dbPath)});
await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
for (let i = 0; i < ${n}; i++) await db.exec("INSERT INTO t (v) VALUES ('row-" + i + "')");
process.exit(0);
`;
  execFileSync(process.execPath, ['--input-type=module', '-e', src], { stdio: 'pipe' });
}

function countRows(dbPath: string): number {
  const src = `
const { connect } = await import(${JSON.stringify(pathToFileURL(tursoPath!).href)});
const db = await connect(${JSON.stringify(dbPath)});
let n;
try { n = (await db.get('SELECT count(*) AS n FROM t')).n; } catch (e) { n = 'ERR:' + e.message; }
process.stdout.write(String(n));
process.exit(0);
`;
  return Number(execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' }));
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

d('BUG-026 — the foreign-shm probe never deletes the -wal of a store whose data lives only in the WAL', () => {
  it('Turso-written store, rows only in -wal (main = page 1 only), -shm present: rows and -wal survive the probe', () => {
    // Turso always writes page 1 to the main file at create, so this is the
    // realistic WAL-only shape: every row lives in the WAL, main is 1 page.
    const dbPath = join(tmpDir, 'walonly.db');
    writeWalOnlyRows(dbPath, 25);
    expect(statSync(dbPath).size).toBeLessThanOrEqual(4096);
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    if (!existsSync(`${dbPath}-shm`)) writeFileSync(`${dbPath}-shm`, '');

    probeForeignShmLock(dbPath);

    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(countRows(dbPath)).toBe(25);
  }, 60_000);

  it('main file under one page (0 bytes), rows only in -wal, -shm present: probe declines without spawning; -wal and rows intact', () => {
    const dbPath = join(tmpDir, 'emptymain.db');
    writeWalOnlyRows(dbPath, 25);
    // Keep page 1 aside, then leave the main file at 0 bytes: the store's
    // data now exists ONLY in the -wal (the shape SQLite's pager deletes).
    const page1 = readFileSync(dbPath);
    truncateSync(dbPath, 0);
    writeFileSync(`${dbPath}-shm`, '');
    const walSha = sha(`${dbPath}-wal`);
    // Precondition, asserted: main under one page, WAL non-empty.
    expect(statSync(dbPath).size).toBeLessThan(4096);
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

    const probe = probeForeignShmLock(dbPath);
    expect(probe.state).toBe('indeterminate');
    expect(probe.method).toBe('none');

    // The -wal is still there, byte-identical ...
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(sha(`${dbPath}-wal`)).toBe(walSha);
    // ... and it still carries every row: restore page 1 and read them back.
    writeFileSync(dbPath, page1);
    expect(countRows(dbPath)).toBe(25);
  }, 60_000);

  it('main file missing (only -wal and -shm on disk): probe declines without spawning; nothing is created or deleted', () => {
    const src = join(tmpDir, 'src-missing.db');
    writeWalOnlyRows(src, 5);
    const dbPath = join(tmpDir, 'missing.db');
    writeFileSync(`${dbPath}-wal`, readFileSync(`${src}-wal`));
    writeFileSync(`${dbPath}-shm`, '');
    const walSha = sha(`${dbPath}-wal`);

    const probe = probeForeignShmLock(dbPath);
    expect(probe.state).toBe('indeterminate');
    expect(probe.method).toBe('none');
    // better-sqlite3 would have CREATED the main file and deleted the -wal.
    expect(existsSync(dbPath)).toBe(false);
    expect(sha(`${dbPath}-wal`)).toBe(walSha);
  }, 60_000);
});
