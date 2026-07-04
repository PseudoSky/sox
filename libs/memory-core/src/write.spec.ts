/**
 * write.spec.ts — memoryWrite persistence of client-supplied summary + metadata,
 * and the idempotent `node.meta` column migration (BL-23).
 * P1 enrichment fields: topic, tags, project_path, enrich_ver columns (BL-24 / D3.1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import { memoryWrite, memoryWriteBatch, requestLedgerPrune } from './write.js';
import { WriteQueue } from './write-queue.js';

// Mock embed to avoid real ONNX model download (these tests assert DB persistence, not embedding quality)

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memwrite-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('memoryWrite — summary + metadata (BL-23)', () => {
  it('persists client-supplied summary and metadata', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: 'Bi-temporal edges supersede facts.',
        summary: 'graph supersession',
        metadata: { project_path: '/Users/nix/dev/ai/foo', url: 'x' },
      });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;

      const row = db
        .prepare<[string], { summary: string | null; meta: string | null }>(
          'SELECT summary, meta FROM node WHERE uid = ?',
        )
        .get(uid)!;

      expect(row.summary).toBe('graph supersession');
      expect(JSON.parse(row.meta!)).toEqual({ project_path: '/Users/nix/dev/ai/foo', url: 'x' });
      db.close();
    } finally {
      cleanup();
    }
  });

  it('leaves meta null when not supplied; summary is set by extractive fallback (no regression)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      // P2: enrichOnWrite runs extractiveSummary when no caller summary is supplied.
      // Content < 100 chars → extractiveSummary returns it as-is (still non-null).
      const r = await memoryWrite(db, { content: 'Plain content, no extras.' });
      const uid = (r as { episode_uid: string }).episode_uid;
      const row = db
        .prepare<[string], { summary: string | null; meta: string | null }>(
          'SELECT summary, meta FROM node WHERE uid = ?',
        )
        .get(uid)!;
      // P2 extractive summary fills this field (content < 100 chars → returns content as-is)
      expect(row.summary).not.toBeNull();
      expect(row.meta).toBeNull();
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── P1: topic / tags / project_path / enrich_ver fields ──────────────────────

describe('memoryWrite — P1 enrichment fields (BL-24)', () => {
  it('persists caller-supplied topic', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: 'TypeScript strict mode improves type safety.',
        topic: 'typescript',
      });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;
      const row = db
        .prepare<[string], { topic: string | null }>('SELECT topic FROM node WHERE uid = ?')
        .get(uid)!;
      expect(row.topic).toBe('typescript');
      db.close();
    } finally { cleanup(); }
  });

  it('parses [<topic>] prefix from content when no explicit topic supplied', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: '[authentication] JWT tokens expire after 1 hour.',
      });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;
      const row = db
        .prepare<[string], { topic: string | null }>('SELECT topic FROM node WHERE uid = ?')
        .get(uid)!;
      expect(row.topic).toBe('authentication');
      db.close();
    } finally { cleanup(); }
  });

  it('explicit topic param overrides [<topic>] prefix', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: '[old-topic] Some content here.',
        topic: 'new-topic',
      });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;
      const row = db
        .prepare<[string], { topic: string | null }>('SELECT topic FROM node WHERE uid = ?')
        .get(uid)!;
      expect(row.topic).toBe('new-topic');
      db.close();
    } finally { cleanup(); }
  });

  it('persists tags as JSON column AND creates MENTIONS entity edges', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: 'Discussing JWT and OAuth flows.',
        tags: ['JWT', 'OAuth'],
      });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;

      // tags JSON column
      const row = db
        .prepare<[string], { tags: string | null }>('SELECT tags FROM node WHERE uid = ?')
        .get(uid)!;
      expect(JSON.parse(row.tags!)).toEqual(['JWT', 'OAuth']);

      // MENTIONS edges
      const mentionCount = db
        .prepare<[string], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM edge e
           JOIN node src ON src.uid = ?
           JOIN node dst ON dst.kind = 'entity' AND dst.name IN ('JWT','OAuth')
           WHERE e.src = src.rowid AND e.dst = dst.rowid AND e.rel = 'MENTIONS'`,
        )
        .get(uid)!;
      expect(mentionCount.cnt).toBe(2);
      db.close();
    } finally { cleanup(); }
  });

  it('persists caller-supplied project_path', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: 'Nx monorepo task caching speeds up CI.',
        project_path: '/Users/nix/dev/ai/sox-ecosystem',
      });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;
      const row = db
        .prepare<[string], { project_path: string | null }>('SELECT project_path FROM node WHERE uid = ?')
        .get(uid)!;
      expect(row.project_path).toBe('/Users/nix/dev/ai/sox-ecosystem');
      db.close();
    } finally { cleanup(); }
  });

  it('leaves topic/tags null when not supplied; project_path is auto-detected by enrichOnWrite', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      // P2: enrichOnWrite auto-detects project_path from git root — it will be non-null.
      // topic and tags remain null when not supplied (no prefix, no tags param).
      const r = await memoryWrite(db, { content: 'A plain episode with no enrichment fields.' });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;
      const row = db
        .prepare<[string], { topic: string | null; tags: string | null; project_path: string | null }>(
          'SELECT topic, tags, project_path FROM node WHERE uid = ?',
        )
        .get(uid)!;
      expect(row.topic).toBeNull();
      expect(row.tags).toBeNull();
      // project_path is auto-detected from git root (non-null in a git repo)
      expect(typeof row.project_path).toBe('string');
      db.close();
    } finally { cleanup(); }
  });

  it('tags are queryable via json_extract / json_each', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: 'Memory graph stores semantic knowledge.',
        tags: ['memory', 'graph'],
      });
      const uid = (r as { episode_uid: string }).episode_uid;

      // json_each filter: find episodes with tag 'graph'
      const found = db
        .prepare<[string, string], { uid: string }>(
          `SELECT n.uid FROM node n, json_each(n.tags) t
           WHERE t.value = ? AND n.uid = ? AND n.t_invalid IS NULL`,
        )
        .get('graph', uid);
      expect(found?.uid).toBe(uid);
      db.close();
    } finally { cleanup(); }
  });

  it('enrichment field in WriteResult matches persisted values', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: '[security] Validate all inputs at the API boundary.',
        topic: 'security',
        project_path: '/projects/api',
        tags: ['validation', 'security'],
        summary: 'Input validation best practice',
      });
      expect('episode_uid' in r).toBe(true);
      const result = r as { episode_uid: string; enrichment: Record<string, unknown> };
      expect(result.enrichment.topic).toBe('security');
      expect(result.enrichment.project_path).toBe('/projects/api');
      expect(result.enrichment.tags).toEqual(['validation', 'security']);
      expect(result.enrichment.summary).toBe('Input validation best practice');
      expect(result.enrichment.near_dup).toBeNull();
      db.close();
    } finally { cleanup(); }
  });

  it('derived_from_uid creates a DERIVED_FROM edge', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      const parent = await memoryWrite(db, { content: 'Parent episode with important context.' });
      expect('episode_uid' in parent).toBe(true);
      const parentUid = (parent as { episode_uid: string }).episode_uid;

      const child = await memoryWrite(db, {
        content: 'Child episode derived from parent context.',
        derived_from_uid: parentUid,
      });
      expect('episode_uid' in child).toBe(true);
      const childUid = (child as { episode_uid: string }).episode_uid;

      const edge = db
        .prepare<[string, string], { rel: string }>(
          `SELECT e.rel FROM edge e
           JOIN node src ON src.uid = ?
           JOIN node dst ON dst.uid = ?
           WHERE e.src = src.rowid AND e.dst = dst.rowid AND e.rel = 'DERIVED_FROM'`,
        )
        .get(childUid, parentUid);
      expect(edge?.rel).toBe('DERIVED_FROM');
      db.close();
    } finally { cleanup(); }
  });
});

// ── WP-3: memory_write_batch ───────────────────────────────────────────────────

describe('memoryWriteBatch — WP-3 (BL-125)', () => {
  let cleanupDb: () => void;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-'));
    cleanupDb = () => fs.rmSync(dir, { recursive: true, force: true });
    dbPath = path.join(dir, 'batch.db');
    db = openDb(dbPath);
    // Reset queue instrumentation
    WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    // Embedding provided by DeterministicTestProvider installed in vitest.setup.ts
  });

  afterEach(() => {
    if (db && db.open) db.close();
    cleanupDb();
    WriteQueue.clearInstances();
  });

  /**
   * Acceptance: batch of 10 items (incl. 1 byte-duplicate) → 9 ok + 1
   * ok:false, code:E_DEDUP, details.existing_uid
   */
  it('batch of 10 items with 1 byte-duplicate returns 9 ok + 1 E_DEDUP with existing_uid', async () => {
    // Items must be semantically distinct (no shared token clusters) so the
    // deterministic feature-hash provider does not false-positive near-dup them.
    // The tenth item is a byte-duplicate of the first (same content after
    // trim+lowercase normalization).
    const items = [
      { content: 'The volcano erupted at dawn revealing ancient lava flows.' },
      { content: 'Stock markets closed higher amid positive earnings reports.' },
      { content: 'Scientists discovered a new antibiotic compound in soil bacteria.' },
      { content: 'Astronomers photographed a black hole swallowing a star.' },
      { content: 'The architect designed a bridge spanning the river gorge.' },
      { content: 'Fishermen reported unusually large hauls of bluefin tuna.' },
      { content: 'Cryptography underpins secure communication across digital networks.' },
      { content: 'Medieval manuscripts revealed recipes for herbal remedies.' },
      { content: 'Marathon runners competed under intense summer heat conditions.' },
      // Byte-duplicate of first item (same content after trim+lowercase)
      { content: '  The Volcano Erupted At Dawn Revealing Ancient Lava Flows.  ' },
    ];

    const result = await memoryWriteBatch(db, items);
    expect(result.results).toHaveLength(10);

    // Count successes
    const ok = result.results.filter((r) => r.ok === true);
    const errs = result.results.filter((r) => r.ok === false);

    expect(ok).toHaveLength(9);
    expect(errs).toHaveLength(1);

    // The error item is the duplicate (index 9)
    const dup = errs[0] as { ok: false; code: string; details?: { existing_uid: string } };
    expect(dup.code).toBe('E_DEDUP');
    expect(dup.details).toBeDefined();
    expect(typeof dup.details!.existing_uid).toBe('string');

    // The existing_uid should match the first item's episode_uid
    const firstUid = (ok[0] as { ok: true; episode_uid: string }).episode_uid;
    expect(dup.details!.existing_uid).toBe(firstUid);

    // Verify total count in DB = 9 (not 10)
    const count = db.prepare<[], { cnt: number }>("SELECT COUNT(*) as cnt FROM node WHERE kind='episode' AND t_invalid IS NULL").get()!;
    expect(count.cnt).toBe(9);
  });

  /**
   * Single queue entry assertion: route the batch through WriteQueue and
   * verify only ONE enqueue was made (not N for N items).
   */
  it('batch routes as a single queue entry (not N items)', async () => {
    WriteQueue.clearInstances();
    const queue = WriteQueue.forPath(dbPath);
    // The batch function itself doesn't enqueue — the test wraps it in a queue
    // entry to simulate what the MCP handler does.
    // We reset the count before the batch, then verify count remains 0
    // because memoryWriteBatch calls memoryWrite internally but does NOT enqueue.
    WriteQueue.resetAllEnqueueCounts();

    // The batch function should not internally enqueue.
    // Content must be semantically distinct: near-identical strings (differing by
    // one char) score >NEARDUP_THRESHOLD (0.95) under the real bge model and one
    // would be invalidated as a near-duplicate, collapsing the count to 1.
    const items = [
      { content: 'The database migration completed at noon on Tuesday.' },
      { content: 'Rainfall over the Amazon basin peaked during the wet season.' },
    ];

    // Simulate the MCP handler pattern: one queue entry for the whole batch
    await queue.enqueue('memory_write_batch', async (qdb) => {
      await memoryWriteBatch(qdb, items);
    });

    // Wait for the queue to drain
    await new Promise<void>((r) => setTimeout(r, 100));

    // Queue should have exactly 1 enqueue (the batch wrapper)
    expect(queue._enqueueCount).toBe(1);

    // Verify both items were written
    const count = db.prepare<[], { cnt: number }>("SELECT COUNT(*) as cnt FROM node WHERE kind='episode' AND t_invalid IS NULL").get()!;
    expect(count.cnt).toBe(2);
  });

  /**
   * Negative control: empty items array returns 0 results, no crash.
   */
  it('negative control: empty items array returns zero results', async () => {
    const result = await memoryWriteBatch(db, []);
    expect(result.results).toHaveLength(0);
  });

  /**
   * Negative control: single invalid item (empty content) returns E_SCOPE_RO.
   */
  it('negative control: empty content in a batch item returns E_SCOPE_RO per-item', async () => {
    const result = await memoryWriteBatch(db, [
      { content: '' },
      { content: 'Valid content after empty.' },
    ]);
    expect(result.results).toHaveLength(2);

    const first = result.results[0];
    expect(first.ok).toBe(false);
    expect((first as { code: string }).code).toBe('E_SCOPE_RO');

    const second = result.results[1];
    expect(second.ok).toBe(true);
  });

  /**
   * Negative control: all items are identical duplicates → all return E_DEDUP
   * except the first (which succeeds).
   */
  it('negative control: all identical items → one success, rest E_DEDUP', async () => {
    const items = [
      { content: 'Identical batch item content for dedup test.' },
      { content: 'Identical batch item content for dedup test.' },
      { content: 'Identical batch item content for dedup test.' },
      { content: 'Identical batch item content for dedup test.' },
      { content: 'Identical batch item content for dedup test.' },
    ];

    const result = await memoryWriteBatch(db, items);
    expect(result.results).toHaveLength(5);

    const ok = result.results.filter((r) => r.ok === true);
    const errs = result.results.filter((r) => r.ok === false);

    expect(ok).toHaveLength(1);
    expect(errs).toHaveLength(4);

    for (const err of errs) {
      expect((err as { code: string }).code).toBe('E_DEDUP');
      expect((err as { details: { existing_uid: string } }).details.existing_uid).toBe(
        (ok[0] as { episode_uid: string }).episode_uid,
      );
    }
  });
});

