/**
 * curate-merge-duplicates-reason.spec.ts — merge_duplicates records its
 * invalidation cause (f7461993).
 *
 * BUG-CLUSTER f7461993: 89 invalidated episodes carried no recorded reason.
 * `curateMergeDuplicates` (curate.ts) was one of the two root-cause writers —
 * it invalidated the dropped uid with a bare `UPDATE node SET t_invalid = ?`
 * and had no `reason` parameter at all. This spec proves the dropped row now
 * carries an `invalidatedReason` after the shared `invalidateEpisodeInTx`
 * helper is used.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { memoryCurate } from './curate.js';

function raw(a: StoreAdapter): Database.Database {
  return a.unwrap() as Database.Database;
}

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcurate-merge-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('memoryCurate merge_duplicates — every invalidation records its reason (f7461993)', () => {
  let cleanupDb: () => void;
  let db: StoreAdapter;

  beforeEach(async () => {
    const { dir, cleanup } = tmpDir();
    cleanupDb = cleanup;
    db = await openDb(path.join(dir, 't.db'));
  });

  afterEach(async () => {
    if (db && raw(db).open) await db.close();
    cleanupDb();
  });

  async function writeEpisode(content: string): Promise<string> {
    const r = await memoryWrite(db, { content, project_path: '/test/project' });
    expect('episode_uid' in r).toBe(true);
    return (r as { episode_uid: string }).episode_uid;
  }

  it('(f7461993) merge_duplicates records invalidatedReason on the dropped episode', async () => {
    const uidKeep = await writeEpisode('Canonical fact: the sky is blue.');
    const uidDrop = await writeEpisode('Duplicate: the sky is blue-ish, apparently.');

    const result = (await memoryCurate(db, {
      op: 'merge_duplicates',
      uid_keep: uidKeep,
      uid_drop: uidDrop,
      dry_run: false,
    })) as { op: string; uid_dropped: string };

    expect(result.op).toBe('merge_duplicates');
    expect(result.uid_dropped).toBe(uidDrop);

    // BUG (pre-fix): the dropped row's t_invalid was set with a bare
    // `UPDATE node SET t_invalid = ?` — no reason parameter existed anywhere
    // in curateMergeDuplicates, so node.meta never recorded WHY the row was
    // invalidated.
    const row = await db.executeGet<{ t_invalid: string | null; meta: string | null }>(
      `SELECT t_invalid, meta FROM node WHERE uid = ?`,
      [uidDrop],
    );
    expect(row).toBeDefined();
    expect(row!.t_invalid).not.toBeNull();

    const meta = JSON.parse(row!.meta ?? '{}') as Record<string, unknown>;
    expect(typeof meta.invalidatedReason).toBe('string');
    expect((meta.invalidatedReason as string).length).toBeGreaterThan(0);
    expect(meta.invalidatedReason).toContain(uidKeep);
    expect(meta.invalidatedVia).toBe('merge_duplicates');
    expect(meta.invalidatedReplacement).toBe(uidKeep);
    expect(typeof meta.invalidatedAt).toBe('string');
  });
});
