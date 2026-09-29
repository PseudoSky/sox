/**
 * Offline rebuild/restore swap safety (store-rebuild.ts).
 *
 * - BL-e92196e2: a write by a separate process that opens, commits,
 *   checkpoints and exits between the snapshot (`VACUUM INTO`) and the swap is
 *   invisible to the swap-time peers/openers re-check. The swap must compare
 *   the source file against the identity recorded before the snapshot and
 *   refuse (`source_changed`), keeping the verified copy.
 * - BL-2c65c6a5: every sidecar inspection and the `-tshm` move happen only
 *   after the cold-open lock is held AND the peers/openers re-check passed — a
 *   late opener's `-tshm` is never moved.
 * - BL-74253544: restore never deletes artifacts it did not create beside the
 *   backup, refuses a backup that is the target file, and refuses a backup that
 *   is itself a live store.
 * - BL-94bcd318: a source without `_adapter_meta` verifies (the rebuild adds
 *   that table to the copy; it is allowed to appear).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rebuildStoreOffline, restoreStoreOffline } from '../store-rebuild.js';
import { TursoAdapterImpl } from '../turso-adapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WRITER_CHILD = path.join(here, 'fixtures', 'rebuild-late-writer-child.ts');

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmpDir(): string {
  // realpath: the store reports its canonical path (macOS /var → /private/var).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-rebuild-swap-')));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A closed, checkpointed adapter-managed store with `t(id, v)` and `rows` rows. */
async function seedStore(dbPath: string, rows = 20): Promise<void> {
  const a = await TursoAdapterImpl.connect({ dbPath });
  try {
    await a.executeRun('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    for (let i = 0; i < rows; i++) await a.executeRun('INSERT INTO t (v) VALUES (?)', [`row-${i}`]);
  } finally {
    await a.close();
  }
}

async function readValues(dbPath: string): Promise<string[]> {
  const a = await TursoAdapterImpl.connect({ dbPath, readonly: true, idleFlushMs: 3_600_000 });
  try {
    const { rows } = await a.executeAll<{ v: string }>('SELECT v FROM t ORDER BY id');
    return rows.map((r) => r.v);
  } finally {
    await a.close();
  }
}

/**
 * A live WRITABLE opener that has just checkpointed: its `-tshm` exists, its
 * `-wal` is empty, and it is still registered as an opener. (A plain writable
 * open leaves WAL frames — the engine stamp — and a readonly open creates no
 * `-tshm`; neither is the shape under test.)
 */
async function openCheckpointedPeer(dbPath: string): Promise<TursoAdapterImpl> {
  const peer = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 3_600_000 });
  await peer.executeGet('SELECT COUNT(*) AS n FROM t');
  await (peer.unwrap() as { exec(sql: string): Promise<unknown> }).exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return peer;
}

function staleTshms(dbPath: string): string[] {
  const prefix = `${path.basename(dbPath)}-tshm.stale-`;
  return fs.readdirSync(path.dirname(dbPath)).filter((n) => n.startsWith(prefix));
}

