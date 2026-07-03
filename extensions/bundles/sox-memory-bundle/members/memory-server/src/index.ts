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
 * @adhd/sox-host-runtime) because the spawned memory-server is a standalone CommonJS
 * process — @adhd/sox-host-runtime is a private workspace package not available in
 * node_modules at the child's runtime. The implementation matches [shape:policy-env]
 * and the policy-core round-trip contract ([policy-core.4]) exactly; the
 * permission-guard.spec.ts [mcp-path-guard.5] tests verify parity.
 */

import type { ToolDefinition, ToolResult } from '@adhd/sox-mcp-runtime';
import { defineTool, serve } from '@adhd/sox-mcp-runtime';
import {
  buildFiltersClause,
  communityUidForRowid,
  expandTilde,
  getActiveEmbedModel,
  getDb,
  getEmbedState,
  getLastEmbedError,
  memoryCurate,
  memoryGetEntityEpisodes,
  memoryGetNearDuplicates,
  memoryGetRelated,
  memoryGetSessionState,
  memoryGetStats,
  memoryGetSupersessionChain,
  memoryInvalidate,
  memoryLinkNode,
  memoryListEntities,
  memoryListProjects,
  memoryListTopics,
  memoryRecall,
  memorySaveSessionState,
  memorySearchEntities,
  memoryUpdate,
  memoryWrite,
  rowidsToUids,
  runBatchEnrich,
  SOCKET_PATH,
  supersedesUidForRowid,
  warmupEmbed,
  isSuperseded,
} from '@adhd/sox-memory-core';
import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
// ─── ADR-0003: content-addressed self-identity ───────────────────────────────
//
// The server's identity is `id` + the sha256 content address of its RUNNING
// entrypoint artifact — never a hand-typed version. `memory_ping` reports it so a
// human (or CI) asking "what code is actually running?" gets a drift-proof answer.
//
// The running entrypoint is THIS executing file (__filename in the compiled CJS
// bundle = the artifact registry/install pin against). We hash its bytes once and
// memoize. `host_compat` is read from the sibling extension.json (copied next to
// the bundle at install time) when present; otherwise a build-time fallback.

const EXTENSION_ID = 'memory-server';
const HOST_COMPAT_FALLBACK = '>=1.0.0 <2.0.0';

interface ContentAddress {
  id: string;
  artifact: string; // "sha256:<full hex>"
  short: string;    // first 12 hex chars of the digest
  host_compat: string;
}

let _contentAddress: ContentAddress | undefined;

/** Compute (and memoize) the content address of the running entrypoint artifact. */
export function getContentAddress(): ContentAddress {
  if (_contentAddress !== undefined) return _contentAddress;

  // The running artifact: prefer the entry script the process was launched with
  // (process.argv[1], e.g. <storePath>/index.js), falling back to this module's
  // own file. Both resolve to the pinned entrypoint in practice.
  let entry = typeof __filename === 'string' ? __filename : '';
  const argvEntry = process.argv[1];
  if (typeof argvEntry === 'string' && argvEntry.length > 0 && fs.existsSync(argvEntry)) {
    entry = argvEntry;
  }

  let digest = '';
  try {
    const bytes = fs.readFileSync(entry);
    digest = crypto.createHash('sha256').update(bytes).digest('hex');
  } catch {
    // Unreadable artifact (should not happen): degrade to an empty-content hash so
    // the shape stays valid rather than throwing inside a ping.
    digest = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  }

  _contentAddress = {
    id: EXTENSION_ID,
    artifact: `sha256:${digest}`,
    short: digest.slice(0, 12),
    host_compat: readHostCompat(entry),
  };
  return _contentAddress;
}

/** Read compatibility.host from the extension.json sibling of the running artifact. */
function readHostCompat(entry: string): string {
  try {
    const manifestPath = path.join(path.dirname(entry), 'extension.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        compatibility?: { host?: string };
      };
      const host = manifest.compatibility?.host;
      if (typeof host === 'string' && host.length > 0) return host;
    }
  } catch {
    /* fall through to the build-time fallback */
  }
  return HOST_COMPAT_FALLBACK;
}

