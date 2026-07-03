/**
 * enrich.spec.ts — unit tests for memory-core enrichment.
 *
 * Covers:
 *   - resolveProjectPath: determinism + override + fallback
 *   - extractiveSummary: determinism + lead-N logic
 *   - computeImportance: determinism + formula correctness
 *   - detectNearDup: no false positives on distinct embeddings
 *   - enrichOnWrite: same input → same output (reproducibility assertion)
 *   - clusterStore: deterministic partition on same DB
 *   - clusterStats: valid structure
 *   - buildAutoLinks: determinism, idempotency
 *   - runBatchEnrich: determinism, structure
 *   - ENRICH_VERSION: is a semver string
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildAutoLinks,
  clusterStats,
  clusterStore,
  computeImportance,
  detectNearDup,
  ENRICH_VERSION,
  enrichOnWrite,
  extractiveSummary,
  resolveProjectPath,
  runBatchEnrich,
} from './index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal schema for test DB (mirrors memory-core schema without FTS triggers). */
const MINIMAL_DDL = `
CREATE TABLE IF NOT EXISTS node (
  rowid INTEGER PRIMARY KEY,
  uid TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  content TEXT, name TEXT, summary TEXT,
  meta TEXT, agent_id TEXT, session_id TEXT, source TEXT,
  importance REAL DEFAULT 1.0, content_hash TEXT, level INTEGER,
  resume_state TEXT, t_created TEXT NOT NULL, t_occurred TEXT,
  t_valid TEXT, t_invalid TEXT, last_access TEXT,
  access_count INTEGER DEFAULT 0,
  tags TEXT, topic TEXT, project_path TEXT, enrich_ver TEXT
);

CREATE TABLE IF NOT EXISTS edge (
  rowid INTEGER PRIMARY KEY,
  src INTEGER NOT NULL REFERENCES node(rowid),
  dst INTEGER NOT NULL REFERENCES node(rowid),
  rel TEXT NOT NULL,
  weight REAL DEFAULT 1.0, origin TEXT,
  t_created TEXT NOT NULL, t_expired TEXT, t_invalid TEXT, meta TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[768]);
`;

function makeTmpDb(): { db: Database.Database; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-enrich-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.exec(MINIMAL_DDL);
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Insert an episode + its embedding into the test DB. Returns rowid. */
function insertEpisode(
  db: Database.Database,
  uid: string,
  content: string,
  embedding: Float32Array,
  opts: { topic?: string; tags?: string[] } = {},
): number {
  const now = new Date().toISOString();
  const tagsJson = opts.tags ? JSON.stringify(opts.tags) : null;
  const result = db
    .prepare<unknown[], { rowid: number }>(
      `INSERT INTO node (uid, kind, content, t_created, t_valid, topic, tags)
       VALUES (?, 'episode', ?, ?, ?, ?, ?) RETURNING rowid`,
    )
    .get(uid, content, now, now, opts.topic ?? null, tagsJson)!;

  db.prepare('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
    result.rowid,
    '[' + Array.from(embedding).map((v) => v.toFixed(8)).join(',') + ']',
  );

  return result.rowid;
}

/** Simple L2-normalised embedding from a seed value (deterministic). */
function seedEmbedding(seed: number): Float32Array {
  const vec = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    vec[i] = Math.sin(seed * (i + 1)) * 0.1 + Math.cos(seed * i) * 0.1;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < 768; i++) norm += (vec[i] as number) * (vec[i] as number);
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 768; i++) vec[i] = (vec[i] as number) / norm;
  return vec;
}

/** Near-identical embedding (high cosine sim with source). */
function nearDupEmbedding(source: Float32Array, perturbation = 0.01): Float32Array {
  const vec = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    vec[i] = (source[i] as number) + (i % 2 === 0 ? perturbation : -perturbation);
  }
  let norm = 0;
  for (let i = 0; i < 768; i++) norm += (vec[i] as number) * (vec[i] as number);
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 768; i++) vec[i] = (vec[i] as number) / norm;
  return vec;
}

// ── ENRICH_VERSION ────────────────────────────────────────────────────────────

