/**
 * memory_recall — deterministic hot path, <50ms.
 * federatedRecall — cross-scope RRF union (design.md §2.7).
 *
 * Algorithm per-store (design.md §2.3):
 *   1. query-embed — ONE real local ONNX/fastembed inference call via `embed()`
 *      (embed.ts:203/:206 → provider.embedSingle(); called at :401 below). This
 *      is NOT a hash projection: the hash backend was removed entirely —
 *      `EmbedBackend = 'auto' | 'real'` (embed.ts:43) and
 *      `createEmbeddingProvider()` throws rather than silently downgrading
 *      (libs/data/CLAUDE.md §2). "Zero LLM/provider calls" below means zero
 *      REMOTE/network LLM calls (no external API dependency) — the local
 *      embedding provider IS invoked once per recall, unavoidably, to embed
 *      the query text.
 *      CAVEAT (historical): BL-254 fixed the dead instrumentation gap on
 *      2026-07-23 — `providerCallCount` is now incremented inside embed(),
 *      so the delta at :930 reflects actual local embed calls. The count
 *      is >0 on every query-path recall (one local ONNX inference per query).
 *      The "zero NETWORK calls" invariant (R1) is guaranteed by the provider
 *      architecture — no remote API is called — not by the counter.
 *   2. parallel: vec0 KNN + FTS5 BM25 + temporal filter
 *   3. graph expand depth-1 over live edges (project store only in federation)
 *   4. RRF (k=60) fusion
 *   5. recency × importance rerank (decay 0.995/h)
 *   6. assemble within token_budget
 *
 * Federation (design.md §2.7) — `federatedRecall` ONLY:
 *   score = scope_weight(scope) · Σ 1/(k+rank), k=60
 *   weights: project=1.0, user=0.6, org=0.4, local=1.0
 *   agent_id match ×1.25 boost; cross-store content-hash dedup; SUPERSEDES suppression.
 *
 * [BL-230] `agent_id` means two DIFFERENT things depending on the entry point — do not
 * carry the federation semantics above into the single-store path:
 *   - `federatedRecall` (below): agent_id match is a ×1.25 scoring BOOST.
 *     A non-matching node still ranks, just lower.
 *   - `memoryRecall` (this function, single-store): agent_id is a HARD FILTER —
 *     `agentFilter` is built at :410 and applied to all three candidate
 *     channels: the vec0 KNN query (:419), the FTS5 BM25 query (:450), and the
 *     temporal-recency query (:465). A non-matching node cannot appear at all.
 *     An empty/absent agent_id disables the filter entirely (it does NOT
 *     filter to the empty string).
 * Tuning ranking off the federation comment alone will mislead you about which rows are even
 * eligible in the single-store case.
 *
 * NOTE: the `:line` citations above are point-in-time (verified against this
 * file as of this edit) — they will drift as the file grows. If a citation
 * looks off by more than a few lines, trust the described behavior/symbol
 * name over the number and re-grep.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { embed, vecToJson, getProviderCallCount } from './embed.js';
import { openDbReadOnly } from './db.js';
import { buildFilterClause } from '@adhd/sox-hybrid-search';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

// ── Query-embed timeout (read-path guard) ─────────────────────────────────────
//
// `memory_recall` advertises "<50ms, zero LLM" — it is a READ path and must
// never hang, even when the shared embed provider is backed up (e.g. an
// enrich-tick storm saturating the single fastembed child-process IPC queue;
// live-observed embed_duration_ms p50 ≈ 25 minutes during such an incident).
//
// `embed()` (embed.ts) has NO cancellation hook — the underlying worker-thread
// provider cannot be aborted, so a call that never settles will hang the
// `await embed(query)` below FOREVER. The pre-existing try/catch at the call
// site only handles a REJECTED promise; a promise that never settles never
// reaches either branch. embed-pipeline.ts's `embedWithTimeout()` races
// exactly this scenario for the heal path (SOX_EMBED_HEAL_TIMEOUT_MS,
// default 120s) but that file is owned by another agent during this
// incident and its 120s budget is far too generous for an interactive read
// — a caller of memory_recall should never wait minutes for a query embed.
// This is a minimal, recall-local duplicate of that same race pattern with a
// read-appropriate default, so a stalled provider degrades the vec channel
// gracefully to BM25/temporal-only (the exact fallback BL-273 already wired
// via `embedVecFailed` below) instead of hanging the whole recall forever.
const DEFAULT_RECALL_EMBED_TIMEOUT_MS = 3000;

function resolveRecallEmbedTimeoutMs(): number {
  const raw = process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RECALL_EMBED_TIMEOUT_MS;
}

/**
 * Race `embed(query)` against a wall-clock timeout. Rejects with a
 * TimeoutError-shaped Error if the embed call has not settled within
 * `timeoutMs` — WITHOUT aborting the underlying call (there is no
 * cancellation hook), so a slow embed may still complete after this promise
 * has already rejected; that stray result is simply discarded by the caller
 * here. The timer is `unref()`d so it can never keep the process alive.
 */
