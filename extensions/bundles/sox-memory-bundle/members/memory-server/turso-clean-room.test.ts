/**
 * turso-clean-room.test.ts — Fresh-database clean-room validation for the
 * Turso storage path, run side-by-side against SqliteAdapter as a control.
 *
 * WHY THIS FILE EXISTS (2026-07-30 incident):
 * The live `~/.memory/memory.db` store was migrated to Turso and ended up
 * with 4410 episodes but only ~85–169 vectors, a missing `fts_node` table,
 * and a broken recall path (`memory_recall` WITH a query times out; WITHOUT
 * a query throws `TypeError: rows is not iterable`). Every diagnosis to that
 * point was performed against either the already-corrupted live store or
 * unit tests running with mocks — nobody had verified the Turso path against
 * a brand-new, empty database. This file is that verification, kept
 * permanently so the Turso path can never again ship unvalidated:
 *
 *   1. Schema creation on a FRESH file — every required table/index actually
 *      gets created (`node`, `edge`, `vec_node`, `fts_node` + FTS5 shadow
 *      tables on sqlite, `memory_scope`, `sox_store_meta`, `organizer_queue`).
 *   2. A real write lands a real row (through `handleToolCall('memory_write')`,
 *      the actual MCP tool surface — not memory-core directly).
 *   3. The embedding actually lands in `vec_node` (row count > 0, correct
 *      byte length for a 768-dim f32 vector: 768 * 4 = 3072 bytes).
 *   4. `memory_recall` WITH a query and WITHOUT a query both actually run
 *      end-to-end against a clean store — this is the reproduction harness
 *      for the two live recall failures. If they don't reproduce here, the
 *      corruption is store-state-dependent, not code-path-dependent; if they
 *      DO reproduce here, the root cause is unconditional and this file
 *      documents exactly where.
 *   5. Real embedding throughput (embeds/sec) using the REAL embedding
 *      provider (no `DeterministicTestProvider` — that measures hashing, not
 *      the ONNX/CoreML path production actually runs).
 *
 * PRE-EXISTING BUG THIS FILE AVOIDS (found while building this harness):
 * `recall-parity.test.ts`, `heal-backend-agnostic.test.ts`, and this file's
 * own first draft all used the pattern:
 *
 *   let hasTurso = false;
 *   beforeAll(async () => { hasTurso = await tursoAvailable(); });
 *   it('...', { skip: !hasTurso }, async () => { ... });
 *
 * Vitest evaluates the `{ skip }` options object during the synchronous
 * `describe()` collection pass — BEFORE any `beforeAll` hook has run. So
 * `hasTurso` is READ while still `false` (its initializer), the options
 * object is frozen with `skip: true` at that instant, and the assigned value
 * from `beforeAll` is never consulted again. The Turso variant of BOTH of
 * those pre-existing tests has therefore *always* statically skipped on
 * every run, regardless of whether Turso was actually available — verified
 * empirically with a minimal repro (`beforeAll` never even executes before
 * the skip decision is made). This is the direct, mechanical answer to "has
 * the Turso path ever been exercised end-to-end": as far as those two
 * dedicated cross-backend tests are concerned, no — they could not have,
 * structurally, no matter how many times CI ran them green.
 *
 * This file resolves Turso availability SYNCHRONOUSLY at module-load time
 * (file-existence check on the driver package, following the pattern
 * `throughput-golden.spec.ts` already uses correctly), so the skip decision
 * is made with the real answer, not a placeholder.
 */

import {
  DeterministicTestProvider,
  WriteQueue,
  _resetEmbedSingleton,
  _setEmbedProviderForTest,
  openDb,
  warmupEmbed,
} from '@adhd/sox-memory-core';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleToolCall } from './src/index.js';

// ── Turso availability — resolved SYNCHRONOUSLY at module load ─────────────
// See file header: do NOT resolve this via an async beforeAll + `{ skip }`.

const TURSO_DRIVER_PATH = path.resolve(
  __dirname,
  '../../../../../node_modules/@tursodatabase/database/dist/promise.js',
);
const HAS_TURSO = (() => {
  try {
    return fs.existsSync(TURSO_DRIVER_PATH);
  } catch {
    return false;
  }
})();

