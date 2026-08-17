#!/usr/bin/env node
/**
 * bench-connect-cost.mjs — measure TursoAdapter connect() ceremony cost
 * against a reused, already-open connection.
 *
 * WHY: dispatched to answer "is per-operation connection scoping viable for
 * store-adapter consumers, or is per-operation open/close too expensive?"
 * (store-adapter connection-lifetime design task, 2026-08-17).
 *
 * CONCLUSION AS OF THE FIRST RUN (2026-08-17, this box, local TursoAdapter,
 * 50 iterations/arm) — record it here so it survives without re-running:
 *
 *   connect() -> SELECT 1 -> close()  steady-state p50 ≈ 3.88ms (p99 5.07ms)
 *   bare connect() only (no query/close) steady-state p50 ≈ 2.98ms
 *   SELECT 1 on an already-open, reused connection        p50 ≈ 0.0073ms
 *   ratio (full cycle / reused op)                        ≈ 530x
 *
 * Nearly all the cost is IN connect() itself — lease-file write
 * (store-lease.ts acquireStoreLease), engine-guard check, WAL-identity
 * baseline probe, BL-352 integrity verify+repair — not in close() or the
 * query. This RULES OUT per-operation `withConnection`-style scoping for any
 * hot write path (e.g. memory-core's WriteQueue, many ops/sec: 530x is a
 * throughput catastrophe) and is a NO-OP for a consumer that already opens
 * once per invocation and exits (e.g. backlog's CLI: scoping tighter adds
 * nothing when the connection is already as short-lived as it can be). The
 * cost IS affordable as an amortized one-shot on a genuinely idle-then-woken
 * long-lived process (e.g. `backlog serve`'s idle-release candidate design —
 * an MCP round trip is already tens-to-hundreds of ms, so 3.88ms on the next
 * request after an idle release is noise).
 *
 * READ-ONLY w.r.t. any real store: opens/closes only a disposable scratch
 * file under the OS tmpdir, deleted at the end of the run. NEVER touches
 * ~/.memory or ~/.adhd/backlog.
 *
 * Usage: node tools/bench-connect-cost.mjs [--iterations=50]
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const ITER = Number(
  process.argv.find((a) => a.startsWith('--iterations='))?.split('=')[1] ?? 50,
);

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const pick = (p) => s[Math.min(n - 1, Math.floor(p * n))];
  const mean = s.reduce((a, b) => a + b, 0) / n;
  return {
    n,
    min_ms: round(s[0]),
    p50_ms: round(pick(0.5)),
    p99_ms: round(pick(0.99)),
    max_ms: round(s[n - 1]),
    mean_ms: round(mean),
  };
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}

async function main() {
  const { createTursoAdapter } = await import(
    join(REPO_ROOT, 'libs/data/store/store-adapter/dist/factory.js')
  );

  const tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-connect-bench-'));
  const dbPath = join(tmpDir, 'bench.db');

  try {
    // ── A: full connect() ceremony, one-shot open+trivial-query+close ──────
    const connectCloseSamples = [];
    for (let i = 0; i < ITER; i++) {
      const t0 = performance.now();
      const adapter = await createTursoAdapter({ dbPath });
      await adapter.init?.();
      await adapter.executeGet('SELECT 1');
      await adapter.close();
      connectCloseSamples.push(performance.now() - t0);
    }
    // First open pays a one-time dynamic-import(@tursodatabase/database) +
    // fresh-file-init cost — isolate it from steady state.
    const firstOpenMs = connectCloseSamples[0];
    const steadyFullCycle = connectCloseSamples.slice(1);

    // ── B: single long-lived connection, N trivial ops on it ───────────────
    const longLived = await createTursoAdapter({ dbPath });
    await longLived.init?.();
    const reusedOpSamples = [];
    for (let i = 0; i < ITER; i++) {
      const t0 = performance.now();
      await longLived.executeGet('SELECT 1');
      reusedOpSamples.push(performance.now() - t0);
    }
    await longLived.close();

    // ── C: isolate JUST the connect() call (no query, no close) ────────────
    const bareConnectSamples = [];
    for (let i = 0; i < ITER; i++) {
      const t0 = performance.now();
      const adapter = await createTursoAdapter({ dbPath });
      bareConnectSamples.push(performance.now() - t0);
      await adapter.close();
    }

    let walBytesAtEnd = 0;
    try {
      walBytesAtEnd = statSync(dbPath + '-wal').size;
    } catch {
      walBytesAtEnd = 0;
    }

    const fullCycle = stats(steadyFullCycle);
    const reused = stats(reusedOpSamples);

    const result = {
      _meta: {
        description:
          'TursoAdapter connect() ceremony cost vs. reused-connection op cost',
        captured_at: new Date().toISOString(),
        db_path: dbPath,
        iterations: ITER,
        note:
          'first_open_ms isolates one-time dynamic-import + fresh-file init; ' +
          'steady_state arms exclude it.',
      },
      first_open_ms: round(firstOpenMs),
      connect_query_close_steady_state: fullCycle,
      bare_connect_only_steady_state: stats(bareConnectSamples.slice(1)),
      reused_connection_query_only: reused,
      ratio_full_cycle_to_reused_op: round(fullCycle.p50_ms / Math.max(0.001, reused.p50_ms)),
      wal_bytes_at_end: walBytesAtEnd,
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('bench-connect-cost FAILED', err);
  process.exit(1);
});
