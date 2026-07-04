import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { memoryRecall, ExpansionOverflowError } from './recall.js';
import { _shutdownEmbedWorker } from './embed.js';


afterAll(async () => {
  await _shutdownEmbedWorker();
});

// ── DB helpers ────────────────────────────────────────────────────────────────

function tmpDb(): { db: Database.Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-'));
  const db = openDb(path.join(dir, 'test.db'));
  return { db, dir };
}

function cleanup(db: Database.Database, dir: string): void {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('ExpansionOverflowError', () => {
  it('has correct name and properties', () => {
    const err = new ExpansionOverflowError('too much', 10000, 4096);
    expect(err.name).toBe('ExpansionOverflowError');
    expect(err.requestedTokens).toBe(10000);
    expect(err.maxTokens).toBe(4096);
    expect(err.message).toContain('too much');
  });
});

describe('ParentContextConfig', () => {
  it('has expected shape', () => {
    const config = {
      maxDepth: 1,
      maxContextTokens: 4096,
      joinStrategy: 'separator' as const,
      separator: '\n\n---\n\n',
      includeOriginal: true,
    };
    expect(config.maxDepth).toBe(1);
    expect(config.joinStrategy).toBe('separator');
  });
});

describe('LateChunkingConfig', () => {
  it('has expected shape', () => {
    const config = {
      enabled: true,
      boundaries: [{ startToken: 0, endToken: 100 }],
      overlapTokens: 0,
    };
    expect(config.enabled).toBe(true);
    expect(config.boundaries).toHaveLength(1);
  });
});

// ── Parent-context expansion: session_id fallback path ─────────────────────────

describe('Parent-context expansion — session_id fallback', () => {
  it('expands child node via session_id when no DERIVED_FROM edge exists', async () => {
    const { db, dir } = tmpDb();
    try {
      // 1. Create a parent node
      const parentResult = await memoryWrite(db, {
        content: 'Parent context document about machine learning algorithms',
        name: 'parent-doc',
      });
      expect(parentResult).toHaveProperty('episode_uid');
      const parentUid = (parentResult as { episode_uid: string }).episode_uid;

      // 2. Create a child node with session_id pointing to the parent's UID.
      //    Intentionally NO derived_from_uid — we must exercise the session_id fallback.
      const childResult = await memoryWrite(db, {
        content: 'Child chunk discussing transformer architectures',
        name: 'child-chunk',
        session_id: parentUid,
      });
      expect(childResult).toHaveProperty('episode_uid');
      const childUid = (childResult as { episode_uid: string }).episode_uid;

      // 3. Verify no DERIVED_FROM edge exists between child and parent.
      const edgeRow = db.prepare(
        `SELECT e.rowid FROM edge e
         JOIN node n_src ON n_src.rowid = e.src
         JOIN node n_dst ON n_dst.rowid = e.dst
         WHERE n_src.uid = ? AND n_dst.uid = ? AND e.rel = 'DERIVED_FROM' AND e.t_expired IS NULL`,
      ).get(childUid, parentUid);
      expect(edgeRow).toBeUndefined();

      // 4. Run recall with parent-context expansion.
      const response = await memoryRecall(db, 'project', {
        query: 'transformer architectures',
        parentContext: {
          maxDepth: 1,
          maxContextTokens: 10000,
          joinStrategy: 'contiguous',
        },
      });

      // 5. Find the child result entry.
      const childResultEntry = response.results.find(r => r.uid === childUid);
      expect(childResultEntry).toBeDefined();
      expect(childResultEntry!.expandedText).toBeTruthy();

      // 6. Verify expandedText includes both child content and parent content.
      expect(childResultEntry!.expandedText).toContain('transformer architectures');
      expect(childResultEntry!.expandedText).toContain('machine learning');

      // 7. Verify expansionSources has depth=0 (child) and depth=1 (parent).
      expect(childResultEntry!.expansionSources).toHaveLength(2);
      expect(childResultEntry!.expansionSources[0].depth).toBe(0);
      expect(childResultEntry!.expansionSources[0].chunk.uid).toBe(childUid);
      expect(childResultEntry!.expansionSources[1].depth).toBe(1);
      expect(childResultEntry!.expansionSources[1].chunk.uid).toBe(parentUid);
      expect(childResultEntry!.expansionSources[1].chunk.content).toContain('machine learning');
    } finally {
      cleanup(db, dir);
    }
  });
});
