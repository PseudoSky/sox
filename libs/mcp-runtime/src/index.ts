/**
 * libs/mcp-runtime/src/index.ts — @adhd/sox-mcp-runtime public API.
 *
 * An MCP extension built on @adhd/sox-mcp-runtime derives [def:serves] automatically:
 * building on this wrapper ⇒ serves stdio + sse + http (all transports implemented).
 *
 * [mcp-runtime.5]: 'serves' is derived from building on the wrapper.
 * [inv:c6-holds]: enforcement is provided uniformly by enforce.ts.
 *
 * Authors import { serve, defineTool } from '@adhd/sox-mcp-runtime'.
 */

// ─── [def:serves] — derived transport capability fact ─────────────────────────
//
// Any extension that imports from @adhd/sox-mcp-runtime automatically serves all
// transports. The validate-time invariant `profiles ⊆ serves` is satisfiable
// because serves = ['stdio', 'sse', 'http'] for all @adhd/sox-mcp-runtime extensions.

/** The transports that every @adhd/sox-mcp-runtime extension serves. */
export const serves = ['stdio', 'sse', 'http'] as const;

/** Union type of supported transport values. */
export type ServesValue = (typeof serves)[number];

// ─── Author API ───────────────────────────────────────────────────────────────

export { defineTool, serve } from './serve.js';
export type {
  RegisteredTool,
  ServeOptions, ToolContext, ToolDefinition, ToolResult,
  ToolResultContent
} from './serve.js';

// ─── Transport (for advanced callers and tests) ───────────────────────────────

export { connectSse, connectStdio, connectStreamableHttp, resolveTransportMode } from './transport.js';
export type { TransportHandle, TransportMode, TransportOptions } from './transport.js';

// ─── Enforcement (for advanced callers and tests) ─────────────────────────────

export { checkFsAccess, checkNetworkAccess, checkSocketAccess, getPolicy } from './enforce.js';
export type { EnforcementDenial } from './enforce.js';

