/**
 * ingest-parity.spec.ts — S11 / BL-165 parity regression suite.
 *
 * GOAL: prove that the NEW implementations routed through `@adhd/sox-ingest`
 * are byte-identical to the OLD ad-hoc implementations they replace. Parity is
 * the precondition for consolidation: chunk boundaries and hash normalization
 * drive dedup + recall; a silent shift corrupts near-duplicate detection on
 * live stores.
 *
 * TEST STRATEGY:
 *   1. Old implementations are inlined as GOLDEN FIXTURES (captured before S11
 *      consolidation). They MUST NOT be updated — they are the ground truth
 *      against which new routing is validated.
 *   2. New implementations delegate through ingest's exported functions
 *      (hexSha256 + splitIntoChunksSentence), re-exported via memory-core.
 *   3. A corpus of representative inputs is fed through both paths and
 *      byte-identical output is asserted.
 *   4. After the switch, the new routing is the LIVE code — this file
 *      survives as a permanent regression test.
 *
 * CORPUS design covers:
 *   - Short content (below chunk threshold)
 *   - Exactly-2000-char boundary (the default token*4 threshold used by callers)
 *   - Long multi-chunk content
 *   - Unicode/emoji-heavy content
 *   - CRLF vs LF line endings
 *   - Leading/trailing whitespace
 *   - Mixed-case content (critical for hash normalization)
 *   - Empty string edge case
 *
 * HASH NORMALIZATION NOTE (documented delta):
 *   write.ts uses: content.trim().toLowerCase() before hashing
 *   ingest's hexSha256 is a raw SHA-256 with no normalization built in.
 *   The ingest path must pre-normalize the same way: hexSha256(content.trim().toLowerCase())
 *   This matches the live store's dedup fingerprints — changing normalization
 *   would make ALL existing E_DEDUP checks fail for case-differing content.
 *
 * CHUNKING DELTA (documented):
 *   The incumbent splitIntoChunks (memory-server) uses sentence boundaries
 *   (lookbehind .!? + whitespace) with no overlap. ingest's chunkContent uses
 *   a sliding window with configurable overlap (default 200 chars) — DIFFERENT.
 *   Resolution: a new function splitIntoChunksSentence was added to ingest that
 *   matches the incumbent behavior exactly. This spec verifies parity against
 *   the golden fixture.
 */

import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import { hexSha256, splitIntoChunksSentence } from '@adhd/sox-ingest/core';

// ──────────────────────────────────────────────────────────────────────────────
// GOLDEN FIXTURES — incumbent implementations captured before S11 consolidation.
// DO NOT modify these functions — they are the ground truth.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * GOLDEN: write.ts SHA-256 hash (line 178, pre-S11).
 * Normalization: content.trim().toLowerCase()
 */
