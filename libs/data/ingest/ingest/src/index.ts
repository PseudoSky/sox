// ── @adhd/sox-ingest — package root (ESM-only) ──────────────────────────────
//
// [BL-231] The pure ingest core now lives in `./core.ts` and is re-exported
// here verbatim, so this root's public API is UNCHANGED.
//
// This root is **ESM-only** and cannot be `require()`d, because it statically
// pulls `./ast-chunker.js`, which performs a module-scope `await Parser.init()`
// to preload tree-sitter WASM grammars (`AstChunker.chunk()`/`.estimate()` are
// synchronous by contract, and `web-tree-sitter@0.25.10` exposes no `initSync`).
// Node refuses to `require()` an ESM graph containing top-level await, and
// esbuild cannot compile one under `format: 'cjs'`.
//
// **CommonJS consumers must import `@adhd/sox-ingest/core`** — a TLA-free
// subpath exporting `ingest`, `hexSha256`, `splitIntoChunksSentence` and the
// `Ingest*` types. That is what `@adhd/sox-memory-core` (a CJS build) uses.
// ESM consumers may keep importing this root for the full chunker surface.

export type { IngestChunk, IngestResult, IngestOpts } from './core.js';
export { hexSha256, splitIntoChunksSentence, ingest } from './core.js';

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
export type { SupportedAstLanguage } from './ast-chunker.js';
export { HeadingChunker } from './heading-chunker.js';
export { MixedFormatChunker, extractFencedCodeBlocks, mapFenceLanguage } from './mixed-format-chunker.js';
export type { FencedCodeBlock } from './mixed-format-chunker.js';

// ── Auto-register chunkers at module load time ───────────────────────────────
// Static constructors populate the registry at build time, no runtime reflection.

import { AstChunker as AstChunkerImpl } from './ast-chunker.js';
import { HeadingChunker as HeadingChunkerImpl } from './heading-chunker.js';
import { MixedFormatChunker as MixedFormatChunkerImpl } from './mixed-format-chunker.js';
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

// Mixed-format chunkers: heading chunker runs first (order 0, parent),
// AST chunker runs on fenced code blocks within each section (order 1,
// child). See mixed-format-chunker.ts for the ordering/nesting contract.
registry.register(
  'mixed:markdown',
  () => new MixedFormatChunkerImpl('markdown'),
  ['markdown'],
);
registry.register(
  'mixed:mdx',
  () => new MixedFormatChunkerImpl('mdx'),
  ['mdx'],
);
registry.register(
  'mixed:rst',
  () => new MixedFormatChunkerImpl('rst'),
  ['rst'],
);
registry.register(
  'mixed:asciidoc',
  () => new MixedFormatChunkerImpl('asciidoc'),
  ['asciidoc'],
);
