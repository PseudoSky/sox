# @adhd/sox-service-proxy

A stdio↔UDS proxy that lets an MCP server's backend be upgraded — new code, new
process — **without the MCP client ever reconnecting**. The client spawns a thin
front-shim over stdio; the shim serves `initialize`/`tools/list` from a cached
schema and relays everything else to a long-lived backend process over a Unix
domain socket. Roll the backend, and the same stdio pipe the client is already
holding keeps working: in-flight and new requests re-dial automatically and
resume the moment the new backend is live. A dependency-free leaf — Node
builtins only (`net`, `crypto`, `fs`, `path`), plus one workspace dependency for
guarded HTTP binding.

```bash
pnpm add @adhd/sox-service-proxy
```

## Quick start

This is the whole shape end-to-end in one process: a backend, a front-shim in
front of it, and a client driving the shim exactly the way an MCP host would
(newline-delimited JSON-RPC over a pair of streams).

```typescript
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { serveBackend, runFrontShim, type BackendHandler } from '@adhd/sox-service-proxy';

async function main() {
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-proxy-')), 'backend.sock');

  // 1. The backend: the real, upgradeable process holding your tool implementation.
  const handler: BackendHandler = (req) => {
    if (req.method === 'initialize') {
      return { jsonrpc: '2.0', id: req.id ?? null, result: { serverInfo: { name: 'demo', version: '1.0.0' }, capabilities: {} } };
    }
    if (req.method === 'tools/list') {
      return { jsonrpc: '2.0', id: req.id ?? null, result: { tools: [{ name: 'echo', description: 'Echoes its input', inputSchema: { type: 'object' } }] } };
    }
    if (req.method === 'tools/call') {
      return { jsonrpc: '2.0', id: req.id ?? null, result: { echoed: req.params } };
    }
    return { jsonrpc: '2.0', id: req.id ?? null, result: null };
  };
  const backend = await serveBackend({ socketPath, handler });

  // 2. The front-shim: what the MCP client actually spawns over stdio. It answers
  //    initialize/tools/list instantly from a cached schema, then relays every
  //    other call to the backend above over the UDS socket.
  const toShim = new PassThrough();   // client -> shim
  const fromShim = new PassThrough(); // shim -> client
  const shim = runFrontShim({ id: 'demo-server', socketPath, input: toShim, output: fromShim });

  // 3. Drive it like an MCP client would.
  fromShim.on('data', (chunk) => process.stdout.write(`client received: ${chunk}`));
  toShim.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { v: 'hi' } }) + '\n');

  // Later: ship a new backend build. Start it on the SAME socketPath and close
  // the old one — dialBackend re-dials automatically, so the shim above (and
  // the MCP client attached to it) never see a disconnect.

  await new Promise((r) => setTimeout(r, 50));
  shim.close();
  await backend.close();
}

main();
```

## API reference

### Front-shim (client-facing)

```typescript
function runFrontShim(opts: FrontShimOptions): FrontShimHandle;

interface FrontShimOptions {
  id: string;                    // extension id, for diagnostics + serve-record
  socketPath: string;            // backend UDS path
  schemaCachePath?: string;      // published schema.json to serve tools/list from before the backend is up
  input?: NodeJS.ReadableStream;  // default: process.stdin
  output?: NodeJS.WritableStream; // default: process.stdout
  onDiagnostic?: (line: string) => void; // stderr sink — see "no-stdout-diagnostics" below
  backoff?: BackoffOptions;
  ensure?: () => Promise<void>;  // auto-spawn hook, called before dialing and after a drop
  httpPort?: number;             // also serve JSON-RPC over HTTP POST /mcp on this port
  onHttpBindResult?: (outcome: ListenOutcome) => void;
  listenFailureRecordFile?: string;
  clientProjectPath?: string;    // injects client_context.project_path into every tools/call frame
}

interface FrontShimHandle {
  done: Promise<void>;           // resolves when the client's input stream ends
  close(): void;
  backend: BackendConnection;
}

interface ClientContext {
  project_path: string;
}
```

### Backend (server-facing)

```typescript
function serveBackend(opts: ServeBackendOptions): Promise<BackendHandle>;

interface ServeBackendOptions {
  socketPath: string;
  handler: BackendHandler;       // (req) => JsonRpcResponse | undefined
  onDiagnostic?: (line: string) => void;
  inheritFd?: number;            // listen on a pre-bound fd from an OS supervisor (launchd socket activation)
}

type BackendHandler = (request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined> | JsonRpcResponse | undefined;

interface BackendHandle {
  socketPath: string;
  close(): Promise<void>;
}
```

`serveBackend` never unlinks a live socket. If the socket file already exists it
probe-connects first; a live socket is refused with a structured `E_LIVE_SOCKET`
error rather than being stolen out from under a running backend.

### Re-dialing connection (the zero-downtime mechanism)

```typescript
function dialBackend(opts: DialOptions): BackendConnection;

interface DialOptions {
  socketPath: string;
  backoff?: BackoffOptions;
  onDiagnostic?: (line: string) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

interface BackoffOptions {
  initialMs?: number;      // default 50
  maxMs?: number;          // default 2000
  giveUpAfterMs?: number;  // default 10000 — after this, pending requests fast-fail with -32001
  maxQueue?: number;       // default 256 — oldest buffered requests are fast-failed beyond this
}

interface BackendConnection {
  send(request: JsonRpcRequest): Promise<JsonRpcResponse>; // buffers while disconnected, never rejects/hangs
  notify(request: JsonRpcRequest): void;                   // dropped if the backend is unavailable
  isConnected(): boolean;
  close(): void;
}
```

