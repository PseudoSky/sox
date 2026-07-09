import type { Chunker, Chunk, ChunkerOptions } from './chunker-registry.js';
import { PermanentChunkingError } from './chunker-registry.js';
import { HeadingChunker } from './heading-chunker.js';
import { AstChunker, type SupportedAstLanguage } from './ast-chunker.js';

// ── Mixed-format chunker ─────────────────────────────────────────────────────
//
// Chunker selection strategy for mixed-format documents (e.g. a Markdown file
// with embedded TypeScript code blocks):
//
//   1. The heading chunker runs first (order: 0), producing section-level
//      chunks.
//   2. The AST chunker runs on any section detected as a fenced code block
//      (order: 1).
//   3. Heading chunks are the parent; AST chunks are nested children —
//      encoded, within the frozen `Chunk` shape, as: the AST child
//      immediately follows its parent heading chunk in the returned array,
//      and shares the parent's `metadata.heading` path. Headings that
//      contain no (supported) code blocks remain heading-only chunks.
//
// Fenced-code-block conventions supported per host syntax:
//   - markdown / mdx : ```lang␊ ... ␊```
//   - rst            : .. code-block:: lang␊␊    <indented block>
//   - asciidoc        : [source,lang]␊----␊ ... ␊----

const FENCE_LANGUAGE_ALIASES: Record<string, SupportedAstLanguage> = {
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'typescript',
  javascript: 'typescript',
  js: 'typescript',
  jsx: 'typescript',
  mjs: 'typescript',
  cjs: 'typescript',
  python: 'python',
  py: 'python',
  python3: 'python',
  java: 'java',
  csharp: 'csharp',
  'c#': 'csharp',
  cs: 'csharp',
};

/** Map a fenced code block's declared language tag to a supported AST
 *  chunker language. Returns `null` for unsupported/unrecognized/absent
 *  languages (the fence is then left un-chunked — heading text still
 *  covers it; graceful degradation, no crash). */
export function mapFenceLanguage(tag: string | undefined): SupportedAstLanguage | null {
  if (!tag) return null;
  return FENCE_LANGUAGE_ALIASES[tag.trim().toLowerCase()] ?? null;
}

export interface FencedCodeBlock {
  /** Raw language tag as written in the document (e.g. "ts", "python"). */
  languageTag: string | undefined;
  /** 0-based, inclusive — the first line of code content (excludes the opening fence marker). */
  codeStartLine: number;
  /** 0-based, inclusive — the last line of code content (excludes the closing fence marker). */
  codeEndLine: number;
}

const MARKDOWN_FENCE_OPEN = /^(\s*)```([\w+-]*)\s*$/;
const MARKDOWN_FENCE_CLOSE = /^\s*```\s*$/;

function extractMarkdownFences(lines: string[]): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const openMatch = lines[i]!.match(MARKDOWN_FENCE_OPEN);
    if (!openMatch) {
      i++;
      continue;
    }
    const languageTag = openMatch[2] || undefined;
    const codeStartLine = i + 1;
    let closeLine = -1;
    for (let j = codeStartLine; j < lines.length; j++) {
      if (MARKDOWN_FENCE_CLOSE.test(lines[j]!)) {
        closeLine = j;
        break;
      }
    }
    if (closeLine === -1) {
      // Unterminated fence — treat the remainder of the document as not fenced.
      break;
    }
    if (closeLine > codeStartLine - 1) {
      blocks.push({ languageTag, codeStartLine, codeEndLine: closeLine - 1 });
    } else {
      // Empty fence (open immediately followed by close) — nothing to chunk.
    }
    i = closeLine + 1;
  }
  return blocks;
}

const RST_CODE_BLOCK_DIRECTIVE = /^(\s*)\.\.\s+code-block::\s*(\S+)?\s*$/;

function extractRstFences(lines: string[]): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = lines[i]!.match(RST_CODE_BLOCK_DIRECTIVE);
    if (!match) {
      i++;
      continue;
    }
    const directiveIndent = match[1]!.length;
    const languageTag = match[2] || undefined;

    // Skip directive option lines (`:linenos:`, etc.) and blank lines
    // immediately following the directive, before the indented body begins.
    let j = i + 1;
    while (
      j < lines.length &&
      (lines[j]!.trim() === '' || /^\s*:\S+:/.test(lines[j]!))
    ) {
      j++;
    }

    const bodyStart = j;
    let bodyEnd = bodyStart - 1;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === '') {
        bodyEnd = j;
        continue;
      }
      const indent = line.search(/\S/);
      if (indent <= directiveIndent) break;
      bodyEnd = j;
    }

    // Trim trailing blank lines from the captured body.
    while (bodyEnd >= bodyStart && lines[bodyEnd]!.trim() === '') bodyEnd--;

    if (bodyEnd >= bodyStart) {
      blocks.push({ languageTag, codeStartLine: bodyStart, codeEndLine: bodyEnd });
    }
    i = Math.max(j, bodyStart);
  }
  return blocks;
}

const ASCIIDOC_SOURCE_DIRECTIVE = /^\[source,\s*([\w+-]*)\s*\]\s*$/;
const ASCIIDOC_DELIMITER = /^-{4,}\s*$/;

