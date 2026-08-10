/**
 * INVESTIGATION-SOXGRAPH-001 — empirical probe: does Turso support recursive CTEs?
 *
 * A handoff claim asserted "Turso lacks recursive CTEs" and proposed building an
 * iterative getSupersessionChain fallback. The graph-store's getSupersessionChain
 * (`libs/data/graph/graph-store/src/index.ts`) relies on `WITH RECURSIVE` for its
 * supersession-chain walk — if the claim were TRUE, that query errors on every
 * real Turso store and the fallback design would be required.
 *
 * The probe settles the question empirically against BOTH real adapters — no
 * mocks, no env gates, no describe.skip.
 *
 * **SQLite arm (unchanged):** both raw queries execute — SQLite supports
 * recursive CTEs, so the raw SQL is the ground truth there.
 *
 * **Turso arm (CANARY FLIP, SOXGRAPH-001):** the engine (0.7.x) rejects
 * `WITH RECURSIVE` at prepare, so raw-SQL execution is impossible. The arm now
 * checks what the PUBLIC surface promises instead:
 *   - Query 1 becomes a flag-truth check: `capabilities.recursiveCte` must be
 *     `false` on 0.7.x, and the raw counter CTE must still THROW — the loud
 *     0.8.x migration signal (when Turso Database Rust >= 0.8.0 lands, this
 *     test flips red and tells the operator to delete the fallback).
 *   - Query 2's public-API proof — graph-store's getSupersessionChain returning
 *     [v1, v2, v3] via the iterative fallback on this same 0.7.x engine —
 *     lives in graph-store's OWN suite ("recursive-cte fallback parity",
 *     graph-store.spec.ts, turso arm). It cannot live here: graph-store
 *     depends on store-adapter, so a store-adapter test importing graph-store
 *     would close the project-graph cycle and break every `nx build`/`nx test`
 *     of both packages (verified 2026-08-10). The probe file stays the
 *     flag-truth canary; the parity suite carries the end-to-end proof.
 *
 * SAFETY: both adapters are constructed against fresh temp dbPath files under
 * the OS tmpdir — never `~/.memory/*`, never the live store.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteAdapter, createTursoAdapter } from '../factory.js';
import type { StoreAdapter } from '../types.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'recursive-cte-probe-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

const openAdapters: StoreAdapter[] = [];

async function openSqlite(label: string): Promise<StoreAdapter> {
  const adapter = createSqliteAdapter({ dbPath: tempPath(label) });
  openAdapters.push(adapter);
  return adapter;
}

async function openTurso(label: string): Promise<StoreAdapter> {
  // Local file, via the factory — the adapter's own connect() defaults already
  // carry experimental ['index_method', 'multiprocess_wal'] (BL-321 follow-up);
  // neither is required for a plain recursive-CTE SELECT, so no extra opts.
  const adapter = await createTursoAdapter({ dbPath: tempPath(label) });
  openAdapters.push(adapter);
  return adapter;
}

afterEach(async () => {
  while (openAdapters.length > 0) {
    const a = openAdapters.pop()!;
    try {
      await a.close();
    } catch {
      // already closed — close() is not the subject under test
    }
  }
});

// ── Probe 1: counter CTE (canonical minimal recursion) ──────────────────────

const COUNTER_CTE_SQL = `
  WITH RECURSIVE cnt(x) AS (
    SELECT 1
    UNION ALL
    SELECT x + 1 FROM cnt WHERE x < 5
  )
  SELECT x FROM cnt
`;

async function probeCounterCte(adapter: StoreAdapter): Promise<number[]> {
  const { rows } = await adapter.executeAll<{ x: number }>(COUNTER_CTE_SQL);
  return rows.map((r) => r.x);
}

// ── Probe 2: graph-shaped recursion (exact getSupersessionChain SQL) ─────────

/**
 * The verbatim `WITH RECURSIVE` block from graph-store getSupersessionChain
 * (`libs/data/graph/graph-store/src/index.ts`), with the final projection
 * narrowed to (rowid, name) for this minimal schema. Everything above the final
 * SELECT — `connected` (UNION, bidirectional), `head` (LIMIT 1), `chain`
 * (UNION, depth) — is byte-for-byte the store's query.
 *
 * SUPERSEDES edge direction matches `supersede()`: src = newer, dst = older.
 */
