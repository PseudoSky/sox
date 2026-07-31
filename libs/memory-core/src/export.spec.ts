/**
 * export.spec.ts — Tests for exportMarkdown (DB→markdown mirror).
 *
 * Covers:
 *   1. Basic export: episode files at topics/<slug>/<uid>.md with frontmatter + content.
 *   2. INDEX.md at root and per-topic are written and list nodes.
 *   3. Second run is idempotent (same files, no duplicates).
 *   4. Invalidated node's file is pruned on next run.
 *   5. enabled:false is a no-op (no files written).
 *   6. Topic derivation: community > entity > general fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type Database from 'better-sqlite3';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { exportMarkdown } from './export.js';
import type { ExportOpts } from './export.js';

/**
 * BL-325: openDb() returns a StoreAdapter, not a raw better-sqlite3 handle.
 * These specs' own verification reads use raw SQL against the sqlite backend,
 * so unwrap once here rather than rewriting every assertion.
 */
function raw(a: StoreAdapter): Database.Database {
  return a.unwrap() as Database.Database;
}


// Mock embed to avoid real ONNX model download (these tests assert export mechanics, not embedding quality)

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-export-test-'));
  return {
    dir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ── 1. Basic export ───────────────────────────────────────────────────────────

describe('exportMarkdown — basic', () => {
  it('writes episode files at topics/<slug>/<uid>.md', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      const w1 = await memoryWrite(db, {
        content: 'The sky is blue and vast.',
        tags: ['sky', 'nature'],
        agent_id: 'test-agent',
        source: 'observation',
        importance: 2.5,
        project_path: '/test/project',
      });

      const uid1 = (w1 as { episode_uid: string }).episode_uid;

      const result = exportMarkdown(db, { dir: exportDir, enabled: true });

      expect(result.nodesWritten).toBe(1);
      expect(result.topics).toBeGreaterThanOrEqual(1);
      expect(result.dir).toBe(exportDir);

      // Find the slug dir — it should map to the first tag "sky"
      const topicsDir = path.join(exportDir, 'topics');
      expect(fs.existsSync(topicsDir)).toBe(true);

      const slugDirs = fs.readdirSync(topicsDir);
      expect(slugDirs.length).toBe(1);

      const slugDir = path.join(topicsDir, slugDirs[0]!);
      const episodeFile = path.join(slugDir, `${uid1}.md`);
      expect(fs.existsSync(episodeFile)).toBe(true);

      const content = fs.readFileSync(episodeFile, 'utf8');
      expect(content).toContain('---');
      expect(content).toContain(`uid: ${uid1}`);
      expect(content).toContain('importance: 2.5');
      expect(content).toContain('agent_id: test-agent');
      expect(content).toContain('The sky is blue and vast.');

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('writes frontmatter with entity list', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      await memoryWrite(db, {
        content: 'Event sourcing is a pattern for durable state.',
        tags: ['event-sourcing', 'patterns'],
        project_path: '/test/project',
      });

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const topicsDir = path.join(exportDir, 'topics');
      const slugDirs = fs.readdirSync(topicsDir);
      const episodeFiles = fs.readdirSync(path.join(topicsDir, slugDirs[0]!))
        .filter((f) => f.endsWith('.md') && f !== 'INDEX.md');
      expect(episodeFiles.length).toBe(1);

      const content = fs.readFileSync(path.join(topicsDir, slugDirs[0]!, episodeFiles[0]!), 'utf8');
      // frontmatter entities block should exist
      expect(content).toContain('entities:');

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});

// ── 2. INDEX.md files ─────────────────────────────────────────────────────────

describe('exportMarkdown — INDEX.md', () => {
  it('writes root INDEX.md listing topics with node counts', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      await memoryWrite(db, { content: 'First memory.', tags: ['alpha'], project_path: '/test/project' });
      await memoryWrite(db, { content: 'Second memory.', tags: ['beta'], project_path: '/test/project' });

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const indexPath = path.join(exportDir, 'INDEX.md');
      expect(fs.existsSync(indexPath)).toBe(true);

      const content = fs.readFileSync(indexPath, 'utf8');
      expect(content).toContain('Memory Export Index');
      expect(content).toContain('**Total episodes:** 2');
      expect(content).toContain('generated by sox-memory export');

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('writes per-topic INDEX.md listing nodes sorted by importance', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      await memoryWrite(db, { content: 'Low importance.', tags: ['topic-x'], importance: 1.0, project_path: '/test/project' });
      await memoryWrite(db, { content: 'High importance.', tags: ['topic-x'], importance: 9.0, project_path: '/test/project' });

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const topicsDir = path.join(exportDir, 'topics');
      const slugDirs = fs.readdirSync(topicsDir);
      // Both use the same tag so should land in the same topic dir
      expect(slugDirs.length).toBe(1);

      const topicIndexPath = path.join(topicsDir, slugDirs[0]!, 'INDEX.md');
      expect(fs.existsSync(topicIndexPath)).toBe(true);

      const content = fs.readFileSync(topicIndexPath, 'utf8');
      expect(content).toContain('Topic:');
      // High importance should appear before low importance
      const highIdx = content.indexOf('9.0');
      const lowIdx = content.indexOf('1.0');
      expect(highIdx).toBeLessThan(lowIdx);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});

// ── 3. Idempotency ────────────────────────────────────────────────────────────

describe('exportMarkdown — idempotency', () => {
  it('second run produces identical output (overwrite, no duplicates)', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, { content: 'Idempotent memory.', tags: ['idempotency'], project_path: '/test/project' });
      const uid = (w as { episode_uid: string }).episode_uid;

      exportMarkdown(db, { dir: exportDir, enabled: true });
      const r2 = exportMarkdown(db, { dir: exportDir, enabled: true });

      expect(r2.nodesWritten).toBe(1);
      expect(r2.topics).toBe(1);

      const topicsDir = path.join(exportDir, 'topics');
      const slugDirs = fs.readdirSync(topicsDir);
      const episodeFiles = fs.readdirSync(path.join(topicsDir, slugDirs[0]!))
        .filter((f) => f.endsWith('.md') && f !== 'INDEX.md');

      // Still exactly one episode file, not doubled
      expect(episodeFiles).toEqual([`${uid}.md`]);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});

// ── 4. Pruning invalidated nodes ──────────────────────────────────────────────

describe('exportMarkdown — pruning', () => {
  it('invalidated node file is removed on next export run', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      // Write two episodes
      const w1 = await memoryWrite(db, { content: 'Ephemeral memory.', tags: ['prune-test'], project_path: '/test/project' });
      const w2 = await memoryWrite(db, { content: 'Keeper memory.', tags: ['prune-test'], project_path: '/test/project' });

      const uid1 = (w1 as { episode_uid: string }).episode_uid;
      const uid2 = (w2 as { episode_uid: string }).episode_uid;

      // First export — both files exist
      exportMarkdown(db, { dir: exportDir, enabled: true });

      const topicsDir = path.join(exportDir, 'topics');
      const slugDirs = fs.readdirSync(topicsDir);
      const beforeFiles = fs.readdirSync(path.join(topicsDir, slugDirs[0]!))
        .filter((f) => f.endsWith('.md') && f !== 'INDEX.md');
      expect(beforeFiles).toContain(`${uid1}.md`);
      expect(beforeFiles).toContain(`${uid2}.md`);

      // Invalidate the first episode
      raw(db).prepare('UPDATE node SET t_invalid = ? WHERE uid = ?').run(
        new Date().toISOString(),
        uid1,
      );

      // Second export — pruned file should be gone
      exportMarkdown(db, { dir: exportDir, enabled: true });

      const afterFiles = fs.readdirSync(path.join(topicsDir, slugDirs[0]!))
        .filter((f) => f.endsWith('.md') && f !== 'INDEX.md');
      expect(afterFiles).not.toContain(`${uid1}.md`);
      expect(afterFiles).toContain(`${uid2}.md`);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('a node that changes topic is removed from its old topic dir (move-prune, BL-20)', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, { content: '[topic-a] Original content.', topic: 'topic-a', project_path: '/test/project' });
      const uid = (w as { episode_uid: string }).episode_uid;

      exportMarkdown(db, { dir: exportDir, enabled: true });
      expect(fs.existsSync(path.join(exportDir, 'topics', 'topic-a', `${uid}.md`))).toBe(true);

      // P5: re-categorise by updating the structured node.topic column (the authoritative field).
      // Content is also updated for consistency, but topic derivation now reads node.topic first.
      raw(db).prepare('UPDATE node SET topic = ?, content = ? WHERE uid = ?').run(
        'topic-b',
        '[topic-b] Original content.',
        uid,
      );
      exportMarkdown(db, { dir: exportDir, enabled: true });

      // The stale copy in the old topic must be pruned; the new topic must hold it.
      expect(fs.existsSync(path.join(exportDir, 'topics', 'topic-a', `${uid}.md`))).toBe(false);
      expect(fs.existsSync(path.join(exportDir, 'topics', 'topic-b', `${uid}.md`))).toBe(true);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});

// ── 5. enabled:false is a no-op ───────────────────────────────────────────────

describe('exportMarkdown — disabled', () => {
  it('returns zeros and writes nothing when enabled=false', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      await memoryWrite(db, { content: 'This should not be exported.', tags: ['test'], project_path: '/test/project' });

      const result = exportMarkdown(db, { dir: exportDir, enabled: false });

      expect(result.nodesWritten).toBe(0);
      expect(result.topics).toBe(0);
      // No files should have been written
      expect(fs.existsSync(path.join(exportDir, 'INDEX.md'))).toBe(false);
      expect(fs.existsSync(path.join(exportDir, 'topics'))).toBe(false);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});

// ── 6. Topic derivation ───────────────────────────────────────────────────────

describe('exportMarkdown — topic derivation', () => {
  it('episode with no tags falls into general topic', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, { content: 'No tags here.', project_path: '/test/project' });
      const uid = (w as { episode_uid: string }).episode_uid;

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const generalDir = path.join(exportDir, 'topics', 'general');
      expect(fs.existsSync(generalDir)).toBe(true);
      expect(fs.existsSync(path.join(generalDir, `${uid}.md`))).toBe(true);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('uses an explicit [<topic>] content prefix as the topic (BL-20)', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, {
        content: '[agent-graph-memory] Bi-temporal edges for fact supersession.',
        project_path: '/test/project',
      });
      const uid = (w as { episode_uid: string }).episode_uid;

      exportMarkdown(db, { dir: exportDir, enabled: true });

      // The bracketed prefix wins over the "general" fallback.
      expect(
        fs.existsSync(path.join(exportDir, 'topics', 'agent-graph-memory', `${uid}.md`)),
      ).toBe(true);
      expect(fs.existsSync(path.join(exportDir, 'topics', 'general', `${uid}.md`))).toBe(false);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('episode with community MEMBER_OF edge uses community as topic', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, { content: 'Community-grouped memory.', project_path: '/test/project' });
      const uid = (w as { episode_uid: string }).episode_uid;

      // Manually insert a community node and MEMBER_OF edge
      const now = new Date().toISOString();
      const commUid = `community-test-${Date.now()}`;
      const commRow = raw(db).prepare<unknown[], { rowid: number }>(
        `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'community', ?, ?, ?) RETURNING rowid`,
      ).get(commUid, 'Machine Learning', now, now) as { rowid: number };

      const epRow = raw(db).prepare<[string], { rowid: number }>(
        `SELECT rowid FROM node WHERE uid = ?`,
      ).get(uid) as { rowid: number };

      raw(db).prepare(
        `INSERT INTO edge (src, dst, rel, origin, t_created) VALUES (?, ?, 'MEMBER_OF', 'extracted', ?)`,
      ).run(epRow.rowid, commRow.rowid, now);

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const topicsDir = path.join(exportDir, 'topics');
      const slugDirs = fs.readdirSync(topicsDir);

      // Should have a slug derived from "Machine Learning"
      expect(slugDirs.some((s) => s.includes('machine') || s.includes('learning'))).toBe(true);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('episode with no community but with MENTIONS entity uses entity as topic', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, {
        content: 'Rust memory safety model.',
        tags: ['rust'],
        project_path: '/test/project',
      });
      const uid = (w as { episode_uid: string }).episode_uid;

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const topicsDir = path.join(exportDir, 'topics');
      const slugDirs = fs.readdirSync(topicsDir);

      // Should map to "rust" slug (from the tag/entity)
      expect(slugDirs).toContain('rust');
      expect(fs.existsSync(path.join(topicsDir, 'rust', `${uid}.md`))).toBe(true);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('pre-existing non-.md content in export dir is untouched', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      // Create a principles/ folder with a file in the export dir — should be untouched
      fs.mkdirSync(path.join(exportDir, 'principles'), { recursive: true });
      fs.writeFileSync(path.join(exportDir, 'principles', 'my-principle.md'), '# Principle\n', 'utf8');

      const db = await openDb(path.join(dbDir, 'test.db'));
      await memoryWrite(db, { content: 'A memory alongside principles.', tags: ['test'], project_path: '/test/project' });

      exportMarkdown(db, { dir: exportDir, enabled: true });

      // Principles folder must still exist and be untouched
      expect(fs.existsSync(path.join(exportDir, 'principles', 'my-principle.md'))).toBe(true);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});

// ── 7. P5 — structured node.topic wins over [<topic>] prefix (BL-22) ──────────

describe('exportMarkdown — P5 structured topic precedence', () => {
  it('structured node.topic column wins over [<topic>] prefix in content', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      // Explicit topic='structured-topic' + content has [prefix-topic] — structured wins.
      const w = await memoryWrite(db, {
        content: '[prefix-topic] Content with a conflicting text prefix.',
        topic: 'structured-topic',
        project_path: '/test/project',
      });
      const uid = (w as { episode_uid: string }).episode_uid;

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const topicsDir = path.join(exportDir, 'topics');
      // Must land in structured-topic slug, not prefix-topic slug.
      expect(fs.existsSync(path.join(topicsDir, 'structured-topic', `${uid}.md`))).toBe(true);
      expect(fs.existsSync(path.join(topicsDir, 'prefix-topic', `${uid}.md`))).toBe(false);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('[<topic>] prefix is used as fallback when node.topic column is null', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      // Write without explicit topic — prefix gets stored in node.topic by enrichOnWrite,
      // then NULL it out to simulate a legacy store where node.topic wasn't populated.
      const w = await memoryWrite(db, {
        content: '[fallback-prefix] Content using the legacy text prefix convention.',
        project_path: '/test/project',
      });
      const uid = (w as { episode_uid: string }).episode_uid;

      // Force node.topic to null to prove the fallback path in export.ts still works.
      raw(db).prepare('UPDATE node SET topic = NULL WHERE uid = ?').run(uid);

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const topicsDir = path.join(exportDir, 'topics');
      // With node.topic=null, the [<topic>] prefix must be used as fallback.
      expect(fs.existsSync(path.join(topicsDir, 'fallback-prefix', `${uid}.md`))).toBe(true);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('structured node.topic wins over MENTIONS entity fallback', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      // Write with an explicit topic and tags — structured topic must win, not entity name.
      const w = await memoryWrite(db, {
        content: 'Discussing TypeScript generics and mapped types.',
        topic: 'typescript-types',
        tags: ['generics', 'mapped-types'],
        project_path: '/test/project',
      });
      const uid = (w as { episode_uid: string }).episode_uid;

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const topicsDir = path.join(exportDir, 'topics');
      // Must use structured-topic slug, not entity slug.
      expect(fs.existsSync(path.join(topicsDir, 'typescript-types', `${uid}.md`))).toBe(true);
      expect(fs.existsSync(path.join(topicsDir, 'generics', `${uid}.md`))).toBe(false);
      expect(fs.existsSync(path.join(topicsDir, 'mapped-types', `${uid}.md`))).toBe(false);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});

// ── 8. P5 — entity names rendered, not UIDs (BL-22) ─────────────────────────

describe('exportMarkdown — P5 entity names in frontmatter (BL-22)', () => {
  it('entities frontmatter lists entity names, not UIDs', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      // Write with tags — these become entity nodes with MENTIONS edges.
      const w = await memoryWrite(db, {
        content: 'JWT and OAuth2 are authentication protocols.',
        tags: ['JWT', 'OAuth2'],
        project_path: '/test/project',
      });
      const uid = (w as { episode_uid: string }).episode_uid;

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const topicsDir = path.join(exportDir, 'topics');
      const slugDirs = fs.readdirSync(topicsDir);
      // Find the episode file (it'll be in the first tag's slug dir or structured-topic)
      let episodeContent: string | null = null;
      for (const slug of slugDirs) {
        const episodePath = path.join(topicsDir, slug, `${uid}.md`);
        if (fs.existsSync(episodePath)) {
          episodeContent = fs.readFileSync(episodePath, 'utf8');
          break;
        }
      }

      expect(episodeContent).not.toBeNull();
      // Entities should contain names, not UIDs (UIDs would be ULID-format like "01J...")
      expect(episodeContent).toContain('entities:');
      expect(episodeContent).toContain('JWT');
      expect(episodeContent).toContain('OAuth2');
      // UIDs are ULID format (26 uppercase base32 chars) — none should appear under entities:
      // We verify entity names appear and no ULID-like string is in the entities block.
      const entitiesSection = episodeContent!.match(/entities:\n([\s\S]*?)(?:\n\w|---)/)?.[1] ?? '';
      expect(entitiesSection).not.toMatch(/\b[0-9A-Z]{26}\b/); // no ULID UIDs

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('entities with null name are omitted from frontmatter', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, {
        content: 'Null-named entity test.',
        topic: 'test-topic',
        project_path: '/test/project',
      });
      const uid = (w as { episode_uid: string }).episode_uid;

      // Insert an entity with null name and a MENTIONS edge to the episode.
      const now = new Date().toISOString();
      const nullEntityUid = `entity-null-${Date.now()}`;
      const entityRow = raw(db).prepare<unknown[], { rowid: number }>(
        `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'entity', NULL, ?, ?) RETURNING rowid`,
      ).get(nullEntityUid, now, now) as { rowid: number };

      const epRow = raw(db).prepare<[string], { rowid: number }>(
        `SELECT rowid FROM node WHERE uid = ?`,
      ).get(uid) as { rowid: number };

      raw(db).prepare(
        `INSERT INTO edge (src, dst, rel, origin, t_created) VALUES (?, ?, 'MENTIONS', 'user_asserted', ?)`,
      ).run(epRow.rowid, entityRow.rowid, now);

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const episodePath = path.join(exportDir, 'topics', 'test-topic', `${uid}.md`);
      expect(fs.existsSync(episodePath)).toBe(true);
      const content = fs.readFileSync(episodePath, 'utf8');
      // The null-named entity should not appear in the entities list at all.
      expect(content).not.toContain(nullEntityUid);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});

// ── 9. P5 — structured summary / tags / project_path in frontmatter ───────────

describe('exportMarkdown — P5 structured provenance fields in frontmatter', () => {
  it('renders structured summary in frontmatter', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, {
        content: 'JWT tokens expire after one hour for security reasons.',
        topic: 'security',
        summary: 'JWT token expiry policy',
        project_path: '/test/project',
      });
      const uid = (w as { episode_uid: string }).episode_uid;

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const episodePath = path.join(exportDir, 'topics', 'security', `${uid}.md`);
      expect(fs.existsSync(episodePath)).toBe(true);
      const content = fs.readFileSync(episodePath, 'utf8');
      expect(content).toContain('summary: JWT token expiry policy');

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('renders structured project_path in frontmatter', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, {
        content: 'Nx build caching reduces CI time significantly.',
        topic: 'ci',
        project_path: '/projects/sox-ecosystem',
      });
      const uid = (w as { episode_uid: string }).episode_uid;

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const episodePath = path.join(exportDir, 'topics', 'ci', `${uid}.md`);
      expect(fs.existsSync(episodePath)).toBe(true);
      const content = fs.readFileSync(episodePath, 'utf8');
      expect(content).toContain('project_path');
      expect(content).toContain('/projects/sox-ecosystem');

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('renders structured tags in frontmatter', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, {
        content: 'SQLite WAL mode enables concurrent reads.',
        topic: 'database',
        tags: ['sqlite', 'wal', 'concurrency'],
        project_path: '/test/project',
      });
      const uid = (w as { episode_uid: string }).episode_uid;

      exportMarkdown(db, { dir: exportDir, enabled: true });

      const episodePath = path.join(exportDir, 'topics', 'database', `${uid}.md`);
      expect(fs.existsSync(episodePath)).toBe(true);
      const content = fs.readFileSync(episodePath, 'utf8');
      expect(content).toContain('tags:');
      expect(content).toContain('sqlite');
      expect(content).toContain('wal');
      expect(content).toContain('concurrency');

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('re-export is byte-identical for unchanged DB (idempotent with structured fields)', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = await openDb(path.join(dbDir, 'test.db'));

      await memoryWrite(db, {
        content: 'Idempotency with structured fields.',
        topic: 'idempotency',
        summary: 'Test for identical re-export',
        tags: ['test', 'idempotency'],
        project_path: '/projects/test',
      });

      exportMarkdown(db, { dir: exportDir, enabled: true });

      // Collect all file contents from first export
      const topicsDir = path.join(exportDir, 'topics');
      const slugDirs = fs.readdirSync(topicsDir);
      const firstContents = new Map<string, string>();
      for (const slug of slugDirs) {
        const slugPath = path.join(topicsDir, slug);
        for (const f of fs.readdirSync(slugPath)) {
          const fullPath = path.join(slugPath, f);
          firstContents.set(fullPath, fs.readFileSync(fullPath, 'utf8'));
        }
      }
      const rootIndex = fs.readFileSync(path.join(exportDir, 'INDEX.md'), 'utf8');

      // Second run — must produce identical content for all episode files.
      // (Timestamps in INDEX.md may differ by sub-second; only check episode files)
      exportMarkdown(db, { dir: exportDir, enabled: true });

      for (const [p, originalContent] of firstContents) {
        if (p.endsWith('INDEX.md')) continue; // INDEX.md has a generation timestamp
        const secondContent = fs.readFileSync(p, 'utf8');
        expect(secondContent).toBe(originalContent);
      }
      // Root index must still be identical (same episodes list)
      // — we only check that its structure is the same, not the timestamp line
      const rootIndex2 = fs.readFileSync(path.join(exportDir, 'INDEX.md'), 'utf8');
      expect(rootIndex2).toContain('Memory Export Index');
      // The episode count must be the same
      const countMatch1 = rootIndex.match(/Total episodes:\*\* (\d+)/);
      const countMatch2 = rootIndex2.match(/Total episodes:\*\* (\d+)/);
      expect(countMatch2?.[1]).toBe(countMatch1?.[1]);

      db.close();
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});
