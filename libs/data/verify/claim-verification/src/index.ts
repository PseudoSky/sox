import { randomUUID } from 'node:crypto';

import type {
  Claim,
  SourceRef,
  ClaimSourcePair,
  SingleSourceResult,
  VerificationResult,
  VerifierHealth,
  ModelRegistration,
  ModelRegistry,
  ClaimVerifier,
  ClaimVerifierConfig,
} from './types.js';

import { ModelNotLoadedError, InvalidClaimInputError } from './errors.js';

import { type ClaimNormalizer, DefaultClaimNormalizer } from './normalizer.js';
import { LRUVerificationCache, cacheKey as makeCacheKey } from './cache.js';
import { cosineSimilarity } from './prefilter.js';
import { WorkerProxy } from './worker.js';

// ── Re-exports ───────────────────────────────────────────────────────────────

export type {
  Claim,
  SourceRef,
  ClaimSourcePair,
  EntailmentLabel,
  SingleSourceResult,
  VerificationResult,
  VerifierHealth,
  WorkerStatus,
  ModelRegistration,
  ModelRegistry,
  ClaimVerifier,
  ClaimVerifierConfig,
} from './types.js';

export type { ClaimNormalizer } from './normalizer.js';
export type { VerificationCache } from './cache.js';

export {
  ModelNotLoadedError,
  VerifierBusyError,
  UnsupportedLanguageError,
  PreFilterSkippedError,
  InvalidClaimInputError,
} from './errors.js';

export { DefaultClaimNormalizer } from './normalizer.js';
export { LRUVerificationCache } from './cache.js';

// ── InMemoryModelRegistry ────────────────────────────────────────────────────

export class InMemoryModelRegistry implements ModelRegistry {
  private models = new Map<string, ModelRegistration>();

  async register(model: ModelRegistration): Promise<void> {
    this.models.set(model.modelId, model);
  }

  async deregister(modelId: string): Promise<void> {
    this.models.delete(modelId);
  }

  async get(modelId: string): Promise<ModelRegistration | undefined> {
    return this.models.get(modelId);
  }

  async list(): Promise<ModelRegistration[]> {
    return [...this.models.values()];
  }

  async isLoaded(modelId: string): Promise<boolean> {
    return this.models.has(modelId);
  }
}

// ── ClaimVerifierImpl ────────────────────────────────────────────────────────

class ClaimVerifierImpl implements ClaimVerifier {
  readonly modelId: string;
  readonly modelVersion: string;
  private config: ClaimVerifierConfig;
  private workers: WorkerProxy[] = [];
  private normalizer: ClaimNormalizer;
  private modelRegistry: InMemoryModelRegistry;
  private cache: LRUVerificationCache;
  private _isReady = false;
  private _isWarmingUp = false;
  private _startedAt = Date.now();
  private _lastError?: string;

  constructor(config: ClaimVerifierConfig) {
    this.modelId = config.modelId;
    this.modelVersion = config.modelVersion;
    this.config = config;
    this.normalizer = new DefaultClaimNormalizer();
    this.modelRegistry = new InMemoryModelRegistry();
    this.cache = new LRUVerificationCache(
      config.cache?.maxSize ?? 10000,
      config.cache?.ttlMs,
    );
  }

  get isReady(): boolean {
    return this._isReady;
  }

  async warmUp(): Promise<void> {
    if (this._isReady) return;
    this._isWarmingUp = true;
    const workerCount = this.config.workerCount ?? 1;

    try {
      for (let i = 0; i < workerCount; i++) {
        const wp = new WorkerProxy(i);
        await wp.start({ modelId: this.modelId, modelVersion: this.modelVersion });
        this.workers.push(wp);
      }

      await this.modelRegistry.register({
        modelId: this.modelId,
        version: this.modelVersion,
        displayName: this.modelId,
        providerUri: 'local:onnx',
        nliModel: true,
        loadedAt: new Date().toISOString(),
      });

      this._isReady = true;
      this._isWarmingUp = false;
      console.info(`[claim-verifier] warmUp complete: model=${this.modelId} v=${this.modelVersion} workers=${workerCount}`);
    } catch (err) {
      this._isWarmingUp = false;
      this._lastError = String(err);
      console.error('[claim-verifier] warmUp failed:', err);
      throw new ModelNotLoadedError(
        `Failed to load model ${this.modelId}: ${String(err)}`,
        this.modelId,
      );
    }
  }