const SUPERSESSION_CHAIN_SQL = `
  WITH RECURSIVE
  connected(rowid) AS (
    SELECT ? AS rowid
    UNION SELECT e.src FROM edge e JOIN connected c ON e.dst = c.rowid WHERE e.rel = 'SUPERSEDES'
    UNION SELECT e.dst FROM edge e JOIN connected c ON e.src = c.rowid WHERE e.rel = 'SUPERSEDES'
  ),
  head(rowid) AS (
    SELECT c.rowid FROM connected c
    WHERE NOT EXISTS (SELECT 1 FROM edge WHERE rel = 'SUPERSEDES' AND src = c.rowid) LIMIT 1
  ),
  chain(rowid, depth) AS (
    SELECT h.rowid, 0 FROM head h
    UNION SELECT e.src, ch.depth + 1 FROM edge e JOIN chain ch ON e.dst = ch.rowid WHERE e.rel = 'SUPERSEDES'
  )
  SELECT n.rowid, n.name FROM node n JOIN chain ch ON n.rowid = ch.rowid ORDER BY ch.depth
`;

async function probeSupersessionChain(adapter: StoreAdapter): Promise<Array<{ rowid: number; name: string }>> {
  // v1 (rowid 1) → superseded by v2 (rowid 2) → superseded by v3 (rowid 3).
  // Chain walk starts from the middle node; the store returns oldest → newest.
  await adapter.exec('CREATE TABLE node (rowid INTEGER PRIMARY KEY, name TEXT)');
  await adapter.exec('CREATE TABLE edge (src INTEGER, dst INTEGER, rel TEXT)');
  await adapter.executeRun('INSERT INTO node (rowid, name) VALUES (?, ?), (?, ?), (?, ?)', [
    1, 'v1', 2, 'v2', 3, 'v3',
  ]);
  await adapter.executeRun('INSERT INTO edge (src, dst, rel) VALUES (?, ?, ?), (?, ?, ?)', [
    2, 1, 'SUPERSEDES', 3, 2, 'SUPERSEDES',
  ]);
  const { rows } = await adapter.executeAll<{ rowid: number; name: string }>(SUPERSESSION_CHAIN_SQL, [2]);
  return rows;
}

// ── The probes — both adapters, real connections, no gates ───────────────────

describe('recursive CTE probe — better-sqlite3 adapter (INVESTIGATION-SOXGRAPH-001)', () => {
  it('counter CTE returns [1, 2, 3, 4, 5]', async () => {
    const adapter = await openSqlite('sqlite-counter');
    expect(await probeCounterCte(adapter)).toEqual([1, 2, 3, 4, 5]);
  });

  it('graph-shaped recursion (getSupersessionChain SQL) walks v1 → v2 → v3', async () => {
    const adapter = await openSqlite('sqlite-chain');
    const chain = await probeSupersessionChain(adapter);
    expect(chain).toEqual([
      { rowid: 1, name: 'v1' },
      { rowid: 2, name: 'v2' },
      { rowid: 3, name: 'v3' },
    ]);
  });
});

describe('recursive CTE probe — Turso adapter (INVESTIGATION-SOXGRAPH-001)', () => {
  it('counter CTE is REJECTED on Turso 0.7.x — recursiveCte:false, raw query throws (0.8.x migration signal)', async () => {
    const adapter = await openTurso('turso-counter');
    // Flag-truth: the connect-time probe (turso-adapter.ts connect()) must have
    // recorded false on the 0.7.x engine.
    expect(adapter.capabilities.recursiveCte).toBe(false);
    // Raw recursive SQL still throws `Parse error: Recursive CTEs are not yet
    // supported`. When Turso Database Rust >= 0.8.0 lands, this expect flips
    // RED — the migration signal to remove the iterative fallbacks.
    await expect(probeCounterCte(adapter)).rejects.toThrow();
  });

  it('canary note — the public-API fallback proof ([v1, v2, v3] via getSupersessionChain) lives in graph-store.spec.ts parity turso arm', async () => {
    // Deliberately NOT asserted here: asserting it would require importing
    // graph-store, closing the store-adapter ↔ graph-store project-graph
    // cycle (see module doc comment). The parity suite in graph-store.spec.ts
    // ("recursive-cte fallback parity — turso — iterative fallback path")
    // runs the exact same 0.7.x engine through the public API and pins
    // ['v1', 'v2', 'v3'] — the shipped 0.8.0 behavior.
    const adapter = await openTurso('turso-canary-note');
    // The precondition that makes the fallback load: graph-store's
    // constructor reads `capabilities.recursiveCte ?? true` and switches to
    // the iterative walk when it is false — which this engine reports.
    expect(adapter.capabilities.recursiveCte).toBe(false);
  });
});
