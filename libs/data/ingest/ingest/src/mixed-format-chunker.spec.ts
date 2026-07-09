import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MixedFormatChunker,
  extractFencedCodeBlocks,
  mapFenceLanguage,
} from './mixed-format-chunker.js';
import { PermanentChunkingError } from './chunker-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '__fixtures__');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

describe('mapFenceLanguage()', () => {
  it('maps common language tags/aliases to their AST chunker language', () => {
    expect(mapFenceLanguage('typescript')).toBe('typescript');
    expect(mapFenceLanguage('ts')).toBe('typescript');
    expect(mapFenceLanguage('js')).toBe('typescript');
    expect(mapFenceLanguage('javascript')).toBe('typescript');
    expect(mapFenceLanguage('python')).toBe('python');
    expect(mapFenceLanguage('py')).toBe('python');
    expect(mapFenceLanguage('java')).toBe('java');
    expect(mapFenceLanguage('csharp')).toBe('csharp');
    expect(mapFenceLanguage('cs')).toBe('csharp');
  });

  it('is case-insensitive', () => {
    expect(mapFenceLanguage('TypeScript')).toBe('typescript');
    expect(mapFenceLanguage('PYTHON')).toBe('python');
  });

  it('returns null for unsupported/absent language tags', () => {
    expect(mapFenceLanguage('bash')).toBeNull();
    expect(mapFenceLanguage(undefined)).toBeNull();
    expect(mapFenceLanguage('')).toBeNull();
    expect(mapFenceLanguage('rust')).toBeNull();
  });
});

describe('extractFencedCodeBlocks() — markdown/mdx', () => {
  const doc = readFixture('sample-with-code.md.fixture');
  const lines = doc.split('\n');

  it('finds every fenced block with its declared language tag', () => {
    const blocks = extractFencedCodeBlocks(doc, 'markdown');
    expect(blocks.map((b) => b.languageTag)).toEqual(['bash', 'typescript', 'python']);
  });

  it('reports absolute, 0-based, inclusive line ranges that exactly bound the code (fences excluded)', () => {
    const blocks = extractFencedCodeBlocks(doc, 'markdown');
    const tsBlock = blocks.find((b) => b.languageTag === 'typescript')!;
    expect(tsBlock).toBeDefined();

    // The line right before codeStartLine must be the opening fence.
    expect(lines[tsBlock.codeStartLine - 1]).toMatch(/^```typescript\s*$/);
    // The line right after codeEndLine must be the closing fence.
    expect(lines[tsBlock.codeEndLine + 1]).toMatch(/^```\s*$/);
    // The extracted code itself contains no fence markers.
    const code = lines.slice(tsBlock.codeStartLine, tsBlock.codeEndLine + 1).join('\n');
    expect(code).not.toContain('```');
    expect(code).toContain('export function createWidget');
  });

  it('works identically for mdx syntax', () => {
    const blocks = extractFencedCodeBlocks(doc, 'mdx');
    expect(blocks.length).toBe(3);
  });

  it('returns [] for a document with no fences', () => {
    expect(extractFencedCodeBlocks('just plain text\nno code here\n', 'markdown')).toEqual([]);
  });
});

describe('extractFencedCodeBlocks() — rst', () => {
  const doc = readFixture('sample-with-code.rst.fixture');
  const lines = doc.split('\n');

  it('finds the code-block directive and its language', () => {
    const blocks = extractFencedCodeBlocks(doc, 'rst');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.languageTag).toBe('python');
  });

  it('captures the indented body until dedent, excluding the directive line', () => {
    const blocks = extractFencedCodeBlocks(doc, 'rst');
    const block = blocks[0]!;
    const code = lines.slice(block.codeStartLine, block.codeEndLine + 1).join('\n');
    expect(code).toContain('def greet(name):');
    expect(code).toContain('class Greeter:');
    expect(code).not.toContain('code-block');
    expect(code).not.toContain('Trailing text');
  });
});

describe('extractFencedCodeBlocks() — asciidoc', () => {
  const doc = readFixture('sample-with-code.adoc.fixture');
  const lines = doc.split('\n');

  it('finds the [source,lang] delimited block and its language', () => {
    const blocks = extractFencedCodeBlocks(doc, 'asciidoc');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.languageTag).toBe('typescript');
  });

  it('captures the code between ---- delimiters, excluding the delimiters themselves', () => {
    const blocks = extractFencedCodeBlocks(doc, 'asciidoc');
    const block = blocks[0]!;
    const code = lines.slice(block.codeStartLine, block.codeEndLine + 1).join('\n');
    expect(code).toContain('export function greet');
    expect(code).not.toContain('----');
    expect(code).not.toContain('Trailing text');
  });
});

