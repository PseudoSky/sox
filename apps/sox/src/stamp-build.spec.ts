/**
 * stamp-build.spec.ts — BL-68 regression + dirty-flag contract for stamp-build.cjs.
 *
 * stamp-build.cjs writes dist/apps/sox/build-info.json with { gitSha, dirty, builtAt }.
 * The `dirty` flag MUST be based on TRACKED changes only (git status --untracked-files=no)
 * so that untracked files (README.md, PUBLISHING.md, .claude/skills/**, etc.) do NOT
 * cause a false-positive "dirty" stamp on an otherwise clean tree (BL-68).
 *
 * Contract:
 *   - A tree with ONLY untracked files → dirty = false
 *   - A tree with a MODIFIED tracked file → dirty = true
 *   - A tree with a STAGED tracked file → dirty = true
 *   - A clean tree (committed, no modifications) → dirty = false
 *
 * We run stamp-build.cjs in a real temp git repo to prove the contract.
 * We do NOT touch the real repo's dist/ or worktree state.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Path to the stamp-build.cjs script under test. */
const STAMP_BUILD = path.resolve(__dirname, '..', 'scripts', 'stamp-build.cjs');

/**
 * Create a minimal temp git repo, run stamp-build.cjs in it, and return the
 * parsed build-info.json it writes. Cleans up the tmpdir after.
 */
