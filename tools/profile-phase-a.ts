/**
 * profile-phase-a.ts — per-phase breakdown of `memoryWritePhaseA`, the term
 * that now binds the <600ms write→community-visible target.
 *
 * WHY: `write_queue.write_latency_ms` reads p50 ~919ms (n=11, live) and that is
 * write-kind-only EXECUTION latency in bypass mode (no queue wait) — so it is
 * Phase-A compute + DB, and it is additive with the ~3.6s time_to_vector, since
 * `memoryWrite` awaits Phase A and only THEN embeds (write.ts:509-514).
 * A single-row local insert cannot explain 919ms, so the hypothesis is that
 * synchronous `enrichOnWrite` (write.ts:428-442) dominates. Nobody has measured
 * it. This measures it.
 *
 * METHOD: wrap the StoreAdapter so every executeRun/executeGet/executeAll/
 * transaction is timed and attributed to a SQL fingerprint. Then:
 *     total wall time  −  Σ(DB time)  =  in-process compute
 * which separates "the database is slow" from "enrichment is slow" — two very
 * different fixes.
 *
 * SAFETY: operates ONLY on a caller-supplied COPY of the store (writes are
 * intrinsic to profiling a write path). Refuses any path under ~/.memory.
 * Measurement only — changes no production code.
 */
import { performance } from 'node:perf_hooks';
// nx infers "@adhd/sox-store-adapter is lazy-loaded" from
// scripts/migrate-store-to-turso.mjs's `await import(...)` optional-availability
// guard and flags every other static importer repo-wide, including this one.
// Item 7 first-run discovery — not a real inconsistency in this file.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { createTursoAdapter } from '@adhd/sox-store-adapter';
// @adhd/sox-memory-core is not a declared root dependency; adding it requires
// `pnpm install` + committing the pnpm-lock.yaml diff (CLAUDE.md "relock
// before merge on new workspace edges"), which is unsafe to run right now
// while another agent is mid-build-and-restart of memory-server's
// 14-project dependency set. Item 7 first-run discovery — tracked as a
// follow-up, not fixed here.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { memoryWritePhaseA } from '../libs/memory-core/src/write.js';

const DB = process.env.PROFILE_DB ?? '/tmp/sub600e/bench.db';
if (DB.includes('/.memory/')) {
  console.error('REFUSING: profile must not touch the live store. Use a copy.');
  process.exit(2);
}
const N = Number(process.env.PROFILE_N ?? 12);

// ── SQL fingerprinting: collapse literals/whitespace so statements group ─────
function fingerprint(sql: string): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  const verb = (s.split(' ')[0] ?? '?').toUpperCase();
  let target = '';
  const m =
    /\b(?:INTO|FROM|UPDATE|TABLE)\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(s);
  if (m) target = m[1]!;
  return `${verb} ${target}`.trim() + ' :: ' + s.slice(0, 70);
}

interface Bucket { calls: number; ms: number }
const dbBuckets = new Map<string, Bucket>();
let dbTotalMs = 0;
let dbCalls = 0;
let txCount = 0;
let txTotalMs = 0;

function record(fp: string, ms: number): void {
  const b = dbBuckets.get(fp) ?? { calls: 0, ms: 0 };
  b.calls += 1;
  b.ms += ms;
  dbBuckets.set(fp, b);
  dbTotalMs += ms;
  dbCalls += 1;
}

/**
 * Wrap an adapter (or a transaction handle) so each SQL call is timed.
 * Transaction bodies are timed as a whole AND their inner statements are
 * attributed individually — inner statement time is a subset of tx time, so
 * only statement time is summed into dbTotalMs to avoid double counting.
 */
