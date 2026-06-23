/**
 * MCP Server: Agent Memory Server v1.1.0
 * 20 memory_* tools over a single-file SQLite graph store.
 * Transport: stdio JSON-RPC (tools/list + tools/call).
 *
 * v1.0.0 adds (P4 enrichment surface — CONTRACTS.md C2):
 *   - memory_write: +topic/project_path/name/derived_from_uid inputs; returns enrichment
 *   - memory_recall: +filters (project_path, topic, tags, importance_min, time range);
 *                    query is now optional; results carry enrichment fields
 *   - memory_get_community: accepts community_uid directly; returns label/member_count/mean_intra_sim
 *   - NEW: memory_topics, memory_list_projects, memory_list_entities, memory_entity_episodes,
 *          memory_related, memory_supersession_chain, memory_near_duplicates,
 *          memory_curate, memory_stats
 *
 * v1.1.0 adds:
 *   - NEW: memory_update — in-place editor for an existing node (uid-keyed, immutable t_created,
 *          deep-merge metadata, re-embed on content/summary change, t_updated audit column)
 *
 * [mcp-path-guard] C6 enforcement: a policy guard runs BEFORE the resource sink
 * (getDb → openDb) in handleToolCall. The guard reads [def:policy-env] injected
 * by the supervisor ([process-boundary]) and denies any caller-supplied db_path
 * outside the declared allowlist. This is the HARD fs denial for the spawned
 * memory-server child ([ref:guard-before-sink], [def:enforcement-opt-in]).
 *
 * [def:enforcement-opt-in]: enforcement applies only when the enforce flag is
 * present. A server started without the enforce flag (standalone/dev) preserves
 * today's behaviour exactly ([inv:no-regress]).
 *
 * NOTE on vendoring: compilePolicyFromEnv is vendored here (not imported from
 * @sox/host-runtime) because the spawned memory-server is a standalone CommonJS
 * process — @sox/host-runtime is a private workspace package not available in
 * node_modules at the child's runtime. The implementation matches [shape:policy-env]
 * and the policy-core round-trip contract ([policy-core.4]) exactly; the
 * permission-guard.spec.ts [mcp-path-guard.5] tests verify parity.
 */

import { serve, defineTool } from '@sox/mcp-runtime';
import type { ToolDefinition, ToolResult } from '@sox/mcp-runtime';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDb, memoryWrite, memoryRecall, enqueueEnrich, memoryUpdate } from '@sox/memory-core';
import { clusterStats, clusterSubset, buildFiltersClause, ENRICH_VERSION } from '@sox/memory-enrich';
import type { MemoryFilter } from '@sox/memory-enrich';
import { monotonicFactory } from 'ulid';
import Database from 'better-sqlite3';

const ulid = monotonicFactory();

// ─── Vendored compilePolicyFromEnv — matches [shape:policy-env] ───────────────
//
// This is a minimal, dependency-free re-implementation of the policy-core
// contract ([shape:policy]) sufficient for the spawned child. It is parity-tested
// against the host-runtime version in permission-guard.spec.ts [mcp-path-guard.5].

/** Expand a leading ~/ to the user's home directory. */
function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return os.homedir() + p.slice(1);
  }
  return p;
}

/**
 * Build a regex from a glob pattern.
 * - `~/` prefix expanded via expandTilde
 * - `**` matches across path separators
 * - `*` matches within a segment (no `/`)
 */
function globToRegex(pattern: string): RegExp {
  const expanded = expandTilde(pattern);
  let regexStr = '';
  let i = 0;
  while (i < expanded.length) {
    if (expanded[i] === '*' && expanded[i + 1] === '*') {
      regexStr += '.*';
      i += 2;
      if (expanded[i] === '/') i++;
    } else if (expanded[i] === '*') {
      regexStr += '[^/]*';
      i++;
    } else {
      const ch = expanded[i] as string;
      regexStr += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
      i++;
    }
  }
  return new RegExp(`^${regexStr}$`);
}

/** Test whether absPath matches the glob pattern. */
function matchGlob(pattern: string, absPath: string): boolean {
  return globToRegex(pattern).test(absPath);
}

/** Normalize a path subject: expand ~/ and resolve to absolute. */
function normalizePath(p: string): string {
  return path.resolve(expandTilde(p));
}

/** Check whether absPath is permitted by patterns (deny-by-default when patterns present). */
function isPathAllowed(patterns: string[] | undefined, subject: string): boolean {
  if (patterns === undefined) return true;       // domain absent → unconstrained
  const norm = normalizePath(subject);
  return patterns.some((p) => matchGlob(p, norm));
}

/** Minimal Policy — [shape:policy] */
interface Policy {
  enforced: boolean;
  allowsFsRead(absPath: string): boolean;
  allowsFsWrite(absPath: string): boolean;
}

/**
 * Rebuild a Policy from [shape:policy-env] environment variables.
 * Inverse of Policy.toEnv() in libs/host-runtime/src/policy.ts.
 * Round-trip contract ([policy-core.4]): identical allow/deny decisions for all subjects.
 *
 * - enforce flag absent → enforced=false, every allows*() returns true ([def:enforcement-opt-in])
 * - enforce flag present → each domain reconstructed from its policy-env JSON array;
 *   empty array means deny-by-default for that domain ([ref:deny-by-default])
 *
 * Reads directly from process.env so the guard always sees the current enforcement
 * state ([process-boundary] injects the policy-env before exec; stable in production).
 * Tests set the policy-env keys on process.env in beforeEach (same pattern as the
 * other guard tests) and delete them in afterEach.
 */
export function compilePolicyFromEnv(): Policy {
  if (!process.env.SOX_PERM_ENFORCE) {
    return {
      enforced: false,
      allowsFsRead: () => true,
      allowsFsWrite: () => true,
    };
  }

  function parseRaw(raw: string | undefined): string[] | undefined {
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch { /* malformed — treat as unconstrained */ }
    return undefined;
  }

  const fsRead = parseRaw(process.env.SOX_PERM_FS_READ);
  const fsWrite = parseRaw(process.env.SOX_PERM_FS_WRITE);

  return {
    enforced: true,
    allowsFsRead: (absPath: string) => isPathAllowed(fsRead, absPath),
    allowsFsWrite: (absPath: string) => isPathAllowed(fsWrite, absPath),
  };
}

// ─── Policy accessor ──────────────────────────────────────────────────────────
//
// The policy is read from process.env on each guard invocation rather than cached
// once at module load time. This serves two purposes:
//
//   1. In production (spawned server): process.env is stable — the supervisor
//      injects [def:policy-env] before exec and never mutates it afterward
//      ([process-boundary]). The result is functionally identical to a cached policy.
//
//   2. In tests: process.env is set per-test in beforeEach/afterEach, so reading
//      it fresh each call ensures the guard sees the correct enforcement state
//      for each test case without module reload.
//
// [def:enforcement-opt-in]: if the enforce flag is absent (standalone/dev mode),
// compilePolicyFromEnv returns enforced=false, every allows*() returns true —
// legacy behaviour is preserved exactly ([inv:no-regress]).

function getPolicy(): Policy {
  return compilePolicyFromEnv();
}

// ─── Active DB connections ────────────────────────────────────────────────────

// Active DB connections keyed by dbPath
const dbCache = new Map<string, Database.Database>();

function getDb(dbPath: string): Database.Database {
  const cached = dbCache.get(dbPath);
  if (cached) return cached;
  const db = openDb(dbPath);
  dbCache.set(dbPath, db);
  return db;
}

