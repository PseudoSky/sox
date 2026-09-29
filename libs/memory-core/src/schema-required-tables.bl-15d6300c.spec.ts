/**
 * BL-15d6300c — `REQUIRED_STORE_TABLES` is what `memory restore` demands of a
 * backup. It must be derived from graph-store's `GRAPH_DDL` (not a hand list),
 * and must not demand the migration-added memory-only tables an older backup
 * can legitimately lack.
 */
import { GRAPH_DDL } from '@adhd/sox-graph-store';
import { describe, expect, it } from 'vitest';
import { DDL_BASE, ddlTableNames, REQUIRED_STORE_TABLES, STORE_CONTENT_TABLE } from './schema.js';

describe('BL-15d6300c — REQUIRED_STORE_TABLES', () => {
  it('BL-15d6300c: is exactly the graph primitives GRAPH_DDL creates', () => {
    expect([...REQUIRED_STORE_TABLES]).toEqual(ddlTableNames(GRAPH_DDL));
    expect([...REQUIRED_STORE_TABLES]).toEqual(['node', 'edge']);
    expect(REQUIRED_STORE_TABLES).toContain(STORE_CONTENT_TABLE);
  });

  it('BL-15d6300c: excludes memory-only tables, which DDL_BASE does create', () => {
    const all = ddlTableNames(DDL_BASE);
    for (const t of ['request_ledger', 'enrich_poison', 'memory_scope']) {
      expect(all).toContain(t);
      expect(REQUIRED_STORE_TABLES).not.toContain(t);
    }
  });
});
