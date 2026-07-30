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

  it('supports a shadow table synced by triggers', () => {
    expect(dialect.supportsShadowTable).toBe(true);
  });

  // ── 1b. createIndexDDL ───────────────────────────────────────────────────

  describe('createIndexDDL', () => {
    it('returns [] when no sqliteDDL is supplied (FTS5 DDL is schema-owned upstream)', () => {
      expect(dialect.createIndexDDL('node', ['content', 'name', 'summary'])).toEqual([]);
      expect(dialect.createIndexDDL('node', ['content'], { content: 2.0 })).toEqual([]);
      expect(dialect.createIndexDDL('other', ['col1', 'col2'])).toEqual([]);
    });

    it('returns the supplied sqliteDDL verbatim, in order', () => {
      const createDDL = `CREATE VIRTUAL TABLE IF NOT EXISTS fts_node USING fts5(content, name, summary, content='node', content_rowid='rowid');`;
      const triggersDDL = `CREATE TRIGGER IF NOT EXISTS fts_node_ai AFTER INSERT ON node BEGIN INSERT INTO fts_node(rowid, content, name, summary) VALUES (new.rowid, new.content, new.name, new.summary); END;`;
      const stmts = dialect.createIndexDDL('node', ['content', 'name', 'summary'], undefined, [
        createDDL,
        triggersDDL,
      ]);
      expect(stmts).toEqual([createDDL, triggersDDL]);
    });

    it('ignores columns/weights — sqliteDDL is the only input that matters', () => {
      const createDDL = 'CREATE VIRTUAL TABLE fts_node USING fts5(content);';
      const stmts = dialect.createIndexDDL('node', ['irrelevant'], { irrelevant: 9 }, [createDDL]);
      expect(stmts).toEqual([createDDL]);
    });
  });

  // ── 1c. legacyResidueNames / dropLegacyDDL (Turso-side residue) ──────────

  describe('legacyResidueNames', () => {
    it('names the Turso native FTS index + its internal directory objects', () => {
      const names = dialect.legacyResidueNames('node');
      expect(names).toContain('idx_fts_node');
      expect(names).toContain('__turso_internal_fts_dir_idx_fts_node');
      expect(names).toContain('__turso_internal_fts_dir_idx_fts_node_key');
    });

    it('parameterizes on table name', () => {
      const names = dialect.legacyResidueNames('custom_table');
      expect(names).toContain('idx_fts_custom_table');
    });
  });

  describe('dropLegacyDDL', () => {
    it('drops the Turso index + its internal directory objects', () => {
      const stmts = dialect.dropLegacyDDL('node');
      expect(stmts.some((s) => s.includes('DROP INDEX IF EXISTS "idx_fts_node"'))).toBe(true);
      expect(
        stmts.some((s) => s.includes('DROP TABLE IF EXISTS "__turso_internal_fts_dir_idx_fts_node"')),
      ).toBe(true);
      expect(
        stmts.some((s) =>
          s.includes('DROP INDEX IF EXISTS "__turso_internal_fts_dir_idx_fts_node_key"'),
        ),
      ).toBe(true);
    });
  });

  // ── 1d. matchClause ──────────────────────────────────────────────────────

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

  // ── 1e. scoreClause ──────────────────────────────────────────────────────

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

  it('does not support a shadow table (index lives directly on the base table)', () => {
    expect(dialect.supportsShadowTable).toBe(false);
  });

  // ── 2b. createIndexDDL ───────────────────────────────────────────────────

  describe('createIndexDDL', () => {
    it('generates CREATE INDEX ... USING fts DDL as a single-element array', () => {
      const ddl = dialect.createIndexDDL('node', ['content', 'name', 'summary']);
      expect(ddl).toEqual([
        'CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content", "name", "summary")',
      ]);
    });

    it('includes weights when provided', () => {
      const [ddl] = dialect.createIndexDDL('node', ['content', 'name', 'summary'], {
        content: 2.0,
        name: 1.0,
        summary: 0.5,
      });
      expect(ddl).toContain("WITH (weights = 'content=2,name=1,summary=0.5')");
      expect(ddl).toContain('CREATE INDEX IF NOT EXISTS idx_fts_node');
    });

    it('quotes column names', () => {
      const [ddl] = dialect.createIndexDDL('node', ['content', 'name']);
      expect(ddl).toContain('"content"');
      expect(ddl).toContain('"name"');
    });

    it('quotes the table name', () => {
      const [ddl] = dialect.createIndexDDL('my_table', ['col']);
      expect(ddl).toContain('"my_table"');
    });

    it('includes IF NOT EXISTS guard', () => {
      const [ddl] = dialect.createIndexDDL('node', ['content']);
      expect(ddl).toContain('IF NOT EXISTS');
    });

    it('omits WITH clause when weights are empty', () => {
      const [ddl] = dialect.createIndexDDL('node', ['content'], {});
      expect(ddl).not.toContain('WITH');
    });

    it('omits WITH clause when weights is undefined', () => {
      const [ddl] = dialect.createIndexDDL('node', ['content']);
      expect(ddl).not.toContain('WITH');
    });

    it('uses idx_fts_ prefix in index name', () => {
      const [ddl] = dialect.createIndexDDL('custom_table', ['col1', 'col2']);
      expect(ddl).toContain('idx_fts_custom_table');
    });

    it('ignores sqliteDDL entirely — it generates its own DDL', () => {
      const ddl = dialect.createIndexDDL('node', ['content'], undefined, [
        'CREATE VIRTUAL TABLE fts_node USING fts5(content);',
      ]);
      expect(ddl).toEqual(['CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")']);
    });
  });

  // ── 2c. legacyResidueNames / dropLegacyDDL (SQLite FTS5-side residue) ────

  describe('legacyResidueNames', () => {
    it('names the FTS5 virtual table, its 4 shadow tables, and its 3 triggers', () => {
      const names = dialect.legacyResidueNames('node');
      expect(names).toEqual(
        expect.arrayContaining([
          'fts_node_ai',
          'fts_node_ad',
          'fts_node_au',
          'fts_node',
          'fts_node_data',
          'fts_node_idx',
          'fts_node_docsize',
          'fts_node_config',
        ]),
      );
      expect(names).toHaveLength(8);
    });
  });

  describe('dropLegacyDDL', () => {
    it('drops the 3 triggers before the virtual table and its 4 shadow tables', () => {
      const stmts = dialect.dropLegacyDDL('node');
      const triggerIdx = ['fts_node_ai', 'fts_node_ad', 'fts_node_au'].map((t) =>
        stmts.findIndex((s) => s.includes(`DROP TRIGGER IF EXISTS "${t}"`)),
      );
      const tableIdx = ['fts_node', 'fts_node_data', 'fts_node_idx', 'fts_node_docsize', 'fts_node_config'].map(
        (t) => stmts.findIndex((s) => s.includes(`DROP TABLE IF EXISTS "${t}"`)),
      );
      expect(triggerIdx.every((i) => i >= 0)).toBe(true);
      expect(tableIdx.every((i) => i >= 0)).toBe(true);
      expect(Math.max(...triggerIdx)).toBeLessThan(Math.min(...tableIdx));
    });
  });

  // ── 2d. matchClause ──────────────────────────────────────────────────────

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

  // ── 2e. scoreClause ──────────────────────────────────────────────────────

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