// ── WP-4: client_request_id idempotency ────────────────────────────────────────

describe('client_request_id idempotency — WP-4 (BL-129)', () => {
  let cleanupDb: () => void;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqid-'));
    cleanupDb = () => fs.rmSync(dir, { recursive: true, force: true });
    dbPath = path.join(dir, 'reqid.db');
    db = openDb(dbPath);
    WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    // Embedding provided by DeterministicTestProvider installed in vitest.setup.ts
  });

  afterEach(() => {
    if (db && db.open) db.close();
    cleanupDb();
    WriteQueue.clearInstances();
  });

  /**
   * Same id replayed → identical result + replayed:true, no new node.
   */
  it('replay of same client_request_id returns replayed:true with existing uid, no new node', async () => {
    const params = {
      content: 'Idempotent write test with client_request_id.',
      client_request_id: 'test-replay-id-001',
    };

    // First call: fresh write
    const first = await memoryWrite(db, params);
    expect('episode_uid' in first).toBe(true);
    const firstResult = first as { episode_uid: string; replayed?: boolean };
    expect(firstResult.replayed).toBeUndefined();

    const firstUid = firstResult.episode_uid;

    // Second call with same id: replay, no new node
    const second = await memoryWrite(db, params);
    expect('episode_uid' in second).toBe(true);
    const secondResult = second as { episode_uid: string; replayed?: boolean };
    expect(secondResult.replayed).toBe(true);
    expect(secondResult.episode_uid).toBe(firstUid);

    // Only one episode in DB
    const count = db.prepare<[], { cnt: number }>("SELECT COUNT(*) as cnt FROM node WHERE kind='episode' AND t_invalid IS NULL").get()!;
    expect(count.cnt).toBe(1);

    // Verify the request_ledger table has exactly one entry
    const ledgerRow = db
      .prepare<[string], { request_id: string; episode_uid: string }>(
        'SELECT request_id, episode_uid FROM request_ledger WHERE request_id = ?',
      )
      .get('test-replay-id-001');
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow!.episode_uid).toBe(firstUid);
  });

  /**
   * Ledger pruning: requestLedgerPrune removes entries older than retention.
   */
  it('requestLedgerPrune deletes entries older than retention days', async () => {
    // Manually insert a ledger entry with a very old created_at
    const oldId = 'old-req-id';
    const oldEpoch = '2020-01-01T00:00:00.000Z';
    db.prepare(
      'INSERT INTO request_ledger(request_id, episode_uid, created_at) VALUES (?, ?, ?)',
    ).run(oldId, 'stale-episode-uid', oldEpoch);

    // Insert a recent entry
    const recentId = 'recent-req-id';
    const recentEpoch = new Date().toISOString();
    db.prepare(
      'INSERT INTO request_ledger(request_id, episode_uid, created_at) VALUES (?, ?, ?)',
    ).run(recentId, 'fresh-episode-uid', recentEpoch);

    // Prune with 1-day retention (old entry is >5 years old → pruned)
    const deleted = requestLedgerPrune(db, 1);
    expect(deleted).toBe(1);

    // Old entry is gone
    const oldRow = db
      .prepare<[string], { request_id: string }>('SELECT request_id FROM request_ledger WHERE request_id = ?')
      .get(oldId);
    expect(oldRow).toBeUndefined();

    // Recent entry survives
    const recentRow = db
      .prepare<[string], { request_id: string }>('SELECT request_id FROM request_ledger WHERE request_id = ?')
      .get(recentId);
    expect(recentRow).toBeDefined();
  });

  /**
   * Negative control: client_request_id that is too long (>128 chars) is rejected.
   */
  it('negative control: client_request_id longer than 128 chars returns E_SCOPE_RO', async () => {
    const longId = 'x'.repeat(129);
    const result = await memoryWrite(db, {
      content: 'Test content for long ID validation.',
      client_request_id: longId,
    });

    expect('episode_uid' in result).toBe(false);
    const err = result as { code: string; message: string };
    expect(err.code).toBe('E_SCOPE_RO');
  });

  /**
   * Negative control: client_request_id that is not a string is rejected.
   */
  it('negative control: non-string client_request_id returns E_SCOPE_RO', async () => {
    // TypeScript would catch this at compile time but at the JS boundary
    // (e.g., MCP tool call), a non-string could arrive.
    const result = await memoryWrite(db, {
      content: 'Test content for non-string ID validation.',
      client_request_id: 12345 as unknown as string,
    });

    expect('episode_uid' in result).toBe(false);
    const err = result as { code: string; message: string };
    expect(err.code).toBe('E_SCOPE_RO');
  });

  /**
   * Negative control: different content with the same client_request_id still replays
   * the first result (the id determines the response, not the content).
   */
  it('negative control: different content with same client_request_id returns original result (replayed)', async () => {
    const id = 'fixed-replay-id';

    const first = await memoryWrite(db, {
      content: 'Original content for fixed id.',
      client_request_id: id,
    });
    const firstResult = first as { episode_uid: string; replayed?: boolean };
    const firstUid = firstResult.episode_uid;

    // Second call with DIFFERENT content but SAME id
    const second = await memoryWrite(db, {
      content: 'COMPLETELY DIFFERENT content with same id.',
      client_request_id: id,
    });
    const secondResult = second as { episode_uid: string; replayed?: boolean };
    expect(secondResult.replayed).toBe(true);
    expect(secondResult.episode_uid).toBe(firstUid);

    // Only one episode was created
    const count = db.prepare<[], { cnt: number }>("SELECT COUNT(*) as cnt FROM node WHERE kind='episode' AND t_invalid IS NULL").get()!;
    expect(count.cnt).toBe(1);
  });
});

