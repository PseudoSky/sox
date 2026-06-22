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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { exportMarkdown } from './export.js';
import type { ExportOpts } from './export.js';

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

// Force hash backend for deterministic, fast tests (no ONNX download)
beforeEach(() => {
  process.env['SOX_EMBED_BACKEND'] = 'hash';
});

afterEach(() => {
  delete process.env['SOX_EMBED_BACKEND'];
});

// ── 1. Basic export ───────────────────────────────────────────────────────────

describe('exportMarkdown — basic', () => {
  it('writes episode files at topics/<slug>/<uid>.md', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const db = openDb(path.join(dbDir, 'test.db'));

      const w1 = await memoryWrite(db, {
        content: 'The sky is blue and vast.',
        tags: ['sky', 'nature'],
        agent_id: 'test-agent',
        source: 'observation',
        importance: 2.5,
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
      const db = openDb(path.join(dbDir, 'test.db'));

      await memoryWrite(db, {
        content: 'Event sourcing is a pattern for durable state.',
        tags: ['event-sourcing', 'patterns'],
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
      const db = openDb(path.join(dbDir, 'test.db'));

      await memoryWrite(db, { content: 'First memory.', tags: ['alpha'] });
      await memoryWrite(db, { content: 'Second memory.', tags: ['beta'] });

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
      const db = openDb(path.join(dbDir, 'test.db'));

      await memoryWrite(db, { content: 'Low importance.', tags: ['topic-x'], importance: 1.0 });
      await memoryWrite(db, { content: 'High importance.', tags: ['topic-x'], importance: 9.0 });

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
      const db = openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, { content: 'Idempotent memory.', tags: ['idempotency'] });
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
      const db = openDb(path.join(dbDir, 'test.db'));

      // Write two episodes
      const w1 = await memoryWrite(db, { content: 'Ephemeral memory.', tags: ['prune-test'] });
      const w2 = await memoryWrite(db, { content: 'Keeper memory.', tags: ['prune-test'] });

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
      db.prepare('UPDATE node SET t_invalid = ? WHERE uid = ?').run(
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
      const db = openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, { content: '[topic-a] Original content.' });
      const uid = (w as { episode_uid: string }).episode_uid;

      exportMarkdown(db, { dir: exportDir, enabled: true });
      expect(fs.existsSync(path.join(exportDir, 'topics', 'topic-a', `${uid}.md`))).toBe(true);

      // Re-categorise the node by changing its [<topic>] prefix, then re-export.
      db.prepare('UPDATE node SET content = ? WHERE uid = ?').run('[topic-b] Original content.', uid);
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
      const db = openDb(path.join(dbDir, 'test.db'));

      await memoryWrite(db, { content: 'This should not be exported.', tags: ['test'] });

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
      const db = openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, { content: 'No tags here.' });
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
      const db = openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, {
        content: '[agent-graph-memory] Bi-temporal edges for fact supersession.',
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
      const db = openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, { content: 'Community-grouped memory.' });
      const uid = (w as { episode_uid: string }).episode_uid;

      // Manually insert a community node and MEMBER_OF edge
      const now = new Date().toISOString();
      const commUid = `community-test-${Date.now()}`;
      const commRow = db.prepare<unknown[], { rowid: number }>(
        `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'community', ?, ?, ?) RETURNING rowid`,
      ).get(commUid, 'Machine Learning', now, now) as { rowid: number };

      const epRow = db.prepare<[string], { rowid: number }>(
        `SELECT rowid FROM node WHERE uid = ?`,
      ).get(uid) as { rowid: number };

      db.prepare(
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
      const db = openDb(path.join(dbDir, 'test.db'));

      const w = await memoryWrite(db, {
        content: 'Rust memory safety model.',
        tags: ['rust'],
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

      const db = openDb(path.join(dbDir, 'test.db'));
      await memoryWrite(db, { content: 'A memory alongside principles.', tags: ['test'] });

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
