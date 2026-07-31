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
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { WriteQueue } from './write-queue.js';

/**
 * BL-325: openDb() returns a StoreAdapter, not a raw better-sqlite3 handle.
 * These specs' own verification reads use raw SQL against the sqlite backend,
 * so unwrap once here rather than rewriting every assertion.
 */
function raw(a: StoreAdapter): Database.Database {
  return a.unwrap() as Database.Database;
}


// Mock embed to avoid real ONNX model download (these tests assert DB persistence, not embedding quality)

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memwrite-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('memoryWrite — summary + metadata (BL-23)', () => {
  it('persists client-supplied summary and metadata', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: 'Bi-temporal edges supersede facts.',
        summary: 'graph supersession',
        project_path: '/Users/nix/dev/ai/foo',
        metadata: { url: 'x' },
      });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;

      const row = raw(db)
        .prepare<[string], { summary: string | null; meta: string | null }>(
          'SELECT summary, meta FROM node WHERE uid = ?',
        )
        .get(uid)!;

      expect(row.summary).toBe('graph supersession');
      expect(JSON.parse(row.meta!)).toEqual({ url: 'x' });
      db.close();
    } finally {
      cleanup();
    }
  });

  it('leaves meta null when not supplied; summary is set by extractive fallback (no regression)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      // P2: enrichOnWrite runs extractiveSummary when no caller summary is supplied.
      // Content < 100 chars → extractiveSummary returns it as-is (still non-null).
      const r = await memoryWrite(db, { content: 'Plain content, no extras.', project_path: '/test/project' });
      const uid = (r as { episode_uid: string }).episode_uid;
      const row = raw(db)
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
      const db = await openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: 'TypeScript strict mode improves type safety.',
        topic: 'typescript',
        project_path: '/test/project',
      });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;
      const row = raw(db)
        .prepare<[string], { topic: string | null }>('SELECT topic FROM node WHERE uid = ?')
        .get(uid)!;
      expect(row.topic).toBe('typescript');
      db.close();
    } finally { cleanup(); }
  });

  it('parses [<topic>] prefix from content when no explicit topic supplied', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: '[authentication] JWT tokens expire after 1 hour.',
        project_path: '/test/project',
      });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;
      const row = raw(db)
        .prepare<[string], { topic: string | null }>('SELECT topic FROM node WHERE uid = ?')
        .get(uid)!;
      expect(row.topic).toBe('authentication');
      db.close();
    } finally { cleanup(); }
  });

  it('explicit topic param overrides [<topic>] prefix', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: '[old-topic] Some content here.',
        topic: 'new-topic',
        project_path: '/test/project',
      });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;
      const row = raw(db)
        .prepare<[string], { topic: string | null }>('SELECT topic FROM node WHERE uid = ?')
        .get(uid)!;
      expect(row.topic).toBe('new-topic');
      db.close();
    } finally { cleanup(); }
  });

  it('persists tags as JSON column AND creates MENTIONS entity edges', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: 'Discussing JWT and OAuth flows.',
        tags: ['JWT', 'OAuth'],
        project_path: '/test/project',
      });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;

      // tags JSON column
      const row = raw(db)
        .prepare<[string], { tags: string | null }>('SELECT tags FROM node WHERE uid = ?')
        .get(uid)!;
      expect(JSON.parse(row.tags!)).toEqual(['JWT', 'OAuth']);

      // MENTIONS edges
      const mentionCount = raw(db)
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
      const db = await openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: 'Nx monorepo task caching speeds up CI.',
        project_path: '/Users/nix/dev/ai/sox-ecosystem',
      });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;
      const row = raw(db)
        .prepare<[string], { project_path: string | null }>('SELECT project_path FROM node WHERE uid = ?')
        .get(uid)!;
      expect(row.project_path).toBe('/Users/nix/dev/ai/sox-ecosystem');
      db.close();
    } finally { cleanup(); }
  });

  it('leaves topic/tags null when not supplied; project_path is caller-supplied', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      // BL-62: project_path is now required (caller-supplied, not auto-detected).
      // topic and tags remain null when not supplied (no prefix, no tags param).
      const r = await memoryWrite(db, { content: 'A plain episode with no enrichment fields.', project_path: '/test/project' });
      expect('episode_uid' in r).toBe(true);
      const uid = (r as { episode_uid: string }).episode_uid;
      const row = raw(db)
        .prepare<[string], { topic: string | null; tags: string | null; project_path: string | null }>(
          'SELECT topic, tags, project_path FROM node WHERE uid = ?',
        )
        .get(uid)!;
      expect(row.topic).toBeNull();
      expect(row.tags).toBeNull();
      // project_path is the caller-supplied value
      expect(row.project_path).toBe('/test/project');
      db.close();
    } finally { cleanup(); }
  });

  it('tags are queryable via json_extract / json_each', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, {
        content: 'Memory graph stores semantic knowledge.',
        tags: ['memory', 'graph'],
        project_path: '/test/project',
      });
      const uid = (r as { episode_uid: string }).episode_uid;

      // json_each filter: find episodes with tag 'graph'
      const found = raw(db)
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
      const db = await openDb(path.join(dir, 't.db'));
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
      expect(result.enrichment.project_path_source).toBe('explicit');
      expect(result.enrichment.tags).toEqual(['validation', 'security']);
      expect(result.enrichment.summary).toBe('Input validation best practice');
      expect(result.enrichment.near_dup).toBeNull();
      db.close();
    } finally { cleanup(); }
  });

  it('derived_from_uid creates a DERIVED_FROM edge', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const parent = await memoryWrite(db, { content: 'Parent episode with important context.', project_path: '/test/project' });
      expect('episode_uid' in parent).toBe(true);
      const parentUid = (parent as { episode_uid: string }).episode_uid;

      const child = await memoryWrite(db, {
        content: 'Child episode derived from parent context.',
        derived_from_uid: parentUid,
        project_path: '/test/project',
      });
      expect('episode_uid' in child).toBe(true);
      const childUid = (child as { episode_uid: string }).episode_uid;

      const edge = raw(db)
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

// ── BL-62: project_path attribution visibility (shim-cwd ≠ working-dir) ──────────
//
// BACKLOG.md BL-62 "REGRESSION / incomplete-fix evidence (2026-07-08)": an unqualified
// `memory_write` (no explicit `project_path`) from a session whose REAL working
// project differed from the serving process's cwd/env was silently attributed to the
// WRONG project — specifically, the MCP shim/backend's frozen process cwd
// (SOX_CONFIG_PROJECT_PATH, injected once at shim spawn — apps/sox/src/main.ts) is
// NOT the same thing as the caller's LIVE working directory, and Node's
// `process.cwd()` cannot change per-request within a single long-lived process. This
// is a DIFFERENT case from the original BL-62 "shim-cwd == project" fix (which only
// proved the single-project-per-shim case): here the shim/backend's own cwd is
// stipulated to differ from the caller's true project (the exact qusececure vs
// agent-source repro, episode 01KX1WZSGSN4KZZM812Q2FCVCE).
//
// HARD GATE (per task brief): the only fully-correct fix requires either (a) the
// caller ALWAYS passing `project_path` explicitly (works today — precedence:
// explicit-arg > env > cwd-git, provenance.ts), or (b) the MCP `roots` capability,
// which this server's transport (libs/mcp-runtime serve()) does NOT negotiate.
// Inventing that protocol wiring here is explicitly out of scope. What IS safely
// implementable within write.ts: stamp WHICH tier resolved project_path
// (`enrichment.project_path_source`) so a caller/operator can DETECT low-confidence
// attribution instead of it being silent and permanently unrecoverable (the
// BL-221 companion fix then makes it correctable via memory_update).
describe('memoryWrite — BL-62 project_path required (resolved)', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['SOX_CONFIG_PROJECT_PATH'];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env['SOX_CONFIG_PROJECT_PATH'];
    else process.env['SOX_CONFIG_PROJECT_PATH'] = savedEnv;
  });

  it('BL-62: an unqualified write (no project_path) is rejected with E_MISSING_PROJECT_PATH and creates no node', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      process.env['SOX_CONFIG_PROJECT_PATH'] = '/Users/nix/dev/ai/agent-source';
      const db = await openDb(path.join(dir, 't.db'));

      // Count nodes before
      const before = raw(db).prepare<[], { cnt: number }>("SELECT COUNT(*) as cnt FROM node WHERE kind='episode'").get()!;

      // No project_path arg — this is now rejected
      const r = await memoryWrite(db, { content: 'BL-62 resolved: unqualified write rejected.' });
      expect('episode_uid' in r).toBe(false);
      const result = r as { code: string; message: string };
      expect(result.code).toBe('E_MISSING_PROJECT_PATH');
      expect(result.message).toContain('project_path is required');

      // Count nodes after — should be unchanged (no node created)
      const after = raw(db).prepare<[], { cnt: number }>("SELECT COUNT(*) as cnt FROM node WHERE kind='episode'").get()!;
      expect(after.cnt).toBe(before.cnt);

      db.close();
    } finally {
      cleanup();
    }
  });

  it('BL-62: passing project_path explicitly succeeds and is reported project_path_source:"explicit"', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      process.env['SOX_CONFIG_PROJECT_PATH'] = '/Users/nix/dev/ai/agent-source';
      const trueWorkingDir = '/Users/nix/Documents/professional/qusececure';

      const db = await openDb(path.join(dir, 't.db'));
      // Caller knows its own real cwd and passes it explicitly.
      const r = await memoryWrite(db, {
        content: 'BL-62 resolved: qualified write with explicit project_path.',
        project_path: trueWorkingDir,
      });
      expect('episode_uid' in r).toBe(true);
      const result = r as {
        episode_uid: string;
        enrichment: { project_path: string | null; project_path_source: string };
      };

      expect(result.enrichment.project_path).toBe(trueWorkingDir);
      expect(result.enrichment.project_path_source).toBe('explicit');

      const row = raw(db)
        .prepare<[string], { project_path: string | null }>(
          'SELECT project_path FROM node WHERE uid = ?',
        )
        .get(result.episode_uid)!;
      expect(row.project_path).toBe(trueWorkingDir);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('BL-62: an empty-string project_path arg is rejected (treated as omitted) with E_MISSING_PROJECT_PATH', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      process.env['SOX_CONFIG_PROJECT_PATH'] = '/Users/nix/dev/ai/agent-source';
      const db = await openDb(path.join(dir, 't.db'));

      // Count nodes before
      const before = raw(db).prepare<[], { cnt: number }>("SELECT COUNT(*) as cnt FROM node WHERE kind='episode'").get()!;

      // Empty-string is treated as omitted → rejected
      const r = await memoryWrite(db, { content: 'BL-62 empty-string now rejected.', project_path: '' });
      expect('episode_uid' in r).toBe(false);
      const result = r as { code: string; message: string };
      expect(result.code).toBe('E_MISSING_PROJECT_PATH');

      // Count nodes after — should be unchanged
      const after = raw(db).prepare<[], { cnt: number }>("SELECT COUNT(*) as cnt FROM node WHERE kind='episode'").get()!;
      expect(after.cnt).toBe(before.cnt);

      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── WP-3: memory_write_batch ───────────────────────────────────────────────────

describe('memoryWriteBatch — WP-3 (BL-125)', () => {
  let cleanupDb: () => void;
  let dbPath: string;
  let db: StoreAdapter;

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-'));
    cleanupDb = () => fs.rmSync(dir, { recursive: true, force: true });
    dbPath = path.join(dir, 'batch.db');
    db = await openDb(dbPath);
    // Reset queue instrumentation
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    // Embedding provided by DeterministicTestProvider installed in vitest.setup.ts
  });

  afterEach(async () => {
    if (db && raw(db).open) db.close();
    cleanupDb();
    await WriteQueue.clearInstances();
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
      { content: 'The volcano erupted at dawn revealing ancient lava flows.', project_path: '/test/project' },
      { content: 'Stock markets closed higher amid positive earnings reports.', project_path: '/test/project' },
      { content: 'Scientists discovered a new antibiotic compound in soil bacteria.', project_path: '/test/project' },
      { content: 'Astronomers photographed a black hole swallowing a star.', project_path: '/test/project' },
      { content: 'The architect designed a bridge spanning the river gorge.', project_path: '/test/project' },
      { content: 'Fishermen reported unusually large hauls of bluefin tuna.', project_path: '/test/project' },
      { content: 'Cryptography underpins secure communication across digital networks.', project_path: '/test/project' },
      { content: 'Medieval manuscripts revealed recipes for herbal remedies.', project_path: '/test/project' },
      { content: 'Marathon runners competed under intense summer heat conditions.', project_path: '/test/project' },
      // Byte-duplicate of first item (same content after trim+lowercase)
      { content: '  The Volcano Erupted At Dawn Revealing Ancient Lava Flows.  ', project_path: '/test/project' },
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
    const count = raw(db).prepare<[], { cnt: number }>("SELECT COUNT(*) as cnt FROM node WHERE kind='episode' AND t_invalid IS NULL").get()!;
    expect(count.cnt).toBe(9);
  });

  /**
   * Single queue entry assertion: route the batch through WriteQueue and
   * verify only ONE enqueue was made (not N for N items).
   */
  it('batch routes as a single queue entry (not N items)', async () => {
    WriteQueue.clearInstances();
    const queue = await WriteQueue.forPath(dbPath);
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
      { content: 'The database migration completed at noon on Tuesday.', project_path: '/test/project' },
      { content: 'Rainfall over the Amazon basin peaked during the wet season.', project_path: '/test/project' },
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
    const count = raw(db).prepare<[], { cnt: number }>("SELECT COUNT(*) as cnt FROM node WHERE kind='episode' AND t_invalid IS NULL").get()!;
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
      { content: '', project_path: '/test/project' },
      { content: 'Valid content after empty.', project_path: '/test/project' },
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
      { content: 'Identical batch item content for dedup test.', project_path: '/test/project' },
      { content: 'Identical batch item content for dedup test.', project_path: '/test/project' },
      { content: 'Identical batch item content for dedup test.', project_path: '/test/project' },
      { content: 'Identical batch item content for dedup test.', project_path: '/test/project' },
      { content: 'Identical batch item content for dedup test.', project_path: '/test/project' },
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

// ── BL-233: memory_write_batch project_path_source parity ──────────────────────
//
// The BL-62 mitigation added WriteResult.enrichment.project_path_source to the
// single-item memoryWrite path. BatchItemOk had no equivalent, so batch writers
// could not tell whether a given item's attribution was inferred (and thus
// possibly wrong, per BL-62) or explicit. This computes it identically to the
// single-item path (a non-empty project_path on THAT item => 'explicit').
describe('memoryWriteBatch — project_path_source parity (BL-233)', () => {
  let cleanupDb: () => void;
  let db: StoreAdapter;

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-pps-'));
    cleanupDb = () => fs.rmSync(dir, { recursive: true, force: true });
    db = await openDb(path.join(dir, 'batch-pps.db'));
  });

  afterEach(() => {
    if (db && raw(db).open) db.close();
    cleanupDb();
  });

  it('BL-233: per-item project_path_source is "explicit" when that item supplies project_path, items without project_path return E_MISSING_PROJECT_PATH', async () => {
    const items = [
      { content: 'Batch item with explicit project_path A.', project_path: '/projects/alpha' },
      { content: 'Batch item with NO project_path at all.' },
      { content: 'Batch item with explicit project_path B.', project_path: '/projects/beta' },
    ];

    const result = await memoryWriteBatch(db, items);
    expect(result.results).toHaveLength(3);

    // First item: explicit project_path → succeeds
    const first = result.results[0];
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.project_path_source).toBe('explicit');
    }

    // Second item: no project_path → rejected with E_MISSING_PROJECT_PATH
    const second = result.results[1];
    expect(second.ok).toBe(false);
    expect((second as { code: string }).code).toBe('E_MISSING_PROJECT_PATH');

    // Third item: explicit project_path → succeeds
    const third = result.results[2];
    expect(third.ok).toBe(true);
    if (third.ok) {
      expect(third.project_path_source).toBe('explicit');
    }
  });

  it('BL-233: an empty-string project_path on a batch item is rejected with E_MISSING_PROJECT_PATH', async () => {
    const result = await memoryWriteBatch(db, [
      { content: 'Batch item with empty-string project_path.', project_path: '' },
    ]);
    const first = result.results[0];
    expect(first.ok).toBe(false);
    expect((first as { code: string }).code).toBe('E_MISSING_PROJECT_PATH');
  });
});