describe('openDb — P1 enrichment column migrations (D3.1)', () => {
  it('a fresh store has all P1 enrichment columns', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 'fresh.db'));
      const cols = (db.prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('topic');
      expect(cols).toContain('tags');
      expect(cols).toContain('project_path');
      expect(cols).toContain('enrich_ver');
      db.close();
    } finally { cleanup(); }
  });

  it('adds P1 columns to a pre-existing store that lacks them (idempotent)', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const dbPath = path.join(dir, 'old-p1.db');
      const raw = new Database(dbPath);
      // Simulate a pre-P1 store: node table without enrichment columns.
      raw.exec(
        `CREATE TABLE node (
           rowid INTEGER PRIMARY KEY, uid TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
           content TEXT, name TEXT, summary TEXT, meta TEXT,
           agent_id TEXT, session_id TEXT, source TEXT, importance REAL DEFAULT 1.0,
           content_hash TEXT, level INTEGER, resume_state TEXT,
           t_created TEXT NOT NULL, t_occurred TEXT, t_valid TEXT, t_invalid TEXT,
           last_access TEXT, access_count INTEGER DEFAULT 0
         )`,
      );
      raw.close();

      const db = openDb(dbPath);
      const cols = (db.prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('topic');
      expect(cols).toContain('tags');
      expect(cols).toContain('project_path');
      expect(cols).toContain('enrich_ver');
      db.close();

      // Idempotent: re-opening does not duplicate or error
      const db2 = openDb(dbPath);
      const cols2 = (db2.prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      for (const col of ['topic', 'tags', 'project_path', 'enrich_ver']) {
        expect(cols2.filter((c) => c === col)).toHaveLength(1);
      }
      db2.close();
    } finally { cleanup(); }
  });

  it('partial pre-existing columns are migrated safely (some missing, some present)', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const dbPath = path.join(dir, 'partial.db');
      const raw = new Database(dbPath);
      // Simulate a store that already has meta + topic but not the rest.
      // Use full schema so FTS triggers work correctly.
      raw.exec(
        `CREATE TABLE node (
           rowid INTEGER PRIMARY KEY, uid TEXT UNIQUE NOT NULL,
           kind TEXT NOT NULL CHECK (kind IN ('episode','entity','claim','community','session')),
           content TEXT, name TEXT, summary TEXT,
           meta TEXT,
           topic TEXT,
           agent_id TEXT, session_id TEXT, source TEXT,
           importance REAL DEFAULT 1.0, confidence REAL, content_hash TEXT,
           level INTEGER, resume_state TEXT,
           t_created TEXT NOT NULL, t_occurred TEXT, t_valid TEXT, t_invalid TEXT,
           last_access TEXT, access_count INTEGER DEFAULT 0
         )`,
      );
      raw.close();

      // topic already exists — openDb must add tags/project_path/enrich_ver without error
      const db = openDb(dbPath);
      const cols = (db.prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('topic');
      expect(cols).toContain('tags');
      expect(cols).toContain('project_path');
      expect(cols).toContain('enrich_ver');
      db.close();
    } finally { cleanup(); }
  });
});

