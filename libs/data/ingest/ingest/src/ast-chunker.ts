import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Language, Parser, type Node as TSNode } from 'web-tree-sitter';
import type { Chunker, Chunk, ChunkerOptions } from './chunker-registry.js';
import { PermanentChunkingError } from './chunker-registry.js';

// ── Syntax-aware AST chunker (cAST algorithm, real tree-sitter backed) ──────
//
// Implements the cAST algorithm (code AST chunker):
// 1. Parse source code into a real syntax tree via `web-tree-sitter` (WASM).
// 2. Walk the tree for top-level declaration nodes (function, class,
//    interface, type alias, enum, record, struct, ...) — recursing
//    transparently through pure scoping containers (e.g. C# `namespace`).
// 3. Preserve function/class boundaries — a declaration's own node span is
//    never split across two chunks.
// 4. Merge declarations shorter than `minFunctionLines` into the preceding
//    chunk.
// 5. Attach accurate `SourceMap` line ranges (0-based, inclusive) per chunk.
//
// `web-tree-sitter` (WASM grammars) was chosen over native `tree-sitter` +
// node-gyp bindings to avoid a native build toolchain and stay portable
// across the workspace/CI (no per-platform prebuilds to manage).

const require = createRequire(import.meta.url);

export type SupportedAstLanguage = 'typescript' | 'python' | 'java' | 'csharp';

const SUPPORTED_LANGUAGES: readonly SupportedAstLanguage[] = [
  'typescript',
  'python',
  'java',
  'csharp',
];

/** Grammar WASM binaries, resolved through `tree-sitter-wasms` (prebuilt,
 *  portable — no native compilation required). */
const GRAMMAR_WASM_MODULE_PATHS: Record<SupportedAstLanguage, string> = {
  typescript: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
  python: 'tree-sitter-wasms/out/tree-sitter-python.wasm',
  java: 'tree-sitter-wasms/out/tree-sitter-java.wasm',
  csharp: 'tree-sitter-wasms/out/tree-sitter-c_sharp.wasm',
};

/** Top-level declaration node types per language — these are the cAST chunk
 *  boundaries. A declaration's node span is always emitted whole; it is
 *  never split across chunks. */
const DECLARATION_NODE_TYPES: Record<SupportedAstLanguage, ReadonlySet<string>> = {
  typescript: new Set([
    'function_declaration',
    'generator_function_declaration',
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'ambient_declaration',
  ]),
  python: new Set(['function_definition', 'class_definition', 'decorated_definition']),
  java: new Set([
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
    'annotation_type_declaration',
  ]),
  csharp: new Set([
    'class_declaration',
    'interface_declaration',
    'struct_declaration',
    'enum_declaration',
    'record_declaration',
    'record_struct_declaration',
    'delegate_declaration',
  ]),
};

/** Node types that are transparent scoping containers: their own span is
 *  never a chunk boundary, but their body is walked for nested top-level
 *  declarations (e.g. a C# `namespace Foo { class Bar {} }` should chunk on
 *  `class Bar`, not on the whole namespace). */
const CONTAINER_NODE_TYPES: Record<SupportedAstLanguage, ReadonlySet<string>> = {
  typescript: new Set(),
  python: new Set(),
  java: new Set(),
  csharp: new Set(['namespace_declaration', 'file_scoped_namespace_declaration']),
};

function isSupportedAstLanguage(language: string): language is SupportedAstLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(language);
}

/** `const foo = () => {...}` / `const foo = function() {...}` — a
 *  function-valued lexical/variable declaration counts as a declaration
 *  boundary even though the grammar doesn't give it its own node type. */
function isFunctionValuedVariableDeclaration(node: TSNode): boolean {
  if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') {
    return false;
  }
  for (const declarator of node.namedChildren) {
    if (!declarator || declarator.type !== 'variable_declarator') continue;
    const value = declarator.childForFieldName('value');
    if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
      return true;
    }
  }
  return false;
}