describe('offline rebuild — swap safety', () => {
  it('BL-e92196e2: a separate-process write between snapshot and swap refuses the swap and the live store keeps the write', async () => {
    const db = path.join(tmpDir(), 'store.db');
    await seedStore(db);
    let childOut = '';
    const report = await rebuildStoreOffline(db, {
      _beforeSwap: async () => {
        const r = spawnSync(process.execPath, ['--import', 'tsx', WRITER_CHILD, db, 'late-write'], {
          encoding: 'utf8',
          timeout: 60_000,
        });
        childOut = `${r.stdout}${r.stderr}`;
        expect(r.status, childOut).toBe(0);
        // Precondition: the writer checkpointed — a non-empty -wal would be
        // refused as sidecars_dirty and never reach the window under test.
        expect(fs.existsSync(`${db}-wal`) ? fs.statSync(`${db}-wal`).size : 0).toBe(0);
      },
    });
    expect(childOut).toContain('"written":true');
    // The live store keeps the late write (checked first: this is the data-loss assertion).
    const values = await readValues(db);
    expect(values).toContain('late-write');
    expect(values).toHaveLength(21);
    expect(report.status, JSON.stringify({ status: report.status, reason: report.reason, error: report.error })).toBe('refused');
    expect(report.reason).toBe('source_changed');
    // The verified copy is kept and reported.
    expect(report.rebuild_path).toBeDefined();
    expect(fs.existsSync(report.rebuild_path as string)).toBe(true);
    expect(report.backup_path).toBeUndefined();
  }, 120_000);

  it('BL-2c65c6a5: a late opener at swap time refuses the swap and its -tshm is untouched', async () => {
    const db = path.join(tmpDir(), 'store.db');
    await seedStore(db);
    let late: TursoAdapterImpl | null = null;
    let tshmIno: bigint | null = null;
    let staleBefore: string[] = [];
    cleanups.push(async () => {
      if (late) await late.close();
    });
    const report = await rebuildStoreOffline(db, {
      _beforeSwap: async () => {
        late = await openCheckpointedPeer(db);
        // Preconditions: the opener's -tshm exists, and there are no WAL frames
        // (a dirty WAL would refuse before the -tshm is reached on any code).
        expect(fs.existsSync(`${db}-tshm`)).toBe(true);
        expect(fs.existsSync(`${db}-wal`) ? fs.statSync(`${db}-wal`).size : 0).toBe(0);
        tshmIno = fs.statSync(`${db}-tshm`, { bigint: true }).ino;
        // The seed's own close already moved one -tshm aside; only a NEW
        // stale name would mean the swap moved the live peer's.
        staleBefore = staleTshms(db);
      },
    });
    expect(report.status, JSON.stringify({ status: report.status, reason: report.reason, error: report.error })).toBe('refused');
    // The live opener holds a lease (writable) — refused as `peers`; an
    // idle-released one is refused as `openers`. Either way: before any sidecar.
    expect(['peers', 'openers']).toContain(report.reason);
    expect(fs.existsSync(`${db}-tshm`)).toBe(true);
    expect(fs.statSync(`${db}-tshm`, { bigint: true }).ino).toBe(tshmIno);
    expect(staleTshms(db)).toEqual(staleBefore);
  }, 120_000);

  it('BUG-2e232ee9: a dry run leaves NO sidecar beside the source store', async () => {
    const db = path.join(tmpDir(), 'store.db');
    await seedStore(db);
    const dir = path.dirname(db);
    // The seed's own writable close already reconciled its `-tshm` (renamed
    // aside, never deleted) and left the post-close sidecars — the exact
    // pre-open state a `--dry-run` must hand back untouched.
    expect(fs.existsSync(`${db}-tshm`)).toBe(false);
    const before = fs.readdirSync(dir).sort();

    const report = await rebuildStoreOffline(db, { dryRun: true });
    expect(report.status, JSON.stringify({ status: report.status, reason: report.reason, error: report.error })).toBe('dry_run');

    // The soft-readonly source open (BL-391) is a native-WRITABLE handle and
    // creates a `-tshm`; the dry-run must remove exactly that. No `-tshm`, no
    // new `.stale-*`, no `-wal` change — the directory listing is identical.
    expect(fs.existsSync(`${db}-tshm`)).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  }, 120_000);

  it('BL-94bcd318: a source without _adapter_meta verifies and rebuilds', async () => {
    const db = path.join(tmpDir(), 'bare.db');
    const mod = (await import('@tursodatabase/database')) as unknown as {
      connect(p: string, o: Record<string, unknown>): Promise<{ exec(sql: string): Promise<unknown>; close(): Promise<unknown> | unknown }>;
    };
    const raw = await mod.connect(db, { timeout: 5000, experimental: ['index_method', 'multiprocess_wal'] });
    try {
      await raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
      await raw.exec("INSERT INTO t (v) VALUES ('a'), ('b'), ('c')");
      await raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      await raw.close();
    }
    fs.rmSync(`${db}-tshm`, { force: true });
    const report = await rebuildStoreOffline(db, { dryRun: true });
    expect(report.status, JSON.stringify({ status: report.status, reason: report.reason, error: report.error })).toBe('dry_run');
    const meta = report.verification?.table_counts.find((t) => t.table === '_adapter_meta');
    expect(meta).toMatchObject({ source: null, ok: true });
    expect(meta?.replacement).not.toBeNull();
    expect(report.verification?.ok).toBe(true);
  }, 120_000);
});

