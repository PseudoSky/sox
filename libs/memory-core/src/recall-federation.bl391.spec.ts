/**
 * BL-391 — federated recall's BM25 arm is dead on Turso, and the failure is
 * swallowed.
 *
 * Two things this test proves red→green:
 *
 * 1. Federated recall's BM25 arm genuinely works: `federatedRecall` opens
 *    non-primary stores read-only via `openDbReadOnly` (recall.ts ->
 *    `getFederationConnection` -> db.ts's `openDbReadOnly`), which used to
 *    pass `readonly: true` straight through to Turso's native connect
 *    option. That makes `fts_match` fail with "Resource is read-only" —
 *    measured directly against the real driver (see the store-adapter-level
 *    BL-391 test for the isolated repro). This test proves an FTS-only hit
 *    (findable ONLY via the BM25 channel, not vector similarity, since the
 *    deterministic test embedding provider is content-agnostic) survives
 *    federatedRecall's non-primary-store read path with a real bm25
 *    contribution in its score breakdown.
 *
 * 2. A dead arm is observable, not silently swallowed: `memoryRecall`
 *    previously had `catch { /* FTS query may fail on special chars *\/ }`
 *    around the FTS query — discarding ANY failure, including the
 *    read-only one, with zero signal. This test forces exactly that failure
 *    (a hard-readonly Turso connection, i.e. `openDbReadOnly`'s pre-fix
 *    behavior recreated directly against `TursoAdapterImpl`) and asserts
 *    `response.degradations` carries the real "Resource is read-only"
 *    message through instead of vanishing.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { memoryRecall, federatedRecall, closeFederationConnections } from './recall.js';
import { _shutdownEmbedWorker } from './embed.js';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();

const tursoDescribe = hasTurso ? describe : describe.skip;

afterAll(async () => {
  await closeFederationConnections();
  await _shutdownEmbedWorker();
});

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bl391-${label}-`));
}

tursoDescribe('BL-391 — federated recall BM25 arm + degradation observability', () => {
  it('federatedRecall returns a real BM25 contribution from a non-primary (read-only) store', async () => {
    const dir = tmpDir('federated-bm25');
    const dbPath = path.join(dir, 'project.db');
    const db = await openDb(dbPath);
    try {
      // A distinctive token the deterministic test embedding provider cannot
      // possibly rank highly by "meaning" — the only realistic path to
      // finding it is the FTS/BM25 channel matching the literal token.
      await memoryWrite(db, {
        content: 'the zzzquixotic marmoset ran across the unrelated field of irrelevant nonsense words',
        project_path: '/test/project',
      });
      await memoryWrite(db, {
        content: 'a completely different document about distributed systems and consensus protocols',
        project_path: '/test/project',
      });
    } finally {
      await db.close();
    }

    // federatedRecall never opens dbPath as the writable `db` above again —
    // it always goes through openDbReadOnly (BL-391's fix point).
    const response = await federatedRecall(
      [{ scope: 'project', dbPath }],
      { query: 'zzzquixotic', limit: 10 },
    );

    expect(response.results.length).toBeGreaterThan(0);
    const hit = response.results.find((r) => r.content?.includes('zzzquixotic'));
    expect(hit).toBeDefined();
    expect(hit!.provenance).toContain('fts');
    expect(hit!.score_breakdown.bm25).toBeGreaterThan(0);

    // Clean run — nothing should have degraded.
    expect(response.degradations).toEqual([]);
  });

  it('a dead FTS arm surfaces as a degradation signal instead of being silently swallowed', async () => {
    const dir = tmpDir('degradation-signal');
    const dbPath = path.join(dir, 'project.db');
    const db = await openDb(dbPath);
    try {
      await memoryWrite(db, {
        content: 'a document that is findable by the fts channel with the word zzzquixotic in it',
        project_path: '/test/project',
      });
    } finally {
      await db.close();
    }

    // Recreate the exact pre-fix symptom directly: a Turso connection opened
    // with native readonly:true (no allowFtsInReadonly) — this is what
    // openDbReadOnly used to produce unconditionally, and what BL-391's red
    // arm is defined as ("Resource is read-only" on fts_match).
    // @nx/enforce-module-boundaries: store-adapter is lazy-loaded throughout
    // memory-core — dynamic import matches that convention (see db.ts).
    const { TursoAdapterImpl } = await import('@adhd/sox-store-adapter');
    const hardReadonly = await TursoAdapterImpl.connect({ dbPath, readonly: true });
    try {
      const response = await memoryRecall(hardReadonly, 'project', { query: 'zzzquixotic' });

      // Must NOT throw — the whole recall degrades gracefully...
      // ...but the degradation must be OBSERVABLE, not swallowed to nothing.
      expect(response.degradations).toBeDefined();
      const ftsDegradation = response.degradations?.find((d) => d.startsWith('fts:'));
      expect(ftsDegradation).toBeDefined();
      expect(ftsDegradation).toMatch(/read-only/i);
    } finally {
      await hardReadonly.close();
    }
  });

  it('federatedRecall surfaces an unreachable store as a degradation instead of it silently vanishing from results', async () => {
    const response = await federatedRecall(
      [{ scope: 'project', dbPath: '/nonexistent/path/that/does/not/exist/anywhere.db' }],
      { query: 'anything' },
    );

    expect(response.results).toEqual([]);
    expect(response.degradations.length).toBeGreaterThan(0);
    expect(response.degradations[0]).toMatch(/scope=project/);
  });
});