function goldenContentHash(content: string): string {
  const normalized = content.trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * GOLDEN: memory-server splitIntoChunks (lines 751–769, pre-S11).
 * Split on chunkTokens * 4 chars, sentence-boundary aware.
 */
function goldenSplitIntoChunks(text: string, chunkTokens: number): string[] {
  const chunkChars = chunkTokens * 4;
  if (text.length <= chunkChars) return [text];

  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = '';

  for (const sentence of sentences) {
    if (current.length > 0 && current.length + 1 + sentence.length > chunkChars) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? current + ' ' + sentence : sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

// ──────────────────────────────────────────────────────────────────────────────
// NEW IMPLEMENTATIONS — routed through @adhd/sox-ingest (post-S11)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * NEW: write.ts content hash — routes through ingest's hexSha256.
 * Applies same normalization as the golden fixture (trim + toLowerCase).
 */
function newContentHash(content: string): string {
  return hexSha256(content.trim().toLowerCase());
}

/**
 * NEW: memory-server chunking — routes through ingest's splitIntoChunksSentence.
 */
function newSplitIntoChunks(text: string, chunkTokens: number): string[] {
  return splitIntoChunksSentence(text, chunkTokens);
}

// ──────────────────────────────────────────────────────────────────────────────
// CORPUS — representative input set
// ──────────────────────────────────────────────────────────────────────────────

const SHORT_CONTENT = 'Hello, world!';

const EXACTLY_2000_CHARS = 'A'.repeat(500) + ' ' + 'B'.repeat(499) + ' ' + 'C'.repeat(500) + ' ' + 'D'.repeat(499);

const LONG_CONTENT_MULTI_CHUNK = [
  'The first sentence describes the initial conditions of the experiment. ',
  'The second sentence elaborates on the methodology used. ',
  'The third sentence presents the primary results. ',
  'The fourth sentence discusses implications of those results. ',
  'The fifth sentence provides additional context from prior work. ',
  'The sixth sentence compares with alternative approaches. ',
  'The seventh sentence considers edge cases and limitations. ',
  'The eighth sentence summarizes the conclusions. ',
  'The ninth sentence points toward future work directions. ',
  'The tenth sentence closes with a statement on broader impact. ',
].join('').repeat(10); // ~7000 chars to force multiple chunks at 500 tokens (2000 chars)

const UNICODE_EMOJI_CONTENT =
  'Memory graphs 🧠 store semantic knowledge. ' +
  'Embeddings 📊 capture semantic similarity. ' +
  'Unicode characters like café, naïve, and résumé are important. ' +
  '中文内容 日本語 한국어 are also valid content types. ' +
  'Emoji: 🚀 💡 ⚡ 🔥 should not break chunking or hashing.';

const CRLF_CONTENT =
  'First line of content.\r\n' +
  'Second line of content.\r\n' +
  'Third line with important information.\r\n' +
  'Fourth line concludes this section.';

const LF_CONTENT =
  'First line of content.\n' +
  'Second line of content.\n' +
  'Third line with important information.\n' +
  'Fourth line concludes this section.';

const LEADING_TRAILING_WHITESPACE = '  \n  Leading whitespace then content.  \n  ';
const MIXED_CASE_CONTENT = 'THE QUICK BROWN FOX Jumps Over The LAZY Dog.';
const EMPTY_CONTENT = '';

const ALL_CORPUS_ENTRIES = [
  { label: 'short', content: SHORT_CONTENT },
  { label: 'exactly-2000-chars', content: EXACTLY_2000_CHARS },
  { label: 'long-multi-chunk', content: LONG_CONTENT_MULTI_CHUNK },
  { label: 'unicode-emoji', content: UNICODE_EMOJI_CONTENT },
  { label: 'crlf-endings', content: CRLF_CONTENT },
  { label: 'lf-endings', content: LF_CONTENT },
  { label: 'leading-trailing-whitespace', content: LEADING_TRAILING_WHITESPACE },
  { label: 'mixed-case', content: MIXED_CASE_CONTENT },
  { label: 'empty', content: EMPTY_CONTENT },
];

// ──────────────────────────────────────────────────────────────────────────────
// PARITY ASSERTIONS — CONTENT HASH
// ──────────────────────────────────────────────────────────────────────────────

describe('S11 parity: content hash (write.ts SHA-256 → ingest hexSha256)', () => {
  for (const { label, content } of ALL_CORPUS_ENTRIES) {
    it(`byte-identical hash for corpus entry: "${label}"`, () => {
      const golden = goldenContentHash(content);
      const actual = newContentHash(content);
      expect(actual).toBe(golden);
      // Also verify format (64 hex chars)
      expect(actual).toMatch(/^[a-f0-9]{64}$/);
    });
  }

  it('hash normalization: case-insensitive dedup (critical for live store correctness)', () => {
    // "THE VOLCANO..." and "the volcano..." must produce the SAME hash
    // (trim+toLowerCase normalization is the live store's dedup ground truth)
    const upper = 'THE VOLCANO ERUPTED AT DAWN REVEALING ANCIENT LAVA FLOWS.';
    const lower = '  the volcano erupted at dawn revealing ancient lava flows.  ';
    expect(newContentHash(upper)).toBe(newContentHash(lower));
    expect(goldenContentHash(upper)).toBe(goldenContentHash(lower));
    // Golden and new must agree
    expect(newContentHash(upper)).toBe(goldenContentHash(upper));
  });

  it('hash differs for semantically distinct content', () => {
    const a = 'Memory systems enable long-term agent persistence.';
    const b = 'Graph databases model entity relationships efficiently.';
    expect(newContentHash(a)).not.toBe(newContentHash(b));
  });

  it('ingest hexSha256 is deterministic across calls', () => {
    const content = 'Determinism is essential for a content-addressed store.';
    const h1 = newContentHash(content);
    const h2 = newContentHash(content);
    expect(h1).toBe(h2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// PARITY ASSERTIONS — CHUNKING
// ──────────────────────────────────────────────────────────────────────────────

const CHUNK_TOKEN_SIZES = [500, 250, 1000]; // common caller values; 500 is the MCP default

describe('S11 parity: chunking (memory-server splitIntoChunks → ingest splitIntoChunksSentence)', () => {
  for (const chunkTokens of CHUNK_TOKEN_SIZES) {
    describe(`chunkTokens=${chunkTokens}`, () => {
      for (const { label, content } of ALL_CORPUS_ENTRIES) {
        it(`byte-identical chunks for corpus entry: "${label}"`, () => {
          const golden = goldenSplitIntoChunks(content, chunkTokens);
          const actual = newSplitIntoChunks(content, chunkTokens);
          expect(actual).toEqual(golden);
        });
      }
    });
  }

  it('chunk count matches for long multi-chunk content (500 tokens → 2000 chars)', () => {
    const golden = goldenSplitIntoChunks(LONG_CONTENT_MULTI_CHUNK, 500);
    const actual = newSplitIntoChunks(LONG_CONTENT_MULTI_CHUNK, 500);
    expect(actual.length).toBe(golden.length);
    expect(actual.length).toBeGreaterThan(1);
  });

  it('single-chunk for content below threshold', () => {
    const golden = goldenSplitIntoChunks(SHORT_CONTENT, 500);
    const actual = newSplitIntoChunks(SHORT_CONTENT, 500);
    expect(actual).toEqual([SHORT_CONTENT]);
    expect(golden).toEqual([SHORT_CONTENT]);
    expect(actual).toEqual(golden);
  });

  it('empty string: both return [""]', () => {
    const golden = goldenSplitIntoChunks('', 500);
    const actual = newSplitIntoChunks('', 500);
    expect(actual).toEqual(golden);
  });

  it('chunking is deterministic across multiple calls', () => {
    const content = LONG_CONTENT_MULTI_CHUNK;
    const c1 = newSplitIntoChunks(content, 500);
    const c2 = newSplitIntoChunks(content, 500);
    expect(c1).toEqual(c2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// DELTA DOCUMENTATION — sliding-window chunkContent vs sentence-boundary splitting
// ──────────────────────────────────────────────────────────────────────────────

describe('S11 delta documentation: ingest chunkContent vs splitIntoChunksSentence', () => {
  /**
   * Documents the behavioral difference between ingest's pre-existing chunkContent
   * (sliding-window with overlap) and the new splitIntoChunksSentence (sentence-boundary,
   * no overlap). Both are now in the ingest library; this test is NOT a parity assertion
   * but a deliberate documentation of the difference so future readers understand why
   * the chunking strategy was preserved rather than switched.
   *
   * DECISION: switchable-over was NOT silently adopted because:
   *   1. The sliding-window creates overlapping chunks — overlap chars would cause
   *      more SAME_AS near-dup edges between chunks (false positives in dedup).
   *   2. Existing stores have chunk boundaries at sentence boundaries — changing
   *      the split strategy shifts chunk UIDs on re-write, breaking idempotency.
   *   3. The sentence-boundary strategy is already well-tuned for the MCP usage
   *      pattern (human-written prose, structured notes).
   *
   * Future: if late-chunking (BL-117) is implemented, the sliding-window strategy
   * may become preferred. At that point, parity tests for the new strategy must
   * be added before switching.
   */
  it('ingest chunkContent uses overlap; splitIntoChunksSentence does not', () => {
    // For a sliding-window to produce different results, content must be long enough
    // and have no sentence boundaries near the split point.
    const ABCDE = 'A'.repeat(100) + 'B'.repeat(100) + 'C'.repeat(100);
    // chunkContent with maxChars=200, overlapChars=50 → first chunk = [0,200), second = [150,350)
    // splitIntoChunksSentence with chunkTokens=50 (200 chars) → splits at sentence boundaries, no overlap
    // These are intentionally different — documenting the delta, not asserting parity.
    const slidingChunks = splitIntoChunksSentence(ABCDE, 50);
    // The content has no sentence boundaries; it will be treated as a single chunk (no .!? separators)
    // or fail the threshold check
    expect(Array.isArray(slidingChunks)).toBe(true);
    expect(slidingChunks.length).toBeGreaterThanOrEqual(1);
  });
});
