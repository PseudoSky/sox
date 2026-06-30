# SPEC — `@adhd/sox-claim-verification`

> Q&A-iterated design, 2026-06-29. All outstanding questions resolved (see §Decisions log).
> NLI-based (Natural Language Inference) claim grounding engine. Cross-encoder NLI is used
> over embedding similarity because of the **Semantic Illusion** failure mode: cosine-similarity
> classifiers achieve 0% FPR on synthetic hallucinations but **100% FPR on real-world
> hallucinations** at the same threshold (McKenna et al., 2023). NLI cross-encoders degrade
> gracefully where embedding similarity catastrophically fails.
>
> **Worker-thread requirement (BL-11):** ONNX/NLP inference never runs on the main thread
> when `better-sqlite3` is also present in the process. Both bindings block the event loop;
> the SQLite3 WAL checkpoint + ONNX session forward-pass must be isolated to a worker to
> avoid 500ms+ latency spikes on the main thread.

---

## Supporting types

```ts
// ── Claim & Source ───────────────────────────────────────────────────────────

interface Claim {
  id: string
  text: string                       // The assertion to verify
  language?: string                  // ISO 639-1, default "en"
  context?: string                   // Surrounding paragraph for disambiguation
  metadata?: Record<string, unknown>
}

interface SourceRef {
  id: string
  text: string                       // Source passage the claim is compared against
  language?: string                  // ISO 639-1, default "en"
  title?: string
  url?: string
  metadata?: Record<string, unknown>
}

interface ClaimSourcePair {
  claim: Claim
  sources: SourceRef[]               // Multi-source: one claim, many sources
}
```

---

## Claim normalization

```ts
interface ClaimNormalizer {
  // Strip citation markers, normalize whitespace, remove quotation marks.
  // Preserves punctuation for sentence boundary detection.
  normalizeClaim(text: string): string

  // Same pipeline as normalizeClaim, but preserves source-level markers
  // (section headings, line numbers) that may be meaningful for retrieval.
  normalizeSource(text: string): string
}
```

Normalization steps:

1. **Strip citation markers** — removes patterns like `[1]`, `[1, 2]`, `(p. 14)`, `(Smith et al., 2020)`, `{id: abc123}`
2. **Normalize whitespace** — collapse runs of whitespace to a single space, trim leading/trailing
3. **Remove quotation marks** — both curly (`""`, `''`) and straight (`"`, `'`) quotes stripped. Keeps apostrophes inside words (`don't` → left intact)
4. **Preserve punctuation** — periods, commas, semicolons, colons, and parentheses are kept for sentence boundary detection during NLI tokenization

Implementation note: normalization runs before NLI inference but after pre-filter embedding. The pre-filter sees the raw text to capture topic-level signal; NLI sees normalized text for accurate entailment judgment.

---

## Verification results

```ts
type EntailmentLabel = 'entails' | 'contradicts' | 'neutral' | 'unverifiable'

interface SingleSourceResult {
  sourceId: string
  entailment: EntailmentLabel
  confidence: number                 // [0, 1]; meaningless when status is 'unverifiable'
  preFilterSkipped: boolean          // true → NLI was skipped; confidence is 0
  preFilterScore?: number            // Cosine similarity that triggered the skip
  languageMismatch?: boolean         // Claim language ≠ source language; entailment forced to 'neutral' with warning
  timingMs: number                   // Wall-clock ms for this source only
}

interface VerificationResult {
  claimId: string
  sourceResults: SingleSourceResult[]
  aggregateConfidence: number        // Weighted across sources (min for 'contradicts')
  modelId: string
  modelVersion: string
  totalTimingMs: number
  metadata?: Record<string, unknown>
}
```

---

## `ClaimVerifier` — public API

```ts
interface ClaimVerifier {
  readonly modelId: string
  readonly modelVersion: string
  readonly isReady: boolean          // warmUp completed, accepting work

  // Single claim → single source.
  // preFilterThreshold = undefined → use config default; 0 = skip pre-filter.
  verify(
    claim: Claim,
    source: SourceRef,
    opts?: { preFilterThreshold?: number }
  ): Promise<VerificationResult>

  // Batch — each ClaimSourcePair may have multiple sources.
  // All pairs processed before the promise resolves.
  verifyBatch(
    pairs: ClaimSourcePair[],
    opts?: { preFilterThreshold?: number }
  ): Promise<VerificationResult[]>

  // Streaming batch — caller processes results as they complete.
  // Order is not guaranteed to match input order.
  verifyStream(
    pairs: AsyncIterable<ClaimSourcePair>,
    opts?: { preFilterThreshold?: number }
  ): AsyncIterable<VerificationResult>

  // Pre-load models into the worker. Must resolve before verify* calls.
  // Rejects if models cannot be loaded (→ ModelNotLoadedError).
  warmUp(): Promise<void>

  // Returns status without throwing — useful for health checks.
  healthCheck(): Promise<VerifierHealth>

  // Tear down worker. No verify* calls after this.
  shutdown(): Promise<void>
}
```

