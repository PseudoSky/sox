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

  afterEach(async () => {
    if (db && raw(db).open) await db.close();
    cleanupDb();
  });

  async function writeEpisode(content: string): Promise<string> {
    const r = await memoryWrite(db, { content, project_path: '/test/project' });
    expect('episode_uid' in r).toBe(true);
    return (r as { episode_uid: string }).episode_uid;
  }

  async function rowidFor(uid: string): Promise<number> {
    const row = await db.executeGet<{ rowid: number }>('SELECT rowid FROM node WHERE uid = ?', [uid]);
    if (!row) throw new Error(`no node for uid ${uid}`);
    return row.rowid;
  }

  it('happy path: replacement_uid produces a SUPERSEDES edge from replacement -> claim', async () => {
    const claimUid = await writeEpisode('Old fact: the sky is green.');
    const replacementUid = await writeEpisode('Corrected fact: the sky is blue.');

    const result = await memoryInvalidate(db, {
      claim_uid: claimUid,
      reason: 'corrected',
      replacement_uid: replacementUid,
    });

    expect('ok' in result && result.ok).toBe(true);
    const ok = result as { ok: true; supersedes_edge_uid?: string };
    expect(ok.supersedes_edge_uid).toBeDefined();

    const claimRowid = await rowidFor(claimUid);
    const replacementRowid = await rowidFor(replacementUid);

    const edge = await db.executeGet<{ rel: string; src: number; dst: number }>(`SELECT rel, src, dst FROM edge WHERE rel = 'SUPERSEDES' AND src = ? AND dst = ?`, [replacementRowid, claimRowid]);

    expect(edge).toBeDefined();
    expect(edge!.rel).toBe('SUPERSEDES');
    expect(edge!.src).toBe(replacementRowid);
    expect(edge!.dst).toBe(claimRowid);

    // Claim itself is invalidated (bi-temporal, never deleted — R5).
    const claimRow = (await db.executeGet<{ t_invalid: string | null }>('SELECT t_invalid FROM node WHERE uid = ?', [claimUid]))!;
    expect(claimRow.t_invalid).not.toBeNull();
  });

  it('BL-247: a nonexistent replacement_uid raises E_REPLACEMENT_NOT_FOUND and does NOT invalidate the claim', async () => {
    const claimUid = await writeEpisode('Claim that should survive a bad replacement_uid.');

    const result = await memoryInvalidate(db, {
      claim_uid: claimUid,
      reason: 'attempted supersession with bogus uid',
      replacement_uid: 'this-uid-does-not-exist-01ARZ3',
    });

    expect('code' in result).toBe(true);
    expect((result as { code: string }).code).toBe('E_REPLACEMENT_NOT_FOUND');

    // Behaviour change from the pre-fix no-op: the claim must NOT be
    // invalidated either — the whole call fails atomically rather than
    // silently invalidating the claim while dropping the requested edge.
    const claimRow = (await db.executeGet<{ t_invalid: string | null }>('SELECT t_invalid FROM node WHERE uid = ?', [claimUid]))!;
    expect(claimRow.t_invalid).toBeNull();

    // No SUPERSEDES edge of any kind was written.
    const edgeCount = (await db.executeGet<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM edge WHERE rel = 'SUPERSEDES'`))!;
    expect(edgeCount.cnt).toBe(0);
  });

  it('BL-247: an already-invalidated replacement_uid raises E_REPLACEMENT_NOT_FOUND and does NOT invalidate the claim', async () => {
    const claimUid = await writeEpisode('Claim that should survive a dead replacement_uid.');
    const deadReplacementUid = await writeEpisode('This node will be invalidated before use as a replacement.');

    // Invalidate the would-be replacement first, with no replacement of its own.
    const preInvalidate = await memoryInvalidate(db, {
      claim_uid: deadReplacementUid,
      reason: 'pre-invalidated for BL-247 test setup',
    });
    expect('ok' in preInvalidate && preInvalidate.ok).toBe(true);

    const result = await memoryInvalidate(db, {
      claim_uid: claimUid,
      reason: 'attempted supersession with an already-dead uid',
      replacement_uid: deadReplacementUid,
    });

    expect('code' in result).toBe(true);
    expect((result as { code: string }).code).toBe('E_REPLACEMENT_NOT_FOUND');

    const claimRow = (await db.executeGet<{ t_invalid: string | null }>('SELECT t_invalid FROM node WHERE uid = ?', [claimUid]))!;
    expect(claimRow.t_invalid).toBeNull();

    const edgeCount = (await db.executeGet<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM edge WHERE rel = 'SUPERSEDES'`))!;
    expect(edgeCount.cnt).toBe(0);
  });

  it('negative control: claim_uid not found returns E_NOT_FOUND (pre-existing behaviour, unchanged)', async () => {
    const result = await memoryInvalidate(db, {
      claim_uid: 'nonexistent-claim-uid',
      reason: 'n/a',
    });
    expect('code' in result).toBe(true);
    expect((result as { code: string }).code).toBe('E_NOT_FOUND');
  });

  it('invalidate without replacement_uid still succeeds with no SUPERSEDES edge (unchanged happy path)', async () => {
    const claimUid = await writeEpisode('Standalone claim, no supersession.');
    const result = await memoryInvalidate(db, { claim_uid: claimUid, reason: 'no longer needed' });
    expect('ok' in result && result.ok).toBe(true);
    const ok = result as { ok: true; supersedes_edge_uid?: string };
    expect(ok.supersedes_edge_uid).toBeUndefined();

    const claimRow = (await db.executeGet<{ t_invalid: string | null }>('SELECT t_invalid FROM node WHERE uid = ?', [claimUid]))!;
    expect(claimRow.t_invalid).not.toBeNull();
  });
});

