# @adhd/sox-claim-verification

An NLI (Natural Language Inference) claim-grounding engine: given a claim and one or more candidate source texts, it returns a per-source entailment verdict (`entails` / `contradicts` / `neutral` / `unverifiable`) with a confidence score. Inference runs on a real cross-encoder NLI model, always inside a worker thread — never on the main thread — with an optional embedding pre-filter to skip NLI entirely for sources that are topically unrelated to the claim, and an LRU cache so repeat claim/source/model triples are free.

```bash
pnpm add @adhd/sox-claim-verification
```

## Quick start

```typescript
import { createClaimVerifier } from '@adhd/sox-claim-verification';

const verifier = await createClaimVerifier({
  modelId: 'MiniCheck',
  modelVersion: '1',
});
// createClaimVerifier() calls warmUp() for you — verifier.isReady is true once it resolves

const result = await verifier.verify(
  { id: 'claim-1', text: 'Paris is the capital of France.' },
  {
    id: 'source-1',
    text:
      'Paris is the capital of France and its most populous city, ' +
      'situated on the river Seine in the north of the country.',
  },
);

console.log(result.sourceResults[0].entailment);   // "entails"
console.log(result.sourceResults[0].confidence);    // e.g. 0.93
console.log(result.aggregateConfidence);            // 0.93

await verifier.shutdown();
```

## API reference

### `createClaimVerifier(config)`

```typescript
function createClaimVerifier(config: ClaimVerifierConfig): Promise<ClaimVerifier>;

interface ClaimVerifierConfig {
  modelId: string;                 // required
  modelVersion: string;            // required
  defaultPreFilterThreshold?: number; // 0..1 cosine-similarity gate; see "Embedding pre-filter" below
  minConfidenceThreshold?: number;    // default 0.5 — entailment below this downgrades to 'neutral'
  workerCount?: number;               // default 1 — number of worker threads to spin up
  maxQueueDepth?: number;
  embeddingProvider?: EmbeddingProvider; // from '@adhd/sox-embedding-provider'; required to use pre-filtering
  cache?: {
    maxSize?: number; // default 10_000
    ttlMs?: number;   // default: no expiry
  };
}
```

Throws `InvalidClaimInputError` synchronously if `modelId` or `modelVersion` is missing.

### `ClaimVerifier`

```typescript
interface ClaimVerifier {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly isReady: boolean;

  verify(claim: Claim, source: SourceRef, opts?: { preFilterThreshold?: number }): Promise<VerificationResult>;

  verifyBatch(pairs: ClaimSourcePair[], opts?: { preFilterThreshold?: number }): Promise<VerificationResult[]>;

  verifyStream(
    pairs: AsyncIterable<ClaimSourcePair>,
    opts?: { preFilterThreshold?: number },
  ): AsyncIterable<VerificationResult>;

  warmUp(): Promise<void>;        // idempotent; createClaimVerifier() already calls this
  healthCheck(): Promise<VerifierHealth>;
  shutdown(): Promise<void>;      // terminates every worker thread
}
```

### Core types

```typescript
interface Claim {
  id: string;
  text: string;
  language?: string;
  context?: string;
  metadata?: Record<string, unknown>;
}

interface SourceRef {
  id: string;
  text: string;
  language?: string;
  title?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

interface ClaimSourcePair {
  claim: Claim;
  sources: SourceRef[]; // one claim checked against many sources
}

type EntailmentLabel = 'entails' | 'contradicts' | 'neutral' | 'unverifiable';

interface SingleSourceResult {
  sourceId: string;
  entailment: EntailmentLabel;
  confidence: number;
  preFilterSkipped: boolean;
  preFilterScore?: number;    // present when a pre-filter ran
  languageMismatch?: boolean;
  timingMs: number;
}

interface VerificationResult {
  claimId: string;
  sourceResults: SingleSourceResult[];
  aggregateConfidence: number; // = confidence when 'entails', min(confidence,1) when 'contradicts', 0 otherwise;
                                // for verifyBatch, the MIN confidence across all sources for that claim
  modelId: string;
  modelVersion: string;
  totalTimingMs: number;
  metadata?: Record<string, unknown>;
}
```

