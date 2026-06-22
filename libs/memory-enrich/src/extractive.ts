/**
 * extractive.ts — lead-N extractive summary (E10).
 * CONTRACTS.md C1.7, DESIGN.md D2 E10.
 *
 * Determinism: same input → same output. Pure function, no DB, no I/O.
 * TODO (Phase 2): replace lead-N with TextRank per D2 E10.
 */

/**
 * Produce an extractive summary of content (E10).
 *
 * Phase 1 strategy: lead-N sentences (2 sentences).
 * Sentence boundary: `.`, `?`, `!` followed by whitespace + capital letter, or newline.
 * If content < 100 chars: return content as-is.
 * Only applied when no caller summary is provided (E2 takes priority).
 */
export function extractiveSummary(content: string): string {
  if (content.length < 100) return content;

  // Split on sentence boundaries: punctuation followed by whitespace+capital, or newlines.
  // We use a manual scan to avoid lookahead (not available in all envs).
  const sentences = splitIntoSentences(content);

  const lead = sentences.slice(0, 2);
  if (lead.length === 0) return content;

  const result = lead.join(' ').trim();
  return result.length > 0 ? result : content;
}

/**
 * Split text into sentences.
 * Boundary: `.`, `?`, `!` followed by whitespace + a capital letter, or a newline.
 * Returns non-empty sentence strings.
 */
function splitIntoSentences(text: string): string[] {
  // Split at newlines first, then at sentence-ending punctuation
  const lines = text.split(/\n+/);
  const sentences: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Split on `. `, `? `, `! ` followed by uppercase letter (lookahead via split+rejoin)
    const parts = trimmed.split(/(?<=[.?!])\s+(?=[A-Z])/);
    for (const part of parts) {
      const p = part.trim();
      if (p) sentences.push(p);
    }
  }

  return sentences;
}
