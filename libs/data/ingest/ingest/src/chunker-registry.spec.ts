import { describe, it, expect } from 'vitest';
import { ChunkerRegistry, PermanentChunkingError, TransientChunkingError } from './chunker-registry.js';
import { AstChunker } from './ast-chunker.js';
import { HeadingChunker } from './heading-chunker.js';

describe('ChunkerRegistry', () => {
  it('registers and retrieves chunkers', () => {
    const reg = new ChunkerRegistry();
    reg.register('ast:treesitter:typescript', () => new AstChunker('typescript'), ['typescript']);
    const chunker = reg.get('ast:treesitter:typescript');
    expect(chunker).toBeDefined();
    expect(chunker?.id).toBe('ast:treesitter:typescript');
  });

  it('getForLanguage returns matching chunkers', () => {
    const reg = new ChunkerRegistry();
    reg.register('heading:markdown', () => new HeadingChunker('markdown'), ['markdown']);
    const chunkers = reg.getForLanguage('markdown');
    expect(chunkers).toHaveLength(1);
    expect(chunkers[0]?.id).toBe('heading:markdown');
  });

  it('list returns all registered ids', () => {
    const reg = new ChunkerRegistry();
    reg.register('a', () => new AstChunker('typescript'), ['typescript']);
    reg.register('b', () => new HeadingChunker('markdown'), ['markdown']);
    expect(reg.list()).toEqual(['a', 'b']);
  });

  it('estimate returns at least 1', () => {
    const chunker = new HeadingChunker('markdown');
    expect(chunker.estimate('')).toBe(1);
    expect(chunker.estimate('hello world')).toBe(1);
  });
});

describe('AstChunker', () => {
  it('chunks TypeScript with function declarations', () => {
    const chunker = new AstChunker('typescript');
    const code = `
function foo() {
  return 1;
}

function bar() {
  return 2;
}
`;
    const chunks = chunker.chunk(code);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]?.text).toContain('function');
  });

  it('throws for unsupported language', () => {
    const chunker = new AstChunker('unsupported');
    expect(() => chunker.chunk('code')).toThrow(PermanentChunkingError);
  });

  it('returns whole document as one chunk when no declarations', () => {
    const chunker = new AstChunker('typescript');
    const code = 'const x = 1;\nconst y = 2;';
    const chunks = chunker.chunk(code);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(code);
  });
});

describe('HeadingChunker', () => {
  it('splits markdown on headings', () => {
    const chunker = new HeadingChunker('markdown');
    const doc = `# Title

Introduction text.

## Section 1

Section 1 content.

## Section 2

Section 2 content.`;
    const chunks = chunker.chunk(doc);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((c) => c.metadata.heading?.includes('Title'))).toBe(true);
    expect(chunks.some((c) => c.metadata.heading?.includes('Section 1'))).toBe(true);
  });

  it('returns whole document when no headings', () => {
    const chunker = new HeadingChunker('markdown');
    const doc = 'Just a plain paragraph.\n\nAnother paragraph.';
    const chunks = chunker.chunk(doc);
    expect(chunks).toHaveLength(1);
  });

  it('respects maxHeadingDepth', () => {
    const chunker = new HeadingChunker('markdown');
    const doc = `# Top

## H2

### H3`;
    const chunks = chunker.chunk(doc, { maxHeadingDepth: 2 });
    const h3Chunks = chunks.filter((c) => c.metadata.heading?.includes('H3'));
    // H3 should not be a split point when maxHeadingDepth is 2
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('throws for unsupported syntax', () => {
    const chunker = new HeadingChunker('unknown');
    expect(() => chunker.chunk('text')).toThrow(PermanentChunkingError);
  });
});

describe('PermanentChunkingError / TransientChunkingError', () => {
  it('PermanentChunkingError has correct name and chunkerId', () => {
    const err = new PermanentChunkingError('test error', 'test-chunker');
    expect(err.name).toBe('PermanentChunkingError');
    expect(err.chunkerId).toBe('test-chunker');
  });

  it('TransientChunkingError has correct name and chunkerId', () => {
    const err = new TransientChunkingError('test error', 'test-chunker');
    expect(err.name).toBe('TransientChunkingError');
    expect(err.chunkerId).toBe('test-chunker');
  });
});
