---
"@adhd/sox-mcp-runtime": minor
---

Additive: multi-transport support (stdio/uds/http/sse).

`serves` tuple widened `readonly ["stdio", "sse"]` → `readonly ["stdio", "sse", "http"]`.
`TransportMode` union widened `'stdio' | 'sse'` → `'stdio' | 'uds' | 'http' | 'sse'`.
`TransportOptions` gains 4 optional fields (`transports?`, `bindAddress?`, `socketPath?`,
`authToken?`); `mode?`/`port?`/`host?` retained unchanged. `TransportHandle` gains optional
`socketPath?`. New exports: `buildToolDispatch`, `connectStreamableHttp`, `connectUds`,
`connectStdioTransport`, `resolveTransports`, `validateBindAuth`, `authMiddleware`, `isLoopback`,
`resolveBindHost`, new type `ToolDispatch`.

`connectSse` changes from `` export declare function connectSse(server: Server, opts?:
TransportOptions): Promise<TransportHandle>; `` to `` export declare const connectSse: typeof
connectStreamableHttp; `` — `connectStreamableHttp`'s own declared signature is structurally
identical (`(server: Server, opts?: TransportOptions): Promise<TransportHandle>`), so `import {
connectSse } from '@adhd/sox-mcp-runtime'; connectSse(server, opts)` compiles unchanged before and
after. Not a breaking change; correctly marked `@deprecated` in the new JSDoc rather than removed.

**Behavior note, does not change the bump:** the documented default HTTP port changed ("then 0
(random)" → "then 3000") and the wire protocol served on that port changed from raw SSE (`GET /sse`,
`POST /message`) to StreamableHTTP session framing. This is a real runtime behavior change for
anything depending on the old literal SSE endpoint shape, but it is invisible to a `.d.ts` diff (same
declared function signature, different implementation) and is out of this gate's detection scope.
Flagged here so dependents on the old SSE endpoint shape know to check before upgrading.
