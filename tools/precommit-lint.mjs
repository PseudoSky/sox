#!/usr/bin/env node
/**
 * tools/precommit-lint.mjs — fc2735f0: lint the STAGED change, not the previous commit.
 *
 * `.husky/pre-commit:69` used to run `nx affected --target=lint --base=HEAD~1 --head=HEAD`,
 * which gates on the blast radius of the commit that already landed, never the one being made
 * right now. The staged index was never consulted (F1/F2 in the item's spec). This script derives
 * the affected-project set from `git diff --cached --name-only --no-renames`, so it is scoped to
 * exactly the files this commit is about to contain.
 *
 * Interactions (see the item spec §2 for the full rationale):
 *   - Pathspec commits (`git commit -- path`, the mandated form) hand this process a PRIVATE
 *     next-index via GIT_INDEX_FILE. tools/lib/git-index-scope.mjs (shared with
 *     tools/run-guards.mjs) re-admits it into the git env used for `diff --cached` only when it
 *     can be PROVEN to belong to this repo's own git dir — never blindly (an ambient
 *     GIT_INDEX_FILE can be leaked into a child process from an unrelated repo, e.g. via `git -c
 *     core.hooksPath=...`'s GIT_CONFIG_* propagation — discovered verifying this very change).
 *     This is the opposite direction of tools/run-guards.mjs's BL-479 stripping, which exists for
 *     a different reason (see that file's header) but resolves via the same shared helper.
 *   - `--amend`: `diff --cached` against HEAD lists only the delta being amended in. The original
 *     content was linted when first committed, so this is acceptable.
 *   - Empty staged set (message-only amend, `--allow-empty`): exit 0 without calling nx.
 *   - A path containing a comma would corrupt nx's comma-joined `--files=a,b,c`: fail loudly
 *     instead of silently under-linting.
 *   - No catch around the git call: a git failure is a hook failure (CLAUDE.md forbids empty
 *     catches and this repo's constraint is fail-closed, not fail-open).
 *
 * R1 (accepted, documented per spec §5): lint still reads the WORKING TREE, not index blobs.
 * Another agent's unstaged broken edit in a project you also touch can still fail your commit.
 * Scope is reduced from "everyone's last commit" to "your own staged projects", not eliminated.
 *
 * Flags:
 *   --print-argv       print the nx argv(s) that would be run, as JSON lines, and exit 0 without
 *                      invoking npx. Used by the Tier 2 graph guard (read-only, no real nx run).
 *   --print-projects   resolve the affected PROJECT set for real (real `nx show projects
 *                      --affected` calls, chunked exactly like a real run would be) and print it
 *                      as a JSON array, then exit 0 WITHOUT running the final `nx run-many -t
 *                      lint`. Used by the Tier 2 graph guard to prove the chunked/unioned project
 *                      set for a staged set over MAX_ARGV_BYTES matches the single-call result.
 *
 * Testing-only env vars (never set by the real hook):
 *   PRECOMMIT_LINT_STAGED_FILES_OVERRIDE   JSON array of paths, used INSTEAD of `git diff
 *                                          --cached` — lets a test exercise the chunking/union
 *                                          logic against this repo's real nx graph without
 *                                          needing an actual multi-KB staged diff.
 *   PRECOMMIT_LINT_MAX_ARGV_BYTES          overrides MAX_ARGV_BYTES, so a test can force the
 *                                          chunked path with a small fixture file list.
 *
 * Usage: node tools/precommit-lint.mjs
 * Exit 0 on success or nothing-to-lint. Non-zero on lint failure or a git/nx spawn failure.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { withVerifiedGitIndex } from './lib/git-index-scope.mjs';

const PRINT_ARGV = process.argv.includes('--print-argv');
const PRINT_PROJECTS = process.argv.includes('--print-projects');

// ARG_MAX headroom (spec §2 step 4): a joined --files= argv near the ~256KB (Linux) / ~1MB+
// (macOS) execve ceiling risks E2BIG. 100KB leaves comfortable margin on every platform this
// repo runs on and is generous for a single commit's staged set. Overridable only for tests.
const MAX_ARGV_BYTES = Number(process.env.PRECOMMIT_LINT_MAX_ARGV_BYTES) || 100_000;

// No try/catch around the git call: a git failure here is a hook failure. Let it throw and
// crash the process with git's own stderr — that is fail-closed by construction (process.exit is
// never reached on that path; the uncaught throw itself terminates with a non-zero exit code),
// and there is nothing safe to fall back to (falling back to "lint everything" or "lint nothing"
// would both hide the git failure from the committer).
function getStagedFiles() {
  if (process.env.PRECOMMIT_LINT_STAGED_FILES_OVERRIDE) {
    // Testing only (see header) — bypasses git entirely.
    try {
      return JSON.parse(process.env.PRECOMMIT_LINT_STAGED_FILES_OVERRIDE);
    } catch (err) {
      console.error(`pre-commit lint: invalid PRECOMMIT_LINT_STAGED_FILES_OVERRIDE — ${err.message}`);
      process.exit(1);
    }
  }
  const root = process.cwd();
  const env = withVerifiedGitIndex({
    root,
    env: process.env,
    indexFile: process.env.GIT_INDEX_FILE,
    label: 'precommit-lint',
  });
  const out = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--no-renames', '-z'],
    { encoding: 'utf8', env },
  );
  return out.split('\0').filter(Boolean);
}

const files = getStagedFiles();

if (files.length === 0) {
  console.log('pre-commit lint: no staged files');
  process.exit(0);
}

const badPath = files.find((f) => f.includes(','));
if (badPath) {
  console.error(
    `pre-commit lint: staged path contains a comma, which would corrupt nx's comma-joined --files= argument: ${badPath}`,
  );
  process.exit(1);
}

function runNx(argv) {
  if (PRINT_ARGV) {
    console.log(JSON.stringify(argv));
    return 0;
  }
  const res = spawnSync('npx', argv, { stdio: 'inherit' });
  if (res.error) {
    console.error(`pre-commit lint: failed to spawn npx — ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

/** Real (never print-argv-skipped) `nx show projects --affected --files=<chunk>` call. */
function showProjectsAffectedReal(chunkFiles) {
  const res = spawnSync(
    'npx',
    ['nx', 'show', 'projects', '--affected', '--files=' + chunkFiles.join(','), '--json'],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    console.error(`pre-commit lint: nx show projects failed for a chunk — ${res.stderr || res.error?.message || ''}`);
    process.exit(res.status || 1);
  }
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    console.error(`pre-commit lint: could not parse 'nx show projects' output — ${err.message}`);
    process.exit(1);
  }
}

