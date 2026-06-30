import { createHash } from 'node:crypto';
import type { Chunker, Chunk, ChunkerOptions } from './chunker-registry.js';
import { PermanentChunkingError } from './chunker-registry.js';

// ── Syntax-aware AST chunker ───────────────────────────────────────────────
//
// Implements a simplified cAST algorithm (code AST chunker):
// 1. Parse source code into lines
// 2. Detect top-level declarations (function, class, interface, etc.)
// 3. Preserve function/class boundaries — never split a declaration
// 4. Merge short adjacent declarations that fall below minFunctionLines
// 5. Attach source maps per chunk

interface Declaration {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'method' | 'block' | 'def';
  startLine: number;
  endLine: number;
}

const DECL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^(export\s+)?(async\s+)?function\s+\w+/,
    /^(export\s+)?class\s+\w+/,
    /^(export\s+)?interface\s+\w+/,
    /^(export\s+)?type\s+\w+\s*=/,
    /^(export\s+)?enum\s+\w+/,
    /^(export\s+)?abstract\s+class\s+\w+/,
    /^(export\s+)?const\s+\w+\s*[:=]\s*(\(|async|function)/,
  ],
  python: [
    /^def\s+\w+/,
    /^class\s+\w+/,
    /^async\s+def\s+\w+/,
    /^@\w+/,
  ],
  java: [
    /^\s*(public|private|protected|static)?\s*(class|interface|enum|record)\s+\w+/,
    /^\s*(public|private|protected)?\s*\w+\s+\w+\s*\(/,
  ],
  csharp: [
    /^\s*(public|private|protected|internal)?\s*(class|interface|struct|enum|record)\s+\w+/,
    /^\s*(public|private|protected|internal)?\s*\w+\s+\w+\s*\(/,
  ],
};

export class AstChunker implements Chunker {
  readonly id: string;
  readonly supportedLanguages: string[];
  private language: string;

  constructor(language: string) {
    this.language = language;
    this.id = `ast:treesitter:${language}`;
    this.supportedLanguages = [language];
  }

  chunk(document: string, options?: ChunkerOptions): Chunk[] {
    if (!DECL_PATTERNS[this.language]) {
      throw new PermanentChunkingError(
        `Unsupported language: ${this.language}`,
        this.id,
      );
    }

    const lines = document.split('\n');
    const patterns = DECL_PATTERNS[this.language]!;
    const minLines = options?.minFunctionLines ?? 3;
    const sourceSha = options?.sourceSha ?? createHash('sha256').update(document).digest('hex');
    const chunks: Chunk[] = [];
    let chunkIndex = 0;

    // Pre-scan for preamble emission — find first declaration line
    let firstDeclLine = -1;
    for (let j = 0; j < lines.length; j++) {
      const trimmed = lines[j]!.trim();
      if (trimmed && patterns.some((p) => p.test(trimmed))) {
        firstDeclLine = j;
        break;
      }
    }

    // Emit preamble (text before the first declaration)
    if (firstDeclLine > 0) {
      const preambleText = lines.slice(0, firstDeclLine).join('\n').trim();
      if (preambleText) {
        chunks.push({
          text: preambleText,
          sourceMap: {
            sourceStartLine: 0,
            sourceEndLine: firstDeclLine - 1,
            ...(options?.sourceUrl !== undefined ? { sourceUrl: options.sourceUrl } : {}),
            sourceSha,
          },
          metadata: {
            chunkerId: this.id,
            language: this.language,
            ...(options?.parentDocId !== undefined ? { parentDocId: options.parentDocId } : {}),
            chunkIndex: chunkIndex++,
          },
        });
      }
    }

    let i = 0;

    while (i < lines.length) {
      const line = lines[i]!;
      const trimmed = line.trim();

      // Skip leading blank lines
      if (!trimmed) {
        i++;
        continue;
      }

      // Check if this line starts a declaration
      const matchingPattern = patterns.find((p) => p.test(trimmed));

      if (matchingPattern) {
        const decl = this.extractDeclaration(lines, i);
        if (decl) {
          const declLines = decl.endLine - decl.startLine + 1;

          if (declLines >= minLines) {
            // Emit any preceding non-declaration lines as a standalone chunk
            if (i > 0 && chunks.length > 0) {
              const prevEnd = chunks[chunks.length - 1]!.sourceMap.sourceEndLine;
              if (prevEnd < decl.startLine - 1) {
                const text = lines.slice(prevEnd + 1, decl.startLine).join('\n').trim();
                if (text) {
                  chunks.push({
                    text,
                    sourceMap: {
                      sourceStartLine: prevEnd + 1,
                      sourceEndLine: decl.startLine - 1,
                      ...(options?.sourceUrl !== undefined ? { sourceUrl: options.sourceUrl } : {}),
                      sourceSha,
                    },
                    metadata: {
                      chunkerId: this.id,
                      language: this.language,
                      ...(options?.parentDocId !== undefined ? { parentDocId: options.parentDocId } : {}),
                      chunkIndex: chunkIndex++,
                    },
                  });
                }
              }
            }

            const text = lines.slice(decl.startLine, decl.endLine + 1).join('\n');
            chunks.push({
              text,
              sourceMap: {
                sourceStartLine: decl.startLine,
                sourceEndLine: decl.endLine,
                ...(options?.sourceUrl !== undefined ? { sourceUrl: options.sourceUrl } : {}),
                sourceSha,
              },
              metadata: {
                chunkerId: this.id,
                language: this.language,
                ...(options?.parentDocId !== undefined ? { parentDocId: options.parentDocId } : {}),
                chunkIndex: chunkIndex++,
              },
            });
            i = decl.endLine + 1;
            continue;
          }

          // Short declaration — merge into preceding chunk or emit standalone
          if (chunks.length > 0) {
            const prev = chunks[chunks.length - 1]!;
            const declText = lines.slice(decl.startLine, decl.endLine + 1).join('\n');
            prev.text += '\n' + declText;
            prev.sourceMap.sourceEndLine = decl.endLine;
          } else {
            // First declaration is short — still emit it as a chunk rather than dropping
            const text = lines.slice(decl.startLine, decl.endLine + 1).join('\n');
            chunks.push({
              text,
              sourceMap: {
                sourceStartLine: decl.startLine,
                sourceEndLine: decl.endLine,
                ...(options?.sourceUrl !== undefined ? { sourceUrl: options.sourceUrl } : {}),
                sourceSha,
              },
              metadata: {
                chunkerId: this.id,
                language: this.language,
                ...(options?.parentDocId !== undefined ? { parentDocId: options.parentDocId } : {}),
                chunkIndex: chunkIndex++,
              },
            });
          }
          i = decl.endLine + 1;
          continue;
        }
      }

      i++;
    }

    // If no declarations were found, return whole document as one chunk
    if (chunks.length === 0) {
      chunks.push({
        text: document,
        sourceMap: {
          sourceStartLine: 0,
          sourceEndLine: lines.length - 1,
          ...(options?.sourceUrl !== undefined ? { sourceUrl: options.sourceUrl } : {}),
          sourceSha,
        },
        metadata: {
          chunkerId: this.id,
          language: this.language,
          ...(options?.parentDocId !== undefined ? { parentDocId: options.parentDocId } : {}),
          chunkIndex: 0,
        },
      });
    }

    return chunks;
  }

  estimate(document: string): number {
    const lines = document.split('\n');
    const patterns = DECL_PATTERNS[this.language];
    if (!patterns) return 1;

    let count = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (patterns.some((p) => p.test(trimmed))) {
        count++;
      }
    }
    return Math.max(count, 1);
  }

  private extractDeclaration(
    lines: string[],
    startIdx: number,
  ): Declaration | null {
    const line = lines[startIdx]!;
    const trimmed = line.trim();

    const kindMatch =
      trimmed.match(/\b(function|class|interface|type|enum|struct|record|def)\b/);
    const kind = (kindMatch?.[1] as Declaration['kind']) ?? 'block';
    const nameMatch = trimmed.match(
      /(?:function|class|interface|type|enum|struct|record|def)\s+(\w+)/,
    );
    const name = nameMatch?.[1] ?? 'anonymous';

    let endIdx = startIdx;
    let foundOpen = false;

    if (this.language === 'python') {
      // Python uses indentation, not braces
      const baseIndent = lines[startIdx]!.search(/\S/);
      for (let j = startIdx + 1; j < lines.length; j++) {
        const l = lines[j]!;
        const trimmedLine = l.trim();

        // Blank lines continue the declaration
        if (!trimmedLine) {
          endIdx = j;
          continue;
        }

        const lineIndent = l.search(/\S/);

        // Decorator at same or lesser indent → belongs to next declaration
        if (lineIndent <= baseIndent && /^@\w/.test(trimmedLine)) {
          endIdx = j - 1;
          break;
        }

        // Line at same or lesser indent → boundary of this declaration
        if (lineIndent <= baseIndent) {
          endIdx = j - 1;
          break;
        }

        // Line inside the declaration body
        endIdx = j;
      }
    } else {
      // Brace-based languages — walk forward to find closing brace
      let depth = 0;
      for (let j = startIdx; j < lines.length; j++) {
        const l = lines[j]!;
        for (const ch of l) {
          if (ch === '{' || ch === '(') {
            depth++;
            foundOpen = true;
          } else if (ch === '}' || ch === ')') {
            depth--;
          }
        }
        if (foundOpen && depth <= 0 && j > startIdx) {
          endIdx = j;
          break;
        }
        endIdx = j;
      }
    }

    return {
      name,
      kind: kind === 'def' ? 'function' : kind,
      startLine: startIdx,
      endLine: endIdx,
    };
  }
}