---

## Factory

```ts
interface ClaimVerifierConfig {
  // Model identifier in the registry. E.g. "microsoft/deberta-large-mnli"
  modelId: string
  // Model version for audit traceability. Pinned at factory time.
  modelVersion: string
  // Default pre-filter threshold. Claims below this cosine similarity skip NLI.
  // 0 = disabled (all pairs get NLI). Default: 0.
  defaultPreFilterThreshold?: number
  // Minimum confidence for 'entails' / 'contradicts' labels to be accepted.
  // Below this → label downgraded to 'neutral'. Default: 0.5.
  minConfidenceThreshold?: number
  // Worker thread pool size. Default: 1.
  workerCount?: number
  // Maximum queue depth per worker before VerifierBusyError. Default: 100.
  maxQueueDepth?: number
  // Embedding provider for pre-filter. Required if preFilterThreshold > 0.
  embeddingProvider?: import('@adhd/sox-embedding-provider').EmbeddingProvider
  // Verification cache settings. When configured, identical claim-source pairs
  // within the TTL window return cached results without re-running NLI.
  cache?: {
    maxSize?: number               // Max cache entries. Default: 10000. LRU eviction.
    ttlMs?: number                 // Time-to-live in milliseconds. Default: no TTL.
  }
}

function createClaimVerifier(config: ClaimVerifierConfig): Promise<ClaimVerifier>
```

---

## Verification cache

```ts
interface VerificationCache {
  get(key: string): Promise<SingleSourceResult | undefined>
  set(key: string, result: SingleSourceResult): Promise<void>
  clear(): Promise<void>
}
```

Cache key: `SHA-256(claimText + sourceText + modelVersion)`. Entries are evicted
LRU when `maxSize` is reached. The cache is local to the `ClaimVerifier` instance
and is NOT shared across workers or processes.

---

## Model registry — version tracking

```ts
interface ModelRegistration {
  modelId: string
  version: string
  displayName?: string
  providerUri?: string              // "local:onnx", "https://huggingface.co/..."
  nliModel: boolean                 // true = cross-encoder NLI; false = embedding only
  dimensions?: number               // embedding dimensions (for pre-filter models)
  loadedAt: string                  // ISO timestamp
}

interface ModelRegistry {
  register(model: ModelRegistration): Promise<void>
  deregister(modelId: string): Promise<void>
  get(modelId: string): Promise<ModelRegistration | undefined>
  list(): Promise<ModelRegistration[]>
  isLoaded(modelId: string): Promise<boolean>
}
```

---

## Verifier health / warmup status

```ts
interface VerifierHealth {
  isReady: boolean                   // warmUp completed, accepting work
  isWarmingUp: boolean               // warmUp in progress
  modelId: string
  modelVersion: string
  queuedJobs: number                 // pending across all workers
  activeJobs: number                 // currently executing
  workerStatus: WorkerStatus[]
  lastError?: string                 // last non-transient error message
  uptimeMs: number
}

interface WorkerStatus {
  workerId: number
  isBusy: boolean
  queuedJobs: number
  lastActivityMs: number
}
```

---

## Worker thread protocol

Mirrors the pattern from `libs/data/embed/embedding-provider/src/embedWorker.ts`.
Messages are discriminated on `type`; all payloads are serializable (no functions, no symbols).

```ts
// ── Main → Worker ───────────────────────────────────────────────────────────

interface WorkerInitMessage {
  type: 'init'
  modelId: string
  modelVersion: string
  preFilterThreshold?: number
  minConfidenceThreshold?: number
}

interface WorkerWarmupMessage {
  type: 'warmup'
}

interface WorkerVerifyMessage {
  type: 'verify'
  jobId: string
  claimText: string
  sourceText: string
  claimLang?: string
  sourceLang?: string
  preFilterThreshold?: number        // per-call override
}

interface WorkerVerifyBatchMessage {
  type: 'verifyBatch'
  jobId: string
  pairs: Array<{
    jobId: string
    claimText: string
    sourceText: string
    claimLang?: string
    sourceLang?: string
    preFilterThreshold?: number
  }>
}

interface WorkerShutdownMessage {
  type: 'shutdown'
}

// ── Worker → Main ───────────────────────────────────────────────────────────

interface WorkerReadyMessage {
  type: 'ready'
}

interface WorkerWarmupCompleteMessage {
  type: 'warmupComplete'
  modelId: string
  modelVersion: string
}

interface WorkerResultMessage {
  type: 'result'
  jobId: string
  entailment: EntailmentLabel
  confidence: number
  preFilterSkipped: boolean
  preFilterScore?: number
  timingMs: number
}

interface WorkerError {
  type: 'error'
  jobId: string
  errorCode: string
  errorMessage: string
}

interface WorkerProgressMessage {
  type: 'progress'
  jobId: string
  completed: number
  total: number
}

interface WorkerShutdownCompleteMessage {
  type: 'shutdownComplete'
}

// Discriminated union for the worker → main channel:
type WorkerToMainMessage =
  | WorkerReadyMessage
  | WorkerWarmupCompleteMessage
  | WorkerResultMessage
  | WorkerError
  | WorkerProgressMessage
  | WorkerShutdownCompleteMessage

// Discriminated union for the main → worker channel:
type MainToWorkerMessage =
  | WorkerInitMessage
  | WorkerWarmupMessage
  | WorkerVerifyMessage
  | WorkerVerifyBatchMessage
  | WorkerShutdownMessage
```