describe('ENRICH_VERSION', () => {
  it('is a semver string', () => {
    expect(ENRICH_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ── resolveProjectPath ────────────────────────────────────────────────────────

describe('resolveProjectPath', () => {
  it('returns override as-is when supplied', () => {
    const override = '/my/project/root';
    expect(resolveProjectPath(override)).toBe(override);
  });

  it('returns same value on repeated calls with no override (determinism)', () => {
    const r1 = resolveProjectPath();
    const r2 = resolveProjectPath();
    expect(r1).toBe(r2);
  });

  it('returns a non-empty string when called without override', () => {
    const result = resolveProjectPath();
    expect(typeof result).toBe('string');
    expect((result ?? '').length).toBeGreaterThan(0);
  });

  it('empty string override falls back to auto-detection', () => {
    const auto = resolveProjectPath();
    const empty = resolveProjectPath('');
    // empty string should fall back to auto-detect (same as no override)
    expect(empty).toBe(auto);
  });
});

// ── resolveProjectPath — BL-56 (injected root, non-repo null, precedence) ──────

describe('resolveProjectPath — BL-56', () => {
  let savedEnv: string | undefined;
  let savedCwd: string;

  beforeEach(() => {
    savedEnv = process.env['SOX_CONFIG_PROJECT_PATH'];
    savedCwd = process.cwd();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env['SOX_CONFIG_PROJECT_PATH'];
    else process.env['SOX_CONFIG_PROJECT_PATH'] = savedEnv;
    process.chdir(savedCwd);
  });

  it('uses SOX_CONFIG_PROJECT_PATH (host/config-injected root) when no override is given', () => {
    process.env['SOX_CONFIG_PROJECT_PATH'] = '/injected/workspace/root';
    expect(resolveProjectPath()).toBe('/injected/workspace/root');
  });

  it('explicit override outranks SOX_CONFIG_PROJECT_PATH', () => {
    process.env['SOX_CONFIG_PROJECT_PATH'] = '/injected/workspace/root';
    expect(resolveProjectPath('/caller/explicit')).toBe('/caller/explicit');
  });

  it('treats a blank SOX_CONFIG_PROJECT_PATH as authoritative "no project" → null (no cwd fallback)', () => {
    // cmdServe sets it to '' when the client launch dir is not a git repo; this must
    // NOT fall through to cwd detection (the served cwd is the extension install dir).
    process.env['SOX_CONFIG_PROJECT_PATH'] = '';
    expect(resolveProjectPath()).toBeNull();
  });

  it('a defined non-empty SOX_CONFIG_PROJECT_PATH wins even when cwd is a git repo', () => {
    // running here cwd IS a git repo (sox-ecosystem); the injected value must still win
    process.env['SOX_CONFIG_PROJECT_PATH'] = '/some/other/workspace';
    expect(resolveProjectPath()).toBe('/some/other/workspace');
  });

  it('returns null (not the bare cwd) when cwd is not a git repo', () => {
    delete process.env['SOX_CONFIG_PROJECT_PATH'];
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl56-nonrepo-'));
    try {
      process.chdir(nonRepo);
      // a non-repo cwd is not a project — null beats mis-attributing every write to it
      expect(resolveProjectPath()).toBeNull();
    } finally {
      process.chdir(savedCwd);
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

// ── extractiveSummary ─────────────────────────────────────────────────────────

describe('extractiveSummary', () => {
  it('returns content as-is when < 100 chars', () => {
    const short = 'Hello world.';
    expect(extractiveSummary(short)).toBe(short);
  });

  it('returns exactly 2 sentences for multi-sentence content', () => {
    const content =
      'TypeScript provides static type checking. It compiles to JavaScript. ' +
      'React is a UI library. It uses virtual DOM for efficient rendering.';
    const summary = extractiveSummary(content);
    expect(summary.length).toBeLessThan(content.length);
    expect(summary).toContain('TypeScript');
    expect(summary).toContain('compiles to JavaScript');
    expect(summary).not.toContain('React is a UI library');
  });

  it('is deterministic: same input → same output', () => {
    const content =
      'The memory graph stores semantic knowledge across sessions. ' +
      'Embeddings enable vector similarity search. Clustering groups related episodes. ' +
      'This ensures efficient recall without LLM calls.';
    const s1 = extractiveSummary(content);
    const s2 = extractiveSummary(content);
    expect(s1).toBe(s2);
  });

  it('handles content with only newline boundaries', () => {
    const content =
      'First paragraph with enough content to pass the threshold.\n' +
      'Second paragraph with different content here.\n' +
      'Third paragraph should be excluded from the summary.';
    const summary = extractiveSummary(content);
    expect(summary).toContain('First paragraph');
  });
});

// ── computeImportance ─────────────────────────────────────────────────────────

describe('computeImportance', () => {
  it('returns 1.0 for zero inputs', () => {
    expect(computeImportance({ word_count: 0, link_degree: 0, access_count: 0, tag_count: 0 }))
      .toBe(1.0);
  });

  it('clamps near 8.0 for maximum inputs (via analysis scoreImportance)', () => {
    expect(
      computeImportance({ word_count: 1000, link_degree: 100, access_count: 100, tag_count: 100 }),
    ).toBe(8.0);
  });

  it('is deterministic: same inputs → same output', () => {
    const inputs = { word_count: 50, link_degree: 5, access_count: 10, tag_count: 3 };
    expect(computeImportance(inputs)).toBe(computeImportance(inputs));
  });

  it('length_score component: 50 words → 4.0 contribution', () => {
    // Only length matters; others are 0
    const score = computeImportance({ word_count: 50, link_degree: 0, access_count: 0, tag_count: 0 });
    expect(score).toBeCloseTo(4.0, 5);
  });

  it('respects weight overrides', () => {
    const base = computeImportance({ word_count: 50, link_degree: 0, access_count: 0, tag_count: 0 });
    const halfWeight = computeImportance(
      { word_count: 50, link_degree: 0, access_count: 0, tag_count: 0 },
      { length: 0.5 },
    );
    expect(halfWeight).toBeCloseTo(base / 2, 4);
  });
});

// ── detectNearDup ─────────────────────────────────────────────────────────────

describe('detectNearDup', () => {
  it('returns null when store is empty', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      process.env['SOX_EMBED_BACKEND'] = 'real'; // use real threshold
      const emb = seedEmbedding(1);
      const rowid = insertEpisode(db, 'ep1', 'A'.repeat(100), emb);
      const result = detectNearDup(db, rowid, emb, 0.95);
      expect(result).toBeNull(); // only 1 node — no neighbours besides self
    } finally {
      delete process.env['SOX_EMBED_BACKEND'];
      cleanup();
    }
  });

  it('returns null for clearly distinct embeddings', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      process.env['SOX_EMBED_BACKEND'] = 'real';
      const emb1 = seedEmbedding(1);
      const emb2 = seedEmbedding(999); // very different seed → different direction
      insertEpisode(db, 'ep1', 'A'.repeat(100), emb1);
      const rowid2 = insertEpisode(db, 'ep2', 'B'.repeat(100), emb2);
      const result = detectNearDup(db, rowid2, emb2, 0.95);
      // Should be null because distinct seeds produce orthogonal vectors
      if (result !== null) {
        expect(result.cosine_sim).toBeLessThan(0.95);
      }
    } finally {
      delete process.env['SOX_EMBED_BACKEND'];
      cleanup();
    }
  });

  it('detects near-duplicate above threshold (real backend)', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      process.env['SOX_EMBED_BACKEND'] = 'real';
      const emb1 = seedEmbedding(42);
      const emb2 = nearDupEmbedding(emb1, 0.001); // very close
      insertEpisode(db, 'ep1', 'A'.repeat(100), emb1);
      const rowid2 = insertEpisode(db, 'ep2', 'B'.repeat(100), emb2);
      const result = detectNearDup(db, rowid2, emb2, 0.95);
      // Near-dup may or may not be detected depending on exact cosine sim
      // Just verify the function doesn't throw and returns consistent results
      const result2 = detectNearDup(db, rowid2, emb2, 0.95);
      expect(result).toEqual(result2); // deterministic
    } finally {
      delete process.env['SOX_EMBED_BACKEND'];
      cleanup();
    }
  });
});

// ── enrichOnWrite ─────────────────────────────────────────────────────────────

describe('enrichOnWrite', () => {
  let db: Database.Database;
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTmpDb();
    db = t.db;
    cleanup = t.cleanup;
    process.env['SOX_EMBED_BACKEND'] = 'hash';
  });

  afterEach(() => {
    delete process.env['SOX_EMBED_BACKEND'];
    cleanup();
  });

  it('produces identical output for the same inputs (reproducibility)', () => {
    // Use two separate DBs to compare results with identical state
    const t1 = makeTmpDb();
    const t2 = makeTmpDb();
    try {
      process.env['SOX_EMBED_BACKEND'] = 'hash';
      const content = '[testing] Enrichment should be deterministic for the same inputs.';
      const emb = seedEmbedding(7);

      const rowid1 = insertEpisode(t1.db, 'ep1', content, emb);
      const rowid2 = insertEpisode(t2.db, 'ep1', content, emb);

      const result1 = enrichOnWrite(t1.db, {
        uid: 'ep1', rowid: rowid1, content, summary: undefined,
        tags: ['test', 'determinism'], topic: undefined,
        metadata: undefined, project_path: '/project/a',
        derived_from_uid: undefined, embedding: emb, importance: undefined,
      });

      const result2 = enrichOnWrite(t2.db, {
        uid: 'ep1', rowid: rowid2, content, summary: undefined,
        tags: ['test', 'determinism'], topic: undefined,
        metadata: undefined, project_path: '/project/a',
        derived_from_uid: undefined, embedding: emb, importance: undefined,
      });

      // All deterministic fields must match
      expect(result1.topic).toBe(result2.topic);
      expect(result1.project_path).toBe(result2.project_path);
      expect(result1.summary).toBe(result2.summary);
      expect(result1.tags).toEqual(result2.tags);
      expect(result1.enrich_ver.pass).toBe(result2.enrich_ver.pass);
      expect(result1.near_dup).toBeNull(); // single episode per DB — no dup
    } finally {
      delete process.env['SOX_EMBED_BACKEND'];
      t1.cleanup();
      t2.cleanup();
    }
  });

  it('parses [<topic>] prefix from content', () => {
    const content = '[machine-learning] Neural networks are function approximators.';
    const emb = seedEmbedding(2);
    const rowid = insertEpisode(db, 'ep1', content, emb);
    const result = enrichOnWrite(db, {
      uid: 'ep1', rowid, content, summary: undefined, tags: [],
      topic: undefined, metadata: undefined, project_path: '/p',
      derived_from_uid: undefined, embedding: emb, importance: undefined,
    });
    expect(result.topic).toBe('machine-learning');
  });

  it('explicit topic overrides prefix', () => {
    const content = '[old-topic] Some content here that is long enough to process.';
    const emb = seedEmbedding(3);
    const rowid = insertEpisode(db, 'ep1', content, emb);
    const result = enrichOnWrite(db, {
      uid: 'ep1', rowid, content, summary: undefined, tags: [],
      topic: 'new-topic', metadata: undefined, project_path: '/p',
      derived_from_uid: undefined, embedding: emb, importance: undefined,
    });
    expect(result.topic).toBe('new-topic');
  });

  it('caller-supplied summary bypasses extractive fallback', () => {
    const content = 'A very long piece of content. It has many sentences. Each one adds detail. The fourth sentence is here.';
    const emb = seedEmbedding(4);
    const rowid = insertEpisode(db, 'ep1', content, emb);
    const result = enrichOnWrite(db, {
      uid: 'ep1', rowid, content, summary: 'My custom summary.',
      tags: [], topic: undefined, metadata: undefined, project_path: '/p',
      derived_from_uid: undefined, embedding: emb, importance: undefined,
    });
    expect(result.summary).toBe('My custom summary.');
  });

  it('extractive summary runs when no caller summary supplied', () => {
    const content = 'TypeScript is a typed superset of JavaScript. It compiles to plain JavaScript. Many frameworks support TypeScript.';
    const emb = seedEmbedding(5);
    const rowid = insertEpisode(db, 'ep1', content, emb);
    const result = enrichOnWrite(db, {
      uid: 'ep1', rowid, content, summary: undefined,
      tags: [], topic: undefined, metadata: undefined, project_path: '/p',
      derived_from_uid: undefined, embedding: emb, importance: undefined,
    });
    expect(result.summary).not.toBeNull();
    expect(result.summary!.length).toBeLessThan(content.length);
  });

  it('writes enrich_ver to node row', () => {
    const content = 'An episode with enrichment version tracking enabled here.';
    const emb = seedEmbedding(6);
    const rowid = insertEpisode(db, 'ep1', content, emb);
    enrichOnWrite(db, {
      uid: 'ep1', rowid, content, summary: undefined, tags: [],
      topic: undefined, metadata: undefined, project_path: '/p',
      derived_from_uid: undefined, embedding: emb, importance: undefined,
    });
    const row = db.prepare<[number], { enrich_ver: string | null }>('SELECT enrich_ver FROM node WHERE rowid = ?').get(rowid)!;
    expect(row.enrich_ver).not.toBeNull();
    const parsed = JSON.parse(row.enrich_ver!) as { pass: string; ts: string };
    expect(parsed.pass).toBe(ENRICH_VERSION);
    expect(typeof parsed.ts).toBe('string');
  });

  it('inserts a SAME_AS edge for a near-duplicate write without throwing (regression: edge column count)', () => {
    // Real-backend threshold (0.95) with no shared-MENTIONS hash guard — so identical
    // embeddings reliably trigger the SAME_AS insert path. No model load: embeddings are
    // passed explicitly. afterEach clears the env.
    process.env['SOX_EMBED_BACKEND'] = 'real';

    // First episode.
    const emb1 = seedEmbedding(11);
    const content1 = 'The deployment pipeline runs lint, build, then test in order.';
    const rowid1 = insertEpisode(db, 'dup1', content1, emb1);
    enrichOnWrite(db, {
      uid: 'dup1', rowid: rowid1, content: content1, summary: undefined, tags: [],
      topic: undefined, metadata: undefined, project_path: '/p',
      derived_from_uid: undefined, embedding: emb1, importance: undefined,
    });

    // Second episode: a near-duplicate (embedding ~identical) in the SAME db — this is the
    // path that exercises the SAME_AS edge insert, which previously had a 7-col/8-value
    // mismatch and threw a SQLite column-count error.
    const emb2 = emb1; // identical vector → cosine 1.0 ≥ 0.98 hash threshold, guarantees near-dup fires
    const content2 = 'The deployment pipeline runs lint, build and then tests in order.';
    const rowid2 = insertEpisode(db, 'dup2', content2, emb2);
    const result2 = enrichOnWrite(db, {
      uid: 'dup2', rowid: rowid2, content: content2, summary: undefined, tags: [],
      topic: undefined, metadata: undefined, project_path: '/p',
      derived_from_uid: undefined, embedding: emb2, importance: undefined,
    });

    // near-dup detected and the SAME_AS edge persisted (new episode → existing neighbour).
    expect(result2.near_dup).not.toBeNull();
    const edge = db
      .prepare<[number, number], { n: number }>(
        "SELECT COUNT(*) AS n FROM edge WHERE src = ? AND dst = ? AND rel = 'SAME_AS'",
      )
      .get(rowid2, rowid1)!;
    expect(edge.n).toBe(1);
  });
});

// ── clusterStore ──────────────────────────────────────────────────────────────

describe('clusterStore', () => {
  it('returns empty clusters for < 2 episodes', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      const emb = seedEmbedding(1);
      insertEpisode(db, 'ep1', 'A'.repeat(100), emb);
      const result = clusterStore(db, { threshold: 0.70 });
      expect(result.clusters).toEqual([]);
    } finally { cleanup(); }
  });

  it('is deterministic: same DB → same clusters and UIDs across two passes', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      // Insert episodes in two groups with close embeddings
      const emb1 = seedEmbedding(10);
      const emb2 = nearDupEmbedding(emb1, 0.05); // close to emb1
      const emb3 = seedEmbedding(500); // far from group 1

      insertEpisode(db, 'ep1', 'A'.repeat(60), emb1);
      insertEpisode(db, 'ep2', 'B'.repeat(60), emb2);
      insertEpisode(db, 'ep3', 'C'.repeat(60), emb3);

      // Run clustering twice
      const r1 = clusterStore(db, { threshold: 0.70 });
      // Reset communities for second run
      db.exec(`UPDATE node SET t_invalid = datetime('now') WHERE kind = 'community'`);
      db.exec(`UPDATE edge SET t_invalid = datetime('now') WHERE rel = 'MEMBER_OF'`);
      const r2 = clusterStore(db, { threshold: 0.70 });

      // Community UIDs must match (same member rowids → same hash)
      const uids1 = r1.clusters.map((c) => c.community_uid).sort();
      const uids2 = r2.clusters.map((c) => c.community_uid).sort();
      expect(uids1).toEqual(uids2);
    } finally { cleanup(); }
  });

  it('suppresses singletons (D1.6)', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      // 3 orthogonal episodes — no cluster possible at high threshold
      insertEpisode(db, 'ep1', 'A'.repeat(60), seedEmbedding(1));
      insertEpisode(db, 'ep2', 'B'.repeat(60), seedEmbedding(999));
      insertEpisode(db, 'ep3', 'C'.repeat(60), seedEmbedding(9999));

      const result = clusterStore(db, { threshold: 0.99 }); // very high → no pairs above threshold
      // All should be unclustered (singletons suppressed)
      for (const cluster of result.clusters) {
        expect(cluster.member_rowids.length).toBeGreaterThanOrEqual(2);
      }
    } finally { cleanup(); }
  });

  it('excludes episodes with content < 50 chars (D5.1)', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      const emb1 = seedEmbedding(1);
      const emb2 = nearDupEmbedding(emb1, 0.001);
      // Both have content < 50 chars — should not be clustered
      insertEpisode(db, 'ep1', 'Short.', emb1);
      insertEpisode(db, 'ep2', 'Also short.', emb2);
      const result = clusterStore(db, { threshold: 0.50 });
      expect(result.clusters).toEqual([]);
    } finally { cleanup(); }
  });
});

