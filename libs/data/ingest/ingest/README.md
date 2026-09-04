# @adhd/sox-ingest

Write-path transforms for turning raw text into retrievable memory: content-hashing (SHA-256
dedup), extractive summarization (lead-sentence, zero LLM), deterministic tag extraction, and two
levels of chunking — a simple sliding-window/sentence splitter, and a full format-aware chunker
registry (AST-aware code chunking via tree-sitter, heading-aware chunking for Markdown/MDX/RST/
AsciiDoc, and a mixed-format chunker that nests the two). Every function is pure, synchronous, and
deterministic — no network calls, no disk I/O, no randomness, same input always produces the same
output.

```bash
pnpm add @adhd/sox-ingest
```

## Quick start

```typescript
import { ingest } from '@adhd/sox-ingest';

const result = ingest('Bi-temporal edges supersede facts rather than overwriting them. ' +
  'This keeps the full history of every revision available for audit.');

console.log(result.contentHash); // 64-char SHA-256 hex digest, stable across repeated calls
console.log(result.summary);     // lead-sentence extractive summary (no LLM)
console.log(result.tags);        // deterministic high-frequency terms, e.g. ['temporal', 'edges', ...]
```

Ask for chunks by passing `chunk` options — useful when `content` is too large to embed or send to
a model in one piece:

```typescript
const chunked = ingest(longDocument, {
  chunk: { maxChars: 2000, overlapChars: 200 },
});
for (const chunk of chunked.chunks ?? []) {
  console.log(chunk.index, chunk.charOffset, chunk.contentHash);
}
```

## Two entry points — pick the one that matches your module system

```typescript
import { ingest, hexSha256, splitIntoChunksSentence } from '@adhd/sox-ingest';       // ESM only
import { ingest, hexSha256, splitIntoChunksSentence } from '@adhd/sox-ingest/core';  // ESM or CommonJS
```

The package root (`@adhd/sox-ingest`) also pulls in the format-aware chunkers (`AstChunker`,
`HeadingChunker`, `MixedFormatChunker`), and `AstChunker`'s module preloads its tree-sitter WASM
grammars with a module-scope `await` — which makes the whole root **ESM-only**; Node refuses to
`require()` a module graph containing a top-level await. If your project is CommonJS (or you only
need `ingest`/`hexSha256`/`splitIntoChunksSentence` and want to avoid pulling in tree-sitter at
all), import the `@adhd/sox-ingest/core` subpath instead — it re-exports the same three functions
and types from a module with no top-level await, safe to `require()`.

## API reference

### Core transforms (`@adhd/sox-ingest` or `@adhd/sox-ingest/core`)

```typescript
interface IngestOpts {
  summaryMaxSentences?: number;   // default 3
  tagMaxCount?: number;            // default 10
  chunk?: { maxChars?: number; overlapChars?: number }; // default 2000 / 200 — omit to skip chunking
}
interface IngestChunk {
  index: number;
  content: string;
  contentHash: string;   // SHA-256 of this chunk's raw content
  charOffset: number;
}
interface IngestResult {
  contentHash: string;   // SHA-256 of normalized (trimmed, whitespace-collapsed) content
  summary: string;
  tags: string[];
  chunks?: IngestChunk[]; // present only when opts.chunk was supplied
}

function ingest(content: string, opts?: IngestOpts): IngestResult;
function hexSha256(data: string): string;
function splitIntoChunksSentence(text: string, chunkTokens: number): string[];
```

- **`hexSha256`** is a raw hasher — it does not normalize input. `ingest()` normalizes
  (trim + collapse whitespace) before hashing; call `hexSha256(content.trim().toLowerCase())`
  yourself if you need dedup-hash parity with a lowercase-normalizing store instead.
- **Summaries under 100 characters are returned unchanged** (`content.trim()`) rather than run
  through sentence splitting — there's nothing to extract from a fragment that short.
- **`splitIntoChunksSentence(text, chunkTokens)`** differs from `ingest()`'s own `chunk` option: it
  splits at `chunkTokens * 4` characters preferring sentence boundaries and produces **no overlap**
  between chunks, versus `ingest()`'s fixed-size sliding window **with** overlap. Pick
  `splitIntoChunksSentence` when you want chunks that never cut a sentence in half; pick
  `ingest({ chunk })` when you want per-chunk content hashes and consistent overlap for
  retrieval-context stitching.

### Format-aware chunkers (`@adhd/sox-ingest`, ESM only)

Every chunker implements the same synchronous interface and always attaches a `SourceMap` so a
chunk can be traced back to its exact line range in the source document:

