// ── Supporting types ─────────────────────────────────────────────────────────

export interface Claim {
  id: string;
  text: string;
  language?: string;
  context?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceRef {
  id: string;
  text: string;
  language?: string;
  title?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface ClaimSourcePair {
  claim: Claim;
  sources: SourceRef[];
}

export type EntailmentLabel = 'entails' | 'contradicts' | 'neutral' | 'unverifiable';

export interface SingleSourceResult {
  sourceId: string;
  entailment: EntailmentLabel;
  confidence: number;
  preFilterSkipped: boolean;
  preFilterScore?: number;
  languageMismatch?: boolean;
  timingMs: number;
}

export interface VerificationResult {
  claimId: string;
  sourceResults: SingleSourceResult[];
  aggregateConfidence: number;
  modelId: string;
  modelVersion: string;
  totalTimingMs: number;
  metadata?: Record<string, unknown>;
}

export interface VerifierHealth {
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

export interface WorkerStatus {
  workerId: number;
  isBusy: boolean;
  queuedJobs: number;
  lastActivityMs: number;
}

export interface ModelRegistration {
  modelId: string;
  version: string;
  displayName?: string;
  providerUri?: string;
  nliModel: boolean;
  dimensions?: number;
  loadedAt: string;
}

export interface ModelRegistry {
  register(model: ModelRegistration): Promise<void>;
  deregister(modelId: string): Promise<void>;
  get(modelId: string): Promise<ModelRegistration | undefined>;
  list(): Promise<ModelRegistration[]>;
  isLoaded(modelId: string): Promise<boolean>;
}

export interface ClaimVerifierConfig {
  modelId: string;
  modelVersion: string;
  defaultPreFilterThreshold?: number;
  minConfidenceThreshold?: number;
  workerCount?: number;
  maxQueueDepth?: number;
  embeddingProvider?: import('@adhd/sox-embedding-provider').EmbeddingProvider;
  cache?: {
    maxSize?: number;
    ttlMs?: number;
  };
}

export interface ClaimVerifier {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly isReady: boolean;

  verify(
    claim: Claim,
    source: SourceRef,
    opts?: { preFilterThreshold?: number },
  ): Promise<VerificationResult>;

  verifyBatch(
    pairs: ClaimSourcePair[],
    opts?: { preFilterThreshold?: number },
  ): Promise<VerificationResult[]>;

  verifyStream(
    pairs: AsyncIterable<ClaimSourcePair>,
    opts?: { preFilterThreshold?: number },
  ): AsyncIterable<VerificationResult>;

  warmUp(): Promise<void>;
  healthCheck(): Promise<VerifierHealth>;
  shutdown(): Promise<void>;
}
