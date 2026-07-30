#!/usr/bin/env node
/**
 * generate-test-store.mjs — generate synthetic SQLite store files
 * for migration sandbox testing.
 *
 * Creates a fresh store with realistic episode data, vectors, and metadata.
 * Uses better-sqlite3 directly for fast bulk inserts while leveraging the
 * store-adapter factory for initial store structure (pragmas, DDL).
 *
 * Usage:
 *   node scripts/generate-test-store.mjs --help
 *   node scripts/generate-test-store.mjs --episodes 1000 --output /tmp/test.db
 *   node scripts/generate-test-store.mjs --empty --output /tmp/empty.db
 *   node scripts/generate-test-store.mjs --all-invalidated --no-embeddings --output /tmp/invalid.db
 *
 * Verification gate:
 *   node scripts/generate-test-store.mjs --episodes 10 --output /tmp/gate-verify.test.db
 *   ls -la /tmp/gate-verify.test.db  # must exist and be > 10 KB
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { GRAPH_DDL, FTS_DDL, FTS_TRIGGERS } from '@adhd/sox-graph-store';
import { createVectorDialect } from '@adhd/sox-store-adapter';

// ── Constants ──────────────────────────────────────────────────────────────────

const EMBED_DIM = 768;

/** Pragmas matching memory-core's convention (WAL, 3000ms busy timeout). */
const PRAGMAS = [
  ['journal_mode', 'WAL'],
  ['busy_timeout', 3000],
  ['synchronous', 'NORMAL'],
  ['foreign_keys', 'ON'],
  ['cache_size', -64000],
];

/** Memory-only DDL (not part of graph-store). */
const MEMORY_ONLY_DDL = `
CREATE TABLE IF NOT EXISTS memory_scope (
  scope        TEXT PRIMARY KEY CHECK (scope IN ('project','user','org','local')),
  scope_id     TEXT NOT NULL,
  embed_model  TEXT NOT NULL,
  embed_dim    INTEGER NOT NULL,
  schema_ver   INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sox_store_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizer_queue (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  op         TEXT NOT NULL CHECK (op IN ('ingest','enrich','extract','link','consolidate','decay','reindex')),
  payload    TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 100,
  enqueued   TEXT NOT NULL, claimed_at TEXT, done_at TEXT,
  attempts   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_q_open ON organizer_queue(done_at, priority, seq) WHERE done_at IS NULL;

CREATE TABLE IF NOT EXISTS request_ledger (
  request_id TEXT PRIMARY KEY,
  episode_uid TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_request_ledger_created_at ON request_ledger(created_at);

CREATE TABLE IF NOT EXISTS promotion_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  node_uid      TEXT NOT NULL, from_scope TEXT NOT NULL, to_scope TEXT NOT NULL,
  occurrences   INTEGER NOT NULL, first_seen TEXT NOT NULL, age_days INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','proposed','approved','rejected','applied')),
  decided_by    TEXT, decided_at TEXT
);
`;

// ── Lorem-ipsum data generator ─────────────────────────────────────────────────

const LOREM_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'veniam', 'quis', 'nostrud', 'exercitation', 'ullamco',
  'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo', 'consequat', 'duis',
  'aute', 'irure', 'reprehenderit', 'voluptate', 'velit', 'esse', 'cillum',
  'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint', 'occaecat', 'cupidatat',
  'proident', 'culpa', 'officia', 'deserunt', 'mollit', 'anim', 'laborum',
  'suspendisse', 'potenti', 'phasellus', 'feugiat', 'tincidunt', 'lacinia',
  'iaculis', 'porttitor', 'scelerisque', 'molestie', 'bibendum', 'gravida',
  'hendrerit', 'varius', 'sagittis', 'ornare', 'tortor', 'congue',
  'faucibus', 'fringilla', 'vehicula', 'egestas', 'interdum', 'platea',
  'dictumst', 'lobortis', 'lectus', 'pretium', 'semper', 'sociosqu',
  'torquent', 'per', 'conubia', 'nostra', 'inceptos', 'himenaeos',
  'fermentum', 'rutrum', 'viverra', 'accumsan', 'tempus', 'dignissim',
];

const TOPICS = [
  'development', 'architecture', 'design', 'bug', 'feature',
  'testing', 'deployment', 'documentation', 'research', 'planning',
  'optimization', 'security', 'observability', 'refactoring', 'integration',
];

const TAGS = [
  'typescript', 'sqlite', 'mcp', 'sox', 'memory', 'api', 'cli',
  'database', 'async', 'migration', 'testing', 'performance',
  'security', 'observability', 'refactoring', 'networking', 'data',
  'graph', 'vector', 'embedding', 'ingest', 'enrich', 'recall',
];

const PROJECT_PATHS = [
  '/projects/sox', '/projects/memory', '/projects/ai',
  '/projects/tools', '/projects/embedding', '/projects/ingest',
  '/docs', null, null, // more nulls for variety
];