const TOOLS: Array<Omit<ToolDefinition, 'handler'>> = [
  {
    name: 'memory_ping',
    description:
      'Use this to verify the server is reachable — returns {ok:true} without touching any database.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_write',
    description:
      'Write a memory episode. Runs deterministic enrichment synchronously (provenance, tags, topic, near-dup, extractive summary). Returns {episode_uid}. Batch enrichments (clustering, auto-links, importance link-score) run asynchronously in the daemon.',
    inputSchema: {
      type: 'object',
      properties: {
        content:          { type: 'string', description: 'The content to memorize. Required.' },
        db_path:          { type: 'string', description: 'Path to the .db file.' },
        summary:          { type: 'string', description: '(E2) Human-readable summary. Persisted to node.summary; no extractive fallback runs if supplied.' },
        name:             { type: 'string', description: '(E2) Title/name for this episode (node.name).' },
        topic:            { type: 'string', description: '(E5) Explicit topic override. Stored to node.topic; takes priority over [<topic>] prefix and cluster label.' },
        tags:             { type: 'array', items: { type: 'string' }, description: '(E4) Concept/entity tags. Persisted as node.tags JSON array AND as entity nodes + MENTIONS edges.' },
        metadata:         { type: 'object', additionalProperties: true, description: '(E3) Arbitrary caller metadata persisted as node.meta JSON. Queryable via json_extract.' },
        project_path:     { type: 'string', description: '(E1) Caller project root path. Auto-detected from cwd+git if omitted.' },
        derived_from_uid: { type: 'string', description: '(E9) UID of a parent episode; emits a DERIVED_FROM edge from this episode to parent.' },
        session_id:       { type: 'string' },
        t_occurred:       { type: 'string', description: 'ISO timestamp when this occurred.' },
        agent_id:         { type: 'string' },
        source: {
          type: 'string',
          enum: ['message', 'tool_output', 'observation', 'document', 'reflection', 'import'],
        },
        importance:       { type: 'number', minimum: 1, maximum: 10, description: 'User-asserted importance (1–10). If supplied, batch enricher will not overwrite it.' },
        chunk_size: {
          type: 'number',
          description: 'Approximate tokens per chunk (default: 500). Content exceeding this threshold is split at sentence boundaries; each chunk is stored as a separate episode with a DERIVED_FROM edge to the parent.',
          default: 500,
        },
      },
      required: ['content', 'db_path'],
    },
  },
  {
    name: 'memory_recall',
    description:
      'Recall memories using hybrid vec+BM25+temporal search, filtered by provenance, topic, or tags. query may be omitted for importance-ranked listing. <50ms, zero LLM.',
    inputSchema: {
      type: 'object',
      properties: {
        query:        { type: 'string', description: 'Semantic query text. If absent or empty, returns importance-ranked results (no vec/FTS, sorted by importance DESC).' },
        db_path:      { type: 'string' },
        scope:        { type: 'string', description: 'Store scope name: project/user/org/local.' },
        agent_id:     { type: 'string' },
        as_of:        { type: 'string', description: 'ISO timestamp for point-in-time recall.' },
        token_budget: { type: 'number', default: 4000 },
        depth:        { type: 'number', default: 1 },
        limit:        { type: 'number', default: 10 },
        filters: {
          type: 'object',
          description: 'Optional filter object.',
          properties: {
            project_path: {
              oneOf: [
                { type: 'string', description: 'Exact match on node.project_path.' },
                { type: 'object', properties: { prefix: { type: 'string' } }, required: ['prefix'], description: 'Prefix match.' },
              ],
            },
            topic:           { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Exact topic string or array of topics (OR semantics).' },
            tags:            { type: 'array', items: { type: 'string' }, description: 'Any-match: episodes that have at least one of these tags.' },
            tags_match_all:  { type: 'boolean', default: false },
            importance_min:  { type: 'number', description: 'Only return episodes with importance >= this value.' },
            t_created_after: { type: 'string', description: 'ISO timestamp; only episodes created after this.' },
            t_created_before:{ type: 'string', description: 'ISO timestamp; only episodes created before this.' },
          },
        },
      },
      required: ['db_path'],
    },
  },
  {
    name: 'memory_search_entities',
    description: 'Search for entities by name/type. Returns matching entity nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        db_path: { type: 'string' },
        entity_type: { type: 'string' },
        limit: { type: 'number', default: 10 },
      },
      required: ['query', 'db_path'],
    },
  },
  {
    name: 'memory_get_session_state',
    description: 'Get session working memory state.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        db_path: { type: 'string' },
      },
      required: ['session_id', 'db_path'],
    },
  },
  {
    name: 'memory_save_session_state',
    description: 'Save session working memory state.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        state: { type: 'object' },
        db_path: { type: 'string' },
      },
      required: ['session_id', 'state', 'db_path'],
    },
  },
  {
    name: 'memory_get_community',
    description: 'Get a community node (embedding-derived cluster) and its members.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path:       { type: 'string' },
        entity_uid:    { type: 'string', description: 'Resolve community for this episode/entity UID (via MEMBER_OF edge).' },
        community_uid: { type: 'string', description: 'Fetch a community directly by its UID.' },
        level:         { type: 'number', default: 0 },
      },
      required: ['db_path'],
    },
  },
  {
    name: 'memory_invalidate',
    description: 'Invalidate a claim (bi-temporal: sets t_invalid, never deletes).',
    inputSchema: {
      type: 'object',
      properties: {
        claim_uid: { type: 'string' },
        reason: { type: 'string' },
        db_path: { type: 'string' },
        t_transition: { type: 'string' },
        replacement_uid: { type: 'string' },
      },
      required: ['claim_uid', 'reason', 'db_path'],
    },
  },
  {
    name: 'memory_update',
    description:
      'In-place editor for an existing live node. Distinct from supersession (which mints a new node). The uid is the required selector and is immutable — it can never change. Updates content, summary, name, topic, tags, importance, metadata (deep-merge by default), t_occurred, and t_valid. t_created is never modified (audit anchor). When content or summary changes, the embedding is refreshed automatically. FTS is auto-synced by the node UPDATE trigger. Returns {uid, updated_fields, reembedded}.',
    inputSchema: {
      type: 'object',
      properties: {
        uid:            { type: 'string', description: 'UID of the live node to update. Required. Error E_NOT_FOUND if absent or invalidated.' },
        db_path:        { type: 'string', description: 'Path to the .db file.' },
        content:        { type: 'string', description: 'Replace node.content. Triggers re-embed and FTS update.' },
        summary:        { type: 'string', description: 'Replace node.summary. Triggers re-embed and FTS update.' },
        name:           { type: 'string', description: 'Replace node.name.' },
        topic:          { type: 'string', description: 'Replace node.topic.' },
        tags:           { type: 'array', items: { type: 'string' }, description: 'Replace node.tags (replaces existing tags wholesale — not additive).' },
        importance:     { type: 'number', minimum: 1, maximum: 10, description: 'Replace node.importance.' },
        metadata:       { type: 'object', additionalProperties: true, description: 'Metadata to merge into (or replace) existing node.meta. See metadata_merge.' },
        metadata_merge: {
          type: 'string',
          enum: ['deep', 'replace'],
          default: 'deep',
          description: "'deep' (default): recursive merge for nested objects; arrays are replaced not concatenated. 'replace': overwrites node.meta wholesale.",
        },
        t_occurred:     { type: 'string', description: 'ISO timestamp — replace node.t_occurred.' },
        t_valid:        { type: 'string', description: 'ISO timestamp — replace node.t_valid.' },
      },
      required: ['uid', 'db_path'],
    },
  },
  {
    name: 'memory_link',
    description:
      'Create a directed edge between two existing nodes. Use for chunk→parent (DERIVED_FROM), claim replacement (SUPERSEDES), or explicit relationships (RELATES_TO, SUPPORTS, MENTIONS, SAME_AS).',
    inputSchema: {
      type: 'object',
      properties: {
        src_uid: { type: 'string', description: 'UID of the source node' },
        dst_uid: { type: 'string', description: 'UID of the destination node' },
        rel: {
          type: 'string',
          enum: ['MENTIONS', 'SUPPORTS', 'RELATES_TO', 'DERIVED_FROM', 'SUPERSEDES', 'SAME_AS', 'ASSIGNED_TO'],
          description: 'Relationship type',
        },
        db_path: { type: 'string', description: 'Path to the .db file' },
        weight: { type: 'number', description: 'Optional edge weight (0–1)' },
        meta: { type: 'object', description: 'Optional JSON metadata' },
      },
      required: ['src_uid', 'dst_uid', 'rel', 'db_path'],
    },
  },
  // ── P4 NEW TOOLS ──────────────────────────────────────────────────────────────
  {
    name: 'memory_topics',
    description:
      'List topics in the memory store with episode counts and cluster backing status. Use before memory_recall to discover valid topic filters.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path:      { type: 'string' },
        project_path: { type: 'string', description: 'Filter to topics that have at least one episode from this project_path.' },
        search:       { type: 'string', description: 'Partial topic name substring filter.' },
        sort_by:      { type: 'string', enum: ['episode_count', 'avg_importance', 'last_written'], default: 'episode_count' },
        limit:        { type: 'number', default: 20, maximum: 200 },
        offset:       { type: 'number', default: 0 },
      },
      required: ['db_path'],
    },
  },
  {
    name: 'memory_list_projects',
    description: 'List distinct project_path values present in the store, with episode counts.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path: { type: 'string' },
        limit:   { type: 'number', default: 20, maximum: 200 },
        offset:  { type: 'number', default: 0 },
      },
      required: ['db_path'],
    },
  },
  {
    name: 'memory_list_entities',
    description:
      'List entity nodes ranked by mention count. Use for entity vocabulary discovery. For lookup by name/type, use memory_search_entities.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path:      { type: 'string' },
        project_path: { type: 'string', description: 'Only count episodes from this project_path.' },
        topic:        { type: 'string', description: 'Only count episodes in this topic.' },
        search:       { type: 'string', description: 'Substring filter on entity name.' },
        limit:        { type: 'number', default: 20, maximum: 200 },
        offset:       { type: 'number', default: 0 },
      },
      required: ['db_path'],
    },
  },
  {
    name: 'memory_entity_episodes',
    description:
      'Return episodes that mention a given entity (via MENTIONS edge), ranked by importance.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path:     { type: 'string' },
        entity_uid:  { type: 'string', description: 'UID of the entity node.' },
        entity_name: { type: 'string', description: 'Name of the entity (resolved to UID if entity_uid not supplied).' },
        limit:       { type: 'number', default: 20, maximum: 200 },
        offset:      { type: 'number', default: 0 },
      },
      required: ['db_path'],
    },
  },
  {
    name: 'memory_related',
    description:
      'Return neighbor episodes of a given episode at depth=1 via graph edges (RELATES_TO, DERIVED_FROM, SUPPORTS, SAME_AS).',
    inputSchema: {
      type: 'object',
      properties: {
        db_path:  { type: 'string' },
        uid:      { type: 'string', description: 'UID of the source episode.' },
        rel:      { type: 'array', items: { type: 'string' }, description: 'Filter by relation type(s). Default: all live relation types.' },
        limit:    { type: 'number', default: 20, maximum: 100 },
      },
      required: ['db_path', 'uid'],
    },
  },
  {
    name: 'memory_supersession_chain',
    description:
      'Return the supersession chain for an episode: what it supersedes and what supersedes it.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path: { type: 'string' },
        uid:     { type: 'string', description: 'Any episode UID in the chain.' },
      },
      required: ['db_path', 'uid'],
    },
  },
  {
    name: 'memory_near_duplicates',
    description:
      'List near-duplicate episode pairs connected by SAME_AS edges. Use for manual deduplication review.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path:      { type: 'string' },
        project_path: { type: 'string' },
        topic:        { type: 'string' },
        threshold:    { type: 'number', description: 'Minimum cosine similarity stored in the SAME_AS edge meta.' },
        limit:        { type: 'number', default: 20, maximum: 200 },
        offset:       { type: 'number', default: 0 },
      },
      required: ['db_path'],
    },
  },
  {
    name: 'memory_curate',
    description:
      'Curation operations: retag, set topic, override importance, merge near-duplicates, or trigger a (optionally filtered) re-cluster pass.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path:    { type: 'string' },
        op: {
          type: 'string',
          enum: ['retag', 'set_topic', 'set_importance', 'merge_duplicates', 'recluster'],
          description: 'The curation operation to perform.',
        },
        uid:        { type: 'string', description: 'Target episode UID (required for retag, set_topic, set_importance).' },
        tags:       { type: 'array', items: { type: 'string' }, description: '(retag) Tags to add. Additive; duplicates are ignored.' },
        topic:      { type: 'string', description: '(set_topic) New topic string.' },
        importance: { type: 'number', minimum: 1, maximum: 10, description: '(set_importance) User-asserted importance.' },
        uid_keep:   { type: 'string', description: '(merge_duplicates) UID of the episode to keep.' },
        uid_drop:   { type: 'string', description: '(merge_duplicates) UID of the episode to invalidate.' },
        filters:    { type: 'object', description: '(recluster) Restrict clustering to the matching subset of episodes. Same filter vocabulary as memory_recall: project_path, topic, tags, tags_match_all, importance_min, t_created_after/before. When present, recluster runs SYNCHRONOUSLY over the subset and returns the resulting communities. Combined with dry_run: dry_run=true returns communities without writing; dry_run=false persists them as a provenance-scoped community slice that leaves the global partition untouched. Absent: global async re-cluster via the daemon (unchanged).' },
        threshold:  { type: 'number', description: '(recluster, filtered) Optional cosine similarity threshold override for the subset pass.' },
        dry_run:    { type: 'boolean', default: false, description: 'If true, return proposed changes without committing them.' },
      },
      required: ['db_path', 'op'],
    },
  },
  {
    name: 'memory_stats',
    description:
      'Return enrichment coverage and cluster quality statistics. Use for health checks and CI gates. Returns tool_version: "1.1.0" signaling v1.1 surface (including memory_update) is present.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path:      { type: 'string' },
        project_path: { type: 'string', description: 'Scope stats to episodes from this project.' },
      },
      required: ['db_path'],
    },
  },
];


