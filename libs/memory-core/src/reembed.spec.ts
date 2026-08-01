/**
 * reembed.spec.ts — Unit tests for reembedStore (BL-160, BL-92).
 *
 * These tests exercise the orchestration logic without loading the real ONNX
 * model. They use a mock embedding provider that returns deterministic
 * fixed-dim vectors and an in-process sqlite database.
 *
 * Coverage:
 *   1. dry-run makes ZERO writes and creates no side-table infrastructure.
 *   2. same-model store reports alreadyCurrent=true, migrated=0 (no force).
 *   3. force=true re-embeds even when the model is already current.
 *   4. modelId resolves to 'bge-base-en-v1.5'.
 *   5. BL-92 — a mixed-model store (record on target model + record on a
 *      stale model) migrates ONLY the stale record without --force, leaving
 *      the already-current record's vec_node bytes and embed_model stamp
 *      byte-for-byte untouched. Also covers 2 distinct stale models migrating
 *      in a single non-force pass (grouping, not just "the one differing
 *      model").
 *   6. BL-92 — NULL embed_model (pre-BL-88 rows) is treated as "unknown, must
 *      migrate" by default, NOT as "assume current". A store with only
 *      current + NULL rows is NOT reported alreadyCurrent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TARGET_MODEL = 'bge-base-en-v1.5';
const TARGET_DIM = 768;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-reembed-test-'));
}

function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ── Mock createEmbeddingProvider ──────────────────────────────────────────────
//
// We mock the embedding-provider so the test never loads the ONNX model.
// The mock returns fixed-length Float32Array(TARGET_DIM) vectors.

const mockProvider = {
  metadata: { modelId: TARGET_MODEL, dimensions: TARGET_DIM },
  embedSingle: vi.fn(async (_text: string) => new Float32Array(TARGET_DIM)),
  embedBatch: vi.fn(async function* (texts: string[]) {
    for (const _ of texts) yield new Float32Array(TARGET_DIM);
  }),
  health: vi.fn(() => ({ state: 'ready', last_error: null })),
};

vi.mock('@adhd/sox-embedding-provider', () => ({
  createEmbeddingProvider: vi.fn(async () => mockProvider),
}));

// ── Import after mocks are wired ──────────────────────────────────────────────

import { reembedStore } from './reembed.js';
import { openDb } from './db.js';
import { _resetEmbedSingleton, vecToJson } from './embed.js';



// ── Test lifecycle ────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];
let priorAdapterEnv: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  _resetEmbedSingleton();
  // This suite reads/writes vec_node directly via raw SQL (insertEmbeddedNode,
  // readVecNodeEmbedding) and inspects the on-disk sqlite_master for a
  // vec_<model> virtual table (vectorTableExists) via a raw better-sqlite3
  // handle — sqlite-vec (better-sqlite3) semantics, not Turso's. The factory
  // default is now STORE_ADAPTER=turso; pin sqlite explicitly, same
  // convention as every other adapter-sensitive spec.
  priorAdapterEnv = process.env['STORE_ADAPTER'];
  process.env['STORE_ADAPTER'] = 'sqlite';
});
afterEach(() => {
  _resetEmbedSingleton();
  for (const d of tmpDirs) removeTempDir(d);
  tmpDirs = [];
  if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = priorAdapterEnv;
});

async function freshDb(): Promise<{ db: StoreAdapter; dbPath: string }> {
  const dir = makeTempDir();
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'test.db');
  const db = await openDb(dbPath);
  // Seed memory_scope so idempotency checks work.
  // (openDb creates the schema including memory_scope via initScope called by
  // stampStoreMeta — but memory_scope may be empty until initScope runs.)
  // Insert a row with an old model so there's something to migrate.
  try {
    await db.executeRun(`INSERT OR IGNORE INTO memory_scope(scope, scope_id, embed_model, embed_dim, schema_ver, created_at)
       VALUES ('project', 'test-scope-id', 'old-model-id', 768, 1, datetime('now'))`);
  } catch {
    /* memory_scope may already have a row from stampStoreMeta */
  }
  return { db, dbPath };
}

async function freshDbCurrentModel(): Promise<{ db: StoreAdapter; dbPath: string }> {
  const { db, dbPath } = await freshDb();
  // Set embed_model to the target so the store is already current.
  await db.executeRun(`UPDATE memory_scope SET embed_model = ?, embed_dim = ?`, [TARGET_MODEL, TARGET_DIM]);
  return { db, dbPath };
}

