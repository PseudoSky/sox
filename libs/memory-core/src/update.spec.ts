/**
 * update.spec.ts — memoryUpdate end-to-end tests.
 *
 * Covers:
 *   - uid-not-found → E_NOT_FOUND
 *   - each replaceable field actually updates in DB
 *   - t_created is immutable; t_updated is set on every successful update
 *   - deep-merge: nested object merged, array replaced
 *   - metadata_merge:'replace' overwrites meta wholesale
 *   - content update re-embeds (vec_node vector changes) while metadata-only does NOT
 *   - FTS reflects content change (fts_node_au trigger fires on node UPDATE)
 *   - no-op (all values identical) → E_NO_FIELDS
 *
 * All operations are deterministic via the _setEmbedProviderForTest() DI hook — no ONNX, no LLM.
 * (This comment previously claimed SOX_EMBED_BACKEND=hash. There is no hash backend:
 *  EmbedBackend = 'auto' | 'real', libs/memory-core/src/embed.ts:43. [BL-250])
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { memoryUpdate, memoryUpdatePhaseA, deepMerge } from './update.js';
import { _shutdownEmbedWorker } from './embed.js';

/**
 * BL-325: openDb() returns a StoreAdapter, not a raw better-sqlite3 handle.
 * These specs' own verification reads use raw SQL against the sqlite backend,
 * so unwrap once here rather than rewriting every assertion.
 */
function raw(a: StoreAdapter): Database.Database {
  return a.unwrap() as Database.Database;
}


// ── Test DB helpers ───────────────────────────────────────────────────────────

async function tmpDb(): Promise<{ db: StoreAdapter; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memupdate-'));
  const db = await openDb(path.join(dir, 'test.db'));
  return { db, dir };
}