/**
 * [mcp-path-guard] Policy guard: resolve db_path to absolute, then check the
 * compiled policy BEFORE calling getDb/openDb (the resource sink).
 *
 * Resolution: expandTilde + path.resolve ensures that relative paths such as
 * ../../etc/x that escape the allowlist are correctly denied ([ref:guard-before-sink]).
 *
 * When policy.enforced === false (enforce flag absent, standalone/dev),
 * this function returns null and the caller proceeds normally ([def:enforcement-opt-in],
 * [inv:no-regress]).
 *
 * Returns: a permission-denied tool result on denial, or null if the path is allowed.
 */
function checkDbPathPolicy(dbPath: string): (ToolResult & { isError: true }) | null {
  const p = getPolicy();
  if (!p.enforced) return null;

  // Resolve to absolute: expand ~/ then resolve relative components.
  // This ensures that relative paths like ../../etc/x that escape the allowlist
  // are correctly denied ([ref:guard-before-sink]).
  const resolvedPath = path.resolve(expandTilde(dbPath));

  // Check both read and write — the db_path grants full file access
  if (!p.allowsFsWrite(resolvedPath) || !p.allowsFsRead(resolvedPath)) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `permission denied: db_path ${resolvedPath} outside declared fs allowlist`,
        },
      ],
    };
  }

  return null;
}

/**
 * Split `text` into chunks of at most `chunkTokens * 4` characters, preferring
 * sentence boundaries (`.`, `!`, `?` followed by whitespace).
 * Returns a single-element array if text is short enough to not need splitting.
 */
