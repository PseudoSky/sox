/**
 * Capture write-perf baseline (RS-0).
 *
 * CONTRACTS §K: p50/p99 of 100 sequential memory_write calls on the pre-change
 * build. Uses a temporary disposable database (NEVER touches the live store).
 *
 * Usage: node scripts/capture-write-perf-baseline.mjs
 */

import { unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the built CommonJS module
const memoryCore = require('../libs/memory-core/dist/index.js');
const { openDb, memoryWrite, warmupEmbed } = memoryCore;

const BASELINE_DIR = join(__dirname, '..', 'docs/plan/runtime-productionization/_shared/baselines');
const TEMP_DB = join(BASELINE_DIR, 'write-perf-temp.db');
const BASELINE_JSON = join(BASELINE_DIR, 'write-perf.json');

// ── Cleanup any previous temp db ──────────────────────────────────────────────
try { unlinkSync(TEMP_DB); } catch { /* ok */ }
try { unlinkSync(TEMP_DB + '-wal'); } catch { /* ok */ }
try { unlinkSync(TEMP_DB + '-shm'); } catch { /* ok */ }

mkdirSync(BASELINE_DIR, { recursive: true });

// ── Step 1: Warm up embed ─────────────────────────────────────────────────────
console.log('Step 1: Warming up embed...');
try {
  await warmupEmbed();
  console.log('  Embed warm.');
} catch (e) {
  console.log('  Warmup failed (may use hash fallback):', e.message);
}

// ── Step 2: Create disposable DB ──────────────────────────────────────────────
console.log('Step 2: Creating disposable DB...');
const db = openDb(TEMP_DB);
console.log('  DB created.');

// ── Step 3: Run 100 sequential writes, measuring each ─────────────────────────
console.log('Step 3: Running 100 sequential memory_write calls...');
const latencies = [];

for (let i = 0; i < 100; i++) {
  const start = performance.now();
  const result = await memoryWrite(db, {
    content: `Baseline write-perf test episode ${i}. This is a synthetic content payload for timing measurement. The quick brown fox jumps over the lazy dog.`,
    tags: ['baseline', 'write-perf', `test-${i % 10}`],
    source: 'import',
  });
  const elapsed = performance.now() - start;
  latencies.push(elapsed);

  if (i > 0 && i % 20 === 0) {
    console.log(`  Progress: ${i}/100 written (last: ${elapsed.toFixed(1)}ms)`);
  }
}

// ── Step 4: Compute p50 / p99 ────────────────────────────────────────────────
console.log('Step 4: Computing percentiles...');
latencies.sort((a, b) => a - b);
const total = latencies.length;

function percentile(p) {
  const idx = Math.ceil(p * total / 100) - 1;
  return latencies[Math.max(0, Math.min(idx, total - 1))];
}

const p50 = percentile(50);
const p99 = percentile(99);
const mean = latencies.reduce((s, v) => s + v, 0) / total;
const min = latencies[0];
const max = latencies[total - 1];

console.log(`  p50:  ${p50.toFixed(2)}ms`);
console.log(`  p99:  ${p99.toFixed(2)}ms`);
console.log(`  mean: ${mean.toFixed(2)}ms`);
console.log(`  min:  ${min.toFixed(2)}ms`);
console.log(`  max:  ${max.toFixed(2)}ms`);

// ── Step 5: Cleanup ───────────────────────────────────────────────────────────
console.log('Step 5: Cleaning up...');
db.close();

// Keep the temp DB for verification if needed — the .gitignore will exclude it

// ── Step 6: Write baseline JSON ───────────────────────────────────────────────
console.log('Step 6: Writing baseline JSON...');

const baseline = {
  _meta: {
    description: 'Pre-migration write-perf baseline captured by RS-0.',
    captured_at: new Date().toISOString(),
    temp_db: 'write-perf-temp.db (disposable, committed for reproducibility)',
    build: 'pre-change (memory-core current, before any context 02 migration)',
    method: '100 sequential memory_write calls to a fresh disposable SQLite store',
    units: 'milliseconds',
  },
  measurements: {
    count: total,
    p50_ms: Math.round(p50 * 100) / 100,
    p99_ms: Math.round(p99 * 100) / 100,
    mean_ms: Math.round(mean * 100) / 100,
    min_ms: Math.round(min * 100) / 100,
    max_ms: Math.round(max * 100) / 100,
  },
  all_latencies_ms: latencies.map(v => Math.round(v * 100) / 100),
};

writeFileSync(BASELINE_JSON, JSON.stringify(baseline, null, 2) + '\n');
console.log(`  Written to: ${BASELINE_JSON}`);
console.log('Done. Write-perf baseline captured successfully.');
