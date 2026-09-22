# @adhd/sox-embedding-provider

A pluggable text→vector embedding provider. One `EmbeddingProvider` interface, one
`createEmbeddingProvider(config)` factory, config-driven model resolution, and an async
batch-first API (`AsyncIterable<Float32Array>`) so a caller gets the first vector back before the
last one in a large batch finishes computing. The default provider is `fastembed` — local ONNX
inference, no network calls, no API key. A `remote` provider is also built in for calling an
HTTP embedding endpoint. `createEmbeddingProvider()` **throws** a typed `ResolutionError`
synchronously (or as a rejection) if the config is invalid or the model fails to load — it never
silently degrades to a different provider.

```bash
pnpm add @adhd/sox-embedding-provider
```

## Quick start

```typescript
import { createEmbeddingProvider } from '@adhd/sox-embedding-provider';

const provider = await createEmbeddingProvider({
  type: 'fastembed',
  model: 'bge-small-en-v1.5',
});

console.log(provider.metadata);
// { modelId: 'bge-small-en-v1.5', dimensions: 384, maxTokens: 512, isRemote: false, isDeterministic: false }

const vec = await provider.embedSingle('The quick brown fox jumps over the lazy dog');
console.log(vec.length); // 384

for await (const v of provider.embedBatch(['first document', 'second document', 'third document'])) {
  console.log(v.length); // 384, one vector per input text, streamed as each is ready
}
```

## API reference

### `createEmbeddingProvider(config): Promise<EmbeddingProvider>`

```typescript
interface EmbeddingProviderConfig {
  type: string;    // 'fastembed' | 'remote'
  model: string;
  options?: Record<string, unknown>;
  host?: 'shared' | 'private';  // default 'shared' — see "Host posture" below
  idleGraceMs?: number;         // how long an idle shared host lingers (default 30000)
}
```

Throws `ResolutionError` if `type` is missing/unknown, or if the model/runtime cannot be loaded.
Never throws mid-call afterward — resolution failures happen only at factory time.

### `EmbeddingProvider`

```typescript
interface EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;
  embedSingle(text: string, role?: EmbedRole): Promise<Float32Array>;
  embedBatch(texts: string[], opts?: { role?: EmbedRole; batchSize?: number }): AsyncIterable<Float32Array>;
  warmUp(texts: string[]): Promise<void>;
  health(): EmbeddingHealth;
}

type EmbedRole = 'document' | 'query';

interface EmbeddingProviderMetadata {
  modelId: string;
  dimensions: number;
  maxTokens: number;
  isRemote: boolean;
  isDeterministic: boolean;
  providerUri?: string;
}

interface EmbeddingHealth {
  configured: string;       // e.g. 'fastembed:bge-base-en-v1.5'
  active: string | null;    // null until warm — never a placeholder model name
  state: 'uninitialized' | 'warming' | 'real' | 'error';
  dimensions: number | null;
  last_error: string | null;
  execution_provider?: string;
}
```

Every provider advertises its `dimensions` via `metadata` — never hardcode a vector dimension for
a model; read it from the provider you constructed. `warmUp()` is currently a no-op on every
shipped provider (fastembed and remote both report `isDeterministic: false`, and warm caching is
only meaningful for deterministic providers) — it's safe to call, but don't rely on it to
pre-populate a cache today.

### fastembed — local ONNX models

```typescript
const provider = await createEmbeddingProvider({
  type: 'fastembed',
  model: 'bge-m3',              // defaults to 'bge-base-en-v1.5' if omitted
  options: { cacheDir: '/custom/model/cache/path' },  // optional; falls back to $SOX_EMBED_CACHE_DIR, then ~/.cache/sox/models
});
```

Built-in models (`modelId` → dimensions):

| `modelId` | dim | max tokens | notes |
|---|---|---|---|
| `bge-small-en-v1.5` | 384 | 512 | lightweight, ~33M params |
| `bge-base-en-v1.5` | 768 | 512 | balanced, ~110M params (default) |
| `multilingual-e5-large` | 1024 | 512 | 100+ languages, ~335M params |
| `bge-m3` | 1024 | 8192 | 100+ languages, long context, ~570M params |
| `codexembed-400m` | 1024 | 8192 | code-only, ~1.6GB RAM, long context |

