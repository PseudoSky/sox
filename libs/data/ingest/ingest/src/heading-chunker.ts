import { createHash } from 'node:crypto';
import type { Chunker, Chunk, ChunkerOptions } from './chunker-registry.js';
import { PermanentChunkingError } from './chunker-registry.js';

// ── Heading-aware chunker ──────────────────────────────────────────────────
//
// Splits documents on heading boundaries (h1, h2, ..., hN).
// Supported formats: Markdown, MDX, RST, AsciiDoc
// Produces parent-pointer back to document root for context reconstruction.

interface HeadingPattern {
  regex: RegExp;
  level: (match: RegExpMatchArray) => number;
}

const FORMAT_PATTERNS: Record<string, HeadingPattern[]> = {
  markdown: [
    { regex: /^#{1,6}\s+(.+)$/m, level: (m) => m[0]!.split('#').length - 1 },
  ],
  mdx: [
    { regex: /^#{1,6}\s+(.+)$/m, level: (m) => m[0]!.split('#').length - 1 },
  ],
  rst: [
    {
      regex: /^(.+)\n[=]+\s*$/m,
      level: () => 1,
    },
    {
      regex: /^(.+)\n[-]+\s*$/m,
      level: () => 2,
    },
  ],
  asciidoc: [
    { regex: /^={1,6}\s+(.+)$/m, level: (m) => m[0]!.split('=').length - 1 },
  ],
};

export class HeadingChunker implements Chunker {
  readonly id: string;
  readonly supportedLanguages: string[];
  private syntax: string;

  constructor(syntax: string) {
    this.syntax = syntax;
    this.id = `heading:${syntax}`;
    this.supportedLanguages = [syntax];
  }

  chunk(document: string, options?: ChunkerOptions): Chunk[] {
    const patterns = FORMAT_PATTERNS[this.syntax];
    if (!patterns) {
      throw new PermanentChunkingError(
        `Unsupported heading syntax: ${this.syntax}`,
        this.id,
      );
    }

    const lines = document.split('\n');
    const maxDepth = options?.maxHeadingDepth ?? 6;
    const sourceSha = options?.sourceSha ?? createHash('sha256').update(document).digest('hex');
    const chunks: Chunk[] = [];
    const headingStack: Array<{ text: string; line: number; depth: number }> = [];

    // Find all headings with their positions
    interface Heading {
      text: string;
      line: number;
      depth: number;
      level: number;
    }

    const headings: Heading[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // RST multi-line heading detection: underline (===== / -----) on its own line
      if (/^[=\-]{3,}\s*$/.test(line) && i > 0) {
        const prevLine = lines[i - 1]?.trim();
        if (prevLine) {
          const depth = line.startsWith('=') ? 1 : 2;
          headings.push({
            text: prevLine,
            line: i - 1,
            depth,
            level: depth,
          });
        }
        continue;
      }

      for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
          const level = pattern.level(match);
          if (level <= maxDepth) {
            headings.push({
              text: match[1]?.trim() ?? match[0]?.trim() ?? '',
              line: i,
              depth: level,
              level,
            });
          }
          break;
        }
      }
    }

    if (headings.length === 0) {
      // No headings found — return whole document as one chunk
      return [
        {
          text: document,
          sourceMap: {
            sourceStartLine: 0,
            sourceEndLine: lines.length - 1,
            ...(options?.sourceUrl !== undefined ? { sourceUrl: options.sourceUrl } : {}),
            sourceSha,
          },
          metadata: {
            chunkerId: this.id,
            language: this.syntax,
            ...(options?.parentDocId !== undefined ? { parentDocId: options.parentDocId } : {}),
            chunkIndex: 0,
            isHeadingRoot: true,
          },
        },
      ];
    }

    // Build heading path for each non-heading section
    const buildHeadingPath = (lineIdx: number): string => {
      const active: string[] = [];
      for (const h of headingStack) {
        if (h.line <= lineIdx) {
          active.push(h.text);
        }
      }
      return active.join(' > ');
    };

    // Emit preamble (text before the first heading)
    let chunkIndex = 0;
    if (headings[0]!.line > 0) {
      const preambleLines = lines.slice(0, headings[0]!.line);
      const preambleText = preambleLines.join('\n').trim();
      if (preambleText) {
        chunks.push({
          text: preambleText,
          sourceMap: {
            sourceStartLine: 0,
            sourceEndLine: headings[0]!.line - 1,
            ...(options?.sourceUrl !== undefined ? { sourceUrl: options.sourceUrl } : {}),
            sourceSha,
          },
          metadata: {
            chunkerId: this.id,
            language: this.syntax,
            ...(options?.parentDocId !== undefined ? { parentDocId: options.parentDocId } : {}),
            chunkIndex: chunkIndex++,
            isHeadingRoot: true,
          },
        });
      }
    }

    for (let hi = 0; hi < headings.length; hi++) {
      const current = headings[hi]!;
      const nextHeading = headings[hi + 1];

      // Update heading stack
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.depth >= current.depth) {
        headingStack.pop();
      }
      headingStack.push({ text: current.text, line: current.line, depth: current.depth });

      const startLine = current.line;
      const endLine = nextHeading ? nextHeading.line - 1 : lines.length - 1;
      const sectionLines = lines.slice(startLine, endLine + 1);

      // Skip if section is empty
      if (sectionLines.every((l) => !l.trim())) continue;

      const text = sectionLines.join('\n');
      const headingPath = buildHeadingPath(current.line);

      chunks.push({
        text,
        sourceMap: {
          sourceStartLine: startLine,
          sourceEndLine: endLine,
          ...(options?.sourceUrl !== undefined ? { sourceUrl: options.sourceUrl } : {}),
          sourceSha,
        },
        metadata: {
          chunkerId: this.id,
          language: this.syntax,
          heading: headingPath,
          ...(options?.parentDocId !== undefined ? { parentDocId: options.parentDocId } : {}),
          chunkIndex: chunkIndex++,
          isHeadingRoot: hi === 0,
        },
      });
    }

    return chunks;
  }

  estimate(document: string): number {
    const patterns = FORMAT_PATTERNS[this.syntax];
    if (!patterns) return 1;

    const lines = document.split('\n');
    let count = 0;
    for (const line of lines) {
      for (const pattern of patterns) {
        if (pattern.regex.test(line)) {
          count++;
          break;
        }
      }
    }
    return Math.max(count, 1);
  }
}
