import { describe, it, expect } from 'vitest';
import { ingest, hexSha256, splitIntoChunksSentence } from './index.js';

describe('ingest()', () => {
  describe('contentHash', () => {
    it('produces a 64-char lowercase hex string', () => {
      const result = ingest('hello world');
      expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is deterministic — same input, same hash', () => {
      const a = ingest('hello world');
      const b = ingest('hello world');
      expect(a.contentHash).toBe(b.contentHash);
    });

    it('normalizes whitespace before hashing', () => {
      const a = ingest('hello   world');
      const b = ingest('hello world');
      expect(a.contentHash).toBe(b.contentHash);
    });

    it('normalizes leading/trailing whitespace', () => {
      const a = ingest('  hello world  ');
      const b = ingest('hello world');
      expect(a.contentHash).toBe(b.contentHash);
    });

    it('differs for different content', () => {
      const a = ingest('hello');
      const b = ingest('world');
      expect(a.contentHash).not.toBe(b.contentHash);
    });

    it('handles empty content', () => {
      const result = ingest('');
      expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('extractive summary', () => {
    it('returns up to 3 sentences by default', () => {
      const content = [
        'First important finding discovered today along with extensive supporting evidence.',
        'Second significant result confirmed by multiple independent verification methods.',
        'Third key insight emerged clearly from the comprehensive data analysis pipeline.',
        'Fourth minor observation noted during routine background processing steps.',
        'Fifth trivial detail recorded in the standard housekeeping procedures.',
      ].join(' ');
      const result = ingest(content);
      expect(result.summary).toContain('First important finding');
      expect(result.summary).toContain('Second significant result');
      expect(result.summary).toContain('Third key insight');
      expect(result.summary).not.toContain('Fourth minor');
    });

    it('respects summaryMaxSentences', () => {
      const content = [
        'One major discovery published today along with detailed supporting analysis.',
        'Two additional findings confirmed by rigorous independent verification.',
        'Three unexpected results emerged during the comprehensive investigation.',
        'Four routine checks completed successfully across all operating systems.',
      ].join(' ');
      const result = ingest(content, { summaryMaxSentences: 2 });
      expect(result.summary).toContain('One major');
      expect(result.summary).toContain('Two additional');
      expect(result.summary).not.toContain('Three unexpected');
    });

    it('respects summaryMaxSentences = 1', () => {
      const content = [
        'Alpha priority alert triggered. Immediate attention is required for this issue.',
        'Beta secondary notice filed. Standard processing will handle this.',
        'Gamma routine check completed. No action is needed at this time.',
      ].join(' ');
      const result = ingest(content, { summaryMaxSentences: 1 });
      expect(result.summary).toContain('Alpha priority');
      expect(result.summary).not.toContain('Beta secondary');
    });

    it('returns content as-is when shorter than 100 chars', () => {
      const content = 'short text';
      const result = ingest(content);
      expect(result.summary).toBe('short text');
    });

    it('returns all sentences when fewer than maxSentences exist', () => {
      const content = 'Only one sentence here.';
      const result = ingest(content, { summaryMaxSentences: 5 });
      expect(result.summary).toContain('Only one sentence here');
    });

    it('splits on newlines as sentence boundaries', () => {
      const content = [
        'Line one important discovery noted here. Additional details confirm the finding.',
        'Line two significant finding observed. Further evidence supports this conclusion.',
        'Line three key insight emerged. The data points to a clear pattern.',
        'Line four minor note recorded. Background information only.',
        'Line five trivial detail logged. Routine housekeeping entry.',
        'Line six routine check completed. Standard operating procedure.',
      ].join('\n');
      const result = ingest(content, { summaryMaxSentences: 3 });
      expect(result.summary).toContain('Line one');
      expect(result.summary).toContain('Line two');
      expect(result.summary).not.toContain('Line three');
      expect(result.summary).not.toContain('Line four');
    });
  });

  describe('tag extraction', () => {
    it('returns at most 10 tags by default', () => {
      const content = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
      const result = ingest(content);
      expect(result.tags.length).toBeLessThanOrEqual(10);
    });

    it('respects tagMaxCount', () => {
      const content = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
      const result = ingest(content, { tagMaxCount: 5 });
      expect(result.tags.length).toBeLessThanOrEqual(5);
    });

    it('does not include stopwords', () => {
      const content = 'the and for with that this are was were from have has had not but all can been';
      const result = ingest(content);
      expect(result.tags.length).toBe(0);
    });

    it('only includes words longer than 3 characters', () => {
      const content = 'a an the cat dog big small enormous tremendous';
      const result = ingest(content);
      for (const tag of result.tags) {
        expect(tag.length).toBeGreaterThan(3);
      }
    });

    it('tags are sorted by frequency (most frequent first)', () => {
      const content = 'machine machine machine learning learning data';
      const result = ingest(content);
      const machineIdx = result.tags.indexOf('machine');
      const learningIdx = result.tags.indexOf('learning');
      expect(machineIdx).toBe(0);
      expect(learningIdx).toBe(1);
    });

    it('returns lowercase tags', () => {
      const result = ingest('Machine Learning ARTIFICIAL Intelligence');
      for (const tag of result.tags) {
        expect(tag).toBe(tag.toLowerCase());
      }
    });

    it('handles punctuation in content', () => {
      const content = 'machine-learning, artificial.intelligence; deep+learning';
      const result = ingest(content);
      expect(result.tags).toContain('machine');
      expect(result.tags).toContain('learning');
      expect(result.tags).toContain('artificial');
      expect(result.tags).toContain('intelligence');
      expect(result.tags).toContain('deep');
    });

    it('handles empty content', () => {
      const result = ingest('');
      expect(result.tags).toEqual([]);
    });
  });

  describe('chunking', () => {
    it('does not include chunks when opts.chunk is not set', () => {
      const content = 'word '.repeat(600);
      const result = ingest(content);
      expect(result.chunks).toBeUndefined();
    });

    it('chunks long content with default maxChars and overlap', () => {
      const content = 'word '.repeat(600);
      const result = ingest(content, { chunk: {} });
      expect(result.chunks).toBeDefined();
      const chunks = result.chunks!;
      expect(chunks.length).toBeGreaterThan(1);
      for (let i = 0; i < chunks.length; i++) {
        // Was `if (chunk) { ...4 assertions... }` — a noUncheckedIndexedAccess guard that
        // also skipped every assertion in exactly the case (a hole in the array) that
        // would have made them worth running. `i < chunks.length`, so `!` is the honest
        // spelling: a missing element now fails here rather than passing silently.
        const chunk = chunks[i]!;
        expect(chunk.index).toBe(i);
        expect(chunk.content).toBeTruthy();
        expect(chunk.contentHash).toMatch(/^[a-f0-9]{64}$/);
        expect(chunk.charOffset).toBeGreaterThanOrEqual(0);
      }
    });

    it('respects custom maxChars and overlapChars', () => {
      const content = 'word '.repeat(100);
      const result = ingest(content, { chunk: { maxChars: 50, overlapChars: 10 } });
      expect(result.chunks).toBeDefined();
      expect(result.chunks!.length).toBeGreaterThan(1);
      for (const chunk of result.chunks!) {
        expect(chunk.content.length).toBeLessThanOrEqual(50);
      }
    });

    it('each chunk has a unique contentHash', () => {
      const words = Array.from({ length: 200 }, (_, i) => `unique_term_${i}`);
      const content = words.join(' ');
      const result = ingest(content, { chunk: { maxChars: 50, overlapChars: 0 } });
      expect(result.chunks).toBeDefined();
      const hashes = result.chunks!.map(c => c.contentHash);
      expect(new Set(hashes).size).toBe(hashes.length);
    });

    it('charOffset increases monotonically', () => {
      const content = 'word '.repeat(100);
      const result = ingest(content, { chunk: { maxChars: 50, overlapChars: 5 } });
      expect(result.chunks).toBeDefined();
      let prev = -1;
      for (const chunk of result.chunks!) {
        expect(chunk.charOffset).toBeGreaterThan(prev);
        prev = chunk.charOffset;
      }
    });

    it('chunks have correct overlap — adjacent chunks share overlapChars chars', () => {
      const content = 'abcdefghij'.repeat(20);
      const maxChars = 50;
      const overlapChars = 10;
      const result = ingest(content, { chunk: { maxChars, overlapChars } });
      expect(result.chunks).toBeDefined();
      const chunks = result.chunks!;
      for (let i = 1; i < chunks.length; i++) {
        const prevEnd = chunks[i - 1]!.content;
        const currStart = chunks[i]!.content;
        const expectedOverlap = prevEnd.slice(-overlapChars);
        expect(currStart.slice(0, overlapChars)).toBe(expectedOverlap);
      }
    });

    it('single chunk when content is shorter than maxChars', () => {
      const content = 'short content';
      const result = ingest(content, { chunk: { maxChars: 1000 } });
      expect(result.chunks).toBeDefined();
      expect(result.chunks!.length).toBe(1);
      expect(result.chunks![0]!.content).toBe(content);
      expect(result.chunks![0]!.index).toBe(0);
      expect(result.chunks![0]!.charOffset).toBe(0);
    });

    it('single chunk when overlapChars >= maxChars', () => {
      const content = 'word '.repeat(100);
      const result = ingest(content, { chunk: { maxChars: 50, overlapChars: 50 } });
      expect(result.chunks).toBeDefined();
      expect(result.chunks!.length).toBe(1);
    });
  });

  describe('deterministic / byte-reproducible', () => {
    it('same input with same opts yields identical result', () => {
      const content = 'The quick brown fox jumps over the lazy dog. A second sentence here. And a third one.';
      const opts = { chunk: { maxChars: 50, overlapChars: 10 }, summaryMaxSentences: 2, tagMaxCount: 5 } as const;
      const a = ingest(content, opts);
      const b = ingest(content, opts);
      expect(a).toEqual(b);
    });

    it('same input without opts yields identical result', () => {
      const a = ingest('deterministic test content');
      const b = ingest('deterministic test content');
      expect(a).toEqual(b);
    });

    it('different content yields different contentHash', () => {
      const a = ingest('hello');
      const b = ingest('world');
      expect(a.contentHash).not.toBe(b.contentHash);
    });

    it('multiple calls always produce the same output', () => {
      const content = 'Consistency. Is key. For memory. Graphs. To function. Correctly.';
      const first = ingest(content);
      for (let i = 0; i < 10; i++) {
        expect(ingest(content)).toEqual(first);
      }
    });
  });

  describe('unified ingest()', () => {
    it('returns all required fields', () => {
      const result = ingest('Hello world. This is a test.');
      expect(result).toHaveProperty('contentHash');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('tags');
      expect(typeof result.contentHash).toBe('string');
      expect(typeof result.summary).toBe('string');
      expect(Array.isArray(result.tags)).toBe(true);
    });

    it('returns chunks only when opts.chunk is specified', () => {
      const without = ingest('some content');
      expect(without.chunks).toBeUndefined();

      const withChunks = ingest('some content', { chunk: {} });
      expect(withChunks.chunks).toBeDefined();
    });

    it('contentHash is the hash of the full normalized content, not of chunks', () => {
      const content = 'word '.repeat(600);
      const result = ingest(content, { chunk: {} });
      const fullHash = result.contentHash;
      const chunkHashes = result.chunks!.map(c => c.contentHash);
      for (const ch of chunkHashes) {
        expect(ch).not.toBe(fullHash);
      }
    });
  });
});

// ── S11 / BL-165: new canonical exports ──────────────────────────────────────

describe('hexSha256() — canonical content hash (S11 / BL-165)', () => {
  it('returns a 64-char lowercase hex string', () => {
    expect(hexSha256('hello world')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    const h1 = hexSha256('deterministic input');
    const h2 = hexSha256('deterministic input');
    expect(h1).toBe(h2);
  });

  it('differs for different inputs', () => {
    expect(hexSha256('a')).not.toBe(hexSha256('b'));
  });

  it('does NOT normalize — caller owns normalization', () => {
    // Uppercase and lowercase produce DIFFERENT digests (no auto-lowercase).
    // write.ts applies trim().toLowerCase() before calling hexSha256.
    expect(hexSha256('HELLO')).not.toBe(hexSha256('hello'));
  });

  it('handles empty string without throwing', () => {
    expect(hexSha256('')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('splitIntoChunksSentence() — canonical sentence-boundary chunker (S11 / BL-165)', () => {
  it('returns [text] when content is below threshold', () => {
    expect(splitIntoChunksSentence('Short text.', 500)).toEqual(['Short text.']);
  });

  it('splits long content at sentence boundaries', () => {
    const sentences = Array.from({ length: 30 }, (_, i) => `Sentence ${i} ends here.`);
    const text = sentences.join(' ');
    const chunks = splitIntoChunksSentence(text, 10); // 10*4=40 chars threshold
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    const text = 'Alpha sentence here. Beta sentence there. Gamma sentence everywhere.'.repeat(20);
    const c1 = splitIntoChunksSentence(text, 50);
    const c2 = splitIntoChunksSentence(text, 50);
    expect(c1).toEqual(c2);
  });

  it('chunkTokens * 4 is the character threshold', () => {
    // A string of exactly 2000 chars should return a single chunk at chunkTokens=500
    const text = 'A'.repeat(2000);
    expect(splitIntoChunksSentence(text, 500)).toEqual([text]);
  });

  it('returns [""] for empty string', () => {
    expect(splitIntoChunksSentence('', 500)).toEqual(['']);
  });

  it('trims trailing whitespace from each chunk', () => {
    const text = 'First sentence ends here.   Second sentence ends there.   '.repeat(30);
    const chunks = splitIntoChunksSentence(text, 10);
    for (const chunk of chunks) {
      expect(chunk).toBe(chunk.trim() === '' ? chunk : chunk.trimEnd());
    }
  });
});
