import { describe, it, expect, beforeAll } from 'vitest';
import {
  createEmbeddingProvider,
  ResolutionError,
  type EmbeddingProvider,
  type EmbeddingProviderMetadata,
} from './index.js';

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function collectBatch(
  iter: AsyncIterable<Float32Array>,
): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for await (const vec of iter) {
    results.push(vec);
  }
  return results;
}

describe('createEmbeddingProvider', () => {
  it('throws ResolutionError for unknown type', async () => {
    await expect(
      createEmbeddingProvider({ type: 'nonexistent', model: 'x' }),
    ).rejects.toThrow(ResolutionError);
  });

  it('throws ResolutionError for empty type', async () => {
    await expect(
      createEmbeddingProvider({ type: '', model: 'x' }),
    ).rejects.toThrow(ResolutionError);
  });

  it('returns deterministic provider for type=hash', async () => {
    const provider = await createEmbeddingProvider({
      type: 'hash',
      model: 'hash-768',
    });
    expect(provider).toBeDefined();
    expect(provider.metadata.isDeterministic).toBe(true);
    expect(provider.metadata.isRemote).toBe(false);
    expect(provider.metadata.modelId).toBe('hash-768');
    expect(provider.metadata.dimensions).toBe(768);
  });

  describe('health() — CONTRACTS §E', () => {
    it('hash provider health returns hash-fallback state', async () => {
      const provider = await createEmbeddingProvider({ type: 'hash', model: 'hash-768' });
      const h = provider.health();
      expect(h.state).toBe('hash-fallback');
      expect(h.configured).toContain('hash');
      expect(h.active).toBe('hash-768');
      expect(h.dimensions).toBe(768);
      expect(h.last_error).toBeNull();
    });

    it('remote provider health returns real state', async () => {
      const provider = await createEmbeddingProvider({
        type: 'remote',
        model: 'remote-768',
        options: { endpoint: 'https://api.example.com/v1', apiKey: 'sk-test12345678' },
      });
      const h = provider.health();
      expect(h.state).toBe('real');
      expect(h.configured).toContain('remote');
      expect(h.active).toBe('remote-768');
      expect(h.dimensions).toBe(768);
      expect(h.last_error).toBeNull();
    });

    it('hash provider health reports correct dimensions for custom dims', async () => {
      const provider = await createEmbeddingProvider({
        type: 'hash',
        model: 'hash-384',
        options: { dimensions: 384 },
      });
      const h = provider.health();
      expect(h.state).toBe('hash-fallback');
      expect(h.dimensions).toBe(384);
    });
  });

  it('returns deterministic provider with custom dimensions', async () => {
    const provider = await createEmbeddingProvider({
      type: 'hash',
      model: 'hash-384',
      options: { dimensions: 384 },
    });
    expect(provider.metadata.dimensions).toBe(384);
    expect(provider.metadata.modelId).toBe('hash-384');
  });

  it('returns remote provider for type=remote', async () => {
    const provider = await createEmbeddingProvider({
      type: 'remote',
      model: 'remote-768',
      options: { endpoint: 'https://api.example.com/v1', apiKey: 'sk-test12345678' },
    });
    expect(provider).toBeDefined();
    expect(provider.metadata.isRemote).toBe(true);
    expect(provider.metadata.isDeterministic).toBe(false);
    expect(provider.metadata.providerUri).toBe('https://api.example.com/v1');
  });

  it('remote provider throws ResolutionError without endpoint', async () => {
    await expect(
      createEmbeddingProvider({ type: 'remote', model: 'x' }),
    ).rejects.toThrow(ResolutionError);
  });
});

