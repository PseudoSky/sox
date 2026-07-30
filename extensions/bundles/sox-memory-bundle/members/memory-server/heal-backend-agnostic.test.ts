/**
 * heal-backend-agnostic.test.ts — Cross-backend healMissingVectors tests.
 *
 * Verifies that healMissingVectors works correctly on both SqliteAdapter and
 * TursoAdapter: gaps created by deleting vec_node rows are detected and filled.
 *
 * Uses the BL-161 deterministic test embedding provider — no real ONNX.
 * SOX_SYNC_EMBED=1 is set by vitest.setup.ts.
 */

import {
  _resetEmbedSingleton,
  _setEmbedProviderForTest,
  DeterministicTestProvider,
  healMissingVectors,
  memoryWrite,
  openDb,
  WriteQueue,
} from '@adhd/sox-memory-core';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-heal-agnostic-'));
  return {
    dir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

async function tursoAvailable(): Promise<boolean> {
  try {
    await import('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
}

async function countMissingVectors(adapter: StoreAdapter): Promise<number> {
  const result = await adapter.executeGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM node n
     WHERE n.kind = 'episode'
       AND n.t_invalid IS NULL
       AND n.content IS NOT NULL AND n.content != ''
       AND NOT EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)`,
  );
  return result?.c ?? 0;
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('healMissingVectors — backend agnostic', () => {
  let hasTurso = false;

  beforeAll(async () => {
    hasTurso = await tursoAvailable();
  });

  beforeEach(() => {
    _resetEmbedSingleton();
    _setEmbedProviderForTest(new DeterministicTestProvider());
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
  });

  it('heals missing vectors on SqliteAdapter', async () => {
    const tmpDir = makeTempDir();

    try {
      const dbPath = path.join(tmpDir.dir, 'memory.db');

      // Keep STORE_ADAPTER set for the entire test — WriteQueue.forPath()
      // also reads STORE_ADAPTER when opening its internal connection.
      const prevAdapter = process.env['STORE_ADAPTER'];
      process.env['STORE_ADAPTER'] = 'sqlite';

      let adapter: StoreAdapter;
      try {
        adapter = await openDb(dbPath);
      } catch (err) {
        if (prevAdapter === undefined) delete process.env['STORE_ADAPTER'];
        else process.env['STORE_ADAPTER'] = prevAdapter;
        throw err;
      }

      try {
        // Write 8 episodes
        const episodes = [
          'The application server experienced high CPU load during peak hours.',
          'Distributed systems require careful consideration of CAP theorem tradeoffs.',
          'The new API gateway improved throughput by 40 percent across all services.',
          'PostgreSQL query optimization often involves analyzing execution plans.',
          'Event-driven architectures enable loose coupling between microservices.',
          'The data pipeline processes over one million records per hour.',
          'Container orchestration with Kubernetes simplifies deployment management.',
          'Monitoring and observability are essential for production system reliability.',
        ];

        for (const content of episodes) {
          await memoryWrite(adapter, {
            content,
            project_path: '/test/heal-project',
          });
        }

        // Delete vec_node entries to create gaps
        await adapter.executeRun('DELETE FROM vec_node');

        const missingBefore = await countMissingVectors(adapter);
        expect(missingBefore).toBeGreaterThan(0);

        // healMissingVectors uses WriteQueue internally — keep STORE_ADAPTER=sqlite
        const wq = await WriteQueue.forPath(dbPath);

        try {
          const healResult = await healMissingVectors(adapter, wq);

          expect(healResult.healed).toBeGreaterThan(0);

          const missingAfter = await countMissingVectors(adapter);
          expect(missingAfter).toBe(0);
        } finally {
          await WriteQueue.clearInstances();
        }
      } finally {
        await adapter.close();
        if (prevAdapter === undefined) {
          delete process.env['STORE_ADAPTER'];
        } else {
          process.env['STORE_ADAPTER'] = prevAdapter;
        }
      }
    } finally {
      tmpDir.cleanup();
    }
  });

  it(
    'heals missing vectors on TursoAdapter',
    { skip: !hasTurso },
    async () => {
      const tmpDir = makeTempDir();

      try {
        const dbPath = path.join(tmpDir.dir, 'memory.db');

        const prevAdapter = process.env['STORE_ADAPTER'];
        process.env['STORE_ADAPTER'] = 'turso';

        let adapter: StoreAdapter;
        try {
          adapter = await openDb(dbPath);
        } catch (err) {
          if (prevAdapter === undefined) delete process.env['STORE_ADAPTER'];
          else process.env['STORE_ADAPTER'] = prevAdapter;
          throw err;
        }

        try {
          const episodes = [
            'The application server experienced high CPU load during peak hours.',
            'Distributed systems require careful consideration of CAP theorem tradeoffs.',
            'The new API gateway improved throughput by 40 percent across all services.',
            'PostgreSQL query optimization often involves analyzing execution plans.',
            'Event-driven architectures enable loose coupling between microservices.',
            'The data pipeline processes over one million records per hour.',
            'Container orchestration with Kubernetes simplifies deployment management.',
            'Monitoring and observability are essential for production system reliability.',
          ];

          for (const content of episodes) {
            await memoryWrite(adapter, {
              content,
              project_path: '/test/heal-project',
            });
          }

          await adapter.executeRun('DELETE FROM vec_node');

          const missingBefore = await countMissingVectors(adapter);
          expect(missingBefore).toBeGreaterThan(0);

          const wq = await WriteQueue.forPath(dbPath);

          try {
            const healResult = await healMissingVectors(adapter, wq);

            expect(healResult.healed).toBeGreaterThan(0);

            const missingAfter = await countMissingVectors(adapter);
            expect(missingAfter).toBe(0);
          } finally {
            await WriteQueue.clearInstances();
          }
        } finally {
          await adapter.close();
          if (prevAdapter === undefined) {
            delete process.env['STORE_ADAPTER'];
          } else {
            process.env['STORE_ADAPTER'] = prevAdapter;
          }
        }
      } finally {
        tmpDir.cleanup();
      }
    },
  );
});