function extractAsciidocFences(lines: string[]): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = lines[i]!.match(ASCIIDOC_SOURCE_DIRECTIVE);
    if (!match) {
      i++;
      continue;
    }
    const languageTag = match[1] || undefined;

    let j = i + 1;
    if (j >= lines.length || !ASCIIDOC_DELIMITER.test(lines[j]!)) {
      // No opening delimiter follows — not a real fenced block.
      i++;
      continue;
    }
    const codeStartLine = j + 1;
    let closeLine = -1;
    for (let k = codeStartLine; k < lines.length; k++) {
      if (ASCIIDOC_DELIMITER.test(lines[k]!)) {
        closeLine = k;
        break;
      }
    }
    if (closeLine === -1) break;

    if (closeLine > codeStartLine - 1) {
      blocks.push({ languageTag, codeStartLine, codeEndLine: closeLine - 1 });
    }
    i = closeLine + 1;
  }
  return blocks;
}

/** Extract fenced code blocks from a document, using the fence convention
 *  appropriate to `syntax`. Returns absolute (document-relative) 0-based
 *  inclusive line ranges for the code content only (fence markers excluded).
 *  Unrecognized syntaxes yield no fences (graceful no-op). */
export function extractFencedCodeBlocks(document: string, syntax: string): FencedCodeBlock[] {
  const lines = document.split('\n');
  switch (syntax) {
    case 'markdown':
    case 'mdx':
      return extractMarkdownFences(lines);
    case 'rst':
      return extractRstFences(lines);
    case 'asciidoc':
      return extractAsciidocFences(lines);
    default:
      return [];
  }
}

const astChunkerCache = new Map<SupportedAstLanguage, AstChunker>();
function getAstChunker(language: SupportedAstLanguage): AstChunker {
  let chunker = astChunkerCache.get(language);
  if (!chunker) {
    chunker = new AstChunker(language);
    astChunkerCache.set(language, chunker);
  }
  return chunker;
}

export class MixedFormatChunker implements Chunker {
  readonly id: string;
  readonly supportedLanguages: string[];
  private readonly syntax: string;
  private readonly headingChunker: HeadingChunker;

  constructor(syntax: string) {
    this.syntax = syntax;
    this.id = `mixed:${syntax}`;
    this.supportedLanguages = [syntax];
    this.headingChunker = new HeadingChunker(syntax);
  }

  chunk(document: string, options?: ChunkerOptions): Chunk[] {
    if (!['markdown', 'mdx', 'rst', 'asciidoc'].includes(this.syntax)) {
      throw new PermanentChunkingError(`Unsupported mixed-format syntax: ${this.syntax}`, this.id);
    }

    // Order 0: heading chunker runs first, producing section-level parents.
    const headingChunks = this.headingChunker.chunk(document, options);

    const lines = document.split('\n');
    const fences = extractFencedCodeBlocks(document, this.syntax);

    const result: Chunk[] = [];

    for (const headingChunk of headingChunks) {
      result.push(headingChunk);

      // Order 1: AST chunker runs on any fenced code block that falls
      // within this heading section's line range.
      const fencesInSection = fences.filter(
        (f) =>
          f.codeStartLine >= headingChunk.sourceMap.sourceStartLine &&
          f.codeEndLine <= headingChunk.sourceMap.sourceEndLine,
      );

      for (const fence of fencesInSection) {
        const astLanguage = mapFenceLanguage(fence.languageTag);
        if (!astLanguage) continue; // unsupported/unknown language — heading text still covers it

        const codeText = lines.slice(fence.codeStartLine, fence.codeEndLine + 1).join('\n');
        if (!codeText.trim()) continue;

        const astChunker = getAstChunker(astLanguage);
        const childOptions: ChunkerOptions = {
          ...(options?.sourceUrl !== undefined ? { sourceUrl: options.sourceUrl } : {}),
          ...(options?.sourceSha !== undefined ? { sourceSha: options.sourceSha } : {}),
          ...(options?.parentDocId !== undefined ? { parentDocId: options.parentDocId } : {}),
          ...(options?.minFunctionLines !== undefined
            ? { minFunctionLines: options.minFunctionLines }
            : {}),
        };
        const codeChunks = astChunker.chunk(codeText, childOptions);

        for (const codeChunk of codeChunks) {
          // Remap line numbers from code-snippet-relative to
          // document-absolute (the snippet's line 0 is `fence.codeStartLine`
          // in the original document).
          codeChunk.sourceMap.sourceStartLine += fence.codeStartLine;
          codeChunk.sourceMap.sourceEndLine += fence.codeStartLine;
          // Nest under the parent heading: share its heading path so the
          // parent/child relationship is recoverable from the frozen Chunk
          // shape (adjacency in the returned array + shared heading path).
          if (headingChunk.metadata.heading !== undefined) {
            codeChunk.metadata.heading = headingChunk.metadata.heading;
          }
          result.push(codeChunk);
        }
      }
    }

    // Renumber chunkIndex sequentially across the whole merged, ordered result.
    result.forEach((c, idx) => {
      c.metadata.chunkIndex = idx;
    });

    return result;
  }

  estimate(document: string): number {
    if (!['markdown', 'mdx', 'rst', 'asciidoc'].includes(this.syntax)) return 1;
    const headingEstimate = this.headingChunker.estimate(document);
    const fences = extractFencedCodeBlocks(document, this.syntax);
    const lines = document.split('\n');

    let codeEstimate = 0;
    for (const fence of fences) {
      const astLanguage = mapFenceLanguage(fence.languageTag);
      if (!astLanguage) continue;
      const codeText = lines.slice(fence.codeStartLine, fence.codeEndLine + 1).join('\n');
      codeEstimate += getAstChunker(astLanguage).estimate(codeText);
    }

    return Math.max(headingEstimate + codeEstimate, 1);
  }
}
