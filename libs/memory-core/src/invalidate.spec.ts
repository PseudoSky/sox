/**
 * invalidate.spec.ts — memoryInvalidate's SUPERSEDES edge (BL-247).
 *
 * BL-247: `memoryInvalidate`'s `replacement_uid` → SUPERSEDES edge path had
 * ZERO test coverage (grep for `replacement_uid` across every *.spec.ts /
 * *.test.ts in libs/ and extensions/ returned no hits before this file), and
 * a mistyped/nonexistent/already-invalidated `replacement_uid` silently
 * no-op'd: the claim was invalidated, `ok:true` was returned, and the
 * caller-requested SUPERSEDES edge was simply never written. This spec:
 *   1. Proves the happy-path SUPERSEDES edge actually gets written
 *      (src = replacement.rowid, dst = claim.rowid, rel = 'SUPERSEDES').
 *   2. Proves a nonexistent `replacement_uid` now raises E_REPLACEMENT_NOT_FOUND
 *      instead of silently succeeding — and that the claim is NOT invalidated
 *      either (all-or-nothing).
 *   3. Proves an already-invalidated `replacement_uid` is treated identically
 *      (it is no longer a LIVE node, same as nonexistent).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { memoryInvalidate } from './write.js';

/**
 * BL-325: openDb() returns a StoreAdapter, not a raw better-sqlite3 handle.
 * These specs' own verification reads use raw SQL against the sqlite backend,
 * so unwrap once here rather than rewriting every assertion.
 */
function raw(a: StoreAdapter): Database.Database {
  return a.unwrap() as Database.Database;
}

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meminvalidate-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('memoryInvalidate — SUPERSEDES edge (BL-247)', () => {
  let cleanupDb: () => void;
  let db: StoreAdapter;

  beforeEach(async () => {
    const { dir, cleanup } = tmpDir();
    cleanupDb = cleanup;
    db = await openDb(path.join(dir, 't.db'));
  });

  afterEach(() => {
    if (db && raw(db).open) db.close();
    cleanupDb();
  });

  async function writeEpisode(content: string): Promise<string> {
    const r = await memoryWrite(db, { content, project_path: '/test/project' });
    expect('episode_uid' in r).toBe(true);
    return (r as { episode_uid: string }).episode_uid;
  }

  function rowidFor(uid: string): number {
    const row = raw(db).prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?').get(uid);
    if (!row) throw new Error(`no node for uid ${uid}`);
    return row.rowid;
  }

  it('happy path: replacement_uid produces a SUPERSEDES edge from replacement -> claim', async () => {
    const claimUid = await writeEpisode('Old fact: the sky is green.');
    const replacementUid = await writeEpisode('Corrected fact: the sky is blue.');

    const result = memoryInvalidate(db, {
      claim_uid: claimUid,
      reason: 'corrected',
      replacement_uid: replacementUid,
    });

    expect('ok' in result && result.ok).toBe(true);
    const ok = await result as { ok: true; supersedes_edge_uid?: string };
    expect(ok.supersedes_edge_uid).toBeDefined();

    const claimRowid = rowidFor(claimUid);
    const replacementRowid = rowidFor(replacementUid);

    const edge = raw(db)
      .prepare<[number, number], { rel: string; src: number; dst: number }>(
        `SELECT rel, src, dst FROM edge WHERE rel = 'SUPERSEDES' AND src = ? AND dst = ?`,
      )
      .get(replacementRowid, claimRowid);

    expect(edge).toBeDefined();
    expect(edge!.rel).toBe('SUPERSEDES');
    expect(edge!.src).toBe(replacementRowid);
    expect(edge!.dst).toBe(claimRowid);

    // Claim itself is invalidated (bi-temporal, never deleted — R5).
    const claimRow = raw(db)
      .prepare<[string], { t_invalid: string | null }>('SELECT t_invalid FROM node WHERE uid = ?')
      .get(claimUid)!;
    expect(claimRow.t_invalid).not.toBeNull();
  });

  it('BL-247: a nonexistent replacement_uid raises E_REPLACEMENT_NOT_FOUND and does NOT invalidate the claim', async () => {
    const claimUid = await writeEpisode('Claim that should survive a bad replacement_uid.');

    const result = memoryInvalidate(db, {
      claim_uid: claimUid,
      reason: 'attempted supersession with bogus uid',
      replacement_uid: 'this-uid-does-not-exist-01ARZ3',
    });

    expect('code' in result).toBe(true);
    expect((await result as { code: string }).code).toBe('E_REPLACEMENT_NOT_FOUND');

    // Behaviour change from the pre-fix no-op: the claim must NOT be
    // invalidated either — the whole call fails atomically rather than
    // silently invalidating the claim while dropping the requested edge.
    const claimRow = raw(db)
      .prepare<[string], { t_invalid: string | null }>('SELECT t_invalid FROM node WHERE uid = ?')
      .get(claimUid)!;
    expect(claimRow.t_invalid).toBeNull();

    // No SUPERSEDES edge of any kind was written.
    const edgeCount = raw(db)
      .prepare<[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM edge WHERE rel = 'SUPERSEDES'`)
      .get()!;
    expect(edgeCount.cnt).toBe(0);
  });

  it('BL-247: an already-invalidated replacement_uid raises E_REPLACEMENT_NOT_FOUND and does NOT invalidate the claim', async () => {
    const claimUid = await writeEpisode('Claim that should survive a dead replacement_uid.');
    const deadReplacementUid = await writeEpisode('This node will be invalidated before use as a replacement.');

    // Invalidate the would-be replacement first, with no replacement of its own.
    const preInvalidate = memoryInvalidate(db, {
      claim_uid: deadReplacementUid,
      reason: 'pre-invalidated for BL-247 test setup',
    });
    expect('ok' in preInvalidate && preInvalidate.ok).toBe(true);

    const result = memoryInvalidate(db, {
      claim_uid: claimUid,
      reason: 'attempted supersession with an already-dead uid',
      replacement_uid: deadReplacementUid,
    });

    expect('code' in result).toBe(true);
    expect((await result as { code: string }).code).toBe('E_REPLACEMENT_NOT_FOUND');

    const claimRow = raw(db)
      .prepare<[string], { t_invalid: string | null }>('SELECT t_invalid FROM node WHERE uid = ?')
      .get(claimUid)!;
    expect(claimRow.t_invalid).toBeNull();

    const edgeCount = raw(db)
      .prepare<[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM edge WHERE rel = 'SUPERSEDES'`)
      .get()!;
    expect(edgeCount.cnt).toBe(0);
  });

  it('negative control: claim_uid not found returns E_NOT_FOUND (pre-existing behaviour, unchanged)', async () => {
    const result = memoryInvalidate(db, {
      claim_uid: 'nonexistent-claim-uid',
      reason: 'n/a',
    });
    expect('code' in result).toBe(true);
    expect((await result as { code: string }).code).toBe('E_NOT_FOUND');
  });

  it('invalidate without replacement_uid still succeeds with no SUPERSEDES edge (unchanged happy path)', async () => {
    const claimUid = await writeEpisode('Standalone claim, no supersession.');
    const result = memoryInvalidate(db, { claim_uid: claimUid, reason: 'no longer needed' });
    expect('ok' in result && result.ok).toBe(true);
    const ok = await result as { ok: true; supersedes_edge_uid?: string };
    expect(ok.supersedes_edge_uid).toBeUndefined();

    const claimRow = raw(db)
      .prepare<[string], { t_invalid: string | null }>('SELECT t_invalid FROM node WHERE uid = ?')
      .get(claimUid)!;
    expect(claimRow.t_invalid).not.toBeNull();
  });
});
