/**
 * libs/service-proxy/src/index.ts — @adhd/sox-service-proxy public API.
 *
 * The front-shim service-proxy (spec §9.5, Slice 1.5): the M3↔M4 bridge that lets
 * an mcp-server service be upgraded to new behaviour WITHOUT forcing the MCP client
 * to reconnect. A thin stdio front-shim (`runFrontShim`) serves initialize +
 * tools/list from a cached schema and proxies tools/call to a persistent, sox-owned
 * backend (`serveBackend`) over a Unix domain socket (`dialBackend`, re-dialing).
 *
 * Dependency-free leaf (node builtins only: net, crypto, fs, path) — no
 * install-engine / apps-sox / host-runtime imports (§9.5.4).
 */

// ── The stdio↔UDS front-shim (client-facing) ──────────────────────────────────
export { runFrontShim } from './shim.js';
export type { FrontShimOptions, FrontShimHandle } from './shim.js';

// ── The backend-side UDS listener (server-facing) ─────────────────────────────
export { serveBackend } from './backend.js';
export type { ServeBackendOptions, BackendHandle, BackendHandler } from './backend.js';

// ── Re-dialing backend connection (the zero-downtime mechanism) ───────────────
export { dialBackend } from './dial.js';
export type { DialOptions, BackendConnection, BackoffOptions } from './dial.js';

// ── [contract:schema-hash] (§9.5.3) ───────────────────────────────────────────
export { computeSchemaHash, canonicalize } from './schema-hash.js';

// ── Length-prefixed frame codec ───────────────────────────────────────────────
export { encodeFrame, FrameDecoder, HEADER_BYTES, MAX_FRAME_BYTES } from './framing.js';

// ── Backend socket-path derivation (data-root-keyed, §9.5.4) ──────────────────
export { backendSocketPath } from './socket-path.js';

// ── JSON-RPC 2.0 types + helpers ──────────────────────────────────────────────
export {
  ERR_BACKEND_UNAVAILABLE,
  errorResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isNotification,
} from './jsonrpc.js';
export type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
} from './jsonrpc.js';