function chunkByBytes(list, maxBytes) {
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  for (const f of list) {
    const size = Buffer.byteLength(f, 'utf8') + 1; // +1 for the joining comma
    if (cur.length > 0 && curBytes + size > maxBytes) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += size;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

const joinedFiles = files.join(',');
const joinedBytes = Buffer.byteLength(joinedFiles, 'utf8');

if (joinedBytes <= MAX_ARGV_BYTES) {
  if (PRINT_PROJECTS) {
    console.log(JSON.stringify(showProjectsAffectedReal(files)));
    process.exit(0);
  }
  process.exit(runNx(['nx', 'affected', '-t', 'lint', '--files=' + joinedFiles]));
}

// Over the ARG_MAX-safe threshold: resolve the affected PROJECT set per chunk via the read-only
// `nx show projects --affected`, union them, then lint the union in one `nx run-many`. This keeps
// the semantics identical to a single `nx affected --files=` call — never a whole-repo fallback.
console.error(
  `pre-commit lint: staged file list is ${joinedBytes} bytes (> ${MAX_ARGV_BYTES}); chunking to avoid ARG_MAX.`,
);
const chunks = chunkByBytes(files, MAX_ARGV_BYTES);
const projectSet = new Set();
for (const chunk of chunks) {
  if (PRINT_ARGV) {
    console.log(JSON.stringify(['nx', 'show', 'projects', '--affected', '--files=' + chunk.join(','), '--json']));
    continue;
  }
  for (const p of showProjectsAffectedReal(chunk)) projectSet.add(p);
}

if (PRINT_ARGV) {
  process.exit(0);
}

if (PRINT_PROJECTS) {
  console.log(JSON.stringify([...projectSet]));
  process.exit(0);
}

if (projectSet.size === 0) {
  console.log('pre-commit lint: no projects affected by the staged files');
  process.exit(0);
}

process.exit(runNx(['nx', 'run-many', '-t', 'lint', '--projects=' + [...projectSet].join(',')]));