describe('memoryInvalidate — not-found / already-invalid / wrong-kind (BUG-MEMORY-002)', () => {
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

  it('BUG-MEMORY-002 (a): non-existent uid returns E_NOT_FOUND with the corrected message text', async () => {
    const result = await memoryInvalidate(db, { claim_uid: 'nonexistent-claim-uid', reason: 'n/a' });
    expect('code' in result).toBe(true);
    const err = result as { code: string; message: string };
    expect(err.code).toBe('E_NOT_FOUND');
    // BUG-MEMORY-002: the old message text ("...or already invalidated") is now
    // a lie — "already invalidated" is no longer a case this branch reaches.
    expect(err.message).toBe('No node found for uid: nonexistent-claim-uid');
    expect(err.message).not.toContain('already invalidated');
  });

  it('BUG-MEMORY-002 (b): invalidating the same claim twice — the second call is idempotent success, not E_NOT_FOUND', async () => {
    const claimUid = await writeEpisode('BUG-MEMORY-002(b): claim invalidated twice.');

    const first = await memoryInvalidate(db, { claim_uid: claimUid, reason: 'first invalidation' });
    expect('ok' in first && first.ok).toBe(true);
    const firstOk = first as { ok: true; already_invalid?: boolean };
    expect(firstOk.already_invalid ?? false).toBe(false);

    const firstRow = (await db.executeGet<{ t_invalid: string }>('SELECT t_invalid FROM node WHERE uid = ?', [claimUid]))!;
    expect(firstRow.t_invalid).not.toBeNull();

    // RED (pre-fix): this second call hit `SELECT rowid FROM node WHERE uid = ?
    // AND t_invalid IS NULL` — zero rows (already invalidated), so it returned
    // the exact same {code:'E_NOT_FOUND'} as a genuinely-nonexistent uid.
    const second = await memoryInvalidate(db, { claim_uid: claimUid, reason: 'second invalidation, same uid' });
    expect('ok' in second).toBe(true);
    const secondOk = second as { ok: true; already_invalid?: boolean; t_invalid?: string };
    expect(secondOk.ok).toBe(true);
    expect(secondOk.already_invalid).toBe(true);
    // The SECOND call must not have touched the row — t_invalid is the
    // ORIGINAL transition time from the first call, not a fresh timestamp.
    expect(secondOk.t_invalid).toBe(firstRow.t_invalid);

    const rowAfterSecond = (await db.executeGet<{ t_invalid: string }>('SELECT t_invalid FROM node WHERE uid = ?', [claimUid]))!;
    expect(rowAfterSecond.t_invalid).toBe(firstRow.t_invalid);
  });

  it('BUG-MEMORY-002 (c): an episode auto-invalidated by the near-dup pipeline before the caller\'s own memory_invalidate call — the literal repro of the dispatch\'s 3/12 probe failures', async () => {
    // memoryWrite() (the top-level convenience wrapper this suite's
    // writeEpisode() calls) ALWAYS finishes its embed synchronously before
    // returning (write.ts:505-526: awaits embed() + applyEmbedding() inline,
    // regardless of SOX_SYNC_EMBED — that env only affects a different
    // composition path) — and applyEmbedding (embed-pipeline.ts:456-487) runs
    // E8 near-dup detection + applyNearDupResult automatically for every
    // still-live node. So writing a near-duplicate SECOND episode auto-
    // invalidates the OLDER one with NO caller action, exactly like the real
    // Phase-B pipeline and the dispatch's observed 3/12 probe failures — no
    // manual vec_node/detectNearDup driving needed (a first attempt at that
    // collided with the vec_node row memoryWrite already inserts).
    const olderUid = await writeEpisode(
      'CONCURRENCY PROBE (disposable, safe to delete). Reproducing a case for BUG-MEMORY-002.',
    );
    const newerUid = await writeEpisode(
      'CONCURRENCY PROBE (disposable, safe to delete). Reproducing a case for BUG-MEMORY-002 v2.',
    );
    expect(newerUid).not.toBe(olderUid);

    // Confirm via direct SQL that the older uid is already invalid BEFORE the
    // caller's own memory_invalidate call ever runs — this is the race.
    const preCheck = (await db.executeGet<{ t_invalid: string | null }>('SELECT t_invalid FROM node WHERE uid = ?', [olderUid]))!;
    expect(preCheck.t_invalid).not.toBeNull();

    // RED (pre-fix): the caller's manual invalidate on the already-invalid
    // uid hit the `t_invalid IS NULL` filter, found zero rows, and returned
    // {code:'E_NOT_FOUND'} — indistinguishable from a uid that never existed.
    const result = await memoryInvalidate(db, { claim_uid: olderUid, reason: 'caller invalidate, lost the race' });
    expect('ok' in result).toBe(true);
    const ok = result as { ok: true; already_invalid?: boolean; t_invalid?: string };
    expect(ok.ok).toBe(true);
    expect(ok.already_invalid).toBe(true);
    expect(ok.t_invalid).toBe(preCheck.t_invalid);
  });

  it('BUG-MEMORY-002 (d): a wrong-kind (community) uid returns E_WRONG_KIND and does NOT mutate the node', async () => {
    const now = new Date().toISOString();
    await db.executeRun(
      `INSERT INTO node (uid, kind, name, level, t_created, t_valid, meta)
       VALUES ('comm-wrong-kind-test', 'community', 'Wrong Kind Test Community', 0, ?, ?, ?)`,
      [now, now, JSON.stringify({ cluster_scope: { kind: 'global' } })],
    );

    const before = (await db.executeGet<{ t_invalid: string | null }>(`SELECT t_invalid FROM node WHERE uid = 'comm-wrong-kind-test'`))!;
    expect(before.t_invalid).toBeNull();

    // RED (pre-fix): the lookup query had no `kind` predicate at all — this
    // call would silently succeed (`ok:true`) and set t_invalid on the
    // community, with zero signal to the caller that they passed the wrong
    // tool's uid.
    const result = await memoryInvalidate(db, { claim_uid: 'comm-wrong-kind-test', reason: 'wrong uid, should be rejected' });
    expect('code' in result).toBe(true);
    const err = result as { code: string; kind?: string };
    expect(err.code).toBe('E_WRONG_KIND');
    expect(err.kind).toBe('community');

    const after = (await db.executeGet<{ t_invalid: string | null }>(`SELECT t_invalid FROM node WHERE uid = 'comm-wrong-kind-test'`))!;
    expect(after.t_invalid).toBeNull();
  });
});

