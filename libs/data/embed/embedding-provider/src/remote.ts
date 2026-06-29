import type { EmbeddingProvider, EmbeddingProviderMetadata, EmbedRole } from './index.js';
import { PermanentEmbeddingError, TransientEmbeddingError } from './index.js';

/**
 * Remote provider adapter — typed reference implementation.
 *
 * Implements EmbeddingProvider against the same async+batch-first contract.
 * NOT wired to a live/paid endpoint — proves context-agnosticism without spend.
 */
export class RemoteProvider implements EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;
  private endpoint: string;
  private apiKey: string | undefined;

  constructor(modelId: string, dimensions: number, endpoint: string, apiKey?: string) {
    this.metadata = {
      modelId,
      dimensions,
      isRemote: true,
      isDeterministic: false,
      providerUri: endpoint,
    };
    this.endpoint = endpoint;
    this.apiKey = apiKey;
  }

  async embedSingle(text: string, role?: EmbedRole): Promise<Float32Array> {
    void role;
    this.validateEndpoint();
    try {
      const vec = await this.simulatedRemoteEmbed(text);
      return vec;
    } catch (err) {
      if (err instanceof TransientEmbeddingError || err instanceof PermanentEmbeddingError) {
        throw err;
      }
      throw new TransientEmbeddingError(
        `Remote embed failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async *embedBatch(
    texts: string[],
    opts?: { role?: EmbedRole; batchSize?: number },
  ): AsyncIterable<Float32Array> {
    void opts;
    this.validateEndpoint();
    const batchSize = opts?.batchSize ?? 256;
    for (let i = 0; i < texts.length; i += batchSize) {
      const chunk = texts.slice(i, i + batchSize);
      for (const text of chunk) {
        try {
          yield await this.simulatedRemoteEmbed(text);
        } catch (err) {
          if (err instanceof TransientEmbeddingError || err instanceof PermanentEmbeddingError) {
            throw err;
          }
          throw new TransientEmbeddingError(
            `Remote batch embed failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  async warmUp(_texts: string[]): Promise<void> {
    // No-op: isDeterministic is false, cache would be unreliable.
  }

  private validateEndpoint(): void {
    if (!this.endpoint.startsWith('https://') && !this.endpoint.startsWith('http://')) {
      throw new PermanentEmbeddingError(
        `Invalid remote endpoint: ${this.endpoint} (must start with http:// or https://)`,
      );
    }
    if (!this.apiKey) {
      throw new PermanentEmbeddingError(
        `Remote provider requires an API key (endpoint: ${this.endpoint})`,
      );
    }
  }

  private async simulatedRemoteEmbed(text: string): Promise<Float32Array> {
    if (!this.apiKey || this.apiKey.length < 8) {
      throw new PermanentEmbeddingError('Invalid API key: too short');
    }

    if (text.length === 0) {
      throw new PermanentEmbeddingError('Cannot embed empty text');
    }

    if (text.length > 8192) {
      throw new PermanentEmbeddingError('Text exceeds maximum token length');
    }

    // Simulate: return a zero vector (reference impl, not wired to real endpoint)
    return new Float32Array(this.metadata.dimensions);
  }
}