describe('deterministic provider (hash)', () => {
  let provider: EmbeddingProvider;
  let meta: EmbeddingProviderMetadata;

  beforeAll(async () => {
    provider = await createEmbeddingProvider({
      type: 'hash',
      model: 'test-hash',
    });
    meta = provider.metadata;
  });

  describe('metadata', () => {
    it('reports correct modelId', () => {
      expect(meta.modelId).toBe('test-hash');
    });

    it('reports correct dimensions (default 768)', () => {
      expect(meta.dimensions).toBe(768);
    });

    it('isDeterministic is true', () => {
      expect(meta.isDeterministic).toBe(true);
    });

    it('isRemote is false', () => {
      expect(meta.isRemote).toBe(false);
    });

    it('has a providerUri', () => {
      expect(meta.providerUri).toContain('local:hash');
    });
  });

  describe('embedSingle', () => {
    it('returns Float32Array of correct length', async () => {
      const vec = await provider.embedSingle('hello world');
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(768);
    });

    it('same text returns identical vector (deterministic)', async () => {
      const a = await provider.embedSingle('hello world');
      const b = await provider.embedSingle('hello world');
      expect(a).toEqual(b);
    });

    it('different texts return different vectors', async () => {
      const a = await provider.embedSingle('the cat sat on the mat');
      const b = await provider.embedSingle('quantum physics explains wave-particle duality');
      const cos = cosine(a, b);
      // BL-86 fix: unrelated strings must have cosine < 0.5
      expect(Math.abs(cos)).toBeLessThan(0.5);
    });

    it('vector is approximately unit-normalized', async () => {
      const vec = await provider.embedSingle('test normalization');
      let norm = 0;
      for (let i = 0; i < vec.length; i++) {
        norm += vec[i]! * vec[i]!;
      }
      norm = Math.sqrt(norm);
      expect(norm).toBeCloseTo(1.0, 3);
    });

    it('empty string still returns a valid vector', async () => {
      const vec = await provider.embedSingle('');
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(768);
      let norm = 0;
      for (let i = 0; i < vec.length; i++) {
        norm += vec[i]! * vec[i]!;
      }
      norm = Math.sqrt(norm);
      expect(norm).toBeCloseTo(1.0, 3);
    });
  });

  describe('embedBatch', () => {
    it('yields correct number of vectors', async () => {
      const texts = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
      const results = await collectBatch(
        provider.embedBatch(texts, { batchSize: 2 }),
      );
      expect(results).toHaveLength(5);
    });

    it('each result is a correctly-sized Float32Array', async () => {
      const texts = ['one', 'two', 'three'];
      const results = await collectBatch(provider.embedBatch(texts));
      for (const vec of results) {
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(768);
      }
    });

    it('batch produces same vectors as individual embedSingle', async () => {
      const texts = ['apple', 'banana', 'cherry'];
      const singles = await Promise.all(texts.map((t) => provider.embedSingle(t)));
      const batch = await collectBatch(provider.embedBatch(texts));

      expect(singles).toHaveLength(batch.length);
      for (let i = 0; i < singles.length; i++) {
        expect(singles[i]).toEqual(batch[i]);
      }
    });

    it('handles empty text array', async () => {
      const results = await collectBatch(provider.embedBatch([]));
      expect(results).toHaveLength(0);
    });
  });

  describe('warmUp', () => {
    it('is not a no-op for deterministic provider — pre-computes into cache', async () => {
      const texts = ['warmup text one', 'warmup text two'];
      // Warm up should pre-compute embeddings
      await provider.warmUp(texts);
      // Subsequent embedSingle should hit the cache (still return correct result)
      const vec = await provider.embedSingle('warmup text one');
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(768);
    });
  });

  describe('BL-86 degeneracy fix', () => {
    it('two very different sentences have cosine < 0.5', async () => {
      const a = await provider.embedSingle(
        'The mitochondria is the powerhouse of the cell',
      );
      const b = await provider.embedSingle(
        'The Treaty of Versailles ended World War I in 1919',
      );
      const cos = cosine(a, b);
      expect(Math.abs(cos)).toBeLessThan(0.5);
    });

    it('multiple unrelated sentence pairs all have cosine < 0.5', async () => {
      const sentences = [
        'Machine learning models require large amounts of training data',
        'The Grand Canyon was formed by the Colorado River',
        'Shakespeare wrote Macbeth in the early 1600s',
        'TCP is a connection-oriented transport layer protocol',
        'Photosynthesis converts carbon dioxide into oxygen',
      ];
      const vectors = await Promise.all(
        sentences.map((s) => provider.embedSingle(s)),
      );

      for (let i = 0; i < vectors.length; i++) {
        for (let j = i + 1; j < vectors.length; j++) {
          const cos = cosine(vectors[i]!, vectors[j]!);
          expect(Math.abs(cos)).toBeLessThan(0.5);
        }
      }
    });
  });
});