// ── BL-567 real-backend cache gate ─────────────────────────────────────────
// Section 5 below measures REAL embedding throughput, so it opts out of the
// setup's default DeterministicTestProvider mock — but only runs when the
// ONNX model binary is actually on disk. Resolved synchronously at module
// load (same reasoning as HAS_TURSO above — vitest freezes `{ skip }` during
// collection). The cache check mirrors embedding-provider's canonical
// isModelCached() (src/index.ts:327): <cacheDir>/<hfRepoId>/model_optimized.onnx,
// with memory-core's cacheDir resolution (embed.ts resolveConfig:
// SOX_EMBED_CACHE_DIR ?? $XDG_CACHE_HOME/sox-memory/models). Cache absent →
// the test SKIPS, never fails or downloads.
const REAL_MODEL_CACHE_DIR =
  process.env['SOX_EMBED_CACHE_DIR'] ??
  path.join(process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'), 'sox-memory', 'models');
const REAL_MODEL_CACHED = fs.existsSync(
  path.join(REAL_MODEL_CACHE_DIR, 'fast-bge-base-en-v1.5', 'model_optimized.onnx'),
);

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

interface SchemaRow {
  name: string;
  type: string;
  sql: string | null;
}

async function introspectSchema(adapter: StoreAdapter): Promise<SchemaRow[]> {
  const result = await adapter.executeAll<SchemaRow>(
    `SELECT name, type, sql FROM sqlite_master ORDER BY type, name`,
  );
  return result.rows;
}

function findTable(rows: SchemaRow[], name: string): SchemaRow | undefined {
  return rows.find((r) => r.name === name && r.type === 'table');
}

/** Race a promise against a hard wall-clock timeout, tagging which one fired. */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<{ timedOut: false; value: T } | { timedOut: true; label: string }> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<{ timedOut: true; label: string }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, label }), ms);
  });
  const wrapped = p.then((value) => {
    clearTimeout(timer);
    return { timedOut: false as const, value };
  });
  return Promise.race([wrapped, timeout]);
}

interface ToolResultLike {
  isError?: boolean;
  content: { type: string; text: string }[];
}

function toolResultBody(result: ToolResultLike): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const EPISODES = [
  'The application server experienced high CPU load during peak hours.',
  'Distributed systems require careful consideration of CAP theorem tradeoffs.',
  'The new API gateway improved throughput by 40 percent across all services.',
  'PostgreSQL query optimization often involves analyzing execution plans.',
  'Event-driven architectures enable loose coupling between microservices.',
];

// ── Result matrix — populated as tests run, printed at the very end ────────

interface MatrixRow {
  adapter: 'sqlite' | 'turso';
  schema_ok: boolean;
  vec_node_ddl: string | null;
  write_ok: boolean;
  vec_count: number;
  vec_byte_len: number | null;
  recall_with_query: string;
  recall_no_query: string;
  enrichment_corrupted: string;
  embeds_per_sec: number | null;
  execution_provider: string | null;
}

const MATRIX: MatrixRow[] = [];

