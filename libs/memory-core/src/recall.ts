/**
 * memory_recall — deterministic hot path, <50ms, zero LLM/provider calls.
 * federatedRecall — cross-scope RRF union (design.md §2.7).
 *
 * Algorithm per-store (design.md §2.3):
 *   1. query-embed (local hash embedding, zero provider calls)
 *   2. parallel: vec0 KNN + FTS5 BM25 + temporal filter
 *   3. graph expand depth-1 over live edges (project store only in federation)
 *   4. RRF (k=60) fusion
 *   5. recency × importance rerank (decay 0.995/h)
 *   6. assemble within token_budget
 *
 * Federation (design.md §2.7):
 *   score = scope_weight(scope) · Σ 1/(k+rank), k=60
 *   weights: project=1.0, user=0.6, org=0.4, local=1.0
 *   agent_id match ×1.25 boost; cross-store content-hash dedup; SUPERSEDES suppression.
 */

import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { embed, vecToJson, getProviderCallCount } from './embed.js';
import { openDbReadOnly } from './db.js';
import { buildFilterClause } from '@adhd/sox-hybrid-search';

export interface RecallParams {
  query: string;
  scopes?: string[] | undefined;
  agent_id?: string | undefined;
  filters?: Record<string, unknown> | undefined;
  as_of?: string | undefined;
  token_budget?: number | undefined;
  depth?: number | undefined;
  limit?: number | undefined;
  vec_weight?: number | undefined;
  fts_weight?: number | undefined;
  temporal_weight?: number | undefined;

  // ── Parent-context expansion (PR #5.1, opt-in) ────────────────────────────
  parentContext?: ParentContextConfig;

  // ── Late chunking (PR #5.2, opt-in) ────────────────────────────────────────
  lateChunking?: LateChunkingConfig;
}

/**
 * Per-channel score breakdown for a single recall result.
 *
 * All channel values are non-negative and sum to `total`, which equals the
 * `score` field on the parent RecallResult (within fp tolerance < 1e-10).
 *
 * Channels correspond to the three RRF signals used in the recall pipeline:
 *   vec      — vector (cosine KNN) channel contribution
 *   bm25     — FTS5 BM25 text channel contribution
 *   temporal — recency-importance rerank channel contribution
 *
 * Normalization: each RRF channel is independently normalised via min-max
 * across the candidate set (per-query), weighted, then scaled by the
 * per-result rerank factor (recency × importance).  The breakdown preserves
 * that proportionality: vec + bm25 + temporal === total === score.
 *
 * Cross-query comparability: because each channel is min-max normalised
 * within its own result set, the raw RRF magnitudes (which vary with result
 * count and rank distribution) cancel out.  Scores from two different queries
 * live on the same [0, 1] scale and can be compared meaningfully.
 */
export interface ScoreBreakdown {
  /** Contribution from the vector (cosine KNN) channel. */
  vec: number;
  /** Contribution from the FTS5 BM25 text channel. */
  bm25: number;
  /** Contribution from the temporal-recency-importance rerank. */
  temporal: number;
  /** Sum of all channels — equals score (within fp tolerance). */
  total: number;
}

export interface RecallResult {
  uid: string;
  content: string | null;
  score: number;
  /** Additive per-channel breakdown of score. Present on all results. */
  score_breakdown: ScoreBreakdown;
  t_valid: string | null;
  scope: string;
  provenance: string[];
  importance: number;
  content_hash: string | null;
  agent_id: string | null;

  // ── Expansion fields (empty if not configured) ────────────────────────────
  expandedText: string;
  expansionSources: Array<{
    chunk: { uid: string; content: string | null; name: string | null };
    depth: number;
  }>;
}

export interface RecallResponse {
  results: RecallResult[];
  provider_call_count: number;
  filterStats?: {
    candidates_before_filter: number;
    candidates_after_filter: number;
  };
  metadata: {
    totalChunksRetrieved: number;
    totalChunksAfterExpansion: number;
    lateChunkingApplied: boolean;
    totalTokensAfterExpansion: number;
    expansionTruncated: boolean;
  };
}

// ── Parent-context expansion ──────────────────────────────────────────────────

export interface ParentContextConfig {
  maxDepth?: number;
  maxContextTokens?: number;
  joinStrategy: 'contiguous' | 'separator' | 'structured' | 'truncate-tail';
  separator?: string;
  includeOriginal?: boolean;
}

// ── Late chunking ─────────────────────────────────────────────────────────────

export interface LateChunkingConfig {
  enabled: boolean;
  boundaries: Array<{ startToken: number; endToken: number; metadata?: Record<string, unknown> }>;
  overlapTokens?: number;
}

// ── Error types ───────────────────────────────────────────────────────────────

export class ExpansionOverflowError extends Error {
  constructor(
    message: string,
    public readonly requestedTokens: number,
    public readonly maxTokens: number,
  ) {
    super(message);
    this.name = 'ExpansionOverflowError';
  }
}

const RRF_K = 60;
const RECENCY_DECAY_PER_HOUR = 0.995;
const DEFAULT_TOKEN_BUDGET = 32000; // was 4000 — too small for doc-scale nodes
const DEFAULT_DEPTH = 1;
const KNN_LIMIT = 20;
const FTS_LIMIT = 20;

