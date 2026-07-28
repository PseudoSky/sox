/**
 * Unit tests for VectorDialect implementations.
 *
 * Covers both dialect classes (SqliteVecDialect, TursoVectorDialect),
 * serialisation helpers (vecToJson, vecToBlob), and the factory
 * (createVectorDialect).
 */
import { describe, it, expect, vi } from 'vitest';

// ── Mock sqlite-vec for SqliteVecDialect.initialize() test ────────────────────

vi.mock('sqlite-vec', () => ({
  load: vi.fn(),
}));

// ── Imports (below mock so hoisting works cleanly) ────────────────────────────

import {
  SqliteVecDialect,
  TursoVectorDialect,
  createVectorDialect,
  vecToJson,
  vecToBlob,
} from '../vector-dialect.js';

// ============================================================================
// 1. vecToJson serialisation
// ============================================================================

describe('vecToJson', () => {
  it('produces a valid JSON array string', () => {
    const vec = new Float32Array([0.1, 0.2, 0.3]);
    const json = vecToJson(vec);
    expect(json).toMatch(/^\[[\d.,-]+\]$/);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
  });

  it('formats values to 8 decimal places', () => {
    // 0.1 in float32 is ≈ 0.10000000149011612, toFixed(8) → '0.10000000'
    const vec = new Float32Array([0.1]);
    const json = vecToJson(vec);
    // The brackets and comma are stripped; the number portion ends with 8 decimals
    const inner = json.slice(1, -1); // strip []
    const parts = inner.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[1]!.length).toBe(8);
  });
});

// ============================================================================
// 2. vecToBlob serialisation
// ============================================================================

