/**
 * memory_recall — deterministic hot path, <50ms, zero LLM/provider calls.
 *
 * Algorithm (design.md §2.3):
 *   1. query-embed (local hash embedding, zero provider calls)
 *   2. parallel: vec0 KNN + FTS5 BM25 + temporal filter
 *   3. graph expand depth-1 over live edges (recursive CTE)
 *   4. RRF (k=60) fusion
 *   5. recency × importance rerank (decay 0.995/h)
 *   6. assemble within token_budget
 */

import Database from 'better-sqlite3';
import { embedText, vecToJson, getProviderCallCount } from './embed.js';

export interface RecallParams {
  query: string;
  scopes?: string[] | undefined;
  agent_id?: string | undefined;
  filters?: Record<string, unknown> | undefined;
  as_of?: string | undefined;
  token_budget?: number | undefined;
  depth?: number | undefined;
  limit?: number | undefined;
}

export interface RecallResult {
  uid: string;
  content: string | null;
  score: number;
  t_valid: string | null;
  scope: string;
  provenance: string[];
  importance: number;
}

export interface RecallResponse {
  results: RecallResult[];
  provider_call_count: number;
}

const RRF_K = 60;
const RECENCY_DECAY_PER_HOUR = 0.995;
const DEFAULT_TOKEN_BUDGET = 4000;
const DEFAULT_DEPTH = 1;
const KNN_LIMIT = 20;
const FTS_LIMIT = 20;

/**
 * Estimate token count (rough: 1 token ≈ 4 chars)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Compute recency decay multiplier.
 * decay = 0.995^hours_since_created
 */
function recencyMultiplier(tCreated: string | null): number {
  if (!tCreated) return 1.0;
  const ageMs = Date.now() - new Date(tCreated).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  return Math.pow(RECENCY_DECAY_PER_HOUR, ageHours);
}

/**
 * RRF score contribution: 1 / (k + rank)
 */
function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

interface NodeRow {
  rowid: number;
  uid: string;
  content: string | null;
  name: string | null;
  summary: string | null;
  importance: number;
  t_created: string | null;
  t_valid: string | null;
  t_invalid: string | null;
  agent_id: string | null;
}

/**
 * Main recall function — executes the full hot path.
 * Invariant R1: zero provider/LLM calls (enforced by not calling any provider).
 */