function cleanup(db: StoreAdapter, dir: string): void {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

afterAll(async () => {
  await _shutdownEmbedWorker();
});

// ── Helper to fetch the raw vec_node embedding as a hex string ───────────────
// We convert to hex so we can use .toBe() for stable identity comparison.
// Buffer references from virtual tables are new instances on each read but
// have identical bytes — we need content equality, not reference equality.

function getVecHex(db: StoreAdapter, rowid: number): string | null {
  const row = raw(db)
    .prepare<[number], { embedding: Buffer | null }>(
      `SELECT embedding FROM vec_node WHERE node_id = CAST(? AS INTEGER)`,
    )
    .get(rowid);
  if (!row?.embedding) return null;
  return Buffer.from(row.embedding).toString('hex');
}

// ── Helper to read the full node row ─────────────────────────────────────────

interface NodeRow {
  rowid: number;
  uid: string;
  content: string | null;
  summary: string | null;
  name: string | null;
  topic: string | null;
  tags: string | null;
  importance: number;
  meta: string | null;
  t_created: string;
  t_updated: string | null;
  t_occurred: string | null;
  t_valid: string | null;
  project_path: string | null;
}

function getNode(db: StoreAdapter, uid: string): NodeRow | undefined {
  return raw(db)
    .prepare<[string], NodeRow>(
      `SELECT rowid, uid, content, summary, name, topic, tags, importance, meta,
              t_created, t_updated, t_occurred, t_valid, project_path
       FROM node WHERE uid = ?`,
    )
    .get(uid);
}

// ── deepMerge unit tests ─────────────────────────────────────────────────────

describe('deepMerge helper', () => {
  it('merges nested objects recursively', () => {
    const result = deepMerge(
      { a: { x: 1, y: 2 }, b: 'hello' },
      { a: { y: 99, z: 3 } },
    );
    expect(result).toEqual({ a: { x: 1, y: 99, z: 3 }, b: 'hello' });
  });

  it('replaces arrays (not concatenates)', () => {
    const result = deepMerge(
      { list: [1, 2, 3] },
      { list: [4, 5] },
    );
    expect(result).toEqual({ list: [4, 5] });
  });

  it('adds new top-level keys', () => {
    const result = deepMerge({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('source scalar overwrites target scalar', () => {
    const result = deepMerge({ x: 'old' }, { x: 'new' });
    expect(result).toEqual({ x: 'new' });
  });

  it('null in source replaces object in target', () => {
    const result = deepMerge({ a: { nested: true } }, { a: null });
    expect(result).toEqual({ a: null });
  });

  it('does not mutate either argument', () => {
    const target = { a: { x: 1 } };
    const source = { a: { y: 2 } };
    deepMerge(target, source);
    expect(target).toEqual({ a: { x: 1 } });
    expect(source).toEqual({ a: { y: 2 } });
  });
});

// ── E_NOT_FOUND ───────────────────────────────────────────────────────────────

describe('memoryUpdate — E_NOT_FOUND', () => {
  it('returns E_NOT_FOUND for an unknown uid', async () => {
    const { db, dir } = tmpDb();
    try {
      const result = await memoryUpdate(db, {
        uid: '01JXNONEXISTENT',
        content: 'new content',
      });
      expect(result).toMatchObject({ code: 'E_NOT_FOUND' });
    } finally {
      cleanup(db, dir);
    }
  });

  it('returns E_NOT_FOUND for an invalidated node', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'will be invalidated', project_path: '/test/project' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      raw(db).prepare(`UPDATE node SET t_invalid = ? WHERE uid = ?`).run(
        new Date().toISOString(),
        uid,
      );
      const result = await memoryUpdate(db, { uid, content: 'should fail' });
      expect(result).toMatchObject({ code: 'E_NOT_FOUND' });
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── E_NO_FIELDS ──────────────────────────────────────────────────────────────

describe('memoryUpdate — E_NO_FIELDS', () => {
  it('returns E_NO_FIELDS when no updatable params supplied', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'initial content', project_path: '/test/project' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const result = await memoryUpdate(db, { uid });
      expect(result).toMatchObject({ code: 'E_NO_FIELDS' });
    } finally {
      cleanup(db, dir);
    }
  });

  it('returns E_NO_FIELDS when supplied value is identical to existing', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, {
        content: 'same content',
        importance: 5,
        project_path: '/test/project',
      });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const result = await memoryUpdate(db, { uid, content: 'same content' });
      expect(result).toMatchObject({ code: 'E_NO_FIELDS' });
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── Field update tests ────────────────────────────────────────────────────────

describe('memoryUpdate — individual field updates', () => {
  it('updates content and reports reembedded:true', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'original content', project_path: '/test/project' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const nodeBefore = getNode(db, uid)!;

      const result = await memoryUpdate(db, { uid, content: 'updated content' });
      expect('uid' in result).toBe(true);
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.uid).toBe(uid);
      expect(ok.updated_fields).toContain('content');
      expect(ok.reembedded).toBe(true);

      const nodeAfter = getNode(db, uid)!;
      expect(nodeAfter.content).toBe('updated content');

      // t_created is immutable
      expect(nodeAfter.t_created).toBe(nodeBefore.t_created);
      // t_updated is set
      expect(nodeAfter.t_updated).not.toBeNull();
    } finally {
      cleanup(db, dir);
    }
  });

  it('updates summary and reports reembedded:true', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'content', summary: 'old summary', project_path: '/test/project' });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const result = await memoryUpdate(db, { uid, summary: 'new summary' });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('summary');
      expect(ok.reembedded).toBe(true);

      const node = getNode(db, uid)!;
      expect(node.summary).toBe('new summary');
    } finally {
      cleanup(db, dir);
    }
  });

  it('updates name', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'episode content', name: 'old name', project_path: '/test/project' });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const result = await memoryUpdate(db, { uid, name: 'new name' });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('name');
      expect(ok.reembedded).toBe(false);

      const node = getNode(db, uid)!;
      expect(node.name).toBe('new name');
    } finally {
      cleanup(db, dir);
    }
  });

  it('updates topic', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'content about TS', topic: 'typescript', project_path: '/test/project' });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const result = await memoryUpdate(db, { uid, topic: 'javascript' });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('topic');
      expect(ok.reembedded).toBe(false);

      const node = getNode(db, uid)!;
      expect(node.topic).toBe('javascript');
    } finally {
      cleanup(db, dir);
    }
  });

  it('BL-221: updates project_path in place without triggering re-embed', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, {
        content: 'a note written under the wrong project',
        project_path: '/Users/nix/dev/ai/agent-source',
      });
      const uid = (wr as { episode_uid: string }).episode_uid;
      expect(getNode(db, uid)!.project_path).toBe('/Users/nix/dev/ai/agent-source');

      const result = await memoryUpdate(db, {
        uid,
        project_path: '/Users/nix/Documents/professional/qusececure',
      });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('project_path');
      expect(ok.reembedded).toBe(false);

      const node = getNode(db, uid)!;
      expect(node.project_path).toBe('/Users/nix/Documents/professional/qusececure');
    } finally {
      cleanup(db, dir);
    }
  });

  it('updates tags', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'tag test', tags: ['a', 'b'], project_path: '/test/project' });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const result = await memoryUpdate(db, { uid, tags: ['c', 'd', 'e'] });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('tags');
      expect(ok.reembedded).toBe(false);

      const node = getNode(db, uid)!;
      expect(JSON.parse(node.tags!)).toEqual(['c', 'd', 'e']);
    } finally {
      cleanup(db, dir);
    }
  });

  it('updates importance', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'importance test', importance: 2, project_path: '/test/project' });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const result = await memoryUpdate(db, { uid, importance: 8 });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('importance');
      expect(ok.reembedded).toBe(false);

      const node = getNode(db, uid)!;
      expect(node.importance).toBe(8);
    } finally {
      cleanup(db, dir);
    }
  });

  it('updates t_occurred and t_valid', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'temporal test', project_path: '/test/project' });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const newOccurred = '2024-01-01T00:00:00.000Z';
      const newValid = '2024-06-01T00:00:00.000Z';
      const result = await memoryUpdate(db, {
        uid,
        t_occurred: newOccurred,
        t_valid: newValid,
      });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('t_occurred');
      expect(ok.updated_fields).toContain('t_valid');
      expect(ok.reembedded).toBe(false);

      const node = getNode(db, uid)!;
      expect(node.t_occurred).toBe(newOccurred);
      expect(node.t_valid).toBe(newValid);
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── BL-221: mis-attributed episodes are now correctable in place ────────────────
//
// BACKLOG.md BL-221 ("mis-attributed episodes are UNCORRECTABLE in place"): a BL-62
// mis-attribution (project_path resolved from the server's env/cwd fallback instead
// of the caller's real project) previously could NOT be repaired, because (1)
// `memory_update` did not have `project_path` in its editable field set, and (2)
// re-writing the identical content with the corrected `project_path` is rejected by
// `E_DEDUP` — the content_hash dedup key (write.ts) is computed over content only and
// ignores project_path, so `memoryWrite` returns the ORIGINAL (wrongly-attributed)
// uid instead of creating a corrected row. This block proves the full end-to-end
// repair path end-to-end: E_DEDUP still fires on re-write (unchanged, by design —
// see the write.ts HARD GATE note: the dedup key itself is intentionally NOT
// touched), but `memory_update` now edits `project_path` directly, which is the
// documented option (a) remediation.
describe('memoryUpdate — BL-221: project_path is correctable in place', () => {
  it('BL-221 (red→green): a mis-attributed episode is uncorrectable via re-write (E_DEDUP) but IS correctable via memory_update', async () => {
    const { db, dir } = tmpDb();
    try {
      // 1. Simulate the BL-62 failure mode: an episode is written with a WRONG
      //    project_path (e.g. the shared backend's frozen shim-spawn cwd, not the
      //    caller's real working directory).
      const wrongProjectPath = '/Users/nix/dev/ai/agent-source';
      const correctProjectPath = '/Users/nix/Documents/professional/qusececure';
      const content = 'BL-221 repro: a fact recorded while misattributed.';
      const wr = await memoryWrite(db, { content, project_path: wrongProjectPath });
      expect('episode_uid' in wr).toBe(true);
      const uid = (wr as { episode_uid: string }).episode_uid;
      expect(getNode(db, uid)!.project_path).toBe(wrongProjectPath);

      // 2. Confirm the compounding sub-finding still holds (by design, NOT touched
      //    by this fix — the dedup key is intentionally content-only, per the
      //    BL-221 HARD GATE): re-writing identical content under the CORRECT
      //    project_path is rejected as a duplicate, returning the WRONG uid's
      //    content instead of creating a corrected row.
      const rewrite = await memoryWrite(db, { content, project_path: correctProjectPath });
      expect('code' in rewrite && rewrite.code).toBe('E_DEDUP');
      expect((rewrite as { existing_uid: string }).existing_uid).toBe(uid);
      // The dedup-rejected rewrite must NOT have mutated project_path as a side effect.
      expect(getNode(db, uid)!.project_path).toBe(wrongProjectPath);

      // 3. GREEN: memory_update (option (a), BL-221) repairs the SAME row in place.
      const result = await memoryUpdate(db, { uid, project_path: correctProjectPath });
      const ok = result as import('./update.js').UpdateResult;
      expect('code' in result).toBe(false);
      expect(ok.updated_fields).toEqual(['project_path']);
      expect(ok.reembedded).toBe(false); // project_path is not part of the embed text

      const node = getNode(db, uid)!;
      expect(node.project_path).toBe(correctProjectPath);
      expect(node.content).toBe(content); // content untouched — uid/content identity preserved
    } finally {
      cleanup(db, dir);
    }
  });

  it('BL-221: memoryUpdatePhaseA reports E_NO_FIELDS when project_path is resupplied unchanged (no false positive)', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, {
        content: 'BL-221 no-op guard',
        project_path: '/Users/nix/dev/ai/sox-ecosystem',
      });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const result = memoryUpdatePhaseA(db, {
        uid,
        project_path: '/Users/nix/dev/ai/sox-ecosystem',
      });
      expect('code' in result && result.code).toBe('E_NO_FIELDS');
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── t_created immutability + t_updated audit ─────────────────────────────────

describe('memoryUpdate — t_created immutable, t_updated set', () => {
  it('never changes t_created; always sets t_updated', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'time anchor test', project_path: '/test/project' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const nodeBefore = getNode(db, uid)!;
      // t_updated is now set by enrichOnWrite → graph.touch() so it's no longer null
      expect(nodeBefore.t_updated).toEqual(expect.any(String));

      const before = Date.now();
      const result = await memoryUpdate(db, { uid, importance: 7 });
      expect('uid' in result).toBe(true);
      const after = Date.now();

      const nodeAfter = getNode(db, uid)!;
      // t_created must not change
      expect(nodeAfter.t_created).toBe(nodeBefore.t_created);
      // t_updated must be set and within the call window
      expect(nodeAfter.t_updated).not.toBeNull();
      const updatedMs = new Date(nodeAfter.t_updated!).getTime();
      expect(updatedMs).toBeGreaterThanOrEqual(before);
      expect(updatedMs).toBeLessThanOrEqual(after + 50); // small tolerance
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── metadata deep-merge vs replace ───────────────────────────────────────────

describe('memoryUpdate — metadata merging', () => {
  it('deep-merges by default: nested objects merged, arrays replaced', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, {
        content: 'meta merge test',
        metadata: { a: { x: 1 }, list: [1, 2, 3], stable: 'keep' },
        project_path: '/test/project',
      });
      const uid = (wr as { episode_uid: string }).episode_uid;

      // Verify initial meta
      const nodeBefore = getNode(db, uid)!;
      const metaBefore = JSON.parse(nodeBefore.meta!) as Record<string, unknown>;
      expect(metaBefore).toMatchObject({ a: { x: 1 }, list: [1, 2, 3], stable: 'keep' });

      const result = await memoryUpdate(db, {
        uid,
        metadata: { a: { y: 2 }, list: [4, 5] },
        // metadata_merge defaults to 'deep'
      });
      expect('uid' in result).toBe(true);
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('meta');
      expect(ok.reembedded).toBe(false);

      const nodeAfter = getNode(db, uid)!;
      const metaAfter = JSON.parse(nodeAfter.meta!) as Record<string, unknown>;

      // Nested object merged: a.x preserved, a.y added
      expect(metaAfter['a']).toEqual({ x: 1, y: 2 });
      // Array replaced (not concatenated)
      expect(metaAfter['list']).toEqual([4, 5]);
      // Untouched key preserved
      expect(metaAfter['stable']).toBe('keep');
    } finally {
      cleanup(db, dir);
    }
  });

  it("metadata_merge:'replace' overwrites meta wholesale", async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, {
        content: 'meta replace test',
        metadata: { old_key: 'will be gone', nested: { deep: true } },
        project_path: '/test/project',
      });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const result = await memoryUpdate(db, {
        uid,
        metadata: { brand_new: 42 },
        metadata_merge: 'replace',
      });
      expect('uid' in result).toBe(true);

      const nodeAfter = getNode(db, uid)!;
      const metaAfter = JSON.parse(nodeAfter.meta!) as Record<string, unknown>;
      expect(metaAfter).toEqual({ brand_new: 42 });
      expect('old_key' in metaAfter).toBe(false);
      expect('nested' in metaAfter).toBe(false);
    } finally {
      cleanup(db, dir);
    }
  });

  it('metadata-only update does NOT re-embed', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'embed stability test', project_path: '/test/project' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const nodeBefore = getNode(db, uid)!;
      const vecBefore = getVecHex(db, nodeBefore.rowid);
      expect(vecBefore).not.toBeNull();

      const result = await memoryUpdate(db, {
        uid,
        metadata: { tag: 'added' },
      });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.reembedded).toBe(false);

      const vecAfter = getVecHex(db, nodeBefore.rowid);
      // Vector must be unchanged (same blob) for a metadata-only update.
      expect(vecAfter).toBe(vecBefore);
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── Re-embed proof ────────────────────────────────────────────────────────────

describe('memoryUpdate — re-embed on content change', () => {
  it('vec_node vector changes when content updates', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'first version of the content', project_path: '/test/project' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const nodeBefore = getNode(db, uid)!;
      const vecBefore = getVecHex(db, nodeBefore.rowid);
      expect(vecBefore).not.toBeNull();

      // Update with a distinctly different content string (hash backend produces
      // content-dependent embeddings, so different text → different vector).
      const result = await memoryUpdate(db, {
        uid,
        content: 'completely different second version with new words',
      });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.reembedded).toBe(true);
      expect(ok.updated_fields).toContain('content');

      const vecAfter = getVecHex(db, nodeBefore.rowid);
      // The blob must have changed (different content → different hash embedding).
      expect(vecAfter).not.toBeNull();
      expect(vecAfter).not.toBe(vecBefore);
    } finally {
      cleanup(db, dir);
    }
  });

  it('vec_node vector unchanged for a non-content/summary update', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'stable content for vector test', project_path: '/test/project' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const nodeBefore = getNode(db, uid)!;
      const vecBefore = getVecHex(db, nodeBefore.rowid);

      await memoryUpdate(db, { uid, topic: 'new-topic' });

      const vecAfter = getVecHex(db, nodeBefore.rowid);
      // Vector must be identical for a topic-only update.
      expect(vecAfter).toBe(vecBefore);
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── FTS sync via trigger ──────────────────────────────────────────────────────

describe('memoryUpdate — FTS reflects content change (fts_node_au trigger)', () => {
  /**
   * The fts_node_au trigger fires AFTER UPDATE ON node and re-indexes all three
   * FTS columns: content, name, summary. When only content changes, FTS still
   * re-indexes the current summary value — so a term that appears in BOTH content
   * AND summary will remain indexed if only the content column is updated.
   *
   * This test uses a unique term that appears ONLY in content (not summary) and
   * verifies the trigger correctly removes it from the FTS index after a content
   * update, then adds the new content's unique term.
   *
   * To guarantee the unique term is never in summary, we write a node with an
   * explicit summary that uses different vocabulary.
   */
  it('fts_node indexes new content terms and removes old content-only terms', async () => {
    const { db, dir } = tmpDb();
    try {
      // Write with an explicit summary that does NOT contain the unique content term.
      const wr = await memoryWrite(db, {
        content: 'the quick zorbflux ran over the lazy dog',
        summary: 'canine speed test',   // no 'zorbflux' here
        project_path: '/test/project',
      });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const nodeRow = await raw(db)
        .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ?`)
        .get(uid)!;

      // 'zorbflux' should be indexed before the update.
      const ftsBeforeRows = raw(db)
        .prepare<[string], { rowid: number }>(
          `SELECT rowid FROM fts_node WHERE fts_node MATCH ?`,
        )
        .all('zorbflux');
      expect(ftsBeforeRows.map((r) => r.rowid)).toContain(nodeRow.rowid);

      // Update content + summary together — replace the unique term with a new one.
      await memoryUpdate(db, {
        uid,
        content: 'a completely different quaxbeam story',
        summary: 'quaxbeam narrative',
      });

      // 'quaxbeam' should now be indexed.
      const ftsAfterRows = raw(db)
        .prepare<[string], { rowid: number }>(
          `SELECT rowid FROM fts_node WHERE fts_node MATCH ?`,
        )
        .all('quaxbeam');
      expect(ftsAfterRows.map((r) => r.rowid)).toContain(nodeRow.rowid);

      // 'zorbflux' should no longer be indexed for this episode — it appeared only in
      // content (and summary), both of which were updated to remove it.
      const ftsRemovedRows = raw(db)
        .prepare<[string], { rowid: number }>(
          `SELECT rowid FROM fts_node WHERE fts_node MATCH ?`,
        )
        .all('zorbflux');
      expect(ftsRemovedRows.map((r) => r.rowid)).not.toContain(nodeRow.rowid);
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── BL-189: two-phase update — Phase A holds the slot, embed is deferred ──────

describe('memoryUpdatePhaseA — two-phase update (BL-189)', () => {
  it('content change: commits columns, DELETES the stale vector, returns a PendingEmbed', async () => {
    const { db, dir } = tmpDb();
    try {
      const w = await memoryWrite(db, { content: 'original text for phase-a', project_path: '/test/project' });
      const uid = (w as { episode_uid: string }).episode_uid;
      const rowid = (raw(db).prepare('SELECT rowid FROM node WHERE uid = ?').get(uid) as { rowid: number }).rowid;
      expect(getVecHex(db, rowid)).not.toBeNull(); // sync composition embedded it

      const a = await memoryUpdatePhaseA(db, { uid, content: 'replaced text for phase-a' });
      expect('code' in a).toBe(false);
      if ('code' in a) return;

      // Columns committed, FTS-visible, stale vector GONE (heal-eligible).
      const row = raw(db).prepare('SELECT content FROM node WHERE uid = ?').get(uid) as { content: string };
      expect(row.content).toBe('replaced text for phase-a');
      expect(getVecHex(db, rowid)).toBeNull();

      // Pending carries the exact identity + text Phase B must apply.
      expect(a.pending).not.toBeNull();
      expect(a.pending!.uid).toBe(uid);
      expect(a.pending!.rowid).toBe(rowid);
      expect(a.pending!.text).toBe('replaced text for phase-a');
      expect(typeof a.pending!.startedAtMs).toBe('number');
      expect(a.result.reembedded).toBe(true);

      // Phase B (applyEmbedding via the sync composition path) restores the vector.
      const done = await memoryUpdate(db, { uid, content: 'replaced text for phase-a v2' });
      expect('code' in done).toBe(false);
      expect(getVecHex(db, rowid)).not.toBeNull();
    } finally {
      cleanup(db, dir);
    }
  });

  it('metadata-only change: no pending, vector untouched', async () => {
    const { db, dir } = tmpDb();
    try {
      const w = await memoryWrite(db, { content: 'stable text', project_path: '/test/project' });
      const uid = (w as { episode_uid: string }).episode_uid;
      const rowid = (raw(db).prepare('SELECT rowid FROM node WHERE uid = ?').get(uid) as { rowid: number }).rowid;
      const before = getVecHex(db, rowid);

      const a = await memoryUpdatePhaseA(db, { uid, metadata: { reviewed: true } });
      expect('code' in a).toBe(false);
      if ('code' in a) return;
      expect(a.pending).toBeNull();
      expect(a.result.reembedded).toBe(false);
      expect(getVecHex(db, rowid)).toBe(before);
    } finally {
      cleanup(db, dir);
    }
  });

  it('summary-only change: pending text is the EXISTING content (pre-BL-189 semantics preserved)', async () => {
    const { db, dir } = tmpDb();
    try {
      const w = await memoryWrite(db, { content: 'content stays', summary: 'old summary', project_path: '/test/project' });
      const uid = (w as { episode_uid: string }).episode_uid;

      const a = await memoryUpdatePhaseA(db, { uid, summary: 'new summary' });
      expect('code' in a).toBe(false);
      if ('code' in a) return;
      expect(a.pending).not.toBeNull();
      expect(a.pending!.text).toBe('content stays');
    } finally {
      cleanup(db, dir);
    }
  });
});
