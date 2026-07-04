import { createHash } from 'node:crypto';

export interface IngestChunk {
  index: number;
  content: string;
  contentHash: string;
  charOffset: number;
}

export interface IngestResult {
  contentHash: string;
  summary: string;
  tags: string[];
  chunks?: IngestChunk[];
}

export interface IngestOpts {
  summaryMaxSentences?: number;
  tagMaxCount?: number;
  chunk?: {
    maxChars?: number;
    overlapChars?: number;
  };
}

const DEFAULT_SUMMARY_SENTENCES = 3;
const DEFAULT_TAG_MAX_COUNT = 10;
const DEFAULT_CHUNK_MAX_CHARS = 2000;
const DEFAULT_CHUNK_OVERLAP_CHARS = 200;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'were',
  'from', 'have', 'has', 'had', 'not', 'but', 'all', 'can', 'been',
  'its', 'what', 'when', 'where', 'which', 'will', 'would', 'could',
  'should', 'then', 'than', 'just', 'also', 'into', 'more', 'some',
  'such', 'only', 'other', 'their', 'there',
  'each', 'they', 'them', 'your', 'does', 'said', 'like', 'over',
  'after', 'before', 'about',
]);

function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ');
}

/**
 * Compute a SHA-256 hex digest of `data`.
 *
 * NOTE on normalization (S11 / BL-165):
 *   This function is a raw hasher — it does NOT normalize its input.
 *   Callers that need the live-store dedup normalization (trim + toLowerCase,
 *   matching write.ts's incumbent behaviour) must pre-normalize:
 *     hexSha256(content.trim().toLowerCase())
 *   The ingest() function applies its own normalization (trim + collapse-whitespace)
 *   which differs from write.ts's normalization (no collapse-whitespace, adds toLowerCase).
 *   Both are documented in the S11 parity spec (ingest-parity.spec.ts).
 */
export function hexSha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function splitIntoSentences(text: string): string[] {
  const lines = text.split(/\n+/);
  const sentences: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/(?<=[.?!])\s+(?=[A-Z])/);
    for (const part of parts) {
      const p = part.trim();
      if (p) sentences.push(p);
    }
  }

  return sentences;
}

function extractiveSummary(content: string, maxSentences: number): string {
  if (content.length < 100) return content.trim();

  const sentences = splitIntoSentences(content);
  const selected = sentences.slice(0, maxSentences);

  const first = selected[0];
  if (first === undefined) return content.trim();

  const result = selected.join(' ').trim();
  return result.length > 0 ? result : content.trim();
}