export function memoryRecall(
  db: Database.Database,
  scope: string,
  params: RecallParams,
): RecallResponse {
  const {
    query,
    agent_id,
    as_of,
    token_budget = DEFAULT_TOKEN_BUDGET,
    depth = DEFAULT_DEPTH,
    limit = 10,
  } = params;

  const beforeCount = getProviderCallCount();

  // 1. Query embedding (zero provider calls — local hash only)
  const queryVec = embedText(query);
  const queryVecJson = vecToJson(queryVec);

  // Validity predicate
  const validityPred = as_of
    ? `(n.t_valid IS NULL OR n.t_valid <= '${as_of}') AND (n.t_invalid IS NULL OR n.t_invalid > '${as_of}')`
    : 'n.t_invalid IS NULL';

  const agentFilter =
    agent_id ? `AND n.agent_id = '${agent_id.replace(/'/g, "''")}'` : '';

  // 2a. Vec0 KNN search
  const vecRows = db
    .prepare<[string, number], { node_id: number; distance: number }>(
      `SELECT v.node_id, v.distance
       FROM vec_node v
       WHERE v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`,
    )
    .all(queryVecJson, KNN_LIMIT);

  // Build rowid → vec rank map
  const vecRanks = new Map<number, number>();
  vecRows.forEach((r, i) => vecRanks.set(r.node_id, i + 1));

  // 2b. FTS5 BM25 search (text search)
  const ftsQuery = query
    .replace(/['"*\-+]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .join(' ');

  const ftsRowids = new Map<number, number>();
  if (ftsQuery) {
    try {
      const ftsRows = db
        .prepare<[string, number], { rowid: number; rank: number }>(
          `SELECT rowid, rank FROM fts_node WHERE fts_node MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery, FTS_LIMIT);
      ftsRows.forEach((r, i) => ftsRowids.set(r.rowid, i + 1));
    } catch {
      // FTS query may fail on special chars — silently ignore
    }
  }

  // 2c. Temporal filter: recently created nodes (recency signal)
  const temporalRows = db
    .prepare<[number], { rowid: number; t_created: string }>(
      `SELECT rowid, t_created FROM node
       WHERE ${validityPred} ${agentFilter}
       ORDER BY t_created DESC LIMIT ?`,
    )
    .all(KNN_LIMIT) as { rowid: number; t_created: string }[];

  const temporalRanks = new Map<number, number>();
  temporalRows.forEach((r, i) => temporalRanks.set(r.rowid, i + 1));

  // Collect all candidate rowids
  const allRowids = new Set<number>([
    ...vecRanks.keys(),
    ...ftsRowids.keys(),
    ...temporalRanks.keys(),
  ]);

  if (allRowids.size === 0) {
    return { results: [], provider_call_count: 0 };
  }

  // 3. RRF fusion scores
  const rrfScores = new Map<number, number>();
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

  // 4. Fetch node details for all candidates
  const rowidList = [...allRowids].join(',');
  const nodes = db
    .prepare<[], NodeRow>(
      `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id
       FROM node WHERE rowid IN (${rowidList})`,
    )
    .all();

  // Filter by validity
  const validNodes = nodes.filter((n) => {
    if (as_of) {
      const validStart = !n.t_valid || n.t_valid <= as_of;
      const validEnd = !n.t_invalid || n.t_invalid > as_of;
      return validStart && validEnd;
    }
    return n.t_invalid === null;
  });

  // 5. Rerank: rrf_score × recency × importance
  const ranked = validNodes.map((n) => {
    const baseRrf = rrfScores.get(n.rowid) ?? 0;
    const recency = recencyMultiplier(n.t_created);
    const imp = (n.importance ?? 1.0) / 10.0; // normalize 1..10 → 0.1..1.0
    const finalScore = baseRrf * recency * (0.5 + 0.5 * imp);
    return { node: n, score: finalScore };
  });

  ranked.sort((a, b) => b.score - a.score);

  // 6. Graph depth-1 expansion via live edges
  const topRowids = ranked.slice(0, limit).map((r) => r.node.rowid);
  const expandedRowids = new Set<number>(topRowids);

  if (depth > 0 && topRowids.length > 0) {
    const validPred = as_of
      ? `(t_valid IS NULL OR t_valid <= '${as_of}') AND (t_invalid IS NULL OR t_invalid > '${as_of}')`
      : 't_invalid IS NULL';
    const neighborRows = db
      .prepare<[], { neighbor_id: number }>(
        `SELECT DISTINCT CASE WHEN src IN (${topRowids.join(',')}) THEN dst ELSE src END AS neighbor_id
         FROM edge
         WHERE (src IN (${topRowids.join(',')}) OR dst IN (${topRowids.join(',')}))
           AND t_expired IS NULL AND ${validPred}`,
      )
      .all();
    neighborRows.forEach((r) => expandedRowids.add(r.neighbor_id));
  }

  // Fetch expanded nodes not already in ranked
  const alreadyRanked = new Set(topRowids);
  const expandedNew = [...expandedRowids].filter((id) => !alreadyRanked.has(id));
  let expandedNodes: NodeRow[] = [];
  if (expandedNew.length > 0) {
    expandedNodes = db
      .prepare<[], NodeRow>(
        `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id
         FROM node WHERE rowid IN (${expandedNew.join(',')})`,
      )
      .all();
  }

  // Assemble final results within token_budget
  const results: RecallResult[] = [];
  let tokenCount = 0;

  const addResult = (node: NodeRow, score: number, provenance: string[]) => {
    const text = [node.content, node.name, node.summary]
      .filter(Boolean)
      .join(' ');
    const tokens = estimateTokens(text);
    if (tokenCount + tokens > token_budget && results.length > 0) return false;
    tokenCount += tokens;
    results.push({
      uid: node.uid,
      content: node.content,
      score,
      t_valid: node.t_valid,
      scope,
      provenance,
      importance: node.importance,
    });
    return true;
  };

  // Add primary results
  for (const { node, score } of ranked) {
    const provenance: string[] = [];
    if (vecRanks.has(node.rowid)) provenance.push('vec');
    if (ftsRowids.has(node.rowid)) provenance.push('fts');
    if (temporalRanks.has(node.rowid)) provenance.push('temporal');
    if (!addResult(node, score, provenance)) break;
    if (results.length >= limit) break;
  }

  // Add graph-expanded neighbors at reduced score
  for (const node of expandedNodes) {
    if (results.length >= limit) break;
    const baseRrf = rrfScores.get(node.rowid) ?? 0.001;
    const recency = recencyMultiplier(node.t_created);
    const imp = (node.importance ?? 1.0) / 10.0;
    const score = baseRrf * 0.5 * recency * (0.5 + 0.5 * imp);
    addResult(node, score, ['graph']);
  }

  const afterCount = getProviderCallCount();
  const providerCallCount = afterCount - beforeCount; // must be 0

  return { results, provider_call_count: providerCallCount };
}