// ─── Vendored compilePolicyFromEnv — matches [shape:policy-env] ───────────────
//
// This is a minimal, dependency-free re-implementation of the policy-core
// contract ([shape:policy]) sufficient for the spawned child. It is parity-tested
// against the host-runtime version in permission-guard.spec.ts [mcp-path-guard.5].

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

// ─── Active DB paths (tracked for fallback enrichment pass) ────────────────────

const openedPaths = new Set<string>();

export const TOOLS: Array<Omit<ToolDefinition, 'handler'>> = [
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
      'Write a memory episode. Runs deterministic enrichment synchronously (provenance, tags, topic, near-dup, extractive summary). Returns {episode_uid}. Batch enrichments (clustering, auto-links, importance link-score) run asynchronously in the daemon when it is running, or via an in-process fallback interval when the daemon is absent.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The content to memorize. Required.' },
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        summary: { type: 'string', description: '(E2) Human-readable summary. Persisted to node.summary; no extractive fallback runs if supplied.' },
        name: { type: 'string', description: '(E2) Title/name for this episode (node.name).' },
        topic: { type: 'string', description: '(E5) Explicit topic override. Stored to node.topic; takes priority over [<topic>] prefix and cluster label.' },
        tags: { type: 'array', items: { type: 'string' }, description: '(E4) Concept/entity tags. Persisted as node.tags JSON array AND as entity nodes + MENTIONS edges.' },
        metadata: { type: 'object', additionalProperties: true, description: '(E3) Arbitrary caller metadata persisted as node.meta JSON. Queryable via json_extract.' },
        project_path: { type: 'string', description: '(E1) Caller project root path. Auto-detected from cwd+git if omitted.' },
        derived_from_uid: { type: 'string', description: '(E9) UID of a parent episode; emits a DERIVED_FROM edge from this episode to parent.' },
        session_id: { type: 'string' },
        t_occurred: { type: 'string', description: 'ISO timestamp when this occurred.' },
        agent_id: { type: 'string' },
        source: {
          type: 'string',
          enum: ['message', 'tool_output', 'observation', 'document', 'reflection', 'import'],
        },
        importance: { type: 'number', minimum: 1, maximum: 10, description: 'User-asserted importance (1–10). If supplied, batch enricher will not overwrite it.' },
        chunk_size: {
          type: 'number',
          description: 'Approximate tokens per chunk (default: 500). Content exceeding this threshold is split at sentence boundaries; each chunk is stored as a separate episode with a DERIVED_FROM edge to the parent.',
          default: 500,
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_recall',
    description:
      'Recall memories using hybrid vec+BM25+temporal search, filtered by provenance, topic, or tags. query may be omitted for importance-ranked listing. <50ms, zero LLM.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Semantic query text. If absent or empty, returns importance-ranked results (no vec/FTS, sorted by importance DESC).' },
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        scope: { type: 'string', description: 'Store scope name: project/user/org/local.' },
        agent_id: { type: 'string' },
        as_of: { type: 'string', description: 'ISO timestamp for point-in-time recall.' },
        token_budget: { type: 'number', default: 4000 },
        depth: { type: 'number', default: 1 },
        limit: { type: 'number', default: 10 },
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
            topic: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Exact topic string or array of topics (OR semantics).' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Any-match: episodes that have at least one of these tags.' },
            tags_match_all: { type: 'boolean', default: false },
            importance_min: { type: 'number', description: 'Only return episodes with importance >= this value.' },
            t_created_after: { type: 'string', description: 'ISO timestamp; only episodes created after this.' },
            t_created_before: { type: 'string', description: 'ISO timestamp; only episodes created before this.' },
          },
        },
      },
      required: [],
    },
  },
  {
    name: 'memory_search_entities',
    description: 'Search for entities by name/type. Returns matching entity nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        entity_type: { type: 'string' },
        limit: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get_session_state',
    description: 'Get session working memory state.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
      },
      required: ['session_id'],
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
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
      },
      required: ['session_id', 'state'],
    },
  },
  {
    name: 'memory_get_community',
    description: 'Get a community node (embedding-derived cluster) and its members.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        entity_uid: { type: 'string', description: 'Resolve community for this episode/entity UID (via MEMBER_OF edge).' },
        community_uid: { type: 'string', description: 'Fetch a community directly by its UID.' },
        level: { type: 'number', default: 0 },
      },
      required: [],
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
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        t_transition: { type: 'string' },
        replacement_uid: { type: 'string' },
      },
      required: ['claim_uid', 'reason'],
    },
  },
  {
    name: 'memory_update',
    description:
      'In-place editor for an existing live node. Distinct from supersession (which mints a new node). The uid is the required selector and is immutable — it can never change. Updates content, summary, name, topic, tags, importance, metadata (deep-merge by default), t_occurred, and t_valid. t_created is never modified (audit anchor). When content or summary changes, the embedding is refreshed automatically. FTS is auto-synced by the node UPDATE trigger. Returns {uid, updated_fields, reembedded}.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'UID of the live node to update. Required. Error E_NOT_FOUND if absent or invalidated.' },
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        content: { type: 'string', description: 'Replace node.content. Triggers re-embed and FTS update.' },
        summary: { type: 'string', description: 'Replace node.summary. Triggers re-embed and FTS update.' },
        name: { type: 'string', description: 'Replace node.name.' },
        topic: { type: 'string', description: 'Replace node.topic.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replace node.tags (replaces existing tags wholesale — not additive).' },
        importance: { type: 'number', minimum: 1, maximum: 10, description: 'Replace node.importance.' },
        metadata: { type: 'object', additionalProperties: true, description: 'Metadata to merge into (or replace) existing node.meta. See metadata_merge.' },
        metadata_merge: {
          type: 'string',
          enum: ['deep', 'replace'],
          default: 'deep',
          description: "'deep' (default): recursive merge for nested objects; arrays are replaced not concatenated. 'replace': overwrites node.meta wholesale.",
        },
        t_occurred: { type: 'string', description: 'ISO timestamp — replace node.t_occurred.' },
        t_valid: { type: 'string', description: 'ISO timestamp — replace node.t_valid.' },
      },
      required: ['uid'],
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
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        weight: { type: 'number', description: 'Optional edge weight (0–1)' },
        meta: { type: 'object', description: 'Optional JSON metadata' },
      },
      required: ['src_uid', 'dst_uid', 'rel'],
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
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        project_path: { type: 'string', description: 'Filter to topics that have at least one episode from this project_path.' },
        search: { type: 'string', description: 'Partial topic name substring filter.' },
        sort_by: { type: 'string', enum: ['episode_count', 'avg_importance', 'last_written'], default: 'episode_count' },
        limit: { type: 'number', default: 20, maximum: 200 },
        offset: { type: 'number', default: 0 },
      },
      required: [],
    },
  },
  {
    name: 'memory_list_projects',
    description: 'List distinct project_path values present in the store, with episode counts.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        limit: { type: 'number', default: 20, maximum: 200 },
        offset: { type: 'number', default: 0 },
      },
      required: [],
    },
  },
  {
    name: 'memory_list_entities',
    description:
      'List entity nodes ranked by mention count. Use for entity vocabulary discovery. For lookup by name/type, use memory_search_entities.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        project_path: { type: 'string', description: 'Only count episodes from this project_path.' },
        topic: { type: 'string', description: 'Only count episodes in this topic.' },
        search: { type: 'string', description: 'Substring filter on entity name.' },
        limit: { type: 'number', default: 20, maximum: 200 },
        offset: { type: 'number', default: 0 },
      },
      required: [],
    },
  },
  {
    name: 'memory_entity_episodes',
    description:
      'Return episodes that mention a given entity (via MENTIONS edge), ranked by importance.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        entity_uid: { type: 'string', description: 'UID of the entity node.' },
        entity_name: { type: 'string', description: 'Name of the entity (resolved to UID if entity_uid not supplied).' },
        limit: { type: 'number', default: 20, maximum: 200 },
        offset: { type: 'number', default: 0 },
      },
      required: [],
    },
  },
  {
    name: 'memory_related',
    description:
      'Return neighbor episodes of a given episode at depth=1 via graph edges (RELATES_TO, DERIVED_FROM, SUPPORTS, SAME_AS).',
    inputSchema: {
      type: 'object',
      properties: {
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        uid: { type: 'string', description: 'UID of the source episode.' },
        rel: { type: 'array', items: { type: 'string' }, description: 'Filter by relation type(s). Default: all live relation types.' },
        limit: { type: 'number', default: 20, maximum: 100 },
      },
      required: ['uid'],
    },
  },
  {
    name: 'memory_supersession_chain',
    description:
      'Return the supersession chain for an episode: what it supersedes and what supersedes it.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        uid: { type: 'string', description: 'Any episode UID in the chain.' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'memory_near_duplicates',
    description:
      'List near-duplicate episode pairs connected by SAME_AS edges. Use for manual deduplication review.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        project_path: { type: 'string' },
        topic: { type: 'string' },
        threshold: { type: 'number', description: 'Minimum cosine similarity stored in the SAME_AS edge meta.' },
        limit: { type: 'number', default: 20, maximum: 200 },
        offset: { type: 'number', default: 0 },
      },
      required: [],
    },
  },
  {
    name: 'memory_curate',
    description:
      'Curation operations: retag, set topic, override importance, merge near-duplicates, or trigger a (optionally filtered) re-cluster pass.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        op: {
          type: 'string',
          enum: ['retag', 'set_topic', 'set_importance', 'merge_duplicates', 'recluster', 'drop_lens', 'list_lenses'],
          description: 'The curation operation to perform. drop_lens removes a persisted subset lens by provenance_hash. list_lenses returns all live subset lenses.',
        },
        uid: { type: 'string', description: 'Target episode UID (required for retag, set_topic, set_importance).' },
        tags: { type: 'array', items: { type: 'string' }, description: '(retag) Tags to add. Additive; duplicates are ignored.' },
        topic: { type: 'string', description: '(set_topic) New topic string.' },
        importance: { type: 'number', minimum: 1, maximum: 10, description: '(set_importance) User-asserted importance.' },
        uid_keep: { type: 'string', description: '(merge_duplicates) UID of the episode to keep.' },
        uid_drop: { type: 'string', description: '(merge_duplicates) UID of the episode to invalidate.' },
        filters: { type: 'object', description: '(recluster) Restrict clustering to the matching subset of episodes. Same filter vocabulary as memory_recall: project_path, topic, tags, tags_match_all, importance_min, t_created_after/before. When present, recluster runs SYNCHRONOUSLY over the subset and returns the resulting communities. Combined with dry_run: dry_run=true returns communities without writing; dry_run=false persists them as a provenance-scoped community slice that leaves the global partition untouched. Absent: global async re-cluster via the daemon (unchanged).' },
        threshold: { type: 'number', description: '(recluster, filtered) Optional cosine similarity threshold override for the subset pass.' },
        provenance_hash: { type: 'string', description: '(drop_lens) The 16-hex provenance hash of the subset lens to drop (obtain from a prior recluster response).' },
        dry_run: { type: 'boolean', default: false, description: 'If true, return proposed changes without committing them.' },
      },
      required: ['op'],
    },
  },
  {
    name: 'memory_stats',
    description:
      'Return enrichment coverage and cluster quality statistics. Use for health checks and CI gates. Returns a `tools` capability list (tool-name presence) — to identify the running code, call memory_ping (content-addressed sha256).',
    inputSchema: {
      type: 'object',
      properties: {
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        project_path: { type: 'string', description: 'Scope stats to episodes from this project.' },
      },
      required: [],
    },
  },
];

