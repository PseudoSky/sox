/**
 * Core chunker types: SourceMap, Chunk, Chunker interface, options, and
 * supporting types for the chunking infrastructure.
 *
 * Every chunk MUST carry a SourceMap — zero chunks without provenance.
 *
 * @module
 */

// ── Source-map ─────────────────────────────────────────────────────────────────

/** Every chunk carries provenance information via a SourceMap. */
export interface SourceMap {
  /** 0-based, inclusive start line in the original document. */
  sourceStartLine: number;
  /** 0-based, inclusive end line in the original document. */
  sourceEndLine: number;
  /** URL or file path of the source document; absent for ephemeral text. */
  sourceUrl?: string;
  /** SHA-256 of the source document at the time of chunking. */
  sourceSha?: string;
}

// ── Chunk shape ────────────────────────────────────────────────────────────────

/** A single retrievable unit produced by a chunker. */
export interface Chunk {
  /** Chunk content — the retrievable unit. */
  text: string;
  /** Provenance information for this chunk. */
  sourceMap: SourceMap;
  /** Structured metadata about the chunk's origin and position. */
  metadata: {
    /** Which chunker produced this — e.g. 'ast:treesitter:ts'. */
    chunkerId: string;
    /** Language identifier — 'typescript' | 'python' | 'markdown' | etc. */
    language?: string;
    /** Heading path for heading-aware chunkers, e.g. "Installation > Prerequisites". */
    heading?: string;
    /** Document-level grouping key. */
    parentDocId?: string;
    /** Position within the document (0-based). */
    chunkIndex: number;
    /** True for the first heading of a document (heading-aware chunkers only). */
    isHeadingRoot?: boolean;
  };
  /** Embedding vector; empty at chunking time, populated after vectorization. */
  embedding?: Float32Array;
}

// ── Chunker interface ──────────────────────────────────────────────────────────

/** Options accepted by every chunker. */
export interface ChunkerOptions {
  sourceUrl?: string;
  sourceSha?: string;
  parentDocId?: string;

  /** AST chunker: minimum function body lines to produce a standalone chunk.
   *  Functions shorter than this are merged into the preceding chunk. Default: 3. */
  minFunctionLines?: number;

  /** Heading chunker: minimum heading depth to split on.
   *  depth 1 = split on h1 only; depth 2 = h1 + h2; etc. Default: 6 (all headings). */
  maxHeadingDepth?: number;
}

/** A chunker transforms a document into zero or more retrievable chunks. */
export interface Chunker {
  /** Unique identifier — e.g. 'ast:treesitter:ts'. */
  readonly id: string;
  /** Languages this chunker supports. */
  readonly supportedLanguages: string[];

  /** Chunk a single document. Returns zero or more chunks.
   *  For languages not in supportedLanguages, throws PermanentChunkingError. */
  chunk(document: string, options?: ChunkerOptions): Chunk[];

  /** Estimate the number of chunks without executing the full chunking pass.
   *  Used for progress reporting and memory pre-allocation. */
  estimate(document: string): number;
}

// ── Chunker selection strategy ─────────────────────────────────────────────────

/** Priority for ordered chunker execution on mixed-format documents.
 *  Lower order runs first. */
export interface ChunkerPriority {
  chunkerId: string;
  order: number;
}

// ── Source-map invalidation ───────────────────────────────────────────────────

export type ChunkStaleReason = 'source_updated' | 'chunker_upgraded' | 'ttl_expired';

export interface StaleChunkConfig {
  /** Chunks with sourceSha older than this threshold (in days) are re-chunked
   *  on the next ingest pass. Default: 30. */
  staleThresholdDays: number;
}
