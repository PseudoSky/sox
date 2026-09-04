# @adhd/sox-mcp-runtime

A thin author-facing wrapper around `@modelcontextprotocol/sdk`: write tools as plain functions, call `serve(tools, opts)`, and get stdio + Unix-domain-socket + Streamable-HTTP transports, C6 permission enforcement at the resource sink, health, and graceful shutdown for free. Every extension built on this package automatically serves all three transports — there is no reimplementation of the MCP protocol here, only transport selection, policy enforcement, and lifecycle wiring layered on top of the official SDK.

```bash
pnpm add @adhd/sox-mcp-runtime
```

## Quick start

```typescript
import { defineTool, serve, type ToolResult } from '@adhd/sox-mcp-runtime';

const echo = defineTool({
  name: 'echo',
  description: 'Echoes the given text back.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  handler: (args, ctx): ToolResult => {
    // ctx exposes the compiled C6 policy — check it before touching any resource.
    if (!ctx.allowsFsRead(process.cwd())) {
      return { isError: true, content: [{ type: 'text', text: 'fs read denied by policy' }] };
    }
    return { content: [{ type: 'text', text: String(args['text']) }] };
  },
});

await serve([echo], { name: 'echo-server', version: '1.0.0' });
```

That's a complete MCP server. Run it directly and it serves `stdio` by default (or `SOX_MCP_TRANSPORT`/`--transport`, or the multi-bind `transports` option below); `soxe` spawns it as a supervised extension via `@adhd/sox-host-runtime` without any further wiring.

### Binding multiple transports at once

```typescript
await serve([echo], {
  name: 'echo-server',
  version: '1.0.0',
  transport: {
    transports: ['stdio', 'uds', 'http'],
    port: 3099,           // SOX_MCP_PORT env var also works
    host: '127.0.0.1',    // non-loopback requires authToken (TR-2)
    socketPath: '/tmp/echo-server.sock',
  },
});
```

## API reference

### Author API

```typescript
const serves: readonly ['stdio', 'sse', 'http'];
type ServesValue = 'stdio' | 'sse' | 'http';

function defineTool<TArgs extends Record<string, unknown> = Record<string, unknown>>(
  def: ToolDefinition<TArgs>,
): RegisteredTool;

interface ToolDefinition<TArgs> {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, object>; required?: string[] };
  handler: (args: TArgs, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

interface ToolContext {
  enforced: boolean;
  allowsFsRead(absPath: string): boolean;
  allowsFsWrite(absPath: string): boolean;
  allowsNetwork(hostOrUrl: string): boolean;
  allowsSocket(absPath: string): boolean;
}

interface ToolResultContent { type: 'text'; text: string; }
interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
}
/** A compiled, registered tool ready for serve() — returned by defineTool(). */
interface RegisteredTool { definition: ToolDefinition; }

function serve(tools: RegisteredTool[], opts: ServeOptions): Promise<void>;
interface ServeOptions {
  name: string;
  version?: string;
  transport?: TransportOptions; // see below — defaults to stdio only
}

function buildToolDispatch(tools: RegisteredTool[], serverInfo: { name: string; version: string }): ToolDispatch;
function formatToolError(err: unknown, ctx?: { tool?: string }): { isError: true; content: [{ type: 'text'; text: string }] };
```

`formatToolError` is what to reach for in a `catch` block around your own dispatch logic — it preserves a structured error's shape (rather than collapsing it to `"[object Object]"` via `String()`) and traces the failure through `@adhd/sox-telemetry`.

### Transport (advanced — for a custom dispatch loop or tests)

```typescript
type TransportMode = 'stdio' | 'uds' | 'http' | 'sse';
interface TransportOptions {
  mode?: TransportMode;           // single-mode back-compat; ignored when `transports` is set
  transports?: TransportMode[];   // multi-bind, e.g. ['stdio', 'uds', 'http']
  port?: number;                  // default: SOX_MCP_PORT env, then 3000
  host?: string;                  // default: '127.0.0.1'
  bindAddress?: string;           // alias for host
  socketPath?: string;            // for 'uds' mode
  authToken?: string;             // bearer token — REQUIRED for a non-loopback http bind
}
interface TransportHandle {
  mode: TransportMode;
  port?: number;
  socketPath?: string;
  close(): Promise<void>;
}
interface ToolDispatch {
  serverInfo: { name: string; version: string };
  listTools(): Array<{ name: string; description: string; inputSchema: object }>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}

function resolveTransportMode(opts?: TransportOptions): TransportMode;
function resolveTransports(opts?: TransportOptions): TransportMode[];
function resolveBindHost(opts: TransportOptions): string;
function isLoopback(host: string): boolean;
function validateBindAuth(opts: TransportOptions): void; // throws if non-loopback bind has no authToken
function authMiddleware(req: IncomingMessage, res: ServerResponse, expectedToken: string): boolean;

function connectStdio(server: Server): Promise<TransportHandle>;
function connectStreamableHttp(server: Server, opts?: TransportOptions): Promise<TransportHandle>;
function connectUds(dispatch: ToolDispatch, socketPath: string): Promise<TransportHandle>;
/** @deprecated alias of connectStreamableHttp */
const connectSse: typeof connectStreamableHttp;
```

### Enforcement (advanced — C6 policy at the resource sink)

```typescript
function getPolicy(): Policy; // re-exported from @adhd/sox-host-runtime; reads SOX_PERM_* env

interface EnforcementDenial { denied: true; reason: string; }
function checkFsAccess(absPath: string): EnforcementDenial | null;
function checkNetworkAccess(hostOrUrl: string): EnforcementDenial | null;
function checkSocketAccess(absPath: string): EnforcementDenial | null;
```

`ToolContext.allowsFsRead`/`allowsFsWrite`/`allowsNetwork`/`allowsSocket` (passed into every tool handler) are the intended call site — reach for `checkFsAccess`/`checkNetworkAccess`/`checkSocketAccess` directly only if you're building a resource sink outside the handler's own `ctx`.

## Invariants / gotchas

- **Enforcement is opt-in and env-driven.** `SOX_PERM_ENFORCE` must be present in the process environment for any `allows*()`/`check*Access()` call to actually deny anything; absent, every check returns "allowed" (legacy compatibility for a server run standalone, outside a supervised extension). The policy itself (`SOX_PERM_FS_*`, `SOX_PERM_SOCKET`, `SOX_PERM_NETWORK`) is injected by `@adhd/sox-host-runtime`'s `Policy.toEnv()` when a supervisor spawns your process — you don't construct it by hand.
- **A non-loopback HTTP bind without an `authToken` refuses to start.** `validateBindAuth` (called internally by `serve()`) throws rather than silently exposing an unauthenticated port.
- **`connectSse` is deprecated** — it's a plain alias for `connectStreamableHttp`; SSE-as-a-transport-name is kept only for backward compatibility with older `transports`/`mode` config.
- **`serves = ['stdio', 'sse', 'http']` is a static, derived fact**, not a runtime capability probe — any extension importing from this package is guaranteed to support all three because the wrapper implements all three uniformly, regardless of which `transports` a given process actually binds at runtime.