function extractTags(content: string, maxCount: number): string[] {
  const words = content.toLowerCase().split(/[^a-z0-9]+/);
  const freq = new Map<string, number>();

  for (const w of words) {
    if (w.length <= 3) continue;
    if (STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCount)
    .map(([w]) => w);
}

/**
 * Split `text` into chunks of at most `chunkTokens * 4` characters, preferring
 * sentence boundaries (`.`, `!`, `?` followed by whitespace).
 *
 * This is the CANONICAL implementation of the incumbent memory-server
 * `splitIntoChunks` function (S11 / BL-165 consolidation). Behavior is
 * byte-identical to the original at `memory-server/src/index.ts:751–769`
 * (pre-S11), verified by the parity spec (ingest-parity.spec.ts):
 *   - Threshold: `chunkTokens * 4` characters (caller default: 500 tokens → 2000 chars)
 *   - No overlap between chunks (sentence-boundary-only split)
 *   - Trailing whitespace is trimmed from each chunk
 *   - Falls back to `[text]` for empty or non-sentence content
 *
 * Delta vs ingest's `chunkContent` (sliding-window):
 *   - `chunkContent` uses overlap (default 200 chars); this function does not.
 *   - `chunkContent` is position-based; this function prefers sentence boundaries.
 *   - See ingest-parity.spec.ts "delta documentation" section for rationale.
 */
export function splitIntoChunksSentence(text: string, chunkTokens: number): string[] {
  const chunkChars = chunkTokens * 4;
  if (text.length <= chunkChars) return [text];

  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = '';

  for (const sentence of sentences) {
    if (current.length > 0 && current.length + 1 + sentence.length > chunkChars) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? current + ' ' + sentence : sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

function chunkContent(
  content: string,
  maxChars: number,
  overlapChars: number,
): IngestChunk[] {
  const step = maxChars - overlapChars;

  if (step <= 0 || content.length <= maxChars) {
    return [{
      index: 0,
      content,
      contentHash: hexSha256(content),
      charOffset: 0,
    }];
  }

  const chunks: IngestChunk[] = [];
  let index = 0;
  let charOffset = 0;

  while (charOffset < content.length) {
    const chunkText = content.slice(charOffset, charOffset + maxChars);
    chunks.push({
      index,
      content: chunkText,
      contentHash: hexSha256(chunkText),
      charOffset,
    });
    index++;
    charOffset += step;
  }

  return chunks;
}

export function ingest(content: string, opts?: IngestOpts): IngestResult {
  const normalized = normalizeContent(content);
  const contentHash = hexSha256(normalized);
  const summarySentences = opts?.summaryMaxSentences ?? DEFAULT_SUMMARY_SENTENCES;
  const tagCount = opts?.tagMaxCount ?? DEFAULT_TAG_MAX_COUNT;

  const summary = extractiveSummary(content, summarySentences);
  const tags = extractTags(content, tagCount);

  if (opts?.chunk) {
    const maxChars = opts.chunk.maxChars ?? DEFAULT_CHUNK_MAX_CHARS;
    const overlapChars = opts.chunk.overlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS;
    const chunks = chunkContent(content, maxChars, overlapChars);
    return { contentHash, summary, tags, chunks };
  }

  return { contentHash, summary, tags };
}

// ── Chunker exports ──────────────────────────────────────────────────────────

export {
  ChunkerRegistry,
  globalChunkerRegistry,
  PermanentChunkingError,
  TransientChunkingError,
} from './chunker-registry.js';
export type {
  SourceMap,
  Chunk,
  Chunker,
  ChunkerOptions,
  ChunkerFactory,
  ChunkerPriority,
  ChunkStaleReason,
  StaleChunkConfig,
} from './chunker-registry.js';

export { AstChunker } from './ast-chunker.js';
export { HeadingChunker } from './heading-chunker.js';

// ── Auto-register chunkers at module load time ───────────────────────────────
// Static constructors populate the registry at build time, no runtime reflection.

import { AstChunker as AstChunkerImpl } from './ast-chunker.js';
import { HeadingChunker as HeadingChunkerImpl } from './heading-chunker.js';
import { globalChunkerRegistry as registry } from './chunker-registry.js';

registry.register(
  'ast:treesitter:ts',
  () => new AstChunkerImpl('typescript'),
  ['typescript'],
);
registry.register(
  'ast:treesitter:python',
  () => new AstChunkerImpl('python'),
  ['python'],
);
registry.register(
  'ast:treesitter:java',
  () => new AstChunkerImpl('java'),
  ['java'],
);
registry.register(
  'ast:treesitter:csharp',
  () => new AstChunkerImpl('csharp'),
  ['csharp'],
);
registry.register(
  'heading:markdown',
  () => new HeadingChunkerImpl('markdown'),
  ['markdown'],
);
registry.register(
  'heading:mdx',
  () => new HeadingChunkerImpl('mdx'),
  ['mdx'],
);
registry.register(
  'heading:rst',
  () => new HeadingChunkerImpl('rst'),
  ['rst'],
);
registry.register(
  'heading:asciidoc',
  () => new HeadingChunkerImpl('asciidoc'),
  ['asciidoc'],
);

// Seal the registry — no more registrations after module init
registry.seal();