### Health and lifecycle

```typescript
const health = await verifier.healthCheck();
// {
//   isReady: true, isWarmingUp: false,
//   modelId: 'MiniCheck', modelVersion: '1',
//   queuedJobs: 0, activeJobs: 0,
//   workerStatus: [{ workerId: 0, isBusy: false, queuedJobs: 0, lastActivityMs: 12 }],
//   uptimeMs: 4213,
// }
```

```typescript
interface VerifierHealth {
  isReady: boolean;
  isWarmingUp: boolean;
  modelId: string;
  modelVersion: string;
  queuedJobs: number;
  activeJobs: number;
  workerStatus: WorkerStatus[];
  lastError?: string;
  uptimeMs: number;
}

interface WorkerStatus {
  workerId: number;
  isBusy: boolean;
  queuedJobs: number;
  lastActivityMs: number;
}
```

Always call `verifier.shutdown()` when you're done — it terminates every worker thread the verifier started.

## Verifying multiple sources for one claim

```typescript
const results = await verifier.verifyBatch([
  {
    claim: { id: 'c1', text: 'The company was founded in 2015.' },
    sources: [
      { id: 's1', text: 'Founded in 2015, the company grew quickly.' },
      { id: 's2', text: 'The company has no publicly stated founding date.' },
    ],
  },
]);

console.log(results[0].sourceResults.length); // 2 — one result per source
console.log(results[0].aggregateConfidence);   // the MIN confidence across both sources
```

## Streaming verification

`verifyStream` accepts an async iterable of pairs and yields results as they complete — useful when claim/source pairs are themselves produced incrementally:

```typescript
async function* pairs(): AsyncIterable<ClaimSourcePair> {
  yield { claim: { id: 'c1', text: 'X happened in 2020.' }, sources: [{ id: 's1', text: 'X happened in 2020.' }] };
  yield { claim: { id: 'c2', text: 'Y is true.' }, sources: [{ id: 's2', text: 'Y is false.' }] };
}

for await (const result of verifier.verifyStream(pairs())) {
  console.log(result.claimId, result.aggregateConfidence);
}
```

## Embedding pre-filter

Pass an `embeddingProvider` and a `defaultPreFilterThreshold` to skip the (comparatively expensive) NLI pass for claim/source pairs that aren't even topically related — a cosine-similarity check runs first, and only pairs above the threshold reach the worker thread:

```typescript
import { createEmbeddingProvider } from '@adhd/sox-embedding-provider';
import { createClaimVerifier } from '@adhd/sox-claim-verification';

const embeddingProvider = await createEmbeddingProvider({ /* ... */ });

const verifier = await createClaimVerifier({
  modelId: 'MiniCheck',
  modelVersion: '1',
  embeddingProvider,
  defaultPreFilterThreshold: 0.3,
});

const result = await verifier.verify(
  { id: 'c1', text: 'The stock market crashed in 1929.' },
  { id: 's1', text: 'Recipe for banana bread: mix flour, sugar, and bananas.' },
);
// result.sourceResults[0].entailment === 'unverifiable'
// result.sourceResults[0].preFilterSkipped === true
// result.sourceResults[0].preFilterScore is set, and NLI never ran for this pair
```

You can also override the threshold per call via `opts.preFilterThreshold` on `verify()`/`verifyBatch()`/`verifyStream()` without changing the verifier's configured default. The pre-filter uses its own `embeddingProvider` instance — it is never coupled to a retrieval/embedding pipeline elsewhere in your application.

## Claim normalization

