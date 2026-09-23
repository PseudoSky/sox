/**
 * topic-prefix-shared-resolver.spec.ts
 *
 * Pins the E5 `[<topic>]`-prefix resolution used by memory-server's chunked
 * `memory_write` handler to the single shared `resolveTopicFromPrefix` export
 * in `@adhd/sox-memory-core` (also used by `computeWriteEnrichment`), so the
 * two call sites cannot silently diverge. This is a source-level guard, not a
 * behavioural one — the resolver's own behaviour is pinned in
 * `libs/memory-core/src/resolve-topic-from-prefix.spec.ts`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// CommonJS module (this project's tsconfig.json target) — __dirname is ambient.
const indexSource = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');

// The exact E5 prefix pattern (as it lives in libs/memory-core/src/enrich.ts).
// A literal occurrence of this pattern's source text in index.ts would mean a
// second hand-rolled copy has been reintroduced.
const E5_PREFIX_REGEX_SOURCE = String.raw`/^\s*\[([^\]\n]{1,64})\]/`;

describe('memory-server topic-prefix resolution uses the shared memory-core export', () => {
  it('imports resolveTopicFromPrefix from @adhd/sox-memory-core', () => {
    expect(indexSource).toMatch(/resolveTopicFromPrefix/);
    // The import must come from the package barrel, not a relative path into
    // memory-core's src (which would re-couple the two packages structurally).
    // [^}]* (not [\s\S]*?) so this cannot match past the FIRST `}` and latch
    // onto an unrelated earlier import block that happens to precede this one.
    const importBlockMatch = /import\s*\{([^}]*)\}\s*from\s*'@adhd\/sox-memory-core';/.exec(
      indexSource
    );
    expect(importBlockMatch).not.toBeNull();
    expect(importBlockMatch?.[1]).toMatch(/resolveTopicFromPrefix/);
  });

  it('calls resolveTopicFromPrefix at the chunked-write resolution site', () => {
    expect(indexSource).toMatch(/resolveTopicFromPrefix\(content\)/);
  });

  it('no longer hand-rolls a second copy of the E5 prefix regex literal', () => {
    // Exactly the literal regex text that used to be duplicated by hand.
    // Its presence in index.ts (outside of this string constant) means
    // someone re-inlined the copy instead of calling the shared export.
    expect(indexSource.includes(E5_PREFIX_REGEX_SOURCE)).toBe(false);
  });
});
