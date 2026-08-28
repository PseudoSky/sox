/**
 * bl618-child-telemetry-bootstrap.spec.ts — BL-618 RED→GREEN.
 *
 * The enrich fork child (`enrich-process-host.ts`) never called
 * `initTelemetry`, so its `sox.stage.cluster.*` / STAGE / OTel records were
 * silently dropped (role `'harness'` fallback, `logSink:'none'`) while the
 * parent (`enrich-isolation.ts`) had no way to know. BL-404 fixed the backend
 * composition root (`index.ts`); it could not — and structurally cannot — fix
 * the fork child, which starts with its own module-level telemetry state.
 *
 * This proves the LIFETIME fix: a spawn-time bootstrap convention. The parent
 * injects `SOX_TELEMETRY_INIT` into the child's env via `forkChild`; the child
 * bootstraps via `bootstrapChildTelemetry`; the child ACKS its state with a
 * `telemetry.ready` message; the parent records the ack and surfaces it on
 * `EnrichIsolatedOk.child_telemetry`.
 *
 * RED (pre-fix): the child's cluster stage records never reach the `logDir`,
 * and `EnrichIsolatedOk.child_telemetry` does not exist. GREEN (post-fix): the
 * child's records land in `<logDir>/memory-core.harness-<date>.jsonl` carrying
 * `service:'memory-core'`, `role:'harness'`, and the child's own `pid`, and the
 * ack is non-null with `logSink:'file'`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { vecToJson } from './embed.js';
import { runEnrichIsolated } from './enrich-isolation.js';

let priorAdapterEnv: string | undefined;
beforeEach(() => {
  priorAdapterEnv = process.env['STORE_ADAPTER'];
  process.env['STORE_ADAPTER'] = 'sqlite';
});
afterEach(() => {
  if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = priorAdapterEnv;
});

function tmpDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function readRecords(filePath: string | null): Record<string, unknown>[] {
  if (filePath === null || !fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A deterministic unit vector — enough for the cluster pass to enter its stage. */
function seedVector(seed: number): Float32Array {
  const vec = new Float32Array(768);
  for (let i = 0; i < 768; i++) vec[i] = Math.sin(seed * (i + 1)) * 0.1;
  return vec;
}

async function insertEpisodeWithVector(
  adapter: StoreAdapter,
  uid: string,
  content: string,
  embedding: Float32Array,
): Promise<void> {
  const info = await adapter.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'))`,
    [uid, content, `hash-${uid}`],
  );
  const rowid = info.lastInsertRowid as number;
  await adapter.executeRun('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)', [
    rowid,
    vecToJson(embedding),
  ]);
}

describe('BL-618: the enrich fork child bootstraps telemetry and acks its state', () => {
  it('produces sox.stage.cluster.* records in the child logDir, with the child\'s pid, and reports child_telemetry', async () => {
    const dbDir = tmpDir('bl618-db-');
    const logDir = path.join(dbDir.dir, 'logs');
    try {
      const dbPath = path.join(dbDir.dir, 'store.db');
      const adapter = await openDb(dbPath);
      // Two similar episodes → a full pass enters the cluster stage (and forms
      // at least a `.start`/`.admitted`, emitted unconditionally on entry).
      await insertEpisodeWithVector(adapter, 'bl618-a', 'Alpha widget factory pipeline module orchestration one.', seedVector(1));
      await insertEpisodeWithVector(adapter, 'bl618-b', 'Alpha widget factory pipeline module orchestration two.', seedVector(1.0001));
      await insertEpisodeWithVector(adapter, 'bl618-distractor', 'Zephyr quokka bagpipe lighthouse unrelated.', seedVector(99));
      // Close the parent connection so the child's own openDb is uncontended.
      await adapter.close();

      const result = await runEnrichIsolated(
        dbPath,
        { incrementalCluster: false },
        120_000,
        { service: 'memory-core', role: 'harness', logSink: 'file', logDir },
      );

      // THE ACK: the child reported its own telemetry state, non-null with a file sink.
      expect(result.ok).toBe(true);
      if (!result.ok) return; // narrow for TS; unreachable on success
      expect(result.child_telemetry).not.toBeNull();
      expect(result.child_telemetry!.logSink).toBe('file');
      expect(result.child_telemetry!.service).toBe('memory-core');
      expect(result.child_telemetry!.role).toBe('harness');

      // THE RECORDS: the child's cluster stage records landed in the logDir —
      // not silently dropped behind the logSink:'none' fallback (the pre-fix
      // shape, where this directory stayed empty and the one-shot BL-404
      // warning was the only tell).
      const records = readRecords(result.child_telemetry!.filePath);
      const clusterRecords = records.filter(
        (r) => typeof r['event'] === 'string' && (r['event'] as string).startsWith('sox.stage.cluster.'),
      );
      expect(clusterRecords.length).toBeGreaterThanOrEqual(1);
      for (const rec of clusterRecords) {
        expect(rec['service']).toBe('memory-core');
        expect(rec['role']).toBe('harness');
        expect(rec['pid']).toBe(result.child_telemetry!.pid);
      }
    } finally {
      dbDir.cleanup();
    }
  }, 120_000);

  it('the child log file name carries the role-qualified component (memory-core.harness)', async () => {
    const dbDir = tmpDir('bl618-db2-');
    const logDir = path.join(dbDir.dir, 'logs');
    try {
      const dbPath = path.join(dbDir.dir, 'store.db');
      const adapter = await openDb(dbPath);
      await insertEpisodeWithVector(adapter, 'bl618-x', 'Alpha widget factory pipeline module orchestration three.', seedVector(2));
      await adapter.close();

      const result = await runEnrichIsolated(
        dbPath,
        { incrementalCluster: true },
        120_000,
        { service: 'memory-core', role: 'harness', logSink: 'file', logDir },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.child_telemetry).not.toBeNull();
      expect(result.child_telemetry!.filePath).toContain('memory-core.harness-');
      expect(result.child_telemetry!.filePath).toContain(logDir);
    } finally {
      dbDir.cleanup();
    }
  }, 120_000);
});
