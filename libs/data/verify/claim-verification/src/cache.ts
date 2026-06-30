import { createHash } from 'node:crypto';
import type { SingleSourceResult } from './types.js';

export interface VerificationCache {
  get(key: string): Promise<SingleSourceResult | undefined>;
  set(key: string, result: SingleSourceResult): Promise<void>;
  clear(): Promise<void>;
}

interface CacheEntry {
  result: SingleSourceResult;
  insertedAt: number;
}

export class LRUVerificationCache implements VerificationCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number | undefined;

  constructor(maxSize: number = 10000, ttlMs?: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  async get(key: string): Promise<SingleSourceResult | undefined> {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (this.ttlMs !== undefined && Date.now() - entry.insertedAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // LRU promotion: re-insert to move to end
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.result;
  }

  async set(key: string, result: SingleSourceResult): Promise<void> {
    if (this.cache.size >= this.maxSize) {
      const first = this.cache.keys().next();
      if (first.value) this.cache.delete(first.value);
    }
    this.cache.set(key, { result, insertedAt: Date.now() });
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Build a cache key from claim text, source text, and model version.
 * SHA-256(claimText + sourceText + modelVersion)
 */
export function cacheKey(claimText: string, sourceText: string, modelVersion: string): string {
  return createHash('sha256')
    .update(claimText + sourceText + modelVersion)
    .digest('hex');
}