// BUG-CLUSTER-ORPHANED-COMMUNITIES-NEVER-GC-001: invalidating an episode must
// ALSO invalidate its live MEMBER_OF edge and any community left with zero live
// members — otherwise ordinary churn silently decays total_clustered toward 0
// while cluster_count stays fixed (the orphaned-community leak; the live
// 139-communities/0-members signature). A full cluster pass used to be the ONLY
// repair; this makes invalidation self-cleaning at O(1) per episode.
// RED: before the fix, the edge and community stay live (both assertions fail).
// GREEN: after gcOrphanedCommunityState is wired into memoryInvalidate.
describe('memoryInvalidate — orphaned-community GC (BUG-CLUSTER-ORPHANED-COMMUNITIES-NEVER-GC-001)', () => {
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

  it('invalidating a member episode invalidates its MEMBER_OF edge and the now-empty global community', async () => {
    const write = await memoryWrite(db, {
      content: 'Episode that will belong to a community before invalidation.',
      project_path: '/test/project',
    });
    expect('episode_uid' in write).toBe(true);
    const uid = (write as { episode_uid: string }).episode_uid;
    const row = (await db.executeGet<{ rowid: number }>('SELECT rowid FROM node WHERE uid = ?', [uid]))!;
    const now = new Date().toISOString();

    // Seed a global community + MEMBER_OF edge, exactly as a full cluster pass
    // would (cluster_scope.kind = 'global', origin 'inferred'). Reads/writes go
    // through the StoreAdapter (this suite's openDb is the TURSO adapter, whose
    // unwrapped handle renders NULL columns as `undefined` — vacuous for null
    // assertions; the adapter's executeGet returns proper `null`).
    await db.executeRun(
      `INSERT INTO node (uid, kind, name, level, t_created, t_valid, meta)
       VALUES ('comm-gc-test', 'community', 'GC Test Community', 0, ?, ?, ?)`,
      [now, now, JSON.stringify({ cluster_scope: { kind: 'global' } })],
    );
    const comm = (await db.executeGet<{ rowid: number }>(`SELECT rowid FROM node WHERE uid = 'comm-gc-test'`))!;
    await db.executeRun(
      `INSERT INTO edge (src, dst, rel, origin, weight, t_created)
       VALUES (?, ?, 'MEMBER_OF', 'inferred', 1.0, ?)`,
      [row.rowid, comm.rowid, now],
    );

    // Pre-state self-check: the fixture MUST be live before invalidation, or
    // the assertions below prove nothing (a broken fixture would pass vacuously).
    const edgeBefore = await db.executeGet<{ t_invalid: string | null }>(`SELECT t_invalid FROM edge WHERE src = ? AND rel = 'MEMBER_OF'`, [row.rowid]);
    expect(edgeBefore).toBeDefined();
    expect(edgeBefore!.t_invalid).toBeNull();
    const commBefore = await db.executeGet<{ t_invalid: string | null }>(`SELECT t_invalid FROM node WHERE uid = 'comm-gc-test'`);
    expect(commBefore!.t_invalid).toBeNull();

    const result = await memoryInvalidate(db, { claim_uid: uid, reason: 'orphan-GC test' });
    expect('ok' in result && result.ok).toBe(true);

    // 1. The episode's MEMBER_OF edge is invalidated with the same transition.
    const edge = await db.executeGet<{ t_invalid: string | null }>(`SELECT t_invalid FROM edge WHERE src = ? AND rel = 'MEMBER_OF'`, [row.rowid]);
    expect(edge).toBeDefined();
    expect(edge!.t_invalid).not.toBeNull();

    // 2. The now-empty global community is invalidated too — not left orphaned.
    const commAfter = await db.executeGet<{ t_invalid: string | null }>(`SELECT t_invalid FROM node WHERE uid = 'comm-gc-test'`);
    expect(commAfter!.t_invalid).not.toBeNull();
  });
});