function wrap<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, recv) {
      const orig = Reflect.get(obj, prop, recv);
      if (typeof orig !== 'function') return orig;
      const name = String(prop);

      if (name === 'executeRun' || name === 'executeGet' || name === 'executeAll') {
        return async (...args: unknown[]) => {
          const sql = typeof args[0] === 'string' ? args[0] : '<non-string>';
          const t = performance.now();
          try {
            return await (orig as (...a: unknown[]) => Promise<unknown>).apply(obj, args);
          } finally {
            record(fingerprint(sql), performance.now() - t);
          }
        };
      }

      if (name === 'transaction') {
        return async (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => {
          const t = performance.now();
          try {
            return await (orig as (...a: unknown[]) => Promise<unknown>).apply(obj, [
              (tx: object) => fn(wrap(tx)),
              ...rest,
            ]);
          } finally {
            txCount += 1;
            txTotalMs += performance.now() - t;
          }
        };
      }

      return (orig as (...a: unknown[]) => unknown).bind(obj);
    },
  }) as T;
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}
function summarize(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: +pct(s, 50).toFixed(1),
    p90: +pct(s, 90).toFixed(1),
    max: +s[s.length - 1]!.toFixed(1),
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1),
  };
}

async function main(): Promise<void> {
  const raw = await createTursoAdapter({ dbPath: DB });
  const adapter = wrap(raw as unknown as object) as typeof raw;

  const perWrite: number[] = [];
  const perWriteDb: number[] = [];

  for (let i = 0; i < N; i++) {
    // Reset per-iteration DB accounting (keep cumulative buckets for the report).
    const dbBefore = dbTotalMs;

    const content =
      `Phase-A profiling probe ${i} — ${Math.random().toString(36).slice(2)}. ` +
      `The incremental cluster join loads every live community member vector and ` +
      `computes cosine similarity against the candidate embedding, then joins the ` +
      `highest-similarity community when it clears the tau threshold. This text is ` +
      `sized to resemble a real episode body so deterministic enrichment (extractive ` +
      `summary, tag inference, topic resolution) does representative work.`;

    const t = performance.now();
    const res = await memoryWritePhaseA(adapter, {
      content,
      project_path: '/tmp/profile-phase-a',
      source: 'observation',
    } as Parameters<typeof memoryWritePhaseA>[1]);
    const wall = performance.now() - t;

    if (res && typeof res === 'object' && 'code' in res) {
      console.error(`iteration ${i}: ${JSON.stringify(res)}`);
      continue;
    }
    perWrite.push(wall);
    perWriteDb.push(dbTotalMs - dbBefore);
  }

  const wallS = summarize(perWrite);
  const dbS = summarize(perWriteDb);
  const computeS = summarize(perWrite.map((w, i) => w - (perWriteDb[i] ?? 0)));

  const top = [...dbBuckets.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, 12)
    .map(([fp, b]) => ({
      statement: fp,
      calls: b.calls,
      total_ms: +b.ms.toFixed(1),
      ms_per_call: +(b.ms / b.calls).toFixed(2),
      pct_of_db_time: +((b.ms / dbTotalMs) * 100).toFixed(1),
    }));

  console.log(
    JSON.stringify(
      {
        profile: 'memoryWritePhaseA',
        db: DB,
        iterations: perWrite.length,
        phase_a_wall_ms: wallS,
        db_time_ms: dbS,
        in_process_compute_ms: computeS,
        compute_share_of_wall:
          wallS.mean > 0 ? +((computeS.mean / wallS.mean) * 100).toFixed(1) : null,
        db_share_of_wall: wallS.mean > 0 ? +((dbS.mean / wallS.mean) * 100).toFixed(1) : null,
        sql_calls_per_write: +(dbCalls / Math.max(perWrite.length, 1)).toFixed(1),
        transactions_per_write: +(txCount / Math.max(perWrite.length, 1)).toFixed(1),
        transaction_wall_ms_total: +txTotalMs.toFixed(1),
        top_statements_by_total_db_time: top,
        note:
          'compute = wall - Σ(statement time). It captures enrichOnWrite, extractive ' +
          'summarization, hashing and entity extraction. A high compute share means the ' +
          'write is CPU-bound in enrichment (deferrable); a high db share with many ' +
          'calls means it is round-trip bound (batchable).',
      },
      null,
      2,
    ),
  );

  await raw.close();
}

void main();