// ── WP-4: client_request_id idempotency ────────────────────────────────────────

describe('client_request_id idempotency — WP-4 (BL-129)', () => {
  let cleanupDb: () => void;
  let dbPath: string;
  let adapter: StoreAdapter;

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqid-'));
    cleanupDb = () => fs.rmSync(dir, { recursive: true, force: true });
    dbPath = path.join(dir, 'reqid.db');
    adapter = await openDb(dbPath);
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    // Embedding provided by DeterministicTestProvider installed in vitest.setup.ts
  });

  afterEach(async () => {
    await adapter.close();
    cleanupDb();
    await WriteQueue.clearInstances();
  });

  /**
   * Same id replayed → identical result + replayed:true, no new node.
   */
  it('replay of same client_request_id returns replayed:true with existing uid, no new node', async () => {
    const params = {
      content: 'Idempotent write test with client_request_id.',
      client_request_id: 'test-replay-id-001',
      project_path: '/test/project',
    };

    // First call: fresh write
    const first = await memoryWrite(adapter, params);
    expect('episode_uid' in first).toBe(true);
    const firstResult = first as { episode_uid: string; replayed?: boolean };
    expect(firstResult.replayed).toBeUndefined();

    const firstUid = firstResult.episode_uid;

    // Second call with same id: replay, no new node
    const second = await memoryWrite(adapter, params);
    expect('episode_uid' in second).toBe(true);
    const secondResult = second as { episode_uid: string; replayed?: boolean };
    expect(secondResult.replayed).toBe(true);
    expect(secondResult.episode_uid).toBe(firstUid);

    // Only one episode in DB
    const count = (await adapter.executeGet<{ cnt: number }>("SELECT COUNT(*) as cnt FROM node WHERE kind='episode' AND t_invalid IS NULL"))!;
    expect(count.cnt).toBe(1);

    // Verify the request_ledger table has exactly one entry
    const ledgerRow = await adapter.executeGet<{ request_id: string; episode_uid: string }>(
      'SELECT request_id, episode_uid FROM request_ledger WHERE request_id = ?',
      ['test-replay-id-001'],
    );
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
    await adapter.executeRun(
      'INSERT INTO request_ledger(request_id, episode_uid, created_at) VALUES (?, ?, ?)',
      [oldId, 'stale-episode-uid', oldEpoch],
    );

    // Insert a recent entry
    const recentId = 'recent-req-id';
    const recentEpoch = new Date().toISOString();
    await adapter.executeRun(
      'INSERT INTO request_ledger(request_id, episode_uid, created_at) VALUES (?, ?, ?)',
      [recentId, 'fresh-episode-uid', recentEpoch],
    );

    // Prune with 1-day retention (old entry is >5 years old → pruned)
    const deleted = await requestLedgerPrune(adapter, 1);
    expect(deleted).toBe(1);

    // Old entry is gone
    const oldRow = await adapter.executeGet<{ request_id: string }>(
      'SELECT request_id FROM request_ledger WHERE request_id = ?',
      [oldId],
    );
    expect(oldRow).toBeNull();

    // Recent entry survives
    const recentRow = await adapter.executeGet<{ request_id: string }>(
      'SELECT request_id FROM request_ledger WHERE request_id = ?',
      [recentId],
    );
    expect(recentRow).toBeDefined();
  });

  /**
   * Negative control: client_request_id that is too long (>128 chars) is rejected.
   */
  it('negative control: client_request_id longer than 128 chars returns E_SCOPE_RO', async () => {
    const longId = 'x'.repeat(129);
    const result = await memoryWrite(adapter, {
      content: 'Test content for long ID validation.',
      client_request_id: longId,
      project_path: '/test/project',
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
    const result = await memoryWrite(adapter, {
      content: 'Test content for non-string ID validation.',
      client_request_id: 12345 as unknown as string,
      project_path: '/test/project',
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

    const first = await memoryWrite(adapter, {
      content: 'Original content for fixed id.',
      client_request_id: id,
      project_path: '/test/project',
    });
    const firstResult = first as { episode_uid: string; replayed?: boolean };
    const firstUid = firstResult.episode_uid;

    // Second call with DIFFERENT content but SAME id
    const second = await memoryWrite(adapter, {
      content: 'COMPLETELY DIFFERENT content with same id.',
      client_request_id: id,
      project_path: '/test/project',
    });
    const secondResult = second as { episode_uid: string; replayed?: boolean };
    expect(secondResult.replayed).toBe(true);
    expect(secondResult.episode_uid).toBe(firstUid);

    // Only one episode was created
    const count = (await adapter.executeGet<{ cnt: number }>("SELECT COUNT(*) as cnt FROM node WHERE kind='episode' AND t_invalid IS NULL"))!;
    expect(count.cnt).toBe(1);
  });
});

describe('openDb — P1 enrichment column migrations (D3.1)', () => {
  it('a fresh store has all canonical columns', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 'fresh.db'));
      const cols = (raw(db).prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      // Base graph-store columns
      expect(cols).toContain('topic');
      expect(cols).toContain('tags');
      expect(cols).toContain('project_path');
      expect(cols).toContain('namespace');
      expect(cols).toContain('level');
      expect(cols).toContain('resume_state');
      // Memory-specific enrichment columns
      expect(cols).toContain('enrich_ver');
      expect(cols).toContain('embed_model');
      db.close();
    } finally { cleanup(); }
  });

  it('adds memory-specific columns to a pre-existing store that lacks them (idempotent)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const dbPath = path.join(dir, 'old-p1.db');
      const raw = new Database(dbPath);
      // Simulate a pre-memory-core store: node table without the memory-specific
      // enrichment columns (enrich_ver, embed_model). All canonical graph-store
      // columns are included so the canonical DDL's CREATE INDEX statements
      // (ix_node_topic, ix_node_project, ix_node_namespace, ix_node_expires, etc.)
      // do not fail with "no such column".
      raw.exec(
        `CREATE TABLE node (
           rowid INTEGER PRIMARY KEY, uid TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
           content TEXT, name TEXT, summary TEXT, meta TEXT, topic TEXT, tags TEXT,
           project_path TEXT,
           agent_id TEXT, session_id TEXT, source TEXT, importance REAL DEFAULT 1.0,
           confidence REAL, content_hash TEXT, level INTEGER, resume_state TEXT,
           namespace TEXT DEFAULT 'global',
           t_expires TEXT, is_superseded INTEGER DEFAULT 0,
           t_created TEXT NOT NULL, t_occurred TEXT, t_valid TEXT, t_invalid TEXT,
           last_access TEXT, access_count INTEGER DEFAULT 0,
           t_updated TEXT
         )`,
      );
      raw.close();

      const db = await openDb(dbPath);
      const cols = (raw(db).prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('enrich_ver');
      expect(cols).toContain('embed_model');
      db.close();

      // Idempotent: re-opening does not duplicate or error
      const db2 = await openDb(dbPath);
      const cols2 = (raw(db2).prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      for (const col of ['enrich_ver', 'embed_model']) {
        expect(cols2.filter((c) => c === col)).toHaveLength(1);
      }
      db2.close();
    } finally { cleanup(); }
  });

  it('partial pre-existing columns are migrated safely (some missing, some present)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const dbPath = path.join(dir, 'partial.db');
      const raw = new Database(dbPath);
      // Simulate a store that already has most base columns but is missing
      // memory-specific columns (enrich_ver, embed_model).
      raw.exec(
        `CREATE TABLE node (
           rowid INTEGER PRIMARY KEY, uid TEXT UNIQUE NOT NULL,
           kind TEXT NOT NULL CHECK (kind IN ('episode','entity','claim','community','session','generic')),
           content TEXT, name TEXT, summary TEXT,
           meta TEXT, topic TEXT, tags TEXT, project_path TEXT,
           namespace TEXT DEFAULT 'global', t_expires TEXT,
           is_superseded INTEGER DEFAULT 0, t_updated TEXT,
           agent_id TEXT, session_id TEXT, source TEXT,
           importance REAL DEFAULT 1.0, confidence REAL, content_hash TEXT,
           level INTEGER, resume_state TEXT,
           t_created TEXT NOT NULL, t_occurred TEXT, t_valid TEXT, t_invalid TEXT,
           last_access TEXT, access_count INTEGER DEFAULT 0
         )`,
      );
      raw.close();

      // Most columns already exist — openDb must add enrich_ver and embed_model without error
      const db = await openDb(dbPath);
      const cols = (raw(db).prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('enrich_ver');
      expect(cols).toContain('embed_model');
      db.close();
    } finally { cleanup(); }
  });
});

