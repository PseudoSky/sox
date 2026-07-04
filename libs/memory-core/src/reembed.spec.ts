/**
 * reembed.spec.ts — Unit tests for reembedStore (BL-160).
 *
 * These tests exercise the orchestration logic without loading the real ONNX
 * model. They use a mock embedding provider that returns deterministic
 * fixed-dim vectors and an in-process sqlite database.
 *
 * Coverage:
 *   1. dry-run makes ZERO writes and creates no vector space table.
 *   2. same-model store reports alreadyCurrent=true, migrated=0 (no force).
 *   3. force=true re-embeds even when the model is already current.
 *   4. modelId resolves to 'bge-base-en-v1.5'.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { _resetEmbedSingleton } from './embed.js';

// ── Test lifecycle ────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  _resetEmbedSingleton();
});
afterEach(() => {
  _resetEmbedSingleton();
  for (const d of tmpDirs) removeTempDir(d);
  tmpDirs = [];
});

function freshDb(): { db: Database.Database; dbPath: string } {
  const dir = makeTempDir();
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'test.db');
  const db = openDb(dbPath);
  // Seed memory_scope so idempotency checks work.
  // (openDb creates the schema including memory_scope via initScope called by
  // stampStoreMeta — but memory_scope may be empty until initScope runs.)
  // Insert a row with an old model so there's something to migrate.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO memory_scope(scope, scope_id, embed_model, embed_dim, schema_ver, created_at)
       VALUES ('project', 'test-scope-id', 'old-model-id', 768, 1, datetime('now'))`,
    ).run();
  } catch {
    /* memory_scope may already have a row from stampStoreMeta */
  }
  return { db, dbPath };
}

function freshDbCurrentModel(): { db: Database.Database; dbPath: string } {
  const { db, dbPath } = freshDb();
  // Set embed_model to the target so the store is already current.
  db.prepare(`UPDATE memory_scope SET embed_model = ?, embed_dim = ?`).run(TARGET_MODEL, TARGET_DIM);
  return { db, dbPath };
}

// ── Helper: check whether a vec0 table exists ─────────────────────────────────

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
    const { db, dbPath } = freshDb();

    // Insert a node so there's something to "migrate".
    db.prepare(
      `INSERT INTO node(uid, kind, content, t_created)
       VALUES ('node-1', 'episode', 'hello world', datetime('now'))`,
    ).run();
    db.close();

    const logs: string[] = [];
    const result = await reembedStore(dbPath, {
      dryRun: true,
      log: (...args) => logs.push(args.join(' ')),
    });

    expect(result.dryRun).toBe(true);
    expect(result.modelId).toBe(TARGET_MODEL);

    // Verify: open the raw SQLite file and confirm no vec_* virtual table was created.
    const rawDb = new Database(dbPath, { readonly: true });
    try {
      // _vector_spaces is created by SqliteVectorBackend constructor, but only
      // if ensureSpace is called — we skip ensureSpace in dry-run, so the table
      // for the target model should NOT be in _vector_spaces.
      const row = rawDb
        .prepare<[string], { model_id: string }>(
          `SELECT model_id FROM _vector_spaces WHERE model_id = ?`,
        )
        .get(TARGET_MODEL);
      expect(row).toBeUndefined();

      // The vec_bge_base_en_v1_5 table should not exist.
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
    const { db, dbPath } = freshDbCurrentModel();
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
    const { db, dbPath } = freshDbCurrentModel();

    // Insert a node so there's something to embed.
    db.prepare(
      `INSERT INTO node(uid, kind, content, t_created)
       VALUES ('node-2', 'episode', 'force re-embed test', datetime('now'))`,
    ).run();
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
    const { db, dbPath } = freshDbCurrentModel();
    db.close();

    const result = await reembedStore(dbPath, {
      backup: false,
      log: () => { /* silent */ },
    });

    // alreadyCurrent=true means idempotency short-circuit ran, but modelId is always resolved.
    expect(result.modelId).toBe('bge-base-en-v1.5');
  });
});
