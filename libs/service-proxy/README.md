# @adhd/sox-service-proxy

A stdio↔UDS proxy that lets an MCP server's backend be upgraded — new code, new
process — **without the MCP client ever reconnecting**. The client spawns a thin
front-shim over stdio; the shim serves `initialize`/`tools/list` from a cached
schema and relays everything else to a long-lived backend process over a Unix
domain socket. Roll the backend, and the same stdio pipe the client is already
holding keeps working: in-flight and new requests re-dial automatically and
resume the moment the new backend is live. A leaf library with no third-party
dependencies: it uses Node builtins (`net`, `crypto`, `fs`, `path`,
`child_process` for the process start token) plus one workspace dependency,
`@adhd/sox-listen-guard`, for guarded HTTP binding.

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
  handler: BackendHandler;       // (req, ctx) => JsonRpcResponse | undefined
  onDiagnostic?: (line: string) => void;
  inheritFd?: number;            // listen on a pre-bound fd from an OS supervisor (launchd socket activation)
  onClientCountChange?: (count: number) => void;
  onClientConnect?: (connectionId: string) => void;                              // 0.6.0
  onClientDisconnect?: (connectionId: string, reason: ClientDisconnectReason) => void; // 0.6.0
}

type BackendHandler = (request: JsonRpcRequest, ctx: ConnectionContext) => Promise<JsonRpcResponse | undefined> | JsonRpcResponse | undefined;
interface ConnectionContext { readonly connectionId: string }          // 0.6.0
type ClientDisconnectReason = 'end' | 'error' | 'closed-by-backend';   // 0.6.0

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

Three tiers, first fit wins: `<socketDir>/proxy-<key>-<digest>.sock`, then
`<socketDir>/proxy-<digest>.sock`, then — when `socketDir` alone is too long —
`/tmp/sox-<uid>/p-<digest>.sock` under the fixed per-uid root
`udsFallbackRoot()`. The result never depends on `TMPDIR`, so every peer
derives the same path for the same key. On a platform without
`process.getuid` the tier-3 root throws `E_UDS_UNSUPPORTED_PLATFORM`.

### Socket-directory trust check

```typescript
function ensurePrivateSocketDir(dir: string, opts: { create: boolean; deps?: Partial<SocketDirDeps> }): void;
function assertPrivateSocketDir(dir: string, deps?: Partial<SocketDirDeps>): void;
function isUdsDirUnsafeError(err: unknown): err is UdsDirUnsafeError;
function tightenOwnedSocketDir(dir: string, opts?: TightenOwnedSocketDirOptions): TightenOutcome;
function udsFallbackRoot(uid?: number): string; // '/tmp/sox-<uid>'
```

A socket is only as private as its directory. `serveBackend` calls
`ensurePrivateSocketDir(dirname(socketPath), { create: true })` before binding.
`dialBackend`, `probeSocketLive`, `handshakeBackend`, and `ensureBackend` check
the directory before they connect. The directory must pass `lstat`:

- it is not a symlink, and it is a directory;
- it is owned by the current uid;
- the `/tmp/sox-<uid>` root is exactly `0700` (created non-recursively);
- any other directory has no group or other write bit.

A failure throws `E_UDS_DIR_UNSAFE` with
`{ reason, dir, expectedUid, actualUid, mode, isSymlink }`. The check never
chmods, chowns, deletes, or swaps the directory for another path. The message
depends on `reason`, and no message suggests a recursive delete:

| `reason` | Meaning | Remediation in the message |
|---|---|---|
| `foreign` | A symlink, a non-directory, or owned by another uid | Check `ls -ld`. Treat it as a possible impostor. `rm <dir>` removes only a symlink. Under sticky `/tmp`, only the owner or an admin can remove it. Inside the data root, `mv` it aside and restart. For the `/tmp/sox-<uid>` root, the message also says to point `SOX_ECOSYSTEM_HOME` at a shorter path. |
| `own-writable` | Yours, but group/other-writable (usually umask 002) | `chmod go-w <dir>`. Do not delete it: it holds live runtime state. |
| `fallback-mode` | `/tmp/sox-<uid>` is yours but not exactly `0700` | `chmod 700 /tmp/sox-<uid>` |

The refusal is non-retryable:

- `serveBackend` rejects without binding.
- `dialBackend` fast-fails pending requests with `-32001` and
  `data.code: 'E_UDS_DIR_UNSAFE'`. It does not re-dial, and the next `send()`
  re-checks the directory.
