/**
 * supersession-chain-is-current.spec.ts — Q2 red/green cases for the
 * `is_current` lie and the oldest-vs-newest canonical selection bug.
 *
 * Corrected semantics (docs/plan-drafts/neardup-invalidation-fix-plan.md §3):
 *   is_current := (the queried node's own t_invalid === null)
 *   canonical  := last live node in the oldest-first ordering
 *                 ?? chain[chain.length - 1]   (nothing live: most recent overall)
 */
import { describe, it, expect } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './db.js';
import { memoryGetSupersessionChain } from './supersession-chain.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersession-is-current-spec-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function createDb(dbPath: string): Promise<StoreAdapter> {
  return await openDb(dbPath);
}

describe('memoryGetSupersessionChain — is_current / canonical selection (Q2)', () => {
  it('Case A: an invalidated, edge-free node must never report is_current: true', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await createDb(path.join(dir, 't.db'));
      const now = new Date().toISOString();
      await db.executeRun(
        `INSERT INTO node (uid, kind, content, t_created, t_valid, t_invalid)
         VALUES ('uid-invalid', 'episode', 'invalidated, no edges', ?, ?, ?)`,
        [now, now, now],
      );

      const result = await memoryGetSupersessionChain(db, { uid: 'uid-invalid' });

      // The chain is [self] — no SUPERSEDES edges — so canonical falls back
      // to itself. is_current must still be false because the queried node
      // is invalidated.
      expect(result.chain.length).toBe(1);
      expect(result.is_current).toBe(false);

      await db.close();
    } finally {
      cleanup();
    }
  });

  it('Case B: canonical is the newer live node, not the oldest', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await createDb(path.join(dir, 't.db'));
      // Three-node chain, oldest -> newest: A (live), B (live), C (invalidated).
      // C SUPERSEDES B, B SUPERSEDES A. The oldest two (A, B) are live.
      // Canonical must be B (newer of the live nodes), not A (oldest).
      await db.executeRun(
        `INSERT INTO node (uid, kind, content, t_created, t_valid, t_invalid)
         VALUES ('uid-a', 'episode', 'A oldest, live', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
      );
      await db.executeRun(
        `INSERT INTO node (uid, kind, content, t_created, t_valid, t_invalid)
         VALUES ('uid-b', 'episode', 'B middle, live', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL)`,
      );
      await db.executeRun(
        `INSERT INTO node (uid, kind, content, t_created, t_valid, t_invalid)
         VALUES ('uid-c', 'episode', 'C newest, invalidated', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:01.000Z')`,
      );
      // rowids: a=1, b=2, c=3. B SUPERSEDES A (src=2,dst=1); C SUPERSEDES B (src=3,dst=2).
      await db.executeRun(
        `INSERT INTO edge (src, dst, rel, origin, t_created)
         VALUES (2, 1, 'SUPERSEDES', 'user_asserted', '2026-01-02T00:00:00.000Z')`,
      );
      await db.executeRun(
        `INSERT INTO edge (src, dst, rel, origin, t_created)
         VALUES (3, 2, 'SUPERSEDES', 'user_asserted', '2026-01-03T00:00:00.000Z')`,
      );

      const result = await memoryGetSupersessionChain(db, { uid: 'uid-c' });

      expect(result.chain.map((l) => l.uid)).toEqual(['uid-a', 'uid-b', 'uid-c']);
      // uid-b is the newer of the two live nodes (a, b) — canonical must be uid-b, not uid-a.
      expect(result.canonical_uid).toBe('uid-b');
      // The queried node (uid-c) is itself invalidated.
      expect(result.is_current).toBe(false);

      await db.close();
    } finally {
      cleanup();
    }
  });

  it('Case C (regression): live, edge-free node — canonical is self, is_current true', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await createDb(path.join(dir, 't.db'));
      const now = new Date().toISOString();
      await db.executeRun(
        `INSERT INTO node (uid, kind, content, t_created, t_valid)
         VALUES ('uid-live', 'episode', 'live, no edges', ?, ?)`,
        [now, now],
      );

      const result = await memoryGetSupersessionChain(db, { uid: 'uid-live' });

      expect(result.canonical_uid).toBe('uid-live');
      expect(result.is_current).toBe(true);

      await db.close();
    } finally {
      cleanup();
    }
  });

  it('Case D: two live nodes, B SUPERSEDES A, query B — canonical is B, is_current true', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await createDb(path.join(dir, 't.db'));
      await db.executeRun(
        `INSERT INTO node (uid, kind, content, t_created, t_valid)
         VALUES ('uid-a', 'episode', 'A', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      );
      await db.executeRun(
        `INSERT INTO node (uid, kind, content, t_created, t_valid)
         VALUES ('uid-b', 'episode', 'B', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
      );
      // rowids: a=1, b=2. B SUPERSEDES A.
      await db.executeRun(
        `INSERT INTO edge (src, dst, rel, origin, t_created)
         VALUES (2, 1, 'SUPERSEDES', 'user_asserted', '2026-01-02T00:00:00.000Z')`,
      );

      const result = await memoryGetSupersessionChain(db, { uid: 'uid-b' });

      expect(result.chain.map((l) => l.uid)).toEqual(['uid-a', 'uid-b']);
      expect(result.canonical_uid).toBe('uid-b');
      expect(result.is_current).toBe(true);

      await db.close();
    } finally {
      cleanup();
    }
  });
});
