/**
 * topic-prefix-shared-resolver.spec.ts
 *
 * Duplication guard: the E5 `[<topic>]`-prefix regex used to be hand-rolled
 * a second time in this file's `index.ts` (chunked `memory_write` handler),
 * duplicating the copy in `libs/memory-core/src/enrich.ts`. Behavioral
 * coverage that the resolved topic actually reaches every chunk lives in
 * `permission-guard.spec.ts` ("long content auto-chunks ... inheriting
 * topic/tags" for the explicit-topic-arg case, "auto-chunks resolve topic
 * from a `[prefix]` on content ... backlog 29f3a4d5 blocker 1" for the
 * prefix case) — the compiler already enforces that `resolveTopicFromPrefix`
 * is imported correctly. What neither of those catches is someone re-inlining
 * a second copy of the regex instead of calling the shared export, so that's
 * the one thing this file checks.
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
  it('no longer hand-rolls a second copy of the E5 prefix regex literal', () => {
    // Exactly the literal regex text that used to be duplicated by hand.
    // Its presence in index.ts (outside of this string constant) means
    // someone re-inlined the copy instead of calling the shared export.
    expect(indexSource.includes(E5_PREFIX_REGEX_SOURCE)).toBe(false);
  });
});