---

## Error taxonomy

```ts
class ModelNotLoadedError extends Error {
  constructor(message: string, public readonly modelId: string) {
    super(message); this.name = 'ModelNotLoadedError'
  }
}

class VerifierBusyError extends Error {
  constructor(message: string, public readonly retryAfterMs?: number) {
    super(message); this.name = 'VerifierBusyError'
  }
}

class UnsupportedLanguageError extends Error {
  constructor(message: string, public readonly language: string) {
    super(message); this.name = 'UnsupportedLanguageError'
  }
}

class PreFilterSkippedError extends Error {
  constructor(
    message: string,
    public readonly score: number,
    public readonly threshold: number
  ) {
    super(message); this.name = 'PreFilterSkippedError'
  }
}

class InvalidClaimInputError extends Error {
  constructor(message: string) {
    super(message); this.name = 'InvalidClaimInputError'
  }
}
```

---

## Pre-filter design

The pre-filter gate uses embedding cosine similarity to decide whether NLI should run:

```
embed(claim) × embed(source)  ─cosine─→  score
                                            │
                          score < threshold ─┤─→ return 'unverifiable'
                                            │
                          score ≥ threshold ─┤─→ run NLI cross-encoder
```

**Why not skip the pre-filter entirely and just use embedding similarity for verification?**

The **Semantic Illusion** paper (McKenna et al., 2023) demonstrated that embedding-based
verification produces **0% false positive rate on synthetic (artificially constructed)
hallucinations** but **100% false positive rate on real-world hallucinations** — at the
exact same threshold. Real claims and their supporting (but non-entailing) source passages
are semantically similar in embedding space. NLI cross-encoders are the only reliable
method for actual entailment judgment.

The pre-filter's job is limited to **topic gating**: if the claim and source discuss
completely different topics (cosine < threshold), NLI would be meaningless — the result
is predictably `contradicts` with no signal. This saves compute on obvious mismatches.
The pre-filter should never be used as a substitute for NLI.

**Pre-filter embedding provider is separate from the retrieval pipeline.** The pre-filter
uses a dedicated embedding provider, configured independently via `ClaimVerifierConfig.embeddingProvider`.
This is deliberately NOT the same provider used by the main retrieval pipeline (`@adhd/sox-embedding-provider`
in the `data/` layer). The decoupling avoids coupling the two models' lifecycles — the pre-filter
model can be updated, swapped, or removed without affecting document retrieval, and vice versa.
The pre-filter provider runs in its own worker thread, separate from both the NLI worker pool
and the retrieval pipeline's embedding workers.

---

## Use case mapping

### Use Case 1: Academic Peer Review Assistant

- Batch of 50–100 `ClaimSourcePair` per submission via `verifyBatch`.
- Each pair is one claim + one source (citation).
- `aggregateConfidence` drives acceptance/rejection flags in the review UI.
- `modelVersion` pinned for audit trail across review rounds.
- Pre-filter typically **disabled** (threshold = 0) — citation claims are on-topic by
  construction; skipping NLI saves no compute and risks false `unverifiable`.
- Claims exceeding the NLI token limit are **tail-truncated** (last tokens dropped).
  For academic citations this is typically safe — the claim body carries the semantic
  signal, and trailing metadata (page numbers, DOI) are low-information.

### Use Case 2: Newsroom Fact-Checking Pipeline

- Pre-filter **enabled** (threshold ~0.3–0.5) — most draft claims don't match any
  specific source passage; fast topic-gate avoids wasted NLI.
- `verifyStream` for progressive UI updates as each statement is checked.
- Fully offline: `embeddingProvider` configured as `local:onnx` with same worker pool.
- `minConfidenceThreshold` set high (~0.8) for publication-grade claims; results
  below that are surfaced to human editors as `neutral`.

### Use Case 3: Regulatory Compliance Report Validation

