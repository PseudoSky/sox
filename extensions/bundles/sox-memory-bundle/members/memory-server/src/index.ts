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
  embedBacklogStats,
  expandTilde,
  getActiveEmbedModel,
  getDb,
  getEmbedHealth,
  getEmbedPipelineMetrics,
  getEmbedState,
  getLastEmbedError,
  hasPendingFullEnrich,
  healMissingVectors,
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
  memoryUpdatePhaseA,
  memoryWrite,
  memoryWriteBatch,
  memoryWriteBatchPhaseA,
  memoryWritePhaseA,
  resolveStoreOrDbPath,
  rowidsToUids,
  runBatchEnrich,
  schedulePendingEmbeds,
  setLeaseInstanceId,
  supersedesUidForRowid,
  syncEmbedEnabled,
  warmupEmbed,
  isSuperseded,
  WriteQueue,
  // S11 / BL-165: canonical chunking re-exported from @adhd/sox-ingest via memory-core.
  // Replaces the local splitIntoChunks function (deleted below).
  splitIntoChunksSentence,
} from '@adhd/sox-memory-core';
import type { PendingEmbed, PhaseAOutcome, WriteError, WriteResult } from '@adhd/sox-memory-core';
import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
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

// ── Instance identity (SA-7 / CONTRACTS §H) ──────────────────────────────────
const INSTANCE_STARTED_AT = new Date().toISOString();
const INSTANCE_ID = crypto.randomUUID();
setLeaseInstanceId(INSTANCE_ID);

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
      'Use this to verify the server is reachable — returns {ok:true} with instance, store, and embed health info.',
    inputSchema: {
      type: 'object',
      properties: {
        store: { type: 'string', description: 'Optional. Named store to report health for (e.g., "default", "user"). Defaults to the bundle-configured store.' },
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Overrides store if both provided.' },
      },
    },
  },
  {
    name: 'memory_write',
    description:
      'Write a memory episode. Runs deterministic enrichment synchronously (provenance, tags, topic, extractive summary). Returns {episode_uid}. The embedding + near-dup detection run asynchronously moments after the write (enrichment.near_dup is null in the response; the episode is keyword/temporal-recallable immediately and vector-recallable once the async embed lands — set SOX_SYNC_EMBED=1 server-side to restore fully synchronous behaviour). Batch enrichments (clustering, auto-links, importance link-score) run in-process on a periodic interval within this server (no separate daemon process).',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The content to memorize. Required.' },
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        client_request_id: {
          type: 'string',
          maxLength: 128,
          description: '(WP-4) Client-supplied request idempotency key. Replay of a known id returns the original result with "replayed": true. No new episode is created.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_write_batch',
    description:
      'Write multiple memory episodes as a single batch. Each item follows the same shape as memory_write. Per-item E_DEDUP is returned as ok:false (not a batch failure). The entire batch routes through one queue entry.',
    inputSchema: {
      type: 'object',
      properties: {
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'The content to memorize. Required.' },
              summary: { type: 'string', description: '(E2) Human-readable summary.' },
              name: { type: 'string', description: '(E2) Title/name for this episode.' },
              topic: { type: 'string', description: '(E5) Explicit topic override.' },
              tags: { type: 'array', items: { type: 'string' }, description: '(E4) Concept/entity tags.' },
              metadata: { type: 'object', additionalProperties: true, description: '(E3) Arbitrary caller metadata.' },
              project_path: { type: 'string', description: '(E1) Caller project root path.' },
              derived_from_uid: { type: 'string', description: '(E9) UID of a parent episode.' },
              session_id: { type: 'string' },
              t_occurred: { type: 'string', description: 'ISO timestamp when this occurred.' },
              agent_id: { type: 'string' },
              source: { type: 'string', enum: ['message', 'tool_output', 'observation', 'document', 'reflection', 'import'] },
              importance: { type: 'number', minimum: 1, maximum: 10, description: 'User-asserted importance (1–10).' },
              client_request_id: { type: 'string', maxLength: 128, description: '(WP-4) Client-supplied request idempotency key. Replay returns the original result.' },
            },
            required: ['content'],
          },
          description: 'Array of memory_write payloads.',
        },
      },
      required: ['items'],
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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
        filters: { type: 'object', description: '(recluster) Restrict clustering to the matching subset of episodes. Same filter vocabulary as memory_recall: project_path, topic, tags, tags_match_all, importance_min, t_created_after/before. When present, recluster runs SYNCHRONOUSLY over the subset and returns the resulting communities. Combined with dry_run: dry_run=true returns communities without writing; dry_run=false persists them as a provenance-scoped community slice that leaves the global partition untouched. Absent: a global full re-cluster runs SYNCHRONOUSLY in-process (no daemon).' },
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
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
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

