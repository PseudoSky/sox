/**
 * libs/service-proxy/src/schema-hash.ts — [contract:schema-hash] (§9.5.3).
 *
 * Both shim and backend compute schema-hash = sha256 of the CANONICAL tools/list
 * payload. The hash must be stable across key ordering and across the two sides'
 * independent serialisation, so we canonicalise (recursively sort object keys)
 * before hashing. A behaviour-only backend upgrade leaves the hash unchanged → the
 * shim keeps serving the cached schema and the client never reconnects. An
 * interface change (a tool added/removed, or an input/output schema edit) changes
 * the hash → the shim emits notifications/tools/list_changed + a stderr notice.
 *
 * Leaf module — node builtins only (crypto).
 */

import { createHash } from 'node:crypto';

/**
 * Recursively produce a canonical JSON string: object keys sorted lexicographically
 * at every level, arrays preserved in order (array order is semantically meaningful
 * for a tools list). This makes the hash independent of how either side happens to
 * order keys when it serialises the payload.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Compute the schema-hash for a tools/list payload (`[contract:schema-hash]`).
 *
 * Accepts either the full `tools/list` result object (`{ tools: [...] }`) or a bare
 * tools array — both canonicalise to the same hash for the same tool set, so the
 * shim and backend can pass whichever they have on hand.
 */
export function computeSchemaHash(toolsListPayload: unknown): string {
  const tools = extractTools(toolsListPayload);
  return createHash('sha256').update(canonicalize({ tools }), 'utf8').digest('hex');
}

/** Normalise the various shapes a tools/list payload may arrive in to a tools array. */
function extractTools(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload !== null && typeof payload === 'object') {
    const tools = (payload as { tools?: unknown }).tools;
    if (Array.isArray(tools)) return tools;
    // A JSON-RPC response wrapping the result: { result: { tools: [...] } }
    const result = (payload as { result?: unknown }).result;
    if (result !== null && typeof result === 'object') {
      const inner = (result as { tools?: unknown }).tools;
      if (Array.isArray(inner)) return inner;
    }
  }
  return [];
}