function isDeclarationNode(node: TSNode, language: SupportedAstLanguage): boolean {
  if (DECLARATION_NODE_TYPES[language].has(node.type)) return true;

  if (language === 'typescript') {
    if (isFunctionValuedVariableDeclaration(node)) return true;

    // `export function foo() {}` / `export class Foo {}` / `export const x = () => {}`
    // wrap the real declaration inside an `export_statement` node. Re-exports
    // (`export { x } from './y'`, `export * from './y'`) do NOT wrap a
    // declaration and correctly fall through as non-declarations.
    if (node.type === 'export_statement') {
      for (const child of node.namedChildren) {
        if (!child) continue;
        if (DECLARATION_NODE_TYPES.typescript.has(child.type)) return true;
        if (isFunctionValuedVariableDeclaration(child)) return true;
      }
    }
  }

  return false;
}

interface DeclSpan {
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, inclusive. */
  endLine: number;
}

/** Walk the syntax tree for top-level declaration spans, transparently
 *  recursing through scoping containers (see `CONTAINER_NODE_TYPES`). */
function collectTopLevelDeclarations(
  rootNode: TSNode,
  language: SupportedAstLanguage,
): DeclSpan[] {
  const containerTypes = CONTAINER_NODE_TYPES[language];
  const decls: DeclSpan[] = [];

  const visit = (node: TSNode): void => {
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (isDeclarationNode(child, language)) {
        decls.push({ startLine: child.startPosition.row, endLine: child.endPosition.row });
      } else if (containerTypes.has(child.type)) {
        const body = child.childForFieldName('body') ?? child;
        visit(body);
      }
    }
  };

  visit(rootNode);
  decls.sort((a, b) => a.startLine - b.startLine);
  return decls;
}

// ── WASM grammar bootstrap ───────────────────────────────────────────────────
//
// The public `Chunker.chunk()` / `Chunker.estimate()` contract is
// synchronous, so all grammars are eagerly loaded once at module-evaluation
// time via top-level await (real, standard ESM — supported by this
// package's `module: NodeNext` / `target: ES2022` config and by vitest/Node
// natively). By the time any `AstChunker` instance is constructed and used,
// every supported grammar is already resident in memory; `chunk()` and
// `estimate()` never need to await anything.

await Parser.init();

/** Single shared parser instance. Safe to reuse across languages/instances:
 *  Node.js is single-threaded and `chunk()`/`estimate()` are fully
 *  synchronous (no `await` between `setLanguage()` and `parse()`), so calls
 *  never interleave. */
const sharedParser = new Parser();

const languageCache = new Map<SupportedAstLanguage, Language>();

await Promise.all(
  SUPPORTED_LANGUAGES.map(async (language) => {
    const wasmPath = require.resolve(GRAMMAR_WASM_MODULE_PATHS[language]);
    const grammar = await Language.load(wasmPath);
    languageCache.set(language, grammar);
  }),
);

// ── AstChunker ───────────────────────────────────────────────────────────────

export class AstChunker implements Chunker {
  readonly id: string;
  readonly supportedLanguages: string[];
  private language: string;

  constructor(language: string) {
    this.language = language;
    this.id = `ast:treesitter:${language}`;
    this.supportedLanguages = [language];
  }

  private loadGrammarOrThrow(): { language: SupportedAstLanguage; grammar: Language } {
    if (!isSupportedAstLanguage(this.language)) {
      throw new PermanentChunkingError(`Unsupported language: ${this.language}`, this.id);
    }
    const grammar = languageCache.get(this.language);
    if (!grammar) {
      // Defensive: every entry in SUPPORTED_LANGUAGES is preloaded above.
      // This only fires if that invariant is ever broken.
      throw new PermanentChunkingError(
        `Grammar not loaded for language: ${this.language}`,
        this.id,
      );
    }
    return { language: this.language, grammar };
  }