describe('offline restore — backup-side safety', () => {
  it('BL-74253544: restore leaves artifacts it did not create beside the backup', async () => {
    const dir = tmpDir();
    const db = path.join(dir, 'store.db');
    const backup = path.join(dir, 'backup.db');
    await seedStore(db, 5);
    await seedStore(backup, 7);
    for (const p of [`${backup}-wal`, `${backup}-tshm`]) fs.rmSync(p, { force: true });
    // Pre-existing artifacts that belong to someone else. A dot-name inside the
    // lease dir is skipped by every lease scanner, so it does not make the
    // backup "live".
    fs.mkdirSync(`${backup}.sox-lease.d`, { recursive: true });
    fs.writeFileSync(`${backup}.sox-lease.d/.keep`, 'not yours');
    fs.writeFileSync(`${backup}.sidecar-sweep-marker`, 'not yours');
    const report = await restoreStoreOffline(backup, db, { dryRun: true });
    expect(report.status, JSON.stringify({ status: report.status, reason: report.reason, error: report.error })).toBe('dry_run');
    expect(fs.readFileSync(`${backup}.sox-lease.d/.keep`, 'utf8')).toBe('not yours');
    expect(fs.readFileSync(`${backup}.sidecar-sweep-marker`, 'utf8')).toBe('not yours');
  }, 120_000);

  it('BL-74253544: restore refuses a backup that is the target file (same path or a hard-link alias)', async () => {
    const dir = tmpDir();
    const db = path.join(dir, 'store.db');
    await seedStore(db, 5);
    fs.mkdirSync(`${db}.sox-lease.d`, { recursive: true });
    fs.writeFileSync(`${db}.sox-lease.d/.keep`, 'live lease dir');
    const same = await restoreStoreOffline(db, db, { dryRun: true });
    expect(same.status).toBe('refused');
    expect(same.reason).toBe('backup_is_target');
    const alias = path.join(dir, 'alias.db');
    fs.linkSync(db, alias);
    const aliased = await restoreStoreOffline(alias, db, { dryRun: true });
    expect(aliased.status).toBe('refused');
    expect(aliased.reason).toBe('backup_is_target');
    expect(fs.readFileSync(`${db}.sox-lease.d/.keep`, 'utf8')).toBe('live lease dir');
  }, 120_000);

  it('BL-74253544: restore refuses a backup that is a live store and leaves its sidecars untouched', async () => {
    const dir = tmpDir();
    const db = path.join(dir, 'store.db');
    const backup = path.join(dir, 'other-scope.db');
    await seedStore(db, 5);
    await seedStore(backup, 7);
    const live = await openCheckpointedPeer(backup);
    cleanups.push(async () => {
      await live.close();
    });
    expect(fs.existsSync(`${backup}-tshm`)).toBe(true);
    expect(fs.statSync(`${backup}-wal`).size).toBe(0);
    const tshmIno = fs.statSync(`${backup}-tshm`, { bigint: true }).ino;
    const report = await restoreStoreOffline(backup, db, { dryRun: true });
    expect(report.status, JSON.stringify({ status: report.status, reason: report.reason, error: report.error })).toBe('refused');
    expect(report.reason).toBe('backup_in_use');
    expect(fs.existsSync(`${backup}.sox-lease.d`)).toBe(true);
    expect(fs.statSync(`${backup}-tshm`, { bigint: true }).ino).toBe(tshmIno);
  }, 120_000);
});