describe('MixedFormatChunker — heading-parent + AST-code-child ordering', () => {
  const doc = readFixture('sample-with-code.md.fixture');
  const chunker = new MixedFormatChunker('markdown');

  it('has id mixed:<syntax>', () => {
    expect(chunker.id).toBe('mixed:markdown');
    expect(chunker.supportedLanguages).toEqual(['markdown']);
  });

  it('runs the heading chunker first — every heading section is present as a parent chunk', () => {
    const chunks = chunker.chunk(doc);
    const headingChunks = chunks.filter((c) => c.metadata.chunkerId === 'heading:markdown');
    const headings = headingChunks.map((c) => c.metadata.heading);
    expect(headings).toContain('API Documentation');
    expect(headings).toContain('API Documentation > Installation');
    expect(headings).toContain('API Documentation > TypeScript usage');
    expect(headings).toContain('API Documentation > Python usage');
    expect(headings).toContain('API Documentation > Notes');
  });

  it('runs the AST chunker on fenced code blocks, nesting the result as children immediately after their parent heading', () => {
    const chunks = chunker.chunk(doc);

    const tsHeadingIdx = chunks.findIndex(
      (c) => c.metadata.chunkerId === 'heading:markdown' && c.metadata.heading?.includes('TypeScript usage'),
    );
    expect(tsHeadingIdx).toBeGreaterThanOrEqual(0);

    const nextChunk = chunks[tsHeadingIdx + 1]!;
    expect(nextChunk.metadata.chunkerId).toBe('ast:treesitter:typescript');
    // The child shares its parent's heading path — this is how the frozen
    // Chunk shape encodes "nested under this heading" without a new field.
    expect(nextChunk.metadata.heading).toBe(chunks[tsHeadingIdx]!.metadata.heading);
    expect(nextChunk.text).toContain('createWidget');
  });

  it('produces an AST child chunk for the Python code fence too, under the Python usage heading', () => {
    const chunks = chunker.chunk(doc);
    const pyHeadingIdx = chunks.findIndex(
      (c) => c.metadata.chunkerId === 'heading:markdown' && c.metadata.heading?.includes('Python usage'),
    );
    const pyChild = chunks[pyHeadingIdx + 1]!;
    expect(pyChild.metadata.chunkerId).toBe('ast:treesitter:python');
    expect(pyChild.text).toContain('def create_widget');
  });

  it('gracefully skips fenced blocks in an unsupported language (bash) — no crash, no AST child', () => {
    const chunks = chunker.chunk(doc);
    const installHeadingIdx = chunks.findIndex(
      (c) => c.metadata.chunkerId === 'heading:markdown' && c.metadata.heading?.includes('Installation'),
    );
    expect(installHeadingIdx).toBeGreaterThanOrEqual(0);
    const nextChunk = chunks[installHeadingIdx + 1];
    // Either there is no next chunk from this section, or it belongs to the next heading — never an AST chunk for bash.
    if (nextChunk) {
      expect(nextChunk.metadata.chunkerId).not.toMatch(/^ast:treesitter:/);
    }
  });

  it('the "Notes" heading (no code fence) remains a heading-only chunk with no AST children', () => {
    const chunks = chunker.chunk(doc);
    const notesIdx = chunks.findIndex(
      (c) => c.metadata.chunkerId === 'heading:markdown' && c.metadata.heading?.includes('Notes'),
    );
    expect(notesIdx).toBe(chunks.length - 1);
  });

  it('AST child chunk sourceMap line numbers point at the correct absolute lines in the ORIGINAL document', () => {
    const chunks = chunker.chunk(doc);
    const tsChild = chunks.find((c) => c.metadata.chunkerId === 'ast:treesitter:typescript' && c.text.includes('createWidget'))!;
    expect(tsChild).toBeDefined();

    const originalLines = doc.split('\n');
    const reconstructed = originalLines
      .slice(tsChild.sourceMap.sourceStartLine, tsChild.sourceMap.sourceEndLine + 1)
      .join('\n');
    expect(reconstructed.trim()).toBe(tsChild.text.trim());
  });

  it('renumbers chunkIndex sequentially across the whole merged, ordered result', () => {
    const chunks = chunker.chunk(doc);
    expect(chunks.map((c) => c.metadata.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it('throws PermanentChunkingError for an unsupported syntax', () => {
    const badChunker = new MixedFormatChunker('unsupported');
    expect(() => badChunker.chunk('text')).toThrow(PermanentChunkingError);
  });

  it('estimate() sums the heading estimate and the AST estimate of each recognized fence', () => {
    const estimate = chunker.estimate(doc);
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeGreaterThanOrEqual(chunker.chunk(doc).length - 2); // heading+AST estimate is a lower-ish bound
  });

  it('propagates sourceUrl/sourceSha/parentDocId to both heading and AST child chunks', () => {
    const chunks = chunker.chunk(doc, {
      sourceUrl: 'file:///docs/widget.md',
      sourceSha: 'cafebabe',
      parentDocId: 'doc-42',
    });
    for (const c of chunks) {
      expect(c.sourceMap.sourceUrl).toBe('file:///docs/widget.md');
      expect(c.sourceMap.sourceSha).toBe('cafebabe');
      expect(c.metadata.parentDocId).toBe('doc-42');
    }
  });
});