describe('openDb — memory-specific column migration', () => {
  it('a fresh store has embed_model', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 'fresh.db'));
      const cols = (raw(db).prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('embed_model');
      expect(cols).toContain('enrich_ver');
      db.close();
    } finally {
      cleanup();
    }
  });

  it('adds embed_model to a pre-existing store that lacks it (idempotent migration)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const dbPath = path.join(dir, 'old.db');
      // Simulate an older store: a node table without the memory-specific columns
      // (embed_model, enrich_ver). All canonical graph-store columns are included
      // so the canonical DDL's CREATE INDEX statements do not fail.
      const raw = new Database(dbPath);
      raw.exec(
        `CREATE TABLE node (
           rowid INTEGER PRIMARY KEY, uid TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
           content TEXT, name TEXT, summary TEXT,
           meta TEXT, topic TEXT, tags TEXT, project_path TEXT,
           agent_id TEXT, session_id TEXT, source TEXT,
           importance REAL DEFAULT 1.0, confidence REAL, content_hash TEXT,
           level INTEGER, resume_state TEXT,
           namespace TEXT DEFAULT 'global',
           t_expires TEXT, is_superseded INTEGER DEFAULT 0,
           t_created TEXT NOT NULL, t_occurred TEXT, t_valid TEXT, t_invalid TEXT,
           last_access TEXT, access_count INTEGER DEFAULT 0,
           t_updated TEXT
         )`,
      );
      raw.close();

      // openDb must migrate in place.
      const db = await openDb(dbPath);
      const cols = (raw(db).prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('embed_model');
      expect(cols).toContain('enrich_ver');
      db.close();

      // Idempotent: re-opening doesn't error or duplicate.
      const db2 = await openDb(dbPath);
      const cols2 = (raw(db2).prepare('PRAGMA table_info(node)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols2.filter((c) => c === 'embed_model')).toHaveLength(1);
      db2.close();
    } finally {
      cleanup();
    }
  });
});