function splitIntoChunks(text: string, chunkTokens: number): string[] {
  const chunkChars = chunkTokens * 4;
  if (text.length <= chunkChars) return [text];

  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = '';

  for (const sentence of sentences) {
    if (current.length > 0 && current.length + 1 + sentence.length > chunkChars) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? current + ' ' + sentence : sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

// ── Helpers for enrichment field reads ───────────────────────────────────────

/** Parse a JSON tags column value — returns [] if null or invalid. */
function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch { /* malformed */ }
  return [];
}

// buildFiltersClause is now owned by @sox/memory-enrich (imported above).
// The local server still uses MemoryFilter for the recluster case type-cast.

/** Resolve episode rowids → uids, preserving the input order. */
function rowidsToUids(db: Database.Database, rowids: number[]): string[] {
  if (rowids.length === 0) return [];
  const ph = rowids.map(() => '?').join(',');
  const rows = db
    .prepare<unknown[], { rowid: number; uid: string }>(
      `SELECT rowid, uid FROM node WHERE rowid IN (${ph})`,
    )
    .all(...rowids);
  const byRowid = new Map(rows.map((r) => [r.rowid, r.uid]));
  return rowids.map((r) => byRowid.get(r)).filter((u): u is string => typeof u === 'string');
}

/**
 * Resolve the GLOBAL MEMBER_OF community uid for an episode rowid.
 *
 * Defaults to `cluster_scope.kind='global'` (treating legacy NULL scope as global)
 * so that persisted subset lenses never leak into recall's `community_uid` field.
 * An episode may be MEMBER_OF both a global and one or more subset communities —
 * this function always returns the global one.
 */
function communityUidForRowid(db: Database.Database, rowid: number): string | null {
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

/** Resolve the SUPERSEDES uid for an episode rowid (i.e., what episode this supersedes). */
function supersedesUidForRowid(db: Database.Database, rowid: number): string | null {
  // "This episode supersedes dst": edge where src=rowid, rel=SUPERSEDES
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

/** Check if an episode is superseded (some other episode's SUPERSEDES edge points to it). */
function isSuperseded(db: Database.Database, rowid: number): boolean {
  const row = db
    .prepare<[number], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM edge WHERE dst = ? AND rel = 'SUPERSEDES' AND t_expired IS NULL`,
    )
    .get(rowid);
  return (row?.cnt ?? 0) > 0;
}

export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  // memory_ping: no db_path needed — handled before the db_path guard.
  if (name === 'memory_ping') {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  }

  const dbPath = args['db_path'] as string | undefined;
  if (!dbPath) {
    return { isError: true, content: [{ type: 'text', text: 'db_path is required' }] };
  }

  // [ref:guard-before-sink]: policy guard runs BEFORE getDb/openDb.
  // openDb does mkdirSync then opens — so the guard must precede the sink so
  // that no directory or file is created at an undeclared path on denial.
  // ([mcp-path-guard.1], [mcp-path-guard.3])
  const denied = checkDbPathPolicy(dbPath);
  if (denied) return denied;

  const db = getDb(dbPath);

  switch (name) {
    case 'memory_write': {
      const content = args['content'] as string;
      const chunkSize = (args['chunk_size'] as number | undefined) ?? 500;
      const chunks = splitIntoChunks(content, chunkSize);

      if (chunks.length > 1) {
        // Long content: write parent episode, then all chunks in parallel
        // (embed() dispatches to the worker thread — parallel dispatches are safe;
        //  the synchronous SQLite transactions serialise naturally on the JS event loop)
        const parentResult = await memoryWrite(db, {
          content,
          summary: args['summary'] as string | undefined,
          name: args['name'] as string | undefined,
          topic: args['topic'] as string | undefined,
          project_path: args['project_path'] as string | undefined,
          derived_from_uid: args['derived_from_uid'] as string | undefined,
          metadata: args['metadata'] as Record<string, unknown> | undefined,
          session_id: args['session_id'] as string | undefined,
          t_occurred: args['t_occurred'] as string | undefined,
          agent_id: args['agent_id'] as string | undefined,
          source: args['source'] as 'message' | undefined,
          importance: args['importance'] as number | undefined,
          tags: args['tags'] as string[] | undefined,
        });

        const parentUid =
          'episode_uid' in parentResult
            ? parentResult.episode_uid
            : parentResult.code === 'E_DEDUP'
              ? parentResult.existing_uid
              : null;

        if (!parentUid) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(parentResult) }] };
        }

        const chunkResults = await Promise.all(
          chunks.map((chunk) =>
            memoryWrite(db, {
              content: chunk,
              agent_id: args['agent_id'] as string | undefined,
              source: (args['source'] as 'message' | undefined) ?? 'document',
              metadata: args['metadata'] as Record<string, unknown> | undefined,
            }),
          ),
        );

        const now = new Date().toISOString();
        const parentRow = db
          .prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?')
          .get(parentUid);
        const chunkUids: string[] = [];

        for (const chunkResult of chunkResults) {
          const chunkUid =
            'episode_uid' in chunkResult
              ? chunkResult.episode_uid
              : chunkResult.code === 'E_DEDUP'
                ? chunkResult.existing_uid
                : null;

          if (chunkUid) {
            chunkUids.push(chunkUid);
            const chunkRow = db
              .prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?')
              .get(chunkUid);
            if (chunkRow && parentRow) {
              db.prepare(
                `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
                 SELECT ?, ?, 'DERIVED_FROM', 'user_asserted', ?, '{"auto_chunk":true}'
                 WHERE NOT EXISTS (
                   SELECT 1 FROM edge WHERE src=? AND dst=? AND rel='DERIVED_FROM' AND t_expired IS NULL
                 )`,
              ).run(chunkRow.rowid, parentRow.rowid, now, chunkRow.rowid, parentRow.rowid);
            }
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ episode_uid: parentUid, chunk_uids: chunkUids, chunk_count: chunks.length }),
          }],
        };
      }

      // Content below threshold: single write
      const result = await memoryWrite(db, {
        content,
        summary: args['summary'] as string | undefined,
        name: args['name'] as string | undefined,
        topic: args['topic'] as string | undefined,
        project_path: args['project_path'] as string | undefined,
        derived_from_uid: args['derived_from_uid'] as string | undefined,
        metadata: args['metadata'] as Record<string, unknown> | undefined,
        session_id: args['session_id'] as string | undefined,
        t_occurred: args['t_occurred'] as string | undefined,
        agent_id: args['agent_id'] as string | undefined,
        source: args['source'] as 'message' | undefined,
        importance: args['importance'] as number | undefined,
        tags: args['tags'] as string[] | undefined,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_recall': {
      const query = args['query'] as string | undefined;
      const filters = args['filters'] as Record<string, unknown> | undefined;
      const limit = (args['limit'] as number | undefined) ?? 10;

      // If no query (or empty), fall back to importance-ranked listing (UC7, OQ-6).
      if (!query || !query.trim()) {
        const { sql: filterSql, params: filterParams } = buildFiltersClause(filters);
        const rows = db
          .prepare<unknown[], {
            rowid: number; uid: string; content: string | null; importance: number;
            t_valid: string | null; agent_id: string | null; content_hash: string | null;
            summary: string | null; topic: string | null; tags: string | null;
            project_path: string | null; t_invalid: string | null; t_created: string;
          }>(
            `SELECT n.rowid, n.uid, n.content, n.importance, n.t_valid, n.agent_id,
                    n.content_hash, n.summary, n.topic, n.tags, n.project_path,
                    n.t_invalid, n.t_created
             FROM node n
             WHERE n.kind = 'episode' AND n.t_invalid IS NULL${filterSql}
             ORDER BY n.importance DESC, n.t_created DESC
             LIMIT ?`,
          )
          .all(...filterParams, limit);

        const results = rows.map((r) => ({
          uid: r.uid,
          content: r.content,
          score: r.importance / 10.0,
          t_valid: r.t_valid,
          scope: (args['scope'] as string | undefined) ?? 'project',
          provenance: ['importance'],
          importance: r.importance,
          content_hash: r.content_hash ?? null,
          agent_id: r.agent_id ?? null,
          // v1 enrichment fields:
          summary: r.summary ?? null,
          topic: r.topic ?? null,
          tags: parseTags(r.tags),
          project_path: r.project_path ?? null,
          is_superseded: isSuperseded(db, r.rowid),
          supersedes_uid: supersedesUidForRowid(db, r.rowid),
          community_uid: communityUidForRowid(db, r.rowid),
        }));

        return {
          content: [{ type: 'text', text: JSON.stringify({ results, provider_call_count: 0 }) }],
        };
      }

      // Build recall filters map compatible with RecallParams.filters
      const recallFilters: Record<string, unknown> = {};
      if (filters) {
        // project_path
        const pp = filters['project_path'];
        if (pp !== undefined) recallFilters['project_path'] = pp;
        // topic
        const tf = filters['topic'];
        if (tf !== undefined) recallFilters['topic'] = tf;
        // tags
        const tg = filters['tags'];
        if (tg !== undefined) recallFilters['tags'] = tg;
        // tags_match_all
        const tma = filters['tags_match_all'];
        if (tma !== undefined) recallFilters['tags_match_all'] = tma;
        // importance_min
        const im = filters['importance_min'];
        if (im !== undefined) recallFilters['importance_min'] = im;
        // time range
        const ta = filters['t_created_after'];
        if (ta !== undefined) recallFilters['t_created_after'] = ta;
        const tb = filters['t_created_before'];
        if (tb !== undefined) recallFilters['t_created_before'] = tb;
      }

      const recallResult = await memoryRecall(db, (args['scope'] as string) ?? 'project', {
        query,
        agent_id: args['agent_id'] as string | undefined,
        as_of: args['as_of'] as string | undefined,
        token_budget: args['token_budget'] as number | undefined,
        depth: args['depth'] as number | undefined,
        limit,
        filters: Object.keys(recallFilters).length > 0 ? recallFilters : undefined,
      });

      // Augment each result with v1 enrichment fields
      const enrichedResults = recallResult.results.map((r) => {
        // Fetch enrichment columns for this uid
        const nodeRow = db
          .prepare<[string], {
            rowid: number; summary: string | null; topic: string | null;
            tags: string | null; project_path: string | null; t_invalid: string | null;
          }>(
            `SELECT rowid, summary, topic, tags, project_path, t_invalid FROM node WHERE uid = ? LIMIT 1`,
          )
          .get(r.uid);

        return {
          ...r,
          summary: nodeRow?.summary ?? null,
          topic: nodeRow?.topic ?? null,
          tags: parseTags(nodeRow?.tags),
          project_path: nodeRow?.project_path ?? null,
          is_superseded: nodeRow ? isSuperseded(db, nodeRow.rowid) : false,
          supersedes_uid: nodeRow ? supersedesUidForRowid(db, nodeRow.rowid) : null,
          community_uid: nodeRow ? communityUidForRowid(db, nodeRow.rowid) : null,
        };
      });

      // Apply filter-level post-processing for fields not handled by the core recall.
      // The core recall path does not yet understand the enrichment filters natively,
      // so we apply them as a post-filter on the result set.
      let filteredResults = enrichedResults;
      if (filters) {
        const { sql: filterSql, params: filterParams } = buildFiltersClause(filters);
        if (filterSql) {
          // Collect the uids that pass the SQL filter
          const uidsRaw = db
            .prepare<unknown[], { uid: string }>(
              `SELECT n.uid FROM node n WHERE n.uid IN (${enrichedResults.map(() => '?').join(',')})${filterSql}`,
            )
            .all(...enrichedResults.map((r) => r.uid), ...filterParams);
          const passingUids = new Set(uidsRaw.map((r) => r.uid));
          filteredResults = enrichedResults.filter((r) => passingUids.has(r.uid));
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ results: filteredResults, provider_call_count: recallResult.provider_call_count }) }],
      };
    }

    case 'memory_search_entities': {
      const query = args['query'] as string;
      const limit = (args['limit'] as number) ?? 10;
      const rows = db
        .prepare(
          `SELECT uid, name, kind, summary, importance FROM node
           WHERE kind = 'entity' AND (name LIKE ? OR summary LIKE ?)
             AND t_invalid IS NULL
           ORDER BY importance DESC LIMIT ?`,
        )
        .all(`%${query}%`, `%${query}%`, limit);
      return {
        content: [{ type: 'text', text: JSON.stringify({ entities: rows }) }],
      };
    }

    case 'memory_get_session_state': {
      const sessionId = args['session_id'] as string;
      const row = db
        .prepare(
          `SELECT resume_state FROM node WHERE kind = 'session' AND session_id = ? AND t_invalid IS NULL`,
        )
        .get(sessionId) as { resume_state: string | null } | undefined;
      const state = row?.resume_state ? (JSON.parse(row.resume_state) as unknown) : null;
      return {
        content: [{ type: 'text', text: JSON.stringify({ state }) }],
      };
    }

    case 'memory_save_session_state': {
      const sessionId = args['session_id'] as string;
      const state = JSON.stringify(args['state']);
      const now = new Date().toISOString();
      const uid = `session-${sessionId}-${now}`;
      // Upsert: close old session node, insert new one
      db.transaction(() => {
        db.prepare(
          `UPDATE node SET t_invalid = ? WHERE kind = 'session' AND session_id = ? AND t_invalid IS NULL`,
        ).run(now, sessionId);
        db.prepare(
          `INSERT INTO node (uid, kind, session_id, resume_state, t_created, t_valid)
           VALUES (?, 'session', ?, ?, ?, ?)`,
        ).run(uid, sessionId, state, now, now);
      })();
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      };
    }

    case 'memory_get_community': {
      const entityUid = args['entity_uid'] as string | undefined;
      const communityUidArg = args['community_uid'] as string | undefined;
      const level = (args['level'] as number) ?? 0;

      // OQ-1: community_uid takes precedence; both supplied is an error per contract.
      if (entityUid && communityUidArg) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code: 'E_AMBIGUOUS', message: 'Supply entity_uid OR community_uid, not both' }) }],
        };
      }

      interface CommunityRow {
        rowid: number; uid: string; name: string | null; meta: string | null; t_created: string;
      }

      let communityRow: CommunityRow | undefined;

      if (communityUidArg) {
        // Fetch community directly by UID
        communityRow = db
          .prepare<[string], CommunityRow>(
            `SELECT rowid, uid, name, meta, t_created FROM node
             WHERE uid = ? AND kind = 'community' AND t_invalid IS NULL`,
          )
          .get(communityUidArg);
      } else if (entityUid) {
        // Find community via MEMBER_OF edge — scoped to GLOBAL communities by default.
        // A subset lens on the same episode must not shadow the global community lookup.
        communityRow = db
          .prepare<[number, string], CommunityRow>(
            `SELECT n2.rowid, n2.uid, n2.name, n2.meta, n2.t_created
             FROM node n1
             JOIN edge e ON e.src = n1.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
             JOIN node n2 ON n2.rowid = e.dst AND n2.kind = 'community' AND n2.level = ? AND n2.t_invalid IS NULL
               AND (json_extract(n2.meta, '$.cluster_scope.kind') IS NULL
                    OR json_extract(n2.meta, '$.cluster_scope.kind') = 'global')
             WHERE n1.uid = ? AND n1.t_invalid IS NULL
             LIMIT 1`,
          )
          .get(level, entityUid);
      } else {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code: 'E_MISSING_INPUT', message: 'Supply entity_uid or community_uid' }) }],
        };
      }

      if (!communityRow) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', entity_uid: entityUid, community_uid: communityUidArg }) }],
        };
      }

      // Parse community meta for quality metrics
      let memberCount = 0;
      let meanIntraSim = 0;
      let centroidEpisodeUid = '';
      if (communityRow.meta) {
        try {
          const m = JSON.parse(communityRow.meta) as {
            mean_intra_sim?: number;
            centroid_rowid?: number;
            member_count?: number;
          };
          if (typeof m.mean_intra_sim === 'number') meanIntraSim = m.mean_intra_sim;
          if (typeof m.member_count === 'number') memberCount = m.member_count;
          if (typeof m.centroid_rowid === 'number') {
            const centRow = db
              .prepare<[number], { uid: string }>(`SELECT uid FROM node WHERE rowid = ?`)
              .get(m.centroid_rowid);
            if (centRow) centroidEpisodeUid = centRow.uid;
          }
        } catch { /* malformed meta */ }
      }

      // Fetch member episodes via MEMBER_OF edges
      const memberRows = db
        .prepare<[number], {
          uid: string; summary: string | null; topic: string | null;
          importance: number; t_created: string; project_path: string | null;
          tags: string | null;
        }>(
          `SELECT n.uid, n.summary, n.topic, n.importance, n.t_created, n.project_path, n.tags
           FROM edge e
           JOIN node n ON n.rowid = e.src AND n.t_invalid IS NULL
           WHERE e.dst = ? AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
           ORDER BY n.importance DESC`,
        )
        .all(communityRow.rowid);

      if (memberCount === 0) memberCount = memberRows.length;

      const communityOut = {
        uid: communityRow.uid,
        label: communityRow.name ?? communityRow.uid,
        member_count: memberCount,
        mean_intra_sim: meanIntraSim,
        centroid_episode_uid: centroidEpisodeUid,
        t_created: communityRow.t_created,
      };

      const members = memberRows.map((m) => ({
        uid: m.uid,
        summary: m.summary ?? null,
        topic: m.topic ?? null,
        importance: m.importance,
        t_created: m.t_created,
        project_path: m.project_path ?? null,
        tags: parseTags(m.tags),
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({ community: communityOut, members }) }],
      };
    }

    case 'memory_invalidate': {
      const claimUid = args['claim_uid'] as string;
      const reason = args['reason'] as string;
      const tTransition = (args['t_transition'] as string) ?? new Date().toISOString();
      const replacementUid = args['replacement_uid'] as string | undefined;

      const claim = db
        .prepare(`SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`)
        .get(claimUid) as { rowid: number } | undefined;
      if (!claim) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', claim_uid: claimUid }) }],
        };
      }

      let supersedgesEdgeUid: string | undefined;
      db.transaction(() => {
        // Close t_invalid
        db.prepare(`UPDATE node SET t_invalid = ? WHERE uid = ?`).run(tTransition, claimUid);

        if (replacementUid) {
          const replacement = db
            .prepare(`SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`)
            .get(replacementUid) as { rowid: number } | undefined;
          if (replacement) {
            supersedgesEdgeUid = `sup-${Date.now()}`;
            db.prepare(
              `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
               VALUES (?, ?, 'SUPERSEDES', 'user_asserted', ?, ?)`,
            ).run(replacement.rowid, claim.rowid, tTransition, JSON.stringify({ reason }));
          }
        }
      })();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: true, supersedes_edge_uid: supersedgesEdgeUid }),
        }],
      };
    }

    case 'memory_update': {
      const uid = args['uid'] as string | undefined;
      if (!uid) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_MISSING', message: 'uid is required' }) }] };
      }
      const updateResult = await memoryUpdate(db, {
        uid,
        content:        args['content']        as string | undefined,
        summary:        args['summary']        as string | undefined,
        name:           args['name']           as string | undefined,
        topic:          args['topic']          as string | undefined,
        tags:           args['tags']           as string[] | undefined,
        importance:     args['importance']     as number | undefined,
        metadata:       args['metadata']       as Record<string, unknown> | undefined,
        metadata_merge: args['metadata_merge'] as 'deep' | 'replace' | undefined,
        t_occurred:     args['t_occurred']     as string | undefined,
        t_valid:        args['t_valid']        as string | undefined,
      });
      if ('code' in updateResult) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(updateResult) }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(updateResult) }],
      };
    }

    case 'memory_link': {
      const VALID_RELS = ['MENTIONS', 'SUPPORTS', 'RELATES_TO', 'DERIVED_FROM', 'SUPERSEDES', 'SAME_AS', 'ASSIGNED_TO'];
      const rel = args['rel'] as string;
      if (!VALID_RELS.includes(rel)) {
        return { isError: true, content: [{ type: 'text', text: `Unknown rel: ${rel}` }] };
      }
      const srcUid = args['src_uid'] as string;
      const dstUid = args['dst_uid'] as string;
      const srcRow = db.prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?').get(srcUid);
      const dstRow = db.prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?').get(dstUid);
      if (!srcRow) {
        return { isError: true, content: [{ type: 'text', text: `src_uid not found: ${srcUid}` }] };
      }
      if (!dstRow) {
        return { isError: true, content: [{ type: 'text', text: `dst_uid not found: ${dstUid}` }] };
      }
      const now = new Date().toISOString();
      const edgeUid = `edge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      db.prepare(
        `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
         SELECT ?, ?, ?, 'user_asserted', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM edge WHERE src=? AND dst=? AND rel=? AND t_expired IS NULL)`,
      ).run(
        srcRow.rowid, dstRow.rowid, rel, now,
        JSON.stringify(args['meta'] ?? {}),
        srcRow.rowid, dstRow.rowid, rel,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify({ edge_uid: edgeUid }) }],
      };
    }

    // ── P4 NEW TOOL HANDLERS ──────────────────────────────────────────────────

    case 'memory_topics': {
      const projectPath = args['project_path'] as string | undefined;
      const search = args['search'] as string | undefined;
      const sortBy = (args['sort_by'] as string | undefined) ?? 'episode_count';
      const limit = Math.min((args['limit'] as number | undefined) ?? 20, 200);
      const offset = (args['offset'] as number | undefined) ?? 0;

      const orderMap: Record<string, string> = {
        episode_count: 'episode_count DESC',
        avg_importance: 'avg_importance DESC',
        last_written: 'last_written DESC',
      };
      const orderClause = orderMap[sortBy] ?? 'episode_count DESC';

      const extraFilters: string[] = [];
      const extraParams: unknown[] = [];

      if (projectPath) {
        extraFilters.push('AND n.project_path = ?');
        extraParams.push(projectPath);
      }
      if (search) {
        extraFilters.push('AND n.topic LIKE ?');
        extraParams.push(`%${search}%`);
      }

      const extraSql = extraFilters.join(' ');

      // Total count
      const countRow = db
        .prepare<unknown[], { cnt: number }>(
          `SELECT COUNT(DISTINCT n.topic) AS cnt
           FROM node n
           WHERE n.kind = 'episode' AND n.t_invalid IS NULL AND n.topic IS NOT NULL
           ${extraSql}`,
        )
        .get(...extraParams);
      const total = countRow?.cnt ?? 0;

      // Per-topic aggregate
      const rows = db
        .prepare<unknown[], {
          topic: string;
          episode_count: number;
          avg_importance: number;
          last_written: string;
        }>(
          `SELECT n.topic AS topic,
                  COUNT(*) AS episode_count,
                  AVG(n.importance) AS avg_importance,
                  MAX(n.t_created) AS last_written
           FROM node n
           WHERE n.kind = 'episode' AND n.t_invalid IS NULL AND n.topic IS NOT NULL
           ${extraSql}
           GROUP BY n.topic
           ORDER BY ${orderClause}
           LIMIT ? OFFSET ?`,
        )
        .all(...extraParams, limit, offset);

      // Enrich each topic with community_uid
      const topics = rows.map((r) => {
        // Find a community uid that has at least one MEMBER_OF member with this topic
        const commRow = db
          .prepare<[string], { uid: string }>(
            `SELECT n2.uid FROM node n1
             JOIN edge e ON e.src = n1.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
             JOIN node n2 ON n2.rowid = e.dst AND n2.kind = 'community' AND n2.t_invalid IS NULL
             WHERE n1.kind = 'episode' AND n1.t_invalid IS NULL AND n1.topic = ?
             LIMIT 1`,
          )
          .get(r.topic);

        return {
          topic: r.topic,
          episode_count: r.episode_count,
          avg_importance: r.avg_importance,
          last_written: r.last_written,
          community_uid: commRow?.uid ?? null,
          has_community: commRow !== undefined,
        };
      });

      return {
        content: [{ type: 'text', text: JSON.stringify({ topics, total }) }],
      };
    }

    case 'memory_list_projects': {
      const limit = Math.min((args['limit'] as number | undefined) ?? 20, 200);
      const offset = (args['offset'] as number | undefined) ?? 0;

      const countRow = db
        .prepare<[], { cnt: number }>(
          `SELECT COUNT(DISTINCT project_path) AS cnt
           FROM node
           WHERE kind = 'episode' AND t_invalid IS NULL AND project_path IS NOT NULL`,
        )
        .get();
      const total = countRow?.cnt ?? 0;

      const rows = db
        .prepare<[number, number], {
          project_path: string;
          episode_count: number;
          last_written: string;
        }>(
          `SELECT project_path, COUNT(*) AS episode_count, MAX(t_created) AS last_written
           FROM node
           WHERE kind = 'episode' AND t_invalid IS NULL AND project_path IS NOT NULL
           GROUP BY project_path
           ORDER BY last_written DESC
           LIMIT ? OFFSET ?`,
        )
        .all(limit, offset);

      return {
        content: [{ type: 'text', text: JSON.stringify({ projects: rows, total }) }],
      };
    }

    case 'memory_list_entities': {
      const projectPath = args['project_path'] as string | undefined;
      const topicFilter = args['topic'] as string | undefined;
      const search = args['search'] as string | undefined;
      const limit = Math.min((args['limit'] as number | undefined) ?? 20, 200);
      const offset = (args['offset'] as number | undefined) ?? 0;

      // Build episode filter for project_path and topic
      const epFilters: string[] = [];
      const epParams: unknown[] = [];
      if (projectPath) {
        epFilters.push('ep.project_path = ?');
        epParams.push(projectPath);
      }
      if (topicFilter) {
        epFilters.push('ep.topic = ?');
        epParams.push(topicFilter);
      }
      const epFilterSql = epFilters.length > 0 ? 'AND ' + epFilters.join(' AND ') : '';

      const nameFilter = search ? 'AND e_node.name LIKE ?' : '';
      if (search) epParams.push(`%${search}%`);

      // Count distinct entities
      const countSql = `
        SELECT COUNT(DISTINCT e_node.rowid) AS cnt
        FROM node e_node
        WHERE e_node.kind = 'entity' AND e_node.t_invalid IS NULL
        ${nameFilter}
        AND EXISTS (
          SELECT 1 FROM edge ment
          JOIN node ep ON ep.rowid = ment.src AND ep.kind = 'episode' AND ep.t_invalid IS NULL
          WHERE ment.dst = e_node.rowid AND ment.rel = 'MENTIONS' AND ment.t_expired IS NULL
          ${epFilterSql}
        )`;

      const countRow = db
        .prepare<unknown[], { cnt: number }>(countSql)
        .get(...epParams);
      const total = countRow?.cnt ?? 0;

      // Fetch entities with mention count and time range
      const rowSql = `
        SELECT e_node.uid,
               e_node.name,
               COUNT(ment.rowid) AS mention_count,
               MIN(ep.t_created)  AS first_seen,
               MAX(ep.t_created)  AS last_seen
        FROM node e_node
        JOIN edge ment ON ment.dst = e_node.rowid AND ment.rel = 'MENTIONS' AND ment.t_expired IS NULL
        JOIN node ep   ON ep.rowid = ment.src AND ep.kind = 'episode' AND ep.t_invalid IS NULL
        WHERE e_node.kind = 'entity' AND e_node.t_invalid IS NULL
        ${nameFilter}
        ${epFilterSql}
        GROUP BY e_node.rowid
        ORDER BY mention_count DESC
        LIMIT ? OFFSET ?`;

      const rows = db
        .prepare<unknown[], {
          uid: string; name: string | null; mention_count: number;
          first_seen: string; last_seen: string;
        }>(rowSql)
        .all(...epParams, limit, offset);

      const entities = rows.map((r) => ({
        uid: r.uid,
        name: r.name ?? '',
        mention_count: r.mention_count,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({ entities, total }) }],
      };
    }

    case 'memory_entity_episodes': {
      const entityUid = args['entity_uid'] as string | undefined;
      const entityName = args['entity_name'] as string | undefined;
      const limit = Math.min((args['limit'] as number | undefined) ?? 20, 200);
      const offset = (args['offset'] as number | undefined) ?? 0;

      // Resolve entity uid
      let resolvedEntityUid = entityUid;
      let resolvedEntityName = '';

      if (!resolvedEntityUid && entityName) {
        // Case-insensitive exact match (OQ-2: return error on ambiguity)
        const matchRows = db
          .prepare<[string], { uid: string; name: string }>(
            `SELECT uid, name FROM node WHERE kind = 'entity' AND LOWER(name) = LOWER(?) AND t_invalid IS NULL`,
          )
          .all(entityName);
        if (matchRows.length === 0) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', entity_name: entityName }) }],
          };
        }
        if (matchRows.length > 1) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ code: 'E_AMBIGUOUS', entity_name: entityName, candidates: matchRows.map((r) => r.uid) }) }],
          };
        }
        resolvedEntityUid = matchRows[0]!.uid;
        resolvedEntityName = matchRows[0]!.name ?? entityName;
      }

      if (!resolvedEntityUid) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code: 'E_MISSING_INPUT', message: 'Supply entity_uid or entity_name' }) }],
        };
      }

      // Fetch entity name if not already resolved
      if (!resolvedEntityName) {
        const nameRow = db
          .prepare<[string], { name: string | null }>(`SELECT name FROM node WHERE uid = ? LIMIT 1`)
          .get(resolvedEntityUid);
        resolvedEntityName = nameRow?.name ?? resolvedEntityUid;
      }

      const entityRow = db
        .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ? LIMIT 1`)
        .get(resolvedEntityUid);

      if (!entityRow) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', entity_uid: resolvedEntityUid }) }],
        };
      }

      const countRow = db
        .prepare<[number], { cnt: number }>(
          `SELECT COUNT(*) AS cnt
           FROM edge e
           JOIN node ep ON ep.rowid = e.src AND ep.kind = 'episode' AND ep.t_invalid IS NULL
           WHERE e.dst = ? AND e.rel = 'MENTIONS' AND e.t_expired IS NULL`,
        )
        .get(entityRow.rowid);
      const total = countRow?.cnt ?? 0;

      const rows = db
        .prepare<[number, number, number], {
          rowid: number; uid: string; content: string | null; summary: string | null;
          topic: string | null; tags: string | null; project_path: string | null;
          importance: number; t_created: string; agent_id: string | null;
          t_invalid: string | null;
        }>(
          `SELECT ep.rowid, ep.uid, ep.content, ep.summary, ep.topic, ep.tags, ep.project_path,
                  ep.importance, ep.t_created, ep.agent_id, ep.t_invalid
           FROM edge e
           JOIN node ep ON ep.rowid = e.src AND ep.kind = 'episode' AND ep.t_invalid IS NULL
           WHERE e.dst = ? AND e.rel = 'MENTIONS' AND e.t_expired IS NULL
           ORDER BY ep.importance DESC
           LIMIT ? OFFSET ?`,
        )
        .all(entityRow.rowid, limit, offset);

      const episodes = rows.map((r) => ({
        uid: r.uid,
        content: r.content,
        summary: r.summary ?? null,
        topic: r.topic ?? null,
        tags: parseTags(r.tags),
        project_path: r.project_path ?? null,
        importance: r.importance,
        t_created: r.t_created,
        agent_id: r.agent_id ?? null,
        is_superseded: isSuperseded(db, r.rowid),
        supersedes_uid: supersedesUidForRowid(db, r.rowid),
        community_uid: communityUidForRowid(db, r.rowid),
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({
          entity: { uid: resolvedEntityUid, name: resolvedEntityName },
          episodes,
          total,
        }) }],
      };
    }

    case 'memory_related': {
      const uid = args['uid'] as string;
      const relFilter = args['rel'] as string[] | undefined;
      const limit = Math.min((args['limit'] as number | undefined) ?? 20, 100);

      const sourceRow = db
        .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ? LIMIT 1`)
        .get(uid);

      if (!sourceRow) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', uid }) }],
        };
      }

      // Build rel IN clause
      const relClause = relFilter && relFilter.length > 0
        ? `AND e.rel IN (${relFilter.map(() => '?').join(',')})`
        : '';
      const relParams = relFilter && relFilter.length > 0 ? relFilter : [];

      // Outbound edges (src = source)
      const outRows = db
        .prepare<unknown[], {
          rowid: number; uid: string; content: string | null; summary: string | null;
          topic: string | null; tags: string | null; project_path: string | null;
          importance: number; t_created: string; agent_id: string | null;
          t_invalid: string | null; rel: string; weight: number | null;
        }>(
          `SELECT n.rowid, n.uid, n.content, n.summary, n.topic, n.tags, n.project_path,
                  n.importance, n.t_created, n.agent_id, n.t_invalid,
                  e.rel, e.weight
           FROM edge e
           JOIN node n ON n.rowid = e.dst AND n.t_invalid IS NULL
           WHERE e.src = ? AND e.t_expired IS NULL ${relClause}
           LIMIT ?`,
        )
        .all(sourceRow.rowid, ...relParams, limit);

      // Inbound edges (dst = source)
      const inRows = db
        .prepare<unknown[], {
          rowid: number; uid: string; content: string | null; summary: string | null;
          topic: string | null; tags: string | null; project_path: string | null;
          importance: number; t_created: string; agent_id: string | null;
          t_invalid: string | null; rel: string; weight: number | null;
        }>(
          `SELECT n.rowid, n.uid, n.content, n.summary, n.topic, n.tags, n.project_path,
                  n.importance, n.t_created, n.agent_id, n.t_invalid,
                  e.rel, e.weight
           FROM edge e
           JOIN node n ON n.rowid = e.src AND n.t_invalid IS NULL
           WHERE e.dst = ? AND e.t_expired IS NULL ${relClause}
           LIMIT ?`,
        )
        .all(sourceRow.rowid, ...relParams, limit);

      const toEdge = (r: typeof outRows[0], direction: 'outbound' | 'inbound') => ({
        episode: {
          uid: r.uid,
          content: r.content,
          summary: r.summary ?? null,
          topic: r.topic ?? null,
          tags: parseTags(r.tags),
          project_path: r.project_path ?? null,
          importance: r.importance,
          t_created: r.t_created,
          agent_id: r.agent_id ?? null,
          is_superseded: isSuperseded(db, r.rowid),
          supersedes_uid: supersedesUidForRowid(db, r.rowid),
          community_uid: communityUidForRowid(db, r.rowid),
        },
        rel: r.rel,
        weight: r.weight ?? 1.0,
        direction,
      });

      const edges = [
        ...outRows.map((r) => toEdge(r, 'outbound')),
        ...inRows.map((r) => toEdge(r, 'inbound')),
      ].slice(0, limit);

      return {
        content: [{ type: 'text', text: JSON.stringify({ source_uid: uid, edges }) }],
      };
    }

    case 'memory_supersession_chain': {
      const uid = args['uid'] as string;

      // Walk the SUPERSEDES edges to build the full chain.
      // Edge convention (from memory_invalidate): new.rowid → old.rowid with rel=SUPERSEDES.
      // So "uid_a supersedes uid_b" = edge: src=uid_a, dst=uid_b.

      const allRows = new Map<string, { uid: string; t_created: string; t_invalid: string | null }>();

      // Collect all nodes in the chain via BFS from the given uid
      const queue: string[] = [uid];
      const visited = new Set<string>();

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);

        const row = db
          .prepare<[string], { uid: string; t_created: string; t_invalid: string | null; rowid: number }>(
            `SELECT uid, t_created, t_invalid, rowid FROM node WHERE uid = ? LIMIT 1`,
          )
          .get(current);
        if (!row) continue;

        allRows.set(current, { uid: row.uid, t_created: row.t_created, t_invalid: row.t_invalid });

        // What does this episode supersede? (outbound SUPERSEDES edge)
        const supersededRows = db
          .prepare<[number], { uid: string }>(
            `SELECT n.uid FROM edge e JOIN node n ON n.rowid = e.dst WHERE e.src = ? AND e.rel = 'SUPERSEDES'`,
          )
          .all(row.rowid);
        for (const s of supersededRows) queue.push(s.uid);

        // What supersedes this episode? (inbound SUPERSEDES edge — src supersedes this)
        const supersederRows = db
          .prepare<[number], { uid: string }>(
            `SELECT n.uid FROM edge e JOIN node n ON n.rowid = e.src WHERE e.dst = ? AND e.rel = 'SUPERSEDES'`,
          )
          .all(row.rowid);
        for (const s of supersederRows) queue.push(s.uid);
      }

      // Build ordered chain oldest-first (by t_created)
      const chain = [...allRows.values()].sort(
        (a, b) => new Date(a.t_created).getTime() - new Date(b.t_created).getTime(),
      );

      // Canonical = most recent non-invalidated node, or latest by t_created
      const canonical = chain.find((n) => n.t_invalid === null) ?? chain[chain.length - 1]!;

      // Fetch reason strings from SUPERSEDES edge metas
      const chainWithReasons = chain.map((n) => {
        // Reason is on the inbound SUPERSEDES edge meta (the edge that made this node superseded)
        const edgeRow = db
          .prepare<[string], { meta: string | null }>(
            `SELECT e.meta FROM edge e
             JOIN node src ON src.rowid = e.src
             JOIN node dst ON dst.rowid = e.dst
             WHERE dst.uid = ? AND e.rel = 'SUPERSEDES'
             LIMIT 1`,
          )
          .get(n.uid);
        let reason: string | null = null;
        if (edgeRow?.meta) {
          try {
            const m = JSON.parse(edgeRow.meta) as { reason?: string };
            reason = m.reason ?? null;
          } catch { /* malformed */ }
        }
        return {
          uid: n.uid,
          t_created: n.t_created,
          t_invalid: n.t_invalid,
          reason,
        };
      });

      return {
        content: [{ type: 'text', text: JSON.stringify({
          canonical_uid: canonical.uid,
          chain: chainWithReasons,
          is_current: canonical.uid === uid,
        }) }],
      };
    }

    case 'memory_near_duplicates': {
      const projectPath = args['project_path'] as string | undefined;
      const topicFilter = args['topic'] as string | undefined;
      const cosineThreshold = args['threshold'] as number | undefined;
      const limit = Math.min((args['limit'] as number | undefined) ?? 20, 200);
      const offset = (args['offset'] as number | undefined) ?? 0;

      // Find SAME_AS edges
      const extraFilters: string[] = [];
      const extraParams: unknown[] = [];

      if (projectPath) {
        extraFilters.push('(na.project_path = ? OR nb.project_path = ?)');
        extraParams.push(projectPath, projectPath);
      }
      if (topicFilter) {
        extraFilters.push('(na.topic = ? OR nb.topic = ?)');
        extraParams.push(topicFilter, topicFilter);
      }
      if (typeof cosineThreshold === 'number') {
        extraFilters.push('CAST(json_extract(e.meta, \'$.cosine_sim\') AS REAL) >= ?');
        extraParams.push(cosineThreshold);
      }

      const extraSql = extraFilters.length > 0 ? 'AND ' + extraFilters.join(' AND ') : '';

      const countRow = db
        .prepare<unknown[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt
           FROM edge e
           JOIN node na ON na.rowid = e.src
           JOIN node nb ON nb.rowid = e.dst
           WHERE e.rel = 'SAME_AS' AND e.t_expired IS NULL
             AND na.kind = 'episode' AND nb.kind = 'episode'
           ${extraSql}`,
        )
        .get(...extraParams);
      const total = countRow?.cnt ?? 0;

      const rows = db
        .prepare<unknown[], {
          uid_a: string; uid_b: string;
          content_a: string | null; content_b: string | null;
          invalid_b: string | null; meta: string | null;
        }>(
          `SELECT na.uid AS uid_a, nb.uid AS uid_b,
                  na.content AS content_a, nb.content AS content_b,
                  nb.t_invalid AS invalid_b,
                  e.meta
           FROM edge e
           JOIN node na ON na.rowid = e.src
           JOIN node nb ON nb.rowid = e.dst
           WHERE e.rel = 'SAME_AS' AND e.t_expired IS NULL
             AND na.kind = 'episode' AND nb.kind = 'episode'
           ${extraSql}
           LIMIT ? OFFSET ?`,
        )
        .all(...extraParams, limit, offset);

      const pairs = rows.map((r) => {
        let cosineSim = 0;
        if (r.meta) {
          try {
            const m = JSON.parse(r.meta) as { cosine_sim?: number };
            cosineSim = m.cosine_sim ?? 0;
          } catch { /* malformed */ }
        }
        return {
          uid_a: r.uid_a,
          uid_b: r.uid_b,
          cosine_sim: cosineSim,
          content_preview_a: (r.content_a ?? '').slice(0, 120),
          content_preview_b: (r.content_b ?? '').slice(0, 120),
          already_merged: r.invalid_b !== null,
        };
      });

      return {
        content: [{ type: 'text', text: JSON.stringify({ pairs, total }) }],
      };
    }

    case 'memory_curate': {
      const op = args['op'] as string;
      const dryRun = args['dry_run'] === true;
      const now = new Date().toISOString();

      switch (op) {
        case 'retag': {
          const uid = args['uid'] as string | undefined;
          const newTags = args['tags'] as string[] | undefined;
          if (!uid) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_MISSING', message: 'uid required for retag' }) }] };
          }

          const row = db
            .prepare<[string], { rowid: number; tags: string | null }>(
              `SELECT rowid, tags FROM node WHERE uid = ? AND t_invalid IS NULL LIMIT 1`,
            )
            .get(uid);
          if (!row) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', uid }) }] };
          }

          const existingTags = parseTags(row.tags);
          const tagsToAdd = (newTags ?? []).filter((t) => !existingTags.includes(t));
          const mergedTags = [...existingTags, ...tagsToAdd];

          const newEntityUids: string[] = [];
          if (!dryRun) {
            db.transaction(() => {
              db.prepare(`UPDATE node SET tags = ? WHERE uid = ?`).run(
                JSON.stringify(mergedTags), uid,
              );
              // Add new entity nodes + MENTIONS edges for new tags
              for (const tag of tagsToAdd) {
                const tagName = tag.trim();
                if (!tagName) continue;
                const existing = db
                  .prepare<[string], { rowid: number; uid: string }>(
                    `SELECT rowid, uid FROM node WHERE kind = 'entity' AND name = ? AND t_invalid IS NULL`,
                  )
                  .get(tagName);
                let entityRowid: number;
                let entityUid: string;
                if (existing) {
                  entityRowid = existing.rowid;
                  entityUid = existing.uid;
                } else {
                  entityUid = ulid();
                  const ins = db
                    .prepare<unknown[], { rowid: number }>(
                      `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'entity', ?, ?, ?) RETURNING rowid`,
                    )
                    .get(entityUid, tagName, now, now);
                  if (!ins) continue;
                  entityRowid = ins.rowid;
                  newEntityUids.push(entityUid);
                }
                db.prepare(
                  `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
                   SELECT ?, ?, 'MENTIONS', 'user_asserted', ?, '{}'
                   WHERE NOT EXISTS (SELECT 1 FROM edge WHERE src=? AND dst=? AND rel='MENTIONS' AND t_expired IS NULL)`,
                ).run(row.rowid, entityRowid, now, row.rowid, entityRowid);
              }
            })();
          }

          return {
            content: [{ type: 'text', text: JSON.stringify({ op: 'retag', uid, tags_added: tagsToAdd, new_entity_uids: newEntityUids }) }],
          };
        }

        case 'set_topic': {
          const uid = args['uid'] as string | undefined;
          const newTopic = args['topic'] as string | undefined;
          if (!uid || !newTopic) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_MISSING', message: 'uid and topic required for set_topic' }) }] };
          }
          const row = db
            .prepare<[string], { topic: string | null }>(
              `SELECT topic FROM node WHERE uid = ? AND t_invalid IS NULL LIMIT 1`,
            )
            .get(uid);
          if (row === undefined) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', uid }) }] };
          }
          const oldTopic = row.topic ?? null;
          if (!dryRun) {
            db.prepare(`UPDATE node SET topic = ? WHERE uid = ?`).run(newTopic, uid);
          }
          return {
            content: [{ type: 'text', text: JSON.stringify({ op: 'set_topic', uid, old_topic: oldTopic, new_topic: newTopic }) }],
          };
        }

        case 'set_importance': {
          const uid = args['uid'] as string | undefined;
          const newImportance = args['importance'] as number | undefined;
          if (!uid || newImportance === undefined) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_MISSING', message: 'uid and importance required for set_importance' }) }] };
          }
          const row = db
            .prepare<[string], { importance: number }>(
              `SELECT importance FROM node WHERE uid = ? AND t_invalid IS NULL LIMIT 1`,
            )
            .get(uid);
          if (row === undefined) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', uid }) }] };
          }
          const oldImportance = row.importance;
          if (!dryRun) {
            // Mark enrich_ver.note=user_override so batch enricher skips re-scoring
            const enrichVer = JSON.stringify({ pass: ENRICH_VERSION, ts: now, note: 'user_override' });
            db.prepare(`UPDATE node SET importance = ?, enrich_ver = ? WHERE uid = ?`).run(newImportance, enrichVer, uid);
          }
          return {
            content: [{ type: 'text', text: JSON.stringify({ op: 'set_importance', uid, old_importance: oldImportance, new_importance: newImportance }) }],
          };
        }

        case 'merge_duplicates': {
          const uidKeep = args['uid_keep'] as string | undefined;
          const uidDrop = args['uid_drop'] as string | undefined;
          if (!uidKeep || !uidDrop) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_MISSING', message: 'uid_keep and uid_drop required for merge_duplicates' }) }] };
          }

          const keepRow = db.prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ? LIMIT 1`).get(uidKeep);
          const dropRow = db.prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ? LIMIT 1`).get(uidDrop);

          if (!keepRow) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', uid: uidKeep }) }] };
          if (!dropRow) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', uid: uidDrop }) }] };

          const sameAsEdgeUid = `same-${Date.now()}`;
          if (!dryRun) {
            db.transaction(() => {
              // Invalidate the dropped episode
              db.prepare(`UPDATE node SET t_invalid = ? WHERE uid = ?`).run(now, uidDrop);
              // Insert SAME_AS edge from keep → drop
              db.prepare(
                `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
                 SELECT ?, ?, 'SAME_AS', 'user_asserted', ?, '{"merge":"manual"}'
                 WHERE NOT EXISTS (SELECT 1 FROM edge WHERE src=? AND dst=? AND rel='SAME_AS' AND t_expired IS NULL)`,
              ).run(keepRow.rowid, dropRow.rowid, now, keepRow.rowid, dropRow.rowid);
            })();
          }

          return {
            content: [{ type: 'text', text: JSON.stringify({ op: 'merge_duplicates', uid_kept: uidKeep, uid_dropped: uidDrop, same_as_edge_uid: sameAsEdgeUid, dry_run: dryRun }) }],
          };
        }

        case 'recluster': {
          const filters = args['filters'] as MemoryFilter | Record<string, unknown> | undefined;

          // Filtered recluster: cluster ONLY the subset matching `filters`,
          // synchronously, and return the resulting communities. This is the
          // on-demand "cluster a subset to find synthesis candidates" path.
          // dry_run=true → read-only (no writes); dry_run=false → persist a
          // provenance-scoped community slice that never touches the global
          // partition. The server treats `filters` as opaque graph predicates;
          // it carries no knowledge of what the tags/topics mean.
          //
          // The structured filter is now passed directly to clusterSubset — the
          // engine owns buildFiltersClause and builds the SQL clause internally.
          // This makes @sox/memory-enrich callable without server-private code.
          if (filters && Object.keys(filters).length > 0) {
            const threshold = args['threshold'];
            const res = clusterSubset(db, {
              filter: filters as MemoryFilter,
              persist: !dryRun,
              ...(typeof threshold === 'number' ? { threshold } : {}),
            });
            const clusters = res.clusters.map((c) => ({
              community_uid: c.community_uid,
              label: c.label,
              size: c.member_rowids.length,
              mean_intra_sim: c.mean_intra_sim,
              members: rowidsToUids(db, c.member_rowids),
            }));
            return {
              content: [{ type: 'text', text: JSON.stringify({
                op: 'recluster',
                scope: 'subset',
                dry_run: dryRun,
                persisted: res.persisted,
                provenance_hash: res.provenance_hash,
                candidate_count: res.candidate_count,
                cluster_count: clusters.length,
                unclustered_count: res.unclustered_count,
                full_pass: res.full_pass,
                clusters,
              }) }],
            };
          }

          // Global recluster (unchanged): OQ-3 dry_run means don't enqueue, just report.
          if (dryRun) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ op: 'recluster', enqueued: false, dry_run: true }) }],
            };
          }
          // Enqueue an explicit 'enrich' op so the daemon runs a full batch-enrich pass
          // (re-clusters + re-links the whole store). This wires the previously-dead
          // schema CHECK constraint so 'enrich' rows have a real producer.
          try {
            enqueueEnrich(db);
          } catch {
            // If daemon not available, the cluster can be triggered manually
          }
          return {
            content: [{ type: 'text', text: JSON.stringify({ op: 'recluster', enqueued: true }) }],
          };
        }

        default:
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_UNKNOWN_OP', op }) }] };
      }
    }

    case 'memory_stats': {
      const projectPath = args['project_path'] as string | undefined;

      const ppFilter = projectPath ? 'AND project_path = ?' : '';
      const ppParams = projectPath ? [projectPath] : [];

      const totalRow = db
        .prepare<unknown[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL ${ppFilter}`,
        )
        .get(...ppParams);
      const totalEpisodes = totalRow?.cnt ?? 0;

      const withTopicRow = db
        .prepare<unknown[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND topic IS NOT NULL ${ppFilter}`,
        )
        .get(...ppParams);

      const withSummaryRow = db
        .prepare<unknown[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND summary IS NOT NULL ${ppFilter}`,
        )
        .get(...ppParams);

      const withTagsRow = db
        .prepare<unknown[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND tags IS NOT NULL ${ppFilter}`,
        )
        .get(...ppParams);

      const withProjectPathRow = db
        .prepare<unknown[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND project_path IS NOT NULL ${ppFilter}`,
        )
        .get(...ppParams);

      // with_community: episodes that have a MEMBER_OF edge to a live GLOBAL community.
      // Scoped to kind='global' (or legacy NULL scope) so persisted subset lenses
      // do not inflate this count — it is used as a CI-gate metric (CONTRACTS C2.12).
      const withCommunityRow = db
        .prepare<unknown[], { cnt: number }>(
          `SELECT COUNT(DISTINCT n.rowid) AS cnt
           FROM node n
           JOIN edge e ON e.src = n.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
           JOIN node c ON c.rowid = e.dst AND c.kind = 'community' AND c.t_invalid IS NULL
             AND (json_extract(c.meta, '$.cluster_scope.kind') IS NULL
                  OR json_extract(c.meta, '$.cluster_scope.kind') = 'global')
           WHERE n.kind = 'episode' AND n.t_invalid IS NULL ${ppFilter.replace('AND project_path', 'AND n.project_path')}`,
        )
        .get(...ppParams);

      // Legacy: enrich_ver IS NULL or note = "legacy"
      const legacyRow = db
        .prepare<unknown[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM node
           WHERE kind = 'episode' AND t_invalid IS NULL
             AND (enrich_ver IS NULL
               OR json_extract(enrich_ver, '$.note') = 'legacy')
           ${ppFilter}`,
        )
        .get(...ppParams);

      // Stale: enrich_ver.pass != current ENRICH_VERSION
      const staleRow = db
        .prepare<unknown[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM node
           WHERE kind = 'episode' AND t_invalid IS NULL AND enrich_ver IS NOT NULL
             AND json_extract(enrich_ver, '$.pass') != ?
           ${ppFilter}`,
        )
        .get(ENRICH_VERSION, ...ppParams);

      const qStats = clusterStats(db);

      const embedModel = process.env['SOX_EMBED_BACKEND'] === 'real'
        ? 'onnx/all-MiniLM-L6-v2'
        : 'hash';

      return {
        content: [{ type: 'text', text: JSON.stringify({
          tool_version: '1.1.0',
          enrich_version: ENRICH_VERSION,
          embed_model: embedModel,
          total_episodes: totalEpisodes,
          with_topic: withTopicRow?.cnt ?? 0,
          with_summary: withSummaryRow?.cnt ?? 0,
          with_tags: withTagsRow?.cnt ?? 0,
          with_project_path: withProjectPathRow?.cnt ?? 0,
          with_community: withCommunityRow?.cnt ?? 0,
          legacy_episodes: legacyRow?.cnt ?? 0,
          stale_episodes: staleRow?.cnt ?? 0,
          cluster_count: qStats.cluster_count,
          largest_cluster_size: qStats.largest_cluster_size,
          mean_intra_cluster_sim: qStats.mean_intra_sim,
          coverage: qStats.coverage,
          cluster_quality: qStats,
        }) }],
      };
    }

    default:
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      };
  }
}

const registeredTools = TOOLS.map((tool) =>
  defineTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: (_args, _ctx) => handleToolCall(tool.name, _args),
  }),
);

void serve(registeredTools, { name: 'memory-server', version: '1.1.0' });
