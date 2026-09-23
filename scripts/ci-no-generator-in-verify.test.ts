/**
 * scripts/ci-no-generator-in-verify.test.ts
 *
 * INVARIANT:
 *
 *   No VERIFICATION workflow regenerates registry/index.json.
 *   `.github/workflows/{ci,validate}.yml` contain zero EXECUTABLE `run:` lines
 *   invoking `build-index`, `sync-index` or `release:prepared`. Comments that
 *   explain the retired gate are permitted and expected.
 *
 * WHY: both workflows used to carry a step that ran `pnpm build-index` and then
 * `git diff --exit-code registry/index.json`, failing with
 * "registry/index.json is stale — run 'pnpm build-index' and commit."
 *
 * That is not a drift gate, it is the outage procedure encoded as CI guidance.
 * `build-index` re-derives every row's `source` into file://  / jsdelivr
 * locators and re-pins every `checksum` from LOCAL DISK BYTES — the exact
 * mechanism recorded in scripts/lib/published-bytes.ts:14-17 as the cause of the
 * CHECKSUM MISMATCH outage. Its remediation message instructed developers to
 * commit that result, which replaces the committed 6-row publication pin with
 * 31 file:// rows.
 *
 * The step could also never have passed: measured read-only, the disk walk
 * yields 31 rows against the registry's 6, plus differing content on all six
 * pinned rows, because `resolveSource` can only emit `npm-package:` locators
 * under SOX_REGISTRY_PUBLISH — a release-path signal that CI does not set. So
 * the invariant it asserted (registry == disk walk) is not merely unsatisfiable,
 * it is the WRONG invariant: the registry is a publication pin, not a mirror
 * of the working tree.
 *
 * What replaced it: the published-bytes gate (every npm-package: row's checksum
 * equals what npm serves — already 6/6) plus the coverage gate
 * (registry/published-coverage.json — no row may silently lose verification).
 * Both verify; neither generates.
 *
 * release.yml is deliberately NOT covered: generation belongs in the release
 * path, which is where `build-index:publish` legitimately runs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const VERIFY_WORKFLOWS = ['ci.yml', 'validate.yml'];
const GENERATORS = ['build-index', 'sync-index', 'release:prepared'];

/**
 * Drop comment-only lines. GitHub-Actions `run:` bodies in these files contain
 * no `#` characters, so a whole-line strip is sufficient AND conservative: it
 * can only ever leave MORE text in scope, never less, so it cannot manufacture
 * a false pass.
 */
function executableLines(source: string): Array<{ n: number; text: string }> {
  return source
    .split('\n')
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => !/^\s*#/.test(text) && text.trim() !== '');
}

describe('verification workflows never run a registry generator', () => {
  for (const wf of VERIFY_WORKFLOWS) {
    it(`${wf} has no executable generator invocation`, () => {
      const file = path.join(repoRoot, '.github', 'workflows', wf);
      const source = fs.readFileSync(file, 'utf8');
      const offenders = executableLines(source)
        .filter(({ text }) => GENERATORS.some((g) => text.includes(g)))
        .map(({ n, text }) => `${wf}:${n}: ${text.trim()}`);
      expect(offenders).toEqual([]);
    });

    it(`${wf} still runs the published-bytes gate that replaced it`, () => {
      // Guard against "fixing" the invariant by deleting verification wholesale.
      const source = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', wf), 'utf8');
      const runs = executableLines(source).map(({ text }) => text);
      expect(runs.some((l) => l.includes('check-published-bytes'))).toBe(true);
    });
  }

  it('the coverage baseline the replacement gate depends on is committed', () => {
    expect(fs.existsSync(path.join(repoRoot, 'registry', 'published-coverage.json'))).toBe(true);
  });
});
