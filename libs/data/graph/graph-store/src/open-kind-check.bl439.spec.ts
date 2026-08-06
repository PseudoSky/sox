/**
 * BL-439 (PKT-58) — `node.kind` opens: the fresh-store DDL paths (`graphDdl()`,
 * `INLINE_MIGRATION_DDL`) no longer carry `CHECK (kind IN (...))`. `ix_node_kind` (already
 * present, unmodified by this packet) becomes reachable for any kind an injected `TypePolicy`
 * (PKT-59) is willing to validate. `NODE_TABLE_DDL` — the legacy-store rebuild target reached by
 * `ensureCheckConstraints()` — deliberately keeps its CHECK; see SPEC-PKT-58.md Decision 1 and
 * `ensure-check-constraints.bl447.spec.ts` Criterion B for the regression guard that proves it.
 *
 * See SPEC-PKT-58.md §4 for the four acceptance criteria this file proves (AC-1 through AC-4).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl } from '@adhd/sox-store-adapter';
import {
  createGraphBackend,
  DEFAULT_NODE_KINDS,
  DEFAULT_TYPE_POLICY,
} from './index.js';
import type { TypePolicy } from './index.js';

// ── Temp directory ───────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'graph-store-bl439-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

const openAdapters: SqliteAdapterImpl[] = [];
afterEach(async () => {
  while (openAdapters.length > 0) {
    const a = openAdapters.pop()!;
    try {
      await a.close();
    } catch {
      // already closed
    }
  }
});

function track(adapter: SqliteAdapterImpl): SqliteAdapterImpl {
  openAdapters.push(adapter);
  return adapter;
}

// A custom, deliberately permissive policy: accepts everything the default accepts PLUS a novel
// node kind ('component'), following `type-policy.bl440.spec.ts`'s convention exactly (Decision 2).
const permissiveTestPolicy: TypePolicy = {
  validateKind(kind: string): void {
    if (kind === 'component') return;
    DEFAULT_TYPE_POLICY.validateKind(kind);
  },
  validateRel(rel: string): void {
    DEFAULT_TYPE_POLICY.validateRel(rel);
  },
};

interface TableIdentity {
  rootpage: number;
  sql: string;
}

async function captureNodeIdentity(adapter: SqliteAdapterImpl): Promise<TableIdentity> {
  const row = await adapter.executeGet<{ sql: string; rootpage: number }>(
    `SELECT sql, rootpage FROM sqlite_master WHERE type='table' AND name='node'`,
  );
  if (!row) throw new Error('node table missing from sqlite_master');
  return { rootpage: row.rootpage, sql: row.sql };
}

// ── AC-1 — a new store accepts and round-trips a consumer kind ───────────────

describe('AC-1 (BL-439) — a new store accepts and round-trips a consumer kind through writeNode/getNode, with an injected TypePolicy permitting it', () => {
  it('writeNode({kind:"component"}) resolves and getNode reports the novel kind, against a fresh store with no CHECK', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter, { typePolicy: permissiveTestPolicy });
    await backend.applySchema();

    const id = await backend.writeNode('novel kind node', { kind: 'component' });
    expect(typeof id).toBe('number');

    const node = await backend.getNode(id);
    expect(node).not.toBeNull();
    expect(node!.kind).toBe('component');

    await adapter.close();
  });
});

// ── AC-2 — EXPLAIN QUERY PLAN: ix_node_kind serves a consumer kind, zero json_each ───

describe('AC-2 (BL-439) — EXPLAIN QUERY PLAN for a consumer-kind query resolves to ix_node_kind, zero json_each', () => {
  it('SELECT ... WHERE kind = ? on a consumer kind uses ix_node_kind and touches no json_each', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter, { typePolicy: permissiveTestPolicy });
    await backend.applySchema();

    for (let i = 0; i < 5; i++) {
      await backend.writeNode(`component content ${i}`, { kind: 'component' });
    }

    const plan = await adapter.executeAll<Record<string, unknown>>(
      `EXPLAIN QUERY PLAN SELECT * FROM node WHERE kind = 'component'`,
    );
    expect(
      plan.rows.some((row) =>
        Object.values(row).some((v) => typeof v === 'string' && v.includes('ix_node_kind')),
      ),
    ).toBe(true);
    expect(
      plan.rows.every((row) =>
        Object.values(row).every((v) => !(typeof v === 'string' && v.toLowerCase().includes('json_each'))),
      ),
    ).toBe(true);

    await adapter.close();
  });

  it('RED-arm contrast: the tag-based json_each path is still what a sub-kind stashed in tags requires — SCAN via json_each, no plain index SEARCH', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter, { typePolicy: permissiveTestPolicy });
    await backend.applySchema();

    for (let i = 0; i < 5; i++) {
      await backend.writeNode(`generic content ${i}`, { kind: 'generic', tags: ['component'] });
    }

    const plan = await adapter.executeAll<Record<string, unknown>>(
      `EXPLAIN QUERY PLAN SELECT * FROM node WHERE EXISTS (SELECT 1 FROM json_each(node.tags) WHERE value = 'component')`,
    );
    const planStrings = plan.rows.flatMap((row) =>
      Object.values(row).filter((v): v is string => typeof v === 'string'),
    );
    expect(planStrings.some((s) => s.includes('SCAN'))).toBe(true);
    expect(planStrings.some((s) => s.toLowerCase().includes('json_each'))).toBe(true);
    expect(planStrings.some((s) => /SEARCH .* USING INDEX/i.test(s))).toBe(false);

    await adapter.close();
  });
});

// ── AC-3 — honest-scope arm: an OLD (CHECK-bearing) store still rejects a consumer kind ───

describe('AC-3 (BL-439) — a store created by the OLD (CHECK-bearing) DDL still rejects a consumer kind, and its table identity is unchanged', () => {
  // Test-local, byte-for-byte copy of `INLINE_MIGRATION_DDL`'s pre-PKT-58 (CHECK-bearing) shape,
  // per SPEC-PKT-58.md AC-3: after this edit lands `index.ts` no longer exports a closed-DDL
  // constant to import, so this literal is maintained locally, following
  // `ensure-check-constraints.bl447.spec.ts`'s established convention for exactly this reason.
  const OLD_CHECK_BEARING_INLINE_DDL = `
CREATE TABLE IF NOT EXISTS "node" (
  "rowid" integer PRIMARY KEY NOT NULL,
  "uid" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('episode','entity','claim','community','session','generic')),
  "content" text,
  "name" text,
  "summary" text,
  "topic" text,
  "tags" text,
  "importance" real DEFAULT 1,
  "confidence" text,
  "content_hash" text,
  "namespace" text DEFAULT 'global',
  "meta" text,
  "agent_id" text,
  "session_id" text,
  "source" text CHECK ("source" IN ('message','tool_output','observation','document','reflection','import')),
  "project_path" text,
  "level" integer,
  "resume_state" text,
  "is_superseded" integer DEFAULT 0,
  "t_occurred" text,
  "t_expires" text,
  "t_created" text NOT NULL,
  "t_valid" text,
  "t_invalid" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "node_uid_unique" ON "node" ("uid");
CREATE INDEX IF NOT EXISTS "ix_node_kind" ON "node" ("kind");
CREATE TABLE IF NOT EXISTS "edge" (
  "rowid" integer PRIMARY KEY NOT NULL,
  "src" integer NOT NULL REFERENCES "node"("rowid") ON DELETE CASCADE,
  "dst" integer NOT NULL REFERENCES "node"("rowid") ON DELETE CASCADE,
  "rel" text NOT NULL CHECK ("rel" IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO','DEPENDS_ON')),
  "weight" real DEFAULT 1,
  "confidence" text,
  "origin" text CHECK ("origin" IN ('extracted','inferred','user_asserted')),
  "meta" text,
  "t_created" text NOT NULL,
  "t_expired" text,
  "t_valid" text,
  "t_invalid" text
);
CREATE INDEX IF NOT EXISTS "ix_edge_src" ON "edge" ("src");
CREATE INDEX IF NOT EXISTS "ix_edge_dst" ON "edge" ("dst");
CREATE INDEX IF NOT EXISTS "ix_edge_rel" ON "edge" ("rel");
`;

  it('a store built from the pre-edit CHECK-bearing DDL still rejects a consumer kind at the SQL layer, and applySchema() leaves its identity byte-identical', async () => {
    const dbPath = tempPath('old-check-bearing');
    const adapter = track(new SqliteAdapterImpl(dbPath));
    await adapter.exec(OLD_CHECK_BEARING_INLINE_DDL);

    const before = await captureNodeIdentity(adapter);
    expect(before.sql).toContain('CHECK ("kind" IN (');

    // Permissive policy deliberately (Decision 2/AC-3): proves the SQL layer, not the TypeScript
    // layer, is still doing the rejecting.
    const backend = createGraphBackend(adapter, { typePolicy: permissiveTestPolicy });
    await backend.applySchema();

    const after = await captureNodeIdentity(adapter);
    // Not a red->green criterion — a regression guard (SPEC-PKT-58.md AC-3): this already passed
    // pre-edit and must still pass post-edit, proving the fresh-DDL edit did not widen
    // ensureCheckConstraints()'s rebuild trigger or otherwise leak the open schema onto a store
    // that has the CHECK.
    expect(after.rootpage).toBe(before.rootpage);
    expect(after.sql).toBe(before.sql);

    await expect(backend.writeNode('x', { kind: 'component' })).rejects.toThrow(
      /CHECK constraint failed/i,
    );
  });
});

// ── AC-4 — populated round-trip: open, close, reopen, zero rebuilds, zero row/edge loss ───

describe('AC-4 (BL-439) — populated round-trip against a synthetic populated store: open, close, reopen, zero rebuilds, zero row/edge loss', () => {
  it('a >=500 node / >=500 edge store survives close+copy+reopen with identical row counts, table identity, and spot-checked row content', async () => {
    const NODE_COUNT = 500;
    const EDGE_COUNT = 500;

    const sourcePath = tempPath('ac4-source');
    const sourceAdapter = track(new SqliteAdapterImpl(sourcePath));
    const backend = createGraphBackend(sourceAdapter); // default policy — this AC is about identity, not consumer kinds
    await backend.applySchema();

    const nodes = Array.from({ length: NODE_COUNT }, (_, i) => ({
      content: `synthetic node content ${i}`,
      meta: {
        kind: DEFAULT_NODE_KINDS[i % DEFAULT_NODE_KINDS.length]!,
        tags: i % 3 === 0 ? ['alpha', 'beta'] : [],
        ...(i % 5 === 0 ? { metadata: { note: `meta-${i}` } } : {}),
      },
    }));
    const edges = Array.from({ length: EDGE_COUNT }, (_, i) => ({
      srcIdx: i % NODE_COUNT,
      dstIdx: (i + 1) % NODE_COUNT,
      rel: 'MENTIONS' as const,
    }));

    await backend.writeGraph(nodes, edges);

    const preCloseCounts = {
      node: (await sourceAdapter.executeGet<{ c: number }>(`SELECT COUNT(*) AS c FROM node`))!.c,
      edge: (await sourceAdapter.executeGet<{ c: number }>(`SELECT COUNT(*) AS c FROM edge`))!.c,
    };
    expect(preCloseCounts.node).toBe(NODE_COUNT);
    expect(preCloseCounts.edge).toBe(EDGE_COUNT);

    const preCloseRows = (
      await sourceAdapter.executeAll<{ rowid: number; uid: string; content: string; kind: string }>(
        `SELECT rowid, uid, content, kind FROM node ORDER BY rowid LIMIT 10`,
      )
    ).rows;

    await sourceAdapter.close(); // forces a WAL checkpoint

    // Copy the .db, plus -wal/-shm if close() did not fully checkpoint them.
    const copyPath = tempPath('ac4-copy');
    copyFileSync(sourcePath, copyPath);
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(sourcePath + ext)) copyFileSync(sourcePath + ext, copyPath + ext);
    }

    // Independent read of the copy's identity BEFORE applySchema() runs on it — proves the copy
    // step itself (a raw file copy) caused zero rebuild by construction.
    const copyAdapterPreSchema = track(new SqliteAdapterImpl(copyPath));
    const preSchemaIdentity = await captureNodeIdentity(copyAdapterPreSchema);
    await copyAdapterPreSchema.close();

    const copyAdapter = track(new SqliteAdapterImpl(copyPath));
    const copyBackend = createGraphBackend(copyAdapter);
    await copyBackend.applySchema();

    const postSchemaIdentity = await captureNodeIdentity(copyAdapter);
    expect(postSchemaIdentity.rootpage).toBe(preSchemaIdentity.rootpage);
    expect(postSchemaIdentity.sql).toBe(preSchemaIdentity.sql);

    const postCounts = {
      node: (await copyAdapter.executeGet<{ c: number }>(`SELECT COUNT(*) AS c FROM node`))!.c,
      edge: (await copyAdapter.executeGet<{ c: number }>(`SELECT COUNT(*) AS c FROM edge`))!.c,
    };
    expect(postCounts.node).toBe(NODE_COUNT);
    expect(postCounts.edge).toBe(EDGE_COUNT);

    expect(await copyAdapter.pragmaGet<number>('foreign_keys')).toBe(1);

    const postRows = (
      await copyAdapter.executeAll<{ rowid: number; uid: string; content: string; kind: string }>(
        `SELECT rowid, uid, content, kind FROM node ORDER BY rowid LIMIT 10`,
      )
    ).rows;
    expect(postRows).toEqual(preCloseRows);
  });
});
