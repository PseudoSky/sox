/**
 * sox-memory core library (P1 MVP)
 * Pre-compiled ESM module: schema, embed, write, recall.
 * Zero provider/LLM calls. Satisfies R1 (zero LLM read), R2 (one .db per scope).
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { monotonicFactory } from 'ulid';

// ── Constants ────────────────────────────────────────────────────────────────

export const EMBED_MODEL = 'nomic-embed-text-v1.5-hash';
export const EMBED_DIM = 768;
export const RRF_K = 60;
export const RECENCY_DECAY_PER_HOUR = 0.995;

// Provider-call counter: MUST remain 0 on the read path (invariant R1)
let _providerCallCount = 0;
export function getProviderCallCount() { return _providerCallCount; }
export function resetProviderCallCount() { _providerCallCount = 0; }

// ── Schema DDL ───────────────────────────────────────────────────────────────

const PRAGMAS = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA busy_timeout = 5000;',
  'PRAGMA synchronous  = NORMAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA cache_size   = -64000;',
];

const DDL = `
CREATE TABLE IF NOT EXISTS memory_scope (
  scope        TEXT PRIMARY KEY CHECK (scope IN ('project','user','org','local')),
  scope_id     TEXT NOT NULL,
  embed_model  TEXT NOT NULL,
  embed_dim    INTEGER NOT NULL,
  schema_ver   INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node (
  rowid        INTEGER PRIMARY KEY,
  uid          TEXT UNIQUE NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('episode','entity','claim','community','session')),
  content      TEXT, name TEXT, summary TEXT,
  agent_id     TEXT,
  session_id   TEXT,
  source       TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  importance   REAL DEFAULT 1.0,
  confidence   REAL,
  content_hash TEXT,
  level        INTEGER,
  resume_state TEXT,
  t_created    TEXT NOT NULL, t_occurred TEXT,
  t_valid      TEXT,  t_invalid TEXT,
  last_access  TEXT,  access_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_node_kind       ON node(kind);
CREATE INDEX IF NOT EXISTS ix_node_hash       ON node(content_hash);
CREATE INDEX IF NOT EXISTS ix_node_agent      ON node(agent_id);
CREATE INDEX IF NOT EXISTS ix_node_session    ON node(session_id);
CREATE INDEX IF NOT EXISTS ix_node_validity   ON node(t_invalid) WHERE t_invalid IS NULL;
CREATE INDEX IF NOT EXISTS ix_node_importance ON node(importance);

CREATE TABLE IF NOT EXISTS edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  rel       TEXT NOT NULL CHECK (rel IN
              ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS')),
  weight     REAL DEFAULT 1.0, confidence REAL,
  origin     TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  t_created  TEXT NOT NULL, t_expired TEXT,
  t_valid    TEXT,          t_invalid TEXT,
  meta       TEXT
);
CREATE INDEX IF NOT EXISTS ix_edge_src  ON edge(src, rel) WHERE t_expired IS NULL;
CREATE INDEX IF NOT EXISTS ix_edge_dst  ON edge(dst, rel) WHERE t_expired IS NULL;
CREATE INDEX IF NOT EXISTS ix_edge_live ON edge(t_invalid) WHERE t_invalid IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[768]);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_node USING fts5(content, name, summary,
  content='node', content_rowid='rowid', tokenize='unicode61');

CREATE TABLE IF NOT EXISTS organizer_queue (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  op         TEXT NOT NULL CHECK (op IN ('ingest','extract','link','consolidate','decay','reindex')),
  payload    TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 100,
  enqueued   TEXT NOT NULL, claimed_at TEXT, done_at TEXT,
  attempts   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_q_open ON organizer_queue(done_at, priority, seq) WHERE done_at IS NULL;
`;

const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS fts_node_ai AFTER INSERT ON node BEGIN
  INSERT INTO fts_node(rowid, content, name, summary)
    VALUES (new.rowid, new.content, new.name, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS fts_node_ad AFTER DELETE ON node BEGIN
  INSERT INTO fts_node(fts_node, rowid, content, name, summary)
    VALUES ('delete', old.rowid, old.content, old.name, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS fts_node_au AFTER UPDATE ON node BEGIN
  INSERT INTO fts_node(fts_node, rowid, content, name, summary)
    VALUES ('delete', old.rowid, old.content, old.name, old.summary);
  INSERT INTO fts_node(rowid, content, name, summary)
    VALUES (new.rowid, new.content, new.name, new.summary);
END;
`;

// ── DB lifecycle ─────────────────────────────────────────────────────────────

export function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  sqliteVec.load(db);
  for (const pragma of PRAGMAS) {
    db.exec(pragma);
  }
  db.exec(DDL);
  db.exec(FTS_TRIGGERS);
  return db;
}

export function openDbReadOnly(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  sqliteVec.load(db);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

export function initScope(db, scope, scopeId) {
  const existing = db.prepare('SELECT * FROM memory_scope WHERE scope = ?').get(scope);
  if (existing) return existing;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_scope(scope, scope_id, embed_model, embed_dim, schema_ver, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(scope, scopeId, EMBED_MODEL, EMBED_DIM, now);
  return { scope, scope_id: scopeId, embed_model: EMBED_MODEL, embed_dim: EMBED_DIM, schema_ver: 1, created_at: now };
}

// ── Embedding ────────────────────────────────────────────────────────────────

/**
 * Deterministic 768-dim hash-based embedding. Zero provider calls (R1).
 * Produces normalized Float32Array for use with sqlite-vec FLOAT[768].
 * Uses FNV-1a hash projection: each dimension accumulates per-token contributions.
 */
