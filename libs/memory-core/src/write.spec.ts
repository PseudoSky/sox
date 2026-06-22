/**
 * write.spec.ts — memoryWrite persistence of client-supplied summary + metadata,
 * and the idempotent `node.meta` column migration (BL-23).
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

  it('leaves summary/meta null when not supplied (no regression)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = openDb(path.join(dir, 't.db'));
      const r = await memoryWrite(db, { content: 'Plain content, no extras.' });
      const uid = (r as { episode_uid: string }).episode_uid;
      const row = db
        .prepare<[string], { summary: string | null; meta: string | null }>(
          'SELECT summary, meta FROM node WHERE uid = ?',
        )
        .get(uid)!;
      expect(row.summary).toBeNull();
      expect(row.meta).toBeNull();
      db.close();
    } finally {
      cleanup();
    }
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
