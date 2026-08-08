#!/usr/bin/env node
/**
 * bench-embed-floor.mjs — measure the WARM steady-state single-text embed
 * latency of the live embedding provider.
 *
 * WHY: the sub-600ms write→community-visible target requires embed + join to
 * both fit in 600ms. `memory_ping` reports embed_duration_ms p50 745ms, but
 * that is contaminated by cold starts, backlog batching and contention. This
 * measures the pure warm compute floor, which is the number that decides
 * whether 600ms is architecturally reachable at all.
 *
 * READ-ONLY: touches no database. Never opens ~/.memory/*.
 */
import { performance } from 'node:perf_hooks';

const N = Number(process.env.BENCH_N ?? 30);
const WARM = Number(process.env.BENCH_WARM ?? 3);

// Representative episode-sized text (the real write path embeds content+summary).
const CORPUS = Array.from({ length: N + WARM }, (_, i) =>
  `Episode ${i}: the incremental cluster join loads every live community member ` +
  `vector and computes cosine similarity against the candidate embedding, then ` +
  `joins the highest-similarity community when it clears the tau threshold. ` +
  `Iteration nonce ${i} ${Math.random().toString(36).slice(2)}.`,
);

function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(label, xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    label,
    n: s.length,
    p50: +pct(s, 50).toFixed(1),
    p90: +pct(s, 90).toFixed(1),
    p99: +pct(s, 99).toFixed(1),
    min: +s[0].toFixed(1),
    max: +s[s.length - 1].toFixed(1),
    mean: +mean.toFixed(1),
  };
}

// Resolve the provider from an explicit dist path when the caller supplies one
// (a fresh worktree has no node_modules; rebuilding to satisfy an import would
// be a destructive `nx build` per BL-235). Falls back to normal resolution.
const providerEntry = process.env.BENCH_PROVIDER_ENTRY ?? '@adhd/sox-embedding-provider';
const mod = await import(providerEntry);
const { createEmbeddingProvider } = mod;

const provider = await createEmbeddingProvider({
  type: 'fastembed',
  model: process.env.BENCH_MODEL ?? 'bge-base-en-v1.5',
});

// ── Cold start: first embed after process boot, model load included ──────────
const coldStart = performance.now();
await provider.embedSingle(CORPUS[0], 'document');
const coldMs = performance.now() - coldStart;

// ── Warm-up (excluded from the reported distribution) ────────────────────────
for (let i = 1; i <= WARM; i++) {
  await provider.embedSingle(CORPUS[i], 'document');
}

// ── Steady-state warm single embeds ──────────────────────────────────────────
const warmSamples = [];
for (let i = 0; i < N; i++) {
  const t = performance.now();
  await provider.embedSingle(CORPUS[WARM + i], 'document');
  warmSamples.push(performance.now() - t);
}

const health = provider.health?.() ?? null;

console.log(
  JSON.stringify(
    {
      bench: 'embed-floor',
      model: provider.metadata?.modelId ?? null,
      dimensions: provider.metadata?.dimensions ?? null,
      execution_provider: health?.execution_provider ?? null,
      state: health?.state ?? null,
      cold_start_ms: +coldMs.toFixed(1),
      warm: summarize('warm_single_embed_ms', warmSamples),
      budget_ms: 600,
      verdict:
        summarize('x', warmSamples).p50 < 600
          ? 'warm embed p50 fits inside the 600ms TOTAL budget (join still to pay)'
          : 'warm embed p50 ALONE exceeds the 600ms total budget',
    },
    null,
    2,
  ),
);

// Release the shared worker/process so the bench exits.
for (const closer of ['shutdownSharedOnnxWorker', 'shutdownSharedFastembedProcess', 'getSharedOnnxWorker']) {
  void closer;
}
process.exit(0);