// ── Helpers for enrichment field reads ───────────────────────────────────────
// S11 / BL-165: splitIntoChunks deleted — consolidated into ingest's
// splitIntoChunksSentence (re-exported from @adhd/sox-memory-core above).
// Parity verified by libs/memory-core/src/ingest-parity.spec.ts.

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
  // memory_ping: no mandatory db_path — handled before the db_path guard.
  // ADR-0003 Decision 5: report the running server's CONTENT ADDRESS — the
  // drift-proof answer to "what code is this?" — instead of a hand-typed version.
  // SA-7 / CONTRACTS §H: enhanced with instance, store, and embed blocks.
  if (name === 'memory_ping') {
    const addr = getContentAddress();
    const embedHealth = getEmbedHealth();

    // ── Instance block (SA-7) ────────────────────────────────────────────────
    const instanceBlock = {
      pid: process.pid,
      started_at: INSTANCE_STARTED_AT,
      transport: process.env.SOX_PROXY_BACKEND === '1' ? 'backend' : 'stdio',
      instance_id: INSTANCE_ID,
    };

    // ── Embed block (SA-7) ───────────────────────────────────────────────────
    const embedBlock = {
      model: embedHealth.model,
      backend: embedHealth.backend,
      state: embedHealth.state,
      on_hash_fallback: embedHealth.on_hash_fallback,
      last_error: embedHealth.last_error,
    };

    // ── Store block (SA-7) ───────────────────────────────────────────────────
    // Attempt to resolve and probe the target store. Errors are non-fatal —
    // the store block is simply omitted from the response.
    let storeBlock: Record<string, unknown> | null = null;
    try {
      const storeArg = args['store'];
      const dbPathArg = args['db_path'];
      const storeResult = resolveStoreOrDbPath(storeArg, dbPathArg);

      let resolvedPath = '';
      let storeName = '';

      if (storeResult === null) {
        resolvedPath = expandTilde(resolveDbPath(undefined));
        storeName = 'default';
      } else if (!('code' in storeResult)) {
        resolvedPath = storeResult.path;
        storeName = storeResult.name;
      }

      if (resolvedPath && fs.existsSync(resolvedPath)) {
        // sha256 file fingerprint
        let sha256Fingerprint = '';
        try {
          const fileBytes = fs.readFileSync(resolvedPath);
          sha256Fingerprint = crypto.createHash('sha256').update(fileBytes).digest('hex');
        } catch { /* fingerprint omitted */ }

        // WAL file size
        const walPath = resolvedPath + '-wal';
        let walBytes = 0;
        try { walBytes = fs.statSync(walPath).size; } catch { /* no WAL yet */ }

        // Open DB for live metadata queries
        const db = getDb(resolvedPath);

        // Queue depth (pending enrichments)
        const qRow = db
          .prepare<[], { q: number }>('SELECT COUNT(*) AS q FROM organizer_queue WHERE done_at IS NULL')
          .get();
        const queueDepth = qRow?.q ?? 0;

        // Enrichment watermark (latest enrich_ver)
        const eRow = db
          .prepare<[], { ev: string | null }>('SELECT MAX(enrich_ver) AS ev FROM node WHERE enrich_ver IS NOT NULL')
          .get();
        const enrichmentWatermark = eRow?.ev ?? null;

        // Queue-drain SLO (BL-172 follow-on): expose stall-detection timestamps +
        // a structured verdict so a dead outbox consumer is machine-visible.
        // NOTE: enrichment_watermark above is MAX(enrich_ver) over nodes — the
        // SYNCHRONOUS write-path enrichment stamps it; it does NOT prove the
        // async consumer is alive. These fields do.
        const oldRow = db
          .prepare<[], { o: string | null }>(
            'SELECT MIN(enqueued) AS o FROM organizer_queue WHERE done_at IS NULL',
          )
          .get();
        const doneRow = db
          .prepare<[], { d: string | null }>('SELECT MAX(done_at) AS d FROM organizer_queue')
          .get();
        const queueOldestPendingAt = oldRow?.o ?? null;
        const queueLastDoneAt = doneRow?.d ?? null;

        // Phase-B embed backlog (two-phase write, 2026-07-04): live episodes
        // whose vec_node row has not landed yet. Cheap SQL; folded into the
        // enrichment verdict so a dead Phase-B pipeline reads `stalled`.
        const embedBacklog = embedBacklogStats(db);

        const enrichmentHealth = computeEnrichmentHealth(
          queueDepth,
          queueOldestPendingAt,
          queueLastDoneAt,
          Date.now(),
          embedBacklog,
        );

        // BL-174: report the real WP-5 checkpoint time (0 = never/no queue → null).
        const lastCheckpointMs = WriteQueue.lastCheckpointAtForPath(resolvedPath);

        storeBlock = {
          name: storeName,
          path: resolvedPath,
          fingerprint: `sha256:${sha256Fingerprint}`,
          wal_bytes: walBytes,
          last_checkpoint_at: lastCheckpointMs > 0 ? new Date(lastCheckpointMs).toISOString() : null,
          enrichment_watermark: enrichmentWatermark,
          queue_depth: queueDepth,
          // Additive (HF-3 rule): never rename/remove the fields above.
          queue_oldest_pending_at: queueOldestPendingAt,
          queue_last_done_at: queueLastDoneAt,
          enrichment: enrichmentHealth,
          // Phase-B embed backlog (additive, 2026-07-04 two-phase write):
          // live episodes without a vec_node row + the oldest one's t_created.
          embed_backlog: embedBacklog.count,
          embed_backlog_oldest_at: embedBacklog.oldest_created_at,
          // Write-path observability (2026-07-04 saturation incident):
          // rolling write-latency percentiles, depth/watermark, deadline
          // budget, and rejection counters from the in-process WriteQueue.
          // null until the first write creates the queue for this store.
          write_queue: WriteQueue.metricsForPath(resolvedPath),
          // Phase-B pipeline observability (two-phase write follow-on):
          // time_to_vector (Phase-A commit → vec applied, the eventual-
          // consistency window), worker-side embed duration, apply/heal
          // counters, plus the backlog mirrored from the fields above (kept
          // top-level too — HF-3 additive rule). `metrics` is null until the
          // first Phase-B activity for this store in this process.
          embed_pipeline: {
            backlog: embedBacklog.count,
            backlog_oldest_at: embedBacklog.oldest_created_at,
            metrics: getEmbedPipelineMetrics(resolvedPath),
          },
        };
      }
    } catch {
      // Store block omitted on any error (file not found, permission, etc.)
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          id: addr.id,
          artifact: addr.artifact,
          short: addr.short,
          host_compat: addr.host_compat,
          // SA-7 blocks
          instance: instanceBlock,
          store: storeBlock,
          embed: embedBlock,
          // ── Legacy flat keys (preserved for one minor version) ─────────────
          embed_model: embedHealth.model,
          embed_backend_configured: embedHealth.backend,
          embed_state: embedHealth.state,
          embed_on_hash_fallback: embedHealth.on_hash_fallback,
          last_embed_error: embedHealth.last_error,
        }),
      }],
    };
  }

  // SA-6 / BL-130: resolve via store-registry when `store` param provided.
  // resolveStoreOrDbPath handles: store → registry, db_path → raw-path fallback,
  // null → use defaults. The result supersedes the simple resolveDbPath chain.
  const storeArg = args['store'];
  const dbPathArg = args['db_path'];
  const storeResult = resolveStoreOrDbPath(storeArg, dbPathArg);

  let dbPath: string;
  if (storeResult === null) {
    // Neither store nor db_path — use the default chain
    const rawDbPath = resolveDbPath(undefined);
    dbPath = expandTilde(rawDbPath);
  } else if ('code' in storeResult) {
    // Unknown store — return structured error
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(storeResult) }],
    };
  } else {
    dbPath = storeResult.path;
  }

  // BL-55: when no store resolved and no explicit db_path, use the fallback chain
  if (!dbPath) {
    const rawDbPath = resolveDbPath(dbPathArg);
    dbPath = expandTilde(rawDbPath);
  }

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
      const wq = WriteQueue.forPath(dbPath);
      const content = args['content'] as string;
      const chunkSize = (args['chunk_size'] as number | undefined) ?? 500;
      // S11 / BL-165: routed through ingest's canonical sentence-boundary chunker.
      const chunks = splitIntoChunksSentence(content, chunkSize);
      // Full write params (shared by both embed modes). client_request_id was
      // previously dropped by this handler (WP-4 idempotency dead through MCP)
      // — now forwarded.
      const parentParams = {
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
        client_request_id: args['client_request_id'] as string | undefined,
      };
      const chunkParams = (chunk: string) => ({
        content: chunk,
        agent_id: args['agent_id'] as string | undefined,
        source: (args['source'] as 'message' | undefined) ?? ('document' as const),
        metadata: args['metadata'] as Record<string, unknown> | undefined,
      });
      /** DERIVED_FROM auto-chunk edges — identical in both embed modes. */
      const linkChunksToParent = (
        writeDb: Database.Database,
        parentUid: string,
        chunkUids: string[],
      ): void => {
        const now = new Date().toISOString();
        const parentRow = writeDb
          .prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?')
          .get(parentUid);
        for (const chunkUid of chunkUids) {
          const chunkRow = writeDb
            .prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?')
            .get(chunkUid);
          if (chunkRow && parentRow) {
            writeDb.prepare(
              `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
               SELECT ?, ?, 'DERIVED_FROM', 'user_asserted', ?, '{"auto_chunk":true}'
               WHERE NOT EXISTS (
                 SELECT 1 FROM edge WHERE src=? AND dst=? AND rel='DERIVED_FROM' AND t_expired IS NULL
               )`,
            ).run(chunkRow.rowid, parentRow.rowid, now, chunkRow.rowid, parentRow.rowid);
          }
        }
      };

      // ── SOX_SYNC_EMBED=1 kill-switch: pre-split behaviour — embedding runs
      // INSIDE the queue slot and near_dup resolves in the response. Rollback
      // path for the async default; no revert needed.
      if (syncEmbedEnabled()) {
        return wq.enqueue('memory_write', async (writeDb) => {
          if (chunks.length > 1) {
            // Long content: write parent episode, then all chunks
            const parentResult = await memoryWrite(writeDb, parentParams);
            const parentUid =
              'episode_uid' in parentResult
                ? parentResult.episode_uid
                : parentResult.code === 'E_DEDUP'
                  ? parentResult.existing_uid
                  : null;
            if (!parentUid) {
              return { isError: true, content: [{ type: 'text', text: JSON.stringify(parentResult) }] };
            }

            // Chunks: written directly on `writeDb`, which we already hold exclusively
            // inside this queue task. Re-enqueuing on the SAME serial queue from within
            // a running task would deadlock (BL-154). Direct writes preserve ordering
            // (this loop is serial) and single-writer safety.
            const chunkUids: string[] = [];
            for (const chunk of chunks) {
              const r: WriteResult | WriteError = await memoryWrite(writeDb, chunkParams(chunk));
              const chunkUid =
                'episode_uid' in r ? r.episode_uid : r.code === 'E_DEDUP' ? r.existing_uid : null;
              if (chunkUid) chunkUids.push(chunkUid);
            }
            linkChunksToParent(writeDb, parentUid, chunkUids);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ episode_uid: parentUid, chunk_uids: chunkUids, chunk_count: chunks.length }),
              }],
            };
          }

          // Content below threshold: single write through queue
          const result = await memoryWrite(writeDb, parentParams);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        });
      }

      // ── Two-phase path (DEFAULT, 2026-07-04): the queue-slot task is FULLY
      // SYNCHRONOUS (no embed, no ONNX, no awaits). Phase B (embedding + vec
      // insert + deferred near-dup) is scheduled AFTER the Phase-A task has
      // returned its slot — never from inside it (BL-154). The response's
      // enrichment.near_dup is null (deferred); the episode is BM25/temporal-
      // recallable immediately and vec-recallable once Phase B lands.
      const outcome = await wq.enqueue('memory_write', (writeDb) => {
        const pendings: PendingEmbed[] = [];

        if (chunks.length > 1) {
          const parentA = memoryWritePhaseA(writeDb, parentParams);
          const parentUid =
            'code' in parentA
              ? parentA.code === 'E_DEDUP'
                ? parentA.existing_uid
                : null
              : parentA.result.episode_uid;
          if (!parentUid) {
            return {
              response: { isError: true, content: [{ type: 'text', text: JSON.stringify(parentA) }] },
              pendings,
            };
          }
          if (!('code' in parentA) && parentA.pending) pendings.push(parentA.pending);

          const chunkUids: string[] = [];
          for (const chunk of chunks) {
            const a: PhaseAOutcome | WriteError = memoryWritePhaseA(writeDb, chunkParams(chunk));
            const chunkUid =
              'code' in a
                ? a.code === 'E_DEDUP'
                  ? a.existing_uid
                  : null
                : a.result.episode_uid;
            if (chunkUid) chunkUids.push(chunkUid);
            if (!('code' in a) && a.pending) pendings.push(a.pending);
          }
          linkChunksToParent(writeDb, parentUid, chunkUids);
          return {
            response: {
              content: [{
                type: 'text',
                text: JSON.stringify({ episode_uid: parentUid, chunk_uids: chunkUids, chunk_count: chunks.length }),
              }],
            },
            pendings,
          };
        }

        const a = memoryWritePhaseA(writeDb, parentParams);
        if ('code' in a) {
          return {
            response: { content: [{ type: 'text', text: JSON.stringify(a) }] },
            pendings,
          };
        }
        if (a.pending) pendings.push(a.pending);
        return {
          response: { content: [{ type: 'text', text: JSON.stringify(a.result) }] },
          pendings,
        };
      });
      // Phase B: scheduled from OUTSIDE the queue task (BL-154 audit point).
      // Fire-and-forget: failures log to stderr and the periodic heal repairs.
      if (outcome.pendings.length > 0) void schedulePendingEmbeds(wq, outcome.pendings);
      return outcome.response;
    }

    case 'memory_write_batch': {
      const wq = WriteQueue.forPath(dbPath);
      const items = args['items'] as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(items) || items.length === 0) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_INVALID_INPUT', message: 'items must be a non-empty array' }) }] };
      }
      const batchItems = items.map((item) => ({
        content: item['content'] as string,
        summary: item['summary'] as string | undefined,
        name: item['name'] as string | undefined,
        topic: item['topic'] as string | undefined,
        project_path: item['project_path'] as string | undefined,
        derived_from_uid: item['derived_from_uid'] as string | undefined,
        metadata: item['metadata'] as Record<string, unknown> | undefined,
        session_id: item['session_id'] as string | undefined,
        t_occurred: item['t_occurred'] as string | undefined,
        agent_id: item['agent_id'] as string | undefined,
        source: item['source'] as 'message' | undefined,
        importance: item['importance'] as number | undefined,
        tags: item['tags'] as string[] | undefined,
        client_request_id: item['client_request_id'] as string | undefined,
      }));

      // SOX_SYNC_EMBED=1 kill-switch: pre-split behaviour (per-item embed
      // inside the single batch queue slot).
      if (syncEmbedEnabled()) {
        return wq.enqueue('memory_write_batch', async (writeDb) => {
          const batchResult = await memoryWriteBatch(writeDb, batchItems);
          return {
            content: [{ type: 'text', text: JSON.stringify(batchResult) }],
          };
        });
      }

      // Two-phase path (DEFAULT): all Phase As run serially inside ONE
      // synchronous queue task (single-queue-entry contract, CONTRACTS §C);
      // Phase-B embeds for the whole batch are pipelined off-slot afterwards
      // (BL-154: scheduled only after the Phase-A task returned its slot).
      const outcome = await wq.enqueue('memory_write_batch', (writeDb) =>
        memoryWriteBatchPhaseA(writeDb, batchItems),
      );
      if (outcome.pendings.length > 0) void schedulePendingEmbeds(wq, outcome.pendings);
      return {
        content: [{ type: 'text', text: JSON.stringify({ results: outcome.results }) }],
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
      const wq = WriteQueue.forPath(dbPath);
      return wq.enqueue('memory_invalidate', (writeDb) => {
        const result = memoryInvalidate(writeDb, {
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
      });
    }

    case 'memory_update': {
      const uid = args['uid'] as string | undefined;
      if (!uid) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_MISSING', message: 'uid is required' }) }] };
      }
      const wq = WriteQueue.forPath(dbPath);
      const updateParams = {
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
      };

      // SOX_SYNC_EMBED=1 kill-switch: pre-BL-189 behaviour — re-embed runs
      // inside the queue slot via the sync composition.
      if (syncEmbedEnabled()) {
        return wq.enqueue('memory_update', async (writeDb) => {
          const updateResult = await memoryUpdate(writeDb, updateParams);
          if ('code' in updateResult) {
            return {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify(updateResult) }],
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(updateResult) }],
          };
        });
      }

      // ── Two-phase path (DEFAULT — BL-189, mirrors memory_write): the slot
      // task is fully synchronous (columns + FTS + stale-vec delete); the
      // re-embed is scheduled off-slot AFTER the task returns (BL-154) via
      // schedulePendingEmbeds — which also records the embed-pipeline metrics
      // memory_update previously skipped (BL-191). A crashed Phase B leaves
      // the node vectorless → healMissingVectors repairs on the next tick.
      const updOutcome = await wq.enqueue('memory_update', (writeDb) => {
        const a = memoryUpdatePhaseA(writeDb, updateParams);
        if ('code' in a) {
          return {
            response: { isError: true, content: [{ type: 'text', text: JSON.stringify(a) }] },
            pending: null as PendingEmbed | null,
          };
        }
        return {
          response: { content: [{ type: 'text', text: JSON.stringify(a.result) }] },
          pending: a.pending,
        };
      });
      if (updOutcome.pending) void schedulePendingEmbeds(wq, [updOutcome.pending]);
      return updOutcome.response;
    }

    case 'memory_link': {
      const wq = WriteQueue.forPath(dbPath);
      return wq.enqueue('memory_link', (writeDb) => {
        const result = memoryLinkNode(writeDb, args);
        if (result.isError) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      });
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
      const wq = WriteQueue.forPath(dbPath);
      return wq.enqueue('memory_curate', async (writeDb) => {
        const result = await memoryCurate(writeDb, args);
        if ('code' in result) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      });
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

// ── BL-162: in-process periodic batch-enrichment loop ─────────────────────────
//
// ADR-0007 single-writer architecture: memory-server IS the writer process, and
// batch enrichment (clustering, auto-links, importance, topic backfill) runs
// entirely in-process — there is no separate daemon process and nothing to probe
// or nudge. This periodic loop is the sole batch-enrichment driver (write-time
// enrichment, e.g. tags/topic/near-dup, already runs synchronously in memoryWrite
// via enrichOnWrite; this loop handles the O(n) incremental clustering pass that
// would otherwise only run on the next write).
//
// The loop uses incremental clustering (no full O(n²) pass) to keep each pass
// fast. A full re-cluster is available on demand via memory_curate recluster.
//
// The loop is debounced: if a pass is already running (blocking the event loop
// via synchronous better-sqlite3), the timer fires after it completes naturally.
//
// This loop iterates over ALL open DB connections in dbCache so enrichment runs
// for every db_path that has been actively used this session.

const PERIODIC_ENRICH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between passes

// ── Queue-drain health SLO (BL-172 follow-on) ─────────────────────────────────
//
// "HEALTHY" must require workload progress, not just RPC liveness: memory_ping
// answered ok:true for 27h while the enrichment outbox was dead. The ping store
// block now carries a structured enrichment verdict so a stalled outbox is
// machine-visible without SQL forensics. Additive fields only (HF-3 rule).
//
// Stall threshold: 3× the in-process consumer tick (FALLBACK_ENRICH_INTERVAL_MS,
// 5 min) = 15 min by default — a pending trigger row older than that means the
// consumer has missed ≥3 ticks. Env-overridable via SOX_ENRICH_STALL_THRESHOLD_MS.

export interface EnrichmentHealth {
  state: 'idle' | 'ok' | 'stalled';
  oldest_pending_at: string | null;
  last_done_at: string | null;
  stall_threshold_ms: number;
  /** Additive (two-phase write, 2026-07-04): Phase-B embed backlog folded into
   *  the verdict. Absent when the caller did not supply backlog stats. */
  embed_backlog?: number;
  embed_backlog_oldest_at?: string | null;
}

/** Resolve the stall threshold (env override → default 3× consumer tick). */
export function enrichStallThresholdMs(): number {
  const raw = process.env.SOX_ENRICH_STALL_THRESHOLD_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 3 * PERIODIC_ENRICH_INTERVAL_MS;
}

/**
 * Compute the enrichment-consumption health verdict. Pure — exported for tests.
 *   idle    — queue empty AND no embed backlog (nothing pending).
 *   ok      — pending work, all of it younger than the stall threshold.
 *   stalled — pending work older than the threshold: a consumer is not draining.
 *
 * The optional `embedBacklog` (two-phase write, 2026-07-04) folds Phase-B
 * health into the same verdict: live episodes missing their vec_node row are
 * pending work for the Phase-B pipeline/heal, aged by the oldest episode's
 * t_created against the same stall threshold. A dead Phase-B pipeline
 * therefore reads `stalled`, never silent ([inv:list-never-lies]).
 */
export function computeEnrichmentHealth(
  queueDepth: number,
  oldestPendingAt: string | null,
  lastDoneAt: string | null,
  nowMs: number,
  embedBacklog?: { count: number; oldest_created_at: string | null },
): EnrichmentHealth {
  const stallThresholdMs = enrichStallThresholdMs();

  /** Verdict for one pending-work channel: ok when fresh, stalled when the
   *  oldest item exceeds the threshold or carries an unparseable timestamp. */
  const channelState = (oldestAt: string | null): 'ok' | 'stalled' => {
    const oldestMs = oldestAt === null ? NaN : Date.parse(oldestAt);
    // An unparseable/absent timestamp with pending rows is itself suspicious —
    // treat as stalled rather than silently ok ([inv:list-never-lies]).
    return !Number.isFinite(oldestMs) || nowMs - oldestMs > stallThresholdMs ? 'stalled' : 'ok';
  };

  let state: EnrichmentHealth['state'] = 'idle';
  if (queueDepth > 0) state = channelState(oldestPendingAt);
  if (embedBacklog !== undefined && embedBacklog.count > 0) {
    const embedState = channelState(embedBacklog.oldest_created_at);
    // Worst-of: stalled dominates; otherwise pending work means at least ok.
    if (embedState === 'stalled' || state === 'stalled') state = 'stalled';
    else state = 'ok';
  }

  return {
    state,
    oldest_pending_at: oldestPendingAt,
    last_done_at: lastDoneAt,
    stall_threshold_ms: stallThresholdMs,
    ...(embedBacklog !== undefined
      ? {
          embed_backlog: embedBacklog.count,
          embed_backlog_oldest_at: embedBacklog.oldest_created_at,
        }
      : {}),
  };
}

// BL-172: organizer_queue ops that are TRIGGERS for a batch-enrich pass. memoryd
// marks these done after a successful runBatchEnrich; the in-process fallback must
// do the same or (with the daemon intentionally absent per ADR-0007) the queue
// grows unbounded and memory_ping's queue_depth lies forever. 'decay'/'reindex'
// are real work items the fallback does NOT perform — they are left open.
const ENRICH_TRIGGER_OPS = ['ingest', 'enrich', 'extract', 'link', 'consolidate'] as const;

/**
 * BL-172: complete the open batch-enrich TRIGGER rows in organizer_queue after a
 * successful runBatchEnrich pass, mirroring memoryd's drain semantics
 * (claim → pass → done-on-success-only). Only rows with seq <= `maxSeq` (captured
 * BEFORE the pass) are completed, so a row enqueued after the pass snapshot is
 * never marked done by work that predates it. Returns the number of completed rows.
 * Exported for the BL-172 regression test.
 */
export function completeEnrichTriggerRows(db: Database.Database, maxSeq: number): number {
  if (maxSeq <= 0) return 0;
  const placeholders = ENRICH_TRIGGER_OPS.map(() => '?').join(',');
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `UPDATE organizer_queue
         SET claimed_at = COALESCE(claimed_at, ?),
             done_at = ?,
             attempts = attempts + 1
       WHERE done_at IS NULL AND seq <= ? AND op IN (${placeholders})`,
    )
    .run(now, now, maxSeq, ...ENRICH_TRIGGER_OPS);
  return res.changes;
}

