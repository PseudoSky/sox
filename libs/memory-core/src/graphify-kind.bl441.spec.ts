/**
 * BL-441 (PKT-60) AC-1/AC-2 — graphifyImport's v2-shape `kind` field is
 * validated against MemoryOntologyPolicy before it reaches the raw SQL
 * INSERT (extensions.ts:614-624).
 *
 * RED arm (AC-1): before this packet's extensions.ts edit, the identical call
 * `graphifyImport(adapter, {version:2, nodes:[{uid:'x', kind:'entitiy', ...}], edges:[]})`
 * SUCCEEDS — returns `{ ok: true, imported: 1, ... }` and a
 * `SELECT kind FROM node WHERE uid = 'x'` returns 'entitiy'. Confirmed by
 * temporarily removing the `validateKind` call and re-running (see inline
 * note below the test) — with the fix restored (as committed) the identical
 * call now returns `{ ok: false, ... }` and no row with kind='entitiy' exists.
 *
 * AC-2: the exact non-regression companion — a legitimate v2 kind ('entity')
 * still imports successfully end to end.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './db.js';
import { graphifyImport } from './extensions.js';

async function tmpAdapter(): Promise<{ adapter: StoreAdapter; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphify-kind-bl441-'));
  const dbPath = path.join(dir, 'p.db');
  const adapter = await openDb(dbPath);
  return {
    adapter,
    cleanup: () => {
      try {
        adapter.close();
      } catch {
        /* already closed */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe('AC-1 (BL-441) — unregistered kind via graphifyImport v2 is rejected', () => {
  it('rejects kind:"entitiy" (typo, unregistered) — returns {ok:false}, no row written', async () => {
    const { adapter, cleanup } = await tmpAdapter();
    cleanups.push(cleanup);

    const result = await graphifyImport(adapter, {
      version: 2,
      nodes: [{ uid: 'x', kind: 'entitiy', content: 'y' }],
      edges: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/entitiy/);
      expect(result.partial).toBe(false);
    }

    const row = await adapter.executeGet<{ kind: string }>(
      `SELECT kind FROM node WHERE uid = 'x'`,
    );
    expect(row).toBeNull();
  });

  it('atomicity: a rejected v2 import writes zero rows even with a valid node earlier in the batch', async () => {
    const { adapter, cleanup } = await tmpAdapter();
    cleanups.push(cleanup);

    const result = await graphifyImport(adapter, {
      version: 2,
      nodes: [
        { uid: 'good', kind: 'entity', content: 'legit node' },
        { uid: 'bad', kind: 'entitiy', content: 'typo node' },
      ],
      edges: [],
    });

    expect(result.ok).toBe(false);

    const rows = await adapter.executeAll<{ uid: string }>(
      `SELECT uid FROM node WHERE uid IN ('good', 'bad')`,
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe('AC-2 (BL-441 non-regression) — legitimate v2 kind still works end to end', () => {
  it('kind:"entity" imports successfully, row round-trips with kind="entity"', async () => {
    const { adapter, cleanup } = await tmpAdapter();
    cleanups.push(cleanup);

    const result = await graphifyImport(adapter, {
      version: 2,
      nodes: [{ uid: 'x', kind: 'entity', content: 'y' }],
      edges: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.imported).toBe(1);
    }

    const row = await adapter.executeGet<{ kind: string }>(
      `SELECT kind FROM node WHERE uid = 'x'`,
    );
    expect(row?.kind).toBe('entity');
  });

  it('all six MEMORY_NODE_KINDS import successfully via graphifyImport v2', async () => {
    const { adapter, cleanup } = await tmpAdapter();
    cleanups.push(cleanup);

    const kinds = ['episode', 'entity', 'claim', 'community', 'session', 'generic'];
    const result = await graphifyImport(adapter, {
      version: 2,
      nodes: kinds.map((kind, i) => ({ uid: `n-${i}-${kind}`, kind, content: `content ${i}` })),
      edges: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.imported).toBe(kinds.length);
    }

    for (let i = 0; i < kinds.length; i++) {
      const row = await adapter.executeGet<{ kind: string }>(
        `SELECT kind FROM node WHERE uid = 'n-${i}-${kinds[i]}'`,
      );
      expect(row?.kind).toBe(kinds[i]);
    }
  });
});