/**
 * ADR-0003 Decision 5: the set of registered tool NAMES — the capability surface.
 * Clients test for the capability they need (e.g. `tools.includes('memory_update')`)
 * instead of inferring it from a `tool_version` semver. Reported by `memory_stats`.
 */
const TOOL_NAMES: string[] = TOOLS.map((t) => t.name);


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

// rowidsToUids, communityUidForRowid, supersedesUidForRowid, isSuperseded,
// buildFiltersClause are imported from @adhd/sox-memory-core above.

/**
 * BL-55: the canonical single memory store. Used when neither a per-call `db_path`
 * arg nor the host-injected bundle config (`SOX_CONFIG_DB_PATH`) supplies a path.
 */
export const DEFAULT_DB_PATH = '~/.memory/memory.db';

/**
 * BL-55: resolve the effective `db_path` for a tool call. `db_path` is OPTIONAL on
 * every tool; callers should normally omit it. Precedence:
 *   1. explicit caller arg (per-call override),
 *   2. the bundle config property the host injects as `SOX_CONFIG_DB_PATH`
 *      (cascade-resolved from `config.memory-server.db_path`; see buildExtConfigEnv),
 *   3. the canonical default store (DEFAULT_DB_PATH).
 * Empty / whitespace-only values fall through so a blank arg or config never wins.
 * The result is NOT trusted blindly — handleToolCall still validates it against the
 * `~/.memory/**` fs allowlist via the permission guard before any db is opened, so a
 * bad override is denied loudly rather than silently routed to an empty store.
 */