async function embedWithRecallTimeout(query: string, timeoutMs: number): Promise<Float32Array> {
  return new Promise<Float32Array>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`embed() timed out after ${timeoutMs}ms (recall read-path guard)`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    embed(query).then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface RecallParams {
  query: string;
  scopes?: string[] | undefined;
  agent_id?: string | undefined;
  // BUG-MEMORY-003: `filters.kinds` (string[]) restricts which node.kind values
  // are admitted as recall candidates. Defaults to ['episode'] when omitted —
  // entity/community/session/generic nodes carry no readable content (they are
  // never populated in vec_node or the FTS index; see write.ts's entity-creation
  // path) and are excluded from results unless a caller explicitly opts in via
  // e.g. `filters: { kinds: ['episode', 'entity'] }`.
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
    /**
     * BL-117: present ONLY when `params.lateChunking?.enabled` was requested
     * but `lateChunkingApplied` is false — a machine-readable reason a caller
     * can branch on to distinguish "ran" from "silently ignored". Absent
     * entirely when late chunking was not requested, or when (hypothetically)
     * it was genuinely applied.
     */
    lateChunkingSkipReason?: string;
    totalTokensAfterExpansion: number;
    expansionTruncated: boolean;
  };
  /**
   * (BL-391) Non-fatal per-channel failures observed while assembling this
   * response — e.g. the FTS/BM25 arm failing (was previously swallowed
   * silently at `catch { /* FTS query may fail on special chars *\/ }`,
   * which made a federated store's BM25 arm dying on Turso's read-only
   * `fts_match` limitation indistinguishable from "no FTS matches found").
   * Absent (or empty) when nothing degraded — never omitted to hide a real
   * failure.
   */
  degradations?: string[];
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

/**
 * BL-117: genuine late chunking (Günther et al.) mean-pools PER-TOKEN
 * (pre-pool) embeddings over caller-supplied boundary token ranges, so each
 * chunk's vector is contextualised by the surrounding document instead of
 * being embedded in isolation. That requires a token-level embedding matrix
 * (or per-boundary embeddings) to pool from at recall time.
 *
 * Today `vec_node` (schema.ts) stores exactly ONE mean-pooled FLOAT[768]
 * vector per node — the final, already-pooled document embedding. There is
 * no token-level embedding matrix and no persisted chunk-boundary metadata
 * anywhere in the schema to pool from. Recall is also a zero-provider-call
 * hot path (R1) — it cannot legitimately call the embedding provider again
 * per candidate to manufacture the missing data on the fly.
 *
 * Conclusion: late chunking is NOT implementable from data already persisted
 * ingest-side. Previously this flag was accepted and silently reported as
 * `applied: true` while doing nothing (the defect). This helper is the single
 * source of truth for the honest, non-lying answer: never "applied", always a
 * machine-readable reason describing exactly what ingest-side storage would
 * be required to make it real (see BL-117 report for the full remediation
 * plan — out of scope for memory-core, requires libs/data/ingest/** changes).
 */
function evaluateLateChunking(config: LateChunkingConfig | undefined): {
  applied: boolean;
  skipReason?: string;
} {
  if (!config?.enabled) return { applied: false };
  return {
    applied: false,
    skipReason:
      'late_chunking_unsupported: no per-token/pre-pool embedding matrix or persisted ' +
      'chunk-boundary metadata exists ingest-side — vec_node stores exactly one mean-pooled ' +
      'FLOAT[768] vector per node (schema.ts), and memory_recall is a zero-provider-call hot ' +
      'path (R1) so it cannot compute one on the fly. Required ingest-side work: persist ' +
      'per-chunk (or per-token) embeddings plus boundary token offsets at write time.',
  };
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
const DEFAULT_KNN_LIMIT = 20;
const DEFAULT_FTS_LIMIT = 20;

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
  adapter: StoreAdapter,
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

  // DEBT-SOXGRAPH-001: only the vec channel needs a dialect object anymore —
  // the FTS channel is fully delegated to `adapter.ftsSearch` (store-adapter's
  // A2 API), which owns all per-backend FTS SQL itself.
  const { createVectorDialect } = await import('@adhd/sox-store-adapter');
  const vectorDialect = createVectorDialect(adapter.config.type);

  // BL-316: scale candidate limits with caller's limit when filters are active
  const knnLimit = filters ? Math.max(DEFAULT_KNN_LIMIT, (limit || 20) * 2) : DEFAULT_KNN_LIMIT;
  const ftsLimit = filters ? Math.max(DEFAULT_FTS_LIMIT, (limit || 20) * 2) : DEFAULT_FTS_LIMIT;

  const beforeCount = getProviderCallCount();

  // BUG-MEMORY-003: computed unconditionally (not gated behind `if (filters)`
  // below) — the null-content-padding bug reproduces with zero filters
  // supplied, so kind-exclusion must be the default, always-on behavior.
  // Defaults to episode-only; entity/community/session/generic nodes are
  // structurally reachable via the temporal channel (recall.ts:623) and the
  // depth-1 graph-expansion neighbor fetch (recall.ts:834) but carry no
  // readable content — see the `filters` doc comment on RecallParams.
  const kinds = (filters && Array.isArray((filters as Record<string, unknown>)['kinds'])
    ? (filters as Record<string, unknown>)['kinds'] as string[]
    : ['episode']);
  const kindClause = kinds.length > 0 ? ` AND n.kind IN (${kinds.map(() => '?').join(',')})` : '';
  const kindParams: unknown[] = kinds;

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
        case 'kinds':
          // BUG-MEMORY-003: handled unconditionally outside this block (kindClause/
          // kindParams below) — deliberately NOT routed through buildFilterClause's
          // NodeFilter (see recall.ts's `kinds` doc comment on RecallParams and
          // SPEC-BUG-MEMORY-003.md §2/§3 D3). Falling through to `default` here would
          // hand an unrecognized 'kinds' key to buildFilterClause, which stringifies
          // unknown keys into `${key} = ?` extraClauses SQL — a broken `kinds = ?`
          // predicate against a table with no such column.
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

  // 1. Query embedding — zero per-query NETWORK calls (R1): embed() always
  //    resolves the real local ONNX/fastembed provider (bge-base-en-v1.5).
  //    There is no hash backend to fall back to — it was removed; see the
  //    file-top docblock for the full trace + the dead-instrumentation caveat
  //    on getProviderCallCount().
  //
  //    BL-273: if embedding is dead (worker process gone), skip vec channel.
  //
  // BL-391: collects non-fatal per-channel failures so a caller can tell
  // "channel found nothing" apart from "channel died silently" — surfaced on
  // RecallResponse.degradations instead of being swallowed by a bare catch.
  const degradations: string[] = [];
  let embedVecFailed = false;
  let queryVecJson: string | undefined;
  try {
    const queryVec = await embedWithRecallTimeout(query, resolveRecallEmbedTimeoutMs());
    queryVecJson = vecToJson(queryVec);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sox-memory] WARNING: embed() failed or timed out in recall, skipping vec channel: ${msg}`);
    embedVecFailed = true;
    degradations.push(`vec: ${msg}`);
  }

  // Validity predicate
  const validityPred = as_of
    ? `(n.t_valid IS NULL OR n.t_valid <= '${as_of}') AND (n.t_invalid IS NULL OR n.t_invalid > '${as_of}')`
    : 'n.t_invalid IS NULL';


  const agentFilter =
    agent_id ? `AND n.agent_id = '${agent_id.replace(/'/g, "''")}'` : '';

  // 2a. Vec0 KNN search
  let vecRows: { node_id: number; distance: number }[] = [];
  if (queryVecJson && !embedVecFailed) {
    const queryVec = JSON.parse(queryVecJson) as number[];
    const { sql: dialectSql, args: dialectArgs } = vectorDialect.topKQuery(
      'vec_node', 'embedding', queryVec, knnLimit, 'cosine',
    );
    // Interpolate __PLACEHOLDER__ with validity + agent + custom filter + kind clauses
    const filterClauses = [validityPred, agentFilter, filterSql, kindClause].filter(Boolean).join(' ');
    const vecSql = dialectSql.replace('__PLACEHOLDER__', filterClauses) + ' LIMIT ?';
    const vecParams: unknown[] = [...dialectArgs, ...filterParams, ...kindParams, knnLimit];
    const vecResult = await adapter.executeAll<{ node_id: number; distance: number }>(vecSql, vecParams);
    vecRows = vecResult.rows;
    // BL-367: stable secondary sort on node_id to break EXACT distance ties
    // deterministically. Exactly-tied distances are common, not an edge
    // case — orthogonal candidates against a query vector routinely tie at
    // the same value — and neither backend's own KNN ordering documents (or
    // guarantees) what breaks a tie: vec0's internal search order and
    // Turso's vector-index iteration order were measured to disagree on an
    // identical corpus, which corrupted cross-backend rank parity (BL-367).
    // vec0 KNN queries reject a compound `ORDER BY distance, <col>` clause
    // (empirically: "Only a single 'ORDER BY distance' clause is allowed on
    // vec0 KNN queries"), so this can't be pushed into SQL for that side —
    // applying it here in JS, uniformly for both dialects, keeps the
    // tiebreak identical everywhere instead of two mechanisms that could
    // drift apart.
    vecRows = [...vecRows].sort((a, b) => a.distance - b.distance || a.node_id - b.node_id);
  }

  // Build rowid → vec rank map
  const vecRanks = new Map<number, number>();
  vecRows.forEach((r, i) => vecRanks.set(r.node_id, i + 1));

  // 2b. FTS BM25 search (text search) — DEBT-SOXGRAPH-001: fully delegated to
  // store-adapter's A2 API. `adapter.ftsSearch` owns ALL per-backend FTS SQL
  // (the SQLite FTS5 fts_node shadow-table match/rank join vs the Turso
  // Tantivy fts_match/fts_score functions on node), token normalization
  // (trim → lowercase → split → drop-empties), the BL-367 multi-term
  // `"t1" OR "t2"` match-query form, the `n` base-table alias on BOTH
  // backends (so the n.-prefixed predicates below need no stripping), and the
  // capability gate (`capabilities.fts === false` → `[]`). memory-core no
  // longer assembles any FTS SQL above store-adapter — the old
  // matchClause/scoreClause branch and the `n.`-alias-stripping hacks are
  // deleted. Rows come back already ordered best-first (score normalized to
  // higher = better on both engines), which is exactly the order the
  // hand-assembled arm produced (SQLite: ascending rank ≡ descending score;
  // Turso: engine ties fall through to the same scan order — verified
  // empirically for the DEBT-SOXGRAPH-001 parity corpus on both backends).
  const ftsRowids = new Map<number, number>();
  try {
    const ftsRows = await adapter.ftsSearch<{ rowid: number }>(
      'node',
      ['content', 'name', 'summary'],
      query,
      {
        limit: ftsLimit,
        // F1 (fix/debt-soxgraph-001): join the predicate fragments with
        // spaces, exactly like the vec channel does above (recall.ts:546).
        // The previous tight concatenation produced `n.t_invalid IS NULLAND
        // n.agent_id = ...` whenever agent_id was set — a syntax error on
        // BOTH backends, swallowed by the BL-391 catch into degradations,
        // which silently zeroed the whole FTS/BM25 channel for every
        // agent-scoped recall. A space-joined array makes it impossible for
        // any future fragment to reintroduce the bug by omitting its leading
        // or trailing space. (The as_of form `)AND` was lexically valid; the
        // bug was specific to the default `IS NULL` predicate + a non-empty
        // agentFilter.)
        where: [validityPred, agentFilter, filterSql, kindClause].filter(Boolean).join(' '),
        params: [...filterParams, ...kindParams],
      },
    );
    ftsRows.forEach((r, i) => ftsRowids.set(r.rowid, i + 1));
  } catch (err) {
    // BL-391: the FTS/BM25 arm can fail for a benign reason (special-char
    // query syntax) OR because the underlying connection cannot run
    // fts_match at all (Turso read-only federation connections, before the
    // allowFtsInReadonly fix — "Resource is read-only"). Either way this
    // degrades results (BM25 signal silently missing) rather than failing
    // the whole recall, but the degradation itself must be observable —
    // record it instead of swallowing it outright.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sox-memory] WARNING: FTS/BM25 channel failed in recall, continuing without it: ${msg}`);
    degradations.push(`fts: ${msg}`);
  }

  // 2c. Temporal filter: recently created nodes (recency signal)
  // NOTE: validityPred and agentFilter use the alias "n", so the table must be aliased as n here.
  const temporalSql = `SELECT n.rowid, n.t_created FROM node n
       WHERE ${validityPred} ${agentFilter} ${filterSql} ${kindClause}
       ORDER BY n.t_created DESC LIMIT ?`;
  const temporalParams: unknown[] = [...filterParams, ...kindParams, knnLimit];
  const temporalResult = await adapter.executeAll<{ rowid: number; t_created: string }>(temporalSql, temporalParams);
  const temporalRows = temporalResult.rows;

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
      const beforeCount = (await adapter.executeGet<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM node n WHERE n.kind = 'episode' AND ${validityPred}`,
      ))?.cnt ?? 0;
      const afterCount = (await adapter.executeGet<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM node n WHERE n.kind = 'episode' AND ${validityPred} ${filterSql}`,
        filterParams,
      ))?.cnt ?? 0;
      filterStats = {
        candidates_before_filter: beforeCount,
        candidates_after_filter: afterCount,
      };
    }
    // BL-117: honestly report late chunking even on the empty-corpus path —
    // a caller who asked for it and got zero results should still learn it
    // was never applied, and why, rather than an empty response masking it.
    const { applied: lcApplied0, skipReason: lcSkip0 } = evaluateLateChunking(params.lateChunking);
    const response: RecallResponse = {
      results: [],
      provider_call_count: 0,
      metadata: {
        totalChunksRetrieved: 0,
        totalChunksAfterExpansion: 0,
        lateChunkingApplied: lcApplied0,
        ...(lcSkip0 ? { lateChunkingSkipReason: lcSkip0 } : {}),
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
  const nodeResult = await adapter.executeAll<NodeRow>(
    `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id, content_hash, session_id
     FROM node WHERE rowid IN (${rowidList})`,
  );
  const nodes = nodeResult.rows;

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
  //     vec_contrib      = vecNorm  × rerank × (1/normTotal)  [proportional share]
  //     bm25_contrib     = ftsNorm  × rerank × (1/normTotal)
  //     temporal_contrib = tempNorm × rerank × (1/normTotal)
  //   where normTotal = vecNorm + ftsNorm + tempNorm (sum of normalised values).
  //   The normalised channel values are per-query min-max scaled so scores from
  //   different queries are comparable.
  //
  //   Degenerate case (BL-167): min-max normalisation can legitimately collapse
  //   every channel to 0 for a node whose raw per-channel value equals that
  //   channel's minimum across the whole candidate set on ALL THREE channels
  //   simultaneously (e.g. a node whose only contributing channel is also that
  //   channel's minimum). When that happens normTotal === 0 even though
  //   finalScore > 0 (baseRrf, and therefore finalScore, are driven by raw —
  //   not normalised — magnitudes). In that case we fall back to splitting the
  //   score proportionally by *raw* RRF channel contribution instead
  //   (rc.vecRaw/rc.ftsRaw/rc.tempRaw, whose sum rc.total is exactly baseRrf by
  //   construction — see step 3 above), so the identity below always holds
  //   rather than only holding "usually":
  //
  //   This guarantees: vec_contrib + bm25_contrib + temporal_contrib === score
  //   for every node, and each channel value is in [0, score].
  const ranked = validNodes.map((n) => {
    const baseRrf = rrfScores.get(n.rowid) ?? 0;
    const recency = recencyMultiplier(n.t_created);
    const imp = (n.importance ?? 1.0) / 10.0; // normalize 1..10 → 0.1..1.0
    const rerank = recency * (0.5 + 0.5 * imp);
    const finalScore = baseRrf * rerank;

    const nc = normChannels.get(n.rowid) ?? { vecNorm: 0, ftsNorm: 0, tempNorm: 0 };
    const normTotal = nc.vecNorm + nc.ftsNorm + nc.tempNorm;
    const rc = rrfChannels.get(n.rowid);
    let vecContrib = 0, bm25Contrib = 0, tempContrib = 0;
    if (normTotal > 0) {
      vecContrib  = finalScore * (nc.vecNorm  / normTotal);
      bm25Contrib = finalScore * (nc.ftsNorm  / normTotal);
      tempContrib = finalScore * (nc.tempNorm / normTotal);
    } else if (rc && rc.total > 0) {
      // BL-167 fallback: normalisation collapsed to 0 but the raw RRF total
      // (and therefore finalScore) is positive. Split by raw contribution so
      // vec + bm25 + temporal === total still holds exactly.
      vecContrib  = finalScore * (rc.vecRaw  / rc.total);
      bm25Contrib = finalScore * (rc.ftsRaw  / rc.total);
      tempContrib = finalScore * (rc.tempRaw / rc.total);
    }
    // else: rc.total === baseRrf === 0 here too, so finalScore is also 0 and
    // leaving all three channels at 0 still satisfies the invariant (0 === 0).

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
    const neighborResult = await adapter.executeAll<{ neighbor_id: number }>(
      `SELECT DISTINCT CASE WHEN src IN (${topRowids.join(',')}) THEN dst ELSE src END AS neighbor_id
       FROM edge
       WHERE (src IN (${topRowids.join(',')}) OR dst IN (${topRowids.join(',')}))
         AND t_expired IS NULL AND ${validPred}`,
    );
    const neighborRows = neighborResult.rows;
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
    // BUG-MEMORY-003 §1b: no `n` alias on this query (unlike the temporal/vec/FTS
    // channels above), so the un-aliased kind predicate is inlined directly rather
    // than reusing kindClause's ` AND n.kind IN (...)` form.
    const expKindClause = kinds.length > 0 ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';
    const expKindParams: unknown[] = kinds.length > 0 ? kindParams : [];
    const expResult = await adapter.executeAll<NodeRow>(
      `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id, content_hash, session_id
       FROM node WHERE rowid IN (${expandedNew.join(',')}) AND ${nodeValidPred} ${expKindClause}`,
      expKindParams,
    );
    expandedNodes = expResult.rows;
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
        const parentEdge = await adapter.executeGet<{ dst: number }>(
          `SELECT dst FROM edge WHERE src = ? AND rel = 'DERIVED_FROM' AND t_expired IS NULL LIMIT 1`,
          [currentRowid],
        );
        if (!parentEdge) {
          // Fallback: parentDocId lookup — session_id IS the parent's UID
          const currentNode = nodeByRowid.get(currentRowid);
          if (currentNode?.session_id) {
            const parentRow = await adapter.executeGet<NodeRow>(
              `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id, content_hash
               FROM node WHERE uid = ?`,
              [currentNode.session_id],
            );
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
          parentRow = await adapter.executeGet<NodeRow>(
            `SELECT rowid, uid, content, name, summary, importance, t_created, t_valid, t_invalid, agent_id, content_hash, session_id
             FROM node WHERE rowid = ?`,
            [parentRowid],
          ) as NodeRow | undefined;
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

  // ── Late chunking (BL-117) ─────────────────────────────────────────────────
  // See evaluateLateChunking() for the full rationale: genuine late chunking
  // is not implementable from data persisted today, so the flag is honestly
  // reported as NOT applied — never silently flipped to true — with a
  // machine-readable reason a caller can branch on.
  const { applied: lateChunkingApplied, skipReason: lateChunkingSkipReason } =
    evaluateLateChunking(params.lateChunking);

  const afterCount = getProviderCallCount();
  // BL-254: this is the count of LOCAL embed calls, normally 1 on the query path
  // (one uncached ONNX inference to embed the query). It is NOT the zero-network
  // invariant — see the header, §1.
  const providerCallCount = afterCount - beforeCount;

  // BL-100: compute filter stats so callers can distinguish filtered-empty from
  // empty-corpus. This is an additive output field — does not change the tool contract.
  let filterStats: RecallResponse['filterStats'] | undefined;
    if (filterSql) {
      const beforeCount = (await adapter.executeGet<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM node n WHERE n.kind = 'episode' AND ${validityPred}`,
      ))?.cnt ?? 0;
      const afterCount = (await adapter.executeGet<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM node n WHERE n.kind = 'episode' AND ${validityPred} ${filterSql}`,
        filterParams,
      ))?.cnt ?? 0;
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
      ...(lateChunkingSkipReason ? { lateChunkingSkipReason } : {}),
      totalTokensAfterExpansion: finalTokensAfterExpansion,
      expansionTruncated,
    },
  };
  if (filterStats) response.filterStats = filterStats;
  if (degradations.length > 0) response.degradations = degradations;
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
  /**
   * (BL-391) Non-fatal degradations observed across the federated stores —
   * a store's FTS/BM25 arm failing, a store's connection being entirely
   * unreachable, or a per-store recall throwing outright. Each entry is
   * prefixed `scope=<scope>: `. ALWAYS present (empty array when nothing
   * degraded) — federated recall must never look "clean" when an arm
   * quietly died; that silent-degrade-at-whole-store-granularity behavior
   * is exactly what BL-391 exists to close.
   */
  degradations: string[];
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

// Connection cache: dbPath → read-only StoreAdapter connection.
// Keeps connections alive across multiple federatedRecall calls (warm page cache).
const _connCache = new Map<string, StoreAdapter>();

// (BL-391) Last connection-open failure reason per dbPath, so federatedRecall
// can surface WHY a store was excluded instead of it silently vanishing from
// results. Public signature of getFederationConnection() is unchanged
// (StoreAdapter | null) for backward compatibility with existing external
// callers — this is a side-channel federatedRecall reads, not part of the
// return value.
const _connErrors = new Map<string, string>();

export async function getFederationConnection(dbPath: string): Promise<StoreAdapter | null> {
  if (!_connCache.has(dbPath)) {
    try {
      const adapter = await openDbReadOnly(dbPath);
      _connCache.set(dbPath, adapter);
      _connErrors.delete(dbPath);
    } catch (err) {
      _connErrors.set(dbPath, err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  return _connCache.get(dbPath) ?? null;
}

export async function closeFederationConnections(): Promise<void> {
  for (const [, adapter] of _connCache) {
    try { await adapter.close(); } catch { /* ignore */ }
  }
  _connCache.clear();
}

/**
 * Run per-store hybrid pipeline using a pre-opened connection.
 * Zero LLM calls.
 *
 * (BL-391) Previously this swallowed EVERY failure — including a dead
 * FTS/BM25 arm inside memoryRecall AND an outright throw from memoryRecall
 * itself — down to a bare `[]`, indistinguishable from "this store
 * genuinely has no matches". That is the whole-store swallow: a federated
 * query that lost its BM25 arm (or failed entirely) looked exactly like a
 * clean, successful query with zero hits. Now both memoryRecall's own
 * per-channel degradations AND an outright throw from memoryRecall are
 * returned to the caller instead of being discarded.
 */
async function recallFromOpenDb(
  adapter: StoreAdapter,
  scope: string,
  params: RecallParams,
): Promise<{ results: RecallResult[]; degradations: string[] }> {
  try {
    const res = await memoryRecall(adapter, scope, params);
    return { results: res.results, degradations: res.degradations ?? [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { results: [], degradations: [`recall failed entirely — ${msg}`] };
  }
}

/**
 * Collect SUPERSEDES targets from a pre-opened adapter.
 */
async function collectSupersededFromDb(adapter: StoreAdapter, suppressed: Set<string>): Promise<void> {
  try {
    const result = await adapter.executeAll<{ superseded_uid: string }>(
      `SELECT n_dst.uid AS superseded_uid
       FROM edge e
       JOIN node n_dst ON n_dst.rowid = e.dst
       WHERE e.rel = 'SUPERSEDES' AND e.t_expired IS NULL`,
    );
    for (const r of result.rows) {
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
    return { results: [], provider_call_count: 0, degradations: [] };
  }

  const beforeCount = getProviderCallCount();

  const { agent_id, token_budget = DEFAULT_TOKEN_BUDGET, limit = 10 } = params;

  // (BL-391) Accumulates every non-fatal degradation across all stores —
  // never dropped. See FederatedRecallResponse.degradations doc comment.
  const federationDegradations: string[] = [];

  // Use cached connections (warm page cache, amortize open cost).
  interface OpenConn { scope: string; dbPath: string; adapter: StoreAdapter | null }
  const openConns: OpenConn[] = await Promise.all(
    stores.map(async ({ scope, dbPath }): Promise<OpenConn> => {
      const adapter = await getFederationConnection(dbPath);
      return { scope, dbPath, adapter };
    }),
  );
  for (const { scope, dbPath, adapter } of openConns) {
    if (adapter) continue;
    // BL-391: a store that failed to open must not silently vanish from
    // federated results as if it simply had no matches.
    const reason = _connErrors.get(dbPath) ?? 'connection unavailable';
    federationDegradations.push(`scope=${scope}: store unreachable (${dbPath}) — ${reason}`);
  }

  // 1. Collect SUPERSEDES targets.
  const suppressedUids = new Set<string>();
  for (const { adapter } of openConns) {
    if (adapter) await collectSupersededFromDb(adapter, suppressedUids);
  }

  // 2. Per-store recall.
  //    agent_id is NOT forwarded as SQL filter — boost applied post-recall.
  const storeParams: RecallParams = { ...params, agent_id: undefined };
  const allStoreResults: Array<{ scope: string; results: RecallResult[] }> = [];
  for (const { scope, adapter } of openConns) {
    if (!adapter) continue;
    const { results, degradations } = await recallFromOpenDb(adapter, scope, storeParams);
    allStoreResults.push({ scope, results });
    for (const d of degradations) federationDegradations.push(`scope=${scope}: ${d}`);
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
  return { results, provider_call_count: afterCount - beforeCount, degradations: federationDegradations };
}

// ── Helper functions (centralized from client/db.ts) ─────────────────────

/**
 * Check whether an episode is superseded (i.e. some other episode's SUPERSEDES
 * edge points to it via rowid).
 */
export async function isSuperseded(adapter: StoreAdapter, rowid: number): Promise<boolean> {
  const row = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM edge WHERE dst = ? AND rel = 'SUPERSEDES' AND t_expired IS NULL`,
    [rowid],
  );
  return (row?.cnt ?? 0) > 0;
}

/**
 * Return the UID of the episode that `rowid` supersedes (outbound SUPERSEDES
 * edge from src=rowid to dst). Returns null if no such edge exists.
 */
export async function supersedesUidForRowid(
  adapter: StoreAdapter,
  rowid: number,
): Promise<string | null> {
  const row = await adapter.executeGet<{ uid: string }>(
    `SELECT n.uid FROM edge e
     JOIN node n ON n.rowid = e.dst AND n.t_invalid IS NULL
     WHERE e.src = ? AND e.rel = 'SUPERSEDES' AND e.t_expired IS NULL
     LIMIT 1`,
    [rowid],
  );
  return row?.uid ?? null;
}

/**
 * Resolve the GLOBAL MEMBER_OF community uid for an episode rowid.
 *
 * Defaults to `cluster_scope.kind='global'` (treating legacy NULL scope as
 * global) so that persisted subset lenses never leak into recall's
 * `community_uid` field.
 */
export async function communityUidForRowid(
  adapter: StoreAdapter,
  rowid: number,
): Promise<string | null> {
  const row = await adapter.executeGet<{ uid: string }>(
    `SELECT n2.uid FROM edge e
     JOIN node n2 ON n2.rowid = e.dst AND n2.kind = 'community' AND n2.t_invalid IS NULL
       AND (json_extract(n2.meta, '$.cluster_scope.kind') IS NULL
            OR json_extract(n2.meta, '$.cluster_scope.kind') = 'global')
     WHERE e.src = ? AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
     ORDER BY e.rowid ASC
     LIMIT 1`,
    [rowid],
  );
  return row?.uid ?? null;
}

/**
 * Resolve episode rowids → uids, preserving the input order.
 */
export async function rowidsToUids(
  adapter: StoreAdapter,
  rowids: number[],
): Promise<string[]> {
  if (rowids.length === 0) return [];
  const ph = rowids.map(() => '?').join(',');
  const result = await adapter.executeAll<{ rowid: number; uid: string }>(
    `SELECT rowid, uid FROM node WHERE rowid IN (${ph})`,
    rowids,
  );
  const byRowid = new Map(result.rows.map((r) => [r.rowid, r.uid]));
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
