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

fastembed inference is routed through a single process-wide shared child process rather than a
worker per provider instance, so multiple `FastembedProvider`s constructed in the same Node process
(even concurrently) never race each other for the same native ONNX runtime.

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
