/**
 * Unit tests for FTSDialect implementations.
 *
 * Covers both dialect classes (SqliteFTS5Dialect, TursoFTSDialect),
 * and the factory (createFTSDialect).
 */
import { describe, it, expect } from 'vitest';

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  SqliteFTS5Dialect,
  TursoFTSDialect,
  createFTSDialect,
} from '../fts-dialect.js';

// ============================================================================
// 1. SqliteFTS5Dialect
// ============================================================================

describe('SqliteFTS5Dialect', () => {
  const dialect = new SqliteFTS5Dialect();

  // ── 1a. basic props ──────────────────────────────────────────────────────

  it('is supported', () => {
    expect(dialect.supported).toBe(true);
  });

  it('has dialect discriminator "sqlite"', () => {
    expect(dialect.dialect).toBe('sqlite');
  });

  // ── 1b. createIndexDDL ───────────────────────────────────────────────────

  describe('createIndexDDL', () => {
    it('returns empty string because FTS5 DDL is managed separately', () => {
      expect(dialect.createIndexDDL('node', ['content', 'name', 'summary'])).toBe('');
      expect(dialect.createIndexDDL('node', ['content'], { content: 2.0 })).toBe('');
      expect(dialect.createIndexDDL('other', ['col1', 'col2'])).toBe('');
    });
  });

  // ── 1c. matchClause ──────────────────────────────────────────────────────

  describe('matchClause', () => {
    it('returns fts_node MATCH with the query param', () => {
      const result = dialect.matchClause(['content', 'name', 'summary'], '?');
      expect(result.sql).toBe('fts_node MATCH ?');
    });

    it('works with an inline query string', () => {
      const result = dialect.matchClause(['content'], "'hello world'");
      expect(result.sql).toBe("fts_node MATCH 'hello world'");
    });

    it('ignores columns (FTS5 uses the virtual table, not columns)', () => {
      const withCols = dialect.matchClause(['a', 'b', 'c'], '?');
      const without = dialect.matchClause([], '?');
      expect(withCols.sql).toBe(without.sql);
    });
  });

  // ── 1d. scoreClause ──────────────────────────────────────────────────────

  describe('scoreClause', () => {
    it('returns fts_node.rank', () => {
      expect(dialect.scoreClause(['content', 'name', 'summary'], '?')).toBe('fts_node.rank');
    });

    it('ignores columns and query param (FTS5 exposes rank directly)', () => {
      expect(dialect.scoreClause([], '')).toBe('fts_node.rank');
      expect(dialect.scoreClause(['x', 'y'], 'query')).toBe('fts_node.rank');
    });
  });
});

// ============================================================================
// 2. TursoFTSDialect
// ============================================================================

describe('TursoFTSDialect', () => {
  const dialect = new TursoFTSDialect();

  // ── 2a. basic props ──────────────────────────────────────────────────────

  it('is supported', () => {
    expect(dialect.supported).toBe(true);
  });

  it('has dialect discriminator "turso"', () => {
    expect(dialect.dialect).toBe('turso');
  });

  // ── 2b. createIndexDDL ───────────────────────────────────────────────────

  describe('createIndexDDL', () => {
    it('generates CREATE INDEX ... USING fts DDL', () => {
      const ddl = dialect.createIndexDDL('node', ['content', 'name', 'summary']);
      expect(ddl).toBe(
        'CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content", "name", "summary")',
      );
    });

    it('includes weights when provided', () => {
      const ddl = dialect.createIndexDDL('node', ['content', 'name', 'summary'], {
        content: 2.0,
        name: 1.0,
        summary: 0.5,
      });
      expect(ddl).toContain("WITH (weights = 'content=2,name=1,summary=0.5')");
      expect(ddl).toContain('CREATE INDEX IF NOT EXISTS idx_fts_node');
    });

    it('quotes column names', () => {
      const ddl = dialect.createIndexDDL('node', ['content', 'name']);
      expect(ddl).toContain('"content"');
      expect(ddl).toContain('"name"');
    });

    it('quotes the table name', () => {
      const ddl = dialect.createIndexDDL('my_table', ['col']);
      expect(ddl).toContain('"my_table"');
    });

    it('includes IF NOT EXISTS guard', () => {
      const ddl = dialect.createIndexDDL('node', ['content']);
      expect(ddl).toContain('IF NOT EXISTS');
    });

    it('omits WITH clause when weights are empty', () => {
      const ddl = dialect.createIndexDDL('node', ['content'], {});
      expect(ddl).not.toContain('WITH');
    });

    it('omits WITH clause when weights is undefined', () => {
      const ddl = dialect.createIndexDDL('node', ['content']);
      expect(ddl).not.toContain('WITH');
    });

    it('uses idx_fts_ prefix in index name', () => {
      const ddl = dialect.createIndexDDL('custom_table', ['col1', 'col2']);
      expect(ddl).toContain('idx_fts_custom_table');
    });
  });

  // ── 2c. matchClause ──────────────────────────────────────────────────────

  describe('matchClause', () => {
    it('generates fts_match with quoted columns and query', () => {
      const result = dialect.matchClause(['content', 'name', 'summary'], "'search query'");
      expect(result.sql).toBe(
        `fts_match("content", "name", "summary", 'search query')`,
      );
    });

    it('quotes column names', () => {
      const result = dialect.matchClause(['content'], '?');
      expect(result.sql).toBe('fts_match("content", ?)');
    });

    it('handles single column', () => {
      const result = dialect.matchClause(['title'], ':q');
      expect(result.sql).toBe('fts_match("title", :q)');
    });
  });

  // ── 2d. scoreClause ──────────────────────────────────────────────────────

  describe('scoreClause', () => {
    it('generates fts_score with quoted columns and query', () => {
      const sql = dialect.scoreClause(['content', 'name', 'summary'], "'query'");
      expect(sql).toBe(`fts_score("content", "name", "summary", 'query')`);
    });

    it('quotes column names', () => {
      const sql = dialect.scoreClause(['content'], '?');
      expect(sql).toBe('fts_score("content", ?)');
    });

    it('handles single column', () => {
      const sql = dialect.scoreClause(['title'], ':q');
      expect(sql).toBe('fts_score("title", :q)');
    });
  });
});

// ============================================================================
// 3. Factory
// ============================================================================

describe('createFTSDialect factory', () => {
  it('returns SqliteFTS5Dialect for type "sqlite"', () => {
    const d = createFTSDialect('sqlite');
    expect(d).toBeInstanceOf(SqliteFTS5Dialect);
    expect(d.dialect).toBe('sqlite');
  });

  it('returns TursoFTSDialect for type "turso"', () => {
    const d = createFTSDialect('turso');
    expect(d).toBeInstanceOf(TursoFTSDialect);
    expect(d.dialect).toBe('turso');
  });
});
