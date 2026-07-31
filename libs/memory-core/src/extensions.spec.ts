/**
 * extensions.spec.ts — B2/B3 memory-core function tests.
 *
 * One happy-path test per new function using a seeded in-memory database.
 * Tests that each function returns the expected shape without throwing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
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

/**
 * BL-325: openDb() returns a StoreAdapter, not a raw better-sqlite3 handle.
 * These specs' own verification reads use raw SQL against the sqlite backend,
 * so unwrap once here rather than rewriting every assertion.
 */
function raw(a: StoreAdapter): Database.Database {
  return a.unwrap() as Database.Database;
}

// Mock embed to avoid real ONNX model download (these tests assert extension function shapes, not embedding quality)

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-spec-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function createDb(dbPath: string): Promise<StoreAdapter> {
  return await openDb(dbPath);
}

async function seedEpisode(
  db: StoreAdapter,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const uid = `ep-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const content = (overrides['content'] as string) ?? 'Test episode content for B2/B3 testing.';
  const topic = (overrides['topic'] as string) ?? 'test-topic';
  const projectPath = (overrides['project_path'] as string) ?? '/test/project';
  const tags = (overrides['tags'] as string[]) ?? ['test', 'example'];
  await db.executeRun(`INSERT INTO node (uid, kind, content, topic, project_path, tags, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, ?, ?, ?, ?)`, [uid, content, topic, projectPath, JSON.stringify(tags), now, now]);
  return uid;
}

async function seedEntity(db: StoreAdapter, name: string): Promise<string> {
  const uid = `entity-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db.executeRun(`INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'entity', ?, ?, ?)`, [uid, name, new Date().toISOString(), new Date().toISOString()]);
  return uid;
}

async function seedEdge(db: StoreAdapter, srcRowid: number, dstRowid: number, rel: string): Promise<void> {
  await db.executeRun(`INSERT INTO edge (src, dst, rel, origin, t_created)
     VALUES (?, ?, ?, 'user_asserted', ?)`, [srcRowid, dstRowid, rel, new Date().toISOString()]);
}

async function rowidForUid(db: StoreAdapter, uid: string): Promise<number> {
  return (await db.executeGet(`SELECT rowid FROM node WHERE uid = ?`, [uid]) as { rowid: number }).rowid;
}

// ── memoryLinkNode ─────────────────────────────────────────────────────────