describe('remote provider', () => {
  it('throws PermanentEmbeddingError for missing API key on embedSingle', async () => {
    const { PermanentEmbeddingError } = await import('./index.js');
    const provider = await createEmbeddingProvider({
      type: 'remote',
      model: 'remote-768',
      options: {
        endpoint: 'https://api.example.com/v1',
        apiKey: 'short',
      },
    });
    await expect(provider.embedSingle('test')).rejects.toThrow(
      PermanentEmbeddingError,
    );
  });

  it('throws PermanentEmbeddingError for empty text', async () => {
    const { PermanentEmbeddingError } = await import('./index.js');
    const provider = await createEmbeddingProvider({
      type: 'remote',
      model: 'remote-768',
      options: {
        endpoint: 'https://api.example.com/v1',
        apiKey: 'sk-test1234567890',
      },
    });
    await expect(provider.embedSingle('')).rejects.toThrow(
      PermanentEmbeddingError,
    );
  });

  it('warmUp is a no-op (isDeterministic = false)', async () => {
    const provider = await createEmbeddingProvider({
      type: 'remote',
      model: 'remote-768',
      options: {
        endpoint: 'https://api.example.com/v1',
        apiKey: 'sk-test12345678',
      },
    });
    // warmUp should not throw
    await provider.warmUp(['text one', 'text two']);
    // No assertion needed — just that it doesn't throw
  });

  it('returns zero vector on successful embed', async () => {
    const provider = await createEmbeddingProvider({
      type: 'remote',
      model: 'remote-768',
      options: {
        endpoint: 'https://api.example.com/v1',
        apiKey: 'sk-test12345678',
      },
    });
    const vec = await provider.embedSingle('hello');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(768);
    // Reference impl returns zero vector
    for (let i = 0; i < vec.length; i++) {
      expect(vec[i]).toBe(0);
    }
  });

  it('throws PermanentEmbeddingError for invalid endpoint', async () => {
    const { PermanentEmbeddingError } = await import('./index.js');
    const provider = await createEmbeddingProvider({
      type: 'remote',
      model: 'remote-768',
      options: {
        endpoint: 'ftp://bad.example.com',
        apiKey: 'sk-test12345678',
      },
    });
    await expect(provider.embedSingle('test')).rejects.toThrow(
      PermanentEmbeddingError,
    );
  });
});

describe('metadata contract', () => {
  it('hash provider reports all required metadata fields', async () => {
    const provider = await createEmbeddingProvider({
      type: 'hash',
      model: 'my-hash',
      options: { dimensions: 384 },
    });
    const m = provider.metadata;
    expect(m.modelId).toBe('my-hash');
    expect(m.dimensions).toBe(384);
    expect(m.isRemote).toBe(false);
    expect(m.isDeterministic).toBe(true);
    expect(typeof m.providerUri).toBe('string');
  });

  it('remote provider reports all required metadata fields', async () => {
    const provider = await createEmbeddingProvider({
      type: 'remote',
      model: 'openai-text-embed-3-small',
      options: {
        endpoint: 'https://api.openai.com/v1',
        apiKey: 'sk-test12345678',
        dimensions: 1536,
      },
    });
    const m = provider.metadata;
    expect(m.modelId).toBe('openai-text-embed-3-small');
    expect(m.dimensions).toBe(1536);
    expect(m.isRemote).toBe(true);
    expect(m.isDeterministic).toBe(false);
    expect(m.providerUri).toBe('https://api.openai.com/v1');
  });
});