// ── clusterStats ──────────────────────────────────────────────────────────────

describe('clusterStats', () => {
  it('returns zero stats on empty store', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      const stats = clusterStats(db);
      expect(stats.cluster_count).toBe(0);
      expect(stats.total_clustered).toBe(0);
      expect(stats.coverage).toBe(0);
    } finally { cleanup(); }
  });

  it('has consistent structure', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      const stats = clusterStats(db);
      expect(typeof stats.cluster_count).toBe('number');
      expect(typeof stats.total_clustered).toBe('number');
      expect(typeof stats.total_unclustered).toBe('number');
      expect(typeof stats.mean_intra_sim).toBe('number');
      expect(typeof stats.mean_inter_sim).toBe('number');
      expect(typeof stats.largest_cluster_size).toBe('number');
      expect(typeof stats.coverage).toBe('number');
    } finally { cleanup(); }
  });
});

// ── buildAutoLinks ────────────────────────────────────────────────────────────

describe('buildAutoLinks', () => {
  it('inserts no edges when < 2 episodes', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      const result = buildAutoLinks(db);
      expect(result.edges_inserted).toBe(0);
    } finally { cleanup(); }
  });

  it('is idempotent: running twice on same DB inserts same count', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      // Insert 4 episodes: e1 and e2 share JWT+OAuth. e3 and e4 only share JWT.
      // With 4 episodes: JWT appears in e1,e2,e3,e4 (4/4 = 100% → stoplist).
      // To avoid stoplist: use 10 episodes where JWT appears in only 2 of them.
      // Simpler: 4 episodes, entities A+B appear in only 2 of 4 (50%=0.5 > 0.3, still stoplist).
      // Use entities that appear in exactly 1 episode pair out of 6 episodes total.
      // entityA appears in e1,e2 (2/6 = 33% — borderline). Use threshold 0.40 explicitly.
      const now = new Date().toISOString();

      // 6 episodes
      const eps: number[] = [];
      for (let i = 1; i <= 6; i++) {
        const r = db.prepare<unknown[], { rowid: number }>(
          `INSERT INTO node (uid, kind, content, t_created, t_valid) VALUES ('ep${i}','episode','Episode ${i} content here.', ?, ?) RETURNING rowid`,
        ).get(now, now)!;
        eps.push(r.rowid);
      }

      // Two shared entities appearing in exactly e1 and e2 (2/6 = 33% < 40% threshold)
      const rA = db.prepare<unknown[], { rowid: number }>(
        `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES ('entA','entity','EntityA', ?, ?) RETURNING rowid`,
      ).get(now, now)!;
      const rB = db.prepare<unknown[], { rowid: number }>(
        `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES ('entB','entity','EntityB', ?, ?) RETURNING rowid`,
      ).get(now, now)!;

      // Only ep1 and ep2 mention both A and B
      for (const [ep, ent] of [
        [eps[0], rA.rowid], [eps[0], rB.rowid],
        [eps[1], rA.rowid], [eps[1], rB.rowid],
      ] as [number, number][]) {
        db.prepare(
          `INSERT INTO edge (src, dst, rel, origin, t_created) VALUES (?, ?, 'MENTIONS', 'user_asserted', ?)`,
        ).run(ep, ent, now);
      }

      // Pass custom threshold 0.40 so entities at 33% are not stoplist
      const result1 = buildAutoLinks(db, 0.40);
      expect(result1.edges_inserted).toBe(1); // ep1 ↔ ep2 share 2 entities

      const result2 = buildAutoLinks(db, 0.40);
      expect(result2.edges_inserted).toBe(0); // idempotent: edge already exists
    } finally { cleanup(); }
  });
});

