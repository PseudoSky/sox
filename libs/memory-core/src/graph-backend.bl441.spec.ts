/**
 * BL-441 (PKT-60) AC-3/AC-4 — memory-core's real composition point
 * (getMemoryGraphBackend) rejects an unregistered kind/rel, and accepts every
 * byte-identical MEMORY_NODE_KINDS/MEMORY_EDGE_RELS value end to end.
 *
 * AC-3 RED arm: before this packet, getMemoryGraphBackend does not exist —
 * this whole file fails to compile/run (the strongest possible red, per the
 * spec's own framing). A runtime-red demonstration is included separately:
 * bare createGraphBackend(adapter) (no typePolicy) against a fresh
 * open-schema store silently accepts kind:'entitiy' today — proving the
 * exact gap getMemoryGraphBackend closes — then the demonstration is
 * discarded (kept only as documentation in this comment, not as a live
 * "pattern to follow" test) per the spec's instruction not to let it read as
 * endorsed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// store-adapter is lazy-loaded throughout memory-core (see db.ts's dynamic
// `await import('@adhd/sox-store-adapter')`) — the project's own eslint
// boundary rule forbids a static value import of it here too; only the type
// is imported statically.
import type { SqliteAdapter as SqliteAdapterInstance } from '@adhd/sox-store-adapter';
import { createGraphBackend, ConstraintError } from '@adhd/sox-graph-store';
import type { EdgeRel } from '@adhd/sox-graph-store';
import { getMemoryGraphBackend, MemoryOntologyPolicy, MEMORY_NODE_KINDS, MEMORY_EDGE_RELS } from './index.js';

async function newSqliteAdapter(): Promise<SqliteAdapterInstance> {
  const { SqliteAdapterImpl } = await import('@adhd/sox-store-adapter');
  return new SqliteAdapterImpl(':memory:');
}

const openAdapters: SqliteAdapterInstance[] = [];
function track(adapter: SqliteAdapterInstance): SqliteAdapterInstance {
  openAdapters.push(adapter);
  return adapter;
}
afterEach(async () => {
  while (openAdapters.length > 0) {
    const a = openAdapters.pop()!;
    try {
      await a.close();
    } catch {
      /* already closed */
    }
  }
});

describe('AC-3 (BL-441) — unregistered kind/rel rejected through getMemoryGraphBackend', () => {
  it('writeNode with an unregistered kind throws ConstraintError', async () => {
    const adapter = track(await newSqliteAdapter());
    const backend = getMemoryGraphBackend(adapter);
    await backend.applySchema();

    await expect(backend.writeNode('x', { kind: 'entitiy' })).rejects.toThrow(ConstraintError);
  });

  it('writeEdge with an unregistered rel throws ConstraintError', async () => {
    const adapter = track(await newSqliteAdapter());
    const backend = getMemoryGraphBackend(adapter);
    await backend.applySchema();

    const n1 = await backend.writeNode('a', { kind: 'episode' });
    const n2 = await backend.writeNode('b', { kind: 'episode' });

    await expect(backend.writeEdge(n1, n2, 'BOGUS_REL' as EdgeRel)).rejects.toThrow(ConstraintError);
  });

  // Runtime-red demonstration (not a target-state pattern): bare createGraphBackend
  // with no injected typePolicy defaults to graph-store's own DEFAULT_TYPE_POLICY,
  // which — per this packet's §1b finding — is the SAME six-kind/ten-rel vocabulary
  // MemoryOntologyPolicy copies byte-for-byte (decision 4). So this demonstrates
  // decision 4's "byte-identical" ruling holds, not a live gap: on a fresh
  // open-schema store, bare createGraphBackend(adapter) REJECTS 'entitiy' exactly
  // like getMemoryGraphBackend does today, because DEFAULT_TYPE_POLICY already
  // covers it (PKT-59 landed before this packet). The pre-PKT-59, pre-PKT-58 gap
  // this packet forecloses is prospective (§1b) — there is no live-runtime-red
  // demonstration available post-PKT-59 short of reverting graph-store itself,
  // which is out of bounds for this packet (§2). AC-3's compile-red (above,
  // getMemoryGraphBackend not existing pre-packet) is the actual red arm.
  it('documents that bare createGraphBackend already rejects the same bogus kind (DEFAULT_TYPE_POLICY parity, decision 4)', async () => {
    const adapter = track(await newSqliteAdapter());
    const bareBackend = createGraphBackend(adapter); // no typePolicy injected
    await bareBackend.applySchema();

    await expect(bareBackend.writeNode('x', { kind: 'entitiy' })).rejects.toThrow(ConstraintError);
  });
});

