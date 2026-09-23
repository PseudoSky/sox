/**
 * resolve-topic-from-prefix.spec.ts
 *
 * `resolveTopicFromPrefix` (enrich.ts) is the single E5 `[<topic>]`-prefix
 * resolver shared by `computeWriteEnrichment` (memory-core write path) and
 * the MCP `memory_write` chunked-write handler in memory-server
 * (extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts).
 * Before this refactor the same regex was hand-duplicated in both places
 * with nothing pinning them together (see the now-deleted "this duplicates
 * enrich.ts's E5 regex by hand" comment in memory-server's index.ts). This
 * suite pins the resolver's own behaviour AND, via computeWriteEnrichment,
 * that the write path's E5 precedence (explicit topic arg > prefix > null)
 * still holds through the extracted helper.
 */
import { describe, it, expect } from 'vitest';
import { resolveTopicFromPrefix, computeWriteEnrichment } from './enrich.js';

describe('resolveTopicFromPrefix', () => {
  it('extracts the topic from a well-formed leading [<topic>] prefix', () => {
    expect(resolveTopicFromPrefix('[project-planning] discussed the roadmap')).toBe(
      'project-planning'
    );
  });

  it('allows leading whitespace before the bracket', () => {
    expect(resolveTopicFromPrefix('   [topic] rest of content')).toBe('topic');
  });

  it('returns null when there is no prefix at all', () => {
    expect(resolveTopicFromPrefix('no prefix here, just content')).toBeNull();
  });

  it('matches a 63-char topic (within the {1,64} cap)', () => {
    const topic = 'a'.repeat(63);
    expect(resolveTopicFromPrefix(`[${topic}] content`)).toBe(topic);
  });

  it('matches a 64-char topic (exactly at the {1,64} cap)', () => {
    const topic = 'a'.repeat(64);
    expect(resolveTopicFromPrefix(`[${topic}] content`)).toBe(topic);
  });

  it('rejects malformed brackets: missing closing bracket', () => {
    expect(resolveTopicFromPrefix('[unterminated content with no close')).toBeNull();
  });

  it('rejects malformed brackets: missing opening bracket', () => {
    expect(resolveTopicFromPrefix('unopened] content')).toBeNull();
  });

  it('rejects an empty bracket pair (capture group requires 1-64 chars)', () => {
    expect(resolveTopicFromPrefix('[] empty prefix')).toBeNull();
  });

  it('rejects a bracket pair exceeding the 64-char cap (falls through to null)', () => {
    const tooLong = 'a'.repeat(65);
    expect(resolveTopicFromPrefix(`[${tooLong}] content`)).toBeNull();
  });

  it('does not match a bracket that is not at the start of content', () => {
    expect(resolveTopicFromPrefix('some text before [topic] the bracket')).toBeNull();
  });

  it('rejects a bracket pair containing a newline', () => {
    expect(resolveTopicFromPrefix('[topic\nwith-newline] content')).toBeNull();
  });
});

describe('computeWriteEnrichment E5 topic precedence (via the shared resolver)', () => {
  const base = {
    summary: undefined,
    tags: undefined,
    project_path: '/tmp/topic-test',
    importance: undefined,
  };

  it('explicit caller topic wins over a content prefix', () => {
    const result = computeWriteEnrichment({
      ...base,
      content: '[from-prefix] some content',
      topic: 'explicit-topic',
    });
    expect(result.topic).toBe('explicit-topic');
  });

  it('falls back to the content prefix when no explicit topic is supplied', () => {
    const result = computeWriteEnrichment({
      ...base,
      content: '[from-prefix] some content',
      topic: undefined,
    });
    expect(result.topic).toBe('from-prefix');
  });

  it('resolves to null when neither an explicit topic nor a prefix is present', () => {
    const result = computeWriteEnrichment({
      ...base,
      content: 'plain content, no prefix',
      topic: undefined,
    });
    expect(result.topic).toBeNull();
  });

  it('malformed brackets in content do not produce a topic', () => {
    const result = computeWriteEnrichment({
      ...base,
      content: '[malformed content with no close',
      topic: undefined,
    });
    expect(result.topic).toBeNull();
  });
});