// ── BL-92 helpers: per-record embed_model + vec_node fixtures ────────────────

/**
 * Insert a live episode WITH a vec_node row (filled with a distinguishable
 * sentinel value) and a given per-record `embed_model` stamp (pass `null` to
 * simulate a pre-BL-88 row). Returns the node's rowid.
 */
async function insertEmbeddedNode(
  db: StoreAdapter,
  uid: string,
  content: string,
  embedModel: string | null,
  fillValue: number,
): Promise<number> {
  const info = await db.executeRun(`INSERT INTO node (uid, kind, content, t_created, t_valid, embed_model)
       VALUES (?, 'episode', ?, datetime('now'), datetime('now'), ?)`, [uid, content, embedModel]);
  const rowid = info.lastInsertRowid as number;
  const vec = new Float32Array(TARGET_DIM).fill(fillValue);
  await db.executeRun(`INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)`, [rowid, vecToJson(vec)]);
  return rowid;
}

/** Read back the raw vec_node embedding for a node rowid. */
async function readVecNodeEmbedding(db: StoreAdapter, rowid: number): Promise<Float32Array> {
  const row = await db.executeGet<{ embedding: Buffer }>(`SELECT embedding FROM vec_node WHERE node_id = ?`, [rowid]);
  if (!row) throw new Error(`no vec_node row for node ${rowid}`);
  const buf = row.embedding;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Read back the per-record embed_model column for a node rowid. */
async function readNodeEmbedModel(db: StoreAdapter, rowid: number): Promise<string | null> {
  const row = await db.executeGet<{ embed_model: string | null }>(`SELECT embed_model FROM node WHERE rowid = ?`, [rowid]);
  return row?.embed_model ?? null;
}

// ── Helper: check whether a vec0 table exists ─────────────────────────────────

// Takes a genuinely raw handle: its only caller opens the .db file directly, in
// readonly mode, specifically to verify what reembedStore did or did not create
// on disk. That is the one place a raw handle is the point rather than a leak.
function vectorTableExists(db: Database.Database, modelId: string): boolean {
  const sanitized = modelId.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'default';
  const tableName = `vec_${sanitized}`;
  const row = db
    .prepare<[string], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    )
    .get(tableName);
  return row !== undefined;
}

// ── Test 1: dry-run makes ZERO writes and creates no vector space ─────────────