  async verify(
    claim: Claim,
    source: SourceRef,
    opts?: { preFilterThreshold?: number },
  ): Promise<VerificationResult> {
    if (!this._isReady) throw new ModelNotLoadedError('ClaimVerifier not warmed up', this.modelId);

    const start = Date.now();
    const normalizer = this.normalizer;
    const claimText = normalizer.normalizeClaim(claim.text);
    const sourceText = normalizer.normalizeSource(source.text);

    if (!claimText || !sourceText) {
      throw new InvalidClaimInputError('Claim and source must have non-empty text');
    }

    const cKey = makeCacheKey(claimText, sourceText, this.modelVersion);
    const cached = await this.cache.get(cKey);
    if (cached) {
      console.debug(`[claim-verifier] cache hit for ${claim.id} -> ${source.id}`);
      return {
        claimId: claim.id,
        sourceResults: [cached],
        aggregateConfidence: cached.entailment === 'contradicts'
          ? Math.min(cached.confidence, 1)
          : cached.entailment === 'entails'
            ? cached.confidence
            : 0,
        modelId: this.modelId,
        modelVersion: this.modelVersion,
        totalTimingMs: 0,
      };
    }

    const preFilterThreshold = opts?.preFilterThreshold ?? this.config.defaultPreFilterThreshold;
    let preFilterScore: number | undefined;

    if (preFilterThreshold && preFilterThreshold > 0 && this.config.embeddingProvider) {
      try {
        const claimEmb = await this.config.embeddingProvider.embedSingle(claimText);
        const sourceEmb = await this.config.embeddingProvider.embedSingle(sourceText);
        preFilterScore = cosineSimilarity(claimEmb, sourceEmb);

        if (preFilterScore < preFilterThreshold) {
          const result: SingleSourceResult = {
            sourceId: source.id,
            entailment: 'unverifiable',
            confidence: 0,
            preFilterSkipped: true,
            preFilterScore,
            timingMs: Date.now() - start,
          };
          return {
            claimId: claim.id,
            sourceResults: [result],
            aggregateConfidence: 0,
            modelId: this.modelId,
            modelVersion: this.modelVersion,
            totalTimingMs: Date.now() - start,
          };
        }
      } catch (err) {
        console.warn('[claim-verifier] pre-filter failed, falling through to NLI:', err);
      }
    }

    const languageMismatch = !!(claim.language && source.language && claim.language !== source.language);
    if (languageMismatch) {
      console.warn(
        `[claim-verifier] language mismatch: claim=${claim.language} source=${source.language} — downgrading to neutral`,
      );
    }

    const worker = this.selectWorker();
    const jobId = randomUUID();
    const response = await worker.send({
      type: 'verify',
      jobId,
      claimText,
      sourceText,
      ...(claim.language ? { claimLang: claim.language } : {}),
      ...(source.language ? { sourceLang: source.language } : {}),
      ...(preFilterThreshold !== undefined ? { preFilterThreshold } : {}),
    });

    let singleResult: SingleSourceResult;

    if (response.type === 'result') {
      let entailment = response.entailment;
      let confidence = response.confidence;

      if (languageMismatch) {
        entailment = 'neutral';
      }

      const minConfidence = this.config.minConfidenceThreshold ?? 0.5;
      if ((entailment === 'entails' || entailment === 'contradicts') && confidence < minConfidence) {
        entailment = 'neutral';
      }

      const resolvedPreFilterScore = response.preFilterScore ?? preFilterScore;
      singleResult = {
        sourceId: source.id,
        entailment,
        confidence,
        preFilterSkipped: response.preFilterSkipped,
        ...(resolvedPreFilterScore !== undefined ? { preFilterScore: resolvedPreFilterScore } : {}),
        languageMismatch,
        timingMs: response.timingMs,
      };
    } else if (response.type === 'error') {
      singleResult = {
        sourceId: source.id,
        entailment: 'unverifiable',
        confidence: 0,
        preFilterSkipped: false,
        timingMs: Date.now() - start,
      };
    } else {
      singleResult = {
        sourceId: source.id,
        entailment: 'unverifiable',
        confidence: 0,
        preFilterSkipped: false,
        timingMs: Date.now() - start,
      };
    }

    await this.cache.set(cKey, singleResult);

    const totalTimingMs = Date.now() - start;
    const aggregateConfidence = singleResult.entailment === 'contradicts'
      ? Math.min(singleResult.confidence, 1)
      : singleResult.entailment === 'entails'
        ? singleResult.confidence
        : 0;

    return {
      claimId: claim.id,
      sourceResults: [singleResult],
      aggregateConfidence,
      modelId: this.modelId,
      modelVersion: this.modelVersion,
      totalTimingMs,
    };
  }

