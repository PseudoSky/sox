/**
 * libs/mcp-runtime/src/index.ts — @sox/mcp-runtime public API.
 *
 * An MCP extension built on @sox/mcp-runtime derives [def:serves] automatically:
 * building on this wrapper ⇒ serves stdio + sse (both transports implemented).
 *
 * [mcp-runtime.5]: 'serves' is derived from building on the wrapper.
 * [inv:c6-holds]: enforcement is provided uniformly by enforce.ts.
 *
 * Authors import { serve, defineTool } from '@sox/mcp-runtime'.
 */

// ─── [def:serves] — derived transport capability fact ─────────────────────────
//
// Any extension that imports from @sox/mcp-runtime automatically serves both
// transports. The validate-time invariant `profiles ⊆ serves` is satisfiable
// because serves = ['stdio', 'sse'] for all @sox/mcp-runtime extensions.

/** The transports that every @sox/mcp-runtime extension serves. */
export const serves = ['stdio', 'sse'] as const;

/** Union type of supported transport values. */
export type ServesValue = (typeof serves)[number];

// ─── Author API ───────────────────────────────────────────────────────────────

export { serve, defineTool } from './serve.js';
export type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ToolResultContent,
  RegisteredTool,
  ServeOptions,
} from './serve.js';

// ─── Transport (for advanced callers and tests) ───────────────────────────────

export { resolveTransportMode, connectStdio, connectSse } from './transport.js';
export type { TransportMode, TransportOptions, TransportHandle } from './transport.js';

// ─── Enforcement (for advanced callers and tests) ─────────────────────────────

export { getPolicy, checkFsAccess, checkNetworkAccess, checkSocketAccess } from './enforce.js';
export type { EnforcementDenial } from './enforce.js';
