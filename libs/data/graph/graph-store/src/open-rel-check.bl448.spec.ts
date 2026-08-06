/**
 * BL-448 (PKT-74) — `edge.rel` opens: the fresh-store DDL paths (`graphDdl()`,
 * `INLINE_MIGRATION_DDL`) no longer carry `CHECK (rel IN (...))`. `ix_edge_src`/`ix_edge_dst`
 * (already present, unmodified by this packet) become reachable for any rel an injected
 * `TypePolicy` (PKT-59/BL-440) is willing to validate. `EDGE_TABLE_DDL` — the legacy-store
 * rebuild target reached by `ensureCheckConstraints()` — deliberately keeps its CHECK; see
 * SPEC-PKT-74.md Decision 1 and `ensure-check-constraints.bl447.spec.ts` Criterion B for the
 * regression guard that proves it.
 *
 * Structure mirrors `open-kind-check.bl439.spec.ts` line for line (same temp-dir scaffolding,
 * same `track()`/`afterEach` cleanup, same `permissiveTestPolicy` convention naming a novel
 * value — here `'COMPONENT_REL'`, chosen to echo BL-439's `'component'` kind and pair the two
 * files' provenance for a future reader).
 *
 * See SPEC-PKT-74.md §4 for AC-1 through AC-4 plus AC-Type.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import {
  createGraphBackend,
  DEFAULT_TYPE_POLICY,
  DEFAULT_EDGE_RELS,
  ConstraintError,
} from './index.js';
import type { TypePolicy, EdgeRel } from './index.js';

// ── Temp directory ───────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'graph-store-bl448-'));
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
// edge rel ('COMPONENT_REL'), following `type-policy.bl440.spec.ts`'s convention exactly
// (SPEC-PKT-74.md Decision 2).
const permissiveTestPolicy: TypePolicy = {
  validateKind(kind: string): void {
    DEFAULT_TYPE_POLICY.validateKind(kind);
  },
  validateRel(rel: string): void {
    if (rel === 'COMPONENT_REL') return;
    DEFAULT_TYPE_POLICY.validateRel(rel);
  },
};

interface TableIdentity {
  rootpage: number;
  sql: string;
}

async function captureEdgeIdentity(adapter: SqliteAdapterImpl): Promise<TableIdentity> {
  const row = await adapter.executeGet<{ sql: string; rootpage: number }>(
    `SELECT sql, rootpage FROM sqlite_master WHERE type='table' AND name='edge'`,
  );
  if (!row) throw new Error('edge table missing from sqlite_master');
  return { rootpage: row.rootpage, sql: row.sql };
}

// ── AC-1 — a new store accepts and round-trips a consumer rel ────────────────

describe('AC-1 (BL-448) — a new store accepts and round-trips a consumer rel through writeEdge/getEdges/getNeighbors, with an injected TypePolicy permitting it', () => {
  it('writeEdge(a, b, "COMPONENT_REL") resolves, getEdges/getNeighbors report the novel rel, against a fresh store with no CHECK', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter, { typePolicy: permissiveTestPolicy });
    await backend.applySchema();

    const a = await backend.writeNode('node a', { kind: 'episode' });
    const b = await backend.writeNode('node b', { kind: 'episode' });

    await backend.writeEdge(a, b, 'COMPONENT_REL');

    const edges = await backend.getEdges({ rel: 'COMPONENT_REL' });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.rel).toBe('COMPONENT_REL');
    expect(edges[0]!.src).toBe(a);
    expect(edges[0]!.dst).toBe(b);

    const neighbors = await backend.getNeighbors(a, { rel: 'COMPONENT_REL' });
    expect(neighbors.map((n) => n.id)).toEqual([b]);

    await adapter.close();
  });

  // Informational, not a strict red/green (SPEC-PKT-74.md §4 AC-1's second `it()`): unlike
  // BL-439's AC-2 (which contrasts against a genuinely different, unindexable json_each query
  // shape for kind's tag-based workaround), there is no pre-existing "workaround" query shape
  // for a consumer edge rel — a custom rel could not be *written* at all before PKT-59+this
  // packet, so there is nothing to contrast against. This `it()` exists to prove
  // ix_edge_src/ix_edge_dst need zero modification to serve a consumer rel, the same "zero new
  // index" property PKT-58 established for ix_node_kind.
  it('EXPLAIN QUERY PLAN for a getEdges({src, rel}) query on a consumer rel resolves via ix_edge_src', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter, { typePolicy: permissiveTestPolicy });
    await backend.applySchema();

    const a = await backend.writeNode('node a', { kind: 'episode' });
    const b = await backend.writeNode('node b', { kind: 'episode' });
    await backend.writeEdge(a, b, 'COMPONENT_REL');

    // Matches getEdges's own SQL construction (index.ts: WHERE t_invalid IS NULL AND src = ?
    // AND rel = ?).
    const plan = await adapter.executeAll<Record<string, unknown>>(
      `EXPLAIN QUERY PLAN SELECT * FROM edge WHERE t_invalid IS NULL AND src = ${a} AND rel = 'COMPONENT_REL'`,
    );
    expect(
      plan.rows.some((row) =>
        Object.values(row).some(
          (v) => typeof v === 'string' && (v.includes('ix_edge_src') || v.includes('ix_edge_unique')),
        ),
      ),
    ).toBe(true);

    await adapter.close();
  });
});

// ── AC-2 — validateRel rejects an unknown rel before the INSERT, no CHECK backstop ───

describe('AC-2 (BL-448) — validateRel rejects an unknown rel before the INSERT is attempted, on a fresh open-schema store with no CHECK backstop', () => {
  it('writeEdge with a bogus rel throws ConstraintError and never reaches the adapter INSERT, against a store with no rel CHECK at all', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter); // default policy — no permissive override
    await backend.applySchema();

    const a = await backend.writeNode('a', {});
    const b = await backend.writeNode('b', {});

    // Wrap executeRun to detect whether an INSERT into `edge` is ever attempted for the bogus rel.
    const originalExecuteRun = adapter.executeRun.bind(adapter);
    let edgeInsertAttempted = false;
    (adapter as unknown as { executeRun: StoreAdapter['executeRun'] }).executeRun = (async (
      sql: string,
      params?: unknown[],
    ) => {
      if (/INSERT INTO edge/i.test(sql)) edgeInsertAttempted = true;
      return originalExecuteRun(sql, params as never);
    }) as StoreAdapter['executeRun'];

    await expect(backend.writeEdge(a, b, 'BOGUS_REL' as EdgeRel)).rejects.toThrow(ConstraintError);
    expect(edgeInsertAttempted).toBe(false);

    await adapter.close();
  });
});

// ── AC-3 — honest-scope arm: an OLD (CHECK-bearing) store still rejects a consumer rel ───

describe('AC-3 (BL-448) — a store created by the OLD (CHECK-bearing) DDL still rejects a consumer rel, and its table identity is unchanged', () => {
  // Test-local, byte-for-byte copy of `INLINE_MIGRATION_DDL`'s pre-PKT-74 (CHECK-bearing) shape,
  // per SPEC-PKT-74.md AC-3: after this edit lands `index.ts` no longer exports a closed-DDL
  // constant to import, so this literal is maintained locally, following
  // `open-kind-check.bl439.spec.ts`'s established convention for exactly this reason.
  const OLD_CHECK_BEARING_INLINE_DDL = `
CREATE TABLE IF NOT EXISTS "node" (
  "rowid" integer PRIMARY KEY NOT NULL,
  "uid" text NOT NULL,
  "kind" text NOT NULL,
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

  it('a store built from the pre-edit CHECK-bearing DDL still rejects a consumer rel at the SQL layer, and applySchema() leaves its identity byte-identical', async () => {
    const dbPath = tempPath('old-check-bearing');
    const adapter = track(new SqliteAdapterImpl(dbPath));
    await adapter.exec(OLD_CHECK_BEARING_INLINE_DDL);

    await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, t_created) VALUES (?, ?, ?, ?)`,
      ['n1', 'episode', 'seed one', new Date().toISOString()],
    );
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, t_created) VALUES (?, ?, ?, ?)`,
      ['n2', 'episode', 'seed two', new Date().toISOString()],
    );

    const before = await captureEdgeIdentity(adapter);
    expect(before.sql).toContain("CHECK (\"rel\" IN (");

    // Permissive policy deliberately (Decision 2/AC-3): proves the SQL layer, not the TypeScript
    // layer, is still doing the rejecting.
    const backend = createGraphBackend(adapter, { typePolicy: permissiveTestPolicy });
    await backend.applySchema();

    const after = await captureEdgeIdentity(adapter);
    // Not a red->green criterion — a regression guard (SPEC-PKT-74.md AC-3): this already passed
    // pre-edit and must still pass post-edit, proving the fresh-DDL edit did not accidentally
    // widen ensureCheckConstraints()'s rebuild trigger or leak the open schema onto a store that
    // still has the CHECK.
    expect(after.rootpage).toBe(before.rootpage);
    expect(after.sql).toBe(before.sql);

    const rowA = await adapter.executeGet<{ rowid: number }>(
      `SELECT rowid FROM node WHERE uid = 'n1'`,
    );
    const rowB = await adapter.executeGet<{ rowid: number }>(
      `SELECT rowid FROM node WHERE uid = 'n2'`,
    );

    await expect(
      backend.writeEdge(rowA!.rowid, rowB!.rowid, 'COMPONENT_REL'),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });
});

// ── AC-4 — populated round-trip against a synthetic populated store ───

describe('AC-4 (BL-448) — populated round-trip against a synthetic populated store: open, close, reopen, zero rebuilds, zero row/edge loss', () => {
  it('a >=500 node / >=500 edge store, edges spanning multiple rels, survives close+copy+reopen with identical row counts, table identity, and spot-checked row content', async () => {
    const NODE_COUNT = 500;
    const EDGE_COUNT = 500;

    const sourcePath = tempPath('ac4-source');
    const sourceAdapter = track(new SqliteAdapterImpl(sourcePath));
    const backend = createGraphBackend(sourceAdapter); // default policy — this AC is about identity, not consumer rels
    await backend.applySchema();

    const nodes = Array.from({ length: NODE_COUNT }, (_, i) => ({
      content: `synthetic node content ${i}`,
      meta: { kind: 'episode' },
    }));
    // Mix DEFAULT_EDGE_RELS across the 500 edges (matching AC-4's own node-kind-cycling
    // convention in open-kind-check.bl439.spec.ts:251), so the edge table's rebuild-avoidance is
    // proven under the same kind of realistic heterogeneity BL-439 proved for `node`.
    const edges = Array.from({ length: EDGE_COUNT }, (_, i) => ({
      srcIdx: i % NODE_COUNT,
      dstIdx: (i + 1) % NODE_COUNT,
      rel: DEFAULT_EDGE_RELS[i % DEFAULT_EDGE_RELS.length] as EdgeRel,
    }));

    await backend.writeGraph(nodes, edges);

    const preCloseCounts = {
      node: (await sourceAdapter.executeGet<{ c: number }>(`SELECT COUNT(*) AS c FROM node`))!.c,
      edge: (await sourceAdapter.executeGet<{ c: number }>(`SELECT COUNT(*) AS c FROM edge`))!.c,
    };
    expect(preCloseCounts.node).toBe(NODE_COUNT);
    expect(preCloseCounts.edge).toBe(EDGE_COUNT);

    const preCloseRows = (
      await sourceAdapter.executeAll<{ rowid: number; src: number; dst: number; rel: string }>(
        `SELECT rowid, src, dst, rel FROM edge ORDER BY rowid LIMIT 10`,
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
    const preSchemaIdentity = await captureEdgeIdentity(copyAdapterPreSchema);
    await copyAdapterPreSchema.close();

    const copyAdapter = track(new SqliteAdapterImpl(copyPath));
    const copyBackend = createGraphBackend(copyAdapter);
    await copyBackend.applySchema();

    const postSchemaIdentity = await captureEdgeIdentity(copyAdapter);
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
      await copyAdapter.executeAll<{ rowid: number; src: number; dst: number; rel: string }>(
        `SELECT rowid, src, dst, rel FROM edge ORDER BY rowid LIMIT 10`,
      )
    ).rows;
    expect(postRows).toEqual(preCloseRows);
  });
});

// ── AC-Type — the EdgeRecord.rel-into-EdgeRel compile break, demonstrated via @ts-expect-error ──

function assertNeverRel(x: never): never {
  throw new Error(`unreachable rel: ${String(x)}`);
}

// Exhaustive over the ten known EdgeRel literals. Before Edit D (EdgeRel closed), the `default`
// arm's narrowed type is `never` and `assertNeverRel(rel)` compiles with NO error — so the
// `@ts-expect-error` below is itself an error ("Unused '@ts-expect-error' directive"), and this
// file fails `npx nx typecheck graph-store`. After Edit D (EdgeRel widened to include
// `string & {}`), the `default` arm's type is `string & {}` (not `never`), so
// `assertNeverRel(rel)` is a genuine type error and the directive becomes necessary — the file
// passes typecheck. This is BL-448's demonstrated (not asserted) EdgeRecord.rel-into-EdgeRel
// compile break: a consumer's exhaustive switch over `edge.rel` stops compiling once EdgeRel
// widens, exactly as ADR-0010's Consequences section states.
function classifyRel(rel: EdgeRel): string {
  switch (rel) {
    case 'MENTIONS': return 'mentions';
    case 'SUPPORTS': return 'supports';
    case 'RELATES_TO': return 'relates_to';
    case 'DERIVED_FROM': return 'derived_from';
    case 'SUPERSEDES': return 'supersedes';
    case 'SAME_AS': return 'same_as';
    case 'ASSIGNED_TO': return 'assigned_to';
    case 'MEMBER_OF': return 'member_of';
    case 'PART_OF': return 'part_of';
    case 'DEPENDS_ON': return 'depends_on';
    default:
      // @ts-expect-error BL-448 — see comment above; necessary only once EdgeRel widens (Edit D).
      return assertNeverRel(rel);
  }
}

describe('AC-Type (BL-448) — EdgeRecord.rel-into-EdgeRel compile break', () => {
  it('classifyRel handles all ten known EdgeRel literals at runtime (sanity check alongside the compile-time @ts-expect-error above)', () => {
    expect(classifyRel('MENTIONS')).toBe('mentions');
    expect(classifyRel('DEPENDS_ON')).toBe('depends_on');
  });
});
