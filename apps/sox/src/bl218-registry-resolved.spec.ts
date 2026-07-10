/**
 * bl218-registry-resolved.spec.ts — BL-218: coverage for `loadRegistryResolved()` /
 * `cmdDetails()` (main.ts:~302, ~3565).
 *
 * `loadRegistryResolved(cwdRoot)` (BL-217 fix, main.ts:302-325) is a two-candidate
 * fallback used by every registry-reading verb (`details`, `search`, `install`, …):
 *
 *   1. `<cwdRoot>/registry/index.json` — the invoking cwd (repo checkout). Used
 *      as-is if it exists AND is non-empty. An absent file, an unparsable file, OR
 *      a present-but-EMPTY `[]` all fall through to step 2 (`loadRegistryIndex`
 *      returns `[]` for all three, and the gate is `fromCwd.length > 0`).
 *   2. `<dir>/registry/index.json` for each of two bundled candidate dirs, in order:
 *        a. `__dirname` — hit directly when running the self-contained esbuild
 *           bundle (`apps/sox/dist/index.js`), since `embed-registry.cjs` always
 *           writes the embedded copy into that exact directory. This is also the
 *           layout of the PUBLISHED npm bundle.
 *        b. `resolve(__dirname, '../../../apps/sox/dist')` — the dev-tsc-build
 *           indirection: `bin/soxe` runs `dist/apps/sox/main.js` (tsc output,
 *           __dirname = `dist/apps/sox`), which has no embedded copy of its own,
 *           so it reaches three levels up (to the repo root) and back down into
 *           the sibling esbuild output at `apps/sox/dist`. THIS is the exact path
 *           BL-217 was filed against.
 *   3. If neither candidate yields entries, returns `[]` (never throws).
 *
 * `cmdDetails()` (main.ts:3565) calls `loadRegistryResolved(process.cwd())` and
 * looks the id up in the result; an id absent from the resolved list (registry
 * empty OR id just not present) prints `unknown extension '<id>'` to stderr and
 * exits 1 — read directly off the real code, not invented.
 *
 * Two groups of CLI-subprocess tests (following the doctor-reconcile.spec.ts /
 * service-os-unit.spec.ts convention — main.ts runs `void main()` unconditionally
 * at module load, so it cannot be `import`ed in-process and must be driven as a
 * child process):
 *
 *   Group A — a sandboxed COPY of the real esbuild bundle (`apps/sox/dist/index.js`)
 *   placed into an isolated `mkdtempSync` directory, so both "the invoking cwd's
 *   registry" and "the bundle's own directory's registry" (candidate 2a) can be
 *   independently controlled with zero risk to the real repo tree or the
 *   operator's `~/.adhd`/`~/.memory`.
 *
 *   Group B — the REAL, unmodified `dist/apps/sox/main.js` (the tsc build `bin/soxe`
 *   actually launches — same convention as every other `apps/sox/src/*.spec.ts`),
 *   invoked from a repo-less sandboxed cwd, proving candidate 2b (the literal
 *   BL-217 regression path) resolves against the real repo's bundled registry
 *   copy at `apps/sox/dist/registry/index.json`. Read-only — never writes into the
 *   repo tree.
 *
 * Both dist artifacts (`apps/sox/dist/index.js`, `dist/apps/sox/main.js`) must be
 * built first (`npx nx build sox`), matching every other spec in this directory.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The real, already-built esbuild bundle — self-contained (all @adhd/sox-* aliases
// inlined by esbuild), so a bare copy of this single file runs standalone with no
// other dist/ output alongside it.
const REAL_ESBUILD_BUNDLE = path.resolve(__dirname, '../dist/index.js');
// The real, already-built tsc CLI entry — what `bin/soxe` actually launches.
const REAL_TSC_MAIN = path.resolve(__dirname, '../../../dist/apps/sox/main.js');
// The real repo's bundled registry copy the tsc build's candidate 2b resolves to.
const REAL_APPS_SOX_DIST_REGISTRY = path.resolve(__dirname, '../dist/registry/index.json');

function fixtureRegistry(...ids: string[]): string {
  return JSON.stringify(
    ids.map((id) => ({
      id,
      type: 'command',
      version: '1.0.0',
      title: id,
      description: `${id} fixture`,
      source: 'local',
      checksum: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      compatibility: { host: '>=1.0.0' },
    })),
  );
}

function runDetails(
  cliMain: string,
  id: string,
  cwd: string,
  home: string,
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliMain, 'details', id], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, SOX_ECOSYSTEM_HOME: home },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('BL-218: loadRegistryResolved() cwd/bundled fallback + cmdDetails() (main.ts:~302, ~3565)', () => {
  describe('Group A — sandboxed copy of the esbuild bundle (candidate 2a: __dirname direct hit)', () => {
    let base: string;
    let bundleDir: string;
    let bundleFile: string;
    let cwdDir: string;
    let homeDir: string;

    beforeEach(() => {
      if (!fs.existsSync(REAL_ESBUILD_BUNDLE)) {
        throw new Error(
          `BL-218: ${REAL_ESBUILD_BUNDLE} not found — run \`npx nx build sox\` before this spec.`,
        );
      }
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl218-esbuild-'));
      bundleDir = path.join(base, 'bundle');
      cwdDir = path.join(base, 'cwd');
      homeDir = path.join(base, 'home');
      fs.mkdirSync(bundleDir, { recursive: true });
      fs.mkdirSync(cwdDir, { recursive: true });
      fs.mkdirSync(homeDir, { recursive: true });
      bundleFile = path.join(bundleDir, 'index.js');
      fs.copyFileSync(REAL_ESBUILD_BUNDLE, bundleFile);
    });

    afterEach(() => {
      try {
        fs.rmSync(base, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('resolves from the invoking cwd when registry/index.json is present and non-empty there', () => {
      fs.mkdirSync(path.join(cwdDir, 'registry'), { recursive: true });
      fs.writeFileSync(path.join(cwdDir, 'registry', 'index.json'), fixtureRegistry('cwd-fixture'));

      const r = runDetails(bundleFile, 'cwd-fixture', cwdDir, homeDir);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('id:          cwd-fixture');
      expect(r.stdout).toContain('title:       cwd-fixture');
    });

    it('cwd registry, when non-empty, takes precedence — does NOT fall through to the bundled copy', () => {
      fs.mkdirSync(path.join(cwdDir, 'registry'), { recursive: true });
      fs.writeFileSync(path.join(cwdDir, 'registry', 'index.json'), fixtureRegistry('cwd-fixture'));
      fs.mkdirSync(path.join(bundleDir, 'registry'), { recursive: true });
      fs.writeFileSync(path.join(bundleDir, 'registry', 'index.json'), fixtureRegistry('bundled-fixture'));

      // 'bundled-fixture' only exists in the bundled copy; since the cwd copy is
      // non-empty it is used exclusively — the id must NOT be found.
      const r = runDetails(bundleFile, 'bundled-fixture', cwdDir, homeDir);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("unknown extension 'bundled-fixture'");
    });

    it('falls back to the bundled registry (candidate 2a: __dirname direct hit) when cwd has none', () => {
      // cwdDir has NO registry/ directory at all.
      fs.mkdirSync(path.join(bundleDir, 'registry'), { recursive: true });
      fs.writeFileSync(path.join(bundleDir, 'registry', 'index.json'), fixtureRegistry('bundled-fixture'));

      const r = runDetails(bundleFile, 'bundled-fixture', cwdDir, homeDir);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('id:          bundled-fixture');
    });

    it('a present-but-EMPTY cwd registry also falls through to the bundled copy (fromCwd.length > 0 gate)', () => {
      fs.mkdirSync(path.join(cwdDir, 'registry'), { recursive: true });
      fs.writeFileSync(path.join(cwdDir, 'registry', 'index.json'), '[]');
      fs.mkdirSync(path.join(bundleDir, 'registry'), { recursive: true });
      fs.writeFileSync(path.join(bundleDir, 'registry', 'index.json'), fixtureRegistry('bundled-fixture'));

      const r = runDetails(bundleFile, 'bundled-fixture', cwdDir, homeDir);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('id:          bundled-fixture');
    });

    it('exits 1 with "unknown extension" when the id is found in NEITHER cwd nor the bundled dir', () => {
      // Neither cwdDir nor bundleDir has a registry/ directory at all —
      // loadRegistryResolved() returns [] and cmdDetails() reports not-found.
      const r = runDetails(bundleFile, 'nowhere-fixture', cwdDir, homeDir);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain("unknown extension 'nowhere-fixture'");
      expect(r.stderr).toContain("Run 'soxe search' to see available extensions.");
    });
  });

  describe('Group B — the real dev-tsc build (candidate 2b: the literal BL-217 regression path)', () => {
    let cwdDir: string;
    let homeDir: string;
    let base: string;

    beforeEach(() => {
      if (!fs.existsSync(REAL_TSC_MAIN)) {
        throw new Error(`BL-218: ${REAL_TSC_MAIN} not found — run \`npx nx build sox\` before this spec.`);
      }
      if (!fs.existsSync(REAL_APPS_SOX_DIST_REGISTRY)) {
        throw new Error(
          `BL-218: ${REAL_APPS_SOX_DIST_REGISTRY} not found — run \`npx nx build sox\` before this spec ` +
            '(the esbuild + embed-registry steps of the sox:build target populate it).',
        );
      }
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl218-tsc-'));
      cwdDir = path.join(base, 'no-repo-checkout');
      homeDir = path.join(base, 'home');
      fs.mkdirSync(cwdDir, { recursive: true });
      fs.mkdirSync(homeDir, { recursive: true });
    });

    afterEach(() => {
      try {
        fs.rmSync(base, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('resolves a real registry id via the sibling apps/sox/dist bundled copy when run from a repo-less cwd', () => {
      // cwdDir deliberately has no registry/ — this is the "consumer with no repo
      // checkout running the CLI's own dev tsc build" scenario BL-217 fixed.
      // __dirname of dist/apps/sox/main.js is dist/apps/sox; candidate 2a
      // (dist/apps/sox/registry/index.json) never exists (embed-registry.cjs only
      // ever targets apps/sox/dist/registry/index.json), so this exercises
      // candidate 2b exclusively.
      const r = runDetails(REAL_TSC_MAIN, 'sox', cwdDir, homeDir);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('id:          sox');
      expect(r.stdout).toContain('type:        command');
    });

    it('still reports "unknown extension" for an id absent from the real registry (repo-less cwd, no invented id)', () => {
      const r = runDetails(REAL_TSC_MAIN, 'bl218-definitely-not-a-real-extension-id', cwdDir, homeDir);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("unknown extension 'bl218-definitely-not-a-real-extension-id'");
    });
  });
});
