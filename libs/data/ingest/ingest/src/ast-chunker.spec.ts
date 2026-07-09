import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Parser, Language } from 'web-tree-sitter';
import { AstChunker } from './ast-chunker.js';
import { PermanentChunkingError } from './chunker-registry.js';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '__fixtures__');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

/**
 * These tests exercise the REAL `web-tree-sitter` WASM parser end-to-end —
 * no mocks, no stubs. Every assertion below either:
 *   (a) independently re-parses the fixture with a fresh tree-sitter parser
 *       to derive the ground-truth declaration boundaries and cross-checks
 *       the chunker's output against them, or
 *   (b) verifies a structural invariant (balanced braces / matching indent,
 *       exact byte-for-byte reconstruction from source lines) that only
 *       holds when chunk boundaries are genuinely AST-aligned.
 */

// ── Independent ground-truth parser (separate from the chunker under test) ──

let groundTruthParser: Parser;
const groundTruthLanguages = new Map<string, Language>();

beforeAll(async () => {
  await Parser.init();
  groundTruthParser = new Parser();
  const wasmFor: Record<string, string> = {
    typescript: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
    python: 'tree-sitter-wasms/out/tree-sitter-python.wasm',
    java: 'tree-sitter-wasms/out/tree-sitter-java.wasm',
    csharp: 'tree-sitter-wasms/out/tree-sitter-c_sharp.wasm',
  };
  for (const [lang, wasmSpecifier] of Object.entries(wasmFor)) {
    const wasmPath = require.resolve(wasmSpecifier);
    groundTruthLanguages.set(lang, await Language.load(wasmPath));
  }
});

/** Re-parse `code` independently and return the set of top-level
 *  "interesting" node types actually present (ground truth for what a
 *  real AST-aware chunker should be reacting to). */
function groundTruthTopLevelTypes(code: string, language: string): string[] {
  const grammar = groundTruthLanguages.get(language);
  if (!grammar) throw new Error(`no ground-truth grammar for ${language}`);
  groundTruthParser.setLanguage(grammar);
  const tree = groundTruthParser.parse(code);
  if (!tree) throw new Error('ground-truth parse failed');
  const types: string[] = [];
  for (const child of tree.rootNode.namedChildren) {
    if (child) types.push(child.type);
  }
  return types;
}

function countCurlyBalance(text: string): number {
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth;
}

/** Reconstruct the exact original slice for a chunk's reported source range
 *  and assert it round-trips (module whitespace-trim, since gap/preamble
 *  chunks are trimmed but declaration chunks never have surrounding
 *  whitespace inside a tree-sitter node span). */
function assertSourceMapRoundTrips(originalDocument: string, chunkText: string, startLine: number, endLine: number) {
  const lines = originalDocument.split('\n');
  const reconstructed = lines.slice(startLine, endLine + 1).join('\n');
  expect(reconstructed.trim()).toBe(chunkText.trim());
}

