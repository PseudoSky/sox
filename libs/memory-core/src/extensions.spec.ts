/**
 * extensions.spec.ts — B2/B3 memory-core function tests.
 *
 * One happy-path test per new function using a seeded in-memory database.
 * Tests that each function returns the expected shape without throwing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import { memoryLinkNode } from './link.js';
import { memoryGetRelated } from './related.js';
import { memoryGetEntityEpisodes } from './entity-episodes.js';
import { memoryListEntities } from './list-entities.js';
import { memoryGetNearDuplicates } from './near-duplicates.js';
import { memoryGetSupersessionChain } from './supersession-chain.js';
import { memoryGetSessionState, memorySaveSessionState } from './session.js';
import { memoryListTopics } from './topics.js';
import { memoryListProjects } from './projects.js';
import { memoryCurate } from './curate.js';
import { memoryGetStats } from './stats.js';

beforeAll(() => { process.env['SOX_EMBED_BACKEND'] = 'hash'; });
afterAll(() => { delete process.env['SOX_EMBED_BACKEND']; });

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-spec-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function createDb(dbPath: string): Database.Database {
  return openDb(dbPath);
}

function seedEpisode(
  db: Database.Database,
  overrides: Record<string, unknown> = {},
): string {
  const uid = `ep-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const content = (overrides['content'] as string) ?? 'Test episode content for B2/B3 testing.';
  const topic = (overrides['topic'] as string) ?? 'test-topic';
  const projectPath = (overrides['project_path'] as string) ?? '/test/project';
  const tags = (overrides['tags'] as string[]) ?? ['test', 'example'];
  db.prepare(
    `INSERT INTO node (uid, kind, content, topic, project_path, tags, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, ?, ?, ?, ?)`,
  ).run(uid, content, topic, projectPath, JSON.stringify(tags), now, now);
  return uid;
}

function seedEntity(db: Database.Database, name: string): string {
  const uid = `entity-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'entity', ?, ?, ?)`,
  ).run(uid, name, new Date().toISOString(), new Date().toISOString());
  return uid;
}

function seedEdge(db: Database.Database, srcRowid: number, dstRowid: number, rel: string): void {
  db.prepare(
    `INSERT INTO edge (src, dst, rel, origin, t_created)
     VALUES (?, ?, ?, 'user_asserted', ?)`,
  ).run(srcRowid, dstRowid, rel, new Date().toISOString());
}

function rowidForUid(db: Database.Database, uid: string): number {
  return (db.prepare(`SELECT rowid FROM node WHERE uid = ?`).get(uid) as { rowid: number }).rowid;
}

// ── memoryLinkNode ─────────────────────────────────────────────────────────

describe('memoryLinkNode (B2)', () => {
  it('creates an edge between two existing nodes', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = createDb(path.join(dir, 't.db'));
      const uidA = await seedEpisode(db);
      const uidB = await seedEpisode(db);

      const result = await memoryLinkNode(db, {
        src_uid: uidA,
        dst_uid: uidB,
        rel: 'RELATES_TO',
      });

      expect(result.isError).toBeUndefined();
      expect(typeof result.edge_uid).toBe('string');
      db.close();
    } finally {
      cleanup();
    }
  });

  it('returns error for unknown rel', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = createDb(path.join(dir, 't.db'));
      const uidA = await seedEpisode(db);
      const uidB = await seedEpisode(db);

      const result = await memoryLinkNode(db, {
        src_uid: uidA,
        dst_uid: uidB,
        rel: 'INVALID_REL',
      });

      expect(result.isError).toBe(true);
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── memoryGetRelated ───────────────────────────────────────────────────────

describe('memoryGetRelated (B2)', () => {
  it('returns related episodes via edges', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = createDb(path.join(dir, 't.db'));
      const uidA = await seedEpisode(db);
      const uidB = await seedEpisode(db);
      seedEdge(db, rowidForUid(db, uidA), rowidForUid(db, uidB), 'RELATES_TO');

      const result = await memoryGetRelated(db, { uid: uidA });

      expect(result.source_uid).toBe(uidA);
      expect(result.edges.length).toBeGreaterThanOrEqual(1);
      expect(result.edges[0]!.rel).toBe('RELATES_TO');
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── memoryGetEntityEpisodes ───────────────────────────────────────────────

describe('memoryGetEntityEpisodes (B2)', () => {
  it('returns episodes mentioning an entity', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = createDb(path.join(dir, 't.db'));
      const epUid = await seedEpisode(db);
      const entityUid = seedEntity(db, 'test-entity');
      seedEdge(db, rowidForUid(db, epUid), rowidForUid(db, entityUid), 'MENTIONS');

      const result = await memoryGetEntityEpisodes(db, { entity_uid: entityUid });

      expect(result.entity?.uid).toBe(entityUid);
      expect(result.episodes?.length).toBeGreaterThanOrEqual(1);
      expect(result.episodes![0]!.uid).toBe(epUid);
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── memoryListEntities ────────────────────────────────────────────────────

describe('memoryListEntities (B2)', () => {
  it('lists entities ranked by mention count', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = createDb(path.join(dir, 't.db'));
      const epUid = await seedEpisode(db);
      const entityUid = seedEntity(db, 'ranked-entity');
      seedEdge(db, rowidForUid(db, epUid), rowidForUid(db, entityUid), 'MENTIONS');

      const result = await memoryListEntities(db, {});

      expect(result.entities.length).toBeGreaterThanOrEqual(1);
      expect(result.entities[0]!.name).toBe('ranked-entity');
      expect(result.entities[0]!.mention_count).toBeGreaterThanOrEqual(1);
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── memoryGetNearDuplicates ───────────────────────────────────────────────

describe('memoryGetNearDuplicates (B2)', () => {
  it('lists SAME_AS edge pairs', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = createDb(path.join(dir, 't.db'));
      const uidA = await seedEpisode(db);
      const uidB = await seedEpisode(db);
      seedEdge(db, rowidForUid(db, uidA), rowidForUid(db, uidB), 'SAME_AS');

      const result = await memoryGetNearDuplicates(db, {});

      expect(result.pairs.length).toBeGreaterThanOrEqual(1);
      expect(result.pairs[0]!.uid_a).toBe(uidA);
      expect(result.pairs[0]!.uid_b).toBe(uidB);
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── memoryGetSupersessionChain ────────────────────────────────────────────

describe('memoryGetSupersessionChain (B2)', () => {
  it('returns chain with canonical uid', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = createDb(path.join(dir, 't.db'));
      const uidA = await seedEpisode(db);

      const result = await memoryGetSupersessionChain(db, { uid: uidA });

      expect(result.canonical_uid).toBe(uidA);
      expect(result.chain.length).toBeGreaterThanOrEqual(1);
      expect(typeof result.is_current).toBe('boolean');
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── memoryGetSessionState / memorySaveSessionState ───────────────────────

describe('memoryGetSessionState / memorySaveSessionState (B2)', () => {
  it('round-trips session state', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = createDb(path.join(dir, 't.db'));
      const sessionId = 'test-session-1';
      const state = { foo: 'bar', count: 42 };

      const saveResult = await memorySaveSessionState(db, {
        session_id: sessionId,
        state,
      });
      expect(saveResult.ok).toBe(true);

      const getResult = await memoryGetSessionState(db, { session_id: sessionId });
      expect(getResult.state).toEqual(state);
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── memoryListTopics ──────────────────────────────────────────────────────

describe('memoryListTopics (B3)', () => {
  it('lists topics with episode counts', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = createDb(path.join(dir, 't.db'));
      await seedEpisode(db, { topic: 'alpha' });
      await seedEpisode(db, { topic: 'alpha' });
      await seedEpisode(db, { topic: 'beta' });

      const result = memoryListTopics(db, {});

      expect(result.total).toBe(2);
      const alpha = result.topics.find((t) => t.topic === 'alpha');
      expect(alpha?.episode_count).toBe(2);
      const beta = result.topics.find((t) => t.topic === 'beta');
      expect(beta?.episode_count).toBe(1);
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── memoryListProjects ────────────────────────────────────────────────────

describe('memoryListProjects (B3)', () => {
  it('lists projects with episode counts', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = createDb(path.join(dir, 't.db'));
      await seedEpisode(db, { project_path: '/project/a' });
      await seedEpisode(db, { project_path: '/project/a' });
      await seedEpisode(db, { project_path: '/project/b' });

      const result = memoryListProjects(db, {});

      expect(result.total).toBe(2);
      const a = result.projects.find((p) => p.project_path === '/project/a');
      expect(a?.episode_count).toBe(2);
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── memoryCurate ──────────────────────────────────────────────────────────

describe('memoryCurate retag (B3)', () => {
  it('adds tags additively', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = createDb(path.join(dir, 't.db'));
      const epUid = await seedEpisode(db, { tags: ['existing'] });

      const result = await memoryCurate(db, {
        op: 'retag',
        uid: epUid,
        tags: ['new-tag'],
      });

      expect(result.op).toBe('retag');
      expect((result as { tags_added: string[] }).tags_added).toEqual(['new-tag']);
      db.close();
    } finally {
      cleanup();
    }
  });
});

describe('memoryCurate set_topic (B3)', () => {
  it('updates topic', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = createDb(path.join(dir, 't.db'));
      const epUid = await seedEpisode(db, { topic: 'old' });

      const result = await memoryCurate(db, {
        op: 'set_topic',
        uid: epUid,
        topic: 'new-topic',
      });

      expect(result.op).toBe('set_topic');
      expect((result as { old_topic: string | null }).old_topic).toBe('old');
      expect((result as { new_topic: string }).new_topic).toBe('new-topic');
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── memoryGetStats ────────────────────────────────────────────────────────

describe('memoryGetStats (B3)', () => {
  it('returns stats with coverage counts', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = createDb(path.join(dir, 't.db'));
      await seedEpisode(db, { topic: 't1' });
      await seedEpisode(db, { topic: 't2' });

      const result = await memoryGetStats(db, {}, ['memory_ping', 'memory_write']);

      expect(result.total_episodes).toBeGreaterThanOrEqual(2);
      expect(result.with_topic).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools).toContain('memory_ping');
      db.close();
    } finally {
      cleanup();
    }
  });
});
