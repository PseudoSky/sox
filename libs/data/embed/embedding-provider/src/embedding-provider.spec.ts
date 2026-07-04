import { describe, it, expect } from 'vitest';
import {
  createEmbeddingProvider,
  ResolutionError,
} from './index.js';

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

  describe('health() — CONTRACTS §E', () => {
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
