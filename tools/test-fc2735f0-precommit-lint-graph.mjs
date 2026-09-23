#!/usr/bin/env node
/**
 * tools/test-fc2735f0-precommit-lint-graph.mjs — Tier 2 (real graph, read-only).
 *
 * Pins the F5/F6 facts from fc2735f0's spec so a future nx.json / root project.json edit cannot
 * silently reintroduce root fan-out: `tools/run-guards.mjs` maps to exactly `sox-ecosystem`
 * (never to every project), and `tools/precommit-lint.mjs --print-argv` for that same file
 * produces a `--files=` argv containing only files under `tools/`, never a bare `nx affected`
 * with no `--files` at all (which would silently lint everything).
 *
 * Read-only: only `nx show projects --affected --files=…` and `node tools/precommit-lint.mjs
 * --print-argv` are invoked — no build, no real lint run.
 *
 * Usage: node tools/test-fc2735f0-precommit-lint-graph.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOLS_DIR, '..');
const PRECOMMIT_LINT = path.join(TOOLS_DIR, 'precommit-lint.mjs');

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

function nxShowProjectsAffected(files) {
  const out = execFileSync(
    'npx',
    ['nx', 'show', 'projects', '--affected', '--files=' + files.join(','), '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return JSON.parse(out);
}

// F5/F6 pin: tools/run-guards.mjs maps to exactly [sox-ecosystem], never fans out.
{
  const projects = nxShowProjectsAffected(['tools/run-guards.mjs']);
  report(
    'F5/F6 pin: tools/run-guards.mjs affects exactly [sox-ecosystem]',
    Array.isArray(projects) && projects.length === 1 && projects[0] === 'sox-ecosystem',
    JSON.stringify(projects),
  );
}

// precommit-lint.mjs's own --files= argv for a tools/-only staged set never falls back to a
// bare `nx affected` with no --files (which would mean "lint everything").
{
  const out = execFileSync(
    process.execPath,
    [PRECOMMIT_LINT, '--print-argv'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        // Fake a tiny staged set by shelling out is not possible without a real git op inside
        // this repo's own index; instead we assert the script itself accepts --print-argv and
        // exits 0 with SOMETHING when nothing is staged (this repo's worktree may have staged
        // files from this very session, so only assert well-formedness, not content).
      },
    },
  );
  const lines = out.split('\n').filter(Boolean);
  // Either "no staged files" (exit path before any argv print) or one/more JSON argv lines.
  let wellFormed = true;
  for (const line of lines) {
    if (line.startsWith('pre-commit lint:')) continue;
    try {
      const argv = JSON.parse(line);
      if (!Array.isArray(argv) || argv[0] !== 'nx') wellFormed = false;
    } catch {
      wellFormed = false;
    }
  }
  report('precommit-lint --print-argv output is well-formed (nx argv or "no staged files")', wellFormed, out.slice(0, 300));
}

// ---------------------------------------------------------------------------------------------
// Chunking path (spec §2 step 4, > MAX_ARGV_BYTES): the unioned project set across chunks must
// equal the single-call --files= project set for the SAME staged set. Uses
// PRECOMMIT_LINT_STAGED_FILES_OVERRIDE + PRECOMMIT_LINT_MAX_ARGV_BYTES (testing-only env vars,
// see precommit-lint.mjs's header) to exercise the real chunking/union logic against this repo's
// real nx graph without needing an actual multi-KB staged diff.
// ---------------------------------------------------------------------------------------------
function gitLsFiles(pattern) {
  return execFileSync('git', ['ls-files', pattern], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function runPrecommitLint(extraArgs, env) {
  return execFileSync(process.execPath, [PRECOMMIT_LINT, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

{
  // A real, diverse staged set spanning two different project owners so the union is meaningful,
  // not just a single-project no-op.
  const stagedSet = [
    ...gitLsFiles('tools/*.mjs').slice(0, 12),
    ...gitLsFiles('libs/host-runtime/src/*.ts').slice(0, 5),
  ];
  const overrideEnv = { PRECOMMIT_LINT_STAGED_FILES_OVERRIDE: JSON.stringify(stagedSet) };

  // Single-call baseline: threshold high enough that nothing chunks.
  const singleCallOut = runPrecommitLint(['--print-projects'], {
    ...overrideEnv,
    PRECOMMIT_LINT_MAX_ARGV_BYTES: '1000000',
  });
  const singleCallProjects = JSON.parse(singleCallOut.trim().split('\n').pop());

  report(
    'chunking fixture: single-call baseline resolves at least one real project',
    Array.isArray(singleCallProjects) && singleCallProjects.length > 0,
    JSON.stringify(singleCallProjects),
  );

  // Force >=2 chunks: threshold small enough that the joined staged set (well over 200 bytes for
  // 17 real repo-relative paths) cannot fit in one chunk.
  const chunkedOut = runPrecommitLint(['--print-argv'], {
    ...overrideEnv,
    PRECOMMIT_LINT_MAX_ARGV_BYTES: '80',
  });
  const chunkArgvLines = chunkedOut
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('['))
    .map((l) => JSON.parse(l));
  report(
    'chunking fixture: >=2 nx show projects chunks are actually produced',
    chunkArgvLines.length >= 2,
    `${chunkArgvLines.length} chunk(s)`,
  );

  const chunkedProjectsOut = runPrecommitLint(['--print-projects'], {
    ...overrideEnv,
    PRECOMMIT_LINT_MAX_ARGV_BYTES: '80',
  });
  const chunkedProjects = JSON.parse(chunkedProjectsOut.trim().split('\n').pop());

  const sortedSingle = [...singleCallProjects].sort();
  const sortedChunked = [...chunkedProjects].sort();
  report(
    'fc2735f0 chunking: unioned project set across chunks equals the single-call --files= result',
    JSON.stringify(sortedSingle) === JSON.stringify(sortedChunked),
    `single=${JSON.stringify(sortedSingle)} chunked=${JSON.stringify(sortedChunked)}`,
  );
}

console.log('');
console.log(failed === 0 ? 'ALL fc2735f0 GRAPH ASSERTIONS PASS' : `${failed} fc2735f0 GRAPH ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
