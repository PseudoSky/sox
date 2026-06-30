import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DefaultClaimNormalizer,
  LRUVerificationCache,
  InMemoryModelRegistry,
  InvalidClaimInputError,
  ModelNotLoadedError,
} from './index.js';

describe('DefaultClaimNormalizer', () => {
  const normalizer = new DefaultClaimNormalizer();

  it('strips citation markers', () => {
    expect(normalizer.normalizeClaim('This is a test [1].')).toBe('This is a test.');
    expect(normalizer.normalizeClaim('Multiple [1, 2, 3] citations')).toBe('Multiple citations');
  });

  it('normalizes whitespace', () => {
    expect(normalizer.normalizeClaim('  hello   world  ')).toBe('hello world');
  });

  it('removes quotation marks', () => {
    expect(normalizer.normalizeClaim('He said "hello"')).toBe('He said hello');
    expect(normalizer.normalizeClaim('\u201Ccurly\u201D quotes')).toBe('curly quotes');
  });

  it('preserves punctuation for sentence boundary detection', () => {
    const result = normalizer.normalizeClaim('First sentence. Second sentence? Yes!');
    expect(result).toContain('.');
    expect(result).toContain('?');
    expect(result).toContain('!');
  });

  it('normalizeSource preserves source markers', () => {
    const result = normalizer.normalizeSource('Section 1: Introduction');
    expect(result).toBe('Section 1: Introduction');
  });
});

describe('LRUVerificationCache', () => {
  it('stores and retrieves entries', async () => {
    const cache = new LRUVerificationCache(3);
    await cache.set('key1', { sourceId: 's1', entailment: 'entails', confidence: 0.9, preFilterSkipped: false, timingMs: 10 });
    const result = await cache.get('key1');
    expect(result?.entailment).toBe('entails');
  });

  it('evicts LRU entries when maxSize exceeded', async () => {
    const cache = new LRUVerificationCache(2);
    await cache.set('k1', { sourceId: 's1', entailment: 'entails', confidence: 0.9, preFilterSkipped: false, timingMs: 1 });
    await cache.set('k2', { sourceId: 's2', entailment: 'neutral', confidence: 0.5, preFilterSkipped: false, timingMs: 1 });
    await cache.get('k1');
    await cache.set('k3', { sourceId: 's3', entailment: 'contradicts', confidence: 0.8, preFilterSkipped: false, timingMs: 1 });
    const evicted = await cache.get('k2');
    expect(evicted).toBeUndefined();
  });

  it('clear removes all entries', async () => {
    const cache = new LRUVerificationCache(10);
    await cache.set('k1', { sourceId: 's1', entailment: 'entails', confidence: 0.9, preFilterSkipped: false, timingMs: 1 });
    await cache.clear();
    expect(await cache.get('k1')).toBeUndefined();
  });
});

describe('InMemoryModelRegistry', () => {
  it('register, get, list lifecycle', async () => {
    const reg = new InMemoryModelRegistry();
    await reg.register({ modelId: 'test-model', version: '1.0', nliModel: true, loadedAt: new Date().toISOString() });
    const retrieved = await reg.get('test-model');
    expect(retrieved?.version).toBe('1.0');
    expect(await reg.isLoaded('test-model')).toBe(true);
    const list = await reg.list();
    expect(list).toHaveLength(1);
    await reg.deregister('test-model');
    expect(await reg.isLoaded('test-model')).toBe(false);
  });
});

describe('createClaimVerifier integration', () => {
  it('throws when modelId is missing', async () => {
    const { createClaimVerifier } = await import('./index.js');
    await expect(
      createClaimVerifier({ modelId: '', modelVersion: '1.0' }),
    ).rejects.toThrow();
  });
});
