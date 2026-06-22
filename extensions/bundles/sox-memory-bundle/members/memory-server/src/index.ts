/**
 * MCP Server: Agent Memory Server
 * 7 memory_* tools over a single-file SQLite graph store.
 * Transport: stdio JSON-RPC (tools/list + tools/call).
 *
 * P1 MVP: memory_write (in-process) + memory_recall (hybrid vec+FTS+temporal)
 * Remaining tools: session state, invalidate, search_entities, get_community (stubs for P1)
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
import { openDb, memoryWrite, memoryRecall } from '@sox/memory-core';
import Database from 'better-sqlite3';

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
      'Recall memories using hybrid vec+BM25+temporal search. <50ms, zero LLM. Returns ranked results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The query to recall' },
        db_path: { type: 'string', description: 'Path to the .db file' },
        scope: { type: 'string', description: 'Scope name (project/user/org/local)' },
        agent_id: { type: 'string' },
        as_of: { type: 'string', description: 'ISO timestamp for point-in-time recall' },
        token_budget: { type: 'number', default: 4000 },
        depth: { type: 'number', default: 1 },
        limit: { type: 'number', default: 10 },
      },
      required: ['query', 'db_path'],
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
    description: 'Get community node for an entity.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_uid: { type: 'string' },
        db_path: { type: 'string' },
        level: { type: 'number', default: 0 },
      },
      required: ['entity_uid', 'db_path'],
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
    name: 'memory_link',
    description:
      'Create a directed edge between two existing nodes. Use for chunk→parent (DERIVED_FROM), claim replacement (SUPERSEDES), or explicit relationships (RELATES_TO, SUPPORTS, MENTIONS).',
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
      const result = await memoryRecall(db, (args['scope'] as string) ?? 'project', {
        query: args['query'] as string,
        agent_id: args['agent_id'] as string | undefined,
        as_of: args['as_of'] as string | undefined,
        token_budget: args['token_budget'] as number | undefined,
        depth: args['depth'] as number | undefined,
        limit: args['limit'] as number | undefined,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
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
      const entityUid = args['entity_uid'] as string;
      const level = (args['level'] as number) ?? 0;
      // Find community via MEMBER_OF edge
      const row = db
        .prepare(
          `SELECT n2.uid, n2.name, n2.summary, n2.level
           FROM node n1
           JOIN edge e ON e.src = n1.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
           JOIN node n2 ON n2.rowid = e.dst AND n2.kind = 'community' AND n2.level = ? AND n2.t_invalid IS NULL
           WHERE n1.uid = ? AND n1.t_invalid IS NULL`,
        )
        .get(level, entityUid);
      if (!row) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code: 'E_NOT_FOUND', entity_uid: entityUid }) }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ community: row }) }],
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

    case 'memory_link': {
      const VALID_RELS = ['MENTIONS', 'SUPPORTS', 'RELATES_TO', 'DERIVED_FROM', 'SUPERSEDES', 'ASSIGNED_TO'];
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

void serve(registeredTools, { name: 'memory-server', version: '0.1.0' });
