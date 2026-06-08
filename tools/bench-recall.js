#!/usr/bin/env node
/**
 * tools/bench-recall.js — P1 acceptance benchmark for sox-memory recall.
 *
 * Usage: node tools/bench-recall.js <db_path> [--n <count>]
 *
 * Asserts:
 *   (a) p95 latency < 50ms (invariant R1)
 *   (b) provider_call_count == 0 (invariant R1: zero LLM on read)
 *   (c) top-1 hit-rate >= 0.9 (recall quality)
 *
 * Exits 0 if all assertions pass; exits 1 with error details otherwise.
 *
 * The benchmark uses queries designed to match seeded content:
 * each query is a topic keyword that appears in seed.js records.
 * The top-1 hit is any record whose content contains the query topic.
 */

import { openDb, memoryRecall, resetProviderCallCount, getProviderCallCount } from '../dist/memory-lib.js';

const TOPICS = [
  'machine learning', 'neural networks', 'deep learning', 'transformer architecture',
  'attention mechanism', 'gradient descent', 'backpropagation', 'convolutional networks',
  'recurrent networks', 'generative models', 'reinforcement learning', 'natural language processing',
  'computer vision', 'speech recognition', 'recommendation systems', 'knowledge graphs',
  'graph neural networks', 'federated learning', 'transfer learning', 'meta-learning',
  'active learning', 'semi-supervised learning', 'self-supervised learning', 'contrastive learning',
  'retrieval augmented generation', 'vector databases', 'embedding models', 'semantic search',
  'question answering', 'text summarization',
];

function percentile(sortedArr, p) {
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

async function main() {
  const args = process.argv.slice(2);
  const dbPath = args[0];

  if (!dbPath) {
    console.error('Usage: node tools/bench-recall.js <db_path> [--n <count>]');
    process.exit(1);
  }

  let n = 200;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--n') {
      n = parseInt(args[i + 1] ?? '200', 10);
      i++;
    }
  }

  console.log(`Benchmarking recall: ${n} queries on ${dbPath}`);

  const db = openDb(dbPath);

  // Verify DB has data
  const nodeCount = db.prepare('SELECT COUNT(*) as c FROM node').get().c;
  if (nodeCount === 0) {
    console.error('ERROR: Database is empty. Run seed.js first.');
    process.exit(1);
  }
  console.log(`  DB has ${nodeCount} nodes`);

  const latencies = [];
  let totalProviderCalls = 0;
  let hits = 0;
  let misses = 0;
  const missDetails = [];

  resetProviderCallCount();

  for (let i = 0; i < n; i++) {
    // Pick a topic deterministically (cycle through topics)
    const topic = TOPICS[i % TOPICS.length];
    const query = topic;

    const t0 = performance.now();
    const result = memoryRecall(db, 'project', { query, limit: 5 });
    const t1 = performance.now();

    const latencyMs = t1 - t0;
    latencies.push(latencyMs);
    totalProviderCalls += result.provider_call_count;

    // Check hit: top-1 result contains the query topic
    const top = result.results[0];
    if (top && top.content && top.content.toLowerCase().includes(topic)) {
      hits++;
    } else {
      misses++;
      if (missDetails.length < 5) {
        missDetails.push({
          query: topic,
          top_content: top?.content?.slice(0, 100) ?? null,
          result_count: result.results.length,
        });
      }
    }
  }

  db.close();

  // Compute statistics
  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const avgMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const hitRate = hits / n;

  console.log('\n=== Benchmark Results ===');
  console.log(`  Queries:            ${n}`);
  console.log(`  Avg latency:        ${avgMs.toFixed(2)}ms`);
  console.log(`  p50 latency:        ${p50.toFixed(2)}ms`);
  console.log(`  p95 latency:        ${p95.toFixed(2)}ms`);
  console.log(`  p99 latency:        ${p99.toFixed(2)}ms`);
  console.log(`  Provider calls:     ${totalProviderCalls}`);
  console.log(`  Top-1 hits:         ${hits}/${n} (${(hitRate * 100).toFixed(1)}%)`);

  if (missDetails.length > 0) {
    console.log('\n  Miss examples:');
    for (const m of missDetails) {
      console.log(`    query="${m.query}" top="${m.top_content}" count=${m.result_count}`);
    }
  }

  // Assertions
  const assertions = [
    {
      name: 'p95 latency < 50ms',
      pass: p95 < 50,
      actual: `${p95.toFixed(2)}ms`,
      expected: '<50ms',
    },
    {
      name: 'provider_call_count == 0',
      pass: totalProviderCalls === 0,
      actual: String(totalProviderCalls),
      expected: '0',
    },
    {
      name: 'top-1 hit-rate >= 0.9',
      pass: hitRate >= 0.9,
      actual: hitRate.toFixed(3),
      expected: '>=0.9',
    },
  ];

  console.log('\n=== Assertion Results ===');
  let allPass = true;
  for (const a of assertions) {
    const status = a.pass ? 'PASS' : 'FAIL';
    console.log(`  [${status}] ${a.name}: actual=${a.actual} expected=${a.expected}`);
    if (!a.pass) allPass = false;
  }

  if (allPass) {
    console.log('\nALL ASSERTIONS PASSED');
    process.exit(0);
  } else {
    console.error('\nFAILED: One or more assertions did not pass');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