fastembed inference is routed through **one machine-wide, peer-spawned, self-reaping host
process** per `(model, execution-provider, cacheDir)` — not one ONNX host per consumer process.
The first consumer to need it peer-spawns the host through the service-proxy's `ensureBackend()`
singleton spawn-lock; every other consumer on the box dials that same host over a Unix domain
socket. The host is compute-only (it holds no store connection) and it **reaps itself**: a
debounced, ref-counted teardown retires it `idleGraceMs` after the last client disconnects and its
last in-flight request drains. There is no supervised service and no daemon.

#### Host posture

`EmbeddingProviderConfig.host` is a typed closed union (default `'shared'`), applied
process-wide before the accessor is constructed and reported in `health().host`:

- `'shared'` — funnel through the machine-wide host above. `getSharedFastembedProcess()` returns a
  `FunneledFastembedClient`; its `terminate()` is a **no-op** (a consumer must never kill a host
  other consumers are using).
- `'private'` — the pre-funnel per-process fork (CI/diagnostics). `getSharedFastembedProcess()`
  returns the private pool directly.

`EmbeddingProviderConfig.idleGraceMs` (typed config, default `DEFAULT_EMBED_HOST_IDLE_GRACE_MS` =
30 s) sets how long a zero-client host lingers before it reaps itself. A host that fails to come up
throws a typed `TransientEmbeddingError` naming the socket — it never silently falls back to a
private host.

#### Lifecycle helpers

```typescript
import {
  getPrivateFastembedProcess,   // the PRIVATE (un-funneled) per-process pool
  resetSharedFastembedHost,     // heal: ask the live shared host to re-fork its private pool
  getSharedFastembedProcess,    // the host-aware accessor (shared by default)
  FunneledFastembedClient,      // what getSharedFastembedProcess() returns under 'shared'
} from '@adhd/sox-embedding-provider';

const client = getSharedFastembedProcess();  // FunneledFastembedClient under the default
const vec = await client.request({ type: 'embed', text: 'hello' });
console.log(client.started, client.pendingCount, client.hostSocketPath);
```

`resetSharedFastembedHost()` is the recovery path for a wedged private child: under `'shared'` it
asks the live host to tear down and re-fork its private ONNX pool (without killing the host other
consumers share); under `'private'` the accessor's `terminate()` path is unchanged.

### remote — call an HTTP embedding endpoint

```typescript
const provider = await createEmbeddingProvider({
  type: 'remote',
  model: 'remote-768',
  options: {
    endpoint: 'https://your-embedding-service.example.com/v1',
    apiKey: process.env.EMBEDDING_API_KEY,
    dimensions: 768,  // optional, default 768
  },
});
```

`options.endpoint` is required — `createEmbeddingProvider` throws `ResolutionError` without it.

### Error taxonomy

```typescript
class TransientEmbeddingError extends Error { readonly retryAfterMs?: number; }
class PermanentEmbeddingError extends Error {}
class ResolutionError extends Error {}
```

- `ResolutionError` — factory-time only (bad config, model can't load). Never thrown mid-call.
- `TransientEmbeddingError` — the caller may retry (e.g. a transient network hiccup on a remote call).
- `PermanentEmbeddingError` — the caller must not retry (e.g. empty input text, an invalid API key shape).

```typescript
import { TransientEmbeddingError, PermanentEmbeddingError } from '@adhd/sox-embedding-provider';

try {
  await provider.embedSingle(text);
} catch (err) {
  if (err instanceof TransientEmbeddingError) {
    // back off and retry, honoring err.retryAfterMs if present
  } else if (err instanceof PermanentEmbeddingError) {
    // do not retry — the input or config itself is the problem
  } else {
    throw err;
  }
}
```

## Invariants

- `createEmbeddingProvider()` throws `ResolutionError` synchronously or as a rejection if the
  config is invalid or the model/runtime cannot load — never a silent downgrade to another provider.
- Every provider advertises `{ modelId, dimensions, isRemote, isDeterministic, providerUri? }` via
  `metadata` — callers never hardcode dimensions.
- `embedBatch()` returns `AsyncIterable<Float32Array>` — callers receive the first result before
  the last batch finishes, which matters for sequential local inference.
- `warmUp()` is a no-op when `isDeterministic === false` — currently always true, since every
  shipped provider hard-codes `isDeterministic: false`.
- `TransientEmbeddingError` → caller may retry; `PermanentEmbeddingError` → caller must not retry;
  `ResolutionError` → factory-time only, never thrown mid-call.
