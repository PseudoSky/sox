/**
 * 98fe54a3 — prod memory-server repeatedly opened / idle-flushed / BUG-026-
 * reconciled `~/.memory/backups/backfill-503cdc2b-apply-….db`.
 *
 * Root cause: every tool call that resolves a `db_path` (memory_ping's store
 * block included) added it to `openedPaths`, the set the enrich, drain and
 * compaction loops iterate forever. One `memory_ping db_path=<backup>` (a
 * post-backfill verification) therefore enlisted the backup into background
 * maintenance for the life of the process — reopened every tick, and eligible
 * for heal WRITES into a point-in-time snapshot.
 *
 * Fix: `enlistForBackgroundMaintenance` refuses stores inside the backup dir,
 * and the call that touched one closes + evicts it on the way out.
 *
 * RED (fix disabled — enlistment always adds): the backup is enlisted.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeAllAdapters, WriteQueue, getDb } from '@adhd/sox-memory-core';
import {
  handleToolCall,
  enlistForBackgroundMaintenance,
  _isEnlistedForBackgroundMaintenanceForTest,
} from './index.js';

let root: string;
let prevBackupDir: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-98fe54a3-'));
  prevBackupDir = process.env.SOX_AUTO_BACKUP_DIR;
  process.env.SOX_AUTO_BACKUP_DIR = path.join(root, 'backups');
  fs.mkdirSync(process.env.SOX_AUTO_BACKUP_DIR, { recursive: true });
});

afterEach(async () => {
  await closeAllAdapters();
  await WriteQueue.clearInstances();
  if (prevBackupDir === undefined) delete process.env.SOX_AUTO_BACKUP_DIR;
  else process.env.SOX_AUTO_BACKUP_DIR = prevBackupDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('98fe54a3 — a backup store is never enlisted into background maintenance', () => {
  it('enlistForBackgroundMaintenance refuses a backup-dir path and accepts a live store path', () => {
    const backup = path.join(root, 'backups', 'backfill-503cdc2b-apply-2026-09-25T03-24-21-520Z-e7d9j3.db');
    const live = path.join(root, 'live', 'memory.db');
    expect(enlistForBackgroundMaintenance(backup)).toBe(false);
    expect(_isEnlistedForBackgroundMaintenanceForTest(backup)).toBe(false);
    expect(enlistForBackgroundMaintenance(live)).toBe(true);
    expect(_isEnlistedForBackgroundMaintenanceForTest(live)).toBe(true);
  });

  it('memory_ping db_path=<backup> does not enlist it and does not leave it open', async () => {
    const backup = path.join(root, 'backups', 'backfill-503cdc2b-apply-x.db');
    // Materialise a real store at the backup path first (as the backfill would).
    const seed = await getDb(backup);
    await seed.executeGet('SELECT 1 AS one');
    await closeAllAdapters();
    await WriteQueue.clearInstances();

    const resp = await handleToolCall('memory_ping', { db_path: backup });
    expect(resp.isError).not.toBe(true);
    expect(_isEnlistedForBackgroundMaintenanceForTest(backup)).toBe(false);
    // Released on the way out: the lease directory holds no live entry from us.
    const leaseDir = `${backup}.sox-lease.d`;
    // Dot-names (the `.openers/` registry dir, `.coldopen.lock`) are not lease
    // entries — the same rule `storeQuiescence` applies.
    const entries = fs.existsSync(leaseDir) ? fs.readdirSync(leaseDir).filter((e) => !e.startsWith('.')) : [];
    // Entry name = connection token; content = `<pid>\n<openedAt>\n`.
    const ours = entries.filter(
      (e) => fs.readFileSync(path.join(leaseDir, e), 'utf8').split('\n')[0] === String(process.pid),
    );
    expect(ours).toEqual([]);
  });
});
