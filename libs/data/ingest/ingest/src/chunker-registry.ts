import type {
  SourceMap,
  Chunk,
  Chunker,
  ChunkerOptions,
  ChunkerPriority,
  ChunkStaleReason,
  StaleChunkConfig,
} from './chunker.js';

export type {
  SourceMap,
  Chunk,
  Chunker,
  ChunkerOptions,
  ChunkerPriority,
  ChunkStaleReason,
  StaleChunkConfig,
};

export type ChunkerFactory = () => Chunker;

// ── Error types ────────────────────────────────────────────────────────────

export class PermanentChunkingError extends Error {
  constructor(message: string, public readonly chunkerId: string) {
    super(message);
    this.name = 'PermanentChunkingError';
  }
}

export class TransientChunkingError extends Error {
  constructor(message: string, public readonly chunkerId: string) {
    super(message);
    this.name = 'TransientChunkingError';
  }
}

// ── ChunkerRegistry ────────────────────────────────────────────────────────

export class ChunkerRegistry {
  private chunkers = new Map<string, Chunker>();
  private languageMap = new Map<string, string[]>();
  private sealed = false;

  register(id: string, factory: ChunkerFactory, languages: string[]): void {
    if (this.sealed) {
      throw new Error(`ChunkerRegistry is sealed — cannot register "${id}" at runtime`);
    }
    const chunker = factory();
    this.chunkers.set(id, chunker);
    for (const lang of languages) {
      const existing = this.languageMap.get(lang) ?? [];
      existing.push(id);
      this.languageMap.set(lang, existing);
    }
  }

  /** Seal the registry — prevents further registrations. */
  seal(): void {
    this.sealed = true;
  }

  get(id: string): Chunker | undefined {
    return this.chunkers.get(id);
  }

  getForLanguage(language: string): Chunker[] {
    const ids = this.languageMap.get(language) ?? [];
    return ids.map((id) => this.chunkers.get(id)).filter((c): c is Chunker => c !== undefined);
  }

  list(): string[] {
    return [...this.chunkers.keys()];
  }
}

// ── Global registry ─────────────────────────────────────────────────────────

export const globalChunkerRegistry = new ChunkerRegistry();
