/**
 * Memory write backing — calls memoryWrite from @adhd/sox-memory-core.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 * Chunking logic (splitIntoChunks) is a server-side orchestration concern and
 * lives in index.ts, not here.
 */

import type { Database } from 'better-sqlite3';
import { memoryWrite } from '@adhd/sox-memory-core';
import type { WriteResult, WriteError } from '@adhd/sox-memory-core';

export type { WriteResult, WriteError };

export interface WriteMemoryResult {
  episode_uid?: string;
  chunk_uids?: string[];
  chunk_count?: number;
  enrichment?: WriteResult['enrichment'];
  code?: string;
  message?: string;
  existing_uid?: string;
}

export const inputSchema = {
  type: 'object' as const,
  properties: {
    content: { type: 'string', description: 'The content to memorize. Required.' },
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
    summary: {
      type: 'string',
      description:
        '(E2) Human-readable summary. Persisted to node.summary; no extractive fallback runs if supplied.',
    },
    name: { type: 'string', description: '(E2) Title/name for this episode (node.name).' },
    topic: {
      type: 'string',
      description:
        '(E5) Explicit topic override. Stored to node.topic; takes priority over [<topic>] prefix and cluster label.',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description:
        '(E4) Concept/entity tags. Persisted as node.tags JSON array AND as entity nodes + MENTIONS edges.',
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description: '(E3) Arbitrary caller metadata persisted as node.meta JSON. Queryable via json_extract.',
    },
    project_path: {
      type: 'string',
      description: '(E1) Caller project root path. Auto-detected from cwd+git if omitted.',
    },
    derived_from_uid: {
      type: 'string',
      description: '(E9) UID of a parent episode; emits a DERIVED_FROM edge from this episode to parent.',
    },
    session_id: { type: 'string' },
    t_occurred: { type: 'string', description: 'ISO timestamp when this occurred.' },
    agent_id: { type: 'string' },
    source: {
      type: 'string',
      enum: ['message', 'tool_output', 'observation', 'document', 'reflection', 'import'],
    },
    importance: {
      type: 'number',
      minimum: 1,
      maximum: 10,
      description: 'User-asserted importance (1–10). If supplied, batch enricher will not overwrite it.',
    },
    chunk_size: {
      type: 'number',
      description:
        'Approximate tokens per chunk (default: 500). Content exceeding this threshold is split at sentence boundaries; each chunk is stored as a separate episode with a DERIVED_FROM edge to the parent.',
      default: 500,
    },
  },
  required: ['content'],
};

/**
 * Backing for memory_write.
 *
 * Performs a single (non-chunked) write via memoryWrite from @adhd/sox-memory-core.
 * Chunking and multi-chunk DERIVED_FROM wiring is handled by the MCP server.
 *
 * Returns the raw memoryWrite result wrapped in a consistent shape.
 */
export async function writeMemory(
  db: Database,
  args: Record<string, unknown>,
): Promise<WriteMemoryResult> {
  const result = await memoryWrite(db, {
    content: args['content'] as string,
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

  if ('code' in result) {
    const existingUid = (result as WriteError & { existing_uid?: string }).existing_uid;
    return {
      code: result.code,
      message: result.message,
      ...(existingUid !== undefined ? { existing_uid: existingUid } : {}),
    };
  }

  return {
    episode_uid: result.episode_uid,
    enrichment: result.enrichment,
  };
}