// Per-signal RRF weights. Temporal is down-weighted (0.4) because recency
// already enters via the recency × importance rerank; giving it equal 1:1:1
// weight double-counted freshness and buried older-but-relevant matches.
const VEC_WEIGHT = 1.0;
const FTS_WEIGHT = 0.8;
const TEMPORAL_WEIGHT = 0.4;

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
  content_hash: string | null;
  session_id: string | null;
}

/**
 * Main recall function — executes the full hot path.
 * Invariant R1: zero provider/LLM calls (enforced by not calling any provider).
 */
export async function memoryRecall(
  db: Database.Database,
  scope: string,
  params: RecallParams,
): Promise<RecallResponse> {
  const {
    query,
    agent_id,
    as_of,
    filters,
    token_budget = DEFAULT_TOKEN_BUDGET,
    depth = DEFAULT_DEPTH,
    limit = 10,
    vec_weight = VEC_WEIGHT,
    fts_weight = FTS_WEIGHT,
    temporal_weight = TEMPORAL_WEIGHT,
  } = params;

  const beforeCount = getProviderCallCount();

  // BL-100: resolve filters into SQL pre-filter clauses. Uses hybrid-search's
  // buildFilterClause for the standard fields (topic, tags, importance_min,
  // project_path, agent_id) and adds time-range + tags_match_all directly.
  let filterSql = '';
  let filterParams: unknown[] = [];
  if (filters && Object.keys(filters).length > 0) {
    // Separate fields that hybrid-search can handle natively from those it cannot.
    // project_path objects {prefix: string} and tags_match_all bool are handled here.
    const nativeFilters: Record<string, unknown> = {};
    const nodeClauses: string[] = [];
    const nodeParams: unknown[] = [];

    for (const [key, value] of Object.entries(filters)) {
      switch (key) {
        case 'project_path': {
          if (value !== undefined && value !== null && typeof value === 'object' && 'prefix' in (value as object)) {
            const prefix = (value as { prefix: string }).prefix;
            nodeClauses.push('(n.project_path = ? OR n.project_path LIKE ?)');
            nodeParams.push(prefix, `${prefix}/%`);
          } else if (typeof value === 'string') {
            nativeFilters[key] = value;
          }
          break;
        }
        case 'tags_match_all':
          // Handled separately below when tags are present
          break;
        case 't_created_after':
          if (typeof value === 'string') {
            nodeClauses.push('n.t_created > ?');
            nodeParams.push(value);
          }
          break;
        case 't_created_before':
          if (typeof value === 'string') {
            nodeClauses.push('n.t_created < ?');
            nodeParams.push(value);
          }
          break;
        default:
          nativeFilters[key] = value;
      }
    }

    // Use hybrid-search's builder for standard NodeFilter fields
    const { nodeFilter, extraClauses } = buildFilterClause(nativeFilters);

    // Build SQL from nodeFilter (fields that map to node table columns)
    if (nodeFilter.topic !== undefined) {
      if (Array.isArray(nodeFilter.topic)) {
        nodeClauses.push(`n.topic IN (${nodeFilter.topic.map(() => '?').join(',')})`);
        nodeParams.push(...nodeFilter.topic);
      } else {
        nodeClauses.push('n.topic = ?');
        nodeParams.push(nodeFilter.topic);
      }
    }

    if (nodeFilter.tags !== undefined && nodeFilter.tags.length > 0) {
      const tagsMatchAll = (filters as Record<string, unknown>)['tags_match_all'] === true;
      if (tagsMatchAll) {
        const tagClauses = nodeFilter.tags.map(
          () => `EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)`,
        );
        nodeClauses.push(`(${tagClauses.join(' AND ')})`);
        nodeParams.push(...nodeFilter.tags);
      } else {
        const tagClauses = nodeFilter.tags.map(
          () => `EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)`,
        );
        nodeClauses.push(`(${tagClauses.join(' OR ')})`);
        nodeParams.push(...nodeFilter.tags);
      }
    }

    if (nodeFilter.importanceMin !== undefined) {
      nodeClauses.push('n.importance >= ?');
      nodeParams.push(nodeFilter.importanceMin);
    }

    // Combine nodeFilter SQL + extraClauses (project_path as string, agent_id, etc.)
    const allSqlParts = [...nodeClauses];
    if (extraClauses.sql) {
      allSqlParts.push(extraClauses.sql.replace(/^AND\s+/, ''));
    }

    if (allSqlParts.length > 0) {
      filterSql = ' AND ' + allSqlParts.join(' AND ');
      filterParams = [...nodeParams, ...extraClauses.params];
    }
  }

  // 1. Query embedding — zero per-query network calls (R1).
  //    Real backend: local ONNX inference; hash backend: deterministic projection.
  const queryVec = await embed(query);
  const queryVecJson = vecToJson(queryVec);

  // Validity predicate
  const validityPred = as_of
    ? `(n.t_valid IS NULL OR n.t_valid <= '${as_of}') AND (n.t_invalid IS NULL OR n.t_invalid > '${as_of}')`
    : 'n.t_invalid IS NULL';


  const agentFilter =
    agent_id ? `AND n.agent_id = '${agent_id.replace(/'/g, "''")}'` : '';

  // 2a. Vec0 KNN search
  const vecSql = `SELECT v.node_id, v.distance
       FROM vec_node v
       JOIN node n ON n.rowid = v.node_id
       WHERE v.embedding MATCH ? AND k = ?
         AND ${validityPred}
         ${agentFilter}
         ${filterSql}
       ORDER BY v.distance
       LIMIT ?`;
  const vecParams: unknown[] = [queryVecJson, KNN_LIMIT, ...filterParams, KNN_LIMIT];
  const vecRows = db
    .prepare(vecSql)
    .all(...vecParams) as unknown as { node_id: number; distance: number }[];

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
        .prepare<[string, ...unknown[]], { rowid: number; rank: number }>(
          `SELECT fts_node.rowid, fts_node.rank
           FROM fts_node
           JOIN node n ON n.rowid = fts_node.rowid
           WHERE fts_node MATCH ?
             AND ${validityPred}
             ${agentFilter}
             ${filterSql}
           ORDER BY fts_node.rank
           LIMIT ?`,
        )
        .all(ftsQuery, ...filterParams, FTS_LIMIT);
      ftsRows.forEach((r, i) => ftsRowids.set(r.rowid, i + 1));
    } catch {
      // FTS query may fail on special chars — silently ignore
    }
  }

  // 2c. Temporal filter: recently created nodes (recency signal)
  // NOTE: validityPred and agentFilter use the alias "n", so the table must be aliased as n here.
  const temporalSql = `SELECT n.rowid, n.t_created FROM node n
       WHERE ${validityPred} ${agentFilter} ${filterSql}
       ORDER BY n.t_created DESC LIMIT ?`;
  const temporalParams: unknown[] = [...filterParams, KNN_LIMIT];
  const temporalRows = db
    .prepare(temporalSql)
    .all(...temporalParams) as unknown as { rowid: number; t_created: string }[];

  const temporalRanks = new Map<number, number>();
  temporalRows.forEach((r, i) => temporalRanks.set(r.rowid, i + 1));

  // Collect all candidate rowids
  const allRowids = new Set<number>([
    ...vecRanks.keys(),
    ...ftsRowids.keys(),
    ...temporalRanks.keys(),
  ]);

  if (allRowids.size === 0) {
    // BL-100: compute filterStats even when results are empty, so callers can
    // distinguish filtered-empty from empty-corpus.
    let filterStats: RecallResponse['filterStats'] | undefined;
    if (filterSql) {
      const beforeCount = (
        db.prepare<[], { cnt: number }>(
          `SELECT COUNT(*) as cnt FROM node n WHERE n.kind = 'episode' AND ${validityPred}`,
        ).get()
      )?.cnt ?? 0;
      const afterCount = (
        db.prepare(
          `SELECT COUNT(*) as cnt FROM node n WHERE n.kind = 'episode' AND ${validityPred} ${filterSql}`,
        ).get(...filterParams) as { cnt: number } | undefined
      )?.cnt ?? 0;
      filterStats = {
        candidates_before_filter: beforeCount,
        candidates_after_filter: afterCount,
      };
    }
    const response: RecallResponse = {
      results: [],
      provider_call_count: 0,
      metadata: {
        totalChunksRetrieved: 0,
        totalChunksAfterExpansion: 0,
        lateChunkingApplied: false,
        totalTokensAfterExpansion: 0,
        expansionTruncated: false,
      },
    };
    if (filterStats) response.filterStats = filterStats;
    return response;
  }

  // 3. RRF fusion scores — compute per-channel raw contributions first so we
  //    can min-max normalise them across the candidate set for the breakdown.
  interface RrfChannels {
    vecRaw: number;   // vec_weight * rrfScore(vecRank), 0 if absent
    ftsRaw: number;   // fts_weight * rrfScore(ftsRank), 0 if absent
    tempRaw: number;  // temporal_weight * rrfScore(tempRank), 0 if absent
    total: number;    // sum
  }
  const rrfChannels = new Map<number, RrfChannels>();
  const rrfScores = new Map<number, number>();
  for (const rowid of allRowids) {
    const vr = vecRanks.get(rowid);
    const fr = ftsRowids.get(rowid);
    const tr = temporalRanks.get(rowid);
    const vecRaw  = vr !== undefined ? vec_weight      * rrfScore(vr) : 0;
    const ftsRaw  = fr !== undefined ? fts_weight      * rrfScore(fr) : 0;
    const tempRaw = tr !== undefined ? temporal_weight * rrfScore(tr) : 0;
    const total   = vecRaw + ftsRaw + tempRaw;
    rrfChannels.set(rowid, { vecRaw, ftsRaw, tempRaw, total });
    rrfScores.set(rowid, total);
  }

  // Per-query min-max normalisation of each channel across all candidates.
  // This makes scores from two different queries land on the same [0, 1] scale.
  function minMaxNorm(vals: number[]): number[] {
    if (vals.length === 0) return [];
    let mn = Infinity, mx = -Infinity;
    for (const v of vals) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const range = mx - mn;
    if (range === 0) return vals.map(() => 1.0);
    return vals.map((v) => (v - mn) / range);
  }

  const rowidOrder = [...allRowids]; // stable ordering for normalisation
  const vecNormArr   = minMaxNorm(rowidOrder.map((id) => rrfChannels.get(id)!.vecRaw));
  const ftsNormArr   = minMaxNorm(rowidOrder.map((id) => rrfChannels.get(id)!.ftsRaw));
  const tempNormArr  = minMaxNorm(rowidOrder.map((id) => rrfChannels.get(id)!.tempRaw));

  // Store per-candidate normalised channel values (used later in addResult).
  interface NormChannels { vecNorm: number; ftsNorm: number; tempNorm: number }
  const normChannels = new Map<number, NormChannels>();
  for (let i = 0; i < rowidOrder.length; i++) {
    normChannels.set(rowidOrder[i]!, {
      vecNorm:  vecNormArr[i]!,
      ftsNorm:  ftsNormArr[i]!,
      tempNorm: tempNormArr[i]!,
    });
  }

  // 4. Fetch node details for all candidates
  const rowidList = [...allRowids].join(',');
  const nodes = db
    .prepare<[], NodeRow>(
      `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id, content_hash, session_id
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
  //
  // score_breakdown design:
  //   The final score is: baseRrf × rerank, where rerank = recency × (0.5 + 0.5×imp).
  //   We decompose the score into three additive channels whose sum equals the final
  //   score exactly:
  //     vec_contrib     = vecNorm  × rerank × (1/normTotal)  [proportional share]
  //     bm25_contrib    = ftsNorm  × rerank × (1/normTotal)
  //     temporal_contrib = tempNorm × rerank × (1/normTotal)
  //   where normTotal = vecNorm + ftsNorm + tempNorm (sum of normalised values).
  //   If normTotal == 0, all three channels get 0 and total gets the raw score.
  //
  //   This guarantees: vec_contrib + bm25_contrib + temporal_contrib = score,
  //   and each channel value is in [0, score].  The normalised channel values are
  //   per-query min-max scaled so scores from different queries are comparable.
  const ranked = validNodes.map((n) => {
    const baseRrf = rrfScores.get(n.rowid) ?? 0;
    const recency = recencyMultiplier(n.t_created);
    const imp = (n.importance ?? 1.0) / 10.0; // normalize 1..10 → 0.1..1.0
    const rerank = recency * (0.5 + 0.5 * imp);
    const finalScore = baseRrf * rerank;

    const nc = normChannels.get(n.rowid) ?? { vecNorm: 0, ftsNorm: 0, tempNorm: 0 };
    const normTotal = nc.vecNorm + nc.ftsNorm + nc.tempNorm;
    let vecContrib = 0, bm25Contrib = 0, tempContrib = 0;
    if (normTotal > 0) {
      vecContrib  = finalScore * (nc.vecNorm  / normTotal);
      bm25Contrib = finalScore * (nc.ftsNorm  / normTotal);
      tempContrib = finalScore * (nc.tempNorm / normTotal);
    }

    const breakdown: ScoreBreakdown = {
      vec:      vecContrib,
      bm25:     bm25Contrib,
      temporal: tempContrib,
      total:    finalScore,
    };
    return { node: n, score: finalScore, breakdown };
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
    const nodeValidPred = as_of
      ? `(t_valid IS NULL OR t_valid <= '${as_of.replace(/'/g, "''")}') AND (t_invalid IS NULL OR t_invalid > '${as_of.replace(/'/g, "''")}')`
      : 't_invalid IS NULL';
    expandedNodes = db
      .prepare<[], NodeRow>(
        `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id, content_hash, session_id
         FROM node WHERE rowid IN (${expandedNew.join(',')}) AND ${nodeValidPred}`,
      )
      .all();
  }

  // Assemble final results within token_budget
  const results: RecallResult[] = [];
  let tokenCount = 0;
  const sourceCounts = new Map<string, number>();
  const MAX_PER_SOURCE = Math.max(2, Math.ceil(limit / 5));

  const addResult = (node: NodeRow, score: number, provenance: string[], breakdown: ScoreBreakdown) => {
    const text = [node.content, node.name, node.summary]
      .filter(Boolean)
      .join(' ');
    const tokens = estimateTokens(text);
    if (tokenCount + tokens > token_budget && results.length > 0) return false;
    // Per-source diversity cap: prevent one verbose document from filling top-N
    const sourceKey = node.content_hash ?? node.uid;
    const sourceCount = sourceCounts.get(sourceKey) ?? 0;
    if (sourceCount >= MAX_PER_SOURCE) return false;
    sourceCounts.set(sourceKey, sourceCount + 1);
    tokenCount += tokens;
    results.push({
      uid: node.uid,
      content: node.content,
      score,
      score_breakdown: breakdown,
      t_valid: node.t_valid,
      scope,
      provenance,
      importance: node.importance,
      content_hash: node.content_hash ?? null,
      agent_id: node.agent_id ?? null,
      expandedText: '',
      expansionSources: [],
    });
    return true;
  };

  // Add primary results
  for (const { node, score, breakdown } of ranked) {
    const provenance: string[] = [];
    if (vecRanks.has(node.rowid)) provenance.push('vec');
    if (ftsRowids.has(node.rowid)) provenance.push('fts');
    if (temporalRanks.has(node.rowid)) provenance.push('temporal');
    if (!addResult(node, score, provenance, breakdown)) break;
    if (results.length >= limit) break;
  }

  // Add graph-expanded neighbors at reduced score
  for (const node of expandedNodes) {
    if (results.length >= limit) break;
    const baseRrf = rrfScores.get(node.rowid) ?? 0.001;
    const recency = recencyMultiplier(node.t_created);
    const imp = (node.importance ?? 1.0) / 10.0;
    const score = baseRrf * 0.5 * recency * (0.5 + 0.5 * imp);
    // Graph-expanded neighbors get a zero-breakdown (they originate from graph
    // traversal, not from a ranked channel signal).
    const graphBreakdown: ScoreBreakdown = { vec: 0, bm25: 0, temporal: 0, total: score };
    addResult(node, score, ['graph'], graphBreakdown);
  }

  // ── Parent-context expansion ───────────────────────────────────────────────
  // Opt-in: expands each result chunk to include parent/grandparent context.
  // Recursive expansion via DERIVED_FROM edges: chunk → parent → grandparent →
  // ... up to maxDepth. Uses Chunk.parentDocId (session_id) as the join key for
  // parent lookups when DERIVED_FROM edges are absent.
  let expansionTruncated = false;
  let totalTokensAfterExpansion = 0;

  if (params.parentContext && results.length > 0) {
    const pc = params.parentContext;
    const maxDepth = pc.maxDepth ?? 0;
    const maxContextTokens = pc.maxContextTokens ?? 4096;

    // Build lookup maps from validNodes (already fetched candidates) for fast access.
    const nodeByRowid = new Map<number, NodeRow>();
    const nodeByUid = new Map<string, NodeRow>();
    for (const node of validNodes) {
      nodeByRowid.set(node.rowid, node);
      nodeByUid.set(node.uid, node);
    }

    // Prepared statements for parent traversal.
    const stmtParentEdge = db.prepare<[number], { dst: number }>(
      `SELECT dst FROM edge WHERE src = ? AND rel = 'DERIVED_FROM' AND t_expired IS NULL LIMIT 1`,
    );
    const stmtNodeByRowid = db.prepare<[number], NodeRow>(
      `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id, content_hash, session_id
       FROM node WHERE rowid = ?`,
    );

    for (const result of results) {
      const sources: Array<{ chunk: { uid: string; content: string | null; name: string | null }; depth: number }> = [];

      // Find the result node's rowid and name for depth 0.
      const resultNode = nodeByUid.get(result.uid);
      const resultName = resultNode?.name ?? null;

      sources.push({
        chunk: { uid: result.uid, content: result.content, name: resultName },
        depth: 0,
      });

      let currentRowid = resultNode?.rowid ?? null;
      let expandedTokens = estimateTokens(result.content ?? '');

      for (let depth = 1; depth <= maxDepth && currentRowid !== null; depth++) {
        // Stop early for truncate-tail when at/beyond limit (further parents won't fit).
        if (pc.joinStrategy === 'truncate-tail' && expandedTokens >= maxContextTokens) {
          expansionTruncated = true;
          break;
        }

        // Find parent via DERIVED_FROM edge.
        const parentEdge = stmtParentEdge.get(currentRowid);
        if (!parentEdge) {
          // Fallback: parentDocId lookup — session_id IS the parent's UID
          const currentNode = nodeByRowid.get(currentRowid);
          if (currentNode?.session_id) {
            const parentRow = db.prepare(
              `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id, content_hash
               FROM node WHERE uid = ?`,
            ).get(currentNode.session_id) as NodeRow | undefined;
            if (parentRow) {
              const parentText = [parentRow.content, parentRow.name, parentRow.summary]
                .filter(Boolean)
                .join(' ');

              if (parentText) {
                const parentTokens = estimateTokens(parentText);
                if (expandedTokens + parentTokens > maxContextTokens) {
                  if (pc.joinStrategy === 'truncate-tail') {
                    expansionTruncated = true;
                    break;
                  }
                  throw new ExpansionOverflowError(
                    `Parent-context expansion exceeds maxContextTokens (${maxContextTokens})`,
                    expandedTokens + parentTokens,
                    maxContextTokens,
                  );
                }
                sources.push({
                  chunk: { uid: parentRow.uid, content: parentRow.content, name: parentRow.name },
                  depth,
                });
                expandedTokens += parentTokens;
              }
              currentRowid = parentRow.rowid;
              continue;
            }
          }
          break;
        }

        const parentRowid = parentEdge.dst;

        // Try in-memory cache first, then fall back to DB query for ancestors
        // outside the initial candidate set.
        let parentRow = nodeByRowid.get(parentRowid);
        if (!parentRow) {
          parentRow = stmtNodeByRowid.get(parentRowid) as NodeRow | undefined;
          if (parentRow) nodeByRowid.set(parentRowid, parentRow); // cache for reuse
        }
        if (!parentRow) break;

        const parentText = [parentRow.content, parentRow.name, parentRow.summary]
          .filter(Boolean)
          .join(' ');

        // Parent with no text: still traverse up (it might be a container node).
        if (!parentText) {
          currentRowid = parentRow.rowid;
          continue;
        }

        const parentTokens = estimateTokens(parentText);
        if (expandedTokens + parentTokens > maxContextTokens) {
          if (pc.joinStrategy === 'truncate-tail') {
            expansionTruncated = true;
            break;
          }
          throw new ExpansionOverflowError(
            `Parent-context expansion exceeds maxContextTokens (${maxContextTokens})`,
            expandedTokens + parentTokens,
            maxContextTokens,
          );
        }

        sources.push({
          chunk: { uid: parentRow.uid, content: parentRow.content, name: parentRow.name },
          depth,
        });
        expandedTokens += parentTokens;
        currentRowid = parentRow.rowid;
      }

      // Build expanded text based on join strategy.
      let expandedText: string;
      const includeOrig = pc.includeOriginal ?? true;
      const orderedSources = includeOrig ? sources : sources.filter((s) => s.depth > 0);

      switch (pc.joinStrategy) {
        case 'contiguous':
          expandedText = orderedSources.map((s) => s.chunk.content ?? '').join(' ');
          break;
        case 'separator':
          expandedText = orderedSources
            .map((s) => s.chunk.content ?? '')
            .filter(Boolean)
            .join(pc.separator ?? '\n\n---\n\n');
          break;
        case 'structured':
          expandedText = orderedSources
            .map((s) => {
              const prefix = s.depth === 0 ? '[CHUNK]' : `[PARENT depth=${s.depth}]`;
              return `${prefix}: ${s.chunk.content ?? ''}`;
            })
            .join('\n\n');
          break;
        case 'truncate-tail':
          expandedText = orderedSources.map((s) => s.chunk.content ?? '').join(' ');
          break;
        default:
          expandedText = orderedSources.map((s) => s.chunk.content ?? '').join(' ');
      }

      result.expandedText = expandedText;
      result.expansionSources = sources;
      totalTokensAfterExpansion += expandedTokens;
    }

    // Re-sort by score after expansion (score unchanged, just metadata).
    results.sort((a, b) => b.score - a.score);
  }

  // ── Late chunking ───────────────────────────────────────────────────────────
  // Opt-in: when enabled, mean-pools per-chunk boundaries at retrieval time.
  // Currently a no-op that records the flag for downstream processing.
  // Real implementation would re-embed result chunks at retrieval time using
  // the stored full-document embedding and per-chunk boundaries.
  let lateChunkingApplied = false;
  if (params.lateChunking?.enabled) {
    lateChunkingApplied = true;
    // Placeholder: late chunking aggregation would transform the recalled chunks
    // by mean-pooling embedding boundaries at retrieval time. The boundaries
    // are pre-computed at ingest time and stored alongside the full-document
    // embedding in the vec_node table.
  }

  const afterCount = getProviderCallCount();
  const providerCallCount = afterCount - beforeCount; // must be 0

  // BL-100: compute filter stats so callers can distinguish filtered-empty from
  // empty-corpus. This is an additive output field — does not change the tool contract.
  let filterStats: RecallResponse['filterStats'] | undefined;
    if (filterSql) {
      const beforeCount = (
        db.prepare<[], { cnt: number }>(
          `SELECT COUNT(*) as cnt FROM node n WHERE n.kind = 'episode' AND ${validityPred}`,
        ).get()
      )?.cnt ?? 0;
      const afterCount = (
        db.prepare(
          `SELECT COUNT(*) as cnt FROM node n WHERE n.kind = 'episode' AND ${validityPred} ${filterSql}`,
        ).get(...filterParams) as { cnt: number } | undefined
      )?.cnt ?? 0;
      filterStats = {
        candidates_before_filter: beforeCount,
        candidates_after_filter: afterCount,
      };
    }

  // Compute expansion-aware metadata.
  // When parent-context expansion is enabled, expansionSources includes the original
  // chunk (depth=0) plus all parents, and totalTokensAfterExpansion tracks the
  // cumulative token count from expansion. When expansion is disabled, use the raw
  // result counts for accurate metadata.
  const expansionEnabled = params.parentContext && results.length > 0;
  const totalChunksAfterExpansion = expansionEnabled
    ? results.reduce((sum, r) => sum + r.expansionSources.length, 0)
    : results.length;
  const finalTokensAfterExpansion = expansionEnabled
    ? totalTokensAfterExpansion
    : tokenCount;

  const response: RecallResponse = {
    results,
    provider_call_count: providerCallCount,
    metadata: {
      totalChunksRetrieved: results.length,
      totalChunksAfterExpansion,
      lateChunkingApplied,
      totalTokensAfterExpansion: finalTokensAfterExpansion,
      expansionTruncated,
    },
  };
  if (filterStats) response.filterStats = filterStats;
  return response;
}

// ── Federation (design.md §2.7) ───────────────────────────────────────────────

/**
 * Scope RRF weights (design.md §2.1).
 * project=1.0, user=0.6, org=0.4, local=1.0
 */
export const SCOPE_WEIGHTS: Record<string, number> = {
  project: 1.0,
  user: 0.6,
  org: 0.4,
  local: 1.0,
};

export interface StoreDescriptor {
  scope: string;
  dbPath: string;
}

export interface FederatedRecallResponse {
  results: RecallResult[];
  provider_call_count: number;
}

/**
 * Registry path and helpers.
 */
const REGISTRY_PATH = path.join(process.env['HOME'] ?? '/tmp', '.memory', 'registry.json');

export function readRegistry(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeRegistry(scope: string, dbPath: string): void {
  let registry: Record<string, string> = {};
  try { registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as Record<string, string>; } catch { /* ok */ }
  registry[scope] = dbPath;
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Discover all installed memory stores (design.md §2.1).
 * Walk cwd → home collecting .memory/*.db + registry.json entries.
 */
export function discoverStores(requestedScopes?: string[]): StoreDescriptor[] {
  const scopes = requestedScopes ?? ['project', 'user', 'org'];
  const found = new Map<string, StoreDescriptor>(); // dbPath → descriptor

  const cwd = process.cwd();
  const home = process.env['HOME'] ?? '/';
  const dirs: string[] = [];

  let cur = cwd;
  while (true) {
    dirs.push(cur);
    if (cur === home) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (!dirs.includes(home)) dirs.push(home);

  for (const dir of dirs) {
    const memDir = path.join(dir, '.memory');
    if (!fs.existsSync(memDir)) continue;
    try {
      const files = fs.readdirSync(memDir).filter((f) => f.endsWith('.db'));
      for (const f of files) {
        const scopeName = f.replace('.db', '');
        if (!scopes.includes(scopeName)) continue;
        const dbPath = path.join(memDir, f);
        if (!found.has(dbPath) && fs.existsSync(dbPath)) {
          found.set(dbPath, { scope: scopeName, dbPath });
        }
      }
    } catch { /* permission error */ }
  }

  const registry = readRegistry();
  for (const [scope, dbPath] of Object.entries(registry)) {
    if (!scopes.includes(scope)) continue;
    if (!dbPath || !fs.existsSync(dbPath)) continue;
    const resolved = path.resolve(dbPath);
    if (!found.has(resolved)) {
      found.set(resolved, { scope, dbPath: resolved });
    }
  }

  return [...found.values()];
}

// Connection cache: dbPath → read-only Database connection.
// Keeps connections alive across multiple federatedRecall calls (warm page cache).
const _connCache = new Map<string, Database.Database>();

export function getFederationConnection(dbPath: string): Database.Database | null {
  if (!_connCache.has(dbPath)) {
    try {
      const db = openDbReadOnly(dbPath);
      _connCache.set(dbPath, db);
    } catch { return null; }
  }
  return _connCache.get(dbPath) ?? null;
}

export function closeFederationConnections(): void {
  for (const [, db] of _connCache) {
    try { db.close(); } catch { /* ignore */ }
  }
  _connCache.clear();
}

/**
 * Run per-store hybrid pipeline using a pre-opened connection.
 * Zero LLM calls.
 */
async function recallFromOpenDb(
  db: Database.Database,
  scope: string,
  params: RecallParams,
): Promise<RecallResult[]> {
  try {
    const res = await memoryRecall(db, scope, params);
    return res.results;
  } catch {
    return [];
  }
}

/**
 * Collect SUPERSEDES targets from a pre-opened DB.
 */
function collectSupersededFromDb(db: Database.Database, suppressed: Set<string>): void {
  try {
    const rows = db.prepare(
      `SELECT n_dst.uid AS superseded_uid
       FROM edge e
       JOIN node n_dst ON n_dst.rowid = e.dst
       WHERE e.rel = 'SUPERSEDES' AND e.t_expired IS NULL`,
    ).all() as Array<{ superseded_uid: string }>;
    for (const r of rows) {
      if (r.superseded_uid) suppressed.add(r.superseded_uid);
    }
  } catch { /* ignore */ }
}

/**
 * Federated recall across multiple scopes (design.md §2.7).
 *
 * Algorithm:
 *   1. WAL fan-out per-store hybrid pipeline (cached connections).
 *   2. scope-weight: score = SCOPE_WEIGHTS[scope] × raw_score
 *   3. agent_id match ×1.25 boost (applied post-recall, not as SQL filter)
 *   4. content-hash dedup: highest scope-weight wins
 *   5. SUPERSEDES suppression (cross-store)
 *   6. Sort by weighted score, assemble within token_budget
 *
 * Invariant R1: zero LLM/provider calls.
 */
export async function federatedRecall(
  stores: StoreDescriptor[],
  params: RecallParams,
): Promise<FederatedRecallResponse> {
  if (!stores || stores.length === 0) {
    return { results: [], provider_call_count: 0 };
  }

  const beforeCount = getProviderCallCount();

  const { agent_id, token_budget = DEFAULT_TOKEN_BUDGET, limit = 10 } = params;

  // Use cached connections (warm page cache, amortize open cost).
  interface OpenConn { scope: string; db: Database.Database | null }
  const openConns: OpenConn[] = stores.map(({ scope, dbPath }) => ({
    scope,
    db: getFederationConnection(dbPath),
  }));

  // 1. Collect SUPERSEDES targets.
  const suppressedUids = new Set<string>();
  for (const { db } of openConns) {
    if (db) collectSupersededFromDb(db, suppressedUids);
  }

  // 2. Per-store recall.
  //    agent_id is NOT forwarded as SQL filter — boost applied post-recall.
  const storeParams: RecallParams = { ...params, agent_id: undefined };
  const allStoreResults: Array<{ scope: string; results: RecallResult[] }> = [];
  for (const { scope, db } of openConns) {
    if (!db) continue;
    const results = await recallFromOpenDb(db, scope, storeParams);
    allStoreResults.push({ scope, results });
  }

  // 3. Merge with scope weighting + agent_id boost
  interface Candidate {
    result: RecallResult;
    weightedScore: number;
    contentHash: string | null;
    scope: string;
  }
  const candidateMap = new Map<string, Candidate>();

  for (const { scope, results } of allStoreResults) {
    const weight = SCOPE_WEIGHTS[scope] ?? 1.0;

    for (const r of results) {
      let weighted = weight * (r.score ?? 0);
      if (agent_id && r.agent_id === agent_id) {
        weighted *= 1.25;
      }

      const existing = candidateMap.get(r.uid);
      if (!existing || weighted > existing.weightedScore) {
        candidateMap.set(r.uid, {
          result: { ...r, scope },
          weightedScore: weighted,
          contentHash: r.content_hash ?? null,
          scope,
        });
      }
    }
  }

  // 4. Content-hash dedup: keep the highest scope-weight entry per hash
  const hashMap = new Map<string, string>(); // hash → winning uid
  for (const [uid, cand] of candidateMap) {
    const h = cand.contentHash;
    if (!h) continue;
    const winnerUid = hashMap.get(h);
    if (!winnerUid) {
      hashMap.set(h, uid);
    } else {
      const winnerWeight = SCOPE_WEIGHTS[candidateMap.get(winnerUid)?.scope ?? ''] ?? 0;
      const candWeight = SCOPE_WEIGHTS[cand.scope] ?? 0;
      if (candWeight > winnerWeight) {
        hashMap.set(h, uid);
      }
    }
  }
  const dupLosers = new Set<string>();
  for (const [h, winnerUid] of hashMap) {
    for (const [uid, cand] of candidateMap) {
      if (cand.contentHash === h && uid !== winnerUid) {
        dupLosers.add(uid);
      }
    }
  }
  for (const uid of dupLosers) candidateMap.delete(uid);

  // 5. SUPERSEDES suppression
  for (const uid of suppressedUids) candidateMap.delete(uid);

  // 6. Sort + assemble within token_budget
  const sorted = [...candidateMap.values()].sort((a, b) => b.weightedScore - a.weightedScore);

  const results: RecallResult[] = [];
  let tokenCount = 0;
  for (const cand of sorted) {
    if (results.length >= limit) break;
    const r = cand.result;
    const text = [r.content, r.uid].filter(Boolean).join(' ');
    const tokens = Math.ceil((text || '').length / 4);
    if (tokenCount + tokens > token_budget && results.length > 0) break;
    tokenCount += tokens;
    results.push({ ...r, score: cand.weightedScore });
  }

  const afterCount = getProviderCallCount();
  return { results, provider_call_count: afterCount - beforeCount };
}

// ── Helper functions (centralized from client/db.ts) ─────────────────────

/**
 * Check whether an episode is superseded (i.e. some other episode's SUPERSEDES
 * edge points to it via rowid).
 */
export function isSuperseded(db: Database.Database, rowid: number): boolean {
  const row = db
    .prepare<[number], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM edge WHERE dst = ? AND rel = 'SUPERSEDES' AND t_expired IS NULL`,
    )
    .get(rowid);
  return (row?.cnt ?? 0) > 0;
}