  async verifyBatch(
    pairs: ClaimSourcePair[],
    opts?: { preFilterThreshold?: number },
  ): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];
    for (const pair of pairs) {
      const sourceResults: SingleSourceResult[] = [];
      let minConfidence = 1;
      let totalTimingMs = 0;

      for (const source of pair.sources) {
        const result = await this.verify(pair.claim, source, opts);
        sourceResults.push(...result.sourceResults);
        totalTimingMs += result.totalTimingMs;
        for (const sr of result.sourceResults) {
          if (sr.confidence < minConfidence) minConfidence = sr.confidence;
        }
      }

      results.push({
        claimId: pair.claim.id,
        sourceResults,
        aggregateConfidence: minConfidence,
        modelId: this.modelId,
        modelVersion: this.modelVersion,
        totalTimingMs,
      });
    }
    return results;
  }

  async *verifyStream(
    pairs: AsyncIterable<ClaimSourcePair>,
    opts?: { preFilterThreshold?: number },
  ): AsyncIterable<VerificationResult> {
    for await (const pair of pairs) {
      yield await this.verifyBatch([pair], opts).then((r) => r[0]!);
    }
  }

  async healthCheck(): Promise<VerifierHealth> {
    return {
      isReady: this._isReady,
      isWarmingUp: this._isWarmingUp,
      modelId: this.modelId,
      modelVersion: this.modelVersion,
      queuedJobs: this.workers.reduce((sum, w) => sum + w.queuedJobs, 0),
      activeJobs: this.workers.filter((w) => w.isBusy).length,
      workerStatus: this.workers.map((w) => ({
        workerId: w.workerId,
        isBusy: w.isBusy,
        queuedJobs: w.queuedJobs,
        lastActivityMs: w.lastActivityMs,
      })),
      ...(this._lastError !== undefined ? { lastError: this._lastError } : {}),
      uptimeMs: Date.now() - this._startedAt,
    };
  }

  async shutdown(): Promise<void> {
    for (const wp of this.workers) {
      await wp.shutdown();
    }
    this.workers = [];
    this._isReady = false;
    console.info('[claim-verifier] shutdown complete');
  }

  private selectWorker(): WorkerProxy {
    const available = this.workers.filter((w) => !w.isBusy);
    if (available.length > 0) return available[0]!;
    return this.workers[Math.floor(Math.random() * this.workers.length)]!;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export async function createClaimVerifier(
  config: ClaimVerifierConfig,
): Promise<ClaimVerifier> {
  if (!config.modelId || !config.modelVersion) {
    throw new InvalidClaimInputError('modelId and modelVersion are required');
  }
  const verifier = new ClaimVerifierImpl(config);
  await verifier.warmUp();
  return verifier;
}
