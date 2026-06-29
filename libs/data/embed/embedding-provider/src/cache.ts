export class EmbeddingCache {
  private cache = new Map<string, Float32Array>();
  private maxSize: number;

  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  get(text: string): Float32Array | undefined {
    const vec = this.cache.get(text);
    if (vec !== undefined) {
      this.cache.delete(text);
      this.cache.set(text, vec);
    }
    return vec;
  }

  set(text: string, vec: Float32Array): void {
    if (this.cache.has(text)) {
      this.cache.delete(text);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(text, vec);
  }

  has(text: string): boolean {
    return this.cache.has(text);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