describe('openDb — node.meta migration (BL-23)', () => {
  it('a fresh store has the meta column', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 'fresh.db'));
      const cols = (db.prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('meta');
      db.close();
    } finally {
      cleanup();
    }
  });

  it('adds meta to a pre-existing store that lacks it (idempotent migration)', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const dbPath = path.join(dir, 'old.db');
      // Simulate an older store: a node table without the meta column.
      const raw = new Database(dbPath);
      // Real old-store node table = current schema MINUS the new `meta` column.
      raw.exec(
        `CREATE TABLE node (
           rowid INTEGER PRIMARY KEY, uid TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
           content TEXT, name TEXT, summary TEXT,
           agent_id TEXT, session_id TEXT, source TEXT, importance REAL DEFAULT 1.0,
           confidence REAL, content_hash TEXT, level INTEGER, resume_state TEXT,
           t_created TEXT NOT NULL, t_occurred TEXT, t_valid TEXT, t_invalid TEXT,
           last_access TEXT, access_count INTEGER DEFAULT 0
         )`,
      );
      raw.close();

      // openDb must migrate it in place.
      const db = openDb(dbPath);
      const cols = (db.prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('meta');
      db.close();

      // Idempotent: re-opening doesn't error or duplicate.
      const db2 = openDb(dbPath);
      const cols2 = (db2.prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols2.filter((c) => c === 'meta')).toHaveLength(1);
      db2.close();
    } finally {
      cleanup();
    }
  });
});