describe('vecToBlob', () => {
  it('produces a Buffer with correct byte length (dim * 4)', () => {
    const vec = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const blob = vecToBlob(vec);
    expect(blob).toBeInstanceOf(Buffer);
    expect(blob.length).toBe(16); // 4 floats × 4 bytes
  });

  it('produces Buffer of correct length for single-element vector', () => {
    const vec = new Float32Array([42.0]);
    const blob = vecToBlob(vec);
    expect(blob.length).toBe(4); // 1 float × 4 bytes
  });

  it('round-trips through a new Float32Array', () => {
    const original = new Float32Array([1.0, 2.0, 3.0]);
    const blob = vecToBlob(original);
    const roundTrip = new Float32Array(
      blob.buffer,
      blob.byteOffset,
      blob.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
    expect(Array.from(roundTrip)).toEqual([1.0, 2.0, 3.0]);
  });
});

// ============================================================================
// 3. SqliteVecDialect
// ============================================================================

describe('SqliteVecDialect', () => {
  const dialect = new SqliteVecDialect();

  // ── 3a. vectorColumnType ─────────────────────────────────────────────────

  describe('vectorColumnType', () => {
    it('returns FLOAT[dim] for the given dimensionality', () => {
      expect(dialect.vectorColumnType(384)).toBe('FLOAT[384]');
      expect(dialect.vectorColumnType(768)).toBe('FLOAT[768]');
      expect(dialect.vectorColumnType(1024)).toBe('FLOAT[1024]');
    });
  });

  // ── 3b. distanceExpr ─────────────────────────────────────────────────────

  describe('distanceExpr', () => {
    it('returns the literal "distance" because MATCH handles it', () => {
      expect(dialect.distanceExpr('embedding', [0.1, 0.2])).toBe('distance');
    });
  });

  // ── 3c. createTableDDL ───────────────────────────────────────────────────

  describe('createTableDDL', () => {
    it('generates vec0 virtual table DDL', () => {
      const ddl = dialect.createTableDDL('foo', 'embedding', 384);
      expect(ddl).toBe(
        'CREATE VIRTUAL TABLE IF NOT EXISTS "foo" USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[384])',
      );
    });

    it('includes IF NOT EXISTS guard', () => {
      const ddl = dialect.createTableDDL('bar', 'vec', 768);
      expect(ddl).toContain('IF NOT EXISTS');
    });

    it('quotes the table name', () => {
      const ddl = dialect.createTableDDL('custom_table', 'v', 1024);
      expect(ddl).toContain('"custom_table"');
    });
  });

  // ── 3d. createIndexDDL ───────────────────────────────────────────────────

  describe('createIndexDDL', () => {
    it('returns empty string because vec0 tables are self-indexing', () => {
      expect(dialect.createIndexDDL('foo', 'embedding', 'cosine')).toBe('');
      expect(dialect.createIndexDDL('foo', 'embedding', 'l2')).toBe('');
      expect(dialect.createIndexDDL('foo', 'embedding', 'dot')).toBe('');
    });
  });

  // ── 3e. topKQuery ────────────────────────────────────────────────────────

  describe('topKQuery', () => {
    const result = dialect.topKQuery(
      'foo_768',
      'embedding',
      [0.1, 0.2, 0.3],
      10,
      'cosine',
    );

    it('SQL uses MATCH ? placeholder', () => {
      expect(result.sql).toContain('MATCH ?');
    });

    it('SQL uses k = ? placeholder', () => {
      expect(result.sql).toContain('k = ?');
    });

    it('SQL has ORDER BY v.distance ASC for cosine', () => {
      expect(result.sql).toContain('ORDER BY v.distance ASC');
    });

    it('args contain vec JSON string and k value', () => {
      expect(result.args).toHaveLength(2);
      expect(typeof result.args[0]).toBe('string');
      expect(result.args[1]).toBe(10);
    });

    it('uses DESC order for dot metric', () => {
      const dotResult = dialect.topKQuery('t', 'v', [1, 2], 5, 'dot');
      expect(dotResult.sql).toContain('ORDER BY v.distance DESC');
    });

    it('uses ASC order for l2 metric', () => {
      const l2Result = dialect.topKQuery('t', 'v', [1, 2], 5, 'l2');
      expect(l2Result.sql).toContain('ORDER BY v.distance ASC');
    });
  });

  // ── 3f. initialize ───────────────────────────────────────────────────────

  describe('initialize', () => {
    it('loads sqlite-vec extension without error', async () => {
      // Requires vi.mock('sqlite-vec') at the top of this file.
      const mockDb = {};
      await expect(dialect.initialize(mockDb)).resolves.toBeUndefined();
    });
  });
});

// ============================================================================
// 4. TursoVectorDialect
// ============================================================================

describe('TursoVectorDialect', () => {
  const dialect = new TursoVectorDialect();

  // ── 4a. vectorColumnType ────────────────────────────────────────────────

  describe('vectorColumnType', () => {
    it('returns F32_BLOB(dim) for the given dimensionality', () => {
      expect(dialect.vectorColumnType(384)).toBe('F32_BLOB(384)');
      expect(dialect.vectorColumnType(768)).toBe('F32_BLOB(768)');
      expect(dialect.vectorColumnType(1024)).toBe('F32_BLOB(1024)');
    });
  });

  // ── 4b. distanceExpr ────────────────────────────────────────────────────

  describe('distanceExpr', () => {
    it('returns vector_distance_cos with a hex blob literal', () => {
      const expr = dialect.distanceExpr('embedding', [0.1, 0.2]);
      expect(expr).toContain('vector_distance_cos(');
      expect(expr).toContain('embedding,');
      expect(expr).toContain("X'");
      expect(expr).toMatch(/^vector_distance_cos\(embedding, X'[0-9a-f]+'\)$/);
    });

    it('produces a 32-character hex string for a 4-dimensional vector', () => {
      const expr = dialect.distanceExpr('v', [1, 2, 3, 4]);
      // 4 floats × 4 bytes × 2 hex chars per byte = 32 hex chars
      const hexMatch = expr.match(/X'([0-9a-f]+)'/);
      expect(hexMatch).not.toBeNull();
      expect(hexMatch![1]!.length).toBe(32);
    });
  });

  // ── 4c. createTableDDL ──────────────────────────────────────────────────

  describe('createTableDDL', () => {
    it('generates standard CREATE TABLE with F32_BLOB column', () => {
      const ddl = dialect.createTableDDL('foo', 'embedding', 384);
      expect(ddl).toBe(
        'CREATE TABLE IF NOT EXISTS "foo" (node_id INTEGER PRIMARY KEY, embedding F32_BLOB(384))',
      );
    });

    it('includes IF NOT EXISTS guard', () => {
      const ddl = dialect.createTableDDL('bar', 'vec', 768);
      expect(ddl).toContain('IF NOT EXISTS');
    });
  });

  // ── 4d. createIndexDDL ──────────────────────────────────────────────────

  describe('createIndexDDL', () => {
    it('returns empty string because libsql_vector_descr is not available in @tursodatabase/database v0.7.1', () => {
      const ddl = dialect.createIndexDDL('foo', 'embedding', 'cosine');
      expect(ddl).toBe('');
    });

    it('returns empty for all three metrics (cosine, l2, dot)', () => {
      expect(dialect.createIndexDDL('foo', 'embedding', 'cosine')).toBe('');
      expect(dialect.createIndexDDL('foo', 'embedding', 'l2')).toBe('');
      expect(dialect.createIndexDDL('foo', 'embedding', 'dot')).toBe('');
    });
  });

  // ── 4e. topKQuery ───────────────────────────────────────────────────────

  describe('topKQuery', () => {
    it('uses vector_distance_cos for cosine metric', () => {
      const result = dialect.topKQuery('foo', 'embedding', [0.1, 0.2, 0.3], 10, 'cosine');
      expect(result.sql).toContain('vector_distance_cos(');
      expect(result.sql).toContain('ORDER BY distance ASC');
      expect(result.sql).not.toContain('LIMIT ?');
      expect(result.sql).not.toContain('MATCH');
    });

    it('args is empty (LIMIT is added by caller)', () => {
      const result = dialect.topKQuery('foo', 'embedding', [0.1, 0.2, 0.3], 10, 'cosine');
      expect(result.args).toHaveLength(0);
    });

    it('uses vector_distance_l2 for l2 metric with ASC order', () => {
      const result = dialect.topKQuery('t', 'v', [1], 5, 'l2');
      expect(result.sql).toContain('vector_distance_l2');
      expect(result.sql).toContain('ORDER BY distance ASC');
    });

    it('uses vector_distance_dot for dot metric with DESC order', () => {
      const result = dialect.topKQuery('t', 'v', [1], 5, 'dot');
      expect(result.sql).toContain('vector_distance_dot');
      expect(result.sql).toContain('ORDER BY distance DESC');
    });
  });

  // ── 4f. initialize ──────────────────────────────────────────────────────

  describe('initialize', () => {
    it('resolves without error (no-op for Turso)', async () => {
      await expect(dialect.initialize({})).resolves.toBeUndefined();
    });
  });
});

// ============================================================================
// 5. Factory
// ============================================================================

describe('createVectorDialect factory', () => {
  it('returns SqliteVecDialect for type "sqlite"', () => {
    expect(createVectorDialect('sqlite')).toBeInstanceOf(SqliteVecDialect);
  });

  it('returns TursoVectorDialect for type "turso"', () => {
    expect(createVectorDialect('turso')).toBeInstanceOf(TursoVectorDialect);
  });
});