/**
 * Return the UID of the episode that `rowid` supersedes (outbound SUPERSEDES
 * edge from src=rowid to dst). Returns null if no such edge exists.
 */
export function supersedesUidForRowid(
  db: Database.Database,
  rowid: number,
): string | null {
  const row = db
    .prepare<[number], { uid: string }>(
      `SELECT n.uid FROM edge e
       JOIN node n ON n.rowid = e.dst AND n.t_invalid IS NULL
       WHERE e.src = ? AND e.rel = 'SUPERSEDES' AND e.t_expired IS NULL
       LIMIT 1`,
    )
    .get(rowid);
  return row?.uid ?? null;
}

/**
 * Resolve the GLOBAL MEMBER_OF community uid for an episode rowid.
 *
 * Defaults to `cluster_scope.kind='global'` (treating legacy NULL scope as
 * global) so that persisted subset lenses never leak into recall's
 * `community_uid` field.
 */
export function communityUidForRowid(
  db: Database.Database,
  rowid: number,
): string | null {
  const row = db
    .prepare<[number], { uid: string }>(
      `SELECT n2.uid FROM edge e
       JOIN node n2 ON n2.rowid = e.dst AND n2.kind = 'community' AND n2.t_invalid IS NULL
         AND (json_extract(n2.meta, '$.cluster_scope.kind') IS NULL
              OR json_extract(n2.meta, '$.cluster_scope.kind') = 'global')
       WHERE e.src = ? AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
       ORDER BY e.rowid ASC
       LIMIT 1`,
    )
    .get(rowid);
  return row?.uid ?? null;
}

/**
 * Resolve episode rowids → uids, preserving the input order.
 */
export function rowidsToUids(
  db: Database.Database,
  rowids: number[],
): string[] {
  if (rowids.length === 0) return [];
  const ph = rowids.map(() => '?').join(',');
  const rows = db
    .prepare<unknown[], { rowid: number; uid: string }>(
      `SELECT rowid, uid FROM node WHERE rowid IN (${ph})`,
    )
    .all(...rowids);
  const byRowid = new Map(rows.map((r) => [r.rowid, r.uid]));
  return rowids
    .map((r) => byRowid.get(r))
    .filter((u): u is string => typeof u === 'string');
}

/**
 * Parse a JSON tags column value. Returns [] if null, undefined, or malformed.
 */
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    /* malformed */
  }
  return [];
}

/**
 * Expand a leading ~/ to the user's home directory.
 * If `p` is exactly `~`, returns the home directory.
 * Otherwise returns `p` unchanged.
 */
export function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return os.homedir() + p.slice(1);
  }
  return p;
}