  chunk(document: string, options?: ChunkerOptions): Chunk[] {
    const { language, grammar } = this.loadGrammarOrThrow();

    sharedParser.setLanguage(grammar);
    const tree = sharedParser.parse(document);
    if (!tree) {
      throw new PermanentChunkingError(
        `tree-sitter failed to parse document for language: ${language}`,
        this.id,
      );
    }

    const lines = document.split('\n');
    const minLines = options?.minFunctionLines ?? 3;
    const sourceSha = options?.sourceSha ?? createHash('sha256').update(document).digest('hex');
    const declarations = collectTopLevelDeclarations(tree.rootNode, language);
    const chunks: Chunk[] = [];
    let chunkIndex = 0;

    const makeChunk = (text: string, startLine: number, endLine: number): Chunk => ({
      text,
      sourceMap: {
        sourceStartLine: startLine,
        sourceEndLine: endLine,
        ...(options?.sourceUrl !== undefined ? { sourceUrl: options.sourceUrl } : {}),
        sourceSha,
      },
      metadata: {
        chunkerId: this.id,
        language,
        ...(options?.parentDocId !== undefined ? { parentDocId: options.parentDocId } : {}),
        chunkIndex: chunkIndex++,
      },
    });

    if (declarations.length === 0) {
      // No declarations found — return the whole document as one chunk.
      chunks.push(makeChunk(document, 0, lines.length - 1));
      return chunks;
    }

    // Preamble: text before the first declaration (imports, license headers, ...).
    // Stored UNtrimmed — every chunk's `text` is always the exact
    // `lines.slice(sourceStartLine, sourceEndLine + 1).join('\n')` slice of
    // the source, so downstream consumers can always reconstruct/verify
    // provenance byte-for-byte. Only whitespace-only spans are skipped
    // entirely (nothing worth its own chunk).
    const first = declarations[0]!;
    if (first.startLine > 0) {
      const preambleText = lines.slice(0, first.startLine).join('\n');
      if (preambleText.trim()) {
        chunks.push(makeChunk(preambleText, 0, first.startLine - 1));
      }
    }

    for (const decl of declarations) {
      const declLineCount = decl.endLine - decl.startLine + 1;

      if (declLineCount >= minLines) {
        // Emit any gap text between the previous chunk and this declaration
        // (e.g. blank lines, trailing comments, non-declaration statements).
        if (chunks.length > 0) {
          const prevEnd = chunks[chunks.length - 1]!.sourceMap.sourceEndLine;
          if (prevEnd < decl.startLine - 1) {
            const gapText = lines.slice(prevEnd + 1, decl.startLine).join('\n');
            if (gapText.trim()) {
              chunks.push(makeChunk(gapText, prevEnd + 1, decl.startLine - 1));
            }
          }
        }

        const text = lines.slice(decl.startLine, decl.endLine + 1).join('\n');
        chunks.push(makeChunk(text, decl.startLine, decl.endLine));
        continue;
      }

      // Short declaration — merge into the preceding chunk, or emit
      // standalone if it's the very first thing in the document. The merge
      // absorbs any intervening gap text too (blank lines, comments) so the
      // merged chunk stays a faithful, contiguous slice of the source: for
      // every chunk, `lines.slice(sourceStartLine, sourceEndLine + 1)` keeps
      // reconstructing exactly `text`.
      const prev = chunks[chunks.length - 1];
      if (prev) {
        const mergeStart = prev.sourceMap.sourceEndLine + 1;
        const mergedText = lines.slice(mergeStart, decl.endLine + 1).join('\n');
        prev.text += '\n' + mergedText;
        prev.sourceMap.sourceEndLine = decl.endLine;
      } else {
        const text = lines.slice(decl.startLine, decl.endLine + 1).join('\n');
        chunks.push(makeChunk(text, decl.startLine, decl.endLine));
      }
    }

    // Trailing text after the last emitted chunk (e.g. module-level code
    // following the final declaration) is not discarded — emit it as its
    // own chunk so the document is fully, losslessly partitioned.
    const last = chunks[chunks.length - 1];
    if (last) {
      const trailingStart = last.sourceMap.sourceEndLine + 1;
      if (trailingStart < lines.length) {
        const trailingText = lines.slice(trailingStart, lines.length).join('\n');
        if (trailingText.trim()) {
          chunks.push(makeChunk(trailingText, trailingStart, lines.length - 1));
        }
      }
    }

    return chunks;
  }

  estimate(document: string): number {
    if (!isSupportedAstLanguage(this.language)) return 1;
    const grammar = languageCache.get(this.language);
    if (!grammar) return 1;

    sharedParser.setLanguage(grammar);
    const tree = sharedParser.parse(document);
    if (!tree) return 1;

    const declarations = collectTopLevelDeclarations(tree.rootNode, this.language);
    return Math.max(declarations.length, 1);
  }
}