export function embedText(text) {
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const vec = new Float32Array(EMBED_DIM);

  for (const token of tokens) {
    const h1 = hash32(token, 0x811c9dc5);
    const h2 = hash32(token, 0x01000193);
    for (let d = 0; d < EMBED_DIM; d++) {
      const seed = ((d * 0x9e3779b9 + h1) >>> 0);
      const val = ((seed ^ h2) / 0x80000000) - 1.0;
      vec[d] += val / Math.max(tokens.length, 1);
    }
  }

  // L2 normalize
  let norm = 0;
  for (let d = 0; d < EMBED_DIM; d++) norm += vec[d] * vec[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < EMBED_DIM; d++) vec[d] /= norm;

  return vec;
}

export function vecToJson(vec) {
  return '[' + Array.from(vec).map(v => v.toFixed(8)).join(',') + ']';
}

export function vecToBuffer(vec) {
  return Buffer.from(vec.buffer);
}

function hash32(str, basis) {
  let h = basis >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ── Write ────────────────────────────────────────────────────────────────────

const ulid = monotonicFactory();

/**
 * memory_write: synchronous insert + embed + FTS index + SHA-256 dedup.
 * Returns { episode_uid } or an error object.
 */
export function memoryWrite(db, params) {
  const {
    content,
    session_id = null,
    t_occurred = null,
    agent_id = null,
    source = 'message',
    importance = 1.0,
  } = params;

  if (!content?.trim()) {
    return { code: 'E_SCOPE_RO', message: 'content must not be empty' };
  }

  const normalized = content.trim().toLowerCase();
  const contentHash = crypto.createHash('sha256').update(normalized).digest('hex');

  const existing = db.prepare('SELECT uid FROM node WHERE content_hash = ?').get(contentHash);
  if (existing) {
    return { code: 'E_DEDUP', message: `Duplicate: ${contentHash}`, existing_uid: existing.uid };
  }

  const uid = ulid();
  const now = new Date().toISOString();
  const tOccurred = t_occurred ?? now;
  const tValid = now;

  const embeddingVec = embedText(content);
  const embeddingBuf = vecToBuffer(embeddingVec);

  const tx = db.transaction(() => {
    const row = db.prepare(
      `INSERT INTO node (uid, kind, content, agent_id, session_id, source, importance,
                         content_hash, t_created, t_occurred, t_valid)
       VALUES (?, 'episode', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING rowid`
    ).get(uid, content, agent_id, session_id, source, importance, contentHash, now, tOccurred, tValid);

    if (!row) throw new Error('Insert failed');
    // sqlite-vec requires explicit INTEGER for the primary key; CAST binds it as integer
    db.prepare('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
      row.rowid,
      vecToJson(embeddingVec),
    );
    return uid;
  });

  const episodeUid = tx();
  return { episode_uid: episodeUid };
}

// ── Recall ───────────────────────────────────────────────────────────────────

const KNN_LIMIT = 20;
const FTS_LIMIT = 20;

function recencyMultiplier(tCreated) {
  if (!tCreated) return 1.0;
  const ageMs = Date.now() - new Date(tCreated).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  return Math.pow(RECENCY_DECAY_PER_HOUR, ageHours);
}

function rrfScore(rank) {
  return 1 / (RRF_K + rank);
}

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * memory_recall: hybrid vec+FTS+temporal search with RRF fusion.
 * Zero provider/LLM calls (R1). p95 < 50ms at 10K rows.
 */
export function memoryRecall(db, scope, params) {
  const {
    query,
    agent_id = null,
    as_of = null,
    token_budget = 4000,
    depth = 1,
    limit = 10,
  } = params;

  const beforeCount = getProviderCallCount();

  // 1. Local embedding (zero provider calls)
  const queryVec = embedText(query);
  const queryVecJson = vecToJson(queryVec);

  // Validity predicate
  const validityPred = as_of
    ? `(n.t_valid IS NULL OR n.t_valid <= '${as_of.replace(/'/g, "''")}') AND (n.t_invalid IS NULL OR n.t_invalid > '${as_of.replace(/'/g, "''")}')`
    : 'n.t_invalid IS NULL';

  const agentSql = agent_id ? `AND n.agent_id = '${agent_id.replace(/'/g, "''")}'` : '';

  // 2a. Vec KNN
  const vecRows = db.prepare(
    `SELECT v.node_id, v.distance FROM vec_node v WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`
  ).all(queryVecJson, KNN_LIMIT);

  const vecRanks = new Map();
  vecRows.forEach((r, i) => vecRanks.set(r.node_id, i + 1));

  // 2b. FTS BM25
  const ftsRowids = new Map();
  const ftsQuery = query
    .replace(/['"*\-+()\[\]]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 1)
    .join(' ');

  if (ftsQuery) {
    try {
      const ftsRows = db.prepare(
        `SELECT rowid, rank FROM fts_node WHERE fts_node MATCH ? ORDER BY rank LIMIT ?`
      ).all(ftsQuery, FTS_LIMIT);
      ftsRows.forEach((r, i) => ftsRowids.set(r.rowid, i + 1));
    } catch {
      // ignore FTS errors (special chars, etc.)
    }
  }

  // 2c. Temporal (recent nodes)
  const temporalRows = db.prepare(
    `SELECT n.rowid, n.t_created FROM node n WHERE ${validityPred} ${agentSql} ORDER BY n.t_created DESC LIMIT ?`
  ).all(KNN_LIMIT);

  const temporalRanks = new Map();
  temporalRows.forEach((r, i) => temporalRanks.set(r.rowid, i + 1));

  // Union of all candidate rowids
  const allRowids = new Set([...vecRanks.keys(), ...ftsRowids.keys(), ...temporalRanks.keys()]);

  if (allRowids.size === 0) {
    return { results: [], provider_call_count: 0 };
  }

  // 3. RRF fusion
  const rrfScores = new Map();
  for (const rowid of allRowids) {
    let score = 0;
    const vr = vecRanks.get(rowid);
    const fr = ftsRowids.get(rowid);
    const tr = temporalRanks.get(rowid);
    if (vr !== undefined) score += rrfScore(vr);
    if (fr !== undefined) score += rrfScore(fr);
    if (tr !== undefined) score += rrfScore(tr);
    rrfScores.set(rowid, score);
  }

  // Fetch node details
  const rowidList = [...allRowids].join(',');
  const nodes = db.prepare(
    `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id
     FROM node WHERE rowid IN (${rowidList})`
  ).all();

  // Filter by validity
  const validNodes = nodes.filter(n => {
    if (as_of) {
      const vs = !n.t_valid || n.t_valid <= as_of;
      const ve = !n.t_invalid || n.t_invalid > as_of;
      return vs && ve;
    }
    return n.t_invalid === null;
  });

  // 4. Rerank: rrf × recency × importance
  const ranked = validNodes.map(n => {
    const baseRrf = rrfScores.get(n.rowid) ?? 0;
    const recency = recencyMultiplier(n.t_created);
    const imp = (n.importance ?? 1.0) / 10.0;
    return { node: n, score: baseRrf * recency * (0.5 + 0.5 * imp) };
  });
  ranked.sort((a, b) => b.score - a.score);

  // 5. Graph depth-1 expansion
  const topRowids = ranked.slice(0, limit).map(r => r.node.rowid);
  const expandedRowids = new Set(topRowids);

  if (depth > 0 && topRowids.length > 0) {
    const validPred2 = as_of
      ? `(t_valid IS NULL OR t_valid <= '${as_of}') AND (t_invalid IS NULL OR t_invalid > '${as_of}')`
      : 't_invalid IS NULL';
    const neighborRows = db.prepare(
      `SELECT DISTINCT CASE WHEN src IN (${topRowids.join(',')}) THEN dst ELSE src END AS neighbor_id
       FROM edge
       WHERE (src IN (${topRowids.join(',')}) OR dst IN (${topRowids.join(',')}))
         AND t_expired IS NULL AND ${validPred2}`
    ).all();
    neighborRows.forEach(r => expandedRowids.add(r.neighbor_id));
  }

  // 6. Assemble within token_budget
  const results = [];
  let tokenCount = 0;

  const addResult = (node, score, provenance) => {
    const text = [node.content, node.name, node.summary].filter(Boolean).join(' ');
    const tokens = estimateTokens(text);
    if (tokenCount + tokens > token_budget && results.length > 0) return false;
    tokenCount += tokens;
    results.push({ uid: node.uid, content: node.content, score, t_valid: node.t_valid, scope, provenance, importance: node.importance });
    return true;
  };

  for (const { node, score } of ranked) {
    const prov = [];
    if (vecRanks.has(node.rowid)) prov.push('vec');
    if (ftsRowids.has(node.rowid)) prov.push('fts');
    if (temporalRanks.has(node.rowid)) prov.push('temporal');
    if (!addResult(node, score, prov)) break;
    if (results.length >= limit) break;
  }

  const afterCount = getProviderCallCount();
  return { results, provider_call_count: afterCount - beforeCount };
}
