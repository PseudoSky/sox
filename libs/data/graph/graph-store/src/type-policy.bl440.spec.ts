/**
 * BL-440 (PKT-59) — injected `TypePolicy`, behaviour-preserving.
 *
 * `writeNode` (index.ts:886-...) used to validate `kind` against a module-level
 * `DEFAULT_NODE_KINDS` constant baked directly into graph-store, and `writeEdgeInternal`
 * (index.ts:1161-...) performed zero runtime validation of `rel` at all (the SQLite CHECK was the
 * only guard, and only after an INSERT was attempted). Per ADR-0010 D2, the vocabulary a store
 * enforces belongs to the consumer (memory-core), injected into graph-store as a `TypePolicy` —
 * not hardcoded inside it. See SPEC-PKT-59.md §4 for the four acceptance criteria this file proves.
 *
 * AC-1 uses a real temp-file adapter (not `:memory:`) — the point is proving schema *identity*
 * survives construction against a store that already has committed rows and an established
 * `sqlite_master` entry, following `ensure-check-constraints.bl447.spec.ts`'s pattern. AC-2..AC-4
 * use `:memory:` per `graph-store.spec.ts`'s existing convention.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import {
  createGraphBackend,
  ConstraintError,
  DEFAULT_NODE_KINDS,
  DEFAULT_EDGE_RELS,
  DEFAULT_TYPE_POLICY,
} from './index.js';
import type { EdgeRel, TypePolicy } from './index.js';

// ── Temp directory (AC-1 only) ───────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'graph-store-bl440-'));
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

interface TableIdentity {
  rootpage: number;
  sql: string;
}

async function captureIdentity(
  adapter: SqliteAdapterImpl,
): Promise<{ node: TableIdentity; edge: TableIdentity }> {
  const rows = (
    await adapter.executeAll<{ name: string; sql: string; rootpage: number }>(
      `SELECT name, sql, rootpage FROM sqlite_master WHERE type='table' AND name IN ('node','edge')`,
    )
  ).rows;
  const node = rows.find((r) => r.name === 'node');
  const edge = rows.find((r) => r.name === 'edge');
  if (!node || !edge) throw new Error('node/edge table missing from sqlite_master');
  return {
    node: { rootpage: node.rootpage, sql: node.sql },
    edge: { rootpage: edge.rootpage, sql: edge.sql },
  };
}

// A custom, deliberately permissive policy: accepts everything the default accepts PLUS a novel
// node kind ('component') and a novel edge rel ('CUSTOM_REL'). Used to prove that permissiveness
// at the TypePolicy layer has no structural path to the schema (AC-1).
const permissivePolicy: TypePolicy = {
  validateKind(kind: string): void {
    if (kind === 'component') return;
    DEFAULT_TYPE_POLICY.validateKind(kind);
  },
  validateRel(rel: string): void {
    if (rel === 'CUSTOM_REL') return;
    DEFAULT_TYPE_POLICY.validateRel(rel);
  },
};

// ── AC-1 — BL-295 regression guard: no path to DDL ───────────────────────────

describe('AC-1 (BL-440) — a permissive injected TypePolicy has no path to DDL (BL-295 regression guard)', () => {
  it('applySchema() with a custom TypePolicy leaves node/edge table identity byte-identical, and the CHECK still rejects what the policy would permit', async () => {
    const dbPath = tempPath('ac1-permissive-policy');

    // Build a store with the current closed DDL via a plain default-policy backend, then insert
    // a couple of rows directly so the store is populated and sqlite_master identity is established.
    const setupAdapter = track(new SqliteAdapterImpl(dbPath));
    const setupBackend = createGraphBackend(setupAdapter);
    await setupBackend.applySchema();
    const n1 = await setupBackend.writeNode('seed one', { kind: 'episode' });
    const n2 = await setupBackend.writeNode('seed two', { kind: 'episode' });
    await setupBackend.writeEdge(n1, n2, 'MENTIONS');
    await setupAdapter.close();

    // Re-open the same file with a fresh adapter (a real cold reconstruction) and a permissive
    // custom policy injected.
    const adapter = track(new SqliteAdapterImpl(dbPath));
    const before = await captureIdentity(adapter);

    const backend = createGraphBackend(adapter, { typePolicy: permissivePolicy });
    await backend.applySchema();

    const after = await captureIdentity(adapter);

    // No rebuild fired merely because a permissive policy was supplied — identity is preserved.
    expect(after.node.rootpage).toBe(before.node.rootpage);
    expect(after.edge.rootpage).toBe(before.edge.rootpage);
    expect(after.node.sql).toBe(before.node.sql);
    expect(after.edge.sql).toBe(before.edge.sql);

    // The backend still works normally for a default-vocabulary kind.
    const n3 = await backend.writeNode('normal node', { kind: 'entity' });
    expect(typeof n3).toBe('number');

    // The custom policy's permissiveness for 'component' now DOES reach the schema: PKT-58
    // (BL-439) deleted the node-side `CHECK (kind IN (...))` from the fresh-store DDL paths
    // (`graphDdl()`, `INLINE_MIGRATION_DDL`), so a store built via `applySchema()` on a fresh
    // file no longer has any SQL-layer kind allowlist for `ensureCheckConstraints()` to leave
    // in place here — the TypePolicy check passes (the policy allows it) and the INSERT now
    // succeeds and round-trips, proving `ix_node_kind` is reachable for a consumer kind once
    // the CHECK is gone. This assertion was the opposite (a CHECK-rejection expectation) prior
    // to PKT-58; see SPEC-PKT-58.md Decision 3 for why flipping it here, not adding a new test
    // file, is this packet's own AC-1 RED arm.
    const idComponent = await backend.writeNode('novel kind node', { kind: 'component' });
    expect(typeof idComponent).toBe('number');
    const nodeComponent = await backend.getNode(idComponent);
    expect(nodeComponent!.kind).toBe('component');

    // Same proof on the edge side, but the opposite outcome from before PKT-74 (BL-448):
    // 'CUSTOM_REL' passes the permissive policy, and after PKT-74 there is no more SQL CHECK to
    // reject it either — the write succeeds and round-trips. This assertion was a CHECK-rejection
    // expectation prior to PKT-74; see SPEC-PKT-74.md §2.5 for why flipping it here, not adding a
    // new test file, is this packet's own literal RED arm (mirrors SPEC-PKT-58.md Decision 3).
    await backend.writeEdge(n1, n3, 'CUSTOM_REL');
    const customEdges = await backend.getEdges({ src: n1, dst: n3, rel: 'CUSTOM_REL' });
    expect(customEdges).toHaveLength(1);
    expect(customEdges[0]!.rel).toBe('CUSTOM_REL');
  });
});

// ── AC-2 — validateRel exists and rejects before the INSERT ──────────────────

describe('AC-2 (BL-440) — DEFAULT_TYPE_POLICY.validateRel rejects, and writeEdge never attempts the INSERT for a rejected rel', () => {
  it('DEFAULT_TYPE_POLICY.validateRel throws ConstraintError for an unknown rel', () => {
    expect(() => DEFAULT_TYPE_POLICY.validateRel('BOGUS_REL')).toThrow(ConstraintError);
  });

  it('backend.writeEdge with a bogus rel throws ConstraintError and never reaches the adapter INSERT', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter);
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

// ── AC-3 — default-policy behaviour unchanged for callers who pass nothing ───

describe('AC-3 (BL-440) — default policy (no opts) preserves today\'s six-kind / ten-rel behaviour exactly', () => {
  it('every DEFAULT_NODE_KINDS value round-trips through writeNode/getNode unchanged', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter);
    await backend.applySchema();

    for (const kind of DEFAULT_NODE_KINDS) {
      const id = await backend.writeNode(`content for ${kind}`, { kind });
      const node = await backend.getNode(id);
      expect(node).not.toBeNull();
      expect(node!.kind).toBe(kind);
    }

    await adapter.close();
  });

  it('every DEFAULT_EDGE_RELS value round-trips through writeEdge/getEdges unchanged', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter);
    await backend.applySchema();

    const a = await backend.writeNode('a', {});
    const b = await backend.writeNode('b', {});

    for (const rel of DEFAULT_EDGE_RELS) {
      await backend.writeEdge(a, b, rel);
      const edges = await backend.getEdges({ rel });
      expect(edges.some((e) => e.src === a && e.dst === b && e.rel === rel)).toBe(true);
    }

    await adapter.close();
  });

  it('kind: "entitiy" (typo) throws ConstraintError', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter);
    await backend.applySchema();

    await expect(backend.writeNode('typo kind', { kind: 'entitiy' })).rejects.toThrow(
      ConstraintError,
    );

    await adapter.close();
  });

  it('an edge rel not in the ten (e.g. BOGUS_REL) throws ConstraintError', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter);
    await backend.applySchema();

    const a = await backend.writeNode('a', {});
    const b = await backend.writeNode('b', {});

    await expect(backend.writeEdge(a, b, 'BOGUS_REL' as EdgeRel)).rejects.toThrow(ConstraintError);

    await adapter.close();
  });
});

// ── AC-4 — the ConstraintError message no longer steers toward kind:'generic' ─

describe("AC-4 (BL-440) — the unknown-kind ConstraintError message drops the 'Non-memory reuse' steering sentence", () => {
  it('message contains "Allowed kinds:" and the six kind names, but not the old steering text', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    const backend = createGraphBackend(adapter);
    await backend.applySchema();

    let caught: unknown;
    try {
      await backend.writeNode('bogus kind node', { kind: 'not-a-real-kind' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConstraintError);
    const message = (caught as Error).message;

    expect(message).not.toContain('Non-memory reuse');
    expect(message).not.toContain('instead of registering a new kind');

    expect(message).toContain('Allowed kinds:');
    for (const kind of DEFAULT_NODE_KINDS) {
      expect(message).toContain(kind);
    }

    await adapter.close();
  });
});