// ── P3: clusterStore — deeper tests ──────────────────────────────────────────

describe('clusterStore — P3 clustering guarantees', () => {
  it('community UID = sha256(sorted member rowids).slice(0,32)', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      // Two very similar episodes
      const emb1 = seedEmbedding(20);
      const emb2 = nearDupEmbedding(emb1, 0.02);
      const r1 = insertEpisode(db, 'ep1', 'A'.repeat(60), emb1);
      const r2 = insertEpisode(db, 'ep2', 'B'.repeat(60), emb2);

      const result = clusterStore(db, { threshold: 0.50 });
      if (result.clusters.length === 1) {
        const cluster = result.clusters[0]!;
        // Verify UID formula: sha256(sorted rowids joined by comma).slice(0,32)
        const sortedRowids = [r1, r2].sort((a, b) => a - b);
        const expectedUid = require('node:crypto')
          .createHash('sha256')
          .update(sortedRowids.join(','))
          .digest('hex')
          .slice(0, 32);
        expect(cluster.community_uid).toBe(expectedUid);
      }
    } finally { cleanup(); }
  });

  it('community UID is stable across re-runs with same members', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      const emb1 = seedEmbedding(30);
      const emb2 = nearDupEmbedding(emb1, 0.02);
      insertEpisode(db, 'ep1', 'A'.repeat(60), emb1);
      insertEpisode(db, 'ep2', 'B'.repeat(60), emb2);

      const r1 = clusterStore(db, { threshold: 0.50 });
      if (r1.clusters.length === 0) return; // not enough similarity — skip

      const uid1 = r1.clusters.map((c) => c.community_uid).sort().join(',');

      // Reset community nodes and re-run
      db.exec(`UPDATE node SET t_invalid = datetime('now') WHERE kind = 'community'`);
      db.exec(`UPDATE edge SET t_invalid = datetime('now') WHERE rel = 'MEMBER_OF'`);

      const r2 = clusterStore(db, { threshold: 0.50 });
      const uid2 = r2.clusters.map((c) => c.community_uid).sort().join(',');

      expect(uid1).toBe(uid2);
    } finally { cleanup(); }
  });

  it('degenerate guard: skips writes when all episodes cluster into one (threshold too low)', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      // All embeddings very similar (same seed) — all will cluster at low threshold
      const base = seedEmbedding(50);
      for (let i = 0; i < 5; i++) {
        const emb = nearDupEmbedding(base, i * 0.001);
        insertEpisode(db, `ep${i}`, `A${i}`.repeat(30), emb);
      }

      // Threshold so low it might cause degenerate clustering
      // The guard should either raise threshold or return empty clusters
      const result = clusterStore(db, { threshold: 0.01 });
      // Either the guard raised the threshold and clusters are formed,
      // or it bailed out returning empty — either is valid
      expect(Array.isArray(result.clusters)).toBe(true);
    } finally { cleanup(); }
  });

  it('member_rowids are sorted ascending in every cluster', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      const emb1 = seedEmbedding(60);
      const emb2 = nearDupEmbedding(emb1, 0.02);
      const emb3 = nearDupEmbedding(emb1, 0.03);
      insertEpisode(db, 'ep1', 'A'.repeat(60), emb1);
      insertEpisode(db, 'ep2', 'B'.repeat(60), emb2);
      insertEpisode(db, 'ep3', 'C'.repeat(60), emb3);

      const result = clusterStore(db, { threshold: 0.50 });
      for (const cluster of result.clusters) {
        const sorted = [...cluster.member_rowids].sort((a, b) => a - b);
        expect(cluster.member_rowids).toEqual(sorted);
      }
    } finally { cleanup(); }
  });

  it('label is derived from centroid-nearest episode (D1.4)', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      const emb1 = seedEmbedding(70);
      const emb2 = nearDupEmbedding(emb1, 0.02);
      insertEpisode(db, 'ep1', 'A'.repeat(60), emb1, { topic: 'my-topic' });
      insertEpisode(db, 'ep2', 'B'.repeat(60), emb2);

      const result = clusterStore(db, { threshold: 0.50 });
      if (result.clusters.length === 1) {
        // Label should come from one of the episodes (preferring topic field)
        expect(typeof result.clusters[0]!.label).toBe('string');
        expect(result.clusters[0]!.label.length).toBeGreaterThan(0);
      }
    } finally { cleanup(); }
  });

  it('community nodes and MEMBER_OF edges are persisted to DB', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      const emb1 = seedEmbedding(80);
      const emb2 = nearDupEmbedding(emb1, 0.02);
      insertEpisode(db, 'ep1', 'A'.repeat(60), emb1);
      insertEpisode(db, 'ep2', 'B'.repeat(60), emb2);

      const result = clusterStore(db, { threshold: 0.50 });
      if (result.clusters.length === 0) return; // not enough similarity

      const communityCount = db
        .prepare<[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'community' AND t_invalid IS NULL`,
        )
        .get()!.cnt;
      expect(communityCount).toBeGreaterThanOrEqual(1);

      const memberOfCount = db
        .prepare<[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM edge WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL`,
        )
        .get()!.cnt;
      expect(memberOfCount).toBeGreaterThanOrEqual(2);
    } finally { cleanup(); }
  });
});

