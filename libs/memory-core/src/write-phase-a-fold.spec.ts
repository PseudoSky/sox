/**
 * write-phase-a-fold.spec.ts — PERF-MEMORY-003.
 *
 * Phase A used to INSERT the node and then issue a SECOND UPDATE over the same
 * row to store the enrichment columns. `summary` and `tags` are covered by the
 * FTS index, so that second write redid FTS maintenance the INSERT had already
 * done — measured at ~134ms, ~56% of Phase A. The enrichment computation itself
 * is ~3.7ms and pure, so it now runs BEFORE the insert and its values are folded
 * in.
 *
 * Two guards, per BL-225:
 *   1. BEHAVIOUR — the persisted row is identical to what the two-step path
 *      produced. This is the correctness gate.
 *   2. STATEMENT COUNT — the write issues exactly ONE node-write statement.
 *      This is the REGRESSION gate: without it, someone re-adds an enrichment
 *      UPDATE, every assertion in (1) still passes, and the ~134ms silently
 *      comes back with nothing to catch it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { memoryWritePhaseA } from './write.js';
import { computeWriteEnrichment } from './enrich.js';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

function raw(a: StoreAdapter): Database.Database {
  return a.unwrap() as Database.Database;
}

let priorAdapterEnv: string | undefined;
beforeEach(() => {
  priorAdapterEnv = process.env['STORE_ADAPTER'];
  process.env['STORE_ADAPTER'] = 'sqlite';
});
afterEach(() => {
  if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = priorAdapterEnv;
});

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phaseafold-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

interface NodeRow {
  summary: string | null;
  tags: string | null;
  topic: string | null;
  project_path: string | null;
  importance: number | null;
  enrich_ver: string | null;
  t_updated: string | null;
}

const PROJECT = '/tmp/phase-a-fold';

describe('PERF-MEMORY-003 — Phase-A enrichment folded into the INSERT', () => {
  it('persists every enrichment column, with the extractive summary fallback applied', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await openDb(path.join(dir, 'm.db'));
      // No caller summary/topic/importance → every fallback path must run.
      const content =
        'The incremental cluster join loads every live community member vector. ' +
        'It then computes cosine similarity against the candidate embedding. ' +
        'Finally it joins the highest-similarity community above the threshold.';

      const res = await memoryWritePhaseA(adapter, { content, project_path: PROJECT });
      const uid = (res as { result: { episode_uid: string } }).result.episode_uid;

      const row = raw(adapter)
        .prepare(
          `SELECT summary, tags, topic, project_path, importance, enrich_ver, t_updated
             FROM node WHERE uid = ?`,
        )
        .get(uid) as NodeRow;

      // The values the shared pure resolver says should be stored. NOTE the
      // `importance: 1.0` — `memoryWritePhaseA` destructures `importance = 1.0`
      // (write.ts:197), so by the time enrichment runs the value is never
      // `undefined`. This spec asserts what the write path ACTUALLY produces,
      // pre- and post-fold alike; see PERF-MEMORY-004 for the separate,
      // pre-existing defect that this default makes E7's computeImportance
      // unreachable and stamps every write as a user override.
      const expected = computeWriteEnrichment({
        content,
        summary: undefined,
        tags: undefined,
        topic: undefined,
        project_path: PROJECT,
        importance: 1.0,
      });

      expect(row.summary).toBe(expected.summary);
      expect(row.summary).not.toBeNull(); // extractive fallback actually ran
      expect(row.importance).toBe(expected.importance);
      expect(row.project_path).toBe(PROJECT);
      // BL-325: empty tags persist as NULL, never the literal '[]'.
      expect(row.tags).toBeNull();
      expect(row.enrich_ver).not.toBeNull();
      expect(JSON.parse(row.enrich_ver!).pass).toBe(expected.enrich_ver.pass);
      expect(row.t_updated).not.toBeNull();

      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('respects caller-supplied importance, topic, summary and tags (no override)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await openDb(path.join(dir, 'm.db'));
      const res = await memoryWritePhaseA(adapter, {
        content: 'Caller supplies everything explicitly here, so no fallback may run.',
        project_path: PROJECT,
        summary: 'CALLER SUMMARY',
        topic: 'caller-topic',
        tags: ['alpha', 'beta'],
        importance: 9,
      });
      const uid = (res as { result: { episode_uid: string } }).result.episode_uid;

      const row = raw(adapter)
        .prepare(
          `SELECT summary, tags, topic, project_path, importance, enrich_ver, t_updated
             FROM node WHERE uid = ?`,
        )
        .get(uid) as NodeRow;

      expect(row.summary).toBe('CALLER SUMMARY');
      expect(row.topic).toBe('caller-topic');
      expect(JSON.parse(row.tags!)).toEqual(['alpha', 'beta']);
      // Caller-asserted importance must survive verbatim (CONTRACTS.md C2.1).
      expect(row.importance).toBe(9);
      // …and be marked as a user override in the provenance stamp.
      expect(JSON.parse(row.enrich_ver!).note).toBe('user_override');

      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('parses a [topic] content prefix when no explicit topic is supplied', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await openDb(path.join(dir, 'm.db'));
      const res = await memoryWritePhaseA(adapter, {
        content: '[inferred-topic] body text that follows the bracketed topic prefix.',
        project_path: PROJECT,
      });
      const uid = (res as { result: { episode_uid: string } }).result.episode_uid;
      const row = raw(adapter)
        .prepare(`SELECT topic FROM node WHERE uid = ?`)
        .get(uid) as NodeRow;
      expect(row.topic).toBe('inferred-topic');
      await adapter.close();
    } finally {
      cleanup();
    }
  });

  /**
   * THE REGRESSION GATE. Counts node-writing statements for a single write.
   *
   * RED before the fold: 2 (INSERT + enrichOnWrite's UPDATE).
   * GREEN after:         1 (INSERT only).
   *
   * Every other assertion in this file passes in BOTH states — this is the only
   * one that fails if the redundant FTS-rewriting UPDATE is reintroduced.
   */
  it('issues exactly ONE node-write statement per write (no second UPDATE)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await openDb(path.join(dir, 'm.db'));

      const nodeWrites: string[] = [];
      const seen = (sql: unknown): void => {
        if (typeof sql !== 'string') return;
        const s = sql.replace(/\s+/g, ' ').trim();
        // Count writes to the EPISODE row only. Deliberately excluded:
        //   - `INSERT INTO node (... 'entity' ...)` (write.ts:395) — entity nodes
        //     for tags/MENTIONS are separate rows, not this episode.
        //   - `UPDATE node SET embed_model` (embed-pipeline.ts:452) — Phase B, and
        //     not reachable from memoryWritePhaseA anyway.
        const isEpisodeInsert = /^INSERT\s+INTO\s+node\b/i.test(s) && !/'entity'/i.test(s);
        const isEpisodeUpdate = /^UPDATE\s+node\b/i.test(s) && !/embed_model/i.test(s);
        if (isEpisodeInsert || isEpisodeUpdate) nodeWrites.push(s.slice(0, 60));
      };

      // Proxy the adapter so both direct calls and in-transaction calls are seen.
      const wrapTx = (tx: object): object =>
        new Proxy(tx, {
          get(o, k, r) {
            const v = Reflect.get(o, k, r);
            if (typeof v !== 'function') return v;
            const name = String(k);
            if (name === 'executeRun' || name === 'executeGet' || name === 'executeAll') {
              return (...args: unknown[]) => {
                seen(args[0]);
                return (v as (...a: unknown[]) => unknown).apply(o, args);
              };
            }
            return (v as (...a: unknown[]) => unknown).bind(o);
          },
        });

      const spy = new Proxy(adapter as object, {
        get(o, k, r) {
          const v = Reflect.get(o, k, r);
          if (typeof v !== 'function') return v;
          const name = String(k);
          if (name === 'executeRun' || name === 'executeGet' || name === 'executeAll') {
            return (...args: unknown[]) => {
              seen(args[0]);
              return (v as (...a: unknown[]) => unknown).apply(o, args);
            };
          }
          if (name === 'transaction') {
            return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
              (v as (...a: unknown[]) => unknown).apply(o, [
                (tx: object) => fn(wrapTx(tx)),
                ...rest,
              ]);
          }
          return (v as (...a: unknown[]) => unknown).bind(o);
        },
      }) as StoreAdapter;

      await memoryWritePhaseA(spy, {
        content: 'A single write must touch the node row exactly once, not twice.',
        project_path: PROJECT,
      });

      expect(nodeWrites.length).toBe(1);
      expect(nodeWrites[0]).toMatch(/^INSERT INTO node/i);

      await adapter.close();
    } finally {
      cleanup();
    }
  });
});