- `probeSocketLive` and `handshakeBackend` reject instead of resolving `false`
  when the socket file exists in an unsafe directory. They still resolve
  `false`, without checking the directory, when no socket file exists.
- `ensureBackend` returns `{ disposition: 'failed', errorCode: 'E_UDS_DIR_UNSAFE' }`
  and spawns nothing.

A directory that does not exist yet is not unsafe. Dialing into it keeps the
ordinary re-dial behaviour.

**Repair: `tightenOwnedSocketDir`.** This removes group/other write from a
directory it can prove is yours. It opens the directory once with
`O_RDONLY|O_DIRECTORY|O_NOFOLLOW`, then runs `fstat` and `fchmod(mode & 0o7755)`
on that same descriptor. It returns one of:

- `'absent'`: the directory does not exist;
- `'ok'`: it was already tight;
- `'tightened'`: the mode was changed, and `onTightened` receives `{dir, oldMode, newMode}` for the caller's telemetry;
- `'skipped-not-owned'`: it was the fallback root, a symlink, a non-directory, or another uid's directory.

The checks above never call it. Only the process that owns the data root does,
once at start-up: `soxe` CLI init on `runDir()` and `socketDir()`, and the
embedding funnel on `$SOX_ECOSYSTEM_HOME/run`.

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

## Lifecycle primitives (0.6.0)

Four additive building blocks for a long-lived backend host that must know who is
connected, avoid stale locks, retire itself when idle, and stop relaunching a
broken child. Every one is optional: one-argument handlers, the 0.5.0 lock file
and all existing options behave exactly as before.

> **The ADR-0022 rule: presence never pins.** Connections, presence and health
> probes never keep a host alive. Only work does. Presence may *release* a host
> (a client going away can make it eligible to retire sooner); it can never
> *pin* one. This is enforced in the types: `createIdleRetirer` has no
> connection or presence parameter, and a host with five permanently idle
> connected clients still retires after its idle window.

### Connection identity and client hooks

The handler receives `ctx.connectionId`: opaque, unique per accepted connection
within one `serveBackend` (`"c1"`, `"c2"`, ...), not a secret. `onClientConnect`
and `onClientDisconnect` fire exactly once per connection, including for a peer
that was `kill -9`ed (the kernel closes its socket). A killed peer normally
reports `'end'`; do not rely on telling `'end'` from `'error'`. A hook that
throws is isolated (reported through `onDiagnostic`) and never breaks a
connection. `onClientCountChange` keeps its 0.5.0 call sequence.

```typescript
import { serveBackend } from '@adhd/sox-service-proxy';

const clients = new Map<string, { connectedAt: number; lastActivityAt: number | null }>();

const backend = await serveBackend({
  socketPath: '/tmp/demo.sock',
  onClientConnect: (id) => clients.set(id, { connectedAt: Date.now(), lastActivityAt: null }),
  onClientDisconnect: (id, reason) => {
    clients.delete(id); // a dead client vanishes at once; no pid polling needed
    console.error(`client ${id} gone (${reason})`);
  },
  handler: (req, ctx) => {
    if (req.method === 'activity') {
      const rec = clients.get(ctx.connectionId);
      if (rec) rec.lastActivityAt = Date.now();
      return undefined; // notification
    }
    return { jsonrpc: '2.0', id: req.id ?? null, result: { you: ctx.connectionId } };
  },
});
```

Consumers that need to attribute requests to a connection (a registry of
clients, per-client accounting) must read `ctx.connectionId` in the handler; the
id is not carried on the JSON-RPC request.

### Pid-reuse-safe spawn lock

`ensureBackend`'s spawn lock file gains an optional `startToken`: the text
`ps -o lstart= -p <pid>` prints for the lock holder, read with `LC_ALL=C` and
`TZ=UTC` so two callers with different locales or timezones produce the same
text for the same process. A lock whose pid is alive but whose token differs
belongs to a recycled pid and is reclaimed immediately instead of after the TTL.
A lock without a token (written by 0.5.0) and any `ps` failure degrade to the
0.5.0 rule (alive means held). `ps` is never run on the `already-live` path.
Verified on macOS; Linux is unverified.

