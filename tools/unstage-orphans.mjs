#!/usr/bin/env node
/**
 * unstage-orphans — [BL-463] clear index entries an agent staged but never committed, so they
 * cannot become a revert bomb for the next agent in the same checkout.
 *
 * THE PROBLEM
 * -----------
 * Staged entries OUTLIVE the agent that created them. Three occurrences on 2026-08-05, all found
 * by accident rather than by any guard: `STATE.md` 50 lines behind HEAD; six paths at 2,687
 * deletions with `CHANGELOG.md` at −260; four paths with `BACKLOG.md` at −292/+174. In every case
 * the working trees were correct and only the index was stale, so `git status` showed nothing
 * alarming and the files looked fine on disk — while a bare `git commit` by anyone would have
 * reverted committed work in bulk. (`git diff` compares against the index, not HEAD, so it
 * actively misleads while this condition is present; `git diff HEAD` is the honest command.)
 *
 * BL-465 is the other source of the same condition — `commit-mine.mjs` used to manufacture it on
 * every run — and is fixed at the source. This tool covers the lifecycle vector: an agent that
 * finished, or was stopped, holding staged paths.
 *
 * WHY THIS IS NOT JUST `git restore --staged .`
 * ---------------------------------------------
 * A staged entry whose content differs from the working tree exists ONLY in the index. Blindly
 * resetting it discards the sole reference to that content — turning a revert bomb into immediate
 * data loss, which is the exact inversion this family of defects keeps producing. So:
 *
 *   - a path whose staged blob equals the working-tree file is SAFE: unstaging loses nothing,
 *     because the identical bytes are still on disk. These are cleared by default.
 *   - a path whose staged blob differs from the working tree is HELD BACK, reported with its blob
 *     sha and the command to read it, and cleared only under `--force`. The blob survives in the
 *     object database either way (until gc), so `--force` is recoverable — but it must be a
 *     decision, not a default.
 *
 * Usage
 *   node tools/unstage-orphans.mjs                     report only; changes nothing
 *   node tools/unstage-orphans.mjs --apply             clear the SAFE paths
 *   node tools/unstage-orphans.mjs --apply --force     also clear index-only content (recoverable)
 *   node tools/unstage-orphans.mjs --apply --min-idle-min 10
 *                                                      refuse unless `.git/index` has been idle
 *                                                      that long — the teardown-safe form, since a
 *                                                      live agent's index is being written now
 *   node tools/unstage-orphans.mjs --json              machine-readable, for orchestrator teardown
 *
 * The working tree is never read for writing and never modified. `git restore --staged` rewrites
 * index entries only — verified across all three incidents above, nothing was lost in any of them.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const force = argv.includes('--force');
const json = argv.includes('--json');
const minIdleMin = Number(argv[argv.indexOf('--min-idle-min') + 1]) || 0;

const repoRoot = git(['rev-parse', '--show-toplevel']).trim();
process.chdir(repoRoot);
const gitDir = git(['rev-parse', '--absolute-git-dir']).trim();

const out = (msg) => { if (!json) console.error(msg); };

/** Minutes since `.git/index` was last written — a live agent's index is being touched now. */
function indexIdleMinutes() {
  try {
    return (Date.now() - statSync(`${gitDir}/index`).mtimeMs) / 60000;
  } catch {
    return Infinity;
  }
}

// `git diff-index --cached` compares the index against HEAD: exactly the entries that would be
// committed by a pathspec-less commit, and nothing else.
const divergent = git(['diff-index', '--cached', '--name-only', 'HEAD'])
  .split('\n')
  .filter(Boolean);

// A path whose index entry equals the working-tree file is safe to clear; anything else exists
// only in the index. `git diff --name-only` (index vs worktree) is precisely that discriminator.
const indexOnly = new Set(
  divergent.length ? git(['diff', '--name-only', '--', ...divergent]).split('\n').filter(Boolean) : [],
);
const safe = divergent.filter((p) => !indexOnly.has(p));
const held = divergent.filter((p) => indexOnly.has(p));

const blobOf = (p) => {
  const line = git(['ls-files', '-s', '--', p]).trim();
  return line ? line.split(/\s+/)[1] : null;
};
const report = {
  repoRoot,
  head: git(['rev-parse', 'HEAD']).trim(),
  indexIdleMinutes: Number(indexIdleMinutes().toFixed(2)),
  divergent,
  safe,
  held: held.map((p) => ({ path: p, blob: blobOf(p), read: `git cat-file blob ${blobOf(p)}` })),
  applied: [],
  skippedReason: null,
};

if (!divergent.length) {
  out('unstage-orphans: shared index matches HEAD — nothing staged, nothing to clear [BL-463].');
} else {
  out(`unstage-orphans: ${divergent.length} path(s) staged in the shared index and NOT in HEAD [BL-463]:`);
  for (const p of safe) out(`  safe   ${p}  (staged bytes are identical to the working tree)`);
  for (const h of report.held) out(`  HELD   ${h.path}  (index-only content — read it with \`${h.read}\`)`);

  const idle = report.indexIdleMinutes;
  if (apply && minIdleMin > 0 && idle < minIdleMin) {
    report.skippedReason = `index-active: written ${idle.toFixed(2)} min ago, --min-idle-min ${minIdleMin}`;
    out(
      `unstage-orphans: REFUSING to clear — \`.git/index\` was written ${idle.toFixed(2)} min ago and ` +
        `--min-idle-min is ${minIdleMin}. Another agent is staging right now.`,
    );
  } else if (apply) {
    const targets = force ? divergent : safe;
    if (targets.length) {
      git(['restore', '--staged', '--', ...targets]);
      report.applied = targets;
      out(`unstage-orphans: cleared ${targets.length} index entry(ies) to HEAD. Working tree untouched.`);
    }
    if (!force && held.length) {
      out(
        `unstage-orphans: ${held.length} index-only path(s) left staged. Re-run with --force to clear ` +
          'them; their blobs stay readable in the object database, but the working tree does not ' +
          'hold those bytes, so this is a decision rather than a default.',
      );
    }
  } else {
    out('unstage-orphans: report only. Re-run with --apply to clear (add --force for the HELD paths).');
  }
}

if (json) console.log(JSON.stringify(report, null, 2));
