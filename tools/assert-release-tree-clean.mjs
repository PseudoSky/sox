#!/usr/bin/env node
/**
 * tools/assert-release-tree-clean.mjs — the release path's FIRST gate.
 *
 * WHY
 * ---
 * `@adhd/sox-cli@1.2.1` was published from a tree whose `build-info.json`
 * carries `dirty: true` — the published bytes correspond to NO COMMIT, so
 * "which source produced what our users are running?" is unanswerable, and
 * bisecting a report against it is impossible.
 *
 * `scripts/build-index.ts` has had a dirty-tree gate since BL-390, but it only
 * fires when build-index RUNS. `pnpm release` never called it at all, and even
 * in `release:prepared` it fires after `release-consumers` — i.e. after the
 * release has already started. This runs BEFORE anything else, so a dirty
 * release stops at step zero.
 *
 * DIRTINESS IS DEFINED EXACTLY AS `apps/sox/scripts/stamp-build.cjs` DEFINES IT
 * -----------------------------------------------------------------------------
 * `git status --porcelain --untracked-files=no` — tracked changes only, staged
 * or unstaged. That is deliberate coupling, not coincidence: this gate must
 * refuse AT LEAST as strictly as the stamp judges, or a release could pass here
 * and still ship an unattributable stamp. It runs before anything generates, so
 * it deliberately does NOT carry stamp-build's one carve-out
 * (`registry/index.json`, which the release path itself rewrites at step 3):
 * at step 1 that file should already be committed, and refusing on it is right. Untracked files are
 * excluded for the same reason stamp-build excludes them (BL-68: a fresh
 * checkout always carries some untracked editor/tooling files).
 *
 * There is NO environment escape hatch, by design. `--allow-dirty` on
 * build-index is for inspecting a provisional index; a release has no
 * equivalent legitimate use, and an escape hatch on this gate would be used.
 *
 *   node tools/assert-release-tree-clean.mjs
 *   node tools/assert-release-tree-clean.mjs --quiet   # no output on success
 */
import { execFileSync } from 'node:child_process';

const quiet = process.argv.includes('--quiet');

let status;
try {
  status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
} catch (e) {
  // Fail CLOSED. "git did not answer" must never read as "the tree is clean" —
  // that is the exact failure mode stamp-build guards with `dirty = true`.
  console.error(
    'release-tree-gate: REFUSING — could not determine working-tree state.\n' +
      `  git status failed: ${e instanceof Error ? e.message : String(e)}\n` +
      '  A release whose provenance cannot be established is not a release.',
  );
  process.exit(1);
}

const offenders = status
  .split('\n')
  .map((l) => l.trimEnd())
  .filter((l) => l.length > 0);

if (offenders.length > 0) {
  const shown = offenders.slice(0, 30).join('\n    ');
  const rest = offenders.length > 30 ? `\n    ...and ${offenders.length - 30} more` : '';
  console.error(
    'release-tree-gate: REFUSING to release from a DIRTY working tree.\n' +
      `  ${offenders.length} tracked change(s), staged or unstaged:\n    ${shown}${rest}\n\n` +
      '  Published bytes from a dirty tree correspond to no commit: `build-info.json`\n' +
      '  is stamped `dirty: true` and registry entries are stamped "<sha>+dirty" with\n' +
      '  `provisional: true`. @adhd/sox-cli@1.2.1 shipped exactly that state\n' +
      '  (PROD-BREAK-SOXCLI-121) and nobody can say what source it was built from.\n\n' +
      '  Fix: commit (or let the owning agent commit) every pending change, then\n' +
      '  re-run the release. The index is shared between concurrent agents — commit\n' +
      '  by explicit pathspec, never `git add -A`. Never `git stash` the difference\n' +
      '  away: that destroys another agent\'s work instead of resolving it.',
  );
  process.exit(1);
}

if (!quiet) {
  console.log('release-tree-gate: OK — working tree is clean; published bytes will name a commit.');
}
