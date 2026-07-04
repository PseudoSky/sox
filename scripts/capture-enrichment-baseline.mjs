/**
 * Capture enrichment-parity baseline (RS-0).
 *
 * CONTRACTS §K: copies the live store, runs one full daemon-driven batch pass
 * over the snapshot, and records counters + sha256.
 *
 * NEVER modifies the live store (~/.memory/memory.db).
 *
 * Usage: node scripts/capture-enrichment-baseline.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the built CommonJS module
const memoryCore = require('../libs/memory-core/dist/index.js');
const { runBatchEnrich } = memoryCore;

// Load better-sqlite3 and sqlite-vec
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

// ── Paths ─────────────────────────────────────────────────────────────────────
const HOME = process.env['HOME'] ?? '/root';
const LIVE_DB = join(HOME, '.memory', 'memory.db');
const SNAPSHOT_DIR = join(__dirname, '..', 'docs/plan/runtime-productionization/_shared/baselines');
const SNAPSHOT_PATH = join(SNAPSHOT_DIR, 'enrichment-baseline-snapshot.db');
const BASELINE_JSON = join(SNAPSHOT_DIR, 'enrichment-parity.json');

// ── Step 1: Create a consistent snapshot ──────────────────────────────────────
console.log('Step 1: Creating consistent snapshot...');
{
  const tmpDb = new Database(LIVE_DB);
  tmpDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  tmpDb.close();
  console.log('  WAL checkpointed on live DB.');
}

mkdirSync(SNAPSHOT_DIR, { recursive: true });
copyFileSync(LIVE_DB, SNAPSHOT_PATH);
console.log(`  Snapshot copied to: ${SNAPSHOT_PATH}`);

const snapshotBuf = readFileSync(SNAPSHOT_PATH);
const snapshotSha256 = createHash('sha256').update(snapshotBuf).digest('hex');
console.log(`  Snapshot sha256: ${snapshotSha256}`);

// ── Step 2: Open snapshot and run batch enrich ────────────────────────────────
console.log('Step 2: Running batch enrich...');
const db = new Database(SNAPSHOT_PATH);
sqliteVec.load(db);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 3000');
db.exec('PRAGMA synchronous = NORMAL');

// Run batch enrichment with default options (full pass)
const result = runBatchEnrich(db, {
  clusterThreshold: 0.82,
  clusterNodeCap: 10000,
  importanceChunkSize: 500,
  entityStoplistThreshold: 0.30,
  incrementalCluster: false,
});

console.log('  Batch enrich result:', JSON.stringify(result, null, 2));

// ── Step 3: Count total nodes and edges ───────────────────────────────────────
console.log('Step 3: Counting nodes and edges...');
const nodeCountRow = db.prepare('SELECT COUNT(*) AS cnt FROM node WHERE t_invalid IS NULL').get();
const totalNodes = nodeCountRow.cnt;
const edgeCountRow = db.prepare('SELECT COUNT(*) AS cnt FROM edge WHERE t_expired IS NULL').get();
const totalEdges = edgeCountRow.cnt;
const episodeCountRow = db.prepare("SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL").get();
const totalEpisodes = episodeCountRow.cnt;

console.log(`  Total live nodes: ${totalNodes}`);
console.log(`  Total live edges: ${totalEdges}`);
console.log(`  Total live episodes: ${totalEpisodes}`);

db.close();

// ── Step 4: Write baseline JSON ───────────────────────────────────────────────
console.log('Step 4: Writing baseline JSON...');
const baseline = {
  _meta: {
    description: 'Pre-migration enrichment baseline captured by RS-0.',
    captured_at: new Date().toISOString(),
    snapshot_sha256: snapshotSha256,
    snapshot_path: 'enrichment-baseline-snapshot.db',
    source: LIVE_DB,
    build: 'pre-change (memory-core current, before any context 02 migration)',
  },
  batch_enrich_result: {
    communities_upserted: result.communities_upserted,
    member_of_edges: result.member_of_edges,
    importance_updated: result.importance_updated,
    relates_to_edges: result.relates_to_edges,
    topics_backfilled: result.topics_backfilled,
    legacy_nodes_stamped: result.legacy_nodes_stamped,
    cluster_pass_skipped: result.cluster_pass_skipped,
    cluster_skip_reason: result.cluster_skip_reason ?? null,
  },
  store_snapshot: {
    total_live_nodes: totalNodes,
    total_live_episodes: totalEpisodes,
    total_live_edges: totalEdges,
  },
};

writeFileSync(BASELINE_JSON, JSON.stringify(baseline, null, 2) + '\n');
console.log(`  Written to: ${BASELINE_JSON}`);
console.log('Done. Enrichment baseline captured successfully.');