describe('memoryLinkNode (B2)', () => {
  it('creates an edge between two existing nodes', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await createDb(path.join(dir, 't.db'));
      const uidA = await seedEpisode(await db);
      const uidB = await seedEpisode(await db);

      const result = await memoryLinkNode(await db, {
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
      const db = await createDb(path.join(dir, 't.db'));
      const uidA = await seedEpisode(await db);
      const uidB = await seedEpisode(await db);

      const result = await memoryLinkNode(await db, {
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
      const db = await createDb(path.join(dir, 't.db'));
      const uidA = await seedEpisode(await db);
      const uidB = await seedEpisode(await db);
      seedEdge(await db, await rowidForUid(await db, uidA), await rowidForUid(await db, uidB), 'RELATES_TO');

      const result = await memoryGetRelated(await db, { uid: uidA });

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
      const db = await createDb(path.join(dir, 't.db'));
      const epUid = await seedEpisode(await db);
      const entityUid = seedEntity(await db, 'test-entity');
      seedEdge(await db, await rowidForUid(await db, epUid), await rowidForUid(await db, await entityUid), 'MENTIONS');

      const result = await memoryGetEntityEpisodes(await db, { entity_uid: entityUid });

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
      const db = await createDb(path.join(dir, 't.db'));
      const epUid = await seedEpisode(await db);
      const entityUid = seedEntity(await db, 'ranked-entity');
      seedEdge(await db, await rowidForUid(await db, epUid), await rowidForUid(await db, await entityUid), 'MENTIONS');

      const result = await memoryListEntities(await db, {});

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
      const db = await createDb(path.join(dir, 't.db'));
      const uidA = await seedEpisode(await db);
      const uidB = await seedEpisode(await db);
      seedEdge(await db, await rowidForUid(await db, uidA), await rowidForUid(await db, uidB), 'SAME_AS');

      const result = await memoryGetNearDuplicates(await db, {});

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
      const db = await createDb(path.join(dir, 't.db'));
      const uidA = await seedEpisode(await db);

      const result = await memoryGetSupersessionChain(await db, { uid: uidA });

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
      const db = await createDb(path.join(dir, 't.db'));
      const sessionId = 'test-session-1';
      const state = { foo: 'bar', count: 42 };

      const saveResult = await memorySaveSessionState(await db, {
        session_id: sessionId,
        state,
      });
      expect(saveResult.ok).toBe(true);

      const getResult = await memoryGetSessionState(await db, { session_id: sessionId });
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
      const db = await createDb(path.join(dir, 't.db'));
      await seedEpisode(await db, { topic: 'alpha' });
      await seedEpisode(await db, { topic: 'alpha' });
      await seedEpisode(await db, { topic: 'beta' });

      const result = await memoryListTopics(await db, {});

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
      const db = await createDb(path.join(dir, 't.db'));
      await seedEpisode(await db, { project_path: '/project/a' });
      await seedEpisode(await db, { project_path: '/project/a' });
      await seedEpisode(await db, { project_path: '/project/b' });

      const result = await memoryListProjects(await db, {});

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
      const db = await createDb(path.join(dir, 't.db'));
      const epUid = await seedEpisode(await db, { tags: ['existing'] });

      const result = await memoryCurate(await db, {
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
      const db = await createDb(path.join(dir, 't.db'));
      const epUid = await seedEpisode(await db, { topic: 'old' });

      const result = await memoryCurate(await db, {
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
      const db = await createDb(path.join(dir, 't.db'));
      await seedEpisode(await db, { topic: 't1' });
      await seedEpisode(await db, { topic: 't2' });

      const result = await memoryGetStats(await db, {}, ['memory_ping', 'memory_write']);

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

// ── memoryCurate drop-episodes ──────────────────────────────────────────────

describe('memoryCurate drop-episodes (B2)', () => {
  it('hard-deletes a single live episode', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await createDb(path.join(dir, 't.db'));
      const uid = await seedEpisode(await db, { content: 'unique drop me' });

      // Verify the node exists before deletion
      const before = await await db.executeGet('SELECT COUNT(*) AS c FROM node WHERE uid = ?', [uid]) as { c: number };
      expect(before.c).toBe(1);

      const result = await memoryCurate(await db, { op: 'drop-episodes', uids: [uid] });

      expect(result).toEqual({
        op: 'drop-episodes',
        deleted: 1,
        cascaded: { vec_node: 0, edges: 0 },
      });

      // Verify the node is gone
      const after = await await db.executeGet('SELECT COUNT(*) AS c FROM node WHERE uid = ?', [uid]) as { c: number };
      expect(after.c).toBe(0);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('cascades to vec_node and edge rows', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await createDb(path.join(dir, 't.db'));

      // Seed two episodes and an edge between them
      const uidA = await seedEpisode(await db, { content: 'ep A' });
      const uidB = await seedEpisode(await db, { content: 'ep B' });
      const rowidA = rowidForUid(await db, uidA);
      const rowidB = rowidForUid(await db, uidB);

      // Insert a vec_node row for uidA
      await await db.executeRun('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)', [rowidA, JSON.stringify(new Array(768).fill(0.1))]);
      // Insert a MENTIONS edge from uidA to uidB (entity relationship)
      await await db.executeRun("INSERT INTO edge (src, dst, rel, origin, t_created) VALUES (?, ?, 'RELATES_TO', 'user_asserted', ?)", [rowidA, rowidB, new Date().toISOString()]);

      const result = await memoryCurate(await db, { op: 'drop-episodes', uids: [uidA] });

      expect(result.op).toBe('drop-episodes');
      expect(result.deleted).toBe(1);
      expect(result.cascaded.vec_node).toBe(1);
      expect(result.cascaded.edges).toBe(1);

      // Verify uidA is gone, uidB still exists
      const nodeA = await await db.executeGet('SELECT COUNT(*) AS c FROM node WHERE uid = ?', [uidA]) as { c: number };
      expect(nodeA.c).toBe(0);
      const nodeB = await await db.executeGet('SELECT COUNT(*) AS c FROM node WHERE uid = ?', [uidB]) as { c: number };
      expect(nodeB.c).toBe(1);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('silently skips non-existent and invalidated UIDs', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await createDb(path.join(dir, 't.db'));
      const liveUid = await seedEpisode(await db, { content: 'live one' });
      const invalidatedUid = await seedEpisode(await db, { content: 'invalidated one' });
      // Invalidate the second one
      await await db.executeRun('UPDATE node SET t_invalid = ? WHERE uid = ?', [new Date().toISOString(), invalidatedUid]);
      const fakeUid = 'nonexistent-uid-0000';

      const result = await memoryCurate(await db, {
        op: 'drop-episodes',
        uids: [fakeUid, invalidatedUid, liveUid],
      });

      // Only the live one should be deleted
      expect(result.op).toBe('drop-episodes');
      expect(result.deleted).toBe(1);
      expect(result.cascaded.vec_node).toBe(0);
      expect(result.cascaded.edges).toBe(0);

      // liveUid is gone
      const liveCheck = await await db.executeGet('SELECT COUNT(*) AS c FROM node WHERE uid = ?', [liveUid]) as { c: number };
      expect(liveCheck.c).toBe(0);
      // invalidatedUid still exists (was already t_invalid, not live)
      const invCheck = await await db.executeGet('SELECT COUNT(*) AS c FROM node WHERE uid = ?', [invalidatedUid]) as { c: number };
      expect(invCheck.c).toBe(1);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('returns zero counts when no UIDs match', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await createDb(path.join(dir, 't.db'));

      const result = await memoryCurate(await db, {
        op: 'drop-episodes',
        uids: ['nonexistent-uid'],
      });

      expect(result.op).toBe('drop-episodes');
      expect(result.deleted).toBe(0);
      expect(result.cascaded.vec_node).toBe(0);
      expect(result.cascaded.edges).toBe(0);
      db.close();
    } finally {
      cleanup();
    }
  });

  it('returns E_MISSING error when uids is empty or missing', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await createDb(path.join(dir, 't.db'));

      const result = await memoryCurate(await db, { op: 'drop-episodes', uids: [] });

      expect(result).toHaveProperty('code', 'E_MISSING');
      db.close();
    } finally {
      cleanup();
    }
  });
});
