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
  autoBackup,
  buildFiltersClause,
  checkAndEscalateEnrichStall,
  communityUidForRowid,
  embedBacklogStats,
  expandTilde,
  getDb,
  getEmbedHealth,
  getEmbedPipelineMetrics,
  hasPendingFullEnrich,
  healMissingVectors,
  log,
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
  readEnrichStallEscalation,
  resolveStoreOrDbPath,
  runEnrichIsolated,
  runCompactionPass,
  DEFAULT_COMPACTION_INTERVAL_MS,
  schedulePendingEmbeds,
  setLeaseInstanceId,
  supersedesUidForRowid,
  vectorDialectFor,
  syncEmbedEnabled,
  warmupEmbed,
  isSuperseded,
  WriteQueue,
  // S11 / BL-165: canonical chunking re-exported from @adhd/sox-ingest via memory-core.
  // Replaces the local splitIntoChunks function (deleted below).
  splitIntoChunksSentence,
} from '@adhd/sox-memory-core';
import type { PendingEmbed, PhaseAOutcome, WriteError, WriteResult } from '@adhd/sox-memory-core';
import type { StoreAdapter, VectorDialect } from '@adhd/sox-store-adapter';
// BL-334: the adapter verifies and repairs its own generated artifacts at open
// (BL-352). Until this wiring, NOTHING read the retained result — so a store
// with a dead FTS index presented as healthy, which is exactly how BL-347 ran
// for a day unnoticed. `resolveVerifyDepth` is reused rather than re-reading
// SOX_STORE_VERIFY here, so "disabled" cannot drift between the two.
import {
  readIntegrityResult,
  resolveVerifyDepth,
  summarizeIntegrityForStatus,
  integrityHeadline,
} from '@adhd/sox-store-adapter';
// BL-401 gap 3: BL-351's stated acceptance requires every emitted metric be
// reachable from the status surface WITHOUT reading a log file — the exact
// BL-353 failure mode ("the data is written when somebody looks... nobody
// looked for two days") the substrate's own design doc calls out as
// insufficient on its own. `telemetrySelfCheck()` is a pure, zero-I/O,
// in-memory read (§5.7) — safe to call on every memory_stats request.
// BL-404: initTelemetry is the composition-root call (see the require.main===module
// block below) that wires this process's role:'live-service' + logSink:'file' state;
// telemetrySelfCheck reads it back for memory_stats.
import { initTelemetry, telemetrySelfCheck, type InitTelemetryOptions } from '@adhd/sox-telemetry';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
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
      'Write a memory episode. Runs deterministic enrichment synchronously (provenance, tags, topic, extractive summary). Returns {episode_uid}. The embedding + near-dup detection run asynchronously moments after the write (enrichment.near_dup is null in the response; the episode is keyword/temporal-recallable immediately and vector-recallable once the async embed lands — set SOX_SYNC_EMBED=1 server-side to restore fully synchronous behaviour). Batch enrichments (clustering, auto-links, importance link-score) run in-process on a periodic interval within this server (no separate daemon process). (BL-62) project_path is REQUIRED — no cwd/env inference. A long-lived server process\'s cwd reflects wherever it happened to be spawned (e.g. a throwaway git worktree with zero prior episodes), not the calling agent\'s real project; a wrong guess here permanently mis-attributes the episode. Pass the calling agent\'s actual workspace root explicitly every time.',
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
        project_path: { type: 'string', description: '(E1, REQUIRED) Caller project root path. No cwd/env inference — the write is rejected with E_MISSING_PROJECT_PATH if omitted.' },
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
      required: ['content', 'project_path'],
    },
  },
  {
    name: 'memory_write_batch',
    description:
      'Write multiple memory episodes as a single batch. Each item follows the same shape as memory_write. Per-item E_DEDUP is returned as ok:false (not a batch failure). The entire batch routes through one queue entry. (BL-62) project_path is REQUIRED on every item — no cwd/env inference; the whole batch is rejected with E_MISSING_PROJECT_PATH if any item omits it.',
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
              project_path: { type: 'string', description: '(E1, REQUIRED) Caller project root path. No cwd/env inference.' },
              derived_from_uid: { type: 'string', description: '(E9) UID of a parent episode.' },
              session_id: { type: 'string' },
              t_occurred: { type: 'string', description: 'ISO timestamp when this occurred.' },
              agent_id: { type: 'string' },
              source: { type: 'string', enum: ['message', 'tool_output', 'observation', 'document', 'reflection', 'import'] },
              importance: { type: 'number', minimum: 1, maximum: 10, description: 'User-asserted importance (1–10).' },
              client_request_id: { type: 'string', maxLength: 128, description: '(WP-4) Client-supplied request idempotency key. Replay returns the original result.' },
            },
            required: ['content', 'project_path'],
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
      'In-place editor for an existing live node. Distinct from supersession (which mints a new node). The uid is the required selector and is immutable — it can never change. Updates content, summary, name, topic, project_path, tags, importance, metadata (deep-merge by default), t_occurred, and t_valid. t_created is never modified (audit anchor). When content or summary changes, the embedding is refreshed automatically. FTS is auto-synced by the node UPDATE trigger. Returns {uid, updated_fields, reembedded}. (BL-221) project_path is editable here specifically so an episode mis-attributed by memory_write\'s old cwd-inference fallback (removed 2026-07-18 — memory_write now requires project_path explicitly and rejects an omitted one outright, so this can only affect episodes written before that fix) can be corrected without a rewrite: re-writing identical content with a different project_path is rejected as a duplicate (content_hash dedup ignores project_path by design), so this is the only in-place remediation path.',
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
        project_path: { type: 'string', description: '(BL-221) Replace node.project_path — corrects mis-attributed provenance from before 2026-07-18 (e.g. a prior write whose enrichment.project_path_source was "inferred", back when memory_write still had a cwd-inference fallback) in place, without content_hash dedup rejecting the correction.' },
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
      'Curation operations: retag, set topic, override importance, merge near-duplicates, drop episodes, or trigger a (optionally filtered) re-cluster pass.',
      inputSchema: {
      type: 'object',
      properties: {
        store: { type: 'string', description: 'Optional. Named store to use (e.g., "default", "user"). Overrides db_path. See memory init --help to register stores.' },
        db_path: { type: 'string', description: 'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.' },
        op: {
          type: 'string',
          enum: ['retag', 'set_topic', 'set_importance', 'merge_duplicates', 'recluster', 'drop_lens', 'drop-episodes', 'list_lenses'],
          description: 'The curation operation to perform. drop_lens removes a persisted subset lens by provenance_hash. drop-episodes hard-deletes episode node rows and cascading data. list_lenses returns all live subset lenses.',
        },
        uid: { type: 'string', description: 'Target episode UID (required for retag, set_topic, set_importance).' },
        uids: { type: 'array', items: { type: 'string' }, description: '(drop-episodes) Array of episode UIDs to hard-delete. Only live nodes (t_invalid IS NULL) are removed; non-existent or already-invalidated UIDs are silently skipped.' },
        tags: { type: 'array', items: { type: 'string' }, description: '(retag) Tags to add. Additive; duplicates are ignored.' },
        topic: { type: 'string', description: '(set_topic) New topic string.' },
        importance: { type: 'number', minimum: 1, maximum: 10, description: '(set_importance) User-asserted importance.' },
        uid_keep: { type: 'string', description: '(merge_duplicates) UID of the episode to keep.' },
        uid_drop: { type: 'string', description: '(merge_duplicates) UID of the episode to invalidate.' },
        filters: { type: 'object', description: '(recluster) Restrict clustering to the matching subset of episodes. Same filter vocabulary as memory_recall: project_path, topic, tags, tags_match_all, importance_min, t_created_after/before. When present, recluster runs SYNCHRONOUSLY over the subset and returns the resulting communities. Combined with dry_run: dry_run=true returns communities without writing; dry_run=false persists them as a provenance-scoped community slice that leaves the global partition untouched. Absent: a global full re-cluster is ENQUEUED, NOT run inline — the call returns {enqueued:true, seq} as soon as the trigger row commits, and the pass executes on a later in-process periodic enrichment tick (typically minutes away), so memory_stats read immediately after WILL still show the old partition. This deferral is deliberate (BL-186): a synchronous full pass holds the serial WriteQueue slot for its entire duration, fast-failing writes behind it with E_BUSY, and can out-wait the MCP client timeout. With dry_run:true nothing is enqueued and {enqueued:false, dry_run:true} returns.' },
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

/**
 * BL-241: rough token estimate (1 token ≈ 4 chars) — mirrors recall.ts's own
 * `estimateTokens` (not exported; duplicated here so the no-query listing branch
 * of memory_recall can honour `token_budget` with the SAME cumulative-estimate
 * semantics as the query path instead of a plain row-count LIMIT).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// rowidsToUids, communityUidForRowid, supersedesUidForRowid, isSuperseded,
// buildFiltersClause are imported from @adhd/sox-memory-core above.

/**
 * BL-55: the canonical single memory store. Used when neither a per-call `db_path`
 * arg nor the host-injected bundle config (`SOX_CONFIG_DB_PATH`) supplies a path.
 * User-scope installs default to this path.
 */
export const DEFAULT_DB_PATH = '~/.memory/memory.db';

/**
 * BL-55: project-scope store path. Used when `SOX_SCOPE=project` and no explicit
 * `db_path` or `SOX_CONFIG_DB_PATH` is supplied, so project-scope installs get a
 * separate store (`memory-dev.db`) from user-scope installs (`memory.db`).
 */
export const DEFAULT_DEV_DB_PATH = '~/.memory/memory-dev.db';

/**
 * BL-55: resolve the effective `db_path` for a tool call. `db_path` is OPTIONAL on
 * every tool; callers should normally omit it. Precedence:
 *   1. explicit caller arg (per-call override),
 *   2. the bundle config property the host injects as `SOX_CONFIG_DB_PATH`
 *      (cascade-resolved from `config.memory-server.db_path`; see buildExtConfigEnv),
 *   3. the scope-based default store:
 *      - `SOX_SCOPE=project` → DEFAULT_DEV_DB_PATH (`~/.memory/memory-dev.db`)
 *      - otherwise           → DEFAULT_DB_PATH (`~/.memory/memory.db`)
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
  // BL-55: scope-based store separation — project-scope installs use a
  // separate dev db so user-scope and project-scope stores don't collide.
  const soxScope = (process.env['SOX_SCOPE'] ?? '').trim().toLowerCase();
  if (soxScope === 'project') return DEFAULT_DEV_DB_PATH;
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
      last_error: embedHealth.last_error,
      execution_provider: embedHealth.execution_provider ?? 'cpu',
    };

    // ── Store block (SA-7) ───────────────────────────────────────────────────
    // Attempt to resolve and probe the target store. Errors are non-fatal —
    // the store block is simply omitted from the response.
    //
    // BL-412: a liveness question must never open a connection to a GUESSED
    // store, and must never register a guessed path into `openedPaths` (the
    // set the periodic background enrich loop iterates — registering it there
    // enlists the store into this process's enrichment scheduler, not just
    // reads it). "Guessed" means the caller supplied neither `store` nor
    // `db_path` AND the host never injected SOX_CONFIG_DB_PATH — that
    // combination only arises when the process was spawned bare (a test
    // harness, a stray `node index.js`), never from a properly configured
    // install (the host always injects SOX_CONFIG_DB_PATH). In that case the
    // resolution below would otherwise silently fall through to
    // `resolveDbPath`'s final default (`~/.memory/memory.db`, the user's real
    // production store) purely to answer "are you reachable?". Refuse to
    // resolve at all in that case; report `configured: false` instead.
    let storeBlock: Record<string, unknown> | null = null;
    try {
      const storeArg = args['store'];
      const dbPathArg = args['db_path'];
      const storeResult = resolveStoreOrDbPath(storeArg, dbPathArg);
      const hasHostConfig = (process.env['SOX_CONFIG_DB_PATH'] ?? '').trim() !== '';

      let resolvedPath = '';
      let storeName = '';

      if (storeResult === null && !hasHostConfig) {
        // No explicit store/db_path AND no host-injected config — this is a
        // guess, not a resolution. Do not open anything.
        storeBlock = {
          configured: false,
          reason:
            'no "store"/"db_path" argument was supplied and SOX_CONFIG_DB_PATH is not set — ' +
            'refusing to guess a store path merely to answer a liveness check (BL-412). ' +
            'Pass "store" or "db_path" explicitly, or run under a host that injects SOX_CONFIG_DB_PATH.',
        };
      } else if (storeResult === null) {
        // hasHostConfig is true: the host explicitly configured a store via
        // SOX_CONFIG_DB_PATH — this is real production config, not a guess.
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

        // Open DB for live metadata queries.
        // NOTE: track this path so the periodic enrich pass (which iterates
        // openedPaths) finds it. memory_ping returns early (before the main
        // handleToolCall flow at line 1011 that normally calls openedPaths.add)
        // so we must register it here — otherwise the enrich timer fires but
        // runPeriodicEnrichPass returns immediately (openedPaths.size === 0)
        // and the 5k+ embed backlog is never healed or enriched.
        const adapter = await getDb(resolvedPath);
        openedPaths.add(resolvedPath);

        // BUG A fix: these were unconditional raw better-sqlite3 `.prepare()`
        // calls via `adapter.unwrap()`. On Turso, `unwrap()` returns the
        // `@tursodatabase/database` handle — not a better-sqlite3 Database —
        // whose query methods are async, so the synchronous `.prepare().get()`
        // API throws/misbehaves. Route every read through the async
        // StoreAdapter surface (`executeGet`), which is correct for both
        // sqlite and turso.

        // Queue depth (pending enrichments)
        const qRow = await adapter.executeGet<{ q: number }>(
          'SELECT COUNT(*) AS q FROM organizer_queue WHERE done_at IS NULL',
        );
        const queueDepth = qRow?.q ?? 0;

        // Enrichment watermark (latest enrich_ver)
        const eRow = await adapter.executeGet<{ ev: string | null }>(
          'SELECT MAX(enrich_ver) AS ev FROM node WHERE enrich_ver IS NOT NULL',
        );
        const enrichmentWatermark = eRow?.ev ?? null;

        // Queue-drain SLO (BL-172 follow-on): expose stall-detection timestamps +
        // a structured verdict so a dead outbox consumer is machine-visible.
        // NOTE: enrichment_watermark above is MAX(enrich_ver) over nodes — the
        // SYNCHRONOUS write-path enrichment stamps it; it does NOT prove the
        // async consumer is alive. These fields do.
        const oldRow = await adapter.executeGet<{ o: string | null }>(
          'SELECT MIN(enqueued) AS o FROM organizer_queue WHERE done_at IS NULL',
        );
        const doneRow = await adapter.executeGet<{ d: string | null }>(
          'SELECT MAX(done_at) AS d FROM organizer_queue',
        );
        const queueOldestPendingAt = oldRow?.o ?? null;
        const queueLastDoneAt = doneRow?.d ?? null;

        // Phase-B embed backlog (two-phase write, 2026-07-04): live episodes
        // whose vec_node row has not landed yet. Cheap SQL; folded into the
        // enrichment verdict so a dead Phase-B pipeline reads `stalled`.
        const embedBacklog = await embedBacklogStats(adapter);

        const enrichmentHealth = computeEnrichmentHealth(
          queueDepth,
          queueOldestPendingAt,
          queueLastDoneAt,
          Date.now(),
          embedBacklog,
        );

        // BL-174: report the real WP-5 checkpoint time (0 = never/no queue → null).
        const lastCheckpointMs = WriteQueue.lastCheckpointAtForPath(resolvedPath);

        // BL-334/BL-352: the adapter's own verify+repair verdict for this store.
        //
        // Read, never re-probed — re-running the probes inside a status call
        // would make `memory_ping` cost 91ms (fast) or 392ms (deep) and would
        // report a DIFFERENT store state than the one the server is actually
        // running on. The open-time result is the operative fact.
        //
        // `healthy` here is earned, not assumed: no pass, an aborted pass, a
        // probe that could not be validated, or verification switched off all
        // render as `unknown` — never as ok. See integrity-status.ts.
        //
        // The verdict is read from the STORE (`_adapter_meta.last_integrity`),
        // not from store-adapter's in-process registry. That registry is
        // unreadable from here for two independent, measured reasons: `getDb`
        // hands back a Proxy (so a WeakMap keyed on the adapter misses), and
        // memory-core reaches store-adapter through `require()` while this file
        // may reach it through the ESM loader — two module instances, two
        // separate Maps. Either one silently yields "never ran" forever, which
        // is precisely the false-healthy this field exists to prevent.
        const persisted = await readIntegrityResult(adapter);
        const integrityView = summarizeIntegrityForStatus(
          persisted?.result ?? null,
          persisted?.runAtMs ?? null,
          resolveVerifyDepth(false) === 'off',
        );

        // BL-413: the durable corrective-action record a stalled tick writes
        // (see enrich-stall.ts / runEnrichPassOnDb). Read-only here — this
        // call never writes; only a tick's own checkAndEscalateEnrichStall
        // call does. null when the queue has never stalled, or the last
        // stall already recovered.
        const enrichStallEscalation = await readEnrichStallEscalation(adapter);

        storeBlock = {
          name: storeName,
          path: resolvedPath,
          adapter_type: adapter.config.type,
          fingerprint: `sha256:${sha256Fingerprint}`,
          wal_bytes: walBytes,
          // BL-334: store integrity. `integrity.healthy === false` means the
          // store is damaged OR unverified — both are actionable, and neither
          // may be read as "fine". `integrity_headline` is the one-line form so
          // the verdict is legible without expanding the block.
          integrity: integrityView,
          integrity_headline: integrityHeadline(integrityView),
          last_checkpoint_at: lastCheckpointMs > 0 ? new Date(lastCheckpointMs).toISOString() : null,
          enrichment_watermark: enrichmentWatermark,
          queue_depth: queueDepth,
          // Additive (HF-3 rule): never rename/remove the fields above.
          queue_oldest_pending_at: queueOldestPendingAt,
          queue_last_done_at: queueLastDoneAt,
          enrichment: enrichmentHealth,
          // BL-413: the recorded corrective action for a stalled queue — null
          // means never escalated or already recovered. Distinct from
          // `enrichment.state` (a live computed verdict): this is the
          // PERSISTED record a tick actually wrote, carrying
          // `consecutive_stalled_ticks` and the isolated pass's last error.
          enrich_stall_escalation: enrichStallEscalation,
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
            // BL-319: rolling per-second throughput (completions in last 60s).
            // Reflects the effective embed rate accounting for child-process
            // serial queue wait — the true system throughput, not the ~335ms
            // inference-only time. Below ~0.5/sec suggests a stuck pipeline.
            embed_throughput_per_sec: getEmbedPipelineMetrics(resolvedPath)?.embed_throughput_per_sec ?? null,
            // BL-319: true when the MOST RECENT heal pass exceeded its time
            // budget and stopped early. When persistently true, the heal
            // cannot keep up with the backlog at the current tick interval.
            heal_time_budget_exceeded: getEmbedPipelineMetrics(resolvedPath)?.heal_time_budget_exceeded ?? null,
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
          // BL-250: embed_on_hash_fallback removed — the hash backend no longer
          // exists (EmbedBackend = 'auto' | 'real' only), so this key always
          // reported the hardcoded constant `false` and never reflected reality.
          embed_model: embedHealth.model,
          embed_backend_configured: embedHealth.backend,
          embed_state: embedHealth.state,
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

  const adapter = await getDb(dbPath);
  // BUG A fix: this used to unconditionally unwrap() to a raw better-sqlite3
  // handle for every tool call — broken on Turso, whose unwrap() returns an
  // async `@tursodatabase/database` handle instead. Every call site below now
  // goes through the async StoreAdapter surface (adapter.executeGet/
  // executeAll/executeRun), which is correct for both backends. See BL-324/
  // team-lead's "BUG A" report for the full live-reproduction trace
  // (memory_recall listing threw "rows is not iterable" on Turso).
  openedPaths.add(dbPath);

  switch (name) {
    case 'memory_write': {
      const wq = await WriteQueue.forPath(dbPath);
      const content = args['content'] as string;
      const chunkSize = (args['chunk_size'] as number | undefined) ?? 500;
      // S11 / BL-165: routed through ingest's canonical sentence-boundary chunker.
      const chunks = splitIntoChunksSentence(content, chunkSize);
      // Full write params (shared by both embed modes). client_request_id was
      // previously dropped by this handler (WP-4 idempotency dead through MCP)
      // — now forwarded.
      // BL-62: project_path is REQUIRED — no cwd/env inference. Checked here (fast,
      // clear MCP error, before any chunking/queue work) AND in memoryWritePhaseA
      // (defense in depth for the other call sites — memory-cli, direct memoryWrite()
      // callers — that don't go through this MCP handler).
      const writeProjectPath = args['project_path'] as string | undefined;
      if (!writeProjectPath || writeProjectPath.length === 0) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify({
              code: 'E_MISSING_PROJECT_PATH',
              message:
                'project_path is required — the calling agent\'s actual workspace root, ' +
                'passed explicitly. No cwd/env inference: a long-lived server process\'s ' +
                'cwd reflects wherever it happened to be spawned, not the caller\'s real ' +
                'project, and a wrong guess here permanently mis-attributes the episode.',
            }),
          }],
        };
      }
      const parentParams = {
        content,
        summary: args['summary'] as string | undefined,
        name: args['name'] as string | undefined,
        topic: args['topic'] as string | undefined,
        project_path: writeProjectPath,
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
        // BL-62 fix: chunks previously omitted project_path entirely, relying on
        // whatever inference the write path fell back to — now inherits the
        // parent's explicit, already-validated value.
        project_path: writeProjectPath,
        agent_id: args['agent_id'] as string | undefined,
        source: (args['source'] as 'message' | undefined) ?? ('document' as const),
        metadata: args['metadata'] as Record<string, unknown> | undefined,
      });
      /** DERIVED_FROM auto-chunk edges — identical in both embed modes. */
      const linkChunksToParent = async (
        adapter: StoreAdapter,
        parentUid: string,
        chunkUids: string[],
      ): Promise<void> => {
        const now = new Date().toISOString();
        const parentRow = await adapter.executeGet<{ rowid: number }>(
          'SELECT rowid FROM node WHERE uid = ?', [parentUid],
        );
        for (const chunkUid of chunkUids) {
          const chunkRow = await adapter.executeGet<{ rowid: number }>(
            'SELECT rowid FROM node WHERE uid = ?', [chunkUid],
          );
          if (chunkRow && parentRow) {
            await adapter.executeRun(
              `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
               SELECT ?, ?, 'DERIVED_FROM', 'user_asserted', ?, '{"auto_chunk":true}'
               WHERE NOT EXISTS (
                 SELECT 1 FROM edge WHERE src=? AND dst=? AND rel='DERIVED_FROM' AND t_expired IS NULL
               )`,
              [chunkRow.rowid, parentRow.rowid, now, chunkRow.rowid, parentRow.rowid],
            );
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
            // BL-324: this MUST be awaited. Un-awaited, the edge inserts escape
            // the queue slot, race the next writer on the same file, and lose
            // all but the first edge to SQLITE_BUSY — surfacing as an unhandled
            // rejection rather than a failed write. The sibling call site below
            // (async-embed path) already awaits it.
            await linkChunksToParent(writeDb, parentUid, chunkUids);
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
      // Explicit type argument (rather than bare inference) so each branch's inline
      // `response` object literal is CONTEXTUALLY typed against ToolResult — without
      // it, TS widens `type: 'text'` to `type: string` and `isError: true` to
      // `isError: boolean` across the union of return statements (no target type to
      // check literals against), which fails ToolResultContent's `type: 'text'`
      // literal requirement under exactOptionalPropertyTypes.
      const outcome = await wq.enqueue<{ response: ToolResult; pendings: PendingEmbed[] }>('memory_write', async (writeDb) => {
        const pendings: PendingEmbed[] = [];

        if (chunks.length > 1) {
          const parentA = await memoryWritePhaseA(writeDb, parentParams);
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
            const a: PhaseAOutcome | WriteError = await memoryWritePhaseA(writeDb, chunkParams(chunk));
            const chunkUid =
              'code' in a
                ? a.code === 'E_DEDUP'
                  ? a.existing_uid
                  : null
                : a.result.episode_uid;
            if (chunkUid) chunkUids.push(chunkUid);
            if (!('code' in a) && a.pending) pendings.push(a.pending);
          }
          await linkChunksToParent(writeDb, parentUid, chunkUids);
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

        const a = await memoryWritePhaseA(writeDb, parentParams);
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
      schedulePhaseBAndWake(wq, outcome.pendings, { useBinaryFormat: adapter.capabilities.nativeVectors, vectorDialect: await vectorDialectFor(adapter) });
      return outcome.response;
    }

    case 'memory_write_batch': {
      const wq = await WriteQueue.forPath(dbPath);
      const items = args['items'] as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(items) || items.length === 0) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_INVALID_INPUT', message: 'items must be a non-empty array' }) }] };
      }
      // BL-62: project_path is REQUIRED per item — no cwd/env inference. Reject the
      // WHOLE batch (matching the single-queue-entry atomicity of the write below)
      // rather than silently writing some items with a bad guess.
      const missingProjectPath = items
        .map((item, i) => ({ i, ok: typeof item['project_path'] === 'string' && (item['project_path'] as string).length > 0 }))
        .filter((r) => !r.ok)
        .map((r) => r.i);
      if (missingProjectPath.length > 0) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify({
              code: 'E_MISSING_PROJECT_PATH',
              message:
                `project_path is required on every batch item — missing on item(s) at index ` +
                `${missingProjectPath.join(', ')}. No cwd/env inference: pass each item's ` +
                `calling agent's actual workspace root explicitly.`,
            }),
          }],
        };
      }
      const batchItems = items.map((item) => ({
        content: item['content'] as string,
        summary: item['summary'] as string | undefined,
        name: item['name'] as string | undefined,
        topic: item['topic'] as string | undefined,
        project_path: item['project_path'] as string,
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
      schedulePhaseBAndWake(wq, outcome.pendings, { useBinaryFormat: adapter.capabilities.nativeVectors, vectorDialect: await vectorDialectFor(adapter) });
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
        // BL-229: the top-level `agent_id` param is a HARD scope filter on the query
        // path (recall.ts: `AND n.agent_id = ?` on every vec/FTS/temporal channel) —
        // it MUST behave identically here, option (a) (apply it to the WHERE), not
        // option (b) (reject it), because the listing path can trivially express it:
        // `agent_id` is a plain column on the SAME `node` table this query already
        // filters. Before this fix the param was accepted into the schema, silently
        // read nowhere on this branch, and every agent's episodes were returned to a
        // caller who asked to be scoped to their own — a confidentiality leak, not a
        // cosmetic gap. Parameterized (never interpolated) to preempt injection, and
        // falsy-checked (`agentId ?`) to match recall.ts's own `agent_id ? ... : ''`
        // semantics exactly (an empty string is "no filter", not "filter to '').
        const agentId = args['agent_id'] as string | undefined;
        const agentSql = agentId ? ' AND n.agent_id = ?' : '';
        const agentParams = agentId ? [agentId] : [];

        // BL-240: `as_of` was accepted into the schema and hardcoded to `n.t_invalid
        // IS NULL` (today's live state only) on this branch, while the query path
        // (recall.ts) swaps in a bi-temporal validity window. "List my memories as
        // of last week" silently returned today's state. Mirror recall.ts's own
        // predicate exactly (`n.t_valid IS NULL OR n.t_valid <= as_of` — a null
        // t_valid means "always been valid" — `AND` `n.t_invalid IS NULL OR
        // n.t_invalid > as_of`), parameterized rather than interpolated.
        const asOf = args['as_of'] as string | undefined;
        const validitySql = asOf
          ? '(n.t_valid IS NULL OR n.t_valid <= ?) AND (n.t_invalid IS NULL OR n.t_invalid > ?)'
          : 'n.t_invalid IS NULL';
        const validityParams = asOf ? [asOf, asOf] : [];

        // BUG A fix: was a synchronous rawDb.prepare().all() call — on Turso,
        // unwrap() returns an async handle whose query methods return
        // Promises, so `rows` bound to an unawaited Promise and the `for`
        // loop below threw "rows is not iterable". Route through the async
        // StoreAdapter surface (correct for both sqlite and turso).
        const { rows } = await adapter.executeAll<{
          rowid: number; uid: string; content: string | null; importance: number;
          t_valid: string | null; agent_id: string | null; content_hash: string | null;
          summary: string | null; topic: string | null; tags: string | null;
          project_path: string | null; t_invalid: string | null; t_created: string;
        }>(
          `SELECT n.rowid, n.uid, n.content, n.importance, n.t_valid, n.agent_id,
                  n.content_hash, n.summary, n.topic, n.tags, n.project_path,
                  n.t_invalid, n.t_created
           FROM node n
           WHERE n.kind = 'episode' AND ${validitySql}${agentSql}${filterSql}
           ORDER BY n.importance DESC, n.t_created DESC
           LIMIT ?`,
          [...validityParams, ...agentParams, ...filterParams, limit],
        );

        // BL-241: `token_budget` was accepted into the schema and silently ignored on
        // this branch (a plain SQL `LIMIT` by row count), while the query path
        // (recall.ts:602-619) trims by cumulative estimated tokens. Mirror that here:
        // rows are already capped at `limit` by the SQL above; further trim by
        // cumulative token estimate, always keeping at least one row so a single
        // oversized episode is never dropped entirely (matches recall.ts's
        // `tokenCount + tokens > token_budget && results.length > 0` guard).
        // Default 4000 matches this tool's documented schema default (see the
        // memory_recall inputSchema above) — NOT recall.ts's internal
        // DEFAULT_TOKEN_BUDGET (32000), a pre-existing, separately-flagged
        // documentation/implementation drift on the query path (see report).
        const tokenBudget = (args['token_budget'] as number | undefined) ?? 4000;
        const budgetedRows: typeof rows = [];
        let tokenCount = 0;
        for (const r of rows) {
          const text = [r.content, r.summary].filter(Boolean).join(' ');
          const tokens = estimateTokens(text);
          if (tokenCount + tokens > tokenBudget && budgetedRows.length > 0) break;
          tokenCount += tokens;
          budgetedRows.push(r);
        }

        const results = await Promise.all(budgetedRows.map(async (r) => ({
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
          is_superseded: await isSuperseded(adapter, r.rowid),
          supersedes_uid: await supersedesUidForRowid(adapter, r.rowid),
          community_uid: await communityUidForRowid(adapter, r.rowid),
        })));

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

      const recallResult = await memoryRecall(adapter, (args['scope'] as string) ?? 'project', {
        query,
        agent_id: args['agent_id'] as string | undefined,
        as_of: args['as_of'] as string | undefined,
        token_budget: args['token_budget'] as number | undefined,
        depth: args['depth'] as number | undefined,
        limit,
        filters: Object.keys(recallFilters).length > 0 ? recallFilters : undefined,
      });

      // Augment each result with v1 enrichment fields
      const enrichedResults = await Promise.all(recallResult.results.map(async (r) => {
        // Fetch enrichment columns for this uid. BUG A fix: was a synchronous
        // rawDb.prepare().get() call — async StoreAdapter surface instead.
        const nodeRow = await adapter.executeGet<{
          rowid: number; summary: string | null; topic: string | null;
          tags: string | null; project_path: string | null; t_invalid: string | null;
        }>(
          `SELECT rowid, summary, topic, tags, project_path, t_invalid FROM node WHERE uid = ? LIMIT 1`,
          [r.uid],
        );

        return {
          ...r,
          summary: nodeRow?.summary ?? null,
          topic: nodeRow?.topic ?? null,
          tags: parseTags(nodeRow?.tags),
          project_path: nodeRow?.project_path ?? null,
          is_superseded: nodeRow ? await isSuperseded(adapter, nodeRow.rowid) : false,
          supersedes_uid: nodeRow ? await supersedesUidForRowid(adapter, nodeRow.rowid) : null,
          community_uid: nodeRow ? await communityUidForRowid(adapter, nodeRow.rowid) : null,
        };
      }));

      // Apply filter-level post-processing for fields not handled by the core recall.
      // The core recall path does not yet understand the enrichment filters natively,
      // so we apply them as a post-filter on the result set.
      let filteredResults = enrichedResults;
      if (filters) {
        const { sql: filterSql, params: filterParams } = buildFiltersClause(filters);
        if (filterSql) {
          // Collect the uids that pass the SQL filter. BUG A fix: was a
          // synchronous rawDb.prepare().all() call.
          const { rows: uidsRaw } = await adapter.executeAll<{ uid: string }>(
            `SELECT n.uid FROM node n WHERE n.uid IN (${enrichedResults.map(() => '?').join(',')})${filterSql}`,
            [...enrichedResults.map((r) => r.uid), ...filterParams],
          );
          const passingUids = new Set(uidsRaw.map((r) => r.uid));
          filteredResults = enrichedResults.filter((r) => passingUids.has(r.uid));
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ results: filteredResults, provider_call_count: recallResult.provider_call_count }) }],
      };
    }

    case 'memory_search_entities': {
      // SearchEntitiesParams.entity_type is `?: string` (no `| undefined` in the
      // member type) — under exactOptionalPropertyTypes the KEY must be omitted
      // entirely when absent, not present with an explicit `undefined` value.
      const entityType = args['entity_type'] as string | undefined;
      const result = await memorySearchEntities(adapter, {
        query: args['query'] as string,
        ...(entityType !== undefined ? { entity_type: entityType } : {}),
        limit: (args['limit'] as number) ?? 10,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_get_session_state': {
      const result = await memoryGetSessionState(adapter, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_save_session_state': {
      const result = await memorySaveSessionState(adapter, args);
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
        // BUG A fix: was a synchronous rawDb.prepare().get() call.
        const viaMemberOf = await adapter.executeGet<{ uid: string }>(
          `SELECT n2.uid FROM node n1
           JOIN edge e ON e.src = n1.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
           JOIN node n2 ON n2.rowid = e.dst AND n2.kind = 'community' AND n2.level = ? AND n2.t_invalid IS NULL
             AND (json_extract(n2.meta, '$.cluster_scope.kind') IS NULL
                  OR json_extract(n2.meta, '$.cluster_scope.kind') = 'global')
           WHERE n1.uid = ? AND n1.t_invalid IS NULL
           LIMIT 1`,
          [level, entityUid!],
        );
        if (!viaMemberOf) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', entity_uid: entityUid }) }] };
        }
        commUid = viaMemberOf.uid;
      }

      // BUG A fix: was a synchronous rawDb.prepare().get() call.
      const commRow = await adapter.executeGet<{ rowid: number; uid: string; name: string | null; meta: string | null; t_created: string }>(
        `SELECT rowid, uid, name, meta, t_created FROM node
         WHERE uid = ? AND kind = 'community' AND t_invalid IS NULL`,
        [commUid],
      );
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

      // BUG A fix: was a synchronous rawDb.prepare().all() call.
      const { rows: members } = await adapter.executeAll<{ uid: string; name: string | null; summary: string | null; topic: string | null; importance: number; t_created: string; project_path: string | null; tags: string | null }>(
        `SELECT n.uid, n.name, n.summary, n.topic, n.importance, n.t_created, n.project_path, n.tags
         FROM edge e
         JOIN node n ON n.rowid = e.src
         WHERE e.dst = ? AND e.rel = 'MEMBER_OF'
           AND e.t_invalid IS NULL AND n.t_invalid IS NULL
         ORDER BY n.importance DESC`,
        [commRow.rowid],
      );
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
      // InvalidateParams' t_transition/replacement_uid are `?: string` (no `| undefined`
      // in the member type) — under exactOptionalPropertyTypes the keys must be omitted
      // entirely when absent, not present with an explicit `undefined` value.
      const tTransition = args['t_transition'] as string | undefined;
      const replacementUid = args['replacement_uid'] as string | undefined;
      const wq = await WriteQueue.forPath(dbPath);
      return wq.enqueue('memory_invalidate', async (writeDb) => {
        const result = await memoryInvalidate(writeDb, {
          claim_uid: args['claim_uid'] as string,
          reason: args['reason'] as string,
          ...(tTransition !== undefined ? { t_transition: tTransition } : {}),
          ...(replacementUid !== undefined ? { replacement_uid: replacementUid } : {}),
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
      const wq = await WriteQueue.forPath(dbPath);
      const updateParams = {
        uid,
        content: args['content'] as string | undefined,
        summary: args['summary'] as string | undefined,
        name: args['name'] as string | undefined,
        topic: args['topic'] as string | undefined,
        project_path: args['project_path'] as string | undefined,
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
      // Explicit type argument — see the identical `memory_write` widening note above.
      const updOutcome = await wq.enqueue<{ response: ToolResult; pending: PendingEmbed | null }>('memory_update', async (writeDb) => {
        const a = await memoryUpdatePhaseA(writeDb, updateParams);
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
      schedulePhaseBAndWake(wq, updOutcome.pending ? [updOutcome.pending] : [], { useBinaryFormat: adapter.capabilities.nativeVectors, vectorDialect: await vectorDialectFor(adapter) });
      return updOutcome.response;
    }

    case 'memory_link': {
      // BL-249: memoryLinkNode is `async function` (Promise<LinkResult>) — the enqueue
      // callback MUST await it. Awaiting here does NOT nest a wq.enqueue call inside a
      // running queue task (the re-entrancy hazard write-queue.ts's header warns about);
      // it is a plain await of a non-queue async DB call, which _processNext's `await
      // result` already supports for any queue task (write-queue.ts:684-687).
      const wq = await WriteQueue.forPath(dbPath);
      return wq.enqueue('memory_link', async (writeDb) => {
        const result = await memoryLinkNode(writeDb, args);
        if (result.isError) {
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      });
    }

    // ── P4 NEW TOOL HANDLERS ──────────────────────────────────────────────────

    case 'memory_topics': {
      const result = await memoryListTopics(adapter, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_list_projects': {
      const result = await memoryListProjects(adapter, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_list_entities': {
      const result = await memoryListEntities(adapter, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_entity_episodes': {
      const result = await memoryGetEntityEpisodes(adapter, args);
      if (result.code) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_related': {
      const result = await memoryGetRelated(adapter, args);
      if (result.code) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_supersession_chain': {
      const result = await memoryGetSupersessionChain(adapter, args);
      if (result.code) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_near_duplicates': {
      const result = await memoryGetNearDuplicates(adapter, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    case 'memory_curate': {
      const wq = await WriteQueue.forPath(dbPath);
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
      const result = await memoryGetStats(adapter, args, TOOL_NAMES);
      // BL-334: `memory_stats` is the health/coverage read and is what a CI gate
      // calls. Coverage percentages computed over a store whose indexes are
      // damaged are not merely incomplete, they are misleading — so the
      // integrity verdict travels WITH them rather than only on memory_ping.
      // Additive (HF-3): never rename or remove existing stats fields.
      // Read from `_adapter_meta`, not the in-process registry — see the
      // memory_ping call site for why that registry cannot be read from here.
      const persistedStats = await readIntegrityResult(adapter);
      const integrityView = summarizeIntegrityForStatus(
        persistedStats?.result ?? null,
        persistedStats?.runAtMs ?? null,
        resolveVerifyDepth(false) === 'off',
      );
      const withIntegrity = {
        ...result,
        integrity: integrityView,
        integrity_headline: integrityHeadline(integrityView),
      };
      // BL-401 gap 3: expose the substrate's self-check the same way
      // `integrity` above is exposed — additive, never overwrites an existing
      // field, and best-effort (a telemetry read must never break the stats
      // call a CI gate depends on). Pure in-memory read, zero I/O.
      let telemetrySelfCheckResult: ReturnType<typeof telemetrySelfCheck> | null;
      try {
        telemetrySelfCheckResult = telemetrySelfCheck();
      } catch {
        telemetrySelfCheckResult = null;
      }
      const withTelemetry = {
        ...withIntegrity,
        telemetry_self_check: telemetrySelfCheckResult,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(withTelemetry) }],
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

// ── BL-382: drain constants, re-derived from the CURRENT embed cost ───────────
//
// The 5-minute interval and the 500-row heal window were both sized when an
// embed cost ~6.9s (BL-331 defect 1: every sox launchd unit ran at ProcessType
// Background / pri 4). At that price a 500-row window is ~57 minutes of work and
// batching hard on a slow cadence was the only sane design. After the fix the
// live p50 is 580ms (n=701, backend pid 69947, contended) and the design is
// inverted — measured over that backend's 1209s life:
//
//   embed wall time  482s (39.9% of span)      throughput over span   0.58/s
//   idle gaps >5s    467s (38.6% of span)      throughput in-embed    1.45/s
//
// i.e. 2.5x of the BL-331 recovery was being given back to scheduling idle. The
// 445s gap decomposed with no residual: 145s of runBatchEnrich + the 300s timer.
//
// So the drain gets its own loop (below) rather than riding the enrich tick, and
// these numbers follow from the measured cost rather than the old one:

/** Re-arm delay after a pass that left work behind. Deliberately NOT zero: it
 *  keeps the loop a chain of macrotasks instead of a spin, and leaves air for
 *  foreground reads (BL-345 — measured at 425ms p50 under a 99.9%-CPU heal, the
 *  number this must not regress). */
const DEFAULT_DRAIN_IDLE_MS = 250;
/** Re-arm delay after a pass that found nothing. Costs one indexed COUNT per
 *  period. This is the floor BL-382 requires be kept: it catches work enqueued
 *  by paths that do not wake, and it is the post-restart recovery path. */
const DEFAULT_DRAIN_FLOOR_MS = 30_000;
/** Debounce window for wakeDrain(). N rapid writes inside one window arm exactly
 *  one pass — the coalescing requirement. */
const DEFAULT_DRAIN_WAKE_DEBOUNCE_MS = 250;
/** Rows per drain pass. Was 500, which at 580ms/embed is ~290s of work — so the
 *  240s SOX_EMBED_HEAL_TIME_BUDGET_MS ALWAYS fired and the truncated remainder
 *  of the scan was wasted (observed: "TIME BUDGET EXCEEDED (417 healed, 83
 *  remaining of 500)" on two consecutive ticks). 64 rows is ~37s, comfortably
 *  inside the budget, so a pass completes its window instead of being cut. */
const DEFAULT_DRAIN_BATCH = 64;

function envMs(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const drainIdleMs = () => envMs('SOX_EMBED_DRAIN_IDLE_MS', DEFAULT_DRAIN_IDLE_MS);
const drainFloorMs = () => envMs('SOX_EMBED_DRAIN_FLOOR_MS', DEFAULT_DRAIN_FLOOR_MS);
const drainWakeDebounceMs = () => envMs('SOX_EMBED_DRAIN_WAKE_DEBOUNCE_MS', DEFAULT_DRAIN_WAKE_DEBOUNCE_MS);
const drainBatchLimit = () => envMs('SOX_EMBED_DRAIN_BATCH', DEFAULT_DRAIN_BATCH);
/** BL-348: hard wall-clock budget for the isolated cluster/enrich child
 *  process. A hung child is SIGTERM'd (then SIGKILL'd) at this bound and the
 *  tick moves on — never blocks the parent, never waits indefinitely. */
const DEFAULT_ENRICH_ISOLATION_TIMEOUT_MS = 120_000;
const enrichIsolationTimeoutMs = () => envMs('SOX_ENRICH_ISOLATION_TIMEOUT_MS', DEFAULT_ENRICH_ISOLATION_TIMEOUT_MS);

// BL-413 follow-on (recluster timeout, 2026-08-04): FULL passes get their own,
// larger budget. A full pass (pending memory_curate recluster trigger) is
// intrinsically heavy — O(n²) clustering over the whole corpus + full-corpus
// importance + autolink + materializeClusters (438 communities / 3,591 edges
// measured) — and at launchd service priority with WAL-write contention against
// the parent it exceeded the 120s incremental budget live (enrich.pass.failed
// error:timeout, tick_seq=8, 2026-08-04T00:49:48Z) even though the same pass
// measures 62.6s on a copy at terminal priority. Full passes are rare and
// operator-initiated, so a long budget converts no fast-fail into a slow one
// (the BL-413 warning applied to the INCREMENTAL tick, which keeps the 120s
// default). Env-overridable via SOX_ENRICH_FULL_TIMEOUT_MS.
const DEFAULT_ENRICH_FULL_TIMEOUT_MS = 600_000;
const enrichFullTimeoutMs = () => envMs('SOX_ENRICH_FULL_TIMEOUT_MS', DEFAULT_ENRICH_FULL_TIMEOUT_MS);

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
 * Exported for the BL-172 regression test. Async (StoreAdapter).
 */
export async function completeEnrichTriggerRows(adapter: StoreAdapter, maxSeq: number): Promise<number> {
  if (maxSeq <= 0) return 0;
  const placeholders = ENRICH_TRIGGER_OPS.map(() => '?').join(',');
  const now = new Date().toISOString();
  const res = await adapter.executeRun(
    `UPDATE organizer_queue
       SET claimed_at = COALESCE(claimed_at, ?),
           done_at = ?,
           attempts = attempts + 1
     WHERE done_at IS NULL AND seq <= ? AND op IN (${placeholders})`,
    [now, now, maxSeq, ...ENRICH_TRIGGER_OPS],
  );
  return res.rowsAffected;
}

/** BL-172: max open trigger-row seq — the pre-pass snapshot boundary. Async (StoreAdapter). */
export async function maxOpenEnrichTriggerSeq(adapter: StoreAdapter): Promise<number> {
  const placeholders = ENRICH_TRIGGER_OPS.map(() => '?').join(',');
  const row = await adapter.executeGet<{ m: number }>(
    `SELECT COALESCE(MAX(seq), 0) AS m FROM organizer_queue
     WHERE done_at IS NULL AND op IN (${placeholders})`,
    [...ENRICH_TRIGGER_OPS],
  );
  return row?.m ?? 0;
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
 *   2. BL-348: clustering/importance/auto-link (`runBatchEnrich`) runs in an
 *      ISOLATED CHILD PROCESS (`runEnrichIsolated`), never in-process. A throw,
 *      hang, or crash inside it can never block this process's event loop and
 *      can never touch a written vector — there is no shared connection, no
 *      shared promise chain. `ok: false` is a normal, non-fatal outcome here:
 *      it is logged and the tick moves on, exactly like a heal failure always
 *      has. Do NOT re-inline `runBatchEnrich(adapter, ...)` on this path —
 *      that is the exact defect BL-348 exists to remove (see
 *      `enrich-process-host.ts` for why in-process execution is unsafe).
 *   3. BL-172 drain: snapshot the open trigger rows this pass will satisfy, run
 *      the pass, then complete them through the async StoreAdapter — ONLY on a
 *      successful isolated pass; a failed pass must not falsely report
 *      trigger rows as done.
 *   4. BL-186: if a full-pass `enrich` row (memory_curate recluster) is pending
 *      INSIDE the snapshot window, the pass runs with incrementalCluster:false
 *      — the honest fulfilment of `{enqueued: true}`. A full-pass row enqueued
 *      after the snapshot stays open and drives the next tick.
 *
 * @param adapter Open StoreAdapter (works on both SqliteAdapter sync and
 *                TursoAdapter async — the previous unwrap-then-call-sync-pattern
 *                was Turso-incompatible because Turso's prepare().get() returns
 *                a Promise, not a synchronous value).
 */
export async function runEnrichPassOnDb(
  adapter: StoreAdapter,
  dbPath: string,
  opts: { acquireHealSlot?: boolean } = {},
): Promise<{
  queue_completed: number;
  full_pass: boolean;
  healed: number;
  heal_failed: number;
  cluster_ok: boolean;
  cluster_error?: string;
}> {
  // Logging follow-on (2026-07-30, from the embed-backfill-stampede incident):
  // a frozen backlog with embeds_completed climbing was the exact signature
  // of the bug, and it took six agents to diagnose because backlog_before/
  // backlog_after were never logged side by side. Cheap (embedBacklogStats is
  // a single indexed COUNT(*) scan) — safe to call twice per pass.
  const backlogBefore = (await embedBacklogStats(adapter)).count;

  // BL-382: the heal here is now a BACKSTOP, not the drain. The dedicated drain
  // loop below normally keeps the backlog at zero, so this scan usually returns
  // nothing. It keeps the same bounded window as the drain — the old default of
  // 500 rows is ~290s of embedding at the measured 580ms p50, which is what made
  // a single enrich tick take 385s (240s of it heal, cut off by the time budget
  // with 83 rows of the window unprocessed).
  //
  // BL-348: this is now the ONLY thing the background slot guards on the
  // enrich-tick side (narrowed from the whole tick, which used to also hold
  // the slot across the entire in-process runBatchEnrich call). It still
  // needs the slot because it runs the SAME `NOT EXISTS vec_node` scan the
  // drain runs — two concurrent scans over that window is the BL-346
  // stampede, unrelated to clustering isolation and not fixed by moving
  // clustering off-process.
  //
  // `acquireHealSlot` defaults true (real production/guarded-tick behaviour).
  // enrich-reentrancy.spec.ts passes false deliberately: that suite proves
  // the REENTRANCY GUARD (`_enrichPassInFlight`) in isolation by calling the
  // raw, unguarded `runPeriodicEnrichPass()` concurrently with itself — a
  // DIFFERENT hazard than the cross-loop (drain vs enrich) exclusion this
  // slot exists for, already covered by drain-wake.spec.ts. Taking the slot
  // unconditionally here would make even the deliberately-unguarded raw path
  // slot-exclusive, which defeats that suite's ability to reproduce the race
  // it exists to prove.
  const wq = await WriteQueue.forPath(dbPath);
  const acquireHealSlot = opts.acquireHealSlot ?? true;
  const heal = acquireHealSlot
    ? await withBackgroundSlot('enrich-heal', () => healMissingVectors(adapter, wq, { limit: drainBatchLimit() }))
    : await healMissingVectors(adapter, wq, { limit: drainBatchLimit() });

  const maxSeq = await maxOpenEnrichTriggerSeq(adapter);
  const fullPass = await hasPendingFullEnrich(adapter, maxSeq);

  // BL-348: isolated child process — see runEnrichIsolated's own doc for why
  // this never throws/rejects, even when the child crashes or times out.
  // BL-413 follow-on: a pending full-enrich trigger (memory_curate recluster)
  // gets the full-pass budget; routine incremental ticks keep the 120s default.
  const isolated = await runEnrichIsolated(
    dbPath,
    { incrementalCluster: !fullPass },
    fullPass ? enrichFullTimeoutMs() : enrichIsolationTimeoutMs(),
  );

  const queueCompleted = isolated.ok ? await completeEnrichTriggerRows(adapter, maxSeq) : 0;
  const backlogAfter = (await embedBacklogStats(adapter)).count;

  if (isolated.ok) {
    const result = isolated.result;
    // BL-413 follow-on: durable sink, not console.error — the pre-fix stderr
    // lines never reached the JSONL, which made the 22.5h enrich stall
    // invisible to telemetry-based triage.
    log.info('enrich.pass.finish', {
      db_path: dbPath,
      communities_upserted: result.communities_upserted,
      cluster_incremental_joined: result.incremental_joined,
      // BL-328/PKT-30: the τ this partition was ACTUALLY produced at, and why.
      // The child has always returned these; this line used to drop them, so
      // the only durable evidence a pass left behind was a cluster count —
      // identical whether calibration ran and chose the floor or never ran at
      // all. That ambiguity cost three sessions on 2026-08-05, when a genuine
      // calibrated full pass (τ=0.87, reason 'floor', projected mean degree
      // 1.98977 of a 2.0 budget) was read as "calibration is inert in
      // production" because its log line said nothing either way.
      //
      // `?? null` rather than omission, deliberately: an ABSENT field is
      // indistinguishable from "not instrumented" (the BL-319/347/376/378
      // failure shape, and this defect's own). A `null` is a positive claim
      // that this pass did not calibrate — which is correct and expected on
      // the incremental path, where only a full pass recomputes τ.
      cluster_calibration: result.cluster_calibration ?? null,
      cluster_effective_threshold: result.cluster_effective_threshold ?? null,
      cluster_guard_retries: result.cluster_guard_retries ?? null,
      importance_updated: result.importance_updated,
      relates_to_edges: result.relates_to_edges,
      queue_completed: queueCompleted,
      full_pass: fullPass,
      embed_healed: heal.healed,
      embed_heal_failed: heal.failed,
      backlog_before: backlogBefore,
      backlog_after: backlogAfter,
      backlog_delta: backlogAfter - backlogBefore,
      embed_heal_disabled: heal.disabled,
    });
  } else {
    // BL-348: the entire point — a failed cluster pass is logged and moved
    // past, never allowed to touch the embed backlog it shares this tick
    // with. embed_healed/backlog above already ran and landed successfully
    // BEFORE this isolated call, unaffected by its outcome.
    log.error('enrich.pass.failed', {
      db_path: dbPath,
      error: isolated.error,
      embed_healed: heal.healed,
      backlog_before: backlogBefore,
      backlog_after: backlogAfter,
    });
  }

  // BL-413: take a DURABLE, RECORDED corrective action when the queue is
  // actually stalled — not just report the string. `memory_ping`'s
  // `enrichment.state: "stalled"` verdict was accurate for 90 consecutive
  // 15-minute windows on the live server (queue_depth 46, queue_last_done_at
  // 22.5h stale) and NOTHING consumed it: the only trace was the
  // `console.error` calls above, which are stderr-only and never reach
  // durable telemetry. This check runs the SAME stall predicate memory_ping
  // uses (computeEnrichmentHealth) immediately after every tick and, when
  // stalled, persists an escalation record (sox_store_meta, survives process
  // restarts) plus a durable `enrich.stall.escalated` telemetry event — see
  // enrich-stall.ts for the full rationale. Failure here must never fail the
  // tick itself; it is pure bookkeeping on top of work that already happened.
  try {
    const qRow = await adapter.executeGet<{ q: number }>(
      'SELECT COUNT(*) AS q FROM organizer_queue WHERE done_at IS NULL',
    );
    const oldRow = await adapter.executeGet<{ o: string | null }>(
      'SELECT MIN(enqueued) AS o FROM organizer_queue WHERE done_at IS NULL',
    );
    const doneRow = await adapter.executeGet<{ d: string | null }>(
      'SELECT MAX(done_at) AS d FROM organizer_queue',
    );
    const queueDepth = qRow?.q ?? 0;
    const oldestPendingAt = oldRow?.o ?? null;
    const lastDoneAt = doneRow?.d ?? null;
    const health = computeEnrichmentHealth(queueDepth, oldestPendingAt, lastDoneAt, Date.now());
    const escalation = await checkAndEscalateEnrichStall(adapter, dbPath, {
      state: health.state,
      queueDepth,
      oldestPendingAt,
      lastDoneAt,
      lastIsolatedError: isolated.ok ? null : isolated.error,
    });
    if (escalation) {
      console.error(
        `[memory-server] enrich.stall.escalated (${dbPath}): ` +
        `consecutive_stalled_ticks=${escalation.consecutive_stalled_ticks} ` +
        `queue_depth=${escalation.queue_depth} last_isolated_error=${escalation.last_isolated_error ?? 'none'}`,
      );
    }
  } catch (err) {
    console.error(`[memory-server] enrich.stall escalation bookkeeping error (${dbPath}):`, err);
  }

  return {
    queue_completed: queueCompleted,
    full_pass: fullPass,
    healed: heal.healed,
    heal_failed: heal.failed,
    cluster_ok: isolated.ok,
    ...(isolated.ok ? {} : { cluster_error: isolated.error }),
  };
}

/**
 * Run one in-process enrichment pass over all open DBs. Exported (test seam
 * only — see enrich-reentrancy.spec.ts) so the pre-fix stampede behaviour can
 * be reproduced directly: calling this UNGUARDED function concurrently is
 * exactly the bug (overlapping ticks racing the same `NOT EXISTS vec_node`
 * scan). Production code path is `runPeriodicEnrichPassGuarded()` below,
 * which never allows two calls in flight at once.
 */
export async function runPeriodicEnrichPass(opts: { acquireHealSlot?: boolean } = {}): Promise<void> {
  if (openedPaths.size === 0) return;

  for (const dbPath of openedPaths) {
    try {
      const adapter = await getDb(dbPath);
      await runEnrichPassOnDb(adapter, dbPath, opts);
    } catch (err) {
      // Durable sink — never stdout (JSON-RPC channel). The pre-fix
      // console.error version made a per-DB enrich failure invisible to
      // telemetry (BL-413 follow-on).
      log.error('enrich.pass.error', {
        db_path: dbPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Reentrancy guard (root-cause fix — embed backfill self-stampede) ──────────
//
// PROVEN INCIDENT: the bare `setInterval(() => void runPeriodicEnrichPass(),
// 5min)` below had ZERO reentrancy guard. A single pass (healMissingVectors'
// sequential 500-row scan through ONE shared fastembedProcessHost.js child
// process) routinely takes far longer than 5 minutes at real throughput. The
// next tick fired anyway, re-ran the SAME `ORDER BY n.rowid ASC LIMIT 500`
// scan (embed-pipeline.ts's NOT EXISTS predicate hadn't advanced because the
// first pass's applies hadn't landed yet), and queued a second full round of
// embeds for the SAME head-of-queue rows behind the first on that one child
// process — compounding every 5 minutes forever. Confirmed live: whichever
// tick finished first landed the row; every other overlapping tick finished
// ~25 min later, hit applyEmbedding's exists-check, and discarded its work as
// 'exists'. Net effect: embed_backlog frozen at 4241 for five weeks while one
// child process burned 650 CPU-minutes to land 169 vectors.
//
// THE FIX: a self-rescheduling setTimeout chain (never setInterval) gated by
// an in-flight flag. The next tick is scheduled ONLY after the current pass
// has fully settled (success or error) — ticks can never overlap, by
// construction (not just "usually don't"). If some other caller manages to
// invoke the guarded entrypoint while a pass is already running (defensive:
// nothing in this codebase does today), the extra invocation is skipped and
// counted rather than silently discarded, so an operator can see the guard
// working via getEnrichPassSkipCount().
//
// FORWARD PROGRESS: with overlap eliminated, each tick's healMissingVectors
// scan (embed-pipeline.ts:582-592, `NOT EXISTS (SELECT 1 FROM vec_node v
// WHERE v.node_id = n.rowid) ORDER BY n.rowid ASC LIMIT 500`) genuinely
// advances: every row the PREVIOUS pass applied now has a vec_node row and is
// excluded from the next SELECT, so the next tick's LIMIT 500 window is a
// disjoint, later slice of the backlog — never a re-fetch of the same head.
// This holds even when a pass is cut short by SOX_EMBED_HEAL_TIME_BUDGET_MS:
// the rows it DID apply before the budget triggered are still excluded next
// time; only the genuinely-unprocessed remainder is re-scanned.

let _enrichPassInFlight = false;
let _enrichTicksSkipped = 0;

/** Exposed for tests/observability — never reset except by module reload. */
export function getEnrichPassSkipCount(): number {
  return _enrichTicksSkipped;
}

/** True while a periodic enrich pass is currently executing. Test seam. */
export function isEnrichPassInFlight(): boolean {
  return _enrichPassInFlight;
}

/**
 * Monotonic tick counter — logged as `tick_seq` on every `enrich.tick.start`/
 * `.finish`/`.skipped` line. Logging follow-on (2026-07-30): two `.start`
 * lines with no `.finish` between them, at the SAME tick_seq boundary rule
 * (a `.start` must be followed by exactly one `.finish` or `.skipped` before
 * the next `.start`), makes reentrancy visible by log inspection alone —
 * this is the signal that would have exposed the stampede on day one, before
 * the reentrancy guard even existed.
 */
let _enrichTickSeq = 0;

/**
 * Reentrancy-guarded entrypoint: runs `runPeriodicEnrichPass()` unless a pass
 * is already in flight, in which case the call is a documented no-op (counted,
 * logged to stderr — never silent). Exported so tests can invoke it directly
 * without waiting on the real 5-minute timer, and so it can be called
 * concurrently in a test to prove overlap is impossible.
 */
export async function runPeriodicEnrichPassGuarded(): Promise<void> {
  const tickSeq = ++_enrichTickSeq;
  // The slot is acquired AFTER the skip check, deliberately: a second concurrent
  // enrich call must still be turned away as a skip rather than queue behind the
  // first (that is the BL-346 anti-stampede contract, and enrich-reentrancy.spec
  // asserts it). See withBackgroundSlot for why the two guards are different
  // mechanisms rather than one.
  if (_enrichPassInFlight) {
    _enrichTicksSkipped++;
    log.warn('enrich.tick.skipped', { tick_seq: tickSeq, skipped_total: _enrichTicksSkipped });
    return;
  }
  _enrichPassInFlight = true;
  const tickStartedAt = Date.now();
  log.info('enrich.tick.start', { tick_seq: tickSeq });
  try {
    // BL-348: NOT wrapped in withBackgroundSlot any more. The clustering work
    // inside runPeriodicEnrichPass -> runEnrichPassOnDb now runs off-process
    // (runEnrichIsolated) and must be able to run concurrently with the
    // drain — that concurrency is the whole point of the isolation boundary.
    // Only the heal step inside runEnrichPassOnDb (which touches the SAME
    // vec_node scan the drain uses) still takes the slot, narrowly, for the
    // BL-346 anti-stampede reason documented at withBackgroundSlot's
    // definition below.
    await runPeriodicEnrichPass();
    log.info('enrich.tick.finish', { tick_seq: tickSeq, duration_ms: Date.now() - tickStartedAt });
  } catch (err) {
    log.error('enrich.tick.error', {
      tick_seq: tickSeq,
      duration_ms: Date.now() - tickStartedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    _enrichPassInFlight = false;
  }
}

// ── BL-382 / BL-348: the background slot — NARROWED, retained for one purpose ─
//
// RETAINED, NOT DELETED, but for a much narrower job than before. Before
// BL-348 this mutex wrapped the ENTIRE enrich tick, including the in-process
// `runBatchEnrich` clustering pass, which is exactly what made the drain and
// clustering mutually exclusive by construction — the defect BL-348 closes.
//
// Clustering (`runBatchEnrich`) no longer touches this slot at all: it runs
// in an isolated child process via `runEnrichIsolated` (enrich-isolation.ts),
// entirely outside the enrich tick's slot-held critical section. It can now
// run FULLY CONCURRENTLY with the drain — that concurrency is BL-348's point.
//
// What the slot still guards: the drain's `healMissingVectors` pass and the
// enrich tick's own BACKSTOP `healMissingVectors` call (see `runEnrichPassOnDb`,
// holder `'enrich-heal'`) both scan the SAME `NOT EXISTS vec_node ... LIMIT n`
// window on the SAME in-process connection. Two concurrent scans over that
// window is the BL-346 stampede — a real hazard, unrelated to clustering, and
// not fixed by moving clustering off-process. That narrow exclusion is all
// that remains behind this mutex.
//
// This is a MUTEX, not a guard: a caller waits for the slot rather than being
// turned away.
//
// The per-loop in-flight guards above/below are a DIFFERENT mechanism and both
// are needed. The guard answers "is another copy of ME already running?" (skip);
// the mutex answers "is the OTHER heal scan running?" (wait). Collapsing them
// into one would either let two enrich ticks queue up (re-creating the stampede
// with extra steps) or make the drain skip work it should merely defer.
let _bgSlot: Promise<void> = Promise.resolve();
let _bgSlotHolder: string | null = null;

/**
 * Run `fn` with exclusive use of the background slot.
 *
 * ⚠️ NEVER call this from inside another background-slot body, and never from
 * inside a WriteQueue task. Both are self-deadlocks — the inner call waits on a
 * slot only the outer call can release. Nesting is detected and thrown rather
 * than hung: a loud failure is worth far more than the silent forever-hang that
 * BL-154 produced (`memory_write` of >2000 chars enqueued from inside a task
 * already holding that same serial queue, and simply never returned).
 */
async function withBackgroundSlot<T>(holder: string, fn: () => Promise<T>): Promise<T> {
  const prev = _bgSlot;
  let release!: () => void;
  _bgSlot = new Promise<void>((r) => (release = r));
  await prev;
  if (_bgSlotHolder !== null) {
    release();
    throw new Error(
      `[memory-server] BL-382 background-slot re-entrancy: "${holder}" acquired while ` +
      `"${_bgSlotHolder}" still holds it. This is the BL-154 deadlock shape — never ` +
      `acquire the slot from inside another slot body or a WriteQueue task.`,
    );
  }
  _bgSlotHolder = holder;
  try {
    return await fn();
  } finally {
    _bgSlotHolder = null;
    release();
  }
}

/** Test seam: which loop currently holds the background slot, or null. */
export function backgroundSlotHolder(): string | null {
  return _bgSlotHolder;
}

// ── BL-382: the embed drain ───────────────────────────────────────────────────
//
// Split out of the enrich tick. Before this, draining one 500-row window meant
// paying ~145s of runBatchEnrich in the same tick and then sleeping 300s —
// measured on pid 69947 as a 445s gap between the last embed of one pass and the
// first of the next, decomposing with no residual into those two terms.
//
// Now the drain reschedules on its OWN backlog: work remaining -> re-arm in
// 250ms; backlog empty -> re-arm at the 30s floor. The floor is kept (BL-382
// requirement 2) because it catches work enqueued by paths that never call
// wakeDrain, and because it is the recovery path after a restart.

let _drainInFlight = false;
/** Set when a wake arrives while a pass is running: the pass re-arms
 *  immediately on completion instead of dropping the signal. Without this a
 *  write landing mid-pass would wait for the floor. */
let _drainDirty = false;
let _drainSeq = 0;
let _drainWakeTimer: ReturnType<typeof setTimeout> | null = null;
let _drainNextTimer: ReturnType<typeof setTimeout> | null = null;
/** Consecutive passes that healed nothing while the backlog was non-empty.
 *  Drives exponential backoff — without it, a window of permanently-failing
 *  rows (e.g. the embed provider is down) would spin at the 250ms idle delay
 *  forever, re-attempting the same rows and burning the machine. */
let _drainNoProgress = 0;
/** Latched when a pass reports the SOX_DISABLE_EMBED_HEAL brake: the chain
 *  stops rather than waking every 30s to do nothing. Keyed off the RESULT, not
 *  a second copy of the env check — BL-344's lesson about duplicated policy. */
let _drainDisabled = false;
let _drainWakesCoalesced = 0;
/** Whether the last completed pass left work behind — drives the re-arm delay. */
let _drainBacklogRemaining = false;

/** Test/observability seam — how many wakes were folded into an existing pass
 *  or an already-armed timer instead of scheduling their own. */
export function getDrainWakesCoalesced(): number {
  return _drainWakesCoalesced;
}
/** True while a drain pass is executing. Test seam. */
export function isDrainPassInFlight(): boolean {
  return _drainInFlight;
}
/** Monotonic count of drain passes actually STARTED — the coalescing assertion
 *  reads this: N wakes must advance it by exactly 1, never by N. */
export function getDrainPassCount(): number {
  return _drainSeq;
}

/**
 * One drain pass over every open store: heal missing vectors ONLY. No
 * clustering, no importance, no queue-trigger completion — those belong to the
 * enrich tick and coupling them to the drain is what BL-382 measured as 145s of
 * dead time per drained window.
 *
 * Returns whether any store still has backlog, so the caller can decide the
 * re-arm delay. Never throws.
 */
async function runDrainPass(): Promise<{ backlogRemaining: boolean; healed: number; disabled: boolean }> {
  let backlogRemaining = false;
  let healed = 0;
  let disabled = false;
  for (const dbPath of openedPaths) {
    try {
      const adapter = await getDb(dbPath);
      const wq = await WriteQueue.forPath(dbPath);
      const heal = await healMissingVectors(adapter, wq, { limit: drainBatchLimit() });
      if (heal.disabled) {
        disabled = true;
        continue;
      }
      healed += heal.healed;
      const after = await embedBacklogStats(adapter);
      if (after.count > 0) backlogRemaining = true;
      if (heal.scanned > 0) {
        console.error(
          `[memory-server] drain (${dbPath}):` +
          ` scanned=${heal.scanned} healed=${heal.healed} exists=${heal.exists}` +
          ` gone=${heal.gone} failed=${heal.failed} backlog_after=${after.count}` +
          (heal.time_budget_exceeded ? ' time_budget_exceeded=true' : ''),
        );
      }
    } catch (err) {
      // stderr only — never stdout ([inv:no-stdout-diagnostics]).
      console.error(`[memory-server] drain error (${dbPath}):`, err);
    }
  }
  return { backlogRemaining, healed, disabled };
}

/** (BL-472) The currently in-flight drain pass, or null. Lets shutdown await
 *  the SAME pass `isDrainPassInFlight()` reports as a boolean, without
 *  polling. Cleared in the pass's own .finally(), same lifetime as
 *  `_drainInFlight`. */
let _drainInFlightPromise: Promise<void> | null = null;

/** (BL-472) Resolve when the currently in-flight drain pass (if any) settles.
 *  Resolves immediately if none is running. Never throws — mirrors
 *  runDrainPassGuarded's own never-throws contract. Available to shutdown
 *  paths; see backend.ts coordinatedShutdown step 0. */
export function waitForDrainSettled(): Promise<void> {
  return _drainInFlightPromise ?? Promise.resolve();
}

/**
 * Reentrancy-guarded drain entrypoint. A concurrent call does NOT queue and is
 * NOT dropped — it sets the dirty flag so the in-flight pass re-arms immediately
 * on completion. Exported so tests can drive it without the timer.
 */
export function runDrainPassGuarded(): Promise<void> {
  if (_drainInFlight) {
    _drainDirty = true;
    _drainWakesCoalesced++;
    return Promise.resolve();
  }
  _drainInFlight = true;
  const seq = ++_drainSeq;
  const startedAt = Date.now();
  const p = (async () => {
    try {
      const r = await withBackgroundSlot('drain', () => runDrainPass());
      if (r.disabled) {
        _drainDisabled = true;
        console.error(
          '[memory-server] embed drain DISABLED via SOX_DISABLE_EMBED_HEAL=1 ' +
          '(BL-339 stopgap — the embed backlog will not drain)',
        );
        return;
      }
      // Forward-progress accounting: backlog with zero healed means this window
      // is stuck, not merely large.
      if (r.backlogRemaining && r.healed === 0) _drainNoProgress++;
      else _drainNoProgress = 0;
      if (r.healed > 0) {
        console.error(
          `[memory-server] drain.finish seq=${seq} healed=${r.healed}` +
          ` duration_ms=${Date.now() - startedAt} backlog_remaining=${r.backlogRemaining}`,
        );
      }
      _drainBacklogRemaining = r.backlogRemaining;
    } catch (err) {
      console.error(
        `[memory-server] drain.error seq=${seq} duration_ms=${Date.now() - startedAt}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      _drainNoProgress++;
    } finally {
      _drainInFlight = false;
    }
  })();
  _drainInFlightPromise = p;
  void p.finally(() => {
    if (_drainInFlightPromise === p) _drainInFlightPromise = null;
  });
  return p;
}

/** Delay before the next drain pass: short while there is work, the floor when
 *  there is not, backing off exponentially when passes stop making progress. */
function nextDrainDelayMs(): number {
  const floor = drainFloorMs();
  if (!_drainBacklogRemaining && !_drainDirty) return floor;
  if (_drainNoProgress > 0) {
    return Math.min(floor, drainIdleMs() * 2 ** Math.min(_drainNoProgress, 10));
  }
  return drainIdleMs();
}

/**
 * Self-rescheduling drain chain. Same shape as the enrich chain — a setTimeout
 * armed only once the previous pass has fully settled, never a setInterval, so
 * two passes can never stack.
 */
function scheduleNextDrain(): void {
  if (_drainDisabled) return;
  if (_drainNextTimer !== null) clearTimeout(_drainNextTimer);
  const delay = nextDrainDelayMs();
  _drainDirty = false;
  _drainNextTimer = setTimeout(() => {
    _drainNextTimer = null;
    void runDrainPassGuarded().finally(scheduleNextDrain);
  }, delay);
  if (typeof _drainNextTimer.unref === 'function') _drainNextTimer.unref();
}

/**
 * Wake the drain — debounced and coalescing (BL-382 requirement 1).
 *
 * ⚠️ BL-154 SAFETY. The deadlock shape BL-154 records is hold-and-wait on one
 * serial queue: a task holding the WriteQueue slot calls `wq.enqueue` and waits
 * for a slot only it can release. `memory_write` with >2000 chars hung forever
 * that way. A naive "writes wake the queue" implementation walks straight into
 * it, so the safety here rests on THREE independent properties, not one:
 *
 *   (a) Call site. Every caller sits AFTER `await wq.enqueue(...)` has resolved
 *       — the same audit point that already licenses schedulePendingEmbeds.
 *   (b) THIS FUNCTION NEVER RUNS WORK. It only arms a timer. Even if some future
 *       caller invokes it from inside a queue task, the pass body runs on a
 *       later macrotask, by which time that task's await chain has resumed and
 *       released the slot. This is the load-bearing property: it makes safety
 *       independent of every call site's discipline, which (a) alone cannot
 *       promise. A call-site convention is exactly what let BL-344's allowlist
 *       diverge across six copies.
 *   (c) The guard never touches the queue. `_drainInFlight` short-circuits to a
 *       flag; it neither awaits nor holds a WriteQueue slot, so it cannot be a
 *       node in a wait cycle.
 *
 * Do NOT call this from inside applyEmbedding or any wq.enqueue callback. It
 * would still be safe by (b), but it would also self-trigger from the drain's
 * own applies — see the `backlogRemaining` rule that stops that loop.
 */
export function wakeDrain(reason: string): void {
  if (_drainDisabled) return;
  if (_drainInFlight) {
    // Fold into the running pass's tail rather than arming a redundant timer.
    _drainDirty = true;
    _drainWakesCoalesced++;
    return;
  }
  if (_drainWakeTimer !== null) {
    // Already armed inside the debounce window — N rapid writes, one pass.
    _drainWakesCoalesced++;
    return;
  }
  _drainWakeTimer = setTimeout(() => {
    _drainWakeTimer = null;
    if (_drainNextTimer !== null) {
      clearTimeout(_drainNextTimer);
      _drainNextTimer = null;
    }
    void runDrainPassGuarded().finally(scheduleNextDrain);
  }, drainWakeDebounceMs());
  if (typeof _drainWakeTimer.unref === 'function') _drainWakeTimer.unref();
  void reason;
}

/**
 * BL-382: run Phase B for a write's pendings and wake the drain.
 *
 * Called at the audit point that is already OUTSIDE the WriteQueue slot — the
 * Phase-A task has resolved by the time this is reachable, which is the same
 * property that has always licensed the bare schedulePendingEmbeds call here.
 *
 * Two wakes, for two different reasons:
 *   - unconditional, on the write itself — covers the crash-between-phases case,
 *     which leaves a vectorless row that ONLY the drain will ever find. Cheap: a
 *     pass over an empty backlog is one indexed COUNT.
 *   - on Phase-B failure — the only write-side path that actually creates drain
 *     work in a healthy process. schedulePendingEmbeds never throws; per-item
 *     failures come back in `failed` and are otherwise left for the heal.
 *
 * Both are debounced and coalescing, so N rapid writes arm ONE pass (BL-382
 * requirement 1), and neither can re-enter the write queue (see wakeDrain).
 */
function schedulePhaseBAndWake(
  wq: WriteQueue,
  pendings: PendingEmbed[],
  opts: { useBinaryFormat: boolean; vectorDialect: VectorDialect },
): void {
  if (pendings.length === 0) return;
  wakeDrain('write');
  void schedulePendingEmbeds(wq, pendings, opts)
    .then((r) => {
      if (r.failed > 0) wakeDrain('phase-b-failure');
    })
    .catch(() => {
      // schedulePendingEmbeds documents that it never throws; if that ever
      // changes, the vectors are missing and the drain is exactly the repair.
      wakeDrain('phase-b-throw');
    });
}

/**
 * (BL-339 / BL-346) Emergency brake for the periodic enrich tick.
 *
 * STOPGAP, NOT A FIX. On 2026-07-31 the live store was read-unavailable for
 * 15+ minutes with ZERO client load: the process stayed alive, burned CPU in
 * 2-53% bursts, and answered not one request. `SOX_DISABLE_EMBED_HEAL=1` was
 * confirmed active in that process, so the embed backfill was NOT the cause —
 * this tick was. Disabling one background job simply handed the starvation to
 * the next one.
 *
 * The real defect is that ANY in-process background work starves every
 * foreground read: there is no concurrency model, no yield point, and no
 * admission control (see BL-331/BL-334/BL-339/BL-345 and the Gap-2 resource-governance
 * design in docs/ideas/themes-2-4-architecture.md). Adding a per-job disable
 * flag is whack-a-mole across every background job that exists or ever will —
 * it is here only so the service can stay READABLE until governance lands.
 *
 * Setting this to '1' means enrichment/clustering never runs: no communities,
 * no importance updates, no relates_to edges. Availability over completeness.
 */
function periodicEnrichDisabled(): boolean {
  return process.env['SOX_DISABLE_PERIODIC_ENRICH'] === '1';
}

function scheduleNextEnrichTick(): void {
  if (periodicEnrichDisabled()) {
    process.stderr.write(
      '[memory-server] periodic enrich DISABLED via SOX_DISABLE_PERIODIC_ENRICH=1 ' +
      '(BL-346 stopgap — enrichment/clustering will not run)\n',
    );
    return;
  }
  const timer = setTimeout(() => {
    void runPeriodicEnrichPassGuarded().finally(scheduleNextEnrichTick);
  }, PERIODIC_ENRICH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

scheduleNextEnrichTick();
// BL-382: the drain's own chain. Independent of the enrich tick's interval —
// they share only the background slot. The first pass is armed at the floor, so
// a restart with a non-empty backlog starts draining within 30s rather than 5min.
scheduleNextDrain();

// BL-405: the 5-min compaction tick (PRAGMA optimize + ANALYZE + WAL
// checkpoint) was exported from memory-core but NEVER started here — the only
// checkpoint path was the WriteQueue idle checkpoint, which itself never fired
// on the Turso _noop path (write-queue.ts enqueue() early-returned before
// _scheduleIdleCheckpoint). Result: memory_ping.store.last_checkpoint_at stayed
// null forever in production and the WAL grew until restart. Self-rescheduling
// chain (mirrors the enrich tick); no-ops until a store is opened. Telemetry
// via the durable sink so the cadence is visible in the JSONL.
function scheduleNextCompactionTick(): void {
  const timer = setTimeout(() => {
    void (async () => {
      for (const dbPath of openedPaths) {
        try {
          const adapter = await getDb(dbPath);
          await runCompactionPass(adapter, {
            log: (msg) => log.info('compaction.pass', { db_path: dbPath, detail: msg }),
          });
        } catch (err) {
          log.error('compaction.pass.error', {
            db_path: dbPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })().finally(scheduleNextCompactionTick);
  }, DEFAULT_COMPACTION_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}
scheduleNextCompactionTick();

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

// BL-404: the exact options this process's composition root passes to
// initTelemetry() below. Exported (not an inline literal at the call site) so
// bl404-telemetry-composition-root.spec.ts can assert against the real
// production value directly — a drift here (e.g. someone flips `role` back to
// a literal 'test' for local debugging and forgets to revert) fails the test
// against the SAME object the entrypoint actually uses, not a copy-pasted
// duplicate that could silently drift out of sync.
export const MEMORY_SERVER_TELEMETRY_INIT_OPTIONS: InitTelemetryOptions = {
  service: 'memory-server',
  role: 'live-service',
  logSink: 'file',
};

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

  // BL-404: this is the telemetry composition root. Before this fix, NOTHING
  // outside a spec file ever called initTelemetry() — every emitter (memory-core,
  // store-adapter's withRetry() instrumentation) ran against the module-level
  // fallback state in @adhd/sox-telemetry's runtime.ts: logSink:'none' (the
  // DurableJsonlSink was never constructed — the BL-365 crash-durability
  // guarantee protected a sink production never instantiated) and role:'test'
  // (defeating BL-353's separation of the live-service population from test/
  // harness populations on the same disk). Called here — the earliest point in
  // BOTH run modes below (backend-proxy AND direct-stdio), before either can
  // dispatch a single tool call — so every emission for the rest of this
  // process's life carries role:'live-service' and lands durably on disk.
  // Never gated behind the --emit-schema branch above: that path is a one-shot
  // build-time schema dump that exits immediately and never serves a request.
  initTelemetry(MEMORY_SERVER_TELEMETRY_INIT_OPTIONS);

  // BL-89: proactively warm the real embedding backend at startup so a missing/broken
  // embedding runtime is reported LOUDLY at boot (stderr + memory_ping.last_embed_error).
  // Fire-and-forget: warmupEmbed() throws on failure (no degraded fallback — BL-250: the
  // hash backend was removed, EmbedBackend = 'auto' | 'real' only), which we log
  // prominently (the server keeps serving non-embed tools, but the failure is
  // unmissable). Never writes to stdout (the JSON-RPC channel).
  // setImmediate defers to the next event loop tick so the MCP transport starts serving
  // before the synchronous portion of ONNX model loading blocks the event loop.
  setImmediate(() => {
    void warmupEmbed().then(
    (h) => {
      if (h.state === 'real') {
        process.stderr.write(`[memory-server] embeddings: real model active (${h.model})\n`);
      }
    },
    (err) => {
      process.stderr.write(
        `[memory-server] DEGRADED: SOX_EMBED_BACKEND=real but embedding warmup failed: ${String(err)}\n`,
      );
    },
  );
  });

  // BL-94: probe the configured adapter's native binding at startup before accepting
  // connections. A missing binding would otherwise fail mid-session after an agent has
  // already written several episodes — the crash is destructive.
  // This probe exits 1 immediately with a clear message so the supervisor can restart.
  const probeDriver = process.env.STORE_ADAPTER === 'turso' ? '@tursodatabase/database' : 'better-sqlite3';
  try {
    require(probeDriver);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `FATAL: ${probeDriver} native binding missing for this Node.js ABI.\n` +
      (probeDriver === 'better-sqlite3'
        ? `Run: pnpm rebuild better-sqlite3 from the sox-ecosystem root, then restart.\n`
        : `Run: pnpm add ${probeDriver}, then restart.\n`) +
      `Error: ${msg}\n`,
    );
    process.exit(1);
  }

  // ── Pre-restart auto-backup (BL-313) ────────────────────────────────────────
  //
  // Before the process exits on SIGTERM or SIGINT, create a timestamped VACUUM
  // INTO backup of the active database. The backup is idempotent: if the source
  // has not changed since the last backup, it is skipped.
  //
  // The handler runs async (backup via VACUUM INTO) and then calls process.exit.
  // The void wrapper is the standard Node pattern for async signal handlers.
  //
  // BL-405: this handler is DIRECT-STDIO MODE ONLY. In BACKEND mode
  // (SOX_PROXY_BACKEND=1, the production path), `runBackend()` below installs
  // its own coordinated shutdown (`backend.ts`'s `coordinatedShutdown`) that
  // already runs this same pre-restart backup as one bounded step of a single
  // sequenced teardown. Registering BOTH used to mean two independent
  // `process.on('SIGTERM', ...)` listeners raced to call `process.exit()` —
  // Node fires every listener for a signal, it does not pick one — and
  // whichever finished first killed the process and aborted the other's
  // in-flight work. Verified empirically: the real WAL checkpoint
  // (`closeDbWithLease`'s `PRAGMA wal_checkpoint(TRUNCATE)`, run from
  // `coordinatedShutdown`'s `closeAllAdapters()` step) routinely never
  // completed — the WAL file was byte-identical after a "clean" shutdown log
  // line. See BACKLOG.md BL-405.
  if (process.env.SOX_PROXY_BACKEND !== '1') {
    const dbPathForBackup = resolveDbPath(undefined);
    async function handleShutdown(signal: string): Promise<void> {
      process.stderr.write(`[memory-server] received ${signal}, running pre-restart backup...\n`);
      try {
        const result = await autoBackup(dbPathForBackup);
        if (!result.skipped && result.path) {
          process.stderr.write(`[memory-server] pre-restart backup saved: ${result.path} (${result.size} bytes)\n`);
        }
      } catch (err) {
        process.stderr.write(`[memory-server] pre-restart backup failed: ${err}\n`);
      }
      process.exit(0);
    }
    process.on('SIGTERM', () => { void handleShutdown('SIGTERM'); });
    process.on('SIGINT', () => { void handleShutdown('SIGINT'); });
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