```typescript
import { readProcessStartToken, isSameProcess } from '@adhd/sox-service-proxy';

const token = readProcessStartToken(process.pid); // e.g. 'Mon Oct 12 09:30:00 2026', or null
// Later, possibly after a restart: is the pid I recorded still the same process?
if (!isSameProcess(recordedPid, recordedToken)) {
  // dead, or the pid number now belongs to someone else: safe to treat as gone
}
```

`isSameProcess` returns `false` for a dead pid or a different token, and `true`
when the token is missing or `ps` fails (fail toward keeping the record).

### Work-driven idle retirer

`createIdleRetirer` retires a host `idleWindowMs` after its last completed work.
It is **explicit-arm**: the host must call `arm()` once, or it never retires.
Report work with `touch()` (including when the resource the host supervises goes
away, to start the window then) or wrap it in `work(fn)`, which counts as busy
while pending and as activity when it settles, on success or failure. The timer
is unref'd and re-evaluates without ever writing the last-work time, so while the
host is busy (`work` pending, or `isBusy()` true) retirement can be up to one
window late. A throwing `isBusy` is treated as busy: it never retires on a guess.
`retire(reason)` is idempotent, runs every step in order even if one throws, and
holds the event loop open until the last step ends.

```typescript
import { createIdleRetirer } from '@adhd/sox-service-proxy';

let browserUp = true;
const retirer = createIdleRetirer({
  idleWindowMs: 30_000, // required, no default
  isBusy: () => browserUp, // a predicate over WORK, never over who is connected
  steps: [
    { name: 'stop-ticker', run: () => clearInterval(ticker) },
    { name: 'close-listener', run: () => backend.close() },
  ],
  onEvent: (e) => console.error('retirer', e.type),
});
const ticker = setInterval(() => retirer.touch(), 5_000).unref();
retirer.arm(); // once; nothing retires before this

await retirer.work(() => handleRequest()); // busy while pending, bumps on settle
browserUp = false;
retirer.touch(); // the resource went away: the idle window starts now
// 30 s later the steps run once, then retirer.state === 'retired'
```

`idleDueInMs({ busy, retiring, lastWorkAt, now, idleWindowMs })` is the pure
deadline arithmetic: `null` when busy or retiring, else the non-negative ms
remaining. Events: `armed`, `fired`, `retire-begin`, `retire-step-failed`,
`retired`. The retirer installs no signal handlers, never calls `process.exit`
and reads no environment variables.

### Circuit breaker

`createCircuitBreaker` is a small state machine for "stop relaunching something
that keeps failing". It defaults to 3 consecutive failures and a 30 s cooldown;
set `windowMs` to count failures within a window instead. After the cooldown
exactly **one** caller receives `{ open: false, probe: true }`; every other
caller keeps seeing the breaker open until that probe records a result (a probe
that never reports expires after `cooldownMs`, so a dead prober cannot wedge a
shared store). That single half-open probe is the one intended divergence from
the embedding funnel's breaker (`funnelClient.ts` has no half-open state: once the cooldown
elapses every caller is admitted, with concurrent ensures coalesced on one shared promise, and the
next failure re-opens it immediately); to
reproduce the funnel's thresholds use
`{ failureThreshold: 3, cooldownMs: 10_000 }`. The default store is in-memory;
supply a `BreakerStore` (`load()`/`save()`, synchronous) to share state across
processes. A throwing store degrades to in-memory and emits `store-failed`.

```typescript
import { createCircuitBreaker, type BreakerStore } from '@adhd/sox-service-proxy';

const breaker = createCircuitBreaker({
  failureThreshold: 3,
  cooldownMs: 30_000,
  windowMs: 60_000, // omit to count consecutive failures only
  onEvent: (e) => console.error('breaker', e.type),
});

async function launchGuarded() {
  const gate = breaker.check();
  if (gate.open) throw new Error(`launch circuit open, retry in ${gate.retryAfterMs} ms`);
  try {
    await launch(); // gate.probe === true means this call is the single half-open probe
    breaker.recordSuccess();
  } catch (e) {
    breaker.recordFailure();
    throw e;
  }
}
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
- **`ctx.connectionId` is the only per-connection handle.** It identifies a
  connection for the lifetime of one `serveBackend`; it is not persisted, not a
  credential, and must never feed a retire or keep-alive decision (ADR-0022).
- **This package has no CLI and no MCP SDK dependency.** It is a
  transport-agnostic JSON-RPC relay; the actual MCP tool dispatcher lives
  behind the `handler` you pass to `serveBackend`.
