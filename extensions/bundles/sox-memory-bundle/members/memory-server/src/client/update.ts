/**
 * Memory update backing — calls memoryUpdate from @adhd/sox-memory-core.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';
import { memoryUpdate } from '@adhd/sox-memory-core';
import type { UpdateResult, UpdateError } from '@adhd/sox-memory-core';

export type { UpdateResult, UpdateError };

export type UpdateMemoryResult = UpdateResult | UpdateError | { code: 'E_MISSING'; message: string };

export const inputSchema = {
  type: 'object' as const,
  properties: {
    uid: {
      type: 'string',
      description:
        'UID of the live node to update. Required. Error E_NOT_FOUND if absent or invalidated.',
    },
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
    content: { type: 'string', description: 'Replace node.content. Triggers re-embed and FTS update.' },
    summary: { type: 'string', description: 'Replace node.summary. Triggers re-embed and FTS update.' },
    name: { type: 'string', description: 'Replace node.name.' },
    topic: { type: 'string', description: 'Replace node.topic.' },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Replace node.tags (replaces existing tags wholesale — not additive).',
    },
    importance: {
      type: 'number',
      minimum: 1,
      maximum: 10,
      description: 'Replace node.importance.',
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description: 'Metadata to merge into (or replace) existing node.meta. See metadata_merge.',
    },
    metadata_merge: {
      type: 'string',
      enum: ['deep', 'replace'],
      default: 'deep',
      description:
        "'deep' (default): recursive merge for nested objects; arrays are replaced not concatenated. 'replace': overwrites node.meta wholesale.",
    },
    t_occurred: { type: 'string', description: 'ISO timestamp — replace node.t_occurred.' },
    t_valid: { type: 'string', description: 'ISO timestamp — replace node.t_valid.' },
  },
  required: ['uid'],
};

/**
 * Backing for memory_update.
 *
 * Delegates to memoryUpdate from @adhd/sox-memory-core.
 * Returns the raw update result (success or error).
 */
export async function updateMemory(
  db: Database,
  args: Record<string, unknown>,
): Promise<UpdateMemoryResult> {
  const uid = args['uid'] as string | undefined;
  if (!uid) {
    return { code: 'E_MISSING', message: 'uid is required' };
  }

  const result = await memoryUpdate(db, {
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

  return result;
}