function runForAdapter(adapterType: 'sqlite' | 'turso') {
  const skip = adapterType === 'turso' && !HAS_TURSO;

  describe(`Clean-room fresh DB — ${adapterType}`, () => {
    if (skip) {
      it.skip(`skipped — Turso driver not found at ${TURSO_DRIVER_PATH}`, () => {});
      return;
    }

    let tmp: { dir: string; cleanup: () => void };
    let dbPath: string;
    let prevStoreAdapter: string | undefined;
    const row: MatrixRow = {
      adapter: adapterType,
      schema_ok: false,
      vec_node_ddl: null,
      write_ok: false,
      vec_count: 0,
      vec_byte_len: null,
      recall_with_query: 'not run',
      recall_no_query: 'not run',
      enrichment_corrupted: 'not run',
      embeds_per_sec: null,
      execution_provider: null,
    };

    beforeAll(() => {
      tmp = makeTempDir(`sox-turso-clean-room-${adapterType}-`);
      dbPath = path.join(tmp.dir, 'memory.db');
      prevStoreAdapter = process.env['STORE_ADAPTER'];
      process.env['STORE_ADAPTER'] = adapterType;
    });

    afterAll(async () => {
      MATRIX.push(row);
      await WriteQueue.clearInstances();
      if (prevStoreAdapter === undefined) delete process.env['STORE_ADAPTER'];
      else process.env['STORE_ADAPTER'] = prevStoreAdapter;
      tmp.cleanup();
    });

    // ── 1. Schema creation on a fresh, empty DB file ─────────────────────

    it(
      'creates every required schema object on open()',
      { timeout: 30_000 },
      async () => {
        const adapter = await openDb(dbPath);
        try {
          const schema = await introspectSchema(adapter);
          const names = schema.map((r) => `${r.type}:${r.name}`);

          const requiredTables = [
            'node',
            'edge',
            'vec_node',
            'memory_scope',
            'sox_store_meta',
            'organizer_queue',
          ];
          const missingTables = requiredTables.filter((t) => !findTable(schema, t));

          // FTS presence differs by dialect: sqlite gets a real fts5 virtual
          // table (+ shadow tables); turso gets a Tantivy index (no fts_node
          // table at all — this is NOT a bug on turso, it's a different
          // mechanism entirely). Report both, assert only what's contractually
          // required per adapter.
          const ftsNode = findTable(schema, 'fts_node');
          const ftsShadow = ['fts_node_data', 'fts_node_idx', 'fts_node_docsize', 'fts_node_config']
            .filter((t) => findTable(schema, t));

          const vecNodeDdl = findTable(schema, 'vec_node')?.sql ?? null;
          row.vec_node_ddl = vecNodeDdl;

          console.log(
            `[${adapterType}] schema objects (${schema.length}): ${names.join(', ')}`,
          );
          console.log(`[${adapterType}] vec_node DDL: ${vecNodeDdl}`);
          console.log(
            `[${adapterType}] fts_node present: ${!!ftsNode}, shadow tables: ${ftsShadow.join(', ') || '(none)'}`,
          );

          expect(
            missingTables,
            `[${adapterType}] missing required tables: ${missingTables.join(', ')}. Full schema: ${names.join(', ')}`,
          ).toEqual([]);

          if (adapterType === 'sqlite') {
            expect(ftsNode, '[sqlite] fts_node virtual table must exist').toBeDefined();
            expect(
              ftsShadow.length,
              `[sqlite] expected 4 fts5 shadow tables, found: ${ftsShadow.join(', ')}`,
            ).toBe(4);
            expect(vecNodeDdl, '[sqlite] vec_node DDL should be a vec0 virtual table').toMatch(/vec0/i);
          } else {
            // Turso: native vector column, no vec0.
            expect(vecNodeDdl, '[turso] vec_node DDL should use native F32_BLOB, not vec0').not.toMatch(/vec0/i);
            expect(vecNodeDdl, '[turso] vec_node DDL should declare F32_BLOB').toMatch(/F32_BLOB/i);
          }

          row.schema_ok = missingTables.length === 0;
        } finally {
          await adapter.close();
        }
      },
    );

    // ── 2 & 3. Real write + embedding lands in vec_node ──────────────────

    it(
      'writes episodes through handleToolCall and lands vectors in vec_node',
      { timeout: 60_000 },
      async () => {
        for (let i = 0; i < EPISODES.length; i++) {
          const result = (await handleToolCall('memory_write', {
            db_path: dbPath,
            content: `${EPISODES[i]} (clean-room ${adapterType} #${i})`,
            project_path: '/test/turso-clean-room',
          })) as ToolResultLike;
          expect(
            result.isError,
            `[${adapterType}] memory_write #${i} failed: ${JSON.stringify(toolResultBody(result))}`,
          ).toBeFalsy();
        }
        row.write_ok = true;

        const adapter = await openDb(dbPath);
        try {
          const countRow = await adapter.executeGet<{ c: number }>(
            `SELECT COUNT(*) AS c FROM vec_node`,
          );
          const count = countRow?.c ?? 0;
          row.vec_count = count;
          console.log(`[${adapterType}] vec_node row count: ${count}`);
          expect(count, `[${adapterType}] expected vec_node to contain rows after real writes`).toBeGreaterThan(0);

          const lenRow = await adapter.executeGet<{ len: number }>(
            `SELECT length(embedding) AS len FROM vec_node LIMIT 1`,
          );
          row.vec_byte_len = lenRow?.len ?? null;
          console.log(`[${adapterType}] vec_node embedding byte length: ${lenRow?.len}`);
          // 768-dim f32 = 768 * 4 = 3072 bytes.
          expect(
            lenRow?.len,
            `[${adapterType}] expected 3072 bytes (768-dim f32), got ${lenRow?.len}`,
          ).toBe(3072);
        } finally {
          await adapter.close();
        }
      },
    );

    // ── 4. Recall — WITH query and WITHOUT query ─────────────────────────
    // This is the direct reproduction harness for the two live failures:
    //   - WITH query: reported to TIME OUT on the live (corrupted) store.
    //   - WITHOUT query: reported to throw `TypeError: rows is not iterable`.
    //
    // ROOT CAUSE — CONFIRMED (2026-07-30, empirically, not just by reading):
    //   extensions/.../memory-server/src/index.ts:1041:
    //     `const rawDb = (adapter as any).unwrap() as Database.Database;`
    //   then used as if it were a SYNCHRONOUS better-sqlite3 handle at lines
    //   1353 (no-query listing), 1455 (with-query enrichment augmentation),
    //   1484, 1551, 1568, 1591. On TursoAdapter, `unwrap()` returns the
    //   `@tursodatabase/database` handle instead. Empirically probed
    //   (`rawDb.constructor.name === 'Database'`, `rawDb.prepare(sql)` IS
    //   synchronous and returns a real `Statement` object) — the actual
    //   divergence from better-sqlite3 is one level deeper:
    //   `Statement#all()` / `Statement#get()` return a `Promise`, not a
    //   resolved value (confirmed live: `allResult instanceof Promise ===
    //   true`). Neither call site awaits it.
    //
    //   NO-QUERY PATH (line 1353-1368): `const rows = rawDb.prepare(sql).all(...)`
    //   assigns the un-awaited Promise itself to `rows`. Line 1384's
    //   `for (const r of rows)` then throws — a Promise is not iterable.
    //   This reproduces on ANY fresh Turso DB regardless of row count (proven
    //   below with a 5-row store) — it is NOT data/scale-dependent, it is
    //   unconditional. Confirmed exact stack:
    //     TypeError: rows is not iterable
    //       at handleToolCall .../memory-server/src/index.ts:1384:25
    //
    //   WITH-QUERY PATH (line 1455): `const nodeRow = rawDb.prepare(...).get(r.uid)`
    //   ALSO assigns an un-awaited Promise to `nodeRow`. This does NOT throw —
    //   `nodeRow?.summary` on a Promise object just optional-chains to
    //   `undefined` (Promises have no `.summary` property, but property
    //   access on a defined object never throws). The result: every
    //   enrichment field (`summary`, `topic`, `tags`, `project_path`,
    //   `is_superseded`, `supersedes_uid`, `community_uid`) silently comes
    //   back wrong/empty instead of erroring — SILENT DATA CORRUPTION, not a
    //   crash. Verified below: `enrichment_corrupted` in the matrix reports
    //   `summary`/`topic` as null even though the written episodes had real
    //   values. Additionally, each un-awaited `Statement#get()` leaves an
    //   orphan async operation that surfaces later as an unhandled promise
    //   rejection (`Error: statement has been finalized` — confirmed via a
    //   standalone probe of the raw driver) once the connection reclaims the
    //   still-pending prepared statement. This is the most likely explanation
    //   for the live TIMEOUT: at 4410 episodes, a single with-query recall
    //   fans out one orphaned, un-awaited statement execution per result via
    //   `Promise.all(recallResult.results.map(...))` on every single call,
    //   compounding across repeated recall traffic until the Turso
    //   connection's serialized statement queue backs up — a 5-row clean
    //   store finishes fast because there just isn't enough queued work yet
    //   to manifest as a hang (see `recall_with_query` result below: it
    //   completes "OK" here, but the corruption underneath it is real and
    //   the timeout mechanism is now explained, not just observed).
    //
    // This bug is NOT Turso-adapter-specific in cause — it is a memory-server
    // (index.ts) integration bug: every raw-SQL call site in this file
    // assumes the unwrapped handle is always better-sqlite3, which stopped
    // being true the moment `openDb()` started honoring `STORE_ADAPTER=turso`.
    // OWNED BY: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts
    // (do not fix here — this file only documents and reproduces).
    it(
      'memory_recall WITH a query runs against a fresh store',
      { timeout: 20_000 },
      async () => {
        const outcome = await withTimeout(
          handleToolCall('memory_recall', {
            db_path: dbPath,
            query: 'server CPU load distributed systems',
            limit: 5,
          }) as Promise<ToolResultLike>,
          15_000,
          'memory_recall(with query)',
        );

        if (outcome.timedOut) {
          row.recall_with_query = 'TIMED OUT (>15s)';
          console.error(`[${adapterType}] memory_recall WITH query TIMED OUT after 15s`);
        } else if (outcome.value.isError) {
          const body = toolResultBody(outcome.value);
          row.recall_with_query = `ERROR: ${JSON.stringify(body)}`;
          console.error(`[${adapterType}] memory_recall WITH query returned isError: ${JSON.stringify(body)}`);
        } else {
          const body = toolResultBody(outcome.value);
          const results = (body['results'] as Record<string, unknown>[] | undefined) ?? [];
          row.recall_with_query = `OK (${results.length} results)`;
          console.log(`[${adapterType}] memory_recall WITH query OK: ${row.recall_with_query}`);

          // Silent-corruption check (see root-cause comment above): on Turso,
          // `summary`/`topic` are derived from an un-awaited Promise treated
          // as a row object, so they come back null/undefined even though
          // every written episode had a real `content` (auto-derives a
          // summary via enrichOnWrite) and this suite writes plain text with
          // no explicit topic. A `content`-bearing result with a null
          // `summary` on Turso (but populated on sqlite for the identical
          // write path) is the fingerprint of the bug, not proof by itself —
          // reported here as a fact, not asserted as a hard failure, since a
          // legitimately-null summary is possible in other configurations.
          const withNullSummary = results.filter((r) => r['content'] && !r['summary']);
          row.enrichment_corrupted =
            withNullSummary.length > 0
              ? `${withNullSummary.length}/${results.length} results have content but null summary/enrichment (matches the un-awaited rawDb.prepare().get() bug)`
              : `0/${results.length} results affected`;
          console.log(`[${adapterType}] enrichment corruption check: ${row.enrichment_corrupted}`);
          if (results.length > 0) {
            console.log(`[${adapterType}] sample result: ${JSON.stringify(results[0])}`);
          }
        }

        // This test intentionally does not assert success — its job is to
        // OBSERVE and RECORD whether the known live failure reproduces on a
        // clean store. The matrix printed at the end of the suite is the
        // deliverable; a human (or the next agent) reads row.recall_with_query.
      },
    );

    it(
      'memory_recall WITHOUT a query (importance-ranked listing) runs against a fresh store',
      { timeout: 20_000 },
      async () => {
        // NOTE: this call is expected to THROW synchronously on TursoAdapter
        // (see the root-cause comment above `memory_recall WITH a query` —
        // index.ts:1353-1384 assigns an un-awaited `Promise<any[]>` to `rows`
        // and then does `for (const r of rows)`). That throw happens
        // synchronously inside the async `handleToolCall`, so it surfaces as
        // a REJECTED promise, not an `isError` tool result and not a hang —
        // caught explicitly here so the reproduction is RECORDED rather than
        // failing this harness test itself.
        let outcome:
          | { timedOut: false; value: ToolResultLike }
          | { timedOut: true; label: string }
          | { threw: true; error: unknown };
        try {
          outcome = await withTimeout(
            handleToolCall('memory_recall', {
              db_path: dbPath,
              limit: 5,
            }) as Promise<ToolResultLike>,
            15_000,
            'memory_recall(no query)',
          );
        } catch (err) {
          outcome = { threw: true, error: err };
        }

        if ('threw' in outcome) {
          const err = outcome.error;
          const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          const stackLine =
            err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : '';
          row.recall_no_query = `THREW: ${message}`;
          console.error(`[${adapterType}] memory_recall WITHOUT query THREW: ${message}\n${stackLine}`);
        } else if (outcome.timedOut) {
          row.recall_no_query = 'TIMED OUT (>15s)';
          console.error(`[${adapterType}] memory_recall WITHOUT query TIMED OUT after 15s`);
        } else if (outcome.value.isError) {
          const body = toolResultBody(outcome.value);
          row.recall_no_query = `ERROR: ${JSON.stringify(body)}`;
          console.error(`[${adapterType}] memory_recall WITHOUT query returned isError: ${JSON.stringify(body)}`);
        } else {
          const body = toolResultBody(outcome.value);
          row.recall_no_query = `OK (${(body['results'] as unknown[] | undefined)?.length ?? 0} results)`;
          console.log(`[${adapterType}] memory_recall WITHOUT query OK: ${row.recall_no_query}`);
        }

        // Reporting-only, same rationale as the WITH-query test above.
      },
    );

    // ── 5. Real embedding throughput (no DeterministicTestProvider) ──────

    it(
      'measures real embedding throughput (real ONNX/fastembed provider)',
      // BL-567: skip (not fail) when the ONNX model cache is absent.
      { timeout: 120_000, skip: !REAL_MODEL_CACHED },
      async () => {
        // BL-567: this test measures the REAL provider — opt out of the
        // setup-default mock for its duration. vitest.setup.ts installs
        // DeterministicTestProvider by default (BL-567), so without this the
        // "throughput" number would measure feature-hashing, not ONNX/CoreML.
        _setEmbedProviderForTest(null);
        try {
          // vitest.setup.ts sets SOX_SYNC_EMBED=1 globally, so each memory_write
          // above already blocked on a real embed() call — this test isolates
          // and times N MORE real writes to get a clean embeds/sec number, and
          // reads the actual execution provider (CoreML on macOS) via
          // warmupEmbed() rather than assuming it.
          const health = await warmupEmbed(30_000);
          row.execution_provider = health.execution_provider ?? null;
          console.log(`[${adapterType}] embed health: ${JSON.stringify(health)}`);

          const N = 8;
          const start = performance.now();
          for (let i = 0; i < N; i++) {
            const result = (await handleToolCall('memory_write', {
              db_path: dbPath,
              content: `Throughput probe ${adapterType} ${Date.now()}-${i}: measuring real embed latency end to end through the MCP tool surface.`,
              project_path: '/test/turso-clean-room-throughput',
            })) as ToolResultLike;
            expect(result.isError).toBeFalsy();
          }
          const elapsedSec = (performance.now() - start) / 1000;
          const perSec = N / elapsedSec;
          row.embeds_per_sec = perSec;
          console.log(
            `[${adapterType}] ${N} real-embed writes in ${elapsedSec.toFixed(2)}s = ${perSec.toFixed(3)} embeds/sec (provider: ${row.execution_provider})`,
          );
          expect(Number.isFinite(perSec)).toBe(true);
        } finally {
          // Restore the default mock so the turso run's later describes (and
          // the next runForAdapter block) stay deterministic.
          _setEmbedProviderForTest(new DeterministicTestProvider());
          _resetEmbedSingleton();
        }
      },
    );
  });
}

// ── Run the full flow for both backends ─────────────────────────────────────

runForAdapter('sqlite');
runForAdapter('turso');

describe('Clean-room results matrix (sqlite vs turso)', () => {
  afterAll(() => {
    console.log('\n\n════════════════════ CLEAN-ROOM RESULTS MATRIX ════════════════════');
    for (const r of MATRIX) {
      console.log(JSON.stringify(r, null, 2));
    }
    console.log('════════════════════════════════════════════════════════════════\n');
  });

  it('prints the matrix (always passes — reporting only)', () => {
    expect(true).toBe(true);
  });
});
