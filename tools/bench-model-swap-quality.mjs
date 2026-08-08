#!/usr/bin/env node
/**
 * bench-model-swap-quality.mjs — does swapping bge-base (768d) for bge-small
 * (384d) preserve clustering semantics?
 *
 * WHY THIS EXISTS: bge-small is 7.3x faster and is the only measured way to
 * fit write→community-visible inside 600ms. But tau is pinned at 0.87
 * (cluster.ts resolveDefaultThreshold / CLUSTER_THRESHOLD_FLOOR) and was
 * calibrated against the bge-base similarity distribution. If bge-small's
 * distribution is shifted, reusing tau=0.87 would silently change coverage
 * and cluster shape — a latency win that wrecks clustering is a regression.
 *
 * Method: sample real episode texts from a COPY of the store, embed each with
 * BOTH models, and compare the pairwise cosine distributions plus the
 * agreement of the tau-thresholded neighbour graph.
 *
 * READ-ONLY on a COPY. Refuses to touch ~/.memory (BL-330).
 */
import { performance } from 'node:perf_hooks';
import { connect } from '@tursodatabase/database';

const DB = process.env.BENCH_DB ?? '/tmp/sub600/bench.db';
if (DB.includes('/.memory/')) {
  console.error('REFUSING: must not touch the live store. Use a copy.');
  process.exit(2);
}
const SAMPLE = Number(process.env.BENCH_SAMPLE ?? 120);
const TAU = Number(process.env.BENCH_TAU ?? 0.87);
const ENTRY =
  process.env.BENCH_PROVIDER_ENTRY ??
  '/Users/nix/dev/ai/sox-ecosystem/libs/data/embed/embedding-provider/dist/index.js';

const db = await connect(DB);
const rows = await (
  await db.prepare(
    `SELECT uid, COALESCE(summary, content) AS text
     FROM node
     WHERE kind = 'episode' AND t_invalid IS NULL
       AND COALESCE(summary, content) IS NOT NULL
       AND length(COALESCE(summary, content)) > 80
     ORDER BY rowid
     LIMIT ?`,
  )
).all([SAMPLE]);
await db.close();

const texts = rows.map((r) => String(r.text).slice(0, 2000));
console.error(`[bench] sampled ${texts.length} real episode texts`);

const { createEmbeddingProvider } = await import(ENTRY);

async function embedAll(model) {
  const p = await createEmbeddingProvider({ type: 'fastembed', model });
  await p.embedSingle('warmup', 'document');
  const out = [];
  const t = performance.now();
  for (const text of texts) out.push(await p.embedSingle(text, 'document'));
  const ms = performance.now() - t;
  return { vecs: out, total_ms: +ms.toFixed(0), per_text_ms: +(ms / texts.length).toFixed(1) };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
function pairwise(vecs) {
  const sims = [];
  for (let i = 0; i < vecs.length; i++)
    for (let j = i + 1; j < vecs.length; j++) sims.push(cosine(vecs[i], vecs[j]));
  return sims;
}
function pct(s, p) {
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
function dist(sims) {
  const s = [...sims].sort((a, b) => a - b);
  return {
    n: s.length,
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(4),
    p50: +pct(s, 50).toFixed(4),
    p90: +pct(s, 90).toFixed(4),
    p99: +pct(s, 99).toFixed(4),
    max: +s[s.length - 1].toFixed(4),
  };
}

const base = await embedAll('bge-base-en-v1.5');
const small = await embedAll('bge-small-en-v1.5');

const simsBase = pairwise(base.vecs);
const simsSmall = pairwise(small.vecs);

// Edges above tau under each model, and their agreement.
const edgesBase = new Set();
const edgesSmall = new Set();
let k = 0;
for (let i = 0; i < texts.length; i++) {
  for (let j = i + 1; j < texts.length; j++) {
    if (simsBase[k] >= TAU) edgesBase.add(`${i}-${j}`);
    if (simsSmall[k] >= TAU) edgesSmall.add(`${i}-${j}`);
    k++;
  }
}
const inter = [...edgesBase].filter((e) => edgesSmall.has(e)).length;
const union = new Set([...edgesBase, ...edgesSmall]).size;

// What tau would bge-small need to produce the SAME edge count as base@0.87?
const sortedSmall = [...simsSmall].sort((a, b) => b - a);
const equivalentTau =
  edgesBase.size > 0 && edgesBase.size <= sortedSmall.length
    ? +sortedSmall[edgesBase.size - 1].toFixed(4)
    : null;

console.log(
  JSON.stringify(
    {
      bench: 'model-swap-quality',
      sample_size: texts.length,
      tau: TAU,
      bge_base: { per_text_ms: base.per_text_ms, dim: base.vecs[0].length, pairwise: dist(simsBase) },
      bge_small: { per_text_ms: small.per_text_ms, dim: small.vecs[0].length, pairwise: dist(simsSmall) },
      speedup: +(base.per_text_ms / small.per_text_ms).toFixed(2),
      edges_above_tau: {
        base: edgesBase.size,
        small: edgesSmall.size,
        jaccard: union > 0 ? +(inter / union).toFixed(4) : null,
      },
      equivalent_tau_for_small: equivalentTau,
      verdict:
        'If edges_above_tau.small differs materially from .base, tau MUST be ' +
        'recalibrated for bge-small — reusing 0.87 would change coverage and ' +
        'cluster shape silently. equivalent_tau_for_small is the tau that ' +
        'reproduces the same edge COUNT on this sample.',
    },
    null,
    2,
  ),
);
process.exit(0);
