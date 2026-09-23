/**
 * scripts/entrypoint-resolution-conformance.test.ts
 *
 * INVARIANT (the reason this file exists):
 *
 *   For every extension-directory shape, all FIVE implementations of
 *   "which single file inside this directory is the checksum anchor"
 *   resolve to the SAME relative path.
 *
 * `libs/install-engine/src/install.ts resolveEntrypointFile` is the AUTHORITY —
 * it is the copy that gates a real install. Two of the five copies WRITE the pin
 * that it later VERIFIES (`build-index.ts` generates `registry/index.json`;
 * `check-registry-sync.ts` mirrors it). A divergence between a writer and the
 * verifier is not untidiness: it is a `CHECKSUM MISMATCH` on every install of
 * the affected row — the exact outage class recorded in
 * `scripts/lib/published-bytes.ts:14-17`.
 *
 * It was live-latent at the time this test was written: `build-index.ts` and
 * `check-registry-sync.ts` omitted the `SKILL.md` probe that install.ts performs
 * (and that build-index's OWN comment claimed to implement), and neither
 * rejected an entrypoint escaping the extension dir. Masked only because no
 * shipped extension currently relies on the SKILL.md fallback — the next skill
 * scaffolded without an explicit `entrypoint` would have tripped it.
 *
 * A comment saying "keep these in sync" is what failed. This is the replacement.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A — AUTHORITY. Imported by RELATIVE SOURCE PATH, never by package name: root
// vitest.config.ts aliases '@adhd/sox-install-engine' to the BUILT dist, where a
// newly added export is invisible until a rebuild — so a package-name import
// here would silently test a STALE artifact instead of the source under review,
// which is precisely the class of blindness this test exists to remove. That is
// why the nx module-boundary rule is suppressed on this one line and nowhere else.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { resolveEntrypointFile as resolveA } from '../libs/install-engine/src/install.js';
// B — published-bytes gate (applied to an extracted npm package dir).
import { resolveEntrypointFromPackageDir as resolveB } from './lib/published-bytes.js';
// D — the generator that WRITES registry/index.json.
import { resolveEntrypointPath as resolveD } from './build-index.js';
// E — the read-only drift mirror of the generator.
import { resolveEntrypointPath as resolveE } from './check-registry-sync.js';
// C — the repin tool (CJS-style .mjs, no build step).
import { resolveEntrypointFile as resolveC } from '../tools/repin-registry-entry.mjs';

type Resolver = { name: string; resolve: (dir: string) => string };

function readManifest(dir: string): { entrypoint?: string } {
  const p = path.join(dir, 'extension.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as { entrypoint?: string };
  } catch {
    return {};
  }
}

// D and E take the already-parsed manifest; A, B and C read it off disk
// themselves. Adapt them to one signature so the comparison is apples-to-apples.
const RESOLVERS: Resolver[] = [
  { name: 'A install.ts (AUTHORITY)', resolve: (d) => resolveA(d) },
  { name: 'B published-bytes.ts', resolve: (d) => resolveB(d) },
  { name: 'C repin-registry-entry.mjs', resolve: (d) => resolveC(d) as string },
  { name: 'D build-index.ts', resolve: (d) => resolveD(d, readManifest(d)) },
  { name: 'E check-registry-sync.ts', resolve: (d) => resolveE(d, readManifest(d)) },
];

let scratch: string;

function fixture(name: string, files: Record<string, string>): string {
  const dir = path.join(scratch, name);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const manifest = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: 'fixture-ext', type: 'skill', title: 't', description: 'd', ...extra });

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-conformance-'));
});
afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('entrypoint resolution is identical across all five implementations', () => {
  const cases: Array<{ name: string; files: Record<string, string>; expected: string }> = [
    {
      name: 'explicit-entrypoint wins over every fallback',
      files: {
        'extension.json': manifest({ entrypoint: 'SKILL.md' }),
        'SKILL.md': '# skill',
        'dist/index.js': 'module.exports = {};',
        'prompt.md': '# prompt',
      },
      expected: 'SKILL.md',
    },
    {
      name: 'dist-only falls back to dist/index.js',
      files: { 'extension.json': manifest(), 'dist/index.js': 'module.exports = {};' },
      expected: path.join('dist', 'index.js'),
    },
    {
      name: 'prompt-only falls back to prompt.md',
      files: { 'extension.json': manifest(), 'prompt.md': '# prompt' },
      expected: 'prompt.md',
    },
    {
      // THE DIVERGENCE. install.ts hashes SKILL.md; build-index/check-registry-sync
      // used to hash extension.json — so the pin they wrote could never match the
      // bytes the install path verifies.
      name: 'skill-only falls back to SKILL.md (NOT extension.json)',
      files: { 'extension.json': manifest(), 'SKILL.md': '# skill' },
      expected: 'SKILL.md',
    },
    {
      name: 'prompt.md precedes SKILL.md when both are present',
      files: { 'extension.json': manifest(), 'prompt.md': '# prompt', 'SKILL.md': '# skill' },
      expected: 'prompt.md',
    },
    {
      name: 'bare manifest falls back to extension.json',
      files: { 'extension.json': manifest() },
      expected: 'extension.json',
    },
    {
      name: 'an unresolvable declared entrypoint falls through to the chain',
      files: { 'extension.json': manifest({ entrypoint: 'nope.js' }), 'prompt.md': '# prompt' },
      expected: 'prompt.md',
    },
    {
      name: 'an unparseable extension.json falls through to the chain',
      files: { 'extension.json': '{ not json', 'dist/index.js': 'module.exports = {};' },
      expected: path.join('dist', 'index.js'),
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const dir = fixture(c.name.replace(/[^a-z0-9]+/gi, '-'), c.files);
      const actual = Object.fromEntries(
        RESOLVERS.map((r) => [r.name, path.relative(dir, r.resolve(dir))]),
      );
      const expected = Object.fromEntries(RESOLVERS.map((r) => [r.name, c.expected]));
      // Compare NORMALIZED RELATIVE PATHS, never basenames: `dist/index.js` and a
      // root-level `index.js` share a basename, so a basename assertion would pass
      // straight through a real divergence.
      expect(actual).toEqual(expected);
    });
  }

  it('an entrypoint escaping the extension dir is REFUSED by every implementation', () => {
    const dir = fixture('escaping-entrypoint', {
      'extension.json': manifest({ entrypoint: '../outside/secret.md' }),
      'SKILL.md': '# skill',
    });
    fs.mkdirSync(path.join(scratch, 'escaping-entrypoint', '..', 'outside'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'outside', 'secret.md'), 'secret');

    const refused = Object.fromEntries(
      RESOLVERS.map((r) => {
        try {
          return [r.name, `RESOLVED:${path.relative(dir, r.resolve(dir))}`];
        } catch {
          return [r.name, 'THREW'];
        }
      }),
    );
    expect(refused).toEqual(Object.fromEntries(RESOLVERS.map((r) => [r.name, 'THREW'])));
  });
});