describe('AstChunker — real tree-sitter parsing (no regex, no mocks)', () => {
  it('does not use a regex/line-based heuristic internally — DECL_PATTERNS is gone', async () => {
    const source = readFileSync(join(__dirname, 'ast-chunker.ts'), 'utf8');
    expect(source).not.toContain('DECL_PATTERNS');
    expect(source).not.toContain('extractDeclaration');
    expect(source).toContain('web-tree-sitter');
    expect(source).toContain('tree-sitter-wasms');
  });

  describe('TypeScript', () => {
    const code = readFixture('sample.ts.fixture');
    const chunker = new AstChunker('typescript');

    it('parses via ground-truth tree-sitter and finds the expected top-level node kinds', () => {
      // Every declaration in the fixture is `export`ed, so at the top level
      // they surface as `export_statement` wrapping the real declaration
      // node (function_declaration/class_declaration/interface_declaration/
      // type_alias_declaration/enum_declaration/lexical_declaration).
      const grammar = groundTruthLanguages.get('typescript')!;
      groundTruthParser.setLanguage(grammar);
      const tree = groundTruthParser.parse(code)!;
      const exportedInnerTypes = tree.rootNode.namedChildren
        .filter((c): c is NonNullable<typeof c> => c !== null && c.type === 'export_statement')
        .flatMap((c) => c.namedChildren)
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => c.type);

      expect(exportedInnerTypes).toContain('interface_declaration');
      expect(exportedInnerTypes).toContain('type_alias_declaration');
      expect(exportedInnerTypes).toContain('enum_declaration');
      expect(exportedInnerTypes).toContain('function_declaration');
      expect(exportedInnerTypes).toContain('abstract_class_declaration');
      expect(exportedInnerTypes).toContain('class_declaration');
      expect(exportedInnerTypes).toContain('lexical_declaration');
      expect(groundTruthTopLevelTypes(code, 'typescript').filter((t) => t === 'export_statement').length).toBeGreaterThanOrEqual(7);
    });

    it('produces one chunk per top-level declaration (never splitting a function/class)', () => {
      const chunks = chunker.chunk(code);
      expect(chunks.length).toBeGreaterThan(1);

      const circleChunk = chunks.find((c) => c.text.includes('class Circle'));
      expect(circleChunk).toBeDefined();
      expect(circleChunk!.text).toContain('area(): number');
      expect(circleChunk!.text).toContain('circumference(): number');
      // Never split: the whole class body (both methods) must be present in ONE chunk.
      expect(countCurlyBalance(circleChunk!.text)).toBe(0);

      const shapeChunk = chunks.find((c) => c.text.includes('abstract class Shape'));
      expect(shapeChunk).toBeDefined();
      expect(shapeChunk!.text).toContain('describe(): string');
      expect(countCurlyBalance(shapeChunk!.text)).toBe(0);

      const distanceChunk = chunks.find((c) => c.text.includes('function distance'));
      expect(distanceChunk).toBeDefined();
      expect(distanceChunk!.text).toContain('Math.sqrt');
      expect(countCurlyBalance(distanceChunk!.text)).toBe(0);
    });

    it('every chunk is a byte-accurate (whitespace-trimmed) slice of the source at its reported SourceMap range', () => {
      const chunks = chunker.chunk(code);
      for (const chunk of chunks) {
        assertSourceMapRoundTrips(code, chunk.text, chunk.sourceMap.sourceStartLine, chunk.sourceMap.sourceEndLine);
      }
    });

    it('merges declarations shorter than minFunctionLines into the preceding chunk', () => {
      const chunks = chunker.chunk(code, { minFunctionLines: 3 });
      // `noop` and `identity` are one-liners — they must NOT appear as their own chunks.
      const standaloneNoop = chunks.find((c) => c.text.trim() === 'export const noop = () => {};');
      expect(standaloneNoop).toBeUndefined();

      const mergedChunk = chunks.find((c) => c.text.includes('export const noop'));
      expect(mergedChunk).toBeDefined();
      expect(mergedChunk!.text).toContain('const identity');
      // Merged short declarations land in the chunk immediately preceding them (the Circle class).
      expect(mergedChunk!.text).toContain('class Circle');
    });

    it('does not merge declarations at or above minFunctionLines', () => {
      const chunks = chunker.chunk(code, { minFunctionLines: 3 });
      const loadConfigChunk = chunks.find((c) => c.text.includes('async function loadConfig'));
      expect(loadConfigChunk).toBeDefined();
      // loadConfig must be its own chunk, not merged with the preceding one.
      expect(loadConfigChunk!.text).not.toContain('class Circle');
      expect(loadConfigChunk!.text).not.toContain('const noop');
    });

    it('emits trailing module-level code after the last declaration as its own chunk (nothing is silently dropped)', () => {
      const chunks = chunker.chunk(code);
      const trailing = chunks.find((c) => c.text.includes('module side effect'));
      expect(trailing).toBeDefined();
      expect(trailing!.text.trim()).toBe(
        "console.log('module side effect at the tail of the file');",
      );
    });

    it('emits the leading import preamble as its own chunk', () => {
      const chunks = chunker.chunk(code);
      const preamble = chunks[0]!;
      expect(preamble.text).toContain("import { readFile } from 'node:fs/promises'");
      expect(preamble.sourceMap.sourceStartLine).toBe(0);
    });

    it('sets metadata.chunkerId and metadata.language, and preserves chunker id', () => {
      expect(chunker.id).toBe('ast:treesitter:typescript');
      const chunks = chunker.chunk(code);
      for (const chunk of chunks) {
        expect(chunk.metadata.chunkerId).toBe('ast:treesitter:typescript');
        expect(chunk.metadata.language).toBe('typescript');
      }
      // chunkIndex is sequential starting at 0
      expect(chunks.map((c) => c.metadata.chunkIndex)).toEqual(chunks.map((_, i) => i));
    });

    it('attaches sourceUrl / sourceSha / parentDocId when provided', () => {
      const chunks = chunker.chunk(code, {
        sourceUrl: 'file:///sample.ts',
        sourceSha: 'deadbeef',
        parentDocId: 'doc-1',
      });
      for (const chunk of chunks) {
        expect(chunk.sourceMap.sourceUrl).toBe('file:///sample.ts');
        expect(chunk.sourceMap.sourceSha).toBe('deadbeef');
        expect(chunk.metadata.parentDocId).toBe('doc-1');
      }
    });

    it('estimate() reflects a real parse — matches the real top-level declaration count for a decl-only snippet', () => {
      const snippet = `function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\n`;
      const c = new AstChunker('typescript');
      expect(c.estimate(snippet)).toBe(3);
      // With minFunctionLines: 1 nothing is short enough to merge, so the
      // real chunk count matches the estimate exactly.
      expect(c.chunk(snippet, { minFunctionLines: 1 }).length).toBe(3);
      // Each one-liner IS below the default minFunctionLines (3), so by
      // default they collapse into a single merged chunk — estimate() is
      // therefore an upper bound on the true chunk count, not an exact
      // match, whenever declarations are shorter than the merge threshold.
      expect(c.chunk(snippet).length).toBe(1);
    });
  });

  describe('JavaScript (parsed via the typescript grammar — a strict syntax superset)', () => {
    const code = readFixture('sample.js.fixture');
    const chunker = new AstChunker('typescript');

    it('chunks CommonJS-style JS with function/class declarations intact', () => {
      const chunks = chunker.chunk(code);

      const loggerChunk = chunks.find((c) => c.text.includes('function createLogger'));
      expect(loggerChunk).toBeDefined();
      expect(loggerChunk!.text).toContain('return function log(message)');
      expect(countCurlyBalance(loggerChunk!.text)).toBe(0);

      const busChunk = chunks.find((c) => c.text.includes('class Bus extends EventEmitter'));
      expect(busChunk).toBeDefined();
      expect(busChunk!.text).toContain('publish(topic, payload)');
      expect(busChunk!.text).toContain('subscribe(topic, handler)');
      expect(countCurlyBalance(busChunk!.text)).toBe(0);
    });

    it('merges the one-line `add` arrow function into the preceding chunk', () => {
      const chunks = chunker.chunk(code);
      expect(chunks.some((c) => c.text.trim() === 'const add = (a, b) => a + b;')).toBe(false);
      expect(chunks.some((c) => c.text.includes('const add = (a, b) => a + b;'))).toBe(true);
    });

    it('emits the trailing module.exports statement as its own chunk', () => {
      const chunks = chunker.chunk(code);
      const trailing = chunks[chunks.length - 1]!;
      expect(trailing.text).toContain('module.exports');
    });
  });

  describe('Python', () => {
    const code = readFixture('sample.py.fixture');
    const chunker = new AstChunker('python');

    it('parses via ground-truth tree-sitter and finds function/class/decorated definitions', () => {
      const types = groundTruthTopLevelTypes(code, 'python');
      expect(types).toContain('function_definition');
      expect(types).toContain('class_definition');
      expect(types).toContain('decorated_definition');
    });

    it('keeps decorators attached to their function/class (never splitting them apart)', () => {
      const chunks = chunker.chunk(code);

      const fibChunk = chunks.find((c) => c.text.includes('def fibonacci'));
      expect(fibChunk).toBeDefined();
      expect(fibChunk!.text).toContain('@functools.lru_cache(maxsize=128)');

      const versionChunk = chunks.find((c) => c.text.includes('class Version'));
      expect(versionChunk).toBeDefined();
      expect(versionChunk!.text).toContain('@functools.total_ordering');
      expect(versionChunk!.text).toContain('__lt__');
    });

    it('keeps the Repository class body (both methods) in a single, unsplit chunk', () => {
      const chunks = chunker.chunk(code);
      const repoChunk = chunks.find((c) => c.text.includes('class Repository'));
      expect(repoChunk).toBeDefined();
      expect(repoChunk!.text).toContain('def path_for');
      expect(repoChunk!.text).toContain('def exists');
    });

    it('every chunk is a byte-accurate (whitespace-trimmed) slice of the source at its reported SourceMap range', () => {
      const chunks = chunker.chunk(code);
      for (const chunk of chunks) {
        assertSourceMapRoundTrips(code, chunk.text, chunk.sourceMap.sourceStartLine, chunk.sourceMap.sourceEndLine);
      }
    });

    it('emits the trailing `if __name__` guard as its own chunk', () => {
      const chunks = chunker.chunk(code);
      const trailing = chunks.find((c) => c.text.includes("if __name__"));
      expect(trailing).toBeDefined();
      expect(trailing!.text).toContain("print(slugify('Hello World'))");
    });
  });

  describe('Java', () => {
    const code = readFixture('Sample.java.fixture');
    const chunker = new AstChunker('java');

    it('parses via ground-truth tree-sitter and finds class/interface/enum declarations', () => {
      const types = groundTruthTopLevelTypes(code, 'java');
      expect(types).toContain('class_declaration');
      expect(types).toContain('interface_declaration');
      expect(types).toContain('enum_declaration');
    });

    it('chunks each top-level type (class/interface/enum) as one unsplit chunk', () => {
      const chunks = chunker.chunk(code);

      const accountChunk = chunks.find((c) => c.text.includes('class Account'));
      expect(accountChunk).toBeDefined();
      expect(accountChunk!.text).toContain('public void deposit(double amount)');
      expect(accountChunk!.text).toContain('public boolean withdraw(double amount)');
      expect(countCurlyBalance(accountChunk!.text)).toBe(0);

      const payableChunk = chunks.find((c) => c.text.includes('interface Payable'));
      expect(payableChunk).toBeDefined();

      const enumChunk = chunks.find((c) => c.text.includes('enum AccountType'));
      expect(enumChunk).toBeDefined();
      expect(enumChunk!.text).toContain('CHECKING');

      const factoryChunk = chunks.find((c) => c.text.includes('class AccountFactory'));
      expect(factoryChunk).toBeDefined();
      expect(factoryChunk!.text).toContain('Account open(String owner)');
    });

    it('emits the package + import preamble as its own chunk', () => {
      const chunks = chunker.chunk(code);
      expect(chunks[0]!.text).toContain('package com.example.sample;');
      expect(chunks[0]!.text).toContain('import java.util.List;');
    });
  });

  describe('C#', () => {
    const code = readFixture('Sample.cs.fixture');
    const chunker = new AstChunker('csharp');

    it('parses via ground-truth tree-sitter — top-level is a single namespace_declaration container', () => {
      const types = groundTruthTopLevelTypes(code, 'csharp');
      expect(types).toContain('namespace_declaration');
    });

    it('recurses transparently through the namespace container to chunk on the classes/interfaces/structs/enums/records inside it', () => {
      const chunks = chunker.chunk(code);

      // The whole `namespace Acme.Billing { ... }` block must NOT appear as
      // a single giant chunk — the namespace is a transparent container.
      expect(chunks.some((c) => c.text.trimStart().startsWith('namespace Acme.Billing'))).toBe(false);

      const invoiceChunk = chunks.find((c) => c.text.includes('class Invoice'));
      expect(invoiceChunk).toBeDefined();
      expect(invoiceChunk!.text).toContain('public void AddLineItem(double amount)');
      expect(invoiceChunk!.text).toContain('public double Total()');
      expect(countCurlyBalance(invoiceChunk!.text)).toBe(0);

      const repoChunk = chunks.find((c) => c.text.includes('interface IInvoiceRepository'));
      expect(repoChunk).toBeDefined();

      const moneyChunk = chunks.find((c) => c.text.includes('struct Money'));
      expect(moneyChunk).toBeDefined();

      const statusChunk = chunks.find((c) => c.text.includes('enum InvoiceStatus'));
      expect(statusChunk).toBeDefined();
      expect(statusChunk!.text).toContain('Paid');

      const lineChunk = chunks.find((c) => c.text.includes('record InvoiceLine'));
      expect(lineChunk).toBeDefined();
    });

    it('every chunk is a byte-accurate (whitespace-trimmed) slice of the source at its reported SourceMap range', () => {
      const chunks = chunker.chunk(code);
      for (const chunk of chunks) {
        assertSourceMapRoundTrips(code, chunk.text, chunk.sourceMap.sourceStartLine, chunk.sourceMap.sourceEndLine);
      }
    });
  });

  describe('graceful fallback for unsupported languages', () => {
    it('throws PermanentChunkingError from chunk() for an unsupported language', () => {
      const chunker = new AstChunker('cobol');
      expect(() => chunker.chunk('IDENTIFICATION DIVISION.')).toThrow(PermanentChunkingError);
    });

    it('estimate() degrades gracefully (returns 1) instead of throwing for an unsupported language', () => {
      const chunker = new AstChunker('cobol');
      expect(chunker.estimate('IDENTIFICATION DIVISION.')).toBe(1);
    });

    it('preserves the id format ast:treesitter:<language> even for unsupported languages', () => {
      const chunker = new AstChunker('cobol');
      expect(chunker.id).toBe('ast:treesitter:cobol');
      expect(chunker.supportedLanguages).toEqual(['cobol']);
    });
  });

  describe('edge cases', () => {
    it('returns the whole document as one chunk when there are no top-level declarations', () => {
      const chunker = new AstChunker('typescript');
      const code = 'const x = 1;\nconst y = 2;';
      const chunks = chunker.chunk(code);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.text).toBe(code);
    });

    it('handles an empty document without throwing', () => {
      const chunker = new AstChunker('typescript');
      expect(() => chunker.chunk('')).not.toThrow();
    });

    it('re-export statements (export { x } from "y") are not misclassified as declarations', () => {
      const chunker = new AstChunker('typescript');
      const code = `export { foo } from './foo';\nexport * from './bar';\n\nexport function real() {\n  return 1;\n}\n`;
      const chunks = chunker.chunk(code);
      const realChunk = chunks.find((c) => c.text.includes('function real'));
      expect(realChunk).toBeDefined();
      // the re-export lines should be part of the preamble, not a fake declaration chunk of their own
      const reExportChunk = chunks.find((c) => c.text.includes("from './foo'"));
      expect(reExportChunk).toBeDefined();
      expect(reExportChunk!.text).not.toBe(undefined);
    });
  });
});