`dialBackend` returns synchronously and starts connecting immediately; calls to
`send()` issued before the first connect are queued and flushed on connect. If
the backend stays down past `giveUpAfterMs`, pending calls resolve with a
`-32001` (backend-unavailable) error response instead of hanging — the loop
keeps re-dialing in the background and recovers automatically.

### Auto-managed backend lifecycle

```typescript
function ensureBackend(opts: EnsureBackendOptions): Promise<EnsureBackendResult>;
function probeSocketLive(socketPath: string, timeoutMs?: number): Promise<boolean>;
function handshakeBackend(socketPath: string, timeoutMs?: number): Promise<boolean>;

type EnsureBackendDisposition = 'already-live' | 'spawned' | 'adopted-after-wait' | 'failed';

interface EnsureBackendResult {
  disposition: EnsureBackendDisposition;
  pid?: number;    // only set when disposition === 'spawned'
  detail: string;
}

interface EnsureBackendOptions {
  socketPath: string;
  singletonKey: string;     // identical keys -> identical spawn lock -> one backend
  command: string;          // e.g. process.execPath
  args: string[];           // e.g. ['--enable-source-maps', entrypointPath]
  cwd?: string;
  env?: NodeJS.ProcessEnv;  // must carry the backend-mode signal + SOX_CONFIG_* env
  lockDir?: string;
  onDiagnostic?: (line: string) => void;
  readyTimeoutMs?: number;  // default 10000
  probeTimeoutMs?: number;  // default 250
  lockTtlMs?: number;       // default 30000
  stderrLogPath?: string;   // NEVER 'inherit' for a detached backend — see gotchas
}
```

`ensureBackend` makes "start a backend if one isn't already running" safe under
a thundering herd of concurrent shims: it probes for liveness first (no spawn if
already live), then races an `O_EXCL` spawn lock — the winner spawns detached
and waits for the socket; losers wait for the winner's socket instead of
spawning their own. Exactly one backend process comes up per `singletonKey`,
no matter how many shims start at once.

### Schema-hash change detection

```typescript
function computeSchemaHash(toolsListPayload: unknown): string;
function canonicalize(value: unknown): string;
```

Both the shim and the backend compute `sha256` of the *canonicalized* (keys
sorted recursively) `tools/list` payload. A backend upgrade that changes
behaviour but not its tool interface leaves the hash unchanged, so the shim
keeps serving its cached schema with zero client-visible change. A real
interface change (a tool added/removed, or a schema edit) changes the hash —
the shim then emits a stderr notice and, if the client declared the
capability, a `notifications/tools/list_changed`.

### Frame codec (shim↔backend wire format)

```typescript
const HEADER_BYTES = 4;
const MAX_FRAME_BYTES: number; // 16 MiB

function encodeFrame(value: unknown): Buffer;

class FrameDecoder {
  constructor(onMessage: (value: unknown) => void, onError: (err: Error) => void);
  push(chunk: Buffer): void;
  reset(): void;
}
```

UDS is a byte stream with no message boundaries, so every payload crossing the
shim↔backend socket is framed as a 4-byte big-endian length prefix followed by
that many bytes of UTF-8 JSON. `FrameDecoder` is decoupled from any socket —
feed it raw chunks (even one byte at a time) via `push()` and it emits each
complete frame to `onMessage`; a declared length over `MAX_FRAME_BYTES` is
treated as a protocol violation via `onError`, not an allocation to honor.

```typescript
const decoder = new FrameDecoder(
  (msg) => console.log('got frame', msg),
  (err) => socket.destroy(err),
);
socket.on('data', (chunk) => decoder.push(chunk));
```

### Socket path derivation

```typescript
function backendSocketPath(socketDir: string, singletonKey: string): string;
```

Composes a deterministic backend UDS path from a resolved socket directory and
a singleton key, sanitizing the result to fit within the platform's
`sun_path` limit (108 bytes on Linux, 104 on macOS) — a socket path derived
from a deeply nested scratch directory can otherwise silently overflow it and
fail `bind(2)` with `EINVAL`.

### JSON-RPC 2.0 types + helpers

```typescript
type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

const ERR_BACKEND_UNAVAILABLE = -32001;

function isJsonRpcRequest(v: unknown): v is JsonRpcRequest;
function isJsonRpcResponse(v: unknown): v is JsonRpcResponse;
function isNotification(req: JsonRpcRequest): boolean; // true iff req.id is absent
function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse;
```

## Invariants / gotchas

- **No stdout diagnostics.** The front-shim's stdout carries *only*
  newline-delimited JSON-RPC to the client — every diagnostic goes to
  `onDiagnostic` (stderr by default). A stray stdout byte corrupts the
  client's JSON-RPC stream.
- **Never `stderrLogPath`-less with `'inherit'`.** A detached backend spawned
  by `ensureBackend` must fully sever inherited stdio. If the spawning
  process's own stderr is connected to a pipe (e.g.
  `soxe upgrade --all 2>&1 | tail`), a detached child inheriting that pipe
  holds it open forever and the pipeline hangs. By default stderr goes to
  `/dev/null`; pass `stderrLogPath` to redirect it to a real file instead.
- **`serveBackend` never unlinks a live socket.** A pre-existing socket file
  is probe-connected before any bind; a live one is refused
  (`E_LIVE_SOCKET`) rather than stolen. Only a stale socket (no process
  listening) is cleaned up.
- **`dialBackend.send()` never rejects and never hangs.** Past
  `giveUpAfterMs` it resolves with a `-32001` error response instead — the
  caller always gets a response object to inspect, and the re-dial loop
  keeps trying in the background so a returning backend recovers
  automatically.
- **This package has no CLI and no MCP SDK dependency.** It is a
  transport-agnostic JSON-RPC relay; the actual MCP tool dispatcher lives
  behind the `handler` you pass to `serveBackend`.