function runStampInRepo(setup: (repoDir: string) => void): {
  gitSha: string;
  dirty: boolean;
  builtAt: string;
} {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-stamp-'));
  const outPath = path.join(repoDir, 'build-info.json');

  try {
    // Init a bare-minimum git repo with one committed file.
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init');
    git('config', 'user.email', 'test@test.test');
    git('config', 'user.name', 'Test');
    // Commit a tracked file so HEAD exists.
    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'initial\n');
    git('add', 'tracked.txt');
    git('commit', '-m', 'init');

    // Let the test scenario apply its modifications.
    setup(repoDir);

    // Monkeypatch the output paths: stamp-build.cjs resolves output relative to
    // __dirname. We can't easily override that from outside. Instead we temporarily
    // write a patched copy that uses our outPath (for testing, we just need one path).
    const original = fs.readFileSync(STAMP_BUILD, 'utf8');
    const patched = original.replace(
      /const outPaths = \[\s*path\.resolve\(__dirname,.*?\),\s*path\.resolve\(__dirname,.*?\),\s*\];/s,
      `const outPaths = [${JSON.stringify(outPath)}];`,
    );
    const patchedScript = path.join(repoDir, 'stamp-build-patched.cjs');
    fs.writeFileSync(patchedScript, patched);

    execFileSync('node', [patchedScript], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return JSON.parse(fs.readFileSync(outPath, 'utf8')) as {
      gitSha: string;
      dirty: boolean;
      builtAt: string;
    };
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

/**
 * Path to the real `sox:build` target definition, so this test exercises the
 * ACTUAL configured command order rather than a hardcoded assumption of it —
 * a future re-ordering regression will be caught by re-reading this file.
 */
const PROJECT_JSON = path.resolve(__dirname, '..', 'project.json');

/**
 * A minimal stand-in for tools/bundle-extension.cjs's [BL-235] atomic swap:
 * stage into `<outdir>.staging-<pid>`, then `renameSync` it into `<outdir>`,
 * destroying whatever was there before (including any build-info.json a
 * PRIOR command already wrote into `<outdir>`). This is the exact mechanism
 * that wipes stamp-build.cjs's PUBLISHED-copy write when stamp-build.cjs runs
 * BEFORE bundle-extension.cjs in the `sox:build` command order.
 */
const BUNDLE_STUB = `
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const outdirIdx = args.indexOf('--outdir');
const outdir = path.resolve(args[outdirIdx + 1]);
const stageDir = outdir + '.staging-stub';
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });
fs.writeFileSync(path.join(stageDir, 'index.js'), '// stub bundle\\n');
if (fs.existsSync(outdir)) fs.rmSync(outdir, { recursive: true, force: true });
fs.renameSync(stageDir, outdir);
console.log('bundle-stub: swapped ' + outdir);
`;

/**
 * [ITEM 4] Regression: `sox:build`'s command ordering must not let
 * bundle-extension.cjs's atomic outdir swap run AFTER stamp-build.cjs has
 * already written the PUBLISHED build-info.json copy into that same outdir —
 * the swap silently discards it, and `warnIfDistSha()` (main.ts) reads from
 * exactly that published `__dirname`, so the BL-65 dirty-dist warning is dead
 * in every published artifact.
 *
 * This drives the REAL project.json `build` target's `commands` array (so a
 * future re-ordering is caught, not just today's fix), substituting a stub
 * for bundle-extension.cjs (no real esbuild bundling needed — only the
 * atomic-swap mechanics matter) and the REAL stamp-build.cjs (copied to the
 * matching relative path so its own __dirname-relative output-path
 * resolution needs no patching). Everything runs inside a disposable temp
 * dir; the real repo's dist/ is never touched.
 *
 * Fails before the fix (stamp-build.cjs invoked in command 1, before
 * bundle-extension.cjs's swap in command 2 — the published copy is wiped).
 * Passes after the fix (stamp-build.cjs invoked in command 2, chained after
 * the swap with `&&`).
 */
describe('[ITEM 4] sox:build command order preserves build-info.json at both paths', () => {
  it('build-info.json survives at BOTH the dev and published output paths', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-build-order-'));
    try {
      // Replicate only the relative directory shape stamp-build.cjs's
      // __dirname-relative path.resolve() calls depend on:
      //   apps/sox/scripts/stamp-build.cjs
      //     -> ../../../dist/apps/sox/build-info.json   (repoRoot/dist/apps/sox/...)
      //     -> ../dist/build-info.json                  (repoRoot/apps/sox/dist/...)
      const scriptsDir = path.join(repoRoot, 'apps', 'sox', 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.copyFileSync(STAMP_BUILD, path.join(scriptsDir, 'stamp-build.cjs'));

      const toolsDir = path.join(repoRoot, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      fs.writeFileSync(path.join(toolsDir, 'bundle-extension.cjs'), BUNDLE_STUB);

      // Pre-create the DEV output dir (nx's `compile` target always runs
      // before `build`, so dist/apps/sox pre-exists in real builds).
      fs.mkdirSync(path.join(repoRoot, 'dist', 'apps', 'sox'), { recursive: true });

      // Parse the REAL project.json build target's command order and reduce
      // it to the two calls this invariant cares about, executed in order.
      const projectJson = JSON.parse(fs.readFileSync(PROJECT_JSON, 'utf8')) as {
        targets: { build: { options: { commands: string[] } } };
      };
      const commands = projectJson.targets.build.options.commands;
      const segments = commands.flatMap((c) => c.split('&&').map((s) => s.trim()));

      const relevant = segments.filter(
        (s) => s.includes('stamp-build.cjs') || s.includes('bundle-extension.cjs'),
      );
      expect(relevant.length).toBeGreaterThanOrEqual(2);

      for (const segment of relevant) {
        if (segment.includes('bundle-extension.cjs')) {
          execFileSync(
            'node',
            [path.join(toolsDir, 'bundle-extension.cjs'), '--outdir', path.join(repoRoot, 'apps', 'sox', 'dist')],
            { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          );
        } else if (segment.includes('stamp-build.cjs')) {
          execFileSync('node', [path.join(scriptsDir, 'stamp-build.cjs')], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        }
      }

      const devPath = path.join(repoRoot, 'dist', 'apps', 'sox', 'build-info.json');
      const publishedPath = path.join(repoRoot, 'apps', 'sox', 'dist', 'build-info.json');

      expect(fs.existsSync(devPath)).toBe(true);
      // This is the assertion that fails pre-fix: bundle-extension.cjs's
      // atomic swap (which runs AFTER stamp-build.cjs in the buggy order)
      // deletes the outdir stamp-build.cjs just wrote into.
      expect(fs.existsSync(publishedPath)).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('stamp-build.cjs', () => {
  it('[BL-68] clean committed tree → dirty = false', () => {
    const result = runStampInRepo((_dir) => {
      // No modifications — clean tree.
    });
    expect(result.dirty).toBe(false);
    expect(result.gitSha).toMatch(/^[0-9a-f]{7,}/);
  });

  it('[BL-68] ONLY untracked files present → dirty = false (regression: was wrongly true)', () => {
    const result = runStampInRepo((dir) => {
      // Add untracked files (README, PUBLISHING, .claude dir) — the exact pattern
      // that caused the BL-68 false-positive on the live dev checkout.
      fs.writeFileSync(path.join(dir, 'README.md'), '# readme\n');
      fs.writeFileSync(path.join(dir, 'PUBLISHING.md'), '# pub\n');
      fs.mkdirSync(path.join(dir, '.claude', 'skills'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'skills', 'SKILL.md'), '# skill\n');
      // These files are NOT git-added, so they are untracked.
    });
    // The fix: --untracked-files=no means untracked files don't count as dirty.
    expect(result.dirty).toBe(false);
  });

  it('[BL-68] modified tracked file → dirty = true', () => {
    const result = runStampInRepo((dir) => {
      // Modify a tracked file (not yet staged).
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'modified\n');
    });
    expect(result.dirty).toBe(true);
  });

  it('[BL-68] staged (but not committed) tracked file → dirty = true', () => {
    const result = runStampInRepo((dir) => {
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'staged\n');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: dir, stdio: 'ignore' });
    });
    expect(result.dirty).toBe(true);
  });

  it('[BL-68] untracked AND modified tracked file → dirty = true', () => {
    const result = runStampInRepo((dir) => {
      // Both untracked (should not count) and a modified tracked file (should count).
      fs.writeFileSync(path.join(dir, 'README.md'), '# readme\n');
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'modified\n');
    });
    expect(result.dirty).toBe(true);
  });
});
