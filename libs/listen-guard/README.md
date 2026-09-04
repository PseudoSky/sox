# @adhd/sox-listen-guard

A safety wrapper around `net.Server#listen()`: probe the port before binding, attach the `'error'`
listener *before* calling `listen()` so a bind failure resolves instead of crashing the process, and
append a structured JSONL record of what happened. Dependency-free — Node builtins only (`net`,
`fs`, `path`), nothing else in `node_modules` to audit.

The problem this solves: `server.listen(port, host, cb)` with no `'error'` listener attached first
means a port collision throws an *unhandled* `'error'` event, which Node treats as fatal — the whole
process dies with a raw crash dump instead of a clean, recoverable outcome.

```bash
pnpm add @adhd/sox-listen-guard
```

## Quick start

```typescript
import * as net from 'node:net';
import { listenGuarded } from '@adhd/sox-listen-guard';

const server = net.createServer((socket) => {
  socket.end('hello\n');
});

const outcome = await listenGuarded(server, { port: 3099, host: '127.0.0.1' });

if (outcome.ok) {
  console.log('listening on 3099');
} else if (outcome.disposition === 'already-running') {
  // another instance is already serving this port — exit 0, not an error
  console.log('already running, nothing to do:', outcome.failure.message);
  process.exit(0);
} else {
  // a genuine bind fault (EACCES, ENOENT, ...) — exit 1
  console.error('listen failed:', outcome.failure.message);
  process.exit(1);
}
```

Note what never happens here: no `try`/`catch`, no `server.on('error', ...)` of your own, and no
unhandled-error crash if the port is already held — `listenGuarded` resolves a typed outcome in every
case.

## API reference

```typescript
function listenGuarded(
  server: net.Server,
  target: ListenTarget,
  opts?: ListenGuardOptions,
): Promise<ListenOutcome>;

interface ListenTarget {
  port?: number;       // TCP
  host?: string;       // TCP, default '127.0.0.1'
  socketPath?: string;  // Unix domain socket
  fd?: number;           // an inherited/socket-activated file descriptor
}

interface ListenGuardOptions {
  recordFile?: string;                    // JSONL path to append a ListenFailureRecord to on failure
  onDiagnostic?: (line: string) => void;  // stderr-style diagnostics sink
  probeTimeoutMs?: number;                 // TCP probe timeout, default 250
}

type ListenOutcome =
  | { ok: true }
  | { ok: false; disposition: ListenDisposition; failure: ListenFailureRecord };

type ListenDisposition = 'already-running' | 'other';
```

For a TCP `target` (`port` set), `listenGuarded` first probes the port with a real connection
attempt. If something is already accepting connections there, it resolves
`{ ok: false, disposition: 'already-running' }` **without ever calling `listen()`** — the fast path.
Otherwise it attaches the `'error'` listener, calls `listen()`, and resolves once either `'listening'`
or `'error'` fires. A Unix-domain-socket `target` (`socketPath` set) skips the probe — the caller owns
its own stale-socket logic — and relies solely on the pre-attached error guard.

### Building blocks

`listenGuarded` is built from four standalone functions, each exported so an already-guarded
`listen()` call site can reuse just the piece it needs:

```typescript
function probeTcp(host: string, port: number, timeoutMs?: number): Promise<boolean>;
function classifyListenError(err: unknown): ListenDisposition;
function buildFailureRecord(err: unknown, disposition: ListenDisposition, target: ListenTarget): ListenFailureRecord;
function emitListenFailure(rec: ListenFailureRecord, opts?: EmitFailureOptions): void;

interface EmitFailureOptions {
  recordFile?: string;
}
```

```typescript
import { probeTcp, classifyListenError, buildFailureRecord, emitListenFailure } from '@adhd/sox-listen-guard';

// A call site that already has its own 'error' listener wired can still get
// the same structured record and probe-before-bind behavior:
if (await probeTcp('127.0.0.1', 3099)) {
  const failure = buildFailureRecord(null, 'already-running', { port: 3099, host: '127.0.0.1' });
  emitListenFailure(failure, { recordFile: './listen-failures.jsonl' });
}

server.once('error', (err) => {
  const disposition = classifyListenError(err); // EADDRINUSE -> 'already-running', else 'other'
  const failure = buildFailureRecord(err, disposition, { port: 3099 });
  emitListenFailure(failure, { recordFile: './listen-failures.jsonl' });
});
```

### The failure record

```typescript
interface ListenFailureRecord {
  code?: string;       // errno code, e.g. 'EADDRINUSE', 'EACCES', 'ENOENT'
  errno?: string;
  syscall?: string;    // e.g. 'listen'
  message: string;
  host?: string;       // TCP
  port?: number;       // TCP
  socketPath?: string; // UDS
  disposition: ListenDisposition;
  pid: number;
  ts: string;          // ISO-8601
}
```

`emitListenFailure` appends one JSON line per failure to `opts.recordFile` (creating the parent
directory as needed) — best-effort: a failed write to the record file is swallowed rather than
thrown, since the record is diagnostics, not control flow.

## Invariants

- `classifyListenError` maps `EADDRINUSE` to `'already-running'`; every other errno maps to
  `'other'`. That split is the intended exit-code convention: `'already-running'` means another
  instance is already serving (safe to exit 0), `'other'` means a genuine fault (exit 1).
- `listenGuarded` never throws for a bind failure — it always resolves a `ListenOutcome`. The
  `'error'` listener is attached before `server.listen()` is ever called, so a bind failure cannot
  surface as an unhandled `'error'` event.
- `emitListenFailure` never throws, even if `recordFile`'s directory can't be created or the append
  fails.