```typescript
interface SourceMap {
  sourceStartLine: number;
  sourceEndLine: number;
  sourceUrl?: string;
  sourceSha?: string;
}
interface Chunk {
  text: string;
  sourceMap: SourceMap;
  metadata: {
    chunkerId: string;
    language?: string;
    heading?: string;         // e.g. "Installation > Prerequisites"
    parentDocId?: string;
    chunkIndex: number;
    isHeadingRoot?: boolean;
  };
  embedding?: Float32Array;   // empty at chunking time; populate after vectorizing
}
interface ChunkerOptions {
  sourceUrl?: string;
  sourceSha?: string;
  parentDocId?: string;
  minFunctionLines?: number;   // AstChunker: merge shorter declarations into the previous chunk (default 3)
  maxHeadingDepth?: number;    // HeadingChunker: split down to this heading depth (default 6)
}
interface Chunker {
  readonly id: string;
  readonly supportedLanguages: string[];
  chunk(document: string, options?: ChunkerOptions): Chunk[];
  estimate(document: string): number;
}
```

#### `AstChunker` — syntax-aware code chunking

Parses real source with `web-tree-sitter` (WASM grammars, no native build step) and splits on
top-level declaration boundaries — a function or class body is never split across two chunks:

```typescript
import { AstChunker } from '@adhd/sox-ingest';

const chunker = new AstChunker('typescript'); // 'typescript' | 'python' | 'java' | 'csharp'
const chunks = chunker.chunk(`
function foo() {
  return 1;
}

function bar() {
  return 2;
}
`);
console.log(chunks.length, chunks[0]?.metadata.chunkerId); // 2 'ast:treesitter:typescript'
```

Declarations shorter than `minFunctionLines` (default 3) are merged into the preceding chunk
instead of becoming their own singleton chunk.

#### `HeadingChunker` — Markdown / MDX / RST / AsciiDoc

Splits a document on heading boundaries and stamps a `heading` breadcrumb (e.g.
`"Installation > Prerequisites"`) onto each chunk's metadata:

```typescript
import { HeadingChunker } from '@adhd/sox-ingest';

const chunker = new HeadingChunker('markdown'); // 'markdown' | 'mdx' | 'rst' | 'asciidoc'
const chunks = chunker.chunk('# Setup\n\nRun `pnpm install`.\n\n## Prerequisites\n\nNode 20+.');
```

#### `MixedFormatChunker` — headings with embedded code fences

Runs the heading chunker first (parent sections), then the AST chunker over each fenced code block
found within a section (child chunks) — so a Markdown doc with embedded TypeScript examples
produces both prose chunks and syntax-aware code chunks, correctly nested:

```typescript
import { MixedFormatChunker, extractFencedCodeBlocks, mapFenceLanguage } from '@adhd/sox-ingest';

const chunker = new MixedFormatChunker('markdown'); // 'markdown' | 'mdx' | 'rst' | 'asciidoc'
const chunks = chunker.chunk(document);

// Lower-level helpers used internally, also useful standalone:
mapFenceLanguage('ts');   // 'typescript' — normalizes fence tags/aliases to an AstChunker language
mapFenceLanguage('bash'); // null — unsupported for AST chunking, left as a prose chunk
extractFencedCodeBlocks(document, 'markdown'); // FencedCodeBlock[] — raw fence extraction, no AST parse
```

#### `ChunkerRegistry` — language-keyed lookup

The package root auto-registers one instance of every chunker above (by language) into
`globalChunkerRegistry` at import time — no runtime reflection, static registration:

```typescript
import { globalChunkerRegistry } from '@adhd/sox-ingest';

const chunkers = globalChunkerRegistry.getForLanguage('markdown');
// → both 'heading:markdown' and 'mixed:markdown' — pick whichever fits your pipeline
console.log(globalChunkerRegistry.list());
```

Build your own registry (e.g. to register only a subset, or a custom chunker) with
`new ChunkerRegistry()` — `register(id, factory, languages)`, `get(id)`, `getForLanguage(lang)`,
`list()`, and `seal()` to lock it against further registration.

A chunker throws `PermanentChunkingError` for a genuinely unsupported input (e.g. an unrecognized
heading syntax) and `TransientChunkingError` for a retryable failure — catch the two separately
rather than treating every chunking failure the same way.

`ChunkStaleReason` (`'source_updated' | 'chunker_upgraded' | 'ttl_expired'`) and
`StaleChunkConfig` (`{ staleThresholdDays }`) are exported types for a consumer that wants to track
when a previously-chunked document needs re-chunking — this package does not itself schedule or
run that check.

## Invariants

- **Zero-LLM, zero-I/O, synchronous.** `ingest()` never touches the network or the filesystem and
  never awaits anything — safe to call on every write with no latency budget concerns.
- **Deterministic and byte-reproducible.** The same input always produces the same hash, summary,
  tags, and chunk boundaries — no random or time-based components anywhere in this package.
- **No storage dependency.** This package has zero database/adapter dependencies of its own; it
  does not inherit or participate in any store's write-concurrency model. A caller (such as
  `@adhd/sox-memory-core`, which re-exports `hexSha256`/`splitIntoChunksSentence` from the `/core`
  subpath for its own CommonJS build) is responsible for persisting whatever `ingest()` returns.

## License

MIT