export function resolveDbPath(argDbPath: unknown): string {
  const fromArg = typeof argDbPath === 'string' ? argDbPath.trim() : '';
  if (fromArg) return fromArg;
  const fromConfig = (process.env['SOX_CONFIG_DB_PATH'] ?? '').trim();
  if (fromConfig) return fromConfig;
  return DEFAULT_DB_PATH;
}

export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  // memory_ping: no db_path needed — handled before the db_path guard.
  // ADR-0003 Decision 5: report the running server's CONTENT ADDRESS — the
  // drift-proof answer to "what code is this?" — instead of a hand-typed version.
  if (name === 'memory_ping') {
    const addr = getContentAddress();
    // BL-48/BL-54: report the resolved embed backend so callers can detect hash-fallback
    // without reading stderr. BL-54: the embed worker warms LAZILY — getActiveEmbedModel()
    // returns the default hash id until the first embed completes, so a fresh server (zero
    // embeds) would FALSELY report embed_on_hash_fallback:true. getEmbedState() fixes this
    // by distinguishing 'uninitialized' (no embed yet) from a real 'hash' fallback. A
    // health check must therefore read embed_state, not embed_model, before the first embed.
    const pingEmbedModel = getActiveEmbedModel();
    const pingConfiguredBackend = process.env['SOX_EMBED_BACKEND'] ?? 'auto';
    const pingEmbedState = getEmbedState();
    const pingOnHashFallback =
      pingConfiguredBackend !== 'hash' && pingEmbedState === 'hash';
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          id: addr.id,
          artifact: addr.artifact,
          short: addr.short,
          host_compat: addr.host_compat,
          embed_model: pingEmbedModel,
          embed_backend_configured: pingConfiguredBackend,
          embed_state: pingEmbedState,
          embed_on_hash_fallback: pingOnHashFallback,
          // BL-89: the real-backend failure cause (worker spawn/init/timeout), so a
          // hash downgrade is diagnosable from the health check, not just stderr.
          last_embed_error: getLastEmbedError(),
        }),
      }],
    };
  }

  // BL-55: db_path is OPTIONAL — resolved via resolveDbPath (arg → bundle config →
  // canonical default). Still validated against the fs allowlist by the guard below.
  const rawDbPath = resolveDbPath(args['db_path']);

  // BL-41: expand a leading `~`/`~/` to $HOME ONCE, here, so the permission guard,
  // the connection cache (getDb), and the resource sink (openDb) all operate on the
  // SAME resolved path. The skill docs show `db_path: "~/.memory/memory.db"` verbatim;
  // without this single expansion the cache keyed on the raw `~` string and openDb
  // would mkdirSync a literal `~` directory relative to cwd. expandTilde mirrors
  // memory-core's expandDbPath byte-for-byte (parity: permission-guard.spec.ts).
  const dbPath = expandTilde(rawDbPath);

  // [ref:guard-before-sink]: policy guard runs BEFORE getDb/openDb.
  // openDb does mkdirSync then opens — so the guard must precede the sink so
  // that no directory or file is created at an undeclared path on denial.
  // ([mcp-path-guard.1], [mcp-path-guard.3])
  const denied = checkDbPathPolicy(dbPath);
  if (denied) return denied;

  const db = getDb(dbPath);
  openedPaths.add(dbPath);

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
      const result = memorySearchEntities(db, {
        query: args['query'] as string,
        entity_type: args['entity_type'] as string | undefined,
        limit: (args['limit'] as number) ?? 10,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_get_session_state': {
      const result = await memoryGetSessionState(db, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_save_session_state': {
      const result = await memorySaveSessionState(db, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_get_community': {
      const entityUid = args['entity_uid'] as string | undefined;
      const communityUidArg = args['community_uid'] as string | undefined;
      const level = (args['level'] as number) ?? 0;

      if (!entityUid && !communityUidArg) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code: 'E_MISSING_INPUT', message: 'Supply entity_uid or community_uid' }) }],
        };
      }
      if (entityUid && communityUidArg) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code: 'E_AMBIGUOUS', message: 'Supply entity_uid OR community_uid, not both' }) }],
        };
      }

      // Resolve community rowid
      let commUid: string;
      if (communityUidArg) {
        commUid = communityUidArg;
      } else {
        const viaMemberOf = db
          .prepare<[number, string], { uid: string }>(
            `SELECT n2.uid FROM node n1
             JOIN edge e ON e.src = n1.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
             JOIN node n2 ON n2.rowid = e.dst AND n2.kind = 'community' AND n2.level = ? AND n2.t_invalid IS NULL
               AND (json_extract(n2.meta, '$.cluster_scope.kind') IS NULL
                    OR json_extract(n2.meta, '$.cluster_scope.kind') = 'global')
             WHERE n1.uid = ? AND n1.t_invalid IS NULL
             LIMIT 1`,
          )
          .get(level, entityUid!);
        if (!viaMemberOf) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', entity_uid: entityUid }) }] };
        }
        commUid = viaMemberOf.uid;
      }

      const commRow = db
        .prepare<[string], { rowid: number; uid: string; name: string | null; meta: string | null; t_created: string }>(
          `SELECT rowid, uid, name, meta, t_created FROM node
           WHERE uid = ? AND kind = 'community' AND t_invalid IS NULL`,
        )
        .get(commUid);
      if (!commRow) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', ...(communityUidArg ? { community_uid: communityUidArg } : { entity_uid: entityUid }) }) }],
        };
      }

      let memberCount = 0;
      let meanIntraSim = 0;
      if (commRow.meta) {
        try {
          const m = JSON.parse(commRow.meta) as { mean_intra_sim?: number; member_count?: number };
          if (typeof m.mean_intra_sim === 'number') meanIntraSim = m.mean_intra_sim;
          if (typeof m.member_count === 'number') memberCount = m.member_count;
        } catch { /* malformed */ }
      }

      const members = db
        .prepare<[number], { uid: string; name: string | null; summary: string | null; topic: string | null; importance: number; t_created: string; project_path: string | null; tags: string | null }>(
          `SELECT n.uid, n.name, n.summary, n.topic, n.importance, n.t_created, n.project_path, n.tags
           FROM edge e
           JOIN node n ON n.rowid = e.src
           WHERE e.dst = ? AND e.rel = 'MEMBER_OF'
             AND e.t_invalid IS NULL AND n.t_invalid IS NULL
           ORDER BY n.importance DESC`,
        )
        .all(commRow.rowid);
      if (memberCount === 0) memberCount = members.length;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            community: {
              uid: commRow.uid,
              label: commRow.name ?? commRow.uid,
              member_count: memberCount,
              mean_intra_sim: meanIntraSim,
              centroid_episode_uid: '',
              t_created: commRow.t_created,
            },
            members: members.map((m) => ({
              uid: m.uid,
              summary: m.summary ?? null,
              topic: m.topic ?? null,
              importance: m.importance,
              t_created: m.t_created,
              project_path: m.project_path ?? null,
              tags: (() => { try { return m.tags ? JSON.parse(m.tags) as string[] : []; } catch { return []; } })(),
            })),
          }),
        }],
      };
    }

    case 'memory_invalidate': {
      const result = memoryInvalidate(db, {
        claim_uid: args['claim_uid'] as string,
        reason: args['reason'] as string,
        t_transition: args['t_transition'] as string | undefined,
        replacement_uid: args['replacement_uid'] as string | undefined,
      });
      if ('code' in result) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_update': {
      const uid = args['uid'] as string | undefined;
      if (!uid) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_MISSING', message: 'uid is required' }) }] };
      }
      const updateResult = await memoryUpdate(db, {
        uid,
        content: args['content'] as string | undefined,
        summary: args['summary'] as string | undefined,
        name: args['name'] as string | undefined,
        topic: args['topic'] as string | undefined,
        tags: args['tags'] as string[] | undefined,
        importance: args['importance'] as number | undefined,
        metadata: args['metadata'] as Record<string, unknown> | undefined,
        metadata_merge: args['metadata_merge'] as 'deep' | 'replace' | undefined,
        t_occurred: args['t_occurred'] as string | undefined,
        t_valid: args['t_valid'] as string | undefined,
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
      const result = await memoryLinkNode(db, args);
      if (result.isError) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    // ── P4 NEW TOOL HANDLERS ──────────────────────────────────────────────────

    case 'memory_topics': {
      const result = memoryListTopics(db, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_list_projects': {
      const result = memoryListProjects(db, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_list_entities': {
      const result = await memoryListEntities(db, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_entity_episodes': {
      const result = await memoryGetEntityEpisodes(db, args);
      if (result.code) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_related': {
      const result = await memoryGetRelated(db, args);
      if (result.code) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_supersession_chain': {
      const result = await memoryGetSupersessionChain(db, args);
      if (result.code) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_near_duplicates': {
      const result = await memoryGetNearDuplicates(db, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_curate': {
      const result = await memoryCurate(db, args);
      if ('code' in result) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_stats': {
      const result = await memoryGetStats(db, args, TOOL_NAMES);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
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

// ── BL-47: in-process fallback enrichment loop ────────────────────────────────
//
// When the memory-daemon service (memory-daemon) is absent (its Unix socket at
// SOCKET_PATH is not connectable), batch enrichment never runs — clustering,
// auto-links, importance, and topic backfill are silently skipped. This fallback
// runs the enrichment loop IN the MCP server process on a periodic interval so
// enrichment is not permanently dead when the daemon is down.
//
// Guard: before each pass we probe SOCKET_PATH. If the daemon IS reachable, we
// skip the fallback pass — the daemon owns the batch loop in that case. This
// prevents double-runs when both are active.
//
// The fallback uses incremental clustering (no full O(n²) pass) to keep each
// pass fast. A full re-cluster is available via memory_curate recluster.
//
// The loop is debounced: if a pass is already running (blocking the event loop
// via synchronous better-sqlite3), the timer fires after it completes naturally.
//
// This fallback iterates over ALL open DB connections in dbCache so enrichment
// runs for every db_path that has been actively used this session.

const FALLBACK_ENRICH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between passes

/** Returns true when the memory-daemon socket is reachable (daemon is up). */
function isDaemonReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(SOCKET_PATH)) {
      resolve(false);
      return;
    }
    const conn = net.createConnection(SOCKET_PATH);
    const timer = setTimeout(() => {
      conn.destroy();
      resolve(false);
    }, 200);
    conn.on('connect', () => {
      clearTimeout(timer);
      conn.destroy();
      resolve(true);
    });
    conn.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Run one in-process incremental enrichment pass over all open DBs. */
async function runFallbackEnrichPass(): Promise<void> {
  if (openedPaths.size === 0) return;

  const daemonUp = await isDaemonReachable();
  if (daemonUp) {
    // Daemon is alive — it owns the batch loop. Do not double-run.
    return;
  }

  for (const dbPath of openedPaths) {
    try {
      const db = getDb(dbPath);
      const result = runBatchEnrich(db, { incrementalCluster: true });
      console.error(
        `[memory-server] fallback enrich (daemon absent, ${dbPath}):` +
        ` communities=${result.communities_upserted}` +
        ` importance_updated=${result.importance_updated}` +
        ` relates_to=${result.relates_to_edges}`,
      );
    } catch (err) {
      // Log to stderr only — never stdout (JSON-RPC channel).
      console.error(`[memory-server] fallback enrich error (${dbPath}):`, err);
    }
  }
}

// Schedule the fallback loop. unref() keeps the timer from holding the process
// open past MCP client disconnect — the server exits cleanly on stdin close.
const _fallbackTimer = setInterval(() => {
  void runFallbackEnrichPass();
}, FALLBACK_ENRICH_INTERVAL_MS);
_fallbackTimer.unref();

// ── Entrypoint dispatch: backend mode vs direct-stdio (spec §9.5) ─────────────
//
// memory-server has two run modes:
//
//   1. BACKEND mode (SOX_PROXY_BACKEND=1) — the DEFAULT under the front-shim
//      service-proxy. This process is a persistent, sox-owned UDS backend holding
//      the real tool implementation; the thin stdio shim (`soxe serve`) proxies
//      tools/call to it. Upgrades = a rolling restart of THIS backend behind the
//      shim, with NO client reconnect (§9.5.2). The shim passes the socket +
//      schema paths via env (it derived them from the [def:singleton-key]).
//
//   2. DIRECT-STDIO mode (default when SOX_PROXY_BACKEND is unset) — the original
//      M3 path: this process IS the MCP server over the client's stdio pipe. This
//      is the opt-out escape hatch (serve_mode:"direct" / --no-proxy) AND the
//      standalone/dev path. Byte-for-byte unchanged behaviour.
//
// The dispatch reads process.argv[1] guard so importing this module (e.g. from
// backend.ts or tests) never auto-starts a server.
if (require.main === module) {
  // Schema emission (build step). `node dist/index.js --emit-schema` prints the
  // canonical tools/list result to stdout so gen-schema.cjs can write
  // dist/schema.json from the SELF-CONTAINED bundle (BL-38: memory-server is now
  // esbuild-bundled, so there is no separate dist/backend.js to require). Derives
  // from buildToolsListResult() — never hand-maintained ([contract:schema-hash]).
  if (process.argv.includes('--emit-schema')) {
    const { buildToolsListResult } = require('./backend.js') as typeof import('./backend.js');
    process.stdout.write(JSON.stringify(buildToolsListResult(), null, 2) + '\n');
    process.exit(0);
  }
  // BL-89: proactively warm the real embedding backend at startup so a missing/broken
  // embedding runtime is reported LOUDLY at boot (stderr + memory_ping.last_embed_error)
  // instead of silently degrading to hash on the first write. Fire-and-forget: for
  // backend='auto' this records the fallback cause; for backend='real' warmupEmbed throws,
  // which we log prominently (the server keeps serving non-embed tools, but the failure is
  // unmissable). Never writes to stdout (the JSON-RPC channel).
  // setImmediate defers to the next event loop tick so the MCP transport starts serving
  // before the synchronous portion of ONNX model loading blocks the event loop.
  setImmediate(() => {
    void warmupEmbed().then(
    (h) => {
      if (h.on_hash_fallback) {
        process.stderr.write(
          `[memory-server] WARNING: embeddings on HASH fallback (degraded recall). cause=${h.last_error ?? 'unknown'}\n`,
        );
      } else if (h.state === 'real') {
        process.stderr.write(`[memory-server] embeddings: real model active (${h.model})\n`);
      }
    },
    (err) => {
      process.stderr.write(
        `[memory-server] FATAL: SOX_EMBED_BACKEND=real but embedding warmup failed: ${String(err)}\n`,
      );
    },
  );
  });

  // BL-94: probe better-sqlite3 native binding at startup before accepting connections.
  // A missing binding (new Node ABI without rebuild) would otherwise fail mid-session
  // after an agent has already written several episodes — the crash is destructive.
  // This probe exits 1 immediately with a clear message so the supervisor can restart.
  try {
    require('better-sqlite3');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `FATAL: better-sqlite3 native binding missing for this Node.js ABI.\n` +
      `Run: pnpm rebuild better-sqlite3 from the sox-ecosystem root, then restart.\n` +
      `Error: ${msg}\n`,
    );
    process.exit(1);
  }

  if (process.env.SOX_PROXY_BACKEND === '1') {
    const socketPath = process.env.SOX_PROXY_BACKEND_SOCKET;
    if (!socketPath) {
      process.stderr.write(
        '[memory-server] SOX_PROXY_BACKEND=1 but SOX_PROXY_BACKEND_SOCKET is unset — cannot bind backend\n',
      );
      process.exit(2);
    }
    // Lazy-require so the direct-stdio path never loads service-proxy.
    const { runBackend } = require('./backend.js') as typeof import('./backend.js');
    void runBackend({
      socketPath,
      ...(process.env.SOX_PROXY_BACKEND_SCHEMA
        ? { schemaPath: process.env.SOX_PROXY_BACKEND_SCHEMA }
        : {}),
    });
  } else {
    // ADR-0003 Decision 5: serverInfo.version is DERIVED from the running artifact's
    // content address (short hash) — never a hand-typed '1.1.0'. The MCP initialize
    // response now answers "what code is this?" with the same drift-proof signal as
    // memory_ping.
    void serve(registeredTools, {
      name: 'memory-server',
      version: getContentAddress().short,
    });
  }
}