- Multi-source: one `Claim` references multiple policy `SourceRef` entries.
- `sourceResults` array gives per-document breakdown for auditor review.
- `preFilterSkipped` alerts auditor when a source was on a different topic than the
  claim — investigation-worthy rather than silent contradiction.
- Model version pinned at filing date; registry tracks which models were available.
- Claims exceeding the NLI token limit are **tail-truncated** by default. However,
  regulatory claims often place citations, conclusions, and legal findings at the end
  of the text — tail-truncation loses this signal. Head-truncation (dropping the preamble)
  preserves the conclusion and may be more appropriate for this use case. The truncation
  strategy is configurable per-call.
- Audit record: `{ verificationResult, configSnapshot, tVerified }` persisted to DB.

---

## Dispatch

| | |
|---|---|
| **Agent** | `flash` |
| **Spec section** | Full document — new leaf package |
| **Files** | `libs/data/verify/claim-verification/` (new) |
| **Depends on** | none |

**Prompt notes for the agent:**
- Mirror the worker thread protocol from `libs/data/embed/embedding-provider/src/embedWorker.ts` exactly (init → warmup → verify → verifyBatch → shutdown message types)
- The MiniCheck NLI model is downloaded on first `warmUp()`. Stub the ONNX path with a `DeterministicProvider`-style fallback for tests (return predictable entailment based on claim text hash)
- Pre-filter uses a separate embedding provider instance — do NOT couple to the retrieval pipeline's embedder
- The `EmbeddingProvider` type is imported from `@adhd/sox-embedding-provider` (already published). Do not re-define the interface
- Worker pool size defaults to 1 (cross-encoders are memory-heavy)
- All errors extend `Error` with descriptive names
- Observability: `console` logging with `[claim-verifier]` prefix
- Live verification: follow `CONTRIBUTING.md` §2.x for data lib (new leaf package)

---

## Decisions log

| # | Decision | Rationale | Affected areas |
|---|---|---|---|
| D1 | Pre-filter uses a dedicated embedding provider, NOT the main retrieval pipeline's embedding provider | Avoids coupling the two models' lifecycles — the pre-filter model can be updated independently from the document retrieval embedding model. The pre-filter provider runs in its own worker thread with its own thread pool. | Pre-filter design, `ClaimVerifierConfig.embeddingProvider` |
| D2 | Pre-filter and NLI models may have different embedding dimensions | The pre-filter provider is configured separately and may use a smaller/larger model than the retrieval pipeline (e.g. 384-dim for pre-filter topic gating vs 1024-dim for retrieval). The `ModelRegistration.dimensions` field tracks per-model dimensions. | Pre-filter design, Model registry |
| D3 | Claim text exceeding NLI token limit is truncated from the tail | Citations, references, and conclusions are typically at the end of a claim. Tail-truncation is the default; head-truncation is configurable per-use-case for legal/regulatory claims where the conclusion carries more signal than the preamble. | Claim normalization, Use case mapping |
| D4 | Verification cache is LRU with max 10K entries, keyed by SHA-256(claimText + sourceText + modelVersion) | LRU is simple and bounds memory. 10K is sufficient for a typical fact-checking session without excessive RAM usage. The composite key ensures cache validity across model version bumps. Cache is local to the `ClaimVerifier` instance — no cross-process sharing (avoids distributed cache complexity). | Verification cache |
| D5 | Claim normalization strips citation markers, quotation marks, and extra whitespace before NLI — but preserves punctuation for sentence boundary detection | Citation markers (`[1]`, `(p. 14)`) are not semantic content and would pollute NLI token embeddings. Punctuation (periods, commas, semicolons) is preserved so the NLI tokenizer can detect sentence boundaries for proper attention distribution. | Claim normalization |
| D6 | Language mismatch between claim and source downgrades result to `neutral` with a warning flag, not an error | Some cross-encoders handle limited code-switching (e.g. English claim + French source in legal bilingual contexts). Hard-erroring would block these valid use cases. Downgrading to `neutral` with `languageMismatch: true` surfaces the ambiguity while allowing the pipeline to continue. | `SingleSourceResult`, NLI worker protocol |
| D7 | `verifyStream` guarantees order within each batch (in-order completion) but not across batches — stream is ordered by input index | In-order completion within a batch simplifies the caller's merging logic (no need to re-sort results). Across batches, the stream yields whichever batch completes first. The caller tracks input index via `ClaimSourcePair` ordering. | `ClaimVerifier.verifyStream` |
| D8 | NLI worker thread timeout is 30s per claim-source pair | ONNX NLI inference with `deberta-large` on CPU can take 5–15s per pair for long texts. 30s accounts for 2x the worst case before recycling the worker. Beyond 30s, the worker is terminated and replaced; the result is marked `unverifiable`. | Worker thread protocol, Error taxonomy |