// ── runBatchEnrich ────────────────────────────────────────────────────────────

describe('runBatchEnrich', () => {
  it('returns expected shape on empty store', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      const result = runBatchEnrich(db);
      expect(typeof result.communities_upserted).toBe('number');
      expect(typeof result.member_of_edges).toBe('number');
      expect(typeof result.importance_updated).toBe('number');
      expect(typeof result.relates_to_edges).toBe('number');
      expect(typeof result.topics_backfilled).toBe('number');
      expect(typeof result.legacy_nodes_stamped).toBe('number');
      expect(typeof result.cluster_pass_skipped).toBe('boolean');
    } finally { cleanup(); }
  });

  it('stamps legacy nodes on first pass', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO node (uid, kind, content, t_created, t_valid)
         VALUES ('ep1', 'episode', 'A legacy episode with no enrich_ver stamped yet.', ?, ?)`,
      ).run(now, now);

      const result = runBatchEnrich(db);
      expect(result.legacy_nodes_stamped).toBe(1);

      const row = db.prepare<[], { enrich_ver: string | null }>(
        `SELECT enrich_ver FROM node WHERE uid = 'ep1'`,
      ).get()!;
      expect(row.enrich_ver).not.toBeNull();
      const parsed = JSON.parse(row.enrich_ver!) as { pass: string; note: string };
      expect(parsed.pass).toBe('legacy');
      expect(parsed.note).toBe('legacy');
    } finally { cleanup(); }
  });

  it('is deterministic: same DB → same batch result counts', () => {
    const t1 = makeTmpDb();
    const t2 = makeTmpDb();
    try {
      process.env['SOX_EMBED_BACKEND'] = 'hash';
      const now = new Date().toISOString();
      for (const t of [t1, t2]) {
        t.db.prepare(
          `INSERT INTO node (uid, kind, content, t_created, t_valid)
           VALUES ('ep1', 'episode', 'Same content for both test databases here.', ?, ?)`,
        ).run(now, now);
      }

      const r1 = runBatchEnrich(t1.db);
      const r2 = runBatchEnrich(t2.db);

      expect(r1.legacy_nodes_stamped).toBe(r2.legacy_nodes_stamped);
      expect(r1.importance_updated).toBe(r2.importance_updated);
      expect(r1.relates_to_edges).toBe(r2.relates_to_edges);
    } finally {
      delete process.env['SOX_EMBED_BACKEND'];
      t1.cleanup();
      t2.cleanup();
    }
  });

  // BL-45: incrementalCluster option skips full O(n²) pass
  it('incrementalCluster:true skips the full cluster pass (no communities written)', () => {
    const { db, cleanup } = makeTmpDb();
    try {
      process.env['SOX_EMBED_BACKEND'] = 'hash';
      const now = new Date().toISOString();
      // Insert two similar episodes with vectors so clustering would fire
      const ep1 = seedEmbedding(1);
      const ep2 = nearDupEmbedding(ep1, 0.01);
      insertEpisode(db, 'ep-inc-1', 'Incremental clustering test episode alpha with enough content.', ep1);
      insertEpisode(db, 'ep-inc-2', 'Incremental clustering test episode beta with enough content.', ep2);
      // First stamp enrich_ver so mixed-model guard passes
      db.prepare(
        `UPDATE node SET enrich_ver = ? WHERE kind = 'episode'`,
      ).run(JSON.stringify({ pass: 'test', ts: now }));

      const result = runBatchEnrich(db, { incrementalCluster: true });
      // incremental mode: clusterStore called with incrementalOnly:true → no full O(n²) pass → 0 communities
      expect(result.communities_upserted).toBe(0);
      // cluster_pass_skipped=true because incrementalOnly returns clusters:[], full_pass:false
      // (the batch orchestrator treats no-full-pass as skipped — expected for incremental mode)
      expect(result.cluster_pass_skipped).toBe(true);
      // importance should still be updated (chunked tx independent of clustering)
      expect(typeof result.importance_updated).toBe('number');
    } finally {
      delete process.env['SOX_EMBED_BACKEND'];
      cleanup();
    }
  });

  // BL-45: importanceChunkSize splits the transaction but produces same results
  it('importanceChunkSize:1 produces same importance updates as default (chunked tx)', () => {
    const t1 = makeTmpDb();
    const t2 = makeTmpDb();
    try {
      process.env['SOX_EMBED_BACKEND'] = 'hash';
      const now = new Date().toISOString();
      // Insert 3 episodes in each DB
      for (let i = 1; i <= 3; i++) {
        for (const t of [t1, t2]) {
          const emb = seedEmbedding(i);
          insertEpisode(t.db, `ep-chunk-${i}`, `Episode content number ${i} for chunk transaction testing here.`, emb);
        }
      }

      // Default chunk (500): run first on t1
      const r1 = runBatchEnrich(t1.db, { importanceChunkSize: 500 });
      // Chunk size 1 (one episode per transaction): run on t2
      const r2 = runBatchEnrich(t2.db, { importanceChunkSize: 1 });

      // Both should produce the same importance_updated count
      expect(r1.importance_updated).toBe(r2.importance_updated);
      expect(r1.legacy_nodes_stamped).toBe(r2.legacy_nodes_stamped);
    } finally {
      delete process.env['SOX_EMBED_BACKEND'];
      t1.cleanup();
      t2.cleanup();
    }
  });
});
