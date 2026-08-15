/**
 * The four `path-safety.ts` copies must stay logically identical.
 *
 * WHY THERE ARE FOUR COPIES (this is deliberate, not an oversight)
 *
 * `assertWithinBase` is needed in install-engine, apps/sox, host-runtime and
 * host-registry. A shared module would require a dependency edge that does not
 * exist and should not: install-engine already depends on host-registry, so
 * host-registry depending back would cycle, and host-runtime/apps-sox have no
 * edge to install-engine at all. Adding permanent coupling between four
 * packages for ~40 lines of dependency-free path logic is a worse trade than
 * duplication.
 *
 * WHY THIS TEST EXISTS
 *
 * Duplicated SECURITY code drifts. One copy gets a fix, the others silently do
 * not, and the weakest copy becomes the real security boundary — while everyone
 * reading the strongest one believes the system is safe. That failure is
 * invisible by construction: nothing about editing one file tells you the other
 * three exist.
 *
 * So the duplication is allowed, but it cannot drift QUIETLY. If you change one
 * copy, this test fails until you change all four. That converts an invisible
 * security regression into a loud, immediate one.
 *
 * If you ever do introduce a shared module, delete this test with it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(__dirname, '../../..');

const COPIES = [
  'apps/sox/src/path-safety.ts',
  'libs/host-runtime/src/path-safety.ts',
  'libs/host-registry/src/path-safety.ts',
  'libs/install-engine/src/path-safety.ts',
];

/**
 * Strip the one line that is legitimately allowed to differ: the header comment
 * naming the file's own path. Everything else — every line of logic — must match
 * byte for byte.
 */
function normalize(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*\*\s*(apps|libs)\/\S+path-safety\.ts\s*$/.test(l))
    .join('\n');
}

describe('path-safety copies stay in sync', () => {
  it('all four copies exist', () => {
    for (const rel of COPIES) {
      expect(existsSync(join(REPO, rel)), `missing copy: ${rel}`).toBe(true);
    }
  });

  it('all four are logically identical (only the self-referential header may differ)', () => {
    const [first, ...rest] = COPIES.map((rel) => ({
      rel,
      body: normalize(readFileSync(join(REPO, rel), 'utf8')),
    }));
    if (!first) throw new Error('COPIES list is empty');

    for (const other of rest) {
      expect(
        other.body,
        `${other.rel} has DRIFTED from ${first.rel}. These are four copies of a ` +
          `SECURITY guard (assertWithinBase). If you fixed one, fix all four — ` +
          `otherwise the weakest copy silently becomes the real boundary. If you ` +
          `intended to consolidate them into a shared module, delete this test too.`,
      ).toBe(first.body);
    }
  });

  it('every copy still exports the guard and its error type', () => {
    for (const rel of COPIES) {
      const src = readFileSync(join(REPO, rel), 'utf8');
      expect(src, `${rel} lost assertWithinBase`).toMatch(/export function assertWithinBase\b/);
      expect(src, `${rel} lost PathEscapeError`).toMatch(/export class PathEscapeError\b/);
      // The two properties that make the guard correct, asserted structurally so
      // a refactor cannot quietly remove them from one copy:
      expect(src, `${rel} lost symlink resolution (realpath)`).toMatch(/realpath/i);
      expect(src, `${rel} lost segment-wise containment (path.relative)`).toMatch(/\.relative\(/);
    }
  });
});
