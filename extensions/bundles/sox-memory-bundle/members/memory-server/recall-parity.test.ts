/**
 * recall-parity.test.ts — Cross-backend recall parity tests.
 *
 * Verifies that SqliteAdapter and TursoAdapter produce ≥80% similarity in
 * rank order and node UIDs for the same write+recall workload.
 *
 * Uses the BL-161 deterministic test embedding provider (feature hashing) —
 * no real ONNX, no I/O delays. SOX_SYNC_EMBED=1 is set by vitest.setup.ts
 * so embeddings land inline with writes (no async Phase-B race).
 */

import {
  _resetEmbedSingleton,
  _setEmbedProviderForTest,
  DeterministicTestProvider,
  memoryRecall,
  memoryWrite,
  openDb,
} from '@adhd/sox-memory-core';
import type {
  RecallResponse,
  RecallResult,
  WriteResult,
} from '@adhd/sox-memory-core';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
process.stderr.write('[recall-parity] FILE LOADED\n');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-recall-parity-'));
  return {
    dir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ── Turso availability — resolved SYNCHRONOUSLY at module load ─────────────
//
// This MUST NOT be resolved in an async `beforeAll`. Vitest evaluates the
// `{ skip }` options object during the synchronous `describe()` collection
// pass, BEFORE any hook runs — so a `let hasTurso = false` assigned in
// `beforeAll` is read while still `false`, the options object is frozen with
// `skip: true`, and the assigned value is never consulted again. This file used
// to do exactly that, which means its Turso arm had ALWAYS statically skipped on
// every run while reporting green. See the header of `turso-clean-room.test.ts`
// for the full write-up.
const TURSO_DRIVER_PATH = path.resolve(
  __dirname,
  '../../../../../node_modules/@tursodatabase/database/dist/promise.js',
);

/** Whether the Turso driver is present on disk. Synchronous by construction. */
function tursoAvailable(): boolean {
  try {
    return fs.existsSync(TURSO_DRIVER_PATH);
  } catch {
    return false;
  }
}

const HAS_TURSO = tursoAvailable();

const EPISODES = [
  'The quick brown fox jumps over the lazy dog near the riverbank.',
  'Machine learning models require careful feature engineering and validation.',
  'The quarterly financial report shows a 15% increase in revenue across all sectors.',
  'Neural networks can approximate any continuous function given enough parameters.',
  'The team completed the sprint with all user stories delivered on time.',
  'Deep reinforcement learning has achieved superhuman performance in many games.',
  'Project Alpha is entering phase three of development with expanded scope.',
  'Natural language processing has seen remarkable advances with transformer architectures.',
  'The server infrastructure needs to be upgraded to handle increased traffic loads.',
  'Database indexing strategies can dramatically improve query performance for large datasets.',
];

const QUERIES = [
  'fox riverbank wildlife outdoors',
  'machine learning neural deep',
  'financial revenue quarterly growth',
  'transformer NLP language processing',
  'database indexing performance query',
];

async function writeEpisodes(adapter: StoreAdapter): Promise<string[]> {
  const uids: string[] = [];
  for (const content of EPISODES) {
    const result = await memoryWrite(adapter, {
      content,
      project_path: '/test/parity-project',
    });
    const uid = (result as WriteResult).episode_uid;
    if (uid) uids.push(uid);
  }
  return uids;
}

function compareResults(a: RecallResult[], b: RecallResult[]): {
  overlapRatio: number;
  rankSimilarity: number;
} {
  const aUids = a.map((r) => r.uid);
  const bUids = b.map((r) => r.uid);
  const aSet = new Set(aUids);
  const bSet = new Set(bUids);
  const intersection = new Set([...aSet].filter((x) => bSet.has(x)));

  const maxLen = Math.max(aSet.size, bSet.size);
  const overlapRatio = maxLen === 0 ? 0 : intersection.size / maxLen;

  let rankMatches = 0;
  for (let i = 0; i < aUids.length; i++) {
    const uid = aUids[i];
    if (uid === undefined) continue;
    const bIdx = bUids.indexOf(uid);
    if (bIdx !== -1 && Math.abs(i - bIdx) <= 1) {
      rankMatches++;
    }
  }
  const denom = Math.min(aUids.length, intersection.size || 1);
  const rankSimilarity = denom === 0 ? 0 : rankMatches / denom;

  return { overlapRatio, rankSimilarity };
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('Cross-backend recall parity', () => {
  beforeEach(() => {
    _resetEmbedSingleton();
    _setEmbedProviderForTest(new DeterministicTestProvider());
  });

  it(
    'sqlite and turso stores produce ≥80% recall result overlap and rank similarity',
    { skip: !HAS_TURSO },
    async () => {
      const sqliteDir = makeTempDir();
      const tursoDir = makeTempDir();

      try {
        // Create sqlite store
        const prevAdapter = process.env['STORE_ADAPTER'];
        process.env['STORE_ADAPTER'] = 'sqlite';
        let sqliteAdapter: StoreAdapter;
        try {
          sqliteAdapter = await openDb(path.join(sqliteDir.dir, 'memory.db'));
        } finally {
          if (prevAdapter === undefined) {
            delete process.env['STORE_ADAPTER'];
          } else {
            process.env['STORE_ADAPTER'] = prevAdapter;
          }
        }

        // Create turso store
        process.env['STORE_ADAPTER'] = 'turso';
        let tursoAdapter: StoreAdapter;
        try {
          tursoAdapter = await openDb(path.join(tursoDir.dir, 'memory.db'));
        } finally {
          if (prevAdapter === undefined) {
            delete process.env['STORE_ADAPTER'];
          } else {
            process.env['STORE_ADAPTER'] = prevAdapter;
          }
        }

        try {
          const sqliteUids = await writeEpisodes(sqliteAdapter);
          const tursoUids = await writeEpisodes(tursoAdapter);

          expect(sqliteUids.length).toBe(10);
          expect(tursoUids.length).toBe(10);

          let totalOverlap = 0;
          let totalRankSim = 0;
          let queriesRan = 0;

          for (const query of QUERIES) {
            const sqliteResp: RecallResponse = await memoryRecall(
              sqliteAdapter,
              'project',
              { query, limit: 5 },
            );
            const tursoResp: RecallResponse = await memoryRecall(
              tursoAdapter,
              'project',
              { query, limit: 5 },
            );

            if (sqliteResp.results.length === 0 || tursoResp.results.length === 0) {
              continue;
            }

            const { overlapRatio, rankSimilarity } = compareResults(
              sqliteResp.results,
              tursoResp.results,
            );

            totalOverlap += overlapRatio;
            totalRankSim += rankSimilarity;
            queriesRan++;
          }

          expect(queriesRan).toBeGreaterThan(0);

          const avgOverlap = totalOverlap / queriesRan;
          const avgRankSim = totalRankSim / queriesRan;

          expect(avgOverlap).toBeGreaterThanOrEqual(0.80);
          expect(avgRankSim).toBeGreaterThanOrEqual(0.80);
        } finally {
          await sqliteAdapter.close();
          await tursoAdapter.close();
        }
      } finally {
        sqliteDir.cleanup();
        tursoDir.cleanup();
      }
    },
  );
});