const SOURCES = ['message', 'tool_output', 'observation', 'document', 'reflection', 'import'];
const AGENTS = ['user', 'assistant', 'system', 'tool', null];

// ── Random helpers ─────────────────────────────────────────────────────────────

function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

function randInt(min, max) {
  return (Math.random() * (max - min + 1) | 0) + min;
}

function pickN(arr, n) {
  const pool = [...arr];
  const picked = [];
  while (picked.length < n && pool.length > 0) {
    const idx = (Math.random() * pool.length) | 0;
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

function randomWords(n) {
  const words = [];
  for (let i = 0; i < n; i++) words.push(pick(LOREM_WORDS));
  return words.join(' ');
}

function randomSentence() {
  const len = randInt(6, 18);
  const words = randomWords(len);
  return words.charAt(0).toUpperCase() + words.slice(1) + '.';
}

function randomParagraph() {
  const sentences = randInt(2, 6);
  const parts = [];
  for (let i = 0; i < sentences; i++) parts.push(randomSentence());
  return parts.join(' ');
}

function randomTimestamp(daysBack = 90) {
  const now = Date.now();
  const offset = Math.random() * daysBack * 86_400_000;
  return new Date(now - offset).toISOString();
}

function randomVector() {
  const arr = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) arr[i] = Math.random() * 2 - 1;
  return '[' + Array.from(arr).map(v => v.toFixed(8)).join(',') + ']';
}

// ── CLI argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    episodes: 1000,
    output: undefined,
    empty: false,
    allInvalidated: false,
    noEmbeddings: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--episodes': {
        const val = argv[++i];
        if (val === undefined || isNaN(Number(val))) {
          console.error('error: --episodes requires a numeric argument');
          process.exit(1);
        }
        args.episodes = Math.max(0, parseInt(val, 10));
        break;
      }
      case '--output': {
        const val = argv[++i];
        if (val === undefined || val.startsWith('--')) {
          console.error('error: --output requires a path argument');
          process.exit(1);
        }
        args.output = path.resolve(val);
        break;
      }
      case '--empty':
        args.empty = true;
        break;
      case '--all-invalidated':
        args.allInvalidated = true;
        break;
      case '--no-embeddings':
        args.noEmbeddings = true;
        break;
      case '--help':
      case '-h':
        console.log(
          'generate-test-store.mjs — generate synthetic SQLite store files\n' +
          '\n' +
          'Usage:\n' +
          '  node scripts/generate-test-store.mjs [flags]\n' +
          '\n' +
          'Flags:\n' +
          '  --episodes <N>      Number of episodes to generate (default: 1000)\n' +
          '  --output <path>     Output store path (default: /tmp/sox-test-store.db)\n' +
          '  --empty             Create an empty store (no episodes, just schema)\n' +
          '  --all-invalidated   Mark all episodes as invalid (t_invalid set)\n' +
          '  --no-embeddings     Skip vector embeddings (no vec_node table)\n' +
          '  --help, -h          Show this help\n' +
          '\n' +
          'Examples:\n' +
          '  node scripts/generate-test-store.mjs --episodes 500 --output /tmp/test.db\n' +
          '  node scripts/generate-test-store.mjs --empty --output /tmp/schema-only.db\n' +
          '  node scripts/generate-test-store.mjs --episodes 10 --all-invalidated --output /tmp/dead.db\n'
        );
        process.exit(0);
      default:
        console.error(`error: unknown flag "${arg}". Use --help for usage.`);
        process.exit(1);
    }
  }

  if (!args.output) {
    args.output = path.resolve('/tmp/sox-test-store.db');
  }

  return args;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { episodes, output, empty, allInvalidated, noEmbeddings } = args;

  // Ensure parent directory exists
  const dir = path.dirname(output);
  fs.mkdirSync(dir, { recursive: true });

  // Open raw database with better-sqlite3
  const rawDb = new Database(output);

  // Apply pragmas
  for (const [key, value] of PRAGMAS) {
    rawDb.pragma(`${key} = ${value}`);
  }

  // Apply graph-store DDL (node, edge, indexes)
  rawDb.exec(GRAPH_DDL);

  // Apply memory-only DDL
  rawDb.exec(MEMORY_ONLY_DDL);

  // Apply FTS DDL and triggers
  rawDb.exec(FTS_DDL);
  rawDb.exec(FTS_TRIGGERS);

  // Add memory-specific columns that are not in the base graph-store DDL
  // These are added by openDb() via migrateAddColumn() on existing stores.
  // On a fresh store they would not exist on the base node table.
  const nodeCols = rawDb.pragma('table_info(node)', { simple: false }).map(r => r.name);
  if (!nodeCols.includes('enrich_ver')) {
    rawDb.exec('ALTER TABLE node ADD COLUMN enrich_ver TEXT');
  }
  if (!nodeCols.includes('embed_model')) {
    rawDb.exec('ALTER TABLE node ADD COLUMN embed_model TEXT');
  }

  // Create vec_node virtual table if embeddings are enabled
  if (!noEmbeddings) {
    // Load sqlite-vec extension (required for vec0 virtual table)
    const { load: loadSqliteVec } = await import('sqlite-vec');
    loadSqliteVec(rawDb);

    // Create vec0 table via the store-adapter's vector dialect
    const vectorDialect = createVectorDialect('sqlite');
    const vecDdl = vectorDialect.createTableDDL('vec_node', 'embedding', EMBED_DIM);
    rawDb.exec(vecDdl);
  }

  // Stamp store identity metadata
  const stamp = rawDb.prepare(
    'INSERT OR IGNORE INTO sox_store_meta(key, value) VALUES (?, ?)'
  );
  stamp.run('schema_version', '1');
  stamp.run('writer_artifact', 'generate-test-store.mjs');
  stamp.run('embed_model', 'bge-base-en-v1.5');
  stamp.run('embed_dimensions', String(EMBED_DIM));

  // Insert memory_scope row
  rawDb.prepare(
    `INSERT OR IGNORE INTO memory_scope(scope, scope_id, embed_model, embed_dim, schema_ver, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('project', 'test-scope', 'bge-base-en-v1.5', EMBED_DIM, 1, new Date().toISOString());

  // ── Bulk episode generation ──────────────────────────────────────────────────

  if (empty || episodes === 0) {
    console.error(`Created empty store at ${output} (schema only, no episodes)`);
    rawDb.close();
    process.exit(0);
  }

  const insertNode = rawDb.prepare(`
    INSERT INTO node(
      uid, kind, content, name, summary, topic, tags, importance, confidence,
      content_hash, namespace, meta, agent_id, session_id, source, project_path,
      level, t_occurred, t_created, t_valid, t_invalid, is_superseded,
      access_count, last_access, t_updated, enrich_ver, embed_model
    ) VALUES (
      ?, 'episode', ?, ?, ?, ?, ?, ?, ?,
      ?, 'global', ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, 0,
      0, ?, ?, ?, ?
    )
  `);

  const insertVec = !noEmbeddings
    ? rawDb.prepare(
        'INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)'
      )
    : null;

  // Wrap in a transaction for maximum throughput
  const bulkInsert = rawDb.transaction(() => {
    for (let i = 0; i < episodes; i++) {
      const uid = randomUUID();
      const content = randomParagraph();
      const name = randomWords(randInt(2, 7));
      const summary = randomSentence();
      const topic = pick(TOPICS);
      const tags = pickN(TAGS, randInt(1, 5)).join(',');
      const importance = Math.random() * 5;
      const confidence = 0.3 + Math.random() * 0.7;
      const contentHash = randomUUID().replace(/-/g, '');
      const meta = JSON.stringify({ generated: true, index: i });
      const agentId = pick(AGENTS);
      const sessionId = randomUUID();
      const source = pick(SOURCES);
      const projectPath = pick(PROJECT_PATHS);
      const level = Math.random() > 0.65 ? randInt(1, 10) : null;
      const tOccurred = randomTimestamp();
      const tCreated = new Date(
        Date.parse(tOccurred) + randInt(0, 300_000)
      ).toISOString();
      const tValid = tCreated;
      const tInvalid = allInvalidated
        ? new Date(
            Date.parse(tCreated) + randInt(86_400_000, 30 * 86_400_000)
          ).toISOString()
        : null;
      const tUpdated = Math.random() > 0.5
        ? new Date(
            Date.parse(tCreated) + randInt(60_000, 7 * 86_400_000)
          ).toISOString()
        : null;
      const lastAccess = Math.random() > 0.7
        ? randomTimestamp(30)
        : null;
      const enrichVer = Math.random() > 0.3 ? 'v2' : null;
      const embedModel = !noEmbeddings ? 'bge-base-en-v1.5' : null;

      const result = insertNode.run(
        uid, content, name, summary, topic, tags, importance, confidence,
        contentHash, meta, agentId, sessionId, source, projectPath,
        level, tOccurred, tCreated, tValid, tInvalid,
        tUpdated, lastAccess, enrichVer, embedModel,
      );

      if (insertVec) {
        const vector = randomVector();
        insertVec.run(result.lastInsertRowid, vector);
      }
    }
  });

  // Run the bulk insert
  const startTime = Date.now();
  console.error(`Generating ${episodes} episodes...`);
  bulkInsert();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.error(`Inserted ${episodes} episodes in ${elapsed}s`);

  rawDb.close();

  // Validate output
  const stat = fs.statSync(output);
  if (stat.size === 0) {
    console.error(`error: output file ${output} is empty`);
    process.exit(1);
  }

  console.error(`Store written to ${output} (${(stat.size / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
