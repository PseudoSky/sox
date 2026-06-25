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

    // Monkeypatch the output path: stamp-build.cjs resolves output relative to
    // __dirname. We can't easily override that from outside. Instead we temporarily
    // write a patched copy that uses our outPath.
    const original = fs.readFileSync(STAMP_BUILD, 'utf8');
    const patched = original.replace(
      /const outPath = path\.resolve\(__dirname,.*?\);/,
      `const outPath = ${JSON.stringify(outPath)};`,
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