Every claim and source is normalized before it reaches the model — citation markers (`[1]`, `[1, 2, 3]`), `(p. 12)`-style page references, `(Smith et al., 2020)`-style inline citations, and both straight and curly quotation marks are stripped, while sentence-ending punctuation is preserved:

```typescript
import { DefaultClaimNormalizer } from '@adhd/sox-claim-verification';

const normalizer = new DefaultClaimNormalizer();
normalizer.normalizeClaim('This is a test [1].');           // "This is a test."
normalizer.normalizeClaim('He said "hello"');                // "He said hello"
normalizer.normalizeSource('Section 1: Introduction');        // "Section 1: Introduction" (unchanged — source text keeps its markers)
```

`ClaimVerifier` uses `DefaultClaimNormalizer` internally; the exported class and `ClaimNormalizer` interface exist for callers who want to normalize text themselves before inspecting it, or plug in a custom implementation.

## Result caching

`ClaimVerifier` caches results keyed by `sha256(claimText + sourceText + modelVersion)` via an `LRUVerificationCache`, sized by `config.cache.maxSize` (default 10,000) with an optional `ttlMs`. The same class is exported directly if you want an independent cache:

```typescript
import { LRUVerificationCache } from '@adhd/sox-claim-verification';

const cache = new LRUVerificationCache(1000, 60_000); // maxSize=1000, ttlMs=60s
await cache.set('key', { sourceId: 's1', entailment: 'entails', confidence: 0.9, preFilterSkipped: false, timingMs: 10 });
const hit = await cache.get('key'); // undefined once maxSize is exceeded (LRU-evicted) or ttlMs elapses
```

## Model registry

`InMemoryModelRegistry` tracks which models are currently loaded — `createClaimVerifier` registers its model automatically on `warmUp()`:

```typescript
import { InMemoryModelRegistry } from '@adhd/sox-claim-verification';

const registry = new InMemoryModelRegistry();
await registry.register({
  modelId: 'MiniCheck',
  version: '1',
  nliModel: true,
  loadedAt: new Date().toISOString(),
});
await registry.isLoaded('MiniCheck'); // true
await registry.list();                // [{ modelId: 'MiniCheck', version: '1', ... }]
await registry.deregister('MiniCheck');
```

```typescript
interface ModelRegistration {
  modelId: string;
  version: string;
  displayName?: string;
  providerUri?: string;
  nliModel: boolean;
  dimensions?: number;
  loadedAt: string;
}

interface ModelRegistry {
  register(model: ModelRegistration): Promise<void>;
  deregister(modelId: string): Promise<void>;
  get(modelId: string): Promise<ModelRegistration | undefined>;
  list(): Promise<ModelRegistration[]>;
  isLoaded(modelId: string): Promise<boolean>;
}
```

## Error taxonomy

```typescript
class ModelNotLoadedError extends Error { modelId: string; }       // thrown by verify() before warmUp() completes
class VerifierBusyError extends Error { retryAfterMs?: number; }
class UnsupportedLanguageError extends Error { language: string; }
class PreFilterSkippedError extends Error { score: number; threshold: number; }
class InvalidClaimInputError extends Error {}                       // e.g. empty claim/source text, missing modelId
```

## Invariants

- **ONNX inference runs exclusively in worker threads, never on the main thread.** `workerCount` controls how many worker threads are started; `verify()` load-balances across whichever workers aren't currently busy.
- **`warmUp()` must complete before any `verify*` call.** `createClaimVerifier()` already awaits this for you; calling `verify()` on a verifier that hasn't warmed up throws `ModelNotLoadedError`.
- **A claim/source language mismatch downgrades the result to `'neutral'` — it never throws.**
- **A result below `minConfidenceThreshold` (default `0.5`) for an `entails`/`contradicts` verdict is downgraded to `'neutral'`** before being returned or cached.
- **Claim normalization always strips citation markers and quotation marks before the text reaches NLI** — `normalizeSource` is deliberately gentler, preserving structural markers like `"Section 1:"`.
