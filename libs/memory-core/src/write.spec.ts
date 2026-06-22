/**
 * write.spec.ts — memoryWrite persistence of client-supplied summary + metadata,
 * and the idempotent `node.meta` column migration (BL-23).
 * P1 enrichment fields: topic, tags, project_path, enrich_ver columns (BL-24 / D3.1).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';

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