/** BL-172: max open trigger-row seq — the pre-pass snapshot boundary. */
export function maxOpenEnrichTriggerSeq(db: Database.Database): number {
  const placeholders = ENRICH_TRIGGER_OPS.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(seq), 0) AS m FROM organizer_queue
       WHERE done_at IS NULL AND op IN (${placeholders})`,
    )
    .get(...ENRICH_TRIGGER_OPS) as { m: number };
  return row.m;
}

/**
 * Run one enrichment tick against a single DB. Exported for tests.
 *
 * Order of operations:
 *   1. Phase-B heal (healMissingVectors) — re-embed live episodes whose vec row
 *      never landed (crash/kill between write Phase A and Phase B). Runs FIRST
 *      so freshly-healed vectors participate in this pass's clustering. The
 *      heal embeds off-slot and applies through the WriteQueue as short tasks;
 *      this function is only ever called from an interval callback / test —
 *      never from inside a queue task (BL-154).
 *   2. BL-172 drain: snapshot the open trigger rows this pass will satisfy, run
 *      the pass, then complete them — synchronously, no await in between (the
 *      better-sqlite3 pass blocks the event loop, so no write can interleave).
 *   3. BL-186: if a full-pass `enrich` row (memory_curate recluster) is pending
 *      INSIDE the snapshot window, the pass runs with incrementalCluster:false
 *      — the honest fulfilment of `{enqueued: true}`. A full-pass row enqueued
 *      after the snapshot stays open and drives the next tick.
 */
export async function runEnrichPassOnDb(
  db: Database.Database,
  dbPath: string,
): Promise<{ queue_completed: number; full_pass: boolean; healed: number; heal_failed: number }> {
  const heal = await healMissingVectors(db, WriteQueue.forPath(dbPath));

  const maxSeq = maxOpenEnrichTriggerSeq(db);
  const fullPass = hasPendingFullEnrich(db, maxSeq);
  const result = runBatchEnrich(db, { incrementalCluster: !fullPass });
  const queueCompleted = completeEnrichTriggerRows(db, maxSeq);
  console.error(
    `[memory-server] periodic enrich (${dbPath}):` +
    ` communities=${result.communities_upserted}` +
    ` importance_updated=${result.importance_updated}` +
    ` relates_to=${result.relates_to_edges}` +
    ` queue_completed=${queueCompleted}` +
    ` full_pass=${fullPass}` +
    ` embed_healed=${heal.healed}` +
    ` embed_heal_failed=${heal.failed}` +
    (heal.disabled ? ' embed_heal=DISABLED' : ''),
  );
  return {
    queue_completed: queueCompleted,
    full_pass: fullPass,
    healed: heal.healed,
    heal_failed: heal.failed,
  };
}

/** Run one in-process enrichment pass over all open DBs. */
async function runPeriodicEnrichPass(): Promise<void> {
  if (openedPaths.size === 0) return;

  for (const dbPath of openedPaths) {
    try {
      const db = getDb(dbPath);
      await runEnrichPassOnDb(db, dbPath);
    } catch (err) {
      // Log to stderr only — never stdout (JSON-RPC channel).
      console.error(`[memory-server] periodic enrich error (${dbPath}):`, err);
    }
  }
}

// Schedule the periodic loop. unref() keeps the timer from holding the process
// open past MCP client disconnect — the server exits cleanly on stdin close.
const _periodicEnrichTimer = setInterval(() => {
  void runPeriodicEnrichPass();
}, PERIODIC_ENRICH_INTERVAL_MS);
_periodicEnrichTimer.unref();

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
    // BL-170: defensive .catch — a rejected startup (any cause runBackend itself
    // did not already exit on) must terminate the process, never idle as a
    // zombie relying on Node's default unhandled-rejection crash (which the
    // embed worker thread can outlive when stdio is a dead pipe).
    runBackend({
      socketPath,
      ...(process.env.SOX_PROXY_BACKEND_SCHEMA
        ? { schemaPath: process.env.SOX_PROXY_BACKEND_SCHEMA }
        : {}),
    }).catch((err: unknown) => {
      process.stderr.write(
        `[memory-server] FATAL: backend failed to start: ${String(err)} — exiting (BL-170)\n`,
      );
      process.exit(1);
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