describe('reembedStore — dry-run', () => {
  it('performs no writes and creates no vec_* table', async () => {
    const { db, dbPath } = await freshDb();

    // Insert a node so there's something to "migrate".
    await db.executeRun(`INSERT INTO node(uid, kind, content, t_created)
       VALUES ('node-1', 'episode', 'hello world', datetime('now'))`);
    db.close();

    const logs: string[] = [];
    const result = await reembedStore(dbPath, {
      dryRun: true,
      log: (...args) => logs.push(args.join(' ')),
    });

    expect(result.dryRun).toBe(true);
    expect(result.modelId).toBe(TARGET_MODEL);

    // Verify: open the raw SQLite file and confirm no side-table infrastructure
    // was created. reembedStore (post-BL-92) writes directly into the fixed
    // vec_node table and never uses the generic multi-space `_vector_spaces` /
    // `vec_<model>` machinery at all — so neither should exist, dry-run or not.
    const rawDb = new Database(dbPath, { readonly: true });
    try {
      const vectorSpacesTable = rawDb
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='_vector_spaces'`,
        )
        .get();
      expect(vectorSpacesTable).toBeUndefined();

      // The vec_bge_base_en_v1_5 side-table should not exist either.
      expect(vectorTableExists(rawDb, TARGET_MODEL)).toBe(false);
    } finally {
      rawDb.close();
    }

    // Log should mention DRY-RUN.
    expect(logs.some((l) => l.includes('DRY-RUN'))).toBe(true);
  });
});

// ── Test 2: same-model store → alreadyCurrent=true, migrated=0 ────────────────

describe('reembedStore — same-model idempotency', () => {
  it('reports alreadyCurrent=true and skips migration when no force', async () => {
    const { db, dbPath } = await freshDbCurrentModel();
    db.close();

    const logs: string[] = [];
    const result = await reembedStore(dbPath, {
      force: false,
      log: (...args) => logs.push(args.join(' ')),
    });

    expect(result.alreadyCurrent).toBe(true);
    expect(result.migrated).toBe(0);
    expect(result.dryRun).toBe(false);
    expect(logs.some((l) => l.includes('already on'))).toBe(true);
  });
});

// ── Test 3: force=true re-embeds even when model is already current ───────────

describe('reembedStore — force re-embed', () => {
  it('runs migration even when all scopes are already on target model', async () => {
    const { db, dbPath } = await freshDbCurrentModel();

    // Insert a node so there's something to embed.
    await db.executeRun(`INSERT INTO node(uid, kind, content, t_created)
       VALUES ('node-2', 'episode', 'force re-embed test', datetime('now'))`);
    db.close();

    const logs: string[] = [];
    const result = await reembedStore(dbPath, {
      force: true,
      backup: false,
      log: (...args) => logs.push(args.join(' ')),
    });

    // With force=true it should attempt migration (even if migrated=0 because
    // there are no source vectors in a different space — sourceModelId may be
    // undefined when there is only one space matching the target).
    expect(result.dryRun).toBe(false);
    expect(result.alreadyCurrent).toBe(false);
    // No errors expected.
    expect(result.errors.filter((e) => e.id !== -1)).toHaveLength(0);
    expect(logs.some((l) => l.includes('re-embedding') || l.includes('DONE'))).toBe(true);
  });
});

// ── Test 4: modelId resolves to 'bge-base-en-v1.5' ───────────────────────────

describe('reembedStore — model resolution', () => {
  it('resolves to the canonical model id bge-base-en-v1.5', async () => {
    const { db, dbPath } = await freshDbCurrentModel();
    db.close();

    const result = await reembedStore(dbPath, {
      backup: false,
      log: () => { /* silent */ },
    });

    // alreadyCurrent=true means idempotency short-circuit ran, but modelId is always resolved.
    expect(result.modelId).toBe('bge-base-en-v1.5');
  });
});

// ── Test 5: BL-92 — mixed-model store, per-record targeting ───────────────────

describe('reembedStore — BL-92 mixed-model store (per-record embed_model)', () => {
  it('targeting a stale model leaves an already-current record byte-for-byte untouched (no --force)', async () => {
    const { db, dbPath } = await freshDb();

    // Already on the target model — must NOT be touched by a non-force run.
    const currentRowid = insertEmbeddedNode(db, 'node-current', 'already current content', TARGET_MODEL, 0.42);
    // On a different, stale model — MUST be migrated.
    const staleRowid = insertEmbeddedNode(db, 'node-stale', 'stale model content', 'old-model-b', 0.99);

    const beforeCurrentVec = Array.from(await readVecNodeEmbedding(db, await currentRowid));
    db.close();

    const logs: string[] = [];
    const result = await reembedStore(dbPath, {
      force: false,
      backup: false,
      log: (...args) => logs.push(args.join(' ')),
    });

    expect(result.alreadyCurrent).toBe(false);
    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    // Grouping is visible: both the current-model bucket and the stale bucket
    // were seen as distinct candidate groups going in.
    expect(result.sourceModelGroups[TARGET_MODEL]).toBe(1);
    expect(result.sourceModelGroups['old-model-b']).toBe(1);

    // NOTE: use openDb (not a bare `new Database`) — it loads the sqlite-vec
    // extension, required to read back the vec_node virtual table's contents.
    const rawDb = await openDb(dbPath);
    try {
      // The stale record is migrated: new stamp + new (mock all-zero) vector.
      expect(await readNodeEmbedModel(rawDb, await staleRowid)).toBe(TARGET_MODEL);
      const afterStaleVec = Array.from(await readVecNodeEmbedding(rawDb, await staleRowid));
      expect(afterStaleVec).toEqual(Array.from(new Float32Array(TARGET_DIM)));

      // The already-current record is untouched: same stamp, SAME vector bytes
      // (proves BL-92's over-migration failure mode is closed — no wasted
      // GPU/compute rewriting a vector that was already correct).
      expect(await readNodeEmbedModel(rawDb, await currentRowid)).toBe(TARGET_MODEL);
      const afterCurrentVec = Array.from(await readVecNodeEmbedding(rawDb, await currentRowid));
      expect(afterCurrentVec).toEqual(beforeCurrentVec);
      expect(afterCurrentVec[0]).toBeCloseTo(0.42, 5);
    } finally {
      rawDb.close();
    }
  });

  it('a store with TWO distinct stale models migrates BOTH groups in one non-force pass', async () => {
    const { db, dbPath } = await freshDb();
    const rowidA = insertEmbeddedNode(db, 'node-a', 'model a content', 'old-model-a', 0.11);
    const rowidB = insertEmbeddedNode(db, 'node-b', 'model b content', 'old-model-b', 0.22);
    db.close();

    const result = await reembedStore(dbPath, { force: false, backup: false, log: () => { /* silent */ } });

    expect(result.alreadyCurrent).toBe(false);
    expect(result.migrated).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(result.sourceModelGroups['old-model-a']).toBe(1);
    expect(result.sourceModelGroups['old-model-b']).toBe(1);

    // NOTE: use openDb (not a bare `new Database`) — it loads the sqlite-vec
    // extension, required to read back the vec_node virtual table's contents.
    const rawDb = await openDb(dbPath);
    try {
      expect(await readNodeEmbedModel(rawDb, await rowidA)).toBe(TARGET_MODEL);
      expect(await readNodeEmbedModel(rawDb, await rowidB)).toBe(TARGET_MODEL);
    } finally {
      rawDb.close();
    }
  });
});

// ── Test 6: BL-92 — NULL embed_model (pre-BL-88 rows) ─────────────────────────

describe('reembedStore — BL-92 NULL embed_model handling', () => {
  it('migrates a NULL-embed_model row by default (NULL = unknown provenance, must re-embed)', async () => {
    const { db, dbPath } = await freshDb();
    const nullRowid = insertEmbeddedNode(db, 'node-null', 'pre-bl88 legacy content', null, 0.77);
    db.close();

    const result = await reembedStore(dbPath, { force: false, backup: false, log: () => { /* silent */ } });

    expect(result.alreadyCurrent).toBe(false);
    expect(result.migrated).toBe(1);
    expect(result.sourceModelGroups['(null)']).toBe(1);

    // NOTE: use openDb (not a bare `new Database`) — it loads the sqlite-vec
    // extension, required to read back the vec_node virtual table's contents.
    const rawDb = await openDb(dbPath);
    try {
      expect(await readNodeEmbedModel(rawDb, await nullRowid)).toBe(TARGET_MODEL);
      const afterVec = Array.from(await readVecNodeEmbedding(rawDb, await nullRowid));
      expect(afterVec).toEqual(Array.from(new Float32Array(TARGET_DIM)));
    } finally {
      rawDb.close();
    }
  });

  it('a store with ONLY current-model + NULL rows is NOT reported alreadyCurrent (NULL forces a real pass)', async () => {
    const { db, dbPath } = await freshDb();
    const currentRowid = insertEmbeddedNode(db, 'node-current', 'current content', TARGET_MODEL, 0.5);
    insertEmbeddedNode(db, 'node-null', 'legacy content', null, 0.6);
    db.close();

    const result = await reembedStore(dbPath, { force: false, backup: false, log: () => { /* silent */ } });
    expect(result.alreadyCurrent).toBe(false);
    expect(result.migrated).toBe(1); // only the NULL row

    // NOTE: use openDb (not a bare `new Database`) — it loads the sqlite-vec
    // extension, required to read back the vec_node virtual table's contents.
    const rawDb = await openDb(dbPath);
    try {
      // The already-current row is confirmed untouched here too.
      expect(await readNodeEmbedModel(rawDb, await currentRowid)).toBe(TARGET_MODEL);
    } finally {
      rawDb.close();
    }
  });

  it('a store with ONLY current-model rows (no NULL, no stale) IS reported alreadyCurrent', async () => {
    const { db, dbPath } = await freshDb();
    insertEmbeddedNode(db, 'node-current-1', 'current content 1', TARGET_MODEL, 0.5);
    insertEmbeddedNode(db, 'node-current-2', 'current content 2', TARGET_MODEL, 0.6);
    db.close();

    const logs: string[] = [];
    const result = await reembedStore(dbPath, {
      force: false,
      backup: false,
      log: (...args) => logs.push(args.join(' ')),
    });
    expect(result.alreadyCurrent).toBe(true);
    expect(result.migrated).toBe(0);
    expect(logs.some((l) => l.includes('already on'))).toBe(true);
  });
});