describe('AC-4 (BL-441 non-regression) — every MEMORY_NODE_KINDS/MEMORY_EDGE_RELS value is accepted end to end through getMemoryGraphBackend', () => {
  it.each(MEMORY_NODE_KINDS)('writeNode/getNode round-trips kind "%s"', async (kind) => {
    const adapter = track(await newSqliteAdapter());
    const backend = getMemoryGraphBackend(adapter);
    await backend.applySchema();

    const id = await backend.writeNode(`content for ${kind}`, { kind });
    const node = await backend.getNode(id);
    expect(node?.kind).toBe(kind);
  });

  it.each(MEMORY_EDGE_RELS)('writeEdge/getEdges round-trips rel "%s"', async (rel) => {
    const adapter = track(await newSqliteAdapter());
    const backend = getMemoryGraphBackend(adapter);
    await backend.applySchema();

    const a = await backend.writeNode('node a', { kind: 'episode' });
    const b = await backend.writeNode('node b', { kind: 'episode' });
    await backend.writeEdge(a, b, rel as EdgeRel);

    const edges = await backend.getEdges({ rel: rel as EdgeRel });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.rel).toBe(rel);
  });
});

describe('AC-4 (BL-441) — MemoryOntologyPolicy accepts its own vocabulary directly (constructor-level parity)', () => {
  it('every MEMORY_NODE_KINDS value passes validateKind with no extension', () => {
    const policy = new MemoryOntologyPolicy();
    for (const kind of MEMORY_NODE_KINDS) {
      expect(() => policy.validateKind(kind)).not.toThrow();
    }
  });

  it('every MEMORY_EDGE_RELS value passes validateRel with no extension', () => {
    const policy = new MemoryOntologyPolicy();
    for (const rel of MEMORY_EDGE_RELS) {
      expect(() => policy.validateRel(rel)).not.toThrow();
    }
  });
});

describe('AC-6 (BL-440 invariant, re-verified after PKT-60) — TypePolicy still has no path to DDL', () => {
  // This packet does not touch graph-store/src/index.ts at all (§2, out of bounds) —
  // this is a regression tripwire, not a red/green pair. If it is ever red, STOP:
  // this packet or a concurrent one has created a path from a consumer's type
  // declaration to DDL (the BL-295/BL-313 failure mode ADR-0010 D2 forecloses).
  // FEAT-013 added `validateEdge` to the write boundary (writeEdgeInternal) — two
  // more `this.typePolicy` occurrences, still NOT in applySchema/ensureCheckConstraints,
  // so the count is 5 and the invariant (no path to DDL) still holds.
  it('this.typePolicy appears exactly 5 times, none inside applySchema or ensureCheckConstraints', () => {
    const graphStoreIndexPath = join(
      __dirname,
      '..',
      '..',
      'data',
      'graph',
      'graph-store',
      'src',
      'index.ts',
    );
    const text = readFileSync(graphStoreIndexPath, 'utf8');
    const lines = text.split('\n');

    const typePolicyLines: number[] = [];
    lines.forEach((line, idx) => {
      if (line.includes('this.typePolicy')) typePolicyLines.push(idx + 1); // 1-indexed
    });
    expect(typePolicyLines).toHaveLength(5);

    // Locate applySchema / ensureCheckConstraints method bodies by their own
    // brace-matched extent, so this assertion self-heals if the methods move —
    // it does not hardcode a line range that could silently drift stale.
    const methodRange = (signaturePattern: RegExp): [number, number] => {
      const startIdx = lines.findIndex((l) => signaturePattern.test(l));
      if (startIdx === -1) throw new Error(`Method matching ${signaturePattern} not found`);
      let depth = 0;
      let started = false;
      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i]!;
        for (const ch of line) {
          if (ch === '{') {
            depth++;
            started = true;
          } else if (ch === '}') {
            depth--;
          }
        }
        if (started && depth === 0) return [startIdx + 1, i + 1]; // 1-indexed inclusive
      }
      throw new Error(`Could not find matching closing brace for ${signaturePattern}`);
    };

    const [applySchemaStart, applySchemaEnd] = methodRange(/async applySchema\(/);
    const [ensureCheckStart, ensureCheckEnd] = methodRange(/private async ensureCheckConstraints\(/);

    for (const line of typePolicyLines) {
      const insideApplySchema = line >= applySchemaStart && line <= applySchemaEnd;
      const insideEnsureCheck = line >= ensureCheckStart && line <= ensureCheckEnd;
      expect(insideApplySchema).toBe(false);
      expect(insideEnsureCheck).toBe(false);
    }
  });
});
