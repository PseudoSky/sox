/**
 * libs/service-proxy/src/jsonrpc.ts — minimal JSON-RPC 2.0 types + helpers shared
 * by the shim and backend. We do NOT pull in the MCP SDK here: the proxy is a
 * transport-agnostic JSON-RPC relay (§9.5.4 — "single-protocol need", no third-
 * party deps). The backend's tool dispatcher (which may be the MCP SDK) is wrapped
 * by serveBackend's `handler`.
 *
 * Leaf module — node builtins only.
 */

/** A JSON-RPC 2.0 request id: string, number, or null (notifications omit it). */
export type JsonRpcId = string | number | null;

/** A JSON-RPC 2.0 request (or notification, when `id` is absent). */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

/** A JSON-RPC 2.0 error object. */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A JSON-RPC 2.0 response. Exactly one of `result` / `error` is present. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * Application-defined JSON-RPC error code for "the backend is currently
 * unavailable" (§9.5.2 / §9.5.5). -32000..-32099 is the JSON-RPC reserved range
 * for implementation-defined server errors; -32001 is our backend-unavailable.
 */
export const ERR_BACKEND_UNAVAILABLE = -32001;

/** A type guard: does this parsed frame look like a JSON-RPC request? */
export function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (v as { method?: unknown }).method === 'string'
  );
}

/** A type guard: does this parsed frame look like a JSON-RPC response? */
export function isJsonRpcResponse(v: unknown): v is JsonRpcResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return o['jsonrpc'] === '2.0' && 'id' in o && ('result' in o || 'error' in o);
}

/** Is this request a notification (no `id`)? Notifications get no response. */
export function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined;
}

/** Build a JSON-RPC error response for the given id. */
export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcError = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: '2.0', id, error };
}
