#!/usr/bin/env node
/**
 * tools/seed.js — deterministic 10K fixture seeder for sox-memory bench.
 *
 * Usage: node tools/seed.js <db_path> <count>
 *   db_path: path to the .db file (created by memory init)
 *   count: number of records to insert (default 10000)
 *
 * Seeds deterministic episodes where each record's content is unique and
 * predictable, allowing bench-recall to query for known top-1 results.
 * No LLM calls; embedding is the local hash-based embedder.
 */

import { openDb, memoryWrite } from '../dist/memory-lib.js';

const TOPICS = [
  'machine learning', 'neural networks', 'deep learning', 'transformer architecture',
  'attention mechanism', 'gradient descent', 'backpropagation', 'convolutional networks',
  'recurrent networks', 'generative models', 'reinforcement learning', 'natural language processing',
  'computer vision', 'speech recognition', 'recommendation systems', 'knowledge graphs',
  'graph neural networks', 'federated learning', 'transfer learning', 'meta-learning',
  'active learning', 'semi-supervised learning', 'self-supervised learning', 'contrastive learning',
  'retrieval augmented generation', 'vector databases', 'embedding models', 'semantic search',
  'question answering', 'text summarization', 'named entity recognition', 'information extraction',
  'dialogue systems', 'machine translation', 'code generation', 'program synthesis',
  'causal inference', 'bayesian networks', 'probabilistic programming', 'uncertainty quantification',
  'robustness adversarial', 'interpretability explainability', 'fairness bias', 'privacy differential',
  'multi-modal learning', 'video understanding', 'audio processing', 'sensor fusion',
  'autonomous systems', 'robotics motion planning', 'game playing', 'scientific discovery',
];

const AGENTS = ['agent-alpha', 'agent-beta', 'agent-gamma', null];
const SOURCES = ['message', 'observation', 'document', 'tool_output'];

/**
 * Simple deterministic pseudo-random generator (LCG).
 * Seed is deterministic so same seed → same data.
 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s, 1664525) + 1013904223 >>> 0;
    return s / 0x100000000;
  };
}

function pickFrom(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

async function main() {
  const args = process.argv.slice(2);
  const dbPath = args[0];
  const count = parseInt(args[1] ?? '10000', 10);

  if (!dbPath) {
    console.error('Usage: node tools/seed.js <db_path> [count]');
    process.exit(1);
  }

  console.log(`Seeding ${count} records into ${dbPath}...`);
  const db = openDb(dbPath);

  const rng = lcg(42); // deterministic seed

  let written = 0;
  let dupes = 0;
  const batchSize = 500;

  // Use a transaction batch for speed
  const insertBatch = db.transaction((batch) => {
    for (const params of batch) {
      const result = memoryWrite(db, params);
      if (result.episode_uid) {
        written++;
      } else if (result.code === 'E_DEDUP') {
        dupes++;
      }
    }
  });

  let batch = [];
  for (let i = 0; i < count; i++) {
    const topic = pickFrom(TOPICS, rng);
    const agent = pickFrom(AGENTS, rng);
    const source = pickFrom(SOURCES, rng);
    const importance = 1 + Math.floor(rng() * 9); // 1..9

    // Unique content: deterministic combination
    const content = `[seed:${i}] ${topic}: The system discovered that ${topic} demonstrates key properties `
      + `in iteration ${i} with coefficient ${(rng() * 100).toFixed(3)}. `
      + `This finding relates to the broader understanding of ${pickFrom(TOPICS, rng)} `
      + `and has implications for ${pickFrom(TOPICS, rng)} research. `
      + `Observation index: ${i}, topic hash: ${topic.length * (i + 1)}.`;

    batch.push({
      content,
      agent_id: agent,
      source,
      importance,
      t_occurred: new Date(Date.now() - Math.floor(rng() * 30 * 24 * 3600 * 1000)).toISOString(),
    });

    if (batch.length >= batchSize) {
      insertBatch(batch);
      batch = [];
      process.stdout.write(`\r  ${written} written, ${dupes} dupes...`);
    }
  }
  if (batch.length > 0) {
    insertBatch(batch);
  }

  console.log(`\nDone. written=${written}, dupes=${dupes}, total=${count}`);

  // Verify
  const nodeCount = db.prepare('SELECT COUNT(*) as c FROM node').get().c;
  const vecCount = db.prepare('SELECT COUNT(*) as c FROM vec_node').get().c;
  console.log(`DB: node=${nodeCount}, vec_node=${vecCount}`);

  db.close();
}

main().catch(e => {
  console.error('Seed failed:', e);
  process.exit(1);
});
